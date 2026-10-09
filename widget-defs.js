// Визначення віджетів: що малює кожен віджет і з якого агента беруться дані (agent) та файлів data/<файл>.json (files).
// Потребує core.js (fmtOnlyUsd, pct), charts.js і agent-ui.js (el, ago, safeUrl).
// Усі тексти з даних вставляються через textContent; у SVG потрапляють лише числа.

const WIDGET_DEFS = (function () {
  const { fmtNum, fmtBig, trendColor, lineChart, sparkline, barChart, donut, hBars, stat, note } = Charts;

  // Обгортка: діаграма стає клікабельною й відкривається у великому вікні (масштаб, лінії, лінійка)
  function openable(chart, getSpec, label) {
    const w = el("div", "chart-open");
    w.appendChild(chart);
    return ChartTool.bind(w, getSpec, label);
  }
  // Ряд значень (з часовими мітками, якщо вони є) → опис для вікна графіка
  function seriesSpec(id, title, values, times, format, source) {
    return function () {
      return { id: id, title: title, points: values.map(function (v, i) { return { t: times ? times[i] : null, c: v }; }), format: format, source: source };
    };
  }
  const coinSpec = function (c) { return function () { return { symbol: c.symbol, name: c.name || c.symbol }; }; };

  return [
    {
      id: "overview", title: "Ринок у цифрах", help: "Загальна вартість усіх криптовалют, обсяг торгів і частка біткоїна та ефіріуму в ринку. Джерело: CoinGecko.", agent: "market", files: ["market"],
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
      },
    },
    {
      id: "top", title: "Найбільші монети (за 7 днів)", help: "Зміна за добу показана кольором, мініграфік — 7 днів. Натисніть на рядок, щоб відкрити графік монети наживо з біржі Binance. Стейблкоїни не показано.", agent: "market", files: ["market"], wide: true, skipHome: true,
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
          ChartTool.bind(row, function () {
            const now = Date.now(), n = c.spark.length;
            return { symbol: c.symbol, name: c.name, fallback: c.spark.map(function (v, i) { return { t: now - (n - 1 - i) * 7 * 864e5 / (n - 1), c: v }; }) };
          }, "Відкрити графік " + c.symbol);
          list.appendChild(row);
        });
        b.appendChild(list);
      },
    },
    {
      id: "movers", title: "Лідери дня серед топ-50", help: "Хто найбільше виріс і впав за добу серед 50 найбільших монет. Натисніть на рядок, щоб відкрити графік.", agent: "market", files: ["market"],
      render: function (b, d) {
        b.appendChild(el("h4", "wsub tone-positive", "Зростання"));
        b.appendChild(hBars(d.market.gainers.map(function (c) { return { label: c.symbol, value: c.change24h, text: pct(c.change24h), color: "var(--up)", open: coinSpec(c) }; })));
        b.appendChild(el("h4", "wsub tone-negative", "Падіння"));
        b.appendChild(hBars(d.market.losers.map(function (c) { return { label: c.symbol, value: c.change24h, text: pct(c.change24h), color: "var(--down)", open: coinSpec(c) }; })));
      },
    },
    {
      id: "sentiment", title: "Страх і жадібність", help: "Індекс від 0 до 100: низько означає страх, високо жадібність. Натисніть на графік, щоб відкрити його у великому вікні.", agent: "sentiment", files: ["sentiment"],
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
        b.appendChild(openable(lineChart(s.history.map(function (h) { return h.v; }), { color: "var(--accent)", label: "Індекс страху й жадібності за 30 днів" }),
          seriesSpec("sentiment", "Індекс страху й жадібності", s.history.map(function (h) { return h.v; }), s.history.map(function (h) { return h.t * 1000; }),
            function (v) { return fmtNum(v, 0) + " / 100"; }, "Джерело: Alternative.me."), "Відкрити графік індексу страху й жадібності"));
        const stats = el("div", "wstats");
        stats.appendChild(stat("Вчора", s.yesterday === null ? "—" : String(s.yesterday)));
        stats.appendChild(stat("Тиждень тому", s.week_ago === null ? "—" : String(s.week_ago)));
        stats.appendChild(stat("Середнє за 30 днів", fmtNum(s.avg30, 0)));
        b.appendChild(stats);
      },
    },
    {
      id: "stable", title: "Стейблкоїни", help: "Стейблкоїн — цифрова монета, прив'язана до долара. Тут загальна пропозиція й частки найбільших. Натисніть на графік, щоб відкрити.", agent: "stablecoins", files: ["stablecoins"],
      render: function (b, d) {
        const s = d.stablecoins;
        const stats = el("div", "wstats");
        stats.appendChild(stat("Загальна пропозиція", fmtBig(s.total)));
        stats.appendChild(stat("За 30 днів", s.change30 === null ? "—" : pct(s.change30), s.change30 >= 0 ? "tone-positive" : "tone-negative"));
        b.appendChild(stats);
        b.appendChild(openable(lineChart(s.history, { color: "var(--up)", label: "Загальна пропозиція стейблкоїнів, останні ~4 місяці" }),
          seriesSpec("stablecoins", "Пропозиція стейблкоїнів", s.history, s.history_t ? s.history_t.map(function (t) { return t * 1000; }) : null, fmtBig, "Джерело: DefiLlama."),
          "Відкрити графік пропозиції стейблкоїнів"));
        b.appendChild(hBars(s.top.map(function (t) { return { label: t.symbol, value: t.supply, text: fmtNum(t.share, 1) + "%", color: "var(--accent)" }; })));
      },
    },
    {
      id: "network", title: "Мережа біткоїна", help: "Чим довша черга й вища комісія, тим дорожче й повільніше проходять перекази. Натисніть на графік потужності, щоб відкрити.", agent: "network", files: ["network"],
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
        b.appendChild(openable(lineChart(n.hashrate_history, { color: "var(--accent)", label: "Потужність майнінгу за 3 місяці" }),
          seriesSpec("hashrate", "Потужність майнінгу біткоїна", n.hashrate_history, n.hashrate_t ? n.hashrate_t.map(function (t) { return t * 1000; }) : null,
            function (v) { return fmtNum(v, 0) + " EH/с"; }, "Джерело: mempool.space."), "Відкрити графік потужності майнінгу"));
      },
    },
    {
      id: "regulation", title: "Регулювання: документи США", help: "Нові офіційні документи США про крипто з Federal Register. Тему визначено за правилами й вона може помилятися. Назви англійською, як в оригіналі.", agent: "regulation", files: ["regulation"], wide: true,
      render: function (b, d, opts) {
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
        cols.appendChild(col("Документи по тижнях (12 тижнів)", openable(barChart(r.weeks, { label: "Кількість документів по тижнях" }),
          seriesSpec("regulation", "Документи про крипто по тижнях", r.weeks, r.week_start ? r.week_start.map(function (d) { return Date.parse(d); }) : null,
            function (v) { return "документів: " + fmtNum(v, 0); }, "Джерело: Federal Register."), "Відкрити графік документів по тижнях")));
        cols.appendChild(col("Типи документів (90 днів)", counts(r.by_type, "var(--accent)")));
        cols.appendChild(col("Які відомства (90 днів)", counts(r.by_agency, "var(--accent)")));
        cols.appendChild(col("Про що (90 днів)", counts(r.by_topic, "var(--accent)")));
        b.appendChild(cols);

        if (opts && opts.compact) return;                        // на головній лише діаграми, без карток документів
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
          list.appendChild(card);
        });
        b.appendChild(list);
      },
    },
    {
      id: "signals", title: "Сигнали по монетах", help: "Сигнал за індикаторами: тренд, імпульс, перегрів. Це інформація, а не фінансова порада й не прогноз. Натисніть на рядок, щоб відкрити біржовий графік.", agent: "signals", files: ["signals"], wide: true,
      render: function (b, d, opts) {
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
          ChartTool.bind(row, coinSpec(c), "Відкрити графік " + c.symbol);
          list.appendChild(row);
        });
        b.appendChild(list);
        if (opts && opts.compact) return;
        const more = el("p", "small");
        const l = el("a", "", "Докладно по кожній монеті"); l.href = "analytics.html#signals";
        more.appendChild(l);
        b.appendChild(more);
      },
    },
    {
      id: "news", title: "Новини: головне зараз", help: "Найважливіші історії за оцінкою агента й активність новин за добу. Клік по графіку відкриває його у великому вікні.", agent: "news", files: ["analytics"], wide: true, skipHome: true,
      render: function (b, d, opts) {
        const a = d.analytics;
        const compact = !!(opts && opts.compact);
        const ul = el("ul", "wlinks");
        a.top.slice(0, compact ? 0 : 5).forEach(function (s) {
          const li = el("li", "");
          const link = el("a", "", s.title_uk || s.title);
          link.href = safeUrl(s.link); link.target = "_blank"; link.rel = "noopener noreferrer";
          if (s.title_uk) link.lang = "uk";
          li.appendChild(link);
          li.appendChild(el("span", "small", " — " + s.source + ", " + ago(s.published)));
          ul.appendChild(li);
        });
        if (!compact) b.appendChild(ul);
        b.appendChild(el("h4", "wsub", "Матеріалів щогодини за добу"));
        const nowT = Date.parse(a.generated_at) || Date.now();
        b.appendChild(openable(barChart(a.activity_24h, { label: "Активність новин за останні 24 години" }),
          seriesSpec("news-activity", "Матеріалів у новинах щогодини", a.activity_24h, a.activity_24h.map(function (v, i) { return nowT - (23 - i) * 36e5; }),
            function (v) { return "матеріалів: " + fmtNum(v, 0); }, "Джерело: новинний агент сайту."), "Відкрити графік активності новин"));
        if (compact) return;
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
