// «Аналітика гаманців»: читання й вибірка даних симуляції для графіка (без DOM і без мережі; тестується в tools/test-wallets.html).
// ЖОДНИХ нових розрахунків торгівлі: береться лише те, що записав рушій (data/simulation.json → paper): криві curve, денні значення daily, раунд round.
//   • Кожен гаманець (100, 1 000, 10 000 $) окремо торгує кожним із 16 ботів: це 48 НЕЗАЛЕЖНИХ віртуальних рахунків, кожен стартує з повної суми свого гаманця.
//   • «Вибраний бот»: один бот на трьох рахунках. «Середнє по ботах»: середня дохідність усіх ботів окремо для кожного розміру гаманця (статистика, не баланс).
//   • Крива: [час, eq, hold], eq — частка від стартового депозиту (1,0 = старт). % = (eq − 1)·100, USD = депозит · eq.
// Точки не вигадуються й не інтерполюються: розрив між сусідніми точками понад поріг — прогалина, лінія там не з'єднується.

(function (root) {
  "use strict";
  const COLORS = { 100: "#F0B90B", 1000: "#0ECB81", 10000: "#2EBDFF" };
  const PERIODS = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000, all: null };
  const MIN_GAP = 40 * 60000;

  function num(v) { return typeof v === "number" && isFinite(v); }

  function cleanCurve(arr) {
    const by = {};
    (Array.isArray(arr) ? arr : []).forEach(function (r) {
      if (!Array.isArray(r) || r.length < 2) return;
      const t = Date.parse(r[0]);
      if (!isFinite(t) || !num(r[1]) || r[1] < 0) return;
      by[t] = { t: t, eq: r[1], hold: num(r[2]) ? r[2] : null };
    });
    return Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return by[t]; });
  }

  // Модель з data/simulation.json. Точки до початку поточного раунду відкидаються (це інший раунд; лінія не з'єднується через раунди).
  function parseModel(sim) {
    if (!sim || typeof sim !== "object" || !sim.paper || !Array.isArray(sim.strategies)) throw new Error("файл симуляції має невідомий формат");
    const paper = sim.paper;
    const rules = sim.strategies.filter(function (s) { return s && typeof s.id === "string"; }).map(function (s) { return { id: s.id, title: typeof s.title === "string" ? s.title : s.id }; });
    const caps = (Array.isArray(paper.accounts) ? paper.accounts : []).filter(function (c) { return Number.isInteger(c) && c > 0; });
    if (!rules.length || !caps.length) throw new Error("у файлі симуляції немає ботів або гаманців");
    const wallets = {};
    caps.forEach(function (cap) {
      const P = (cap === paper.cap || !paper.wallets || !paper.wallets[cap]) ? paper : paper.wallets[cap];
      const rs = P.round && Date.parse(P.round.start) ? Date.parse(P.round.start) : null, re = P.round && Date.parse(P.round.end) ? Date.parse(P.round.end) : null;
      const w = { cap: cap, coins: (paper.wallet_coins && paper.wallet_coins[cap]) || P.coins || [], roundStart: rs, roundEnd: re, strategies: {}, daily: P.daily && typeof P.daily === "object" ? P.daily : {}, history: Array.isArray(P.history) ? P.history : [] };
      rules.forEach(function (r) {
        const st = P.strategies && P.strategies[r.id];
        if (!st || !Array.isArray(st.curve)) return;
        let cv = cleanCurve(st.curve);
        if (rs !== null) cv = cv.filter(function (p) { return p.t >= rs - 60000; });
        if (cv.length) w.strategies[r.id] = { curve: cv, trades: num(st.trades) ? st.trades : null, open: Array.isArray(st.open) ? st.open.length : null, openCoins: Array.isArray(st.open) ? st.open.filter(function (x) { return typeof x === "string"; }) : null, state: st.state && typeof st.state === "object" ? st.state : {} };
      });
      wallets[cap] = w;
    });
    return { rules: rules, caps: caps, wallets: wallets, fee: num(paper.fee) ? paper.fee : null, updated: typeof sim.updated === "string" ? sim.updated : (typeof sim.generated_at === "string" ? sim.generated_at : null) };
  }

  // Ряд eq гаманця: один бот або середнє по ботах.
  // Середнє рахується лише в часових мітках, де є ВСІ боти гаманця (мітки не округлюються й не створюються); решта лічиться як відкинуті.
  function series(model, query, cap) {
    const w = model.wallets[cap];
    if (!w) return { points: [], meta: { rules: 0, used: 0, dropped: 0 } };
    if (query.mode === "avg") {
      const ids = Object.keys(w.strategies), n = ids.length, acc = {};
      ids.forEach(function (id) { w.strategies[id].curve.forEach(function (p) { const a = acc[p.t] || (acc[p.t] = { n: 0, s: 0 }); a.n++; a.s += p.eq; }); });
      const ts = Object.keys(acc).map(Number).sort(function (a, b) { return a - b; });
      const pts = [];
      let dropped = 0;
      ts.forEach(function (t) { if (n && acc[t].n === n) pts.push({ t: t, eq: acc[t].s / n }); else dropped++; });
      return { points: pts, meta: { rules: n, used: pts.length, dropped: dropped } };
    }
    const st = w.strategies[query.bot];
    return { points: st ? st.curve.map(function (p) { return { t: p.t, eq: p.eq }; }) : [], meta: { rules: st ? 1 : 0, used: st ? st.curve.length : 0, dropped: 0 } };
  }

  // Денні значення: daily[дата][бот] = [eq, hold, угоди] — значення останнього запуску за добу (частота: день)
  function dailySeries(model, query, cap) {
    const w = model.wallets[cap];
    if (!w) return { points: [], meta: { rules: 0, used: 0, dropped: 0 } };
    const dates = Object.keys(w.daily).sort(), ids = Object.keys(w.strategies), pts = [];
    let dropped = 0;
    dates.forEach(function (d) {
      const row = w.daily[d], t = Date.parse(d + "T00:00:00Z");
      if (!row || !isFinite(t)) return;
      if (query.mode === "avg") {
        const vals = ids.map(function (id) { return row[id] && num(row[id][0]) ? row[id][0] : null; });
        if (ids.length && vals.every(function (v) { return v !== null; })) pts.push({ t: t, eq: vals.reduce(function (a, b) { return a + b; }, 0) / vals.length });
        else dropped++;
      } else if (row[query.bot] && num(row[query.bot][0])) pts.push({ t: t, eq: row[query.bot][0] });
    });
    return { points: pts, meta: { rules: ids.length, used: pts.length, dropped: dropped } };
  }

  function value(eq, cap, unit) { return unit === "pct" ? (eq - 1) * 100 : cap * eq; }

  function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; }
  // Поріг прогалини: понад 3 типові кроки (не менше 40 хв); для денних точок — понад 1,5 доби
  function gapThreshold(points, daily) {
    if (daily) return 36 * 3600000;
    const d = []; for (let i = 1; i < points.length; i++) d.push(points[i].t - points[i - 1].t);
    return Math.max(MIN_GAP, 3 * median(d));
  }
  // Сегменти без розривів і прогалини між ними (прогалини рахуються по ВСІЙ серії, до обрізання періодом)
  function split(points, thr) {
    const segs = [], gaps = [];
    let cur = [];
    points.forEach(function (p, i) {
      if (i && p.t - points[i - 1].t > thr) { segs.push(cur); gaps.push({ a: points[i - 1].t, b: p.t }); cur = []; }
      cur.push(p);
    });
    if (cur.length) segs.push(cur);
    return { segments: segs, gaps: gaps };
  }
  function clip(points, t0, t1) { return points.filter(function (p) { return p.t >= t0 && p.t <= t1; }); }
  function periodWindow(period, now) { const w = PERIODS[period]; return w === undefined || w === null ? null : [now - w, now]; }
  function logAllowed(vals) { return vals.length > 0 && vals.every(function (v) { return v > 0; }); }

  // ---------- Показники карток і KPI (лише з наявних збережених точок) ----------
  // Просідання: найбільше падіння від піку до дна за збереженими точками (між запусками агента рухи невідомі, тому це оцінка за дискретними точками)
  function maxDrawdown(vals) {
    if (!Array.isArray(vals) || vals.length < 2) return null;
    let peak = -Infinity, mdd = 0;
    vals.forEach(function (v) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak * 100); });
    return mdd;
  }
  function sumNums(arr) { return arr.every(function (x) { return x !== null && x !== undefined; }) ? arr.reduce(function (a, b) { return a + b; }, 0) : null; }

  // Показники одного гаманця: «Вибраний бот» — один рахунок; «Середнє по ботах» — середня крива 16 ботів, а угоди й позиції — СУМА по ботах (не показники одного рахунку)
  function walletStats(model, query, cap) {
    const w = model.wallets[cap], src = series(model, query, cap), pts = src.points, last = pts.length ? pts[pts.length - 1] : null;
    const ids = w ? Object.keys(w.strategies) : [];
    let trades = null, open = null, openCoins = [];
    if (w) {
      if (query.mode === "avg") { trades = ids.length ? sumNums(ids.map(function (id) { return w.strategies[id].trades; })) : null; open = ids.length ? sumNums(ids.map(function (id) { return w.strategies[id].open; })) : null; }
      else { const st = w.strategies[query.bot]; trades = st ? st.trades : null; open = st ? st.open : null; openCoins = st && st.openCoins ? st.openCoins.slice() : []; }
    }
    return { cap: cap, deposit: cap, coins: w ? w.coins : [], last: last, first: pts.length ? pts[0] : null, value: last ? cap * last.eq : null, resultUsd: last ? cap * (last.eq - 1) : null, resultPct: last ? (last.eq - 1) * 100 : null,
      trades: trades, open: open, openCoins: openCoins, bots: query.mode === "avg" ? ids.length : 1, dd: maxDrawdown(pts.map(function (p) { return p.eq; })), points: pts, meta: src.meta, roundStart: w ? w.roundStart : null, roundEnd: w ? w.roundEnd : null, dailyDays: w ? Object.keys(w.daily).length : 0 };
  }
  // Сумарна крива трьох рахунків: лише часові мітки, де є ВСІ три гаманці (без округлення й нових міток); просадка рахується по цій кривій, а не з просадок гаманців
  function aggregate(model, query) {
    const caps = model.caps, per = caps.map(function (c) { const m = {}; series(model, query, c).points.forEach(function (p) { m[p.t] = p.eq; }); return m; });
    const first = per[0] || {}, out = [];
    Object.keys(first).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) { if (per.every(function (m) { return m[t] !== undefined; })) out.push({ t: t, usd: caps.reduce(function (a, c, i) { return a + c * per[i][t]; }, 0) }); });
    return out;
  }
  function kpis(model, query) {
    const stats = model.caps.map(function (c) { return walletStats(model, query, c); }), have = stats.filter(function (s) { return s.last; });
    const deposits = model.caps.reduce(function (a, c) { return a + c; }, 0), agg = aggregate(model, query);
    if (!have.length) return { stats: stats, empty: true, deposits: deposits };
    const sum = have.reduce(function (a, s) { return a + s.value; }, 0), dep = have.reduce(function (a, s) { return a + s.deposit; }, 0), lasts = have.map(function (s) { return s.last.t; });
    return { stats: stats, empty: false, complete: have.length === stats.length, deposits: dep, sum: sum, resultUsd: sum - dep, resultPct: (sum - dep) / dep * 100, open: sumNums(stats.map(function (s) { return s.open; })), trades: sumNums(stats.map(function (s) { return s.trades; })),
      dd: agg.length >= 2 ? maxDrawdown(agg.map(function (p) { return p.usd; })) : null, aggPoints: agg.length, asOf: Math.min.apply(null, lasts), mixedTimes: Math.max.apply(null, lasts) !== Math.min.apply(null, lasts) };
  }

  // ---------- Жива оцінка (окремо від історії): та сама формула, що й liveMarks у «Симуляції» ----------
  // state[монета] = [у позиції?, eq монети, hold, остання ціна закриття, вага]; для монет у позиції eq множиться на (жива ціна / ціна закриття)
  function liveEq(state, prices) {
    const syms = Object.keys(state || {});
    let eq = 0, open = 0, priced = 0;
    syms.forEach(function (sym) {
      const s = state[sym];
      if (!Array.isArray(s) || !num(s[1]) || !num(s[3]) || s[3] <= 0) return;
      const w = s.length > 4 && num(s[4]) ? s[4] : 1 / syms.length, live = prices && num(prices[sym]) && prices[sym] > 0 ? prices[sym] : null;
      if (s[0]) { open++; if (live !== null) priced++; }
      eq += w * s[1] * (s[0] && live !== null ? live / s[3] : 1);
    });
    return { eq: eq, open: open, priced: priced, complete: priced === open };
  }
  function liveWallet(model, query, cap, prices) {
    const w = model.wallets[cap]; if (!w) return null;
    const ids = query.mode === "avg" ? Object.keys(w.strategies) : (w.strategies[query.bot] ? [query.bot] : []);
    if (!ids.length) return null;
    const rs = ids.map(function (id) { return liveEq(w.strategies[id].state, prices); });
    return { eq: rs.reduce(function (a, r) { return a + r.eq; }, 0) / rs.length, open: rs.reduce(function (a, r) { return a + r.open; }, 0), priced: rs.reduce(function (a, r) { return a + r.priced; }, 0), complete: rs.every(function (r) { return r.complete; }) };
  }
  function liveSymbols(model, query) {
    const set = {};
    model.caps.forEach(function (cap) {
      const w = model.wallets[cap]; if (!w) return;
      (query.mode === "avg" ? Object.keys(w.strategies) : [query.bot]).forEach(function (id) { const st = w.strategies[id]; if (!st) return; Object.keys(st.state).forEach(function (sym) { if (st.state[sym] && st.state[sym][0]) set[sym] = 1; }); });
    });
    return Object.keys(set).sort();
  }

  root.WalletsData = { maxDrawdown: maxDrawdown, walletStats: walletStats, aggregate: aggregate, kpis: kpis, liveEq: liveEq, liveWallet: liveWallet, liveSymbols: liveSymbols, COLORS: COLORS, PERIODS: PERIODS, MIN_GAP: MIN_GAP, parseModel: parseModel, series: series, dailySeries: dailySeries, value: value, gapThreshold: gapThreshold, split: split, clip: clip, periodWindow: periodWindow, logAllowed: logAllowed, median: median };
})(typeof window !== "undefined" ? window : this);
