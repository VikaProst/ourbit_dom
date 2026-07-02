"""Собрать ЧИСТЫЙ zip-пакет для друга (без твоих личных файлов).

Кладёт на Рабочий стол: SQUAD-TERMINAL-для-друга.zip
Исключает: секрет активации, твой ключ, журнал ключей, прокси, серверные/владельческие скрипты, логи.
license.txt кладётся ПУСТЫМ шаблоном — друг впишет свой ключ.
"""
import os, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.expanduser("~"), "Desktop", "SQUAD-TERMINAL-для-друга.zip")

# что НЕ класть другу (личное/владельческое/серверное)
SKIP_FILES = {
    "admin_secret.txt", "keys_log.txt", "act_keys.json", "bindings.json", "proxies.json",
    "make_key.py", "publish.py", "activation_server.py", "make_friend_package.py",
    "КАК-ВЫДАВАТЬ-КЛЮЧИ.md", "КАК-ПОДЕЛИТЬСЯ-И-ОБНОВЛЯТЬ.md",
}
SKIP_EXT = {".log", ".bak", ".pyc"}
SKIP_DIRS = {".git", "__pycache__"}

n = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f in SKIP_FILES or os.path.splitext(f)[1] in SKIP_EXT:
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, HERE)
            if f == "license.txt":
                z.writestr("ourbit_dom/" + rel, "# Впиши сюда свой КЛЮЧ активации (одной строкой), который дала Вика.\n")
                n += 1
                continue
            z.write(full, "ourbit_dom/" + rel)
            n += 1

print(f"Готово: {OUT}")
print(f"Файлов в пакете: {n}")
print("Отправь этот zip другу. Внутри уже прописан адрес обновления и проверялки.")
