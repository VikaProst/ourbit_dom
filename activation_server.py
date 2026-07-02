"""Сервер активации «1 ключ = 1 IP» (на премиум-сервере Вики, всегда включён).

Ключи хранятся ПРЯМО ЗДЕСЬ (act_keys.json) и добавляются мгновенно через админ-API
(make_key.py у Вики). Никакого GitHub-кэша. IP-привязка: ключ намертво к первому IP.

Файлы рядом со скриптом:
  admin_secret.txt  — секрет для админ-API (задаётся при деплое, НЕ публикуется)
  act_keys.json     — {"allowed":[sha256...]}  (растёт через админ-API)
  bindings.json     — {sha256: ip}

Эндпоинты:
  GET  /health                         → статус
  POST /activate  {key}                → проверка+привязка к IP (это дёргает терминал друга)
  POST /admin {secret, action, hash}   → add | del | list  (это дёргает make_key.py у Вики)

Запуск: python3 -u activation_server.py   (порт 8790, держать через systemd)
"""
import json, os, hashlib, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8790
HERE = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(HERE, "act_keys.json")
BIND_FILE = os.path.join(HERE, "bindings.json")
SECRET_FILE = os.path.join(HERE, "admin_secret.txt")
_LOCK = threading.Lock()


def _load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def _save(path, obj):
    try:
        json.dump(obj, open(path, "w", encoding="utf-8"), indent=1)
    except Exception:
        pass


def _secret():
    try:
        return open(SECRET_FILE, encoding="utf-8").read().strip()
    except Exception:
        return ""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    def _ip(self):
        xff = self.headers.get("X-Forwarded-For")
        return xff.split(",")[0].strip() if xff else self.client_address[0]

    def do_GET(self):
        if self.path.startswith("/health"):
            allowed = _load(KEYS_FILE, {"allowed": []}).get("allowed") or []
            self._json({"ok": True, "keys": len(allowed), "bound": len(_load(BIND_FILE, {}))})
        else:
            self._json({"ok": False}, 404)

    def do_POST(self):
        if self.path.startswith("/activate"):
            self._activate()
        elif self.path.startswith("/admin"):
            self._admin()
        else:
            self._json({"ok": False}, 404)

    def _activate(self):
        key = (self._body().get("key") or "").strip()
        if not key:
            self._json({"ok": False, "reason": "нет ключа"}); return
        h = hashlib.sha256(key.encode()).hexdigest()
        with _LOCK:
            allowed = set(_load(KEYS_FILE, {"allowed": []}).get("allowed") or [])
            if h not in allowed:
                self._json({"ok": False, "reason": "ключ недействителен или отозван"}); return
            binds = _load(BIND_FILE, {})
            ip = self._ip()
            cur = binds.get(h)
            if cur is None:
                binds[h] = ip; _save(BIND_FILE, binds)
                self._json({"ok": True, "ip": ip, "bound": "new"})
            elif cur == ip:
                self._json({"ok": True, "ip": ip, "bound": "same"})
            else:
                self._json({"ok": False, "reason": "ключ уже привязан к другому IP (" + cur + ")"})

    def _admin(self):
        b = self._body()
        if not _secret() or b.get("secret") != _secret():
            self._json({"ok": False, "reason": "неверный админ-секрет"}, 403); return
        act = b.get("action")
        with _LOCK:
            data = _load(KEYS_FILE, {"allowed": []})
            allowed = data.get("allowed") or []
            if act == "list":
                self._json({"ok": True, "allowed": allowed, "bound": _load(BIND_FILE, {})}); return
            h = (b.get("hash") or "").strip()
            if not h:
                self._json({"ok": False, "reason": "нет hash"}); return
            if act == "add":
                if h not in allowed: allowed.append(h)
                data["allowed"] = allowed; _save(KEYS_FILE, data)
                self._json({"ok": True, "count": len(allowed)})
            elif act == "del":
                allowed = [x for x in allowed if x != h]; data["allowed"] = allowed; _save(KEYS_FILE, data)
                binds = _load(BIND_FILE, {}); binds.pop(h, None); _save(BIND_FILE, binds)   # снять и IP-привязку
                self._json({"ok": True, "count": len(allowed)})
            else:
                self._json({"ok": False, "reason": "action: add|del|list"})


if __name__ == "__main__":
    print(f"Activation server :{PORT} — ключи в act_keys.json, админ через /admin")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
