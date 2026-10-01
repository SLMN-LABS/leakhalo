document.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('loader');
  const content = document.getElementById('content');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const shieldToggleBtn = document.getElementById('shieldToggleBtn');
  const refreshBtn = document.getElementById('refreshBtn');
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
    }
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
      webrtcItem.title = `⚠️ WebRTC Leak Detected!\nReal IP: ${leakedIps}\n(VPN Exit IP: ${exitIp})\nClick Armor to enable protection.`;
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

    setWebRTCState(targetOn ? 'unknown' : 'probing');

    chrome.runtime.sendMessage({ type: 'TOGGLE_SHIELD', explicitState: targetOn }, (res) => {
      setTimeout(() => { isTogglingShield = false; }, 100);
      if (res && typeof res.shieldActive === 'boolean') {
        setShieldState(res.shieldActive ? (res.shieldEffective ? 'on' : 'error') : 'off');
        chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'appSettings', 'shieldEffective'], (data) => {
          runSecurityAudit(data.latestV4Info, data.latestV6Info, data.appSettings, data.shieldEffective);
        });
      } else {
        loadData(true);
      }
    });
  }

  if (shieldToggleBtn) shieldToggleBtn.addEventListener('click', toggleShield);
  if (shieldStatusPill) shieldStatusPill.addEventListener('click', toggleShield);

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('rotating');
      chrome.runtime.sendMessage({ type: 'REFRESH_NOW' }, () => {
        setTimeout(() => refreshBtn.classList.remove('rotating'), 650);
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

  function setupClickToCopy(rowElement, textElement, statusElement) {
    if (!rowElement || !textElement || !statusElement) return;

    function triggerCopy() {
      const text = textElement.innerText?.trim();
      if (!text || !(/^[0-9.]+$/.test(text) || /^[0-9a-f:]+$/i.test(text)) || text === '0.0.0.0' || text === '::') return;

      navigator.clipboard.writeText(text).then(() => {
        rowElement.classList.add('copied');
        statusElement.innerText = 'Copied ✓';
        setTimeout(() => {
          rowElement.classList.remove('copied');
          statusElement.innerText = 'Copy';
        }, 1300);
      }).catch(() => {
        statusElement.innerText = 'Failed';
        setTimeout(() => {
          statusElement.innerText = 'Copy';
        }, 1300);
      });
    }

    rowElement.addEventListener('click', triggerCopy);
    rowElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerCopy();
      }
    });
  }

  setupClickToCopy(v4IpRow, v4Ip, v4CopyStatus);
  setupClickToCopy(v6IpRow, v6Ip, v6CopyStatus);

  // Popup flags are rectangular artwork (assets/flags-rect, 96x72) so they stay sharp in the
  // 36x26 frame; the square toolbar set is the fallback, then the app icon.
  function setPopupFlag(img, watermark, code) {
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
      this.onerror = null;
      this.src = square;
    };
    img.src = rect;
    watermark.src = rect;
  }

  function renderIPv4(data, isOffline = false, probeError = false, hasResult = false) {
    if (isOffline || !data || !data.ip) {
      v4Country.innerText = isOffline ? 'Offline' : (probeError || hasResult ? 'IPv4 unavailable' : 'Checking...');
      v4Ip.innerText = isOffline ? 'No Connection' : (probeError || hasResult ? 'Unavailable' : 'Checking network');
      v4FlagImg.src = '/assets/icons/icon48.png';
      v4Watermark.src = '';
      v4CityRegion.innerText = isOffline ? 'Network connection unavailable' : (probeError ? 'Unable to verify network' : (hasResult ? 'IPv6 connection detected' : 'Waiting for network check'));
      v4CityRegion.title = v4CityRegion.innerText;
      v4IspRow.style.display = 'none';
      v4MapBtn.removeAttribute('href');
      v4MapBtn.classList.add('disabled');
      if (v4TypeTag) {
        v4TypeTag.className = 'type-tag offline';
        v4TypeTag.innerText = isOffline ? 'Disconnected' : (probeError ? 'Error' : (hasResult ? 'Unavailable' : 'Pending'));
        v4TypeTag.style.display = 'inline-flex';
      }
      return;
    }

    const resolvedCountry = getFullCountryName(data.countryCode, data.country);
    v4Country.innerText = resolvedCountry;
    v4Ip.innerText = data.ip;

    if (v4TypeTag && data.connectionType && data.connectionType !== 'Unknown') {
      const rawType = data.connectionType.toLowerCase();
      const typeClass = rawType.includes('data') ? 'datacenter'
        : rawType.includes('resid') ? 'residential'
        : rawType.includes('vpn') ? 'vpn'
        : rawType.includes('mobi') ? 'mobile'
        : 'datacenter';
      v4TypeTag.className = `type-tag ${typeClass}`;
      v4TypeTag.innerText = data.connectionType;
      v4TypeTag.style.display = 'inline-flex';
    } else if (v4TypeTag) {
      v4TypeTag.style.display = 'none';
    }

    const locParts = [data.city, data.region].filter(Boolean);
    const locText = locParts.length ? locParts.join(', ') : (resolvedCountry && resolvedCountry !== 'Unknown Country' ? resolvedCountry : 'Location unavailable');
    v4CityRegion.innerText = locText;
    v4CityRegion.title = locText;

    if (/^[a-z]{2}$/i.test(data.countryCode || '')) {
      setPopupFlag(v4FlagImg, v4Watermark, data.countryCode.toLowerCase());
    } else {
      v4FlagImg.src = '/assets/icons/icon48.png';
      v4Watermark.src = '';
    }

    const lat = parseFloat(data.lat);
    const lon = parseFloat(data.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      v4MapBtn.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}&zoom=11`;
      v4MapBtn.classList.remove('disabled');
    } else {
      v4MapBtn.removeAttribute('href');
      v4MapBtn.classList.add('disabled');
    }

    const ispText = formatIspAsn(data.isp, data.asn);
    if (ispText) {
      v4Isp.innerText = ispText;
      v4Isp.title = ispText;
      v4IspRow.style.display = 'flex';
    } else {
      v4IspRow.style.display = 'none';
    }
  }

  function renderIPv6(data, isOffline = false) {
    if (isOffline || !data || !data.ip) {
      v6ActiveCard.style.display = 'none';
      v6InactivePill.style.display = 'flex';
      return;
    }

    v6InactivePill.style.display = 'none';
    v6ActiveCard.style.display = 'block';

    const resolvedCountry = getFullCountryName(data.countryCode, data.country);
    v6Country.innerText = resolvedCountry;
    v6Ip.innerText = data.ip;

    if (v6TypeTag && data.connectionType && data.connectionType !== 'Unknown') {
      const rawType = data.connectionType.toLowerCase();
      const typeClass = rawType.includes('data') ? 'datacenter'
        : rawType.includes('resid') ? 'residential'
        : rawType.includes('vpn') ? 'vpn'
        : rawType.includes('mobi') ? 'mobile'
        : 'datacenter';
      v6TypeTag.className = `type-tag ${typeClass}`;
      v6TypeTag.innerText = data.connectionType;
      v6TypeTag.style.display = 'inline-flex';
    } else if (v6TypeTag) {
      v6TypeTag.style.display = 'none';
    }

    const locParts = [data.city, data.region].filter(Boolean);
    const locText = locParts.length ? locParts.join(', ') : (resolvedCountry && resolvedCountry !== 'Unknown Country' ? resolvedCountry : 'Location unavailable');
    v6CityRegion.innerText = locText;
    v6CityRegion.title = locText;

    if (/^[a-z]{2}$/i.test(data.countryCode || '')) {
      setPopupFlag(v6FlagImg, v6Watermark, data.countryCode.toLowerCase());
    } else {
      v6FlagImg.src = '/assets/icons/icon48.png';
      v6Watermark.src = '';
    }

    const lat = parseFloat(data.lat);
    const lon = parseFloat(data.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      v6MapBtn.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}&zoom=11`;
      v6MapBtn.classList.remove('disabled');
    } else {
      v6MapBtn.removeAttribute('href');
      v6MapBtn.classList.add('disabled');
    }

    const ispText = formatIspAsn(data.isp, data.asn);
    if (ispText) {
      v6Isp.innerText = ispText;
      v6Isp.title = ispText;
      v6IspRow.style.display = 'flex';
    } else {
      v6IspRow.style.display = 'none';
    }
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
      ipEl.textContent = ip;
      el.append(src, ipEl);
      const code = /^[a-z]{2}$/i.test(info?.countryCode || '') ? info.countryCode.toLowerCase() : '';
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

  function checkSplitRouting(v4, v6) {
    if (!splitBadge) return;
    if (v4 && v6 && v4.countryCode && v6.countryCode &&
        v4.countryCode.toUpperCase() !== v6.countryCode.toUpperCase()) {
      splitBadge.title = `Split Route Detected!\nIPv4: ${v4.country} (${v4.countryCode})\nIPv6: ${v6.country} (${v6.countryCode})`;
      splitBadge.style.display = 'inline-flex';
    } else {
      splitBadge.style.display = 'none';
    }
  }

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

  function probeWebRTCLeaks(v4Data, v6Data) {
    return new Promise((resolve) => {
      const activeV4 = (v4Data?.ip || '').trim().toLowerCase();
      const activeV6 = (v6Data?.ip || '').trim().toLowerCase();

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

        const leaked = candidateList.filter(ip => {
          const norm = ip.trim().toLowerCase();
          return norm !== activeV4 && norm !== activeV6;
        });

        resolve({
          leaked: leaked.length > 0,
          verified: candidateList.length > 0,
          leakedIPs: leaked,
          allIPs: candidateList
        });
      }

      timer = setTimeout(() => {
        done();
      }, 1200);

      try {
        const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
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
          if (finished || !event || !event.candidate) return;
          const candidate = event.candidate;

          const directAddr = candidate.address || candidate.ip;
          if (directAddr && !isPrivateOrBogonIP(directAddr)) {
            discoveredIPs.add(directAddr.trim());
          }

          const candStr = candidate.candidate || '';
          const tokens = candStr.trim().split(/\s+/);
          if (tokens.length >= 5) {
            const tokenIp = tokens[4];
            if (tokenIp && !isPrivateOrBogonIP(tokenIp)) {
              discoveredIPs.add(tokenIp.trim());
            }
          }
        };

        setTimeout(() => {
          done();
        }, 900);
      } catch (err) {
        done();
      }
    });
  }

  function runSecurityAudit(v4Info, v6Info, settings, shieldEffective) {
    if (!securityBar) return;
    const enableWebRtc = !settings || settings.enableWebRtcScan !== false;
    if (!enableWebRtc) {
      currentAuditId++;
      if (activeProbePC) {
        try { activeProbePC.close(); } catch (e) {}
        activeProbePC = null;
      }
      setWebRTCState('disabled');
      return;
    }

    const auditId = ++currentAuditId;
    if (activeProbePC) {
      try { activeProbePC.close(); } catch (e) {}
      activeProbePC = null;
    }

    const isArmorOn = !settings || settings.enableAntiLeakShield !== false;

    if (isArmorOn) {
      document.documentElement.dataset.leakhaloShield = 'enabled';
      setWebRTCState(shieldEffective === true ? 'protected' : 'unknown');
      return;
    }

    document.documentElement.dataset.leakhaloShield = 'disabled';
    setWebRTCState('probing');

    probeWebRTCLeaks(v4Info, v6Info).then((res) => {
      if (auditId !== currentAuditId) return;

      if (res.leaked && res.leakedIPs?.length) {
        setWebRTCState('leak', { leakedIPs: res.leakedIPs, exitIp: v4Info?.ip });
      } else if (res.verified) {
        setWebRTCState('clean');
      } else {
        setWebRTCState('unknown');
      }
    });
  }

  function applySettings(settings) {
    if (!settings) return;
    const showMap = settings.showMap !== false;
    v4MapBtn.style.display = showMap ? 'inline-flex' : 'none';
    v6MapBtn.style.display = showMap ? 'inline-flex' : 'none';
  }

  function normalizeVal(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  // Everything that changes what the popup shows must be part of this fingerprint, or loadData()
  // skips the redraw (a finished lookup that found nothing differs from the "Locating..."
  // placeholder only by its country name and pending flag).
  function computeFingerprint(res) {
    const v4 = res.latestV4Info ? `${normalizeVal(res.latestV4Info.ip)}|${normalizeVal(res.latestV4Info.country)}|${res.latestV4Info.pending === true}|${normalizeVal(res.latestV4Info.countryCode).toUpperCase()}|${normalizeVal(res.latestV4Info.city)}|${normalizeVal(res.latestV4Info.region)}|${normalizeVal(res.latestV4Info.isp)}|${normalizeVal(res.latestV4Info.asn)}|${normalizeVal(res.latestV4Info.connectionType)}|${normalizeVal(res.latestV4Info.lat)}|${normalizeVal(res.latestV4Info.lon)}` : 'none';
    const v6 = res.latestV6Info ? `${normalizeVal(res.latestV6Info.ip)}|${normalizeVal(res.latestV6Info.country)}|${res.latestV6Info.pending === true}|${normalizeVal(res.latestV6Info.countryCode).toUpperCase()}|${normalizeVal(res.latestV6Info.city)}|${normalizeVal(res.latestV6Info.region)}|${normalizeVal(res.latestV6Info.isp)}|${normalizeVal(res.latestV6Info.asn)}|${normalizeVal(res.latestV6Info.connectionType)}|${normalizeVal(res.latestV6Info.lat)}|${normalizeVal(res.latestV6Info.lon)}` : 'none';
    const settings = res.appSettings ? `${res.appSettings.enableAntiLeakShield !== false}_${res.appSettings.antiLeakPolicy || ''}_${res.appSettings.showMap !== false}_${res.appSettings.badgeMode || ''}_${res.appSettings.enableWebRtcScan !== false}_${res.appSettings.warnRouteDivergence === true}` : 'defaults';
    const d = res.routeDivergence;
    const route = d && Array.isArray(d.alts)
      ? `${normalizeVal(d.primaryIp)}|${normalizeVal(d.primarySource)}|${d.alts.map(alt => `${normalizeVal(alt.source)}:${normalizeVal(alt.ip)}:${normalizeVal(alt.geo?.countryCode)}`).join(',')}`
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

  function loadData(forceRender = false) {
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

      if (res.appSettings) {
        applySettings(res.appSettings);
      }

      const isOffline = res.isOffline === true;
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
      renderIPv6(res.latestV6Info || null, isOffline);
      checkSplitRouting(isOffline || res.probeError ? null : res.latestV4Info,
        isOffline || res.probeError ? null : res.latestV6Info);
      // The split-route card is opt-in (Settings); detection still keeps the main IP stable.
      const showRouteWarning = res.appSettings?.warnRouteDivergence === true;
      renderRouteDivergence(isOffline || res.probeError || !showRouteWarning ? null : res.routeDivergence, res.latestV4Info);

      const isShieldActive = res.appSettings ? res.appSettings.enableAntiLeakShield !== false : true;
      setShieldState(isShieldActive ? (res.shieldEffective ? SHIELD_STATES.ON : SHIELD_STATES.ERROR) : SHIELD_STATES.OFF);

      runSecurityAudit(res.latestV4Info, res.latestV6Info, res.appSettings, res.shieldEffective);

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
    if (area === 'local' && (changes.latestV4Info || changes.latestV6Info || changes.appSettings || changes.isOffline || changes.probeError || changes.shieldEffective || changes.routeDivergence || changes.v4Unverified)) {
      loadData(false);
    }
  });

  window.addEventListener('unload', () => {
    clearInterval(liveCheckTimer);
    currentAuditId++;
    if (activeProbePC) activeProbePC.close();
  });
});
