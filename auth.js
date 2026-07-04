/* Экран входа SQUAD TERMINAL.
   Весь терминал закрыт логином+паролем: скрипты приложения (class="appjs") НЕ выполняются,
   пока вход не пройден. Логин проверяется на сервере Вики (через бэкенд /api/login).
   Вошёл — auth.js по очереди подключает app.js и остальные модули в исходном порядке. */
(function () {
  "use strict";
  var gate, msgEl, formEl, loginEl, passEl, errEl, booted = false;

  function $(id) { return document.getElementById(id); }

  // Подключить скрипты приложения ПОСЛЕДОВАТЕЛЬНО (порядок важен: app.js задаёт глобалы для остальных)
  function bootApp() {
    if (booted) return;
    booted = true;
    var tags = Array.prototype.slice.call(document.querySelectorAll("script.appjs"));
    (function next(i) {
      if (i >= tags.length) return;
      var src = tags[i].getAttribute("data-src");
      if (!src) { next(i + 1); return; }
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { next(i + 1); };
      s.onerror = function () { next(i + 1); };   // не спотыкаемся на одном файле
      document.body.appendChild(s);
    })(0);
  }

  function hideGate() {
    if (gate) gate.style.display = "none";
  }

  function showForm(prefillErr) {
    if (msgEl) msgEl.style.display = "none";
    if (formEl) formEl.style.display = "block";
    if (errEl) errEl.textContent = prefillErr || "";
    if (loginEl) loginEl.focus();
  }

  function submit(ev) {
    if (ev) ev.preventDefault();
    var login = (loginEl && loginEl.value || "").trim();
    var pass = (passEl && passEl.value) || "";
    if (!login || !pass) { errEl.textContent = "Впиши логин и пароль."; return; }
    errEl.textContent = "Проверяю…";
    var btn = $("authbtn"); if (btn) btn.disabled = true;
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: login, password: pass })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (btn) btn.disabled = false;
        if (d && d.ok) {
          hideGate();
          bootApp();
        } else {
          errEl.textContent = (d && d.error) || "Неверный логин или пароль.";
          if (passEl) { passEl.value = ""; passEl.focus(); }
        }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        errEl.textContent = "Нет связи с терминалом. Перезапусти start.bat.";
      });
  }

  function init() {
    gate = $("authgate");
    msgEl = $("authmsg");
    formEl = $("authform");
    loginEl = $("authlogin");
    passEl = $("authpass");
    errEl = $("autherr");
    if (formEl) formEl.addEventListener("submit", submit);
    var btn = $("authbtn");
    if (btn) btn.addEventListener("click", submit);

    fetch("/api/authstatus").then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && (d.authed || !d.required)) {
          hideGate();
          bootApp();               // уже вошёл (или вход не требуется) — грузим приложение
        } else {
          showForm();              // нужен логин+пароль
        }
      })
      .catch(function () {
        // Бэкенд не ответил — покажем форму (после входа перепроверится)
        showForm("Не удалось проверить доступ. Впиши логин и пароль.");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
