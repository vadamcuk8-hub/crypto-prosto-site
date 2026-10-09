// Каркас віджетів: Widgets.mount(контейнер, список_віджетів, {compact}) створює картки й повертає refresh(agents).
// Кожен віджет читає дані СВОГО агента і не залежить від решти: якщо один агент не відповів,
// лише його віджет покаже повідомлення. Визначення віджетів — у widget-defs.js.
// Стан агента показує крапка біля назви (зелена — свіжі дані, червона — застаріли); подробиці — у підказці при наведенні.
// compact: true — головна сторінка без тексту (лише діаграми й числа).
// Потребує agent-ui.js (el, ago, loadJson, isStale) і help.js.

const Widgets = (function () {
  function mount(box, defs, opts) {
    opts = opts || {};
    const cards = {};
    defs.forEach(function (w) {
      const card = el("article", "widget" + (w.wide ? " w2" : ""));
      card.id = "w-" + w.id;
      const title = el("h3", "widget-title", w.title);
      if (w.help) title.appendChild(Help.icon(w.help));          // пояснення до віджета: значок «?» замість абзацу тексту
      const dot = el("span", "widget-dot");
      dot.tabIndex = 0;
      dot.setAttribute("data-help", "Стан агента: ще завантажується");
      title.appendChild(dot);
      card.appendChild(title);
      const body = el("div", "widget-body", "…");
      body.classList.add("loading");
      card.appendChild(body);
      box.appendChild(card);
      cards[w.id] = { body: body, dot: dot, sig: "" };
    });

    // Стан під назвою: який агент, звідки дані, коли оновлено, чи не застарів (у підказці крапки)
    function footer(w, agents, generatedAt) {
      const st = agents && agents.agents ? agents.agents[w.agent] : null;
      const c = cards[w.id];
      const stale = !!(st && generatedAt && isStale(st, generatedAt));
      const failed = !!(st && !st.ok);
      c.dot.className = "widget-dot" + (stale || failed ? " bad" : "");
      const text = "Агент «" + (st ? st.title : w.agent) + "»" + (st ? " · " + st.source : "") +
        (generatedAt ? " · оновлено " + ago(generatedAt) : "") +
        (stale ? ". Дані застаріли" : "") + (failed ? ". Останній запуск не вдався" : "");
      c.dot.setAttribute("data-help", text);
      c.dot.setAttribute("aria-label", text);
    }

    async function refreshWidget(w, agents) {
      const c = cards[w.id];
      try {
        const parts = await Promise.all(w.files.map(function (f) { return loadJson("data/" + f + ".json"); }));
        const data = {};
        w.files.forEach(function (f, i) { data[f] = parts[i]; });
        const sig = parts.map(function (p) { return p.generated_at; }).join("|");
        if (sig !== c.sig) {                       // перемальовуємо лише коли агент справді оновив дані
          c.sig = sig;
          c.body.classList.remove("loading");
          c.body.replaceChildren();
          w.render(c.body, data, opts);
        }
        footer(w, agents, parts[0].generated_at);
      } catch (e) {
        if (!c.sig) {
          c.body.classList.remove("loading");
          c.body.replaceChildren(el("p", "note", "Немає даних"));
        }
        footer(w, agents, null);
      }
    }

    return { refresh: function (agents) { defs.forEach(function (w) { refreshWidget(w, agents); }); } };
  }

  return { mount: mount };
})();
