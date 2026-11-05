# Contributing to Leaf

Thanks for helping! Leaf is a calm, local-only Windows assistant: drop a file, get the one action you most likely want. Contributions that keep it **fast, private, and quiet** are very welcome.

## Good first contributions
- **A new file type or conversion.** See "Adding a format" below; it usually touches two files.
- **Better suggestions.** If Leaf guessed wrong for something you dropped, open an issue with what you dropped and what you expected.
- **Windows testing.** Many features drive Office or Windows APIs; reports from real PCs are gold.
- Translations, accessibility, docs.

## Set up
Requirements: Node.js 20+ and Git. Windows 10/11 for the full experience; Linux or macOS works for most engine work.

```bash
git clone https://github.com/thezodiacavenger/leaf
cd leaf
npm install
npm start          # run Leaf from source
npm test           # self-contained engine tests (on Linux, run under xvfb-run)
```

Build the Windows app:
```bash
npm run prebuild   # only needed when building on Linux/macOS (fetches the Windows ExifTool)
npm run dist       # → dist/Leaf-<version>-portable.exe
```

## How Leaf is put together
```
src/main.js            windows, state machine, IPC, tray, Leaf Pile, leaf:// protocol
src/engine/sources.js  turns a drop into items and works out each file's kind
src/engine/plan.js     the "brain": ranks suggestions for a drop
src/engine/run.js      photo conversions, zip/unzip; hands document actions to docs.js
src/engine/docs.js     email, combine, PDF toolkit, Office, CSV, photo report, OCR, fax
src/engine/*.js        focused helpers (mail, pdf, render, office, raw, ocr, sheet, report…)
src/ui/*.html          leaf, panel, gallery, plus hidden darkroom/workroom pages
```
Heavy work runs off the UI: HEIC in worker threads, RAW in a hidden "darkroom" window (LibRaw WebAssembly), PDF rendering in a hidden "workroom" (pdf.js), emails in a locked-down render window (no JavaScript, no network).

### Adding a format
1. **Recognise it**: add the extension to `kindOf()` in `src/engine/sources.js`.
2. **Suggest it**: add a branch in `propose()` in `src/engine/plan.js`. One primary action, quieter alternatives.
3. **Do it**: handle the action id in `src/engine/docs.js` (documents) or `src/engine/run.js` (images).
4. **Name the result**: add a done-title in `doneTitle()` in `src/ui/panel.html`.
5. Add a case to `tests/unit.js`.

## Principles (please keep these)
- **Local only.** No cloud APIs, telemetry or network calls with user content.
- **Never touch originals.** Write new files next to the source or into a new folder.
- **One obvious answer.** Don't add a question when the file tells you the answer.
- **Low stimulation.** No sounds, pop-ups or animation without meaning.
- **Small and dependency-light.** Prefer platform features (Chromium, Windows, Office) over new packages. New dependencies need a permissive licence and a version at least two weeks old.

## Pull requests
- Keep PRs focused; describe what you dropped, what Leaf did before, and what it does now.
- `npm test` must pass. Screenshots help for UI changes.
- Windows-only behaviour (Office, OCR, Explorer): say whether you tested it on Windows 10, 11, or not at all.

By contributing you agree your work is licensed under the [MIT License](LICENSE).
