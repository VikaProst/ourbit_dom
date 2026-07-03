"use strict";
// Скринер Ourbit (MetaScalp-style): таблица монет с метриками, сортировка по столбцам, фильтры мин/макс,
// активность-бар, топ-N, заморозка при наведении, звук, шаблоны, клик→линк. Данные /api/screener (сервер).
(function () {
  const g = (id) => document.getElementById(id);
  const win = g("scrwin");
  let timer = null, rowsRaw = [], frozen = false, muteMap = {};
  let frozenSyms = null, lastShownKeys = [];      // заморозка при наведении: порядок/состав строк

  // ── столбцы: key, подпись, тип (num/pct/usd/act/coin), направление сортировки по умолчанию ──
  const COLS = [
    {k:"coin",   t:"Монета",    kind:"coin"},
    {k:"rise",   t:"Изм %",     kind:"pct"},
    {k:"trades", t:"Сделки",    kind:"num"},
    {k:"amt",    t:"Оборот $",  kind:"usd"},
    {k:"act",    t:"Активность",kind:"act"},
    {k:"scoll",  t:"СБОР",      kind:"scol"},
    {k:"wall",   t:"СТЕНА $",   kind:"usd"},
    {k:"spread", t:"Спред %",   kind:"spr"},
    {k:"natr",   t:"NATR %",    kind:"num3"},
    {k:"dpct",   t:"Δоб %",     kind:"signpct"},
    {k:"dusd",   t:"Δоб $",     kind:"signusd"},
    {k:"vspike", t:"Всплеск V %",kind:"num"},
    {k:"tspike", t:"Всплеск сд %",kind:"num"},
    {k:"funding",t:"Фандинг %", kind:"num3"},
    {k:"oipct",  t:"ОИ %",      kind:"signpct"},
    {k:"oiusd",  t:"ОИ $",      kind:"signusd"},
    {k:"vol",    t:"Объём",     kind:"num"},
    {k:"last",   t:"Цена",      kind:"price"},
  ];
  const DEF = { cols:["coin","scoll","wall","rise","amt","spread","natr"], sort:"scoll", dir:-1, topN:20,
                freeze:true, sound:false, mute:30, filters:{}, exchanges:["ourbit"], exExcluded:[], tfs:{}, colW:{}, showStrip:true };
  const TF_METRICS = new Set(["rise","trades","amt","natr","vspike","tspike","dusd","dpct","oipct","oiusd"]);  // метрики с таймфреймом
  const TF_OPTS = [1,3,5,15,30,60];
  // бирж-бейдж: всегда виден рядом с монетой (как в MetaScalp). lbl=код, c=цвет фона
  const EXMETA = {
    ourbit:{lbl:"OURB", c:"#16c784"}, weex:{lbl:"WEEX", c:"#e6a943"},
    mexc:{lbl:"MEXC", c:"#3ac6e6"}, bybit:{lbl:"BYBIT", c:"#f7a600"},
    okx:{lbl:"OKX", c:"#c9cdd4"}, gate:{lbl:"GATE", c:"#e6446e"},
    bitget:{lbl:"BITG", c:"#00e0c6"}, kucoin:{lbl:"KUCN", c:"#24d19a"},
    bingx:{lbl:"BINGX", c:"#2a5bd7"}, htx:{lbl:"HTX", c:"#2c6bed"},
    bitmart:{lbl:"BMART", c:"#3ad1c8"}, hyperliquid:{lbl:"HYPE", c:"#4be3c0"},
    xt:{lbl:"XT", c:"#1f9d55"}, lbank:{lbl:"LBANK", c:"#3aa0ff"},
    blofin:{lbl:"BLOFIN", c:"#7a6cff"}, bitunix:{lbl:"BITX", c:"#f0a03c"},
    whitebit:{lbl:"WBIT", c:"#d0d4da"}, asterdex:{lbl:"ASTER", c:"#9d7bff"},
    binance:{lbl:"BINA", c:"#f0b90b"}, edgex:{lbl:"EDGEX", c:"#8ce06a"},
    lighter:{lbl:"LIGHT", c:"#b8c0cc"}, upbit:{lbl:"UPBIT", c:"#1273e6"},
    binancespot:{lbl:"BINs", c:"#f0d24b"},
  };
  const EXDOM = { ourbit:"ourbit.com", weex:"weex.com", mexc:"mexc.com", bybit:"bybit.com",
    okx:"okx.com", gate:"gate.io", bitget:"bitget.com", kucoin:"kucoin.com", bingx:"bingx.com",
    htx:"htx.com", bitmart:"bitmart.com", hyperliquid:"hyperliquid.xyz", xt:"xt.com",
    lbank:"lbank.com", blofin:"blofin.com", bitunix:"bitunix.com", whitebit:"whitebit.com",
    asterdex:"asterdex.com", binance:"binance.com", edgex:"edgex.exchange", lighter:"lighter.xyz", upbit:"upbit.com", binancespot:"binance.com" };
  function exMeta(ex){ return EXMETA[ex] || {lbl:(ex||"?").toUpperCase().slice(0,5), c:"#8a929c"}; }
  // иконка биржи: фавиконка (как «MF» в MetaScalp) с фолбэком на цветной монограмм-тайл
  function exIcon(ex){ const m=exMeta(ex), dom=EXDOM[ex], mono=(m.lbl||"?").slice(0,2);
    const tile='<span class="exbadge" style="background:'+m.c+'" title="'+ex+' фьючерс">'+
      (dom?'<img class="exico" src="https://icons.duckduckgo.com/ip3/'+dom+'.ico" alt="" loading="lazy" onerror="this.remove()">':'')+
      '<span class="exmono">'+mono+'</span></span>';
    return tile; }
  // мини-бейдж биржи для полоски (иконка + S/F)
  function exStripBadge(ex){ const isSpot=ex.endsWith("spot"), letter=isSpot?"S":"F", dom=EXDOM[ex], m=exMeta(ex);
    return '<span class="exmini" title="'+ex+'">'+
      (dom?'<img class="exminico" src="https://icons.duckduckgo.com/ip3/'+dom+'.ico" alt="" loading="lazy" onerror="this.remove()">':'<span class="exminimono" style="background:'+m.c+'">'+(m.lbl||"?").slice(0,1)+'</span>')+
      '<i class="exminil '+(isSpot?"s":"f")+'">'+letter+'</i></span>'; }
  let CFG = load();

  function load(){ try{ const j=JSON.parse(localStorage.getItem("scr.cfg")); if(j) return Object.assign({}, DEF, j, {filters:j.filters||{}, tfs:j.tfs||{}, exExcluded:j.exExcluded||[], colW:j.colW||{}}); }catch(e){} return JSON.parse(JSON.stringify(DEF)); }
  function save(){ try{ localStorage.setItem("scr.cfg", JSON.stringify(CFG)); }catch(e){} }

  // ── форматтеры ──
  function fmtUsd(v){ v=Math.round(v||0); if(v>=1e9)return "$"+(v/1e9).toFixed(2)+"B"; if(v>=1e6)return "$"+(v/1e6).toFixed(2)+"M"; if(v>=1e3)return "$"+(v/1e3).toFixed(1)+"K"; return "$"+v; }
  function fmtNum(v){ v=Math.round(v||0); if(v>=1e9)return (v/1e9).toFixed(1)+"B"; if(v>=1e6)return (v/1e6).toFixed(1)+"M"; if(v>=1e3)return (v/1e3).toFixed(1)+"K"; return String(v); }
  function cell(col, row){
    switch(col.kind){
      case "coin":  { const main=row.mainex||row.ex||"ourbit";
        const strip=(CFG.showStrip!==false)?(row.exchs||[]).filter(e=>e!==main).map(exStripBadge).join(""):"";
        return exIcon(main)+'<b class="scrsym">'+row.symbol.replace("_USDT","")+'</b>'+
          (strip?'<span class="exstrip">'+strip+'</span>':""); }
      case "pct":   { const up=row.rise>=0; return '<span class="'+(up?"up":"down")+'">'+(up?"+":"")+(row.rise||0).toFixed(2)+"%</span>"; }
      case "num":   return fmtNum(row[col.k]);
      case "usd":   return fmtUsd(row[col.k]);
      case "spr":   return (row.spread||0).toFixed(3)+"%";
      case "num3":  return (row[col.k]||0).toFixed(3);
      case "signpct": { const v=row[col.k]||0; return '<span class="'+(v>=0?"up":"down")+'">'+(v>=0?"+":"")+v.toFixed(2)+"%</span>"; }
      case "signusd": { const v=row[col.k]||0; return '<span class="'+(v>=0?"up":"down")+'">'+(v>=0?"+":"−")+fmtUsd(Math.abs(v))+"</span>"; }
      case "price": return (row.last||0).toString();
      case "act":   { const a=Math.max(0,Math.min(100,row.act||0)); return '<span class="actbar"><i style="width:'+a+'%"></i></span>'; }
      case "scol":  { const a=Math.max(0,Math.min(100,row.scoll||0)); return '<span class="actbar" title="Скор сбора спреда: жирный тик × прострелы × свипы, гейт по ликвидности"><i style="width:'+a+'%;background:linear-gradient(90deg,#3b82f6,#22d3ee)"></i></span> <b style="font-size:10px;color:#7cc4ff">'+a+'</b>'; }
      default: return row[col.k];
    }
  }

  // ── применить фильтры ──
  function pass(row){
    for(const k in CFG.filters){ const f=CFG.filters[k]; if(!f) continue;
      const v = k==="coin" ? 0 : (row[k]||0);
      if(f.min!=null && f.min!=="" && v < +f.min) return false;
      if(f.max!=null && f.max!=="" && v > +f.max) return false;
    }
    return true;
  }

  // ── EDGE-триггер: звук/подсветка при ВХОДЕ монеты в набор прошедших фильтр (не level, не каждый тик) ──
  let prevPass = new Set();          // символы, проходившие фильтр в прошлом кадре
  let firstPass = true;              // первый расчёт — только засеять набор, без оповещений
  const hlUntil = {};                // symbol -> ts подсветки строки
  function hasActiveFilter(){ return Object.keys(CFG.filters).some(k=>{ const f=CFG.filters[k]; return f && ((f.min!=null&&f.min!=="")||(f.max!=null&&f.max!=="")); }); }
  function edgeAlerts(passed){
    const now=Date.now(), curSet=new Set();
    const filt=hasActiveFilter();
    for(const r of passed){ curSet.add(r.symbol);
      if(!firstPass && filt && !prevPass.has(r.symbol)){            // переход «не проходила → проходит»
        const last=muteMap[r.symbol]||0;
        if(now-last >= (CFG.mute||30)*1000){                        // кулдаун на символ
          muteMap[r.symbol]=now; hlUntil[r.symbol]=now+2500;        // подсветка строки 2.5с
          if(CFG.sound){ try{ if(typeof beep==="function") beep(r.rise>=0?1:2, true); }catch(e){} }
          try{ if(typeof notify==="function") notify("Скринер: "+r.symbol.replace("_USDT","")+" под фильтром","info"); }catch(e){}
        }
      }
    }
    prevPass=curSet; firstPass=false;
  }

  function sortRows(rows){
    const k=CFG.sort, dir=CFG.dir;
    return rows.slice().sort((a,b)=>{ let av,bv;
      if(k==="coin"){ av=a.symbol; bv=b.symbol; return dir*(av<bv?-1:av>bv?1:0); }
      av=a[k]||0; bv=b[k]||0; return dir*(av-bv); });
  }

  const DEFW = {coin:210,rise:78,trades:70,amt:92,act:80,scoll:92,wall:88,spread:70,natr:70,dpct:74,dusd:84,vspike:82,tspike:86,funding:74,oipct:70,oiusd:84,vol:70,last:80};
  function colW(k){ return (CFG.colW&&CFG.colW[k])||DEFW[k]||80; }
  function applyCols(){                                  // ширины колонок через <colgroup> (table-layout:fixed)
    const cg=g("scrcolgroup"); if(!cg) return; let h="";
    for(const c of COLS){ if(CFG.cols.indexOf(c.k)<0) continue; h+='<col style="width:'+colW(c.k)+'px">'; }
    cg.innerHTML=h;
  }
  function renderHead(){
    const th=g("scrhead"); if(!th) return; applyCols(); let h="<tr>";
    for(const c of COLS){ if(CFG.cols.indexOf(c.k)<0) continue;
      const on=CFG.sort===c.k; const arr=on?(CFG.dir<0?" ▼":" ▲"):"";
      h+='<th data-k="'+c.k+'" class="'+(c.kind==="coin"?"":"num")+(on?" sorton":"")+'">'+c.t+arr+'<span class="colrz" data-k="'+c.k+'"></span></th>'; }
    h+="</tr>"; th.innerHTML=h;
    th.querySelectorAll("th").forEach(el=>{ el.onclick=(e)=>{ if(e.target.classList.contains("colrz")) return; const k=el.dataset.k;
      if(CFG.sort===k) CFG.dir=-CFG.dir; else { CFG.sort=k; CFG.dir=(k==="coin")?1:-1; } save(); renderHead(); render(); }; });
    // ресайз колонок мышью за правый край заголовка
    th.querySelectorAll(".colrz").forEach(rz=>{ rz.addEventListener("mousedown",(e)=>{ e.preventDefault(); e.stopPropagation();
      const k=rz.dataset.k, sx=e.clientX, sw=colW(k);
      const mv=(ev)=>{ CFG.colW=CFG.colW||{}; CFG.colW[k]=Math.max(40, sw+ev.clientX-sx); applyCols(); };
      const up=()=>{ save(); window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up); };
      window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up); }); });
  }

  function render(){
    const tb=g("scrrows"); if(!tb) return;
    const cur=(typeof S!=="undefined"&&S.symbol)||"";
    const passed=rowsRaw.filter(pass);
    edgeAlerts(passed);                                  // edge-триггер звука/подсветки по набору прошедших
    const keyOf=(r)=>r.symbol+"|"+(r.ex||"ourbit");
    let rows;
    if(frozen && frozenSyms){                            // заморозка: тот же порядок/состав, значения свежие
      const m={}; for(const r of passed) m[keyOf(r)]=r;
      rows=frozenSyms.map(k=>m[k]).filter(Boolean);
    } else {
      rows=sortRows(passed).slice(0, Math.max(1, CFG.topN||20));
      lastShownKeys=rows.map(keyOf);
    }
    if(!rows.length){ if(tb.children.length) tb.innerHTML=""; return; }   // пусто → просто чисто, без надписи (появится само)
    const nowT=Date.now(); let html="";
    for(const row of rows){ const active=(row.symbol===cur&&(row.ex||"ourbit")==="ourbit")?" active":"";
      const hl=(hlUntil[row.symbol]||0)>nowT?" scrhit":"";      // подсветка недавно вошедших под фильтр
      html+='<tr data-sym="'+row.symbol+'" data-ex="'+(row.ex||"ourbit")+'" class="scrrow'+active+hl+'">';
      for(const c of COLS){ if(CFG.cols.indexOf(c.k)<0) continue;
        html+='<td class="'+(c.kind==="coin"?"coin":"num")+'">'+cell(c,row)+"</td>"; }
      html+="</tr>";
    }
    tb.innerHTML=html;
    tb.querySelectorAll(".scrrow").forEach(tr=>{ tr.onclick=()=>{ const sym=tr.dataset.sym, ex=tr.dataset.ex;
      if(ex && ex!=="ourbit"){ if(typeof notify==="function") notify("Линк только для Ourbit; "+sym.replace("_USDT","")+" на "+ex.toUpperCase()+" — данные скринера","info"); return; }
      if(typeof switchSymbol==="function"&&sym){ switchSymbol(sym); const inp=g("symbol"); if(inp) inp.value=sym.replace("_USDT",""); } }; });
  }

  async function poll(){
    // при заморозке ДАННЫЕ продолжают тикать, но порядок/состав строк не меняются (см. render)
    const w=(g("scrwin-win")&&g("scrwin-win").value)||"1";   // TF в минутах (M1..M60)
    const ex=(CFG.exchanges&&CFG.exchanges.length?CFG.exchanges:["ourbit"]).join(",");
    const tfs=CFG.tfs&&Object.keys(CFG.tfs).length?("&tfs="+encodeURIComponent(JSON.stringify(CFG.tfs))):"";
    const xex=(CFG.exExcluded&&CFG.exExcluded.length)?("&xex="+encodeURIComponent(CFG.exExcluded.join(","))):"";
    let r; try{ r=await fetch("/api/screener?win="+w+"&n=200&ex="+encodeURIComponent(ex)+tfs+xex).then(x=>x.json()); }catch(e){ return; }
    if(!r||!r.ok) return; rowsRaw=r.rows||[]; render();
  }

  // ── модалка настроек ──
  function buildSettings(){
    const cols=g("scrset-cols"); if(cols){ cols.innerHTML="";
      for(const c of COLS){ const l=document.createElement("label"); l.className="chk";
        const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=CFG.cols.indexOf(c.k)>=0; cb.dataset.k=c.k;
        cb.onchange=()=>{ const k=cb.dataset.k; if(cb.checked){ if(CFG.cols.indexOf(k)<0) CFG.cols.push(k); } else CFG.cols=CFG.cols.filter(x=>x!==k); save(); renderHead(); render(); };
        l.appendChild(cb); l.appendChild(document.createTextNode(" "+c.t)); cols.appendChild(l); }
    }
    const fl=g("scrset-filters"); if(fl){ fl.innerHTML="";
      for(const c of COLS){ if(c.kind==="coin"||c.kind==="act") continue;
        const f=CFG.filters[c.k]||{}; const row=document.createElement("div"); row.className="scrfrow";
        row.innerHTML='<span>'+c.t+'</span>';
        const mn=document.createElement("input"); mn.type="number"; mn.placeholder="мин"; mn.value=f.min!=null?f.min:"";
        const mx=document.createElement("input"); mx.type="number"; mx.placeholder="макс"; mx.value=f.max!=null?f.max:"";
        const upd=()=>{ CFG.filters[c.k]={min:mn.value===""?"":+mn.value, max:mx.value===""?"":+mx.value}; save(); render(); };
        mn.oninput=upd; mx.oninput=upd; row.append(mn,mx);
        if(TF_METRICS.has(c.k)){                                   // per-metric таймфрейм (пусто = как общий TF)
          const tf=document.createElement("select"); tf.className="scrtf"; tf.title="таймфрейм метрики";
          tf.innerHTML='<option value="">TF</option>'+TF_OPTS.map(m=>'<option value="'+m+'"'+((CFG.tfs&&CFG.tfs[c.k]==m)?" selected":"")+'>M'+m+'</option>').join("");
          tf.onchange=()=>{ CFG.tfs=CFG.tfs||{}; if(tf.value) CFG.tfs[c.k]=+tf.value; else delete CFG.tfs[c.k]; save(); poll(); };
          row.append(tf);
        }
        fl.appendChild(row); }
    }
    const tn=g("scrset-topn"); if(tn) tn.value=CFG.topN;
    const fz=g("scrset-freeze"); if(fz) fz.checked=CFG.freeze!==false;
    const sd=g("scrset-sound"); if(sd) sd.checked=CFG.sound===true;
    const st=g("scrset-strip"); if(st) st.checked=CFG.showStrip!==false;
    const mu=g("scrset-mute"); if(mu) mu.value=CFG.mute;
    wireExchanges();
    refreshTplList();
  }
  // 3-состояние фида биржи: главная (метрики+стакан) → бейдж (просто в полоске) → исключён ✕ (нигде)
  function feedEx(baseEx, feed){ return feed==="S" ? baseEx+"spot" : baseEx; }
  function feedState(ex){
    if((CFG.exExcluded||[]).indexOf(ex)>=0) return "excl";
    if((CFG.exchanges||[]).indexOf(ex)>=0) return "main";
    return "badge"; }
  function applyFeedState(fb, ex){ const s=feedState(ex);
    fb.classList.toggle("on", s==="main"); fb.classList.toggle("excl", s==="excl");
    fb.title = "ЛКМ: показать монеты этой биржи в скринере (главная) · ПКМ: исключить биржу (красный ✕)"; }
  const _rm=(a,ex)=>{ const i=a.indexOf(ex); if(i>=0) a.splice(i,1); };
  function toggleMain(ex){                                            // ЛКМ: источник вкл/выкл (зелёный)
    CFG.exchanges=(CFG.exchanges||[]).slice(); CFG.exExcluded=(CFG.exExcluded||[]).slice();
    _rm(CFG.exExcluded, ex);                                          // включение источника снимает исключение
    const i=CFG.exchanges.indexOf(ex); if(i>=0) CFG.exchanges.splice(i,1); else CFG.exchanges.push(ex);
    if(!CFG.exchanges.length) CFG.exchanges=["ourbit"]; save(); }
  function toggleExcl(ex){                                            // ПКМ: исключить/вернуть (красный)
    CFG.exchanges=(CFG.exchanges||[]).slice(); CFG.exExcluded=(CFG.exExcluded||[]).slice();
    const i=CFG.exExcluded.indexOf(ex); if(i>=0) CFG.exExcluded.splice(i,1); else { _rm(CFG.exchanges, ex); CFG.exExcluded.push(ex); }
    if(!CFG.exchanges.length) CFG.exchanges=["ourbit"]; save(); }
  function refreshRow(rw){ let any=false;
    rw.querySelectorAll(".exsf[data-feed]").forEach(fb=>{ applyFeedState(fb, feedEx(rw.dataset.ex, fb.dataset.feed));
      if(fb.classList.contains("on")) any=true; });
    rw.classList.toggle("on", any); }
  function wireExchanges(){
    document.querySelectorAll(".exrow[data-ex]").forEach(rw=>{
      const baseEx=rw.dataset.ex;
      const nm=rw.querySelector("span");                           // ярлык биржи (иконка) перед названием
      if(nm){ if(nm.dataset.nm==null) nm.dataset.nm=nm.textContent.replace(/^[^\wА-Яа-я]+/,"").trim();
        nm.innerHTML=exIcon(baseEx)+nm.dataset.nm; }
      rw.querySelectorAll(".exsf[data-feed]").forEach(fb=>{
        const ex=feedEx(baseEx, fb.dataset.feed);
        fb.onclick=(e)=>{ e.stopPropagation(); toggleMain(ex); refreshRow(rw); poll(); };
        fb.oncontextmenu=(e)=>{ e.preventDefault(); e.stopPropagation(); toggleExcl(ex); refreshRow(rw); poll(); };
      });
      refreshRow(rw);
    });
  }
  function _tpls(){ try{ return JSON.parse(localStorage.getItem("scr.tpls"))||{}; }catch(e){ return {}; } }
  function _saveTpls(o){ try{ localStorage.setItem("scr.tpls", JSON.stringify(o)); }catch(e){} }
  function refreshTplList(){ const s=g("scrset-tpl"); if(!s) return; const o=_tpls(); s.innerHTML="";
    for(const nm in o){ const op=document.createElement("option"); op.value=nm; op.textContent=nm; s.appendChild(op); } }

  function wireSettings(){
    const gearb=g("scrgear"); if(gearb) gearb.onclick=(e)=>{ e.stopPropagation(); buildSettings(); g("scrset").classList.remove("hidden"); };
    const cl=g("scrset-close"); if(cl) cl.onclick=()=>g("scrset").classList.add("hidden");
    const m=g("scrset"); if(m) m.onclick=(e)=>{ if(e.target===m) m.classList.add("hidden"); };
    const applyBasic=()=>{ CFG.topN=Math.max(1,parseInt(g("scrset-topn").value,10)||20);
      CFG.freeze=g("scrset-freeze").checked; CFG.sound=g("scrset-sound").checked; CFG.mute=Math.max(0,parseInt(g("scrset-mute").value,10)||30);
      if(g("scrset-strip")) CFG.showStrip=g("scrset-strip").checked; save(); render(); };
    const sv=g("scrset-save"); if(sv) sv.onclick=()=>{ applyBasic(); const nm=(g("scrset-name").value||"").trim();
      if(nm){ const o=_tpls(); o[nm]=JSON.parse(JSON.stringify(CFG)); _saveTpls(o); refreshTplList(); } };
    const svc=g("scrset-saveclose"); if(svc) svc.onclick=()=>{ applyBasic(); g("scrset").classList.add("hidden"); };
    const rs=g("scrset-reset"); if(rs) rs.onclick=()=>{ CFG=JSON.parse(JSON.stringify(DEF)); save(); buildSettings(); renderHead(); render(); };
    const ld=g("scrset-load"); if(ld) ld.onclick=()=>{ const s=g("scrset-tpl"); const o=_tpls(); const t=o[s&&s.value];
      if(t){ CFG=Object.assign({}, DEF, t, {filters:t.filters||{}}); save(); buildSettings(); renderHead(); render(); } };
    const dl=g("scrset-del"); if(dl) dl.onclick=()=>{ const s=g("scrset-tpl"); const o=_tpls(); if(s&&o[s.value]){ delete o[s.value]; _saveTpls(o); refreshTplList(); } };
  }

  function open(){ const wasTiled=win.classList.contains("tiled");
    win.classList.remove("hidden"); win.classList.remove("tiled"); win.classList.remove("collapsed");   // развернуть, если было свёрнуто (тело таблицы пряталось)
    if(win.parentElement!==document.body) document.body.appendChild(win);   // вытащить из тайла воркспейса
    win.style.zIndex=45;
    // если окно было в тайле / уехало за экран — вернуть в нормальную плавающую позицию
    const r=win.getBoundingClientRect();
    if(wasTiled||r.width<120||r.height<80||r.right<60||r.bottom<60||r.left>innerWidth-60||r.top>innerHeight-40||(r.left<40&&r.top<90)){
      win.style.left="auto"; win.style.right="20px"; win.style.top="120px"; win.style.width="620px"; win.style.height="520px"; }
    renderHead(); poll(); if(timer) clearInterval(timer); timer=setInterval(poll,1500); }   // ~0.7Гц каденс (мягче нагрузка)
  function close(){ win.classList.add("hidden"); if(timer){ clearInterval(timer); timer=null; } }

  function wire(){
    const btn=g("scrbtn"); if(btn) btn.onclick=()=>{
      const vis=!win.classList.contains("hidden")&&!win.classList.contains("tiled");   // «открыт» = нормальное плавающее окно
      vis?close():open(); };   // если tiled/скрыт — открыть и вытащить из тайла (а не закрыть)
    const x=g("scrclose"); if(x) x.onclick=close;
    const sel=g("scrwin-win"); if(sel) sel.onchange=poll;
    const lk=g("scr-link"); if(lk){ lk.checked=!!window.linkOn; lk.onchange=()=>{ window.linkOn=lk.checked; }; }
    // заморозка при наведении на тело таблицы
    const body=g("scrbody"); if(body){
      body.addEventListener("mouseenter",()=>{ if(CFG.freeze!==false){ frozen=true; frozenSyms=lastShownKeys.slice(); } });
      body.addEventListener("mouseleave",()=>{ frozen=false; frozenSyms=null; render(); }); }   // ушёл курсор → пересортировка
    if(window.Dock) window.Dock.makeWindow({ win, handle:g("scrdrag"), titleBar:g("scrdrag"), resize:g("scrres"), key:"screener", minW:360, minH:220 });
    wireSettings(); renderHead();
    if(document.documentElement.classList.contains("scr-embed")) open();   // отдельное окно скринера (iframe) — сразу открыть
  }
  wire();
})();
