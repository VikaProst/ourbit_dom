"use strict";
// tile.js — тайловый воркспейс: рекурсивное дерево сплиттеров (как в MetaScalp).
// Листья хостят реальные панели (график/скринер/лента/вочлист/финрез), между ними —
// перетаскиваемые делители. Дерево строится кнопками (split/close) + выбором панели,
// сохраняется в localStorage. Стакан не трогаем — панели реюзаются как есть.
(function () {
  const $ = (id) => document.getElementById(id);
  const LS = "ws.tree.v1";
  // реестр панелей: id → {win: элемент .wbwin, label, btn: кнопка-открытия (null = всегда видима)}
  const PANELS = {
    book:   { win: "bookwin", label: "Стакан (DOM)", btn: null },
    chart:  { win: "chartwin", label: "График", btn: "chartbtn" },
    screener: { win: "scrwin", label: "Скринер", btn: "scrbtn" },
    tape:   { win: "tapewin", label: "Лента", btn: "tapebtn" },
    watch:  { win: "watchwin", label: "Вочлист", btn: "watchbtn" },
    fin:    { win: "finwin",  label: "Финрез", btn: "finbtn" },
  };
  let TREE = load() || { t: "leaf", panel: null };
  let _uid = 1;
  function bumpResize() { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }

  function load() { try { return JSON.parse(localStorage.getItem(LS)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(LS, JSON.stringify(strip(TREE))); } catch (e) {} }
  function strip(n) {                                   // в localStorage — только структура (без DOM)
    if (n.t === "leaf") return { t: "leaf", panel: n.panel };
    return { t: "split", dir: n.dir, ratio: n.ratio, a: strip(n.a), b: strip(n.b) };
  }

  // ── помощники дерева ──
  function panelsInUse(n, set) { set = set || new Set();
    if (n.t === "leaf") { if (n.panel) set.add(n.panel); }
    else { panelsInUse(n.a, set); panelsInUse(n.b, set); } return set; }
  function findParent(root, target, parent) {
    if (root === target) return parent || null;
    if (root.t === "split") return findParent(root.a, target, root) || findParent(root.b, target, root);
    return null; }

  // ── операции ──
  function splitLeaf(leaf, dir) {                       // разбить лист на два (dir: row=верт.делитель, col=гориз.)
    const a = { t: "leaf", panel: leaf.panel }, b = { t: "leaf", panel: null };
    leaf.t = "split"; leaf.dir = dir; leaf.ratio = 0.5; leaf.a = a; leaf.b = b; leaf.panel = null;
    render(); save();
  }
  function closeLeaf(leaf) {                            // закрыть лист → его место занимает сосед
    const parent = findParent(TREE, leaf, null);
    if (!parent) { leaf.panel = null; render(); save(); return; }   // корневой лист — просто очистить
    const sib = parent.a === leaf ? parent.b : parent.a;
    Object.keys(parent).forEach(k => delete parent[k]);
    Object.assign(parent, sib);                        // схлопнуть: родитель становится соседом
    render(); save();
  }
  function assignPanel(leaf, pid) {                     // назначить панель листу (убрать из прежнего листа)
    if (pid) { const prev = leafOfPanel(TREE, pid); if (prev && prev !== leaf) prev.panel = null; }
    leaf.panel = pid || null; render(); save();
  }
  function leafOfPanel(n, pid) {
    if (n.t === "leaf") return n.panel === pid ? n : null;
    return leafOfPanel(n.a, pid) || leafOfPanel(n.b, pid); }

  // ── монтирование панелей ──
  function mountPanel(pid, host) {
    const el = $(PANELS[pid].win); if (!el) return;
    if (pid === "chart" && typeof window.popOutChart === "function") window.popOutChart();  // вынуть из встраивания в стакан
    // если панель ещё не запущена (скрыта) — кликнуть её кнопку, чтобы стартовали данные/таймеры
    if (el.classList.contains("hidden")) { const b = $(PANELS[pid].btn); if (b) b.click(); }
    if (!el.classList.contains("tiled") && el._preStyle == null) el._preStyle = el.getAttribute("style") || "";  // запомнить плавающую позицию
    el.classList.remove("hidden"); el.classList.add("tiled");
    host.appendChild(el);
  }
  function untile(el) {                                 // вернуть панель в плавающее окно на её прежнее место
    if (!el) return; el.classList.remove("tiled");
    if (el._preStyle != null) { el.setAttribute("style", el._preStyle); el._preStyle = null; }
    el.classList.add("hidden"); document.body.appendChild(el);
  }
  function unmountAll() {                               // вернуть все панели из дерева во floating (перед rebuild)
    Object.keys(PANELS).forEach(pid => { const el = $(PANELS[pid].win);
      if (el && el.classList.contains("tiled") && el.parentElement && el.parentElement.classList.contains("tleaf-body"))
        document.body.appendChild(el); });
  }

  // ── рендер дерева ──
  function render() {
    const root = $("wsroot"); if (!root) return;
    unmountAll();
    root.innerHTML = "";
    root.appendChild(build(TREE));
    // панели, которых нет в дереве, но помечены tiled → снять флаг и скрыть (вернулись во floating-состояние)
    const used = panelsInUse(TREE);
    Object.keys(PANELS).forEach(pid => { if (!used.has(pid)) { const el = $(PANELS[pid].win);
      if (el && el.classList.contains("tiled")) untile(el); } });
    bumpResize();
  }

  function build(node) {
    if (node.t === "leaf") return buildLeaf(node);
    const box = document.createElement("div");
    box.className = "tsplit " + (node.dir === "col" ? "tcol" : "trow");
    const A = build(node.a), B = build(node.b);
    const r = Math.max(0.08, Math.min(0.92, node.ratio || 0.5));
    A.style.flex = "0 0 " + (r * 100) + "%";
    B.style.flex = "1 1 0";
    const sp = document.createElement("div");
    sp.className = "tsplitter " + (node.dir === "col" ? "tsp-h" : "tsp-v");
    wireSplitter(sp, box, node, A);
    box.append(A, sp, B);
    return box;
  }

  function buildLeaf(leaf) {
    if (!leaf._id) leaf._id = "L" + (_uid++);
    const cell = document.createElement("div");
    cell.className = "tleaf";
    cell._node = leaf;                                 // привязка DOM→узел (для drag&drop)
    const head = document.createElement("div");
    head.className = "tleaf-head";
    // грип для перетаскивания панели в другую ячейку
    const grip = document.createElement("span");
    grip.className = "tleaf-grip"; grip.textContent = "⠿"; grip.title = "перетащи панель в другую ячейку";
    grip.style.visibility = leaf.panel ? "visible" : "hidden";
    grip.addEventListener("mousedown", (e) => startDrag(leaf, e));
    head.appendChild(grip);
    // выбор панели
    const sel = document.createElement("select");
    sel.className = "tleaf-sel";
    sel.innerHTML = '<option value="">— пусто —</option>' +
      Object.keys(PANELS).map(pid => '<option value="' + pid + '"' + (leaf.panel === pid ? " selected" : "") + '>' + PANELS[pid].label + "</option>").join("");
    sel.onchange = () => assignPanel(leaf, sel.value);
    // кнопки
    const bH = mkbtn("⇥", "разбить по вертикали (левый|правый)", () => splitLeaf(leaf, "row"));
    const bV = mkbtn("⤓", "разбить по горизонтали (верх/низ)", () => splitLeaf(leaf, "col"));
    const bX = mkbtn("✕", "закрыть ячейку", () => closeLeaf(leaf));
    head.append(sel, spacer(), bH, bV, bX);
    // тело
    const body = document.createElement("div");
    body.className = "tleaf-body";
    cell.append(head, body);
    if (leaf.panel && PANELS[leaf.panel]) mountPanel(leaf.panel, body);
    else { const hint = document.createElement("div"); hint.className = "tleaf-hint";
      hint.textContent = "выбери панель ▲ или разбей ячейку"; body.appendChild(hint); }
    return cell;
  }

  function mkbtn(txt, title, fn) { const b = document.createElement("button");
    b.className = "tleaf-btn"; b.textContent = txt; b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; }
  function spacer() { const s = document.createElement("span"); s.style.flex = "1"; return s; }

  // ── делители ──
  function wireSplitter(sp, box, node, A) {
    let on = false, start = 0, size = 0, base = 0;
    const horiz = node.dir !== "col";                  // trow → вертикальный делитель, тянем по X
    sp.addEventListener("mousedown", (e) => { on = true; start = horiz ? e.clientX : e.clientY;
      const r = box.getBoundingClientRect(); size = horiz ? r.width : r.height; base = node.ratio || 0.5;
      document.body.style.userSelect = "none"; e.preventDefault(); e.stopPropagation(); });
    window.addEventListener("mousemove", (e) => { if (!on || !size) return;
      const d = (horiz ? e.clientX : e.clientY) - start;
      node.ratio = Math.max(0.08, Math.min(0.92, base + d / size));
      A.style.flex = "0 0 " + (node.ratio * 100) + "%";
      bumpResize();
    });
    window.addEventListener("mouseup", () => { if (on) { on = false; document.body.style.userSelect = ""; save(); bumpResize(); } });
  }

  // ── drag&drop: тащим панель за грип в другую ячейку (край=сплит, центр=обмен) ──
  let DRAG = null;
  function startDrag(leaf, e) {
    if (!leaf.panel) return; e.preventDefault(); e.stopPropagation();
    const ov = document.createElement("div"); ov.className = "tsdrop"; ov.style.display = "none";
    const root = $("wsroot"); if (root) root.appendChild(ov);
    DRAG = { from: leaf, ov: ov, target: null, zone: null };
    document.body.style.cursor = "grabbing";
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp, { once: true });
  }
  function leafElFromPoint(x, y) { let el = document.elementFromPoint(x, y);
    while (el && el !== document.body) { if (el.classList && el.classList.contains("tleaf")) return el; el = el.parentElement; }
    return null; }
  function onDragMove(e) {
    if (!DRAG) return; const le = leafElFromPoint(e.clientX, e.clientY);
    const root = $("wsroot"); if (!le || !le._node || !root) { DRAG.ov.style.display = "none"; DRAG.target = null; return; }
    const body = le.querySelector(".tleaf-body") || le, r = body.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    let zone, zx = r.left - rr.left, zy = r.top - rr.top, zw = r.width, zh = r.height;
    if (fx < 0.25) { zone = "left"; zw = r.width / 2; }
    else if (fx > 0.75) { zone = "right"; zx += r.width / 2; zw = r.width / 2; }
    else if (fy < 0.25) { zone = "top"; zh = r.height / 2; }
    else if (fy > 0.75) { zone = "bottom"; zy += r.height / 2; zh = r.height / 2; }
    else zone = "center";
    DRAG.target = le._node; DRAG.zone = zone;
    const o = DRAG.ov; o.style.display = "block"; o.style.left = zx + "px"; o.style.top = zy + "px"; o.style.width = zw + "px"; o.style.height = zh + "px";
  }
  function onDragUp() {
    window.removeEventListener("mousemove", onDragMove); document.body.style.cursor = "";
    const d = DRAG; DRAG = null; if (!d) return;
    if (d.ov && d.ov.parentElement) d.ov.parentElement.removeChild(d.ov);
    if (d.target && d.zone) dropMove(d.from, d.target, d.zone);
  }
  function collapseIfEmpty(leaf) {
    if (leaf.t !== "leaf" || leaf.panel) return;
    const parent = findParent(TREE, leaf, null); if (!parent) return;
    const sib = parent.a === leaf ? parent.b : parent.a;
    Object.keys(parent).forEach(k => delete parent[k]); Object.assign(parent, sib);
  }
  function dropMove(from, target, zone) {
    if (from === target || !from.panel) return;
    const pid = from.panel;
    if (zone === "center") { const tmp = target.panel; target.panel = pid; from.panel = tmp; render(); save(); return; }
    const dir = (zone === "left" || zone === "right") ? "row" : "col";
    const before = (zone === "left" || zone === "top");
    const keep = { t: "leaf", panel: target.panel }, ins = { t: "leaf", panel: pid };
    target.t = "split"; target.dir = dir; target.ratio = 0.5; target.panel = null;
    target.a = before ? ins : keep; target.b = before ? keep : ins;
    from.panel = null; collapseIfEmpty(from);
    render(); save();
  }

  // ── окно воркспейса ──
  function open() { const w = $("wswin"); if (!w) return; w.classList.remove("hidden"); render(); }
  function close() { const w = $("wswin"); if (!w) return; w.classList.add("hidden");
    // вернуть панели в обычные плавающие окна (скрытые) — чтобы не «застревали» в закрытом воркспейсе
    Object.keys(PANELS).forEach(pid => { const el = $(PANELS[pid].win);
      if (el && el.classList.contains("tiled")) untile(el); }); }
  function reset() { TREE = { t: "leaf", panel: null }; render(); save(); }

  function init() {
    const w = $("wswin"); if (!w) return;
    if (window.Dock) window.Dock.makeWindow({ win: w, handle: $("wsdrag"), titleBar: $("wsdrag"),
      resize: $("wsres"), key: "workspace", minW: 420, minH: 260, onResize: render });
    const btn = $("wsbtn"); if (btn) btn.onclick = () => w.classList.contains("hidden") ? open() : close();
    const xc = $("wsclose"); if (xc) xc.onclick = close;
    const rs = $("wsreset"); if (rs) rs.onclick = reset;
  }
  window.Tiles = { open, close, render };
  // общий помощник: вытащить любую панель из тайла в нормальное плавающее окно (для кнопок панелей)
  window.untileFloat = function (win, def) {
    if (!win) return; const wasTiled = win.classList.contains("tiled");
    win.classList.remove("hidden"); win.classList.remove("tiled");
    if (win.parentElement !== document.body) document.body.appendChild(win);
    win.style.zIndex = 45;
    const r = win.getBoundingClientRect(); def = def || {};
    if (wasTiled || r.width < 120 || r.height < 80 || r.right < 60 || r.bottom < 60 ||
        r.left > innerWidth - 60 || r.top > innerHeight - 40 || (r.left < 40 && r.top < 90)) {
      win.style.left = "auto"; win.style.right = (def.right || 20) + "px"; win.style.top = (def.top || 120) + "px";
      win.style.width = (def.w || 560) + "px"; win.style.height = (def.h || 480) + "px";
    }
  };
  window.isPanelFloatingVisible = function (win) {
    return !!win && !win.classList.contains("hidden") && !win.classList.contains("tiled");
  };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
