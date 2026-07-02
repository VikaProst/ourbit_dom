"""Сервер активации «1 ключ = 1 IP» (запускается на ПРЕМИУМ-сервере Вики, всегда включён).

Логика:
  - разрешённые ключи берёт как sha256-хеши из keys.json твоего GitHub (сам обновляет раз в 60с);
  - при активации привязывает хеш ключа к IP того, кто первым им воспользовался;
  - дальше пускает ТОЛЬКО с того же IP; с чужого IP — отказ.
Управление ключами — через GitHub (make_key.py → keys.json → Commit/Push). Тут ничего править не надо.
Сброс привязки (если друг сменил IP) — удалить строку из bindings.json и перезапустить, ИЛИ ключ отозвать в keys.json.

Запуск на сервере:  python3 -u activation_server.py
Порт 8790. Держать через systemd/screen, чтобы был всегда.
"""
import json, os, time, hashlib, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen, Request

PORT = 8790
KEYS_URL = "https://raw.githubusercontent.com/VikaProst/ourbit_dom/main/keys.json"
HERE = os.path.dirname(os.path.abspath(__file__))
BIND_FILE = os.path.join(HERE, "bindings.json")

_ALLOWED = set()          # sha256-хеши разрешённых ключей (из GitHub)
_BIND = {}                # hash -> ip
_LOCK = threading.Lock()


def _load_bindings():
    global _BIND
    try:
        _BIND = json.load(open(BIND_FILE, encoding="utf-8"))
    except Exception:
        _BIND = {}


def _save_bindings():
    try:
        json.dump(_BIND, open(BIND_FILE, "w", encoding="utf-8"), indent=1)
    except Exception:
        pass


def _refresh_keys():
    global _ALLOWED
    while True:
        try:
            raw = urlopen(Request(KEYS_URL, headers={"User-Agent": "act"}), timeout=8).read()
            _ALLOWED = set(json.loads(raw).get("allowed") or [])
        except Exception:
            pass
        time.sleep(60)


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

    def _ip(self):
        # реальный IP клиента (учитываем прокси/же CDN, если фронт стоит)
        xff = self.headers.get("X-Forwarded-For")
        return (xff.split(",")[0].strip() if xff else self.client_address[0])

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json({"ok": True, "keys": len(_ALLOWED), "bound": len(_BIND)})
        else:
            self._json({"ok": False}, 404)

    def do_POST(self):
        if not self.path.startswith("/activate"):
            self._json({"ok": False}, 404); return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            body = {}
        key = (body.get("key") or "").strip()
        if not key:
            self._json({"ok": False, "reason": "нет ключа"}); return
        h = hashlib.sha256(key.encode()).hexdigest()
        if h not in _ALLOWED:
            self._json({"ok": False, "reason": "ключ недействителен или отозван"}); return
        ip = self._ip()
        with _LOCK:
            bound = _BIND.get(h)
            if bound is None:
                _BIND[h] = ip; _save_bindings()
                self._json({"ok": True, "ip": ip, "bound": "new"})
            elif bound == ip:
                self._json({"ok": True, "ip": ip, "bound": "same"})
            else:
                self._json({"ok": False, "reason": "ключ уже привязан к другому IP (" + bound + ")"})


if __name__ == "__main__":
    _load_bindings()
    threading.Thread(target=_refresh_keys, daemon=True).start()
    print(f"Activation server на :{PORT} — keys из {KEYS_URL}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
