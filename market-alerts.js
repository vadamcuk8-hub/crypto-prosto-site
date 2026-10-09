// Ринок, частина 5: сповіщення про ціну.
// Потребує market-live.js.

// ---------- Сповіщення про ціну ----------
const alertCoin = document.getElementById("alertCoin");
const alertDir = document.getElementById("alertDir");
const alertPrice = document.getElementById("alertPrice");
const alertList = document.getElementById("alertList");
const alertError = document.getElementById("alertError");
const alertNow = document.getElementById("alertNow");

let alerts = [];
try { alerts = JSON.parse(localStorage.getItem("alerts") || "[]"); } catch (e) { alerts = []; }

function saveAlerts() {
  try { localStorage.setItem("alerts", JSON.stringify(alerts)); } catch (e) {}
}

function coinShort(id) {
  return coins[id].name.replace(/.*\(|\)/g, "") || coins[id].name;
}

function renderAlerts() {
  if (!alertList) return;
  alertList.innerHTML = "";
  if (!alerts.length) {
    alertList.innerHTML = '<li class="muted">Сповіщень поки немає.</li>';
    return;
  }
  alerts.forEach(function (a, i) {
    const li = document.createElement("li");
    const dir = a.dir === "above" ? "вище" : "нижче";
    const text = coinShort(a.coin) + " " + dir + " " + fmtOnlyUsd(a.price);
    li.className = a.done ? "done" : "";
    li.innerHTML = '<span>' + (a.done ? "✓ Спрацювало: " : "● Чекаємо: ") + text +
      (a.done ? " (було " + fmtOnlyUsd(a.hit) + ")" : "") + "</span>";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chip";
    del.textContent = "Видалити";
    del.addEventListener("click", function () {
      alerts.splice(i, 1);
      saveAlerts();
      renderAlerts();
    });
    li.appendChild(del);
    alertList.appendChild(li);
  });
}

// Сповіщення на сторінці (і системне, якщо дозволено)
let toastTimer = null;
function showToast(text) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "alert");
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 12000);
  t.onclick = function () { t.classList.remove("show"); };
}

function checkAlerts() {
  let changed = false;
  alerts.forEach(function (a) {
    if (a.done || !state[a.coin]) return;
    const p = state[a.coin].usd;
    if ((a.dir === "above" && p >= a.price) || (a.dir === "below" && p <= a.price)) {
      a.done = true;
      a.hit = p;
      changed = true;
      const msg = coinShort(a.coin) + " став " + (a.dir === "above" ? "вищим" : "нижчим") + " за " +
        fmtOnlyUsd(a.price) + ". Зараз: " + fmtOnlyUsd(p);
      showToast("Сповіщення: " + msg);
      document.title = "● " + document.title.replace(/^● /, "");
      if ("Notification" in window && Notification.permission === "granted") {
        try { new Notification("Крипто простими словами", { body: msg }); } catch (e) {}
      }
    }
  });
  if (changed) { saveAlerts(); renderAlerts(); }
}

// Показуємо поточну ціну вибраної монети — щоб було від чого відштовхуватись (викликається щосекунди з головного циклу)
function updateAlertNow() {
  if (!alertNow) return;
  const s = state[alertCoin.value];
  setText(alertNow, s ? "Зараз " + coinShort(alertCoin.value) + ": " + fmtOnlyUsd(s.usd) : "");
}

if (alertList) {
  renderAlerts();
  alertCoin.addEventListener("change", updateAlertNow);

  document.getElementById("alertAdd").addEventListener("click", function () {
    alertError.textContent = "";
    const price = parseFloat(String(alertPrice.value).replace(/\s/g, "").replace(",", "."));
    const s = state[alertCoin.value];
    if (isNaN(price) || price <= 0) { alertError.textContent = "Введіть ціну в доларах, наприклад 90000."; return; }
    if (!s) { alertError.textContent = "Ціни ще завантажуються. Спробуйте за кілька секунд."; return; }
    if ((alertDir.value === "above" && s.usd >= price) || (alertDir.value === "below" && s.usd <= price)) {
      alertError.textContent = "Ця умова вже виконана: зараз " + fmtOnlyUsd(s.usd) + ". Оберіть іншу ціну.";
      return;
    }
    if (alerts.filter(function (a) { return !a.done; }).length >= 10) { alertError.textContent = "Не більше 10 активних сповіщень."; return; }
    alerts.push({ coin: alertCoin.value, dir: alertDir.value, price: price, done: false });
    alertPrice.value = "";
    saveAlerts();
    renderAlerts();
  });

  // Кнопка дозволу на системні сповіщення (якщо браузер їх підтримує)
  const permBtn = document.getElementById("alertPerm");
  if ("Notification" in window && Notification.permission === "default") {
    permBtn.hidden = false;
    permBtn.addEventListener("click", function () {
      Notification.requestPermission().then(function () { permBtn.hidden = true; });
    });
  }

  // Повернули увагу на вкладку — прибираємо позначку в заголовку
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) document.title = document.title.replace(/^● /, "");
  });
}
