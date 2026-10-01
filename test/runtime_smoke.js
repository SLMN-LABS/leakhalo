const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background/background.js'), 'utf8');
const data = {
  latestV4Info: null,
  latestV6Info: { ip: '2001:db8::1', countryCode: 'DE', country: 'Germany' },
  appSettings: { enableNotifications: false }
};
const requests = [];
const event = { addListener() {} };
let installedListener;
const createdTabs = [];
let policy = 'default';
let prediction = true;
let networkMode = 'normal';
let policyChangeListener;
let currentV4 = '198.51.100.22';
let alarmPeriod = 1;
let geoGate = null;
let geoStarted = null;
let notifyGeoStarted = null;
let rateLimitIpify = false;
let ipifyV4 = null; // null = ipify sees the same IP as Cloudflare
let cloudflareDown = false;
let stallBody = null; // () => true makes response bodies hang after headers
let stallIpify = false;
let geoDown = false;
let toolbarGetGate = null;
const toolbar = {};
const PROXIED_V4 = '203.0.113.9';
const notifications = [];

function result(body, ok = true, status = ok ? 200 : 500, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok, status, headers: { get: name => headers[name] || null },
    text: async () => (typeof stallBody === 'function' && stallBody()) ? new Promise(() => {}) : text,
    json: async () => JSON.parse(text), blob: async () => null
  };
}

const chrome = {
  runtime: {
    getURL: name => `chrome-extension://test/${name}`,
    onInstalled: { addListener(listener) { installedListener = listener; } }, onStartup: event, onMessage: event
  },
  tabs: { async create(options) { createdTabs.push(options); } },
  alarms: { get: (_name, callback) => callback({ periodInMinutes: alarmPeriod }), create(_name, info) { alarmPeriod = info.periodInMinutes; }, onAlarm: event },
  storage: { local: {
    get(keys, callback) {
      const names = typeof keys === 'string' ? [keys] : keys;
      const found = Object.fromEntries(names.map(name => [name, data[name]]));
      if (callback) callback(found);
      if (toolbarGetGate && names.includes('routeDivergence')) { const gate = toolbarGetGate; toolbarGetGate = null; return gate.then(() => found); }
      return Promise.resolve(found);
    },
    async set(values) { Object.assign(data, values); }
  } },
  action: {
    setIcon: async (icon) => { toolbar.icon = icon; }, setBadgeText: async ({ text }) => { toolbar.badge = text; },
    setBadgeBackgroundColor: async ({ color }) => { toolbar.color = color; }, setTitle: async ({ title }) => { toolbar.title = title; }
  },
  notifications: { create: (_id, options, callback) => { notifications.push(options); callback?.(); } },
  privacy: { network: {
    webRTCIPHandlingPolicy: {
      onChange: { addListener(listener) { policyChangeListener = listener; } },
      async set({ value }) { policy = value; },
      async clear() { policy = 'default'; },
      async get() { return { value: policy, levelOfControl: 'controlled_by_this_extension' }; }
    },
    networkPredictionEnabled: {
      async set({ value }) { prediction = value; },
      async clear() { prediction = true; }
    }
  } }
};

const context = vm.createContext({
  chrome, AbortController, URL, setTimeout, clearTimeout, Intl,
  navigator: { onLine: true },
  async fetch(url) {
    requests.push(url);
    if (networkMode === 'failed') return result('', false);
    if (url.startsWith('https://cloudflare.com/')) return cloudflareDown ? result('', false) : result(`ip=${currentV4}\nloc=US\n`);
    if (new URL(url).hostname === 'api.ipify.org') {
      if (stallIpify) return { ...result(''), text: () => new Promise(() => {}) };
      return rateLimitIpify
        ? result('', false, 429, { 'Retry-After': '60' })
        : ipifyV4 === 'down' ? result('', false) : result({ ip: ipifyV4 || currentV4 });
    }
    if (url.startsWith('https://api6.ipify.org/')) return result({ ip: 'invalid' });
    if (url.startsWith('https://ipv6.icanhazip.com/')) return result('invalid');
    if (geoDown && /ipwho\.is|geojs\.io|ipinfo\.io/.test(url)) return result('', false, 503);
    if (url.startsWith('https://ipwho.is/')) {
      if (geoGate) { notifyGeoStarted(); await geoGate; }
      return result({
        success: true, ip: currentV4,
        ...(url.includes(PROXIED_V4) ? { country_code: 'AZ', country: 'Azerbaijan' } : { country_code: 'US', country: 'United States' }),
        connection: { isp: 'Example ISP', asn: 64500 }
      });
    }
    return result('', false);
  }
});

async function main() {
  vm.runInContext(source, context);
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', context); // probes here run milliseconds apart; persistence is tested below
  assert.equal(alarmPeriod, 0.5, 'Existing one-minute alarm must be upgraded');
  assert.equal(vm.runInContext('isValidIPv4("256.1.1.1")', context), false);
  assert.equal(vm.runInContext('isValidIPv4("198.51.100.22")', context), true);
  assert.equal(vm.runInContext('isValidIPv6("bad:value")', context), false);
  assert.equal(vm.runInContext('isValidIPv6("::::")', context), false);
  assert.equal(vm.runInContext('isValidIPv6("2001:db8::1")', context), true);
  assert.equal(vm.runInContext('normalizeCoordinate(0, 90)', context), 0);
  assert.equal(vm.runInContext('normalizeCoordinate(200, 90)', context), null);
  assert.equal(vm.runInContext('classifyConnectionType({isp:"Example ISP"})', context), 'Unknown');

  const snapshot = await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(snapshot.v4Info.ip, '198.51.100.22');
  assert.equal(data.latestV4Info.ip, '198.51.100.22');
  assert.equal(data.latestV6Info, null, 'Absent IPv6 must not retain an old route');
  assert.equal(data.isOffline, false);
  assert.equal(requests.filter(url => url.startsWith('https://cloudflare.com/')).length, 1);
  assert.equal(requests.some(url => url.startsWith('https://ipv4.icanhazip.com/')), false,
    'Fallback sources should not be called after a successful primary source');

  assert.equal(requests.filter(url => new URL(url).hostname === 'api.ipify.org').length, 1,
    'Every probe must also ask the independent vantage point');
  assert.equal(requests.some(url => url.startsWith('https://checkip.amazonaws.com')), false,
    'The independent fallback should not be called after ipify answers');

  const count = requests.length;
  await vm.runInContext('fetchAllBackgroundLocations(false)', context);
  assert.equal(requests.length, count, 'A recent probe should be reused');

  const first = vm.runInContext('fetchAllBackgroundLocations(false)', context);
  const forced = vm.runInContext('fetchAllBackgroundLocations(true)', context);
  await Promise.all([first, forced]);
  assert.equal(requests.filter(url => url.startsWith('https://cloudflare.com/')).length, 2,
    'Manual refresh should run after a cached check');
  assert.equal(requests.filter(url => url.startsWith('https://ipwho.is/')).length, 1,
    'Repeated refreshes of an unchanged IP should reuse recent geolocation');

  data.appSettings.enableNotifications = true;
  currentV4 = '198.51.100.23';
  geoStarted = new Promise(resolve => { notifyGeoStarted = resolve; });
  let releaseGeo;
  geoGate = new Promise(resolve => { releaseGeo = resolve; });
  const changed = vm.runInContext('fetchAllBackgroundLocations(true)', context);
  await geoStarted;
  assert.equal(data.latestV4Info.ip, currentV4, 'New IP should be visible before geolocation finishes');
  assert.equal(data.latestV4Info.isp, 'N/A', 'Initial result should show pending metadata');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(notifications.length, 1, 'IP change notification should not wait for geolocation');
  releaseGeo();
  await changed;
  geoGate = null;
  assert.equal(data.latestV4Info.isp, 'Example ISP');
  const geoRequestsBeforeCache = requests.filter(url => url.startsWith('https://ipwho.is/')).length;
  await vm.runInContext('getGeoLocation("198.51.100.22")', context);
  assert.equal(requests.filter(url => url.startsWith('https://ipwho.is/')).length, geoRequestsBeforeCache,
    'Returning to a recent VPN exit IP should reuse in-memory geolocation');

  const beforePopupCheck = requests.filter(url => url.startsWith('https://cloudflare.com/')).length;
  data.lastProbeAt = Date.now() - 6_000;
  await vm.runInContext('fetchAllBackgroundLocations(false, POPUP_PROBE_INTERVAL_MS)', context);
  assert.equal(requests.filter(url => url.startsWith('https://cloudflare.com/')).length, beforePopupCheck + 1,
    'Opening the popup should recheck a six-second-old result');

  const beforeDisabledAlarm = requests.length;
  data.appSettings.enableAutoRefresh = false;
  data.lastProbeAt = 0;
  await vm.runInContext('autoRefresh()', context);
  assert.equal(requests.length, beforeDisabledAlarm, 'Disabled automatic checks must not contact providers');
  data.appSettings.enableAutoRefresh = true;
  await vm.runInContext('autoRefresh()', context);
  assert.ok(requests.length > beforeDisabledAlarm, 'Re-enabled automatic checks must run');

  // --- Destination-dependent routing (e.g. a provider that NATs traffic to api.ipify.org abroad) ---
  const direct = currentV4;
  // Default: the warning is off. The main IP must stay put and nothing may be shown or sent.
  ipifyV4 = PROXIED_V4;
  data.lastNotifTime = 0; data.lastRouteNotifTime = 0;
  const quietBefore = notifications.length;
  const geoBefore = requests.filter(url => url.includes(PROXIED_V4)).length;
  for (let i = 0; i < 3; i++) await vm.runInContext('fetchAllBackgroundLocations(true, POPUP_PROBE_INTERVAL_MS)', context);
  assert.equal(data.latestV4Info.ip, direct, 'Default: the main IP is shown');
  assert.equal(notifications.length, quietBefore, 'Default: no notification about different IPs');
  assert.notEqual(toolbar.badge, '!', 'Default: no warning badge');
  assert.doesNotMatch(toolbar.title, /different IPs/, 'Default: no warning in the toolbar title');
  assert.equal(requests.filter(url => url.includes(PROXIED_V4)).length, geoBefore, 'Default: the other IP is not geolocated');
  ipifyV4 = null;
  for (let i = 0; i < 2; i++) await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  data.appSettings.warnRouteDivergence = true; // the remaining routing tests exercise the opt-in warning
  const ipChangeCount = () => notifications.filter(n => /IP Changed/.test(n.title)).length;
  const altIps = () => Array.from(data.routeDivergence?.alts || [], alt => alt.ip);
  ipifyV4 = PROXIED_V4;
  data.lastNotifTime = 0;
  const notesBefore = notifications.length;
  await vm.runInContext('fetchAllBackgroundLocations(true, POPUP_PROBE_INTERVAL_MS)', context);
  assert.equal(data.latestV4Info.ip, direct, 'The displayed IP must come from the edge source, not whichever answers');
  assert.equal(data.routeDivergence, null, 'A single mismatch must not be reported');
  await vm.runInContext('fetchAllBackgroundLocations(true, POPUP_PROBE_INTERVAL_MS)', context);
  assert.equal(data.latestV4Info.ip, direct, 'Popup checks must not flip the displayed IP');
  assert.equal(data.routeDivergence?.primaryIp, direct);
  assert.deepEqual(altIps(), [PROXIED_V4]);
  assert.equal(data.routeDivergence.alts[0].geo?.countryCode, 'AZ', 'The alternate route should be geolocated');
  assert.equal(notifications.length, notesBefore + 1, 'A confirmed divergence notifies once');
  assert.match(notifications.at(-1).title, /different IPs/);
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(notifications.length, notesBefore + 1, 'An unchanged divergence must not notify again');
  assert.equal(ipChangeCount(), 1, 'Divergence must not produce IP-change notifications');

  cloudflareDown = true;
  for (let i = 0; i < 4; i++) {
    const held = await vm.runInContext('fetchAllBackgroundLocations(true)', context);
    assert.equal(data.latestV4Info.ip, direct, 'A known alternate route must never replace the displayed IP');
    assert.notEqual(held.probeError, true, 'A held IP is not a probe failure');
    assert.equal(data.v4Unverified, true, 'A held IP is marked unverified');
  }
  assert.equal(notifications.length, notesBefore + 1, 'Holding the IP must not notify');
  cloudflareDown = false;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.v4Unverified, false);

  // State written by the old version (it showed the proxied IP). Correcting it is not a network change.
  data.latestV4Info = { ...data.latestV4Info, ip: PROXIED_V4 };
  data.routeState = null;
  data.routeDivergence = null;
  for (let i = 0; i < 3; i++) await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.latestV4Info.ip, direct);
  assert.equal(ipChangeCount(), 1, 'Switching to the edge answer must not claim the IP changed');

  // The edge IP moves while ipify is unreachable: evidence for the old IP no longer applies.
  ipifyV4 = 'down';
  currentV4 = '198.51.100.40';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.routeDivergence, null, 'Evidence recorded for an old IP must be cleared');
  currentV4 = direct;
  ipifyV4 = PROXIED_V4;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.routeDivergence, null, 'The first mismatch after returning is not yet evidence');
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.deepEqual(altIps(), [PROXIED_V4], 'Re-confirmed on the second consecutive mismatch');

  ipifyV4 = null;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.routeDivergence, null, 'Agreement from the same provider clears the warning at once');

  for (const transient of ['203.0.113.50', null, '203.0.113.51', null]) {
    ipifyV4 = transient;
    await vm.runInContext('fetchAllBackgroundLocations(true)', context);
    assert.equal(data.routeDivergence, null, 'Mismatches that do not repeat (VPN switching) are never reported');
  }

  // A real change is still detected and notified when every vantage point moves.
  data.lastNotifTime = 0;
  let changesBefore = ipChangeCount();
  currentV4 = '198.51.100.30';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.latestV4Info.ip, '198.51.100.30');
  assert.equal(ipChangeCount(), changesBefore + 1, 'A real IP change must notify');

  // Through the real caller: a throttled announcement is retried later with the right baseline.
  data.lastNotifTime = 0;
  currentV4 = '198.51.100.31';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(ipChangeCount(), changesBefore + 2);
  currentV4 = '198.51.100.32';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(ipChangeCount(), changesBefore + 2, 'Within 4 s of the last notification it is throttled');
  data.lastNotifTime = 0;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(ipChangeCount(), changesBefore + 3, 'The throttled change is announced on a later probe');
  assert.match(notifications.at(-1).message, /from 198\.51\.100\.31 to 198\.51\.100\.32/);
  currentV4 = direct;
  data.lastNotifTime = 0;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);

  // --- Decision function, exercised directly (production code) ---
  const T0 = 1_000_000;
  const evalRoute = (obs, cached, state = null, div = null, now = T0) =>
    vm.runInContext(`evaluateIPv4Route(${JSON.stringify(obs)}, ${JSON.stringify(cached)}, ${JSON.stringify(state)}, ${JSON.stringify(div)}, ${now})`, context);
  const E = ip => ({ ip, countryCode: '', source: 'Cloudflare' });
  const I = (ip, source = 'ipify') => ({ ip, countryCode: '', source });
  const A = '192.0.2.1', B = '192.0.2.2', C = '192.0.2.3';
  const at = ip => ({ ip, vantage: 'edge' });
  // Runs a sequence of [edge, independent] probes, feeding back what the extension would store.
  // Mirrors the caller: persists state and divergence, keeps the cache through failures and holds,
  // clears IPv4 when only IPv6 answered ('v6'), and commits announcedIp only if delivery succeeds.
  const run = (steps, cached = at(A), deliver = () => true, stepMs = 3_000) => {
    let state = null, div = null, shown = cached, out = [], now = T0;
    steps.forEach(([e, i, v6], n) => {
      now += stepMs;
      const r = evalRoute({ edge: e ? E(e) : null, independent: i ? (typeof i === 'string' ? I(i) : i) : null }, shown, state, div, now);
      const failed = !r.primary && !r.held && !v6;
      state = r.state;
      if (!failed) div = r.divergence; // the failure path does not rewrite stored evidence
      if (r.primary) shown = { ip: r.primary.ip, vantage: r.primary.vantage };
      else if (!r.held && v6) shown = null; // IPv4 absent, IPv6 present
      const delivered = !failed && r.notify && deliver(n);
      if (delivered) state = { ...state, announcedIp: r.notify.to };
      out.push({ ...r, shown: shown?.ip, delivered: !!delivered });
    });
    return out;
  };
  const notes = seq => seq.filter(r => r.delivered).map(r => `${r.notify.from}>${r.notify.to}`);

  let seq = run([[A, B], [null, B], [null, B], [null, B], [null, B]]);
  assert.ok(seq.slice(1).every(r => r.shown === A), 'R1: an unconfirmed alternate never replaces the edge IP');
  assert.deepEqual(notes(seq), [], 'R1: and never notifies');
  seq = run([[A, B], [A, B], ...Array(60).fill([null, B])]);
  assert.ok(seq.every(r => r.shown === A), 'R1: confirmed alternate evidence outlives any timeout');
  assert.deepEqual(notes(seq), []);

  seq = run([[null, C], [null, C]]);
  assert.equal(seq[0].shown, A, 'R7: one independent-only answer is not enough');
  assert.equal(seq[1].shown, C, 'R7: a consistent new fallback value is accepted on the next probe');
  assert.deepEqual(notes(seq), [`${A}>${C}`]);

  seq = run([[B, A], [B, B]]);
  assert.deepEqual(notes(seq), [`${A}>${B}`], 'Staggered switch notifies once it completes');
  seq = run([[B, A], [B, A], [B, B], [B, B]]);
  assert.deepEqual(notes(seq), [`${A}>${B}`], 'R2: a two-probe stagger still notifies exactly once');
  seq = run([[B, A], [B, null], [B, null], [B, B]]);
  assert.deepEqual(notes(seq), [`${A}>${B}`], 'R2: an interrupted observation delays but does not lose the change');
  seq = run([[B, A], [B, null]]);
  assert.deepEqual(notes(seq), [], 'R2: one silent probe from the group that saw the old IP is not proof it is gone');
  seq = run([[B, A], [B, A], [B, null], [B, null], [B, null]]);
  assert.deepEqual(notes(seq), [], 'R2: an old IP that is a confirmed alternate route is a split, not a change');
  seq = run([[null, null], [A, A]]);
  assert.deepEqual(notes(seq), [], 'An outage followed by the same IP is not a change');
  seq = run([[B, A], [C, A], [C, C]]);
  assert.deepEqual(notes(seq), [`${A}>${C}`], 'R3: successive changes keep the original baseline');
  seq = run([[B, A], [A, A]]);
  assert.deepEqual(notes(seq), [], 'A change that reverts before completing is never announced');
  seq = run([[B, B], [B, B]]);
  assert.deepEqual(notes(seq), [`${A}>${B}`], 'A clean change notifies on the first probe');

  seq = run([[A, B], [A, null], [A, B]]);
  assert.equal(seq[1].confirmed.length, 0, 'An incomplete probe is not evidence');
  assert.equal(seq[2].confirmed.length, 1, 'but on a flaky network it does not restart the run either');
  seq = run([[A, B], [null, null], [null, null], [A, B]]);
  assert.equal(seq[3].confirmed.length, 1, 'Probe failures in between are neutral');
  seq = run([[A, B], [C, null], [A, B]]);
  assert.ok(seq.every(r => !r.confirmed.length), 'A lone answer that contradicts the candidate breaks the run');
  seq = run([[A, B], [C, B], [A, B]]);
  assert.ok(seq.every(r => !r.divergence), 'A contradicting observation breaks the run');
  let r4 = evalRoute({ edge: E(A), independent: I(B) }, at(A));
  r4 = evalRoute({ edge: E(A), independent: I(B) }, at(A), r4.state, null, T0 + 3 * 60_000);
  assert.equal(r4.divergence, null, 'Mismatches minutes apart are not consecutive');

  seq = run([[A, B], [A, B], [A, I(B, 'Amazon')], [A, I(A, 'Amazon')], [A, I(C, 'Amazon')]]);
  assert.deepEqual(seq[4].divergence?.alts.find(alt => alt.source === 'ipify')?.ip, B,
    'R5: fallback observations never erase or take over ipify evidence');
  assert.equal(seq.filter(r => r.confirmed.length).length, 1, 'and do not cause a second confirmation');
  seq = run([[A, B], [A, B], [A, A]]);
  assert.equal(seq[2].divergence, null, 'The provider that saw the alternate IP clears it');
  seq = run([[A, B], [A, B], [A, C], [A, C]]);
  assert.equal(seq[2].divergence, null, 'A provider reporting a different IP withdraws its old evidence');
  assert.deepEqual(Array.from(seq[3].divergence?.alts || [], alt => alt.ip), [C]);

  seq = run([[A, B], [A, B], [null, null], [A, B]]);
  assert.equal(seq[3].confirmed.length, 0, 'Confirmed evidence survives failures and is not re-confirmed');
  assert.deepEqual(Array.from(seq[3].divergence?.alts || [], alt => alt.ip), [B]);

  // Round-three sequences
  seq = run([[A, B], [A, B], [null, null, 'v6'], [null, B], [null, B]]);
  assert.ok(seq.slice(3).every(r => r.held), 'IPv4 briefly absent: known proxy evidence still blocks a flip');
  assert.deepEqual(notes(seq), []);
  seq = run([[B, A], [null, null], [null, null], [B, B]]);
  assert.deepEqual(notes(seq), [`${A}>${B}`], 'Outages in the middle of a change do not swallow its announcement');
  seq = run([[B, A], [B, A], [null, B], [null, B]]);
  assert.equal(seq[2].divergence, null, 'A provider that stops seeing its alternate withdraws the evidence without the edge');
  assert.deepEqual(notes(seq), [`${A}>${B}`]);
  seq = run([[B, B], [C, C], [C, C], [B, B]], at(A), n => n !== 1);
  assert.deepEqual(notes(seq), [`${A}>${B}`, `${B}>${C}`, `${C}>${B}`], 'A throttled announcement is retried with the right baseline');
  seq = run([[null, C], [null, null], [null, C]]);
  assert.ok(seq.every(r => r.shown === A), 'Interrupted fallback answers are not consecutive');
  assert.deepEqual(notes(seq), []);

  // Minimum persistence (production value 15 s): a short VPN transition is never a split.
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 15000', context);
  seq = run([[B, A], [B, A], [B, A], [B, B]], at(A), () => true, 3_000);
  assert.ok(seq.every(r => !r.confirmed.length), 'A 9-second stagger is not reported as a split');
  seq = run([[A, B], [A, B], [A, B], [A, B], [A, B], [A, B], [A, B]], at(A), () => true, 3_000);
  assert.equal(seq.findIndex(r => r.confirmed.length), 5, 'A persistent split is confirmed once it has lasted 15 s');
  seq = run([[A, B], [A, null], [null, B], [A, B], [null, null], [A, B], [A, B]], at(A), () => true, 3_000);
  assert.equal(seq.findIndex(r => r.confirmed.length), 5, 'Incomplete probes on a flaky network do not delay confirmation');
  seq = run([[A, B], [A, B], [A, B], [A, A], [A, B], [A, B], [A, B]], at(A), () => true, 3_000);
  assert.ok(seq.every(r => !r.confirmed.length), 'Agreement in between restarts the 15 s clock');
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', context);

  const fresh = evalRoute({ edge: E(A), independent: I(A) }, null);
  assert.equal(fresh.notify, null, 'First run is a baseline, not a change');
  assert.equal(fresh.state.announcedIp, A);

  // --- Stalled response body (headers sent, body never finishes) ---
  ipifyV4 = null;
  stallIpify = true;
  const started = Date.now();
  const stalled = await Promise.race([
    vm.runInContext('fetchAllBackgroundLocations(true)', context),
    new Promise((_, reject) => setTimeout(() => reject(new assert.AssertionError({ message: 'A stalled body blocked the probe' })), 6_000))
  ]);
  assert.ok(Date.now() - started < 5_000, 'A stalled body must time out instead of blocking the probe');
  assert.equal(stalled.v4Info.ip, currentV4);
  stallIpify = false;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);

  // --- Alternate-route geolocation retries after a failure ---
  const altIp = '203.0.113.77';
  ipifyV4 = altIp;
  geoDown = true;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.deepEqual(altIps(), [altIp]);
  assert.equal(data.routeDivergence.alts[0].geo, null, 'Geolocation was down');
  geoDown = false;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.routeDivergence.alts[0].geo, null, 'Retries follow the normal cooldown');
  data.routeDivergence.alts[0].geoAt = Date.now() - 16 * 60_000;
  data.lastProbeAt = 0;
  await vm.runInContext('fetchAllBackgroundLocations(false)', context);
  assert.equal(data.routeDivergence.alts[0].geo?.countryCode, 'US', 'Automatic checks retry missing alternate metadata');

  // --- Toolbar: divergence marker, failure precedence, render ordering ---
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(toolbar.badge, '!', 'Same-country divergence still shows a warning badge');
  assert.match(toolbar.title, /Sites see different IPs/);
  networkMode = 'failed';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(toolbar.badge, 'ERR', 'Failed verification must not look like a verified location');
  networkMode = 'normal';
  ipifyV4 = null;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.routeDivergence, null);

  data.routeDivergence = { primaryIp: currentV4, primarySource: 'Cloudflare', alts: [{ source: 'ipify', ip: altIp, geo: null, geoAt: 0 }] };
  let releaseToolbar;
  toolbarGetGate = new Promise(resolve => { releaseToolbar = resolve; });
  const olderRender = vm.runInContext('updateToolbarDisplay(' + JSON.stringify(data.latestV4Info) + ', null, false, false)', context);
  data.routeDivergence = null;
  await vm.runInContext('updateToolbarDisplay(' + JSON.stringify(data.latestV4Info) + ', null, false, false)', context);
  releaseToolbar();
  await olderRender;
  await vm.runInContext('toolbarApplyChain', context);
  assert.doesNotMatch(toolbar.title, /different IPs/, 'An older render must not overwrite newer state');
  assert.notEqual(toolbar.badge, '!');

  // --- Never stuck on "Locating..." ---
  // 1. A placeholder left by an interrupted probe (e.g. the service worker was stopped mid-lookup).
  ipifyV4 = null;
  data.latestV4Info = { ip: currentV4, country: 'Locating...', countryCode: '', pending: true, isp: 'N/A', asn: 'N/A', updatedAt: Date.now(), vantage: 'edge' };
  await vm.runInContext('fetchAllBackgroundLocations(true, POPUP_PROBE_INTERVAL_MS)', context);
  assert.notEqual(data.latestV4Info.country, 'Locating...', 'A leftover placeholder is resolved on the next probe');
  assert.equal(data.latestV4Info.pending, undefined);
  // 2. The same placeholder while the displayed IP is held (edge unreachable).
  data.latestV4Info = { ip: currentV4, country: 'Locating...', countryCode: '', pending: true, isp: 'N/A', asn: 'N/A', updatedAt: Date.now(), vantage: 'edge' };
  cloudflareDown = true;
  ipifyV4 = '203.0.113.88';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.v4Unverified, true);
  assert.notEqual(data.latestV4Info.country, 'Locating...', 'A held placeholder is resolved too');
  cloudflareDown = false;
  ipifyV4 = null;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  // 3. Geolocation that never answers resolves to a final value within the lookup bound.
  vm.runInContext('GEO_LOOKUP_TIMEOUT_MS = 300; geoMemoryCache.clear()', context);
  geoGate = new Promise(() => {});
  notifyGeoStarted = () => {};
  currentV4 = '198.51.100.61';
  data.lastNotifTime = 0;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(data.latestV4Info.ip, '198.51.100.61');
  assert.notEqual(data.latestV4Info.country, 'Locating...', 'A hung lookup must not leave a placeholder');
  assert.equal(data.latestV4Info.pending, undefined);
  // 4. Anything else that hangs cannot block later probes.
  vm.runInContext('PROBE_WATCHDOG_MS = 400; GEO_LOOKUP_TIMEOUT_MS = 600000; geoMemoryCache.clear()', context);
  let releaseHung;
  geoGate = new Promise(resolve => { releaseHung = resolve; });
  currentV4 = '198.51.100.62';
  await Promise.race([
    vm.runInContext('fetchAllBackgroundLocations(true)', context),
    new Promise((_, reject) => setTimeout(() => reject(new assert.AssertionError({ message: 'The watchdog did not release a hung probe' })), 3_000))
  ]);
  geoGate = null;
  const afterHang = await Promise.race([
    vm.runInContext('fetchAllBackgroundLocations(true)', context),
    new Promise((_, reject) => setTimeout(() => reject(new assert.AssertionError({ message: 'A hung probe blocked the next one' })), 3_000))
  ]);
  assert.equal(afterHang.v4Info.ip, '198.51.100.62');
  currentV4 = '198.51.100.63';
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  releaseHung();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(data.latestV4Info.ip, '198.51.100.63', 'An abandoned probe finishing late must not overwrite newer state');
  vm.runInContext('PROBE_WATCHDOG_MS = 30000; GEO_LOOKUP_TIMEOUT_MS = 15000', context);
  currentV4 = direct;
  await vm.runInContext('fetchAllBackgroundLocations(true)', context);

  rateLimitIpify = true;
  const limited = await vm.runInContext('fetchWithTimeout("https://api.ipify.org?format=json")', context);
  assert.equal(limited.status, 429);
  const afterLimit = requests.length;
  await assert.rejects(vm.runInContext('fetchWithTimeout("https://api.ipify.org?format=json")', context));
  assert.equal(requests.length, afterLimit, 'A rate-limited provider must not receive immediate retries');
  assert.ok(data.providerCooldowns['https://api.ipify.org'] > Date.now());
  rateLimitIpify = false;

  networkMode = 'failed';
  const failed = await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(failed.probeError, true);
  assert.equal(failed.isOffline, false, 'Provider failure is not proof of disconnection');
  assert.equal(data.latestV4Info.ip, currentV4, 'A failed probe must retain the last result');

  context.navigator.onLine = false;
  const offline = await vm.runInContext('fetchAllBackgroundLocations(true)', context);
  assert.equal(offline.isOffline, true);
  assert.equal(data.latestV4Info.ip, currentV4);

  await policyChangeListener({ value: 'default', levelOfControl: 'controlled_by_other_extensions' });
  assert.equal(data.shieldEffective, false, 'Policy takeover should remove the active indicator');
  data.appSettings.enableAntiLeakShield = false;
  data.appSettings.enableDnsPrefetchBlock = true;
  await vm.runInContext('applyPrivacyShield()', context);
  assert.equal(policy, 'default', 'WebRTC policy should clear when its switch is off');
  assert.equal(prediction, false, 'Network prediction switch should work independently of WebRTC protection');
  data.appSettings.enableDnsPrefetchBlock = false;
  await vm.runInContext('applyPrivacyShield()', context);
  assert.equal(prediction, true, 'Network prediction setting should restore when disabled');
  assert.equal(typeof installedListener, 'function', 'The install listener must be registered');
  installedListener({ reason: 'install' });
  await vm.runInContext('activeProbePromise', context);
  assert.equal(createdTabs.length, 1, 'First install must open one welcome tab');
  assert.deepEqual(createdTabs.map(tab => tab.url), ['chrome-extension://test/welcome/welcome.html']);
  for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
    installedListener({ reason });
    await vm.runInContext('activeProbePromise', context);
    assert.equal(createdTabs.length, 1, `${reason} must not open a welcome tab`);
  }
  console.log('First-install welcome tab runtime tests passed');
  console.log('Background runtime smoke tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
