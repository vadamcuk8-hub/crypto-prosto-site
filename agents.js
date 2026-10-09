// Сторінка «Агенти»: кожен агент у своїй вкладці (стан, розклад, джерело, файл даних і його віджети), а перша вкладка — огляд усіх.
// Потребує agent-ui.js, charts.js, widget-defs.js, widgets.js. Тексти вставляються через textContent.

(function () {
  const tabsBox = document.getElementById("agentTabs");
  const panels = document.getElementById("agentPanels");
  if (!tabsBox || !panels) return;

  const INFO = [
    { id: "market", label: "Ринок", task: "Рахує капіталізацію, частки біткоїна й ефіріуму, топ монет і лідерів дня.", files: ["market"] },
    { id: "network", label: "Мережа біткоїна", task: "Стежить за комісіями, чергою транзакцій і потужністю майнінгу.", files: ["network"] },
    { id: "sentiment", label: "Настрій", task: "Веде індекс страху й жадібності та його історію за 30 днів.", files: ["sentiment"] },
    { id: "stablecoins", label: "Стейблкоїни", task: "Рахує пропозицію стейблкоїнів, лідерів і динаміку.", files: ["stablecoins"] },
    { id: "regulation", label: "Регулювання", task: "Збирає нові офіційні документи США про крипто.", files: ["regulation"] },
    { id: "news", label: "Новини", task: "Читає стрічки видань, фільтрує рекламу, зливає повтори, перекладає й робить висновки.", files: ["news", "analytics"] },
  ];
  const STATE_TEXT = { ok: "Працює", stale: "Дані застаріли", failed: "Помилка", none: "Немає даних" };

  let agents = null;
  const views = {};            // id → { tab, panel, status, widgets }
  let current = "all";

  function fmtInterval(sec) {
    if (!sec) return "—";
    return sec < 3600 ? Math.round(sec / 60) + " хв" : Math.round(sec / 3600) + " год";
  }

  function chip(state) {
    return el("span", "chip " + state, STATE_TEXT[state]);
  }

  function statusOf(id) {
    return agents && agents.agents ? agents.agents[id] : null;
  }

  // ---------- Вкладки ----------
  function makeTab(id, label) {
    const b = el("button", "agent-tab");
    b.type = "button";
    b.id = "tab-" + id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "panel-" + id);
    b.appendChild(el("span", "tab-dot"));
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click", function () { select(id, true); });
    tabsBox.appendChild(b);
    const p = el("section", "agent-panel");
    p.id = "panel-" + id;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", b.id);
    p.hidden = true;
    panels.appendChild(p);
    return { tab: b, panel: p };
  }

  views.all = makeTab("all", "Огляд");
  views.all.table = el("div", "agent-table-wrap");
  views.all.panel.appendChild(el("p", "muted", "Усі агенти й їхній стан. Натисніть на назву, щоб відкрити вкладку агента."));
  views.all.panel.appendChild(views.all.table);

  INFO.forEach(function (info) {
    const v = makeTab(info.id, info.label);
    v.info = info;
    v.status = el("div", "agent-card");
    v.panel.appendChild(v.status);
    v.dash = el("div", "dash");
    v.panel.appendChild(v.dash);
    v.widgets = null;
    views[info.id] = v;
  });

  function select(id, focus) {
    if (!views[id]) id = "all";
    current = id;
    Object.keys(views).forEach(function (k) {
      const on = k === id;
      views[k].tab.setAttribute("aria-selected", on ? "true" : "false");
      views[k].tab.tabIndex = on ? 0 : -1;
      views[k].panel.hidden = !on;
    });
    if (focus) views[id].tab.focus();
    history.replaceState(null, "", id === "all" ? location.pathname : "#" + id);
    const v = views[id];
    if (v.info && !v.widgets) {            // віджети агента створюємо лише коли вкладку відкрито вперше
      v.widgets = Widgets.mount(v.dash, WIDGET_DEFS.filter(function (w) { return w.agent === id; }));
    }
    refreshView();
  }

  tabsBox.addEventListener("keydown", function (e) {
    const ids = Object.keys(views);
    const i = ids.indexOf(current);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % ids.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + ids.length) % ids.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = ids.length - 1;
    if (n >= 0) { e.preventDefault(); select(ids[n], true); }
  });

  // ---------- Вміст ----------
  function renderStatus(v) {
    const st = statusOf(v.info.id);
    const state = agentState(st);
    const box = v.status;
    box.replaceChildren();
    const head = el("div", "agent-head");
    head.appendChild(el("h2", "agent-name", st ? st.title : v.info.label));
    head.appendChild(chip(state));
    box.appendChild(head);
    box.appendChild(el("p", "agent-task", v.info.task));
    const dl = el("dl", "agent-facts");
    function fact(k, val, link) {
      dl.appendChild(el("dt", "", k));
      const dd = el("dd");
      if (link) { const a = el("a", "", val); a.href = link; dd.appendChild(a); } else dd.textContent = val;
      dl.appendChild(dd);
    }
    fact("Останній успішний запуск", st && st.last_ok ? ago(st.last_ok) : "ще не було");
    fact("Розклад", st ? "кожні " + fmtInterval(st.interval) + " (на GitHub: раз на ~10 хв)" : "—");
    fact("Джерело даних", st ? st.source : "—");
    v.info.files.forEach(function (f) { fact("Файл даних", "data/" + f + ".json", "data/" + f + ".json"); });
    box.appendChild(dl);
    if (st && st.error) box.appendChild(el("p", "note", "Остання помилка: " + st.error));
    v.tab.className = "agent-tab " + state;
  }

  function renderOverview() {
    const v = views.all;
    const t = el("table", "agent-table");
    const head = el("tr");
    ["Агент", "Задача", "Стан", "Оновлено", "Розклад"].forEach(function (h) { head.appendChild(el("th", "", h)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    INFO.forEach(function (info) {
      const st = statusOf(info.id);
      const tr = el("tr");
      const name = el("td");
      const b = el("button", "link-btn", st ? st.title : info.label);
      b.type = "button";
      b.addEventListener("click", function () { select(info.id, true); });
      name.appendChild(b);
      tr.appendChild(name);
      tr.appendChild(el("td", "", info.task));
      tr.appendChild(el("td")).appendChild(chip(agentState(st)));
      tr.appendChild(el("td", "", st && st.last_ok ? ago(st.last_ok) : "—"));
      tr.appendChild(el("td", "", st ? fmtInterval(st.interval) : "—"));
      body.appendChild(tr);
      views[info.id].tab.className = "agent-tab " + agentState(st);
    });
    t.appendChild(body);
    v.table.replaceChildren(t);
  }

  function refreshView() {
    if (current === "all") { renderOverview(); return; }
    const v = views[current];
    renderStatus(v);
    if (v.widgets) v.widgets.refresh(agents);
  }

  async function refreshAll() {
    try { agents = await loadJson("data/agents.json"); } catch (e) { agents = null; }
    INFO.forEach(function (i) { views[i.id].tab.className = "agent-tab " + agentState(statusOf(i.id)); });
    refreshView();
  }

  const fresh = document.getElementById("freshness");
  async function tick() {
    await refreshAll();
    if (fresh) renderFreshness(fresh, agents);
  }

  select(location.hash.slice(1) || "all", false);
  tick();
  setInterval(function () { if (!document.hidden) tick(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  window.addEventListener("hashchange", function () { select(location.hash.slice(1) || "all", false); });
})();
