// Анімований фон-графіки для головного екрана.
// Малюється на <canvas class="hero-bg">: лінії, свічки, стовпчики й світні точки повільно «біжать» вліво,
// а палітра кольорів плавно змінюється (океан → захід → ліс → аврора).
// Це декорація: дані вигадані випадково й нічого не означають. Тому canvas прихований від скрінрідерів.
// Анімація зупиняється, коли блок не видно або вкладка неактивна, а при «зменшити рух» малюється один кадр.

(function () {
  const canvas = document.querySelector(".hero-bg");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Палітри: тло (верх і низ) та кольори шарів, у форматі RGB
  const PALETTES = [
    { top: [10, 26, 38],  bottom: [14, 56, 72],  a: [45, 212, 191],  b: [56, 189, 248],  bars: [99, 102, 241],  up: [52, 211, 153],  down: [244, 114, 182] },
    { top: [34, 16, 40],  bottom: [70, 28, 50],  a: [251, 146, 60],  b: [250, 204, 21],  bars: [236, 72, 153],  up: [250, 204, 21],  down: [244, 63, 94] },
    { top: [10, 32, 24],  bottom: [18, 62, 42],  a: [74, 222, 128],  b: [163, 230, 53],  bars: [45, 212, 191],  up: [134, 239, 172], down: [251, 146, 60] },
    { top: [22, 18, 50],  bottom: [42, 28, 90],  a: [167, 139, 250], b: [244, 114, 182], bars: [56, 189, 248],  up: [94, 234, 212],  down: [251, 113, 133] },
  ];
  const HOLD = 9000;      // скільки мс тримається одна палітра
  const BLEND = 2800;     // скільки мс триває плавний перехід

  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
  function rgba(c, a) { return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + a + ")"; }
  function ease(t) { return t * t * (3 - 2 * t); }

  // Поточні кольори з урахуванням переходу між палітрами
  function currentColors(now) {
    const cycle = HOLD + BLEND;
    const k = Math.floor(now / cycle);
    const inCycle = now % cycle;
    const p1 = PALETTES[k % PALETTES.length];
    const p2 = PALETTES[(k + 1) % PALETTES.length];
    const t = inCycle < HOLD ? 0 : ease((inCycle - HOLD) / BLEND);
    const out = {};
    ["top", "bottom", "a", "b", "bars", "up", "down"].forEach(function (key) { out[key] = mix(p1[key], p2[key], t); });
    return out;
  }

  // Випадкове «блукання»: значення від 0 до 1, що плавно змінюються
  let seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  function Walk(vol, pull) {
    this.v = 0.5; this.m = 0; this.vol = vol; this.pull = pull;
  }
  Walk.prototype.next = function () {
    this.m = this.m * 0.8 + (rnd() - 0.5) * this.vol;
    this.v = Math.min(1, Math.max(0, this.v + this.m + (0.5 - this.v) * this.pull));
    return this.v;
  };

  // Шар-ряд: масив значень, що «їде» вліво
  function Layer(step, speed, vol, pull, candle) {
    this.step = step; this.speed = speed; this.off = 0; this.vals = []; this.walk = new Walk(vol, pull); this.candle = candle;
  }
  Layer.prototype.make = function () {
    const o = this.walk.v;
    const c = this.walk.next();
    if (!this.candle) return c;
    const hi = Math.min(1, Math.max(o, c) + rnd() * 0.06);
    const lo = Math.max(0, Math.min(o, c) - rnd() * 0.06);
    return { o: o, c: c, h: hi, l: lo };
  };
  Layer.prototype.fill = function (n) {
    while (this.vals.length < n) this.vals.push(this.make());
  };
  Layer.prototype.advance = function (dt, n) {
    this.off += this.speed * dt;
    while (this.off >= 1) {
      this.off -= 1;
      this.vals.shift();
      this.vals.push(this.make());
    }
    this.fill(n);
  };

  let W = 0, H = 0, dpr = 1;
  const A = new Layer(14, 1.3, 0.09, 0.015, false);   // велика лінія з заливкою
  const B = new Layer(10, 2.2, 0.10, 0.02, false);    // тонка швидка лінія
  const C = new Layer(18, 1.0, 0.12, 0.02, true);     // японські свічки
  const D = new Layer(13, 1.1, 0.30, 0.10, false);    // стовпчики обсягів
  const layers = [A, B, C, D];

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layers.forEach(function (l) { l.fill(Math.ceil(W / l.step) + 4); });
  }

  function draw(now) {
    const col = currentColors(now);
    // тло
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, rgba(col.top, 1));
    bg.addColorStop(1, rgba(col.bottom, 1));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // сітка
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 6; i++) { const y = Math.round((H / 6) * i) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // стовпчики (знизу)
    ctx.fillStyle = rgba(col.bars, 0.32);
    D.vals.forEach(function (v, i) {
      const h = v * H * 0.22 + 4;
      ctx.fillRect((i - D.off) * D.step, H - h, D.step * 0.55, h);
    });

    // свічки: усі зростаючі малюємо одним штрихом, усі спадні — другим (а не по одному штриху на кожну)
    const cy = function (v) { return H * (0.86 - v * 0.5); };
    [true, false].forEach(function (goingUp) {
      const color = goingUp ? col.up : col.down;
      const group = C.vals.map(function (c, i) { return { c: c, x: (i - C.off) * C.step }; })
        .filter(function (g) { return (g.c.c >= g.c.o) === goingUp; });
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.fillStyle = rgba(color, 0.45);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      group.forEach(function (g) { ctx.moveTo(g.x + 4, cy(g.c.h)); ctx.lineTo(g.x + 4, cy(g.c.l)); });
      ctx.stroke();
      group.forEach(function (g) {
        ctx.fillRect(g.x, cy(Math.max(g.c.o, g.c.c)), 8, Math.max(2, Math.abs(cy(g.c.o) - cy(g.c.c))));
      });
    });

    // тонка лінія
    ctx.beginPath();
    B.vals.forEach(function (v, i) {
      const x = (i - B.off) * B.step, y = H * (0.62 - v * 0.38);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = rgba(col.b, 0.85);
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();

    // велика лінія із заливкою
    const pts = A.vals.map(function (v, i) { return [(i - A.off) * A.step, H * (0.80 - v * 0.52)]; });
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.strokeStyle = rgba(col.a, 0.95);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(pts[pts.length - 1][0], H);
    ctx.lineTo(pts[0][0], H);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, H * 0.25, 0, H);
    fill.addColorStop(0, rgba(col.a, 0.38));
    fill.addColorStop(1, rgba(col.a, 0));
    ctx.fillStyle = fill;
    ctx.fill();

    // світна точка, що пульсує, на видимому «кінці» графіка
    const idx = Math.min(pts.length - 1, Math.floor((W * 0.86) / A.step));
    const p = pts[idx];
    const pulse = (Math.sin(now / 420) + 1) / 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 8 + pulse * 9, 0, Math.PI * 2);
    ctx.fillStyle = rgba(col.a, 0.18 + 0.12 * (1 - pulse));
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p[0], p[1], 4.5, 0, Math.PI * 2);
    ctx.fillStyle = rgba([255, 255, 255], 0.95);
    ctx.fill();
  }

  // ---------- запуск ----------
  let last = performance.now(), running = false, visible = true;

  function frame(t) {
    if (!visible || document.hidden) { running = false; return; }
    if (t - last < 33) { requestAnimationFrame(frame); return; }  // близько 30 кадрів/с: рух повільний, різниці не видно, а процесор працює вдвічі менше
    const dt = Math.min((t - last) / 1000, 0.1);
    last = t;
    layers.forEach(function (l) { l.advance(dt, Math.ceil(W / l.step) + 4); });
    draw(t);
    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  resize();
  draw(performance.now());                       // перший кадр одразу, без чекання
  if (reduce) return;                            // «зменшити рух»: лишається один статичний кадр

  let resizeQueued = false;   // зміна розміру приходить десятками подій: перемальовуємо один раз за кадр\n  window.addEventListener("resize", function () {\n    if (resizeQueued) return;\n    resizeQueued = true;\n    requestAnimationFrame(function () { resizeQueued = false; resize(); draw(performance.now()); });\n  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) start(); });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }, { threshold: 0.01 }).observe(canvas);
  }
  start();
})();
