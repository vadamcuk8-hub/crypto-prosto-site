// Сторінка «Симуляція»: 7-денний паперовий рахунок на 100, 1000 і 10000 $ (оцінка щосекунди за живими цінами Binance)
// та симуляція «а якби торгувати в минулому» за реальною історією цін. Дані готує агент «Симуляція» (data/simulation.json).
// Це віртуальні гроші, а не порада й не прогноз. Потребує agent-ui.js (el, loadJson, ago, agentState, REFRESH_MS), help.js.
// Усі тексти вставляються через textContent.

(function () {
  const paperTiles = document.getElementById("paperTiles");
  if (!paperTiles) return;
  const NS = "http://www.w3.org/2000/svg";
  const PCOL = { eq: "var(--accent)", hold: "#c28a3a" };
  let sim = null, last = "", live = {}, socket = null, delay = 5000, boundSyms = "";
  let hist = null;
  const trail = {};                                        // живі точки між запусками агента: {id: [[ISO, eq, hold], ...]}

  function usd(v) { return v.toLocaleString("uk-UA", { maximumFractionDigits: v >= 1000 ? 0 : 2 }) + " $"; }
  function pc(v, d) { return (v > 0 ? "+" : "") + v.toLocaleString("uk-UA", { maximumFractionDigits: d === undefined ? 2 : d }) + "%"; }
  function cls(v) { return v > 0 ? "tone-positive" : v < 0 ? "tone-negative" : ""; }
  function sv(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }
  function fill(select, items, value) {
    select.replaceChildren();
    items.forEach(function (x) { const o = el("option", "", x[1]); o.value = x[0]; select.appendChild(o); });
    if (value !== undefined && items.some(function (x) { return x[0] === value; })) select.value = value;
  }

  // ---------- Графік двох кривих: правило проти «просто тримати» (у відсотках від старту) ----------
  function curves(box, readout, a, b, labels, marks, fmtX) {
    box.replaceChildren();
    const W = 760, H = 260, ML = 8, MR = 56, MT = 12, MB = 24, n = a.length;
    const all = a.concat(b).map(function (v) { return (v - 1) * 100; });
    let lo = Math.min.apply(null, all.concat([0])), hi = Math.max.apply(null, all.concat([0]));
    if (hi - lo < 0.2) { hi += 0.1; lo -= 0.1; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const X = function (i) { return ML + (n <= 1 ? 0 : i / (n - 1)) * (W - ML - MR); };
    const Y = function (v) { return MT + (hi - (v - 1) * 100) / (hi - lo) * (H - MT - MB); };
    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "sim-svg" });
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, y = MT + (hi - v) / (hi - lo) * (H - MT - MB);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: Math.abs(v) < (hi - lo) / 8 ? "sim-zero" : "sim-grid" }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "sim-axis" }, svg).textContent = pc(v, Math.abs(hi - lo) < 5 ? 2 : 0);
    }
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, k) {
      if (n < 2) return;
      sv("text", { x: X(i), y: H - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle", class: "sim-axis" }, svg).textContent = fmtX(i);
    });
    function line(arr, color, w) {
      const pts = arr.map(function (v, i) { return X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(" ");
      sv("polyline", { points: pts, class: "sim-line", style: "stroke:" + color + ";stroke-width:" + w }, svg);
    }
    line(b, PCOL.hold, 1.6);
    line(a, PCOL.eq, 2.4);
    (marks || []).forEach(function (m) {
      if (m[0] >= n) return;
      sv("circle", { cx: X(m[0]), cy: Y(a[m[0]]), r: 3.2, class: m[1] > 0 ? "sim-buy" : "sim-sell" }, svg);
    });
    const cross = sv("line", { y1: MT, y2: H - MB, class: "sim-cross", visibility: "hidden" }, svg);
    svg.addEventListener("pointermove", function (e) {
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(n - 1, Math.round((x - ML) / (W - ML - MR) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      readout.textContent = fmtX(i) + " · правило " + pc((a[i] - 1) * 100) + " · «просто тримати» " + pc((b[i] - 1) * 100);
    });
    svg.addEventListener("pointerleave", function () { cross.setAttribute("visibility", "hidden"); readout.textContent = ""; });
    const lg = el("div", "sim-legend");
    const l1 = el("span", "", "▬ " + labels[0]); l1.style.color = PCOL.eq;
    const l2 = el("span", "", "▬ " + labels[1]); l2.style.color = PCOL.hold;
    lg.appendChild(l1); lg.appendChild(l2);
    if (marks && marks.length) { lg.appendChild(el("span", "sim-buy-l", "● купівля")); lg.appendChild(el("span", "sim-sell-l", "● продаж")); }
    box.appendChild(svg);
    box.appendChild(lg);
  }

  // ---------- Паперовий рахунок ----------
  const pStrat = document.getElementById("paperStrategy");

  // Гаманці торгують окремо й різними монетами: paperRaw — дані всіх гаманців, sim.paper — дані вибраного (activeCap)
  let paperRaw = null;
  function walletData(cap) { return !paperRaw ? sim.paper : (cap === paperRaw.cap || !paperRaw.wallets || !paperRaw.wallets[cap]) ? paperRaw : paperRaw.wallets[cap]; }
  function applyWallet() {
    if (!paperRaw) return;
    if (!activeCap) activeCap = parseInt(new URLSearchParams(location.search).get("wallet"), 10) || null;
    if (!activeCap || paperRaw.accounts.indexOf(activeCap) < 0) activeCap =paperRaw.cap || paperRaw.accounts[Math.min(1, paperRaw.accounts.length - 1)];
    sim.paper = walletData(activeCap);
    evts = evtsAll[activeCap] || evtsAll[paperRaw.cap] || {};
  }
  function liveMarks(id, P) {
    // оцінка рахунку за живими цінами: рахунок на закритті × (жива ціна / ціна закриття), якщо монета в позиції
    const st = (P || sim.paper).strategies[id], coins = Object.keys(st.state);
    let eq = 0, hold = 0, n = 0;
    coins.forEach(function (sym) {
      const s = st.state[sym], px = live[sym] || s[3], r = px / s[3];
      const w = s.length > 4 ? s[4] : 1 / coins.length;
      eq += w * s[1] * (s[0] ? r : 1);
      hold += w * s[2] * r;
      n++;
    });
    return n ? { eq: eq, hold: hold, live: coins.some(function (c) { return live[c]; }) } : { eq: st.eq, hold: st.hold, live: false };
  }

  // Жива стрічка угод під рахунком у стилі гаманця: нумерація, фільтри, сортування, пояснення кожної угоди простими словами.
  // Результат відкритих позицій рахується за живою ціною. Усе віртуально, це не порада.
  const seenFeed = {}, feedOpen = {}, feedCfg = { side: "", coin: "", sort: "new", limit: 20 };
  let feedFirst = true, feedBar = null, activeCap = null;
  const walletTabs = el("div", "wallet-tabs");
  walletTabs.setAttribute("role", "tablist");
  walletTabs.setAttribute("aria-label", "Гаманці");

  function plainWhy(e) {
    // пояснення для новачка: що означають показники, на які спирався бот
    const buy = e.side === "BUY", ind = e.ind || {}, out = [];
    if (e.reason) out.push(["Коротко", e.reason]);
    if (ind.price && ind.sma50) {
      const up = ind.price > ind.sma50, d = Math.abs(ind.price / ind.sma50 - 1) * 100;
      out.push(["Тренд (на графіку)", "Ціна " + pxfmt(ind.price) + " була " + (up ? "вище" : "нижче") + " середньої за 50 свічок (" + pxfmt(ind.sma50) + ") на " + d.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) +
        "%. Це лінія «звичайної» ціни: коли ціна вище неї, тренд вгору, коли нижче — вниз. " + (buy ? (up ? "Бот купує, бо ціна над лінією." : "") : (!up ? "Бот продає, бо ціна опустилась під лінію." : ""))]);
    }
    if (typeof ind.rsi === "number") {
      const r = ind.rsi;
      out.push(["Перегрів чи розпродаж (RSI)", "RSI " + Math.round(r) + " зі 100: " + (r >= 70 ? "ринок «перегрітий», після таких зростань часто буває відкат." : r <= 30 ? "монету сильно розпродали, іноді після цього буває відскок." : "нейтрально, ні перегріву, ні паніки.")]);
    }
    if (typeof ind.score === "number") out.push(["Підсумкова оцінка", "Сигнал " + Math.round(ind.score) + " за шкалою від −100 (продавати) до +100 (купувати). Це зведення кількох показників."]);
    if (e.ctx && e.ctx.label) out.push(["Загальний фон ринку", e.ctx.label + ". Правило цього не враховує, показано лише для довідки."]);
    out.push(["Важливо", "Це віртуальна угода правила, а не порада. Правило може помилятися: завдання експерименту якраз перевірити, чи заробляє воно після комісій."]);
    return out;
  }

  function pairEvents(list) {                                 // list у хронологічному порядку: звʼязуємо купівлю з наступним продажем тієї ж монети
    const open = {};
    list.forEach(function (e) {
      if (e.side === "BUY") { open[e.coin] = e; e.__sell = null; e.__buy = null; }
      else { e.__buy = open[e.coin] || null; if (open[e.coin]) open[e.coin].__sell = e; delete open[e.coin]; }
    });
  }

  // Простий звіт для друку або збереження в PDF: звичайна таблиця без графіки (кнопка «Звіт PDF» відкриває друк браузера → «Зберегти як PDF»)
  function printReport() {
    const id = pStrat.value || sim.strategies[0].id, st = sim.paper.strategies[id], m = liveMarks(id), er = (m.eq - 1) * 100;
    let box = document.getElementById("printReport");
    if (box) box.remove();
    box = el("div", ""); box.id = "printReport";
    box.appendChild(el("h1", "", "Звіт симуляції: " + ruleTitle(id)));
    box.appendChild(el("p", "", "Сформовано: " + new Date().toLocaleString("uk-UA") + ". Раунд: " + new Date(sim.paper.round.start).toLocaleString("uk-UA") + " — " + new Date(sim.paper.round.end).toLocaleString("uk-UA") + "."));
    box.appendChild(el("p", "", "Усі гроші віртуальні. Це не фінансова порада й не прогноз. Витрати на кожну операцію (комісія разом із ковзанням): " + ((sim.paper.fee || 0) * 100).toLocaleString("uk-UA") + "%."));
    const t1 = document.createElement("table");
    [["Гаманець (монети)", "Зараз", "Результат", "«Просто тримати»"]].concat(sim.paper.accounts.map(function (cap) {
      const P = walletData(cap), mm = P.strategies[id] ? liveMarks(id, P) : { eq: 1, hold: 1 }, e2 = (mm.eq - 1) * 100;
      return [usd(cap) + " (" + (P.coins || []).join(", ") + ")", usd(cap * mm.eq), (e2 >= 0 ? "+" : "−") + usd(Math.abs(cap * (mm.eq - 1))) + " (" + pc(e2) + ")", pc((mm.hold - 1) * 100)];
    })).forEach(function (r, i) { const tr = document.createElement("tr"); r.forEach(function (c) { tr.appendChild(el(i ? "td" : "th", "", c)); }); t1.appendChild(tr); });
    box.appendChild(t1);
    const cap = activeCap || sim.paper.accounts[Math.min(1, sim.paper.accounts.length - 1)], trades = buildTrades(id, cap), t2 = document.createElement("table");
    box.appendChild(el("h2", "", "Угоди гаманця " + usd(cap) + " (купівля й продаж однієї монети — один рядок)"));
    const head = ["№", "Монета", "Стан", "Куплено", "Продано", "Утримання", "Сума", "Результат", "Витрати", "Причина купівлі"];
    const hr = document.createElement("tr"); head.forEach(function (c) { hr.appendChild(el("th", "", c)); }); t2.appendChild(hr);
    trades.forEach(function (t) {
      const tr = document.createElement("tr");
      [String(t.n), t.coin, t.kind === "start" ? "Старт раунду" : t.kind === "pair" ? "Закрито" : "Відкрито", t.kind === "start" ? when(t.ts) : when(t.buy.candle),
        t.kind === "pair" ? when(t.sell.candle) : "—", t.kind === "pair" ? dur(t.held) : "—", usd(t.sum),
        t.pl === null ? "—" : pc(t.pl) + (t.usd !== null ? " (" + money(t.usd) + ")" : ""), "≈" + usd(t.costs),
        t.kind === "start" ? t.items.map(function (x) { return x.e.coin; }).join(", ") + ": " + (t.items[0].e.reason || "") : (t.buy.reason || "")].forEach(function (c) { tr.appendChild(el("td", "", c)); });
      t2.appendChild(tr);
    });
    if (!trades.length) { const tr = document.createElement("tr"), td = el("td", "", "Угод ще не було."); td.colSpan = head.length; tr.appendChild(td); t2.appendChild(tr); }
    box.appendChild(t2);
    document.body.appendChild(box);
    document.body.classList.add("printing");
    const done = function () { document.body.classList.remove("printing"); box.remove(); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  }

  function feedToolbar() {
    if (feedBar) return;
    feedBar = el("div", "sim-feed-bar");
    function sel(key, items) {
      const s = document.createElement("select");
      items.forEach(function (x) { const o = el("option", "", x[1]); o.value = x[0]; s.appendChild(o); });
      s.value = feedCfg[key];
      s.addEventListener("change", function () { feedCfg[key] = key === "limit" ? parseInt(s.value, 10) : s.value; renderPaper(false); });
      s.setAttribute("aria-label", "Стрічка угод: " + key);
      feedBar.appendChild(s);
      return s;
    }
    feedBar.appendChild(el("b", "", "Стрічка угод:"));
    sel("side", [["", "усі угоди"], ["open", "відкриті"], ["closed", "закриті (пари)"]]);
    feedBar.coinSel = sel("coin", [["", "усі монети"]]);
    sel("sort", [["new", "спочатку нові"], ["old", "спочатку старі"], ["sum", "за сумою"], ["pl", "за результатом"]]);
    sel("limit", [["10", "показати 10"], ["20", "показати 20"], ["60", "показати 60"]]);
    const pb = el("button", "link-btn", "Звіт PDF"); pb.type = "button";
    pb.title = "Відкриє друк: оберіть «Зберегти як PDF»";
    pb.addEventListener("click", printReport);
    feedBar.appendChild(pb);
    const csv = document.getElementById("decCsv");
    csv.textContent = "CSV"; csv.title = "Зберегти угоди у файл CSV (відкривається в Excel)";
    feedBar.appendChild(csv);
    paperTiles.parentNode.insertBefore(walletTabs, paperTiles);
  }

  // Розділи гаманця й сторінки: показується один за раз, щоб усе було компактно в одному місці
  const VIEWS = [["feed", "Угоди й рішення"], ["pos", "Позиції"], ["stats", "Статистика"],["chart", "Графік"], ["arena", "Арена ботів"], ["rounds", "Раунди"]];
  let activeView = "feed";
  function showView(v) {
    activeView = v;
    document.querySelectorAll(".wallet-pane").forEach(function (p) { p.hidden = p.getAttribute("data-view") !== v; });
    const bar = document.getElementById("walletViews");
    bar.replaceChildren();
    VIEWS.forEach(function (x) {
      const b = el("button", "wallet-view" + (x[0] === v ? " on" : ""), x[1]);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", x[0] === v ? "true" : "false");
      b.addEventListener("click", function () { showView(x[0]); });
      bar.appendChild(b);
    });
  }
  function showSection(id) {
    const ids = ["paper", "history", "testnet", "simAgent"];
    if (id === "decisions") { showView("feed"); id = "paper"; }
    if (ids.indexOf(id) < 0) return;
    ids.forEach(function (s) { const n = document.getElementById(s); if (n) n.hidden = s !== id; });
    document.querySelectorAll(".subtabs a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + id); });
  }
  document.querySelectorAll(".subtabs a").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); const id = a.getAttribute("href").slice(1); showSection(id); try { history.replaceState(null, "", "#" + id); } catch (x) { /* не критично */ } });
  });
  showView("feed");
  showSection((location.hash || "#paper").slice(1));

  // Угоди для стрічки: старт раунду згорнуто в один запис, купівля + продаж однієї монети — одна «пара» з підсумком, решта — відкриті позиції
  function buildTrades(id, cap) {
    const all = ((typeof evts !== "undefined" && evts[id]) || []).slice().sort(function (a, b) { return a.candle - b.candle; });
    pairEvents(all);
    const fee = sim.paper.fee || 0, out = [], start = [];
    function qOf(e) { return cap * (e.w || 1 / Math.max(1, sim.paper.coins.length)) * e.eq * (1 - fee) / e.price; }
    all.forEach(function (e) {
      if (e.side !== "BUY") return;
      const q = qOf(e), isStart = String(e.reason || "").indexOf("Початкова позиція") === 0;
      const px = live[e.coin];
      if (e.__sell) {
        const s = e.__sell, w = e.w || 1 / Math.max(1, sim.paper.coins.length), usdPl = cap * w * (s.eq - e.eq);
        out.push({ rid: id, kind: "pair", coin: e.coin, buy: e, sell: s, q: q, ts: s.candle, sum: q * e.price, pl: (s.eq / (e.eq * (1 - fee)) - 1) * 100, usd: usdPl,
          costs: q * e.price * fee + q * s.price * fee, held: s.candle - e.candle });
      } else {
        out.push({ rid: id, kind: "open", isStart: isStart, coin: e.coin, buy: e, q: q, ts: e.candle, sum: q * e.price, pl: px ? (px / e.price - 1) * 100 : null, usd: px ? q * (px - e.price) : null, costs: q * e.price * fee });
      }
    });
    if (start.length) {
      const sum = start.reduce(function (a, x) { return a + x.q * x.e.price; }, 0), pls = start.filter(function (x) { return live[x.e.coin]; });
      const usdPl = pls.reduce(function (a, x) { return a + x.q * (live[x.e.coin] - x.e.price); }, 0);
      out.push({ kind: "start", coin: start.length + " монет", items: start, ts: start[0].e.candle, sum: sum, pl: pls.length && sum ? usdPl / sum * 100 : null, usd: pls.length ? usdPl : null, costs: sum * fee });
    }
    out.sort(function (a, b) { return a.ts - b.ts; });
    out.forEach(function (t, i) { t.n = i + 1; });
    return out;
  }

  const TF_FULL = { "1d": "денному графіку (1 день)", "1h": "годинному графіку (1 година)", "15m": "15-хвилинному графіку", "30m": "30-хвилинному графіку", "2h": "2-годинному графіку" };
  const TF_SHORT = { "1d": "1 день", "1h": "1 год", "15m": "15 хв", "30m": "30 хв", "2h": "2 год" };
  const TF_CHECK = { "1d": "щодня", "1h": "щогодини", "15m": "кожні 15 хвилин", "30m": "кожні 30 хвилин", "2h": "кожні 2 години" };

  // Умови виходу правила простими словами: коли й за яких цін бот планує продати (рішення лише за закритою свічкою)
  function planOf(id, t) {
    const d = ruleDef(id) || {}, e = t.buy, tf = TF_SHORT[e.tf] || e.tf, ind = e.ind || {}, out = [];
    if (d.kind === "random") out.push("випадково: на кожній закритій свічці є ≈" + Math.round((d.p_exit || 0.1) * 100) + "% шанс вийти (це контрольний бот без індикаторів)");
    else if (d.kind === "sma50") out.push(d.invert ? "коли ціна закриття " + tf + "-свічки підніметься вище середньої за 50 свічок" + (ind.sma50 ? " (при купівлі середня була " + pxfmt(ind.sma50) + ")" : "")
      : "коли ціна закриття " + tf + "-свічки опуститься нижче середньої за 50 свічок" + (ind.sma50 ? " (при купівлі середня була " + pxfmt(ind.sma50) + ")" : ""));
    else if (typeof d.exit === "number") out.push(d.invert ? "коли оцінка сигналу підніметься вище " + (-d.exit) + " (при купівлі: " + Math.round(ind.score || 0) + ")" : "коли оцінка сигналу впаде нижче " + d.exit + " (при купівлі: " + Math.round(ind.score || 0) + ")");
    if (d.stop) out.push("стоп-лос: якщо ціна впаде до " + pxfmt(e.price * (1 - d.stop / 100)) + " (−" + d.stop + "%)");
    if (d.take) out.push("тейк-профіт: якщо ціна зросте до " + pxfmt(e.price * (1 + d.take / 100)) + " (+" + d.take + "%)");
    return { text: out, check: TF_CHECK[e.tf] || e.tf };
  }

  function dur(ms) {
    const m = Math.round(ms / 60000);
    return m < 60 ? m + " хв" : m < 2880 ? (m / 60).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " год" : (m / 1440).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " дн";
  }
  function money(v) { return (v >= 0 ? "+" : "−") + usd(Math.abs(v)); }

  // ---------- Розгорнута угода: анімований графік ціни наживо, цілі виходу й результат ----------
  const klCache = {};                                        // свічки Binance для пояснення: {"BNB|1h": {at, data}}
  const tcDrawn = {}, tcHover = {};                          // для яких угод анімацію появи вже показано; стан курсора між оновленнями
  function loadCandles(coin, tf) {
    const key = coin + "|" + tf, c = klCache[key];
    if (c && Date.now() - c.at < 60000) return c.data;
    if (!c || !c.busy) {
      klCache[key] = { at: c ? c.at : 0, data: c ? c.data : null, busy: true };
      const path = "/api/v3/klines?symbol=" + coin + "USDT&interval=" + tf + "&limit=400";
      function get(host) { return fetch(host + path).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); }); }
      get("https://api.binance.com").catch(function () { return get("https://data-api.binance.vision"); })      // запасна адреса, якщо основна недоступна
        .then(function (rows) {
          if (!Array.isArray(rows) || !rows.length) throw new Error("порожньо");
          klCache[key] = { at: Date.now(), data: rows.map(function (x) { return { t: x[0], c: parseFloat(x[4]) }; }) };
          renderPaper(false);
        }).catch(function () { klCache[key] = { at: Date.now(), data: [], busy: false }; });
    }
    return c ? c.data : null;
  }

  function normCdf(x) {                                     // функція нормального розподілу (наближення Абрамовіца–Стегуна)
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function moveTxt(d) { return (d >= 0 ? "ціні треба зрости на " : "ціні треба впасти на ") + Math.abs(d).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + "%"; }
  function pctTxt(p) { return p < 0.01 ? "менше 1%" : p > 0.99 ? "понад 99%" : "≈" + Math.round(p * 100) + "%"; }
  function spanLabel(tf, n) { const m = n * ({ "15m": 15, "30m": 30, "1h": 60, "2h": 120, "1d": 1440 }[tf] || 60); return m >= 1440 ? Math.round(m / 1440) + " дн" : m >= 120 ? Math.round(m / 60) + " год" : m + " хв"; }

  function smaAt(arr, i, n) { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k].c; return s / n; }

  // Цілі виходу з відкритої позиції: ціна, за якої правило закрило б угоду (або безубитковість), і результат у цій точці з урахуванням витрат
  function exitTargets(t, def, smaLast) {
    const e = t.buy, fee = sim.paper.fee || 0, k = (1 - fee) * (1 - fee), out = [];
    function res(p) { const pct = (k * p / e.price - 1) * 100; return { pct: pct, usd: t.sum * pct / 100 }; }
    out.push(Object.assign({ key: "be", label: "Беззбитковість (повернути витрати)", price: e.price / k, color: "var(--muted)" }, res(e.price / k)));
    if (def.take) { const p = e.price * (1 + def.take / 100); out.push(Object.assign({ key: "take", label: "Тейк-профіт (фіксація прибутку)", price: p, color: "var(--up)" }, res(p))); }
    if (def.stop) { const p = e.price * (1 - def.stop / 100); out.push(Object.assign({ key: "stop", label: "Стоп-лос (обмеження збитку)", price: p, color: "var(--down)" }, res(p))); }
    if (def.kind === "sma50" && smaLast) out.push(Object.assign({ key: "sma", label: def.invert ? "Вихід за правилом: ціна закриття вище середньої" : "Вихід за правилом: ціна закриття нижче середньої", price: smaLast, color: "var(--tc-ma)" }, res(smaLast)));
    return out;
  }

  function tradeChart(t, d, cur) {
    const box = el("div", "tc-box"), e = t.buy, def = ruleDef(t.rid) || {}, key = t.fkey, firstDraw = !tcDrawn[key];
    if (!d) { box.appendChild(el("p", "small muted", "Завантажуємо ціни з Binance…")); return box; }
    if (!d.length) { box.appendChild(el("p", "small muted", "Графік зараз недоступний (немає зв'язку з Binance).")); return box; }
    d = d.map(function (x) { return { t: x.t, c: x.c }; });
    if (cur) d[d.length - 1].c = cur;                                  // остання свічка живе: її ціна оновлюється щосекунди
    const entryIdx = Math.max(0, d.findIndex(function (x) { return x.t >= e.candle; })), left = d[0].t > e.candle;
    const exitRaw = t.kind === "pair" ? d.findIndex(function (x) { return x.t >= t.sell.candle; }) : -1, exitIdx = exitRaw < 0 ? d.length - 1 : exitRaw;
    const i0 = Math.max(0, Math.min(d.length - 90, entryIdx - 20)), view = d.slice(i0), FUT = 12;
    const W = 760, H = 280, ML = 8, MR = 70, MT = 16, MB = 22, plotW = W - ML - MR, nTot = view.length + FUT;
    const sma = view.map(function (x, i) { return smaAt(d, i0 + i, 50); });
    const rets = []; for (let i = Math.max(1, d.length - 100); i < d.length; i++) rets.push(Math.log(d[i].c / d[i - 1].c));
    const mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length, sd = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / rets.length);
    const last = d[d.length - 1].c, smaLast = sma[sma.length - 1], targets = t.kind === "open" ? exitTargets(t, def, smaLast) : [];
    let lo = Infinity, hi = -Infinity;
    function ext(v) { if (v !== null && v !== undefined && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    view.forEach(function (x, i) { ext(x.c); ext(sma[i]); });
    ext(last * Math.exp(-2 * sd * Math.sqrt(FUT))); ext(last * Math.exp(2 * sd * Math.sqrt(FUT))); ext(e.price);
    targets.forEach(function (g) { if (g.key !== "sma") ext(g.price); });
    targets.forEach(function (g) {                                     // ймовірність за простою моделлю випадкового блукання з мінливістю останніх свічок
      const up = g.price > e.price; g.reached = up ? last >= g.price : last <= g.price;
      const dl = Math.abs(Math.log(g.price / last));
      g.dist = (g.price / last - 1) * 100;
      g.p1 = g.reached ? 1 : 2 * (1 - normCdf(dl / sd)) / 2;
      g.pn = g.reached ? 1 : Math.min(1, 2 * (1 - normCdf(dl / (sd * Math.sqrt(FUT)))));
    });
    box.tcInfo = { last: last, targets: targets, span: spanLabel(e.tf, FUT) };
    const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
    const X = function (i) { return ML + i / (nTot - 1) * plotW; }, Y = function (v) { return MT + (hi - v) / (hi - lo) * (H - MT - MB); };
    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "tc-svg" + (firstDraw ? " tc-first" : ""), role: "img", "aria-label": "Ціна " + t.coin + ": де куплено, цілі виходу й типовий діапазон" }), pxs = pxfmt;
    const gid = "tcg" + String(key).replace(/[^a-z0-9]/gi, "");
    const defs = sv("defs", {}, svg), grad = sv("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    sv("stop", { offset: "0%", "stop-color": "var(--tc-price)", "stop-opacity": 0.28 }, grad); sv("stop", { offset: "100%", "stop-color": "var(--tc-price)", "stop-opacity": 0 }, grad);
    const num2 = function (v) { return pxs(v).replace(" $", ""); }, halo = { "paint-order": "stroke", stroke: "var(--card)", "stroke-width": 3, "stroke-linejoin": "round" };
    const tags = [], lefts = [];                                                  // підписи на правій осі та зліва: розставляємо без накладання
    if (def.kind === "sma50") {                                                    // зона виходу за середньою: там правило закрило б угоду
      const pts = sma.map(function (v, i) { return v === null ? null : [X(i), Y(v)]; }).filter(Boolean);
      if (pts.length > 1) {
        const edge = def.invert ? MT : H - MB;
        sv("polygon", { class: "tc-zone", points: pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + " " + pts[pts.length - 1][0].toFixed(1) + "," + edge + " " + pts[0][0].toFixed(1) + "," + edge, fill: "var(--down)", opacity: 0.08 }, svg);
      }
    }
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; sv("line", { x1: ML, x2: W - MR, y1: Y(v), y2: Y(v), stroke: "var(--line)", "stroke-dasharray": "1 4" }, svg); sv("text", { x: W - MR + 6, y: Y(v) + 3.5, "font-size": 10, fill: "var(--muted)" }, svg).textContent = num2(v); }
    const cone = function (m, f) { const up = [], dn = []; for (let k = 0; k <= FUT; k++) { const x = X(view.length - 1 + k); up.push(x.toFixed(1) + "," + Y(last * Math.exp(m * sd * Math.sqrt(k))).toFixed(1)); dn.unshift(x.toFixed(1) + "," + Y(last * Math.exp(-m * sd * Math.sqrt(k))).toFixed(1)); } sv("polygon", { class: "tc-cone", points: up.concat(dn).join(" "), fill: "var(--tc-price)", opacity: f }, svg); };
    cone(2, 0.07); cone(1, 0.13);
    sv("line", { x1: X(view.length - 1), x2: X(view.length - 1), y1: MT, y2: H - MB, stroke: "var(--muted)", "stroke-dasharray": "2 3", opacity: 0.6 }, svg);
    sv("text", Object.assign({ x: X(view.length - 1) + 6, y: MT + 8, "font-size": 10, fill: "var(--muted)" }, halo), svg).textContent = "типовий діапазон →";
    // цілі виходу: рівні на графіку, підписи окремо
    targets.forEach(function (g) {
      const col = g.key === "sma" ? "var(--tc-ma)" : g.color;
      if (g.key !== "sma") sv("line", { class: "tc-level", x1: ML, x2: W - MR, y1: Y(g.price), y2: Y(g.price), stroke: col, "stroke-width": 1.2, "stroke-dasharray": "6 4" }, svg);
      tags.push({ y: Y(g.price), text: num2(g.price), fill: col });
      lefts.push({ y: Y(g.price), text: (g.key === "be" ? "беззбитковість " : g.key === "take" ? "тейк-профіт " : g.key === "stop" ? "стоп-лос " : "вихід за правилом ") + pc(g.pct), fill: col });
    });
    // ціна (з градієнтною заливкою) та середня
    const pp = view.map(function (x, i) { return X(i).toFixed(1) + "," + Y(x.c).toFixed(1); });
    sv("polygon", { class: "tc-area", points: pp.join(" ") + " " + X(view.length - 1).toFixed(1) + "," + (H - MB) + " " + X(0).toFixed(1) + "," + (H - MB), fill: "url(#" + gid + ")" }, svg);
    sv("polyline", { class: "tc-price", pathLength: 1, points: pp.join(" "), fill: "none", stroke: "var(--tc-price)", "stroke-width": 1.8, "stroke-linejoin": "round" }, svg);
    const sp = sma.map(function (v, i) { return v === null ? null : X(i).toFixed(1) + "," + Y(v).toFixed(1); }).filter(Boolean);
    if (sp.length > 1) sv("polyline", { class: "tc-sma", pathLength: 1, points: sp.join(" "), fill: "none", stroke: "var(--tc-ma)", "stroke-width": 1.4 }, svg);
    // позначки купівлі/продажу у стилі біржі: круглий значок B / S
    function badge(i, price, color, letter, text) {
      const x = X(i), y0 = Y(price), g = sv("g", { class: "tc-pop" }, svg);
      const near = t.kind === "open" && Math.abs(x - X(view.length - 1)) < 20 && Math.abs(y0 - Y(last)) < 20, y = near ? y0 - 24 : y0;   // якщо збігається з живою точкою, значок піднімаємо над нею
      if (near) sv("line", { x1: x, x2: x, y1: y + 9, y2: y0, stroke: color, "stroke-width": 1.5 }, g);
      sv("circle", { cx: x, cy: y, r: 9, fill: color, stroke: "var(--card)", "stroke-width": 2 }, g);
      sv("text", { x: x, y: y + 3.6, "text-anchor": "middle", "font-size": 10.5, "font-weight": 800, fill: "#fff" }, g).textContent = letter;
      sv("text", Object.assign({ x: Math.min(W - MR - 4, Math.max(ML + 4, x)), y: near ? y - 14 : y + 25, "text-anchor": x > W * 0.7 ? "end" : x < 80 ? "start" : "middle", "font-size": 10.5, "font-weight": 700, fill: color }, halo), g).textContent = text;
    }
    badge(Math.max(0, entryIdx - i0), e.price, "var(--up)", "B", (left ? "← " : "") + "купівля");
    tags.push({ y: Y(e.price), text: num2(e.price), fill: "var(--up)" });
    if (t.kind === "pair") { badge(Math.max(0, exitIdx - i0), t.sell.price, "var(--down)", "S", "продаж"); tags.push({ y: Y(t.sell.price), text: num2(t.sell.price), fill: "var(--down)" }); }
    else {
      sv("line", { x1: ML, x2: W - MR, y1: Y(last), y2: Y(last), stroke: "var(--accent)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.8 }, svg);
      sv("circle", { class: "tc-ring", cx: X(view.length - 1), cy: Y(last), r: 5, fill: "var(--accent)" }, svg);
      sv("circle", { cx: X(view.length - 1), cy: Y(last), r: 4.5, fill: "var(--accent)", stroke: "var(--card)", "stroke-width": 2 }, svg);
      tags.push({ y: Y(last), text: num2(last), fill: "var(--accent)", dark: true, strong: true });
    }
    // розсуваємо підписи, щоб не накладались
    function spread(list, gap, minY, maxY) {
      list.sort(function (a, b) { return a.y - b.y; });
      list.forEach(function (it, i) { it.py = i && it.y < list[i - 1].py + gap ? list[i - 1].py + gap : it.y; });
      for (let i = list.length - 1; i >= 0; i--) { if (list[i].py > maxY) list[i].py = maxY; if (i < list.length - 1 && list[i].py > list[i + 1].py - gap) list[i].py = list[i + 1].py - gap; if (list[i].py < minY) list[i].py = minY; }
    }
    spread(tags, 16, MT + 6, H - MB - 6);
    tags.forEach(function (tg) {
      sv("rect", { x: W - MR + 2, y: tg.py - 8, width: MR - 4, height: 16, rx: 3, fill: tg.fill }, svg);
      sv("text", { x: W - MR + 2 + (MR - 4) / 2, y: tg.py + 3.5, "text-anchor": "middle", "font-size": 10, "font-weight": 700, fill: tg.dark ? "#14161a" : "#fff" }, svg).textContent = tg.text;
    });
    spread(lefts, 15, MT + 8, H - MB - 6);
    lefts.forEach(function (lf) { sv("text", Object.assign({ x: ML + 6, y: lf.py - 4, "font-size": 10.5, "font-weight": 700, fill: lf.fill }, halo), svg).textContent = lf.text; });
    [0, Math.floor(view.length / 2), view.length - 1].forEach(function (i, k) { sv("text", { x: X(i), y: H - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle", "font-size": 10, fill: "var(--muted)" }, svg).textContent = new Date(view[i].t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); });
    // перехрестя у стилі біржі: вертикаль + горизонталь і ціна на осі
    const cross = sv("line", { y1: MT, y2: H - MB, stroke: "var(--muted)", "stroke-dasharray": "3 3", visibility: "hidden" }, svg), crossH = sv("line", { x1: ML, x2: W - MR, stroke: "var(--muted)", "stroke-dasharray": "3 3", visibility: "hidden" }, svg);
    const crossTag = sv("g", { visibility: "hidden" }, svg); sv("rect", { x: W - MR + 2, width: MR - 4, height: 16, rx: 3, fill: "var(--muted)" }, crossTag); const crossTxt = sv("text", { x: W - MR + 2 + (MR - 4) / 2, "text-anchor": "middle", "font-size": 10, "font-weight": 700, fill: "#14161a" }, crossTag);
    const ro = el("p", "small tc-readout", tcHover[key] || "Наведіть курсор на графік: час і ціна.");
    svg.addEventListener("pointermove", function (ev) {
      const b = svg.getBoundingClientRect(), x = (ev.clientX - b.left) / b.width * W, i = Math.round((x - ML) / plotW * (nTot - 1));
      if (i < 0 || i >= view.length) { [cross, crossH, crossTag].forEach(function (n) { n.setAttribute("visibility", "hidden"); }); return; }
      const yy = Y(view[i].c);
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); crossH.setAttribute("y1", yy); crossH.setAttribute("y2", yy);
      crossTag.firstChild.setAttribute("y", yy - 8); crossTxt.setAttribute("y", yy + 3.5); crossTxt.textContent = num2(view[i].c);
      [cross, crossH, crossTag].forEach(function (n) { n.setAttribute("visibility", "visible"); });
      const ch = (view[i].c / e.price - 1) * 100;
      ro.textContent = tcHover[key] = new Date(view[i].t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + ": " + pxs(view[i].c) + " · проти ціни купівлі " + pc(ch) + (sma[i] ? " · середня " + pxs(sma[i]) : "");
    });
    svg.addEventListener("pointerleave", function () { [cross, crossH, crossTag].forEach(function (n) { n.setAttribute("visibility", "hidden"); }); });
    box.appendChild(svg);
    box.appendChild(ro);
    if (firstDraw) { tcDrawn[key] = 1; setTimeout(function () { document.querySelectorAll(".tc-first").forEach(function (n) { n.classList.remove("tc-first"); }); }, 2200); }
    const lg = el("div", "tc-legend small");
    [["— ціна наживо", "var(--tc-price)"], ["— середня за 50 свічок", "var(--tc-ma)"], ["Ⓑ купівля", "var(--up)"], ["Ⓢ продаж", "var(--down)"], ["▒ діапазон, куди ціна зазвичай рухається", "var(--tc-price)"]].forEach(function (x) { const s = el("span", "", x[0]); s.style.color = x[1]; lg.appendChild(s); });
    box.appendChild(lg);
    box.appendChild(exitPanel(t, last, targets, box.tcInfo));
    const chips = el("div", "tc-chips"), r1 = (Math.exp(sd * Math.sqrt(FUT)) - 1) * 100, r2 = (Math.exp(2 * sd * Math.sqrt(FUT)) - 1) * 100;
    function chip(a, b, c2) { const s = el("div", "tc-chip " + (c2 || "")); s.appendChild(el("span", "small", a)); s.appendChild(el("b", "", b)); chips.appendChild(s); }
    const span = FUT * ({ "15m": 15, "30m": 30, "1h": 60, "2h": 120, "1d": 1440 }[e.tf] || 60), spanTxt = span >= 1440 ? Math.round(span / 1440) + " дн" : span >= 120 ? Math.round(span / 60) + " год" : span + " хв";
    chip("Наскільки ціна зазвичай зміниться за наступні " + spanTxt, "до ±" + r1.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + "% (так буває у 7 випадках із 10)");
    chip("А в рідкісних випадках", "до ±" + r2.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + "% (майже завжди вкладається)");
    box.appendChild(chips);
    box.appendChild(el("p", "small muted tc-note", "Це не прогноз ціни: правила не вміють передбачати, а діапазон показує лише, наскільки ціна зазвичай коливається. Чи заробляють правила, показує «Арена ботів»."));
    return box;
  }

  // Панель «Скільки до виходу»: результат, якби закрити зараз, і прогрес до кожної цілі
  function exitPanel(t, last, targets, info) {
    const e = t.buy, fee = sim.paper.fee || 0, k = (1 - fee) * (1 - fee), p = el("div", "tc-exit");
    if (t.kind === "pair") {
      const h = el("div", "tc-exit-h"); h.appendChild(el("b", "", "Угоду закрито: " + pc(t.pl) + " (" + money(t.usd) + ")")); h.appendChild(el("span", "small", "купівля " + pxfmt(e.price) + " → продаж " + pxfmt(t.sell.price) + " · утримання " + dur(t.held)));
      p.appendChild(h); return p;
    }
    const nowPct = (k * last / e.price - 1) * 100, h = el("div", "tc-exit-h");
    h.appendChild(el("b", cls(nowPct), "Якби закрити зараз: " + pc(nowPct) + " (" + money(t.sum * nowPct / 100) + ")"));
    h.appendChild(el("span", "small", "ціна зараз " + pxfmt(last) + " · купівля " + pxfmt(e.price) + " · витрати на вхід і вихід враховано"));
    p.appendChild(h);
    if (!targets.length || targets.length === 1) p.appendChild(el("p", "small muted", "У цього правила немає фіксованої ціни виходу: воно закриває угоду за іншим сигналом (див. «Коли планує продати»). Беззбитковість вище показує, до якої ціни треба дорости, щоб вийти без втрат."));
    targets.forEach(function (g) {
      const up = g.price > e.price, reached = up ? last >= g.price : last <= g.price;
      const row = el("div", "tc-target"), prog = reached ? 1 : Math.max(0, Math.min(1, (last - e.price) / (g.price - e.price))), dist = (g.price / last - 1) * 100;
      const top = el("div", "tc-target-top");
      top.appendChild(el("span", "tc-dot")).style.background = g.color;
      top.appendChild(el("b", "", g.label));
      top.appendChild(el("span", "", "ціна " + pxfmt(g.price)));
      top.appendChild(el("b", cls(g.pct), "результат " + pc(g.pct) + " (" + money(g.usd) + ")"));
      row.appendChild(top);
      const bar = el("div", "tc-prog"), fl = el("i", ""); fl.style.width = (prog * 100).toFixed(1) + "%"; fl.style.background = g.color; bar.appendChild(fl); row.appendChild(bar);
      row.appendChild(el("div", "small tc-target-sub", (prog >= 1 ? "ціна вже за цією межею: правило закриє угоду, коли закриється поточна свічка (якщо ціна не повернеться)" : "до цілі: " + moveTxt(dist) + " від ціни зараз · пройдено " + Math.round(prog * 100) + "% шляху від ціни купівлі")));
      if (!g.reached) row.appendChild(el("div", "small tc-prob", "Ймовірність дійти до цієї ціни: за наступну свічку " + pctTxt(g.p1) + ", за наступні " + (info ? info.span : "") + " " + pctTxt(g.pn)));
      p.appendChild(row);
    });
    return p;
  }

  // Шкала-«спідометр» для показника: позначка на кольорових зонах
  function gauge(title, val, min, max, zones, label, ticks, caps, hint) {
    const g = el("div", "tc-gauge"), tr = el("div", "tc-track");
    zones.forEach(function (z) { const s = el("i", ""); s.style.left = (z[0] - min) / (max - min) * 100 + "%"; s.style.width = (z[1] - z[0]) / (max - min) * 100 + "%"; s.style.background = z[2]; tr.appendChild(s); });
    (ticks || []).forEach(function (tk) { const s = el("u", ""); s.style.left = (tk[0] - min) / (max - min) * 100 + "%"; s.title = tk[1]; tr.appendChild(s); });
    const mk = el("b", "tc-mark"); mk.style.left = Math.max(0, Math.min(100, (val - min) / (max - min) * 100)) + "%"; tr.appendChild(mk);
    const head = el("div", "tc-gauge-h"); head.appendChild(el("span", "", title)); head.appendChild(el("b", "", label));
    g.appendChild(head); g.appendChild(tr);
    if (caps) { const c = el("div", "tc-caps small"); c.appendChild(el("span", "", caps[0])); c.appendChild(el("span", "", caps[1])); g.appendChild(c); }
    if (hint) g.appendChild(el("div", "small tc-gauge-hint", hint));
    return g;
  }

  function tradeDetails(t) {
    const ex = el("div", "sim-feed-why tc"), e = t.buy, ind = e.ind || {}, def = ruleDef(t.rid) || {};
    ex.appendChild(el("div", "sim-feed-where", "Куплено на " + (TF_FULL[e.tf] || e.tf) + " · правило: " + ruleTitle(t.rid)));
    const sumRow = el("div", "tc-sum small");
    [["Кількість", qfmt(t.q) + " " + t.coin], ["Сума входу", usd(t.sum)], ["Витрати", "≈" + usd(t.costs)]].concat(t.kind === "pair" ? [["Утримання", dur(t.held)], ["Результат", pc(t.pl) + " (" + money(t.usd) + ")"]] : []).forEach(function (x) { const s = el("span", ""); s.appendChild(document.createTextNode(x[0] + ": ")); s.appendChild(el("b", "", x[1])); sumRow.appendChild(s); });
    ex.appendChild(sumRow);
    const chartBox = tradeChart(t, loadCandles(t.coin, e.tf), live[t.coin]);
    ex.appendChild(chartBox);
    const gs = el("div", "tc-gauges");
    const nw = "у момент купівлі";
    if (ind.price && ind.sma50) {
      const dv = (ind.price / ind.sma50 - 1) * 100, ad = Math.abs(dv).toLocaleString("uk-UA", { maximumFractionDigits: 2 });
      gs.appendChild(gauge("Куди йде ціна?", dv, -3, 3, [[-3, 0, "rgba(180,80,80,.35)"], [0, 3, "rgba(80,150,100,.35)"]], dv >= 0 ? "вище звичайної на " + ad + "%" : "нижче звичайної на " + ad + "%", [[0, "«звичайна» ціна"]],
        ["← ціна нижче звичайної (падає)", "вище звичайної (росте) →"], "«Звичайна» ціна — це середня за останні 50 свічок. Над нею ринок росте, під нею падає (" + nw + ")."));
    }
    if (typeof ind.rsi === "number") {
      const r = ind.rsi;
      gs.appendChild(gauge("Чи не надто різкий рух?", r, 0, 100, [[0, 30, "rgba(80,150,100,.35)"], [30, 70, "rgba(150,150,150,.25)"], [70, 100, "rgba(180,80,80,.35)"]],
        r >= 70 ? "ціна надто різко виросла" : r <= 30 ? "ціна надто різко впала" : "рух спокійний, без крайнощів", [[30, "30"], [70, "70"]],
        ["← надто сильно падала", "надто сильно росла →"], "Це показник RSI (" + Math.round(r) + " зі 100). Після дуже різкого руху ціна часто відкочується назад (" + nw + ")."));
    }
    if (typeof ind.score === "number") {
      const sc = Math.round(ind.score);
      gs.appendChild(gauge("Що радять сигнали?", ind.score, -100, 100, [[-100, -30, "rgba(180,80,80,.35)"], [-30, 30, "rgba(150,150,150,.25)"], [30, 100, "rgba(80,150,100,.35)"]],
        sc >= 30 ? "більше за купівлю (" + sc + ")" : sc <= -30 ? "більше за продаж (" + sc + ")" : "нічого певного (" + sc + ")", typeof def.enter === "number" ? [[def.enter, "поріг входу"], [def.exit, "поріг виходу"]] : [],
        ["← радять продавати", "радять купувати →"], "Зведена оцінка всіх показників від −100 до +100 (" + nw + "). Пунктирні позначки — пороги, за яких правило входить і виходить."));
    }
    ex.appendChild(gs);
    const plan = planOf(t.rid, t);
    const pw = el("div", "tc-plan"); pw.appendChild(el("b", "", t.kind === "pair" ? "Чому продали: " : "Коли планує продати: "));
    pw.appendChild(document.createTextNode(t.kind === "pair" ? (t.sell.reason || "") : plan.text.join("; або ") + ". Перевірка " + plan.check + ", лише за закритою свічкою."));
    if (t.kind === "open") {
      const nowP = live[t.coin] || (chartBox.tcInfo && chartBox.tcInfo.last), info = chartBox.tcInfo, main = info ? info.targets.filter(function (g) { return g.key !== "be"; }) : [];
      const live2 = el("div", "tc-now");
      live2.appendChild(el("div", "", "Ціна зараз: " + (nowP ? pxfmt(nowP) : "—") + " · куплено по " + pxfmt(e.price) + (nowP ? " (" + pc((nowP / e.price - 1) * 100) + ")" : "")));
      main.forEach(function (g) {
        live2.appendChild(el("div", "", (g.key === "sma" ? "До виходу за правилом" : g.key === "take" ? "До фіксації прибутку" : "До стоп-лосу") + ": " +
          (g.reached ? "ціна вже за межею " + pxfmt(g.price) + ", вихід на закритті свічки" : moveTxt(g.dist) + " (до " + pxfmt(g.price) + ") · ймовірність за наступну свічку " + pctTxt(g.p1) + ", за " + info.span + " " + pctTxt(g.pn)) +
          " · результат у цій точці " + pc(g.pct)));
      });
      if (!main.length) live2.appendChild(el("div", "", def.kind === "random" ? "Вихід випадковий: на кожній наступній свічці ≈" + Math.round((def.p_exit || 0.1) * 100) + "% шанс." : "Вихід за сигналом, а не за ціною, тому відстань у ціні не рахується."));
      live2.appendChild(el("div", "small muted", "Ймовірність — груба оцінка за звичною мінливістю ціни, а не прогноз і не гарантія."));
      pw.appendChild(live2);
    }
    ex.appendChild(pw);
    return ex;
  }

  function feedBox(id, cap) {
    feedToolbar();
    const cs = feedBar.coinSel;
    if (cs.options.length - 1 !== sim.paper.coins.length) {
      cs.replaceChildren(); [["", "усі монети"]].concat(sim.paper.coins.map(function (c) { return [c, c]; })).forEach(function (x) { const o = el("option", "", x[1]); o.value = x[0]; cs.appendChild(o); });
      cs.value = feedCfg.coin;
    }
    const trades = buildTrades(id, cap);
    const box = el("div", "sim-feed"), head = el("div", "sim-feed-h");
    head.appendChild(el("b", "", "Гаманець: угоди бота"));
    head.appendChild(el("span", "sim-feed-live", "● наживо"));
    box.appendChild(head);
    if (!trades.length) { box.appendChild(el("p", "sim-feed-empty", "Угод ще не було: правило чекає свого сигналу. Тут з'являтиметься кожна угода з поясненням.")); return box; }

    const closed = trades.filter(function (t) { return t.kind === "pair"; }), wins = closed.filter(function (t) { return t.pl > 0; }).length;
    const realized = closed.reduce(function (a, t) { return a + t.usd; }, 0), costs = trades.reduce(function (a, t) { return a + t.costs; }, 0);
    const sumLine = el("div", "sim-feed-sum-line small");
    [["Угод закритих", String(closed.length)], ["прибуткових", closed.length ? wins + " з " + closed.length : "—"], ["зафіксовано", closed.length ? money(realized) : "—"], ["витрати (комісія + ковзання)", "≈" + usd(costs)]].forEach(function (x) {
      const s = el("span", ""); s.appendChild(document.createTextNode(x[0] + ": ")); s.appendChild(el("b", x[0] === "зафіксовано" && closed.length ? cls(realized) : "", x[1])); sumLine.appendChild(s);
    });
    box.appendChild(sumLine);

    let items = trades.filter(function (t) {
      return (!feedCfg.coin || t.kind === "start" || t.coin === feedCfg.coin) && (!feedCfg.side || (feedCfg.side === "closed" ? t.kind === "pair" : t.kind !== "pair"));
    });
    items.sort(function (a, b) {
      const pa = a.pl === null ? -1e9 : a.pl, pb = b.pl === null ? -1e9 : b.pl;
      return feedCfg.sort === "old" ? a.ts - b.ts : feedCfg.sort === "sum" ? b.sum - a.sum : feedCfg.sort === "pl" ? pb - pa : b.ts - a.ts;
    });
    box.appendChild(el("p", "sim-feed-count small", "Показано " + Math.min(items.length, feedCfg.limit) + " із " + items.length + " угод"));
    if (!items.length) box.appendChild(el("p", "sim-feed-empty", "За цим фільтром угод немає."));
    items.slice(0, feedCfg.limit).forEach(function (t) {
      const key = id + "|" + cap + "|" + t.kind + "|" + t.coin + "|" + t.ts, row = el("div", "sim-feed-row " + (t.kind === "pair" ? (t.pl >= 0 ? "buy" : "sell") : t.kind === "open" ? "buy" : "start"));
      if (!feedFirst && !seenFeed[key]) row.classList.add("new");
      seenFeed[key] = 1;
      const top = el("button", "sim-feed-top"); top.type = "button"; top.setAttribute("aria-expanded", feedOpen[key] ? "true" : "false");
      top.appendChild(el("span", "sim-feed-n", "№" + t.n));
      top.appendChild(el("span", "sim-feed-side", t.kind === "pair" ? "ЗАКРИТО" : t.isStart ? "КУПЛЕНО НА СТАРТІ" : "КУПЛЕНО"));
      top.appendChild(el("b", "", t.coin));
      top.appendChild(el("span", "sim-feed-tf", "графік " + (TF_SHORT[(t.buy || {}).tf] || "")));
      top.appendChild(el("span", "small sim-feed-times", t.kind === "start" ? when(t.ts) : t.kind === "pair" ? when(t.buy.candle) + " → " + when(t.sell.candle) + " · " + dur(t.held) : when(t.buy.candle) + " → в позиції"));
      if (t.pl !== null) top.appendChild(el("span", "sim-feed-pl " + cls(t.pl), pc(t.pl) + (t.usd !== null ? " (" + money(t.usd) + ")" : "")));
      top.appendChild(el("span", "sim-feed-sum", usd(t.sum)));
      top.addEventListener("click", function () { feedOpen[key] = !feedOpen[key]; renderPaper(false); });
      row.appendChild(top);
      t.fkey = key;
      if (feedOpen[key]) row.appendChild(tradeDetails(t));
      else {
        const plan = t.kind === "open" ? planOf(id, t) : null;
        const why = t.kind === "pair" ? t.sell.reason || "" : plan ? "Планує продати " + plan.text.join("; або ") + ". Перевірка " + plan.check + "." : "";
        row.appendChild(el("span", "small sim-feed-hint", "▸ " + String(why).slice(0, 190) + (why.length > 190 ? "…" : "")));
      }
      box.appendChild(row);
    });
    return box;
  }

  function renderPaper(withChart) {
    if (!sim || !sim.paper) return;
    const id = pStrat.value || sim.strategies[0].id, st = sim.paper.strategies[id];
    if (!st) return;
    const m = liveMarks(id), er = (m.eq - 1) * 100, hr = (m.hold - 1) * 100;

    paperTiles.replaceChildren();
    feedToolbar();
    walletTabs.replaceChildren();
    sim.paper.accounts.forEach(function (cap) {
      const b = el("button", "wallet-tab" + (cap === activeCap ? " on" : ""));
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", cap === activeCap ? "true" : "false");
      const P = walletData(cap), mm = P.strategies[id] ? liveMarks(id, P) : { eq: 1 }, e2 = (mm.eq - 1) * 100;
      b.appendChild(el("span", "wallet-tab-n", "Гаманець " + usd(cap)));
      b.appendChild(el("b", "", usd(cap * mm.eq)));
      b.appendChild(el("span", "small " + cls(e2), pc(e2)));
      b.appendChild(el("span", "small wallet-tab-coins", (P.coins || []).join(" · ")));
      b.addEventListener("click", function () { activeCap = cap; applyWallet(); renderPaper(true); renderBoard(); renderRounds(); renderDecisions(); });
      walletTabs.appendChild(b);
    });
    paperTiles.classList.add("wallet-single");
    sim.paper.accounts.filter(function (cap) { return cap === activeCap; }).forEach(function (cap) {
      const t = el("div", "ov-tile");
      t.appendChild(el("h3", "ov-title", "Рахунок " + usd(cap)));
      t.appendChild(el("b", "out-big", usd(cap * m.eq)));
      t.appendChild(el("span", cls(er), (er >= 0 ? "+" : "−") + usd(Math.abs(cap * (m.eq - 1))) + " (" + pc(er) + ")"));
      t.appendChild(el("span", "small " + cls(hr), "«просто тримати»: " + usd(cap * m.hold) + " (" + pc(hr) + ")"));
      const inCoins = st.open.reduce(function (a, c) { const x = st.state[c]; return a + (x ? cap * x[4] * x[1] * (live[c] ? live[c] / x[3] : 1) : 0); }, 0);
      const per = st.open.length ? inCoins / st.open.length : 0;
      const small = st.open.length && per < 10;
      const chip = el("span", "ov-verdict " + (small ? "mixed" : "same"), "у монетах: " + usd(inCoins) + " (" + st.open.length + " із " + Object.keys(st.state).length + " монет), решта готівкою");
      chip.tabIndex = 0;
      chip.setAttribute("data-help", st.open.length ? ("Відкриті віртуальні позиції: " + st.open.join(", ") + ". " + (small ? "На біржі мінімальний ордер близько 10 $: на такій сумі розділити гроші між усіма цими монетами не вийшло б. " : "") + "Угод у раунді: " + st.trades) : "Зараз усі гроші в готівці: сигнали не радять тримати жодної монети");
      t.appendChild(chip);
      document.getElementById("walletFeed").replaceChildren(feedBar, feedBox(id, cap));
      paperTiles.appendChild(t);
    });
    feedFirst = false;

    if (withChart === false) return;                                  // щосекунди оновлюємо лише суми, графік рідше
    const curve = st.curve.slice();
    const lastTs = curve.length ? Date.parse(curve[curve.length - 1][0]) : 0;
    (trail[activeCap + "|" + id] || []).forEach(function (r) { if (Date.parse(r[0]) > lastTs) curve.push(r); });   // слід за живою ціною між запусками агента
    if (curve.length >= 2) {
      curves(document.getElementById("paperChart"), document.getElementById("paperReadout"),
        curve.map(function (r) { return r[1]; }), curve.map(function (r) { return r[2]; }), ["правило", "«просто тримати»"], null,
        function (i) { return new Date(curve[i][0]).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); });
    } else {
      document.getElementById("paperChart").replaceChildren(el("p", "muted", "Крива з'явиться після кількох запусків агента (кожні ~10 хвилин)."));
    }
  }

  function renderRounds() {
    const box = document.getElementById("paperHistory"), h = sim.paper.history || [];
    if (!h.length) { box.replaceChildren(el("p", "muted", "Перший раунд іще триває.")); return; }
    const t = el("table", "agent-table"), head = el("tr");
    ["Раунд", "Правило", "Результат правила", "«Просто тримати»", "Угод"].forEach(function (x) { head.appendChild(el("th", "", x)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    h.slice().reverse().forEach(function (r) {
      sim.strategies.forEach(function (s) {
        const v = r.strategies[s.id];
        if (!v) return;
        const tr = el("tr");
        tr.appendChild(el("td", "", new Date(r.start).toLocaleDateString("uk-UA", { day: "numeric", month: "short" }) + " – " + new Date(r.end).toLocaleDateString("uk-UA", { day: "numeric", month: "short" })));
        tr.appendChild(el("td", "", s.title));
        tr.appendChild(el("td", cls(v.eq - 1), pc((v.eq - 1) * 100)));
        tr.appendChild(el("td", cls(v.hold - 1), pc((v.hold - 1) * 100)));
        tr.appendChild(el("td", "", String(v.trades)));
        body.appendChild(tr);
      });
    });
    t.appendChild(body);
    box.replaceChildren(t);
  }


  // ---------- «Арена ботів»: усі правила паралельно, одна спільна діаграма результату + рейтинг ----------
  const BOT_COLORS = ["#44707f", "#c28a3a", "#6b8f5e", "#8a6fa8", "#b8666a", "#4f8f8b", "#a07c50", "#6f7fb0", "#9a9a52", "#b0708f", "#5f7f5f", "#7a7a7a", "#c07a4a", "#3f6f9f", "#8f5f7f"];
  const arenaHidden = {};
  let arenaSort = "ret";

  function botTags(def) {
    const t = [];
    if (def.kind === "random") t.push(["контроль: випадковий", "same"]);
    if (def.invert) t.push(["обернене", "down"]);
    if (def.stop) t.push(["стоп " + def.stop + "%", "same"]);
    if (def.take) t.push(["тейк " + def.take + "%", "same"]);
    if (def.sizing === "vol") t.push(["за мінливістю", "same"]);
    return t;
  }

  function arenaChart(box, readout, rows) {
    const series = rows.filter(function (r) { return !arenaHidden[r.id] && r.st.curve && r.st.curve.length; }).map(function (r) {
      const pts = r.st.curve.map(function (p) { return [Date.parse(p[0]), (p[1] - 1) * 100, (p[2] - 1) * 100]; });
      pts.push([Date.now(), r.ret, r.hold]);
      return { r: r, pts: pts };
    });
    box.replaceChildren();
    if (!series.length) { box.appendChild(el("p", "muted", "Оберіть хоча б одного бота у списку нижче.")); return; }
    const W = 760, H = 280, ML = 46, MR = 12, MT = 10, MB = 24;
    let t0 = Infinity, t1 = -Infinity, lo = 0, hi = 0;
    series.forEach(function (s) { s.pts.forEach(function (p) { t0 = Math.min(t0, p[0]); t1 = Math.max(t1, p[0]); lo = Math.min(lo, p[1], p[2]); hi = Math.max(hi, p[1], p[2]); }); });
    if (hi - lo < 0.2) { hi += 0.1; lo -= 0.1; }
    const pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
    const X = function (t) { return ML + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - ML - MR); };
    const Y = function (v) { return MT + (hi - v) / (hi - lo) * (H - MT - MB); };
    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "sim-svg", role: "img", "aria-label": "Результат усіх ботів у відсотках від старту раунду" });
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, y = Y(v);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, stroke: "var(--line)", "stroke-width": 1 }, svg);
      sv("text", { x: ML - 6, y: y + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, svg).textContent = pc(v, 2);
    }
    sv("line", { x1: ML, x2: W - MR, y1: Y(0), y2: Y(0), stroke: "var(--text)", "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.6 }, svg);
    [t0, (t0 + t1) / 2, t1].forEach(function (t, k) {
      sv("text", { x: X(t), y: H - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle", "font-size": 11, fill: "var(--muted)" }, svg).textContent =
        new Date(t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    });
    const hold = series[0].pts;                                    // «просто тримати» однакове для всіх правил (ті самі монети й ваги)
    sv("polyline", { points: hold.map(function (p) { return X(p[0]).toFixed(1) + "," + Y(p[2]).toFixed(1); }).join(" "), fill: "none", stroke: "var(--muted)", "stroke-width": 2, "stroke-dasharray": "6 4", opacity: 0.8 }, svg);
    series.forEach(function (s) {
      const sel = pStrat.value === s.r.id;
      sv("polyline", { points: s.pts.map(function (p) { return X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join(" "), fill: "none", stroke: s.r.color,
        "stroke-width": sel ? 3.2 : 1.8, "stroke-linejoin": "round", opacity: sel ? 1 : 0.85, "stroke-dasharray": s.r.def.kind === "random" ? "2 3" : "" }, svg);
      const last = s.pts[s.pts.length - 1];
      sv("circle", { cx: X(last[0]), cy: Y(last[1]), r: sel ? 4.5 : 3, fill: s.r.color }, svg);
    });
    const cross = sv("line", { y1: MT, y2: H - MB, stroke: "var(--text)", "stroke-width": 1, opacity: 0.5, visibility: "hidden" }, svg);
    svg.addEventListener("pointermove", function (e) {
      const b = svg.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W, t = t0 + Math.max(0, Math.min(1, (x - ML) / (W - ML - MR))) * (t1 - t0);
      cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t)); cross.setAttribute("visibility", "visible");
      const vals = series.map(function (s) {
        let best = s.pts[0]; s.pts.forEach(function (p) { if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; });
        return { title: s.r.title, v: best[1] };
      }).sort(function (a, b) { return b.v - a.v; });
      readout.textContent = new Date(t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " → " +
        vals.slice(0, 4).map(function (v) { return v.title + " " + pc(v.v, 3); }).join(" · ") + (vals.length > 4 ? " · … найгірший: " + vals[vals.length - 1].title + " " + pc(vals[vals.length - 1].v, 3) : "");
    });
    svg.addEventListener("pointerleave", function () { cross.setAttribute("visibility", "hidden"); readout.textContent = ""; });
    box.appendChild(svg);
    const lg = el("div", "sim-legend");
    lg.appendChild(el("span", "", "┄ ┄ «просто тримати» ті самі монети"));
    box.appendChild(lg);
  }

  function renderBoard() {
    const box = document.getElementById("paperBoard");
    const ids = Object.keys(sim.paper.strategies);
    if (!ids.length) return;
    const TF = { "1d": "щодня", "1h": "щогодини", "15m": "кожні 15 хв", "30m": "кожні 30 хв", "2h": "кожні 2 год" };
    const rows = ids.map(function (id, i) {
      const st = sim.paper.strategies[id], m = liveMarks(id), def = sim.strategies.filter(function (s) { return s.id === id; })[0] || {};
      return { id: id, def: def, color: BOT_COLORS[i % BOT_COLORS.length], title: def.title || id, tf: TF[def.tf] || def.tf, inv: def.invert, pair: def.pair, st: st, ret: (m.eq - 1) * 100, hold: (m.hold - 1) * 100 };
    });
    rows.forEach(function (r) { r.vs = r.ret - r.hold; });
    const sorted = rows.slice().sort(function (a, b) { return arenaSort === "trades" ? b.st.trades - a.st.trades : arenaSort === "vs" ? b.vs - a.vs : b.ret - a.ret; });
    box.replaceChildren();
    const wrap = el("div", "arena");

    const bar = el("div", "arena-bar");
    bar.appendChild(el("b", "", "Сортування рейтингу:"));
    const ss = document.createElement("select");
    [["ret", "за результатом"], ["vs", "проти «тримати»"], ["trades", "за кількістю угод"]].forEach(function (x) { const o = el("option", "", x[1]); o.value = x[0]; ss.appendChild(o); });
    ss.value = arenaSort; ss.setAttribute("aria-label", "Сортування рейтингу ботів");
    ss.addEventListener("change", function () { arenaSort = ss.value; renderBoard(); });
    bar.appendChild(ss);
    [["Усі", function () { return false; }], ["Лише справжні", function (r) { return r.def.kind === "random" || r.inv; }], ["Лише контроль", function (r) { return !(r.def.kind === "random" || r.inv); }]].forEach(function (f) {
      const b = el("button", "link-btn", f[0]); b.type = "button";
      b.addEventListener("click", function () { rows.forEach(function (r) { arenaHidden[r.id] = f[1](r); }); renderBoard(); });
      bar.appendChild(b);
    });
    wrap.appendChild(bar);

    const chartBox = el("div", "sim-chart"), ro = el("p", "sim-readout small");
    wrap.appendChild(chartBox); wrap.appendChild(ro);

    const list = el("div", "arena-list");
    const maxAbs = Math.max(0.05, Math.max.apply(null, rows.map(function (r) { return Math.abs(r.ret); })));
    sorted.forEach(function (r, i) {
      const card = el("div", "arena-row" + (pStrat.value === r.id ? " sel" : "") + (arenaHidden[r.id] ? " off" : ""));
      const dot = el("button", "arena-dot"); dot.type = "button"; dot.style.background = arenaHidden[r.id] ? "transparent" : r.color; dot.style.borderColor = r.color;
      dot.setAttribute("aria-pressed", arenaHidden[r.id] ? "false" : "true"); dot.setAttribute("aria-label", "Показати " + r.title + " на діаграмі"); dot.title = "Показати чи сховати на діаграмі";
      dot.addEventListener("click", function () { arenaHidden[r.id] = !arenaHidden[r.id]; renderBoard(); });
      card.appendChild(dot);
      const main = el("button", "arena-main"); main.type = "button"; main.title = "Показати цього бота в рахунках вище";
      main.addEventListener("click", function () { pStrat.value = r.id; renderPaper(true); renderDecisions(); renderBoard(); });
      const top = el("div", "arena-top");
      top.appendChild(el("span", "arena-rank", (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1))));
      top.appendChild(el("b", "", r.title));
      botTags(r.def).forEach(function (t) { top.appendChild(el("span", "rank-tag " + t[1], t[0])); });
      top.appendChild(el("span", "arena-ret " + cls(r.ret), pc(r.ret, 3)));
      main.appendChild(top);
      const track = el("div", "arena-track"), fillb = el("i", r.ret >= 0 ? "pos" : "neg");
      fillb.style.width = Math.max(2, Math.abs(r.ret) / maxAbs * 50) + "%"; fillb.style[r.ret >= 0 ? "left" : "right"] = "50%";
      track.appendChild(fillb); main.appendChild(track);
      main.appendChild(el("div", "small arena-meta", r.tf + " · проти «тримати»: " + pc(r.vs, 3) + " · угод: " + r.st.trades + " · " + (r.st.open.length ? "у позиції: " + r.st.open.length + " монет" : "у готівці")));
      card.appendChild(main);
      list.appendChild(card);
    });
    wrap.appendChild(list);
    box.appendChild(wrap);
    arenaChart(chartBox, ro, rows);

    const lines = [];
    rows.filter(function (r) { return r.inv && r.pair; }).forEach(function (r) {
      const base = rows.filter(function (x) { return x.id === r.pair; })[0];
      if (!base) return;
      const gap = base.ret - r.ret;
      lines.push("«" + base.title + "»: за сигналом " + pc(base.ret, 3) + ", навпаки " + pc(r.ret, 3) + (Math.abs(gap) < 0.1 ? " (різниця майже непомітна)" : gap > 0 ? " (за сигналом краще)" : " (навпаки краще)"));
    });
    const rnd = rows.filter(function (r) { return r.def.kind === "random"; })[0];
    if (rnd) lines.push("випадковий бот-контроль: " + pc(rnd.ret, 3) + " (якщо правила не перевершують його, їхні сигнали нічого не додають)");
    document.getElementById("paperVerdict").textContent = lines.length ? "Контроль: " + lines.join("; ") + ". Занадто короткий період для висновків: чекайте повних 7 днів." : "";
  }

  // ---------- Усі денні правила для вибраної монети й періоду ----------
  function renderStratTable(sym, p) {
    const c = sim.coins[sym], box = document.getElementById("simStratTable");
    const t = el("table", "agent-table"), head = el("tr");
    ["Правило", "Підсумок", "«Просто тримати»", "Різниця", "Просідання", "Краще за випадкові", "Угод"].forEach(function (x) { head.appendChild(el("th", "", x)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    sim.strategies.filter(function (s) { return s.tf === "1d" && c.strategies[s.id]; }).map(function (s) {
      return { s: s, m: c.strategies[s.id][p] };
    }).sort(function (a, b) { return b.m.ret - a.m.ret; }).forEach(function (x, i) {
      const tr = el("tr", i === 0 ? "rank-strong" : "");
      const name = el("td", "", x.s.title);
      if (x.s.invert) name.appendChild(el("span", "rank-tag down", "обернене"));
      tr.appendChild(name);
      tr.appendChild(el("td", cls(x.m.ret), pc(x.m.ret, 1)));
      tr.appendChild(el("td", cls(x.m.hold), pc(x.m.hold, 1)));
      tr.appendChild(el("td", cls(x.m.ret - x.m.hold), pc(x.m.ret - x.m.hold, 1)));
      tr.appendChild(el("td", "tone-negative", pc(x.m.dd, 1)));
      tr.appendChild(el("td", "", x.m.beat + "%"));
      tr.appendChild(el("td", "", String(x.m.trades)));
      body.appendChild(tr);
    });
    t.appendChild(body);
    box.replaceChildren(t);
  }

  // ---------- Історія: що було б у минулому ----------
  const hCoin = document.getElementById("simCoin"), hStrat = document.getElementById("simStrategy"), hCap = document.getElementById("simCapital");
  const hPeriods = document.getElementById("simPeriods");
  let period = "365";

  function periodLabel(p) { return p === "0" ? "Вся історія" : p + " днів"; }

  function renderHistory() {
    if (!sim) return;
    const sym = hCoin.value, sid = hStrat.value, cap = parseFloat(hCap.value), c = sim.coins[sym];
    if (!c) return;
    const m = c.strategies[sid][period], hold = c.hold[period];
    const rule = sim.strategies.filter(function (s) { return s.id === sid; })[0];
    if (!rule || !c.strategies[sid]) return;

    hPeriods.replaceChildren();
    sim.periods.map(String).forEach(function (p) {
      const b = el("button", "ct-btn" + (p === period ? " active" : ""), periodLabel(p));
      b.type = "button"; b.setAttribute("aria-pressed", p === period ? "true" : "false");
      b.setAttribute("data-help", "Період симуляції: " + (p === "0" ? "усі дні, що є в історії" : "останні " + p + " днів"));
      b.addEventListener("click", function () { period = p; renderHistory(); });
      hPeriods.appendChild(b);
    });

    renderStratTable(sym, period);
    const better = m.ret > m.hold;
    const tiles = document.getElementById("simTiles");
    tiles.replaceChildren();
    function tile(title, big, sub, help, c2) {
      const t = el("div", "ov-tile");
      const h = el("h3", "ov-title", title); if (help) h.appendChild(Help.icon(help));
      t.appendChild(h); t.appendChild(el("b", "out-big " + (c2 || ""), big));
      if (sub) t.appendChild(el("span", "small", sub));
      tiles.appendChild(t);
    }
    tile("Правило: підсумок", usd(cap * (1 + m.ret / 100)), pc(m.ret) + " за " + m.days + " днів", rule.help, cls(m.ret));
    tile("«Просто тримати»", usd(cap * (1 + m.hold / 100)), pc(m.hold) + (better ? ", правило краще" : ", правило гірше"), "Купити монету на початку й нічого не робити.", cls(m.hold));
    tile("Проти випадковості", "краще за " + m.beat + "%", "випадкових симуляцій; їхня медіана " + pc(m.rnd_med), "Те саме число днів у ринку, але в випадкові дні. Якщо правило краще за 90 % випадкових, воно, ймовірно, щось ловить; біля 50 % це схоже на удачу.");
    tile("Найгірше просідання", pc(m.dd, 1), "«просто тримати»: " + pc(m.hold_dd, 1), "Найбільше падіння рахунку від піку до дна за період.", "tone-negative");
    tile("Угоди", String(m.trades), "прибуткових: " + m.wins + " із " + m.rounds + " · у ринку " + m.time + "% часу", "Кожна купівля чи продаж із комісією " + (sim.fee * 100).toLocaleString("uk-UA") + "%.");

    curves(document.getElementById("simChart"), document.getElementById("simReadout"), m.eq, hold, ["правило", "«просто тримати»"], m.marks,
      function (i) { return "день " + Math.round(i / (m.eq.length - 1) * m.days) + " із " + m.days; });

    // таблиця за всіма монетами
    const t = el("table", "agent-table"), head = el("tr");
    ["Монета", "Правило", "«Просто тримати»", "Різниця", "Краще за випадкові", "Угод"].forEach(function (x) { head.appendChild(el("th", "", x)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    Object.keys(sim.coins).forEach(function (s) {
      const r = sim.coins[s].strategies[sid][period], tr = el("tr", r.ret > r.hold ? "rank-strong" : "");
      const nb = el("button", "link-btn", s); nb.type = "button";
      nb.addEventListener("click", function () { hCoin.value = s; renderHistory(); window.scrollTo({ top: document.getElementById("history").offsetTop, behavior: "smooth" }); });
      tr.appendChild(el("td")).appendChild(nb);
      tr.appendChild(el("td", cls(r.ret), pc(r.ret, 1)));
      tr.appendChild(el("td", cls(r.hold), pc(r.hold, 1)));
      tr.appendChild(el("td", cls(r.ret - r.hold), pc(r.ret - r.hold, 1)));
      tr.appendChild(el("td", "", r.beat + "%"));
      tr.appendChild(el("td", "", String(r.trades)));
      body.appendChild(tr);
    });
    t.appendChild(body);
    document.getElementById("simTable").replaceChildren(t);
  }

  [hCoin, hStrat, hCap].forEach(function (s) { s.addEventListener("change", renderHistory); });
  pStrat.addEventListener("change", function () { renderPaper(true); renderDecisions(); });


  // ---------- Журнал рішень бота: що купив, коли, чому і на що спирався ----------
  let evts = {}, evtsAll = {}, trader = null;
  const decSource = document.getElementById("decSource"), decCoin = document.getElementById("decCoin"), decSide = document.getElementById("decSide");
  const IND_HELP = {
    price: "Ціна закриття свічки, на якій ухвалено рішення", sma50: "Середня ціна за останні 50 свічок: короткий тренд",
    sma200: "Середня ціна за останні 200 свічок: довгий тренд", rsi: "RSI від 0 до 100: вище 70 «перегрів», нижче 30 «розпродаж»",
    macd: "Імпульс (MACD): вгору чи вниз", mom30: "Зміна ціни за 30 свічок", score: "Оцінка сигналу від −100 до +100",
  };

  function ruleTitle(id) { return (sim.strategies.filter(function (s) { return s.id === id; })[0] || { title: id }).title; }
  function ruleDef(id) { return sim.strategies.filter(function (s) { return s.id === id; })[0] || {}; }
  function qtyOf(e, cap) { return cap * (e.w || 1 / Math.max(1, sim.paper.coins.length)) * e.eq * (1 - (sim.paper.fee || 0)) / e.price; }
  function qfmt(q) { return q.toLocaleString("uk-UA", { maximumFractionDigits: q >= 100 ? 2 : q >= 1 ? 4 : 6 }); }
  function pxfmt(p) { return p.toLocaleString("uk-UA", { maximumFractionDigits: p >= 100 ? 2 : p >= 1 ? 4 : 6 }) + " $"; }
  function when(ms) { return new Date(ms).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }

  function currentEvents() {
    const id = pStrat.value || sim.strategies[0].id;
    return (evts[id] || []).slice().sort(function (a, b) { return b.candle - a.candle; });
  }

  // Закриті угоди правила: пари «купівля → продаж» по кожній монеті
  function roundTrips(list) {
    const trips = [], open = {};
    list.slice().sort(function (a, b) { return a.candle - b.candle; }).forEach(function (e) {
      if (e.side === "BUY") open[e.coin] = e;
      else if (open[e.coin]) {
        const b = open[e.coin], fee = sim.paper.fee || 0;
        trips.push({ coin: e.coin, pl: (e.eq / (b.eq * (1 - fee)) - 1) * 100, buy: b, sell: e });
        delete open[e.coin];
      }
    });
    return trips;
  }

  function renderDecisions() {
    if (!sim || !sim.paper) return;
    const id = pStrat.value || sim.strategies[0].id, cap = activeCap || sim.paper.accounts[Math.min(1, sim.paper.accounts.length - 1)], st = sim.paper.strategies[id];
    if (!decCoin.options.length || decCoin.options.length === 1) {
      sim.paper.coins.forEach(function (c) { const o = el("option", "", c); o.value = c; decCoin.appendChild(o); });
    }
    const list = currentEvents();

    // -- позиції зараз --
    const openBox = document.getElementById("decOpen");
    if (st && st.open.length) {
      const t = el("table", "agent-table"), head = el("tr");
      ["Монета", "Кількість", "Куплено за", "Зараз", "Вартість", "Результат"].forEach(function (x) { head.appendChild(el("th", "", x)); });
      t.appendChild(el("thead")).appendChild(head);
      const body = el("tbody");
      st.open.forEach(function (c) {
        const buy = list.filter(function (e) { return e.coin === c && e.side === "BUY"; })[0], px = live[c] || st.state[c][3], tr = el("tr");
        const nb = el("button", "link-btn", c); nb.type = "button";
        nb.setAttribute("data-help", "Відкрити біржовий графік " + c);
        nb.addEventListener("click", function () { ChartTool.open({ symbol: c, name: c }); });
        tr.appendChild(el("td")).appendChild(nb);
        if (buy) {
          const q = qtyOf(buy, cap), ch = (px / buy.price - 1) * 100;
          tr.appendChild(el("td", "", qfmt(q) + " " + c));
          tr.appendChild(el("td", "", pxfmt(buy.price) + " · " + when(buy.candle)));
          tr.appendChild(el("td", "", pxfmt(px)));
          tr.appendChild(el("td", "", usd(q * px)));
          tr.appendChild(el("td", cls(ch), pc(ch, 2) + " (" + (ch >= 0 ? "+" : "−") + usd(Math.abs(q * px - q * buy.price)) + ")"));
        } else {
          tr.appendChild(el("td", "small", "куплено до початку журналу"));
          ["", "", "", ""].forEach(function () { tr.appendChild(el("td", "", "")); });
        }
        body.appendChild(tr);
      });
      t.appendChild(body);
      openBox.replaceChildren(t);
    } else {
      openBox.replaceChildren(el("p", "muted", "Зараз правило тримає гроші в готівці: жодної позиції немає."));
    }

    // -- статистика закритих угод --
    const trips = roundTrips(list), stats = document.getElementById("decStats");
    stats.replaceChildren();
    function tile(title, big, sub, c2) {
      const d = el("div", "ov-tile");
      d.appendChild(el("h3", "ov-title", title)); d.appendChild(el("b", "out-big " + (c2 || ""), big));
      if (sub) d.appendChild(el("span", "small", sub));
      stats.appendChild(d);
    }
    if (trips.length) {
      const wins = trips.filter(function (x) { return x.pl > 0; }).length, avg = trips.reduce(function (a, x) { return a + x.pl; }, 0) / trips.length;
      const best = trips.reduce(function (a, x) { return x.pl > a.pl ? x : a; }), worst = trips.reduce(function (a, x) { return x.pl < a.pl ? x : a; });
      tile("Закритих угод", String(trips.length), "прибуткових: " + wins + " (" + Math.round(100 * wins / trips.length) + "%)");
      tile("Середній результат угоди", pc(avg, 2), "з урахуванням комісії", cls(avg));
      tile("Найкраща угода", pc(best.pl, 2), best.coin + ", " + when(best.sell.candle), cls(best.pl));
      tile("Найгірша угода", pc(worst.pl, 2), worst.coin + ", " + when(worst.sell.candle), cls(worst.pl));
    } else {
      tile("Закритих угод", "0", "ще не було повного циклу «купівля → продаж»");
    }
    tile("Усього рішень у журналі", String(list.length), "купівель: " + list.filter(function (e) { return e.side === "BUY"; }).length);

    // -- журнал --
    const box = document.getElementById("decList");
    box.replaceChildren();
    const testnet = decSource.value === "testnet";
    let items;
    if (testnet) {
      items = ((trader && trader.configured && trader.orders) || []).map(function (o) {
        return { when: new Date(o.t).getTime(), coin: o.coin, side: o.side, price: o.fill && o.fill.avg ? o.fill.avg : o.price, rule: trader.strategy, tf: "",
                 reason: o.reason, ind: o.ind, ctx: o.ctx, fill: o.fill, usd: o.usdt, candle: o.candle };
      });
      if (!items.length) { box.appendChild(el("p", "muted", trader && trader.configured ? "Бот на тестовій біржі ще не робив ордерів." : "Тестову біржу ще не підключено: див. розділ вище.")); }
    } else {
      items = list.map(function (e) {
        return { when: e.candle, coin: e.coin, side: e.side, price: e.price, rule: e.rule, tf: e.tf, reason: e.reason, ind: e.ind, ctx: e.ctx, qty: qtyOf(e, cap), usd: qtyOf(e, cap) * e.price, candle: e.candle };
      });
      if (!items.length) { box.appendChild(el("p", "muted", "Це правило ще не купувало й не продавало: рішень у журналі немає.")); }
    }
    items = items.filter(function (x) { return (!decCoin.value || x.coin === decCoin.value) && (!decSide.value || x.side === decSide.value); });
    window.__decItems = items;
    items.slice(0, 60).forEach(function (x) {
      const card = el("article", "dec-card " + (x.side === "BUY" ? "buy" : "sell"));
      const head = el("div", "dec-head");
      head.appendChild(el("span", "dec-side " + (x.side === "BUY" ? "buy" : "sell"), x.side === "BUY" ? "КУПІВЛЯ" : "ПРОДАЖ"));
      head.appendChild(el("b", "", x.coin));
      head.appendChild(el("span", "small", pxfmt(x.price)));
      head.appendChild(el("span", "small dec-when", when(x.when)));
      card.appendChild(head);
      const money = x.fill && x.fill.qty
        ? "Фактично виконано: " + qfmt(x.fill.qty) + " " + x.coin + " за середньою ціною " + pxfmt(x.fill.avg) + ", сума " + usd(x.fill.quote) +
          (Object.keys(x.fill.fees || {}).length ? ", комісія " + Object.keys(x.fill.fees).map(function (k) { return qfmt(x.fill.fees[k]) + " " + k; }).join(", ") : "")
        : x.qty ? "На рахунку " + usd(cap) + ": ≈ " + qfmt(x.qty) + " " + x.coin + " на суму ≈ " + usd(x.usd) : "";
      if (money) card.appendChild(el("p", "dec-money", money));
      const rd = x.rule ? ruleDef(x.rule) : {};
      const why = el("p", "dec-why");
      why.appendChild(el("b", "", "Чому: "));
      why.appendChild(document.createTextNode(x.reason || "—"));
      card.appendChild(why);
      if (x.rule) card.appendChild(el("p", "small", "Правило: " + ruleTitle(x.rule) + (x.tf ? " · свічки: " + ({ "1d": "1 день", "1h": "1 година", "15m": "15 хвилин" }[x.tf] || x.tf) : "")));
      if (x.ind) {
        const chips = el("div", "dec-chips");
        chips.appendChild(el("span", "small", "На що спирався: "));
        const spec = [["price", "Ціна " + pxfmt(x.ind.price)], ["sma50", "Середня 50: " + pxfmt(x.ind.sma50)], ["sma200", "Середня 200: " + pxfmt(x.ind.sma200)],
          ["rsi", "RSI " + Math.round(x.ind.rsi)], ["macd", "MACD " + (x.ind.macd > 0 ? "вгору" : "вниз")], ["mom30", "30 свічок: " + pc(x.ind.mom30, 1)], ["score", "Оцінка " + x.ind.score]];
        spec.forEach(function (s) {
          if (rd.kind === "sma50" && !["price", "sma50"].includes(s[0])) return;       // правило тренду дивиться лише на ціну й середню
          const c = el("span", "chip", s[1]); c.tabIndex = 0; c.setAttribute("data-help", IND_HELP[s[0]]); chips.appendChild(c);
        });
        card.appendChild(chips);
      }
      if (x.ctx) {
        const ctx = el("p", "dec-ctx small");
        ctx.appendChild(document.createTextNode("Для довідки (правило цього не враховує): загальний фон по " + x.coin + " — " + x.ctx.label.toLowerCase() + " (" + (x.ctx.score > 0 ? "+" : "") + x.ctx.score + ")"));
        if (x.ctx.headline) {
          ctx.appendChild(document.createTextNode("; свіжа новина: "));
          const a = el("a", "", x.ctx.headline); a.href = x.ctx.link || "#"; a.target = "_blank"; a.rel = "noopener noreferrer"; ctx.appendChild(a);
        }
        card.appendChild(ctx);
      }
      box.appendChild(card);
    });
  }

  function csvDecisions() {
    const rows = [["час", "джерело", "правило", "монета", "дія", "ціна", "кількість", "сума", "причина"]];
    if (decSource.value === "paper") {
      const id = pStrat.value || sim.strategies[0].id, cap = activeCap || sim.paper.accounts[Math.min(1, sim.paper.accounts.length - 1)];
      rows.length = 0;
      rows.push(["№", "правило", "гаманець $", "монета", "стан", "куплено", "продано", "утримання, хв", "ціна купівлі", "ціна продажу", "сума $", "результат %", "результат $", "витрати $", "причина купівлі", "причина продажу"]);
      buildTrades(id, cap).forEach(function (t) {
        const b = t.kind === "start" ? t.items[0].e : t.buy;
        rows.push([t.n, id, cap, t.coin, t.kind === "start" ? "старт раунду" : t.kind === "pair" ? "закрито" : "відкрито", new Date(t.kind === "start" ? t.ts : b.candle).toISOString(),
          t.kind === "pair" ? new Date(t.sell.candle).toISOString() : "", t.kind === "pair" ? Math.round(t.held / 60000) : "", t.kind === "start" ? "" : b.price, t.kind === "pair" ? t.sell.price : "",
          t.sum.toFixed(2), t.pl === null ? "" : t.pl.toFixed(3), t.usd === null ? "" : t.usd.toFixed(2), t.costs.toFixed(2), b.reason || "", t.kind === "pair" ? (t.sell.reason || "") : ""]);
      });
    }
    (decSource.value === "paper" ? [] : (window.__decItems || [])).forEach(function (x) {
      rows.push([new Date(x.when).toISOString(), decSource.value, x.rule || "", x.coin, x.side, x.price, x.fill && x.fill.qty ? x.fill.qty : (x.qty || ""), (x.fill && x.fill.quote) || (x.usd ? x.usd.toFixed(2) : ""), x.reason || ""]);
    });
    const text = "\ufeff" + rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = "zhurnal-rishen.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  [decSource, decCoin, decSide].forEach(function (s) { s.addEventListener("change", renderDecisions); });
  document.getElementById("decCsv").addEventListener("click", csvDecisions);

  // ---------- Тестова біржа (Binance Testnet) ----------
  async function renderTrader() {
    const setup = document.getElementById("trSetup"), tiles = document.getElementById("trTiles"), orders = document.getElementById("trOrders");
    let t;
    try { t = await loadJson("data/trader.json"); trader = t; } catch (e) { setup.replaceChildren(el("p", "muted", "Дані тестової біржі ще не створено.")); return; }
    setup.replaceChildren(); tiles.replaceChildren(); orders.replaceChildren();
    if (!t.configured) {
      const box = el("div", "agent-card");
      box.appendChild(el("h3", "agent-sub", "Як увімкнути (безкоштовно, ненастоящі гроші)"));
      const ol = el("ol", "steps");
      ["Відкрийте testnet.binance.vision і увійдіть через GitHub.",
       "Створіть ключ: «Generate HMAC_SHA256 Key». Ключ і секрет покажуть один раз.",
       "На GitHub: Settings → Secrets and variables → Actions → New repository secret. Додайте BINANCE_TESTNET_API_KEY і BINANCE_TESTNET_API_SECRET.",
       "Actions → «Оновлення даних і публікація» → Run workflow. Бот почне торгувати на тестовому рахунку."].forEach(function (x) { ol.appendChild(el("li", "", x)); });
      box.appendChild(ol);
      box.appendChild(el("p", "small", "Ключі вставляйте тільки в секрети GitHub: не пишіть їх у чат і не кладіть у файли сайту. Ключі від справжньої біржі сюди не потрібні й не підходять."));
      setup.appendChild(box);
      return;
    }
    function tile(title, big, sub, c2) {
      const d = el("div", "ov-tile");
      d.appendChild(el("h3", "ov-title", title));
      d.appendChild(el("b", "out-big " + (c2 || ""), big));
      if (sub) d.appendChild(el("span", "small", sub));
      tiles.appendChild(d);
    }
    tile("Тестовий рахунок", usd(t.equity), "старт " + usd(t.start_equity) + " · з " + new Date(t.since).toLocaleDateString("uk-UA"));
    tile("Результат бота", pc(t.ret, 3), "віртуальна симуляція того ж правила: " + pc(t.paper_ret, 3), cls(t.ret));
    tile("Позиції", Object.keys(t.positions).length ? Object.keys(t.positions).join(", ") : "готівка", "USDT вільно: " + usd(t.usdt));
    tile("Ордерів", String(t.orders_total), "правило: " + (sim ? (sim.strategies.filter(function (s) { return s.id === t.strategy; })[0] || {}).title : t.strategy));
    if (t.orders.length) {
      const tb = el("table", "agent-table"), head = el("tr");
      ["Час", "Дія", "Монета", "Сума", "Ціна", "Статус"].forEach(function (x) { head.appendChild(el("th", "", x)); });
      tb.appendChild(el("thead")).appendChild(head);
      const body = el("tbody");
      t.orders.forEach(function (o) {
        const tr = el("tr");
        tr.appendChild(el("td", "small", new Date(o.t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
        tr.appendChild(el("td", o.side === "BUY" ? "tone-positive" : "tone-negative", o.side === "BUY" ? "купівля" : "продаж"));
        tr.appendChild(el("td", "", o.coin));
        tr.appendChild(el("td", "", usd(o.usdt)));
        tr.appendChild(el("td", "", usd(o.price)));
        tr.appendChild(el("td", "small", o.status || ""));
        body.appendChild(tr);
      });
      tb.appendChild(body);
      orders.appendChild(tb);
    }
  }

  // ---------- Агент ----------
  async function renderAgent() {
    const box = document.getElementById("simAgentCard");
    let agents = null;
    try { agents = await loadJson("data/agents.json"); } catch (e) { /* статус необов'язковий */ }
    const st = agents && agents.agents ? agents.agents.simulation : null, state = agentState(st);
    box.replaceChildren();
    const head = el("div", "agent-head");
    head.appendChild(el("h3", "agent-name", st ? st.title : "Симуляція торгівлі"));
    head.appendChild(el("span", "chip " + state, { ok: "Працює", stale: "Дані застаріли", failed: "Помилка", none: "Немає даних" }[state]));
    box.appendChild(head);
    box.appendChild(el("p", "small", st && st.last_ok ? "Останній запуск " + ago(st.last_ok) + " · розрахунок на історії " + (sim ? ago(sim.computed_at) : "—") + " · запуски кожні ~10 хв (GitHub)" : "Ще не запускався"));
    if (sim) {
      const ul = el("ul", "insights");
      sim.insights.forEach(function (x) {
        const li = el("li", "insight " + x.tone);
        li.appendChild(el("span", "insight-mark", x.tone === "negative" ? "▼" : x.tone === "positive" ? "▲" : "●"));
        li.appendChild(document.createTextNode(x.text));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    const links = el("p", "small");
    [["data/simulation.json", "Дані агента"], ["knowledge/simulation.json", "База знань (правила, комісія, суми)"], ["agents.html#simulation", "Вкладка агента"]].forEach(function (x, i) {
      if (i) links.appendChild(document.createTextNode(" · "));
      const a = el("a", "", x[1]); a.href = x[0]; links.appendChild(a);
    });
    box.appendChild(links);
  }

  // ---------- Живі ціни Binance: оцінка рахунків щосекунди ----------
  function connect() {
    const all = {};
    [paperRaw].concat(Object.keys((paperRaw && paperRaw.wallets) || {}).map(function (k) { return paperRaw.wallets[k]; })).forEach(function (P) {
      if (!P) return;
      const f = Object.keys(P.strategies)[0];
      if (f) Object.keys(P.strategies[f].state).forEach(function (c) { all[c] = 1; });
    });
    const syms = Object.keys(all).sort();
    if (!syms.length || syms.join() === boundSyms) return;
    boundSyms = syms.join();
    if (socket) { socket.onclose = null; try { socket.close(); } catch (e) { /* закрито */ } }
    try { socket = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + syms.map(function (s) { return s.toLowerCase() + "usdt@miniTicker"; }).join("/")); } catch (e) { return; }
    socket.onopen = function () { delay = 5000; };
    socket.onmessage = function (ev) {
      try { const d = JSON.parse(ev.data).data; live[d.s.replace(/USDT$/, "")] = parseFloat(d.c); } catch (e) { /* пошкоджене повідомлення */ }
    };
    socket.onclose = function () { boundSyms = ""; setTimeout(function () { if (sim) connect(); }, delay); delay = Math.min(delay * 2, 60000); };
  }

  async function refresh() {
    try {
      const d = await loadJson("data/simulation.json");
      if (d.generated_at === last) return;
      last = d.generated_at;
      if (!hist || hist.computed_at !== d.computed_at) hist = await loadJson("data/simulation_history.json");   // важка історична частина змінюється рідко
      d.coins = hist.coins;
      const first = !sim;
      sim = d;
      if (first || !pStrat.options.length) {
        const TF = { "1d": "щодня", "1h": "щогодини", "15m": "кожні 15 хв" };
        fill(pStrat, d.strategies.map(function (s) { return [s.id, s.title + " · рішення " + (TF[s.tf] || s.tf)]; }));
        fill(hStrat, d.strategies.filter(function (s) { return s.tf === "1d"; }).map(function (s) { return [s.id, s.title]; }));
        fill(hCoin, Object.keys(d.coins).map(function (s) { return [s, s]; }), "BTC");
      }
      paperRaw = d.paper;
      evtsAll = {};
      try { evtsAll[paperRaw.cap] = await loadJson("data/paper_events.json"); } catch (e) { evtsAll[paperRaw.cap] = {}; }
      for (const k of Object.keys(paperRaw.wallets || {})) {
        try { evtsAll[parseInt(k, 10)] = await loadJson("data/paper_events_" + k + ".json"); } catch (e) { evtsAll[parseInt(k, 10)] = {}; }
      }
      applyWallet();
      if (first) {                                           // за замовчуванням показуємо правило з посилання (?rule=) або з найбільшою активністю
        const want = new URLSearchParams(location.search).get("rule");
        const busiest = Object.keys(evts).sort(function (x, y) { return evts[y].length - evts[x].length; })[0];
        const pick = [want, busiest].filter(function (id) { return id && sim.paper.strategies[id]; })[0];
        if (pick) pStrat.value = pick;
      }
      connect();
      renderPaper(true); renderBoard(); renderRounds(); renderHistory(); renderAgent(); renderTrader().then(renderDecisions);
    } catch (e) {
      paperTiles.replaceChildren(el("p", "note", "Немає даних"));
    }
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(function () { if (!document.hidden && sim) { renderPaper(false); renderBoard(); } }, 1000);      // суми й таблиця лідерів за живою ціною щосекунди
  setInterval(function () {                                                                  // кожні 5 секунд: нова точка сліду й оновлення графіка
    if (document.hidden || !sim || !sim.paper) return;
    sim.paper.accounts.forEach(function (cap) {
      const P = walletData(cap);
      Object.keys(P.strategies).forEach(function (id) {
        const m = liveMarks(id, P);
        if (!m.live) return;
        const arr = trail[cap + "|" + id] = trail[cap + "|" + id] || [];
        arr.push([new Date().toISOString(), m.eq, m.hold]);
        if (arr.length > 800) arr.shift();
      });
    });
    renderPaper(true);
  }, 5000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
