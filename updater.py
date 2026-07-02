"""Авто-обновление терминала: перед запуском тянет свежие файлы с UPDATE_URL.

URL берётся из файла update_url.txt (одна строка). Если файла нет / нет связи —
тихо работаем на текущей версии (офлайн-безопасно). Проверяем sha256 каждого файла,
качаем только изменённые. Обновления применяются ПРИ ЗАПУСКЕ (не в середине торговли).
"""
import os, json, hashlib, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# файлы, которые НЕ трогаем при обновлении (личные настройки/данные друга)
SKIP = {"update_url.txt", "proxies.json", "manifest.json", "srv.out.log", "srv.err.log",
        "start.bat", "license.txt"}   # start.bat НЕ трогаем (запускается сам себя — перезапись рвёт кодировку); license.txt личный


def _url():
    f = os.path.join(HERE, "update_url.txt")
    if not os.path.exists(f):
        return None
    u = open(f, encoding="utf-8").read().strip()
    return u.rstrip("/") if (u and not u.startswith("#")) else None


def _get(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "squad-updater"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def main():
    base = _url()
    if not base:
        print("[update] update_url.txt не задан — пропускаю авто-обновление")
        return
    try:
        man = json.loads(_get(base + "/manifest.json").decode("utf-8"))
    except Exception:
        print("[update] нет связи с сервером обновлений — работаю на текущей версии")
        return
    changed = 0
    for rel, sha in (man.get("files") or {}).items():
        if rel in SKIP:
            continue
        dst = os.path.join(HERE, rel.replace("/", os.sep))
        cur = hashlib.sha256(open(dst, "rb").read()).hexdigest() if os.path.exists(dst) else None
        if cur == sha:
            continue
        try:
            data = _get(base + "/" + rel)
            if hashlib.sha256(data).hexdigest() != sha:
                print("[update] хеш не совпал, пропуск:", rel); continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as fh:
                fh.write(data)
            changed += 1
            print("[update] обновлён:", rel)
        except Exception as exc:
            print("[update] не скачался:", rel, exc)
    print(f"[update] готово: обновлено {changed} файлов, версия {man.get('version', '?')}")


if __name__ == "__main__":
    main()
