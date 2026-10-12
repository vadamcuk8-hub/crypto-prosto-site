// Блок «Аналітичні звіти» на сторінці «Гаманці»: параметри, доступність даних до експорту, формування PDF / Excel / CSV із індикатором і повідомленнями про помилки.
// Усі розрахунки — в ReportCore (на тих самих функціях, що й Analytics Pro); важкі кодувальники (report-export.js, report-pdf.js) і шрифт вантажаться лише при першому формуванні.
// Зовнішній текст виводиться через textContent. Тестується в tools/test-reports.html.

(function (root) {
  "use strict";
  const RC = root.ReportCore, PREF = "wl:report:v1";
  const FORMATS = [["pdf", "PDF"], ["xlsx", "Excel (.xlsx)"], ["csvzip", "CSV: ZIP-пакет таблиць"], ["csv", "CSV: лише рахунки"]];
  function h(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function nf(v, d) { return v.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function two(n) { return ("0" + n).slice(-2); }
  function stamp(t) { const d = new Date(t); return d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) + "-" + two(d.getUTCHours()) + two(d.getUTCMinutes()); }
  function dtl(t) { const d = new Date(t); return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) + "T" + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()); }
  function kb(n) { return n >= 1048576 ? nf(n / 1048576, 1) + " МБ" : nf(n / 1024, 0) + " КБ"; }

  function defaultLoaders() {
    const map = (function () { try { const el = document.getElementById("lazyScripts"); return el ? JSON.parse(el.textContent) : {}; } catch (e) { return {}; } })();
    return {
      loadScript: function (name) { return new Promise(function (res, rej) { const s = document.createElement("script"); s.src = map[name] || name; s.onload = function () { res(); }; s.onerror = function () { rej(new Error("Не вдалося завантажити модуль " + name)); }; document.head.appendChild(s); }); },
      loadFont: function (url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); }); },
    };
  }

  // api: { model(), ops(), comp(), archive(), ensureArchive(fromMs), now(), env: { storage, download(name, text), downloadBytes(name, u8, mime), loadScript, loadFont, fontUrl } }
  function mount(host, api) {
    const env = Object.assign({ fontUrl: "assets/fonts/NotoSans-Regular.ttf", fontBoldUrl: "assets/fonts/NotoSans-Bold.ttf" }, defaultLoaders(), api.env || {});
    const st = { period: "all", from: "", to: "", wallet: "", botMode: "all", bot: "", bots: [], kind: "short", format: "xlsx" };
    try { const s = JSON.parse(env.storage && env.storage.getItem(PREF)); if (s && typeof s === "object") Object.keys(st).forEach(function (k) { if (k === "bots" ? Array.isArray(s[k]) : typeof s[k] === "string") st[k] = s[k]; }); } catch (e) { /* без збережень */ }
    let busy = false, fontState = null, avail = null, built = false;
    const ui = {};
    function persist() { try { env.storage.setItem(PREF, JSON.stringify(st)); } catch (e) { /* без збережень */ } }
    host.replaceChildren(); host.classList.add("wl-rep");
    function lbl(text, ctl) { const l = h("label", "wl-fl wl-rep-f"); l.appendChild(h("span", "wl-lbl", text)); l.appendChild(ctl); return l; }
    function select(name, opts, cur, on) { const s = document.createElement("select"); s.setAttribute("aria-label", name); opts.forEach(function (o) { const e = h("option", "", o[1]); e.value = o[0]; s.appendChild(e); }); s.value = cur; s.addEventListener("change", function () { on(s.value); }); return s; }

    function params() {
      const p = { period: st.period, wallet: st.wallet, kind: st.kind, format: st.format, bots: st.botMode === "all" ? null : st.botMode === "one" ? (st.bot ? [st.bot] : []) : st.bots.slice() };
      if (st.period === "custom") { p.from = st.from ? Date.parse(st.from + ":00Z") : NaN; p.to = st.to ? Date.parse(st.to + ":00Z") : NaN; }
      return p;
    }
    function build() {
      const m = api.model(); if (!m) return;
      host.replaceChildren();
      host.appendChild(h("h2", "wl-h2", "Аналітичні звіти"));
      host.appendChild(h("p", "wl-muted wl-small", "Звіт за 16 стратегіями на 48 незалежних рахунках: PDF, Excel або CSV. Показники ті самі, що в Analytics Pro; рахунки не складаються в портфель."));
      const grid = h("div", "wl-rep-grid"); ui.grid = grid;
      grid.appendChild(lbl("Період", select("Період", RC.PERIODS, st.period, function (v) { st.period = v; if (v === "custom" && !st.from) { const a = api.model(), asOf = RC.resolvePeriod(a, RC.normalize(a, { period: "all" })).asOf || api.now(); st.to = dtl(asOf); st.from = dtl(asOf - 86400000); } persist(); build(); })));
      if (st.period === "custom") {
        const f = document.createElement("input"); f.type = "datetime-local"; f.value = st.from; f.setAttribute("aria-label", "Початок діапазону (UTC)"); f.addEventListener("change", function () { st.from = f.value; persist(); refreshAvail(); });
        const t = document.createElement("input"); t.type = "datetime-local"; t.value = st.to; t.setAttribute("aria-label", "Кінець діапазону (UTC)"); t.addEventListener("change", function () { st.to = t.value; persist(); refreshAvail(); });
        grid.appendChild(lbl("Від (UTC)", f)); grid.appendChild(lbl("До (UTC)", t));
      }
      grid.appendChild(lbl("Гаманець", select("Гаманець", [["", "Усі для порівняння"]].concat(m.caps.map(function (c) { return [String(c), RC.capTxt(c)]; })), st.wallet, function (v) { st.wallet = v; persist(); refreshAvail(); })));
      grid.appendChild(lbl("Стратегії", select("Стратегії", [["all", "Усі (" + m.rules.length + ")"], ["one", "Одна"], ["selected", "Вибрані"]], st.botMode, function (v) { st.botMode = v; persist(); build(); })));
      if (st.botMode === "one") { if (!st.bot || !m.rules.some(function (r) { return r.id === st.bot; })) st.bot = m.rules[0].id; grid.appendChild(lbl("Стратегія", select("Одна стратегія", m.rules.map(function (r) { return [r.id, r.title]; }), st.bot, function (v) { st.bot = v; persist(); refreshAvail(); }))); }
      grid.appendChild(lbl("Тип", select("Тип звіту", [["short", "Короткий"], ["detailed", "Детальний"]], st.kind, function (v) { st.kind = v; persist(); refreshAvail(); })));
      grid.appendChild(lbl("Формат", select("Формат", FORMATS, st.format, function (v) { st.format = v; persist(); refreshAvail(); checkFont(); })));
      host.appendChild(grid);
      if (st.botMode === "selected") {
        const det = document.createElement("details"); det.className = "wl-rep-bots"; det.open = true; const sm = document.createElement("summary"); sm.textContent = "Вибрані стратегії: " + st.bots.length + " із " + m.rules.length; det.appendChild(sm);
        const ctl = h("div", "wl-rep-botctl"); [["Усі", function () { return m.rules.map(function (r) { return r.id; }); }], ["Жодної", function () { return []; }]].forEach(function (x) { const b = h("button", "wl-btn", x[0]); b.type = "button"; b.addEventListener("click", function () { st.bots = x[1](); persist(); build(); }); ctl.appendChild(b); }); det.appendChild(ctl);
        const list = h("div", "wl-rep-botlist"); m.rules.forEach(function (r) { const l = h("label", "wl-ck wl-rep-ck"), c = document.createElement("input"); c.type = "checkbox"; c.checked = st.bots.indexOf(r.id) >= 0; c.addEventListener("change", function () { st.bots = m.rules.map(function (q) { return q.id; }).filter(function (id) { return id === r.id ? c.checked : st.bots.indexOf(id) >= 0; }); persist(); sm.textContent = "Вибрані стратегії: " + st.bots.length + " із " + m.rules.length; refreshAvail(); }); l.appendChild(c); l.appendChild(h("span", "", r.title)); list.appendChild(l); }); det.appendChild(list); host.appendChild(det);
      }
      ui.avail = h("div", "wl-rep-avail"); ui.avail.setAttribute("role", "status"); host.appendChild(ui.avail);
      ui.fontNote = h("p", "wl-muted wl-small wl-rep-font"); host.appendChild(ui.fontNote);
      const act = h("div", "wl-rep-act"); ui.btn = h("button", "wl-btn wl-rep-go", "Сформувати звіт"); ui.btn.type = "button"; ui.btn.addEventListener("click", generate); act.appendChild(ui.btn);
      ui.prog = document.createElement("progress"); ui.prog.max = 1; ui.prog.value = 0; ui.prog.hidden = true; ui.prog.setAttribute("aria-label", "Формування звіту"); act.appendChild(ui.prog); ui.progTxt = h("span", "wl-muted wl-small wl-rep-pt"); act.appendChild(ui.progTxt); host.appendChild(act);
      ui.err = h("p", "wl-error wl-rep-err"); ui.err.hidden = true; ui.err.setAttribute("role", "alert"); host.appendChild(ui.err);
      ui.ok = h("p", "wl-note wl-rep-ok"); ui.ok.hidden = true; ui.ok.setAttribute("role", "status"); host.appendChild(ui.ok);
      built = true; refreshAvail(); checkFont();
    }
    function archiveInfo() { const a = api.archive ? api.archive() : null; return a || null; }
    function refreshAvail() {
      if (!built || !ui.avail) return;
      const m = api.model(); if (!m) return;
      const p = params(), a = RC.availability(m, api.ops(), api.comp(), p, { archive: archiveInfo() }); avail = a; ui.avail.replaceChildren();
      const line = function (t, cls) { const x = h("div", "wl-rep-line" + (cls ? " " + cls : ""), t); ui.avail.appendChild(x); return x; };
      if (a.errors.length && !a.accounts) { a.errors.forEach(function (e) { line(e, "wl-rep-bad"); }); }
      else {
        line("Рахунків у звіті: " + a.accounts + " · з достовірним equity для періоду: " + a.withEquity + (a.coverage.partial ? " (період скорочено до поточного раунду: " + a.coverage.partial + ")" : "") + (a.coverage.none ? " · без даних: " + a.coverage.none : ""));
        line("Підтверджених операцій у періоді: " + a.opsInPeriod + (a.opsOtherRounds ? " (+ " + a.opsOtherRounds + " з попередніх раундів, у підсумки не входять)" : "") + (p.kind === "detailed" ? "" : " · у короткому звіті перелік операцій не включено"));
        const c = a.completeness; line("Повнота історії операцій: повні дані — " + c.full + ", часткові — " + c.partial + ", недостатньо даних — " + c.insufficient + " (за рахунками)", c.partial + c.insufficient ? "wl-rep-warn" : "");
        if (a.period) line("Період: " + (a.period.key === "all" ? "поточний раунд до останньої збереженої точки" : a.period.label + (a.period.from !== null ? ": " + RC.fmtDate(a.period.from) + " — " + RC.fmtDate(a.period.to) : "")) + " · дані станом на " + RC.fmtDate(a.period.asOf));
        const ar = archiveInfo(); if (ar) line("Архів операцій: " + (ar.status === "ok" ? "завантажено сегментів " + ar.loaded + " із " + ar.total + (ar.needMore ? "; для цього періоду буде дозавантажено ще " + ar.needMore : "") : ar.status === "error" ? "недоступний (" + (ar.reason || "помилка") + ")" : "завантаження…"), ar.status === "error" ? "wl-rep-warn" : "");
        a.warnings.forEach(function (w) { line("▲ " + w, "wl-rep-warn"); }); a.errors.forEach(function (e) { line("✕ " + e, "wl-rep-bad"); });
      }
      ui.btn.disabled = busy || !a.ready; ui.btn.setAttribute("aria-disabled", ui.btn.disabled ? "true" : "false");
    }
    function checkFont() {
      if (!ui.fontNote) return; const pdf = st.format === "pdf";
      if (!pdf) { ui.fontNote.textContent = ""; return; }
      if (fontState === true) { ui.fontNote.textContent = ""; return; }
      if (fontState === false) { ui.fontNote.textContent = "PDF недоступний: у проєкті немає шрифту з кирилицею (" + env.fontUrl + "). Excel і CSV працюють без нього."; return; }
      ui.fontNote.textContent = "";
      if (fontState === null) { fontState = "pending"; Promise.resolve().then(function () { return env.loadFont(env.fontUrl); }).then(function (b) { fontState = b; }).catch(function () { fontState = false; }).then(function () { if (built) checkFont(); }); }
    }
    function setProgress(v, text) { ui.prog.hidden = false; ui.prog.value = v; ui.progTxt.textContent = text || ""; return new Promise(function (r) { setTimeout(r, 0); }); }
    function fail(msg) { ui.err.textContent = msg; ui.err.hidden = false; }

    async function ensureModules(fmt) {
      if (!root.ReportExport) await env.loadScript("report-export.js");
      if (fmt === "pdf" && !root.ReportPdf) await env.loadScript("report-pdf.js");
    }
    async function loadFonts() {
      if (fontState && fontState !== true && fontState !== false && fontState !== "pending") { const reg = fontState; let bold = null; try { bold = await env.loadFont(env.fontBoldUrl); } catch (e) { bold = null; } return { regular: reg, bold: bold }; }
      let reg; try { reg = await env.loadFont(env.fontUrl); } catch (e) { fontState = false; throw new Error("PDF недоступний: не знайдено шрифт з кирилицею (" + env.fontUrl + "). Excel і CSV працюють без нього."); }
      fontState = reg; let bold = null; try { bold = await env.loadFont(env.fontBoldUrl); } catch (e) { bold = null; } return { regular: reg, bold: bold };
    }
    async function generate() {
      if (busy) return; ui.err.hidden = true; ui.ok.hidden = true;
      const m = api.model(); if (!m) return fail("Дані симуляції ще не завантажено.");
      const p = params(), a0 = RC.availability(m, api.ops(), api.comp(), p, { archive: archiveInfo() });
      if (!a0.ready) return fail(a0.errors.join(" "));
      busy = true; ui.btn.disabled = true; ui.btn.textContent = "Формування…";
      const t0 = Date.now();
      try {
        await setProgress(0.03, "Підготовка даних…");
        if (api.ensureArchive && a0.period) { await setProgress(0.06, "Завантаження потрібних сегментів архіву…"); await api.ensureArchive(a0.period.from, p.period); }
        await setProgress(0.15, "Розрахунок показників…");
        const rep = RC.build(api.model(), api.ops(), api.comp(), p, { now: api.now(), archive: archiveInfo() });
        if (rep.empty) throw new Error(rep.errors.join(" ") || "Немає даних для звіту.");
        await setProgress(0.25, "Завантаження модулів експорту…"); await ensureModules(p.format);
        const base = "crypto-prosto-report-" + stamp(api.now()); let name, bytes, mime, text = null;
        if (p.format === "pdf") {
          await setProgress(0.3, "Завантаження шрифту…"); const fonts = await loadFonts();
          bytes = await root.ReportPdf.generate(rep, fonts, { progress: function (x) { return setProgress(0.3 + 0.65 * x, "Формування PDF… " + Math.round(x * 100) + "%"); } }); name = base + ".pdf"; mime = "application/pdf";
        } else if (p.format === "xlsx") { await setProgress(0.4, "Формування Excel…"); bytes = await root.ReportExport.xlsx(rep); name = base + ".xlsx"; mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
        else if (p.format === "csvzip") { await setProgress(0.4, "Формування CSV-пакета…"); const files = root.ReportExport.csvFiles(rep); bytes = await root.ReportExport.zip(files.map(function (f) { return { name: f.name, data: f.text }; }), { time: api.now() }); name = base + "-csv.zip"; mime = "application/zip"; }
        else { await setProgress(0.4, "Формування CSV…"); const f = root.ReportExport.csvSingle(rep); text = f.text; name = base + "-rakhunky.csv"; mime = "text/csv;charset=utf-8"; }
        await setProgress(0.97, "Завантаження файлу…");
        if (text !== null) env.download(name, text); else (env.downloadBytes || function () { throw new Error("Завантаження файлів недоступне"); })(name, bytes, mime);
        const size = text !== null ? new TextEncoder().encode(text).length : bytes.length;
        ui.ok.textContent = "Готово: " + name + " · " + kb(size) + " · за " + nf((Date.now() - t0) / 1000, 1) + " с." + (rep.warnings.length ? " Є попередження (" + rep.warnings.length + "): вони відображені у звіті в розділі обмежень." : "");
        ui.ok.hidden = false; api.lastReport = { name: name, size: size, format: p.format, rep: rep };
      } catch (e) { fail("Не вдалося сформувати звіт: " + (e && e.message ? e.message : "помилка")); }
      busy = false; ui.prog.hidden = true; ui.progTxt.textContent = ""; ui.btn.textContent = "Сформувати звіт"; refreshAvail();
    }
    build();
    return { refresh: function () { if (!built) build(); else { if (!host.querySelector(".wl-rep-grid")) build(); else { refreshAvail(); } } }, rebuild: build, state: function () { return JSON.parse(JSON.stringify(st)); }, params: params, availability: function () { return avail; }, generate: generate, busy: function () { return busy; }, setFontState: function (v) { fontState = v; checkFont(); } };
  }

  root.ReportUI = { mount: mount, FORMATS: FORMATS };
})(typeof window !== "undefined" ? window : this);
