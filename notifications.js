"use strict";
// Лента уведомлений: сбор событий (алерты, прострелы, крупные принты, спред-гейт). window.notify(msg, kind).
(function(){
  const g=(id)=>document.getElementById(id);
  const win=g("notifwin"); if(!win) return;
  const FEED=[]; let unseen=0;
  function two(n){ return n<10?"0"+n:""+n; }
  function stamp(){ const d=new Date(); return two(d.getHours())+":"+two(d.getMinutes())+":"+two(d.getSeconds()); }
  function render(){
    const el=g("notiflist"); if(!el) return;
    if(!FEED.length){ el.innerHTML='<div class="fin-empty">пока нет уведомлений</div>'; return; }
    let h="";
    for(let i=FEED.length-1;i>=0&& i>FEED.length-200;i--){ const n=FEED[i];
      h+='<div class="ntf ntf-'+(n.kind||"info")+'"><span class="ntf-t">'+n.time+'</span>'+n.msg+'</div>'; }
    el.innerHTML=h;
  }
  function badge(){ const c=g("notifcnt"); if(!c) return; if(unseen>0){ c.textContent=unseen>99?"99+":unseen; c.classList.remove("hidden"); } else c.classList.add("hidden"); }
  window.notify=function(msg, kind){ if(!msg) return;
    FEED.push({time:stamp(), msg:String(msg), kind:kind||"info"});
    if(FEED.length>500) FEED.splice(0, FEED.length-500);
    if(win.classList.contains("hidden")){ unseen++; badge(); } else render();
  };
  function open(){ win.classList.remove("hidden"); unseen=0; badge(); render(); }
  function close(){ win.classList.add("hidden"); }
  const btn=g("notifbtn"); if(btn) btn.onclick=()=> win.classList.contains("hidden")?open():close();
  const x=g("notifclose"); if(x) x.onclick=close;
  const clr=g("notifclr"); if(clr) clr.onclick=(e)=>{ e.stopPropagation(); FEED.length=0; render(); };
  if(window.Dock) window.Dock.makeWindow({ win, handle:g("notifdrag"), titleBar:g("notifdrag"), resize:g("notifres"), key:"notif", minW:260, minH:200 });
})();
