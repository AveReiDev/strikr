/**
 * A small modal list for choosing one value.
 *
 * Replaces tap-to-cycle rows: with nine possible round counts, cycling means
 * up to eight taps to reach the one you want, and you cannot see the options
 * without walking through them.
 */

let openSheet = null;

export function openPicker({ title, options, value, format = String, onSelect }) {
  closePicker();

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="sheet-title">${title}</div>
      <div class="bars sheet-options"></div>
      <button class="sheet-cancel" type="button">Cancel</button>
    </div>`;

  const list = overlay.querySelector('.sheet-options');
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bar';
    b.setAttribute('aria-pressed', String(opt === value));
    b.innerHTML = `
      <span class="bar-text"><span class="bar-title">${format(opt)}</span></span>
      <span class="marker"></span>`;
    b.addEventListener('click', () => {
      closePicker();
      onSelect?.(opt);
    });
    list.appendChild(b);
  }

  // Tapping the backdrop or Cancel dismisses without changing anything.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.sheet-cancel')) closePicker();
  });

  const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  (list.querySelector('[aria-pressed="true"]') ?? list.firstElementChild)?.focus();

  openSheet = { overlay, onKey };
  return closePicker;
}

export function closePicker() {
  if (!openSheet) return;
  document.removeEventListener('keydown', openSheet.onKey);
  openSheet.overlay.remove();
  document.body.style.overflow = '';
  openSheet = null;
}
