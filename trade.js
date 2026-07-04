"use strict";
// Механика торговли MetaScalp: мышь + клавиатура. Использует глобалы из app.js (S, fmt, compress, setStepMult).
// Боевые ордера уходят только когда сервер «вооружён» (подключён токеном + 0% fee + LIVE вкл).

const T = { connected: false, armed: false, pos: null, orders: [] };
window.T = T;   // экспорт для finrez.js и др. (иначе window.T=undefined → Финрез думал «не подключено»)
const SIDE = { OPEN_LONG: 1, CLOSE_SHORT: 2, OPEN_SHORT: 3, CLOSE_LONG: 4 };
const OT = { LIMIT: 1, IOC: 3, MARKET: 5 };
const $$ = (id) => document.getElementById(id);

function log(msg, kind){
  const el=$$("tradelog"); if(!el) return;
  el.textContent=msg; el.style.color = kind==="err" ? "#ef938f" : kind==="ok" ? "#6fcf91" : "#5b6573";
}
// размер позиции в контрактах из активного слота (S.size в выбранной единице)
function volContracts(price){
  const sz=S.size||0, cs=S.contractSize||1;
  if(S.unit==="USD")  return Math.max(1, Math.round(sz/(cs*price)));
  if(S.unit==="coin") return Math.max(1, Math.round(sz/cs));
  return Math.max(1, Math.round(sz));
}

async function postJSON(url, body){
  try{ return await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body||{})}).then(r=>r.json()); }
  catch(e){ return {ok:false,error:"сеть"}; }
}

// ── подключение / арм ──
async function connect(){
  const tok=$$("token").value.trim();
  if(!tok){ log("вставь uc_token","err"); return; }
  log("подключаюсь…");
  const r=await postJSON("/api/connect",{token:tok});
  if(!r.ok){ log(r.error||"ошибка подключения","err"); T.connected=false; $$("livebtn").disabled=true;
    $$("acct").textContent="не подключено"; $$("acct").className="acct"; return; }
  T.connected=true;
  const fee=r.fee||{}; const zero=fee.zero_fee;
  $$("acct").textContent=`баланс $${r.balance.toFixed(2)} · fee ${zero?"0% ✓":"НЕ 0% ("+fee.total_fee+")"}`;
  $$("acct").className="acct ok";
  $$("livebtn").disabled=false;                       // LIVE доступен при любой комиссии (юзер: торгую везде)
  log(zero?"подключено, fee 0% — можно включать LIVE":"подключено (fee "+(fee.total_fee||"?")+") — LIVE доступен","ok");
  refreshAccount();                                   // сразу подтянуть позицию/ордера (чтобы после смены ключа не «висела» старая)
}
async function setArm(on){
  if(S.exWeex){ T.armed=on; const a=document.querySelector(".arm"); if(a) a.style.color=on?"#6fcf91":"#ef938f";
    log(on?"🔴 LIVE WEEX включён — ордера РЕАЛЬНЫЕ (тестируй малым размером!)":"LIVE выключен","ok"); return; }
  const r=await postJSON("/api/arm",{on});
  if(!r.ok){ log(r.error||"не удалось","err"); $$("livebtn").checked=false; T.armed=false; return; }
  T.armed=r.state.armed; document.querySelector(".arm").style.color=T.armed?"#6fcf91":"#ef938f";
  log(T.armed?"🔴 LIVE включён — ордера РЕАЛЬНЫЕ":"LIVE выключен","ok");
}

// ── ордер ──
// volOverride задаём при ЗАКРЫТИИ — берём фактический размер позиции T.pos.vol (контракты), НЕ размер UI-лота
function snapPx(price){ const t=S.tick||0.01, d=(S.dec!=null?S.dec:8); return price?+(Math.round(price/t)*t).toFixed(d):0; }
function showPing(ms, ok){ const el=$$("pinglog"); if(!el) return; el.textContent=(ok?"":"✗ ")+ms+"мс";
  el.style.color = !ok?"#ef938f": ms<250?"#6fcf91": ms<700?"#e6a943":"#ef938f"; }
async function sendOrder(side, otype, price, label, volOverride, positionId, symOverride){
  if(S.exWeex) return sendOrderWeex(side, otype, price, label, volOverride);
  if(S.exMexc){ log("MEXC: торговля кликом пока не подключена (только Ourbit/WEEX)","err"); return; }
  const sym=symOverride||S.symbol;
  const px=snapPx(price);                                    // СНАП цены к тику (убрать float-мусор → биржа не отвергнет по точности)
  const vol=(volOverride!=null && volOverride>0) ? Math.round(volOverride) : volContracts(px||S.bestAsk||1);
  if(!T.armed){ log(`✋ ${label}: LIVE off (vol≈${vol}) — не отправлено`); return; }
  log(`${label}: отправка vol=${vol}…`);
  const t0=(window.performance?performance.now():Date.now());
  const r=await postJSON("/api/order",{symbol:sym,side,otype,vol,price:px,leverage:S.lev,
                                       sl:S.slPct||0,tp:S.tpPct||0,
                                       positionId:(positionId!=null?positionId:0)});   // ЗАКРЫТИЕ передаёт positionId — иначе Ourbit откроет новую позу
  const ms=Math.round((window.performance?performance.now():Date.now())-t0);
  const pms=(r&&r.srv_ms!=null)?r.srv_ms:ms;                 // истинный пинг биржи (без клиентского джанка), если сервер прислал
  showPing(pms, !!r.ok);
  if(r.ok){ log(`✅ ${label} принят (vol=${vol}) · ${pms}мс`,"ok");
    if(otype===OT.LIMIT && px>0){                            // ОПТИМИСТИЧНО показать лимитку в стакане СРАЗУ (не ждать опрос счёта ~1с)
      const oid=(r.resp&&r.resp.data&&(r.resp.data.orderId||r.resp.data.id||r.resp.data))||("tmp"+Date.now());
      const ord={id:oid, side, price:px, vol};
      T.orders=(T.orders||[]).concat([ord]);
      if(!T._pending) T._pending=new Map();
      T._pending.set(oid, {ord, exp:Date.now()+3500});       // держим оптимистично ~3.5с: биржа отдаёт open_orders с задержкой → иначе заявка МИГАЕТ (пропала→появилась)
      S._render=true;
    }
  }
  else if(r.maybe_filled){                                   // ORPHAN-защита: ордер МОГ исполниться
    _riskFired=false;
    const p=(r.positions&&r.positions[0]);
    log(`⚠ ${label}: СЕТЬ/ТАЙМАУТ — ОРДЕР МОГ ИСПОЛНИТЬСЯ! ${p?("позиция "+(p.side===1?"LONG":"SHORT")+" "+p.vol):"проверь позицию!"}`,"err");
  }
  else { _riskFired=false; log(`❌ ${label}: ${r.error||JSON.stringify(r.resp&&r.resp.message||r.resp)}`,"err"); }
  refreshAccount();
}
// POSITION-AWARE (эмуляция one-way в хедж-режиме): действие ПРОТИВ позиции = ЗАКРЫТЬ её (reduce-only), НЕ открыть противоположную.
// Убирает баг «продаю чтобы закрыть лонг — открывает шорт». Ourbit не даёт включить one-way, поэтому эмулируем в терминале.
function _posClose(wantBuy){
  const p=T.pos;
  if(p && p.vol>0){
    if(p.side===1 && !wantBuy) return {side:SIDE.CLOSE_LONG,  vol:p.vol, id:p.id, txt:"CLOSE LONG"};   // ЛОНГ + продажа = закрыть лонг
    if(p.side===2 && wantBuy)  return {side:SIDE.CLOSE_SHORT, vol:p.vol, id:p.id, txt:"CLOSE SHORT"};  // ШОРТ + покупка = закрыть шорт
  }
  return null;   // нет позиции ИЛИ клик ПО направлению позиции → открыть/добавить
}
function _openMarket(buy){   // маркет-открытие с учётом режима (Рыночная / Лимитная-в-рендже)
  if(S.orderMode==="limit"){ const px=(buy?(S.bestAsk||S.bestBid):(S.bestBid||S.bestAsk))||0;
    const p=buy?px*(1+(S.throwPct||0.05)/100):px*(1-(S.throwPct||0.05)/100);
    sendOrder(buy?SIDE.OPEN_LONG:SIDE.OPEN_SHORT, OT.IOC, p, (buy?"BUY":"SELL")+" лимит-рендж @"+snapPx(p)); }
  else sendOrder(buy?SIDE.OPEN_LONG:SIDE.OPEN_SHORT, OT.MARKET, 0, (buy?"BUY":"SELL")+" рынок");
}
function marketBuy(){  const c=_posClose(true);  if(c) sendOrder(c.side, OT.MARKET, 0, c.txt+" (рынок)", c.vol, c.id); else _openMarket(true); }
function marketSell(){ const c=_posClose(false); if(c) sendOrder(c.side, OT.MARKET, 0, c.txt+" (рынок)", c.vol, c.id); else _openMarket(false); }
function limitBuy(p){  const c=_posClose(true);  if(c) sendOrder(c.side, OT.LIMIT, p, c.txt+" лимит @"+snapPx(p), c.vol, c.id); else sendOrder(SIDE.OPEN_LONG,  OT.LIMIT, p, "лимит BUY @"+snapPx(p)); }
function limitSell(p){ const c=_posClose(false); if(c) sendOrder(c.side, OT.LIMIT, p, c.txt+" лимит @"+snapPx(p), c.vol, c.id); else sendOrder(SIDE.OPEN_SHORT, OT.LIMIT, p, "лимит SELL @"+snapPx(p)); }
async function closePos(){                                     // D / Alt+клик: закрытие ЧЕРЕЗ СЕРВЕР — он сам берёт ВСЕ позиции с биржи и закрывает (надёжно, не зависит от клиентского T.allpos)
  if(S.exWeex) return closePosWeex();
  if(!T.armed){ log("✋ LIVE off"); return; }
  const t0=(window.performance?performance.now():Date.now());
  const r=await postJSON("/api/closeall",{leverage:S.lev, symbol:S.symbol});
  const ms=Math.round((window.performance?performance.now():Date.now())-t0); showPing(ms, !!(r&&r.ok));
  if(r&&r.ok){
    log(`закрыто ${r.closed}/${r.found}, снято лимиток ${r.cancelled_orders||0}`+(r.errors&&r.errors.length?" ⚠ "+r.errors.join("; "):""), (r.errors&&r.errors.length)?"err":"ok");
    T.pos=null; T.allpos=[]; T.orders=[]; S._render=true;      // оптимистично обнулить всё
  } else log("ошибка закрытия: "+((r&&r.error)||"—"),"err");
  refreshAccount();
}
// «Заявка на закрытие» (MetaScalp): лимитка на ВЕСЬ объём позиции, СТОРОНА ЗАКРЫВАЮЩАЯ (reduce-only) —
// НЕ откроет новую позицию. Для лонга = продать (CLOSE_LONG), для шорта = купить (CLOSE_SHORT).
function closeLimit(price){
  if(!T.pos || !(T.pos.vol>0)){ log("нет позиции — «заявку на закрытие» ставить нечего","err"); return; }
  const long=T.pos.side===1, side=long?SIDE.CLOSE_LONG:SIDE.CLOSE_SHORT;
  sendOrder(side, OT.LIMIT, price, `лимит ЗАКРЫТИЕ ${long?"LONG":"SHORT"} @${snapPx(price)}`, T.pos.vol, T.pos.id);   // + positionId = reduce-only
}
// индикатор режима «заявка на закрытие» под стаканом — горит пока зажата Ctrl или F
function updateCloseMode(){
  const el=$$("closemode"); if(!el) return;
  if(!(window.ctrlHeld || window.fHeld)){ el.style.display="none"; return; }
  el.style.display="flex";
  if(T.pos && T.pos.vol>0){ el.className="closemode"; el.textContent="🎯 заявка на закрытие — клик по цене"; }
  else { el.className="closemode nopos"; el.textContent="режим закрытия · позиции нет"; }
}
window.updateCloseMode=updateCloseMode;
async function reverse(){
  if(!T.pos){ marketBuy(); return; }
  const wasLong=T.pos.side===1, closeVol=T.pos.vol, posId=T.pos.id;   // фиксируем ДО закрытия (T.pos обнулится)
  const close=wasLong?SIDE.CLOSE_LONG:SIDE.CLOSE_SHORT;
  await sendOrder(close, OT.MARKET, 0, "REV-close", closeVol, posId); // ДОЖДАТЬСЯ закрытия (+positionId), ПОТОМ открывать (иначе гонка → двойная позиция)
  (wasLong?marketSell:marketBuy)();                            // открываем противоположную по зафиксированной стороне
}
async function cancelOrder(id){                              // отмена ОДНОЙ заявки (клик по красному × в стакане)
  if(S.exWeex) return cancelOrderWeex(id);
  if(!T.armed){ log("✋ LIVE off"); return; }
  (T._cancelled=T._cancelled||new Map()).set(id, Date.now()+4000);   // не воскрешать 4с (пока биржа не подтвердит отмену)
  T.orders=(T.orders||[]).filter(o=>o.id!==id); S._render=true;   // ОПТИМИСТИЧНО убрать пилюлю МГНОВЕННО (если не удалится — вернётся опросом)
  const t0=(window.performance?performance.now():Date.now());
  const r=await postJSON("/api/cancel",{id});
  const ms=Math.round((window.performance?performance.now():Date.now())-t0);
  const pms=(r&&r.srv_ms!=null)?r.srv_ms:ms; showPing(pms, !!r.ok);
  log(r.ok?`заявка отменена · ${pms}мс`:"ошибка отмены заявки", r.ok?"ok":"err"); refreshAccount();
}
async function cancelAll(){
  if(S.exWeex) return cancelAllWeex();
  if(!T.armed){ log("✋ CANCEL: LIVE off"); return; }
  const ids=(T.orders||[]).map(o=>o.id).filter(x=>x!=null);   // id уже есть у клиента → отмена ОДНИМ запросом (без лишних round-trip'ов)
  const exp=Date.now()+4000; T._cancelled=T._cancelled||new Map(); ids.forEach(id=>T._cancelled.set(id,exp));   // не воскрешать отменённые (фикс фликера)
  T.orders=[]; S._render=true;                                // оптимистично убрать все пилюли сразу
  const t0=(window.performance?performance.now():Date.now());
  const r=await postJSON("/api/cancelall",{symbol:S.symbol, ids});
  const ms=Math.round((window.performance?performance.now():Date.now())-t0);
  const pms=(r&&r.srv_ms!=null)?r.srv_ms:ms; showPing(pms, !!r.ok);
  if(r.ok && r.failed && r.failed.length) log(`⚠ отменено ${r.killed}, НЕ отменены: ${r.failed.join(",")} · ${pms}мс`,"err");
  else log(r.ok?`отменено ордеров: ${r.killed} · ${pms}мс`:"ошибка отмены", r.ok?"ok":"err");
  refreshAccount();
}

// ═══════════════ ТОРГОВЛЯ WEEX (маршрут на серверные /api/weex*) ═══════════════
// WEEX торгует в МОНЕТАХ (не контракты). Открыть лонг=BUY+LONG, закрыть лонг=SELL+LONG (hedge).
function _wxMap(side){   // Ourbit-сторона → WEEX {s:BUY/SELL, ps:LONG/SHORT/BOTH}
  const ow=!!S.weexOneWay;
  if(side===SIDE.OPEN_LONG)   return ow?{s:"BUY", ps:"BOTH"}:{s:"BUY", ps:"LONG"};
  if(side===SIDE.CLOSE_LONG)  return ow?{s:"SELL",ps:"BOTH"}:{s:"SELL",ps:"LONG"};
  if(side===SIDE.OPEN_SHORT)  return ow?{s:"SELL",ps:"BOTH"}:{s:"SELL",ps:"SHORT"};
  if(side===SIDE.CLOSE_SHORT) return ow?{s:"BUY", ps:"BOTH"}:{s:"BUY", ps:"SHORT"};
  return {s:"BUY", ps:"LONG"};
}
function _wxQty(price, volOverride){                       // количество в МОНЕТАХ
  if(volOverride!=null && volOverride>0) return volOverride;     // закрытие: точный размер позиции (монеты)
  const p=price||S.bestAsk||S.bestBid||1, qp=(S.weexQprec!=null?S.weexQprec:0);
  const f=Math.pow(10,qp); let q=Math.floor(((S.size||0)/(p||1))*f)/f;   // лот трактуем как $ → монеты, вниз к шагу
  if(q<=0) q=1/f;
  return +q.toFixed(qp);
}
async function sendOrderWeex(side, otype, price, label, volOverride){
  if(!T.armed){ log(`✋ ${label}: LIVE off — не отправлено`); return; }
  const m=_wxMap(side), isMkt=(otype===OT.MARKET), px=isMkt?0:snapPx(price), qty=_wxQty(px||price, volOverride);
  const tif=(otype===OT.IOC)?"IOC":"GTC";
  log(`WEEX ${label}: ${m.s}/${m.ps} qty=${qty}${isMkt?"":" @"+px}…`);
  const t0=(window.performance?performance.now():Date.now());
  const r=await postJSON("/api/weexorder",{symbol:S.symbol, side:m.s, positionSide:m.ps,
                          otype:isMkt?"MARKET":"LIMIT", qty:String(qty), price:isMkt?undefined:String(px), tif});
  showPing((r&&r.srv_ms!=null)?r.srv_ms:Math.round((window.performance?performance.now():Date.now())-t0), !!(r&&r.ok));
  if(r&&r.ok) log(`✅ WEEX ${label} принят (qty=${qty})`,"ok");
  else log(`❌ WEEX ${label}: ${(r&&r.error)||JSON.stringify((r&&r.resp&&(r.resp.msg||r.resp.message))||r&&r.resp)}`,"err");
  refreshAccount();
}
async function closePosWeex(){
  if(!T.armed){ log("✋ LIVE off"); return; }
  log("WEEX: закрываю позицию…"); let ok=0;
  for(const ps of (S.weexOneWay?["BOTH"]:["LONG","SHORT"])){
    const r=await postJSON("/api/weexclose",{symbol:S.symbol, positionSide:ps}); if(r&&r.ok) ok++; }
  await postJSON("/api/weexcancelall",{symbol:S.symbol});
  log(ok?"WEEX: позиция закрыта":"WEEX: закрывать нечего","ok");
  T.pos=null; T.orders=[]; S._render=true; refreshAccount();
}
async function cancelAllWeex(){
  if(!T.armed){ log("✋ CANCEL: LIVE off"); return; }
  T.orders=[]; S._render=true;
  const r=await postJSON("/api/weexcancelall",{symbol:S.symbol});
  log((r&&r.ok)?"WEEX: заявки отменены":"WEEX: ошибка отмены",(r&&r.ok)?"ok":"err"); refreshAccount();
}
async function cancelOrderWeex(id){
  if(!T.armed){ log("✋ LIVE off"); return; }
  T.orders=(T.orders||[]).filter(o=>o.id!==id); S._render=true;
  const r=await postJSON("/api/weexcancel",{symbol:S.symbol, orderId:id});
  log((r&&r.ok)?"WEEX: заявка отменена":"WEEX: ошибка отмены",(r&&r.ok)?"ok":"err"); refreshAccount();
}
function _wxNum(o, keys){ for(const k of keys){ if(o&&o[k]!=null&&o[k]!==""){ const v=parseFloat(o[k]); if(!isNaN(v)) return v; } } return 0; }
async function refreshAccountWeex(verbose){
  try{
    const r=await fetch("/api/weexaccount").then(x=>x.json());
    if(!r||!r.ok){ if(verbose) log("WEEX: счёт не читается (проверь ключи/права)","err"); return; }
    const raw=Array.isArray(r.positions)?r.positions:((r.positions&&(r.positions.data||r.positions.list))||[]);
    const base=(S.symbol||"").replace("_USDT","").toUpperCase(); let pos=null;
    for(const p of (raw||[])){
      const psym=String(p.symbol||p.contractName||p.contractCode||"").toUpperCase();
      if(base && psym.indexOf(base)<0) continue;
      const amt=_wxNum(p,["positionAmt","total","available","size","holdVolume","hold","openDelegateSize"]);
      if(!amt) continue;
      const sideStr=String(p.positionSide||p.holdSide||p.side||"").toUpperCase();
      const isLong = sideStr.indexOf("SHORT")>=0 ? false : (sideStr.indexOf("LONG")>=0 ? true : amt>0);
      pos={ side:isLong?1:2, vol:Math.abs(amt),
            avg:_wxNum(p,["entryPrice","avgPrice","openAvgPrice","costPrice","holdAvgPrice"]),
            pnl:_wxNum(p,["unrealizedProfit","unrealizedPnl","unrealisedPnl","upl","unrealizedPNL"]),
            id:(p.positionSide||p.holdSide||"BOTH") }; break; }
    T.pos=pos;
    const bal=r.balance, arr=Array.isArray(bal)?bal:((bal&&(bal.data||bal.list))||[]); let usdt=0;
    for(const b of (Array.isArray(arr)?arr:[])){ if(String(b.asset||b.marginCoin||b.currency||b.coin||"").toUpperCase()==="USDT"){ usdt=_wxNum(b,["available","balance","equity","crossWalletBalance","accountEquity"]); break; } }
    T.balance=usdt; T._lastAcct=Date.now();
    const pi=$$("posinfo");
    if(pi){ if(T.pos){ const long=T.pos.side===1; pi.textContent=`${long?"LONG":"SHORT"} ${fmt(T.pos.vol)} @ ${T.pos.avg} · PnL ${T.pos.pnl>=0?"+":""}${(T.pos.pnl||0).toFixed(3)}`; pi.style.color=long?"#6fcf91":"#ef938f"; } else pi.textContent=""; }
    const a=$$("acct"); if(a){ a.textContent=`баланс $${usdt.toFixed(2)}`; a.className="acct ok"; }
    S._render=true;
  }catch(e){}
}

// ── SL/TP/безубыток (application-side): терминал следит за ценой и закрывает по рынку ──
// MetaScalp «Application»-режим: стоп живёт в терминале, не на бирже. Работает пока окно открыто.
let _riskFired=false;
function armBreakeven(){
  if(!T.pos){ log("нет позиции для безубытка"); return; }
  const long=T.pos.side===1, px=long?S.bestBid:S.bestAsk;
  const profit = long ? px>T.pos.avg : px<T.pos.avg;
  if(!profit){ log("безубыток: позиция не в плюсе","err"); return; }
  T.beArmed=true; log("🛡 стоп в безубыток взведён @"+T.pos.avg.toFixed(S.dec),"ok");
}
function checkRisk(){
  if(!T.armed || !T.pos){ _riskFired=false; T.beArmed=false; return; }
  const long=T.pos.side===1, px=long?S.bestBid:S.bestAsk, avg=T.pos.avg;
  if(!px) return;
  const sl = S.slPct>0 ? (long?avg*(1-S.slPct/100):avg*(1+S.slPct/100)) : null;
  const tp = S.tpPct>0 ? (long?avg*(1+S.tpPct/100):avg*(1-S.tpPct/100)) : null;
  const be = T.beArmed ? avg : null;
  let hit=null;
  if(long){ if(sl!=null&&px<=sl)hit="SL"; else if(be!=null&&px<=be)hit="БУ"; else if(tp!=null&&px>=tp)hit="TP"; }
  else    { if(sl!=null&&px>=sl)hit="SL"; else if(be!=null&&px>=be)hit="БУ"; else if(tp!=null&&px<=tp)hit="TP"; }
  if(!hit && S.slUsd>0 && T.pos.vol){   // авто-SL по ДОЛЛАРАМ (закрыть при убытке ≥ $X, независимо от %)
    const pu=(px-avg)*T.pos.vol*(S.contractSize||1)*(long?1:-1);
    if(pu <= -Math.abs(S.slUsd)) hit="SL$";
  }
  if(hit && !_riskFired){ _riskFired=true; log(`${hit} @${px.toFixed(S.dec)} — закрываю`,"ok"); closePos();
    setTimeout(()=>{ _riskFired=false; }, 2500);   // разблокировать повтор: если закрытие не прошло — checkRisk попробует снова
  }
}

// ── аккаунт / маркеры ──
async function refreshAccount(verbose){
  if(S.exWeex) return refreshAccountWeex(verbose);
  if(!T.connected){ if(verbose) log("✋ не подключено — вставь токен и «Подключить», чтобы увидеть заявки/позицию","err"); return; }
  const hadPos=!!T.pos;
  try{
    const r=await fetch("/api/account?symbol="+encodeURIComponent(S.symbol)).then(x=>x.json());
    if(!r.ok){ if(verbose) log("ошибка обновления счёта","err"); return; }
    T.pos=(r.positions&&r.positions[0])||null;
    // ЗВУК откр/закр — ТОЛЬКО по подтверждённой сервером смене (не по оптимистичному T.pos, иначе ложные бипы при закрытии/реверсе/мелькании)
    const _srvHasPos=!!(r.positions && r.positions[0]);
    if(T._acctInit && _srvHasPos!==T._sndPos && window.posSound) posSound(_srvHasPos);
    T._sndPos=_srvHasPos; T._acctInit=true;
    let orders=r.orders||[];
    // НЕ воскрешать только что отменённые заявки: биржа отдаёт open_orders с задержкой после отмены → был фликер (пропал→появился→пропал)
    if(T._cancelled && T._cancelled.size){ const now=Date.now();
      for(const [id,exp] of T._cancelled){ if(exp<now) T._cancelled.delete(id); }   // истёкшие метки убрать
      orders=orders.filter(o=>!T._cancelled.has(o.id)); }
    // НЕ дать только что ПОСТАВЛЕННОЙ заявке моргнуть: биржа показывает её в open_orders с задержкой → держим оптимистичную, пока биржа не подтвердит/не истечёт таймер
    if(T._pending && T._pending.size){ const now=Date.now();
      const haveId=new Set(orders.map(o=>String(o.id)));                          // сверка по id (нормализуем тип число/строка)
      const havePx=new Set(orders.map(o=>o.side+"@"+snapPx(o.price||0)));         // + сверка по сторона+цена (на случай tmp-id / иного типа id)
      for(const [id,rec] of T._pending){
        const key=rec.ord.side+"@"+snapPx(rec.ord.price||0);
        if(rec.exp<now || haveId.has(String(id)) || havePx.has(key) || (T._cancelled&&T._cancelled.has(id))){ T._pending.delete(id); continue; }   // подтверждена биржей (по id или цене) / истекла / отменена
        orders=orders.concat([rec.ord]); }   // ещё не видна на бирже — показываем оптимистичную
    }
    T.orders=orders;
    if(verbose){ const no=(r.orders||[]).length, p=T.pos;   // ↻ переподключение: показать ВСЁ что реально стоит на бирже
      log(`↻ синхронизация: заявок на бирже ${no}${p?`, позиция ${p.side===1?"LONG":"SHORT"} ${fmt(p.vol)} @ ${p.avg}`:", позиции нет"}`,"ok"); }
    T.balance=r.balance||0; T.equity=r.equity||0; T.allpos=r.allpos||r.positions||[];   // ВСЕ позиции (по всем монетам)
    T._lastAcct=Date.now();                                   // отметка свежести данных
    if(hadPos && !T.pos){ postJSON("/api/cancelplans",{symbol:S.symbol}); }   // позиция закрылась → снять оставшиеся биржевые стопы (OCO)
    const pi=$$("posinfo");
    if(T.pos){ const long=T.pos.side===1;
      pi.textContent=`${long?"LONG":"SHORT"} ${fmt(T.pos.vol)} @ ${T.pos.avg} · PnL ${T.pos.pnl>=0?"+":""}${T.pos.pnl.toFixed(3)}`;
      pi.style.color=long?"#6fcf91":"#ef938f";
    } else { pi.textContent=""; }
    $$("acct").textContent=`баланс $${(r.balance||0).toFixed(2)}`;
  }catch(e){}
}
// индикатор потери связи с биржей: если аккаунт не обновлялся дольше 8с при открытой позиции — предупредить
setInterval(()=>{ if(T.connected && T.pos && T._lastAcct && Date.now()-T._lastAcct>8000){
  const a=$$("acct"); if(a){ a.textContent="⚠ СВЯЗЬ ПОТЕРЯНА "+Math.round((Date.now()-T._lastAcct)/1000)+"с — стоп в терминале НЕ работает!"; a.className="acct"; a.style.color="#ef938f"; } } }, 2000);
// маркеры позиции/лимиток в стакане (вызывается из app.js после каждой отрисовки)
window.applyTradeMarkers=function(){
  if(T.pos){ const ap=T.pos.avg.toFixed(S.dec);
    const tr=document.querySelector(`#rows tr[data-price="${ap}"]`);
    if(tr) tr.classList.add(T.pos.side===1?"poslong":"posshort"); }
  for(const o of T.orders){ const op=(o.price||0).toFixed(S.dec);
    const tr=document.querySelector(`#rows tr[data-price="${op}"]`);
    if(tr) tr.classList.add(o.side===SIDE.OPEN_LONG||o.side===SIDE.CLOSE_SHORT?"ordbuy":"ordsell"); }
};

// ── мышь по стакану (ХИТ-ТЕСТ ПО CANVAS, без DOM-строк) ──
function wireMouse(){
  const cv=$$("ladcanvas"); if(!cv) return;
  function lvl(e){ const r=cv.getBoundingClientRect(), rH=(S.geo&&S.geo.rowH)||14;
    const i=Math.floor((e.clientY-r.top)/rH), s=(S.geo?S.geo.topS:0)-i;
    return { s, price:s*S.step, isAsk:s>=S.baS, isBid:s<=S.bbS }; }
  cv.addEventListener("mousemove",(e)=>{ const L=lvl(e); if(L.price!==S.hover) S.hover=L.price;
    S._hoverPri=true;
    S._lastS=L.s;   // запоминаем строку под курсором — чтобы линейка появилась сразу при нажатии L
    if(window.rulerHeld){ const anc=(L.s>=S.baS?S.baS:S.bbS); S._ruler={a:anc, b:L.s}; }   // ЛИНЕЙКА USDT: от края спреда до курсора (просто держи L и веди мышь)
    if(window.markDirty) markDirty(); });   // приоритетный кадр — ховер следует за курсором плавно (обходит FPS-троттл)
  cv.addEventListener("mouseleave",()=>{ S.hover=null; if(window.markDirty) markDirty(); });
  // фокус клавиатуры мог застрять на поле ввода (размер/символ) — тогда L и др. клавиши не долетают до стакана.
  // при клике/наведении на стакан снимаем фокус с поля, чтобы горячие клавиши работали всегда.
  cv.addEventListener("mousedown",()=>{ const a=document.activeElement; if(a&&(a.tagName==="INPUT"||a.tagName==="SELECT")&&a.blur) a.blur(); });
  cv.addEventListener("click",(e)=>{
    if(window.rulerHeld){ return; }   // зажата L (линейка) — не торговать
    if(window.fHeld){ if(T.pos && T.pos.vol>0) closeLimit(lvl(e).price);   // ЗАЖАТА F = «заявка на закрытие» (MetaScalp «Зажать ГК»)
                      else log("нет позиции для заявки на закрытие","err"); return; }
    if(e.ctrlKey){ if(T.pos && T.pos.vol>0) closeLimit(lvl(e).price);   // Ctrl+ЛКМ = то же (альтернатива)
                   else if(window.toggleAlert) toggleAlert(lvl(e).price); return; }
    if(e.altKey){ closePos(); return; }   // Alt+ЛКМ = закрыть по рынку
    // клик по красному × заявки (правый край строки) → отмена именно этой заявки
    const r=cv.getBoundingClientRect(), cx=e.clientX-r.left, cy=e.clientY-r.top, LW=S.ladWidth||190;
    if(cx>=LW-16 && S._ordHit){ const h=S._ordHit.find(o=>cy>=o.y1&&cy<o.y2); if(h&&h.id!=null){ cancelOrder(h.id); return; } }
    const L=lvl(e); if(L.isAsk) marketBuy(); else limitBuy(L.price); });
  cv.addEventListener("contextmenu",(e)=>{ e.preventDefault();
    if(window.fHeld){ if(T.pos && T.pos.vol>0) closeLimit(lvl(e).price); return; }   // F+ПКМ = заявка на закрытие
    if(e.ctrlKey){ if(T.pos && T.pos.vol>0) closeLimit(lvl(e).price); return; }   // Ctrl+ПКМ = то же
    if(e.altKey){ closePos(); return; }
    const L=lvl(e); if(L.isBid) marketSell(); else limitSell(L.price); });
  // клик КОЛЕСОМ по уровню с нашей заявкой = отмена
  // средняя кнопка (колёсико) по строке с лимиткой = отмена ИМЕННО ЭТОЙ заявки.
  // Ловим на mousedown + preventDefault — иначе браузер включает автоскролл и auxclick не доходит.
  cv.addEventListener("mousedown",(e)=>{ if(e.button!==1) return; e.preventDefault();
    const r=cv.getBoundingClientRect(), cy=e.clientY-r.top;
    let h=S._ordHit && S._ordHit.find(o=>cy>=o.y1&&cy<o.y2);           // точный хит-тест по строке заявки (как у ×)
    if(!h){ const L=lvl(e); const o=(T.orders||[]).find(o=>Math.abs((o.price||0)-L.price)<(S.step||0.01)/2); if(o) h=o; }
    if(h&&h.id!=null) cancelOrder(h.id); else log("на этом уровне нет моей заявки"); });
  cv.addEventListener("auxclick",(e)=>{ if(e.button===1) e.preventDefault(); });   // добить автоскролл-иконку
}

// ── клавиатура: НАСТРАИВАЕМЫЕ торговые клавиши (S.keys) + фиксированные служебные ──
function wireKeys(){
  const ACT={ buy:()=>marketBuy(), sell:()=>marketSell(), limitBuy:()=>limitBuy(S.bestBid),
    limitSell:()=>limitSell(S.bestAsk), close:()=>closePos(), reverse:()=>reverse(),
    cancel:()=>cancelAll(), center:()=>{ if(window.centerNow) centerNow(); }, be:()=>armBreakeven(),
    trail:()=>{ if(window.toggleTrail) toggleTrail(); } };
  document.addEventListener("keydown",(e)=>{
    if(e.target.tagName==="INPUT"||e.target.tagName==="SELECT") return;
    if(window._bindingKey) return;   // идёт назначение клавиши в настройках — не выполнять действия
    const sc=document.getElementById("scroller"), code=e.code, K=S.keys||{};
    if(code==="KeyL"){ if(!e.repeat){ window.rulerHeld=!window.rulerHeld;   // L = ПЕРЕКЛЮЧАТЕЛЬ линейки USDT (нажал вкл → водишь мышь → нажал выкл). Переживает потерю фокуса/скриншот
        if(window.rulerHeld){ if(S._lastS!=null){ const anc=(S._lastS>=S.baS?S.baS:S.bbS); S._ruler={a:anc, b:S._lastS}; } }
        else { S._ruler=null; }
        if(window.markDirty) markDirty(); } return; }
    if(code==="KeyF"){ window.fHeld=true; updateCloseMode(); return; }   // ЗАЖАТЬ F = режим «заявка на закрытие»: клик по цене ставит reduce-only лимитку на весь объём позиции
    if(code==="ControlLeft"||code==="ControlRight"){ window.ctrlHeld=true; updateCloseMode(); return; }   // ЗАЖАТЬ Ctrl = тот же режим (индикатор внизу загорается)
    if(e.ctrlKey||e.metaKey||e.altKey) return;   // 🔴 КРИТ: НЕ выполнять торговые клавиши с Ctrl/Alt/Meta (Ctrl+Shift+R=перезагрузка дёргала R=реверс→открывала позу! Ctrl+A/S тоже)
    // настраиваемые торговые действия (по физ.коду, работает на любой раскладке)
    for(const act in ACT){ const kk=K[act]||(typeof DEFAULT_KEYS!=="undefined"?DEFAULT_KEYS[act]:null);   // фолбэк на дефолт → новые клавиши (W/E/N) работают без сброса сохранённых
      if(kk && code===kk){ if(act==="center") e.preventDefault(); ACT[act](); return; } }
    switch(code){   // фиксированные служебные
      case "F9": e.preventDefault(); if(window.togglePerf) togglePerf(); break;   // встроенный профайлер (FPS/ms/пропуски)
      case "KeyH": window.hHeld=true; break;   // зажать H + колесо над стаканом = сжать/разжать
      case "Digit1": case "Digit2": case "Digit3": case "Digit4": case "Digit5":
        if(window.selectLot) selectLot(parseInt(code.slice(5),10)-1); break;
      case "ShiftLeft": case "ShiftRight": if(window.centerNow) centerNow(); break;   // Shift = центр (доп.)
      case "KeyQ": { e.preventDefault(); const s=document.getElementById("symbol"); s&&s.focus(); break; }
      case "Space": e.preventDefault(); cancelAll(); break;
      case "Equal": case "NumpadAdd": compress(1); break;
      case "Minus": case "NumpadSubtract": compress(-1); break;
      case "Digit0": setStepMult(50); break;
      case "Digit9": setStepMult(1); break;
      case "BracketLeft":  if(typeof applyRowH==="function" && S.rowCss>7){ applyRowH(S.rowCss-1); } break;   // [ — строки ниже = видно БОЛЬШЕ уровней
      case "BracketRight": if(typeof applyRowH==="function" && S.rowCss<28){ applyRowH(S.rowCss+1); } break;  // ] — строки выше
      case "ArrowUp": if(sc){ e.preventDefault(); sc.scrollTop-=42; } break;
      case "ArrowDown": if(sc){ e.preventDefault(); sc.scrollTop+=42; } break;
      case "PageUp": if(sc){ e.preventDefault(); sc.scrollTop-=sc.clientHeight*0.8; } break;
      case "PageDown": if(sc){ e.preventDefault(); sc.scrollTop+=sc.clientHeight*0.8; } break;
      case "ArrowLeft": if(sc){ e.preventDefault(); sc.scrollLeft-=120; } break;
      case "ArrowRight": if(sc){ e.preventDefault(); sc.scrollLeft+=120; } break;
    }
  });
  document.addEventListener("keyup",(e)=>{ if(e.code==="KeyH") window.hHeld=false;
    if(e.code==="KeyF") window.fHeld=false;
    if(e.code==="ControlLeft"||e.code==="ControlRight") window.ctrlHeld=false;
    updateCloseMode(); });   // L теперь переключатель (не hold) — по отпусканию ничего не делаем
  window.addEventListener("blur",()=>{ window.fHeld=false; window.ctrlHeld=false; window.hHeld=false; updateCloseMode(); });   // отпустил фокус (alt-tab) — сбросить hold-режимы (линейка L — переключатель, её не трогаем)
}

// подхватить УЖЕ подключённую биржу (сервер сам поднял сохранённый токен Ourbit) — чтобы не вставлять заново
function reflectConnected(s){
  if(!(s&&s.connected)) return false;
  T.connected=true;
  const fee=s.fee||{}, zero=fee.zero_fee;
  const el=$$("acct"); if(el){ el.textContent=`баланс $${(s.balance||0).toFixed(2)} · fee ${zero?"0% ✓":"НЕ 0%"}`; el.className="acct ok"; }
  const lb=$$("livebtn"); if(lb) lb.disabled=false;
  refreshAccount();
  return true;
}
function autoReflect(){
  let tries=0;
  const t=setInterval(async()=>{
    tries++;
    if(T.connected){ clearInterval(t); return; }
    try{ const s=await fetch("/api/state").then(r=>r.json());
      if(reflectConnected(s)){ log("Ourbit подключён автоматически (сохранённый токен)","ok"); clearInterval(t); } }catch(e){}
    if(tries>12) clearInterval(t);         // ~18с попыток (сервер проверяет токен в фоне при старте)
  }, 1500);
}

function wireTrade(){
  $$("connectbtn").onclick=connect;
  $$("token").addEventListener("keydown",(e)=>{ if(e.key==="Enter") connect(); });
  $$("livebtn").onchange=(e)=>setArm(e.target.checked);
  const bind=(id,fn)=>{ const el=$$(id); if(el) el.onclick=fn; };
  bind("m-buy",marketBuy); bind("m-sell",marketSell); bind("m-close",closePos);
  bind("m-rev",reverse); bind("m-cancel",cancelAll);
  wireMouse(); wireKeys();
  setInterval(refreshAccount, 1500);
  setInterval(checkRisk, 300);        // следим за SL/TP/безубытком быстрее, чем обновление аккаунта
  autoReflect();                      // при загрузке — подхватить сохранённое подключение Ourbit
}
wireTrade();
