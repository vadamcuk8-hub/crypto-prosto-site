// Ринок, частина 4: теплова карта.
// Потребує market-live.js.

// ---------- Теплова карта ринку ----------
const heatBox = document.getElementById("heatmapBox");

// Скільки відсотків кольору (зеленого чи червоного) має плитка: від 15% до 85%, максимум при зміні ±8%
function heatPct(change) {
  return Math.round(15 + Math.min(Math.abs(change) / 8, 1) * 70);
}

// Колір плитки: чим більша зміна, тим насиченіше
function heatColor(change) {
  return "color-mix(in srgb, var(--" + (change >= 0 ? "up" : "down") + ") " + heatPct(change) + "%, var(--card))";
}

// --- Читабельний текст на кольорових плитках: колір тексту (темний або білий) обираємо за яскравістю плитки ---
const colorProbe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
colorProbe.canvas.width = colorProbe.canvas.height = 1;

function cssRgb(cssColor) {            // «#327050» або «rgb(…)» → [r, g, b]
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = cssColor;
  colorProbe.fillRect(0, 0, 1, 1);
  const d = colorProbe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function relLum(c) {
  const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrastOf(a, b) {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Колір тексту для плитки: той із двох (темний / білий), що дає більший контраст.
// Результат залежить лише від знака й відсотка кольору, тому запам'ятовуємо його до зміни теми.
function heatTextColor(change) {
  const pct = heatPct(change), up = change >= 0;
  const key = (up ? "u" : "d") + pct;
  if (heatMemo[key]) return heatMemo[key];
  const w = pct / 100;
  const cs = getComputedStyle(root);
  const base = cssRgb(cs.getPropertyValue(up ? "--up" : "--down").trim());
  const card = cssRgb(cs.getPropertyValue("--card").trim());
  const bg = base.map(function (v, i) { return v * w + card[i] * (1 - w); });
  // Чорний або білий: для будь-якого фону найкращий з них дає контраст не менший за 4,58:1
  const dark = [0, 0, 0], light = [255, 255, 255];
  return (heatMemo[key] = contrastOf(bg, dark) >= contrastOf(bg, light) ? "#000000" : "#ffffff");
}

function renderHeatmap() {
  if (!heatBox) return;
  const ids = Object.keys(coins).filter(function (id) { return state[id]; });
  if (!ids.length) return;

  if (heatBox.querySelector(".heat-tile:not([data-id])")) heatBox.innerHTML = "";
  ids.forEach(function (id) {
    let tile = heatBox.querySelector('[data-id="' + id + '"]');
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "heat-tile";
      tile.dataset.id = id;
      tile.innerHTML = '<div class="heat-name"></div><div class="heat-change"></div><div class="heat-price"></div>';
      tile._nodes = { name: tile.querySelector(".heat-name"), change: tile.querySelector(".heat-change"), price: tile.querySelector(".heat-price") };
      if (coins[id].pair) makeCoinPicker(tile, id, "Показати графіки цієї монети");
      heatBox.appendChild(tile);
    }
    const s = state[id], n = tile._nodes;
    const bg = heatColor(s.change), bgKey = bg + root.getAttribute("data-theme");
    if (tile._bg !== bgKey) {                   // колір міняємо, лише коли змінився відсоток насиченості або тема
      tile._bg = bgKey;
      tile.style.background = bg;
      tile.style.color = heatTextColor(s.change);
    }
    setText(n.name, coinShort(id));
    setText(n.change, (s.change >= 0 ? "▲ +" : "▼ ") + s.change.toFixed(2).replace(".", ",") + "%");
    setText(n.price, fmtMoney(s.usd));
  });
}
