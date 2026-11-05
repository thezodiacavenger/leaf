// The "brain": looks at a drop and proposes a short, ranked list of actions.
// Rule of thumb: one obvious primary action, at most three alternatives. Never ask what we can infer.
const { NATIVE_DECODE } = require('./sources');

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function summarize(sources) {
  const all = sources.flatMap((s) => s.items);
  const c = { heic: 0, raster: 0, doc: 0, pdf: 0, archive: 0, other: 0, decodable: 0 };
  for (const it of all) { c[it.kind]++; if (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)) c.decodable++; }
  const bytes = all.reduce((a, it) => a + (it.size || 0), 0);
  return { all, c, bytes };
}

function propose(sources, { platform = process.platform } = {}) {
  const { all, c, bytes } = summarize(sources);
  const zips = sources.filter((s) => s.type === 'zip');
  const where = sources.length === 1 ? sources[0].label : plural(sources.length, 'item');
  const images = c.heic + c.decodable;
  const actions = [];
  let title; let icon = 'file';

  if (c.heic) {
    icon = 'photo';
    title = plural(c.heic, 'HEIC photo');
    actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Opens anywhere. Originals untouched.' });
    actions.push({ id: 'convert', target: 'png', label: 'PNG', hint: 'Lossless, larger files' });
    if (images > 1) actions.push({ id: 'pdf', label: 'One PDF', hint: 'All photos, one file' });
  } else if (images) {
    icon = 'photo';
    title = plural(images, 'image');
    const allJpeg = all.filter((i) => i.kind === 'raster').every((i) => /\.jpe?g$/.test(i.ext));
    actions.push({ id: 'shrink', label: 'Shrink for email', hint: '2048px, ~5× smaller' });
    actions.push(allJpeg ? { id: 'convert', target: 'png', label: 'PNG' } : { id: 'convert', target: 'jpeg', label: 'JPEG' });
    if (images > 1 || c.doc === 0) actions.push({ id: 'pdf', label: images > 1 ? 'One PDF' : 'PDF' });
  }

  if (c.doc && !images) {
    icon = 'doc';
    const docs = all.filter((i) => i.kind === 'doc');
    title = docs.length === 1 ? docs[0].name : plural(docs.length, 'document');
    if (platform === 'win32') {
      actions.push({ id: 'doc-pdf', label: 'Save as PDF', hint: 'Uses Word, keeps layout' });
      if (docs.length === 1) actions.push({ id: 'doc-mail', label: 'Write as email', hint: 'Body pasted into Outlook, formatting kept' });
      actions.push({ id: 'doc-attach', label: 'Email as PDF' });
    } else {
      actions.push({ id: 'unsupported', label: 'Save as PDF', hint: 'Windows + Word required', disabled: true });
    }
  }

  if (zips.length) {
    actions.push({ id: 'unzip', label: actions.length ? 'Just unzip' : 'Unzip', hint: 'Everything, into a folder' });
    if (!title) { icon = 'archive'; title = plural(all.length, 'file'); }
  }

  if (!actions.length) {
    title = title || plural(all.length, 'file');
    actions.push({ id: 'reveal', label: 'Nothing to convert yet', hint: 'Leaf learns new formats over time', disabled: true });
  }

  const parts = [where];
  if (bytes) parts.push(mb(bytes));
  const extra = all.length - c.heic - (c.heic ? 0 : images) - (actions.some((a) => a.id.startsWith('doc')) ? c.doc : 0);
  if (extra > 0 && (c.heic || images)) parts.push(`${plural(extra, 'other file')} kept as-is`);

  return { icon, title, subtitle: parts.join(' · '), actions, counts: c, total: all.length };
}

module.exports = { propose, mb, plural };
