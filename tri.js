"use strict";
// ТРЕУГОЛЬНИК — монитор треугольного арбитража на битке (MEXC фьючерсы, read-only).
// USDT↔BTC↔USDC↔USDT через BTC_USDT · BTC_USDC · USDC_USDT.
// Показывает живой gross/net (тейкер) и потолок для мейкер-исполнения. Ордера НЕ шлёт.
(function(){
  const g=(id)=>document.getElementById(id);
  const T={ timer:null };

  const css=document.createElement("style"); css.textContent=`
  #triwin{display:flex;flex-direction:column;font:12px ui-monospace,Consolas,monospace}
  #tribody{flex:1;overflow-y:auto;padding:10px 12px}
  .trihead{display:flex;gap:8px;align-items:center;color:#8a929c;font-size:10px;margin-bottom:8px;flex-wrap:wrap}
  .trihead .chip{border-radius:4px;padding:1px 6px;background:rgba(255,255,255,.05)}
  .trihero{display:flex;align-items:baseline;gap:10px;margin:6px 0 12px}
  .trihero .big{font-size:34px;font-weight:800;letter-spacing:-1px}
  .trihero .big.pos{color:#4be38a}.trihero .big.neg{color:#ff8a86}
  .trihero .sub{font-size:11px;color:#8a929c}
  .trirow{display:grid;grid-template-columns:150px 1fr 1fr;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)}
  .trirow .k{color:#8a929c}
  .trirow .pos{color:#4be38a}.trirow .neg{color:#ff8a86}
  .trilegs{margin-top:12px}
  .trileg{display:grid;grid-template-columns:110px 1fr 1fr 70px;gap:6px;padding:3px 0;font-size:11px}
  .trileg .sym{color:#dfe6ee;font-weight:700}
  .trileg .lbl{color:#5b6573}
  .trispark{display:flex;align-items:flex-end;gap:1px;height:38px;margin:8px 0}
  .trispark i{flex:1;background:#2e5;opacity:.5;min-height:1px}
  .trispark i.neg{background:#e55}
  .trinote{margin-top:12px;padding:8px;border:1px solid rgba(230,169,67,.25);border-radius:6px;background:rgba(230,169,67,.06);color:#d9c08a;font-size:10px;line-height:1.5}
  .triwin-off{color:#5b6573;padding:20px;text-align:center}`;
  document.head.appendChild(css);

  const win=document.createElement("div");
  win.id="triwin"; win.className="wbwin hidden";
  win.style.cssText="left:auto;right:24px;top:120px;width:460px;height:520px";
  win.innerHTML=`
    <div class="wbtitle" id="tridrag">
      <span class="wbcoin">🔺 ТРЕУГОЛЬНИК BTC</span>
      <span class="wbsp"></span>
      <span id="tri-state" style="font-size:9px;color:#5b6573"></span>
      <button class="wbx" id="triclose">×</button>
    </div>
    <div id="tribody"><div class="triwin-off">Подключаюсь к MEXC…</div></div>
    <div class="wbresize" id="trires"></div>`;
  document.body.appendChild(win);

  const bp=(x)=> (x>=0?"+":"")+x.toFixed(2)+" bps";
  const cls=(x)=> x>=0?"pos":"neg";

  function render(s){
    const body=g("tribody");
    if(!s||!s.ok){ body.innerHTML='<div class="triwin-off">Нет данных с MEXC…</div>'; return; }
    const best=s.best_net, dir=s.best_dir;
    const winrate = s.cycles? Math.round(100*s.windows/s.cycles):0;
    // мейкер-потолок: две BTC-ноги 0%, петля ~1bps → net_maker ≈ gross - 0.5..1 bps
    const netMaker = s.best_gross - 1.0;
    const B=s.books||{};
    const leg=(sym,label)=>{ const b=B[sym]; if(!b) return "";
      return `<div class="trileg"><span class="sym">${sym}</span>`+
             `<span class="lbl">bid ${b.bid}</span><span class="lbl">ask ${b.ask}</span>`+
             `<span class="lbl">${label}</span></div>`; };
    const hist=s.hist||[]; const mx=Math.max(1,...hist.map(Math.abs));
    const spark=hist.map(v=>`<i class="${v<0?'neg':''}" style="height:${Math.max(2,Math.abs(v)/mx*100)}%;opacity:${v>0?.85:.5}"></i>`).join("");
    body.innerHTML=`
      <div class="trihead">
        <span class="chip">циклов ${s.cycles}</span>
        <span class="chip">окон (net&gt;0): ${s.windows} · ${winrate}%</span>
        <span class="chip">USDC/USDT спред ${s.usdc_spread_bps.toFixed(2)} bps</span>
      </div>
      <div class="trihero">
        <span class="big ${cls(best)}">${bp(best)}</span>
        <span class="sub">лучший net (тейкер), направление ${dir}<br>gross ${bp(s.best_gross)} · мейкер-потолок ≈ ${bp(netMaker)}</span>
      </div>
      <div class="trispark">${spark}</div>
      <div class="trirow"><span class="k">Цикл A · USDT→BTC→USDC→USDT</span><span class="${cls(s.gross_a)}">gross ${bp(s.gross_a)}</span><span class="${cls(s.net_a)}">net ${bp(s.net_a)}</span></div>
      <div class="trirow"><span class="k">Цикл B · USDT→USDC→BTC→USDT</span><span class="${cls(s.gross_b)}">gross ${bp(s.gross_b)}</span><span class="${cls(s.net_b)}">net ${bp(s.net_b)}</span></div>
      <div class="trilegs">
        ${leg("BTC_USDT","maker 0%")}
        ${leg("BTC_USDC","maker 0%")}
        ${leg("USDC_USDT","maker 0.01%")}
      </div>
      <div class="trinote">Ядро края = лонг BTC_USDC + шорт BTC_USDT (обе ноги maker 0% → бесплатно).
      «gross» = потолок при мейкер-исполнении. «net» = если шмальнуть 3 маркета (тейкер, обычно в минус).
      Барьер: получить мейкер-филл на обеих BTC-ногах до схлопывания разрыва. Монитор, ордера не шлёт.</div>`;
  }

  async function poll(){
    try{ const r=await fetch("/api/tri/state"); const s=await r.json(); render(s);
      const st=g("tri-state"); if(st) st.textContent = s&&s.ok? ("обновлено "+new Date(s.ts*1000).toLocaleTimeString()) : (s&&s.err? "ошибка" : "…");
    }catch(e){}
  }
  function open(){ win.classList.remove("hidden"); win.style.zIndex=46; poll();
    if(!T.timer) T.timer=setInterval(poll, 3000); }
  function close(){ win.classList.add("hidden"); if(T.timer){ clearInterval(T.timer); T.timer=null; } }

  const btn=g("tribtn"); if(btn) btn.onclick=()=>{ win.classList.contains("hidden")?open():close(); };
  g("triclose").onclick=close;
  // перетаскивание/ресайз — как у прочих окон (dock.js вешает по классам wbtitle/wbresize)
})();
