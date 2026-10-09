// Ринок, частина 2: графіки (наживо, за період, по монетах), валюта, CSV.
// Потребує market-live.js.

// ---------- Графіки ----------

// Малює лінійний графік у SVG всередині елемента box
function drawChart(box, prices, label, periodText) {
  // Якщо нічого не змінилось (та сама остання ціна, валюта, підказка) — графік не перебудовуємо:
  // так не перезапускається анімація пульсуючої точки й не витрачаються сили щосекунди
  const sig = [prices.length, prices[0], prices[prices.length - 1], currency, usdRate, label, periodText, box._hover].join("|");
  if (box._sig === sig && box.firstChild) return;
  box._sig = sig;

  const min = Math.min.apply(null, prices);
  const max = Math.max.apply(null, prices);
  const span = max - min || 1; // щоб не ділити на нуль, якщо ціна не змінювалась
  const W = 600, H = 160;

  const pts = prices.map(function (p, i) {
    const x = (i / (prices.length - 1)) * W;
    const y = H - ((p - min) / span) * (H - 10) - 5;
    return x.toFixed(1) + "," + y.toFixed(1);
  });

  const change = (prices[prices.length - 1] / prices[0] - 1) * 100;
  const cls = change >= 0 ? "up" : "down";
  const color = "var(--" + cls + ")";   // зелений, якщо росте; червоний, якщо падає
  const gid = "grad-" + box.id;         // у кожного графіка свій градієнт
  const last = pts[pts.length - 1].split(",");

  // Горизонтальні напрямні лінії (сітка)
  let grid = "";
  [0.25, 0.5, 0.75].forEach(function (k) {
    grid += '<line x1="0" x2="' + W + '" y1="' + (H * k) + '" y2="' + (H * k) +
      '" stroke="var(--accent-soft)" stroke-width="1" stroke-dasharray="4 6"/>';
  });

  // Підказка при наведенні курсора (або дотику): вертикальна лінія, точка і ціна
  box._args = [prices, label, periodText];
  let hoverSvg = "", tip = "";
  if (box._hover != null) {
    const i = Math.round(box._hover * (prices.length - 1));
    const hp = pts[i].split(",");
    const diff = (prices[i] / prices[0] - 1) * 100;
    hoverSvg = '<line x1="' + hp[0] + '" x2="' + hp[0] + '" y1="0" y2="' + H +
      '" stroke="var(--muted)" stroke-width="1"/>' +
      '<circle cx="' + hp[0] + '" cy="' + hp[1] + '" r="5" style="fill:var(--card);stroke:' + color + ';stroke-width:2.5"/>';
    tip = '<div class="tip" style="left:' + (i / (prices.length - 1)) * 100 + '%">' + fmtMoney(prices[i]) +
      ' <span style="color:var(--' + (diff >= 0 ? "up" : "down") + ')">' + (diff >= 0 ? "+" : "") + diff.toFixed(2) + "%</span></div>";
  }

  if (!box._bound) {
    box._bound = true;
    const redraw = function () { drawChart.apply(null, [box].concat(box._args)); };
    const move = function (e) {
      const svg = box.querySelector("svg");
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      box._hover = Math.min(1, Math.max(0, (x - r.left) / r.width));
      redraw();
    };
    const leave = function () { box._hover = null; redraw(); };
    box.addEventListener("mousemove", move);
    box.addEventListener("touchmove", move, { passive: true });
    box.addEventListener("mouseleave", leave);
    box.addEventListener("touchend", leave);
  }

  box.innerHTML =
    '<div class="chart-svg">' +
    '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + label + '">' +
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" style="stop-color:' + color + ';stop-opacity:0.38"/>' +
    '<stop offset="100%" style="stop-color:' + color + ';stop-opacity:0"/></linearGradient></defs>' +
    grid +
    '<polygon points="0,' + H + " " + pts.join(" ") + " " + W + "," + H + '" fill="url(#' + gid + ')"/>' +
    '<polyline points="' + pts.join(" ") + '" fill="none" stroke-width="2.5" stroke-linejoin="round" style="stroke:' + color + '"/>' +
    '<circle class="live-dot-ring" cx="' + last[0] + '" cy="' + last[1] + '" r="9" style="fill:' + color + '"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4.5" style="fill:' + color + '"/>' + hoverSvg + '</svg>' + tip + '</div>' +
    '<div class="stats"><span>Мін: <b style="color:var(--down)">' + fmtMoney(min) + '</b></span>' +
    '<span>Макс: <b style="color:var(--up)">' + fmtMoney(max) + '</b></span>' +
    "<span>" + periodText + ': <b style="color:' + color + '">' +
    (change >= 0 ? "▲ +" : "▼ ") + change.toFixed(2) + "%</b></span></div>";
}

// Тижнева історія біткоїна (завантажується один раз), остання точка оновлюється наживо
const weekData = {};          // історія цін (кеш): ключ "монета:днів", наприклад "bitcoin:7"
const weekTimes = {};         // час кожної точки (мілісекунди) — потрібен для завантаження CSV
let selectedCoin = "bitcoin"; // яку монету зараз показують графіки
let selectedDays = 7;         // за який період (1, 7 або 30 днів)

function histKey(id) { return id + ":" + selectedDays; }

function periodLabel() {
  return selectedDays === 1 ? "1 день" : selectedDays + " днів";
}

async function loadWeekChart(id) {
  const box = document.getElementById("btcChart");
  if (!box) return;
  const key = histKey(id);
  if (weekData[key]) return; // уже завантажено
  box.innerHTML = '<p class="muted">Завантаження графіка…</p>';
  box._sig = "";   // щоб після завантаження графік точно перемалювався
  try {
    const data = await (await fetch("https://api.coingecko.com/api/v3/coins/" + id + "/market_chart?vs_currency=usd&days=" + selectedDays)).json();
    weekData[key] = data.prices.map(function (p) { return p[1]; });
    weekTimes[key] = data.prices.map(function (p) { return p[0]; });
  } catch (e) {
    box.innerHTML = '<p class="muted">Не вдалося завантажити графік. Спробуйте обрати монету ще раз.</p>';
    box._sig = "";
  }
}

// Графік «наживо»: накопичуємо останні 120 секунд
const liveBuffers = {}; // для кожної монети свій список останніх цін

function updateCharts() {
  // Щосекунди дописуємо точку в буфер кожної монети (тому при перемиканні історія вже є)
  Object.keys(coins).forEach(function (id) {
    if (!state[id] || !coins[id].pair) return;
    const buf = liveBuffers[id] || (liveBuffers[id] = []);
    buf.push(state[id].usd);
    if (buf.length > 120) buf.shift();
  });
  if (document.hidden) return;

  const name = coins[selectedCoin].name;
  const liveBox = document.getElementById("liveChart");
  const buf = liveBuffers[selectedCoin];
  if (liveBox && buf && buf.length > 1) {
    drawChart(liveBox, buf, "Ціна " + name + " за останні хвилини", "За цей час");
  }

  const weekBox = document.getElementById("btcChart");
  const week = weekData[histKey(selectedCoin)];
  if (weekBox && week && state[selectedCoin]) {
    week[week.length - 1] = state[selectedCoin].usd; // остання точка — наживо
    drawChart(weekBox, week, "Графік ціни " + name + " за " + periodLabel(), "За " + periodLabel());
  }
}

// Перемикач монет над графіками
const coinTabs = document.querySelectorAll(".coin-tab");
const coinTabsBox = document.getElementById("coinTabs");
if (coinTabsBox) coinTabsBox.style.setProperty("--c", coins[selectedCoin].color);   // колір активної кнопки береться з об'єкта coins

coinTabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    selectedCoin = tab.dataset.coin;
    coinTabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
    document.getElementById("coinTabs").style.setProperty("--c", coins[selectedCoin].color);
    document.querySelectorAll(".coin-name").forEach(function (el) {
      el.textContent = tab.textContent;
    });
    loadWeekChart(selectedCoin).then(updateCharts);
    updateCharts();
  });
});

// Вибір періоду графіка: 1 день, 7 днів, 30 днів
const periodTabs = document.querySelectorAll(".period-tab");

periodTabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    selectedDays = parseInt(tab.dataset.days, 10);
    periodTabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
    document.querySelectorAll(".period-name").forEach(function (el) { el.textContent = periodLabel(); });
    loadWeekChart(selectedCoin).then(updateCharts);
  });
});

// Завантаження даних графіка як CSV (відкривається в Excel / Google Таблицях)
const csvBtn = document.getElementById("csvBtn");

if (csvBtn) {
  csvBtn.addEventListener("click", function () {
    const key = histKey(selectedCoin);
    const prices = weekData[key];
    const times = weekTimes[key];
    if (!prices || !times) {
      const old = csvBtn.textContent;
      csvBtn.textContent = "Графік ще завантажується";
      setTimeout(function () { csvBtn.textContent = old; }, 1800);
      return;
    }
    // Крапка з комою як роздільник і кома в числах — так Excel українською відкриє файл правильно
    const rows = ["Час;Ціна, USD"];
    prices.forEach(function (p, i) {
      rows.push(new Date(times[i]).toISOString().replace("T", " ").slice(0, 19) + ";" + String(p).replace(".", ","));
    });
    const blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = selectedCoin + "-" + selectedDays + "d.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
}

// Перемикач валюти: долар / гривня / євро
const currencyTabs = document.querySelectorAll(".currency-tab");

function applyCurrency() {
  currencyTabs.forEach(function (t) { t.classList.toggle("active", t.dataset.cur === currency); });
  lastAnalysis = ""; // щоб огляд ринку перемалювався в новій валюті
}

currencyTabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    currency = tab.dataset.cur;
    try { localStorage.setItem("currency", currency); } catch (e) {}
    applyCurrency();
    renderPrices();
    updateCharts();
  });
});
applyCurrency();
