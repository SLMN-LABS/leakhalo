document.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('loader');
  const content = document.getElementById('content');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const shieldToggleBtn = document.getElementById('shieldToggleBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const maskToggleBtn = document.getElementById('maskToggleBtn');
  const splitBadge = document.getElementById('splitBadge');
  const routeAlert = document.getElementById('routeAlert');
  const routeAlertRows = document.getElementById('routeAlertRows');
  const lastUpdatedTime = document.getElementById('lastUpdatedTime');

  const v4Country = document.getElementById('v4Country');
  const v4TypeTag = document.getElementById('v4TypeTag');
  const v4FlagImg = document.getElementById('v4FlagImg');
  const v4Watermark = document.getElementById('v4Watermark');
  const v4Ip = document.getElementById('v4Ip');
  const v4IpRow = document.getElementById('v4IpRow');
  const v4CopyStatus = document.getElementById('v4CopyStatus');
  const v4CityRegion = document.getElementById('v4CityRegion');
  const v4Isp = document.getElementById('v4Isp');
  const v4MapBtn = document.getElementById('v4MapBtn');
  const v4IspRow = document.getElementById('v4IspRow');
  const v4TzRow = document.getElementById('v4TzRow');
  const v4Card = document.getElementById('v4Card');
  const v4InactivePill = document.getElementById('v4InactivePill');
  const v6PillMsg = document.getElementById('v6PillMsg');
  const v4Tz = document.getElementById('v4Tz');

  const v6ActiveCard = document.getElementById('v6ActiveCard');
  const v6InactivePill = document.getElementById('v6InactivePill');
  const v6Country = document.getElementById('v6Country');
  const v6TypeTag = document.getElementById('v6TypeTag');
  const v6FlagImg = document.getElementById('v6FlagImg');
  const v6Watermark = document.getElementById('v6Watermark');
  const v6Ip = document.getElementById('v6Ip');
  const v6IpRow = document.getElementById('v6IpRow');
  const v6CopyStatus = document.getElementById('v6CopyStatus');
  const v6CityRegion = document.getElementById('v6CityRegion');
  const v6Isp = document.getElementById('v6Isp');
  const v6MapBtn = document.getElementById('v6MapBtn');
  const v6IspRow = document.getElementById('v6IspRow');
  const v6TzRow = document.getElementById('v6TzRow');
  const v6Tz = document.getElementById('v6Tz');
  const copyAnnouncer = document.getElementById('copyAnnouncer');

  const securityBar = document.getElementById('securityBar');
  const shieldStatusPill = document.getElementById('shieldStatusPill');
  const shieldDot = document.getElementById('shieldDot');
  const shieldStatusText = document.getElementById('shieldStatusText');
  const webrtcItem = document.getElementById('webrtcItem');
  const webrtcDot = document.getElementById('webrtcDot');
  const webrtcStatus = document.getElementById('webrtcStatus');

  let currentAuditId = 0;
  let activeProbePC = null;
  let isTogglingShield = false;
  let hasRenderedOnce = false;
  let lastRenderedFingerprint = '';
  let lastAuditSignature = '';
  // Settings of the current render: screenshot mode and the optional time-zone row.
  let maskIps = false;
  let showTimeZone = false;

  // Screenshot mode keeps the network part and hides the rest: 185.220.•••.•••, 2001:db8:•••.
  function shownIp(ip) {
    if (!maskIps || !ip) return ip;
    if (!ip.includes(':')) return ip.split('.').slice(0, 2).concat('•••', '•••').join('.');
    return `${ip.split(':').filter(Boolean).slice(0, 2).join(':')}:•••`;
  }

  const WEBRTC_STATES = {
    DISABLED: 'disabled',
    PROTECTED: 'protected',
    PROBING: 'probing',
    CLEAN: 'clean',
    LEAK: 'leak',
    UNKNOWN: 'unknown'
  };

  const SHIELD_STATES = {
    ON: 'on',
    OFF: 'off',
    ERROR: 'error'
  };

  const runtimeState = {
    shield: SHIELD_STATES.ON,
    webrtc: WEBRTC_STATES.PROBING
  };

  const STATUS_CONFIG = {
    webrtc: {
      disabled: { dotClass: '', statusClass: '', text: '', title: '', visible: false },
      protected: { dotClass: 'sec-dot green', statusClass: 'sec-status clean', text: 'Policy Active', title: 'Chromium confirms this extension controls the selected WebRTC IP handling policy.', visible: true },
      probing: { dotClass: 'sec-dot checking', statusClass: 'sec-status', text: 'Probing...', title: 'Probing network for direct WebRTC STUN leaks...', visible: true },
      clean: { dotClass: 'sec-dot green', statusClass: 'sec-status clean', text: 'No Leak Seen', title: 'No different public ICE candidate was observed in this limited popup check.', visible: true },
      leak: { dotClass: 'sec-dot red', statusClass: 'sec-status danger', text: 'Leak Detected', title: '⚠️ WebRTC Leak Detected! Real IP unmasked. Click Armor to enable protection.', visible: true },
      unknown: { dotClass: 'sec-dot amber', statusClass: 'sec-status warn', text: 'Unknown', title: 'WebRTC: Unable to verify network candidates.', visible: true }
    },
    shield: {
      on: { btnOff: false, dotClass: 'sec-dot green', statusClass: 'sec-status clean', text: 'ON', btnTitle: 'WebRTC privacy policy requested. Click to toggle.', pillTitle: 'WebRTC privacy policy requested. Click to toggle.' },
      off: { btnOff: true, dotClass: 'sec-dot amber', statusClass: 'sec-status warn', text: 'OFF', btnTitle: 'Anti-Leak Armor: OFF (Protection Disabled). Click to activate.', pillTitle: 'Anti-Leak Armor is OFF. Click to activate protection.' },
      error: { btnOff: true, dotClass: 'sec-dot amber', statusClass: 'sec-status warn', text: 'UNAVAILABLE', btnTitle: 'Browser did not confirm this extension controls the WebRTC policy. Click to retry.', pillTitle: 'WebRTC policy unavailable or controlled elsewhere. Click to retry.' }
    }
  };

  function setShieldState(state) {
    runtimeState.shield = STATUS_CONFIG.shield[state] ? state : SHIELD_STATES.OFF;
    const cfg = STATUS_CONFIG.shield[runtimeState.shield];
    if (shieldToggleBtn) {
      if (cfg.btnOff) shieldToggleBtn.classList.add('off');
      else shieldToggleBtn.classList.remove('off');
      shieldToggleBtn.title = cfg.btnTitle;
      shieldToggleBtn.setAttribute('aria-pressed', String(!cfg.btnOff));
    }
    shieldStatusPill?.setAttribute('aria-pressed', String(!cfg.btnOff));
    if (shieldDot && shieldStatusText) {
      shieldDot.className = cfg.dotClass;
      shieldStatusText.className = cfg.statusClass;
      shieldStatusText.innerText = cfg.text;
      if (shieldStatusPill) shieldStatusPill.title = cfg.pillTitle;
    }
  }

  function setWebRTCState(state, extra = {}) {
    runtimeState.webrtc = STATUS_CONFIG.webrtc[state] ? state : WEBRTC_STATES.UNKNOWN;
    if (!webrtcDot || !webrtcStatus || !webrtcItem) return;

    const cfg = STATUS_CONFIG.webrtc[runtimeState.webrtc];
    const divider = document.querySelector('.sec-divider');
    if (divider) divider.style.display = cfg.visible ? '' : 'none';
    if (!cfg.visible) {
      webrtcItem.style.display = 'none';
      return;
    }
    webrtcItem.style.display = '';

    webrtcDot.className = cfg.dotClass;
    webrtcStatus.className = cfg.statusClass;
    webrtcStatus.innerText = cfg.text;

    if (runtimeState.webrtc === WEBRTC_STATES.LEAK) {
      const leakedIps = extra.leakedIPs?.join(', ') || '';
      const exitIp = extra.exitIp || 'N/A';
      const advice = extra.balanced
        ? 'Balanced mode lets WebRTC use your default network. Choose Strict in Settings.'
        : 'Click Armor to enable protection.';
      webrtcItem.title = `⚠️ WebRTC Leak Detected!\nReal IP: ${leakedIps}\n(VPN Exit IP: ${exitIp})\n${advice}`;
    } else {
      webrtcItem.title = cfg.title;
    }
  }

  function toggleShield() {
    if (isTogglingShield) return;
    isTogglingShield = true;

    const targetOn = runtimeState.shield !== 'on';
    setShieldState(targetOn ? 'on' : 'off');
    document.documentElement.dataset.leakhaloShield = targetOn ? 'enabled' : 'disabled';

    currentAuditId++;
    if (activeProbePC) {
      try { activeProbePC.close(); } catch (e) {}
      activeProbePC = null;
    }
    lastAuditSignature = '';
    // Turning protection off starts a check; turning it on waits for the browser's confirmation
    // instead of flashing a warning colour first.
    if (!targetOn) setWebRTCState('probing');

    chrome.runtime.sendMessage({ type: 'TOGGLE_SHIELD', explicitState: targetOn }, (res) => {
      void chrome.runtime.lastError;
      setTimeout(() => { isTogglingShield = false; }, 100);
      if (res && typeof res.shieldActive === 'boolean') {
        setShieldState(res.shieldActive ? (res.shieldEffective ? 'on' : 'error') : 'off');
        loadData(false);
      } else {
        loadData(true);
      }
    });
  }

  if (shieldToggleBtn) shieldToggleBtn.addEventListener('click', toggleShield);
  if (shieldStatusPill) shieldStatusPill.addEventListener('click', toggleShield);

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      refreshBtn.classList.add('rotating');
      chrome.runtime.sendMessage({ type: 'REFRESH_NOW' }, () => {
        void chrome.runtime.lastError;
        setTimeout(() => {
          refreshBtn.classList.remove('rotating');
          refreshBtn.disabled = false;
        }, 650);
        loadData(true, true);
      });
    });
  }

  if (maskToggleBtn) {
    maskToggleBtn.addEventListener('click', () => {
      const next = !maskIps;
      maskToggleBtn.setAttribute('aria-pressed', String(next));
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { maskIp: next } }, () => {
        void chrome.runtime.lastError;
        loadData(true);
      });
    });
  }

  if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
      }
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

  function formatIspAsn(rawIsp, rawAsn) {
    let isp = (rawIsp || '').trim();
    let asn = (rawAsn || '').trim();
    if (isp === 'N/A') isp = '';
    if (asn === 'N/A') asn = '';
    if (/^\d+$/.test(asn)) asn = `AS${asn}`;

    let detectedAsn = asn;
    const asMatch = isp.match(/\bAS(\d+)\b/i) || asn.match(/\bAS(\d+)\b/i);
    if (asMatch) {
      detectedAsn = `AS${asMatch[1]}`;
    }

    let cleanIsp = isp
      .replace(/^AS\d+\s*[-_:]*\s*/i, '')
      .replace(/\s*[-_:/|]*\s*\(?AS\d+\)?\s*$/i, '')
      .replace(/\s*\(?AS\d+\)?/gi, '')
      .trim();

    if (!cleanIsp && detectedAsn) return detectedAsn;
    if (cleanIsp && detectedAsn) return `${cleanIsp} (${detectedAsn})`;
    if (cleanIsp) return cleanIsp;
    return '';
  }

  // Copies the address the row was given (setCopyable), never text read back from the page.
  function setupClickToCopy(rowElement, statusElement, label) {
    if (!rowElement || !statusElement) return;
    let copyTimer = null;

    function triggerCopy() {
      const text = rowElement.dataset.ip;
      if (!text) return;
      const settle = (status, announcement, copied) => {
        clearTimeout(copyTimer);
        rowElement.classList.toggle('copied', copied);
        statusElement.innerText = status;
        if (copyAnnouncer) copyAnnouncer.textContent = announcement;
        copyTimer = setTimeout(() => {
          rowElement.classList.remove('copied');
          statusElement.innerText = 'Copy';
          if (copyAnnouncer) copyAnnouncer.textContent = '';
        }, 1300);
      };
      navigator.clipboard.writeText(text)
        .then(() => settle('Copied ✓', `${label} address copied`, true))
        .catch(() => settle('Failed', 'Copy failed', false));
    }

    rowElement.addEventListener('click', triggerCopy);
    rowElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerCopy();
      }
    });
  }

  setupClickToCopy(v4IpRow, v4CopyStatus, 'IPv4');
  setupClickToCopy(v6IpRow, v6CopyStatus, 'IPv6');

  // Pseudo codes (XX unknown, T1 Tor, EU region…) are never a country or a flag.
  const PSEUDO_COUNTRY_CODES = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);
  function realCountryCode(code) {
    const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
    return /^[A-Z]{2}$/.test(upper) && !PSEUDO_COUNTRY_CODES.has(upper) ? upper : '';
  }

  // "Tehran, Tehran" reads as a mistake: show a repeated name once.
  function placeText(city, region) {
    return [city, region].filter((part, i, all) => part && all.indexOf(part) === i).join(', ');
  }

  // An address row can be copied only while it shows an address.
  function setCopyable(row, ip, label) {
    row.dataset.ip = ip || '';
    row.classList.toggle('no-ip', !ip);
    row.tabIndex = ip ? 0 : -1;
    if (ip) {
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', maskIps ? `${label} address (hidden). Copy` : `${label} ${ip}. Copy`);
      row.title = 'Click to copy IP address';
    } else {
      row.removeAttribute('role');
      row.removeAttribute('aria-label');
      row.removeAttribute('title');
    }
  }

  // Popup flags are rectangular artwork (assets/flags-rect, 96x72) so they stay sharp in the
  // 36x26 frame; the square toolbar set is the fallback, then the app icon.
  function clearWatermark(watermark) {
    watermark.onerror = null;
    watermark.removeAttribute('src');
    watermark.hidden = true;
  }

  // The app icon in place of a flag (offline, pending or unknown country), with no watermark.
  function setNoFlag(img, watermark) {
    delete img.dataset.code;
    img.onerror = null;
    img.src = '/assets/icons/icon48.png';
    clearWatermark(watermark);
  }

  function setPopupFlag(img, watermark, code) {
    // Re-assigning the same flag every 3 seconds would only re-decode it.
    if (img.dataset.code === code) return;
    img.dataset.code = code;
    // Handlers left from an earlier flag must not fire for this one (they would bring it back).
    img.onerror = null;
    watermark.onerror = null;
    const rect = `/assets/flags-rect/flag-${code}.png`;
    const square = `/assets/flags/flag-${code}.png`;
    img.onerror = function() {
      this.onerror = function() {
        this.onerror = null;
        this.src = '/assets/icons/icon48.png';
      };
      this.src = square;
    };
    watermark.onerror = function() {
      this.onerror = function() { clearWatermark(this); };
      this.src = square;
    };
    watermark.hidden = false;
    img.src = rect;
    watermark.src = rect;
  }

  // UTC offset in minutes of an IANA time zone right now, or null if unknown.
  function zoneOffsetMinutes(timeZone) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || '';
      if (name === 'GMT' || name === 'UTC') return 0;
      const m = name.match(/^(?:GMT|UTC)([+\-\u2212])(\d{1,2})(?::?(\d{2}))?$/i);
      return m ? (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : null;
    } catch (e) {
      return null;
    }
  }

  // Websites can compare the browser's clock with the IP's location; a different time zone can
  // reveal a VPN or proxy. Compared by current UTC offset, so neighbouring zones count as a match.
  const ipZoneOffset = zone => typeof zone === 'string' && zone && zone !== 'N/A' ? zoneOffsetMinutes(zone) : null;

  function renderTimeZone(ipZone, row, valueEl) {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const ipOffset = ipZoneOffset(ipZone);
    const browserOffset = browserZone ? zoneOffsetMinutes(browserZone) : null;
    if (ipOffset === null || browserOffset === null) {
      row.style.display = 'none';
      return;
    }
    const match = ipOffset === browserOffset;
    const readable = zone => zone.replace(/_/g, ' ');
    valueEl.innerText = match ? readable(ipZone) : `${readable(ipZone)} · your clock ${readable(browserZone)}`;
    valueEl.title = match
      ? 'Your browser clock matches the time zone of this IP.'
      : 'Your browser clock is in a different time zone than this IP. Websites can compare the two, which can reveal a VPN or proxy.';
    valueEl.classList.toggle('tz-match', match);
    valueEl.classList.toggle('tz-mismatch', !match);
    row.style.display = 'flex';
  }

  const MAP_TITLE = 'Open approximate location in OpenStreetMap';
  // A map link only for real coordinates (0,0 is what some services send for "unknown").
  function setMapLink(link, lat, lon) {
    const la = parseFloat(lat), lo = parseFloat(lon);
    const ok = Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
    if (ok) {
      link.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(la)}&mlon=${encodeURIComponent(lo)}&zoom=11`;
      link.classList.remove('disabled');
    } else {
      link.removeAttribute('href');
      link.classList.add('disabled');
    }
    syncMapTitle(link);
  }
  function syncMapTitle(link) {
    if (link.classList.contains('disabled') || link.classList.contains('no-map')) link.removeAttribute('title');
    else link.title = MAP_TITLE;
  }

  function renderTypeTag(tag, data, probeError, pending) {
    if (!tag) return;
    if (probeError) {
      // The providers did not answer this time: what is shown is the last verified result.
      tag.className = 'type-tag offline';
      tag.innerText = 'Last known';
      tag.style.display = 'inline-flex';
    } else if (!pending && data.connectionType && data.connectionType !== 'Unknown') {
      const rawType = data.connectionType.toLowerCase();
      const typeClass = rawType.includes('data') ? 'datacenter'
        : rawType.includes('resid') ? 'residential'
        : rawType.includes('vpn') ? 'vpn'
        : rawType.includes('mobi') ? 'mobile'
        : 'datacenter';
      tag.className = `type-tag ${typeClass}`;
      tag.innerText = data.connectionType;
      tag.style.display = 'inline-flex';
    } else {
      tag.style.display = 'none';
    }
  }

  // Country, place, flag, map link and ISP of one address family. `pending`: the location lookup
  // has not answered yet, so nothing is called unknown or unavailable.
  function renderPlace(els, data, probeError) {
    const code = realCountryCode(data.countryCode);
    // Cloudflare may already have given the country; city and network follow from the lookup.
    const pending = data.pending === true;
    const resolvedCountry = pending && !code ? 'Locating…' : getFullCountryName(code, code ? data.country : '');
    els.country.innerText = resolvedCountry;
    renderTypeTag(els.typeTag, data, probeError, pending);

    const locText = pending ? 'Looking up location…'
      : placeText(data.city, data.region) || (code ? resolvedCountry : 'Location unavailable');
    els.city.innerText = locText;
    els.city.title = locText;

    if (code) setPopupFlag(els.flag, els.watermark, code.toLowerCase());
    else setNoFlag(els.flag, els.watermark);
    setMapLink(els.map, data.lat, data.lon);

    const ispText = pending ? '' : formatIspAsn(data.isp, data.asn);
    els.isp.innerText = ispText;
    els.isp.title = ispText;
    els.ispRow.style.display = ispText ? 'flex' : 'none';
  }

  const v4Els = { country: v4Country, typeTag: v4TypeTag, city: v4CityRegion, flag: v4FlagImg, watermark: v4Watermark, map: v4MapBtn, isp: v4Isp, ispRow: v4IspRow };
  const v6Els = { country: v6Country, typeTag: v6TypeTag, city: v6CityRegion, flag: v6FlagImg, watermark: v6Watermark, map: v6MapBtn, isp: v6Isp, ispRow: v6IspRow };

  function renderIPv4(data, isOffline = false, probeError = false, hasResult = false) {
    // IPv6 works but there is no IPv4: a one-line note instead of a large failure card.
    const v6Only = !isOffline && !probeError && hasResult && !data?.ip;
    v4Card.style.display = v6Only ? 'none' : '';
    v4InactivePill.style.display = v6Only ? 'flex' : 'none';
    if (v6Only) return;
    if (isOffline || !data || !data.ip) {
      setCopyable(v4IpRow, '', 'IPv4');
      v4Country.innerText = isOffline ? 'Offline' : (probeError || hasResult ? 'IPv4 unavailable' : 'Checking...');
      v4Ip.innerText = isOffline ? 'No Connection' : (probeError || hasResult ? 'Unavailable' : 'Checking network');
      setNoFlag(v4FlagImg, v4Watermark);
      v4CityRegion.innerText = isOffline ? 'Network connection unavailable' : (probeError ? 'Unable to verify network' : (hasResult ? 'IPv6 connection detected' : 'Waiting for network check'));
      v4CityRegion.title = v4CityRegion.innerText;
      v4IspRow.style.display = 'none';
      v4TzRow.style.display = 'none';
      setMapLink(v4MapBtn, null, null);
      if (v4TypeTag) {
        v4TypeTag.className = 'type-tag offline';
        v4TypeTag.innerText = isOffline ? 'Disconnected' : (probeError ? 'Error' : (hasResult ? 'Unavailable' : 'Pending'));
        v4TypeTag.style.display = 'inline-flex';
      }
      return;
    }

    v4Ip.innerText = shownIp(data.ip);
    v4Ip.title = shownIp(data.ip);
    setCopyable(v4IpRow, data.ip, 'IPv4');
    renderPlace(v4Els, data, probeError);
    if (showTimeZone) renderTimeZone(data.timezone, v4TzRow, v4Tz);
    else v4TzRow.style.display = 'none';
  }

  function renderIPv6(data, isOffline = false, checking = false, probeError = false, v4 = null) {
    if (isOffline || !data || !data.ip) {
      v6ActiveCard.style.display = 'none';
      v6InactivePill.style.display = 'flex';
      v6PillMsg.innerText = isOffline ? 'Offline' : checking ? 'Checking…' : 'Not detected on current network';
      v6InactivePill.title = isOffline ? 'No network connection' : checking ? 'Checking for IPv6' : 'No IPv6 address detected on this network';
      setCopyable(v6IpRow, '', 'IPv6');
      return;
    }

    v6InactivePill.style.display = 'none';
    v6ActiveCard.style.display = 'block';
    v6Ip.innerText = shownIp(data.ip);
    v6Ip.title = shownIp(data.ip); // long addresses are shortened with an ellipsis
    setCopyable(v6IpRow, data.ip, 'IPv6');
    renderPlace(v6Els, data, probeError);
    // The IPv6 time zone is worth a row only without an IPv4 card or when it differs from IPv4's.
    const v4Offset = v4?.ip ? ipZoneOffset(v4.timezone) : null;
    if (showTimeZone && (!v4?.ip || v4Offset === null || ipZoneOffset(data.timezone) !== v4Offset)) renderTimeZone(data.timezone, v6TzRow, v6Tz);
    else v6TzRow.style.display = 'none';
  }

  // Two independent IP sources disagreeing (confirmed twice by the background) means some
  // destinations are routed differently. Built with DOM APIs: provider data is untrusted text.
  function renderRouteDivergence(divergence, v4) {
    if (!routeAlert || !routeAlertRows) return;
    if (!divergence || !v4 || v4.ip !== divergence.primaryIp || !Array.isArray(divergence.alts) || !divergence.alts.length) {
      routeAlert.style.display = 'none';
      routeAlertRows.replaceChildren();
      return;
    }
    const row = (source, ip, info) => {
      const el = document.createElement('div');
      el.className = 'route-alert-row';
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = source;
      const ipEl = document.createElement('span');
      ipEl.className = 'ip';
      ipEl.textContent = shownIp(ip);
      el.append(src, ipEl);
      const code = realCountryCode(info?.countryCode).toLowerCase();
      if (code) {
        const img = document.createElement('img');
        img.alt = '';
        img.onerror = function() { this.onerror = null; this.src = `/assets/flags/flag-${code}.png`; };
        img.src = `/assets/flags-rect/flag-${code}.png`;
        el.append(img);
      }
      const name = code ? getFullCountryName(code, info.country) : '';
      if (name) {
        const where = document.createElement('span');
        where.className = 'where';
        where.textContent = name;
        el.append(where);
      }
      return el;
    };
    routeAlertRows.replaceChildren(
      row(divergence.primarySource, divergence.primaryIp, v4),
      ...divergence.alts.map(alt => row(alt.source, alt.ip, alt.geo))
    );
    routeAlert.style.display = 'flex';
  }

  // Shown only for two settled locations: an unverified or still-locating IPv4 would compare an
  // old country with a new one.
  function checkSplitRouting(v4, v6, v4Unverified = false) {
    if (!splitBadge) return;
    const v4Code = realCountryCode(v4?.countryCode), v6Code = realCountryCode(v6?.countryCode);
    if (v4 && v6 && !v4Unverified && !v4.pending && !v6.pending && v4Code && v6Code && v4Code !== v6Code) {
      splitBadge.title = `Split Route Detected!\nIPv4: ${getFullCountryName(v4Code, v4.country)} (${v4Code})\nIPv6: ${getFullCountryName(v6Code, v6.country)} (${v6Code})`;
      splitBadge.style.display = 'inline-flex';
    } else {
      splitBadge.style.display = 'none';
    }
  }

  // Candidates that cannot be the public address websites see. Documentation ranges count as
  // public (the tests use them).
  function isPrivateOrBogonIP(ip) {
    const s = canonicalIp(ip);
    if (!s || s.endsWith('.local') || s.endsWith('.arpa')) return true;
    const v4Parts = s.split('.');
    if (v4Parts.length === 4) {
      if (!v4Parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255 && p === String(Number(p)))) return true;
      const [o0, o1, o2] = v4Parts.map(Number);
      return o0 === 0 || o0 === 10 || o0 === 127 || o0 >= 224 ||
        (o0 === 192 && o1 === 168) || (o0 === 172 && o1 >= 16 && o1 <= 31) || (o0 === 169 && o1 === 254) ||
        (o0 === 100 && o1 >= 64 && o1 <= 127) || (o0 === 198 && (o1 === 18 || o1 === 19)) || (o0 === 192 && o1 === 0 && o2 === 0);
    }
    if (s.includes(':') && /^[0-9a-f:]+$/.test(s)) {
      return s === '::' || s === '::1' || /^fe[89ab][0-9a-f]:/.test(s) || /^f[cd][0-9a-f]{2}:/.test(s) ||
        /^ff[0-9a-f]{2}:/.test(s) || s.startsWith('64:ff9b:');
    }
    return true;
  }

  // Lower-case, compressed IPv6; an IPv4-mapped IPv6 address becomes the IPv4 address.
  function canonicalIp(ip) {
    const s = (ip || '').trim().toLowerCase();
    if (!s.includes(':')) return s;
    const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];
    let host;
    try { host = new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch (e) { return s; }
    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
      return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return host;
  }

  function probeWebRTCLeaks(v4Data, v6Data) {
    return new Promise((resolve) => {
      const activeV4 = canonicalIp(v4Data?.ip);
      const activeV6 = canonicalIp(v6Data?.ip);

      if (!activeV4 && !activeV6) {
        return resolve({ leaked: false, verified: false, leakedIPs: [], allIPs: [] });
      }

      const discoveredIPs = new Set();
      let finished = false;
      let pc = null;
      let timer = null;

      function done() {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (pc) {
          if (activeProbePC === pc) activeProbePC = null;
          try { pc.close(); } catch (e) {}
        }
        const candidateList = Array.from(discoveredIPs);
        const leaked = candidateList.filter(ip => ip !== activeV4 && ip !== activeV6);
        resolve({
          leaked: leaked.length > 0,
          verified: candidateList.length > 0,
          leakedIPs: leaked,
          allIPs: candidateList
        });
      }

      const addCandidate = (raw) => {
        const ip = canonicalIp(raw);
        if (ip && !isPrivateOrBogonIP(ip)) discoveredIPs.add(ip);
      };

      // One deadline for slow links; usually gathering completes much sooner and ends the check.
      timer = setTimeout(done, 2000);

      try {
        const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (!RTCPC) return done();

        pc = new RTCPC({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        activeProbePC = pc;

        pc.createDataChannel('leakProbe');
        pc.createOffer().then(offer => {
          if (!finished && pc) {
            pc.setLocalDescription(offer).catch(() => {});
          }
        }).catch(() => {});

        pc.onicecandidate = (event) => {
          if (finished) return;
          if (!event || !event.candidate) return done(); // gathering finished
          const candidate = event.candidate;
          addCandidate(candidate.address || candidate.ip);
          const tokens = (candidate.candidate || '').trim().split(/\s+/);
          if (tokens.length >= 5) addCandidate(tokens[4]);
        };
        pc.onicegatheringstatechange = () => {
          if (pc?.iceGatheringState === 'complete') done();
        };
      } catch (err) {
        done();
      }
    });
  }

  function runSecurityAudit(v4Info, v6Info, settings, shieldEffective, unverified = false, force = false) {
    if (!securityBar) return;
    const isArmorOn = !settings || settings.enableAntiLeakShield !== false;
    document.documentElement.dataset.leakhaloShield = isArmorOn ? 'enabled' : 'disabled';
    const enableWebRtc = !settings || settings.enableWebRtcScan !== false;
    const balanced = settings?.antiLeakPolicy === 'default_public_interface_only';
    // Re-checked only when something that affects WebRTC changed (not for a finished location
    // lookup or an appearance setting), so a running check is not cut short.
    const signature = [canonicalIp(v4Info?.ip), canonicalIp(v6Info?.ip), enableWebRtc, isArmorOn, balanced, shieldEffective === true, unverified].join('|');
    if (!force && signature === lastAuditSignature) return;
    lastAuditSignature = signature;

    const auditId = ++currentAuditId;
    if (activeProbePC) {
      try { activeProbePC.close(); } catch (e) {}
      activeProbePC = null;
    }
    if (!enableWebRtc) {
      setWebRTCState('disabled');
      return;
    }

    // Strict mode blocks the leak itself; Balanced still lets WebRTC use the default network, so
    // that case is checked too.
    if (isArmorOn && (!balanced || shieldEffective !== true || unverified)) {
      setWebRTCState(shieldEffective === true ? 'protected' : 'unknown');
      return;
    }
    if (unverified) {
      setWebRTCState('unknown');
      return;
    }
    if (!isArmorOn) setWebRTCState('probing');

    probeWebRTCLeaks(v4Info, v6Info).then((res) => {
      if (auditId !== currentAuditId) return;
      const exitIp = [v4Info?.ip, v6Info?.ip].filter(Boolean).join(' / ');
      if (res.leaked && res.leakedIPs?.length) {
        setWebRTCState('leak', { leakedIPs: res.leakedIPs.map(shownIp), exitIp: [v4Info?.ip, v6Info?.ip].filter(Boolean).map(shownIp).join(' / '), balanced: isArmorOn });
      } else if (isArmorOn) {
        setWebRTCState('protected');
      } else if (res.verified) {
        setWebRTCState('clean');
      } else {
        setWebRTCState('unknown');
      }
    });
  }

  // Map links off: the place name stays; only the link and its pin go.
  function applySettings(settings) {
    if (!settings) return;
    const showMap = settings.showMap !== false;
    for (const link of [v4MapBtn, v6MapBtn]) {
      link.classList.toggle('no-map', !showMap);
      if (!showMap) link.removeAttribute('href');
      syncMapTitle(link);
    }
  }

  function normalizeVal(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  // Everything that changes what the popup shows must be part of this fingerprint, or loadData()
  // skips the redraw (a finished lookup that found nothing differs from the "Locating..."
  // placeholder only by its country name and pending flag).
  function computeFingerprint(res) {
    const v4 = res.latestV4Info ? `${normalizeVal(res.latestV4Info.ip)}|${normalizeVal(res.latestV4Info.country)}|${res.latestV4Info.pending === true}|${normalizeVal(res.latestV4Info.countryCode).toUpperCase()}|${normalizeVal(res.latestV4Info.city)}|${normalizeVal(res.latestV4Info.region)}|${normalizeVal(res.latestV4Info.isp)}|${normalizeVal(res.latestV4Info.asn)}|${normalizeVal(res.latestV4Info.connectionType)}|${normalizeVal(res.latestV4Info.lat)}|${normalizeVal(res.latestV4Info.lon)}|${normalizeVal(res.latestV4Info.timezone)}` : 'none';
    const v6 = res.latestV6Info ? `${normalizeVal(res.latestV6Info.ip)}|${normalizeVal(res.latestV6Info.country)}|${res.latestV6Info.pending === true}|${normalizeVal(res.latestV6Info.countryCode).toUpperCase()}|${normalizeVal(res.latestV6Info.city)}|${normalizeVal(res.latestV6Info.region)}|${normalizeVal(res.latestV6Info.isp)}|${normalizeVal(res.latestV6Info.asn)}|${normalizeVal(res.latestV6Info.connectionType)}|${normalizeVal(res.latestV6Info.lat)}|${normalizeVal(res.latestV6Info.lon)}|${normalizeVal(res.latestV6Info.timezone)}` : 'none';
    const settings = res.appSettings ? `${res.appSettings.enableAntiLeakShield !== false}_${res.appSettings.antiLeakPolicy || ''}_${res.appSettings.showMap !== false}_${res.appSettings.badgeMode || ''}_${res.appSettings.enableWebRtcScan !== false}_${res.appSettings.warnRouteDivergence === true}_${res.appSettings.maskIp === true}_${res.appSettings.showTimeZone === true}` : 'defaults';
    const d = res.routeDivergence;
    const route = d && Array.isArray(d.alts)
      ? `${normalizeVal(d.primaryIp)}|${normalizeVal(d.primarySource)}|${d.alts.map(alt => `${normalizeVal(alt.source)}:${normalizeVal(alt.ip)}:${normalizeVal(alt.geo?.countryCode)}:${normalizeVal(alt.geo?.country)}`).join(',')}`
      : 'none';
    return `${v4}__${v6}__${settings}__${res.isOffline === true}__${res.probeError === true}__${res.shieldEffective === true}__${route}__${res.v4Unverified === true}`;
  }

  // Shows when the IP was last checked (every ~3 s while the popup is open), not when the
  // location was last refreshed, so a live popup never looks stale.
  function updateTimestamp(updatedAt) {
    if (!lastUpdatedTime) return;
    if (!updatedAt) {
      lastUpdatedTime.innerText = 'No result yet';
      return;
    }
    const secondsAgo = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
    if (secondsAgo < 5) {
      lastUpdatedTime.innerText = 'Checked just now';
    } else if (secondsAgo < 60) {
      lastUpdatedTime.innerText = `Checked ${secondsAgo}s ago`;
    } else {
      const mins = Math.floor(secondsAgo / 60);
      lastUpdatedTime.innerText = `Checked ${mins}m ago`;
    }
  }

  function loadData(forceRender = false, forceAudit = false) {
    if (!hasRenderedOnce) {
      loader.style.display = 'flex';
      content.style.display = 'none';
    }

    chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'appSettings', 'isOffline', 'probeError', 'shieldEffective', 'routeDivergence', 'v4Unverified', 'lastCheckedAt'], (res) => {
      const currentFingerprint = computeFingerprint(res);

      if (hasRenderedOnce && !forceRender && currentFingerprint === lastRenderedFingerprint) {
        updateTimestamp(res.lastCheckedAt || res.latestV4Info?.updatedAt || res.latestV6Info?.updatedAt);
        return;
      }

      lastRenderedFingerprint = currentFingerprint;
      hasRenderedOnce = true;

      const isOffline = res.isOffline === true;
      maskIps = res.appSettings?.maskIp === true;
      showTimeZone = res.appSettings?.showTimeZone === true;
      maskToggleBtn?.setAttribute('aria-pressed', String(maskIps));
      if (maskToggleBtn) maskToggleBtn.title = maskIps ? 'Show IP addresses' : 'Hide IP addresses (for screenshots)';
      maskToggleBtn?.setAttribute('aria-label', maskIps ? 'Show IP addresses' : 'Hide IP addresses');
      const pulseDot = document.querySelector('.pulse-dot');
      const subbarLabel = document.querySelector('.subbar-label');
      if (isOffline) {
        if (pulseDot) pulseDot.className = 'pulse-dot offline';
        if (subbarLabel) subbarLabel.innerText = 'Network Offline';
      } else if (res.probeError) {
        if (pulseDot) pulseDot.className = 'pulse-dot offline';
        if (subbarLabel) subbarLabel.innerText = 'Unable to verify network';
      } else if (res.v4Unverified && res.latestV4Info) {
        // The primary IPv4 source did not answer; the shown IPv4 is the last verified one.
        if (pulseDot) pulseDot.className = 'pulse-dot pending';
        if (subbarLabel) subbarLabel.innerText = 'Verifying IPv4…';
      } else if (!res.latestV4Info && !res.latestV6Info) {
        if (pulseDot) pulseDot.className = 'pulse-dot';
        if (subbarLabel) subbarLabel.innerText = 'Checking network';
      } else {
        if (pulseDot) pulseDot.className = 'pulse-dot';
        if (subbarLabel) subbarLabel.innerText = 'Live Monitor';
      }

      renderIPv4(res.latestV4Info || null, isOffline, res.probeError === true, !!res.latestV6Info);
      const checking = !isOffline && !res.probeError && !res.latestV4Info && !res.latestV6Info;
      renderIPv6(res.latestV6Info || null, isOffline, checking, res.probeError === true, res.latestV4Info || null);
      if (res.appSettings) applySettings(res.appSettings);
      checkSplitRouting(isOffline || res.probeError ? null : res.latestV4Info,
        isOffline || res.probeError ? null : res.latestV6Info, res.v4Unverified === true);
      // The split-route card is opt-in (Settings); detection still keeps the main IP stable.
      const showRouteWarning = res.appSettings?.warnRouteDivergence === true;
      renderRouteDivergence(isOffline || res.probeError || !showRouteWarning ? null : res.routeDivergence, res.latestV4Info);

      const isShieldActive = res.appSettings ? res.appSettings.enableAntiLeakShield !== false : true;
      setShieldState(isShieldActive ? (res.shieldEffective ? SHIELD_STATES.ON : SHIELD_STATES.ERROR) : SHIELD_STATES.OFF);

      // Without a fresh, verified public IP a WebRTC candidate cannot be judged as a leak.
      const unverified = isOffline || res.probeError === true || res.v4Unverified === true;
      runSecurityAudit(res.latestV4Info, res.latestV6Info, res.appSettings, res.shieldEffective, unverified, forceAudit);

      updateTimestamp(res.lastCheckedAt || res.latestV4Info?.updatedAt || res.latestV6Info?.updatedAt);

      loader.style.display = 'none';
      content.style.display = 'flex';
    });
  }

  const LIVE_CHECK_INTERVAL_MS = 3_000;
  let liveCheckInFlight = false;
  let forceAfterCurrentCheck = false;
  let lastForcedCheckAt = 0;

  function checkNetwork(force = false) {
    if (document.hidden) return;
    if (force && Date.now() - lastForcedCheckAt < 1_500) return;
    if (liveCheckInFlight) {
      if (force) forceAfterCurrentCheck = true;
      return;
    }
    if (force) lastForcedCheckAt = Date.now();
    liveCheckInFlight = true;
    chrome.runtime.sendMessage({ type: 'CHECK_NETWORK', force }, (res) => {
      void chrome.runtime.lastError; // the worker may restart between checks; the next one retries
      liveCheckInFlight = false;
      if (res?.data) loadData(false);
      if (forceAfterCurrentCheck) {
        forceAfterCurrentCheck = false;
        checkNetwork(true);
      }
    });
  }

  loadData(true);
  checkNetwork();
  const liveCheckTimer = setInterval(() => checkNetwork(), LIVE_CHECK_INTERVAL_MS);
  const onConnectionChange = () => checkNetwork(true);
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkNetwork(true);
  });
  navigator.connection?.addEventListener?.('change', onConnectionChange);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.latestV4Info || changes.latestV6Info || changes.appSettings || changes.isOffline || changes.probeError || changes.shieldEffective || changes.routeDivergence || changes.v4Unverified || changes.lastCheckedAt)) {
      loadData(false);
    }
  });

  window.addEventListener('pagehide', () => {
    clearInterval(liveCheckTimer);
    currentAuditId++;
    if (activeProbePC) activeProbePC.close();
  });
});
