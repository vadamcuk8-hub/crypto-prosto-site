// Аналітика, розділ «Загальна картина»: фон по кожній монеті зі зведених даних (сигнали, новини, настрій, потоки грошей).
// Дані готує агент «Картина» (tools/agents/agent_outlook.py → data/outlook.json). Це інформація, а не фінансова порада.
// Потребує agent-ui.js (el, ago, loadJson, safeUrl, isStale, REFRESH_MS), charts.js, chart-tool.js, help.js. Тексти вставляються через textContent.

(function () {
  const tilesEl = document.getElementById("outTiles");
  const grid = document.getElementById("outGrid");
  if (!grid) return;
  const MARK = { positive: ["▲", "Позитивно"], negative: ["▼", "Негативно"], neutral: ["●", "Нейтрально"] };
  const COMP = { technical: "Технічні", news: "Новини", mood: "Настрій", breadth: "Ширина", flows: "Гроші" };
  const COMP_HELP = {
    technical: "Оцінка технічних індикаторів монети: тренд, імпульс, перегрів",
    news: "Тон новин саме про цю монету за останні 48 годин (є лише коли новин достатньо)",
    mood: "Індекс страху й жадібності всього ринку",
    breadth: "Яка частка найбільших монет зростає за добу",
    flows: "Чи росте пропозиція стейблкоїнів: гроші заходять у ринок чи виходять",
  };
  let last = "";

  function sgn(v) { return (v > 0 ? "+" : "") + v; }

  function tile(title, value, help, cls) {
    const t = el("div", "ov-tile");
    const h = el("h3", "ov-title", title);
    if (help) h.appendChild(Help.icon(help));
    t.appendChild(h);
    t.appendChild(el("b", "out-big " + (cls || ""), value));
    return t;
  }

  function card(c) {
    const d = el("article", "out-card " + c.label_key);
    const head = el("div", "sig-head");
    const name = el("div");
    name.appendChild(el("h3", "sig-sym", c.symbol));
    name.appendChild(el("span", "small", c.name));
    head.appendChild(name);
    const open = el("button", "ov-coin " + (c.score >= 10 ? "pos" : c.score <= -10 ? "neg" : ""), (c.score > 0 ? "+" : "") + c.score);
    open.type = "button";
    open.setAttribute("data-help", "Загальна оцінка фону від −100 до +100. Натисніть, щоб відкрити біржовий графік " + c.symbol);
    open.addEventListener("click", function () { ChartTool.open({ symbol: c.symbol, name: c.name }); });
    head.appendChild(open);
    d.appendChild(head);
    d.appendChild(el("div", "out-label " + c.label_key, c.label));
    d.appendChild(Charts.signalGauge(c.score, c.label_key));

    const chips = el("div", "out-chips");
    Object.keys(c.components).forEach(function (k) {
      const v = c.components[k];
      const chip = el("span", "chip " + (v > 10 ? "ok" : v < -10 ? "failed" : ""), COMP[k] + " " + sgn(v));
      chip.tabIndex = 0;
      chip.setAttribute("data-help", COMP_HELP[k] + ": " + sgn(v) + " із ±100");
      chips.appendChild(chip);
    });
    d.appendChild(chips);

    if (c.headlines.length) {
      const ul = el("ul", "out-news");
      c.headlines.slice(0, 2).forEach(function (h) {
        const li = el("li", h.tone);
        const a = el("a", "", h.title);
        a.href = safeUrl(h.link); a.target = "_blank"; a.rel = "noopener noreferrer";
        li.appendChild(a);
        li.appendChild(el("span", "small", " — " + h.source + ", " + ago(h.published) + (h.confirmations > 1 ? ", підтвердили " + h.confirmations : "")));
        ul.appendChild(li);
      });
      d.appendChild(ul);
    } else {
      d.appendChild(el("p", "small", "Свіжих новин про цю монету немає"));
    }

    const more = el("details", "sig-more");
    more.appendChild(el("summary", "", "Чому така оцінка"));
    const ul = el("ul", "insights");
    c.factors.forEach(function (f) {
      const li = el("li", "insight " + f.tone);
      const m = MARK[f.tone] || MARK.neutral;
      li.appendChild(el("span", "insight-mark", m[0]));
      li.appendChild(el("span", "sr-only", m[1] + ": "));
      li.appendChild(document.createTextNode(f.text));
      ul.appendChild(li);
    });
    more.appendChild(ul);
    more.appendChild(el("p", "small", c.agree ? "Чинники збігаються." : "Чинники суперечать одне одному."));
    d.appendChild(more);
    return d;
  }

  async function refresh() {
    try {
      const o = await loadJson("data/outlook.json");
      if (o.generated_at === last) return;
      last = o.generated_at;
      const m = o.market;
      tilesEl.replaceChildren(
        tile("Настрій ринку", m.mood + " · " + m.mood_label.toLowerCase(), "Індекс страху й жадібності від 0 до 100" + (m.extreme ? ". Екстремальний рівень: оцінки монет зменшено" : "")),
        tile("Ширина ринку", m.breadth_share + "%", "Яка частка найбільших монет зростає за добу"),
        tile("Гроші в ринку", m.stable_change30 === null ? "—" : sgn(m.stable_change30) + "%", "Зміна пропозиції стейблкоїнів за 30 днів: плюс означає, що гроші заходять", m.stable_change30 > 0 ? "tone-positive" : m.stable_change30 < 0 ? "tone-negative" : ""),
        tile("Новин за " + o.window_hours + " год", String(m.news_total), "Скільки новин із доданих джерел пройшло відбір агента"),
        tile("Самонавчання", o.learning.evaluated + " перевірок", (o.insights.length ? o.insights[o.insights.length - 1].text : "") +
          " Ваги чинників зараз: " + Object.keys(o.learning.weights).map(function (k) { return COMP[k] + " " + Math.round(o.learning.weights[k] * 100) + "%"; }).join(", ") + "."),
        tile("Довіра до картини", o.reliability === "low" ? "низька" : "помірна", o.reliability_text + " " + o.disclaimer, o.reliability === "low" ? "tone-negative" : "")
      );
      grid.replaceChildren();
      o.coins.forEach(function (c) { grid.appendChild(card(c)); });
    } catch (e) {
      grid.replaceChildren(el("p", "note", "Немає даних"));
    }
  }

  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
