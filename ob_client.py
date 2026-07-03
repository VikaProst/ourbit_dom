"""Лёгкий подписанный клиент Ourbit для DOM-терминала (баланс/позиции/ордера).

Подпись вскрыта ранее (см. ourbit_direct_broker / память project-ourbit-order-signing-cracked):
  nonce = ms; g = md5(token+nonce)[7:]; sign = md5(nonce + compact_body + g)  (POST)
                                        sign = md5(nonce + g)                 (GET)
  заголовки: Authorization=token, x-ourbit-nonce, x-ourbit-sign, Cookie uc_token

НЕ инстанцирует тяжёлый ourbit_direct_broker (тот стартует WS-потоки и снимает все
план-ордера на старте). Здесь — только прямые HTTP вызовы для ручного терминала.
Боевые ордера шлются ТОЛЬКО когда сервер «вооружён» (token задан + LIVE armed).
"""
from __future__ import annotations
import hashlib, json, time, threading

try:
    import proxy as _proxy
except Exception:
    _proxy = None


def _pxy():
    """dict прокси для curl_cffi (proxies=...), либо None — торговля идёт через тот же пул."""
    return _proxy.proxies_dict() if _proxy else None

try:
    from curl_cffi import requests as _http
    def _new_session(): return _http.Session(impersonate="chrome120")
except ImportError:
    import requests as _http  # type: ignore
    def _new_session():
        s = _http.Session(); s.headers.update({"User-Agent": "Mozilla/5.0"}); return s

BASE = "https://futures.ourbit.com/api/v1"

# side (как в ourbit_direct_broker)
OPEN_LONG, CLOSE_SHORT, OPEN_SHORT, CLOSE_LONG = 1, 2, 3, 4
TYPE_LIMIT, TYPE_IOC, TYPE_MARKET = 1, 3, 5
ISOLATED = 1


class ObClient:
    _POOL = 3                              # число торговых соединений (бид+аск+запас не ждут друг друга)

    def __init__(self):
        # Чтение (опрос счёта) — отдельная сессия. Запись (ордера) — ПУЛ соединений, чтобы
        # несколько ордеров подряд шли по РАЗНЫМ каналам и не стояли в очереди (это остаток пинга).
        self._sr = _new_session()          # read: balance/positions/orders/fee/plans
        self._lr = threading.Lock()        # curl_cffi Session не потокобезопасен — сериализуем по сессии
        self._sw_pool = [_new_session() for _ in range(self._POOL)]
        self._sw_locks = [threading.Lock() for _ in range(self._POOL)]
        self._sw_rr = 0
        self._rr_lock = threading.Lock()
        self.token = ""

    def set_token(self, token: str):
        self.token = (token or "").strip()

    def warm(self):
        """Прогреть TCP/TLS обеих сессий (read+write) лёгким GET, чтобы первый ордер/отмена
        НЕ платили полный хендшейк (~0.5–1с). Пул соединений per-host, поэтому GET на write-сессии
        прогревает то же соединение, что переиспользует ордер-POST. Ошибки/404 не важны — важен коннект."""
        pairs = [(self._lr, self._sr)] + list(zip(self._sw_locks, self._sw_pool))
        for lk, s in pairs:
            try:
                with lk:
                    s.get(f"{BASE}/contract/ping", timeout=4)
            except Exception:
                pass

    def warm_trade(self):
        """Прогреть ВСЕ торговые соединения пула — read-сессию греет опрос счёта."""
        for lk, s in zip(self._sw_locks, self._sw_pool):
            try:
                with lk:
                    s.get(f"{BASE}/contract/ping", timeout=4)
            except Exception:
                pass

    # ── подпись ──
    def _hdr_get(self):
        n = str(int(time.time() * 1000))
        g = hashlib.md5(f"{self.token}{n}".encode()).hexdigest()[7:]
        sign = hashlib.md5(f"{n}{g}".encode()).hexdigest()
        return {"Authorization": self.token, "x-ourbit-nonce": n, "x-ourbit-sign": sign,
                "Cookie": f"uc_token={self.token}; u_id={self.token}"}

    def _hdr_post(self, body_json: str):
        n = str(int(time.time() * 1000))
        g = hashlib.md5(f"{self.token}{n}".encode()).hexdigest()[7:]
        sign = hashlib.md5(f"{n}{body_json}{g}".encode()).hexdigest()
        return {"Authorization": self.token, "x-ourbit-nonce": n, "x-ourbit-sign": sign,
                "Content-Type": "application/json", "Cookie": f"uc_token={self.token}; u_id={self.token}",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"}

    def _get(self, path, params=None):
        kw = {"params": params, "headers": self._hdr_get(), "timeout": 15}   # 15с — медленная сеть друга до Ourbit успевает (было 8с → curl(28) таймаут)
        px = _pxy()
        if px:
            kw["proxies"] = px
        with self._lr:                     # read-сессия (опрос счёта) — не мешает торговой
            r = self._sr.get(f"{BASE}{path}", **kw)
        return r.status_code, r.json()

    def _post(self, path, body):
        bj = json.dumps(body, separators=(",", ":"))
        kw = {"data": bj, "headers": self._hdr_post(bj), "timeout": 8}
        px = _pxy()
        if px:
            kw["proxies"] = px
        with self._rr_lock:                # выбрать следующее соединение пула (round-robin)
            i = self._sw_rr; self._sw_rr = (self._sw_rr + 1) % self._POOL
        with self._sw_locks[i]:            # ордера подряд идут по РАЗНЫМ соединениям → не ждут друг друга
            r = self._sw_pool[i].post(f"{BASE}{path}", **kw)
        return r.status_code, r.json()

    # ── чтение ──
    def balance(self):
        _, d = self._get("/private/account/assets")
        for a in (d.get("data") or []):
            if a.get("currency") == "USDT":
                return float(a.get("availableBalance") or 0), float(a.get("equity") or 0)
        return 0.0, 0.0

    def positions(self, symbol=None):
        params = {"symbol": symbol} if symbol else {}     # symbol=None → ВСЕ открытые позиции по всем монетам
        _, d = self._get("/private/position/open_positions", params)
        out = []
        for p in (d.get("data") or []):
            hv = float(p.get("holdVol") or 0)
            if hv > 0:
                out.append({"side": int(p.get("positionType") or 0),  # 1 long, 2 short
                            "vol": hv, "avg": float(p.get("openAvgPrice") or p.get("holdAvgPrice") or 0),
                            "pnl": float(p.get("realised") or p.get("unrealised") or 0),
                            "id": p.get("positionId"),
                            "symbol": p.get("symbol") or (symbol or "")})
        return out

    def get_position_mode(self):
        """Текущий режим позиции: 1 = Hedge (хедж), 2 = One-way (односторонний)."""
        _, d = self._get("/private/position/position_mode")
        return d

    def set_position_mode(self, mode):
        """Сменить режим позиции (только когда нет позиций/ордеров). 1=hedge, 2=one-way."""
        return self._post("/private/position/change_position_mode", {"positionMode": int(mode)})

    def open_orders(self, symbol):
        _, d = self._get("/private/order/list/open_orders", {"symbol": symbol, "page_num": 1, "page_size": 50})
        rows = d.get("data") or []
        return [{"id": o.get("orderId"), "side": int(o.get("side") or 0),
                 "price": float(o.get("price") or 0), "vol": float(o.get("vol") or 0)} for o in rows]

    def fee_check(self):
        """Проверка реального 0% fee по последним закрытым позициям (правило юзера)."""
        _, d = self._get("/private/position/list/history_positions", {"page_num": 1, "page_size": 20})
        rows = d.get("data") or []
        tot = 0.0; n = 0
        for p in rows:
            for k in ("fee", "profitFee", "takerFee", "makerFee", "totalFee"):
                v = p.get(k)
                if v is not None:
                    try: tot += abs(float(v))
                    except (TypeError, ValueError): pass
            n += 1
        return {"samples": n, "total_fee": round(tot, 6), "zero_fee": (n > 0 and tot == 0.0)}

    def history(self, symbol=None, page_size=100, max_pages=12):
        """ВСЯ история ЗАКРЫТЫХ сделок (для Финрез, как MetaScalp «Ваши сделки») — постранично."""
        out = []
        for page in range(1, max_pages + 1):
            params = {"page_num": page, "page_size": page_size}
            if symbol:
                params["symbol"] = symbol
            _, d = self._get("/private/position/list/history_positions", params)
            rows = d.get("data") or []
            if not rows:
                break
            self._parse_history(rows, out)
            if len(rows) < page_size:
                break   # последняя страница
        return out

    @staticmethod
    def _parse_history(rows, out):
        for p in rows:
            cvol = float(p.get("closeVol") or p.get("holdVol") or 0)
            profit = 0.0
            for k in ("realised", "profit", "closeProfitLoss", "realisedPnl"):
                if p.get(k) is not None:
                    try: profit = float(p[k]); break
                    except (TypeError, ValueError): pass
            fee = 0.0
            if p.get("totalFee") is not None:
                try: fee = abs(float(p["totalFee"]))
                except (TypeError, ValueError): pass
            elif p.get("fee") is not None:
                try: fee = abs(float(p["fee"]))
                except (TypeError, ValueError): pass
            else:
                for k in ("takerFee", "makerFee", "profitFee"):
                    if p.get(k) is not None:
                        try: fee += abs(float(p[k]))
                        except (TypeError, ValueError): pass
            out.append({"symbol": p.get("symbol") or "", "side": int(p.get("positionType") or 0),
                        "vol": cvol, "open": float(p.get("openAvgPrice") or 0),
                        "close": float(p.get("closeAvgPrice") or 0), "profit": profit, "fee": fee,
                        "time": p.get("updateTime") or p.get("closeTime") or 0})
        return out

    # ── ордера ──
    def create(self, symbol, side, otype, vol, price, leverage, position_id=None):
        body = {"symbol": symbol, "side": int(side), "openType": ISOLATED, "type": str(otype),
                "vol": int(vol), "leverage": int(leverage), "priceProtect": "0"}
        if otype != TYPE_MARKET:
            body["price"] = str(price)
        if position_id is not None:            # ЗАКРЫТИЕ (side 2/4): без positionId Ourbit ОТКРЫВАЕТ новую позу вместо закрытия!
            body["positionId"] = position_id
        return self._post("/private/order/create", body)

    def cancel(self, order_id):
        return self._post("/private/order/cancel", [order_id])

    def cancel_batch(self, ids):
        """Отменить НЕСКОЛЬКО заявок ОДНИМ запросом (Ourbit принимает массив id) — вместо N round-trip'ов."""
        ids = [i for i in (ids or []) if i is not None]
        if not ids:
            return 200, {"success": True, "data": []}
        return self._post("/private/order/cancel", ids)

    def cancel_all(self, symbol):
        killed = 0; failed = []
        for o in self.open_orders(symbol):
            try:
                self.cancel(o["id"]); killed += 1
            except Exception:
                failed.append(o["id"])
        return killed, failed

    # ── серверный стоп/тейк на бирже (plan-order — переживает падение терминала/связи) ──
    def place_stop(self, symbol, close_side, vol, trigger_price, trigger_type, position_id=None, order_type=5):
        """POST /private/planorder/place — триггер-ордер на бирже.
        close_side: 4=close_long / 2=close_short. triggerType: 2=цена≤триггер(SL лонга)/1=цена≥(SL шорта).
        orderType 5=маркет при срабатывании, trend 2=mark-price, executeCycle 1=24ч."""
        body = {"symbol": symbol, "vol": int(vol), "side": int(close_side), "openType": ISOLATED,
                "triggerPrice": str(trigger_price), "triggerType": int(trigger_type),
                "trend": 2, "orderType": int(order_type), "executeCycle": 1}
        if position_id is not None:
            body["positionId"] = position_id
        return self._post("/private/planorder/place", body)

    def plan_orders(self, symbol):
        _, d = self._get("/private/planorder/list/orders", {"symbol": symbol, "page_num": 1, "page_size": 50})
        return [{"id": o.get("id") or o.get("orderId"), "triggerPrice": o.get("triggerPrice")} for o in (d.get("data") or [])]

    def cancel_plan(self, symbol, plan_id):
        return self._post("/private/planorder/cancel", [{"symbol": symbol, "orderId": str(plan_id)}])

    def cancel_all_plans(self, symbol):
        killed = 0
        for o in self.plan_orders(symbol):
            try:
                if o["id"] is not None:
                    self.cancel_plan(symbol, o["id"]); killed += 1
            except Exception:
                pass
        return killed
