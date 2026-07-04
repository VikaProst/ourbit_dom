"""Выдать/отозвать логин+пароль другу (запускает Вика). Меняет пользователей на сервере МГНОВЕННО.

  python make_user.py add Вася          → создаст логина "Вася" со случайным паролем
  python make_user.py add Вася 1234      → создаст/сменит пароль логина "Вася" на "1234"
  python make_user.py del Вася           → отозвать доступ (удалить логин)
  python make_user.py list               → показать все логины

Логин+пароль отдаёшь другу — он вписывает их в экране входа терминала. Записывается в
users_log.txt (кому какой логин/пароль). Пароли на сервере хранятся только как хеш.
"""
import secrets, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def _read(f):
    try:
        v = open(os.path.join(HERE, f), encoding="utf-8").read().strip()
        return v if not v.startswith("#") else ""
    except Exception:
        return ""


def _admin(payload):
    srv = _read("license_server.txt").rstrip("/")
    secret = _read("admin_secret.txt")
    if not srv:
        print("[!] license_server.txt не задан — не знаю адрес сервера входа."); return None
    if not secret:
        print("[!] admin_secret.txt пуст."); return None
    payload["secret"] = secret
    try:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(srv + "/admin", data=body, headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    except Exception as e:
        print("[!] Нет связи с сервером входа:", e); return None


arg = sys.argv[1] if len(sys.argv) > 1 else "help"

if arg == "list":
    r = _admin({"action": "listusers"})
    if r and r.get("ok"):
        users = r.get("users") or []
        print("Логинов на сервере:", len(users))
        for u in users:
            print("  •", u)
elif arg == "del":
    if len(sys.argv) < 3:
        print("укажи логин: python make_user.py del ЛОГИН")
    else:
        login = sys.argv[2].strip()
        r = _admin({"action": "deluser", "login": login})
        if r and r.get("ok"):
            print("Отозван логин «%s». Осталось логинов: %s" % (login, r.get("count")))
elif arg == "add":
    if len(sys.argv) < 3:
        print("укажи логин: python make_user.py add ЛОГИН [ПАРОЛЬ]"); sys.exit(0)
    login = sys.argv[2].strip()
    pw = sys.argv[3].strip() if len(sys.argv) > 3 else secrets.token_hex(4)   # нет пароля → случайный
    r = _admin({"action": "adduser", "login": login, "password": pw})
    if r and r.get("ok"):
        print("=" * 50)
        print("ЛОГИН:  %s" % login)
        print("ПАРОЛЬ: %s" % pw)
        print("=" * 50)
        print("Отдай другу эти логин и пароль — он вводит их в терминале.")
        print("Всего логинов на сервере:", r.get("count"))
        try:                                     # локальный журнал (кому что) — не публикуется
            with open(os.path.join(HERE, "users_log.txt"), "a", encoding="utf-8") as f:
                f.write("логин=%s\tпароль=%s\n" % (login, pw))
            print("(записано в users_log.txt — там видно кому какой логин/пароль)")
        except Exception:
            pass
    else:
        print("[!] Не добавлен. Проверь что сервер входа развёрнут (ОБНОВИТЬ-СЕРВЕР-ВХОДА.bat).")
else:
    print(__doc__)
