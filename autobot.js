"use strict";
/* ============================================================================
   AUTOBOT (PAPER) — авто-сбор спреда, ЕДИНАЯ адаптивная стратегия.
   ----------------------------------------------------------------------------
   ⚠ РЕЖИМ: только PAPER (симуляция). Реальные ордера НЕ отправляются —
   бот НЕ дёргает sendOrder/limitBuy и не требует LIVE/подключения токеном.
   Филлы считаются виртуально по РЕАЛЬНОЙ ленте сделок (S.flow.ticks):
   заявка филлится, только если ПОСЛЕ её постановки прошёл принт по нужной цене.
   Это честная модель мейкера: наш ордер пассивный, филл-цена = наша лимитка.

   ОДНА стратегия — бот сам выбирает поведение по рынку (3 способа Вики слиты):
     • ТРЕНД есть        → вход на откате ПО тренду, быстрый скальп (+N тиков).
     • ФЛЭТ + стена ММ    → «прострел»: лимитка глубоко у дальней стены,
                            тейк ближе к середине (доля пути к mid).
     • ФЛЭТ + широкий спред → «поджатие»: лимитка у середины, на тик впереди ММ.
   Выход у всех: закрывающая лимитка. Аварийный стоп по тикам/времени.

   Данные из app.js: S.bestBid, S.bestAsk, S.tick, S.dec, S.symbol,
   S.contractSize, S.depth {bids:[[p,v]], asks:[[p,v]]}, S.flow.ticks [{t,p,v}].
   ========================================================================== */
(function () {
  const AB = {
    on: false,
    cfg: {
      sizeUsd: 20,       // размер лота в $ (режим "usd")
      sizeMode: "usd",   // "usd" = задаём в долларах (бот пересчитает в контракты) / "contracts" = РОВНО N контрактов (фикс)
      sizeContracts: 1,  // размер лота в контрактах (режим "contracts") — сколько ровно ставим
      profitTicks: 2,    // тейк, тиков (тренд/поджатие)
      gateTicks: 3,      // не собирать спред у середины/стены, пока спред уже этого
      stopTicks: 8,      // аварийный стоп: убыток ≥ N тиков → закрыть по рынку
      maxHoldSec: 25,    // не пересиживать: закрыть по рынку через N сек
      aheadTicks: 1,     // «чуть раньше» ММ (поджатие): агрессивнее середины на N тиков
      deepTicks: 12,     // как глубоко искать дальнюю стену (прострел)
      scanTicks: 60,     // окно сканирования стен от спреда, тиков (минимум; на мелко-тиковых монетах перекрывается % полосой)
      scanPct: 1.5,      // окно сканирования = максимум(scanTicks, эта доля % от цены) — на ALLO/микро-тик тик крохотный, стены далеко в тиках
      scanMaxTicks: 2000,// потолок окна в тиках (чтобы не сканировать весь стакан)
      wallMinUsd: 300,   // стена меньше этого ($) не считается стеной — от неё спред не собираем
      fixUsd: 0,         // (УДАЛЕНО из UI) легаси-поле: перебивало «Размер лота» и путало. Гасится миграцией в loadState, размер ТОЛЬКО из sizeUsd.
      wallFrac: 0.3,     // (устар.) доля ликвидности окна
      wallKeepFrac: 0.4, // цель держим, пока у стены ≥ этой доли исходного объёма (в ±2 тика)
      clusterGap: 2,     // склеивать соседние крупные тики в одну стену, если разрыв ≤ G тиков
      dominanceD: 3,     // стена «торчит», если кластер ≥ D× медианы уровней окна
      wallMode: "biggest", // выбор среди кандидатов: "near"=ближайший к спреду / "biggest"=самый жирный маркетос
      hystPct: 0.3,      // гистерезис: не перепрыгивать на др. стену, пока она не крупнее текущей на H
      persistMs: 500,    // антиспуф: стена валидна, только если простояла ≥ этого (не гнаться за мельканием)
      tpFrac: 0.6,       // прострел: доля пути от входа к середине для тейка
      trendSec: 10,      // окно определения тренда
      trendTicks: 4,     // мин. ход за окно, чтобы считать трендом
      pullbackTicks: 2,  // тренд: на сколько тиков за край ставим лимитку (откат)
      requoteSec: 2,     // (не спамить) мин. интервал между переставлениями, сек — умолчание
      requoteTicks: 3,   // переставлять заявку ТОЛЬКО если цель сместилась ≥ этого (иначе не трогать)
      cooldownSec: 2,    // пауза между сделками
      minPrintUsd: 5,    // принты мельче ($) не двигают наш филл (реализм)
      // ── МЕХАНИКА order-flow (исследование 2026-07-06) ─────────────────────
      wallMedianMult: 5, // стена ≥ этого × медианы уровня в окне (иначе не «стена», а шум)
      wallAgeMs: 2000,   // стена должна ПРОСТОЯТЬ ≥ этого непрерывно (спуф снимают быстрее)
      spoofMs: 800,      // появилась и исчезла/усохла БЕЗ сделок за < этого → спуф
      icebergMult: 1.6,  // сквозь уровень прошло сделок > видимого размера × это, а он стоит → айсберг (доливают)
      absVolZ: 3.0,      // absorption: Z-score объёма ленты за окно ≥ этого (реальная драка)
      absImb: 0.6,       // absorption: |дисбаланс агрессора| ≥ этого (бьют в одну сторону)
      absHoldTicks: 1.5, // absorption: цена сдвинулась ≤ этого тиков за окно (стена ЕСТ, не пускает) = держит
      absWinSec: 3,      // окно расчёта absorption/дельты/Z, сек
      brkDepthDrop: 0.30,// пробой: глубина стороны −этого доли за brkWinSec без долива
      brkVolFrac: 0.60,  // пробой: маркет-объём > этого доли видимой глубины за окно
      brkWinSec: 2,      // окно детекта пробоя, сек
      obiLevels: 8,      // сколько уровней стакана в расчёте OBI-перекоса
      obiGate: 0.6,      // |OBI| ≥ этого = направленно (котируем в сторону перекоса); < obiFlat = флэт, не котируем
      obiFlat: 0.2,      // |OBI| < этого = флэт (нет края) → стоп котирования
      minBookUsd: 3000,  // тонкий стакан: суммарная глубина top-N < этого $ → НЕ котируем (VANRY-защита)
      maxSprTicks: 40,   // спред шире этого (тиков) → не котируем (проскок стопа, PAPER врёт в плюс)
      invCapMult: 1.5,   // хард-кап инвентаря: |позиция| > лот × это → на этой стороне только флэтить
      adverseSec: 2,     // адверс-выход: дельта против нас держится ≥ этого сек после филла → «пора выходить»
      exitMaker: true,   // 🔑 ВЫХОД ТОЛЬКО ЛИМИТКОЙ (мейкер, 0 комсы). При «пора выходить» переставляем закр.лимитку на maker-край (лонг→ask, шорт→bid), НЕ по рынку. Маркет — ТОЛЬКО авария накопления.
      gateEnable: true,  // мастер-переключатель гейтов absorption/OBI/тонкий-стакан (off = старое «жирная стена»)
    },
    auto: true,          // 🎯 авто-подбор гейт/тейк/стоп/глубина под монету из живого стакана
    twoSided: true,      // ⇅ ставить лимитки с ОБЕИХ сторон (у верхнего и нижнего маркетоса)
    paper: true,         // true=симуляция, false=РЕАЛ (реальные ордера через терминал, только Ourbit/WEEX)
    conn: { ex: "mexc", type: "api", key: "", secret: "", pass: "", uid: "" },
    // runtime
    state: "idle",       // idle | quoting | inpos
    entry: null,         // {side,price,vol,since,placedAt,tpPrice,kind}
    pos: null,           // {long,price,vol,t,kind}
    close: null,         // {side,price,since}
    cooldownUntil: 0,
    _sym: null, _flip: false,
    stats: { trades: 0, wins: 0, losses: 0, pnlUsd: 0, ticksSum: 0 },
    log: [],
  };
  window.AB = AB;

  const EXCHANGES = [["mexc", "MEXC"], ["ourbit", "Ourbit"], ["weex", "WEEX"], ["bybit", "Bybit"], ["gate", "Gate"], ["bitget", "Bitget"]];
  const NEEDS_PASS = { weex: 1, okx: 1, bitget: 1, kucoin: 1 };

  // ── сохранение настроек ─────────────────────────────────────────────────
  function saveState() {
    try { localStorage.setItem("ab_cfg", JSON.stringify(AB.cfg)); localStorage.setItem("ab_conn", JSON.stringify(AB.conn)); localStorage.setItem("ab_auto", AB.auto ? "1" : "0"); localStorage.setItem("ab_paper", AB.paper ? "1" : "0"); localStorage.setItem("ab_two", AB.twoSided ? "1" : "0"); } catch (e) {}
  }
  function loadState() {
    try {
      const c = JSON.parse(localStorage.getItem("ab_cfg") || "null"); if (c) Object.assign(AB.cfg, c);
      // МИГРАЦИЯ: раньше было 2 поля ($ лота + фикс-$), фикс ПЕРЕБИВАЛ и путал («ставлю $10, а ордер $20»).
      // Теперь ОДНО поле «Размер лота, $» (sizeUsd) — старый fixUsd гасим навсегда, размер только из sizeUsd.
      if (AB.cfg.fixUsd > 0) { AB.cfg.fixUsd = 0; saveState(); }
      const n = JSON.parse(localStorage.getItem("ab_conn") || "null"); if (n) Object.assign(AB.conn, n);
      const a = localStorage.getItem("ab_auto"); if (a != null) AB.auto = a === "1";
      const pp = localStorage.getItem("ab_paper"); if (pp != null) AB.paper = pp === "1";
      const tw = localStorage.getItem("ab_two"); if (tw != null) AB.twoSided = tw === "1";
    } catch (e) {}
  }

  // ── помощники ────────────────────────────────────────────────────────────
  const tk = () => S.tick || 0.01;
  const dc = () => (S.dec != null ? S.dec : 2);
  const snap = (p) => +(Math.round(p / tk()) * tk()).toFixed(dc());
  const now = () => (S.flow && S.flow.now ? S.flow.now : Date.now());
  const cs = () => S.contractSize || 1;
  const inContracts = () => AB.cfg.sizeMode === "contracts";
  // Кол-во контрактов ордера. Режим "contracts" = РОВНО столько (фикс, без пересчёта). Режим "usd" = из $ / цена.
  function vol(price) {
    if (inContracts()) return Math.max(1, Math.round(AB.cfg.sizeContracts || 1));
    const usd = AB.cfg.sizeUsd || 1; return Math.max(1, Math.round(usd / (price * cs())));
  }
  function lotUsd(price) {  // notional одного лота (для порогов накопления)
    const px = price || S.bestBid || S.bestAsk || 0;
    if (inContracts()) return Math.max(1, Math.round(AB.cfg.sizeContracts || 1)) * px * cs();
    return AB.cfg.sizeUsd || 1;
  }
  // Мин. ордер биржи = 1 контракт. Блокируем ТОЛЬКО в режиме $ (там микро-лот может не покрыть 1 контракт). В режиме контрактов — 1 контракт всегда валиден.
  function minContractUsd() { const px = S.bestBid || S.bestAsk || 0; return px * cs(); }
  function lotTooSmall() { if (inContracts()) return false; const mc = minContractUsd(); return mc > 0 && (AB.cfg.sizeUsd || 0) < mc * 0.99; }
  // Читаемый размер ордера: в $ И в контрактах.
  function sizeReadout() {
    const px = S.bestBid || S.bestAsk || 0, coin = (S.symbol || "").replace("_USDT", "");
    const csn = cs() > 1 ? ` · 1 контр=${cs()} ${coin}` : "";
    if (inContracts()) {
      const ctr = Math.max(1, Math.round(AB.cfg.sizeContracts || 1));
      return px ? `📦 ордер: ${ctr} контр. (фикс) = $${Math.round(ctr * px * cs())}${csn}` : `📦 ордер: ${ctr} контр. (фикс)`;
    }
    const usd = AB.cfg.sizeUsd || 0;
    if (!px) return `💵 ордер: $${usd}`;
    const mc = minContractUsd();
    if (lotTooSmall()) return `⛔ 1 контракт = $${Math.round(mc)} (${cs()} ${coin}) > твой лот $${usd} — НЕ ТОРГУЮ. Подними лот ≥ $${Math.ceil(mc)}, монету дешевле, или переключи на «контр.»`;
    const ctr = Math.max(1, Math.round(usd / (px * cs())));
    return `💵 ордер: $${usd} ≈ ${ctr} контр. = $${Math.round(ctr * px * cs())}${csn}`;
  }
  function pnlUsd(long, entry, exit, v) { return (long ? exit - entry : entry - exit) * v * cs(); }
  function ticksBetween(a, b) { return Math.round(Math.abs(a - b) / tk()); }
  function abLog(msg, kind) { AB.log.unshift({ msg, kind }); if (AB.log.length > 40) AB.log.length = 40; }

  // Тренд по ленте за окно: +1 / -1 / 0.
  function trendDir(sec) {
    const ticks = (S.flow && S.flow.ticks) || [], nT = now();
    if (ticks.length < 4) return 0;
    const from = nT - sec * 1000;
    let firstP = null, lastP = null;
    for (const p of ticks) { if (p.t < from) continue; if (firstP == null) firstP = p.p; lastP = p.p; }
    if (firstP == null || lastP == null) return 0;
    const moveT = (lastP - firstP) / tk();
    if (Math.abs(moveT) < AB.cfg.trendTicks) return 0;
    return moveT > 0 ? 1 : -1;
  }

  // Объём «в очереди» на нашей цене в момент постановки (сколько ликвидности стоит впереди нас).
  // Внутри спреда (свой новый уровень) очереди нет → фил быстрее; у стены очередь большая → фил медленный/редкий (реализм).
  function queueAt(side, price) {
    const d = S.depth; if (!d) return 0;
    const arr = side === "buy" ? d.bids : d.asks; if (!arr) return 0;
    const t = tk();
    for (const [p, v] of arr) { if (Math.abs(p - price) < t * 0.5) return v || 0; }
    return 0;
  }
  // Размах цены ленты за окно (тиков) — мера волатильности.
  function recentRangeTicks(sec) {
    const ticks = (S.flow && S.flow.ticks) || [], from = now() - sec * 1000;
    let hi = -Infinity, lo = Infinity;
    for (const p of ticks) { if (p.t < from) continue; if (p.p > hi) hi = p.p; if (p.p < lo) lo = p.p; }
    return hi < lo ? 0 : (hi - lo) / tk();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ДВИЖОК ORDER-FLOW (2026-07-06) — чтобы бот ЧЁТКО видел маркетоса.
  //  Использует сторону агрессора S.flow.ticks[].side (1=ударил покупатель).
  //  Считает: absorption-триггер (держит→отскок) vs пробой, OBI-перекос,
  //  жизненный цикл стены (спуф/подтверждена/защищена-айсберг), тонкий стакан.
  // ══════════════════════════════════════════════════════════════════════════
  function mid() { const bb = S.bestBid, ba = S.bestAsk; return (bb && ba) ? (bb + ba) / 2 : 0; }
  function bucketKey(p) { return Math.round(p / (S.step || tk())); }

  // Стата ленты за окно С УЧЁТОМ агрессора: buy/sell объём ($), дисбаланс [-1..1].
  function tapeStats(sec) {
    const ticks = (S.flow && S.flow.ticks) || [], from = now() - sec * 1000;
    let bV = 0, sV = 0, n = 0;
    for (const p of ticks) { if (p.t < from) continue; const u = p.v * cs() * p.p; if (p.side === 1) bV += u; else sV += u; n++; }
    const tot = bV + sV;
    return { buyUsd: bV, sellUsd: sV, tot, imb: tot > 0 ? (bV - sV) / tot : 0, n };
  }
  // OBI-перекос стакана по top-N уровням: (ΣBid−ΣAsk)/(ΣBid+ΣAsk) ∈ [-1..1].
  function computeOBI(nLev) {
    const d = S.depth; if (!d || !d.bids || !d.asks) return { obi: 0, bookUsd: 0 };
    let b = 0, a = 0;
    for (let i = 0; i < nLev; i++) { const bd = d.bids[i], ak = d.asks[i]; if (bd) b += bd[1] * cs() * bd[0]; if (ak) a += ak[1] * cs() * ak[0]; }
    const t = b + a;
    return { obi: t > 0 ? (b - a) / t : 0, bookUsd: t };
  }
  // Раз в шаг: пересчитать сигналы (кэш в AB.sig). Volume Z — по сэмплам объёма окна ~1/сек.
  function updateSignals() {
    const C = AB.cfg, ms = Date.now(), t = tk();
    const st = tapeStats(C.absWinSec);
    if (ms - (AB._volSampAt || 0) >= 900) { AB._volSampAt = ms; const h = AB._volHist || (AB._volHist = []); h.push(st.tot); if (h.length > 90) h.shift(); }
    const h = AB._volHist || []; let volZ = 0;
    if (h.length >= 10) { const m = h.reduce((a, b) => a + b, 0) / h.length; const v = h.reduce((a, b) => a + (b - m) * (b - m), 0) / h.length; const sd = Math.sqrt(v); volZ = sd > 0 ? (st.tot - m) / sd : 0; }
    const cm = mid(), mh = AB._midHist || (AB._midHist = []);
    if (cm) mh.push({ t: ms, p: cm }); while (mh.length && mh[0].t < ms - C.absWinSec * 1000) mh.shift();
    const movedT = (mh.length && cm) ? Math.abs(cm - mh[0].p) / t : 0;
    const ob = computeOBI(C.obiLevels);
    AB.sig = { volZ, imb: st.imb, movedT, obi: ob.obi, bookUsd: ob.bookUsd, tot: st.tot, buyUsd: st.buyUsd, sellUsd: st.sellUsd, at: ms };
    return AB.sig;
  }
  // ABSORPTION на стороне: объём большой (Z), бьют в стену (дисбаланс), а цена НЕ идёт → стена ест → отскок.
  //  side="buy": мы лонг от бид-стены → агрессия ДОЛЖНА быть на продажу (imb<0), но цена держится.
  function absorbing(side) {
    const s = AB.sig, C = AB.cfg; if (!s) return false;
    if (s.volZ < C.absVolZ) return false;              // нет «драки» за уровень
    if (s.movedT > C.absHoldTicks) return false;       // цена ушла = не absorb (пробой/дрейф)
    return side === "buy" ? s.imb <= -C.absImb : s.imb >= C.absImb;
  }
  // ПРОБОЙ: большой объём + цена ПОШЛА, либо маркет-объём съедает видимую глубину.
  function breaking(side) {
    const s = AB.sig, C = AB.cfg; if (!s) return false;
    if (s.volZ >= C.absVolZ && s.movedT > C.absHoldTicks * 2) return true;
    if (s.bookUsd > 0 && s.tot > s.bookUsd * C.brkVolFrac) return true;
    return false;
  }
  // Трекинг стен во времени (одна модель на сторону). Классификация: spoof/confirming/confirmed/defended.
  //  🔑 КЛАСТЕРИЗАЦИЯ: размазанный маркетос (соседние уровни, разрыв ≤ clusterGap бакетов) = ОДНА стена.
  //  px стены = БЛИЖНИЙ к спреду край кластера (лимитка встаёт впереди КРАЯ, а не в середине маркетоса!).
  //  traded = сколько $ проторговано СКВОЗЬ бакеты кластера с прошлого шага (для айсберга).
  function updateWallsSide(side, tradedMap) {
    const d = S.depth; if (!d) return [];
    const t = tk(), C = AB.cfg;
    const arr = side === "buy" ? d.bids : d.asks, best = side === "buy" ? S.bestBid : S.bestAsk;
    if (!arr || !best) return [];
    // окно = максимум(фикс. тики, % от цены), с потолком. На мелко-тиковых монетах (ALLO tick 1e-5) стены далеко в тиках.
    const bandTicks = t > 0 ? Math.round((best * (C.scanPct || 1.5) / 100) / t) : 0;
    const scan = Math.min(C.scanMaxTicks || 2000, Math.max(C.deepTicks || 12, C.scanTicks || 60, bandTicks));
    // 1) уровни в окне
    const lv = [];
    for (const [p, v] of arr) {
      if (!(v > 0)) continue;
      const off = side === "buy" ? (best - p) : (p - best);
      if (off <= 0 || off > scan * t) continue;
      lv.push({ p, v, usd: v * cs() * p, offT: Math.round(off / t), bk: bucketKey(p) });
    }
    const nowMs = Date.now(), trk = AB.wallTrk || (AB.wallTrk = { buy: new Map(), sell: new Map() }), m = trk[side];
    if (!lv.length) { for (const [k, w] of m) { if (nowMs - w.lastSeen > 1500) m.delete(k); } return []; }
    const med = median(lv.map((l) => l.usd)) || 1;
    lv.sort((a, b) => a.offT - b.offT);
    // 2) кластеры ТОЛЬКО из КРУПНЫХ уровней (≥ 2× медианы) — иначе мелочь склеивает весь стакан
    //    в один кластер и «край» оказывается мелким уровнем у спреда (лимитка не там!).
    const G = C.clusterGap || 2, cls = [];
    const big = lv.filter((l) => l.usd >= med * 2);
    for (const l of big) {
      const last = cls[cls.length - 1];
      if (last && Math.abs(l.bk - last.lastBk) <= G) {
        last.usd += l.usd; last.lastBk = l.bk; last.traded += tradedMap.get(l.bk) || 0;
        if (l.v > last.peakV) { last.peakV = l.v; last.peakP = l.p; }
      } else cls.push({ edgeP: l.p, edgeBk: l.bk, lastBk: l.bk, offT: l.offT, usd: l.usd, peakV: l.v, peakP: l.p, traded: tradedMap.get(l.bk) || 0 });
    }
    // 3) трекинг кластеров во времени по ближнему краю (край дрожит ±бакет → матчим по близости)
    const alive = new Set(), out = [];
    for (const c of cls) {
      let w = null, bd = G + 2;
      for (const [k, x] of m) { const dd = Math.abs(k - c.edgeBk); if (dd <= G + 1 && dd < bd) { bd = dd; w = x; } }
      if (!w) { w = { key: c.edgeBk, bornAt: nowMs, traded: 0, refills: 0, wasBelow: false, peakUsd: c.usd, peakV: 0 }; m.set(c.edgeBk, w); }
      else if (w.key !== c.edgeBk) { m.delete(w.key); w.key = c.edgeBk; m.set(c.edgeBk, w); }   // край сместился — переносим трек
      w.lastSeen = nowMs; w.px = c.edgeP; w.curUsd = c.usd; w.peakV = Math.max(w.peakV, c.peakV); w.offT = c.offT;
      if (c.usd > w.peakUsd) w.peakUsd = c.usd;
      if (c.usd < w.peakUsd * 0.4) w.wasBelow = true;                            // просел
      else if (w.wasBelow && c.usd >= w.peakUsd * 0.8) { w.refills++; w.wasBelow = false; }  // вернулся = долив
      w.traded += c.traded;
      alive.add(w.key);
      const age = nowMs - w.bornAt;
      w.age = age; w.median = med;
      w.isWall = c.usd >= C.wallMedianMult * med && c.usd >= (C.wallMinUsd > 0 ? C.wallMinUsd : 0);
      w.iceberg = w.peakUsd > 0 && w.traded > w.peakUsd * C.icebergMult;         // проторговано > видимого = доливают
      const shrankNoTrade = (w.curUsd < w.peakUsd * 0.3) && (w.traded < w.peakUsd * 0.2) && age < C.spoofMs * 5;
      if (shrankNoTrade) w.cls = "spoof";                                        // усох без сделок = спуф
      else if (age < C.wallAgeMs) w.cls = "confirming";                          // ещё не простоял
      else if (w.iceberg || w.refills >= 1) w.cls = "defended";                  // держат (айсберг/долив)
      else if (w.isWall) w.cls = "confirmed";
      else w.cls = "weak";
      if (w.isWall || w.cls === "defended") out.push(w);
    }
    for (const [k, w] of m) { if (!alive.has(k) && nowMs - w.lastSeen > 1500) m.delete(k); }  // ушедшие стены отпадают
    return out.sort((a, b) => a.offT - b.offT);
  }
  // Раз в шаг: посчитать проторгованное сквозь бакеты с прошлого шага, обновить обе стороны.
  function stepWalls() {
    const ticks = (S.flow && S.flow.ticks) || [], wm = AB._wallSeenT || 0; let maxT = wm; const traded = new Map();
    for (const pr of ticks) { if (pr.t <= wm) continue; if (pr.t > maxT) maxT = pr.t; const bk = bucketKey(pr.p); traded.set(bk, (traded.get(bk) || 0) + pr.v * cs() * pr.p); }
    AB._wallsBuy = updateWallsSide("buy", traded);
    AB._wallsSell = updateWallsSide("sell", traded);
    AB._wallSeenT = maxT;
  }
  // Почему сейчас НЕЛЬЗЯ котировать на стороне (null = можно). Гейты из исследования.
  function quotingBlocked(side) {
    const C = AB.cfg;
    if (lotTooSmall()) return `1 контракт $${Math.round(minContractUsd())} > лот $${C.sizeUsd} — подними лот`;   // мин.ордер биржи дороже лота (защита ВСЕГДА, даже при gateEnable=off)
    if (!C.gateEnable) return null;
    const s = AB.sig; if (!s) return "нет сигналов";
    const bb = S.bestBid, ba = S.bestAsk, t = tk(); if (!bb || !ba || ba <= bb) return "нет стакана";
    if (Math.round((ba - bb) / t) > C.maxSprTicks) return "спред широк";
    if (s.bookUsd < C.minBookUsd) return "тонкий стакан";
    if (Math.abs(s.obi) < C.obiFlat) return "флэт (OBI)";
    if (side === "buy" && s.obi <= -C.obiFlat) return "OBI против лонга";
    if (side === "sell" && s.obi >= C.obiFlat) return "OBI против шорта";
    if (breaking(side)) return "пробой";
    return null;
  }

  // РЕАЛИСТИЧНЫЙ филл: заявка филлится не по касанию, а когда:
  //  • цена ПРОБИЛА уровень насквозь (гарантированный филл), ИЛИ
  //  • проторговано ≥ (очередь впереди + наш объём) ПО нашей цене.
  // Микропринты (< minPrintUsd) игнор. Считаем только принты после постановки, без двойного счёта (watermark).
  function printFilled(order) {
    const ticks = (S.flow && S.flow.ticks) || [], t = tk(), half = t * 0.5;
    const buy = order.side === "buy", minU = AB.cfg.minPrintUsd || 0;
    let wm = order._seen || order.since, maxT = wm, hit = false;
    for (let i = 0; i < ticks.length; i++) {
      const pr = ticks[i]; if (pr.t <= wm) continue; if (pr.t > maxT) maxT = pr.t;
      if (buy ? (pr.p < order.price - half) : (pr.p > order.price + half)) { hit = true; break; }   // пробой насквозь
      if (Math.abs(pr.p - order.price) < half) {                                                     // торговля ПО нашей цене → съедаем очередь
        if (minU > 0 && pr.v * cs() * pr.p < minU) continue;
        order.fillVol = (order.fillVol || 0) + pr.v;
        if (order.fillVol >= (order.queue || 0) + order.vol) { hit = true; break; }
      }
    }
    order._seen = maxT;
    return hit;
  }

  // ── авто-подбор параметров под текущую монету (из живого стакана/ленты) ──────
  function autoTune() {
    if (!AB.auto) return;
    if (AB._tuneSym !== S.symbol) { AB._sprEMA = 0; AB._tuneSym = S.symbol; }
    const bb = S.bestBid, ba = S.bestAsk, t = tk(); if (!bb || !ba || ba <= bb) return;
    const spr = Math.round((ba - bb) / t);
    AB._sprEMA = AB._sprEMA ? AB._sprEMA * 0.85 + spr * 0.15 : spr;   // сглаженный типичный спред
    const med = AB._sprEMA, vol = recentRangeTicks(10), C = AB.cfg;
    const cl = (x, a, b) => Math.max(a, Math.min(b, Math.round(x)));
    C.profitTicks   = cl(med * 0.5, 1, 8);                                  // тейк ≈ половина спреда
    C.gateTicks     = cl(med * 0.8, 2, 14);                                 // входим когда спред ≥ ~типичного
    C.stopTicks     = cl(Math.max(C.profitTicks * 2, vol * 0.5), C.profitTicks + 2, C.profitTicks * 4);
    C.maxHoldSec    = cl(Math.max(12, 250 / (vol + 3)), 10, 45);            // волатильнее → короче держим
    C.deepTicks     = cl(Math.max(med * 2, vol), 8, 40);
    C.trendTicks    = cl(Math.max(3, vol * 0.4), 3, 12);
    C.pullbackTicks = cl(med * 0.4, 1, 5);
    C.minPrintUsd   = Math.max(5, (C.sizeUsd || 20) * 0.1);
    // wallMinUsd НЕ трогаем — стены задаёт Вика сама (её поле «Размер стены ММ, $»).
  }

  function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

  // ВЫБОР стены из модели: не спуф, простояла, ≥ порога; и (защищена ИЛИ идёт absorption).
  function pickWall(side) {
    const walls = side === "buy" ? (AB._wallsBuy || []) : (AB._wallsSell || []);
    const C = AB.cfg, minUsd = C.wallMinUsd > 0 ? C.wallMinUsd : 0;
    // нестрогий режим (gateEnable=off): достаточно даже подтверждающейся стены; строгий — только confirmed/defended
    const okCls = C.gateEnable ? ["confirmed", "defended"] : ["confirming", "confirmed", "defended"];
    let cand = walls.filter((w) => okCls.indexOf(w.cls) >= 0 && w.peakUsd >= minUsd);
    if (!cand.length) return null;
    // СТРОГИЙ режим: обычную стену берём только при живой absorption; защищённую — всегда.
    // НЕСТРОГИЙ: absorption НЕ требуем — ставим лимитку у стены сразу (как раньше, чтобы можно было заходить).
    if (C.gateEnable) {
      const abs = absorbing(side);
      cand = cand.filter((w) => w.cls === "defended" || abs);
      if (!cand.length) return null;
    }
    if (C.wallMode === "near") return cand.reduce((a, b) => (b.offT < a.offT ? b : a));
    return cand.reduce((a, b) => (b.peakUsd > a.peakUsd ? b : a));   // самый жирный маркетос
  }
  // ЦЕЛЬ на сторону: гейты → выбор стены → лимитка на тик впереди стены. Гистерезис (не прыгать между стенами).
  function getTarget(side) {
    const key = side === "buy" ? "tgtBuy" : "tgtSell", C = AB.cfg, t = tk();
    const blk = quotingBlocked(side);
    if (blk) { AB[key] = null; AB._noWall = true; AB[side === "buy" ? "_blkBuy" : "_blkSell"] = blk; return null; }
    const w = pickWall(side);
    if (!w) { AB[key] = null; AB._noWall = true; AB[side === "buy" ? "_blkBuy" : "_blkSell"] = "нет стены (спуф/тонко/не absorb)"; return null; }
    AB._noWall = false; AB[side === "buy" ? "_blkBuy" : "_blkSell"] = null;
    const mkP = (wp) => side === "buy" ? snap(wp + C.aheadTicks * t) : snap(wp - C.aheadTicks * t);
    const mkTp = (pr) => side === "buy" ? snap(pr + C.profitTicks * t) : snap(pr - C.profitTicks * t);
    const cur = AB[key], H = C.hystPct || 0.3;
    if (cur) {                                                    // держимся за свою стену, пока рядом и новая не крупнее на H
      if (Math.abs(w.px - cur.wallPx) <= (C.clusterGap || 2) * t || w.peakUsd < (cur.usd || 0) * (1 + H)) {
        cur.wallPx = w.px; cur.usd = w.peakUsd; cur.price = mkP(w.px); cur.tpPrice = mkTp(cur.price); cur.offT = w.offT; cur.cls = w.cls; cur.wallVol = w.peakV; cur.wallVol0 = w.peakV;
        return cur;
      }
    }
    const price = mkP(w.px);
    AB[key] = { side, price, tpPrice: mkTp(price), wallPx: w.px, wallVol: w.peakV, wallVol0: w.peakV, usd: w.peakUsd, offT: w.offT, cls: w.cls, iceberg: !!w.iceberg, bornAt: Date.now() };
    abLog(`[цель ${side === "buy" ? "BUY" : "SELL"} ${w.cls}${w.iceberg ? " 🧊" : ""}] стена@${w.px.toFixed(dc())} $${Math.round(w.peakUsd)} ${w.offT}т → лимит@${price.toFixed(dc())}`);
    return AB[key];
  }

  // ── ВХОД: через движок getTarget (гейты + модель стены). Одна нога = ближайшая допустимая сторона. ──
  function planEntry(bb, ba, sprT) {
    const tb = getTarget("buy"), ts = getTarget("sell");
    let tgt = null;
    if (tb && ts) tgt = tb.offT <= ts.offT ? tb : ts;
    else tgt = tb || ts;
    if (!tgt) { AB._noWall = true; return null; }
    return { side: tgt.side, price: tgt.price, tpPrice: tgt.tpPrice, wallPx: tgt.wallPx, wallVol: tgt.wallVol,
             kind: `${tgt.cls}${tgt.iceberg ? " 🧊" : ""} ${tgt.offT}т $${Math.round(tgt.usd)}` };
  }
  // План для ОДНОЙ стороны (двусторонний режим) — та же цель из движка.
  function planSide(side) {
    const tgt = getTarget(side);
    if (!tgt) return null;
    return { side, price: tgt.price, tpPrice: tgt.tpPrice, wallPx: tgt.wallPx, wallVol: tgt.wallVol, offT: tgt.offT, usd: tgt.usd };
  }

  // ── PAPER двусторонний: держим лимитки с обеих сторон (qBuy/qSell), любой прострел ловим ──
  function makePaperQuote(plan) {
    const sn = now();
    return { side: plan.side, price: plan.price, vol: vol(plan.price), tpPrice: plan.tpPrice,
             wallPx: plan.wallPx, wallVol: plan.wallVol, offT: plan.offT,
             since: sn, _seen: sn, placedAt: Date.now(), queue: queueAt(plan.side, plan.price), fillVol: 0 };
  }
  function fillFromQuote(q) {                                   // одна сторона залилась → позиция + тейк + СНЯТЬ ВСЕ заявки
    const long = q.side === "buy", sn = now(), cside = long ? "sell" : "buy";
    AB.pos = { long, price: q.price, vol: q.vol, t: sn, kind: "2стор", wallPx: q.wallPx, wallVol0: q.wallVol };
    AB.close = { side: cside, price: q.tpPrice, since: sn, _seen: sn, queue: queueAt(cside, q.tpPrice), fillVol: 0 };
    AB.qBuy = null; AB.qSell = null; AB.state = "inpos";
    abLog(`✅ ЗАЛИЛО ${long ? "LONG" : "SHORT"} @${q.price.toFixed(dc())} — тейк @${q.tpPrice.toFixed(dc())} (лимитки сняты)`, "ok");
  }
  function manageSidePaper(side) {                              // ставим/держим у ЗАЛОЧЕННОЙ цели (getTarget)
    const key = side === "buy" ? "qBuy" : "qSell", cur = AB[key], tgt = getTarget(side);
    if (!tgt) { if (cur) AB[key] = null; return; }              // маркетоса нет → снять
    if (cur && ticksBetween(cur.price, tgt.price) < (AB.cfg.requoteTicks || 3)) return; // маркетос там же → держим, ждём прострел
    AB[key] = makePaperQuote(tgt);
    abLog(`[2стор ${side === "buy" ? "BUY" : "SELL"} маркетос ${tgt.offT}т $${Math.round(tgt.usd)}] @${tgt.price.toFixed(dc())}`);
  }
  function twoSidedPaperStep(bb, ba, sprT) {
    if (now() < AB.cooldownUntil) return;
    for (const key of ["qBuy", "qSell"]) { const q = AB[key]; if (q && printFilled(q)) { fillFromQuote(q); return; } }   // залив → выходим
    manageSidePaper("buy"); manageSidePaper("sell");
  }

  // ── переходы состояний ────────────────────────────────────────────────────
  function placeEntry(plan) {
    const v = vol(plan.price), sn = now();
    AB.entry = { side: plan.side, price: plan.price, vol: v, tpPrice: plan.tpPrice, kind: plan.kind,
                 wallPx: plan.wallPx, wallVol: plan.wallVol,
                 since: sn, _seen: sn, placedAt: Date.now(), queue: queueAt(plan.side, plan.price), fillVol: 0 };
    AB.state = "quoting";
    abLog(`[${plan.kind}] вход ${plan.side === "buy" ? "BUY" : "SELL"} @${plan.price.toFixed(dc())} (vol ${v}) · тейк @${plan.tpPrice.toFixed(dc())}`);
  }
  function onEntryFilled() {
    const e = AB.entry, long = e.side === "buy", sn = now(), cside = long ? "sell" : "buy";
    AB.pos = { long, price: e.price, vol: e.vol, t: sn, kind: e.kind, wallPx: e.wallPx, wallVol0: e.wallVol };
    AB.close = { side: cside, price: e.tpPrice, since: sn, _seen: sn, queue: queueAt(cside, e.tpPrice), fillVol: 0 };
    AB.entry = null; AB.state = "inpos";
    abLog(`✅ ЗАЛИЛО ${long ? "LONG" : "SHORT"} @${AB.pos.price.toFixed(dc())} — тейк @${AB.close.price.toFixed(dc())}`, "ok");
  }
  function closeAt(price, reason, taker) {
    const p = AB.pos, v = p.vol, pl = pnlUsd(p.long, p.price, price, v);
    const tks = (p.long ? price - p.price : p.price - price) / tk();
    AB.stats.trades++; if (pl >= 0) AB.stats.wins++; else AB.stats.losses++;
    AB.stats.pnlUsd += pl; AB.stats.ticksSum += tks;
    abLog(`${pl >= 0 ? "💚" : "❌"} ЗАКРЫТО (${reason}) @${price.toFixed(dc())} · ${tks >= 0 ? "+" : ""}${tks.toFixed(1)}т · ${pl >= 0 ? "+" : ""}$${pl.toFixed(3)}${taker ? " (тейкер)" : ""}`, pl >= 0 ? "ok" : "err");
    AB.pos = null; AB.close = null; AB.entry = null; AB.state = "idle"; AB._closeChasing = false;
    AB.cooldownUntil = now() + AB.cfg.cooldownSec * 1000;
  }
  // Стена-якорь ещё жива? (объём на её цене не съеден/не снят). Пока жива — заявку НЕ трогаем, ждём прострел.
  function wallAlive(order) {
    if (!order.wallPx) return false;
    return queueAt(order.side, order.wallPx) >= (order.wallVol || 0) * 0.4;
  }
  // СТРУКТУРНЫЙ выход: стену-якорь съели (на её цене осталось <40% от пика) → гипотеза «держит» не работает.
  function wallEaten(pos) {
    if (!pos.wallPx || !(pos.wallVol0 > 0)) return false;
    const side = pos.long ? "buy" : "sell";
    return queueAt(side, snap(pos.wallPx)) < pos.wallVol0 * 0.4;
  }
  // АДВЕРС-филл: после входа поток агрессивно идёт ПРОТИВ нас (нас пикнули перед ходом против).
  function adverseFill(pos) {
    const s = AB.sig; if (!s) return false;
    return pos.long ? s.imb < -AB.cfg.absImb : s.imb > AB.cfg.absImb;
  }
  function maybeRequote(bb, ba, sprT) {
    const e = AB.entry, C = AB.cfg;
    if (wallAlive(e)) return;                                   // маркетос на месте → держим заявку (ждём импульс, НЕ спамим)
    // стену съели/сняли → переанкорить на новую ближайшую
    const plan = planEntry(bb, ba, sprT);
    if (!plan) { abLog("маркетос ушёл — снимаю заявку"); AB.entry = null; AB.state = "idle"; return; }
    if (plan.side !== e.side || ticksBetween(plan.price, e.price) >= (C.requoteTicks || 3)) placeEntry(plan);
  }
  // PAPER: тейк — лимитка (мейкер); убыток/время — режем по рынку (иначе убыток не фиксируется).
  function manageCloseLimit(bb, ba) {
    const p = AB.pos, C = AB.cfg, ms = now(), t = tk();
    const adverse = p.long ? bb : ba, lossT = p.long ? (p.price - adverse) / t : (adverse - p.price) / t;
    const held = ms - p.t;
    // «пора выходить активнее» — но ВСЁ РАВНО ЛИМИТКОЙ (мейкер, 0 комсы), НЕ по рынку.
    const reason = (held > 1000 && wallEaten(p)) ? "стену съели"
      : (held > C.adverseSec * 1000 && lossT >= 1 && adverseFill(p)) ? "адверс"
      : (lossT >= C.stopTicks) ? `стоп ${C.stopTicks}т`
      : (held >= C.maxHoldSec * 1000) ? `время ${C.maxHoldSec}с` : null;
    if (reason && AB.close) {                                    // переставить закр.лимитку на maker-край выхода (лонг→ask, шорт→bid) — ловим спред, комса 0
      const mk = p.long ? snap(ba) : snap(bb);
      if (Math.abs(AB.close.price - mk) >= t * 0.5) { AB.close.price = mk; AB.close.since = ms; AB.close._seen = ms; AB.close.queue = queueAt(AB.close.side, mk); AB.close.fillVol = 0; if (!AB._closeChasing) abLog(`↩ выход лимиткой (${reason}) @${mk.toFixed(dc())}`); AB._closeChasing = true; }
    }
    // фактический филл проверяется в step() через printFilled(AB.close) (мейкер, taker=false). Рынком НЕ закрываем.
  }

  // ── главный цикл ──────────────────────────────────────────────────────────
  // Снять ВСЕ рабочие заявки бота (реал) — при Стопе / смене режима / монеты. Позицию не трогаем.
  function cancelBotOrders() {
    try {
      if (S.exMexc) { if (AB._mexcConn) mexcCancelAllReal(); }
      else if (typeof cancelAll === "function") cancelAll();
    } catch (e) {}
  }
  function resetRuntime(silent) {
    if (!AB.paper) {                                            // РЕАЛ: ВСЕГДА снять свои заявки (в двустороннем entry не заполняется!)
      cancelBotOrders();
      if (AB.pos) abLog("⚠ позиция ОСТАЛАСЬ открыта — закрой вручную (D/Alt-клик)", "err");
      else abLog("снял заявки бота");
    }
    AB.state = "idle"; AB.entry = null; AB.pos = null; AB.close = null;
    AB.qBuy = null; AB.qSell = null; AB.rqBuy = null; AB.rqSell = null; AB.io = {};
    AB._deadBuy = 0; AB._deadSell = 0; AB.tgtBuy = null; AB.tgtSell = null; AB.cooldownUntil = 0;
    if (!silent && AB.paper) abLog("сброс");
  }
  // Стена ММ: если Вика НЕ вписала вручную — тянем из стакана «Крупный объём USD»; вписала — не трогаем.
  function syncWall() {
    if (AB._wallManual) return;
    const src = (S.big1USD > 0 ? S.big1USD : 0) || (S.big2USD > 0 ? S.big2USD : 0);
    if (src > 0) AB.cfg.wallMinUsd = src;
  }
  // ── РЕАЛ: можно ли торговать вживую. MEXC — через веб-токен клиента; Ourbit — через терминал. ──
  function realBlockReason() {
    if (S.exMexc) {
      if (!AB._mexcConn) return "MEXC не подключён — вставь Web UID и «Сохранить ключ»";
      return null;   // согласие = токен сохранён + бот в РЕАЛ (подтверждение было)
    }
    if (S.exWeex) return "WEEX — реал бота пока Ourbit/MEXC";
    if (typeof sendOrder !== "function" || typeof SIDE === "undefined" || typeof OT === "undefined" || !window.T) return "нет торгового модуля";
    if (!window.T.connected) return "не подключён — вставь uc_token и «Подключить»";
    if (!window.T.armed) return "включи LIVE в терминале (галка LIVE)";
    return null;
  }
  // ── MEXC реал: ордера через /api/mexcorder, позицию читаем поллингом /api/mexcaccount ──
  function abPost(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(async (r) => { try { return await r.json(); } catch (e) { return { ok: false, error: "старый сервер (нет роута) — перезапусти start.bat", http: r.status }; } })
      .catch(() => ({ ok: false, error: "нет связи с сервером — перезапусти start.bat" }));
  }
  function mexcOrder(side, otype, price, vol, positionId) {
    return abPost("/api/mexcorder", { symbol: S.symbol, side, otype, vol, price: snap(price), leverage: S.lev || 20, positionId: positionId || 0 });
  }
  function mexcCancelAllReal() { return abPost("/api/mexccancelall", { symbol: S.symbol }); }
  function mexcPos() { const a = AB._mexcAcct; return (a && a.positions && a.positions[0]) || null; }
  const RSIDE = { OPEN_LONG: 1, CLOSE_SHORT: 2, OPEN_SHORT: 3, CLOSE_LONG: 4 }, ROT = { LIMIT: 1, MARKET: 5 };
  function mexcCloseMarket(pos) { return mexcOrder(pos.side === 1 ? RSIDE.CLOSE_LONG : RSIDE.CLOSE_SHORT, ROT.MARKET, 0, pos.vol, pos.id); }
  // Ответ на закрытие: «позиция закрыта/нет» (2009/2008) → бот В IDLE (не долбить закрытие).
  function closeRespIdle(r) {
    const code = r && r.resp && r.resp.code;
    if (code === 2009 || code === 2008) { AB.pos = null; AB.close = null; AB.state = "idle"; AB.io = {}; AB._realCd = Date.now() + 2000; abLog("позиция уже закрыта — сброс", "ok"); return true; }
    return false;
  }
  async function mexcAcctPoll() {
    if (AB.paper || !S.exMexc || !AB._mexcConn || !AB.on) return;
    try { const r = await fetch("/api/mexcaccount?symbol=" + encodeURIComponent(S.symbol)).then((x) => x.json()); if (r && r.ok) AB._mexcAcct = r; } catch (e) {}
  }
  // ── МЕХАНИЗМ INTENT per-side: NONE→PENDING→LIVE с таймаутом ожидания поллинга (анти-дубль, устойчив к лагу) ──
  const IO_PENDING_MS = 3000;
  function ioSlot(side) { if (!AB.io) AB.io = {}; return AB.io[side] || (AB.io[side] = { state: "NONE", price: 0, id: 0, at: 0, busy: false }); }
  const REQ_GAP_MS = 1300;      // не чаще ~1 запроса/1.3с к MEXC (иначе «Requests are too frequent»)
  function reqThrottled(ms) { return ms < (AB._reqCd || 0); }
  function markReq(ms) { AB._reqCd = ms + REQ_GAP_MS; }
  function cancelSideById(side, id) { const io = ioSlot(side); io.busy = true; markReq(Date.now()); abPost("/api/mexccancel", { id }).then(() => { io.busy = false; io.state = "NONE"; io.id = 0; }); }
  function placeSide(side, want, ms) {
    const io = ioSlot(side); io.busy = true; io.state = "PENDING"; io.price = want.price; io.at = ms; markReq(ms);
    const oside = side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT;
    mexcOrder(oside, ROT.LIMIT, want.price, vol(want.price), 0).then((r) => {
      io.busy = false;
      if (r && r.ok) abLog(`[РЕАЛ ${side === "buy" ? "BUY" : "SELL"}] стена@${(want.wallPx || 0).toFixed(dc())} $${Math.round(want.usd || 0)} → лимит@${want.price.toFixed(dc())} (${want.offT}т) · ордер ${vol(want.price)} контр ≈ $${Math.round(vol(want.price) * want.price * cs())}`);
      else {                                                     // ОТКАЗ → пауза на эту сторону (не долбим биржу), причина в лог
        const msg = (r && (r.error || (r.resp && r.resp.message))) || "?";
        io.state = "NONE"; io.retryAt = Date.now() + (/frequent|too many|429/i.test(msg) ? 8000 : 6000);
        abLog(`MEXC ${side} отклонён: ${msg}`, "err");
      }
    });
  }
  // Реконсилер ОДНОЙ стороны: приводим реальные ордера к желаемому (ровно 1 у цели). Устойчив к лагу поллинга.
  function reconcileSide(side, want, orders, ms) {
    const io = ioSlot(side), t = tk();
    const openSide = side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT;
    const tol = ((AB.cfg.requoteTicks || 3) + 0.5) * t;
    const mine = orders.filter((o) => o.side === openSide);
    const live = mine[0] || null;
    if (live) { io.state = "LIVE"; io.id = live.id; io.price = live.price; }
    else if (io.state === "LIVE") { io.state = "GONE"; io.at = ms; return; }   // была LIVE, исчезла → МОГЛА ЗАЛИТЬСЯ! ждём поллинг позиции, НЕ ставим новую (анти-накопление)
    else if (io.state === "GONE" || io.state === "PENDING") { if (ms - io.at > IO_PENDING_MS) io.state = "NONE"; else return; }   // ждём отражения — НЕ дублируем
    if (io.busy || reqThrottled(ms) || ms < (io.retryAt || 0)) return;   // троттл частоты + пауза после отказа
    if (mine.length > 1) { cancelSideById(side, mine[1].id); return; }   // дедуп: лишний снять
    if (want == null) { if (live) cancelSideById(side, live.id); else io.state = "NONE"; return; }
    if (live) { if (Math.abs(live.price - want.price) > tol) cancelSideById(side, live.id); return; }   // цена совпала → СТОИМ (ждём прострел)
    placeSide(side, want, ms);
  }
  // Переход в позицию (один раз): снять обе входные, поставить reduce-лимитку.
  function enterPos(pos, ms) {
    if (AB.state === "inpos" && AB.pos) return;
    const long = pos.side === 1, t = tk(), C = AB.cfg;
    const tp = long ? snap(pos.avg + C.profitTicks * t) : snap(pos.avg - C.profitTicks * t);
    mexcCancelAllReal(); AB.io = {};
    AB.pos = { long, price: pos.avg, vol: pos.vol, t: ms, kind: "2стор", wallPx: (long ? (AB.tgtBuy && AB.tgtBuy.wallPx) : (AB.tgtSell && AB.tgtSell.wallPx)) || 0, wallVol0: (long ? (AB.tgtBuy && AB.tgtBuy.wallVol0) : (AB.tgtSell && AB.tgtSell.wallVol0)) || 0 };
    AB.close = { side: long ? "sell" : "buy", price: tp, id: 0, state: "NONE", busy: false, at: 0 };
    AB.state = "inpos"; AB._closeChasing = false;
    abLog(`✅ РЕАЛ MEXC залило ${long ? "LONG" : "SHORT"} @${pos.avg} — тейк-лимит @${tp.toFixed(dc())} (входные сняты)`, "ok");
  }
  // Управление позицией MEXC: ровно ОДНА reduce-лимитка. Маркет — ТОЛЬКО авария (позиция >3× лота).
  function mexcManagePos(bb, ba) {
    const C = AB.cfg, t = tk(), ms = Date.now(), pos = mexcPos();
    if (!(pos && pos.vol > 0)) {
      if (AB.state === "inpos") { AB.stats.trades++; abLog("💚 РЕАЛ MEXC позиция закрыта (лимит)", "ok"); }
      AB.pos = null; AB.close = null; AB.state = "idle"; AB.io = {}; AB._closeChasing = false; AB._realCd = ms + C.cooldownSec * 1000; return;
    }
    const long = pos.side === 1, cside = long ? RSIDE.CLOSE_LONG : RSIDE.CLOSE_SHORT;
    const cl = AB.close || (AB.close = { side: long ? "sell" : "buy", price: 0, id: 0, state: "NONE", busy: false, at: 0 });
    const usd = pos.vol * cs() * (long ? bb : ba);
    if (usd > lotUsd(long ? bb : ba) * 1.5) { abLog(`🛑 позиция ${Math.round(usd)}$ > 1.5× лота — накопление! аварийно закрываю по рынку`, "err"); if (!reqThrottled(ms)) { markReq(ms); mexcCancelAllReal(); mexcCloseMarket(pos).then(closeRespIdle); } return; }
    // ВЫХОД ТОЛЬКО ЛИМИТКОЙ (мейкер, 0 комсы). При «пора выходить» переставляем reduce-лимитку на maker-край, НЕ по рынку.
    const adverse = long ? bb : ba, lossT = long ? (AB.pos.price - adverse) / t : (adverse - AB.pos.price) / t;
    const held = ms - AB.pos.t;
    const structural = held > 1200 && wallEaten(AB.pos), advHit = held > C.adverseSec * 1000 && lossT >= 1 && adverseFill(AB.pos);
    const wantOut = structural || advHit || lossT >= C.stopTicks || held >= C.maxHoldSec * 1000;
    const tp = long ? snap(AB.pos.price + C.profitTicks * t) : snap(AB.pos.price - C.profitTicks * t);
    const makerEdge = long ? snap(ba) : snap(bb);             // лонг закрываем ПРОДАЖЕЙ по ask, шорт — ПОКУПКОЙ по bid (мейкер, ловим спред)
    const target = (C.exitMaker && wantOut) ? makerEdge : tp;
    if (Math.abs((cl.price || 0) - target) >= t * 0.5) {
      cl.price = target;
      if (wantOut && !AB._closeChasing) { AB._closeChasing = true; abLog(`↩ РЕАЛ выход ЛИМИТКОЙ (${structural ? "стену съели" : advHit ? "адверс" : lossT >= C.stopTicks ? "стоп" : "время"}) @${target.toFixed(dc())}`); }
    }
    // реконсилер ЗАКРЫТИЯ: ровно одна reduce-лимитка на cl.price (переставит на новую цену, если сместилась/отклонена)
    const orders = (AB._mexcAcct && AB._mexcAcct.orders) || [];
    const closes = orders.filter((o) => o.side === cside);
    const tol = ((C.requoteTicks || 3) + 0.5) * t;
    const good = closes.find((o) => Math.abs(o.price - cl.price) <= tol);
    if (good) { cl.state = "LIVE"; cl.id = good.id; return; }
    if (cl.busy || reqThrottled(ms) || ms < (cl.retryAt || 0)) return;   // троттл частоты + пауза после отказа
    const extra = closes.find((o) => o !== good);
    if (extra) { cl.busy = true; markReq(ms); abPost("/api/mexccancel", { id: extra.id }).then(() => { cl.busy = false; }); return; }
    if (cl.state === "PENDING") { if (ms - cl.at > IO_PENDING_MS) cl.state = "NONE"; else return; }
    cl.busy = true; cl.state = "PENDING"; cl.at = ms; markReq(ms);
    mexcOrder(cside, ROT.LIMIT, cl.price, pos.vol, pos.id).then((r) => { cl.busy = false; if (!(r && r.ok) && !closeRespIdle(r)) { cl.state = "NONE"; cl.retryAt = Date.now() + 6000; abLog("тейк-лимит отклонён — пауза", "err"); } });
  }
  // MEXC двусторонний — реконсилер обеих сторон + переход в позицию.
  function realStepMexcTwo(bb, ba) {
    const reason = realBlockReason(); if (reason) { AB._realReason = reason; return; }
    AB._realReason = null;
    const ms = Date.now(), pos = mexcPos();
    if (pos && pos.vol > 0) { enterPos(pos, ms); mexcManagePos(bb, ba); return; }   // залив
    if (AB.state === "inpos") { mexcManagePos(bb, ba); return; }                     // позиция ушла из поллинга — закроем цикл
    const orders = (AB._mexcAcct && AB._mexcAcct.orders) || [];
    if (orders.length > 3 && !AB._mexcBusy) {                    // СТРАХОВКА: любой сбой сопоставления → не даём накопиться
      AB._mexcBusy = true; abLog(`⚠ ${orders.length} заявок на бирже — снимаю ВСЕ (страховка)`, "err");
      mexcCancelAllReal().then(() => { AB._mexcBusy = false; }); AB.io = {}; return;
    }
    reconcileSide("buy", getTarget("buy"), orders, ms);
    reconcileSide("sell", getTarget("sell"), orders, ms);
  }
  function realStepMexc(bb, ba, sprT) {
    const reason = realBlockReason();
    if (reason) { AB._realReason = reason; return; }
    AB._realReason = null;
    if (AB.twoSided) { realStepMexcTwo(bb, ba); return; }       // двусторонний режим
    const t = tk(), C = AB.cfg, ms = Date.now(), pos = mexcPos();
    if (AB.state === "idle") {
      if (ms < (AB._realCd || 0) || AB._mexcBusy) return;
      const plan = planEntry(bb, ba, sprT); if (!plan) return;
      const v = vol(plan.price), side = plan.side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT;
      AB._mexcBusy = true;
      mexcOrder(side, ROT.LIMIT, plan.price, v, 0).then((r) => {
        AB._mexcBusy = false;
        if (r && r.ok) { AB.entry = { side: plan.side, price: plan.price, vol: v, tpPrice: plan.tpPrice, kind: plan.kind, wallPx: plan.wallPx, wallVol: plan.wallVol, placedAt: ms }; AB.state = "quoting"; abLog(`[РЕАЛ MEXC ${plan.kind}] вход ${plan.side === "buy" ? "BUY" : "SELL"} @${plan.price.toFixed(dc())}`); }
        else abLog("MEXC вход отклонён: " + ((r && (r.error || (r.resp && r.resp.message))) || "?"), "err");
      });
    } else if (AB.state === "quoting" && AB.entry) {
      if (pos && pos.vol > 0) {
        const long = pos.side === 1, cside = long ? RSIDE.CLOSE_LONG : RSIDE.CLOSE_SHORT, tp = AB.entry.tpPrice;
        mexcCancelAllReal();
        mexcOrder(cside, ROT.LIMIT, tp, pos.vol, pos.id);
        AB.pos = { long, price: pos.avg, vol: pos.vol, t: ms, kind: AB.entry.kind }; AB.close = { price: tp }; AB.entry = null; AB.state = "inpos";
        abLog(`✅ РЕАЛ MEXC залило ${long ? "LONG" : "SHORT"} @${pos.avg} — тейк @${tp.toFixed(dc())}`, "ok");
      } else if (!wallAlive(AB.entry) && !AB._mexcBusy) {         // стену съели/сняли → переанкорить (иначе ДЕРЖИМ, ждём прострел, НЕ спамим)
        const plan = planEntry(bb, ba, sprT);
        if (!plan) { AB._mexcBusy = true; mexcCancelAllReal().then(() => { AB._mexcBusy = false; }); AB.entry = null; AB.state = "idle"; AB._realCd = ms + 800; abLog("маркетос ушёл — снял заявку"); }
        else if (plan.side !== AB.entry.side || ticksBetween(plan.price, AB.entry.price) >= (C.requoteTicks || 3)) {
          AB._mexcBusy = true; mexcCancelAllReal();
          mexcOrder(plan.side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT, ROT.LIMIT, plan.price, vol(plan.price), 0).then((r) => { AB._mexcBusy = false; });
          AB.entry = { side: plan.side, price: plan.price, vol: vol(plan.price), tpPrice: plan.tpPrice, kind: plan.kind, wallPx: plan.wallPx, wallVol: plan.wallVol, placedAt: ms };
          abLog("переставил (маркетос сместился)");
        }
      }
    } else if (AB.state === "inpos" && AB.pos) {
      mexcManagePos(bb, ba);   // закрытие лимиткой (см. общий обработчик)
      if (false) {
        const usd = pos.vol * cs() * (AB.pos.long ? bb : ba);
        if (usd > C.sizeUsd * 2) { abLog("🛑 MEXC позиция превысила лимит — аварийно закрываю, стоп бота", "err"); mexcCancelAllReal(); mexcCloseMarket(pos); AB.on = false; syncToggleBtn(); return; }
        const adverse = AB.pos.long ? bb : ba, lossT = AB.pos.long ? (AB.pos.price - adverse) / t : (adverse - AB.pos.price) / t;
        if (lossT >= C.stopTicks) { abLog(`РЕАЛ MEXC стоп ${C.stopTicks}т`, "err"); mexcCancelAllReal(); mexcCloseMarket(pos); }
        else if (ms - AB.pos.t >= C.maxHoldSec * 1000) { mexcCancelAllReal(); mexcCloseMarket(pos); }
      }
    }
  }
  // РЕАЛЬНЫЙ движок: постит настоящие лимитки через терминал (sendOrder), позицию читает из T.pos.
  function realStep(bb, ba, sprT) {
    const reason = realBlockReason();
    if (reason) { AB._realReason = reason; return; }
    AB._realReason = null;
    const T = window.T, t = tk(), C = AB.cfg, ms = Date.now();
    if (AB.state === "idle") {
      if (ms < (AB._realCd || 0)) return;
      const plan = planEntry(bb, ba, sprT); if (!plan) return;
      const v = vol(plan.price), side = plan.side === "buy" ? SIDE.OPEN_LONG : SIDE.OPEN_SHORT;
      sendOrder(side, OT.LIMIT, plan.price, "AB вход " + plan.kind, v);
      AB.entry = { side: plan.side, price: plan.price, vol: v, tpPrice: plan.tpPrice, kind: plan.kind, wallPx: plan.wallPx, wallVol: plan.wallVol, placedAt: ms };
      AB.state = "quoting";
      abLog(`[РЕАЛ ${plan.kind}] вход ${plan.side === "buy" ? "BUY" : "SELL"} @${plan.price.toFixed(dc())}`);
    } else if (AB.state === "quoting" && AB.entry) {
      if (T.pos && T.pos.vol > 0) {                                   // залило (появилась реальная позиция)
        const long = T.pos.side === 1, cside = long ? SIDE.CLOSE_LONG : SIDE.CLOSE_SHORT;
        const tp = AB.entry.tpPrice;
        cancelAll();                                                  // снять остаток входной заявки (защита от накопления)
        sendOrder(cside, OT.LIMIT, tp, "AB тейк", T.pos.vol, T.pos.id);
        AB.pos = { long, price: T.pos.avg, vol: T.pos.vol, t: ms, kind: AB.entry.kind };
        AB.close = { price: tp }; AB.entry = null; AB.state = "inpos";
        abLog(`✅ РЕАЛ залило ${long ? "LONG" : "SHORT"} @${T.pos.avg} — тейк @${tp.toFixed(dc())}`, "ok");
      } else if (!wallAlive(AB.entry)) {                              // стену съели/сняли → переанкорить (иначе ДЕРЖИМ, ждём прострел)
        const plan = planEntry(bb, ba, sprT);
        if (!plan) { cancelAll(); AB.entry = null; AB.state = "idle"; AB._realCd = ms + 800; abLog("маркетос ушёл — снял заявку"); }
        else if (plan.side !== AB.entry.side || ticksBetween(plan.price, AB.entry.price) >= (C.requoteTicks || 3)) {
          cancelAll(); sendOrder(plan.side === "buy" ? SIDE.OPEN_LONG : SIDE.OPEN_SHORT, OT.LIMIT, plan.price, "AB вход " + plan.kind, vol(plan.price));
          AB.entry = { side: plan.side, price: plan.price, vol: vol(plan.price), tpPrice: plan.tpPrice, kind: plan.kind, wallPx: plan.wallPx, wallVol: plan.wallVol, placedAt: ms };
          abLog("переставил (маркетос сместился)");
        }
      }
    } else if (AB.state === "inpos" && AB.pos) {
      if (!(T.pos && T.pos.vol > 0)) {                                // позиции нет → закрылось
        AB.stats.trades++; abLog("💚 РЕАЛ позиция закрыта", "ok");
        AB.pos = null; AB.close = null; AB.state = "idle"; AB._closeChasing = false; AB._realCd = ms + C.cooldownSec * 1000;
      } else {
        const usd = T.pos.vol * cs() * (AB.pos.long ? bb : ba);
        if (usd > lotUsd(AB.pos.long ? bb : ba) * 2) { abLog("🛑 РЕАЛ позиция превысила лимит — аварийно закрываю по рынку, стоп бота", "err"); cancelAll(); closePos(); AB.on = false; syncToggleBtn(); return; }
        const adverse = AB.pos.long ? bb : ba, lossT = AB.pos.long ? (AB.pos.price - adverse) / t : (adverse - AB.pos.price) / t;
        const wantOut = lossT >= C.stopTicks || (ms - AB.pos.t >= C.maxHoldSec * 1000);
        if (C.exitMaker && wantOut && !AB._closeChasing) {       // ВЫХОД ЛИМИТКОЙ (мейкер): переставить закр.заявку на maker-край, НЕ по рынку
          const mk = AB.pos.long ? snap(ba) : snap(bb);
          AB._closeChasing = true; cancelAll();
          sendOrder(AB.pos.long ? SIDE.CLOSE_LONG : SIDE.CLOSE_SHORT, OT.LIMIT, mk, "AB выход лимит", T.pos.vol, T.pos.id);
          abLog(`↩ РЕАЛ выход ЛИМИТКОЙ (${lossT >= C.stopTicks ? "стоп" : "время"}) @${mk.toFixed(dc())}`);
        } else if (!C.exitMaker && wantOut) { abLog(`РЕАЛ выход по рынку`, "err"); cancelAll(); closePos(); }
      }
    }
  }

  let _lastTune = 0;
  function step() {
    const nowMs = Date.now();
    syncWall();
    if (nowMs - _lastTune > 1200) { _lastTune = nowMs; autoTune(); }   // подбор параметров под монету (и когда выключен — для readout)
    if (S.bestBid && S.bestAsk && S.depth) { updateSignals(); stepWalls(); }   // движок order-flow (нужен и для readout панели)
    if (AB.on) {
      if (AB._sym !== S.symbol) { resetRuntime(); AB._sym = S.symbol; AB._volHist = []; AB._midHist = []; AB.wallTrk = { buy: new Map(), sell: new Map() }; AB._wallsBuy = []; AB._wallsSell = []; AB._wallSeenT = 0; }   // новая монета → сбросить базис объёма и трекинг стен
      const bb = S.bestBid, ba = S.bestAsk, t = tk();
      if (bb && ba && ba > bb) {
        const sprT = Math.round((ba - bb) / t);
        if (!AB.paper) { if (S.exMexc) realStepMexc(bb, ba, sprT); else realStep(bb, ba, sprT); }   // РЕАЛ (MEXC через веб-токен / Ourbit через терминал)
        else if (AB.state === "inpos" && AB.pos) { if (AB.close && printFilled(AB.close)) closeAt(AB.close.price, "тейк", false); else manageCloseLimit(bb, ba); }
        else if (AB.twoSided) { twoSidedPaperStep(bb, ba, sprT); }                                  // PAPER двусторонний (лимитки с обеих сторон)
        else if (AB.state === "quoting" && AB.entry) { if (printFilled(AB.entry)) onEntryFilled(); else maybeRequote(bb, ba, sprT); }
        else if (AB.state === "idle" && now() >= AB.cooldownUntil) { const plan = planEntry(bb, ba, sprT); if (plan) placeEntry(plan); }
      }
    }
    render();
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById("ab-style")) return;
    const s = document.createElement("style"); s.id = "ab-style";
    s.textContent = `
    #abwin{position:fixed;right:20px;top:100px;width:320px;background:#141922;border:1px solid #2a3340;border-radius:10px;
      font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#c7d0da;z-index:9000;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none;max-height:90vh;overflow:auto}
    #abwin.show{display:block}
    #ab-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a3340;cursor:move;user-select:none;position:sticky;top:0;background:#141922;z-index:2}
    #ab-head b{font-size:13px}
    #ab-paper{margin-left:auto;font-size:10px;font-weight:800;color:#111;background:#e6c34a;border-radius:4px;padding:2px 8px;cursor:pointer;user-select:none}
    #ab-paper.real{background:#d93a3a;color:#fff}
    #ab-x{cursor:pointer;color:#7a8697;padding:0 4px}
    #ab-body{padding:8px 10px}
    #ab-toggle{width:100%;padding:8px;border:none;border-radius:8px;font-weight:800;font-size:14px;cursor:pointer;letter-spacing:.3px}
    #ab-toggle.off{background:#1f6f43;color:#dfffe9}
    #ab-toggle.on{background:#7a2530;color:#ffd9d6}
    .ab-row{display:flex;gap:6px;align-items:center;margin:5px 0}
    .ab-row label{flex:1;color:#8a95a4;font-size:11px}
    .ab-row input{width:78px;background:#0e131b;border:1px solid #2a3340;color:#cfe;border-radius:6px;padding:3px 5px;font-size:12px}
    .ab-row.full input{width:100%}
    .ab-sec{margin:8px 0 4px;color:#6f7c8c;font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-top:1px solid #202833;padding-top:7px}
    .ab-cl{cursor:pointer;user-select:none}
    .ab-cl:hover{color:#9fc0ff}
    .ab-sub{color:#5f6b7a;font-size:10px;text-transform:none;letter-spacing:0}
    .ab-strat{background:#0e131b;border:1px solid #202833;border-radius:8px;padding:7px;font-size:11px;color:#9fc0ff;line-height:1.5;margin-top:5px}
    .ab-autochk{display:flex;align-items:center;gap:6px;margin:7px 0 5px;font-size:12px;cursor:pointer;color:#cfe}
    .ab-autochk input{width:auto;margin:0}
    #ab-status{background:#0e131b;border:1px solid #202833;border-radius:8px;padding:7px;font-size:11px;line-height:1.55;margin-top:8px}
    #ab-status .st{font-weight:800}
    .ab-stats{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px}
    .ab-stat{background:#0e131b;border:1px solid #202833;border-radius:7px;padding:5px 8px}
    .ab-stat .k{color:#6f7c8c;font-size:10px}
    .ab-stat .v{font-weight:800;font-size:14px}
    #ab-log{margin-top:6px;max-height:110px;overflow:auto;font:11px/1.5 ui-monospace,Menlo,monospace}
    #ab-log div{padding:1px 0;border-bottom:1px solid #1a212b;color:#95a1b0}
    #ab-log .ok{color:#6fcf91}
    #ab-log .err{color:#ef938f}
    #ab-btn{cursor:pointer}
    #ab-btn.live{color:#ffce54}
    .ab-exrow{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
    .ab-exrow button{padding:4px 9px;background:#0e131b;border:1px solid #2a3340;color:#8a95a4;border-radius:14px;cursor:pointer;font-size:11px;font-weight:600}
    .ab-exrow button.on{background:#233152;color:#9fc0ff;border-color:#3a4d78}
    .ab-ct{display:flex;gap:4px;margin-bottom:6px}
    .ab-ct button{flex:1;padding:5px;background:#0e131b;border:1px solid #2a3340;color:#8a95a4;border-radius:6px;cursor:pointer;font-size:11px}
    .ab-ct button.on{background:#233152;color:#9fc0ff;border-color:#3a4d78}
    #ab-connsave{flex:1;background:#233152;border:1px solid #3a4d78;color:#cfe0ff;border-radius:6px;padding:6px;cursor:pointer;font-weight:600}
    #ab-connstat{font-size:10px;color:#6fcf91;flex:1}
    .ab-note{font-size:10px;color:#7a8697;margin-top:4px;line-height:1.4}
    .ab-crow{display:flex;gap:5px;margin-top:8px}
    .ab-crow button{flex:1;background:#0e131b;border:1px solid #2a3340;color:#8a95a4;border-radius:6px;padding:5px;cursor:pointer;font-size:11px}
    `;
    document.head.appendChild(s);
  }

  function credFieldsHTML() {
    const c = AB.conn;
    if (c.type === "uid") {
      return `<div class="ab-row full"><input id="ab-uid" placeholder="Web UID / токен (из браузера биржи)" value="${c.uid || ""}"></div>`;
    }
    let h = `<div class="ab-row full"><input id="ab-key" placeholder="API Key" value="${c.key || ""}"></div>
             <div class="ab-row full"><input id="ab-secret" type="password" placeholder="Secret" value="${c.secret || ""}"></div>`;
    if (NEEDS_PASS[c.ex]) h += `<div class="ab-row full"><input id="ab-pass" type="password" placeholder="Passphrase" value="${c.pass || ""}"></div>`;
    return h;
  }

  function buildWindow() {
    const w = document.createElement("div"); w.id = "abwin";
    w.innerHTML = `
    <div id="ab-head"><b>🤖 Автобот</b><span id="ab-paper" title="клик — переключить PAPER / РЕАЛ">PAPER</span><span id="ab-x">✕</span></div>
    <div id="ab-body">
      <button id="ab-toggle" class="off">▶ Старт</button>

      <div class="ab-row full"><input id="ab-coin" list="symlist" placeholder="монета (VANRY, BTC…)" autocomplete="off" spellcheck="false"></div>
      <div class="ab-note" id="ab-coinnow">—</div>

      <div class="ab-sec ab-cl" data-box="ab-connbox">▸ Биржа и ключ <span id="ab-connx" class="ab-sub"></span></div>
      <div id="ab-connbox" style="display:none">
        <div class="ab-exrow" id="ab-exrow"></div>
        <div class="ab-ct" id="ab-ct"><button data-ct="api">API ключ</button><button data-ct="uid">Web UID</button></div>
        <div id="ab-credfields"></div>
        <div class="ab-row"><button id="ab-connsave">Сохранить ключ</button><span id="ab-connstat"></span></div>
      </div>

      <div class="ab-ct" id="ab-sizemode"><button data-sm="usd">💵 В долларах</button><button data-sm="contracts">📦 В контрактах</button></div>
      <div class="ab-row"><label id="ab-sizelbl">Размер лота, $</label><input type="number" id="ab-size" step="1"></div>
      <div class="ab-row"><label>🧱 Стена ММ, $ <span class="ab-sub">задаёшь ты</span></label><input type="number" id="ab-wallusd" step="50"></div>
      <div class="ab-crow"><button id="ab-wallpull">↧ из стакана</button></div>
      <div class="ab-note" id="ab-wallinfo" style="color:#e6c34a">🧱 стена ММ: —</div>
      <div class="ab-ct" id="ab-wallmode"><button data-wm="biggest">🏆 Крупнейшая</button><button data-wm="near">📎 Ближняя</button></div>
      <div class="ab-note" id="ab-fixinfo" style="color:#7fd0ff">💵 ордер: —</div>
      <label class="ab-autochk"><input type="checkbox" id="ab-two"> ⇅ <b>Обе стороны</b> <span class="ab-sub">(лимитки сверху и снизу)</span></label>
      <label class="ab-autochk"><input type="checkbox" id="ab-strict"> 🎯 <b>Строгий режим</b> <span class="ab-sub">(ждать absorption; выкл = ставить у стены сразу)</span></label>
      <label class="ab-autochk"><input type="checkbox" id="ab-auto"> ⚙ <b>Авто под монету</b> <span class="ab-sub">(гейт/тейк/стоп)</span></label>
      <div id="ab-autoline" class="ab-strat">—</div>
      <div class="ab-sec ab-cl" data-box="ab-manual">▸ Ручная настройка</div>
      <div id="ab-manual" style="display:none">
        <div class="ab-row"><label>Тейк, тиков</label><input type="number" id="ab-profit" step="1"></div>
        <div class="ab-row"><label>Гейт спреда, тиков</label><input type="number" id="ab-gate" step="1"></div>
        <div class="ab-row"><label>Стоп, тиков</label><input type="number" id="ab-stop" step="1"></div>
        <div class="ab-row"><label>Макс. держать, сек</label><input type="number" id="ab-hold" step="1"></div>
        <div class="ab-row"><label>Впереди ММ, тиков</label><input type="number" id="ab-ahead" step="1"></div>
        <div class="ab-row"><label>Глубина стены, тиков</label><input type="number" id="ab-deep" step="1"></div>
        <div class="ab-row"><label>Порог стены (доля)</label><input type="number" id="ab-wallfrac" step="0.05"></div>
        <div class="ab-row"><label>Тейк прострела (доля)</label><input type="number" id="ab-tpfrac" step="0.1"></div>
        <div class="ab-row"><label>Окно тренда, сек</label><input type="number" id="ab-tsec" step="1"></div>
        <div class="ab-row"><label>Мин. ход тренда, тиков</label><input type="number" id="ab-tticks" step="1"></div>
        <div class="ab-row"><label>Откат входа, тиков</label><input type="number" id="ab-pull" step="1"></div>
      </div>

      <div id="ab-status">—</div>
      <div class="ab-stats">
        <div class="ab-stat"><div class="k">Сделок</div><div class="v" id="ab-trades">0</div></div>
        <div class="ab-stat"><div class="k">Винрейт</div><div class="v" id="ab-win">—</div></div>
        <div class="ab-stat"><div class="k">PnL</div><div class="v" id="ab-pnl">$0</div></div>
        <div class="ab-stat"><div class="k">Ø тиков</div><div class="v" id="ab-avgt">—</div></div>
      </div>
      <div class="ab-crow"><button id="ab-reset">Сброс</button><button id="ab-logtgl" data-box="ab-log">Лог ▸</button></div>
      <div id="ab-log" style="display:none"></div>
    </div>`;
    document.body.appendChild(w);
    wireWindow(w);
    return w;
  }

  function bindNum(id, key) {
    const el = document.getElementById(id); if (!el) return;
    el.value = AB.cfg[key];
    el.onchange = () => { const v = parseFloat(el.value); if (!isNaN(v)) { AB.cfg[key] = v; saveState(); } };
  }

  function renderExchanges(w) {
    const box = w.querySelector("#ab-exrow"); if (!box) return;
    box.innerHTML = EXCHANGES.map(([id, name]) => `<button data-ex="${id}" class="${AB.conn.ex === id ? "on" : ""}">${name}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { AB.conn.ex = b.dataset.ex; box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); renderCredFields(w); saveState(); };
    });
  }
  function renderCredType(w) {
    w.querySelectorAll("#ab-ct button").forEach((b) => {
      b.classList.toggle("on", b.dataset.ct === AB.conn.type);
      b.onclick = () => { AB.conn.type = b.dataset.ct; w.querySelectorAll("#ab-ct button").forEach((x) => x.classList.toggle("on", x === b)); renderCredFields(w); saveState(); };
    });
  }
  function renderCredFields(w) {
    const box = w.querySelector("#ab-credfields"); if (!box) return;
    box.innerHTML = credFieldsHTML();
    const bind = (id, key) => { const el = box.querySelector("#" + id); if (el) el.oninput = () => { AB.conn[key] = el.value.trim(); }; };
    bind("ab-uid", "uid"); bind("ab-key", "key"); bind("ab-secret", "secret"); bind("ab-pass", "pass");
  }

  function applyAutoUI(w) {
    const chk = (w || document).querySelector("#ab-auto"); if (chk) chk.checked = AB.auto;
  }
  // сворачивание секции по клику на заголовок (data-box = id тела)
  function toggleBox(id, headEl) {
    const el = document.getElementById(id); if (!el) return;
    const nowOpen = el.style.display === "none";
    el.style.display = nowOpen ? "block" : "none";
    if (headEl) headEl.textContent = headEl.textContent.replace(/[▸▾]/, nowOpen ? "▾" : "▸");
  }
  function syncToggleBtn() {
    const tg = document.getElementById("ab-toggle"); if (tg) { tg.className = AB.on ? "on" : "off"; tg.textContent = AB.on ? "⏸ Стоп" : "▶ Старт"; }
    const btn = document.getElementById("ab-btn"); if (btn) btn.classList.toggle("live", AB.on);
  }
  function updatePaperBadge() {
    const b = document.getElementById("ab-paper"); if (!b) return;
    b.textContent = AB.paper ? "PAPER" : "🔴 РЕАЛ";
    b.classList.toggle("real", !AB.paper);
  }

  function wireWindow(w) {
    ["profit:profitTicks", "gate:gateTicks", "stop:stopTicks", "hold:maxHoldSec",
     "ahead:aheadTicks", "deep:deepTicks", "wallfrac:wallFrac", "tpfrac:tpFrac", "tsec:trendSec", "tticks:trendTicks", "pull:pullbackTicks"]
      .forEach((s) => { const [id, key] = s.split(":"); bindNum("ab-" + id, key); });

    // ── РАЗМЕР: режим $ / контракты + поле, которое пишет в нужный cfg ──
    const sizeEl = w.querySelector("#ab-size"), sizeLbl = w.querySelector("#ab-sizelbl"), smBox = w.querySelector("#ab-sizemode");
    const sizeRender = () => {
      if (sizeLbl) sizeLbl.textContent = inContracts() ? "Размер лота, контр." : "Размер лота, $";
      if (sizeEl) { sizeEl.step = inContracts() ? "1" : "1"; sizeEl.value = inContracts() ? (AB.cfg.sizeContracts || 1) : (AB.cfg.sizeUsd || 0); }
      if (smBox) smBox.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sm === (AB.cfg.sizeMode || "usd")));
      const fi = document.getElementById("ab-fixinfo"); if (fi) fi.textContent = sizeReadout();
    };
    if (sizeEl) sizeEl.onchange = () => {
      const v = parseFloat(sizeEl.value); if (isNaN(v) || v <= 0) return;
      if (inContracts()) AB.cfg.sizeContracts = Math.max(1, Math.round(v)); else AB.cfg.sizeUsd = v;
      saveState(); sizeRender();
    };
    if (smBox) smBox.querySelectorAll("button").forEach((b) => b.onclick = () => {
      AB.cfg.sizeMode = b.dataset.sm; saveState(); sizeRender();
      abLog(inContracts() ? `режим размера: 📦 ${AB.cfg.sizeContracts} контр. (фикс)` : `режим размера: 💵 $${AB.cfg.sizeUsd}`);
    });
    sizeRender();

    // ── СТРОГИЙ РЕЖИМ (gateEnable): вкл = ждать absorption; выкл = ставить у стены сразу ──
    const strictEl = w.querySelector("#ab-strict");
    if (strictEl) { strictEl.checked = AB.cfg.gateEnable !== false; strictEl.onchange = () => { AB.cfg.gateEnable = strictEl.checked; saveState(); abLog(strictEl.checked ? "строгий режим ВКЛ (жду absorption)" : "строгий режим ВЫКЛ (ставлю у стены сразу)"); }; }

    // поле стены ММ (задаёт Вика; ручной ввод → авто-синк из стакана отключается)
    const wu = w.querySelector("#ab-wallusd");
    if (wu) { wu.value = AB.cfg.wallMinUsd; wu.onchange = () => { const v = parseFloat(wu.value); if (v > 0) { AB.cfg.wallMinUsd = v; AB._wallManual = true; saveState(); abLog("стена ММ вручную: $" + Math.round(v)); } }; }
    const wp = w.querySelector("#ab-wallpull");
    if (wp) wp.onclick = () => {
      const src = (S.big1USD > 0 ? S.big1USD : 0) || (S.big2USD > 0 ? S.big2USD : 0);
      if (src > 0) { AB.cfg.wallMinUsd = src; AB._wallManual = true; if (wu) wu.value = src; saveState(); abLog("стена ММ = $" + Math.round(src) + " (из стакана)"); }
      else abLog("в стакане «Крупный объём USD» не задан порог", "err");
    };

    // readout размера: живая сумма в $ и контрактах (обновляется в render())
    const fxInfo = w.querySelector("#ab-fixinfo");
    if (fxInfo) fxInfo.textContent = sizeReadout();

    // режим выбора стены: 🏆 крупнейшая (жирный маркетос, не середина) / 📎 ближняя к спреду
    const wmBox = w.querySelector("#ab-wallmode");
    if (wmBox) {
      const paint = () => wmBox.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.wm === (AB.cfg.wallMode || "biggest")));
      wmBox.querySelectorAll("button").forEach((b) => b.onclick = () => { AB.cfg.wallMode = b.dataset.wm; AB.tgtBuy = null; AB.tgtSell = null; paint(); saveState(); abLog("режим стены: " + (b.dataset.wm === "biggest" ? "🏆 крупнейшая" : "📎 ближняя")); });
      paint();
    }

    const twoChk = w.querySelector("#ab-two");
    if (twoChk) { twoChk.checked = AB.twoSided; twoChk.onchange = () => { AB.twoSided = twoChk.checked; if (AB.on) resetRuntime(true); saveState(); abLog(AB.twoSided ? "режим: ⇅ обе стороны" : "режим: одна нога"); }; }
    const autoChk = w.querySelector("#ab-auto");
    if (autoChk) { autoChk.checked = AB.auto; autoChk.onchange = () => { AB.auto = autoChk.checked; applyAutoUI(w); saveState(); if (AB.auto) autoTune(); }; }
    applyAutoUI(w);

    renderExchanges(w); renderCredType(w); renderCredFields(w);

    w.querySelector("#ab-connsave").onclick = () => {
      saveState();
      const st = w.querySelector("#ab-connstat");
      const cred = AB.conn.type === "uid" ? (AB.conn.uid ? "UID ✓" : "UID пуст") : (AB.conn.key ? "ключ ✓" : "ключ пуст");
      if (st) { st.textContent = `${AB.conn.ex.toUpperCase()} · ${cred}`; }
      abLog(`биржа ${AB.conn.ex.toUpperCase()} · ${AB.conn.type === "uid" ? "Web UID" : "API"} сохранён`);
      if (AB.conn.ex === "mexc") {                       // MEXC: подключаем для реальной торговли бота
        let payload;
        if (AB.conn.type === "api") {
          if (!AB.conn.key || !AB.conn.secret) { abLog("MEXC: впиши API Key и Secret", "err"); return; }
          payload = { key: AB.conn.key, secret: AB.conn.secret };
        } else {
          const tok = (AB.conn.uid || "").trim();
          if (!tok) { abLog("MEXC: впиши Web UID (uc_token из браузера mexc.com)", "err"); return; }
          payload = { token: tok };
        }
        if (st) st.textContent = "MEXC · проверяю…";
        abPost("/api/mexcconnect", payload).then((r) => {
          AB._mexcConn = !!(r && r.ok);
          if (r && r.ok) { if (st) st.textContent = `MEXC · ${r.mode === "api" ? "API" : "Web"} · баланс $${(r.balance || 0).toFixed(2)}`; abLog(`✅ MEXC подключён (${r.mode === "api" ? "API-ключ" : "Web UID"}) · баланс $${(r.balance || 0).toFixed(2)}`, "ok"); }
          else { if (st) st.textContent = "MEXC · " + ((r && r.error) || "не принял"); abLog("MEXC не принял: " + ((r && r.error) || "?"), "err"); }
        });
      }
    };

    // поле монеты бота: ввод → переключить стакан на неё (учитывает активную биржу через switchSymbol/mexc-guard)
    const coinEl = w.querySelector("#ab-coin");
    if (coinEl) {
      const applyCoin = () => {
        let v = (coinEl.value || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
        if (!v) return;
        if (!v.endsWith("_USDT")) v = v.replace(/_?USDT$/, "") + "_USDT";
        if (v === S.symbol) return;
        if (typeof switchSymbol === "function") switchSymbol(v);   // сам решает: MEXC-поллинг / WEEX / Ourbit-поток
        else S.symbol = v;
        const hi = document.getElementById("symbol"); if (hi) hi.value = v.replace("_USDT", "");
        if (AB.on) resetRuntime(true);                              // сменили монету на ходу — обнулить текущую заявку/позу
        abLog("монета бота: " + v.replace("_USDT", ""));
      };
      coinEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyCoin(); } });
      coinEl.addEventListener("change", applyCoin);
    }

    // сворачиваемые заголовки (Биржа/ключ, Ручная настройка) + кнопка Лог
    w.querySelectorAll(".ab-cl").forEach((h) => { h.onclick = () => toggleBox(h.dataset.box, h); });
    const lt = w.querySelector("#ab-logtgl"); if (lt) lt.onclick = () => toggleBox(lt.dataset.box, lt);

    // бейдж PAPER ⟷ РЕАЛ (с подтверждением при включении реала)
    updatePaperBadge();
    const pb = w.querySelector("#ab-paper");
    if (pb) pb.onclick = () => {
      if (AB.paper) {
        const reason = realBlockReason();
        const warn = "🔴 ВКЛЮЧИТЬ РЕАЛЬНУЮ ТОРГОВЛЮ?\n\nБот будет ставить НАСТОЯЩИЕ ордера на реальные деньги." +
          (reason ? "\n\n⚠ Сейчас реал недоступен: " + reason + "\n(переключить можно, но торговать начнёт только когда условие выполнено)" : "\n\nНачинай с МИКРО-размера лота!");
        if (!window.confirm(warn)) return;
        AB.paper = false;
        if (AB.on) resetRuntime(true);   // смена режима — обнулить текущую заявку/позу
      } else { if (AB.on) resetRuntime(true); AB.paper = true; }   // уходим с РЕАЛ→PAPER: снять реальные заявки ДО смены флага
      updatePaperBadge(); saveState();
      abLog(AB.paper ? "режим: PAPER (симуляция)" : "режим: 🔴 РЕАЛ", AB.paper ? null : "err");
    };

    const tg = w.querySelector("#ab-toggle");
    tg.onclick = () => {
      AB.on = !AB.on;
      syncToggleBtn();
      if (AB.on) { AB._sym = S.symbol; AB._realCd = 0; resetRuntime(true); abLog(`СТАРТ · ${AB.paper ? "PAPER" : "🔴 РЕАЛ"} · ${(S.symbol || "?").replace("_USDT", "")}`, "ok"); }
      else { resetRuntime(true); abLog("СТОП"); }
    };
    w.querySelector("#ab-reset").onclick = () => { AB.stats = { trades: 0, wins: 0, losses: 0, pnlUsd: 0, ticksSum: 0 }; AB.log = []; abLog("статистика сброшена"); };
    w.querySelector("#ab-x").onclick = () => w.classList.remove("show");
    dragify(w, w.querySelector("#ab-head"));
  }

  function dragify(win, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.id === "ab-x") return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect(); ox = r.left; oy = r.top; win.style.right = "auto"; e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => { if (!drag) return; win.style.left = (ox + e.clientX - sx) + "px"; win.style.top = (oy + e.clientY - sy) + "px"; });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  function injectButton() {
    if (document.getElementById("ab-btn")) return;
    const hdr = document.querySelector("header"); if (!hdr) return;
    const b = document.createElement("button");
    b.id = "ab-btn"; b.className = "gear"; b.title = "Автобот — сбор спреда (PAPER)"; b.textContent = "🤖 Бот";
    hdr.insertBefore(b, hdr.querySelector(".status") || null);
    b.onclick = () => { (document.getElementById("abwin") || buildWindow()).classList.toggle("show"); };
  }

  // ── отрисовка панели ───────────────────────────────────────────────────────
  let _lastRender = 0;
  function render() {
    const w = document.getElementById("abwin"); if (!w || !w.classList.contains("show")) return;
    const t = Date.now(); if (t - _lastRender < 200) return; _lastRender = t;

    const cn = document.getElementById("ab-coinnow");
    if (cn) { const ex = S.exMexc ? "MEXC" : S.exWeex ? "WEEX" : "Ourbit";
      cn.textContent = "стакан: " + (S.symbol || "?").replace("_USDT", "") + " · " + ex; }
    const ci = document.getElementById("ab-coin");
    if (ci && document.activeElement !== ci && !ci.value) ci.placeholder = (S.symbol || "").replace("_USDT", "") || "монета (VANRY, BTC…)";

    const wi = document.getElementById("ab-wallinfo");
    if (wi) { const wm = Math.round(AB.cfg.wallMinUsd || 0);
      wi.textContent = wm > 0 ? `🧱 стена ММ: $${wm}` + (AB.on && AB._noWall ? " · ⚠ маркетоса ≥ этого рядом нет — жду (снизь порог)" : " — бот ставит лимитку у стены ≥ этого") : "🧱 стена ММ: впиши сумму крупной стены"; }
    const wuf = document.getElementById("ab-wallusd");
    if (wuf && document.activeElement !== wuf && String(Math.round(AB.cfg.wallMinUsd || 0)) !== wuf.value) wuf.value = Math.round(AB.cfg.wallMinUsd || 0);

    const al = document.getElementById("ab-autoline");
    if (al) { const C = AB.cfg;
      al.textContent = AB.auto
        ? `бот подобрал: гейт ${C.gateTicks}т · тейк ${C.profitTicks}т · стоп ${C.stopTicks}т · держ ${C.maxHoldSec}с  ·  🧱 стена ≥ $${Math.round(C.wallMinUsd)} (твоя)`
        : "ручной режим — параметры ниже";
    }
    const fxi = document.getElementById("ab-fixinfo");           // живой размер ордера в $ и контрактах
    if (fxi) fxi.textContent = sizeReadout();

    const st = document.getElementById("ab-status");
    if (st) {
      const bb = S.bestBid, ba = S.bestAsk, sprT = (bb && ba) ? Math.round((ba - bb) / tk()) : 0;
      const stMap = { idle: ["ждём условие", "#8a95a4"], quoting: ["заявка выставлена", "#e6c34a"], inpos: ["в позиции", "#6fcf91"] };
      const [stTxt, stCol] = AB.on ? (stMap[AB.state] || ["—", "#8a95a4"]) : ["ВЫКЛ", "#7a8697"];
      const modeTag = AB.paper ? `<span style="color:#e6c34a">PAPER</span>` : `<span style="color:#ff6b66">🔴 РЕАЛ</span>`;
      let html = `${modeTag} · <span class="st" style="color:${stCol}">${stTxt}</span> · спред ${sprT}т`;
      if (AB.sig) {                                              // ── readout движка order-flow ──
        const s = AB.sig, brk = breaking("buy") || breaking("sell"), abs = absorbing("buy") || absorbing("sell");
        const light = brk ? `<span style="color:#ff6b66">🔴 пробой</span>` : abs ? `<span style="color:#6fcf91">🟢 absorption</span>` : `<span style="color:#7a8697">⚪ тихо</span>`;
        const wb = (AB._wallsBuy || [])[0], ws = (AB._wallsSell || [])[0];
        const wtag = (w) => w ? w.cls + (w.iceberg ? "🧊" : "") + " $" + Math.round(w.peakUsd) : "—";
        html += `<br>${light} · OBI ${s.obi >= 0 ? "+" : ""}${s.obi.toFixed(2)} · Z ${s.volZ.toFixed(1)}`;
        html += `<br><span style="color:#6fcf91">🧱B ${wtag(wb)}</span> · <span style="color:#ef938f">🧱S ${wtag(ws)}</span>`;
        if (AB.on && AB._noWall && (AB._blkBuy || AB._blkSell)) html += `<br><span style="color:#c9a34a">⛔ ${AB._blkBuy || AB._blkSell}</span>`;
      }
      if (!AB.paper && AB.on && AB._realReason) html += `<br><span style="color:#ef938f">⚠ ${AB._realReason}</span>`;
      if (AB.entry) html += `<br>[${AB.entry.kind}] ${AB.entry.side === "buy" ? "BUY" : "SELL"} @${AB.entry.price.toFixed(dc())} → тейк @${AB.entry.tpPrice.toFixed(dc())}`;
      if (AB.twoSided && !AB.pos) {                              // двусторонний: показать обе стоящие лимитки
        const qb = AB.paper ? AB.qBuy : AB.rqBuy, qs = AB.paper ? AB.qSell : AB.rqSell;
        if (qb) html += `<br><span style="color:#6fcf91">↑ BUY @${(qb.price).toFixed(dc())}</span>`;
        if (qs) html += `<br><span style="color:#ef938f">↓ SELL @${(qs.price).toFixed(dc())}</span>`;
        if (!qb && !qs && AB.on) html += `<br><span style="color:#7a8697">жду маркетос ≥ $${Math.round(AB.cfg.wallMinUsd || 0)}…</span>`;
      }
      if (AB.pos) {
        const px = AB.pos.long ? bb : ba;
        const up = px ? pnlUsd(AB.pos.long, AB.pos.price, px, AB.pos.vol) : 0;
        html += `<br>[${AB.pos.kind}] ${AB.pos.long ? "LONG" : "SHORT"} @${AB.pos.price.toFixed(dc())} · тейк @${(AB.close ? AB.close.price : 0).toFixed(dc())}`;
        html += `<br>плав. PnL <b style="color:${up >= 0 ? "#6fcf91" : "#ef938f"}">${up >= 0 ? "+" : ""}$${up.toFixed(3)}</b>`;
      }
      st.innerHTML = html;
    }
    const A = AB.stats, set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("ab-trades", A.trades);
    set("ab-win", A.trades ? Math.round(A.wins / A.trades * 100) + "%" : "—");
    const pnlEl = document.getElementById("ab-pnl");
    if (pnlEl) { pnlEl.textContent = (A.pnlUsd >= 0 ? "+$" : "-$") + Math.abs(A.pnlUsd).toFixed(2); pnlEl.style.color = A.pnlUsd >= 0 ? "#6fcf91" : "#ef938f"; }
    set("ab-avgt", A.trades ? (A.ticksSum / A.trades).toFixed(1) : "—");
    const lg = document.getElementById("ab-log");
    if (lg) lg.innerHTML = AB.log.slice(0, 20).map((l) => `<div class="${l.kind || ""}">${l.msg}</div>`).join("");
  }

  // ── старт ───────────────────────────────────────────────────────────────────
  function boot() { loadState(); injectStyle(); injectButton(); setInterval(step, 250); setInterval(mexcAcctPoll, 700); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
