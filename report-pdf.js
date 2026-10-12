// PDF-звіт без зовнішніх бібліотек: власний мінімальний генератор PDF 1.5 з вбудованим TrueType-шрифтом (Identity-H, ToUnicode), вектор­ними графіками й таблицями з переносом між сторінками.
// Шрифт потрібен лише для кирилиці: його файл (.ttf) передається ззовні (fontBytes.regular / fontBytes.bold). Із шрифту вбудовується ПІДМНОЖИНА (лише використані гліфи).
// Генерація асинхронна (віддає керування браузеру між частинами) і повідомляє про прогрес. Тестується в tools/test-reports.html.

(function (root) {
  "use strict";
  const enc = new TextEncoder();
  function num(v) { return typeof v === "number" && isFinite(v); }

  // ---------- TrueType ----------
  function parseTTF(ab, opt) {
    const dv = new DataView(ab), u8 = new Uint8Array(ab); let base = 0;
    if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12);                      // колекція .ttc: перший шрифт
    const n = dv.getUint16(base + 4), tables = {};
    for (let i = 0; i < n; i++) { const p = base + 12 + i * 16, tag = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); tables[tag] = { off: dv.getUint32(p + 8), len: dv.getUint32(p + 12) }; }
    ["head", "hhea", "maxp", "hmtx", "loca", "glyf"].concat(opt && opt.noCmap ? [] : ["cmap"]).forEach(function (t) { if (!tables[t]) throw new Error("у шрифті немає таблиці " + t + " (потрібен TrueType з контурами glyf)"); });
    const head = tables.head.off, hhea = tables.hhea.off, f = { ab: ab, dv: dv, u8: u8, tables: tables };
    f.unitsPerEm = dv.getUint16(head + 18); f.bbox = [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)]; f.locFmt = dv.getInt16(head + 50);
    f.ascent = dv.getInt16(hhea + 4); f.descent = dv.getInt16(hhea + 6); f.numH = dv.getUint16(hhea + 34); f.numGlyphs = dv.getUint16(tables.maxp.off + 4);
    f.capHeight = f.ascent * 0.7;
    if (tables["OS/2"] && tables["OS/2"].len >= 90 && dv.getUint16(tables["OS/2"].off) >= 2) f.capHeight = dv.getInt16(tables["OS/2"].off + 88) || f.capHeight;
    f.cmapSub = opt && opt.noCmap ? null : pickCmap(f); f.cache = {};
    return f;
  }
  function pickCmap(f) {
    const dv = f.dv, o = f.tables.cmap.off, n = dv.getUint16(o + 2); let best = null;
    for (let i = 0; i < n; i++) { const pid = dv.getUint16(o + 4 + i * 8), eid = dv.getUint16(o + 6 + i * 8), off = o + dv.getUint32(o + 8 + i * 8), fmt = dv.getUint16(off); const score = (pid === 3 && eid === 10 && fmt === 12) ? 4 : (pid === 3 && eid === 1 && fmt === 4) ? 3 : (pid === 0 && (fmt === 4 || fmt === 12)) ? 2 : 0; if (score && (!best || score > best.score)) best = { off: off, fmt: fmt, score: score }; }
    if (!best) throw new Error("у шрифті немає Unicode-таблиці cmap (формат 4 або 12)"); return best;
  }
  function gidOf(f, cp) {
    if (f.cache[cp] !== undefined) return f.cache[cp];
    const dv = f.dv, o = f.cmapSub.off; let g = 0;
    if (f.cmapSub.fmt === 4) {
      const sc = dv.getUint16(o + 6) / 2, endO = o + 14, startO = endO + sc * 2 + 2, deltaO = startO + sc * 2, rangeO = deltaO + sc * 2;
      for (let i = 0; i < sc; i++) { if (cp <= dv.getUint16(endO + i * 2)) { const st = dv.getUint16(startO + i * 2); if (cp >= st) { const ro = dv.getUint16(rangeO + i * 2); if (ro === 0) g = (cp + dv.getInt16(deltaO + i * 2)) & 0xFFFF; else { const gp = rangeO + i * 2 + ro + (cp - st) * 2; g = dv.getUint16(gp); if (g) g = (g + dv.getInt16(deltaO + i * 2)) & 0xFFFF; } } break; } }
    } else {
      const ng = dv.getUint32(o + 12); let lo = 0, hi = ng - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1, p = o + 16 + mid * 12, s = dv.getUint32(p), e = dv.getUint32(p + 4); if (cp < s) hi = mid - 1; else if (cp > e) lo = mid + 1; else { g = dv.getUint32(p + 8) + (cp - s); break; } }
    }
    f.cache[cp] = g; return g;
  }
  function advance(f, g) { const i = g < f.numH ? g : f.numH - 1; return f.dv.getUint16(f.tables.hmtx.off + i * 4); }
  function glyphRange(f, g) {
    const dv = f.dv, lo = f.tables.loca.off; let a, b;
    if (f.locFmt === 0) { a = dv.getUint16(lo + g * 2) * 2; b = dv.getUint16(lo + g * 2 + 2) * 2; } else { a = dv.getUint32(lo + g * 4); b = dv.getUint32(lo + g * 4 + 4); }
    return [f.tables.glyf.off + a, f.tables.glyf.off + b];
  }
  function checksum(u8) { let s = 0; const n = u8.length; for (let i = 0; i < n; i += 4) { s = (s + (((u8[i] << 24) | ((u8[i + 1] || 0) << 16) | ((u8[i + 2] || 0) << 8) | (u8[i + 3] || 0)) >>> 0)) >>> 0; } return s >>> 0; }
  // Підмножина шрифту: ті самі номери гліфів, невикористані гліфи порожні; зберігаються лише потрібні для PDF таблиці
  function subsetTTF(f, gids) {
    const need = new Set(gids); need.add(0); const q = Array.from(need);
    while (q.length) {
      const g = q.pop(), r = glyphRange(f, g); if (r[1] - r[0] < 10) continue;
      if (f.dv.getInt16(r[0]) < 0) { let p = r[0] + 10, flags; do { flags = f.dv.getUint16(p); const gi = f.dv.getUint16(p + 2); if (!need.has(gi)) { need.add(gi); q.push(gi); } p += 4 + ((flags & 1) ? 4 : 2); if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8; } while (flags & 0x20); }
    }
    const chunks = [], loca = new DataView(new ArrayBuffer((f.numGlyphs + 1) * 4)); let off = 0;
    for (let g = 0; g < f.numGlyphs; g++) { loca.setUint32(g * 4, off); if (need.has(g)) { const r = glyphRange(f, g), len = r[1] - r[0]; if (len > 0) { const pad = (4 - (len % 4)) % 4, c = new Uint8Array(len + pad); c.set(f.u8.subarray(r[0], r[1])); chunks.push(c); off += c.length; } } }
    loca.setUint32(f.numGlyphs * 4, off);
    const glyf = new Uint8Array(off); let o = 0; chunks.forEach(function (c) { glyf.set(c, o); o += c.length; });
    const tbl = {}; ["hhea", "maxp", "hmtx", "cvt ", "fpgm", "prep"].forEach(function (t) { if (f.tables[t]) tbl[t] = f.u8.slice(f.tables[t].off, f.tables[t].off + f.tables[t].len); });
    const head = f.u8.slice(f.tables.head.off, f.tables.head.off + f.tables.head.len); new DataView(head.buffer).setUint32(8, 0); new DataView(head.buffer).setInt16(50, 1);
    tbl.head = head; tbl.loca = new Uint8Array(loca.buffer); tbl.glyf = glyf;
    const tags = Object.keys(tbl).sort(), nt = tags.length; let sr = 1, es = 0; while (sr * 2 <= nt) { sr *= 2; es++; }
    let pos = 12 + nt * 16; const parts = [], recs = new DataView(new ArrayBuffer(12 + nt * 16)); recs.setUint32(0, 0x00010000); recs.setUint16(4, nt); recs.setUint16(6, sr * 16); recs.setUint16(8, es); recs.setUint16(10, nt * 16 - sr * 16);
    tags.forEach(function (t, i) { const d = tbl[t], pad = (4 - (d.length % 4)) % 4, p = new Uint8Array(d.length + pad); p.set(d); for (let k = 0; k < 4; k++) recs.setUint8(12 + i * 16 + k, t.charCodeAt(k)); recs.setUint32(12 + i * 16 + 4, checksum(p)); recs.setUint32(12 + i * 16 + 8, pos); recs.setUint32(12 + i * 16 + 12, d.length); parts.push(p); pos += p.length; });
    const out = new Uint8Array(pos); out.set(new Uint8Array(recs.buffer), 0); let w = 12 + nt * 16; parts.forEach(function (p) { out.set(p, w); w += p.length; });
    const hi = tags.indexOf("head"), hoff = parseInt(recs.getUint32(12 + hi * 16 + 8)); new DataView(out.buffer).setUint32(hoff + 8, (0xB1B0AFBA - checksum(out)) >>> 0);
    return out;
  }

  // ---------- шрифт у PDF ----------
  function Face(bytes, name, bold) { this.f = parseTTF(bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); this.name = name; this.fauxBold = !!bold; this.used = {}; this.uni = {}; }
  const FALLBACK = { " ": " ", " ": " ", " ": " ", "−": "-", "–": "-", "—": "-", "…": "...", "·": "-", "≥": ">=", "≈": "~", "→": "->", "←": "<-", "▲": "^", "▼": "v", "’": "'", "«": '"', "»": '"', "×": "x", "⁄": "/" };
  Face.prototype.encode = function (text) {
    const f = this.f; let hex = "", w = 0;
    for (const ch of Array.from(String(text))) {
      let cp = ch.codePointAt(0), g = gidOf(f, cp);
      if (!g) { const fb = FALLBACK[ch]; if (fb !== undefined) { for (const c2 of Array.from(fb)) { const g2 = gidOf(f, c2.codePointAt(0)); if (g2) { hex += hx(g2); w += advance(f, g2); this.used[g2] = advance(f, g2); this.uni[g2] = c2.codePointAt(0); } } continue; } g = gidOf(f, 63); cp = 63; if (!g) continue; }
      hex += hx(g); w += advance(f, g); this.used[g] = advance(f, g); this.uni[g] = cp;
    }
    return { hex: hex, width: w };
  };
  Face.prototype.width = function (text, size) { const f = this.f; let w = 0; for (const ch of Array.from(String(text))) { let cp = ch.codePointAt(0), g = gidOf(f, cp); if (!g) { const fb = FALLBACK[ch]; if (fb !== undefined) { for (const c2 of Array.from(fb)) w += advance(f, gidOf(f, c2.codePointAt(0)) || 0); continue; } g = gidOf(f, 63); } w += advance(f, g); } return w / f.unitsPerEm * size; };
  function hx(g) { return ("0000" + g.toString(16)).slice(-4); }

  // ---------- PDF-документ ----------
  const PW = 595.28, PH = 841.89;
  function PdfDoc(fonts, meta) { this.fonts = fonts; this.meta = meta || {}; this.pages = []; this.cur = null; this.margin = 36; this.tops = 52; this.bottom = 42; }
  PdfDoc.prototype.addPage = function (landscape) { const p = { w: landscape ? PH : PW, h: landscape ? PW : PH, ops: [], landscape: !!landscape }; this.pages.push(p); this.cur = p; this.y = this.tops; return p; };
  PdfDoc.prototype.cw = function () { return this.cur.w - this.margin * 2; };
  function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(function (x) { return x.toFixed(3); }).join(" "); }
  PdfDoc.prototype.text = function (x, y, s, size, o) {
    o = o || {}; const face = o.bold && !this.fauxBold ? this.fonts.bold : this.fonts.regular, e = face.encode(s), p = this.cur; let tx = x;
    if (o.align === "right") tx = x - e.width / face.f.unitsPerEm * size; else if (o.align === "center") tx = x - e.width / face.f.unitsPerEm * size / 2;
    p.ops.push("BT /" + (o.bold && !this.fauxBold ? "F2" : "F1") + " " + size.toFixed(2) + " Tf " + rgb(o.color || "#1E2329") + " rg " + (this.fauxBold && o.bold ? "2 Tr " + rgb(o.color || "#1E2329") + " RG 0.25 w " : "") + tx.toFixed(2) + " " + (p.h - y).toFixed(2) + " Td <" + e.hex + "> Tj" + (this.fauxBold && o.bold ? " 0 Tr" : "") + " ET");
  };
  PdfDoc.prototype.rect = function (x, y, w, h, fill, stroke, lw) { const p = this.cur; p.ops.push((fill ? rgb(fill) + " rg " : "") + (stroke ? rgb(stroke) + " RG " + (lw || 0.5) + " w " : "") + x.toFixed(2) + " " + (p.h - y - h).toFixed(2) + " " + w.toFixed(2) + " " + h.toFixed(2) + " re " + (fill && stroke ? "B" : fill ? "f" : "S")); };
  PdfDoc.prototype.line = function (x1, y1, x2, y2, color, lw) { const p = this.cur; p.ops.push(rgb(color || "#D0D5DB") + " RG " + (lw || 0.5) + " w " + x1.toFixed(2) + " " + (p.h - y1).toFixed(2) + " m " + x2.toFixed(2) + " " + (p.h - y2).toFixed(2) + " l S"); };
  PdfDoc.prototype.poly = function (pts, color, lw) { const p = this.cur; if (pts.length < 2) return; p.ops.push(rgb(color) + " RG " + (lw || 1) + " w 1 j 1 J " + pts.map(function (q, i) { return q[0].toFixed(2) + " " + (p.h - q[1]).toFixed(2) + (i ? " l" : " m"); }).join(" ") + " S"); };
  PdfDoc.prototype.wrap = function (s, size, width, bold) {
    const face = bold ? this.fonts.bold : this.fonts.regular, out = []; String(s === null || s === undefined ? "" : s).split(/\n/).forEach(function (par) {
      let line = ""; par.split(/\s+/).forEach(function (wd) {
        if (!wd && line === "") return; const t = line ? line + " " + wd : wd;
        if (face.width(t, size) <= width) { line = t; return; }
        if (line) { out.push(line); line = ""; }
        if (face.width(wd, size) <= width) { line = wd; return; }
        let cur = ""; Array.from(wd).forEach(function (ch) { if (face.width(cur + ch, size) > width && cur) { out.push(cur); cur = ch; } else cur += ch; }); line = cur;
      }); out.push(line);
    }); return out.length ? out : [""];
  };
  PdfDoc.prototype.ensure = function (h, landscape) { if (this.y + h > this.cur.h - this.bottom) { this.addPage(this.cur.landscape); return true; } return false; };
  PdfDoc.prototype.paragraph = function (s, size, o) { o = o || {}; const lh = size * 1.35, lines = this.wrap(s, size, this.cw() - (o.indent || 0), o.bold), self = this; lines.forEach(function (l) { self.ensure(lh); self.text(self.margin + (o.indent || 0), self.y + size, l, size, o); self.y += lh; }); this.y += o.after === undefined ? 3 : o.after; };
  PdfDoc.prototype.heading = function (s, level) { const size = level === 1 ? 14 : 11; this.ensure(size * 3); this.y += level === 1 ? 8 : 5; this.text(this.margin, this.y + size, s, size, { bold: true, color: "#1E2329" }); this.y += size + 3; this.line(this.margin, this.y, this.margin + this.cw(), this.y, "#F0B90B", 1.2); this.y += 6; };
  // таблиця: columns [{title, w (відносна), align, get(row) -> string, color(row)?}], rows масив
  PdfDoc.prototype.table = function (cols, rows, o) {
    o = o || {}; const size = o.size || 7.5, pad = 3, lh = size * 1.3, tw = this.cw(), sum = cols.reduce(function (a, c) { return a + (c.w || 1); }, 0), ws = cols.map(function (c) { return tw * (c.w || 1) / sum; }), self = this;
    function header() {
      const lines = cols.map(function (c, i) { return self.wrap(c.title, size, ws[i] - pad * 2, true); }), hh = Math.max.apply(null, lines.map(function (l) { return l.length; })) * lh + pad * 2;
      self.ensure(hh + lh * 2); self.rect(self.margin, self.y, tw, hh, "#1E2329"); let x = self.margin; cols.forEach(function (c, i) { lines[i].forEach(function (l, k) { self.text(c.align === "right" ? x + ws[i] - pad : x + pad, self.y + pad + size + k * lh - 1, l, size, { bold: true, color: "#FFFFFF", align: c.align === "right" ? "right" : "left" }); }); x += ws[i]; }); self.y += hh; return hh;
    }
    header(); let zebra = false;
    rows.forEach(function (r) {
      const cells = cols.map(function (c, i) { const v = c.get(r); return self.wrap(v === null || v === undefined || v === "" ? "—" : String(v), size, ws[i] - pad * 2, c.bold); }), rh = Math.max.apply(null, cells.map(function (l) { return l.length; })) * lh + pad * 2;
      if (self.y + rh > self.cur.h - self.bottom) { self.addPage(self.cur.landscape); header(); zebra = false; }
      if (r.__group) { self.rect(self.margin, self.y, tw, rh, "#FFF4CC"); self.text(self.margin + pad, self.y + pad + size - 1, r.__group, size, { bold: true }); self.y += rh; zebra = false; return; }
      if (zebra) self.rect(self.margin, self.y, tw, rh, "#F5F6F8"); zebra = !zebra;
      let x = self.margin; cols.forEach(function (c, i) { const col = c.color ? c.color(r) : null; cells[i].forEach(function (l, k) { self.text(c.align === "right" ? x + ws[i] - pad : x + pad, self.y + pad + size + k * lh - 1, l, size, { align: c.align === "right" ? "right" : "left", color: col || "#1E2329", bold: !!c.bold }); }); x += ws[i]; });
      self.line(self.margin, self.y + rh, self.margin + tw, self.y + rh, "#E3E6EA", 0.4); self.y += rh;
    });
    this.y += 6;
  };
  PdfDoc.prototype.cards = function (items) {
    const n = items.length, gap = 6, w = (this.cw() - gap * (n - 1)) / n, h = 46; this.ensure(h + 6); const self = this, y0 = this.y;
    items.forEach(function (it, i) { const x = self.margin + i * (w + gap); self.rect(x, y0, w, h, "#F5F6F8", "#D0D5DB", 0.5); self.rect(x, y0, 3, h, "#F0B90B"); self.paragraphAt(x + 8, y0 + 5, w - 12, it.label, 7, { color: "#5B6573" }); self.text(x + 8, y0 + 33, it.value, 13, { bold: true, color: it.color || "#1E2329" }); if (it.sub) self.text(x + 8, y0 + 42, it.sub, 6.5, { color: "#5B6573" }); });
    this.y += h + 8;
  };
  PdfDoc.prototype.paragraphAt = function (x, y, width, s, size, o) { const lines = this.wrap(s, size, width), self = this; lines.slice(0, 2).forEach(function (l, i) { self.text(x, y + size + i * size * 1.25, l, size, o); }); };
  // графік: series [{title,color,pts:[[t,v]]}]
  PdfDoc.prototype.chart = function (title, series, o) {
    o = o || {}; const h = o.h || 150, w = this.cw(), left = 36, right = 8, top = 10, bottom = 22; this.ensure(h + 52 + series.length * 4); this.paragraph(title, 9, { bold: true, after: 2 });
    const x0 = this.margin + left, x1 = this.margin + w - right, y0 = this.y + top, y1 = this.y + h - bottom; let tmin = Infinity, tmax = -Infinity, vmin = Infinity, vmax = -Infinity;
    series.forEach(function (s) { s.pts.forEach(function (p) { tmin = Math.min(tmin, p[0]); tmax = Math.max(tmax, p[0]); vmin = Math.min(vmin, p[1]); vmax = Math.max(vmax, p[1]); }); }); vmin = Math.min(vmin, 0); vmax = Math.max(vmax, 0); if (vmax - vmin < 0.2) { vmax += 0.1; vmin -= 0.1; } const padv = (vmax - vmin) * 0.08; vmin -= padv; vmax += padv; if (tmax <= tmin) tmax = tmin + 1;
    const X = function (t) { return x0 + (t - tmin) / (tmax - tmin) * (x1 - x0); }, Y = function (v) { return y1 - (v - vmin) / (vmax - vmin) * (y1 - y0); };
    this.rect(x0, y0, x1 - x0, y1 - y0, "#FFFFFF", "#D0D5DB", 0.5);
    for (let i = 0; i <= 4; i++) { const v = vmin + (vmax - vmin) * i / 4, yy = Y(v); this.line(x0, yy, x1, yy, "#ECEEF1", 0.4); this.text(x0 - 3, yy + 2.5, (Math.abs(v) < 0.005 ? "0" : v.toFixed(2)).replace(".", ",") + "%", 6.5, { align: "right", color: "#5B6573" }); }
    if (vmin < 0 && vmax > 0) this.line(x0, Y(0), x1, Y(0), "#8A94A3", 0.7);
    const dt = function (t) { const d = new Date(t), p = function (n) { return ("0" + n).slice(-2); }; return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()); };
    for (let i = 0; i <= 3; i++) { const t = tmin + (tmax - tmin) * i / 3; this.text(X(t), y1 + 10, dt(t), 6.5, { align: i === 0 ? "left" : i === 3 ? "right" : "center", color: "#5B6573" }); }
    series.forEach(function (s) { this.poly(s.pts.map(function (p) { return [X(p[0]), Y(p[1])]; }), s.color, 1); }, this);
    this.y = y1 + bottom + 6; let lx = this.margin; const self = this;
    series.forEach(function (s) { const lw = self.fonts.regular.width(s.title, 7) + 16; if (lx + lw > self.margin + w) { lx = self.margin; self.y += 10; self.ensure(12); } self.rect(lx, self.y - 5, 8, 3, s.color); self.text(lx + 11, self.y - 2, s.title, 7); lx += lw + 6; });
    this.y += 12;
  };

  // ---------- збирання файлу ----------
  function esc(s) { return String(s).replace(/[\\()]/g, function (c) { return "\\" + c; }); }
  async function compress(u8) { if (typeof CompressionStream === "undefined") return null; const cs = new CompressionStream("deflate"), w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
  async function finish(doc, progress) {
    const faces = [["F1", doc.fonts.regular], ["F2", doc.fonts.bold]], objs = [], add = function (body) { objs.push(body); return objs.length; };
    const stream = async function (dict, u8) { const z = await compress(u8), data = z && z.length < u8.length ? z : u8; return { head: dict + (data === u8 ? "" : " /Filter /FlateDecode") + " /Length " + data.length, data: data }; };
    add(null); add(null);                                                    // 1: каталог, 2: сторінки (заповнюємо наприкінці)
    const fontRefs = {}, seen = new Map();
    for (const fe of faces) {
      const face = fe[1]; if (seen.has(face)) { fontRefs[fe[0]] = seen.get(face); continue; }
      const gids = Object.keys(face.used).map(Number); const sub = subsetTTF(face.f, gids), file = await stream("<< /Length1 " + sub.length, sub);
      const fileId = add({ s: file }), fname = "CPSans" + (seen.size ? "B" : "R"), tag = (seen.size ? "BBBBBB+" : "AAAAAA+") + fname, f = face.f, sc = 1000 / f.unitsPerEm;
      const desc = add("<< /Type /FontDescriptor /FontName /" + tag + " /Flags 4 /FontBBox [" + f.bbox.map(function (v) { return Math.round(v * sc); }).join(" ") + "] /ItalicAngle 0 /Ascent " + Math.round(f.ascent * sc) + " /Descent " + Math.round(f.descent * sc) + " /CapHeight " + Math.round(f.capHeight * sc) + " /StemV 80 /FontFile2 " + fileId + " 0 R >>");
      const widths = gids.sort(function (a, b) { return a - b; }).map(function (g) { return g + " [" + Math.round(face.used[g] * sc) + "]"; }).join(" ");
      const cid = add("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /" + tag + " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor " + desc + " 0 R /CIDToGIDMap /Identity /DW 1000 /W [" + widths + "] >>");
      let cm = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n";
      for (let i = 0; i < gids.length; i += 100) { const part = gids.slice(i, i + 100); cm += part.length + " beginbfchar\n" + part.map(function (g) { const cp = face.uni[g]; let u = ""; if (cp !== undefined) { if (cp > 0xFFFF) { const c = cp - 0x10000; u = hx(0xD800 + (c >> 10)) + hx(0xDC00 + (c & 1023)); } else u = hx(cp); } return "<" + hx(g) + "> <" + (u || "0000") + ">"; }).join("\n") + "\nendbfchar\n"; }
      cm += "endcmap CMapName currentdict /CMap defineresource pop end end";
      const tu = add({ s: await stream("<<", enc.encode(cm)) });
      const t0 = add("<< /Type /Font /Subtype /Type0 /BaseFont /" + tag + " /Encoding /Identity-H /DescendantFonts [" + cid + " 0 R] /ToUnicode " + tu + " 0 R >>");
      seen.set(face, t0); fontRefs[fe[0]] = t0;
    }
    const pageIds = [];
    for (let i = 0; i < doc.pages.length; i++) {
      const p = doc.pages[i], content = enc.encode(p.ops.join("\n")), cs = await stream("<<", content), cid = add({ s: cs });
      pageIds.push(add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w.toFixed(2) + " " + p.h.toFixed(2) + "] /Resources << /Font << /F1 " + fontRefs.F1 + " 0 R /F2 " + fontRefs.F2 + " 0 R >> >> /Contents " + cid + " 0 R >>"));
      if (progress && i % 4 === 3) { await progress(0.8 + 0.2 * (i / doc.pages.length)); }
    }
    objs[1] = "<< /Type /Pages /Kids [" + pageIds.map(function (x) { return x + " 0 R"; }).join(" ") + "] /Count " + pageIds.length + " >>";
    const infoId = add("<< /Title <" + utf16hex(doc.meta.title || "Звіт") + "> /Author <" + utf16hex("Crypto Prosto · Analytics Pro") + "> /Producer (Crypto Prosto report generator) /CreationDate (" + pdfDate(doc.meta.date) + ") >>");
    objs[0] = "<< /Type /Catalog /Pages 2 0 R /Lang (uk-UA) /ViewerPreferences << /DisplayDocTitle true >> >>";
    const chunks = [], offs = []; let pos = 0, push = function (u) { chunks.push(u); pos += u.length; };
    push(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 53, 10, 37, 226, 227, 207, 211, 10]));                // «%PDF-1.5» і бінарний маркер
    objs.forEach(function (o, i) {
      offs[i] = pos; push(enc.encode((i + 1) + " 0 obj\n"));
      if (o && o.s) { push(enc.encode(o.s.head + " >>\nstream\n")); }
      else push(enc.encode(o + "\n"));
      if (o && o.s) { push(o.s.data); push(enc.encode("\nendstream\n")); }
      push(enc.encode("endobj\n"));
    });
    const xref = pos; push(enc.encode("xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offs.map(function (o) { return ("0000000000" + o).slice(-10) + " 00000 n \n"; }).join("") + "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R /Info " + infoId + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n"));
    const out = new Uint8Array(pos); let o2 = 0; chunks.forEach(function (c) { out.set(c, o2); o2 += c.length; }); return out;
  }
  function utf16hex(s) { let h = "FEFF"; for (const ch of String(s)) { const cp = ch.codePointAt(0); if (cp > 0xFFFF) { const c = cp - 0x10000; h += hx(0xD800 + (c >> 10)) + hx(0xDC00 + (c & 1023)); } else h += hx(cp); } return h; }
  function pdfDate(t) { const d = new Date(t || Date.now()), p = function (n) { return ("0" + n).slice(-2); }; return "D:" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"; }
  const tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  // ---------- звіт ----------
  function fmtNum(v, d) { return v.toLocaleString("uk-UA", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ | /g, " ").replace("-", "−"); }
  function signed(v, d, unit) { return (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), d) + unit; }
  function tone(v) { return v > 0.00001 ? "#0A8F5A" : v < -0.00001 ? "#C9283D" : "#1E2329"; }
  function usd(v) { return v === null || v === undefined ? "—" : signed(v, 2, " $"); }
  function pct(v) { return v === null || v === undefined ? "—" : signed(v, 2, "%"); }
  function ddTxt(v) { return v === null || v === undefined ? "—" : v < 0.005 ? "0,00%" : "−" + fmtNum(v, 2) + "%"; }
  function dtTxt(t) { return new Date(t).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }); }

  async function generate(rep, fontBytes, opts) {
    opts = opts || {}; const progress = opts.progress || function () { return Promise.resolve(); };
    if (!fontBytes || !fontBytes.regular) throw new Error("Немає шрифту для PDF: додайте файл шрифту з підтримкою кирилиці (assets/fonts/NotoSans-Regular.ttf).");
    const regular = new Face(fontBytes.regular, "R", false), bold = fontBytes.bold ? new Face(fontBytes.bold, "B", false) : regular;
    const doc = new PdfDoc({ regular: regular, bold: bold }, { title: "Аналітичний звіт Crypto Prosto", date: rep.generatedAt }), T = rep.tables, P = rep.params, A = rep.availability, W = Object.keys(rep.kpis).map(Number);
    doc.fauxBold = !fontBytes.bold;                                          // немає жирного накреслення: жирний текст імітується обведенням звичайного
    doc.addPage(false);
    // шапка
    doc.rect(0, 0, doc.cur.w, 70, "#1E2329"); doc.rect(0, 70, doc.cur.w, 3, "#F0B90B");
    doc.text(36, 32, "Крипто простими словами", 10, { color: "#F0B90B", bold: true }); doc.text(36, 54, "Аналітичний звіт · Analytics Pro", 18, { color: "#FFFFFF", bold: true });
    doc.text(doc.cur.w - 36, 32, "Сформовано: " + ReportCoreFmt(rep.generatedAt), 8, { color: "#C9CED6", align: "right" }); doc.text(doc.cur.w - 36, 48, "Paper Trading · віртуальні рахунки", 8, { color: "#C9CED6", align: "right" });
    doc.y = 90;
    doc.paragraph("Період: " + rep.periodText, 9, { bold: true, after: 1 }); doc.paragraph("Фільтри: " + rep.filtersText, 8.5, { after: 1 }); doc.paragraph("Дані станом на: " + ReportCoreFmt(rep.period.asOf) + ".  Рахунків у звіті: " + A.accounts + ", з достовірним equity: " + A.withEquity + ".", 8.5, { after: 4 });
    rep.period.notes.forEach(function (n) { doc.paragraph("Примітка: " + n, 8, { color: "#8A5A00", after: 1 }); });
    await progress(0.1);
    // 2. підсумок
    doc.heading("1. Короткий фінансовий підсумок", 1);
    const k = rep.kpisAll || rep.kpis[W[0]], kcards = [{ label: "Рахунків із даними", value: String(k.accounts), sub: "із " + A.accounts + " вибраних" }, { label: "Середня дохідність рахунків", value: k.meanPct === null ? "—" : pct(k.meanPct), color: k.meanPct === null ? null : tone(k.meanPct), sub: "просте середнє, не портфель" }, { label: "У плюсі / у мінусі / нульових", value: k.positive + " / " + k.negative + " / " + k.zero, sub: k.idle ? "без угод: " + k.idle : "" }, { label: "Макс. просідання серед рахунків", value: k.maxDd === null ? "—" : ddTxt(k.maxDd), sub: k.maxDdAcc ? k.maxDdAcc.title : "" }];
    doc.cards(kcards);
    doc.paragraph("Усі 48 рахунків (16 стратегій × 3 гаманці) — незалежні віртуальні рахунки зі своїми стартами й наборами монет. Вони не складаються в один портфель, суми USD різних гаманців не додаються.", 8, { color: "#5B6573" });
    doc.table([{ title: "Гаманець", w: 1.1, get: function (r) { return r.wallet; } }, { title: "Рахунків", w: 0.8, align: "right", get: function (r) { return r.accounts; } }, { title: "Сер. дохідність", w: 1.1, align: "right", get: function (r) { return pct(r.mean); }, color: function (r) { return r.mean === null ? null : tone(r.mean); } }, { title: "+ / − / 0", w: 1, align: "right", get: function (r) { return r.plus + " / " + r.minus + " / " + r.zero; } }, { title: "Найкращий активний", w: 2.4, get: function (r) { return r.best ? r.best + " (" + pct(r.bestPct) + ")" : null; } }, { title: "Найгірший активний", w: 2.4, get: function (r) { return r.worst ? r.worst + " (" + pct(r.worstPct) + ")" : null; } }, { title: "Макс. просідання", w: 1.1, align: "right", get: function (r) { return ddTxt(r.maxDd); } }], T.wallets.rows);
    await progress(0.2);
    // 3. рейтинг
    doc.heading("2. ТОП-3 та АНТИТОП-3 активних стратегій", 1);
    const groups = []; T.ranking.rows.forEach(function (r) { if (!groups.length || groups[groups.length - 1].g !== r.list) groups.push({ g: r.list, rows: [] }); groups[groups.length - 1].rows.push(r); });
    const rr = []; groups.forEach(function (g) { rr.push({ __group: g.g }); g.rows.forEach(function (r) { rr.push(r); }); });
    if (rr.length) doc.table([{ title: "Місце", w: 0.6, get: function (r) { return r.rank; } }, { title: "Стратегія", w: 3.6, get: function (r) { return r.title; } }, { title: "Дохідність", w: 1, align: "right", get: function (r) { return pct(r.pct); }, color: function (r) { return r.pct === null ? null : tone(r.pct); } }, { title: "Результат", w: 1, align: "right", get: function (r) { return r.usd === null ? "—" : usd(r.usd); }, color: function (r) { return r.usd === null ? null : tone(r.usd); } }, { title: "Угоди", w: 0.7, align: "right", get: function (r) { return r.trades; } }, { title: "Позначка", w: 1.4, get: function (r) { return r.sign; } }], rr);
    else doc.paragraph("Недостатньо активних стратегій для рейтингу (боти без угод у ТОП і АНТИТОП не входять).", 9);
    doc.paragraph(T.ranking.note, 7.5, { color: "#5B6573" });
    // 4. гаманці й рахунки
    doc.heading("3. Результати рахунків", 1);
    doc.table([{ title: "Стратегія", w: 3.2, get: function (r) { return r.title; } }, { title: "Гаманець", w: 1, get: function (r) { return r.wallet; } }, { title: "Результат", w: 1.1, align: "right", get: function (r) { return r.usd === null ? "—" : usd(r.usd); }, color: function (r) { return r.usd === null ? null : tone(r.usd); } }, { title: "Дохідність", w: 1, align: "right", get: function (r) { return r.pct === null ? "—" : pct(r.pct); }, color: function (r) { return r.pct === null ? null : tone(r.pct); } }, { title: "Угоди", w: 0.6, align: "right", get: function (r) { return r.trades; } }, { title: "Просід.", w: 0.85, align: "right", get: function (r) { return ddTxt(r.dd); } }, { title: "Win Rate", w: 0.8, align: "right", get: function (r) { return r.winRate === null ? "—" : fmtNum(r.winRate, 0) + "%"; } }, { title: "Реаліз. PnL", w: 1.1, align: "right", get: function (r) { return r.realized === null ? "—" : usd(r.realized); }, color: function (r) { return r.realized === null ? null : tone(r.realized); } }, { title: "Повнота", w: 1.55, get: function (r) { return String(r.status).replace("Повні дані · закритих угод немає", "Повні · закриттів немає").replace("Часткові дані", "Часткові").replace("Повні дані", "Повні"); } }], T.accounts.rows, { size: 7 });
    doc.paragraph(T.accounts.note, 7.5, { color: "#5B6573" });
    await progress(0.35);
    if (P.kind === "detailed") {
      doc.heading("4. Прибутки, збитки, просідання та комісії", 1);
      doc.table([{ title: "Стратегія", w: 3, get: function (r) { return r.title; } }, { title: "Гаманець", w: 0.95, get: function (r) { return r.wallet; } }, { title: "Просід.", w: 0.8, align: "right", get: function (r) { return ddTxt(r.dd); } }, { title: "Найгірша угода", w: 1.2, align: "right", get: function (r) { return r.worst === null ? "—" : usd(r.worst); } }, { title: "Збиткових / закриттів", w: 1.1, align: "right", get: function (r) { return r.closed === null ? "—" : r.losses + " / " + r.closed; } }, { title: "SL / TP / Trail", w: 1, align: "right", get: function (r) { return r.stops + " / " + r.takes + " / " + r.trails; } }, { title: "Комісії", w: 0.9, align: "right", get: function (r) { return r.fee === null ? "—" : fmtNum(r.fee, 2) + " $"; } }, { title: "Час у поз.", w: 0.8, align: "right", get: function (r) { return r.tim === null ? "—" : fmtNum(r.tim, 0) + "%"; } }, { title: "Вибірка", w: 1.1, get: function (r) { return /мала/.test(r.sample) ? "мала" : /немає/.test(r.sample) ? "немає закриттів" : "достатня"; } }], T.risks.rows, { size: 7 });
      doc.paragraph(T.risks.note, 7.5, { color: "#5B6573" });
      if (T.fees) { doc.heading("Комісії та торгові витрати", 2); doc.table([{ title: "Гаманець", w: 1, get: function (r) { return r.wallet; } }, { title: "Сума комісій і проковзання (відомі), $", w: 2, align: "right", get: function (r) { return r.fee === null ? "—" : fmtNum(r.fee, 2) + " $"; } }, { title: "Рахунків із даними про витрати", w: 1.4, align: "right", get: function (r) { return r.accounts; } }, { title: "Операцій без даних про витрати", w: 1.6, align: "right", get: function (r) { return r.missing; } }], T.fees.rows); doc.paragraph(T.fees.note, 7.5, { color: "#5B6573" }); }
      await progress(0.5);
      const charts = rep.charts.filter(function (c) { return c.ok; });
      doc.heading("5. Графіки дохідності (ТОП-3 та АНТИТОП-3 гаманця)", 1);
      if (!charts.length) doc.paragraph("Графіки не побудовано: недостатньо збережених точок (потрібно щонайменше 20 на рахунок).", 9); charts.forEach(function (c) { doc.chart("Гаманець " + ReportCoreCap(c.cap) + ": дохідність від початку періоду, %", c.series.map(function (s) { return { title: s.title.length > 42 ? s.title.slice(0, 41) + "…" : s.title, color: s.color, pts: s.pts }; })); });
      rep.charts.filter(function (c) { return !c.ok; }).forEach(function (c) { doc.paragraph("Гаманець " + ReportCoreCap(c.cap) + ": графік не побудовано — " + c.reason + ".", 8, { color: "#5B6573" }); });
      await progress(0.6);
      doc.heading("6. Історія торгових операцій", 1);
      doc.paragraph(T.ops.note, 8, { color: "#5B6573" });
      const rows = T.ops.rows;
      const oc = [{ title: "Час (UTC)", w: 1.05, get: function (r) { return dtTxt(r.t); } }, { title: "Стратегія", w: 2.7, get: function (r) { return r.title; } }, { title: "Гаманець", w: 0.9, get: function (r) { return r.wallet; } }, { title: "Монета", w: 0.65, get: function (r) { return r.coin; } }, { title: "Операція", w: 1, get: function (r) { return r.side; } }, { title: "Ціна", w: 0.9, align: "right", get: function (r) { return fmtNum(r.price, r.price >= 100 ? 2 : 4); } }, { title: "Результат", w: 1.1, align: "right", get: function (r) { return r.pnl === null ? "—" : usd(r.pnl); }, color: function (r) { return r.pnl === null ? null : tone(r.pnl); } }, { title: "Причина виходу", w: 1.3, get: function (r) { return r.exit; } }];
      const CH = 200; for (let i = 0; i < rows.length; i += CH) { if (i === 0) doc.table(oc, rows.slice(0, CH), { size: 6.8 }); else doc.table(oc, rows.slice(i, i + CH), { size: 6.8 }); await progress(0.6 + 0.2 * Math.min(1, i / rows.length)); await tick(); }
      if (!rows.length) doc.paragraph("Підтверджених операцій у вибраному періоді немає.", 9);
    }
    doc.heading((P.kind === "detailed" ? "7" : "4") + ". Пояснення обмежень даних", 1);
    T.limits.rows.forEach(function (r) { doc.paragraph((r.k === "Попередження" ? "▲ " : "• ") + r.v, 8, { indent: 6, after: 2, color: r.k === "Попередження" ? "#8A5A00" : "#1E2329" }); });
    if (P.kind === "detailed") { doc.heading("Джерела даних", 2); T.sources.rows.forEach(function (r) { doc.paragraph(r.k + ": " + r.v, 8, { indent: 6, after: 1 }); }); }
    // колонтитули
    const n = doc.pages.length;
    doc.pages.forEach(function (p, i) { doc.cur = p; doc.line(36, p.h - 30, p.w - 36, p.h - 30, "#D0D5DB", 0.5); doc.text(36, p.h - 18, "Crypto Prosto · Analytics Pro · симуляція на віртуальних грошах, не фінансова порада", 7, { color: "#5B6573" }); doc.text(p.w - 36, p.h - 18, "Сторінка " + (i + 1) + " з " + n, 7, { color: "#5B6573", align: "right" }); if (i > 0) { doc.text(36, 26, "Аналітичний звіт · " + (rep.period.key === "all" ? "поточний раунд" : rep.period.label) + " · " + rep.filtersText.slice(0, 80), 7, { color: "#5B6573" }); doc.line(36, 32, p.w - 36, 32, "#F0B90B", 0.8); } });
    await progress(0.8); const out = await finish(doc, progress); await progress(1); return out;
  }
  function ReportCoreFmt(t) { return root.ReportCore ? root.ReportCore.fmtDate(t) : String(t); }
  function ReportCoreCap(c) { return c.toLocaleString("uk-UA").replace(/ | /g, " ") + " $"; }

  root.ReportPdf = { generate: generate, parseTTF: parseTTF, subsetTTF: subsetTTF, gidOf: gidOf, Face: Face, PdfDoc: PdfDoc };
})(typeof window !== "undefined" ? window : this);
