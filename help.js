// Помічник: підказки до кнопок і заголовків.
//  • Будь-який елемент з атрибутом data-help показує підказку при наведенні миші, фокусі з клавіатури або дотику.
//  • Елемент з атрибутом data-hinfo отримує поруч значок «?» з довшим поясненням (замість абзацу тексту на сторінці).
//  • Help.icon(текст) створює такий значок у скрипті; Help.apply(корінь) підключає підказки до статичної розмітки.
//  • Внизу сторінки є перемикач «Підказки», вибір зберігається в браузері.
// Усі тексти вставляються через textContent.

const Help = (function () {
  const KEY = "help-off";
  let on = true, tip = null, current = null, timer = 0;
  try { on = localStorage.getItem(KEY) !== "1"; } catch (e) { /* сховище недоступне: підказки увімкнені */ }

  // Підказки для статичних кнопок і полів (селектор → текст), щоб не правити кожну сторінку вручну
  const MAP = [
    ["#menuBtn", "Відкрити або закрити меню сторінок"],
    [".currency-tab", "Показати ціни монет у цій валюті"],
    [".coin-tab", "Показати графіки цієї монети"],
    [".period-tab", "Змінити період графіка"],
    ["#openChart", "Відкрити біржовий графік обраної монети: свічки наживо, масштаб, лінії, лінійка"],
    ["#csvBtn", "Зберегти дані графіка у файл CSV, його відкриває Excel"],
    ["#calcAmt", "Скільки одиниць перераховувати. Можна писати з комою: 0,05"],
    ["#calcFrom", "З чого рахуємо: монета чи валюта"],
    ["#calcTo", "У що рахуємо: монета чи валюта"],
    ["#calcSwap", "Поміняти місцями «з чого» і «у що»"],
    ["#calcCopy", "Скопіювати результат у буфер обміну"],
    ["#calcChips .chip", "Підставити цю кількість у калькулятор"],
    ["#alertCoin", "Монета, за ціною якої стежимо"],
    ["#alertDir", "Коли сповіщати: ціна вище чи нижче заданої"],
    ["#alertPrice", "Цільова ціна в доларах, наприклад 90000"],
    ["#alertAdd", "Додати сповіщення: сайт повідомить, коли ціна досягне значення (поки сторінка відкрита)"],
    ["#alertPerm", "Дозволити системні сповіщення браузера, щоб побачити їх навіть в іншій вкладці"],
    ["#feedSearch", "Шукати слово в заголовках і описах. Клавіша «/» переходить у пошук"],
    ["#feedClear", "Очистити пошук"],
    ["#filtersToggle", "Показати або сховати фільтри за темою, джерелом, періодом і мовою"],
    ["#feedSort", "Спочатку нові чи найважливіші за оцінкою агента"],
    ["#periodSeg button", "Показати новини лише за цей період"],
    ["#langSeg button", "Показати новини лише цією мовою оригіналу"],
    ["#fConfirmed", "Лише історії, які підтвердили щонайменше два видання"],
    ["#fOfficial", "Лише офіційні джерела: SEC і Federal Register"],
    ["#fFresh", "Лише новини за останні 30 хвилин"],
    ["#feedTranslate", "Показувати заголовки українською (автопереклад) чи в оригіналі"],
    ["#feedMore", "Показати ще новини зі стрічки"],
    ["#newsSearch", "Шукати слово серед головних сюжетів"],
    ["#newsSort", "Порядок сюжетів: як на сайті, новіші чи старіші"],
    ["#newsReset", "Скинути пошук, фільтр і порядок"],
    [".filter", "Показати лише сюжети цієї теми"],
    ["#glossSearch", "Знайти слово в глосарії"],
    ["#faqToggle", "Розгорнути або згорнути всі відповіді"],
    [".subtabs a", "Перейти до цього розділу сторінки"],
  ];

  function ensure() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "help-tip"; tip.id = "helpTip"; tip.setAttribute("role", "tooltip"); tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function place(node) {
    const r = node.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
    tip.style.top = Math.round(top) + "px";
    tip.style.left = Math.round(left) + "px";
  }

  function hide() {
    clearTimeout(timer);
    if (tip) tip.hidden = true;
    if (current) { current.removeAttribute("aria-describedby"); current = null; }
  }

  function show(node) {
    if (!on) return;
    const text = node.getAttribute("data-help");
    if (!text) return;
    hide();
    const t = ensure();
    const host = document.querySelector("dialog[open]") || document.body;      // у вікні графіка підказка має бути всередині нього
    if (t.parentNode !== host) host.appendChild(t);
    t.textContent = text;
    t.hidden = false;
    place(node);
    node.setAttribute("aria-describedby", "helpTip");
    current = node;
    timer = setTimeout(hide, 6000);
  }

  function target(e) { return e.target && e.target.closest ? e.target.closest("[data-help]") : null; }
  document.addEventListener("pointerover", function (e) { const n = target(e); if (n && e.pointerType !== "touch") show(n); });
  document.addEventListener("pointerout", function (e) { if (target(e) && e.pointerType !== "touch") hide(); });
  document.addEventListener("pointerdown", function (e) { const n = target(e); if (n && e.pointerType === "touch") show(n); else if (!n) hide(); });
  document.addEventListener("focusin", function (e) { const n = target(e); if (n) show(n); });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  document.addEventListener("scroll", hide, true);

  // Значок «?» з поясненням: клік або Enter показує підказку (корисно на телефоні)
  function icon(text) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "help-icon"; b.textContent = "?";
    b.setAttribute("data-help", text);
    b.setAttribute("aria-label", "Пояснення: " + text);
    b.addEventListener("click", function (e) { e.stopPropagation(); if (current === b && tip && !tip.hidden) hide(); else { const was = on; on = true; show(b); on = was; } });
    return b;
  }

  function apply(root) {
    root = root || document;
    MAP.forEach(function (m) {
      root.querySelectorAll(m[0]).forEach(function (n) { if (!n.hasAttribute("data-help")) n.setAttribute("data-help", m[1]); });
    });
    root.querySelectorAll("[data-hinfo]").forEach(function (n) {
      if (n.querySelector(":scope > .help-icon")) return;
      n.appendChild(document.createTextNode(" "));
      n.appendChild(icon(n.getAttribute("data-hinfo")));
    });
  }

  function toggleButton() {
    const line = document.querySelector(".footer-line");
    if (!line || line.querySelector(".help-toggle")) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "help-toggle";
    function paint() { b.textContent = "Підказки: " + (on ? "увімкнено" : "вимкнено"); b.setAttribute("aria-pressed", on ? "true" : "false"); }
    b.setAttribute("data-help", "Увімкнути або вимкнути підказки до кнопок");
    b.addEventListener("click", function () {
      on = !on;
      try { localStorage.setItem(KEY, on ? "0" : "1"); } catch (e) { /* не критично */ }
      hide(); paint();
    });
    paint();
    line.appendChild(document.createTextNode(" · "));
    line.appendChild(b);
  }

  apply();
  toggleButton();
  return { icon: icon, apply: apply };
})();
