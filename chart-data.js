// Ринкові дані для графіків: завантаження свічок Binance, кеш, нормалізація й ОДНЕ спільне WebSocket-з'єднання на сторінку.
//  • fetchKlines: REST зі спільним кешем і об'єднанням однакових запитів (два графіки на ту саму монету дають один запит);
//  • normalizeSeries / merge / prependOlder: упорядкування за часом без дублів (свічка з тим самим часом замінюється, а не додається);
//  • subscribe: підписка на свічки монети й інтервалу. Одне з'єднання, лічильник підписників на кожен потік, жодних повторних підписок;
//  • перепідключення: затримка 1 с → 2 с → 4 с … максимум 30 с з випадковим відхиленням ±30 %; після кількох невдач зупиняємось
//    (без нескінченного циклу) й відновлюємось, коли повернувся інтернет, вкладка стала видимою або з'явилась нова підписка;
//  • після перепідключення пропущені свічки добираються через REST (startTime = остання відома свічка) і приходять у onBackfill;
//  • pager: підвантаження старішої історії без дублювання запитів;
//  • symbolInfo / inferDecimals: точність цін. Крок ціни (tickSize) береться з правил біржі (exchangeInfo), а НЕ зі свічок: у потоці свічок його немає.
//    Якщо правил немає (мережа, інструмент), кількість знаків оцінюється за самими цінами.
// Нічого не залежить від сторінки: усе, що торкається мережі й таймерів, можна підмінити (create(deps)), тому модуль тестується
// у tools/test-chart.html без біржі. Це інформація, а не фінансова порада.

(function (root) {
  "use strict";
  const DEFAULT_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

  function create(userDeps) {
    const deps = Object.assign({
      fetch: function (u) { return root.fetch(u); },
      WebSocket: root.WebSocket,
      setTimeout: function (f, ms) { return root.setTimeout(f, ms); },
      clearTimeout: function (id) { root.clearTimeout(id); },
      random: Math.random,
      now: function () { return Date.now(); },
      hosts: DEFAULT_HOSTS,
      wsUrl: "wss://stream.binance.com:9443/ws",
      autoResume: true,                 // слухати online / visibilitychange у браузері
    }, userDeps || {});
    const CFG = { ttlMs: 15000, baseDelay: 1000, maxDelay: 30000, jitter: 0.3, maxFails: 8, retryPageMs: 5000 };

    // ---------- Нормалізація ----------
    // Рядок Binance [час, open, high, low, close, volume, …] або об'єкт {t,o,h,l,c,v} → {t,o,h,l,c,v} із числами; сміття → null
    function normalizeRow(r) {
      if (!r) return null;
      const a = Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] } : r;
      const c = { t: +a.t, o: +a.o, h: +a.h, l: +a.l, c: +a.c, v: +a.v };
      if (!isFinite(c.t) || c.t <= 0 || !isFinite(c.o) || !isFinite(c.h) || !isFinite(c.l) || !isFinite(c.c)) return null;
      if (!isFinite(c.v)) c.v = 0;
      return c;
    }
    // Упорядкований за часом ряд без дублів (для однакового часу лишається остання свічка)
    function normalizeSeries(rows) {
      const map = new Map();
      (rows || []).forEach(function (r) { const c = normalizeRow(r); if (c) map.set(c.t, c); });
      return Array.from(map.values()).sort(function (a, b) { return a.t - b.t; });
    }
    // Об'єднує два ряди: свічки з incoming замінюють однакові за часом
    function merge(base, incoming) { return normalizeSeries((base || []).concat(incoming || [])); }
    // Додає ЛИШЕ старіші за найстарішу наявну свічки; повертає новий ряд і скільки реально додано
    function prependOlder(all, older) {
      const cur = normalizeSeries(all);
      const first = cur.length ? cur[0].t : Infinity;
      const add = normalizeSeries(older).filter(function (c) { return c.t < first; });
      return { all: add.concat(cur), added: add.length };
    }

    // ---------- REST: свічки ----------
    const cache = new Map(), inflight = new Map();
    function clearCache() { cache.clear(); inflight.clear(); }
    function copy(rows) { return rows.map(function (c) { return Object.assign({}, c); }); }

    function fetchKlines(sym, interval, opts) {
      opts = opts || {};
      const limit = opts.limit || 500;
      const key = [sym, interval, limit, opts.endTime || "", opts.startTime || ""].join("|");
      const hit = cache.get(key);
      if (hit && deps.now() - hit.at < CFG.ttlMs) return Promise.resolve(copy(hit.rows));
      if (inflight.has(key)) return inflight.get(key).then(copy);       // такий самий запит уже летить: чекаємо його, нового не робимо
      const p = (async function () {
        let err = new Error("немає джерел даних");
        for (let i = 0; i < deps.hosts.length; i++) {
          try {
            const url = deps.hosts[i] + "/api/v3/klines?symbol=" + sym + "USDT&interval=" + interval + "&limit=" + limit +
              (opts.endTime ? "&endTime=" + opts.endTime : "") + (opts.startTime ? "&startTime=" + opts.startTime : "");
            const r = await deps.fetch(url);
            if (!r.ok) { err = new Error("HTTP " + r.status); continue; }
            const body = await r.json();
            if (!Array.isArray(body)) { err = new Error("неправильна відповідь біржі"); continue; }
            const rows = normalizeSeries(body);
            cache.set(key, { at: deps.now(), rows: rows });
            return rows;
          } catch (e) { err = e; }
        }
        throw err;
      })();
      inflight.set(key, p);
      const done = function () { inflight.delete(key); };
      p.then(done, done);
      return p.then(copy);
    }

    // Підвантаження старішої історії: один запит одночасно, ніколи не питаємо те саме двічі, після помилки пауза
    function pager(sym, interval, limit) {
      limit = limit || 500;
      let loading = null, done = false, askedEnd = null, retryAt = 0;
      return {
        isDone: function () { return done; },
        isLoading: function () { return !!loading; },
        // oldestT: час найстарішої свічки, яку маємо. Повертає { rows, done } (rows ще не злиті з поточним рядом)
        loadOlder: function (oldestT) {
          if (done || !oldestT) return Promise.resolve({ rows: [], done: done });
          if (loading) return loading;
          if (deps.now() < retryAt) return Promise.resolve({ rows: [], done: done, wait: true });
          const end = oldestT - 1;
          if (askedEnd === end) return Promise.resolve({ rows: [], done: done });
          askedEnd = end;
          loading = fetchKlines(sym, interval, { limit: limit, endTime: end }).then(function (rows) {
            loading = null;
            if (rows.length < limit) done = true;                          // біржа віддала менше за ліміт: далі історії немає
            return { rows: rows, done: done };
          }, function (e) {
            loading = null; askedEnd = null; retryAt = deps.now() + CFG.retryPageMs;
            return { rows: [], done: done, error: e };
          });
          return loading;
        },
      };
    }

    // ---------- Точність цін ----------
    // Кількість знаків після коми з кроку ціни: "0.01000000" → 2, "1.00000000" → 0, "0.00000001" → 8
    function decimalsFromTick(tick) {
      const s = typeof tick === "number" ? tick.toFixed(12) : String(tick);
      const frac = (s.split(".")[1] || "").replace(/0+$/, "");
      return frac.length;
    }
    // Кількість знаків за самими цінами: найменше d, при якому ціна збігається з округленою до d знаків (з відносною похибкою)
    function inferDecimals(values, maxD) {
      maxD = maxD || 10;
      let best = 0;
      (values || []).forEach(function (v) {
        if (!isFinite(v) || v === 0) return;
        const tol = Math.abs(v) * 1e-9 + 1e-15;
        for (let d = 0; d <= maxD; d++) { if (Math.abs(+v.toFixed(d) - v) <= tol) { if (d > best) best = d; return; } }
        best = maxD;
      });
      return best;
    }
    function roundToTick(p, tick) { return tick > 0 ? +(Math.round(p / tick) * tick).toFixed(decimalsFromTick(tick)) : p; }
    // Відповідь exchangeInfo → { tickSize, decimals, stepSize, source: "exchange" } або null (немає правил)
    function parseSymbolInfo(json) {
      const sym = json && Array.isArray(json.symbols) ? json.symbols[0] : null;
      if (!sym || !Array.isArray(sym.filters)) return null;
      const pf = sym.filters.filter(function (f) { return f && f.filterType === "PRICE_FILTER"; })[0];
      const tick = pf ? parseFloat(pf.tickSize) : NaN;
      if (!(tick > 0)) return null;                                   // tickSize 0 означає «без обмеження»: не використовуємо
      const lf = sym.filters.filter(function (f) { return f && f.filterType === "LOT_SIZE"; })[0];
      return { tickSize: tick, decimals: decimalsFromTick(pf.tickSize), stepSize: lf ? parseFloat(lf.stepSize) : null, source: "exchange" };
    }
    const infoCache = new Map(), infoInflight = new Map();
    // Правила інструмента з біржі (один запит на монету). null — правил отримати не вдалось: викликач оцінює точність за даними
    function symbolInfo(sym) {
      if (infoCache.has(sym)) return Promise.resolve(infoCache.get(sym));
      if (infoInflight.has(sym)) return infoInflight.get(sym);
      const p = (async function () {
        for (let i = 0; i < deps.hosts.length; i++) {
          try {
            const r = await deps.fetch(deps.hosts[i] + "/api/v3/exchangeInfo?symbol=" + sym + "USDT");
            if (!r.ok) continue;
            const info = parseSymbolInfo(await r.json());
            if (info) { infoCache.set(sym, info); return info; }
          } catch (e) { /* пробуємо наступне джерело */ }
        }
        return null;                                                  // невдача не кешується: наступне відкриття спробує ще раз
      })();
      infoInflight.set(sym, p);
      const done = function () { infoInflight.delete(sym); };
      p.then(done, done);
      return p;
    }

    // ---------- WebSocket: одне з'єднання, багато підписників ----------
    const subs = new Map();            // потік → { sym, interval, handlers:Set, lastT, backfilling }
    let ws = null, status = "idle", fails = 0, timer = null, everOpened = false, msgId = 0, gotMessage = false, resumeBound = false;

    function streamName(sym, interval) { return sym.toLowerCase() + "usdt@kline_" + interval; }
    function setStatus(s) {
      if (status === s) return;
      status = s;
      subs.forEach(function (sub) { sub.handlers.forEach(function (h) { if (h.onStatus) { try { h.onStatus(s); } catch (e) { /* помилка підписника не зупиняє решту */ } } }); });
    }
    function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* закриється й перепідключиться */ } } }
    function clearTimer() { if (timer !== null) { deps.clearTimeout(timer); timer = null; } }

    function backfill(sub) {
      if (!sub.lastT || sub.backfilling) return;
      sub.backfilling = true;
      fetchKlines(sub.sym, sub.interval, { startTime: sub.lastT, limit: 500 }).then(function (rows) {
        sub.backfilling = false;
        const fresh = rows.filter(function (c) { return c.t >= sub.lastT; });
        if (!fresh.length) return;
        sub.lastT = Math.max(sub.lastT, fresh[fresh.length - 1].t);
        sub.handlers.forEach(function (h) { if (h.onBackfill) { try { h.onBackfill(fresh.slice()); } catch (e) { /* не зупиняємо */ } } });
      }, function () { sub.backfilling = false; });                           // не вдалось: спробуємо при наступному перепідключенні, без циклу
    }

    function connect() {
      clearTimer();
      if (!subs.size || !deps.WebSocket) { if (!subs.size) setStatus("idle"); return; }
      setStatus(everOpened ? "reconnecting" : "connecting");
      let sock;
      try { sock = new deps.WebSocket(deps.wsUrl); } catch (e) { scheduleReconnect(); return; }
      ws = sock; gotMessage = false;
      sock.onopen = function () {
        if (ws !== sock) return;
        setStatus("open");
        send({ method: "SUBSCRIBE", params: Array.from(subs.keys()), id: ++msgId });
        if (everOpened) subs.forEach(backfill);                                  // були розрив: добираємо пропущені свічки
        everOpened = true;
      };
      sock.onmessage = function (ev) {
        if (ws !== sock) return;
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!gotMessage) { gotMessage = true; fails = 0; }                        // з'єднання справді живе: скидаємо лічильник невдач
        if (!m || m.e !== "kline" || !m.k) return;
        const sub = subs.get(String(m.s || "").toLowerCase() + "@kline_" + m.k.i);
        if (!sub) return;                                                         // потік, на який ніхто не підписаний (або чужа монета): ігноруємо
        const c = normalizeRow({ t: m.k.t, o: m.k.o, h: m.k.h, l: m.k.l, c: m.k.c, v: m.k.v });
        if (!c || c.t < sub.lastT) return;                                        // стара або сміттєва свічка
        sub.lastT = c.t;
        sub.handlers.forEach(function (h) { if (h.onCandle) { try { h.onCandle(c, !!m.k.x, m.E); } catch (e) { /* не зупиняємо */ } } });
      };
      sock.onclose = function () {
        if (ws !== sock) return;
        ws = null;
        if (!subs.size) { setStatus("idle"); return; }
        scheduleReconnect();
      };
      sock.onerror = function () { /* після помилки браузер викличе onclose */ };
    }

    function delayFor(n) {
      const base = Math.min(CFG.maxDelay, CFG.baseDelay * Math.pow(2, n - 1));
      return Math.max(0, Math.round(base * (1 + (deps.random() * 2 - 1) * CFG.jitter)));
    }
    function scheduleReconnect() {
      clearTimer();
      fails++;
      if (fails > CFG.maxFails) { setStatus("offline"); return; }                // досить: чекаємо online / видимості / нової підписки
      setStatus("reconnecting");
      timer = deps.setTimeout(function () { timer = null; connect(); }, delayFor(fails));
    }
    function kick() {                                                             // ручне або автоматичне відновлення після «offline»
      if (!subs.size || ws || timer !== null) return;
      fails = 0;
      connect();
    }
    function bindResume() {
      if (resumeBound || !deps.autoResume || !root.addEventListener) return;
      resumeBound = true;
      root.addEventListener("online", kick);
      if (root.document) root.document.addEventListener("visibilitychange", function () { if (!root.document.hidden && status === "offline") kick(); });
    }

    // handlers: { onCandle(c, closed), onBackfill(rows), onStatus(s) }; opts.lastT — час останньої відомої свічки (для добору пропущених)
    function subscribe(sym, interval, handlers, opts) {
      bindResume();
      const key = streamName(sym, interval);
      let sub = subs.get(key), fresh = false;
      if (!sub) { sub = { sym: sym, interval: interval, handlers: new Set(), lastT: 0, backfilling: false }; subs.set(key, sub); fresh = true; }
      const h = handlers || {};
      sub.handlers.add(h);
      if (opts && opts.lastT && opts.lastT > sub.lastT) sub.lastT = opts.lastT;
      if (ws && ws.readyState === 1) { if (fresh) send({ method: "SUBSCRIBE", params: [key], id: ++msgId }); }
      else if (!ws && timer === null) { if (status === "offline") fails = 0; connect(); }
      let active = true;
      return function unsubscribe() {
        if (!active) return;
        active = false;
        const s = subs.get(key);
        if (!s) return;
        s.handlers.delete(h);
        if (s.handlers.size) return;
        subs.delete(key);
        if (subs.size && ws && ws.readyState === 1) send({ method: "UNSUBSCRIBE", params: [key], id: ++msgId });      // інші потоки лишаються, цей відписуємо
        if (!subs.size) {                                                         // нікого не лишилось: закриваємо з'єднання й таймери
          clearTimer();
          const old = ws; ws = null;
          if (old) { old.onclose = null; try { old.close(); } catch (e) { /* закрито */ } }
          fails = 0; everOpened = false;
          setStatus("idle");
        }
      };
    }
    // Сповіщає підписку про останню відому свічку (після завантаження історії), щоб розрив добирався від правильного місця
    function touch(sym, interval, lastT) {
      const sub = subs.get(streamName(sym, interval));
      if (sub && lastT > sub.lastT) sub.lastT = lastT;
    }

    return {
      create: create, normalizeRow: normalizeRow, normalizeSeries: normalizeSeries, merge: merge, prependOlder: prependOlder,
      fetchKlines: fetchKlines, pager: pager, subscribe: subscribe, touch: touch, kick: kick, clearCache: clearCache,
      symbolInfo: symbolInfo, parseSymbolInfo: parseSymbolInfo, decimalsFromTick: decimalsFromTick, inferDecimals: inferDecimals, roundToTick: roundToTick,
      status: function () { return status; },
      _state: function () { return { status: status, fails: fails, timer: timer !== null, subs: Array.from(subs.keys()), handlers: Array.from(subs.values()).map(function (s) { return s.handlers.size; }), hasSocket: !!ws }; },
      _delayFor: delayFor, CFG: CFG,
    };
  }

  const api = create();
  root.ChartData = api;
})(typeof window !== "undefined" ? window : this);
