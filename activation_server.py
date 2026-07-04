"""Сервер входа по логину+паролю (на премиум-сервере Вики, всегда включён).

Пользователи (логин→хеш пароля) хранятся ПРЯМО ЗДЕСЬ (users.json) и добавляются
мгновенно через админ-API (make_user.py у Вики). Вика выдаёт каждому свой логин+пароль
и может отозвать доступ в любой момент. Пароли хранятся ТОЛЬКО как sha256-хеш.

Файлы рядом со скриптом:
  admin_secret.txt  — секрет для админ-API (задаётся при деплое, НЕ публикуется)
  users.json        — {"users": {"логин": "sha256(пароль)"}}  (растёт через админ-API)
  act_keys.json     — СТАРАЯ система ключей (оставлена для совместимости, терминал её больше не дёргает)
  bindings.json     — СТАРАЯ IP-привязка ключей

Эндпоинты:
  GET  /health                              → статус
  POST /login  {login, password}            → проверка логина+пароля (это дёргает терминал друга)
  POST /admin {secret, action, ...}         → adduser | deluser | listusers  (это дёргает make_user.py у Вики)
                                              (+ старые add|del|list по ключам — для совместимости)
  POST /activate {key}                      → СТАРАЯ проверка ключа по IP (терминал больше не зовёт)

Запуск: python3 -u activation_server.py   (порт 8790, держать через systemd)
"""
import json, os, hashlib, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8790
HERE = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(HERE, "act_keys.json")
BIND_FILE = os.path.join(HERE, "bindings.json")
USERS_FILE = os.path.join(HERE, "users.json")         # {"users": {"логин": "sha256(пароль)"}}
SECRET_FILE = os.path.join(HERE, "admin_secret.txt")
BUGS_FILE = os.path.join(HERE, "bug_reports.jsonl")   # багрепорты друзей (по строке JSON на отчёт, с картинками)
# ХОЗЯЙСКИЕ КЛЮЧИ (Вика) — без ограничения по IP: пускают с ЛЮБОГО IP (все её машины). Только sha256-хеши (не сам ключ).
OWNER_HASHES = {"92d54c611e825dcc42b2108e046fd563a66da5e4b007490e3d5ff9eef8901c74"}
# АДМИН-IP (машины Вики): активация проходит ВСЕГДА — без ключа и без привязки. Друзьям это правило не касается.
ADMIN_IPS = {"213.139.11.65", "82.208.115.8"}
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
        if n > 12_000_000:      # защита от гигантских POST (баги с фото сжаты, 4 картинки ≈ 1-2 МБ)
            try: self.rfile.read(n)
            except Exception: pass
            return {}
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    def _html(self, body, code=200):
        page = ("<!doctype html><meta charset=utf-8><title>Баги SQUAD TERMINAL</title>"
                "<style>body{background:#0d1117;color:#dfe5ee;font:14px Arial,Helvetica,sans-serif;margin:0;padding:18px}"
                "h1{font-size:19px;margin:0 0 16px}"
                ".b{background:#161b22;border:1px solid #2c3444;border-radius:10px;padding:12px 14px;margin:0 0 14px;max-width:840px}"
                ".m{color:#8994a6;font-size:12px;margin-bottom:6px}"
                ".t{white-space:pre-wrap;font-size:14px;line-height:1.5}"
                ".imgs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}"
                ".imgs img{max-width:250px;max-height:200px;border-radius:8px;border:1px solid #2c3444;cursor:zoom-in}"
                ".empty{color:#8994a6}</style>") + body
        data = page.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _ip(self):
        xff = self.headers.get("X-Forwarded-For")
        return xff.split(",")[0].strip() if xff else self.client_address[0]

    def do_GET(self):
        if self.path.startswith("/health"):
            users = _load(USERS_FILE, {"users": {}}).get("users") or {}
            allowed = _load(KEYS_FILE, {"allowed": []}).get("allowed") or []
            self._json({"ok": True, "users": len(users), "keys": len(allowed), "bound": len(_load(BIND_FILE, {}))})
        elif self.path.startswith("/bugs"):
            self._bugs_view()
        else:
            self._json({"ok": False}, 404)

    def do_POST(self):
        if self.path.startswith("/login"):
            self._login()
        elif self.path.startswith("/activate"):
            self._activate()
        elif self.path.startswith("/admin"):
            self._admin()
        elif self.path.startswith("/bug"):
            self._bug()
        else:
            self._json({"ok": False}, 404)

    def _login(self):
        """Проверка логина+пароля друга. Пароль сверяем по sha256-хешу из users.json."""
        b = self._body()
        login = (b.get("login") or "").strip()
        pw = b.get("password") or ""
        if not login or not pw:
            self._json({"ok": False, "reason": "нужны логин и пароль"}); return
        users = _load(USERS_FILE, {"users": {}}).get("users") or {}
        h = hashlib.sha256(pw.encode()).hexdigest()
        if users.get(login) == h:
            self._json({"ok": True, "login": login})
        else:
            self._json({"ok": False, "reason": "неверный логин или пароль"})

    def _bug(self):
        b = self._body()
        text = (b.get("text") or "").strip()
        imgs = b.get("images") or []
        if not isinstance(imgs, list):
            imgs = []
        imgs = [i for i in imgs if isinstance(i, str) and i.startswith("data:image")][:4]
        if not text and not imgs:
            self._json({"ok": False, "reason": "пустой отчёт"}); return
        rec = {"text": text[:4000], "images": imgs,
               "symbol": (b.get("symbol") or "")[:40], "version": (b.get("version") or "")[:20],
               "ua": (b.get("ua") or "")[:300], "who": (b.get("who") or "")[:16],
               "ip": self._ip(), "ts": (b.get("ts") or "")[:32]}
        with _LOCK:
            try:
                with open(BUGS_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except Exception as e:
                self._json({"ok": False, "reason": str(e)}); return
        self._json({"ok": True})

    def _bugs_view(self):
        import html as _h
        from urllib.parse import urlparse, parse_qs
        sec = (parse_qs(urlparse(self.path).query).get("secret") or [""])[0]
        if not _secret() or sec != _secret():
            self._html("<h1>🔒 Доступ закрыт</h1><p class=empty>Добавь к адресу <b>?secret=ТВОЙ_АДМИН_СЕКРЕТ</b> "
                       "(тот же, что в admin_secret.txt).</p>", 403); return
        recs = []
        try:
            for line in open(BUGS_FILE, encoding="utf-8"):
                line = line.strip()
                if line:
                    try: recs.append(json.loads(line))
                    except Exception: pass
        except Exception:
            pass
        recs = recs[-500:][::-1]        # последние 500, новые сверху
        parts = ["<h1>🐞 Баги от друзей — {} шт.</h1>".format(len(recs))]
        if not recs:
            parts.append("<p class=empty>Пока пусто — багрепортов не приходило.</p>")
        for r in recs:
            meta = " · ".join(x for x in [
                r.get("ts", ""),
                ("от " + r.get("who", "")) if r.get("who") else "",
                r.get("symbol", ""),
                ("v" + r.get("version", "")) if r.get("version") else "",
                ("ip " + r.get("ip", "")) if r.get("ip") else "",
            ] if x)
            imgs = "".join('<img src="{}" onclick="window.open(this.src)">'.format(i)
                           for i in (r.get("images") or []))
            parts.append('<div class="b"><div class="m">{}</div><div class="t">{}</div>{}</div>'.format(
                _h.escape(meta), _h.escape(r.get("text", "") or "(без текста)"),
                ('<div class="imgs">' + imgs + '</div>') if imgs else ""))
        self._html("".join(parts))

    def _activate(self):
        if self._ip() in ADMIN_IPS:                            # админ-машина Вики → активация всегда ок (без ключа/без привязки)
            self._json({"ok": True, "ip": self._ip(), "bound": "admin"}); return
        key = (self._body().get("key") or "").strip()
        if not key:
            self._json({"ok": False, "reason": "нет ключа"}); return
        h = hashlib.sha256(key.encode()).hexdigest()
        with _LOCK:
            allowed = set(_load(KEYS_FILE, {"allowed": []}).get("allowed") or [])
            if h not in allowed:
                self._json({"ok": False, "reason": "ключ недействителен или отозван"}); return
            if h in OWNER_HASHES:                                  # хозяйский ключ — пускаем с любого IP (все машины Вики)
                self._json({"ok": True, "ip": self._ip(), "bound": "owner"}); return
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
            # ── управление ПОЛЬЗОВАТЕЛЯМИ (логин+пароль) — новая система ──
            if act in ("adduser", "deluser", "listusers"):
                udata = _load(USERS_FILE, {"users": {}})
                users = udata.get("users") or {}
                if act == "listusers":
                    self._json({"ok": True, "users": sorted(users.keys())}); return
                login = (b.get("login") or "").strip()
                if not login:
                    self._json({"ok": False, "reason": "нет login"}); return
                if act == "adduser":
                    pw = b.get("password") or ""
                    if not pw:
                        self._json({"ok": False, "reason": "нет password"}); return
                    users[login] = hashlib.sha256(pw.encode()).hexdigest()   # перезапись = смена пароля
                    udata["users"] = users; _save(USERS_FILE, udata)
                    self._json({"ok": True, "count": len(users)}); return
                if act == "deluser":
                    users.pop(login, None); udata["users"] = users; _save(USERS_FILE, udata)
                    self._json({"ok": True, "count": len(users)}); return
            # ── СТАРАЯ система по ключам (совместимость) ──
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
                self._json({"ok": False, "reason": "action: adduser|deluser|listusers (или старые add|del|list)"})


if __name__ == "__main__":
    print(f"Login server :{PORT} — пользователи в users.json, вход через /login, админ через /admin")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
