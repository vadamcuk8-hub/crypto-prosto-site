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

  function fact(dl, k, v, help) {
    const dt = el("dt", "", k);
    if (help) { dt.setAttribute("data-help", help); dt.tabIndex = 0; }
    dl.appendChild(dt);
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
    function tag(text, help) { const t = el("span", "chip", text); t.tabIndex = 0; t.setAttribute("data-help", help); return t; }
    if (c.interest) meta.appendChild(tag("Інтерес ×" + fmtNum(c.interest.surge, 1), "Обсяг торгів за добу проти звичного за 7 днів на біржі " + (s.exchange ? s.exchange.name : "") + ". ×1 — як зазвичай, більше — інтерес зростає"));
    if (c.auto) meta.appendChild(tag("додано автоматично" + (c.in_list_since ? " " + c.in_list_since : ""), "Монету додано автоматично через зростання обсягу торгів. Це не означає, що вона надійна: невеликі монети значно ризикованіші за BTC та ETH"));
    d.appendChild(meta);

    const lab = el("div", "sig-labelrow");
    lab.appendChild(el("span", "sig-label " + (c.tilt ? "tilt" : c.signal), c.tilt ? s.labels["tilt_" + c.tilt] : s.labels[c.signal]));
    lab.appendChild(el("span", "small", "оцінка " + (c.score > 0 ? "+" : "") + c.score + " із ±100"));
    d.appendChild(lab);
    d.appendChild(Charts.signalGauge(c.score, c.signal));
    const cap = el("div", "gauge-scale");
    ["Продавці", "Рівновага", "Покупці"].forEach(function (t) { cap.appendChild(el("span", "", t)); });
    d.appendChild(cap);

    const spark = el("div", "chart-open");
    spark.appendChild(lineChart(c.spark, { color: c.change30d >= 0 ? "var(--up)" : "var(--down)", label: c.symbol + ": ціна за 90 днів", h: 70, w: 320, dots: true }));
    d.appendChild(ChartTool.bind(spark, function () { return { symbol: c.symbol, name: c.name }; }, "Відкрити графік " + c.symbol + " наживо"));
    const open = el("button", "sig-open", "Відкрити графік наживо");
    open.type = "button";
    open.setAttribute("aria-label", "Відкрити графік " + c.symbol + " наживо");
    open.setAttribute("data-help", "Відкрити біржовий графік " + c.symbol + ": свічки наживо, масштаб, лінії, лінійка");
    open.addEventListener("click", function () { ChartTool.open({ symbol: c.symbol, name: c.name }); });
    d.appendChild(open);
    d.appendChild(el("p", "sig-tldr", c.tldr));

    const more = el("details", "sig-more");
    more.appendChild(el("summary", "", "Докладніше"));
    more.appendChild(reasonList(c.reasons));
    const dl = el("dl", "agent-facts");
    fact(dl, "Зміна за 7 / 30 днів", sgn(c.change7d) + " / " + sgn(c.change30d));
    fact(dl, "RSI (0–100)", fmtNum(c.rsi, 0));
    fact(dl, "Середні за 50 / 200 днів", usd(c.sma50) + " / " + usd(c.sma200));
    const rangeHelp = "Статистика поточної мінливості: приблизно у 2 випадках із 3 ціна лишалася б усередині діапазону. Це не прогноз і не гарантія";
    fact(dl, "Діапазон за 7 днів", usd(c.range7[0]) + " – " + usd(c.range7[1]), rangeHelp);
    fact(dl, "Діапазон за 30 днів", usd(c.range30[0]) + " – " + usd(c.range30[1]), rangeHelp);
    more.appendChild(dl);
    more.appendChild(el("p", "small", btSentence(c, s)));
    more.appendChild(el("p", "small", "Джерело цін і обсягів: " + c.source + (c.interest ? "; торги до USDT, обсяг за добу " + fmtNum(c.interest.volume_usd / 1e6, 0) + " млн $" : "") + "."));
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


  // ---------- Огляд сигналів: наочні плитки замість списку речень ----------
  function tile(title, help) {
    const t = el("div", "ov-tile");
    const h = el("h3", "ov-title", title);
    if (help) h.appendChild(Help.icon(help));
    t.appendChild(h);
    return t;
  }

  function coinChip(c, sign) {
    const b = el("button", "ov-coin " + (c.score >= 0 ? "pos" : "neg"), sign + " " + c.symbol + " " + (c.score > 0 ? "+" : "") + c.score);
    b.type = "button";
    b.setAttribute("data-help", "Відкрити біржовий графік " + c.symbol);
    b.addEventListener("click", function () { ChartTool.open({ symbol: c.symbol, name: c.name }); });
    return b;
  }

  function overview(s) {
    const grid = el("div", "ov-grid"), coins = s.coins, n = coins.length;

    // 1. Баланс ринку: смуга покупці / нахил / рівновага / продавці
    const t1 = tile("Баланс ринку", "Скільки монет мають перевагу покупців чи продавців за індикаторами. Світліші відтінки — рівновага з нахилом. Кількість монет написано всередині смуг.");
    const parts = [
      ["sellers", "Продавці", coins.filter(function (c) { return c.signal === "sellers"; }).length],
      ["ts", "Нахил до продавців", coins.filter(function (c) { return c.tilt === "sellers"; }).length],
      ["bal", "Рівновага", coins.filter(function (c) { return c.signal === "balance" && !c.tilt; }).length],
      ["tb", "Нахил до покупців", coins.filter(function (c) { return c.tilt === "buyers"; }).length],
      ["buyers", "Покупці", coins.filter(function (c) { return c.signal === "buyers"; }).length],
    ];
    const seg = el("div", "ov-seg");
    seg.setAttribute("role", "img");
    seg.setAttribute("aria-label", parts.map(function (x) { return x[1] + ": " + x[2]; }).join(", "));
    parts.forEach(function (x) {
      if (!x[2]) return;
      const sp = el("span", "ov-s " + x[0], String(x[2]));
      sp.style.flexGrow = String(x[2]);
      sp.setAttribute("data-help", x[1] + ": " + x[2] + " з " + n + " монет");
      sp.tabIndex = 0;
      seg.appendChild(sp);
    });
    t1.appendChild(seg);
    const lg = el("div", "ov-legend");
    lg.appendChild(el("span", "", "▼ продавці"));
    lg.appendChild(el("span", "", "покупці ▲"));
    t1.appendChild(lg);
    grid.appendChild(t1);

    // 2. Найсильніший і найслабший сигнал
    const best = coins.reduce(function (a, c) { return c.score > a.score ? c : a; }, coins[0]);
    const worst = coins.reduce(function (a, c) { return c.score < a.score ? c : a; }, coins[0]);
    const t2 = tile("Лідер і аутсайдер", "Найвища й найнижча оцінка сигналу серед монет (від −100 до +100). Натисніть, щоб відкрити графік.");
    const row2 = el("div", "ov-coins");
    row2.appendChild(coinChip(best, "▲"));
    row2.appendChild(coinChip(worst, "▼"));
    t2.appendChild(row2);
    grid.appendChild(t2);

    // 3. Чи справджувались сигнали: стовпчики з лінією «випадково»
    const b = s.backtest, pa = b.all.up_pct, pb = b.buyers.up_pct, ps = b.sellers.up_pct;
    const t3 = tile("Чи справджуються сигнали", "Для кожного дня за рік перевірено, як часто ціна через " + s.horizon_days +
      " днів була вищою. Червона лінія — результат «навмання» (усі дні разом). Якщо стовпчики біля лінії, сигнал не краще за випадковість.");
    if (pa !== null && pb !== null && ps !== null) {
      const same = Math.abs(pb - pa) < 5 && Math.abs(ps - pa) < 5, good = pb > pa && ps < pa;
      const bars = el("div", "ov-bars");
      [["Покупці", pb, "var(--up)"], ["Продавці", ps, "var(--down)"], ["Усі дні", pa, "var(--accent)"]].forEach(function (x) {
        const r = el("div", "ov-bar");
        r.appendChild(el("span", "ov-bl", x[0]));
        const tr = el("span", "ov-bt");
        const f = el("span", "ov-bf"); f.style.width = x[1] + "%"; f.style.background = x[2];
        tr.appendChild(f);
        const base = el("span", "ov-base"); base.style.left = pa + "%";
        tr.appendChild(base);
        r.appendChild(tr);
        r.appendChild(el("span", "ov-bv", x[1] + "%"));
        r.setAttribute("data-help", x[0] + ": ціна через " + s.horizon_days + " днів була вищою у " + x[1] + "% випадків");
        r.tabIndex = 0;
        bars.appendChild(r);
      });
      t3.appendChild(bars);
      t3.appendChild(el("span", "ov-verdict " + (same ? "same" : good ? "good" : "mixed"), same ? "майже як випадково" : good ? "працюють краще за випадок" : "працюють нерівно"));
    } else {
      t3.appendChild(el("span", "ov-verdict same", "замало даних"));
    }
    grid.appendChild(t3);

    // 4. Діапазон за 30 днів для найсильнішої монети
    const t4 = tile("Діапазон 30 днів: " + best.symbol, "Статистика поточної мінливості: приблизно у 2 випадках із 3 ціна за 30 днів лишалася б усередині діапазону. Це не прогноз і не гарантія.");
    const lo = best.range30[0], hi = best.range30[1], pos = Math.max(0, Math.min(100, (best.price - lo) / (hi - lo) * 100));
    const rg = el("div", "ov-range");
    rg.setAttribute("role", "img");
    rg.setAttribute("aria-label", best.symbol + ": від " + usd(lo) + " до " + usd(hi) + ", зараз " + usd(best.price));
    const mk = el("span", "ov-mark"); mk.style.left = pos + "%";
    rg.appendChild(mk);
    t4.appendChild(rg);
    const rl = el("div", "ov-legend");
    rl.appendChild(el("span", "", usd(lo)));
    rl.appendChild(el("span", "", usd(hi)));
    t4.appendChild(rl);
    grid.appendChild(t4);

    return grid;
  }


  // ---------- Рейтинг монет: таблиця з сортуванням ----------
  const rankBox = document.getElementById("sigRank");
  let rankSort = { k: "score", dir: -1 };
  let rankData = null;

  function baseRate(c) {
    const b = c.backtest[c.signal];
    return b && b.n >= 20 ? { p: b.up_pct, n: b.n } : { p: null, n: b ? b.n : 0 };
  }

  const RANK_COLS = [
    { k: "symbol", t: "Монета", v: function (c) { return c.symbol; }, help: "Монета. Натисніть, щоб відкрити біржовий графік" },
    { k: "score", t: "Сигнал", v: function (c) { return c.score; }, help: "Оцінка індикаторів від −100 (продавці) до +100 (покупці)" },
    { k: "c7", t: "7 днів", v: function (c) { return c.change7d; }, help: "Зміна ціни за 7 днів" },
    { k: "c30", t: "30 днів", v: function (c) { return c.change30d; }, help: "Зміна ціни за 30 днів" },
    { k: "rsi", t: "RSI", v: function (c) { return c.rsi; }, help: "RSI від 0 до 100: вище 70 — «перегрів», нижче 30 — «розпродаж»" },
    { k: "int", t: "Інтерес", v: function (c) { return c.interest ? c.interest.surge : 0; }, help: "Обсяг торгів за добу проти звичного за 7 днів (×1 — як зазвичай)" },
    { k: "hist", t: "Історично", v: function (c) { const b = baseRate(c); return b.p === null ? -1 : b.p; }, help: "Як часто після такого самого сигналу ціна через 7 днів була вищою за останній рік. Біля 50 % — «як навмання»" },
    { k: "rng", t: "Діапазон 7 днів", v: function (c) { return (c.range7[1] - c.range7[0]) / c.price; }, help: "Де ціна лишалася б за тиждень приблизно у 2 випадках із 3 (статистика мінливості, не прогноз). Сортування — за шириною" },
  ];

  function renderRank(s) {
    if (!rankBox) return;
    if (s) rankData = s;
    if (!rankData) return;
    const coins = rankData.coins.slice();
    const byScore = coins.slice().sort(function (a, b) { return b.score - a.score; });
    const top = byScore.slice(0, 3).map(function (c) { return c.symbol; }), bottom = byScore.slice(-3).map(function (c) { return c.symbol; });
    const col = RANK_COLS.filter(function (c) { return c.k === rankSort.k; })[0];
    coins.sort(function (a, b) {
      const x = col.v(a), y = col.v(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * rankSort.dir;
    });

    const t = el("table", "agent-table rank-table");
    const head = el("tr");
    RANK_COLS.forEach(function (c) {
      const th = el("th");
      th.setAttribute("aria-sort", rankSort.k === c.k ? (rankSort.dir < 0 ? "descending" : "ascending") : "none");
      const b = el("button", "rank-sort", c.t + (rankSort.k === c.k ? (rankSort.dir < 0 ? " ▼" : " ▲") : ""));
      b.type = "button";
      b.setAttribute("data-help", c.help);
      b.addEventListener("click", function () {
        rankSort = { k: c.k, dir: rankSort.k === c.k ? -rankSort.dir : (c.k === "symbol" ? 1 : -1) };
        renderRank();
      });
      th.appendChild(b);
      head.appendChild(th);
    });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    coins.forEach(function (c) {
      const tr = el("tr", top.indexOf(c.symbol) >= 0 ? "rank-strong" : bottom.indexOf(c.symbol) >= 0 ? "rank-weak" : "");
      const name = el("td");
      const nb = el("button", "link-btn", c.symbol);
      nb.type = "button";
      nb.setAttribute("data-help", "Відкрити біржовий графік " + c.name);
      nb.addEventListener("click", function () { ChartTool.open({ symbol: c.symbol, name: c.name }); });
      name.appendChild(nb);
      if (top.indexOf(c.symbol) >= 0) name.appendChild(el("span", "rank-tag up", "сильніший"));
      if (bottom.indexOf(c.symbol) >= 0) name.appendChild(el("span", "rank-tag down", "слабший"));
      tr.appendChild(name);

      const sig = el("td");
      sig.appendChild(el("b", c.score >= 0 ? "tone-positive" : "tone-negative", (c.score > 0 ? "+" : "") + c.score));
      sig.appendChild(document.createTextNode(" "));
      sig.appendChild(el("span", "small", c.tilt ? rankData.labels["tilt_" + c.tilt] : rankData.labels[c.signal]));
      tr.appendChild(sig);
      tr.appendChild(el("td", tone(c.change7d), sgn(c.change7d)));
      tr.appendChild(el("td", tone(c.change30d), sgn(c.change30d)));
      const rsi = el("td", c.rsi >= 70 ? "tone-negative" : c.rsi <= 30 ? "tone-positive" : "", fmtNum(c.rsi, 0));
      if (c.rsi >= 70 || c.rsi <= 30) rsi.setAttribute("data-help", c.rsi >= 70 ? "Перегрів: монету багато купували" : "Розпродаж: монету багато продавали");
      tr.appendChild(rsi);
      tr.appendChild(el("td", "", c.interest ? "×" + fmtNum(c.interest.surge, 1) : "—"));
      const b = baseRate(c), h = el("td", "", b.p === null ? "мало даних" : b.p + "% (" + b.n + " дн.)");
      if (b.p !== null) h.setAttribute("data-help", "Після такого самого сигналу ціна через " + rankData.horizon_days + " днів була вищою у " + b.p + "% із " + b.n + " днів за рік");
      tr.appendChild(h);
      tr.appendChild(el("td", "small", usd(c.range7[0]) + " – " + usd(c.range7[1])));
      body.appendChild(tr);
    });
    t.appendChild(body);
    rankBox.replaceChildren(t);
  }

  async function refresh() {
    try {
      const s = await loadJson("data/signals.json");
      const stale = isStale({ interval: 3600 }, s.generated_at);
      statusEl.textContent = "● Сигнали оновлено " + ago(s.generated_at) + (stale ? ". Дані застаріли." : ". Сторінка оновлюється сама.");
      statusEl.className = "feed-status " + (stale ? "off" : "live");
      if (s.generated_at === last) return;
      last = s.generated_at;
      insightsEl.replaceChildren(overview(s));
      selEl.replaceChildren();
      const sel = s.selection || {};
      const sh = el("h3", "agent-sub", "Як добираються монети");
      if (sel.note) sh.appendChild(Help.icon(sel.note));
      selEl.appendChild(sh);
      const lastChange = (sel.changes || []).slice(-1)[0];
      selEl.appendChild(el("span", "ov-verdict " + (lastChange ? "mixed" : "same"),
        lastChange ? "Остання заміна: " + (lastChange.out ? lastChange.out + " → " + lastChange["in"] : "+ " + lastChange["in"]) + " · " + lastChange.date : "Список без змін"));
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
      noteEl.textContent = "Це інформація, а не фінансова порада й не прогноз.";
      noteEl.appendChild(Help.icon(s.disclaimer));
      grid.replaceChildren();
      Object.keys(live).forEach(function (k) { delete live[k]; });
      s.coins.forEach(function (c) { grid.appendChild(card(c, s)); });
      const symbols = s.coins.filter(function (c) { return c.source === "Binance"; }).map(function (c) { return c.symbol; });
      if (symbols.join() !== lastSymbols) { lastSymbols = symbols.join(); connect(symbols); }   // список монет змінився: нова підписка
      btBox.replaceChildren(backtestTable(s));
      renderRank(s);
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
