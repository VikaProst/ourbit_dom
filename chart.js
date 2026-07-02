"use strict";
// График — плавающее перетаскиваемое окно. Минутные ТФ из kline, секундные строятся из ленты сделок.
(function(){
  const C = { win:null, sym:"XAUT_USDT", tf:"Min1", candles:[], timer:null, zoom:1,
              secBuckets:new Map(), seen:new Set() };
  const $$ = (id)=>document.getElementById(id);
  const SECS = { Sec1:1, Sec15:15, Sec30:30 };

  // ── данные ──
  async function fetchMin(){
    try{ const r=await fetch("/api/kline?symbol="+encodeURIComponent(C.sym)+"&interval="+C.tf).then(x=>x.json());
      if(r.ok){ C.candles=r.candles||[]; render(); } }catch(e){}
  }
  async function fetchSec(){
    const sn=SECS[C.tf]||1;
    try{ const r=await fetch("/api/deals?symbol="+encodeURIComponent(C.sym)).then(x=>x.json());
      if(r.ok){ for(const d of (r.deals||[])){ const key=d.t+"-"+d.p+"-"+d.v;
          if(C.seen.has(key)) continue; C.seen.add(key);
          const b=Math.floor(d.t/1000/sn)*sn; let c=C.secBuckets.get(b);
          if(!c){ c={t:b,o:d.p,h:d.p,l:d.p,c:d.p,v:d.v||0,fp:new Map()}; C.secBuckets.set(b,c); }
          else { c.h=Math.max(c.h,d.p); c.l=Math.min(c.l,d.p); c.c=d.p; c.v=(c.v||0)+(d.v||0); }
          const cell=c.fp.get(d.p)||{b:0,s:0}; if(d.side===1) cell.b+=d.v||0; else cell.s+=d.v||0; c.fp.set(d.p,cell); }
        if(C.seen.size>6000) C.seen=new Set();
        C.candles=Array.from(C.secBuckets.values()).sort((a,b)=>a.t-b.t).slice(-400);
        render(); } }catch(e){}
  }
  function poll(){ (SECS[C.tf]?fetchSec:fetchMin)(); }

  function render(){
    const cv=$$("chartcv"); if(!cv) return; const body=cv.parentElement;
    const W=body.clientWidth, H=body.clientHeight;
    if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
    const g=cv.getContext("2d"); g.clearRect(0,0,W,H);
    const P=window.LAD_PAL||{}, C_UP=P.candleUp||"#2ea043", C_DN=P.candleDown||"#e0524d",
          C_TXT=P.chartText||"#5b6573", C_GRID=P.chartGrid||"rgba(255,255,255,.05)", C_LAST=P.chartLast||"#e6a943";
    let cs=C.candles; if(!cs.length){ g.fillStyle=C_TXT; g.font="10px monospace"; g.fillText("сбор данных…",10,20); return; }
    const visN=Math.max(8, Math.round(cs.length*C.zoom));
    const pan=Math.max(0, Math.min(Math.max(0,cs.length-visN), C.pan||0));   // горизонтальный пан
    cs=cs.slice(Math.max(0,cs.length-visN-pan), cs.length-pan);
    const N=cs.length; let hi=-Infinity, lo=Infinity;
    for(const c of cs){ if(c.h>hi)hi=c.h; if(c.l<lo)lo=c.l; }
    const pad=(hi-lo)*0.08||1; hi+=pad; lo-=pad; const rng=hi-lo||1;
    const volH=Math.min(70, Math.round(H*0.18)), priceH=H-volH;   // нижние ~18% — объём под свечами
    const dec=(rng<1?4:rng<50?2:1), padR=60, cw=(W-padR)/N, y=(p)=>priceH-(p-lo)/rng*priceH;
    C._cw=cw; C._priceH=priceH; C._lo=lo; C._rng=rng;
    g.font="9px ui-monospace,Consolas,monospace"; g.textAlign="left";
    for(let i=0;i<=4;i++){ const p=lo+rng*i/4, yy=y(p);
      g.strokeStyle=C_GRID; g.beginPath(); g.moveTo(0,yy); g.lineTo(W-padR,yy); g.stroke();
      g.fillStyle=C_TXT; g.fillText(p.toFixed(dec), W-padR+4, yy+3); }
    // объёмные бары (нижняя зона)
    let maxV=0; for(const c of cs){ if((c.v||0)>maxV) maxV=c.v; }
    if(maxV>0){ for(let i=0;i<N;i++){ const c=cs[i], x=i*cw+cw/2, up=c.c>=c.o, bw=Math.max(1,cw*0.62);
      const vh=Math.max(1,(c.v||0)/maxV*(volH-4)); g.fillStyle=up?C_UP:C_DN; g.globalAlpha=0.45;
      g.fillRect(x-bw/2, H-vh, bw, vh); } g.globalAlpha=1; }
    const foot = C.foot && SECS[C.tf];
    if(foot){
      // ── ФУТПРИНТ: per-price дельта-ячейки внутри свечного столбца ──
      let minGap=Infinity, prev, maxCell=0, anyFp=false;
      for(const c of cs){ if(!c.fp||!c.fp.size) continue; anyFp=true;
        const ps=[...c.fp.keys()].map(Number).sort((a,b)=>a-b);
        for(let k=0;k<ps.length;k++){ const cell=c.fp.get(ps[k]); const tot=(cell.b||0)+(cell.s||0); if(tot>maxCell)maxCell=tot;
          if(k>0){ const gp=ps[k]-ps[k-1]; if(gp>1e-12 && gp<minGap) minGap=gp; } } }
      if(anyFp && maxCell>0){
        const tick=(minGap===Infinity)?rng/40:minGap, cellPx=Math.max(2,Math.min(22,tick/rng*priceH));
        const wide=cw>46; g.textAlign="center"; g.font="8px ui-monospace,Consolas,monospace";
        for(let i=0;i<N;i++){ const c=cs[i]; if(!c.fp||!c.fp.size) continue; const x0=i*cw+1, w=Math.max(2,cw-2);
          for(const [pk,cell] of c.fp){ const p=+pk, tot=(cell.b||0)+(cell.s||0); if(tot<=0) continue;
            const yy=y(p)-cellPx/2, dl=(cell.b||0)-(cell.s||0), a=0.14+0.66*Math.min(1,tot/maxCell);
            g.globalAlpha=a; g.fillStyle=dl>=0?C_UP:C_DN; g.fillRect(x0,yy,w,Math.max(1,cellPx-1)); g.globalAlpha=1;
            if(wide && cellPx>=8){ g.fillStyle="rgba(232,236,242,.85)"; g.fillText((cell.b||0).toFixed(0)+"×"+(cell.s||0).toFixed(0), x0+w/2, yy+cellPx-1.5); } }
          // тонкий HL-фитиль поверх для структуры
          const xm=i*cw+cw/2; g.strokeStyle="rgba(150,158,170,.5)"; g.beginPath(); g.moveTo(xm,y(c.h)); g.lineTo(xm,y(c.l)); g.stroke(); }
        g.textAlign="left";
      } else { g.fillStyle=C_TXT; g.fillText("футпринт: сбор сделок…",10,34); }
    } else {
      for(let i=0;i<N;i++){ const c=cs[i], x=i*cw+cw/2, up=c.c>=c.o;
        g.strokeStyle=up?C_UP:C_DN; g.fillStyle=up?C_UP:C_DN;
        g.beginPath(); g.moveTo(x,y(c.h)); g.lineTo(x,y(c.l)); g.stroke();
        const bw=Math.max(1,cw*0.62), yo=y(c.o), yc=y(c.c);
        g.fillRect(x-bw/2, Math.min(yo,yc), bw, Math.max(1,Math.abs(yc-yo))); }
    }
    const last=cs[N-1].c;
    g.strokeStyle=C_LAST; g.setLineDash([3,3]); g.beginPath(); g.moveTo(0,y(last)); g.lineTo(W-padR,y(last)); g.stroke(); g.setLineDash([]);
    g.fillStyle=C_LAST; g.fillText(last.toFixed(dec), W-padR+4, y(last)+3);
    // КРОССХЭЙР: линии + цена справа + O/H/L/C наведённой свечи
    if(C.mx!=null && C.my!=null && C.mx<W-padR && C.my>0 && C.my<H){
      g.strokeStyle="rgba(210,216,224,.35)"; g.setLineDash([2,3]); g.lineWidth=1;
      g.beginPath(); g.moveTo(Math.round(C.mx)+0.5,0); g.lineTo(Math.round(C.mx)+0.5,H);
      g.moveTo(0,Math.round(C.my)+0.5); g.lineTo(W-padR,Math.round(C.my)+0.5); g.stroke(); g.setLineDash([]);
      if(C.my<priceH){ const pr=lo+(priceH-C.my)/priceH*rng;
        g.fillStyle="#1c1f24"; g.fillRect(W-padR,C.my-8,padR,16); g.fillStyle="#e6e8ea"; g.textAlign="left"; g.fillText(pr.toFixed(dec),W-padR+4,C.my+3); }
      const ci=Math.max(0,Math.min(N-1,Math.floor(C.mx/cw))), cc=cs[ci];
      if(cc){ g.fillStyle="#0d1117"; g.fillRect(0,0,190,14); g.fillStyle="#9aa2ac"; g.textAlign="left";
        g.fillText("O "+cc.o.toFixed(dec)+"  H "+cc.h.toFixed(dec)+"  L "+cc.l.toFixed(dec)+"  C "+cc.c.toFixed(dec), 4, 8); }
    }
  }

  function setTf(tf){ C.tf=tf; C.secBuckets=new Map(); C.seen=new Set(); C.candles=[];
    if(C.timer) clearInterval(C.timer); poll(); C.timer=setInterval(poll, SECS[tf]?500:3000); }
  function setSym(sym){ C.sym=sym; C.secBuckets=new Map(); C.seen=new Set(); C.candles=[]; poll(); }

  window.openChart=function(sym){
    if(sym) C.sym=sym;
    const ci=$$("chartsym"); if(ci) ci.value=C.sym.replace("_USDT","");
    const w=C.win; if(!w) return;
    // самоисцеление: вытащить график из тайла/встраивания/свёрнутого → чистое плавающее видимое окно
    try{ if(w.classList.contains("embedded")) popOut(); }catch(e){}
    w.classList.remove("collapsed");                    // развернуть, если было свёрнуто (виден только заголовок)
    if(window.untileFloat){ window.untileFloat(w,{right:20,top:58,w:520,h:360}); }
    else { w.classList.remove("hidden","tiled"); if(w.parentElement!==document.body) document.body.appendChild(w); }
    if(w.offsetHeight<140){ w.style.height="360px"; if(w.offsetWidth<300) w.style.width="520px"; }  // гарантия видимого размера
    C.embedded=false; const eb=$$("chartembed"); if(eb) eb.textContent="⤓";
    setTf(C.tf); requestAnimationFrame(render);          // рендер после layout (корректная высота canvas)
  };
  // встраивание графика ВНУТРЬ окна стакана (сверху/снизу, с делителем — тянуть высоту)
  function embedChart(pos){ const dock=$$("chartdock"); if(!dock||!C.win) return;
    const body=$$("bookbody"); if(body) body.classList.toggle("chart-bottom", pos==="bottom");
    C.pos=pos==="bottom"?"bottom":"top";
    C.win.classList.remove("hidden"); C.win.classList.add("embedded"); dock.appendChild(C.win);
    dock.style.height=(C._h||300)+"px"; const rz=$$("chartdockres"); if(rz) rz.style.display="block";
    C.embedded=true; const eb=$$("chartembed"); if(eb) eb.textContent="⤢"; setTf(C.tf); render(); }
  window.embedChart=embedChart; window.popOutChart=()=>popOut();
  window.setChartSym=(full)=>{ if(!full) return; const ci=$$("chartsym"); if(ci) ci.value=full.replace("_USDT",""); setSym(full); };
  function popOut(){ const dock=$$("chartdock"); const body=$$("bookbody"); if(body) body.classList.remove("chart-bottom");
    C.win.classList.remove("embedded"); document.body.appendChild(C.win);
    if(dock) dock.style.height="0"; const rz=$$("chartdockres"); if(rz) rz.style.display="none";
    C.embedded=false; const eb=$$("chartembed"); if(eb) eb.textContent="⤓";
    C.win.style.left="auto"; C.win.style.right="20px"; C.win.style.top="58px"; C.win.style.width="520px"; C.win.style.height="360px"; render(); }
  function init(){
    C.win=$$("chartwin"); if(!C.win) return;
    if(window.Dock) window.Dock.makeWindow({ win:C.win, handle:$$("chartdrag"), titleBar:$$("chartdrag"),
      resize:$$("chartres"), key:"chart", minW:300, minH:220, onResize:render });
    const eb=$$("chartembed"); if(eb) eb.onclick=(e)=>{ e.stopPropagation(); C.embedded?popOut():embedChart(); };
    const fb=$$("chartfoot"); if(fb) fb.onclick=(e)=>{ e.stopPropagation(); C.foot=!C.foot; fb.classList.toggle("on",C.foot);
      if(C.foot && !SECS[C.tf]) setTf("Sec15"); else render(); };
    const dres=$$("chartdockres"); if(dres){ let on=false,sy=0,sh=0;
      dres.addEventListener("mousedown",(e)=>{ on=true; sy=e.clientY; sh=$$("chartdock").offsetHeight; e.preventDefault(); });
      window.addEventListener("mousemove",(e)=>{ if(!on) return; const h=Math.max(120,Math.min(760,sh+e.clientY-sy)); const dk=$$("chartdock"); dk.style.height=h+"px"; C._h=h; render(); });
      window.addEventListener("mouseup",()=>{ on=false; }); }
    $$("chartclose").onclick=()=>{ if(C.embedded) popOut(); C.win.classList.add("hidden"); if(C.timer){ clearInterval(C.timer); C.timer=null; } };
    $$("charttf").onchange=()=>setTf($$("charttf").value);
    const ci=$$("chartsym"); if(ci) ci.addEventListener("change",()=>{ const v=ci.value.trim().toUpperCase(); if(!v) return;
      let full=null; try{ if(typeof S!=="undefined"&&S.symMap) full=S.symMap[v]; }catch(e){}
      full=full||(v.endsWith("_USDT")?v:v+"_USDT"); ci.value=full.replace("_USDT",""); setSym(full); });
    const cv=$$("chartcv"); if(cv){ let panOn=false, psx=0, pst=0;
      cv.addEventListener("wheel",(e)=>{ e.preventDefault();
        C.zoom=Math.max(0.12,Math.min(1, C.zoom*(e.deltaY<0?0.88:1.14))); render(); },{passive:false});
      cv.addEventListener("mousedown",(e)=>{ panOn=true; psx=e.clientX; pst=C.pan||0; cv.style.cursor="grabbing"; });
      window.addEventListener("mouseup",()=>{ panOn=false; if(cv) cv.style.cursor="crosshair"; });
      cv.addEventListener("mousemove",(e)=>{ const r=cv.getBoundingClientRect(); C.mx=e.clientX-r.left; C.my=e.clientY-r.top;
        if(panOn){ C.pan=Math.max(0, pst+Math.round((e.clientX-psx)/(C._cw||8))); }
        render(); });
      cv.addEventListener("mouseleave",()=>{ C.mx=null; C.my=null; render(); }); }
    const b=$$("chartbtn"); if(b) b.onclick=()=>{ let s=C.sym; try{ if(typeof S!=="undefined"&&S.symbol) s=S.symbol; }catch(e){} openChart(s); };
  }
  if(document.readyState!=="loading") init(); else document.addEventListener("DOMContentLoaded",init);
})();
