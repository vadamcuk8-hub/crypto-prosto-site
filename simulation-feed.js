// Сторінка «Симуляція»: праворуч від поточного інтерфейсу — «Жива стрічка подій» (той самий LiveFeed.mount і той самий журнал data/live_feed.json).
// Ширина ≥ 1360 px: ліворуч симуляція (≈65 %), праворуч стрічка (≈35 %) з незалежною прокруткою й згортанням.
// Вужче: угорі сторінки кнопка «Події», що відкриває висувне вікно (таблиці й графіки не стискаються).
// За замовчуванням стрічка показує ВСІ глобальні події; кнопки «лише цей гаманець» і «лише цей бот» звужують її до вибраного на сторінці.
// Потребує agent-ui.js, live-feed-core.js, live-feed.js; торгової логіки не чіпає.
(function () {
  if (typeof LiveFeed === "undefined" || document.body.classList.contains("page-wallets")) return;
  const first = document.getElementById("paper"), last = document.getElementById("simAgent");
  if (!first || !last || first.parentNode !== last.parentNode) return;

  const bar = el("div", "sim-events-bar"), layout = el("div", "sim-layout"), main = el("div", "sim-main"), side = el("div", "sim-side"), host = el("div", "sim-feed");
  first.parentNode.insertBefore(bar, first); first.parentNode.insertBefore(layout, first);
  let n = first;
  while (n) { const next = n.nextSibling; main.appendChild(n); if (n === last) break; n = next; }            // наявні розділи переїжджають у ліву колонку разом зі своїми обробниками
  layout.appendChild(main); side.appendChild(host); layout.appendChild(side);

  // кнопки звуження: усі події (за замовчуванням) / лише поточний гаманець / лише поточний бот
  const scope = el("div", "sim-scope"), bW = el("button", "", "Лише цей гаманець"), bB = el("button", "", "Лише цей бот");
  [bW, bB].forEach(function (b) { b.type = "button"; b.setAttribute("aria-pressed", "false"); scope.appendChild(b); });
  const cur = { cap: null, rule: null };
  let onlyW = false, onlyB = false, inst = null;

  function ruleTitle() { const s = document.getElementById("paperStrategy"); return s && s.selectedOptions && s.selectedOptions[0] ? s.selectedOptions[0].textContent : cur.rule; }
  function labels() {
    bW.textContent = cur.cap ? "Лише гаманець " + cur.cap.toLocaleString("uk-UA") + " $" : "Лише цей гаманець";
    bB.textContent = cur.rule ? "Лише бот: " + ruleTitle() : "Лише цей бот"; bB.title = bB.textContent;
    bW.setAttribute("aria-pressed", onlyW ? "true" : "false"); bB.setAttribute("aria-pressed", onlyB ? "true" : "false");
  }
  function apply() {
    labels();
    if (!inst) return;
    const f = inst.getFilter(), w = onlyW && cur.cap ? cur.cap : "", b = onlyB && cur.rule ? cur.rule : "";
    if (String(f.wallet) !== String(w) || f.bot !== b) inst.setFilter({ wallet: w, bot: b });                // той самий фільтр не перебудовує список: дублікатів немає
  }
  bW.addEventListener("click", function () { onlyW = !onlyW; apply(); });
  bB.addEventListener("click", function () { onlyB = !onlyB; apply(); });
  function onSelect(e) {
    const d = e.detail || {};
    if (d.cap === cur.cap && d.rule === cur.rule) return;
    cur.cap = d.cap || null; cur.rule = d.rule || null; apply();
  }
  document.addEventListener("sim:select", onSelect);

  inst = LiveFeed.mount(host, {
    layoutRoot: layout, extra: scope, fabParent: bar, drawerBelow: 1359, period: "all",
    onMode: function (on) { bar.classList.toggle("on", on); },
  });
  labels();
  window.addEventListener("pagehide", function () { document.removeEventListener("sim:select", onSelect); inst.destroy(); });
})();
