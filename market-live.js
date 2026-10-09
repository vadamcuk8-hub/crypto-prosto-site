// Ринок, частина 1: стан, курси НБУ, ціни Binance/CoinGecko, огляд ринку, індекс страху.
// Потребує core.js (setText, fmtOnlyUsd, pct, root).

const LIVE_MS = 10000;   // дані Binance вважаються «живими», якщо вони новіші за 10 секунд
let heatMemo = {};       // кеш кольорів тексту на плитках теплової карти (скидається при зміні теми)
document.addEventListener("themechange", function () { heatMemo = {}; });

// ---------- Живі курси ----------

// Курси НБУ: скільки гривень коштує 1 долар і 1 євро (заповнюються в loadFiat)
let usdRate = 0;
let eurRate = 0;

// Обрана валюта цін: "usd", "uah" або "eur" (запам'ятовується в браузері)
let currency = "usd";
try {
  const savedCur = localStorage.getItem("currency");
  if (savedCur === "uah" || savedCur === "eur") currency = savedCur;
} catch (e) {}

// Форматує суму в обраній валюті; якщо курс ще не відомий — показує долари
function fmtMoney(usd) {
  if (currency === "uah" && usdRate) {
    const uah = usd * usdRate;
    const d = uah >= 100 ? 0 : 2;
    return uah.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }) + " ₴";
  }
  if (currency === "eur" && usdRate && eurRate) {
    const eur = (usd * usdRate) / eurRate;
    const d = eur >= 100 ? 0 : 2;
    return eur.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }) + " €";
  }
  return fmtOnlyUsd(usd);
}

// Та сама сума в «іншій» валюті (для рядка «≈ ...» під ціною)
function fmtOther(usd) {
  if (currency !== "usd") return "≈ " + fmtOnlyUsd(usd);
  return usdRate ? "≈ " + Math.round(usd * usdRate).toLocaleString("uk-UA") + " ₴" : "";
}

// Монети: id для CoinGecko, пара для Binance і назва на сайті
const coins = {
  bitcoin: { name: "Біткоїн (BTC)", pair: "btcusdt", color: "#c9a24d" },
  ethereum: { name: "Ефіріум (ETH)", pair: "ethusdt", color: "#8089b8" },
  solana: { name: "Solana (SOL)", pair: "solusdt", color: "#5fa8a0" },
  ripple: { name: "XRP", pair: "xrpusdt", color: "#6f93b3" },
  tether: { name: "Tether (USDT)", pair: null, color: "#6aa58b" }, // стейблкоїн, майже завжди 1 $
};

// Поточні ціни: { bitcoin: { usd, change, liveAt }, ... }
// Для USDT стартове значення 1 $: якщо CoinGecko не відповість, сайт покаже його
const state = { tether: { usd: 1, change: 0, liveAt: 0 } };

// Із пар Binance (btcusdt) назад у id монет (bitcoin)
const pairToId = {};
Object.keys(coins).forEach(function (id) {
  if (coins[id].pair) pairToId[coins[id].pair] = id;
});

// 1) Початкові дані та запасний варіант: CoinGecko (раз на хвилину)
async function loadCrypto() {
  try {
    // Просимо в CoinGecko лише те, чого немає наживо з Binance (так запитів менше)
    const need = Object.keys(coins).filter(function (id) {
      return !(state[id] && Date.now() - state[id].liveAt < LIVE_MS);
    });
    if (!need.length) return;
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=" +
      need.join(",") + "&vs_currencies=usd&include_24hr_change=true";
    const data = await (await fetch(url)).json();
    need.forEach(function (id) {
      if (!data[id]) return;
      state[id] = { usd: data[id].usd, change: data[id].usd_24h_change || 0, liveAt: 0 };
    });
  } catch (e) {
    // нічого: спробуємо ще раз за хвилину
  }
}

// 2) Дані щосекунди: WebSocket Binance (сервер сам надсилає нові ціни)
let socket = null;
let reconnectDelay = 5000; // пауза перед повторним підключенням: 5 с, далі подвоюється до 60 с

function connectLive() {
  const streams = Object.keys(pairToId).map(function (p) { return p + "@miniTicker"; }).join("/");
  try {
    socket = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams);
  } catch (e) {
    return;
  }
  socket.onopen = function () { reconnectDelay = 5000; };
  socket.onmessage = function (event) {
    const d = JSON.parse(event.data).data;
    const id = pairToId[d.s.toLowerCase()];
    if (!id) return;
    const price = parseFloat(d.c);
    const open = parseFloat(d.o);
    state[id] = { usd: price, change: (price / open - 1) * 100, liveAt: Date.now() };
  };
  // Якщо зв'язок обірвався (або Binance недоступний у вашому регіоні) — пробуємо знову з дедалі більшою паузою
  socket.onclose = function () {
    setTimeout(connectLive, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  };
  socket.onerror = function () { socket.close(); };
}

// Відкриває біржовий графік монети (chart-tool.js): свічки наживо, масштаб, лінії, лінійка
function openCoinChart(id) {
  const c = coins[id];
  if (!c || !c.pair || typeof ChartTool === "undefined") return;
  ChartTool.open({ symbol: c.pair.replace("usdt", "").toUpperCase(), name: c.name });
}

// Робить елемент кнопкою «відкрити графік цієї монети» (картки цін і плитки теплової карти)
function makeCoinPicker(el, id, title) {
  el.classList.add("clickable");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("data-help", "Відкрити графік " + coins[id].name + " наживо: свічки з біржі Binance, масштаб, лінії, лінійка");
  el.setAttribute("aria-label", "Відкрити графік " + coins[id].name);
  function pick() {
    const tab = document.querySelector('.coin-tab[data-coin="' + id + '"]');
    if (tab) tab.click();                              // графіки на сторінці теж перемикаємо на цю монету
    openCoinChart(id);                                 // і відкриваємо біржовий графік у великому вікні
  }
  el.addEventListener("click", pick);
  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
  });
}

// Малюємо (або оновлюємо) картки цін. Викликається щосекунди.
function renderPrices() {
  const box = document.getElementById("cryptoPrices");
  if (!box) return;
  let any = false;

  Object.keys(coins).forEach(function (id) {
    const s = state[id];
    if (!s) return;
    any = true;

    // Створюємо картку один раз, далі лише міняємо цифри
    let el = box.querySelector('[data-id="' + id + '"]');
    if (!el) {
      if (box.querySelector(".loading")) box.innerHTML = "";
      el = document.createElement("div");
      el.className = "price";
      el.dataset.id = id;
      el.style.setProperty("--c", coins[id].color); // власний колір монети

      // Клік по картці обирає цю монету для графіків (для USDT графіка немає)
      if (coins[id].pair) makeCoinPicker(el, id, "Показати графіки цієї монети");
      el.innerHTML = '<div class="name">' + coins[id].name + '</div><div class="value"></div>' +
        '<div class="uah"></div><div class="change"></div>';
      el._nodes = { value: el.querySelector(".value"), uah: el.querySelector(".uah"), change: el.querySelector(".change") };
      box.appendChild(el);
    }

    // Якщо ціна змінилась — коротко підсвічуємо картку (зелений — вгору, червоний — вниз)
    const last = parseFloat(el.dataset.last);
    if (!isNaN(last) && last !== s.usd) {
      el.classList.remove("flash-up", "flash-down");
      void el.offsetWidth; // перезапуск анімації
      el.classList.add(s.usd > last ? "flash-up" : "flash-down");
    }
    el.dataset.last = s.usd;

    // Пишемо в DOM лише те, що справді змінилось (раніше все переписувалось щосекунди)
    const n = el._nodes, trend = s.change >= 0 ? "up" : "down";
    setText(n.value, fmtMoney(s.usd));
    setText(n.uah, fmtOther(s.usd));
    setText(n.change, (s.change >= 0 ? "▲ +" : "▼ ") + s.change.toFixed(2) + "% за 24 год");
    if (el.dataset.trend !== trend) {
      el.dataset.trend = trend;
      n.change.className = "change " + trend;
    }
  });

  const meta = document.getElementById("cryptoMeta");
  if (meta && any) {
    const live = state.bitcoin && Date.now() - state.bitcoin.liveAt < LIVE_MS;
    setText(meta, live ? "● Наживо, щосекунди (Binance)" : "Оновлення раз на хвилину (CoinGecko)");
  }
}

// ---------- Автоматичний огляд ринку ----------
// Береться з поточних цін; кожне правило — одне просте речення українською.
let lastAnalysis = "";

function renderAnalysis() {
  const box = document.getElementById("analysis");
  if (!box) return;

  // Стейблкоїн (USDT) в аналіз не беремо: його ціна майже не міняється
  const ids = Object.keys(coins).filter(function (id) { return id !== "tether" && state[id]; });
  if (ids.length < 2) return;

  const list = ids.map(function (id) {
    return { id: id, name: coins[id].name.replace(/ \(.*\)/, ""), ch: state[id].change };
  }).sort(function (a, b) { return b.ch - a.ch; });

  const up = list.filter(function (c) { return c.ch >= 0; }).length;
  const best = list[0];
  const worst = list[list.length - 1];
  const lines = [];

  // 1) Загальний настрій
  if (up === 0) lines.push("Усі " + list.length + " монети за добу подешевшали: ринок «червоний».");
  else if (up === list.length) lines.push("Усі " + list.length + " монети за добу подорожчали: ринок «зелений».");
  else lines.push("Ринок змішаний: " + up + " з " + list.length + " монет зросли за добу, решта впали.");

  // 2) Лідер і аутсайдер
  lines.push("Найкращий результат за 24 години: " + best.name + " (" + pct(best.ch) + "), найгірший: " + worst.name + " (" + pct(worst.ch) + ").");

  // 3) Різкі рухи
  const sharp = list.filter(function (c) { return Math.abs(c.ch) >= 5; });
  if (sharp.length) {
    lines.push("Різкі рухи (понад 5% за добу): " + sharp.map(function (c) { return c.name; }).join(", ") +
      ". Дрібніші монети зазвичай коливаються сильніше за біткоїн.");
  } else {
    lines.push("Різких рухів (понад 5% за добу) немає, ринок відносно спокійний.");
  }

  // 4) Тиждень для вибраної монети
  const week = weekData[histKey(selectedCoin)];
  if (week && week.length > 1) {
    const first = week[0], now = week[week.length - 1];
    const lo = Math.min.apply(null, week), hi = Math.max.apply(null, week);
    const wch = (now / first - 1) * 100;
    const posInRange = (now - lo) / (hi - lo || 1);
    const where = posInRange < 0.25 ? "ближче до мінімуму цього періоду" : posInRange > 0.75 ? "ближче до максимуму цього періоду" : "посередині діапазону цього періоду";
    lines.push(coins[selectedCoin].name.replace(/ \(.*\)/, "") + " за " + periodLabel() + ": " + pct(wch) + "; ціна зараз " + where +
      " (" + fmtMoney(lo) + " — " + fmtMoney(hi) + ").");
  }

  const text = lines.join("|");
  if (text === lastAnalysis) return; // не перемальовуємо, якщо нічого не змінилось
  lastAnalysis = text;
  document.getElementById("analysisList").innerHTML = lines.map(function (l) { return "<li>" + l + "</li>"; }).join("");
  box.hidden = false;
}

// Курси гривні: відкритий API Національного банку України
async function loadFiat() {
  const box = document.getElementById("fiatPrices");
  if (!box) return;
  const meta = document.getElementById("fiatMeta");
  try {
    const data = await (await fetch("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json")).json();
    const wanted = { USD: "Долар США", EUR: "Євро", GBP: "Фунт стерлінгів", PLN: "Злотий" };
    box.innerHTML = "";
    let date = "";
    data.forEach(function (c) {
      if (!wanted[c.cc]) return;
      date = c.exchangedate;
      if (c.cc === "USD") usdRate = c.rate;
      if (c.cc === "EUR") eurRate = c.rate;
      const el = document.createElement("div");
      el.className = "price";
      el.innerHTML =
        '<div class="name">' + wanted[c.cc] + " (" + c.cc + ")</div>" +
        '<div class="value">' + c.rate.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴</div>";
      box.appendChild(el);
    });
    meta.textContent = "Джерело: Національний банк України, офіційний курс на " + date + ". Оновлюється раз на добу.";
  } catch (e) {
    box.innerHTML = '<div class="price loading">Не вдалося завантажити курс НБУ.</div>';
    meta.textContent = "";
  }
}

// Індекс страху й жадібності (Alternative.me): число від 0 до 100
async function loadFng() {
  const box = document.getElementById("fng");
  if (!box) return;
  try {
    const data = await (await fetch("https://api.alternative.me/fng/?limit=1")).json();
    const item = data.data[0];
    const v = parseInt(item.value, 10);
    const names = {
      "Extreme Fear": "Надзвичайний страх", "Fear": "Страх", "Neutral": "Нейтрально",
      "Greed": "Жадібність", "Extreme Greed": "Надзвичайна жадібність",
    };
    const label = names[item.value_classification] || item.value_classification;
    box.innerHTML =
      '<span class="fng-value">' + v + " / 100</span> — <b>" + label + "</b>" +
      '<div class="gauge"><div class="gauge-marker" style="left:0%"></div></div>' +
      '<div class="gauge-scale"><span>Страх</span><span>Нейтрально</span><span>Жадібність</span></div>' +
      '<p class="small">Індекс показує, як відчуває себе ринок: низькі значення — інвестори бояться, високі — поспішають купувати. ' +
      "Джерело: Alternative.me, оновлюється раз на добу. Це не порада купувати чи продавати.</p>";
    // Маркер «їде» до потрібного місця після появи
    setTimeout(function () {
      const m = box.querySelector(".gauge-marker");
      if (m) m.style.left = v + "%";
    }, 100);
  } catch (e) {
    box.innerHTML = '<p class="muted">Не вдалося завантажити індекс.</p>';
  }
}
