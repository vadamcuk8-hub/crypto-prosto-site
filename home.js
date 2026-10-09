// Головна: панель віджетів + загальний рядок «Дані оновлено …».
// Потребує agent-ui.js, charts.js, widget-defs.js, widgets.js.

(function () {
  const box = document.getElementById("dashboard");
  if (!box) return;
  const panel = Widgets.mount(box, WIDGET_DEFS);
  const line = document.getElementById("freshness");

  async function refreshAll() {
    let agents = null;
    try { agents = await loadJson("data/agents.json"); } catch (e) { /* статус необов'язковий */ }
    panel.refresh(agents);
    if (line) renderFreshness(line, agents);
  }

  refreshAll();
  setInterval(function () { if (!document.hidden) refreshAll(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshAll(); });
})();
