// RAW photos + metadata.
// Every major camera stores a camera-rendered JPEG inside its RAW file (that's what the camera's own
// screen shows). We find the largest one, rotate it per EXIF, and copy the original metadata across.
// ExifTool (bundled) reads/writes metadata for every brand, including CR3 and RAF.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const BRANDS = {
  '.cr2': 'Canon', '.cr3': 'Canon', '.crw': 'Canon', '.nef': 'Nikon', '.nrw': 'Nikon', '.arw': 'Sony', '.srf': 'Sony', '.sr2': 'Sony',
  '.raf': 'Fujifilm', '.orf': 'OM System / Olympus', '.ori': 'OM System / Olympus', '.rw2': 'Panasonic Lumix', '.rwl': 'Leica', '.dng': 'DNG',
  '.pef': 'Pentax', '.srw': 'Samsung', '.3fr': 'Hasselblad', '.fff': 'Hasselblad', '.iiq': 'Phase One', '.x3f': 'Sigma', '.erf': 'Epson',
  '.mos': 'Leaf', '.mrw': 'Minolta', '.kdc': 'Kodak', '.dcr': 'Kodak',
};
const RAW = new Set(Object.keys(BRANDS));

// ---------- find the biggest displayable JPEG inside any file ----------
const SOI = Buffer.from([0xff, 0xd8, 0xff]);
function jpegAt(buf, i) {
  let j = i + 2; let w = 0; let h = 0;
  while (j + 4 <= buf.length) {
    if (buf[j] !== 0xff) return null;
    let m = buf[j + 1];
    while (m === 0xff && j + 2 < buf.length) { j++; m = buf[j + 1]; } // fill bytes
    if (m === 0xd9) return w && h ? { start: i, end: j + 2, w, h } : null;
    if (m >= 0xd0 && m <= 0xd7) { j += 2; continue; }
    const len = buf.readUInt16BE(j + 2);
    if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) { h = buf.readUInt16BE(j + 5); w = buf.readUInt16BE(j + 7); }
    else if ((m >= 0xc3 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null; // lossless/arithmetic = sensor data, not a picture
    j += 2 + len;
    if (m === 0xda) { // entropy-coded data: skip to the next real marker
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] !== 0x00 && !(buf[j + 1] >= 0xd0 && buf[j + 1] <= 0xd7))) j++;
    }
  }
  return null;
}
function largestJpeg(buf) {
  let best = null; let pos = 0;
  while ((pos = buf.indexOf(SOI, pos)) !== -1) {
    const c = jpegAt(buf, pos);
    if (c && c.w >= 160 && c.h >= 120 && (!best || c.w * c.h > best.w * best.h)) best = c;
    pos = c ? c.end : pos + 2;
  }
  return best && { data: buf.subarray(best.start, best.end), width: best.w, height: best.h };
}

// ---------- rotate a BGRA bitmap per EXIF orientation ----------
function rotate(bgra, w, h, orientation) {
  if (![3, 6, 8].includes(orientation)) return { data: bgra, width: w, height: h };
  const src = new Uint32Array(bgra.buffer, bgra.byteOffset, w * h);
  const out = new Uint32Array(w * h);
  if (orientation === 3) { for (let i = 0, n = w * h; i < n; i++) out[n - 1 - i] = src[i]; return { data: Buffer.from(out.buffer), width: w, height: h }; }
  // 6 = rotate 90° clockwise, 8 = 90° counter-clockwise; result is h wide, w tall
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const nx = orientation === 6 ? h - 1 - y : y;
      const ny = orientation === 6 ? x : w - 1 - x;
      out[ny * h + nx] = src[row + x];
    }
  }
  return { data: Buffer.from(out.buffer), width: h, height: w };
}

// ---------- ExifTool (one shared, long-lived process) ----------
let et;
function exiftool() {
  if (!et) { const { ExifTool } = require('exiftool-vendored'); et = new ExifTool({ maxProcs: 3, taskTimeoutMillis: 30000 }); }
  return et;
}
// Orientation + true output size of a RAW (decides: use the camera's JPEG, or develop the RAW).
async function rawInfo(file) {
  try {
    const t = await exiftool().read(file, ['-n', '-Orientation', '-ImageSize']);
    const [w, h] = String(t.ImageSize || '').split(/[ x]/).map(Number);
    return { orientation: Number(t.Orientation) || 1, width: w || 0, height: h || 0 };
  } catch { return { orientation: 1, width: 0, height: 0 }; }
}

// Copies all metadata from the original onto the converted file, marks it upright, drops embedded previews.
async function copyMeta(src, dest, { stripGps = false } = {}) {
  try {
    await exiftool().write(dest, {}, { writeArgs: ['-overwrite_original', '-tagsFromFile', src, '-all:all', '-unsafe', '-Orientation#=1',
      '-PreviewImage=', '-ThumbnailImage=', '-JpgFromRaw=', '-OtherImage=', ...(stripGps ? ['-gps:all='] : [])] });
  } catch { /* metadata is a bonus; never fail a conversion over it */ }
}

// Strips every metadata tag (GPS, camera serial, author…) but keeps the colour profile and rotation.
async function stripMeta(file) {
  await exiftool().write(file, {}, { writeArgs: ['-overwrite_original', '-all=', '-tagsFromFile', '@', '-icc_profile', '-Orientation'] });
}

// Gives ExifTool a real file even for items that live inside a zip.
const TMP = path.join(os.tmpdir(), 'leaf-src'); let tmpSeq = 0;
async function onDisk(item, buf) {
  if (item.abs) return item.abs;
  if (item._tmp) return item._tmp;
  // Own folder per item so the copy keeps its real name (shown in Photo info).
  const dir = path.join(TMP, `${Date.now().toString(36)}-${++tmpSeq}`); await fsp.mkdir(dir, { recursive: true });
  item._tmp = path.join(dir, item.name.replace(/[\\/:*?"<>|]/g, '_'));
  await fsp.writeFile(item._tmp, buf || await item.read());
  return item._tmp;
}

// ---------- human-friendly photo info ----------
const fmtDate = (d) => { if (!d) return ''; const s = d.toDate ? d.toDate() : d.rawValue ? d.rawValue : d; const dt = s instanceof Date ? s : new Date(String(s).replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')); return isNaN(dt) ? String(d.rawValue || d) : dt.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
const val = (v) => (v == null || v === '' ? '' : typeof v === 'object' && v.rawValue != null ? String(v.rawValue) : String(v));

async function photoInfo(file) {
  const t = await exiftool().read(file);
  const camera = [t.Make, t.Model].filter(Boolean).join(' ').replace(/^(\w+)\s+\1\b/i, '$1').replace(/^NIKON CORPORATION NIKON/i, 'Nikon').replace(/^OLYMPUS (IMAGING )?CORP\.\s*/i, 'Olympus ').trim();
  const shutter = val(t.ExposureTime || t.ShutterSpeed);
  const hero = [t.FocalLength && val(t.FocalLength).replace(/\.0 mm/, ' mm'), t.FNumber && `ƒ/${t.FNumber}`, shutter && `${shutter} s`, t.ISO && `ISO ${t.ISO}`].filter(Boolean);
  const [w, h] = String(t.ImageSize || '').split(/[ x]/).map(Number).filter(Boolean).length === 2 ? String(t.ImageSize).split(/[ x]/).map(Number) : [t.ImageWidth || t.ExifImageWidth, t.ImageHeight || t.ExifImageHeight];
  const rows = [
    ['Lens', val(t.LensModel || t.LensID || t.Lens || t.LensType)],
    ['Taken', fmtDate(t.DateTimeOriginal || t.CreateDate)],
    ['Size', w && h ? `${w} × ${h}${t.Megapixels ? ` · ${Math.round(t.Megapixels)} MP` : ''}` : ''],
    ['Exposure', [t.ExposureProgram, t.ExposureCompensation != null && t.ExposureCompensation !== 0 ? `${t.ExposureCompensation > 0 ? '+' : ''}${val(t.ExposureCompensation)} EV` : ''].filter(Boolean).join(' · ')],
    ['Metering', val(t.MeteringMode)], ['White balance', val(t.WhiteBalance)], ['Flash', val(t.Flash)],
    ['Focus', [t.FocusMode, t.AFAreaMode].filter(Boolean).map(val).join(' · ')],
    ['Shutter count', val(t.ShutterCount || t.ImageCount || t.MechanicalShutterCount)],
    ['Serial', val(t.SerialNumber || t.InternalSerialNumber)],
    ['Firmware', val(t.FirmwareVersion || t.Software)],
    ['Location', t.GPSLatitude != null && t.GPSLongitude != null ? `${Number(t.GPSLatitude).toFixed(5)}, ${Number(t.GPSLongitude).toFixed(5)}` : ''],
    ['Artist', val(t.Artist || t.Creator)], ['Copyright', val(t.Copyright)],
    ['File', [path.basename(file), val(t.FileSize)].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);
  const gps = t.GPSLatitude != null && t.GPSLongitude != null ? { lat: Number(t.GPSLatitude), lon: Number(t.GPSLongitude) } : null;
  const d = t.DateTimeOriginal || t.CreateDate; const takenRaw = d && d.toDate ? +d.toDate() : 0;
  return { camera: camera || path.basename(file), hero, rows, gps, name: path.basename(file), takenRaw };
}

// Every tag, grouped, for the "All tags" view.
async function allTags(file) {
  const t = await exiftool().readRaw(file, { readArgs: ['-G1', '-a', '-s'] });
  return Object.entries(t).filter(([k, v]) => !/^SourceFile$|^ExifTool|:(Directory|FilePermissions|FileAccessDate|FileInodeChangeDate|FileModifyDate)$/.test(k) && v != null && !(typeof v === 'string' && /^\(Binary data/.test(v)) && !(typeof v === 'object' && v._ctor))
    .map(([k, v]) => { const [g, n] = k.includes(':') ? k.split(':') : ['', k]; return [g, n, typeof v === 'object' ? JSON.stringify(v) : String(v)]; });
}

module.exports = { RAW, BRANDS, largestJpeg, rotate, rawInfo, copyMeta, stripMeta, onDisk, photoInfo, allTags, endExiftool: () => et && et.end() };
