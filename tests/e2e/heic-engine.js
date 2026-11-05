const { app } = require('electron');
const path = require('path');
const E = '/home/user/leaf/src/engine/';
app.whenReady().then(async () => {
  const { inspect } = require(E + 'sources'); const { propose } = require(E + 'plan'); const { run, shutdown } = require(E + 'run');
  const zip = process.argv[process.argv.length - 1];
  for (const pick of [0, 2, 3]) {
    const src = await inspect([zip]); const p = propose(src, { platform: 'win32' });
    if (pick === 0) console.log(JSON.stringify(p, null, 1));
    const t = Date.now();
    const r = await run(src, p.actions[pick], { progress: (d, n, name) => {}, settings: {} });
    console.log(p.actions[pick].label, Date.now() - t, 'ms', JSON.stringify({ dirs: r.dirs, failures: r.failures, outputs: r.outputs.map(o => [o.name, o.width, o.height, o.bytes, !!o.thumb]) }));
  }
  shutdown(); app.quit();
});
