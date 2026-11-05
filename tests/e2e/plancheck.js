const { app } = require('electron');
app.whenReady().then(async () => {
  const E = '/home/user/leaf/src/engine/';
  const { inspect, enrich } = require(E + 'sources'); const { propose } = require(E + 'plan');
  for (const p of process.env.PATHS.split('|')) { const s = await enrich(await inspect([p])); const r = propose(s, { platform: 'win32' }); console.log(p.split('/').pop(), '=>', r.title, '|', r.actions.map((a) => a.id + (a.target ? ':' + a.target : '')).join(', ')); }
  app.exit(0);
});
