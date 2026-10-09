// Малювання графіків у SVG та простих діаграм (спільне для віджетів головної).
// Потребує agent-ui.js (el). Дані малюються лише числами/атрибутами; тексти — через textContent.

(function () {
  const NS = "http://www.w3.org/2000/svg";
  let uid = 0;   // для унікальних id градієнтів

  // ---------- Помічники малювання ----------
  function sv(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }

  function fmtNum(n, digits) {
    return n.toLocaleString("uk-UA", { maximumFractionDigits: digits === undefined ? 0 : digits });
  }

  function fmtBig(usd) {
    if (usd >= 1e12) return fmtNum(usd / 1e12, 2) + " трлн $";
    if (usd >= 1e9) return fmtNum(usd / 1e9, 1) + " млрд $";
    return fmtNum(usd / 1e6, 0) + " млн $";
  }

  const trendColor = function (v) { return v >= 0 ? "var(--up)" : "var(--down)"; };

  // Лінійний графік (з заливкою). labels: показати мін і макс під графіком.
  function lineChart(values, opts) {
    const o = Object.assign({ w: 320, h: 110, color: "var(--accent)", fill: true, dots: true }, opts || {});
    const svg = sv("svg", { viewBox: "0 0 " + o.w + " " + o.h, class: "wchart", role: "img", "aria-label": o.label || "Графік" });
    if (values.length < 2) return svg;
    const min = Math.min.apply(null, values), max = Math.max.apply(null, values), span = max - min || 1;
    const pad = 6;
    const pts = values.map(function (v, i) {
      return [(i / (values.length - 1)) * o.w, o.h - pad - ((v - min) / span) * (o.h - pad * 2)];
    });
    const line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    if (o.fill) {
      const id = "wg" + (++uid);
      const defs = sv("defs", {}, svg);
      const g = sv("linearGradient", { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      sv("stop", { offset: "0%", style: "stop-color:" + o.color + ";stop-opacity:0.35" }, g);
      sv("stop", { offset: "100%", style: "stop-color:" + o.color + ";stop-opacity:0" }, g);
      sv("polygon", { points: "0," + o.h + " " + line + " " + o.w + "," + o.h, fill: "url(#" + id + ")" }, svg);
    }
    sv("polyline", { points: line, fill: "none", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", style: "stroke:" + o.color }, svg);
    if (o.dots) {
      const last = pts[pts.length - 1];
      sv("circle", { cx: last[0], cy: last[1], r: 4, style: "fill:" + o.color }, svg);
    }
    return svg;
  }

  function sparkline(values, color) {
    return lineChart(values, { w: 110, h: 34, color: color, fill: false, dots: false, label: "Мініграфік за 7 днів" });
  }

  // Стовпчики однакової ширини; висота за значенням. Останній — акцентний.
  function barChart(values, opts) {
    const o = Object.assign({ w: 320, h: 100, color: "var(--accent)" }, opts || {});
    const svg = sv("svg", { viewBox: "0 0 " + o.w + " " + o.h, class: "wchart", role: "img", "aria-label": o.label || "Діаграма" });
    const max = Math.max.apply(null, values.concat([1]));
    const bw = o.w / values.length;
    values.forEach(function (v, i) {
      const h = (v / max) * (o.h - 6);
      const r = sv("rect", { x: i * bw + 2, y: o.h - h, width: Math.max(2, bw - 4), height: Math.max(h, 1), rx: 3, style: "fill:" + o.color + ";opacity:" + (i === values.length - 1 ? 1 : 0.55) }, svg);
      sv("title", {}, r).textContent = String(v);
    });
    return svg;
  }

  // Кільцева діаграма: slices = [{value, color}]
  function donut(slices) {
    const R = 42, C = 2 * Math.PI * R;
    const svg = sv("svg", { viewBox: "0 0 120 120", class: "wdonut", role: "img", "aria-label": "Частки ринку" });
    sv("circle", { cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 16, style: "stroke:var(--accent-soft)" }, svg);
    const total = slices.reduce(function (a, s) { return a + s.value; }, 0) || 1;
    let offset = 0;
    slices.forEach(function (s) {
      const len = (s.value / total) * C;
      sv("circle", { cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 16, "stroke-dasharray": len.toFixed(2) + " " + (C - len).toFixed(2),
        "stroke-dashoffset": (-offset).toFixed(2), transform: "rotate(-90 60 60)", style: "stroke:" + s.color }, svg);
      offset += len;
    });
    return svg;
  }

  // Горизонтальні смуги: items = [{label, value, text, color}]
  function hBars(items) {
    const wrap = el("div", "bars");
    const max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); }).concat([0.0001]));
    items.forEach(function (i) {
      const row = el("div", "bar-row");
      row.appendChild(el("span", "bar-label", i.label));
      const track = el("span", "bar-track");
      const fill = el("span", "bar-fill");
      fill.style.width = Math.max(3, Math.round((100 * Math.abs(i.value)) / max)) + "%";
      if (i.color) fill.style.background = i.color;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "bar-val", i.text));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function stat(label, value, cls) {
    const d = el("div", "wstat");
    d.appendChild(el("div", "wstat-l", label));
    d.appendChild(el("div", "wstat-v" + (cls ? " " + cls : ""), value));
    return d;
  }

  function note(text) { return el("p", "small", text); }

  window.Charts = { sv: sv, fmtNum: fmtNum, fmtBig: fmtBig, trendColor: trendColor, lineChart: lineChart,
    sparkline: sparkline, barChart: barChart, donut: donut, hBars: hBars, stat: stat, note: note };
})();
