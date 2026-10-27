document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('appVersion').textContent = chrome.runtime.getManifest().version;

  const saveToast = document.getElementById('saveToast');
  const setNotifications = document.getElementById('setNotifications');
  const setNotifyIPv6 = document.getElementById('setNotifyIPv6');
  const setAutoRefresh = document.getElementById('setAutoRefresh');
  const setFastDetection = document.getElementById('setFastDetection');
  const setRouteWarning = document.getElementById('setRouteWarning');
  const setShowMap = document.getElementById('setShowMap');
  const setShowTimeZone = document.getElementById('setShowTimeZone');
  const setAntiLeakShield = document.getElementById('setAntiLeakShield');
  const setAntiLeakPolicy = document.getElementById('setAntiLeakPolicy');
  const setDnsPrefetchBlock = document.getElementById('setDnsPrefetchBlock');
  const setWebRtcScan = document.getElementById('setWebRtcScan');
  const badgeRadios = [...document.getElementsByName('badgeMode')];
  const themeRadios = [...document.getElementsByName('optionsTheme')];
  const navItems = [...document.querySelectorAll('.nav-item')];
  const navMenu = document.querySelector('.nav-menu');
  const navIndicator = document.querySelector('.nav-indicator');
  const sections = navItems.map((item) => ({
    item,
    section: document.getElementById(item.getAttribute('href')?.slice(1))
  })).filter(({ section }) => section);
  const policyRow = document.getElementById('policyRow');
  const fastDetectionRow = document.getElementById('fastDetectionRow');
  const notifyIpv6Row = document.getElementById('notifyIpv6Row');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');

  const fields = {
    enableNotifications: setNotifications,
    notifyIPv6: setNotifyIPv6,
    enableAutoRefresh: setAutoRefresh,
    enableFastDetection: setFastDetection,
    warnRouteDivergence: setRouteWarning,
    showMap: setShowMap,
    showTimeZone: setShowTimeZone,
    enableAntiLeakShield: setAntiLeakShield,
    antiLeakPolicy: setAntiLeakPolicy,
    enableDnsPrefetchBlock: setDnsPrefetchBlock,
    enableWebRtcScan: setWebRtcScan
  };
  const OPT_IN = ['warnRouteDivergence', 'showTimeZone'];
  const pendingCounts = new Map();
  let saveChain = Promise.resolve();
  // The settings as last confirmed by storage, to undo a control whose save failed.
  let lastKnownSettings = {};
  let batchFailed = false;

  function setStatus(message, state = 'ready') {
    saveToast.textContent = message;
    saveToast.dataset.state = state;
  }

  // Sub-settings that have no effect while their parent is off are shown disabled.
  function updateDependentControls() {
    const dependents = [
      [setAntiLeakPolicy, policyRow, setAntiLeakShield],
      [setFastDetection, fastDetectionRow, setAutoRefresh],
      [setNotifyIPv6, notifyIpv6Row, setNotifications]
    ];
    for (const [control, row, parent] of dependents) {
      control.disabled = !parent.checked;
      row?.classList.toggle('is-disabled', !parent.checked);
    }
  }

  function applyField(key, settings) {
    const control = fields[key];
    if (key === 'antiLeakPolicy') {
      control.value = settings.antiLeakPolicy === 'default_public_interface_only'
        ? 'default_public_interface_only'
        : 'disable_non_proxied_udp';
    } else {
      // Every switch defaults to on except the opt-in split-route warning and time-zone row.
      control.checked = OPT_IN.includes(key) ? settings[key] === true : settings[key] !== false;
    }
  }

  function applySettings(settings, skipPending = false) {
    for (const key of Object.keys(fields)) {
      if (skipPending && pendingCounts.has(key)) continue;
      applyField(key, settings);
    }
    if (!skipPending || !pendingCounts.has('badgeMode')) {
      const badgeMode = ['flag', 'text', 'off'].includes(settings.badgeMode) ? settings.badgeMode : 'flag';
      for (const radio of badgeRadios) radio.checked = radio.value === badgeMode;
    }
    if (!skipPending || !pendingCounts.has('optionsTheme')) {
      const theme = ['light', 'dark', 'system'].includes(settings.optionsTheme) ? settings.optionsTheme : 'light';
      for (const radio of themeRadios) radio.checked = radio.value === theme;
      window.leakHaloTheme?.apply(theme);
    }
    updateDependentControls();
  }

  // A failed save puts that one control back to its stored value.
  function revertField(key) {
    if (key in fields) applyField(key, lastKnownSettings);
    else applySettings(lastKnownSettings, true);
    updateDependentControls();
  }

  function queueSave(key, value) {
    if (!pendingCounts.size) batchFailed = false; // a new batch of changes starts
    pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
    setStatus('Saving…', 'saving');
    saveChain = saveChain.catch(() => {}).then(async () => {
      let failed = false;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { [key]: value } });
        if (response?.status !== 'ok') throw new Error('Browser setting update failed');
        if (response.settings) lastKnownSettings = response.settings;
      } catch (error) {
        failed = true;
        batchFailed = true;
      } finally {
        const remaining = (pendingCounts.get(key) || 1) - 1;
        if (remaining) pendingCounts.set(key, remaining);
        else pendingCounts.delete(key);
        if (failed && !pendingCounts.has(key)) revertField(key);
        // One status for the whole batch: "Saved" only once nothing is pending and nothing failed.
        if (!pendingCounts.size) setStatus(batchFailed ? 'Could not apply setting' : 'Saved in this browser', batchFailed ? 'error' : 'ready');
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
      navMenu.scrollTo({ left, behavior: scrollBehavior() });
    }
  }

  // Keep the clicked destination selected while smooth scrolling crosses other sections.
  let navigationTarget = null;
  let navigationTimer = null;
  // A short last section cannot reach the top, so a click on the one before it ends at the page
  // bottom; it then stays selected until the reader scrolls themselves.
  let bottomOverride = null;
  const isAtBottom = () => window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;

  function releaseNavigationTarget() {
    if (navigationTarget && isAtBottom() && navigationTarget !== sections[sections.length - 1]?.item) bottomOverride = navigationTarget;
    navigationTarget = null;
    clearTimeout(navigationTimer);
  }

  function updateActiveNavFromScroll() {
    if (!sections.length || navigationTarget) return;
    const atBottom = isAtBottom();
    if (bottomOverride && atBottom) {
      setActiveNav(bottomOverride);
      return;
    }
    bottomOverride = null;
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

  // The reader scrolling themselves ends a click's hold on the selection.
  function userScrolled() {
    bottomOverride = null;
    if (navigationTarget) {
      navigationTarget = null;
      clearTimeout(navigationTimer);
    }
    queueNavUpdate();
  }

  function goToSection(item, behavior) {
    releaseNavigationTarget();
    bottomOverride = null;
    navigationTarget = item;
    setActiveNav(item);
    const targetId = item.getAttribute('href')?.slice(1);
    document.getElementById(targetId)?.scrollIntoView({ behavior, block: 'start' });
    navigationTimer = setTimeout(releaseNavigationTarget, behavior === 'smooth' ? 1200 : 100);
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      history.replaceState(null, '', item.getAttribute('href'));
      goToSection(item, scrollBehavior());
    });
  });
  window.addEventListener('scroll', queueNavUpdate, { passive: true });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    // Follow the layout at once (no indicator animation) even while a click holds the selection.
    navMenu?.classList.add('resizing');
    const active = navItems.find((item) => item.classList.contains('active'));
    if (active) positionNavIndicator(active);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => navMenu?.classList.remove('resizing'), 150);
    queueNavUpdate();
  });
  window.addEventListener('scrollend', (event) => {
    if (event.target === document || event.target === window || event.target === document.documentElement) {
      releaseNavigationTarget();
    }
  });
  window.addEventListener('wheel', userScrolled, { passive: true });
  window.addEventListener('touchstart', userScrolled, { passive: true });
  window.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScrolled();
  });
  window.addEventListener('pointerdown', (event) => {
    if (!navMenu?.contains(event.target)) userScrolled();
  }, { passive: true });

  // Opened at a section link (options.html#badge): start there.
  const initialItem = navItems.find((item) => item.getAttribute('href') === location.hash);
  if (initialItem) goToSection(initialItem, 'auto');
  else queueNavUpdate();
  requestAnimationFrame(() => requestAnimationFrame(() => navMenu?.classList.add('indicator-ready')));

  // Listeners first, so a change made while the stored settings load is neither lost nor undone.
  for (const [key, control] of Object.entries(fields)) {
    control.addEventListener('change', () => {
      if (['enableAntiLeakShield', 'enableAutoRefresh', 'enableNotifications'].includes(key)) updateDependentControls();
      queueSave(key, key === 'antiLeakPolicy' ? control.value : control.checked);
    });
  }
  for (const radio of badgeRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) queueSave('badgeMode', radio.value);
    });
  }
  for (const radio of themeRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      window.leakHaloTheme?.apply(radio.value);
      queueSave('optionsTheme', radio.value);
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.appSettings) {
      lastKnownSettings = changes.appSettings.newValue || {};
      applySettings(lastKnownSettings, true);
    }
  });

  try {
    const { appSettings } = await chrome.storage.local.get('appSettings');
    lastKnownSettings = appSettings || {};
    applySettings(lastKnownSettings, true);
    if (!pendingCounts.size) setStatus('Saved in this browser');
  } catch (error) {
    setStatus('Settings unavailable', 'error');
  }
});
