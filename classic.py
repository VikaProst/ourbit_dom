"""КЛАССИКА: сканер формаций ТС Вики на Binance Futures, 5-минутки.

Ищет по свечам: пробой уровня (базовый / через наторговку / с локалки / каскада / через
наклонку), пробой наклонки (по ЗАКРЫТИЮ свечи, 3+ касания), боковик-пробой, закол
уровня с возвратом. Для каждого сигнала считает ТВХ / СТОП (0.2-0.3% от уровня) / ТЕЙК
(следующий уровень или +3%) и зону 1-5 (где цена в диапазоне) — как на схемах ТС.

Данные: публичный API Binance Futures (без ключа). Монеты: топ по 24ч обороту,
фильтр активности = средний оборот 5м-свечи >= cfg.min5mvol (по умолчанию $70 000).
"""
import json, math, threading, time, urllib.error, urllib.request
from collections import deque

FAPI = "https://fapi.binance.com"

# ── конфиг (правится из UI через /api/classic/cfg) ──
CFG = {
    "min24hvol": 70_000.0,  # мин. ОБЪЁМ ЗА 24 ЧАСА, USDT (фильтр «активные монеты»)
    "topn": 250,            # потолок числа монет для сканирования (после фильтра по 24ч объёму)
    "tfs": ["1m", "5m", "15m", "30m"],   # таймфреймы сканирования (как в сделках Вики)
    "scan_sec": 60,         # период прохода сканера, сек
    "tol": 0.0025,          # допуск касания уровня (0.25%)
    "brk": 0.0012,          # запас пробоя: закрытие выше уровня на 0.12%
    "shorts": True,         # искать и шорт-формации (дамп)
    "vol_spike": 1.8,       # объём пробойной свечи ≥ N× медианы (всплеск = подтверждение)
    "natr_min": 0.5,        # мин. NATR(14), % — отсекаем «мёртвые» монеты без движения
    "rel_vol_min": 1.4,     # «в игре»: относит.объём (новые деньги) ≥ N× фона, иначе мёртвый актив
    "min_grade": "УРОВЕНЬ", # слать сигналы не слабее: ХАЙ / УРОВЕНЬ / СЕТАП (ТС: ХАЙ=слабо, не шлём)
    "top_movers": True,     # сканировать ТОЛЬКО топ роста/падения дня (по |24ч изменению|) — правило Вики
    "btc_context": True,    # треугольник (ТС5/6) валиден только если BTC в ту же сторону (правило ТС)
}
_GRADE_RANK = {"ХАЙ": 0, "УРОВЕНЬ": 1, "СЕТАП": 2}
_TF_SEC = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800}

_ALERTS = deque(maxlen=150)          # свежие алерты (id растёт)
_ALERT_ID = [0]
_SEEN: dict = {}                     # (sym, dir, lvl_round) -> ts антидубль (1 алерт на пробой)
_SEEN_TTL = 4 * 3600
_LOCK = threading.Lock()
_STATE = {"symbols": 0, "scanned": 0, "last_sweep": 0.0, "err": ""}
_CHART_CACHE: dict = {}              # sym -> (ts, payload) для /api/classic/chart


_BAN_UNTIL = [0.0]                   # бан Binance (418/429): не дёргаем API до этого времени
_FETCH = [None]                      # внешний загрузчик (server.py: curl_cffi + прокси); None → urllib напрямую


def set_ban(until_ts: float):
    """Внешняя синхронизация бана (server.py при 418 в THIEF-поллере — общий IP)."""
    if until_ts > _BAN_UNTIL[0]:
        _BAN_UNTIL[0] = until_ts


def set_fetcher(fn):
    """server.py передаёт свой proxy-aware загрузчик fn(url, timeout)->parsed json (кидает при 418)."""
    _FETCH[0] = fn


def _get(url: str, timeout: int = 15):
    if time.time() < _BAN_UNTIL[0]:
        raise RuntimeError("бан Binance до %s" % time.strftime("%H:%M:%S", time.localtime(_BAN_UNTIL[0])))
    if _FETCH[0]:                    # через прокси-сессию терминала (обходит бан IP, если задан прокси)
        return _FETCH[0](url, timeout)
    req = urllib.request.Request(url, headers={"User-Agent": "squad-classic"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (418, 429):     # лимиты: Binance говорит сколько ждать (Retry-After)
            try:
                wait = int(e.headers.get("Retry-After") or 120)
            except (TypeError, ValueError):
                wait = 120
            _BAN_UNTIL[0] = time.time() + min(max(wait, 60), 1800)
        raise


def _top_symbols() -> list:
    """Кандидаты Binance: объём24ч ≥ min24hvol, и (правило Вики) ТОП РОСТА/ПАДЕНИЯ дня по |24ч изменению|."""
    tick = _get(FAPI + "/fapi/v1/ticker/24hr", timeout=20)
    floor = float(CFG["min24hvol"])
    rows = []
    for t in tick:
        s = t.get("symbol") if isinstance(t, dict) else None
        if not s or not s.endswith("USDT"):
            continue
        qv = float(t.get("quoteVolume") or 0.0)
        if qv < floor:
            continue
        chg = abs(float(t.get("priceChangePercent") or 0.0))   # |изменение за 24ч|, % (рост ИЛИ падение)
        rows.append((s, qv, chg))
    if CFG.get("top_movers", True):
        rows.sort(key=lambda x: -x[2])            # топ движения дня — «монета в игре / новые деньги»
    else:
        rows.sort(key=lambda x: -x[1])            # иначе просто топ по обороту
    return [s for s, _, _ in rows[: int(CFG["topn"])]]


def _klines(sym: str, interval: str = "5m", limit: int = 180) -> list:
    """Свечи ТФ → [[t,o,h,l,c,qvol]] только ЗАКРЫТЫЕ (последняя формирующаяся отброшена)."""
    d = _get(FAPI + f"/fapi/v1/klines?symbol={sym}&interval={interval}&limit={limit}")
    bars = [[int(k[0] // 1000), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[7])]
            for k in d if isinstance(k, list) and len(k) >= 8]
    tfsec = _TF_SEC.get(interval, 300)
    if bars and bars[-1][0] + tfsec > time.time():
        bars = bars[:-1]                       # формации ТОЛЬКО по закрытию свечи (правило ТС)
    return bars


def _natr(bars: list, period: int = 14) -> float:
    """NATR(14) в % = ATR / цена × 100 — как индикатор на графиках Вики (живость движения)."""
    if len(bars) < period + 1:
        return 0.0
    trs = []
    for i in range(len(bars) - period, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    atr = sum(trs) / period
    price = bars[-1][4]
    return atr / price * 100.0 if price else 0.0


def _vol_spike(bars: list, mult: float) -> bool:
    """Пробойная свеча на ВСПЛЕСКЕ объёма: объём последней ≥ mult × медианы 20 предыдущих."""
    if len(bars) < 22:
        return False
    prev = sorted(b[5] for b in bars[-21:-1])
    med = prev[len(prev) // 2] if prev else 0.0
    return med > 0 and bars[-1][5] >= med * mult


# ── МЕТОДОЛОГИЯ ТАЙП: монета «в игре», консолидация, импульс, градация сетапа ──
def _rel_vol(bars: list, recent: int = 10, base: int = 40) -> float:
    """«Новые деньги»: относительный объём = ср.объём последних 10 свечей / медиана базовых 40.
    >1.5 = в монету вошли деньги (IN PLAY), а не мёртвый актив."""
    if len(bars) < recent + base + 2:
        return 1.0
    r = sum(b[5] for b in bars[-recent:]) / recent
    older = sorted(b[5] for b in bars[-(recent + base):-recent])
    med = older[len(older) // 2] if older else 0.0
    return r / med if med > 0 else 1.0


def _consolidation(bars: list, lvl: float, natr: float, n: int = 8) -> tuple:
    """Зажатие/накопление у уровня ПЕРЕД пробоем (правило ТС: «ждём консолидацию и действуем»).
    n свечей до пробойной образуют узкий диапазон, прижатый к уровню. Порог ширины ~ по NATR."""
    if len(bars) < n + 2 or lvl <= 0:
        return (False, 1.0)
    win = bars[-(n + 1):-1]
    hi = max(b[2] for b in win); lo = min(b[3] for b in win)
    rng = (hi - lo) / lvl
    cons_max = max(0.012, natr / 100.0 * 2.5)              # волатильная монета → консолидация шире
    near = sum(1 for b in win if abs(b[4] - lvl) / lvl < cons_max) >= n * 0.55
    return (rng < cons_max * 1.6 and near, rng)


def _impulse_before(bars: list, n_cons: int = 8, n_imp: int = 12) -> bool:
    """Был ИМПУЛЬС на объёме до консолидации («всё начинается с объёма», приор). Ход ≥ ~2×NATR."""
    if len(bars) < n_cons + n_imp + 2:
        return False
    seg = bars[-(n_cons + n_imp):-n_cons]
    if not seg or seg[0][1] <= 0:
        return False
    mv = abs(seg[-1][4] - seg[0][1]) / seg[0][1]
    base = sorted(b[5] for b in bars[-(n_cons + n_imp + 20):-(n_cons + n_imp)]) if len(bars) > n_cons + n_imp + 22 else []
    bmed = base[len(base) // 2] if base else 0.0
    vseg = sum(b[5] for b in seg) / len(seg)
    return mv > 0.02 and (bmed == 0 or vseg > bmed * 1.3)  # заметный ход + объём выше фона


def _grade(bars: list, lvl: float, natr: float, touches: int) -> tuple:
    """Градация ТС: ХАЙ (слабо) / УРОВЕНЬ (2+ касания+реакция) / СЕТАП (уровень+консолидация+импульс)."""
    cons, rng = _consolidation(bars, lvl, natr)
    imp = _impulse_before(bars)
    if cons and imp and touches >= 2:
        return ("СЕТАП", cons)
    if touches >= 2 and (cons or imp):
        return ("УРОВЕНЬ", cons)
    return ("ХАЙ", cons)


# ── КЛАССИФИКАЦИЯ по 6 стратегиям ТАЙП (ТС №1-6): формация + контекст → strat ──
def _prior_move(bars: list, lookback: int = 45, upto: int = 8) -> float:
    """Ход цены ДО последних `upto` свечей — контекст (был ли большой тренд/падение до формации)."""
    if len(bars) < lookback:
        seg = bars[:-upto] if len(bars) > upto + 3 else bars
    else:
        seg = bars[-lookback:-upto]
    if len(seg) < 5 or seg[0][1] <= 0:
        return 0.0
    return (seg[-1][4] - seg[0][1]) / seg[0][1]


def _classify_long(bars: list, relv: float) -> str:
    """ТС1 Global Long (аномальный объём + крупный прежний рост = ступени) vs ТС2 Local Long (локальный)."""
    prior = _prior_move(bars)
    if relv >= 3.0 and prior > 0.10:            # деньги вошли сильно + уже большой ход = глобальный тренд
        return "ТС№1 Global Long"
    return "ТС№2 Local Long"


def _uptrend_pump(bars: list, look: int = 40) -> bool:
    """Контекст ПАМПА (для «Трендовая памп пробой»): сильный рост + цена держится У ХАЁВ (не откатилась).
    Ступени: рост→поджатие→рост. Пробой вверх на таком фоне = продолжение пампа."""
    if len(bars) < look + 5:
        return False
    lo = min(b[3] for b in bars[-look:-12])     # низ ДО текущего поджатия
    hi_recent = max(b[2] for b in bars[-look:])
    if lo <= 0:
        return False
    rise = (hi_recent - lo) / lo                 # насколько выросли
    near_top = bars[-1][4] > hi_recent * 0.97    # цена у хаёв (поджатие под вершиной, не глубокий откат)
    return rise > 0.06 and near_top              # ощутимый памп + держимся вверху


def _hook_target(bars: list, lvl: float) -> float:
    """ТС4 Hook: после ЗАТЯЖНОГО ПАДЕНИЯ пробой вверх. Цель = 25% амплитуды падения (правило ТС). 0=не крючок."""
    if len(bars) < 60:
        return 0.0
    earlier_hi = max(b[2] for b in bars[-60:-18])
    recent_lo = min(b[3] for b in bars[-22:])
    if earlier_hi <= 0:
        return 0.0
    drop = (earlier_hi - recent_lo) / earlier_hi
    if drop < 0.06 or lvl < recent_lo * 0.999:  # нужно заметное падение и уровень у дна
        return 0.0
    return lvl * (1 + drop * 0.25)              # тейк = четверть падения (технический отскок)


def _triangle(lines: list, bars: list) -> dict:
    """Треугольник = верхняя НИСХОДЯЩАЯ (по хаям) + нижняя ВОСХОДЯЩАЯ (по лоям), сходятся. None если нет."""
    downs = [t for t in lines if t["down"] and t["touches"] >= 3]
    ups = [t for t in lines if not t["down"] and t["touches"] >= 3]
    if not downs or not ups:
        return None
    u, l = downs[0], ups[0]                     # верхняя и нижняя границы
    i = len(bars) - 1
    vu = u["p1"] + u["slope"] * (i - u["i1"])   # верхняя граница сейчас
    vl = l["p1"] + l["slope"] * (i - l["i1"])   # нижняя граница сейчас
    if vu <= vl:                                 # уже сошлись/перехлест — не треугольник
        return None
    return {"up": u, "lo": l, "vu": vu, "vl": vl}


def _false_breakout(bars: list, lvl: float, long: bool, look: int = 6) -> bool:
    """Ложный вынос ПЕРЕД пробоем (усилитель уверенности ТС5/6): недавно прокололи В ДРУГУЮ сторону и вернулись."""
    if len(bars) < look + 2:
        return False
    win = bars[-(look + 1):-1]
    if long:                                     # перед лонг-пробоем был ложный слом ВНИЗ
        return any(b[3] < lvl * 0.997 and b[4] > lvl * 0.999 for b in win)
    return any(b[2] > lvl * 1.003 and b[4] < lvl * 1.001 for b in win)  # перед шорт был закол ВВЕРХ


_BTC = {"ts": 0.0, "trend": 0}


def _btc_trend() -> int:
    """Тренд BTC за ~сутки (1ч): +1 растёт / -1 падает / 0 флэт. Контекст для треугольников (ТС5/6)."""
    now = time.time()
    if now - _BTC["ts"] < 300:
        return _BTC["trend"]
    try:
        d = _get(FAPI + "/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=30")
        cl = [float(k[4]) for k in d if isinstance(k, list) and len(k) >= 5]
        if len(cl) >= 25:
            chg = (cl[-1] - cl[-24]) / cl[-24] if cl[-24] else 0.0
            _BTC["trend"] = 1 if chg > 0.005 else (-1 if chg < -0.005 else 0)
            _BTC["ts"] = now
    except Exception:
        pass
    return _BTC["trend"]


# ─────────────────────────── движок формаций ───────────────────────────
def _swings(bars: list, k: int = 2) -> tuple:
    """Свинг-хаи/лои (фрактал k соседей) → ([(i,price)высокие], [(i,price)низкие])."""
    hi, lo = [], []
    for i in range(k, len(bars) - k):
        h = bars[i][2]; l = bars[i][3]
        if all(h >= bars[j][2] for j in range(i - k, i + k + 1) if j != i):
            hi.append((i, h))
        if all(l <= bars[j][3] for j in range(i - k, i + k + 1) if j != i):
            lo.append((i, l))
    return hi, lo


def _levels(swings: list, tol: float) -> list:
    """Кластеризация свингов в уровни → [{p, touches, i_first, i_last}], 2+ касания = подтверждён."""
    pts = sorted(swings, key=lambda x: x[1])
    out, grp = [], []
    for i, p in pts:
        if grp and abs(p - grp[-1][1]) / grp[-1][1] > tol:
            out.append(grp); grp = []
        grp.append((i, p))
    if grp:
        out.append(grp)
    lv = []
    for g in out:
        if len(g) < 2:
            continue                                     # уровень = 2+ удара (правило ТС)
        ps = [p for _, p in g]; idx = [i for i, _ in g]
        lv.append({"p": sum(ps) / len(ps), "touches": len(g), "i_first": min(idx), "i_last": max(idx)})
    return lv


def _trendlines(sw_hi: list, sw_lo: list, bars: list, tol: float) -> list:
    """Наклонки: нисходящие по хаям (лонг-пробой) и восходящие по лоям (шорт).
    Базовая наклонка = 3+ касания (правило ТС), закрытий за линией между касаниями нет."""
    out = []
    for pts, down in ((sw_hi[-10:], True), (sw_lo[-10:], False)):
        n = len(pts)
        for a in range(n - 1):
            for b in range(a + 1, n):
                (i1, p1), (i2, p2) = pts[a], pts[b]
                if i2 == i1:
                    continue
                slope = (p2 - p1) / (i2 - i1)
                if (down and slope >= 0) or (not down and slope <= 0):
                    continue
                line = lambda i: p1 + slope * (i - i1)
                touches = 0; ok = True
                for i, p in pts:
                    if i < i1:
                        continue
                    d = abs(p - line(i)) / line(i) if line(i) > 0 else 1
                    if d <= tol:
                        touches += 1
                for i in range(i1, len(bars) - 1):       # закрытия сквозь линию = линия сломана раньше
                    c = bars[i][4]; v = line(i)
                    if v <= 0 or (down and c > v * (1 + tol)) or (not down and c < v * (1 - tol)):
                        ok = False; break
                if ok and touches >= 3:
                    out.append({"i1": i1, "p1": p1, "slope": slope, "down": down, "touches": touches})
    out.sort(key=lambda t: -t["touches"])
    return out[:4]


def _zone(bars: list, price: float) -> str:
    """Зоны 1-5 из ТС: где цена внутри диапазона окна (~17ч)."""
    hi = max(b[2] for b in bars); lo = min(b[3] for b in bars)
    if hi <= lo:
        return "?"
    pos = (price - lo) / (hi - lo)
    return ("зона 1 (над хаем)" if pos > 1.0 else "зона 2 (у хая)" if pos >= 0.93 else
            "зона 3" if pos >= 0.75 else "зона 4 (середина)" if pos >= 0.2 else "зона 5 (у лоя)")


def _recent_levels(bars: list, tol: float, win: int = 34) -> tuple:
    """Уровни ТЕКУЩЕГО поджатия (метод Вики): свинги последних `win` свечей → СВЕЖИЕ чистые уровни,
    а не старьё по всей истории. Индексы касаний — в координатах полного bars (для проверки свежести)."""
    n = len(bars)
    off = max(0, n - 1 - win)
    seg = bars[off:n - 1]                                 # окно ДО пробойной свечи
    if len(seg) < 8:
        return [], []
    sh, sl = _swings(seg)
    sh = [(i + off, p) for i, p in sh]                    # сдвиг индексов в полную шкалу
    sl = [(i + off, p) for i, p in sl]
    return _levels(sh, tol), _levels(sl, tol)


def _next_level(levels: list, price: float, long: bool, natr: float) -> float:
    """ТЕЙК = следующий КРУПНЫЙ уровень по направлению (без урезания 3% — как в сделках Вики).
    Нет уровня → цель по волатильности (мин. 5%, либо 4×NATR — ловим памп)."""
    strong = [l["p"] for l in levels if l.get("touches", 0) >= 3]
    ups = sorted([p for p in strong if p > price * 1.004]) if long else \
          sorted([p for p in strong if p < price * 0.996], reverse=True)
    if not ups:                                          # нет крупного — берём любой следующий уровень
        allp = [l["p"] for l in levels]
        ups = sorted([p for p in allp if p > price * 1.004]) if long else \
              sorted([p for p in allp if p < price * 0.996], reverse=True)
    if ups:
        return ups[0]
    frac = max(0.05, natr / 100.0 * 4.0)                 # памп без уровня сверху → цель по NATR, минимум 5%
    return price * (1 + frac) if long else price * (1 - frac)


def _mk_alert(sym, direction, kind, lvl, bars, levels, tf, natr, extra=None, grade=None, relv=None,
             strat=None, take=None):
    """Карточка алерта: формация + ТВХ/СТОП/ТЕЙК по правилам ТС (стоп 0.2-0.3 от уровня → б/у)."""
    last = bars[-1]; long = direction == "LONG"
    tvx = lvl                                            # ТВХ = уровень (ретест после пробоя)
    stop = lvl * (1 - 0.0025) if long else lvl * (1 + 0.0025)
    if take is None:
        take = _next_level(levels, last[4], long, natr)
    a = {"sym": sym, "dir": direction, "kind": kind, "strat": strat or ("ТС№2 Local Long" if long else "ТС№3 Short"),
         "tf": tf, "level": lvl, "tvx": tvx, "stop": stop,
         "take": take, "price": last[4], "t": last[0], "zone": _zone(bars, last[4]),
         "natr": round(natr, 2), "grade": grade or "УРОВЕНЬ", "relv": round(relv or 1.0, 2), "ts": time.time()}
    if extra:
        a.update(extra)
    return a


def _detect(sym: str, bars: list, tf: str = "5m") -> list:
    """Все формации ТС на закрытых свечах. Алерт — только на СВЕЖИЙ пробой (этой свечой).
    Фильтр Вики: пробой считаем только на ВСПЛЕСКЕ объёма и при живом NATR (иначе шум)."""
    if len(bars) < 60:
        return []
    natr = _natr(bars)
    spike = _vol_spike(bars, float(CFG["vol_spike"]))
    relv = _rel_vol(bars)                               # «новые деньги» — монета в игре
    if natr < float(CFG["natr_min"]) or not spike:      # мёртвая монета / нет всплеска → пропускаем
        return []
    if relv < float(CFG["rel_vol_min"]):                # объём не вырос → актив не «в игре» (правило ТАЙП)
        return []
    min_rank = _GRADE_RANK.get(CFG.get("min_grade", "УРОВЕНЬ"), 1)
    tol, brk = float(CFG["tol"]), float(CFG["brk"])
    sw_hi, sw_lo = _swings(bars[:-1])                    # свинги ДО пробойной свечи (полная история)
    res_all = _levels(sw_hi, tol); sup_all = _levels(sw_lo, tol)   # ПОЛНЫЕ уровни — только для целей тейка
    res, sup = _recent_levels(bars, tol)                 # СВЕЖИЕ уровни коила — для пробоя (метод Вики: граница поджатия)
    lvls_take = res_all + sup_all                        # тейк ищем по всем уровням (следующий сверху/снизу)
    lines = _trendlines(sw_hi, sw_lo, bars, tol)
    c, pc = bars[-1][4], bars[-2][4]
    i_last = len(bars) - 1
    found = []

    def fresh_cross(lvl, long):                          # пробой именно ЭТОЙ свечой
        return (c > lvl * (1 + brk) and pc <= lvl * (1 + brk)) if long else \
               (c < lvl * (1 - brk) and pc >= lvl * (1 - brk))

    # ── пробой уровня (лонг по сопротивлению, шорт по поддержке) ──
    for lvl_list, long in ((res, True), (sup, False)):
        if not long and not CFG["shorts"]:
            continue
        for L in lvl_list:
            lvl = L["p"]
            if not fresh_cross(lvl, long) or i_last - L["i_last"] > 12:   # уровень ТРОГАЛИ недавно = поджатие сейчас (не старьё)
                continue
            # подтип по контексту подхода (схемы «как пробивать уровни»)
            kind = "базовый пробой уровня"
            win = bars[-9:-1]                            # 8 свечей перед пробойной
            rng = (max(b[2] for b in win) - min(b[3] for b in win)) / lvl
            near = all(abs(b[4] - lvl) / lvl < 0.006 for b in win[-5:])
            cascade = [x for x in (res if long else sup)
                       if x is not L and abs(x["p"] - lvl) / lvl < 0.015]
            line_here = [t for t in lines if t["down"] == long and
                         abs((t["p1"] + t["slope"] * (i_last - t["i1"])) - lvl) / lvl < 0.006]
            if len(cascade) >= 2:
                kind = "пробой каскада"
            elif rng < 0.004 and near:
                kind = "пробой через наторговку"
            elif line_here:
                kind = "пробой уровня через наклонку"
            else:                                        # локалка: мини-уровень 0.3-1.5% до основного
                loc = [x for x in (res if long else sup) if x is not L and x["i_last"] > len(bars) - 22
                       and 0.003 < (lvl - x["p"]) / lvl < 0.015] if long else \
                      [x for x in (res if long else sup) if x is not L and x["i_last"] > len(bars) - 22
                       and 0.003 < (x["p"] - lvl) / lvl < 0.015]
                if loc:
                    kind = "пробой уровня с локалки"
            grade, _ = _grade(bars, lvl, natr, L["touches"])   # ХАЙ/УРОВЕНЬ/СЕТАП — нужна консолидация+импульс
            if _GRADE_RANK[grade] < min_rank:                  # слабый (без консолидации) — пропускаем (правило ТС)
                continue
            # классификация по 6 ТС: шорт→ТС3; лонг→ПАМП(ТС1 Трендовая памп пробой)/Hook(ТС4)/Local(ТС2)
            hook_take = _hook_target(bars, lvl) if long else 0.0
            if long and _uptrend_pump(bars):                     # рост + поджатие у хаёв → пробой = продолжение пампа
                strat, tk, kind = "ТС№1 Global Long", None, "Трендовая памп пробой"
            elif long and hook_take:
                strat, tk, kind = "ТС№4 Hook", hook_take, kind + " (крючок)"
            elif long:
                strat, tk = _classify_long(bars, relv), None
            else:
                strat, tk = "ТС№3 Short", None
            found.append(_mk_alert(sym, "LONG" if long else "SHORT", kind, lvl, bars,
                                   lvls_take, tf, natr, {"touches": L["touches"]}, grade, relv, strat, tk))

    # ── пробой наклонки / ТРЕУГОЛЬНИК (ТС5/6 — по закрытию свечи) ──
    tri = _triangle(lines, bars)                         # есть сходящиеся границы = треугольник
    for t in lines:
        v = t["p1"] + t["slope"] * (i_last - t["i1"])
        pv = t["p1"] + t["slope"] * (i_last - 1 - t["i1"])
        if v <= 0:
            continue
        gr, _ = _grade(bars, v, natr, t["touches"])
        if _GRADE_RANK[gr] < min_rank:
            continue
        if t["down"] and c > v * (1 + brk) and pc <= pv * (1 + brk):           # пробой ВВЕРХ верхней линии
            is_tri = bool(tri and t is tri["up"])
            if is_tri and CFG.get("btc_context", True) and _btc_trend() < 0:    # треугольник-лонг против падающего BTC → не ТС5
                is_tri = False
            strat = "ТС№5 Triangle Long" if is_tri else _classify_long(bars, relv)
            kind = "пробой треугольника вверх" if is_tri else "пробой наклонки"
            fb = _false_breakout(bars, v, True) if is_tri else False
            found.append(_mk_alert(sym, "LONG", kind, v, bars, lvls_take, tf, natr,
                                   {"touches": t["touches"], "line": [t["i1"], t["p1"], i_last, v],
                                    "false_out": fb, "btc": _btc_trend()}, gr, relv, strat))
        elif not t["down"] and CFG["shorts"] and c < v * (1 - brk) and pc >= pv * (1 - brk):  # пробой ВНИЗ нижней
            is_tri = bool(tri and t is tri["lo"])
            if is_tri and CFG.get("btc_context", True) and _btc_trend() > 0:    # треугольник-шорт против растущего BTC → не ТС6
                is_tri = False
            strat = "ТС№6 Triangle Short" if is_tri else "ТС№3 Short"
            kind = "пробой треугольника вниз" if is_tri else "пробой наклонки (дамп)"
            fb = _false_breakout(bars, v, False) if is_tri else False
            found.append(_mk_alert(sym, "SHORT", kind, v, bars, lvls_take, tf, natr,
                                   {"touches": t["touches"], "line": [t["i1"], t["p1"], i_last, v],
                                    "false_out": fb, "btc": _btc_trend()}, gr, relv, strat))

    # ── боковик: плоский ренж 40+ свечей, пробой границы ──
    box = bars[-45:-1]
    bh = max(b[2] for b in box); bl = min(b[3] for b in box)
    if bl > 0 and (bh - bl) / bl < 0.05:
        top_t = sum(1 for b in box if abs(b[2] - bh) / bh < tol)
        bot_t = sum(1 for b in box if abs(b[3] - bl) / bl < tol)
        if top_t >= 2 and bot_t >= 2 and _impulse_before(bars, n_cons=44, n_imp=12):  # боковик ТОЛЬКО с приором-импульсом (ошибка №1 ТС)
            if fresh_cross(bh, True):
                found.append(_mk_alert(sym, "LONG", "боковик. пробой (приор)", bh, bars, lvls_take, tf, natr,
                                       {"touches": top_t}, "СЕТАП", relv, _classify_long(bars, relv)))
            elif CFG["shorts"] and fresh_cross(bl, False):
                found.append(_mk_alert(sym, "SHORT", "боковик. пробой вниз (приор)", bl, bars, lvls_take, tf, natr,
                                       {"touches": bot_t}, "СЕТАП", relv, "ТС№3 Short"))

    # ── закол уровня с возвратом (свип лоя/хая → предвестник, схема «закол лоя 0.3-0.5») ──
    last = bars[-1]
    for L in sup:
        lvl = L["p"]
        if last[3] < lvl * (1 - 0.0015) and c > lvl * (1 + 0.0005) and pc >= lvl:
            found.append(_mk_alert(sym, "LONG", "закол лоя. возврат в ренж", lvl, bars, lvls_take, tf, natr,
                                   {"touches": L["touches"]}))
    if CFG["shorts"]:
        for L in res:
            lvl = L["p"]
            if last[2] > lvl * (1 + 0.0015) and c < lvl * (1 - 0.0005) and pc <= lvl:
                found.append(_mk_alert(sym, "SHORT", "закол хая. возврат в ренж", lvl, bars, lvls_take, tf, natr,
                                       {"touches": L["touches"]}))
    return found


# ─────────────────────────── сканер ───────────────────────────
def _push(alerts: list):
    now = time.time()
    with _LOCK:
        for k in [k for k, ts in _SEEN.items() if now - ts > _SEEN_TTL]:
            _SEEN.pop(k, None)
        for a in alerts:
            bucket = round(math.log(a["level"]) * 250) if a["level"] > 0 else 0   # корзина ~0.4% (лог-шкала)
            key = (a["sym"], a["dir"], a.get("tf", ""), bucket)                    # свой антидубль на каждый ТФ
            if key in _SEEN:
                continue
            _SEEN[key] = now
            _ALERT_ID[0] += 1
            a["id"] = _ALERT_ID[0]
            _ALERTS.append(a)


def scanner():
    """Фоновый поток: раз в scan_sec проходит топ монет Binance, ищет формации."""
    syms, syms_ts = [], 0.0
    while True:
        try:
            if time.time() - syms_ts > 600 or not syms:
                syms = _top_symbols(); syms_ts = time.time()
                _STATE["symbols"] = len(syms); _STATE["err"] = ""
            tfs = [t for t in CFG["tfs"] if t in _TF_SEC] or ["5m"]
            scanned = 0
            for sym in syms:
                if time.time() < _BAN_UNTIL[0]:           # бан по лимитам — не жжём запросы впустую
                    break
                for tf in tfs:                            # сканируем каждый ТФ отдельно (1m/5m/15m/30m)
                    if time.time() < _BAN_UNTIL[0]:
                        break
                    try:
                        bars = _klines(sym, tf)            # фильтр по 24ч объёму уже в _top_symbols
                        _push(_detect(sym, bars, tf))
                    except Exception:
                        continue
                    time.sleep(0.25)                      # ~4 запр/с: делим лимит с опросом тикера THIEF
                scanned += 1
            _STATE["scanned"] = scanned; _STATE["last_sweep"] = time.time()
            _STATE["err"] = ("бан Binance до " + time.strftime("%H:%M", time.localtime(_BAN_UNTIL[0]))) \
                if time.time() < _BAN_UNTIL[0] else ""
        except Exception as exc:
            _STATE["err"] = str(exc)[:200]
        time.sleep(max(10, float(CFG["scan_sec"])))


# ─────────────────────────── API для server.py ───────────────────────────
def alerts_since(since_id: int) -> dict:
    with _LOCK:
        items = [a for a in _ALERTS if a["id"] > since_id]
    return {"ok": True, "alerts": items[-40:], "last_id": _ALERT_ID[0],
            "state": dict(_STATE), "cfg": dict(CFG)}


def chart(sym: str, tf: str = "5m") -> dict:
    """Свечи + уровни + наклонки монеты для отрисовки графика «как на схемах»."""
    sym = (sym or "").upper().replace("_", "")
    if not sym.endswith("USDT"):
        sym += "USDT"
    if tf not in _TF_SEC:
        tf = "5m"
    ck = sym + "@" + tf
    hit = _CHART_CACHE.get(ck)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    try:
        bars = _klines(sym, tf, limit=200)
    except Exception as exc:                     # бан/сеть — вернуть последний кэш или понятный текст (не 502)
        if hit:
            return hit[1]
        return {"ok": False, "error": str(exc)[:160]}
    if len(bars) < 30:
        return {"ok": False, "error": "нет свечей " + sym}
    tol = float(CFG["tol"])
    sw_hi, sw_lo = _swings(bars)
    res = _levels(sw_hi, tol); sup = _levels(sw_lo, tol)
    lines = _trendlines(sw_hi, sw_lo, bars, tol)
    with _LOCK:
        sym_alerts = [a for a in _ALERTS if a["sym"] == sym][-6:]
    out = {"ok": True, "sym": sym, "tf": tf, "natr": round(_natr(bars), 2), "bars": bars,
           "levels": [{"p": l["p"], "touches": l["touches"], "kind": "res"} for l in res] +
                     [{"p": l["p"], "touches": l["touches"], "kind": "sup"} for l in sup],
           "lines": [{"i1": t["i1"], "p1": t["p1"], "slope": t["slope"], "down": t["down"],
                      "touches": t["touches"]} for t in lines],
           "alerts": sym_alerts}
    _CHART_CACHE[ck] = (time.time(), out)
    return out


def set_cfg(body: dict) -> dict:
    for k in ("min24hvol", "topn", "scan_sec", "tol", "brk", "vol_spike", "natr_min", "rel_vol_min"):
        if k in body:
            try:
                CFG[k] = float(body[k]) if k != "topn" else int(body[k])
            except (TypeError, ValueError):
                pass
    if "shorts" in body:
        CFG["shorts"] = bool(body["shorts"])
    if body.get("min_grade") in _GRADE_RANK:
        CFG["min_grade"] = body["min_grade"]
    if "top_movers" in body:
        CFG["top_movers"] = bool(body["top_movers"])
    if "btc_context" in body:
        CFG["btc_context"] = bool(body["btc_context"])
    if isinstance(body.get("tfs"), list):
        good = [t for t in body["tfs"] if t in _TF_SEC]
        if good:
            CFG["tfs"] = good
    return {"ok": True, "cfg": dict(CFG)}
