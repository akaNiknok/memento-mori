# Memento Mori logo

**The idea:** a coin has its sides cut away, and an hourglass is left. Money is measured in time. This is the tagline in one shape: *Count the money. Remember the days.*

## Construction
- **Symbol:** one circle (radius 108 on a 256 grid). The two cuts are wedges whose walls sit at exactly 30° from horizontal. The walls meet at a waist 18 units wide. The two arcs are 120° each, so the coin outline stays clear.
- **Small-size cut** (`mm-symbol-small.svg`): radius 116 and a 30-unit waist. Use it at 32 px and smaller, so the waist stays open at 16 px. The app icon and favicon use this cut.
- **Reversed cut** (`mm-symbol-reversed.svg`): radius 107 and a 16-unit waist. White on a dark ground looks heavier, so this cut is thinner.
- **Wordmark:** custom geometric lowercase, built from rectangles, half-rings and rings. There is no font, so you need no licence. Stem 17, x-height 100. Round letters overshoot by 1.5 and are 1 unit heavier.
- **Source:** `build.py` writes every master SVG. To change the geometry, edit it and run `python brand/build.py brand`. Then copy the small-cut path into `MARK` in `icons.js` and run `npm run icons`.

## Files
| Use | File |
| --- | --- |
| Symbol: ink, accent, small, reversed | `mm-symbol*.svg` |
| Horizontal lockup: ink, accent, dark, reversed | `mm-horizontal*.svg` |
| Stacked lockup: ink, accent, dark, reversed | `mm-stacked*.svg` |
| Wordmark alone | `mm-wordmark.svg` |
| One colour: black, white, accent; SVG and PNG at 1200 px | `variants/` |
| Avatar, rounded app icon, favicon | `icons/` |
| The PWA icons | `icons.js` → `worker/public/icon-*.png` |

## Colour
The logo uses the app's own tokens. It adds no new colour.

| Name | HEX | RGB | Use |
| --- | --- | --- | --- |
| Accent | `#2463EB` | 36 99 235 | Symbol on light, app-icon tile |
| Accent, dark | `#0A84FF` | 10 132 255 | Symbol on dark |
| Ink | `#1C1C1E` | 28 28 30 | Wordmark on light, one-colour mark |
| Paper | `#F5F5F7` | 245 245 247 | Wordmark on dark |

The white symbol on the Accent tile has a contrast ratio of 5.2:1. For print, give the HEX values to the printer for a match. No Pantone value is set.

## Rules
- **Clear space:** keep a space equal to one quarter of the symbol height on all sides. On a 256 symbol, that is 64.
- **Minimum size:** symbol 16 px (use the small cut below 32 px). Horizontal lockup 160 px wide. Stacked lockup 96 px wide.
- **Lockup proportions:** horizontal = x-height is 0.4 of the symbol height, gap 60 on a 256 symbol. Stacked = wordmark is 2.4 symbol widths, gap 52. Do not set the lockups again by hand. Use the files.
- **Grounds:** on white or light grey, use the accent symbol and the ink wordmark. On black or `#1C1C1E`, use the dark files. On a photo or the accent colour, use the white one-colour version.

## Do not
- Do not add a gradient, shadow or outline.
- Do not put a ₱ or any other sign in the waist.
- Do not rotate the symbol 90°. On its side, it reads as a bow tie.
- Do not stretch the symbol, and do not change the angle of the cuts.
- Do not set "Memento Mori" in a font next to the symbol. Use the wordmark.
- Do not use the regular symbol below 32 px. Use the small cut.

## Open items
- The wordmark outlines overlap where strokes join (for example, the stems of m). They render correctly, but they are not merged into one outline. Merge them in a vector editor before you use them for a cut or embroidery.
- No trademark search was done. Do a search before any use outside this project.
