"""Установщик сервера входа на squadbot (45.89.219.102). Запускает Вика через
НАСТРОИТЬ-СЕРВЕР-ВХОДА.bat. Копирует activation_server.py, ставит systemd-сервис,
открывает порт 8790, регистрирует логин Вики. Пароль сервера вводится ВИДИМО."""
import os, sys, json, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
IP = "45.89.219.102"
PORT = 8790
VIKA_LOGIN = "vika"
VIKA_PW = "fd0a7b23"

try:
    import paramiko
except ImportError:
    print("Ставлю библиотеку paramiko..."); os.system(sys.executable + " -m pip install --quiet paramiko")
    import paramiko

print("=" * 56)
print("  НАСТРОЙКА СЕРВЕРА ВХОДА на squadbot (" + IP + ")")
print("=" * 56)
pw = input("Пароль сервера (виден при вводе), потом Enter: ").strip()
if not pw:
    print("Пустой пароль — выход."); sys.exit(1)

c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    c.connect(IP, username="root", password=pw, timeout=15, allow_agent=False, look_for_keys=False)
except paramiko.AuthenticationException:
    print("\n[!] Пароль не подошёл. Запусти файл заново и введи верный пароль."); sys.exit(1)
except Exception as e:
    print("\n[!] Не удалось подключиться:", e); sys.exit(1)
print("Вошёл на сервер, устанавливаю...")


def run(cmd):
    _i, o, e = c.exec_command(cmd, timeout=60)
    return o.read().decode(errors="replace"), e.read().decode(errors="replace")


sftp = c.open_sftp()
run("mkdir -p /root/ourbit_dom")
sftp.put(os.path.join(HERE, "activation_server.py"), "/root/ourbit_dom/activation_server.py")
sec = open(os.path.join(HERE, "admin_secret.txt"), encoding="utf-8").read().strip()
with sftp.open("/root/ourbit_dom/admin_secret.txt", "w") as f:
    f.write(sec)
unit = ("[Unit]\nDescription=SQUAD login server\nAfter=network.target\n"
        "[Service]\nWorkingDirectory=/root/ourbit_dom\n"
        "ExecStart=/usr/bin/python3 -u /root/ourbit_dom/activation_server.py\nRestart=always\n"
        "[Install]\nWantedBy=multi-user.target\n")
with sftp.open("/etc/systemd/system/loginserver.service", "w") as f:
    f.write(unit)
sftp.close()
run("systemctl daemon-reload && systemctl enable --now loginserver")
o, _ = run("ufw status 2>/dev/null | head -1")
if o.startswith("Status: active"):
    run("ufw allow 8790/tcp")
time.sleep(2)
o, _ = run("systemctl is-active loginserver")
h, _ = run("curl -s http://localhost:8790/health || echo NOHEALTH")
print("Сервис:", o.strip(), "| health:", h.strip())
c.close()

# зарегистрировать логин Вики через публичный admin-API
print("Регистрирую твой логин...")
try:
    b = json.dumps({"secret": sec, "action": "adduser", "login": VIKA_LOGIN, "password": VIKA_PW}).encode()
    req = urllib.request.Request("http://%s:%d/admin" % (IP, PORT), data=b, headers={"Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=12).read().decode())
    print("Логин 'vika':", "добавлен OK" if r.get("ok") else r)
except Exception as e:
    print("[!] Не смог зарегистрировать логин удалённо:", e)
    print("    (сервер поставлен; логин добавь потом: python make_user.py add vika " + VIKA_PW + ")")

print("=" * 56)
print("ГОТОВО.")
print("  ЛОГИН:  " + VIKA_LOGIN)
print("  ПАРОЛЬ: " + VIKA_PW)
print("Теперь закрой чёрное окно терминала и запусти start.bat заново,")
print("потом на экране входа введи логин и пароль.")
print("=" * 56)
