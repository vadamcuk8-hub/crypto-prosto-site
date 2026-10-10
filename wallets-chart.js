// Головний порівняльний графік «Аналітики гаманців»: SVG без бібліотек. WalletsChart.create(host).set({...}).
// Малює лише передані точки (нічого не інтерполюється): сегменти ліній не з'єднуються через прогалини, прогалини позначені смугою «немає даних».
// Керування: колесо — масштаб, перетягування — прокрутка, двоклік/кнопка — скидання, дотик: один палець — прокрутка, два — масштаб, дотик — підказка.
// Усі тексти вставляються через textContent.

(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg", ML = 8, MR = 66, MT = 12, MB = 28;
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const STEPS = [MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

  function sv(tag, attrs, parent) { const n = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (parent) parent.appendChild(n); return n; }
  function div(cls, text) { const d = document.createElement("div"); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function nf(v, d) { return v.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }); }

  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { ticks: out, step: step };
  }
  function logTicks(lo, hi) {                                              // lo, hi — значення (не логарифми); позначки 1·2·5 × 10^k
    const out = [];
    for (let k = Math.floor(Math.log10(lo)) - 1; k <= Math.ceil(Math.log10(hi)); k++) [1, 2, 5].forEach(function (m) { const v = m * Math.pow(10, k); if (v >= lo && v <= hi) out.push(v); });
    return out;
  }
  function fmtTime(t, span) {
    const d = new Date(t), two = function (x) { return (x < 10 ? "0" : "") + x; };
    if (span <= 36 * HOUR) return two(d.getHours()) + ":" + two(d.getMinutes());
    if (span <= 4 * DAY) return two(d.getDate()) + "." + two(d.getMonth() + 1) + " " + two(d.getHours()) + ":00";
    return two(d.getDate()) + "." + two(d.getMonth() + 1);
  }
  function fullTime(t, daily) { return new Date(t).toLocaleString("uk-UA", daily ? { day: "2-digit", month: "2-digit", year: "numeric" } : { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }

  function create(host, opts) {
    opts = opts || {};
    host.classList.add("wl-chart");
    const svg = sv("svg", { class: "wl-svg", role: "img", tabindex: "0" }), tip = div("wl-tip"), msg = div("wl-empty");
    tip.hidden = true; msg.hidden = true;
    host.appendChild(svg); host.appendChild(tip); host.appendChild(msg);
    const uid = "wlclip" + Math.floor(Math.random() * 1e9);
    let data = null, view = null, hover = null, W = 900, H = 440, timer = 0, ro = null, destroyed = false;
    const ptrs = new Map();
    let drag = null, pinch = null;

    // ---------- геометрія ----------
    function domain() { const d = data.domain; return d.t1 > d.t0 ? [d.t0, d.t1] : [d.t0 - HOUR, d.t0 + HOUR]; }
    function cur() { return view || domain(); }
    function plotW() { return W - ML - MR; }
    function xOf(t, v) { return ML + (t - v[0]) / (v[1] - v[0]) * plotW(); }
    function tOf(x, v) { return v[0] + (x - ML) / plotW() * (v[1] - v[0]); }
    function sizeFor(w) { return { w: Math.max(260, Math.round(w)), h: w < 560 ? Math.max(280, Math.round(w * 0.85)) : Math.max(340, Math.min(560, Math.round(w * 0.46))) }; }
    function applySize(w) {
      if (!w || w < 50) return;
      const s = sizeFor(w);
      if (s.w === W && s.h === H) return;
      W = s.w; H = s.h; svg.setAttribute("viewBox", "0 0 " + W + " " + H); schedule();
    }
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    // ---------- відображення ----------
    function visibleSeries() { return data.series.filter(function (s) { return s.visible; }); }
    function schedule() { if (!timer && !destroyed) timer = setTimeout(function () { timer = 0; draw(); }, 16); }
    function flush() { if (timer) { clearTimeout(timer); timer = 0; } draw(); }

    function draw() {
      svg.replaceChildren();
      tip.hidden = true;
      if (!data) return;
      const vis = visibleSeries(), v = cur(), log = data.unit === "log";
      svg.setAttribute("aria-label", data.caption || "Порівняльний графік гаманців");
      const inView = [];
      vis.forEach(function (s) { s.segments.forEach(function (seg) { seg.forEach(function (p) { if (p.t >= v[0] && p.t <= v[1]) inView.push(p.v); }); }); });
      msg.hidden = !!inView.length;
      msg.textContent = inView.length ? "" : (data.emptyText || "Немає історичних даних за цей період");
      if (!inView.length) return;
      let lo = Math.min.apply(null, inView), hi = Math.max.apply(null, inView);
      if (log) { lo = Math.log(lo); hi = Math.log(hi); }
      if (hi - lo < (log ? 1e-4 : (data.unit === "pct" ? 0.05 : Math.max(1e-6, Math.abs(hi) * 0.0005)))) { const m = (hi + lo) / 2, e = log ? 5e-5 : (data.unit === "pct" ? 0.03 : Math.max(5e-7, Math.abs(hi) * 0.00025)); lo = m - e; hi = m + e; }
      const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
      const ph = H - MT - MB, yOf = function (val) { const a = log ? Math.log(val) : val; return MT + (hi - a) / (hi - lo) * ph; };
      const defs = sv("defs", {}, svg), cp = sv("clipPath", { id: uid }, defs); sv("rect", { x: ML, y: MT, width: plotW(), height: ph }, cp);
      const pat = sv("pattern", { id: uid + "h", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs); sv("rect", { width: 8, height: 8, fill: "rgba(154,164,178,.06)" }, pat); sv("line", { x1: 0, y1: 0, x2: 0, y2: 8, stroke: "rgba(154,164,178,.28)", "stroke-width": 1.2 }, pat);

      const tagYs = [];                                                       // позначки останніх значень: підписи осі під ними не малюємо, щоб не накладались
      vis.forEach(function (s) { const ls = s.segments[s.segments.length - 1], lp = ls && ls[ls.length - 1]; if (lp && lp.t >= v[0] && lp.t <= v[1]) tagYs.push(yOf(lp.v)); });
      // сітка й осі
      let ticks, step = 1, fmtY;
      if (log) { const t = logTicks(Math.exp(lo), Math.exp(hi)); ticks = t.length >= 2 ? t : niceTicks(Math.exp(lo), Math.exp(hi), 4).ticks; fmtY = function (x) { return (x >= 100 ? nf(x, 0) : x >= 1 ? nf(x, 2) : nf(x, 4)) + " $"; }; }
      else { const t = niceTicks(lo, hi, H < 340 ? 4 : 6); ticks = t.ticks; step = t.step; const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9))); fmtY = function (x) { return data.unit === "pct" ? nf(x, Math.max(1, d)) + "%" : nf(x, d) + " $"; }; }
      ticks.forEach(function (tv) {
        const y = yOf(tv); if (y < MT - 1 || y > MT + ph + 1) return;
        sv("line", { x1: ML, x2: W - MR, y1: y, y2: y, class: "wl-grid" }, svg);
        if (!tagYs.some(function (ty) { return Math.abs(ty - y) < 14; })) sv("text", { x: W - MR + 6, y: y + 4, class: "wl-axis" }, svg).textContent = fmtY(tv);
      });
      if (data.unit === "pct" && lo < 0 && hi > 0) { const y0 = yOf(0); sv("line", { x1: ML, x2: W - MR, y1: y0, y2: y0, class: "wl-zero" }, svg); sv("text", { x: ML + 6, y: y0 - 4, class: "wl-zero-t" }, svg).textContent = "0% = початковий депозит"; }
      // вісь часу
      const span = v[1] - v[0];
      if (data.daily) {
        const days = []; vis.forEach(function (s) { s.segments.forEach(function (seg) { seg.forEach(function (p) { if (p.t >= v[0] && p.t <= v[1] && days.indexOf(p.t) < 0) days.push(p.t); }); }); }); days.sort(function (a, b) { return a - b; });
        const every = Math.max(1, Math.ceil(days.length / (W < 480 ? 4 : 8)));
        days.forEach(function (t, i) { if (i % every) return; const x = xOf(t, v); sv("line", { x1: x, x2: x, y1: MT, y2: MT + ph, class: "wl-grid wl-vgrid" }, svg); sv("text", { x: x, y: H - 8, "text-anchor": "middle", class: "wl-axis" }, svg).textContent = fmtTime(t, 10 * DAY); });
      } else {
        const want = W < 480 ? 3 : 6, st = STEPS.filter(function (s) { return span / s <= want * 1.6; })[0] || STEPS[STEPS.length - 1];
        for (let t = Math.ceil(v[0] / st) * st; t <= v[1]; t += st) { const x = xOf(t, v); sv("line", { x1: x, x2: x, y1: MT, y2: MT + ph, class: "wl-grid wl-vgrid" }, svg); sv("text", { x: x, y: H - 8, "text-anchor": "middle", class: "wl-axis" }, svg).textContent = fmtTime(t, span); }
      }

      const body = sv("g", { "clip-path": "url(#" + uid + ")" }, svg);
      // прогалини: до початку даних і між сегментами; лінії через них не з'єднуються
      const firsts = vis.map(function (s) { return s.segments.length ? s.segments[0][0].t : null; }).filter(function (x) { return x !== null; });
      const bands = [];
      if (!data.daily && firsts.length && Math.min.apply(null, firsts) > v[0] + span * 0.03 && data.showLeadGap !== false) bands.push([v[0], Math.min.apply(null, firsts), "Немає даних: початок історії"]);
      vis.forEach(function (s) { (s.gaps || []).forEach(function (g) { if (g.b >= v[0] && g.a <= v[1] && !bands.some(function (b) { return Math.abs(b[0] - g.a) < 1 && Math.abs(b[1] - g.b) < 1; })) bands.push([g.a, g.b, "Немає даних"]); }); });
      bands.forEach(function (b) {
        const x0 = clamp(xOf(b[0], v), ML, W - MR), x1 = clamp(xOf(b[1], v), ML, W - MR);
        if (x1 - x0 < 1) return;
        sv("rect", { x: x0, y: MT, width: x1 - x0, height: ph, fill: "url(#" + uid + "h)", class: "wl-gap" }, body);
        if (x1 - x0 > 80) sv("text", { x: (x0 + x1) / 2, y: MT + 16, "text-anchor": "middle", class: "wl-gap-t" }, body).textContent = b[2];
      });
      if (data.roundStart && data.roundStart >= v[0] && data.roundStart <= v[1]) { const x = xOf(data.roundStart, v); sv("line", { x1: x, x2: x, y1: MT, y2: MT + ph, class: "wl-round" }, body); sv("text", { x: x + 4, y: MT + ph - 6, class: "wl-round-t" }, body).textContent = "Початок раунду"; }

      // лінії
      const tags = [];
      vis.forEach(function (s) {
        const dim = data.focus && data.focus !== s.cap;
        s.segments.forEach(function (seg) {
          const pts = seg.filter(function (p) { return p.t >= v[0] - span && p.t <= v[1] + span; });          // трохи за краєм, щоб лінія входила в область
          if (!pts.length) return;
          if (pts.length > 1) {
            let d = ""; pts.forEach(function (p, i) { d += (i ? "L" : "M") + xOf(p.t, v).toFixed(1) + " " + yOf(p.v).toFixed(1); });
            sv("path", { d: d, class: "wl-line", "data-cap": s.cap, stroke: s.color, opacity: dim ? 0.3 : 1 }, body);
          }
          if (pts.length === 1 || data.daily || pts.length < 3) pts.forEach(function (p) { if (p.t >= v[0] && p.t <= v[1]) sv("circle", { cx: xOf(p.t, v), cy: yOf(p.v), r: data.daily ? 3.6 : 3, fill: s.color, class: "wl-dot", "data-cap": s.cap, opacity: dim ? 0.3 : 1 }, body); });
        });
        const lastSeg = s.segments[s.segments.length - 1], last = lastSeg && lastSeg[lastSeg.length - 1];
        if (last && last.t >= v[0] && last.t <= v[1]) tags.push({ y: yOf(last.v), s: s, v: last.v });
      });
      tags.sort(function (a, b) { return a.y - b.y; });
      for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 17) tags[i].y = tags[i - 1].y + 17;       // підписи останніх значень не накладаються
      tags.forEach(function (t) {
        sv("rect", { x: W - MR + 1, y: t.y - 9, width: MR - 3, height: 18, rx: 3, fill: t.s.color, class: "wl-tag" }, svg);
        sv("text", { x: W - MR + 5, y: t.y + 4, class: "wl-tag-t" }, svg).textContent = data.unit === "pct" ? nf(t.v, 2) + "%" : nf(t.v, t.v >= 100 ? 0 : 2);
      });

      // курсор і підказка
      if (hover !== null && hover >= v[0] && hover <= v[1]) {
        const x = xOf(hover, v);
        sv("line", { x1: x, x2: x, y1: MT, y2: MT + ph, class: "wl-cross" }, svg);
        tip.replaceChildren();
        tip.appendChild(div("wl-tip-time", fullTime(hover, data.daily)));
        const tol = data.daily ? 1 : 5 * MIN;
        vis.forEach(function (s) {
          const p = nearest(s, hover);
          const row = div("wl-tip-row"), dot = document.createElement("i"); dot.style.background = s.color; row.appendChild(dot);
          row.appendChild(div("wl-tip-n", s.label));
          if (p && Math.abs(p.t - hover) <= tol) {
            const usd = s.cap * p.eq, pc = (p.eq - 1) * 100;
            row.appendChild(div("wl-tip-v", (s.cond ? "≈ " : "") + nf(usd, 2) + " $ · " + (pc >= 0 ? "+" : "−") + nf(Math.abs(pc), 2) + "%"));
            sv("circle", { cx: x, cy: yOf(p.v), r: 4.5, fill: s.color, stroke: "#0B0E11", "stroke-width": 1.5 }, svg);
          } else row.appendChild(div("wl-tip-v wl-tip-no", "немає даних у цій точці"));
          tip.appendChild(row);
        });
        if (vis.some(function (s) { return s.cond; })) tip.appendChild(div("wl-tip-note", "Умовно: депозит × середня дохідність"));
        tip.hidden = false;
        const tw = tip.offsetWidth || 190, scale = host.clientWidth / W, px = x * scale;
        tip.style.left = Math.round(px + 14 + tw > host.clientWidth ? Math.max(4, px - 14 - tw) : px + 14) + "px"; tip.style.top = "10px";
      }
    }
    function nearest(s, t) {
      let best = null, bd = Infinity;
      s.segments.forEach(function (seg) {
        let lo = 0, hi = seg.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (seg[m].t < t) lo = m + 1; else hi = m; }
        [lo - 1, lo].forEach(function (i) { if (i >= 0 && i < seg.length && Math.abs(seg[i].t - t) < bd) { bd = Math.abs(seg[i].t - t); best = seg[i]; } });
      });
      return best;
    }
    function nearestTime(t) {                                           // найближча реальна часова мітка серед видимих рядів
      let best = null, bd = Infinity;
      visibleSeries().forEach(function (s) { const p = nearest(s, t); if (p && Math.abs(p.t - t) < bd) { bd = Math.abs(p.t - t); best = p.t; } });
      return best;
    }

    // ---------- масштаб і прокрутка ----------
    function setView(a, b) {
      const d = domain(), full = d[1] - d[0], minSpan = Math.min(full, data.minSpan || 10 * MIN);
      let span = clamp(b - a, minSpan, full), s = a;
      if (s < d[0]) s = d[0]; if (s + span > d[1]) s = d[1] - span;
      view = span >= full * 0.999 ? null : [s, s + span];
      schedule();
      if (typeof opts.onView === "function") opts.onView(!!view);
    }
    function zoomAt(f, tc) { const v = cur(), span = v[1] - v[0], ns = span * f, r = (tc - v[0]) / span; setView(tc - r * ns, tc - r * ns + ns); }
    function pan(dxPx) { const v = cur(), span = v[1] - v[0], dt = -dxPx / plotW() * span; setView(v[0] + dt, v[1] + dt); }
    function xClient(e) { const r = svg.getBoundingClientRect(); return (e.clientX - r.left) * W / r.width; }

    svg.addEventListener("wheel", function (e) { if (!data) return; e.preventDefault(); zoomAt(e.deltaY > 0 ? 1.25 : 0.8, tOf(clamp(xClient(e), ML, W - MR), cur())); }, { passive: false });
    svg.addEventListener("pointerdown", function (e) {
      if (!data) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (ptrs.size >= 2) {
        const a = Array.from(ptrs.values());
        pinch = { d0: Math.max(10, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)), v0: cur().slice(), cx: (a[0].x + a[1].x) / 2 }; drag = null; return;
      }
      drag = { x: e.clientX, v0: cur().slice(), moved: false, touch: e.pointerType === "touch" };
    });
    svg.addEventListener("pointermove", function (e) {
      if (!data) return;
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (pinch && ptrs.size >= 2) {
        const a = Array.from(ptrs.values()), d = Math.max(10, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)), span0 = pinch.v0[1] - pinch.v0[0], ns = span0 * pinch.d0 / d;
        const r = svg.getBoundingClientRect(), xm = (pinch.cx - r.left) * W / r.width, tc = tOf(clamp(xm, ML, W - MR), pinch.v0), ratio = (tc - pinch.v0[0]) / span0;
        setView(tc - ratio * ns, tc - ratio * ns + ns); return;
      }
      if (drag) {
        const dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) > (drag.touch ? 8 : 4)) drag.moved = true;
        if (drag.moved) { const r = svg.getBoundingClientRect(), sc = W / r.width, v = drag.v0, span = v[1] - v[0], dt = -dx * sc / plotW() * span; view = null; const d = domain(), full = d[1] - d[0]; const s = clamp(v[0] + dt, d[0], d[1] - span); view = span >= full * 0.999 ? null : [s, s + span]; schedule(); return; }
      }
      if (e.pointerType !== "touch") { const t = nearestTime(tOf(clamp(xClient(e), ML, W - MR), cur())); if (t !== hover) { hover = t; schedule(); } }
    });
    function up(e) {
      const wasTap = drag && !drag.moved && drag.touch;
      ptrs.delete(e.pointerId);
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (ptrs.size < 2) pinch = null;
      if (wasTap && data) { const t = nearestTime(tOf(clamp(xClient(e), ML, W - MR), cur())); hover = t === hover ? null : t; schedule(); }
      if (!ptrs.size) drag = null;
    }
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", function (e) { ptrs.delete(e.pointerId); pinch = null; drag = null; });
    svg.addEventListener("pointerleave", function (e) { if (e.pointerType !== "touch" && !drag) { hover = null; schedule(); } });
    svg.addEventListener("dblclick", function () { reset(); });
    svg.addEventListener("keydown", function (e) {
      if (!data) return;
      if (e.key === "Home") { e.preventDefault(); reset(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(0.8, hover !== null ? hover : (cur()[0] + cur()[1]) / 2); }
      else if (e.key === "-") { e.preventDefault(); zoomAt(1.25, hover !== null ? hover : (cur()[0] + cur()[1]) / 2); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const all = []; visibleSeries().forEach(function (s) { s.segments.forEach(function (seg) { seg.forEach(function (p) { all.push(p.t); }); }); });
        all.sort(function (a, b) { return a - b; });
        const base = hover !== null ? hover : all[all.length - 1];
        const next = e.key === "ArrowLeft" ? all.filter(function (t) { return t < base; }).pop() : all.filter(function (t) { return t > base; })[0];
        if (next !== undefined) { hover = next; schedule(); }
      } else if (e.key === "Escape") { hover = null; schedule(); }
    });
    function reset() { view = null; hover = null; schedule(); if (typeof opts.onView === "function") opts.onView(false); }

    if (window.ResizeObserver) { ro = new ResizeObserver(function (en) { if (en.length && !destroyed) applySize(en[0].contentRect.width); }); ro.observe(host); }
    applySize(host.clientWidth);

    return {
      svg: svg, tip: tip, empty: msg,
      set: function (d) { const keep = data && view && d.keepView; data = d; if (!keep) view = null; if (hover !== null && !(hover >= domain()[0] && hover <= domain()[1])) hover = null; schedule(); },
      reset: reset, flush: flush, size: function () { return { w: W, h: H }; }, getView: function () { return view ? view.slice() : null; },
      hoverAt: function (t) { hover = t === null ? null : nearestTime(t); flush(); },
      resize: function (w) { applySize(w); },
      destroy: function () { destroyed = true; clearTimeout(timer); if (ro) ro.disconnect(); svg.remove(); tip.remove(); msg.remove(); host.classList.remove("wl-chart"); },
    };
  }

  root.WalletsChart = { create: create, _niceTicks: niceTicks, _logTicks: logTicks };
})(typeof window !== "undefined" ? window : this);
