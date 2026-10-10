// Сторінка «Аналітика гаманців»: режими «Вибраний бот» / «Середнє по ботах», головний графік трьох гаманців, періоди й шкали.
// Дані: data/simulation.json (лише збережені криві curve і денні значення daily; нічого не перераховується й не домальовується), статус Testnet: data/trader.json.
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
      now: function () { return Date.now(); }, storage: root.localStorage, search: root.location ? root.location.search : "",
      setTimeout: function (f, ms) { return root.setTimeout(f, ms); }, clearTimeout: function (i) { root.clearTimeout(i); }, refreshMs: 60000,
    };
  }

  function mount(host, envIn) {
    const env = Object.assign(defaultEnv(), envIn || {});
    const params = new URLSearchParams(env.search || "");
    let prefs = { mode: "bot", bot: null, unit: "pct", period: "all", view: "curve" };
    try { const s = JSON.parse(env.storage.getItem(PREFS)); if (s && typeof s === "object") Object.keys(prefs).forEach(function (k) { if (typeof s[k] === "string") prefs[k] = s[k]; }); } catch (e) { /* без збережень */ }
    if (["bot", "avg"].indexOf(prefs.mode) < 0) prefs.mode = "bot";
    if (["pct", "usd", "log"].indexOf(prefs.unit) < 0) prefs.unit = "pct";
    if (!(prefs.period in D.PERIODS)) prefs.period = "all";
    if (["curve", "daily"].indexOf(prefs.view) < 0) prefs.view = "curve";
    let focus = parseInt(params.get("wallet"), 10) || null;
    const urlBot = params.get("bot");
    let model = null, loadError = null, trader = null, traderErr = null, hidden = {}, chart = null, feed = null, timer = 0, destroyed = false, lastOk = 0, detailCap = null, prices = {}, pricesAt = null, priceTimer = 0, priceLoopOn = false;
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
    // структура наступних підетапів (без показників)
    const rest = h("div", "wl-rest");
    [["wlCapital", "Розподіл капіталу"], ["wlTable", "Статистика ботів"], ["wlRounds", "Минулі раунди й денні підсумки"]].forEach(function (s) {
      const sec = h("div", "wl-card wl-soon"); sec.id = s[0]; sec.appendChild(h("h2", "wl-h2", s[1])); sec.appendChild(h("p", "wl-muted", "Розділ буде додано в наступному підетапі.")); rest.appendChild(sec);
    });
    const tn = h("div", "wl-card wl-testnet"); tn.id = "wlTestnet"; tn.appendChild(h("h2", "wl-h2", "Binance Testnet")); ui.tn = h("p", "wl-muted", "Перевіряємо статус…"); tn.appendChild(ui.tn);
    tn.appendChild(h("p", "wl-muted wl-small", "Окремий тестовий режим: не входить у статистику віртуальних рахунків і ніколи не змішується з нею."));
    const disc = h("p", "wl-disc", "Це симуляція на віртуальних грошах: інформація, а не фінансова порада й не прогноз. Дані беруться зі збережених точок історії; прогалини не заповнюються.");
    [bar, ui.err, ui.note, ui.focusNote, kpiBox, card, cardsSec, ui.detail, rest, tn, disc].forEach(function (n) { host.appendChild(n); });

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
      renderKpi(); renderCards(); renderDetail();
    }
    function now0() { return env.now(); }
    function roundStart() { const w = model.wallets[model.caps[0]]; return w && w.roundStart; }

    // ---------- KPI, картки, деталі ----------
    function sign(v) { return v >= 0 ? "+" : "−"; }
    function usdTxt(v) { return sign(v) + nf(Math.abs(v), 2) + " $"; }
    function pctTxt(v) { return sign(v) + nf(Math.abs(v), 2) + "%"; }
    function tone(v) { return v > 0.00001 ? "up" : v < -0.00001 ? "down" : ""; }
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
        tile("Просідання", k.dd === null ? "Немає даних" : "−" + nf(k.dd, 2) + "%", k.dd === null ? "немає спільних міток трьох рахунків" : "за кривою суми трьох рахунків (" + k.aggPoints + " спільних точок)", k.dd ? "down" : "");
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
        [["Початковий депозит", nf(cap, 0) + " $"], [avg ? "Угоди, Σ 16 ботів" : "Угоди", dash(s.trades, String)], [avg ? "Відкриті позиції, Σ" : "Відкриті позиції", dash(s.open, String)], ["Макс. просідання", s.dd === null ? "—" : "−" + nf(s.dd, 2) + "%"], ["Оновлено", hhmm(s.last.t)]].forEach(function (x) {
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
        row("Максимальне просідання", s.dd === null ? "немає даних" : "−" + nf(s.dd, 2) + "% (оцінка за дискретними точками" + (avg ? ", за середньою кривою" : "") + ")");
        row(avg ? "Угоди (сума по ботах)" : "Угоди в поточному раунді", dash(s.trades, String)); row(avg ? "Відкриті позиції (сума по ботах)" : "Відкриті позиції", dash(s.open, String));
        if (!avg) row("Монети в позиції", s.openCoins.length ? s.openCoins.join(", ") : "позицій немає");
        row("Збережених точок історії", s.points.length + " (від " + hhmm(s.first.t) + " до " + hhmm(s.last.t) + ")");
        if (avg) row("Мітки для середнього", "використано " + s.meta.used + ", відкинуто " + s.meta.dropped + " (бракує даних хоча б одного бота)");
      } else row("Історія", "немає збережених точок");
      row("Поточний раунд", w && w.roundStart ? hhmm(w.roundStart) + (w.roundEnd ? " — " + hhmm(w.roundEnd) : "") : null); row("Денних значень збережено", s.dailyDays);
      const lw = pricesAt !== null && env.now() - pricesAt < 90000 ? D.liveWallet(model, query(), detailCap, prices) : null;
      row("Поточна оцінка за ринковою ціною", lw && lw.open > 0 && lw.complete ? (avg ? "≈ " : "") + nf(detailCap * lw.eq, 2) + " $ · " + pctTxt((lw.eq - 1) * 100) + " (окремо від історії)" : (lw && lw.open === 0 ? "позицій немає: збігається зі збереженою" : "недоступна (немає живих цін для всіх відкритих позицій)"));
      ui.detail.appendChild(dl);
      ui.detail.appendChild(h("p", "wl-muted wl-small", "Розширену статистику ботів, розподіл капіталу й історію угод буде додано в наступних підетапах."));
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
        if (urlBot && model.rules.some(function (r) { return r.id === urlBot; }) && !load.once) prefs.bot = urlBot;
        load.once = true;
      }).catch(function (e) { loadError = (e && e.message ? e.message : "помилка").slice(0, 120); })
        .then(function () { if (!destroyed) render(true); })
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
      state: function () { return Object.assign({}, prefs, { focus: focus, hidden: Object.assign({}, hidden) }); }, chart: chart, model: function () { return model; }, reload: load,
      destroy: function () { destroyed = true; env.clearTimeout(timer); env.clearTimeout(priceTimer); chart.destroy(); if (feed) { feed.inst.destroy(); feed.host.remove(); } host.classList.remove("wl-page"); host.replaceChildren(); },
    };
  }

  root.WalletsPage = { mount: mount };
  if (typeof document !== "undefined") {
    const rootEl = document.getElementById("wlRoot");
    if (rootEl && !root.__WL_NO_AUTO) mount(rootEl);
  }
})(typeof window !== "undefined" ? window : this);
