// Сторінка «Аналітика гаманців»: режими «Вибраний бот» / «Середнє по ботах», головний графік трьох гаманців, періоди й шкали.
// Дані: data/simulation.json (лише збережені криві curve і денні значення daily; нічого не перераховується й не домальовується), статус Testnet: data/trader.json.
// Історія угод: повний архів Paper Trading data/paper_archive/ (індекс + лише потрібні сегменти, кеш у пам'яті з перевіркою за індексом), журнал paper_events*.json і live_feed.json; Testnet не змішується.
// Потребує wallets-data.js, wallets-chart.js; кнопка «Торгові події» використовує наявний LiveFeed.mount() (live-feed.js), якщо він підключений.
// Це симуляція на віртуальних грошах, а не фінансова порада.

(function (root) {
  "use strict";
  const D = root.WalletsData;
  const PERIOD_LABELS = [["1h", "1 год"], ["6h", "6 год"], ["24h", "24 год"], ["7d", "7 днів"], ["30d", "30 днів"], ["all", "Увесь період"]];
  const PREFS = "wl:prefs:v1";

  function h(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function nf(v, d) { return v.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function capLabel(c) { return c.toLocaleString("uk-UA") + " $"; }
  function ago(t, now) { const m = Math.max(0, Math.round((now - t) / 60000)); return m < 1 ? "щойно" : m < 60 ? m + " хв тому" : m < 1440 ? Math.round(m / 60) + " год тому" : Math.round(m / 1440) + " дн тому"; }
  function hhmm(t) { return new Date(t).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

  function defaultEnv() {
    return {
      loadJson: function (url) { return fetch(url + (url.indexOf("?") < 0 ? "?t=" + Math.floor(Date.now() / 60000) : "")).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); },
      loadPrices: function (syms) { const q = encodeURIComponent(JSON.stringify(syms.map(function (x) { return x + "USDT"; }))); return fetch("https://data-api.binance.vision/api/v3/ticker/price?symbols=" + q).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (arr) { const m = {}; (Array.isArray(arr) ? arr : []).forEach(function (x) { const v = parseFloat(x.price); if (x && typeof x.symbol === "string" && v > 0) m[x.symbol.replace(/USDT$/, "")] = v; }); return m; }); },
      priceMs: 20000,
      download: function (name, text) { const b = new Blob([text], { type: "text/csv;charset=utf-8" }), u = URL.createObjectURL(b), a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1500); },
      now: function () { return Date.now(); }, storage: root.localStorage, search: root.location ? root.location.search : "",
      setTimeout: function (f, ms) { return root.setTimeout(f, ms); }, clearTimeout: function (i) { root.clearTimeout(i); }, refreshMs: 60000,
    };
  }

  function mount(host, envIn) {
    const env = Object.assign(defaultEnv(), envIn || {});
    const params = new URLSearchParams(env.search || "");
    let prefs = { mode: "bot", bot: null, unit: "pct", period: "all", view: "curve", scope: "round" };
    try { const s = JSON.parse(env.storage.getItem(PREFS)); if (s && typeof s === "object") Object.keys(prefs).forEach(function (k) { if (typeof s[k] === "string") prefs[k] = s[k]; }); } catch (e) { /* без збережень */ }
    if (["bot", "avg"].indexOf(prefs.mode) < 0) prefs.mode = "bot";
    if (["pct", "usd", "log"].indexOf(prefs.unit) < 0) prefs.unit = "pct";
    if (!(prefs.period in D.PERIODS)) prefs.period = "all";
    if (["curve", "daily"].indexOf(prefs.view) < 0) prefs.view = "curve";
    if (["round", "all"].indexOf(prefs.scope) < 0) prefs.scope = "round";
    let focus = parseInt(params.get("wallet"), 10) || null;
    const urlDetail = parseInt(params.get("detail"), 10) || null;
    const urlBot = params.get("bot");
    let model = null, loadError = null, trader = null, traderErr = null, hidden = {}, chart = null, feed = null, timer = 0, destroyed = false, lastOk = 0, detailCap = null, prices = {}, pricesAt = null, priceTimer = 0, priceLoopOn = false;
    let extra = { ops: [], notes: { fromEvents: 0, fromFeed: 0, fromArchive: 0, both: 0, withArchive: 0, skipped: 0 }, comp: null, feedOpen: [], eventsLoaded: 0, feedLoaded: false, ready: false };
    let arch = { status: "idle", index: null, segs: {}, errors: [], needed: 0, names: [], reason: "" }, rawBy = {}, rawFeed = null, archReq = 0;
    const tbl = { wallet: "", bot: "", onlyOpen: false, q: "", sort: "resultPct", dir: "desc" }, hist = { wallet: "", bot: "", coin: "", type: "", period: "round", shown: 50 }, qf = { wallet: "", bot: "", status: "" }, ef = { wallet: "", bot: "", shown: 25 }, dtbl = { sort: "resultPct", dir: "desc" };
    let capTab = null;
    const ui = {};

    host.replaceChildren();
    host.classList.add("wl-page");
    // ---------- каркас ----------
    const bar = h("div", "wl-bar");
    const modeBox = h("div", "wl-seg"); modeBox.setAttribute("role", "group"); modeBox.setAttribute("aria-label", "Режим аналітики");
    [["bot", "Вибраний бот"], ["avg", "Середнє по ботах"]].forEach(function (m) { const b = h("button", "wl-btn", m[1]); b.type = "button"; b.setAttribute("data-mode", m[0]); b.addEventListener("click", function () { prefs.mode = m[0]; changed(true); }); modeBox.appendChild(b); });
    ui.modeBtns = modeBox.querySelectorAll("button");
    const botBox = h("label", "wl-bot"); botBox.appendChild(h("span", "wl-lbl", "Бот"));
    ui.bot = document.createElement("select"); ui.bot.setAttribute("aria-label", "Бот"); botBox.appendChild(ui.bot);
    ui.bot.addEventListener("change", function () { prefs.bot = ui.bot.value; changed(true); });
    const meta = h("div", "wl-meta"); ui.updated = h("span", "wl-updated", "Завантаження…"); ui.events = h("div", "wl-events"); meta.appendChild(ui.updated); meta.appendChild(ui.events);
    bar.appendChild(modeBox); bar.appendChild(botBox); bar.appendChild(meta);
    ui.note = h("p", "wl-note"); ui.focusNote = h("p", "wl-focus"); ui.focusNote.hidden = true;
    ui.err = h("p", "wl-error"); ui.err.hidden = true; ui.err.setAttribute("role", "alert");

    const card = h("div", "wl-card wl-main"); card.id = "wlChartCard";
    const tools = h("div", "wl-tools");
    const unitBox = h("div", "wl-seg"); unitBox.setAttribute("role", "group"); unitBox.setAttribute("aria-label", "Шкала");
    [["pct", "Дохідність, %"], ["usd", "Капітал, $"], ["log", "$ лог."]].forEach(function (u) { const b = h("button", "wl-btn", u[1]); b.type = "button"; b.setAttribute("data-unit", u[0]); b.addEventListener("click", function () { if (b.disabled) return; prefs.unit = u[0]; changed(true); }); unitBox.appendChild(b); });
    const viewBox = h("div", "wl-seg"); viewBox.setAttribute("role", "group"); viewBox.setAttribute("aria-label", "Частота даних");
    [["curve", "Криві"], ["daily", "Денні"]].forEach(function (u) { const b = h("button", "wl-btn", u[1]); b.type = "button"; b.setAttribute("data-view", u[0]); b.addEventListener("click", function () { prefs.view = u[0]; changed(true); }); viewBox.appendChild(b); });
    tools.appendChild(unitBox); tools.appendChild(viewBox);
    const perBox = h("div", "wl-seg wl-periods"); perBox.setAttribute("role", "group"); perBox.setAttribute("aria-label", "Період");
    PERIOD_LABELS.forEach(function (p) { const b = h("button", "wl-btn", p[1]); b.type = "button"; b.setAttribute("data-period", p[0]); b.addEventListener("click", function () { prefs.period = p[0]; changed(true); }); perBox.appendChild(b); });
    const legend = h("div", "wl-legend"); ui.legend = legend;
    const resetBtn = h("button", "wl-btn wl-reset", "Скинути масштаб"); resetBtn.type = "button"; resetBtn.hidden = true; resetBtn.addEventListener("click", function () { if (chart) chart.reset(); });
    const chartHost = h("div", "wl-chart-host"); ui.chartHost = chartHost;
    ui.caption = h("p", "wl-caption"); ui.gaps = h("p", "wl-gapnote");
    const head = h("div", "wl-card-h"); head.appendChild(h("h2", "wl-h2", "Динаміка гаманців")); head.appendChild(resetBtn);
    card.appendChild(head); card.appendChild(tools); card.appendChild(perBox); card.appendChild(legend); card.appendChild(chartHost); card.appendChild(ui.caption); card.appendChild(ui.gaps);

    // KPI над графіком
    const kpiBox = h("div", "wl-kpi-wrap"); ui.kpiGrid = h("div", "wl-kpi"); ui.kpiBadges = h("div", "wl-badges"); kpiBox.appendChild(ui.kpiGrid); kpiBox.appendChild(ui.kpiBadges);
    // три картки гаманців і деталізація
    const cardsSec = h("div", "wl-cards-sec"); cardsSec.id = "wlCards"; cardsSec.appendChild(h("h2", "wl-h2", "Гаманці")); ui.cards = h("div", "wl-cards"); cardsSec.appendChild(ui.cards);
    ui.detail = h("div", "wl-card wl-detail"); ui.detail.id = "wlDetail"; ui.detail.hidden = true; ui.detail.setAttribute("role", "region"); ui.detail.setAttribute("aria-label", "Деталі гаманця");
    // блоки статистики (картки — div, не section: глобальні правила section сюди не діють)
    function block(id, title, note, kind) {
      const c = h("div", "wl-card wl-block"); c.id = id; const head = h("div", "wl-card-h"); head.appendChild(h("h2", "wl-h2", title));
      if (kind) { const b = h("button", "wl-btn wl-export", "Експорт CSV"); b.type = "button"; b.setAttribute("data-export", kind); b.setAttribute("aria-label", "Експортувати в CSV: " + title); b.title = "Завантажити CSV для Excel з урахуванням поточних фільтрів"; b.addEventListener("click", function () { doExport(kind); }); head.appendChild(b); }
      c.appendChild(head); if (note) c.appendChild(h("p", "wl-muted wl-small wl-bnote", note)); const body = h("div", "wl-bbody"); c.appendChild(body); return { card: c, body: body }; }
    const bCmp = block("wlCompare", "Порівняння результатів між гаманцями", "Дохідність кожного бота в трьох незалежних гаманцях, у % від депозиту поточного раунду."), bTbl = block("wlTable", "Статистика ботів: 16 ботів × 3 гаманці = 48 незалежних рахунків", "", "bots"),
      bQual = block("wlQuality", "Підтверджені угоди та реалізований PnL: 48 рахунків", "", "quality"), bCap = block("wlCapital", "Розподіл капіталу"), bHist = block("wlHistory", "Історія торгових операцій (архів Paper Trading)", "", "ops"), bExec = block("wlExec", "Фактичне виконання Stop Loss / Take Profit / Trailing Stop"), bRounds = block("wlRounds", "Підсумки попередніх раундів", "", "rounds"), bDaily = block("wlDaily", "Денні результати", "", "daily");
    ui.cmp = bCmp.body; ui.tbl = bTbl.body; ui.qual = bQual.body; ui.exec = bExec.body; ui.cap = bCap.body; ui.hist = bHist.body; ui.rounds = bRounds.body; ui.daily = bDaily.body;
    const tn = h("div", "wl-card wl-testnet"); tn.id = "wlTestnet"; tn.appendChild(h("h2", "wl-h2", "Binance Testnet")); ui.tn = h("p", "wl-muted", "Перевіряємо статус…"); tn.appendChild(ui.tn);
    tn.appendChild(h("p", "wl-muted wl-small", "Окремий тестовий режим: не входить у статистику віртуальних рахунків і ніколи не змішується з нею."));
    const disc = h("p", "wl-disc", "Це симуляція на віртуальних грошах: інформація, а не фінансова порада й не прогноз. Дані беруться зі збережених точок історії; прогалини не заповнюються.");
    [bar, ui.err, ui.note, ui.focusNote, kpiBox, card, cardsSec, ui.detail, bCmp.card, bTbl.card, bQual.card, bCap.card, bHist.card, bExec.card, bRounds.card, bDaily.card, tn, disc].forEach(function (n) { host.appendChild(n); });

    chart = root.WalletsChart.create(chartHost, { onView: function (z) { resetBtn.hidden = !z; } });

    // ---------- допоміжне ----------
    function persist() { try { env.storage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) { /* без збережень */ } }
    function ruleTitle(id) { const r = model && model.rules.filter(function (x) { return x.id === id; })[0]; return r ? r.title : id; }
    function query() { return { mode: prefs.mode, bot: prefs.bot }; }
    function changed(resetZoom) { persist(); render(!resetZoom); if (model) loadLive(); }

    function build() {                                                       // ряди, обрізані періодом; прогалини рахуються по всій серії
      const daily = prefs.view === "daily", now = env.now(), win = D.periodWindow(prefs.period, now), unit = prefs.unit === "pct" ? "pct" : "usd";
      const out = { series: [], daily: daily, allVals: [], first: Infinity, last: -Infinity, used: [], dropped: 0, gaps: 0 };
      model.caps.forEach(function (cap) {
        const src = daily ? D.dailySeries(model, query(), cap) : D.series(model, query(), cap), pts = src.points;
        pts.forEach(function (p) { out.allVals.push(cap * p.eq); });
        const sp = D.split(pts, D.gapThreshold(pts, daily)), segs = sp.segments.map(function (seg) { return (win ? D.clip(seg, win[0], win[1]) : seg).map(function (p) { return { t: p.t, eq: p.eq, v: D.value(p.eq, cap, unit) }; }); }).filter(function (s) { return s.length; });
        const gaps = sp.gaps.filter(function (g) { return !win || (g.b >= win[0] && g.a <= win[1]); });
        const n = segs.reduce(function (a, s) { return a + s.length; }, 0);
        out.series.push({ cap: cap, label: capLabel(cap), color: D.COLORS[cap] || "#9AA4B2", visible: !hidden[cap], segments: segs, gaps: gaps, cond: prefs.mode === "avg", n: n, total: pts.length, meta: src.meta, lastPt: pts[pts.length - 1] || null });
        out.used.push(n); out.dropped += src.meta.dropped; out.gaps += gaps.length;
        segs.forEach(function (s) { out.first = Math.min(out.first, s[0].t); out.last = Math.max(out.last, s[s.length - 1].t); });
      });
      out.win = win; out.now = now;
      return out;
    }

    function render(keepView) {
      ui.err.hidden = !loadError || !!model;
      if (loadError) ui.err.textContent = model ? "" : "Дані симуляції недоступні: " + loadError + ". Спробуємо ще раз за хвилину.";
      if (!model) { ui.updated.textContent = loadError ? "Немає даних" : "Завантаження…"; return; }
      const bots = model.rules;
      if (!prefs.bot || !bots.some(function (r) { return r.id === prefs.bot; })) prefs.bot = bots[0].id;
      if (ui.bot.dataset.k !== bots.map(function (r) { return r.id; }).join("|")) { ui.bot.replaceChildren(); bots.forEach(function (r) { const o = h("option", "", r.title); o.value = r.id; ui.bot.appendChild(o); }); ui.bot.dataset.k = bots.map(function (r) { return r.id; }).join("|"); }
      ui.bot.value = prefs.bot; ui.bot.disabled = prefs.mode === "avg";
      Array.prototype.forEach.call(ui.modeBtns, function (b) { const on = b.getAttribute("data-mode") === prefs.mode; b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("on", on); });
      ui.note.textContent = prefs.mode === "bot"
        ? "Бот «" + ruleTitle(prefs.bot) + "» у трьох незалежних симуляціях: кожен гаманець торгує окремо й стартує зі своєї суми. Сума початкових депозитів 100 + 1 000 + 10 000 = 11 100 $ — це не загальний капітал системи."
        : "Середня дохідність усіх " + bots.length + " ботів окремо для кожного розміру гаманця: це статистичний показник, а не баланс спільного рахунку. Дохідність у $ умовна: депозит × середня дохідність.";
      const b = build();
      const allPos = b.allVals.length > 0 && D.logAllowed(b.allVals);
      if (prefs.unit === "log" && !allPos) prefs.unit = "usd";
      if (prefs.unit === "log") { /* лог. шкала лише за додатних значень */ }
      host.querySelectorAll("[data-unit]").forEach(function (x) {
        const u = x.getAttribute("data-unit"), on = u === prefs.unit; x.setAttribute("aria-pressed", on ? "true" : "false"); x.classList.toggle("on", on);
        if (u === "log") { x.disabled = !allPos; x.title = allPos ? "Логарифмічна шкала в доларах" : "Логарифмічна шкала недоступна: є нульові або від'ємні значення"; }
      });
      host.querySelectorAll("[data-view]").forEach(function (x) { const on = x.getAttribute("data-view") === prefs.view; x.setAttribute("aria-pressed", on ? "true" : "false"); x.classList.toggle("on", on); });
      host.querySelectorAll("[data-period]").forEach(function (x) { const on = x.getAttribute("data-period") === prefs.period; x.setAttribute("aria-pressed", on ? "true" : "false"); x.classList.toggle("on", on); });
      // легенда: останнє збережене значення кожного гаманця (історія, не жива ціна)
      ui.legend.replaceChildren();
      b.series.forEach(function (s) {
        const chip = h("button", "wl-chip" + (hidden[s.cap] ? " off" : "") + (focus === s.cap ? " focus" : "")); chip.type = "button"; chip.setAttribute("aria-pressed", hidden[s.cap] ? "false" : "true"); chip.setAttribute("data-cap", s.cap);
        chip.title = "Показати або сховати лінію " + s.label;
        const dot = h("i", "wl-dot"); dot.style.background = s.color; chip.appendChild(dot); chip.appendChild(h("b", "", s.label));
        const lp = s.lastPt;
        chip.appendChild(h("span", "wl-chip-v", lp ? (s.cond ? "≈ " : "") + nf(s.cap * lp.eq, 2) + " $ · " + (lp.eq >= 1 ? "+" : "−") + nf(Math.abs((lp.eq - 1) * 100), 2) + "%" : "немає даних"));
        chip.addEventListener("click", function () { hidden[s.cap] = !hidden[s.cap]; render(true); });
        ui.legend.appendChild(chip);
      });
      const allHidden = b.series.every(function (s) { return !s.visible; });
      const first = b.first === Infinity ? now0() - 86400000 : b.first, last = b.last === -Infinity ? now0() : b.last;
      const domain = b.win ? { t0: b.win[0], t1: b.win[1] } : { t0: first, t1: last };
      const unitName = prefs.unit === "pct" ? "Дохідність у % від початкового депозиту" : prefs.unit === "usd" ? "Капітал у USD" : "Капітал у USD, логарифмічна шкала";
      const caption = (prefs.mode === "bot" ? "Вибраний бот: " + ruleTitle(prefs.bot) : "Середнє по " + bots.length + " ботах (умовний показник)") + " · " + unitName + " · " + (prefs.view === "daily" ? "денна частота (значення останнього запуску за добу)" : "збережені точки кривої") + " · поточний раунд";
      chart.set({ series: b.series, unit: prefs.unit, daily: b.daily, domain: domain, minSpan: b.daily ? 86400000 : 10 * 60000, roundStart: !b.daily ? roundStart() : null, focus: focus, caption: caption, keepView: !!keepView, showLeadGap: !b.daily,
        emptyText: allHidden ? "Усі лінії приховано: увімкніть їх у легенді." : "Немає історичних даних за цей період" });
      ui.caption.textContent = caption + (b.used.some(Boolean) ? " · точок у періоді: " + b.series.map(function (s) { return s.label + " — " + s.n; }).join(", ") : "");
      const notes = [];
      if (b.gaps) notes.push("Є прогалини в даних (" + b.gaps + "): вони позначені штрихуванням, лінії через них не з'єднуються.");
      if (prefs.mode === "avg" && b.dropped) notes.push("Середнє рахується лише в часових мітках, де є дані всіх ботів; пропущено міток: " + b.dropped + ".");
      if (b.last !== -Infinity && !b.daily) notes.push("Остання збережена точка: " + hhmm(b.last) + " (" + ago(b.last, env.now()) + ").");
      ui.gaps.textContent = notes.join(" ");
      ui.updated.textContent = model.updated ? "Дані оновлено " + ago(Date.parse(model.updated) || lastOk, env.now()) : "";
      ui.focusNote.hidden = !focus;
      if (focus) { ui.focusNote.replaceChildren(h("span", "", "Відкрито за посиланням: гаманець " + capLabel(focus) + " виділено, інші лінії приглушено. "));
        const x = h("button", "wl-link", "Показати всі однаково"); x.type = "button"; x.addEventListener("click", function () { focus = null; render(true); }); ui.focusNote.appendChild(x); }
      persist();
      renderKpi(); renderCards(); renderDetail(); renderExtra();
    }
    function now0() { return env.now(); }
    function roundStart() { const w = model.wallets[model.caps[0]]; return w && w.roundStart; }

    // ---------- KPI, картки, деталі ----------
    function sign(v) { return v >= 0 ? "+" : "−"; }
    function usdTxt(v) { return sign(v) + nf(Math.abs(v), 2) + " $"; }
    function pctTxt(v) { return sign(v) + nf(Math.abs(v), 2) + "%"; }
    function tone(v) { return v > 0.00001 ? "up" : v < -0.00001 ? "down" : ""; }
    function ddTxt(v) { return v < 0.005 ? "0,00%" : "−" + nf(v, 2) + "%"; }
    function dash(v, f) { return v === null || v === undefined ? "—" : f(v); }
    function svgEl(tag, a, parent) { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.keys(a || {}).forEach(function (k) { n.setAttribute(k, a[k]); }); if (parent) parent.appendChild(n); return n; }
    function tile(label, value, sub, cls) {
      const t = h("div", "wl-tile"); t.appendChild(h("span", "wl-tile-l", label)); t.appendChild(h("b", "wl-tile-v" + (cls ? " " + cls : ""), value)); t.appendChild(h("span", "wl-tile-s", sub)); ui.kpiGrid.appendChild(t);
    }
    function renderKpi() {
      const avg = prefs.mode === "avg", k = D.kpis(model, query()), c = avg ? "≈ " : "";
      ui.kpiGrid.replaceChildren(); ui.kpiBadges.replaceChildren();
      if (k.empty) { ["Сума рахунків", "Результат, $", "Дохідність, %", "Відкриті позиції", "Угоди", "Просідання"].forEach(function (l) { tile(l, "—", "Немає даних"); }); }
      else {
        const asOf = hhmm(k.asOf) + (k.mixedTimes ? " (останні точки гаманців різного часу)" : "") + (k.complete ? "" : "; дані є не для всіх гаманців");
        tile(avg ? "Умовна сума трьох середніх рахунків" : "Сума трьох рахунків бота", c + nf(k.sum, 2) + " $", "депозити " + nf(k.deposits, 0) + " $ · станом на " + asOf);
        tile("Результат", c + usdTxt(k.resultUsd), avg ? "умовно: депозит × середня дохідність" : "до суми початкових депозитів", tone(k.resultUsd));
        tile("Дохідність", pctTxt(k.resultPct), avg ? "середня за 16 ботами, зважена за депозитами" : "від суми початкових депозитів", tone(k.resultPct));
        tile(avg ? "Відкриті позиції, Σ" : "Відкриті позиції", dash(k.open, String), avg ? "сума по всіх ботах і гаманцях (не один рахунок)" : "сума по трьох рахунках");
        tile(avg ? "Угоди, Σ" : "Угоди", dash(k.trades, String), avg ? "сума по всіх ботах і гаманцях (не один рахунок)" : "сума по трьох рахунках, поточний раунд");
        tile("Просідання", k.dd === null ? "Немає даних" : ddTxt(k.dd), k.dd === null ? "немає спільних міток трьох рахунків" : "за кривою суми трьох рахунків (" + k.aggPoints + " спільних точок)", k.dd ? "down" : "");
      }
      ["Поточний раунд", "За збереженими даними", "Оцінка за дискретними точками"].concat(avg ? ["Умовний показник"] : []).forEach(function (b) { ui.kpiBadges.appendChild(h("span", "wl-badge", b)); });
    }
    function sparkNode(s, color) {                                      // мініграфік лише за збереженими точками; прогалини не з'єднуються
      const box = h("div", "wl-spark"), pts = s.points;
      if (pts.length < 2) { box.appendChild(h("span", "wl-muted wl-small", "Недостатньо точок для мініграфіка")); return box; }
      const W = 220, H = 52, thr = D.gapThreshold(pts, false), sp = D.split(pts, thr), t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      let lo = Math.min(1, Math.min.apply(null, pts.map(function (p) { return p.eq; }))), hi = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.eq; })));
      if (hi - lo < 1e-9) { hi += 0.0005; lo -= 0.0005; }
      const X = function (t) { return 3 + (t - t0) / (t1 - t0 || 1) * (W - 6); }, Y = function (e) { return 4 + (hi - e) / (hi - lo) * (H - 8); };
      const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "wl-spark-svg", role: "img", "aria-label": "Мініграфік " + capLabel(s.cap) }, box);
      svgEl("line", { x1: 0, x2: W, y1: Y(1), y2: Y(1), class: "wl-spark-base" }, svg);
      sp.segments.forEach(function (seg) { if (seg.length > 1) svgEl("polyline", { points: seg.map(function (p) { return X(p.t).toFixed(1) + "," + Y(p.eq).toFixed(1); }).join(" "), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", class: "wl-spark-line" }, svg); });
      return box;
    }
    function liveLine(s) {                                              // жива оцінка ОКРЕМО від збереженої: історію й мініграфік не змінює
      const box = h("div", "wl-live"), avg = prefs.mode === "avg", fresh = pricesAt !== null && env.now() - pricesAt < 90000, lw = fresh ? D.liveWallet(model, query(), s.cap, prices) : null;
      if (!s.last) return box;
      if (!fresh || !lw) { box.appendChild(h("span", "wl-live-l wl-muted", "Живі ціни недоступні: показано останню збережену оцінку (" + hhmm(s.last.t) + ").")); return box; }
      if (lw.open === 0) { box.appendChild(h("span", "wl-live-l wl-muted", "Відкритих позицій немає: поточна оцінка збігається зі збереженою.")); return box; }
      if (!lw.complete) { box.appendChild(h("span", "wl-live-l wl-muted", "Живі ціни є не для всіх відкритих позицій: поточна оцінка недоступна, показано збережену (" + hhmm(s.last.t) + ").")); return box; }
      box.appendChild(h("span", "wl-live-l", "Поточна оцінка за ринковою ціною"));
      const v = s.cap * lw.eq, pc = (lw.eq - 1) * 100;
      box.appendChild(h("b", "wl-live-v " + tone(pc), (avg ? "≈ " : "") + nf(v, 2) + " $ · " + pctTxt(pc)));
      box.appendChild(h("span", "wl-live-s wl-muted", "ціни Binance о " + new Date(pricesAt).toLocaleTimeString("uk-UA") + (avg ? " · умовно" : "")));
      return box;
    }
    function renderCards() {
      const avg = prefs.mode === "avg", c = avg ? "≈ " : "";
      ui.cards.replaceChildren();
      model.caps.forEach(function (cap) {
        const s = D.walletStats(model, query(), cap), color = D.COLORS[cap] || "#9AA4B2";
        const card = h("div", "wl-wcard" + (detailCap === cap ? " sel" : "") + (focus === cap ? " focus" : "")); card.style.setProperty("--wc", color);
        card.setAttribute("role", "button"); card.tabIndex = 0; card.setAttribute("aria-expanded", detailCap === cap ? "true" : "false"); card.setAttribute("aria-controls", "wlDetail"); card.setAttribute("data-cap", cap);
        card.setAttribute("aria-label", "Гаманець " + capLabel(cap) + (s.last ? ": " + c + nf(s.value, 2) + " $, " + pctTxt(s.resultPct) : ": даних немає") + ". Натисніть, щоб показати деталі");
        const head = h("div", "wl-wc-h"); head.appendChild(h("span", "wl-wc-t", capLabel(cap))); head.appendChild(h("span", "wl-wc-coins", s.coins.join(" · "))); card.appendChild(head);
        if (!s.last) { card.appendChild(h("p", "wl-muted", "Немає збережених точок для цього гаманця.")); ui.cards.appendChild(card); wire(card, cap); return; }
        card.appendChild(h("span", "wl-wc-l", avg ? "Умовна вартість (середня дохідність 16 ботів)" : "Остання збережена вартість рахунку"));
        card.appendChild(h("b", "wl-wc-v", c + nf(s.value, 2) + " $"));
        card.appendChild(h("div", "wl-wc-r " + tone(s.resultPct), c + usdTxt(s.resultUsd) + " · " + pctTxt(s.resultPct)));
        const g = h("div", "wl-wc-g");
        [["Початковий депозит", nf(cap, 0) + " $"], [avg ? "Угоди, Σ 16 ботів" : "Угоди", dash(s.trades, String)], [avg ? "Відкриті позиції, Σ" : "Відкриті позиції", dash(s.open, String)], ["Макс. просідання", s.dd === null ? "—" : ddTxt(s.dd)], ["Оновлено", hhmm(s.last.t)]].forEach(function (x) {
          const cell = h("div", "wl-wc-c"); cell.appendChild(h("span", "wl-wc-cl", x[0])); cell.appendChild(h("b", "", x[1])); g.appendChild(cell);
        });
        card.appendChild(g); card.appendChild(sparkNode(s, color)); card.appendChild(liveLine(s));
        if (avg) card.appendChild(h("p", "wl-wc-note", "Агрегована статистика 16 незалежних симуляцій; сума угод і позицій — не показник одного рахунку."));
        ui.cards.appendChild(card); wire(card, cap);
      });
    }
    function wire(card, cap) {
      const open = function () { detailCap = detailCap === cap ? null : cap; renderCards(); renderDetail(); const again = ui.cards.querySelector('[data-cap="' + cap + '"]'); if (detailCap === cap && ui.detail.querySelector(".wl-detail-h")) ui.detail.querySelector(".wl-detail-h").focus(); else if (again) again.focus(); };
      card.addEventListener("click", open);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
    function renderDetail() {
      ui.detail.hidden = !detailCap; ui.detail.replaceChildren();
      if (!detailCap || !model) return;
      const s = D.walletStats(model, query(), detailCap), avg = prefs.mode === "avg", c = avg ? "≈ " : "", w = model.wallets[detailCap];
      const head = h("div", "wl-card-h"), t = h("h2", "wl-h2 wl-detail-h", "Деталі: гаманець " + capLabel(detailCap)); t.tabIndex = -1; head.appendChild(t);
      const close = h("button", "wl-btn", "Закрити"); close.type = "button"; close.setAttribute("aria-label", "Закрити деталі гаманця"); close.addEventListener("click", function () { const cap = detailCap; detailCap = null; renderCards(); renderDetail(); const cd = ui.cards.querySelector('[data-cap="' + cap + '"]'); if (cd) cd.focus(); }); head.appendChild(close); ui.detail.appendChild(head);
      const dl = h("dl", "wl-dl");
      function row(k, v) { if (v === null || v === undefined || v === "") return; dl.appendChild(h("dt", "", k)); dl.appendChild(h("dd", "", String(v))); }
      row("Режим", avg ? "Середнє по " + s.bots + " ботах (статистика, не баланс)" : "Бот: " + ruleTitle(prefs.bot));
      row("Початковий депозит", nf(detailCap, 0) + " $"); row("Монети гаманця", s.coins.join(", "));
      if (s.last) {
        row(avg ? "Умовна вартість" : "Остання збережена вартість", c + nf(s.value, 2) + " $ (" + hhmm(s.last.t) + ")"); row("Результат", c + usdTxt(s.resultUsd) + " · " + pctTxt(s.resultPct));
        row("Максимальне просідання", s.dd === null ? "немає даних" : ddTxt(s.dd) + " (оцінка за дискретними точками" + (avg ? ", за середньою кривою" : "") + ")");
        row(avg ? "Угоди (сума по ботах)" : "Угоди в поточному раунді", dash(s.trades, String)); row(avg ? "Відкриті позиції (сума по ботах)" : "Відкриті позиції", dash(s.open, String));
        if (!avg) row("Монети в позиції", s.openCoins.length ? s.openCoins.join(", ") : "позицій немає");
        row("Збережених точок історії", s.points.length + " (від " + hhmm(s.first.t) + " до " + hhmm(s.last.t) + ")");
        if (avg) row("Мітки для середнього", "використано " + s.meta.used + ", відкинуто " + s.meta.dropped + " (бракує даних хоча б одного бота)");
      } else row("Історія", "немає збережених точок");
      row("Поточний раунд", w && w.roundStart ? hhmm(w.roundStart) + (w.roundEnd ? " — " + hhmm(w.roundEnd) : "") : null); row("Денних значень збережено", s.dailyDays);
      const lw = pricesAt !== null && env.now() - pricesAt < 90000 ? D.liveWallet(model, query(), detailCap, prices) : null;
      row("Поточна оцінка за ринковою ціною", lw && lw.open > 0 && lw.complete ? (avg ? "≈ " : "") + nf(detailCap * lw.eq, 2) + " $ · " + pctTxt((lw.eq - 1) * 100) + " (окремо від історії)" : (lw && lw.open === 0 ? "позицій немає: збігається зі збереженою" : "недоступна (немає живих цін для всіх відкритих позицій)"));
      if (lw && lw.open > 0 && lw.complete && s.last) { const diff = detailCap * lw.eq - s.value; row("Різниця: жива оцінка − збережена вартість", (avg ? "≈ " : "") + usdTxt(diff) + " (" + sign(diff) + nf(Math.abs(diff / detailCap * 100), 2) + "% від депозиту) — рух ціни відкритих позицій після останнього збереженого запуску агента; історія не змінюється"); }
      ui.detail.appendChild(dl);
      renderDetailExtra(detailCap);
    }

    // ---------- Статистика ботів, капітал, історія, раунди, денні ----------
    const EXIT = { stop: "Stop Loss", take: "Take Profit", trail: "Трейлінг-стоп", trend: "Злам тренду", signal: "Сигнал правила", unknown: "причина не вказана" };
    function rows() { return D.accountRows(model, extra.ops, prefs.scope); }
    function wrapTable(table) { const w = h("div", "wl-tw"); w.setAttribute("tabindex", "0"); w.setAttribute("role", "region"); w.setAttribute("aria-label", "Таблиця: прокручується всередині блоку"); w.appendChild(table); return w; }
    function sel(label, opts, cur, onChange) {
      const l = h("label", "wl-fl"); l.appendChild(h("span", "wl-lbl", label)); const x = document.createElement("select"); x.setAttribute("aria-label", label);
      opts.forEach(function (o) { const e = h("option", "", o[1]); e.value = o[0]; x.appendChild(e); }); x.value = cur; x.addEventListener("change", function () { onChange(x.value); }); l.appendChild(x); return l;
    }
    function botOpts(first) { return [["", first]].concat(model.rules.map(function (r) { return [r.id, r.title]; })); }
    function walletOpts(first) { return [["", first]].concat(model.caps.map(function (c) { return [String(c), capLabel(c)]; })); }
    function numCell(tr, text, cls, title) { const td = h("td", "wl-num" + (cls ? " " + cls : ""), text); if (title) td.title = title; tr.appendChild(td); return td; }

    const COLS = [["title", "Бот", false], ["wallet", "Гаманець", true], ["value", "Вартість", true], ["resultUsd", "P/L, $", true], ["resultPct", "Дохідність", true], ["trades", "Угоди", true], ["open", "Позиції", true], ["dd", "Макс. просідання", true], ["winRate", "Win Rate*", true], ["realized", "Реалізований PnL*", true]];
    function botsTable(list, st, fixedWallet, onSort) {
      const t = h("table", "wl-tbl"), thead = h("thead"), tr = h("tr");
      COLS.forEach(function (c) {
        if (fixedWallet && c[0] === "wallet") return;
        const th = h("th", c[2] ? "wl-num" : ""), b = h("button", "wl-th", c[1]); b.type = "button"; b.setAttribute("data-sort", c[0]);
        th.setAttribute("aria-sort", st.sort === c[0] ? (st.dir === "asc" ? "ascending" : "descending") : "none"); if (st.sort === c[0]) b.textContent = c[1] + (st.dir === "asc" ? " ▲" : " ▼");
        b.addEventListener("click", function () { if (st.sort === c[0]) st.dir = st.dir === "asc" ? "desc" : "asc"; else { st.sort = c[0]; st.dir = c[0] === "title" ? "asc" : "desc"; } onSort(); });
        th.appendChild(b); tr.appendChild(th);
      });
      thead.appendChild(tr); t.appendChild(thead);
      const tb = h("tbody");
      sortRowsView(list, st).forEach(function (r) {
        const row = h("tr", "wl-r" + (r.bot === prefs.bot ? " sel" : "") + (r.hasData ? "" : " nodata")); row.setAttribute("data-bot", r.bot); row.setAttribute("data-wallet", r.wallet);
        const td = h("td", "wl-bn"), pick = h("button", "wl-link", r.title); pick.type = "button"; pick.title = "Показати цього бота на графіку й у картках"; pick.addEventListener("click", function () { prefs.mode = "bot"; prefs.bot = r.bot; changed(true); }); td.appendChild(pick); row.appendChild(td);
        if (!fixedWallet) row.appendChild(h("td", "wl-num", capLabel(r.wallet)));
        if (!r.hasData) { const c = h("td", "wl-muted", "Немає збережених точок"); c.colSpan = COLS.length - 1 - (fixedWallet ? 1 : 0); row.appendChild(c); tb.appendChild(row); return; }
        numCell(row, nf(r.value, 2) + " $"); numCell(row, usdTxt(r.resultUsd), tone(r.resultPct)); numCell(row, pctTxt(r.resultPct), tone(r.resultPct));
        numCell(row, dash(r.trades, String)); numCell(row, dash(r.open, String)); numCell(row, r.dd === null ? "—" : ddTxt(r.dd));
        const wc = winCell(r); numCell(row, wc[0], wc[1], wc[2]); const pc2 = pnlCell(r); numCell(row, pc2[0], pc2[1], pc2[2]);
        tb.appendChild(row);
      });
      if (!tb.children.length) { const r = h("tr"), c = h("td", "wl-muted", "За вибраними фільтрами рахунків немає."); c.colSpan = COLS.length; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb); return t;
    }
    // Win Rate й реалізований PnL: завжди з позначкою повноти; без доказу повноти й без закриттів — «Недостатньо даних» (не 0 %)
    function winCell(r) {
      if (r.status === "insufficient") return ["Недостатньо даних", "wl-muted", "Немає ні доказу повноти історії, ні підтверджених закриттів з відомим результатом"];
      if (r.noClosed) return ["Закритих угод немає", "wl-muted", "Історія повна: за цей період угоди не закривалися"];
      return [nf(r.winRate, 0) + "% (" + r.wins + "/" + r.closed + ") · " + (r.status === "full" ? "повні дані" : "часткові"), tone(r.winRate - 50), (r.status === "full" ? "Повні дані: кількість підтверджених угод збігається з лічильником рушія. " : "Часткові дані: частина історії відсутня, Win Rate лише за " + r.closed + " підтвердженими закриттями. ") + "Закриття без відомого відкриття не рахуються."];
    }
    function pnlCell(r) {
      if (r.status === "insufficient") return ["Недостатньо даних", "wl-muted", ""];
      if (r.noClosed) return ["—", "wl-muted", "Закритих угод немає"];
      return [usdTxt(r.realized) + (r.status === "full" ? "" : " · часткові"), tone(r.realized), "Сума підтверджених закритих угод (" + r.closed + "), чиста з комісіями"];
    }
    function sortRowsView(list, st) { return D.sortRows(list, st.sort, st.dir); }
    function tableNote() { return h("p", "wl-muted wl-small", "* Область: " + (prefs.scope === "all" ? "усі завантажені раунди" : "поточний раунд") + ". Win Rate і реалізований PnL — лише за підтвердженими закриттями. «Повні дані» — кількість підтверджених подій збігається з лічильником угод рушія; «часткові» — частина історії відсутня; «Недостатньо даних» — показник неможливо коректно розрахувати (це не 0%). Реалізований PnL не додається до вартості рахунку: вона вже враховує всі угоди. Докладніше — у блоці «Підтверджені угоди та реалізований PnL»."); }

    function renderCompare() {
      const rs = rows(), by = {}; rs.forEach(function (r) { (by[r.bot] = by[r.bot] || {})[r.wallet] = r; });
      const t = h("table", "wl-tbl wl-cmp"), hr = h("tr"); hr.appendChild(h("th", "", "Бот")); model.caps.forEach(function (c) { hr.appendChild(h("th", "wl-num", capLabel(c))); }); hr.appendChild(h("th", "wl-num", "Середнє"));
      t.appendChild(h("thead")).appendChild(hr);
      const all = rs.filter(function (r) { return r.hasData; }).map(function (r) { return Math.abs(r.resultPct); }), mx = Math.max(0.05, all.length ? Math.max.apply(null, all) : 0.05), tb = h("tbody");
      model.rules.forEach(function (r) {
        const tr = h("tr", "wl-r" + (r.id === prefs.bot ? " sel" : "")); const td = h("td", "wl-bn"), b = h("button", "wl-link", r.title); b.type = "button"; b.addEventListener("click", function () { prefs.mode = "bot"; prefs.bot = r.id; changed(true); }); td.appendChild(b); tr.appendChild(td);
        const vals = [];
        model.caps.forEach(function (c) { const x = by[r.id] && by[r.id][c], td2 = h("td", "wl-num " + (x && x.hasData ? tone(x.resultPct) : "wl-muted"), x && x.hasData ? pctTxt(x.resultPct) : "—"); if (x && x.hasData) { vals.push(x.resultPct); td2.style.background = (x.resultPct >= 0 ? "rgba(14,203,129," : "rgba(246,70,93,") + (Math.min(1, Math.abs(x.resultPct) / mx) * 0.28).toFixed(2) + ")"; } tr.appendChild(td2); });
        const m = vals.length ? vals.reduce(function (a, b2) { return a + b2; }, 0) / vals.length : null; tr.appendChild(h("td", "wl-num wl-avg " + (m === null ? "wl-muted" : tone(m)), m === null ? "—" : pctTxt(m))); tb.appendChild(tr);
      });
      t.appendChild(tb); ui.cmp.replaceChildren(wrapTable(t), h("p", "wl-muted wl-small", "Середнє — арифметичне трьох незалежних результатів (не результат спільного рахунку)."));
    }
    function renderTable() {
      const bar = h("div", "wl-filters");
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), tbl.wallet, function (v) { tbl.wallet = v; renderTable(); }));
      bar.appendChild(sel("Бот", botOpts("Усі боти"), tbl.bot, function (v) { tbl.bot = v; renderTable(); }));
      const q = document.createElement("input"); q.type = "search"; q.placeholder = "Пошук за назвою бота"; q.value = tbl.q; q.setAttribute("aria-label", "Пошук за назвою бота"); q.className = "wl-search";
      q.addEventListener("input", function () { tbl.q = q.value; renderTableBody(); }); const ql = h("label", "wl-fl"); ql.appendChild(h("span", "wl-lbl", "Пошук")); ql.appendChild(q); bar.appendChild(ql);
      const ck = h("label", "wl-fl wl-ck"), cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = tbl.onlyOpen; cb.addEventListener("change", function () { tbl.onlyOpen = cb.checked; renderTableBody(); }); ck.appendChild(cb); ck.appendChild(h("span", "", "Лише з відкритими позиціями")); bar.appendChild(ck);
      ui.tblBody = h("div", "wl-tbody-wrap"); ui.tbl.replaceChildren(bar, ui.tblBody); renderTableBody();
    }
    function renderTableBody() {
      const list = D.filterRows(rows(), tbl), box = ui.tblBody; box.replaceChildren();
      box.appendChild(h("p", "wl-muted wl-small", "Показано " + list.length + " із " + model.caps.length * model.rules.length + " незалежних рахунків (кожен бот у кожному гаманці торгує окремо). Таблиця однакова в обох режимах: це окремі рахунки, а не спільний."));
      box.appendChild(wrapTable(botsTable(list, tbl, false, renderTableBody))); box.appendChild(tableNote());
    }

    // розподіл капіталу
    function capBar(sp) {
      const bar = h("div", "wl-capbar"); bar.setAttribute("role", "img"); bar.setAttribute("aria-label", "У позиціях " + nf(sp.shareInPos * 100, 1) + "%, готівка " + nf(sp.shareCash * 100, 1) + "%");
      const a = h("i", "wl-cap-pos"), b = h("i", "wl-cap-cash"); a.style.width = (sp.shareInPos * 100).toFixed(2) + "%"; b.style.width = (sp.shareCash * 100).toFixed(2) + "%"; bar.appendChild(a); bar.appendChild(b); return bar;
    }
    function capitalNode(cap) {
      const box = h("div", "wl-capital"), avg = prefs.mode === "avg", sp = avg ? D.capitalSplitAvg(model, cap, extra.ops) : D.capitalSplit(model, prefs.bot, cap, extra.ops), c = avg ? "≈ " : "";
      if (!sp || !sp.available) { box.appendChild(h("p", "wl-muted", "Розподіл недоступний: " + (sp ? sp.reason : "немає даних рахунку") + ".")); return box; }
      box.appendChild(h("p", "wl-muted wl-small", avg ? "Середнє по " + sp.n + " незалежних рахунках гаманця " + capLabel(cap) + " (умовно): це не один спільний рахунок." : "Рахунок: гаманець " + capLabel(cap) + ", бот «" + ruleTitle(prefs.bot) + "». Станом на останню збережену точку."));
      box.appendChild(capBar(sp));
      const leg = h("div", "wl-caplegend"); [["wl-cap-pos", "У відкритих позиціях", sp.inPos, sp.shareInPos], ["wl-cap-cash", "Вільні кошти (готівка частки без позиції)", sp.cash, sp.shareCash]].forEach(function (x) { const it = h("span", "wl-capleg"), d = h("i", x[0]); it.appendChild(d); it.appendChild(h("span", "", x[1] + ": " + c + nf(x[2], 2) + " $ (" + nf(x[3] * 100, 1) + "%)")); leg.appendChild(it); }); box.appendChild(leg);
      const dl = h("dl", "wl-dl"); function row(k, v) { dl.appendChild(h("dt", "", k)); dl.appendChild(h("dd", "", v)); }
      row("Початковий депозит", nf(cap, 0) + " $"); row("Остання збережена вартість", c + nf(sp.value, 2) + " $"); row("Результат поточного раунду", c + usdTxt(sp.resultUsd) + " · " + pctTxt(sp.resultPct));
      if (!avg) {
        row("Реалізований PnL", sp.realized === null ? "Немає даних (збережених закриттів немає)" : usdTxt(sp.realized) + " — за збереженими закриттями (" + sp.realizedN + ")");
        row("Нереалізований PnL", sp.unrealized === null ? "Недостатньо даних: немає запису про відкриття всіх відкритих позицій" : usdTxt(sp.unrealized) + (sp.openCoins.length ? " (" + sp.openCoins.length + " відкритих позицій, за збереженою оцінкою)" : " (позицій немає)"));
        if (sp.openCoins.length) row("Відкриті позиції", sp.openCoins.map(function (x) { return x.coin; }).join(", "));
      }
      box.appendChild(dl);
      box.appendChild(h("p", "wl-muted wl-small", "Готівка — частина гаманця без відкритої позиції (так працює рушій: вартість монети поза позицією не залежить від ціни). Реалізований і нереалізований PnL — окремі оцінки за збереженими подіями; вони не додаються до вартості рахунку й у сумі не обов'язково дорівнюють результату (витрати на комісії, неповна історія)."));
      return box;
    }
    function renderCapital() {
      const cap = capTab || detailCap || model.midCap, tabs = h("div", "wl-seg"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Гаманець для розподілу капіталу");
      model.caps.forEach(function (c) { const b = h("button", "wl-btn" + (c === cap ? " on" : ""), capLabel(c)); b.type = "button"; b.setAttribute("aria-pressed", c === cap ? "true" : "false"); b.setAttribute("data-cap", c); b.addEventListener("click", function () { capTab = c; renderCapital(); }); tabs.appendChild(b); });
      ui.cap.replaceChildren(tabs, capitalNode(cap));
    }

    // ---------- область показників і стан архіву ----------
    function scopeControl(onDone) {
      const box = h("div", "wl-seg wl-scope"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Область показників");
      [["round", "Поточний раунд"], ["all", "Усі завантажені раунди"]].forEach(function (x) {
        const b = h("button", "wl-btn" + (prefs.scope === x[0] ? " on" : ""), x[1]); b.type = "button"; b.setAttribute("data-scope", x[0]); b.setAttribute("aria-pressed", prefs.scope === x[0] ? "true" : "false");
        b.addEventListener("click", function () { if (prefs.scope === x[0]) return; prefs.scope = x[0]; persist(); ensureArchive(); renderExtra(); if (onDone) onDone(); }); box.appendChild(b);
      });
      return box;
    }
    function archiveStatusNode() {
      const box = h("div", "wl-arch"); box.setAttribute("role", "status");
      if (!extra.ready || arch.status === "idle" || arch.status === "loading") { box.appendChild(h("p", "wl-muted wl-small", !extra.ready ? "Завантаження журналів подій…" : "Завантаження архіву Paper Trading…" + (arch.needed ? " (сегментів: " + arch.needed + ")" : ""))); return box; }
      if (arch.status === "error") { box.appendChild(h("p", "wl-warn wl-small", "Архів недоступний (" + arch.reason + "): показано лише журнали paper_events і live_feed. Історія за цей період неповна, доказу повноти немає.")); return box; }
      const idx = arch.index, got = arch.names.length;
      box.appendChild(h("p", "wl-muted wl-small", "Архів: " + idx.total + " подій у " + idx.segments.length + " сегм.; завантажено " + got + " з " + idx.segments.length + " (лише потрібні для вибраного періоду)" + (idx.sizeWarning ? "; архів уже великий: завантаження повного періоду може бути повільним" : "") + "."));
      arch.errors.forEach(function (e) { box.appendChild(h("p", "wl-warn wl-small", "Сегмент " + e.name + " недоступний або пошкоджений (" + e.msg + "): операції за цей період неповні.")); });
      return box;
    }
    function complBadge(st, tip) { const b = h("span", "wl-cb wl-cb-" + st, D.COMPL_TXT[st] || st); if (tip) b.title = tip; return b; }

    // ---------- Підтверджені угоди та реалізований PnL ----------
    function qualityList() { return D.sortRows(D.filterRows(rows(), qf), "wallet", "asc"); }
    function qualityTable(list) {
      const t = h("table", "wl-tbl wl-qual"), hr = h("tr");
      ["Бот", "Гаманець", "Повнота", "Закриті (приб./збит.)", "Win Rate", "Реалізований PnL", "Середній результат", "Комісії й проковзання", "Операцій / угод рушія"].forEach(function (x, i) { hr.appendChild(h("th", i >= 3 ? "wl-num" : "", x)); });
      t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      list.forEach(function (r) {
        const tr = h("tr", "wl-r"); tr.setAttribute("data-bot", r.bot); tr.setAttribute("data-wallet", r.wallet); tr.setAttribute("data-status", r.status);
        const lab = function (td, k) { td.setAttribute("data-label", k); return td; };
        const bq = h("td", "wl-botc", r.title); bq.title = r.title; tr.appendChild(lab(bq, "Бот")); tr.appendChild(lab(h("td", "", capLabel(r.wallet)), "Гаманець"));
        const tdc = h("td", ""); tdc.appendChild(complBadge(r.status, r.status === "full" ? "Кількість підтверджених подій збігається з лічильником угод рушія" : r.status === "partial" ? "Частина історії відсутня" : "Неможливо коректно розрахувати")); tr.appendChild(lab(tdc, "Повнота"));
        const wc = winCell(r), pcl = pnlCell(r);
        lab(numCell(tr, r.status === "insufficient" ? "—" : r.closed + " (" + r.wins + "/" + r.losses + (r.flat ? "/" + r.flat : "") + ")", r.status === "insufficient" ? "wl-muted" : ""), "Закриті (приб./збит.)");
        lab(numCell(tr, wc[0].replace(/ · (повні дані|часткові)$/, ""), wc[1], wc[2]), "Win Rate"); lab(numCell(tr, pcl[0].replace(/ · часткові$/, ""), pcl[1], pcl[2]), "Реалізований PnL");
        lab(numCell(tr, r.avgUsd === null ? "—" : usdTxt(r.avgUsd) + " · " + pctTxt(r.avgPct), r.avgUsd === null ? "wl-muted" : tone(r.avgUsd), "Середнє арифметичне чистих результатів закритих угод" + (r.pctEst ? ". Для " + r.pctEst + " угод витрати входу невідомі: відсоток оцінено за комісією моделі (результат у $ від цього не залежить)" : "")), "Середній результат");
        lab(numCell(tr, r.feeUsd === null ? "—" : (r.feeMissing ? "≥ " : "") + nf(r.feeUsd, 2) + " $", r.feeUsd === null ? "wl-muted" : "", r.feeMissing ? "Для " + r.feeMissing + " операцій немає даних про витрати" : "Комісія біржі + проковзання моделі за всі підтверджені операції"), "Комісії й проковзання");
        lab(numCell(tr, r.confirmed + " / " + (r.expected === null ? "—" : r.expected) + (r.missing ? " (бракує " + r.missing + ")" : ""), r.missing ? "wl-muted" : "", "Підтверджених операцій / угод за лічильником рушія"), "Операцій / угод рушія"); tb.appendChild(tr);
      });
      if (!list.length) { const r = h("tr"), c = h("td", "wl-muted", "За вибраними фільтрами рахунків немає."); c.colSpan = 9; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb); return t;
    }
    function renderQuality() {
      if (!model) return;
      const bar = h("div", "wl-filters");
      bar.appendChild(scopeControl());
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), qf.wallet, function (v) { qf.wallet = v; renderQuality(); }));
      bar.appendChild(sel("Бот", botOpts("Усі боти"), qf.bot, function (v) { qf.bot = v; renderQuality(); }));
      bar.appendChild(sel("Повнота", [["", "Будь-яка"], ["full", "Повні дані"], ["partial", "Часткові дані"], ["insufficient", "Недостатньо даних"]], qf.status, function (v) { qf.status = v; renderQuality(); }));
      const all = rows(), cnt = { full: 0, partial: 0, insufficient: 0 }; all.forEach(function (r) { cnt[r.status]++; });
      const sum = h("p", "wl-muted wl-small wl-qsum", "Область: " + (prefs.scope === "all" ? "усі завантажені раунди" : "поточний раунд") + ". Рахунків: повні дані — " + cnt.full + ", часткові — " + cnt.partial + ", недостатньо даних — " + cnt.insufficient + " із " + all.length + ".");
      const list = qualityList();
      ui.qual.replaceChildren(bar, archiveStatusNode(), sum, wrapTable(qualityTable(list)),
        h("p", "wl-muted wl-small", "Метод. Реалізований PnL — сума чистих результатів підтверджених закритих угод: депозит · частка · (eq продажу − eq купівлі), тобто з урахуванням комісії й проковзання обох сторін; пара «купівля → продаж» утворюється лише в межах одного раунду. Win Rate — частка прибуткових закриттів. Середній результат — середнє арифметичне чистих результатів. Комісії й проковзання — за всіма підтвердженими операціями рахунку. «Повні дані» присвоюється тільки тоді, коли кількість підтверджених подій раунду дорівнює лічильнику угод рушія (а не тому, що подій багато). Реалізований PnL — окрема величина: вона не підміняє загальну зміну вартості рахунку."));
    }

    // ---------- історія операцій ----------
    function opType(o) { return o.type === "open" ? (o.initial ? "BUY · старт раунду" : "BUY") : "SELL"; }
    function px(v) { return nf(v, v >= 100 ? 2 : 4); }
    function execText(o) {
      const d = D.execDetail(o); if (!d) return null;
      return d.label + ": поріг " + (d.declared >= 0 ? "+" : "−") + nf(Math.abs(d.declared), 2) + "%" + (d.kind === "trail" ? " від піку" : "") + " · " + (d.entry !== null ? px(d.entry) + " → " : "вихід ") + px(d.exitPrice) + " · рух " + pctTxt(d.move) + (d.gap !== null ? " · відхилення " + sign(d.gap) + nf(Math.abs(d.gap), 2) + " п.п. " + (d.kind === "trail" ? "(від піку)" : "") : "");
    }
    function opsTable(list, fixedWallet) {
      const t = h("table", "wl-tbl wl-ops"), hr = h("tr");
      const cols = ["Дата й час", "Бот"].concat(fixedWallet ? [] : ["Гаманець"]).concat(["Монета", "Операція", "Ціна", "Обсяг", "Комісія", "Результат закриття", "Причина виходу", "Джерело · повнота"]);
      cols.forEach(function (x) { hr.appendChild(h("th", /^(Ціна|Обсяг|Комісія|Результат закриття)$/.test(x) ? "wl-num" : "", x)); });
      t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      list.forEach(function (o) {
        const tr = h("tr", "wl-r " + (o.type === "open" ? "wl-buy" : "wl-sell")); tr.setAttribute("data-key", o.key);
        const lab = function (td, k) { td.setAttribute("data-label", k); return td; };
        tr.appendChild(lab(h("td", "", hhmm(o.t)), "Дата й час")); const bc = h("td", "wl-botc", ruleTitle(o.bot)); bc.title = ruleTitle(o.bot); tr.appendChild(lab(bc, "Бот")); if (!fixedWallet) tr.appendChild(lab(h("td", "", capLabel(o.wallet)), "Гаманець")); tr.appendChild(lab(h("td", "", o.coin), "Монета"));
        tr.appendChild(lab(h("td", o.type === "open" ? "up" : "down", opType(o)), "Операція"));
        lab(numCell(tr, px(o.price)), "Ціна");
        const vol = numCell(tr, o.volUsd === null ? "—" : nf(o.volUsd, 2) + " $", o.volUsd === null ? "wl-muted" : "", o.volQty === null ? "Кількість невідома: немає даних про витрати" : "Кількість: " + nf(o.volQty, o.volQty >= 1 ? 4 : 6) + " " + o.coin); lab(vol, "Обсяг");
        lab(numCell(tr, o.feeUsd === null ? "—" : nf(o.feeUsd, 2) + " $ (" + nf(o.cost * 100, 3) + "%)", o.feeUsd === null ? "wl-muted" : "", "Комісія біржі + проковзання моделі"), "Комісія");
        const hasRes = o.type === "close" && o.pnlUsd !== null;
        lab(numCell(tr, o.type === "open" ? "—" : hasRes ? usdTxt(o.pnlUsd) + " · " + pctTxt(o.pnlPct) : "невідомий", o.type === "open" ? "wl-muted" : hasRes ? tone(o.pnlUsd) : "wl-muted", o.type === "close" && !hasRes ? "Результат невідомий: відкриття немає в підтверджених записах цього раунду" : ""), "Результат закриття");
        const why = h("td", ""); if (o.type === "close") { why.appendChild(document.createTextNode(o.exit && o.exit !== "unknown" ? (EXIT[o.exit] || o.exit) : EXIT.unknown)); const x = execText(o); if (x) { why.appendChild(h("small", "wl-exline", x)); } } else why.className = "wl-muted", why.textContent = "—"; tr.appendChild(lab(why, "Причина виходу"));
        const src = h("td", "wl-src"); src.appendChild(h("span", "wl-muted", o.src.map(function (x) { return x === "paper_archive" ? "архів" : x === "paper_events" ? "журнал" : "стрічка"; }).join(" + "))); src.appendChild(complBadge(o.compl, o.complEntry ? "Підтверджено подій: " + o.complEntry.confirmed + ", угод за лічильником рушія: " + (o.complEntry.expected === null ? "невідомо" : o.complEntry.expected) : "Лічильник угод цього раунду невідомий")); tr.appendChild(lab(src, "Джерело · повнота"));
        tb.appendChild(tr);
      });
      if (!list.length) { const r = h("tr"), c = h("td", "wl-muted", "Підтверджених операцій за вибраними фільтрами немає."); c.colSpan = cols.length; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb); return t;
    }
    function histNote() {
      const n = extra.notes, first = extra.ops.length ? extra.ops[0].t : null, ar = extra.ops.filter(function (o) { return o.src.indexOf("paper_archive") >= 0; });
      return h("p", "wl-muted wl-small", "Джерела: архів Paper Trading (повний, без обмеження 40 подій), журнал paper_events і підтверджені записи live_feed.json; однакові операції не дублюються (записів: " + extra.ops.length + ", з них є в архіві: " + ar.length + ", лише в журналі: " + n.fromEvents + ", лише в стрічці: " + n.fromFeed + "). Архів не відновлює операції, що зникли з журналів до його появи" + (first ? "; найраніша завантажена операція: " + hhmm(first) : "") + ". Показаний обсяг, комісія й результат — за моделлю симулятора; це не біржові операції, цінові сповіщення й Binance Testnet сюди не входять.");
    }
    const HP = { "24h": 86400000, "7d": 604800000 };
    function histList() {
      const f = hist, now = env.now();
      return extra.ops.filter(function (o) { return (!f.wallet || o.wallet === Number(f.wallet)) && (!f.bot || o.bot === f.bot) && (!f.coin || o.coin === f.coin) && (!f.type || o.type === f.type)
        && (f.period === "all" || (f.period === "round" ? o.roundCurrent : HP[f.period] ? o.t >= now - HP[f.period] : true)); }).sort(function (a, b) { return b.t - a.t; });
    }
    function renderHistory() {
      if (!model) return;
      const f = hist, bar = h("div", "wl-filters"), reset = function () { f.shown = 50; renderHistory(); };
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), f.wallet, function (v) { f.wallet = v; reset(); }));
      bar.appendChild(sel("Бот", botOpts("Усі боти"), f.bot, function (v) { f.bot = v; reset(); }));
      const coins = {}; extra.ops.forEach(function (o) { coins[o.coin] = 1; });
      bar.appendChild(sel("Монета", [["", "Усі монети"]].concat(Object.keys(coins).sort().map(function (c) { return [c, c]; })), f.coin, function (v) { f.coin = v; reset(); }));
      bar.appendChild(sel("Операція", [["", "BUY і SELL"], ["open", "BUY (відкриття)"], ["close", "SELL (закриття)"]], f.type, function (v) { f.type = v; reset(); }));
      bar.appendChild(sel("Період", [["round", "Поточний раунд"], ["24h", "24 години"], ["7d", "7 днів"], ["all", "Увесь архів"]], f.period, function (v) { f.period = v; ensureArchive(); reset(); }));
      const list = histList(), body = [bar, archiveStatusNode()];
      body.push(h("p", "wl-muted wl-small wl-hcount", "Показано " + Math.min(list.length, f.shown) + " із " + list.length + " операцій за фільтрами."));
      body.push(wrapTable(opsTable(list.slice(0, f.shown), false)));
      if (list.length > f.shown) { const m = h("button", "wl-btn wl-more", "Показати ще (" + Math.min(50, list.length - f.shown) + " із " + (list.length - f.shown) + ")"); m.type = "button"; m.addEventListener("click", function () { f.shown += 50; renderHistory(); }); body.push(m); }
      body.push(histNote()); ui.hist.replaceChildren.apply(ui.hist, body);
    }

    // ---------- Фактичне виконання Stop Loss / Take Profit / Trailing Stop ----------
    function renderExec() {
      if (!model) return;
      const bar = h("div", "wl-filters");
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), ef.wallet, function (v) { ef.wallet = v; ef.shown = 25; renderExec(); }));
      bar.appendChild(sel("Бот", botOpts("Усі боти"), ef.bot, function (v) { ef.bot = v; ef.shown = 25; renderExec(); }));
      const sl = extra.ops.filter(function (o) { return o.type === "close" && (o.exit === "stop" || o.exit === "take" || o.exit === "trail"); }), withInfo = sl.filter(function (o) { return !!o.exitInfo; });
      const list = withInfo.filter(function (o) { return (!ef.wallet || o.wallet === Number(ef.wallet)) && (!ef.bot || o.bot === ef.bot); }).sort(function (a, b) { return b.t - a.t; });
      const t = h("table", "wl-tbl wl-exec"), hr = h("tr");
      ["Дата й час", "Бот", "Гаманець", "Монета", "Тип виходу", "Заявлений поріг", "Ціна входу", "Ціна виходу", "Фактичний рух", "Відхилення від порогу", "Результат угоди"].forEach(function (x, i) { hr.appendChild(h("th", i >= 5 ? "wl-num" : "", x)); });
      t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      list.slice(0, ef.shown).forEach(function (o) {
        const d = D.execDetail(o), tr = h("tr", "wl-r"); tr.setAttribute("data-key", o.key); tr.setAttribute("data-kind", d.kind);
        const lab = function (td, k) { td.setAttribute("data-label", k); return td; };
        tr.appendChild(lab(h("td", "", hhmm(o.t)), "Дата й час")); tr.appendChild(lab(h("td", "", ruleTitle(o.bot)), "Бот")); tr.appendChild(lab(h("td", "", capLabel(o.wallet)), "Гаманець")); tr.appendChild(lab(h("td", "", o.coin), "Монета")); tr.appendChild(lab(h("td", d.kind === "take" ? "up" : "down", d.label), "Тип виходу"));
        lab(numCell(tr, (d.declared >= 0 ? "+" : "−") + nf(Math.abs(d.declared), 2) + "%" + (d.kind === "trail" ? " від піку" : "")), "Заявлений поріг");
        lab(numCell(tr, d.entry === null ? "—" : px(d.entry), d.entry === null ? "wl-muted" : ""), "Ціна входу"); lab(numCell(tr, px(d.exitPrice)), "Ціна виходу");
        lab(numCell(tr, pctTxt(d.move) + (d.kind === "trail" && d.fromPeak !== null ? " (від піку " + pctTxt(d.fromPeak) + ")" : ""), tone(d.move), "Фактичний рух ціни від входу до виходу"), "Фактичний рух");
        lab(numCell(tr, d.gap === null ? "—" : sign(d.gap) + nf(Math.abs(d.gap), 2) + " п.п.", d.gap === null ? "wl-muted" : tone(d.gap), d.gap === null ? "" : "Фактичний рух мінус заявлений поріг (" + d.gapBase + "): від'ємне — гірше за поріг, додатне — краще"), "Відхилення від порогу");
        lab(numCell(tr, d.pnlUsd === null ? "невідомий" : usdTxt(d.pnlUsd) + " · " + pctTxt(d.pnlPct), d.pnlUsd === null ? "wl-muted" : tone(d.pnlUsd), d.pnlUsd === null ? "Немає запису про відкриття" : "Чистий результат угоди з комісіями й проковзанням"), "Результат угоди"); tb.appendChild(tr);
      });
      if (!list.length) { const r = h("tr"), c = h("td", "wl-muted", withInfo.length ? "За вибраними фільтрами виходів немає." : "Виходів за стопом, тейком чи трейлінгом із даними про виконання (exit_info) поки немає. Такі дані з'являються лише для нових виходів; для старих їх не вигадуємо."); c.colSpan = 11; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb);
      const body = [bar, h("p", "wl-muted wl-small wl-exsum", "Виходів за Stop Loss / Take Profit / Trailing Stop у завантажених даних: " + sl.length + ", з даними про виконання (exit_info): " + withInfo.length + ", без них (записані до їх появи): " + (sl.length - withInfo.length) + "."), wrapTable(t)];
      if (list.length > ef.shown) { const m = h("button", "wl-btn wl-more", "Показати ще (" + (list.length - ef.shown) + ")"); m.type = "button"; m.addEventListener("click", function () { ef.shown += 25; renderExec(); }); body.push(m); }
      body.push(h("p", "wl-note wl-exnote2", D.EXIT_NOTE));
      body.push(h("p", "wl-muted wl-small", "Фактичний рух — зміна ціни від входу до ціни виходу; відхилення — різниця між ним і заявленим порогом (для Trailing Stop — відкат від піку). Результат угоди — чистий, з комісіями й проковзанням, рахується з пари купівля → продаж; якщо відкриття немає в підтверджених записах, він невідомий."));
      ui.exec.replaceChildren.apply(ui.exec, body);
    }

    // раунди й денні
    function renderRounds() {
      const rr = D.roundsRows(model, query()), c = prefs.mode === "avg" ? "≈ " : "";
      if (!rr.length) { const w = model.wallets[model.midCap]; ui.rounds.replaceChildren(h("p", "wl-muted", "Завершених раундів ще немає: перший раунд триває" + (w && w.roundEnd ? " до " + hhmm(w.roundEnd) : "") + ". Підсумки з'являться після його завершення.")); return; }
      const t = h("table", "wl-tbl"), hr = h("tr"); ["Раунд", "Період", "Гаманець", "Кінцева вартість", "Дохідність", "Угоди", "Утримання активу", "Різниця з утриманням"].forEach(function (x, i) { hr.appendChild(h("th", i >= 3 ? "wl-num" : "", x)); }); t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      rr.forEach(function (r) { const tr = h("tr", "wl-r"); tr.appendChild(h("td", "", "№ " + r.n)); tr.appendChild(h("td", "", (r.start ? hhmm(r.start) : "—") + " — " + (r.end ? hhmm(r.end) : "—"))); tr.appendChild(h("td", "", capLabel(r.wallet)));
        numCell(tr, c + nf(r.value, 2) + " $"); numCell(tr, pctTxt(r.pct), tone(r.pct)); numCell(tr, dash(r.trades, String)); numCell(tr, r.holdPct === null ? "—" : pctTxt(r.holdPct), r.holdPct === null ? "wl-muted" : tone(r.holdPct)); numCell(tr, r.vsHold === null ? "—" : sign(r.vsHold) + nf(Math.abs(r.vsHold), 2) + " п.п.", r.vsHold === null ? "wl-muted" : tone(r.vsHold)); tb.appendChild(tr); });
      t.appendChild(tb); ui.rounds.replaceChildren(wrapTable(t), h("p", "wl-muted wl-small", "Лише підсумкові значення завершених раундів (paper.history); внутрішньораундових кривих для них не збережено." + (prefs.mode === "avg" ? " Режим середнього: середнє по ботах, умовно." : " Бот: " + ruleTitle(prefs.bot) + ".")));
    }
    function renderDaily() {
      const dr = D.dailyRows(model, query()), c = prefs.mode === "avg" ? "≈ " : "";
      if (!dr.length) { ui.daily.replaceChildren(h("p", "wl-muted", "Денних значень ще немає.")); return; }
      const t = h("table", "wl-tbl"), hr = h("tr"); hr.appendChild(h("th", "", "Дата")); model.caps.forEach(function (cp) { hr.appendChild(h("th", "wl-num", capLabel(cp))); }); t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      dr.forEach(function (r) { const tr = h("tr", "wl-r"); tr.appendChild(h("td", "", new Date(r.date + "T00:00:00Z").toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })));
        model.caps.forEach(function (cp) { const x = r.cells[cp]; numCell(tr, x ? c + nf(x.value, 2) + " $ · " + pctTxt(x.pct) + (x.trades !== null ? " · угод: " + x.trades : "") : "—", x ? tone(x.pct) : "wl-muted"); }); tb.appendChild(tr); });
      t.appendChild(tb); ui.daily.replaceChildren(wrapTable(t), h("p", "wl-muted wl-small", "Частота: день — значення останнього запуску агента за добу (UTC), а не 10-хвилинні точки графіка. Режим: " + (prefs.mode === "avg" ? "середнє по ботах (умовно)." : "бот «" + ruleTitle(prefs.bot) + "».")));
    }
    function renderExtra() { renderCompare(); renderTable(); renderQuality(); renderCapital(); renderHistory(); renderExec(); renderRounds(); renderDaily(); }

    // розширена деталізація гаманця
    function renderDetailExtra(cap) {
      const avg = prefs.mode === "avg";
      if (avg) ui.detail.appendChild(h("p", "wl-note", "Режим «Середнє по ботах»: нижче — 16 незалежних симуляцій цього гаманця, а не один спільний рахунок. Показники вгорі — агрегат (середня дохідність), угоди й позиції — суми по ботах."));
      ui.detail.appendChild(h("h3", "wl-h3", "Розподіл капіталу")); ui.detail.appendChild(capitalNode(cap));
      ui.detail.appendChild(h("h3", "wl-h3", "Поточні відкриті позиції: жива оцінка"));
      const est = D.positionEstimates(model, query(), cap, extra.ops, extra.feedOpen, prices, pricesAt, env.now());
      if (est.length) {
        const t = h("table", "wl-tbl wl-pos"), hr = h("tr"); ["Бот", "Монета", "Відкрито", "Ціна входу", "Ринкова ціна", "Оцінка позиції", "Нереалізований PnL", "Ціна оновлена"].forEach(function (x, i) { hr.appendChild(h("th", i >= 3 && i < 7 ? "wl-num" : "", x)); }); t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
        est.forEach(function (x) {
          const tr = h("tr", "wl-r"); tr.setAttribute("data-coin", x.coin); tr.appendChild(h("td", "", ruleTitle(x.bot))); tr.appendChild(h("td", "", x.coin)); tr.appendChild(h("td", "", x.entryT ? hhmm(x.entryT) : "невідомо"));
          numCell(tr, x.entry === null ? "—" : nf(x.entry, x.entry >= 100 ? 2 : 4)); numCell(tr, x.price === null ? "—" : nf(x.price, x.price >= 100 ? 2 : 4), x.price === null ? "wl-muted" : ""); numCell(tr, x.value === null ? "—" : (avg ? "≈ " : "") + nf(x.value, 2) + " $", x.value === null ? "wl-muted" : "");
          numCell(tr, x.pnlUsd === null ? (x.priceChangePct === null ? "—" : "ціна " + pctTxt(x.priceChangePct) + " від входу") : usdTxt(x.pnlUsd) + " · " + pctTxt(x.pnlPct), x.pnlUsd === null ? "wl-muted" : tone(x.pnlUsd), x.pnlUsd === null ? "Немає запису про відкриття: вкладену суму визначити неможливо" : "Оцінка за ринковою ціною мінус вкладена сума (з урахуванням витрат входу)");
          tr.appendChild(h("td", x.status === "live" ? "" : "wl-muted", x.status === "live" ? new Date(x.priceAt).toLocaleTimeString("uk-UA") : x.status === "stale" ? "ціна застаріла" + (x.priceAt ? " (" + new Date(x.priceAt).toLocaleTimeString("uk-UA") + ")" : "") : "немає ціни")); tb.appendChild(tr);
        });
        t.appendChild(tb); ui.detail.appendChild(wrapTable(t));
        ui.detail.appendChild(h("p", "wl-muted wl-small", "Ціни входу — зі стану рушія (live_feed.json); ринкові ціни Binance беруться одним спільним запитом і не змінюють збережену історію, баланси чи результати симуляції. Оцінка позиції = вартість за поточною ринковою ціною; PnL — окрема оцінка, яка не додається до збереженої вартості рахунку."));
      } else {
        const s = D.walletStats(model, query(), cap);
        ui.detail.appendChild(h("p", "wl-muted", (s.open === 0 ? "Відкритих позицій немає." : "Відкрито позицій: " + dash(s.open, String) + (!avg && s.openCoins.length ? " (" + s.openCoins.join(", ") + ")" : "") + "; деталі позицій недоступні: стан монет не збережено.")));
      }
      ui.detail.appendChild(h("h3", "wl-h3", "Боти гаманця " + capLabel(cap)));
      const list = D.filterRows(rows(), { wallet: cap }), box = h("div"); ui.detail.appendChild(box);
      const draw = function () { box.replaceChildren(wrapTable(botsTable(list, dtbl, true, draw)), tableNote()); }; draw();
      ui.detail.appendChild(h("h3", "wl-h3", "Збережені торгові операції гаманця"));
      const ops = extra.ops.filter(function (o) { return o.wallet === cap && (avg || o.bot === prefs.bot); }).sort(function (a, b) { return b.t - a.t; });
      ui.detail.appendChild(wrapTable(opsTable(ops.slice(0, 15), true))); ui.detail.appendChild(histNote());
    }

    // ---------- Експорт CSV: враховує поточні фільтри; лише наявні підтверджені дані ----------
    function exportCsv(kind) {
      if (!model) return null;
      let text = null;
      if (kind === "bots") { const l = D.sortRows(D.filterRows(rows(), tbl), tbl.sort, tbl.dir); if (l.length) text = D.botsCsv(l); }
      else if (kind === "ops") { const l = histList(); if (l.length) text = D.opsCsv(l.map(function (o) { return Object.assign({}, o, { botTitle: ruleTitle(o.bot) }); })); }
      else if (kind === "quality") { const l = qualityList(); if (l.length) text = D.qualityCsv(l); }
      else if (kind === "daily") { if (D.dailyRows(model, query()).length) text = D.dailyCsv(model, query()); }
      else if (kind === "rounds") { if (D.roundsRows(model, query()).length) text = D.roundsCsv(model, query()); }
      if (!text) return null;
      const d = new Date(env.now()).toISOString().slice(0, 10), names = { bots: "boty", ops: "operatsii", quality: "pidtverdzheni-uhody", daily: "dennі-rezultaty", rounds: "raundy" };
      return { name: "wallets-" + (names[kind] || kind).replace("і", "i") + "-" + d + ".csv", text: text, rows: text.split("\r\n").length - 2 };
    }
    function doExport(kind) {
      const r = exportCsv(kind), note = document.querySelector("#" + ({ bots: "wlTable", ops: "wlHistory", quality: "wlQuality", daily: "wlDaily", rounds: "wlRounds" }[kind] || "wlTable") + " .wl-exnote");
      let msg = host.querySelector('[data-export="' + kind + '"]');
      const box = msg && msg.closest(".wl-card"); let n = box && box.querySelector(".wl-exnote"); if (box && !n) { n = h("p", "wl-muted wl-small wl-exnote"); n.setAttribute("role", "status"); box.querySelector(".wl-card-h").insertAdjacentElement("afterend", n); }
      if (!r) { if (n) n.textContent = "Немає даних для експорту за вибраними фільтрами."; return null; }
      env.download(r.name, r.text); if (n) n.textContent = "Файл " + r.name + " завантажено: " + r.rows + " рядків. Числа з десятковою комою, роздільник «;» (для Excel з українськими налаштуваннями)."; return r;
    }

    // додаткові файли: журнали подій і підтверджені записи (необов'язкові; відсутність не ламає сторінку), потім архів Paper Trading
    let histSig = "";
    function rebuildHistory() {
      // Дорога операція (десятки тисяч подій за рік): не перебудовуємо, якщо вхідні дані не змінились (щохвилинне оновлення сторінки).
      const sig = [model.updated, rawFeed && rawFeed.updated, Object.keys(rawBy).map(function (k) { return k + ":" + Object.keys(rawBy[k]).map(function (b) { return (rawBy[k][b] || []).length; }).join(","); }).join(";"), arch.status, arch.names.map(function (n) { const c = arch.segs[n]; return n + ":" + (c ? c.count + "/" + c.bytes : 0); }).join(";")].join("|");
      if (sig === histSig && extra.ready && extra.ops.length) return;
      histSig = sig;
      const hh = D.buildHistory(model, rawBy, rawFeed, archiveEvents());
      extra = { ops: hh.ops, notes: hh.notes, comp: hh.comp, feedOpen: extra.feedOpen, eventsLoaded: extra.eventsLoaded, feedLoaded: extra.feedLoaded, ready: true };
    }
    function archiveEvents() {
      if (arch.status !== "ok" || !arch.index) return [];
      const out = []; arch.index.segments.forEach(function (sg) { const c = arch.segs[sg.name]; if (c && c.ok && c.count === sg.count && c.bytes === sg.bytes) Array.prototype.push.apply(out, c.events); });
      return out;
    }
    // Потрібне вікно архіву: від початку найстарішого поточного раунду (мінус запас) або довше, якщо вибрано більший період; null — увесь архів.
    function demandFrom() {
      if (prefs.scope === "all" || hist.period === "all") return null;
      let f = null; model.caps.forEach(function (c) { const w = model.wallets[c]; if (w && w.roundStart !== null) f = f === null ? w.roundStart : Math.min(f, w.roundStart); });
      if (f === null) return null;
      f -= 2 * 3600000; if (HP[hist.period]) f = Math.min(f, env.now() - HP[hist.period]);
      return f;
    }
    // Індекс завжди читається заново; сегмент береться з кешу лише якщо його count і bytes збігаються з індексом (інакше це застарілі дані й вони перезавантажуються).
    function loadArchive() {
      const from = demandFrom(), req = ++archReq;
      if (arch.status !== "ok") arch.status = "loading";
      return Promise.resolve().then(function () { return env.loadJson("data/paper_archive/index.json"); }).then(function (raw) {
        const idx = D.parseArchiveIndex(raw); if (!idx.ok) throw new Error(idx.reason);
        const need = D.neededSegments(idx, from), errors = [];
        arch.needed = need.length;
        return Promise.all(need.map(function (sg) {
          const c = arch.segs[sg.name]; if (c && c.ok && c.count === sg.count && c.bytes === sg.bytes) return c;
          return Promise.resolve().then(function () { return env.loadJson("data/paper_archive/" + sg.name + ".json"); }).then(function (d) {
            const r = D.parseArchiveSegment(d, sg.name); if (!r.ok) throw new Error(r.reason);
            return (arch.segs[sg.name] = { name: sg.name, count: sg.count, bytes: sg.bytes, ok: true, events: r.events, bad: r.bad });
          }).catch(function (e) { errors.push({ name: sg.name, msg: (e && e.message ? e.message : "помилка").slice(0, 80) }); delete arch.segs[sg.name]; return null; });
        })).then(function () { if (req !== archReq) return; arch.index = idx; arch.errors = errors; arch.names = need.filter(function (sg) { return arch.segs[sg.name]; }).map(function (sg) { return sg.name; }); arch.status = "ok"; arch.reason = ""; });
      }).catch(function (e) { if (req !== archReq) return; arch.status = "error"; arch.index = null; arch.segs = {}; arch.names = []; arch.errors = []; arch.reason = (e && e.message ? e.message : "помилка").slice(0, 60); });
    }
    function ensureArchive() { if (!model || destroyed) return Promise.resolve(); return loadArchive().then(function () { if (!destroyed) { rebuildHistory(); renderExtra(); } }); }
    function loadExtras() {
      const files = model.caps.map(function (cap) { return { cap: cap, url: cap === model.midCap ? "data/paper_events.json" : "data/paper_events_" + cap + ".json" }; });
      return Promise.all(files.map(function (f) { return Promise.resolve().then(function () { return env.loadJson(f.url); }).then(function (d) { return [f.cap, d && typeof d === "object" ? d : null]; }).catch(function () { return [f.cap, null]; }); }))
        .then(function (pairs) {
          const by = {}; let ok = 0; pairs.forEach(function (x) { if (x[1]) { by[x[0]] = x[1]; ok++; } });
          return Promise.resolve().then(function () { return env.loadJson("data/live_feed.json"); }).catch(function () { return null; }).then(function (feed) {
            rawBy = by; rawFeed = feed && typeof feed === "object" ? feed : null;
            extra = { ops: [], notes: extra.notes, comp: null, feedOpen: rawFeed && Array.isArray(rawFeed.feedOpen || rawFeed.open) ? (rawFeed.open || []).filter(function (x) { return x && Number.isInteger(x.wallet) && typeof x.bot === "string" && typeof x.coin === "string" && typeof x.entry === "number"; }) : [], eventsLoaded: ok, feedLoaded: !!rawFeed, ready: true };
            rebuildHistory();                                                                  // спочатку журнали: сторінка показується одразу, архів дозавантажується поступово
            if (!destroyed) renderExtra();
            return loadArchive().then(function () { if (!destroyed) { rebuildHistory(); } });
          });
        });
    }

    // ---------- Живі ціни: окремо від історії ----------
    function loadLive() {
      const syms = D.liveSymbols(model, query());
      if (!syms.length) { prices = {}; pricesAt = env.now(); if (!destroyed) { renderCards(); renderDetail(); } return Promise.resolve(); }
      return Promise.resolve().then(function () { return env.loadPrices(syms); }).then(function (m) { prices = m || {}; pricesAt = env.now(); }).catch(function () { /* залишаємо попередні ціни: вони стають «застарілими» самі */ })
        .then(function () { if (!destroyed) { renderCards(); renderDetail(); } });
    }
    function priceLoop() { if (destroyed) return; priceTimer = env.setTimeout(function () { (model ? loadLive() : Promise.resolve()).then(priceLoop); }, env.priceMs); }

    // ---------- Testnet: лише статус ----------
    function renderTestnet() {
      if (traderErr) { ui.tn.textContent = "Статус Testnet недоступний (" + traderErr + ")."; return; }
      if (!trader) return;
      ui.tn.textContent = trader.configured ? "Підключено до Binance Testnet (ненастоящі гроші)." + (trader.updated ? " Оновлено " + ago(Date.parse(trader.updated) || env.now(), env.now()) + "." : "") : "Не підключено: ключі Testnet не задані. Балансів і угод Testnet тут немає.";
    }

    // ---------- завантаження ----------
    function load() {
      return Promise.resolve().then(function () { return env.loadJson("data/simulation.json"); }).then(function (sim) {
        model = D.parseModel(sim); loadError = null; lastOk = env.now();
        if (!load.once && urlDetail && model.caps.indexOf(urlDetail) >= 0) detailCap = urlDetail;
        if (urlBot && model.rules.some(function (r) { return r.id === urlBot; }) && !load.once) prefs.bot = urlBot;
        load.once = true;
      }).catch(function (e) { loadError = (e && e.message ? e.message : "помилка").slice(0, 120); })
        .then(function () { if (!destroyed) render(true); })
        .then(function () { return model && !destroyed ? loadExtras().then(function () { if (!destroyed) render(true); }) : null; })
        .then(function () { if (model && !destroyed) { loadLive(); if (!priceLoopOn) { priceLoopOn = true; priceLoop(); } } })
        .then(function () { return Promise.resolve().then(function () { return env.loadJson("data/trader.json"); }).then(function (t) { trader = t; traderErr = null; }).catch(function (e) { traderErr = (e && e.message ? e.message : "помилка").slice(0, 60); }); })
        .then(function () { if (!destroyed) renderTestnet(); });
    }
    function loop() { if (destroyed) return; timer = env.setTimeout(function () { load().then(loop); }, env.refreshMs); }

    // ---------- кнопка «Торгові події»: наявна висувна панель LiveFeed ----------
    if (typeof LiveFeed !== "undefined" && env.feed !== false) {
      const fh = h("div", "wl-feed"); document.body.appendChild(fh);
      feed = { host: fh, inst: LiveFeed.mount(fh, { layoutRoot: host, fabParent: ui.events, fabLabel: "Торгові події", drawerBelow: 99999, period: "all", wallet: focus || undefined, env: env.feedEnv }) };
    }

    render(false);
    load().then(loop);
    return {
      state: function () { return Object.assign({}, prefs, { focus: focus, hidden: Object.assign({}, hidden) }); }, exportCsv: exportCsv, doExport: doExport, chart: chart, model: function () { return model; }, reload: load,
      destroy: function () { destroyed = true; env.clearTimeout(timer); env.clearTimeout(priceTimer); chart.destroy(); if (feed) { feed.inst.destroy(); feed.host.remove(); } host.classList.remove("wl-page"); host.replaceChildren(); },
    };
  }

  root.WalletsPage = { mount: mount };
  if (typeof document !== "undefined") {
    const rootEl = document.getElementById("wlRoot");
    if (rootEl && !root.__WL_NO_AUTO) mount(rootEl);
  }
})(typeof window !== "undefined" ? window : this);
