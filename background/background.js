
let activeProbePromise = null;
let queuedForceProbePromise = null;
const PROBE_INTERVAL_MS = 30_000;
const POPUP_PROBE_INTERVAL_MS = 3_000;
const GEO_RETRY_INTERVAL_MS = 15 * 60_000;
const MANUAL_GEO_REFRESH_MS = 5 * 60_000;
const GEO_MEMORY_CACHE_MS = 30 * 60_000;
// Upper bounds so no single step can leave the extension stuck (e.g. on "Locating...").
let GEO_LOOKUP_TIMEOUT_MS = 15_000;
let PROBE_WATCHDOG_MS = 30_000;
let TOOLBAR_WAIT_MS = 5_000;
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

async function loadFlagBitmap(countryCode) {
  if (!/^[a-z]{2}$/i.test(countryCode || '')) return null;
  try {
    const url = chrome.runtime.getURL(`assets/flags/flag-${countryCode.toLowerCase()}.png`);
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (e) {
    return null;
  }
}

async function renderSplitFlagImageData(code1, code2, size = 48) {
  try {
    const [bitmap1, bitmap2] = await Promise.all([
      loadFlagBitmap(code1),
      loadFlagBitmap(code2)
    ]);

    if (!bitmap1 || !bitmap2) return null;

    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(size, size);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
    } else {
      return null;
    }
    const ctx = canvas.getContext('2d');

    const scale = size / 48;
    const splitX = Math.round(24 * scale);
    // Square flags fill the whole icon, so the divider runs full height.
    const topY = 0;
    const bottomY = size;

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

    ctx.strokeStyle = '#0b0e14';
    ctx.lineWidth = Math.max(1, Math.round(2 * scale));
    ctx.beginPath();
    ctx.moveTo(splitX, topY);
    ctx.lineTo(splitX, bottomY);
    ctx.stroke();

    return ctx.getImageData(0, 0, size, size);
  } catch (err) {
    return null;
  }
}

async function renderDisconnectedIcon(size = 48) {
  try {
    const url = chrome.runtime.getURL('assets/icons/icon48.png');
    const response = await fetch(url);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(size, size);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
    } else {
      return null;
    }

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
    ctx.putImageData(imgData, 0, 0);
    return ctx.getImageData(0, 0, size, size);
  } catch (e) {
    return null;
  }
}

const DEFAULT_ACTION_ICON = { path: { "16": "/assets/icons/icon16.png", "48": "/assets/icons/icon48.png" } };
let toolbarRenderSeq = 0;
let toolbarApplyChain = Promise.resolve();

async function renderedActionIcon(render) {
  const [img16, img32, img48] = await Promise.all([render(16), render(32), render(48)]);
  if (!img48) return null;
  const imageData = { "48": img48 };
  if (img16) imageData["16"] = img16;
  if (img32) imageData["32"] = img32;
  return { imageData };
}

// Works out icon, badge and title for the current state without touching the toolbar.
async function planToolbar(v4Info, v6Info, isOffline, probeError) {
  const res = await chrome.storage.local.get(['appSettings', 'routeDivergence']);
  const badgeMode = (res.appSettings && res.appSettings.badgeMode) ? res.appSettings.badgeMode : 'flag';

  // Failure states take precedence over cached locations: a stale flag must not look verified.
  if (isOffline || probeError || (!v4Info?.ip && !v6Info?.ip)) {
    const icon = await renderedActionIcon(renderDisconnectedIcon).catch(() => null);
    return {
      icon: icon || DEFAULT_ACTION_ICON,
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
  const primaryName = v4Info?.country || v6Info?.country || 'Connected';
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
  lines.push(primaryCode ? `Location: ${primaryName} (${primaryCode})` : `LeakHalo: ${primaryName}`);
  const title = lines.join('\n');
  const warning = !!divergence || isV4V6Split;

  if (badgeMode === 'off') {
    return { icon: DEFAULT_ACTION_ICON, badgeText: divergence ? '!' : '', badgeColor: '#f59e0b', title };
  }

  // Two flags: IPv4/IPv6 split first, otherwise a divergence whose routes are in different countries.
  const secondCode = isV4V6Split ? v6Code : (v4Code ? altCode : '');
  let icon = null;
  if (primaryCode && secondCode) {
    icon = await renderedActionIcon(size => renderSplitFlagImageData(v4Code || primaryCode, secondCode, size)).catch(() => null);
  }
  if (!icon && primaryCode) {
    const flagPath = `/assets/flags/flag-${primaryCode.toLowerCase()}.png`;
    icon = { path: { "16": flagPath, "32": flagPath, "48": flagPath } };
  }

  let badgeText = '';
  let badgeColor = null;
  if (badgeMode === 'text' && primaryCode) {
    badgeText = primaryCode;
    badgeColor = warning ? '#f59e0b' : '#0284c7';
  } else if (divergence) {
    // Same-country or unknown-country divergence still needs a visible marker.
    badgeText = '!';
    badgeColor = '#f59e0b';
  } else if (!primaryCode) {
    badgeText = 'ON';
    badgeColor = '#10b981';
  }
  return { icon: icon || DEFAULT_ACTION_ICON, badgeText, badgeColor, title };
}

// Renders are planned concurrently but applied one at a time, and a plan superseded by a newer
// call is dropped, so an older render can never overwrite newer state.
async function updateToolbarDisplay(v4Info, v6Info, isOffline = false, probeError = false) {
  const seq = ++toolbarRenderSeq;
  const plan = await planToolbar(v4Info, v6Info, isOffline, probeError).catch(() => null);
  if (!plan) return;
  toolbarApplyChain = toolbarApplyChain.catch(() => {}).then(async () => {
    if (seq !== toolbarRenderSeq) return;
    try {
      await chrome.action.setIcon(plan.icon);
    } catch (e) {
      await chrome.action.setIcon(DEFAULT_ACTION_ICON).catch(() => {});
    }
    await chrome.action.setBadgeText({ text: plan.badgeText });
    if (plan.badgeColor) await chrome.action.setBadgeBackgroundColor({ color: plan.badgeColor });
    await chrome.action.setTitle({ title: plan.title });
  });
  return toolbarApplyChain;
}

// Returns true when the change counts as announced (shown, or notifications are switched off) and
// false when it was throttled or failed, so the caller can retry it on a later probe.
async function sendIPChangeNotification(type, oldIp, newGeo) {
  try {
    const now = Date.now();
    const stored = await chrome.storage.local.get(['lastNotifTime', 'appSettings']);
    const enableNotifs = stored.appSettings ? stored.appSettings.enableNotifications !== false : true;
    if (!enableNotifs) return true;
    const lastNotif = stored.lastNotifTime || 0;
    if (now - lastNotif < 4000) return false;
    await chrome.storage.local.set({ lastNotifTime: now });

    const notifId = `ip_change_${now}`;
    const flagEmoji = newGeo.countryCode ? ` (${newGeo.countryCode})` : '';
    const knownCountry = normalizeCountryCode(newGeo.countryCode) ? ` in ${newGeo.country}` : '';
    const message = oldIp
      ? `Changed from ${oldIp} to ${newGeo.ip}${knownCountry}`
      : `Connected with ${newGeo.ip}${knownCountry}`;

    const iconUrl = normalizeCountryCode(newGeo.countryCode)
      ? chrome.runtime.getURL(`assets/flags/flag-${newGeo.countryCode.toLowerCase()}.png`)
      : chrome.runtime.getURL('assets/icons/icon48.png');

    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: iconUrl,
      title: `🌍 ${type} IP Changed${flagEmoji}`,
      message: message,
      priority: 2
    }, () => {});
    return true;
  } catch (e) {
    return false;
  }
}

async function sendRouteDivergenceNotification(divergence, primaryInfo) {
  try {
    const now = Date.now();
    // Separate throttle: an IP-change notification a moment earlier must not swallow this one,
    // which fires only once per confirmed divergence.
    const stored = await chrome.storage.local.get(['lastRouteNotifTime', 'appSettings']);
    if (stored.appSettings?.warnRouteDivergence !== true) return; // warning is opt-in
    if (now - (stored.lastRouteNotifTime || 0) < 4000) return;
    if (stored.appSettings && stored.appSettings.enableNotifications === false) return;
    await chrome.storage.local.set({ lastRouteNotifTime: now });
    const where = (ip, info) => normalizeCountryCode(info?.countryCode) ? `${ip} (${info.country})` : ip;
    const alts = divergence.alts.map(alt => `${alt.source}: ${where(alt.ip, alt.geo)}`).join('\n');
    chrome.notifications.create(`route_divergence_${now}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon48.png'),
      title: '⚠️ Sites see different IPs',
      message: `${divergence.primarySource}: ${where(divergence.primaryIp, primaryInfo)}\n${alts}\nA proxy, VPN rule or your internet provider's routing sends some sites through a different IP.`,
      priority: 2
    }, () => {});
  } catch (e) {}
}

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
      signal: controller.signal
    });
    if (res.status === 429) {
      const retryAfter = res.headers?.get?.('Retry-After');
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter || '') - Date.now());
      const delay = Math.min(24 * 60 * 60_000, Math.max(5 * 60_000, parsed || 0));
      providerCooldowns[origin] = Date.now() + delay;
      await chrome.storage.local.set({ providerCooldowns }).catch(() => {});
    }
    // Read the body under the same deadline: a server that sends headers and then stalls must not
    // hold up the probe (and every check queued behind it).
    const aborted = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('Timed out'));
      controller.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    });
    const body = await Promise.race([res.text(), aborted]);
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

function isValidIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isValidIPv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':') || ip.length > 39 || !/^[0-9a-f:]+$/i.test(ip)) return false;
  try {
    new URL(`http://[${ip}]/`);
    return true;
  } catch (e) {
    return false;
  }
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
    const ipMatch = text.match(/ip=([^\n]+)/);
    const locMatch = text.match(/loc=([^\n]+)/);
    if (ipMatch && isValidIPv4(ipMatch[1].trim())) {
      return {
        ip: ipMatch[1].trim(),
        countryCode: locMatch && locMatch[1] ? locMatch[1].trim().toUpperCase() : '',
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
    firstIPv4([cloudflare, plain(`https://ipv4.icanhazip.com?${buster}`, 'icanhazip')]),
    firstIPv4([ipify, plain(`https://checkip.amazonaws.com?${buster}`, 'Amazon')])
  ]);
  return { edge, independent };
}

const ROUTE_PAIR_TTL_MS = 2 * 60_000;   // "consecutive" probes must also be close in time
// A mismatch must also last this long: while a VPN connects, old connections keep the previous
// route for a few seconds, and fast checks would otherwise report that transition as a split.
let ROUTE_MIN_PERSIST_MS = 15_000;
const FALLBACK_CONFIRMATIONS = 2;        // independent-only answers needed to replace an edge IP
const GROUP_MISSES_AS_KNOWN = 2;         // a group silent this long no longer vouches for an old IP

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
    const knownAlternate = (!!div && div.alts.some(alt => alt.ip === independent.ip)) ||
      st.altSeen.list.some(seen => seen.ip === independent.ip);
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
  // With no IPv4 answer at all nothing was learned, so keep what is shown and all evidence.
  const noAnswer = !edge && !independent;
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
      if (own) div.alts = div.alts.filter(alt => alt !== own); // this provider now agrees
      st.altSeen.list = st.altSeen.list.filter(seen => seen.source !== independent.source);
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

async function getFastPublicIPv6() {
  const buster = `_t=${Date.now()}`;
  const endpoints = [
    () => fetchWithTimeout(`https://api6.ipify.org?format=json&${buster}`, {}, 2200).then(async (res) => {
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data && isValidIPv6(data.ip)) {
        return data.ip.trim();
      }
      throw new Error();
    }),
    () => fetchWithTimeout(`https://ipv6.icanhazip.com?${buster}`, {}, 2200).then(async (res) => {
      if (!res.ok) throw new Error();
      const text = await res.text();
      if (isValidIPv6(text?.trim())) {
        return text.trim();
      }
      throw new Error();
    })
  ];

  for (const endpoint of endpoints) {
    try { return await endpoint(); } catch (e) {}
  }
  return null;
}

function getFullCountryName(code, fallbackName) {
  // Short names where the CLDR English label is longer than the ISO 3166-1 short name.
  const shortNames = { PS: 'Palestine' };
  if (code && shortNames[code.toUpperCase()]) return shortNames[code.toUpperCase()];
  if (code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      const name = dn.of(code.toUpperCase());
      if (name && name !== code.toUpperCase()) return name;
    } catch (e) {}
  }
  const cleanFallback = (typeof fallbackName === 'string' && !fallbackName.startsWith('Unknown') && !fallbackName.startsWith('Detected')) ? fallbackName : '';
  if (cleanFallback && cleanFallback.length > 2) {
    return cleanFallback;
  }
  return code || cleanFallback || 'Unknown Country';
}

function normalizeCountryCode(code) {
  return typeof code === 'string' && /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : '';
}

function normalizeCoordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function classifyConnectionType(data) {
  const isp = (data.isp || '').toLowerCase();
  const org = (data.org || '').toLowerCase();
  const domain = (data.domain || '').toLowerCase();
  const rawType = (data.type || '').toLowerCase();

  if (data.isVpn || data.isProxy || rawType === 'vpn' || rawType === 'proxy') {
    return 'VPN / Relay';
  }
  if (data.isHosting || rawType === 'hosting' || rawType === 'datacenter') {
    return 'Datacenter';
  }
  if (data.isMobile || rawType === 'cellular' || rawType === 'mobile') {
    return 'Mobile';
  }

  const datacenterKeywords = [
    'hetzner', 'ovh', 'digitalocean', 'amazon', 'aws', 'google cloud', 'linode',
    'vultr', 'm247', 'leaseweb', 'choopa', 'oracle', 'cloudflare', 'fastly',
    'serverius', 'contabo', 'hostinger', 'tencent', 'alibaba', 'azure', 'akamai',
    'datacenter', 'data center', 'hosting', 'cloud', 'servers', 'server', 'vps', 'dedicated',
    'hivelocity', 'cogent', 'psychz', 'quadranet', 'scaleway', 'equinix', 'ipvolume'
  ];

  for (const kw of datacenterKeywords) {
    if (isp.includes(kw) || org.includes(kw) || domain.includes(kw)) {
      return 'Datacenter';
    }
  }

  if (['residential', 'isp', 'broadband'].includes(rawType)) return 'Residential';
  return 'Unknown';
}

async function getGeoLocation(ip, initialCountryCode = '', useRecentCache = true) {
  const cached = useRecentCache ? geoMemoryCache.get(ip) : null;
  if (cached && Date.now() - cached.updatedAt < GEO_MEMORY_CACHE_MS) {
    geoMemoryCache.delete(ip);
    geoMemoryCache.set(ip, cached);
    return { ...cached, updatedAt: Date.now() };
  }
  const result = await withTimeout(fetchGeoLocation(ip, initialCountryCode), GEO_LOOKUP_TIMEOUT_MS,
    () => unresolvedGeoInfo(ip, initialCountryCode));
  if (result.countryCode || result.isp !== 'N/A') {
    geoMemoryCache.delete(ip);
    geoMemoryCache.set(ip, result);
    if (geoMemoryCache.size > 16) geoMemoryCache.delete(geoMemoryCache.keys().next().value);
  }
  return result;
}

async function fetchGeoLocation(ip, initialCountryCode = '') {
  const buster = `_t=${Date.now()}`;
  if (!isValidIPv4(ip) && !isValidIPv6(ip)) throw new Error('Invalid IP address');

  try {
    const res = await fetchWithTimeout(`https://ipwho.is/${ip}?${buster}`, {}, 3800);
    if (res.ok) {
      const data = await res.json();
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
          city: data.city || '',
          region: data.region || '',
          isp: ispStr,
          asn: data.connection && data.connection.asn ? `AS${data.connection.asn}` : 'N/A',
          timezone: (data.timezone && data.timezone.id) || 'N/A',
          connectionType: connType,
          lat: normalizeCoordinate(data.latitude, 90),
          lon: normalizeCoordinate(data.longitude, 180),
          updatedAt: Date.now()
        };
      }
    }
  } catch (e) {}

  try {
    const res = await fetchWithTimeout(`https://get.geojs.io/v1/ip/geo/${ip}.json?${buster}`, {}, 3500);
    if (res.ok) {
      const data = await res.json();
      if (data && (data.country_code || data.country)) {
        const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
        const countryName = getFullCountryName(countryCode, data.country);
        const asnStr = data.asn ? `AS${data.asn}` : 'N/A';
        const ispStr = data.organization_name || data.organization || 'N/A';
        const connType = classifyConnectionType({
          isp: ispStr,
          org: data.organization || data.organization_name
        });

        return {
          ip,
          country: countryName,
          countryCode: countryCode,
          city: data.city || '',
          region: data.region || '',
          isp: ispStr,
          asn: asnStr,
          timezone: data.timezone || 'N/A',
          connectionType: connType,
          lat: normalizeCoordinate(data.latitude, 90),
          lon: normalizeCoordinate(data.longitude, 180),
          updatedAt: Date.now()
        };
      }
    }
  } catch (e) {}

  try {
    const res = await fetchWithTimeout(`https://ipinfo.io/${ip}/json?${buster}`, {}, 3500);
    if (res.ok) {
      const data = await res.json();
      if (data && data.country && !data.error) {
        const countryCode = normalizeCountryCode(data.country);
        const countryName = getFullCountryName(countryCode, '');
        let lat = null;
        let lon = null;
        if (data.loc) {
          const parts = data.loc.split(',');
          lat = normalizeCoordinate(parts[0], 90);
          lon = normalizeCoordinate(parts[1], 180);
        }
        let asnStr = 'N/A';
        let ispStr = data.org || 'N/A';
        const orgMatch = (data.org || '').match(/^(AS\d+)\s*(.*)$/i);
        if (orgMatch) {
          asnStr = orgMatch[1].toUpperCase();
          ispStr = orgMatch[2] || orgMatch[1];
        }
        const connType = classifyConnectionType({
          isp: ispStr,
          org: data.org
        });

        return {
          ip,
          country: countryName,
          countryCode: countryCode,
          city: data.city || '',
          region: data.region || '',
          isp: ispStr,
          asn: asnStr,
          timezone: data.timezone || 'N/A',
          connectionType: connType,
          lat: lat,
          lon: lon,
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
async function internetReachable() {
  const ping = (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    return fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(timer));
  };
  try {
    await Promise.any([ping('https://cloudflare.com/cdn-cgi/trace'), ping('https://api.ipify.org/')]);
    return true;
  } catch (e) {
    return false;
  }
}

// repeat: keep retrying every 15 s after the quick steps. Without it (the browser itself reports
// offline, so the 'online' event will follow) only the quick steps run, as a safety net in case
// that event never reaches this worker, e.g. when Chrome starts before the network is up.
function scheduleOfflineRetry(repeat = true) {
  if (offlineRetry.timer || (!repeat && offlineRetry.step >= OFFLINE_RETRY_MS.length)) return;
  const delay = OFFLINE_RETRY_MS[Math.min(offlineRetry.step++, OFFLINE_RETRY_MS.length - 1)];
  offlineRetry.timer = setTimeout(() => {
    offlineRetry.timer = null;
    fetchAllBackgroundLocations(true).catch(() => {});
  }, delay);
}

function resetOfflineRetry() {
  clearTimeout(offlineRetry.timer);
  offlineRetry.timer = null;
  offlineRetry.step = 0;
}

async function fetchAllBackgroundLocations(forceRefresh = false, minimumIntervalMs = PROBE_INTERVAL_MS) {
  if (activeProbePromise) {
    if (!forceRefresh) return activeProbePromise;
    if (!queuedForceProbePromise) {
      queuedForceProbePromise = activeProbePromise.catch(() => {}).then(() =>
        fetchAllBackgroundLocations(true, minimumIntervalMs)
      ).finally(() => { queuedForceProbePromise = null; });
    }
    return queuedForceProbePromise;
  }

  // A probe abandoned by the watchdog may still finish later; it must not overwrite newer state.
  const generation = ++probeGeneration;
  const current = () => generation === probeGeneration;
  const commit = async (values) => { if (current()) await chrome.storage.local.set(values); };
  const work = (async () => {
    {
      const stored = await chrome.storage.local.get([
        'latestV4Info',
        'latestV6Info',
        'isOffline',
        'appSettings',
        'lastProbeAt',
        'routeState',
        'routeDivergence'
      ]);

      const cachedV4 = stored.latestV4Info || null;
      const cachedV6 = stored.latestV6Info || null;
      if (!forceRefresh && Date.now() - (stored.lastProbeAt || 0) < minimumIntervalMs) {
        return { v4Info: cachedV4, v6Info: cachedV6, isOffline: stored.isOffline === true };
      }

      await commit({ lastProbeAt: Date.now() });

      // The browser knows it has no network: show that at once, without requests that can only fail.
      // Mostly the 'online' event (or the alarm, if the worker slept) ends this state.
      if (!deviceOnline()) {
        await commit({ isOffline: true, probeError: false });
        if (current()) scheduleOfflineRetry(false);
        await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, true, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
        return { v4Info: cachedV4, v6Info: cachedV6, isOffline: true, probeError: false };
      }

      const [observation, fastV6] = await Promise.all([
        probePublicIPv4(),
        getFastPublicIPv6()
      ]);
      const route = evaluateIPv4Route(observation, cachedV4, stored.routeState, stored.routeDivergence || null);
      const fastV4 = route.primary;
      const v4Held = route.held;

      if (!fastV4 && !fastV6 && !v4Held) {
        // Every provider failed. If not even a plain request gets an answer, there is no working
        // connection, although the browser may still report one (virtual network adapters, Wi-Fi
        // without internet). Otherwise the providers are the problem ("ERR").
        const isOffline = !deviceOnline() || !(await internetReachable());
        await commit({ isOffline, probeError: !isOffline, routeState: route.state });
        if (isOffline && current()) scheduleOfflineRetry();
        await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, isOffline, !isOffline).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
        return { v4Info: cachedV4, v6Info: cachedV6, isOffline, probeError: !isOffline };
      }
      resetOfflineRetry();

      const v4Changed = !!fastV4 && cachedV4?.ip !== fastV4.ip;
      const v6Changed = !!fastV6 && cachedV6?.ip !== fastV6;
      const retainedV4 = v4Held ? cachedV4 : null;
      const pendingV4 = fastV4
        ? (v4Changed ? { ...makePendingGeoInfo(fastV4.ip, fastV4.countryCode), vantage: fastV4.vantage } : cachedV4)
        : retainedV4;
      const pendingV6 = fastV6 ? (v6Changed ? makePendingGeoInfo(fastV6) : cachedV6) : null;
      const updateObj = { isOffline: false, probeError: false, v4Unverified: v4Held, lastCheckedAt: Date.now() };

      if (v4Changed || v6Changed) {
        updateObj.latestV4Info = pendingV4;
        updateObj.latestV6Info = pendingV6;
        await commit(updateObj);
        if (route.notify && v4Changed && current() && await sendIPChangeNotification('IPv4', route.notify.from, pendingV4)) {
          route.state.announcedIp = route.notify.to;
        }
        if (v6Changed && cachedV6?.ip && stored.appSettings?.notifyIPv6 !== false && current()) sendIPChangeNotification('IPv6', cachedV6.ip, pendingV6);
        await withTimeout(current() && updateToolbarDisplay(pendingV4, pendingV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
      }

      // Geolocate alternate routes when first confirmed, and retry missing metadata on the same
      // schedule as the primary IP.
      const divergence = route.divergence;
      const altsNeedingGeo = divergence && stored.appSettings?.warnRouteDivergence === true ? divergence.alts.filter(alt => {
        const age = Date.now() - (alt.geoAt || 0);
        return !normalizeCountryCode(alt.geo?.countryCode) &&
          (age >= GEO_RETRY_INTERVAL_MS || (forceRefresh && age >= MANUAL_GEO_REFRESH_MS));
      }) : [];
      const [finalV4, finalV6, altGeos] = await Promise.all([
        (async () => {
          if (!fastV4) {
            // A held IP may still be an unfinished placeholder from an interrupted probe.
            if (!retainedV4?.pending) return retainedV4;
            const info = await getGeoLocation(retainedV4.ip, retainedV4.countryCode);
            return { ...info, vantage: retainedV4.vantage };
          }
          const age = Date.now() - (cachedV4?.updatedAt || 0);
          const needsEnrichment = v4Changed || !cachedV4?.updatedAt || cachedV4.pending === true ||
            (!cachedV4.countryCode && age >= GEO_RETRY_INTERVAL_MS) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          const info = needsEnrichment ? await getGeoLocation(fastV4.ip, fastV4.countryCode, v4Changed) : cachedV4;
          return info && info.vantage !== fastV4.vantage ? { ...info, vantage: fastV4.vantage } : info;
        })(),
        (async () => {
          if (!fastV6) return null;
          const age = Date.now() - (cachedV6?.updatedAt || 0);
          const needsEnrichment = v6Changed || !cachedV6?.updatedAt || cachedV6.pending === true ||
            (!cachedV6.countryCode && age >= GEO_RETRY_INTERVAL_MS) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          return needsEnrichment ? getGeoLocation(fastV6, '', v6Changed) : cachedV6;
        })(),
        Promise.all(altsNeedingGeo.map(alt => getGeoLocation(alt.ip).catch(() => null)))
      ]);

      altsNeedingGeo.forEach((alt, i) => {
        const geo = altGeos[i];
        alt.geoAt = Date.now();
        if (geo && (normalizeCountryCode(geo.countryCode) || geo.isp !== 'N/A')) {
          alt.geo = { country: geo.country, countryCode: geo.countryCode, city: geo.city, isp: geo.isp, asn: geo.asn };
        }
      });
      if (route.confirmed.length && current()) sendRouteDivergenceNotification(divergence, finalV4);
      // A change confirmed on a later probe (the IP itself did not change on this one).
      if (route.notify && !v4Changed && current() && await sendIPChangeNotification('IPv4', route.notify.from, finalV4)) {
        route.state.announcedIp = route.notify.to;
      }
      updateObj.routeState = route.state;
      updateObj.routeDivergence = divergence;

      if (JSON.stringify(cachedV4) !== JSON.stringify(finalV4)) updateObj.latestV4Info = finalV4;
      if (JSON.stringify(cachedV6) !== JSON.stringify(finalV6)) updateObj.latestV6Info = finalV6;
      await commit(updateObj);
      await withTimeout(current() && updateToolbarDisplay(finalV4, finalV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});

      return { v4Info: finalV4, v6Info: finalV6, isOffline: false };
    }
  })();
  // Watchdog: a probe that hangs anywhere must not block every later check.
  const probe = withTimeout(work, PROBE_WATCHDOG_MS, async () => {
    const saved = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline']);
    return { v4Info: saved.latestV4Info || null, v6Info: saved.latestV6Info || null, isOffline: saved.isOffline === true };
  }).finally(() => {
    if (activeProbePromise === probe) activeProbePromise = null;
  });
  activeProbePromise = probe;
  return probe;
}

async function applyPrivacyShield() {
  let effective = false;
  try {
    const res = await chrome.storage.local.get('appSettings');
    const settings = res.appSettings || {};
    const shieldActive = settings.enableAntiLeakShield !== false;
    const policyMode = settings.antiLeakPolicy || 'disable_non_proxied_udp';
    const blockDnsPrefetch = settings.enableDnsPrefetchBlock !== false;

    if (chrome.privacy && chrome.privacy.network) {
      if (chrome.privacy.network.webRTCIPHandlingPolicy) {
        if (shieldActive) {
          await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: policyMode });
          const current = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
          effective = current.value === policyMode && current.levelOfControl === 'controlled_by_this_extension';
        } else {
          await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
        }
      }

      if (chrome.privacy.network.networkPredictionEnabled) {
        if (blockDnsPrefetch) {
          await chrome.privacy.network.networkPredictionEnabled.set({ value: false });
        } else {
          await chrome.privacy.network.networkPredictionEnabled.clear({});
        }
      }
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
const FAST_CHANNEL_URLS = ['wss://35-232-61-175.sslip.io/v1/ws', 'ws://35.232.61.175/v1/ws'];
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
  if (!fastChannel.enabled) { stopFastChannel(); return; }
  if (!fastChannel.ws && !fastChannel.retryTimer && !fastChannel.connecting) connectFastChannel();
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

async function connectFastChannel() {
  if (!fastChannel.enabled || fastChannel.ws || fastChannel.connecting) return;
  // Offline: wait for the 'online' event (or the next alarm) instead of dialing.
  if (!deviceOnline()) return;
  fastChannel.connecting = true;
  let url, reachable;
  try {
    // Test-only override so the end-to-end suite can point the channel at a local stand-in.
    const { devFastChannelUrls } = await chrome.storage.local.get('devFastChannelUrls');
    const urls = Array.isArray(devFastChannelUrls) && devFastChannelUrls.length ? devFastChannelUrls : FAST_CHANNEL_URLS;
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
  ws.onopen = () => {
    opened = true;
    openedAt = Date.now();
    fastChannel.attempt = 0;
    // The server is reachable again: if the last check found no connection, re-check now.
    chrome.storage.local.get(['isOffline', 'probeError']).then((res) => {
      if (res.isOffline === true || res.probeError === true) fetchAllBackgroundLocations(true).catch(() => {});
    }).catch(() => {});
    let id = 0;
    clearTimeout(fastChannel.pingTimer);
    // Pings keep the socket (and with it this service worker) alive and detect silent drops.
    const ping = () => {
      if (fastChannel.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'ping', id: ++id }));
      clearTimeout(fastChannel.pongTimer);
      fastChannel.pongTimer = setTimeout(() => { try { ws.close(4000, 'pong timeout'); } catch (e) {} }, FAST_PONG_TIMEOUT_MS);
      fastChannel.pingTimer = setTimeout(ping, FAST_PING_MS);
    };
    fastChannel.pingTimer = setTimeout(ping, FAST_PING_MS);
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg?.type === 'pong') clearTimeout(fastChannel.pongTimer);
    if ((msg?.type === 'hello' || msg?.type === 'pong') && (isValidIPv4(msg.ip) || isValidIPv6(msg.ip))) {
      onFastChannelIp(msg.ip).catch(() => {});
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
    if (fastChannel.ws === ws) fastChannel.ws = null;
    if (dropped) {
      fastChannel.dropProbeAt = Date.now();
      fetchAllBackgroundLocations(true).catch(() => {});
    }
    clearTimeout(fastChannel.pingTimer);
    clearTimeout(fastChannel.pongTimer);
    if (!opened) fastChannel.urlIndex++; // try the next address (wss first, then plain ws)
    scheduleFastReconnect();
  };
}

function scheduleFastReconnect() {
  if (!fastChannel.enabled || fastChannel.retryTimer) return;
  const delay = FAST_BACKOFF_MS[Math.min(fastChannel.attempt++, FAST_BACKOFF_MS.length - 1)];
  fastChannel.retryTimer = setTimeout(() => { fastChannel.retryTimer = null; connectFastChannel(); }, delay);
}

async function onFastChannelIp(ip) {
  const { fastChannelIp } = await chrome.storage.local.get('fastChannelIp');
  if (ip === fastChannelIp) return;
  await chrome.storage.local.set({ fastChannelIp: ip });
  // First value is a baseline. Afterwards a different IP means the network changed: verify now
  // with the regular providers instead of waiting for the alarm. Only a trigger, never displayed.
  if (fastChannelIp) fetchAllBackgroundLocations(true).catch(() => {});
}

function ensureAlarm() {
  chrome.alarms.get('fetchLocationsAlarm', (alarm) => {
    if (alarm?.periodInMinutes !== 0.5) {
      chrome.alarms.create('fetchLocationsAlarm', { periodInMinutes: 0.5 });
    }
  });
}
ensureAlarm();

async function autoRefresh() {
  syncFastChannel().catch(() => {}); // revive the channel if the worker was restarted
  const { appSettings } = await chrome.storage.local.get('appSettings');
  // Slightly below the alarm period, so a probe that ran just before does not skip a whole tick.
  if (appSettings?.enableAutoRefresh !== false) return fetchAllBackgroundLocations(false, PROBE_INTERVAL_MS - 5_000);
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  syncFastChannel().catch(() => {});
  applyPrivacyShield();
  chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError'], (res) => {
    updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
  });
  fetchAllBackgroundLocations(true);
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  syncFastChannel().catch(() => {});
  applyPrivacyShield();
  chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError'], (res) => {
    updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
  });
  fetchAllBackgroundLocations(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchLocationsAlarm') {
    autoRefresh();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'REFRESH_NOW') {
    fetchAllBackgroundLocations(true).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'CHECK_NETWORK') {
    fetchAllBackgroundLocations(request.force === true, POPUP_PROBE_INTERVAL_MS).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'SETTINGS_UPDATED') {
    applyPrivacyShield().then(() => {
      chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError'], (res) => {
        updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
      });
      sendResponse({ status: 'ok' });
    });
    return true;
  }
  if (request.type === 'TOGGLE_SHIELD') {
    chrome.storage.local.get('appSettings', async (res) => {
      const current = res.appSettings || {};
      const newStatus = (typeof request.explicitState === 'boolean')
        ? request.explicitState
        : (current.enableAntiLeakShield === false ? true : false);
      current.enableAntiLeakShield = newStatus;
      await chrome.storage.local.set({ appSettings: current });
      const shieldEffective = await applyPrivacyShield();
      sendResponse({ status: 'ok', shieldActive: newStatus, shieldEffective });
    });
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
    clearTimeout(fastChannel.retryTimer);
    fastChannel.retryTimer = null;
    syncFastChannel().catch(() => {});
    resetOfflineRetry();
    fetchAllBackgroundLocations(true).catch(() => {});
  });
  // Lost the network: show it in the toolbar at once (the check makes no requests while offline).
  self.addEventListener('offline', () => {
    fetchAllBackgroundLocations(true).catch(() => {});
  });
}

const webRtcPolicy = chrome.privacy?.network?.webRTCIPHandlingPolicy;
if (webRtcPolicy?.onChange) {
  webRtcPolicy.onChange.addListener(async (details) => {
    if (details.incognitoSpecific) return;
    const { appSettings } = await chrome.storage.local.get('appSettings');
    const requested = appSettings?.antiLeakPolicy || 'disable_non_proxied_udp';
    const enabled = appSettings?.enableAntiLeakShield !== false;
    const shieldEffective = enabled && details.value === requested &&
      details.levelOfControl === 'controlled_by_this_extension';
    await chrome.storage.local.set({ shieldEffective });
  });
}
