"use strict";
// Финрез: баланс/equity, открытые позиции (PnL), ордера (отмена). Читает состояние T из trade.js.
(function(){
  const g=(id)=>document.getElementById(id);
  const win=g("finwin"); if(!win) return;
  let timer=null;
  function f2(v){ return (v||0).toFixed(2); }
  function fmtv(v){ v=Math.abs(v||0); if(v>=1e6)return (v/1e6).toFixed(1)+"M"; if(v>=1e3)return (v/1e3).toFixed(1)+"K"; return String(Math.round(v)); }

  function render(){
    const T=window.T||(typeof T!=="undefined"?T:null);
    const conn = T && T.connected;
    const head=g("fin-head");
    if(head){ if(!conn){ head.innerHTML='<span class="fin-off">не подключено — вставь токен и «Подключить»</span>'; }
      else { const pnl=(T.allpos||[]).reduce((s,p)=>s+(p.pnl||0),0);
        head.innerHTML='<div class="fin-bal"><span>Баланс</span><b>$'+f2(T.balance)+'</b></div>'
          +'<div class="fin-bal"><span>Equity</span><b>$'+f2(T.equity)+'</b></div>'
          +'<div class="fin-bal"><span>PnL</span><b class="'+(pnl>=0?"up":"down")+'">'+(pnl>=0?"+":"")+f2(pnl)+'</b></div>'; } }
    const posEl=g("fin-pos");
    if(posEl){ const ps=(T&&T.allpos)||[];
      if(!conn){ posEl.innerHTML=""; } else if(!ps.length){ posEl.innerHTML='<div class="fin-empty">нет позиций</div>'; }
      else { let h='<table class="scrtbl"><tbody>';
        for(const p of ps){ const long=p.side===1;
          h+='<tr><td class="coin">'+(p.symbol||"").replace("_USDT","")+'</td>'
            +'<td class="num '+(long?"up":"down")+'">'+(long?"LONG":"SHORT")+'</td>'
            +'<td class="num">'+fmtv(p.vol)+'</td><td class="num">'+(p.avg||0)+'</td>'
            +'<td class="num '+((p.pnl||0)>=0?"up":"down")+'">'+((p.pnl||0)>=0?"+":"")+f2(p.pnl)+'</td></tr>'; }
        h+='</tbody></table>'; posEl.innerHTML=h; } }
    const ordEl=g("fin-ord");
    if(ordEl){ const os=(T&&T.orders)||[];
      if(!conn){ ordEl.innerHTML=""; } else if(!os.length){ ordEl.innerHTML='<div class="fin-empty">нет ордеров</div>'; }
      else { let h='<table class="scrtbl"><tbody>';
        for(const o of os){ const buy=(o.side===1||o.side===2);
          h+='<tr><td class="num '+(buy?"up":"down")+'">'+(buy?"BUY":"SELL")+'</td>'
            +'<td class="num">'+(o.price||0)+'</td><td class="num">'+fmtv(o.vol)+'</td>'
            +'<td class="num fin-cancel" title="отменить все">×</td></tr>'; }
        h+='</tbody></table>'; ordEl.innerHTML=h;
        ordEl.querySelectorAll(".fin-cancel").forEach(el=>{ el.onclick=()=>{ if(typeof cancelAll==="function") cancelAll(); }; }); } }
  }
  // ── история закрытых сделок (как MetaScalp «Ваши сделки»): тикер · объём$ · % · чистая прибыль$ · комиссия ──
  let _histT=0, _lastHistSig="";
  async function loadHistory(){
    const T=window.T||(typeof T!=="undefined"?T:null); const trEl=g("fin-trades"), totEl=g("fin-trades-tot");
    if(!trEl) return;
    if(!(T&&T.connected)){ trEl.innerHTML='<div class="fin-empty">не подключено — вставь токен и «Подключить»</div>'; if(totEl) totEl.textContent=""; return; }
    if(!trEl.innerHTML) trEl.innerHTML='<div class="fin-empty">загружаю историю…</div>';
    try{
      const r=await fetch("/api/history").then(x=>x.json());
      if(!r.ok){ trEl.innerHTML='<div class="fin-empty">ошибка: '+(r.error||"—")+'</div>'; return; }
      if(!r.trades){ return; }
      const _sig=r.trades.length+"|"+(r.trades[0]?r.trades[0].time:0)+"|"+(r.trades[0]?r.trades[0].profit:0);
      if(_sig===_lastHistSig) return;   // история не изменилась → НЕ перестраивать таблицу (не фризить ленту)
      _lastHistSig=_sig;
      const cs=(window.S&&S.contractSize)||1;
      let sumP=0,sumF=0, h='<table class="scrtbl fintr"><thead><tr><td>Тикер</td><td class="num">Объём$</td><td class="num">%</td><td class="num">Прибыль$</td><td class="num">Комис.</td></tr></thead><tbody>';
      for(const t of r.trades){
        const usd=(t.vol||0)*(t.close||t.open||0)*cs;                 // нотионал сделки
        const pct=usd? (t.profit/usd*100):0;                          // % от объёма
        const win=(t.profit||0)>=0;
        sumP+=(t.profit||0); sumF+=(t.fee||0);
        h+='<tr><td class="coin">'+((t.symbol||"").replace("_USDT",""))+'</td>'
          +'<td class="num">'+usd.toFixed(2)+'</td>'
          +'<td class="num '+(win?"up":"down")+'">'+(win?"":"")+pct.toFixed(2)+'</td>'
          +'<td class="num '+(win?"up":"down")+'">'+(win?"+":"")+f2(t.profit)+'$</td>'
          +'<td class="num fin-fee">'+f2(t.fee)+'</td></tr>';
      }
      h+='</tbody></table>';
      if(!r.trades.length) h='<div class="fin-empty">нет закрытых сделок</div>';
      trEl.innerHTML=h;
      if(totEl) totEl.innerHTML='· '+r.trades.length+' сд · Чистая: <b class="'+(sumP>=0?"up":"down")+'">'+(sumP>=0?"+":"")+f2(sumP)+'$</b> · Комис: <b>'+f2(sumF)+'</b>';
    }catch(e){}
  }
  function isVis(){ return !!win && !win.classList.contains("hidden") && win.getClientRects().length > 0; }   // надёжно (работает и для position:fixed, где offsetParent=null)
  function open(){ if(window.untileFloat) window.untileFloat(win,{right:20,top:200,w:440,h:420}); else win.classList.remove("hidden");
    render(); loadHistory(); }
  function close(){ win.classList.add("hidden"); }
  const btn=g("finbtn"); if(btn) btn.onclick=()=> (window.isPanelFloatingVisible?window.isPanelFloatingVisible(win):!win.classList.contains("hidden"))?close():open();
  const x=g("finclose"); if(x) x.onclick=close;
  if(window.Dock) window.Dock.makeWindow({ win, handle:g("findrag"), titleBar:g("findrag"), resize:g("finres"), key:"finrez", minW:280, minH:200 });
  // САМОСТОЯТЕЛЬНЫЙ рендер, пока панель видима — как бы её ни открыли (кнопкой/тайлом/доком/восстановлением)
  // render (позиции/ордера) — лёгкий, 1с. История — ТЯЖЁЛАЯ (все страницы + большая таблица) → раз в 30с, иначе фризит ленту.
  let _hn=0, _prevConn=false;
  setInterval(()=>{ if(!isVis()) return; render();
    const TT=window.T||(typeof T!=="undefined"?T:null), conn=!!(TT&&TT.connected);
    if(conn && !_prevConn){ _lastHistSig=""; loadHistory(); }   // ТОЛЬКО что подключились → сразу подтянуть историю (не ждать 30с)
    _prevConn=conn;
    if((_hn++)%30===0) loadHistory();
  }, 1000);
  if(isVis()){ render(); loadHistory(); }
})();
