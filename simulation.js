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
  const coinOpen = {}, seenFeed = {}, feedOpen = {}, feedCfg = { side: "", coin: "", sort: "new", limit: 1000 };
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

  // Оновлює наявні вузли на місці, а не замінює їх: так клік не «втрачається», коли дані оновились у момент натискання
  function morph(o, n) {
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return false;
    if (o.nodeType === 3 || o.nodeType === 8) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return true; }
    Array.prototype.slice.call(o.attributes).forEach(function (a) { if (!n.hasAttribute(a.name)) o.removeAttribute(a.name); });
    Array.prototype.slice.call(n.attributes).forEach(function (a) { if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value); });
    if (!o.hasAttribute("data-keep")) morphKids(o, n);                       // вбудований графік живе власним життям: не перебудовуємо його вміст
    return true;
  }
  function morphKids(o, n) {
    const oc = Array.prototype.slice.call(o.childNodes), nc = Array.prototype.slice.call(n.childNodes), m = Math.min(oc.length, nc.length);
    for (let i = 0; i < m; i++) if (!morph(oc[i], nc[i])) o.replaceChild(nc[i], oc[i]);
    for (let i = m; i < nc.length; i++) o.appendChild(nc[i]);
    for (let i = oc.length - 1; i >= m; i--) o.removeChild(oc[i]);
  }
  function mountFeed(box) {
    const wf = document.getElementById("walletFeed");
    if (feedBar.parentNode !== wf) wf.insertBefore(feedBar, wf.firstChild);
    let fb = document.getElementById("feedBody");
    if (!fb) { fb = el("div", ""); fb.id = "feedBody"; wf.appendChild(fb); }
    const tmp = document.createElement("div"); tmp.appendChild(box); morphKids(fb, tmp);
  }

  function feedToolbar() {
    if (feedBar) return;
    feedBar = el("div", "sim-feed-bar");
    const chips = [];
    [["", "Усі"], ["open", "Відкриті"], ["closed", "Закриті"], ["win", "Прибуткові"], ["loss", "Збиткові"], ["flap", "«Смикання»"]].forEach(function (x) {
      const b = el("button", "feed-chip" + (feedCfg.side === x[0] ? " on" : ""), x[1]); b.type = "button"; b.setAttribute("aria-pressed", feedCfg.side === x[0] ? "true" : "false");
      b.title = { "": "Усі угоди", open: "Угоди, що ще відкриті", closed: "Завершені угоди (купівля й продаж)", win: "Закриті з прибутком після витрат", loss: "Закриті зі збитком", flap: "Повторний вхід майже одразу після продажу" }[x[0]];
      b.addEventListener("click", function () {
        feedCfg.side = x[0];
        chips.forEach(function (c) { const on = c === b; c.classList.toggle("on", on); c.setAttribute("aria-pressed", on ? "true" : "false"); });
        renderPaper(false);
      });
      chips.push(b); feedBar.appendChild(b);
    });
    const so = el("button", "feed-chip sort", feedCfg.sort === "new" ? "Спочатку нові ↓" : "Спочатку старі ↑"); so.type = "button"; so.title = "Порядок угод у кожній монеті";
    so.addEventListener("click", function () { feedCfg.sort = feedCfg.sort === "new" ? "old" : "new"; so.textContent = feedCfg.sort === "new" ? "Спочатку нові ↓" : "Спочатку старі ↑"; renderPaper(false); });
    feedBar.appendChild(so);
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
  const WALLETS_PAGE = document.body.classList.contains("page-wallets");
  const VIEWS = [["feed", "Угоди й рішення"], ["pos", "Позиції"], ["stats", "Статистика"],["chart", "Графік"], ["arena", "Арена ботів"], ["rounds", "Раунди"]];
  let activeView = "feed";
  function showView(v) {
    activeView = v;
    document.querySelectorAll(".wallet-pane").forEach(function (p) { p.hidden = p.getAttribute("data-view") !== v; });
    if (v === "analytics" && typeof renderAnalytics === "function" && sim) renderAnalytics();
    const bar = document.getElementById("walletViews");
    bar.replaceChildren();
    VIEWS.forEach(function (x) {
      const b = el("button", "wallet-view" + (x[0] === v ? " on" : ""), x[1]);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", x[0] === v ? "true" : "false");
      b.addEventListener("click", function () { showView(x[0]); });
      bar.appendChild(b);
    });
    const lk = el("a", "wallet-view link", "Аналітика гаманців →"); lk.href = "wallets.html"; lk.title = "Окрема сторінка: порівняння гаманців, найвигідніша угода, живий бот"; bar.appendChild(lk);
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
  showView(WALLETS_PAGE ? "analytics" : "feed");
  showSection((location.hash || "#paper").slice(1));

  // Угоди для стрічки: старт раунду згорнуто в один запис, купівля + продаж однієї монети — одна «пара» з підсумком, решта — відкриті позиції
  function buildTrades(id, cap, PW, EV) {
    const P = PW || sim.paper, E = EV || evts;
    const all = ((E && E[id]) || []).slice().sort(function (a, b) { return a.candle - b.candle; });
    pairEvents(all);
    const fee = P.fee || 0, out = [], start = [];
    function qOf(e) { return cap * (e.w || 1 / Math.max(1, P.coins.length)) * e.eq * (1 - fee) / e.price; }
    const lastSell = {}, costPct = (1 - (1 - fee) * (1 - fee)) * 100;
    all.forEach(function (e) {
      if (e.side !== "BUY") { lastSell[e.coin] = e.candle; return; }
      const q = qOf(e), isStart = String(e.reason || "").indexOf("Початкова позиція") === 0;
      const flapMs = !isStart && lastSell[e.coin] !== undefined && e.candle - lastSell[e.coin] <= 3600000 ? e.candle - lastSell[e.coin] : null;
      const sst = P.strategies[id] && P.strategies[id].state[e.coin], px = live[e.coin] || (sst ? sst[3] : null);   // запасна ціна: остання закрита свічка, поки не прийшла жива
      if (e.__sell) {
        const s = e.__sell, w = e.w || 1 / Math.max(1, P.coins.length), usdPl = cap * w * (s.eq - e.eq);
        out.push({ rid: id, kind: "pair", coin: e.coin, buy: e, sell: s, q: q, ts: s.candle, sum: q * e.price, pl: (s.eq / (e.eq * (1 - fee)) - 1) * 100, usd: usdPl,
          costs: q * e.price * fee + q * s.price * fee, held: s.candle - e.candle, costPct: costPct, flapMs: flapMs });
      } else {
        out.push({ rid: id, kind: "open", isStart: isStart, coin: e.coin, buy: e, q: q, ts: e.candle, sum: q * e.price, pl: px ? (px / e.price - 1) * 100 : null, usd: px ? q * (px - e.price) : null, costs: q * e.price * fee, costPct: costPct, flapMs: flapMs });
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
    if (d.kind === "setup") {
      if (d.mode === "dip") out.push("одразу, коли ціна зростає на " + (d.take || 0) + "% (тейк-профіт) або падає на " + (d.stop || 0) + "% (стоп-лос) від купівлі");
      else out.push("одразу, коли спрацює один із виходів: стоп-лос −" + (d.stop || 0) + "%, тейк-профіт +" + (d.take || 0) + "%" + (d.trail ? ", трейлінг-стоп " + d.trail + "% від максимуму" : "") + " або ціна опуститься нижче 15-хвилинної середньої");
    } else if (d.kind === "random") out.push("випадково: на кожній закритій свічці є ≈" + Math.round((d.p_exit || 0.1) * 100) + "% шанс вийти (це контрольний бот без індикаторів)");
    else if (d.kind === "sma50") out.push(d.invert ? "коли ціна закриття " + tf + "-свічки підніметься вище середньої за 50 свічок" + (ind.sma50 ? " (при купівлі середня була " + pxfmt(ind.sma50) + ")" : "")
      : "коли ціна закриття " + tf + "-свічки опуститься нижче середньої за 50 свічок" + (ind.sma50 ? " (при купівлі середня була " + pxfmt(ind.sma50) + ")" : ""));
    else if (typeof d.exit === "number") out.push(d.invert ? "коли оцінка сигналу підніметься вище " + (-d.exit) + " (при купівлі: " + Math.round(ind.score || 0) + ")" : "коли оцінка сигналу впаде нижче " + d.exit + " (при купівлі: " + Math.round(ind.score || 0) + ")");
    if (d.stop && d.kind !== "setup") out.push("стоп-лос: якщо ціна впаде до " + pxfmt(e.price * (1 - d.stop / 100)) + " (−" + d.stop + "%)");
    if (d.take && d.kind !== "setup") out.push("тейк-профіт: якщо ціна зросте до " + pxfmt(e.price * (1 + d.take / 100)) + " (+" + d.take + "%)");
    return { text: out, check: d.kind === "setup" ? "при кожному запуску бота (≈ кожні 10 хв), без очікування закриття свічки" : (TF_CHECK[e.tf] || e.tf) };
  }

  function dur(ms) {
    const m = Math.round(ms / 60000);
    return m < 60 ? m + " хв" : m < 2880 ? (m / 60).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " год" : (m / 1440).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " дн";
  }
  function money(v) { return (v >= 0 ? "+" : "−") + usd(Math.abs(v)); }

  // ---------- Розгорнута угода: анімований графік ціни наживо, цілі виходу й результат ----------
  const klCache = {};                                        // свічки Binance для пояснення: {"BNB|1h": {at, data}}
  const tcDrawn = {}, tcHover = {}, tcCharts = {};                          // для яких угод анімацію появи вже показано; стан курсора між оновленнями
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
    // інтерактивний графік біржового типу: свічки, об'єм, MA, BOLL, RSI, лінії, тренд, Фібоначчі, лінійка; B/S — купівля й продаж
    const levels = [{ price: e.price, color: "#2ebd85", label: "ціна купівлі" }];
    targets.forEach(function (g) { if (g.key !== "sma") levels.push({ price: g.price, color: g.key === "take" ? "#2ebd85" : g.key === "stop" ? "#f6465d" : "#848e9c", label: g.key === "be" ? "беззбитковість" : g.key === "take" ? "тейк-профіт" : "стоп-лос" }); });
    if (t.kind === "pair") levels.push({ price: t.sell.price, color: "#f6465d", label: "ціна продажу" });
    const markers = [{ t: e.candle, price: e.price, side: "BUY", label: "Купівля " + pxfmt(e.price) }];
    if (t.kind === "pair") markers.push({ t: t.sell.candle, price: t.sell.price, side: "SELL", label: "Продаж " + pxfmt(t.sell.price) });
    const host = el("div", "tc-ct"); host.setAttribute("data-keep", "1");
    const spec = { symbol: t.coin, name: t.coin, interval: e.tf, focusT: e.candle, markers: markers, levels: levels, ind: { ma7: false, ma25: false, ma50: true, vol: true } };
    const reg = tcCharts[key];
    if (reg && reg.host.isConnected) reg.inst.update({ levels: levels, markers: markers });
    else {
      if (reg) { try { reg.inst.close(); } catch (x) { /* вже закрито */ } }
      tcCharts[key] = { host: host, inst: ChartTool.mount(host, spec) };
    }
    box.appendChild(host);
    box.appendChild(el("p", "small muted tc-note", "Графік інтерактивний: колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути. Зверху можна змінити масштаб часу (1 хв … 1 тиждень), увімкнути MA, BOLL, RSI й об'єм; ліворуч — горизонтальні лінії, тренд, рівні Фібоначчі та лінійка. Свої лінії зберігаються в цьому браузері."));
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

  // Аналіз угоди за свічками: найкраща й найгірша точка, що віддали, що було після виходу
  function tradeAnalysis(t, d) {
    const box = el("div", "tr-ana"), e = t.buy, fee = sim.paper.fee || 0;
    box.appendChild(el("h5", "sim-feed-h5", "Аналіз угоди"));
    if (!d || !d.length) { box.appendChild(el("p", "small muted", d ? "Свічки зараз недоступні." : "Рахуємо за свічками Binance…")); return box; }
    const f = function (v) { return Math.abs(v).toLocaleString("uk-UA", { maximumFractionDigits: 2 }); };
    const i0 = d.findIndex(function (x) { return x.t >= e.candle; });
    if (i0 < 0) { box.appendChild(el("p", "small muted", "Свічки за цей період ще не завантажені.")); return box; }
    const iEnd = t.kind === "pair" ? Math.max(i0, d.findIndex(function (x) { return x.t >= t.sell.candle; })) : d.length - 1, endIdx = iEnd < 0 ? d.length - 1 : iEnd;
    const seg = d.slice(i0, endIdx + 1).map(function (x) { return x.c; }); if (live[t.coin] && t.kind !== "pair") seg.push(live[t.coin]);
    const mx = Math.max.apply(null, seg), mn = Math.min.apply(null, seg), up = (mx / e.price - 1) * 100, dn = (mn / e.price - 1) * 100;
    const tMax = d[i0 + seg.indexOf(mx)] ? d[i0 + seg.indexOf(mx)].t - e.candle : 0;
    const cells = [];
    function cell(label, value, sub, tone) { cells.push([label, value, sub, tone || ""]); }
    cell("Найкраща точка", pxfmt(mx), (up >= 0 ? "+" : "−") + f(up) + "% від купівлі, через " + dur(Math.max(0, tMax)), up > 0 ? "good" : "");
    cell("Найгірша точка", pxfmt(mn), (dn >= 0 ? "+" : "−") + f(dn) + "% від купівлі", dn < -1 ? "bad" : "");
    let conclusion;
    if (t.kind === "pair") {
      const sell = t.sell.price, gave = (mx / sell - 1) * 100, after = d.slice(endIdx + 1).map(function (x) { return x.c; }).concat(live[t.coin] ? [live[t.coin]] : []);
      cell("Вихід", pxfmt(sell), gave > 0.05 ? "віддали " + f(gave) + "% відносно найкращої точки" : "вийшли біля найкращої точки", gave > 0.8 ? "warn" : "good");
      if (after.length) {
        const aUp = (Math.max.apply(null, after) / sell - 1) * 100, aDn = (Math.min.apply(null, after) / sell - 1) * 100;
        cell("Після продажу", aUp > Math.abs(aDn) ? "ціна ще зросла" : "ціна впала", "найвище +" + f(aUp) + "%, найнижче −" + f(aDn) + "% від ціни продажу", aUp > 1.5 ? "warn" : aDn < -1.5 ? "good" : "");
        conclusion = aUp > 1.5 ? "Вийшли зарано: ціна після продажу ще зросла на " + f(aUp) + "%." : aDn < -1.5 ? "Вихід був вчасний: після нього ціна впала на " + f(aDn) + "%." : "Після виходу ціна суттєво не змінилась: вихід нейтральний.";
      }
      if (gave > 1.5 && t.pl <= 0) conclusion = "Угода була в плюсі (до +" + f(up) + "%), але не зафіксувалась: правило виходить лише за закритою свічкою. Тейк-профіт міг би це врятувати. " + (conclusion || "");
    } else {
      const now = seg[seg.length - 1], fromTop = (now / mx - 1) * 100;
      cell("Зараз", pxfmt(now), "від найкращої точки " + (fromTop >= 0 ? "+" : "−") + f(fromTop) + "% · в позиції " + dur(Date.now() - e.candle), fromTop < -1 ? "warn" : "");
      conclusion = up > 1 && t.pl !== null && t.pl < up / 2 ? "Угода вже була в плюсі до +" + f(up) + "%, зараз прибуток частково повернувся. Тейк-профіт міг би зафіксувати частину." : "Угода відкрита: результат залежить від того, коли закриється свічка біля лінії виходу.";
    }
    const g = el("div", "tr-ana-g");
    cells.forEach(function (c) { const x = el("div", "tr-an-t " + c[3]); x.appendChild(el("span", "small", c[0])); x.appendChild(el("b", "", c[1])); x.appendChild(el("span", "small", c[2])); g.appendChild(x); });
    box.appendChild(g);
    if (conclusion) box.appendChild(el("p", "tr-tip small", conclusion));
    return box;
  }

  function tradeDetails(t) {
    const ex = el("div", "sim-feed-why tc"), e = t.buy, ind = e.ind || {}, def = ruleDef(t.rid) || {};
    ex.appendChild(el("div", "sim-feed-where", (def.kind === "setup" ? "Куплено одразу за умовами (15-хвилинний графік + підтвердження годинним) · правило: " : "Куплено на " + (TF_FULL[e.tf] || e.tf) + " · правило: ") + ruleTitle(t.rid)));
    const sumRow = el("div", "tc-sum small");
    [["Кількість", qfmt(t.q) + " " + t.coin], ["Сума входу", usd(t.sum)], ["Витрати", "≈" + usd(t.costs)]].concat(t.kind === "pair" ? [["Утримання", dur(t.held)], ["Результат", pc(t.pl) + " (" + money(t.usd) + ")"]] : []).forEach(function (x) { const s = el("span", ""); s.appendChild(document.createTextNode(x[0] + ": ")); s.appendChild(el("b", "", x[1])); sumRow.appendChild(s); });
    ex.appendChild(sumRow);
    const chartBox = tradeChart(t, loadCandles(t.coin, e.tf), live[t.coin]);
    ex.appendChild(chartBox);
    ex.appendChild(tradeAnalysis(t, loadCandles(t.coin, e.tf)));
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
    pw.appendChild(document.createTextNode(t.kind === "pair" ? (t.sell.reason || "") : plan.text.join("; або ") + ". Перевірка " + plan.check + (def.kind === "setup" ? "." : ", лише за закритою свічкою.")));
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

  // Розбір однієї угоди простими словами: чому вийшов прибуток чи збиток
  function tradeVerdict(t) {
    const cp = t.costPct || 0, f1 = function (v) { return Math.abs(v).toLocaleString("uk-UA", { maximumFractionDigits: 2 }); };
    let tone, tag, text;
    if (t.kind === "pair") {
      const gross = t.pl + cp;
      if (t.pl > 0) { tone = "good"; tag = "прибуток"; text = "Ціна зросла на " + f1(gross) + "%, після витрат (≈" + f1(cp) + "%) лишилось " + f1(t.pl) + "%."; }
      else if (gross > 0) { tone = "warn"; tag = "з'їли комісії"; text = "Ціна зросла лише на " + f1(gross) + "%, а витрати ≈" + f1(cp) + "% забрали весь прибуток."; }
      else { tone = "bad"; tag = "сигнал помилився"; text = "Після купівлі ціна впала на " + f1(gross) + "% за " + dur(t.held) + ": сигнал виявився хибним." + (t.held <= 3600000 * 1.01 ? " Утримання менше години — схоже на шум." : ""); }
      if (t.flapMs !== null) text += " Купівля була через " + Math.max(1, Math.round(t.flapMs / 60000)) + " хв після попереднього продажу цієї монети: правило «смикається» біля середньої.";
    } else {
      tag = t.isStart ? "старт раунду" : "відкрито";
      if (t.pl === null) { tone = "neutral"; text = "Чекаємо живу ціну."; }
      else if (t.pl >= cp) { tone = "good"; text = "Зараз у плюсі навіть після витрат на вихід (≈" + f1(cp) + "%)."; }
      else if (t.pl > 0) { tone = "warn"; text = "Ціна вже вища за купівлю, але менше за витрати: щоб вийти в плюс, треба ще +" + f1(cp - t.pl) + "%."; }
      else { tone = "bad"; text = "Поки в мінусі: " + pc(t.pl) + "; з витратами на вихід (≈" + f1(cp) + "%) відновлення потребує ≈+" + f1(cp - t.pl) + "%."; }
      if (t.flapMs !== null) text += " Купівля через " + Math.max(1, Math.round(t.flapMs / 60000)) + " хв після попереднього продажу цієї монети.";
    }
    return { tone: tone, tag: tag, text: text };
  }

  function feedBox(id, cap) {
    feedToolbar();
    const trades = buildTrades(id, cap);
    trades.forEach(function (t) { t.v = tradeVerdict(t); });
    const box = el("div", "sim-feed");
    if (!trades.length) { box.appendChild(el("p", "sim-feed-empty", "Угод ще не було: правило чекає свого сигналу. Тут з'являтиметься кожна угода з поясненням.")); return box; }

    let items = trades.filter(function (t) {
      const f = feedCfg.side;
      return (!feedCfg.coin || t.coin === feedCfg.coin) && (!f || (f === "closed" ? t.kind === "pair" : f === "open" ? t.kind !== "pair" : f === "win" ? t.kind === "pair" && t.pl > 0 : f === "loss" ? t.kind === "pair" && t.pl <= 0 : f === "flap" ? t.flapMs !== null : true));
    });
    items.sort(function (a, b) {
      const pa = a.pl === null ? -1e9 : a.pl, pb = b.pl === null ? -1e9 : b.pl;
      return feedCfg.sort === "old" ? a.ts - b.ts : feedCfg.sort === "sum" ? b.sum - a.sum : feedCfg.sort === "pl" ? pb - pa : b.ts - a.ts;
    });
    box.appendChild(el("p", "sim-feed-count small", "Угод за фільтром: " + items.length + " · натисніть на угоду, щоб побачити графік і деталі"));
    if (!items.length) box.appendChild(el("p", "sim-feed-empty", "За цим фільтром угод немає."));
    // Кожна монета: окремий компактний блок зі своїм підсумком і своїми угодами
    const byCoin = {};
    items.forEach(function (t) { (byCoin[t.coin] = byCoin[t.coin] || []).push(t); });
    sim.paper.coins.filter(function (c) { return !feedCfg.coin || c === feedCfg.coin; }).forEach(function (coin) {
      const all = trades.filter(function (t) { return t.coin === coin; }), cl = all.filter(function (t) { return t.kind === "pair"; }), op = all.filter(function (t) { return t.kind !== "pair"; })[0];
      const rz = cl.reduce(function (a2, t) { return a2 + t.usd; }, 0), wn = cl.filter(function (t) { return t.pl > 0; }).length;
      const list = byCoin[coin] || [], sec = el("div", "tr-coin-sec"), opened = coinOpen[coin] !== false;
      const hd = el("button", "tr-coin-h"); hd.type = "button"; hd.setAttribute("aria-expanded", opened ? "true" : "false");
      hd.appendChild(el("b", "tr-coin", coin));
      hd.appendChild(el("span", "tr-tag " + (op ? "good" : ""), op ? "в позиції" : "готівка"));
      hd.appendChild(el("span", "small", live[coin] ? pxfmt(live[coin]) : ""));
      hd.appendChild(el("span", "small tr-coin-st", all.length ? "угод закритих " + cl.length + (cl.length ? " · прибуткових " + wn : "") : "угод ще не було"));
      hd.appendChild(el("span", "tr-coin-res " + (cl.length ? cls(rz) : ""), cl.length ? money(rz) : ""));
      hd.appendChild(el("span", "tr-chev", opened ? "▾" : "▸"));
      hd.setAttribute("data-coinh", coin);
      sec.appendChild(hd);
      if (opened) {
        if (!list.length) sec.appendChild(el("p", "small tr-empty", all.length ? "За цим фільтром угод немає." : "Бот ще не купував цю монету: сигналу не було."));
        list.slice(0, feedCfg.limit).forEach(function (t) {
          const key = id + "|" + cap + "|" + t.kind + "|" + t.coin + "|" + t.ts, v = t.v, open = !!feedOpen[key];
          const row = el("div", "tr-row " + v.tone + (open ? " open" : ""));
          if (!feedFirst && !seenFeed[key]) row.classList.add("new");
          seenFeed[key] = 1; t.fkey = key;
          const top = el("button", "tr-rtop"); top.type = "button"; top.setAttribute("aria-expanded", open ? "true" : "false");
          top.appendChild(el("span", "sim-feed-n", "№" + t.n));
          top.appendChild(el("span", "tr-tag " + v.tone, v.tag));
          top.appendChild(el("span", "small tr-when", t.kind === "pair" ? when(t.buy.candle) + " → " + when(t.sell.candle) + " · " + dur(t.held) : when(t.buy.candle) + " → в позиції"));
          top.appendChild(el("span", "tr-res " + (t.pl === null ? "" : cls(t.pl)), t.pl === null ? "—" : pc(t.pl) + (t.usd !== null ? " · " + money(t.usd) : "")));
          top.setAttribute("data-fk", key);
          row.appendChild(top);
          if (!open) row.appendChild(el("div", "small tr-rv", v.text));
          else { row.appendChild(el("div", "tr-verdict small", v.text)); row.appendChild(tradeDetails(t)); }
          sec.appendChild(row);
        });
      }
      box.appendChild(sec);
    });
    return box;
  }

  // ---------- Вкладка «Аналітика»: порівняння всіх гаманців для вибраного бота ----------
  const anCfg = { period: 0 };                                                        // 0 = увесь раунд, інакше кількість годин
  const AN_PERIODS = [["1 година", 1], ["6 годин", 6], ["24 години", 24], ["3 дні", 72], ["Увесь раунд", 0]];
  function anSince() { return anCfg.period ? Date.now() - anCfg.period * 3600000 : 0; }
  const WCOL = { "100": "#44707f", "1000": "#c28a3a", "10000": "#8a6fa8" };
  const f2 = function (v) { return v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }); };

  function wAnalyze(id, cap) {
    const P = walletData(cap), E = evtsAll[cap] || {}, st = P.strategies[id];
    if (!st) return null;
    const since = anSince();
    const trades = buildTrades(id, cap, P, E).filter(function (t) { return t.kind !== "pair" || t.ts >= since; });      // закриті угоди лише за вибраний період, відкриті — завжди
    trades.forEach(function (t) { t.v = tradeVerdict(t); t.wcap = cap; });
    const closed = trades.filter(function (t) { return t.kind === "pair"; }), wins = closed.filter(function (t) { return t.pl > 0; }), losses = closed.filter(function (t) { return t.pl <= 0; });
    const avg = function (arr) { return arr.length ? arr.reduce(function (a, t) { return a + t.pl; }, 0) / arr.length : 0; };
    const cvAll = st.curve || [];
    const cv = since ? cvAll.filter(function (r) { return Date.parse(r[0]) >= since; }) : cvAll;
    const base = cv.length ? cv[0] : [0, 1, 1];                                        // початок періоду: від нього рахуємо результат
    let peak = 0, mdd = 0; cv.forEach(function (r) { peak = Math.max(peak, r[1]); if (peak) mdd = Math.max(mdd, (peak - r[1]) / peak * 100); });
    const m = liveMarks(id, P), perCoin = {};
    const eq0 = since && cv.length ? cv[0][1] : 1, hold0 = since && cv.length ? cv[0][2] : 1;
    trades.forEach(function (t) { if (t.usd !== null) perCoin[t.coin] = (perCoin[t.coin] || 0) + t.usd; else perCoin[t.coin] = perCoin[t.coin] || 0; });
    P.coins.forEach(function (c) { if (perCoin[c] === undefined) perCoin[c] = 0; });
    return { cap: cap, P: P, st: st, trades: trades, closed: closed, wins: wins, losses: losses, avgWin: avg(wins), avgLoss: avg(losses), avgAll: avg(closed),
      realized: closed.reduce(function (a, t) { return a + t.usd; }, 0), costs: trades.reduce(function (a, t) { return a + t.costs; }, 0), mdd: mdd, ret: (m.eq / eq0 - 1) * 100, hold: (m.hold / hold0 - 1) * 100, curve: cv, eq0: eq0,
      eaten: closed.filter(function (t) { return t.v.tag === "з'їли комісії"; }).length, wrong: closed.filter(function (t) { return t.v.tag === "сигнал помилився"; }).length,
      flaps: trades.filter(function (t) { return t.flapMs !== null; }).length, open: trades.filter(function (t) { return t.kind !== "pair"; }).length, perCoin: perCoin };
  }

  function spark(points, color) {
    const svg = sv("svg", { viewBox: "0 0 120 32", class: "an-spark", "aria-hidden": "true" });
    if (points.length < 2) return svg;
    const lo = Math.min.apply(null, points.concat([1])), hi = Math.max.apply(null, points.concat([1])), r = hi - lo || 1;
    sv("line", { x1: 0, x2: 120, y1: 32 - (1 - lo) / r * 28 - 2, y2: 32 - (1 - lo) / r * 28 - 2, stroke: "var(--line)", "stroke-dasharray": "2 3" }, svg);
    sv("polyline", { points: points.map(function (v, i) { return (i / (points.length - 1) * 120).toFixed(1) + "," + (30 - (v - lo) / r * 28).toFixed(1); }).join(" "), fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round" }, svg);
    return svg;
  }

  function walletsChart(list, id) {
    const box = el("div", "an-chart"), W = 760, H = 230, ML = 46, MR = 12, MT = 10, MB = 22;
    const series = list.map(function (a) {
      const pts = a.curve.map(function (p) { return [Date.parse(p[0]), (p[1] / a.eq0 - 1) * 100]; }); pts.push([Date.now(), a.ret]);
      return { a: a, pts: pts };
    }).filter(function (s) { return s.pts.length > 1; });
    if (!series.length) { box.appendChild(el("p", "muted", "Крива з'явиться після кількох запусків агента.")); return box; }
    let t0 = Infinity, t1 = -Infinity, lo = 0, hi = 0;
    series.forEach(function (s) { s.pts.forEach(function (p) { t0 = Math.min(t0, p[0]); t1 = Math.max(t1, p[0]); lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }); });
    if (hi - lo < 0.2) { hi += 0.1; lo -= 0.1; }
    const pad = (hi - lo) * 0.1; hi += pad; lo -= pad;
    const X = function (t) { return ML + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - ML - MR); }, Y = function (v) { return MT + (hi - v) / (hi - lo) * (H - MT - MB); };
    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "sim-svg", role: "img", "aria-label": "Результат гаманців у відсотках від старту" });
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; sv("line", { x1: ML, x2: W - MR, y1: Y(v), y2: Y(v), stroke: "var(--line)" }, svg); sv("text", { x: ML - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" }, svg).textContent = pc(v, 2); }
    sv("line", { x1: ML, x2: W - MR, y1: Y(0), y2: Y(0), stroke: "var(--text)", "stroke-dasharray": "2 3", opacity: 0.6 }, svg);
    [t0, (t0 + t1) / 2, t1].forEach(function (t, k) { sv("text", { x: X(t), y: H - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle", "font-size": 11, fill: "var(--muted)" }, svg).textContent = new Date(t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); });
    series.forEach(function (s) {
      const col = WCOL[s.a.cap] || "var(--accent)";
      sv("polyline", { points: s.pts.map(function (p) { return X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join(" "), fill: "none", stroke: col, "stroke-width": 2.2, "stroke-linejoin": "round" }, svg);
      const lp = s.pts[s.pts.length - 1]; sv("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 3.5, fill: col }, svg);
    });
    const cross = sv("line", { y1: MT, y2: H - MB, stroke: "var(--muted)", "stroke-dasharray": "3 3", visibility: "hidden" }, svg), ro = el("p", "small sim-readout", "Наведіть курсор на графік: значення кожного гаманця.");
    svg.addEventListener("pointermove", function (ev) {
      const b = svg.getBoundingClientRect(), x = (ev.clientX - b.left) / b.width * W, t = t0 + Math.max(0, Math.min(1, (x - ML) / (W - ML - MR))) * (t1 - t0);
      cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t)); cross.setAttribute("visibility", "visible");
      ro.textContent = new Date(t).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " → " + series.map(function (s) {
        let best = s.pts[0]; s.pts.forEach(function (p) { if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; }); return usd(s.a.cap) + ": " + pc(best[1], 3); }).join(" · ");
    });
    svg.addEventListener("pointerleave", function () { cross.setAttribute("visibility", "hidden"); });
    box.appendChild(svg); box.appendChild(ro);
    const lg = el("div", "an-legend small");
    series.forEach(function (s) { const sp = el("span", "", "● гаманець " + usd(s.a.cap)); sp.style.color = WCOL[s.a.cap]; lg.appendChild(sp); });
    box.appendChild(lg);
    return box;
  }

  // Чому угода була вигідною (або невигідною): розбір простими словами за даними самої угоди
  function whyTrade(t) {
    const e = t.buy, ind = e.ind || {}, cp = t.costPct || 0, lines = [], good = t.pl > 0;
    if (t.kind === "pair") {
      const gross = t.pl + cp, r = String(t.sell.reason || "");
      lines.push("Купили по " + pxfmt(e.price) + ", продали по " + pxfmt(t.sell.price) + ": ціна змінилась на " + pc(gross, 2) + ", витрати ≈" + f2(cp) + "%, чистий результат " + pc(t.pl, 2) + " (" + money(t.usd) + ").");
      if (/^Тейк-профіт/.test(r)) lines.push("Вихід: спрацював тейк-профіт, тобто бот зафіксував прибуток на заздалегідь заданій цілі й не віддав його ринку.");
      else if (/^Трейлінг/.test(r)) lines.push("Вихід: трейлінг-стоп. Ціна зросла, потім трохи відкотилась, і бот зафіксував накопичений прибуток.");
      else if (/^Стоп-лос/.test(r)) lines.push("Вихід: спрацював стоп-лос, тобто бот обмежив збиток, щоб він не ріс далі.");
      else lines.push("Вихід: " + (good ? "тренд зберігався, поки правило не вийшло за своєю умовою; " : "") + r.replace(/\.$/, "") + ".");
      lines.push("Утримання " + dur(t.held) + (t.held <= 3600000 * 1.01 ? ": дуже коротка угода, результат більше схожий на випадковість." : good ? ": ціна встигла рухнути достатньо, щоб покрити витрати." : "."));
    } else {
      lines.push("Угода ще відкрита: купили по " + pxfmt(e.price) + ", зараз " + (t.pl === null ? "—" : pc(t.pl, 2)) + " до витрат на вихід (≈" + f2(cp) + "%).");
    }
    if (typeof ind.rsi === "number") lines.push("Момент входу: RSI " + Math.round(ind.rsi) + (ind.rsi >= 70 ? " — ринок був перегрітий, ризик відкату" : ind.rsi <= 35 ? " — після розпродажу, можливий відскок" : " — без крайнощів, тобто купували не на піку емоцій") + ".");
    if (ind.price && ind.sma50) lines.push("Тренд при купівлі: ціна на " + f2(Math.abs((ind.price / ind.sma50 - 1) * 100)) + "% " + (ind.price >= ind.sma50 ? "вище" : "нижче") + " середньої за 50 свічок.");
    if (t.flapMs !== null) lines.push("Увага: це повторний вхід через " + Math.max(1, Math.round(t.flapMs / 60000)) + " хв після попереднього продажу тієї ж монети.");
    return lines;
  }

  function bestWorst(list) {
    const all = list.reduce(function (a, x) { return a.concat(x.trades); }, []).filter(function (t) { return t.pl !== null; });
    const box = el("div", "an-bw");
    if (!all.length) { box.appendChild(el("p", "muted", "Угод за цей період ще немає.")); return box; }
    all.sort(function (a, b) { return b.pl - a.pl; });
    function card(t, kind, title) {
      const c = el("div", "an-bw-card " + kind);
      const h = el("div", "an-bw-h"); h.appendChild(el("b", "", title)); h.appendChild(el("span", "an-bw-pl " + cls(t.pl), pc(t.pl, 2) + " · " + money(t.usd)));
      c.appendChild(h);
      c.appendChild(el("div", "small muted", t.coin + " · гаманець " + usd(t.wcap) + " · " + when(t.buy.candle) + (t.kind === "pair" ? " → " + when(t.sell.candle) : " → в позиції") + " · сума " + usd(t.sum)));
      const ul = el("ul", "an-tips"); whyTrade(t).forEach(function (x) { ul.appendChild(el("li", "small", x)); }); c.appendChild(ul);
      return c;
    }
    const best = all[0], worst = all[all.length - 1];
    box.appendChild(card(best, best.pl > 0 ? "good" : "warn", best.pl > 0 ? "Найвигідніша угода" : "Найкраща угода (поки без прибутку)"));
    if (all.length > 1 && worst !== best) box.appendChild(card(worst, worst.pl < 0 ? "bad" : "warn", "Найневдаліша угода"));
    return box;
  }

  // ---------- Живий бот у браузері: дивиться на ціну щосекунди й діє одразу, коли зійшлися умови (тимчасово, поки відкрита сторінка) ----------
  const LB_KEY = "liveBotV1";
  let liveBot = null;
  function lbLoad() {
    try { const v = JSON.parse(localStorage.getItem(LB_KEY) || "null"); if (v && v.coins) return v; } catch (e) { /* без збереження */ }
    return null;
  }
  function lbSave() { try { localStorage.setItem(LB_KEY, JSON.stringify(liveBot)); } catch (e) { /* немає місця або заборонено: працюємо без збереження */ } }
  function lbRule() { return (sim.strategies || []).filter(function (s) { return s.id === "setup_live"; })[0]; }
  function lbReset(cap) {
    const P = walletData(cap), n = Math.max(1, P.coins.length);
    liveBot = { cap: cap, since: Date.now(), coins: {}, log: [], trades: 0, w: 1 / n };
    P.coins.forEach(function (c) { liveBot.coins[c] = { pos: false, eq: 1, entry: null, peak: null, px: null, cool: 0 }; });
    lbSave();
  }
  function smaLast(arr, n) { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; }
  function rsiLast(arr, n) {
    n = n || 14; if (arr.length < n + 2) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = arr[i] - arr[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  function lbEntry(r, P, s15, s1h, rsi, c15) {
    const band = (r.band === undefined || r.band === null ? 0.1 : r.band) / 100, lo = r.rsi_min === null || r.rsi_min === undefined ? 40 : r.rsi_min, hi = r.rsi_max === null || r.rsi_max === undefined ? 68 : r.rsi_max;
    if (!(P > s15 * (1 + band)) || !(P > s1h) || rsi === null || rsi < lo || rsi > hi || c15.length < 6 || !(P > c15[c15.length - 5])) return null;
    return "Умови зійшлися одразу: ціна " + pxfmt(P) + " вища за 15-хвилинну середню (" + pxfmt(s15) + ") і годинну (" + pxfmt(s1h) + "), RSI за годину " + Math.round(rsi) + ", за останню годину ціна росте.";
  }
  function lbExit(r, co, P, s15) {
    const chg = (P / co.entry - 1) * 100, pk = co.peak || co.entry;
    if (r.stop && chg <= -r.stop) return "Стоп-лос: ціна на " + f2(Math.abs(chg)) + "% нижча за купівлю (поріг " + r.stop + "%).";
    if (r.take && chg >= r.take) return "Тейк-профіт: ціна на " + f2(chg) + "% вища за купівлю (поріг " + r.take + "%).";
    if (r.trail && (pk / co.entry - 1) * 100 >= (r.trail_start || 0.6) && (P / pk - 1) * 100 <= -r.trail) return "Трейлінг-стоп: ціна відкотилась на " + f2(Math.abs((P / pk - 1) * 100)) + "% від максимуму.";
    if (s15 && P < s15 * (1 - (r.band === undefined || r.band === null ? 0.1 : r.band) / 100)) return "Тренд зламано: ціна нижче 15-хвилинної середньої.";
    return null;
  }
  function lbTick() {
    if (!sim || !sim.paper || !liveBot) return;
    const r = lbRule(), fee = sim.paper.fee || 0, now = Date.now();
    if (!r) return;
    Object.keys(liveBot.coins).forEach(function (sym) {
      const co = liveBot.coins[sym], P = live[sym], d15 = loadCandles(sym, "15m"), d1h = loadCandles(sym, "1h");
      if (!P || !d15 || !d1h || d15.length < 60 || d1h.length < 60) return;
      if (co.px) { const k = P / co.px; if (co.pos) { co.eq *= k; co.peak = Math.max(co.peak || P, P); } }
      co.px = P;
      const c15 = d15.map(function (x) { return x.c; }), c1h = d1h.map(function (x) { return x.c; });
      c15[c15.length - 1] = P; c1h[c1h.length - 1] = P;
      const s15 = smaLast(c15, 50), s1h = smaLast(c1h, 50), rsi = rsiLast(c1h, 14);
      if (co.pos) {
        const why = lbExit(r, co, P, s15);
        if (why) { co.eq *= 1 - fee; liveBot.log.unshift({ t: now, coin: sym, side: "SELL", price: P, why: why, pl: (P / co.entry - 1) * 100 - fee * 200 }); co.pos = false; co.entry = null; co.peak = null; co.cool = now + (r.cooldown_min || 30) * 60000; liveBot.trades++; lbSave(); }
      } else if (now >= (co.cool || 0) && s15 && s1h) {
        const why = lbEntry(r, P, s15, s1h, rsi, c15);
        if (why) { co.eq *= 1 - fee; co.pos = true; co.entry = P; co.peak = P; liveBot.log.unshift({ t: now, coin: sym, side: "BUY", price: P, why: why }); liveBot.trades++; lbSave(); }
      }
    });
    liveBot.log = liveBot.log.slice(0, 40);
  }
  function liveBotNode() {
    const wrap = el("div", "lb");
    wrap.appendChild(el("h4", "sub", "Живий бот у браузері: реагує щосекунди"));
    const r = lbRule();
    if (!r) { wrap.appendChild(el("p", "muted", "Правила сканера умов ще не завантажені.")); return wrap; }
    const caps = sim.paper.accounts, cap = liveBot ? liveBot.cap : (caps[Math.min(1, caps.length - 1)]);
    if (!liveBot) lbReset(cap);
    const total = Object.keys(liveBot.coins).reduce(function (a, c) { return a + liveBot.w * liveBot.coins[c].eq; }, 0), ret = (total - 1) * 100;
    wrap.appendChild(el("p", "small muted", "Використовує умови правила «" + r.title + "», але перевіряє їх при кожній зміні ціни, а не раз на 10 хвилин. Працює лише поки відкрита ця сторінка; стан зберігається в цьому браузері. Це додатковий експеримент, він не входить у рейтинг ботів."));
    const row = el("div", "lb-row");
    const t1 = el("div", "an-an-t lb-t"); t1.appendChild(el("span", "small muted", "Гаманець " + usd(liveBot.cap) + " · монети " + Object.keys(liveBot.coins).join(" ")));
    t1.appendChild(el("b", "an-big " + cls(ret), pc(ret, 3) + " · " + money(liveBot.cap * ret / 100)));
    t1.appendChild(el("span", "small muted", "угод: " + liveBot.trades + " · працює вже " + dur(Date.now() - liveBot.since) + " · у позиції: " + (Object.keys(liveBot.coins).filter(function (c) { return liveBot.coins[c].pos; }).join(", ") || "готівка")));
    row.appendChild(t1);
    const rb = el("button", "feed-chip", "Почати з нуля"); rb.type = "button"; rb.setAttribute("data-lbreset", liveBot.cap); row.appendChild(rb);
    caps.forEach(function (c) { if (c !== liveBot.cap) { const b = el("button", "feed-chip", "Гаманець " + usd(c)); b.type = "button"; b.setAttribute("data-lbreset", c); row.appendChild(b); } });
    wrap.appendChild(row);
    const ready = Object.keys(liveBot.coins).filter(function (c) { const a = klCache[c + "|15m"], b = klCache[c + "|1h"]; return a && b && a.data && b.data; }).length;
    if (ready < Object.keys(liveBot.coins).length) wrap.appendChild(el("p", "small muted", "Завантажуємо свічки Binance: " + ready + " із " + Object.keys(liveBot.coins).length + " монет…"));
    const list = el("div", "lb-log");
    if (!liveBot.log.length) list.appendChild(el("p", "small muted", "Угод ще не було: бот чекає, поки умови зійдуться."));
    liveBot.log.slice(0, 12).forEach(function (x) {
      const it = el("div", "lb-item " + (x.side === "BUY" ? "buy" : "sell"));
      it.appendChild(el("b", "", (x.side === "BUY" ? "КУПЛЕНО " : "ПРОДАНО ") + x.coin));
      it.appendChild(el("span", "small", new Date(x.t).toLocaleTimeString("uk-UA") + " · " + pxfmt(x.price) + (x.pl !== undefined ? " · " + pc(x.pl, 2) : "")));
      it.appendChild(el("span", "small muted", x.why));
      list.appendChild(it);
    });
    wrap.appendChild(list);
    return wrap;
  }
  document.getElementById("walletAnalytics").addEventListener("click", function (e) {
    const b = e.target.closest("[data-lbreset]");
    if (b) { lbReset(parseInt(b.getAttribute("data-lbreset"), 10)); renderAnalytics(); }
  });
  liveBot = lbLoad();
  setInterval(function () { if (!document.hidden && sim && sim.paper && !document.getElementById("walletAnalytics").hidden) { try { lbTick(); } catch (e) { /* не зупиняємо сторінку через помилку бота */ } } }, 1000);

  function renderAnalytics() {
    const root = document.getElementById("walletAnalytics");
    if (!root || root.hidden || !sim || !sim.paper) return;
    if (!document.getElementById("anBar")) {                                           // панель вибору періоду: створюється один раз і не перебудовується
      const bar = el("div", "an-bar"); bar.id = "anBar";
      bar.appendChild(el("b", "", "Період аналізу:"));
      AN_PERIODS.forEach(function (x) {
        const b = el("button", "feed-chip" + (anCfg.period === x[1] ? " on" : ""), x[0]); b.type = "button"; b.setAttribute("data-per", x[1]);
        b.addEventListener("click", function () { anCfg.period = x[1]; bar.querySelectorAll(".feed-chip").forEach(function (c) { c.classList.toggle("on", c === b); }); renderAnalytics(); });
        bar.appendChild(b);
      });
      const body = el("div", ""); body.id = "anBody"; root.appendChild(bar); root.appendChild(body);
    }
    const box = document.getElementById("anBody");
    const id = pStrat.value || sim.strategies[0].id, list = sim.paper.accounts.map(function (cap) { return wAnalyze(id, cap); }).filter(Boolean);
    const tmp = document.createElement("div");
    const head = el("div", "an-head");
    head.appendChild(el("h4", "", "Аналітика гаманців: " + ruleTitle(id)));
    head.appendChild(el("p", "small muted", "Один і той самий бот у трьох гаманцях з різними монетами · період: " + (AN_PERIODS.filter(function (x) { return x[1] === anCfg.period; })[0] || [""])[0].toLowerCase() + ". Вибрати іншого бота: «Арена ботів» або таблиця нижче."));
    tmp.appendChild(head);
    tmp.appendChild(gateNode(id, "цього бота у всіх гаманцях"));
    if (!list.length) { tmp.appendChild(el("p", "muted", "Для цього бота ще немає даних.")); morphKids(box, tmp); return; }

    // 1. три гаманці поруч
    const cards = el("div", "an-cards");
    list.forEach(function (a) {
      const c = el("div", "an-card"); c.style.borderTopColor = WCOL[a.cap] || "var(--accent)";
      const top = el("div", "an-card-h"); top.appendChild(el("b", "", "Гаманець " + usd(a.cap))); top.appendChild(el("span", "small muted", a.P.coins.join(" · "))); c.appendChild(top);
      const big = el("div", "an-big " + cls(a.ret), pc(a.ret, 2) + " · " + money(a.cap * a.ret / 100)); c.appendChild(big);
      c.appendChild(el("div", "small " + cls(a.ret - a.hold), "проти «просто тримати» (" + pc(a.hold, 2) + "): " + pc(a.ret - a.hold, 2)));
      c.appendChild(spark(a.curve.map(function (r) { return r[1] / a.eq0; }), WCOL[a.cap] || "var(--accent)"));
      const g = el("div", "an-grid");
      [["Закрито угод", String(a.closed.length)], ["Прибуткових", a.closed.length ? Math.round(100 * a.wins.length / a.closed.length) + "%" : "—"], ["Середня угода", a.closed.length ? pc(a.avgAll, 2) : "—"],
       ["Середній виграш / програш", a.closed.length ? (a.wins.length ? pc(a.avgWin, 2) : "—") + " / " + (a.losses.length ? pc(a.avgLoss, 2) : "—") : "—"], ["Витрати (комісії)", "≈" + usd(a.costs)],
       ["Просідання", a.curve.length > 1 ? "−" + f2(a.mdd) + "%" : "—"], ["Відкрито зараз", String(a.open)], ["«Смикання»", String(a.flaps)]].forEach(function (x) {
        const cell = el("div", "an-cell"); cell.appendChild(el("span", "small muted", x[0])); cell.appendChild(el("b", "", x[1])); g.appendChild(cell);
      });
      c.appendChild(g); cards.appendChild(c);
    });
    tmp.appendChild(cards);

    // найвигідніша й найневдаліша угода з поясненням
    tmp.appendChild(el("h4", "sub", "Яка угода була найвигідніша і чому"));
    tmp.appendChild(bestWorst(list));

    tmp.appendChild(liveBotNode());

    // 2. криві гаманців
    tmp.appendChild(el("h4", "sub", "Результат гаманців у часі (% від старту раунду)"));
    tmp.appendChild(walletsChart(list, id));

    // 3. усі боти × гаманці
    tmp.appendChild(el("h4", "sub", "Усі боти в усіх гаманцях (результат у %)"));
    const rules = Object.keys(sim.paper.strategies).map(function (rid) {
      const vals = sim.paper.accounts.map(function (cap) { const P = walletData(cap); return P.strategies[rid] ? liveMarks(rid, P) : null; });
      const rets = vals.map(function (m) { return m ? (m.eq - 1) * 100 : null; }), ok = rets.filter(function (v) { return v !== null; });
      return { rid: rid, rets: rets, avg: ok.length ? ok.reduce(function (a, b) { return a + b; }, 0) / ok.length : 0 };
    }).sort(function (a, b) { return b.avg - a.avg; });
    const mxAbs = Math.max(0.05, Math.max.apply(null, rules.map(function (r) { return Math.max.apply(null, r.rets.map(function (v) { return Math.abs(v || 0); })); })));
    const ht = el("table", "agent-table an-heat"), hh = el("tr");
    hh.appendChild(el("th", "", "Бот")); sim.paper.accounts.forEach(function (cap) { hh.appendChild(el("th", "", usd(cap))); }); hh.appendChild(el("th", "", "Середнє"));
    ht.appendChild(el("thead")).appendChild(hh);
    const hb = el("tbody");
    rules.forEach(function (r) {
      const tr = el("tr", r.rid === id ? "board-sel" : ""); tr.setAttribute("data-hrule", r.rid); tr.tabIndex = 0;
      const nm = el("td", "", ruleTitle(r.rid)); botTags(ruleDef(r.rid)).slice(0, 2).forEach(function (t) { nm.appendChild(el("span", "rank-tag " + t[1], t[0])); }); tr.appendChild(nm);
      r.rets.forEach(function (v) {
        const td = el("td", v === null ? "" : cls(v), v === null ? "—" : pc(v, 2));
        if (v !== null) td.style.background = (v >= 0 ? "rgba(80,150,100," : "rgba(180,80,80,") + (Math.min(1, Math.abs(v) / mxAbs) * 0.35).toFixed(2) + ")";
        tr.appendChild(td);
      });
      tr.appendChild(el("td", "an-avg " + cls(r.avg), pc(r.avg, 2)));
      hb.appendChild(tr);
    });
    ht.appendChild(hb);
    const hw = el("div", "agent-table-wrap"); hw.appendChild(ht); tmp.appendChild(hw);

    // 4. звідки прибуток і збиток по монетах
    tmp.appendChild(el("h4", "sub", "Результат по монетах (закриті угоди + відкриті за живою ціною)"));
    const coinsBox = el("div", "an-coins");
    const maxC = Math.max(0.01, Math.max.apply(null, list.map(function (a) { return Math.max.apply(null, Object.keys(a.perCoin).map(function (c) { return Math.abs(a.perCoin[c]); })); })));
    list.forEach(function (a) {
      const col = el("div", "an-coincol"); col.appendChild(el("b", "small", "Гаманець " + usd(a.cap)));
      Object.keys(a.perCoin).forEach(function (c) {
        const v = a.perCoin[c], row = el("div", "an-coinrow"); row.appendChild(el("span", "an-coinname", c));
        const tr = el("div", "an-coinbar"), fl = el("i", v >= 0 ? "pos" : "neg"); fl.style.width = (Math.abs(v) / maxC * 50) + "%"; fl.style[v >= 0 ? "left" : "right"] = "50%"; tr.appendChild(fl); row.appendChild(tr);
        row.appendChild(el("span", "small " + cls(v), v === 0 ? "—" : money(v))); col.appendChild(row);
      });
      coinsBox.appendChild(col);
    });
    tmp.appendChild(coinsBox);

    // 5. розподіл результатів угод і залежність від тривалості
    const all = list.reduce(function (a, x) { return a.concat(x.closed); }, []);
    tmp.appendChild(el("h4", "sub", "Розподіл результатів закритих угод (усі гаманці)"));
    if (!all.length) tmp.appendChild(el("p", "muted", "Закритих угод ще немає: розподіл з'явиться, коли боти почнуть продавати."));
    else {
      const bins = [[-1e9, -1, "< −1%"], [-1, -0.5, "−1…−0,5"], [-0.5, -0.3, "−0,5…−0,3"], [-0.3, 0, "−0,3…0"], [0, 0.3, "0…0,3"], [0.3, 1, "0,3…1"], [1, 1e9, "> 1%"]];
      const cnt = bins.map(function (b) { return all.filter(function (t) { return t.pl >= b[0] && t.pl < b[1]; }).length; }), mc = Math.max.apply(null, cnt) || 1;
      const hist = el("div", "an-hist");
      bins.forEach(function (b, i) { const col = el("div", "an-hcol"); col.appendChild(el("span", "small", String(cnt[i]))); const bar = el("i", b[0] >= 0 ? "pos" : "neg"); bar.style.height = Math.max(3, cnt[i] / mc * 70) + "px"; col.appendChild(bar); col.appendChild(el("span", "small muted", b[2])); hist.appendChild(col); });
      tmp.appendChild(hist);
      const buckets = [["до 1 години", function (t) { return t.held <= 3600000 * 1.01; }], ["1–4 години", function (t) { return t.held > 3600000 * 1.01 && t.held <= 14400000; }], ["понад 4 години", function (t) { return t.held > 14400000; }]];
      const bt = el("table", "agent-table"), bh = el("tr"); ["Скільки тримали", "Угод", "Прибуткових", "Середній результат", "Разом"].forEach(function (x) { bh.appendChild(el("th", "", x)); });
      bt.appendChild(el("thead")).appendChild(bh); const bb = el("tbody");
      buckets.forEach(function (b) {
        const ts = all.filter(function (t) { return b[1](t); }), tr = el("tr"), av = ts.length ? ts.reduce(function (a, t) { return a + t.pl; }, 0) / ts.length : 0, sm = ts.reduce(function (a, t) { return a + t.usd; }, 0);
        tr.appendChild(el("td", "", b[0])); tr.appendChild(el("td", "", String(ts.length))); tr.appendChild(el("td", "", ts.length ? Math.round(100 * ts.filter(function (t) { return t.pl > 0; }).length / ts.length) + "%" : "—"));
        tr.appendChild(el("td", ts.length ? cls(av) : "", ts.length ? pc(av, 2) : "—")); tr.appendChild(el("td", ts.length ? cls(sm) : "", ts.length ? money(sm) : "—")); bb.appendChild(tr);
      });
      bt.appendChild(bb); const bw = el("div", "agent-table-wrap"); bw.appendChild(bt); tmp.appendChild(bw);
    }

    // 6. висновки простими словами
    const tips = [], best = list.slice().sort(function (a, b) { return b.ret - a.ret; }), worst = best[best.length - 1];
    if (list.length > 1) tips.push("Найкращий гаманець для цього бота: " + usd(best[0].cap) + " (" + pc(best[0].ret, 2) + "), найгірший: " + usd(worst.cap) + " (" + pc(worst.ret, 2) + "). Різницю дають монети, а не сума: відсотки від суми не залежать.");
    const totC = list.reduce(function (a, x) { return a + x.costs; }, 0), totR = list.reduce(function (a, x) { return a + x.realized; }, 0);
    if (all.length) tips.push("Усього закрито " + all.length + " угод: зафіксовано " + money(totR) + ", витрати на комісії й ковзання ≈" + usd(totC) + (totC > Math.abs(totR) ? " — витрати більші за результат." : "."));
    const shortAll = all.filter(function (t) { return t.held <= 3600000 * 1.01; });
    if (shortAll.length >= 3) tips.push("Угод до 1 години: " + shortAll.length + " із " + all.length + ", прибуткових " + shortAll.filter(function (t) { return t.pl > 0; }).length + ". Дуже короткі угоди найчастіше програють витратам.");
    const fl = list.reduce(function (a, x) { return a + x.flaps; }, 0);
    if (fl) tips.push("«Смикань» (повторний вхід одразу після продажу): " + fl + ". Для порівняння є версії правил з буфером і паузою.");
    if (!tips.length) tips.push("Угод ще замало для висновків: боти чекають своїх сигналів.");
    tmp.appendChild(el("h4", "sub", "Висновки"));
    const ul = el("ul", "an-tips"); tips.forEach(function (x) { ul.appendChild(el("li", "small", x)); }); tmp.appendChild(ul);
    tmp.appendChild(el("p", "small muted", "Це експеримент на віртуальних грошах, а не порада. Даних поки мало, і результат окремого дня легко може бути везінням."));
    morphKids(box, tmp);
  }
  document.getElementById("walletAnalytics").addEventListener("click", function (e) {
    const r = e.target.closest("[data-hrule]");
    if (r) { pStrat.value = r.getAttribute("data-hrule"); renderPaper(true); renderBoard(); renderDecisions(); }
  });

  document.getElementById("walletFeed").addEventListener("click", function (e) {
    const fk = e.target.closest("[data-fk]");
    if (fk) { feedOpen[fk.getAttribute("data-fk")] = !feedOpen[fk.getAttribute("data-fk")]; renderPaper(false); return; }
    const ch = e.target.closest("[data-coinh]");
    if (ch) { const c = ch.getAttribute("data-coinh"); coinOpen[c] = coinOpen[c] === false; renderPaper(false); }
  });
  walletTabs.addEventListener("click", function (e) {
    const b = e.target.closest("[data-cap]");
    if (!b) return;
    activeCap = parseInt(b.getAttribute("data-cap"), 10); applyWallet(); renderPaper(true); renderBoard(); renderRounds(); renderDecisions();
  });
  document.getElementById("paperBoard").addEventListener("click", function (e) {
    const d = e.target.closest("[data-adot]"), m = e.target.closest("[data-amain]");
    if (d) { arenaHidden[d.getAttribute("data-adot")] = !arenaHidden[d.getAttribute("data-adot")]; renderBoard(); }
    else if (m) { pStrat.value = m.getAttribute("data-amain"); renderPaper(true); renderDecisions(); renderBoard(); }
  });

  function renderPaper(withChart) {
    if (!sim || !sim.paper) return;
    const id = pStrat.value || sim.strategies[0].id, st = sim.paper.strategies[id];
    if (!st) return;
    const m = liveMarks(id), er = (m.eq - 1) * 100, hr = (m.hold - 1) * 100;

    const tp = document.createElement("div"), wt = document.createElement("div");
    feedToolbar();
    sim.paper.accounts.forEach(function (cap) {
      const b = el("button", "wallet-tab" + (cap === activeCap ? " on" : ""));
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", cap === activeCap ? "true" : "false");
      const P = walletData(cap), mm = P.strategies[id] ? liveMarks(id, P) : { eq: 1 }, e2 = (mm.eq - 1) * 100;
      b.appendChild(el("span", "wallet-tab-n", "Гаманець " + usd(cap)));
      b.appendChild(el("b", "", usd(cap * mm.eq)));
      b.appendChild(el("span", "small " + cls(e2), pc(e2)));
      b.appendChild(el("span", "small wallet-tab-coins", (P.coins || []).join(" · ")));
      b.setAttribute("data-cap", cap);
      wt.appendChild(b);
    });
    morphKids(walletTabs, wt);
    paperTiles.classList.add("wallet-single");
    const wv = document.getElementById("walletViews");
    let gate = document.getElementById("dataGate");
    if (!gate) { gate = el("div", ""); gate.id = "dataGate"; wv.parentNode.insertBefore(gate, wv); }
    const tg = document.createElement("div"); tg.appendChild(gateNode(id, "цього бота")); morphKids(gate, tg);
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
      mountFeed(feedBox(id, cap));
      tp.appendChild(t);
    });
    morphKids(paperTiles, tp);
    feedFirst = false;
    Object.keys(tcCharts).forEach(function (k) { if (!tcCharts[k].host.isConnected && !feedOpen[k]) { try { tcCharts[k].inst.close(); } catch (x) { /* вже закрито */ } delete tcCharts[k]; } });
    renderAnalytics();

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
    const daily = dailyTable();
    if (!h.length) { box.replaceChildren(daily, el("p", "muted", "Перший раунд іще триває: підсумок з'явиться після завершення.")); return; }
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
    box.replaceChildren(daily, el("h4", "sub", "Завершені раунди"), t);
  }

  // Знімок по днях: як змінювався результат кожного бота від старту раунду (остання точка кожного дня)
  function dailyTable() {
    const wrap = el("div", "tr-daily"), dd = sim.paper.daily || {}, days = Object.keys(dd).sort().slice(-14);
    wrap.appendChild(el("h4", "sub", "Результат по днях (від старту раунду, у %)"));
    if (days.length < 1) { wrap.appendChild(el("p", "muted", "Знімки по днях ще не зібрані: перший з'явиться після наступного запуску агента.")); return wrap; }
    const last = dd[days[days.length - 1]], ids = Object.keys(last).sort(function (a, b) { return last[b][0] - last[a][0]; });
    const t = el("table", "agent-table"), head = el("tr");
    head.appendChild(el("th", "", "Бот"));
    days.forEach(function (d) { head.appendChild(el("th", "", new Date(d + "T12:00:00Z").toLocaleDateString("uk-UA", { day: "numeric", month: "short" }))); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    ids.forEach(function (rid, i) {
      const tr = el("tr", i === 0 ? "rank-strong" : "");
      tr.appendChild(el("td", "", ruleTitle(rid)));
      days.forEach(function (d) { const v = dd[d] && dd[d][rid]; tr.appendChild(el("td", v ? cls(v[0] - 1) : "", v ? pc((v[0] - 1) * 100, 2) : "—")); });
      body.appendChild(tr);
    });
    t.appendChild(body);
    const wr = el("div", "agent-table-wrap"); wr.appendChild(t); wrap.appendChild(wr);
    wrap.appendChild(el("p", "small muted", "Показано останню точку кожного дня. Дивіться на послідовність днів, а не на один: окремий день легко може бути везінням."));
    return wrap;
  }

  // Чи достатньо даних для висновків: потрібно хоча б кілька днів і десятки закритих угод
  const GATE_DAYS = 3, GATE_TRADES = 30;
  function gateInfo(ruleId) {
    const rd = sim.paper.round, days = Math.max(0, (Date.now() - Date.parse(rd.start)) / 864e5), total = Math.max(1, (Date.parse(rd.end) - Date.parse(rd.start)) / 864e5);
    let closed = 0;
    Object.keys(evts || {}).forEach(function (rid) {
      if (ruleId && rid !== ruleId) return;
      const open = {};
      (evts[rid] || []).slice().sort(function (a, b) { return a.candle - b.candle; }).forEach(function (e) { if (e.side === "BUY") open[e.coin] = 1; else if (open[e.coin]) { closed++; delete open[e.coin]; } });
    });
    return { days: days, total: total, closed: closed, ok: days >= GATE_DAYS && closed >= GATE_TRADES };
  }
  function gateNode(ruleId, who) {
    const g = gateInfo(ruleId), n = el("div", "tr-gate " + (g.ok ? "ok" : "low"));
    const f = function (v) { return v.toLocaleString("uk-UA", { maximumFractionDigits: 1 }); };
    n.appendChild(el("b", "", g.ok ? "Даних достатньо для попередньої оцінки" : "Замало даних для висновків: відсотки зараз переважно випадковість"));
    n.appendChild(el("span", "small", "Пройшло " + f(g.days) + " із " + f(g.total) + " днів (потрібно хоча б " + GATE_DAYS + ") · закритих угод " + who + ": " + g.closed + " (потрібно хоча б " + GATE_TRADES + ")" + (g.ok ? ". Навіть тоді це не гарантія на майбутнє." : "")));
    return n;
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
    if (def.kind === "setup") t.push(["миттєво за умовами", "up"]);
    if (def.kind !== "setup" && def.band) t.push(["буфер " + def.band + "%", "same"]);
    if (def.cooldown) t.push(["пауза " + def.cooldown + " св.", "same"]);
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
      return { id: id, def: def, color: BOT_COLORS[i % BOT_COLORS.length], title: def.title || id, tf: def.kind === "setup" ? "одразу за умовами" : (TF[def.tf] || def.tf), inv: def.invert, pair: def.pair, st: st, ret: (m.eq - 1) * 100, hold: (m.hold - 1) * 100 };
    });
    rows.forEach(function (r) { r.vs = r.ret - r.hold; });
    const sorted = rows.slice().sort(function (a, b) { return arenaSort === "trades" ? b.st.trades - a.st.trades : arenaSort === "vs" ? b.vs - a.vs : b.ret - a.ret; });
    const wrap = el("div", "arena");
    wrap.appendChild(gateNode(null, "усіх ботів"));

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
      dot.setAttribute("data-adot", r.id);
      card.appendChild(dot);
      const main = el("button", "arena-main"); main.type = "button"; main.title = "Показати цього бота в рахунках вище";
      main.setAttribute("data-amain", r.id);
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
    arenaChart(chartBox, ro, rows);
    const tmpA = document.createElement("div"); tmpA.appendChild(wrap); morphKids(box, tmpA);

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
    const conn = el("div", "tr-conn");
    try {
      const nt = await loadJson("data/notify.json"), tr2 = await loadJson("data/trader.json");
      [["Telegram-сповіщення", nt.configured, "TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID"], ["Бот на тестовій біржі", tr2.configured, "BINANCE_TESTNET_API_KEY і BINANCE_TESTNET_API_SECRET"]].forEach(function (x) {
        const row = el("div", "tr-conn-row " + (x[1] ? "ok" : "off"));
        row.appendChild(el("b", "", x[0] + ": " + (x[1] ? "підключено" : "не підключено")));
        if (!x[1]) row.appendChild(el("span", "small", "Щоб увімкнути: GitHub → Settings → Secrets and variables → Actions → New repository secret: " + x[2] + ". Ключі вводяться лише там, не в чаті й не у файлах сайту."));
        conn.appendChild(row);
      });
    } catch (e) { /* стан підключень необов'язковий */ }
    box.appendChild(conn);
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
        const TF = { "1d": "щодня", "1h": "щогодини", "15m": "кожні 15 хв", "30m": "кожні 30 хв", "2h": "кожні 2 год" };
        fill(pStrat, d.strategies.map(function (s) { return [s.id, s.title + " · " + (s.kind === "setup" ? "рішення одразу за умовами" : "рішення " + (TF[s.tf] || s.tf))]; }));
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
