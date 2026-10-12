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
    return { rules: rules, caps: caps, midCap: Number.isInteger(paper.cap) ? paper.cap : caps[Math.min(1, caps.length - 1)], wallets: wallets, fee: num(paper.fee) ? paper.fee : null, updated: typeof sim.updated === "string" ? sim.updated : (typeof sim.generated_at === "string" ? sim.generated_at : null) };
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

  // ---------- Збережені торгові операції: paper_events (журнал рушія) + підтверджені записи live_feed.json (лише віртуальні угоди; Testnet не змішується) ----------
  // Ключ події: [гаманець, бот, монета, тип, свічка, час, ціна, eq, витрати] (+ «~n» для справді однакових записів): різні операції лише через однаковий час і монету НЕ зливаються.
  // Результат закриття — за тими самими формулами, що й на сторінці «Симуляція» та в агенті feed: % = eq_продажу / (eq_купівлі·(1−витрати входу)) − 1, $ = депозит · частка · (eq_продажу − eq_купівлі).
  function opKey(o, n) { return JSON.stringify([o.wallet, o.bot, o.coin, o.type, o.candle === undefined ? null : o.candle, o.t, o.price, o.eq === undefined ? null : o.eq, o.cost === undefined ? null : o.cost]) + (n > 1 ? "~" + n : ""); }
  function isInitial(reason, flag) { return flag === true || String(reason || "").indexOf("Початкова позиція") === 0; }
  function buildHistory(model, eventsByCap, feed) {
    const map = {}, order = [], notes = { fromEvents: 0, fromFeed: 0, both: 0, skipped: 0 };
    const add = function (o, src) { const e = map[o.key]; if (e) { if (e.src.indexOf(src) < 0) e.src.push(src); if (src === "live_feed") { e.exit = o.exit || e.exit; } return; } o.src = [src]; map[o.key] = o; order.push(o.key); };
    Object.keys(eventsByCap || {}).forEach(function (capKey) {
      const cap = Number(capKey), data = eventsByCap[capKey]; if (!data || typeof data !== "object") return;
      Object.keys(data).forEach(function (rule) {
        const seen = {};
        (Array.isArray(data[rule]) ? data[rule] : []).forEach(function (e) {
          const t = e && Date.parse(e.at);
          if (!e || (e.side !== "BUY" && e.side !== "SELL") || typeof e.coin !== "string" || !num(e.price) || !num(e.eq) || !isFinite(t)) { notes.skipped++; return; }
          const o = { wallet: cap, bot: rule, coin: e.coin, type: e.side === "BUY" ? "open" : "close", candle: num(e.candle) ? e.candle : null, t: t, price: e.price, eq: e.eq, w: num(e.w) ? e.w : null, cost: num(e.cost) ? e.cost : null,
            exit: e.side === "SELL" ? (e.exit || "unknown") : null, initial: e.side === "BUY" && isInitial(e.reason, false), reason: typeof e.reason === "string" ? e.reason.slice(0, 160) : "" };
          const base = opKey(o, 1); seen[base] = (seen[base] || 0) + 1; o.key = opKey(o, seen[base]); add(o, "paper_events");
        });
      });
    });
    if (feed && Array.isArray(feed.events)) {
      const seen = {};
      feed.events.forEach(function (e) {
        if (!e || e.source !== "sim" || !Number.isInteger(e.wallet) || typeof e.bot !== "string" || !num(e.t) || !num(e.price) || (e.type !== "open" && e.type !== "close")) return;
        const o = { wallet: e.wallet, bot: e.bot, coin: e.coin, type: e.type, candle: num(e.candle) ? e.candle : null, t: e.t, price: e.price, eq: num(e.eq) ? e.eq : null, w: num(e.w) ? e.w : null, cost: num(e.cost) ? e.cost : null,
          exit: e.type === "close" ? (e.exit || "unknown") : null, initial: e.initial === true, reason: typeof e.reason === "string" ? e.reason.slice(0, 160) : "" };
        const m = /~(\d+)$/.exec(String(e.id)), n = m ? parseInt(m[1], 10) : 1; o.key = opKey(o, n); add(o, "live_feed");
      });
    }
    const ops = order.map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t || (a.key < b.key ? -1 : 1); });
    ops.forEach(function (o) { if (o.src.length === 2) notes.both++; else if (o.src[0] === "paper_events") notes.fromEvents++; else notes.fromFeed++; });
    pairOps(ops, model);
    return { ops: ops, notes: notes };
  }
  function pairOps(ops, model) {
    const fee = model && num(model.fee) ? model.fee : 0, groups = {};
    ops.forEach(function (o) { (groups[[o.wallet, o.bot, o.coin].join("|")] = groups[[o.wallet, o.bot, o.coin].join("|")] || []).push(o); });
    Object.keys(groups).forEach(function (k) {
      let cur = null;
      groups[k].forEach(function (o) {
        if (o.type === "open") { cur = o; return; }
        o.result = "unknown"; o.pnlUsd = null; o.pnlPct = null; o.entry = null; o.qty = null; o.openKey = cur ? cur.key : null;
        if (cur && num(cur.eq) && cur.eq > 0 && num(o.eq) && num(cur.w)) {
          const ce = num(cur.cost) ? cur.cost : fee;
          o.entry = cur.price; o.pnlPct = (o.eq / (cur.eq * (1 - ce)) - 1) * 100; o.pnlUsd = o.wallet * cur.w * (o.eq - cur.eq); o.qty = o.wallet * cur.w * cur.eq * (1 - ce) / cur.price;
          o.result = o.pnlUsd > 1e-9 ? "profit" : o.pnlUsd < -1e-9 ? "loss" : "flat";
        }
        cur = null;
      });
      groups[k]._open = cur;
    });
    ops.forEach(function (o) { o.isOpenNow = false; });
    Object.keys(groups).forEach(function (k) { if (groups[k]._open) groups[k]._open.isOpenNow = true; });
  }
  // Win Rate лише за закриттями з відомим результатом; без закриттів — null («Немає даних», а не 0 %)
  function accountOps(ops, cap, bot) { return ops.filter(function (o) { return o.wallet === cap && o.bot === bot; }); }
  function tally(list) {
    const closed = list.filter(function (o) { return o.type === "close" && o.pnlUsd !== null; });
    const wins = closed.filter(function (o) { return o.pnlUsd > 0; }).length;
    return { closed: closed.length, wins: wins, winRate: closed.length ? wins / closed.length * 100 : null, realized: closed.length ? closed.reduce(function (a, o) { return a + o.pnlUsd; }, 0) : null, closesAll: list.filter(function (o) { return o.type === "close"; }).length };
  }

  // Рядки таблиці: 16 ботів × 3 гаманці = 48 НЕЗАЛЕЖНИХ рахунків
  function accountRows(model, ops) {
    const rows = [];
    model.caps.forEach(function (cap) {
      model.rules.forEach(function (r) {
        const s = walletStats(model, { mode: "bot", bot: r.id }, cap), t = tally(accountOps(ops || [], cap, r.id));
        rows.push({ bot: r.id, title: r.title, wallet: cap, value: s.value, resultUsd: s.resultUsd, resultPct: s.resultPct, trades: s.trades, open: s.open, dd: s.dd, winRate: t.winRate, closed: t.closed, wins: t.wins, realized: t.realized, hasData: !!s.last, last: s.last ? s.last.t : null });
      });
    });
    return rows;
  }
  function filterRows(rows, f) {
    const q = (f.q || "").trim().toLowerCase();
    return rows.filter(function (r) { return (!f.wallet || r.wallet === Number(f.wallet)) && (!f.bot || r.bot === f.bot) && (!f.onlyOpen || (r.open || 0) > 0) && (!q || r.title.toLowerCase().indexOf(q) >= 0 || r.bot.toLowerCase().indexOf(q) >= 0); });
  }
  function sortRows(rows, key, dir) {
    const m = dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      const x = a[key], y = b[key];
      if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;            // «немає даних» завжди внизу
      if (y === null || y === undefined) return -1;
      if (typeof x === "string") return m * x.localeCompare(y, "uk");
      return m * (x - y) || a.wallet - b.wallet;
    });
  }

  // Розподіл капіталу одного рахунку. Семантика рушія (agent_simulation): state[монета] = [у позиції?, eq монети, hold, ціна закриття, вага];
  // eq монети поза позицією НЕ змінюється з ціною (це готівка цієї частки), а в позиції множиться на ціну. Тому:
  //   готівка = депозит · Σ(вага · eq) за монетами БЕЗ позиції;  у позиціях = збережена вартість (крива) − готівка. Подвійного підрахунку немає: готівка + позиції = вартість.
  function capitalSplit(model, bot, cap, ops) {
    const w = model.wallets[cap], st = w && w.strategies[bot]; if (!st) return null;
    const last = st.curve[st.curve.length - 1], V = cap * last.eq, syms = Object.keys(st.state || {});
    if (!syms.length) return { available: false, reason: "рушій не віддав стан монет цього рахунку" };
    let cash = 0, openCoins = [];
    syms.forEach(function (sym) {
      const x = st.state[sym]; if (!Array.isArray(x) || !num(x[1])) return;
      const wt = x.length > 4 && num(x[4]) ? x[4] : 1 / syms.length;
      if (x[0]) openCoins.push({ coin: sym, weight: wt, eq: x[1] }); else cash += cap * wt * x[1];
    });
    const inPos = V - cash;
    if (inPos < -1e-6 * V) return { available: false, reason: "стан рушія не узгоджується зі збереженою вартістю" };
    const mine = accountOps(ops || [], cap, bot), t = tally(mine), fee = num(model.fee) ? model.fee : 0;
    let invested = 0, matched = 0;
    openCoins.forEach(function (c) {
      const opens = mine.filter(function (o) { return o.coin === c.coin && o.type === "open" && o.isOpenNow; }), b = opens[opens.length - 1];
      if (b && num(b.eq) && num(b.w)) { invested += cap * b.w * b.eq * (1 - (num(b.cost) ? b.cost : fee)); matched++; c.entry = b.price; c.entryT = b.t; }
    });
    const unreal = openCoins.length && matched === openCoins.length ? inPos - invested : (openCoins.length ? null : 0);
    return { available: true, deposit: cap, value: V, cash: Math.max(0, cash), inPos: Math.max(0, inPos), shareCash: Math.max(0, cash) / V, shareInPos: Math.max(0, inPos) / V, resultUsd: V - cap, resultPct: (V / cap - 1) * 100,
      realized: t.realized, realizedN: t.closed, unrealized: unreal, openCoins: openCoins, matched: matched };
  }
  function capitalSplitAvg(model, cap, ops) {
    const rs = model.rules.map(function (r) { return capitalSplit(model, r.id, cap, ops); }).filter(function (x) { return x && x.available; });
    if (!rs.length) return { available: false, reason: "немає даних жодного бота" };
    const m = function (k) { return rs.reduce(function (a, x) { return a + x[k]; }, 0) / rs.length; };
    return { available: true, avg: true, n: rs.length, deposit: cap, value: m("value"), cash: m("cash"), inPos: m("inPos"), shareCash: m("shareCash"), shareInPos: m("shareInPos"), resultUsd: m("resultUsd"), resultPct: m("resultPct") };
  }
  // Попередні раунди (paper.history) і денні значення (paper.daily): лише наявні підсумки, без відновлення внутрішньораундових кривих
  function roundsRows(model, query) {
    const rows = [];
    model.caps.forEach(function (cap) {
      const w = model.wallets[cap]; if (!w) return;
      w.history.forEach(function (h, i) {
        if (!h || typeof h !== "object" || !h.strategies) return;
        const ids = query.mode === "avg" ? Object.keys(h.strategies) : [query.bot], vals = ids.map(function (id) { return h.strategies[id]; }).filter(function (x) { return x && num(x.eq); });
        if (!vals.length) return;
        const eq = vals.reduce(function (a, x) { return a + x.eq; }, 0) / vals.length, hold = vals.every(function (x) { return num(x.hold); }) ? vals.reduce(function (a, x) { return a + x.hold; }, 0) / vals.length : null;
        const tr = vals.every(function (x) { return num(x.trades); }) ? vals.reduce(function (a, x) { return a + x.trades; }, 0) : null;
        rows.push({ n: i + 1, wallet: cap, start: Date.parse(h.start) || null, end: Date.parse(h.end) || null, value: cap * eq, pct: (eq - 1) * 100, trades: tr, holdPct: hold === null ? null : (hold - 1) * 100, vsHold: hold === null ? null : (eq - hold) * 100, bots: vals.length });
      });
    });
    return rows.sort(function (a, b) { return a.n - b.n || a.wallet - b.wallet; });
  }
  function dailyRows(model, query) {
    const dates = {};
    model.caps.forEach(function (cap) { const w = model.wallets[cap]; if (w) Object.keys(w.daily).forEach(function (d) { dates[d] = 1; }); });
    return Object.keys(dates).sort().map(function (d) {
      const row = { date: d, cells: {} };
      model.caps.forEach(function (cap) {
        const w = model.wallets[cap], day = w && w.daily[d]; let eq = null, trades = null;
        if (day) {
          const ids = query.mode === "avg" ? Object.keys(w.strategies) : [query.bot], vals = ids.map(function (id) { return day[id]; });
          if (vals.length && vals.every(function (x) { return Array.isArray(x) && num(x[0]); })) { eq = vals.reduce(function (a, x) { return a + x[0]; }, 0) / vals.length; trades = vals.every(function (x) { return num(x[2]); }) ? vals.reduce(function (a, x) { return a + x[2]; }, 0) : null; }
        }
        row.cells[cap] = eq === null ? null : { value: cap * eq, pct: (eq - 1) * 100, trades: trades };
      });
      return row;
    });
  }

  // ---------- Жива оцінка кожної відкритої позиції (окремо від історії; ціни — один спільний запит Binance) ----------
  // Вартість позиції за ринковою ціною P = депозит · вага · eq монети · (P / ціна закриття зі стану рушія) — та сама формула, що в liveMarks «Симуляції».
  // Вкладено = депозит · вага · eq_купівлі · (1 − витрати входу); нереалізований PnL = вартість − вкладено (потребує запису про відкриття, інакше не вигадується).
  function positionEstimates(model, query, cap, ops, feedOpen, prices, priceAt, now) {
    const w = model.wallets[cap], out = [];
    if (!w) return out;
    const ids = query.mode === "avg" ? Object.keys(w.strategies) : [query.bot], fee = num(model.fee) ? model.fee : 0, fresh = priceAt !== null && priceAt !== undefined && now - priceAt < 90000;
    ids.forEach(function (id) {
      const st = w.strategies[id]; if (!st) return;
      const syms = Object.keys(st.state || {});
      syms.forEach(function (sym) {
        const x = st.state[sym]; if (!Array.isArray(x) || !x[0] || !num(x[1]) || !num(x[3]) || x[3] <= 0) return;
        const wt = x.length > 4 && num(x[4]) ? x[4] : 1 / syms.length;
        const fo = (feedOpen || []).filter(function (f) { return f.wallet === cap && f.bot === id && f.coin === sym; })[0];
        const bs = (ops || []).filter(function (o) { return o.wallet === cap && o.bot === id && o.coin === sym && o.type === "open" && o.isOpenNow; }), b = bs[bs.length - 1];
        const entry = fo ? fo.entry : (b ? b.price : null), entryT = fo && num(fo.entry_t) ? fo.entry_t : (b ? b.t : null);
        const px = prices && num(prices[sym]) && prices[sym] > 0 ? prices[sym] : null, usable = fresh && px !== null;
        const value = usable ? cap * wt * x[1] * (px / x[3]) : null;
        const invested = b && num(b.eq) && b.eq > 0 && num(b.w) ? cap * b.w * b.eq * (1 - (num(b.cost) ? b.cost : fee)) : null;
        out.push({ bot: id, coin: sym, entry: entry, entryT: entryT, price: usable ? px : null, status: px === null ? "missing" : fresh ? "live" : "stale", value: value, invested: invested,
          pnlUsd: value !== null && invested !== null ? value - invested : null, pnlPct: value !== null && invested !== null && invested > 0 ? (value / invested - 1) * 100 : null, priceChangePct: usable && num(entry) && entry > 0 ? (px / entry - 1) * 100 : null, priceAt: priceAt === undefined ? null : priceAt });
      });
    });
    return out;
  }

  // ---------- CSV (для Excel: UTF-8 з BOM, роздільник «;», десяткова кома; текст захищено від формульних ін'єкцій) ----------
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return isFinite(v) ? v.toFixed(8).replace(/\.?0+$/, "").replace(".", ",") : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                                    // Excel не виконає як формулу
    if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(cols, rows) {
    const head = cols.map(function (c) { return csvCell(c[0]); }).join(";");
    return "\uFEFF" + [head].concat(rows.map(function (r) { return cols.map(function (c) { return csvCell(c[1](r)); }).join(";"); })).join("\r\n") + "\r\n";
  }
  function isoT(t) { return typeof t === "number" && isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : ""; }
  const EXIT_TXT = { stop: "Stop Loss", take: "Take Profit", trail: "Трейлінг-стоп", trend: "Злам тренду", signal: "Сигнал правила", unknown: "причина не вказана" };
  function botsCsv(rows) {
    return toCsv([["Бот", function (r) { return r.title; }], ["Ідентифікатор бота", function (r) { return r.bot; }], ["Початковий депозит гаманця, USD", function (r) { return r.wallet; }], ["Остання збережена вартість, USD", function (r) { return r.value; }],
      ["Результат, USD", function (r) { return r.resultUsd; }], ["Дохідність, %", function (r) { return r.resultPct; }], ["Угоди за раунд", function (r) { return r.trades; }], ["Відкриті позиції", function (r) { return r.open; }], ["Макс. просідання, % (за дискретними точками)", function (r) { return r.dd; }],
      ["Win Rate, % (частковий: лише збережені закриття)", function (r) { return r.winRate; }], ["Закриттів з відомим результатом", function (r) { return r.closed; }], ["Виграшних закриттів", function (r) { return r.wins; }],
      ["Реалізований PnL, USD (за збереженими закриттями)", function (r) { return r.realized; }], ["Остання точка (UTC)", function (r) { return isoT(r.last); }]], rows);
  }
  function keyText(o) { const m = /~(\d+)$/.exec(o.key); try { return JSON.parse(o.key.replace(/~\d+$/, "")).join("|") + (m ? "~" + m[1] : ""); } catch (e) { return o.key; } }
  function opsCsv(ops) {
    return toCsv([["Час (UTC)", function (o) { return isoT(o.t); }], ["Бот", function (o) { return o.botTitle || o.bot; }], ["Ідентифікатор бота", function (o) { return o.bot; }], ["Початковий депозит гаманця, USD", function (o) { return o.wallet; }], ["Монета", function (o) { return o.coin; }],
      ["Подія", function (o) { return o.type === "open" ? (o.initial ? "Стартова позиція раунду" : "Відкриття") : "Закриття"; }], ["Причина виходу", function (o) { return o.type === "close" ? (EXIT_TXT[o.exit] || o.exit) : ""; }],
      ["Ціна входу, USDT", function (o) { return o.type === "open" ? o.price : o.entry; }], ["Ціна виходу, USDT", function (o) { return o.type === "close" ? o.price : null; }], ["PnL, USD (віртуальний)", function (o) { return o.type === "close" ? o.pnlUsd : null; }],
      ["PnL, %", function (o) { return o.type === "close" ? o.pnlPct : null; }], ["Кількість", function (o) { return o.type === "close" ? o.qty : null; }], ["Джерело", function (o) { return o.src.join(" + "); }], ["Ключ події", keyText]], ops);
  }
  function dailyCsv(model, query) {
    const rows = [], label = query.mode === "avg" ? "Середнє по ботах (умовно)" : (model.rules.filter(function (r) { return r.id === query.bot; })[0] || { title: query.bot }).title;
    dailyRows(model, query).forEach(function (d) { model.caps.forEach(function (cap) { const x = d.cells[cap]; if (x) rows.push({ date: d.date, cap: cap, x: x }); }); });
    return toCsv([["Дата (UTC)", function (r) { return r.date; }], ["Режим / бот", function () { return label; }], ["Умовний показник", function () { return query.mode === "avg" ? "так" : "ні"; }], ["Початковий депозит гаманця, USD", function (r) { return r.cap; }],
      ["Вартість на кінець доби, USD", function (r) { return r.x.value; }], ["Результат, USD", function (r) { return r.x.value - r.cap; }], ["Дохідність, %", function (r) { return r.x.pct; }], ["Угоди", function (r) { return r.x.trades; }]], rows);
  }
  function roundsCsv(model, query) {
    const rows = roundsRows(model, query), label = query.mode === "avg" ? "Середнє по ботах (умовно)" : (model.rules.filter(function (r) { return r.id === query.bot; })[0] || { title: query.bot }).title;
    return toCsv([["Раунд №", function (r) { return r.n; }], ["Початок (UTC)", function (r) { return isoT(r.start); }], ["Кінець (UTC)", function (r) { return isoT(r.end); }], ["Режим / бот", function () { return label; }], ["Умовний показник", function () { return query.mode === "avg" ? "так" : "ні"; }],
      ["Початковий депозит гаманця, USD", function (r) { return r.wallet; }], ["Кінцева вартість, USD", function (r) { return r.value; }], ["Дохідність, %", function (r) { return r.pct; }], ["Угоди", function (r) { return r.trades; }], ["Утримання активу, %", function (r) { return r.holdPct; }], ["Різниця з утриманням, п.п.", function (r) { return r.vsHold; }]], rows);
  }

  root.WalletsData = { positionEstimates: positionEstimates, csvCell: csvCell, toCsv: toCsv, botsCsv: botsCsv, opsCsv: opsCsv, dailyCsv: dailyCsv, roundsCsv: roundsCsv, buildHistory: buildHistory, tally: tally, accountOps: accountOps, accountRows: accountRows, filterRows: filterRows, sortRows: sortRows, capitalSplit: capitalSplit, capitalSplitAvg: capitalSplitAvg, roundsRows: roundsRows, dailyRows: dailyRows, maxDrawdown: maxDrawdown, walletStats: walletStats, aggregate: aggregate, kpis: kpis, liveEq: liveEq, liveWallet: liveWallet, liveSymbols: liveSymbols, COLORS: COLORS, PERIODS: PERIODS, MIN_GAP: MIN_GAP, parseModel: parseModel, series: series, dailySeries: dailySeries, value: value, gapThreshold: gapThreshold, split: split, clip: clip, periodWindow: periodWindow, logAllowed: logAllowed, median: median };
})(typeof window !== "undefined" ? window : this);
