// Інтерактивний графік у вікні в стилі біржі Binance: ChartTool.open({...}).
//  • Монета (symbol): свічки або лінія з біржі Binance, оновлюються в реальному часі (WebSocket), 7 масштабів часу.
//  • Будь-який ряд (points): той самий графік для даних віджетів (настрій, стейблкоїни, мережа тощо).
//  • Маніпуляції: колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути; індикатори MA(7/25/99) і об'єм;
//    інструменти: курсор, горизонтальна лінія (маркер), лінія тренду, лінійка (різниця ціни, відсоток, час).
//  • Лінії й маркери зберігаються в цьому браузері. Клавіатура: стрілки, + / −, Home, Enter, Esc.
//  • Сенсорне керування (Pointer Events): один палець — прокрутка, два — масштаб, довге натискання — перехрестя з даними свічки, дотик — вибір і редагування малюнків.
//  • Малюнки редагуються (інструмент «Курсор»): вибір кліком, перетягування, контрольні точки, панель властивостей (колір, товщина, стиль, замок, видалення), Delete, Ctrl+Z / Ctrl+Y.
// Дані й WebSocket: chart-data.js (спільне з'єднання, кеш, добір пропущених свічок, підвантаження історії), індикатори: chart-indicators.js.
// Цінова шкала (звичайна, логарифмічна, відсоткова, ручне вертикальне масштабування): chart-scale.js. Точність цін: правила біржі через ChartData.symbolInfo.
// Індикатори (SMA, EMA, Bollinger, VWAP на графіку; RSI і MACD в підпанелях; об'єм): набір і збереження налаштувань — chart-layout.js, математика — chart-indicators.js.
// Потребує agent-ui.js (el), chart-data.js, chart-indicators.js, chart-scale.js, chart-layout.js. Усі тексти вставляються через textContent. Це інформація, а не фінансова порада.

const ChartTool = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const DEF_W = 860, DEF_H = 440, ML = 8, MR = 82, MT = 10, MB = 24, VOL_SHARE = 0.2, MIN_BARS = 15;
  const FRAMES = [
    { id: "1m", label: "1 хв", note: "хвилинні свічки", unit: "1 хвилину" }, { id: "5m", label: "5 хв", note: "5-хвилинні", unit: "5 хвилин" }, { id: "15m", label: "15 хв", note: "15-хвилинні", unit: "15 хвилин" },
    { id: "1h", label: "1 год", note: "годинні", unit: "1 годину" }, { id: "4h", label: "4 год", note: "4-годинні", unit: "4 години" }, { id: "1d", label: "1 день", note: "денні", unit: "1 день" },
    { id: "1w", label: "1 тиждень", note: "тижневі", unit: "1 тиждень" },
  ];
  FRAMES.splice(3, 0, { id: "30m", label: "30 хв", note: "30-хвилинні", unit: "30 хвилин" });     // 1m 5m 15m 30m 1h 2h 4h 1d 1w
  FRAMES.splice(5, 0, { id: "2h", label: "2 год", note: "2-годинні", unit: "2 години" });
  const DEFAULT_FRAME = FRAMES.findIndex(function (f) { return f.id === "1h"; }), LIMIT = 500, MAX_BARS = 6000, DEFAULT_BARS = 100;
  let uid = 0;
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const TOOLS = [
    { id: "cursor", icon: "↖", label: "Курсор", hint: "Курсор: наведіть, щоб побачити ціну й час. Колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути." },
    { id: "hline", icon: "―", label: "Горизонтальна лінія", hint: "Горизонтальна лінія: натисніть на графік, щоб поставити маркер на цій ціні." },
    { id: "trend", icon: "⟋", label: "Лінія тренду", hint: "Лінія тренду: натисніть першу точку, потім другу. Esc скасовує." },
    { id: "fib", icon: "Fib", label: "Рівні Фібоначчі", hint: "Рівні Фібоначчі: натисніть початок руху, потім його кінець. Графік покаже рівні відкату 23,6 / 38,2 / 50 / 61,8 / 78,6 %." },
    { id: "ruler", icon: "↔", label: "Лінійка", hint: "Лінійка: натисніть першу точку, потім другу, щоб побачити різницю ціни, відсоток і час. Esc очищує вимір." },
  ];
  const MAX_LINES = 20, MAX_UNDO = 50, HIT_LINE = 7, HIT_HANDLE = 10, HIT_LINE_T = 16, HIT_HANDLE_T = 26, LONG_PRESS_MS = 450, TOUCH_MOVE = 8, NARROW_PX = 600;
  // Типові вигляди малюнків (збігаються з CSS): h — горизонтальна лінія, l — тренд, f — Фібоначчі
  const DEF_LOOK = { h: { color: "#f0b90b", width: 1.2, style: "dashed" }, l: { color: "#4a9bf5", width: 1.8, style: "solid" }, f: { color: "#cc7ee8", width: 1, style: "solid" } };
  const OBJ_NAME = { h: "Горизонтальна лінія", l: "Лінія тренду", f: "Рівні Фібоначчі" };
  let idSeq = 0;
  function newId() { return "o" + Date.now().toString(36) + (++idSeq).toString(36); }

  // Розмір полотна за шириною контейнера: 1 одиниця viewBox = 1 піксель; на вузькому екрані графік вищий (0,9 від ширини), на широкому ≈0,51
  function sizeFor(wpx) {
    const w = Math.max(300, Math.min(1600, Math.round(wpx)));
    return { w: w, h: w < 560 ? Math.round(w * 0.9) : Math.max(300, Math.round(w * 0.51)) };
  }

  // Жести скасовуються, коли вкладка ховається (один спільний слухач документа на всі графіки)
  const gestureHosts = new Set();
  let visBound = false;
  function bindVisibility() {
    if (visBound) return; visBound = true;
    document.addEventListener("visibilitychange", function () { if (document.hidden) gestureHosts.forEach(function (fn) { fn(); }); });
  }

  // Один екземпляр графіка: або вікно (dialog), або вбудований на сторінку (embed). Стан кожного окремий.
  function create(embed) {
  let dlg = null, S = null, ui = {}, raf = 0, drag = null, host = null, lastGood = null, hintT = 0, lpTimer = 0, tmode = null, pinch = null;
  const tp = new Map();                                                  // активні дотики: pointerId → позиція
  let coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);   // сенсорне введення: більші області попадання
  const CLIP = "ctclip" + (++uid);
  let W = DEF_W, H = DEF_H, ro = null;                                   // розмір полотна в пікселях: оновлюється ResizeObserver, тож шрифти лишаються читабельними
  function isOpen() { return embed ? dlg.isConnected : dlg.open; }

  // ---------- Допоміжне ----------
  function sv(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }
  function fmtP(v, unit) {
    const a = Math.abs(v), d = a >= 100 ? 2 : a >= 1 ? 4 : 6;
    return v.toLocaleString("uk-UA", { minimumFractionDigits: a >= 100 ? 2 : 0, maximumFractionDigits: a >= 1e6 ? 0 : d }) + (unit === undefined ? "" : unit);
  }
  // Ціна: якщо відомий крок ціни біржі (або оцінка за даними), показуємо рівно стільки знаків після коми; інакше евристика за розміром ціни
  function FP(v) {
    if (S.spec.format) return S.spec.format(v);
    if (S.prec && isFinite(v)) return v.toLocaleString("uk-UA", { minimumFractionDigits: S.prec.decimals, maximumFractionDigits: S.prec.decimals }) + (S.spec.unit === undefined ? "" : S.spec.unit);
    return fmtP(v, S.spec.unit);
  }
  // Режим шкали зберігається в браузері й діє для всіх графіків
  function loadScaleMode() { try { const v = localStorage.getItem("ct2:scale"); return v === "log" || v === "pct" ? v : "lin"; } catch (e) { return "lin"; } }
  function saveScaleMode(m) { try { localStorage.setItem("ct2:scale", m); } catch (e) { /* без збереження */ } }
  function fmtV(v) { return v >= 1e9 ? (v / 1e9).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + " млрд" : v >= 1e6 ? (v / 1e6).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + " млн" : v >= 1e3 ? (v / 1e3).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + " тис." : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }); }
  function fmtPct(v) { return (v > 0 ? "+" : "") + v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + "%"; }
  function fmtDate(t, withTime) {
    if (t === null || t === undefined) return "";
    const d = new Date(t);
    return d.toLocaleDateString("uk-UA", { day: "numeric", month: "short", year: "2-digit" }) + (withTime ? ", " + d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "");
  }
  function fmtAxis(t) {
    if (t === null || t === undefined) return "";
    return S.intraday ? new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
  }
  function fmtSpan(ms) {
    const m = Math.round(ms / 60000);
    return m < 90 ? m + " хв" : m < 60 * 36 ? Math.round(m / 60) + " год" : Math.round(m / 1440) + " дн.";
  }
  function isLive() { return !!S.spec.symbol && !S.fallbackMode; }
  function hasVol() { return S.all.length && S.all[0].v !== undefined; }
  function hasOhlc() { return S.all.length && S.all[0].o !== undefined; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- Збереження ліній ----------
  function storeKey() { return "ct2:" + (S.spec.symbol || S.spec.id || S.spec.title); }
  // Стара структура {h, l, f} збережена; додаткові необов'язкові поля малюнка: id, locked, color, width, style ("solid" | "dashed").
  // Один пошкоджений запис пропускається, решта лишається; при нечитабельному записі повністю копія зберігається під ключем ct2bak:
  function cleanProps(o) {
    if (typeof o.locked !== "boolean") delete o.locked;
    if (!(typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color))) delete o.color;
    if (!(typeof o.width === "number" && o.width >= 0.5 && o.width <= 6)) delete o.width;
    if (o.style !== "solid" && o.style !== "dashed") delete o.style;
    return o;
  }
  function okPt(q) { return q && typeof q === "object" && typeof q.price === "number" && isFinite(q.price); }
  function normLines(d) {
    const seen = {};
    const fix = function (o) { cleanProps(o); if (typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(o.id) || seen[o.id]) o.id = newId(); seen[o.id] = true; return o; };
    const pairs = function (arr) { return (Array.isArray(arr) ? arr : []).filter(function (x) { return x && okPt(x.a) && okPt(x.b); }).map(fix); };
    return { h: (Array.isArray(d.h) ? d.h : []).filter(okPt).map(fix), l: pairs(d.l), f: pairs(d.f) };
  }
  function loadLines() {
    let raw = null;
    try {
      raw = localStorage.getItem(storeKey());
      return normLines(JSON.parse(raw || "{}") || {});
    } catch (e) {
      try { if (raw) localStorage.setItem("ct2bak:" + storeKey().slice(4), raw); } catch (e2) { /* не критично */ }
      return { h: [], l: [], f: [] };
    }
  }
  function saveLines() { try { localStorage.setItem(storeKey(), JSON.stringify({ h: S.h, l: S.l, f: S.f })); } catch (e) { /* сховище недоступне: лінії живуть до закриття вікна */ } }

  // ---------- Каркас вікна ----------
  function build() {
    dlg = embed ? el("div", "ct ct-embed") : el("dialog", "ct");
    if (!embed) dlg.setAttribute("aria-labelledby", "ctTitle");

    const head = el("div", "ct-head");
    const title = el("div");
    ui.title = el("h2", "ct-title"); ui.title.id = embed ? "ctTitleE" : "ctTitle";
    ui.sub = el("p", "ct-sub");
    title.appendChild(ui.title); title.appendChild(ui.sub);
    ui.price = el("div", "ct-price");
    ui.stats = el("div", "ct-stats");
    const close = el("button", "ct-close", "✕");
    close.type = "button"; close.setAttribute("aria-label", "Закрити графік"); close.setAttribute("data-help", "Закрити графік (клавіша Esc)");
    close.addEventListener("click", function () { dlg.close(); teardown(); });          // teardown і тут: подія close інколи приходить із запізненням
    head.appendChild(title); head.appendChild(ui.price); head.appendChild(ui.stats); if (!embed) head.appendChild(close);
    dlg.appendChild(head);

    const bar = el("div", "ct-bar");
    ui.frames = el("div", "ct-group"); ui.frames.setAttribute("role", "group"); ui.frames.setAttribute("aria-label", "Масштаб часу");
    ui.types = el("div", "ct-group"); ui.types.setAttribute("role", "group"); ui.types.setAttribute("aria-label", "Вигляд графіка");
    ui.inds = el("div", "ct-group"); ui.inds.setAttribute("role", "group"); ui.inds.setAttribute("aria-label", "Індикатори");
    ui.zoom = el("div", "ct-group"); ui.zoom.setAttribute("role", "group"); ui.zoom.setAttribute("aria-label", "Масштаб і прокрутка");
    ui.scale = el("div", "ct-group"); ui.scale.setAttribute("role", "group"); ui.scale.setAttribute("aria-label", "Цінова шкала");
    [ui.frames, ui.types, ui.inds, ui.scale, ui.zoom].forEach(function (g) { bar.appendChild(g); });
    dlg.appendChild(bar);
    ui.ipanel = el("div", "ct-ipanel"); ui.ipanel.hidden = true; ui.ivals = {};
    dlg.appendChild(ui.ipanel);

    ui.legend = el("p", "ct-legend");
    dlg.appendChild(ui.legend);

    const body = el("div", "ct-body");
    ui.tools = el("div", "ct-tools"); ui.tools.setAttribute("role", "group"); ui.tools.setAttribute("aria-label", "Інструменти малювання");
    body.appendChild(ui.tools);
    ui.svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "ct-svg", role: "application", tabindex: "0",
      "data-help": "Колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути. Клавіатура: стрілки, + / −, Enter", "aria-label": "Інтерактивний графік. Стрілки вліво й вправо переміщують курсор, плюс і мінус змінюють масштаб, Enter ставить лінію або точку лінійки." });
    body.appendChild(ui.svg);
    ui.props = el("div", "ct-props"); ui.props.hidden = true; ui.props.setAttribute("role", "toolbar"); ui.props.setAttribute("aria-label", "Властивості вибраного малюнка");
    body.appendChild(ui.props);
    dlg.appendChild(body);

    ui.hint = el("p", "ct-hint");
    dlg.appendChild(ui.hint);
    ui.list = el("div", "ct-lines");
    dlg.appendChild(ui.list);
    ui.foot = el("p", "ct-foot");
    dlg.appendChild(ui.foot);

    const svg = ui.svg;
    function xv(e) { const r = svg.getBoundingClientRect(); return (e.clientX - r.left) * W / r.width; }
    svg.addEventListener("pointerdown", function (e) {
      if (!S) return;
      coarse = e.pointerType === "touch";
      if (coarse) {
        tp.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (tp.size >= 2) { secondFinger(); return; }                                      // другий палець: масштаб (або ігнор, якщо йшло редагування)
        tmode = null;
      }
      if (S.all.length && (xv(e) >= W - MR || e.shiftKey)) {                               // вісь цін або Shift: вертикальне масштабування / зсув
        const g0 = geo(view().pts);
        drag = { axis: xv(e) >= W - MR, vpan: !(xv(e) >= W - MR), y: e.clientY, moved: false, rng: { lo: g0.loT, hi: g0.hiT }, priceH: g0.priceH, g: g0 };
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
        return;
      }
      let hit = null;
      if (S.tool === "cursor" && S.all.length) {                                          // режим вибору/редагування: ловимо контрольні точки й лінії
        const r0 = svg.getBoundingClientRect(), px = xv(e), py = (e.clientY - r0.top) * H / r0.height, vw0 = view(), g0 = geo(vw0.pts);
        const hh = hitHandle(px, py, g0, vw0);
        if (hh) { startEdit(e, hh.kind, hh.o, hh.k, g0); return; }
        const ho = hitObject(px, py, g0, vw0);
        if (ho) { select(ho.o.id); if (!ho.o.locked) { startEdit(e, ho.kind, ho.o, "move", g0); return; } hit = "locked"; }
        else hit = "empty";
      }
      drag = { x: e.clientX, off: S.off, moved: false, hit: hit };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (coarse && hit !== "locked") {                                                    // довге натискання: перехрестя з даними свічки (рух понад поріг скасовує очікування)
        const pid = e.pointerId;
        clearTimeout(lpTimer);
        lpTimer = setTimeout(function () {
          lpTimer = 0;
          const q = tp.get(pid);
          if (!S || !q || !drag || drag.moved || drag.edit || drag.axis || drag.vpan || tmode) return;
          drag.lp = true; S.lp = true; pointer({ clientX: q.x, clientY: q.y }); schedule();
        }, LONG_PRESS_MS);
      }
    });
    svg.addEventListener("pointermove", function (e) {
      if (!S) return;
      coarse = e.pointerType === "touch";
      if (coarse) {
        if (tp.has(e.pointerId)) tp.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (tmode === "pinch") { doPinch(); return; }
        if (tmode === "ignore") return;
        if (drag && drag.lp) { pointer(e); return; }
      }
      if (drag && drag.edit) { applyEdit(e); return; }
      if (drag && (drag.axis || drag.vpan)) {
        const r = svg.getBoundingClientRect(), dy = e.clientY - drag.y;
        if (Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          if (drag.axis) manualFrom(drag.g, ChartScale.zoomRange(drag.rng, Math.exp(-dy / 200)));        // потягнули вниз: свічки вищі, вгору: нижчі
          else { const dt = dy * H / r.height / drag.priceH * (drag.rng.hi - drag.rng.lo); manualFrom(drag.g, ChartScale.panRange(drag.rng, dt)); }
        }
        return;
      }
      if (drag) {
        const r = svg.getBoundingClientRect(), step = (W - ML - MR) / visibleCount() * r.width / W;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > (coarse ? TOUCH_MOVE : 4)) { drag.moved = true; clearTimeout(lpTimer); lpTimer = 0; }
        if (drag.moved) { setOff(drag.off + Math.round(dx / step)); return; }
      }
      pointer(e);
    });
    svg.addEventListener("pointerup", function (e) {
      if (!S) { drag = null; return; }
      if (e.pointerType === "touch" && touchEnd(e, false)) return;
      if (drag && drag.edit) { const d = drag; drag = null; try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ } if (d.moved) commitFrom(d.pre); schedule(); return; }
      const wasClick = drag && !drag.moved && !drag.axis && !drag.vpan;
      const emptyClick = wasClick && drag.hit === "empty";
      drag = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (emptyClick) select(null);                                                      // клік по порожньому місцю знімає виділення
      if (wasClick) { pointer(e); act(); if (e.pointerType === "touch") { S.hover = null; schedule(); } }
    });
    svg.addEventListener("pointercancel", function (e) {                                // перерване перетягування повертає малюнок на місце
      if (e.pointerType === "touch") { touchEnd(e, true); return; }
      if (drag && drag.edit) { const d = drag; drag = null; restoreSnap(d.pre); changed(); }
      else drag = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    });
    svg.addEventListener("lostpointercapture", function (e) { if (e.pointerType === "touch" && S && tp.has(e.pointerId)) touchEnd(e, true); });
    // Сенсорні жести: прокрутка сторінки лишається доступною; торкання, що починає редагування чи масштаб, забирає жест лише в межах графіка
    svg.addEventListener("touchstart", function (ev) {
      if (!S || !S.all.length) return;
      if (ev.touches.length >= 2) { ev.preventDefault(); return; }
      const t = ev.touches[0], r = svg.getBoundingClientRect(), x = (t.clientX - r.left) * W / r.width, y = (t.clientY - r.top) * H / r.height;
      if (x >= W - MR) { ev.preventDefault(); return; }
      if (S.tool !== "cursor") return;
      coarse = true;
      const vw = view(), g = geo(vw.pts), h = hitHandle(x, y, g, vw) || hitObject(x, y, g, vw);
      if (h && !h.o.locked) ev.preventDefault();
    }, { passive: false });
    svg.addEventListener("contextmenu", function (ev) { if (S && (S.lp || lpTimer || tmode)) ev.preventDefault(); });     // довге натискання не відкриває меню браузера
    svg.addEventListener("wheel", function (e) {
      if (!S) return;
      e.preventDefault();
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width;
      if (x >= W - MR && S.all.length) { const g0 = geo(view().pts); manualFrom(g0, ChartScale.zoomRange({ lo: g0.loT, hi: g0.hiT }, e.deltaY > 0 ? 1.15 : 1 / 1.15)); return; }     // колесо над віссю цін: вертикальний масштаб
      zoom(e.deltaY > 0 ? 1 : -1, clamp((x - ML) / (W - ML - MR), 0, 1));
    }, { passive: false });
    svg.addEventListener("dblclick", function (e) { if (xv(e) >= W - MR) { S.vman = null; schedule(); return; } resetView(); });          // над віссю цін: назад до авто-масштабу
    svg.addEventListener("keydown", function (e) {
      if (!S || !S.all.length) return;
      const v = view(), i = S.hover ? S.hover.i : v.pts.length - 1;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const n = clamp(i + (e.key === "ArrowLeft" ? -1 : 1), 0, v.pts.length - 1);
        S.hover = { i: n, price: v.pts[n].c };
        schedule();
      } else if (e.key === "Enter") { e.preventDefault(); if (!S.hover) S.hover = { i: i, price: v.pts[i].c }; act(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(-1, 0.5); }
      else if (e.key === "-") { e.preventDefault(); zoom(1, 0.5); }
      else if (e.key === "Home") { e.preventDefault(); resetView(); }
      else if (e.key === "a" || e.key === "A") { e.preventDefault(); S.vman = null; schedule(); }
      else if (e.key === "Escape" && (S.mA || S.mB || S.pend)) { e.stopPropagation(); S.mA = S.mB = S.pend = null; schedule(); }
      else if (e.key === "Escape" && S.sel) { e.preventDefault(); e.stopPropagation(); select(null); }
    });
    // Гарячі клавіші редагування: Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, Delete / Backspace; у полях введення не перехоплюються
    dlg.addEventListener("keydown", function (e) {
      if (!S) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey, k = (e.key || "").toLowerCase(), z = k === "z" || e.code === "KeyZ", y = k === "y" || e.code === "KeyY";
      if (mod && z && !e.shiftKey) { if (undo()) e.preventDefault(); }
      else if (mod && (y || (z && e.shiftKey))) { if (redo()) e.preventDefault(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && S.sel) { e.preventDefault(); deleteSel(); }
    });
    if (!embed) dlg.addEventListener("close", teardown);
    (embed ? host : document.body).appendChild(dlg);
  }

  // ---------- Сенсорні жести ----------
  // Стани: null (один палець: прокрутка/вибір/редагування/довге натискання), "pinch" (два пальці — масштаб), "ignore" (доки не піднято всі пальці)
  function cancelGestures() {
    clearTimeout(lpTimer); lpTimer = 0;
    if (S && drag && drag.edit && drag.moved) { restoreSnap(drag.pre); changed(); }       // частково змінені координати не лишаються
    drag = null; pinch = null; tmode = null; tp.clear();
    if (S && S.lp) { S.lp = false; S.hover = null; schedule(); }
  }
  function secondFinger() {
    clearTimeout(lpTimer); lpTimer = 0;
    if (S.lp) { S.lp = false; S.hover = null; }
    if (tmode === "pinch" || tmode === "ignore") return;                                  // третій палець ігноруємо
    if (drag && drag.edit) {                                                              // випадковий другий палець не пошкоджує малюнок: рух скасовано
      if (drag.moved) { restoreSnap(drag.pre); changed(); }
      drag = null; tmode = "ignore"; schedule(); return;
    }
    drag = null;
    if (!S.all.length) { tmode = "ignore"; return; }
    const ids = Array.from(tp.keys()).slice(0, 2), a = tp.get(ids[0]), b = tp.get(ids[1]), r = ui.svg.getBoundingClientRect(), vw = view(), n0 = visibleCount();
    const mx = ((a.x + b.x) / 2 - r.left) * W / r.width, frac = clamp((mx - ML) / (W - ML - MR), 0, 1);
    pinch = { ids: ids, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), n0: n0, anchor: vw.start + frac * n0 };
    tmode = "pinch";
  }
  // Масштаб двома пальцями: центр між пальцями лишається над тією самою свічкою; кількість свічок обмежена, ціни й малюнки не чіпаються
  function doPinch() {
    const a = tp.get(pinch.ids[0]), b = tp.get(pinch.ids[1]), len = S.all.length;
    if (!a || !b || !len) return;
    const r = ui.svg.getBoundingClientRect(), d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const newN = clamp(Math.round(pinch.n0 * pinch.d0 / d), Math.min(MIN_BARS, len), len);
    const mx = ((a.x + b.x) / 2 - r.left) * W / r.width, frac = clamp((mx - ML) / (W - ML - MR), 0, 1);
    const start = clamp(Math.round(pinch.anchor - frac * newN), 0, len - newN);
    S.n = newN; S.off = len - (start + newN);
    schedule();
  }
  // Кінець дотику; true — подію повністю оброблено тут
  function touchEnd(e, cancelled) {
    tp.delete(e.pointerId);
    try { ui.svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    if (tmode === "pinch" || tmode === "ignore") {
      if (tp.size === 0) { tmode = null; pinch = null; } else if (tmode === "pinch") { tmode = "ignore"; pinch = null; }       // після підняття одного пальця решта не тягне графік
      schedule(); return true;
    }
    clearTimeout(lpTimer); lpTimer = 0;
    if (cancelled) {
      if (drag && drag.edit && drag.moved) { restoreSnap(drag.pre); changed(); }
      drag = null; if (S.lp) { S.lp = false; S.hover = null; } schedule(); return true;
    }
    if (drag && drag.lp) { drag = null; S.lp = false; S.hover = null; schedule(); return true; }
    return false;
  }

  // Підлаштовуємо полотно під ширину контейнера (1 одиниця viewBox = 1 піксель): на телефоні шрифти не зменшуються в рази
  function applySize(wpx) {
    if (!wpx || wpx < 50 || !ui.svg) return;
    const bw = ui.svg.parentNode ? ui.svg.parentNode.clientWidth : 0;                      // ширина контейнера (не залежить від режиму розкладки)
    dlg.classList.toggle("ct-narrow", bw > 0 && bw < NARROW_PX);                           // вузький екран: інструменти зверху в рядок, панель властивостей під графіком
    const sz = sizeFor(wpx), nw = sz.w, nh = sz.h;
    if (nw === W && nh === H) return;
    W = nw; H = nh;
    cancelGestures();                                                                     // зміна розміру чи орієнтації скасовує жест, що триває
    ui.svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    if (S) schedule();
  }
  function startRO() {
    if (ro || !window.ResizeObserver || !ui.svg) return;
    ro = new ResizeObserver(function (en) { if (en.length) applySize(en[0].contentRect.width); });
    ro.observe(ui.svg);
  }
  function stopRO() { if (ro) { ro.disconnect(); ro = null; } }

  function btn(box, label, opts) {
    const b = el("button", "ct-btn" + (opts.active ? " active" : ""), label);
    b.type = "button";
    if (opts.pressed !== undefined) b.setAttribute("aria-pressed", opts.pressed ? "true" : "false");
    if (opts.title && opts.aria) b.setAttribute("aria-label", opts.title);
    if (opts.help || opts.title) b.setAttribute("data-help", opts.help || opts.title);
    b.addEventListener("click", opts.onClick);
    box.appendChild(b);
    return b;
  }

  function renderBar() {
    ui.frames.replaceChildren();
    ui.frames.hidden = !isLive();
    if (isLive()) FRAMES.forEach(function (f, i) { btn(ui.frames, f.label, { active: i === S.frame, pressed: i === S.frame, help: "Масштаб часу: одна свічка показує " + f.unit + ". Менше — детальніше, більше — ширший огляд", onClick: function () { S.frame = i; S.mA = S.mB = S.pend = null; loadLive(); renderBar(); } }); });

    ui.types.replaceChildren();
    ui.types.hidden = !hasOhlc();
    if (hasOhlc()) [["candles", "Свічки", "Свічки: ціна відкриття, закриття, максимум і мінімум за період. Зелена свічка — ціна зросла, червона — впала"], ["line", "Лінія", "Лінія: лише ціна закриття, простіше для огляду"]].forEach(function (t) { btn(ui.types, t[1], { active: S.type === t[0], pressed: S.type === t[0], help: t[2], onClick: function () { S.type = t[0]; renderBar(); schedule(); } }); });

    renderIndChips();

    ui.scale.replaceChildren();
    ui.sbtn = {};
    [["lin", "Лін.", "Звичайна шкала: однакова відстань на екрані означає однакову різницю цін"],
     ["log", "Лог.", "Логарифмічна шкала: однакова відстань означає однаковий відсоток зміни. Зручна, коли ціна сильно змінюється; потребує додатних цін"],
     ["pct", "%", "Відсоткова шкала: нуль — закриття першої видимої свічки, значення показують зміну в % від неї. База вказана на графіку"]].forEach(function (m) {
      ui.sbtn[m[0]] = btn(ui.scale, m[1], { active: S.scale === m[0], pressed: S.scale === m[0], help: m[2], onClick: function () { setScale(m[0]); } });
    });
    ui.sbtn.auto = btn(ui.scale, "Авто", { active: !S.vman, pressed: !S.vman, help: "Автоматичний вертикальний масштаб за видимими свічками. Ручний масштаб: потягніть вісь цін вгору чи вниз, Shift+перетягування по графіку зсуває вертикально. Двічі клацніть по осі або натисніть A, щоб повернути авто", onClick: function () { S.vman = null; schedule(); } });
    ui.scale.hidden = !S.all.length;

    ui.zoom.replaceChildren();
    btn(ui.zoom, "+", { title: "Збільшити масштаб", aria: true, onClick: function () { zoom(-1, 0.5); } });
    btn(ui.zoom, "−", { title: "Зменшити масштаб", aria: true, onClick: function () { zoom(1, 0.5); } });
    btn(ui.zoom, "◀", { title: "Прокрутити назад у часі", aria: true, onClick: function () { setOff(S.off + Math.max(1, Math.round(visibleCount() * 0.25))); } });
    btn(ui.zoom, "▶", { title: "Прокрутити вперед у часі", aria: true, onClick: function () { setOff(S.off - Math.max(1, Math.round(visibleCount() * 0.25))); } });
    btn(ui.zoom, "⟲", { title: "Скинути масштаб", aria: true, onClick: resetView });

    ui.tools.replaceChildren();
    TOOLS.forEach(function (t) {
      const b = btn(ui.tools, t.icon, { active: S.tool === t.id, pressed: S.tool === t.id, title: t.label, help: t.label + ". " + t.hint, aria: true, onClick: function () { S.tool = t.id; S.mA = S.mB = S.pend = null; renderBar(); schedule(); } });
      b.classList.add("ct-tool");
    });
    const un = btn(ui.tools, "↶", { title: "Скасувати (Ctrl+Z)", aria: true, onClick: function () { undo(); } });
    const rd = btn(ui.tools, "↷", { title: "Повторити (Ctrl+Y)", aria: true, onClick: function () { redo(); } });
    un.classList.add("ct-hist"); rd.classList.add("ct-hist"); ui.undoB = un; ui.redoB = rd;
    syncHist();
    ui.hint.hidden = true;
  }
  function syncHist() { if (ui.undoB) { ui.undoB.disabled = !S || !S.undo.length; ui.redoB.disabled = !S || !S.redo.length; } }

  // Режим шкали: змінюється лише спосіб показу цін, самі свічки й малюнки (час + ціна) не чіпаємо
  function setScale(m) { S.scale = m; S.vman = null; saveScaleMode(m); schedule(); }
  function syncScaleBar(g) {
    if (!ui.sbtn) return;
    ui.scale.hidden = !S.all.length;
    ["lin", "log", "pct"].forEach(function (m) {
      const b = ui.sbtn[m], ok = m === "lin" || ChartScale.canUse(m, minPrice(), g.base);
      b.disabled = !ok;
      b.classList.toggle("active", S.scale === m && (ok || m === "lin"));
      b.setAttribute("aria-pressed", S.scale === m && ok ? "true" : "false");
      b.title = ok ? "" : "Недоступно: у даних є нульові або від'ємні значення";
    });
    ui.sbtn.auto.classList.toggle("active", !g.manual);
    ui.sbtn.auto.setAttribute("aria-pressed", !g.manual ? "true" : "false");
  }
  // Ручне вертикальне масштабування: поточний діапазон стає «ручним» у просторі поточного режиму
  function manualFrom(g, r) { S.vman = { mode: g.mode, lo: r.lo, hi: r.hi }; schedule(); }

  // ---------- Дані ----------
  async function loadLive() {
    const f = FRAMES[S.frame], token = ++S.token;
    S.intraday = f.id !== "1d" && f.id !== "1w";
    ui.sub.textContent = S.spec.name + " · " + f.note + " · Binance";
    unsubLive();
    try {
      const rows = await ChartData.fetchKlines(S.spec.symbol, f.id, { limit: LIMIT });
      if (token !== S.token) return;
      S.all = rows; S.ver++; S.noMore = false; S.loadingOlder = false; S.pager = ChartData.pager(S.spec.symbol, f.id, LIMIT);
      if (!S.prec || S.prec.source !== "exchange") S.prec = { decimals: ChartData.inferDecimals(rows.slice(-200).map(function (c) { return c.c; })), tick: 0, source: "data" };   // поки немає правил біржі: оцінка за цінами
      loadPrecision(S.spec.symbol, token);
      S.error = null; lastGood = { symbol: S.spec.symbol, name: S.spec.name };
      S.n = Math.min(DEFAULT_BARS, S.all.length); S.off = 0;
      if (S.spec.focusT) {                                    // потрібний момент (угода) старший за завантажені свічки: беремо більший масштаб
        if (S.all[0].t > S.spec.focusT && S.frame < FRAMES.length - 1) { S.frame++; return loadLive(); }
        const gi = idxOf({ t: S.spec.focusT }), len = S.all.length, n = Math.min(len, DEFAULT_BARS);
        const start = clamp(gi - Math.round(n * 0.3), 0, Math.max(0, len - n));
        S.n = n; S.off = len - (start + n);
      }
      subscribeLive(f.id, token);
    } catch (e) {
      if (S.spec.fallback && S.spec.fallback.length) {         // немає пари на біржі: показуємо ряд із віджета
        S.fallbackMode = true; S.intraday = false; S.type = "line";
        S.all = S.spec.fallback.map(function (p) { return { t: p.t, c: p.c }; }); S.ver++; S.prec = null;
        S.n = S.all.length; S.off = 0;
        ui.sub.textContent = S.spec.name + " · 7 днів · цієї монети немає на Binance, ряд із CoinGecko";
      } else {
        S.all = []; S.ver++; S.error = "Для цієї монети немає торгової пари на Binance, або біржа тимчасово недоступна.";
        if (embed && lastGood && lastGood.symbol !== S.spec.symbol) {       // вбудований графік повертається до попередньої монети
          const back = lastGood;
          setTimeout(function () { if (S && S.error) open(back); }, 2500);
        }
      }
    }
    renderBar(); renderLines(); schedule();
  }

  // Крок ціни береться з правил біржі (exchangeInfo), а не зі свічок: у потоці свічок його немає
  function loadPrecision(sym, token) {
    ChartData.symbolInfo(sym).then(function (info) {
      if (!S || token !== S.token || !info) return;
      S.prec = { decimals: info.decimals, tick: info.tickSize, source: "exchange" };
      schedule();
    }, function () { /* лишається оцінка за даними */ });
  }

  function unsubLive() { if (S && S.unsub) { try { S.unsub(); } catch (e) { /* вже відписано */ } S.unsub = null; } }

  // Свічки наживо: підписка на спільне з'єднання ChartData (одне WebSocket на сторінку, без повторних підписок)
  function subscribeLive(interval, token) {
    const lastT = S.all.length ? S.all[S.all.length - 1].t : 0;
    S.unsub = ChartData.subscribe(S.spec.symbol, interval, {
      onCandle: function (c, closed, E) { if (!S || token !== S.token) return; applyCandle(c); if (E) S.exchangeTime = E; schedule(); },
      onBackfill: function (rows) { if (!S || token !== S.token) return; S.all = ChartData.merge(S.all, rows); S.ver++; schedule(); },     // пропущені під час розриву свічки
      onStatus: function (st) { if (!S || token !== S.token) return; S.link = st; schedule(); },
    }, { lastT: lastT });
  }
  function applyCandle(c) {
    const a = S.all, last = a[a.length - 1];
    if (last && last.t === c.t) a[a.length - 1] = c;                      // та сама свічка: оновлюємо
    else if (!last || c.t > last.t) { a.push(c); if (a.length > MAX_BARS) { a.shift(); shiftIdx(-1); } }
    else return;                                                           // стара свічка: ігноруємо
    S.ver++;
  }
  function shiftIdx(d) { [S.mA, S.mB, S.pend].forEach(function (p) { if (p && typeof p.gi === "number") p.gi += d; }); if (drag && drag.items) drag.items.forEach(function (it) { it.gi0 += d; }); }

  // Підвантаження старішої історії, коли вікно доходить до лівого краю даних. Вікно перегляду не зсувається:
  // S.off відраховується від правого краю, а нові свічки додаються лише ліворуч
  function maybeLoadOlder(vw) {
    if (!S || !S.pager || !isLive() || S.noMore || S.pager.isLoading() || S.pager.isDone() || !S.all.length || S.all.length >= MAX_BARS) return;
    if (vw.start > 25) return;
    const token = S.token, pager = S.pager;
    S.loadingOlder = true;
    pager.loadOlder(S.all[0].t).then(function (r) {
      if (!S || token !== S.token || pager !== S.pager) return;           // тим часом змінили монету чи масштаб
      S.loadingOlder = false;
      if (r.rows && r.rows.length) {
        const m = ChartData.prependOlder(S.all, r.rows);
        if (m.added) { S.all = m.all; S.ver++; shiftIdx(m.added); }
      }
      if (r.done) S.noMore = true;
      schedule();
    });
  }

  function teardown() { if (S) { S.token++; unsubLive(); S = null; } stopRO(); gestureHosts.delete(cancelGestures); drag = null; pinch = null; tmode = null; tp.clear(); clearTimeout(lpTimer); lpTimer = 0; clearTimeout(hintT); if (ui.props) { ui.props.hidden = true; ui.props.replaceChildren(); } }

  // ---------- Вікно перегляду (масштаб і прокрутка) ----------
  function visibleCount() { return clamp(S.n, Math.min(MIN_BARS, S.all.length), Math.max(S.all.length, 1)); }
  function view() {
    const len = S.all.length, n = visibleCount();
    S.off = clamp(S.off, 0, Math.max(0, len - n));
    const end = len - S.off, start = Math.max(0, end - n);
    return { start: start, end: end, pts: S.all.slice(start, end) };
  }
  function setOff(v) { S.off = Math.max(0, Math.min(v, S.all.length - visibleCount())); schedule(); }
  function resetView() { S.n = Math.min(S.fallbackMode || !S.spec.symbol ? S.all.length : DEFAULT_BARS, S.all.length); S.off = 0; schedule(); }
  function zoom(dir, f) {
    const len = S.all.length;
    if (!len) return;
    const oldN = visibleCount(), oldStart = Math.max(0, len - S.off - oldN);
    const newN = clamp(Math.round(oldN * (dir > 0 ? 1.2 : 0.83)), Math.min(MIN_BARS, len), len);
    const anchor = oldStart + f * oldN;
    let ns = Math.round(anchor - f * newN);
    ns = clamp(ns, 0, len - newN);
    S.n = newN; S.off = len - (ns + newN);
    schedule();
  }

  // ---------- Геометрія ----------
  // Найменша ціна в усьому ряду (кеш за версією даних): логарифмічна й відсоткова шкали потребують додатних цін
  function minPrice() { return ind("minp", function () { let m = Infinity; S.all.forEach(function (p) { const v = p.l !== undefined ? p.l : p.c; if (v < m) m = v; }); return m; }); }
  function effMode(pts) {
    if (S.scale === "lin") return "lin";
    return ChartScale.canUse(S.scale, minPrice(), pts.length ? pts[0].c : 0) ? S.scale : "lin";
  }
  function geo(pts) {
    const n = pts.length, plotW = W - ML - MR, plotH = H - MT - MB;
    const vol = ChartLayout.visible(S.layout, "vol").length > 0 && hasVol(), volH = vol ? Math.round(plotH * VOL_SHARE) : 0;
    // підпанелі (RSI, MACD) під ціною й об'ємом: кожна ≈20 % висоти, разом разом з об'ємом не більше 60 %; масштаб у них свій і ціну не чіпає
    const subItems = S.all.length > 20 ? ChartLayout.visible(S.layout, "sub") : [], budget = Math.round(plotH * 0.6) - (vol ? volH + 8 : 0);
    const subH = subItems.length ? Math.max(36, Math.min(Math.round(plotH * 0.2), Math.floor((budget - 8 * subItems.length) / subItems.length))) : 0;
    const extra = (vol ? volH + 8 : 0) + subItems.length * (subH + 8), priceH = plotH - extra;
    const subs = subItems.map(function (it, k) { return { it: it, top: MT + priceH + (vol ? volH + 8 : 0) + 8 + k * (subH + 8), h: subH }; });
    let lo = Infinity, hi = -Infinity, vmax = 0;
    pts.forEach(function (p) {
      const a = S.type === "candles" && p.l !== undefined ? p.l : p.c, b = S.type === "candles" && p.h !== undefined ? p.h : p.c;
      if (a < lo) lo = a; if (b > hi) hi = b;
      if (p.v > vmax) vmax = p.v;
    });
    if (!isFinite(lo)) { lo = 1; hi = 2; }
    const mode = effMode(pts), base = pts.length ? pts[0].c : 1;       // база відсоткової шкали: закриття першої видимої свічки
    const auto = ChartScale.autoRange(mode, lo, hi, base, 0.08);
    const man = S.vman && S.vman.mode === mode ? S.vman : null;           // ручний діапазон діє лише в тому режимі, в якому його задали
    const rng = man || auto, loT = rng.lo, hiT = rng.hi, span = hiT - loT;
    const step = plotW / n;
    return {
      n: n, plotW: plotW, plotH: plotH, priceH: priceH, volH: volH, vol: vol, subs: subs, extra: extra, vmax: vmax, step: step,
      mode: mode, base: base, loT: loT, hiT: hiT, auto: auto, manual: !!man,
      lo: ChartScale.inv(mode, loT, base), hi: ChartScale.inv(mode, hiT, base),             // межі видимого діапазону в цінах
      x: function (i) { return ML + (i + 0.5) * step; },
      y: function (v) { return MT + (hiT - ChartScale.fwd(mode, v, base)) / span * priceH; },     // ціна → піксель
      yT: function (t) { return MT + (hiT - t) / span * priceH; },                                   // координата шкали → піксель
      inside: function (v) { const t = ChartScale.fwd(mode, v, base); return t >= loT && t <= hiT; },
      idx: function (x) { return clamp(Math.floor((x - ML) / step), 0, n - 1); },
      val: function (y) { return ChartScale.inv(mode, hiT - (y - MT) / priceH * span, base); },   // піксель → ціна
      ticks: ChartScale.ticks(mode, loT, hiT, base, 5),
    };
  }

  function pointer(e) {
    if (!S || !S.all.length) return;
    const r = ui.svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    const v = view(), g = geo(v.pts);
    ui.svg.style.cursor = x >= W - MR && y >= MT && y <= MT + g.priceH + g.extra ? "ns-resize" : "";      // над віссю цін курсор підказує вертикальне масштабування
    if (x < ML || x > W - MR || y < MT || y > MT + g.priceH + g.extra) { S.hover = null; schedule(); return; }
    let price = clamp(g.val(Math.min(y, MT + g.priceH)), g.lo, g.hi);
    if (S.prec && S.prec.tick) price = ChartData.roundToTick(price, S.prec.tick);        // ціна для ліній і лінійки кратна кроку ціни біржі
    S.hover = { i: g.idx(x), price: price };
    ui.svg.style.cursor = x >= W - MR ? "ns-resize" : S.tool === "cursor" ? cursorAt(x, y, g, v) : "";
    schedule();
  }

  // позиція точки за часом (або за номером, якщо часу немає) → номер у всьому ряді
  function idxOf(p) {
    if (p.t === null || p.t === undefined) return p.gi;
    const a = S.all;
    if (!a.length) return 0;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < p.t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(a[lo - 1].t - p.t) < Math.abs(a[lo].t - p.t)) lo--;
    return lo;
  }
  function mkPoint(vw) {
    const gi = vw.start + S.hover.i, p = S.all[gi];
    return { t: p.t, gi: gi, price: S.hover.price };
  }

  // Клік або Enter: інструмент діє залежно від режиму
  function act() {
    if (!S || !S.hover) return;
    const vw = view(), pt = mkPoint(vw), P = function (q) { return { t: q.t, gi: q.gi, price: q.price }; };
    if (S.tool === "hline") {
      mutate(function () { if (S.h.length >= MAX_LINES) S.h.shift(); const o = { id: newId(), t: pt.t, price: pt.price }; S.h.push(o); S.sel = o.id; });
    } else if (S.tool === "trend") {
      if (!S.pend) S.pend = pt;
      else {
        const a = S.pend; S.pend = null;
        mutate(function () { if (S.l.length >= MAX_LINES) S.l.shift(); const o = { id: newId(), a: P(a), b: P(pt) }; S.l.push(o); S.sel = o.id; });
      }
    } else if (S.tool === "fib") {
      if (!S.pend) S.pend = pt;
      else {
        const a = S.pend; S.pend = null;
        mutate(function () { if (S.f.length >= MAX_LINES) S.f.shift(); const o = { id: newId(), a: P(a), b: P(pt) }; S.f.push(o); S.sel = o.id; });
      }
    } else if (S.tool === "ruler") {
      if (!S.mA || S.mB) { S.mA = pt; S.mB = null; } else { S.mB = pt; }
    }
    schedule();
  }

  // ---------- Редагування малюнків: вибір, перетягування, історія ----------
  // Службові рівні й маркери B/S (spec.levels, spec.markers) тут не беруть участі: редагуються лише власні малюнки користувача (S.h, S.l, S.f).
  function eff(kind, o) { const d = DEF_LOOK[kind]; return { color: o.color || d.color, width: o.width || d.width, style: o.style || d.style }; }
  function lookStyle(kind, o, fill) {                                           // inline-стиль лише для змінених користувачем властивостей
    let st = "";
    if (o.color) st += (fill ? "fill:" : "stroke:") + o.color + ";";
    if (!fill) { if (o.width) st += "stroke-width:" + o.width + ";"; if (o.style) st += "stroke-dasharray:" + (o.style === "dashed" ? "6 4" : "none") + ";"; }
    return st;
  }
  function eachObj(fn) { ["h", "f", "l"].forEach(function (k) { S[k].forEach(function (o) { fn(k, o); }); }); }    // порядок = порядок малювання (знизу вгору)
  function findSel() { let r = null; if (S.sel) eachObj(function (k, o) { if (o.id === S.sel) r = { kind: k, o: o }; }); return r; }
  function snap() { return JSON.stringify({ h: S.h, l: S.l, f: S.f }); }
  function restoreSnap(str) { const d = normLines(JSON.parse(str)); S.h = d.h; S.l = d.l; S.f = d.f; if (S.sel && !findSel()) S.sel = null; }
  function changed() { S.lv++; saveLines(); renderLines(); renderProps(); syncHist(); schedule(); }
  function commitFrom(pre) {                                                    // одна дія = один запис історії; нова дія очищає Redo
    if (snap() === pre) return false;
    S.undo.push(pre); if (S.undo.length > MAX_UNDO) S.undo.shift(); S.redo = [];
    changed(); return true;
  }
  function mutate(fn) { const pre = snap(); fn(); commitFrom(pre); }
  function undo() { if (!S || !S.undo.length) return false; S.redo.push(snap()); restoreSnap(S.undo.pop()); changed(); return true; }
  function redo() { if (!S || !S.redo.length) return false; S.undo.push(snap()); restoreSnap(S.redo.pop()); changed(); return true; }
  function select(id) { if (S.sel === id) return; S.sel = id; renderProps(); schedule(); }
  function say(msg) { ui.hint.textContent = msg; ui.hint.hidden = false; clearTimeout(hintT); hintT = setTimeout(function () { ui.hint.hidden = true; }, 2600); }
  function deleteSel() {
    const f = findSel(); if (!f) return;
    if (f.o.locked) { say("Малюнок заблоковано: спершу розблокуйте його, щоб видалити."); return; }
    mutate(function () { S[f.kind] = S[f.kind].filter(function (x) { return x !== f.o; }); S.sel = null; });
  }

  // Відстань (у пікселях полотна) від точки до відрізка
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function ptXY(q, g, vw) { return { x: g.x(idxOf(q) - vw.start), y: g.y(q.price) }; }
  function objDist(kind, o, x, y, g, vw) {
    if (x < ML || x > W - MR || y < MT || y > MT + g.priceH) return Infinity;
    if (kind === "h") return g.inside(o.price) ? Math.abs(y - g.y(o.price)) : Infinity;
    const a = ptXY(o.a, g, vw), b = ptXY(o.b, g, vw);
    if (kind === "l") return segDist(x, y, a.x, a.y, b.x, b.y);
    let d = segDist(x, y, a.x, a.y, b.x, b.y);
    const x0 = Math.min(a.x, b.x), dP = o.b.price - o.a.price;
    FIB.forEach(function (lv) { const pr = o.b.price - dP * lv; if (g.inside(pr)) d = Math.min(d, segDist(x, y, x0, g.y(pr), W - MR, g.y(pr))); });
    return d;
  }
  // Найближчий малюнок у межах HIT_LINE; при однаковій відстані — верхній за порядком малювання
  function hitObject(x, y, g, vw) {
    let best = null, bd = coarse ? HIT_LINE_T : HIT_LINE;
    eachObj(function (k, o) { const d = objDist(k, o, x, y, g, vw); if (d <= bd) { bd = d; best = { kind: k, o: o, d: d }; } });
    return best;
  }
  function hitHandle(x, y, g, vw) {
    const f = S.tool === "cursor" ? findSel() : null;
    if (!f || f.o.locked || f.kind === "h") return null;
    let best = null, bd = coarse ? HIT_HANDLE_T : HIT_HANDLE;
    ["a", "b"].forEach(function (k) { const q = ptXY(f.o[k], g, vw), d = Math.hypot(x - q.x, y - q.y); if (d <= bd) { bd = d; best = { kind: f.kind, o: f.o, k: k }; } });
    return best;
  }
  function cursorAt(x, y, g, vw) {
    if (hitHandle(x, y, g, vw)) return "grab";
    const h = hitObject(x, y, g, vw);
    if (!h) return "";
    return h.o.locked ? "default" : h.o.id === S.sel ? "move" : "pointer";
  }

  // Перетягування: зсув рахується від точки натискання в пікселях і переводиться у (час, ціну) поточними функціями шкали — стрибка немає на жодному режимі
  function startEdit(e, kind, o, what, g) {
    const names = kind === "h" ? [] : what === "move" ? ["a", "b"] : [what];
    const items = kind === "h" ? [{ p: o, gi0: 0, y0: g.y(o.price), price0: o.price }] : names.map(function (k) { return { p: o[k], gi0: idxOf(o[k]), y0: g.y(o[k].price), t0: o[k].t, g0: o[k].gi, price0: o[k].price }; });
    drag = { edit: { kind: kind, o: o }, x0: e.clientX, y0: e.clientY, g: g, items: items, moved: false, pre: snap() };
    try { ui.svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
  }
  function applyEdit(e) {
    const d = drag, r = ui.svg.getBoundingClientRect();
    let dx = (e.clientX - d.x0) * W / r.width, dy = (e.clientY - d.y0) * H / r.height;
    if (!d.moved) { if (Math.hypot(dx, dy) < (coarse ? 6 : 3)) return; d.moved = true; }
    const isH = d.edit.kind === "h", n = S.all.length;
    let di = isH ? 0 : Math.round(dx / d.g.step);
    if (!isH) { const mn = Math.min.apply(null, d.items.map(function (i) { return i.gi0; })), mx = Math.max.apply(null, d.items.map(function (i) { return i.gi0; })); di = clamp(di, -mn, n - 1 - mx); }
    const ys = d.items.map(function (i) { return i.y0; });
    dy = clamp(dy, MT - Math.min.apply(null, ys), MT + d.g.priceH - Math.max.apply(null, ys));         // вся фігура лишається в межах цінової області (геометрія зберігається)
    d.items.forEach(function (it) {
      let price = d.g.val(it.y0 + dy);
      if (S.prec && S.prec.tick) price = ChartData.roundToTick(price, S.prec.tick);
      if (!(price > 0) || !isFinite(price)) return;
      it.p.price = price;
      if (!isH) {
        if (di === 0) { it.p.t = it.t0; it.p.gi = it.g0; }
        else { const gi = it.gi0 + di; it.p.t = S.all[gi].t; it.p.gi = gi; }
      }
    });
    schedule();
  }

  // Плаваюча панель властивостей вибраного малюнка
  function renderProps() {
    const box = ui.props; box.replaceChildren();
    const f = S ? findSel() : null;
    if (!f) { box.hidden = true; return; }
    box.hidden = false;
    const o = f.o, d = eff(f.kind, o), lock = !!o.locked;
    box.appendChild(el("b", "ct-pname", OBJ_NAME[f.kind] + (lock ? " 🔒" : "")));
    const col = document.createElement("input"); col.type = "color"; col.value = d.color; col.disabled = lock; col.title = "Колір"; col.setAttribute("aria-label", "Колір малюнка");
    let pre = null;
    col.addEventListener("input", function () { if (pre === null) pre = snap(); o.color = col.value; schedule(); });
    col.addEventListener("change", function () { if (pre !== null) { const p0 = pre; pre = null; o.color = col.value; if (!commitFrom(p0)) changed(); } });
    box.appendChild(col);
    const w = document.createElement("select"); w.disabled = lock; w.title = "Товщина"; w.setAttribute("aria-label", "Товщина лінії");
    [1, 1.5, 2, 3, 4].forEach(function (x) { const op = el("option", "", x + " px"); op.value = String(x); w.appendChild(op); });
    w.value = String([1, 1.5, 2, 3, 4].reduce(function (b, x) { return Math.abs(x - d.width) < Math.abs(b - d.width) ? x : b; }, 1));
    w.addEventListener("change", function () { mutate(function () { o.width = parseFloat(w.value); }); });
    box.appendChild(w);
    const st = document.createElement("select"); st.disabled = lock; st.title = "Стиль лінії"; st.setAttribute("aria-label", "Стиль лінії");
    [["solid", "Суцільна"], ["dashed", "Пунктир"]].forEach(function (x) { const op = el("option", "", x[1]); op.value = x[0]; st.appendChild(op); });
    st.value = d.style;
    st.addEventListener("change", function () { mutate(function () { o.style = st.value; }); });
    box.appendChild(st);
    const lk = el("button", "ct-btn ct-plock", lock ? "Розблокувати" : "Заблокувати"); lk.type = "button"; lk.setAttribute("aria-pressed", lock ? "true" : "false");
    lk.setAttribute("data-help", lock ? "Дозволити переміщення й видалення" : "Захистити від випадкового переміщення й видалення");
    lk.addEventListener("click", function () { mutate(function () { if (o.locked) delete o.locked; else o.locked = true; }); });
    box.appendChild(lk);
    const rm = el("button", "ct-btn ct-pdel", "Видалити"); rm.type = "button"; rm.disabled = lock; rm.setAttribute("aria-label", "Видалити вибраний малюнок"); rm.title = lock ? "Спершу розблокуйте" : "Видалити (Delete)";
    rm.addEventListener("click", deleteSel);
    box.appendChild(rm);
  }

  // ---------- Малювання ----------
  // Таймер замість requestAnimationFrame: у закритій чи фоновій вкладці браузер не викликає анімаційні кадри, і графік не оновлювався б
  function schedule() { if (!raf) raf = setTimeout(function () { raf = 0; if (S) draw(); }, 30); }

  // Обчислення рядів індикаторів кешуються за версією даних (S.ver): наведення курсора, прокрутка й масштаб їх не перераховують
  function ind(key, fn) { return S.cache.get(key, S.ver, fn); }

  function draw() {
    const svg = ui.svg;
    svg.replaceChildren();
    if (!S.all.length) {
      sv("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "ct-empty" }, svg).textContent = S.error || "Завантаження графіка…";
      ui.price.textContent = ""; ui.stats.textContent = ""; ui.legend.textContent = "";
      return;
    }
    const vw = view(), pts = vw.pts, g = geo(pts), last = S.all[S.all.length - 1];
    maybeLoadOlder(vw);
    const prev = S.all.length > 1 ? S.all[S.all.length - 2] : last;
    const upNow = last.o !== undefined ? last.c >= last.o : last.c >= prev.c;
    const volBottom = MT + g.priceH + (g.vol ? g.volH + 8 : 0), bottom = MT + g.priceH + g.extra;

    const defs = sv("defs", {}, svg);
    const clip = sv("clipPath", { id: CLIP }, defs);
    sv("rect", { x: ML, y: MT, width: g.plotW, height: bottom - MT }, clip);
    sv("rect", { x: ML, y: MT, width: g.plotW, height: g.priceH }, sv("clipPath", { id: CLIP + "p" }, defs));

    // підпис ціни залежно від режиму: у відсотковому режимі теги й вісь показують зміну в %, у решті ціну
    const FS = function (v) { return g.mode === "pct" ? fmtPct(ChartScale.fwd("pct", v, g.base)) : FP(v); };
    // сітка й вісь цін («круглі» значення; у логарифмічному режимі відстань між ними нерівна, це нормально)
    g.ticks.forEach(function (tk) {
      const y = g.yT(tk.t);
      if (y < MT - 0.5 || y > MT + g.priceH + 0.5) return;
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-grid" }, svg);
      if (Math.abs(y - g.y(last.c)) > 13) sv("text", { x: W - MR + 6, y: y + 4, class: "ct-axis" }, svg).textContent = g.mode === "pct" ? fmtPct(tk.v) : FP(tk.v);   // не перекриваємо мітку останньої ціни
    });
    if (g.mode === "pct") {                                                   // чітко показуємо, від якої ціни рахуються відсотки
      const b0 = pts[0], pt = sv("text", { x: ML + 8, y: MT + 14, class: "ct-pct-base" }, svg);
      pt.textContent = "0% = " + FP(g.base) + " (закриття першої видимої свічки, " + fmtDate(b0.t, S.intraday || isLive()) + ")";
    } else if (g.mode === "log") sv("text", { x: ML + 8, y: MT + 14, class: "ct-pct-base" }, svg).textContent = "Логарифмічна шкала";
    if (g.manual) sv("text", { x: W - MR - 6, y: MT + 14, "text-anchor": "end", class: "ct-pct-base" }, svg).textContent = "ручний масштаб (Авто — кнопка або A)";
    // вісь часу
    const NT = W < 480 ? 3 : W < 700 ? 4 : 6;                           // на вузькому екрані менше підписів, щоб не накладались
    for (let k = 0; k < NT; k++) {
      const i = Math.round((pts.length - 1) * k / (NT - 1)), t = pts[i].t, x = g.x(i);
      sv("line", { x1: x, x2: x, y1: MT, y2: bottom, class: "ct-grid ct-vgrid" }, svg);
      sv("text", { x: x, y: H - 7, "text-anchor": k === 0 ? "start" : k === NT - 1 ? "end" : "middle", class: "ct-axis" }, svg).textContent = fmtAxis(t);
    }

    const body = sv("g", { "clip-path": "url(#" + CLIP + ")" }, svg);
    // об'єм
    if (g.vol && g.vmax > 0) {
      pts.forEach(function (p, i) {
        const h = Math.max(1, p.v / g.vmax * g.volH), up = p.o !== undefined ? p.c >= p.o : true;
        sv("rect", { x: g.x(i) - Math.max(1, g.step * 0.35), y: volBottom - h, width: Math.max(1, g.step * 0.7), height: h, class: "ct-vol " + (up ? "ct-up" : "ct-down") }, body);
      });
    }
    // ціна
    if (S.type === "candles" && hasOhlc()) {
      const bw = Math.max(1, Math.min(16, g.step * 0.7));
      pts.forEach(function (p, i) {
        const up = p.c >= p.o, cls = up ? "ct-up" : "ct-down", x = g.x(i);
        sv("line", { x1: x, x2: x, y1: g.y(p.h), y2: g.y(p.l), class: "ct-wick " + cls }, body);
        sv("rect", { x: x - bw / 2, y: Math.min(g.y(p.o), g.y(p.c)), width: bw, height: Math.max(1, Math.abs(g.y(p.o) - g.y(p.c))), class: "ct-body-c " + cls }, body);
      });
    } else {
      const line = pts.map(function (p, i) { return g.x(i).toFixed(1) + "," + g.y(p.c).toFixed(1); }).join(" ");
      sv("polygon", { points: g.x(0) + "," + (MT + g.priceH) + " " + line + " " + g.x(pts.length - 1) + "," + (MT + g.priceH), class: "ct-area" }, body);
      sv("polyline", { points: line, class: "ct-line" }, body);
    }
    // індикатори на основному графіку (SMA, EMA, Bollinger, VWAP): ряди рахуються по всій історії й кешуються, показуємо видиму частину
    drawOverlays(g, vw, sv("g", { "clip-path": "url(#" + CLIP + "p)" }, body));
    // горизонтальні лінії (маркери)
    const glow = function (kind, o, x1, y1, x2, y2) {                          // підсвічування вибраного малюнка
      if (S.sel !== o.id) return;
      sv("line", { x1: x1, y1: y1, x2: x2, y2: y2, class: "ct-sel-glow" + (o.locked ? " locked" : ""), "data-oid": o.id, style: "stroke:" + eff(kind, o).color + ";stroke-width:" + (eff(kind, o).width + 7) }, body);
    };
    S.h.forEach(function (m) {
      if (!g.inside(m.price)) return;
      const y = g.y(m.price);
      glow("h", m, ML, y, W - MR, y);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-hline", style: lookStyle("h", m), "data-oid": m.id }, body);
      sv("rect", { x: W - MR + 1, y: y - 9, width: MR - 2, height: 18, rx: 3, class: "ct-hline-tag", style: lookStyle("h", m, true) }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "ct-hline-text" }, svg).textContent = FS(m.price);
    });
    // рівні Фібоначчі
    S.f.forEach(function (fb) {
      const a = idxOf(fb.a) - vw.start, b = idxOf(fb.b) - vw.start, x0 = Math.min(g.x(a), g.x(b)), dP = fb.b.price - fb.a.price;
      glow("f", fb, g.x(a), g.y(fb.a.price), g.x(b), g.y(fb.b.price));
      FIB.forEach(function (lv) {
        const price = fb.b.price - dP * lv, y = g.y(price);
        if (!g.inside(price)) return;
        sv("line", { x1: x0, x2: W - MR, y1: y, y2: y, class: "ct-fib" + (lv === 0 || lv === 1 ? " ct-fib-edge" : ""), style: lookStyle("f", fb), "data-oid": fb.id }, body);
        sv("text", { x: x0 + 4, y: y - 3, class: "ct-fib-t", style: lookStyle("f", fb, true) }, body).textContent = (lv * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 }) + "% · " + FP(price);
      });
      sv("line", { x1: g.x(a), y1: g.y(fb.a.price), x2: g.x(b), y2: g.y(fb.b.price), class: "ct-trend ct-dash", style: fb.color ? "stroke:" + fb.color : "" }, body);
    });
    // лінії тренду
    S.l.forEach(function (ln) {
      const a = idxOf(ln.a) - vw.start, b = idxOf(ln.b) - vw.start;
      glow("l", ln, g.x(a), g.y(ln.a.price), g.x(b), g.y(ln.b.price));
      sv("line", { x1: g.x(a), y1: g.y(ln.a.price), x2: g.x(b), y2: g.y(ln.b.price), class: "ct-trend", style: lookStyle("l", ln), "data-oid": ln.id }, body);
      sv("circle", { cx: g.x(a), cy: g.y(ln.a.price), r: 3.5, class: "ct-trend-dot", style: lookStyle("l", ln, true) }, body);
      sv("circle", { cx: g.x(b), cy: g.y(ln.b.price), r: 3.5, class: "ct-trend-dot", style: lookStyle("l", ln, true) }, body);
    });
    const selO = S.tool === "cursor" ? findSel() : null;                     // контрольні точки — лише для вибраного незаблокованого тренду чи Фібоначчі
    if (selO && selO.kind !== "h" && !selO.o.locked) ["a", "b"].forEach(function (k) {
      sv("circle", { cx: g.x(idxOf(selO.o[k]) - vw.start), cy: g.y(selO.o[k].price), r: coarse ? 11 : 6, class: "ct-handle", "data-h": k, style: "stroke:" + eff(selO.kind, selO.o).color }, body);
    });
    if (S.pend) {
      const a = S.pend.gi - vw.start;
      sv("circle", { cx: g.x(a), cy: g.y(S.pend.price), r: 4.5, class: "ct-trend-dot" }, body);
      if (S.hover) sv("line", { x1: g.x(a), y1: g.y(S.pend.price), x2: g.x(S.hover.i), y2: g.y(S.hover.price), class: "ct-trend ct-dash" }, body);
    }
    // лінійка
    const B = S.mB || (S.mA && S.hover ? { gi: vw.start + S.hover.i, t: pts[S.hover.i].t, price: S.hover.price } : null);
    if (S.mA && B) ruler(svg, body, g, vw, S.mA, B);
    else if (S.mA) sv("circle", { cx: g.x(S.mA.gi - vw.start), cy: g.y(S.mA.price), r: 5, class: "ct-ruler-dot" }, body);

    // підпанелі під графіком: RSI, MACD (власні шкали; на координати свічок, рівнів і малюнків не впливають)
    const hoverGi = S.hover ? vw.start + S.hover.i : S.all.length - 1;
    g.subs.forEach(function (sp) { if (sp.it.type === "rsi") drawRSI(sp, g, vw, hoverGi); else if (sp.it.type === "macd") drawMACD(sp, g, vw, hoverGi); });
    // позначки угод (B — купівля, S — продаж) і рівні, передані сторінкою
    (S.spec.levels || []).forEach(function (lv) {
      if (!g.inside(lv.price)) return;
      const y = g.y(lv.price);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-level", style: "stroke:" + lv.color }, body);
      sv("rect", { x: W - MR + 1, y: y - 9, width: MR - 2, height: 18, rx: 3, style: "fill:" + lv.color }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "ct-hline-text" }, svg).textContent = FS(lv.price);
      if (lv.label) sv("text", { x: ML + 6, y: y - 4, class: "ct-level-t", style: "fill:" + lv.color }, body).textContent = lv.label;
    });
    (S.spec.markers || []).forEach(function (m) {
      if (!S.all.length || S.all[0].t > m.t + 1) return;
      const gi = idxOf({ t: m.t }), vi = gi - vw.start;
      if (vi < 0 || vi >= pts.length) return;
      const cd = S.all[gi], buy = m.side === "BUY", x = g.x(vi);
      const yb = buy ? g.y(cd.l !== undefined ? cd.l : cd.c) + 17 : g.y(cd.h !== undefined ? cd.h : cd.c) - 17, ye = g.y(m.price);
      const gm = sv("g", { class: "ct-marker " + (buy ? "ct-up" : "ct-down") }, body);
      sv("line", { x1: x, x2: x, y1: yb, y2: ye, class: "ct-marker-stem" }, gm);
      sv("circle", { cx: x, cy: yb, r: 9, class: "ct-marker-dot" }, gm);
      sv("text", { x: x, y: yb + 3.8, "text-anchor": "middle", class: "ct-marker-t" }, gm).textContent = buy ? "B" : "S";
      sv("title", {}, gm).textContent = m.label || (buy ? "Купівля" : "Продаж");
    });
    // остання ціна
    const yl = clamp(g.y(last.c), MT, MT + g.priceH);
    sv("line", { x1: ML, x2: W - MR, y1: yl, y2: yl, class: "ct-last" }, svg);
    sv("rect", { x: W - MR + 1, y: yl - 9, width: MR - 2, height: 18, rx: 3, class: "ct-tag " + (upNow ? "ct-up" : "ct-down") }, svg);
    sv("text", { x: W - MR + 6, y: yl + 4, class: "ct-tagtext" }, svg).textContent = FS(last.c);

    // перехрестя
    let readHtml = null;
    if (S.hover) {
      const h = S.hover, p = pts[h.i], x = g.x(h.i), y = g.y(h.price);
      sv("line", { x1: x, x2: x, y1: MT, y2: bottom, class: "ct-cross" }, svg);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-cross" }, svg);
      sv("rect", { x: W - MR + 1, y: y - 9, width: MR - 2, height: 18, rx: 3, class: "ct-crosstag" }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "ct-crosstext" }, svg).textContent = FS(h.price);
      const tt = fmtDate(p.t, S.intraday || isLive()), tw = tt.length * 6.4 + 12, tx = clamp(x - tw / 2, ML, W - MR - tw);
      sv("rect", { x: tx, y: H - MB + 2, width: tw, height: 18, rx: 3, class: "ct-crosstag" }, svg);
      sv("text", { x: tx + 6, y: H - MB + 15, class: "ct-crosstext" }, svg).textContent = tt;
      readHtml = p;
    }
    if (S.lp && S.hover) drawLpCard(g, vw, readHtml, vw.start + S.hover.i);
    legend(readHtml || last, readHtml ? vw.start + S.hover.i : S.all.length - 1, readHtml);

    // шапка
    let hi = -Infinity, lo = Infinity, vs = 0;
    pts.forEach(function (p) { hi = Math.max(hi, p.h !== undefined ? p.h : p.c); lo = Math.min(lo, p.l !== undefined ? p.l : p.c); vs += p.v || 0; });
    const ch = 100 * (last.c / pts[0].c - 1);
    ui.price.replaceChildren(el("b", "ct-big " + (upNow ? "ct-upc" : "ct-downc"), FP(last.c)), el("span", ch >= 0 ? "ct-upc" : "ct-downc", fmtPct(ch) + " у вікні"));
    ui.stats.replaceChildren(stat("Макс", FP(hi)), stat("Мін", FP(lo)), hasVol() ? stat("Об'єм", fmtV(vs)) : stat("Точок", String(pts.length)));
    const linkNote = S.link === "reconnecting" ? " З'єднання втрачено, відновлюємо…" : S.link === "offline" ? " Немає зв'язку з біржею: дані можуть бути застарілі." : "";
    ui.foot.textContent = isLive()
      ? "Дані: біржа Binance" + (S.exchangeTime ? ", час біржі " + new Date(S.exchangeTime).toLocaleTimeString("uk-UA") : "") + ". Це інформація, а не фінансова порада." + linkNote + (S.loadingOlder ? " Завантажується старіша історія…" : "")
      : (S.spec.source || "") + " Це інформація, а не фінансова порада.";
    ui.foot.textContent += S.prec && isLive() ? (S.prec.source === "exchange" ? " Крок ціни " + S.prec.tick.toLocaleString("uk-UA", { maximumFractionDigits: 10 }) + " (правила біржі)." : " Кількість знаків ціни оцінено за даними.") : "";
    syncScaleBar(g);
    refreshIndValues(hoverGi);
    renderLines(true);
  }


  // ---------- Індикатори: обчислення (з кешем), значення, малювання ----------
  function numFmt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    const a = Math.abs(v);
    return a >= 1000 ? v.toLocaleString("uk-UA", { maximumFractionDigits: 0 }) : a >= 1 ? v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) : a === 0 ? "0" : v.toPrecision(3).replace(".", ",");
  }
  // Ряди індикатора: ключ кешу = тип + параметри; однакові індикатори (наприклад, два однакові EMA) не рахуються двічі
  function computed(it) {
    const p = it.params, closes = ind("closes", function () { return S.all.map(function (q) { return q.c; }); });
    switch (it.type) {
      case "sma": return ind("sma:" + p.period, function () { return ChartIndicators.sma(closes, p.period); });
      case "ema": return ind("ema:" + p.period, function () { return ChartIndicators.ema(closes, p.period); });
      case "boll": return ind("boll:" + p.period + ":" + p.mult, function () { return ChartIndicators.bollinger(closes, p.period, p.mult); });
      case "rsi": return ind("rsi:" + p.period, function () { return ChartIndicators.rsi(closes, p.period); });
      case "macd": return ind("macd:" + p.fast + ":" + p.slow + ":" + p.signal, function () { return ChartIndicators.macd(closes, p.fast, p.slow, p.signal); });
      case "vwap": return ind("vwap:" + p.session, function () { return ChartIndicators.vwap(S.all, p.session); });
      default: return null;
    }
  }
  // Текст значення індикатора на свічці gi (для легенди й панелі керування)
  function indValue(it, gi, short) {
    if (gi === undefined || gi < 0 || gi >= S.all.length) return "";
    const c = computed(it);
    switch (it.type) {
      case "sma": case "ema": return c[gi] === null || c[gi] === undefined ? "" : FP(c[gi]);
      case "boll": return c.mid[gi] === null ? "" : short ? FP(c.mid[gi]) : "верх " + FP(c.up[gi]) + " · середня " + FP(c.mid[gi]) + " · низ " + FP(c.dn[gi]);
      case "rsi": return c[gi] === null || c[gi] === undefined ? "" : c[gi].toLocaleString("uk-UA", { maximumFractionDigits: 1 });
      case "macd": return c.macd[gi] === null ? "" : short ? numFmt(c.macd[gi]) : "MACD " + numFmt(c.macd[gi]) + " · сигнал " + numFmt(c.signal[gi]) + " · гістограма " + numFmt(c.hist[gi]);
      case "vwap":
        if (!hasVol()) return short ? "" : "потрібні дані про обсяг";
        if (c.unavailable) return short ? "" : "недоступний на цьому масштабі (свічка не коротша за сесію)";
        return c.vwap[gi] === null ? "" : FP(c.vwap[gi]) + (c.partial[gi] ? (short ? "*" : " (неповна сесія)") : "");
      case "vol": return S.all[gi].v === undefined ? "" : fmtV(S.all[gi].v);
      default: return "";
    }
  }
  function refreshIndValues(gi) { Object.keys(ui.ivals).forEach(function (id) { const it = ChartLayout.find(S.layout, id); if (it) ui.ivals[id].textContent = it.visible ? indValue(it, gi, false) || "—" : "приховано"; }); }

  // Лінія по ряду; ids — номер сесії кожної точки: на межі сесій лінія розривається (VWAP); partial — чи неповна сесія
  function segments(arr, ids, part, vw, g) {
    const out = []; let d = "", sid = null, pf = false;
    const flush = function () { if (d) out.push({ d: d, partial: pf }); d = ""; };
    for (let i = vw.start; i < vw.end; i++) {
      const v = arr[i];
      if (v === null || v === undefined) { flush(); continue; }
      if (ids && ids[i] !== sid) { flush(); sid = ids[i]; pf = !!(part && part[i]); }
      d += (d ? "L" : "M") + g.x(i - vw.start).toFixed(1) + " " + g.y(v).toFixed(1);
    }
    flush();
    return out;
  }
  function drawOverlays(g, vw, body) {
    const notes = [];
    ChartLayout.visible(S.layout, "main").forEach(function (it) {
      const p = it.params, st = "stroke:" + it.color + ";stroke-width:" + it.width;
      if (it.type === "sma" || it.type === "ema") {
        if (S.all.length < p.period) return;
        segments(computed(it), null, null, vw, g).forEach(function (sg) { sv("path", { d: sg.d, class: "ct-ma" + (it.type === "ema" ? " ct-ema" : ""), style: st }, body); });
      } else if (it.type === "boll") {
        if (S.all.length < p.period) return;
        const bb = computed(it), U = bb.up.slice(vw.start, vw.end), D = bb.dn.slice(vw.start, vw.end), Mm = bb.mid.slice(vw.start, vw.end);
        const path = function (arr) { let d = ""; arr.forEach(function (v, i) { if (v !== null) d += (d ? "L" : "M") + g.x(i).toFixed(1) + " " + g.y(v).toFixed(1); }); return d; };
        const ok = U.map(function (v, i) { return v !== null && D[i] !== null; });
        const poly = []; U.forEach(function (v, i) { if (ok[i]) poly.push(g.x(i).toFixed(1) + "," + g.y(v).toFixed(1)); });
        for (let i = D.length - 1; i >= 0; i--) if (ok[i]) poly.push(g.x(i).toFixed(1) + "," + g.y(D[i]).toFixed(1));
        if (poly.length > 3) sv("polygon", { points: poly.join(" "), class: "ct-boll-fill", style: "fill:" + it.color }, body);
        [U, D].forEach(function (a) { const d = path(a); if (d) sv("path", { d: d, class: "ct-boll", style: st }, body); });
        const dm = path(Mm); if (dm) sv("path", { d: dm, class: "ct-boll ct-boll-mid", style: "stroke:" + it.color }, body);
      } else if (it.type === "vwap") {
        if (!hasVol()) { notes.push("VWAP: у цьому ряді немає обсягу торгів"); return; }
        const r = computed(it);
        if (r.unavailable) { notes.push("VWAP (" + (p.session === "week" ? "тиждень" : "день") + " UTC) недоступний на цьому масштабі: свічка не коротша за сесію"); return; }
        let anyPartial = false;
        segments(r.vwap, r.ids, r.partial, vw, g).forEach(function (sg) {
          anyPartial = anyPartial || sg.partial;
          sv("path", { d: sg.d, class: "ct-vwap" + (sg.partial ? " ct-vwap-partial" : ""), style: st + (sg.partial ? ";stroke-dasharray:3 3;opacity:.6" : "") }, body);
        });
        if (anyPartial) notes.push("VWAP: початок сесії не завантажено, пунктир — неповна сесія (менш достовірно)");
      }
    });
    const y0 = MT + 14 + (g.mode !== "lin" ? 14 : 0);
    notes.forEach(function (t, k) { sv("text", { x: ML + 8, y: y0 + k * 14, class: "ct-pct-base" }, ui.svg).textContent = t; });
  }

  function subFrame(sp, g, title, ticks) {                                    // рамка підпанелі, заголовок і підписи осі
    sv("rect", { x: ML, y: sp.top, width: g.plotW, height: sp.h, class: "ct-rsi-bg" }, ui.svg);
    sv("text", { x: ML + 6, y: sp.top + 13, class: "ct-rsi-t" }, ui.svg).textContent = title;
    ticks.forEach(function (tk) { sv("text", { x: W - MR + 6, y: tk.y + 4, class: "ct-axis" }, ui.svg).textContent = tk.label; });
  }
  function drawRSI(sp, g, vw, gi) {
    const it = sp.it, arr = computed(it), top = sp.top, hh = sp.h, Y = function (v) { return top + (100 - v) / 100 * hh; }, R = arr.slice(vw.start, vw.end);
    const lv = arr[gi];
    subFrame(sp, g, ChartLayout.title(it) + (lv !== null && lv !== undefined ? "  " + lv.toLocaleString("uk-UA", { maximumFractionDigits: 1 }) : ""), [{ y: Y(30), label: "30" }, { y: Y(70), label: "70" }]);
    [30, 70].forEach(function (v) { sv("line", { x1: ML, x2: W - MR, y1: Y(v), y2: Y(v), class: "ct-rsi-ref" }, ui.svg); });
    let d = ""; R.forEach(function (v, i) { if (v !== null) d += (d ? "L" : "M") + g.x(i).toFixed(1) + " " + Y(v).toFixed(1); });
    if (d) sv("path", { d: d, class: "ct-rsi-line", style: "stroke:" + it.color + ";stroke-width:" + it.width, "clip-path": "url(#" + CLIP + ")" }, ui.svg);
  }
  // MACD: власна вертикальна шкала (діапазон за видимими значеннями, нуль завжди в межах), гістограма + лінія MACD + сигнальна лінія
  function drawMACD(sp, g, vw, gi) {
    const it = sp.it, m = computed(it), p = it.params, top = sp.top, hh = sp.h;
    const A = m.macd.slice(vw.start, vw.end), Sg = m.signal.slice(vw.start, vw.end), Hs = m.hist.slice(vw.start, vw.end);
    let lo = 0, hi = 0, any = false;
    [A, Sg, Hs].forEach(function (arr) { arr.forEach(function (v) { if (v !== null && v !== undefined) { any = true; if (v < lo) lo = v; if (v > hi) hi = v; } }); });
    if (!any) { subFrame(sp, g, ChartLayout.title(it) + ": замало даних (потрібно щонайменше " + (p.slow + p.signal - 1) + " свічок)", []); return; }
    if (hi - lo < 1e-12) { hi += 1e-9; lo -= 1e-9; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const Y = function (v) { return top + (hi - v) / (hi - lo) * hh; }, y0 = Y(0);
    const cur = m.macd[gi] === null || m.macd[gi] === undefined ? "" : "  MACD " + numFmt(m.macd[gi]) + "  сигнал " + numFmt(m.signal[gi]) + "  гіст. " + numFmt(m.hist[gi]);
    subFrame(sp, g, ChartLayout.title(it) + cur, [{ y: Y(hi - pad), label: numFmt(hi - pad) }, { y: y0, label: "0" }, { y: Y(lo + pad), label: numFmt(lo + pad) }]);
    sv("line", { x1: ML, x2: W - MR, y1: y0, y2: y0, class: "ct-rsi-ref" }, ui.svg);
    const bw = Math.max(1, Math.min(14, g.step * 0.7)), cg = sv("g", { "clip-path": "url(#" + CLIP + ")" }, ui.svg);
    Hs.forEach(function (v, i) {
      if (v === null || v === undefined) return;
      const y = Y(v);
      sv("rect", { x: g.x(i) - bw / 2, y: Math.min(y, y0), width: bw, height: Math.max(0.5, Math.abs(y - y0)), class: "ct-macd-h " + (v >= 0 ? "ct-up" : "ct-down") }, cg);
    });
    const line = function (arr) { let d = ""; arr.forEach(function (v, i) { if (v !== null && v !== undefined) d += (d ? "L" : "M") + g.x(i).toFixed(1) + " " + Y(v).toFixed(1); }); return d; };
    const d1 = line(A), d2 = line(Sg);
    if (d1) sv("path", { d: d1, class: "ct-macd-line", style: "stroke:" + it.color + ";stroke-width:" + it.width }, cg);
    if (d2) sv("path", { d: d2, class: "ct-macd-line", style: "stroke:" + (it.color2 || "#ff9800") + ";stroke-width:" + it.width }, cg);
  }

  // Картка даних свічки під час довгого натискання: дата й час, OHLC, обсяг, значення активних індикаторів (картка з боку, протилежного до пальця)
  function drawLpCard(g, vw, p, gi) {
    if (!p) return;
    const lines = [fmtDate(p.t, S.intraday || isLive())];
    if (p.o !== undefined) { lines.push("Відкр. " + FP(p.o) + "  Макс " + FP(p.h)); lines.push("Мін " + FP(p.l) + "  Закр. " + FP(p.c)); } else lines.push("Значення " + FP(p.c));
    if (p.v !== undefined) lines.push("Об'єм " + fmtV(p.v));
    let n = 0;
    S.layout.items.forEach(function (it) {
      if (!it.visible || it.type === "vol" || n >= 6) return;
      const v = indValue(it, gi, true); if (!v) return;
      lines.push(ChartLayout.label(it) + " " + v); n++;
    });
    const w = Math.min(g.plotW - 12, Math.max.apply(null, lines.map(function (t) { return t.length; })) * 6.6 + 16), h = lines.length * 15 + 8;
    const x = g.x(S.hover.i), left = x > ML + g.plotW / 2;
    const bx = left ? ML + 6 : W - MR - w - 6, by = MT + 6;
    sv("rect", { x: bx, y: by, width: w, height: h, rx: 6, class: "ct-lp-bg" }, ui.svg);
    lines.forEach(function (t, i) { sv("text", { x: bx + 8, y: by + 17 + i * 15, class: "ct-lp-t" }, ui.svg).textContent = t; });
  }

  // ---------- Панель керування індикаторами ----------
  function renderIndChips() {
    ui.inds.replaceChildren();
    S.layout.items.forEach(function (it) {
      if (it.type === "vol" && !hasVol()) return;
      const needVol = it.type === "vwap" && !hasVol();
      const b = btn(ui.inds, ChartLayout.label(it), { active: it.visible && !needVol, pressed: it.visible, help: ChartLayout.title(it) + ". Натисніть, щоб показати чи сховати" + (needVol ? ". Потрібні дані про обсяг" : ""),
        onClick: function () { ChartLayout.update(S.layout, it.id, { visible: !it.visible }); afterLayoutChange(!ui.ipanel.hidden); } });
      b.style.setProperty("--ma", it.color);
      b.setAttribute("data-ind", it.id);
      if (needVol) b.disabled = true;
    });
    const gear = btn(ui.inds, "⚙ Індикатори", { active: !ui.ipanel.hidden, pressed: !ui.ipanel.hidden, help: "Додати, налаштувати, сховати чи видалити індикатори: періоди, кольори, товщина ліній", onClick: function () { ui.ipanel.hidden = !ui.ipanel.hidden; if (!ui.ipanel.hidden) renderIndPanel(); renderIndChips(); } });
    gear.classList.add("ct-gear");
  }
  function renderIndPanel() {
    const box = ui.ipanel; box.replaceChildren(); ui.ivals = {};
    if (!S) return;
    const head = el("div", "ct-ip-head");
    head.appendChild(el("b", "", "Індикатори"));
    const close = el("button", "ct-btn", "✕"); close.type = "button"; close.setAttribute("aria-label", "Закрити панель індикаторів");
    close.addEventListener("click", function () { box.hidden = true; renderIndChips(); });
    head.appendChild(close); box.appendChild(head);
    // додавання
    const addRow = el("div", "ct-ip-add"), sel = document.createElement("select"); sel.setAttribute("aria-label", "Тип індикатора");
    Object.keys(ChartLayout.TYPES).filter(function (t) { return t !== "vol"; }).forEach(function (t) { const o = el("option", "", ChartLayout.TYPES[t].name); o.value = t; o.disabled = !ChartLayout.canAdd(S.layout, t); sel.appendChild(o); });
    const first = Array.prototype.find.call(sel.options, function (o) { return !o.disabled; }); if (first) sel.value = first.value;
    const addBtn = el("button", "ct-btn", "＋ Додати"); addBtn.type = "button";
    addBtn.addEventListener("click", function () { if (ChartLayout.add(S.layout, sel.value)) afterLayoutChange(true); });
    addRow.appendChild(sel); addRow.appendChild(addBtn); box.appendChild(addRow);
    // список
    S.layout.items.forEach(function (it) {
      const T = ChartLayout.TYPES[it.type], row = el("div", "ct-irow" + (it.visible ? "" : " off"));
      row.setAttribute("data-ind", it.id);
      const eye = el("button", "ct-btn ct-ieye", it.visible ? "●" : "○"); eye.type = "button"; eye.setAttribute("aria-pressed", it.visible ? "true" : "false"); eye.setAttribute("aria-label", (it.visible ? "Сховати " : "Показати ") + ChartLayout.title(it));
      eye.style.color = it.color;
      eye.addEventListener("click", function () { ChartLayout.update(S.layout, it.id, { visible: !it.visible }); afterLayoutChange(true); });
      row.appendChild(eye);
      row.appendChild(el("span", "ct-iname", ChartLayout.title(it)));
      const val = el("span", "ct-ival", ""); ui.ivals[it.id] = val; row.appendChild(val);
      const ctr = el("div", "ct-ictl");
      Object.keys(T.params).forEach(function (k) {
        const d = T.params[k], lab = el("label", "ct-ipar"); lab.appendChild(el("span", "", d.label));
        let inp;
        if (d.options) { inp = document.createElement("select"); d.options.forEach(function (o) { const op = el("option", "", o[1]); op.value = o[0]; inp.appendChild(op); }); inp.value = it.params[k]; }
        else { inp = document.createElement("input"); inp.type = "number"; inp.min = d.min; inp.max = d.max; inp.step = d.step || 1; inp.value = it.params[k]; }
        inp.setAttribute("aria-label", ChartLayout.label(it) + ": " + d.label);
        inp.addEventListener("change", function () { const patch = {}; patch[k] = d.options ? inp.value : parseFloat(inp.value); ChartLayout.update(S.layout, it.id, { params: patch }); afterLayoutChange(true); });
        lab.appendChild(inp); ctr.appendChild(lab);
      });
      const col = function (field, titleText) {
        const c = document.createElement("input"); c.type = "color"; c.value = it[field]; c.title = titleText; c.setAttribute("aria-label", titleText + ": " + ChartLayout.label(it));
        c.addEventListener("input", function () { const patch = {}; patch[field] = c.value; ChartLayout.update(S.layout, it.id, patch); if (field === "color") eye.style.color = c.value; schedule(); });
        c.addEventListener("change", function () { afterLayoutChange(false); });
        return c;
      };
      if (it.type !== "vol") { ctr.appendChild(col("color", it.type === "macd" ? "Колір лінії MACD" : "Колір")); if (it.color2) ctr.appendChild(col("color2", "Колір сигнальної лінії")); }
      if (it.type !== "vol") {
        const w = document.createElement("select"); w.title = "Товщина лінії"; w.setAttribute("aria-label", "Товщина лінії: " + ChartLayout.label(it));
        [1, 1.5, 2, 3, 4].forEach(function (x) { const o = el("option", "", x + " px"); o.value = x; w.appendChild(o); });
        w.value = String([1, 1.5, 2, 3, 4].reduce(function (b, x) { return Math.abs(x - it.width) < Math.abs(b - it.width) ? x : b; }, 1.5));
        w.addEventListener("change", function () { ChartLayout.update(S.layout, it.id, { width: parseFloat(w.value) }); afterLayoutChange(false); });
        ctr.appendChild(w);
        const del = el("button", "ct-btn ct-idel", "✕"); del.type = "button"; del.setAttribute("aria-label", "Видалити індикатор " + ChartLayout.title(it)); del.title = "Видалити";
        del.addEventListener("click", function () { ChartLayout.remove(S.layout, it.id); afterLayoutChange(true); });
        ctr.appendChild(del);
      }
      row.appendChild(ctr); box.appendChild(row);
    });
    box.appendChild(el("p", "ct-ip-note", "Налаштування зберігаються в цьому браузері. VWAP рахується по сесії UTC (доба або тиждень) і потребує обсягу; RSI і MACD показуються в окремих панелях під графіком."));
    schedule();
  }

  function stat(k, v) {
    const d = el("div", "ct-stat");
    d.appendChild(el("span", "ct-k", k));
    d.appendChild(el("b", "", v));
    return d;
  }

  // Рядок над графіком у стилі Binance: показники свічки під курсором і значення MA
  function legend(p, gi, hovered) {
    const box = ui.legend, prevClose = gi > 0 ? S.all[gi - 1].c : p.o !== undefined ? p.o : p.c;
    box.replaceChildren();
    const up = p.o !== undefined ? p.c >= p.o : p.c >= prevClose, cls = up ? "ct-upc" : "ct-downc";
    box.appendChild(el("span", "ct-lt", fmtDate(p.t, S.intraday || isLive())));
    if (p.o !== undefined) {
      [["Відкр.", p.o], ["Макс", p.h], ["Мін", p.l], ["Закр.", p.c]].forEach(function (x) {
        box.appendChild(el("span", "ct-lk", x[0] + " "));
        box.appendChild(el("span", cls, FP(x[1])));
      });
      box.appendChild(el("span", "ct-lk", "Зміна "));
      box.appendChild(el("span", cls, fmtPct(100 * (p.c / p.o - 1))));
    } else {
      box.appendChild(el("span", "ct-lk", "Значення "));
      box.appendChild(el("span", cls, FP(p.c)));
    }
    S.layout.items.forEach(function (it) {
      if (!it.visible || it.type === "vol") return;
      const v = indValue(it, gi, true);
      if (!v) return;
      const sp = el("span", "ct-ma-leg", ChartLayout.label(it) + " " + v);
      sp.style.color = it.color;
      box.appendChild(sp);
    });
    if (hovered && S.hover) box.appendChild(el("span", "ct-lk", "курсор " + FP(S.hover.price)));
  }

  function ruler(svg, body, g, vw, a, b) {
    const xa = g.x(a.gi - vw.start), ya = g.y(a.price), xb = g.x(b.gi - vw.start), yb = g.y(b.price);
    const d = b.price - a.price, pc = 100 * d / a.price, up = d >= 0;
    sv("rect", { x: Math.min(xa, xb), y: Math.min(ya, yb), width: Math.abs(xb - xa), height: Math.abs(yb - ya), class: "ct-ruler-box " + (up ? "up" : "down") }, body);
    sv("line", { x1: xa, y1: ya, x2: xb, y2: yb, class: "ct-ruler-line" }, body);
    sv("circle", { cx: xa, cy: ya, r: 4.5, class: "ct-ruler-dot" }, body);
    sv("circle", { cx: xb, cy: yb, r: 4.5, class: "ct-ruler-dot" }, body);
    const bars = Math.abs(b.gi - a.gi);
    const span = a.t !== null && a.t !== undefined && b.t !== null && b.t !== undefined ? fmtSpan(Math.abs(b.t - a.t)) : bars + " точок";
    const txt = (d >= 0 ? "+" : "") + FP(d) + " (" + fmtPct(pc) + ") · " + bars + " свічок · " + span;
    const w = txt.length * 6.4 + 14, lx = clamp((xa + xb) / 2 - w / 2, ML, W - MR - w), ly = clamp(Math.min(ya, yb) - 28, MT + 2, MT + g.priceH - 22);
    sv("rect", { x: lx, y: ly, width: w, height: 20, rx: 4, class: "ct-ruler-label-bg" }, svg);
    sv("text", { x: lx + 7, y: ly + 14, class: "ct-ruler-label" }, svg).textContent = txt;
  }

  // ---------- Список ліній ----------
  function renderLines(quiet) {
    const sig = S.h.length + "/" + S.l.length + "/" + S.f.length + "/" + S.lv + "/" + (S.sel || "");
    if (quiet && ui.list.dataset.n === sig && S.all.length) {
      const last = S.all[S.all.length - 1].c;
      ui.list.querySelectorAll("[data-price]").forEach(function (n) {
        const ch = 100 * (last / parseFloat(n.dataset.price) - 1);
        n.textContent = fmtPct(ch) + " до поточної ціни";
        n.className = "ct-pl " + (ch >= 0 ? "ct-upc" : "ct-downc");
      });
      return;
    }
    ui.list.dataset.n = sig;
    ui.list.replaceChildren();
    if (!S.h.length && !S.l.length && !S.f.length) return;
    ui.list.appendChild(el("h3", "ct-list-title", "Ваші лінії"));
    const ul = el("ul", "ct-mlist");
    S.h.forEach(function (m, idx) {
      const li = el("li");
      li.appendChild(el("b", "", (m.locked ? "🔒 " : "") + "Горизонтальна " + FP(m.price)));
      if (m.t) li.appendChild(el("span", "ct-lk", " · " + fmtDate(m.t, true)));
      const ch = el("span"); ch.dataset.price = String(m.price);
      li.appendChild(document.createTextNode(" ")); li.appendChild(ch);
      li.appendChild(del("горизонтальну лінію " + FP(m.price), function () { removeObj("h", m); }, m.locked));
      ul.appendChild(li);
    });
    S.l.forEach(function (ln, idx) {
      const li = el("li");
      const d = ln.b.price - ln.a.price;
      li.appendChild(el("b", "", (ln.locked ? "🔒 " : "") + "Тренд " + FP(ln.a.price) + " → " + FP(ln.b.price)));
      li.appendChild(el("span", ln.b.price >= ln.a.price ? "ct-pl ct-upc" : "ct-pl ct-downc", " " + fmtPct(100 * d / ln.a.price)));
      li.appendChild(del("лінію тренду", function () { removeObj("l", ln); }, ln.locked));
      ul.appendChild(li);
    });
    S.f.forEach(function (fb, idx) {
      const li = el("li");
      li.appendChild(el("b", "", (fb.locked ? "🔒 " : "") + "Фібоначчі " + FP(fb.a.price) + " → " + FP(fb.b.price)));
      li.appendChild(del("рівні Фібоначчі", function () { removeObj("f", fb); }, fb.locked));
      ul.appendChild(li);
    });
    ui.list.appendChild(ul);
    const clear = el("button", "ct-btn", "Очистити всі");
    clear.type = "button";
    clear.setAttribute("data-help", "Видалити всі малюнки цієї монети, крім заблокованих (їх спершу розблокуйте). Дію можна скасувати Ctrl+Z");
    clear.addEventListener("click", function () { mutate(function () { ["h", "l", "f"].forEach(function (k) { S[k] = S[k].filter(function (o) { return o.locked; }); }); if (S.sel && !findSel()) S.sel = null; }); });
    ui.list.appendChild(clear);
    if (S.all.length) renderLines(true);
  }

  function removeObj(kind, o) { mutate(function () { S[kind] = S[kind].filter(function (x) { return x !== o; }); if (S.sel === o.id) S.sel = null; }); }
  function del(what, fn, locked) {
    const b = el("button", "ct-del", "Видалити");
    b.type = "button";
    if (locked) { b.disabled = true; b.title = "Малюнок заблоковано: спершу розблокуйте"; }
    b.setAttribute("aria-label", "Видалити " + what);
    b.setAttribute("data-help", "Видалити " + what + " з графіка");
    b.addEventListener("click", fn);
    return b;
  }

  // ---------- Набір індикаторів: завантаження й збереження ----------
  // Окремі набори: "main" (звичайні графіки), "alt" (графіки, де сторінка сама задала індикатори, наприклад пояснення угод), "series" (ряди без свічок).
  // Набір спільний для всіх активів одного типу графіків і не залежить від монети; пошкоджені дані в localStorage ігноруються.
  function openLayout(spec) {
    const key = !spec.symbol ? "series" : spec.ind ? "alt" : "main";
    let layout = null;
    try { layout = ChartLayout.parse(localStorage.getItem("ct2:ind:" + key)); } catch (e) { layout = null; }
    if (!layout) layout = ChartLayout.defaults(!spec.symbol ? { ma7: false, ma25: false, ma50: false, ma99: false, boll: false, rsi: false, vol: false } : spec.ind);
    return { key: key, layout: layout };
  }
  function saveLayout() { try { localStorage.setItem("ct2:ind:" + S.layoutKey, ChartLayout.serialize(S.layout)); } catch (e) { /* без збереження: набір діє до закриття графіка */ } }
  function afterLayoutChange(rebuildPanel) { saveLayout(); renderBar(); if (rebuildPanel) renderIndPanel(); schedule(); }

  // ---------- Відкриття ----------
  // spec: { symbol, name, fallback } для монети з біржі; або { id, title, points: [{t, c}], format, source } для ряду даних
  function open(spec) {
    if (!dlg) build();
    teardown();
    const fi = spec.interval ? FRAMES.findIndex(function (f) { return f.id === spec.interval; }) : -1;
    const LAY = openLayout(spec);
    S = { spec: spec, all: [], n: DEFAULT_BARS, off: 0, type: "candles", frame: fi >= 0 ? fi : DEFAULT_FRAME, tool: "cursor", h: [], l: [], f: [], sel: null, undo: [], redo: [], lv: 0,
          layout: LAY.layout, layoutKey: LAY.key, hover: null, mA: null, mB: null, pend: null, token: 0, ws: null,
          error: null, intraday: true, exchangeTime: 0, fallbackMode: false, scale: loadScaleMode(), vman: null, prec: null, ver: 0, cache: ChartIndicators.cache(), pager: null, noMore: false, loadingOlder: false, unsub: null, link: "idle" };
    const saved = loadLines(); S.h = saved.h; S.l = saved.l; S.f = saved.f;
    ui.title.textContent = spec.symbol ? spec.symbol + "/USDT" : spec.title;
    ui.sub.textContent = spec.symbol ? spec.name : (spec.subtitle || "");
    ui.list.dataset.n = "";
    renderProps();
    gestureHosts.add(cancelGestures); bindVisibility();
    if (spec.symbol) { renderBar(); loadLive(); }
    else {
      S.type = "line"; S.intraday = false;
      S.all = spec.points.map(function (p, i) { return { t: p.t === undefined ? null : p.t, c: p.c }; });
      S.n = S.all.length;
      renderBar();
    }
    startRO();
    if (!embed && !dlg.open) dlg.showModal();
    renderLines();
    schedule();
    if (!embed) ui.svg.focus({ preventScroll: true });
  }

  return { open: open, mount: function (h) { host = h; }, close: teardown, update: function (patch) { if (S) { Object.assign(S.spec, patch); schedule(); } } };
  }

  // Вікно (спільне для всіх клікабельних графіків) і необов'язковий вбудований графік на сторінці
  let shared = null, embedded = null;
  function openDialog(spec) {
    if (!shared) shared = create(false);
    shared.open(spec);
  }
  // Монети відкриваються у вбудованому графіку, якщо він є на сторінці (і прокручують до нього); решта — у вікні
  function open(spec) {
    if (embedded && spec.symbol) {
      embedded.open(spec);
      const box = embedded.host;
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    openDialog(spec);
  }
  // Окремий вбудований графік (не заміщує головний): для пояснення угод на сторінці «Симуляція»
  function mount(host, spec) {
    const inst = create(true);
    inst.mount(host);
    inst.host = host;
    inst.open(spec);
    return inst;
  }
  function embed(host, spec) {
    const inst = create(true);
    inst.mount(host);
    inst.host = host;
    embedded = inst;
    inst.open(spec);
    return inst;
  }

  // Робить елемент (рядок, діаграму) клікабельним: клік або Enter відкриває графік
  function bind(node, getSpec, label) {
    node.classList.add("ct-open");
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", label || "Відкрити графік");
    node.setAttribute("data-help", label || "Відкрити графік");
    node.addEventListener("click", function (e) { if (e.target.closest("a")) return; open(getSpec()); });
    node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(getSpec()); } });
    return node;
  }

  return { open: open, bind: bind, embed: embed, mount: mount, _sizeFor: sizeFor };
})();
