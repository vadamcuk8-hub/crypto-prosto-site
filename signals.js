// Аналітика, розділ «Сигнали по монетах»: інформаційні вікна по найпопулярніших монетах + чесна перевірка сигналів на минулому.
// Дані готує агент «Сигнали» (tools/agents/agent_signals.py → data/signals.json). Це інформація, а не фінансова порада.
// Потребує agent-ui.js (el, ago, loadJson, isStale, REFRESH_MS) і charts.js. Усі тексти вставляються через textContent.

(function () {
  const grid = document.getElementById("sigGrid");
  if (!grid) return;
  const statusEl = document.getElementById("sigStatus");
  const insightsEl = document.getElementById("sigInsights");
  const noteEl = document.getElementById("sigNote");
  const selEl = document.getElementById("sigSelection");
  const btBox = document.getElementById("sigBacktest");
  const { fmtNum, lineChart } = Charts;
  const SIGN = { positive: ["▲", "Позитивно"], negative: ["▼", "Негативно"], neutral: ["●", "Нейтрально"] };
  let last = "";

  function usd(v) { return fmtNum(v, v >= 100 ? 2 : v >= 1 ? 4 : 5) + " $"; }
  function sgn(v) { return (v > 0 ? "+" : "") + fmtNum(v, 1) + "%"; }
  function tone(v) { return v > 0 ? "tone-positive" : v < 0 ? "tone-negative" : ""; }

  function reasonList(items) {
    const ul = el("ul", "insights");
    items.forEach(function (x) {
      const li = el("li", "insight " + x.tone);
      const m = SIGN[x.tone] || SIGN.neutral;
      li.appendChild(el("span", "insight-mark", m[0]));
      li.appendChild(el("span", "sr-only", m[1] + ": "));
      li.appendChild(document.createTextNode(x.text));
      ul.appendChild(li);
    });
    return ul;
  }

  function fact(dl, k, v) {
    dl.appendChild(el("dt", "", k));
    dl.appendChild(el("dd", "", v));
  }

  function btSentence(c, s) {
    const b = c.backtest, h = s.horizon_days;
    if (!b.buyers.n && !b.sellers.n) return "Для цієї монети замало історії, щоб перевірити сигнали.";
    function part(k, name) {
      return b[k].n ? "після «" + name + "» (" + b[k].n + " днів) ціна через " + h + " днів була вищою у " + b[k].up_pct + "%" : null;
    }
    const parts = [part("buyers", s.labels.buyers), part("sellers", s.labels.sellers)].filter(Boolean);
    return "За останній рік для " + c.symbol + ": " + parts.join("; ") + ". У середньому за всі дні — у " + b.all.up_pct + "%.";
  }

  function card(c, s) {
    const d = el("article", "sig-card " + c.signal);
    const head = el("div", "sig-head");
    const name = el("div");
    name.appendChild(el("h3", "sig-sym", c.symbol));
    name.appendChild(el("span", "small", c.name));
    head.appendChild(name);
    const px = el("div", "sig-price");
    const priceEl = el("b", "", usd(c.price));
    const timeEl = el("span", "small", c.source + ", денна свічка (оновлено " + ago(s.generated_at) + ")");
    px.appendChild(priceEl);
    px.appendChild(el("span", "small " + tone(c.change24h), sgn(c.change24h) + " за добу"));
    px.appendChild(timeEl);
    head.appendChild(px);
    live[c.symbol] = { priceEl: priceEl, timeEl: timeEl, card: d, msg: null };
    d.appendChild(head);

    const meta = el("div", "sig-meta");
    if (c.interest) {
      meta.appendChild(el("span", "chip", "Інтерес ×" + fmtNum(c.interest.surge, 1)));
      meta.appendChild(el("span", "small", "обсяг торгів за добу проти звичного за 7 днів, " + (s.exchange ? s.exchange.name : "біржа")));
    }
    if (c.auto) meta.appendChild(el("span", "chip", "додано автоматично" + (c.in_list_since ? " " + c.in_list_since : "")));
    d.appendChild(meta);

    const lab = el("div", "sig-labelrow");
    lab.appendChild(el("span", "sig-label " + (c.tilt ? "tilt" : c.signal), c.tilt ? s.labels["tilt_" + c.tilt] : s.labels[c.signal]));
    lab.appendChild(el("span", "small", "оцінка " + (c.score > 0 ? "+" : "") + c.score + " із ±100"));
    d.appendChild(lab);
    d.appendChild(Charts.signalGauge(c.score, c.signal));
    const cap = el("div", "gauge-scale");
    ["Продавці", "Рівновага", "Покупці"].forEach(function (t) { cap.appendChild(el("span", "", t)); });
    d.appendChild(cap);

    d.appendChild(lineChart(c.spark, { color: c.change30d >= 0 ? "var(--up)" : "var(--down)", label: c.symbol + ": ціна за 90 днів", h: 70, w: 320, dots: true }));
    d.appendChild(el("p", "small", "Ціна за останні 90 днів"));
    d.appendChild(el("p", "sig-tldr", c.tldr));

    const more = el("details", "sig-more");
    more.appendChild(el("summary", "", "Докладніше"));
    more.appendChild(reasonList(c.reasons));
    const dl = el("dl", "agent-facts");
    fact(dl, "Зміна за 7 / 30 днів", sgn(c.change7d) + " / " + sgn(c.change30d));
    fact(dl, "RSI (0–100)", fmtNum(c.rsi, 0));
    fact(dl, "Середні за 50 / 200 днів", usd(c.sma50) + " / " + usd(c.sma200));
    fact(dl, "Діапазон за 7 днів", usd(c.range7[0]) + " – " + usd(c.range7[1]));
    fact(dl, "Діапазон за 30 днів", usd(c.range30[0]) + " – " + usd(c.range30[1]));
    more.appendChild(dl);
    more.appendChild(el("p", "small", "Діапазон — це статистика поточної мінливості: приблизно у 2 випадках із 3 ціна лишалася б усередині. Це не прогноз і не гарантія."));
    more.appendChild(el("p", "small", btSentence(c, s)));
    more.appendChild(el("p", "small", "Джерело цін і обсягів: " + c.source + (c.interest ? "; торги до USDT, обсяг за добу " + fmtNum(c.interest.volume_usd / 1e6, 0) + " млн $" : "") + "."));
    if (!c.pinned) more.appendChild(el("p", "small", "Монету додано автоматично через зростання обсягу торгів. Це не означає, що вона надійна: невеликі монети значно ризикованіші за BTC та ETH."));
    d.appendChild(more);
    return d;
  }

  function backtestTable(s) {
    const t = el("table", "agent-table");
    const head = el("tr");
    ["Сигнал", "Днів у перевірці", "Ціна через " + s.horizon_days + " днів була вищою", "Середня зміна"].forEach(function (h) { head.appendChild(el("th", "", h)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    [["buyers", s.labels.buyers], ["balance", s.labels.balance], ["sellers", s.labels.sellers], ["all", "Усі дні разом"]].forEach(function (x) {
      const r = s.backtest[x[0]], tr = el("tr");
      tr.appendChild(el("td", "", x[1]));
      tr.appendChild(el("td", "", fmtNum(r.n, 0)));
      tr.appendChild(el("td", "", r.up_pct === null ? "—" : r.up_pct + "% випадків"));
      tr.appendChild(el("td", "", r.avg === undefined || r.avg === null ? "—" : sgn(r.avg)));
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }

  // ---------- Жива ціна з біржі Binance (WebSocket) ----------
  // Ціна на картці береться прямо з біржі й оновлюється щосекунди; поруч показано час біржі (з повідомлення Binance).
  // Індикатори й сигнал агент рахує за денними свічками раз на годину: вони не змінюються щосекунди.
  const live = {};            // символ → { px, t (мс біржі), el, timeEl, base }
  let socket = null, delay = 5000, lastSymbols = "", closed = false;

  function paint(sym) {
    const x = live[sym];
    if (!x || !x.priceEl || !x.msg) return;
    x.priceEl.textContent = usd(x.msg.px);
    const t = new Date(x.msg.t);
    x.timeEl.textContent = "Binance, " + t.toLocaleTimeString("uk-UA") + " (час біржі)";
    x.card.classList.add("is-live");
  }

  function connect(symbols) {
    closed = true;
    if (socket) { try { socket.close(); } catch (e) { /* уже закрито */ } }
    closed = false;
    if (!symbols.length) return;
    const streams = symbols.map(function (s) { return s.toLowerCase() + "usdt@miniTicker"; }).join("/");
    try { socket = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); } catch (e) { return; }
    socket.onopen = function () { delay = 5000; };
    socket.onmessage = function (ev) {
      try {
        const d = JSON.parse(ev.data).data;
        const sym = d.s.replace(/USDT$/, "");
        if (live[sym]) { live[sym].msg = { px: parseFloat(d.c), t: d.E }; }
      } catch (e) { /* пропускаємо пошкоджене повідомлення */ }
    };
    socket.onclose = function () {
      if (closed) return;
      setTimeout(function () { connect(Object.keys(live)); }, delay);
      delay = Math.min(delay * 2, 60000);
    };
  }

  setInterval(function () {                       // малюємо раз на секунду, навіть якщо повідомлень приходить більше
    if (document.hidden) return;
    Object.keys(live).forEach(paint);
  }, 1000);

  async function refresh() {
    try {
      const s = await loadJson("data/signals.json");
      const stale = isStale({ interval: 3600 }, s.generated_at);
      statusEl.textContent = "● Сигнали оновлено " + ago(s.generated_at) + (stale ? ". Дані застаріли." : ". Сторінка оновлюється сама.");
      statusEl.className = "feed-status " + (stale ? "off" : "live");
      if (s.generated_at === last) return;
      last = s.generated_at;
      insightsEl.replaceChildren(reasonList(s.insights));
      selEl.replaceChildren();
      const sel = s.selection || {};
      selEl.appendChild(el("h3", "agent-sub", "Як добираються монети"));
      selEl.appendChild(el("p", "small", sel.note || ""));
      const src = el("p", "small", (s.exchange ? s.exchange.note + " " : "") + "Сайт біржі: ");
      if (s.exchange) { const a = el("a", "", s.exchange.name); a.href = s.exchange.url; a.target = "_blank"; a.rel = "noopener noreferrer"; src.appendChild(a); }
      selEl.appendChild(src);
      if (sel.error) selEl.appendChild(el("p", "note", "Біржа тимчасово недоступна, тому список монет не оновлювався: " + sel.error));
      if ((sel.changes || []).length) {
        selEl.appendChild(el("h4", "wsub", "Останні заміни"));
        const ul = el("ul", "wlinks");
        sel.changes.slice().reverse().forEach(function (x) { ul.appendChild(el("li", "", x.date + ": " + x.text)); });
        selEl.appendChild(ul);
      }
      if ((sel.top_interest || []).length) {
        selEl.appendChild(el("p", "small", "Найбільший інтерес зараз: " + sel.top_interest.slice(0, 5).map(function (x) { return x.symbol + " ×" + fmtNum(x.surge, 1); }).join(", ") + "."));
      }
      noteEl.textContent = s.disclaimer;
      grid.replaceChildren();
      Object.keys(live).forEach(function (k) { delete live[k]; });
      s.coins.forEach(function (c) { grid.appendChild(card(c, s)); });
      const symbols = s.coins.filter(function (c) { return c.source === "Binance"; }).map(function (c) { return c.symbol; });
      if (symbols.join() !== lastSymbols) { lastSymbols = symbols.join(); connect(symbols); }   // список монет змінився: нова підписка
      btBox.replaceChildren(backtestTable(s));
    } catch (e) {
      statusEl.textContent = "Сигнали не завантажено";
      statusEl.className = "feed-status off";
      grid.replaceChildren(el("p", "note", HELP));
    }
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
