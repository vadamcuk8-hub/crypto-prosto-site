// Сторінка «Аналітика» (analytics.html): висновки, теми, тон, монети, активність, найважливіші історії.
// Потребує agent-ui.js (el, safeUrl, ago, loadJson).

(function () {
  // ======================= Аналітика (analytics.html) =======================
  const concl = document.getElementById("conclusions");
  if (concl) {
    const statusEl = document.getElementById("anStatus");

    function bars(box, entries, total, labelFn, colorFn) {
      box.innerHTML = "";
      entries.forEach(function (e) {
        const row = el("div", "bar-row");
        row.appendChild(el("span", "bar-label", labelFn(e[0])));
        const track = el("span", "bar-track");
        const fill = el("span", "bar-fill");
        fill.style.width = Math.max(3, Math.round((100 * e[1]) / (total || 1))) + "%";
        if (colorFn) fill.style.background = colorFn(e[0]);
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el("span", "bar-val", String(e[1])));
        box.appendChild(row);
      });
      if (!entries.length) box.appendChild(el("p", "muted", "Даних поки немає."));
    }

    function activityChart(box, hours) {
      const W = 600, H = 120, max = Math.max.apply(null, hours.concat([1]));
      const bw = W / hours.length;
      let svg = '<svg viewBox="0 0 ' + W + " " + (H + 20) + '" role="img" aria-label="Кількість новин по годинах за добу">';
      hours.forEach(function (v, i) {
        const h = (v / max) * H;
        svg += '<rect x="' + (i * bw + 2) + '" y="' + (H - h) + '" width="' + (bw - 4) + '" height="' + h + '" rx="3" style="fill:var(--accent)"><title>' + v + "</title></rect>";
      });
      svg += '<text x="0" y="' + (H + 15) + '" style="fill:var(--muted);font-size:12px">24 год тому</text>' +
        '<text x="' + W + '" y="' + (H + 15) + '" text-anchor="end" style="fill:var(--muted);font-size:12px">зараз</text></svg>';
      box.innerHTML = svg; // тут лише числа, а не тексти з новин
    }

    function storyList(box, items, withScore) {
      box.innerHTML = "";
      items.forEach(function (i) {
        const li = el("li");
        const a = el("a", "", i.title_uk || i.title);
        a.href = safeUrl(i.link);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        if (i.title_uk) a.lang = "uk";
        li.appendChild(a);
        li.appendChild(el("span", "small", " — " + i.source + ", " + ago(i.published) +
          (withScore ? ", важливість " + i.importance + "/100, джерел: " + i.confirmations : "")));
        box.appendChild(li);
      });
      if (!items.length) box.appendChild(el("li", "muted", "Немає."));
    }

    const TONE = { positive: "Позитивні", neutral: "Нейтральні", negative: "Негативні" };
    const TONE_COLOR = { positive: "var(--up)", neutral: "var(--accent)", negative: "var(--down)" };
    let lastGenerated = "";
    let lastHours = [];   // коли агент востаннє оновлював аналітику (щоб не перебудовувати однакове)

    async function refresh() {
      try {
        const a = await loadJson("data/analytics.json");
        const labels = a.labels || {};
        const hours = (Date.now() - new Date(a.generated_at).getTime()) / 3600000;
        statusEl.textContent = "● Аналіз оновлено " + ago(a.generated_at) + (hours > STALE_HOURS ? ". Дані застаріли: запустіть start-agents.bat." : ". Сторінка оновлюється сама.");
        statusEl.className = "feed-status " + (hours > STALE_HOURS ? "off" : "live");
        if (a.generated_at === lastGenerated) return;   // агент нічого нового не підготував: сторінку не перебудовуємо
        lastGenerated = a.generated_at;

        concl.innerHTML = "";
        a.conclusions.forEach(function (c) { concl.appendChild(el("li", "", c)); });

        const t = document.getElementById("anTiles");
        t.innerHTML = "";
        [["Матеріалів", a.total, "за " + a.window_hours + " год"],
         ["Джерел працює", a.sources.filter(function (s) { return s.ok; }).length + " / " + a.sources.length, "з відстежуваних"],
         ["Відсіяно реклами", a.filters.hype, "«хайп» і платні тексти"],
         ["Повторів злито", a.filters.merged, "одна історія з різних видань"]].forEach(function (x) {
          const d = el("div", "plan-card");
          d.appendChild(el("div", "small", x[0]));
          d.appendChild(el("div", "plan-big", String(x[1])));
          d.appendChild(el("div", "small", x[2]));
          t.appendChild(d);
        });

        bars(document.getElementById("topicBars"),
          Object.entries(a.by_topic).sort(function (x, y) { return y[1] - x[1]; }), a.total,
          function (k) { return labels[k] || k; });
        bars(document.getElementById("sentBars"),
          ["positive", "neutral", "negative"].map(function (k) { return [k, a.sentiment[k] || 0]; }), a.total,
          function (k) { return TONE[k]; }, function (k) { return TONE_COLOR[k]; });
        bars(document.getElementById("sourceBars"),
          Object.entries(a.by_source).sort(function (x, y) { return y[1] - x[1]; }), a.total,
          function (k) { return k; });

        const coinBox = document.getElementById("coinList");
        coinBox.innerHTML = "";
        Object.entries(a.coins).slice(0, 8).forEach(function (e) {
          const s = e[1].sentiment;
          const d = el("div", "plan-card");
          if (e[0] !== "USDT" && e[0] !== "USDC") ChartTool.bind(d, function () { return { symbol: e[0], name: e[0] }; }, "Відкрити графік " + e[0] + " наживо");
          d.appendChild(el("div", "plan-big", e[0]));
          d.appendChild(el("div", "small", "згадок: " + e[1].count));
          d.appendChild(el("div", "small " + (s > 1 ? "tone-positive" : s < -1 ? "tone-negative" : ""), s > 1 ? "новини радше позитивні" : s < -1 ? "новини радше негативні" : "новини нейтральні"));
          coinBox.appendChild(d);
        });

        activityChart(document.getElementById("activity"), a.activity_24h);
        const actBox = document.getElementById("activityBox");
        if (actBox && !actBox.classList.contains("ct-open")) {
          ChartTool.bind(actBox, function () {
            const t0 = Date.parse(lastGenerated) || Date.now();
            return { id: "news-activity", title: "Матеріалів у новинах щогодини", format: function (v) { return "матеріалів: " + v.toLocaleString("uk-UA"); },
              points: lastHours.map(function (v, i) { return { t: t0 - (23 - i) * 36e5, c: v }; }), source: "Джерело: новинний агент сайту." };
          }, "Відкрити графік активності новин");
        }
        lastHours = a.activity_24h;
        storyList(document.getElementById("topStories"), a.top, true);
        storyList(document.getElementById("needsCheck"), a.needs_check, false);

        const tb = document.querySelector("#sourceTable tbody");
        tb.innerHTML = "";
        a.sources.forEach(function (s) {
          const tr = el("tr");
          tr.appendChild(el("td", "", s.name));
          tr.appendChild(el("td", "", s.ok ? "працює" : "помилка"));
          tr.appendChild(el("td", "", String(s.count)));
          tr.appendChild(el("td", "score", String(s.weight)));
          tb.appendChild(tr);
        });
      } catch (e) {
        statusEl.textContent = "Аналітику не завантажено";
        statusEl.className = "feed-status off";
        concl.innerHTML = "";
        concl.appendChild(el("li", "", HELP));
      }
    }

    refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);   // у прихованій вкладці дані не качаємо
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  }
})();
