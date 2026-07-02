"""Генератор ключей активации (запускает ХОЗЯИН — Вика).

Каждый запуск = один новый ключ для одного друга:
  1. python make_key.py
  2. КЛЮЧ отдай другу (он вставит его в терминал при активации).
  3. ХЕШ добавь в keys.json в список "allowed" → Commit → Push (через GitHub Desktop).
Друг активируется этим ключом. Чтобы ОТОЗВАТЬ доступ — удали его хеш из keys.json и запушь.
"""
import secrets, hashlib, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
key = secrets.token_hex(8)                       # 16-символьный ключ
h = hashlib.sha256(key.encode()).hexdigest()

print("=" * 50)
print("КЛЮЧ (отдать другу):   ", key)
print("ХЕШ  (в keys.json):    ", h)
print("=" * 50)

# по желанию — сразу добавить хеш в keys.json
try:
    p = os.path.join(HERE, "keys.json")
    data = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"allowed": []}
    if h not in data.get("allowed", []):
        data.setdefault("allowed", []).append(h)
        json.dump(data, open(p, "w", encoding="utf-8"), indent=1)
        print("Хеш добавлен в keys.json. Осталось: Commit + Push в GitHub Desktop.")
except Exception as exc:
    print("keys.json не обновлён автоматически, добавь хеш вручную:", exc)
