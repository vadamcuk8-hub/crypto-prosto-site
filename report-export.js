// Експорт звітів: CSV (сумісний з українським Excel), ZIP-пакет і справжній Excel-файл .xlsx. Без зовнішніх бібліотек: власний мінімальний ZIP і SpreadsheetML.
// Дані беруться готовими з ReportCore (таблиці з типами колонок); тут лише форматування. Тестується в tools/test-reports.html.
//   • CSV: UTF-8 з BOM, роздільник «;», десяткова кома, захист від CSV-ін'єкцій (текст, що починається з = + - @ таб або CR, отримує апостроф).
//   • XLSX: числа, відсотки й дати — справжні типи з числовими форматами; текст — рядки (не формули); текст на «=+-@» має quotePrefix; фільтри й заморожений заголовок.
//   • Порожні значення (null) лишаються порожніми клітинками: відсутні дані не замінюються нулями.

(function (root) {
  "use strict";
  const enc = new TextEncoder();
  function num(v) { return typeof v === "number" && isFinite(v); }

  // ---------- CSV ----------
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return isFinite(v) ? v.toFixed(8).replace(/\.?0+$/, "").replace(".", ",").replace(/^-0$/, "0") : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function isoT(t) { return num(t) ? new Date(t).toISOString().replace(".000Z", "Z") : null; }
  function colTitle(c) {
    const t = c.title;
    if ((c.type === "pct" || c.type === "pct0" || c.type === "dd") && t.indexOf("%") < 0) return t + ", %";
    if ((c.type === "usd" || c.type === "usd0") && t.indexOf("$") < 0) return t + ", $";
    return t;
  }
  function csvValue(c, v) {
    if (v === null || v === undefined) return null;
    if (c.type === "dt") return isoT(v);
    if (c.type === "dd") return num(v) ? (v < 0.005 ? 0 : -v) : null;
    return num(v) || typeof v === "string" ? v : String(v);
  }
  function tableCsv(table, extraCols) {
    const cols = table.columns, head = cols.map(function (c) { return csvCell(colTitle(c)); }).join(";");
    const lines = [head].concat(table.rows.map(function (r) { return cols.map(function (c) { return csvCell(csvValue(c, r[c.key])); }).join(";"); }));
    return "﻿" + lines.join("\r\n") + "\r\n";
  }
  const CSV_FILES = [["meta", "01_parametry.csv"], ["wallets", "02_gamantsi.csv"], ["ranking", "03_reiting_stratehii.csv"], ["accounts", "04_rakhunky.csv"], ["ops", "05_torhovi_operatsii.csv"], ["risks", "06_ryzyky.csv"], ["fees", "07_komisii.csv"], ["limits", "08_obmezhennia.csv"], ["sources", "09_dzherela.csv"]];
  function csvFiles(rep) {
    const out = []; CSV_FILES.forEach(function (f) { const t = rep.tables[f[0]]; if (!t) return; if (f[0] === "ops" && rep.params.kind !== "detailed") return; out.push({ name: f[1], text: tableCsv(t) }); });
    return out;
  }
  function csvSingle(rep) { return { name: "rakhunky.csv", text: tableCsv(rep.tables.accounts) }; }

  // ---------- CRC32 і ZIP ----------
  let CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function streamTransform(kind, u8) {        // kind: "deflate-raw" / "deflate" — стиснути; "inflate-raw" / "inflate" — розпакувати
    const dec = kind.indexOf("inflate") === 0, cs = dec ? new DecompressionStream(kind === "inflate-raw" ? "deflate-raw" : "deflate") : new CompressionStream(kind), w = cs.writable.getWriter();
    w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function deflateRaw(u8) { return streamTransform("deflate-raw", u8); }
  async function deflateZlib(u8) { return streamTransform("deflate", u8); }
  function canDeflate() { return typeof CompressionStream !== "undefined"; }
  function w16(a, v) { a.push(v & 255, (v >> 8) & 255); }
  function w32(a, v) { a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
  function dosTime(d) { return [((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xFFFF, (((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xFFFF]; }
  // entries: [{name, data: Uint8Array | string}]; повертає Uint8Array. Метод 8 (deflate-raw), якщо браузер уміє, інакше 0 (store).
  async function zip(entries, opts) {
    opts = opts || {}; const date = dosTime(new Date(opts.time || Date.now())), parts = [], central = []; let offset = 0;
    for (const e of entries) {
      const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data, name = enc.encode(e.name), crc = crc32(raw);
      let data = raw, method = 0; if (canDeflate() && raw.length > 64 && opts.store !== true) { try { const d = await deflateRaw(raw); if (d.length < raw.length) { data = d; method = 8; } } catch (x) { data = raw; method = 0; } }
      const lh = []; w32(lh, 0x04034b50); w16(lh, 20); w16(lh, 0x0800); w16(lh, method); w16(lh, date[0]); w16(lh, date[1]); w32(lh, crc); w32(lh, data.length); w32(lh, raw.length); w16(lh, name.length); w16(lh, 0);
      parts.push(new Uint8Array(lh), name, data);
      const ch = []; w32(ch, 0x02014b50); w16(ch, 20); w16(ch, 20); w16(ch, 0x0800); w16(ch, method); w16(ch, date[0]); w16(ch, date[1]); w32(ch, crc); w32(ch, data.length); w32(ch, raw.length); w16(ch, name.length); w16(ch, 0); w16(ch, 0); w16(ch, 0); w16(ch, 0); w32(ch, 0); w32(ch, offset);
      central.push(new Uint8Array(ch), name); offset += lh.length + name.length + data.length;
    }
    const cdSize = central.reduce(function (a, p) { return a + p.length; }, 0), end = []; w32(end, 0x06054b50); w16(end, 0); w16(end, 0); w16(end, entries.length); w16(end, entries.length); w32(end, cdSize); w32(end, offset); w16(end, 0);
    const all = parts.concat(central, [new Uint8Array(end)]), total = all.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(total); let o = 0; all.forEach(function (p) { out.set(p, o); o += p.length; }); return out;
  }
  // Читання (для перевірок): повертає [{name, data: Uint8Array, crcOk}]
  async function unzip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--; if (e < 0) throw new Error("немає EOCD");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [], dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("пошкоджений центральний каталог");
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csz = dv.getUint32(p + 20, true), usz = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true), name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true), start = lo + 30 + lnl + lxl, comp = u8.subarray(start, start + csz);
      const data = method === 0 ? comp.slice() : await streamTransform("inflate-raw", comp); out.push({ name: name, data: data, crcOk: crc32(data) === crc && data.length === usz }); p += 46 + nl + xl + cl;
    }
    return out;
  }

  // ---------- XLSX ----------
  function xesc(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function colName(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const ST = { def: 0, head: 1, title: 2, note: 3, text: 4, usd: 5, usd0: 6, pct: 7, pct0: 8, int: 9, dt: 10, num6: 11, price: 12, qp: 13, bold: 14, wrap: 15 };
  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;$&quot;"/><numFmt numFmtId="165" formatCode="#,##0\\ &quot;$&quot;"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="167" formatCode="0.000000"/><numFmt numFmtId="168" formatCode="#,##0.00####"/></numFmts>'
    + '<fonts count="5"><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="14"/><name val="Arial"/><family val="2"/></font><font><i/><sz val="9"/><color rgb="FF666666"/><name val="Arial"/><family val="2"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E2329"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D5DB"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="16">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" quotePrefix="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const TYPE_STYLE = { text: "text", usd: "usd", usd0: "usd0", pct: "pct", pct0: "pct0", dd: "pct", int: "int", dt: "dt", num: "num6", num6: "num6", price: "price" };
  const WIDTH = { text: 30, usd: 15, usd0: 13, pct: 13, pct0: 11, dd: 13, int: 11, dt: 18, num6: 14, price: 14 };
  function serial(t) { return t / 86400000 + 25569; }
  // клітинка: {v, st} → XML; null → пропуск
  function cellXml(ref, v, type) {
    if (v === null || v === undefined || v === "") return "";
    if (type === "dt") return num(v) ? '<c r="' + ref + '" s="' + ST.dt + '"><v>' + serial(v) + "</v></c>" : "";
    if (type === "pct" || type === "pct0") return num(v) ? '<c r="' + ref + '" s="' + ST[type] + '"><v>' + (v / 100) + "</v></c>" : "";
    if (type === "dd") return num(v) ? '<c r="' + ref + '" s="' + ST.pct + '"><v>' + (v < 0.005 ? 0 : -v / 100) + "</v></c>" : "";
    if (type === "usd" || type === "usd0" || type === "int" || type === "num6" || type === "num" || type === "price") return num(v) ? '<c r="' + ref + '" s="' + ST[TYPE_STYLE[type]] + '"><v>' + v + "</v></c>" : "";
    let s = String(v); if (s.length > 32000) s = s.slice(0, 32000) + "…";
    const style = /^[=+\-@\t\r]/.test(s) ? ST.qp : ST.text;                                   // текст ніколи не є формулою: рядок + quotePrefix для «небезпечних» початків
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(s) + "</t></is></c>";
  }
  function textCell(ref, s, style) { return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(s) + "</t></is></c>"; }
  // blocks: [{kind:"title",text}, {kind:"note",text}, {kind:"table", table, filter:bool}, {kind:"blank"}]
  function sheetXml(blocks, opt) {
    let r = 1, rows = [], filterRef = null, freezeRow = 0, maxCols = 1, merges = [], widths = [];
    function pushRow(cells, h) { rows.push('<row r="' + r + '"' + (h ? ' ht="' + h + '" customHeight="1"' : "") + ">" + cells.join("") + "</row>"); r++; }
    blocks.forEach(function (b) {
      if (b.kind === "blank") { r++; return; }
      if (b.kind === "title") { pushRow([textCell("A" + r, b.text, ST.title)], 22); return; }
      if (b.kind === "note") { const row = r; pushRow([textCell("A" + row, b.text, ST.note)], Math.max(15, Math.ceil(b.text.length / 110) * 13)); merges.push("A" + row + ":" + colName(Math.max(5, b.span || 8) - 1) + row); return; }
      if (b.kind === "kv") { b.table.rows.forEach(function (x) { pushRow([textCell("A" + r, x.k, ST.bold), cellXml("B" + r, x.v, "text") || textCell("B" + r, "", ST.text)].concat([])); }); widths[0] = Math.max(widths[0] || 0, 34); widths[1] = Math.max(widths[1] || 0, 90); maxCols = Math.max(maxCols, 2); return; }
      const t = b.table, cols = t.columns, headRow = r; maxCols = Math.max(maxCols, cols.length);
      pushRow(cols.map(function (c, i) { return textCell(colName(i) + r, c.title, ST.head); }), 32);
      t.rows.forEach(function (x) { pushRow(cols.map(function (c, i) { return cellXml(colName(i) + r, x[c.key], c.type); })); });
      cols.forEach(function (c, i) { const wdt = Math.min(60, Math.max(WIDTH[c.type] || 14, Math.min(44, Math.ceil(c.title.length * 0.9)))); widths[i] = Math.max(widths[i] || 0, wdt); });
      if (b.filter) { filterRef = "A" + headRow + ":" + colName(cols.length - 1) + (headRow + t.rows.length); if (b.freeze !== false) freezeRow = headRow; }
    });
    const lastRow = Math.max(1, r - 1);
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    x += '<dimension ref="A1:' + colName(maxCols - 1) + lastRow + '"/>';
    x += '<sheetViews><sheetView workbookViewId="0"' + (opt && opt.first ? ' tabSelected="1"' : "") + ' showGridLines="1">' + (freezeRow ? '<pane ySplit="' + freezeRow + '" topLeftCell="A' + (freezeRow + 1) + '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A' + (freezeRow + 1) + '" sqref="A' + (freezeRow + 1) + '"/>' : "") + "</sheetView></sheetViews>";
    x += '<sheetFormatPr defaultRowHeight="14"/>';
    if (widths.length) x += "<cols>" + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join("") + "</cols>";
    x += "<sheetData>" + rows.join("") + "</sheetData>";
    if (filterRef) x += '<autoFilter ref="' + filterRef + '"/>';
    if (merges.length) x += '<mergeCells count="' + merges.length + '">' + merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join("") + "</mergeCells>";
    x += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/>';
    return x + "</worksheet>";
  }
  function xlsxSheets(rep) {
    const T = rep.tables, per = rep.periodText, p = rep.params, s = [];
    s.push({ name: "Підсумок", blocks: [{ kind: "title", text: "Аналітичний звіт Crypto Prosto · Analytics Pro" }, { kind: "kv", table: T.meta }, { kind: "blank" }, { kind: "title", text: T.wallets.title }, { kind: "table", table: T.wallets }, { kind: "note", text: T.wallets.note, span: 10 }] });
    s.push({ name: "Рейтинг стратегій", blocks: [{ kind: "table", table: T.ranking, filter: true }, { kind: "blank" }, { kind: "note", text: T.ranking.note, span: 8 }] });
    s.push({ name: "Рахунки", blocks: [{ kind: "table", table: T.accounts, filter: true }, { kind: "blank" }, { kind: "note", text: T.accounts.note, span: 12 }] });
    s.push({ name: "Торгові операції", blocks: p.kind === "detailed" ? [{ kind: "table", table: T.ops, filter: true }, { kind: "blank" }, { kind: "note", text: T.ops.note, span: 10 }] : [{ kind: "note", text: "У короткому звіті перелік операцій не включено. Оберіть тип «детальний», щоб додати операції.", span: 8 }] });
    s.push({ name: "Ризики", blocks: [{ kind: "table", table: T.risks, filter: true }, { kind: "blank" }, { kind: "note", text: T.risks.note, span: 10 }, { kind: "blank" }, { kind: "title", text: T.fees.title }, { kind: "table", table: T.fees }, { kind: "note", text: T.fees.note, span: 8 }] });
    s.push({ name: "Джерела та обмеження", blocks: [{ kind: "title", text: T.limits.title }, { kind: "kv", table: T.limits }, { kind: "blank" }, { kind: "title", text: T.sources.title }, { kind: "kv", table: T.sources }] });
    void per; return s;
  }
  async function xlsx(rep, opts) {
    const sheets = xlsxSheets(rep), now = new Date(rep.generatedAt || Date.now()), iso = now.toISOString().replace(/\.\d+Z$/, "Z");
    const files = [];
    files.push({ name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map(function (x, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("")
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' });
    files.push({ name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' });
    files.push({ name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
      + sheets.map(function (x, i) { return '<sheet name="' + xesc(x.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join("") + "</sheets></workbook>" });
    files.push({ name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map(function (x, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join("")
      + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' });
    files.push({ name: "xl/styles.xml", data: STYLES });
    sheets.forEach(function (x, i) { files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(x.blocks, { first: i === 0 }) }); });
    files.push({ name: "docProps/core.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Аналітичний звіт Crypto Prosto</dc:title><dc:creator>Crypto Prosto · Analytics Pro</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created></cp:coreProperties>' });
    files.push({ name: "docProps/app.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Crypto Prosto Analytics Pro</Application></Properties>' });
    return zip(files, { time: now.getTime(), store: opts && opts.store });
  }

  root.ReportExport = { csvCell: csvCell, tableCsv: tableCsv, csvFiles: csvFiles, csvSingle: csvSingle, crc32: crc32, zip: zip, unzip: unzip, xlsx: xlsx, xlsxSheets: xlsxSheets, deflateZlib: deflateZlib, canDeflate: canDeflate, colTitle: colTitle, serial: serial, ST: ST, STYLES: STYLES };
})(typeof window !== "undefined" ? window : this);
