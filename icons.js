// Render the app icon -> worker/public/icon-180.png (apple-touch + favicon) and
// icon-512.png (manifest), each with a -dark twin. `npm run icons`; only needed if the SVG below changes.
// Uses the Chrome/Edge already on the machine as the renderer, so there is no image
// dependency to install. The art is the SVG in this file — there is no binary master.
// Deliberately square with a full-bleed fill: iOS rounds the apple-touch-icon itself and
// Android masks the maskable manifest icon, so baked-in rounded corners would be
// double-rounded there and leave transparent corners iOS composites onto black.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'worker', 'public');
const SIZES = [180, 512];
// The hourglass coin (brand/, DESIGN.md "App icon"): a coin with its sides cut away, so
// what is left is an hourglass. Flat tile, one ink, in a 96-unit box. The drawing is the
// small-size cut (brand/mm-symbol-small.svg, wider waist) because icon-180 is also the
// favicon: its 30-unit waist stays ~1px at 16px. Scaled to a 58-unit diameter, inside
// Android's 80% maskable safe circle (76.8). The shape is symmetric, so no optical nudge.
// Two variants, same geometry: light = white on the accent (--accent #2463EB); dark =
// the dark --accent (#0A84FF) on the dark --card (#1C1C1E).
// index.html swaps the favicon and apple-touch-icon to the -dark files in the dark theme.
const MARK = 'M24 76.62A116 116 0 0 1 232 76.62L143 128L232 179.38A116 116 0 0 1 24 179.38L113 128Z';
const icon = (bg, ink) => `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <rect width="96" height="96" fill="${bg}"/>
  <path transform="translate(48 48) scale(.25) translate(-128 -128)" fill="${ink}" d="${MARK}"/>
</svg>`;
const ICONS = { '': icon('#2463EB', '#fff'), '-dark': icon('#1C1C1E', '#0A84FF') };
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const chrome = BROWSERS.find((p) => fs.existsSync(p));
if (!chrome) throw new Error('No Chrome/Edge found; add its path to BROWSERS in icons.js');

for (const [suffix, ICON] of Object.entries(ICONS)) for (const size of SIZES) {
  const wrap = path.join(os.tmpdir(), `mm-icon-${size}${suffix}.html`);
  fs.writeFileSync(wrap, `<style>*{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${ICON}`);
  const out = path.join(OUT_DIR, `icon-${size}${suffix}.png`);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${out}`, `--window-size=${size},${size}`, wrap], { stdio: 'ignore' });
  fs.unlinkSync(wrap);
  console.log(`${out} (${fs.statSync(out).size} bytes)`);
}
