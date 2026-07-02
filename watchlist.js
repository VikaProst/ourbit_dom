"use strict";
// Вочлист: избранные монеты, живая цена/изм%, клик→переключить (линк). Данные /api/ticker per coin.
(function(){
  const g=(id)=>document.getElementById(id);
  const win=g("watchwin"); if(!win) return;
  let timer=null;
  let WL=[]; try{ WL=JSON.parse(localStorage.getItem("wl"))||[]; }catch(e){}
  const save=()=>{ try{ localStorage.setItem("wl", JSON.stringify(WL)); }catch(e){} };
  const cache={};                                        // sym -> {rise,last}

  function fmtP(v){ if(v>=1)return v.toFixed(v>=100?2:3); return v.toPrecision(4); }
  function render(){
    const tb=g("watchrows"); if(!tb) return;
    const cur=(typeof S!=="undefined"&&S.symbol)||"";
    if(!WL.length){ tb.innerHTML='<tr><td class="scrempty">пусто — жми ＋ чтобы добавить текущую монету</td></tr>'; return; }
    let h="";
    for(const sym of WL){ const d=cache[sym]||{}; const up=(d.rise||0)>=0; const base=sym.replace("_USDT","");
      h+='<tr data-sym="'+sym+'" class="scrrow'+(sym===cur?" active":"")+'">'
        +'<td class="coin"><span class="exbadge">F</span>'+base+'</td>'
        +'<td class="num">'+(d.last!=null?fmtP(d.last):"—")+'</td>'
        +'<td class="num '+(up?"up":"down")+'">'+(d.rise!=null?(up?"+":"")+d.rise.toFixed(2)+"%":"—")+'</td>'
        +'<td class="num wl-x" title="убрать">×</td></tr>';
    }
    tb.innerHTML=h;
    tb.querySelectorAll(".scrrow").forEach(tr=>{
      tr.onclick=(e)=>{ const sym=tr.dataset.sym;
        if(e.target.classList.contains("wl-x")){ WL=WL.filter(x=>x!==sym); save(); render(); return; }
        if(typeof switchSymbol==="function"){ switchSymbol(sym); const inp=g("symbol"); if(inp) inp.value=sym.replace("_USDT",""); } };
    });
  }
  async function poll(){
    for(const sym of WL){
      try{ const r=await fetch("/api/ticker?symbol="+encodeURIComponent(sym)).then(x=>x.json());
        if(r&&r.ok) cache[sym]={rise:(r.rise!=null?r.rise*100:null), last:(r.last!=null?+r.last:null)}; }catch(e){}
    }
    render();
  }
  function open(){ if(window.untileFloat) window.untileFloat(win,{right:20,top:130,w:260,h:380}); else win.classList.remove("hidden");
    render(); poll(); if(timer) clearInterval(timer); timer=setInterval(poll,3000); }
  function close(){ win.classList.add("hidden"); if(timer){ clearInterval(timer); timer=null; } }

  const btn=g("watchbtn"); if(btn) btn.onclick=()=> (window.isPanelFloatingVisible?window.isPanelFloatingVisible(win):!win.classList.contains("hidden"))?close():open();
  const x=g("watchclose"); if(x) x.onclick=close;
  const add=g("watchadd"); if(add) add.onclick=(e)=>{ e.stopPropagation();
    const s=(typeof S!=="undefined"&&S.symbol)||""; if(s&&WL.indexOf(s)<0){ WL.push(s); save(); poll(); } };
  const lk=g("watch-link"); if(lk){ lk.checked=!!window.linkOn; lk.onchange=()=>{ window.linkOn=lk.checked; }; }
  if(window.Dock) window.Dock.makeWindow({ win, handle:g("watchdrag"), titleBar:g("watchdrag"), resize:g("watchres"), key:"watch", minW:200, minH:180 });
})();
