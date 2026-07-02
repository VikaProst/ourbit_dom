// theme.js — система тем (палитра стакана), пресеты, кастомный RGBA-пикер.
// Единый источник правды по цветам стакана = LAD_PAL. Тема пишет в LAD_PAL и просит перерисовку (S._render).
// «Стандартная» тема = снимок дефолтных значений LAD_PAL (read-only). Правки уходят в копию (новую тему).
// Хранение: localStorage. Экспорт/импорт JSON. Живое применение без перезагрузки.
(function(){
  "use strict";
  const LS = "ourbit.themes.v1";

  // Редактируемые ключи палитры стакана: секции + подписи. Значения по умолчанию берём из LAD_PAL.
  const KEYS = [
    {sec:"Основа", items:[
      {k:"bg",       label:"Фон стакана"},
      {k:"priceBg",  label:"Фон колонки цены"},
    ]},
    {sec:"Плотность (полосы объёма)", items:[
      {k:"bar",      label:"Полоса",         alpha:1},
      {k:"barWall",  label:"Полоса-стена",   alpha:1},
      {k:"txtNorm",  label:"Текст объёма"},
      {k:"txtBig",   label:"Текст крупного"},
      {k:"ice",      label:"Айсберг"},
    ]},
    {sec:"Бид / Аск", items:[
      {k:"bidBg",    label:"Фон бида",       alpha:1},
      {k:"askBg",    label:"Фон аска",       alpha:1},
      {k:"bidPill",  label:"Лучший бид"},
      {k:"askPill",  label:"Лучший аск"},
    ]},
    {sec:"Цена / уровни", items:[
      {k:"price",    label:"Цена"},
      {k:"priceMain",label:"Осн. уровень"},
      {k:"priceMid", label:"Промеж. уровень"},
    ]},
    {sec:"Ховер / вспышки", items:[
      {k:"hoverBadge",label:"Бейдж ховера"},
      {k:"rulerBand", label:"Линейка (плашка)",   alpha:1},
      {k:"rulerLine", label:"Линейка (crosshair)",alpha:1},
      {k:"flashBuy",  label:"Вспышка покупки",    alpha:1, prefix:1},
      {k:"flashSell", label:"Вспышка продажи",    alpha:1, prefix:1},
      {k:"flashPull", label:"Вспышка снятия",     alpha:1, prefix:1},
    ]},
    {sec:"График", items:[
      {k:"candleUp",  label:"Свеча вверх"},
      {k:"candleDown",label:"Свеча вниз"},
      {k:"chartLast", label:"Линия цены"},
      {k:"chartText", label:"Текст/шкала"},
      {k:"chartGrid", label:"Сетка", alpha:1},
    ]},
    {sec:"Лента", items:[
      {k:"tapeBuy",  label:"Покупка"},
      {k:"tapeSell", label:"Продажа"},
    ]},
  ];
  const ALLK = []; KEYS.forEach(s => s.items.forEach(it => ALLK.push(it)));
  const META = {}; ALLK.forEach(it => META[it.k] = it);

  // ── парсинг/сборка цвета ──
  function parse(str){
    str = String(str || "").trim();
    let m = str.match(/^#([0-9a-f]{6})$/i);
    if(m){ const n = parseInt(m[1],16); return {r:n>>16&255, g:n>>8&255, b:n&255, a:1}; }
    m = str.match(/^#([0-9a-f]{3})$/i);
    if(m){ const h=m[1]; return {r:parseInt(h[0]+h[0],16), g:parseInt(h[1]+h[1],16), b:parseInt(h[2]+h[2],16), a:1}; }
    m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)?\s*,?\s*$/i);
    if(m){ return {r:+m[1], g:+m[2], b:+m[3], a: m[4]==null ? 1 : parseFloat(m[4])}; }
    return {r:128, g:128, b:128, a:1};
  }
  function hex2(n){ return ("0"+((n|0)&255).toString(16)).slice(-2); }
  function toStr(c, prefix){
    const a = Math.max(0, Math.min(1, c.a==null?1:c.a));
    if(prefix) return "rgba("+(c.r|0)+","+(c.g|0)+","+(c.b|0)+",";   // незакрытый префикс — рендер допишет alpha
    if(a >= 1) return "#"+hex2(c.r)+hex2(c.g)+hex2(c.b);
    return "rgba("+(c.r|0)+","+(c.g|0)+","+(c.b|0)+","+(+a.toFixed(3))+")";
  }
  // цвет для отрисовки свотча (всегда валидный rgba, даже для префиксных ключей)
  function swatchColor(str){ const c = parse(str); return "rgba("+(c.r|0)+","+(c.g|0)+","+(c.b|0)+","+(c.a==null?1:c.a)+")"; }

  // ── применение темы в LAD_PAL ──
  function apply(app){
    if(typeof LAD_PAL === "undefined" || !app) return;
    for(const it of ALLK){ if(app[it.k] != null) LAD_PAL[it.k] = app[it.k]; }
    if(typeof S !== "undefined") S._render = true;
  }

  // ── хранилище пресетов ──
  let STORE = {active:"Стандартная", list:[]};
  function snapshotDefault(){
    const app = {}; for(const it of ALLK) app[it.k] = (typeof LAD_PAL!=="undefined" ? LAD_PAL[it.k] : "");
    return {name:"Стандартная", ro:true, app};
  }
  function migrate(app, def){ const out = Object.assign({}, def); if(app) for(const k in app) if(k in def) out[k] = app[k]; return out; }
  function load(){
    try{ const j = JSON.parse(localStorage.getItem(LS)); if(j && Array.isArray(j.list)) STORE = j; }catch(e){}
    const def = snapshotDefault();               // «Стандартная» = всегда актуальный снимок дефолтов (read-only)
    const i = STORE.list.findIndex(t => t.name === "Стандартная");
    if(i < 0) STORE.list.unshift(def);
    else STORE.list[i] = {name:"Стандартная", ro:true, app: def.app};
    // миграция остальных тем: недостающие ключи берём из дефолта
    for(const t of STORE.list){ if(t.name!=="Стандартная") t.app = migrate(t.app, def.app); }
    if(!STORE.list.some(t => t.name === STORE.active)) STORE.active = "Стандартная";
  }
  function save(){ try{ localStorage.setItem(LS, JSON.stringify(STORE)); }catch(e){} }
  function active(){ return STORE.list.find(t => t.name === STORE.active) || STORE.list[0]; }
  function uniqName(base){ let n=base, i=2; while(STORE.list.some(t=>t.name===n)){ n=base+" "+i; i++; } return n; }
  function forkIfRO(){                            // правка read-only темы → копия
    let a = active();
    if(a && a.ro){ const cp = {name:uniqName("Тема"), app:Object.assign({}, a.app)}; STORE.list.push(cp); STORE.active = cp.name; a = cp; }
    return a;
  }

  // ── UI: вкладка «Отображение» ──
  const $ = (id) => document.getElementById(id);
  function build(){
    const pane = $("pane-display"); if(!pane) return;
    pane.innerHTML = "";
    // управление пресетами
    const bar = document.createElement("div"); bar.className = "thbar";
    const sel = document.createElement("select"); sel.id = "th-sel";
    bar.appendChild(sel);
    const mk = (t, fn) => { const b=document.createElement("button"); b.className="thbtn"; b.textContent=t; b.onclick=fn; bar.appendChild(b); return b; };
    mk("Новая", () => { const cp={name:uniqName("Тема"), app:Object.assign({}, active().app)}; STORE.list.push(cp); STORE.active=cp.name; save(); build(); });
    mk("Дубль", () => { const cp={name:uniqName(active().name), app:Object.assign({}, active().app)}; STORE.list.push(cp); STORE.active=cp.name; save(); build(); });
    mk("Переименовать", () => { const a=active(); if(a.ro) return alert("«Стандартная» защищена"); const nm=prompt("Название темы:", a.name); if(nm && nm.trim()){ a.name=uniqName(nm.trim()); STORE.active=a.name; save(); build(); } });
    mk("Удалить", () => { const a=active(); if(a.ro) return alert("«Стандартная» защищена"); STORE.list=STORE.list.filter(t=>t!==a); STORE.active="Стандартная"; save(); apply(active().app); build(); });
    mk("Сбросить", () => { STORE.active="Стандартная"; save(); apply(active().app); build(); });
    mk("Экспорт", exportJson);
    mk("Импорт", importJson);
    pane.appendChild(bar);

    sel.innerHTML = "";
    for(const t of STORE.list){ const o=document.createElement("option"); o.value=t.name; o.textContent=t.name+(t.ro?" (станд.)":""); if(t.name===STORE.active) o.selected=true; sel.appendChild(o); }
    sel.onchange = () => { STORE.active = sel.value; save(); apply(active().app); build(); };

    // секции цветов (сворачиваемые)
    for(const s of KEYS){
      const sec = document.createElement("div"); sec.className = "thsec";
      const head = document.createElement("div"); head.className = "thsechead";
      head.innerHTML = '<span class="tharrow">⌄</span>'+s.sec;
      const body = document.createElement("div"); body.className = "thsecbody";
      head.onclick = () => { body.classList.toggle("collapsed"); head.querySelector(".tharrow").textContent = body.classList.contains("collapsed")?"›":"⌄"; };
      for(const it of s.items){
        const row = document.createElement("div"); row.className = "throw";
        const lbl = document.createElement("span"); lbl.className="thlbl"; lbl.textContent = it.label;
        const sw = document.createElement("button"); sw.className = "thsw"; sw.dataset.k = it.k;
        sw.style.setProperty("--c", swatchColor(active().app[it.k]));
        sw.onclick = () => openPicker(it, sw);
        row.append(lbl, sw); body.appendChild(row);
      }
      sec.append(head, body); pane.appendChild(sec);
    }
  }
  function refreshSwatches(){ document.querySelectorAll("#pane-display .thsw").forEach(sw => sw.style.setProperty("--c", swatchColor(active().app[sw.dataset.k]))); }

  // ── кастомный RGBA-пикер (R/G/B/A ползунки + hex/rgba ввод + превью на шахматке) ──
  let PICK = null;
  function openPicker(it, anchor){
    closePicker();
    const a = active(); const c = parse(a.app[it.k]);
    const box = document.createElement("div"); box.className = "thpick";
    box.innerHTML =
      '<div class="thpreview"><span></span></div>'+
      row("R", "r", c.r, 255)+ row("G","g",c.g,255)+ row("B","b",c.b,255)+
      (it.alpha ? rowA("A","a",c.a) : "")+
      '<div class="thpickrow"><input class="thhex" type="text"></div>'+
      '<div class="thpickfoot"><button class="thbtn" data-x="ok">Готово</button></div>';
    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.min(window.innerWidth-230, r.left) + "px";
    box.style.top  = Math.min(window.innerHeight-260, r.bottom+4) + "px";
    PICK = box;
    const prev = box.querySelector(".thpreview span");
    const hex = box.querySelector(".thhex");
    const cur = {r:c.r, g:c.g, b:c.b, a:it.alpha?c.a:1};
    const upd = (writeHex) => {
      const str = toStr(cur, it.prefix);
      prev.style.background = swatchColor(str);
      if(writeHex) hex.value = str;
      const a2 = forkIfRO(); a2.app[it.k] = str; apply(a2.app); anchor.style.setProperty("--c", swatchColor(str));
    };
    box.querySelectorAll("input[type=range]").forEach(inp => {
      inp.oninput = () => { const ch=inp.dataset.ch; cur[ch] = ch==="a"?parseFloat(inp.value):parseInt(inp.value,10); upd(true); refreshSelName(); };
    });
    hex.value = toStr(cur, it.prefix);
    hex.onchange = () => { const p=parse(hex.value); cur.r=p.r; cur.g=p.g; cur.b=p.b; if(it.alpha) cur.a=p.a; box.querySelectorAll("input[type=range]").forEach(inp=>{ inp.value=cur[inp.dataset.ch]; }); upd(false); refreshSelName(); };
    box.querySelector('[data-x=ok]').onclick = () => { save(); closePicker(); };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
    function outside(e){ if(!box.contains(e.target) && e.target!==anchor){ save(); closePicker(); } }
    box._outside = outside;
  }
  function row(lbl, ch, val, max){ return '<div class="thpickrow"><label>'+lbl+'</label><input type="range" data-ch="'+ch+'" min="0" max="'+max+'" value="'+(val|0)+'"></div>'; }
  function rowA(lbl, ch, val){ return '<div class="thpickrow"><label>'+lbl+'</label><input type="range" data-ch="'+ch+'" min="0" max="1" step="0.01" value="'+(val==null?1:val)+'"></div>'; }
  function refreshSelName(){ const sel=$("th-sel"); if(sel && sel.value!==STORE.active){ /* пересобрать список при форке */ build(); } }
  function closePicker(){ if(PICK){ if(PICK._outside) document.removeEventListener("mousedown", PICK._outside, true); PICK.remove(); PICK=null; } }

  // ── экспорт/импорт ──
  function exportJson(){
    const a = active(); const blob = new Blob([JSON.stringify(a, null, 1)], {type:"application/json"});
    const url = URL.createObjectURL(blob); const el = document.createElement("a");
    el.href = url; el.download = "theme-"+a.name.replace(/\s+/g,"_")+".json"; el.click(); URL.revokeObjectURL(url);
  }
  function importJson(){
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json";
    inp.onchange = () => { const f=inp.files[0]; if(!f) return; const fr=new FileReader();
      fr.onload = () => { try{ const t=JSON.parse(fr.result); if(t && t.app){ t.name=uniqName(t.name||"Импорт"); delete t.ro; t.app=migrate(t.app, snapshotDefault().app); STORE.list.push(t); STORE.active=t.name; save(); apply(t.app); build(); } }catch(e){ alert("Некорректный JSON темы"); } };
      fr.readAsText(f); };
    inp.click();
  }

  // ── старт ──
  function init(){ load(); apply(active().app); build(); }
  // app.js уже отработал (theme.js подключён после него), LAD_PAL и S существуют
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.Themes = {apply:()=>apply(active().app), rebuild:build};
})();
