const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const S = '/path/to/leaf-test-data';
const J = path.join(S, 'test', 'Trip (JPEG)'); const T = '/tmp/leaf-thumbs';
const thumbDir = fs.readdirSync(T).map((d) => path.join(T, d)).sort().pop();
const thumbs = fs.readdirSync(thumbDir).map((f) => path.join(thumbDir, f)).sort();
const outputs = ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg', 'IMG_0004.jpg'].map((n, i) => ({ name: n, path: path.join(J, n), thumb: thumbs[i % thumbs.length], width: 1440, height: 960, bytes: 200000 }));
const many = Array.from({ length: 48 }, (_, i) => ({ ...outputs[i % 4], name: `IMG_${4400 + i}.jpg` }));
const states = {
  proposal: { phase: 'proposal', proposal: { icon: 'photo', title: '48 HEIC photos', subtitle: 'Vacation.zip · 212 MB · 3 other files kept as-is', actions: [
    { label: 'Convert to JPEG', hint: 'Opens anywhere. Originals untouched.' }, { label: 'PNG' }, { label: 'One PDF' }, { label: 'Just unzip' }] } },
  working: { phase: 'working', action: 'Convert to JPEG', progress: { done: 31, total: 48, name: 'IMG_4471.HEIC' } },
  done: { phase: 'done', result: { action: 'convert', title: 'Vacation (JPEG)', size: '96 MB', outputs: many, failures: [] } },
};
const mock = (state) => `window.leaf = { send(){}, invoke: async () => null, pathsOf: () => [], url: (p) => 'file://' + p,
  on(ch, fn) { if (ch === 'state') setTimeout(() => fn(${JSON.stringify(state)}), 50); if (ch === 'gallery') setTimeout(() => fn(${JSON.stringify(states.done.result)}), 50); } };`;

(async () => {
  const b = await chromium.launch();
  for (const [scheme, which, file, H] of [['dark', 'proposal', 'mock-proposal-dark', 236], ['light', 'done', 'mock-done-light', 286], ['dark', 'working', 'mock-working-dark', 128]]) {
    const ctx = await b.newContext({ bypassCSP: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: scheme });
    await ctx.addInitScript(mock(states[which]));
    const p = await ctx.newPage();
    const wall = path.join(J, scheme === 'dark' ? 'IMG_0003.jpg' : 'IMG_0002.jpg');
    const tb = scheme === 'dark' ? 'rgba(20,22,28,.78)' : 'rgba(240,242,246,.8)';
    const html = path.join(S, `${file}.html`); fs.writeFileSync(html, `<body style="margin:0;height:720px;background:url('file://${wall}') center/cover">
      <div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:${tb};backdrop-filter:blur(30px)"></div>
      <div style="position:absolute;right:112px;bottom:66px;width:380px;height:${H}px;border-radius:9px;overflow:hidden;backdrop-filter:blur(40px) saturate(1.7);box-shadow:0 24px 60px -10px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,${scheme === 'dark' ? 0.1 : 0.5})">
        <iframe src="file:///home/user/leaf/src/ui/panel.html?glass=system" style="border:0;width:100%;height:100%;background:transparent"></iframe></div>
      <iframe src="file:///home/user/leaf/src/ui/leaf.html" style="position:absolute;right:8px;bottom:56px;width:112px;height:112px;border:0;background:transparent"></iframe></body>`); await p.goto('file://' + html);
    await p.waitForTimeout(900); await p.screenshot({ path: `${S}/shots/${file}.png` }); await ctx.close();
  }
  const ctx = await b.newContext({ bypassCSP: true, viewport: { width: 1240, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await ctx.addInitScript(mock(states.done)); const p = await ctx.newPage();
  await p.goto('file:///home/user/leaf/src/ui/gallery.html'); await p.waitForTimeout(800);
  for (const k of ['ArrowRight', 'ArrowRight', 'x', 'ArrowRight', 'x', 'ArrowDown']) await p.keyboard.press(k);
  await p.waitForTimeout(600); await p.screenshot({ path: `${S}/shots/mock-gallery-dark.png` }); await b.close();
})();
