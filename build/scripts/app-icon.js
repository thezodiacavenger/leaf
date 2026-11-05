const { chromium } = require('playwright');
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64">
<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d6c4"/><stop offset=".5" stop-color="#2f6bff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient>
<radialGradient id="h" cx=".25" cy=".15" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<path d="M10 54C10 28 26 10 54 10c0 28-16 44-44 44z" fill="url(#a)"/><path d="M10 54C10 28 26 10 54 10c0 28-16 44-44 44z" fill="url(#h)"/>
<path d="M14 50L40 24" stroke="#fff" stroke-opacity=".8" stroke-width="3" stroke-linecap="round"/></svg>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  for (const [s, out] of [[512, 'build/icon.png'], [32, 'src/ui/tray.png']]) {
    await p.setViewportSize({ width: s, height: s });
    await p.setContent(`<body style="margin:0;background:transparent">${svg(s)}</body>`);
    await p.screenshot({ path: out, omitBackground: true });
  }
  await b.close();
})();
