"use strict";
// Колоночная ЛЕНТА СДЕЛОК (time & sales) уровня MetaScalp/CScalp — Canvas 2D + ring buffer, без DOM-строк.
// Плавающее окно (кнопка «≣ Лента»). Кормится из SSE-сделок (window.tapeFeed из app.js).
(function () {
  const g = (id) => document.getElementById(id);
  const N = 6000, ROW = 16;                       // размер кольцевого буфера и высота строки
  // РИНГ-БУФЕР на типизированных массивах (ноль аллокаций при добавлении сделки)
  const B = { p:new Float64Array(N), v:new Float64Array(N), t:new Float64Array(N), s:new Int8Array(N), head:0, count:0, lastT:0 };
  let win, cv, paused=false, dirty=true, minVol=0, agg=false, raf=0;

  function push(price, vol, side, ts) {
    // агрегация: подряд одна цена+сторона в окне 250мс → сумма в последнюю строку
    if (agg && B.count) { const li=(B.head-1+N)%N;
      if (B.s[li]===side && B.p[li]===price && ts-B.t[li]<=250) { B.v[li]+=vol; B.t[li]=ts; dirty=true; return; } }
    B.p[B.head]=price; B.v[B.head]=vol; B.s[B.head]=side; B.t[B.head]=ts;
    B.head=(B.head+1)%N; if (B.count<N) B.count++;
    dirty=true;
  }
  // приём сделок из app.js (S.flow.ticks) — только новые по времени, без задвоения
  window.tapeFeed = function (ticks) {
    if (!ticks || !ticks.length) return;
    for (let i=0;i<ticks.length;i++){ const tk=ticks[i]; if (tk.t>B.lastT){ push(tk.p, tk.v, tk.side===1?1:-1, tk.t); } }
    B.lastT = ticks[ticks.length-1].t;
  };

  // форматтеры
  function fmtSize(vc, price){ const u = (typeof unitVal==="function")?unitVal(vc,price):vc; const a=Math.round(u);
    if(a>=1e6) return (a/1e6).toFixed(2)+"M"; if(a>=1e3) return (a/1e3).toFixed(1)+"K"; return ""+a; }
  function two(n){ return n<10?"0"+n:""+n; }
  function fmtTime(ms){ const d=new Date(ms); return two(d.getHours())+":"+two(d.getMinutes())+":"+two(d.getSeconds()); }

  function render(){
    raf=requestAnimationFrame(render);
    if (!win || win.classList.contains("hidden")) return;
    if (!dirty) return; dirty=false;
    const body=g("tapebody"); if(!cv||!body) return;
    const W=body.clientWidth, H=body.clientHeight, dpr=window.devicePixelRatio||1;
    if(cv.width!==Math.round(W*dpr)||cv.height!==Math.round(H*dpr)){ cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); cv.style.width=W+"px"; cv.style.height=H+"px"; }
    const c=cv.getContext("2d"); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,W,H);
    c.font="11px Verdana,Geneva,sans-serif"; c.textBaseline="middle";
    // цвета из системы тем (LAD_PAL): buy/sell ленты
    const P=window.LAD_PAL||{};
    const toRgb=(v,d)=>{ const m=/^#?([0-9a-f]{6})$/i.exec(v||""); if(m){const n=parseInt(m[1],16);return [n>>16&255,n>>8&255,n&255];} const r=/(\d+)\D+(\d+)\D+(\d+)/.exec(v||""); return r?[+r[1],+r[2],+r[3]]:d; };
    const BUY=toRgb(P.tapeBuy,[46,160,67]), SELL=toRgb(P.tapeSell,[224,82,77]);
    const dec=S.dec||2, rows=Math.ceil(H/ROW), tW=64, sW=64, pW=W-tW-sW;   // время | цена | размер
    // порог крупного для подсветки (адаптив: от «Крупный объём тиков» или 3× медианы)
    const bigT = S.tickBig||5000;
    // идём с конца буфера (новейшие сверху), рисуем видимые + учитываем фильтр и свипы
    let drawn=0, idx=(B.head-1+N)%N, prevSweepPrice=null, prevSide=0;
    for (let k=0; k<B.count && drawn<rows; k++, idx=(idx-1+N)%N){
      const price=B.p[idx], vol=B.v[idx], side=B.s[idx], ts=B.t[idx];
      const uv=(typeof unitVal==="function")?unitVal(vol,price):vol;
      if (minVol>0 && uv<minVol) continue;
      const y=drawn*ROW;
      // фон строки: сторона + градация по объёму (крупнее = насыщеннее)
      const mag=Math.min(1, uv/(bigT||1));
      const a=0.10 + mag*0.5;
      const RGB=side>0?BUY:SELL;
      c.fillStyle = `rgba(${RGB[0]},${RGB[1]},${RGB[2]},${a.toFixed(3)})`;
      c.fillRect(0,y,W,ROW-1);
      // свип: та же сторона, цена сдвинулась (агрессия прошла уровень) → рамка-акцент
      if (prevSide===side && prevSweepPrice!=null && price!==prevSweepPrice){
        c.strokeStyle = `rgba(${RGB[0]},${RGB[1]},${RGB[2]},.7)`; c.lineWidth=1; c.strokeRect(0.5,y+0.5,W-1,ROW-2);
      }
      prevSide=side; prevSweepPrice=price;
      // текст: время | цена | размер (светлый тон стороны)
      const tcol = `rgb(${Math.min(255,RGB[0]+90)},${Math.min(255,RGB[1]+90)},${Math.min(255,RGB[2]+90)})`;
      c.fillStyle="#8a94a3"; c.textAlign="left";  c.fillText(fmtTime(ts), 5, y+ROW/2);
      c.fillStyle="#e8edf2"; c.textAlign="right"; c.fillText(price.toFixed(dec), tW+pW-6, y+ROW/2);
      c.fillStyle=tcol;      c.textAlign="right"; c.font=(uv>=bigT?"bold 11px":"11px")+" Verdana,Geneva,sans-serif";
      c.fillText(fmtSize(vol,price), W-6, y+ROW/2); c.font="11px Verdana,Geneva,sans-serif";
      drawn++;
    }
    // индикатор паузы
    if (paused){ c.fillStyle="rgba(230,169,67,.9)"; c.fillRect(0,0,W,2); }
  }

  function open(){ if(window.untileFloat) window.untileFloat(win,{right:20,top:120,w:280,h:520}); else win.classList.remove("hidden");
    dirty=true; if(!raf) render(); }
  function close(){ win.classList.add("hidden"); }

  function wire(){
    win=g("tapewin"); cv=g("tapecanvas"); if(!win) return;
    const btn=g("tapebtn"); if(btn) btn.onclick=()=> (window.isPanelFloatingVisible?window.isPanelFloatingVisible(win):!win.classList.contains("hidden"))?close():open();
    const x=g("tapeclose"); if(x) x.onclick=close;
    const mv=g("tape-minvol"); if(mv) mv.onchange=()=>{ minVol=parseFloat(mv.value)||0; dirty=true; };
    const ag=g("tape-agg"); if(ag) ag.onchange=()=>{ agg=ag.checked; dirty=true; };
    const live=g("tape-live"); if(live) live.onclick=()=>{ paused=false; dirty=true; };
    // пауза при наведении (стоп-автоскролл, как в терминалах) — заморозка чтения крупняка
    const body=g("tapebody");
    if(body){ body.addEventListener("mouseenter",()=>{ paused=true; }); body.addEventListener("mouseleave",()=>{ paused=false; dirty=true; }); }
    // перетаскивание + докинг + ресайз + сворачивание + сохранение — через общий Dock
    if(window.Dock) window.Dock.makeWindow({ win, handle:g("tapedrag"), titleBar:g("tapedrag"),
      resize:g("taperes"), key:"tape", minW:240, minH:200, onResize:()=>{ dirty=true; } });
    render();
  }
  wire();
})();
