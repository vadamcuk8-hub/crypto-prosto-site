// Жива стрічка новин (news.html): пошук, фільтри, картки з картинками й вікном «Вплив на ринок».
// Потребує core.js (setText, fmtOnlyUsd, pct) і agent-ui.js (el, safeUrl, ago, loadJson).

(function () {
  const PAGE = 40;            // скільки новин показувати за раз

  // ======================= Жива стрічка (news.html) =======================
  const feedBox = document.getElementById("liveFeed");
  if (feedBox) {
    const $ = function (id) { return document.getElementById(id); };
    const statusEl = $("liveStatus"), staleEl = $("feedStale"), countEl = $("feedCount"), moreBtn = $("feedMore");
    const searchEl = $("feedSearch"), clearBtn = $("feedClear"), sortSel = $("feedSort");
    const toggleBtn = $("filtersToggle"), badge = $("filtersBadge"), panel = $("filtersPanel"), activeBox = $("activeFilters");
    const topicBox = $("topicChips"), sourceBox = $("sourceChips"), periodBox = $("periodSeg"), langBox = $("langSeg");
    const cbConfirmed = $("fConfirmed"), cbOfficial = $("fOfficial"), cbFresh = $("fFresh"), cbTranslate = $("feedTranslate");

    const PERIOD_HOURS = { "1": 1, "6": 6, "24": 24, "72": 72, all: 0 };
    const PERIOD_NAME = { "1": "за 1 годину", "6": "за 6 годин", "24": "за добу", "72": "за 3 доби" };
    const LANG_NAME = { uk: "оригінал українською", en: "оригінал англійською" };

    // Усі налаштування фільтрів в одному місці
    const state = { q: "", topics: new Set(), sources: new Set(), period: "all", lang: "all",
                    confirmed: false, official: false, fresh: false, translate: true, sort: "new" };
    let data = null;
    let shown = PAGE;
    let seen = null;      // id новин, які вже були на екрані (щоб підсвічувати нові)
    let chipsBuilt = "";  // «підпис» набору тем і джерел, щоб не перебудовувати кнопки без потреби

    // ---------- Збереження фільтрів в адресі сторінки (можна поділитися посиланням) ----------
    function readUrl() {
      const p = new URLSearchParams(location.search);
      state.q = p.get("q") || "";
      (p.get("t") || "").split(",").filter(Boolean).forEach(function (x) { state.topics.add(x); });
      (p.get("s") || "").split(",").filter(Boolean).forEach(function (x) { state.sources.add(x); });
      state.period = Object.prototype.hasOwnProperty.call(PERIOD_HOURS, p.get("p")) ? p.get("p") : "all";
      state.lang = ["uk", "en"].indexOf(p.get("l")) > -1 ? p.get("l") : "all";
      state.confirmed = p.get("c") === "1";
      state.official = p.get("o") === "1";
      state.fresh = p.get("f") === "1";
      state.translate = p.get("tr") !== "0";
      state.sort = p.get("sort") === "imp" ? "imp" : "new";
    }

    function writeUrl() {
      const p = new URLSearchParams();
      if (state.q) p.set("q", state.q);
      if (state.topics.size) p.set("t", Array.from(state.topics).join(","));
      if (state.sources.size) p.set("s", Array.from(state.sources).join(","));
      if (state.period !== "all") p.set("p", state.period);
      if (state.lang !== "all") p.set("l", state.lang);
      if (state.confirmed) p.set("c", "1");
      if (state.official) p.set("o", "1");
      if (state.fresh) p.set("f", "1");
      if (!state.translate) p.set("tr", "0");
      if (state.sort !== "new") p.set("sort", state.sort);
      const qs = p.toString();
      try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch (e) {}
    }

    // ---------- Пошук: слова через пробіл (усі мають бути), «-слово» виключає ----------
    function parseQuery(q) {
      const pos = [], neg = [];
      q.toLowerCase().split(/\s+/).filter(Boolean).forEach(function (t) {
        if (t.charAt(0) === "-" && t.length > 1) neg.push(t.slice(1)); else pos.push(t);
      });
      return { pos: pos, neg: neg };
    }

    // Додає текст у елемент, підсвічуючи знайдені слова (через <mark>, без innerHTML)
    let hlKey = "", hlRx = null;   // регулярний вираз збираємо один раз на пошуковий запит, а не для кожної картки
    function appendHighlighted(parent, text, terms) {
      if (!terms.length) { parent.appendChild(document.createTextNode(text)); return; }
      const key = terms.join("\u0001");
      if (key !== hlKey) {
        hlKey = key;
        hlRx = new RegExp("(" + terms.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "ig");
      }
      text.split(hlRx).forEach(function (part, idx) {
        if (idx % 2 === 1) parent.appendChild(el("mark", "", part));
        else if (part) parent.appendChild(document.createTextNode(part));
      });
    }

    function matches(i, terms) {
      const hay = (i.title + " " + (i.title_uk || "") + " " + (i.snippet || "") + " " + (i.snippet_uk || "") + " " + i.source).toLowerCase();
      return terms.pos.every(function (t) { return hay.indexOf(t) > -1; }) &&
             !terms.neg.some(function (t) { return hay.indexOf(t) > -1; });
    }

    function filtered() {
      const now = Date.now();
      const terms = parseQuery(state.q);
      const hours = PERIOD_HOURS[state.period];
      const list = data.items.filter(function (i) {
        if (state.topics.size && !state.topics.has(i.topic)) return false;
        if (state.sources.size && !state.sources.has(i.source)) return false;
        if (hours && (now - new Date(i.published).getTime()) / 3600000 > hours) return false;
        if (state.lang !== "all" && i.lang !== state.lang) return false;
        if (state.confirmed && i.confirmations < 2) return false;
        if (state.official && !i.official) return false;
        if (state.fresh && !i.new) return false;
        return matches(i, terms);
      });
      if (state.sort === "imp") {
        list.sort(function (a, b) { return b.importance - a.importance || (a.published < b.published ? 1 : -1); });
      }
      return { list: list, terms: terms.pos };
    }

    // ---------- Кнопки-фільтри (теми й джерела з лічильниками) ----------
    function buildChips() {
      const labels = data.labels || {};
      const tCount = {}, sCount = {};
      data.items.forEach(function (i) {
        tCount[i.topic] = (tCount[i.topic] || 0) + 1;
        sCount[i.source] = (sCount[i.source] || 0) + 1;
      });
      const sig = JSON.stringify([tCount, sCount]);
      if (sig === chipsBuilt) return;
      chipsBuilt = sig;

      function fill(box, counts, nameOf, set) {
        box.innerHTML = "";
        Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (key) {
          const b = el("button", "fchip", "");
          b.type = "button";
          b.dataset.key = key;
          b.setAttribute("aria-pressed", set.has(key) ? "true" : "false");
          b.appendChild(document.createTextNode(nameOf(key) + " "));
          b.appendChild(el("span", "fchip-n", String(counts[key])));
          b.addEventListener("click", function () {
            if (set.has(key)) set.delete(key); else set.add(key);
            changed();
          });
          box.appendChild(b);
        });
      }
      fill(topicBox, tCount, function (k) { return labels[k] || k; }, state.topics);
      fill(sourceBox, sCount, function (k) { return k; }, state.sources);
    }

    // ---------- «Активні фільтри»: короткі плашки з хрестиком ----------
    function activePills() {
      const labels = (data && data.labels) || {};
      const pills = [];
      if (state.q) pills.push({ text: "Пошук: «" + state.q + "»", clear: function () { state.q = ""; } });
      state.topics.forEach(function (t) { pills.push({ text: "Тема: " + (labels[t] || t), clear: function () { state.topics.delete(t); } }); });
      state.sources.forEach(function (s) { pills.push({ text: "Джерело: " + s, clear: function () { state.sources.delete(s); } }); });
      if (state.period !== "all") pills.push({ text: "Період: " + PERIOD_NAME[state.period], clear: function () { state.period = "all"; } });
      if (state.lang !== "all") pills.push({ text: "Мова: " + LANG_NAME[state.lang], clear: function () { state.lang = "all"; } });
      if (state.confirmed) pills.push({ text: "Підтверджені 2+ джерелами", clear: function () { state.confirmed = false; } });
      if (state.official) pills.push({ text: "Лише офіційні", clear: function () { state.official = false; } });
      if (state.fresh) pills.push({ text: "Лише нові", clear: function () { state.fresh = false; } });
      return pills;
    }

    function resetAll() {
      state.q = ""; state.topics.clear(); state.sources.clear(); state.period = "all"; state.lang = "all";
      state.confirmed = state.official = state.fresh = false;
    }

    function syncControls() {
      if (searchEl.value !== state.q) searchEl.value = state.q;
      clearBtn.hidden = !state.q;
      sortSel.value = state.sort;
      cbConfirmed.checked = state.confirmed;
      cbOfficial.checked = state.official;
      cbFresh.checked = state.fresh;
      cbTranslate.checked = state.translate;
      [[periodBox, state.period], [langBox, state.lang]].forEach(function (pair) {
        pair[0].querySelectorAll("button").forEach(function (b) {
          b.setAttribute("aria-pressed", b.dataset.v === pair[1] ? "true" : "false");
        });
      });
      [[topicBox, state.topics], [sourceBox, state.sources]].forEach(function (pair) {
        pair[0].querySelectorAll(".fchip").forEach(function (b) {
          b.setAttribute("aria-pressed", pair[1].has(b.dataset.key) ? "true" : "false");
        });
      });

      const pills = activePills();
      badge.textContent = pills.length ? String(pills.length) : "";
      badge.hidden = !pills.length;
      activeBox.innerHTML = "";
      pills.forEach(function (p) {
        const b = el("button", "pill", p.text + " ×");
        b.type = "button";
        b.setAttribute("aria-label", "Прибрати фільтр: " + p.text);
        b.addEventListener("click", function () { p.clear(); changed(); });
        activeBox.appendChild(b);
      });
      if (pills.length > 1) {
        const r = el("button", "pill pill-reset", "Скинути все");
        r.type = "button";
        r.addEventListener("click", function () { resetAll(); changed(); });
        activeBox.appendChild(r);
      }
    }

    function changed() {
      shown = PAGE;
      writeUrl();
      syncControls();
      render();
    }

    // ---------- Картка новини ----------
    function renderItem(i, isNew, terms) {
      const art = el("article", "feed-item" + (isNew ? " is-new" : ""));
      const a = el("div", "feed-body");   // весь текст картки; картинка додається окремо збоку
      const meta = el("div", "feed-meta");
      meta.appendChild(el("span", "feed-src" + (i.official ? " official" : ""), i.source + (i.official ? " ✓ офіційне" : "")));
      meta.appendChild(el("span", "feed-time", ago(i.published)));
      meta.appendChild(el("span", "tag", (data.labels && data.labels[i.topic]) || i.topic));
      if (i.lang === "en") meta.appendChild(el("span", "feed-lang", "EN"));
      if (isNew || i.new) meta.appendChild(el("span", "feed-new", "нове"));
      a.appendChild(meta);

      const useUk = state.translate && i.lang === "en" && i.title_uk;
      const h = el("h3", "feed-title");
      const link = el("a", "");
      appendHighlighted(link, useUk ? i.title_uk : i.title, terms);
      link.href = safeUrl(i.link);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (useUk) link.lang = "uk";
      h.appendChild(link);
      a.appendChild(h);

      if (useUk) {
        if (i.snippet_uk) { const p = el("p", "feed-snippet"); appendHighlighted(p, i.snippet_uk, terms); a.appendChild(p); }
        const orig = el("p", "feed-orig", "Оригінал (англійською): ");
        appendHighlighted(orig, i.title, terms);   // пошук працює і за оригіналом: підсвічуємо й там
        a.appendChild(orig);
        meta.appendChild(el("span", "feed-lang", "автопереклад" + (i.translated_by ? " · " + i.translated_by : "")));
      } else if (i.snippet) {
        const p = el("p", "feed-snippet");
        appendHighlighted(p, i.snippet, terms);
        a.appendChild(p);
      }

      if (i.impact) a.appendChild(renderImpact(i));

      const foot = el("div", "feed-foot");
      foot.appendChild(el("span", "feed-conf" + (i.confirmations >= 2 ? " ok" : ""),
        i.confirmations >= 2 ? "Підтверджено: " + i.confirmations + " джерела" : "Одне джерело"));
      const tone = { positive: "тон: позитивний", negative: "тон: негативний", neutral: "тон: нейтральний" }[i.sent_label];
      foot.appendChild(el("span", "feed-tone tone-" + i.sent_label, tone));
      if (i.coins && i.coins.length) foot.appendChild(el("span", "feed-coins", i.coins.join(" · ")));
      if (i.also && i.also.length) {
        const also = el("span", "feed-also", "також: ");
        i.also.forEach(function (x, n) {
          const l = el("a", "", x.source);
          l.href = safeUrl(x.link);
          l.target = "_blank";
          l.rel = "noopener noreferrer";
          also.appendChild(l);
          if (n < i.also.length - 1) also.appendChild(document.createTextNode(", "));
        });
        foot.appendChild(also);
      }
      a.appendChild(foot);

      // Картинка зі стрічки видання (завантажується з сайту видання; якщо не завантажилась — картку показуємо без неї)
      if (i.image && safeUrl(i.image) !== "#") {
        const media = el("a", "feed-media");
        media.href = safeUrl(i.link);
        media.target = "_blank";
        media.rel = "noopener noreferrer";
        media.tabIndex = -1;
        media.setAttribute("aria-hidden", "true");
        const img = document.createElement("img");
        img.src = i.image;
        img.alt = "";
        img.width = 320;
        img.height = 180;
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", function () { media.remove(); art.classList.remove("has-img"); });
        media.appendChild(img);
        art.classList.add("has-img");
        art.appendChild(media);
      }
      art.appendChild(a);
      return art;
    }

    // ---------- Інформаційне вікно: яких монет стосується і як може вплинути на ринок ----------
    const openImpacts = new Set();   // щоб відкриті вікна не закривались при оновленні списку

    function renderImpact(i) {
      const im = i.impact;
      const mk = data.market && data.market.coins ? data.market.coins : {};
      const d = el("details", "impact");
      d.open = openImpacts.has(i.id);
      d.addEventListener("toggle", function () { if (d.open) openImpacts.add(i.id); else openImpacts.delete(i.id); });

      const sum = el("summary", "");
      sum.appendChild(el("span", "impact-title", "Вплив на ринок"));
      const row = el("span", "impact-coins");
      if (im.coins.length) {
        im.coins.forEach(function (c) {
          const chip = el("span", "coin-chip");
          chip.appendChild(el("b", "", c.symbol));
          const m = mk[c.symbol];
          if (m) chip.appendChild(el("span", "chg " + (m.change >= 0 ? "up" : "down"),
            (m.change >= 0 ? "▲ +" : "▼ ") + m.change.toFixed(2).replace(".", ",") + "%"));
          row.appendChild(chip);
        });
      } else {
        row.appendChild(el("span", "coin-chip", "ринок загалом"));
      }
      sum.appendChild(row);
      d.appendChild(sum);

      const body = el("div", "impact-body");
      const facts = el("dl", "impact-facts");
      [["Стосується", im.coins.length ? im.coins.map(function (c) { return c.name; }).join(", ") : "ринку загалом"],
       ["Вплив", im.direction], ["Рівень", im.level]].forEach(function (f) {
        const box = el("div", "");
        box.appendChild(el("dt", "", f[0]));
        box.appendChild(el("dd", f[0] === "Вплив" ? "tone-" + im.tone : "", f[1]));
        facts.appendChild(box);
      });
      body.appendChild(facts);
      body.appendChild(el("p", "impact-text", im.text));

      const priced = im.coins.filter(function (c) { return mk[c.symbol]; });
      if (priced.length && data.market) {
        const t = new Date(data.market.time).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
        const ul = el("ul", "impact-prices");
        priced.forEach(function (c) {
          const m = mk[c.symbol];
          const li = el("li", "");
          li.appendChild(document.createTextNode(c.name + ": " + fmtOnlyUsd(m.price) + ", "));  // fmtOnlyUsd і pct — із script.js
          li.appendChild(el("span", m.change >= 0 ? "tone-positive" : "tone-negative", pct(m.change) + " за 24 год"));
          ul.appendChild(li);
        });
        body.appendChild(ul);
        body.appendChild(el("p", "small", "Ціни — знімок на " + t + " (" + data.market.source + "). Актуальні курси на сторінці «Ринок»."));
      }
      body.appendChild(el("p", "small", "Оцінку зроблено програмою за темою й тоном заголовка. Це не прогноз і не фінансова порада."));
      d.appendChild(body);
      return d;
    }

    function render() {
      if (!data) return;
      const res = filtered();
      feedBox.innerHTML = "";
      res.list.slice(0, shown).forEach(function (i) {
        feedBox.appendChild(renderItem(i, seen && !seen.has(i.id), res.terms));
      });
      if (!res.list.length) {
        const box = el("div", "feed-empty");
        box.appendChild(el("p", "", "За цими умовами новин немає."));
        const b = el("button", "chip", "Скинути фільтри");
        b.type = "button";
        b.addEventListener("click", function () { resetAll(); changed(); });
        box.appendChild(b);
        feedBox.appendChild(box);
      }
      countEl.textContent = "Знайдено " + res.list.length + " з " + data.items.length +
        (res.list.length > shown ? ", показано " + shown : "");
      moreBtn.hidden = res.list.length <= shown;
    }

    async function refresh() {
      try {
        const fresh = await loadJson("data/news.json");
        data = fresh;
        if (seen === null) seen = new Set(data.items.map(function (i) { return i.id; }));  // перше завантаження: нічого не «нове»
        buildChips();
        syncControls();
        render();
        seen = new Set(data.items.map(function (i) { return i.id; })); // після показу всі ці новини вважаємо «побаченими»

        const hours = (Date.now() - new Date(data.generated_at).getTime()) / 3600000;
        statusEl.textContent = "● Оновлено " + ago(data.generated_at) + ". Сторінка сама перевіряє нові дані щохвилини.";
        statusEl.className = "feed-status live";
        staleEl.hidden = hours <= STALE_HOURS;
        if (hours > STALE_HOURS) {
          staleEl.textContent = "Дані застаріли: агент не запускався вже " + Math.round(hours) + " год. Запустіть start-agents.bat, щоб стрічка знову оновлювалась.";
        }
      } catch (e) {
        statusEl.textContent = "Стрічку не завантажено";
        statusEl.className = "feed-status off";
        if (!data) { feedBox.innerHTML = ""; feedBox.appendChild(el("p", "note", HELP)); }
      }
    }

    // ---------- Події ----------
    let timer = null;
    searchEl.addEventListener("input", function () {   // невелика затримка, щоб не перемальовувати на кожну літеру
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = searchEl.value.trim(); changed(); }, 160);
    });
    searchEl.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && searchEl.value) { searchEl.value = ""; state.q = ""; changed(); }
    });
    clearBtn.addEventListener("click", function () { searchEl.value = ""; state.q = ""; changed(); searchEl.focus(); });
    document.addEventListener("keydown", function (e) {   // клавіша «/» переходить у пошук
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(tag)) { e.preventDefault(); searchEl.focus(); searchEl.select(); }
    });
    sortSel.addEventListener("change", function () { state.sort = sortSel.value; changed(); });
    [[periodBox, "period"], [langBox, "lang"]].forEach(function (pair) {
      pair[0].querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () { state[pair[1]] = b.dataset.v; changed(); });
      });
    });
    [[cbConfirmed, "confirmed"], [cbOfficial, "official"], [cbFresh, "fresh"], [cbTranslate, "translate"]].forEach(function (pair) {
      pair[0].addEventListener("change", function () { state[pair[1]] = pair[0].checked; changed(); });
    });
    toggleBtn.addEventListener("click", function () {
      const open = panel.hidden;
      panel.hidden = !open;
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    moreBtn.addEventListener("click", function () { shown += PAGE; render(); });

    readUrl();
    if (state.topics.size || state.sources.size || state.period !== "all" || state.lang !== "all" || state.confirmed || state.official || state.fresh) {
      panel.hidden = false;                                // якщо відкрили за посиланням з фільтрами — показуємо панель
      toggleBtn.setAttribute("aria-expanded", "true");
    }
    syncControls();
    refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);   // у прихованій вкладці дані не качаємо
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  }
})();
