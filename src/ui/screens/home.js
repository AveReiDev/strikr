/**
 * Home: choose the workout, start it.
 *
 * Every choice writes straight through to settings, so it survives a reload.
 */

import { SPORTS, TIERS, INTENSITIES, ROUND_LENGTHS, WORKOUT_MODES, EMPHASES, CHOICES } from '../../store/settings.js';
import { gapMsFor } from '../../engine/timing.js';
import { buildPool } from '../../engine/selector.js';
import { buildLadderPool, LADDER_MODES } from '../../engine/ladder.js';
import { dailyVolume, weeklyLoad, FEELS, FEEL_LABEL } from '../../store/history.js';
import { computeSuggestion } from '../../engine/suggest.js';
import { sessionLoad, weekPlan, applyWeekPlan } from '../../engine/load.js';
import { TAGS, DRILL_TAGS, TAG_LABEL } from '../../store/library.js';

const SPORT_LABEL = { boxing: 'Boxing', muaythai: 'Muay Thai', kickboxing: 'Kickboxing' };

const MODE_LABEL = { random: 'Random', ladder: 'Ladder', pyramid: 'Pyramid', defense: 'Defense' };
const MODE_SUB = {
  random: 'Mixed combos',
  ladder: 'Add a strike',
  pyramid: 'Up, then down',
  defense: 'Attack, then defend',
};

const EMPHASIS_LABEL = { off: 'Off', levels: 'Levels' };
const EMPHASIS_SUB = { off: 'Any combo', levels: 'Head, body, legs' };

/**
 * A collapsible Home section. The header is a button; when the section is
 * closed it shows the current choice, so a hidden focus is never a surprise.
 */
const section = (id, label, body) => `
  <section class="home-section" data-section="${id}">
    <button class="section-label section-toggle" aria-expanded="true" aria-controls="sec-${id}">
      <span>${label}</span>
      <span class="section-summary"></span>
      <span class="section-chev" aria-hidden="true">&rsaquo;</span>
    </button>
    <div class="section-body" id="sec-${id}">${body}</div>
  </section>`;

const TIER_SUB = {
  beginner: 'Basic combos',
  intermediate: 'Technical striking',
  advanced: 'High-level combos',
};

export function createHomeScreen({ root, settings, config, library, history, onStart, onSetGoal, onFeel }) {
  let suggestionDismissed = false;
  let feelFor = null;         // id of the just-saved session awaiting a rating

  root.innerHTML = `
    <h1 class="page-title">STRIKR<span class="dot">.</span></h1>

    <div id="feel-prompt"></div>
    <div id="suggestion-card"></div>

    ${section('sport', 'Select sport', '<div class="bars" data-group="sport"></div>')}
    ${section('tier', 'Difficulty', '<div class="bars" data-group="tier"></div>')}
    ${section('intensity', 'Intensity', `
      <div class="grid" data-group="intensity"></div>
      <div class="bars" data-group="intensityCustom" style="margin-top:var(--sp-2)"></div>
      <div id="custom-controls" hidden></div>`)}
    ${section('workoutMode', 'Mode', '<div class="grid" data-group="workoutMode"></div>')}
    ${section('focus', 'Focus', `
      <div class="grid wrap" data-group="focus"></div>
      <div class="grid" data-group="weakSpots" style="margin-top:var(--sp-2)"></div>`)}
    ${section('emphasis', 'Emphasis', '<div class="grid" data-group="emphasis"></div>')}
    ${section('rounds', 'Rounds', `
      <div class="stepper" data-group="rounds">
        <button class="chip num" data-step="-1" aria-label="One round fewer">&minus;</button>
        <div class="stepper-val"><span class="stepper-num" id="rounds-val"></span><span class="stepper-unit" id="rounds-unit"></span></div>
        <button class="chip num" data-step="1" aria-label="One round more">+</button>
      </div>
      <div class="sub-label">Round length (min)</div>
      <div class="grid" data-group="roundLengthMin"></div>
      <div class="muted rounds-total" id="rounds-total"></div>`)}

    <div class="muted pool-size" id="pool-size"></div>
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
    workoutMode: root.querySelector('[data-group="workoutMode"]'),
    emphasis: root.querySelector('[data-group="emphasis"]'),
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
    if (group === 'roundLengthMin') renderRounds();
    renderPoolSize();
    renderSummaries();
  }

  /**
   * How many combos this workout will actually draw from. A Beginner pool is
   * 10 per sport and a focus can shrink it to a handful — without this the
   * repetition that follows looks like a broken shuffle.
   */
  const poolSizeEl = root.querySelector('#pool-size');
  function renderPoolSize() {
    const ladder = LADDER_MODES.includes(settings.get('workoutMode'));
    const n = (ladder ? buildLadderPool : buildPool)(library.activePool(), {
      sport: settings.get('sport'),
      tier: settings.get('tier'),
      focus: settings.get('focus') || null,
    }).length;
    const noun = ladder ? 'ladder' : 'combo';
    // Ramp and finisher live in Settings, so say here that they are on.
    const extras = [
      settings.get('warmupMin') ? `${settings.get('warmupMin')} min warm-up` : '',
      settings.get('rampUp') ? 'ramp up' : '',
      settings.get('finisherSec') ? `${settings.get('finisherSec')}s finisher` : '',
    ].filter(Boolean).map((x) => ` · ${x}`).join('');
    poolSizeEl.textContent = n
      ? `${n} ${noun}${n === 1 ? '' : 's'} in rotation${extras}`
      : ladder
        ? 'No combos here are long enough to ladder'
        : 'No combos match these choices';
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

  const rank = (tag, known) => {
    const i = known.indexOf(tag);
    return i < 0 ? known.length : i;
  };

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
    // Known tags in their declared order, anything else after.
    const ordered = (set, known) => [...set].sort((a, b) => rank(a, known) - rank(b, known));
    return { comboTags: ordered(comboTags, TAGS), drillTags: ordered(drillTags, DRILL_TAGS) };
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
        renderPoolSize();
        renderSummaries();
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
      renderSummaries();
    });
    groups.weakSpots.appendChild(b);
  }

  for (const m of WORKOUT_MODES) {
    groups.workoutMode.appendChild(stackChip('workoutMode', m, MODE_LABEL[m], MODE_SUB[m]));
  }

  // Emphasis leans the draw toward combos that work one thing; it never
  // shrinks the pool, so the count below does not change with it.
  for (const e of EMPHASES) {
    groups.emphasis.appendChild(stackChip('emphasis', e, EMPHASIS_LABEL[e], EMPHASIS_SUB[e]));
  }

  for (const r of ROUND_LENGTHS) groups.roundLengthMin.appendChild(chip('roundLengthMin', r));

  /* ---- rounds stepper -------------------------------------------------- */

  // A stepper, not chips: fifteen choices would be three rows of buttons.
  const ROUNDS = CHOICES.roundsPerWorkout;
  const stepper = root.querySelector('[data-group="rounds"]');

  function renderRounds() {
    const n = settings.get('roundsPerWorkout');
    const len = settings.get('roundLengthMin');
    const rest = settings.get('restBetweenRoundsSec');
    root.querySelector('#rounds-val').textContent = String(n);
    root.querySelector('#rounds-unit').textContent = n === 1 ? 'round' : 'rounds';
    stepper.querySelector('[data-step="-1"]').disabled = n <= ROUNDS[0];
    stepper.querySelector('[data-step="1"]').disabled = n >= ROUNDS[ROUNDS.length - 1];
    const total = Math.round(n * len + ((n - 1) * rest) / 60);
    root.querySelector('#rounds-total').textContent =
      `About ${total} min with ${rest}s rests`;
  }

  stepper.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn) return;
    const i = ROUNDS.indexOf(settings.get('roundsPerWorkout'));
    const next = ROUNDS[Math.min(ROUNDS.length - 1, Math.max(0, i + Number(btn.dataset.step)))];
    settings.set('roundsPerWorkout', next);
    renderRounds();
    renderSummaries();
  });

  renderRounds();

  /* ---- collapsible sections -------------------------------------------- */

  const sections = [...root.querySelectorAll('.home-section')];

  /** What each closed section shows in its header: the current choice. */
  function summaryOf(id) {
    switch (id) {
      case 'sport': return SPORT_LABEL[settings.get('sport')];
      case 'tier': return settings.get('tier');
      case 'intensity': return settings.get('intensity');
      case 'workoutMode': return MODE_LABEL[settings.get('workoutMode')];
      case 'focus': {
        const f = settings.get('focus');
        const label = f ? TAG_LABEL[f] || f : 'All';
        return settings.get('focusWeak') ? `${label} · Weak spots` : label;
      }
      case 'emphasis': return EMPHASIS_LABEL[settings.get('emphasis')] ?? '';
      case 'rounds': return `${settings.get('roundsPerWorkout')} × ${settings.get('roundLengthMin')} min`;
      default: return '';
    }
  }

  function renderSummaries() {
    for (const sec of sections) {
      sec.querySelector('.section-summary').textContent = summaryOf(sec.dataset.section);
    }
  }

  function applyCollapsed() {
    const closed = settings.get('homeCollapsed') ?? [];
    for (const sec of sections) {
      const open = !closed.includes(sec.dataset.section);
      sec.classList.toggle('collapsed', !open);
      sec.querySelector('.section-toggle').setAttribute('aria-expanded', String(open));
      sec.querySelector('.section-body').hidden = !open;
    }
  }

  for (const sec of sections) {
    sec.querySelector('.section-toggle').addEventListener('click', () => {
      const id = sec.dataset.section;
      const closed = settings.get('homeCollapsed') ?? [];
      settings.set('homeCollapsed', closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id]);
      applyCollapsed();
    });
  }

  renderSummaries();
  applyCollapsed();

  root.querySelector('#start-round').addEventListener('click', onStart);
  renderCustom();

  /* ---- suggestion card (6B) ----------------------------------------- */

  const suggestionBox = root.querySelector('#suggestion-card');

  /**
   * The day's suggestion, fitted into the week. One function for both the
   * card and Load, so what Load applies is always what the card showed.
   */
  function currentPlan() {
    const now = Date.now();
    const all = history.all();
    const loadCfg = config.load;
    const weeks = weeklyLoad(all, {
      now,
      weeks: loadCfg.lookbackWeeks,
      loadOf: (r) => sessionLoad(r, loadCfg),
    });
    const week = weekPlan(weeks, loadCfg);

    const goal = settings.get('goal');
    if (!goal) return { week, suggestion: null };
    const since = now - 14 * 24 * 60 * 60 * 1000;
    const volumes = dailyVolume(all, { sport: settings.get('sport'), since });
    const suggestion = applyWeekPlan(computeSuggestion(goal, volumes, settings.all), week, loadCfg);
    return { week, suggestion };
  }

  /** "This week 38 / 52 · week 2 of 4", or nothing before any training. */
  function weekLine(week) {
    const done = Math.round(week.thisWeek);
    if (week.target === null) {
      return done ? `<div class="suggestion-week">This week ${done} load · building your baseline</div>` : '';
    }
    // The header already says EASY WEEK when it is one, so no need to repeat it.
    return `<div class="suggestion-week">This week ${done} / ${Math.round(week.target)} load · week ${week.weekOfBlock} of ${week.blockLength}</div>`;
  }

  function renderSuggestion() {
    if (suggestionDismissed) {
      suggestionBox.innerHTML = '';
      return;
    }
    const { week, suggestion } = currentPlan();

    if (!settings.get('goal')) {
      suggestionBox.innerHTML = `
        <div class="card suggestion-card">
          <div class="suggestion-header">SUGGESTED WORKOUT</div>
          <div class="suggestion-reason">Set a training goal and each session will be suggested here, building toward it.</div>
          ${weekLine(week)}
          <div class="suggestion-actions">
            <button class="suggestion-btn primary-btn" data-action="set-goal">Set goal</button>
            <button class="suggestion-btn" data-action="dismiss">Dismiss</button>
          </div>
        </div>`;
      return;
    }

    if (!suggestion) {
      suggestionBox.innerHTML = '';
      return;
    }

    if (suggestion.goalReached) {
      suggestionBox.innerHTML = `
        <div class="card suggestion-card goal-reached">
          <div class="suggestion-header">&#10003; GOAL REACHED</div>
          <div class="suggestion-detail">${suggestion.reason}</div>
          ${weekLine(week)}
          <div class="suggestion-actions">
            <button class="suggestion-btn" data-action="new-goal">Set new goal</button>
          </div>
        </div>`;
    } else {
      const header = suggestion.weekDone ? 'WEEK DONE' : week.easy ? 'EASY WEEK' : 'SUGGESTED WORKOUT';
      suggestionBox.innerHTML = `
        <div class="card suggestion-card">
          <div class="suggestion-header">${header}</div>
          <div class="suggestion-detail highlight">${suggestion.rounds} round${suggestion.rounds === 1 ? '' : 's'} · ${capitalise(suggestion.intensity)} · ${suggestion.roundLengthMin} min</div>
          ${suggestion.reason ? `<div class="suggestion-reason">${suggestion.reason}</div>` : ''}
          ${weekLine(week)}
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
      const s = currentPlan().suggestion;
      if (!s || s.goalReached) return;
      settings.set('roundsPerWorkout', s.rounds);
      if (INTENSITIES.includes(s.intensity)) settings.set('intensity', s.intensity);
      settings.set('roundLengthMin', s.roundLengthMin);
      refreshAll();
    } else if (action === 'dismiss') {
      suggestionDismissed = true;
      suggestionBox.innerHTML = '';
    } else if (action === 'new-goal') {
      settings.set('goal', null);
      onSetGoal?.();
    } else if (action === 'set-goal') {
      onSetGoal?.();
    }
  });

  function refreshAll() {
    for (const group of ['sport', 'tier', 'intensity', 'workoutMode', 'emphasis', 'roundLengthMin']) {
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
    renderPoolSize();
    renderRounds();
    renderSummaries();
    applyCollapsed();
  }

  /* ---- post-workout rating --------------------------------------------- */

  const feelBox = root.querySelector('#feel-prompt');

  function renderFeel() {
    if (!feelFor) { feelBox.innerHTML = ''; return; }
    feelBox.innerHTML = `
      <div class="card feel-card">
        <div class="suggestion-header">HOW DID THAT FEEL?</div>
        <div class="feel-scale">
          ${FEELS.map((f) => `
            <button class="chip stack feel-btn" data-feel="${f}">
              <span class="chip-title">${f}</span><span class="chip-sub">${FEEL_LABEL[f]}</span>
            </button>`).join('')}
        </div>
        <button class="feel-skip" data-feel="">Skip</button>
      </div>`;
  }

  feelBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feel]');
    if (!btn) return;
    const id = feelFor;
    feelFor = null;
    renderFeel();
    onFeel?.(id, Number(btn.dataset.feel) || null);
  });

  renderSuggestion();
  renderPoolSize();

  return {
    askFeel(id) {
      feelFor = id;
      renderFeel();
    },
    refresh() {
      suggestionDismissed = false;
      refreshAll();
    },
    notice(html) {
      root.querySelector('#home-notice').innerHTML = html ? `<div class="notice">${html}</div>` : '';
    },
  };
}
