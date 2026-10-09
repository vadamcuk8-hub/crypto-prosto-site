// Головна: біржовий графік (як на Binance) із тікером монет, курси валют НБУ та діаграми віджетів без тексту.
// Потребує agent-ui.js, charts.js, chart-tool.js, widget-defs.js, widgets.js, help.js.

(function () {
  const COINS = [["BTC", "Біткоїн"], ["ETH", "Ефіріум"], ["BNB", "BNB"], ["SOL", "Solana"], ["XRP", "XRP"], ["DOGE", "Dogecoin"], ["ADA", "Cardano"], ["LINK", "Chainlink"]];
  const STORE = "homeCoin";

  // ---------- Біржовий графік і тікер ----------
  const ticker = document.getElementById("homeTicker");
  const chartBox = document.getElementById("homeChart");
  const ticks = {};
  let chart = null, selected = "BTC";
  try { const v = localStorage.getItem(STORE); if (v && COINS.some(function (c) { return c[0] === v; })) selected = v; } catch (e) { /* не критично */ }

  function fmt(v) { return v.toLocaleString("uk-UA", { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 6 }); }

  function pick(sym) {
    selected = sym;
    try { localStorage.setItem(STORE, sym); } catch (e) { /* не критично */ }
    Object.keys(ticks).forEach(function (k) { ticks[k].btn.setAttribute("aria-selected", k === sym ? "true" : "false"); });
    const c = COINS.filter(function (x) { return x[0] === sym; })[0];
    if (chart) chart.open({ symbol: sym, name: c[1] });
  }

  if (ticker && chartBox) {
    COINS.forEach(function (c) {
      const b = el("button", "bn-tick");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-help", "Показати біржовий графік " + c[1] + " (" + c[0] + "/USDT) нижче");
      const sym = el("span", "bn-sym", c[0] + "/USDT"), px = el("span", "bn-px", "…"), ch = el("span", "bn-ch", "");
      b.appendChild(sym); b.appendChild(px); b.appendChild(ch);
      b.addEventListener("click", function () { pick(c[0]); });
      ticker.appendChild(b);
      ticks[c[0]] = { btn: b, px: px, ch: ch };
    });
    chart = ChartTool.embed(chartBox, { symbol: selected, name: COINS.filter(function (x) { return x[0] === selected; })[0][1] });
    pick(selected);

    // Ціни тікера: WebSocket Binance, оновлення щосекунди; зміна рахується від ціни відкриття за 24 години
    let socket = null, delay = 5000;
    const last = {};
    // Початкові ціни одним запитом, щоб тікер не чекав на перше повідомлення WebSocket
    (async function () {
      try {
        const q = encodeURIComponent(JSON.stringify(COINS.map(function (c) { return c[0] + "USDT"; })));
        const r = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI&symbols=" + q);
        if (!r.ok) return;
        (await r.json()).forEach(function (t) {
          const sym = t.symbol.replace(/USDT$/, "");
          if (ticks[sym] && !last[sym]) last[sym] = { c: parseFloat(t.lastPrice), o: parseFloat(t.openPrice) };
        });
      } catch (e) { /* дочекаємось WebSocket */ }
    })();
    function connect() {
      const streams = COINS.map(function (c) { return c[0].toLowerCase() + "usdt@miniTicker"; }).join("/");
      try { socket = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); } catch (e) { return; }
      socket.onopen = function () { delay = 5000; };
      socket.onmessage = function (ev) {
        try {
          const d = JSON.parse(ev.data).data, sym = d.s.replace(/USDT$/, "");
          if (ticks[sym]) last[sym] = { c: parseFloat(d.c), o: parseFloat(d.o) };
        } catch (e) { /* пошкоджене повідомлення */ }
      };
      socket.onclose = function () { setTimeout(connect, delay); delay = Math.min(delay * 2, 60000); };
    }
    connect();
    setInterval(function () {
      if (document.hidden) return;
      Object.keys(last).forEach(function (sym) {
        const l = last[sym], t = ticks[sym], chg = 100 * (l.c / l.o - 1);
        setText(t.px, fmt(l.c));
        setText(t.ch, (chg >= 0 ? "+" : "") + chg.toFixed(2).replace(".", ",") + "%");
        t.ch.className = "bn-ch " + (chg >= 0 ? "up" : "down");
      });
    }, 1000);
  }

  // ---------- Курс валют (НБУ) ----------
  const ratesBox = document.getElementById("homeRates");
  const CUR = [["USD", "Долар"], ["EUR", "Євро"], ["PLN", "Злотий"], ["GBP", "Фунт"], ["CHF", "Франк"]];
  async function loadRates() {
    if (!ratesBox) return;
    try {
      const r = await fetch("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const rows = await r.json(), by = {};
      rows.forEach(function (x) { by[x.cc] = x; });
      ratesBox.replaceChildren();
      CUR.forEach(function (c) {
        const x = by[c[0]];
        if (!x) return;
        const d = el("div", "rate");
        d.tabIndex = 0;
        d.setAttribute("data-help", c[1] + ": скільки гривень коштує 1 " + c[0] + " за офіційним курсом НБУ на " + x.exchangedate);
        d.appendChild(el("span", "rate-code", c[0] + " → UAH"));
        d.appendChild(el("span", "rate-val", x.rate.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴"));
        ratesBox.appendChild(d);
      });
    } catch (e) { ratesBox.hidden = !ratesBox.children.length; }
  }
  loadRates();
  setInterval(loadRates, 30 * 60 * 1000);

  // ---------- Діаграми віджетів ----------
  const box = document.getElementById("dashboard");
  if (!box) return;
  const panel = Widgets.mount(box, WIDGET_DEFS.filter(function (w) { return !w.skipHome; }), { compact: true });

  async function refreshAll() {
    let agents = null;
    try { agents = await loadJson("data/agents.json"); } catch (e) { /* статус необов'язковий */ }
    panel.refresh(agents);
  }

  refreshAll();
  setInterval(function () { if (!document.hidden) refreshAll(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshAll(); });
})();
