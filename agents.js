// Сторінка «Агенти»: кожен агент у своїй вкладці, а перша вкладка — огляд усіх.
// На вкладці лише аналітика: висновки агента, його графіки й історія по днях. Технічні дані (розклад, джерело, файли) згорнуті.
// Потребує agent-ui.js, charts.js, widget-defs.js, widgets.js. Тексти вставляються через textContent.

(function () {
  const tabsBox = document.getElementById("agentTabs");
  const panels = document.getElementById("agentPanels");
  if (!tabsBox || !panels) return;

  // insights — файл даних із висновками; history — числа з data/history/<агент>.json, що малюються як графіки по днях
  const INFO = [
    { id: "market", label: "Ринок", task: "Що відбувається з ринком у цілому за добу.", files: ["market"], insights: "market",
      knowledge: "knowledge/market.json",
      history: [{ key: "market_cap", title: "Капіталізація ринку", fmt: "usd" }, { key: "btc_dominance", title: "Частка біткоїна", fmt: "pct" },
        { key: "breadth", title: "Частка монет у зростанні за добу", fmt: "pct" }] },
    { id: "network", label: "Мережа біткоїна", task: "Наскільки дорога й завантажена мережа біткоїна.", files: ["network"], insights: "network",
      knowledge: "knowledge/network.json",
      history: [{ key: "fastest_fee", title: "Комісія за швидкий переказ, сат/байт", fmt: "int" }, { key: "hashrate_ehs", title: "Потужність майнінгу", fmt: "ehs" },
        { key: "mempool", title: "Черга транзакцій", fmt: "int" }] },
    { id: "sentiment", label: "Настрій", task: "Чи ринок налаштований на страх чи на жадібність.", files: ["sentiment"], insights: "sentiment",
      knowledge: "knowledge/sentiment.json", history: [{ key: "value", title: "Індекс страху й жадібності", fmt: "int" }] },
    { id: "stablecoins", label: "Стейблкоїни", task: "Скільки «грошей на очікуванні» є на крипторинку.", files: ["stablecoins"], insights: "stablecoins",
      knowledge: "knowledge/stablecoins.json",
      history: [{ key: "total", title: "Загальна пропозиція стейблкоїнів", fmt: "usd" }, { key: "top_share", title: "Частка найбільшого стейблкоїна", fmt: "pct" }] },
    { id: "regulation", label: "Регулювання", task: "Що роблять регулятори США щодо крипто.", files: ["regulation"], insights: "regulation",
      knowledge: "knowledge/regulation.json",
      history: [{ key: "d30", title: "Документів за 30 днів", fmt: "int" }, { key: "unknown", title: "Документів без теми (чого навчити агента)", fmt: "int" }] },
    { id: "signals", label: "Сигнали", task: "Що кажуть індикатори про найпопулярніші монети (інформація, не порада).", files: ["signals"], insights: "signals",
      knowledge: "knowledge/signals.json",
      history: [{ key: "avg_score", title: "Середня оцінка сигналів (-100…100)", fmt: "int" }, { key: "buyers", title: "Монет з перевагою покупців", fmt: "int" },
        { key: "sellers", title: "Монет з перевагою продавців", fmt: "int" }] },
    { id: "news", label: "Новини", task: "Про що пишуть видання й який тон новин.", files: ["news", "analytics"], insights: "analytics",
      history: [{ key: "total", title: "Матеріалів у стрічці за добу", fmt: "int" }, { key: "negative_share", title: "Частка негативних заголовків", fmt: "pct" },
        { key: "positive_share", title: "Частка позитивних заголовків", fmt: "pct" }] },
  ];
  const STATE_TEXT = { ok: "Працює", stale: "Дані застаріли", failed: "Помилка", none: "Немає даних" };
  const MARK = { positive: ["▲", "Позитивно"], negative: ["▼", "Негативно"], neutral: ["●", "Нейтрально"] };

  let agents = null;
  const insightData = {};      // id → [{tone, text}]
  const aiData = {};           // id → {text, model, at}: необов'язкове ШІ-пояснення (з'являється, коли задано ключ)
  const views = {};            // id → { tab, panel, ... }
  let current = "all";

  function fmtInterval(sec) {
    if (!sec) return "—";
    return sec < 3600 ? Math.round(sec / 60) + " хв" : Math.round(sec / 3600) + " год";
  }

  function fmtValue(kind, v) {
    const f = Charts.fmtNum;
    if (kind === "usd") return Charts.fmtBig(v);
    if (kind === "pct") return f(v, 1) + "%";
    if (kind === "ehs") return f(v, 0) + " EH/с";
    return f(v, 0);
  }

  function chip(state) { return el("span", "chip " + state, STATE_TEXT[state]); }
  function statusOf(id) { return agents && agents.agents ? agents.agents[id] : null; }

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
  views.all.panel.appendChild(el("p", "muted", "Головний висновок кожного агента. Натисніть на назву, щоб відкрити вкладку з повною аналітикою."));
  views.all.panel.appendChild(views.all.table);

  INFO.forEach(function (info) {
    const v = makeTab(info.id, info.label);
    v.info = info;
    v.head = el("div", "agent-card");
    v.insights = el("div", "agent-card");
    v.dash = el("div", "dash");
    v.hist = el("div", "agent-card");
    v.tech = el("details", "agent-tech");
    [v.head, v.insights, v.dash, v.hist, v.tech].forEach(function (n) { v.panel.appendChild(n); });
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

  // ---------- Вміст вкладки агента ----------
  function renderHead(v) {
    const st = statusOf(v.info.id);
    const state = agentState(st);
    v.head.replaceChildren();
    const row = el("div", "agent-head");
    row.appendChild(el("h2", "agent-name", st ? st.title : v.info.label));
    row.appendChild(chip(state));
    v.head.appendChild(row);
    v.head.appendChild(el("p", "agent-task", v.info.task));
    v.head.appendChild(el("p", "small", st && st.last_ok ? "Дані оновлено " + ago(st.last_ok) : "Дані ще не оновлювалися"));
    v.tab.className = "agent-tab " + state;
  }

  function renderInsights(v) {
    const list = insightData[v.info.id] || [];
    v.insights.replaceChildren(el("h3", "agent-sub", "Висновки"));
    if (!list.length) { v.insights.appendChild(el("p", "small", "Висновків поки немає: агент ще не створив дані.")); return; }
    const ul = el("ul", "insights");
    list.forEach(function (x) {
      const li = el("li", "insight " + x.tone);
      const m = MARK[x.tone] || MARK.neutral;
      li.appendChild(el("span", "insight-mark", m[0]));
      li.appendChild(el("span", "sr-only", m[1] + ": "));
      li.appendChild(document.createTextNode(x.text));
      ul.appendChild(li);
    });
    v.insights.appendChild(ul);
    const ai = aiData[v.info.id];
    if (ai) {
      const box = el("div", "ai-note");
      box.appendChild(el("h4", "wsub", "Пояснення простими словами (ШІ)"));
      box.appendChild(el("p", "", ai.text));
      box.appendChild(el("p", "small", "Написано автоматично моделлю " + ai.model + " на основі висновків вище, " + ago(ai.at) + ". Може помилятися."));
      v.insights.appendChild(box);
    }
    v.insights.appendChild(el("p", "small", "Висновки складено автоматично за правилами й можуть помилятися. Це не фінансова порада."));
  }

  // Історія агента: одна точка на день (data/history/<агент>.json). Поки точок мало, пояснюємо, що вона накопичується.
  async function renderHistory(v) {
    let rows = [];
    try { rows = await loadJson("data/history/" + v.info.id + ".json"); } catch (e) { /* історії ще немає */ }
    v.hist.replaceChildren(el("h3", "agent-sub", "Історія по днях"));
    if (rows.length < 3) {
      v.hist.appendChild(el("p", "small", "Історія накопичується: зараз днів із даними — " + rows.length + ". Графіки з’являться, коли їх буде щонайменше три."));
      return;
    }
    const grid = el("div", "wcols");
    v.info.history.forEach(function (h) {
      const vals = rows.map(function (r) { return r.values[h.key]; }).filter(function (x) { return typeof x === "number"; });
      if (vals.length < 2) return;
      const c = el("div", "wcol");
      c.appendChild(el("h4", "wsub", h.title));
      c.appendChild(Charts.lineChart(vals, { color: "var(--accent)", label: h.title, h: 80 }));
      c.appendChild(el("p", "small", "Зараз " + fmtValue(h.fmt, vals[vals.length - 1]) + " · від " + fmtValue(h.fmt, Math.min.apply(null, vals)) +
        " до " + fmtValue(h.fmt, Math.max.apply(null, vals))));
      grid.appendChild(c);
    });
    v.hist.appendChild(grid);
    v.hist.appendChild(el("p", "small", "З " + rows[0].date + " по " + rows[rows.length - 1].date + " (" + rows.length + " точок; старіші дані стискаються самі)."));
  }

  function renderTech(v) {
    const st = statusOf(v.info.id);
    v.tech.replaceChildren(el("summary", "", "Технічні дані агента"));
    const dl = el("dl", "agent-facts");
    function fact(k, val, link) {
      dl.appendChild(el("dt", "", k));
      const dd = el("dd");
      if (link) { const a = el("a", "", val); a.href = link; dd.appendChild(a); } else dd.textContent = val;
      dl.appendChild(dd);
    }
    fact("Розклад", st ? "кожні " + fmtInterval(st.interval) + " (на GitHub: раз на ~10 хв)" : "—");
    fact("Джерело даних", st ? st.source : "—");
    v.info.files.forEach(function (f) { fact("Файл даних", "data/" + f + ".json", "data/" + f + ".json"); });
    if (v.info.knowledge) fact("База знань (пороги й тексти)", v.info.knowledge, v.info.knowledge);
    v.tech.appendChild(dl);
    if (st && st.error) v.tech.appendChild(el("p", "note", "Остання помилка: " + st.error));
  }

  function renderOverview() {
    const t = el("table", "agent-table");
    const head = el("tr");
    ["Агент", "Головний висновок", "Стан", "Оновлено"].forEach(function (h) { head.appendChild(el("th", "", h)); });
    t.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    INFO.forEach(function (info) {
      const st = statusOf(info.id);
      const first = (insightData[info.id] || [])[0];
      const tr = el("tr");
      const name = el("td");
      const b = el("button", "link-btn", st ? st.title : info.label);
      b.type = "button";
      b.addEventListener("click", function () { select(info.id, true); });
      name.appendChild(b);
      tr.appendChild(name);
      tr.appendChild(el("td", "", first ? first.text : "Даних ще немає"));
      tr.appendChild(el("td")).appendChild(chip(agentState(st)));
      tr.appendChild(el("td", "", st && st.last_ok ? ago(st.last_ok) : "—"));
      body.appendChild(tr);
      views[info.id].tab.className = "agent-tab " + agentState(st);
    });
    t.appendChild(body);
    views.all.table.replaceChildren(t);
  }

  function refreshView() {
    if (current === "all") { renderOverview(); return; }
    const v = views[current];
    renderHead(v);
    renderInsights(v);
    renderTech(v);
    renderHistory(v);
    if (v.widgets) v.widgets.refresh(agents);
  }

  async function loadInsights(info) {
    try {
      const d = await loadJson("data/" + info.insights + ".json");
      aiData[info.id] = d.ai_summary || null;
      insightData[info.id] = d.insights || (d.conclusions || []).map(function (t) { return { tone: "neutral", text: t }; });
    } catch (e) { insightData[info.id] = []; }
  }

  const fresh = document.getElementById("freshness");
  async function tick() {
    try { agents = await loadJson("data/agents.json"); } catch (e) { agents = null; }
    await Promise.all(INFO.map(loadInsights));
    INFO.forEach(function (i) { views[i.id].tab.className = "agent-tab " + agentState(statusOf(i.id)); });
    refreshView();
    if (fresh) renderFreshness(fresh, agents);
  }

  select(location.hash.slice(1) || "all", false);
  tick();
  setInterval(function () { if (!document.hidden) tick(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  window.addEventListener("hashchange", function () { select(location.hash.slice(1) || "all", false); });
})();
