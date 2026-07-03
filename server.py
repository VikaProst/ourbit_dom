"""Ourbit DOM-стакан — локальный браузерный торговый терминал (MetaScalp-style).

Данные (всё read-only, без авторизации):
  - стакан:  GET https://futures.ourbit.com/api/v1/contract/depth/{SYM}
  - лента:   GET .../contract/deals/{SYM}  (p,v,T=сторона,t=время)
  - инстр.:  GET .../contract/detail       (705 шт, tick/contractSize/maxLev)

Бэкенд (stdlib http.server, без веб-фреймворков):
  GET /                       -> index.html (+ /app.js /style.css)
  GET /api/instruments        -> список инструментов (кэш)
  GET /api/depth?symbol=SYM   -> стакан (прокси)
  GET /api/flow?symbol=SYM    -> аналитика ленты: кластера/дельта/пузыри

Фоновый поток поллит ленту активного символа каждые 0.5с и накапливает её,
из накопления считаются кластера (объём по цене), дельта по минутам и пузыри
агрессивных сделок. Торговля добавляется на Этапе 2 поверх ourbit_direct_broker.

Запуск:  python ourbit_dom/server.py   ->  http://localhost:8777
"""
from __future__ import annotations

import asyncio
import collections
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import urllib.request

try:
    import websockets
    _HAS_WS = True
except ImportError:
    _HAS_WS = False

try:
    from curl_cffi import requests as _http
    _SESSION = _http.Session(impersonate="chrome120")
except ImportError:  # pragma: no cover
    import requests as _http  # type: ignore
    _SESSION = _http.Session()
    _SESSION.headers.update({"User-Agent": "Mozilla/5.0"})

OURBIT_BASE = "https://futures.ourbit.com/api/v1"
PORT = int(os.getenv("OURBIT_DOM_PORT", "8777"))
HERE = os.path.dirname(os.path.abspath(__file__))

# ── пул прокси (REST через curl_cffi proxies=, WS best-effort) ──
try:
    import proxy as _proxy
except Exception:
    _proxy = None
_raw_get = _SESSION.get
def _get(url, **kw):
    """GET к бирже через активный прокси (если задан)."""
    if _proxy:
        pd = _proxy.proxies_dict()
        if pd:
            kw.setdefault("proxies", pd)
    return _raw_get(url, **kw)


_raw_post = _SESSION.post


def _post(url, json=None, **kw):
    """POST к бирже через активный прокси (для HyperLiquid и т.п.)."""
    if _proxy:
        pd = _proxy.proxies_dict()
        if pd:
            kw.setdefault("proxies", pd)
    return _raw_post(url, json=json, **kw)

import inspect as _inspect
_WS_PROXY_OK = _HAS_WS and _proxy and ("proxy" in _inspect.signature(websockets.connect).parameters)
def _ws_kw():
    """kwargs для websockets.connect: proxy=..., если версия поддерживает И включён WS-прокси."""
    if _WS_PROXY_OK:
        u = _proxy.ws_url()
        if u:
            return {"proxy": u}
    return {}

_INSTR = {"ts": 0.0, "data": None, "tick": {}}
_INSTR_TTL = 300.0


def _instruments() -> list[dict]:
    now = time.time()
    if _INSTR["data"] and now - _INSTR["ts"] < _INSTR_TTL:
        return _INSTR["data"]
    rows = _get(f"{OURBIT_BASE}/contract/detail", timeout=12).json().get("data") or []
    slim, tickmap = [], {}
    for r in rows:
        sym = r.get("symbol")
        if not sym:
            continue
        tickmap[sym] = r.get("priceUnit")
        slim.append({
            "symbol": sym, "tick": r.get("priceUnit"),
            "contractSize": r.get("contractSize"), "maxLev": r.get("maxLeverage"),
        })
    _INSTR.update({"ts": now, "data": slim, "tick": tickmap})
    return slim


def _tick_of(symbol: str) -> float:
    if not _INSTR["tick"]:
        _instruments()
    return float(_INSTR["tick"].get(symbol) or 0.01)


def _clean_book(bids, asks):
    """Отсортировать (бид ↓, аск ↑), убрать нулевые уровни и пересечение — чистые края книги для клиента."""
    def norm(rows):
        out = []
        for x in rows:
            try:
                p = float(x[0]); v = float(x[1])
            except (TypeError, ValueError, IndexError):
                continue
            if v > 0:
                out.append([p, v, x[2] if len(x) > 2 else 1])
        return out
    b = sorted(norm(bids), key=lambda x: -x[0])
    a = sorted(norm(asks), key=lambda x: x[0])
    if b and a and b[0][0] >= a[0][0]:          # пересечение → режем перекрытие по краям
        ba, bb = a[0][0], b[0][0]
        b2 = [x for x in b if x[0] < ba]
        a2 = [x for x in a if x[0] > bb]
        if b2 and a2:
            b, a = b2, a2
    return b, a


def _depth(symbol: str) -> dict:
    data = _get(f"{OURBIT_BASE}/contract/depth/{symbol}", timeout=8).json().get("data") or {}
    b, a = _clean_book(data.get("bids") or [], data.get("asks") or [])
    return {"symbol": symbol, "bids": b, "asks": a,
            "ts": data.get("timestamp") or int(time.time() * 1000)}


def _fetch_deals(symbol: str) -> list:
    return _get(f"{OURBIT_BASE}/contract/deals/{symbol}", timeout=8).json().get("data") or []


# ─────────────────── Накопитель ленты сделок (flow) ───────────────────
class FlowState:
    """Хранит недавние сделки символа и считает кластера/дельту/пузыри."""
    def __init__(self):
        self.deals = collections.deque(maxlen=15000)   # (t, p, v, side) side: 1 buy / 2 sell
        self.seen = collections.deque(maxlen=15000)
        self.seen_set: set = set()
        self.lock = threading.Lock()

    def add(self, t, p, v, side, key):
        if key in self.seen_set:
            return
        if len(self.seen) == self.seen.maxlen:        # вытеснение старых ключей
            self.seen_set.discard(self.seen[0])
        self.seen.append(key)
        self.seen_set.add(key)
        self.deals.append((t, p, v, side))

    def merge(self, raw: list):
        for d in raw:
            try:
                t = int(d.get("t")); p = float(d.get("p")); v = float(d.get("v"))
                side = 1 if int(d.get("T", 1)) == 1 else 2
                key = f"{t}-{d.get('p')}-{d.get('v')}-{d.get('O')}-{d.get('M')}"
            except (TypeError, ValueError):
                continue
            self.add(t, p, v, side, key)

    def snapshot(self, tick: float, fp_minutes: int = 3) -> dict:
        now_ms = int(time.time() * 1000)
        with self.lock:
            deals = list(self.deals)
        delta: dict = {}            # minute -> [buyVol, sellVol]
        fp: dict = {}               # minute -> {tickint: [buyVol, sellVol]}  (футпринт время×цена)
        for (t, p, v, side) in deals:
            ti = round(p / tick)
            m = t // 60000
            dd = delta.get(m)
            if dd is None:
                dd = delta[m] = [0.0, 0.0]
            dd[0 if side == 1 else 1] += v
            col = fp.get(m)
            if col is None:
                col = fp[m] = {}
            cell = col.get(ti)
            if cell is None:
                cell = col[ti] = [0.0, 0.0]
            cell[0 if side == 1 else 1] += v

        # сырые тики — АБСОЛЮТНО КАЖДАЯ сделка за 3 минуты (без агрегации, без обрезки объёмов)
        cutoff = now_ms - 180_000
        ticks = [{"p": round(p, 8), "v": round(v), "side": side, "t": t}
                 for (t, p, v, side) in deals if t >= cutoff]
        ticks = ticks[-4000:]

        dmin = sorted(delta.keys())[-30:]
        delta_out = [[int(m), round(delta[m][0]), round(delta[m][1])] for m in dmin]
        # футпринт: последние N минутных колонок (время×цена), N задаётся настройкой
        fmin = sorted(fp.keys())[-max(1, fp_minutes):]
        fp_out = [{"t": int(m), "cells": {str(k): [round(b), round(s)] for k, (b, s) in fp[m].items()}}
                  for m in fmin]
        return {
            "footprint": fp_out,
            "delta": delta_out,
            "ticks": ticks,
            "now": now_ms,
        }

    def ticks_only(self, limit: int = 400) -> dict:
        """Лёгкий срез: только последние сделки для ленты (без тяжёлого футпринта/дельты).
        Шлётся часто (лента успевает за ценой при волатильности)."""
        now_ms = int(time.time() * 1000)
        with self.lock:
            deals = list(self.deals)[-limit:]
        ticks = [{"p": round(p, 8), "v": round(v), "side": side, "t": t}
                 for (t, p, v, side) in deals]
        return {"ticks": ticks, "now": now_ms}


_FLOW: dict = {}
_FLOW_LOCK = threading.Lock()
_ACTIVE = {"symbol": "XAUT_USDT"}
_WANTED: dict = {}                 # symbol -> last_request_ms: живые книги для ВСЕХ открытых стаканов (мультиокно)
_WANTED_LOCK = threading.Lock()


def _want(sym):
    if sym:
        with _WANTED_LOCK:
            _WANTED[sym] = int(time.time() * 1000)

# ─── торговля (Этап 2): лёгкий подписанный клиент + защита ───
from ob_client import ObClient, TYPE_MARKET
_OB = ObClient()
_TRADE = {"connected": False, "armed": False, "zero_fee": False,
          "balance": 0.0, "equity": 0.0, "fee": None, "auto_stop": False}   # биржевые SL/TP ВЫКЛ по умолчанию (план-ордера накапливались и переоткрывали позы). Стоп — application-side в терминале
_MAX_VOL = 500000        # аварийный верхний предел контрактов на 1 ордер (защита от NaN/аномалии)


def _place_server_stop(symbol, pos_side, avg, vol, sl_pct, tp_pct, position_id=None):
    """Ставит биржевой SL/TP (plan-order) после открытия. pos_side: 1 long / 2 short.
    Переживает падение терминала/связи. Возвращает список размещённых planOrderId."""
    placed = []
    if avg <= 0 or vol <= 0:
        return placed
    close_side = 4 if pos_side == 1 else 2               # 4=close_long / 2=close_short
    try:
        if sl_pct and sl_pct > 0:
            sl = avg * (1 - sl_pct / 100) if pos_side == 1 else avg * (1 + sl_pct / 100)
            tt = 2 if pos_side == 1 else 1               # long SL: цена≤ ; short SL: цена≥
            _, r = _OB.place_stop(symbol, close_side, vol, round(sl, 8), tt, position_id)
            if r.get("success"):
                placed.append(r.get("data"))
        if tp_pct and tp_pct > 0:
            tp = avg * (1 + tp_pct / 100) if pos_side == 1 else avg * (1 - tp_pct / 100)
            tt = 1 if pos_side == 1 else 2               # long TP: цена≥ ; short TP: цена≤
            _, r = _OB.place_stop(symbol, close_side, vol, round(tp, 8), tt, position_id)
            if r.get("success"):
                placed.append(r.get("data"))
    except Exception:
        pass
    return placed


def _async_place_stop(sym, sl_pct, tp_pct):
    """Фоном: дождаться позиции и поставить биржевой SL/TP — чтобы ответ на ордер уходил мгновенно."""
    try:
        time.sleep(0.4)
        poss = _OB.positions(sym)
        if poss:
            p = poss[0]
            _place_server_stop(sym, p["side"], p["avg"], int(p["vol"]), sl_pct, tp_pct, p.get("id"))
    except Exception:
        pass


def _async_cancel_plans(sym):
    try:
        _OB.cancel_all_plans(sym)
    except Exception:
        pass


# ── АКТИВАЦИЯ по ключу (1 ключ = 1 IP): проверка на сервере активации Вики ──
_ACT = {"ok": False, "ts": 0.0}

def _act_cfg(fname):
    try:
        for line in open(os.path.join(HERE, fname), encoding="utf-8").read().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):   # ПЕРВАЯ непустая строка без # (комментарий в файле не ломает чтение ключа)
                return line
        return ""
    except Exception:
        return ""

def _activation_ok():
    srv = _act_cfg("license_server.txt").rstrip("/")
    if not srv:
        # БАЗОВЫЙ режим (без сервера): проверка ключа по локальному keys.json (без привязки к IP)
        try:
            allowed = json.load(open(os.path.join(HERE, "keys.json"), encoding="utf-8")).get("allowed") or []
        except Exception:
            allowed = []
        if not allowed:
            return True, "активация не требуется"   # список ключей пуст → открыто (у хозяина/в dev)
        key = _act_cfg("license.txt")
        if not key:
            return False, "нет ключа активации — впиши его в license.txt (попроси у Вики)"
        import hashlib
        if hashlib.sha256(key.encode()).hexdigest() in allowed:
            return True, "ok"
        return False, "ключ недействителен или отозван"
    # СТРОГИЙ режим (1 ключ = 1 IP) через сервер активации
    if _ACT["ok"] and time.time() - _ACT["ts"] < 6 * 3600:
        return True, "ok"                          # успешный кэш 6ч — краткий простой сервера не блокирует
    key = _act_cfg("license.txt")
    if not key:
        return False, "нет ключа активации — впиши его в license.txt (попроси у Вики)"
    try:
        body = json.dumps({"key": key}).encode()
        req = urllib.request.Request(srv + "/activate", data=body,
                                     headers={"Content-Type": "application/json", "User-Agent": "term"})
        r = json.loads(urllib.request.urlopen(req, timeout=8).read().decode())
    except Exception:
        return (True, "ok") if _ACT["ok"] else (False, "сервер активации недоступен, попробуй позже")
    if r.get("ok"):
        _ACT.update({"ok": True, "ts": time.time()})
        return True, "ok"
    return False, r.get("reason") or "ключ не принят"


def _trade_connect(token: str) -> dict:
    _OB.set_token(token)
    try:
        avail, equity = _OB.balance()
    except Exception as exc:
        _TRADE.update({"connected": False, "armed": False})
        return {"ok": False, "error": f"токен не принят: {exc}"}
    if avail == 0.0 and equity == 0.0:
        # часто = истёкший токен (assets вернул 401/пусто)
        _TRADE.update({"connected": False, "armed": False})
        return {"ok": False, "error": "баланс 0 — либо НЕТ USDT на ФЬЮЧЕРСАХ (переведи со спота), либо токен истёк (пришли свежий uc_token)"}
    try:
        fee = _OB.fee_check()
    except Exception:
        fee = {"samples": 0, "total_fee": 0, "zero_fee": False}
    _TRADE.update({"connected": True, "armed": False, "zero_fee": fee.get("zero_fee", False),
                   "balance": avail, "equity": equity, "fee": fee})
    threading.Thread(target=_OB.warm, daemon=True).start()   # прогреть торговое соединение сразу (минимальный пинг 1-го ордера)
    return {"ok": True, "balance": avail, "equity": equity, "fee": fee, "state": _trade_state()}


def _conn_keepalive():
    """Держим TCP/TLS торгового соединения тёплым, пока подключены — иначе Ourbit закрывает
    простаивающий коннект и следующий ордер/отмена платит хендшейк (был пинг >1.5с)."""
    while True:
        time.sleep(6)                        # Ourbit рвёт idle-коннект к ~10-15с (замерено) → греем каждые 6с, чтобы ВСЕГДА тёплое
        if _TRADE.get("connected"):
            try: _OB.warm_trade()            # греем только торговую сессию (read тёплая от опроса счёта)
            except Exception: pass


def _trade_state() -> dict:
    return {k: _TRADE[k] for k in ("connected", "armed", "zero_fee", "balance", "equity", "fee")}


def _fee_watchdog():
    """Обновляем инфо о комиссии (для показа). LIVE НЕ снимаем — юзер торгует при любой комиссии."""
    while True:
        time.sleep(300)
        if _TRADE.get("connected"):
            try:
                fee = _OB.fee_check()
                _TRADE["fee"] = fee
                _TRADE["zero_fee"] = fee.get("zero_fee", False)
            except Exception:
                pass


def _flow_for(symbol: str) -> FlowState:
    with _FLOW_LOCK:
        fs = _FLOW.get(symbol)
        if fs is None:
            fs = _FLOW[symbol] = FlowState()
        return fs


def _poller():
    while True:
        sym = _ACTIVE["symbol"]
        try:
            raw = _fetch_deals(sym)
            fs = _flow_for(sym)
            with fs.lock:
                fs.merge(raw)
        except Exception:
            pass
        time.sleep(0.5)


# ─────────── Скринер: топ по обороту за окно (напр. 30с) по ВСЕМ инструментам ───────────
_SCREENER = {"hist": collections.deque(maxlen=60), "lock": threading.Lock()}   # (t, {sym:(amount24, volume24, rise, last, bid, ask)})

# ─────────── Поминутный БАКЕТНЫЙ движок метрик (MetaScalp-style ядро) ───────────
# На инструмент: кольцо поминутных бакетов [o,h,l,c,oi,turn,trades,delta] за последние _MB_KEEP минут.
# Наполняется: цена/OI из all-ticker (2с), оборот/сделки/дельта из WS-ленты (каждая сделка).
# Любая метрика за любой TF = агрегат по нужному числу последних бакетов.
_MB: dict = {}
_MB_LOCK = threading.Lock()
_SLOT = 60               # поминутные бакеты (для цены/OHLC/OI/NATR — они «сброса» не дают)
_MB_KEEP = 75            # минут истории. Суммы (сделки/оборот/дельта) считаем СКОЛЬЗЯЩИМ окном из ленты (без сброса)
_O, _H, _L, _C, _OI, _TURN, _TR, _DELTA = 0, 1, 2, 3, 4, 5, 6, 7


def _mb_get(sym, minute):
    d = _MB.get(sym)
    if d is None:
        d = _MB[sym] = {}
    b = d.get(minute)
    if b is None:
        b = d[minute] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0]
    return d, b


def _mb_price(sym, price, oi):
    if price <= 0:
        return
    m = int(time.time() // _SLOT)
    with _MB_LOCK:
        d, b = _mb_get(sym, m)
        if b[_O] == 0.0:
            b[_O] = price
        if b[_H] == 0.0 or price > b[_H]:
            b[_H] = price
        if b[_L] == 0.0 or price < b[_L]:
            b[_L] = price
        b[_C] = price
        if oi > 0:
            b[_OI] = oi
        cutoff = m - _MB_KEEP
        for k in [k for k in d if k < cutoff]:
            del d[k]


def _mb_deal(sym, notional, sign):
    m = int(time.time() // _SLOT)
    with _MB_LOCK:
        _, b = _mb_get(sym, m)
        b[_TURN] += notional
        b[_TR] += 1
        b[_DELTA] += sign


def _mb_copy(sym):
    with _MB_LOCK:
        d = _MB.get(sym)
        return dict(d) if d else {}


def _agg_window(d, now_m, tf, offset=0):
    """Агрегат за окно [now-offset-tf+1 .. now-offset]: оборот/сделки/дельта + hi/lo + ATR (по true range бакетов)."""
    turn = 0.0; trades = 0; delta = 0.0; hi = 0.0; lo = 0.0; trsum = 0.0; trn = 0; prevc = None
    for k in range(now_m - offset - tf + 1, now_m - offset + 1):
        b = d.get(k)
        if not b:
            prevc = None
            continue
        turn += b[_TURN]; trades += b[_TR]; delta += b[_DELTA]
        if b[_H] > 0:
            hi = b[_H] if hi == 0 else max(hi, b[_H])
            lo = b[_L] if lo == 0 else min(lo, b[_L])
            tr = b[_H] - b[_L]
            if prevc is not None:
                tr = max(tr, abs(b[_H] - prevc), abs(b[_L] - prevc))
            trsum += tr; trn += 1; prevc = b[_C]
    return {"turn": turn, "trades": trades, "delta": delta, "hi": hi, "lo": lo,
            "atr": (trsum / trn) if trn else 0.0}


def _close_at(d, m):
    b = d.get(m)
    return b[_C] if (b and b[_C] > 0) else None


def _close_ago(d, now_m, tf):
    """Цена закрытия примерно tf минут назад (ближайший доступный бакет ≤ now-tf)."""
    for k in range(now_m - tf, now_m - _MB_KEEP - 1, -1):
        c = _close_at(d, k)
        if c:
            return c
    return None


def _screener_poller():
    while True:
        try:
            r = _get(f"{OURBIT_BASE}/contract/ticker", timeout=10)
            data = r.json().get("data") or []
            snap = {}
            for t in data:
                sym = t.get("symbol")
                if not sym:
                    continue
                last = float(t.get("lastPrice") or 0); oi = float(t.get("holdVol") or 0)
                snap[sym] = (float(t.get("amount24") or 0), float(t.get("volume24") or 0),
                             float(t.get("riseFallRate") or 0), last,
                             float(t.get("bid1") or 0), float(t.get("ask1") or 0),
                             float(t.get("fundingRate") or 0), oi)
                _mb_price(sym, last, oi)                 # питаем бакеты ценой/OI
            with _SCREENER["lock"]:
                _SCREENER["hist"].append((time.time(), snap))
            with _EX_SYMS_LOCK:
                _EX_SYMS["ourbit"] = set(snap.keys())    # принадлежность для полоски бейджей
        except Exception:
            pass
        time.sleep(2)


_VSPIKE_K = 3        # число предыдущих окон для базы всплеска
# веса композитной «Активности» (0..100): сделки/оборот/NATR/всплеск
_ACT_W = {"trades": 0.40, "amt": 0.35, "natr": 0.15, "vspike": 0.10}


def _screener_top(win_min: float = 1.0, n: int = 40, tfs: dict = None) -> list:
    """Ourbit-скринер на бакетном движке: точные формулы MetaScalp, per-metric TF (минуты)."""
    tfs = tfs or {}
    def TF(metric):
        try:
            return max(1, int(tfs.get(metric, win_min)))
        except (TypeError, ValueError):
            return max(1, int(win_min))
    with _SCREENER["lock"]:
        hist = list(_SCREENER["hist"])
    if not hist:
        return []
    cur = hist[-1][1]
    now_m = int(time.time() // 60)
    now_ms = int(time.time() * 1000)
    rows = []
    for sym, tup in cur.items():
        amt24, vol24, rise24, last, bid, ask, funding, oi = tup
        if last <= 0:
            continue
        d = _mb_copy(sym)
        # Изменение % за TF: (c_now − c_[TF назад]) / c_[TF назад] (из поминутных бакетов)
        pago = _close_ago(d, now_m, TF("rise"))
        change = (last - pago) / pago * 100 if pago else 0.0
        # Сделки / Оборот$ / Дельта — СКОЛЬЗЯЩЕЕ окно из ленты (без «сброса» на границе минуты, дёшево)
        trades = _deal_metrics(sym, now_ms - TF("trades") * 60000)[0]
        turn = _deal_metrics(sym, now_ms - TF("amt") * 60000)[1]
        _c, dturn, delta = _deal_metrics(sym, now_ms - TF("dusd") * 60000)
        # NATR% = ATR(окно)/price
        natr = _agg_window(d, now_m, TF("natr"))["atr"] / last * 100 if last else 0.0
        # Спред% — мгновенный
        mid = (bid + ask) / 2 if (bid and ask) else last
        spread = (ask - bid) / mid * 100 if (bid and ask and mid) else 0.0
        # Всплеск объёма/сделок% = тек.окно / пред.окно (скользяще из ленты)
        tfv = TF("vspike") * 60000
        cur_v = _deal_metrics(sym, now_ms - tfv)[1]; prev_v = _deal_metrics(sym, now_ms - 2 * tfv)[1] - cur_v
        vspike = cur_v / prev_v * 100 if prev_v > 0 else 0.0
        tft = TF("tspike") * 60000
        cur_t = _deal_metrics(sym, now_ms - tft)[0]; prev_t = _deal_metrics(sym, now_ms - 2 * tft)[0] - cur_t
        tspike = cur_t / prev_t * 100 if prev_t > 0 else 0.0
        # Изм. ОИ% и ОИ$ за TF
        oib = d.get(now_m - TF("oipct"))
        oi_ago = oib[_OI] if (oib and oib[_OI] > 0) else oi
        oi_pct = (oi - oi_ago) / oi_ago * 100 if oi_ago else 0.0
        oi_usd = (oi - oi_ago) * last
        rows.append({"symbol": sym, "ex": "ourbit", "rise": round(change, 2), "last": last, "bid": bid, "ask": ask,
                     "amt": round(turn), "vol": round(trades), "spread": round(spread, 4), "trades": trades,
                     "dusd": round(delta), "dpct": round(delta / dturn * 100, 2) if dturn else 0.0,
                     "natr": round(natr, 3), "funding": round(funding * 100, 4),
                     "oipct": round(oi_pct, 2), "oiusd": round(oi_usd), "vspike": round(vspike), "tspike": round(tspike)})
    # Композитная «Активность» — нормировка компонент по набору + взвешенная сумма
    mtr = max((r["trades"] for r in rows), default=1) or 1
    mam = max((r["amt"] for r in rows), default=1) or 1
    mna = max((r["natr"] for r in rows), default=1) or 1
    mvs = max((r["vspike"] for r in rows), default=1) or 1
    for r in rows:
        a = (_ACT_W["trades"] * r["trades"] / mtr + _ACT_W["amt"] * r["amt"] / mam +
             _ACT_W["natr"] * min(1.0, r["natr"] / mna) + _ACT_W["vspike"] * min(1.0, r["vspike"] / mvs))
        r["act"] = round(min(100.0, a * 100))
        # СБОР-СКОР (стратегия сбора спреда «ARPA-подобные»): жирный тик × прострелы × свипы, гейт по ликвидности.
        # Идея: низкая цена → 1 тик = жирный % (spread%), активная волатильность (natr) даёт прострелы-филлы, всплеск = свипы через стенки.
        liq = 0.0 if r["amt"] < 15000 else min(1.0, r["amt"] / 150000.0)   # <$15k оборота = мёртвая, отсекаем; плавно к 1 на $150k
        spr = min(1.0, r["spread"] / 0.12)     # спред(тик)% 0.12%+ = жирный тик
        vol = min(1.0, r["natr"] / 2.5)        # NATR 2.5%+ = активные прострелы
        vsp = min(1.0, r["vspike"] / 250.0)    # всплеск x2.5 = свипы
        r["scoll"] = round(min(100.0, (0.50 * spr + 0.32 * vol + 0.18 * vsp) * liq * 100))
    rows.sort(key=lambda r: (r["amt"], r["trades"]), reverse=True)
    return rows[:n]


_SCR_CACHE: dict = {}     # (win,n,tfs) -> (ts, rows) — кэш пересчёта: несколько окон-пользователей → 1 пересчёт


def _screener_top_cached(win, n, tfs):
    key = (round(float(win), 3), int(n), json.dumps(tfs, sort_keys=True) if tfs else "")
    now = time.time()
    ent = _SCR_CACHE.get(key)
    if ent and now - ent[0] < 1.4:
        return ent[1]
    rows = _screener_top(win, n, tfs)
    _SCR_CACHE[key] = (now, rows)
    if len(_SCR_CACHE) > 24:
        for k in [k for k, v in list(_SCR_CACHE.items()) if now - v[0] > 8]:
            _SCR_CACHE.pop(k, None)
    return rows


# ─────────── Скринер: МУЛЬТИБИРЖА (только данные, публичный REST, без торговли) ───────────
# Каждый адаптер: как получить all-tickers фьючерсов и распарсить строку в кортеж
# (symbol, last, bid, ask, turnover_usdt, base_vol, rise_ratio). rise — ДОЛЯ (×100=%).
_EX_ADAPTERS: dict = {}
_EX_HIST: dict = {}


def _ff(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _sym_strip_usdt(s: str) -> str:
    """BTCUSDT -> BTC_USDT (пусто если не USDT)."""
    s = (s or "").upper()
    return s[:-4] + "_USDT" if s.endswith("USDT") else ""


def _reg_ex(ex, url, parse=None, list_path="data", method="GET", body=None, build=None, headers=None):
    _EX_ADAPTERS[ex] = {"url": url, "parse": parse, "list": list_path,
                        "method": method, "body": body, "build": build, "headers": headers}
    _EX_HIST[ex] = {"hist": collections.deque(maxlen=60), "lock": threading.Lock()}


def _dig(js, path):
    if path == "root":
        return js
    cur = js
    for k in path.split("."):
        cur = cur.get(k) if isinstance(cur, dict) else None
        if cur is None:
            return None
    return cur


def _weex_norm_sym(raw: str) -> str:
    s = (raw or "").lower()
    if s.startswith("cmt_"):
        s = s[4:]
    return _sym_strip_usdt(s)


# ── парсеры по биржам ──
def _p_weex(t):
    s = _weex_norm_sym(t.get("symbol"))
    return (s, _ff(t.get("last")), _ff(t.get("best_bid")), _ff(t.get("best_ask")),
            _ff(t.get("volume_24h")), _ff(t.get("base_volume")), _ff(t.get("priceChangePercent"))) if s else None


def _p_mexc(t):
    s = (t.get("symbol") or "").upper()
    if not s.endswith("_USDT"):
        return None
    return (s, _ff(t.get("lastPrice")), _ff(t.get("bid1")), _ff(t.get("ask1")),
            _ff(t.get("amount24")), _ff(t.get("volume24")), _ff(t.get("riseFallRate")))


def _p_bybit(t):
    s = _sym_strip_usdt(t.get("symbol"))
    return (s, _ff(t.get("lastPrice")), _ff(t.get("bid1Price")), _ff(t.get("ask1Price")),
            _ff(t.get("turnover24h")), _ff(t.get("volume24h")), _ff(t.get("price24hPcnt"))) if s else None


def _p_okx(t):
    iid = t.get("instId") or ""
    if not iid.endswith("-USDT-SWAP"):
        return None
    last = _ff(t.get("last")); op = _ff(t.get("open24h"))
    volc = _ff(t.get("volCcy24h"))
    return (iid[:-10] + "_USDT", last, _ff(t.get("bidPx")), _ff(t.get("askPx")),
            volc * last, volc, (last - op) / op if op else 0.0)


def _p_gate(t):
    s = (t.get("contract") or "").upper()
    if not s.endswith("_USDT"):
        return None
    return (s, _ff(t.get("last")), _ff(t.get("highest_bid")), _ff(t.get("lowest_ask")),
            _ff(t.get("volume_24h_quote")), _ff(t.get("volume_24h_base")), _ff(t.get("change_percentage")) / 100.0)


def _p_bitget(t):
    s = _sym_strip_usdt(t.get("symbol"))
    return (s, _ff(t.get("lastPr")), _ff(t.get("bidPr")), _ff(t.get("askPr")),
            _ff(t.get("usdtVolume")), _ff(t.get("baseVolume")), _ff(t.get("change24h"))) if s else None


def _p_kucoin(t):
    if t.get("quoteCurrency") != "USDT" or t.get("settleCurrency") != "USDT" or t.get("isInverse"):
        return None
    s = (t.get("symbol") or "")
    if s.endswith("M"):
        s = s[:-1]
    base = _sym_strip_usdt(s)
    if not base:
        return None
    if base.startswith("XBT_"):
        base = "BTC_USDT"
    return (base, _ff(t.get("lastTradePrice")), 0.0, 0.0,
            _ff(t.get("turnoverOf24h")), _ff(t.get("volumeOf24h")), _ff(t.get("priceChgPct")))


def _p_bingx(t):
    s = (t.get("symbol") or "")
    if not s.endswith("-USDT"):
        return None
    return (s.replace("-", "_"), _ff(t.get("lastPrice")), _ff(t.get("bidPrice")), _ff(t.get("askPrice")),
            _ff(t.get("quoteVolume")), _ff(t.get("volume")), _ff(t.get("priceChangePercent")) / 100.0)


def _p_htx(t):
    s = (t.get("contract_code") or "")
    if not s.endswith("-USDT"):
        return None
    bid = t.get("bid"); ask = t.get("ask")
    bidp = _ff(bid[0]) if isinstance(bid, list) and bid else 0.0
    askp = _ff(ask[0]) if isinstance(ask, list) and ask else 0.0
    last = _ff(t.get("close")); op = _ff(t.get("open"))
    return (s.replace("-", "_"), last, bidp, askp,
            _ff(t.get("trade_turnover")), _ff(t.get("amount")), (last - op) / op if op else 0.0)


def _p_bitmart(t):
    base = _sym_strip_usdt(t.get("symbol"))
    return (base, _ff(t.get("last_price")), 0.0, 0.0,
            _ff(t.get("turnover_24h")), _ff(t.get("volume_24h")), _ff(t.get("change_24h"))) if base else None


def _p_xt(t):
    s = (t.get("s") or "").upper()
    return (s, _ff(t.get("c")), 0.0, 0.0, _ff(t.get("v")), _ff(t.get("a")), _ff(t.get("r"))) if s.endswith("_USDT") else None


def _p_lbank(t):
    base = _sym_strip_usdt(t.get("symbol"))
    if not base:
        return None
    last = _ff(t.get("lastPrice")); op = _ff(t.get("openPrice"))
    return (base, last, 0.0, 0.0, _ff(t.get("turnover")), _ff(t.get("volume")), (last - op) / op if op else 0.0)


def _p_blofin(t):
    iid = (t.get("instId") or "")
    if not iid.endswith("-USDT"):
        return None
    last = _ff(t.get("last")); op = _ff(t.get("open24h"))
    volc = _ff(t.get("volCurrency24h"))
    return (iid.replace("-", "_"), last, _ff(t.get("bidPrice")), _ff(t.get("askPrice")),
            volc * last, volc, (last - op) / op if op else 0.0)


def _p_bitunix(t):
    base = _sym_strip_usdt(t.get("symbol"))
    if not base:
        return None
    last = _ff(t.get("lastPrice")); op = _ff(t.get("open"))
    return (base, last, 0.0, 0.0, _ff(t.get("quoteVol")), _ff(t.get("baseVol")), (last - op) / op if op else 0.0)


def _p_whitebit(t):
    if t.get("money_currency") != "USDT":
        return None
    base = (t.get("stock_currency") or "").upper()
    return (base + "_USDT", _ff(t.get("last_price")), _ff(t.get("bid")), _ff(t.get("ask")),
            _ff(t.get("money_volume")), _ff(t.get("stock_volume")), 0.0) if base else None


def _p_aster(t):
    base = _sym_strip_usdt(t.get("symbol"))
    return (base, _ff(t.get("lastPrice")), 0.0, 0.0,
            _ff(t.get("quoteVolume")), _ff(t.get("volume")), _ff(t.get("priceChangePercent")) / 100.0) if base else None


def _p_binance(t):
    base = _sym_strip_usdt(t.get("symbol"))
    return (base, _ff(t.get("lastPrice")), 0.0, 0.0,
            _ff(t.get("quoteVolume")), _ff(t.get("volume")), _ff(t.get("priceChangePercent")) / 100.0) if base else None


def _p_binance_spot(t):
    base = _sym_strip_usdt(t.get("symbol"))          # спот /api/v3/ticker/24hr — есть bid/ask
    return (base, _ff(t.get("lastPrice")), _ff(t.get("bidPrice")), _ff(t.get("askPrice")),
            _ff(t.get("quoteVolume")), _ff(t.get("volume")), _ff(t.get("priceChangePercent")) / 100.0) if base else None


def _p_lighter(t):
    if t.get("market_type") != "perp" or t.get("status") != "active":
        return None
    base = (t.get("symbol") or "").upper()
    return (base + "_USDT", _ff(t.get("last_trade_price")), 0.0, 0.0,
            _ff(t.get("daily_quote_token_volume")), _ff(t.get("daily_base_token_volume")),
            _ff(t.get("daily_price_change")) / 100.0) if base else None


def _build_hyperliquid(js):
    snap = {}
    try:
        universe = js[0].get("universe") or []
        ctxs = js[1] or []
    except (IndexError, AttributeError, TypeError):
        return snap
    for i, u in enumerate(universe):
        if i >= len(ctxs) or u.get("isDelisted"):
            continue
        name = u.get("name")
        if not name:
            continue
        c = ctxs[i]
        last = _ff(c.get("markPx")); prev = _ff(c.get("prevDayPx"))
        snap[name.upper() + "_USDT"] = (_ff(c.get("dayNtlVlm")), _ff(c.get("dayBaseVlm")),
                                        (last - prev) / prev if prev else 0.0, last, 0.0, 0.0)
    return snap


_reg_ex("weex", "https://api-contract.weex.com/capi/v2/market/tickers", _p_weex, list_path="root")
_reg_ex("mexc", "https://contract.mexc.com/api/v1/contract/ticker", _p_mexc, list_path="data")
_reg_ex("bybit", "https://api.bybit.com/v5/market/tickers?category=linear", _p_bybit, list_path="result.list")
_reg_ex("okx", "https://www.okx.com/api/v5/market/tickers?instType=SWAP", _p_okx, list_path="data")
_reg_ex("gate", "https://api.gateio.ws/api/v4/futures/usdt/tickers", _p_gate, list_path="root")
_reg_ex("bitget", "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures", _p_bitget, list_path="data")
_reg_ex("kucoin", "https://api-futures.kucoin.com/api/v1/contracts/active", _p_kucoin, list_path="data")
_reg_ex("bingx", "https://open-api.bingx.com/openApi/swap/v2/quote/ticker", _p_bingx, list_path="data")
_reg_ex("htx", "https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged", _p_htx, list_path="ticks")
_reg_ex("bitmart", "https://api-cloud-v2.bitmart.com/contract/public/details", _p_bitmart, list_path="data.symbols")
_reg_ex("xt", "https://fapi.xt.com/future/market/v1/public/q/tickers", _p_xt, list_path="result")
_reg_ex("lbank", "https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU", _p_lbank, list_path="data")
_reg_ex("blofin", "https://openapi.blofin.com/api/v1/market/tickers", _p_blofin, list_path="data")
_reg_ex("bitunix", "https://fapi.bitunix.com/api/v1/futures/market/tickers", _p_bitunix, list_path="data")
_reg_ex("whitebit", "https://whitebit.com/api/v4/public/futures", _p_whitebit, list_path="result")
_reg_ex("asterdex", "https://fapi.asterdex.com/fapi/v1/ticker/24hr", _p_aster, list_path="root")
_reg_ex("binance", "https://fapi.binance.com/fapi/v1/ticker/24hr", _p_binance, list_path="root")
_reg_ex("binancespot", "https://api.binance.com/api/v3/ticker/24hr", _p_binance_spot, list_path="root")
_reg_ex("lighter", "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", _p_lighter, list_path="order_book_details")
_reg_ex("hyperliquid", "https://api.hyperliquid.xyz/info", build=_build_hyperliquid, method="POST", body={"type": "metaAndAssetCtxs"})


_EX_WANT: dict = {}      # ex -> время последнего запроса из скринера (ленивый опрос)
_EX_TTL = 45             # сек: биржа опрашивается только пока её смотрят


def _ex_want(ex: str):
    _EX_WANT[ex] = time.time()


# ─────────── Карта принадлежности «биржа → множество монет» (для полоски бейджей) ───────────
_EX_SYMS: dict = {}          # ex -> set(symbols)  (какие монеты торгуются на бирже)
_EX_SYMS_LOCK = threading.Lock()


def _ex_fetch(ex: str) -> dict:
    """Один запрос all-tickers биржи → snap {sym: (turn,base,rise,last,bid,ask)}."""
    ad = _EX_ADAPTERS[ex]
    kw = {"timeout": 12}
    if ad.get("headers"):
        kw["headers"] = ad["headers"]
    if ad["method"] == "POST":
        resp = _post(ad["url"], json=ad["body"], **kw)
    else:
        resp = _get(ad["url"], **kw)
    js = resp.json()
    if ad.get("build"):
        return ad["build"](js) or {}
    arr = _dig(js, ad["list"]) or []
    snap = {}
    for t in arr:
        try:
            r = ad["parse"](t)
        except Exception:
            r = None
        if r and r[0]:
            snap[r[0]] = (r[4], r[5], r[6], r[1], r[2], r[3])
    return snap


def _set_syms(ex, snap):
    with _EX_SYMS_LOCK:
        _EX_SYMS[ex] = set(snap.keys())


def _ex_poll(ex: str):
    while True:
        try:
            if time.time() - _EX_WANT.get(ex, 0) > _EX_TTL:
                time.sleep(2)                    # никто не смотрит эту биржу — не жжём сеть/CPU
                continue
            snap = _ex_fetch(ex)
            _set_syms(ex, snap)
            with _EX_HIST[ex]["lock"]:
                _EX_HIST[ex]["hist"].append((time.time(), snap))
        except Exception:
            pass
        time.sleep(2)


_SCR_LAST = [0.0]        # время последнего запроса скринера (обход бирж нужен только когда скринер используется)


def _membership_sweep():
    """Обход ВСЕХ бирж для карты монет (полоска бейджей). ТОЛЬКО пока скринер активен —
    иначе не жжём CPU/сеть (спайки душат SSE стакана). 1 запрос/биржу, разнесён, редко."""
    time.sleep(12)
    while True:
        if time.time() - _SCR_LAST[0] > 120:    # скринер давно не открывали → спим, стакан не трогаем
            time.sleep(10)
            continue
        for ex in list(_EX_ADAPTERS.keys()):
            if time.time() - _SCR_LAST[0] > 120:
                break
            try:
                _set_syms(ex, _ex_fetch(ex))
            except Exception:
                pass
            time.sleep(6)
        time.sleep(180)


def _membership_of(coin, excluded):
    """Список ex-фидов, где торгуется монета (кроме исключённых)."""
    with _EX_SYMS_LOCK:
        return [ex for ex, syms in _EX_SYMS.items() if ex not in excluded and coin in syms]


def _in_excluded(coin, excluded):
    """True, если монета торгуется хоть на одной из исключённых бирж (тогда её вообще не показывать)."""
    if not excluded:
        return False
    with _EX_SYMS_LOCK:
        return any(coin in _EX_SYMS.get(ex, ()) for ex in excluded)


# приоритет «главной» биржи (метрики+стакан) при дедупе по монете
_EX_PRIO = ["ourbit", "weex", "binance", "bybit", "okx", "mexc", "gate", "bitget", "kucoin",
            "bingx", "htx", "bitmart", "xt", "lbank", "blofin", "bitunix", "whitebit",
            "asterdex", "lighter", "hyperliquid", "binancespot"]


def _screener_top_ex(ex: str, win: float = 30.0, n: int = 40) -> list:
    h = _EX_HIST.get(ex)
    if not h:
        return []
    with h["lock"]:
        hist = list(h["hist"])
    if not hist:
        return []
    now_t, cur = hist[-1]
    win_snaps = [(t, s) for (t, s) in hist if now_t - t <= win]
    old = win_snaps[0][1] if win_snaps else hist[0][1]
    prev = None
    for (t, s) in hist:
        if now_t - t <= 2 * win:
            prev = s; break
    rows = []
    for sym, tup in cur.items():
        amt24, vol24, rise, last, bid, ask = tup
        o = old.get(sym)
        d_amt = max(0.0, amt24 - o[0]) if o else 0.0
        d_vol = max(0.0, vol24 - o[1]) if o else 0.0
        mid = (bid + ask) / 2 if (bid and ask) else last
        spread = round((ask - bid) / mid * 100, 4) if (bid and ask and mid) else 0.0
        hi = lo = last
        for (t, s) in win_snaps:
            e = s.get(sym)
            if e:
                px = e[3]
                if px > hi: hi = px
                if px and px < lo: lo = px
        natr = round((hi - lo) / last * 100, 3) if last else 0.0
        vspike = 0.0
        if prev:
            pe = prev.get(sym)
            if pe and o:
                prev_dvol = max(0.0, o[1] - pe[1])
                if prev_dvol > 0:
                    vspike = round(d_vol / prev_dvol * 100)
        rows.append({"symbol": sym, "ex": ex, "rise": round(rise * 100, 2), "last": last, "bid": bid, "ask": ask,
                     "amt": round(d_amt), "vol": round(d_vol), "spread": spread, "trades": 0,
                     "dusd": 0, "dpct": 0.0, "natr": natr, "funding": 0.0,
                     "oipct": 0.0, "oiusd": 0, "vspike": vspike})
    mam = max((r["amt"] for r in rows), default=1) or 1
    for r in rows:
        r["act"] = round(100 * r["amt"] / mam)
    rows.sort(key=lambda r: r["amt"], reverse=True)
    return rows[:n]



# ─────────── Счётчик СДЕЛОК по многим монетам (отдельный WS) — для скринера «топ по сделкам» ───────────
_DEALS: dict = {}                      # sym -> deque timestamps(ms)
_DEALS_LOCK = threading.Lock()


def _deal_count(sym: str, cutoff_ms: int) -> int:
    return _deal_metrics(sym, cutoff_ms)[0]


def _deal_metrics(sym: str, cutoff_ms: int):
    """(кол-во сделок, оборот$ , дельта$ агрессии) за окно из WS-ленты сделок."""
    with _DEALS_LOCK:
        dq = _DEALS.get(sym)
        if not dq:
            return (0, 0.0, 0.0)
        cnt = 0; turn = 0.0; delta = 0.0
        for e in reversed(dq):         # новейшие первыми — считаем пока в окне
            if e[0] >= cutoff_ms:
                cnt += 1; turn += e[1]; delta += e[2]
            else:
                break
    return (cnt, turn, delta)


def _deal_counter_ws():
    import asyncio
    try:
        import websockets
    except ImportError:
        return

    async def run():
        while True:
            try:
                insts = _instruments()
                syms = [i["symbol"] for i in insts]
                _CSIZE = {i["symbol"]: float(i.get("contractSize") or 1) for i in insts}   # для USD-оборота сделок
                if not syms:
                    await asyncio.sleep(3); continue
                async with websockets.connect(WS_URL, open_timeout=15, ping_interval=20, ping_timeout=15, max_queue=None, **_ws_kw()) as ws:
                    for s in syms:
                        await ws.send(json.dumps({"method": "sub.deal", "param": {"symbol": s}}))
                        await asyncio.sleep(0.003)
                    print(f"[deals-ws] подписка на {len(syms)} монет — счётчик сделок для скринера")
                    while True:
                        msg = await asyncio.wait_for(ws.recv(), timeout=40)
                        d = json.loads(msg)
                        if d.get("channel") == "push.deal":
                            if time.time() - _SCR_LAST[0] > 120:      # скринер закрыт → НЕ обрабатываем все сделки (разгрузка GIL, чтобы стакан/лента не фризили)
                                continue
                            sym = d.get("symbol"); dt = d.get("data") or {}
                            t = dt.get("t") or d.get("ts")
                            if sym and t:
                                try:
                                    p = float(dt.get("p") or 0); v = float(dt.get("v") or 0); side = int(dt.get("T") or 1)
                                except (TypeError, ValueError):
                                    p = v = 0.0; side = 1
                                notional = p * v * _CSIZE.get(sym, 1)     # USD: цена × контракты × размер контракта
                                sign = notional if side == 1 else -notional      # +покупка / −продажа (агрессия)
                                with _DEALS_LOCK:
                                    dq = _DEALS.get(sym)
                                    if dq is None:
                                        dq = _DEALS[sym] = collections.deque(maxlen=6000)
                                    dq.append((int(t), notional, sign))
                                _mb_deal(sym, notional, sign)     # питаем бакеты оборотом/сделками/дельтой
            except Exception:
                await asyncio.sleep(4)

    asyncio.run(run())


# ─────────── WS-фид Ourbit: живая книга (снапшот REST + диффы) + лента ───────────
WS_URL = "wss://futures.ourbit.com/edge"
_BOOK: dict = {}          # symbol -> {"bids":{price:[vol,ords]}, "asks":{...}, "ts":ms}
_BOOK_LOCK = threading.Lock()
_BOOK_EVENT = threading.Event()   # взводится при любом обновлении книги → SSE шлёт сразу
_RESEED_REQ: dict = {}            # symbol -> bool: срочный reseed при обнаружении кросса


def _seed_book(symbol: str):
    d = _depth(symbol)
    with _BOOK_LOCK:
        _BOOK[symbol] = {
            "bids": {float(x[0]): [float(x[1]), x[2] if len(x) > 2 else 1] for x in d["bids"]},
            "asks": {float(x[0]): [float(x[1]), x[2] if len(x) > 2 else 1] for x in d["asks"]},
            "ts": int(time.time() * 1000),
        }


def _apply_depth(symbol: str, data: dict):
    with _BOOK_LOCK:
        b = _BOOK.get(symbol)
        if not b:
            return
        for key in ("bids", "asks"):
            for lvl in (data.get(key) or []):
                try:
                    price = float(lvl[0]); vol = float(lvl[1])
                    ords = lvl[2] if len(lvl) > 2 else 1
                except (TypeError, ValueError, IndexError):
                    continue
                if vol <= 0:
                    b[key].pop(price, None)
                else:
                    b[key][price] = [vol, ords]
                    # анти-кросс: новый уровень вытесняет противоположные ПЕРЕСЕКАЮЩИЕСЯ (старые стухли,
                    # иначе стакан «забагован» — бид выше аска). Новее = вернее.
                    if key == "asks":
                        for bp in [x for x in b["bids"] if x >= price]:
                            b["bids"].pop(bp, None)
                    else:
                        for ap in [x for x in b["asks"] if x <= price]:
                            b["asks"].pop(ap, None)
        b["ts"] = int(time.time() * 1000)
    _BOOK_EVENT.set()


def _last_trade_price(symbol: str):
    fs = _FLOW.get(symbol)
    if fs and fs.deals:
        try:
            return fs.deals[-1][1]
        except Exception:
            return None
    return None


def _depth_live(symbol: str):
    with _BOOK_LOCK:
        b = _BOOK.get(symbol)
        if not b or (int(time.time() * 1000) - b["ts"]) > 5000:
            return None
        bids = sorted(b["bids"].items(), key=lambda x: -x[0])
        asks = sorted(b["asks"].items(), key=lambda x: x[0])
        ts = b["ts"]
    # АНТИ-КРОСС НА ВЫДАЧЕ: книга не должна быть перекрещена (бид ≥ аск = «забаг»). Чистим по опорной цене.
    if bids and asks and bids[0][0] >= asks[0][0]:
        ref = _last_trade_price(symbol)
        if ref:
            bids = [x for x in bids if x[0] <= ref]      # биды выше последней сделки = протухли
            asks = [x for x in asks if x[0] >= ref]       # аски ниже последней сделки = протухли
        if not bids or not asks or bids[0][0] >= asks[0][0]:
            # опоры нет/всё ещё кросс → жёстко режем перекрытие по стороне аска
            ba = asks[0][0] if asks else None
            if ba is not None:
                bids = [x for x in bids if x[0] < ba]
        _RESEED_REQ[symbol] = True                         # просим срочный reseed чистых данных
    bids = bids[:200]; asks = asks[:200]
    return {"symbol": symbol, "ts": ts,
            "bids": [[p, v[0], v[1]] for p, v in bids],
            "asks": [[p, v[0], v[1]] for p, v in asks]}


def _feed_ws_deal(symbol: str, data):
    items = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
    if not items:
        return
    fs = _flow_for(symbol)
    with fs.lock:
        fs.merge(items)


async def _ws_loop():
    # МНОГОСИМВОЛЬНЫЙ: держим живые книги для всех запрошенных символов (несколько стаканов не дерутся)
    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=None, open_timeout=10,
                                          max_size=2 ** 22, **_ws_kw()) as ws:
                loop = asyncio.get_event_loop()
                subbed = set(); last_seed = {}; last_ping = time.time()
                async def seed(s):
                    await loop.run_in_executor(None, _seed_book, s); last_seed[s] = time.time()   # REST в пуле — не блокируем event loop
                while True:
                    now_ms = int(time.time() * 1000)
                    with _WANTED_LOCK:
                        wanted = {s for s, t in _WANTED.items() if now_ms - t < 30000}
                    wanted.add(_ACTIVE["symbol"])
                    for s in wanted - subbed:          # подписать новые
                        await ws.send(json.dumps({"method": "sub.depth", "param": {"symbol": s}}))
                        await ws.send(json.dumps({"method": "sub.deal", "param": {"symbol": s}}))
                        subbed.add(s); await seed(s)
                    for s in list(subbed - wanted):    # отписать неактуальные (стакан закрыт >30с)
                        for m in ("unsub.depth", "unsub.deal"):
                            await ws.send(json.dumps({"method": m, "param": {"symbol": s}}))
                        subbed.discard(s); last_seed.pop(s, None)
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        d = json.loads(msg); ch = d.get("channel"); sym = d.get("symbol")
                        if ch == "push.depth" and sym in subbed:
                            _apply_depth(sym, d.get("data") or {})
                        elif ch == "push.deal" and sym in subbed:
                            _feed_ws_deal(sym, d.get("data"))
                    except asyncio.TimeoutError:
                        pass
                    now = time.time()
                    if now - last_ping > 15:
                        await ws.send(json.dumps({"method": "ping"})); last_ping = now
                    for s in list(subbed):             # reseed по каждому символу (срочный при кроссе / анти-дрейф 10с)
                        if _RESEED_REQ.get(s) and now - last_seed.get(s, 0) > 1.5:
                            _RESEED_REQ[s] = False; await seed(s)
                        elif now - last_seed.get(s, 0) > 10:
                            await seed(s)
        except Exception:
            await asyncio.sleep(2)


def _ws_runner():
    # сторож: даже если asyncio.run упадёт с ошибкой — перезапускаем, поток не умирает
    while True:
        try:
            asyncio.run(_ws_loop())
        except Exception:
            pass
        time.sleep(2)


def _start_ws():
    if not _HAS_WS:
        print("[ws] websockets не установлен — работаем на REST-поллинге")
        return
    threading.Thread(target=_ws_runner, daemon=True, name="ourbit-ws").start()
    print("[ws] WebSocket-фид Ourbit запущен (живой стакан + лента, авто-перезапуск)")


# ─────────────────────────── HTTP ───────────────────────────
_STATIC = {"/app.js": "application/javascript; charset=utf-8",
           "/trade.js": "application/javascript; charset=utf-8",
           "/chart.js": "application/javascript; charset=utf-8",
           "/screener.js": "application/javascript; charset=utf-8",
           "/tape.js": "application/javascript; charset=utf-8",
           "/watchlist.js": "application/javascript; charset=utf-8",
           "/finrez.js": "application/javascript; charset=utf-8",
           "/notifications.js": "application/javascript; charset=utf-8",
           "/dock.js": "application/javascript; charset=utf-8",
           "/theme.js": "application/javascript; charset=utf-8",
           "/tile.js": "application/javascript; charset=utf-8",
           "/style.css": "text/css; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # постоянное соединение для SSE-потока

    def log_message(self, *a):
        pass

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, name, ctype):
        try:
            with open(os.path.join(HERE, name), "rb") as fh:
                body = fh.read()
        except FileNotFoundError:
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")  # правки css/js — обычным F5, без жёсткого
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, qs):
        sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
        _ACTIVE["symbol"] = sym; _want(sym)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
        except Exception:
            return
        last_ts = 0; last_depth = 0.0; last_flow = 0.0; last_ticks = 0.0
        try:
            while True:
                _want(sym)                                     # держим книгу этого стакана живой (мультиокно)
                _BOOK_EVENT.wait(0.05); _BOOK_EVENT.clear()   # просыпаемся часто → лента успевает за ценой
                now = time.time()
                live = _depth_live(sym); dep = live or _depth(sym)
                ts = dep.get("ts", 0)
                if ts != last_ts and now - last_depth >= 0.02:
                    last_ts = ts; last_depth = now
                    msg = json.dumps({"t": "depth", "depth": dep, "tick": _tick_of(sym),
                                      "src": "ws" if live else "rest"})
                    self.wfile.write(("data:" + msg + "\n\n").encode("utf-8")); self.wfile.flush()
                # БЫСТРЫЕ тики (лента) — часто и дёшево (без футпринта)
                if now - last_ticks >= 0.04:
                    last_ticks = now
                    tk = _flow_for(sym).ticks_only()
                    self.wfile.write(("data:" + json.dumps({"t": "ticks", "ticks": tk["ticks"], "now": tk["now"]}) + "\n\n").encode("utf-8"))
                    self.wfile.flush()
                # ТЯЖЁЛЫЙ футпринт/дельта — реже (медленно меняются)
                if now - last_flow >= 0.25:
                    last_flow = now
                    fl = _flow_for(sym).snapshot(_tick_of(sym), 40)
                    self.wfile.write(("data:" + json.dumps({"t": "flow", "flow": fl}) + "\n\n").encode("utf-8"))
                    self.wfile.flush()
        except Exception:
            return

    def do_GET(self):
        u = urlparse(self.path)
        route, qs = u.path, parse_qs(u.query)
        try:
            if route in ("/", "/index.html"):
                self._file("index.html", "text/html; charset=utf-8")
            elif route == "/favicon.ico":
                self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers()   # нет иконки — 204, без 404
            elif route in _STATIC:
                self._file(route.lstrip("/"), _STATIC[route])
            elif route == "/api/instruments":
                self._json({"ok": True, "instruments": _instruments()})
            elif route == "/api/depth":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                _ACTIVE["symbol"] = sym; _want(sym)
                live = _depth_live(sym)
                self._json({"ok": True, "depth": live or _depth(sym),
                            "tick": _tick_of(sym), "src": "ws" if live else "rest"})
            elif route == "/api/flow":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                _ACTIVE["symbol"] = sym; _want(sym)
                try:
                    fpmin = max(1, min(40, int((qs.get("fpmin") or ["3"])[0])))
                except (TypeError, ValueError):
                    fpmin = 3
                self._json({"ok": True, "flow": _flow_for(sym).snapshot(_tick_of(sym), fpmin)})
            elif route == "/api/screener":
                try:
                    win = float((qs.get("win") or ["1"])[0])          # окно в МИНУТАХ (M1..M60)
                    n = int((qs.get("n") or ["40"])[0])
                except (TypeError, ValueError):
                    win, n = 1.0, 40
                tfs = {}
                try:
                    raw = (qs.get("tfs") or [""])[0]                   # per-metric TF: JSON {"rise":1,"vspike":5}
                    if raw:
                        tfs = json.loads(raw) or {}
                except (ValueError, TypeError):
                    tfs = {}
                _SCR_LAST[0] = time.time()                            # скринер активен → разрешить обход бирж для полоски
                ex = (qs.get("ex") or ["ourbit"])[0].lower()
                exset = {e.strip() for e in ex.split(",") if e.strip()}
                excluded = {e.strip() for e in (qs.get("xex") or [""])[0].lower().split(",") if e.strip()}
                win_sec = max(2.0, win * 60)                          # для бирж-снапшотов окно в секундах
                # «главные» биржи (метрики+стакан) в порядке приоритета
                mains = [e for e in _EX_PRIO if e in exset] or ["ourbit"]
                bycoin = {}                                           # дедуп по монете: первая (приоритетная) главная выигрывает
                for e in mains:
                    if e == "ourbit":
                        rows_e = _screener_top_cached(win, n, tfs)
                    elif e in _EX_ADAPTERS:
                        _ex_want(e); rows_e = _screener_top_ex(e, win_sec, n)
                    else:
                        rows_e = []
                    for r in rows_e:
                        if r["symbol"] not in bycoin:
                            bycoin[r["symbol"]] = r
                out = []
                for coin, r in bycoin.items():
                    if _in_excluded(coin, excluded):                  # монета торгуется на исключённой бирже → не показывать вообще
                        continue
                    r["exchs"] = _membership_of(coin, excluded)       # полоска бирж, где монета торгуется (кроме исключённых)
                    r["mainex"] = r.get("ex")
                    out.append(r)
                self._json({"ok": True, "win": win, "rows": out})
            elif route == "/api/stream":
                self._sse(qs)
            elif route == "/api/deals":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                try:
                    raw = _fetch_deals(sym)
                except Exception:
                    raw = []
                deals = []
                for d in raw:
                    try:
                        deals.append({"t": int(d.get("t")), "p": float(d.get("p")),
                                      "v": float(d.get("v")), "side": 1 if int(d.get("T", 1)) == 1 else 2})
                    except (TypeError, ValueError):
                        continue
                self._json({"ok": True, "deals": deals})
            elif route == "/api/kline":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                interval = (qs.get("interval") or ["Min1"])[0]
                secs = {"Min1": 60, "Min5": 300, "Min15": 900, "Min30": 1800,
                        "Min60": 3600, "Hour4": 14400, "Day1": 86400}.get(interval, 60)
                now = int(time.time())
                try:
                    d = _get(f"{OURBIT_BASE}/contract/kline/{sym}",
                                     params={"interval": interval, "start": now - 220 * secs, "end": now},
                                     timeout=8).json().get("data") or {}
                except Exception:
                    d = {}
                t = d.get("time") or []; o = d.get("open") or []; h = d.get("high") or []
                lo = d.get("low") or []; c = d.get("close") or []; vv = d.get("vol") or d.get("amount") or []
                candles = [{"t": t[i], "o": o[i], "h": h[i], "l": lo[i], "c": c[i],
                            "v": (float(vv[i]) if i < len(vv) else 0)}
                           for i in range(min(len(t), len(o), len(h), len(lo), len(c)))]
                self._json({"ok": True, "candles": candles})
            elif route == "/api/ticker":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                try:
                    d = _get(f"{OURBIT_BASE}/contract/ticker",
                                     params={"symbol": sym}, timeout=6).json().get("data") or {}
                except Exception:
                    d = {}
                if isinstance(d, list):
                    d = d[0] if d else {}
                self._json({"ok": True, "rise": d.get("riseFallRate"), "last": d.get("lastPrice"),
                            "mark": d.get("fairPrice") or d.get("indexPrice") or d.get("lastPrice")})
            elif route == "/api/proxy":
                if not _proxy:
                    self._json({"ok": False, "error": "модуль proxy не загружен"}); return
                self._json({"ok": True, "ws_supported": _WS_PROXY_OK, **_proxy.status()})
            elif route == "/api/state":
                self._json({"ok": True, "state": _trade_state()})
            elif route == "/api/account":
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                avail, equity = _OB.balance()
                _TRADE.update({"balance": avail, "equity": equity})
                self._json({"ok": True, "balance": avail, "equity": equity,
                            "positions": _OB.positions(sym), "orders": _OB.open_orders(sym),
                            "allpos": _OB.positions(None)})    # ВСЕ позиции по всем монетам (чтобы не терять «чужие» позы)
            elif route == "/api/posmode":        # текущий режим позиции (1 hedge / 2 one-way)
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                self._json({"ok": True, "mode": _OB.get_position_mode()})
            elif route == "/api/plandiag":       # ДИАГНОСТИКА план-ордеров (найти верное поле id для отмены)
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                symq = (qs.get("symbol") or ["XAUT_USDT"])[0]
                self._json({"ok": True, "diag": _OB.plan_diag(symq)})
            elif route == "/api/history":       # история закрытых сделок для Финрез (как MetaScalp «Ваши сделки»)
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                symq = (qs.get("symbol") or [""])[0] or None   # пусто = все тикеры
                self._json({"ok": True, "trades": _OB.history(symq)})
            else:
                self.send_error(404)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, code=502)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return {}

    def _origin_ok(self):
        """CSRF-защита: разрешаем POST только со своей localhost-страницы (чужая вкладка не пошлёт ордер)."""
        o = self.headers.get("Origin") or self.headers.get("Referer") or ""
        return (o == "") or ("//localhost:" in o) or ("//127.0.0.1:" in o)

    def do_POST(self):
        route = urlparse(self.path).path
        o = self.headers.get("Origin") or self.headers.get("Referer") or ""
        ext = o.startswith("chrome-extension://")
        if not self._origin_ok() and not (ext and route == "/api/exttoken"):
            self._json({"ok": False, "error": "origin запрещён"}, code=403); return
        b = self._read_body()
        try:
            if route == "/api/connect":
                self._json(_trade_connect(b.get("token", "")))
            elif route == "/api/exttoken":           # из Chrome-расширения: авто-подключение токеном с открытой страницы биржи
                self._json(_trade_connect(b.get("token", "")))
            elif route == "/api/arm":
                on = bool(b.get("on"))
                if on and not _TRADE["connected"]:
                    self._json({"ok": False, "error": "сначала подключись токеном"}); return
                if on:
                    okA, whyA = _activation_ok()      # АКТИВАЦИЯ по ключу (1 ключ = 1 IP)
                    if not okA:
                        self._json({"ok": False, "error": "🔑 АКТИВАЦИЯ: " + whyA}); return
                _TRADE["armed"] = on                  # торговля при ЛЮБОЙ комиссии (юзер: торгую везде)
                if on:
                    threading.Thread(target=_OB.warm, daemon=True).start()   # прогреть соединение при включении LIVE — 1-й ордер сразу быстрый
                self._json({"ok": True, "state": _trade_state()})
            elif route == "/api/setposmode":     # сменить режим позиции (1 hedge / 2 one-way) — только когда флэт
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                try:
                    sc, resp = _OB.set_position_mode(int(b.get("mode", 2)))
                    self._json({"ok": bool(resp.get("success")), "resp": resp})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/closeall":       # НАДЁЖНОЕ закрытие: сервер сам берёт ВСЕ позиции с биржи и закрывает (не зависит от клиента)
                if not _TRADE["armed"]:
                    self._json({"ok": False, "error": "LIVE не включён"}); return
                try:
                    poslist = _OB.positions(None)     # все позиции по всем монетам
                except Exception as exc:
                    self._json({"ok": False, "error": "не смог прочитать позиции: " + str(exc)}); return
                closed, errs = 0, []
                syms = set(p.get("symbol") for p in poslist if p.get("symbol"))
                if b.get("symbol"): syms.add(b.get("symbol"))   # + текущая монета клиента
                for p in poslist:
                    cside = 4 if p.get("side") == 1 else 2   # 4=close long / 2=close short
                    try:
                        sc, resp = _OB.create(p.get("symbol"), cside, 5, int(p.get("vol") or 0), 0,
                                              int(b.get("leverage", 50)), position_id=p.get("id"))
                        if resp.get("success"): closed += 1
                        else: errs.append(f"{p.get('symbol')}: {resp.get('message') or resp.get('code')}")
                    except Exception as exc:
                        errs.append(f"{p.get('symbol')}: {exc}")
                cancelled = 0                              # + снять ВСЕ лимитки по этим монетам (иначе доливают позу обратно!)
                for s in syms:
                    try:
                        for o in _OB.open_orders(s):
                            _OB.cancel(o["id"]); cancelled += 1
                    except Exception: pass
                self._json({"ok": True, "closed": closed, "found": len(poslist),
                            "cancelled_orders": cancelled, "errors": errs})
            elif route == "/api/order":
                if not _TRADE["armed"]:
                    self._json({"ok": False, "error": "LIVE не включён"}); return
                sym = b.get("symbol") or ""
                try:
                    vol = int(b["vol"]); side = int(b["side"]); otype = int(b["otype"])
                except (KeyError, TypeError, ValueError):
                    self._json({"ok": False, "error": "плохие параметры ордера"}); return
                if vol <= 0 or vol > _MAX_VOL:
                    self._json({"ok": False, "error": f"vol вне лимита (1..{_MAX_VOL})"}); return
                try:   # ЛОГ каждого ордера (диагностика авто-открытия): время, сторона, объём, монета
                    with open(os.path.join(HERE, "order_log.txt"), "a", encoding="utf-8") as _lf:
                        _lf.write(f"{time.strftime('%H:%M:%S')} ORDER side={side} otype={otype} vol={vol} sym={sym} px={b.get('price')}\n")
                except Exception:
                    pass
                _t0 = time.time()
                try:
                    close_pid = None
                    if side in (2, 4):   # ЗАКРЫТИЕ: нужен positionId (без него Ourbit ОТКРЫВАЕТ противоположную!)
                        try: client_pid = int(b.get("positionId") or 0)
                        except (TypeError, ValueError): client_pid = 0
                        if client_pid > 0:
                            # БЫСТРЫЙ ПУТЬ: клиент прислал свежий id позиции (обновляется раз в 1.5с) → БЕЗ лишнего round-trip к бирже (~250мс быстрее).
                            # Закрытие С positionId = reduce-only: противоположную НЕ откроет (х2-баг был только при отсутствии id).
                            close_pid = client_pid
                        else:
                            # id нет → безопасный путь: тянем позицию с биржи (+1 round-trip)
                            want_long = (side == 4)   # 4=CLOSE_LONG закрывает лонг, 2=CLOSE_SHORT закрывает шорт
                            try: poslist = _OB.positions(sym)
                            except Exception: poslist = []
                            match = next((p for p in poslist if (p.get("side") == 1) == want_long and p.get("id")), None)
                            if not match:   # позиции нужной стороны НЕТ → НЕ открываем противоположную
                                self._json({"ok": False, "error": "закрывать нечего: позиция не найдена на бирже (противоположную НЕ открываю)"}); return
                            close_pid = match["id"]
                            if match.get("vol"): vol = min(vol, int(match["vol"]))   # не больше реального объёма позиции
                    sc, resp = _OB.create(sym, side, otype, vol, b.get("price", 0), int(b.get("leverage", 50)),
                                          position_id=close_pid)
                except Exception:
                    # ORPHAN-защита: ордер МОГ исполниться — вернуть фактическую позицию клиенту
                    try: pos = _OB.positions(sym)
                    except Exception: pos = []
                    self._json({"ok": False, "maybe_filled": True,
                                "error": "СЕТЬ/ТАЙМАУТ: ордер мог исполниться — проверь позицию", "positions": pos}); return
                srv_ms = round((time.time() - _t0) * 1000)   # чистое время round-trip к бирже
                ok = bool(resp.get("success"))
                if not ok:   # ВРЕМЕННО: логируем полный ответ биржи при отказе — чтобы увидеть настоящую причину «Unknown error»
                    try:
                        with open(os.path.join(HERE, "order_log.txt"), "a", encoding="utf-8") as _lf:
                            _lf.write(f"{time.strftime('%H:%M:%S')} REJECT lev={b.get('leverage')} side={side} vol={vol} px={b.get('price')} otype={otype} http={sc} resp={json.dumps(resp, ensure_ascii=False)}\n")
                    except Exception:
                        pass
                # серверный стоп/снятие — В ФОНЕ, чтобы ответ на ордер уходил МГНОВЕННО (без задержки)
                if ok and side in (2, 4):        # закрытие позиции → снять биржевые стопы (фоном)
                    threading.Thread(target=_async_cancel_plans, args=(sym,), daemon=True).start()
                elif ok and _TRADE.get("auto_stop") and side in (1, 3) and (float(b.get("sl", 0)) > 0 or float(b.get("tp", 0)) > 0):
                    threading.Thread(target=_async_place_stop, args=(sym, float(b.get("sl", 0)), float(b.get("tp", 0))), daemon=True).start()
                self._json({"ok": ok, "http": sc, "resp": resp, "srv_ms": srv_ms})
            elif route == "/api/cancel":         # отмена ОДНОЙ заявки по id (клик по × в стакане)
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                try:
                    _t0 = time.time()
                    sc, resp = _OB.cancel(b.get("id"))
                    self._json({"ok": bool(resp.get("success")), "resp": resp,
                                "srv_ms": round((time.time() - _t0) * 1000)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/cancelall":
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                sym = b.get("symbol", "XAUT_USDT")
                ids = b.get("ids") or []
                _t0 = time.time()
                if ids:                                  # клиент прислал id заявок → отменяем ВСЕ ОДНИМ запросом (быстро)
                    sc, resp = _OB.cancel_batch(ids)
                    killed = len(ids) if resp.get("success") else 0; failed = []
                else:                                    # фолбэк: сервер сам вытянет открытые ордера (медленнее)
                    killed, failed = _OB.cancel_all(sym)
                # биржевые стопы (plan-ордера) снимаем В ФОНЕ — не задерживаем ответ на отмену лимиток
                threading.Thread(target=_async_cancel_plans, args=(sym,), daemon=True).start()
                self._json({"ok": True, "killed": killed, "failed": failed,
                            "srv_ms": round((time.time() - _t0) * 1000)})
            elif route == "/api/cancelplans":       # чистка биржевых стопов (после закрытия позиции стопом/руками)
                if not _TRADE["connected"]:
                    self._json({"ok": False, "error": "не подключено"}); return
                self._json({"ok": True, "killed": _OB.cancel_all_plans(b.get("symbol", "XAUT_USDT"))})
            elif route == "/api/autostop":          # тумблер: ставить ли биржевой SL/TP автоматически
                _TRADE["auto_stop"] = bool(b.get("on"))
                self._json({"ok": True, "auto_stop": _TRADE["auto_stop"]})
            elif route.startswith("/api/proxy/"):
                if not _proxy:
                    self._json({"ok": False, "error": "модуль proxy не загружен"}); return
                act = route[len("/api/proxy/"):]
                if act == "add":
                    pid = _proxy.add_proxy(b.get("url", ""))
                    self._json({"ok": bool(pid), "id": pid, **_proxy.status()})
                elif act == "remove":
                    _proxy.remove_proxy(b.get("id", "")); self._json({"ok": True, **_proxy.status()})
                elif act == "toggle":
                    _proxy.toggle_proxy(b.get("id", ""), bool(b.get("enabled"))); self._json({"ok": True, **_proxy.status()})
                elif act == "mode":
                    _proxy.set_mode(b.get("mode", "off")); self._json({"ok": True, **_proxy.status()})
                elif act == "ws":
                    _proxy.set_ws(bool(b.get("on"))); self._json({"ok": True, **_proxy.status()})
                elif act == "test":
                    res = _proxy.test_proxy(b.get("id", "")); self._json({"ok": res.get("ok", False), "res": res, **_proxy.status()})
                else:
                    self.send_error(404)
            else:
                self.send_error(404)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, code=502)


def main():
    threading.Thread(target=_poller, daemon=True).start()
    threading.Thread(target=_screener_poller, daemon=True, name="screener").start()
    for _ex in _EX_ADAPTERS:
        threading.Thread(target=_ex_poll, args=(_ex,), daemon=True, name="scr-" + _ex).start()
    threading.Thread(target=_membership_sweep, daemon=True, name="ex-membership").start()
    threading.Thread(target=_fee_watchdog, daemon=True, name="fee-watchdog").start()
    threading.Thread(target=_conn_keepalive, daemon=True, name="conn-keepalive").start()
    threading.Thread(target=_deal_counter_ws, daemon=True, name="deals-ws").start()
    if _proxy:
        threading.Thread(target=_proxy.health_loop, daemon=True, name="proxy-health").start()
    _start_ws()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Ourbit DOM (MetaScalp-style) запущен:  http://localhost:{PORT}")
    print("Ctrl+C — остановить.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено."); srv.shutdown()


if __name__ == "__main__":
    main()
