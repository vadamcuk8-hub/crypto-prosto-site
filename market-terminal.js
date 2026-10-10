// Сторінка «Ринок»: біржовий графік ліворуч і «Жива стрічка подій» праворуч.
// Потребує chart-tool.js, live-feed-core.js, live-feed.js. Графік окремий (ChartTool.mount), тож решта графіків сторінки працює як раніше.
(function () {
  const COINS = [["BTC", "Біткоїн"], ["ETH", "Ефіріум"], ["BNB", "BNB"], ["SOL", "Solana"], ["XRP", "XRP"], ["ADA", "Cardano"], ["DOGE", "Dogecoin"], ["LINK", "Chainlink"], ["AVAX", "Avalanche"], ["SUI", "Sui"]];
  const KEY = "mkTermCoin";
  const tabs = document.getElementById("mkCoins"), chartBox = document.getElementById("mkChart"), feedBox = document.getElementById("mkFeed"), root = document.getElementById("mkTerminal");
  if (!tabs || !chartBox || !feedBox || typeof ChartTool === "undefined" || typeof LiveFeed === "undefined") return;
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
  // клік по монеті в стрічці (подвійний клік або кнопка в подробицях) перемикає графік
  LiveFeed.mount(feedBox, { layoutRoot: root, onCoin: function (coin) { if (nameOf(coin)) { pick(coin); chartBox.scrollIntoView({ behavior: "smooth", block: "nearest" }); } } });
})();
