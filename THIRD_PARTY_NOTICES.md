# Third-party notices

Leaf is MIT-licensed (see [LICENSE](LICENSE)). The Windows build bundles the components below, each under its own licence. Full licence texts ship inside each package under `resources/app.asar` / `resources/app.asar.unpacked/node_modules/<package>/`.

## Components with copyleft or special terms

| Component | Used for | Licence | Notes |
|---|---|---|---|
| [libheif](https://github.com/strukturag/libheif) and [libde265](https://github.com/strukturag/libde265), via [`libheif-js`](https://github.com/catdad-experiments/libheif-js) | HEIC/HEIF decoding | LGPL-3.0 | Shipped as a separate, replaceable file in `resources/app.asar.unpacked/node_modules/libheif-js/`. Source: the links above. |
| [LibRaw](https://www.libraw.org/), via [`libraw-wasm`](https://github.com/ybouane/LibRaw-Wasm) (ISC) | RAW photo development | LGPL-2.1 or CDDL-1.0 (LibRaw's dual licence) | Shipped as a separate, replaceable file in `resources/app.asar.unpacked/node_modules/libraw-wasm/`. Source: libraw.org. |
| [ExifTool](https://exiftool.org/) by Phil Harvey, via [`exiftool-vendored`](https://github.com/photostructure/exiftool-vendored.js) (MIT) | Photo metadata | Same terms as Perl (Artistic License or GPL) | Windows build includes `exiftool.exe` and its bundled Perl runtime, unmodified. |

## Permissive components

| Package | Licence |
|---|---|
| Electron (includes Chromium and Node.js; see `LICENSES.chromium.html` next to `Leaf.exe`) | MIT (+ Chromium's BSD-style and component licences) |
| @cantoo/pdf-lib | MIT |
| pdfjs-dist (Mozilla pdf.js) | Apache-2.0 |
| @kenjiuno/msgreader | Apache-2.0 |
| @kenjiuno/decompressrtf | BSD-2-Clause |
| rtf-stream-parser | MIT |
| postal-mime | MIT-0 |
| heic-decode | ISC |
| yauzl, yazl | MIT |
| utif | MIT |
| exiftool-vendored, batch-cluster, luxon, he | MIT |
| @photostructure/tz-lookup | CC0-1.0 |
| pako | MIT AND Zlib |
| tslib | 0BSD |
| remaining transitive dependencies | MIT |

Run `npm ls --omit=dev --all` for the exact dependency tree of any build.
