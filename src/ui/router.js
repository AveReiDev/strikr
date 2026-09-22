/**
 * Screen switching and the bottom tab bar.
 *
 * Deliberately tiny: this app has four screens and no URLs to speak of, so a
 * full routing library would be more machinery than the problem deserves.
 */

export const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'combos', label: 'Combos' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export function createRouter({ onEnter } = {}) {
  let current = null;

  function show(id) {
    for (const el of document.querySelectorAll('.screen')) {
      el.classList.toggle('active', el.id === `screen-${id}`);
    }
    for (const el of document.querySelectorAll('.tab')) {
      if (el.dataset.tab === id) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    // The workout screen is full-bleed with no tab bar.
    document.body.dataset.mode = id === 'workout' ? 'workout' : 'browse';
    current = id;
    onEnter?.(id);
  }

  document.getElementById('tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) show(b.dataset.tab);
  });

  return {
    show,
    get current() { return current; },
  };
}
