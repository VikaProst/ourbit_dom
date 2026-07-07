"""Собрать ЧИСТЫЙ zip-пакет для друга (без твоих личных файлов), с ЕГО логином.

Кладёт на Рабочий стол: SQUAD-TERMINAL-для-друга.zip
Спрашивает логин+пароль для друга и кладёт их в users.txt внутри пакета — друг сразу заходит.
Исключает ВСЕ твои личные файлы: токен Ourbit, ключи WEEX, твои логины/пароли, секреты, серверные скрипты.
"""
import os, zipfile, secrets

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.expanduser("~"), "Desktop", "SQUAD-TERMINAL-для-друга.zip")

# что НЕ класть другу (личное/владельческое/серверное) — БЕЗ этого твои ключи/пароли утекут!
SKIP_FILES = {
    # личные ключи и доступы (НИКОГДА не отдавать)
    "ourbit.txt", "weex.txt", "users.txt", "users_log.txt", "license.txt",
    "admin_secret.txt", "keys_log.txt", "act_keys.json", "bindings.json", "proxies.json",
    # адрес автообновления у ВЛАДЕЛЬЦА выключен (чтобы Вика сама не тянула с GitHub) — другу НЕ копируем,
    # вместо него ниже пишем ПРАВИЛЬНЫЙ (иначе у друга автообновление мёртвое, старая версия навсегда)
    "update_url.txt",
    # владельческие/серверные инструменты
    "make_key.py", "make_user.py", "publish.py", "activation_server.py", "make_friend_package.py",
    "deploy.py", "_setup_login_squadbot.py",
    "make_key.py", "КАК-ВЫДАВАТЬ-КЛЮЧИ.md", "КАК-ВЫДАВАТЬ-ЛОГИН.md", "КАК-ПОДЕЛИТЬСЯ-И-ОБНОВЛЯТЬ.md",
    "ВЫДАТЬ-КЛЮЧ.bat", "ВЫДАТЬ-ЛОГИН.bat", "СОБРАТЬ-ПАКЕТ-ДРУГУ.bat", "ВЫКАТИТЬ-ОБНОВЛЕНИЕ.bat",
    "ОБНОВИТЬ-СЕРВЕР-ВХОДА.bat", "НАСТРОИТЬ-СЕРВЕР-ВХОДА.bat", "ОБНОВИТЬ-СЕРВЕР-БАГИ.bat", "ПОСМОТРЕТЬ-БАГИ.bat",
}
SKIP_EXT = {".log", ".bak", ".pyc"}
SKIP_DIRS = {".git", "__pycache__"}

# ── логин+пароль друга (попадёт в его users.txt) ──
login = (input("Логин для друга (Enter = drug1): ").strip() or "drug1")
pw = (input("Пароль (Enter = случайный): ").strip() or secrets.token_hex(4))
friend_users = ("# Твой вход в терминал (выдала Вика). НЕ меняй, если не просили.\n"
                "%s:%s\n" % (login, pw))

n = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f in SKIP_FILES or os.path.splitext(f)[1] in SKIP_EXT:
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, HERE)
            z.write(full, "ourbit_dom/" + rel)
            n += 1
    z.writestr("ourbit_dom/users.txt", friend_users)   # вход друга
    n += 1
    z.writestr("ourbit_dom/update_url.txt",             # ПРАВИЛЬНЫЙ адрес автообновления (у владельца выключен, другу нужен рабочий!)
               "https://raw.githubusercontent.com/VikaProst/ourbit_dom/main\n")
    n += 1

print("=" * 50)
print("ГОТОВО. Пакет:", OUT)
print("Файлов:", n)
print("-" * 50)
print("ЛОГИН другу:  %s" % login)
print("ПАРОЛЬ другу: %s" % pw)
print("=" * 50)
print("Отправь этот zip другу + скажи логин и пароль выше.")
print("Твои ключи/токены/пароли в пакет НЕ попали.")
