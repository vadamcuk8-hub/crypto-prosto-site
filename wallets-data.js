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
        if (cv.length) w.strategies[r.id] = { curve: cv, trades: num(st.trades) ? st.trades : null, open: Array.isArray(st.open) ? st.open.length : null };
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

  root.WalletsData = { COLORS: COLORS, PERIODS: PERIODS, MIN_GAP: MIN_GAP, parseModel: parseModel, series: series, dailySeries: dailySeries, value: value, gapThreshold: gapThreshold, split: split, clip: clip, periodWindow: periodWindow, logAllowed: logAllowed, median: median };
})(typeof window !== "undefined" ? window : this);
