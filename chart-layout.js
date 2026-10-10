// Набір індикаторів графіка: модель, налаштування, збереження. Чисті функції без DOM (тестуються в tools/test-chart.html).
// Індикатор — це запис { id, type, visible, color, color2?, width, params }. Типи: sma (MA), ema, boll (Bollinger), rsi, macd, vwap, vol (об'єм).
//   • sma, ema, boll, vwap малюються на основному графіку; rsi і macd — в окремих підпанелях під ним; vol — стовпчики внизу цінової області;
//   • декілька EMA/SMA з різними параметрами можна мати одночасно, RSI і MACD — по одному (кожен у своїй підпанелі);
//   • sanitize() перевіряє будь-які дані (з localStorage чи сторінки): невідомі типи й сміття відкидаються, числа обмежуються, кольори перевіряються;
//   • математика індикаторів — у chart-indicators.js, малювання — в chart-tool.js.

(function (root) {
  "use strict";
  const VERSION = 1, MAX_ITEMS = 14;
  const PALETTE = ["#f0b90b", "#cc7ee8", "#4a9bf5", "#26a69a", "#ff7043", "#ec407a", "#8bc34a", "#29b6f6"];
  // Опис типів: назва, де малюється, параметри (мінімум, максимум, значення за замовчуванням), ліміт кількості
  const TYPES = {
    sma: { name: "Ковзна середня (SMA)", where: "main", max: 6, params: { period: { min: 2, max: 500, def: 20, label: "Період" } }, color: "#f0b90b", width: 1.3 },
    ema: { name: "Експоненційна середня (EMA)", where: "main", max: 6, params: { period: { min: 2, max: 500, def: 21, label: "Період" } }, color: "#26a69a", width: 1.5 },
    boll: { name: "Смуги Боллінджера", where: "main", max: 2, params: { period: { min: 2, max: 200, def: 20, label: "Період" }, mult: { min: 0.5, max: 5, def: 2, step: 0.5, label: "Відхилення" } }, color: "#4a9bf5", width: 1 },
    vwap: { name: "VWAP (за обсягом)", where: "main", max: 2, params: { session: { options: [["day", "день UTC"], ["week", "тиждень UTC"]], def: "day", label: "Сесія" } }, color: "#4dd0e1", width: 1.6 },
    rsi: { name: "RSI", where: "sub", max: 1, params: { period: { min: 2, max: 100, def: 14, label: "Період" } }, color: "#cc7ee8", width: 1.4 },
    macd: { name: "MACD", where: "sub", max: 1, params: { fast: { min: 2, max: 100, def: 12, label: "Швидка" }, slow: { min: 3, max: 300, def: 26, label: "Повільна" }, signal: { min: 2, max: 100, def: 9, label: "Сигнал" } }, color: "#4a9bf5", color2: "#ff9800", width: 1.4 },
    vol: { name: "Об'єм", where: "vol", max: 1, params: {}, color: "#848e9c", width: 1 },
  };

  function isColor(c) { return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c); }
  function num(v, min, max, def, int) {
    let x = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(x)) x = def;
    x = Math.min(max, Math.max(min, x));
    return int ? Math.round(x) : x;
  }
  // Приводить параметри до допустимих значень (MACD: швидка завжди менша за повільну)
  function cleanParams(type, p) {
    const T = TYPES[type], out = {};
    p = p && typeof p === "object" ? p : {};
    Object.keys(T.params).forEach(function (k) {
      const d = T.params[k];
      if (d.options) out[k] = d.options.some(function (o) { return o[0] === p[k]; }) ? p[k] : d.def;
      else out[k] = num(p[k], d.min, d.max, d.def, !d.step);
    });
    if (type === "macd" && out.fast >= out.slow) out.slow = Math.min(TYPES.macd.params.slow.max, out.fast + 1);
    return out;
  }
  function cleanItem(raw, usedIds) {
    if (!raw || typeof raw !== "object" || !TYPES[raw.type]) return null;
    const T = TYPES[raw.type];
    let id = typeof raw.id === "string" && /^[a-z0-9_]{1,20}$/i.test(raw.id) ? raw.id : null;
    if (!id || usedIds[id]) { let n = 1; while (usedIds["i" + n]) n++; id = "i" + n; }
    usedIds[id] = true;
    const it = { id: id, type: raw.type, visible: raw.visible !== false, color: isColor(raw.color) ? raw.color : T.color, width: num(raw.width, 0.5, 5, T.width), params: cleanParams(raw.type, raw.params) };
    if (T.color2) it.color2 = isColor(raw.color2) ? raw.color2 : T.color2;
    return it;
  }
  // Перевірка цілого набору: ліміти за типами й загальний, унікальні id
  function sanitize(obj) {
    if (!obj || typeof obj !== "object" || obj.v !== VERSION || !Array.isArray(obj.items)) return null;
    const used = {}, counts = {}, items = [];
    obj.items.forEach(function (raw) {
      if (items.length >= MAX_ITEMS) return;
      const it = cleanItem(raw, used);
      if (!it) return;
      counts[it.type] = (counts[it.type] || 0) + 1;
      if (counts[it.type] > TYPES[it.type].max) return;
      items.push(it);
    });
    return { v: VERSION, items: items };
  }
  function mk(id, type, visible, params, color) { return { id: id, type: type, visible: visible, color: color || TYPES[type].color, width: TYPES[type].width, params: cleanParams(type, params), color2: TYPES[type].color2 }; }
  // Набір за замовчуванням: MA 7 і 25 та об'єм увімкнені; MA 50, 99, Bollinger і RSI вимкнені (як було раніше).
  // flags — старий формат сторінок { ma7, ma25, ma50, ma99, boll, rsi, vol }: true/false змінює видимість відповідного індикатора
  function defaults(flags) {
    const f = flags && typeof flags === "object" ? flags : {};
    const on = function (k, d) { return typeof f[k] === "boolean" ? f[k] : d; };
    const items = [
      mk("ma7", "sma", on("ma7", true), { period: 7 }, "#f0b90b"), mk("ma25", "sma", on("ma25", true), { period: 25 }, "#cc7ee8"),
      mk("ma50", "sma", on("ma50", false), { period: 50 }, "#a78bfa"), mk("ma99", "sma", on("ma99", false), { period: 99 }, "#4a9bf5"),
      mk("boll", "boll", on("boll", false), { period: 20, mult: 2 }), mk("rsi", "rsi", on("rsi", false), { period: 14 }), mk("vol", "vol", on("vol", true), {}),
    ];
    items.forEach(function (it) { if (it.color2 === undefined) delete it.color2; });
    return { v: VERSION, items: items };
  }
  function find(layout, id) { return layout.items.filter(function (i) { return i.id === id; })[0] || null; }
  function count(layout, type) { return layout.items.filter(function (i) { return i.type === type; }).length; }
  function canAdd(layout, type) { return !!TYPES[type] && layout.items.length < MAX_ITEMS && count(layout, type) < TYPES[type].max; }
  function nextColor(layout) { const used = layout.items.map(function (i) { return i.color.toLowerCase(); }); return PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[layout.items.length % PALETTE.length]; }
  // Додає індикатор із параметрами за замовчуванням (або заданими); повертає новий запис або null, якщо ліміт вичерпано
  function add(layout, type, params) {
    if (!canAdd(layout, type)) return null;
    const used = {}; layout.items.forEach(function (i) { used[i.id] = true; });
    let n = 1; while (used["i" + n]) n++;
    const T = TYPES[type], it = { id: "i" + n, type: type, visible: true, color: (type === "sma" || type === "ema") ? nextColor(layout) : T.color, width: T.width, params: cleanParams(type, params || {}) };
    if (T.color2) it.color2 = T.color2;
    layout.items.push(it);
    return it;
  }
  function remove(layout, id) { const n = layout.items.length; layout.items = layout.items.filter(function (i) { return i.id !== id; }); return layout.items.length !== n; }
  // Змінює поля запису: visible, color, color2, width, params (усе проходить перевірку)
  function update(layout, id, patch) {
    const it = find(layout, id);
    if (!it || !patch) return null;
    if ("visible" in patch) it.visible = !!patch.visible;
    if ("color" in patch && isColor(patch.color)) it.color = patch.color;
    if ("color2" in patch && isColor(patch.color2) && TYPES[it.type].color2) it.color2 = patch.color2;
    if ("width" in patch) it.width = num(patch.width, 0.5, 5, it.width);
    if (patch.params) it.params = cleanParams(it.type, Object.assign({}, it.params, patch.params));
    return it;
  }
  // Підписи: label — коротка назва на кнопці, title — повна з параметрами
  function label(it) {
    switch (it.type) {
      case "sma": return "MA" + it.params.period;
      case "ema": return "EMA " + it.params.period;
      case "boll": return "BOLL";
      case "vol": return "Об'єм";
      case "vwap": return "VWAP";
      default: return TYPES[it.type] ? it.type.toUpperCase() : "?";
    }
  }
  function title(it) {
    const p = it.params;
    switch (it.type) {
      case "sma": return "SMA (" + p.period + ")";
      case "ema": return "EMA (" + p.period + ")";
      case "boll": return "Bollinger (" + p.period + ", " + p.mult + ")";
      case "rsi": return "RSI (" + p.period + ")";
      case "macd": return "MACD (" + p.fast + ", " + p.slow + ", " + p.signal + ")";
      case "vwap": return "VWAP (" + (p.session === "week" ? "тиждень" : "день") + " UTC)";
      case "vol": return "Об'єм";
      default: return "?";
    }
  }
  function serialize(layout) { return JSON.stringify(layout); }
  // Безпечне читання з тексту (localStorage): пошкоджені або чужі дані дають null
  function parse(text) {
    if (typeof text !== "string" || !text || text.length > 20000) return null;
    try { return sanitize(JSON.parse(text)); } catch (e) { return null; }
  }
  function visible(layout, where) { return layout.items.filter(function (i) { return i.visible && TYPES[i.type].where === where; }); }

  root.ChartLayout = { VERSION: VERSION, MAX_ITEMS: MAX_ITEMS, TYPES: TYPES, defaults: defaults, sanitize: sanitize, add: add, remove: remove, update: update, find: find, count: count, canAdd: canAdd, label: label, title: title, serialize: serialize, parse: parse, visible: visible };
})(typeof window !== "undefined" ? window : this);
