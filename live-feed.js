// «Жива стрічка подій»: панель у стилі Binance / Bybit. LiveFeed.mount(host, { wallet, coin, bot, onCoin, layoutRoot }).
// Дані й логіка: live-feed-core.js (журнал підтверджених подій data/live_feed.json + цінові сповіщення за живою ціною).
// Потребує agent-ui.js (el) і live-feed-core.js. Усі тексти з даних вставляються через textContent. Це інформація, а не фінансова порада.

const LiveFeed = (function () {
  const C = LiveFeedCore;
  const CATS = [["all", "Усі"], ["profit", "Прибуток"], ["loss", "Збиток"], ["be", "Беззбитк."], ["sltp", "SL/TP"]];
  const PERIODS = [["1h", "1 год"], ["6h", "6 год"], ["24h", "24 год"], ["7d", "7 днів"], ["all", "Увесь час"]];
  const GLYPH = { near_be: "◔", reached_be: "◎", to_plus: "↗", to_minus: "↘" };
  const STATUS = { live: ["Онлайн", "ok"], connecting: ["Підключення…", "warn"], reconnecting: ["Перепідключення…", "warn"], rest: ["Ціни раз на 20 с", "warn"], offline: ["Немає живих цін", "bad"], idle: ["Онлайн: журнал", "idle"] };
  const SHOW_STEP = 60;

  function fmtPx(v) { return v.toLocaleString("uk-UA", { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6 }); }
  function fmtPct(v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
  function fmtUsd(v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USDT"; }
  function fmtTime(t) {
    const d = new Date(t), now = new Date(), same = d.toDateString() === now.toDateString();
    const tm = d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return same ? tm : d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) + " " + tm;
  }
  function fullTime(t) { return new Date(t).toLocaleString("uk-UA"); }
  function ago(iso, now) { const t = Date.parse(iso); if (!t) return ""; const m = Math.max(0, Math.round((now - t) / 60000)); return m < 1 ? "щойно" : m < 60 ? m + " хв тому" : Math.round(m / 60) + " год тому"; }

  function mount(host, opts) {
    opts = opts || {};
    const core = C.acquire(opts.env), root = opts.layoutRoot || host.parentElement;
    const f = { cat: "all", coin: opts.coin || "", bot: opts.bot || "", wallet: opts.wallet === undefined || opts.wallet === null ? "" : opts.wallet, period: opts.period || "24h" };
    let st = core.state(), shown = SHOW_STEP, sig = "", fresh = {}, destroyed = false, readTimer = 0, detailId = null;
    const nodes = { cards: {} };

    host.classList.add("lf-host");
    const wrap = el("aside", "lf"); wrap.setAttribute("aria-label", "Жива стрічка подій");
    const head = el("div", "lf-head");
    const ttl = el("div", "lf-ttl");
    ttl.innerHTML = "";                                                       // без HTML з даних: іконка створюється нижче
    const ico = document.createElementNS("http://www.w3.org/2000/svg", "svg"); ico.setAttribute("viewBox", "0 0 24 24"); ico.setAttribute("width", "22"); ico.setAttribute("height", "22"); ico.setAttribute("aria-hidden", "true"); ico.setAttribute("class", "lf-ico");
    ico.innerHTML = '<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    ttl.appendChild(ico); ttl.appendChild(el("h3", "lf-title", "Жива стрічка подій"));
    const pill = el("span", "lf-pill idle"); pill.setAttribute("role", "status");
    const dot = el("i", "lf-dot"), pillTxt = el("span", "", "…"); pill.appendChild(dot); pill.appendChild(pillTxt); ttl.appendChild(pill);
    const unread = el("button", "lf-unread", "0"); unread.type = "button"; unread.hidden = true; unread.setAttribute("aria-label", "Непрочитані події: позначити прочитаними");
    const sndBtn = el("button", "lf-ibtn lf-sound", "🔕"); sndBtn.type = "button";
    const colBtn = el("button", "lf-ibtn lf-collapse", "⌃"); colBtn.type = "button"; colBtn.setAttribute("aria-label", "Згорнути панель подій"); colBtn.title = "Згорнути панель";
    head.appendChild(ttl); head.appendChild(unread); head.appendChild(sndBtn); head.appendChild(colBtn);
    const tabs = el("div", "lf-tabs"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Категорії подій");
    const sel = el("div", "lf-sel");
    const selPair = document.createElement("select"), selBot = document.createElement("select"), selWal = document.createElement("select"), selPer = document.createElement("select");
    [[selPair, "Торгова пара"], [selBot, "Бот"], [selWal, "Гаманець"], [selPer, "Період"]].forEach(function (x) { x[0].setAttribute("aria-label", x[1]); x[0].className = "lf-select"; sel.appendChild(x[0]); });
    PERIODS.forEach(function (p) { const o = el("option", "", p[1]); o.value = p[0]; selPer.appendChild(o); });
    selPer.value = f.period;
    const list = el("div", "lf-list"); list.setAttribute("role", "log"); list.setAttribute("aria-live", "polite"); list.setAttribute("aria-relevant", "additions");
    const foot = el("details", "lf-foot"), footSum = el("summary", "", "Про журнал і типи подій"), footTxt = el("p", "");
    foot.appendChild(footSum); foot.appendChild(footTxt);
    const detail = el("div", "lf-detail"); detail.hidden = true; detail.setAttribute("role", "dialog"); detail.setAttribute("aria-modal", "true"); detail.setAttribute("aria-label", "Подробиці події");
    wrap.appendChild(head); wrap.appendChild(tabs); wrap.appendChild(sel); wrap.appendChild(list); wrap.appendChild(foot); wrap.appendChild(detail);
    host.appendChild(wrap);

    // кнопка «Події» (телефон) і кнопка повернення панелі після згортання
    const fab = el("button", "lf-fab", "Події"); fab.type = "button"; fab.setAttribute("aria-expanded", "false");
    const fabBadge = el("span", "lf-fab-badge", ""); fabBadge.hidden = true; fab.appendChild(fabBadge);
    const reopen = el("button", "lf-reopen", "Події"); reopen.type = "button"; reopen.setAttribute("aria-label", "Показати панель подій");
    const reopenBadge = el("span", "lf-fab-badge", ""); reopenBadge.hidden = true; reopen.appendChild(reopenBadge);
    document.body.appendChild(fab);
    if (root) root.appendChild(reopen);

    function setCollapsed(v) {
      core.setPref("collapsed", !!v);
      host.classList.toggle("lf-collapsed", !!v); if (root) root.classList.toggle("lf-root-collapsed", !!v);
      colBtn.setAttribute("aria-expanded", v ? "false" : "true");
      if (typeof opts.onCollapse === "function") opts.onCollapse(!!v);
    }
    function setDrawer(v) {
      host.classList.toggle("lf-open", !!v); fab.setAttribute("aria-expanded", v ? "true" : "false");
      document.documentElement.classList.toggle("lf-lock", !!v && window.matchMedia && window.matchMedia("(max-width: 767px)").matches);
      if (v) { startRead(); }
    }
    function startRead() {                                                     // поки панель видно, нові події стають прочитаними через кілька секунд
      clearTimeout(readTimer);
      readTimer = setTimeout(function () { if (!destroyed && visibleNow()) core.markRead(); }, 4000);
    }
    function visibleNow() { return !document.hidden && !host.classList.contains("lf-collapsed") && (window.matchMedia && window.matchMedia("(max-width: 767px)").matches ? host.classList.contains("lf-open") : true); }

    // ---------- Відображення ----------
    function statusInfo() {
      if (!st.journal.loaded && !st.journal.ok) return st.journal.error ? ["Журнал недоступний", "bad"] : ["Завантаження…", "warn"];
      return STATUS[st.price] || STATUS.idle;
    }
    function renderHeader() {
      const s = statusInfo(); pill.className = "lf-pill " + s[1]; pillTxt.textContent = s[0];
      pill.title = "Журнал подій" + (st.journal.updated ? " оновлено " + ago(st.journal.updated, core.now()) : "") + (st.price === "idle" ? "; відкритих позицій для цінових сповіщень немає" : "");
      unread.hidden = !st.unread; unread.textContent = st.unread > 99 ? "99+" : String(st.unread);
      [fabBadge, reopenBadge].forEach(function (b) { b.hidden = !st.unread; b.textContent = st.unread > 99 ? "99+" : String(st.unread); });
      sndBtn.textContent = st.prefs.sound ? "🔔" : "🔕"; sndBtn.setAttribute("aria-pressed", st.prefs.sound ? "true" : "false");
      sndBtn.setAttribute("aria-label", st.prefs.sound ? "Звук увімкнено: вимкнути" : "Звук вимкнено: увімкнути"); sndBtn.title = sndBtn.getAttribute("aria-label");
    }
    function fillSelect(sl, first, entries, cur) {
      const key = entries.map(function (e) { return e[0]; }).join("|") + "#" + first;
      if (sl.dataset.k !== key) {
        sl.replaceChildren();
        const o0 = el("option", "", first); o0.value = ""; sl.appendChild(o0);
        entries.forEach(function (e) { const o = el("option", "", e[1]); o.value = String(e[0]); sl.appendChild(o); });
        sl.dataset.k = key;
      }
      sl.value = String(cur === undefined || cur === null ? "" : cur);
      if (sl.value !== String(cur === undefined || cur === null ? "" : cur)) sl.value = "";
    }
    function renderControls() {
      const pairs = {}, bots = {};
      st.items.forEach(function (it) { pairs[it.coin] = it.pair; bots[it.bot] = it.botTitle; });
      fillSelect(selPair, "Усі пари", Object.keys(pairs).sort().map(function (k) { return [k, pairs[k]]; }), f.coin);
      fillSelect(selBot, "Усі боти", Object.keys(bots).sort().map(function (k) { return [k, bots[k]]; }), f.bot);
      fillSelect(selWal, "Усі гаманці", st.wallets.map(function (w) { return [w, C.walletLabel(w)]; }), f.wallet);
      const cnt = C.counts(st.items, f, core.now());
      tabs.replaceChildren();
      CATS.forEach(function (c) {
        const b = el("button", "lf-tab" + (f.cat === c[0] ? " active" : ""), c[1] + " (" + cnt[c[0]] + ")"); b.type = "button"; b.setAttribute("aria-pressed", f.cat === c[0] ? "true" : "false"); b.setAttribute("data-cat", c[0]);
        b.addEventListener("click", function () { f.cat = c[0]; shown = SHOW_STEP; render(true); });
        tabs.appendChild(b);
      });
    }
    function line(cls, text) { return el("div", cls, text); }
    function badge(cls, text, hint) { const b = el("span", "lf-badge " + cls, text); if (hint) b.title = hint; return b; }
    function buildCard(it) {
      const tn = C.tone(it), card = el("article", "lf-card tone-" + tn); card.tabIndex = 0; card.setAttribute("data-id", it.id); card.setAttribute("data-source", it.source); card.setAttribute("data-type", it.kind === "price" ? it.type : it.type + (it.exit ? ":" + it.exit : ""));
      card.setAttribute("role", "button"); card.setAttribute("aria-label", C.title(it) + ", " + it.pair + ", " + fmtTime(it.t));
      const ic = el("div", "lf-icon", it.kind === "price" ? GLYPH[it.type] : it.exit === "stop" ? "SL" : it.exit === "take" ? "TP" : it.type === "open" ? "＋" : it.result === "profit" ? "✓" : it.result === "loss" ? "✕" : "■");
      const body = el("div", "lf-body");
      const l1 = el("div", "lf-l1"); l1.appendChild(el("b", "lf-pair", it.pair)); l1.appendChild(el("span", "lf-type", C.title(it))); l1.appendChild(el("time", "lf-time", fmtTime(it.t)));
      const l2 = line("lf-l2", "Гаманець: " + C.walletLabel(it.wallet) + " · Бот: " + (it.botTitle || it.bot));
      const l3 = el("div", "lf-l3");
      l3.appendChild(badge("dir " + it.direction.toLowerCase(), it.direction));
      l3.appendChild(badge("src " + it.source, C.sourceLabel(it), C.sourceNote(it)));
      if (it.kind === "trade" && it.type === "close" && it.entry !== null) l3.appendChild(el("span", "lf-px", "Вихід: " + fmtPx(it.price) + "  Вхід: " + fmtPx(it.entry)));
      else if (it.kind === "trade" && it.type === "open") l3.appendChild(el("span", "lf-px", "Вхід: " + fmtPx(it.price)));
      else if (it.kind === "price") l3.appendChild(el("span", "lf-px", "Поточна ціна: " + fmtPx(it.price)));
      body.appendChild(l1); body.appendChild(l2); body.appendChild(l3);
      let res = null;
      if (it.kind === "price") {
        if (it.type === "near_be" && it.dist !== null) res = "Відстань до беззбитковості: " + it.dist.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + "%";
        else if (it.type === "reached_be") res = "Перетнуто рівень беззбитковості " + (it.be !== null ? fmtPx(it.be) : "");
        else if (it.pnlPct !== null) res = "Нереалізований PnL: " + fmtPct(it.pnlPct);
      } else if (it.type === "close") {
        if (it.pnlUsd !== null) res = (it.source === "testnet" ? "Результат за виконаннями (без повного обліку комісій): " : "Реалізований результат: ") + fmtUsd(it.pnlUsd) + (it.pnlPct !== null ? " (" + fmtPct(it.pnlPct) + ")" : "");
        else res = it.partial ? "Часткове виконання: результат не рахується" : "Результат невідомий: відкриття немає в журналі";
      }
      if (res) body.appendChild(line("lf-res " + (it.pnlUsd !== null ? (it.pnlUsd >= 0 ? "up" : "down") : it.kind === "price" && it.pnlPct !== null && it.type !== "near_be" && it.type !== "reached_be" ? (it.pnlPct >= 0 ? "up" : "down") : ""), res));
      const more = el("button", "lf-more", "⋮"); more.type = "button"; more.setAttribute("aria-label", "Подробиці події"); more.tabIndex = -1;
      card.appendChild(ic); card.appendChild(body); card.appendChild(more);
      const open = function () { showDetail(it.id); };
      card.addEventListener("click", open);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      if (typeof opts.onCoin === "function") card.addEventListener("dblclick", function () { opts.onCoin(it.coin); });
      return card;
    }
    function render(force) {
      renderHeader();
      const now = core.now(), vis = C.applyFilter(st.items, f, now), key = st.items.length + ":" + (st.items[0] ? st.items[0].id : "") + "|" + JSON.stringify(f) + "|" + shown + "|" + st.journal.ok + st.journal.loaded + (st.journal.error || "") + "|" + st.wallets.join(",");
      if (force || key !== sig) {
        sig = key; renderControls();
        const prevTop = list.scrollTop, prevH = list.scrollHeight;
        list.replaceChildren();
        if (!st.journal.loaded) list.appendChild(line("lf-empty", st.journal.error ? "Журнал подій недоступний: " + st.journal.error + ". Спробуємо ще раз за хвилину." : "Завантажуємо журнал подій…"));
        else if (!vis.length) {
          list.appendChild(line("lf-empty", st.items.length ? "За вибраними фільтрами подій немає. Змініть період, пару, бота чи гаманець." : "Подій ще немає. Тут з'являтимуться підтверджені угоди ботів і цінові сповіщення про відкриті позиції."));
        } else {
          vis.slice(0, shown).forEach(function (it) { const c = buildCard(it); if (fresh[it.id]) { c.classList.add("lf-new"); } list.appendChild(c); });
          if (vis.length > shown) { const m = el("button", "lf-showmore", "Показати ще (" + (vis.length - shown) + ")"); m.type = "button"; m.addEventListener("click", function () { shown += SHOW_STEP; render(true); }); list.appendChild(m); }
        }
        if (prevTop > 0) list.scrollTop = prevTop + (list.scrollHeight - prevH > 0 && Object.keys(fresh).length ? list.scrollHeight - prevH : 0);
        fresh = {};
      }
      footTxt.textContent = (st.journal.policy || "Журнал підтверджених подій: старіші записи видаляються, це не повна історія угод.") + " Цінові події — лише оцінка за поточною ціною. Це інформація, а не фінансова порада.";
    }
    function showDetail(id) {
      const it = st.items.filter(function (x) { return x.id === id; })[0];
      if (!it) return;
      detailId = id; detail.replaceChildren();
      const box = el("div", "lf-dbox tone-" + C.tone(it));
      const hd = el("div", "lf-dhead"); hd.appendChild(el("b", "", it.pair + " · " + C.title(it)));
      const close = el("button", "lf-ibtn", "✕"); close.type = "button"; close.setAttribute("aria-label", "Закрити подробиці"); close.addEventListener("click", hideDetail); hd.appendChild(close); box.appendChild(hd);
      box.appendChild(line("lf-dnote", C.sourceNote(it)));
      const dl = el("dl", "lf-dl");
      function row(k, v) { if (v === null || v === undefined || v === "") return; dl.appendChild(el("dt", "", k)); dl.appendChild(el("dd", "", String(v))); }
      row("Час", fullTime(it.t)); row("Джерело", C.sourceLabel(it)); row("Підтвердження", it.kind === "price" ? "Оцінка за поточною ціною (не підтверджена угода)" : it.confirmed === "exchange" ? "Виконання біржі Binance Testnet" : "Модель симулятора (віртуальна угода)");
      row("Гаманець", C.walletLabel(it.wallet)); row("Бот", it.botTitle || it.bot); row("Напрямок", it.direction);
      if (it.kind === "trade") {
        row(it.type === "open" ? "Ціна входу" : "Ціна виходу", fmtPx(it.price)); row("Ціна входу", it.type === "close" && it.entry !== null ? fmtPx(it.entry) : null); row("Кількість", it.qty !== null ? it.qty.toLocaleString("uk-UA", { maximumFractionDigits: 8 }) : null);
        if (it.type === "close") { row("Причина виходу", C.EXIT_LABEL[it.exit] || it.exit); row("Результат", it.pnlUsd !== null ? fmtUsd(it.pnlUsd) + (it.pnlPct !== null ? " (" + fmtPct(it.pnlPct) + ")" : "") : "невідомий"); row("Точність результату", it.pnlUsd !== null ? C.pnlNote(it) : null); }
        row("Витрати входу (комісія + проковзання)", it.cost !== null ? (it.cost * 100).toLocaleString("uk-UA", { maximumFractionDigits: 3 }) + "%" : null);
        row("Ордер біржі", it.orderId); row("Статус ордера", it.status);
        row("Комісії біржі", it.fees && Object.keys(it.fees).length ? Object.keys(it.fees).map(function (k) { return it.fees[k] + " " + k; }).join(", ") : null);
        row("Рішення бота", it.reason);
      } else {
        row("Поточна ціна", fmtPx(it.price)); row("Ціна входу", it.entry !== null ? fmtPx(it.entry) : null); row("Рівень беззбитковості", it.be !== null ? fmtPx(it.be) : null);
        row("Відстань до беззбитковості", it.dist !== null ? it.dist.toLocaleString("uk-UA", { maximumFractionDigits: 3 }) + "%" : null); row("Нереалізований PnL (до витрат виходу)", it.pnlPct !== null ? fmtPct(it.pnlPct) : null);
      }
      row("ID події", it.id);
      box.appendChild(dl);
      if (typeof opts.onCoin === "function") { const go = el("button", "lf-tab active", "Показати " + it.pair + " на графіку"); go.type = "button"; go.addEventListener("click", function () { opts.onCoin(it.coin); hideDetail(); }); box.appendChild(go); }
      detail.appendChild(box); detail.hidden = false; close.focus();
    }
    function hideDetail() { detail.hidden = true; detailId = null; }

    // ---------- Події ----------
    const off = [core.subscribe(function (s) { st = s; if (!destroyed) render(false); }),
      core.onNew(function (items) { items.forEach(function (it) { fresh[it.id] = 1; }); if (visibleNow()) startRead(); })];
    [[selPair, "coin"], [selBot, "bot"], [selWal, "wallet"], [selPer, "period"]].forEach(function (x) { x[0].addEventListener("change", function () { f[x[1]] = x[0].value; shown = SHOW_STEP; render(true); }); });
    unread.addEventListener("click", function () { core.markRead(); });
    sndBtn.addEventListener("click", function () { core.setPref("sound", !st.prefs.sound); });
    colBtn.addEventListener("click", function () { setCollapsed(true); });
    reopen.addEventListener("click", function () { setCollapsed(false); startRead(); });
    fab.addEventListener("click", function () { setDrawer(!host.classList.contains("lf-open")); });
    detail.addEventListener("click", function (e) { if (e.target === detail) hideDetail(); });
    wrap.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!detail.hidden) { e.stopPropagation(); hideDetail(); } else if (host.classList.contains("lf-open")) setDrawer(false); } });
    list.addEventListener("scroll", function () { if (list.scrollTop < 8 && st.unread) startRead(); });
    const closeDrawer = el("button", "lf-ibtn lf-close-drawer", "✕"); closeDrawer.type = "button"; closeDrawer.setAttribute("aria-label", "Закрити вікно подій"); closeDrawer.addEventListener("click", function () { setDrawer(false); }); head.appendChild(closeDrawer);

    if (st.prefs.collapsed) setCollapsed(true);
    render(true);
    if (st.prefs.collapsed === false) startRead();

    return {
      el: wrap,
      setFilter: function (p) { Object.keys(p).forEach(function (k) { if (k in f) f[k] = p[k] === null || p[k] === undefined ? "" : p[k]; }); shown = SHOW_STEP; render(true); },
      getFilter: function () { return Object.assign({}, f); },
      collapse: setCollapsed, toggleDrawer: setDrawer, showDetail: showDetail, core: core,
      destroy: function () {
        destroyed = true; clearTimeout(readTimer); off.forEach(function (fn) { fn(); });
        wrap.remove(); fab.remove(); reopen.remove(); host.classList.remove("lf-host", "lf-collapsed", "lf-open"); if (root) root.classList.remove("lf-root-collapsed");
        document.documentElement.classList.remove("lf-lock"); C.release();
      },
    };
  }

  return { mount: mount };
})();
