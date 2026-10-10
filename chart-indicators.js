// Математика індикаторів для графіка: чисті функції без DOM і без мережі (тестуються в tools/test-chart.html).
//   vwap (за обсягом, по сесії UTC).
// Кожна функція отримує масив чисел (зазвичай ціни закриття) і повертає масив тієї самої довжини: null там, де значення ще не можна порахувати.
//   sma, ema, rsi (Вайлдер), bollinger (середня і смуги ±k стандартних відхилень), macd (лінія, сигнал, гістограма).
// cache() — маленький кеш результатів за «версією» даних: поки дані не змінились (наведення курсора, прокрутка, масштаб), ряд НЕ перераховується.

(function (root) {
  "use strict";

  function nulls(n) { return new Array(n).fill(null); }

  // Проста ковзна середня: біжуча сума, O(n)
  function sma(arr, n) {
    const out = nulls(arr.length);
    if (!(n >= 1)) return out;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // Експоненційна середня: перше значення (на n-му елементі) — проста середня перших n, далі EMA = попередня + k·(ціна − попередня), k = 2/(n+1)
  function ema(arr, n) {
    const out = nulls(arr.length);
    if (!(n >= 1) || arr.length < n) return out;
    const k = 2 / (n + 1);
    let s = 0;
    for (let i = 0; i < n; i++) s += arr[i];
    let prev = s / n;
    out[n - 1] = prev;
    for (let i = n; i < arr.length; i++) { prev = prev + k * (arr[i] - prev); out[i] = prev; }
    return out;
  }

  // RSI за Вайлдером: перше значення (на індексі n) — з простих середніх перших n змін, далі згладжування (n−1)/n
  function rsi(arr, n) {
    n = n || 14;
    const out = nulls(arr.length);
    if (arr.length < n + 2) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = arr[i] - arr[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  // Смуги Боллінджера: середня n і ±k стандартних відхилень (за генеральною сукупністю, ділення на n)
  function bollinger(arr, n, k) {
    n = n || 20; k = k === undefined ? 2 : k;
    const mid = sma(arr, n), up = nulls(arr.length), dn = nulls(arr.length);
    for (let i = n - 1; i < arr.length; i++) {
      let q = 0;
      for (let j = i - n + 1; j <= i; j++) q += (arr[j] - mid[i]) * (arr[j] - mid[i]);
      const sd = Math.sqrt(q / n);
      up[i] = mid[i] + k * sd; dn[i] = mid[i] - k * sd;
    }
    return { mid: mid, up: up, dn: dn };
  }

  // MACD: лінія = EMA(fast) − EMA(slow); сигнал = EMA лінії; гістограма = лінія − сигнал
  function macd(arr, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const ef = ema(arr, fast), es = ema(arr, slow), line = nulls(arr.length), sig = nulls(arr.length), hist = nulls(arr.length);
    let first = -1;
    for (let i = 0; i < arr.length; i++) if (ef[i] !== null && es[i] !== null) { line[i] = ef[i] - es[i]; if (first < 0) first = i; }
    if (first >= 0 && arr.length - first >= signal) {
      const part = ema(line.slice(first), signal);
      for (let i = 0; i < part.length; i++) if (part[i] !== null) { sig[first + i] = part[i]; hist[first + i] = line[first + i] - part[i]; }
    }
    return { macd: line, signal: sig, hist: hist };
  }

  // ---------- VWAP ----------
  // Середня ціна, зважена за обсягом, ПО СЕСІЇ: сума(типова ціна × обсяг) / сума(обсяг), типова ціна = (High + Low + Close) / 3.
  // Сесія завжди в UTC: "day" — доба з 00:00 UTC (за замовчуванням для криптовалют), "week" — тиждень з понеділка 00:00 UTC.
  // Нова сесія починає розрахунок із нуля, дані різних сесій не змішуються. Свічка без обсягу не змінює суми; поки в сесії не було обсягу, значення немає (null).
  // partial[i] = true для сесії, початок якої не завантажено (ряд починається посеред сесії): такий VWAP неповний і не повністю достовірний.
  // unavailable = true, якщо свічка не коротша за сесію (наприклад, денні свічки для сесії «доба»): VWAP не має сенсу.
  const DAY = 86400000;
  function sessionId(t, session) {
    const d = Math.floor(t / DAY);
    if (session === "week") { const dow = (((d + 3) % 7) + 7) % 7; return d - dow; }     // 1 січня 1970 — четвер; понеділок = 0
    return d;
  }
  function sessionLength(session) { return session === "week" ? 7 * DAY : DAY; }
  function vwap(candles, session) {
    session = session === "week" ? "week" : "day";
    const n = candles.length, out = new Array(n).fill(null), partial = new Array(n).fill(false), ids = new Array(n).fill(0);
    if (!n) return { vwap: out, partial: partial, ids: ids, unavailable: false, session: session };
    let step = Infinity;
    for (let i = 1; i < Math.min(n, 60); i++) { const d = candles[i].t - candles[i - 1].t; if (d > 0 && d < step) step = d; }
    if (step >= sessionLength(session)) return { vwap: out, partial: partial, ids: ids, unavailable: true, session: session };
    const firstSid = sessionId(candles[0].t, session), firstPartial = candles[0].t > firstSid * DAY;
    let cur = null, pv = 0, vv = 0;
    for (let i = 0; i < n; i++) {
      const c = candles[i], sid = sessionId(c.t, session);
      if (sid !== cur) { cur = sid; pv = 0; vv = 0; }
      ids[i] = sid; partial[i] = sid === firstSid && firstPartial;
      if (c.h === undefined || c.l === undefined) continue;
      const v = c.v;
      if (isFinite(v) && v > 0) { pv += (c.h + c.l + c.c) / 3 * v; vv += v; }
      out[i] = vv > 0 ? pv / vv : null;
    }
    return { vwap: out, partial: partial, ids: ids, unavailable: false, session: session };
  }

  // Кеш за версією даних: get(ключ, версія, обчислення) перераховує лише коли версія змінилась
  function cache() {
    const store = new Map();
    return {
      get: function (key, version, compute) {
        const hit = store.get(key);
        if (hit && hit.version === version) return hit.value;
        const value = compute();
        store.set(key, { version: version, value: value });
        return value;
      },
      clear: function () { store.clear(); },
    };
  }

  root.ChartIndicators = { sma: sma, ema: ema, rsi: rsi, bollinger: bollinger, macd: macd, vwap: vwap, sessionId: sessionId, cache: cache };
})(typeof window !== "undefined" ? window : this);
