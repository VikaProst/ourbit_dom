// dock.js — общий менеджер плавающих окон: перетаскивание + докинг к краям экрана +
// ресайз + сворачивание (roll-up к шапке) + сохранение раскладки в localStorage.
// Используется графиком, скринером и лентой (единое поведение = 1:1 с MetaScalp).
(function(){
  "use strict";
  const $ = (id) => document.getElementById(id);
  const T = 78;                          // высота верхней панели приложения
  const LS = "ourbit.dock.v1";
  let STATE = {};
  try{ STATE = JSON.parse(localStorage.getItem(LS)) || {}; }catch(e){}
  const save = () => { try{ localStorage.setItem(LS, JSON.stringify(STATE)); }catch(e){} };

  // ЦЕЛЬ ДОКИНГА: при перетаскивании обычного окна цель = окно стакана (#bookwin) → можно бросить ПОВЕРХ стакана.
  // При перетаскивании самого стакана цель = весь экран (докинг к краям экрана).
  let _R = null;
  function targetRect(win){
    const bw = $("bookwin");
    if(bw && win !== bw){ const r = bw.getBoundingClientRect(); return {l:r.left, t:r.top, w:r.width, h:r.height}; }
    return {l:0, t:T, w:innerWidth, h:innerHeight - T};
  }
  function positionCross(){ const c = $("dockcross"); if(!c || !_R) return;
    c.style.left = Math.round(_R.l + _R.w/2)+"px"; c.style.top = Math.round(_R.t + _R.h/2)+"px"; }
  // прямоугольники доков относительно цели _R (половины/центр-поверх)
  function dockRect(d){ const R = _R || {l:0, t:T, w:innerWidth, h:innerHeight - T};
    if(d === "left")   return [R.l, R.t, Math.round(R.w/2), R.h];
    if(d === "right")  return [R.l + Math.round(R.w/2), R.t, Math.round(R.w/2), R.h];
    if(d === "top")    return [R.l, R.t, R.w, Math.round(R.h/2)];
    if(d === "bottom") return [R.l, R.t + Math.round(R.h/2), R.w, Math.round(R.h/2)];
    if(d === "center") return [R.l, R.t, R.w, R.h];   // ПОВЕРХ стакана (весь его прямоугольник)
    return null; }
  function showPreview(d){ const p = $("dockpreview"); if(!p) return;
    const r = d && dockRect(d); if(!r){ p.style.display = "none"; return; }
    p.style.left = r[0]+"px"; p.style.top = r[1]+"px"; p.style.width = r[2]+"px"; p.style.height = r[3]+"px"; p.style.display = "block"; }
  function hotZone(x,y){ const c = $("dockcross"); if(!c || c.style.display === "none") return null;
    let hot = null; c.querySelectorAll(".dz").forEach(z => { const r = z.getBoundingClientRect();
      const inside = x>=r.left && x<=r.right && y>=r.top && y<=r.bottom; z.classList.toggle("hot", inside); if(inside) hot = z.dataset.dock; });
    showPreview(hot); return hot; }

  function applyState(win, s, onResize){
    if(!s) return;
    // зажимаем в видимую зону — окно не может восстановиться за экраном (страховка от «пропавших» окон)
    if(s.left != null){ win.style.left = Math.max(0, Math.min(innerWidth-80, s.left))+"px"; win.style.right = "auto"; }
    if(s.top   != null) win.style.top   = Math.max(0, Math.min(innerHeight-40, s.top))+"px";
    if(s.width != null) win.style.width = Math.max(160, s.width)+"px";
    if(s.height!= null) win.style.height= Math.max(120, s.height)+"px";
    win.classList.toggle("collapsed", !!s.collapsed);
    if(onResize) onResize();
  }
  function record(win, key){ if(win.classList.contains("tiled")) return;   // вложенную в тайл позицию НЕ сохранять
    const s = STATE[key] || (STATE[key] = {});
    s.left = win.offsetLeft; s.top = win.offsetTop; s.width = win.offsetWidth; s.height = win.offsetHeight;
    s.collapsed = win.classList.contains("collapsed"); save(); }

  function makeWindow(o){
    const win = o.win, handle = o.handle, key = o.key, onResize = o.onResize;
    if(!win || !handle) return;
    // кнопка сворачивания в шапке (перед крестиком закрытия)
    const tb = o.titleBar || handle;
    if(tb && !tb.querySelector(".wbmin")){
      const b = document.createElement("button"); b.className = "wbx wbmin"; b.textContent = "–"; b.title = "Свернуть/развернуть";
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); win.classList.toggle("collapsed"); if(onResize) onResize(); record(win, key); };
      const x = tb.querySelector(".wbx"); tb.insertBefore(b, x || null);
    }
    // перетаскивание + докинг
    let dx=0, dy=0, on=false;
    handle.addEventListener("mousedown", (e) => { if(["SELECT","BUTTON","INPUT","OPTION"].includes(e.target.tagName)) return;
      if(win.classList.contains("tiled")) return;      // панель вложена в тайл-воркспейс — не таскать за шапку
      on = true; dx = e.clientX - win.offsetLeft; dy = e.clientY - win.offsetTop;
      _R = targetRect(win); positionCross();          // крест над стаканом (или экраном, если тащим сам стакан)
      const c = $("dockcross"); if(c) c.style.display = "block"; e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if(!on) return;
      win.style.left = Math.max(0, e.clientX-dx)+"px"; win.style.top = Math.max(40, e.clientY-dy)+"px"; win.style.right = "auto";
      hotZone(e.clientX, e.clientY); });
    window.addEventListener("mouseup", (e) => { if(!on) return; on = false;
      const z = hotZone(e.clientX, e.clientY); const c = $("dockcross"); if(c) c.style.display = "none"; showPreview(null);
      if(z){ const r = dockRect(z); win.style.left=r[0]+"px"; win.style.top=r[1]+"px"; win.style.right="auto"; win.style.width=r[2]+"px"; win.style.height=r[3]+"px"; if(onResize) onResize(); }
      record(win, key); });
    // ресайз
    if(o.resize){ let ron=false, sx=0, sy=0, sw=0, sh=0;
      o.resize.addEventListener("mousedown", (e) => { ron=true; sx=e.clientX; sy=e.clientY; sw=win.offsetWidth; sh=win.offsetHeight; e.preventDefault(); e.stopPropagation(); });
      window.addEventListener("mousemove", (e) => { if(!ron) return;
        win.style.width = Math.max(o.minW||300, sw+e.clientX-sx)+"px"; win.style.height = Math.max(o.minH||200, sh+e.clientY-sy)+"px"; if(onResize) onResize(); });
      window.addEventListener("mouseup", () => { if(ron){ ron=false; record(win, key); } });
    }
    applyState(win, STATE[key], onResize);       // восстановить сохранённую раскладку
  }

  window.Dock = { makeWindow, dockRect, record: (win,key) => record(win,key) };
})();
