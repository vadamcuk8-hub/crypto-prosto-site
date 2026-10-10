// Жива стрічка подій: ядро без інтерфейсу (модель подій, фільтри, цінові сповіщення, живі ціни, звук, сховище).
// Тестується в tools/test-feed.html з підміненими fetch, WebSocket, таймерами й сховищем.
//
// Три різні види подій (їх не можна плутати):
//   • «Віртуальна угода» (source=sim): підтверджене виконання за моделлю симулятора, не біржова операція. Джерело: data/live_feed.json (агент «feed»);
//   • «Binance Testnet» (source=testnet): виконання на тестовій біржі (ненастоящі гроші). Джерело: той самий журнал, ID = біржовий orderId;
//   • «Цінова подія» (source=price): ОЦІНКА за живою ціною (наближення до беззбитковості, перехід PnL через нуль). Рахується в цьому браузері,
//     не є підтвердженим продажем і зберігається лише як інформаційне повідомлення (localStorage), а не як фінансова історія.
// Живі ціни: одне спільне WebSocket-з'єднання Binance (miniTicker) на всю сторінку; без WebSocket або при збоях — запит цін раз на 20 с.
// Усі тексти з даних вставляються в інтерфейс лише через textContent.

(function (root) {
  "use strict";
  const PERIODS = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000, all: Infinity };
  const EXIT_LABEL = { stop: "Stop Loss", take: "Take Profit", trail: "Трейлінг-стоп", trend: "Злам тренду", signal: "Сигнал правила", unknown: "Причина не вказана рушієм" };
  const PRICE_TYPES = ["near_be", "reached_be", "to_plus", "to_minus"];
  const INFO_MAX = 300, STORE_INFO = "lf:info:v1", STORE_PREFS = "lf:prefs:v1";
  const DEFAULT_PREFS = { sound: false, collapsed: false, near: 0.2, seen: 0 };

  function num(v) { return typeof v === "number" && isFinite(v); }
  function str(v, max) { return typeof v === "string" ? v.slice(0, max || 200) : ""; }

  // ---------- Модель подій ----------
  function normTrade(e) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || !num(e.t)) return null;
    if (e.source !== "sim" && e.source !== "testnet") return null;
    if (e.type !== "open" && e.type !== "close") return null;
    if (typeof e.coin !== "string" || !num(e.price) || !(Number.isInteger(e.wallet) || e.wallet === "testnet")) return null;
    return {
      id: e.id, t: e.t, kind: "trade", source: e.source, type: e.type, result: e.type === "close" ? (e.result || "unknown") : null, exit: e.type === "close" ? (e.exit || "unknown") : null,
      coin: e.coin, pair: str(e.pair, 24) || e.coin + "/USDT", wallet: e.wallet, bot: str(e.bot, 60), botTitle: str(e.bot_title, 120) || str(e.bot, 60), direction: e.direction === "SHORT" ? "SHORT" : "LONG",
      price: e.price, entry: num(e.entry_price) ? e.entry_price : null, qty: num(e.qty) ? e.qty : null, pnlPct: num(e.pnl_pct) ? e.pnl_pct : null, pnlUsd: num(e.pnl_usd) ? e.pnl_usd : null,
      reason: str(e.reason, 300), confirmed: e.confirmed === "exchange" ? "exchange" : "engine", orderId: e.order_id ? str(String(e.order_id), 40) : null, status: str(e.status, 24),
      fees: e.fees && typeof e.fees === "object" ? e.fees : null, partial: !!e.partial, cost: num(e.cost) ? e.cost : null,
      initial: e.initial === true,
      pnlExact: e.source === "sim" && e.pnl_basis === "model",         // лише модель симулятора має повний облік витрат; Testnet-результат — завжди наближений
    };
  }
  function normInfo(e) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !num(e.t) || PRICE_TYPES.indexOf(e.type) < 0 || typeof e.coin !== "string" || !num(e.price)) return null;
    return {
      id: e.id, t: e.t, kind: "price", source: "price", type: e.type, result: null, exit: null, coin: e.coin, pair: str(e.pair, 24) || e.coin + "/USDT", wallet: Number.isInteger(e.wallet) ? e.wallet : "testnet",
      bot: str(e.bot, 60), botTitle: str(e.botTitle, 120) || str(e.bot, 60), direction: e.direction === "SHORT" ? "SHORT" : "LONG", price: e.price, entry: num(e.entry) ? e.entry : null,
      be: num(e.be) ? e.be : null, dist: num(e.dist) ? e.dist : null, pnlPct: num(e.pnlPct) ? e.pnlPct : null, pos: str(e.pos, 120), confirmed: "estimate",
    };
  }
  function mergeItems(lists) {                               // дедуплікація за ID, найновіші першими
    const by = {};
    lists.forEach(function (l) { l.forEach(function (it) { if (!by[it.id]) by[it.id] = it; }); });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.t - a.t || (a.id < b.id ? 1 : -1); });
  }

  // ---------- Категорії, назви, фільтри ----------
  function cats(it) {
    const c = [];
    if (it.kind === "trade") {
      if (it.type === "close") {
        if (it.result === "profit") c.push("profit");
        if (it.result === "loss") c.push("loss");
        if (it.exit === "stop" || it.exit === "take" || it.exit === "trail") c.push("sltp");
      }
    } else {
      if (it.type === "to_plus") c.push("profit");
      if (it.type === "to_minus") c.push("loss");
      if (it.type === "near_be" || it.type === "reached_be") c.push("be");
    }
    return c;
  }
  function title(it) {
    if (it.kind === "price") return { near_be: "Наближення до беззбитковості", reached_be: "Досягнуто беззбитковості", to_plus: "Позиція перейшла в плюс", to_minus: "Позиція перейшла в мінус" }[it.type];
    if (it.type === "open") return it.source === "testnet" ? "Testnet: куплено" : "Відкрито позицію";
    if (it.partial) return "Часткове закриття";
    if (it.exit === "stop") return "Stop Loss виконано";
    if (it.exit === "take") return "Take Profit виконано";
    if (it.exit === "trail") return "Трейлінг-стоп виконано";
    if (it.result === "profit") return it.source === "testnet" ? "Testnet: закрито в плюс" : "Закрито в плюс";
    if (it.result === "loss") return it.source === "testnet" ? "Testnet: закрито в мінус" : "Закрито в мінус";
    if (it.result === "flat") return "Закрито без результату";
    return it.source === "testnet" ? "Testnet: продано" : "Закрито позицію";
  }
  function tone(it) {                                         // up / down / accent / info
    if (it.kind === "price") return { near_be: "info", reached_be: "accent", to_plus: "up", to_minus: "down" }[it.type];
    if (it.type === "open") return "info";
    if (it.result === "profit") return "up";
    if (it.result === "loss") return "down";
    return it.exit === "take" ? "up" : it.exit === "stop" ? "down" : "info";
  }
  function pnlNote(it) {
    if (it.source === "testnet") return "Різниця сум виконаних ордерів у USDT: комісії біржі (їх можуть стягувати в BNB чи в самій монеті) повністю не враховано, тож це не точний чистий PnL.";
    return "Результат за моделлю симулятора: комісія й проковзання моделі враховані; відсоток — за формулою сторінки «Симуляція». Це віртуальна угода.";
  }
  function sourceLabel(it) { return it.source === "testnet" ? "Binance Testnet" : it.source === "sim" ? "Віртуальна угода" : "Цінова подія"; }
  function sourceNote(it) {
    return it.source === "testnet" ? "Виконано на тестовій біржі Binance Testnet (ненастоящі гроші)."
      : it.source === "sim" ? "Підтверджено моделлю симулятора: це віртуальна угода, а не біржова операція."
        : "Оцінка за поточною ціною: не є підтвердженим продажем і не змінює жодної угоди.";
  }
  function walletLabel(w) { return w === "testnet" ? "Testnet" : Number(w).toLocaleString("uk-UA") + " $"; }
  function applyFilter(items, f, now, skipCat) {
    const win = PERIODS[f.period] === undefined ? Infinity : PERIODS[f.period];
    return items.filter(function (it) {
      if (win !== Infinity && now - it.t > win) return false;
      if (f.coin && it.coin !== f.coin) return false;
      if (f.bot && it.bot !== f.bot) return false;
      if (f.wallet !== "" && f.wallet !== undefined && f.wallet !== null && String(it.wallet) !== String(f.wallet)) return false;
      if (!skipCat && f.cat && f.cat !== "all" && cats(it).indexOf(f.cat) < 0) return false;
      return true;
    });
  }
  function counts(items, f, now) {                            // лічильники категорій при поточних фільтрах пари, бота, гаманця й періоду
    const base = applyFilter(items, f, now, true), c = { all: base.length, profit: 0, loss: 0, be: 0, sltp: 0 };
    base.forEach(function (it) { cats(it).forEach(function (k) { c[k]++; }); });
    return c;
  }

  // ---------- Беззбитковість і цінові події ----------
  // Беззбитковість із чинної моделі витрат: ціна, за якої закриття позиції повертає витрати входу (фактичні, з події) і виходу (комісія + проковзання моделі)
  function beOf(pos, cfg) {
    const ce = num(pos.entry_cost) ? pos.entry_cost : cfg.fee, k = (1 - ce) * (1 - cfg.fee);
    return pos.direction === "SHORT" ? pos.entry * k : pos.entry / k;
  }
  function pnlPct(pos, P) { return (pos.direction === "SHORT" ? -1 : 1) * (P / pos.entry - 1) * 100; }
  function distBe(pos, be, P) { return pos.direction === "SHORT" ? (P - be) / P * 100 : (be - P) / P * 100; }       // > 0: беззбитковість ще не досягнуто
  // Автомат однієї позиції. Перший розрахунок лише запам'ятовує стан (без подій). Гістерезис: знак PnL змінюється поза смугою ±hyst %, «наближення» вмикається в зоні near %
  // і знову спрацює лише після виходу із зони 1,5·near; повернення нижче беззбитковості потребує відходу на 0,1 %.
  function evalPosition(pos, P, st, cfg, now) {
    if (!(P > 0) || !(pos.entry > 0)) return { st: st, events: [] };
    const be = beOf(pos, cfg), pl = pnlPct(pos, P), d = distBe(pos, be, P), h = cfg.hyst, near = cfg.near;
    const prev = st || { sign: 0, be: "far", n: {} }, n = { sign: prev.sign, be: prev.be, n: Object.assign({}, prev.n) };
    if (pl > h) n.sign = 1; else if (pl < -h) n.sign = -1;
    if (d <= 0) n.be = "reached";
    else if (prev.be === "reached") { if (d > 0.1) n.be = d <= near ? "near" : "far"; }
    else if (d <= near) n.be = "near";
    else if (d > near * 1.5) n.be = "far";
    const events = [];
    if (st) {
      const add = function (type) {
        n.n[type] = (n.n[type] || 0) + 1;
        events.push({ id: "px-" + pos.pos + "-" + type + "-" + n.n[type], t: now, kind: "price", type: type, coin: pos.coin, pair: pos.pair, wallet: pos.wallet, bot: pos.bot, botTitle: pos.bot_title,
          direction: pos.direction, price: P, entry: pos.entry, be: be, dist: d, pnlPct: pl, pos: pos.pos });
      };
      if (n.sign === 1 && prev.sign === -1) add("to_plus");
      else if (n.sign === -1 && prev.sign === 1) add("to_minus");
      if (n.be === "reached" && prev.be !== "reached") add("reached_be");
      else if (n.be === "near" && prev.be === "far") add("near_be");
    }
    return { st: n, events: events };
  }

  // ---------- Сховище ----------
  function createStorage(ls) {
    return {
      get: function (k, def) { try { const v = JSON.parse(ls.getItem(k)); return v === null || v === undefined ? def : v; } catch (e) { return def; } },
      set: function (k, v) { try { ls.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    };
  }

  // ---------- Живі ціни: одне WebSocket-з'єднання на сторінку, резервний запит цін ----------
  function createHub(env, onPrice, onStatus) {
    let syms = [], ws = null, fails = 0, timer = 0, rest = 0, status = "idle", stopped = true, lastMsg = 0, dog = 0;
    function setStatus(s) { if (s !== status) { status = s; onStatus(s); } }
    function url() { return "wss://stream.binance.com:9443/stream?streams=" + syms.map(function (s) { return s.toLowerCase() + "usdt@miniTicker"; }).join("/"); }
    function stopRest() { if (rest) { env.clearTimeout(rest); rest = 0; } }
    function pollRest() {
      rest = 0;
      if (stopped || !syms.length || status === "live") return;
      const q = encodeURIComponent(JSON.stringify(syms.map(function (s) { return s + "USDT"; })));
      Promise.resolve().then(function () { return env.fetch("https://data-api.binance.vision/api/v3/ticker/price?symbols=" + q); })
        .then(function (r) { if (!r || !r.ok) throw new Error("http"); return r.json(); })
        .then(function (arr) {
          if (stopped || status === "live") return;
          (arr || []).forEach(function (x) { const p = parseFloat(x.price); if (x && typeof x.symbol === "string" && p > 0) onPrice(x.symbol.replace(/USDT$/, ""), p); });
          setStatus("rest");
        })
        .catch(function () { if (!stopped && status !== "live") setStatus("offline"); })
        .then(function () { if (!stopped && status !== "live" && !rest) rest = env.setTimeout(pollRest, 20000); });
    }
    function startRest() { if (!rest && !stopped) { rest = env.setTimeout(pollRest, 0); } }
    function failed() {
      if (stopped) return;
      fails++;
      if (fails >= 2 || !env.WebSocket) startRest();
      if (status === "live") setStatus("reconnecting");
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(fails, 6) - 1)) * (0.7 + 0.6 * env.random());
      timer = env.setTimeout(connect, delay);
    }
    function watch() {                                           // WebSocket «мовчить» понад 45 с: примусове перепідключення
      dog = 0;
      if (stopped || !ws) return;
      if (env.now() - lastMsg > 45000 && status === "live") { const w = ws; ws = null; try { w.close(); } catch (e) { /* вже закрито */ } failed(); return; }
      dog = env.setTimeout(watch, 15000);
    }
    function connect() {
      timer = 0;
      if (stopped || !syms.length) return;
      if (!env.WebSocket) { if (status === "idle") setStatus("connecting"); startRest(); return; }
      if (status !== "rest" && status !== "live") setStatus(fails ? "reconnecting" : "connecting");
      let mine;
      try { mine = ws = new env.WebSocket(url()); } catch (e) { ws = null; failed(); return; }
      lastMsg = env.now();
      mine.onopen = function () { if (ws !== mine) return; fails = 0; stopRest(); lastMsg = env.now(); setStatus("live"); if (!dog) dog = env.setTimeout(watch, 15000); };
      mine.onmessage = function (ev) {
        if (ws !== mine) return;
        lastMsg = env.now();
        let d = null;
        try { d = JSON.parse(ev.data).data; } catch (e) { return; }
        const p = d && parseFloat(d.c);
        if (d && typeof d.s === "string" && p > 0) { if (status !== "live") { fails = 0; stopRest(); setStatus("live"); } onPrice(d.s.replace(/USDT$/, ""), p); }
      };
      mine.onclose = function () { if (ws !== mine) return; ws = null; failed(); };
      mine.onerror = function () { /* onclose завжди слідує за помилкою */ };
    }
    function closeWs() { if (timer) { env.clearTimeout(timer); timer = 0; } if (dog) { env.clearTimeout(dog); dog = 0; } const w = ws; ws = null; if (w) { try { w.close(); } catch (e) { /* вже закрито */ } } }
    return {
      setSymbols: function (list) {
        const next = Array.from(new Set(list)).sort();
        if (next.join(",") === syms.join(",") && !stopped) return;
        syms = next;
        closeWs(); stopRest(); fails = 0;
        if (!syms.length) { setStatus("idle"); return; }
        if (!stopped) connect();
      },
      start: function () { if (!stopped) return; stopped = false; if (syms.length) connect(); },
      stop: function () { stopped = true; closeWs(); stopRest(); setStatus("idle"); },
      status: function () { return status; },
    };
  }

  // ---------- Звук ----------
  function createSound(env) {
    const played = {};
    let ctx = null;
    function beep(freqs) {
      const AC = env.AudioContext;
      if (!AC) return false;
      try {
        ctx = ctx || new AC();
        if (ctx.resume) ctx.resume();
        freqs.forEach(function (f, i) {
          const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.16;
          o.frequency.value = f; o.type = "sine"; g.gain.value = 0.06;
          o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + 0.13);
        });
        return true;
      } catch (e) { return false; }
    }
    return {
      // звук лише для: прибуткового закриття, збиткового закриття, досягнення беззбитковості; кожна подія звучить не більше одного разу
      maybe: function (it, enabled) {
        if (!enabled || played[it.id]) return false;
        let f = null;
        if (it.kind === "trade" && it.type === "close" && !it.partial) f = it.result === "profit" ? [660, 880] : it.result === "loss" ? [440, 330] : null;
        else if (it.kind === "price" && it.type === "reached_be") f = [600];
        if (!f) return false;
        played[it.id] = true;
        return beep(f);
      },
      unlock: function () { return beep([1]); },
    };
  }

  // ---------- Контролер: журнал + живі ціни + цінові події ----------
  function createController(env) {
    const storage = createStorage(env.storage), sound = createSound(env), subs = [], newSubs = [];
    const S = { trades: [], open: [], fee: 0.0015, info: [], journal: { ok: false, loaded: false, updated: null, error: null, policy: "", max: 0, dropped: 0 }, price: "idle", prices: {}, prefs: Object.assign({}, DEFAULT_PREFS), states: {} };
    let known = null, timer = 0, started = 0, refreshing = false, lastPriceAt = 0;
    const saved = storage.get(STORE_PREFS, {});
    if (saved && typeof saved === "object") {
      if (typeof saved.sound === "boolean") S.prefs.sound = saved.sound;
      if (typeof saved.collapsed === "boolean") S.prefs.collapsed = saved.collapsed;
      if (num(saved.near) && saved.near > 0 && saved.near <= 5) S.prefs.near = saved.near;
      if (num(saved.seen)) S.prefs.seen = saved.seen;
    }
    const si = storage.get(STORE_INFO, null);
    if (si && typeof si === "object" && Array.isArray(si.events)) S.info = si.events.map(normInfo).filter(Boolean).slice(0, INFO_MAX);
    if (si && si.states && typeof si.states === "object") S.states = si.states;
    const hub = createHub(env, onPrice, function (s) { S.price = s; emit(); });

    function saveInfo() { storage.set(STORE_INFO, { v: 1, events: S.info.slice(0, INFO_MAX), states: S.states }); }
    function savePrefs() { storage.set(STORE_PREFS, S.prefs); }
    function items() { return mergeItems([S.trades, S.info]); }
    function emit() { const st = snapshot(); subs.slice().forEach(function (fn) { try { fn(st); } catch (e) { /* підписник не повинен зупиняти решту */ } }); }
    function snapshot() {
      const all = items(), seen = S.prefs.seen;
      return { items: all, unread: all.filter(function (it) { return it.t > seen; }).length, price: S.price, journal: S.journal, prefs: S.prefs, open: S.open, wallets: wallets(all) };
    }
    function wallets(all) { const s = {}; all.forEach(function (it) { s[it.wallet] = 1; }); return Object.keys(s).map(function (k) { return k === "testnet" ? "testnet" : Number(k); }).sort(function (a, b) { return (a === "testnet") - (b === "testnet") || a - b; }); }
    function announce(fresh) {                                         // нові (після першого завантаження) події: анімація й звук
      if (!fresh.length) return;
      fresh.forEach(function (it) { sound.maybe(it, S.prefs.sound); });
      newSubs.slice().forEach(function (fn) { try { fn(fresh); } catch (e) { /* ігноруємо */ } });
    }
    function trackKnown(list) {
      const fresh = [];
      list.forEach(function (it) { if (known && !known[it.id]) fresh.push(it); if (known) known[it.id] = 1; });
      if (!known) { known = {}; list.forEach(function (it) { known[it.id] = 1; }); }
      return fresh;
    }
    function applyJournal(j) {
      const trades = (j.events || []).map(normTrade).filter(function (x) { return x && !x.initial; });        // стартові позиції раунду не засмічують стрічку
      S.trades = trades;
      S.fee = num(j.fee) && j.fee >= 0 && j.fee < 0.1 ? j.fee : 0.0015;
      S.open = (Array.isArray(j.open) ? j.open : []).filter(function (p) { return p && typeof p.pos === "string" && typeof p.coin === "string" && num(p.entry) && p.entry > 0 && (Number.isInteger(p.wallet) || p.wallet === "testnet"); });
      S.journal = { ok: true, loaded: true, updated: typeof j.updated === "string" ? j.updated : null, error: null, policy: str(j.policy, 500), max: num(j.max_events) ? j.max_events : 0, dropped: num(j.dropped) ? j.dropped : 0 };
      const fresh = trackKnown(items());
      syncSymbols();
      announce(fresh.filter(function (it) { return it.kind === "trade"; }));
    }
    function syncSymbols() {
      const set = S.open.map(function (p) { return p.coin; });
      hub.setSymbols(set);
      const alive = {};
      S.open.forEach(function (p) { alive[p.pos] = 1; });
      Object.keys(S.states).forEach(function (k) { if (!alive[k]) delete S.states[k]; });
    }
    function onPrice(coin, P) {
      S.prices[coin] = P;
      const now = env.now(), cfg = { fee: S.fee, near: S.prefs.near, hyst: 0.05 }, out = [];
      S.open.forEach(function (pos) {
        if (pos.coin !== coin) return;
        const r = evalPosition(pos, P, S.states[pos.pos], cfg, now);
        S.states[pos.pos] = r.st;
        r.events.forEach(function (e) { out.push(e); });
      });
      if (out.length) {
        const have = {};
        S.info.forEach(function (x) { have[x.id] = 1; });
        const add = out.map(normInfo).filter(function (x) { return x && !have[x.id]; });
        if (add.length) { S.info = add.concat(S.info).slice(0, INFO_MAX); known = known || {}; add.forEach(function (it) { known[it.id] = 1; }); saveInfo(); announce(add); }
        emit();
      } else if (now - lastPriceAt > 30000) { lastPriceAt = now; saveInfo(); }              // стан автоматів зберігаємо й без подій, але не частіше ніж раз на 30 с
    }
    function refresh() {
      if (refreshing) return Promise.resolve();
      refreshing = true;
      return Promise.resolve().then(function () { return env.fetch(env.journalUrl + "?t=" + Math.floor(env.now() / 60000)); })
        .then(function (r) { if (!r || !r.ok) throw new Error("HTTP " + (r && r.status)); return r.json(); })
        .then(function (j) {
          if (!j || j.v !== 1 || !Array.isArray(j.events)) throw new Error("журнал має невідомий формат");
          applyJournal(j);
        })
        .catch(function (e) { S.journal = Object.assign({}, S.journal, { ok: false, loaded: S.journal.loaded, error: (e && e.message ? e.message : "помилка").slice(0, 120) }); })
        .then(function () { refreshing = false; emit(); });
    }
    return {
      state: snapshot,
      now: function () { return env.now(); },
      subscribe: function (fn) { subs.push(fn); return function () { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
      onNew: function (fn) { newSubs.push(fn); return function () { const i = newSubs.indexOf(fn); if (i >= 0) newSubs.splice(i, 1); }; },
      start: function () { if (started) return; started = 1; hub.start(); refresh(); timer = env.setTimeout(function loop() { refresh(); timer = env.setTimeout(loop, 60000); }, 60000); },
      stop: function () { started = 0; if (timer) { env.clearTimeout(timer); timer = 0; } hub.stop(); },
      refresh: refresh,
      markRead: function () { const all = items(); S.prefs.seen = Math.max(S.prefs.seen, all.length ? all[0].t : 0, env.now() - 1); savePrefs(); emit(); },
      setPref: function (k, v) { if (k in DEFAULT_PREFS) { S.prefs[k] = v; savePrefs(); if (k === "sound" && v) sound.unlock(); emit(); } },
      _inject: { onPrice: onPrice, hub: hub },
    };
  }

  function defaultEnv() {
    return {
      fetch: function (u, o) { return root.fetch(u, o); }, WebSocket: root.WebSocket, setTimeout: function (f, ms) { return root.setTimeout(f, ms); }, clearTimeout: function (id) { root.clearTimeout(id); },
      now: function () { return Date.now(); }, random: Math.random, storage: root.localStorage, AudioContext: root.AudioContext || root.webkitAudioContext, journalUrl: "data/live_feed.json",
    };
  }
  let shared = null, users = 0;
  function acquire(env) {                                             // одна спільна система на сторінку: сокет і таймери не дублюються між панелями
    if (!shared) shared = createController(env || defaultEnv());
    users++;
    shared.start();
    return shared;
  }
  function release() { users = Math.max(0, users - 1); if (!users && shared) { shared.stop(); shared = null; } }

  root.LiveFeedCore = {
    PERIODS: PERIODS, EXIT_LABEL: EXIT_LABEL, DEFAULT_PREFS: DEFAULT_PREFS, normTrade: normTrade, normInfo: normInfo, mergeItems: mergeItems, cats: cats, title: title, tone: tone, sourceLabel: sourceLabel, sourceNote: sourceNote,
    pnlNote: pnlNote, walletLabel: walletLabel, applyFilter: applyFilter, counts: counts, beOf: beOf, pnlPct: pnlPct, distBe: distBe, evalPosition: evalPosition, createStorage: createStorage, createHub: createHub, createSound: createSound,
    createController: createController, acquire: acquire, release: release, defaultEnv: defaultEnv,
  };
})(typeof window !== "undefined" ? window : this);
