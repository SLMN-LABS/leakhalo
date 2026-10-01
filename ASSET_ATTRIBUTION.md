# Visual asset attribution

The 244 country and territory PNGs in `assets/flags/` were rasterized at 48 × 48 pixels from the SVGs in [kapowaz/square-flags](https://github.com/kapowaz/square-flags), commit `dbc118b3763acfa96482cdd9f71d45a445015d45`. `flag-ct.png` uses `es-ct.svg`; the other files use matching two-letter source filenames. The images are distributed under the MIT license in `assets/flags/LICENSE-square-flags.md`.

The 243 rectangular PNGs in `assets/flags-rect/` are the popup's flags. They were rasterized at 96 × 72 pixels (4:3, sharp on 2× displays in the popup's 36 × 26 frame) from the `flags/4x3` SVGs of [lipis/flag-icons](https://github.com/lipis/flag-icons) version 7.5.0 with `tools/build-popup-flags.cjs`. `flag-ct.png` uses `es-ct.svg`. `flag-an` has no 4:3 source, so the popup falls back to the square flag for it. The images are distributed under the MIT license in `assets/flags-rect/LICENSE-flag-icons.md`. The toolbar icon and notifications keep the square set.

Square Flags is based on [HatScripts/circle-flags](https://github.com/HatScripts/circle-flags), also MIT licensed. Its license notice is included in `assets/flags/LICENSE-circle-flags.md`.

The publisher supplied the new LeakHalo artwork on 2026-09-29. `assets/brand/icon-only.png`, `wordmark.png`, and `flat-mark.png` are optimized from the supplied icon-only, text, and minimal-icon PNGs respectively. The extension icons in `assets/icons/` are sized from the minimal mark. The publisher previously confirmed ownership of the original logo and extension icons.

`assets/brand/salman-labs.png` is cropped from the publisher-supplied Salman Labs logo shared on 2026-09-29 and appears next to the publisher name in Settings.

The package, shield-check, and external-link SVG paths in `options/options.html` come from [Lucide](https://github.com/lucide-icons/lucide). The license and notices are included in `assets/icons/LICENSE-lucide.txt`.

The welcome page's globe (`welcome/land.js`) samples land points from [Natural Earth](https://www.naturalearthdata.com/) (public domain) via the [world-atlas](https://github.com/topojson/world-atlas) package (ISC).
