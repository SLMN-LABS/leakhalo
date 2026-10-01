// Rasterises lipis/flag-icons 4x3 SVGs into assets/flags-rect/flag-{code}.png for the popup.
// The toolbar keeps the square flags in assets/flags/; the popup shows flags in a 36×26 CSS box,
// so rectangular artwork at 96×72 stays sharp on 2× displays.
//
//   npm pack flag-icons@7.5.0 && tar xzf flag-icons-7.5.0.tgz
//   node tools/build-popup-flags.cjs package/flags/4x3
//
// Needs playwright-core (npm install) and a Chromium build (npx playwright-core install chromium).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const req = m => require(m); // npm install (devDependencies) provides playwright-core
const { chromium } = req('playwright-core');

const svgDir = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(svgDir, 'de.svg'))) { console.error('usage: node tools/build-popup-flags.cjs <flag-icons>/flags/4x3'); process.exit(1); }
const outDir = path.join(root, 'assets/flags-rect');
const W = 96, H = 72;
const ALIAS = { ct: 'es-ct' }; // assets/flags uses "ct" for Catalonia (see ASSET_ATTRIBUTION.md)

(async () => {
  const codes = fs.readdirSync(path.join(root, 'assets/flags')).map(f => /^flag-([a-z]{2})\.png$/.exec(f)).filter(Boolean).map(m => m[1]).sort();
  fs.mkdirSync(outDir, { recursive: true });
  const exe = process.env.BROWSER_EXECUTABLE || path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
  const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const page = await browser.newPage();
  const missing = [];
  try {
    for (const code of codes) {
      const file = path.join(svgDir, (ALIAS[code] || code) + '.svg');
      if (!fs.existsSync(file)) { missing.push(code); continue; }
      const svg = 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64');
      const png = await page.evaluate(async ({ svg, W, H }) => {
        const img = new Image(); img.src = svg; await img.decode();
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, W, H);
        return c.toDataURL('image/png').split(',')[1];
      }, { svg, W, H });
      fs.writeFileSync(path.join(outDir, `flag-${code}.png`), Buffer.from(png, 'base64'));
    }
  } finally { await browser.close(); }
  console.log(`Wrote ${codes.length - missing.length} flags to ${path.relative(root, outDir)}.`);
  if (missing.length) console.log(`No 4x3 artwork for: ${missing.join(', ')} — the popup falls back to the square flag.`);
})().catch(e => { console.error(e); process.exit(1); });
