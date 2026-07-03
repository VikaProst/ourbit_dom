"""Заливка activation_server.py на сервер (запускается НА СЕРВЕРЕ из /tmp).
Сам находит запущенный activation_server.py (по процессу), делает бэкап, заменяет, перезапускает.
Вызывается из ОБНОВИТЬ-СЕРВЕР-БАГИ.bat: scp этого файла + act_new.py в /tmp, потом `python3 /tmp/deploy.py`.
"""
import os, subprocess, time, sys, urllib.request

NEW = "/tmp/act_new.py"

def sh(c):
    try:
        return subprocess.check_output(c, shell=True, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return ""

# 1) найти путь запущенного activation_server.py (надёжно — через /proc процесса)
pid = sh("pgrep -f activation_server.py | head -1")
target = ""
if pid:
    cwd = sh("readlink -f /proc/%s/cwd" % pid)
    try:
        parts = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
        arg = next((a.decode() for a in parts if a.endswith(b"activation_server.py")), "")
    except Exception:
        arg = ""
    if arg.startswith("/"):
        target = arg
    elif cwd and arg:
        target = os.path.join(cwd, os.path.basename(arg))

# 2) фолбэк — типовые пути
if not target or not os.path.isfile(target):
    for c in ["/root/ourbit_dom/activation_server.py",
              os.path.expanduser("~/ourbit_dom/activation_server.py"),
              os.path.expanduser("~/activation_server.py")]:
        if os.path.isfile(c):
            target = c; break

if not target or not os.path.isfile(target):
    print("[!] НЕ НАШЁЛ activation_server.py на сервере — путь неизвестен, ничего не менял."); sys.exit(1)

# 3) бэкап + замена
os.system("cp '%s' '%s.bak' 2>/dev/null" % (target, target))
os.system("cp '%s' '%s'" % (NEW, target))
print("обновлён файл:", target)

# 4) перезапуск: systemd-юнит (если есть), иначе kill+nohup
unit = sh("systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -i activ | awk '{print $1}' | head -1")
if unit:
    os.system("systemctl restart %s" % unit)
    print("перезапуск через systemd:", unit)
else:
    if pid:
        os.system("kill %s 2>/dev/null" % pid); time.sleep(1)
    os.system("cd '%s' && nohup python3 -u activation_server.py > act.log 2>&1 &" % os.path.dirname(target))
    print("перезапуск через nohup")

# 5) проверка здоровья
time.sleep(2)
try:
    h = urllib.request.urlopen("http://localhost:8790/health", timeout=5).read().decode()
    print("HEALTH:", h)
except Exception as e:
    print("[!] HEALTH не ответил:", e, "— проверь сервер вручную")
