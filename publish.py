"""Публикация обновления друзьям: генерит manifest.json (список файлов + sha256).

ЗАПУСКАЕТ ХОЗЯИН (Вика), когда пофиксили баг:
  1. python publish.py           → создаст manifest.json
  2. залить manifest.json + изменённые файлы на UPDATE_URL
     (или: git add -A && git commit -m fix && git push  — если хостинг на GitHub)
У друзей start.bat при следующем запуске сам подтянет свежие файлы.
"""
import os, json, hashlib, time

HERE = os.path.dirname(os.path.abspath(__file__))
INCLUDE = [
    "app.js", "trade.js", "chart.js", "classic.js", "tri.js", "screener.js", "mxdex.js", "tape.js", "watchlist.js", "finrez.js",
    "notifications.js", "theme.js", "tile.js", "dock.js", "bugreport.js", "autobot.js", "auth.js", "exlogos.js", "index.html", "style.css",
    "server.py", "classic.py", "tri.py", "ob_client.py", "weex_client.py", "mexc_client.py", "proxy.py", "updater.py", "license_server.txt", "keys.json",
    "chrome-extension/manifest.json", "chrome-extension/popup.html", "chrome-extension/popup.js",
]

files = {}
for rel in INCLUDE:
    p = os.path.join(HERE, rel.replace("/", os.sep))
    if os.path.exists(p):
        with open(p, "rb") as fh:
            data = fh.read().replace(b"\r\n", b"\n")   # LF-нормализация: git хранит/GitHub отдаёт LF → хеш считаем по LF, иначе updater у друга «не совпал хеш» и пропускает файл
            files[rel] = hashlib.sha256(data).hexdigest()

man = {"version": time.strftime("%Y%m%d-%H%M"), "files": files}
with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(man, fh, indent=1, ensure_ascii=False)

print(f"manifest.json создан: {len(files)} файлов, версия {man['version']}")
print("Теперь залей manifest.json + изменённые файлы на UPDATE_URL (или git push).")
