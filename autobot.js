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
      sizeUsd: 20,       // размер лота (виртуальный), $
      profitTicks: 2,    // тейк, тиков (тренд/поджатие)
      gateTicks: 3,      // не собирать спред у середины/стены, пока спред уже этого
      stopTicks: 8,      // аварийный стоп: убыток ≥ N тиков → закрыть по рынку
      maxHoldSec: 25,    // не пересиживать: закрыть по рынку через N сек
      aheadTicks: 1,     // «чуть раньше» ММ (поджатие): агрессивнее середины на N тиков
      deepTicks: 12,     // как глубоко искать дальнюю стену (прострел)
      wallMinUsd: 300,   // стена меньше этого ($) не считается стеной — от неё спред не собираем
      wallFrac: 0.3,     // стена доминирующая, если ≥ этой доли ликвидности окна
      wallKeepFrac: 0.4, // цель держим, пока у стены ≥ этой доли исходного объёма (в ±2 тика)
      tpFrac: 0.6,       // прострел: доля пути от входа к середине для тейка
      trendSec: 10,      // окно определения тренда
      trendTicks: 4,     // мин. ход за окно, чтобы считать трендом
      pullbackTicks: 2,  // тренд: на сколько тиков за край ставим лимитку (откат)
      requoteSec: 2,     // (не спамить) мин. интервал между переставлениями, сек — умолчание
      requoteTicks: 3,   // переставлять заявку ТОЛЬКО если цель сместилась ≥ этого (иначе не трогать)
      cooldownSec: 2,    // пауза между сделками
      minPrintUsd: 5,    // принты мельче ($) не двигают наш филл (реализм)
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
  function vol(price) { return Math.max(1, Math.round((AB.cfg.sizeUsd || 1) / (price * cs()))); }
  function pnlUsd(long, entry, exit, v) { return (long ? exit - entry : entry - exit) * v * cs(); }
  function ticksBetween(a, b) { return Math.round(Math.abs(a - b) / tk()); }
  function abLog(msg, kind) { AB.log.unshift({ msg, kind }); if (AB.log.length > 40) AB.log.length = 40; }

  // Доминирующая «стена» на стороне в пределах maxTicks. Возвращает {price,vol,usd} или null.
  // Стена засчитывается, только если: объём ≥ frac от ликвидности в окне И её размер ≥ minUsd$.
  function farWallStrong(side, maxTicks, frac, minUsd) {
    const d = S.depth; if (!d) return null;
    const t = tk(), arr = side === "buy" ? d.bids : d.asks, best = side === "buy" ? S.bestBid : S.bestAsk;
    if (!arr || !best) return null;
    let bestP = null, bestV = 0, sum = 0;
    for (const [p, v] of arr) {
      if (!(v > 0)) continue;
      const off = side === "buy" ? (best - p) : (p - best);
      if (off <= 0 || off > maxTicks * t) continue;
      sum += v; if (v > bestV) { bestV = v; bestP = p; }
    }
    if (bestP == null || sum <= 0 || bestV / sum < frac) return null;
    const usd = bestV * cs() * bestP;
    if (minUsd > 0 && usd < minUsd) return null;   // мелкая стенка — игнорируем
    return { price: bestP, vol: bestV, usd };
  }

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

  // Ближайший МАРКЕТОС (доминирующая стена ≥ minUsd$) на стороне в пределах maxTicks от бэста.
  function nearestWall(side, maxTicks, minUsd) {
    const d = S.depth; if (!d) return null;
    const t = tk(), arr = side === "buy" ? d.bids : d.asks, best = side === "buy" ? S.bestBid : S.bestAsk;
    if (!arr || !best) return null;
    let bestOff = Infinity, res = null;
    for (const [p, v] of arr) {
      if (!(v > 0)) continue;
      const off = side === "buy" ? (best - p) : (p - best);
      if (off <= 0 || off > maxTicks * t) continue;
      const usd = v * cs() * p;
      if (usd >= minUsd && off < bestOff) { bestOff = off; res = { price: p, vol: v, usd, offT: Math.round(off / t) }; }
    }
    return res;
  }

  // ДОМИНИРУЮЩАЯ стена: самый КРУПНЫЙ уровень в окне; засчитывается только если ≥ minUsd И доминирует
  // (≥ frac от суммарной ликвидности окна). Так встаём у настоящего большого маркетоса, а не у мелочи/середины.
  function dominantWall(side, maxTicks, minUsd, frac) {
    const d = S.depth; if (!d) return null;
    const t = tk(), arr = side === "buy" ? d.bids : d.asks, best = side === "buy" ? S.bestBid : S.bestAsk;
    if (!arr || !best) return null;
    let bestL = null, sum = 0;
    for (const [p, v] of arr) {
      if (!(v > 0)) continue;
      const off = side === "buy" ? (best - p) : (p - best);
      if (off <= 0 || off > maxTicks * t) continue;
      const usd = v * cs() * p; sum += usd;
      if (!bestL || usd > bestL.usd) bestL = { p, v, usd, off };
    }
    if (!bestL) return null;
    if (minUsd > 0 && bestL.usd < minUsd) return null;
    if (frac > 0 && sum > 0 && bestL.usd / sum < frac) return null;
    return { price: bestL.p, vol: bestL.v, usd: bestL.usd, offT: Math.round(bestL.off / t) };
  }
  // «Стена жива» — устойчиво к дрожанию: максимум объёма в ±2 тика от якоря ≥ wallKeepFrac исходного.
  function wallAliveAt(side, wallPx, wallVol0) {
    if (!wallPx || !(wallVol0 > 0)) return false;
    const t = tk(); let best = 0;
    for (let k = -2; k <= 2; k++) { const v = queueAt(side, snap(wallPx + k * t)); if (v > best) best = v; }
    return best >= wallVol0 * (AB.cfg.wallKeepFrac || 0.4);
  }
  // «Стена мертва» подтверждается 3 подряд мёртвыми чтениями (гасит транзиентный gap=0 стакана).
  function wallDeadConfirmed(side, cur) {
    const k = side === "buy" ? "_deadBuy" : "_deadSell";
    if (wallAliveAt(side, cur.wallPx, cur.wallVol)) { AB[k] = 0; return false; }
    AB[k] = (AB[k] || 0) + 1;
    return AB[k] >= 3;
  }
  // ЗАЛОК ЦЕЛИ: единственная точка расчёта цены. Пока стена жива — цель НЕ меняется (лимитка стоит, ждёт прострел).
  function getTarget(side) {
    const key = side === "buy" ? "tgtBuy" : "tgtSell", cur = AB[key], t = tk(), C = AB.cfg;
    if (cur && !wallDeadConfirmed(side, cur)) return cur;
    const range = Math.max(C.deepTicks || 12, 60);
    const wall = dominantWall(side, range, C.wallMinUsd > 0 ? C.wallMinUsd : 0, C.wallFrac || 0.3);
    if (!wall) { AB[key] = null; AB._noWall = true; return null; }
    AB._noWall = false;
    const buy = side === "buy";
    const price = buy ? snap(wall.price + C.aheadTicks * t) : snap(wall.price - C.aheadTicks * t);
    const tp = buy ? snap(price + C.profitTicks * t) : snap(price - C.profitTicks * t);
    AB[key] = { side, price, tpPrice: tp, wallPx: wall.price, wallVol: wall.vol, offT: wall.offT, usd: wall.usd, bornAt: Date.now() };
    return AB[key];
  }

  // ── ЯКОРЬ К МАРКЕТОСУ: лимитку ставим на тик ВПЕРЕДИ ближайшей крупной стены. ──
  // Тренд решает сторону (не входить против тренда). Нет стены рядом → В ПУСТОТУ НЕ СТАВИМ.
  function planEntry(bb, ba, sprT) {
    const t = tk(), C = AB.cfg;
    const dir = trendDir(C.trendSec);
    const allowBuy = dir >= 0, allowSell = dir <= 0;
    const range = Math.max(C.deepTicks || 12, 60);
    const minUsd = C.wallMinUsd > 0 ? C.wallMinUsd : 0, frac = C.wallFrac || 0.3;
    const wb = allowBuy ? dominantWall("buy", range, minUsd, frac) : null;
    const ws = allowSell ? dominantWall("sell", range, minUsd, frac) : null;
    let side = null, wall = null;
    if (wb && ws) { if (wb.offT <= ws.offT) { side = "buy"; wall = wb; } else { side = "sell"; wall = ws; } }
    else if (wb) { side = "buy"; wall = wb; }
    else if (ws) { side = "sell"; wall = ws; }
    else { AB._noWall = true; return null; }                    // маркетоса ≥ minUsd рядом нет → ждём
    AB._noWall = false;
    const buy = side === "buy";
    const price = buy ? snap(wall.price + C.aheadTicks * t) : snap(wall.price - C.aheadTicks * t);   // на тик впереди стены («чуть раньше»)
    const tp = buy ? snap(price + C.profitTicks * t) : snap(price - C.profitTicks * t);
    return { side, price, tpPrice: tp, wallPx: wall.price, wallVol: wall.vol, kind: `маркетос ${wall.offT}т $${Math.round(wall.usd)}` };
  }

  // План для ОДНОЙ стороны — ближайший маркетос этой стороны (для двустороннего режима, БЕЗ тренд-фильтра).
  function planSide(side) {
    const t = tk(), C = AB.cfg;
    const range = Math.max(C.deepTicks || 12, 90), minUsd = C.wallMinUsd > 0 ? C.wallMinUsd : 500;
    const wall = nearestWall(side, range, minUsd);
    if (!wall) return null;
    const buy = side === "buy";
    const price = buy ? snap(wall.price + C.aheadTicks * t) : snap(wall.price - C.aheadTicks * t);
    const tp = buy ? snap(price + C.profitTicks * t) : snap(price - C.profitTicks * t);
    return { side, price, tpPrice: tp, wallPx: wall.price, wallVol: wall.vol, offT: wall.offT, usd: wall.usd };
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
    AB.pos = { long, price: q.price, vol: q.vol, t: sn, kind: "2стор" };
    AB.close = { side: cside, price: q.tpPrice, since: sn, _seen: sn, queue: queueAt(cside, q.tpPrice), fillVol: 0 };
    AB.qBuy = null; AB.qSell = null; AB.state = "inpos";
    abLog(`✅ ЗАЛИЛО ${long ? "LONG" : "SHORT"} @${q.price.toFixed(dc())} — тейк @${q.tpPrice.toFixed(dc())} (лимитки сняты)`, "ok");
  }
  function manageSidePaper(side) {                              // ставим/держим у ЗАЛОЧЕННОЙ цели (getTarget)
    const key = side === "buy" ? "qBuy" : "qSell", cur = AB[key], tgt = getTarget(side);
    if (!tgt) { if (cur) AB[key] = null; return; }              // маркетоса нет → снять
    if (cur && ticksBetween(cur.price, tgt.price) < 0.5) return; // цена та же → держим, ждём прострел (не пересоздаём)
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
    AB.pos = { long, price: e.price, vol: e.vol, t: sn, kind: e.kind };
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
    AB.pos = null; AB.close = null; AB.entry = null; AB.state = "idle";
    AB.cooldownUntil = now() + AB.cfg.cooldownSec * 1000;
  }
  // Стена-якорь ещё жива? (объём на её цене не съеден/не снят). Пока жива — заявку НЕ трогаем, ждём прострел.
  function wallAlive(order) {
    if (!order.wallPx) return false;
    return queueAt(order.side, order.wallPx) >= (order.wallVol || 0) * 0.4;
  }
  function maybeRequote(bb, ba, sprT) {
    const e = AB.entry, C = AB.cfg;
    if (wallAlive(e)) return;                                   // маркетос на месте → держим заявку (ждём импульс, НЕ спамим)
    // стену съели/сняли → переанкорить на новую ближайшую
    const plan = planEntry(bb, ba, sprT);
    if (!plan) { abLog("маркетос ушёл — снимаю заявку"); AB.entry = null; AB.state = "idle"; return; }
    if (plan.side !== e.side || ticksBetween(plan.price, e.price) >= (C.requoteTicks || 3)) placeEntry(plan);
  }
  // PAPER: позицию закрываем ТОЛЬКО лимиткой (тейк). Долго не дошёл → двигаем лимит закрытия к рынку (маркер), без маркета.
  function manageCloseLimit(bb, ba) {
    const p = AB.pos, C = AB.cfg, ms = now();
    if (ms - p.t >= C.maxHoldSec * 1000) {
      const edge = p.long ? ba : bb, newPx = snap(edge);
      if (ticksBetween(newPx, AB.close.price) >= 1) {
        AB.close.price = newPx; AB.close.since = ms; AB.close._seen = ms; AB.close.fillVol = 0; AB.close.queue = queueAt(AB.close.side, newPx);
        p.t = ms;
        abLog(`тейк не дошёл — лимит закрытия к рынку @${newPx.toFixed(dc())}`);
      }
    }
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
  function mexcCloseMarket(pos) { mexcOrder(pos.side === 1 ? RSIDE.CLOSE_LONG : RSIDE.CLOSE_SHORT, ROT.MARKET, 0, pos.vol, pos.id); }
  async function mexcAcctPoll() {
    if (AB.paper || !S.exMexc || !AB._mexcConn || !AB.on) return;
    try { const r = await fetch("/api/mexcaccount?symbol=" + encodeURIComponent(S.symbol)).then((x) => x.json()); if (r && r.ok) AB._mexcAcct = r; } catch (e) {}
  }
  // ── МЕХАНИЗМ INTENT per-side: NONE→PENDING→LIVE с таймаутом ожидания поллинга (анти-дубль, устойчив к лагу) ──
  const IO_PENDING_MS = 3000;
  function ioSlot(side) { if (!AB.io) AB.io = {}; return AB.io[side] || (AB.io[side] = { state: "NONE", price: 0, id: 0, at: 0, busy: false }); }
  function cancelSideById(side, id) { const io = ioSlot(side); io.busy = true; abPost("/api/mexccancel", { id }).then(() => { io.busy = false; io.state = "NONE"; io.id = 0; }); }
  function placeSide(side, want, ms) {
    const io = ioSlot(side); io.busy = true; io.state = "PENDING"; io.price = want.price; io.at = ms;
    const oside = side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT;
    mexcOrder(oside, ROT.LIMIT, want.price, vol(want.price), 0).then((r) => {
      io.busy = false;
      if (r && r.ok) abLog(`[РЕАЛ 2стор ${side === "buy" ? "BUY" : "SELL"} ${want.offT}т] @${want.price.toFixed(dc())}`);
      else { io.state = "NONE"; abLog(`MEXC ${side} отклонён: ${(r && (r.error || (r.resp && r.resp.message))) || "?"}`, "err"); }
    });
  }
  // Реконсилер ОДНОЙ стороны: приводим реальные ордера к желаемому (ровно 1 у цели). Устойчив к лагу поллинга.
  function reconcileSide(side, want, orders, ms) {
    const io = ioSlot(side), t = tk();
    const openSide = side === "buy" ? RSIDE.OPEN_LONG : RSIDE.OPEN_SHORT;
    const tol = ((AB.cfg.requoteTicks || 3) + 0.5) * t;
    const mine = orders.filter((o) => o.side === openSide);
    if (mine.length > 1) { if (!io.busy) cancelSideById(side, mine[1].id); return; }   // дедуп: лишний снять
    const live = mine[0] || null;
    if (live) { io.state = "LIVE"; io.id = live.id; io.price = live.price; }
    else if (io.state === "PENDING") { if (ms - io.at > IO_PENDING_MS) io.state = "NONE"; else return; }   // ждём отражения — НЕ дублируем
    if (io.busy) return;
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
    AB.pos = { long, price: pos.avg, vol: pos.vol, t: ms, kind: "2стор" };
    AB.close = { side: long ? "sell" : "buy", price: tp, id: 0, state: "NONE", busy: false, at: 0 };
    AB.state = "inpos";
    abLog(`✅ РЕАЛ MEXC залило ${long ? "LONG" : "SHORT"} @${pos.avg} — тейк-лимит @${tp.toFixed(dc())} (входные сняты)`, "ok");
  }
  // Управление позицией MEXC: ровно ОДНА reduce-лимитка. Маркет — ТОЛЬКО авария (позиция >3× лота).
  function mexcManagePos(bb, ba) {
    const C = AB.cfg, t = tk(), ms = Date.now(), pos = mexcPos();
    if (!(pos && pos.vol > 0)) {
      if (AB.state === "inpos") { AB.stats.trades++; abLog("💚 РЕАЛ MEXC позиция закрыта (лимит)", "ok"); }
      AB.pos = null; AB.close = null; AB.state = "idle"; AB.io = {}; AB._realCd = ms + C.cooldownSec * 1000; return;
    }
    const long = pos.side === 1, cside = long ? RSIDE.CLOSE_LONG : RSIDE.CLOSE_SHORT;
    const cl = AB.close || (AB.close = { side: long ? "sell" : "buy", price: 0, id: 0, state: "NONE", busy: false, at: 0 });
    const usd = pos.vol * cs() * (long ? bb : ba);
    if (usd > C.sizeUsd * 3) { abLog("🛑 позиция >3× лота — аварийный маркет-выход, стоп бота", "err"); mexcCancelAllReal(); mexcCloseMarket(pos); AB.on = false; syncToggleBtn(); return; }
    if (ms - AB.pos.t >= C.maxHoldSec * 1000) {                 // тейк не дошёл → шагаем ЛИМИТ к рынку (мейкер)
      const edge = long ? ba : bb;
      if (ticksBetween(edge, cl.price) >= 1) { cl.price = snap(edge); cl.state = "NONE"; AB.pos.t = ms; abLog(`тейк не дошёл — лимит закрытия к рынку @${snap(edge).toFixed(dc())}`); }
    }
    // реконсилер ЗАКРЫТИЯ: ровно одна reduce-лимитка на cl.price (переставит, если биржа отклонила)
    const orders = (AB._mexcAcct && AB._mexcAcct.orders) || [];
    const closes = orders.filter((o) => o.side === cside);
    const tol = ((C.requoteTicks || 3) + 0.5) * t;
    const good = closes.find((o) => Math.abs(o.price - cl.price) <= tol);
    if (cl.busy) return;
    const extra = closes.find((o) => o !== good);
    if (extra) { cl.busy = true; abPost("/api/mexccancel", { id: extra.id }).then(() => { cl.busy = false; }); return; }
    if (good) { cl.state = "LIVE"; cl.id = good.id; return; }
    if (cl.state === "PENDING") { if (ms - cl.at > IO_PENDING_MS) cl.state = "NONE"; else return; }
    cl.busy = true; cl.state = "PENDING"; cl.at = ms;
    mexcOrder(cside, ROT.LIMIT, cl.price, pos.vol, pos.id).then((r) => { cl.busy = false; if (!(r && r.ok)) { cl.state = "NONE"; abLog("тейк-лимит отклонён — повтор", "err"); } });
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
        AB.pos = null; AB.close = null; AB.state = "idle"; AB._realCd = ms + C.cooldownSec * 1000;
      } else {
        const usd = T.pos.vol * cs() * (AB.pos.long ? bb : ba);
        if (usd > C.sizeUsd * 2) { abLog("🛑 РЕАЛ позиция превысила лимит — аварийно закрываю, стоп бота", "err"); cancelAll(); closePos(); AB.on = false; syncToggleBtn(); return; }
        const adverse = AB.pos.long ? bb : ba, lossT = AB.pos.long ? (AB.pos.price - adverse) / t : (adverse - AB.pos.price) / t;
        if (lossT >= C.stopTicks) { abLog(`РЕАЛ стоп ${C.stopTicks}т — закрываю`, "err"); cancelAll(); closePos(); }
        else if (ms - AB.pos.t >= C.maxHoldSec * 1000) { abLog(`РЕАЛ время ${C.maxHoldSec}с — закрываю`); cancelAll(); closePos(); }
      }
    }
  }

  let _lastTune = 0;
  function step() {
    const nowMs = Date.now();
    syncWall();
    if (nowMs - _lastTune > 1200) { _lastTune = nowMs; autoTune(); }   // подбор параметров под монету (и когда выключен — для readout)
    if (AB.on) {
      if (AB._sym !== S.symbol) { resetRuntime(); AB._sym = S.symbol; }
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

      <div class="ab-row"><label>Размер лота, $</label><input type="number" id="ab-size" step="1"></div>
      <div class="ab-row"><label>🧱 Стена ММ, $ <span class="ab-sub">задаёшь ты</span></label><input type="number" id="ab-wallusd" step="50"></div>
      <div class="ab-crow"><button id="ab-wallpull">↧ из стакана</button></div>
      <div class="ab-note" id="ab-wallinfo" style="color:#e6c34a">🧱 стена ММ: —</div>
      <label class="ab-autochk"><input type="checkbox" id="ab-two"> ⇅ <b>Обе стороны</b> <span class="ab-sub">(лимитки сверху и снизу)</span></label>
      <label class="ab-autochk"><input type="checkbox" id="ab-auto"> 🎯 <b>Авто под монету</b> <span class="ab-sub">(гейт/тейк/стоп)</span></label>
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
    ["size:sizeUsd", "profit:profitTicks", "gate:gateTicks", "stop:stopTicks", "hold:maxHoldSec",
     "ahead:aheadTicks", "deep:deepTicks", "wallfrac:wallFrac", "tpfrac:tpFrac", "tsec:trendSec", "tticks:trendTicks", "pull:pullbackTicks"]
      .forEach((s) => { const [id, key] = s.split(":"); bindNum("ab-" + id, key); });

    // поле стены ММ (задаёт Вика; ручной ввод → авто-синк из стакана отключается)
    const wu = w.querySelector("#ab-wallusd");
    if (wu) { wu.value = AB.cfg.wallMinUsd; wu.onchange = () => { const v = parseFloat(wu.value); if (v > 0) { AB.cfg.wallMinUsd = v; AB._wallManual = true; saveState(); abLog("стена ММ вручную: $" + Math.round(v)); } }; }
    const wp = w.querySelector("#ab-wallpull");
    if (wp) wp.onclick = () => {
      const src = (S.big1USD > 0 ? S.big1USD : 0) || (S.big2USD > 0 ? S.big2USD : 0);
      if (src > 0) { AB.cfg.wallMinUsd = src; AB._wallManual = true; if (wu) wu.value = src; saveState(); abLog("стена ММ = $" + Math.round(src) + " (из стакана)"); }
      else abLog("в стакане «Крупный объём USD» не задан порог", "err");
    };

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

    const st = document.getElementById("ab-status");
    if (st) {
      const bb = S.bestBid, ba = S.bestAsk, sprT = (bb && ba) ? Math.round((ba - bb) / tk()) : 0;
      const stMap = { idle: ["ждём условие", "#8a95a4"], quoting: ["заявка выставлена", "#e6c34a"], inpos: ["в позиции", "#6fcf91"] };
      const [stTxt, stCol] = AB.on ? (stMap[AB.state] || ["—", "#8a95a4"]) : ["ВЫКЛ", "#7a8697"];
      const modeTag = AB.paper ? `<span style="color:#e6c34a">PAPER</span>` : `<span style="color:#ff6b66">🔴 РЕАЛ</span>`;
      let html = `${modeTag} · <span class="st" style="color:${stCol}">${stTxt}</span> · спред ${sprT}т`;
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
