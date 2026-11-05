// Email files -> one normalized shape: { subject, from, to, cc, date, html, text, attachments[] }.
// .msg (Outlook, incl. RTF-only bodies and emails attached to emails), .eml (MIME), winmail.dat (TNEF).
const path = require('node:path');

const decoder = (enc) => { try { return new TextDecoder(String(enc || 'utf-8').replace(/^cp(\d+)$/i, 'windows-$1').replace(/^ansi_x3\.4-1968$/i, 'ascii')); } catch { return new TextDecoder('windows-1252'); } };
const decode = (buf, enc) => decoder(enc).decode(buf);

// Outlook RTF ("compressed RTF" with HTML wrapped inside) -> html or text
function rtfToBody(compressed) {
  try {
    const { decompressRTF } = require('@kenjiuno/decompressrtf');
    const { deEncapsulateSync } = require('rtf-stream-parser');
    const rtf = Buffer.from(decompressRTF(Array.from(compressed)));
    const r = deEncapsulateSync(rtf, { decode, mode: 'either' });
    return r.mode === 'html' ? { html: String(r.text) } : { text: String(r.text) };
  } catch { return {}; }
}

const who = (name, email) => (name && email && name !== email ? `${name} <${email}>` : name || email || '');

// ---------- .msg ----------
function parseMsg(buf, depth = 0) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const reader = new MsgReader(buf);
  const d = reader.getFileData();
  if (d.error) throw new Error(d.error);
  return fromMsgFields(reader, d, depth);
}
function fromMsgFields(reader, d, depth) {
  const recips = (type) => (d.recipients || []).filter((r) => (r.recipType || 'to') === type).map((r) => who(r.name, r.smtpAddress || r.email)).join('; ');
  let html = d.bodyHtml || (d.html ? decode(d.html, 'utf-8') : '');
  let text = d.body || '';
  if (!html && d.compressedRtf) { const r = rtfToBody(d.compressedRtf); html = r.html || ''; if (!text) text = r.text || ''; }
  const attachments = [];
  for (const a of d.attachments || []) {
    try {
      if (a.innerMsgContent && depth < 2) {
        const inner = fromMsgFields(reader, a.innerMsgContentFields, depth + 1);
        attachments.push({ name: `${(inner.subject || 'Attached email').slice(0, 80)}.msg`, mail: inner, data: null, size: 0 });
        continue;
      }
      const got = reader.getAttachment(a);
      attachments.push({ name: got.fileName || a.fileName || a.fileNameShort || 'attachment', data: Buffer.from(got.content), cid: (a.pidContentId || '').replace(/[<>]/g, ''), mime: a.attachMimeTag || '', hidden: !!a.attachmentHidden, size: got.content.length });
    } catch { /* skip unreadable attachment */ }
  }
  return {
    subject: d.subject || '', from: who(d.senderName, d.senderSmtpAddress || d.senderEmail), to: recips('to'), cc: recips('cc'),
    date: d.clientSubmitTime || d.messageDeliveryTime || d.creationTime || '', html, text, attachments,
  };
}

// ---------- .eml ----------
async function parseEml(buf) {
  const { default: PostalMime } = await import('postal-mime');
  const e = await PostalMime.parse(buf, { attachmentEncoding: 'arraybuffer' });
  const list = (xs) => (xs || []).map((x) => who(x.name, x.address)).join('; ');
  const attachments = [];
  for (const a of e.attachments || []) {
    const data = Buffer.from(a.content);
    if (/^message\/rfc822$/i.test(a.mimeType)) { try { const inner = await parseEml(data); attachments.push({ name: `${(inner.subject || 'Attached email').slice(0, 80)}.eml`, mail: inner, data: null, size: 0 }); continue; } catch {} }
    attachments.push({ name: a.filename || `attachment${a.mimeType ? '.' + a.mimeType.split('/')[1] : ''}`, data, cid: (a.contentId || '').replace(/[<>]/g, ''), mime: a.mimeType || '', hidden: a.disposition === 'inline' && !!a.contentId, size: data.length });
  }
  return { subject: e.subject || '', from: e.from ? who(e.from.name, e.from.address) : '', to: list(e.to), cc: list(e.cc), date: e.date || '', html: e.html || '', text: e.text || '', attachments };
}

// ---------- winmail.dat (TNEF) ----------
const TNEF_SIG = 0x223e9f78;
const isTnef = (buf) => buf.length > 6 && buf.readUInt32LE(0) === TNEF_SIG;
const cstr = (b) => decode(b.subarray(0, b.indexOf(0) >= 0 ? b.indexOf(0) : b.length), 'windows-1252');

// MAPI property block (used for long file names, attached data, message bodies)
function mapiProps(b) {
  const out = {}; let p = 0; const pad = (n) => (n + 3) & ~3;
  const fixed = { 0x0002: 4, 0x0003: 4, 0x0004: 4, 0x0005: 8, 0x0006: 8, 0x0007: 8, 0x000a: 4, 0x000b: 4, 0x0014: 8, 0x0040: 8, 0x0048: 16 };
  try {
    const count = b.readUInt32LE(p); p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const type = b.readUInt16LE(p); const id = b.readUInt16LE(p + 2); p += 4;
      if (id >= 0x8000) { p += 16; const kind = b.readUInt32LE(p); p += 4; if (kind === 0) p += 4; else { const n = b.readUInt32LE(p); p += 4 + pad(n); } }
      const base = type & 0x0fff; const multi = (type & 0x1000) !== 0;
      if (fixed[base]) { const n = multi ? b.readUInt32LE(p) : 1; if (multi) p += 4; out[id] = b.subarray(p, p + fixed[base]); p += fixed[base] * n; continue; }
      const n = b.readUInt32LE(p); p += 4; const vals = [];
      for (let k = 0; k < n; k++) { const len = b.readUInt32LE(p); p += 4; vals.push(b.subarray(p, p + len)); p += pad(len); }
      out[id] = { type: base, vals };
    }
  } catch { /* truncated block: keep what we have */ }
  return out;
}
const propStr = (v) => (!v || !v.vals ? '' : v.type === 0x001f ? Buffer.from(v.vals[0]).toString('utf16le').replace(/\0+$/, '') : cstr(v.vals[0]));

function parseTnef(buf) {
  if (!isTnef(buf)) throw new Error('not a winmail.dat file');
  let p = 6; const attachments = []; let cur = null; const msg = { subject: '', from: '', to: '', cc: '', date: '', html: '', text: '' };
  while (p + 9 <= buf.length) {
    const level = buf[p]; const id = buf.readUInt32LE(p + 1); const len = buf.readUInt32LE(p + 5);
    if (p + 9 + len > buf.length) break;
    const data = buf.subarray(p + 9, p + 9 + len); p += 11 + len; const name = id & 0xffff;
    if (level === 2) {
      if (name === 0x9002) { cur = { name: '', data: null }; attachments.push(cur); }
      else if (!cur) continue;
      else if (name === 0x8010) { if (!cur.name) cur.name = cstr(data); }
      else if (name === 0x800f) cur.data = Buffer.from(data);
      else if (name === 0x9005) {
        const pr = mapiProps(data);
        const long = propStr(pr[0x3707]) || propStr(pr[0x3001]); if (long) cur.name = long;
        if (!cur.data && pr[0x3701] && pr[0x3701].vals) { const v = pr[0x3701]; cur.data = Buffer.from(v.type === 0x000d ? v.vals[0].subarray(16) : v.vals[0]); }
        const mime = propStr(pr[0x370e]); if (mime) cur.mime = mime;
      }
    } else if (level === 1) {
      if (name === 0x8004) msg.subject = cstr(data);
      else if (name === 0x800c) msg.text = cstr(data);
      else if (name === 0x9003) {
        const pr = mapiProps(data);
        if (!msg.subject) msg.subject = propStr(pr[0x0037]);
        if (pr[0x1013] && pr[0x1013].vals) msg.html = decode(pr[0x1013].vals[0], 'utf-8');
        if (!msg.html && pr[0x1009] && pr[0x1009].vals) { const r = rtfToBody(pr[0x1009].vals[0]); msg.html = r.html || ''; if (!msg.text) msg.text = r.text || ''; }
        if (!msg.text) msg.text = propStr(pr[0x1000]);
      }
    }
  }
  msg.attachments = attachments.filter((a) => a.data && a.data.length).map((a, i) => ({ name: a.name || `attachment-${i + 1}`, data: a.data, mime: a.mime || '', size: a.data.length }));
  return msg;
}

// Pick the right parser from the bytes, not just the extension.
async function parseMail(buf, ext) {
  if (isTnef(buf)) return parseTnef(buf);
  if (buf.readUInt32LE(0) === 0xe011cfd0) return parseMsg(buf); // OLE compound file = Outlook .msg
  return parseEml(buf);
}

// Windows-safe file name from a subject line.
function safeName(s, fallback = 'Email') {
  const n = String(s || '').replace(/^(re|fw|fwd)\s*:\s*/gi, (m) => m.toUpperCase().replace(/\s+/g, '')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
  return n || fallback;
}

// The page Leaf prints: a clear header block, then the email body exactly as sent (in its own style scope).
function toHtml(m) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const date = m.date ? (() => { const d = new Date(m.date); return isNaN(d) ? String(m.date) : d.toLocaleString('en-CA', { dateStyle: 'full', timeStyle: 'short' }); })() : '';
  const files = m.attachments.filter((a) => !a.inline);
  const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  let body = m.html;
  if (body) {
    for (const a of m.attachments) if (a.cid && a.data) {
      const re = new RegExp(`cid:${a.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
      if (re.test(body)) { a.inline = true; body = body.replace(re, `data:${a.mime || 'image/png'};base64,${a.data.toString('base64')}`); }
    }
    // Images referenced by plain file name (common in older Outlook mail)
    for (const a of m.attachments) if (a.data && /^image\//i.test(a.mime || '') || (a.data && /\.(png|jpe?g|gif|bmp|webp)$/i.test(a.name))) {
      const re = new RegExp(`(src\\s*=\\s*["'])${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'])`, 'gi');
      if (re.test(body)) { a.inline = true; const mime = a.mime || `image/${a.name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')}`; body = body.replace(re, `$1data:${mime};base64,${a.data.toString('base64')}$2`); }
    }
    // Word-authored mail carries its own page setup (@page, page: WordSection1) which forces blank pages.
    const styles = (body.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n').replace(/@page[^{]*\{[^}]*\}/gi, '').replace(/(^|[;{\s])page\s*:\s*[\w-]+\s*;?/gi, '$1');
    const inner = (body.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, body])[1];
    body = (styles + inner).replace(/<\/?template/gi, '&lt;template').replace(/<script[\s\S]*?<\/script>/gi, '');
  } else {
    body = `<pre>${esc(m.text || '(no message text)')}</pre>`;
  }
  const rows = [['From', m.from], ['To', m.to], ['Cc', m.cc], ['Sent', date], ['Attachments', m.attachments.filter((a) => !a.inline).map((a) => `${a.name}${a.size ? ` (${kb(a.size)})` : ''}`).join(', ')]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.subject)}</title><style>
    @page { size: Letter; margin: 0.6in; }
    body { font: 10.5pt/1.45 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
    .hdr { border-bottom: 2px solid #2f6bff; padding-bottom: 10px; margin-bottom: 18px; }
    h1 { font-size: 15pt; margin: 0 0 8px; font-weight: 600; }
    table.h { border-collapse: collapse; } table.h td { padding: 2px 10px 2px 0; vertical-align: top; font-size: 9.5pt; }
    td.k { color: #666; white-space: nowrap; }
  </style></head><body>
  <div class="hdr"><h1>${esc(m.subject || '(no subject)')}</h1><table class="h">${rows}</table></div>
  <div class="mail"><template shadowrootmode="open"><style>:host{display:block;overflow-wrap:anywhere} *{widows:1;orphans:1} img{max-width:100%;max-height:7in;width:auto;height:auto;object-fit:contain} img[src^="http"],img[src^="//"]{display:none!important} pre{white-space:pre-wrap;font:10.5pt/1.45 "Segoe UI",Arial,sans-serif;margin:0} table{max-width:100%}</style>${body}</template></div>
  </body></html>`;
}

module.exports = { parseMail, toHtml, safeName, isTnef };
