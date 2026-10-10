// Цінова шкала графіка: чиста математика без DOM (тестується в tools/test-chart.html).
// Три режими: "lin" (звичайна), "log" (логарифмічна: однакові відсоткові рухи виглядають однаково), "pct" (відсоток відносно базової ціни).
// Усі координати графіка рахуються у «перетвореному просторі» t = fwd(режим, ціна): це лише спосіб відобразити ціну на екрані,
// самі свічки (OHLC) і намальовані об'єкти (час + ціна) не змінюються й однаково коректні в будь-якому режимі.

(function (root) {
  "use strict";
  const TINY = 1e-12;

  // ціна → координата шкали
  function fwd(mode, v, base) {
    if (mode === "log") return Math.log(Math.max(v, TINY));
    if (mode === "pct") return base > 0 ? (v / base - 1) * 100 : v;
    return v;
  }
  // координата шкали → ціна
  function inv(mode, t, base) {
    if (mode === "log") return Math.exp(t);
    if (mode === "pct") return base > 0 ? base * (1 + t / 100) : t;
    return t;
  }
  // Чи можна застосувати режим: логарифм і відсотки вимагають додатних цін (інакше це математично неможливо)
  function canUse(mode, minPrice, base) {
    if (mode === "log") return minPrice > 0;
    if (mode === "pct") return minPrice > 0 && base > 0;
    return true;
  }

  // Автоматичний діапазон за найменшою й найбільшою ціною у вікні; відступ pad додається у просторі шкали
  function autoRange(mode, lo, hi, base, pad) {
    pad = pad === undefined ? 0.08 : pad;
    let a = fwd(mode, lo, base), b = fwd(mode, hi, base);
    if (!isFinite(a) || !isFinite(b)) { a = 0; b = 1; }
    if (b - a < 1e-12) { const d = Math.max(Math.abs(a) * 0.01, 1e-9); a -= d; b += d; }
    const p = (b - a) * pad;
    return { lo: a - p, hi: b + p };
  }
  // Масштабування діапазону відносно центру: factor < 1 — наближення, > 1 — віддалення
  function zoomRange(r, factor) {
    const mid = (r.lo + r.hi) / 2, half = Math.max((r.hi - r.lo) / 2 * factor, 1e-9);
    return { lo: mid - half, hi: mid + half };
  }
  function panRange(r, dt) { return { lo: r.lo + dt, hi: r.hi + dt }; }

  // «Гарний» крок: 1, 2, 5 × 10^k
  function niceStep(range, count) {
    const raw = Math.max(range, 1e-12) / Math.max(count, 1), mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  }
  function stepDecimals(step) { const s = step.toExponential(); const m = /e([+-]\d+)/.exec(s); const e = m ? parseInt(m[1], 10) : 0; return Math.max(0, -e); }
  function linTicks(lo, hi, count) {
    const step = niceStep(hi - lo, count), d = stepDecimals(step) + 1, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(Math.min(d, 12)));
    return out;
  }

  // Позначки осі в діапазоні [lo, hi] простору шкали. Повертає [{ t: координата, v: ціна (lin, log) або відсоток (pct) }]
  function ticks(mode, lo, hi, base, count) {
    count = count || 5;
    if (mode === "log") {
      const pLo = Math.exp(lo), pHi = Math.exp(hi), decades = Math.log10(pHi / pLo), out = [];
      if (decades <= 0.9) return linTicks(pLo, pHi, count).filter(function (v) { return v > 0; }).map(function (v) { return { t: Math.log(v), v: v }; });
      const mant = decades > 6 ? [1] : decades > 3 ? [1, 3] : [1, 2, 5];
      for (let e = Math.floor(Math.log10(pLo)); e <= Math.ceil(Math.log10(pHi)); e++) {
        mant.forEach(function (m) { const v = +(m * Math.pow(10, e)).toPrecision(12); if (v >= pLo * (1 - 1e-9) && v <= pHi * (1 + 1e-9)) out.push({ t: Math.log(v), v: v }); });
      }
      return out;
    }
    return linTicks(lo, hi, count).map(function (v) { return { t: v, v: v }; });
  }

  root.ChartScale = { fwd: fwd, inv: inv, canUse: canUse, autoRange: autoRange, zoomRange: zoomRange, panRange: panRange, niceStep: niceStep, ticks: ticks, MODES: ["lin", "log", "pct"] };
})(typeof window !== "undefined" ? window : this);
