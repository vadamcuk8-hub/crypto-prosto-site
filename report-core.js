// «Аналітичні звіти»: модель звіту (без DOM і без мережі; тестується в tools/test-reports.html).
// ВСІ показники беруться з тих самих функцій, що й Analytics Pro 1–2 (WalletsData): accountRows, accountStats, proRanking, proKpis, periodResult, buildHistory.
// Тут немає власної логіки PnL: звіт лише відбирає рахунки й операції за фільтрами, викликає ці функції і складає таблиці для PDF / XLSX / CSV.
// Принципи:
//   • 48 рахунків незалежні: жодної суми USD через гаманці, жодного «спільного портфеля»; загальний рейтинг стратегій — за простим середнім % трьох рахунків.
//   • Відсутні значення лишаються порожніми (null), а не нулями; часткова історія не видається за повну; Paper Trading не змішується з Testnet.
//   • Результат за період — лише за збереженими точками кривої (D.periodResult); якщо точок для періоду немає, дохідність не вигадується зі знімка.
//   • Поточний раунд: операції попередніх раундів не входять у підсумки (лише позначаються окремо).

(function (root) {
  "use strict";
  const D = root.WalletsData;
  const PERIODS = [["24h", "24 години"], ["7d", "7 днів"], ["30d", "30 днів"], ["all", "Увесь доступний період"], ["custom", "Власний діапазон"]];
  const WINDOW = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  const TOL = 25 * 60000, MAX_CUSTOM = 400 * 86400000;
  const LIMITS = { pdfOps: 3000, xlsxOps: 100000, csvOps: 200000, bigArchiveBytes: 8e6, bigArchiveEvents: 30000 };
  const COLORS = ["#F0B90B", "#0ECB81", "#2EBDFF", "#F6465D", "#A06BFF", "#FF8A3D"];
  const STATUS_TXT = D ? D.COMPL_TXT : {};

  function num(v) { return typeof v === "number" && isFinite(v); }
  function periodLabel(k) { const x = PERIODS.filter(function (p) { return p[0] === k; })[0]; return x ? x[1] : k; }
  function fmtDate(t) { return t === null || t === undefined ? "—" : new Date(t).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"; }

  // ---------- параметри ----------
  function normalize(model, p) {
    p = p || {};
    const errors = [], caps = model.caps, wallet = p.wallet !== "" && p.wallet !== null && p.wallet !== undefined && caps.indexOf(Number(p.wallet)) >= 0 ? Number(p.wallet) : "";
    const ids = model.rules.map(function (r) { return r.id; });
    let bots = null;
    if (Array.isArray(p.bots)) { bots = p.bots.filter(function (b) { return ids.indexOf(b) >= 0; }); if (!bots.length) errors.push("Не вибрано жодної стратегії."); }
    const kind = p.kind === "detailed" ? "detailed" : "short", period = PERIODS.some(function (x) { return x[0] === p.period; }) ? p.period : "all";
    const out = { wallet: wallet, bots: bots, kind: kind, period: period, from: null, to: null, format: p.format || "pdf" };
    if (period === "custom") {
      if (!num(p.from) || !num(p.to)) errors.push("Власний діапазон: вкажіть початок і кінець.");
      else if (!(p.from < p.to)) errors.push("Власний діапазон: початок має бути раніше за кінець.");
      else if (p.to - p.from > MAX_CUSTOM) errors.push("Власний діапазон завеликий (понад 400 днів).");
      else { out.from = p.from; out.to = p.to; }
    }
    return { params: out, errors: errors, selectedRules: model.rules.filter(function (r) { return !bots || bots.indexOf(r.id) >= 0; }), selectedCaps: wallet === "" ? caps.slice() : [wallet] };
  }
  function selectedLabel(model, params) { return params.bots === null || params.bots.length === model.rules.length ? "усі стратегії (" + model.rules.length + ")" : params.bots.length === 1 ? "стратегія «" + (model.rules.filter(function (r) { return r.id === params.bots[0]; })[0] || { title: params.bots[0] }).title + "»" : "вибрані стратегії (" + params.bots.length + " з " + model.rules.length + ")"; }

  // ---------- вікно періоду ----------
  function resolvePeriod(model, norm) {
    const prm = norm.params, notes = [];
    let asOf = null;
    norm.selectedCaps.forEach(function (cap) { const w = model.wallets[cap]; if (!w) return; norm.selectedRules.forEach(function (r) { const st = w.strategies[r.id]; if (st && st.curve.length) { const t = st.curve[st.curve.length - 1].t; if (asOf === null || t > asOf) asOf = t; } }); });
    let from = null, to = null;
    if (prm.period === "24h" || prm.period === "7d" || prm.period === "30d") { if (asOf !== null) { to = asOf; from = asOf - WINDOW[prm.period]; } }
    else if (prm.period === "custom" && prm.from !== null) {
      from = prm.from; to = prm.to;
      if (asOf !== null && to > asOf + TOL) { notes.push("Кінець діапазону пізніше за останні збережені дані (" + fmtDate(asOf) + "): період скорочено до останньої збереженої точки."); to = asOf; }
      if (to <= from) { notes.push("Власний діапазон лежить поза збереженими даними."); }
    }
    let roundStart = null; norm.selectedCaps.forEach(function (cap) { const w = model.wallets[cap]; if (w && w.roundStart !== null && (roundStart === null || w.roundStart < roundStart)) roundStart = w.roundStart; });
    return { key: prm.period, label: periodLabel(prm.period), from: from, to: to, asOf: asOf, roundStart: roundStart, notes: notes };
  }

  // ---------- вибір операцій ----------
  function inWindow(o, per) { return (per.from === null || o.t >= per.from) && (per.to === null || o.t <= per.to); }

  // ---------- рядки рахунків за вікном періоду (спільні для звіту, порівняння й динаміки) ----------
  // Мінімальна вибірка закритих угод для змістовного Win Rate; нижче — позначка «мала вибірка».
  const MIN_SAMPLE = 10, MIN_POINTS = 6;
  // Частка часу з відкритими позиціями: сума інтервалів «купівля → продаж» по монетах / (довжина вікна × кількість монет гаманця).
  // Рахується лише коли історія рахунку в раунді ПОВНА (є доказ повноти): інакше null.
  function timeInMarket(model, mineOps, cap, bot, from, to, asOf, roundStart, full) {
    const w = model.wallets[cap], coins = w && w.coins ? w.coins.length : 0; if (!full || !coins) return null;
    const t0 = from === null ? roundStart : Math.max(from, roundStart === null ? from : roundStart), t1 = to === null ? asOf : Math.min(to, asOf === null ? to : asOf); if (t0 === null || t1 === null || !(t1 > t0)) return null;
    const by = {}; mineOps.slice().sort(function (x, y) { return x.t - y.t; }).forEach(function (o) { (by[o.coin] = by[o.coin] || []).push(o); });
    let inPos = 0; Object.keys(by).forEach(function (c) { let st = null; by[c].forEach(function (o) { if (o.type === "open") { if (st === null) st = o.t; } else if (st !== null) { inPos += Math.max(0, Math.min(o.t, t1) - Math.max(st, t0)); st = null; } }); if (st !== null) inPos += Math.max(0, t1 - Math.max(st, t0)); });
    return Math.min(1, inPos / ((t1 - t0) * coins));
  }
  function makeRows(model, ops, comp0, norm, per) {
    const selSet = {}; norm.selectedRules.forEach(function (r) { selSet[r.id] = true; }); const capSet = {}; norm.selectedCaps.forEach(function (c) { capSet[c] = true; });
    const all = D.accountRows(model, ops, "round").filter(function (r) { return selSet[r.bot] && capSet[r.wallet]; });
    const tradesOps = ops.filter(function (o) { return selSet[o.bot] && capSet[o.wallet] && o.wallet !== "testnet"; }), periodOpsAll = tradesOps.filter(function (o) { return inWindow(o, per); });
    const cur = periodOpsAll.filter(function (o) { return o.roundCurrent; }), other = periodOpsAll.length - cur.length;
    const rows = all.map(function (r) {
      const pr = D.periodResult(model, r.wallet, r.bot, per.from, per.to, TOL), st = D.accountStats(model, cur, r.wallet, r.bot, "round", comp0), x = Object.assign({}, r);
      const roundFull = st.status === "full";
      x.pr = pr; x.coverage = pr.status === "ok" ? pr.coverage : "none"; x.reason = pr.status === "ok" ? "" : pr.reason;
      x.hasData = pr.status === "ok"; x.resultUsd = pr.status === "ok" ? pr.usd : null; x.resultPct = pr.status === "ok" ? pr.pct : null; x.value = pr.status === "ok" ? r.wallet * pr.eq1 : null; x.dd = pr.status === "ok" && pr.ddKnown ? pr.dd : null;
      x.start = pr.status === "ok" ? pr.startT : null; x.end = pr.status === "ok" ? pr.endT : null;
      const mine = cur.filter(function (o) { return o.wallet === r.wallet && o.bot === r.bot; });
      x.opsInPeriod = mine.length; x.trades = per.from === null ? r.trades : (roundFull ? mine.length : null);
      x.open = per.to === null || (per.asOf !== null && per.to >= per.asOf - TOL) ? r.open : null;
      x.openCoins = x.open === null ? null : (model.wallets[r.wallet].strategies[r.bot].openCoins || []);
      x.closed = st.closed; x.wins = st.wins; x.losses = st.losses; x.flat = st.flat; x.winRate = st.winRate; x.realized = st.realized; x.avgUsd = st.avgUsd; x.avgPct = st.avgPct; x.feeUsd = st.feeUsd; x.feeMissing = st.feeMissing; x.orphan = st.orphan; x.status = st.status; x.noClosed = st.noClosed; x.pctEst = st.pctEst;
      const ce = comp0.byKey[r.wallet + "|" + r.bot + "|" + (model.wallets[r.wallet].roundStart !== null ? model.wallets[r.wallet].roundStart : "none")]; x.roundExpected = ce ? ce.expected : null; x.roundConfirmed = ce ? ce.confirmed : null; x.roundMissing = ce ? ce.missing : null;
      const closes = mine.filter(function (o) { return o.type === "close" && o.pnlUsd !== null; }); x.worst = closes.length ? closes.slice().sort(function (a, b) { return a.pnlUsd - b.pnlUsd; })[0] : null; x.best = closes.length ? closes.slice().sort(function (a, b) { return b.pnlUsd - a.pnlUsd; })[0] : null;
      x.stops = mine.filter(function (o) { return o.type === "close" && o.exit === "stop"; }).length; x.takes = mine.filter(function (o) { return o.type === "close" && o.exit === "take"; }).length; x.trails = mine.filter(function (o) { return o.type === "close" && o.exit === "trail"; }).length;
      x.feePctDeposit = x.feeUsd === null ? null : x.feeUsd / r.wallet * 100;
      x.smallSample = x.closed < MIN_SAMPLE; x.timeInMarket = timeInMarket(model, ops.filter(function (o) { return o.wallet === r.wallet && o.bot === r.bot && o.roundCurrent; }), r.wallet, r.bot, per.from, per.to, per.asOf, model.wallets[r.wallet].roundStart, roundFull);
      return x;
    });
    return { rows: rows, cur: cur, other: other, periodOpsAll: periodOpsAll };
  }

  // ---------- побудова звіту ----------
  function build(model, ops, comp, rawParams, ctx) {
    ctx = ctx || {};
    const now = num(ctx.now) ? ctx.now : Date.now(), norm = normalize(model, rawParams), prm = norm.params, per = resolvePeriod(model, norm), comp0 = comp || { entries: [], byKey: {} };
    const rep = { v: 1, generatedAt: now, params: prm, errors: norm.errors.slice(), period: per, empty: false, tables: {}, notes: [], warnings: [] };
    if (norm.errors.length) { rep.empty = true; return rep; }
    const view = { caps: norm.selectedCaps, rules: norm.selectedRules };
    const mr = makeRows(model, ops, comp0, norm, per), rows = mr.rows, cur = mr.cur, other = mr.other, periodOpsAll = mr.periodOpsAll;
    const withData = rows.filter(function (r) { return r.hasData; });
    // доступність
    const cov = { full: 0, partial: 0, none: 0 }; rows.forEach(function (r) { cov[r.coverage === "full" ? "full" : r.coverage === "partial" ? "partial" : "none"]++; });
    const stat = { full: 0, partial: 0, insufficient: 0 }; rows.forEach(function (r) { stat[r.status]++; });
    rep.availability = { accounts: rows.length, withEquity: withData.length, coverage: cov, completeness: stat, opsInPeriod: cur.length, opsOtherRounds: other, opsTotalLoaded: ops.length, archive: ctx.archive || null };
    if (!withData.length) { rep.empty = true; rep.errors.push("Немає достовірних збережених значень equity для вибраного періоду та фільтрів: звіт не формується (дохідність не розраховується зі знімка)."); }
    if (cov.partial) rep.warnings.push("Період скорочено до поточного раунду для " + cov.partial + " рахунків: попередні раунди не змішуються.");
    if (cov.none) rep.warnings.push("Для " + cov.none + " рахунків немає збережених точок на межах періоду: вони не входять у результати й рейтинг.");
    if (stat.partial + stat.insufficient) rep.warnings.push("Історія операцій неповна для " + (stat.partial + stat.insufficient) + " рахунків: Win Rate і реалізований PnL там часткові або недоступні.");
    if (other) rep.warnings.push("У вибраному періоді є " + other + " операцій попередніх раундів: вони позначені окремо й не входять у підсумки.");
    if (ctx.archive && ctx.archive.status === "error") rep.warnings.push("Архів недоступний: операції лише з журналів paper_events і live_feed, історія неповна.");
    if (ctx.archive && (ctx.archive.bytes > LIMITS.bigArchiveBytes || ctx.archive.total > LIMITS.bigArchiveEvents)) rep.warnings.push("Великий архів: формування може тривати довше.");
    const noTim = withData.filter(function (r) { return r.timeInMarket === null; }).length, smallN = withData.filter(function (r) { return r.smallSample; }).length;
    if (noTim) rep.warnings.push("Частка часу з відкритими позиціями недоступна для " + noTim + " рахунків: історія операцій у раунді неповна (немає доказу повноти), тому час у позиціях не оцінюється.");
    if (smallN) rep.warnings.push("Мала вибірка (менше " + MIN_SAMPLE + " закритих угод) у " + smallN + " рахунків: Win Rate, середній результат і частка часу в позиціях ненадійні.");
    rep.rows = rows;
    // рейтинги (ті самі функції, що в Analytics Pro)
    const rk = {}; const ranked = withData;
    if (prm.wallet === "") { rk.overall = D.proRanking(view, ranked, "", "pct", false); rk.perWallet = {}; norm.selectedCaps.forEach(function (c) { rk.perWallet[c] = { usd: D.proRanking(view, ranked, String(c), "usd", false), pct: D.proRanking(view, ranked, String(c), "pct", false) }; }); }
    else { rk.overall = null; rk.perWallet = {}; rk.perWallet[prm.wallet] = { usd: D.proRanking(view, ranked, String(prm.wallet), "usd", false), pct: D.proRanking(view, ranked, String(prm.wallet), "pct", false) }; }
    rep.ranking = rk;
    rep.kpis = {}; norm.selectedCaps.forEach(function (c) { rep.kpis[c] = D.proKpis(view, ranked, String(c), "pct"); }); rep.kpisAll = prm.wallet === "" ? D.proKpis(view, ranked, "", "pct") : null;
    // операції
    const maxOps = ctx.maxOps || (prm.format === "pdf" ? LIMITS.pdfOps : prm.format === "xlsx" ? LIMITS.xlsxOps : LIMITS.csvOps);
    const sortedOps = D.proSortOps(periodOpsAll, "t", "desc"); rep.opsTotal = sortedOps.length; rep.ops = prm.kind === "detailed" ? sortedOps.slice(0, maxOps) : []; rep.opsTruncated = prm.kind === "detailed" && sortedOps.length > maxOps;
    if (rep.opsTruncated) rep.warnings.push("Перелік операцій обмежено " + maxOps + " записами для цього формату (всього " + sortedOps.length + "); повний перелік доступний у XLSX або CSV.");
    // графіки: ТОП-3 і АНТИТОП-3 кожного гаманця за відсотковою дохідністю, лише якщо достатньо точок
    rep.charts = norm.selectedCaps.map(function (c) {
      const r = rk.perWallet[c] ? rk.perWallet[c].pct : null, picks = r ? r.top.concat(r.anti.filter(function (e) { return r.top.indexOf(e) < 0; })) : [], series = [];
      picks.forEach(function (e, i) { const row = rows.filter(function (x) { return x.wallet === c && x.bot === e.bot; })[0]; if (row && row.pr && row.pr.status === "ok" && row.pr.series.length >= 20) series.push({ bot: e.bot, title: e.title, color: COLORS[i % COLORS.length], pts: row.pr.series.map(function (p) { return [p.t, (p.eq / row.pr.eq0 - 1) * 100]; }) }); });
      return { cap: c, series: series, ok: series.length > 0, reason: series.length ? "" : "недостатньо збережених точок (потрібно щонайменше 20)" };
    });
    rep.tables = tables(model, rep, norm);
    return rep;
  }

  // ---------- таблиці (спільні для PDF, XLSX, CSV) ----------
  function capTxt(c) { return c.toLocaleString("uk-UA").replace(/ | /g, " ") + " $"; }
  function tables(model, rep, norm) {
    const prm = rep.params, per = rep.period, T = {}, titles = {}; model.rules.forEach(function (r) { titles[r.id] = r.title; });
    const filters = "Гаманець: " + (prm.wallet === "" ? "усі (порівняння)" : capTxt(prm.wallet)) + "; " + selectedLabel(model, prm) + "; тип: " + (prm.kind === "detailed" ? "детальний" : "короткий");
    const periodTxt = per.key === "all" ? "Увесь доступний період (поточний раунд" + (per.roundStart !== null ? " із " + fmtDate(per.roundStart) : "") + ", до останньої збереженої точки)" : per.label + (per.from !== null ? ": " + fmtDate(per.from) + " — " + fmtDate(per.to) : "");
    rep.filtersText = filters; rep.periodText = periodTxt;
    T.meta = { id: "meta", title: "Параметри звіту", columns: [{ key: "k", title: "Параметр", type: "text" }, { key: "v", title: "Значення", type: "text" }], rows: [
      { k: "Звіт", v: "Аналітичний звіт Crypto Prosto · Analytics Pro" }, { k: "Сформовано", v: fmtDate(rep.generatedAt) }, { k: "Період", v: periodTxt }, { k: "Дані станом на", v: fmtDate(per.asOf) }, { k: "Фільтри", v: filters },
      { k: "Режим даних", v: "Paper Trading: віртуальні рахунки; Binance Testnet не включено" }, { k: "Рахунків у звіті", v: String(rep.availability.accounts) + " (з достовірним equity: " + rep.availability.withEquity + ")" } ] };
    if (per.notes.length) per.notes.forEach(function (n) { T.meta.rows.push({ k: "Примітка до періоду", v: n }); });
    // KPI по гаманцях
    const kcols = [{ key: "wallet", title: "Гаманець", type: "text" }, { key: "accounts", title: "Рахунків із даними", type: "int" }, { key: "mean", title: "Середня дохідність", type: "pct" }, { key: "plus", title: "У плюсі", type: "int" }, { key: "minus", title: "У мінусі", type: "int" }, { key: "zero", title: "Нульових", type: "int" },
      { key: "idle", title: "Без угод", type: "int" }, { key: "best", title: "Найкращий активний рахунок", type: "text" }, { key: "bestPct", title: "Найкращий, %", type: "pct" }, { key: "worst", title: "Найгірший активний рахунок", type: "text" }, { key: "worstPct", title: "Найгірший, %", type: "pct" }, { key: "sumUsd", title: "Сума P/L незалежних рахунків, $", type: "usd" }, { key: "maxDd", title: "Макс. просідання", type: "dd" }];
    T.wallets = { id: "wallets", title: "Результати за гаманцями", columns: kcols, rows: norm.selectedCaps.map(function (c) { const k = rep.kpis[c], act = rep.ranking.perWallet[c] ? rep.ranking.perWallet[c].pct.list : [], b = act.length ? act[0] : null, w = act.length > 1 ? act[act.length - 1] : null; return { wallet: capTxt(c), accounts: k.accounts, mean: k.meanPct, plus: k.positive, minus: k.negative, zero: k.zero, idle: k.idle, best: b ? b.title : null, bestPct: b ? b.pct : null, worst: w ? w.title : null, worstPct: w ? w.pct : null, sumUsd: k.sumUsd, maxDd: k.maxDd }; }),
      note: "«Найкращий/найгірший активний» — серед рахунків із угодами (боти без угод не враховуються). Рахунки незалежні: «Сума P/L» — арифметична сума результатів незалежних рахунків одного гаманця, а не результат спільного портфеля. Суми USD різних гаманців не додаються." };
    // рейтинг
    const rcols = [{ key: "list", title: "Список", type: "text" }, { key: "rank", title: "Місце", type: "text" }, { key: "title", title: "Стратегія", type: "text" }, { key: "wallet", title: "Гаманець", type: "text" }, { key: "pct", title: "Дохідність, %", type: "pct" }, { key: "usd", title: "Результат, $", type: "usd" }, { key: "trades", title: "Угоди", type: "int" }, { key: "sign", title: "Позначка", type: "text" }];
    const rrows = [], sgn = function (e) { return e.sign === "minus" ? "у мінусі" : e.sign === "zero" ? "нульовий результат" : "у плюсі"; };
    function addList(name, rk, wallet, useUsd) { [["ТОП-3", rk.top], ["АНТИТОП-3", rk.anti]].forEach(function (g) { g[1].forEach(function (e) { rrows.push({ list: name + " · " + g[0], rank: (e.tie ? "=" : "") + e.rank, title: e.title, wallet: wallet, pct: e.pct, usd: wallet === "Усі гаманці (середнє)" ? null : e.usd, trades: e.trades, sign: sgn(e) }); }); }); }
    if (rep.ranking.overall) addList("Усі гаманці, за середнім %", rep.ranking.overall, "Усі гаманці (середнє)", false);
    norm.selectedCaps.forEach(function (c) { const r = rep.ranking.perWallet[c]; if (!r) return; addList(capTxt(c) + ", за $", r.usd, capTxt(c), true); if (prm.wallet !== "") addList(capTxt(c) + ", за %", r.pct, capTxt(c), false); });
    T.ranking = { id: "ranking", title: "Рейтинг стратегій (ТОП-3 та АНТИТОП-3 активних)", columns: rcols, rows: rrows, note: "Боти без угод у рейтинг не входять. У режимі «усі гаманці» місце визначає лише просте середнє % трьох незалежних рахунків; суму $ для місця не використовуємо. У ТОП потрапляють найкращі з наявних активних, навіть якщо результат нульовий чи від'ємний (є позначка)." };
    // рахунки
    const acols = [{ key: "title", title: "Стратегія", type: "text" }, { key: "bot", title: "Ідентифікатор", type: "text" }, { key: "wallet", title: "Гаманець", type: "text" }, { key: "deposit", title: "Депозит, $", type: "usd0" }, { key: "value", title: "Вартість, $", type: "usd" }, { key: "usd", title: "Результат, $", type: "usd" }, { key: "pct", title: "Дохідність", type: "pct" },
      { key: "trades", title: "Угоди", type: "int" }, { key: "open", title: "Відкриті позиції", type: "int" }, { key: "dd", title: "Просідання", type: "dd" }, { key: "closed", title: "Закриті угоди", type: "int" }, { key: "wins", title: "Прибуткові", type: "int" }, { key: "losses", title: "Збиткові", type: "int" }, { key: "flat", title: "Нульові", type: "int" },
      { key: "winRate", title: "Win Rate, %", type: "pct0" }, { key: "realized", title: "Реалізований PnL, $", type: "usd" }, { key: "fee", title: "Комісії й проковзання, $", type: "usd" }, { key: "status", title: "Повнота історії", type: "text" }, { key: "coverage", title: "Покриття періоду", type: "text" }, { key: "from", title: "Початок (UTC)", type: "dt" }, { key: "to", title: "Кінець (UTC)", type: "dt" }, { key: "periodTxt", title: "Період звіту", type: "text" }, { key: "filtersTxt", title: "Фільтри звіту", type: "text" }];
    const covTxt = function (r) { return r.coverage === "full" ? "повне" : r.coverage === "partial" ? "скорочено до раунду" : "немає даних" + (r.reason ? ": " + r.reason : ""); };
    T.accounts = { id: "accounts", title: "Рахунки (незалежні віртуальні)", columns: acols, rows: rep.rows.map(function (r) { const stTxt = r.status === "insufficient" ? "Недостатньо даних" : (r.noClosed ? "Повні дані · закритих угод немає" : STATUS_TXT[r.status] + (r.status === "partial" && r.roundMissing ? " (бракує " + r.roundMissing + ")" : ""));
      return { title: r.title, bot: r.bot, wallet: capTxt(r.wallet), deposit: r.wallet, value: r.value, usd: r.resultUsd, pct: r.resultPct, trades: r.trades, open: r.open, dd: r.dd, closed: r.status === "insufficient" ? null : r.closed, wins: r.status === "insufficient" ? null : r.wins, losses: r.status === "insufficient" ? null : r.losses, flat: r.status === "insufficient" ? null : r.flat, winRate: r.winRate, realized: r.realized, fee: r.feeUsd, status: stTxt, coverage: covTxt(r), from: r.start, to: r.end, periodTxt: periodTxt, filtersTxt: filters }; }),
      note: "Win Rate і реалізований PnL — лише за підтвердженими закриттями поточного раунду; порожнє значення означає «немає даних», а не нуль. Результат і дохідність — за збереженими точками кривої; відсотки рахуються від " + (per.from === null ? "депозиту (початок раунду)" : "equity на початок періоду, а якщо період починається раніше за раунд — від депозиту") + "." };
    // ризики
    const ccols = [{ key: "title", title: "Стратегія", type: "text" }, { key: "wallet", title: "Гаманець", type: "text" }, { key: "dd", title: "Макс. просідання", type: "dd" }, { key: "worst", title: "Найгірша угода, $", type: "usd" }, { key: "worstPct", title: "Найгірша угода, %", type: "pct" }, { key: "best", title: "Найкраща угода, $", type: "usd" }, { key: "losses", title: "Збиткових закриттів", type: "int" }, { key: "closed", title: "Закриттів із результатом", type: "int" },
      { key: "stops", title: "Stop Loss", type: "int" }, { key: "takes", title: "Take Profit", type: "int" }, { key: "trails", title: "Trailing Stop", type: "int" }, { key: "fee", title: "Комісії, $", type: "usd" }, { key: "feePct", title: "Комісії, % депозиту", type: "pct" }, { key: "open", title: "Відкриті позиції", type: "int" }, { key: "openCoins", title: "Монети в позиції", type: "text" }, { key: "tim", title: "Частка часу з позиціями", type: "pct0" }, { key: "sample", title: "Вибірка", type: "text" }];
    T.risks = { id: "risks", title: "Прибутки, збитки, просідання, комісії", columns: ccols, rows: rep.rows.filter(function (r) { return r.hasData; }).map(function (r) { return { title: r.title, wallet: capTxt(r.wallet), dd: r.dd, worst: r.worst ? r.worst.pnlUsd : null, worstPct: r.worst ? r.worst.pnlPct : null, best: r.best ? r.best.pnlUsd : null, losses: r.status === "insufficient" ? null : r.losses, closed: r.status === "insufficient" ? null : r.closed, stops: r.stops, takes: r.takes, trails: r.trails, fee: r.feeUsd, feePct: r.feePctDeposit, open: r.open, openCoins: r.openCoins === null ? null : (r.openCoins.length ? r.openCoins.join(", ") : "—"), tim: r.timeInMarket === null ? null : r.timeInMarket * 100, sample: r.status === "insufficient" ? "немає закриттів" : (r.smallSample ? "мала вибірка (" + r.closed + " < " + MIN_SAMPLE + ")" : "достатня") }; }),
      note: "Критерій малої вибірки: менше " + MIN_SAMPLE + " закритих угод із відомим результатом (рахунки без закриттів — також мала вибірка). Частка часу з позиціями — лише коли історія рахунку в раунді повна (інакше порожньо). «Мала вибірка» — менше 10 закритих угод: Win Rate і середні значення ненадійні. Це не прогноз. Просідання — за збереженими точками кривої; найгірша й найкраща угоди — серед підтверджених закриттів із відомим результатом; комісії — лише за операціями з відомими витратами." };
    // комісії та торгові витрати за гаманцями (лише операції з відомими витратами; рахунки незалежні, суми різних гаманців між собою не додаються)
    T.fees = { id: "fees", title: "Комісії та торгові витрати", columns: [{ key: "wallet", title: "Гаманець", type: "text" }, { key: "fee", title: "Комісії й проковзання (відомі), $", type: "usd" }, { key: "accounts", title: "Рахунків із даними про витрати", type: "int" }, { key: "missing", title: "Операцій без даних про витрати", type: "int" }],
      rows: norm.selectedCaps.map(function (c) { const rs = rep.rows.filter(function (r) { return r.wallet === c && r.hasData; }), known = rs.filter(function (r) { return r.feeUsd !== null; }); return { wallet: capTxt(c), fee: known.length ? known.reduce(function (a, r) { return a + r.feeUsd; }, 0) : null, accounts: known.length, missing: rs.reduce(function (a, r) { return a + (r.feeMissing || 0); }, 0) }; }),
      note: "Комісія біржі й проковзання моделі за підтвердженими операціями поточного раунду в періоді; якщо для події немає даних про витрати, вона не входить у суму (лічильник «без даних»). Сума — по незалежних рахунках одного гаманця, не результат спільного портфеля." };
    // операції
    const ocols = [{ key: "t", title: "Час (UTC)", type: "dt" }, { key: "title", title: "Стратегія", type: "text" }, { key: "wallet", title: "Гаманець", type: "text" }, { key: "coin", title: "Монета", type: "text" }, { key: "side", title: "Операція", type: "text" }, { key: "price", title: "Ціна, USDT", type: "price" }, { key: "vol", title: "Обсяг, $", type: "usd" }, { key: "qty", title: "Кількість", type: "num6" },
      { key: "fee", title: "Комісія й проковзання, $", type: "usd" }, { key: "pnl", title: "Результат, $", type: "usd" }, { key: "pnlPct", title: "Результат, %", type: "pct" }, { key: "exit", title: "Причина виходу", type: "text" }, { key: "round", title: "Раунд", type: "text" }, { key: "compl", title: "Повнота рахунку в раунді", type: "text" }, { key: "src", title: "Джерело", type: "text" }];
    const EXITS = D.EXIT_KIND, ETXT = { stop: "Stop Loss", take: "Take Profit", trail: "Trailing Stop", trend: "Злам тренду", signal: "Сигнал правила", unknown: "Причина не вказана" };
    T.ops = { id: "ops", title: "Торгові операції (Paper Trading)", columns: ocols, rows: rep.ops.map(function (o) { return { t: o.t, title: titles[o.bot] || o.bot, wallet: capTxt(o.wallet), coin: o.coin, side: o.type === "open" ? (o.initial ? "BUY · старт раунду" : "BUY") : "SELL", price: o.price, vol: o.volUsd, qty: o.volQty, fee: o.feeUsd, pnl: o.type === "close" ? o.pnlUsd : null, pnlPct: o.type === "close" ? o.pnlPct : null, exit: o.type === "close" ? (ETXT[o.exit] || o.exit || ETXT.unknown) : null, round: o.roundCurrent ? "поточний" : (typeof o.roundKey === "number" ? "попередній " + fmtDate(o.roundKey) : "невідомий"), compl: STATUS_TXT[o.compl] || "", src: o.src.map(function (x) { return x === "paper_archive" ? "архів" : x === "paper_events" ? "журнал" : "стрічка"; }).join(" + ") }; }),
      note: prm.kind === "detailed" ? ("Операцій у періоді: " + rep.opsTotal + (rep.opsTruncated ? "; показано " + rep.ops.length : "") + ". Операції попередніх раундів позначені в колонці «Раунд» і не входять у підсумки. Порожні клітинки — немає даних.") : "У короткому звіті перелік операцій не включено." };
    // джерела й обмеження
    const lim = [];
    lim.push("Це симуляція на віртуальних грошах (Paper Trading): інформація, а не фінансова порада й не прогноз. Binance Testnet у звіт не входить.");
    lim.push("48 рахунків (16 стратегій × 3 гаманці) — незалежні віртуальні рахунки зі своїми стартами й наборами монет; вони не складаються в реальний портфель, суми USD різних гаманців не додаються.");
    lim.push("Загальний рейтинг стратегій визначається простим середнім відсоткової дохідності трьох рахунків; боти без угод у ТОП-3 та АНТИТОП-3 не входять.");
    lim.push("Дохідність за період рахується лише за збереженими точками кривої; якщо точок для періоду немає, значення не розраховується (порожньо). Дані охоплюють поточний раунд; попередні раунди не змішуються.");
    lim.push("Win Rate та реалізований PnL — за підтвердженими закриттями; «Повні дані» означає, що кількість підтверджених подій раунду дорівнює лічильнику угод рушія. Часткова історія позначена, відсутні дані не замінюються нулями.");
    lim.push("Комісії й проковзання враховано за подіями з відомими витратами; якщо витрат немає, відповідні суми порожні або позначені як неповні.");
    rep.warnings.forEach(function (w) { lim.push("Увага: " + w); });
    T.limits = { id: "limits", title: "Джерела та обмеження", columns: [{ key: "k", title: "Тип", type: "text" }, { key: "v", title: "Опис", type: "text" }], rows: lim.map(function (x) { return { k: /^Увага/.test(x) ? "Попередження" : "Обмеження", v: x }; }) };
    const a = rep.availability, ar = a.archive;
    T.sources = { id: "sources", title: "Джерела даних", columns: [{ key: "k", title: "Джерело", type: "text" }, { key: "v", title: "Стан", type: "text" }], rows: [
      { k: "data/simulation.json: криві equity (curve), стан рахунків", v: "використано; станом на " + fmtDate(per.asOf) }, { k: "Архів Paper Trading (data/paper_archive/)", v: ar ? (ar.status === "ok" ? "завантажено сегментів: " + ar.loaded + " із " + ar.total + " (подій у завантажених: " + (ar.events === undefined ? "—" : ar.events) + ")" : ar.status === "error" ? "недоступний: " + (ar.reason || "помилка") : "не завантажено") : "не використано" },
      { k: "Журнал paper_events і стрічка live_feed", v: "використано як доповнення (дублікати за ключем події не враховуються)" }, { k: "Шрифт PDF", v: "Noto Sans (SIL Open Font License 1.1), вбудовується підмножина гліфів" }, { k: "Підтверджених операцій у періоді (поточний раунд)", v: String(a.opsInPeriod) }, { k: "Операцій попередніх раундів у періоді", v: String(a.opsOtherRounds) },
      { k: "Рахунків: повні / часткові / недостатньо даних", v: a.completeness.full + " / " + a.completeness.partial + " / " + a.completeness.insufficient } ] };
    return T;
  }


  // =====================================================================
  // Analytics Pro 4: порівняння періодів, динаміка стратегій
  // Усі розрахунки — через ті самі функції, що й решта звіту (makeRows → accountRows/accountStats/periodResult, proRanking). Порівняння дозволяється лише
  // за достатніх історичних даних обох періодів; якщо даних бракує, повертається причина (reason), а не нульовий результат.
  // =====================================================================
  const CMP_WINDOW = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  function fmtD(t) { return fmtDate(t); }
  function dataStart(model, norm) {
    let m = null; norm.selectedCaps.forEach(function (c) { const w = model.wallets[c]; if (!w) return; norm.selectedRules.forEach(function (r) { const st = w.strategies[r.id]; if (st && st.curve.length && (m === null || st.curve[0].t < m)) m = st.curve[0].t; }); }); return m;
  }
  // Чи придатний рахунок для порівняння у вікні: є точки на обох межах, період не скорочено, достатньо точок усередині
  function accountOk(r) {
    if (!r.hasData) return { ok: false, reason: r.reason || "немає точок equity" };
    if (r.coverage !== "full") return { ok: false, reason: "період починається раніше за наявні дані (скорочується до початку раунду)" };
    if (!(r.pr.points >= MIN_POINTS)) return { ok: false, reason: "замало збережених точок у вікні (" + r.pr.points + ", потрібно щонайменше " + MIN_POINTS + ")" };
    return { ok: true, reason: "" };
  }
  function mkPer(asOf, roundStart, from, to) { return { key: "custom", label: "Власний діапазон", from: from, to: to, asOf: asOf, roundStart: roundStart, notes: [] }; }
  function compare(model, ops, comp, opts) {
    opts = opts || {}; const norm = normalize(model, { period: "all", wallet: opts.wallet, bots: opts.bots, kind: "short" }), comp0 = comp || { entries: [], byKey: {} };
    const out = { v: 1, mode: CMP_WINDOW[opts.mode] ? opts.mode : (opts.mode === "custom" ? "custom" : "24h"), errors: norm.errors.slice(), allowed: false, reasons: [], windows: null, accounts: [], strategies: [], rankComparable: false, rankReason: "", metric: "pct", idle: !!opts.idle, wallet: norm.params.wallet, notes: [] };
    if (out.errors.length) return out;
    const per0 = resolvePeriod(model, norm), asOf = per0.asOf, rs = per0.roundStart, ds = dataStart(model, norm);
    if (asOf === null) { out.errors.push("Немає збережених даних для вибраних рахунків."); return out; }
    let A, B;
    if (CMP_WINDOW[out.mode]) { const W = CMP_WINDOW[out.mode]; A = [asOf - W, asOf]; B = [asOf - 2 * W, asOf - W]; }
    else {
      const a = opts.a || {}, b = opts.b || {};
      if (![a.from, a.to, b.from, b.to].every(num)) out.errors.push("Власні періоди: вкажіть початок і кінець обох періодів.");
      else if (!(a.from < a.to) || !(b.from < b.to)) out.errors.push("Власні періоди: початок кожного має бути раніше за кінець.");
      else if (a.from === b.from && a.to === b.to) out.errors.push("Власні періоди збігаються: порівнювати нічого.");
      else if (Math.max(a.to - a.from, b.to - b.from) > 400 * 86400000) out.errors.push("Власний період завеликий (понад 400 днів).");
      if (out.errors.length) return out;
      A = [a.from, Math.min(a.to, asOf)]; B = [b.from, Math.min(b.to, asOf)];
      const la = A[1] - A[0], lb = B[1] - B[0]; if (la > 0 && lb > 0 && Math.abs(la - lb) / Math.max(la, lb) > 0.1) out.notes.push("Періоди різної тривалості (" + Math.round(la / 36e5) + " год і " + Math.round(lb / 36e5) + " год): порівнюйте з обережністю.");
    }
    out.windows = { a: { from: A[0], to: A[1], text: fmtD(A[0]) + " — " + fmtD(A[1]) }, b: { from: B[0], to: B[1], text: fmtD(B[0]) + " — " + fmtD(B[1]) }, asOf: asOf, dataStart: ds, roundStart: rs };
    const mA = makeRows(model, ops, comp0, norm, mkPer(asOf, rs, A[0], A[1])), mB = makeRows(model, ops, comp0, norm, mkPer(asOf, rs, B[0], B[1]));
    const rowOf = function (rows, c, b) { return rows.filter(function (r) { return r.wallet === c && r.bot === b; })[0]; };
    const view = { caps: norm.selectedCaps, rules: norm.selectedRules }, good = { a: [], b: [] };
    mA.rows.forEach(function (ra) {
      const rb = rowOf(mB.rows, ra.wallet, ra.bot), oa = accountOk(ra), ob = accountOk(rb), ok = oa.ok && ob.ok;
      const m = function (r) { return { pct: r.resultPct, usd: r.resultUsd, dd: r.dd, trades: r.trades, ops: r.opsInPeriod, closed: r.status === "insufficient" ? null : r.closed, wins: r.status === "insufficient" ? null : r.wins, losses: r.status === "insufficient" ? null : r.losses, realized: r.realized, fee: r.feeUsd, status: r.status, timeInMarket: r.timeInMarket, smallSample: r.smallSample }; };
      const d = function (x, y) { return num(x) && num(y) ? x - y : null; };
      const acc = { wallet: ra.wallet, bot: ra.bot, title: ra.title, comparable: ok, reason: ok ? "" : (!oa.ok ? "Поточний період: " + oa.reason : "Попередній період: " + ob.reason), a: m(ra), b: m(rb), delta: ok ? { pct: d(ra.resultPct, rb.resultPct), usd: d(ra.resultUsd, rb.resultUsd), dd: d(ra.dd, rb.dd), trades: d(ra.trades, rb.trades), ops: ra.opsInPeriod - rb.opsInPeriod } : null };
      out.accounts.push(acc); if (ok) { good.a.push(ra); good.b.push(rowOf(mB.rows, ra.wallet, ra.bot)); }
    });
    const nOk = out.accounts.filter(function (x) { return x.comparable; }).length;
    out.allowed = nOk > 0; out.comparableAccounts = nOk;
    const why = function (label, key) { const bad = out.accounts.filter(function (x) { return !x.comparable && (key === "a" ? /^Поточний/.test(x.reason) : /^Попередній/.test(x.reason)); }); if (!bad.length) return; const reasons = {}; bad.forEach(function (x) { const t = x.reason.replace(/^[^:]+: /, ""); reasons[t] = (reasons[t] || 0) + 1; }); out.reasons.push(label + " (" + (key === "a" ? out.windows.a.text : out.windows.b.text) + "): недостатньо даних у " + bad.length + " із " + out.accounts.length + " рахунків — " + Object.keys(reasons).map(function (t) { return t + " (" + reasons[t] + ")"; }).join("; ") + "."); };
    why("Поточний період", "a"); why("Попередній період", "b");
    if (ds !== null && B[0] < ds - TOL) out.reasons.push("Історія equity починається з " + fmtD(ds) + ", а попередній період починається з " + fmtD(B[0]) + ": бракує " + Math.round((ds - B[0]) / 36e5) + " год даних.");
    if (!out.allowed) { out.reasons.unshift("Порівняння недоступне: немає жодного рахунку з достатніми даними в обох періодах."); return out; }
    // рейтинг за однаковими правилами в обох періодах (метрика: у режимі «усі гаманці» — середній %, для одного гаманця — % або $)
    const wStr = norm.params.wallet === "" ? "" : String(norm.params.wallet), metric = opts.metric === "usd" && wStr !== "" ? "usd" : "pct"; out.metric = metric;
    const rkA = D.proRanking(view, good.a, wStr, metric, !!opts.idle), rkB = D.proRanking(view, good.b, wStr, metric, !!opts.idle);
    const idsA = rkA.list.map(function (e) { return e.bot; }).sort().join("|"), idsB = rkB.list.map(function (e) { return e.bot; }).sort().join("|");
    const selected = norm.selectedRules.length, covered = new Set(rkA.list.map(function (e) { return e.bot; })), missingData = norm.selectedRules.filter(function (r) { return !out.accounts.some(function (x) { return x.bot === r.id && x.comparable; }) || (norm.selectedCaps.length > 1 && out.accounts.some(function (x) { return x.bot === r.id && !x.comparable; })); }).length;
    if (missingData) out.rankReason = missingData + " із " + selected + " стратегій мають неповні дані в одному з періодів: склад порівняння некоректний, місця не порівнюються.";
    else if (idsA !== idsB) out.rankReason = "Склад активних стратегій відрізняється (поточний період: " + rkA.list.length + ", попередній: " + rkB.list.length + "; боти без угод у рейтинг не входять): місця не порівнюються.";
    else if (rkA.list.length < 2) out.rankReason = "Замало активних стратегій для порівняння місць (" + rkA.list.length + ").";
    else out.rankComparable = true;
    void covered;
    const byBot = function (rk) { const m = {}; rk.list.forEach(function (e) { m[e.bot] = e; }); return m; }, ma = byBot(rkA), mb = byBot(rkB);
    norm.selectedRules.forEach(function (r) {
      const ea = ma[r.id] || null, eb = mb[r.id] || null; let change = "insufficient", reason = out.rankReason;
      if (out.rankComparable && ea && eb) { change = ea.rank < eb.rank ? "up" : ea.rank > eb.rank ? "down" : "same"; reason = ""; }
      else if (!reason) reason = !ea || !eb ? "стратегія не входить до рейтингу в одному з періодів (немає угод або даних)" : "";
      out.strategies.push({ bot: r.id, title: r.title, rankA: ea ? ea.rank : null, rankB: eb ? eb.rank : null, tieA: ea ? ea.tie : false, tieB: eb ? eb.tie : false, pctA: ea ? ea.pct : null, pctB: eb ? eb.pct : null, usdA: ea ? ea.usd : null, usdB: eb ? eb.usd : null, change: change, reason: reason, noTrades: !!(ea && ea.noTrades) });
    });
    out.strategies.sort(function (x, y) { return (x.rankA === null) - (y.rankA === null) || (x.rankA - y.rankA) || x.title.localeCompare(y.title, "uk"); });
    // підсумок по гаманцях (лише порівнянні рахунки)
    out.summary = norm.selectedCaps.map(function (c) { const xs = out.accounts.filter(function (x) { return x.wallet === c && x.comparable; }); const mean = function (k, s) { const v = xs.map(function (x) { return x[s][k]; }).filter(num); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }; return { wallet: c, accounts: xs.length, pctA: mean("pct", "a"), pctB: mean("pct", "b"), ddA: mean("dd", "a"), ddB: mean("dd", "b"), opsA: xs.reduce(function (a, x) { return a + x.a.ops; }, 0), opsB: xs.reduce(function (a, x) { return a + x.b.ops; }, 0) }; });
    return out;
  }

  // ---------- Динаміка однієї стратегії (кожен гаманець — окремий графік; спільної кривої капіталу немає) ----------
  function dynamics(model, ops, comp, opts) {
    opts = opts || {}; const norm = normalize(model, { period: opts.period || "all", from: opts.from, to: opts.to, wallet: opts.wallet, bots: opts.bot ? [opts.bot] : null, kind: "short" }), comp0 = comp || { entries: [], byKey: {} };
    const out = { v: 1, errors: norm.errors.slice(), panels: [], period: null, bot: opts.bot || null };
    if (out.errors.length) return out;
    const per = resolvePeriod(model, norm); out.period = per; const mr = makeRows(model, ops, comp0, norm, per), rule = norm.selectedRules[0];
    // попередній період такої самої тривалості для порівняння просідання
    let prevPer = null; if (per.from !== null && per.to !== null && per.to > per.from) prevPer = mkPer(per.asOf, per.roundStart, per.from - (per.to - per.from), per.from);
    const mp = prevPer ? makeRows(model, ops, comp0, norm, prevPer) : null;
    norm.selectedCaps.forEach(function (cap) {
      const row = mr.rows.filter(function (r) { return r.wallet === cap && r.bot === rule.id; })[0]; if (!row) return;
      const panel = { tim: row.timeInMarket, timReason: row.timeInMarket === null ? "історія операцій рахунку в раунді неповна (немає доказу повноти) або період поза раундом" : "", cap: cap, bot: rule.id, title: rule.title, status: row.hasData ? "ok" : "nodata", reason: row.reason, coverage: row.coverage, pct: row.resultPct, usd: row.resultUsd, dd: row.dd, opsCount: row.opsInPeriod, closed: row.status === "insufficient" ? null : row.closed, wins: row.wins, losses: row.losses, realized: row.realized, feeUsd: row.feeUsd, smallSample: row.smallSample, complStatus: row.status, series: null, hold: null, holdReason: "", holdPct: null, vsHold: null, recent: [], ddPrev: null, ddChange: null, ddReason: "" };
      if (row.hasData) {
        const pr = row.pr, pts = pr.series, hold0 = pr.basis === "deposit" ? 1 : (pts[0] ? pts[0].hold : null);
        panel.series = { pct: pts.map(function (p) { return [p.t, (p.eq / pr.eq0 - 1) * 100]; }), usd: pts.map(function (p) { return [p.t, cap * (p.eq - pr.eq0)]; }) };
        if (pts.length && num(hold0) && pts.every(function (p) { return num(p.hold); })) { panel.hold = pts.map(function (p) { return [p.t, (p.hold / hold0 - 1) * 100]; }); panel.holdPct = panel.hold[panel.hold.length - 1][1]; panel.vsHold = panel.pct - panel.holdPct; }
        else panel.holdReason = "немає базових даних Buy & Hold для всіх точок періоду";
        const last = pts[pts.length - 1], st = model.wallets[cap].strategies[rule.id].curve;
        [["1 год", 36e5], ["6 год", 6 * 36e5], ["24 год", 24 * 36e5]].forEach(function (x) { const p0 = D.nearestPoint(st, last.t - x[1], TOL); panel.recent.push({ label: x[0], pct: p0 && p0.t < last.t ? (last.eq / p0.eq - 1) * 100 : null, reason: p0 && p0.t < last.t ? "" : "немає точки на початок інтервалу" }); });
        if (mp) { const rp = mp.rows.filter(function (r) { return r.wallet === cap && r.bot === rule.id; })[0], ok = rp && accountOk(rp); if (rp && ok.ok && row.coverage === "full") { panel.ddPrev = rp.dd; if (num(row.dd) && num(rp.dd)) panel.ddChange = row.dd - rp.dd; else panel.ddReason = "просідання невідоме"; } else panel.ddReason = rp ? "попередній період: " + ok.reason : "немає даних"; }
        else panel.ddReason = "для періоду «увесь доступний» попереднього періоду немає";
      }
      out.panels.push(panel);
    });
    return out;
  }

  // ---------- доступність до експорту (дешева перевірка без побудови таблиць) ----------
  function availability(model, ops, comp, params, ctx) {
    const norm = normalize(model, params), out = { errors: norm.errors.slice(), accounts: 0, withEquity: 0, coverage: { full: 0, partial: 0, none: 0 }, completeness: { full: 0, partial: 0, insufficient: 0 }, opsInPeriod: 0, opsOtherRounds: 0, period: null, warnings: [], ready: false };
    if (norm.errors.length) return out;
    const per = resolvePeriod(model, norm), capSet = {}, selSet = {}; norm.selectedCaps.forEach(function (c) { capSet[c] = true; }); norm.selectedRules.forEach(function (r) { selSet[r.id] = true; }); out.period = per;
    const c0 = comp || { entries: [], byKey: {} };
    norm.selectedCaps.forEach(function (cap) { norm.selectedRules.forEach(function (r) {
      out.accounts++; const pr = D.periodResult(model, cap, r.id, per.from, per.to, TOL); if (pr.status === "ok") { out.withEquity++; out.coverage[pr.coverage === "partial" ? "partial" : "full"]++; } else out.coverage.none++;
      const w = model.wallets[cap], e = c0.byKey[cap + "|" + r.id + "|" + (w && w.roundStart !== null ? w.roundStart : "none")]; const st = e ? (e.status === "full" ? "full" : (e.confirmed > 0 ? "partial" : "insufficient")) : "insufficient"; out.completeness[st]++;
    }); });
    ops.forEach(function (o) { if (!capSet[o.wallet] || !selSet[o.bot] || !inWindow(o, per)) return; if (o.roundCurrent) out.opsInPeriod++; else out.opsOtherRounds++; });
    if (out.coverage.partial) out.warnings.push("Період скорочено до поточного раунду для " + out.coverage.partial + " рахунків.");
    if (out.coverage.none) out.warnings.push("Для " + out.coverage.none + " рахунків немає точок equity на межах періоду.");
    if (out.completeness.partial + out.completeness.insufficient) out.warnings.push("Історія операцій неповна для " + (out.completeness.partial + out.completeness.insufficient) + " рахунків.");
    if (out.opsOtherRounds) out.warnings.push("Операцій попередніх раундів: " + out.opsOtherRounds + " (не входять у підсумки).");
    const ar = ctx && ctx.archive; if (ar && (ar.bytes > LIMITS.bigArchiveBytes || ar.total > LIMITS.bigArchiveEvents)) out.warnings.push("Великий архів: формування може тривати довше.");
    out.ready = out.withEquity > 0; if (!out.ready) out.errors.push("Немає достовірних збережених значень equity для вибраного періоду та фільтрів.");
    return out;
  }

  root.ReportCore = { compare: compare, dynamics: dynamics, makeRows: makeRows, timeInMarket: timeInMarket, MIN_SAMPLE: MIN_SAMPLE, MIN_POINTS: MIN_POINTS, CMP_WINDOW: CMP_WINDOW, PERIODS: PERIODS, TOL: TOL, LIMITS: LIMITS, COLORS: COLORS, normalize: normalize, resolvePeriod: resolvePeriod, build: build, availability: availability, periodLabel: periodLabel, fmtDate: fmtDate, capTxt: capTxt };
})(typeof window !== "undefined" ? window : this);
