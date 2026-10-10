// Сторінка «Ринок»: біржовий графік із вибором монети. «Жива стрічка подій» тепер на сторінці «Симуляція» (simulation-feed.js; той самий модуль LiveFeed).
// Потребує chart-tool.js. Графік окремий (ChartTool.mount), тож решта графіків сторінки працює як раніше.
(function () {
  const COINS = [["BTC", "Біткоїн"], ["ETH", "Ефіріум"], ["BNB", "BNB"], ["SOL", "Solana"], ["XRP", "XRP"], ["ADA", "Cardano"], ["DOGE", "Dogecoin"], ["LINK", "Chainlink"], ["AVAX", "Avalanche"], ["SUI", "Sui"]];
  const KEY = "mkTermCoin";
  const tabs = document.getElementById("mkCoins"), chartBox = document.getElementById("mkChart");
  if (!tabs || !chartBox || typeof ChartTool === "undefined") return;
  let selected = "BTC";
  try { const v = localStorage.getItem(KEY); if (v && COINS.some(function (c) { return c[0] === v; })) selected = v; } catch (e) { /* не критично */ }
  const nameOf = function (s) { return COINS.filter(function (c) { return c[0] === s; })[0]; };
  const chart = ChartTool.mount(chartBox, { symbol: selected, name: nameOf(selected)[1] });
  const btns = {};

  function pick(sym, reopen) {
    if (!nameOf(sym)) return;
    selected = sym;
    try { localStorage.setItem(KEY, sym); } catch (e) { /* не критично */ }
    Object.keys(btns).forEach(function (k) { btns[k].setAttribute("aria-selected", k === sym ? "true" : "false"); });
    if (reopen !== false) chart.open({ symbol: sym, name: nameOf(sym)[1] });
  }
  COINS.forEach(function (c) {
    const b = el("button", "mk-coin", c[0] + "/USDT"); b.type = "button"; b.setAttribute("role", "tab");
    b.addEventListener("click", function () { pick(c[0]); });
    tabs.appendChild(b); btns[c[0]] = b;
  });
  pick(selected, false);
})();
