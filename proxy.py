"""Пул прокси для Ourbit-терминала.

REST (curl_cffi) — через proxies=; WS (websockets) — best-effort (если версия поддерживает proxy=).
Режимы: off (прямое) / sticky (первый живой) / rotate (по кругу) / on_error (сменить при ошибке).
Health-check в фоне: латентность + IP/гео (ip-api), пометка мёртвых, failover на живой.
Список хранится в proxies.json, редактируется из UI (/api/proxy/*).

Формат прокси-URL: http://user:pass@host:port  |  socks5://user:pass@host:port
"""
from __future__ import annotations
import json, os, time, threading

HERE = os.path.dirname(os.path.abspath(__file__))
PFILE = os.path.join(HERE, "proxies.json")
_LOCK = threading.Lock()
_STATE = {"list": [], "mode": "off", "rr": 0, "ws": False}   # mode: off/sticky/rotate/on_error; ws=прокси и для WS


def _load():
    try:
        with open(PFILE, encoding="utf-8") as f:
            d = json.load(f)
        _STATE["list"] = d.get("list", [])
        _STATE["mode"] = d.get("mode", "off")
        _STATE["ws"] = d.get("ws", False)
    except Exception:
        pass


def _save():
    try:
        with open(PFILE, "w", encoding="utf-8") as f:
            json.dump({"list": _STATE["list"], "mode": _STATE["mode"], "ws": _STATE["ws"]}, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def set_ws(on):
    with _LOCK:
        _STATE["ws"] = bool(on); _save()


def status():
    with _LOCK:
        return {"mode": _STATE["mode"], "ws": _STATE["ws"], "list": [dict(p) for p in _STATE["list"]]}


def list_proxies():
    with _LOCK:
        return [dict(p) for p in _STATE["list"]]


def get_mode():
    with _LOCK:
        return _STATE["mode"]


def set_mode(m):
    with _LOCK:
        if m in ("off", "sticky", "rotate", "on_error"):
            _STATE["mode"] = m; _save()


def add_proxy(url):
    url = (url or "").strip()
    if not url:
        return None
    if "://" not in url:
        url = "http://" + url
    with _LOCK:
        pid = str(int(time.time() * 1000))
        _STATE["list"].append({"id": pid, "url": url, "enabled": True, "dead": False,
                               "latency": 0, "ip": "", "geo": "", "err": "", "checked": 0})
        _save()
        return pid


def remove_proxy(pid):
    with _LOCK:
        _STATE["list"] = [p for p in _STATE["list"] if p["id"] != pid]; _save()


def toggle_proxy(pid, en):
    with _LOCK:
        for p in _STATE["list"]:
            if p["id"] == pid:
                p["enabled"] = bool(en)
        _save()


def _alive():
    return [p for p in _STATE["list"] if p.get("enabled") and not p.get("dead")]


def active_url():
    """URL активного прокси по режиму, либо None (прямое соединение)."""
    with _LOCK:
        mode = _STATE["mode"]
        if mode == "off":
            return None
        al = _alive()
        if not al:
            return None
        if mode == "rotate":
            _STATE["rr"] = (_STATE["rr"] + 1) % len(al)
            return al[_STATE["rr"]]["url"]
        return al[0]["url"]           # sticky / on_error → первый живой


def proxies_dict():
    """dict для curl_cffi (proxies=...), либо None."""
    u = active_url()
    return {"http": u, "https": u} if u else None


def ws_url():
    """URL прокси для WS (best-effort), только если включён флаг ws; иначе None (WS напрямую)."""
    with _LOCK:
        if not _STATE["ws"]:
            return None
    return active_url()


def mark_dead(url, err=""):
    if not url:
        return
    with _LOCK:
        for p in _STATE["list"]:
            if p["url"] == url:
                p["dead"] = True; p["err"] = (err or "dead")[:80]


def test_one(url, timeout=8):
    """Тест прокси: латентность + IP/гео (ip-api). Возвращает dict."""
    try:
        from curl_cffi import requests as R
    except ImportError:
        import requests as R
    t0 = time.time()
    try:
        r = R.get("http://ip-api.com/json", proxies={"http": url, "https": url}, timeout=timeout)
        j = r.json()
        lat = int((time.time() - t0) * 1000)
        return {"ok": True, "latency": lat, "ip": j.get("query", ""),
                "geo": (j.get("countryCode", "") + " " + j.get("city", "")).strip(), "err": ""}
    except Exception as e:
        return {"ok": False, "latency": 0, "ip": "", "geo": "", "err": str(e)[:90]}


def test_proxy(pid):
    with _LOCK:
        p = next((x for x in _STATE["list"] if x["id"] == pid), None)
    if not p:
        return {"ok": False, "err": "нет прокси"}
    res = test_one(p["url"])
    with _LOCK:
        for x in _STATE["list"]:
            if x["id"] == pid:
                x.update({"dead": not res["ok"], "latency": res["latency"], "ip": res["ip"],
                          "geo": res["geo"], "err": res["err"], "checked": int(time.time())})
        _save()
    return res


def health_loop():
    """Фоновый health-check: периодически тестит включённые прокси, метит мёртвых/живых."""
    while True:
        for p in list_proxies():
            if not p.get("enabled"):
                continue
            res = test_one(p["url"])
            with _LOCK:
                for x in _STATE["list"]:
                    if x["id"] == p["id"]:
                        x.update({"dead": not res["ok"], "latency": res["latency"], "ip": res["ip"],
                                  "geo": res["geo"], "err": res["err"], "checked": int(time.time())})
            _save()
            time.sleep(1)          # не спамить ip-api
        time.sleep(45)


_load()
