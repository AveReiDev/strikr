/**
 * The combo library screen.
 *
 * Shipped combos can be switched off and reweighted but never deleted; the
 * user's own combos can be edited and deleted.
 */

import { FREQUENCIES, SPORTS, TIERS, SPORT_LABEL, TAGS, deriveFromDisplay } from '../../store/library.js';
import { openPicker, closePicker } from '../components/picker.js';
import { comboFrequency, comboCoverage } from '../../store/history.js';

const FREQ_LABEL = { occasional: 'Occasional', common: 'Common', constant: 'Constant' };
const TAG_LABEL = {
  hands: 'Hands', kicks: 'Kicks', elbows: 'Elbows',
  body: 'Body', defensive: 'Defense',
};

export function createCombosScreen({ root, library, settings, history, onChange }) {
  let query = '';
  let expanded = new Set();

  root.innerHTML = `
    <div class="combos-head">
      <h1 class="page-title">My combos</h1>
      <button class="add-btn" id="combo-add" aria-label="Add a combo">+</button>
    </div>
    <input class="search" id="combo-search" type="search" placeholder="Search combos" autocomplete="off">
    <div id="combo-summary" class="muted"></div>
    <div id="combo-list"></div>
  `;

  const listEl = root.querySelector('#combo-list');
  const summaryEl = root.querySelector('#combo-summary');

  function render() {
    const groups = library.bySport(query);
    const overall = library.counts();
    const records = history?.all() ?? [];
    const pool = library.activePool();
    const cov = comboCoverage(records, pool);
    const freq = comboFrequency(records);
    summaryEl.textContent = `${overall.active} of ${overall.total} active · ${cov.practiced} practiced`;

    listEl.innerHTML = '';
    for (const group of groups) {
      const counts = library.counts(group.sport);
      const open = expanded.has(group.sport) || !!query;

      const header = document.createElement('button');
      header.className = 'group-head';
      header.setAttribute('aria-expanded', String(open));
      header.innerHTML = `
        <span class="group-name">${group.label}</span>
        <span class="group-meta">${counts.active}/${counts.total}<span class="chev">${open ? '&and;' : '&or;'}</span></span>`;
      header.addEventListener('click', () => {
        if (expanded.has(group.sport)) expanded.delete(group.sport);
        else expanded.add(group.sport);
        render();
      });
      listEl.appendChild(header);

      if (!open) continue;

      if (!group.combos.length) {
        const empty = document.createElement('div');
        empty.className = 'placeholder';
        empty.textContent = 'No combos match';
        listEl.appendChild(empty);
        continue;
      }
      for (const combo of group.combos) listEl.appendChild(card(combo, freq));
    }
  }

  function card(combo, freq) {
    const count = freq?.get(combo.id) || 0;
    const el = document.createElement('div');
    el.className = 'combo-card';
    if (!combo.enabled) el.classList.add('off');
    el.innerHTML = `
      <div class="combo-top">
        <button class="combo-meta" data-freq="${combo.id}">
          ${combo.tier} &middot; <span class="freq">${FREQ_LABEL[combo.frequency]}</span>${count ? ` &middot; ${count}&times; called` : ''}
        </button>
        <div class="combo-actions">
          <button class="icon" data-toggle="${combo.id}"
            aria-pressed="${combo.enabled}"
            aria-label="${combo.enabled ? 'Active' : 'Inactive'}">${combo.enabled ? '&check;' : '&times;'}</button>
          ${combo.custom ? `
          <button class="icon" data-edit="${combo.id}" aria-label="Edit">&#9998;</button>
          <button class="icon danger-icon" data-del="${combo.id}" aria-label="Delete">&#128465;</button>` : ''}
        </div>
      </div>
      <div class="combo-display">${escapeHtml(combo.display)}</div>
      <div class="combo-speech">${escapeHtml(combo.speech)} &middot; ${combo.actions} actions</div>
      ${Array.isArray(combo.tags) && combo.tags.length ? `<div class="combo-tags">${combo.tags.map((t) => `<span class="tag-chip">${escapeHtml(TAG_LABEL[t] || t)}</span>`).join('')}</div>` : ''}
    `;
    return el;
  }

  /* ---- interactions -------------------------------------------------- */

  root.querySelector('#combo-search').addEventListener('input', (e) => {
    query = e.target.value;
    render();
  });

  root.querySelector('#combo-add').addEventListener('click', () => {
    openComboForm({ mode: 'add' });
  });

  listEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const combo = library.find(toggle.dataset.toggle);
      library.setEnabled(combo.id, !combo.enabled);
      render();
      onChange?.();
      return;
    }

    const freq = e.target.closest('[data-freq]');
    if (freq) {
      const combo = library.find(freq.dataset.freq);
      openPicker({
        title: 'How often should this come up?',
        options: FREQUENCIES,
        value: combo.frequency,
        format: (f) => FREQ_LABEL[f],
        onSelect: (f) => { library.setFrequency(combo.id, f); render(); onChange?.(); },
      });
      return;
    }

    const edit = e.target.closest('[data-edit]');
    if (edit) { openComboForm({ mode: 'edit', combo: library.find(edit.dataset.edit) }); return; }

    const del = e.target.closest('[data-del]');
    if (del) {
      const combo = library.find(del.dataset.del);
      if (confirm(`Delete "${combo.display}"?\n\nThis cannot be undone.`)) {
        library.remove(combo.id);
        render();
        onChange?.();
      }
    }
  });

  /* ---- add / edit form ------------------------------------------------ */

  function openComboForm({ mode, combo }) {
    const initial = combo ?? {
      display: '',
      sport: settings.get('sport'),
      tier: settings.get('tier'),
      frequency: 'common',
    };

    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    overlay.innerHTML = `
      <form class="sheet" id="combo-form">
        <div class="sheet-title">${mode === 'add' ? 'New combo' : 'Edit combo'}</div>

        <label class="field">
          <span class="field-label">Combo</span>
          <input class="search" name="display" value="${escapeAttr(initial.display)}"
                 placeholder="Jab - Cross - Lead hook" autocomplete="off" required>
          <span class="field-hint">
            Separate strikes with a dash. Put stage directions in brackets — they
            are timed but not spoken, e.g. Cross - (land switched) - Lead hook.
          </span>
        </label>

        <div class="field">
          <span class="field-label">Preview</span>
          <div class="preview" id="combo-preview"></div>
        </div>

        <div class="field">
          <span class="field-label">Sport</span>
          <div class="grid" data-field="sport"></div>
        </div>

        <div class="field">
          <span class="field-label">Difficulty</span>
          <div class="grid" data-field="tier"></div>
        </div>

        <div class="field">
          <span class="field-label">How often</span>
          <div class="grid" data-field="frequency"></div>
        </div>

        <div class="field">
          <span class="field-label">Tags</span>
          <div class="grid wrap" data-field="tags" id="combo-tags"></div>
        </div>

        <div class="form-errors" id="combo-errors"></div>

        <button class="primary" type="submit">${mode === 'add' ? 'Add combo' : 'Save changes'}</button>
        <button class="sheet-cancel" type="button" id="combo-cancel">Cancel</button>
      </form>`;

    const chosen = {
      sport: initial.sport,
      tier: initial.tier,
      frequency: initial.frequency,
      tags: Array.isArray(initial.tags) ? [...initial.tags] : [],
    };

    const buildChips = (field, values, label) => {
      const box = overlay.querySelector(`[data-field="${field}"]`);
      for (const v of values) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = label(v);
        b.setAttribute('aria-pressed', String(chosen[field] === v));
        b.addEventListener('click', () => {
          chosen[field] = v;
          for (const c of box.children) c.setAttribute('aria-pressed', String(c === b));
        });
        box.appendChild(b);
      }
    };
    buildChips('sport', SPORTS, (v) => SPORT_LABEL[v]);
    buildChips('tier', TIERS, (v) => v);
    buildChips('frequency', FREQUENCIES, (v) => FREQ_LABEL[v]);

    // Tag toggle chips (multi-select)
    const tagsBox = overlay.querySelector('[data-field="tags"]');
    for (const t of TAGS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = TAG_LABEL[t] || t;
      b.setAttribute('aria-pressed', String(chosen.tags.includes(t)));
      b.addEventListener('click', () => {
        const idx = chosen.tags.indexOf(t);
        if (idx >= 0) chosen.tags.splice(idx, 1);
        else chosen.tags.push(t);
        b.setAttribute('aria-pressed', String(chosen.tags.includes(t)));
      });
      tagsBox.appendChild(b);
    }

    const input = overlay.querySelector('[name="display"]');
    const preview = overlay.querySelector('#combo-preview');
    const errorsEl = overlay.querySelector('#combo-errors');

    function updatePreview() {
      const d = deriveFromDisplay(input.value);
      preview.innerHTML = d.actions
        ? `<div class="preview-display">${escapeHtml(d.display)}</div>
           <div class="preview-speech">Voice says: &ldquo;${escapeHtml(d.speech)}&rdquo;</div>
           <div class="preview-speech">${d.actions} action${d.actions === 1 ? '' : 's'} for timing</div>`
        : '<div class="preview-speech">Nothing yet</div>';
    }
    input.addEventListener('input', updatePreview);
    updatePreview();

    const close = () => { overlay.remove(); document.body.style.overflow = ''; };
    overlay.querySelector('#combo-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#combo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const payload = { display: input.value, sport: chosen.sport, tier: chosen.tier, frequency: chosen.frequency, tags: chosen.tags };
      const result = mode === 'add'
        ? library.addCustom(payload)
        : library.updateCustom(combo.id, payload);

      if (!result.ok) {
        errorsEl.innerHTML = result.errors.map((x) => `<div>${escapeHtml(x)}</div>`).join('');
        return;
      }
      close();
      query = '';
      root.querySelector('#combo-search').value = '';
      expanded.add(chosen.sport);
      render();
      onChange?.();
    });

    closePicker();
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    input.focus();
  }

  render();
  return { refresh: render };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const escapeAttr = escapeHtml;
