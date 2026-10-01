// End-to-end test: loads the unpacked extension into real Chromium and drives it through network
// scenarios served by a local HTTPS stand-in for every provider (Cloudflare, icanhazip, ipify,
// Amazon, ipwho.is, GeoJS, ipinfo). Nothing is mocked inside the extension: the service worker,
// popup, options page, chrome.action, chrome.notifications and chrome.privacy are the real ones.
// Welcome compatibility checks separately simulate unavailable action UI APIs in that page.
//
//   node test/e2e_browser.cjs            mocked scenarios (deterministic)
//   node test/e2e_browser.cjs --live     also runs once against the real providers
//
// Needs playwright-core and a Chromium build (the halo film's node_modules has both):
//   PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE override the defaults. Screenshots go to test/e2e-output/.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), https = require('node:https');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const req = m => require(m); // npm install (devDependencies) provides playwright-core
const { chromium } = req(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const BROWSER = process.env.BROWSER_EXECUTABLE || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const OUT = path.join(__dirname, 'e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- provider stand-in ---------------- */
const IR = '46.100.233.74', AZ = '31.171.101.166', DE = '203.0.113.44', NL = '203.0.113.60', US6 = '2001:db8::26', PSIP = '203.0.113.99', C_IP = '198.51.100.77';
const GEO = {
  [IR]: { country_code: 'IR', country: 'Iran', city: 'Tehran', region: 'Tehran', connection: { isp: 'Telecommunication Company of Iran', asn: 58224 } },
  [AZ]: { country_code: 'AZ', country: 'Azerbaijan', city: 'Baku', region: 'Baku City', connection: { isp: 'Delta Telecom Ltd', asn: 29049 } },
  [DE]: { country_code: 'DE', country: 'Germany', city: 'Berlin', region: 'Berlin', connection: { isp: 'Example Network', asn: 64500 } },
  [NL]: { country_code: 'NL', country: 'Netherlands', city: 'Amsterdam', region: 'North Holland', connection: { isp: 'Example NL', asn: 64510 } },
  [US6]: { country_code: 'US', country: 'United States', city: 'San Francisco', region: 'California', connection: { isp: 'Example v6', asn: 64501 } },
  [PSIP]: { country_code: 'PS', country: 'Palestine', city: 'Ramallah', region: 'West Bank', connection: { isp: 'Example PS', asn: 64520 } },
  [C_IP]: { country_code: 'FR', country: 'France', city: 'Paris', region: 'Île-de-France', connection: { isp: 'Example FR', asn: 64530 } }
};
const net = {
  edge: IR, loc: 'IR', indep: IR, v6: null,
  serverIp: null,    // IP the LeakHalo server stand-in reports (null = same as edge)
  sockets: new Set(), wsOrigins: [],
  down: new Set(),   // hosts answering 503
  hang: new Set(),   // hosts that never answer
  log: []
};
const HOSTS = ['35-232-61-175.sslip.io', 'cloudflare.com', 'ipv4.icanhazip.com', 'ipv6.icanhazip.com', 'api.ipify.org', 'api6.ipify.org', 'checkip.amazonaws.com', 'ipwho.is', 'get.geojs.io', 'ipinfo.io'];

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakhalo-e2e-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=leakhalo-e2e',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (rq, rs) => {
    const host = (rq.headers.host || '').split(':')[0], url = new URL(rq.url, 'https://x');
    net.log.push({ t: Date.now(), host, path: url.pathname });
    if (net.hang.has(host)) return; // never respond
    const send = (code, body, type = 'text/plain') => { rs.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' }); rs.end(body); };
    if (net.down.has(host)) return send(503, 'down');
    switch (host) {
      case 'cloudflare.com': return send(200, `fl=1\nh=cloudflare.com\nip=${net.edge}\nts=0\nloc=${net.loc}\n`);
      case 'ipv4.icanhazip.com': return send(200, net.edge + '\n');
      case 'api.ipify.org': return send(200, JSON.stringify({ ip: net.indep }), 'application/json');
      case 'checkip.amazonaws.com': return send(200, net.indep + '\n');
      // Without IPv6 the connection fails, as on a real IPv4-only network. (Answering 503 would
      // instead trigger Chrome's throttling of extension requests that keep getting server errors.)
      case 'api6.ipify.org': return net.v6 ? send(200, JSON.stringify({ ip: net.v6 }), 'application/json') : rq.socket.destroy();
      case 'ipv6.icanhazip.com': return net.v6 ? send(200, net.v6 + '\n') : rq.socket.destroy();
      case 'ipwho.is': {
        const ip = decodeURIComponent(url.pathname.slice(1)), g = GEO[ip];
        return send(200, JSON.stringify(g ? { success: true, ip, ...g, timezone: { id: 'UTC' }, latitude: 1, longitude: 1 } : { success: false }), 'application/json');
      }
      default: return send(503, 'unused');
    }
  });
  attachWebSocket(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Minimal RFC 6455 stand-in for LeakHalo's change-detection server: hello + ping/pong.
function attachWebSocket(server) {
  const crypto = require('node:crypto');
  const frame = text => { const b = Buffer.from(text); const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); return Buffer.concat([head, b]); };
  server.on('upgrade', (rq, socket) => {
    if (!rq.url.startsWith('/v1/ws') || net.down.has('ipwatch')) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(rq.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    net.sockets.add(socket); net.wsOrigins.push(rq.headers.origin);
    const ip = () => net.serverIp || net.edge;
    socket.write(frame(JSON.stringify({ v: 1, type: 'hello', ip: ip(), ts: Date.now() })));
    let buf = Buffer.alloc(0);
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
        buf = buf.slice(off + 4 + len);
        if (op === 8) { socket.end(); return; }
        if (op === 1) { try { const m = JSON.parse(data); if (m.type === 'ping') socket.write(frame(JSON.stringify({ v: 1, type: 'pong', id: m.id, ip: ip() }))); } catch (e) {} }
      }
    });
    const drop = () => net.sockets.delete(socket);
    socket.on('close', drop); socket.on('error', drop);
  });
}
const dropSockets = () => { for (const s of net.sockets) s.destroy(); net.sockets.clear(); };

/* ---------------- test runner ---------------- */
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✓ ${name}`); }
  catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
    if (global.lastTiming) console.log('      timing (s): ' + global.lastTiming);
    if (global.dumpState) console.log('      state: ' + await global.dumpState().catch(err => err.message));
  } finally {
    net.down.clear(); net.hang.clear(); // a failing check must not break the ones after it
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(250); }
  throw new Error(`Timed out after ${ms} ms waiting for ${what}${last !== undefined ? ` (last: ${JSON.stringify(last)})` : ''}`);
}

async function launch({ mocked, port }) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakhalo-profile-'));
  const args = [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-sandbox', '--no-first-run'];
  if (mocked) {
    args.push('--no-proxy-server', '--ignore-certificate-errors', `--host-resolver-rules=${HOSTS.map(h => `MAP ${h} 127.0.0.1:${port}`).join(',')},EXCLUDE localhost`);
  }
  // Live runs go through the host's proxy when one is configured (Chromium ignores *_proxy env vars).
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!mocked && proxy) args.push(`--proxy-server=${proxy}`);
  const context = await chromium.launchPersistentContext(userDir, { executablePath: BROWSER, headless: true, args, viewport: { width: 420, height: 760 } });
  const errors = [], welcomeErrors = [], welcomeRequests = [], welcomePages = new Set();
  const watchPage = page => {
    const record = message => {
      if (page.url().endsWith('/welcome/welcome.html')) welcomeErrors.push(message);
      errors.push(`page: ${message}`);
    };
    page.on('pageerror', e => record(e.message));
    page.on('console', m => { if (m.type() === 'error') record(m.text()); });
    page.on('request', r => { if (page.url().endsWith('/welcome/welcome.html')) welcomeRequests.push(r.url()); });
    const track = () => { if (page.url().endsWith('/welcome/welcome.html')) welcomePages.add(page); };
    page.on('framenavigated', track);
    track();
  };
  context.on('page', watchPage);
  context.pages().forEach(watchPage);
  let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
  sw.on?.('console', m => { if (m.type() === 'error') errors.push(`sw: ${m.text()}`); });
  const id = new URL(sw.url()).host;
  return { context, sw, id, errors, welcomeErrors, welcomeRequests, welcomePages };
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const { context, sw, id, errors, welcomeErrors, welcomeRequests, welcomePages } = await launch({ mocked: true, port });
  const bg = (fn, arg) => sw.evaluate(fn, arg);
  const storage = keys => bg(k => chrome.storage.local.get(k), keys);
  const action = () => bg(async () => ({ title: await chrome.action.getTitle({}), badge: await chrome.action.getBadgeText({}) }));
  global.dumpState = async () => JSON.stringify({ storage: await storage(['latestV4Info', 'probeError', 'v4Unverified', 'isOffline', 'routeState', 'routeDivergence']), action: await action(),
    popup: global.currentPopup && !global.currentPopup.isClosed() ? await popupState(global.currentPopup) : null, recent: net.log.slice(-6).map(r => r.host), ipifyCalls: net.log.slice(-40).filter(r => r.host === 'api.ipify.org').length, amazonCalls: net.log.slice(-40).filter(r => r.host === 'checkip.amazonaws.com').length });
  const notifications = [];
  // Record notifications as the extension creates them (the real API is still called).
  await bg(() => {
    const orig = chrome.notifications.create.bind(chrome.notifications);
    self.__notes = [];
    chrome.notifications.create = (id, opts, cb) => { self.__notes.push({ title: opts.title, message: opts.message }); return orig(id, opts, cb); };
  });
  const notes = () => bg(() => self.__notes.slice());
  const probe = (force = true) => bg(f => fetchAllBackgroundLocations(f), force);
  const shot = async (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const openPopup = async () => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`popup: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`popup: ${m.text()}`); });
    await page.goto(`chrome-extension://${id}/popup/popup.html`);
    await page.waitForSelector('#content', { state: 'visible', timeout: 15_000 });
    global.currentPopup = page;
    return page;
  };
  const popupState = page => page.evaluate(() => ({
    ip: document.getElementById('v4Ip')?.textContent.trim(),
    country: document.getElementById('v4Country')?.textContent.trim(),
    city: document.getElementById('v4CityRegion')?.textContent.trim(),
    flag: document.getElementById('v4FlagImg')?.getAttribute('src'),
    flagW: document.getElementById('v4FlagImg')?.naturalWidth,
    status: document.querySelector('.subbar-label')?.textContent.trim(),
    alert: getComputedStyle(document.getElementById('routeAlert')).display !== 'none',
    alertRows: [...document.querySelectorAll('#routeAlertRows .route-alert-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    split: getComputedStyle(document.getElementById('splitBadge')).display !== 'none',
    v6: getComputedStyle(document.getElementById('v6ActiveCard')).display !== 'none' ? document.getElementById('v6Ip')?.textContent.trim() : null,
    webrtc: document.getElementById('webrtcStatus')?.textContent.trim(),
    armor: document.getElementById('shieldStatusText')?.textContent.trim(),
    stamp: document.getElementById('lastUpdatedTime')?.textContent.trim()
  }));
  const settings = patch => bg(async p => {
    const { appSettings = {} } = await chrome.storage.local.get('appSettings');
    await chrome.storage.local.set({ appSettings: { ...appSettings, ...p } });
  }, patch);

  console.log('\nLeakHalo end-to-end (real Chromium, local provider stand-ins)\n');

  await check('Service worker starts and the first check stores the Cloudflare IP with its location', async () => {
    const s = await waitFor(async () => { const r = await storage(['latestV4Info']); return r.latestV4Info?.country === 'Iran' && r.latestV4Info; }, 20_000, 'first result');
    assert(s.ip === IR && s.vantage === 'edge', `stored ${JSON.stringify(s)}`);
  });
  await check('Toolbar shows the location title without a warning', async () => {
    const a = await waitFor(async () => { const x = await action(); return /Iran/.test(x.title) && x; }, 10_000, 'toolbar title');
    assert(a.badge === '' && !/different/.test(a.title), JSON.stringify(a));
  });

  let welcome;
  const welcomeState = page => page.evaluate(() => ({
    country: document.getElementById('connectionCountry').textContent,
    city: document.getElementById('connectionCity').textContent,
    ip: document.getElementById('connectionV4').textContent,
    v6: document.getElementById('connectionV6').textContent,
    network: document.getElementById('connectionNetwork').textContent,
    policy: document.getElementById('connectionPolicy').textContent,
    flag: document.getElementById('connectionFlag').getAttribute('src'),
    flagW: document.getElementById('connectionFlag').naturalWidth,
    pinned: document.getElementById('pinCard').dataset.pinned,
    pinStatus: document.getElementById('pinStatusText').textContent,
    state: document.getElementById('connectionCard').dataset.state
  }));
  await check('First install automatically opens exactly one welcome tab with the live Iran connection', async () => {
    welcome = await waitFor(() => context.pages().find(p => p.url() === `chrome-extension://${id}/welcome/welcome.html`), 10_000, 'automatic welcome tab');
    const s = await waitFor(async () => { const x = await welcomeState(welcome); return x.country === 'Iran' && x.flagW === 96 && x; }, 10_000, 'welcome connection');
    assert(s.ip === IR && /Tehran/.test(s.city) && /AS58224/.test(s.network) && /flags-rect\/flag-ir\.png$/.test(s.flag), JSON.stringify(s));
    assert(context.pages().filter(p => p.url().endsWith('/welcome/welcome.html')).length === 1 && welcomePages.size === 1, 'more than one automatic welcome tab');
    await welcome.reload(); // register request/error monitoring through an entire load
    await waitFor(async () => (await welcomeState(welcome)).country === 'Iran', 10_000, 'welcome reload');
    assert(welcomePages.size === 1, 'reload opened another welcome tab');
  });
  await check('Welcome pin guide shows instructions when headless Chrome reports not pinned', async () => {
    assert((await welcome.evaluate(() => chrome.action.getUserSettings())).isOnToolbar === false, 'headless action unexpectedly pinned');
    const s = await welcomeState(welcome);
    assert(s.pinned === 'false' && /pin LeakHalo/.test(s.pinStatus), JSON.stringify(s));
    assert(await welcome.locator('.pin-steps li').count() === 3, 'missing numbered pin steps');
  });
  await check('Welcome quick setup persists all three preferences and syncs both ways with Settings', async () => {
    const opt = await context.newPage();
    try {
      await opt.goto(`chrome-extension://${id}/options/options.html`);
      await opt.waitForFunction(() => document.getElementById('saveToast').textContent === 'Saved in this browser');
      const original = (await storage('appSettings')).appSettings || {};
      const pairs = [
        ['setNotifications', 'enableNotifications'], ['setFastDetection', 'enableFastDetection'], ['setAntiLeakShield', 'enableAntiLeakShield']
      ];
      for (const [control, key] of pairs) {
        await welcome.uncheck(`#${control}`);
        await waitFor(async () => (await storage('appSettings')).appSettings?.[key] === false && !(await opt.isChecked(`#${control}`)), 8_000, `${key} saved and mirrored`);
        await waitFor(() => welcome.locator('#saveStatus').textContent().then(t => t === 'Saved in this browser'), 8_000, 'settings effects');
        if (key === 'enableAntiLeakShield') {
          assert((await bg(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}))).value === 'default', 'shield side effect missing');
          assert((await welcomeState(welcome)).policy === 'WebRTC protection off', 'disabled shield labelled active');
        }
        await opt.check(`#${control}`, { force: true });
        await waitFor(async () => (await storage('appSettings')).appSettings?.[key] === true && await welcome.isChecked(`#${control}`), 8_000, `${key} external sync`);
      }
      const after = (await storage('appSettings')).appSettings;
      for (const key of Object.keys(original).filter(k => !pairs.some(p => p[1] === k))) assert(after[key] === original[key], `unrelated ${key} changed`);
      await waitFor(async () => (await welcomeState(welcome)).policy === 'Policy active', 8_000, 'verified welcome policy');
    } finally { await opt.close(); }
  });
  await check('Welcome pin events, visible polling, unavailable APIs and popup rejection degrade gracefully', async () => {
    for (const mode of ['event', 'poll', 'unavailable']) {
      const page = await context.newPage();
      try {
        await page.addInitScript(mode => {
          window.__pin = false;
          window.__pinReads = 0;
          chrome.action.getUserSettings = mode === 'unavailable' ? undefined : async () => { window.__pinReads++; return { isOnToolbar: window.__pin }; };
          chrome.action.onUserSettingsChanged = mode === 'event' ? { addListener(fn) { window.__pinChanged = fn; } } : undefined;
          chrome.action.openPopup = mode === 'unavailable' ? undefined : async () => { throw new Error('No focused window'); };
        }, mode);
        await page.goto(`chrome-extension://${id}/welcome/welcome.html`);
        await page.click('#openPopup');
        assert(await page.locator('#popupHelp').textContent() === 'Click the LeakHalo icon in your toolbar', 'missing popup help');
        if (mode === 'unavailable') {
          assert((await welcomeState(page)).pinned === 'false', 'unavailable API claimed success');
        } else {
          await page.evaluate(mode => { window.__pin = true; if (mode === 'event') window.__pinChanged({ isOnToolbar: true }); }, mode);
          await waitFor(async () => (await welcomeState(page)).pinned === 'true', 5_000, `${mode} pin detection`);
          assert((await welcomeState(page)).pinStatus === 'Pinned. Your country is now always one glance away.', 'missing success');
          assert(await page.locator('#pinFinalStep').getAttribute('aria-current') === 'step', 'step indicator not completed');
          if (mode === 'poll') {
            assert(await page.evaluate(() => window.__pinReads) >= 2, 'fallback did not poll');
            await page.evaluate(() => {
              Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
              document.dispatchEvent(new Event('visibilitychange'));
            });
            const reads = await page.evaluate(() => window.__pinReads);
            await sleep(1700);
            assert(await page.evaluate(() => window.__pinReads) === reads, 'hidden tab kept polling');
          }
        }
      } finally { await page.close(); }
    }
  });
  await check('Welcome fits desktop Chrome windows (1366×657 and 1920×969 viewports) without overflow', async () => {
    // Background tabs are not rendered; measure the welcome page as the active tab, as users see it.
    await welcome.bringToFront();
    // Real page viewports of Chrome on 1366×768 and 1920×1080 Windows screens.
    for (const [name, width, height] of [['1366', 1366, 657], ['1920', 1920, 969]]) {
      await welcome.setViewportSize({ width, height });
      for (const colorScheme of ['light', 'dark']) {
        await welcome.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await welcome.evaluate(() => window.scrollTo(0, 0));
        await welcome.screenshot({ path: path.join(OUT, `welcome-${name}-${colorScheme}.png`) });
        await shot(welcome, `welcome-${name}-${colorScheme}-full`);
        const layout = await welcome.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        assert(layout.content <= layout.viewport, `${name}/${colorScheme} overflow: ${JSON.stringify(layout)}`);
        assert(await welcome.evaluate(() => [...document.querySelectorAll('*')].every(n => getComputedStyle(n).animationName === 'none')), 'reduced motion left an animation running');
      }
    }
    const nextFrame = () => welcome.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (const width of [1024, 2560]) {
      await welcome.setViewportSize({ width, height: 900 });
      await nextFrame(); // layout-driven positions (the globe label) update on the next frame
      const over = await welcome.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth, client: document.documentElement.clientWidth,
        culprits: [...document.querySelectorAll('body *')].filter(n => n.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).slice(0, 5).map(n => `${n.tagName}.${n.className || n.id}:${Math.round(n.getBoundingClientRect().right)}`) }));
      assert(over.scroll <= over.inner, `${width}px horizontal overflow: ${JSON.stringify(over)}`);
    }
    // The key content (connection card and the pin coach) is above the fold on a 1366×768 laptop.
    await welcome.setViewportSize({ width: 1366, height: 657 });
    const fold = await welcome.evaluate(() => ({ card: document.getElementById('connectionCard').getBoundingClientRect().bottom, coach: document.querySelector('.coach-card').getBoundingClientRect().bottom }));
    assert(fold.card <= 657 && fold.coach <= 657, `below the fold: ${JSON.stringify(fold)}`);
    await welcome.setViewportSize({ width: 1440, height: 900 });
    await welcome.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    assert(!welcomeRequests.some(url => !url.startsWith(`chrome-extension://${id}/`)), `external welcome request: ${welcomeRequests.join(', ')}`);
  });
  await check('Welcome reserves connection space and has readable contrast', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await welcome.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const width of [1024, 1366, 1920]) {
        await welcome.setViewportSize({ width, height: 900 });
        // Exercise the renderer synchronously so background storage events cannot interrupt
        // the measurements. Actual provider→storage→page updates are checked separately.
        const result = await welcome.evaluate(() => {
          const saved = state;
          const savedFailure = checkFailed;
          checkFailed = false;
          const heights = [], observed = [];
          const measure = () => {
            render();
            heights.push(document.getElementById('connectionCard').getBoundingClientRect().height);
            observed.push(document.getElementById('connectionCountry').textContent);
          };
          try {
            state = { appSettings: {} }; measure();
            state = { appSettings: {}, shieldEffective: true, latestV4Info: { ip: '46.100.233.74', pending: true, countryCode: '' } }; measure();
            state = { ...state, latestV4Info: { ip: '46.100.233.74', countryCode: 'IR', country: 'Iran', city: 'Tehran', isp: 'Example ISP', asn: 'AS58224' }, latestV6Info: { ip: '2001:db8::26', countryCode: 'US', city: 'San Francisco', isp: 'Example v6' } }; measure();
            state.probeError = true; measure();
            state.isOffline = true; measure();
            state.appSettings.enableAntiLeakShield = false; measure();
          } finally { state = saved; checkFailed = savedFailure; render(); }
          const css = getComputedStyle(document.documentElement);
          const luminance = hex => {
            const c = hex.trim().slice(1);
            const full = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
            return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          };
          const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
          // Text tokens against the darkest and lightest page backgrounds, and the gradient button.
          const contrasts = [['--ink', '--bg'], ['--muted', '--bg'], ['--faint', '--bg'], ['--mint', '--bg'], ['--sky', '--bg'], ['--faint', '--bg-2'], ['--muted', '--bg-2']].map(([a, b]) => contrast(css.getPropertyValue(a), css.getPropertyValue(b)));
          const button = getComputedStyle(document.getElementById('openPopup'));
          const rgbHex = rgb => '#' + rgb.match(/\d+/g).slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('');
          for (const stop of ['#7dd3fc', css.getPropertyValue('--mint')]) contrasts.push(contrast(rgbHex(button.color), stop));
          return { heights, observed, contrasts };
        });
        assert(Math.max(...result.heights) - Math.min(...result.heights) < 1, `${width}/${colorScheme} card shifted: ${result.heights}`);
        assert(result.observed[1] === 'Locating…' && result.observed[3] === 'Unable to verify network' && result.observed[4] === 'You’re offline', JSON.stringify(result.observed));
        assert(result.contrasts.every(ratio => ratio >= 4.5), `${colorScheme} contrast: ${JSON.stringify(result.contrasts)}`);
      }
    }
    await welcome.setViewportSize({ width: 1440, height: 900 });
    await welcome.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  });

  let popup = await openPopup();
  await check('Popup renders IP, country, city and a sharp rectangular flag', async () => {
    const s = await waitFor(async () => { const x = await popupState(popup); return x.country === 'Iran' && x.flagW > 0 && x; }, 10_000, 'popup');
    assert(s.ip === IR && /Tehran/.test(s.city) && /flags-rect\/flag-ir\.png$/.test(s.flag) && s.flagW === 96 && s.status === 'Live Monitor' && !s.alert, JSON.stringify(s));
    await shot(popup, '01-normal');
  });

  await check('Popup timestamp reports the last check, so an open popup never looks stale', async () => {
    await sleep(8_000);
    const s = await popupState(popup);
    assert(/^Checked (just now|[0-9]s ago)$/.test(s.stamp), `timestamp: ${s.stamp}`);
  });
  await check('Default: ipify routed abroad — popup shows only the main country, no warning anywhere', async () => {
    net.indep = AZ;
    const seen = new Set();
    const end = Date.now() + 22_000;
    while (Date.now() < end) { const s = await popupState(popup); seen.add(s.ip); assert(!s.alert, 'warning card shown by default'); await sleep(300); }
    assert(!seen.has(AZ) && seen.has(IR), `IPs shown: ${[...seen]}`);
    const a = await action();
    assert(a.badge === '' && !/different/.test(a.title) && /Iran/.test(a.title), JSON.stringify(a));
    assert(!(await notes()).length, 'notification sent by default');
    await shot(popup, '02a-default-no-warning');
    net.indep = IR;
    await waitFor(async () => !(await storage(['routeDivergence'])).routeDivergence, 15_000, 'internal divergence to clear');
  });
  await check('Opt-in warning: ipify routed abroad — popup never flips, warning appears', async () => {
    await settings({ warnRouteDivergence: true });
    net.indep = AZ;
    const tw = Date.now();
    global.lastTiming = '';
    const watch = setInterval(async () => {
      const st = await storage(['routeState', 'routeDivergence']).catch(() => ({}));
      global.lastTiming += ` ${((Date.now() - tw) / 1000).toFixed(0)}s:${(st.routeState?.lastPairKeys || []).length}/${st.routeDivergence ? 'div' : '-'}`;
    }, 2_000);
    setTimeout(() => clearInterval(watch), 40_000);
    const seen = new Set();
    const end = Date.now() + 22_000; // a split must persist 15 s before it is reported
    while (Date.now() < end) { const s = await popupState(popup); seen.add(s.ip); await sleep(300); }
    assert(!seen.has(AZ) && seen.has(IR), `IPs shown while popup open: ${[...seen]}`);
    // A split must persist 15 s before it is reported; allow for 3-6 s probe spacing.
    const s = await waitFor(async () => { const x = await popupState(popup); return x.alert && x; }, 20_000, 'warning card');
    assert(s.alert && s.alertRows.length === 2 && /Cloudflare.*46\.100\.233\.74.*Iran/.test(s.alertRows[0]) && /ipify.*31\.171\.101\.166.*Azerbaijan/.test(s.alertRows[1]), JSON.stringify(s.alertRows));
    await shot(popup, '02-split-routing');
  });
  await check('Reopening the popup five times never shows the proxied IP', async () => {
    for (let i = 0; i < 5; i++) {
      await popup.close(); popup = await openPopup();
      for (let k = 0; k < 6; k++) { const s = await popupState(popup); assert(s.ip !== AZ, `open #${i + 1} showed ${s.ip}`); await sleep(250); }
    }
  });
  await check('Toolbar and notification report the split once, with no false "IP changed"', async () => {
    const a = await action();
    assert(/Sites see different IPs/.test(a.title) && /31\.171\.101\.166 \(AZ\)/.test(a.title) && a.badge === '!', JSON.stringify(a));
    const n = await notes();
    assert(n.filter(x => /different IPs/.test(x.title)).length === 1, JSON.stringify(n));
    assert(!n.some(x => /IP Changed/.test(x.title)), 'unexpected IP-change notification: ' + JSON.stringify(n));
  });
  await check('Split routing ends: warning clears on the next check', async () => {
    net.indep = IR;
    await waitFor(async () => !(await popupState(popup)).alert, 10_000, 'alert to clear');
    const a = await waitFor(async () => { const x = await action(); return !/different/.test(x.title) && x; }, 5_000, 'toolbar to clear');
    assert(a.badge === '', JSON.stringify(a));
  });

  await check('Real IP change (VPN connects): popup updates within seconds, one notification', async () => {
    const before = (await notes()).length;
    net.edge = DE; net.loc = 'DE'; net.indep = DE;
    const t0 = Date.now();
    await waitFor(async () => (await popupState(popup)).country === 'Germany', 12_000, 'Germany in popup');
    await waitFor(async () => { const x = await welcomeState(welcome); return x.country === 'Germany' && x.ip === DE; }, 5_000, 'Germany live in welcome');
    const dt = Date.now() - t0;
    await sleep(4_000);
    const n = (await notes()).slice(before);
    assert(n.length === 1 && /IP Changed/.test(n[0].title) && /46\.100\.233\.74 to 203\.0\.113\.44/.test(n[0].message), JSON.stringify(n));
    console.log(`      detected in ${(dt / 1000).toFixed(1)} s`);
    await shot(popup, '03-changed-germany');
  });
  await check('Staggered switch (edge first, ipify later): exactly one notification, correct "from"', async () => {
    const before = (await notes()).length;
    net.edge = NL; net.loc = 'NL'; // ipify still sees DE for a while
    await waitFor(async () => (await popupState(popup)).country === 'Netherlands', 12_000, 'Netherlands');
    await sleep(4_000);
    assert((await notes()).length === before, 'notified before the switch completed');
    net.indep = NL;
    await waitFor(async () => (await notes()).length > before, 12_000, 'deferred notification');
    await sleep(4_000);
    const n = (await notes()).slice(before);
    assert(n.length === 1 && /203\.0\.113\.44 to 203\.0\.113\.60/.test(n[0].message), JSON.stringify(n));
  });

  await check('Cloudflare unreachable, new independent answer: held as "Verifying" before accepting', async () => {
    net.down.add('cloudflare.com'); net.down.add('ipv4.icanhazip.com');
    net.indep = C_IP;
    const r1 = await probe();
    const st = await storage(['latestV4Info', 'v4Unverified']);
    assert(st.latestV4Info.ip === NL && st.v4Unverified === true, `after 1st: ${JSON.stringify(st)}`);
    await waitFor(async () => (await popupState(popup)).status === 'Verifying IPv4…' || (await popupState(popup)).ip === C_IP, 6_000, 'verifying or accepted');
    await probe();
    const st2 = await storage(['latestV4Info', 'v4Unverified']);
    assert(st2.latestV4Info.ip === C_IP && st2.v4Unverified === false, `after 2nd: ${JSON.stringify(st2)}`);
    net.down.clear(); net.edge = C_IP; net.loc = 'FR';
    await probe();
  });

  await check('Geolocation that never answers: no permanent "Locating..."', async () => {
    net.hang.add('ipwho.is');
    net.edge = PSIP; net.loc = ''; net.indep = PSIP; // no country from Cloudflare either
    await probe();
    const s = await waitFor(async () => { const x = await popupState(popup); return x.ip === PSIP && x.country !== 'Locating...' && x; }, 40_000, 'placeholder to resolve');
    assert(s.country === 'Unknown Country', JSON.stringify(s));
    net.hang.clear();
  });
  await check('Your network: every geolocation service filtered — popup shows the country Cloudflare reports', async () => {
    ['ipwho.is', 'get.geojs.io', 'ipinfo.io'].forEach(h => net.hang.add(h));
    net.edge = IR; net.loc = 'IR'; net.indep = IR;
    await probe();
    const s = await waitFor(async () => { const x = await popupState(popup); return x.ip === IR && x.country !== 'Locating...' && x; }, 30_000, 'country');
    assert(s.country === 'Iran' && /flag-ir\.png$/.test(s.flag), JSON.stringify(s));
    await shot(popup, '04a-geo-filtered');
    net.hang.clear();
    net.edge = PSIP; net.loc = ''; net.indep = PSIP;
    await probe();
  });
  await check('A leftover placeholder (interrupted check) resolves on the next check; PS shows as Palestine', async () => {
    await bg(ip => chrome.storage.local.set({ latestV4Info: { ip, country: 'Locating...', countryCode: '', pending: true, isp: 'N/A', asn: 'N/A', updatedAt: Date.now(), vantage: 'edge' } }), PSIP);
    await probe();
    await waitFor(async () => (await popupState(popup)).country === 'Palestine', 15_000, 'Palestine');
    await waitFor(async () => (await welcomeState(welcome)).country === 'Palestine', 5_000, 'Palestine in welcome');
    await shot(popup, '04-palestine');
  });

  await check('All providers down: "Unable to verify network" and ERR badge; recovery restores', async () => {
    HOSTS.forEach(h => net.down.add(h));
    await probe();
    await waitFor(async () => (await popupState(popup)).status === 'Unable to verify network', 8_000, 'error status');
    assert((await welcomeState(welcome)).country === 'Unable to verify network', 'welcome showed a stale country during outage');
    const a = await action();
    assert(a.badge === 'ERR' && /Unable to verify/.test(a.title), JSON.stringify(a));
    await shot(popup, '05-outage');
    net.down.clear();
    await waitFor(async () => (await popupState(popup)).status === 'Live Monitor', 12_000, 'recovery');
    assert((await action()).badge === '', 'badge after recovery');
  });

  await check('IPv6 present in another country: IPv6 card and Split Route pill', async () => {
    net.edge = DE; net.loc = 'DE'; net.indep = DE; net.v6 = US6;
    const t6 = Date.now(), firsts = {};
    const s = await waitFor(async () => {
      const x = await popupState(popup), st = await storage(['latestV6Info']);
      const mark = (k, v) => { if (v && !firsts[k]) firsts[k] = ((Date.now() - t6) / 1000).toFixed(1); };
      mark('storedV6', st.latestV6Info?.ip === US6); mark('storedV6Country', st.latestV6Info?.countryCode === 'US');
      mark('popupGermany', x.country === 'Germany'); mark('popupV6', x.v6 === US6); mark('popupSplit', x.split);
      global.lastTiming = JSON.stringify(firsts);
      return x.v6 === US6 && x.country === 'Germany' && x.split && x;
    }, 30_000, 'IPv6 card');
    console.log(`      timing (s): ${global.lastTiming}`);
    await waitFor(async () => /Split Route/.test((await action()).title), 10_000, 'Split Route in toolbar title');
    await waitFor(async () => (await welcomeState(welcome)).v6 === US6, 5_000, 'IPv6 in welcome');
    await shot(popup, '06-ipv6-split');
    net.v6 = null;
    await waitFor(async () => !(await popupState(popup)).v6, 30_000, 'IPv6 card to go');
  });

  await check('Settings page: badge modes change the toolbar; notifications switch is honoured', async () => {
    const opt = await context.newPage();
    opt.on('pageerror', e => errors.push(`options: ${e.message}`));
    await opt.goto(`chrome-extension://${id}/options/options.html`);
    await opt.check('input[name="badgeMode"][value="text"]', { force: true });
    await waitFor(async () => (await action()).badge === 'DE', 8_000, 'DE text badge');
    await opt.check('input[name="badgeMode"][value="off"]', { force: true });
    await waitFor(async () => { const a = await action(); return a.badge === '' && /Location: Germany/.test(a.title); }, 8_000, 'off mode');
    await opt.check('input[name="badgeMode"][value="flag"]', { force: true });
    await waitFor(async () => /Location: Germany/.test((await action()).title), 8_000, 'flag mode');
    await shot(opt, '07-options');
    await opt.uncheck('#setNotifications', { force: true });
    await waitFor(async () => (await storage(['appSettings'])).appSettings?.enableNotifications === false, 5_000, 'setting saved');
    const before = (await notes()).length;
    net.edge = NL; net.loc = 'NL'; net.indep = NL;
    await waitFor(async () => (await popupState(popup)).country === 'Netherlands', 12_000, 'change');
    await sleep(3_000);
    assert((await notes()).length === before, 'notified although notifications are off');
    await opt.check('#setNotifications', { force: true });
    await opt.close();
  });

  await check('Armor: WebRTC policy is applied by this extension and the shield toggles it', async () => {
    const pol = () => bg(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
    const p1 = await waitFor(async () => { const p = await pol(); return p.value === 'disable_non_proxied_udp' && p; }, 8_000, 'policy');
    assert(p1.levelOfControl === 'controlled_by_this_extension', JSON.stringify(p1));
    await waitFor(async () => (await popupState(popup)).webrtc === 'Policy Active', 8_000, 'Policy Active');
    await popup.click('#shieldToggleBtn');
    await waitFor(async () => (await pol()).value === 'default' && (await popupState(popup)).armor === 'OFF', 8_000, 'armor off');
    await shot(popup, '08-armor-off');
    await popup.click('#shieldToggleBtn');
    await waitFor(async () => (await pol()).value === 'disable_non_proxied_udp' && (await popupState(popup)).armor === 'ON', 8_000, 'armor on');
  });

  await check('Fast detection: connects to the LeakHalo server from the extension origin', async () => {
    await waitFor(() => net.sockets.size > 0, 15_000, 'WebSocket connection');
    assert(net.wsOrigins.every(o => o === `chrome-extension://${id}`), JSON.stringify(net.wsOrigins));
  });
  await check('Fast detection: popup closed, alarm off — a network change updates the toolbar in seconds', async () => {
    await popup.close();
    await bg(() => chrome.alarms.clearAll());
    await sleep(1_000);
    net.edge = C_IP; net.loc = 'FR'; net.indep = C_IP; net.serverIp = null;
    const t0 = Date.now();
    dropSockets(); // a real network change breaks the old connection
    const a = await waitFor(async () => { const x = await action(); return /France/.test(x.title) && x; }, 15_000, 'toolbar to show France');
    console.log(`      toolbar updated ${((Date.now() - t0) / 1000).toFixed(1)} s after the change (alarm disabled)`);
  });
  await check('Fast detection: a change on a still-open connection is caught by the ping', async () => {
    await waitFor(() => net.sockets.size > 0, 15_000, 'reconnection');
    await sleep(1_000);
    net.edge = DE; net.loc = 'DE'; net.indep = DE; // server keeps the socket; pong reports the new IP
    const t0 = Date.now();
    await waitFor(async () => /Germany/.test((await action()).title), 20_000, 'toolbar to show Germany');
    console.log(`      noticed ${((Date.now() - t0) / 1000).toFixed(1)} s after the change (ping every 10 s)`);
  });
  await check('Fast detection: the Settings switch disconnects and reconnects', async () => {
    await settings({ enableFastDetection: false });
    await waitFor(() => net.sockets.size === 0, 8_000, 'disconnect');
    await sleep(4_000);
    assert(net.sockets.size === 0, 'reconnected while disabled');
    await settings({ enableFastDetection: true });
    await waitFor(() => net.sockets.size > 0, 15_000, 'reconnect');
  });
  await check('Fast detection: plain ws:// fallback works from the extension', async () => {
    const plain = require('node:http').createServer();
    attachWebSocket(plain);
    await new Promise(r => plain.listen(0, '127.0.0.1', r));
    const before = net.wsOrigins.length;
    await bg(url => chrome.storage.local.set({ devFastChannelUrls: [url] }), `ws://127.0.0.1:${plain.address().port}/v1/ws`);
    dropSockets();
    await waitFor(() => net.wsOrigins.length > before, 15_000, 'plain ws connection');
    await bg(() => chrome.storage.local.remove('devFastChannelUrls'));
    dropSockets();
    plain.close();
    await bg(() => { ensureAlarm(); });
  });
  popup = await openPopup();

  await check('Request volume while the popup is open stays bounded', async () => {
    const t0 = Date.now(); await sleep(15_000);
    const recent = net.log.filter(r => r.t >= t0);
    const perMin = h => Math.round(recent.filter(r => r.host === h).length * 60_000 / (Date.now() - t0));
    const rates = Object.fromEntries(['cloudflare.com', 'api.ipify.org', 'api6.ipify.org', 'ipwho.is'].map(h => [h, perMin(h)]));
    console.log(`      requests/min: ${JSON.stringify(rates)}`);
    assert(rates['cloudflare.com'] <= 25 && rates['api.ipify.org'] <= 25 && rates['ipwho.is'] <= 2, JSON.stringify(rates));
  });

  await check('No console/page errors or external page requests from welcome; no JavaScript errors elsewhere', async () => {
    assert(!welcomeErrors.length, welcomeErrors.join('\n'));
    assert(!welcomeRequests.some(url => !url.startsWith(`chrome-extension://${id}/`)), 'external request from welcome');
    const real = errors.filter(e => !/net::ERR_|Failed to load resource|status of 503/.test(e));
    assert(!real.length, real.join('\n'));
  });

  await popup.close();
  await welcome.close();
  await context.close();
  server.close();

  if (process.argv.includes('--live')) {
    console.log('\nLive run against the real providers\n');
    const live = await launch({ mocked: false });
    const lbg = (fn, arg) => live.sw.evaluate(fn, arg);
    await check('Live: real providers answer and the popup shows a located public IP', async () => {
      const s = await waitFor(async () => { const r = await lbg(() => chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'routeDivergence', 'probeError'])); return (r.latestV4Info?.countryCode || r.latestV6Info?.countryCode) && r; }, 45_000, 'live result');
      const page = await live.context.newPage();
      await page.goto(`chrome-extension://${live.id}/popup/popup.html`);
      await page.waitForSelector('#content', { state: 'visible', timeout: 15_000 });
      await sleep(4_000);
      await page.screenshot({ path: path.join(OUT, '09-live.png'), fullPage: true });
      console.log(`      live: IPv4 ${s.latestV4Info?.ip || '-'} (${s.latestV4Info?.country || '-'}, ${s.latestV4Info?.isp || '-'}), IPv6 ${s.latestV6Info?.ip || 'none'}, divergence ${s.routeDivergence ? 'yes' : 'no'}`);
      assert(!s.probeError, 'probe error on live network');
    });
    await live.context.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${path.relative(ROOT, OUT)}/`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
