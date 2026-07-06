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
import calendar
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
# ── КЛАССИКА: сканер формаций ТС на Binance 5м (classic.py) ──
try:
    import classic as _classic
except Exception:
    _classic = None
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


# ── СКАНЕР СТЕНОК (маркетос): тянем стакан ТОЛЬКО по топ-кандидатам скринера (не по всем 705), меряем крупнейшую стенку ──
_WALL_CACHE = {}                        # sym -> (wall_usd, standout_ratio, ts)
_WALL_WANT = {"syms": [], "ts": 0.0}    # какие символы сканировать (топ скринера) + когда запрошено
_WALL_LOCK = threading.Lock()

def _csize(sym):
    data = _instruments()
    cs = _INSTR.get("csize")
    if cs is None or _INSTR.get("_csz_ts") != _INSTR["ts"]:
        cs = {it.get("symbol"): float(it.get("contractSize") or 1) for it in (data or [])}
        _INSTR["csize"] = cs
        _INSTR["_csz_ts"] = _INSTR["ts"]
    return cs.get(sym, 1.0)

def _wall_metric(depth, cs):
    """Крупнейшая стенка в $ и её «выделенность» (во сколько раз больше средней глубины) по топ-15 уровням каждой стороны."""
    best_usd = 0.0
    ratio = 0.0
    for side in (depth.get("bids") or [], depth.get("asks") or []):
        lv = side[:15]
        if not lv:
            continue
        usds = [l[0] * l[1] * cs for l in lv]
        mx = max(usds)
        avg = sum(usds) / len(usds)
        if mx > best_usd:
            best_usd = mx
        if avg > 0 and mx / avg > ratio:
            ratio = mx / avg
    return best_usd, ratio

try:
    _WALL_SESS = _http.Session(impersonate="chrome120")   # ОТДЕЛЬНАЯ сессия сканера — не конкурирует с фидами скринера/стакана
except Exception:
    _WALL_SESS = _http.Session()
def _wall_depth(symbol):
    data = _WALL_SESS.get(f"{OURBIT_BASE}/contract/depth/{symbol}", timeout=8).json().get("data") or {}
    b, a = _clean_book(data.get("bids") or [], data.get("asks") or [])
    return {"symbol": symbol, "bids": b, "asks": a}
def _wall_scanner():
    """Фон: стакан по топ-кандидатам скринера → размер/выделенность стенки в кэш. Активен только пока скринер открыт.
    Отдельная сессия + мягкая нагрузка (12 монет, каждые 8с, микропауза), чтобы НЕ лагал скринер."""
    while True:
        time.sleep(8)
        with _WALL_LOCK:
            want = list(_WALL_WANT["syms"])
            wts = _WALL_WANT["ts"]
        if not want or time.time() - wts > 25:   # скринер не открыт → не грузим биржу
            continue
        for sym in want[:12]:
            try:
                usd, ratio = _wall_metric(_wall_depth(sym), _csize(sym))
                _WALL_CACHE[sym] = (usd, ratio, time.time())
            except Exception:
                pass
            time.sleep(0.15)                     # микропауза — не забиваем сеть залпом


def _fetch_deals(symbol: str) -> list:
    return _get(f"{OURBIT_BASE}/contract/deals/{symbol}", timeout=8).json().get("data") or []


# ─────────────────── MEXC как ИСТОЧНИК СТАКАНА (не только цены) ───────────────────
# MEXC contract API идентичен Ourbit (Ourbit — форк MEXC): те же /contract/detail|depth|deals.
# Отдаём стакан+ленту MEXC клиенту через /api/mexcdepth и /api/mexctrades (REST-поллинг, как WEEX).
MEXC_BASE = "https://contract.mexc.com/api/v1"
_MEXC_INSTR = {"ts": 0.0, "tick": {}, "csize": {}}
_MEXC_INSTR_TTL = 3600
try:
    _MEXC_SESS = _http.Session(impersonate="chrome120")   # отдельная сессия — не конкурирует с фидами Ourbit
except Exception:
    _MEXC_SESS = _http.Session()


def _mexc_instruments() -> None:
    now = time.time()
    if _MEXC_INSTR["tick"] and now - _MEXC_INSTR["ts"] < _MEXC_INSTR_TTL:
        return
    try:
        rows = _MEXC_SESS.get(f"{MEXC_BASE}/contract/detail", timeout=12).json().get("data") or []
    except Exception:
        return
    tick, csz, maxlev = {}, {}, {}
    for r in rows:
        sym = r.get("symbol")
        if not sym:
            continue
        tick[sym] = r.get("priceUnit")
        csz[sym] = r.get("contractSize")
        maxlev[sym] = r.get("maxLeverage")
    if tick:
        _MEXC_INSTR.update({"ts": now, "tick": tick, "csize": csz, "maxlev": maxlev})


def _mexc_maxlev(sym: str) -> int:
    if not _MEXC_INSTR.get("maxlev"):
        _mexc_instruments()
    try:
        return int(_MEXC_INSTR.get("maxlev", {}).get(sym) or 20)
    except (TypeError, ValueError):
        return 20


def _mexc_tick(sym: str) -> float:
    if not _MEXC_INSTR["tick"]:
        _mexc_instruments()
    try:
        return float(_MEXC_INSTR["tick"].get(sym) or 0.0001)
    except (TypeError, ValueError):
        return 0.0001


def _mexc_csize(sym: str) -> float:
    if not _MEXC_INSTR["csize"]:
        _mexc_instruments()
    try:
        return float(_MEXC_INSTR["csize"].get(sym) or 1)
    except (TypeError, ValueError):
        return 1.0


def _mexc_depth(sym: str) -> dict:
    data = _MEXC_SESS.get(f"{MEXC_BASE}/contract/depth/{sym}", timeout=8).json().get("data") or {}
    b, a = _clean_book(data.get("bids") or [], data.get("asks") or [])
    return {"symbol": sym, "bids": b, "asks": a, "ts": data.get("timestamp") or int(time.time() * 1000)}


_MX_CSIZE: dict = {}          # sym -> contractSize (кэш из contract/detail)
_MX_CSIZE_TS = [0.0]
_MX_LIQ: dict = {}            # sym -> (usd, ts)  ликвидность до сдвига цены


def _mx_csize() -> dict:
    if _MX_CSIZE and time.time() - _MX_CSIZE_TS[0] < 3600:
        return _MX_CSIZE
    try:
        arr = _MEXC_SESS.get(f"{MEXC_BASE}/contract/detail", timeout=12).json().get("data") or []
        for c in arr:
            s = (c.get("symbol") or "").upper()
            if s:
                _MX_CSIZE[s] = _ff(c.get("contractSize"))
        _MX_CSIZE_TS[0] = time.time()
    except Exception:
        pass
    return _MX_CSIZE


def _mx_liq(sym: str, pct: float) -> int:
    """Сколько $ можно КУПИТЬ на MEXC до сдвига цены на pct% (сумма аск-ноционала в окне)."""
    now = time.time()
    c = _MX_LIQ.get(sym)
    if c and now - c[1] < 5:
        return c[0]
    usd = 0
    try:
        asks = _mexc_depth(sym).get("asks") or []
        cs = _mx_csize().get(sym) or 0
        if asks and cs:
            best = asks[0][0]; lim = best * (1 + pct / 100.0)
            tot = 0.0
            for row in asks:
                p, v = row[0], row[1]
                if p > lim:
                    break
                tot += p * v * cs
            usd = round(tot)
    except Exception:
        pass
    _MX_LIQ[sym] = (usd, now)
    return usd


_MX_KL: dict = {}            # sym -> (points, ts)  кэш kline (история для окна 1ч/4ч)


def _mx_kline(sym: str, minutes: int) -> list:
    """История цены MEXC свечами → [[t_sec, close]] за последние `minutes` минут."""
    now = time.time()
    c = _MX_KL.get(sym)
    if c and now - c[1] < 30 and c[2] == minutes:       # кэш учитывает окно (иначе 4ч-запрос отдаёт данные вместо 24ч)
        return c[0]
    pts = []
    interval = "Min1" if minutes <= 1440 else "Min5"   # Min1 до 24ч (MEXC даёт 1440 свечей) — КАЖДОЕ движение чётко
    try:
        d = _MEXC_SESS.get(f"{MEXC_BASE}/contract/kline/{sym}",
                           params={"interval": interval, "start": int(now) - minutes * 60, "end": int(now)},
                           timeout=10).json().get("data") or {}
        tt = d.get("time") or []; cc = d.get("close") or []
        pts = [[int(tt[i]), _ff(cc[i])] for i in range(min(len(tt), len(cc))) if _ff(cc[i]) > 0]
    except Exception:
        pts = []
    _MX_KL[sym] = (pts, now, minutes)
    return pts


def _mexc_deals(sym: str) -> list:
    raw = _MEXC_SESS.get(f"{MEXC_BASE}/contract/deals/{sym}", timeout=8).json().get("data") or []
    out = []
    for d in (raw if isinstance(raw, list) else []):
        try:
            out.append({"id": None, "t": int(d.get("t")), "p": float(d.get("p")),
                        "v": float(d.get("v")), "side": 1 if int(d.get("T", 1)) == 1 else 2})
        except (TypeError, ValueError):
            continue
    return out


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

# ── MEXC ТОРГОВЛЯ (веб-подпись, форк Ourbit) — для автобота на MEXC ──
from mexc_client import MexcClient
_MEXCTR = MexcClient()
_MEXC_TRADE = {"connected": False}

# ── WEEX (2-й источник стакана; торговля позже через веб-uid) ──
from weex_client import _WEEX, to_v3 as _wx_v3
_WEEX_INFO = {"ts": 0.0, "map": {}, "qprec": {}}
def _weex_load_info():
    now = time.time()
    if now - _WEEX_INFO["ts"] > 600:
        try:
            info = _WEEX.exchange_info() or {}
            m, q = {}, {}
            for s in (info.get("symbols") or []):
                sym = s.get("symbol")
                pp = s.get("pricePrecision")
                if pp is not None:
                    m[sym] = 10 ** (-int(pp))
                qp = s.get("quantityPrecision")
                if qp is not None:
                    q[sym] = int(qp)         # число знаков после запятой в количестве (монеты)
            if m:
                _WEEX_INFO["map"] = m; _WEEX_INFO["qprec"] = q; _WEEX_INFO["ts"] = now
        except Exception:
            pass

def _weex_tick(sym):
    _weex_load_info()
    return _WEEX_INFO["map"].get(_wx_v3(sym), 0.0001)

def _weex_qprec(sym):
    _weex_load_info()
    return _WEEX_INFO["qprec"].get(_wx_v3(sym), 0)   # 0 = целые монеты по умолчанию

def _load_weex_creds():
    """Ключи WEEX из weex.txt (3 строки: key / secret / passphrase). Наружу не уходит (в .gitignore)."""
    try:
        with open(os.path.join(HERE, "weex.txt"), encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
        if len(lines) >= 3:
            _WEEX.set_creds(lines[0], lines[1], lines[2])
            return True
    except Exception:
        pass
    return False
_load_weex_creds()

_WEEX_SYMS = {"ts": 0.0, "list": []}
def _weex_syms():
    now = time.time()
    if now - _WEEX_SYMS["ts"] > 600:
        try:
            info = _WEEX.exchange_info() or {}
            bases = []
            for s in (info.get("symbols") or []):
                sym = s.get("symbol", "")     # BTCUSDT
                if sym.endswith("USDT"):
                    bases.append(sym[:-4])
            if bases:
                _WEEX_SYMS["list"] = bases
                _WEEX_SYMS["ts"] = now
        except Exception:
            pass
    return _WEEX_SYMS["list"]

# ── СКАНЕР WEEX (для колонок «Сделки» и «СБОР/маркетос» скринера) — лёгкий: топ-12 монет, отдельная сессия ──
_WEEX_TR = {}                              # sym -> (count, ts)  число сделок
_WEEX_WALL = {}                            # sym -> (wall_usd, ratio, ts)  маркетос-стена
_WEEX_TR_WANT = {"syms": [], "ts": 0.0}
_WEEX_TR_LOCK = threading.Lock()
try:
    _WTR_SESS = _http.Session(impersonate="chrome120")
except Exception:
    _WTR_SESS = _http.Session()
def _weex_trade_count(symbol, win_sec=60):
    """Сделок за окно. Лента WEEX отдаёт ~100 последних → у активных все в окне (потолок 100).
    Поэтому берём СКОРОСТЬ (сделок/сек по размаху) и экстраполируем на окно — активные различаются."""
    from weex_client import to_v2 as _wv2
    r = _WTR_SESS.get(f"https://api-contract.weex.com/capi/v2/market/trades?symbol={_wv2(symbol)}", timeout=8).json()
    trades = r if isinstance(r, list) else []
    times = sorted(t for t in (float(x.get("time") or 0) for x in trades) if t > 0)
    if len(times) < 2:
        return len(trades)
    span_ms = times[-1] - times[0]
    if span_ms <= 0:
        return len(times)
    rate = len(times) / (span_ms / 1000.0)      # сделок/сек
    return int(round(rate * win_sec))            # экстраполяция на окно (мин) — реальная скорость, не потолок 100
def _weex_trades_scanner():
    """Фон: число сделок WEEX по топ-монетам скринера в кэш. Активен только пока скринер с WEEX открыт."""
    while True:
        time.sleep(8)
        with _WEEX_TR_LOCK:
            want = list(_WEEX_TR_WANT["syms"])
            wts = _WEEX_TR_WANT["ts"]
        if not want or time.time() - wts > 25:
            continue
        for sym in want[:12]:
            try:
                _WEEX_TR[sym] = (_weex_trade_count(sym), time.time())
            except Exception:
                pass
            try:
                _usd, _ratio = _wall_metric(_WEEX.depth(sym), 1.0)   # стена WEEX (size в монетах → cs=1)
                _WEEX_WALL[sym] = (_usd, _ratio, time.time())
            except Exception:
                pass
            time.sleep(0.15)

# ── СКАНЕР MEXC (колонка «Сделки» скринера) — зеркало WEEX-сканера: топ-12 монет, скорость ленты ──
_MEXC_TR: dict = {}                         # sym -> (count, ts)  число сделок за окно
_MEXC_TR_WANT = {"syms": [], "ts": 0.0}
_MEXC_TR_LOCK = threading.Lock()
def _mexc_trade_count(symbol: str, win_sec: int = 60) -> int:
    """Сделок за окно по ленте MEXC (отдаёт ~100 последних → считаем СКОРОСТЬ и экстраполируем)."""
    deals = _mexc_deals(symbol)
    times = sorted(t for t in (float(d.get("t") or 0) for d in deals) if t > 0)
    if len(times) < 2:
        return len(deals)
    span_ms = times[-1] - times[0]
    if span_ms <= 0:
        return len(times)
    rate = len(times) / (span_ms / 1000.0)      # сделок/сек
    return int(round(rate * win_sec))
def _mexc_trades_scanner():
    """Фон: число сделок MEXC по топ-монетам скринера в кэш. Активен только пока скринер с MEXC открыт."""
    while True:
        time.sleep(4)
        with _MEXC_TR_LOCK:
            want = list(_MEXC_TR_WANT["syms"])
            wts = _MEXC_TR_WANT["ts"]
        if not want or time.time() - wts > 25:
            continue
        for sym in want[:30]:
            try:
                _MEXC_TR[sym] = (_mexc_trade_count(sym), time.time())
            except Exception:
                pass
            time.sleep(0.12)

# ── WEEX WebSocket: real-time стакан (снимок+дельты) и лента для АКТИВНОГО символа ──
_WEEX_WS = {"want": None, "sym": None, "bids": {}, "asks": {}, "trades": collections.deque(maxlen=400), "ts": 0.0}
_WEEX_WS_LOCK = threading.Lock()
def _weex_ws_book():
    with _WEEX_WS_LOCK:
        bids = sorted(_WEEX_WS["bids"].items(), key=lambda x: -x[0])[:20]
        asks = sorted(_WEEX_WS["asks"].items(), key=lambda x: x[0])[:20]
        return {"bids": [[p, v] for p, v in bids], "asks": [[p, v] for p, v in asks]}, _WEEX_WS["sym"], _WEEX_WS["ts"]
def _weex_ws_runner():
    import asyncio
    import json as J
    try:
        import websockets
    except ImportError:
        return
    async def run():
        while True:
            cur = None
            try:
                async with websockets.connect("wss://ws-contract.weex.com/v3/ws/public", open_timeout=8, ping_interval=None) as ws:
                    while True:
                        want = _WEEX_WS["want"]
                        if want != cur:
                            if cur:
                                try: await ws.send(J.dumps({"method": "UNSUBSCRIBE", "params": [_wx_v3(cur) + "@depth15", _wx_v3(cur) + "@trade"], "id": 9}))
                                except Exception: pass
                            with _WEEX_WS_LOCK:
                                _WEEX_WS["bids"] = {}; _WEEX_WS["asks"] = {}; _WEEX_WS["trades"].clear(); _WEEX_WS["sym"] = want; _WEEX_WS["ts"] = 0.0
                            if want:
                                await ws.send(J.dumps({"method": "SUBSCRIBE", "params": [_wx_v3(want) + "@depth15", _wx_v3(want) + "@trade"], "id": 1}))
                            cur = want
                        try:
                            m = await asyncio.wait_for(ws.recv(), timeout=2)
                        except asyncio.TimeoutError:
                            try: await ws.send(J.dumps({"method": "PONG", "id": 1}))
                            except Exception: pass
                            continue
                        try: d = J.loads(m)
                        except Exception: continue
                        ev = str(d.get("e") or "").lower()
                        if d.get("event") in ("ping", "pong") or d.get("type") == "ping":
                            try: await ws.send(J.dumps({"method": "PONG", "id": 1}))
                            except Exception: pass
                            continue
                        if "depth" in ev:
                            snap = str(d.get("d")).upper() == "SNAPSHOT" or ev == "depthsnapshot"
                            with _WEEX_WS_LOCK:
                                if snap:
                                    _WEEX_WS["bids"] = {}; _WEEX_WS["asks"] = {}
                                for side, book in (("b", "bids"), ("a", "asks")):
                                    for lvl in (d.get(side) or []):
                                        try: p = float(lvl[0]); v = float(lvl[1])
                                        except Exception: continue
                                        if v <= 0: _WEEX_WS[book].pop(p, None)
                                        else: _WEEX_WS[book][p] = v
                                _WEEX_WS["ts"] = time.time()
                        elif "trade" in ev:
                            with _WEEX_WS_LOCK:
                                for t in (d.get("d") or []):
                                    try:
                                        side = 2 if str(t.get("m")).lower() == "true" else 1
                                        _WEEX_WS["trades"].append({"id": t.get("t"), "t": int(t.get("T") or 0), "p": float(t.get("p") or 0), "v": float(t.get("q") or 0), "side": side})
                                    except Exception: pass
            except Exception:
                await asyncio.sleep(2)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run())
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


# ── ВХОД по логину+паролю: ЛОКАЛЬНАЯ проверка по файлу users.txt (без сервера, без API) ──
# Логин закрывает ВЕСЬ терминал: без успешного входа бэкенд не отдаёт данные/торговлю.
# Файл users.txt рядом со скриптом: по одной паре "логин:пароль" на строку (строки с # — комментарии).
# Состояние держим на процесс (localhost, один пользователь): вошёл раз — работает до перезапуска.
_AUTH = {"ok": False, "login": None}

def _act_cfg(fname):
    try:
        for line in open(os.path.join(HERE, fname), encoding="utf-8").read().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):   # ПЕРВАЯ непустая строка без # (комментарий в файле не ломает чтение)
                return line
        return ""
    except Exception:
        return ""

def _load_users():
    """Читает users.txt → {логин: пароль}. Пары 'логин:пароль' по строке. Никакой сети."""
    out = {}
    try:
        for line in open(os.path.join(HERE, "users.txt"), encoding="utf-8").read().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            login, pw = line.split(":", 1)
            login, pw = login.strip(), pw.strip()
            if login and pw:
                out[login] = pw
    except Exception:
        pass
    return out

def _auth_required():
    """Вход обязателен, если в users.txt есть хотя бы одна пара. Пусто/нет файла → терминал открыт."""
    return bool(_load_users())

def _do_login(login, password):
    """Проверяет логин+пароль ЛОКАЛЬНО по users.txt. Успех → открывает терминал на этот процесс."""
    users = _load_users()
    if not users:
        _AUTH.update({"ok": True, "login": (login or "dev")})   # нет users.txt → вход не требуется
        return {"ok": True, "login": _AUTH["login"], "dev": True}
    login = (login or "").strip()
    if not login or not password:
        return {"ok": False, "error": "впиши логин и пароль"}
    if users.get(login) == password:
        _AUTH.update({"ok": True, "login": login})
        return {"ok": True, "login": login}
    return {"ok": False, "error": "неверный логин или пароль"}


def _save_ourbit_token(token: str):
    """Сохранить рабочий токен Ourbit локально — чтобы не вставлять заново каждый запуск (ourbit.txt, в .gitignore)."""
    try:
        with open(os.path.join(HERE, "ourbit.txt"), "w", encoding="utf-8") as f:
            f.write((token or "").strip() + "\n")
    except Exception:
        pass


def _trade_connect(token: str, save: bool = True) -> dict:
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
    if save:
        _save_ourbit_token(token)                            # запомнить рабочий токен для след. запуска
    threading.Thread(target=_OB.warm, daemon=True).start()   # прогреть торговое соединение сразу (минимальный пинг 1-го ордера)
    return {"ok": True, "balance": avail, "equity": equity, "fee": fee, "state": _trade_state()}


def _autoconnect_ourbit():
    """При старте: если есть сохранённый токен Ourbit — подключиться им (не вставлять заново). Токен мог истечь — тогда молча пропускаем."""
    try:
        with open(os.path.join(HERE, "ourbit.txt"), encoding="utf-8") as f:
            tok = f.read().strip()
    except Exception:
        return
    if tok:
        try:
            r = _trade_connect(tok, save=False)
            print("[ourbit] авто-подключение сохранённым токеном:", "ok, баланс $%.2f" % r.get("balance", 0) if r.get("ok") else "токен истёк — вставь свежий в терминале")
        except Exception:
            pass


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
                     "natr": round(natr, 3), "funding": round(funding * 100, 4), "amt24": round(amt24),
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
        # гейт ликвидности по 24ч-обороту (всегда есть, в отличие от минутного) — чтоб скор не обнулялся ночью
        liq = 0.0 if r["amt24"] < 300000 else min(1.0, r["amt24"] / 5000000.0)   # <$300k за сутки = мёртвая; полная ликвидность на $5М+
        spr = min(1.0, r["spread"] / 0.10)     # спред(тик)% 0.10%+ = жирный тик (как ARPA ~0.08%)
        vol = min(1.0, r["natr"] / 1.8)        # NATR 1.8%+ = активные прострелы
        vsp = min(1.0, r["vspike"] / 250.0)    # всплеск x2.5 = свипы
        # МАРКЕТОС (стенки) из фонового сканера стакана по топ-кандидатам
        wc = _WALL_CACHE.get(r["symbol"])
        r["wall"] = round(wc[0]) if wc else 0
        if wc:   # стакан известен → маркетос ГЛАВНЫЙ вес (крупная выделенная стенка = есть от чего собирать спред)
            wallN = min(1.0, (wc[1] - 1.0) / 4.0) if wc[1] > 1.0 else 0.0   # выделенность x5 глубины = максимум
            r["scoll"] = round(min(100.0, (0.40 * wallN + 0.30 * spr + 0.18 * vol + 0.12 * vsp) * liq * 100))
        else:    # стакан ещё не сканирован → по тикеру (спред-первичный), не штрафуем
            r["scoll"] = round(min(100.0, (0.50 * spr + 0.32 * vol + 0.18 * vsp) * liq * 100))
    # топ-кандидатов отправляем сканеру стенок (следующий проход учтёт маркетос)
    _top = sorted(rows, key=lambda r: r["scoll"], reverse=True)[:18]
    with _WALL_LOCK:
        _WALL_WANT["syms"] = [r["symbol"] for r in _top]
        _WALL_WANT["ts"] = time.time()
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


def _reg_ex(ex, url, parse=None, list_path="data", method="GET", body=None, build=None, headers=None, timeout=12):
    _EX_ADAPTERS[ex] = {"url": url, "parse": parse, "list": list_path,
                        "method": method, "body": body, "build": build, "headers": headers, "timeout": timeout}
    _EX_HIST[ex] = {"hist": collections.deque(maxlen=180), "lock": threading.Lock()}   # ~3 мин при опросе 1с (посекундная детальность линий)


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
            _ff(t.get("turnover24h")), _ff(t.get("volume24h")), _ff(t.get("price24hPcnt")),
            _ff(t.get("markPrice"))) if s else None                        # 8-й = справедливая (mark)


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
            _ff(t.get("volume_24h_quote")), _ff(t.get("volume_24h_base")), _ff(t.get("change_percentage")) / 100.0,
            _ff(t.get("mark_price")))                                       # 8-й = справедливая (mark)


def _p_bitget(t):
    s = _sym_strip_usdt(t.get("symbol"))
    return (s, _ff(t.get("lastPr")), _ff(t.get("bidPr")), _ff(t.get("askPr")),
            _ff(t.get("usdtVolume")), _ff(t.get("baseVolume")), _ff(t.get("change24h")),
            _ff(t.get("markPrice"))) if s else None                         # 8-й = справедливая (mark)


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
    base = _sym_strip_usdt(t.get("symbol"))          # спот /api/v3/ticker/24hr — есть bid/ask (MEXC-спот тот же формат)
    return (base, _ff(t.get("lastPrice")), _ff(t.get("bidPrice")), _ff(t.get("askPrice")),
            _ff(t.get("quoteVolume")), _ff(t.get("volume")), _ff(t.get("priceChangePercent")) / 100.0) if base else None


def _p_gatespot(t):
    s = (t.get("currency_pair") or "").upper()
    if not s.endswith("_USDT"):
        return None
    return (s, _ff(t.get("last")), _ff(t.get("highest_bid")), _ff(t.get("lowest_ask")),
            _ff(t.get("quote_volume")), _ff(t.get("base_volume")), _ff(t.get("change_percentage")) / 100.0)


def _p_okxspot(t):
    iid = t.get("instId") or ""
    if not iid.endswith("-USDT"):
        return None
    last = _ff(t.get("last")); op = _ff(t.get("open24h")); volc = _ff(t.get("volCcy24h"))
    return (iid[:-5] + "_USDT", last, _ff(t.get("bidPx")), _ff(t.get("askPx")),
            volc * last, volc, (last - op) / op if op else 0.0)


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
_reg_ex("gate", "https://api.gateio.ws/api/v4/futures/usdt/tickers", _p_gate, list_path="root", timeout=20)
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
# ── СПОТ-фиды бирж (буква S в панели THIEF) ──
_reg_ex("mexcspot", "https://api.mexc.com/api/v3/ticker/24hr", _p_binance_spot, list_path="root")
_reg_ex("bybitspot", "https://api.bybit.com/v5/market/tickers?category=spot", _p_bybit, list_path="result.list")
_reg_ex("gatespot", "https://api.gateio.ws/api/v4/spot/tickers", _p_gatespot, list_path="root")
_reg_ex("okxspot", "https://www.okx.com/api/v5/market/tickers?instType=SPOT", _p_okxspot, list_path="data")
_reg_ex("bitgetspot", "https://api.bitget.com/api/v2/spot/market/tickers", _p_bitget, list_path="data")
_reg_ex("lighter", "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", _p_lighter, list_path="order_book_details")
_reg_ex("hyperliquid", "https://api.hyperliquid.xyz/info", build=_build_hyperliquid, method="POST", body={"type": "metaAndAssetCtxs"})


_EX_WANT: dict = {}      # ex -> время последнего запроса из скринера (ленивый опрос)
_EX_TTL = 45             # сек: биржа опрашивается только пока её смотрят


def _ex_want(ex: str):
    _EX_WANT[ex] = time.time()


# ─────────── Карта принадлежности «биржа → множество монет» (для полоски бейджей) ───────────
_EX_SYMS: dict = {}          # ex -> set(symbols)  (какие монеты торгуются на бирже)
_EX_SYMS_LOCK = threading.Lock()


_BINANCE_BAN = [0.0]     # общий бэкофф Binance (418/429): и THIEF-поллер, и Классика уважают → бан рассасывается


def _ex_fetch(ex: str) -> dict:
    """Один запрос all-tickers биржи → snap {sym: (turn,base,rise,last,bid,ask)}."""
    ad = _EX_ADAPTERS[ex]
    kw = {"timeout": ad.get("timeout", 12)}
    if ad.get("headers"):
        kw["headers"] = ad["headers"]
    if ad["method"] == "POST":
        resp = _post(ad["url"], json=ad["body"], **kw)
    else:
        resp = _get(ad["url"], **kw)
    sc = getattr(resp, "status_code", 200)
    if sc in (418, 429) and "binance" in ad["url"]:      # лимит Binance — встаём на паузу (Retry-After), не долбим
        try:
            wait = int(resp.headers.get("Retry-After") or 120)
        except (TypeError, ValueError):
            wait = 120
        _BINANCE_BAN[0] = time.time() + min(max(wait, 60), 1800)
        if _classic:
            _classic.set_ban(_BINANCE_BAN[0])            # синхронизируем бан с модулем Классики (общий IP)
        raise RuntimeError("binance %s ban" % sc)
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
            snap[r[0]] = (r[4], r[5], r[6], r[1], r[2], r[3], r[7] if len(r) > 7 else 0.0)   # [6]=fair (mark), 0 если биржа не отдаёт
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
            if ex in ("binance", "binancespot") and time.time() < _BINANCE_BAN[0]:
                time.sleep(3)                    # бан Binance — не долбим (иначе бан не кончится); линии панели замрут
                continue
            snap = _ex_fetch(ex)
            _set_syms(ex, snap)
            with _EX_HIST[ex]["lock"]:
                _EX_HIST[ex]["hist"].append((time.time(), snap))
        except Exception:
            pass
        # Binance-тикер = вес 40; каждую секунду = ВЕСЬ лимит IP → klines Классики его переполняют.
        # Опрашиваем Binance раз в 3с (оставляем лимит сканеру), остальные биржи — раз в 1с как было.
        time.sleep(3.0 if ex in ("binance", "binancespot") else 1.0)


# ─────────── MEXC «справедливая цена» (fairPrice) — отдельный кэш+поллер для панели MEXC↔DEX ───────────
# _EX_HIST["mexc"] хранит только last (парсер отбрасывает fairPrice). Панель показывает справедливую
# цену отдельной линией — поэтому качаем all-ticker MEXC ещё раз, сохраняя (last, fair) с историей.
_MXFAIR = {"hist": collections.deque(maxlen=180), "lock": threading.Lock()}
_MXFAIR_WANT = [0.0]      # время последнего запроса из панели (ленивый опрос — не жжём сеть, если панель закрыта)


def _mxfair_want():
    _MXFAIR_WANT[0] = time.time()


def _mxfair_poll():
    """Тикеры MEXC-контрактов → {sym: (last, fair)} с историей. Опрос только пока панель смотрит."""
    url = "https://contract.mexc.com/api/v1/contract/ticker"
    while True:
        try:
            if time.time() - _MXFAIR_WANT[0] > 45:
                time.sleep(2); continue
            arr = _get(url, timeout=10).json().get("data") or []
            snap = {}
            for t in arr:
                s = (t.get("symbol") or "").upper()
                if not s.endswith("_USDT"):
                    continue
                last = _ff(t.get("lastPrice"))
                fair = _ff(t.get("fairPrice")) or _ff(t.get("indexPrice")) or last
                if last:
                    snap[s] = (last, fair)
            with _MXFAIR["lock"]:
                _MXFAIR["hist"].append((time.time(), snap))
        except Exception:
            pass
        time.sleep(1.0)                              # ~1с — справедливая MEXC тикает так же часто, как линии бирж


# ─────────── On-chain цена по контракту (Dexscreener, БЕСПЛАТНО без ключа) — фиолетовая DEX-линия [CA] ───────────
# DexTools API платный; Dexscreener даёт ту же USD-цену с самого ликвидного пула. symbol→контракт кэшируем
# в dex_map.json (+ ручной оверрайд). Опрашиваем только монеты, которые СЕЙЧАС смотрит панель (бережём лимит).
_DEX = {"hist": collections.deque(maxlen=300), "lock": threading.Lock()}   # ~55мин истории при быстром цикле
_DEX_MAP: dict = {}                              # base -> {chain,pair,addr,liq} | {"skip":True}
_DEX_WANT: dict = {}                             # base -> ts последнего запроса из панели
_DEX_REF: dict = {}                              # base -> референс-цена CEX (отсечка коллизий тикера)
_DEX_TS: dict = {}                               # base -> ts последнего СВЕЖЕГО опроса цены (гард актуальности алертов)
_DEX_MAP_FILE = os.path.join(HERE, "dex_map.json")


def _dex_load_map():
    global _DEX_MAP
    try:
        with open(_DEX_MAP_FILE, encoding="utf-8") as fh:
            _DEX_MAP = json.load(fh) or {}
    except Exception:
        _DEX_MAP = {}


def _dex_save_map():
    try:
        with open(_DEX_MAP_FILE, "w", encoding="utf-8") as fh:
            json.dump(_DEX_MAP, fh, ensure_ascii=False)
    except Exception:
        pass


def _dex_want(base):
    _DEX_WANT[base] = time.time()


import math as _math
_DEX_GOODQ = {"USDC", "USDT", "WETH", "WBNB", "SOL", "WSOL", "DAI", "USDE", "ETH", "BNB",
              "USDC.E", "USD1", "FDUSD", "TUSD", "USDD", "USDP", "WBTC"}
# ТЯЖИ — только настоящие блю-чипы, где цена DEX = цена биржи (арбитража нет). Спред-колл по ним = битый пул-тёзка → игнор.
_DEX_HEAVY = {"BTC", "ETH", "XRP", "BNB", "SOL", "DOGE", "ADA", "TRX", "LTC", "BCH",
              "DOT", "LINK", "AVAX", "XLM", "XMR", "ATOM", "TON",
              "WBTC", "WETH", "STETH", "PAXG", "XAUT", "USDC", "USDT", "DAI"}


_DEX_MIN_VOL = 20000                             # мин. объём пула 24ч ($): ниже = мёртвый пул, цена застывает → ложный спред
_DEX_MIN_TURN = 0.005                            # мин. оборот/ликвидность (0.5%/сут): отсекает ФЕЙКОВЫЕ «глубокие-мёртвые» пулы-тёзки ($1B ликв. + ~0 оборот)


def _dex_vol(p):
    """Объём 24ч пула ($). Главный критерий выбора пула — где реально идёт торговля, там живая цена (как смотрит друг)."""
    return _ff((p.get("volume") or {}).get("h24"))


def _dex_fake(liq, vol):
    """Пул-фейк? Абсурдная ликвидность при мизерном обороте = тёзка/спуф (даёт ложный спред-колл)."""
    return liq > 0 and vol < liq * _DEX_MIN_TURN


def _dex_resolve(base, ca=None):
    """Резолв пула DEX. ПРИОРИТЕТ — по КОНТРАКТУ токена (как THIEF, иммунитет к коллизии тикера);
    иначе поиск по тикеру со смягчённым гардом (ближе к цене CEX + по ликвидности)."""
    m = _DEX_MAP.get(base)
    if m:                                        # уже знаем (адрес/пара или skip) — не долбить
        return m
    if base in _DEX_HEAVY and not ca:            # тяж без явного контракта — не резолвим (арбитража нет, будет тёзка)
        _DEX_MAP[base] = {"skip": True}; return _DEX_MAP[base]
    ca = ca or (m or {}).get("addr")
    if ca:                                       # ── по контракту: пул с макс. объёмом (живой) ──
        try:
            ps = _get("https://api.dexscreener.com/latest/dex/tokens/" + ca, timeout=10).json().get("pairs") or []
            live = [p for p in ps if _ff(p.get("priceUsd")) > 0 and _dex_vol(p) >= _DEX_MIN_VOL
                    and not _dex_fake(_ff((p.get("liquidity") or {}).get("usd")), _dex_vol(p))]  # мёртвые/фейковые пулы мимо
            best = max(live, key=_dex_vol, default=None)     # выбираем пул с МАКС. объёмом 24ч (живая цена, как смотрит друг)
            if best:
                mm = {"chain": best.get("chainId"), "pair": best.get("pairAddress"), "addr": ca,
                      "liq": round(_ff((best.get("liquidity") or {}).get("usd"))), "vol": round(_dex_vol(best))}
                _DEX_MAP[base] = mm; _dex_save_map(); return mm
        except Exception:
            pass
    if len(base) <= 2:                           # однобуквенные тикеры по поиску бесполезны — только по CA
        return {"skip": True}
    ref = _DEX_REF.get(base, 0.0)
    try:
        pairs = _get("https://api.dexscreener.com/latest/dex/search",
                     params={"q": base}, timeout=10).json().get("pairs") or []
        cand = []
        for p in pairs:
            if ((p.get("baseToken") or {}).get("symbol") or "").upper() != base:
                continue
            if ((p.get("quoteToken") or {}).get("symbol") or "").upper() not in _DEX_GOODQ:
                continue
            px = _ff(p.get("priceUsd")); liq = _ff((p.get("liquidity") or {}).get("usd"))
            if px > 0 and liq >= 25000 and _dex_vol(p) >= _DEX_MIN_VOL and not _dex_fake(liq, _dex_vol(p)):
                cand.append((p, px, liq))         # мимо: тонкие (<$25k), мёртвые (<$20k), и ФЕЙКОВЫЕ (огромная ликв.+нулевой оборот = тёзка)
        if ref and cand:                          # у настоящей монеты цена DEX≈цене биржи → двойники отсекаются ценой
            cand = [c for c in cand if 0.88 <= c[1] / ref <= 1.12]     # ТОЛЬКО ±~12%: реальный арбитраж MEXC↔DEX тут, шире = обёрнутый пул-тёзка
        elif not ref:                             # нет цены с биржи (не знаем ref) — не рискуем, только по CA
            cand = []
        best = max(cand, key=lambda c: _dex_vol(c[0]), default=None)   # пул с МАКС. объёмом 24ч — живая цена (как друг)
        if best:
            bp = best[0]
            m = {"chain": bp.get("chainId"), "pair": bp.get("pairAddress"),
                 "addr": (bp.get("baseToken") or {}).get("address"),
                 "liq": round(best[2]), "vol": round(_dex_vol(bp))}
            _DEX_MAP[base] = m; _dex_save_map()
        else:
            m = {"skip": True}
        return m
    except Exception:
        return {}


# Dexscreener chainId → GeckoTerminal network slug (для истории свечей DEX-пула)
_GT_NET = {"ethereum": "eth", "bsc": "bsc", "solana": "solana", "base": "base", "arbitrum": "arbitrum",
           "polygon": "polygon_pos", "optimism": "optimism", "avalanche": "avax", "fantom": "ftm",
           "sui": "sui-network", "ton": "ton", "tron": "tron", "blast": "blast", "linea": "linea", "scroll": "scroll",
           "mantle": "mantle", "zksync": "zksync-era", "celo": "celo", "cronos": "cro", "sonic": "sonic",
           "berachain": "berachain", "unichain": "unichain", "hyperliquid": "hyperevm", "abstract": "abstract",
           "ink": "ink", "apechain": "apechain", "world-chain": "world-chain", "pulsechain": "pulsechain",
           "seiv2": "sei-evm", "gnosischain": "xdai", "moonbeam": "moonbeam",
           "worldchain": "world-chain", "taiko": "taiko"}
_DEX_KL: dict = {}                                # (base) -> (pts, ts) кэш истории DEX-свечей (совместимость)
_DEX_OHLC: dict = {}                              # (base) -> (bars, ts, minutes) кэш OHLC-свечей DEX


def _dex_ohlc(base: str, minutes: int) -> list:
    """OHLC-свечи DEX-пула (GeckoTerminal, бесплатно) → [[t_sec, open, high, low, close]] за последние `minutes` минут.
    Полная история свечей DEX (для свечного графика), масштаб выправлен к живой цене Dexscreener."""
    m = _DEX_MAP.get(base)
    if not m or m.get("skip") or not m.get("chain") or not m.get("pair"):
        return []
    now = time.time()
    c = _DEX_OHLC.get(base)
    if c and now - c[1] < 45 and c[2] == minutes:  # кэш 45с, учитывает окно (иначе 4ч-запрос отдаёт данные вместо 24ч)
        return c[0]
    net = _GT_NET.get(m["chain"], m["chain"])
    bars = []
    try:
        agg = 1 if minutes <= 600 else 5 if minutes <= 3000 else 15   # 24ч (1440м) = 5-мин свечи (минутный лимит 1000 не покроет)
        lim = min(1000, minutes // agg + 10)
        url = f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{m['pair']}/ohlcv/minute"
        gp = {"aggregate": agg, "limit": lim, "currency": "usd"}
        if m.get("addr"):
            gp["token"] = m["addr"]                # цена ИМЕННО нашей монеты (иначе GT берёт базовый токен пула → чужая цена)
        d = _get(url, params=gp, timeout=10).json()
        lst = (((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
        if not lst and gp.get("token"):           # GT отверг token-адрес (не-EVM формат, напр. sui «0x…::sui::SUI» → 400) → повтор без token, масштаб выправит якорь ниже
            gp.pop("token", None)
            d = _get(url, params=gp, timeout=10).json()
            lst = (((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
        for x in lst:                             # ohlcv_list: [ts, open, high, low, close, volume]
            if len(x) >= 5:
                o, h, l, cl = _ff(x[1]), _ff(x[2]), _ff(x[3]), _ff(x[4])
                if cl > 0 and o > 0:
                    bars.append([int(x[0]), o, h, l, cl])
        bars.sort()
        live = _dex_price(base)                   # привязка к правде Dexscreener: если GT даёт иной масштаб — подгоняем ВСЕ o/h/l/c
        if live > 0 and bars and bars[-1][4] > 0:
            f = live / bars[-1][4]
            if f < 0.98 or f > 1.02:              # масштаб/сторона GT разошлись с живой ценой >2% → выравниваем всю историю к правде Dexscreener
                bars = [[t, o * f, h * f, l * f, cl * f] for t, o, h, l, cl in bars]
    except Exception:
        bars = []
    _DEX_OHLC[base] = (bars, now, minutes)
    return bars


def _dex_kline(base: str, minutes: int) -> list:
    """История цены DEX линией → [[t_sec, close]] (оверлей/совместимость). Строится из OHLC-кэша, без лишних запросов."""
    return [[t, cl] for t, o, h, l, cl in _dex_ohlc(base, minutes)]


_DEX_TRADES: dict = {}                            # base -> (pts, ts) кэш per-swap сделок DEX


def _dex_trades(base: str) -> list:
    """ПОСВОПОВАЯ цена DEX (каждая сделка) → [[t_sec, price_usd]] последних ~200 свопов (GeckoTerminal /trades).
    Даёт детальную линию DEX как у друга: каждое движение = реальный своп в пуле (мельче, чем snapshot Dexscreener)."""
    m = _DEX_MAP.get(base)
    if not m or m.get("skip") or not m.get("chain") or not m.get("pair"):
        return []
    now = time.time()
    c = _DEX_TRADES.get(base)
    if c and now - c[1] < 6:                      # кэш 6с (свопы прилетают не чаще)
        return c[0]
    net = _GT_NET.get(m["chain"], m["chain"])
    addr = (m.get("addr") or "").lower()
    pts = []
    try:
        url = f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{m['pair']}/trades"
        d = _get(url, timeout=10).json()
        for t in (d.get("data") or []):
            a = t.get("attributes") or {}
            ts = a.get("block_timestamp") or ""
            try:
                sec = calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))
            except Exception:
                continue
            fa = (a.get("from_token_address") or "").lower()
            ta = (a.get("to_token_address") or "").lower()
            if addr and ta == addr:               # наша монета = to → её цена price_to
                px = _ff(a.get("price_to_in_usd"))
            elif addr and fa == addr:             # наша монета = from
                px = _ff(a.get("price_from_in_usd"))
            else:                                 # без addr — берём меньшую по величине (обычно наша дешёвая монета, а не quote-стейбл/WBNB)
                pf, pt = _ff(a.get("price_from_in_usd")), _ff(a.get("price_to_in_usd"))
                px = min([p for p in (pf, pt) if p > 0] or [0])
            if px > 0:
                pts.append([sec, px])
        pts.sort()
        live = _dex_price(base)                   # выравнивание масштаба к правде Dexscreener
        if live > 0 and pts and pts[-1][1] > 0:
            f = live / pts[-1][1]
            if f < 0.9 or f > 1.1:
                pts = [[s, p * f] for s, p in pts]
    except Exception:
        pts = []
    _DEX_TRADES[base] = (pts, now)
    return pts


def _dex_price(base):
    m = _DEX_MAP.get(base)
    if not m or m.get("skip") or not m.get("chain") or not m.get("pair"):
        return 0.0
    try:
        js = _get(f"https://api.dexscreener.com/latest/dex/pairs/{m['chain']}/{m['pair']}", timeout=10).json()
        pairs = js.get("pairs") or ([js.get("pair")] if js.get("pair") else [])
        if pairs and pairs[0]:
            return _ff(pairs[0].get("priceUsd"))
    except Exception:
        pass
    return 0.0


_DEX_POLL_CAP = 120                                  # потолок постоянного опроса вотчлиста (лимит Dexscreener)
_DEX_SLOW_BATCH = 24                                 # монет вотчлиста за один проход (ротацией) — проход ~12с, вся сотня освежается за ~5 проходов (<90с гарда)
_DEX_FRESH_SEC = 90                                  # старше — цена DEX считается протухшей (не берём в спред-коллы)
_dex_slow_off = 0                                    # смещение ротации медленного ряда


def _dex_poll():
    """On-chain цены. ДВА РЯДА: быстрый — монеты, открытые в панели (их видит юзер), качаем КАЖДЫЙ проход
    → живая тикающая линия; медленный — вотчлист по объёму, опрашиваем ротацией порциями (для ленты спред-коллов).
    Так монеты в ячейках освежаются за ~10-15с вместо ~60с, при этом лимит Dexscreener соблюдён."""
    global _dex_slow_off
    while True:
        try:
            now = time.time()
            fast = [b for b, t in list(_DEX_WANT.items()) if now - t <= 45]      # открыто в панели — всегда
            fastset = set(fast)
            watch = [b for b, mm in list(_DEX_MAP.items())
                     if isinstance(mm, dict) and not mm.get("skip") and mm.get("pair") and b not in fastset]
            watch.sort(key=lambda b: (_DEX_MAP.get(b) or {}).get("vol", 0)
                       or (_DEX_MAP.get(b) or {}).get("liq", 0), reverse=True)   # активные пулы — в приоритет
            watch = watch[:_DEX_POLL_CAP]
            if watch:
                _dex_slow_off %= len(watch)
                slow = watch[_dex_slow_off:_dex_slow_off + _DEX_SLOW_BATCH]
                _dex_slow_off += _DEX_SLOW_BATCH
            else:
                slow = []
            bases = fast + [b for b in slow if b not in fastset]
            if not bases:
                time.sleep(2); continue
            snap = dict(_DEX["hist"][-1][1]) if _DEX["hist"] else {}   # держим прошлые значения между опросами (линия непрерывна)
            mx_last = {}                                              # живая цена MEXC (для проверки дрейфа пула)
            mh = _EX_HIST.get("mexc")
            if mh:
                with mh["lock"]:
                    ms = mh["hist"][-1][1] if mh["hist"] else {}
                mx_last = {s.replace("_USDT", ""): v[3] for s, v in ms.items() if v and v[3]}
            for b in bases:
                m = _DEX_MAP.get(b)
                if m is None:
                    _dex_resolve(b); time.sleep(0.3); m = _DEX_MAP.get(b)
                if not isinstance(m, dict) or m.get("skip") or not m.get("pair"):
                    continue                                          # нечего качать — без сетевого запроса и без паузы
                px = _dex_price(b)
                if px:
                    ml = mx_last.get(b)                               # ЖИВОЙ гард тёзки: DEX уехал >15% от MEXC → пул неверный, выкинуть
                    if ml and ml > 0 and (px / ml > 1.15 or px / ml < 0.87):
                        _DEX_REF[b] = ml; _DEX_MAP[b] = {"skip": True}
                        _DEX_TS.pop(b, None); snap.pop(b, None); _dex_save_map()
                    else:
                        snap[b] = px; _DEX_TS[b] = time.time()        # отметка свежести (для гарда актуальности)
                time.sleep(0.3)
            with _DEX["lock"]:
                _DEX["hist"].append((time.time(), snap))
        except Exception:
            pass
        time.sleep(1)


_DEX_SEED_TOPN = 260                                  # сколько топ-монет MEXC по обороту пытаться привязать к DEX


def _dex_seed():
    """Фоновый посев вотчлиста: топ монет MEXC по обороту → подобрать правильный DEX-пул (жёсткая проверка
    цена≈биржа + ликвидность) и закэшировать в dex_map. Так лента MEXC↔DEX наполняется САМА, без ручной вставки CA."""
    time.sleep(25)                                   # дать mexc прогреться
    while True:
        try:
            for b, mm in list(_DEX_MAP.items()):     # выкинуть закэшированные МЁРТВЫЕ/ФЕЙКОВЫЕ пулы → перерезолв/skip
                if isinstance(mm, dict) and mm.get("pair") and mm.get("vol") is not None \
                   and (mm["vol"] < _DEX_MIN_VOL or _dex_fake(mm.get("liq", 0), mm["vol"])):
                    _DEX_MAP.pop(b, None); _DEX_REF.pop(b, None)
            _ex_want("mexc")
            h = _EX_HIST.get("mexc")
            snap = {}
            if h:
                with h["lock"]:
                    snap = h["hist"][-1][1] if h["hist"] else {}
            ranked = sorted(((sym, v) for sym, v in snap.items() if v and v[3] and v[0]),
                            key=lambda kv: kv[1][0], reverse=True)[:_DEX_SEED_TOPN]
            if len(ranked) < 20:                      # MEXC ещё не прогрелся (мало монет) → короткая пауза и повтор, НЕ спать 10 мин
                time.sleep(15); continue
            for sym, v in ranked:
                base = sym.replace("_USDT", "")
                if base in _DEX_MAP:                  # уже пробовали (пул или skip) — не долбим повторно
                    continue
                if base in _DEX_HEAVY or len(base) <= 2:   # тяжи (BTC/ETH/XRP…) — без арбитража, пропускаем
                    _DEX_MAP[base] = {"skip": True}; continue
                _DEX_REF[base] = v[3]                 # ref = последняя цена MEXC (для отсечки монет-двойников)
                try:
                    _dex_resolve(base)
                except Exception:
                    _DEX_MAP[base] = {"skip": True}
                time.sleep(0.5)                       # ~120 запросов/мин — под лимитом Dexscreener
        except Exception:
            pass
        time.sleep(600)                               # раз в 10 мин добираем новые монеты в топе


def _grid_series(syms, exs, want_fair, want_dex=False):
    """Серии цены монеты сразу по нескольким биржам (+справедливая MEXC, +on-chain DEX) для панели MEXC↔DEX.
    Возвращает {sym: {"s": {ex: [[t,last]...]}, "m": {ex: {last,turn,rise}}}}."""
    fair_exs = [e[:-4] for e in exs if e.endswith("fair") and e != "mexcfair" and e[:-4] in _EX_ADAPTERS]   # bybitfair→bybit: справедливая ИЗ ТОГО ЖЕ тикера биржи
    exs = [e for e in exs if not e.endswith("fair") or e == "mexcfair"]
    for e in exs + fair_exs:                         # прогреть нужные фиды (ленивый опрос)
        if e in _EX_ADAPTERS:
            _ex_want(e)
    if want_fair:
        _mxfair_want()
    dh = []
    if want_dex:
        with _DEX["lock"]:
            dh = list(_DEX["hist"])
    out = {}
    for sym in syms:
        s = {}; m = {}
        base = sym[:-5] if sym.endswith("_USDT") else sym
        for e in exs:
            h = _EX_HIST.get(e)
            if not h:
                continue
            with h["lock"]:
                hist = list(h["hist"])
            arr = [[round(t, 1), v[3]] for (t, snap) in hist
                   for v in (snap.get(sym),) if v and v[3]]
            if arr:
                s[e] = arr
                nv = hist[-1][1].get(sym)
                if nv:
                    m[e] = {"last": nv[3], "turn": round(nv[0]), "rise": round(nv[2] * 100, 2)}
        for e in fair_exs:                            # справедливая (mark) биржи: серия из 7-го поля снапшота
            h = _EX_HIST.get(e)
            if not h:
                continue
            with h["lock"]:
                hist = list(h["hist"])
            fa = [[round(t, 1), v[6]] for (t, snap) in hist
                  for v in (snap.get(sym),) if v and len(v) > 6 and v[6]]
            if fa:
                s[e + "fair"] = fa
                m[e + "fair"] = {"last": fa[-1][1], "turn": 0, "rise": 0.0}
        if want_fair:
            with _MXFAIR["lock"]:
                fh = list(_MXFAIR["hist"])
            fa = [[round(t, 1), v[1]] for (t, snap) in fh
                  for v in (snap.get(sym),) if v]
            fl = [[round(t, 1), v[0]] for (t, snap) in fh
                  for v in (snap.get(sym),) if v]
            if fa:
                s["mexcfair"] = fa
                m["mexcfair"] = {"last": fa[-1][1], "turn": 0, "rise": 0.0}   # живой фолбэк — пунктир справедливой не рвётся между поллами
            if fl and "mexc" not in s:               # если mexc-фид не выбран — берём last из fair-поллера
                s["mexc"] = fl
        if want_dex:
            _ref = (m.get("mexc") or m.get("binance") or m.get("bybit") or {}).get("last") or 0.0
            if _ref:
                _DEX_REF[base] = _ref                 # референс CEX для отсечки коллизий при резолве DEX
            _dex_want(base)                          # попросить поллер качать эту монету
            da = [[round(t, 1), snap[base]] for (t, snap) in dh if snap.get(base)]
            if da:
                s["dex"] = da
                m["dex"] = {"last": da[-1][1], "turn": (_DEX_MAP.get(base) or {}).get("liq", 0), "rise": 0.0}
        out[sym] = {"s": s, "m": m}
    return out


# ─────────── Помесекундный рекордер цен (MEXC last + DEX + справедливая) — ПЛОТНАЯ история для панели MEXC↔DEX ───────────
# Свечи kline дают 1 точку/мин (грубо). Рекордер сэмплит цену КАЖДУЮ ~1с в кольцевые буферы → на графике виден
# каждый тик расхождения MEXC↔DEX сразу при открытии (не ждём, пока живой фид медленно наполнит). Пишем ТОЛЬКО
# монеты, которые сейчас смотрят (потолок числа монет + maxlen буфера) — память ограничена, CPU не жжём.
_PX: dict = {}                                       # base -> {feed:deque}, элемент = (t_sec, price). feed: mexc/dex/fair + осн. биржи
_PX_LOCK = threading.Lock()
_PX_MAXLEN = 7200                                    # ~2ч посекундно на линию (записываем МНОГО бирж → бюджет памяти)
_PX_CEX = ("binance", "bybit", "gate", "bitget", "okx", "bingx", "ourbit", "asterdex")   # доп. биржи для посекундной истории (mexc пишется отдельно)
_PX_MAX_COINS = 60                                   # потолок числа одновременно записываемых монет (память/CPU)
_PREWARM_TOP = 24                                    # сколько САМЫХ активных монет ленты пред-писать посекундно (чтоб при открытии график был уже детальный)
_PX_WATCH_SEC = 60                                   # монета «смотрится», если её просили из панели в этом окне
_PX_KEEP_SEC = 900                                   # держим буфер ещё ~15мин после того как перестали смотреть (реопен покажет историю)
_PX_WATCH: dict = {}                                 # base -> ts последнего явного «просмотра» (запрос /api/pxhist)
_PX_DEX_HOT: dict = {}                                # base -> (ts, px) — «горячая» DEX-цена, опрашивается часто для ОТКРЫТЫХ монет
_PX_HOT_MAX = 30                                      # сколько открытых монет опрашивать DEX часто (батч Dexscreener: до 30 пар/сеть 1 запросом → все открытые обновляются ~1-2с)


def _px_watch(base):
    _PX_WATCH[base] = time.time()


def _px_dex_hot():
    """Частый опрос DEX-цены для ОТКРЫТЫХ монет — БАТЧАМИ: Dexscreener принимает до 30 пар ОДНИМ запросом
    (/pairs/{chain}/{p1},{p2},…). Одна сеть = один запрос → в разы меньше запросов (нет 429 rate-limit),
    обновление ~1-2с на ВСЕ открытые монеты сразу (раньше 0.35с/монету по очереди — ловили 429, цена стояла)."""
    while True:
        try:
            now = time.time()
            hot = [b for b, t in list(_DEX_WANT.items()) if now - t <= 30]        # реально открыто сейчас
            hot.sort(key=lambda b: -_DEX_WANT.get(b, 0))
            hot = hot[:_PX_HOT_MAX]
            groups = {}                                                           # chain -> [(base, pair_lower)]
            for b in hot:
                m = _DEX_MAP.get(b)
                if not isinstance(m, dict) or m.get("skip") or not m.get("pair") or not m.get("chain"):
                    continue
                groups.setdefault(m["chain"], []).append((b, m["pair"].lower()))
            did = False
            for chain, lst in groups.items():
                try:
                    pairs = ",".join(p for _, p in lst[:30])
                    js = _get(f"https://api.dexscreener.com/latest/dex/pairs/{chain}/{pairs}", timeout=10).json()
                    arr = js.get("pairs") or ([js.get("pair")] if js.get("pair") else [])
                    bypair = {(p.get("pairAddress") or "").lower(): _ff(p.get("priceUsd")) for p in arr if p}
                    ts = time.time()
                    for b, pr in lst:
                        px = bypair.get(pr) or 0.0
                        if px > 0:
                            _PX_DEX_HOT[b] = (ts, px)
                    did = True
                except Exception:
                    pass
                time.sleep(0.4)
            for b in list(_PX_DEX_HOT.keys()):                                   # чистим давно не открытые
                if now - _DEX_WANT.get(b, 0) > 120:
                    _PX_DEX_HOT.pop(b, None)
            if not did:
                time.sleep(1)
        except Exception:
            pass
        time.sleep(0.6)


def _px_recorder():
    """Каждую ~1с сэмплит MEXC last + DEX + справедливую для СМОТРИМЫХ монет в кольцевые буферы — плотная посекундная история."""
    while True:
        try:
            now = time.time()
            watched = set()
            for b, t in list(_DEX_WANT.items()):     # открыто в ячейке панели (gridseries dex=1 ставит для ЛЮБОЙ монеты, даже без DEX)
                if now - t <= _PX_WATCH_SEC:
                    watched.add(b)
            for b, t in list(_PX_WATCH.items()):      # явно запрошено из /api/pxhist (страховка)
                if now - t <= _PX_WATCH_SEC:
                    watched.add(b)
            if watched:
                watched = set(sorted(watched)[:_PX_MAX_COINS])   # потолок числа монет (детерминированно)
                mx = {}                               # MEXC last по base
                mh = _EX_HIST.get("mexc")
                if mh:
                    with mh["lock"]:
                        ms = mh["hist"][-1][1] if mh["hist"] else {}
                    mx = {s.replace("_USDT", ""): v[3] for s, v in ms.items() if v and v[3]}
                with _MXFAIR["lock"]:                 # справедливая (fair) — тот же источник, что m["mexcfair"] в _grid_series
                    fs = _MXFAIR["hist"][-1][1] if _MXFAIR["hist"] else {}
                fair = {s.replace("_USDT", ""): v[1] for s, v in fs.items() if v and v[1]}
                with _DEX["lock"]:                    # on-chain цена DEX по base
                    dex = dict(_DEX["hist"][-1][1]) if _DEX["hist"] else {}
                cexsnaps = {}                          # доп. биржи: последний снапшот (только прогретые, у кого есть данные)
                for f in _PX_CEX:
                    h = _EX_HIST.get(f)
                    if not h:
                        continue
                    with h["lock"]:
                        snp = h["hist"][-1][1] if h["hist"] else {}
                    if snp:
                        cexsnaps[f] = snp
                ts = round(now, 1)
                with _PX_LOCK:
                    for b in watched:
                        buf = _PX.get(b)
                        if buf is None:
                            buf = _PX[b] = {"mexc": collections.deque(maxlen=_PX_MAXLEN),
                                            "dex":  collections.deque(maxlen=_PX_MAXLEN),
                                            "fair": collections.deque(maxlen=_PX_MAXLEN)}
                        mp = mx.get(b)
                        if mp:
                            buf["mexc"].append((ts, mp))
                        fp = fair.get(b)
                        if fp:
                            buf["fair"].append((ts, fp))
                        hot = _PX_DEX_HOT.get(b)                       # свежая «горячая» DEX-цена (опрос ~3с) важнее снапшота (~40с)
                        dp = hot[1] if (hot and now - hot[0] <= 15) else dex.get(b)
                        if dp:
                            buf["dex"].append((ts, dp))
                        sym_u = b + "_USDT"                            # ОСНОВНЫЕ БИРЖИ посекундно (детальная история как у MEXC)
                        for f, snp in cexsnaps.items():
                            v = snp.get(sym_u)
                            if v and v[3]:
                                dq = buf.get(f)
                                if dq is None:
                                    dq = buf[f] = collections.deque(maxlen=_PX_MAXLEN)
                                dq.append((ts, v[3]))
                    if len(_PX) > _PX_MAX_COINS * 2:  # уборка буферов монет, которые давно не смотрят (память ограничена)
                        for b in list(_PX.keys()):
                            last_seen = max(_DEX_WANT.get(b, 0), _PX_WATCH.get(b, 0))
                            if now - last_seen > _PX_KEEP_SEC:
                                _PX.pop(b, None)
        except Exception:
            pass
        time.sleep(1)


def _px_hist(syms, sec):
    """Последние `sec` секунд посекундной истории для монет → {SYM_USDT: {"mexc":[[t,p]...], "dex":[...], "fair":[...]}}."""
    cut = time.time() - sec
    out = {}
    with _PX_LOCK:
        for s in syms:
            b = s.replace("_USDT", "")
            _px_watch(b)                              # запрос из панели = монета смотрится → рекордер начнёт её писать
            buf = _PX.get(b)
            if not buf:
                out[s] = {"mexc": [], "dex": [], "fair": []}
                continue
            out[s] = {k: [[t, p] for (t, p) in dq if t >= cut] for k, dq in buf.items()}   # все записанные биржи (mexc/dex/fair + осн.)
    return out


_PUMP_WIN = 90                                       # окно расчёта пампа/дампа, сек (движение цены «прямо сейчас»)


def _pump_pct(ex, sym):
    """Краткосрочное изменение цены биржи `ex` по монете `sym` за последние ~_PUMP_WIN сек (памп>0 / дамп<0)."""
    h = _EX_HIST.get(ex)
    if not h:
        return 0.0
    with h["lock"]:
        hist = list(h["hist"])
    if len(hist) < 2:
        return 0.0
    cut = hist[-1][0] - _PUMP_WIN
    first = last = 0.0
    for t, snap in hist:
        v = snap.get(sym)
        if not v or not v[3]:
            continue
        if t >= cut and first == 0.0:
            first = v[3]
        last = v[3]
    return (last - first) / first * 100 if first > 0 and last > 0 else 0.0


def _gap_top(exs, n, minturn, maxgap=400.0):
    """Топ монет по максимальному расхождению последней цены между биржами (авто-список для панели).
    Фильтры от мусора: минимум ликвидности (minturn) и потолок гэпа maxgap% (гэп выше = коллизия тикеров/битая цена).
    Плюс `pump` — краткосрочное движение цены (для стратегии памп-дамп: клиент требует памп + расхождение)."""
    for e in exs:
        if e in _EX_ADAPTERS:
            _ex_want(e)
    latest = {}                                      # ex -> {sym: (last, turn)}
    for e in exs:
        h = _EX_HIST.get(e)
        if not h:
            continue
        with h["lock"]:
            snap = h["hist"][-1][1] if h["hist"] else {}
        latest[e] = {sym: (v[3], v[0], v[2]) for sym, v in snap.items() if v and v[3]}
    syms = set()
    for e in latest:
        syms |= set(latest[e].keys())
    dex_snap = {}; _now = time.time()                # on-chain цены (только по монетам, что уже опрашиваются)
    try:
        with _DEX["lock"]:
            if _DEX["hist"]:
                dex_snap = dict(_DEX["hist"][-1][1])
    except Exception:
        pass
    rows = []
    for sym in syms:
        pairs = []; turn = 0.0; exset = []; rise = 0.0; hiturn = -1.0; ref_e = None
        for e in exs:
            v = latest.get(e, {}).get(sym)
            if v:
                pairs.append((e, v[0])); exset.append(e)
                if v[1] > hiturn:                    # 24ч-изменение + памп берём с самой оборотистой биржи
                    hiturn = v[1]; turn = v[1]; rise = v[2]; ref_e = e
        _b = sym.replace("_USDT", "")
        dpx = dex_snap.get(_b) if _b not in _DEX_HEAVY else 0   # DEX↔биржа — СУТЬ стратегии; тяжи игнорим (там нет арбитража)
        if dpx and dpx > 0 and pairs and (_now - _DEX_TS.get(_b, 0) <= _DEX_FRESH_SEC):   # только СВЕЖАЯ цена DEX (протухшую в спред-колл не берём)
            pairs.append(("dex", dpx)); exset.append("dex")
        if len(pairs) < 2 or turn < minturn:
            continue
        lo_e, mn = min(pairs, key=lambda x: x[1])    # биржа с минимальной ценой (дешевле)
        hi_e, mx = max(pairs, key=lambda x: x[1])    # биржа с максимальной ценой (дороже)
        if mn <= 0:
            continue
        gap = (mx - mn) / mn * 100
        if gap > maxgap:                             # абсурдный гэп = разные токены под одним тикером / битая цена
            continue
        pump = _pump_pct(ref_e, sym) if ref_e else 0.0   # памп/дамп «прямо сейчас» (движение ref-биржи за ~90с)
        rows.append({"symbol": sym, "gap": round(gap, 3), "turn": round(turn),
                     "rise": round(rise * 100, 2), "pump": round(pump, 2), "ex": exset, "loEx": lo_e, "hiEx": hi_e})
    rows.sort(key=lambda r: max(r["gap"], abs(r["pump"])), reverse=True)   # наверх: и сильное расхождение, И сильный памп/дамп
    for r in rows[:_PREWARM_TOP]:                # ПРЕД-ЗАПИСЬ: топ активных монет пишем посекундно ЗАРАНЕЕ → при открытии график сразу детальный
        _bb = r["symbol"].replace("_USDT", "")
        _px_watch(_bb); _dex_want(_bb)
    return rows[:n]


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


# ── ссылки на страницу монеты по биржам (панель MEXC↔DEX: бейджи под монетой, клик = переход) ──
_EX_URL = {
    "mexc": "https://futures.mexc.com/exchange/{S}",          "mexcspot": "https://www.mexc.com/exchange/{S}",
    "binance": "https://www.binance.com/en/futures/{C}",      "binancespot": "https://www.binance.com/en/trade/{S}",
    "bybit": "https://www.bybit.com/trade/usdt/{C}",          "bybitspot": "https://www.bybit.com/en/trade/spot/{B}/USDT",
    "okx": "https://www.okx.com/trade-swap/{L}-usdt-swap",    "okxspot": "https://www.okx.com/trade-spot/{L}-usdt",
    "gate": "https://www.gate.io/futures_trade/USDT/{S}",     "gatespot": "https://www.gate.io/trade/{S}",
    "bitget": "https://www.bitget.com/futures/usdt/{C}",      "bitgetspot": "https://www.bitget.com/spot/{C}",
    "bingx": "https://bingx.com/en-us/perpetual/{B}-USDT",    "ourbit": "https://futures.ourbit.com/exchange/{S}",
    "weex": "https://www.weex.com/futures/{B}-USDT",          "kucoin": "https://www.kucoin.com/futures/trade/{C}M",
    "htx": "https://www.htx.com/futures/linear_swap/exchange#contract_code={B}-USDT",
    "lbank": "https://www.lbank.com/futures/{l}usdt",         "bitmart": "https://futures.bitmart.com/en-US?symbol={C}",
    "xt": "https://www.xt.com/en/futures/trade/{l}_usdt",     "blofin": "https://blofin.com/futures/{B}-USDT",
    "bitunix": "https://www.bitunix.com/contract-trade/{C}",  "whitebit": "https://whitebit.com/trade/{B}-PERP",
    "asterdex": "https://www.asterdex.com/en/futures/{C}",    "lighter": "https://app.lighter.xyz/trade/{B}",
    "hyperliquid": "https://app.hyperliquid.xyz/trade/{B}",
}


def _ex_url(ex: str, sym: str) -> str:
    """URL страницы монеты на бирже. {S}=BTC_USDT {C}=BTCUSDT {B}=BTC {L}=btc-lower {l}=btclower."""
    t = _EX_URL.get(ex) or ""
    if not t:
        return ""
    base = sym[:-5] if sym.endswith("_USDT") else sym
    return (t.replace("{S}", sym).replace("{C}", base + "USDT")
             .replace("{B}", base).replace("{L}", base.lower()).replace("{l}", base.lower()))


def _mx_where(syms: list) -> dict:
    """{sym: [[ex, url], ...]} — на каких биржах монета есть (для бейджей под монетой в панели)."""
    out = {}
    with _EX_SYMS_LOCK:
        snap = {ex: s for ex, s in _EX_SYMS.items()}
    for sym in syms:
        rows = []
        for ex, s in snap.items():
            if sym in s:
                rows.append([ex, _ex_url(ex, sym)])
        out[sym] = rows
    return out


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
        amt24, vol24, rise, last, bid, ask = tup[:6]     # snap хранит 7 полей ([6]=fairPrice для THIEF) — скринеру нужны первые 6
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
        _scoll = 0; _wall = 0
        if ex == "weex":                     # СБОР/маркетос для WEEX (спред×прострелы×свипы×стена, гейт по 24ч)
            _liq = 0.0 if amt24 < 300000 else min(1.0, amt24 / 5000000.0)
            _spr = min(1.0, spread / 0.10); _vol = min(1.0, natr / 1.8); _vsp = min(1.0, vspike / 250.0)
            _wc = _WEEX_WALL.get(sym)
            if _wc:
                _wall = round(_wc[0])
                _wallN = min(1.0, (_wc[1] - 1.0) / 4.0) if _wc[1] > 1.0 else 0.0
                _scoll = round(min(100.0, (0.40 * _wallN + 0.30 * _spr + 0.18 * _vol + 0.12 * _vsp) * _liq * 100))
            else:
                _scoll = round(min(100.0, (0.50 * _spr + 0.32 * _vol + 0.18 * _vsp) * _liq * 100))
        rows.append({"symbol": sym, "ex": ex, "rise": round(rise * 100, 2), "last": last, "bid": bid, "ask": ask,
                     "amt": round(d_amt), "vol": round(d_vol), "spread": spread, "trades": 0,
                     "dusd": 0, "dpct": 0.0, "natr": natr, "funding": 0.0, "scoll": _scoll, "wall": _wall,
                     "oipct": 0.0, "oiusd": 0, "vspike": vspike})
    mam = max((r["amt"] for r in rows), default=1) or 1
    for r in rows:
        r["act"] = round(100 * r["amt"] / mam)
    rows.sort(key=lambda r: r["amt"], reverse=True)
    top = rows[:n]
    if ex == "weex":                     # число сделок WEEX из СВОЕГО WS-фида (_weex_deal_metrics) — ВСЕ монеты real-time
        now_ms = int(time.time() * 1000)
        cutoff = now_ms - int(win * 1000)     # win = окно в СЕКУНДАХ (win_sec)
        for r in rows:
            c, turn, delta = _weex_deal_metrics(r["symbol"], cutoff)
            r["trades"] = c; r["vol"] = c
            if turn:
                r["amt"] = round(turn); r["dusd"] = round(delta)
                r["dpct"] = round(delta / turn * 100, 2) if turn else 0.0
        mam = max((r["amt"] for r in rows), default=1) or 1    # пересчёт «Активности» под оконный оборот
        for r in rows:
            r["act"] = round(100 * r["amt"] / mam)
        top = sorted(rows, key=lambda r: (r["trades"], r["amt"]), reverse=True)[:n]
        with _WEEX_TR_LOCK:                                    # кормим сканер СТЕН (для СБОР-скора) топ-монетами
            _WEEX_TR_WANT["syms"] = [r["symbol"] for r in top[:12]]
            _WEEX_TR_WANT["ts"] = time.time()
    elif ex == "mexc":                   # число сделок MEXC из ОБЩЕГО WS-счётчика (_deal_metrics, как Ourbit) — ВСЕ монеты real-time
        now_ms = int(time.time() * 1000)
        cutoff = now_ms - int(win * 1000)     # win = окно в СЕКУНДАХ (win_sec)
        for r in rows:
            c, turn, delta = _mexc_deal_metrics(r["symbol"], cutoff)   # СВОЙ фид MEXC (включая эксклюзивы ANSEM/FARTCOIN)
            r["trades"] = c; r["vol"] = c
            r["amt"] = round(turn); r["dusd"] = round(delta)
            r["dpct"] = round(delta / turn * 100, 2) if turn else 0.0
            # СБОР-скор (стратегия Вики): жирный спред × прострелы(NATR) × свипы(всплеск),
            # гейт по АКТИВНОСТИ ленты (сделки/окно) — сток-токены с мелким оборотом, но частыми
            # сделками и жирным спредом = лучшие кандидаты на сбор (не режем по 24ч-обороту).
            _spr = min(1.0, r["spread"] / 0.10)       # спред(тик)% ≥ 0.10% = жирный тик
            _vol = min(1.0, r["natr"] / 1.8)          # NATR ≥ 1.8% = активные прострелы
            _vsp = min(1.0, r["vspike"] / 250.0)      # всплеск ×2.5 = свипы
            _gate = max(0.20, min(1.0, r["trades"] / 100.0))   # 100+ сделок/окно = полный вес; тихие ≥0.20
            r["scoll"] = round(min(100.0, (0.50 * _spr + 0.30 * _vol + 0.20 * _vsp) * _gate * 100))
        mam = max((r["amt"] for r in rows), default=1) or 1    # пересчёт «Активности» под оконный оборот
        for r in rows:
            r["act"] = round(100 * r["amt"] / mam)
        top = sorted(rows, key=lambda r: (r["trades"], r["amt"]), reverse=True)[:n]   # сортировка по сделкам (все монеты известны)
    return top



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


# ─────────── Счётчик СДЕЛОК MEXC (свой WS, contract.mexc.com/edge) — для MEXC-скринера ───────────
# MEXC-эксклюзивы (ANSEM/FARTCOIN/сток-токены) отсутствуют на Ourbit → нужен ОТДЕЛЬНЫЙ фид MEXC.
_MEXC_DEALS: dict = {}
_MEXC_DEALS_LOCK = threading.Lock()
MEXC_WS_URL = "wss://contract.mexc.com/edge"


def _mexc_deal_metrics(sym: str, cutoff_ms: int):
    """(кол-во сделок, оборот$, дельта$) MEXC за окно из своего WS-фида сделок."""
    with _MEXC_DEALS_LOCK:
        dq = _MEXC_DEALS.get(sym)
        if not dq:
            return (0, 0.0, 0.0)
        cnt = 0; turn = 0.0; delta = 0.0
        for e in reversed(dq):
            if e[0] >= cutoff_ms:
                cnt += 1; turn += e[1]; delta += e[2]
            else:
                break
    return (cnt, turn, delta)


def _mexc_deal_counter_ws():
    import asyncio
    try:
        import websockets
    except ImportError:
        return

    async def run():
        while True:
            try:
                if time.time() - _SCR_LAST[0] > 120:          # MEXC-скринер закрыт → не держим соединение
                    await asyncio.sleep(5); continue
                _mexc_instruments()
                csz = dict(_MEXC_INSTR.get("csize") or {})
                syms = list(csz.keys())
                if not syms:
                    await asyncio.sleep(3); continue
                async with websockets.connect(MEXC_WS_URL, open_timeout=15, ping_interval=20, ping_timeout=15, max_queue=None, **_ws_kw()) as ws:
                    for s in syms:
                        await ws.send(json.dumps({"method": "sub.deal", "param": {"symbol": s}}))
                        await asyncio.sleep(0.003)
                    print(f"[mexc-deals-ws] подписка на {len(syms)} монет MEXC — счётчик сделок для скринера")
                    while True:
                        if time.time() - _SCR_LAST[0] > 120:  # ушли со скринера → закрыть соединение (разгрузка)
                            break
                        msg = await asyncio.wait_for(ws.recv(), timeout=40)
                        d = json.loads(msg)
                        if d.get("channel") != "push.deal":
                            continue
                        sym = d.get("symbol")
                        data = d.get("data")
                        deals = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
                        for dt in deals:
                            t = dt.get("t") or d.get("ts")
                            if not (sym and t):
                                continue
                            try:
                                p = float(dt.get("p") or 0); v = float(dt.get("v") or 0); side = int(dt.get("T") or 1)
                            except (TypeError, ValueError):
                                p = v = 0.0; side = 1
                            notional = p * v * float(csz.get(sym, 1) or 1)
                            sign = notional if side == 1 else -notional
                            with _MEXC_DEALS_LOCK:
                                dq = _MEXC_DEALS.get(sym)
                                if dq is None:
                                    dq = _MEXC_DEALS[sym] = collections.deque(maxlen=6000)
                                dq.append((int(t), notional, sign))
            except Exception:
                await asyncio.sleep(4)

    asyncio.run(run())


# ─────────── Счётчик СДЕЛОК WEEX (свой WS, ws-contract.weex.com) — ВСЕ монеты для WEEX-скринера ───────────
_WEEX_DEALS: dict = {}
_WEEX_DEALS_LOCK = threading.Lock()


def _weex_deal_metrics(sym: str, cutoff_ms: int):
    """(кол-во сделок, оборот$, дельта$) WEEX за окно из своего WS-фида сделок (v уже в USD)."""
    with _WEEX_DEALS_LOCK:
        dq = _WEEX_DEALS.get(sym)
        if not dq:
            return (0, 0.0, 0.0)
        cnt = 0; turn = 0.0; delta = 0.0
        for e in reversed(dq):
            if e[0] >= cutoff_ms:
                cnt += 1; turn += e[1]; delta += e[2]
            else:
                break
    return (cnt, turn, delta)


def _weex_deal_counter_ws():
    import asyncio
    import json as J
    try:
        import websockets
    except ImportError:
        return

    async def run():
        while True:
            try:
                if time.time() - _SCR_LAST[0] > 120:          # WEEX-скринер закрыт → не держим соединение
                    await asyncio.sleep(5); continue
                bases = list(_weex_syms())
                if not bases:
                    await asyncio.sleep(3); continue
                streams = [b + "USDT@trade" for b in bases]
                async with websockets.connect("wss://ws-contract.weex.com/v3/ws/public", open_timeout=10, ping_interval=None) as ws:
                    for i in range(0, len(streams), 30):      # батчами (лимит params в одном сообщении)
                        await ws.send(J.dumps({"method": "SUBSCRIBE", "params": streams[i:i + 30], "id": 1}))
                        await asyncio.sleep(0.06)
                    print(f"[weex-deals-ws] подписка на {len(streams)} монет WEEX — счётчик сделок для скринера")
                    while True:
                        if time.time() - _SCR_LAST[0] > 120:  # ушли со скринера → закрыть
                            break
                        try:
                            m = await asyncio.wait_for(ws.recv(), timeout=15)
                        except asyncio.TimeoutError:
                            try: await ws.send(J.dumps({"method": "PONG", "id": 1}))
                            except Exception: pass
                            continue
                        try: d = J.loads(m)
                        except Exception: continue
                        if d.get("event") in ("ping", "pong") or d.get("type") == "ping":
                            try: await ws.send(J.dumps({"method": "PONG", "id": 1}))
                            except Exception: pass
                            continue
                        if str(d.get("e") or "").lower() != "trade":   # только живые сделки (не tradeSnapshot — не раздуваем окно)
                            continue
                        s = d.get("s") or ""
                        if not s.endswith("USDT"):
                            continue
                        sym = s[:-4] + "_USDT"
                        for t in (d.get("d") or []):
                            try:
                                T = int(t.get("T") or 0)
                                notional = float(t.get("v") or 0)     # v уже в USD (цена×кол-во)
                                side = 2 if str(t.get("m")).lower() == "true" else 1
                            except (TypeError, ValueError):
                                continue
                            if not T:
                                continue
                            sign = notional if side == 1 else -notional
                            with _WEEX_DEALS_LOCK:
                                dq = _WEEX_DEALS.get(sym)
                                if dq is None:
                                    dq = _WEEX_DEALS[sym] = collections.deque(maxlen=6000)
                                dq.append((T, notional, sign))
            except Exception:
                await asyncio.sleep(4)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run())


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
           "/classic.js": "application/javascript; charset=utf-8",
           "/screener.js": "application/javascript; charset=utf-8",
           "/mxdex.js": "application/javascript; charset=utf-8",
           "/tape.js": "application/javascript; charset=utf-8",
           "/watchlist.js": "application/javascript; charset=utf-8",
           "/finrez.js": "application/javascript; charset=utf-8",
           "/notifications.js": "application/javascript; charset=utf-8",
           "/dock.js": "application/javascript; charset=utf-8",
           "/theme.js": "application/javascript; charset=utf-8",
           "/tile.js": "application/javascript; charset=utf-8",
           "/bugreport.js": "application/javascript; charset=utf-8",
           "/autobot.js": "application/javascript; charset=utf-8",
           "/auth.js": "application/javascript; charset=utf-8",
           "/exlogos.js": "application/javascript; charset=utf-8",
           "/style.css": "text/css; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # постоянное соединение для SSE-потока

    def log_message(self, *a):
        pass

    # клиент закрыл соединение (перезагрузка/закрытие вкладки) в момент записи → НЕ шумим трейсбеком (WinError 10053 и т.п.)
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError, OSError):
            self.close_connection = True

    def finish(self):
        try:
            super().finish()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
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
        # ── ГЕЙТ ВХОДА: без успешного логина отдаём ТОЛЬКО страницу, статику и статус входа ──
        if _auth_required() and not _AUTH["ok"] and route not in ("/", "/index.html", "/favicon.ico", "/api/authstatus") and route not in _STATIC:
            self._json({"ok": False, "error": "нужен вход", "auth": False}, code=401); return
        try:
            if route in ("/", "/index.html"):
                self._file("index.html", "text/html; charset=utf-8")
            elif route == "/favicon.ico":
                self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers()   # нет иконки — 204, без 404
            elif route == "/api/authstatus":
                self._json({"ok": True, "authed": _AUTH["ok"], "login": _AUTH["login"], "required": _auth_required()})
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
            elif route == "/api/weexdepth":          # стакан WEEX (WS real-time, фолбэк REST)
                sym = (qs.get("symbol") or ["BTC_USDT"])[0]
                _WEEX_WS["want"] = sym                # сказать WS подписаться на этот символ
                book, wsym, wts = _weex_ws_book()
                if wsym == sym and book["bids"] and book["asks"] and (time.time() - wts) < 4:
                    self._json({"ok": True, "depth": {"symbol": sym, "bids": book["bids"], "asks": book["asks"], "ts": int(wts * 1000)},
                                "tick": _weex_tick(sym), "qprec": _weex_qprec(sym), "src": "ws"})
                else:
                    try:
                        self._json({"ok": True, "depth": _WEEX.depth(sym), "tick": _weex_tick(sym), "qprec": _weex_qprec(sym), "src": "rest"})
                    except Exception as exc:
                        self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexsyms":            # список монет WEEX (для ярлыков в поиске)
                self._json({"ok": True, "syms": _weex_syms()})
            elif route == "/api/weexaccount":         # позиции + баланс WEEX (для Финрез/маркеров)
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX"}); return
                try:
                    _, pos = _WEEX.positions()
                    _, bal = _WEEX.balance()
                    self._json({"ok": True, "positions": pos, "balance": bal})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weextrades":          # лента сделок WEEX (WS real-time, фолбэк REST)
                sym = (qs.get("symbol") or ["BTC_USDT"])[0]
                _WEEX_WS["want"] = sym
                with _WEEX_WS_LOCK:
                    live = list(_WEEX_WS["trades"]) if _WEEX_WS["sym"] == sym else []
                if live:
                    self._json({"ok": True, "ticks": live, "src": "ws"}); return
                try:
                    raw = _WEEX.trades(sym) or []
                    out = []
                    for t in (raw if isinstance(raw, list) else []):
                        # isBuyerMaker=true → покупатель мейкер → АГРЕССОР продавец → sell(2); иначе buy(1)
                        side = 2 if str(t.get("isBuyerMaker")).lower() == "true" else 1
                        out.append({"id": t.get("ticketId"), "t": int(t.get("time") or 0),
                                    "p": float(t.get("price") or 0), "v": float(t.get("size") or 0), "side": side})
                    self._json({"ok": True, "ticks": out})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/mexcdepth":           # стакан MEXC (REST-поллинг)
                sym = (qs.get("symbol") or ["BTC_USDT"])[0]
                try:
                    self._json({"ok": True, "depth": _mexc_depth(sym),
                                "tick": _mexc_tick(sym), "csize": _mexc_csize(sym), "src": "rest"})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/mexctrades":          # лента сделок MEXC (REST-поллинг)
                sym = (qs.get("symbol") or ["BTC_USDT"])[0]
                try:
                    self._json({"ok": True, "ticks": _mexc_deals(sym)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/mexcaccount":         # ПРИВАТНОЕ: позиции/ордера/баланс MEXC (для автобота-реала)
                if not _MEXC_TRADE["connected"]:
                    self._json({"ok": False, "error": "MEXC не подключён"}); return
                sym = (qs.get("symbol") or [""])[0]
                try:
                    avail, equity = _MEXCTR.balance()
                    self._json({"ok": True, "balance": avail, "equity": equity,
                                "positions": _MEXCTR.positions(sym), "orders": _MEXCTR.open_orders(sym),
                                "allpos": _MEXCTR.positions(None)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/flow":
                sym = (qs.get("symbol") or ["XAUT_USDT"])[0]
                _ACTIVE["symbol"] = sym; _want(sym)
                try:
                    fpmin = max(1, min(40, int((qs.get("fpmin") or ["3"])[0])))
                except (TypeError, ValueError):
                    fpmin = 3
                self._json({"ok": True, "flow": _flow_for(sym).snapshot(_tick_of(sym), fpmin)})
            elif route == "/api/gridseries":                     # серии цены монеты по многим биржам + справедливая MEXC (панель MEXC↔DEX)
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:24]
                exs = [e.strip().lower() for e in (qs.get("ex") or ["mexc,binance,bybit"])[0].split(",") if e.strip()][:12]
                want_fair = (qs.get("fair") or ["1"])[0] != "0"
                want_dex = (qs.get("dex") or ["0"])[0] == "1"
                self._json({"ok": True, "now": round(time.time(), 1),
                            "series": _grid_series(syms, exs, want_fair, want_dex)})
            elif route == "/api/gaptop":                         # авто-топ монет по максимальному расхождению цен между биржами
                exs = [e.strip().lower() for e in (qs.get("ex") or ["mexc,binance,bybit,gate,bitget"])[0].split(",") if e.strip()][:12]
                try:
                    n = max(1, min(60, int((qs.get("n") or ["20"])[0])))
                    minturn = float((qs.get("minturn") or ["50000"])[0])   # $ 24ч оборота — отсечь неликвид/мусор
                    maxgap = float((qs.get("maxgap") or ["400"])[0])       # % — потолок гэпа (выше = коллизия тикеров)
                except (TypeError, ValueError):
                    n, minturn, maxgap = 20, 50000.0, 400.0
                self._json({"ok": True, "rows": _gap_top(exs, n, minturn, maxgap)})
            elif route == "/api/classic/alerts":                 # КЛАССИКА: свежие алерты формаций (since=последний виденный id)
                if not _classic:
                    self._json({"ok": False, "error": "модуль classic не загружен"}); return
                try:
                    since = int((qs.get("since") or ["0"])[0])
                except (TypeError, ValueError):
                    since = 0
                self._json(_classic.alerts_since(since))
            elif route == "/api/classic/chart":                  # КЛАССИКА: свечи+уровни+наклонки монеты для графика
                if not _classic:
                    self._json({"ok": False, "error": "модуль classic не загружен"}); return
                self._json(_classic.chart((qs.get("symbol") or ["BTCUSDT"])[0], (qs.get("tf") or ["5m"])[0]))
            elif route == "/api/mxsyms":                         # список монет для поиска в ячейках панели MEXC↔DEX
                with _EX_SYMS_LOCK:
                    allsyms = set()
                    for _sy in _EX_SYMS.values():
                        allsyms |= _sy
                self._json({"ok": True, "syms": sorted(s.replace("_USDT", "") for s in allsyms)[:6000]})
            elif route == "/api/mxwhere":                        # на каких биржах есть монета (+ссылки) — бейджи под монетой
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:80]
                self._json({"ok": True, "where": _mx_where(syms)})
            elif route == "/api/dexmap":                         # ручной оверрайд контракта/пары DEX (как в THIEF)
                b = (qs.get("base") or [""])[0].strip().upper().replace("_USDT", "")
                ca = (qs.get("ca") or [""])[0].strip()
                chain = (qs.get("chain") or [""])[0].strip().lower()
                pair = (qs.get("pair") or [""])[0].strip()
                if b:
                    if pair and chain:
                        _DEX_MAP[b] = {"chain": chain, "pair": pair, "addr": ca}
                    elif ca:
                        _DEX_MAP.pop(b, None); _dex_resolve(b, ca=ca)   # резолв по контракту
                    _dex_save_map()
                self._json({"ok": True, "map": _DEX_MAP.get(b)})
            elif route == "/api/mxliq":                          # L: сколько $ можно зайти на MEXC до сдвига цены на pct%
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                try:
                    pct = float((qs.get("pct") or ["0.5"])[0])
                except (TypeError, ValueError):
                    pct = 0.5
                self._json({"ok": True, "liq": {s: _mx_liq(s, pct) for s in syms}})
            elif route == "/api/mxkline":                        # история цены MEXC (для окна 1ч/4ч)
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                try:
                    minutes = max(30, min(1440, int((qs.get("minutes") or ["240"])[0])))
                except (TypeError, ValueError):
                    minutes = 240
                self._json({"ok": True, "kline": {s: _mx_kline(s, minutes) for s in syms}})
            elif route == "/api/dexkline":                       # история цены DEX-пула (полная линия DEX)
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                try:
                    minutes = max(30, min(1440, int((qs.get("minutes") or ["240"])[0])))
                except (TypeError, ValueError):
                    minutes = 240
                self._json({"ok": True, "kline": {s: _dex_kline(s.replace("_USDT", ""), minutes) for s in syms}})
            elif route == "/api/dexohlc":                        # OHLC-свечи DEX-пула (свечной график) → [[t,o,h,l,c]]
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                try:
                    minutes = max(30, min(1440, int((qs.get("minutes") or ["240"])[0])))
                except (TypeError, ValueError):
                    minutes = 240
                self._json({"ok": True, "kline": {s: _dex_ohlc(s.replace("_USDT", ""), minutes) for s in syms}})
            elif route == "/api/dextrades":                      # ПОСВОПОВАЯ цена DEX (каждая сделка) → детальная линия
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                self._json({"ok": True, "trades": {s: _dex_trades(s.replace("_USDT", "")) for s in syms}})
            elif route == "/api/pxhist":                         # ПЛОТНАЯ посекундная история цен (MEXC/DEX/fair) для панели
                syms = [s.strip().upper() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()][:12]
                try:
                    sec = max(30, min(_PX_MAXLEN, int((qs.get("sec") or ["3600"])[0])))
                except (TypeError, ValueError):
                    sec = 3600
                self._json({"ok": True, "hist": _px_hist(syms, sec)})
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
        # ── ГЕЙТ ВХОДА: без успешного логина принимаем только сам логин ──
        if _auth_required() and not _AUTH["ok"] and route != "/api/login":
            self._json({"ok": False, "error": "нужен вход", "auth": False}, code=401); return
        try:
            if route == "/api/login":
                self._json(_do_login(b.get("login", ""), b.get("password", "")))
            elif route == "/api/logout":
                _AUTH.update({"ok": False, "login": None}); self._json({"ok": True})
            elif route == "/api/connect":
                self._json(_trade_connect(b.get("token", "")))
            elif route == "/api/exttoken":           # из Chrome-расширения: авто-подключение токеном с открытой страницы биржи
                self._json(_trade_connect(b.get("token", "")))
            elif route == "/api/arm":
                on = bool(b.get("on"))
                if on and not _TRADE["connected"]:
                    self._json({"ok": False, "error": "сначала подключись токеном"}); return
                _TRADE["armed"] = on                  # доступ уже под логином; торговля при ЛЮБОЙ комиссии (юзер: торгую везде)
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
            elif route == "/api/weexcreds":           # сохранить ключ WEEX (в weex.txt) + проверить баланс
                key = (b.get("key") or "").strip(); sec = (b.get("secret") or "").strip(); pas = (b.get("passphrase") or "").strip()
                if not (key and sec and pas):
                    self._json({"ok": False, "error": "нужны все 3: key, secret, passphrase"}); return
                try:
                    with open(os.path.join(HERE, "weex.txt"), "w", encoding="utf-8") as f:
                        f.write(key + "\n" + sec + "\n" + pas + "\n")
                    _WEEX.set_creds(key, sec, pas)
                    _, bal = _WEEX.balance()                       # тест авторизации
                    ok = isinstance(bal, list) or (isinstance(bal, dict) and not bal.get("errorCode") and bal.get("code") not in ("-1040", "-1041", "-1042"))
                    self._json({"ok": True, "tested": bool(ok), "balance": bal})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexorder":          # ── ТОРГОВЛЯ WEEX ──
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX (впиши key/secret/passphrase в weex.txt)"}); return
                try:
                    _t0 = time.time()
                    sc, resp = _WEEX.create_order(b.get("symbol", "BTC_USDT"), b.get("side", "BUY"),
                                                  b.get("positionSide", "BOTH"), b.get("otype", "MARKET"),
                                                  b.get("qty"), b.get("price"), b.get("tif", "GTC"))
                    ok = bool((isinstance(resp, dict) and (resp.get("success") or resp.get("orderId") or (resp.get("data") or {}).get("orderId"))) or sc == 200)
                    self._json({"ok": ok, "http": sc, "resp": resp, "srv_ms": round((time.time() - _t0) * 1000)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexclose":
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX"}); return
                try:
                    _t0 = time.time()
                    sc, resp = _WEEX.close_position(b.get("symbol", "BTC_USDT"), b.get("positionSide", "BOTH"))
                    self._json({"ok": bool((isinstance(resp, dict) and resp.get("success")) or sc == 200), "resp": resp, "srv_ms": round((time.time() - _t0) * 1000)})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexcancel":
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX"}); return
                try:
                    sc, resp = _WEEX.cancel(b.get("symbol", "BTC_USDT"), b.get("orderId"))
                    self._json({"ok": bool((isinstance(resp, dict) and resp.get("success")) or sc == 200), "resp": resp})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexcancelall":
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX"}); return
                try:
                    sc, resp = _WEEX.cancel_all(b.get("symbol", "BTC_USDT"))
                    self._json({"ok": bool((isinstance(resp, dict) and resp.get("success")) or sc == 200), "resp": resp})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/weexleverage":
                if not _WEEX.has_creds():
                    self._json({"ok": False, "error": "нет ключей WEEX"}); return
                try:
                    mt = "ISOLATED" if b.get("margin") == "isolated" else "CROSSED"
                    sc, resp = _WEEX.set_leverage(b.get("symbol", "BTC_USDT"), mt, int(b.get("leverage", 20)))
                    self._json({"ok": bool((isinstance(resp, dict) and resp.get("success")) or sc == 200), "resp": resp})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
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
            elif route == "/api/mexcconnect":       # подключить MEXC: API ключ+секрет (HMAC) ИЛИ веб-токен. Валидируем чтением баланса.
                key = (b.get("key") or "").strip(); sec = (b.get("secret") or "").strip(); tok = (b.get("token") or "").strip()
                if key and sec:
                    _MEXCTR.set_creds(key, sec)
                elif tok:
                    _MEXCTR.set_token(tok)
                else:
                    self._json({"ok": False, "error": "нужен API ключ+секрет или Web UID"}); return
                try:
                    avail, equity = _MEXCTR.balance()
                    _MEXC_TRADE["connected"] = True
                    threading.Thread(target=_MEXCTR.warm, daemon=True).start()
                    self._json({"ok": True, "balance": avail, "equity": equity, "mode": _MEXCTR.mode()})
                except Exception as exc:
                    _MEXC_TRADE["connected"] = False
                    self._json({"ok": False, "error": "MEXC не принял ключ: " + str(exc)})
            elif route == "/api/mexcorder":         # РЕАЛЬНЫЙ ордер MEXC (автобот). Согласие = подключён MEXC + бот в режиме РЕАЛ.
                if not _MEXC_TRADE["connected"]:
                    self._json({"ok": False, "error": "MEXC не подключён (вставь Web UID)"}); return
                try:
                    side = int(b.get("side")); otype = int(b.get("otype", 1)); vol = int(b.get("vol") or 0)
                    sym = b.get("symbol", "")
                    if vol <= 0 or vol > _MAX_VOL:
                        self._json({"ok": False, "error": f"vol вне лимита (1..{_MAX_VOL})"}); return
                    close_pid = None
                    if side in (2, 4):                # закрытие — нужен positionId (иначе откроет противоположную)
                        try: close_pid = int(b.get("positionId") or 0) or None
                        except (TypeError, ValueError): close_pid = None
                        if close_pid is None:
                            want_long = (side == 4)
                            try: poslist = _MEXCTR.positions(sym)
                            except Exception: poslist = []
                            match = next((p for p in poslist if (p.get("side") == 1) == want_long and p.get("id")), None)
                            if not match:
                                self._json({"ok": False, "error": "закрывать нечего: позиция не найдена"}); return
                            close_pid = match["id"]
                            if match.get("vol"): vol = min(vol, int(match["vol"]))
                    _t0 = time.time()
                    lev = min(int(b.get("leverage", 20)), _mexc_maxlev(sym))   # обрезать плечо до максимума контракта (VANRY=20) — иначе MEXC «leverage adjusted»
                    sc, resp = _MEXCTR.create(sym, side, otype, vol, b.get("price", 0), lev, position_id=close_pid)
                    if not (isinstance(resp, dict) and resp.get("success")):   # ЛОГ отказа MEXC (диагностика)
                        try:
                            with open(os.path.join(HERE, "mexc_order_log.txt"), "a", encoding="utf-8") as _lf:
                                _lf.write(f"{time.strftime('%H:%M:%S')} REJECT sym={sym} side={side} vol={vol} lev={lev} px={b.get('price')} resp={json.dumps(resp, ensure_ascii=False)}\n")
                        except Exception:
                            pass
                    self._json({"ok": bool(resp.get("success")), "http": sc, "resp": resp,
                                "srv_ms": round((time.time() - _t0) * 1000)})
                except Exception as exc:
                    try: pos = _MEXCTR.positions(b.get("symbol", ""))
                    except Exception: pos = []
                    self._json({"ok": False, "maybe_filled": True, "error": "СЕТЬ/ТАЙМАУТ: ордер мог исполниться", "positions": pos})
            elif route == "/api/mexccancel":
                if not _MEXC_TRADE["connected"]:
                    self._json({"ok": False, "error": "MEXC не подключён"}); return
                try:
                    sc, resp = _MEXCTR.cancel(b.get("id"))
                    self._json({"ok": bool(resp.get("success")), "resp": resp})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/mexccancelall":
                if not _MEXC_TRADE["connected"]:
                    self._json({"ok": False, "error": "MEXC не подключён"}); return
                sym = b.get("symbol", "")
                ids = b.get("ids") or []
                try:
                    if ids:
                        sc, resp = _MEXCTR.cancel_batch(ids)
                        killed = len(ids) if resp.get("success") else 0; failed = []
                    else:
                        killed, failed = _MEXCTR.cancel_all(sym)
                    self._json({"ok": True, "killed": killed, "failed": failed})
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)})
            elif route == "/api/classic/cfg":       # КЛАССИКА: настройки сканера (мин.объём, топ-N, шорты)
                if not _classic:
                    self._json({"ok": False, "error": "модуль classic не загружен"}); return
                self._json(_classic.set_cfg(b))
            elif route == "/api/autostop":          # тумблер: ставить ли биржевой SL/TP автоматически
                _TRADE["auto_stop"] = bool(b.get("on"))
                self._json({"ok": True, "auto_stop": _TRADE["auto_stop"]})
            elif route == "/api/bug":                # багрепорт из виджета → пересылаем на центральный сервер Вики
                text = (b.get("text") or "").strip()
                imgs = b.get("images") or []
                if not isinstance(imgs, list): imgs = []
                imgs = [i for i in imgs if isinstance(i, str) and i.startswith("data:image")][:4]
                if not text and not imgs:
                    self._json({"ok": False, "error": "пустой отчёт"}); return
                who = (_AUTH.get("login") or "")[:16]   # Вика видит КТО прислал баг — по логину вошедшего
                report = {"text": text[:4000], "images": imgs,
                          "symbol": (b.get("symbol") or "")[:40], "version": (b.get("version") or "")[:20],
                          "ua": (b.get("ua") or "")[:300], "who": who,
                          "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
                try:                                 # локальный бэкап на машине друга (без картинок — только след, чтобы факт не потерять)
                    with open(os.path.join(HERE, "bug_reports_local.jsonl"), "a", encoding="utf-8") as _bf:
                        _meta = {k: report[k] for k in ("text", "symbol", "version", "who", "ts")}
                        _meta["images"] = len(imgs)
                        _bf.write(json.dumps(_meta, ensure_ascii=False) + "\n")
                except Exception:
                    pass
                srv = _act_cfg("license_server.txt").rstrip("/")
                if not srv:
                    self._json({"ok": True, "local": True}); return
                try:
                    _rb = json.dumps(report).encode()
                    _rq = urllib.request.Request(srv + "/bug", data=_rb,
                                                 headers={"Content-Type": "application/json", "User-Agent": "term"})
                    _rr = json.loads(urllib.request.urlopen(_rq, timeout=15).read().decode())
                    self._json({"ok": bool(_rr.get("ok")), "resp": _rr})
                except Exception as exc:
                    self._json({"ok": False, "error": "сервер багов недоступен: " + str(exc)})
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
    threading.Thread(target=_wall_scanner, daemon=True, name="wall-scanner").start()
    threading.Thread(target=_weex_trades_scanner, daemon=True, name="weex-trades").start()
    threading.Thread(target=_weex_ws_runner, daemon=True, name="weex-ws").start()
    for _ex in _EX_ADAPTERS:
        threading.Thread(target=_ex_poll, args=(_ex,), daemon=True, name="scr-" + _ex).start()
    threading.Thread(target=_membership_sweep, daemon=True, name="ex-membership").start()
    threading.Thread(target=_mxfair_poll, daemon=True, name="mxfair").start()
    _dex_load_map()
    threading.Thread(target=_dex_poll, daemon=True, name="dex-onchain").start()
    threading.Thread(target=_dex_seed, daemon=True, name="dex-seed").start()      # авто-посев контрактов (лента наполняется сама)
    threading.Thread(target=_px_recorder, daemon=True, name="px-recorder").start()  # посекундный рекордер цен → плотная история панели
    threading.Thread(target=_px_dex_hot, daemon=True, name="px-dex-hot").start()     # частый опрос DEX для открытых монет → плотная DEX-линия
    threading.Thread(target=_autoconnect_ourbit, daemon=True, name="ourbit-autoconnect").start()   # подхватить сохранённый токен Ourbit
    threading.Thread(target=_fee_watchdog, daemon=True, name="fee-watchdog").start()
    threading.Thread(target=_conn_keepalive, daemon=True, name="conn-keepalive").start()
    threading.Thread(target=_deal_counter_ws, daemon=True, name="deals-ws").start()
    threading.Thread(target=_mexc_deal_counter_ws, daemon=True, name="mexc-deals-ws").start()
    threading.Thread(target=_weex_deal_counter_ws, daemon=True, name="weex-deals-ws").start()
    if _proxy:
        threading.Thread(target=_proxy.health_loop, daemon=True, name="proxy-health").start()
    if _classic:
        def _classic_fetch(url, timeout=15):     # Классика ходит через ту же proxy-aware сессию (обходит бан IP при прокси)
            r = _get(url, timeout=timeout)
            sc = getattr(r, "status_code", 200)
            if sc in (418, 429):
                try:
                    wait = int(r.headers.get("Retry-After") or 120)
                except (TypeError, ValueError):
                    wait = 120
                _BINANCE_BAN[0] = time.time() + min(max(wait, 60), 1800)
                _classic.set_ban(_BINANCE_BAN[0])
                raise RuntimeError("binance %s ban" % sc)
            return r.json()
        _classic.set_fetcher(_classic_fetch)
        threading.Thread(target=_classic.scanner, daemon=True, name="classic-scanner").start()
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
