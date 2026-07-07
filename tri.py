"""ТРЕУГОЛЬНИК: монитор треугольного арбитража на битке — фьючерсы MEXC (read-only).

Узлы: USDT — USDC — BTC (биток в центре). Три реальных перпа на одной бирже:
    BTC_USDT · BTC_USDC · USDC_USDT
Цикл A: USDT→BTC→USDC→USDT.   Цикл B: USDT→USDC→BTC→USDT (зеркало).
Край = когда BTC_USDC/BTC_USDT ≠ прямому курсу USDC_USDT.

Считаем по РЕАЛЬНЫМ bid/ask (на каждой ноге пересекаем спред) минус комиссии.
На MEXC maker=0% → в мониторе показываем и тейкер-сценарий (шмальнуть 3 маркета),
и «gross» (без комиссий = потолок для мейкер-исполнения лимитками).

ТОЛЬКО МОНИТОР: ордера НЕ шлёт. Даёт состояние во фронт через server.py /api/tri/state.
"""
import json
import threading
import time
import urllib.request
from collections import deque

FUT = "https://contract.mexc.com/api/v1"
BTC_USDT, BTC_USDC, USDC_USDT = "BTC_USDT", "BTC_USDC", "USDC_USDT"
SYMS = (BTC_USDT, BTC_USDC, USDC_USDT)

CFG = {"poll_sec": 4.0}
FEES = {BTC_USDT: 0.0002, BTC_USDC: 0.0002, USDC_USDT: 0.0004}  # taker, перепроверяем из API

_LOCK = threading.Lock()
_STATE = {
    "ok": False, "ts": 0.0, "err": "",
    "books": {}, "fees": dict(FEES),
    "gross_a": 0.0, "net_a": 0.0, "gross_b": 0.0, "net_b": 0.0,
    "best_net": 0.0, "best_dir": "-", "best_gross": 0.0,
    "usdc_spread_bps": 0.0, "windows": 0, "cycles": 0,
    "hist": [],  # последние N best_net (bps) для мини-графика
}
_HIST = deque(maxlen=120)


def _get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "squad-tri"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())


def _verify_fees():
    try:
        data = _get(f"{FUT}/contract/detail")
        arr = data.get("data") if isinstance(data, dict) else data
        for it in arr or []:
            if it.get("symbol") in FEES:
                FEES[it["symbol"]] = float(it.get("takerFeeRate", FEES[it["symbol"]]))
    except Exception:  # noqa: BLE001 — не критично, остаёмся на дефолтах
        pass


def _fetch_books():
    data = _get(f"{FUT}/contract/ticker")
    arr = data.get("data") if isinstance(data, dict) else data
    out = {}
    for d in arr or []:
        s = d.get("symbol")
        if s in SYMS and d.get("bid1") and d.get("ask1"):
            out[s] = (float(d["bid1"]), float(d["ask1"]))
    return out


def _cycle_a(books, use_fee):
    a_btcusdt = books[BTC_USDT][1]     # купить BTC по ask
    b_btcusdc = books[BTC_USDC][0]     # продать BTC по bid
    b_usdcusdt = books[USDC_USDT][0]   # продать USDC по bid
    f = FEES if use_fee else {s: 0.0 for s in SYMS}
    btc = (1.0 / a_btcusdt) * (1 - f[BTC_USDT])
    usdc = btc * b_btcusdc * (1 - f[BTC_USDC])
    usdt = usdc * b_usdcusdt * (1 - f[USDC_USDT])
    return (usdt - 1.0) * 10000


def _cycle_b(books, use_fee):
    a_usdcusdt = books[USDC_USDT][1]   # купить USDC по ask
    a_btcusdc = books[BTC_USDC][1]     # купить BTC по ask
    b_btcusdt = books[BTC_USDT][0]     # продать BTC по bid
    f = FEES if use_fee else {s: 0.0 for s in SYMS}
    usdc = (1.0 / a_usdcusdt) * (1 - f[USDC_USDT])
    btc = (usdc / a_btcusdc) * (1 - f[BTC_USDC])
    usdt = btc * b_btcusdt * (1 - f[BTC_USDT])
    return (usdt - 1.0) * 10000


def state():
    with _LOCK:
        s = dict(_STATE)
        s["hist"] = list(_HIST)
        return s


def set_cfg(body):
    try:
        v = float(body.get("poll_sec", CFG["poll_sec"]))
        CFG["poll_sec"] = max(2.0, min(30.0, v))
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "cfg": dict(CFG)}


def poller():
    """Фоновый цикл: тянет 3 стакана, считает край, копит статистику."""
    _verify_fees()
    windows = 0
    cycles = 0
    while True:
        try:
            books = _fetch_books()
            if len(books) < 3:
                time.sleep(CFG["poll_sec"])
                continue
            cycles += 1
            ga, na = _cycle_a(books, False), _cycle_a(books, True)
            gb, nb = _cycle_b(books, False), _cycle_b(books, True)
            best_net = max(na, nb)
            best_dir = "B" if nb >= na else "A"
            best_gross = gb if best_dir == "B" else ga
            if best_net > 0:
                windows += 1
            ub, ua = books[USDC_USDT]
            usdc_spread = (ua - ub) / ub * 10000
            _HIST.append(round(best_net, 2))
            with _LOCK:
                _STATE.update({
                    "ok": True, "ts": time.time(), "err": "",
                    "books": {k: {"bid": v[0], "ask": v[1]} for k, v in books.items()},
                    "fees": dict(FEES),
                    "gross_a": ga, "net_a": na, "gross_b": gb, "net_b": nb,
                    "best_net": best_net, "best_dir": best_dir, "best_gross": best_gross,
                    "usdc_spread_bps": usdc_spread, "windows": windows, "cycles": cycles,
                })
        except Exception as exc:  # noqa: BLE001 — монитор не должен падать
            with _LOCK:
                _STATE["err"] = repr(exc)[:200]
        time.sleep(CFG["poll_sec"])
