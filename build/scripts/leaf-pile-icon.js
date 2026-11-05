// Renders the "Leaf Pile" folder icon (aurora glass folder + leaf) at several sizes and packs a Windows .ico.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = '/home/user/leaf/src/ui/leaf-pile.ico'; const PREVIEW = '/path/to/leaf-test-data/leaf-pile-256.png';
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 256 256">
<defs>
 <linearGradient id="au" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d6c4"/><stop offset=".5" stop-color="#2f6bff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient>
 <linearGradient id="back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8fd8"/><stop offset="1" stop-color="#5b3fd6"/></linearGradient>
 <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity=".04"/></linearGradient>
 <radialGradient id="glow" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#9ff6ea" stop-opacity=".55"/><stop offset="1" stop-color="#9ff6ea" stop-opacity="0"/></radialGradient>
</defs>
<path d="M22 64a16 16 0 0 1 16-16h56l20 20h104a16 16 0 0 1 16 16v118a16 16 0 0 1-16 16H38a16 16 0 0 1-16-16z" fill="url(#back)"/>
<path d="M14 98a16 16 0 0 1 16-16h196a16 16 0 0 1 16 16l-10 104a16 16 0 0 1-16 14H40a16 16 0 0 1-16-14z" fill="url(#au)"/>
<path d="M14 98a16 16 0 0 1 16-16h196a16 16 0 0 1 16 16l-10 104a16 16 0 0 1-16 14H40a16 16 0 0 1-16-14z" fill="url(#glow)"/>
<path d="M14 98a16 16 0 0 1 16-16h196a16 16 0 0 1 16 16l-3 30H17z" fill="url(#glass)"/>
<path d="M14 98a16 16 0 0 1 16-16h196a16 16 0 0 1 16 16" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="3"/>
<g transform="translate(128 152)">
 <path d="M-34 34C-34-6-10-34 34-34c0 44-26 68-68 68z" fill="#fff" fill-opacity=".92"/>
 <path d="M-28 28L12-12" stroke="url(#au)" stroke-width="5" stroke-linecap="round"/>
</g></svg>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const pngs = [];
  for (const s of [16, 24, 32, 48, 64, 256]) {
    await p.setViewportSize({ width: s, height: s }); await p.setContent(`<body style="margin:0;background:transparent">${svg(s)}</body>`);
    pngs.push([s, await p.screenshot({ omitBackground: true })]);
  }
  await b.close();
  fs.writeFileSync(PREVIEW, pngs[pngs.length - 1][1]);
  // ICO = 6-byte header + 16-byte entry per image + PNG payloads (PNG-in-ICO works on Windows Vista+).
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = 6 + 16 * pngs.length; const entries = []; const datas = [];
  for (const [s, png] of pngs) {
    const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(off, 12);
    entries.push(e); datas.push(png); off += png.length;
  }
  fs.writeFileSync(OUT, Buffer.concat([head, ...entries, ...datas]));
  console.log('ico bytes', fs.statSync(OUT).size);
})();
