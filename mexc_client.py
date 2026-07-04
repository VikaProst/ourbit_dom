"""Подписанный клиент MEXC futures для DOM-терминала (баланс/позиции/ордера).

ДВА режима авторизации:
  • API  — официальная подпись HMAC-SHA256 (ApiKey+secret). Заголовки ApiKey/Request-Time/Signature,
           база contract.mexc.com. ⚠ фьючерс-API MEXC часто в «обслуживании» — ордера могут не идти.
  • WEB  — веб-токен (uc_token из браузера), схема как у Ourbit (x-mxc-nonce/x-mxc-sign),
           база futures.mexc.com. Используется если задан token, а не key+secret.

MEXC — родитель Ourbit, эндпоинты веб-режима зеркалят ob_client. Боевые ордера — только когда
сервер «вооружён» (клиент подключён + бот в РЕАЛ). Не инстанцирует тяжёлые WS-потоки.
"""
from __future__ import annotations
import hashlib, hmac, json, time, threading

try:
    import proxy as _proxy
except Exception:
    _proxy = None


def _pxy():
    return _proxy.proxies_dict() if _proxy else None


try:
    from curl_cffi import requests as _http
    def _new_session(): return _http.Session(impersonate="chrome120")
except ImportError:
    import requests as _http  # type: ignore
    def _new_session():
        s = _http.Session(); s.headers.update({"User-Agent": "Mozilla/5.0"}); return s

API_BASE = "https://contract.mexc.com/api/v1"     # официальный API (HMAC)
WEB_BASE = "https://futures.mexc.com/api/v1"       # веб-токен (форк Ourbit)

OPEN_LONG, CLOSE_SHORT, OPEN_SHORT, CLOSE_LONG = 1, 2, 3, 4
TYPE_LIMIT, TYPE_IOC, TYPE_MARKET = 1, 3, 5
ISOLATED = 1


class MexcClient:
    _POOL = 3

    def __init__(self):
        self._sr = _new_session()
        self._lr = threading.Lock()
        self._sw_pool = [_new_session() for _ in range(self._POOL)]
        self._sw_locks = [threading.Lock() for _ in range(self._POOL)]
        self._sw_rr = 0
        self._rr_lock = threading.Lock()
        self.token = ""          # веб-токен
        self.key = ""            # API key
        self.secret = ""         # API secret

    def set_token(self, token: str):
        self.token = (token or "").strip(); self.key = ""; self.secret = ""

    def set_creds(self, key: str, secret: str):
        self.key = (key or "").strip(); self.secret = (secret or "").strip(); self.token = ""

    def mode(self) -> str:
        if self.key and self.secret:
            return "api"
        if self.token:
            return "web"
        return ""

    def _base(self):
        return API_BASE if self.mode() == "api" else WEB_BASE

    def has_creds(self) -> bool:
        return self.mode() != ""

    def warm(self):
        base = self._base()
        for lk, s in [(self._lr, self._sr)] + list(zip(self._sw_locks, self._sw_pool)):
            try:
                with lk:
                    s.get(f"{base}/contract/ping", timeout=4)
            except Exception:
                pass

    # ── подпись: API (HMAC) ──
    def _api_hdr(self, sign_target: str):
        ts = str(int(time.time() * 1000))
        sig = hmac.new(self.secret.encode(), (self.key + ts + sign_target).encode(), hashlib.sha256).hexdigest()
        return {"ApiKey": self.key, "Request-Time": ts, "Signature": sig, "Content-Type": "application/json"}

    # ── подпись: WEB (веб-токен, x-mxc-*) ──
    def _web_hdr_get(self):
        n = str(int(time.time() * 1000))
        g = hashlib.md5(f"{self.token}{n}".encode()).hexdigest()[7:]
        sign = hashlib.md5(f"{n}{g}".encode()).hexdigest()
        return {"Authorization": self.token, "x-mxc-nonce": n, "x-mxc-sign": sign,
                "Cookie": f"uc_token={self.token}; u_id={self.token}"}

    def _web_hdr_post(self, body_json: str):
        n = str(int(time.time() * 1000))
        g = hashlib.md5(f"{self.token}{n}".encode()).hexdigest()[7:]
        sign = hashlib.md5(f"{n}{body_json}{g}".encode()).hexdigest()
        return {"Authorization": self.token, "x-mxc-nonce": n, "x-mxc-sign": sign,
                "Content-Type": "application/json", "Cookie": f"uc_token={self.token}; u_id={self.token}",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"}

    def _get(self, path, params=None):
        base = self._base()
        if self.mode() == "api":
            qs = "&".join(f"{k}={params[k]}" for k in sorted(params)) if params else ""
            hdr = self._api_hdr(qs)
        else:
            hdr = self._web_hdr_get()
        kw = {"params": params, "headers": hdr, "timeout": 15}
        px = _pxy()
        if px:
            kw["proxies"] = px
        with self._lr:
            r = self._sr.get(f"{base}{path}", **kw)
        return r.status_code, r.json()

    def _post(self, path, body):
        base = self._base()
        bj = json.dumps(body, separators=(",", ":"))
        hdr = self._api_hdr(bj) if self.mode() == "api" else self._web_hdr_post(bj)
        kw = {"data": bj, "headers": hdr, "timeout": 8}
        px = _pxy()
        if px:
            kw["proxies"] = px
        with self._rr_lock:
            i = self._sw_rr; self._sw_rr = (self._sw_rr + 1) % self._POOL
        with self._sw_locks[i]:
            r = self._sw_pool[i].post(f"{base}{path}", **kw)
        return r.status_code, r.json()

    # ── чтение ──
    def balance(self):
        _, d = self._get("/private/account/assets")
        for a in (d.get("data") or []):
            if a.get("currency") == "USDT":
                return float(a.get("availableBalance") or 0), float(a.get("equity") or 0)
        return 0.0, 0.0

    def positions(self, symbol=None):
        params = {"symbol": symbol} if symbol else {}
        _, d = self._get("/private/position/open_positions", params)
        out = []
        for p in (d.get("data") or []):
            hv = float(p.get("holdVol") or 0)
            if hv > 0:
                out.append({"side": int(p.get("positionType") or 0),
                            "vol": hv, "avg": float(p.get("openAvgPrice") or p.get("holdAvgPrice") or 0),
                            "pnl": float(p.get("realised") or p.get("unrealised") or 0),
                            "id": p.get("positionId"),
                            "symbol": p.get("symbol") or (symbol or "")})
        return out

    def open_orders(self, symbol):
        _, d = self._get("/private/order/list/open_orders", {"symbol": symbol, "page_num": 1, "page_size": 50})
        rows = d.get("data") or []
        return [{"id": o.get("orderId"), "side": int(o.get("side") or 0),
                 "price": float(o.get("price") or 0), "vol": float(o.get("vol") or 0)} for o in rows]

    # ── ордера ──  (API: /order/submit, WEB: /order/create) ──
    def _order_path(self):
        return "/private/order/submit" if self.mode() == "api" else "/private/order/create"

    def create(self, symbol, side, otype, vol, price, leverage, position_id=None):
        body = {"symbol": symbol, "side": int(side), "openType": ISOLATED, "type": str(otype),
                "vol": int(vol), "leverage": int(leverage), "priceProtect": "0"}
        if otype != TYPE_MARKET:
            body["price"] = str(price)
        if position_id is not None:
            body["positionId"] = position_id
        return self._post(self._order_path(), body)

    def cancel(self, order_id):
        return self._post("/private/order/cancel", [order_id])

    def cancel_batch(self, ids):
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
