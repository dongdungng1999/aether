/**
 * OfficePreview — fast, local-only renderer for .docx / .xlsx / .pptx
 * preview. NO network calls, NO MinerU.
 *
 * Why this exists:
 *   In 0.4.13 the "👁 Preview" button on a docx/xlsx card called the
 *   AttachmentParser → MinerU MCP → proxy `/mcp/mineru/mcp`. That route
 *   hit "All connection attempts failed" whenever the proxy MCP wasn't
 *   reachable, AND was the wrong layer regardless: MinerU is for
 *   model-input extraction (OCR + layout), not cosmetic rendering. The
 *   user just wants to see the content quickly.
 *
 *   This module unzips the OOXML container in-process (Node has zlib
 *   built-in; OOXML uses store/deflate so we don't need a third-party
 *   library) and pulls the visible text out of the relevant XML parts.
 *
 *   Quality of output is intentionally "good enough for a glance":
 *   paragraphs and headings for docx, a flat HTML table per sheet for
 *   xlsx, a bulleted list for pptx. If the user wants pixel-perfect
 *   rendering they can still Download and open in Word/Excel/PowerPoint.
 *
 *   Latency goal: < 100 ms on a typical hello-world.docx. Verified by
 *   the unit test in tests/unit/officePreview.test.ts.
 */

import * as fs from 'fs/promises';
import * as zlib from 'zlib';

/** Public result. `kind` matches what the webview's artifact panel
 *  already understands: 'docx-html' / 'xlsx-html'. */
export interface OfficeRender {
  kind:  'docx-html' | 'xlsx-html' | 'pptx-html';
  /** Body HTML (no <html>/<body>/<head>). The webview wraps it in its
   *  own chrome iframe with site-specific CSS. */
  html:  string;
  /** Filename echoed back so the webview can show it as a title. */
  source: string;
}

/* ─── small ZIP reader (Store + Deflate only, that's all OOXML uses) ─── */

interface ZipEntry { name: string; bytes: Buffer; }

/** Parse a ZIP from a Buffer using the End-of-Central-Directory record.
 *  Handles only what OOXML needs: method 0 (store) and method 8 (deflate),
 *  no ZIP64, no encryption, no spanning. Returns a name → bytes map. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Find EOCD: signature 0x06054b50, scan back from the end (max 64 KB
  // comment).
  const minStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const cdSize   = buf.readUInt32LE(eocd + 12);
  const cdOff    = buf.readUInt32LE(eocd + 16);
  const total    = buf.readUInt16LE(eocd + 10);
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method  = buf.readUInt16LE(p + 10);
    const compLen = buf.readUInt32LE(p + 20);
    const uncLen  = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraL  = buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const lhOff   = buf.readUInt32LE(p + 42);
    const name    = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraL + cmtLen;

    // Local header → data offset.
    if (buf.readUInt32LE(lhOff) !== 0x04034b50) continue;
    const lhNameLen  = buf.readUInt16LE(lhOff + 26);
    const lhExtraLen = buf.readUInt16LE(lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    const compData  = buf.slice(dataStart, dataStart + compLen);

    let bytes: Buffer;
    if (method === 0)        bytes = compData;
    else if (method === 8)   bytes = zlib.inflateRawSync(compData);
    else throw new Error(`zip method ${method} not supported (need store or deflate)`);
    if (bytes.length !== uncLen && method !== 0) {
      // Some writers report 0xFFFFFFFF and use data descriptors; we trust
      // the inflate output in that case.
    }
    out.set(name, bytes);
    void cdSize; void uncLen;
  }
  return out;
}

/* ─── XML helpers (regex-based, intentionally minimal) ─── */

function stripTags(xml: string): string {
  return xml.replace(/<[^>]+>/g, '');
}
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Extract every <w:t> text run, in document order, grouped by <w:p>. */
function readDocxParagraphs(documentXml: string): { style: string; text: string }[] {
  const paras: { style: string; text: string }[] = [];
  // <w:p> ... </w:p> (greedy — w:p never nest).
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(documentXml)) !== null) {
    const inner = m[1];
    // Detect heading style — pStyle val="Heading1" / "Title" / etc.
    const styleM = /<w:pStyle\s+w:val="([^"]+)"/.exec(inner);
    const style  = styleM ? styleM[1] : '';
    // Concatenate every <w:t>...</w:t> (and <w:tab/>, <w:br/>).
    let text = '';
    const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^/]*\/>|<w:br\b[^/]*\/>/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(inner)) !== null) {
      if (pm[1] !== undefined) text += decodeEntities(pm[1]);
      else if (pm[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    paras.push({ style, text });
  }
  return paras;
}

function paraToHtml(p: { style: string; text: string }): string {
  const t = escapeHtml(p.text).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
  if (!t.trim()) return '<p>&nbsp;</p>';
  const s = p.style.toLowerCase();
  if (s === 'title')                 return `<h1 class="docx-title">${t}</h1>`;
  if (s === 'subtitle')              return `<p class="docx-subtitle">${t}</p>`;
  if (/^heading\s*1$|^heading1$/.test(s)) return `<h1>${t}</h1>`;
  if (/^heading\s*2$|^heading2$/.test(s)) return `<h2>${t}</h2>`;
  if (/^heading\s*3$|^heading3$/.test(s)) return `<h3>${t}</h3>`;
  if (/^heading\s*4$|^heading4$/.test(s)) return `<h4>${t}</h4>`;
  if (/listparagraph|listbullet/.test(s)) return `<li>${t}</li>`;
  if (/^quote/.test(s))              return `<blockquote>${t}</blockquote>`;
  return `<p>${t}</p>`;
}

/** Render a docx Buffer to HTML body. */
export function renderDocx(buf: Buffer): string {
  const zip = readZip(buf);
  const documentXml = zip.get('word/document.xml');
  if (!documentXml) {
    // Some writers nest under a different path; fall back to first
    // document*.xml found.
    for (const [k, v] of zip.entries()) {
      if (/^word\/document\d*\.xml$/i.test(k)) {
        return renderDocxXml(v.toString('utf8'));
      }
    }
    throw new Error('docx has no word/document.xml');
  }
  return renderDocxXml(documentXml.toString('utf8'));
}

function renderDocxXml(xml: string): string {
  const paras = readDocxParagraphs(xml);
  if (!paras.length) return `<p class="docx-empty">(empty document)</p>`;
  // Collapse consecutive <li> into a <ul>.
  const out: string[] = [];
  let inList = false;
  for (const p of paras) {
    const html = paraToHtml(p);
    if (html.startsWith('<li>')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(html);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(html);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/* ─── XLSX ─────────────────────────────────────────────────────────── */

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    // Concatenate every <t> inside (rich-text strings have multiple <r><t>).
    let s = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) s += decodeEntities(tm[1]);
    out.push(s);
  }
  return out;
}

interface XlsxCell { ref: string; col: number; row: number; value: string; }

function colLetterToNumber(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

function readSheetCells(sheetXml: string, sst: string[]): XlsxCell[] {
  const out: XlsxCell[] = [];
  const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = cRe.exec(sheetXml)) !== null) {
    const attrs = m[1] ?? m[3] ?? '';
    const inner = m[2] ?? '';
    const refM  = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!refM) continue;
    const tM = /\bt="([^"]+)"/.exec(attrs);
    const type = tM ? tM[1] : 'n';
    let valM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
    let value = '';
    if (valM) {
      value = decodeEntities(valM[1]);
      if (type === 's') {
        const idx = parseInt(value, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < sst.length) value = sst[idx];
      } else if (type === 'b') {
        value = value === '1' ? 'TRUE' : 'FALSE';
      }
    } else if (type === 'inlineStr' || type === 'str') {
      const isM = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
      if (isM) {
        let s = '';
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(isM[1])) !== null) s += decodeEntities(tm[1]);
        value = s;
      }
    }
    out.push({
      ref:   refM[1] + refM[2],
      col:   colLetterToNumber(refM[1]),
      row:   parseInt(refM[2], 10),
      value,
    });
  }
  return out;
}

function cellsToHtmlTable(cells: XlsxCell[], sheetName: string): string {
  if (!cells.length) return `<h2>${escapeHtml(sheetName)}</h2><p class="xlsx-empty">(empty sheet)</p>`;
  let maxRow = 0, maxCol = 0;
  for (const c of cells) { if (c.row > maxRow) maxRow = c.row; if (c.col > maxCol) maxCol = c.col; }
  // Cap the rendered grid so a stray million-row sheet doesn't lock up.
  const capRow = Math.min(maxRow, 200);
  const capCol = Math.min(maxCol, 50);
  const grid: string[][] = Array.from({ length: capRow }, () => Array<string>(capCol).fill(''));
  for (const c of cells) {
    if (c.row <= capRow && c.col <= capCol) grid[c.row - 1][c.col - 1] = c.value;
  }
  const out: string[] = [`<h2>${escapeHtml(sheetName)}</h2>`, '<table>'];
  // First row → <thead>; rest → <tbody>.
  out.push('<thead><tr>');
  for (let c = 0; c < capCol; c++) out.push(`<th>${escapeHtml(grid[0][c])}</th>`);
  out.push('</tr></thead>');
  out.push('<tbody>');
  for (let r = 1; r < capRow; r++) {
    out.push('<tr>');
    for (let c = 0; c < capCol; c++) out.push(`<td>${escapeHtml(grid[r][c])}</td>`);
    out.push('</tr>');
  }
  out.push('</tbody></table>');
  if (maxRow > capRow || maxCol > capCol) {
    out.push(`<p class="xlsx-truncated muted">(truncated to ${capRow}×${capCol}; full sheet is ${maxRow}×${maxCol})</p>`);
  }
  return out.join('\n');
}

export function renderXlsx(buf: Buffer): string {
  const zip = readZip(buf);
  const wbXml   = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const sstXml  = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  const sst     = readSharedStrings(sstXml);

  // Map sheetId/r:id → name from workbook.xml.
  // <sheet name="..." sheetId="N" r:id="rIdX"/>
  const sheetMeta: { name: string; rid: string }[] = [];
  // Self-closing or with content. Attribute values may contain slashes
  // (xmlns URLs), so use a non-greedy body match.
  const sRe = /<sheet\s+([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = sRe.exec(wbXml)) !== null) {
    const a = m[1];
    const nM = /name="([^"]+)"/.exec(a);
    const rM = /r:id="([^"]+)"/.exec(a);
    if (nM && rM) sheetMeta.push({ name: nM[1], rid: rM[1] });
  }
  // workbook.xml.rels → sheet rid → file path.
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const ridToPath = new Map<string, string>();
  const rRe = /<Relationship\s+([^>]*?)\/?>/g;
  while ((m = rRe.exec(relsXml)) !== null) {
    const a = m[1];
    const idM = /Id="([^"]+)"/.exec(a);
    const tgM = /Target="([^"]+)"/.exec(a);
    if (idM && tgM) ridToPath.set(idM[1], tgM[1]);
  }
  const out: string[] = [];
  for (const meta of sheetMeta) {
    const rel = ridToPath.get(meta.rid) || '';
    // Targets are relative to xl/. Normalize.
    const fullPath = rel.startsWith('/') ? rel.slice(1) : 'xl/' + rel;
    const sheetXml = zip.get(fullPath)?.toString('utf8');
    if (!sheetXml) continue;
    const cells = readSheetCells(sheetXml, sst);
    out.push(cellsToHtmlTable(cells, meta.name));
  }
  if (!out.length) return `<p class="xlsx-empty">(no sheets)</p>`;
  return out.join('\n');
}

/* ─── PPTX (very minimal — title + bullets per slide) ─────────────── */

export function renderPptx(buf: Buffer): string {
  const zip = readZip(buf);
  const slides: string[] = [];
  for (const [k, v] of zip.entries()) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(k)) continue;
    const xml = v.toString('utf8');
    // Strip everything but <a:t>text</a:t> runs grouped by <a:p>.
    const slideOut: string[] = [];
    const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(xml)) !== null) {
      const inner = pm[1];
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let s = '';
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(inner)) !== null) s += decodeEntities(tm[1]);
      if (s.trim()) slideOut.push(s);
    }
    if (slideOut.length) {
      const idx = parseInt(k.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
      const [title, ...rest] = slideOut;
      slides.push(`<section class="pptx-slide"><h2>Slide ${idx}: ${escapeHtml(title)}</h2>` +
        (rest.length ? `<ul>${rest.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '') +
        `</section>`);
    }
  }
  // Sort by slide index (filenames give us 1,10,11,2 — fix).
  slides.sort((a, b) => {
    const ai = parseInt((a.match(/Slide (\d+):/) || [, '0'])[1], 10);
    const bi = parseInt((b.match(/Slide (\d+):/) || [, '0'])[1], 10);
    return ai - bi;
  });
  if (!slides.length) return `<p class="pptx-empty">(no slides found)</p>`;
  return slides.join('\n');
}

/* ─── Public dispatch ─────────────────────────────────────────────── */

export async function renderOfficeFile(filePath: string): Promise<OfficeRender> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.doc') || lower.endsWith('.xls') || lower.endsWith('.ppt')) {
    throw new Error('Legacy binary Office files (.doc/.xls/.ppt) are not supported for inline preview. Use Download to open this file in Word, Excel, or PowerPoint.');
  }
  const buf = await fs.readFile(filePath);
  if (lower.endsWith('.docx')) {
    return { kind: 'docx-html', html: renderDocx(buf), source: filePath };
  }
  if (lower.endsWith('.xlsx')) {
    return { kind: 'xlsx-html', html: renderXlsx(buf), source: filePath };
  }
  if (lower.endsWith('.pptx')) {
    return { kind: 'pptx-html', html: renderPptx(buf), source: filePath };
  }
  throw new Error(`OfficePreview: unsupported extension on ${filePath}`);
}
