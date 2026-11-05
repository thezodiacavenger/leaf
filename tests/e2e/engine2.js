// Engine-level checks: zip a RAW folder, convert a TIFF, HEIC zip regression, multi-file loose drop proposals.
const { app } = require('electron');
const fs = require('fs'); const path = require('path');
const S = '/path/to/leaf-test-data';
app.whenReady().then(async () => {
  const E = '/home/user/leaf/src/engine/';
  const { inspect } = require(E + 'sources'); const { propose } = require(E + 'plan'); const { run, shutdown } = require(E + 'run'); const raw = require(E + 'raw');
  const go = async (paths, label) => {
    const src = await inspect(paths); const p = propose(src, { platform: 'win32' });
    console.log(`\n[${label}] ${p.title} | ${p.subtitle} | ${p.actions.map((a) => a.label).join(' / ')}`);
    return { src, p };
  };
  const exec = async ({ src, p }, id, target) => {
    const a = p.actions.find((x) => x.id === id && (!target || x.target === target));
    const t = Date.now(); const r = await run(src, a, { settings: {}, progress: () => {} });
    console.log(`  -> ${a.label}: ${Date.now() - t} ms, failures ${JSON.stringify(r.failures)}`);
    r.outputs.forEach((o) => console.log(`     ${o.name} ${o.width || ''}x${o.height || ''} ${(o.bytes / 1e6).toFixed(2)}MB ${o.note || ''}`));
    return r;
  };
  try {
    const z = await exec(await go([path.join(S, 'Shoot')], 'RAW folder'), 'zip');
    const zipList = require('child_process').execSync(`unzip -l "${z.outputs[0].path}" | tail -12`).toString(); console.log(zipList);
    await exec(await go([path.join(S, 'tifftest', 'scan.tif')], 'TIFF'), 'convert', 'jpeg');
    await exec(await go([path.join(S, 'tifftest', 'Trip.zip')], 'HEIC zip'), 'convert', 'jpeg');
    await go([path.join(S, 'Shoot', 'sony_a7m3.ARW')], 'single RAW');
    await go([path.join(S, 'tifftest', 'scan.tif'), path.join(S, 'Shoot', 'nikon_z6.NEF')], 'mixed loose');
    await go([path.join(S, 'etdbg.js'), path.join(S, 'engine2.js')], 'two other files');
  } catch (e) { console.log('FAILED', e.stack); }
  shutdown(); await raw.endExiftool(); app.exit(0);
});
