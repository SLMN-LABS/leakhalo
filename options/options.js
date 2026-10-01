document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('appVersion').textContent = chrome.runtime.getManifest().version;

  const saveToast = document.getElementById('saveToast');
  const setNotifications = document.getElementById('setNotifications');
  const setAutoRefresh = document.getElementById('setAutoRefresh');
  const setFastDetection = document.getElementById('setFastDetection');
  const setRouteWarning = document.getElementById('setRouteWarning');
  const setShowMap = document.getElementById('setShowMap');
  const setAntiLeakShield = document.getElementById('setAntiLeakShield');
  const setAntiLeakPolicy = document.getElementById('setAntiLeakPolicy');
  const setDnsPrefetchBlock = document.getElementById('setDnsPrefetchBlock');
  const setWebRtcScan = document.getElementById('setWebRtcScan');
  const badgeRadios = [...document.getElementsByName('badgeMode')];
  const navItems = [...document.querySelectorAll('.nav-item')];
  const navMenu = document.querySelector('.nav-menu');
  const navIndicator = document.querySelector('.nav-indicator');
  const sections = navItems.map((item) => ({
    item,
    section: document.getElementById(item.getAttribute('href')?.slice(1))
  })).filter(({ section }) => section);
  const policyRow = document.getElementById('policyRow');

  const fields = {
    enableNotifications: setNotifications,
    enableAutoRefresh: setAutoRefresh,
    enableFastDetection: setFastDetection,
    warnRouteDivergence: setRouteWarning,
    showMap: setShowMap,
    enableAntiLeakShield: setAntiLeakShield,
    antiLeakPolicy: setAntiLeakPolicy,
    enableDnsPrefetchBlock: setDnsPrefetchBlock,
    enableWebRtcScan: setWebRtcScan
  };
  const pendingCounts = new Map();
  let saveChain = Promise.resolve();

  function setStatus(message, state = 'ready') {
    saveToast.textContent = message;
    saveToast.dataset.state = state;
  }

  function setPolicyAvailability() {
    const enabled = setAntiLeakShield.checked;
    setAntiLeakPolicy.disabled = !enabled;
    policyRow.classList.toggle('is-disabled', !enabled);
  }

  function applySettings(settings, skipPending = false) {
    for (const [key, control] of Object.entries(fields)) {
      if (skipPending && pendingCounts.has(key)) continue;
      if (key === 'antiLeakPolicy') {
        control.value = settings.antiLeakPolicy === 'default_public_interface_only'
          ? 'default_public_interface_only'
          : 'disable_non_proxied_udp';
      } else {
        // Every switch defaults to on except the opt-in split-route warning.
        control.checked = key === 'warnRouteDivergence' ? settings[key] === true : settings[key] !== false;
      }
    }
    if (!skipPending || !pendingCounts.has('badgeMode')) {
      const badgeMode = ['flag', 'text', 'off'].includes(settings.badgeMode) ? settings.badgeMode : 'flag';
      for (const radio of badgeRadios) radio.checked = radio.value === badgeMode;
    }
    setPolicyAvailability();
  }

  function queueSave(key, value) {
    pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
    setStatus('Saving…', 'saving');
    saveChain = saveChain.catch(() => {}).then(async () => {
      try {
        const { appSettings } = await chrome.storage.local.get('appSettings');
        const next = { ...(appSettings || {}), [key]: value };
        await chrome.storage.local.set({ appSettings: next });
        const response = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
        if (response?.status !== 'ok') throw new Error('Browser setting update failed');
        setStatus('Saved in this browser');
      } catch (error) {
        setStatus('Could not apply setting', 'error');
      } finally {
        const remaining = (pendingCounts.get(key) || 1) - 1;
        if (remaining) pendingCounts.set(key, remaining);
        else pendingCounts.delete(key);
      }
    });
  }

  function positionNavIndicator(item) {
    if (!navIndicator) return;
    navIndicator.style.width = `${item.offsetWidth}px`;
    navIndicator.style.height = `${item.offsetHeight}px`;
    navIndicator.style.transform = `translate3d(${item.offsetLeft}px, ${item.offsetTop}px, 0)`;
  }

  function setActiveNav(item) {
    const changed = !item.classList.contains('active') || item.getAttribute('aria-current') !== 'location';
    if (changed) {
      navItems.forEach((nav) => {
        nav.classList.toggle('active', nav === item);
        if (nav === item) nav.setAttribute('aria-current', 'location');
        else nav.removeAttribute('aria-current');
      });
    }
    positionNavIndicator(item);
    if (changed && window.innerWidth <= 900 && navMenu) {
      const menuRect = navMenu.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const left = navMenu.scrollLeft + itemRect.left - menuRect.left - (navMenu.clientWidth - item.clientWidth) / 2;
      navMenu.scrollTo({ left, behavior: 'smooth' });
    }
  }

  // Keep the clicked destination selected while smooth scrolling crosses other sections.
  let navigationTarget = null;
  let navigationTimer = null;
  function releaseNavigationTarget() {
    navigationTarget = null;
    clearTimeout(navigationTimer);
  }

  function updateActiveNavFromScroll() {
    if (!sections.length || navigationTarget) return;
    const atBottom = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
    const marker = Math.min(window.innerHeight * 0.35, 220);
    let current = sections[0];
    for (const entry of sections) {
      if (entry.section.getBoundingClientRect().top <= marker) current = entry;
    }
    setActiveNav(atBottom ? sections[sections.length - 1].item : current.item);
  }

  let scrollUpdateQueued = false;
  function queueNavUpdate() {
    if (scrollUpdateQueued) return;
    scrollUpdateQueued = true;
    requestAnimationFrame(() => {
      scrollUpdateQueued = false;
      updateActiveNavFromScroll();
    });
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      releaseNavigationTarget();
      navigationTarget = item;
      setActiveNav(item);
      const targetId = item.getAttribute('href')?.slice(1);
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      navigationTimer = setTimeout(releaseNavigationTarget, 1200);
    });
  });
  window.addEventListener('scroll', queueNavUpdate, { passive: true });
  window.addEventListener('resize', queueNavUpdate);
  window.addEventListener('scrollend', (event) => {
    if (event.target === document || event.target === window || event.target === document.documentElement) {
      releaseNavigationTarget();
    }
  });
  window.addEventListener('wheel', () => {
    if (navigationTarget) {
      releaseNavigationTarget();
      queueNavUpdate();
    }
  }, { passive: true });
  window.addEventListener('touchstart', () => {
    if (navigationTarget) {
      releaseNavigationTarget();
      queueNavUpdate();
    }
  }, { passive: true });
  window.addEventListener('keydown', (event) => {
    if (navigationTarget && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      releaseNavigationTarget();
      queueNavUpdate();
    }
  });
  window.addEventListener('pointerdown', (event) => {
    if (navigationTarget && !navMenu?.contains(event.target)) {
      releaseNavigationTarget();
      queueNavUpdate();
    }
  }, { passive: true });
  queueNavUpdate();
  requestAnimationFrame(() => requestAnimationFrame(() => navMenu?.classList.add('indicator-ready')));

  try {
    const { appSettings } = await chrome.storage.local.get('appSettings');
    applySettings(appSettings || {});
    setStatus('Saved in this browser');
  } catch (error) {
    setStatus('Settings unavailable', 'error');
  }

  for (const [key, control] of Object.entries(fields)) {
    control.addEventListener('change', () => {
      if (key === 'enableAntiLeakShield') setPolicyAvailability();
      queueSave(key, key === 'antiLeakPolicy' ? control.value : control.checked);
    });
  }
  for (const radio of badgeRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) queueSave('badgeMode', radio.value);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.appSettings) {
      applySettings(changes.appSettings.newValue || {}, true);
    }
  });
});
