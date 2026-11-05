// Parses every sample email/winmail file, prints a summary, renders each to PDF.
const { app } = require('electron');
const fs = require('fs'); const path = require('path');
const S = '/path/to/leaf-test-data/mail';
app.whenReady().then(async () => {
  const mail = require('/home/user/leaf/src/engine/mail.js'); const { htmlToPdf } = require('/home/user/leaf/src/engine/render.js');
  fs.mkdirSync(`${S}/out`, { recursive: true });
  for (const dir of ['msg', 'tnef']) {
    for (const f of fs.readdirSync(`${S}/${dir}`).filter((x) => /\.(msg|tnef)$/.test(x)).sort()) {
      try {
        process.stdout.write('start ' + f + '\n'); const m = await mail.parseMail(fs.readFileSync(`${S}/${dir}/${f}`)); process.stdout.write('  parsed\n');
        const atts = m.attachments.map((a) => `${a.name}${a.mail ? '[email]' : ''}:${a.size}`).join(', ');
        let pages = '';
        if (dir === 'msg') { const t = Date.now(); const pdf = await htmlToPdf(mail.toHtml(m), { footer: m.subject }); fs.writeFileSync(`${S}/out/${f}.pdf`, pdf); pages = `pdf ${(pdf.length / 1e3).toFixed(0)}KB ${Date.now() - t}ms`; }
        console.log(`${f.padEnd(34)} subj="${m.subject.slice(0, 40)}" from="${m.from.slice(0, 30)}" body=${m.html ? 'html' : m.text ? 'text' : 'NONE'} | ${atts.slice(0, 120)} ${pages}`);
      } catch (e) { console.log(`${f.padEnd(34)} ERROR ${e.message}`); }
    }
  }
  app.exit(0);
});
