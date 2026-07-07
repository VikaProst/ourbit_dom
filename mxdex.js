"use strict";
/* ============================================================================
   MEXC↔DEX (THIEF). СЛЕВА — лента спред-коллов (монеты, у кого цена между
   биржами разъехалась: пороги 2.5/5/8/10/15/20/30/50%, приятный звон).
   СПРАВА — сетка ячеек: в каждой ЖИВОЙ график монеты, цены всех включённых
   бирж наложены, плавно тикает в реальном времени; правая шкала — % (спред),
   левая — цена. Поиск монеты внутри ячейки. Зум окна графика. ＋ ячейка.
   ========================================================================== */
(function () {
  const g = (id) => document.getElementById(id);
  const LS = "mxdex.cfg.v4";                          // v4: старт MEXC↔DEX (сброс старых настроек бирж)
  const POLL_MS = 1000;                               // как часто тянем свежие цены
  const HOT_MAX = 8;                                  // сколько ОТКРЫТЫХ ячеек кормим плотными сидами каждый тик (их мало → максимум детали; потолок от «раздувания» при огромной сетке)
  // Кластер-фильтр CEX-линий (анти-коллизия тикеров + анти-мерцание): цены ОДНОЙ монеты на разных биржах
  // держатся вместе (<~1-2%, арбитраж их поджимает). Линия далеко от кластера = ДРУГОЙ токен-тёзка
  // (напр. gate EDGE ≠ mexc EDGE, сидит на 0.072 против 0.30). Гистерезис IN<OUT = линия не мигает у границы.
  const CLU_IN = 0.05, CLU_OUT = 0.09, CLU_HARD = 0.5;   // показать <5%, скрыть >9%, жёсткий обрез (тёзка) >50% от медианы
  const SCALE_K = 1;                                  // 1 = ШКАЛА СНАПИТСЯ к данным без дрейфа (Вика: график не должен постоянно двигаться при зуме). Мерцание линий гасит гистерезис-фильтр
  const THRESH = [2.5, 5, 8, 10, 15, 20, 30, 50];     // пороги спред-колла, %
  const RE_ALERT_MS = 10 * 60 * 1000;                 // спред ДЕРЖИТСЯ → повторный сигнал не чаще раза в 10 мин
  const GONE_RESET_MS = 3 * 60 * 1000;                // спред ПРОПАЛ на 3+ мин → сброс (новое появление = новый разрыв = сигнал)
  const ACTIVITY_MIN = 0.6;                           // % движения за ~90с — с этого показываем значок 🚀/🔻 в ленте (сам АЛЕРТ требует ≥ CFG.thresh)
  const WINS =[[30, "30с"], [60, "1м"], [120, "2м"], [300, "5м"], [600, "10м"], [1800, "30м"], [3600, "1ч"], [14400, "4ч"], [86400, "24ч"]];

  const SRC = [                                        // fx = справедливая (mark) цена — буква «Ф» ПОД биржей (есть где API отдаёт mark в тикере)
    { lbl: "MEXC", c: "#16c784", f: "mexc", s: "mexcspot", fx: "mexcfair" },     // зелёный (фикс)
    { lbl: "BINANCE", c: "#f5b800", f: "binance", s: "binancespot" },           // золотой
    { lbl: "BYBIT", c: "#ff7f0e", f: "bybit", s: "bybitspot", fx: "bybitfair" }, // оранжевый
    { lbl: "GATE", c: "#e6446e", f: "gate", s: "gatespot", fx: "gatefair" },     // малиновый
    { lbl: "BITGET", c: "#17becf", f: "bitget", s: "bitgetspot", fx: "bitgetfair" }, // циан
    { lbl: "OKX", c: "#9aa7b4", f: "okx", s: "okxspot" },                        // серый
    { lbl: "KUCOIN", c: "#0be881", f: "kucoin" },                                // бирюзово-зелёный (без спота/fair — kucoin их не отдаёт)
    { lbl: "BINGX", c: "#1f77ff", f: "bingx" },                                  // синий
    { lbl: "OURBIT", c: "#e377c2", f: "ourbit" },                                // розовый
    { lbl: "ASTER", c: "#5a4fcf", f: "asterdex" },                               // индиго
    { lbl: "LIGHTER", c: "#8c564b", f: "lighter" },                             // коричневый
    { lbl: "HL", c: "#bcbd22", f: "hyperliquid" },                             // оливковый
  ];
  const SPECIAL = [
    { lbl: "DEX·CA", c: "#a64dff", id: "dex", title: "on-chain цена по контракту (Dexscreener)" },   // фиолетовый (фикс)
  ];
  const COL = { mexc: "#16c784", binance: "#f5b800", binancespot: "#f5d24b", bybit: "#ff7f0e",
    gate: "#e6446e", bitget: "#17becf", bingx: "#1f77ff", okx: "#9aa7b4", kucoin: "#0be881", ourbit: "#e377c2",
    asterdex: "#5a4fcf", lighter: "#8c564b", hyperliquid: "#bcbd22", mexcfair: "#e6c84a", dex: "#a64dff",
    mexcspot: "#6fe0a8", bybitspot: "#ffb066", gatespot: "#f08ba6", bitgetspot: "#7fe0ea", okxspot: "#cfd6de",
    bybitfair: "#ff7f0e", gatefair: "#e6446e", bitgetfair: "#17becf" };   // справедливые — цвет биржи, рисуются ПУНКТИРОМ
  const LBL = { mexc: "MEXC·F", binance: "BINANCE·F", binancespot: "BINANCE·S", bybit: "BYBIT·F",
    gate: "GATE·F", bitget: "BITGET·F", bingx: "BINGX", okx: "OKX·F", kucoin: "KUCOIN·F", ourbit: "OURBIT",
    asterdex: "ASTER", lighter: "LIGHTER", hyperliquid: "HL", mexcfair: "FAIR", dex: "DEX·CA",
    mexcspot: "MEXC·S", bybitspot: "BYBIT·S", gatespot: "GATE·S", bitgetspot: "BITGET·S", okxspot: "OKX·S",
    bybitfair: "BYBIT·Ф", gatefair: "GATE·Ф", bitgetfair: "BITGET·Ф" };

  const DEF = { ex: ["mexc", "dex", "mexcfair"], sound: true,           // старт: MEXC ↔ DEX (арбитраж on-chain vs биржа)
    cards: ["VANRY_USDT", "GWEI_USDT", "OPENAI_USDT", "ANTHROPIC_USDT"],
    windowSec: 120, thresh: 4, pinned: [], minturn: 3000, maxgap: 300,   // thresh — ЕДИНЫЙ порог: спред ≥ % И памп/дамп ≥ % одновременно
    mxtrades: 1000,                                                       // глубина загрузки истории по сделкам (фикс. максимум — селектор убран, деталь максимальная)
    cols: 3, cellH: 210, lw: 0.5, feedW: 198 };
  const isSpot = (e) => !!e && e.endsWith("spot");                     // спотовые фиды — Вика их НЕ торгует (в уведомления не берём)

  let CFG = load();
  const BUF = {};                    // "sym::ex" -> [[t,price]] клиентский буфер (плавная живая линия)
  const SEEDSIG = {};                // "sym::ex" -> сигнатура последнего сида (len:t0:t1:last) → сервер вернул то же окно = НЕ пересобираем массив
  let DEEPKQ = [];                   // очередь монет на тяжёлый сид свечей (kline) — раскидываем по тикам, не грузим 5 фетчей разом при открытии
  const SEEDBUSY = {};               // feed-тип -> идёт ли сейчас медленный сид-фетч (px/ex/dex): НЕ наслаиваем запросы при холодном серверном кэше → детально, но без зависания
  const VIS = {};                    // "sym::ex" -> bool: показывается ли линия сейчас (гистерезис кластер-фильтра, чтобы не мигала)
  const SCALE = {};                  // sym -> {hi,lo} сглаженная шкала графика (не телепортируем окно при появлении/уходе линии)
  const ACTIVE = {};                 // sym -> {bucket} — трекинг пробоя порога (для дедупа алертов)
  const LOG_LS = "mxdex.log.v1", LOG_MAX = 60;
  let FEEDLOG = loadLog();            // ИСТОРИЯ спред-коллов (копится, не сбрасывается, хранится в localStorage)
  function loadLog() { try { const j = JSON.parse(localStorage.getItem(LOG_LS)); if (Array.isArray(j)) return j.slice(0, LOG_MAX); } catch (e) {} return []; }
  function saveLog() { try { localStorage.setItem(LOG_LS, JSON.stringify(FEEDLOG.slice(0, LOG_MAX))); } catch (e) {} }
  function pushLog(ev) { FEEDLOG.unshift(ev); if (FEEDLOG.length > LOG_MAX) FEEDLOG.length = LOG_MAX; saveLog(); }
  let SYMS = [];                     // список монет для поиска в ячейках
  const PINDATA = {};                // sym -> {gap,rise}
  let META = {};                     // sym -> {ex:{last,turn,rise}} свежие цены
  const LIQ = {};                    // sym -> $ ликвидности MEXC (сколько можно зайти до сдвига 0.5%)
  const CELLWIN = {};                // sym -> своё окно графика (колесо крутит ТОЛЬКО свою ячейку, не все)
  const SEEDED = {};                 // sym -> окно (сек), на которое УЖЕ подтянута история (новая монета/зум шире → сид СРАЗУ, не ждать циклов)
  const WHERE = {};                  // sym -> [[ex,url],...] на каких биржах монета есть (бейджи под монетой, клик = переход)
  const CELLFEEDS = {};              // sym -> [loEx,hiEx] биржи, где у монеты РЕАЛЬНЫЙ спред → их линии рисуем в ячейке (даже если тумблер выкл)
  const WORDER = ["mexc", "binance", "bybit", "okx", "gate", "bitget", "bingx", "ourbit", "weex", "kucoin", "asterdex", "hyperliquid", "lighter",
    "htx", "lbank", "bitmart", "xt", "blofin", "bitunix", "whitebit", "mexcspot", "binancespot", "bybitspot", "gatespot", "okxspot", "bitgetspot"];   // порядок: тяжи сперва
  const winOf = (sym) => CELLWIN[sym] || CFG.windowSec;
  const maxWin = () => { let m = CFG.windowSec; for (const s in CELLWIN) if (CELLWIN[s] > m) m = CELLWIN[s]; return m; };
  let timer = null, raf = null, firstScan = true;
  const win = () => g("mxwin");

  function load() { try { const j = JSON.parse(localStorage.getItem(LS)); if (j) return Object.assign({}, DEF, j, { ex: j.ex || DEF.ex, cards: j.cards || DEF.cards, pinned: j.pinned || [], minturn: DEF.minturn, maxgap: DEF.maxgap }); } catch (e) {} return JSON.parse(JSON.stringify(DEF)); }
  function save() { try { localStorage.setItem(LS, JSON.stringify(CFG)); } catch (e) {} }
  const has = (id) => CFG.ex.indexOf(id) >= 0;
  function toggle(id) { const i = CFG.ex.indexOf(id); if (i >= 0) CFG.ex.splice(i, 1); else CFG.ex.push(id); save(); }
  const nowS = () => Date.now() / 1000;

  function fmtUsd(v) { v = Math.round(v || 0); if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B"; if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M"; if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K"; return "$" + v; }
  function normSym(s) { s = (s || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, ""); if (!s) return ""; return s.endsWith("_USDT") ? s : s.replace(/USDT$/, "") + "_USDT"; }
  function decOf(v) { v = Math.abs(v || 0); return v >= 100 ? 2 : v >= 1 ? 4 : v >= 0.01 ? 5 : 8; }
  function bucketOf(gap) { let b = 0; for (const t of THRESH) if (gap >= t) b = t; return b; }
  function hhmmss(ts) { const d = new Date(ts); const p = (n, l) => String(n).padStart(l || 2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); }

  // ── приятный звон (WebAudio) ──
  let AC = null;
  function chime(strong) {
    if (!CFG.sound) return;
    try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === "suspended") AC.resume();
      const t0 = AC.currentTime, notes = strong ? [587.33, 880.0] : [659.25, 523.25];   // мягкое, тёплое двузвучие
      notes.forEach((f, i) => { const o = AC.createOscillator(), gg = AC.createGain();
        o.type = "sine"; o.frequency.value = f; o.connect(gg); gg.connect(AC.destination);
        const t = t0 + i * 0.13; gg.gain.setValueAtTime(0.0001, t);
        gg.gain.exponentialRampToValueAtTime(0.075, t + 0.04);                            // тише
        gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);                           // дольше, мягкий хвост
        o.start(t); o.stop(t + 0.78); });
    } catch (e) {}
  }

  // ── верхняя панель бирж (S/F) + FAIR + DEX ──
  function renderBar() {
    const bar = g("mxbar"); if (!bar) return;
    let h = SRC.map((sr) => {
      const letter = (kind, id, tip) => id
        ? '<span class="mxsf' + (has(id) ? " on" : "") + '" data-id="' + id + '" style="--exc:' + sr.c + '" title="' + tip + '">' + kind + '</span>'
        : '<span class="mxsf dis" title="фид не подключён">' + kind + '</span>';
      return '<span class="mxsrc v"><span class="mxsrclbl" style="--exc:' + sr.c + '">' + sr.lbl + '</span><span class="mxsfrow">' +
        letter("S", sr.s, "спот") + letter("F", sr.f, "фьюч") + letter("Ф", sr.fx, "справедливая (mark) цена биржи") + '</span></span>';
    }).join("");
    h += SPECIAL.map((sp) => '<span class="mxsrc"><span class="mxsf' + (has(sp.id) ? " on" : "") + '" data-id="' + sp.id + '" style="--exc:' + sp.c + ';border-left:0;padding:0 9px" title="' + sp.title + '">' + sp.lbl + '</span></span>').join("");
    bar.innerHTML = h;
    bar.querySelectorAll(".mxsf[data-id]").forEach((el) => { el.onclick = () => { toggle(el.dataset.id); renderBar(); }; });
  }

  // ── нижняя панель: зум окна ──
  function renderZoom() {
    const z = g("mxzoom"); if (!z) return;
    z.innerHTML = WINS.map((w) => '<button class="mxzb' + (CFG.windowSec === w[0] ? " on" : "") + '" data-w="' + w[0] + '">' + w[1] + '</button>').join("");
    z.querySelectorAll(".mxzb").forEach((b) => { b.onclick = () => { CFG.windowSec = +b.dataset.w; for (const s in CELLWIN) delete CELLWIN[s]; save(); renderZoom(); }; });   // кнопка = общее окно для всех (сброс индивидуальных)
  }

  // ── попап настроек сетки ──
  function setTxt(id, v) { const e = g(id); if (e) e.textContent = v; }
  function buildCols() { const c = g("mxcols"); if (!c) return;
    c.innerHTML = [1, 2, 3, 4, 5, 6].map((n) => '<button class="' + (CFG.cols === n ? "on" : "") + '" data-c="' + n + '">' + n + '</button>').join("");
    c.querySelectorAll("button").forEach((b) => { b.onclick = () => { CFG.cols = +b.dataset.c; save(); buildCols(); applyGrid(); }; }); }
  function closeSettings() { const s = g("mxset"); if (s) { s.classList.add("hidden"); s.style.display = "none"; } document.removeEventListener("mousedown", onDocDown); document.removeEventListener("keydown", onSetKey); }
  function onDocDown(e) { const s = g("mxset"); if (!s || s.classList.contains("hidden")) return; if (s.contains(e.target) || (e.target && e.target.id === "mxgear")) return; closeSettings(); }
  function onSetKey(e) { if (e.key === "Escape") closeSettings(); }
  function openSettings() {
    const s = g("mxset"); if (!s) return;
    if (!s.classList.contains("hidden")) { closeSettings(); return; }     // повторный клик по ⚙ — закрыть
    const st = g("mxstat");
    try {
      s.classList.remove("hidden"); s.style.display = "";
      const hh = s.querySelector(".mxseth"); if (hh && hh.childNodes[0]) hh.childNodes[0].nodeValue = "Настройки сетки · v246  ";   // видно версию при открытии
      s.onmousedown = (e) => e.stopPropagation();     // не отдавать mousedown драгу окна — иначе клики внутри «съедаются»
      const xb = g("mxset-x"); if (xb) { xb.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); closeSettings(); }; xb.onclick = closeSettings; }
      document.addEventListener("keydown", onSetKey);
      setTimeout(() => document.addEventListener("mousedown", onDocDown), 0);   // без capture — не мешает кликам внутри
      buildCols();
      const ch = g("mxcellh"); if (ch) { ch.value = CFG.cellH; setTxt("mxcellhv", CFG.cellH); ch.oninput = () => { CFG.cellH = +ch.value; setTxt("mxcellhv", CFG.cellH); applyGrid(); save(); }; }
      const lw = g("mxlw"); if (lw) { lw.value = CFG.lw; setTxt("mxlwv", CFG.lw); lw.oninput = () => { CFG.lw = +lw.value; setTxt("mxlwv", CFG.lw); save(); }; }
      const fw = g("mxfw"); if (fw) { fw.value = CFG.feedW; setTxt("mxfwv", CFG.feedW); fw.oninput = () => { CFG.feedW = +fw.value; setTxt("mxfwv", CFG.feedW); applyGrid(); save(); }; }
    } catch (e) { if (st) { st.textContent = "НАСТР.ОШИБКА: " + (e && e.message || e); st.style.color = "#ef5f5a"; } }
  }

  // ── лента коллов: расхождение между биржами (+DEX) ИЛИ памп/дамп ≥ порога. Споты не берём. ──
  function alertChime(ev, bucket) {
    chime(bucket >= 15);
    const base = ev.sym.replace("_USDT", "");
    const pair = (ev.loEx && ev.hiEx) ? " · " + (LBL[ev.loEx] || ev.loEx) + " → " + (LBL[ev.hiEx] || ev.hiEx) : "";
    const pumpTxt = (Math.abs(ev.pump || 0) >= ACTIVITY_MIN) ? " · " + (ev.pump >= 0 ? "🚀памп +" : "🔻дамп ") + ev.pump.toFixed(1) + "%" : "";
    try { if (typeof notify === "function") notify(base + " Δ" + (ev.gap || 0).toFixed(1) + "%" + pair + pumpTxt, bucket >= 15 ? "warn" : "info"); } catch (e) {}
  }
  function processRows(rows) {
    const nowT = Date.now(), seen = new Set();
    for (const r of rows) {
      if (isSpot(r.loEx) || isSpot(r.hiEx)) continue;                           // спот-пару вообще не рассматриваем (Вика спот не торгует)
      const mv = Math.abs(r.pump || 0);                                         // памп/дамп монеты за ~90с (АКТИВНОСТЬ)
      // ОДИН ПОРОГ на оба: сигнал = расхождение ≥ порога И памп/дамп ≥ порога (оба сразу) → монета активна, график НЕ стоит.
      if (r.gap < CFG.thresh || mv < CFG.thresh) continue;
      seen.add(r.symbol);
      const inten = Math.max(r.gap, Math.abs(r.pump || 0)), b = bucketOf(inten), prev = ACTIVE[r.symbol];
      // сигнал: 1) НОВЫЙ колл  2) пробой более ВЫСОКОГО порога интенсивности  3) держится ≥10 мин с прошлого сигнала
      const isNew = !prev, escal = prev && b > prev.bucket;
      const repeat = prev && nowT - (prev.al || prev.t) >= RE_ALERT_MS;
      const fire = isNew || escal || repeat;
      const bucket = prev ? Math.max(prev.bucket, b) : b;                       // порог ЗАЛИПАЕТ на максимуме → колебания у порога не спамят
      ACTIVE[r.symbol] = { bucket: bucket, t: (isNew || escal) ? nowT : prev.t,
        al: fire ? nowT : (prev.al || prev.t), gone: 0 };                       // al = время последнего сигнала (кулдаун 10 мин)
      if (fire && !firstScan) {                                                 // ПИШЕМ в историю (копится, не удаляется)
        const ev = { sym: r.symbol, gap: r.gap, pump: r.pump || 0, rise: r.rise, loEx: r.loEx, hiEx: r.hiEx, bucket: b, t: nowT };
        pushLog(ev); alertChime(ev, b);
      }
    }
    for (const sym in ACTIVE) {                                                 // монета ушла из спреда → сброс ТОЛЬКО после 3 мин отсутствия:
      if (seen.has(sym)) continue;                                             // мелкий провал у порога не считается «новым разрывом»,
      const a = ACTIVE[sym];                                                    // а настоящее исчезновение (3+ мин) → возврат = новый сигнал
      if (!a.gone) a.gone = nowT; else if (nowT - a.gone > GONE_RESET_MS) delete ACTIVE[sym];
    }
    firstScan = false;
  }
  function gapClass(b) { return b >= 50 ? "g50" : b >= 30 ? "g30" : b >= 20 ? "g20" : b >= 15 ? "g15" : b >= 10 ? "g10" : b >= 8 ? "g8" : b >= 5 ? "g5" : ""; }
  function exTag(id) { return '<span class="mxpe" style="--exc:' + (COL[id] || "#8a929c") + '">' + (LBL[id] || (id || "?").toUpperCase()) + '</span>'; }
  function feedRow(a, pinned) {
    const sym = a.sym, base = sym.replace("_USDT", ""), gap = a.gap || 0, pump = a.pump || 0;
    const col = COL[a.hiEx || a.loEx || "mexc"] || "#8a929c";
    const pair = (a.loEx && a.hiEx) ? '<span class="mxpair">' + exTag(a.loEx) + '→' + exTag(a.hiEx) + '</span>' : "";
    const pumpTag = (Math.abs(pump) >= ACTIVITY_MIN) ? '<span class="mxpump ' + (pump >= 0 ? "up" : "dn") + '">' + (pump >= 0 ? "🚀+" : "🔻") + pump.toFixed(1) + '%</span>' : "";
    const sub = pinned ? '<span class="mxrtime">📌 закреплено</span>' : (pair + pumpTag + '<span class="mxrtime">' + (a.t ? hhmmss(a.t) : "") + '</span>');
    const fresh = (!pinned && a.t && (Date.now() - a.t) < 12000) ? " fresh" : "";   // свежий сигнал (<12с) — подсвечиваем и пульсируем
    return '<div class="mxrow' + fresh + '" data-sym="' + sym + '" style="--bar:' + col + '"><div class="mxrbar"></div>' + (fresh ? '<span class="mxrnew">🔔</span>' : '') +
      '<div class="mxrmid"><span class="mxrsym">' + base + '</span><span class="mxrsub">' + sub + '</span></div>' +
      '<div class="mxrright"><span class="mxrgap">' + gap.toFixed(gap >= 10 ? 0 : 1) + '%</span>' +
      (pinned ? '<span class="mxrpin" data-unpin="' + sym + '" title="открепить">✕</span>' : '') + '</div></div>';
  }
  function renderFeed(bySym) {
    const feed = g("mxfeed"); if (!feed) return; let html = "";
    for (const sym of CFG.pinned) { const d = PINDATA[sym] || {}; const r = bySym[sym] || {}; html += feedRow({ sym: sym, gap: d.gap || 0, loEx: r.loEx, hiEx: r.hiEx }, true); }
    for (const ev of FEEDLOG) { if (CFG.pinned.indexOf(ev.sym) >= 0) continue;
      if (isSpot(ev.loEx) || isSpot(ev.hiEx)) continue;                        // старые СПОТ-записи скрываем
      if (Math.abs(ev.pump || 0) < ACTIVITY_MIN) continue;                     // старые «застывшие» записи (без пампа) не показываем — только реальные памп+спред
      html += feedRow(ev, false); }                                           // ИСТОРИЯ (копится)
    if (!html) { feed.innerHTML = '<div class="mxfhint">Пока тихо. Сигнал появится, когда монета РАЗЪЕДЕТСЯ ≥ ' + CFG.thresh + '% между биржами/DEX И одновременно даст памп/дамп ≥ ' + CFG.thresh + '% за ~90с.</div>'; return; }
    feed.innerHTML = html;
    feed.querySelectorAll(".mxrpin").forEach((el) => { el.onclick = (e) => { e.stopPropagation(); unpin(el.dataset.unpin); }; });
    feed.querySelectorAll(".mxwb").forEach((el) => { el.onclick = (e) => { e.stopPropagation(); if (el.dataset.url) window.open(el.dataset.url, "_blank"); }; });   // квадратик биржи = переход на её страницу монеты
    feed.querySelectorAll(".mxrow").forEach((el) => { el.onclick = () => openInCell(el.dataset.sym); });
  }

  // ── применить размеры сетки/ленты (из настроек) ──
  function applyGrid() {
    const grid = g("mxgrid"); if (grid) { grid.style.gridTemplateColumns = "repeat(" + CFG.cols + ",1fr)"; grid.style.gridAutoRows = CFG.cellH + "px"; }
    const fc = document.querySelector(".mxfeedcol"); if (fc) { if (CFG.feedW <= 0) { fc.style.display = "none"; } else { fc.style.display = ""; fc.style.width = CFG.feedW + "px"; } }
  }

  // ── сетка ячеек ──
  function renderGrid() {
    const grid = g("mxgrid"); if (!grid) return;
    applyGrid();
    grid.innerHTML = "";
    CFG.cards.forEach((sym, idx) => {
      const cell = document.createElement("div"); cell.className = "mxcell"; cell.dataset.idx = idx;
      if (!sym) {
        cell.innerHTML = '<div class="mxempty">выбери монету<input class="mxcsearch" placeholder="напр. GWEI" autocomplete="off"></div>';
      } else {
        cell.innerHTML = '<div class="mxchead"><span class="mxcsym" title="клик — открыть стакан (Ourbit / WEEX / MEXC)">📖 ' + sym.replace("_USDT", "") + '</span>' +
          '<span class="mxca" title="задать контракт/пару DEX — вставь ссылку Dexscreener или CA (как у друга)">CA</span><span class="mxsp"></span><b class="mxcgap" title="спред между биржами">—</b>' +
          '<button class="mxcedit" title="сменить монету — поиск">✏</button><button class="mxcx" title="убрать ячейку">×</button></div>' +
          '<canvas class="mxccanvas"></canvas><div class="mxcfoot"></div>';
      }
      grid.appendChild(cell);
      const inp = cell.querySelector(".mxcsearch");                 // поле в пустой ячейке — открывает поиск
      if (inp) inp.addEventListener("focus", () => openSearchAt(inp, idx));
      const ed = cell.querySelector(".mxcedit"); if (ed) ed.onclick = () => openSearchAt(ed, idx);   // карандаш = поиск/смена монеты
      const cabtn = cell.querySelector(".mxca"); if (cabtn) cabtn.onclick = () => setDexMap(sym);      // CA = задать контракт/пару DEX
      const sy = cell.querySelector(".mxcsym"); if (sy) sy.onclick = () => openBookMenu(sym, sy);
      const cx = cell.querySelector(".mxcx"); if (cx) cx.onclick = () => { CFG.cards.splice(idx, 1); save(); renderGrid(); };
      const cv = cell.querySelector(".mxccanvas");
      if (cv) {
        cv.addEventListener("wheel", (e) => { e.preventDefault();          // колесо крутит ТОЛЬКО эту ячейку (её окно), не все графики
          const cur = winOf(sym); CELLWIN[sym] = Math.max(15, Math.min(18000, Math.round(cur * (e.deltaY < 0 ? 0.8 : 1.25)))); }, { passive: false });
        // ЛИНЕЙКА: Shift+тяни ИЛИ средняя кнопка мыши (колёсико) — измерить спред между двумя ценами
        const rel = (e) => { const rc = cv.getBoundingClientRect(); return { x: e.clientX - rc.left, y: e.clientY - rc.top }; };
        cv.addEventListener("mousedown", (e) => { if (!(e.shiftKey || e.button === 1)) return; e.preventDefault();
          const p = rel(e); cell._ruler = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; cell._rul = true; });
        cv.addEventListener("mousemove", (e) => { const p = rel(e); cell._cross = p; if (cell._rul) { cell._ruler.x1 = p.x; cell._ruler.y1 = p.y; } });   // перекрестие следует за мышью
        const endRul = () => { cell._rul = false; cell._ruler = null; };                     // отпустила — линейка пропала
        cv.addEventListener("mouseup", endRul);
        cv.addEventListener("mouseleave", () => { cell._cross = null; if (cell._rul) endRul(); });   // ушла — перекрестие пропало
      }
    });
  }
  function setCardCoin(idx, raw) { const sym = normSym(raw); if (!sym) return;
    if (idx >= CFG.cards.length) CFG.cards.push(sym); else CFG.cards[idx] = sym;
    save(); renderGrid(); poll(); }
  function setDexMap(sym) {                                        // задать контракт/пару DEX вручную (как THIEF)
    const base = sym.replace("_USDT", "");
    const inp = prompt("DEX для " + base + ":\nвставь ссылку Dexscreener (…/chain/pair) или адрес контракта (CA)", "");
    if (inp == null) return; const s = inp.trim(); if (!s) return;
    let chain = "", pair = "", ca = "";
    const mm = s.match(/(?:dexscreener\.com|dextools\.io\/app\/[a-z-]+)\/([a-z0-9-]+)\/(?:pair-explorer\/)?([A-Za-z0-9]+)/i);
    if (mm) { chain = mm[1].toLowerCase(); pair = mm[2]; } else { ca = s.replace(/[^A-Za-z0-9]/g, ""); }
    const q = "base=" + encodeURIComponent(base) + (pair ? ("&chain=" + encodeURIComponent(chain) + "&pair=" + encodeURIComponent(pair)) : ("&ca=" + encodeURIComponent(ca)));
    fetch("/api/dexmap?" + q).then((x) => x.json()).then(() => { if (!has("dex")) { CFG.ex.push("dex"); save(); renderBar(); } delete BUF[sym + "::dex"]; poll(); }).catch(() => {});
  }
  function flashCell(sym) {                             // подсветить существующую ячейку монеты и проскроллить к ней (стиль на DIV, не на canvas → dirty-рендер не трогаем)
    const grid = g("mxgrid"); if (!grid) return;
    const idx = CFG.cards.indexOf(sym); if (idx < 0) return;
    let cell = null; for (const ch of grid.children) { if (+ch.dataset.idx === idx) { cell = ch; break; } }
    if (!cell) return;
    cell.classList.remove("mxflash"); void cell.offsetWidth; cell.classList.add("mxflash");   // рестарт анимации если кликнули повторно
    setTimeout(() => cell.classList.remove("mxflash"), 1500);
    try { cell.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
  }
  function openInCell(raw) { const sym = normSym(raw); if (!sym) return;
    if (CFG.cards.indexOf(sym) >= 0) { flashCell(sym); return; }   // уже открыта — не дублируем, а подсвечиваем и скроллим к ней
    let idx = CFG.cards.indexOf("");                    // есть пустая ячейка? заполнить её
    if (idx >= 0) CFG.cards[idx] = sym; else CFG.cards.push(sym);   // иначе — новая ячейка рядом
    save(); renderGrid(); poll(); }
  function openInDom(sym) { if (!sym) return; const base = sym.replace("_USDT", "");
    try { navigator.clipboard.writeText(base); } catch (e) {}
    const hasS = typeof S !== "undefined";
    if (typeof openSymbolOn === "function") { if (hasS && S.instr && S.instr[sym]) return openSymbolOn(sym, "ourbit"); if (hasS && S._weexSet && S._weexSet.has(base)) return openSymbolOn(sym, "weex"); }
    if (typeof switchSymbol === "function") switchSymbol(sym); }
  // ── открыть стакан монеты на нужной бирже (терминал умеет Ourbit / WEEX / MEXC) ──
  function openBook(sym, ex) {
    try { navigator.clipboard.writeText(sym.replace("_USDT", "")); } catch (e) {}
    if (ex === "mexc") { if (typeof switchSymbol === "function") switchSymbol(sym); if (typeof setMexcMode === "function") setMexcMode(true); }
    else if (typeof openSymbolOn === "function") openSymbolOn(sym, ex);
  }
  let BOOKMENU = null;
  function closeBookMenu() { if (BOOKMENU) { BOOKMENU.remove(); BOOKMENU = null; } document.removeEventListener("mousedown", bookOut, true); }
  function bookOut(e) { if (BOOKMENU && !BOOKMENU.contains(e.target)) closeBookMenu(); }
  function openBookMenu(sym, anchor) {
    closeBookMenu(); const m = document.createElement("div"); m.className = "mxbookmenu";
    const base = sym.replace("_USDT", "");
    try { navigator.clipboard.writeText(base); } catch (e) {}              // КЛИК ПО МОНЕТЕ = сразу копируем тикер (без отдельного пункта)
    const exs = [["ourbit", "🐸 Ourbit"], ["weex", "🟠 WEEX"], ["mexc", "🔵 MEXC"]];
    m.innerHTML = '<div class="mxbmh">' + base + ' ✅ скопирован — открыть стакан</div>' +
      exs.map((e) => '<button data-ex="' + e[0] + '">' + e[1] + '</button>').join("");
    document.body.appendChild(m); const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(innerWidth - 170, Math.max(6, r.left)) + "px"; m.style.top = (r.bottom + 4) + "px";
    m.querySelectorAll("button").forEach((b) => { b.onclick = () => { openBook(sym, b.dataset.ex); closeBookMenu(); }; });
    BOOKMENU = m; setTimeout(() => document.addEventListener("mousedown", bookOut, true), 0);
  }

  // ── на каких биржах монета есть: подгрузка + компактные квадратики (цвет биржи, F=фьюч/S=спот, клик = страница монеты) ──
  async function loadWhere(syms) {
    const missing = []; for (const s of syms) if (s && !WHERE[s] && missing.indexOf(s) < 0) missing.push(s);
    if (!missing.length) return;
    try { const r = await fetch("/api/mxwhere?symbols=" + encodeURIComponent(missing.slice(0, 60).join(","))).then((x) => x.json());
      if (r && r.ok) for (const sym in (r.where || {})) { const rows = r.where[sym]; if (rows && rows.length) WHERE[sym] = rows; }
    } catch (e) {}
  }
  function whereBadges(sym, max) {
    const rows = WHERE[sym]; if (!rows || !rows.length) return "";
    const m = {}; for (const r of rows) m[r[0]] = r[1];
    let h = "", n = 0;
    for (const ex of WORDER) { if (!(ex in m)) continue; if (n >= max) break; n++;
      h += '<span class="mxwb" data-url="' + (m[ex] || "") + '" title="' + (LBL[ex] || ex) + ' — открыть страницу монеты" style="--exc:' + (COL[ex] || "#8a929c") + '">' + (ex.endsWith("spot") ? "S" : "F") + '</span>';
    }
    return h ? '<span class="mxwrow">' + h + '</span>' : "";
  }

  function pin(raw) { const sym = normSym(raw); if (!sym) return; if (CFG.pinned.indexOf(sym) < 0) CFG.pinned.push(sym); save(); poll(); }
  function unpin(sym) { const i = CFG.pinned.indexOf(sym); if (i >= 0) CFG.pinned.splice(i, 1); delete PINDATA[sym]; save(); renderFeed({}); }

  // ── буфер живых цен ──
  function latestOf(rec, id) { if (rec.m && rec.m[id] && rec.m[id].last) return rec.m[id].last; if (rec.s && rec.s[id] && rec.s[id].length) return rec.s[id][rec.s[id].length - 1][1]; return null; }
  function ingest(sym, rec) {
    const now = nowS();
    const ids = CFG.ex.slice();                                          // тумблеры + пары-биржи монеты (чтобы линии спот-бирж тоже писались в буфер)
    const cf = CELLFEEDS[sym]; if (cf) for (const e of cf) if (ids.indexOf(e) < 0) ids.push(e);
    for (const id of ids) {
      const key = sym + "::" + id; let buf = BUF[key] || (BUF[key] = []);
      if (rec.s && rec.s[id] && rec.s[id].length) {                       // доливаем историю сервера по мере прогрева фида (не только при пустом буфере)
        const srv = rec.s[id];
        if (buf.length === 0) { for (const p of srv) buf.push([p[0], p[1]]); }
        else if (srv[0][0] < buf[0][0] - 0.5) {                           // есть ли вообще точки СТАРШЕ начала буфера — иначе не тратим O(n) filter каждую секунду
          const firstT = buf[0][0], older = srv.filter((p) => p[0] < firstT - 0.5);
          for (let i = older.length - 1; i >= 0; i--) buf.unshift([older[i][0], older[i][1]]); }
      }
      const v = latestOf(rec, id);
      if (v) { const lp = buf[buf.length - 1]; if (!lp || now - lp[0] >= 0.8) buf.push([now, v]); else lp[1] = v; }   // КАЖДУЮ секунду — точка (каждое движение)
      if (_pc % 4 === 0) {                                                // тримминг старья — раз в ~4с (не каждую секунду по всем биржам) и одним splice вместо цепочки shift (каждый shift = O(n))
        const cutoff = now - Math.max(2400, winOf(sym) + 600);           // держим на всё окно ячейки (до 24ч)
        let cut = 0; while (cut < buf.length && buf[cut][0] < cutoff) cut++;
        if (cut > 0) buf.splice(0, cut);
      }
      if (buf.length > 30000) buf.splice(0, buf.length - 30000);          // хватит на ~8ч посекундно
    }
  }
  function seedBuf(key, pts) {                                            // префикс истории свечами в буфер линии (только точки старше имеющихся)
    if (!pts || !pts.length) return;
    const buf = BUF[key] || (BUF[key] = []); const now = nowS();
    const firstLive = buf.length ? buf[0][0] : now;
    if (pts[0][0] >= firstLive - 1) return;                              // весь kline новее уже имеющегося начала → нечего префиксить (частый случай после первого сида) — не тратим O(n) filter
    const hist = []; for (const p of pts) if (p[0] < firstLive - 1 && p[1] > 0) hist.push(p);
    if (hist.length) { for (let i = hist.length - 1; i >= 0; i--) buf.unshift([hist[i][0], hist[i][1]]); if (buf.length > 30000) buf.splice(0, buf.length - 30000); }
  }
  // подгрузка истории MEXC + СПРАВЕДЛИВОЙ свечами (детально, до 24ч) — «каждое движение чётко»
  async function klineSeed(syms) {
    const minutes = Math.min(1440, Math.max(60, Math.ceil(maxWin() / 60) + 10));   // разрешение по окну: 4ч→Min1×250, 24ч→Min1×1440
    try { const r = await fetch("/api/mxkline?minutes=" + minutes + "&symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.kline || {})) { const pts = r.kline[sym]; if (!pts || !pts.length) continue;
        seedBuf(sym + "::mexc", pts);
        seedBuf(sym + "::mexcfair", pts);                                 // справедливая ≈ цена MEXC → та же история (тоже на 24ч)
      }
    } catch (e) {}
  }
  // подгрузка ПОЛНОЙ истории DEX свечами (GeckoTerminal) — префикс к живому буферу линии DEX (как у MEXC)
  async function dexKlineSeed(syms) {
    if (!has("dex")) return;
    const minutes = Math.min(1440, Math.max(60, Math.ceil(maxWin() / 60) + 10));   // история DEX по окну (детально)
    try { const r = await fetch("/api/dexkline?minutes=" + minutes + "&symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.kline || {})) { const pts = r.kline[sym]; if (!pts || !pts.length) continue;
        seedBuf(sym + "::dex", pts);
      }
    } catch (e) {}
  }
  // ПОСВОПОВАЯ линия DEX: каждая сделка в пуле = точка (GeckoTerminal /trades). Детально, как у друга. Владеет недавним окном DEX.
  async function dexTradesSeed(syms) {
    if (!has("dex") || !syms || !syms.length || SEEDBUSY.dex) return;   // in-flight-гард: не наслаиваем свопы (серверный кэш 6с) — детально, без затыка
    SEEDBUSY.dex = true;
    try { const r = await fetch("/api/dextrades?symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.trades || {})) { const pts = r.trades[sym]; if (pts && pts.length) pxSeed(sym + "::dex", pts); }
    } catch (e) {} finally { SEEDBUSY.dex = false; }
  }
  const KLINE_EX = ["bybit", "binance", "gate", "bitget", "okx"];         // биржи с подключённой историей свечей (полная линия слева)
  const TRADES_EX = ["bybit", "binance", "gate", "bitget", "okx"];        // биржи с per-trade историей (детализация старой части линии по сделкам)
  // ПОЛНАЯ ИСТОРИЯ ДРУГИХ БИРЖ: свечи каждой биржи → префикс к линии (как у MEXC), чтобы график был не с середины
  async function exKlineSeed(syms) {
    const exset = {};                                                    // какие биржи показываем (тумблеры + пары монет) и умеем их свечи
    for (const e of CFG.ex) if (KLINE_EX.indexOf(e) >= 0) exset[e] = 1;
    for (const s of syms) { const cf = CELLFEEDS[s]; if (cf) for (const e of cf) if (KLINE_EX.indexOf(e) >= 0) exset[e] = 1; }
    const exs = Object.keys(exset); if (!exs.length) return;
    const minutes = Math.min(1440, Math.max(60, Math.ceil(maxWin() / 60) + 10));
    try { const r = await fetch("/api/exkline?minutes=" + minutes + "&exs=" + exs.join(",") + "&symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.kline || {})) { const byex = r.kline[sym] || {};
        for (const ex in byex) { const pts = byex[ex]; if (pts && pts.length) seedBuf(sym + "::" + ex, pts); }   // префикс истории (не трогает живой хвост)
      }
    } catch (e) {}
  }
  // ПОСДЕЛОЧНАЯ ДЕТАЛИЗАЦИЯ СТАРОЙ линии бирж: каждая сделка биржи = точка (recent-trade REST). Глубина = CFG.mxtrades.
  // Владеет окном [t0..t1] последних N сделок (детальнее рекордера и глубже назад) — как dexTradesSeed для DEX. seedBuf-свечи остаются fallback ещё старше.
  async function exTradesSeed(syms) {
    const exset = {};                                                    // какие биржи показываем (тумблеры + пары монет) и умеем их сделки
    for (const e of CFG.ex) if (TRADES_EX.indexOf(e) >= 0) exset[e] = 1;
    for (const s of syms) { const cf = CELLFEEDS[s]; if (cf) for (const e of cf) if (TRADES_EX.indexOf(e) >= 0) exset[e] = 1; }
    const exs = Object.keys(exset); if (!exs.length || SEEDBUSY.ex) return;   // in-flight-гард: сделки бирж — тяжёлый fan-out (кэш 8с) → не запускаем новый, пока прежний в полёте
    SEEDBUSY.ex = true;
    const lim = Math.max(50, Math.min(1000, CFG.mxtrades || 500));
    try { const r = await fetch("/api/extrades?limit=" + lim + "&exs=" + exs.join(",") + "&symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.trades || {})) { const byex = r.trades[sym] || {};
        for (const ex in byex) { const pts = byex[ex]; if (pts && pts.length) pxSeed(sym + "::" + ex, pts); }   // pxSeed уважает SEEDSIG-скип (нет новых сделок = не пересобираем)
      }
    } catch (e) {} finally { SEEDBUSY.ex = false; }
  }
  // плотная посекундная история: заменяет её окном [t0..t1] буфера (per-second ПОБЕЖДАЕТ грубые свечи в этом диапазоне),
  // сохраняя грубую историю СТАРШЕ t0 (fallback за пределами рекордера) и живой хвост НОВЕЕ t1
  function pxSeed(key, pts) {
    if (!pts || !pts.length) return;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const sig = pts.length + ":" + t0 + ":" + t1 + ":" + pts[pts.length - 1][1];
    if (SEEDSIG[key] === sig) return;                                    // сервер вернул ТО ЖЕ окно (нет новых свопов/тиков) → не пересобираем массив (живой хвост уже дописан ingest'ом)
    SEEDSIG[key] = sig;
    const buf = BUF[key] || (BUF[key] = []);
    // границы через бинарный поиск (буфер отсортирован по времени) — вместо двух O(n) filter + concat
    const iOlder = idxAtOrAfter(buf, t0 - 0.5);                          // всё ДО него — грубые свечи старше рекордера (оставляем как есть)
    const jNewer = idxAtOrAfter(buf, t1 + 0.5);                          // с него — живые точки новее последней записанной секунды
    const merged = buf.slice(0, iOlder);
    for (const p of pts) if (p[1] > 0) merged.push([p[0], p[1]]);        // плотная посекундная середина
    for (let i = jNewer; i < buf.length; i++) merged.push(buf[i]);       // порядок по времени сохранён (older<t0<=dense<=t1<newer)
    BUF[key] = merged;
    if (merged.length > 30000) merged.splice(0, merged.length - 30000);
  }
  // подгрузка ПЛОТНОЙ посекундной истории (серверный рекордер) — каждое движение MEXC/DEX/fair за окно, сразу при открытии
  async function pxHistSeed(syms) {
    if (!syms || !syms.length || SEEDBUSY.px) return;                      // in-flight-гард (посекундка серверная быстрая, но всё равно не наслаиваем)
    SEEDBUSY.px = true;
    const sec = Math.min(21600, Math.max(60, Math.ceil(maxWin()) + 30));            // окно ячейки в секундах, потолок 6ч (maxlen рекордера)
    try { const r = await fetch("/api/pxhist?sec=" + sec + "&symbols=" + encodeURIComponent(syms.join(","))).then((x) => x.json());
      if (!r || !r.ok) return;
      for (const sym in (r.hist || {})) { const h = r.hist[sym] || {};
        for (const feed in h) {
          if (feed === "dex") continue;                                    // DEX историю ведёт dexTradesSeed (посвоповая, детальнее)
          if (TRADES_EX.indexOf(feed) >= 0) continue;                      // CEX историю ведёт exTradesSeed (посделочно, глубже рекордера) — не перетираем окно
          const key = feed === "fair" ? "mexcfair" : feed;                 // mexc + справедливая — посекундно из рекордера
          pxSeed(sym + "::" + key, h[feed]);
        }
      }
    } catch (e) {} finally { SEEDBUSY.px = false; }
  }
  function spreadNow(sym) { const px = []; let rise = 0, hiT = -1;
    const m = META[sym] || {}; for (const ex in m) { if (ex.endsWith("fair")) continue; const v = m[ex]; if (v && v.last) { px.push(v.last); if (v.turn > hiT) { hiT = v.turn; rise = v.rise; } } }   // DEX учитываем (MEXC↔DEX), справедливые — нет
    if (px.length < 2) return { gap: 0, rise };
    const med = px.slice().sort((a, b) => a - b)[Math.floor(px.length / 2)];   // отсечь коллизии (>50% от медианы)
    const cl = px.filter((p) => med <= 0 || Math.abs(p - med) / med <= 0.5); const use = cl.length >= 2 ? cl : px;
    const mn = Math.min(...use), mx = Math.max(...use); return { gap: mn > 0 ? (mx - mn) / mn * 100 : 0, rise }; }

  // ── опрос ──
  let _pc = 0;
  async function poll() {
    if (!win() || win().classList.contains("hidden")) return;
    _pc++;
    // СКАНЕР СПРЕД-КОЛЛОВ: только ФЬЮЧ-биржи бара + DEX (сервер добавляет сам). СПОТ в уведомления НЕ берём (просьба Вики).
    // Тумблеры бара отвечают ТОЛЬКО за линии на графике.
    const feeds = SRC.reduce((a, sr) => { if (sr.f) a.push(sr.f); return a; }, []);
    const serFeeds = CFG.ex.filter((e) => e !== "mexcfair" && e !== "dex");   // серии графика: биржи + <ex>fair (сервер понимает суффикс)
    let bySym = {};
    {
      try { const gr = await fetch("/api/gaptop?n=80&minturn=" + CFG.minturn + "&maxgap=" + CFG.maxgap + "&ex=" + encodeURIComponent(feeds.join(","))).then((x) => x.json());
        if (gr && gr.ok) { for (const r of (gr.rows || [])) { bySym[r.symbol] = r;
            if (r.loEx || r.hiEx) CELLFEEDS[r.symbol] = [r.loEx, r.hiEx].filter((e) => e && e !== "dex"); }   // где реальный спред → линии в ячейке
          processRows(gr.rows || []);
          const st = g("mxstat2"); if (st) st.textContent = (gr.rows || []).length + " монет · " + Object.keys(ACTIVE).length + " в спреде · порог " + CFG.thresh + "%"; } } catch (e) {}
    }
    const need = []; for (const s of CFG.cards) if (s && need.indexOf(s) < 0) need.push(s); for (const s of CFG.pinned) if (need.indexOf(s) < 0) need.push(s);
    for (const s of need) if (!CELLFEEDS[s]) { const ev = FEEDLOG.find((e) => e.sym === s); if (ev && (ev.loEx || ev.hiEx)) CELLFEEDS[s] = [ev.loEx, ev.hiEx].filter((e) => e && e !== "dex"); }
    if (need.length) {
      const reqSet = {}; for (const e of serFeeds) reqSet[e] = 1;              // тумблеры + пары-биржи всех открытых монет → тянем их серии
      for (const s of need) { const cf = CELLFEEDS[s]; if (cf) for (const e of cf) reqSet[e] = 1; }
      const reqFeeds = Object.keys(reqSet);
      const url = "/api/gridseries?symbols=" + encodeURIComponent(need.join(",")) + "&ex=" + encodeURIComponent(reqFeeds.join(",")) + "&fair=" + (has("mexcfair") ? "1" : "0") + "&dex=" + (has("dex") ? "1" : "0");
      try { const r = await fetch(url).then((x) => x.json());
        if (r && r.ok) { const ser = r.series || {};
          for (const sym in ser) { META[sym] = ser[sym].m || {}; ingest(sym, ser[sym]); }
          for (const sym of CFG.pinned) PINDATA[sym] = spreadNow(sym); } } catch (e) {}
      if (_pc % 5 === 1) {                               // L (глубина MEXC) — раз в ~5с, чтобы не долбить стакан
        try { const lr = await fetch("/api/mxliq?symbols=" + encodeURIComponent(need.join(",")) + "&pct=0.5").then((x) => x.json());
          if (lr && lr.ok) Object.assign(LIQ, lr.liq || {}); } catch (e) {}
      }
      // МГНОВЕННЫЙ сид: новая монета или окно расширили → сразу тянем то, что ВИДНО в окне (посекундная + DEX),
      // а тяжёлые свечи-историю (5 фетчей) НЕ грузим одним тиком — ставим в очередь и раскидываем по следующим тикам.
      const deep = need.filter((s) => !(SEEDED[s] >= winOf(s)));
      if (deep.length) { for (const s of deep) SEEDED[s] = winOf(s);
        pxHistSeed(deep); dexTradesSeed(deep); exTradesSeed(deep);
        for (const s of deep) if (DEEPKQ.indexOf(s) < 0) DEEPKQ.push(s); }
      if (DEEPKQ.length) { const batch = DEEPKQ.splice(0, 3); klineSeed(batch); dexKlineSeed(batch); exKlineSeed(batch); }   // догруз свечей-истории пачками ≤3 монет за тик
      // ОТКРЫТЫЕ ЯЧЕЙКИ (видимые карточки) — их МАЛО → максимум детали: плотные сиды КАЖДЫЙ тик.
      // Реальную частоту холодных фетчей ограничивает серверный кэш (extrades 8с / dextrades 6с) + in-flight-гард
      // в самих сидах (не наслаиваем медленный запрос) → детально у края линии, но БЕЗ зависания.
      const hotSet = {}; for (const s of CFG.cards) if (s) hotSet[s] = 1;
      const hot = need.filter((s) => hotSet[s]).slice(0, HOT_MAX);      // видимые ячейки — детально каждую секунду
      const bg = need.filter((s) => !hotSet[s]);                        // фон (закреплённые сверх видимых) — оптимизировано, реже
      if (hot.length) { pxHistSeed(hot); exTradesSeed(hot); dexTradesSeed(hot); }   // посекундка + посделочно/посвопово у края — каждый тик
      if (bg.length) {                                                 // фон — прежний разнесённый режим (не грузим браузер при многих закреплённых)
        if (_pc % 4 === 1) pxHistSeed(bg);
        if (_pc % 4 === 3) exTradesSeed(bg);
        if (_pc % 2 === 0) dexTradesSeed(bg);
      }
      if (_pc % 8 === 4) { klineSeed(need); }                         // свечи MEXC — свой тик (fallback старше рекордера, история — можно реже)
      if (_pc % 8 === 6) { dexKlineSeed(need); exKlineSeed(need); }   // свечи DEX/других бирж — отдельный тик (не вместе с MEXC-свечами)
    }
    // на каких биржах есть монета — для бейджей (ячейки + лента + закреп), кэшируется
    const wsy = need.slice(); for (const ev of FEEDLOG.slice(0, 30)) if (wsy.indexOf(ev.sym) < 0) wsy.push(ev.sym);
    loadWhere(wsy);
    renderFeed(bySym);
  }

  // ── живой рендер (плавно, каждый кадр) ──
  let _lastFrame = 0;
  const EASE_FRAMES = 10;                                             // после смены данных дорисовываем ~10 кадров (шкала плавно доезжает по SCALE_K), потом ячейка «засыпает»
  function cellNewestT(sym) {                                         // самый свежий тик среди линий монеты — дёшево (last-элемент буферов, без обхода истории)
    let t = 0; const ex = CFG.ex;
    for (let i = 0; i < ex.length; i++) { const b = BUF[sym + "::" + ex[i]]; if (b && b.length) { const tt = b[b.length - 1][0]; if (tt > t) t = tt; } }
    const cf = CELLFEEDS[sym];
    if (cf) for (let i = 0; i < cf.length; i++) { const b = BUF[sym + "::" + cf[i]]; if (b && b.length) { const tt = b[b.length - 1][0]; if (tt > t) t = tt; } }
    return t;
  }
  function frame() { raf = requestAnimationFrame(frame);
    const w = win(); if (!w || w.classList.contains("hidden")) return;
    const t = Date.now(); if (t - _lastFrame < 55) return;             // ~18 fps: линии обновляются ~1с, 60fps не нужен → убирает лаги
    _lastFrame = t;
    const grid = g("mxgrid"); if (!grid) return;
    // DIRTY-ФЛАГ: ячейку перерисовываем ТОЛЬКО когда пришёл новый тик, идёт сглаживание шкалы, есть взаимодействие
    // мышью (перекрестие/линейка) или сменился размер холста. Иначе кадр пропускаем — главный поток свободен для кликов.
    try { for (const cell of grid.children) {
      const idx = +cell.dataset.idx, sym = CFG.cards[idx]; if (!sym) continue;
      const cv = cell.querySelector(".mxccanvas");
      const interacting = !!(cell._cross || cell._rul);
      const nt = cellNewestT(sym), cwin = winOf(sym);
      const cw2 = cv ? cv.clientWidth : 0, ch2 = cv ? cv.clientHeight : 0;
      if (interacting || cell._pInt || nt !== cell._nt || cwin !== cell._win || cw2 !== cell._cw || ch2 !== cell._ch) cell._ease = EASE_FRAMES;
      cell._pInt = interacting; cell._nt = nt; cell._win = cwin; cell._cw = cw2; cell._ch = ch2;
      if ((cell._ease | 0) > 0) { cell._ease--; drawCell(cell, sym); }
    } }
    catch (e) { const s = g("mxstat"); if (s) { s.textContent = "РИС.ОШИБКА: " + (e && e.message || e); s.style.color = "#ef5f5a"; } }
  }
  function idxAtOrAfter(b, t) { let lo = 0, hi = b.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b[m][0] < t) lo = m + 1; else hi = m; } return lo; }   // первый индекс с t≥порога (буфер отсортирован)
  // РОБАСТНЫЙ центр кластера цен: медиана, затем медиана только «ближних» (в 15%) значений → тёзки-выбросы не тянут центр
  function clusterMed(vals) {
    if (!vals.length) return 0;
    const s = vals.slice().sort((a, b) => a - b); const m = s[Math.floor(s.length / 2)];
    if (!(m > 0)) return 0;
    const near = s.filter((v) => Math.abs(v - m) / m <= 0.15); const s2 = near.length ? near : s;
    return s2[Math.floor(s2.length / 2)];
  }

  function drawCell(cell, sym) {
    const cv = cell.querySelector(".mxccanvas"); if (!cv) return;
    let W = cv.clientWidth, H = cv.clientHeight;
    W = Math.max(60, W); H = Math.max(40, H);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const x = cv.getContext("2d"); x.clearRect(0, 0, W, H);
    const padR = 58, padL = 2, now = nowS(), cw = winOf(sym), tMin = now - cw, tMax = now;
    // ТУМБЛЕРЫ — ГЛАВНЫЕ: рисуем только включённые биржи. Пара-спред монеты — ТОЛЬКО фолбэк (если монеты нет ни на одной включённой).
    const allLines = CFG.ex.filter((id) => { const b = BUF[sym + "::" + id]; return b && b.length; });
    if (!allLines.length) { const cf = CELLFEEDS[sym]; if (cf) for (const e of cf) { const b = BUF[sym + "::" + e]; if (b && b.length && allLines.indexOf(e) < 0) allLines.push(e); } }
    if (!allLines.length) { x.fillStyle = "#5b6573"; x.font = "11px monospace"; x.fillText("сбор данных…", 10, 20); return; }
    // КЛАСТЕР-ФИЛЬТР (единый, с гистерезисом): CEX-линии одной монеты держатся вместе; линия далеко от
    // кластера = токен-тёзка на другой бирже (напр. gate EDGE 0.072 против mexc 0.30) → не рисуем.
    // dex/справедливые (пунктир) не трогаем — у них своя природа/лаг (dex может законно разъехаться на пампе).
    const cexLasts = [];
    for (const id of allLines) { if (id === "dex" || id.endsWith("fair")) continue; const b = BUF[sym + "::" + id]; const v = b[b.length - 1][1]; if (v > 0) cexLasts.push(v); }
    const med = clusterMed(cexLasts);
    const canFilter = cexLasts.length >= 3 && med > 0;                          // <3 CEX-линий — не с чем сравнивать кластер, не режем
    let lines = allLines.filter((id) => {
      if (id === "dex" || id.endsWith("fair")) return true;
      const b = BUF[sym + "::" + id], p = b[b.length - 1][1];
      if (!(p > 0)) return false;
      if (!canFilter) return true;
      const dev = Math.abs(p - med) / med, key = sym + "::" + id, shown = VIS[key] !== false;
      let keep;
      if (dev > CLU_HARD) keep = false;                                         // абсурдно далеко (точно тёзка) — скрыть сразу
      else if (shown) keep = dev <= CLU_OUT;                                    // показана → скрыть, только если ушла > OUT (гистерезис)
      else keep = dev <= CLU_IN;                                               // скрыта → вернуть, только если вошла < IN
      VIS[key] = keep;
      return keep;
    });
    if (!lines.some((id) => id !== "dex" && !id.endsWith("fair"))) lines = allLines;   // подстраховка: не гасим все реальные линии
    // АВТОСКЕЙЛ (робастный): одиночный выброс ВНУТРИ линии не раздувает шкалу (спайк-гард к центру кластера)
    let hi = -Infinity, lo = Infinity; const cap = med > 0 ? med : 0;
    for (const id of lines) { const b = BUF[sym + "::" + id]; const special = (id === "dex" || id.endsWith("fair"));
      for (let i = b.length - 1; i >= 0; i--) { if (b[i][0] < tMin) break; const v = b[i][1];
        if (!(v > 0)) continue;
        if (cap > 0 && !special && Math.abs(v - cap) / cap > CLU_HARD) continue;   // точка-выброс (тёзка/битый тик) не двигает hi/lo
        if (v > hi) hi = v; if (v < lo) lo = v; } }
    if (!(hi > lo)) { const m = hi > 0 ? hi : (cap > 0 ? cap : 1); hi = m * 1.001; lo = m * 0.999; }
    const pad = (hi - lo) * 0.12; hi += pad; lo -= pad;
    // СГЛАЖИВАНИЕ ШКАЛЫ: не телепортируем окно при появлении/уходе линии — плавно подъезжаем к цели.
    // Если цель далеко (реальный сильный ход / смена диапазона >2×) — снап, чтобы не отставать.
    const sc = SCALE[sym];
    if (sc && isFinite(sc.hi) && sc.hi > sc.lo) {
      const curRng = sc.hi - sc.lo, tgtRng = hi - lo;
      const far = hi > sc.hi + curRng || lo < sc.lo - curRng || tgtRng > curRng * 2 || tgtRng < curRng * 0.5;
      if (!far) { hi = sc.hi + (hi - sc.hi) * SCALE_K; lo = sc.lo + (lo - sc.lo) * SCALE_K; }
    }
    SCALE[sym] = { hi, lo };
    const rng = hi - lo || 1, dec = decOf((hi + lo) / 2);
    const yOf = (p) => H - (p - lo) / rng * (H - 6) - 3;
    const priceAt = (y) => lo + (H - 3 - y) / (H - 6) * rng; cell._priceAt = priceAt;   // для линейки (Y→цена)
    const xOf = (t) => padL + Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin))) * (W - padR - padL);
    // сетка + оси: слева цена, справа % (спред от низа)
    x.strokeStyle = "rgba(255,255,255,.05)"; x.lineWidth = 1; x.font = "9px ui-monospace,monospace"; x.textAlign = "left";
    for (let i = 0; i <= 4; i++) { const p = lo + rng * (1 - i / 4), yy = 3 + i / 4 * (H - 6);
      x.strokeStyle = "rgba(255,255,255,.05)"; x.beginPath(); x.moveTo(padL, yy); x.lineTo(W - padR, yy); x.stroke();
      x.fillStyle = "#3a4250"; x.fillText(p.toFixed(dec), padL + 2, yy - 2);
      x.fillStyle = "#5b6573"; x.fillText(((p - lo) / (lo || 1) * 100).toFixed(0) + "%", W - padR + 4, yy + 8); }
    // линии цены — ступеньками, каждая точка = движение по секундам (как у THIEF друга)
    const pills = [];
    x.lineJoin = "round"; x.lineCap = "butt";
    for (const id of lines) { const b = BUF[sym + "::" + id], col = COL[id] || "#8a929c";
      const pts = []; const s0 = idxAtOrAfter(b, tMin);                  // пропуск к началу окна (не перебирать всю историю → без лагов)
      let lastV = s0 > 0 ? b[s0 - 1][1] : null, firstV = null;
      const total = b.length - s0, maxPts = Math.max(64, (W - padR - padL) * 3) | 0;
      const stride = total > maxPts ? Math.ceil(total / maxPts) : 1;    // >3 точек на пиксель не видны (субпиксельные ступеньки) → прореживаем шаг только на очень широких окнах (24ч посекундно). Обычные окна: stride=1
      for (let i = s0; i < b.length; i += stride) { if (firstV == null) firstV = b[i][1]; pts.push([xOf(b[i][0]), yOf(b[i][1])]); }
      if (stride > 1 && (b.length - 1 - s0) % stride !== 0 && b.length) { const li = b.length - 1; pts.push([xOf(b[li][0]), yOf(b[li][1])]); }   // последняя (актуальная) точка — всегда
      let anchorV = (lastV != null) ? lastV : firstV;                    // есть реальная точка старше окна → тянем её плоско к левому краю (непрерывно, как THIEF)
      if (id === "dex" && lastV == null) anchorV = null;                  // DEX без сид-истории: НЕ рисуем фейковую плоскую полку во всю ширину — начинаем с первой реальной точки
      if (anchorV != null && pts.length) pts.unshift([xOf(tMin), yOf(anchorV)]);
      const lastPt = b[b.length - 1]; if (lastPt) pills.push({ y: yOf(lastPt[1]), v: lastPt[1], col });
      if (!pts.length) continue;
      const isFair = id.endsWith("fair");
      x.strokeStyle = col; x.lineWidth = isFair ? Math.max(0.5, CFG.lw * 0.7) : CFG.lw;
      if (isFair) x.setLineDash([4, 3]); else x.setLineDash([]);           // ЛЮБАЯ справедливая — пунктир цвета своей биржи
      x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) { x.lineTo(pts[i][0], pts[i - 1][1]); x.lineTo(pts[i][0], pts[i][1]); }   // СТУПЕНЬКА: цена держится и прыгает на новом тике (как у THIEF друга)
      x.stroke(); }
    x.setLineDash([]);
    pills.sort((a, b) => a.y - b.y); const ph = 13; for (let i = 1; i < pills.length; i++) if (pills[i].y - pills[i - 1].y < ph) pills[i].y = pills[i - 1].y + ph;
    x.font = "10px ui-monospace,monospace";
    for (const pl of pills) { const yy = Math.max(7, Math.min(H - 5, pl.y)); x.fillStyle = pl.col; roundRect(x, W - padR + 1, yy - 6, padR - 3, 12, 3); x.fill(); x.fillStyle = "#0b0e12"; x.fillText(pl.v.toFixed(dec), W - padR + 4, yy + 3); }
    // header + footer
    const m = META[sym] || {};
    const prim = lines.find((e) => !e.endsWith("fair")) || lines[0];
    // спред в шапке = по РЕАЛЬНО НАРИСОВАННЫМ линиям (без справедливых), чтобы цифра совпадала с графиком, а не считалась по застывшим/невидимым фидам
    let gmn = Infinity, gmx = -Infinity;
    for (const id of lines) { if (id.endsWith("fair")) continue; const b = BUF[sym + "::" + id]; if (!b || !b.length) continue; const v = b[b.length - 1][1]; if (v > 0) { if (v < gmn) gmn = v; if (v > gmx) gmx = v; } }
    const vgap = (gmn > 0 && gmx > gmn) ? (gmx - gmn) / gmn * 100 : 0;
    const gapEl = cell.querySelector(".mxcgap"); if (gapEl) gapEl.textContent = vgap.toFixed(2) + "%";   // спред — жёлтой цифрой (наша палитра)
    const ca = cell.querySelector(".mxca"); if (ca) ca.classList.toggle("on", !!(m.dex));
    // подвал (THIEF): слева — на каких биржах есть монета; справа — D (актив/мин) · L (ликвидн.) · окно
    const foot = cell.querySelector(".mxcfoot"); if (foot) {
      let turn = 0; for (const id of lines) if (m[id] && m[id].turn) turn = Math.max(turn, m[id].turn);
      const wb = whereBadges(sym, 12);                                     // на каких биржах монета есть (клик = страница монеты)
      const badges = wb || lines.filter((id) => !id.endsWith("fair") && id !== "dex").map((id) => '<span class="mxbadge" style="--exc:' + (COL[id] || "#8a929c") + '">' + (LBL[id] || id) + '</span>').join("");
      const winLbl = (WINS.find((w) => w[0] === cw) || [0, cw + "с"])[1];   // окно ЭТОЙ ячейки
      foot.innerHTML = badges + '<span class="mxsp"></span>' +
        '<span class="mxfd" title="изменений цены в минуту (активность)">D:' + activity(sym, prim) + '</span>' +
        '<span class="mxfl" title="L: сколько $ можно зайти на MEXC до сдвига цены на 0.5% (глубина стакана)">L:' + fmtUsd(LIQ[sym] != null ? LIQ[sym] : turn) + '</span>' +
        '<span class="mxftf" title="окно графика (колесо мыши / кнопки внизу)">' + winLbl + '</span>';
    }
    // ── ЛИНЕЙКА: измерение спреда между двумя ценами (Shift-тяни или средняя кнопка) ──
    const r = cell._ruler;
    if (r && priceAt) {
      const y0 = Math.max(3, Math.min(H - 3, r.y0)), y1 = Math.max(3, Math.min(H - 3, r.y1));
      const p0 = priceAt(y0), p1 = priceAt(y1), loP = Math.min(p0, p1), hiP = Math.max(p0, p1);
      const spr = loP > 0 ? (hiP - loP) / loP * 100 : 0;
      const RC = "#5c9c6e", vx = r.x1 || W - padR - 30;                 // приглушённо-зелёная сплошная линейка
      x.strokeStyle = RC; x.setLineDash([]); x.lineWidth = 1;
      x.beginPath(); x.moveTo(0, y0); x.lineTo(W - padR, y0); x.moveTo(0, y1); x.lineTo(W - padR, y1); x.moveTo(vx, y0); x.lineTo(vx, y1); x.stroke();
      const my = (y0 + y1) / 2, txt = spr.toFixed(2) + "%";
      x.font = "700 12px ui-monospace,monospace"; const tw = x.measureText(txt).width;
      x.fillStyle = RC; roundRect(x, vx - tw - 12, my - 8, tw + 10, 16, 4); x.fill();
      x.fillStyle = "#0b0e12"; x.textAlign = "left"; x.fillText(txt, vx - tw - 7, my + 4);
    }
    // ── ПЕРЕКРЕСТИЕ (едва заметное) + время снизу, цена справа — следует за мышью ──
    const cx = cell._cross;
    if (cx && !r) {
      const gx = Math.max(padL, Math.min(W - padR, cx.x)), gy = Math.max(3, Math.min(H - 3, cx.y));
      x.strokeStyle = "rgba(255,255,255,.16)"; x.setLineDash([3, 3]); x.lineWidth = 1;
      x.beginPath(); x.moveTo(gx, 3); x.lineTo(gx, H - 3); x.moveTo(padL, gy); x.lineTo(W - padR, gy); x.stroke(); x.setLineDash([]);
      const tt = tMin + (gx - padL) / (W - padR - padL || 1) * (tMax - tMin);   // x → время
      const tl = hhmmss(tt * 1000); x.font = "700 10px ui-monospace,monospace";
      const tw2 = x.measureText(tl).width; let bx = Math.max(padL, Math.min(W - padR - tw2 - 8, gx - (tw2 + 8) / 2));
      x.fillStyle = "rgba(20,24,30,.92)"; roundRect(x, bx, H - 15, tw2 + 8, 13, 3); x.fill();
      x.fillStyle = "#c9cdd4"; x.textAlign = "left"; x.fillText(tl, bx + 4, H - 5);
      const pv = priceAt(gy);                                                   // y → цена (пилюля справа)
      x.fillStyle = "rgba(20,24,30,.92)"; roundRect(x, W - padR + 1, gy - 7, padR - 3, 14, 3); x.fill();
      x.fillStyle = "#e6eaef"; x.fillText(pv.toFixed(dec), W - padR + 4, gy + 3);
    }
  }
  function activity(sym, ex) { const b = BUF[sym + "::" + ex]; if (!b || b.length < 2) return 0;
    const c = nowS() - 60; let n = 0; for (let i = 1; i < b.length; i++) if (b[i][0] >= c && b[i][1] !== b[i - 1][1]) n++; return n; }
  function roundRect(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }

  // ── список монет + КАСТОМНЫЙ поиск-дропдаун в ячейке ──
  let _symsAt = 0;
  async function loadSyms(force) {                                     // список монет для поиска — освежаем (свежие листинги MEXC появляются)
    const t = Date.now(); if (!force && SYMS.length && t - _symsAt < 120000) return;
    try { const r = await fetch("/api/mxsyms").then((x) => x.json()); if (r && r.ok && r.syms) { SYMS = r.syms; _symsAt = t; } } catch (e) {} }
  let SPOP = null, SIDX = -1;
  function ensureSPop() { if (SPOP) return SPOP;
    const p = document.createElement("div"); p.className = "mxsearchpop"; p.style.display = "none";
    p.innerHTML = '<input class="mxsi" placeholder="монета (GWEI)…" autocomplete="off"><div class="mxsolist"></div>';
    document.body.appendChild(p); SPOP = p;
    const inp = p.querySelector(".mxsi");
    inp.addEventListener("input", () => renderSearch(inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = inp.value.trim(); if (v) setCardCoin(SIDX, v); closeSearch(); } else if (e.key === "Escape") closeSearch(); });
    document.addEventListener("mousedown", (e) => { if (SPOP && SPOP.style.display !== "none" && !SPOP.contains(e.target) && !(e.target && e.target.classList && e.target.classList.contains("mxcedit"))) closeSearch(); }, true);
    return p; }
  function closeSearch() { if (SPOP) SPOP.style.display = "none"; SIDX = -1; }
  function renderSearch(q) { const p = SPOP; if (!p) return; const box = p.querySelector(".mxsolist"); if (!box) return;
    q = (q || "").trim().toUpperCase();
    let list = q ? SYMS.filter((s) => s.indexOf(q) >= 0).sort((a, b) => a.indexOf(q) - b.indexOf(q) || a.length - b.length) : SYMS;
    list = list.slice(0, 80);
    box.innerHTML = list.length ? list.map((s) => '<div class="mxso" data-s="' + s + '">' + s + '</div>').join("") : '<div class="mxso-empty">ничего не найдено</div>';
    box.querySelectorAll(".mxso").forEach((el) => { el.onmousedown = (e) => { e.preventDefault(); setCardCoin(SIDX, el.dataset.s); closeSearch(); }; });
  }
  function openSearchAt(anchor, idx) { const p = ensureSPop(); SIDX = idx;
    const inp = p.querySelector(".mxsi"); if (inp) inp.value = ""; renderSearch("");
    loadSyms().then(() => { if (SPOP && SPOP.style.display !== "none") renderSearch(inp ? inp.value : ""); });   // дозагрузили свежий список → перерисовать дропдаун
    const r = anchor.getBoundingClientRect(); p.style.left = Math.min(innerWidth - 236, Math.max(6, r.right - 228)) + "px"; p.style.top = (r.bottom + 4) + "px"; p.style.display = "block";
    if (inp) setTimeout(() => inp.focus(), 0); }

  // ── скринер СДЕЛОК (активность): топ монет MEXC по числу сделок, клик → график в ячейке ──
  let DPOP = null, DPOP_TIMER = null;
  function ensureDPop() { if (DPOP) return DPOP;
    const p = document.createElement("div"); p.className = "mxdealspop"; p.style.display = "none";
    p.innerHTML = '<div class="mxdph">🔥 Активные <span class="mxdpu">сделок/мин · клик → график</span><span class="mxdpx" title="закрыть">✕</span></div><div class="mxdplist"></div>';
    document.body.appendChild(p); DPOP = p;
    p.querySelector(".mxdpx").onclick = closeDeals;
    const hd = p.querySelector(".mxdph");                                   // перетаскивание окошка за заголовок
    if (hd) { hd.style.cursor = "move"; let dx = 0, dy = 0, drag = false;
      hd.addEventListener("mousedown", (e) => { if (e.target.classList.contains("mxdpx")) return; drag = true; const r = p.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; e.preventDefault(); e.stopPropagation(); });
      document.addEventListener("mousemove", (e) => { if (!drag) return; p.style.left = Math.max(0, Math.min(innerWidth - 60, e.clientX - dx)) + "px"; p.style.top = Math.max(0, Math.min(innerHeight - 24, e.clientY - dy)) + "px"; });
      document.addEventListener("mouseup", () => { drag = false; }); }
    // закрывать ТОЛЬКО при клике ВНЕ панели THIEF SQUAD (по крестику — отдельно). Клик по графику/ячейкам внутри панели — окошко ВИСИТ.
    document.addEventListener("mousedown", (e) => {
      if (!DPOP || DPOP.style.display === "none") return;
      if (DPOP.contains(e.target) || e.target === g("mxdeals")) return;     // сам попап / кнопка-переключатель
      const w = win(); if (w && w.contains(e.target)) return;               // клик ВНУТРИ THIEF SQUAD (график, ячейки, бар) — не закрывать
      closeDeals();                                                         // клик совсем вне панели → закрыть
    }, true);
    return p; }
  function closeDeals() { if (DPOP) DPOP.style.display = "none"; if (DPOP_TIMER) { clearInterval(DPOP_TIMER); DPOP_TIMER = null; } }
  function renderDeals(rows) { const p = DPOP; if (!p) return; const box = p.querySelector(".mxdplist"); if (!box) return;
    if (!rows || !rows.length) { box.innerHTML = '<div class="mxso-empty">Считаю сделки по ~1000 монет MEXC…<br>наполнится за ~30 секунд — НЕ закрывай окошко</div>'; return; }
    const byDeals = (rows[0].tr || 0) > 0;                              // есть сделки → по сделкам; иначе фолбэк по обороту (не пусто)
    const val = (r) => byDeals ? (r.tr || 0) : (r.turn || 0), mx = val(rows[0]) || 1;
    const hint = p.querySelector(".mxdpu"); if (hint) hint.innerHTML = byDeals ? "сделок/мин · клик → график" : "по обороту $ (сделки копятся…) · клик → график";
    box.innerHTML = rows.map((r) => { const base = (r.s || "").replace("_USDT", ""); const w = Math.max(3, Math.round(100 * val(r) / mx));
      const num = byDeals ? (r.tr || 0) : fmtUsd(r.turn || 0);
      return '<div class="mxdrow" data-s="' + r.s + '"><span class="mxdbar" style="width:' + w + '%"></span><b class="mxdsym">' + base + '</b><span class="mxdtr">' + num + '</span></div>'; }).join("");
    box.querySelectorAll(".mxdrow").forEach((el) => { el.onclick = () => openInCell(el.dataset.s); });
  }
  async function loadDeals() { const p = DPOP; if (!p || p.style.display === "none") return;
    // ТОТ ЖЕ источник, что рабочий основной Скринер: поле trades считается по-настоящему (_deal_metrics).
    // ex=ourbit,mexc — ourbit-путь есть на ЛЮБОЙ версии сервера и всегда тёплый (наполнится без рестарта),
    // mexc добавляет свои эксклюзивы/сток-токены где доступно. Union по монетам, дедуп на сервере.
    try { const r = await fetch("/api/screener?win=1&n=200&ex=ourbit,mexc").then((x) => x.json());
      if (!r || !r.ok) return;
      const rows = (r.rows || []).filter((x) => (x.trades || 0) > 0)
        .sort((a, b) => (b.trades || 0) - (a.trades || 0))
        .slice(0, 60).map((x) => ({ s: x.symbol, tr: x.trades }));
      renderDeals(rows); } catch (e) {}
  }
  function openDeals(anchor) { const p = ensureDPop();
    if (p.style.display !== "none") { closeDeals(); return; }              // повторный клик = закрыть
    p.style.display = "block"; renderDeals([]); loadDeals();
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.min(innerWidth - 258, Math.max(6, r.left)) + "px";
    p.style.top = Math.max(44, r.top - 388) + "px";                       // кнопка внизу панели → раскрываем ВВЕРХ
    if (DPOP_TIMER) clearInterval(DPOP_TIMER); DPOP_TIMER = setInterval(loadDeals, 4000);   // обновление раз в 4с (не каждый тик)
  }

  // ── окно ──
  // подготовить контент панели (наполнить сетку/панели) — вызывается и при загрузке, и при открытии
  function ensure() {
    const stv = g("mxstat"); if (stv) { stv.textContent = "v246"; stv.style.color = "#6b7280"; }
    try {
      if (!CFG.cards || !CFG.cards.length) { CFG.cards = DEF.cards.slice(); save(); }
      renderBar(); renderZoom(); renderGrid(); loadSyms();
      const sb = g("mxsound"); if (sb) sb.classList.toggle("on", CFG.sound);
      const th = g("mxthresh"); if (th) th.value = CFG.thresh;
      const mt = g("mxtrades"); if (mt) mt.value = String(CFG.mxtrades || 500);
    } catch (e) { if (stv) { stv.textContent = "v246 ОШИБКА: " + (e && e.message || e); stv.style.color = "#ef5f5a"; } }
  }
  function open() {
    const w = win(); if (!w) return;
    const wasTiled = w.classList.contains("tiled");
    w.classList.remove("hidden", "tiled", "collapsed"); if (w.parentElement !== document.body) document.body.appendChild(w); w.style.zIndex = 46;
    const r = w.getBoundingClientRect();
    if (wasTiled || r.width < 200 || r.right < 60 || r.left > innerWidth - 60 || r.top > innerHeight - 40) { w.style.left = "40px"; w.style.right = "auto"; w.style.top = "60px"; w.style.width = "1100px"; w.style.height = "660px"; }
    else if (r.left < -30 || r.top < 0) { w.style.left = Math.max(6, r.left) + "px"; w.style.top = Math.max(44, r.top) + "px"; if (r.left < -30) w.style.left = "6px"; }   // окно уползло за край экрана (бар/лента «пропали») → вернуть в экран, размер не трогаем
    firstScan = true; ensure(); poll();
    if (timer) clearInterval(timer); timer = setInterval(poll, POLL_MS);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function close() { const w = win(); if (w) w.classList.add("hidden"); if (timer) { clearInterval(timer); timer = null; } if (raf) { cancelAnimationFrame(raf); raf = null; } closeDeals(); }

  function init() {
    const w = win(); if (!w) return;
    if (window.Dock) window.Dock.makeWindow({ win: w, handle: g("mxdrag"), titleBar: g("mxdrag"), resize: g("mxres"), key: "mxdex", minW: 560, minH: 340 });
    const btn = g("mxbtn"); if (btn) btn.onclick = () => { const vis = !w.classList.contains("hidden") && !w.classList.contains("tiled"); vis ? close() : open(); };
    const xc = g("mxclose"); if (xc) xc.onclick = close;
    const add = g("mxadd"); if (add) add.addEventListener("keydown", (e) => { if (e.key === "Enter") { pin(add.value); add.value = ""; } });
    const addb = g("mxaddb"); if (addb) addb.onclick = () => { const a = g("mxadd"); if (a) { pin(a.value); a.value = ""; } };
    const sb = g("mxsound"); if (sb) sb.onclick = () => { CFG.sound = !CFG.sound; save(); sb.classList.toggle("on", CFG.sound); if (CFG.sound) chime(false); };
    const th = g("mxthresh"); if (th) { th.value = CFG.thresh; th.onchange = () => { const v = parseFloat(th.value); if (v > 0) { CFG.thresh = v; save(); } }; }
    const mt = g("mxtrades"); if (mt) { mt.value = String(CFG.mxtrades || 500); mt.onchange = () => { const v = parseInt(mt.value, 10); if (v > 0) { CFG.mxtrades = v; save(); for (const k in SEEDSIG) if (k.indexOf("::") > 0 && TRADES_EX.indexOf(k.split("::")[1]) >= 0) delete SEEDSIG[k]; } }; }   // сброс сигнатур сделок-линий → следующий сид перетянет на новую глубину
    const dl = g("mxdeals"); if (dl) dl.onclick = () => openDeals(dl);
    const ac = g("mxaddcard"); if (ac) ac.onclick = () => { CFG.cards.push(""); save(); renderGrid(); };
    const gr = g("mxgear"); if (gr) gr.onclick = openSettings;
    const gridEl = g("mxgrid");                                        // футер ячейки переписывается каждый кадр → клики по квадратикам бирж ловим ДЕЛЕГАТОМ
    if (gridEl) gridEl.addEventListener("click", (e) => { const wb = e.target && e.target.closest && e.target.closest(".mxwb");
      if (wb && wb.dataset.url) { e.stopPropagation(); window.open(wb.dataset.url, "_blank"); } });
    const gx = g("mxset-x"); if (gx) gx.onclick = closeSettings;
    // НАДЁЖНЫЙ делегат: клик по крестику настроек ловим на уровне документа (мимо любых локальных перехватчиков)
    document.addEventListener("mousedown", (e) => {
      const t = e.target; if (!t) return;
      if (t.id === "mxset-x" || (t.closest && t.closest("#mxset-x"))) { e.preventDefault(); e.stopPropagation(); closeSettings(); }
    }, true);
    ensure();                                          // наполнить панель сразу (не ждать открытия) + впечатать версию
    if (!timer) timer = setInterval(poll, POLL_MS);    // опрос идёт всегда (poll сам молчит, если окно скрыто)
    if (!raf) raf = requestAnimationFrame(frame);      // рендер-цикл (frame сам молчит, если окно скрыто)
  }
  window.MXDex = { open, close };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
