// Визначення віджетів: що малює кожен віджет і з якого агента беруться дані (agent) та файлів data/<файл>.json (files).
// Потребує core.js (fmtOnlyUsd, pct), charts.js і agent-ui.js (el, ago, safeUrl).
// Усі тексти з даних вставляються через textContent; у SVG потрапляють лише числа.

const WIDGET_DEFS = (function () {
  const { fmtNum, fmtBig, trendColor, lineChart, sparkline, barChart, donut, hBars, stat, note } = Charts;

  return [
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
      id: "regulation", title: "Регулювання: документи США", agent: "regulation", files: ["regulation"], wide: true,
      render: function (b, d) {
        const r = d.regulation, s = r.stats || { d7: 0, d30: 0, prev30: 0 };
        const diff = s.d30 - s.prev30;
        const stats = el("div", "wstats");
        stats.appendChild(stat("За 7 днів", String(s.d7)));
        stats.appendChild(stat("За 30 днів", String(s.d30)));
        stats.appendChild(stat("Проти попередніх 30 днів", (diff > 0 ? "+" : "") + diff));
        stats.appendChild(stat("Усього в базі", fmtNum(r.total_all_time)));
        b.appendChild(stats);

        function col(title, node) {
          const c = el("div", "wcol");
          c.appendChild(el("h4", "wsub", title));
          c.appendChild(node);
          return c;
        }
        function counts(list, color) {
          return hBars((list || []).map(function (x) { return { label: x.label, value: x.count, text: String(x.count), color: color }; }));
        }
        const cols = el("div", "wcols");
        cols.appendChild(col("Документи по тижнях (12 тижнів)", barChart(r.weeks, { label: "Кількість документів по тижнях" })));
        cols.appendChild(col("Типи документів (90 днів)", counts(r.by_type, "var(--accent)")));
        cols.appendChild(col("Які відомства (90 днів)", counts(r.by_agency, "var(--accent)")));
        cols.appendChild(col("Про що (90 днів)", counts(r.by_topic, "var(--accent)")));
        b.appendChild(cols);

        b.appendChild(el("h4", "wsub", "Останні документи"));
        const list = el("div", "doc-list");
        r.latest.slice(0, 6).forEach(function (x) {
          const card = el("article", "doc-card");
          const tags = el("div", "doc-tags");
          tags.appendChild(el("span", "chip", x.type));
          tags.appendChild(el("span", "chip", x.topic));
          tags.appendChild(el("span", "small", x.date));
          card.appendChild(tags);
          const a = el("a", "doc-title", x.title);
          a.href = safeUrl(x.url); a.target = "_blank"; a.rel = "noopener noreferrer";
          a.lang = "en"; a.title = x.title_full || x.title;
          card.appendChild(a);
          card.appendChild(el("p", "doc-agency", x.agency));
          card.appendChild(el("p", "small", x.topic_hint + " " + x.type_hint));
          list.appendChild(card);
        });
        b.appendChild(list);
        const teach = r.to_teach || [], stale = r.stale_rules || [];
        if (teach.length || stale.length) {
          const box = el("details", "teach");
          box.appendChild(el("summary", "", "База знань: " + teach.length + " документів без теми" + (stale.length ? ", застарілих правил: " + stale.length : "")));
          if (teach.length) {
            box.appendChild(el("p", "small", "Агент не знайшов для них правила. Щоб навчити його, додайте слово з назви й тему у файл knowledge/regulation.json (розділ «overrides»)."));
            const ul = el("ul", "wlinks");
            teach.forEach(function (x) {
              const li = el("li", "", x.title);
              li.appendChild(el("span", "small", " — " + x.agency + ", " + x.date));
              ul.appendChild(li);
            });
            box.appendChild(ul);
          }
          if (stale.length) {
            box.appendChild(el("p", "small", "Ці виправлення не спрацьовували понад 180 днів. Їх можна видалити з файлу, щоб база не розросталась:"));
            const ul = el("ul", "wlinks");
            stale.forEach(function (x) { ul.appendChild(el("li", "", "«" + x.contains + "» → " + x.topic + " (останній збіг: " + x.last_matched + ")")); });
            box.appendChild(ul);
          }
          b.appendChild(box);
        }
        b.appendChild(note("Назви документів — англійською, як в оригіналі. Тема й пояснення визначені за правилами (не ШІ) і можуть помилятися; відкрийте оригінал, щоб перевірити."));
      },
    },
    {
      id: "signals", title: "Сигнали по монетах (інформація, не порада)", agent: "signals", files: ["signals"], wide: true,
      render: function (b, d) {
        const s = d.signals;
        const list = el("div", "wrows sig-rows");
        s.coins.forEach(function (c) {
          const row = el("div", "sig-row");
          const name = el("div", "wrow-name");
          name.appendChild(el("b", "", c.symbol));
          name.appendChild(el("span", "small", c.name));
          row.appendChild(name);
          row.appendChild(Charts.signalGauge(c.score, c.signal));
          row.appendChild(el("span", "sig-label " + (c.tilt ? "tilt" : c.signal), c.tilt ? s.labels["tilt_" + c.tilt] : s.labels[c.signal]));
          list.appendChild(row);
        });
        b.appendChild(list);
        b.appendChild(note(s.disclaimer));
        const more = el("p", "small");
        const l = el("a", "", "Докладно по кожній монеті"); l.href = "analytics.html#signals";
        more.appendChild(l);
        b.appendChild(more);
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
})();
