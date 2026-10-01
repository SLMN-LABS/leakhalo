const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err });
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err });
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
  }
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('🚀 LEAKHALO EXTENSION COMPREHENSIVE TEST SUITE');
  console.log('========================================\n');

  console.log('📦 [1/6] Manifest V3 & File Integrity Tests:');
  const manifestPath = path.join(ROOT, 'manifest.json');
  let manifest;

  test('manifest.json exists and is valid JSON', () => {
    assert(fs.existsSync(manifestPath), 'manifest.json does not exist');
    const content = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(content);
    assert(manifest && typeof manifest === 'object');
  });

  test('manifest_version is exactly 3', () => {
    assert.strictEqual(manifest.manifest_version, 3);
  });

  test('Manifest required identity fields exist', () => {
    assert(manifest.name && manifest.name.length > 0);
    assert(manifest.version && /^\d+\.\d+\.\d+/.test(manifest.version));
    assert(manifest.description && manifest.description.length > 0);
  });

  test('Service worker file exists on disk', () => {
    assert(manifest.background && manifest.background.service_worker);
    const swPath = path.join(ROOT, manifest.background.service_worker);
    assert(fs.existsSync(swPath), `Service worker file ${swPath} not found`);
  });

  test('No page-wide content script permissions are requested', () => {
    assert(!manifest.content_scripts, 'Page injection is not needed for the browser privacy API');
  });

  test('Action popup and options files exist on disk', () => {
    assert(manifest.action && manifest.action.default_popup);
    assert(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
    assert(manifest.options_ui && manifest.options_ui.page);
    assert(fs.existsSync(path.join(ROOT, manifest.options_ui.page)));
  });

  test('All declared icons exist on disk and are non-empty', () => {
    const iconDicts = [manifest.icons, manifest.action.default_icon];
    for (const d of iconDicts) {
      assert(d && typeof d === 'object');
      for (const size of ['16', '48', '128']) {
        if (d[size]) {
          const p = path.join(ROOT, d[size]);
          assert(fs.existsSync(p), `Icon ${p} does not exist`);
          const stat = fs.statSync(p);
          assert(stat.size > 0, `Icon ${p} is empty`);
        }
      }
    }
  });

  test('Host permissions do NOT include <all_urls> and use HTTPS', () => {
    assert(Array.isArray(manifest.host_permissions));
    assert(!manifest.host_permissions.includes('<all_urls>'), 'host_permissions must not contain broad <all_urls>');
    for (const hp of manifest.host_permissions) {
      assert(hp.startsWith('https://'), `Host permission ${hp} must use secure HTTPS`);
    }
  });

  test('Permissions do not include unused activeTab or tabs', () => {
    assert(Array.isArray(manifest.permissions));
    assert(!manifest.permissions.includes('activeTab'), 'unused activeTab should be removed');
  });

  test('Manifest includes primary geo provider get.geojs.io', () => {
    assert(manifest.host_permissions.includes('https://get.geojs.io/*'), 'manifest must include get.geojs.io');
  });

  test('Popup does not load the retired WebRTC interceptor', () => {
    const popup = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
    assert(!popup.includes('webrtc-shield.js'));
  });

  console.log('\n⚙️ [3/6] Background Service Worker Unit & Logic Tests:');
  const bgCode = fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8');

  console.log('\n👋 First-install Welcome Page Tests:');
  const welcomeFiles = ['welcome/welcome.html', 'welcome/welcome.css', 'welcome/welcome.js'];
  test('Welcome files exist and total less than 60 KB', () => {
    let bytes = 0;
    for (const file of welcomeFiles) {
      assert(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
      bytes += fs.statSync(path.join(ROOT, file)).size;
    }
    assert(bytes < 60 * 1024, `Welcome files total ${bytes} bytes`);
  });
  const welcomeHtml = fs.readFileSync(path.join(ROOT, welcomeFiles[0]), 'utf8');
  const welcomeCss = fs.readFileSync(path.join(ROOT, welcomeFiles[1]), 'utf8');
  const welcomeJs = fs.readFileSync(path.join(ROOT, welcomeFiles[2]), 'utf8');
  test('Welcome page uses local styles, a deferred script and the extension favicon', () => {
    assert(welcomeHtml.includes('<title>Welcome to LeakHalo</title>'));
    assert(welcomeHtml.includes('href="welcome.css"'));
    assert(welcomeHtml.includes('<script src="welcome.js" defer></script>'));
    assert(welcomeHtml.includes('href="../assets/icons/icon16.png"'));
    for (const match of welcomeHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (match[1].startsWith('#')) continue;
      assert(fs.existsSync(path.resolve(ROOT, 'welcome', match[1])), `Missing local resource: ${match[1]}`);
    }
  });
  test('Welcome page has no remote URLs, network clients, inline scripts or handlers', () => {
    for (const src of [welcomeHtml, welcomeCss, welcomeJs]) {
      assert(!/(?:https?:|wss?:)\/\/|(?:src|href)\s*=\s*["']\/\//i.test(src), 'Welcome must use only local resources');
    }
    assert(!/<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S/i.test(welcomeHtml), 'Inline script found');
    assert(!/\son[a-z]+\s*=/i.test(welcomeHtml), 'Inline event handler found');
    assert(!/\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest|EventSource)\b|sendBeacon\s*\(/.test(welcomeJs), 'Page must not contact the network directly');
    assert(!/@import|@font-face/.test(welcomeCss), 'Welcome must use system fonts');
  });
  test('Onboarding adds no permissions or web-accessible resources', () => {
    assert.deepStrictEqual(manifest.permissions, ['storage', 'alarms', 'notifications', 'privacy']);
    assert.deepStrictEqual(manifest.host_permissions, [
      'https://api.ipify.org/*', 'https://api6.ipify.org/*', 'https://cloudflare.com/*',
      'https://*.icanhazip.com/*', 'https://checkip.amazonaws.com/*', 'https://ipwho.is/*',
      'https://get.geojs.io/*', 'https://ipinfo.io/*'
    ]);
    assert(!manifest.web_accessible_resources);
  });
  test('Background opens the welcome page only from the first-install guard', () => {
    assert(bgCode.includes('chrome.runtime.onInstalled.addListener((details) => {'));
    assert(/if \(details\??\.reason === 'install'\) \{\s*chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\('welcome\/welcome\.html'\) \}\)(\.catch\(\(\) => \{\}\))?;\s*\}/.test(bgCode));
    assert.strictEqual((bgCode.match(/welcome\/welcome.html/g) || []).length, 1);
  });
  test('Welcome uses accessible switches, live status, dark mode and reduced motion', () => {
    assert.strictEqual((welcomeHtml.match(/role="switch"/g) || []).length, 3);
    assert(welcomeHtml.includes('id="connectionCard"') && welcomeHtml.includes('aria-live="polite"'));
    for (const id of ['setNotifications', 'setFastDetection', 'setAntiLeakShield']) {
      assert(welcomeHtml.includes(`for="${id}"`));
    }
    assert(welcomeCss.includes('prefers-color-scheme: dark'));
    assert(welcomeCss.includes('prefers-reduced-motion: reduce'));
    assert(welcomeCss.includes(':focus-visible'));
    for (const match of welcomeJs.matchAll(/(?:byId|getElementById)\('([^']+)'\)/g)) {
      assert(welcomeHtml.includes(`id="${match[1]}"`), `Missing welcome element: ${match[1]}`);
    }
    let depth = 0;
    for (const c of welcomeCss) { if (c === '{') depth++; if (c === '}') depth--; assert(depth >= 0); }
    assert.strictEqual(depth, 0, 'Welcome CSS braces must balance');
  });
  test('Welcome uses the popup country rules and both local flag fallbacks', () => {
    assert(welcomeJs.includes("shortNames = { PS: 'Palestine' }"));
    assert(welcomeJs.includes("Intl.DisplayNames(['en'], { type: 'region' })"));
    assert(welcomeJs.includes('/assets/flags-rect/flag-${code}.png'));
    assert(welcomeJs.includes('/assets/flags/flag-${code}.png'));
    assert(welcomeJs.includes("this.src = '/assets/icons/icon48.png'"));
  });

  test('background.js must NOT contain setInterval', () => {
    assert(!bgCode.includes('setInterval('), 'setInterval must be completely eliminated in MV3');
  });

  test('Two-tier Cloudflare trace parsing logic', () => {
    const mockTraceText = `fl=31f49
h=cloudflare.com
ip=185.190.140.22
ts=1727392800.123
visit_scheme=https
uag=Mozilla/5.0
colo=FRA
sliver=none
http=http/2
loc=DE
tls=TLSv1.3
sni=plaintext
warp=off
gateway=off
rbi=off
kex=X25519
`;
    const ipMatch = mockTraceText.match(/ip=([^\n]+)/);
    const locMatch = mockTraceText.match(/loc=([^\n]+)/);
    assert(ipMatch && ipMatch[1].trim() === '185.190.140.22');
    assert(locMatch && locMatch[1].trim() === 'DE');
  });

  test('Split Routing preservation: Background does not wipe IPv4 on different IPv6 country', () => {
    assert(!bgCode.includes('cached.latestV4Info.countryCode !== v6Info.countryCode'), 'Split routing self-destruction code must be removed');
    assert(!bgCode.includes('cached.latestV6Info.countryCode !== v4Info.countryCode'), 'Split routing self-destruction code must be removed');
  });

  test('Connection classification handles known types and leaves uncertain networks unknown', () => {
    function classifyConnectionType(data) {
      const isp = (data.isp || '').toLowerCase();
      const org = (data.org || '').toLowerCase();
      const rawType = (data.type || '').toLowerCase();

      if (data.isVpn || data.isProxy || rawType === 'vpn' || rawType === 'proxy') return 'VPN / Relay';
      if (data.isHosting || rawType === 'hosting' || rawType === 'datacenter') return 'Datacenter';
      if (data.isMobile || rawType === 'cellular' || rawType === 'mobile') return 'Mobile';

      const datacenterKeywords = [
        'hetzner', 'ovh', 'digitalocean', 'amazon', 'aws', 'google cloud', 'linode',
        'vultr', 'm247', 'leaseweb', 'choopa', 'oracle', 'cloudflare', 'fastly',
        'serverius', 'contabo', 'hostinger', 'tencent', 'alibaba', 'azure', 'akamai'
      ];
      for (const kw of datacenterKeywords) {
        if (isp.includes(kw) || org.includes(kw)) return 'Datacenter';
      }
      return 'Unknown';
    }

    assert.strictEqual(classifyConnectionType({ isVpn: true }), 'VPN / Relay');
    assert.strictEqual(classifyConnectionType({ isHosting: true }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ isp: 'Cloudflare, Inc.' }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ isp: 'Hetzner Online GmbH' }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ type: 'mobile' }), 'Mobile');
    assert.strictEqual(classifyConnectionType({ isp: 'Comcast Cable' }), 'Unknown');
  });

  test('Full country name resolver uses Intl and fallbacks', () => {
    function getFullCountryName(code, fallbackName) {
      if (code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
        try {
          const dn = new Intl.DisplayNames(['en'], { type: 'region' });
          const name = dn.of(code.toUpperCase());
          if (name && name !== code.toUpperCase()) return name;
        } catch (e) {}
      }
      const cleanFallback = (fallbackName && !fallbackName.startsWith('Unknown') && !fallbackName.startsWith('Detected')) ? fallbackName : '';
      if (cleanFallback && cleanFallback.length > 2) {
        return cleanFallback;
      }
      return code || cleanFallback || 'Unknown Country';
    }

    assert.strictEqual(getFullCountryName('DE', 'Germany'), 'Germany');
    assert.strictEqual(getFullCountryName('US', ''), 'United States');
    assert.strictEqual(getFullCountryName('FR', ''), 'France');
    assert.strictEqual(getFullCountryName('XYZ', ''), 'XYZ');
    assert.strictEqual(getFullCountryName('PL', 'Detected'), 'Poland');
    assert.strictEqual(getFullCountryName('', 'Detected'), 'Unknown Country');
    assert.strictEqual(getFullCountryName('', ''), 'Unknown Country');
    assert(!bgCode.includes("getFullCountryName(resolvedCode, 'Detected')"), 'Background must not pass Detected fallback');
  });

  test('Offline state sets isOffline: true without wiping latestV4Info or latestV6Info', () => {
    assert(!bgCode.includes('latestV4Info: null,\n      latestV6Info: null'), 'Offline handler must preserve cached snapshot');
  });

  test('Privacy shield uses clear({}) when inactive', () => {
    assert(bgCode.includes('chrome.privacy.network.webRTCIPHandlingPolicy.clear({})'), 'Must clear webRTC policy on disable');
    assert(bgCode.includes('chrome.privacy.network.networkPredictionEnabled.clear({})'), 'Must clear network prediction policy on disable');
  });

  console.log('\n🖥️ [4/6] Popup Controller & HTML DOM Tests:');
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');

  test('popup.html contains all critical interactive element IDs', () => {
    const requiredIds = [
      'loader', 'content', 'settingsToggleBtn', 'shieldToggleBtn', 'refreshBtn',
      'splitBadge', 'lastUpdatedTime', 'v4Country', 'v4TypeTag', 'v4FlagImg',
      'v4Watermark', 'v4Ip', 'v4IpRow', 'v4CopyStatus', 'v4CityRegion', 'v4Isp',
      'v4MapBtn', 'v4IspRow', 'v6ActiveCard', 'v6InactivePill', 'v6Country',
      'v6TypeTag', 'v6FlagImg', 'v6Watermark', 'v6Ip', 'v6IpRow', 'v6CopyStatus',
      'v6CityRegion', 'v6Isp', 'v6MapBtn', 'v6IspRow', 'securityBar',
      'shieldStatusPill', 'shieldDot', 'shieldStatusText', 'webrtcItem',
      'webrtcDot', 'webrtcStatus'
    ];
    for (const id of requiredIds) {
      assert(popupHtml.includes(`id="${id}"`), `popup.html missing element id="${id}"`);
    }
  });

  test('popup.js queries only existing IDs (no dead element queries)', () => {
    const deadIds = ['v4Asn', 'v4Timezone', 'v4AsnRow', 'v4TimezoneRow', 'v6Asn', 'v6Timezone', 'v6AsnRow', 'v6TimezoneRow'];
    for (const id of deadIds) {
      assert(!popupJs.includes(`document.getElementById('${id}')`), `popup.js contains dead query for id="${id}"`);
    }
  });

  test('Popup does not contain generic Detected string fallbacks', () => {
    assert(!popupJs.includes("'Location detected'"), 'Popup must not fallback to Location detected');
    assert(!popupJs.includes("'Detected Country'"), 'Popup must not fallback to Detected Country');
  });

  test('Bogon & Private IP validator classifies IPs correctly', () => {
    function isPrivateOrBogonIP(ip) {
      if (!ip || typeof ip !== 'string') return true;
      const s = ip.trim().toLowerCase();
      if (!s || s === '0.0.0.0' || s === '::' || s === '::1') return true;
      if (s.endsWith('.local') || s.endsWith('.arpa') || s.includes('.local')) return true;
      if (s.startsWith('10.') || s.startsWith('192.168.') || s.startsWith('127.') || s.startsWith('169.254.')) return true;
      if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(s)) return true;
      if (s.startsWith('fc00:') || s.startsWith('fd00:') || s.startsWith('fe80:') || s.startsWith('ff00:')) return true;

      const v4Parts = s.split('.');
      if (v4Parts.length === 4) {
        const valid = v4Parts.every(p => {
          const n = parseInt(p, 10);
          return !isNaN(n) && n >= 0 && n <= 255 && p === String(n);
        });
        if (valid) {
          const o0 = parseInt(v4Parts[0], 10);
          const o1 = parseInt(v4Parts[1], 10);
          if (o0 === 10 || o0 === 127 || o0 === 0) return true;
          if (o0 === 192 && o1 === 168) return true;
          if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
          if (o0 === 169 && o1 === 254) return true;
          if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;
          if (o0 >= 224) return true;
          return false;
        }
      }

      if (s.includes(':') && /^[0-9a-f:]+$/i.test(s)) {
        if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff') || s === '::1') return true;
        return false;
      }
      return true;
    }

    assert.strictEqual(isPrivateOrBogonIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('10.0.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('172.16.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('100.64.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateOrBogonIP('1.1.1.1'), false);
    assert.strictEqual(isPrivateOrBogonIP('185.190.140.22'), false);
    assert.strictEqual(isPrivateOrBogonIP('fe80::1'), true);
    assert.strictEqual(isPrivateOrBogonIP('2606:4700:4700::1111'), false);
  });

  test('formatIspAsn formats combinations cleanly', () => {
    function formatIspAsn(rawIsp, rawAsn) {
      let isp = (rawIsp || '').trim();
      let asn = (rawAsn || '').trim();
      if (isp === 'N/A') isp = '';
      if (asn === 'N/A') asn = '';

      let detectedAsn = asn;
      const asMatch = isp.match(/\bAS(\d+)\b/i) || asn.match(/\bAS(\d+)\b/i);
      if (asMatch) {
        detectedAsn = `AS${asMatch[1]}`;
      }

      let cleanIsp = isp
        .replace(/^AS\d+\s*[-_:]*\s*/i, '')
        .replace(/\s*\(?AS\d+\)?\s*$/i, '')
        .replace(/\s*\(?AS\d+\)?/gi, '')
        .trim();

      if (!cleanIsp && detectedAsn) return detectedAsn;
      if (cleanIsp && detectedAsn) return `${cleanIsp} (${detectedAsn})`;
      if (cleanIsp) return cleanIsp;
      return '';
    }

    assert.strictEqual(formatIspAsn('Cloudflare, Inc.', 'AS13335'), 'Cloudflare, Inc. (AS13335)');
    assert.strictEqual(formatIspAsn('AS13335 Cloudflare, Inc.', 'N/A'), 'Cloudflare, Inc. (AS13335)');
    assert.strictEqual(formatIspAsn('N/A', 'AS60068'), 'AS60068');
    assert.strictEqual(formatIspAsn('N/A', 'N/A'), '');
  });

  test('Flag image error handler sets onerror = null and uses local fallback', () => {
    assert(popupJs.includes('this.onerror = null;'), 'Must set onerror = null to prevent infinite loops');
    assert(!popupJs.includes('cdn.ipwhois.io'), 'Must not fetch remote CDN images');
  });

  console.log('\n⚙️ [5/6] Options Controller & Settings Dashboard Tests:');
  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');

  test('options.html contains matching section IDs for all nav links', () => {
    const requiredSections = ['general', 'badge', 'notifications', 'about'];
    for (const s of requiredSections) {
      assert(optionsHtml.includes(`id="${s}"`), `options.html missing section id="${s}"`);
      assert(optionsHtml.includes(`href="#${s}"`), `options.html missing nav link href="#${s}"`);
    }
  });

  test('options.js binds smooth navigation and tracks manual scrolling', () => {
    assert(optionsJs.includes('scrollIntoView'), 'options.js must implement smooth navigation scrolling');
    assert(optionsJs.includes('updateActiveNavFromScroll'), 'options.js must update navigation as the page scrolls');
    assert(optionsJs.includes("classList.toggle('active'"), 'options.js must manage the active navigation item');
  });

  test('options.html setting controls all exist in options.js', () => {
    const controlIds = [
      'saveToast', 'setNotifications', 'setAutoRefresh', 'setShowMap',
      'setAntiLeakShield', 'setAntiLeakPolicy', 'setDnsPrefetchBlock', 'setWebRtcScan'
    ];
    for (const id of controlIds) {
      assert(optionsHtml.includes(`id="${id}"`), `options.html missing control id="${id}"`);
      assert(optionsJs.includes(`getElementById('${id}')`), `options.js missing listener for id="${id}"`);
    }
  });

  console.log('\n🎨 [6/6] Assets & National Flags Validation:');

  test('All 244 ISO country flag PNG assets are valid files', () => {
    const flagsDir = path.join(ROOT, 'assets/flags');
    assert(fs.existsSync(flagsDir), 'assets/flags directory must exist');
    const files = fs.readdirSync(flagsDir);
    assert(files.length >= 240, `Expected at least 240 flags, found ${files.length}`);

    const keyCountries = ['us', 'de', 'fr', 'gb', 'nl', 'ca', 'au', 'jp', 'ir', 'tr', 'ru', 'br', 'in'];
    for (const code of keyCountries) {
      const flagFile = path.join(flagsDir, `flag-${code}.png`);
      assert(fs.existsSync(flagFile), `Essential flag ${flagFile} is missing`);
      const stat = fs.statSync(flagFile);
      assert(stat.size > 50, `Flag file ${flagFile} is unexpectedly small (${stat.size} bytes)`);
    }
  });

  test('Popup uses sharp rectangular flags with a square fallback for every country', () => {
    const rectDir = path.join(ROOT, 'assets/flags-rect');
    assert(fs.existsSync(path.join(rectDir, 'LICENSE-flag-icons.md')), 'flags-rect license notice missing');
    const squares = fs.readdirSync(path.join(ROOT, 'assets/flags')).filter(f => /^flag-[a-z]{2}\.png$/.test(f));
    const noRectSource = ['flag-an.png'];
    for (const f of squares) {
      if (noRectSource.includes(f)) continue;
      const file = path.join(rectDir, f);
      assert(fs.existsSync(file), `Rectangular popup flag ${f} is missing`);
      const png = fs.readFileSync(file);
      assert(png.readUInt32BE(16) === 96 && png.readUInt32BE(20) === 72, `${f} must be 96x72 (got ${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`);
    }
    const popupJs = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
    assert(popupJs.includes('/assets/flags-rect/flag-${code}.png'), 'popup must load rectangular flags');
    assert(popupJs.includes('/assets/flags/flag-${code}.png'), 'popup must fall back to the square flag');
  });

  test('Country code PS is labelled "Palestine" in popup and notifications', () => {
    for (const file of ['popup/popup.js', 'background/background.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert(/shortNames = \{ PS: 'Palestine' \}/.test(src), `${file} must map PS to "Palestine"`);
    }
  });

  test('Extension icons are valid PNG files of exact required sizes', () => {
    const iconsDir = path.join(ROOT, 'assets/icons');
    for (const size of ['16', '48', '128']) {
      const iconPath = path.join(iconsDir, `icon${size}.png`);
      assert(fs.existsSync(iconPath), `icon${size}.png missing`);
      const stat = fs.statSync(iconPath);
      assert(stat.size > 100, `icon${size}.png is too small`);
    }
  });

  console.log('\n🔍 [7/7] Deep Edge-Case & Architecture Validation:');

  test('popup.css and options.css have balanced braces and no syntax corruption', () => {
    const popupCss = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');
    const optionsCss = fs.readFileSync(path.join(ROOT, 'options/options.css'), 'utf8');

    function checkBraces(css, name) {
      let depth = 0;
      for (let i = 0; i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}') depth--;
        assert(depth >= 0, `Unmatched closing brace in ${name} at index ${i}`);
      }
      assert.strictEqual(depth, 0, `Unmatched opening brace in ${name}`);
    }

    checkBraces(popupCss, 'popup.css');
    checkBraces(optionsCss, 'options.css');
    assert(popupCss.includes('.pulse-dot'), 'popup.css missing .pulse-dot');
    assert(popupCss.includes('.location-link.disabled'), 'popup.css missing .location-link.disabled');
  });

  test('Split Routing state correctly identifies different countries between IPv4 and IPv6', () => {
    function computeSplitRouting(v4, v6) {
      if (!v4 || !v6 || !v4.countryCode || !v6.countryCode) return false;
      return v4.countryCode.toUpperCase() !== v6.countryCode.toUpperCase();
    }

    assert.strictEqual(computeSplitRouting({ countryCode: 'US' }, { countryCode: 'US' }), false);
    assert.strictEqual(computeSplitRouting({ countryCode: 'DE' }, { countryCode: 'US' }), true);
    assert.strictEqual(computeSplitRouting({ countryCode: 'IR' }, null), false);
    assert.strictEqual(computeSplitRouting(null, { countryCode: 'FR' }), false);
  });

  test('Badge generation returns correct 2-letter ISO, OFF, or ERR', () => {
    function getBadgeText(state, settings) {
      if (!settings || !settings.badgeDisplay) return '';
      if (state.isOffline) return 'OFF';
      if (settings.badgeV6 && state.latestV6Info && state.latestV6Info.countryCode) {
        return state.latestV6Info.countryCode.toUpperCase();
      }
      if (state.latestV4Info && state.latestV4Info.countryCode) {
        return state.latestV4Info.countryCode.toUpperCase();
      }
      return '...';
    }

    assert.strictEqual(getBadgeText({ isOffline: true }, { badgeDisplay: true }), 'OFF');
    assert.strictEqual(getBadgeText({ isOffline: false, latestV4Info: { countryCode: 'us' } }, { badgeDisplay: true }), 'US');
    assert.strictEqual(getBadgeText({ isOffline: false, latestV4Info: { countryCode: 'us' }, latestV6Info: { countryCode: 'de' } }, { badgeDisplay: true, badgeV6: true }), 'DE');
    assert.strictEqual(getBadgeText({ isOffline: false, latestV4Info: { countryCode: 'us' } }, { badgeDisplay: false }), '');
  });

  console.log('\n========================================');
  console.log(`📊 TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  if (failedTests > 0) {
    console.log(`❌ ${failedTests} TESTS FAILED:`);
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  } else {
    console.log('🎉 ALL TESTS PASSED WITH 100% SUCCESS!');
    console.log('========================================\n');
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
