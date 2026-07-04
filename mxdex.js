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
  const LS = "mxdex.cfg.v3";
  const POLL_MS = 1000;                               // как часто тянем свежие цены
  const THRESH = [2.5, 5, 8, 10, 15, 20, 30, 50];     // пороги спред-колла, %
  const WINS = [[30, "30с"], [60, "1м"], [120, "2м"], [300, "5м"], [600, "10м"], [1800, "30м"]];

  const SRC = [
    { lbl: "MEXC", c: "#3ac6e6", f: "mexc" },
    { lbl: "BINANCE", c: "#f0b90b", f: "binance", s: "binancespot" },
    { lbl: "BYBIT", c: "#f7a600", f: "bybit" },
    { lbl: "GATE", c: "#e6446e", f: "gate" },
    { lbl: "BITGET", c: "#00e0c6", f: "bitget" },
    { lbl: "BINGX", c: "#2a5bd7", f: "bingx" },
    { lbl: "OKX", c: "#c9cdd4", f: "okx" },
    { lbl: "OURBIT", c: "#16c784", f: "ourbit" },
    { lbl: "ASTER", c: "#9d7bff", f: "asterdex" },
    { lbl: "LIGHTER", c: "#b8c0cc", f: "lighter" },
    { lbl: "HL", c: "#4be3c0", f: "hyperliquid" },
  ];
  const SPECIAL = [
    { lbl: "FAIR·MEXC", c: "#e6c84a", id: "mexcfair", title: "справедливая цена MEXC (fairPrice)" },
    { lbl: "DEX·CA", c: "#e259c6", id: "dex", title: "on-chain цена по контракту (Dexscreener)" },
  ];
  const COL = { mexc: "#3ac6e6", binance: "#f0b90b", binancespot: "#f0d24b", bybit: "#f7a600",
    gate: "#e6446e", bitget: "#00e0c6", bingx: "#2a5bd7", okx: "#c9cdd4", ourbit: "#16c784",
    asterdex: "#9d7bff", lighter: "#b8c0cc", hyperliquid: "#4be3c0", mexcfair: "#e6c84a", dex: "#e259c6" };
  const LBL = { mexc: "MEXC", binance: "BINANCE·F", binancespot: "BINANCE·S", bybit: "BYBIT",
    gate: "GATE", bitget: "BITGET", bingx: "BINGX", okx: "OKX", ourbit: "OURBIT",
    asterdex: "ASTER", lighter: "LIGHTER", hyperliquid: "HL", mexcfair: "FAIR", dex: "DEX·CA" };

  const DEF = { ex: ["mexc", "binance", "bybit", "asterdex", "mexcfair"], sound: true,
    cards: ["VANRY_USDT", "GWEI_USDT", "OPENAI_USDT", "ANTHROPIC_USDT"],
    windowSec: 120, thresh: 2.5, pinned: [], minturn: 20000, maxgap: 600,
    cols: 3, cellH: 210, lw: 1.7, feedW: 198 };

  let CFG = load();
  const BUF = {};                    // "sym::ex" -> [[t,price]] клиентский буфер (плавная живая линия)
  let FEED = [];                     // спред-коллы (новейшие первыми)
  const SEEN = {};                   // sym -> последний пробитый порог
  const PINDATA = {};                // sym -> {gap,rise}
  let META = {};                     // sym -> {ex:{last,turn,rise}} свежие цены
  let timer = null, raf = null, firstScan = true;
  const win = () => g("mxwin");

  function load() { try { const j = JSON.parse(localStorage.getItem(LS)); if (j) return Object.assign({}, DEF, j, { ex: j.ex || DEF.ex, cards: j.cards || DEF.cards, pinned: j.pinned || [] }); } catch (e) {} return JSON.parse(JSON.stringify(DEF)); }
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
      const t0 = AC.currentTime, notes = strong ? [783.99, 1046.5, 1567.98] : [659.25, 987.77];
      notes.forEach((f, i) => { const o = AC.createOscillator(), gg = AC.createGain();
        o.type = "sine"; o.frequency.value = f; o.connect(gg); gg.connect(AC.destination);
        const t = t0 + i * 0.10; gg.gain.setValueAtTime(0.0001, t);
        gg.gain.exponentialRampToValueAtTime(0.15, t + 0.02); gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        o.start(t); o.stop(t + 0.47); });
    } catch (e) {}
  }

  // ── верхняя панель бирж (S/F) + FAIR + DEX ──
  function renderBar() {
    const bar = g("mxbar"); if (!bar) return;
    let h = SRC.map((sr) => {
      const letter = (kind, id) => id
        ? '<span class="mxsf' + (has(id) ? " on" : "") + '" data-id="' + id + '" style="--exc:' + sr.c + '" title="' + (kind === "S" ? "спот" : "фьюч") + '">' + kind + '</span>'
        : '<span class="mxsf dis" title="фид не подключён">' + kind + '</span>';
      return '<span class="mxsrc"><span class="mxsrclbl" style="--exc:' + sr.c + '">' + sr.lbl + '</span>' + letter("S", sr.s) + letter("F", sr.f) + '</span>';
    }).join("");
    h += SPECIAL.map((sp) => '<span class="mxsrc"><span class="mxsf' + (has(sp.id) ? " on" : "") + '" data-id="' + sp.id + '" style="--exc:' + sp.c + ';border-left:0;padding:0 9px" title="' + sp.title + '">' + sp.lbl + '</span></span>').join("");
    bar.innerHTML = h;
    bar.querySelectorAll(".mxsf[data-id]").forEach((el) => { el.onclick = () => { toggle(el.dataset.id); renderBar(); }; });
  }

  // ── нижняя панель: зум окна ──
  function renderZoom() {
    const z = g("mxzoom"); if (!z) return;
    z.innerHTML = WINS.map((w) => '<button class="mxzb' + (CFG.windowSec === w[0] ? " on" : "") + '" data-w="' + w[0] + '">' + w[1] + '</button>').join("");
    z.querySelectorAll(".mxzb").forEach((b) => { b.onclick = () => { CFG.windowSec = +b.dataset.w; save(); renderZoom(); }; });
  }

  // ── попап настроек сетки ──
  function setTxt(id, v) { const e = g(id); if (e) e.textContent = v; }
  function buildCols() { const c = g("mxcols"); if (!c) return;
    c.innerHTML = [1, 2, 3, 4, 5, 6].map((n) => '<button class="' + (CFG.cols === n ? "on" : "") + '" data-c="' + n + '">' + n + '</button>').join("");
    c.querySelectorAll("button").forEach((b) => { b.onclick = () => { CFG.cols = +b.dataset.c; save(); buildCols(); applyGrid(); }; }); }
  function closeSettings() { const s = g("mxset"); if (s) s.classList.add("hidden"); document.removeEventListener("mousedown", onDocDown); document.removeEventListener("keydown", onSetKey); }
  function onDocDown(e) { const s = g("mxset"); if (!s || s.classList.contains("hidden")) return; if (s.contains(e.target) || (e.target && e.target.id === "mxgear")) return; closeSettings(); }
  function onSetKey(e) { if (e.key === "Escape") closeSettings(); }
  function openSettings() {
    const s = g("mxset"); if (!s) return;
    if (!s.classList.contains("hidden")) { closeSettings(); return; }     // повторный клик по ⚙ — закрыть
    const st = g("mxstat");
    try {
      s.classList.remove("hidden");
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

  // ── лента спред-коллов ──
  function pushAlert(sym, gap, rise, bucket) {
    FEED.unshift({ sym, gap, rise, bucket, t: Date.now() }); if (FEED.length > 80) FEED.length = 80;
    chime(bucket >= 15);
    try { if (typeof notify === "function") notify("Спред " + sym.replace("_USDT", "") + " Δ" + gap.toFixed(1) + "%", bucket >= 15 ? "warn" : "info"); } catch (e) {}
  }
  function processRows(rows) {
    for (const r of rows) { const b = bucketOf(r.gap);
      if (b >= CFG.thresh) { const prev = SEEN[r.symbol] || 0; if (b > prev) { if (!firstScan) pushAlert(r.symbol, r.gap, r.rise, b); SEEN[r.symbol] = b; } }
      else SEEN[r.symbol] = 0;
    }
    firstScan = false;
  }
  function gapClass(b) { return b >= 50 ? "g50" : b >= 30 ? "g30" : b >= 20 ? "g20" : b >= 15 ? "g15" : b >= 10 ? "g10" : b >= 8 ? "g8" : b >= 5 ? "g5" : ""; }
  function feedRow(sym, gap, rise, tstr, pinned, ex) {
    const base = sym.replace("_USDT", ""), b = bucketOf(gap), col = COL[(ex && ex[0]) || "mexc"] || "#8a929c";
    return '<div class="mxrow" data-sym="' + sym + '" style="--bar:' + col + '"><div class="mxrbar"></div>' +
      '<div class="mxrmid"><span class="mxrsym">' + (pinned ? "📌 " : "") + base + '</span><span class="mxrtime">' + tstr + '</span></div>' +
      '<div class="mxrright"><span class="mxrchg ' + (rise >= 0 ? "up" : "down") + '">' + (rise >= 0 ? "+" : "") + (rise || 0).toFixed(2) + '%</span>' +
      '<span class="mxrgap ' + gapClass(b) + '">Δ' + (gap || 0).toFixed(gap >= 10 ? 0 : 1) + '%</span></div>' +
      (pinned ? '<span class="mxrpin" data-unpin="' + sym + '" title="открепить">✕</span>' : '') + '</div>';
  }
  function renderFeed(bySym) {
    const feed = g("mxfeed"); if (!feed) return; let html = "";
    for (const sym of CFG.pinned) { const d = PINDATA[sym] || {}; const r = bySym[sym]; html += feedRow(sym, d.gap || 0, d.rise || 0, "закреплено", true, r && r.ex); }
    for (const f of FEED) { if (CFG.pinned.indexOf(f.sym) >= 0) continue; html += feedRow(f.sym, f.gap, f.rise, hhmmss(f.t), false, (bySym[f.sym] || {}).ex); }
    if (!html) { feed.innerHTML = '<div class="mxfhint">Здесь появятся монеты, когда цена между биржами разъедется (порог ниже ↓).</div>'; return; }
    feed.innerHTML = html;
    feed.querySelectorAll(".mxrpin").forEach((el) => { el.onclick = (e) => { e.stopPropagation(); unpin(el.dataset.unpin); }; });
    feed.querySelectorAll(".mxrow").forEach((el) => { el.onclick = () => setCardCoin(0, el.dataset.sym); });
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
        cell.innerHTML = '<div class="mxempty">выбери монету<input class="mxcsearch" list="mxsymlist" placeholder="напр. GWEI"></div>';
      } else {
        cell.innerHTML = '<div class="mxchead"><span class="mxcsym" title="клик — открыть стакан (Ourbit / WEEX / MEXC)">📖 ' + sym.replace("_USDT", "") + '</span>' +
          '<span class="mxca hidden">CA</span><span class="mxchg"></span><span class="mxsp"></span><b class="mxcgap"></b>' +
          '<input class="mxcsearch" list="mxsymlist" placeholder="поиск"><button class="mxcx" title="убрать ячейку">×</button></div>' +
          '<canvas class="mxccanvas"></canvas><div class="mxcfoot"></div>';
      }
      grid.appendChild(cell);
      const inp = cell.querySelector(".mxcsearch");
      if (inp) { const commit = () => { const v = inp.value; if (v) { setCardCoin(idx, v); } };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
        inp.addEventListener("change", commit); }
      const sy = cell.querySelector(".mxcsym"); if (sy) sy.onclick = () => openBookMenu(sym, sy);
      const cx = cell.querySelector(".mxcx"); if (cx) cx.onclick = () => { CFG.cards.splice(idx, 1); save(); renderGrid(); };
      const cv = cell.querySelector(".mxccanvas"); if (cv) cv.addEventListener("wheel", (e) => { e.preventDefault();
        const cur = CFG.windowSec; CFG.windowSec = Math.max(15, Math.min(3600, Math.round(cur * (e.deltaY < 0 ? 0.8 : 1.25)))); save(); renderZoom(); }, { passive: false });
    });
  }
  function setCardCoin(idx, raw) { const sym = normSym(raw); if (!sym) return;
    if (idx >= CFG.cards.length) CFG.cards.push(sym); else CFG.cards[idx] = sym;
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
    const exs = [["ourbit", "🐸 Ourbit"], ["weex", "🟠 WEEX"], ["mexc", "🔵 MEXC"]];
    m.innerHTML = '<div class="mxbmh">' + sym.replace("_USDT", "") + ' — открыть стакан</div>' + exs.map((e) => '<button data-ex="' + e[0] + '">' + e[1] + '</button>').join("");
    document.body.appendChild(m); const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(innerWidth - 170, Math.max(6, r.left)) + "px"; m.style.top = (r.bottom + 4) + "px";
    m.querySelectorAll("button").forEach((b) => { b.onclick = () => { openBook(sym, b.dataset.ex); closeBookMenu(); }; });
    BOOKMENU = m; setTimeout(() => document.addEventListener("mousedown", bookOut, true), 0);
  }

  function pin(raw) { const sym = normSym(raw); if (!sym) return; if (CFG.pinned.indexOf(sym) < 0) CFG.pinned.push(sym); save(); poll(); }
  function unpin(sym) { const i = CFG.pinned.indexOf(sym); if (i >= 0) CFG.pinned.splice(i, 1); delete PINDATA[sym]; save(); renderFeed({}); }

  // ── буфер живых цен ──
  const feedsActive = () => CFG.ex;
  function latestOf(rec, id) { if (rec.m && rec.m[id] && rec.m[id].last) return rec.m[id].last; if (rec.s && rec.s[id] && rec.s[id].length) return rec.s[id][rec.s[id].length - 1][1]; return null; }
  function ingest(sym, rec) {
    const now = nowS();
    for (const id of feedsActive()) {
      const key = sym + "::" + id; let buf = BUF[key] || (BUF[key] = []);
      if (buf.length === 0 && rec.s && rec.s[id]) for (const p of rec.s[id]) buf.push([p[0], p[1]]);   // разовый бэкафилл истории
      const v = latestOf(rec, id);
      if (v) { const lp = buf[buf.length - 1]; if (!lp || now - lp[0] >= 0.8) buf.push([now, v]); else lp[1] = v; }
      const cutoff = now - 2000; while (buf.length && buf[0][0] < cutoff) buf.shift();
      if (buf.length > 3000) buf.splice(0, buf.length - 3000);
    }
  }
  function spreadNow(sym) { const px = []; let rise = 0, hiT = -1;
    const m = META[sym] || {}; for (const ex in m) { if (ex === "mexcfair" || ex === "dex") continue; const v = m[ex]; if (v && v.last) { px.push(v.last); if (v.turn > hiT) { hiT = v.turn; rise = v.rise; } } }
    if (px.length < 2) return { gap: 0, rise }; const mn = Math.min(...px), mx = Math.max(...px); return { gap: (mx - mn) / mn * 100, rise }; }

  // ── опрос ──
  async function poll() {
    if (!win() || win().classList.contains("hidden")) return;
    const feeds = CFG.ex.filter((e) => e !== "mexcfair" && e !== "dex");
    let bySym = {};
    if (feeds.length >= 2) {
      try { const gr = await fetch("/api/gaptop?n=80&minturn=" + CFG.minturn + "&maxgap=" + CFG.maxgap + "&ex=" + encodeURIComponent(feeds.join(","))).then((x) => x.json());
        if (gr && gr.ok) { for (const r of (gr.rows || [])) bySym[r.symbol] = r; processRows(gr.rows || []);
          const st = g("mxstat2"); if (st) st.textContent = (gr.rows || []).length + " монет · " + FEED.length + " коллов · буфер " + Object.keys(BUF).length + " · порог " + CFG.thresh + "%"; } } catch (e) {}
    }
    const need = []; for (const s of CFG.cards) if (s && need.indexOf(s) < 0) need.push(s); for (const s of CFG.pinned) if (need.indexOf(s) < 0) need.push(s);
    if (need.length) {
      const url = "/api/gridseries?symbols=" + encodeURIComponent(need.join(",")) + "&ex=" + encodeURIComponent(feeds.join(",")) + "&fair=" + (has("mexcfair") ? "1" : "0") + "&dex=" + (has("dex") ? "1" : "0");
      try { const r = await fetch(url).then((x) => x.json());
        if (r && r.ok) { const ser = r.series || {};
          for (const sym in ser) { META[sym] = ser[sym].m || {}; ingest(sym, ser[sym]); }
          for (const sym of CFG.pinned) PINDATA[sym] = spreadNow(sym); } } catch (e) {}
    }
    renderFeed(bySym);
  }

  // ── живой рендер (плавно, каждый кадр) ──
  function frame() { raf = requestAnimationFrame(frame);
    const w = win(); if (!w || w.classList.contains("hidden")) return;
    const grid = g("mxgrid"); if (!grid) return;
    try { for (const cell of grid.children) { const idx = +cell.dataset.idx, sym = CFG.cards[idx]; if (sym) drawCell(cell, sym); } }
    catch (e) { const s = g("mxstat"); if (s) { s.textContent = "v176 РИС.ОШИБКА: " + (e && e.message || e); s.style.color = "#ef5f5a"; } }
  }

  function drawCell(cell, sym) {
    const cv = cell.querySelector(".mxccanvas"); if (!cv) return;
    let W = cv.clientWidth, H = cv.clientHeight;
    W = Math.max(60, W); H = Math.max(40, H);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const x = cv.getContext("2d"); x.clearRect(0, 0, W, H);
    const padR = 58, padL = 2, now = nowS(), tMin = now - CFG.windowSec, tMax = now;
    const lines = CFG.ex.filter((id) => { const b = BUF[sym + "::" + id]; return b && b.length; });
    if (!lines.length) { x.fillStyle = "#5b6573"; x.font = "11px monospace"; x.fillText("сбор данных…", 10, 20); return; }
    let hi = -Infinity, lo = Infinity;
    for (const id of lines) { const b = BUF[sym + "::" + id]; for (let i = b.length - 1; i >= 0; i--) { if (b[i][0] < tMin) break; if (b[i][1] > hi) hi = b[i][1]; if (b[i][1] < lo) lo = b[i][1]; } }
    if (!(hi > lo)) { const m = hi > 0 ? hi : 1; hi = m * 1.001; lo = m * 0.999; }
    const pad = (hi - lo) * 0.12; hi += pad; lo -= pad; const rng = hi - lo || 1, dec = decOf((hi + lo) / 2);
    const yOf = (p) => H - (p - lo) / rng * (H - 6) - 3;
    const xOf = (t) => padL + Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin))) * (W - padR - padL);
    // сетка + оси: слева цена, справа % (спред от низа)
    x.strokeStyle = "rgba(255,255,255,.05)"; x.lineWidth = 1; x.font = "9px ui-monospace,monospace"; x.textAlign = "left";
    for (let i = 0; i <= 4; i++) { const p = lo + rng * (1 - i / 4), yy = 3 + i / 4 * (H - 6);
      x.strokeStyle = "rgba(255,255,255,.05)"; x.beginPath(); x.moveTo(padL, yy); x.lineTo(W - padR, yy); x.stroke();
      x.fillStyle = "#3a4250"; x.fillText(p.toFixed(dec), padL + 2, yy - 2);
      x.fillStyle = "#5b6573"; x.fillText(((p - lo) / (lo || 1) * 100).toFixed(0) + "%", W - padR + 4, yy + 8); }
    // линии (плавные)
    const pills = [];
    for (const id of lines) { const b = BUF[sym + "::" + id], col = COL[id] || "#8a929c";
      x.strokeStyle = col; x.lineWidth = id === "mexcfair" ? Math.max(1, CFG.lw * 0.75) : CFG.lw; if (id === "mexcfair") x.setLineDash([5, 3]); else x.setLineDash([]);
      x.beginPath(); let started = false, lastV = 0;
      for (let i = 0; i < b.length; i++) { const t = b[i][0]; if (t < tMin) { lastV = b[i][1]; continue; } const px = xOf(t), py = yOf(b[i][1]); if (!started) { if (i > 0) x.moveTo(xOf(tMin), yOf(lastV)); else x.moveTo(px, py); started = true; } x.lineTo(px, py); lastV = b[i][1]; }
      x.stroke(); const lastPt = b[b.length - 1]; if (lastPt) pills.push({ y: yOf(lastPt[1]), v: lastPt[1], col }); }
    x.setLineDash([]);
    pills.sort((a, b) => a.y - b.y); const ph = 13; for (let i = 1; i < pills.length; i++) if (pills[i].y - pills[i - 1].y < ph) pills[i].y = pills[i - 1].y + ph;
    x.font = "10px ui-monospace,monospace";
    for (const pl of pills) { const yy = Math.max(7, Math.min(H - 5, pl.y)); x.fillStyle = pl.col; roundRect(x, W - padR + 1, yy - 6, padR - 3, 12, 3); x.fill(); x.fillStyle = "#0b0e12"; x.fillText(pl.v.toFixed(dec), W - padR + 4, yy + 3); }
    // header + footer
    const m = META[sym] || {}, sp = spreadNow(sym);
    const prim = lines.find((e) => e !== "mexcfair") || lines[0], b0 = BUF[sym + "::" + prim];
    const chgEl = cell.querySelector(".mxchg"); if (chgEl && b0 && b0.length > 1) { let base = null; for (const p of b0) if (p[0] >= tMin) { base = p[1]; break; } if (base == null) base = b0[0][1]; const c = (b0[b0.length - 1][1] - base) / base * 100; chgEl.textContent = (c >= 0 ? "+" : "") + c.toFixed(2) + "%"; chgEl.className = "mxchg " + (c >= 0 ? "up" : "down"); }
    const gapEl = cell.querySelector(".mxcgap"); if (gapEl) { gapEl.textContent = "Δ" + sp.gap.toFixed(2) + "%"; gapEl.className = "mxcgap" + (sp.gap >= CFG.thresh ? " hot" : ""); }
    const ca = cell.querySelector(".mxca"); if (ca) ca.classList.toggle("hidden", !(m.dex));
    const foot = cell.querySelector(".mxcfoot"); if (foot) { let turn = 0; for (const id of lines) if (m[id] && m[id].turn) turn = Math.max(turn, m[id].turn);
      foot.innerHTML = lines.map((id) => '<span class="mxbadge" style="--exc:' + (COL[id] || "#8a929c") + '">' + (LBL[id] || id) + '</span>').join("") + '<span class="mxliq">' + fmtUsd(turn) + '</span>'; }
  }
  function roundRect(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }

  // ── датлист монет для поиска ──
  async function loadSyms() { const dl = g("mxsymlist"); if (!dl || dl.childElementCount) return;
    try { const r = await fetch("/api/mxsyms").then((x) => x.json()); if (r && r.ok) dl.innerHTML = (r.syms || []).slice(0, 4000).map((s) => '<option value="' + s + '">').join(""); } catch (e) {} }

  // ── окно ──
  // подготовить контент панели (наполнить сетку/панели) — вызывается и при загрузке, и при открытии
  function ensure() {
    const stv = g("mxstat"); if (stv) { stv.textContent = "v176"; stv.style.color = "#6b7280"; }
    try {
      if (!CFG.cards || !CFG.cards.length) { CFG.cards = DEF.cards.slice(); save(); }
      renderBar(); renderZoom(); renderGrid(); loadSyms();
      const sb = g("mxsound"); if (sb) sb.classList.toggle("on", CFG.sound);
      const th = g("mxthresh"); if (th) th.value = CFG.thresh;
    } catch (e) { if (stv) { stv.textContent = "v176 ОШИБКА: " + (e && e.message || e); stv.style.color = "#ef5f5a"; } }
  }
  function open() {
    const w = win(); if (!w) return;
    const wasTiled = w.classList.contains("tiled");
    w.classList.remove("hidden", "tiled", "collapsed"); if (w.parentElement !== document.body) document.body.appendChild(w); w.style.zIndex = 46;
    const r = w.getBoundingClientRect();
    if (wasTiled || r.width < 200 || r.right < 60 || r.left > innerWidth - 60 || r.top > innerHeight - 40) { w.style.left = "40px"; w.style.right = "auto"; w.style.top = "60px"; w.style.width = "1100px"; w.style.height = "660px"; }
    firstScan = true; ensure(); poll();
    if (timer) clearInterval(timer); timer = setInterval(poll, POLL_MS);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function close() { const w = win(); if (w) w.classList.add("hidden"); if (timer) { clearInterval(timer); timer = null; } if (raf) { cancelAnimationFrame(raf); raf = null; } }

  function init() {
    const w = win(); if (!w) return;
    if (window.Dock) window.Dock.makeWindow({ win: w, handle: g("mxdrag"), titleBar: g("mxdrag"), resize: g("mxres"), key: "mxdex", minW: 560, minH: 340 });
    const btn = g("mxbtn"); if (btn) btn.onclick = () => { const vis = !w.classList.contains("hidden") && !w.classList.contains("tiled"); vis ? close() : open(); };
    const xc = g("mxclose"); if (xc) xc.onclick = close;
    const add = g("mxadd"); if (add) add.addEventListener("keydown", (e) => { if (e.key === "Enter") { pin(add.value); add.value = ""; } });
    const addb = g("mxaddb"); if (addb) addb.onclick = () => { const a = g("mxadd"); if (a) { pin(a.value); a.value = ""; } };
    const sb = g("mxsound"); if (sb) sb.onclick = () => { CFG.sound = !CFG.sound; save(); sb.classList.toggle("on", CFG.sound); if (CFG.sound) chime(false); };
    const th = g("mxthresh"); if (th) th.onchange = () => { const v = parseFloat(th.value); if (v > 0) { CFG.thresh = v; save(); } };
    const ac = g("mxaddcard"); if (ac) ac.onclick = () => { CFG.cards.push(""); save(); renderGrid(); };
    const gr = g("mxgear"); if (gr) gr.onclick = openSettings;
    const gx = g("mxset-x"); if (gx) gx.onclick = closeSettings;
    ensure();                                          // наполнить панель сразу (не ждать открытия) + впечатать версию
    if (!timer) timer = setInterval(poll, POLL_MS);    // опрос идёт всегда (poll сам молчит, если окно скрыто)
    if (!raf) raf = requestAnimationFrame(frame);      // рендер-цикл (frame сам молчит, если окно скрыто)
  }
  window.MXDex = { open, close };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
