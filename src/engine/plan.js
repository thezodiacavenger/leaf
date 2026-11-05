// The "brain": looks at a drop and proposes one obvious action plus quieter alternatives.
// The panel shows the first four alternatives; the rest sit behind "More". Never ask what we can infer.
const { NATIVE_DECODE } = require('./sources');
const { BRANDS } = require('./raw');

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const OFFICE = ['doc', 'sheet', 'slides'];

function summarize(sources) {
  const all = sources.flatMap((s) => s.items);
  const c = { heic: 0, raw: 0, tiff: 0, raster: 0, doc: 0, sheet: 0, slides: 0, csv: 0, text: 0, email: 0, tnef: 0, pdf: 0, archive: 0, other: 0, decodable: 0 };
  for (const it of all) { c[it.kind] = (c[it.kind] || 0) + 1; if (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)) c.decodable++; }
  return { all, c, bytes: all.reduce((a, it) => a + (it.size || 0), 0) };
}

function rawBrands(all) {
  const seen = [...new Set(all.filter((i) => i.kind === 'raw').map((i) => i.ext))];
  const names = seen.map((e) => (BRANDS[e] === 'DNG' ? 'DNG' : `${BRANDS[e]} ${e.slice(1).toUpperCase()}`));
  return names.length > 3 ? `${names.slice(0, 3).join(' · ')} +${names.length - 3}` : names.join(' · ');
}

const A = {
  zip: { id: 'zip', label: 'Make a zip', hint: 'One file, easy to send' },
  info: { id: 'exif', label: 'Photo info', hint: 'Camera, lens, settings, date, location' },
  report: { id: 'photo-report', label: 'Photo report PDF', hint: 'Captioned with date taken & GPS — for claims, damage, RMAs' },
  ocr: { id: 'ocr', label: 'Make searchable PDF', hint: 'Reads the text so you can search & copy it (Windows OCR)' },
  combine: { id: 'combine', label: 'Combine into one PDF', hint: 'In name order · forms flattened · a bookmark per file' },
  clean: { id: 'clean', label: 'Remove hidden data', hint: 'Author, company, comments, GPS, edit history' },
};

function propose(sources, { platform = process.platform } = {}) {
  const { all, c, bytes } = summarize(sources);
  const win = platform === 'win32';
  const zips = sources.filter((s) => s.type === 'zip');
  const loose = sources.some((s) => s.type !== 'zip');
  const several = all.length > 1 || sources.some((s) => s.type === 'folder');
  const where = sources.length === 1 ? sources[0].label : plural(sources.length, 'item');
  const photos = c.heic + c.raw + c.tiff + c.decodable;
  const officeN = c.doc + c.sheet + c.slides;
  const docish = c.pdf + c.email + officeN; // real documents (a stray notes.txt doesn't make a zip of photos a "package")
  const kinds = Object.entries(c).filter(([k, n]) => n && k !== 'decodable' && k !== 'other' && k !== 'archive').length;
  const actions = [];
  let title; let icon = 'file'; let detail = '';
  const zipIt = () => loose && several && A.zip;
  const off = (a) => (win ? a : { ...a, disabled: true, hint: 'Needs Windows with Microsoft Office' });

  // ---- a mix of documents (or several PDFs): the "submission package"
  // Mostly photos with a document or two (e.g. 40 site photos + a claim form) is still a photo job; Combine stays an alternative.
  const photoJob = photos > docish * 3;
  if (!photoJob && ((docish >= 2 && (kinds > 1 || c.pdf >= 2)) || (docish >= 1 && photos >= 1))) {
    icon = 'stack';
    title = plural(all.length, 'file');
    detail = [c.pdf && plural(c.pdf, 'PDF'), c.email && plural(c.email, 'email'), officeN && plural(officeN, 'Office file'), photos && plural(photos, 'photo')].filter(Boolean).join(' · ');
    actions.push(A.combine);
    if (c.pdf >= 2 && kinds === 1) actions.push({ id: 'pdf-compress', label: 'Compress each', hint: 'Under 9 MB for email & carrier portals' });
    actions.push(zipIt());
  } else if (c.email) {
    // ---- Outlook / .eml emails
    icon = 'mail';
    title = c.email === 1 ? (all.find((i) => i.kind === 'email').name.replace(/\.(msg|eml)$/i, '')) : plural(c.email, 'email');
    if (c.email === 1) {
      actions.push({ id: 'mail-pdf', label: 'Save as PDF', hint: 'Email + attachments in one PDF, for the client file' });
      actions.push({ id: 'mail-attach', label: 'Extract attachments', hint: 'Into a folder next to it' });
    } else {
      actions.push({ id: 'mail-onepdf', label: 'One PDF of all emails', hint: 'Oldest first, attachments included, bookmarked' });
      actions.push({ id: 'mail-pdf', label: 'Save each as PDF' });
      actions.push({ id: 'mail-attach', label: 'Extract attachments' });
    }
    actions.push(zipIt());
  } else if (c.tnef) {
    icon = 'mail'; title = 'winmail.dat'; detail = 'Outlook attachments packed for non-Outlook mail';
    actions.push({ id: 'mail-attach', label: 'Extract attachments', hint: 'Unpacks the real files' });
  } else if (c.pdf && !(photos && photoJob)) {
    // ---- PDFs
    icon = 'doc';
    const pdfs = all.filter((i) => i.kind === 'pdf'); const f = pdfs.length === 1 ? pdfs[0].facts || {} : {};
    title = pdfs.length === 1 ? pdfs[0].name : plural(pdfs.length, 'PDF');
    if (f.pages) detail = plural(f.pages, 'page');
    const tools = {
      compress: { id: 'pdf-compress', label: 'Compress for email', hint: 'Under 9 MB — fits Outlook and carrier portals. Text stays sharp.' },
      ocr: A.ocr, flatten: { id: 'pdf-flatten', label: 'Flatten form', hint: 'Locks the filled-in fields so they print & combine reliably' },
      protect: { id: 'pdf-protect', label: 'Protect with password', ask: { kind: 'password', label: 'Password for this PDF', go: 'Protect' } },
      unlock: { id: 'pdf-unlock', label: 'Remove password', ...(f.needsPassword ? { ask: { kind: 'password', label: 'Current password', go: 'Unlock' } } : { hint: 'Removes printing/copying restrictions' }) },
      extract: { id: 'pdf-extract', label: 'Extract pages…', ask: { kind: 'pages', label: `Pages to keep${f.pages ? ` (1–${f.pages})` : ''}`, placeholder: 'e.g. 1-3, 7', go: 'Extract' } },
      split: { id: 'pdf-split', label: 'Split into pages' },
      rotate: { id: 'pdf-rotate', label: 'Rotate 90°' },
      word: off({ id: 'pdf-word', label: 'Make editable (Word)', hint: 'Opens the PDF in Word and saves a .docx' }),
      clean: A.clean,
    };
    const order = f.needsPassword ? ['unlock']
      : f.scanned ? ['ocr', 'compress', 'extract', 'rotate', 'split', 'protect', 'clean']
      : f.hasForm ? ['flatten', 'compress', 'protect', 'extract', 'split', 'word', 'clean']
      : f.encrypted ? ['unlock', 'compress', 'extract', 'split', 'word']
      : ['compress', 'protect', 'extract', 'split', 'word', 'rotate', 'ocr', 'clean'];
    if (pdfs.length > 1) actions.push(...['compress', 'flatten', 'protect', 'rotate', 'clean'].map((k) => tools[k]));
    else actions.push(...order.map((k) => tools[k]));
    if (f.needsPassword) detail = 'Password-protected';
    actions.push(zipIt());
  } else if (c.raw) {
    icon = 'camera';
    const others = c.heic + c.tiff + c.decodable;
    title = others ? `${c.raw} RAW + ${plural(others, 'photo')}` : plural(c.raw, 'RAW photo');
    detail = rawBrands(all);
    actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Full resolution. Keeps camera, lens & date.' });
    actions.push({ id: 'convert', target: 'png', label: 'PNG', hint: 'Lossless, larger files' }, A.info, docish && A.combine, zipIt(), photos > 1 && A.report, photos > 1 && { id: 'pdf', label: 'One PDF' });
  } else if (c.heic) {
    icon = 'photo'; title = plural(c.heic, 'HEIC photo');
    actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Opens anywhere. Originals untouched.' });
    actions.push({ id: 'convert', target: 'png', label: 'PNG', hint: 'Lossless, larger files' });
    actions.push(docish && A.combine, photos > 1 ? A.report : A.info, photos > 1 ? { id: 'pdf', label: 'One PDF', hint: 'All photos, one file' } : null, zipIt(), photos > 1 && A.info, A.clean);
  } else if (c.tiff && all.some((i) => i.kind === 'tiff' && i.pages > 1)) {
    icon = 'doc'; title = c.tiff === 1 ? all.find((i) => i.kind === 'tiff').name : plural(c.tiff, 'TIFF');
    const pages = all.reduce((a, i) => a + (i.pages || 0), 0); detail = `${pages} pages — looks like a fax or scan`;
    actions.push({ id: 'tiff-pdf', label: 'Make PDF', hint: 'Every page, correct size' }, A.ocr, { id: 'convert', target: 'jpeg', label: 'JPEG (first page)' });
  } else if (photos) {
    icon = 'photo';
    title = plural(photos, c.tiff && !c.decodable ? 'TIFF image' : 'image');
    if (c.tiff) actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Much smaller, opens anywhere' });
    actions.push({ id: 'shrink', label: 'Shrink for email', hint: '2048px, ~5× smaller, location removed' });
    if (docish) actions.push(A.combine);
    if (photos > 1) actions.push(A.report);
    const allJpeg = all.filter((i) => i.kind === 'raster').every((i) => /\.jpe?g$/.test(i.ext));
    if (!c.tiff) actions.push(allJpeg ? { id: 'convert', target: 'png', label: 'PNG' } : { id: 'convert', target: 'jpeg', label: 'JPEG' });
    actions.push({ id: 'pdf', label: photos > 1 ? 'One PDF' : 'PDF' }, A.info, zipIt(), A.ocr, A.clean);
  } else if (c.sheet) {
    icon = 'sheet'; title = c.sheet === 1 ? all.find((i) => i.kind === 'sheet').name : plural(c.sheet, 'workbook');
    actions.push(off({ id: 'office-pdf', label: 'Save as PDF', hint: 'Fitted to page width — no more 40-page printouts' }), off({ id: 'xls-csv', label: 'Each sheet to CSV', hint: 'UTF-8, one file per sheet' }), off({ id: 'office-email', label: 'Email as PDF' }), off(A.clean), zipIt());
  } else if (c.csv) {
    icon = 'sheet'; title = c.csv === 1 ? all.find((i) => i.kind === 'csv').name : plural(c.csv, 'CSV file');
    actions.push({ id: 'csv-xlsx', label: 'Open safely as Excel', hint: 'Leading zeros, long IDs & dates kept exactly as written', open: true }, { id: 'csv-clean', label: 'Clean up CSV', hint: 'Trim spaces, drop blank rows, UTF-8' }, zipIt());
  } else if (c.slides) {
    icon = 'slides'; title = c.slides === 1 ? all.find((i) => i.kind === 'slides').name : plural(c.slides, 'presentation');
    actions.push(off({ id: 'office-pdf', label: 'Save as PDF' }), off({ id: 'office-email', label: 'Email as PDF' }), off(A.clean), zipIt());
  } else if (c.doc) {
    icon = 'doc';
    const docs = all.filter((i) => i.kind === 'doc');
    title = docs.length === 1 ? docs[0].name : plural(docs.length, 'document');
    actions.push(off({ id: 'office-pdf', label: 'Save as PDF', hint: 'Uses Word, keeps layout' }));
    if (docs.length === 1) actions.push(off({ id: 'doc-mail', label: 'Write as email', hint: 'Body pasted into Outlook, formatting kept' }));
    actions.push(off({ id: 'office-email', label: 'Email as PDF' }), off(A.clean), zipIt());
  }

  if (zips.length) {
    actions.push({ id: 'unzip', label: actions.filter(Boolean).length ? 'Just unzip' : 'Unzip', hint: 'Everything, into a folder' });
    if (!title) { icon = 'archive'; title = plural(all.length, 'file'); }
  }
  if (!actions.filter(Boolean).length && loose) {
    const folder = sources.length === 1 && sources[0].type === 'folder';
    icon = folder ? 'archive' : 'file'; title = title || (folder ? sources[0].label : plural(all.length, 'file'));
    actions.push({ id: 'zip', label: folder ? 'Zip this folder' : 'Make a zip', hint: 'One file, easy to send' });
  }

  const list = actions.filter(Boolean).filter((a, i, arr) => arr.findIndex((b) => b.id === a.id && b.target === a.target) === i);
  if (!list.length) list.push({ id: 'reveal', label: 'Nothing to convert yet', hint: 'Leaf learns new formats over time', disabled: true });
  // Keep the primary usable: if the best idea needs Office and there is none, promote the next one.
  if (list[0].disabled) { const k = list.findIndex((a) => !a.disabled); if (k > 0) list.unshift(...list.splice(k, 1)); }

  const parts = [where];
  if (detail) parts.push(detail);
  if (bytes) parts.push(mb(bytes));
  const extra = all.length - photos;
  if (extra > 0 && photos && list[0].id === 'convert') parts.push(`${plural(extra, 'other file')} kept as-is`);
  return { icon, title: title || plural(all.length, 'file'), subtitle: parts.join(' · '), actions: list, counts: c, total: all.length };
}

module.exports = { propose, mb, plural };
