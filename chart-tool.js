// Інтерактивний графік у вікні в стилі біржі Binance: ChartTool.open({...}).
//  • Монета (symbol): свічки або лінія з біржі Binance, оновлюються в реальному часі (WebSocket), 7 масштабів часу.
//  • Будь-який ряд (points): той самий графік для даних віджетів (настрій, стейблкоїни, мережа тощо).
//  • Маніпуляції: колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути; індикатори MA(7/25/99) і об'єм;
//    інструменти: курсор, горизонтальна лінія (маркер), лінія тренду, лінійка (різниця ціни, відсоток, час).
//  • Лінії й маркери зберігаються в цьому браузері. Клавіатура: стрілки, + / −, Home, Enter, Esc.
// Потребує agent-ui.js (el). Усі тексти вставляються через textContent. Це інформація, а не фінансова порада.

const ChartTool = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const W = 860, H = 440, ML = 8, MR = 82, MT = 10, MB = 24, VOL_SHARE = 0.2, MIN_BARS = 15;
  const FRAMES = [
    { id: "1m", label: "1 хв", note: "хвилинні свічки", unit: "1 хвилину" }, { id: "5m", label: "5 хв", note: "5-хвилинні", unit: "5 хвилин" }, { id: "15m", label: "15 хв", note: "15-хвилинні", unit: "15 хвилин" },
    { id: "1h", label: "1 год", note: "годинні", unit: "1 годину" }, { id: "4h", label: "4 год", note: "4-годинні", unit: "4 години" }, { id: "1d", label: "1 день", note: "денні", unit: "1 день" },
    { id: "1w", label: "1 тиждень", note: "тижневі", unit: "1 тиждень" },
  ];
  const DEFAULT_FRAME = 3, LIMIT = 500, DEFAULT_BARS = 100;
  const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
  const MAS = [{ id: "ma7", n: 7, color: "#f0b90b" }, { id: "ma25", n: 25, color: "#cc7ee8" }, { id: "ma99", n: 99, color: "#4a9bf5" }];
  const TOOLS = [
    { id: "cursor", icon: "↖", label: "Курсор", hint: "Курсор: наведіть, щоб побачити ціну й час. Колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути." },
    { id: "hline", icon: "―", label: "Горизонтальна лінія", hint: "Горизонтальна лінія: натисніть на графік, щоб поставити маркер на цій ціні." },
    { id: "trend", icon: "⟋", label: "Лінія тренду", hint: "Лінія тренду: натисніть першу точку, потім другу. Esc скасовує." },
    { id: "ruler", icon: "↔", label: "Лінійка", hint: "Лінійка: натисніть першу точку, потім другу, щоб побачити різницю ціни, відсоток і час. Esc очищує вимір." },
  ];
  const MAX_LINES = 20;

  // Один екземпляр графіка: або вікно (dialog), або вбудований на сторінку (embed). Стан кожного окремий.
  function create(embed) {
  let dlg = null, S = null, ui = {}, raf = 0, drag = null, host = null, lastGood = null;
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
  function FP(v) { return S.spec.format ? S.spec.format(v) : fmtP(v, S.spec.unit); }
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
  function loadLines() {
    try {
      const d = JSON.parse(localStorage.getItem(storeKey()) || "{}");
      return { h: (d.h || []).filter(function (m) { return typeof m.price === "number"; }), l: (d.l || []).filter(function (x) { return x.a && x.b; }) };
    } catch (e) { return { h: [], l: [] }; }
  }
  function saveLines() { try { localStorage.setItem(storeKey(), JSON.stringify({ h: S.h, l: S.l })); } catch (e) { /* сховище недоступне: лінії живуть до закриття вікна */ } }

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
    close.addEventListener("click", function () { dlg.close(); });
    head.appendChild(title); head.appendChild(ui.price); head.appendChild(ui.stats); if (!embed) head.appendChild(close);
    dlg.appendChild(head);

    const bar = el("div", "ct-bar");
    ui.frames = el("div", "ct-group"); ui.frames.setAttribute("role", "group"); ui.frames.setAttribute("aria-label", "Масштаб часу");
    ui.types = el("div", "ct-group"); ui.types.setAttribute("role", "group"); ui.types.setAttribute("aria-label", "Вигляд графіка");
    ui.inds = el("div", "ct-group"); ui.inds.setAttribute("role", "group"); ui.inds.setAttribute("aria-label", "Індикатори");
    ui.zoom = el("div", "ct-group"); ui.zoom.setAttribute("role", "group"); ui.zoom.setAttribute("aria-label", "Масштаб і прокрутка");
    [ui.frames, ui.types, ui.inds, ui.zoom].forEach(function (g) { bar.appendChild(g); });
    dlg.appendChild(bar);

    ui.legend = el("p", "ct-legend");
    dlg.appendChild(ui.legend);

    const body = el("div", "ct-body");
    ui.tools = el("div", "ct-tools"); ui.tools.setAttribute("role", "group"); ui.tools.setAttribute("aria-label", "Інструменти малювання");
    body.appendChild(ui.tools);
    ui.svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "ct-svg", role: "application", tabindex: "0",
      "data-help": "Колесо миші — масштаб, перетягування — прокрутка, подвійний клік — скинути. Клавіатура: стрілки, + / −, Enter", "aria-label": "Інтерактивний графік. Стрілки вліво й вправо переміщують курсор, плюс і мінус змінюють масштаб, Enter ставить лінію або точку лінійки." });
    body.appendChild(ui.svg);
    dlg.appendChild(body);

    ui.hint = el("p", "ct-hint");
    dlg.appendChild(ui.hint);
    ui.list = el("div", "ct-lines");
    dlg.appendChild(ui.list);
    ui.foot = el("p", "ct-foot");
    dlg.appendChild(ui.foot);

    const svg = ui.svg;
    svg.addEventListener("pointerdown", function (e) {
      if (!S) return;
      drag = { x: e.clientX, off: S.off, moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    });
    svg.addEventListener("pointermove", function (e) {
      if (!S) return;
      if (drag) {
        const r = svg.getBoundingClientRect(), step = (W - ML - MR) / visibleCount() * r.width / W;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) { setOff(drag.off + Math.round(dx / step)); return; }
      }
      pointer(e);
    });
    svg.addEventListener("pointerup", function (e) {
      if (!S) { drag = null; return; }
      const wasClick = drag && !drag.moved;
      drag = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (wasClick) { pointer(e); act(); }
    });
    svg.addEventListener("pointerleave", function () { if (S && !drag) { S.hover = null; schedule(); } });
    svg.addEventListener("wheel", function (e) {
      if (!S) return;
      e.preventDefault();
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width;
      zoom(e.deltaY > 0 ? 1 : -1, clamp((x - ML) / (W - ML - MR), 0, 1));
    }, { passive: false });
    svg.addEventListener("dblclick", function () { resetView(); });
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
      else if (e.key === "Escape" && (S.mA || S.mB || S.pend)) { e.stopPropagation(); S.mA = S.mB = S.pend = null; schedule(); }
    });
    if (!embed) dlg.addEventListener("close", teardown);
    (embed ? host : document.body).appendChild(dlg);
  }

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

    ui.inds.replaceChildren();
    MAS.forEach(function (m) { btn(ui.inds, "MA" + m.n, { active: S.ind[m.id], pressed: S.ind[m.id], help: "Ковзна середня за " + m.n + " періодів: згладжує ціну й показує напрям тренду. Кольорова лінія на графіку", onClick: function () { S.ind[m.id] = !S.ind[m.id]; renderBar(); schedule(); } }).style.setProperty("--ma", m.color); });
    if (hasVol()) btn(ui.inds, "Об'єм", { active: S.ind.vol, pressed: S.ind.vol, help: "Об'єм торгів за кожну свічку: стовпчики внизу. Високий об'єм означає більший інтерес", onClick: function () { S.ind.vol = !S.ind.vol; renderBar(); schedule(); } });

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
    ui.hint.hidden = true;
  }

  // ---------- Дані ----------
  async function klines(sym, interval) {
    let err;
    for (let h = 0; h < HOSTS.length; h++) {
      try {
        const r = await fetch(HOSTS[h] + "/api/v3/klines?symbol=" + sym + "USDT&interval=" + interval + "&limit=" + LIMIT);
        if (r.ok) return await r.json();
        err = new Error("HTTP " + r.status);
      } catch (e) { err = e; }
    }
    throw err;
  }

  async function loadLive() {
    const f = FRAMES[S.frame], token = ++S.token;
    S.intraday = f.id !== "1d" && f.id !== "1w";
    ui.sub.textContent = S.spec.name + " · " + f.note + " · Binance";
    closeWs();
    try {
      const rows = await klines(S.spec.symbol, f.id);
      if (token !== S.token) return;
      S.all = rows.map(function (r) { return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }; });
      S.error = null; lastGood = { symbol: S.spec.symbol, name: S.spec.name };
      S.n = Math.min(DEFAULT_BARS, S.all.length); S.off = 0;
      connectWs(f.id, token);
    } catch (e) {
      if (S.spec.fallback && S.spec.fallback.length) {         // немає пари на біржі: показуємо ряд із віджета
        S.fallbackMode = true; S.intraday = false; S.type = "line";
        S.all = S.spec.fallback.map(function (p) { return { t: p.t, c: p.c }; });
        S.n = S.all.length; S.off = 0;
        ui.sub.textContent = S.spec.name + " · 7 днів · цієї монети немає на Binance, ряд із CoinGecko";
      } else {
        S.all = []; S.error = "Для цієї монети немає торгової пари на Binance, або біржа тимчасово недоступна.";
        if (embed && lastGood && lastGood.symbol !== S.spec.symbol) {       // вбудований графік повертається до попередньої монети
          const back = lastGood;
          setTimeout(function () { if (S && S.error) open(back); }, 2500);
        }
      }
    }
    renderBar(); renderLines(); schedule();
  }

  function closeWs() { if (S && S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch (e) { /* закрито */ } S.ws = null; } }

  function connectWs(interval, token) {
    try { S.ws = new WebSocket("wss://stream.binance.com:9443/ws/" + S.spec.symbol.toLowerCase() + "usdt@kline_" + interval); } catch (e) { return; }
    S.ws.onmessage = function (ev) {
      if (!S || token !== S.token) return;
      try {
        const m = JSON.parse(ev.data), k = m.k;
        const p = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
        const last = S.all[S.all.length - 1];
        if (last && last.t === p.t) S.all[S.all.length - 1] = p;
        else if (!last || p.t > last.t) { S.all.push(p); if (S.all.length > LIMIT + 50) S.all.shift(); }
        S.exchangeTime = m.E;
        schedule();
      } catch (e) { /* пошкоджене повідомлення */ }
    };
    S.ws.onclose = function () {
      if (S && S.token === token && isOpen()) setTimeout(function () { if (S && S.token === token && isOpen()) connectWs(interval, token); }, 4000);
    };
  }

  function teardown() { if (S) { S.token++; closeWs(); S = null; } drag = null; }

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
  function geo(pts) {
    const n = pts.length, plotW = W - ML - MR, plotH = H - MT - MB;
    const vol = S.ind.vol && hasVol(), volH = vol ? Math.round(plotH * VOL_SHARE) : 0, priceH = plotH - volH - (vol ? 8 : 0);
    let lo = Infinity, hi = -Infinity, vmax = 0;
    pts.forEach(function (p) {
      const a = S.type === "candles" && p.l !== undefined ? p.l : p.c, b = S.type === "candles" && p.h !== undefined ? p.h : p.c;
      if (a < lo) lo = a; if (b > hi) hi = b;
      if (p.v > vmax) vmax = p.v;
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12) { lo *= 0.99; hi *= 1.01; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const step = plotW / n;
    return {
      n: n, plotW: plotW, plotH: plotH, priceH: priceH, volH: volH, vol: vol, vmax: vmax, lo: lo, hi: hi, step: step,
      x: function (i) { return ML + (i + 0.5) * step; },
      y: function (v) { return MT + (hi - v) / (hi - lo) * priceH; },
      idx: function (x) { return clamp(Math.floor((x - ML) / step), 0, n - 1); },
      val: function (y) { return hi - (y - MT) / priceH * (hi - lo); },
    };
  }

  function pointer(e) {
    if (!S || !S.all.length) return;
    const r = ui.svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    const v = view(), g = geo(v.pts);
    if (x < ML || x > W - MR || y < MT || y > MT + g.priceH + (g.vol ? g.volH + 8 : 0)) { S.hover = null; schedule(); return; }
    S.hover = { i: g.idx(x), price: clamp(g.val(Math.min(y, MT + g.priceH)), g.lo, g.hi) };
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
    const vw = view(), pt = mkPoint(vw);
    if (S.tool === "hline") {
      if (S.h.length >= MAX_LINES) S.h.shift();
      S.h.push({ t: pt.t, price: pt.price });
      saveLines(); renderLines();
    } else if (S.tool === "trend") {
      if (!S.pend) S.pend = pt;
      else {
        if (S.l.length >= MAX_LINES) S.l.shift();
        S.l.push({ a: { t: S.pend.t, gi: S.pend.gi, price: S.pend.price }, b: { t: pt.t, gi: pt.gi, price: pt.price } });
        S.pend = null; saveLines(); renderLines();
      }
    } else if (S.tool === "ruler") {
      if (!S.mA || S.mB) { S.mA = pt; S.mB = null; } else { S.mB = pt; }
    }
    schedule();
  }

  // ---------- Малювання ----------
  // Таймер замість requestAnimationFrame: у закритій чи фоновій вкладці браузер не викликає анімаційні кадри, і графік не оновлювався б
  function schedule() { if (!raf) raf = setTimeout(function () { raf = 0; if (S) draw(); }, 30); }

  function sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function draw() {
    const svg = ui.svg;
    svg.replaceChildren();
    if (!S.all.length) {
      sv("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "ct-empty" }, svg).textContent = S.error || "Завантаження графіка…";
      ui.price.textContent = ""; ui.stats.textContent = ""; ui.legend.textContent = "";
      return;
    }
    const vw = view(), pts = vw.pts, g = geo(pts), last = S.all[S.all.length - 1];
    const prev = S.all.length > 1 ? S.all[S.all.length - 2] : last;
    const upNow = last.o !== undefined ? last.c >= last.o : last.c >= prev.c;
    const bottom = MT + g.priceH + (g.vol ? g.volH + 8 : 0);

    const defs = sv("defs", {}, svg);
    const clip = sv("clipPath", { id: "ctclip" }, defs);
    sv("rect", { x: ML, y: MT, width: g.plotW, height: bottom - MT }, clip);

    // сітка й вісь цін
    for (let k = 0; k <= 5; k++) {
      const v = g.lo + (g.hi - g.lo) * k / 5, y = g.y(v);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-grid" }, svg);
      if (Math.abs(y - g.y(last.c)) > 13) sv("text", { x: W - MR + 6, y: y + 4, class: "ct-axis" }, svg).textContent = FP(v);   // не перекриваємо мітку останньої ціни
    }
    // вісь часу
    for (let k = 0; k < 6; k++) {
      const i = Math.round((pts.length - 1) * k / 5), t = pts[i].t, x = g.x(i);
      sv("line", { x1: x, x2: x, y1: MT, y2: bottom, class: "ct-grid ct-vgrid" }, svg);
      sv("text", { x: x, y: H - 7, "text-anchor": k === 0 ? "start" : k === 5 ? "end" : "middle", class: "ct-axis" }, svg).textContent = fmtAxis(t);
    }

    const body = sv("g", { "clip-path": "url(#ctclip)" }, svg);
    // об'єм
    if (g.vol && g.vmax > 0) {
      pts.forEach(function (p, i) {
        const h = Math.max(1, p.v / g.vmax * g.volH), up = p.o !== undefined ? p.c >= p.o : true;
        sv("rect", { x: g.x(i) - Math.max(1, g.step * 0.35), y: bottom - h, width: Math.max(1, g.step * 0.7), height: h, class: "ct-vol " + (up ? "ct-up" : "ct-down") }, body);
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
    // ковзні середні (рахуємо по всьому ряду, показуємо видиму частину)
    const closes = S.all.map(function (p) { return p.c; });
    MAS.forEach(function (m) {
      if (!S.ind[m.id] || S.all.length < m.n) return;
      const arr = sma(closes, m.n).slice(vw.start, vw.end);
      let d = "";
      arr.forEach(function (v, i) { if (v !== null) d += (d ? "L" : "M") + g.x(i).toFixed(1) + " " + g.y(v).toFixed(1); });
      if (d) sv("path", { d: d, class: "ct-ma", style: "stroke:" + m.color }, body);
    });
    // горизонтальні лінії (маркери)
    S.h.forEach(function (m) {
      if (m.price < g.lo || m.price > g.hi) return;
      const y = g.y(m.price);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-hline" }, body);
      sv("rect", { x: W - MR + 1, y: y - 9, width: MR - 2, height: 18, rx: 3, class: "ct-hline-tag" }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "ct-hline-text" }, svg).textContent = FP(m.price);
    });
    // лінії тренду
    S.l.forEach(function (ln) {
      const a = idxOf(ln.a) - vw.start, b = idxOf(ln.b) - vw.start;
      sv("line", { x1: g.x(a), y1: g.y(ln.a.price), x2: g.x(b), y2: g.y(ln.b.price), class: "ct-trend" }, body);
      sv("circle", { cx: g.x(a), cy: g.y(ln.a.price), r: 3.5, class: "ct-trend-dot" }, body);
      sv("circle", { cx: g.x(b), cy: g.y(ln.b.price), r: 3.5, class: "ct-trend-dot" }, body);
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

    // остання ціна
    const yl = clamp(g.y(last.c), MT, MT + g.priceH);
    sv("line", { x1: ML, x2: W - MR, y1: yl, y2: yl, class: "ct-last" }, svg);
    sv("rect", { x: W - MR + 1, y: yl - 9, width: MR - 2, height: 18, rx: 3, class: "ct-tag " + (upNow ? "ct-up" : "ct-down") }, svg);
    sv("text", { x: W - MR + 6, y: yl + 4, class: "ct-tagtext" }, svg).textContent = FP(last.c);

    // перехрестя
    let readHtml = null;
    if (S.hover) {
      const h = S.hover, p = pts[h.i], x = g.x(h.i), y = g.y(h.price);
      sv("line", { x1: x, x2: x, y1: MT, y2: bottom, class: "ct-cross" }, svg);
      sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "ct-cross" }, svg);
      sv("rect", { x: W - MR + 1, y: y - 9, width: MR - 2, height: 18, rx: 3, class: "ct-crosstag" }, svg);
      sv("text", { x: W - MR + 6, y: y + 4, class: "ct-crosstext" }, svg).textContent = FP(h.price);
      const tt = fmtDate(p.t, S.intraday || isLive()), tw = tt.length * 6.4 + 12, tx = clamp(x - tw / 2, ML, W - MR - tw);
      sv("rect", { x: tx, y: H - MB + 2, width: tw, height: 18, rx: 3, class: "ct-crosstag" }, svg);
      sv("text", { x: tx + 6, y: H - MB + 15, class: "ct-crosstext" }, svg).textContent = tt;
      readHtml = p;
    }
    legend(readHtml || last, readHtml ? vw.start + S.hover.i : S.all.length - 1, readHtml);

    // шапка
    let hi = -Infinity, lo = Infinity, vs = 0;
    pts.forEach(function (p) { hi = Math.max(hi, p.h !== undefined ? p.h : p.c); lo = Math.min(lo, p.l !== undefined ? p.l : p.c); vs += p.v || 0; });
    const ch = 100 * (last.c / pts[0].c - 1);
    ui.price.replaceChildren(el("b", "ct-big " + (upNow ? "ct-upc" : "ct-downc"), FP(last.c)), el("span", ch >= 0 ? "ct-upc" : "ct-downc", fmtPct(ch) + " у вікні"));
    ui.stats.replaceChildren(stat("Макс", FP(hi)), stat("Мін", FP(lo)), hasVol() ? stat("Об'єм", fmtV(vs)) : stat("Точок", String(pts.length)));
    ui.foot.textContent = isLive()
      ? "Дані: біржа Binance" + (S.exchangeTime ? ", час біржі " + new Date(S.exchangeTime).toLocaleTimeString("uk-UA") : "") + ". Це інформація, а не фінансова порада."
      : (S.spec.source || "") + " Це інформація, а не фінансова порада.";
    renderLines(true);
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
    const closes = S.all.map(function (q) { return q.c; });
    MAS.forEach(function (m) {
      if (!S.ind[m.id] || S.all.length < m.n) return;
      const v = sma(closes, m.n)[gi];
      if (v === null || v === undefined) return;
      const s = el("span", "ct-ma-leg", "MA" + m.n + " " + FP(v));
      s.style.color = m.color;
      box.appendChild(s);
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
    const sig = S.h.length + "/" + S.l.length;
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
    if (!S.h.length && !S.l.length) return;
    ui.list.appendChild(el("h3", "ct-list-title", "Ваші лінії"));
    const ul = el("ul", "ct-mlist");
    S.h.forEach(function (m, idx) {
      const li = el("li");
      li.appendChild(el("b", "", "Горизонтальна " + FP(m.price)));
      if (m.t) li.appendChild(el("span", "ct-lk", " · " + fmtDate(m.t, true)));
      const ch = el("span"); ch.dataset.price = String(m.price);
      li.appendChild(document.createTextNode(" ")); li.appendChild(ch);
      li.appendChild(del("горизонтальну лінію " + FP(m.price), function () { S.h.splice(idx, 1); saveLines(); renderLines(); schedule(); }));
      ul.appendChild(li);
    });
    S.l.forEach(function (ln, idx) {
      const li = el("li");
      const d = ln.b.price - ln.a.price;
      li.appendChild(el("b", "", "Тренд " + FP(ln.a.price) + " → " + FP(ln.b.price)));
      li.appendChild(el("span", ln.b.price >= ln.a.price ? "ct-pl ct-upc" : "ct-pl ct-downc", " " + fmtPct(100 * d / ln.a.price)));
      li.appendChild(del("лінію тренду", function () { S.l.splice(idx, 1); saveLines(); renderLines(); schedule(); }));
      ul.appendChild(li);
    });
    ui.list.appendChild(ul);
    const clear = el("button", "ct-btn", "Очистити всі");
    clear.type = "button";
    clear.setAttribute("data-help", "Видалити всі горизонтальні лінії й лінії тренду для цієї монети");
    clear.addEventListener("click", function () { S.h = []; S.l = []; saveLines(); renderLines(); schedule(); });
    ui.list.appendChild(clear);
    if (S.all.length) renderLines(true);
  }

  function del(what, fn) {
    const b = el("button", "ct-del", "Видалити");
    b.type = "button";
    b.setAttribute("aria-label", "Видалити " + what);
    b.setAttribute("data-help", "Видалити " + what + " з графіка");
    b.addEventListener("click", fn);
    return b;
  }

  // ---------- Відкриття ----------
  // spec: { symbol, name, fallback } для монети з біржі; або { id, title, points: [{t, c}], format, source } для ряду даних
  function open(spec) {
    if (!dlg) build();
    teardown();
    S = { spec: spec, all: [], n: DEFAULT_BARS, off: 0, type: "candles", frame: DEFAULT_FRAME, tool: "cursor", h: [], l: [],
          ind: { ma7: true, ma25: true, ma99: false, vol: true }, hover: null, mA: null, mB: null, pend: null, token: 0, ws: null,
          error: null, intraday: true, exchangeTime: 0, fallbackMode: false };
    const saved = loadLines(); S.h = saved.h; S.l = saved.l;
    ui.title.textContent = spec.symbol ? spec.symbol + "/USDT" : spec.title;
    ui.sub.textContent = spec.symbol ? spec.name : (spec.subtitle || "");
    ui.list.dataset.n = "";
    if (spec.symbol) { renderBar(); loadLive(); }
    else {
      S.type = "line"; S.intraday = false;
      S.all = spec.points.map(function (p, i) { return { t: p.t === undefined ? null : p.t, c: p.c }; });
      S.n = S.all.length;
      S.ind.ma7 = S.ind.ma25 = false; S.ind.vol = false;
      renderBar();
    }
    if (!embed && !dlg.open) dlg.showModal();
    renderLines();
    schedule();
    if (!embed) ui.svg.focus({ preventScroll: true });
  }

  return { open: open, mount: function (h) { host = h; }, close: teardown };
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

  return { open: open, bind: bind, embed: embed };
})();
