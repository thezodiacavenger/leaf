const fs = require('fs'); const path = require('path');
const R = require('/home/user/leaf/src/engine/raw.js');
const D = '/path/to/leaf-test-data/raws';
(async () => {
  for (const f of fs.readdirSync(D).filter((f) => /^[a-z]/.test(f)).sort()) {
    const p = path.join(D, f); const buf = fs.readFileSync(p);
    const t0 = Date.now(); const j = R.largestJpeg(buf); const ms = Date.now() - t0;
    const o = await R.orientationOf(p); const info = await R.photoInfo(p);
    console.log(f.padEnd(18), j ? `${j.width}x${j.height}`.padEnd(10) : 'NONE      ', `${ms}ms`.padEnd(6), 'orient', o, '|', info.camera, '|', info.hero.join(' · '), '|', (info.rows.find((r) => r[0] === 'Lens') || [])[1] || '-');
    if (j) fs.writeFileSync(`/path/to/leaf-test-data/prev_${f}.jpg`, j.data);
  }
  const all = await R.allTags(path.join(D, 'canon_r6.CR3')); console.log('all tags (R6):', all.length, all.slice(0, 3));
  await R.endExiftool();
})();
