// ── ВИДЖЕТ БАГ-РЕПОРТА (чат помощи) ──
// Плавающая кнопка 💬 внизу справа → окошко: описание бага + ФОТО (файл или Ctrl+V) → шлём на /api/bug.
// Сервер терминала пересылает на центральный сервер активации, где копятся баги от всех друзей (с картинками).
(function(){
  "use strict";
  function ver(){ try{ const s=[...document.scripts].find(x=>x.src.includes("app.js")); const m=s&&s.src.match(/v=([\w.]+)/); return m?m[1]:"?"; }catch(e){ return "?"; } }
  function sym(){ try{ return (window.S&&S.symbol)||""; }catch(e){ return ""; } }

  // ── стили (инлайн, чтобы не зависеть от style.css) ──
  const css=document.createElement("style");
  css.textContent=`
  #bugfab{position:fixed;right:18px;bottom:16px;width:46px;height:46px;border-radius:50%;
    background:#2b6cff;color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;
    cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);z-index:99998;border:1px solid rgba(255,255,255,.2);
    transition:transform .12s,background .12s;user-select:none}
  #bugfab:hover{transform:scale(1.08);background:#3f7bff}
  #bugpanel{position:fixed;right:18px;bottom:72px;width:320px;background:#181c24;border:1px solid #2c3444;
    border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.55);z-index:99999;display:none;overflow:hidden;
    font-family:Arial,Helvetica,sans-serif;color:#dfe5ee}
  #bugpanel.on{display:block}
  #bughead{background:#20favc;background:linear-gradient(90deg,#233152,#1b2130);padding:10px 12px;font-weight:700;
    font-size:14px;display:flex;justify-content:space-between;align-items:center}
  #bughead .x{cursor:pointer;opacity:.7;font-size:16px}
  #bughead .x:hover{opacity:1}
  #bugbody{padding:12px}
  #bugtext{width:100%;box-sizing:border-box;height:88px;resize:vertical;background:#10141b;color:#e8edf5;
    border:1px solid #2c3444;border-radius:8px;padding:8px;font-size:13px;font-family:inherit;outline:none}
  #bugtext:focus{border-color:#3f7bff}
  .bugrow{display:flex;gap:8px;align-items:center;margin-top:8px}
  .bugbtn{background:#232b39;color:#cfd8e6;border:1px solid #333c4d;border-radius:7px;padding:7px 10px;
    font-size:12px;cursor:pointer}
  .bugbtn:hover{background:#2c384a}
  .bugbtn.send{background:#2b6cff;color:#fff;border-color:#2b6cff;font-weight:700;flex:1;text-align:center}
  .bugbtn.send:hover{background:#3f7bff}
  #bugthumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  #bugthumbs .th{position:relative;width:60px;height:46px;border-radius:6px;overflow:hidden;border:1px solid #333c4d}
  #bugthumbs .th img{width:100%;height:100%;object-fit:cover}
  #bugthumbs .th b{position:absolute;top:0;right:0;background:rgba(0,0,0,.6);color:#fff;font-size:11px;
    width:15px;height:15px;line-height:15px;text-align:center;cursor:pointer}
  #bughint{font-size:11px;color:#8994a6;margin-top:8px;line-height:1.4}
  #bugstatus{font-size:12px;margin-top:8px;min-height:16px}
  #bugstatus.ok{color:#5ecb7f}#bugstatus.err{color:#ef8f8a}`;
  document.head.appendChild(css);

  // ── разметка ──
  const fab=document.createElement("div"); fab.id="bugfab"; fab.title="Сообщить о баге"; fab.textContent="💬";
  const panel=document.createElement("div"); panel.id="bugpanel";
  panel.innerHTML=`
    <div id="bughead"><span>🐞 Сообщить о баге</span><span class="x" id="bugclose">✕</span></div>
    <div id="bugbody">
      <textarea id="bugtext" placeholder="Опиши баг: что делал(а), что пошло не так, на какой монете…"></textarea>
      <div id="bugthumbs"></div>
      <div class="bugrow">
        <button class="bugbtn" id="bugphoto">📷 Прикрепить фото</button>
        <input type="file" id="bugfile" accept="image/*" multiple style="display:none">
      </div>
      <div id="bughint">Можно вставить скриншот прямо сюда: <b>Ctrl+V</b> (сделай PrtScn / Win+Shift+S, потом Ctrl+V в это окно).</div>
      <div class="bugrow"><button class="bugbtn send" id="bugsend">Отправить</button></div>
      <div id="bugstatus"></div>
    </div>`;
  document.body.appendChild(fab); document.body.appendChild(panel);

  const $=(id)=>document.getElementById(id);
  const images=[];   // массив dataURL (jpeg)

  function open(){ panel.classList.add("on"); setTimeout(()=>$("bugtext").focus(),50); }
  function close(){ panel.classList.remove("on"); }
  fab.onclick=()=>panel.classList.contains("on")?close():open();
  $("bugclose").onclick=close;

  // сжать картинку до ~1600px / jpeg, чтобы не грузить сеть
  function compress(file, cb){
    const r=new FileReader();
    r.onload=()=>{ const img=new Image();
      img.onload=()=>{ const max=1600, sc=Math.min(1,max/Math.max(img.width,img.height));
        const w=Math.round(img.width*sc), h=Math.round(img.height*sc);
        const c=document.createElement("canvas"); c.width=w; c.height=h;
        c.getContext("2d").drawImage(img,0,0,w,h);
        try{ cb(c.toDataURL("image/jpeg",0.7)); }catch(e){ cb(null); } };
      img.onerror=()=>cb(null); img.src=r.result; };
    r.onerror=()=>cb(null); r.readAsDataURL(file);
  }
  function addImage(file){ if(!file||images.length>=4) return;
    compress(file,(d)=>{ if(!d) return; images.push(d); renderThumbs(); }); }
  function renderThumbs(){ const box=$("bugthumbs"); box.innerHTML="";
    images.forEach((d,i)=>{ const th=document.createElement("div"); th.className="th";
      th.innerHTML=`<img src="${d}"><b data-i="${i}">✕</b>`;
      th.querySelector("b").onclick=()=>{ images.splice(i,1); renderThumbs(); };
      box.appendChild(th); }); }

  $("bugphoto").onclick=()=>$("bugfile").click();
  $("bugfile").onchange=(e)=>{ [...e.target.files].forEach(addImage); e.target.value=""; };
  // вставка скриншота Ctrl+V (когда панель открыта)
  window.addEventListener("paste",(e)=>{ if(!panel.classList.contains("on")) return;
    const items=(e.clipboardData||{}).items||[];
    for(const it of items){ if(it.type&&it.type.indexOf("image")===0){ const f=it.getAsFile(); if(f) addImage(f); } } });

  async function send(){
    const text=$("bugtext").value.trim();
    const st=$("bugstatus");
    if(!text && !images.length){ st.className="err"; st.textContent="Напиши что за баг или прикрепи фото."; return; }
    st.className=""; st.textContent="Отправляю…";
    try{
      const r=await fetch("/api/bug",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text, images, symbol:sym(), version:ver(), ua:navigator.userAgent})}).then(x=>x.json());
      if(r&&r.ok){ st.className="ok"; st.textContent="✓ Отправлено! Спасибо — баг ушёл разработчику.";
        $("bugtext").value=""; images.length=0; renderThumbs(); setTimeout(close,1400); }
      else { st.className="err"; st.textContent="Не отправилось: "+((r&&r.error)||"нет связи с сервером багов"); }
    }catch(e){ st.className="err"; st.textContent="Ошибка сети — попробуй ещё раз."; }
  }
  $("bugsend").onclick=send;
})();
