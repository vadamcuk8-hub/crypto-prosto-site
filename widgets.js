// Каркас віджетів: Widgets.mount(контейнер, список_віджетів) створює картки й повертає refresh(agents).
// Кожен віджет читає дані СВОГО агента і не залежить від решти: якщо один агент не відповів,
// лише його віджет покаже повідомлення. Визначення віджетів — у widget-defs.js.
// Потребує agent-ui.js (el, ago, loadJson, isStale).

const Widgets = (function () {
  function mount(box, defs) {
    const cards = {};
    defs.forEach(function (w) {
      const card = el("article", "widget" + (w.wide ? " w2" : ""));
      card.id = "w-" + w.id;
      card.appendChild(el("h3", "widget-title", w.title));
      const body = el("div", "widget-body", "Завантаження…");
      body.classList.add("loading");
      const foot = el("p", "widget-foot");
      card.appendChild(body);
      card.appendChild(foot);
      box.appendChild(card);
      cards[w.id] = { body: body, foot: foot, sig: "" };
    });

    // Підпис під віджетом: який агент, звідки дані, коли оновлено, чи не застарів
    function footer(w, agents, generatedAt) {
      const st = agents && agents.agents ? agents.agents[w.agent] : null;
      const c = cards[w.id];
      const stale = !!(st && generatedAt && isStale(st, generatedAt));
      const failed = !!(st && !st.ok);
      c.foot.className = "widget-foot" + (stale || failed ? " bad" : "");
      c.foot.textContent = "Агент «" + (st ? st.title : w.agent) + "»" + (st ? " · " + st.source : "") +
        (generatedAt ? " · оновлено " + ago(generatedAt) : "") +
        (stale ? ". Дані застаріли" : "") + (failed ? ". Останній запуск не вдався" : "");
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
          w.render(c.body, data);
        }
        footer(w, agents, parts[0].generated_at);
      } catch (e) {
        if (!c.sig) {
          c.body.classList.remove("loading");
          c.body.replaceChildren(el("p", "note", "Дані цього агента ще не створено. Запустіть start-agents.bat, а сайт відкривайте через локальний сервер."));
        }
        footer(w, agents, null);
      }
    }

    return { refresh: function (agents) { defs.forEach(function (w) { refreshWidget(w, agents); }); } };
  }

  return { mount: mount };
})();
