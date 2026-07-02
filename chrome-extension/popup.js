"use strict";
// Читает токен Ourbit с открытой страницы (cookie + localStorage) и подключает локальный терминал.
const TERM = "http://localhost:8777/api/exttoken";
const $ = (id) => document.getElementById(id);

function setStatus(msg, cls) { const s = $("status"); s.textContent = msg; s.className = "row " + (cls || ""); }
function showTok(tok) { const t = $("tok"); if (tok) { t.style.display = "block"; t.textContent = "токен: " + tok.slice(0, 10) + "…" + tok.slice(-6); } }

// кандидаты имён токена
const COOKIE_NAMES = ["uc_token", "u_token", "u_id", "token", "access_token", "authorization"];
const LS_HINT = /uc_?token|access_?token|(^|_)token$|authorization/i;

async function tokenFromCookies() {
  // читает cookie с доменов ourbit (в т.ч. HttpOnly — через chrome.cookies)
  const found = {};
  for (const dom of ["ourbit.com", ".ourbit.com", "futures.ourbit.com"]) {
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ domain: dom }); } catch (e) {}
    for (const c of cookies) found[c.name] = c.value;
  }
  for (const n of COOKIE_NAMES) if (found[n] && found[n].length > 20) return found[n];
  // иначе — самый «токеноподобный» по имени
  for (const n in found) if (LS_HINT.test(n) && found[n].length > 20) return found[n];
  return null;
}

async function tokenFromPage() {
  // fallback: читаем localStorage/куки прямо со страницы Ourbit (нужна открытая вкладка)
  const tabs = await chrome.tabs.query({ url: ["https://*.ourbit.com/*"] });
  if (!tabs.length) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const hint = /uc_?token|access_?token|(^|_)token$|authorization/i;
        const out = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && hint.test(k)) out[k] = localStorage.getItem(k); } } catch (e) {}
        try { document.cookie.split(";").forEach(p => { const [k, v] = p.split("="); if (k && hint.test(k.trim())) out["cookie:" + k.trim()] = (v || "").trim(); }); } catch (e) {}
        return out;
      },
    });
    const vals = res && res.result || {};
    for (const k in vals) { let v = vals[k]; if (typeof v === "string" && v.length > 20) { try { const j = JSON.parse(v); v = j.token || j.access_token || j.value || v; } catch (e) {} if (typeof v === "string" && v.length > 20) return v; } }
  } catch (e) {}
  return null;
}

async function connect() {
  $("go").disabled = true; setStatus("ищу токен на странице Ourbit…");
  let tok = await tokenFromCookies();
  if (!tok) tok = await tokenFromPage();
  if (!tok) { setStatus("токен не найден. Войди на futures.ourbit.com и открой её вкладку.", "err"); $("go").disabled = false; return; }
  showTok(tok);
  setStatus("подключаю терминал…");
  try {
    const r = await fetch(TERM, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tok }) }).then(x => x.json());
    if (r.ok) setStatus("✓ подключено · баланс $" + (r.balance != null ? r.balance.toFixed(2) : "?") + (r.fee && r.fee.zero_fee ? " · fee 0%" : ""), "ok");
    else setStatus("терминал ответил: " + (r.error || "ошибка"), "err");
  } catch (e) {
    setStatus("терминал недоступен (localhost:8777 запущен?)", "err");
  }
  $("go").disabled = false;
}

$("go").addEventListener("click", connect);
