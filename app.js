"use strict";
const POLL_DEPTH = 40, POLL_FLOW = 250;
let ROW_PX = 14; const COL_W = 46;     // высота строки (CSS rowCss+1) и ширина колонки футпринта
function applyRowH(cssPx){ S.rowCss=cssPx; ROW_PX=cssPx+1;
  document.documentElement.style.setProperty("--rowh", ROW_PX+"px");   // строка = ROW_PX (граница внутри, border-box)
  if(typeof measureRowPitch==="function") measureRowPitch();   // пересчёт реальной высоты строки
  S._render=true; }
function applyLadWidth(px){ S.ladWidth=px; const l=$("ladder"); if(l) l.style.width=px+"px"; S._render=true; }
const $ = (id) => document.getElementById(id);

// пороги как в «Настройки стакана» MetaScalp: fill=Заполнение строки, big1=Крупный объём, big2=Крупный объём 2
// цвет: больший порог → оранжевый (как было), меньший порог → красный
const CFG = {
  USD:       { fill: 5000,  big1: 2500,  big2: 5000,  cluFill: 12000 },
  coin:      { fill: 10000, big1: 10000, big2: 20000, cluFill: 40000 },
  contracts: { fill: 5000,  big1: 2500,  big2: 5000,  cluFill: 20000 },
};
const STEP_MULTS = [1, 2, 5, 10, 20, 50, 100];

const S = {
  symbol: "XAUT_USDT", tick: 0.01, dec: 2, contractSize: 0.001,
  unit: "USD", stepMult: 1, step: 0.01,
  depth: null, flow: { footprint: [], ticks: [], delta: [], now: 0 },
  geo: { topS: 0, botS: 0, rowH: ROW_PX, h: 0 }, lastMid: null, fpWidth: 260,
  size: 160, lev: 50, instr: {}, bestBid: 0, bestAsk: 0, baS: 0, bbS: 0, hover: null, centerS: null, hideFp: false,
  // настройки стакана (как «Настройки стакана» MetaScalp)
  mainMult: 50, midMult: 10, range: 120, fpMin: 3, rowCss: 13, ladWidth: 190, theme: "dark", fps: 20, lotsX: null, lotsY: null, fpTotal: 380,
  topStab: false, topHold: 150,   // стабилизация топа ВЫКЛ по умолчанию (прячет реальный край) — истинный край показываем сразу, спокойствие даёт FPS-троттлинг
  showVP: true, showCols: true,   // VP и вертикальные столбцы объёма/дельты футпринта
  autoCenter: false,              // авто-центровка цены с гистерезисом (для волатильности)
  cluMode: "delta", cluTF: 1, ladMinUsd: 0,
  tickStyle: "both", tickLine: 1.2, tickMin: 0, tickAgg: 200, tickBig: 5000, avgMode: "Fix", slPct: 0, tpPct: 0, slUsd: 0, margin: "cross", orderMode: "market", throwPct: 0.05, pnlFmt: "usd", abbrev: true, fillAuto: false, fillTopN: 10, fillMult: 1, colorAuto: true, sound: false, spreadGate: 3,
  // настраиваемые горячие клавиши (действие → физ.код клавиши, e.code)
  keys: { buy:"KeyT", sell:"KeyY", limitBuy:"KeyA", limitSell:"KeyS", close:"KeyD",
          reverse:"KeyR", cancel:"KeyB", center:"KeyC", be:"KeyG" },
};
// центрировать стакан на текущей цене ОДИН раз (по клавише), без непрерывного авто-центра
function centerNow(){ S._centerReq = true; S._render = true; }
window.centerNow = centerNow;
function markDirty(){ S._render = true; }   // «нужна перерисовка» — дёргать на любом взаимодействии
window.markDirty = markDirty;
// табы инструментов: быстрое переключение монеты (как вкладки MetaScalp)
let SYMTABS=[]; try{ SYMTABS=JSON.parse(localStorage.getItem("symtabs"))||[]; }catch(e){}
function saveTabs(){ try{ localStorage.setItem("symtabs", JSON.stringify(SYMTABS)); }catch(e){} }
function renderTabs(){ const box=$("symtabs"); if(!box) return; box.innerHTML="";
  for(const sym of SYMTABS){ const t=document.createElement("span"); t.className="symtab"+(sym===S.symbol?" on":"");
    t.innerHTML=sym.replace("_USDT","")+'<i class="symtab-x">×</i>';
    t.onmousedown=(e)=>e.stopPropagation();
    t.onclick=(e)=>{ if(e.target.classList.contains("symtab-x")){ SYMTABS=SYMTABS.filter(x=>x!==sym); saveTabs(); renderTabs(); return; }
      if(sym!==S.symbol && typeof switchSymbol==="function"){ switchSymbol(sym); const inp=$("symbol"); if(inp) inp.value=sym.replace("_USDT",""); } };
    box.appendChild(t); } }
function addTab(sym){ sym=sym||S.symbol; if(sym && SYMTABS.indexOf(sym)<0){ SYMTABS.push(sym); saveTabs(); } renderTabs(); }
window.renderTabs=renderTabs; window.addTab=addTab;
// сигнальный уровень (алерт): Ctrl+клик по стакану ставит/снимает линию-звонок на цене
function toggleAlert(price){ if(!(price>0)) return; if(!S._alerts) S._alerts={};
  const arr=S._alerts[S.symbol]||(S._alerts[S.symbol]=[]);
  const p=+(Math.round(price/S.step)*S.step).toFixed(S.dec);
  const i=arr.findIndex(a=>Math.abs(a-p)<S.step*0.5);
  if(i>=0) arr.splice(i,1); else arr.push(p);
  S._render=true; if(typeof saveCurrent==="function") saveCurrent(); }
window.toggleAlert=toggleAlert;

function decimalsOf(t){ if(!t) return 2; const s=String(t);
  if(s.includes("e-")) return parseInt(s.split("e-")[1],10);
  return s.includes(".")?s.split(".")[1].length:0; }
// LRU-кэш форматирования объёма: в горячем цикле рисования 0 аллокаций строк (значения повторяются между кадрами)
const _fmtCache=new Map();
function fmt(v){ v=Math.round(v);
  const key=(S.abbrev===false?1:0)*1e15+v; const hit=_fmtCache.get(key); if(hit!==undefined) return hit;
  let r;
  if(S.abbrev===false) r=String(v);
  else if(v>=1e6) r=(v/1e6).toFixed(1)+"M";
  else if(v>=1e3) r=(v/1e3).toFixed(v>=1e4?0:1)+"K"; else r=String(v);
  if(_fmtCache.size>6000) _fmtCache.clear(); _fmtCache.set(key,r); return r; }
// кэш строк цены (price.toFixed(dec)) — уровни стабильны между кадрами, экономит toFixed в цикле
const _pxCache=new Map();
function fmtPrice(price, dec){ const key=dec*1e12+Math.round(price*1e6); const hit=_pxCache.get(key); if(hit!==undefined) return hit;
  const r=price.toFixed(dec); if(_pxCache.size>8000) _pxCache.clear(); _pxCache.set(key,r); return r; }
function status(st,txt){ $("dot").className="dot"+(st==="live"?" live":st==="err"?" err":"");
  $("statustext").textContent=txt; }
function unitVal(vc, price){
  if(S.unit==="USD")  return vc*S.contractSize*price;
  if(S.unit==="coin") return vc*S.contractSize;
  return vc; }

// «Складывать тики за период» (как MetaScalp): подряд идущие сделки ОДНОЙ стороны в окне aggMs
// сливаются в один принт. Объём суммируется, цена = средневзвешенная (VWAP). aggMs=0 → сырые тики.
function aggregateTicks(ticks, aggMs){
  if(!aggMs || aggMs<=0 || !ticks.length) return ticks;
  const out=[];
  for(const tk of ticks){
    const last=out[out.length-1];
    if(last && tk.side===last.side && (tk.t - last._t0) <= aggMs){
      const nv=last.v+tk.v;
      last.p=(last.p*last.v + tk.p*tk.v)/nv;   // средневзвешенная цена принта
      last.v=nv; last.t=tk.t;                  // объём суммируем, время — последнее
    } else {
      out.push({p:tk.p, v:tk.v, side:tk.side, t:tk.t, _t0:tk.t});
    }
  }
  return out;
}

// Таймфрейм кластеров: минутные колонки футпринта группируем в бакеты по tf минут (клиентская агрегация).
// Ограничено историей fpMin (минут) на сервере.
// сборка футпринта из сырых тиков на произвольном ТФ (секунды) — для суб-минутных ТФ (30с), которых нет в серверных минутных бакетах
function buildFpFromTicks(tfSec){
  const ticks=S.flow.ticks||[], tick=S.tick||0.01, bucketMs=Math.max(1,tfSec)*1000;
  const idx=new Map(), out=[];
  for(const t of ticks){ const b=Math.floor(t.t/bucketMs), ti=Math.round(t.p/tick);
    let col=idx.get(b); if(!col){ col={t:b, cells:{}}; idx.set(b,col); out.push(col); }
    const cell=col.cells[ti]||[0,0]; if(t.side===1) cell[0]+=t.v; else cell[1]+=t.v; col.cells[ti]=cell; }
  return out.sort((a,b)=>a.t-b.t);
}
function groupFootprint(fp, tf){
  if(!tf || tf<=1 || !fp.length) return fp;
  const out=[], idx=new Map();
  for(const c of fp){ const b=Math.floor(c.t/tf);
    let g=idx.get(b);
    if(!g){ g={t:b*tf, cells:{}}; idx.set(b,g); out.push(g); }
    for(const k in c.cells){ const cell=g.cells[k]||[0,0]; cell[0]+=c.cells[k][0]; cell[1]+=c.cells[k][1]; g.cells[k]=cell; }
  }
  return out;
}

async function loadInstruments(){
  const r = await fetch("/api/instruments").then(x=>x.json()); if(!r.ok) return;
  const list = r.instruments.slice().sort((a,b)=>a.symbol.localeCompare(b.symbol));
  for(const i of list) S.instr[i.symbol]=i;
  const pri = ["XAUT_USDT","PAXG_USDT","SILVER_USDT","BTC_USDT","ETH_USDT"];
  const ordered = [...pri.filter(s=>S.instr[s]).map(s=>S.instr[s]),
                   ...list.filter(i=>!pri.includes(i.symbol))];
  S.symMap={};
  const dl=$("symlist"); dl.innerHTML="";
  for(const ins of ordered){ const base=ins.symbol.replace("_USDT","");
    S.symMap[base]=ins.symbol;
    const o=document.createElement("option"); o.value=base; dl.appendChild(o); }
  const inp=$("symbol"); inp.value=S.symbol.replace("_USDT","");
  applySymbolMeta();
  const tryset=()=>{ const v=inp.value.trim().toUpperCase();
    const full=S.symMap[v]||(S.instr[v]?v:null)||(S.instr[v+"_USDT"]?v+"_USDT":null);
    if(full && full!==S.symbol){ switchSymbol(full); inp.value=full.replace("_USDT",""); inp.blur(); } };
  inp.addEventListener("change", tryset);
  inp.addEventListener("input", ()=>{ if(S.symMap[inp.value.trim().toUpperCase()]) tryset(); });
}
function switchSymbol(full){
  S.symbol=full; applySymbolMeta(); S.centerS=null;
  S.flow={footprint:[],ticks:[],delta:[],now:0}; POOL=[];
  if(S._pv) S._pv.clear(); if(S._flash) S._flash.clear();   // сброс детекта проедания
  S._render=true;
  if(typeof connectStream==="function") connectStream();
  if(window.linkOn && window.setChartSym) setChartSym(full);   // ЛИНК: график следует за стаканом
  S.markPrice=0; if(typeof renderTabs==="function") renderTabs();
}
// поиск монеты по клику на название (как MetaScalp): поле поиска + список инструментов
function openSymbolSearch(onPick, anchorEl){
  closeSymbolSearch();
  const box=document.createElement("div"); box.className="symsearch"; box.id="symsearch";
  const inp=document.createElement("input"); inp.className="symsearch-inp"; inp.placeholder="Поиск по имени…"; inp.autocomplete="off"; inp.spellcheck=false;
  const list=document.createElement("div"); list.className="symsearch-list";
  box.append(inp,list); document.body.appendChild(box);
  const an=(anchorEl||$("booktitle")).getBoundingClientRect(); box.style.left=Math.round(an.left)+"px"; box.style.top=Math.round(an.bottom+4)+"px";
  const all=Object.keys(S.instr).sort();
  const render=(flt)=>{ list.innerHTML=""; const q=(flt||"").toUpperCase(); let n=0;
    for(const sym of all){ const base=sym.replace("_USDT","");
      if(q && base.indexOf(q)<0) continue; if(n++>300) break;
      const it=document.createElement("div"); it.className="symsearch-it"+(sym===S.symbol?" on":""); it.textContent=base;
      it.onclick=()=>{ if(onPick) onPick(sym); else switchSymbol(sym); const si=$("symbol"); if(si) si.value=base; closeSymbolSearch(); };
      list.appendChild(it); } };
  render("");
  inp.oninput=()=>render(inp.value.trim());
  inp.onkeydown=(e)=>{ if(e.key==="Enter"){ const f=list.querySelector(".symsearch-it"); if(f) f.click(); } else if(e.key==="Escape") closeSymbolSearch(); };
  inp.focus();
  setTimeout(()=>document.addEventListener("mousedown",_symOutside,true),0);
}
function _symOutside(e){ const b=$("symsearch"); if(b && !b.contains(e.target) && e.target!==$("booktitle")) closeSymbolSearch(); }
function closeSymbolSearch(){ const b=$("symsearch"); if(b) b.remove(); document.removeEventListener("mousedown",_symOutside,true); }
function applySymbolMeta(){
  const m=S.instr[S.symbol]; if(!m) return;
  S.tick=parseFloat(m.tick)||0.01; S.dec=decimalsOf(S.tick);
  S.contractSize=parseFloat(m.contractSize)||1; buildStepOptions();
  const bt=$("booktitle"); if(bt) bt.textContent=S.symbol.replace("_USDT","");
}
function buildStepOptions(){
  if(!STEP_MULTS.includes(S.stepMult)) S.stepMult=1;
  S.step=S.stepMult*S.tick; updateStepBtn();
}
function updateStepBtn(){ const b=$("stepbtn"); if(b) b.textContent="×"+S.stepMult;
  const p=$("pt6x"); if(p) p.textContent="×"+S.stepMult; }
function wirePanelTools(){
  document.querySelectorAll("#paneltools .pt").forEach(b=>{ b.onclick=()=>{ const a=b.dataset.act;
    if(a==="unit"){ const U=["USD","coin","contracts"]; S.unit=U[(U.indexOf(S.unit)+1)%U.length];
      b.textContent=S.unit==="USD"?"$":S.unit==="coin"?"C":"#"; }
    else if(a==="clusters"){ if(window.setTrailCollapsed) setTrailCollapsed(!S.hideFp,true); b.classList.toggle("act",!S.hideFp); }
    else if(a==="gear"){ $("gear").click(); }
    else if(a==="reconnect"){ hardRefresh(); }
    else if(a==="chart"){ if(window.openChart) openChart(S.symbol||"XAUT_USDT"); b.classList.add("act"); }
    else if(a==="link"){ window.linkOn=!window.linkOn; b.classList.toggle("act",window.linkOn);
      if(window.linkOn && window.setChartSym) setChartSym(S.symbol); }   // линк: график/скринер следуют за монетой стакана
    else if(a==="notes"){ b.classList.toggle("act"); } S._render=true; }; });
  const p=$("pt6x"); if(p) p.onclick=(e)=>{ e.stopPropagation(); showCompressMenu(p); };
}
// ресайз окна за ВСЕ углы/края (n/s/e/w + углы)
function addResizeHandles(win){
  for(const d of ["n","s","e","w","ne","nw","se","sw"]){
    if(win.querySelector(".rzh-"+d)) continue;
    const h=document.createElement("div"); h.className="rzh rzh-"+d; h.dataset.d=d;
    h.addEventListener("mousedown",(e)=>startResize(e,win,d)); win.appendChild(h);
  }
}
function startResize(e,win,d){ e.preventDefault(); e.stopPropagation();
  const sx=e.clientX, sy=e.clientY, r=win.getBoundingClientRect(), sl=r.left, st=r.top, sw=r.width, sh=r.height;
  const mv=(ev)=>{ const dx=ev.clientX-sx, dy=ev.clientY-sy; let l=sl,t=st,w=sw,hh=sh;
    if(d.indexOf("e")>=0) w=Math.max(340, sw+dx);
    if(d.indexOf("s")>=0) hh=Math.max(200, sh+dy);
    if(d.indexOf("w")>=0){ w=Math.max(340, sw-dx); l=sl+(sw-w); }
    if(d.indexOf("n")>=0){ hh=Math.max(200, sh-dy); t=st+(sh-hh); }
    win.style.left=l+"px"; win.style.right="auto"; win.style.top=t+"px"; win.style.width=w+"px"; win.style.height=hh+"px";
    S._render=true; _fpSig=""; };
  const up=()=>{ window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up);
    if(window.Dock&&Dock.record) Dock.record(win,"book"); };
  window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up);
}
function wireBookWin(){
  const el=$("bookwin"); if(!el) return;
  addResizeHandles(el);
  const ta=$("symtabadd"); if(ta){ ta.onmousedown=(e)=>e.stopPropagation();
    ta.onclick=(e)=>{ e.stopPropagation();       // «+» = новая вкладка: выбрать монету в поиске
      openSymbolSearch((sym)=>{ addTab(sym); switchSymbol(sym); const inp=$("symbol"); if(inp) inp.value=sym.replace("_USDT",""); }, ta); }; }
  renderTabs();
  const bt=$("booktitle"); if(bt){ bt.style.cursor="pointer"; bt.title="сменить монету — клик";
    bt.onmousedown=(e)=>e.stopPropagation();               // не начинать перетаскивание окна
    bt.onclick=(e)=>{ e.stopPropagation(); openSymbolSearch(); }; }
  // стакан = тоже докируемое окно (крест-докинг лево/право/верх/низ + сворачивание + сохранение), как график/лента
  const setup=()=>{ if(window.Dock){
      window.Dock.makeWindow({ win:el, handle:$("bookdrag"), titleBar:$("bookdrag"), resize:$("bookres"),
        key:"book", minW:340, minH:260, onResize:()=>{ _fpSig=""; S._render=true; } });
    } else requestAnimationFrame(setup); };   // dock.js грузится сразу после app.js — к 1-му кадру уже готов
  setup();
}
async function pollTicker(){
  try{ const r=await fetch("/api/ticker?symbol="+encodeURIComponent(S.symbol)).then(x=>x.json());
    if(r.ok && r.rise!=null){ const pc=r.rise*100, el=$("chg");
      el.textContent=(pc>=0?"+":"")+pc.toFixed(2)+"%"; el.className="chg "+(pc>=0?"up":"down");
      if(r.mark!=null){ S.markPrice=+r.mark; S._render=true; } } }catch(e){}
}
function setStepMult(mult){ mult=Math.round(mult); if(!(mult>0)) return;   // принимает ЛЮБОЕ целое ≥1 (не только из списка)
  S.stepMult=mult; S.step=mult*S.tick; S.centerS=null; updateStepBtn(); S._render=true; }
// выпадающее меню сжатия: пресеты + ввод своего значения (как MetaScalp)
function showCompressMenu(anchor){
  closeCompressMenu();
  const m=document.createElement("div"); m.className="cmpmenu"; m.id="cmpmenu";
  const inp=document.createElement("input"); inp.type="number"; inp.min="1"; inp.value=S.stepMult; inp.className="cmpinp"; inp.title="своё значение (Enter)";
  inp.onkeydown=(ev)=>{ if(ev.key==="Enter"){ const v=parseInt(inp.value,10); if(v>0){ setStepMult(v); closeCompressMenu(); } } };
  m.appendChild(inp);
  for(const v of [1,2,5,10,20,50,100,1000]){ const b=document.createElement("button"); b.textContent="×"+v;
    if(v===S.stepMult) b.className="on"; b.onclick=()=>{ setStepMult(v); closeCompressMenu(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect(); m.style.left=Math.round(r.left)+"px"; m.style.top=Math.round(r.bottom+2)+"px";
  setTimeout(()=>document.addEventListener("mousedown",_cmpOutside,true),0);
  inp.focus(); inp.select();
}
function _cmpOutside(e){ const m=$("cmpmenu"); if(m && !m.contains(e.target)) closeCompressMenu(); }
function closeCompressMenu(){ const m=$("cmpmenu"); if(m) m.remove(); document.removeEventListener("mousedown",_cmpOutside,true); }
// контекст-меню кластеров (правый клик) — выбор таймфрейма, как в MetaScalp
function showCluMenu(x,y){
  closeCluMenu();
  const m=document.createElement("div"); m.className="clumenu"; m.id="clumenu";
  for(const [lbl,v] of [["30с",0.5],["1м",1],["5м",5],["10м",10],["15м",15],["30м",30],["1ч",60],["1д",1440]]){
    const b=document.createElement("div"); b.className="clumi"+(S.cluTF===v?" on":""); b.textContent=lbl;
    b.onclick=()=>{ S.cluTF=v; _fpSig=""; renderFootprint(); renderDelta(); if(typeof saveCurrent==="function") saveCurrent(); closeCluMenu(); };
    m.appendChild(b); }
  document.body.appendChild(m);
  m.style.left=Math.round(Math.min(window.innerWidth-130,x))+"px"; m.style.top=Math.round(Math.min(window.innerHeight-280,y))+"px";
  setTimeout(()=>document.addEventListener("mousedown",_cluOutside,true),0);
}
function _cluOutside(e){ const m=$("clumenu"); if(m && !m.contains(e.target)) closeCluMenu(); }
function closeCluMenu(){ const m=$("clumenu"); if(m) m.remove(); document.removeEventListener("mousedown",_cluOutside,true); }
// меню «+ Добавить»: что добавить в рабочее пространство (как вкладка «+» в MetaScalp)
function showAddMenu(anchor){
  closeAddMenu();
  const sym=S.symbol||"XAUT_USDT";
  const items=[
    ["➕ Отдельный стакан (окно)", ()=>addOrderbookWindow()],
    ["➕ Отдельный скринер (окно)", ()=>addScreenerWindow()],
    ["График (плавающий)", ()=>{ if(window.popOutChart) popOutChart(); if(window.openChart) openChart(sym); }],
    ["Стакан + график сверху", ()=>{ if(window.openChart) openChart(sym); if(window.embedChart) embedChart("top"); }],
    ["Стакан + график снизу", ()=>{ if(window.openChart) openChart(sym); if(window.embedChart) embedChart("bottom"); }],
    ["Лента сделок", ()=>{ const b=$("tapebtn"); if(b) b.click(); }],
    ["Скринер", ()=>{ const b=$("scrbtn"); if(b) b.click(); }],
    ["Вочлист", ()=>{ const b=$("watchbtn"); if(b) b.click(); }],
    ["— — —", null],
    ["⬇ Экспорт раскладки", ()=>exportLayout()],
    ["⬆ Импорт раскладки", ()=>importLayout()],
  ];
  const m=document.createElement("div"); m.className="addmenu"; m.id="addmenu";
  for(const [lbl,fn] of items){ const b=document.createElement("div"); b.className="addmi"+(fn?"":" addsep"); b.textContent=lbl;
    if(fn) b.onclick=()=>{ fn(); closeAddMenu(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect(); m.style.left=Math.round(r.left)+"px"; m.style.top=Math.round(r.bottom+3)+"px";
  setTimeout(()=>document.addEventListener("mousedown",_addOutside,true),0);
}
function _addOutside(e){ const m=$("addmenu"); if(m && !m.contains(e.target) && e.target!==$("addbtn")) closeAddMenu(); }
function closeAddMenu(){ const m=$("addmenu"); if(m) m.remove(); document.removeEventListener("mousedown",_addOutside,true); }
// экспорт/импорт всей раскладки рабочего пространства (конфиг + окна + темы + вкладки + вочлист + скринер)
const _LAYOUT_KEYS=["gc_dom_cur","ourbit.dock.v1","ourbit.themes.v1","symtabs","wl","scr.cfg","scr.tpls","gc_dom_tpl"];
function exportLayout(){
  const dump={}; for(const k of _LAYOUT_KEYS){ const v=localStorage.getItem(k); if(v!=null) dump[k]=v; }
  const blob=new Blob([JSON.stringify(dump,null,1)],{type:"application/json"});
  const url=URL.createObjectURL(blob), a=document.createElement("a"); a.href=url; a.download="squad-layout.json"; a.click(); URL.revokeObjectURL(url);
}
function importLayout(){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="application/json";
  inp.onchange=()=>{ const f=inp.files[0]; if(!f) return; const fr=new FileReader();
    fr.onload=()=>{ try{ const d=JSON.parse(fr.result);
      for(const k of _LAYOUT_KEYS){ if(d[k]!=null) localStorage.setItem(k,d[k]); }
      location.reload(); }catch(e){ alert("Некорректный файл раскладки"); } };
    fr.readAsText(f); };
  inp.click();
}
// ОТДЕЛЬНЫЙ стакан = независимый экземпляр в iframe (своя монета/поток), плавающее окно в рабочем пространстве
let _domN=0;
function addOrderbookWindow(){
  _domN++; const n=_domN;
  const w=document.createElement("div"); w.className="wbwin domwin"; w.style.cssText="left:"+(40+n*24)+"px;top:"+(70+n*24)+"px;width:540px;height:620px";
  const title=document.createElement("div"); title.className="wbtitle domdrag";
  title.innerHTML='<span class="wbcoin">СТАКАН '+n+'</span><span style="color:var(--muted)">· отдельный</span><span class="wbsp"></span>';
  const x=document.createElement("button"); x.className="wbx"; x.textContent="×"; x.onmousedown=(e)=>e.stopPropagation(); x.onclick=()=>w.remove(); title.appendChild(x);
  const body=document.createElement("div"); body.className="wbbody";
  const fr=document.createElement("iframe"); fr.className="domframe"; fr.src="/?dom=1"; body.appendChild(fr);
  const res=document.createElement("div"); res.className="wbresize";
  w.append(title,body,res); document.body.appendChild(w);
  if(window.Dock) window.Dock.makeWindow({ win:w, handle:title, titleBar:title, resize:res, key:"dom"+n, minW:340, minH:300 });
}
// ОТДЕЛЬНЫЙ скринер = независимый экземпляр в iframe (своя раскладка/фильтры), плавающее окно
let _scrN=0;
function addScreenerWindow(){
  _scrN++; const n=_scrN;
  const w=document.createElement("div"); w.className="wbwin domwin"; w.style.cssText="left:"+(60+n*24)+"px;top:"+(90+n*24)+"px;width:760px;height:560px";
  const title=document.createElement("div"); title.className="wbtitle domdrag";
  title.innerHTML='<span class="wbcoin">📊 СКРИНЕР '+n+'</span><span style="color:var(--muted)">· отдельный</span><span class="wbsp"></span>';
  const x=document.createElement("button"); x.className="wbx"; x.textContent="×"; x.onmousedown=(e)=>e.stopPropagation(); x.onclick=()=>w.remove(); title.appendChild(x);
  const body=document.createElement("div"); body.className="wbbody";
  const fr=document.createElement("iframe"); fr.className="domframe"; fr.src="/?screener=1"; body.appendChild(fr);
  const res=document.createElement("div"); res.className="wbresize";
  w.append(title,body,res); document.body.appendChild(w);
  if(window.Dock) window.Dock.makeWindow({ win:w, handle:title, titleBar:title, resize:res, key:"scrwin"+n, minW:420, minH:300 });
}
const THEMES=["dark","mid","light"];
function applyTheme(t){ S.theme=t; document.body.className=(t==="dark"?"":"theme-"+t); }
function compress(dir){ const i=STEP_MULTS.indexOf(S.stepMult);
  setStepMult(STEP_MULTS[Math.max(0,Math.min(STEP_MULTS.length-1,i+dir))]); }

// ─────────── стакан (закреплён справа): заполненность + цена ───────────
// СТАБИЛИЗАЦИЯ ТОПА КНИГИ: не двигать отображаемый лучший бид/аск на транзиентах (<holdMs);
// реальное движение (≥3 тиков) — сразу. Гасит «телепорт» подсветки бид/аск на микро-шуме.
function stabTop(raw, isBid){
  const key=isBid?'_sbb':'_sba', ck=isBid?'_sbbC':'_sbaC', ct=isBid?'_sbbCt':'_sbaCt';
  const now=(window.performance?performance.now():Date.now()), hold=S.topHold||150;
  if(S[key]==null){ S[key]=raw; S[ck]=raw; S[ct]=now; return raw; }
  if(raw===S[key]){ S[ck]=raw; S[ct]=now; return raw; }                 // не изменился — держим
  if(Math.abs(raw-S[key])>=3){ S[key]=raw; S[ck]=raw; S[ct]=now; return raw; }  // реальное движение — сразу
  if(S[ck]!==raw){ S[ck]=raw; S[ct]=now; return S[key]; }               // новый кандидат — начинаем ждать
  if(now-S[ct]>=hold){ S[key]=raw; return raw; }                        // кандидат устоял holdMs — коммитим
  return S[key];                                                        // держим прежний (гасим мигание)
}
function renderLadder(){
  const d=S.depth; if(!d||!d.bids.length||!d.asks.length){ status("err","нет стакана"); return; }
  const step=S.step, tick=S.tick, dec=S.dec, sk=(p)=>Math.round(p/step);
  // ИСТИННЫЙ КРАЙ КНИГИ: лучший бид = МАКС цена бидов, лучший аск = МИН цена асков (строго > бида).
  // Иначе стеклый уровень внутри спреда (после диффов bids[0]/asks[0] ≠ край) «повисает» между бид и аск.
  // МИН аск, затем МАКС бид СТРОГО НИЖЕ аска → пересечение (бид на аске) невозможно, даже при кривой книге
  let bestAsk=0; for(let j=0;j<d.asks.length;j++){ const a=d.asks[j]; if(a[1]>0 && (bestAsk===0||a[0]<bestAsk)) bestAsk=a[0]; }
  let bestBid=0; for(let j=0;j<d.bids.length;j++){ const b=d.bids[j]; if(b[1]>0 && b[0]>bestBid && (bestAsk===0||b[0]<bestAsk)) bestBid=b[0]; }
  if(!bestBid) bestBid=(d.bids[0]&&d.bids[0][0])||0; if(!bestAsk) bestAsk=(d.asks[0]&&d.asks[0][0])||bestBid;
  const mid=(bestBid+bestAsk)/2;
  const cls=(S.lastMid==null)?"":(mid>S.lastMid?"up":mid<S.lastMid?"down":""); S.lastMid=mid;
  const pn=$("price"); pn.textContent=mid.toFixed(dec); pn.className="price-now "+cls;
  // СПРЕД В ТИКАХ + гейт входа: подсвечиваем зелёным когда спред достаточно широк для сбора (≥ порога)
  const spr=bestAsk-bestBid, sprT=Math.max(0,Math.round(spr/S.tick)), sprEl=$("spread");
  if(sprEl){ sprEl.textContent=`спред ${sprT}т · ${(spr/mid*100).toFixed(3)}%`;
    sprEl.className = "spread"+(sprT>=(S.spreadGate||3) ? " wide" : ""); }

  let rawBb=sk(bestBid), rawBa=sk(bestAsk);
  if(rawBa<=rawBb) rawBa=rawBb+1;                 // после округления по шагу совпали/пересеклись → аск строго на уровень выше бида
  let bbS=rawBb, baS=rawBa;
  if(S.topStab!==false){ bbS=stabTop(rawBb,true); baS=stabTop(rawBa,false);
    if(bbS>=baS){ bbS=rawBb; baS=rawBa; S._sbb=rawBb; S._sba=rawBa; } }   // стаб пересеклась → откат на сырое
  if(baS<=bbS) baS=bbS+1;                          // финальная гарантия: аск ВСЕГДА выше бида (нет наложения)
  const midS=Math.round((rawBb+rawBa)/2);   // центр сетки — по СЫРОМУ топу (правдивый), стабилизация только для подсветки
  // ценовая сетка: якорь на текущей цене при инициализации / по запросу центровки (клавиша) / у края
  if(S.centerS==null || S._centerReq){ S.centerS=midS; }
  else if(Math.abs(midS-S.centerS) > S.range-30){
    const _d=midS-S.centerS; S.centerS=midS;
    const _sc=$("scroller"); if(_sc) _sc.scrollTop += _d*rowPitch();   // сдвиг сетки гасим сдвигом прокрутки
    // ФИКС ТЕНЕЙ: при ре-якоре сетки сбрасываем детект проедания — иначе на старых уровнях остаются призраки-вспышки
    if(S._pv) S._pv.clear(); if(S._flash) S._flash.clear();
  }
  const centerS=S.centerS, RANGE=S.range, topS=centerS+RANGE, botS=centerS-RANGE, cfg=CFG[S.unit];
  const n=topS-botS+1, rH=ROW_PX;
  S.geo={topS,botS,rowH:rH,h:n*rH}; S._rowPitch=rH; S._yOff=0;
  // ТИПИЗИРОВАННЫЕ МАССИВЫ (индекс i=topS−s): книга бид/аск + проторгованное. Переиспользуются, .fill(0) без GC.
  if(!S._bid || S._bid.length!==n){ S._bid=new Float64Array(n); S._ask=new Float64Array(n); S._exe=new Float64Array(n); }
  const BID=S._bid, ASK=S._ask, EXE=S._exe; BID.fill(0); ASK.fill(0); EXE.fill(0);
  for(let j=0;j<d.bids.length;j++){ const i=topS-Math.round(d.bids[j][0]/step); if(i>=0&&i<n) BID[i]+=d.bids[j][1]; }
  for(let j=0;j<d.asks.length;j++){ const i=topS-Math.round(d.asks[j][0]/step); if(i>=0&&i<n) ASK[i]+=d.asks[j][1]; }
  // ВАЛИДАЦИЯ СТАБИЛИЗАЦИИ: удержанный лучший бид/аск показываем ТОЛЬКО пока на нём есть объём.
  // Уровень опустел (заявку сняли / цена ушла) → отпускаем на сырой, иначе подсветка «застревает» в пустом спреде.
  if(S.topStab!==false){
    const bi=topS-bbS, ai=topS-baS;
    if(bi<0||bi>=n||BID[bi]<=0){ bbS=rawBb; S._sbb=rawBb; S._sbbC=rawBb; }
    if(ai<0||ai>=n||ASK[ai]<=0){ baS=rawBa; S._sba=rawBa; S._sbaC=rawBa; }
    if(bbS>=baS){ bbS=rawBb; baS=rawBa; S._sbb=rawBb; S._sba=rawBa; }
  }
  { const _tk=S.flow.ticks||[], _tn=S.flow.now||0;
    for(let k=_tk.length-1;k>=0;k--){ const t=_tk[k]; if(_tn-t.t>1500) break; const i=topS-Math.round(t.p/step); if(i>=0&&i<n) EXE[i]+=t.v; } }
  // раз в 400мс: перцентили видимого стакана → АВТО-пороги цвета + авто-заполнение (по массивам, без Map)
  let fillBasis=cfg.fill;
  { const nowT=(window.performance?performance.now():Date.now());
    if(!S._autoT || nowT-S._autoT>400){ S._autoT=nowT;
      const vols=[]; for(let i=0;i<n;i++){ const v=BID[i]||ASK[i]; if(v>0) vols.push(unitVal(v,(topS-i)*step)); }
      if(vols.length){ vols.sort((a,b)=>b-a);
        const at=(f)=>Math.max(1,vols[Math.min(vols.length-1,Math.floor(vols.length*f))]||1);
        S._big1Auto=at(0.25); S._big2Auto=at(0.06);
        const N=Math.max(1,S.fillTopN||10),k=(S.fillMult>0?S.fillMult:1),top=vols.slice(0,Math.min(N,vols.length)),mean=top.reduce((a,b)=>a+b,0)/top.length,p=Math.max(1,mean*k);
        S._fillBasis=S._fillBasis>0?S._fillBasis+0.35*(p-S._fillBasis):p; } }
    if(S.fillAuto) fillBasis=S._fillBasis||cfg.fill; }
  // пороги цвета (одни на весь стакан)
  const _autoCol=S.colorAuto!==false;
  const _loT=_autoCol?(S._big1Auto||Math.min(cfg.big1,cfg.big2)):Math.min(cfg.big1,cfg.big2);
  const _hiT=_autoCol?(S._big2Auto||Math.max(cfg.big1,cfg.big2)):Math.max(cfg.big1,cfg.big2);
  // ── ОТРИСОВКА НА CANVAS (без DOM-строк = максимальная производительность) ──
  const LW=S.ladWidth||190, H=n*rH, dpr=window.devicePixelRatio||1, cv=$("ladcanvas");
  if(cv){
    if(cv.width!==Math.round(LW*dpr)||cv.height!==Math.round(H*dpr)){ cv.width=Math.round(LW*dpr); cv.height=Math.round(H*dpr); cv.style.width=LW+"px"; cv.style.height=H+"px"; }
    const g=cv.getContext("2d"); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,LW,H); g.textBaseline="middle";
    const PW=Math.min(84,Math.max(64,Math.round(LW*0.42))), DW=LW-PW, PX=DW, P=LAD_PAL, half=rH/2, FONT="11px ui-monospace,Consolas,monospace";
    g.fillStyle=P.bg; g.fillRect(0,0,LW,H);          // тёмно-серый фон стакана
    g.fillStyle=P.priceBg; g.fillRect(PX,0,PW,H);    // колонка цены чуть темнее
    if(!S._pv) S._pv=new Map(); if(!S._flash) S._flash=new Map();
    const pv=S._pv, fl=S._flash, nowP=(window.performance?performance.now():Date.now());
    for(let i=0;i<n;i++){
      // БЕСШОВНАЯ ТАЙЛИРОВКА: край ряда = round((i+1)*rH), высота = разница с предыдущим краем →
      // соседние полосы стыкуются пиксель-в-пиксель без «швов» (fix полосатости при дробном rH/dpr)
      const yT=Math.round(i*rH), yB=Math.round((i+1)*rH), hT=yB-yT;
      const s=topS-i, y=yT, price=s*step, isAsk=s>=baS, isBid=s<=bbS;
      const isBB=s===bbS, isBA=s===baS, isMid=isBB&&isBA;
      let vc=isAsk?ASK[i]:isBid?BID[i]:(ASK[i]||BID[i]); vc=vc||0;
      if(s>bbS && s<baS) vc=0;          // СТРОГО ВНУТРИ СПРЕДА (по ОТОБРАЖАЕМОМУ краю) → чистим, иначе стаб.подсветка рассинхрон → «застрявший» уровень
      if(vc && S.ladMinUsd>0 && unitVal(vc,price)<S.ladMinUsd) vc=0;
      const uv=vc?unitVal(vc,price):0, isWall=uv>=_hiT;
      // ДЕТЕКТ ПРОЕДАНИЯ: объём упал? traded-through (были сделки на цене) vs pulled (снятие лимитки)
      // ФИКС ТЕНЕЙ: только для уровней ВНУТРИ книги (бид/аск), не в разрыве спреда — иначе при рывке цены
      // выпавший из книги уровень даёт фантомную «серую» вспышку там, где объёма уже нет.
      const inBook = (s<=bbS)||(s>=baS);
      const prev=pv.get(s);
      if(inBook && prev!=null && vc>0 && vc < prev-Math.max(1,prev*0.05)){
        // ТОЛЬКО проедание СДЕЛКОЙ = короткая цветная вспышка. Снятие лимитки (без сделки) = мгновенно, БЕЗ серого следа.
        const traded = EXE[i] && unitVal(EXE[i],price) >= unitVal(prev-vc,price)*0.4;
        if(traded) fl.set(s,{t:nowP, k:(isAsk?1:-1)}); else fl.delete(s);
      } else if(!inBook && fl.has(s)) fl.delete(s);          // уровень ушёл в спред — гасим вспышку сразу
      pv.set(s, vc);
      const halfT=Math.round(hT/2), yc=y+hT/2;
      // фон строки: лучший бид/аск / сжатый спред
      if(isMid){ g.fillStyle=P.bidBg; g.fillRect(0,yT,LW,halfT); g.fillStyle=P.askBg; g.fillRect(0,yT+halfT,LW,hT-halfT); }
      else if(isBB){ g.fillStyle=P.bidBg; g.fillRect(0,yT,LW,hT); }
      else if(isBA){ g.fillStyle=P.askBg; g.fillRect(0,yT,LW,hT); }
      // ВСПЫШКА ТОЛЬКО проедания сделкой (цвет стороны, затухание 300мс). Серой «pulled»-вспышки больше нет.
      const f=fl.get(s);
      if(f){ const age=nowP-f.t;
        if(age<300){ const a=(1-age/300)*0.5;
          g.fillStyle=(f.k>0?P.flashBuy:P.flashSell)+a.toFixed(3)+")"; g.fillRect(0,yT,DW,hT); }
        else fl.delete(s); }
      // полоса плотности (янтарь; стена ярче) + айсберг + число — БЕЗ inset: соседние полосы сливаются в сплошной блок
      if(vc){ const barW=Math.max(6,Math.min(DW,uv/fillBasis*DW));
        g.fillStyle=isWall?P.barWall:P.bar; g.fillRect(0,yT,barW,hT);   // числа+полоса вместе слева, растёт вправо к цене
        if(uv>=_loT){ const ex=EXE[i]; if(ex && unitVal(ex,price)>=uv*1.2){ g.fillStyle=P.ice; g.fillRect(0,yT,4,hT); } }
        g.fillStyle=isWall?P.txtBig:P.txtNorm; g.textAlign="left"; g.font=FONT; g.fillText(fmt(uv),5,yc); }
      // цена (пилюля на лучшем биде/аске; жирная на осн. уровнях)
      const tnorm=Math.round(price/tick), isMain=tnorm%S.mainMult===0, isMidL=tnorm%S.midMult===0;
      let ptc;
      if(isMid){ g.fillStyle=P.bidPill; g.fillRect(PX,yT,PW,halfT); g.fillStyle=P.askPill; g.fillRect(PX,yT+halfT,PW,hT-halfT); ptc="#07090d"; }
      else if(isBB){ g.fillStyle=P.bidPill; g.fillRect(PX,yT,PW,hT); ptc="#07090d"; }
      else if(isBA){ g.fillStyle=P.askPill; g.fillRect(PX,yT,PW,hT); ptc="#07090d"; }
      else ptc=isMain?P.priceMain:isMidL?P.priceMid:P.price;
      g.fillStyle=ptc; g.font=(isMain||isBB||isBA||isMid?"bold 11px":"11px")+" ui-monospace,Consolas,monospace"; g.textAlign="center"; g.fillText(fmtPrice(price,dec),PX+PW/2,yc);
    }
    // ── ХОВЕР-ЛИНЕЙКА НА ВСЮ ШИРИНУ (как MetaScalp): плашка ряда + crosshair + процент-бейдж ──
    if(S.hover!=null){
      const hs=Math.round(S.hover/step), hi=topS-hs;
      if(hi>=0 && hi<n){
        const yT=Math.round(hi*rH), hT=Math.round((hi+1)*rH)-yT, price=hs*step;
        g.fillStyle=P.rulerBand; g.fillRect(0,yT,LW,hT);                       // полупрозрачная плашка на всю ширину (текст читаем)
        const yc=Math.round(yT+hT/2)+0.5;                                       // тонкий crosshair по центру ряда
        g.strokeStyle=P.rulerLine; g.lineWidth=1; g.beginPath(); g.moveTo(0,yc); g.lineTo(LW,yc); g.stroke();
        const vc=(hs>=baS?ASK[hi]:hs<=bbS?BID[hi]:(ASK[hi]||BID[hi]))||0, uv=vc?unitVal(vc,price):0;
        S._hovPc=Math.abs((price-mid)/mid*100).toFixed(2).replace(".",",")+"%"+(uv?" "+fmt(uv):"");
        S._hovY=Math.round(yT+hT/2);                     // бейдж рисуем DOM-плашкой СЛЕВА от стакана (не поверх баров)
      } else S._hovPc=null;
    } else S._hovPc=null;
    if(fl.size) S._render=true;   // пока есть активные вспышки — продолжаем перерисовку для плавного затухания
    // MARK PRICE: тонкая линия на шкале, подпись MP — DOM-плашкой слева
    S._mpY=null;
    if(S.markPrice>0){ const my=Math.round((topS-S.markPrice/step+0.5)*rH); if(my>=0&&my<=H){
      g.strokeStyle="rgba(120,160,230,.7)"; g.setLineDash([2,4]); g.lineWidth=1; g.beginPath(); g.moveTo(0,my+0.5); g.lineTo(LW,my+0.5); g.stroke(); g.setLineDash([]);
      S._mpY=my; S._mpTxt="MP "+S.markPrice.toFixed(dec); } }
    // СИГНАЛЬНЫЕ УРОВНИ (алерты): пунктирная линия + колокол на заданной цене (Ctrl+клик по стакану)
    const alerts=(S._alerts&&S._alerts[S.symbol])||[];
    for(const ap of alerts){ const yy=Math.round((topS-ap/step+0.5)*rH); if(yy>=0&&yy<=H){
      g.strokeStyle="rgba(230,169,67,.85)"; g.setLineDash([4,3]); g.lineWidth=1; g.beginPath(); g.moveTo(0,yy+0.5); g.lineTo(LW,yy+0.5); g.stroke(); g.setLineDash([]);
      g.fillStyle="#e6a943"; g.font="10px Verdana,sans-serif"; g.textAlign="left"; g.fillText("🔔"+ap.toFixed(dec), 3, yy-2); } }
    // проверка пересечения ценой → звук (один раз на пересечение)
    if(alerts.length && S._lastAlertMid!=null){
      for(const ap of alerts){ if((S._lastAlertMid<ap && mid>=ap)||(S._lastAlertMid>ap && mid<=ap)){
        try{ if(typeof beep==="function") beep(mid>=ap?1:2, true); }catch(e){}
        try{ if(window.notify) notify("🔔 "+S.symbol.replace("_USDT","")+" достиг "+ap.toFixed(dec), "alert"); }catch(e){} } }
    }
    S._lastAlertMid=mid;
    // маркеры позиции/ордеров (из trade.js)
    if(typeof T!=="undefined"){
      const _allpos=(T.allpos&&T.allpos.length)?T.allpos:(T.pos?[T.pos]:[]);
      const _cur=[], _other=[];
      for(const P of _allpos){ if(!(P.vol>0)) continue; ((!P.symbol||P.symbol===S.symbol)?_cur:_other).push(P); }
      if(_cur.length || _other.length){                     // зоны рисуем ТОЛЬКО для текущей монеты; позы др.монет — только счётчик в плашке
        let _tVal=0,_tPnl=0; const _cs=S.contractSize||1;
        for(const P of _cur){ if(!(P.avg>0)) continue;
          const long=P.side===1, avg=P.avg, rtPnl=(mid-avg)*P.vol*_cs*(long?1:-1);
          _tVal+=P.vol*_cs*mid; _tPnl+=rtPnl;
          const ey=Math.round((topS-avg/step+0.5)*rH), cy=Math.round((topS-mid/step+0.5)*rH);
          const zt=Math.max(0,Math.min(ey,cy)), zb=Math.min(H,Math.max(ey,cy));
          if(zb>zt){ g.fillStyle=rtPnl>=0?"rgba(63,224,122,.28)":"rgba(255,95,89,.28)"; g.fillRect(0,zt,LW,zb-zt); }
        }
        const _oPnl=_other.reduce((s,p)=>s+(p.pnl||0),0);
        const _pts=_cur[0]?((mid-_cur[0].avg)/(S.tick||0.01))*(_cur[0].side===1?1:-1):0;   // PnL в тиках
        S._posRT=(_cur.length||_other.length)?{cnt:_cur.length, other:_other.length, val:_tVal, pnl:_tPnl+_oPnl,
                  pts:_pts, pct:(_tVal?_tPnl/_tVal*100:0), entry:(_cur[0]?_cur[0].avg:0), long:(_cur[0]?_cur[0].side===1:true)}:null;
      } else S._posRT=null;
      // нижняя плашка позиции под стаканом: цена входа | объём$ | PnL$ (реальное время)
      const _pb=$("posbar");
      if(_pb){ if(S._posRT){ const q=S._posRT; _pb.style.display="flex";
        const pe=$("pb-entry"), pvv=$("pb-val"), pl=$("pb-pnl");
        if(pe) pe.textContent = q.other ? (q.cnt+"+"+q.other+" поз") : (q.cnt>1?(q.cnt+" поз"):(q.entry?q.entry.toFixed(dec):"—"));
        if(pvv) pvv.textContent=Math.round(q.val)+"$";
        if(pl){ const fmt=S.pnlFmt||"usd";
          const txt = fmt==="points" ? ((q.pts>=0?"+":"")+Math.round(q.pts)+"т")
                    : fmt==="percent" ? ((q.pct>=0?"+":"")+q.pct.toFixed(2)+"%")
                    : ((q.pnl>=0?"+":"")+q.pnl.toFixed(2)+"$");
          pl.textContent=txt; pl.className="pb-pnl "+(q.pnl>=0?"pos":"neg"); }
      } else _pb.style.display="none"; }
      S._ordHit=[];                                         // зоны красного × для клик-отмены
      let _obN=0,_obUsd=0,_osN=0,_osUsd=0; const _ocs=S.contractSize||1;   // суммы лимиток (ВСЕ, вкл. вне экрана)
      for(const o of (T.orders||[])){                       // МОИ лимитки в стакане (как MetaScalp): яркая пилюля с объёмом поверх цены + красный × справа
        const buy=(o.side===1||o.side===2), _u=(o.price||0)*(o.vol||0)*_ocs;
        if(buy){_obN++;_obUsd+=_u;} else {_osN++;_osUsd+=_u;}   // накопить суммы до фильтра видимости
        const os=Math.round((o.price||0)/step), yy=Math.round((topS-os)*rH);
        if(yy<-rH||yy>H) continue;
        const yc=yy+rH/2;
        // ВЫДЕЛЕНИЕ ВСЕЙ СТРОКИ на уровне заявки (заливка + рамка на всю ширину)
        g.fillStyle=buy?"rgba(63,224,122,.15)":"rgba(255,95,89,.13)"; g.fillRect(0, yy+1, LW-1, rH-2);
        g.strokeStyle=buy?"rgba(63,224,122,.75)":"rgba(255,95,89,.7)"; g.lineWidth=1;
        g.strokeRect(0.5, yy+1.5, LW-2, rH-3);
        const vtxt=(typeof fmt==="function"&&typeof unitVal==="function")?fmt(unitVal(o.vol||0,o.price||0)):(""+Math.round(o.vol||0));   // объём в ВЫБРАННОЙ единице ($/coin/контр.), как весь стакан — чтобы $20 показывался как 20, не 156 контрактов
        g.font="bold 11px ui-monospace,Consolas,monospace"; g.textAlign="center"; g.textBaseline="middle";
        const tw=g.measureText(vtxt).width, xr=LW-16;       // правый край пилюли (16px под красный ×)
        const pw=Math.ceil(tw)+12, ph=Math.min(rH-2,16), px0=xr-pw, py0=Math.round(yc-ph/2);
        g.fillStyle=buy?"#3fe07a":"#ff5f59";                // яркая пилюля: зелёная buy / красная sell
        g.beginPath(); (g.roundRect?g.roundRect(px0,py0,pw,ph,3):g.rect(px0,py0,pw,ph)); g.fill();
        g.fillStyle=buy?"#04120a":"#1a0605";                // объём тёмным жирным поверх пилюли
        g.fillText(vtxt, px0+pw/2, yc+0.5);
        g.fillStyle="#ff3b30"; g.font="bold 13px sans-serif"; g.fillText("×", LW-7, yc+0.5);   // красный × отмена
        g.textBaseline="alphabetic";                        // вернуть базовую линию для остального рендера
        S._ordHit.push({id:o.id, y1:yy, y2:yy+rH});
      }
      // нижняя плашка СУММ ЛИМИТОК (на какую сумму стоят заявки в стакане — чтоб не запутаться)
      const _ob=$("ordbar");
      if(_ob){
        const grp=(u)=>(""+Math.round(u)).replace(/\B(?=(\d{3})+(?!\d))/g," ");
        const sig=_obN+"/"+Math.round(_obUsd)+"/"+_osN+"/"+Math.round(_osUsd);
        if(sig!==S._obSig){ S._obSig=sig;
          const has=(_obN+_osN)>0; _ob.style.display=has?"flex":"none";
          if(has){ const bb=$("ob-buy"), ss=$("ob-sell");
            if(bb) bb.textContent=_obN?`BUY ${_obN} · $${grp(_obUsd)}`:"—";
            if(ss) ss.textContent=_osN?`SELL ${_osN} · $${grp(_osUsd)}`:"—";
          }
        }
      }
    }
  }
  S.bestBid=bestBid; S.bestAsk=bestAsk; S.baS=baS; S.bbS=bbS;
  // ЛИНЕЙКА USDT (зажать L + тянуть): суммарный объём бид+аск в выделенном диапазоне цен
  if(S._ruler){
    const _rc=S.contractSize||1, sHi=Math.max(S._ruler.a,S._ruler.b), sLo=Math.min(S._ruler.a,S._ruler.b);
    let sumUsd=0;
    for(let s=sLo;s<=sHi;s++){ const i=topS-s; if(i<0||i>=n) continue; const v=(BID[i]||0)+(ASK[i]||0); if(v) sumUsd+=v*_rc*(s*step); }
    const yHi=Math.round((topS-sHi)*rH), yLo=Math.round((topS-sLo+1)*rH);
    g.fillStyle="rgba(120,170,255,.12)"; g.fillRect(0,yHi,LW,yLo-yHi);
    g.strokeStyle="rgba(120,170,255,.6)"; g.lineWidth=1; g.strokeRect(0.5,yHi+0.5,LW-1,Math.max(1,yLo-yHi-1));
    const lbl="Σ "+(typeof fmt==="function"?fmt(sumUsd):Math.round(sumUsd))+"$";
    g.font="bold 11px Arial,sans-serif"; g.textAlign="center"; g.textBaseline="middle";
    const tw=Math.ceil(g.measureText(lbl).width)+10, by=Math.round((yHi+yLo)/2-8);
    g.fillStyle="rgba(50,80,150,.95)"; g.fillRect(LW/2-tw/2,by,tw,16);
    g.fillStyle="#dce8ff"; g.fillText(lbl,LW/2,by+8); g.textBaseline="alphabetic"; g.textAlign="left";
  }
  // ЦЕНТРОВКА ПО КЛАВИШЕ + АВТО-ЦЕНТРОВКА С ГИСТЕРЕЗИСОМ (опция, для волатильности)
  const sc=$("scroller");
  if(sc && S.autoCenter && !S._centerReq && (window.performance?performance.now():Date.now())-(S._userScrollT||0)>2500){
    const centerRow=(sc.scrollTop+sc.clientHeight/2)/rH, midRow=topS-midS, bandRows=(sc.clientHeight/rH)*0.28;
    if(Math.abs(midRow-centerRow)>bandRows) S._centerReq=true;   // цена ушла >28% высоты от центра → до-центрировать
  }
  if(S._centerReq){ S._centerReq=false; sc.scrollTop=(topS-midS+0.5)*rH - sc.clientHeight/2; }
  renderFootprint();
  positionLots();                 // панель лотов едет вместе с кластерами
  positionLadderLabels();         // % ховера и MP — плашками СЛЕВА от стакана (не поверх баров)
  status("live","в эфире");
}
// плашки слева от стакана: процент наведения + Mark Price (вне канваса, чтобы не перекрывать бары)
function positionLadderLabels(){
  if(!_geo){ refreshGeo(); if(!_geo) return; }
  const rightAnchor=Math.round(window.innerWidth-_geo.ladL+2);   // якорь по правому краю → без чтения offsetWidth (0 рефлоу)
  let hp=$("hovpct"); if(!hp){ hp=document.createElement("div"); hp.id="hovpct"; hp.className="edgelbl"; document.body.appendChild(hp); }
  if(S._hovPc!=null){ if(hp._t!==S._hovPc){ hp.textContent=S._hovPc; hp._t=S._hovPc; } hp.style.display="block";
    hp.style.top=Math.round(_geo.ladT+S._hovY-9)+"px"; hp.style.left="auto"; hp.style.right=rightAnchor+"px"; }
  else if(hp.style.display!=="none") hp.style.display="none";
  let mp=$("mplbl"); if(!mp){ mp=document.createElement("div"); mp.id="mplbl"; mp.className="edgelbl mp"; document.body.appendChild(mp); }
  if(S._mpY!=null){ if(mp._t!==S._mpTxt){ mp.textContent=S._mpTxt; mp._t=S._mpTxt; } mp.style.display="block";
    mp.style.top=Math.round(_geo.ladT+S._mpY-8)+"px"; mp.style.left="auto"; mp.style.right=rightAnchor+"px"; }
  else if(mp.style.display!=="none") mp.style.display="none";
}
// палитра стакана для canvas — как MetaScalp: тёмно-серый фон, ЯНТАРНЫЕ полосы плотности (сторона по положению)
const LAD_PAL={ bg:"#2b2f36", priceBg:"#23262c",
  bar:"#7f5d36", barWall:"#e8ac52",         // плотность / стена — СПЛОШНЫЕ (alpha=1, без призраков, как MetaScalp)
  txtNorm:"#cfd4da", txtBig:"#ffe0b0",
  bidBg:"rgba(46,166,91,.42)", askBg:"rgba(231,76,60,.42)", bidPill:"#2ecc71", askPill:"#ff5b6e",
  price:"#cfd4da", priceMain:"#ffffff", priceMid:"#e6e8ea", ice:"#4aa8e0", hoverBadge:"#5b3fd6",
  rulerBand:"rgba(180,190,210,0.13)", rulerLine:"rgba(205,214,228,0.5)",   // ховер-линейка на всю ширину
  flashBuy:"rgba(70,230,130,", flashSell:"rgba(255,95,89,", flashPull:"rgba(150,160,175,",
  // график и лента (читаются chart.js / tape.js — тема применяется и к ним)
  candleUp:"#2ea043", candleDown:"#e0524d", chartText:"#5b6573", chartGrid:"rgba(255,255,255,0.05)", chartLast:"#e6a943",
  tapeBuy:"#2ea043", tapeSell:"#e0524d" };
window.LAD_PAL=LAD_PAL;   // доступ для chart.js/tape.js/theme.js

// стакан на canvas — заглушки для совместимости со старым кодом (пул строк больше не нужен)
let POOL=[];
function buildPool(){}
function measureRowPitch(){}
function rowPitch(){ return S._rowPitch || ROW_PX; }

// ─────────── футпринт (время×цена) + тики на canvas ───────────
let _fpSig="";
function renderFootprint(){
  const {topS,botS,rowH,h}=S.geo; if(!h) return;
  const cfg=CFG[S.unit], step=S.step;
  // ТФ<1мин (30с=0.5) → строим из тиков; иначе серверные минутные бакеты
  const fp=(S.cluTF<1)?buildFpFromTicks(Math.round((S.cluTF||0.5)*60)):groupFootprint(S.flow.footprint||[], S.cluTF), L=fp.length;
  if(S.hideFp){ const cv=$("fpcanvas"); if(cv.width){cv.width=0;} $("grid").style.width=""; return; }
  // пропускаем перерисовку холста, если данные/геометрия не изменились (экономия CPU при 60fps)
  // перерисовка холста при изменении данных (25Гц по быстрым тикам) — как было, ровно и без статтера
  const _psig=(typeof T!=="undefined")?((T.allpos&&T.allpos.length?T.allpos:(T.pos?[T.pos]:[])).map(p=>p.side+":"+p.vol+":"+p.avg).join(",")):"";
  const sig=S.flow.now+"|"+topS+"|"+botS+"|"+step+"|"+S.fpWidth+"|"+S.fpTotal+"|"+S.unit+"|"+S.cluMode+"|"+S.cluTF+"|"+S.tickAgg+"|"+rowH.toFixed(2)+"|"+S.baS+"|"+S.bbS+"|"+(S.showVP!==false)+"|"+(S.showCols!==false)+"|"+_psig;
  if(sig===_fpSig) return; _fpSig=sig;
  // S.fpWidth = ширина кластеров (ручка тянет её, до 0); лента = широкий тик-график (как MetaScalp)
  // ФИКСИРОВАННАЯ общая зона (кластера+лента) = W. Кластера растут ВНУТРИ неё за счёт ленты → СТАКАН НЕ ДВИГАЕТСЯ.
  const total=Math.max(120, S.fpTotal||380);
  const fpW=Math.max(0, Math.min(total, S.fpWidth||0)), tapeW=total-fpW, W=total;
  const cv=$("fpcanvas");
  if(cv.width!==W||cv.height!==h){ cv.width=W; cv.height=h; }
  const g=cv.getContext("2d"); g.clearRect(0,0,W,h);
  g.font="9px Verdana,Geneva,sans-serif"; g.textBaseline="middle";
  // сдвигаем всю отрисовку на выравнивающий offset → строка холста ровно напротив строки стакана
  const _yOff=Math.abs(S._yOff||0)<rowH*2 ? (S._yOff||0) : 0;   // защита от абсурдных значений
  g.save(); g.translate(0, _yOff);

  // ── футпринт: УЗКИЕ колонки по времени, новые справа, история уходит влево (тумблер S.showCols) ──
  const colW = COL_W;
  // ЯКОРЬ ПО АБСОЛЮТНОМУ ВРЕМЕНИ бакета (а не по числу колонок L) → добавление/выпадение колонки НЕ двигает остальные (фикс мигания на 30с)
  const newestT = L ? fp[L-1].t : 0, colStep = (S.cluTF<1) ? 1 : (S.cluTF||1);
  if(S.showCols!==false) for(let j=0;j<L;j++){
    const x=fpW-(Math.round((newestT-fp[j].t)/colStep)+1)*colW;   // позиция от времени бакета (новейшая справа)
    if(x<-colW || x>fpW) continue;
    const col=fp[j].cells, agg=new Map();
    for(const tStr in col){ const price=parseInt(tStr,10)*S.tick, s=Math.round(price/step);
      const a=agg.get(s)||[0,0], c=col[tStr]; a[0]+=c[0]; a[1]+=c[1]; agg.set(s,a); }
    // POC: уровень с максимальным объёмом за период — чёрная обводка (как в MetaScalp)
    let maxS=null, maxTot=0;
    for(const [s,[bv,sv]] of agg){ const t=bv+sv; if(t>maxTot){ maxTot=t; maxS=s; } }
    const mode=S.cluMode||"delta";
    for(const [s,[bv,sv]] of agg){ if(s>topS||s<botS) continue;
      const y=(topS-s)*rowH, tot=bv+sv; if(tot<=0) continue;
      const uv=unitVal(tot, s*step), net=bv-sv;
      const a=Math.min(0.8, 0.12+uv/cfg.cluFill*0.8);
      if(mode==="bs"){
        // Buy×Sell: ячейка делится — покупки (зелёная слева) + продажи (красная справа), ширина ∝ объёму стороны
        const bw=(colW-2)*(bv/tot);
        g.fillStyle=`rgba(46,160,67,${a})`; g.fillRect(x+1,y+1,bw,rowH-2);
        g.fillStyle=`rgba(224,82,77,${a})`; g.fillRect(x+1+bw,y+1,(colW-2)-bw,rowH-2);
      } else {
        g.fillStyle = net>=0 ? `rgba(46,160,67,${a})` : `rgba(224,82,77,${a})`;
        g.fillRect(x+1,y+1,colW-2,rowH-2);
      }
      if(s===maxS){ g.strokeStyle="#000"; g.lineWidth=1.5; g.strokeRect(x+1.5,y+1.5,colW-3,rowH-3); }
      // текст по режиму: Дельта=знаковая нетто, Сумма=общий объём, Buy×Sell=общий (нейтр., цвет уже в баре)
      let label, txtCol;
      if(mode==="sum"){ label=fmt(uv); txtCol=net>=0?"#9fe6b6":"#f5b3af"; }
      else if(mode==="bs"){ label=fmt(uv); txtCol="#e8edf2"; }
      else { label=(net>=0?"+":"−")+fmt(unitVal(Math.abs(net), s*step)); txtCol=net>=0?"#9fe6b6":"#f5b3af"; }
      g.fillStyle = txtCol; g.fillText(label, x+3, y+rowH/2);
    }
    g.strokeStyle="rgba(255,255,255,.05)"; g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke();
  }
  // тонкая граница футпринт/лента (без заливки — чтобы не было пустого тёмного блока)
  g.strokeStyle="rgba(255,255,255,.10)"; g.beginPath(); g.moveTo(fpW,0); g.lineTo(fpW,h); g.stroke();

  // ── VOLUME PROFILE: горизонтальный профиль объёма по ценам за период (сумма по всем колонкам) ──
  if(S.showVP!==false){
    const prof=new Map(); let maxV=0, pocS=null;
    for(let j=0;j<L;j++){ const col=fp[j].cells;
      for(const tStr in col){ const s=Math.round(parseInt(tStr,10)*S.tick/step);
        const a=prof.get(s)||[0,0], c=col[tStr]; a[0]+=c[0]; a[1]+=c[1]; prof.set(s,a); } }
    for(const [s,[bv,sv]] of prof){ const t=bv+sv; if(t>maxV){ maxV=t; pocS=s; } }
    if(maxV>0){ const vpMax=Math.max(60, tapeW*0.5);   // макс длина бара профиля (слева от ленты)
      for(const [s,[bv,sv]] of prof){ if(s>topS||s<botS) continue; const t=bv+sv; if(t<=0) continue;
        const y=(topS-s)*rowH, w=Math.max(1, t/maxV*vpMax), net=bv-sv;
        g.fillStyle = s===pocS ? "rgba(230,169,67,.55)" : (net>=0?"rgba(46,160,67,.28)":"rgba(224,82,77,.28)");
        g.fillRect(fpW, y+1, w, rowH-2); }   // от границы кластеров вправо в зону ленты (полупрозрачно — пузыри видны)
    }
  }

  // ТЕКУЩАЯ ЦЕНА на ленте: пунктирные линии лучшего бида/аска через всю зону ленты (сразу видно где цена сейчас)
  g.setLineDash([5,4]); g.lineWidth=1;
  if(S.baS){ const ya=(topS-S.baS+0.5)*rowH; if(ya>=0&&ya<=h){ g.strokeStyle="rgba(224,82,77,.55)"; g.beginPath(); g.moveTo(0,ya); g.lineTo(W,ya); g.stroke(); } }
  if(S.bbS){ const yb=(topS-S.bbS+0.5)*rowH; if(yb>=0&&yb<=h){ g.strokeStyle="rgba(46,160,67,.55)"; g.beginPath(); g.moveTo(0,yb); g.lineTo(W,yb); g.stroke(); } }
  g.setLineDash([]);

  // ── зона ленты (тики-пузыри): новые СПРАВА, старые влево ──
  const ticks=aggregateTicks(S.flow.ticks||[], S.tickAgg); const SP=30, mg=18;
  const maxN=Math.max(1,Math.floor((tapeW-mg)/SP));
  const recent=ticks.filter(tk=>unitVal(tk.v,tk.p)>=(S.tickMin||0)).slice(-maxN).reverse();  // фильтр мелких + новейшие справа
  const pts=[];
  for(let i=0;i<recent.length;i++){ const tk=recent[i]; const x=W-mg-i*SP;   // равный шаг, новые справа (как MetaScalp)
    if(x<fpW+6) break;                                   // ушли за футпринт — клип
    const ps=tk.p/step;                                  // ТОЧНАЯ цена сделки (дробная позиция)
    const y=(ps>topS+0.5||ps<botS-0.5)?null:(topS-ps+0.5)*rowH;
    pts.push([x,y,tk]); }
  // линия-траектория через центры пузырей (как у MetaScalp — путь цены по сделкам)
  const vis=pts.filter(p=>p[1]!=null);
  if(S.tickStyle!=="dots" && vis.length>1){ g.strokeStyle="rgba(185,195,210,.65)"; g.lineWidth=(S.tickLine||1.2)+0.4; g.beginPath();
    vis.forEach((p,i)=> i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1])); g.stroke(); }
  // пузыри: на СВОЕЙ цене, узкие (rx мал), высокие при крупном объёме (ry ∝ объём) — 1:1 как MetaScalp
  g.textAlign="center";
  const bigT=S.tickBig||cfg.big2;
  if(S.tickStyle!=="lines") for(let i=0;i<pts.length;i++){ const [x,y,tk]=pts[i]; if(y==null) continue; const uv=unitVal(tk.v,tk.p);
    const mag=Math.sqrt(Math.max(0,uv)/bigT);         // 1 = «крупный объём тиков»
    const rx=11+Math.min(1,mag)*8;                    // 11..19 круглый пузырь (крупные — как MetaScalp)
    const ry=Math.min(88, rx + Math.max(0,mag-1)*34); // вытягиваем в высокий эллипс ТОЛЬКО крупные (>порога)
    g.beginPath(); g.ellipse(x,y,rx,ry,0,0,6.2832);
    g.fillStyle=tk.side===1?"#2ea043":"#e0524d"; g.fill();
    g.strokeStyle=tk.side===1?"rgba(255,255,255,.3)":"rgba(255,255,255,.22)"; g.lineWidth=1.2; g.stroke();
    // шрифт подгоняем, чтобы объём влез в пузырь и читался
    const label=fmt(uv); let fs=10; g.font=fs+"px Verdana,Geneva,sans-serif";
    while(fs>7 && g.measureText(label).width>rx*2-5){ fs--; g.font=fs+"px Verdana,Geneva,sans-serif"; }
    g.fillStyle="#07090d"; g.fillText(label,x,y); }

  // ── ДЕТЕКТОР ПРОСТРЕЛА: за ~500мс одна сторона набила > порога → метка «куда стрельнуло» (для лесенки под следующий) ──
  const nowT=S.flow.now||0, pn=(window.performance?performance.now():Date.now());
  let bV=0,sV=0,hiP=-1e18,loP=1e18;
  for(let k=ticks.length-1;k>=0;k--){ const tk=ticks[k]; if(nowT-tk.t>500) break;
    const u=unitVal(tk.v,tk.p); if(tk.side===1){bV+=u; if(tk.p>hiP)hiP=tk.p;} else {sV+=u; if(tk.p<loP)loP=tk.p;} }
  const shotThr=(S.tickBig||5000)*3;
  if(bV>=shotThr && (!S._shot||pn-S._shot.lt>700||S._shot.side!==1)){ S._shot={lt:pn,price:hiP,side:1,vol:bV};
    if(pn-(S._shotN||0)>1500){ S._shotN=pn; try{ if(window.notify) notify("▲ прострел вверх "+S.symbol.replace("_USDT","")+" "+fmt(bV),"shot"); }catch(e){} } }
  else if(sV>=shotThr && (!S._shot||pn-S._shot.lt>700||S._shot.side!==2)){ S._shot={lt:pn,price:loP,side:2,vol:sV};
    if(pn-(S._shotN||0)>1500){ S._shotN=pn; try{ if(window.notify) notify("▼ прострел вниз "+S.symbol.replace("_USDT","")+" "+fmt(sV),"shot"); }catch(e){} } }
  if(S._shot){ const age=pn-S._shot.lt;
    if(age<3500){ const ps=S._shot.price/step;
      if(ps<=topS+0.5 && ps>=botS-0.5){ const y=(topS-ps+0.5)*rowH, al=0.8*(1-age/3500);
        const col=S._shot.side===1?"63,224,122":"255,95,89";
        // компактная метка у стакана (без линии через поле): короткий брусок + подпись «куда стрельнуло»
        g.fillStyle=`rgba(${col},${al.toFixed(3)})`;
        g.fillRect(W-6, y-rowH/2, 6, rowH);                       // маркер на краю (у стакана)
        g.font="bold 10px Verdana,sans-serif"; g.textAlign="right";
        g.fillText((S._shot.side===1?"▲ прострел ":"▼ прострел ")+fmt(S._shot.vol), W-10, y); g.textAlign="center"; }
    } else S._shot=null;
  }
  // МАРКЕР ПОЗИЦИИ у правого края левой панели (СЛЕВА от стакана): только число, цвет по стороне, прозрачный фон
  if(typeof T!=="undefined"){
    const _ap=(T.allpos&&T.allpos.length)?T.allpos:(T.pos?[T.pos]:[]);
    for(const P of _ap){ if(!(P.avg>0)) continue; if(P.symbol && P.symbol!==S.symbol) continue;   // бейдж только для текущей монеты
      const long=P.side===1, y=Math.round((topS - P.avg/step + 0.5)*rowH);
      if(y<-2||y>h+2) continue;
      const txt=(typeof fmt==="function"&&typeof unitVal==="function")?fmt(unitVal(P.vol,P.avg)):(""+Math.round(P.vol));
      g.font="bold 10px Arial,sans-serif"; g.textAlign="right"; g.textBaseline="middle";
      const tw=Math.ceil(g.measureText(txt).width)+8;
      g.fillStyle=long?"rgba(63,224,122,.22)":"rgba(255,95,89,.20)"; g.fillRect(W-tw, y-7, tw, 14);
      g.fillStyle=long?"#3fe07a":"#ff5f59"; g.fillText(txt, W-4, y);
      g.textAlign="left"; g.textBaseline="middle";
    }
  }
  g.font="9px Verdana,Geneva,sans-serif"; g.textAlign="left";
  g.restore();   // снимаем выравнивающий сдвиг
}

function renderDelta(){
  const wrap=$("delta"); wrap.innerHTML="";
  if(S.hideFp){ wrap.style.width="0px"; return; }
  const fp=S.flow.footprint||[];
  if(!fp.length){ wrap.style.width="0px"; return; }
  // та же геометрия, что в renderFootprint — узкие столбцы, новые справа (под колонками кластеров)
  const tapeW=110, fpW=Math.max(0,S.fpWidth), W=fpW+tapeW, colW=COL_W;
  wrap.style.width=fpW+"px";
  const dmap=new Map(); for(const [m,bu,se] of (S.flow.delta||[])) dmap.set(m,[bu,se]);
  const pref=S.bestBid||1;
  // рисуем только СТОЛЬКО колонок, сколько влезает (как футпринт) — иначе слипаются
  const maxCols=Math.max(1, Math.floor(fpW/colW));
  const visFp=fp.slice(-maxCols);
  const padLeft=Math.max(0, fpW - visFp.length*colW);   // отступ слева, новейшая примыкает к ленте
  if(padLeft>0){ const sp=document.createElement("div"); sp.style.cssText="flex:0 0 "+padLeft+"px"; wrap.appendChild(sp); }
  for(const c of visFp){
    let bu=0, se=0; const d=dmap.get(c.t);
    if(d){ bu=d[0]; se=d[1]; } else { for(const k in c.cells){ bu+=c.cells[k][0]; se+=c.cells[k][1]; } }
    const net=bu-se, tot=bu+se;
    const col=document.createElement("div"); col.className="dcol"; col.style.flex="0 0 "+colW+"px";
    const t=document.createElement("div"); t.className="dtot"; t.textContent=fmt(unitVal(tot,pref)); col.appendChild(t);
    const v=document.createElement("div"); v.className="dval "+(net>=0?"up":"down");
    v.textContent=(net>=0?"+":"−")+fmt(unitVal(Math.abs(net),pref)); col.appendChild(v);
    const l=document.createElement("div"); l.className="dlbl"; const dt=new Date(c.t*60000);
    l.textContent=String(dt.getHours()).padStart(2,"0")+":"+String(dt.getMinutes()).padStart(2,"0");
    col.appendChild(l); wrap.appendChild(col);
  }
}

async function pollDepth(){
  try{ const r=await fetch("/api/depth?symbol="+encodeURIComponent(S.symbol)).then(x=>x.json());
    if(!r.ok){ status("err","ошибка: "+(r.error||"")); return; } S.depth=r.depth; renderLadder();
  }catch(e){ status("err","сеть недоступна"); } }
async function pollFlow(){
  const cols=Math.max(3, Math.min(40, Math.ceil((Math.max(160,S.fpWidth)-110)/COL_W)+1));
  try{ const r=await fetch("/api/flow?symbol="+encodeURIComponent(S.symbol)+"&fpmin="+cols).then(x=>x.json());
    if(r.ok){ S.flow=r.flow; renderFootprint(); renderDelta(); }
  }catch(e){} }

function wireButtons(){
  // КОЛЕСО над стаканом = сжать/разжать (как MetaScalp), а не прокрутка
  let _lastWheel=0;
  $("ladder").addEventListener("wheel",(e)=>{
    if(!window.hHeld) return;                  // сжатие ТОЛЬКО при зажатой H; иначе обычная прокрутка
    e.preventDefault(); e.stopPropagation();
    const t=(window.performance?performance.now():Date.now()); if(t-_lastWheel<70) return; _lastWheel=t;
    compress(e.deltaY>0?-1:1); },{passive:false});   // инверсия: колесо ВВЕРХ=сжать, ВНИЗ=разжать
  // колесо над футпринтом — обычная прокрутка (отключает авто-центр, чтобы не снапило)
  const _cb=$("centerbtn"); if(_cb) _cb.onclick=()=>centerNow();   // кнопка «Центр» = центровка по цене
  const _ab=$("addbtn"); if(_ab) _ab.onclick=(e)=>{ e.stopPropagation(); showAddMenu(_ab); };   // «+ Добавить»
  // перетаскиваемые ручки: ширина кластеров (fpresize) и ширина стакана (ladresize)
  let mode=null, sx=0, sw=0;
  // #fpresize (у левого края стакана) = ПРИТЯГИВАЕТ стакан к кластерам (меняет общую зону fpTotal), стакан двигается
  $("fpresize").addEventListener("mousedown",(e)=>{ mode="fp"; sx=e.clientX; sw=S.fpTotal||380; e.preventDefault(); });
  $("ladresize").addEventListener("mousedown",(e)=>{ mode="lad"; sx=e.clientX; sw=S.ladWidth; e.preventDefault(); });
  window.addEventListener("mousemove",(e)=>{ if(!mode) return; const d=e.clientX-sx;
    if(mode==="fp"){ S.fpTotal=Math.max(Math.max(40,S.fpWidth||0), Math.min(1200, sw+d)); _fpSig=""; renderFootprint(); renderDelta(); refreshGeo(); positionLots(); }
    else { applyLadWidth(Math.max(110,Math.min(420, sw+d))); } S._render=true; });
  const _sc=$("scroller"); if(_sc){ _sc.addEventListener("scroll",()=>{ refreshGeo(); });   // геометрия для плашек ховера; позиция лотов от скролла НЕ зависит
    _sc.addEventListener("wheel",()=>{ S._userScrollT=(window.performance?performance.now():Date.now()); }, {passive:true}); }  // пауза авто-центровки после ручного скролла
  window.addEventListener("resize",()=>{ refreshGeo(); positionLots(); });
  setInterval(refreshGeo, 300);        // подхватываем перемещение/ресайз окна (без per-frame layout reads)
  window.addEventListener("mouseup",()=>{ mode=null; });
  // сворачивание панели кластеров/следа ВБОК с анимацией (кнопка-стрелка ◀/▶, двойной клик, клавиша F)
  window.toggleTrail=()=>setTrailCollapsed(!S.hideFp, true);
  $("fpcanvas").addEventListener("dblclick",()=>setTrailCollapsed(!S.hideFp,true));
  $("fpcanvas").addEventListener("contextmenu",(e)=>{ e.preventDefault(); showCluMenu(e.clientX,e.clientY); });   // ПКМ = таймфрейм кластеров
  $("fpresize").addEventListener("dblclick",()=>setTrailCollapsed(!S.hideFp,true));
  const tb=$("trailtoggle"); if(tb) tb.onclick=()=>setTrailCollapsed(!S.hideFp,true);
  updateTrailArrow();
  // кнопка сжатия ×N (вместо «шаг») и переключатель темы
  $("stepbtn").onclick=(e)=>{ e.stopPropagation(); showCompressMenu($("stepbtn")); };
  $("themebtn").onclick=()=>{ applyTheme(THEMES[(THEMES.indexOf(S.theme)+1)%THEMES.length]); };
}
// ── боковое сворачивание панели кластеров: анимация ширины по performance.now() (easeOutCubic ~200мс) ──
function updateTrailArrow(){ const tb=$("trailtoggle"); if(tb) tb.textContent=S.hideFp?"▶":"◀"; }
function _animFp(from,to,done){
  const t0=(window.performance?performance.now():Date.now()), dur=200;
  (function step(){ const p=Math.min(1,((window.performance?performance.now():Date.now())-t0)/dur), e=1-Math.pow(1-p,3);
    S.fpWidth=Math.round(from+(to-from)*e); _fpSig=""; renderFootprint(); renderDelta(); positionLots(); S._render=true;
    if(p<1) requestAnimationFrame(step); else if(done) done(); })();
}
function setTrailCollapsed(collapsed, animate){
  if(collapsed){
    if(!S.hideFp && S.fpWidth>20) S._fpSaved=S.fpWidth;                  // запомнить ширину до сворачивания
    if(animate) _animFp(S.fpWidth, 0, ()=>{ S.hideFp=true; _fpSig=""; S._render=true; updateTrailArrow(); });
    else { S.hideFp=true; S.fpWidth=0; _fpSig=""; renderFootprint(); renderDelta(); }
  } else {
    S.hideFp=false; const to=S._fpSaved||260;
    if(animate) _animFp(0, to, ()=>{ updateTrailArrow(); });
    else { S.fpWidth=to; _fpSig=""; renderFootprint(); renderDelta(); }
  }
  updateTrailArrow(); S._render=true;
  if(typeof saveCurrent==="function") saveCurrent();
}
window.setTrailCollapsed=setTrailCollapsed;

// ─────────── панель «Настройки стакана» (как MetaScalp) ───────────
function fillSet(){
  const v=(id,val)=>{ const e=$(id); if(e) e.value=val; };
  const ck=(id,val)=>{ const e=$(id); if(e) e.checked=val; };
  v("set-fillUSD",CFG.USD.fill); v("set-big1USD",CFG.USD.big1); v("set-big2USD",CFG.USD.big2);
  v("set-fillCoin",CFG.coin.fill); v("set-big1Coin",CFG.coin.big1); v("set-big2Coin",CFG.coin.big2);
  v("set-rowH",S.rowCss); v("set-mainMult",S.mainMult); v("set-midMult",S.midMult); v("set-range",S.range); v("set-fps",S.fps);
  v("set-fpMin",S.fpMin); v("set-lev",S.lev); v("set-size",S.size); v("set-unit",S.unit);
  v("set-margin",S.margin); v("set-avg",S.avgMode); v("set-sl",S.slPct); v("set-tp",S.tpPct);
  v("set-slusd",S.slUsd); v("set-ordermode",S.orderMode); v("set-throw",S.throwPct); v("set-pnlfmt",S.pnlFmt);
  for(let i=0;i<5;i++) v("set-lot"+i, LOTS[i]!=null?LOTS[i]:"");
  v("set-tickstyle",S.tickStyle); v("set-tickline",S.tickLine); v("set-tickmin",S.tickMin); v("set-tickagg",S.tickAgg); v("set-tickbig",S.tickBig);
  v("set-clufillUSD",CFG.USD.cluFill); v("set-clufillCoin",CFG.coin.cluFill);
  v("set-clumode",S.cluMode); v("set-clutf",S.cluTF); v("set-ladminusd",S.ladMinUsd);
  v("set-filltopn",S.fillTopN); v("set-fillmult",S.fillMult);
  ck("set-showclu",!S.hideFp); ck("set-showvp",S.showVP!==false); ck("set-showcols",S.showCols!==false); ck("set-abbrev",S.abbrev!==false); ck("set-fillauto",S.fillAuto!==false); ck("set-colorauto",S.colorAuto!==false); ck("set-sound",S.sound===true);
  ck("set-topstab",S.topStab!==false); ck("set-autocenter",S.autoCenter===true); v("set-tophold",S.topHold);
  v("set-stepmult",S.stepMult); v("set-theme",S.theme);
  renderKeyList(); updateAutoFields();
}
// подсветка активности ручных порогов: серым те поля, что перекрыты авто-режимом (иначе «редактирую — не работает»)
function updateAutoFields(){
  const dis=(id,on)=>{ const e=$(id); if(e){ e.disabled=!!on; e.style.opacity=on?0.4:1;
    const lab=e.closest("label"); if(lab) lab.style.opacity=on?0.5:1; } };
  const fillAuto=$("set-fillauto")&&$("set-fillauto").checked;
  const colAuto=$("set-colorauto")&&$("set-colorauto").checked;
  // ручное заполнение активно при ВЫКЛ авто-заполненности; авто-параметры — наоборот
  dis("set-fillUSD",fillAuto); dis("set-fillCoin",fillAuto);
  dis("set-filltopn",!fillAuto); dis("set-fillmult",!fillAuto);
  // ручные пороги цвета активны при ВЫКЛ авто-цвета
  ["set-big1USD","set-big2USD","set-big1Coin","set-big2Coin"].forEach(id=>dis(id,colAuto));
}
const DEFAULT_KEYS={ buy:"KeyT", sell:"KeyY", limitBuy:"KeyA", limitSell:"KeyS", close:"KeyD", reverse:"KeyR", cancel:"KeyB", center:"KeyC", be:"KeyG", trail:"KeyF" };
const KEY_LABELS={ buy:"Купить по рынку", sell:"Продать по рынку", limitBuy:"Лимит-покупка (best bid)", limitSell:"Лимит-продажа (best ask)", close:"Закрыть позицию", reverse:"Реверс", cancel:"Отменить все", center:"Центрировать стакан", be:"Стоп в безубыток", trail:"Свернуть след/кластера" };
function keyName(code){ if(!code) return "—"; return code.replace("Key","").replace("Digit","").replace("Arrow","");}
function renderKeyList(){
  const box=$("keylist"); if(!box) return; box.innerHTML="";
  for(const act in KEY_LABELS){
    const row=document.createElement("div"); row.className="keyrow";
    const lbl=document.createElement("span"); lbl.textContent=KEY_LABELS[act];
    const btn=document.createElement("button"); btn.className="keybtn"; btn.textContent=keyName(S.keys[act]);
    btn.onclick=()=>{ btn.textContent="нажми…"; window._bindingKey=true;
      const cap=(e)=>{ e.preventDefault(); e.stopPropagation();
        if(e.code!=="Escape"){ S.keys[act]=e.code; }
        window._bindingKey=false; document.removeEventListener("keydown",cap,true);
        renderKeyList(); if(typeof saveCurrent==="function") saveCurrent(); };
      document.addEventListener("keydown",cap,true);
    };
    row.append(lbl,btn); box.appendChild(row);
  }
}
function wireSettings(){
  const m=$("settings");
  $("gear").onclick=()=>{ fillSet(); m.classList.remove("hidden"); };
  $("setclose").onclick=()=>m.classList.add("hidden");
  const kr=$("keys-reset"); if(kr) kr.onclick=()=>{ S.keys=Object.assign({},DEFAULT_KEYS); renderKeyList(); if(typeof saveCurrent==="function") saveCurrent(); };
  m.onclick=(e)=>{ if(e.target===m) m.classList.add("hidden"); };
  document.querySelectorAll("#settings .stab").forEach(b=>{ b.onclick=()=>{
    document.querySelectorAll("#settings .stab").forEach(x=>x.classList.remove("on"));
    document.querySelectorAll("#settings .stabpane").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    const p=document.querySelector('#settings .stabpane[data-pane="'+b.dataset.tab+'"]'); if(p) p.classList.add("on");
  }; });
  $("setapply").onclick=()=>{
    const num=(id,def)=>{ const e=$(id); const v=e?parseFloat(e.value):NaN; return isFinite(v)&&v>0?v:def; };
    const numz=(id,def)=>{ const e=$(id); const v=e?parseFloat(e.value):NaN; return isFinite(v)?v:def; };
    CFG.USD.fill=num("set-fillUSD",CFG.USD.fill); CFG.USD.big1=num("set-big1USD",CFG.USD.big1); CFG.USD.big2=num("set-big2USD",CFG.USD.big2);
    CFG.coin.fill=num("set-fillCoin",CFG.coin.fill); CFG.coin.big1=num("set-big1Coin",CFG.coin.big1); CFG.coin.big2=num("set-big2Coin",CFG.coin.big2);
    CFG.USD.cluFill=num("set-clufillUSD",CFG.USD.cluFill); CFG.coin.cluFill=num("set-clufillCoin",CFG.coin.cluFill);
    S.cluMode=($("set-clumode")&&$("set-clumode").value)||S.cluMode; S.cluTF=parseInt($("set-clutf")&&$("set-clutf").value,10)||1;
    S.ladMinUsd=numz("set-ladminusd",S.ladMinUsd);
    S.fillTopN=Math.max(1,Math.round(num("set-filltopn",S.fillTopN))); S.fillMult=num("set-fillmult",S.fillMult); S._fillBasisT=0; _fpSig="";
    S.mainMult=Math.max(1,Math.round(num("set-mainMult",S.mainMult)));
    S.midMult=Math.max(1,Math.round(num("set-midMult",S.midMult)));
    S.range=Math.max(20,Math.min(400,Math.round(num("set-range",S.range))));
    if($("set-fps")) S.fps=Math.max(10,Math.min(60,parseInt($("set-fps").value,10)||S.fps));
    S.fpMin=Math.max(1,Math.min(40,Math.round(num("set-fpMin",S.fpMin))));
    applyRowH(Math.max(8,Math.min(30,Math.round(num("set-rowH",S.rowCss)))));
    S.lev=parseInt($("set-lev").value,10)||S.lev;
    S.size=num("set-size",S.size); S.unit=$("set-unit").value||S.unit;
    S.margin=$("set-margin").value; S.avgMode=$("set-avg").value;
    S.slPct=numz("set-sl",S.slPct); S.tpPct=numz("set-tp",S.tpPct); S.slUsd=numz("set-slusd",S.slUsd);
    { const om=$("set-ordermode"); if(om) S.orderMode=om.value||S.orderMode; S.throwPct=num("set-throw",S.throwPct);
      const pf=$("set-pnlfmt"); if(pf) S.pnlFmt=pf.value||S.pnlFmt; }
    const nl=[]; for(let i=0;i<5;i++){ const e=$("set-lot"+i); const x=e?parseFloat(e.value):NaN; if(isFinite(x)&&x>0) nl.push(x); }
    if(nl.length) LOTS=nl;
    S.tickStyle=$("set-tickstyle").value; S.tickLine=num("set-tickline",S.tickLine);
    S.tickMin=numz("set-tickmin",S.tickMin); S.tickAgg=numz("set-tickagg",S.tickAgg); S.tickBig=num("set-tickbig",S.tickBig);
    S.hideFp=!$("set-showclu").checked; if($("set-showvp")) S.showVP=$("set-showvp").checked; if($("set-showcols")) S.showCols=$("set-showcols").checked; S.abbrev=$("set-abbrev").checked;
    if($("set-fillauto")) S.fillAuto=$("set-fillauto").checked;
    if($("set-colorauto")) S.colorAuto=$("set-colorauto").checked;
    if($("set-sound")) S.sound=$("set-sound").checked;
    if($("set-topstab")) S.topStab=$("set-topstab").checked;
    if($("set-autocenter")) S.autoCenter=$("set-autocenter").checked;
    if($("set-tophold")) S.topHold=Math.max(0,Math.min(1000,numz("set-tophold",S.topHold)));
    if($("set-stepmult")) setStepMult(parseInt($("set-stepmult").value,10)||S.stepMult);
    if($("set-theme")) applyTheme($("set-theme").value);
    _fpSig=""; wireLots(); S._render=true;
    m.classList.add("hidden");
  };
  $("set-unit").onchange=()=>{ S.unit=$("set-unit").value; };
  $("set-lev").onchange=()=>{ S.lev=parseInt($("set-lev").value,10)||S.lev; };
  const fa=$("set-fillauto"); if(fa) fa.addEventListener("change",updateAutoFields);
  const ca=$("set-colorauto"); if(ca) ca.addEventListener("change",updateAutoFields);
  wireProxy();
}

// ── Прокси-панель (пул на сервере: /api/proxy) ──
async function pxCall(path,body){
  try{ const r=await fetch("/api/proxy"+path,{method:body?"POST":"GET",
        headers:body?{"Content-Type":"application/json"}:undefined,
        body:body?JSON.stringify(body):undefined});
    return await r.json(); }catch(e){ return {ok:false,error:String(e)}; }
}
function pxRenderStatus(d){
  if(!d) return;
  const md=$("px-mode"); if(md&&d.mode) md.value=d.mode;
  const ws=$("px-ws"); if(ws) ws.checked=!!d.ws;
  const wh=$("px-wshint"); if(wh) wh.textContent=d.ws_supported?"(book/ленты)":"(⚠ версия websockets без proxy — только REST)";
  const box=$("px-list"); if(!box) return; box.innerHTML="";
  for(const p of (d.list||[])){
    const row=document.createElement("div"); row.className="pxrow"+(p.dead?" dead":"")+(p.enabled?"":" off");
    const dot=document.createElement("span"); dot.className="pxdot "+(p.dead?"bad":(p.checked?"good":"unk"));
    const url=document.createElement("span"); url.className="pxurl"; url.textContent=p.url;
    const info=document.createElement("span"); info.className="pxinfo";
    info.textContent=(p.latency?p.latency+"мс ":"")+(p.geo||"")+(p.ip?" "+p.ip:"")+(p.err?" · "+p.err:"");
    const en=document.createElement("button"); en.className="pxbtn"; en.textContent=p.enabled?"вкл":"выкл";
    en.onclick=async()=>pxRenderStatus(await pxCall("/toggle",{id:p.id,enabled:!p.enabled}));
    const tst=document.createElement("button"); tst.className="pxbtn"; tst.textContent="тест";
    tst.onclick=async()=>{ tst.textContent="…"; pxRenderStatus(await pxCall("/test",{id:p.id})); };
    const del=document.createElement("button"); del.className="pxbtn del"; del.textContent="✕";
    del.onclick=async()=>pxRenderStatus(await pxCall("/remove",{id:p.id}));
    row.append(dot,url,info,en,tst,del); box.appendChild(row);
  }
}
async function pxLoad(){ pxRenderStatus(await pxCall("")); }
function wireProxy(){
  const md=$("px-mode"); if(md) md.onchange=async()=>pxRenderStatus(await pxCall("/mode",{mode:md.value}));
  const ws=$("px-ws"); if(ws) ws.onchange=async()=>pxRenderStatus(await pxCall("/ws",{on:ws.checked}));
  const add=$("px-add"),url=$("px-url");
  if(add) add.onclick=async()=>{ const u=(url&&url.value||"").trim(); if(!u) return;
    pxRenderStatus(await pxCall("/add",{url:u})); if(url) url.value=""; };
  if(url) url.onkeydown=(e)=>{ if(e.key==="Enter"&&add) add.click(); };
  // подгружать список при открытии вкладки Прокси
  const tab=document.querySelector('#settings .stab[data-tab="proxy"]');
  if(tab) tab.addEventListener("click",pxLoad);
}

// вертикальная панель рядом со стаканом (как у MetaScalp): 50X / Fix / USD / лоты
let LOTS=[20,40,80,160,300];
const LEVS=[10,20,50,100,200];
function selectLotBtn(b){ $("lots").querySelectorAll(".lp-sz").forEach(x=>x.classList.remove("on"));
  b.classList.add("on"); S.size=parseFloat(b.dataset.lot)||S.size; }
function selectLot(i){ const bs=$("lots").querySelectorAll(".lp-sz"); if(bs[i]) selectLotBtn(bs[i]); }  // клавиши 1-5
function editLot(b){   // двойной клик → вписать свой объём
  const inp=document.createElement("input"); inp.type="number"; inp.value=b.dataset.lot; inp.className="lp-edit";
  b.replaceWith(inp); inp.focus(); inp.select();
  const done=(save)=>{ const v=parseFloat(inp.value);
    if(save && isFinite(v) && v>0){ b.dataset.lot=v; b.textContent=v; }
    inp.replaceWith(b); if(save && isFinite(v) && v>0) selectLotBtn(b); };
  inp.onblur=()=>done(true);
  inp.onkeydown=(e)=>{ if(e.key==="Enter"){ e.preventDefault(); inp.blur(); } else if(e.key==="Escape"){ done(false); } };
}
function wireLots(){
  const box=$("lots"); box.innerHTML="";
  const mn=$("main"); if(mn && box.parentElement!==mn) mn.appendChild(box);   // в #main → позиционируется относительно стакана надёжно
  // кнопка СВОРАЧИВАНИЯ панели кластеров (выдвинуть/задвинуть вбок; панель лотов едет вместе)
  const col=document.createElement("button"); col.className="lp-col"; col.title="свернуть/развернуть кластера";
  col.textContent=S.hideFp?"▶":"◀";
  col.onclick=()=>{ const willCollapse=!S.hideFp; if(window.setTrailCollapsed) setTrailCollapsed(willCollapse,true); col.textContent=willCollapse?"▶":"◀"; };
  box.appendChild(col);
  const lev=document.createElement("button"); lev.className="lp-lev"; lev.textContent=S.lev+"X";
  lev.onclick=()=>{ S.lev=LEVS[(LEVS.indexOf(S.lev)+1)%LEVS.length]; lev.textContent=S.lev+"X"; };
  box.appendChild(lev);
  const fix=document.createElement("button"); fix.className="lp-fix"; fix.textContent="Fix"; box.appendChild(fix);
  const unit=document.createElement("button"); unit.className="lp-usd";
  unit.textContent=S.unit==="contracts"?"cont":S.unit;
  const U=["USD","coin","contracts"];
  unit.onclick=()=>{ S.unit=U[(U.indexOf(S.unit)+1)%U.length]; unit.textContent=S.unit==="contracts"?"cont":S.unit; };
  box.appendChild(unit);
  for(const amt of LOTS){ const b=document.createElement("button"); b.className="lp-sz"; b.textContent=amt; b.dataset.lot=amt;
    if(amt===S.size) b.classList.add("on");
    b.onclick=()=>selectLotBtn(b);
    b.ondblclick=(e)=>{ e.preventDefault(); editLot(b); };   // 2 клика = вписать своё значение
    box.appendChild(b); }
}
// панель лотов ПРИКЛЕЕНА к правому краю СТОЛБЦОВ КЛАСТЕРОВ (граница fpWidth), не к краю всего канваса.
// Едет вместе с кластерами при ресайзе делителя/скролле. Отдельно от стакана.
// КЭШ ГЕОМЕТРИИ: читаем layout ТОЛЬКО на скролл/ресайз/таймер, а не на каждый кадр (иначе форс-рефлоу = фриз при ховере)
let _geo=null;
function refreshGeo(){ const fp=$("fpwrap"), m=$("main"), cv=$("ladcanvas"), bw=$("bookwin");
  if(!fp||!m){ _geo=null; return; }
  const mr=m.getBoundingClientRect(), fr=fp.getBoundingClientRect(), cr=cv?cv.getBoundingClientRect():null;
  _geo={ fpL:fr.left, mainL:mr.left, mainH:mr.height,
         ladL:cr?cr.left:0, ladT:cr?cr.top:0,
         bl:bw?bw.getBoundingClientRect().left:0 };
}
function positionLots(){ const p=$("lots"); if(!p) return;
  // ширина зоны кластеров = стабильная величина из настроек (НЕ живой rect прокручиваемого fpwrap → без «беготни»)
  const cw = S.hideFp ? 0 : Math.min((S.fpTotal||380),(S.fpWidth||0));
  const lx = Math.round(Math.max(2, cw + 12));
  if(p._lx!==lx){ p.style.left=lx+"px"; p._lx=lx; }
  const ce=$("cluedge");
  if(ce){ const cx=Math.round(cw); if(ce._lx!==cx){ ce.style.left=cx+"px"; ce.style.top="0"; ce.style.height="100%"; ce._lx=cx; } }
  // icon-панель — в пустую зону ленты (справа от кластеров, сверху), а не поверх столбцов объёма
  const pt=$("paneltools"); if(pt){ const px=Math.round(cw+20); if(pt._lx!==px){ pt.style.left=px+"px"; pt.style.top="8px"; pt.style.right="auto"; pt._lx=px; } }
}
// перетаскивание делителя кластеров мышью: тянешь влево/вправо — ширина; к краю → сворачивание
function wireCluEdge(){
  const ce=$("cluedge"); if(!ce) return; let on=false;
  ce.addEventListener("mousedown",(e)=>{ on=true; e.preventDefault(); e.stopPropagation(); });
  window.addEventListener("mousemove",(e)=>{ if(!on) return;
    const fp=$("fpwrap"); if(!fp) return; const r=fp.getBoundingClientRect();
    const total=Math.max(120,S.fpTotal||380);
    let w=e.clientX - r.left;                             // кластера растут ВНУТРИ зоны total → СТАКАН НА МЕСТЕ
    S.fpWidth=Math.max(0,Math.min(total,Math.round(w))); if(S.fpWidth>20) S._fpSaved=S.fpWidth;
    _fpSig=""; renderFootprint(); renderDelta(); positionLots(); S._render=true; });
  window.addEventListener("mouseup",()=>{ if(on){ on=false; if(typeof saveCurrent==="function") saveCurrent(); } });
}
// циклическое сжатие/расширение стакана (горячая клавиша H)
function cycleCompress(){ const i=STEP_MULTS.indexOf(S.stepMult); setStepMult(STEP_MULTS[(i+1)%STEP_MULTS.length]); }

// ── ЗВУК на крупный принт (Web Audio) — ловить агрессию/поглощение ММ на слух ──
let _actx=null;
function _audio(){ if(!_actx){ try{ _actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return _actx; }
document.addEventListener("pointerdown",()=>{ const a=_audio(); if(a&&a.state==="suspended") a.resume(); });
function beep(side, strong){
  const a=_audio(); if(!a) return;
  const o=a.createOscillator(), g=a.createGain();
  o.type="sine"; o.frequency.value = side===1 ? (strong?900:680) : (strong?300:440);   // buy выше, sell ниже
  o.connect(g); g.connect(a.destination);
  const t=a.currentTime, vol=strong?0.3:0.16;
  g.gain.setValueAtTime(0.0001,t);
  g.gain.exponentialRampToValueAtTime(vol, t+0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t+0.14);
  o.start(t); o.stop(t+0.15);
}
// ИНДИКАТОР ПОТОКА: куда «стреляет» лента (перекос агрессии buy/sell за 4с) + скорость (сделок/сек)
function renderFlowMeter(){
  const el=$("flowmeter"); if(!el) return;
  const t=S.flow.ticks||[], now=S.flow.now||0; if(!t.length){ el.textContent=""; return; }
  let buy=0, sell=0, cnt=0;
  for(let i=t.length-1;i>=0;i--){ const tk=t[i], age=now-tk.t; if(age>4000) break;
    const u=unitVal(tk.v,tk.p); if(tk.side===1) buy+=u; else sell+=u; if(age<=1000) cnt++; }
  const tot=buy+sell||1, bp=Math.round(buy/tot*100);
  const dir = bp>=55?"▲":bp<=45?"▼":"■", dcol = bp>=55?"#6fcf91":bp<=45?"#ef938f":"#8a94a3";
  el.innerHTML = `<span style="color:${dcol}">${dir}${bp}%</span>`
    + `<span class="fm-bar"><span class="fm-buy" style="width:${bp}%"></span><span class="fm-sell" style="width:${100-bp}%"></span></span>`
    + `<span class="fm-spd">${cnt}/с</span>`;
}
// поток push (SSE) + рендер на requestAnimationFrame — плавно, без поллинга
let _es=null, _dirty=false;
function connectStream(){
  if(document.documentElement.classList.contains("scr-embed")) return;   // окно только-скринер: стакан не нужен, не жжём SSE
  if(_es){ try{ _es.close(); }catch(e){} }
  _es=new EventSource("/api/stream?symbol="+encodeURIComponent(S.symbol));
  _es.onmessage=(e)=>{ let m; try{ m=JSON.parse(e.data); }catch(err){ return; }
    if(m.t==="depth"){ S.depth=m.depth; S._render=true; }
    else if(m.t==="ticks"){
      if(S.sound && m.ticks && m.ticks.length){       // звук на КРУПНЫЙ принт (только новые с прошлого раза)
        const big=S.tickBig||5000; let last=S._sndT||0, mx=last;
        for(const tk of m.ticks){ if(tk.t>last){ const u=unitVal(tk.v,tk.p); if(u>=big) beep(tk.side, u>=big*3); if(tk.t>mx)mx=tk.t; } }
        S._sndT=mx;
      } else if(m.ticks && m.ticks.length){ S._sndT=m.ticks[m.ticks.length-1].t; }
      if(window.tapeFeed) tapeFeed(m.ticks);          // колоночная лента (ring buffer)
      S.flow.ticks=m.ticks; S.flow.now=m.now; S._render=true; renderFlowMeter();
    }   // быстрая лента (пузыри успевают за ценой)
    else if(m.t==="flow"){ S.flow=m.flow; S._render=true; renderDelta(); renderFlowMeter(); } };
  _es.onerror=()=>{ status("err","переподключение…"); };
}
// полное обновление стакана по кнопке ↻ (без Ctrl+Shift+R): сброс состояния + переоткрытие потока
function hardRefresh(){
  status("err","обновление…");
  S.depth=null; S.flow={footprint:[],ticks:[],delta:[],now:0};
  S.centerS=null; POOL=[]; const r=$("rows"); if(r) r.textContent="";
  if(S._pv) S._pv.clear(); if(S._flash) S._flash.clear();
  _fpSig=""; S._rowPitch=0; S._fillBasisT=0; S._yOff=0;
  const cv=$("fpcanvas"); if(cv){ cv.width=0; }
  connectStream();
  fetch("/api/depth?symbol="+encodeURIComponent(S.symbol)).then(x=>x.json())
    .then(d=>{ if(d&&d.ok&&d.depth){ S.depth=d.depth; S._render=true; } }).catch(()=>{});   // мгновенный первый кадр, не ждём SSE
  if(typeof refreshAccount==="function") refreshAccount(true);   // ↻ подтянуть и ПОКАЗАТЬ все мои заявки/позицию с биржи (вдруг забыла снять)
}
// ── ВСТРОЕННЫЙ ПРОФАЙЛЕР (F9 или window.togglePerf()): рендеров-в-сек, ms/кадр avg+p95, dropped frames ──
const _pf={on:false, times:[], lastRaf:0, renders:0, drops:0, secT:0};
function togglePerf(){ _pf.on=!_pf.on; const el=$("perfhud"); if(el) el.style.display=_pf.on?"block":"none";
  _pf.times.length=0; _pf.renders=0; _pf.drops=0; _pf.secT=0; _pf.lastRaf=0; }
window.togglePerf=togglePerf;
let _lastRender=0;
function frame(ts){
  ts = ts || (window.performance?performance.now():Date.now());
  // РЕНДЕР ТОЛЬКО ПО ИЗМЕНЕНИЮ (S._render): данные/наведение/центровка. Нативный скролл перерисовки не требует.
  if(_pf.on && _pf.lastRaf && (ts-_pf.lastRaf)>24) _pf.drops++;   // разрыв >~1.5 кадра = пропущенный кадр
  _pf.lastRaf = ts;
  // ТРОТТЛИНГ ЧАСТОТЫ (как FPS в MetaScalp/CScalp): при 50Гц-потоке сырой бид/аск мельтешит —
  // рисуем не чаще S.fps (деф.30) → шум усредняется, стакан «спокойный». S._render НЕ сбрасываем при пропуске (коалесинг).
  const minDt = 1000/Math.max(1, S.fps||30);
  const pri = S._hoverPri===true; if(pri) S._hoverPri=false;   // движение мыши по стакану → рисуем сразу (плавный ховер, до 60fps)
  const due = pri || (ts - _lastRender) >= minDt - 1;
  try{ if(S.depth && S._render && due){ S._render=false; _lastRender=ts;
    const t0 = _pf.on?performance.now():0;
    renderLadder(); window._rc=(window._rc||0)+1;
    if(_pf.on){ const dt=performance.now()-t0; _pf.times.push(dt); if(_pf.times.length>150)_pf.times.shift(); _pf.renders++; }
  } }catch(err){}
  if(_pf.on && ts-_pf.secT>=500){                                // раз в 0.5с обновляем HUD
    const dur=ts-_pf.secT||1; _pf.secT=ts;
    const ups=Math.round(_pf.renders*1000/dur); _pf.renders=0;
    const a=_pf.times.slice().sort((x,y)=>x-y);
    const avg=a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
    const p95=a.length?a[Math.min(a.length-1,Math.floor(a.length*0.95))]:0;
    const hud=$("perfhud"); if(hud) hud.textContent="рендеров "+ups+"/с · avg "+avg.toFixed(1)+"мс · p95 "+p95.toFixed(1)+"мс · пропуск "+_pf.drops;
  }
  requestAnimationFrame(frame);
}

// ── СИМУЛЯТОР ПОТОКА (замер 60 FPS без биржи): в консоли startSim(250) / stopSim() ──
let _simTimer=null, _simFps=null;
function startSim(rate){
  rate=rate||250; stopSim();
  const b=(S.depth&&S.depth.bids&&S.depth.bids[0])?S.depth.bids[0][0]:(S.symbol.indexOf("BTC")>=0?60000:100);
  let mid=b; const tick=S.tick||0.01;
  const gen=()=>{
    mid += (Math.random()-0.5)*tick*2;
    const bids=[], asks=[];
    for(let i=1;i<=140;i++){ bids.push([+(mid-i*tick).toFixed(8), Math.round(Math.random()*5000)+10, 1]); asks.push([+(mid+i*tick).toFixed(8), Math.round(Math.random()*5000)+10, 1]); }
    S.depth={symbol:S.symbol,ts:Date.now(),bids,asks};
    const now=Date.now(), ticks=[], nd=Math.random()<0.1?18:2;   // 10% всплески-свипы
    for(let k=0;k<nd;k++){ const side=Math.random()<0.5?1:2; ticks.push({p:+(side===1?mid+tick:mid-tick).toFixed(8), v:Math.round(Math.random()*3000)+1, side, t:now-k}); }
    S.flow.ticks=(S.flow.ticks||[]).concat(ticks).slice(-400); S.flow.now=now;
    if(window.tapeFeed) tapeFeed(ticks);
    S._render=true;
  };
  _simTimer=setInterval(gen, Math.max(1,Math.round(1000/rate)));
  let r0=window._rc||0, t0=performance.now();
  _simFps=setInterval(()=>{ const dt=(performance.now()-t0)/1000, rc=(window._rc||0)-r0;
    console.log("СИМ "+rate+"/с → рендеров:", (rc/dt).toFixed(0), "FPS"); r0=window._rc||0; t0=performance.now(); }, 2000);
  console.log("Симулятор: "+rate+" апдейтов/сек. stopSim() — стоп.");
}
function stopSim(){ if(_simTimer){clearInterval(_simTimer);_simTimer=null;} if(_simFps){clearInterval(_simFps);_simFps=null;} if(typeof connectStream==="function") connectStream(); }
window.startSim=startSim; window.stopSim=stopSim;

// ─────────── шаблоны рабочего конфига (как «Рабочие пространства» GC-term) ───────────
function captureConfig(){
  return { symbol:S.symbol, stepMult:S.stepMult, fpWidth:S.fpWidth, ladWidth:S.ladWidth,
    rowCss:S.rowCss, range:S.range, mainMult:S.mainMult, midMult:S.midMult, fpMin:S.fpMin, fps:S.fps, fpTotal:S.fpTotal,
    lev:S.lev, size:S.size, unit:S.unit, hideFp:S.hideFp, fpSaved:S._fpSaved, lotsX:S.lotsX, lotsY:S.lotsY, theme:S.theme,
    tickStyle:S.tickStyle, tickLine:S.tickLine, tickMin:S.tickMin, tickAgg:S.tickAgg, tickBig:S.tickBig,
    cluMode:S.cluMode, cluTF:S.cluTF, ladMinUsd:S.ladMinUsd, fillTopN:S.fillTopN, fillMult:S.fillMult, colorAuto:S.colorAuto, sound:S.sound, spreadGate:S.spreadGate, topStab:S.topStab, topHold:S.topHold, showVP:S.showVP, showCols:S.showCols, autoCenter:S.autoCenter,
    avgMode:S.avgMode, slPct:S.slPct, tpPct:S.tpPct, slUsd:S.slUsd, orderMode:S.orderMode, throwPct:S.throwPct, pnlFmt:S.pnlFmt, margin:S.margin, abbrev:S.abbrev, fillAuto:S.fillAuto, lots:LOTS.slice(),
    keys:{...S.keys}, alerts:S._alerts,
    cfg:{USD:{...CFG.USD}, coin:{...CFG.coin}, contracts:{...CFG.contracts}} };
}
function applyConfig(c){
  if(!c) return;
  if(c.symbol && S.instr[c.symbol]) S.symbol=c.symbol;
  if(c.cfg){ Object.assign(CFG.USD,c.cfg.USD||{}); Object.assign(CFG.coin,c.cfg.coin||{}); Object.assign(CFG.contracts,c.cfg.contracts||{}); }
  S.range=c.range||S.range; S.mainMult=c.mainMult||S.mainMult; S.midMult=c.midMult||S.midMult; S.fpMin=c.fpMin||S.fpMin; if(c.fps) S.fps=c.fps; if(c.fpTotal) S.fpTotal=c.fpTotal;
  S.lev=c.lev||S.lev; S.size=c.size||S.size; S.unit=c.unit||S.unit; if(c.hideFp!=null) S.hideFp=c.hideFp;
  if(c.fpWidth) S.fpWidth=c.fpWidth; if(c.fpSaved) S._fpSaved=c.fpSaved;
  if(c.lotsX!=null) S.lotsX=c.lotsX; if(c.lotsY!=null) S.lotsY=c.lotsY; if(typeof positionLots==="function") positionLots();
  if(typeof updateTrailArrow==="function") updateTrailArrow();
  if(c.tickStyle) S.tickStyle=c.tickStyle; if(c.tickLine!=null) S.tickLine=c.tickLine;
  if(c.tickMin!=null) S.tickMin=c.tickMin; if(c.tickAgg!=null) S.tickAgg=c.tickAgg; if(c.tickBig!=null) S.tickBig=c.tickBig;
  if(c.cluMode) S.cluMode=c.cluMode; if(c.cluTF!=null) S.cluTF=c.cluTF; if(c.ladMinUsd!=null) S.ladMinUsd=c.ladMinUsd;
  if(c.fillTopN!=null) S.fillTopN=c.fillTopN; if(c.fillMult!=null) S.fillMult=c.fillMult; if(c.colorAuto!=null) S.colorAuto=c.colorAuto; if(c.sound!=null) S.sound=c.sound; if(c.spreadGate!=null) S.spreadGate=c.spreadGate;
  if(c.topStab!=null) S.topStab=c.topStab; if(c.topHold!=null) S.topHold=c.topHold; if(c.showVP!=null) S.showVP=c.showVP; if(c.showCols!=null) S.showCols=c.showCols; if(c.autoCenter!=null) S.autoCenter=c.autoCenter;
  if(c.avgMode) S.avgMode=c.avgMode; if(c.slPct!=null) S.slPct=c.slPct; if(c.tpPct!=null) S.tpPct=c.tpPct;
  if(c.slUsd!=null) S.slUsd=c.slUsd; if(c.orderMode) S.orderMode=c.orderMode; if(c.throwPct!=null) S.throwPct=c.throwPct; if(c.pnlFmt) S.pnlFmt=c.pnlFmt;
  if(c.margin) S.margin=c.margin; if(c.abbrev!=null) S.abbrev=c.abbrev; if(c.fillAuto!=null) S.fillAuto=c.fillAuto;
  if(Array.isArray(c.lots)&&c.lots.length) LOTS=c.lots.slice();
  applySymbolMeta();
  if(c.stepMult) setStepMult(c.stepMult);
  applyRowH(c.rowCss||S.rowCss); applyLadWidth(c.ladWidth||S.ladWidth);
  if(c.keys) S.keys=Object.assign({}, S.keys, c.keys);
  if(c.alerts) S._alerts=c.alerts;
  if(c.theme) applyTheme(c.theme);
  const inp=$("symbol"); if(inp) inp.value=S.symbol.replace("_USDT","");
  S.centerS=null; POOL=[]; S.flow={footprint:[],ticks:[],delta:[],now:0}; _fpSig="";
  wireLots();
  if(typeof connectStream==="function") connectStream();
}
function _tpls(){ try{ return JSON.parse(localStorage.getItem("gc_dom_tpl")||"{}"); }catch(e){ return {}; } }
function _saveTpls(o){ try{ localStorage.setItem("gc_dom_tpl",JSON.stringify(o)); }catch(e){} }
function saveCurrent(){ try{ localStorage.setItem("gc_dom_cur",JSON.stringify(captureConfig())); }catch(e){} }
function renderTplList(){
  const box=$("tpllist"); box.innerHTML=""; const o=_tpls();
  const names=Object.keys(o).sort((a,b)=>(o[b].ts||0)-(o[a].ts||0));
  if(!names.length){ box.innerHTML='<div style="color:var(--muted);font-size:11px;padding:4px">пока нет сохранённых</div>'; return; }
  for(const nm of names){ const it=o[nm];
    const row=document.createElement("div"); row.className="tplitem";
    const info=document.createElement("div"); info.className="nm";
    const b=document.createElement("b"); b.textContent=nm;
    const sm=document.createElement("small"); sm.textContent=new Date(it.ts||0).toLocaleString();
    info.appendChild(b); info.appendChild(sm); row.appendChild(info);
    const ld=document.createElement("button"); ld.className="ld"; ld.textContent="Загрузить";
    ld.onclick=()=>{ applyConfig(it.cfg); saveCurrent(); $("templates").classList.add("hidden"); };
    const del=document.createElement("button"); del.className="del"; del.textContent="✕";
    del.onclick=()=>{ const oo=_tpls(); delete oo[nm]; _saveTpls(oo); renderTplList(); };
    row.appendChild(ld); row.appendChild(del); box.appendChild(row);
  }
}
function wireTemplates(){
  const m=$("templates");
  $("tplbtn").onclick=()=>{ renderTplList(); m.classList.remove("hidden"); };
  $("tplclose").onclick=()=>m.classList.add("hidden");
  m.onclick=(e)=>{ if(e.target===m) m.classList.add("hidden"); };
  $("tplsave").onclick=()=>{ const nm=$("tplname").value.trim(); if(!nm) return;
    const o=_tpls(); o[nm]={cfg:captureConfig(), ts:Date.now()}; _saveTpls(o); $("tplname").value=""; renderTplList(); };
  $("tplname").addEventListener("keydown",(e)=>{ if(e.key==="Enter") $("tplsave").click(); });
}

(async function start(){
  try{ if(new URLSearchParams(location.search).has("dom")) document.body.classList.add("dom-embed"); }catch(e){}  // режим «только стакан» (в iframe отдельного окна)
  applyRowH(S.rowCss); applyLadWidth(S.ladWidth); applyTheme(S.theme);
  await loadInstruments(); wireButtons(); wireSettings(); wireLots(); wireCluEdge(); wireTemplates(); wirePanelTools(); wireBookWin();
  pollTicker(); setInterval(pollTicker, 5000);
  let restored=false;
  try{ const cur=localStorage.getItem("gc_dom_cur"); if(cur){ applyConfig(JSON.parse(cur)); restored=true; } }catch(e){}
  if(!restored) connectStream();
  window.addEventListener("beforeunload", saveCurrent);
  setInterval(saveCurrent, 4000);
  // разовый пересчёт высоты строки при ресайзе окна и вскоре после загрузки (шрифты/раскладка устаканились)
  window.addEventListener("resize", ()=>{ if(typeof measureRowPitch==="function") measureRowPitch(); });
  setTimeout(()=>{ if(typeof measureRowPitch==="function") measureRowPitch(); }, 800);
  if(!document.documentElement.classList.contains("scr-embed")) requestAnimationFrame(frame);   // только-скринер: не крутим RAF-рендер стакана
})();
