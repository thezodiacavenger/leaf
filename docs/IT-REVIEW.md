# Leaf: IT security & deployment review

**One-page summary for IT.** Leaf is a desktop file-conversion assistant for Windows 10/11: the user drags a file onto it, and it converts or packages the file locally (photos, PDFs, Outlook emails, Office files). It is open source (MIT) and built from public source by GitHub Actions.

| | |
|---|---|
| Version reviewed | **0.3.1** ([release](https://github.com/thezodiacavenger/leaf/releases/tag/v0.3.1)) |
| Author | Emmet Adriaans (personal open-source project) |
| Licence | MIT; bundled components listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| Runtime | Electron 44.9.3 (Chromium + Node.js; security-supported release line) |
| Platforms | Windows 10 and 11, x64 |
| Privileges | Standard user. No admin rights, services, drivers or kernel components |
| Code signing | **Not signed** (SmartScreen warns on first run). See "Verifying the download" |

---

## 1. Network behaviour
- **Leaf makes no network connections of its own.** No telemetry, analytics, auto-update, crash reporting, licence checks or cloud APIs. All conversions run locally.
- Two **user-initiated** links open in the user's default apps:
  - **"Map"** in Photo info opens `https://www.openstreetmap.org/?mlat=…&mlon=…` in the default browser, which sends a photo's GPS coordinates to OpenStreetMap.
  - **Email fallback**: when classic Outlook isn't available, Leaf opens a `mailto:` link in the default mail app.
- **Email rendering is sandboxed.** Emails (.msg/.eml) render to PDF in a hidden window with JavaScript disabled and every network request blocked. Remote images and tracking pixels never load.
- Internal `net.fetch` calls read only local files (`file://`) through Leaf's own `leaf://` scheme.

Firewall expectation: Leaf needs **no outbound access**. Blocking it at the firewall has no effect on conversions.

## 2. Processes Leaf starts
| Process | When | Why |
|---|---|---|
| `Leaf.exe` (Electron: main, renderer, GPU and utility processes) | Always | The app. Renderers are sandboxed with context isolation |
| `exiftool.exe` (bundled, with its own Perl runtime, from [exiftool.org](https://exiftool.org/) via `exiftool-vendored`) | Photo metadata | Reads and copies EXIF (camera, date) |
| `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <inline script>` | Office conversions, Outlook drafts, text recognition (OCR) | Drives the user's own Word/Excel/PowerPoint/Outlook via COM and Windows' built-in OCR (`Windows.Media.Ocr`). Scripts are generated inline by Leaf; nothing is downloaded or written as a `.ps1`. `Bypass` applies only to that child process and does not change machine policy |
| `attrib.exe`, `ie4uinit.exe -show` | Only if the user enables the optional "Leaf Pile" folder | Hides `desktop.ini` and refreshes Explorer's icon cache so the folder shows its icon |

**Note for locked-down estates:** under PowerShell Constrained Language Mode, AppLocker or WDAC script rules, the Office, Outlook and OCR features fail with a clear error, and all other features keep working. To allow them, permit `powershell.exe` launched by `Leaf.exe` for COM automation (`New-Object -ComObject Word.Application`, etc.) and WinRT OCR types.

## 3. Files and settings Leaf writes
| Location | What | When |
|---|---|---|
| Next to the user's file, or a new sibling folder (e.g. `Photos (JPEG)\`) | Converted output. **Originals are never modified or deleted** | Each conversion |
| `%APPDATA%\Leaf\` | `settings.json` (window position, preferences), `leaf.log` (error log), Chromium profile cache | Always |
| `%TEMP%\leaf-*` | Thumbnails, temporary copies of files inside zips/emails, render/OCR scratch | During work; cleared at next launch |
| `%LOCALAPPDATA%\Programs\leaf\` | Program files (installer version, per-user install, with uninstaller) | Installer only |
| `%TEMP%\<random>\` | Self-extracting runtime | Portable version, each launch |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | Start-with-Windows entry | Only if the user ticks it in the tray menu |
| `%APPDATA%\Microsoft\Windows\SendTo\Leaf.lnk` | "Send to → Leaf" shortcut | Only if the user ticks it |
| `Desktop\Leaf Pile\` (+ hidden `desktop.ini`, `.leaf-pile.ico`) | Optional watched drop folder | Only if the user accepts the one-time offer |

No HKLM changes, no file associations, no shell extensions, no scheduled tasks.

## 4. Data handling
- **Everything stays on the PC.** Files are read and written locally; nothing is uploaded.
- Office conversions use the **locally installed** Microsoft Office. Leaf opens documents read-only, and never closes a PowerPoint the user already had open.
- "Remove hidden data" strips document properties, comments and GPS. "Shrink for email" removes location data from photos.
- PDF password protection uses AES-256. Leaf never stores passwords.
- `leaf.log` holds error messages and stack traces only. It can contain file names, but never file contents.

## 5. Hardening in the code
- Sandboxed, context-isolated renderers. Only a narrow, channel-checked IPC bridge is exposed.
- The gallery can read only files Leaf itself produced (allow-list).
- Zip extraction rejects absolute paths and `..` (zip-slip).
- Emails render with no JavaScript and no network access (§1).
- Hidden worker windows (RAW development, PDF rendering) load only Leaf's bundled files.
- Dependencies are pinned in `package-lock.json`. New dependency versions must be at least two weeks old (supply-chain caution), and licences are reviewed ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
- Vulnerability reports: [SECURITY.md](../SECURITY.md).

## 6. Verifying the download
Releases are built from the public source by GitHub Actions on a Windows runner ([workflow](../.github/workflows/release.yml)). SHA-256 of the 0.3.1 assets, as published by GitHub:

```
Leaf-Setup-0.3.1.exe     914fd8b15a0ea5f26a1be9f423bba652a50de95c64234107dd6beb05e77a9de8
Leaf-0.3.1-portable.exe  b6ba65e69a8d9e06a50a7bcaa87b540e20c84867875be87d4ef6026b74b67454
```

Check on Windows:
```powershell
Get-FileHash .\Leaf-Setup-0.3.1.exe -Algorithm SHA256
```
The binaries are unsigned. Organisations that require signed code can build from source and sign with their own certificate (`npm ci`, then `npx electron-builder --win nsis`), or allow-list by hash.

## 7. Deployment notes
- **Recommended:** `Leaf-Setup-0.3.1.exe` (per-user install, no admin, uninstall via Settings → Apps).
- **Portable:** runs without installing, but starts more slowly because it unpacks itself each launch.
- **Removal:** uninstall via Settings → Apps, then optionally delete `%APPDATA%\Leaf\` and the `Leaf Pile` desktop folder (user files inside are never deleted automatically).

## 8. Known limitations / open items
- Unsigned binaries (SmartScreen prompt).
- "Write as email" and Outlook attachments require **classic Outlook** (the new Outlook has no COM API; Leaf falls back to showing the files).
- Office, OCR, Leaf Pile icon, Start-with-Windows and Send-To behaviour is written against documented Windows APIs; field testing is ongoing. Word → PDF has been confirmed on Windows.
