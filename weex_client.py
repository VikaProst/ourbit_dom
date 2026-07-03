"""WEEX Contract (фьючерсы) — клиент: стакан/лента (публично, v2) + торговля (v3, HMAC-подпись).

Данные стакана: GET /capi/v2/market/depth?symbol=cmt_btcusdt  (публично, без ключа).
Торговля v3: /capi/v3/... с заголовками ACCESS-KEY / ACCESS-SIGN / ACCESS-TIMESTAMP / ACCESS-PASSPHRASE.
Подпись: base64( HMAC_SHA256(secret, ts + METHOD + path + query + body) ), ts в мс.
Ключ/секрет/passphrase — из weex.txt (3 строки), НАРУЖУ не уходят (только на api-contract.weex.com).
"""
import hmac
import hashlib
import base64
import time
import json
import threading

try:
    from curl_cffi import requests as _http
    _SESS = _http.Session(impersonate="chrome120")
except Exception:                       # фолбэк без curl_cffi
    import requests as _http
    _SESS = _http.Session()

BASE = "https://api-contract.weex.com"


def to_v2(sym: str) -> str:
    """BTC_USDT -> cmt_btcusdt (для публичных v2 рыночных данных)."""
    c = sym.replace("_USDT", "").replace("_usdt", "").replace("_", "").lower()
    return "cmt_" + c + "usdt"


def to_v3(sym: str) -> str:
    """BTC_USDT -> BTCUSDT (для v3 торговли)."""
    return sym.replace("_", "").upper()


class WeexClient:
    def __init__(self):
        self.key = ""
        self.secret = ""
        self.passphrase = ""
        self._lock = threading.Lock()

    def set_creds(self, key, secret, passphrase):
        self.key = (key or "").strip()
        self.secret = (secret or "").strip()
        self.passphrase = (passphrase or "").strip()

    def has_creds(self) -> bool:
        return bool(self.key and self.secret and self.passphrase)

    # ── ПУБЛИЧНОЕ: стакан / лента / контракты ──
    def depth(self, symbol: str) -> dict:
        s = to_v2(symbol)
        r = _SESS.get(f"{BASE}/capi/v2/market/depth?symbol={s}", timeout=8)
        d = r.json() or {}
        bids = [[float(p), float(v)] for p, v in (d.get("bids") or [])]
        asks = [[float(p), float(v)] for p, v in (d.get("asks") or [])]
        return {"symbol": symbol, "bids": bids, "asks": asks, "ts": int(time.time() * 1000)}

    def trades(self, symbol: str):
        s = to_v2(symbol)
        return _SESS.get(f"{BASE}/capi/v2/market/trades?symbol={s}", timeout=8).json()

    def exchange_info(self, symbol=None):
        p = "?symbol=" + to_v3(symbol) if symbol else ""
        return _SESS.get(f"{BASE}/capi/v3/market/exchangeInfo{p}", timeout=10).json()

    # ── ПОДПИСЬ v3 ──
    def _sign(self, method, path, query="", body=""):
        ts = str(int(time.time() * 1000))
        prehash = ts + method.upper() + path + query + body
        sig = base64.b64encode(
            hmac.new(self.secret.encode(), prehash.encode(), hashlib.sha256).digest()
        ).decode()
        return ts, sig

    def _priv(self, method, path, params=None, body_obj=None):
        query = ""
        if params:
            query = "?" + "&".join(f"{k}={params[k]}" for k in params)
        body = "" if body_obj is None else json.dumps(body_obj, separators=(",", ":"))
        ts, sig = self._sign(method, path, query, body)
        hdr = {"ACCESS-KEY": self.key, "ACCESS-SIGN": sig, "ACCESS-TIMESTAMP": ts,
               "ACCESS-PASSPHRASE": self.passphrase, "Content-Type": "application/json"}
        url = BASE + path + query
        with self._lock:
            if method == "GET":
                r = _SESS.get(url, headers=hdr, timeout=10)
            elif method == "DELETE":
                r = _SESS.delete(url, headers=hdr, data=body, timeout=10)
            else:
                r = _SESS.post(url, headers=hdr, data=body, timeout=10)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, {"raw": r.text}

    # ── ТОРГОВЛЯ v3 ──
    # side: BUY/SELL ; position_side: LONG/SHORT (hedge) или BOTH (one-way)
    # открыть лонг=BUY+LONG, закрыть лонг=SELL+LONG, открыть шорт=SELL+SHORT, закрыть шорт=BUY+SHORT
    def create_order(self, symbol, side, position_side, otype, qty, price=None, tif="GTC", coid=None):
        body = {"symbol": to_v3(symbol), "side": side, "positionSide": position_side,
                "type": otype, "quantity": str(qty),
                "newClientOrderId": coid or ("t" + str(int(time.time() * 1000)))}
        if otype == "LIMIT":
            body["price"] = str(price)
            body["timeInForce"] = tif
        return self._priv("POST", "/capi/v3/order", body_obj=body)

    def close_position(self, symbol, position_side):
        return self._priv("POST", "/capi/v3/closePosition",
                          body_obj={"symbol": to_v3(symbol), "positionSide": position_side})

    def cancel(self, symbol, order_id):
        return self._priv("DELETE", "/capi/v3/order",
                          body_obj={"symbol": to_v3(symbol), "orderId": order_id})

    def cancel_all(self, symbol):
        return self._priv("DELETE", "/capi/v3/allOpenOrders",
                          body_obj={"symbol": to_v3(symbol)})

    def open_orders(self, symbol=None):
        p = {"symbol": to_v3(symbol)} if symbol else None
        return self._priv("GET", "/capi/v3/openOrders", params=p)

    def positions(self):
        return self._priv("GET", "/capi/v3/account/position/allPosition")

    def balance(self):
        return self._priv("GET", "/capi/v3/account/balance")

    def set_leverage(self, symbol, margin_type, lev):
        body = {"symbol": to_v3(symbol), "marginType": margin_type}
        if margin_type == "ISOLATED":
            body["isolatedLongLeverage"] = str(lev)
            body["isolatedShortLeverage"] = str(lev)
        else:
            body["crossLeverage"] = str(lev)
        return self._priv("POST", "/capi/v3/account/leverage", body_obj=body)

    def set_margin_mode(self, symbol, margin_type, separated_type):
        # margin_type: CROSSED/ISOLATED ; separated_type: COMBINED(one-way)/SEPARATED(hedge)
        return self._priv("POST", "/capi/v3/account/marginType",
                          body_obj={"symbol": to_v3(symbol), "marginType": margin_type,
                                    "separatedType": separated_type})


_WEEX = WeexClient()
