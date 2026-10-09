// Головна сторінка: панель віджетів із графіками. Кожен віджет читає дані СВОГО агента (tools/agents/…) і не залежить від решти:
// якщо один агент не відповів, лише його віджет покаже повідомлення, а інші працюють.
// Потребує core.js (setText, fmtOnlyUsd, pct), charts.js і agent-ui.js (el, ago, loadJson, safeUrl, REFRESH_MS).
// Усі тексти з даних вставляються через textContent; у SVG потрапляють лише числа.

(function () {
  const box = document.getElementById("dashboard");
  if (!box) return;

  const { sv, fmtNum, fmtBig, trendColor, lineChart, sparkline, barChart, donut, hBars, stat, note } = Charts;

  // ---------- Віджети ----------
  const WIDGETS = [
    {
      id: "overview", title: "Ринок у цифрах", agent: "market", files: ["market"],
      render: function (b, d) {
        const g = d.market.global;
        const stats = el("div", "wstats");
        stats.appendChild(stat("Капіталізація", fmtBig(g.market_cap)));
        stats.appendChild(stat("Обсяг торгів за добу", fmtBig(g.volume)));
        stats.appendChild(stat("Зміна за 24 год", pct(g.change24h), g.change24h >= 0 ? "tone-positive" : "tone-negative"));
        b.appendChild(stats);
        const row = el("div", "wdonut-row");
        row.appendChild(donut([
          { value: g.btc_dominance, color: "#c9a24d" }, { value: g.eth_dominance, color: "#8089b8" }, { value: g.other_dominance, color: "var(--accent)" }]));
        const legend = el("ul", "wlegend");
        [["Біткоїн", g.btc_dominance, "#c9a24d"], ["Ефіріум", g.eth_dominance, "#8089b8"], ["Інші монети", g.other_dominance, "var(--accent)"]].forEach(function (x) {
          const li = el("li", "");
          const dot = el("span", "wdot"); dot.style.background = x[2];
          li.appendChild(dot);
          li.appendChild(document.createTextNode(x[0] + ": " + fmtNum(x[1], 1) + "%"));
          legend.appendChild(li);
        });
        row.appendChild(legend);
        b.appendChild(row);
        b.appendChild(note("Частка кожної групи у загальній капіталізації. Усього монет у обігу: " + fmtNum(g.active_coins) + "."));
      },
    },
    {
      id: "top", title: "Найбільші монети (за 7 днів)", agent: "market", files: ["market"], wide: true,
      render: function (b, d) {
        const list = el("div", "wrows");
        d.market.top.forEach(function (c) {
          const row = el("div", "wrow");
          const name = el("div", "wrow-name");
          name.appendChild(el("b", "", c.symbol));
          name.appendChild(el("span", "small", c.name));
          row.appendChild(name);
          row.appendChild(el("div", "wrow-price", fmtOnlyUsd(c.price)));
          row.appendChild(el("div", "wrow-ch " + (c.change24h >= 0 ? "tone-positive" : "tone-negative"), pct(c.change24h || 0)));
          const sp = el("div", "wrow-spark");
          sp.appendChild(sparkline(c.spark, trendColor(c.change7d || 0)));
          row.appendChild(sp);
          list.appendChild(row);
        });
        b.appendChild(list);
        b.appendChild(note("Зміна за добу — у кольоровій плитці, мініграфік показує 7 днів. Стейблкоїни не показано."));
      },
    },
    {
      id: "movers", title: "Лідери дня серед топ-50", agent: "market", files: ["market"],
      render: function (b, d) {
        b.appendChild(el("h4", "wsub tone-positive", "Зростання"));
        b.appendChild(hBars(d.market.gainers.map(function (c) { return { label: c.symbol, value: c.change24h, text: pct(c.change24h), color: "var(--up)" }; })));
        b.appendChild(el("h4", "wsub tone-negative", "Падіння"));
        b.appendChild(hBars(d.market.losers.map(function (c) { return { label: c.symbol, value: c.change24h, text: pct(c.change24h), color: "var(--down)" }; })));
      },
    },
    {
      id: "sentiment", title: "Страх і жадібність", agent: "sentiment", files: ["sentiment"],
      render: function (b, d) {
        const s = d.sentiment;
        const head = el("div", "wbig");
        head.appendChild(el("span", "fng-value", s.value + " / 100"));
        head.appendChild(document.createTextNode(" "));
        head.appendChild(el("b", "", s.label));
        b.appendChild(head);
        const gauge = el("div", "gauge");
        const marker = el("div", "gauge-marker");
        marker.style.left = "0%";
        gauge.appendChild(marker);
        b.appendChild(gauge);
        setTimeout(function () { marker.style.left = s.value + "%"; }, 80);
        const scale = el("div", "gauge-scale");
        ["Страх", "Нейтрально", "Жадібність"].forEach(function (t) { scale.appendChild(el("span", "", t)); });
        b.appendChild(scale);
        b.appendChild(lineChart(s.history.map(function (h) { return h.v; }), { color: "var(--accent)", label: "Індекс страху й жадібності за 30 днів" }));
        const stats = el("div", "wstats");
        stats.appendChild(stat("Вчора", s.yesterday === null ? "—" : String(s.yesterday)));
        stats.appendChild(stat("Тиждень тому", s.week_ago === null ? "—" : String(s.week_ago)));
        stats.appendChild(stat("Середнє за 30 днів", fmtNum(s.avg30, 0)));
        b.appendChild(stats);
      },
    },
    {
      id: "stable", title: "Стейблкоїни", agent: "stablecoins", files: ["stablecoins"],
      render: function (b, d) {
        const s = d.stablecoins;
        const stats = el("div", "wstats");
        stats.appendChild(stat("Загальна пропозиція", fmtBig(s.total)));
        stats.appendChild(stat("За 30 днів", s.change30 === null ? "—" : pct(s.change30), s.change30 >= 0 ? "tone-positive" : "tone-negative"));
        b.appendChild(stats);
        b.appendChild(lineChart(s.history, { color: "var(--up)", label: "Загальна пропозиція стейблкоїнів, останні ~4 місяці" }));
        b.appendChild(hBars(s.top.map(function (t) { return { label: t.symbol, value: t.supply, text: fmtNum(t.share, 1) + "%", color: "var(--accent)" }; })));
        b.appendChild(note("Стейблкоїн — цифрова монета, прив’язана до долара. Частки — від усієї пропозиції."));
      },
    },
    {
      id: "network", title: "Мережа біткоїна", agent: "network", files: ["network"],
      render: function (b, d) {
        const n = d.network;
        b.appendChild(el("h4", "wsub", "Комісія за переказ (сатоші за байт)"));
        const labels = [["fastestFee", "Швидко"], ["halfHourFee", "30 хв"], ["hourFee", "1 год"], ["economyFee", "Економно"]];
        b.appendChild(hBars(labels.map(function (l) { return { label: l[1], value: n.fees[l[0]] || 0, text: String(n.fees[l[0]]), color: "var(--accent)" }; })));
        const stats = el("div", "wstats");
        stats.appendChild(stat("Транзакцій у черзі", fmtNum(n.mempool.count)));
        stats.appendChild(stat("Висота блоку", fmtNum(n.height)));
        stats.appendChild(stat("Потужність", fmtNum(n.hashrate_ehs, 0) + " EH/с"));
        b.appendChild(stats);
        b.appendChild(lineChart(n.hashrate_history, { color: "var(--accent)", label: "Потужність майнінгу за 3 місяці" }));
        b.appendChild(note("Чим довша черга й вища комісія, тим дорожче й повільніше проходять перекази."));
      },
    },
    {
      id: "regulation", title: "Регулювання: документи США", agent: "regulation", files: ["regulation"],
      render: function (b, d) {
        const r = d.regulation;
        b.appendChild(el("h4", "wsub", "Нові документи про крипто по тижнях (12 тижнів)"));
        b.appendChild(barChart(r.weeks, { label: "Кількість документів про крипто в Federal Register по тижнях" }));
        const list = el("ul", "wlinks");
        r.latest.slice(0, 5).forEach(function (x) {
          const li = el("li", "");
          const a = el("a", "", x.title);
          a.href = safeUrl(x.url); a.target = "_blank"; a.rel = "noopener noreferrer";
          li.appendChild(a);
          li.appendChild(el("span", "small", " — " + x.type + ", " + x.date));
          list.appendChild(li);
        });
        b.appendChild(list);
        b.appendChild(note("Назви документів — англійською, як в оригіналі. Усього в базі: " + fmtNum(r.total_all_time) + "."));
      },
    },
    {
      id: "news", title: "Новини: головне зараз", agent: "news", files: ["analytics"], wide: true,
      render: function (b, d) {
        const a = d.analytics;
        const ul = el("ul", "wlinks");
        a.top.slice(0, 5).forEach(function (s) {
          const li = el("li", "");
          const link = el("a", "", s.title_uk || s.title);
          link.href = safeUrl(s.link); link.target = "_blank"; link.rel = "noopener noreferrer";
          if (s.title_uk) link.lang = "uk";
          li.appendChild(link);
          li.appendChild(el("span", "small", " — " + s.source + ", " + ago(s.published)));
          ul.appendChild(li);
        });
        b.appendChild(ul);
        b.appendChild(el("h4", "wsub", "Скільки матеріалів виходило щогодини за добу"));
        b.appendChild(barChart(a.activity_24h, { label: "Активність новин за останні 24 години" }));
        if (a.conclusions && a.conclusions[1]) b.appendChild(note(a.conclusions[1]));
        const more = el("p", "small");
        const l1 = el("a", "", "Усі новини"); l1.href = "news.html";
        const l2 = el("a", "", "Аналітика"); l2.href = "analytics.html";
        more.appendChild(l1); more.appendChild(document.createTextNode(" · ")); more.appendChild(l2);
        b.appendChild(more);
      },
    },
  ];

  // ---------- Каркас віджета ----------
  const cards = {};
  WIDGETS.forEach(function (w) {
    const card = el("article", "widget" + (w.wide ? " w2" : ""));
    card.id = "w-" + w.id;
    card.appendChild(el("h3", "widget-title", w.title));
    const body = el("div", "widget-body", "Завантаження…");
    body.classList.add("loading");
    const foot = el("p", "widget-foot");
    card.appendChild(body);
    card.appendChild(foot);
    box.appendChild(card);
    cards[w.id] = { card: card, body: body, foot: foot, sig: "" };
  });

  // Підпис під віджетом: який агент, звідки дані, коли оновлено, чи не застарів
  function footer(w, agents, generatedAt) {
    const st = agents && agents.agents ? agents.agents[w.agent] : null;
    const c = cards[w.id];
    const stale = st && generatedAt && (Date.now() - new Date(generatedAt).getTime()) / 1000 > st.interval * 3;
    const failed = st && !st.ok;
    c.foot.className = "widget-foot" + (stale || failed ? " bad" : "");
    c.foot.textContent = "Агент «" + (st ? st.title : w.agent) + "»" + (st ? " · " + st.source : "") +
      (generatedAt ? " · оновлено " + ago(generatedAt) : "") +
      (stale ? ". Дані застаріли" : "") + (failed ? ". Останній запуск не вдався" : "");
  }

  async function load(name) {
    return loadJson("data/" + name + ".json");
  }

  async function refreshWidget(w, agents) {
    const c = cards[w.id];
    try {
      const parts = await Promise.all(w.files.map(load));
      const data = {};
      w.files.forEach(function (f, i) { data[f] = parts[i]; });
      const stamp = parts[0].generated_at || parts[0].updated;
      const sig = w.files.map(function (f, i) { return parts[i].generated_at; }).join("|");
      if (sig !== c.sig) {                       // перемальовуємо лише коли агент справді оновив дані
        c.sig = sig;
        c.body.classList.remove("loading");
        c.body.replaceChildren();
        w.render(c.body, data);
      }
      footer(w, agents, stamp);
    } catch (e) {
      if (!c.sig) {
        c.body.classList.remove("loading");
        c.body.replaceChildren(el("p", "note", "Дані цього агента ще не створено. Запустіть start-agents.bat, а сайт відкривайте через локальний сервер."));
      }
      footer(w, agents, null);
    }
  }

  async function refreshAll() {
    let agents = null;
    try { agents = await loadJson("data/agents.json"); } catch (e) { /* статус необов'язковий */ }
    WIDGETS.forEach(function (w) { refreshWidget(w, agents); });
  }

  refreshAll();
  setInterval(function () { if (!document.hidden) refreshAll(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshAll(); });
})();
