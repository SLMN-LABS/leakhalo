// Welcome page: reads the extension's own state; all provider requests stay in the background.
const stateKeys = ['latestV4Info', 'latestV6Info', 'probeError', 'isOffline', 'shieldEffective', 'appSettings'];
const byId = id => document.getElementById(id);
const controls = {
  enableNotifications: byId('setNotifications'),
  enableFastDetection: byId('setFastDetection'),
  enableAntiLeakShield: byId('setAntiLeakShield')
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let state = {};
let saveChain = Promise.resolve();
const pendingCounts = new Map();
let checkFailed = false;
let locationTimedOut = false;
let pendingSignature = '';
let locationTimer;

function setText(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

// Match the popup's English country names, including its short-name overrides.
function getFullCountryName(code, fallbackName) {
  const shortNames = { PS: 'Palestine' };
  if (code && shortNames[code.toUpperCase()]) return shortNames[code.toUpperCase()];
  if (code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
      if (name && name !== code.toUpperCase()) return name;
    } catch (error) {}
  }
  const cleanFallback = (typeof fallbackName === 'string' && !fallbackName.startsWith('Unknown') && !fallbackName.startsWith('Detected')) ? fallbackName : '';
  if (cleanFallback && cleanFallback.length > 2) return cleanFallback;
  return code || cleanFallback || 'Unknown Country';
}

function formatIspAsn(rawIsp, rawAsn) {
  let isp = (rawIsp || '').trim();
  let asn = (rawAsn || '').trim();
  if (isp === 'N/A') isp = '';
  if (asn === 'N/A') asn = '';
  const asMatch = isp.match(/\bAS(\d+)\b/i) || asn.match(/\bAS(\d+)\b/i);
  const detectedAsn = asMatch ? `AS${asMatch[1]}` : asn;
  const cleanIsp = isp.replace(/^AS\d+\s*[-_:]*\s*/i, '').replace(/\s*\(?AS\d+\)?\s*$/i, '').replace(/\s*\(?AS\d+\)?/gi, '').trim();
  if (!cleanIsp && detectedAsn) return detectedAsn;
  if (cleanIsp && detectedAsn) return `${cleanIsp} (${detectedAsn})`;
  return cleanIsp;
}

// Same rectangular flag → square flag → app icon fallback as the popup.
function setFlag(img, countryCode) {
  const code = /^[a-z]{2}$/i.test(countryCode || '') ? countryCode.toLowerCase() : '';
  if (img.dataset.code === code) return;
  img.dataset.code = code;
  img.onerror = null;
  if (!code) { img.src = '/assets/icons/icon48.png'; return; }
  img.onerror = function() {
    this.onerror = function() { this.onerror = null; this.src = '/assets/icons/icon48.png'; };
    this.src = `/assets/flags/flag-${code}.png`;
  };
  img.src = `/assets/flags-rect/flag-${code}.png`;
}

function country(info) {
  if (info.pending === true && !info.countryCode) return locationTimedOut ? 'Location unavailable' : 'Locating…';
  return getFullCountryName(info.countryCode, info.country);
}

function render() {
  const settings = state.appSettings || {};
  const v4 = state.latestV4Info?.ip ? state.latestV4Info : null;
  const v6 = state.latestV6Info?.ip ? state.latestV6Info : null;
  const info = v4 || v6;
  const offline = state.isOffline === true;
  const failed = !offline && (state.probeError === true || (!info && checkFailed));
  const loading = !info && !offline && !failed;
  const pending = !!(v4?.pending || v6?.pending);
  const signature = pending ? `${v4?.ip}|${v4?.pending}|${v6?.ip}|${v6?.pending}` : '';
  if (signature !== pendingSignature) {
    pendingSignature = signature;
    locationTimedOut = false;
    clearTimeout(locationTimer);
    // An interrupted worker must never leave this page on "Locating…" indefinitely.
    if (pending) locationTimer = setTimeout(() => { locationTimedOut = true; render(); }, 20_000);
  }
  byId('connectionCard').dataset.state = offline ? 'offline' : failed ? 'error' : loading ? 'loading' : pending ? 'pending' : 'live';
  for (const id of ['connectionV4', 'connectionV6', 'connectionNetwork']) byId(id).classList.toggle('skeleton', loading);
  setText('connectionCountry', offline ? 'You’re offline' : failed ? 'Unable to verify network' : info ? country(info) : 'Checking your connection…');
  const locParts = info ? [info.city, info.region].filter((part, i, all) => part && all.indexOf(part) === i) : [];
  setText('connectionCity', offline ? 'Connect to the internet to check your IP' : failed ? 'LeakHalo will check again in the background' : loading ? 'Waiting for the first network check' : pending ? (locationTimedOut ? 'Location lookup did not finish' : 'Locating…') : locParts.join(', ') || 'City unavailable');
  setText('connectionV4', offline || failed ? 'Unavailable' : v4?.ip || (loading ? 'Checking…' : 'Not detected'));
  setText('connectionV6', offline || failed ? 'Unavailable' : v6?.ip || (loading ? 'Checking…' : 'Not detected'));
  setText('connectionV6Location', !offline && !failed && v6 ? [country(v6), v6.city].filter(Boolean).join(' · ') : '');
  setText('connectionNetwork', offline || failed ? 'Unavailable' : info ? formatIspAsn(info.isp, info.asn) || (pending && !locationTimedOut ? 'Locating…' : 'Network unavailable') : 'Checking…');
  for (const id of ['connectionCountry', 'connectionCity', 'connectionV4', 'connectionV6', 'connectionV6Location', 'connectionNetwork']) byId(id).title = byId(id).textContent;
  setFlag(byId('connectionFlag'), !offline && !failed ? info?.countryCode : '');
  byId('copyIp').disabled = !(v4?.ip || v6?.ip) || offline || failed;
  const shieldOn = settings.enableAntiLeakShield !== false;
  const active = shieldOn && state.shieldEffective === true;
  setText('connectionPolicy', !shieldOn ? 'WebRTC protection off' : active ? 'Policy active' : state.shieldEffective === undefined ? 'Checking WebRTC policy…' : 'Policy not verified');
  document.querySelector('.policy-label').dataset.active = String(active);
  for (const [key, control] of Object.entries(controls)) {
    if (!pendingCounts.has(key)) control.checked = settings[key] !== false;
  }
  globe.setTarget(!offline && !failed ? info : null);
}

function setSaveStatus(message, kind = 'ready') {
  setText('saveStatus', message);
  byId('saveStatus').dataset.state = kind;
}

// Same per-field merge and SETTINGS_UPDATED side effect as the Settings page.
function queueSave(key, value) {
  pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
  setSaveStatus('Saving…', 'saving');
  saveChain = saveChain.catch(() => {}).then(async () => {
    try {
      const { appSettings } = await chrome.storage.local.get('appSettings');
      const next = { ...(appSettings || {}), [key]: value };
      await chrome.storage.local.set({ appSettings: next });
      const response = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
      if (response?.status !== 'ok') throw new Error('Browser setting update failed');
      setSaveStatus('Saved in this browser');
    } catch (error) {
      setSaveStatus('Could not apply setting. Try again or open Settings.', 'error');
    } finally {
      const remaining = (pendingCounts.get(key) || 1) - 1;
      if (remaining) pendingCounts.set(key, remaining);
      else pendingCounts.delete(key);
      render();
    }
  });
}

/* ---------- globe: where the web places you ---------- */
const globe = (() => {
  const canvas = byId('globe');
  const ctx = canvas.getContext('2d');
  const label = byId('globeLabel');
  const D = Math.PI / 180;
  const land = Array.isArray(self.LEAKHALO_LAND) ? self.LEAKHALO_LAND : [];
  const n = land.length / 2;
  const cp = new Float32Array(n), sp = new Float32Array(n), sl = new Float32Array(n), cl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const la = land[2 * i] * D, lo = land[2 * i + 1] * D;
    cp[i] = Math.cos(la); sp[i] = Math.sin(la); sl[i] = Math.sin(lo); cl[i] = Math.cos(lo);
  }
  let target = null;          // { lat, lon, text }
  let lon0 = 20, lat0 = 20;   // current view centre
  let raf = 0, last = 0, size = 0;

  function resize() {
    const css = canvas.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px && px !== canvas.width) { canvas.width = canvas.height = px; }
    size = css;
  }
  function draw(t) {
    if (!size) resize();
    const W = canvas.width, dpr = W / (size || 1), cx = W / 2, cy = W / 2, R = W * 0.38;
    ctx.clearRect(0, 0, W, W);
    // Follow the user's location with a slow sway; drift gently without one.
    const sway = reducedMotion.matches ? 0 : Math.sin(t / 5200) * 16;
    const goalLon = target ? target.lon + sway : (reducedMotion.matches ? 20 : (t / 140) % 360);
    // Centre the user's latitude so the marker and its label sit mid-globe, clear of the pin coach.
    const goalLat = target ? Math.max(-40, Math.min(50, target.lat)) : 18;
    const k = reducedMotion.matches ? 1 : 0.06;
    let dl = ((goalLon - lon0 + 540) % 360) - 180;
    lon0 += dl * k; lat0 += (goalLat - lat0) * k;
    const c0 = Math.cos(lon0 * D), s0 = Math.sin(lon0 * D), ct = Math.cos(lat0 * D), st = Math.sin(lat0 * D);

    // atmosphere
    const glow = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.35);
    glow.addColorStop(0, 'rgba(56,189,248,.28)'); glow.addColorStop(.3, 'rgba(56,189,248,.08)'); glow.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.35, 0, 7); ctx.fill();
    // back dots, body, front dots
    const front = [], back = [];
    for (let i = 0; i < n; i++) {
      const x = cp[i] * (sl[i] * c0 - cl[i] * s0), y0 = sp[i], z0 = cp[i] * (cl[i] * c0 + sl[i] * s0);
      const y = y0 * ct - z0 * st, z = y0 * st + z0 * ct;
      (z > 0 ? front : back).push(cx + R * x, cy - R * y, z);
    }
    const dot = Math.max(1.4, R / 210);
    ctx.fillStyle = 'rgba(80,130,190,.16)';
    for (let i = 0; i < back.length; i += 3) ctx.fillRect(back[i] - dot / 2, back[i + 1] - dot / 2, dot, dot);
    const body = ctx.createRadialGradient(cx - R * .3, cy - R * .35, R * .1, cx, cy, R);
    body.addColorStop(0, 'rgba(20,44,86,.92)'); body.addColorStop(.85, 'rgba(6,16,36,.94)'); body.addColorStop(1, 'rgba(46,140,230,.45)');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    for (let i = 0; i < front.length; i += 3) {
      const z = front[i + 2];
      ctx.fillStyle = `rgba(${Math.round(90 + 60 * z)},${Math.round(170 + 60 * z)},255,${(.25 + .75 * z).toFixed(3)})`;
      ctx.fillRect(front[i] - dot / 2, front[i + 1] - dot / 2, dot, dot);
    }
    // the brand halo: a tilted orbit with a travelling spark
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.15);
    const ring = ctx.createLinearGradient(-R * 1.3, 0, R * 1.3, 0);
    ring.addColorStop(0, 'rgba(29,111,224,0)'); ring.addColorStop(.3, 'rgba(56,189,248,.55)'); ring.addColorStop(.7, 'rgba(25,230,193,.55)'); ring.addColorStop(1, 'rgba(25,230,193,0)');
    ctx.strokeStyle = ring; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.ellipse(0, 0, R * 1.28, R * 0.36, 0, 0, 7); ctx.stroke();
    if (!reducedMotion.matches) {
      const a = t / 1600, sx = Math.cos(a) * R * 1.28, sy = Math.sin(a) * R * 0.36;
      const spark = ctx.createRadialGradient(sx, sy, 0, sx, sy, 10 * dpr);
      spark.addColorStop(0, 'rgba(220,255,250,1)'); spark.addColorStop(.4, 'rgba(25,230,193,.6)'); spark.addColorStop(1, 'rgba(25,230,193,0)');
      ctx.fillStyle = spark; ctx.beginPath(); ctx.arc(sx, sy, 10 * dpr, 0, 7); ctx.fill();
    }
    ctx.restore();
    // the user's position
    let shown = false;
    if (target) {
      const la = target.lat * D, dlo = (target.lon - lon0) * D;
      const x = Math.cos(la) * Math.sin(dlo), y0 = Math.sin(la), z0 = Math.cos(la) * Math.cos(dlo);
      const y = y0 * ct - z0 * st, z = y0 * st + z0 * ct;
      if (z > 0.1) {
        const px = cx + R * x, py = cy - R * y;
        const phase = reducedMotion.matches ? 0.5 : (t / 1800) % 1;
        for (const p of [phase, (phase + .5) % 1]) {
          ctx.strokeStyle = `rgba(25,230,193,${(1 - p) * .8})`; ctx.lineWidth = 2 * dpr;
          ctx.beginPath(); ctx.arc(px, py, (6 + p * 26) * dpr, 0, 7); ctx.stroke();
        }
        const g = ctx.createRadialGradient(px, py, 0, px, py, 14 * dpr);
        g.addColorStop(0, '#ffffff'); g.addColorStop(.35, 'rgba(25,230,193,.95)'); g.addColorStop(1, 'rgba(25,230,193,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 14 * dpr, 0, 7); ctx.fill();
        // Keep the label inside the page: flip it to the left of the marker near the right edge.
        const lx = px / dpr, ly = py / dpr, lw = label.offsetWidth || 220;
        const right = canvas.getBoundingClientRect().left + lx + 16 + lw <= document.documentElement.clientWidth - 8;
        label.style.transform = `translate(${(right ? lx + 16 : lx - 16 - lw).toFixed(1)}px, ${ly.toFixed(1)}px) translateY(-50%)`;
        shown = true;
      }
    }
    label.hidden = !shown;
  }
  function frame(t) {
    raf = 0;
    if (t - last >= 33) { last = t; draw(t); }
    if (!reducedMotion.matches && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  new ResizeObserver(() => { resize(); draw(performance.now()); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') start(); });
  reducedMotion.addEventListener?.('change', () => { draw(performance.now()); start(); });
  start();
  return {
    setTarget(info) {
      const lat = Number(info?.lat), lon = Number(info?.lon);
      const ok = info && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
      target = ok ? { lat, lon } : null;
      if (ok) setText('globeLabelText', `You appear here · ${[info.city, getFullCountryName(info.countryCode, info.country)].filter(Boolean)[0] || ''}`.replace(/ · $/, ''));
      draw(performance.now());
    }
  };
})();

/* ---------- live state ---------- */
for (const [key, control] of Object.entries(controls)) control.addEventListener('change', () => queueSave(key, control.checked));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let changed = false;
  for (const key of stateKeys) {
    if (changes[key]) { state[key] = changes[key].newValue; changed = true; }
  }
  if (changed) render();
});
chrome.storage.local.get(stateKeys).then(data => {
  // Events received during the read take precedence over its snapshot.
  state = { ...data, ...state };
  render();
  for (const control of Object.values(controls)) control.disabled = false;
  setSaveStatus('Saved in this browser');
}).catch(() => {
  checkFailed = true;
  render();
  setSaveStatus('Settings unavailable. Open Settings to try again.', 'error');
});

const firstCheckTimer = setTimeout(() => { checkFailed = true; render(); }, 30_000);
// One check on load also re-enriches a pending result left by an interrupted worker.
chrome.runtime.sendMessage({ type: 'CHECK_NETWORK', force: true }).then(() => {
  clearTimeout(firstCheckTimer);
  checkFailed = true; // only affects an empty result; stored failure/offline flags remain authoritative
  render();
}).catch(() => {
  clearTimeout(firstCheckTimer);
  checkFailed = true;
  render();
});

byId('copyIp').addEventListener('click', async () => {
  const ip = state.latestV4Info?.ip || state.latestV6Info?.ip;
  if (!ip) return;
  const button = byId('copyIp');
  try {
    await navigator.clipboard.writeText(ip);
    button.dataset.copied = 'true';
    setText('copyLabel', 'Copied');
  } catch (error) {
    setText('copyLabel', 'Copy failed');
  }
  setTimeout(() => { button.dataset.copied = 'false'; setText('copyLabel', 'Copy'); }, 1600);
});

/* ---------- pin coach ---------- */
function setPinned(isOnToolbar) {
  const pinned = isOnToolbar === true;
  byId('pinCard').dataset.pinned = String(pinned);
  setText('pinEyebrow', pinned ? 'All set' : 'One last step');
  setText('pinTitle', pinned ? 'LeakHalo is pinned' : 'Pin LeakHalo to your toolbar');
  setText('arrowLabel', pinned ? 'Your flag is up here' : 'Extensions are up here');
  setText('pinStatusText', pinned ? 'Pinned. Your country is now always one glance away.' : 'Waiting for you to pin LeakHalo');
  if (pinned) byId('pinFinalStep').setAttribute('aria-current', 'step');
  else byId('pinFinalStep').removeAttribute('aria-current');
}

async function checkPinned() {
  if (document.visibilityState !== 'visible') return;
  try { setPinned((await chrome.action.getUserSettings()).isOnToolbar); }
  catch (error) { setText('pinStatusText', 'Follow the steps above to pin LeakHalo'); }
}

// New Chrome delivers changes; older builds are queried while this tab is visible.
let pinPoll;
if (typeof chrome.action?.getUserSettings === 'function') {
  checkPinned();
  let subscribed = false;
  try {
    if (chrome.action.onUserSettingsChanged?.addListener) {
      chrome.action.onUserSettingsChanged.addListener(settings => setPinned(settings.isOnToolbar));
      subscribed = true;
    }
  } catch (error) {}
  const syncPinPoll = () => {
    clearInterval(pinPoll);
    if (!subscribed && document.visibilityState === 'visible') pinPoll = setInterval(checkPinned, 1500);
  };
  syncPinPoll();
  document.addEventListener('visibilitychange', () => { checkPinned(); syncPinPoll(); });
} else {
  setText('pinStatusText', 'Follow the steps above to pin LeakHalo');
}
window.addEventListener('pagehide', () => { clearInterval(pinPoll); clearTimeout(firstCheckTimer); clearTimeout(locationTimer); });

byId('openPopup').addEventListener('click', async () => {
  try {
    if (typeof chrome.action?.openPopup !== 'function') throw new Error('Popup API unavailable');
    await chrome.action.openPopup();
    setText('popupHelp', '');
  } catch (error) { setText('popupHelp', 'Click the LeakHalo icon in your toolbar'); }
});
for (const link of document.querySelectorAll('[data-options]')) link.addEventListener('click', async event => {
  event.preventDefault();
  try { await chrome.runtime.openOptionsPage(); }
  catch (error) { setSaveStatus('Could not open Settings. Try the Settings link again.', 'error'); }
});
setText('appVersion', chrome.runtime.getManifest().version);
