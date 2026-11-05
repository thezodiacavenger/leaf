// Document actions: email -> PDF, attachments, combine into one PDF, PDF toolkit, Office -> PDF/CSV,
// CSV -> Excel, remove hidden data, photo report, searchable PDF (OCR), fax TIFF -> PDF.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mail = require('./mail');
const pdf = require('./pdf');
const office = require('./office');
const sheet = require('./sheet');
const raw = require('./raw');
const { htmlToPdf, textToPdf } = require('./render');

const OFFICE = new Set(['doc', 'sheet', 'slides']);
const isPhotoKind = (k) => ['heic', 'raw', 'tiff', 'raster'].includes(k);
const base = (p) => path.parse(p).name;
const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const ext = (n) => path.extname(n).toLowerCase();
const kindFromName = (n) => require('./sources').kindOf(ext(n), n);

let tmpSeq = 0;
async function tmpFile(name) {
  const dir = path.join(os.tmpdir(), 'leaf-src'); await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, `${Date.now().toString(36)}-${++tmpSeq}-${name.replace(/[\\/:*?"<>|]/g, '_')}`);
}

// Office files (any number) -> PDFs in one Office session. Returns Map(srcPath -> {bytes}|{err}).
async function officeToPdfs(srcs) {
  const out = new Map(); if (!srcs.length) return out;
  const jobs = await Promise.all(srcs.map(async (src) => ({ op: 'pdf', src, dest: await tmpFile(`${base(src)}.pdf`) })));
  const res = await office.runJobs(jobs);
  for (let i = 0; i < jobs.length; i++) {
    if (res[i].ok && fs.existsSync(jobs[i].dest)) { out.set(srcs[i], { bytes: await fsp.readFile(jobs[i].dest) }); fs.rm(jobs[i].dest, { force: true }, () => {}); }
    else out.set(srcs[i], { err: res[i].err || 'Office couldn’t convert it' });
  }
  return out;
}

// ---------- email -> one PDF (message first, then each attachment as pages) ----------
const SIGNATURE_IMG = /^image\d{3}\.(png|jpe?g|gif)$/i;
async function mailToPdf(m, h, depth = 0) {
  const parts = [{ bytes: await htmlToPdf(mail.toHtml(m), { footer: m.subject }), title: m.subject || 'Email' }];
  const skipped = [];
  const atts = m.attachments.filter((a) => !a.inline && !(a.hidden && a.cid) && !(SIGNATURE_IMG.test(a.name) && a.size < 60000));
  const officeAtts = [];
  for (const a of atts) if (a.data && OFFICE.has(kindFromName(a.name))) { a.tmp = await tmpFile(a.name); await fsp.writeFile(a.tmp, a.data); officeAtts.push(a.tmp); }
  const converted = await officeToPdfs(officeAtts);
  for (const a of atts) {
    try {
      const k = a.mail ? 'email' : kindFromName(a.name);
      if (a.mail && depth < 2) parts.push(...(await mailToPdf(a.mail, h, depth + 1)).parts.map((p, i) => (i ? p : { ...p, title: `Attached email: ${p.title}` })));
      else if (k === 'pdf') { await pdf.open(a.data); parts.push({ bytes: a.data, title: a.name }); }
      else if (isPhotoKind(k)) { const { img } = await h.toImage({ name: a.name, ext: ext(a.name), kind: k, read: async () => a.data }); parts.push({ bytes: await pdf.imagesToPdf([{ img }]), title: a.name }); }
      else if (OFFICE.has(k)) { const r = converted.get(a.tmp); if (r.bytes) parts.push({ bytes: r.bytes, title: a.name }); else skipped.push(`${a.name} (${r.err})`); }
      else if (k === 'text' || /\.(txt|csv|log)$/i.test(a.name)) parts.push({ bytes: await textToPdf(sheet.decodeText(a.data), a.name), title: a.name });
      else skipped.push(a.name);
    } catch (e) { skipped.push(`${a.name} (${e.message})`); }
    if (a.tmp) fs.rm(a.tmp, { force: true }, () => {});
  }
  return { parts, skipped };
}

async function readMail(it) { return mail.parseMail(await it.read(), it.ext); }

// ---------- what goes into "Combine into one PDF" ----------
const combinable = (it) => it.kind === 'pdf' || it.kind === 'email' || it.kind === 'text' || OFFICE.has(it.kind) || isPhotoKind(it.kind);
async function partsFor(items, h, ctx) {
  const officeSrcs = [];
  for (const it of items) if (OFFICE.has(it.kind)) officeSrcs.push(await raw.onDisk(it));
  const converted = await officeToPdfs(officeSrcs);
  const parts = new Array(items.length);
  await h.each(items, 3, ctx, async (it, n) => {
    if (it.kind === 'pdf') { const b = await it.read(); await pdf.open(b); parts[n] = [{ bytes: b, title: base(it.name) }]; }
    else if (it.kind === 'email') { const m = await readMail(it); const r = await mailToPdf(m, h); parts[n] = r.parts.map((p, i) => (i ? p : { ...p, title: m.subject || base(it.name) })); }
    else if (OFFICE.has(it.kind)) { const r = converted.get(await raw.onDisk(it)); if (!r.bytes) throw new Error(r.err); parts[n] = [{ bytes: r.bytes, title: base(it.name) }]; }
    else if (it.kind === 'text') parts[n] = [{ bytes: await textToPdf(sheet.decodeText(await it.read()), it.name), title: base(it.name) }];
    else { const { img } = await h.toImage(it); parts[n] = [{ bytes: await pdf.imagesToPdf([{ img }]), title: base(it.name) }]; }
  });
  return parts.filter(Boolean).flat();
}

// ---------- output helpers ----------
function beside(it, src, suffix, extn) {
  const dir = it.abs ? path.dirname(it.abs) : path.dirname(src.path);
  return path.join(dir, `${base(it.name)}${suffix}${extn}`);
}
const nameForGroup = (sources) => (sources.length === 1 && sources[0].type !== 'file' ? base(sources[0].path) : path.basename(path.dirname(sources[0].path)) || 'Combined');
const homeFor = (sources) => path.dirname(sources[0].path);

async function emit(ctx, h, dest, bytes, extra = {}) {
  dest = h.uniquePath(dest); await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.writeFile(dest, bytes);
  ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: bytes.length, kind: extn(dest), ...extra });
  return dest;
}
const extn = (p) => ext(p).slice(1);

const HANDLED = new Set(['mail-pdf', 'mail-onepdf', 'mail-attach', 'combine', 'pdf-compress', 'pdf-split', 'pdf-extract', 'pdf-rotate', 'pdf-flatten', 'pdf-protect', 'pdf-unlock', 'pdf-word', 'office-pdf', 'office-email', 'xls-csv', 'csv-xlsx', 'csv-clean', 'clean', 'photo-report', 'ocr', 'tiff-pdf']);

async function run(sources, action, ctx, h) {
  const all = sources.flatMap((s) => s.items.map((it) => ({ it, src: s })));
  const pick = (pred) => all.filter(({ it }) => pred(it));
  const one = async (list, fn) => h.each(list, 2, ctx, async ({ it, src }) => fn(it, src));

  switch (action.id) {
    case 'mail-pdf': return one(pick((i) => i.kind === 'email'), async (it, src) => {
      const m = await readMail(it); const r = await mailToPdf(m, h);
      const bytes = r.parts.length === 1 ? r.parts[0].bytes : await pdf.combine(r.parts, { flatten: false });
      await emit(ctx, h, beside(it, src, '', '.pdf').replace(/[^\\/]+\.pdf$/, `${mail.safeName(m.subject, base(it.name))}.pdf`), bytes,
        { note: r.skipped.length ? `Not included: ${r.skipped.join(', ')}` : `${r.parts.length - 1} attachment${r.parts.length === 2 ? '' : 's'} included` });
    });
    case 'mail-onepdf': {
      const list = pick((i) => i.kind === 'email'); const parsed = [];
      await one(list, async (it) => { const m = await readMail(it); parsed.push({ m, r: await mailToPdf(m, h), it }); });
      parsed.sort((a, b) => new Date(a.m.date || 0) - new Date(b.m.date || 0));
      const parts = parsed.flatMap(({ m, r }) => r.parts.map((p, i) => (i ? p : { ...p, title: `${m.subject || 'Email'}${m.date ? ` — ${new Date(m.date).toLocaleDateString('en-CA')}` : ''}` })));
      return emit(ctx, h, path.join(homeFor(sources), `${nameForGroup(sources)} emails.pdf`), await pdf.combine(parts, { flatten: false }), { note: `${parsed.length} emails, oldest first, bookmarked` });
    }
    case 'mail-attach': return one(pick((i) => i.kind === 'email' || i.kind === 'tnef'), async (it, src) => {
      const m = await readMail(it);
      const dir = h.uniquePath(beside(it, src, ` (attachments)`, '').replace(/[^\\/]+ \(attachments\)$/, `${it.kind === 'tnef' ? base(it.name) : mail.safeName(m.subject, base(it.name))} (attachments)`));
      let n = 0;
      for (const a of m.attachments.filter((x) => !x.inline)) {
        if (a.mail) { const r = await mailToPdf(a.mail, h); await emit(ctx, h, path.join(dir, `${mail.safeName(a.mail.subject, 'Attached email')}.pdf`), r.parts.length === 1 ? r.parts[0].bytes : await pdf.combine(r.parts, { flatten: false })); n++; continue; }
        await emit(ctx, h, path.join(dir, a.name.replace(/[\\/:*?"<>|]/g, '_')), a.data); n++;
      }
      if (!n) throw new Error('No attachments in this email');
      ctx.dirs.add(dir);
    });
    case 'combine': {
      const list = pick(combinable).map((x) => x.it).sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
      const parts = await partsFor(list, h, ctx);
      if (!parts.length) throw new Error('Nothing here could be combined');
      return emit(ctx, h, path.join(homeFor(sources), `${nameForGroup(sources)} (combined).pdf`), await pdf.combine(parts), { note: `${list.length} files → ${parts.length} sections, forms flattened, bookmarked` });
    }
    case 'pdf-compress': return one(pick((i) => i.kind === 'pdf'), async (it, src) => {
      const b = await it.read(); const out = await pdf.compress(b);
      if (out.length >= b.length * 0.97) throw new Error('Already as small as it can get without losing quality');
      await emit(ctx, h, beside(it, src, ' (compressed)', '.pdf'), out, { note: `${kb(b.length)} → ${kb(out.length)}` });
    });
    case 'pdf-split': return one(pick((i) => i.kind === 'pdf'), async (it, src) => {
      const files = await pdf.split(await it.read()); const dir = h.uniquePath(beside(it, src, ' (pages)', '')); ctx.dirs.add(dir);
      const w = String(files.length).length;
      for (let i = 0; i < files.length; i++) await emit(ctx, h, path.join(dir, `${base(it.name)} p${String(i + 1).padStart(w, '0')}.pdf`), files[i]);
    });
    case 'pdf-extract': return one(pick((i) => i.kind === 'pdf'), async (it, src) => {
      const r = await pdf.extract(await it.read(), action.value || '');
      await emit(ctx, h, beside(it, src, ` p${String(action.value).replace(/\s+/g, '').replace(/[^\d,-]/g, '').slice(0, 30)}`, '.pdf'), r.bytes, { note: `${r.pages.length} page${r.pages.length === 1 ? '' : 's'}` });
    });
    case 'pdf-rotate': return one(pick((i) => i.kind === 'pdf'), async (it, src) => emit(ctx, h, beside(it, src, ' (rotated)', '.pdf'), await pdf.rotate(await it.read(), 90)));
    case 'pdf-flatten': return one(pick((i) => i.kind === 'pdf'), async (it, src) => emit(ctx, h, beside(it, src, ' (flattened)', '.pdf'), await pdf.flatten(await it.read()), { note: 'Fields locked as text — keep the original if you need to edit it' }));
    case 'pdf-protect': return one(pick((i) => i.kind === 'pdf'), async (it, src) => emit(ctx, h, beside(it, src, ' (protected)', '.pdf'), await pdf.protect(await it.read(), action.value), { note: 'AES-256. Send the password separately — by phone or text, not in the same email.' }));
    case 'pdf-unlock': return one(pick((i) => i.kind === 'pdf'), async (it, src) => emit(ctx, h, beside(it, src, ' (unlocked)', '.pdf'), await pdf.unlock(await it.read(), action.value ?? '')));
    case 'pdf-word': {
      const list = pick((i) => i.kind === 'pdf');
      const jobs = await Promise.all(list.map(async ({ it, src }) => ({ op: 'pdf2word', src: await raw.onDisk(it), dest: h.uniquePath(beside(it, src, '', '.docx')) })));
      const res = await office.runJobs(jobs);
      res.forEach((r, i) => { if (r.ok) ctx.outputs.push({ path: jobs[i].dest, name: path.basename(jobs[i].dest), bytes: fs.statSync(jobs[i].dest).size, kind: 'docx' }); else ctx.failures.push({ name: list[i].it.name, reason: r.err }); ctx.progress(i + 1, res.length, list[i].it.name); });
      return;
    }
    case 'office-pdf': case 'office-email': {
      const list = pick((i) => OFFICE.has(i.kind));
      const srcs = await Promise.all(list.map(({ it }) => raw.onDisk(it))); const conv = await officeToPdfs(srcs);
      for (let i = 0; i < list.length; i++) {
        const r = conv.get(srcs[i]); if (r.bytes) await emit(ctx, h, beside(list[i].it, list[i].src, '', '.pdf'), r.bytes); else ctx.failures.push({ name: list[i].it.name, reason: r.err });
        ctx.progress(i + 1, list.length, list[i].it.name);
      }
      if (action.id === 'office-email' && ctx.outputs.length) await office.composeMail({ attachments: ctx.outputs.map((o) => o.path), subject: base(list[0].it.name) });
      return;
    }
    case 'xls-csv': {
      const list = pick((i) => i.kind === 'sheet');
      const jobs = await Promise.all(list.map(async ({ it, src }) => ({ op: 'csv', src: await raw.onDisk(it), dest: h.uniquePath(beside(it, src, ' (CSV)', '')) })));
      const res = await office.runJobs(jobs);
      res.forEach((r, i) => {
        if (!r.ok) return ctx.failures.push({ name: list[i].it.name, reason: r.err });
        ctx.dirs.add(jobs[i].dest);
        for (const f of fs.readdirSync(jobs[i].dest)) ctx.outputs.push({ path: path.join(jobs[i].dest, f), name: f, bytes: fs.statSync(path.join(jobs[i].dest, f)).size, kind: 'csv' });
      });
      return;
    }
    case 'csv-xlsx': return one(pick((i) => i.kind === 'csv'), async (it, src) => {
      const dest = h.uniquePath(beside(it, src, '', '.xlsx')); const r = await sheet.csvToXlsx(await raw.onDisk(it), dest, base(it.name));
      ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: fs.statSync(dest).size, kind: 'xlsx', note: `${r.rows - 1} rows · ${r.textCols} of ${r.cols} columns kept exactly as text (IDs, zeros, dates)` });
    });
    case 'csv-clean': return one(pick((i) => i.kind === 'csv'), async (it, src) => {
      const dest = h.uniquePath(beside(it, src, ' (clean)', '.csv')); const r = sheet.cleanCsv(await raw.onDisk(it), dest);
      ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: fs.statSync(dest).size, kind: 'csv', note: `${r.before - r.after} blank row${r.before - r.after === 1 ? '' : 's'} removed, spaces trimmed, UTF-8` });
    });
    case 'clean': {
      const list = pick((i) => OFFICE.has(i.kind) || i.kind === 'pdf' || isPhotoKind(i.kind));
      const officeList = list.filter(({ it }) => OFFICE.has(it.kind));
      const jobs = await Promise.all(officeList.map(async ({ it, src }) => ({ op: 'clean', src: await raw.onDisk(it), dest: h.uniquePath(beside(it, src, ' (clean)', ext(it.name))) })));
      (await office.runJobs(jobs)).forEach((r, i) => (r.ok ? ctx.outputs.push({ path: jobs[i].dest, name: path.basename(jobs[i].dest), bytes: fs.statSync(jobs[i].dest).size }) : ctx.failures.push({ name: officeList[i].it.name, reason: r.err })));
      await one(list.filter(({ it }) => !OFFICE.has(it.kind)), async (it, src) => {
        if (it.kind === 'pdf') return emit(ctx, h, beside(it, src, ' (clean)', '.pdf'), await pdf.scrub(await it.read()));
        const dest = h.uniquePath(beside(it, src, ' (clean)', ext(it.name))); await fsp.copyFile(await raw.onDisk(it), dest); await raw.stripMeta(dest);
        ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: fs.statSync(dest).size });
      });
      ctx.outputs.forEach((o) => { o.note = o.note || 'Author, company, comments, GPS & edit history removed'; });
      return;
    }
    case 'photo-report': return require('./report').photoReport(sources, pick((i) => isPhotoKind(i.kind)).map((x) => x.it), ctx, h, emit);
    case 'ocr': return require('./ocr').searchable(pick((i) => i.kind === 'pdf' || isPhotoKind(i.kind)), ctx, h, emit, beside);
    case 'tiff-pdf': return one(pick((i) => i.kind === 'tiff'), async (it, src) => {
      const pages = require('./report').tiffPages(await it.read());
      await emit(ctx, h, beside(it, src, '', '.pdf'), await require('./report').pagesToPdf(pages), { note: `${pages.length} page${pages.length === 1 ? '' : 's'}` });
    });
    default: throw new Error(`Unknown action ${action.id}`);
  }
}

module.exports = { run, handles: (id) => HANDLED.has(id), combinable, OFFICE };
