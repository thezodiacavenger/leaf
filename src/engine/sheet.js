// CSV -> XLSX without Excel's guessing (leading zeros, long IDs and dates stay exactly as written),
// and CSV clean-up. Tiny dependency-free XLSX writer (an .xlsx is a zip of XML parts).
const fs = require('node:fs');

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

function sniffDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const score = (d) => head.split('\n').map((l) => l.split(d).length - 1);
  return [',', ';', '\t', '|'].map((d) => ({ d, s: score(d) })).filter((x) => x.s[0] > 0 && x.s.every((n) => n === x.s[0])).sort((a, b) => b.s[0] - a.s[0])[0]?.d
    || [',', ';', '\t'].sort((a, b) => head.split(b).length - head.split(a).length)[0];
}

function parseCsv(text, delim = sniffDelimiter(text)) {
  const rows = []; let row = []; let cell = ''; let i = 0; let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += c === '\r' && text[i + 1] === '\n' ? 2 : 1; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return { rows, delim };
}

const NUM = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;
// A column is numeric only if every value is a plain number Excel can hold exactly. Anything else stays text.
function columnTypes(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  return Array.from({ length: width }, (_, c) => {
    const vals = rows.slice(1).map((r) => (r[c] ?? '').trim()).filter(Boolean);
    return vals.length && vals.every((v) => NUM.test(v)) ? 'n' : 's';
  });
}

const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function sheetXml(rows, types) {
  const widths = types.map((_, c) => Math.min(60, Math.max(8, ...rows.slice(0, 500).map((r) => String(r[c] ?? '').length + 2))));
  const last = `${colName(Math.max(0, types.length - 1))}${Math.max(1, rows.length)}`;
  const body = rows.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => {
    const ref = `${colName(x)}${y + 1}`; const t = (v ?? '').trim();
    if (t === '') return '';
    if (y > 0 && types[x] === 'n') return `<c r="${ref}"><v>${t.trim()}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${y === 0 ? 2 : 1}"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1" style="${types[i] === 's' ? 1 : 0}"/>`).join('')}</cols>
<sheetData>${body}</sheetData>${rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
}

async function writeXlsx(dest, rows, sheetName = 'Sheet1') {
  const yazl = require('yazl');
  const types = columnTypes(rows); const name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>${rows.length > 1 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(Math.max(0, types.length - 1))}$${rows.length}</definedName></definedNames>` : ''}</workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml': sheetXml(rows, types),
  };
  const z = new yazl.ZipFile(); for (const [n, s] of Object.entries(parts)) z.addBuffer(Buffer.from(s, 'utf8'), n);
  z.end();
  await new Promise((res, rej) => z.outputStream.pipe(fs.createWriteStream(dest)).on('close', res).on('error', rej));
  return { rows: rows.length, cols: types.length, textCols: types.filter((t) => t === 's').length };
}

async function csvToXlsx(src, dest, sheetName) {
  const { rows } = parseCsv(decodeText(fs.readFileSync(src)));
  return writeXlsx(dest, rows.filter((r) => r.some((c) => c.trim() !== '')), sheetName);
}

// Trim cells, drop blank rows, consistent quoting, UTF-8 with BOM (Excel reads accents correctly).
function cleanCsv(src, dest) {
  const { rows, delim } = parseCsv(decodeText(fs.readFileSync(src)));
  const kept = rows.map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim())).filter((r) => r.some((c) => c !== ''));
  const width = Math.max(...kept.map((r) => r.length));
  const esc = (c) => (/[",\r\n;\t]/.test(c) || c.includes(delim) ? `"${c.replace(/"/g, '""')}"` : c);
  fs.writeFileSync(dest, '﻿' + kept.map((r) => Array.from({ length: width }, (_, i) => esc(r[i] ?? '')).join(delim)).join('\r\n') + '\r\n', 'utf8');
  return { before: rows.length, after: kept.length };
}

module.exports = { parseCsv, csvToXlsx, cleanCsv, decodeText };
