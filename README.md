# Leaf

**Drop anything on the leaf. It works out what you want.**

Leaf is a small glass leaf that sits in the corner of the Windows desktop. Drag a zip, folder, photo or document onto it. Leaf looks inside, suggests the one thing you most likely want, and does it with a single key press. Originals are never changed.

| Suggest | Done | Gallery | Full screen |
|---|---|---|---|
| ![](docs/1-suggest.png) | ![](docs/2-done.png) | ![](docs/3-gallery.png) | ![](docs/4-fullscreen.png) |

---

## The product

### Who it's for
People who get handed files in the wrong shape: iPhone photos in HEIC, zips from vendors, Word documents that should be PDFs or emails. Today they hunt for an online converter, which is slow and sends files to a stranger's server. Leaf does it locally, in about two seconds, from the corner of the screen.

### Design principles (UX)
1. **One obvious answer.** Leaf never asks a question it can answer itself. A zip of HEIC photos doesn't get "Unzip?" followed by "Convert?". Leaf reads the zip's table of contents without extracting it and offers one combined step: **Convert to JPEG**. Alternatives sit beside it, quieter, at most three.
2. **Low stimulation.** No sounds, no talking mascot, no pop-ups it wasn't asked for. The leaf sits at 86% opacity until you need it. Motion appears only to mean something: the leaf swells when you drag over it, shows a progress ring while it works, and nudges once when work finishes in the background.
3. **Keyboard first, mouse friendly.** Enter does the main action, 2–9 pick an alternative and Esc dismisses. In the gallery, use the arrows or Tab to move, Space for full screen, X to select and Ctrl+C to copy.
4. **Safe by construction.** Output always goes to a new folder (`Trip (JPEG)`) or sits next to the original. Nothing is overwritten or deleted. Mac junk files (`__MACOSX`, `._*`, `.DS_Store`) are ignored silently.
5. **Smart about size.** Emailing more than 20 MB of photos sends email-size copies automatically (2048 px, about 5× smaller). The full-size files stay on disk.

### The flow
```
drop ─▶ Leaf reads it (no extraction) ─▶ one suggestion + ≤3 alternatives
     ─▶ Enter ─▶ progress ring on the leaf ─▶ "48 JPEGs ready"
     ─▶ Space ─▶ glass gallery ─▶ Space ─▶ full screen ─▶ ← → ─▶ Email / PDF / Copy
```

### What it does today (v0.1)
| You drop | Leaf suggests | Alternatives |
|---|---|---|
| Zip / folder / files of **HEIC** photos | **Convert to JPEG** | PNG · One PDF · Just unzip |
| JPG / PNG / BMP images | **Shrink for email** | Convert format · One PDF |
| Any other zip | **Unzip** | — |
| Word document (.docx/.doc/.rtf/.odt) *(preview)* | **Save as PDF** (via Word) | Write as email (Outlook, formatting kept) · Email as PDF |

After the conversion: **Preview** (glass gallery), **Folder** and **Email** (opens classic Outlook with attachments; otherwise shows the files so you can drag them into any mail app).

System integration: tray menu, **Start with Windows**, **right-click → Send to → Leaf**, and the leaf can be dragged anywhere on screen (its position is remembered). It follows the light/dark theme and uses Windows 11 acrylic glass, falling back to drawn glass on Windows 10.

### Roadmap
**v0.2: Office and mail (your "Version 2")**
- Word, Excel and PowerPoint → PDF in one step, plus "Combine into one PDF" for a mix of documents.
- Word → email body with formatting kept (done in preview for classic Outlook). Add a new-Outlook / Microsoft Graph route so it works without classic Outlook.
- PDF → images, PDF merge/split, rotate/reorder pages in the gallery.

**v0.3: Connectors** (each one is a new destination on the gallery's side rail)
- OneDrive / SharePoint: "Save to team folder" with a remembered default.
- Teams: send to a chat or channel.
- Gmail / Google Drive for people who don't use Microsoft 365.

**v0.4: Learns your habits**
- If you pick the same alternative three times for a file type, it becomes the default.
- One-step Send To shortcuts ("Leaf: convert to JPEG") using the existing `--auto` flag.
- Optional rules, for example "HEIC from the Downloads folder → JPEG automatically".

**Later**
- Video (MOV → MP4), audio, and live-photo pairs.
- Business drops: drop an ERP inventory export (CSV/XLSX) and get "Summarise aged stock by days on hand". This is a natural fit for the impairment work.

---

## Engineering

**Stack:** Electron 33. No native modules, so it cross-builds cleanly and has no compiler or DLL problems on locked-down PCs.

| Concern | Choice | Why |
|---|---|---|
| HEIC decode | `heic-decode` (libheif in WebAssembly) in a **worker-thread pool** (cores − 1) | Decoding is the slow part; workers keep the UI smooth. |
| JPEG/PNG encode, resize, thumbnails | Electron's built-in `nativeImage` (Chromium's encoder) | Native speed with zero dependencies. |
| Zip | `yauzl`, reading entries lazily into memory | No temporary HEIC files; handles large zips; blocks zip-slip paths. |
| PDF | `pdf-lib` (pure JS) | |
| Word → PDF / Outlook | PowerShell + COM into the user's own Office | Uses real Office, so layout is exactly right. |
| Previews | Custom `leaf://` protocol with an allow-list | The gallery can read only files Leaf itself produced. |

```
src/
  main.js            windows, state machine, IPC, tray, Send To
  preload.js         narrow, channel-checked bridge
  engine/
    sources.js       drop → flat item list (zip/folder/file), junk filtering
    plan.js          the "brain": ranks suggestions
    run.js           executes actions, progress, thumbnails
    pool.js          HEIC worker pool
    heic-worker.js
    office.js        Word/Outlook via PowerShell COM
  ui/
    leaf.html        the leaf (drop target, progress ring, drag-to-move)
    panel.html       suggestion → progress → done
    gallery.html     glass grid, side rail, full-screen preview
    base.css         design tokens (light/dark)
```

Adding a format means adding a case in `plan.js` (what to suggest) and in `run.js` (how to do it). The UI needs no changes.

### Run / build
```bash
npm install
npm start                # dev run
npm run dist             # → dist/Leaf-0.1.2-portable.exe
```
Command line: `Leaf.exe "C:\path\photos.zip"` opens the suggestion panel. Add `--auto` to run the main suggestion straight away.

### Verified vs. not yet verified
- ✅ Zip of HEIC photos → JPEG/PNG/PDF/unzip, folder flattening, macOS junk skipped, other files kept. Tested end to end, including the packaged build.
- ✅ Gallery keyboard navigation, selection, full screen.
- ⚠️ **Not yet run on real Windows:** acrylic glass, Send To, Word → PDF, Word → Outlook and Outlook attachments. These were written against documented Windows/Office APIs but built on Linux. Test them first. If the glass looks wrong, untick **Glass: use Windows acrylic** in the tray menu.
- ⚠️ The exe is unsigned, so SmartScreen will warn on first run (More info → Run anyway). For a company-wide rollout, sign it with a code-signing certificate.
- ⚠️ Photo metadata (EXIF date/GPS) is not carried over to the JPEGs yet.
