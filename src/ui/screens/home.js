/**
 * Home: choose the workout, start it.
 *
 * Every choice writes straight through to settings, so it survives a reload.
 */

import { SPORTS, TIERS, INTENSITIES, ROUND_LENGTHS } from '../../store/settings.js';
import { gapMsFor } from '../../engine/timing.js';
import { buildPool } from '../../engine/selector.js';
import { dailyVolume } from '../../store/history.js';
import { computeSuggestion } from '../../engine/suggest.js';
import { TAG_LABEL } from '../../store/library.js';

const SPORT_LABEL = { boxing: 'Boxing', muaythai: 'Muay Thai', kickboxing: 'Kickboxing' };

const TIER_SUB = {
  beginner: 'Basic combos',
  intermediate: 'Technical striking',
  advanced: 'High-level combos',
};

export function createHomeScreen({ root, settings, config, library, history, onStart }) {
  let suggestionDismissed = false;

  root.innerHTML = `
    <h1 class="page-title">STRIKR<span class="dot">.</span></h1>

    <div id="suggestion-card"></div>

    <div class="section-label">Select sport</div>
    <div class="bars" data-group="sport"></div>

    <div class="section-label">Difficulty</div>
    <div class="bars" data-group="tier"></div>

    <div class="section-label">Intensity</div>
    <div class="grid" data-group="intensity"></div>
    <div class="bars" data-group="intensityCustom" style="margin-top:var(--sp-2)"></div>
    <div id="custom-controls" hidden></div>

    <div class="section-label">Focus</div>
    <div class="grid wrap" data-group="focus"></div>
    <div class="grid" data-group="weakSpots" style="margin-top:var(--sp-2)"></div>

    <div class="section-label">Round length (min)</div>
    <div class="grid" data-group="roundLengthMin"></div>

    <div id="home-notice"></div>
    <div class="action-dock">
      <button class="primary" id="start-round">&#9654; Start round</button>
    </div>
  `;

  // Intensity is split across two containers to match the reference: the three
  // presets sit side by side, Custom is a full-width bar beneath them.
  const intensityBoxes = [
    root.querySelector('[data-group="intensity"]'),
    root.querySelector('[data-group="intensityCustom"]'),
  ];

  const groups = {
    sport: root.querySelector('[data-group="sport"]'),
    tier: root.querySelector('[data-group="tier"]'),
    focus: root.querySelector('[data-group="focus"]'),
    weakSpots: root.querySelector('[data-group="weakSpots"]'),
    roundLengthMin: root.querySelector('[data-group="roundLengthMin"]'),
  };

  const buttonsFor = (group) =>
    group === 'intensity'
      ? intensityBoxes.flatMap((b) => [...b.children])
      : [...groups[group].children];

  /** Describe an intensity by the range of gaps it actually produces. */
  function intensitySub(key) {
    const i = key === 'custom' ? settingsIntensity() : config.intensity[key];
    const lo = gapMsFor({ actions: 2 }, i) / 1000;
    const hi = gapMsFor({ actions: 7 }, i) / 1000;
    // A range, not a single figure: the gap widens with combo length, so the
    // reference screenshots' "4s rest" was never the whole truth.
    return `Gap ${lo.toFixed(1)}–${hi.toFixed(1)}s`;
  }
  const settingsIntensity = () => ({
    baseGapMs: settings.get('customIntensity').baseGapMs,
    perActionMs: settings.get('customIntensity').perActionMs,
  });

  function bar(group, value, title, sub) {
    const b = document.createElement('button');
    b.className = 'bar';
    b.dataset.value = String(value);
    b.setAttribute('aria-pressed', String(settings.get(group) === value));
    b.innerHTML = `
      <span class="bar-text">
        <span class="bar-title">${title}</span>
        ${sub ? `<span class="bar-sub">${sub}</span>` : ''}
      </span>
      <span class="marker"></span>`;
    b.addEventListener('click', () => select(group, value));
    return b;
  }

  function chip(group, value) {
    const b = document.createElement('button');
    b.className = 'chip num';
    b.dataset.value = String(value);
    b.textContent = String(value);
    b.setAttribute('aria-pressed', String(settings.get(group) === value));
    b.addEventListener('click', () => select(group, value));
    return b;
  }

  function select(group, value) {
    settings.set(group, value);
    for (const el of buttonsFor(group)) {
      el.setAttribute('aria-pressed', String(el.dataset.value === String(value)));
    }
    if (group === 'intensity') renderCustom();
    if (group === 'sport') {
      settings.set('focus', null);
      renderFocusPicker();
    }
  }

  /** A left-aligned chip carrying a title and a sub-line, as in the reference. */
  function stackChip(group, value, title, sub) {
    const b = document.createElement('button');
    b.className = 'chip stack';
    b.dataset.value = String(value);
    b.setAttribute('aria-pressed', String(settings.get(group) === value));
    b.innerHTML = `<span class="chip-title">${title}</span><span class="chip-sub">${sub}</span>`;
    b.addEventListener('click', () => select(group, value));
    return b;
  }

  /* ---- custom intensity controls (spec 8) --------------------------- */

  const customBox = root.querySelector('#custom-controls');

  function renderCustom() {
    const on = settings.get('intensity') === 'custom';
    customBox.hidden = !on;
    if (!on) { refreshIntensitySubs(); return; }

    const c = settings.get('customIntensity');
    customBox.innerHTML = `
      <div class="card" style="margin-top:var(--sp-2)">
        <div class="slider-row">
          <div class="row-title">Base gap</div>
          <div class="row-sub">Fixed time added to every combo</div>
          <div class="slider-wrap">
            <input type="range" id="cus-base" min="0" max="5000" step="100" value="${c.baseGapMs}">
            <span class="slider-val" id="cus-base-val">${(c.baseGapMs / 1000).toFixed(1)}s</span>
          </div>
        </div>
        <div class="slider-row">
          <div class="row-title">Per action</div>
          <div class="row-sub">Extra time for each strike in the combo</div>
          <div class="slider-wrap">
            <input type="range" id="cus-per" min="100" max="1500" step="50" value="${c.perActionMs}">
            <span class="slider-val" id="cus-per-val">${(c.perActionMs / 1000).toFixed(2)}s</span>
          </div>
        </div>
        <div class="slider-row"><div class="muted" id="cus-preview"></div></div>
      </div>`;

    const base = customBox.querySelector('#cus-base');
    const per = customBox.querySelector('#cus-per');

    const update = () => {
      settings.setCustomIntensity({
        baseGapMs: Number(base.value),
        perActionMs: Number(per.value),
      });
      customBox.querySelector('#cus-base-val').textContent = `${(base.value / 1000).toFixed(1)}s`;
      customBox.querySelector('#cus-per-val').textContent = `${(per.value / 1000).toFixed(2)}s`;
      preview();
      refreshIntensitySubs();
    };

    function preview() {
      const i = { baseGapMs: Number(base.value), perActionMs: Number(per.value) };
      const parts = [2, 4, 7].map(
        (a) => `${a} actions ${(gapMsFor({ actions: a }, i) / 1000).toFixed(1)}s`
      );
      customBox.querySelector('#cus-preview').textContent = parts.join('  ·  ');
    }

    base.addEventListener('input', update);
    per.addEventListener('input', update);
    preview();
  }

  function refreshIntensitySubs() {
    for (const el of buttonsFor('intensity')) {
      const sub = el.querySelector('.chip-sub, .bar-sub');
      if (sub && el.dataset.value !== 'custom') sub.textContent = intensitySub(el.dataset.value);
    }
  }

  /* ---- build ---------------------------------------------------------- */

  for (const s of SPORTS) groups.sport.appendChild(bar('sport', s, SPORT_LABEL[s], ''));
  for (const t of TIERS) groups.tier.appendChild(bar('tier', t, t, TIER_SUB[t]));

  // Light / Medium / Hard side by side, Custom as a full-width bar beneath.
  for (const i of INTENSITIES) {
    if (i === 'custom') {
      intensityBoxes[1].appendChild(
        bar('intensity', i, i, 'Choose your own timing')
      );
    } else {
      intensityBoxes[0].appendChild(stackChip('intensity', i, i, intensitySub(i)));
    }
  }

  // Focus: dynamic tag picker based on the current sport's combos.
  function availableTags() {
    const sport = settings.get('sport');
    const combos = library.activePool().filter((c) => c.sport === sport);
    const comboTags = new Set();
    const drillTags = new Set();
    for (const c of combos) {
      if (!Array.isArray(c.tags)) continue;
      for (const t of c.tags) (c.single ? drillTags : comboTags).add(t);
    }
    return { comboTags: [...comboTags], drillTags: [...drillTags] };
  }

  function renderFocusPicker() {
    groups.focus.innerHTML = '';
    const current = settings.get('focus') || '';
    const { comboTags, drillTags } = availableTags();

    const addBtn = (value, label) => {
      const b = document.createElement('button');
      b.className = 'chip num';
      b.dataset.value = value;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(current === value));
      b.addEventListener('click', () => {
        settings.set('focus', value || null);
        for (const el of [...groups.focus.children]) {
          el.setAttribute('aria-pressed', String(el.dataset.value === value));
        }
      });
      groups.focus.appendChild(b);
    };

    addBtn('', 'All');
    for (const t of comboTags) addBtn(t, TAG_LABEL[t] || t);
    if (drillTags.length) {
      const sep = document.createElement('span');
      sep.className = 'focus-sep';
      sep.textContent = '|';
      groups.focus.appendChild(sep);
      for (const t of drillTags) addBtn(t, TAG_LABEL[t] || t);
    }
  }

  renderFocusPicker();

  // Weak spots toggle — composable with the tag focus.
  const weakOptions = [
    { value: 'false', label: 'All combos' },
    { value: 'true', label: 'Weak spots' },
  ];
  for (const opt of weakOptions) {
    const b = document.createElement('button');
    b.className = 'chip num';
    b.dataset.value = opt.value;
    b.textContent = opt.label;
    b.setAttribute('aria-pressed', String(String(settings.get('focusWeak')) === opt.value));
    b.addEventListener('click', () => {
      settings.set('focusWeak', opt.value === 'true');
      for (const el of [...groups.weakSpots.children]) {
        el.setAttribute('aria-pressed', String(el.dataset.value === opt.value));
      }
    });
    groups.weakSpots.appendChild(b);
  }

  for (const r of ROUND_LENGTHS) groups.roundLengthMin.appendChild(chip('roundLengthMin', r));

  root.querySelector('#start-round').addEventListener('click', onStart);
  renderCustom();

  /* ---- suggestion card (6B) ----------------------------------------- */

  const suggestionBox = root.querySelector('#suggestion-card');

  function renderSuggestion() {
    const goal = settings.get('goal');
    if (!goal || suggestionDismissed) {
      suggestionBox.innerHTML = '';
      return;
    }

    const now = Date.now();
    const since = now - 14 * 24 * 60 * 60 * 1000;
    const volumes = dailyVolume(history.all(), { sport: settings.get('sport'), since });
    const suggestion = computeSuggestion(goal, volumes, settings.all);

    if (!suggestion) {
      suggestionBox.innerHTML = '';
      return;
    }

    if (suggestion.goalReached) {
      suggestionBox.innerHTML = `
        <div class="card suggestion-card goal-reached">
          <div class="suggestion-header">&#10003; GOAL REACHED</div>
          <div class="suggestion-detail">${suggestion.reason}</div>
          <div class="suggestion-actions">
            <button class="suggestion-btn" data-action="new-goal">Set new goal</button>
          </div>
        </div>`;
    } else {
      suggestionBox.innerHTML = `
        <div class="card suggestion-card">
          <div class="suggestion-header">SUGGESTED WORKOUT</div>
          <div class="suggestion-detail highlight">${suggestion.rounds} rounds · ${capitalise(suggestion.intensity)} · ${suggestion.roundLengthMin} min</div>
          ${suggestion.reason ? `<div class="suggestion-reason">${suggestion.reason}</div>` : ''}
          <div class="suggestion-actions">
            <button class="suggestion-btn primary-btn" data-action="load">Load</button>
            <button class="suggestion-btn" data-action="dismiss">Dismiss</button>
          </div>
        </div>`;
    }
  }

  function capitalise(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

  suggestionBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'load') {
      const goal = settings.get('goal');
      const now = Date.now();
      const since = now - 14 * 24 * 60 * 60 * 1000;
      const volumes = dailyVolume(history.all(), { sport: settings.get('sport'), since });
      const s = computeSuggestion(goal, volumes, settings.all);
      if (!s) return;
      settings.set('roundsPerWorkout', s.rounds);
      if (INTENSITIES.includes(s.intensity)) settings.set('intensity', s.intensity);
      settings.set('roundLengthMin', s.roundLengthMin);
      refreshAll();
    } else if (action === 'dismiss') {
      suggestionDismissed = true;
      suggestionBox.innerHTML = '';
    } else if (action === 'new-goal') {
      settings.set('goal', null);
      suggestionBox.innerHTML = '';
    }
  });

  function refreshAll() {
    for (const group of ['sport', 'tier', 'intensity', 'roundLengthMin']) {
      for (const el of buttonsFor(group)) {
        el.setAttribute('aria-pressed', String(el.dataset.value === String(settings.get(group))));
      }
    }
    renderFocusPicker();
    for (const el of [...groups.weakSpots.children]) {
      el.setAttribute('aria-pressed', String(el.dataset.value === String(settings.get('focusWeak'))));
    }
    refreshIntensitySubs();
    renderCustom();
    renderSuggestion();
  }

  renderSuggestion();

  return {
    refresh() {
      suggestionDismissed = false;
      refreshAll();
    },
    notice(html) {
      root.querySelector('#home-notice').innerHTML = html ? `<div class="notice">${html}</div>` : '';
    },
  };
}
