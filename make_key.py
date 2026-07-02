"""Выдать ключ активации другу (запускает Вика). Добавляет ключ на сервер МГНОВЕННО.

  python make_key.py            → новый ключ + сразу добавлен на проверялку
  python make_key.py list       → показать сколько ключей и их IP-привязки
  python make_key.py del ХЕШ    → отозвать ключ по хешу (снимает и IP-привязку)

Ключ отдаёшь другу — он вписывает его в свой license.txt.
"""
import secrets, hashlib, json, os, sys, urllib.request

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
        print("[!] license_server.txt не задан — не знаю адрес проверялки."); return None
    if not secret:
        print("[!] admin_secret.txt пуст."); return None
    payload["secret"] = secret
    try:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(srv + "/admin", data=body, headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    except Exception as e:
        print("[!] Нет связи с сервером активации:", e); return None


arg = sys.argv[1] if len(sys.argv) > 1 else "new"

if arg == "list":
    r = _admin({"action": "list"})
    if r and r.get("ok"):
        print("Ключей на сервере:", len(r.get("allowed") or []))
        print("IP-привязки:", json.dumps(r.get("bound") or {}, ensure_ascii=False, indent=1))
elif arg == "del":
    if len(sys.argv) < 3:
        print("укажи хеш: python make_key.py del ХЕШ")
    else:
        r = _admin({"action": "del", "hash": sys.argv[2].strip()})
        if r and r.get("ok"):
            print("Отозван. Осталось ключей:", r.get("count"))
else:
    name = arg if arg != "new" else "друг"       # python make_key.py Вася  → подпишет ключ именем
    key = secrets.token_hex(8)
    h = hashlib.sha256(key.encode()).hexdigest()
    print("=" * 50)
    print("КЛЮЧ для «%s» (отдать другу): %s" % (name, key))
    print("=" * 50)
    r = _admin({"action": "add", "hash": h})
    if r and r.get("ok"):
        print("✓ Ключ добавлен на проверялку. Всего ключей:", r.get("count"))
        print("Друг вписывает этот ключ в свой license.txt — и активируется.")
        try:                                     # локальный журнал (кому какой ключ) — не публикуется
            with open(os.path.join(HERE, "keys_log.txt"), "a", encoding="utf-8") as f:
                f.write(f"{name}\tключ={key}\tхеш={h}\n")
            print("(записано в keys_log.txt — там видно кому какой ключ/хеш)")
        except Exception:
            pass
    else:
        print("[!] Ключ НЕ добавлен на сервер (см. ошибку выше). Проверь что проверялка развёрнута.")
