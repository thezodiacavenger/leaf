// The "brain": looks at a drop and proposes a short, ranked list of actions.
// Rule of thumb: one obvious primary action, at most four alternatives. Never ask what we can infer.
const { NATIVE_DECODE } = require('./sources');
const { BRANDS } = require('./raw');

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function summarize(sources) {
  const all = sources.flatMap((s) => s.items);
  const c = { heic: 0, raw: 0, tiff: 0, raster: 0, doc: 0, pdf: 0, archive: 0, other: 0, decodable: 0 };
  for (const it of all) { c[it.kind]++; if (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)) c.decodable++; }
  const bytes = all.reduce((a, it) => a + (it.size || 0), 0);
  return { all, c, bytes };
}

// "Sony ARW · Canon CR3" — tells a photographer at a glance what they dropped.
function rawBrands(all) {
  const seen = [...new Set(all.filter((i) => i.kind === 'raw').map((i) => i.ext))];
  const names = seen.map((e) => (BRANDS[e] === 'DNG' ? 'DNG' : `${BRANDS[e]} ${e.slice(1).toUpperCase()}`));
  return names.length > 3 ? `${names.slice(0, 3).join(' · ')} +${names.length - 3}` : names.join(' · ');
}

function propose(sources, { platform = process.platform } = {}) {
  const { all, c, bytes } = summarize(sources);
  const zips = sources.filter((s) => s.type === 'zip');
  const loose = sources.some((s) => s.type !== 'zip');
  const several = all.length > 1 || sources.some((s) => s.type === 'folder');
  const where = sources.length === 1 ? sources[0].label : plural(sources.length, 'item');
  const photos = c.heic + c.raw + c.tiff + c.decodable;
  const actions = [];
  let title; let icon = 'file'; let detail = '';

  const zipIt = () => loose && several && { id: 'zip', label: 'Make a zip', hint: 'One file, easy to send' };
  const info = () => photos && { id: 'exif', label: 'Photo info', hint: 'Camera, lens, settings, date, location' };

  if (c.raw) {
    icon = 'camera';
    const others = c.heic + c.tiff + c.decodable;
    title = others ? `${c.raw} RAW + ${plural(others, 'photo')}` : plural(c.raw, 'RAW photo');
    detail = rawBrands(all);
    actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Full resolution. Keeps camera, lens & date.' });
    actions.push({ id: 'convert', target: 'png', label: 'PNG', hint: 'Lossless, larger files' });
    actions.push(info());
    actions.push(zipIt() || (photos > 1 && { id: 'pdf', label: 'One PDF', hint: 'Contact sheet style' }));
  } else if (c.heic) {
    icon = 'photo';
    title = plural(c.heic, 'HEIC photo');
    actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Opens anywhere. Originals untouched.' });
    actions.push({ id: 'convert', target: 'png', label: 'PNG', hint: 'Lossless, larger files' });
    if (photos > 1) actions.push({ id: 'pdf', label: 'One PDF', hint: 'All photos, one file' });
    actions.push(photos === 1 ? info() : zipIt());
  } else if (photos) {
    icon = 'photo';
    title = plural(photos, c.tiff && !c.decodable ? 'TIFF image' : 'image');
    if (c.tiff) actions.push({ id: 'convert', target: 'jpeg', label: 'Convert to JPEG', hint: 'Much smaller, opens anywhere' });
    actions.push({ id: 'shrink', label: 'Shrink for email', hint: '2048px, ~5× smaller, location removed' });
    const allJpeg = all.filter((i) => i.kind === 'raster').every((i) => /\.jpe?g$/.test(i.ext));
    if (!c.tiff) actions.push(allJpeg ? { id: 'convert', target: 'png', label: 'PNG' } : { id: 'convert', target: 'jpeg', label: 'JPEG' });
    actions.push({ id: 'pdf', label: photos > 1 ? 'One PDF' : 'PDF' });
    actions.push(info());
    actions.push(zipIt());
  }

  if (c.doc && !photos) {
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
    actions.push(zipIt());
  }

  if (zips.length) {
    actions.push({ id: 'unzip', label: actions.filter(Boolean).length ? 'Just unzip' : 'Unzip', hint: 'Everything, into a folder' });
    if (!title) { icon = 'archive'; title = plural(all.length, 'file'); }
  }

  // Nothing specific to do: zipping is still useful for any pile of files.
  if (!actions.filter(Boolean).length && loose) {
    icon = sources.length === 1 && sources[0].type === 'folder' ? 'archive' : 'file';
    title = title || (sources.length === 1 && sources[0].type === 'folder' ? sources[0].label : plural(all.length, 'file'));
    actions.push({ id: 'zip', label: sources.length === 1 && sources[0].type === 'folder' ? 'Zip this folder' : 'Make a zip', hint: 'One file, easy to send' });
  }

  const list = actions.filter(Boolean).filter((a, i, arr) => arr.findIndex((b) => b.id === a.id && b.target === a.target) === i).slice(0, 5);
  if (!list.length) list.push({ id: 'reveal', label: 'Nothing to convert yet', hint: 'Leaf learns new formats over time', disabled: true });

  const parts = [where];
  if (detail) parts.push(detail);
  if (bytes) parts.push(mb(bytes));
  const handled = photos + (list.some((a) => a.id.startsWith('doc')) ? c.doc : 0);
  const extra = all.length - handled;
  if (extra > 0 && photos && list[0].id === 'convert') parts.push(`${plural(extra, 'other file')} kept as-is`);

  return { icon, title: title || plural(all.length, 'file'), subtitle: parts.join(' · '), actions: list, counts: c, total: all.length };
}

module.exports = { propose, mb, plural };
