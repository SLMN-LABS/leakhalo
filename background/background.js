
let activeProbePromise = null;
let queuedForceProbePromise = null;
const PROBE_INTERVAL_MS = 30_000;
const POPUP_PROBE_INTERVAL_MS = 3_000;
let POPUP_PROBE_WITH_CHANNEL_MS = 10_000;
const GEO_RETRY_INTERVAL_MS = 15 * 60_000;
const MANUAL_GEO_REFRESH_MS = 5 * 60_000;
const ALT_GEO_MANUAL_RETRY_MS = 30_000;
const GEO_MEMORY_CACHE_MS = 30 * 60_000;
// Upper bounds so no single step can leave the extension stuck (e.g. on "Locating...").
let GEO_LOOKUP_TIMEOUT_MS = 15_000;
let PROBE_WATCHDOG_MS = 30_000;
let TOOLBAR_WAIT_MS = 5_000;
let NOTIFY_GEO_WAIT_MS = 2_500;
let probeGeneration = 0;
// While a check reports "offline", retry soon so the return of the connection shows within seconds
// (the alarm alone would take up to 30 s), then every 15 s for as long as the worker runs.
// Requests fail locally while offline, so this is cheap.
const OFFLINE_RETRY_MS = [3_000, 5_000, 10_000, 15_000];
const offlineRetry = { timer: null, step: 0 };
const deviceOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve(onTimeout()), ms); })
  ]).finally(() => clearTimeout(timer));
}
const geoMemoryCache = new Map();
const providerCooldowns = {};
const providerCooldownReady = chrome.storage.local.get('providerCooldowns').then(({ providerCooldowns: saved }) => {
  if (saved && typeof saved === 'object') Object.assign(providerCooldowns, saved);
}).catch(() => {});

// Keeps a provider out of rotation until `until`, and drops cooldowns that have run out.
async function markProviderCooldown(origin, delayMs) {
  const now = Date.now();
  if (origin) providerCooldowns[origin] = now + delayMs;
  for (const [key, until] of Object.entries(providerCooldowns)) if (!(until > now)) delete providerCooldowns[key];
  await chrome.storage.local.set({ providerCooldowns: { ...providerCooldowns } }).catch(() => {});
}

async function loadBitmap(path) {
  try {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch (e) {
    return null;
  }
}

function loadFlagBitmap(countryCode) {
  if (!/^[a-z]{2}$/i.test(countryCode || '')) return Promise.resolve(null);
  return loadBitmap(`assets/flags/flag-${countryCode.toLowerCase()}.png`);
}

function iconCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

const ICON_SIZES = [16, 32, 48];

// Both flags are decoded once and drawn at every toolbar size; the bitmaps are released after.
async function renderSplitFlagIcon(code1, code2) {
  const [bitmap1, bitmap2] = await Promise.all([loadFlagBitmap(code1), loadFlagBitmap(code2)]);
  try {
    if (!bitmap1 || !bitmap2) return null;
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = iconCanvas(size);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const splitX = Math.round(size / 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, size);
      ctx.clip();
      ctx.drawImage(bitmap1, 0, 0, size, size);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, size - splitX, size);
      ctx.clip();
      ctx.drawImage(bitmap2, 0, 0, size, size);
      ctx.restore();
      // A whole-pixel divider (fillRect, not a half-pixel stroke) drawn only over the flags
      // themselves, so it stays sharp at 16 and 32 px and never runs past rounded corners.
      const width = Math.max(1, Math.round(size / 24));
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(splitX - Math.floor(width / 2), 0, width, size);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    return { imageData };
  } catch (err) {
    return null;
  } finally {
    bitmap1?.close?.();
    bitmap2?.close?.();
  }
}

// The grey offline icon never changes, so it is drawn once per worker and reused.
let disconnectedIcon = null;
async function renderDisconnectedIcon() {
  if (disconnectedIcon) return disconnectedIcon;
  const bitmap = await loadBitmap('assets/icons/icon48.png');
  try {
    if (!bitmap) return null;
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = iconCanvas(size);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, size, size);
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const avg = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        d[i] = avg;
        d[i + 1] = avg;
        d[i + 2] = avg;
        d[i + 3] = Math.round(d[i + 3] * 0.45);
      }
      imageData[size] = imgData;
    }
    disconnectedIcon = { imageData };
    return disconnectedIcon;
  } catch (e) {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

const DEFAULT_ACTION_ICON = { path: { "16": "/assets/icons/icon16.png", "32": "/assets/icons/icon32.png", "48": "/assets/icons/icon48.png" } };
let toolbarRenderSeq = 0;
let toolbarApplyChain = Promise.resolve();
// What the toolbar shows now, so an unchanged state (most checks) costs no rendering or API calls.
let appliedToolbarKey = '';

// Badge text colours chosen for contrast on each badge background.
const BADGE_TEXT = { '#f59e0b': '#192b35', '#0284c7': '#ffffff', '#64748b': '#ffffff' };

// Works out icon, badge and title for the current state without rendering anything: the icon is
// described ({ kind, codes }) so an unchanged state can be recognised before any drawing.
async function planToolbar(v4Info, v6Info, isOffline, probeError) {
  const res = await chrome.storage.local.get(['appSettings', 'routeDivergence']);
  const badgeMode = (res.appSettings && res.appSettings.badgeMode) ? res.appSettings.badgeMode : 'flag';

  // Failure states take precedence over cached locations: a stale flag must not look verified.
  if (isOffline || probeError || (!v4Info?.ip && !v6Info?.ip)) {
    return {
      icon: { kind: 'grey' },
      // Offline is the grey icon alone; only a provider error adds a badge.
      badgeText: probeError ? 'ERR' : '',
      badgeColor: probeError ? '#f59e0b' : '#64748b',
      title: probeError ? 'LeakHalo: Unable to verify network' : 'LeakHalo: Disconnected / No Internet Connection'
    };
  }

  // The split-route warning is opt-in (Settings): by default the main country is shown alone.
  const divergence = res.appSettings?.warnRouteDivergence === true &&
    res.routeDivergence && v4Info?.ip && v4Info.ip === res.routeDivergence.primaryIp &&
    Array.isArray(res.routeDivergence.alts) && res.routeDivergence.alts.length ? res.routeDivergence : null;
  const v4Code = normalizeCountryCode(v4Info?.countryCode);
  const v6Code = normalizeCountryCode(v6Info?.countryCode);
  const altCode = divergence
    ? divergence.alts.map(alt => normalizeCountryCode(alt.geo?.countryCode)).find(code => code && code !== v4Code) || ''
    : '';
  const primaryCode = v4Code || v6Code;
  const primaryName = primaryCode ? (v4Code ? v4Info.country : v6Info.country) : '';
  const isV4V6Split = !!(v4Code && v6Code && v4Code !== v6Code);

  const lines = [];
  if (divergence) {
    lines.push('⚠️ Sites see different IPs',
      `${divergence.primarySource}: ${divergence.primaryIp}${v4Code ? ` (${v4Code})` : ''}`,
      ...divergence.alts.map(alt => {
        const code = normalizeCountryCode(alt.geo?.countryCode);
        return `${alt.source}: ${alt.ip}${code ? ` (${code})` : ''}`;
      }));
  }
  if (isV4V6Split) {
    lines.push('⚠️ Split Route Detected!', `IPv4: ${v4Info.country} (${v4Code}) | IPv6: ${v6Info.country} (${v6Code})`);
  }
  const locating = v4Info?.pending === true || (!v4Info?.ip && v6Info?.pending === true);
  lines.push(primaryCode ? `Location: ${primaryName} (${primaryCode})`
    : `LeakHalo: ${locating ? 'locating…' : 'location unknown'} · ${v4Info?.ip || v6Info?.ip}`);
  const title = lines.join('\n');
  const warning = !!divergence || isV4V6Split;

  if (badgeMode === 'off') {
    return { icon: { kind: 'default' }, badgeText: divergence ? '!' : '', badgeColor: '#f59e0b', title };
  }

  // Two flags: IPv4/IPv6 split first, otherwise a divergence whose routes are in different countries.
  const secondCode = isV4V6Split ? v6Code : (v4Code ? altCode : '');
  const icon = primaryCode && secondCode ? { kind: 'split', codes: [v4Code || primaryCode, secondCode] }
    : primaryCode ? { kind: 'flag', codes: [primaryCode] } : { kind: 'default' };

  let badgeText = '';
  let badgeColor = null;
  if (badgeMode === 'text' && primaryCode) {
    badgeText = primaryCode;
    badgeColor = warning ? '#f59e0b' : '#0284c7';
  } else if (divergence) {
    // Same-country or unknown-country divergence still needs a visible marker.
    badgeText = '!';
    badgeColor = '#f59e0b';
  }
  return { icon, badgeText, badgeColor, title };
}

async function renderPlannedIcon(icon) {
  if (icon.kind === 'grey') return (await renderDisconnectedIcon().catch(() => null)) || DEFAULT_ACTION_ICON;
  if (icon.kind === 'split') {
    const split = await renderSplitFlagIcon(icon.codes[0], icon.codes[1]).catch(() => null);
    if (split) return split;
  }
  if (icon.kind === 'split' || icon.kind === 'flag') {
    const flagPath = `/assets/flags/flag-${icon.codes[0].toLowerCase()}.png`;
    return { path: { "16": flagPath, "32": flagPath, "48": flagPath } };
  }
  return DEFAULT_ACTION_ICON;
}

// Renders are planned concurrently but applied one at a time, and a plan superseded by a newer
// call is dropped, so an older render can never overwrite newer state.
async function updateToolbarDisplay(v4Info, v6Info, isOffline = false, probeError = false) {
  const seq = ++toolbarRenderSeq;
  const plan = await planToolbar(v4Info, v6Info, isOffline, probeError).catch(() => null);
  if (!plan) return;
  toolbarApplyChain = toolbarApplyChain.catch(() => {}).then(async () => {
    if (seq !== toolbarRenderSeq) return;
    const key = JSON.stringify(plan);
    if (key === appliedToolbarKey) return;
    appliedToolbarKey = '';
    try {
      await chrome.action.setIcon(await renderPlannedIcon(plan.icon));
    } catch (e) {
      await chrome.action.setIcon(DEFAULT_ACTION_ICON).catch(() => {});
    }
    await chrome.action.setBadgeText({ text: plan.badgeText });
    if (plan.badgeColor) {
      await chrome.action.setBadgeBackgroundColor({ color: plan.badgeColor });
      await chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT[plan.badgeColor] || '#ffffff' });
    }
    await chrome.action.setTitle({ title: plan.title });
    appliedToolbarKey = key;
  });
  return toolbarApplyChain;
}

// Returns true when the change counts as announced (shown, or notifications are switched off) and
// false when it was throttled or failed, so the caller can retry it on a later probe.
// Resolves true only when Chrome actually created the notification.
function createNotification(id, options) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, options, () => resolve(!chrome.runtime.lastError));
    } catch (e) {
      resolve(false);
    }
  });
}

// One alert at a time per address family, so the throttle check and its timestamp cannot
// interleave between two checks.
const notifyChains = {};
function sendIPChangeNotification(type, oldIp, newGeo) {
  const run = (notifyChains[type] || Promise.resolve()).catch(() => false).then(() => deliverIPChangeNotification(type, oldIp, newGeo));
  notifyChains[type] = run;
  return run;
}

async function deliverIPChangeNotification(type, oldIp, newGeo) {
  try {
    const now = Date.now();
    // Throttled per address family, so an IPv4 and an IPv6 change in the same check both arrive.
    const throttleKey = `lastNotifTime${type}`;
    const stored = await chrome.storage.local.get([throttleKey, 'appSettings', 'announcedCountries']);
    const enableNotifs = stored.appSettings ? stored.appSettings.enableNotifications !== false : true;
    const newCode = normalizeCountryCode(newGeo.countryCode);
    const oldCode = normalizeCountryCode(stored.announcedCountries?.[type]);
    if (!enableNotifs) {
      if (newCode) await rememberAnnouncedCountry(type, newCode);
      return true;
    }
    const lastNotif = stored[throttleKey] || 0;
    if (now - lastNotif < 4000) return false;

    // One notification per kind: a newer alert replaces the older one instead of piling up.
    const notifId = `leakhalo_ip_change_${type}`;
    // A new country is what matters most (a VPN that dropped, say), so it gets its own alert;
    // a new address in the same country is a routine change.
    const countryChanged = !!(oldCode && newCode && oldCode !== newCode);
    const flagEmoji = newCode ? ` (${newCode})` : '';
    const knownCountry = newCode ? ` in ${newGeo.country}` : '';
    const message = countryChanged
      ? `Changed from ${oldIp} to ${newGeo.ip}: ${getFullCountryName(oldCode, '')} → ${newGeo.country}`
      : oldIp
        ? `Changed from ${oldIp} to ${newGeo.ip}${knownCountry}`
        : `Connected with ${newGeo.ip}${knownCountry}`;

    const iconUrl = normalizeCountryCode(newGeo.countryCode)
      ? chrome.runtime.getURL(`assets/flags/flag-${newGeo.countryCode.toLowerCase()}.png`)
      : chrome.runtime.getURL('assets/icons/icon48.png');

    const delivered = await createNotification(notifId, {
      type: 'basic',
      iconUrl: iconUrl,
      title: countryChanged ? `🚨 Country changed: ${oldCode} → ${newCode}` : `🌍 ${type} IP Changed${flagEmoji}`,
      message: message,
      priority: 2
    });
    if (delivered) {
      await chrome.storage.local.set({ [throttleKey]: now });
      if (newCode) await rememberAnnouncedCountry(type, newCode);
    }
    return delivered;
  } catch (e) {
    return false;
  }
}

// The country of the address the user was last told about, per family, so an alert can say
// whether the country changed.
async function rememberAnnouncedCountry(type, code) {
  const { announcedCountries } = await chrome.storage.local.get('announcedCountries');
  if (announcedCountries?.[type] !== code) await chrome.storage.local.set({ announcedCountries: { ...(announcedCountries || {}), [type]: code } });
}

// Resolves true once the divergence counts as announced (shown, or notifications are off). False
// while the opt-in warning is off or the alert was throttled or failed, so it is retried later.
async function sendRouteDivergenceNotification(divergence, primaryInfo) {
  try {
    const now = Date.now();
    // Separate throttle: an IP-change notification a moment earlier must not swallow this one.
    const stored = await chrome.storage.local.get(['lastRouteNotifTime', 'appSettings']);
    if (stored.appSettings?.warnRouteDivergence !== true) return false; // warning is opt-in
    if (stored.appSettings && stored.appSettings.enableNotifications === false) return true;
    if (now - (stored.lastRouteNotifTime || 0) < 4000) return false;
    const where = (ip, info) => normalizeCountryCode(info?.countryCode) ? `${ip} (${info.country})` : ip;
    const alts = divergence.alts.map(alt => `${alt.source}: ${where(alt.ip, alt.geo)}`).join('\n');
    const delivered = await createNotification('leakhalo_route_divergence', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon48.png'),
      title: '⚠️ Sites see different IPs',
      message: `${divergence.primarySource}: ${where(divergence.primaryIp, primaryInfo)}\n${alts}\nA proxy, VPN rule or your internet provider's routing sends some sites through a different IP.`,
      priority: 2
    });
    if (delivered) await chrome.storage.local.set({ lastRouteNotifTime: now });
    return delivered;
  } catch (e) {
    return false;
  }
}

chrome.notifications?.onClicked?.addListener((id) => chrome.notifications.clear(id));

// Answers from IP and location services are a few hundred bytes; anything far larger is not one.
const MAX_RESPONSE_BYTES = 64 * 1024;
async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  await providerCooldownReady;
  const origin = new URL(url).origin;
  if ((providerCooldowns[origin] || 0) > Date.now()) throw new Error('Provider cooling down');
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    });
    if (res.status === 429) {
      const retryAfter = res.headers?.get?.('Retry-After');
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter || '') - Date.now());
      await markProviderCooldown(origin, Math.min(24 * 60 * 60_000, Math.max(5 * 60_000, parsed || 0)));
    }
    // Error answers are never read by the callers: release the body instead of downloading it.
    const length = Number(res.headers?.get?.('Content-Length'));
    if (!res.ok || length > MAX_RESPONSE_BYTES) {
      res.body?.cancel?.().catch(() => {});
      if (res.ok) throw new Error('Response too large');
      return { ok: false, status: res.status, headers: res.headers, text: async () => '', json: async () => { throw new Error('No body'); } };
    }
    // Read the body under the same deadline: a server that sends headers and then stalls must not
    // hold up the probe (and every check queued behind it).
    const aborted = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('Timed out'));
      controller.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    });
    const body = await Promise.race([res.text(), aborted]);
    if (body.length > MAX_RESPONSE_BYTES) throw new Error('Response too large');
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  } finally {
    clearTimeout(id);
  }
}

// A public IP is never in these ranges: a captive portal or local proxy answering a request must
// not be taken for the address websites see. (Documentation ranges stay valid; tests use them.)
function isNonPublicIPv4(parts) {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) || (a === 198 && (b === 18 || b === 19));
}

function isValidIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    !isNonPublicIPv4(parts.map(Number));
}

function isValidIPv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':') || ip.length > 39 || !/^[0-9a-f:]+$/i.test(ip)) return false;
  let canonical;
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch (e) {
    return false;
  }
  // Unspecified, loopback, IPv4-mapped, link-local, unique-local and multicast addresses.
  return !(canonical === '::' || canonical === '::1' || canonical.startsWith('::ffff:') ||
    /^fe[89ab][0-9a-f]:/.test(canonical) || /^f[cd][0-9a-f]{2}:/.test(canonical) || /^ff[0-9a-f]{2}:/.test(canonical));
}

// IPv4 is discovered from two independent vantage points at once:
//   edge        – Cloudflare's network (trace endpoint, then icanhazip, which Cloudflare operates)
//   independent – ipify, then Amazon's checkip
// Proxies, VPN rules and provider routing can send some destinations through another public IP,
// so the two may legitimately see different public IPs. The displayed IP always comes from the
// edge group (falling back to the independent group), so the answer never depends on which
// endpoint happened to respond first or on whether the popup is open.
async function firstIPv4(sources) {
  for (const source of sources) {
    try { return await source(); } catch (e) {}
  }
  return null;
}

// On dual-stack networks Chrome reaches cloudflare.com over IPv6, so its trace reports the IPv6
// address. Then icanhazip (IPv4-only, also on Cloudflare's network) answers instead, and for a
// while the trace is skipped rather than costing every check an extra round trip.
const CF_TRACE_V6_SKIP_MS = 10 * 60_000;
let cfTraceV6Until = 0;

async function probePublicIPv4() {
  const buster = `_t=${Date.now()}`;
  const plain = (url, source) => () => fetchWithTimeout(url, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const ip = ((await res.text()) || '').trim();
    if (isValidIPv4(ip)) return { ip, countryCode: '', source };
    throw new Error();
  });
  const cloudflare = () => fetchWithTimeout(`https://cloudflare.com/cdn-cgi/trace?${buster}`, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    const ipMatch = text.match(/^ip=([^\r\n]+)/m);
    const locMatch = text.match(/^loc=([^\r\n]+)/m);
    if (ipMatch && ipMatch[1].includes(':')) cfTraceV6Until = Date.now() + CF_TRACE_V6_SKIP_MS;
    if (ipMatch && isValidIPv4(ipMatch[1].trim())) {
      return {
        ip: ipMatch[1].trim(),
        countryCode: locMatch && locMatch[1] ? normalizeCountryCode(locMatch[1]) : '',
        source: 'Cloudflare'
      };
    }
    throw new Error();
  });
  const ipify = () => fetchWithTimeout(`https://api.ipify.org?format=json&${buster}`, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && isValidIPv4(data.ip)) return { ip: data.ip.trim(), countryCode: '', source: 'ipify' };
    throw new Error();
  });
  const [edge, independent] = await Promise.all([
    firstIPv4(Date.now() < cfTraceV6Until
      ? [plain(`https://ipv4.icanhazip.com?${buster}`, 'icanhazip')]
      : [cloudflare, plain(`https://ipv4.icanhazip.com?${buster}`, 'icanhazip')]),
    firstIPv4([ipify, plain(`https://checkip.amazonaws.com?${buster}`, 'Amazon')])
  ]);
  return { edge, independent };
}

const ROUTE_PAIR_TTL_MS = 2 * 60_000;   // "consecutive" probes must also be close in time
// A mismatch must also last this long: while a VPN connects, old connections keep the previous
// route for a few seconds, and fast checks would otherwise report that transition as a split.
let ROUTE_MIN_PERSIST_MS = 15_000;
const PRIMARY_INDEPENDENT_SOURCE = 'ipify'; // the independent group's first provider
const FALLBACK_CONFIRMATIONS = 2;        // independent-only answers needed to replace an edge IP
const GROUP_MISSES_AS_KNOWN = 2;         // a group silent this long no longer vouches for an old IP
// After the edge group has been silent this long, earlier alternate-route evidence no longer holds
// the shown IP: a new independent answer is then accepted after FALLBACK_CONFIRMATIONS probes.
let EDGE_SILENT_RELEASE_MS = 3 * 60_000;

// Pure decision step for one IPv4 probe (no I/O). Inputs:
//   observation  { edge, independent } answers ({ ip, countryCode, source }) or null
//   cachedV4     the IPv4 currently shown ({ ip, vantage: 'edge' | 'independent', ... }) or null
//   state        persisted { announcedIp, lastPairKeys, lastPairAt, edgeMisses, indepMisses, fallback }
//   divergence   persisted { primaryIp, primarySource, alts: [{ source, ip, geo, geoAt, since }], since }
// Model:
//   * Shown IP: the edge answer. Without it, an independent answer that is known alternate-route
//     evidence never replaces the shown IP (held, "Verifying"); a new independent value replaces an
//     edge-derived IP only after it is seen in FALLBACK_CONFIRMATIONS consecutive probes.
//   * Divergence evidence is kept per independent provider. A provider's evidence is confirmed by
//     the same mismatch in two strictly consecutive probes and removed only when that provider
//     itself agrees with the edge or reports a different IP. Fallback providers never erase it.
//   * Notifications compare the shown IP with announcedIp, the last IP the user was told about.
//     A change is announced once no vantage point that could still see the old IP does, so
//     staggered switches, reverts and successive changes produce exactly one correct message.
function evaluateIPv4Route(observation, cachedV4, state, divergence, now = Date.now()) {
  const { edge, independent } = observation;
  // IPv4 identity survives probes where IPv4 is briefly absent (IPv6-only answers), so evidence
  // and holds keep applying when it returns.
  const ref = cachedV4?.ip ? cachedV4 : (state?.lastV4?.ip ? state.lastV4 : null);
  const cachedIp = ref?.ip || null;
  const st = {
    announcedIp: state?.announcedIp || cachedIp,
    // A split candidate survives while it keeps being observed (TTL between observations).
    lastPairKeys: (state?.lastPairKeys || []).filter(k => now - (state?.pairSeen?.[k] || state?.lastPairAt || 0) <= ROUTE_PAIR_TTL_MS),
    pairSince: {},
    pairSeen: {},
    lastPairAt: now,
    edgeMisses: edge ? 0 : (state?.edgeMisses || 0) + 1,
    indepMisses: independent ? 0 : (state?.indepMisses || 0) + 1,
    edgeSilentSince: edge ? null : (state?.edgeSilentSince || now),
    fallback: null, // strictly consecutive: only the independent-only branch below keeps it
    lastV4: ref ? { ip: ref.ip, vantage: ref.vantage || 'edge' } : null,
    // Independent IPs seen disagreeing with the edge for the IP currently shown (confirmed or not).
    altSeen: state?.altSeen && state.altSeen.primaryIp === cachedIp ? { primaryIp: cachedIp, list: [...state.altSeen.list] } : { primaryIp: cachedIp, list: [] }
  };
  let div = divergence && cachedIp && divergence.primaryIp === cachedIp && Array.isArray(divergence.alts)
    ? { ...divergence, alts: divergence.alts.map(alt => ({ ...alt })) }
    : null;

  // 1. The IPv4 to show.
  let primary = null;
  let held = false;
  if (edge) {
    primary = { ...edge, vantage: 'edge' };
    st.fallback = null;
  } else if (independent) {
    const edgeLongSilent = now - st.edgeSilentSince >= EDGE_SILENT_RELEASE_MS;
    const knownAlternate = !edgeLongSilent && ((!!div && div.alts.some(alt => alt.ip === independent.ip)) ||
      st.altSeen.list.some(seen => seen.ip === independent.ip));
    if (independent.ip === cachedIp) {
      primary = { ...independent, vantage: ref.vantage || 'independent' };
    } else if (cachedIp && knownAlternate) {
      held = true;
    } else if (!cachedIp || ref.vantage === 'independent') {
      primary = { ...independent, vantage: 'independent' };
    } else {
      const prev = state?.fallback;
      st.fallback = prev?.ip === independent.ip
        ? { ip: independent.ip, count: prev.count + 1 }
        : { ip: independent.ip, count: 1 };
      if (st.fallback.count >= FALLBACK_CONFIRMATIONS) {
        primary = { ...independent, vantage: 'independent' };
        st.fallback = null;
      } else {
        held = true;
      }
    }
  }
  // With no IPv4 answer at all nothing was learned, so keep what is shown and all evidence. The
  // shown IPv4 is held ("Verifying") until both groups have missed GROUP_MISSES_AS_KNOWN probes in
  // a row: a single timeout on a dual-stack network must not drop the IPv4 card.
  const noAnswer = !edge && !independent;
  if (noAnswer && cachedIp && !(st.edgeMisses >= GROUP_MISSES_AS_KNOWN && st.indepMisses >= GROUP_MISSES_AS_KNOWN)) held = true;
  const shownIp = primary ? primary.ip : ((held || noAnswer) ? cachedIp : null);
  if (div && shownIp !== div.primaryIp) div = null; // the shown IP moved: old evidence is stale
  if (st.altSeen.primaryIp !== shownIp) st.altSeen = { primaryIp: shownIp, list: [] };
  if (primary) st.lastV4 = { ip: primary.ip, vantage: primary.vantage };

  // 2. Divergence evidence, per independent provider.
  const confirmed = [];
  const pairKeys = [];
  if (edge && independent) {
    const own = div ? div.alts.find(alt => alt.source === independent.source) : null;
    if (edge.ip === independent.ip) {
      if (independent.source === PRIMARY_INDEPENDENT_SOURCE) {
        // The independent group's main provider agrees: evidence a fallback provider left while it
        // was unavailable is no longer backed by anything (that fallback is asked only when it fails).
        if (div) div.alts = [];
        st.altSeen.list = [];
      } else {
        if (own) div.alts = div.alts.filter(alt => alt !== own); // this provider now agrees
        st.altSeen.list = st.altSeen.list.filter(seen => seen.source !== independent.source);
      }
    } else {
      if (edge.ip === shownIp && !st.altSeen.list.some(seen => seen.source === independent.source && seen.ip === independent.ip)) {
        st.altSeen.list = [...st.altSeen.list.filter(seen => seen.source !== independent.source), { source: independent.source, ip: independent.ip }].slice(-4);
      }
      // Keyed by the IP pair, not the provider: ipify and its fallback seeing the same alternate
      // IP is the same evidence.
      const key = `${edge.ip}|${independent.ip}`;
      pairKeys.push(key);
      const since = st.lastPairKeys.includes(key) && state?.pairSince?.[key] ? state.pairSince[key] : now;
      st.pairSince[key] = since;
      st.pairSeen[key] = now;
      if (own && own.ip !== independent.ip) div.alts = div.alts.filter(alt => alt !== own); // contradicted
      const still = !!div && div.alts.some(alt => alt.ip === independent.ip);
      if (!still && st.lastPairKeys.includes(key) && now - since >= ROUTE_MIN_PERSIST_MS) {
        if (!div) div = { primaryIp: edge.ip, primarySource: edge.source, alts: [], since: now };
        const alt = { source: independent.source, ip: independent.ip, geo: null, geoAt: 0, since: now };
        div.alts.push(alt);
        confirmed.push(alt);
      }
    }
    if (div) div.primarySource = edge.source;
  } else if (independent) {
    // Without an edge answer a provider can still withdraw its own evidence: it no longer sees
    // the alternate IP it reported.
    if (div) div.alts = div.alts.filter(alt => alt.source !== independent.source || alt.ip === independent.ip);
    st.altSeen.list = st.altSeen.list.filter(seen => seen.source !== independent.source || seen.ip === independent.ip);
  }
  if (div && !div.alts.length) div = null;
  if (edge && independent) {
    st.lastPairKeys = pairKeys; // agreement or a different pair replaces the candidate
  } else {
    // An incomplete probe (one side or both missing) is neutral unless an answering side
    // contradicts the candidate; on a flaky network it must not restart the persistence clock.
    st.lastPairKeys = st.lastPairKeys.filter(k => {
      const [kEdge, kAlt] = k.split('|');
      return !(edge && edge.ip !== kEdge) && !(independent && independent.ip !== kAlt);
    });
    for (const k of st.lastPairKeys) {
      st.pairSince[k] = state?.pairSince?.[k] || now;
      st.pairSeen[k] = state?.pairSeen?.[k] || state?.lastPairAt || now;
    }
  }

  // 3. Change notification against the last announced IP.
  let notify = null;
  if (!st.announcedIp) {
    st.announcedIp = shownIp; // first result: a baseline, not a change
  } else if (!noAnswer && shownIp && shownIp !== st.announcedIp) {
    const stillSeen = [edge?.ip, independent?.ip].includes(st.announcedIp);
    const edgeSettled = !!edge || st.edgeMisses >= GROUP_MISSES_AS_KNOWN;
    const indepSettled = !!independent || st.indepMisses >= GROUP_MISSES_AS_KNOWN;
    const isKnownSplit = !!div && div.alts.some(alt => alt.ip === st.announcedIp);
    // The caller advances announcedIp only after the notification is delivered (or notifications
    // are off), so a throttled announcement is retried with the correct "from".
    if (!stillSeen && !isKnownSplit && edgeSettled && indepSettled) notify = { from: st.announcedIp, to: shownIp };
  }

  return { primary, held, state: st, divergence: div, confirmed, notify };
}

// Canonical (compressed, lower-case) IPv6, so two spellings of one address compare equal.
function canonicalIPv6(ip) {
  try { return new URL(`http://[${ip.trim()}]/`).hostname.slice(1, -1); } catch (e) { return ip.trim().toLowerCase(); }
}

// Cloudflare's edge first (icanhazip), like IPv4, so a Split Route compares the two address
// families from the same vantage point. Networks that silently drop IPv6 (VPN kill switches)
// would otherwise cost two full timeouts: ipify starts after IPV6_HEDGE_MS or as soon as
// icanhazip fails, and the wait never exceeds IPV6_TIMEOUT_MS.
const IPV6_TIMEOUT_MS = 2200;
const IPV6_HEDGE_MS = 700;
function getFastPublicIPv6() {
  const buster = `_t=${Date.now()}`;
  const icanhazip = () => fetchWithTimeout(`https://ipv6.icanhazip.com?${buster}`, {}, IPV6_TIMEOUT_MS).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (isValidIPv6(text?.trim())) return canonicalIPv6(text);
    throw new Error();
  });
  const ipify = (timeoutMs) => fetchWithTimeout(`https://api6.ipify.org?format=json&${buster}`, {}, timeoutMs).then(async (res) => {
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && isValidIPv6(data.ip)) return canonicalIPv6(data.ip);
    throw new Error();
  });
  return new Promise((resolve) => {
    const started = Date.now();
    let primaryDone = false, primaryIp = null, backup = null, settled = false;
    const finish = (ip) => { if (!settled) { settled = true; clearTimeout(hedge); resolve(ip); } };
    const startBackup = () => {
      if (backup) return;
      backup = ipify(Math.max(300, IPV6_TIMEOUT_MS - (Date.now() - started)))
        .then(ip => { if (!primaryDone || !primaryIp) finish(ip); })
        .catch(() => { if (primaryDone) finish(primaryIp); });
    };
    const hedge = setTimeout(startBackup, IPV6_HEDGE_MS);
    icanhazip().then(ip => { primaryDone = true; primaryIp = ip; finish(ip); }).catch(() => {
      primaryDone = true;
      if (backup) backup.then(() => finish(null)); else { clearTimeout(hedge); startBackup(); backup.then(() => finish(null)); }
    });
  });
}

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { return null; }
})();

function getFullCountryName(code, fallbackName) {
  // Short names where the CLDR English label is longer than the ISO 3166-1 short name.
  const shortNames = { PS: 'Palestine' };
  if (code && shortNames[code.toUpperCase()]) return shortNames[code.toUpperCase()];
  if (code && regionNames) {
    try {
      const name = regionNames.of(code.toUpperCase());
      if (name && name !== code.toUpperCase()) return name;
    } catch (e) {}
  }
  const cleanFallback = (typeof fallbackName === 'string' && !fallbackName.startsWith('Unknown') && !fallbackName.startsWith('Detected')) ? fallbackName : '';
  if (cleanFallback && cleanFallback.length > 2) {
    return cleanFallback;
  }
  return code || cleanFallback || 'Unknown Country';
}

// Pseudo codes that are not countries: XX/ZZ unknown, T1 Tor, A1/A2 anonymous proxy and
// satellite, O1 other, EU/AP regions. They must never show as a country or a flag.
const PSEUDO_COUNTRY_CODES = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);
function normalizeCountryCode(code) {
  if (typeof code !== 'string' || !/^[a-z]{2}$/i.test(code.trim())) return '';
  const upper = code.trim().toUpperCase();
  return PSEUDO_COUNTRY_CODES.has(upper) ? '' : upper;
}

function normalizeCoordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

// Some services answer 0,0 ("Null Island") when they have no location: that is no location.
function normalizeLatLon(lat, lon) {
  const la = normalizeCoordinate(lat, 90), lo = normalizeCoordinate(lon, 180);
  return la === null || lo === null || (la === 0 && lo === 0) ? { lat: null, lon: null } : { lat: la, lon: lo };
}

// Placeholder words some services use for an unknown city or region.
function cleanPlace(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(unknown|n\/?a|none|null|-+)$/i.test(text) ? '' : text;
}

// "AS13335 Cloudflare, Inc." → { asn: 'AS13335', name: 'Cloudflare, Inc.' }
function splitAsnPrefix(org) {
  const match = (org || '').match(/^(AS\d+)\s*[-_:|]?\s*(.*)$/i);
  return match ? { asn: match[1].toUpperCase(), name: match[2] || match[1].toUpperCase() } : { asn: '', name: org || '' };
}

// Matched as whole words, so "cloud" no longer catches an ISP in St. Cloud and "aws" no word
// that merely contains it. Relay and mobile networks are checked before datacenters: Cloudflare
// WARP runs on Cloudflare's network but is a relay, not a hosting provider.
const RELAY_PATTERN = /\b(cloudflare warp|icloud private relay|private relay|mullvad|proton ?vpn|proton ag|nordvpn|nord security|expressvpn|express vpn|surfshark|windscribe|ivpn|private internet access|cyberghost|hide\.me|tor exit|vpn)\b/i;
const MOBILE_PATTERN = /\b(mobile|cellular|irancell|mtn irancell|mobile communication company of iran|rightel|t-mobile|verizon wireless|vodafone mobile)\b/i;
const DATACENTER_PATTERN = new RegExp('\\b(' + [
  'hetzner', 'ovh', 'ovhcloud', 'digitalocean', 'amazon', 'aws', 'google cloud', 'google llc', 'linode', 'akamai',
  'vultr', 'm247', 'leaseweb', 'choopa', 'oracle', 'cloudflare', 'fastly', 'serverius', 'contabo',
  'hostinger', 'tencent', 'alibaba', 'azure', 'microsoft', 'datacenter', 'data center', 'data centre', 'hosting',
  '(?<!st\\.? )cloud', 'servers?', 'vps', 'dedicated', 'colocation', 'hivelocity', 'cogent', 'psychz', 'quadranet',
  'scaleway', 'equinix', 'ipvolume', 'datacamp', 'stark industries', 'aeza'
].join('|') + ')\\b', 'i');

function classifyConnectionType(data) {
  const text = [data.isp, data.org, data.domain].filter(Boolean).join(' ');
  const rawType = (data.type || '').toLowerCase();

  if (data.isVpn || data.isProxy || rawType === 'vpn' || rawType === 'proxy') return 'VPN / Relay';
  if (data.isHosting || rawType === 'hosting' || rawType === 'datacenter') return 'Datacenter';
  if (data.isMobile || rawType === 'cellular' || rawType === 'mobile') return 'Mobile';
  if (RELAY_PATTERN.test(text)) return 'VPN / Relay';
  if (MOBILE_PATTERN.test(text)) return 'Mobile';
  if (DATACENTER_PATTERN.test(text)) return 'Datacenter';
  if (['residential', 'isp', 'broadband'].includes(rawType)) return 'Residential';
  return 'Unknown';
}

// Recent lookups survive the service worker being stopped (session storage is memory only), so
// switching back and forth between VPN exits does not ask the location services again.
const GEO_CACHE_KEY = 'geoMemoryCache';
const geoCacheReady = (chrome.storage.session?.get(GEO_CACHE_KEY) || Promise.resolve({})).then((saved) => {
  for (const [ip, info] of Object.entries(saved?.[GEO_CACHE_KEY] || {})) if (!geoMemoryCache.has(ip)) geoMemoryCache.set(ip, info);
}).catch(() => {});

function rememberGeo(ip, info) {
  geoMemoryCache.delete(ip);
  geoMemoryCache.set(ip, info);
  if (geoMemoryCache.size > 16) geoMemoryCache.delete(geoMemoryCache.keys().next().value);
  chrome.storage.session?.set({ [GEO_CACHE_KEY]: Object.fromEntries(geoMemoryCache) }).catch(() => {});
}

async function getGeoLocation(ip, initialCountryCode = '', useRecentCache = true) {
  await geoCacheReady;
  const cached = useRecentCache ? geoMemoryCache.get(ip) : null;
  if (cached && Date.now() - cached.updatedAt < GEO_MEMORY_CACHE_MS) {
    geoMemoryCache.delete(ip);
    geoMemoryCache.set(ip, cached);
    return { ...cached, updatedAt: Date.now() };
  }
  const deadline = Date.now() + GEO_LOOKUP_TIMEOUT_MS;
  const result = await withTimeout(fetchGeoLocation(ip, initialCountryCode, deadline), GEO_LOOKUP_TIMEOUT_MS,
    () => unresolvedGeoInfo(ip, initialCountryCode));
  // Only complete answers are remembered: a failed or country-only lookup is retried later.
  if (!geoIncomplete(result)) rememberGeo(ip, result);
  return result;
}

// After a provider fails, the next one is tried only while the lookup's deadline has not passed,
// so a lookup that already timed out stops sending requests.
async function fetchGeoLocation(ip, initialCountryCode = '', deadline = Infinity) {
  if (!isValidIPv4(ip) && !isValidIPv6(ip)) throw new Error('Invalid IP address');
  const timeLeft = (ms) => Math.min(ms, deadline - Date.now());

  try {
    const res = await fetchWithTimeout(`https://ipwho.is/${ip}`, {}, timeLeft(3000));
    if (res.ok) {
      const data = await res.json();
      // ipwho.is reports its rate limit as a normal answer with success: false.
      if (data && data.success === false && /limit|quota|too many/i.test(data.message || '')) {
        await markProviderCooldown('https://ipwho.is', 15 * 60_000);
      }
      if (data && data.success) {
        const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
        const countryName = getFullCountryName(countryCode, data.country);
        const ispStr = (data.connection && (data.connection.isp || data.connection.org)) || 'N/A';
        const connType = classifyConnectionType({
          isp: ispStr,
          org: data.connection?.org,
          domain: data.connection?.domain,
          type: data.connection?.type,
          isVpn: data.connection?.is_vpn,
          isProxy: data.connection?.is_proxy,
          isHosting: data.connection?.is_datacenter
        });

        return {
          ip,
          country: countryName,
          countryCode: countryCode,
          city: cleanPlace(data.city),
          region: cleanPlace(data.region),
          isp: ispStr,
          asn: data.connection && data.connection.asn ? `AS${data.connection.asn}` : 'N/A',
          timezone: (data.timezone && data.timezone.id) || 'N/A',
          connectionType: connType,
          ...normalizeLatLon(data.latitude, data.longitude),
          updatedAt: Date.now()
        };
      }
    }
  } catch (e) {}

  if (timeLeft(3500) <= 0) return unresolvedGeoInfo(ip, initialCountryCode);
  try {
    const res = await fetchWithTimeout(`https://get.geojs.io/v1/ip/geo/${ip}.json`, {}, timeLeft(3500));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.country_code || data.country)) {
        const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
        const countryName = getFullCountryName(countryCode, data.country);
        const org = splitAsnPrefix(data.organization);
        const asnStr = data.asn ? `AS${data.asn}` : (org.asn || 'N/A');
        const ispStr = data.organization_name || org.name || 'N/A';
        const connType = classifyConnectionType({
          isp: ispStr,
          org: data.organization || data.organization_name
        });

        return {
          ip,
          country: countryName,
          countryCode: countryCode,
          city: cleanPlace(data.city),
          region: cleanPlace(data.region),
          isp: ispStr,
          asn: asnStr,
          timezone: data.timezone || 'N/A',
          connectionType: connType,
          ...normalizeLatLon(data.latitude, data.longitude),
          updatedAt: Date.now()
        };
      }
    }
  } catch (e) {}

  if (timeLeft(3500) <= 0) return unresolvedGeoInfo(ip, initialCountryCode);
  try {
    const res = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`, {}, timeLeft(3500));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.country || data.org) && !data.error) {
        const countryCode = normalizeCountryCode(data.country) || normalizeCountryCode(initialCountryCode);
        const countryName = getFullCountryName(countryCode, '');
        const [lat, lon] = typeof data.loc === 'string' ? data.loc.split(',') : [];
        const org = splitAsnPrefix(data.org);
        const asnStr = org.asn || 'N/A';
        const ispStr = org.name || 'N/A';
        const connType = classifyConnectionType({
          isp: ispStr,
          org: data.org
        });

        return {
          ip,
          country: countryName,
          countryCode: countryCode,
          city: cleanPlace(data.city),
          region: cleanPlace(data.region),
          isp: ispStr,
          asn: asnStr,
          timezone: data.timezone || 'N/A',
          connectionType: connType,
          ...normalizeLatLon(lat, lon),
          updatedAt: Date.now()
        };
      }
    }
  } catch (e) {}

  return unresolvedGeoInfo(ip, initialCountryCode);
}

// Result when no geolocation provider answered: never a "Locating..." placeholder.
function unresolvedGeoInfo(ip, initialCountryCode = '') {
  const resolvedCode = normalizeCountryCode(initialCountryCode);
  return {
    ip: ip,
    country: getFullCountryName(resolvedCode, ''),
    countryCode: resolvedCode,
    city: '',
    region: '',
    isp: 'N/A',
    asn: 'N/A',
    timezone: 'N/A',
    connectionType: 'Unknown',
    lat: null,
    lon: null,
    updatedAt: Date.now()
  };
}

function makePendingGeoInfo(ip, countryCode = '') {
  const code = normalizeCountryCode(countryCode);
  return {
    ip,
    country: code ? getFullCountryName(code, '') : 'Locating...',
    countryCode: code,
    pending: true, // placeholder until geolocation answers; always re-enriched on the next probe
    city: '',
    region: '',
    isp: 'N/A',
    asn: 'N/A',
    timezone: 'N/A',
    connectionType: 'Unknown',
    lat: null,
    lon: null,
    updatedAt: Date.now()
  };
}

// Plain reachability check, independent of CORS headers and provider cooldowns: any HTTP answer,
// even an error page, proves a working connection.
// LeakHalo's own server is asked only while Instant change detection is on.
async function internetReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const ping = (url) => fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
  const urls = ['https://cloudflare.com/cdn-cgi/trace', 'https://api.ipify.org/', 'https://checkip.amazonaws.com/'];
  try {
    const { appSettings } = await chrome.storage.local.get('appSettings');
    if (fastDetectionEnabled(appSettings)) urls.push('https://35-232-61-175.sslip.io/healthz');
    await Promise.any(urls.map(ping));
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort(); // the first answer decides; the others need not finish
  }
}

// repeat: keep retrying every 15 s after the quick steps. Without it (the browser itself reports
// offline, so the 'online' event will follow) only the quick steps run, as a safety net in case
// that event never reaches this worker, e.g. when Chrome starts before the network is up.
// A lookup that produced no country, or only a country (every location service failed and the
// country came from Cloudflare), is retried on GEO_RETRY_INTERVAL_MS.
function geoIncomplete(info) {
  return !normalizeCountryCode(info?.countryCode) || (!info.city && (!info.isp || info.isp === 'N/A'));
}

function scheduleOfflineRetry(repeat = true) {
  if (offlineRetry.timer || (!repeat && offlineRetry.step >= OFFLINE_RETRY_MS.length)) return;
  const delay = OFFLINE_RETRY_MS[Math.min(offlineRetry.step++, OFFLINE_RETRY_MS.length - 1)];
  offlineRetry.timer = setTimeout(async () => {
    offlineRetry.timer = null;
    if (!(await autoChecksEnabled())) return;
    fetchAllBackgroundLocations(true).catch(() => {});
  }, delay);
}

async function autoChecksEnabled() {
  const { appSettings } = await chrome.storage.local.get('appSettings');
  return appSettings?.enableAutoRefresh !== false;
}

function resetOfflineRetry() {
  clearTimeout(offlineRetry.timer);
  offlineRetry.timer = null;
  offlineRetry.step = 0;
}

// Probe bookkeeping that only matters while the browser runs lives in session storage (memory),
// so frequent checks do not rewrite the disk; it falls back to local storage where unavailable.
const sessionStore = chrome.storage.session || chrome.storage.local;

// Same fields as routeState apart from the probe timestamp, to skip rewriting an unchanged state.
const sameRouteState = (a, b) => JSON.stringify({ ...(a || {}), lastPairAt: 0 }) === JSON.stringify({ ...(b || {}), lastPairAt: 0 });

async function fetchAllBackgroundLocations(forceRefresh = false, minimumIntervalMs = PROBE_INTERVAL_MS) {
  if (activeProbePromise) {
    if (!forceRefresh) return activeProbePromise;
    if (!queuedForceProbePromise) {
      // Freed as soon as the queued probe starts, so a request arriving while it runs queues
      // another probe instead of reusing one that began before the request.
      queuedForceProbePromise = activeProbePromise.catch(() => {}).then(() => {
        queuedForceProbePromise = null;
        return fetchAllBackgroundLocations(true, minimumIntervalMs);
      });
    }
    return queuedForceProbePromise;
  }

  // A probe abandoned by the watchdog may still finish later; it must not overwrite newer state.
  const generation = ++probeGeneration;
  const current = () => generation === probeGeneration;
  const commit = async (values) => { if (current() && Object.keys(values).length) await chrome.storage.local.set(values); };
  const work = (async () => {
    {
      const stored = await chrome.storage.local.get([
        'latestV4Info',
        'latestV6Info',
        'isOffline',
        'probeError',
        'v4Unverified',
        'appSettings',
        'routeState',
        'routeDivergence',
        'pendingV6Notice',
        'lastKnownV6Ip'
      ]);
      const { lastProbeAt } = await sessionStore.get('lastProbeAt').catch(() => ({}));

      const cachedV4 = stored.latestV4Info || null;
      const cachedV6 = stored.latestV6Info || null;
      const result = (v4Info, v6Info, isOffline = false, probeError = false) => ({ v4Info, v6Info, isOffline, probeError });
      // Without any stored result there is nothing to fall back on, so the interval never applies.
      const hasResult = !!(cachedV4 || cachedV6 || stored.isOffline || stored.probeError);
      // The slower interval does not apply after a failed or offline check (recovery shows at
      // once) or while a different route is shown: the server only sees its own route.
      const watchRoutes = !!stored.routeDivergence && stored.appSettings?.warnRouteDivergence === true;
      const interval = stored.isOffline || stored.probeError || watchRoutes ? Math.min(minimumIntervalMs, POPUP_PROBE_INTERVAL_MS) : minimumIntervalMs;
      if (!forceRefresh && hasResult && Date.now() - (lastProbeAt || 0) < interval) {
        return result(cachedV4, cachedV6, stored.isOffline === true, stored.probeError === true);
      }

      if (current()) await sessionStore.set({ lastProbeAt: Date.now() }).catch(() => {});

      // The browser knows it has no network: show that at once, without requests that can only fail.
      // Mostly the 'online' event (or the alarm, if the worker slept) ends this state.
      if (!deviceOnline()) {
        await commit({ isOffline: true, probeError: false });
        if (current()) scheduleOfflineRetry(false);
        await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, true, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
        return result(cachedV4, cachedV6, true, false);
      }

      const [observation, fastV6] = await Promise.all([
        probePublicIPv4(),
        getFastPublicIPv6()
      ]);
      const route = evaluateIPv4Route(observation, cachedV4, stored.routeState, stored.routeDivergence || null);
      const fastV4 = route.primary;
      const v4Held = route.held;

      if (!fastV4 && !fastV6 && (!v4Held || (!observation.edge && !observation.independent))) {
        // Every provider failed. If not even a plain request gets an answer, there is no working
        // connection, although the browser may still report one (virtual network adapters, Wi-Fi
        // without internet). Otherwise the providers are the problem ("ERR"). Either way nothing
        // was learned about the routes, so the route state is left as it was.
        const isOffline = !deviceOnline() || !(await internetReachable());
        await commit({ isOffline, probeError: !isOffline });
        if (isOffline && current()) scheduleOfflineRetry();
        await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, isOffline, !isOffline).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
        return result(cachedV4, cachedV6, isOffline, !isOffline);
      }
      resetOfflineRetry();

      const v4Changed = !!fastV4 && cachedV4?.ip !== fastV4.ip;
      const v6Changed = !!fastV6 && cachedV6?.ip !== fastV6;
      const retainedV4 = v4Held ? cachedV4 : null;
      const pendingV4 = fastV4
        ? (v4Changed ? { ...makePendingGeoInfo(fastV4.ip, fastV4.countryCode), vantage: fastV4.vantage } : cachedV4)
        : retainedV4;
      const pendingV6 = fastV6 ? (v6Changed ? makePendingGeoInfo(fastV6) : cachedV6) : null;
      const updateObj = { lastCheckedAt: Date.now() };
      if (stored.isOffline !== false) updateObj.isOffline = false;
      if (stored.probeError !== false) updateObj.probeError = false;
      if (stored.v4Unverified !== v4Held) updateObj.v4Unverified = v4Held;

      if (v4Changed || v6Changed) {
        // Shown at once ("Locating…"); the change alerts follow once the new location is known.
        await commit({ ...updateObj, latestV4Info: pendingV4, latestV6Info: pendingV6, routeState: route.state });
        await withTimeout(current() && updateToolbarDisplay(pendingV4, pendingV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
      }

      // Geolocate alternate routes when first confirmed, and retry missing metadata on the same
      // schedule as the primary IP (a manual refresh retries a missing country after 30 s).
      const divergence = route.divergence;
      if (divergence && route.confirmed.length) divergence.notified = false;
      const altsNeedingGeo = divergence && stored.appSettings?.warnRouteDivergence === true ? divergence.alts.filter(alt => {
        const age = Date.now() - (alt.geoAt || 0);
        return !normalizeCountryCode(alt.geo?.countryCode) &&
          (age >= GEO_RETRY_INTERVAL_MS || (forceRefresh && age >= ALT_GEO_MANUAL_RETRY_MS));
      }) : [];
      // A refresh of an unchanged IP must not replace a complete location with a failed lookup.
      const keepComplete = (cached, info) => cached && !cached.pending && !geoIncomplete(cached) && geoIncomplete(info)
        ? { ...cached, updatedAt: Date.now() } : info;
      const geoV4 = (async () => {
          if (!fastV4) {
            // A held IP may still be an unfinished placeholder from an interrupted probe.
            if (!retainedV4?.pending) return retainedV4;
            const info = await getGeoLocation(retainedV4.ip, retainedV4.countryCode);
            return { ...info, vantage: retainedV4.vantage };
          }
          const age = Date.now() - (cachedV4?.updatedAt || 0);
          const needsEnrichment = v4Changed || !cachedV4?.updatedAt || cachedV4.pending === true ||
            (geoIncomplete(cachedV4) && age >= GEO_RETRY_INTERVAL_MS) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          // The memory cache serves a new or unfinished IP; retries and manual refreshes ask again.
          const useCache = v4Changed || cachedV4?.pending === true;
          let info = needsEnrichment ? await getGeoLocation(fastV4.ip, fastV4.countryCode, useCache) : cachedV4;
          if (needsEnrichment && !v4Changed) info = keepComplete(cachedV4, info);
          return info && info.vantage !== fastV4.vantage ? { ...info, vantage: fastV4.vantage } : info;
        })();
      const geoV6 = (async () => {
          if (!fastV6) return null;
          const age = Date.now() - (cachedV6?.updatedAt || 0);
          const needsEnrichment = v6Changed || !cachedV6?.updatedAt || cachedV6.pending === true ||
            (geoIncomplete(cachedV6) && age >= GEO_RETRY_INTERVAL_MS) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          if (!needsEnrichment) return cachedV6;
          const info = await getGeoLocation(fastV6, '', v6Changed || cachedV6?.pending === true);
          return v6Changed ? info : keepComplete(cachedV6, info);
        })();
      const geoAlts = Promise.all(altsNeedingGeo.map(alt => getGeoLocation(alt.ip).catch(() => null)));

      // Change alerts carry the new country when geolocation answers within NOTIFY_GEO_WAIT_MS;
      // a slow lookup must not delay the alert itself.
      const [alertV4, alertV6] = await Promise.all([
        withTimeout(geoV4, NOTIFY_GEO_WAIT_MS, () => pendingV4),
        withTimeout(geoV6, NOTIFY_GEO_WAIT_MS, () => pendingV6)
      ]);
      if (current()) {
        // IPv6: compared with the last address seen, even if IPv6 was briefly absent in between.
        const v6From = cachedV6?.ip || stored.lastKnownV6Ip || null;
        const v6Notice = v6Changed && v6From && v6From !== fastV6 ? { from: stored.pendingV6Notice?.from || v6From, to: fastV6 } : stored.pendingV6Notice;
        if (v6Notice) {
          if (alertV6?.ip !== v6Notice.to || stored.appSettings?.notifyIPv6 === false) {
            if (stored.pendingV6Notice) await commit({ pendingV6Notice: null }); // superseded, or switched off
          } else {
            // Kept until delivered: a throttled or failed IPv6 alert is retried on the next check.
            const delivered = await sendIPChangeNotification('IPv6', v6Notice.from, alertV6);
            await commit({ pendingV6Notice: delivered ? null : v6Notice });
          }
        }
        // announcedIp advances only after delivery, so a throttled alert is retried.
        if (route.notify && await sendIPChangeNotification('IPv4', route.notify.from, alertV4)) {
          route.state.announcedIp = route.notify.to;
        }
      }
      const [finalV4, finalV6, altGeos] = await Promise.all([geoV4, geoV6, geoAlts]);

      altsNeedingGeo.forEach((alt, i) => {
        const geo = altGeos[i];
        alt.geoAt = Date.now();
        if (geo && (normalizeCountryCode(geo.countryCode) || geo.isp !== 'N/A')) {
          alt.geo = { country: geo.country, countryCode: geo.countryCode, city: geo.city, isp: geo.isp, asn: geo.asn };
        }
      });
      // Retried on later checks until delivered, like the IP change alerts.
      if (divergence && !divergence.notified && current() && await sendRouteDivergenceNotification(divergence, finalV4)) {
        divergence.notified = true;
      }
      if (!sameRouteState(route.state, stored.routeState) || v4Changed || v6Changed) updateObj.routeState = route.state;
      if (JSON.stringify(divergence || null) !== JSON.stringify(stored.routeDivergence || null)) updateObj.routeDivergence = divergence;
      if (finalV6?.ip && finalV6.ip !== stored.lastKnownV6Ip) updateObj.lastKnownV6Ip = finalV6.ip;
      // The announced address's country, once known: the "from" of the next country-change alert.
      if (current()) {
        const v4Code = normalizeCountryCode(finalV4?.countryCode);
        if (v4Code && finalV4.ip === route.state.announcedIp) await rememberAnnouncedCountry('IPv4', v4Code);
        const v6Code = normalizeCountryCode(finalV6?.countryCode);
        const v6Pending = (await chrome.storage.local.get('pendingV6Notice')).pendingV6Notice;
        if (v6Code && !v6Pending) await rememberAnnouncedCountry('IPv6', v6Code);
      }

      if (JSON.stringify(cachedV4) !== JSON.stringify(finalV4)) updateObj.latestV4Info = finalV4;
      if (JSON.stringify(cachedV6) !== JSON.stringify(finalV6)) updateObj.latestV6Info = finalV6;
      await commit(updateObj);
      await withTimeout(current() && updateToolbarDisplay(finalV4, finalV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});

      return result(finalV4, finalV6);
    }
  })();
  // Watchdog: a probe that hangs anywhere must not block every later check.
  const probe = withTimeout(work, PROBE_WATCHDOG_MS, async () => {
    const saved = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError']);
    return { v4Info: saved.latestV4Info || null, v6Info: saved.latestV6Info || null, isOffline: saved.isOffline === true, probeError: saved.probeError === true };
  }).finally(() => {
    if (activeProbePromise === probe) activeProbePromise = null;
  });
  activeProbePromise = probe;
  return probe;
}

// Serialized: an older application finishing late must not overwrite a newer result.
let privacyChain = Promise.resolve();
function applyPrivacyShield() {
  const run = privacyChain.catch(() => false).then(() => applyPrivacyShieldNow());
  privacyChain = run;
  return run;
}

const WEBRTC_POLICIES = ['disable_non_proxied_udp', 'default_public_interface_only'];
const requestedWebRtcPolicy = (settings) => WEBRTC_POLICIES.includes(settings?.antiLeakPolicy) ? settings.antiLeakPolicy : WEBRTC_POLICIES[0];

// The two browser settings are applied independently: a failure of one never skips the other.
async function applyPrivacyShieldNow() {
  let effective = false;
  const settings = (await chrome.storage.local.get('appSettings').catch(() => ({}))).appSettings || {};
  const network = chrome.privacy?.network;
  try {
    if (network?.webRTCIPHandlingPolicy) {
      if (settings.enableAntiLeakShield !== false) {
        const policyMode = requestedWebRtcPolicy(settings);
        await network.webRTCIPHandlingPolicy.set({ value: policyMode });
        const current = await network.webRTCIPHandlingPolicy.get({});
        effective = current.value === policyMode && current.levelOfControl === 'controlled_by_this_extension';
      } else {
        await network.webRTCIPHandlingPolicy.clear({});
      }
    }
  } catch (err) {}
  try {
    if (network?.networkPredictionEnabled) {
      if (settings.enableDnsPrefetchBlock !== false) await network.networkPredictionEnabled.set({ value: false });
      else await network.networkPredictionEnabled.clear({});
    }
  } catch (err) {}
  await chrome.storage.local.set({ shieldEffective: effective });
  return effective;
}

/* ---------- Fast change detection (LeakHalo's own server) ----------
 * An auxiliary WebSocket to LeakHalo's server, which reports the public IP it sees for this
 * connection. While the socket is open Chrome keeps this service worker running (Chrome 116+), so
 * a network change is noticed within seconds even when the popup is closed; the regular providers
 * then verify it immediately. If the server is unreachable, everything works as before on the
 * 30-second alarm. Users can turn it off in Settings (enableFastDetection).
 *
 * Chrome records every failed WebSocket handshake as an error of the extension (shown on
 * chrome://extensions), while failed fetches stay silent. So the channel never dials while the
 * device is offline, and before each attempt it checks with a plain request that the server is
 * reachable. Offline, or where the server is blocked, it waits quietly and retries with backoff.
 */
// Encrypted only: without it, the 30-second checks carry on.
const FAST_CHANNEL_URLS = ['wss://35-232-61-175.sslip.io/v1/ws'];
const FAST_PING_MS = 10_000;
const FAST_PONG_TIMEOUT_MS = 5_000;
const FAST_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const FAST_REACH_TIMEOUT_MS = 5_000;
const FAST_DROP_PROBE_GAP_MS = 10_000;
const fastChannel = { ws: null, enabled: false, connecting: false, urlIndex: 0, attempt: 0, pingTimer: null, pongTimer: null, retryTimer: null, dropProbeAt: 0 };

// The server's health check on the same host and scheme as the socket (wss → https, ws → http).
async function fastServerReachable(wsUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAST_REACH_TIMEOUT_MS);
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/healthz';
    url.search = '';
    await fetch(url.href, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function fastDetectionEnabled(settings) {
  // Off with its own switch, and also when automatic checks are off (it only triggers checks).
  return settings?.enableFastDetection !== false && settings?.enableAutoRefresh !== false;
}

async function syncFastChannel() {
  if (typeof WebSocket === 'undefined') return;
  const { appSettings } = await chrome.storage.local.get('appSettings');
  fastChannel.enabled = fastDetectionEnabled(appSettings);
  if (!fastChannel.enabled) {
    stopFastChannel();
    fastChannel.attempt = 0;
    saveFastBackoff(0); // switched on again later, it connects at once
    // Switched off: the server's last view of this connection is no longer needed.
    await chrome.storage.local.remove?.('fastChannelIp');
    return;
  }
  if (!fastChannel.ws && !fastChannel.retryTimer && !fastChannel.connecting) await connectFastChannel();
}

// The backoff survives the worker being stopped between alarms (session storage is memory only),
// so an unreachable server is not asked again every time the worker wakes.
const FAST_BACKOFF_KEY = 'fastChannelBackoff';
async function fastBackoffWait() {
  const saved = (await chrome.storage.session?.get(FAST_BACKOFF_KEY).catch(() => null))?.[FAST_BACKOFF_KEY];
  if (saved && fastChannel.attempt === 0 && !fastChannel.ws) fastChannel.attempt = saved.attempt || 0;
  return Math.max(0, (saved?.retryAt || 0) - Date.now());
}
function saveFastBackoff(retryAt) {
  chrome.storage.session?.set({ [FAST_BACKOFF_KEY]: { attempt: fastChannel.attempt, retryAt } }).catch(() => {});
}

function stopFastChannel() {
  clearTimeout(fastChannel.retryTimer);
  fastChannel.retryTimer = null;
  clearTimeout(fastChannel.pingTimer);
  clearTimeout(fastChannel.pongTimer);
  const ws = fastChannel.ws;
  fastChannel.ws = null;
  if (ws) { try { ws.close(1000, 'disabled'); } catch (e) {} }
}

// Test-only override URLs: encrypted, or plain only to this machine.
const isAllowedDevChannelUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'wss:' || (u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch (e) {
    return false;
  }
};

async function connectFastChannel() {
  if (!fastChannel.enabled || fastChannel.ws || fastChannel.connecting || fastChannel.retryTimer) return;
  // Offline: wait for the 'online' event (or the next alarm) instead of dialing.
  if (!deviceOnline()) return;
  const wait = await fastBackoffWait();
  if (wait > 0) {
    if (!fastChannel.retryTimer && !fastChannel.ws) fastChannel.retryTimer = setTimeout(() => { fastChannel.retryTimer = null; connectFastChannel(); }, wait);
    return;
  }
  if (!fastChannel.enabled || fastChannel.ws || fastChannel.connecting || fastChannel.retryTimer) return;
  fastChannel.connecting = true;
  let url, reachable;
  try {
    // Test-only override so the end-to-end suite can point the channel at a local stand-in.
    const { devFastChannelUrls } = await chrome.storage.local.get('devFastChannelUrls');
    const devUrls = Array.isArray(devFastChannelUrls) ? devFastChannelUrls.filter(isAllowedDevChannelUrl) : [];
    const urls = devUrls.length ? devUrls : FAST_CHANNEL_URLS;
    url = urls[fastChannel.urlIndex % urls.length];
    reachable = await fastServerReachable(url);
  } finally {
    fastChannel.connecting = false;
  }
  if (!fastChannel.enabled || fastChannel.ws || fastChannel.retryTimer) return;
  if (!reachable) {
    // Unreachable through this address: try the next one after the backoff, unless the device
    // went offline meanwhile (then the 'online' event resumes the channel).
    if (deviceOnline()) { fastChannel.urlIndex++; scheduleFastReconnect(); }
    return;
  }
  let ws;
  try { ws = new WebSocket(url); } catch (e) { fastChannel.urlIndex++; scheduleFastReconnect(); return; }
  fastChannel.ws = ws;
  let opened = false;
  let openedAt = 0;
  const isCurrent = () => fastChannel.enabled && fastChannel.ws === ws;
  ws.onopen = () => {
    if (!isCurrent()) { try { ws.close(1000, 'obsolete'); } catch (e) {} return; }
    opened = true;
    openedAt = Date.now();
    fastChannel.attempt = 0;
    saveFastBackoff(0);
    // The server is reachable again: if the last check found no connection, re-check now.
    chrome.storage.local.get(['isOffline', 'probeError']).then((res) => {
      if (res.isOffline === true || res.probeError === true) fetchAllBackgroundLocations(true).catch(() => {});
    }).catch(() => {});
    let id = 0;
    clearTimeout(fastChannel.pingTimer);
    // Pings keep the socket (and with it this service worker) alive and detect silent drops.
    const ping = () => {
      if (fastChannel.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'ping', id: ++id }));
      } catch (e) {
        try { ws.close(4001, 'send failed'); } catch (_) {}
        return;
      }
      clearTimeout(fastChannel.pongTimer);
      fastChannel.pongTimer = setTimeout(() => { try { ws.close(4000, 'pong timeout'); } catch (e) {} }, FAST_PONG_TIMEOUT_MS);
      fastChannel.pingTimer = setTimeout(ping, FAST_PING_MS);
    };
    fastChannel.pingTimer = setTimeout(ping, FAST_PING_MS);
  };
  ws.onmessage = (event) => {
    if (!isCurrent()) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg?.type === 'pong') clearTimeout(fastChannel.pongTimer);
    if ((msg?.type === 'hello' || msg?.type === 'pong') && (isValidIPv4(msg.ip) || isValidIPv6(msg.ip))) {
      onFastChannelIp(msg.ip, isCurrent).catch(() => {});
    }
  };
  ws.onerror = () => {}; // onclose follows
  ws.onclose = () => {
    // Closed by the network rather than by us: the connection changed or dropped, so check now.
    // A connection that had been up for a while always counts; short-lived ones at most once per
    // 10 s, so a server that keeps dropping fresh connections cannot loop.
    // Offline, the check makes no requests, so it always runs.
    const dropped = opened && fastChannel.ws === ws && (!deviceOnline() ||
      Date.now() - openedAt >= FAST_DROP_PROBE_GAP_MS || Date.now() - fastChannel.dropProbeAt >= FAST_DROP_PROBE_GAP_MS);
    // An obsolete socket (replaced, or the channel switched off) must not touch the current
    // socket's timers or schedule reconnects.
    if (fastChannel.ws !== ws) return;
    fastChannel.ws = null;
    if (dropped) {
      fastChannel.dropProbeAt = Date.now();
      fetchAllBackgroundLocations(true).catch(() => {});
    }
    clearTimeout(fastChannel.pingTimer);
    clearTimeout(fastChannel.pongTimer);
    if (!opened) fastChannel.urlIndex++; // with several addresses, try the next one
    scheduleFastReconnect();
  };
}

function scheduleFastReconnect() {
  if (!fastChannel.enabled || fastChannel.retryTimer) return;
  const delay = FAST_BACKOFF_MS[Math.min(fastChannel.attempt++, FAST_BACKOFF_MS.length - 1)];
  saveFastBackoff(Date.now() + delay);
  fastChannel.retryTimer = setTimeout(() => { fastChannel.retryTimer = null; connectFastChannel(); }, delay);
}

// The server's view of the IP is only a trigger, never displayed: when it differs from the address
// LeakHalo shows for that family, the network may have changed, so the regular providers verify
// now instead of waiting for the alarm. Nothing known yet: the regular first check covers it.
async function onFastChannelIp(rawIp, isCurrent = () => true) {
  const ip = rawIp.includes(':') ? canonicalIPv6(rawIp) : rawIp.trim();
  const { fastChannelIp, latestV4Info, latestV6Info } = await chrome.storage.local.get(['fastChannelIp', 'latestV4Info', 'latestV6Info']);
  if (ip === fastChannelIp || !isCurrent()) return;
  await chrome.storage.local.set({ fastChannelIp: ip });
  const known = ip.includes(':') ? latestV6Info?.ip : latestV4Info?.ip;
  if (known ? ip !== known : !!fastChannelIp) fetchAllBackgroundLocations(true).catch(() => {});
}

// The 30-second alarm exists only while automatic checks are on, so with them off the worker is
// not woken twice a minute for nothing.
const PROBE_ALARM = 'fetchLocationsAlarm';
let alarmCheck = null;
function ensureAlarm() {
  alarmCheck = alarmCheck || (async () => {
    try {
      if (!(await autoChecksEnabled())) {
        await chrome.alarms.clear(PROBE_ALARM);
        return;
      }
      const alarm = await chrome.alarms.get(PROBE_ALARM);
      if (alarm?.periodInMinutes !== 0.5) await chrome.alarms.create(PROBE_ALARM, { periodInMinutes: 0.5 });
    } catch (e) {} finally {
      alarmCheck = null;
    }
  })();
  return alarmCheck;
}
ensureAlarm();

async function autoRefresh() {
  // Revive the channel if the worker was restarted; the worker stays busy until both finish.
  const { appSettings } = await chrome.storage.local.get('appSettings');
  // Slightly below the alarm period, so a probe that ran just before does not skip a whole tick.
  await Promise.all([
    syncFastChannel().catch(() => {}),
    appSettings?.enableAutoRefresh !== false ? fetchAllBackgroundLocations(false, PROBE_INTERVAL_MS - 5_000).catch(() => {}) : null
  ]);
}

// Every worker start already runs the setup at the bottom of this file (alarm, policies, toolbar,
// channel); these events add only what is specific to them.
chrome.runtime.onInstalled.addListener((details) => {
  fetchAllBackgroundLocations(true).catch(() => {});
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  autoChecksEnabled().then(on => on && fetchAllBackgroundLocations(true)).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROBE_ALARM) autoRefresh().catch(() => {});
});

// The settings pages may change, with their allowed values. Anything else in a patch is ignored.
const BOOLEAN_SETTINGS = ['enableNotifications', 'notifyIPv6', 'enableAutoRefresh', 'enableFastDetection', 'warnRouteDivergence',
  'showMap', 'enableAntiLeakShield', 'enableDnsPrefetchBlock', 'enableWebRtcScan', 'showTimeZone', 'maskIp'];
const CHOICE_SETTINGS = { antiLeakPolicy: WEBRTC_POLICIES, badgeMode: ['flag', 'text', 'off'], optionsTheme: ['light', 'dark', 'system'] };
function validSettingsPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  for (const [key, value] of Object.entries(patch)) {
    if (BOOLEAN_SETTINGS.includes(key) ? typeof value === 'boolean' : CHOICE_SETTINGS[key]?.includes(value)) clean[key] = value;
  }
  return clean;
}
const PRIVACY_KEYS = ['enableAntiLeakShield', 'antiLeakPolicy', 'enableDnsPrefetchBlock'];
const TOOLBAR_KEYS = ['badgeMode', 'warnRouteDivergence'];

// Every page changes settings through this queue, field by field, so two pages saving at the same
// time can never overwrite each other's choice with a stale copy.
let settingsChain = Promise.resolve();
// patch: fields to set, or a function of the current settings returning those fields. Only the
// effects of fields that actually changed run (browser policies, toolbar, checks).
function updateSettings(patch) {
  const run = settingsChain.catch(() => {}).then(async () => {
    const { appSettings, shieldEffective: storedEffective } = await chrome.storage.local.get(['appSettings', 'shieldEffective']);
    const previous = appSettings || {};
    const fields = validSettingsPatch(typeof patch === 'function' ? patch(previous) : patch);
    const next = { ...previous, ...fields };
    const changed = (key) => key in fields && fields[key] !== previous[key];
    if (Object.keys(fields).some(changed)) await chrome.storage.local.set({ appSettings: next });
    // Re-applied when a privacy field changed, and as a retry while the policy is not confirmed.
    const shieldEffective = PRIVACY_KEYS.some(changed) || storedEffective !== true
      ? await applyPrivacyShield() : true;
    const autoWasOff = previous.enableAutoRefresh === false;
    if (next.enableAutoRefresh === false) {
      resetOfflineRetry();
      await chrome.alarms.clear(PROBE_ALARM).catch(() => {});
    } else if (autoWasOff) {
      ensureAlarm();
    }
    if (TOOLBAR_KEYS.some(changed)) {
      const res = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError']);
      await updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
    }
    // Checks switched back on, or the route warning turned on (its other routes still need a
    // location): check now instead of waiting for the next alarm.
    if ((autoWasOff && next.enableAutoRefresh !== false) || (changed('warnRouteDivergence') && next.warnRouteDivergence === true)) {
      fetchAllBackgroundLocations(true).catch(() => {});
    }
    return { settings: next, shieldEffective };
  });
  settingsChain = run;
  return run;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own pages talk to the worker.
  if (!request || typeof request !== 'object' || sender?.id !== chrome.runtime.id) return false;
  if (request.type === 'UPDATE_SETTINGS' && request.patch && typeof request.patch === 'object' && !Array.isArray(request.patch)) {
    updateSettings(request.patch)
      .then(({ settings, shieldEffective }) => sendResponse({ status: 'ok', settings, shieldEffective }))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'REFRESH_NOW') {
    fetchAllBackgroundLocations(true).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'CHECK_NETWORK') {
    // While LeakHalo's server connection is up it reports a changed IP within seconds (and a
    // dropped connection triggers a check), so the open popup asks the providers less often.
    const interval = fastChannel.ws?.readyState === 1 ? POPUP_PROBE_WITH_CHANNEL_MS : POPUP_PROBE_INTERVAL_MS;
    fetchAllBackgroundLocations(request.force === true, interval).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'TOGGLE_SHIELD') {
    (async () => {
      const explicit = typeof request.explicitState === 'boolean' ? request.explicitState : null;
      const { settings, shieldEffective } = await updateSettings(current =>
        ({ enableAntiLeakShield: explicit ?? current.enableAntiLeakShield === false }));
      sendResponse({ status: 'ok', shieldActive: settings.enableAntiLeakShield, shieldEffective });
    })().catch(() => sendResponse({ status: 'error' }));
    return true;
  }
});

chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError'], (res) => {
  updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
});
applyPrivacyShield();
syncFastChannel().catch(() => {});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes.appSettings || changes.devFastChannelUrls)) syncFastChannel().catch(() => {});
});
// Network events: back online, reconnect and check right away; offline, show it right away.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('online', () => {
    fastChannel.attempt = 0;
    saveFastBackoff(0);
    clearTimeout(fastChannel.retryTimer);
    fastChannel.retryTimer = null;
    syncFastChannel().catch(() => {});
    resetOfflineRetry();
    autoChecksEnabled().then(on => on && fetchAllBackgroundLocations(true)).catch(() => {});
  });
  // Lost the network: show it in the toolbar at once (the check makes no requests while offline).
  self.addEventListener('offline', () => {
    autoChecksEnabled().then(on => on && fetchAllBackgroundLocations(true)).catch(() => {});
  });
}

const webRtcPolicy = chrome.privacy?.network?.webRTCIPHandlingPolicy;
if (webRtcPolicy?.onChange) {
  // Queued behind any policy change in progress, so a late event cannot overwrite a newer result.
  webRtcPolicy.onChange.addListener((details) => {
    if (details.incognitoSpecific) return;
    privacyChain = privacyChain.catch(() => false).then(async () => {
      const { appSettings } = await chrome.storage.local.get('appSettings');
      const shieldEffective = appSettings?.enableAntiLeakShield !== false &&
        details.value === requestedWebRtcPolicy(appSettings) && details.levelOfControl === 'controlled_by_this_extension';
      await chrome.storage.local.set({ shieldEffective });
      return shieldEffective;
    });
    return privacyChain;
  });
}
