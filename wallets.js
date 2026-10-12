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
      downloadBytes: function (name, bytes, mime) { const b = new Blob([bytes], { type: mime || "application/octet-stream" }), u = URL.createObjectURL(b), a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 3000); },
      now: function () { return Date.now(); }, storage: root.localStorage, search: root.location ? root.location.search : "",
      setTimeout: function (f, ms) { return root.setTimeout(f, ms); }, clearTimeout: function (i) { root.clearTimeout(i); }, refreshMs: 60000,
    };
  }

  function mount(host, envIn) {
    const env = Object.assign(defaultEnv(), envIn || {});
    const params = new URLSearchParams(env.search || "");
    let prefs = { mode: "bot", bot: null, unit: "pct", period: "all", view: "curve", scope: "round", proWallet: "", proMetric: "usd", proIdle: "0" };
    try { const s = JSON.parse(env.storage.getItem(PREFS)); if (s && typeof s === "object") Object.keys(prefs).forEach(function (k) { if (typeof s[k] === "string") prefs[k] = s[k]; }); } catch (e) { /* без збережень */ }
    if (["bot", "avg"].indexOf(prefs.mode) < 0) prefs.mode = "bot";
    if (["pct", "usd", "log"].indexOf(prefs.unit) < 0) prefs.unit = "pct";
    if (!(prefs.period in D.PERIODS)) prefs.period = "all";
    if (["curve", "daily"].indexOf(prefs.view) < 0) prefs.view = "curve";
    if (["round", "all"].indexOf(prefs.scope) < 0) prefs.scope = "round";
    if (["usd", "pct"].indexOf(prefs.proMetric) < 0) prefs.proMetric = "usd";
    if (["0", "1"].indexOf(prefs.proIdle) < 0) prefs.proIdle = "0";
    let focus = parseInt(params.get("wallet"), 10) || null;
    const urlDetail = parseInt(params.get("detail"), 10) || null;
    const urlBot = params.get("bot");
    let model = null, loadError = null, trader = null, traderErr = null, hidden = {}, chart = null, feed = null, timer = 0, destroyed = false, lastOk = 0, detailCap = null, prices = {}, pricesAt = null, priceTimer = 0, priceLoopOn = false;
    let extra = { ops: [], notes: { fromEvents: 0, fromFeed: 0, fromArchive: 0, both: 0, withArchive: 0, skipped: 0 }, comp: null, feedOpen: [], eventsLoaded: 0, feedLoaded: false, ready: false };
    let arch = { status: "idle", index: null, segs: {}, errors: [], needed: 0, names: [], reason: "" }, rawBy = {}, rawFeed = null, archReq = 0;
    const pt = { sort: "resultPct", dir: "desc", wallet: "", status: "", sign: "", q: "", onlyTrades: false, onlyOpen: false, shown: 12, open: {} }, ph = { q: "", wallet: "", bot: "", coin: "", type: "", result: "", exit: "", period: "round", sort: "t", dir: "desc", shown: 20, open: {} }, dtbl = { sort: "resultPct", dir: "desc" };
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

    // Analytics Pro 1: компактні KPI й рейтинги (заповнюється в renderPro)
    const proCard = h("div", "wl-card wl-pro"); proCard.id = "wlPro"; ui.pro = proCard;
    function exportHead(title, btns) {
      const head = h("div", "wl-card-h"); head.appendChild(h("h2", "wl-h2", title));
      btns.forEach(function (x) { const b = h("button", "wl-btn wl-export", x[1]); b.type = "button"; b.setAttribute("data-export", x[0]); b.setAttribute("aria-label", x[1]); b.title = "Завантажити CSV для Excel з урахуванням поточних фільтрів"; b.addEventListener("click", function () { doExport(x[0]); }); head.appendChild(b); });
      return head;
    }
    const proAccCard = h("div", "wl-card wl-block wl-proacc"), proHistCard = h("div", "wl-card wl-block wl-prohist"); proAccCard.id = "wlProAcc"; proHistCard.id = "wlProHist";
    const dynCard = h("div", "wl-card wl-block wl-dynamics"), pcmpCard = h("div", "wl-card wl-block wl-pcmp"); dynCard.id = "wlDynamics"; pcmpCard.id = "wlPeriodCmp";
    dynCard.appendChild(h("h2", "wl-h2", "Динаміка стратегій")); ui.dyn = h("div", "wl-bbody"); dynCard.appendChild(ui.dyn);
    pcmpCard.appendChild(h("h2", "wl-h2", "Порівняння періодів і зміна місць")); ui.pcmp = h("div", "wl-bbody"); pcmpCard.appendChild(ui.pcmp);
    proAccCard.appendChild(exportHead("Analytics Pro: рахунки (48 незалежних)", [["bots", "Експорт CSV: показники"], ["quality", "Експорт CSV: якість даних"]])); ui.proAcc = h("div", "wl-bbody"); proAccCard.appendChild(ui.proAcc);
    proHistCard.appendChild(exportHead("Analytics Pro: історія торгових операцій", [["ops", "Експорт CSV: операції"]])); ui.proHist = h("div", "wl-bbody"); proHistCard.appendChild(ui.proHist);
    const repCard = h("div", "wl-card wl-block wl-reports"); repCard.id = "wlReports"; ui.rep = repCard; let reportUI = null, repFrom;
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
    const bCmp = block("wlCompare", "Порівняння результатів між гаманцями", "Дохідність кожного бота в трьох незалежних гаманцях, у % від депозиту поточного раунду."), bCap = block("wlCapital", "Розподіл капіталу"), bRounds = block("wlRounds", "Підсумки попередніх раундів", "", "rounds"), bDaily = block("wlDaily", "Денні результати", "", "daily");
    ui.cmp = bCmp.body; ui.cap = bCap.body; ui.rounds = bRounds.body; ui.daily = bDaily.body;
    const tn = h("div", "wl-card wl-testnet"); tn.id = "wlTestnet"; tn.appendChild(h("h2", "wl-h2", "Binance Testnet")); ui.tn = h("p", "wl-muted", "Перевіряємо статус…"); tn.appendChild(ui.tn);
    tn.appendChild(h("p", "wl-muted wl-small", "Окремий тестовий режим: не входить у статистику віртуальних рахунків і ніколи не змішується з нею."));
    const disc = h("p", "wl-disc", "Це симуляція на віртуальних грошах: інформація, а не фінансова порада й не прогноз. Дані беруться зі збережених точок історії; прогалини не заповнюються.");
    [bar, ui.err, ui.note, ui.focusNote, proCard, kpiBox, card, cardsSec, ui.detail, proAccCard, proHistCard, dynCard, pcmpCard, repCard, bCmp.card, bCap.card, bRounds.card, bDaily.card, tn, disc].forEach(function (n) { host.appendChild(n); });

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
      renderKpi(); renderPro(); renderCards(); renderDetail(); renderExtra();
    }
    function now0() { return env.now(); }
    function roundStart() { const w = model.wallets[model.caps[0]]; return w && w.roundStart; }

    // ---------- Analytics Pro 1: компактні KPI, ТОП-3 / АНТИТОП-3 ----------
    function renderPro() {
      if (!model) return;
      if (prefs.proWallet !== "" && model.caps.indexOf(Number(prefs.proWallet)) < 0) prefs.proWallet = "";
      const idle = prefs.proIdle === "1", rs = D.accountRows(model, [], "round"), rk = D.proRanking(model, rs, prefs.proWallet, prefs.proMetric, idle), k = D.proKpis(model, rs, prefs.proWallet, rk.metric), all = rk.all;
      const metric = rk.metric, mtxt = function (e) { return metric === "pct" ? pctTxt(e.pct) : usdTxt(e.usd); }, mval = function (e) { return metric === "pct" ? e.pct : e.usd; };
      const head = h("div", "wl-pro-h"), title = h("h2", "wl-h2", "Analytics Pro"); head.appendChild(title);
      const ctl = h("div", "wl-pro-ctl"), wseg = h("div", "wl-seg"), mseg = h("div", "wl-seg");
      wseg.setAttribute("role", "group"); wseg.setAttribute("aria-label", "Гаманець для аналітики"); mseg.setAttribute("role", "group"); mseg.setAttribute("aria-label", "Рейтинг за");
      [["", "Усі гаманці"]].concat(model.caps.map(function (c) { return [String(c), capLabel(c)]; })).forEach(function (x) { const b = h("button", "wl-btn" + (prefs.proWallet === x[0] ? " on" : ""), x[1]); b.type = "button"; b.setAttribute("data-pro-wallet", x[0]); b.setAttribute("aria-pressed", prefs.proWallet === x[0] ? "true" : "false"); b.addEventListener("click", function () { prefs.proWallet = x[0]; persist(); renderPro(); }); wseg.appendChild(b); });
      [["usd", "Прибуток, $"], ["pct", "Дохідність, %"]].forEach(function (x) {
        const on = metric === x[0], b = h("button", "wl-btn" + (on ? " on" : ""), x[1]); b.type = "button"; b.setAttribute("data-pro-metric", x[0]); b.setAttribute("aria-pressed", on ? "true" : "false");
        if (all && x[0] === "usd") { b.disabled = true; b.title = "У режимі «Усі гаманці» місце визначає лише середня дохідність у %: суму $ трьох гаманців для рейтингу не використовуємо. Прибуток $ доступний для окремого гаманця."; }
        b.addEventListener("click", function () { prefs.proMetric = x[0]; persist(); renderPro(); }); mseg.appendChild(b);
      });
      const idleBtn = h("button", "wl-btn wl-pro-idle" + (idle ? " on" : ""), "Включати ботів без угод"); idleBtn.type = "button"; idleBtn.setAttribute("data-pro-idle", idle ? "1" : "0"); idleBtn.setAttribute("aria-pressed", idle ? "true" : "false");
      idleBtn.title = "За замовчуванням боти, які ще не здійснили жодної угоди в поточному раунді, не беруть участі в ТОП-3 і АНТИТОП-3"; idleBtn.addEventListener("click", function () { prefs.proIdle = idle ? "0" : "1"; persist(); renderPro(); });
      ctl.appendChild(wseg); ctl.appendChild(mseg); ctl.appendChild(idleBtn); head.appendChild(ctl);
      const grid = h("div", "wl-pro-kpi");
      const t = function (label, value, sub, cls, id) { const d = h("div", "wl-ptile"); d.setAttribute("data-kpi", id); d.appendChild(h("span", "wl-ptile-l", label)); d.appendChild(h("b", "wl-ptile-v" + (cls ? " " + cls : ""), value)); d.appendChild(h("span", "wl-ptile-s", sub)); grid.appendChild(d); };
      const who = function (r) { return r ? r.title + " · " + capLabel(r.wallet) : ""; }, kv = function (r) { return metric === "pct" ? r.resultPct : r.resultUsd; }, kt = function (r) { return metric === "pct" ? pctTxt(r.resultPct) : usdTxt(r.resultUsd); };
      if (!k.accounts) { ["Результат рахунків", "Середня дохідність", "Рахунки", "Найкращий", "Найгірший", "Угоди · позиції"].forEach(function (l, i) { t(l, "—", "Немає даних", "", "k" + i); }); }
      else {
        t("Результат рахунків", usdTxt(k.sumUsd), "сума " + k.accounts + " незалежних рахунків (не спільний портфель); депозити " + nf(k.deposits, 0) + " $", tone(k.sumUsd), "sum");
        t("Середня дохідність", pctTxt(k.meanPct), "середнє арифметичне " + k.accounts + " рахунків", tone(k.meanPct), "mean");
        t("Рахунки в плюсі / у мінусі", k.positive + " / " + k.negative, "нульових: " + k.zero + (k.idle ? " · без угод: " + k.idle : "") + (k.noData ? " · без даних: " + k.noData : ""), "", "pn");
        t("Найкращий рахунок", k.best ? kt(k.best) : "—", who(k.best), k.best ? tone(kv(k.best)) : "", "best");
        t("Найгірший рахунок", k.worst ? kt(k.worst) : "—", who(k.worst), k.worst ? tone(kv(k.worst)) : "", "worst");
        t("Угоди · відкриті позиції", dash(k.trades, String) + " · " + dash(k.open, String), k.maxDd === null ? "просідання невідоме" : "макс. просідання " + ddTxt(k.maxDd) + " (" + who(k.maxDdAcc) + ")", "", "tr");
      }
      const lists = h("div", "wl-pro-lists");
      function listNode(titleTxt, cls, items) {
        const box = h("div", "wl-pro-list " + cls), hd = h("h3", "wl-h3", titleTxt + " (" + items.length + ")"); box.appendChild(hd);
        const ol = h("ol", "wl-pro-ol"); ol.setAttribute("aria-label", titleTxt);
        items.forEach(function (e) {
          const li = h("li", "wl-pro-li"); li.setAttribute("data-bot", e.bot); li.setAttribute("data-rank", e.rank); li.setAttribute("data-sign", e.sign);
          const rank = h("span", "wl-pro-rank", (e.tie ? "=" : "") + e.rank), body = h("div", "wl-pro-body"), nm = h("button", "wl-link wl-pro-name", e.title); nm.type = "button"; nm.title = "Показати цього бота на графіку й у картках";
          nm.addEventListener("click", function () { prefs.mode = "bot"; prefs.bot = e.bot; changed(true); });
          const val = h("div", "wl-pro-val"); val.appendChild(h("b", "wl-pro-main " + tone(mval(e)), mtxt(e)));
          val.appendChild(h("span", "wl-ptile-s", all ? "середнє трьох незалежних рахунків" : (metric === "pct" ? usdTxt(e.usd) : pctTxt(e.pct))));
          body.appendChild(nm); body.appendChild(h("div", "wl-ptile-s", "угод: " + dash(e.trades, String) + " · позицій: " + dash(e.open, String) + (e.ddKnown ? " · просідання " + ddTxt(e.dd) : "")));
          const tags = h("div", "wl-pro-tags");
          if (e.sign === "minus") tags.appendChild(h("span", "wl-cb wl-cb-partial", "у мінусі")); else if (e.sign === "zero") tags.appendChild(h("span", "wl-cb wl-cb-unknown", "нульовий результат"));
          if (e.noTrades) { const nt = h("span", "wl-cb wl-cb-unknown", "без угод"); nt.title = "Бот ще не торгував у цьому раунді"; tags.appendChild(nt); }
          if (tags.children.length) body.appendChild(tags);
          if (all) {                                           // USD кожного гаманця окремо: незалежні рахунки, різні набори монет
            const det = document.createElement("details"); det.className = "wl-pro-det"; const sm = document.createElement("summary"); sm.textContent = "Рахунки по гаманцях"; det.appendChild(sm);
            e.perWallet.forEach(function (w) { det.appendChild(h("div", "wl-ptile-s", capLabel(w.wallet) + ": " + usdTxt(w.usd) + " · " + pctTxt(w.pct) + " · угод " + dash(w.trades, String))); });
            body.appendChild(det);
          }
          li.appendChild(rank); li.appendChild(body); li.appendChild(val); ol.appendChild(li);
        });
        if (!items.length) ol.appendChild(h("li", "wl-muted", "Недостатньо активних стратегій для цього списку."));
        box.appendChild(ol); return box;
      }
      lists.appendChild(listNode("ТОП-3", "wl-pro-top", rk.top)); lists.appendChild(listNode("АНТИТОП-3", "wl-pro-anti", rk.anti));
      const notes = [];
      notes.push("Рейтинг за " + (metric === "pct" ? "дохідністю, %" : "прибутком, $") + " · " + (all ? "усі гаманці: місце визначає просте середнє відсоткової дохідності трьох незалежних рахунків бота (суму $ для рейтингу не використовуємо; $ кожного гаманця — у деталях). Гаманці торгують різними монетами, тож це не порівняння розміру депозиту й не спільний портфель" : "гаманець " + capLabel(Number(prefs.proWallet)) + ": окремий рахунок кожного бота зі своїм набором монет") + " · поточний раунд, збережена вартість.");
      notes.push(idle ? "Боти без угод включено." : "Боти без угод виключено з рейтингу" + (rk.idle ? " (" + rk.idle + ")" : "") + ": вони не торгували, їхній результат нульовий.");
      notes.push("У списках показано фактичну кількість активних стратегій; у ТОП потрапляють найкращі з наявних, навіть якщо їхній результат нульовий чи від'ємний (це позначено).");
      if (rk.excluded.length) notes.push("Не в рейтингу (немає збережених точок для всіх вибраних рахунків): " + rk.excluded.length + ".");
      notes.push("Це не прогноз: короткий раунд і малий обсяг угод не доводять переваги стратегії.");
      ui.pro.replaceChildren(head, grid, lists, h("p", "wl-muted wl-small wl-pro-note", notes.join(" ")));
    }

    // ---------- Analytics Pro 2: компактна таблиця 48 рахунків із розкривними деталями ----------
    const PT_COLS = [["title", "Бот", false], ["wallet", "Гаманець", true], ["value", "Вартість", true], ["resultUsd", "P/L, $", true], ["resultPct", "%", true], ["trades", "Угоди", true], ["open", "Поз.", true], ["dd", "Просідання", true], ["winRate", "Win Rate", true], ["realized", "Реалізований PnL", true], ["statusRank", "Повнота", false]];
    function accKey(r) { return r.wallet + "|" + r.bot; }
    function detailLine(dl, k, v) { if (v === null || v === undefined || v === "") return; dl.appendChild(h("dt", "", k)); const dd = h("dd", ""); if (v && v.nodeType) dd.appendChild(v); else dd.textContent = String(v); dl.appendChild(dd); }
    function accDetailNode(r, rs) {
      const d = D.accountDetail(model, extra.ops, r.wallet, r.bot, prefs.scope, extra.comp || { entries: [], byKey: {} }, rs), box = h("div", "wl-det-box");
      if (!d) { box.appendChild(h("p", "wl-muted", "Деталі недоступні: немає збережених точок рахунку.")); return box; }
      const st = d.stats, dl = h("dl", "wl-dl");
      detailLine(dl, "Початковий депозит", nf(d.cap, 0) + " $"); detailLine(dl, "Збережена вартість", nf(d.value, 2) + " $"); detailLine(dl, "Результат", usdTxt(d.resultUsd) + " · " + pctTxt(d.resultPct));
      detailLine(dl, "Проти «просто тримати»", d.vsHold === null ? null : sign(d.vsHold) + nf(Math.abs(d.vsHold), 2) + " п.п. (утримання " + pctTxt(d.holdPct) + ")");
      detailLine(dl, "Раунд", d.roundStart ? hhmm(d.roundStart) + (d.roundEnd ? " — " + hhmm(d.roundEnd) : "") : null); detailLine(dl, "Монети гаманця", d.coins.length ? d.coins.join(", ") : null);
      detailLine(dl, "Відкриті позиції", d.open === null ? null : d.open + (d.openCoins.length ? " (" + d.openCoins.join(", ") + ")" : "")); detailLine(dl, "Угоди за лічильником рушія", dash(d.trades, String));
      const wc = winCell(Object.assign({}, r, { status: st.status, noClosed: st.noClosed, winRate: st.winRate, wins: st.wins, closed: st.closed }));
      detailLine(dl, "Повнота історії", D.COMPL_TXT[st.status] + " · підтверджено подій " + st.confirmed + (st.expected === null ? "" : " із " + st.expected + (st.missing ? " (бракує " + st.missing + ")" : "")));
      detailLine(dl, "Закриті угоди", st.status === "insufficient" ? "Недостатньо даних" : st.closed + " (прибуткових " + st.wins + ", збиткових " + st.losses + ", нульових " + st.flat + ")" + (st.orphan ? "; закриттів без відомого відкриття: " + st.orphan : ""));
      detailLine(dl, "Win Rate", wc[0]); detailLine(dl, "Реалізований PnL", st.realized === null ? null : usdTxt(st.realized) + (st.avgUsd === null ? "" : " · середня угода " + usdTxt(st.avgUsd) + " / " + pctTxt(st.avgPct)));
      detailLine(dl, "Комісії й проковзання", st.feeUsd === null ? null : (st.feeMissing ? "≥ " : "") + nf(st.feeUsd, 2) + " $");
      detailLine(dl, "Виходи Stop Loss / Take Profit / Trailing", d.exits.stop + d.exits.take + d.exits.trail ? "SL " + d.exits.stop + " · TP " + d.exits.take + " · Trailing " + d.exits.trail + " (з даними виконання: " + d.exits.withInfo + ")" : null);
      box.appendChild(dl);
      if (d.siblings.length > 1) {
        const sb = h("div", "wl-det-sib"); sb.appendChild(h("h4", "wl-h4", "Той самий бот у гаманцях (окремі незалежні рахунки)"));
        d.siblings.forEach(function (x) { sb.appendChild(h("div", "wl-ptile-s" + (x.current ? " wl-det-cur" : ""), capLabel(x.wallet) + ": " + usdTxt(x.usd) + " · " + pctTxt(x.pct) + " · угод " + dash(x.trades, String) + (x.current ? " ← цей рахунок" : ""))); });
        sb.appendChild(h("p", "wl-muted wl-small", "Рахунки не складаються в один портфель: у кожного свій старт і свій набір монет.")); box.appendChild(sb);
      }
      if (d.latest.length) {
        const lt = h("div", "wl-det-ops"); lt.appendChild(h("h4", "wl-h4", "Останні підтверджені операції"));
        d.latest.forEach(function (o) { lt.appendChild(h("div", "wl-ptile-s", hhmm(o.t) + " · " + (o.type === "open" ? "BUY" : "SELL") + " " + o.coin + " по " + px(o.price) + (o.type === "close" ? (o.pnlUsd !== null ? " · " + usdTxt(o.pnlUsd) + " (" + pctTxt(o.pnlPct) + ")" : " · результат невідомий") + (o.exit && o.exit !== "unknown" ? " · " + (EXIT[o.exit] || o.exit) : "") : ""))); });
        box.appendChild(lt);
      } else box.appendChild(h("p", "wl-muted wl-small", "Підтверджених операцій цього рахунку в завантажених даних немає."));
      return box;
    }
    function ptHead(onSort) {
      const thead = h("thead"), tr = h("tr"); tr.appendChild(h("th", "wl-pt-x", ""));
      PT_COLS.forEach(function (c) {
        const th = h("th", c[2] ? "wl-num" : ""), b = h("button", "wl-th", c[1]); b.type = "button"; b.setAttribute("data-sort", c[0]); th.setAttribute("aria-sort", pt.sort === c[0] ? (pt.dir === "asc" ? "ascending" : "descending") : "none"); if (pt.sort === c[0]) b.textContent = c[1] + (pt.dir === "asc" ? " ▲" : " ▼");
        b.addEventListener("click", function () { if (pt.sort === c[0]) pt.dir = pt.dir === "asc" ? "desc" : "asc"; else { pt.sort = c[0]; pt.dir = c[0] === "title" || c[0] === "statusRank" ? "asc" : "desc"; } pt.shown = 12; onSort(); }); th.appendChild(b); tr.appendChild(th);
      });
      thead.appendChild(tr); return thead;
    }
    function renderProAccBody() {
      const rs = rows(), list = D.sortRows(D.proFilterRows(rs, pt), pt.sort, pt.dir), box = ui.ptBody; box.replaceChildren();
      box.appendChild(h("p", "wl-muted wl-small wl-pt-count", "Показано " + Math.min(list.length, pt.shown) + " із " + list.length + " рахунків (усього " + rs.length + "). Кожен бот у кожному гаманці — окремий незалежний рахунок."));
      const t = h("table", "wl-tbl wl-pt"); t.appendChild(ptHead(renderProAccBody)); const tb = h("tbody");
      list.slice(0, pt.shown).forEach(function (r) {
        const key = accKey(r), open = !!pt.open[key], tr = h("tr", "wl-r" + (r.hasData ? "" : " nodata") + (open ? " sel" : "") + (r.bot === prefs.bot ? " wl-cur" : "")); tr.setAttribute("data-bot", r.bot); tr.setAttribute("data-wallet", r.wallet); tr.setAttribute("data-status", r.status);
        const lab = function (td, k) { td.setAttribute("data-label", k); return td; };
        const xb = h("button", "wl-btn wl-pt-tog", open ? "▾" : "▸"); xb.type = "button"; xb.setAttribute("aria-expanded", open ? "true" : "false"); xb.setAttribute("aria-label", (open ? "Згорнути" : "Розгорнути") + " деталі: " + r.title + ", " + capLabel(r.wallet)); xb.addEventListener("click", function () { pt.open[key] = !open; renderProAccBody(); });
        const tx = h("td", "wl-pt-x"); tx.appendChild(xb); tr.appendChild(tx);
        const bn = h("td", "wl-botc"), lk = h("button", "wl-link", r.title); lk.type = "button"; lk.title = r.title; lk.addEventListener("click", function () { prefs.mode = "bot"; prefs.bot = r.bot; changed(true); }); bn.appendChild(lk); tr.appendChild(lab(bn, "Бот")); tr.appendChild(lab(h("td", "", capLabel(r.wallet)), "Гаманець"));
        if (!r.hasData) { const c = h("td", "wl-muted", "Немає збережених точок"); c.colSpan = 10; tr.appendChild(c); tb.appendChild(tr); } else {
          lab(numCell(tr, nf(r.value, 2) + " $"), "Вартість"); lab(numCell(tr, usdTxt(r.resultUsd), tone(r.resultUsd)), "P/L, $"); lab(numCell(tr, pctTxt(r.resultPct), tone(r.resultPct)), "%"); lab(numCell(tr, dash(r.trades, String)), "Угоди"); lab(numCell(tr, dash(r.open, String)), "Поз."); lab(numCell(tr, r.dd === null ? "—" : ddTxt(r.dd)), "Просідання");
          const wc = winCell(r), pcl = pnlCell(r); lab(numCell(tr, wc[0].replace(/ · (повні дані|часткові)$/, ""), wc[1], wc[2]), "Win Rate"); lab(numCell(tr, pcl[0].replace(/ · часткові$/, ""), pcl[1], pcl[2]), "Реалізований PnL"); const tdc = h("td", ""); tdc.appendChild(complBadge(r.status)); tr.appendChild(lab(tdc, "Повнота")); tb.appendChild(tr);
        }
        if (open) { const dr = h("tr", "wl-det"), dc = h("td", ""); dc.colSpan = PT_COLS.length + 1; dc.setAttribute("role", "region"); dc.setAttribute("aria-label", "Деталі рахунку " + r.title + ", " + capLabel(r.wallet)); dc.appendChild(accDetailNode(r, rs)); dr.appendChild(dc); tb.appendChild(dr); }
      });
      if (!list.length) { const r = h("tr"), c = h("td", "wl-muted", "За вибраними фільтрами рахунків немає."); c.colSpan = PT_COLS.length + 1; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb); box.appendChild(wrapTable(t));
      if (list.length > pt.shown) { const m = h("button", "wl-btn wl-more", "Показати ще (" + Math.min(12, list.length - pt.shown) + " із " + (list.length - pt.shown) + ")"); m.type = "button"; m.addEventListener("click", function () { pt.shown += 12; renderProAccBody(); }); box.appendChild(m); }
      box.appendChild(tableNote());
      const det = document.createElement("details"); det.className = "wl-pro-det"; det.appendChild(h("summary", "", "Методика: підтверджені угоди й реалізований PnL"));
      det.appendChild(h("p", "wl-muted wl-small", "Реалізований PnL — сума чистих результатів підтверджених закритих угод: депозит · частка · (eq продажу − eq купівлі), тобто з урахуванням комісії й проковзання обох сторін; пара «купівля → продаж» утворюється лише в межах одного раунду. Win Rate — частка прибуткових закриттів. Середній результат — середнє арифметичне чистих результатів. Комісії й проковзання — за всіма підтвердженими операціями рахунку (у деталях рахунку). «Повні дані» присвоюється тільки тоді, коли кількість підтверджених подій раунду дорівнює лічильнику угод рушія (а не тому, що подій багато). Реалізований PnL — окрема величина: вона не підміняє загальну зміну вартості рахунку."));
      box.appendChild(det);
    }
    function renderProAcc() {
      if (!model) return;
      const bar = h("div", "wl-filters"), reset = function () { pt.shown = 12; renderProAccBody(); };
      const q = document.createElement("input"); q.type = "search"; q.placeholder = "Пошук: бот або гаманець"; q.value = pt.q; q.setAttribute("aria-label", "Пошук рахунку"); q.className = "wl-search"; q.addEventListener("input", function () { pt.q = q.value; reset(); });
      const ql = h("label", "wl-fl"); ql.appendChild(h("span", "wl-lbl", "Пошук")); ql.appendChild(q); bar.appendChild(ql);
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), pt.wallet, function (v) { pt.wallet = v; reset(); }));
      bar.appendChild(sel("Результат", [["", "Будь-який"], ["plus", "У плюсі"], ["minus", "У мінусі"], ["zero", "Нульовий"]], pt.sign, function (v) { pt.sign = v; reset(); }));
      bar.appendChild(sel("Повнота", [["", "Будь-яка"], ["full", "Повні дані"], ["partial", "Часткові дані"], ["insufficient", "Недостатньо даних"]], pt.status, function (v) { pt.status = v; reset(); }));
      [["onlyTrades", "Лише з угодами"], ["onlyOpen", "Лише з позиціями"]].forEach(function (c) { const ck = h("label", "wl-fl wl-ck"), cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = pt[c[0]]; cb.addEventListener("change", function () { pt[c[0]] = cb.checked; reset(); }); ck.appendChild(cb); ck.appendChild(h("span", "", c[1])); bar.appendChild(ck); });
      ui.ptBody = h("div", "wl-tbody-wrap"); const cnt = { full: 0, partial: 0, insufficient: 0 }, all = rows(); all.forEach(function (r) { cnt[r.status]++; });
      const sum = h("p", "wl-muted wl-small wl-qsum", "Область: " + (prefs.scope === "all" ? "усі завантажені раунди" : "поточний раунд") + ". Рахунків: повні дані — " + cnt.full + ", часткові — " + cnt.partial + ", недостатньо даних — " + cnt.insufficient + " із " + all.length + ".");
      ui.proAcc.replaceChildren(bar, scopeControl(), archiveStatusNode(), sum, ui.ptBody); renderProAccBody();
    }

    // ---------- Analytics Pro 2: нова історія операцій (пошук, фільтри, сортування, пагінація, розкривні деталі) ----------
    function phTitles() { const m = {}; model.rules.forEach(function (r) { m[r.id] = r.title; }); return m; }
    function phList() { return D.proSortOps(D.proFilterOps(extra.ops, ph, env.now(), phTitles()), ph.sort, ph.dir); }
    function opDetailNode(o) {
      const dl = h("dl", "wl-dl"), box = h("div", "wl-det-box");
      detailLine(dl, "Бот · гаманець", ruleTitle(o.bot) + " · " + capLabel(o.wallet)); detailLine(dl, "Операція", (o.type === "open" ? (o.initial ? "BUY · старт раунду" : "BUY (відкриття)") : "SELL (закриття)") + " " + o.coin + "/USDT");
      detailLine(dl, o.type === "open" ? "Ціна входу" : "Ціна виходу", px(o.price)); if (o.type === "close") detailLine(dl, "Ціна входу", o.entry === null ? "невідома: немає відкриття в підтверджених записах" : px(o.entry));
      detailLine(dl, "Обсяг", o.volUsd === null ? null : nf(o.volUsd, 2) + " $" + (o.volQty === null ? "" : " · " + nf(o.volQty, o.volQty >= 1 ? 4 : 6) + " " + o.coin));
      detailLine(dl, "Комісія й проковзання", o.feeUsd === null ? "невідомі: немає даних про витрати" : nf(o.feeUsd, 2) + " $ (" + nf(o.cost * 100, 3) + "%)");
      if (o.type === "close") { detailLine(dl, "Результат угоди", o.pnlUsd === null ? "невідомий: немає відкриття" : usdTxt(o.pnlUsd) + " · " + pctTxt(o.pnlPct) + (o.pctEst ? " (% оцінено за комісією моделі)" : "")); detailLine(dl, "Причина виходу", o.exit && o.exit !== "unknown" ? (EXIT[o.exit] || o.exit) : EXIT.unknown); detailLine(dl, "Виконання виходу", execText(o)); }
      detailLine(dl, "Раунд", typeof o.roundKey === "number" ? hhmm(o.roundKey) + (o.roundCurrent ? " (поточний)" : "") : "невідомий"); detailLine(dl, "Джерела", o.src.map(function (x) { return x === "paper_archive" ? "архів" : x === "paper_events" ? "журнал" : "стрічка"; }).join(" + "));
      detailLine(dl, "Повнота рахунку в раунді", D.COMPL_TXT[o.compl] + (o.complEntry ? " · підтверджено подій " + o.complEntry.confirmed + (o.complEntry.expected === null ? "" : " із " + o.complEntry.expected) : "")); detailLine(dl, "Рішення бота", o.reason || null);
      box.appendChild(dl); if (o.type === "close" && o.exit && ["stop", "take", "trail"].indexOf(o.exit) >= 0) box.appendChild(h("p", "wl-muted wl-small", D.EXIT_NOTE)); return box;
    }
    function renderProHistBody() {
      const list = phList(), box = ui.phBody; box.replaceChildren();
      const sl = extra.ops.filter(function (o) { return o.type === "close" && (o.exit === "stop" || o.exit === "take" || o.exit === "trail"); }), withInfo = sl.filter(function (o) { return !!o.exitInfo; });
      box.appendChild(h("p", "wl-muted wl-small wl-exsum", "Виходів за Stop Loss / Take Profit / Trailing Stop у завантажених даних: " + sl.length + ", з даними про виконання (exit_info): " + withInfo.length + ", без них (записані до їх появи): " + (sl.length - withInfo.length) + ". Фактичний поріг, ціни входу й виходу та відхилення — у деталях операції (розкрийте рядок)." + (sl.length && !withInfo.length ? " Для старих виходів дані виконання не вигадуємо." : "")));
      box.appendChild(h("p", "wl-muted wl-small wl-ph-count", "Показано " + Math.min(list.length, ph.shown) + " із " + list.length + " операцій (завантажено підтверджених: " + extra.ops.length + ")."));
      const t = h("table", "wl-tbl wl-ph"), hr = h("tr"); hr.appendChild(h("th", "wl-pt-x", ""));
      [["t", "Час", false], [null, "Рахунок", false], [null, "Монета", false], [null, "Операція", false], ["price", "Ціна", true], ["pnl", "Результат", true], [null, "Повнота", false]].forEach(function (c) {
        const th = h("th", c[2] ? "wl-num" : "");
        if (c[0]) { const b = h("button", "wl-th", c[1] + (ph.sort === c[0] ? (ph.dir === "asc" ? " ▲" : " ▼") : "")); b.type = "button"; b.setAttribute("data-sort", c[0]); th.setAttribute("aria-sort", ph.sort === c[0] ? (ph.dir === "asc" ? "ascending" : "descending") : "none"); b.addEventListener("click", function () { if (ph.sort === c[0]) ph.dir = ph.dir === "asc" ? "desc" : "asc"; else { ph.sort = c[0]; ph.dir = "desc"; } ph.shown = 20; renderProHist(); }); th.appendChild(b); } else th.textContent = c[1];
        hr.appendChild(th);
      });
      t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      list.slice(0, ph.shown).forEach(function (o) {
        const open = !!ph.open[o.key], tr = h("tr", "wl-r " + (o.type === "open" ? "wl-buy" : "wl-sell") + (open ? " sel" : "")); tr.setAttribute("data-key", o.key); const lab = function (td, k) { td.setAttribute("data-label", k); return td; };
        const xb = h("button", "wl-btn wl-pt-tog", open ? "▾" : "▸"); xb.type = "button"; xb.setAttribute("aria-expanded", open ? "true" : "false"); xb.setAttribute("aria-label", (open ? "Згорнути" : "Розгорнути") + " деталі операції"); xb.addEventListener("click", function () { ph.open[o.key] = !open; renderProHistBody(); });
        const tx = h("td", "wl-pt-x"); tx.appendChild(xb); tr.appendChild(tx);
        tr.appendChild(lab(h("td", "", hhmm(o.t)), "Час")); const ac = h("td", "wl-botc", ruleTitle(o.bot) + " · " + capLabel(o.wallet)); ac.title = ruleTitle(o.bot) + " · " + capLabel(o.wallet); tr.appendChild(lab(ac, "Рахунок")); tr.appendChild(lab(h("td", "", o.coin), "Монета"));
        tr.appendChild(lab(h("td", o.type === "open" ? "up" : "down", o.type === "open" ? (o.initial ? "BUY · старт" : "BUY") : "SELL" + (o.exit && o.exit !== "unknown" ? " · " + (EXIT[o.exit] || o.exit) : "")), "Операція")); lab(numCell(tr, px(o.price)), "Ціна");
        const hasRes = o.type === "close" && o.pnlUsd !== null; lab(numCell(tr, o.type === "open" ? "—" : hasRes ? usdTxt(o.pnlUsd) + " · " + pctTxt(o.pnlPct) : "невідомий", o.type === "open" ? "wl-muted" : hasRes ? tone(o.pnlUsd) : "wl-muted"), "Результат");
        const tdc = h("td", ""); tdc.appendChild(complBadge(o.compl)); tr.appendChild(lab(tdc, "Повнота")); tb.appendChild(tr);
        if (open) { const dr = h("tr", "wl-det"), dc = h("td", ""); dc.colSpan = 8; dc.setAttribute("role", "region"); dc.setAttribute("aria-label", "Деталі операції"); dc.appendChild(opDetailNode(o)); dr.appendChild(dc); tb.appendChild(dr); }
      });
      if (!list.length) { const r = h("tr"), c = h("td", "wl-muted", "Підтверджених операцій за вибраними фільтрами немає."); c.colSpan = 8; r.appendChild(c); tb.appendChild(r); }
      t.appendChild(tb); box.appendChild(wrapTable(t));
      if (list.length > ph.shown) { const m = h("button", "wl-btn wl-more", "Показати ще (" + Math.min(20, list.length - ph.shown) + " із " + (list.length - ph.shown) + ")"); m.type = "button"; m.addEventListener("click", function () { ph.shown += 20; renderProHistBody(); }); box.appendChild(m); }
      box.appendChild(histNote());
    }
    function renderProHist() {
      if (!model) return;
      const bar = h("div", "wl-filters"), reset = function () { ph.shown = 20; renderProHistBody(); };
      const q = document.createElement("input"); q.type = "search"; q.placeholder = "Пошук: бот, монета, причина"; q.value = ph.q; q.setAttribute("aria-label", "Пошук операції"); q.className = "wl-search"; q.addEventListener("input", function () { ph.q = q.value; reset(); });
      const ql = h("label", "wl-fl"); ql.appendChild(h("span", "wl-lbl", "Пошук")); ql.appendChild(q); bar.appendChild(ql);
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), ph.wallet, function (v) { ph.wallet = v; reset(); }));
      bar.appendChild(sel("Бот", botOpts("Усі боти"), ph.bot, function (v) { ph.bot = v; reset(); }));
      const coins = {}; extra.ops.forEach(function (o) { coins[o.coin] = 1; });
      bar.appendChild(sel("Монета", [["", "Усі монети"]].concat(Object.keys(coins).sort().map(function (c) { return [c, c]; })), ph.coin, function (v) { ph.coin = v; reset(); }));
      bar.appendChild(sel("Операція", [["", "BUY і SELL"], ["open", "BUY"], ["close", "SELL"]], ph.type, function (v) { ph.type = v; reset(); }));
      bar.appendChild(sel("Результат", [["", "Будь-який"], ["profit", "Прибуток"], ["loss", "Збиток"], ["flat", "Нульовий"], ["unknown", "Невідомий"], ["open", "Відкриття (без результату)"]], ph.result, function (v) { ph.result = v; reset(); }));
      bar.appendChild(sel("Вихід", [["", "Будь-який"], ["stop", "Stop Loss"], ["take", "Take Profit"], ["trail", "Trailing Stop"], ["trend", "Злам тренду"], ["signal", "Сигнал правила"], ["unknown", "Причина не вказана"]], ph.exit, function (v) { ph.exit = v; reset(); }));
      bar.appendChild(sel("Період", [["round", "Поточний раунд"], ["24h", "24 години"], ["7d", "7 днів"], ["all", "Увесь архів"]], ph.period, function (v) { ph.period = v; ensureArchive(); reset(); }));
      bar.appendChild(sel("Сортування", [["t", "За часом"], ["pnl", "За результатом"], ["vol", "За обсягом"], ["fee", "За комісією"], ["price", "За ціною"]], ph.sort, function (v) { ph.sort = v; ph.dir = "desc"; reset(); }));
      const dir = h("button", "wl-btn wl-ph-dir", ph.dir === "asc" ? "▲ за зростанням" : "▼ за спаданням"); dir.type = "button"; dir.setAttribute("aria-label", "Напрям сортування"); dir.addEventListener("click", function () { ph.dir = ph.dir === "asc" ? "desc" : "asc"; renderProHist(); });
      bar.appendChild(dir);
      ui.phBody = h("div", "wl-tbody-wrap"); ui.proHist.replaceChildren(bar, archiveStatusNode(), ui.phBody); renderProHistBody();
    }


    // ---------- Analytics Pro 4: динаміка стратегій і порівняння періодів ----------
    const dy = { bot: "", wallet: "", period: "all", unit: "pct", cmp: "24h", cwallet: "", cbot: "", a: { from: "", to: "" }, b: { from: "", to: "" } };
    function dayMs(v, end) { if (!v) return NaN; const t = Date.parse(v + "T00:00:00"); return isNaN(t) ? NaN : (end ? t + 86400000 - 1 : t); }
    function lineChart(host, series, o) {                                                 // series: [{pts:[[t,v]], color, dash, label}]
      const W = 640, H = 190, L = 46, Rr = 8, T = 10, B = 22, all = [];
      series.forEach(function (s) { s.pts.forEach(function (p) { all.push(p); }); });
      const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "wl-dyn-svg", role: "img", "aria-label": o.aria }, host);
      if (all.length < 2) { return svg; }
      let t0 = Infinity, t1 = -Infinity, v0 = 0, v1 = 0; all.forEach(function (p) { t0 = Math.min(t0, p[0]); t1 = Math.max(t1, p[0]); v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]); });
      if (v1 - v0 < 1e-9) { v1 += 1; v0 -= 1; } const pad = (v1 - v0) * 0.08; v0 -= pad; v1 += pad; if (t1 <= t0) t1 = t0 + 1;
      const X = function (t) { return L + (t - t0) / (t1 - t0) * (W - L - Rr); }, Y = function (v) { return T + (1 - (v - v0) / (v1 - v0)) * (H - T - B); };
      [v0 + pad, 0, v1 - pad].forEach(function (g, i) { if (i === 1 && !(g > v0 && g < v1)) return; svgEl("line", { x1: L, x2: W - Rr, y1: Y(g), y2: Y(g), class: g === 0 ? "wl-dyn-zero" : "wl-dyn-grid" }, svg); const tx = svgEl("text", { x: L - 4, y: Y(g) + 3, "text-anchor": "end", class: "wl-dyn-ax" }, svg); tx.textContent = o.fmt(g); });
      [t0, (t0 + t1) / 2, t1].forEach(function (t, i) { const tx = svgEl("text", { x: X(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === 2 ? "end" : "middle", class: "wl-dyn-ax" }, svg); tx.textContent = hhmm(t); });
      series.forEach(function (s) { if (s.pts.length > 1) svgEl("polyline", { points: s.pts.map(function (p) { return X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-dasharray": s.dash || "", class: "wl-dyn-line" }, svg); });
      return svg;
    }
    function dynWallets() { return dy.wallet === "" ? model.caps : [Number(dy.wallet)]; }
    function renderDynamics() {
      if (!model || !root.ReportCore) return; const RC = root.ReportCore, host = ui.dyn;
      if (!dy.bot || !model.rules.some(function (r) { return r.id === dy.bot; })) dy.bot = model.rules[0].id;
      const bar = h("div", "wl-filters");
      bar.appendChild(sel("Бот", botOpts("").slice(1), dy.bot, function (v) { dy.bot = v; renderDynamics(); }));
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці (окремі графіки)"), dy.wallet, function (v) { dy.wallet = v; renderDynamics(); }));
      bar.appendChild(sel("Період", [["all", "Увесь доступний"], ["24h", "24 години"], ["7d", "7 днів"], ["30d", "30 днів"]], dy.period, function (v) { dy.period = v; renderDynamics(); }));
      bar.appendChild(sel("Шкала", [["pct", "Дохідність, %"], ["usd", "Капітал-результат, $"]], dy.unit, function (v) { dy.unit = v; renderDynamics(); }));
      const res = RC.dynamics(model, extra.ops, extra.comp, { bot: dy.bot, wallet: dy.wallet === "" ? undefined : Number(dy.wallet), period: dy.period });
      host.replaceChildren(bar);
      if (res.errors.length) { host.appendChild(h("p", "wl-muted", res.errors.join(" "))); return; }
      host.appendChild(h("p", "wl-muted wl-small", "Три гаманці — це три незалежні рахунки з різними монетами, тому спільної кривої капіталу немає: кожен гаманець має власний графік. Дані — збережені точки історії; прогалини не заповнюються."));
      const grid = h("div", "wl-dyn-grid-box");
      res.panels.forEach(function (p) {
        const c = h("div", "wl-dyn"); c.setAttribute("data-dyn-wallet", String(p.cap)); c.appendChild(h("h3", "wl-h3", capLabel(p.cap) + " · " + p.title));
        if (p.status !== "ok") { c.appendChild(h("p", "wl-muted", "Немає даних: " + (p.reason || "недостатньо точок equity") + ".")); grid.appendChild(c); return; }
        const kv = h("dl", "wl-dl wl-dyn-kv"); const add = function (k, v) { kv.appendChild(h("dt", "", k)); kv.appendChild(h("dd", "", v)); };
        add("Результат", usdTxt(p.usd) + " · " + pctTxt(p.pct) + (p.coverage === "partial" ? " (період скорочено до початку даних)" : ""));
        add("Макс. просідання", p.dd === null ? "невідоме" : ddTxt(p.dd));
        add("Зміна просідання", p.ddChange === null ? "недоступна: " + p.ddReason : (p.ddChange > 0 ? "+" : p.ddChange < 0 ? "−" : "") + nf(Math.abs(p.ddChange), 2) + " в.п. (попереднє: " + ddTxt(p.ddPrev) + ")");
        add("Операцій за період", String(p.opsCount));
        add("Buy & Hold", p.vsHold === null ? "немає даних: " + p.holdReason : pctTxt(p.holdPct) + " · різниця " + pctTxt(p.vsHold).replace("%", " в.п."));
        add("Останній час", p.recent.map(function (r) { return r.label + ": " + (r.pct === null ? "—" : pctTxt(r.pct)); }).join(" · "));
        c.appendChild(kv);
        const series = [{ pts: dy.unit === "pct" ? p.series.pct : p.series.usd, color: D.COLORS[p.cap] || "#4C8DFF", label: "Стратегія" }];
        if (dy.unit === "pct" && p.hold) series.push({ pts: p.hold, color: "#9AA4B2", dash: "5 4", label: "Buy & Hold" });
        const box = h("div", "wl-dyn-chart"); lineChart(box, series, { aria: "Динаміка " + p.title + ", " + capLabel(p.cap), fmt: function (v) { return dy.unit === "pct" ? nf(v, 1) + "%" : nf(v, 0) + " $"; } });
        if (p.series.pct.length < 2) box.appendChild(h("p", "wl-muted wl-small", "Замало точок для графіка (" + p.series.pct.length + ")."));
        c.appendChild(box);
        if (dy.unit === "pct" && p.hold) c.appendChild(h("p", "wl-muted wl-small", "Суцільна лінія — стратегія, штрихова — утримання монет без торгівлі (Buy & Hold)."));
        c.appendChild(riskNode(p));
        grid.appendChild(c);
      });
      host.appendChild(grid);
    }
    function riskNode(p) {
      const d = h("div", "wl-risk"); d.setAttribute("data-risk", String(p.cap)); d.appendChild(h("h4", "wl-h4", "Ризики"));
      const dl = h("dl", "wl-dl"), add = function (k, v) { dl.appendChild(h("dt", "", k)); dl.appendChild(h("dd", "", v)); };
      add("Закритих угод", p.closed === null ? "невідомо" : String(p.closed)); add("Прибуткових / збиткових", p.closed === null ? "невідомо" : p.wins + " / " + p.losses + (p.closed ? " (" + nf(p.wins / p.closed * 100, 0) + "% / " + nf(p.losses / p.closed * 100, 0) + "%)" : ""));
      add("Частка часу з позиціями", p.tim === null ? "недоступна: " + p.timReason : nf(p.tim * 100, 0) + "% (середнє по монетах гаманця)"); add("Реалізований PnL", p.realized === null ? "невідомий" : usdTxt(p.realized)); add("Комісії й проковзання", p.feeUsd === null ? "невідомі" : nf(p.feeUsd, 2) + " $");
      d.appendChild(dl);
      if (p.closed === null) d.appendChild(h("p", "wl-warn wl-small", "Закритих підтверджених угод немає: показники win/loss неможливо оцінити."));
      else if (p.smallSample) d.appendChild(h("p", "wl-warn wl-small", "Мала вибірка: лише " + p.closed + " закритих угод (менше " + root.ReportCore.MIN_SAMPLE + "). Відсотки й середні значення ненадійні."));
      if (p.tim === null) d.appendChild(h("p", "wl-warn wl-small", "Частка часу з позиціями не показана: історія операцій неповна, оцінка була б хибною."));
      d.appendChild(h("p", "wl-muted wl-small", "Це історичні показники симуляції, а не прогноз і не гарантія прибутку."));
      return d;
    }

    const CHG = { up: ["▲", "піднялась", "up"], down: ["▼", "опустилась", "down"], same: ["=", "без змін", ""], insufficient: ["?", "недостатньо даних", "wl-muted"] };
    function renderPeriodCmp() {
      if (!model || !root.ReportCore) return; const RC = root.ReportCore, host = ui.pcmp, bar = h("div", "wl-filters"), seg = h("div", "wl-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Порівнювані періоди");
      [["24h", "24 год проти попередніх 24 год"], ["7d", "7 днів проти попередніх 7"], ["30d", "30 днів проти попередніх 30"], ["custom", "Власні періоди"]].forEach(function (x) { const b = h("button", "wl-btn" + (dy.cmp === x[0] ? " on" : ""), x[1]); b.type = "button"; b.setAttribute("data-cmp", x[0]); b.setAttribute("aria-pressed", dy.cmp === x[0] ? "true" : "false"); b.addEventListener("click", function () { dy.cmp = x[0]; renderPeriodCmp(); }); seg.appendChild(b); });
      host.replaceChildren(seg, bar);
      bar.appendChild(sel("Гаманець", walletOpts("Усі гаманці"), dy.cwallet, function (v) { dy.cwallet = v; renderPeriodCmp(); }));
      bar.appendChild(sel("Стратегія", botOpts("Усі стратегії"), dy.cbot, function (v) { dy.cbot = v; renderPeriodCmp(); }));
      if (dy.cmp === "custom") {
        const di = function (label, o, k) { const l = h("label", "wl-fl"); l.appendChild(h("span", "wl-lbl", label)); const i = document.createElement("input"); i.type = "date"; i.value = o[k]; i.setAttribute("aria-label", label); i.addEventListener("change", function () { o[k] = i.value; renderPeriodCmp(); }); l.appendChild(i); return l; };
        bar.appendChild(di("Період A: з", dy.a, "from")); bar.appendChild(di("Період A: по", dy.a, "to")); bar.appendChild(di("Період B: з", dy.b, "from")); bar.appendChild(di("Період B: по", dy.b, "to"));
      }
      const o = { mode: dy.cmp, wallet: dy.cwallet === "" ? undefined : Number(dy.cwallet), bots: dy.cbot ? [dy.cbot] : undefined, metric: dy.cwallet === "" ? "pct" : prefs.proMetric, idle: prefs.proIdle === "1" };
      if (dy.cmp === "custom") { o.a = { from: dayMs(dy.a.from), to: dayMs(dy.a.to, true) }; o.b = { from: dayMs(dy.b.from), to: dayMs(dy.b.to, true) }; }
      const r = RC.compare(model, extra.ops, extra.comp, o);
      if (r.errors.length) { const p = h("p", "wl-muted", dy.cmp === "custom" && !dy.a.from ? "Оберіть дати обох періодів: поточного (A) і порівнюваного (B)." : r.errors.join(" ")); p.setAttribute("data-cmp-state", "error"); host.appendChild(p); return; }
      host.appendChild(h("p", "wl-small", "Поточний період A: " + r.windows.a.text + " · порівнюється з B: " + r.windows.b.text));
      r.notes.forEach(function (n) { host.appendChild(h("p", "wl-warn wl-small", n)); });
      if (!r.allowed) { const bx = h("div", "wl-cmp-no"); bx.setAttribute("data-cmp-state", "blocked"); r.reasons.forEach(function (t) { bx.appendChild(h("p", "", t)); }); host.appendChild(bx); return; }
      if (r.reasons.length) { const bx = h("div", "wl-warn wl-small"); r.reasons.forEach(function (t) { bx.appendChild(h("p", "", t)); }); host.appendChild(bx); }
      // підсумок по гаманцях
      const t = h("table", "wl-tbl wl-cmp"), hr = h("tr"); ["Гаманець", "Рахунків", "A, %", "B, %", "Зміна, в.п.", "Макс. просідання A / B", "Операцій A / B"].forEach(function (c, i) { hr.appendChild(h("th", i ? "wl-num" : "", c)); }); t.appendChild(h("thead")).appendChild(hr); const tb = h("tbody");
      r.summary.forEach(function (s) { const tr = h("tr"), lab = function (td, k) { td.setAttribute("data-label", k); return td; }; tr.appendChild(lab(h("td", "", capLabel(s.wallet)), "Гаманець")); lab(numCell(tr, String(s.accounts)), "Рахунків");
        lab(numCell(tr, s.pctA === null ? "—" : pctTxt(s.pctA), s.pctA === null ? "" : tone(s.pctA)), "A, %"); lab(numCell(tr, s.pctB === null ? "—" : pctTxt(s.pctB), s.pctB === null ? "" : tone(s.pctB)), "B, %");
        const d = s.pctA !== null && s.pctB !== null ? s.pctA - s.pctB : null; lab(numCell(tr, d === null ? "—" : pctTxt(d).replace("%", ""), d === null ? "" : tone(d)), "Зміна, в.п."); lab(numCell(tr, (s.ddA === null ? "—" : ddTxt(s.ddA)) + " / " + (s.ddB === null ? "—" : ddTxt(s.ddB))), "Макс. просідання A / B"); lab(numCell(tr, s.opsA + " / " + s.opsB), "Операцій A / B"); tb.appendChild(tr); });
      t.appendChild(tb); host.appendChild(wrapTable(t));
      // зміна місць
      host.appendChild(h("h3", "wl-h3", "Зміна місць стратегій"));
      host.appendChild(h("p", "wl-muted wl-small", "Правила рейтингу однакові в обох періодах (" + (r.wallet === "" ? "середня дохідність % трьох незалежних рахунків" : r.metric === "usd" ? "результат у $ вибраного гаманця" : "дохідність % вибраного гаманця") + "); боти без угод " + (r.idle ? "включені" : "не входять") + "."));
      if (!r.rankComparable) { const w = h("p", "wl-warn"); w.setAttribute("data-rank-state", "invalid"); w.textContent = "Місця не порівнюються: " + r.rankReason; host.appendChild(w); }
      const rt = h("table", "wl-tbl wl-rank"), rh = h("tr"); ["Стратегія", "Місце A", "Місце B", "Зміна"].forEach(function (c, i) { rh.appendChild(h("th", i && i < 3 ? "wl-num" : "", c)); }); rt.appendChild(h("thead")).appendChild(rh); const rb = h("tbody");
      r.strategies.forEach(function (s) { const tr = h("tr"), g = CHG[s.change], lab = function (td, k) { td.setAttribute("data-label", k); return td; }; tr.setAttribute("data-bot", s.bot); tr.appendChild(lab(h("td", "wl-botc", s.title), "Стратегія"));
        lab(numCell(tr, s.rankA === null ? "—" : (s.tieA ? "= " : "") + s.rankA), "Місце A"); lab(numCell(tr, s.rankB === null ? "—" : (s.tieB ? "= " : "") + s.rankB), "Місце B");
        const td = h("td", g[2]); const b = h("span", "wl-rk wl-rk-" + s.change, g[0] + " " + g[1]); b.setAttribute("data-change", s.change); if (s.reason) b.title = s.reason; td.appendChild(b); if (s.change === "insufficient" && s.reason) td.appendChild(h("span", "wl-muted wl-small", " — " + s.reason)); tr.appendChild(lab(td, "Зміна")); rb.appendChild(tr); });
      rt.appendChild(rb); host.appendChild(wrapTable(rt));
      // рахунки (деталізація, лише порівнянні)
      const det = document.createElement("details"); det.className = "wl-pro-det"; det.appendChild(h("summary", "", "Деталі по рахунках (" + r.comparableAccounts + " із " + r.accounts.length + " порівнянні)"));
      const at = h("table", "wl-tbl wl-cmpacc"), ah = h("tr"); ["Рахунок", "A, %", "B, %", "Просідання A / B", "Операцій A / B", "Закрито A / B", "Мала вибірка", "Примітка"].forEach(function (c, i) { ah.appendChild(h("th", i && i < 6 ? "wl-num" : "", c)); }); at.appendChild(h("thead")).appendChild(ah); const ab = h("tbody");
      r.accounts.forEach(function (a) { const tr = h("tr"), lab = function (td, k) { td.setAttribute("data-label", k); return td; }; tr.appendChild(lab(h("td", "wl-botc", a.title + " · " + capLabel(a.wallet)), "Рахунок"));
        const v = function (x, f) { return x === null || x === undefined ? "—" : f(x); };
        lab(numCell(tr, a.comparable ? v(a.a.pct, pctTxt) : "—"), "A, %"); lab(numCell(tr, a.comparable ? v(a.b.pct, pctTxt) : "—"), "B, %"); lab(numCell(tr, a.comparable ? v(a.a.dd, ddTxt) + " / " + v(a.b.dd, ddTxt) : "—"), "Просідання A / B"); lab(numCell(tr, a.comparable ? a.a.ops + " / " + a.b.ops : "—"), "Операцій A / B");
        lab(numCell(tr, a.comparable ? v(a.a.closed, String) + " / " + v(a.b.closed, String) : "—"), "Закрито A / B"); lab(h("td", "", a.comparable ? (a.a.smallSample || a.b.smallSample ? "так" : "ні") : "—"), "Мала вибірка"); tr.appendChild(lab(h("td", a.comparable ? "wl-muted" : "wl-warn", a.comparable ? "" : a.reason), "Примітка")); ab.appendChild(tr); });
      at.appendChild(ab); det.appendChild(wrapTable(at)); host.appendChild(det);
      host.appendChild(h("p", "wl-muted wl-small", "Порівняння історичних результатів симуляції. Це не прогноз: минулі показники не гарантують майбутніх."));
    }

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
    function renderExtra() { if (!reportUI && model && root.ReportUI && root.ReportCore) reportUI = root.ReportUI.mount(ui.rep, reportApi()); else if (reportUI) reportUI.refresh(); renderProAcc(); renderProHist(); renderDynamics(); renderPeriodCmp(); renderCompare(); renderCapital(); renderRounds(); renderDaily(); }

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
      if (kind === "bots") { const l = D.sortRows(D.proFilterRows(rows(), pt), pt.sort, pt.dir); if (l.length) text = D.botsCsv(l); }
      else if (kind === "ops") { const l = phList(); if (l.length) text = D.opsCsv(l.map(function (o) { return Object.assign({}, o, { botTitle: ruleTitle(o.bot) }); })); }
      else if (kind === "quality") { const l = D.sortRows(D.proFilterRows(rows(), pt), "wallet", "asc"); if (l.length) text = D.qualityCsv(l); }
      else if (kind === "daily") { if (D.dailyRows(model, query()).length) text = D.dailyCsv(model, query()); }
      else if (kind === "rounds") { if (D.roundsRows(model, query()).length) text = D.roundsCsv(model, query()); }
      if (!text) return null;
      const d = new Date(env.now()).toISOString().slice(0, 10), names = { bots: "boty", ops: "operatsii", quality: "pidtverdzheni-uhody", daily: "dennі-rezultaty", rounds: "raundy" };
      return { name: "wallets-" + (names[kind] || kind).replace("і", "i") + "-" + d + ".csv", text: text, rows: text.split("\r\n").length - 2 };
    }
    function doExport(kind) {
      const r = exportCsv(kind);
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
      if (prefs.scope === "all" || ph.period === "all" || repFrom === null) return null;
      let f = null; model.caps.forEach(function (c) { const w = model.wallets[c]; if (w && w.roundStart !== null) f = f === null ? w.roundStart : Math.min(f, w.roundStart); });
      if (f === null) return null;
      f -= 2 * 3600000; if (HP[ph.period]) f = Math.min(f, env.now() - HP[ph.period]); if (typeof repFrom === "number") f = Math.min(f, repFrom - 3600000);
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
    // API для блоку «Аналітичні звіти»: дані беруться з поточного стану сторінки (ті самі рядки, що в таблицях Analytics Pro)
    function reportApi() {
      return { model: function () { return model; }, ops: function () { return extra.ops; }, comp: function () { return extra.comp; }, now: function () { return env.now(); },
        archive: function () { if (arch.status === "idle") return null; const ix = arch.index; return { status: arch.status, loaded: arch.names.length, total: ix ? ix.segments.length : 0, bytes: ix ? ix.bytes : 0, events: ix ? ix.total : 0, reason: arch.reason }; },
        ensureArchive: function (from, periodKey) { repFrom = periodKey === "all" || from === null || from === undefined ? undefined : from; return ensureArchive(); },
        env: Object.assign({ storage: env.storage, download: env.download, downloadBytes: env.downloadBytes }, env.report || {}) };
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
