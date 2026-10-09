// Аналітика, розділ «Звіт по ринку»: щоденний звіт агента «Звіт» (tools/agents/agent_report.py → data/report.json) і архів днів.
// Можна обрати день, зберегти звіт у файл (.md) чи скопіювати текст. Це інформація, а не фінансова порада.
// Потребує agent-ui.js (el, loadJson, REFRESH_MS), help.js. Тексти вставляються через textContent.

(function () {
  const body = document.getElementById("repBody");
  if (!body) return;
  const sel = document.getElementById("repDate");
  const saveBtn = document.getElementById("repSave");
  const copyBtn = document.getElementById("repCopy");
  let data = null, shown = null, last = "";

  function toMarkdown(day) {
    const lines = ["# Звіт по ринку, " + day.date, ""];
    day.sections.forEach(function (s) {
      lines.push("## " + s.title);
      s.lines.forEach(function (x) { lines.push("- " + x); });
      lines.push("");
    });
    return lines.join("\n");
  }

  function render(day) {
    shown = day;
    body.replaceChildren();
    body.appendChild(el("p", "rep-head " + (day.sections[0] ? day.sections[0].tone : "neutral"), day.headline));
    const grid = el("div", "rep-grid");
    day.sections.slice(1).forEach(function (s) {
      const box = el("div", "rep-sec " + (s.id === "watch" ? "watch" : s.tone));
      box.appendChild(el("h3", "rep-title", s.title));
      const ul = el("ul", "rep-list");
      s.lines.forEach(function (x) { ul.appendChild(el("li", "", x)); });
      box.appendChild(ul);
      grid.appendChild(box);
    });
    body.appendChild(grid);
  }

  function fillSelect(r) {
    sel.replaceChildren();
    r.archive.slice().reverse().forEach(function (a, i) {
      const o = el("option", "", a.date + (i === 0 ? " (сьогодні)" : ""));
      o.value = a.date;
      sel.appendChild(o);
    });
  }

  sel.addEventListener("change", function () {
    const day = data.archive.filter(function (a) { return a.date === sel.value; })[0];
    if (day) render(day);
  });

  saveBtn.addEventListener("click", function () {
    if (!shown) return;
    const blob = new Blob([toMarkdown(shown)], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "zvit-" + shown.date + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  copyBtn.addEventListener("click", function () {
    if (!shown) return;
    const done = function () { copyBtn.textContent = "Скопійовано"; setTimeout(function () { copyBtn.textContent = "Копіювати текст"; }, 1800); };
    if (typeof copyText === "function") Promise.resolve(copyText(toMarkdown(shown))).then(done, done);
    else if (navigator.clipboard) navigator.clipboard.writeText(toMarkdown(shown)).then(done, function () {});
  });

  async function refresh() {
    try {
      const r = await loadJson("data/report.json");
      if (r.generated_at === last) return;
      last = r.generated_at;
      const keep = sel.value;
      data = r;
      fillSelect(r);
      const today = r.archive[r.archive.length - 1];
      const day = keep ? (r.archive.filter(function (a) { return a.date === keep; })[0] || today) : today;
      sel.value = day.date;
      render(day);
    } catch (e) {
      body.replaceChildren(el("p", "note", "Звіту ще немає"));
    }
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
