"use strict";
// КЛАССИКА — формации ТС на Binance 5м: лента алертов (пробои уровней/наклонок/боковиков)
// + график со свечами, уровнями (оранжевые линии как на схемах), наклонками, ТВХ/СТОП/ТЕЙК.
(function(){
  const g=(id)=>document.getElementById(id);
  const K={ lastId:0, alerts:[], sel:null, chart:null, timer:null, ctimer:null,
            cfg:JSON.parse(localStorage.getItem("clas.cfg")||"{}") };
  if(K.cfg.sound===undefined) K.cfg.sound=true;

  // ── стили (свои, чтобы не трогать style.css) ──
  const css=document.createElement("style"); css.textContent=`
  #claswin{display:flex;flex-direction:column}
  #clasbody{display:flex;flex:1;min-height:0}
  #clasfeed{width:230px;min-width:230px;overflow-y:auto;border-right:1px solid rgba(255,255,255,.07);padding:4px}
  #claschart{flex:1;position:relative;min-width:0}
  #clascv{position:absolute;inset:0;width:100%;height:100%}
  .clascard{border:1px solid rgba(255,255,255,.09);border-radius:6px;padding:5px 7px;margin-bottom:5px;cursor:pointer;font:11px ui-monospace,Consolas,monospace;background:rgba(255,255,255,.02)}
  .clascard:hover{background:rgba(255,255,255,.06)}
  .clascard.sel{border-color:#e6a943;background:rgba(230,169,67,.08)}
  .clascard .cc1{display:flex;gap:6px;align-items:center;margin-bottom:2px}
  .clascard .sym{font-weight:700;color:#dfe6ee}
  .clascard .dir{font-size:9px;font-weight:700;border-radius:3px;padding:0 4px}
  .clascard .dir.L{background:rgba(46,160,67,.25);color:#4be38a}
  .clascard .dir.S{background:rgba(224,82,77,.25);color:#ff8a86}
  .clascard .tf{font-size:9px;font-weight:700;border-radius:3px;padding:0 4px;background:rgba(159,192,255,.16);color:#9fc0ff}
  #clashead .chip.tf{background:rgba(159,192,255,.16);color:#9fc0ff}
  .clascard .kind{color:#e6a943}
  .clascard .meta{color:#5b6573;font-size:10px}
  #clashead{display:flex;gap:10px;align-items:center;padding:3px 8px;font:11px ui-monospace,Consolas,monospace;color:#8a929c;border-bottom:1px solid rgba(255,255,255,.07);flex-wrap:wrap}
  #clashead b{color:#e6a943}
  #clashead .chip{border-radius:4px;padding:1px 6px;background:rgba(255,255,255,.05)}
  #clasttl input[type=number]{width:70px}
  .clasempty{color:#5b6573;font:11px ui-monospace,monospace;padding:10px}`;
  document.head.appendChild(css);

  // ── окно ──
  const win=document.createElement("div");
  win.id="claswin"; win.className="wbwin hidden";
  win.style.cssText="left:auto;right:24px;top:110px;width:860px;height:560px";
  win.innerHTML=`
    <div class="wbtitle" id="clasdrag">
      <span class="wbcoin">📈 КЛАССИКА</span>
      <span id="clasttl" style="display:flex;gap:6px;align-items:center;font-size:10px">
        <label title="мин. объём за 24 часа, $ (фильтр активных монет Binance)">24ч объём≥<input type="number" id="clas-minvol" step="1000000"></label>
        <label title="звук нового алерта"><input type="checkbox" id="clas-sound">🔔</label>
        <label title="искать и шорт-формации"><input type="checkbox" id="clas-shorts">шорты</label>
      </span>
      <span class="wbsp"></span>
      <span id="clas-state" style="font-size:9px;color:#5b6573"></span>
      <button class="wbx" id="clasclose">×</button>
    </div>
    <div id="clashead"><span class="clasempty">Выбери алерт слева — покажу график с уровнями и ТВХ</span></div>
    <div id="clasbody">
      <div id="clasfeed"><div class="clasempty">Сканирую Binance 5м… формации появятся здесь</div></div>
      <div id="claschart"><canvas id="clascv"></canvas></div>
    </div>
    <div class="wbresize" id="clasres"></div>`;
  document.body.appendChild(win);

  // ── звук нового алерта (короткий бип) ──
  let _ac=null;
  function beep(){ if(!K.cfg.sound) return;
    try{ _ac=_ac||new (window.AudioContext||window.webkitAudioContext)();
      const o=_ac.createOscillator(), gn=_ac.createGain();
      o.type="sine"; o.frequency.value=880; gn.gain.setValueAtTime(.15,_ac.currentTime);
      gn.gain.exponentialRampToValueAtTime(.001,_ac.currentTime+.25);
      o.connect(gn); gn.connect(_ac.destination); o.start(); o.stop(_ac.currentTime+.26); }catch(e){} }

  // ── лента алертов ──
  const fmtT=(t)=>{ const d=new Date(t*1000); return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2); };
  const fmtP=(p)=>{ if(!isFinite(p))return"?"; return p>=100?p.toFixed(1):p>=1?p.toFixed(4):p.toFixed(6); };
  function renderFeed(){
    const box=g("clasfeed"); if(!box) return;
    if(!K.alerts.length){ box.innerHTML='<div class="clasempty">Пока формаций нет — сканер работает…</div>'; return; }
    box.innerHTML=K.alerts.map(a=>`
      <div class="clascard${K.sel&&K.sel.id===a.id?" sel":""}" data-id="${a.id}">
        <div class="cc1"><span class="sym">${a.sym.replace("USDT","")}</span>
          <span class="dir ${a.dir==="LONG"?"L":"S"}">${a.dir}</span>
          ${a.tf?('<span class="tf">'+a.tf+'</span>'):""}
          <span class="meta" style="margin-left:auto">${fmtT(a.t)}</span></div>
        <div class="kind">${a.kind}</div>
        <div class="meta">ур ${fmtP(a.level)} · ${a.zone||""}${a.touches?(" · "+a.touches+"кас"):""}${a.natr?(" · NATR "+a.natr):""}</div>
      </div>`).join("");
    box.querySelectorAll(".clascard").forEach(el=>{ el.onclick=()=>{
      const a=K.alerts.find(x=>x.id===+el.dataset.id); if(a){ K.sel=a; renderFeed(); loadChart(a.sym, a.tf); } }; });
  }
  function renderHead(){
    const h=g("clashead"), a=K.sel;
    if(!a){ h.innerHTML='<span class="clasempty">Выбери алерт слева — покажу график с уровнями и ТВХ</span>'; return; }
    const tp=a.take&&a.tvx?((Math.abs(a.take-a.tvx)/a.tvx*100)).toFixed(1)+"%":"";
    h.innerHTML=`<b>${a.sym.replace("USDT","")}</b>${a.tf?('<span class="chip tf">'+a.tf+'</span>'):""}<span class="chip">${a.kind}</span>
      <span class="chip" style="color:${a.dir==="LONG"?"#4be38a":"#ff8a86"}">${a.dir}</span>
      <span class="chip">ТВХ ${fmtP(a.tvx)}</span><span class="chip" style="color:#ff8a86">СТОП ${fmtP(a.stop)}</span>
      <span class="chip" style="color:#4be38a">ТЕЙК ${fmtP(a.take)}${tp?(" (+"+tp+")"):""}</span><span class="chip">${a.zone||""}</span>`;
  }

  async function poll(){
    try{ const r=await fetch("/api/classic/alerts?since="+K.lastId).then(x=>x.json());
      if(!r.ok) return;
      const st=r.state||{};
      const stEl=g("clas-state");
      stEl.textContent=`монет: ${st.scanned||0}/${st.symbols||0}`+(st.err?" ⚠":"");
      stEl.title=st.err||"";
      if(r.alerts&&r.alerts.length){
        K.alerts=r.alerts.concat(K.alerts).slice(0,80);
        if(K.lastId>0) beep();                     // на первую загрузку истории не пищим
        K.lastId=r.last_id||K.lastId; renderFeed();
      } else K.lastId=r.last_id||K.lastId;
    }catch(e){}
  }

  // ── график: свечи + уровни (оранжевые, как на схемах) + наклонки + ТВХ/СТОП/ТЕЙК ──
  async function loadChart(sym, tf){
    try{ const r=await fetch("/api/classic/chart?symbol="+encodeURIComponent(sym)+"&tf="+encodeURIComponent(tf||"5m")).then(x=>x.json());
      if(r.ok){ K.chart=r; renderHead(); draw(); } }catch(e){}
  }
  function draw(){
    const cv=g("clascv"), ch=K.chart; if(!cv||!ch) return;
    const body=cv.parentElement, W=body.clientWidth, H=body.clientHeight;
    if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
    const x2=cv.getContext("2d"); x2.clearRect(0,0,W,H);
    const P=window.LAD_PAL||{}, C_UP=P.candleUp||"#2ea043", C_DN=P.candleDown||"#e0524d",
          C_TXT=P.chartText||"#5b6573", C_GRID=P.chartGrid||"rgba(255,255,255,.05)", ORNG="#e6a943";
    const cs=ch.bars; if(!cs||!cs.length) return;
    let hi=-Infinity, lo=Infinity;
    for(const c of cs){ if(c[2]>hi)hi=c[2]; if(c[3]<lo)lo=c[3]; }
    const a=K.sel&&K.sel.sym===ch.sym?K.sel:null;
    if(a){ hi=Math.max(hi,a.take,a.level); lo=Math.min(lo,a.stop,a.level); }
    const pad=(hi-lo)*.07||1; hi+=pad; lo-=pad; const rng=hi-lo||1;
    const padR=64, N=cs.length, cw=(W-padR)/N, y=(p)=>H-(p-lo)/rng*H, dec=rng<0.01?6:rng<1?4:rng<50?2:1;
    x2.font="9px ui-monospace,Consolas,monospace";
    for(let i=0;i<=4;i++){ const p=lo+rng*i/4, yy=y(p);
      x2.strokeStyle=C_GRID; x2.beginPath(); x2.moveTo(0,yy); x2.lineTo(W-padR,yy); x2.stroke();
      x2.fillStyle=C_TXT; x2.fillText(p.toFixed(dec), W-padR+4, yy+3); }
    for(let i=0;i<N;i++){ const c=cs[i], xx=i*cw+cw/2, up=c[4]>=c[1], bw=Math.max(1,cw*.6);
      x2.strokeStyle=x2.fillStyle=up?C_UP:C_DN;
      x2.beginPath(); x2.moveTo(xx,y(c[2])); x2.lineTo(xx,y(c[3])); x2.stroke();
      const yo=y(c[1]), yc=y(c[4]);
      x2.fillRect(xx-bw/2, Math.min(yo,yc), bw, Math.max(1,Math.abs(yc-yo))); }
    // уровни: двойная оранжевая линия (стиль схем ТС)
    for(const L of (ch.levels||[])){ const yy=y(L.p);
      if(yy<-8||yy>H+8) continue;
      x2.strokeStyle=ORNG; x2.globalAlpha=.85; x2.lineWidth=1;
      x2.beginPath(); x2.moveTo(0,yy); x2.lineTo(W-padR,yy); x2.stroke();
      x2.globalAlpha=.4; x2.beginPath(); x2.moveTo(0,yy+2.5); x2.lineTo(W-padR,yy+2.5); x2.stroke();
      x2.globalAlpha=1; x2.fillStyle=ORNG; x2.fillText(L.touches+"×", W-padR-22, yy-3); }
    // наклонки
    for(const t of (ch.lines||[])){ const iEnd=N-1, pEnd=t.p1+t.slope*(iEnd-t.i1);
      x2.strokeStyle=ORNG; x2.globalAlpha=.9; x2.lineWidth=1.2;
      x2.beginPath(); x2.moveTo(t.i1*cw+cw/2, y(t.p1)); x2.lineTo(iEnd*cw+cw/2, y(pEnd)); x2.stroke(); x2.globalAlpha=1; }
    // выбранный алерт: ТВХ/СТОП/ТЕЙК + стрелка на пробойной свече
    if(a){
      const lines=[["ТВХ",a.tvx,"#dfe6ee"],["СТОП",a.stop,"#ff8a86"],["ТЕЙК",a.take,"#4be38a"]];
      for(const [lbl,p,col] of lines){ const yy=y(p);
        x2.strokeStyle=col; x2.setLineDash([5,4]); x2.beginPath(); x2.moveTo(0,yy); x2.lineTo(W-padR,yy); x2.stroke();
        x2.setLineDash([]); x2.fillStyle=col; x2.fillText(lbl+" "+fmtP(p), 6, yy-3); }
      const bi=cs.findIndex(c=>c[0]===a.t);
      if(bi>=0){ const xx=bi*cw+cw/2, yy=y(a.dir==="LONG"?cs[bi][3]:cs[bi][2]);
        x2.fillStyle=a.dir==="LONG"?"#4be38a":"#ff8a86"; x2.font="14px monospace";
        x2.fillText(a.dir==="LONG"?"▲":"▼", xx-5, a.dir==="LONG"?yy+16:yy-8); x2.font="9px ui-monospace,Consolas,monospace"; }
    }
  }

  // ── настройки ──
  function saveCfg(){ localStorage.setItem("clas.cfg", JSON.stringify(K.cfg)); }
  async function pushCfg(body){ try{ await fetch("/api/classic/cfg",{method:"POST",
    headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)}); }catch(e){} }
  function wireCfg(){
    const mv=g("clas-minvol"), sd=g("clas-sound"), sh=g("clas-shorts");
    fetch("/api/classic/alerts?since=999999999").then(x=>x.json()).then(r=>{
      if(r&&r.cfg){ mv.value=r.cfg.min24hvol; sh.checked=!!r.cfg.shorts; } }).catch(()=>{});
    sd.checked=!!K.cfg.sound;
    mv.onchange=()=>pushCfg({min24hvol:+mv.value||0});
    sh.onchange=()=>pushCfg({shorts:sh.checked});
    sd.onchange=()=>{ K.cfg.sound=sd.checked; saveCfg(); };
  }

  // ── открыть/закрыть ──
  function open(){ win.classList.remove("hidden"); win.style.zIndex=46;
    poll(); if(K.timer) clearInterval(K.timer); K.timer=setInterval(poll,5000);
    if(K.ctimer) clearInterval(K.ctimer);
    K.ctimer=setInterval(()=>{ if(K.sel) loadChart(K.sel.sym, K.sel.tf); else draw(); },15000);
    draw(); }
  function close(){ win.classList.add("hidden");
    if(K.timer){clearInterval(K.timer);K.timer=null;} if(K.ctimer){clearInterval(K.ctimer);K.ctimer=null;} }

  function wire(){
    const btn=g("clasbtn"); if(btn) btn.onclick=()=>{ win.classList.contains("hidden")?open():close(); };
    g("clasclose").onclick=close;
    new ResizeObserver(()=>draw()).observe(g("claschart"));
    if(window.Dock) window.Dock.makeWindow({ win, handle:g("clasdrag"), titleBar:g("clasdrag"),
      resize:g("clasres"), key:"classic", minW:520, minH:300 });
    wireCfg();
  }
  wire();
})();
