// Applies the Settings page theme before the first paint, from a local copy of the saved choice,
// so a dark page never flashes white. options.js keeps the copy in sync with appSettings.
(function () {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'light';
  function apply(next) {
    choice = ['light', 'dark', 'system'].includes(next) ? next : 'light';
    const dark = choice === 'dark' || (choice === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('optionsTheme', choice); } catch (error) {}
  }
  try { apply(localStorage.getItem('optionsTheme')); } catch (error) { apply('light'); }
  media.addEventListener('change', () => apply(choice));
  window.leakHaloTheme = { apply };
})();
