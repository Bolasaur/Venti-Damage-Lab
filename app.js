/* Venti Damage Lab.
 *
 * This file renders the interface and nothing else. It never computes damage:
 * every number on screen is posted to the calculator engine (engine/, running
 * in a Web Worker -- see engine/client.js) and read back. That is deliberate --
 * an earlier version of this UI re-implemented the formulae inline and drifted
 * out of sync with the calculator.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let STATE = null;      // the editable build, mirrored to the server
let CONST = null;      // static tables (roster, weapons, stat labels...)
let RESULT = null;     // the last successful calculation
let VIEW = 'home';
let SELECTED = 'Venti';

/* The cost-scamming optimizer's run state, tracked outside the view so a
 * run survives navigating away from the Cost Scamming menu: idle | running |
 * done | error. Whichever screen is showing when it settles decides whether
 * to repaint the panel in place or pop the corner toast instead. */
let OPTIMIZE = { status: 'idle' };

const VIEW_TITLES = {
  home: 'Team Overview',
  characters: 'Edit Characters',
  rotation: 'Edit Rotation',
  stats: 'Damage Stats',
  costscaling: 'Cost Scamming',
};

// Refinement is always exactly R1-R5, for every weapon -- no need to fetch
// this from the server the way CONST.character_levels is.
const WEAPON_REFINEMENTS = [1, 2, 3, 4, 5];

/* ------------------------------------------------------------------ utils */

const num = (value, digits = 0) =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const pct = (value, digits = 1) => `${(Number(value) * 100).toFixed(digits)}%`;

const isPercent = (stat) => CONST.percent_stats.includes(stat);
const label = (stat) => CONST.stat_labels[stat] || stat;

/* "ATK%" already carries its sign; "Crit Rate" needs one adding. */
const fieldLabel = (stat) => {
  const base = label(stat);
  return isPercent(stat) && !base.includes('%') ? `${base}%` : base;
};

/* Percent stats live as fractions in the state and as percentages on screen.
 * Rounding on the way out keeps .14 from surfacing as 14.000000000000002. */
const toDisplay = (stat, raw) =>
  Number((isPercent(stat) ? Number(raw) * 100 : Number(raw)).toFixed(6));
const fromDisplay = (stat, shown) => {
  const value = Number(shown);
  if (!Number.isFinite(value)) return 0;
  return isPercent(stat) ? value / 100 : value;
};

const character = (name) => STATE.characters[name];
const meta = (name) => CONST.characters[name];
const onTeam = (name) => name === CONST.locked || STATE.team.includes(name);

/* ------------------------------------------------------------- engine I/O */

/* The engine answers the same /api/* requests the old Python server did, but
 * locally -- see engine/client.js. Loaded on first use. */
let engine = null;

async function post(path, body) {
  if (engine === null) engine = await import('./engine/client.js');
  return engine.request(path, body);
}

let pending = null;

/* Every edit funnels through here. Calls are debounced so dragging a number
 * field does not fire a request per keystroke. */
function recalc() {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    let payload;
    try {
      payload = await post('/api/calc', STATE);
    } catch (error) {
      return showError(`Could not reach the calculator: ${error.message}`);
    }
    if (payload.error) return showError(payload.error);
    RESULT = payload;
    clearError();
    renderBanner();
    refreshLive();
  }, 120);
}

function showError(message) {
  const box = $('#bannerError');
  box.textContent = message;
  box.hidden = false;
  $('#banner').classList.add('is-stale');
  const inline = $('#rotationError');
  if (inline) { inline.textContent = message; inline.hidden = false; }
}

function clearError() {
  $('#bannerError').hidden = true;
  $('#banner').classList.remove('is-stale');
  const inline = $('#rotationError');
  if (inline) inline.hidden = true;
}

/* -------------------------------------------------------------- the banner */

function conPip(level) {
  const pip = el('span', 'con-pip', `C${level}`);
  if (level >= 6) pip.classList.add('con-pip--max');
  else if (level === 0) pip.classList.add('con-pip--zero');
  return pip;
}

function renderBanner() {
  $('#bannerTitle').textContent = VIEW_TITLES[VIEW];
  if (!RESULT) return;

  $('#statDps').textContent = num(RESULT.dps);
  $('#statTotal').textContent = num(RESULT.total);
  $('#statLength').textContent = `${RESULT.rotation_length.toFixed(2)}s`;
  $('#statCost').textContent = String(RESULT.cost);

  const buffs = RESULT.debug.team_buffs;
  $('#anemoResonanceLight').classList.toggle('is-active', !!buffs.anemo_resonance_active);
  $('#pyroResonanceLight').classList.toggle('is-active', !!buffs.pyro_resonance_active);

  /* On the home screen each chip also carries a share bar; elsewhere the
   * chips condense to keep the banner shallow. The damage figure itself
   * always shows, on every screen. */
  const detailed = VIEW === 'home';
  const chips = $('#bannerChips');
  chips.innerHTML = '';

  const byName = new Map(RESULT.results.map((r) => [r.name, r]));
  RESULT.members.forEach((name) => {
    const result = byName.get(name);
    const chip = el('div', 'chip');
    chip.appendChild(conPip(result.con_level));

    const body = el('div', 'chip-figures');
    body.appendChild(el('span', 'chip-name', name));
    body.appendChild(el('span', 'chip-damage', num(result.total)));
    body.appendChild(el('span', 'chip-share', `${pct(result.share)} of team`));
    if (detailed) {
      const bar = el('div', 'chip-bar');
      bar.style.width = `${Math.max(result.share * 100, 2)}%`;
      body.appendChild(bar);
    }
    chip.appendChild(body);
    bindChipNav(chip, name);
    chips.appendChild(chip);
  });

  /* Benched characters stay visible but dimmed, so swapping is one glance. */
  if (detailed) {
    CONST.roster.filter((name) => !RESULT.members.includes(name)).forEach((name) => {
      const chip = el('div', 'chip chip-absent');
      chip.appendChild(conPip(character(name).con_level));
      const body = el('div', 'chip-figures');
      body.appendChild(el('span', 'chip-name', name));
      body.appendChild(el('span', 'chip-share', 'benched'));
      chip.appendChild(body);
      bindChipNav(chip, name);
      chips.appendChild(chip);
    });
  }
}

/* Clicking a character's chip opens their stat/build editor; it stops the
 * click from reaching the banner-wide handler (bound once in boot()) that
 * would otherwise send a click anywhere else on the banner back home. */
function bindChipNav(chip, name) {
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    SELECTED = name;
    go('characters');
  });
}

/* Repaint the parts of the current view that show calculated numbers, without
 * touching any input the user might be typing in. */
function refreshLive() {
  if (VIEW === 'characters') {
    const panel = $('#statPanel');
    if (panel) renderStatPanel(panel, SELECTED);
    const eyebrow = $('#statEyebrow');
    if (eyebrow) renderStatEyebrow(eyebrow, SELECTED);
  } else if (VIEW === 'stats') {
    renderSources();
    renderDebug();
  } else if (VIEW === 'rotation') {
    updateFieldTimeTotals();
    updateSkillCastNote();
  }
}

/* ------------------------------------------------------------------- views */

function go(view) {
  VIEW = view;
  const tpl = $(`#tpl-${view}`);
  const host = $('#view');
  host.innerHTML = '';
  host.appendChild(tpl.content.cloneNode(true));
  host.querySelectorAll('[data-goto]').forEach((button) =>
    button.addEventListener('click', () => go(button.dataset.goto)));
  /* The result is right there in the panel once this view is showing, so
   * the toast that would otherwise announce it becomes redundant. */
  if (view === 'costscaling') hideOptimizeToast();
  ({ home: renderHome, characters: renderCharacters, rotation: renderRotation, stats: renderStats, costscaling: renderCostScaling })[view]();
  renderBanner();
}

/* ------------------------------------------------------------------- home */

function renderHome() {
  renderTeamSlots();
}

/* Kept separate from renderHome so re-rendering the dropdowns after a change
 * does not also re-append the reset button. */
function renderTeamSlots() {
  document.querySelectorAll('[data-team-slot]').forEach((select) => {
    const index = Number(select.dataset.teamSlot);
    select.innerHTML = '';
    select.appendChild(new Option('— empty —', ''));
    /* Every character is always selectable here -- picking one already in
     * another slot trades the two slots' occupants instead of being blocked. */
    CONST.roster.filter((name) => name !== CONST.locked).forEach((name) =>
      select.appendChild(new Option(name, name)));
    select.value = STATE.team[index] || '';
    select.addEventListener('change', () => {
      const chosen = select.value || null;
      const previousHere = STATE.team[index];
      if (chosen) {
        const elsewhere = STATE.team.findIndex((name, i) => i !== index && name === chosen);
        if (elsewhere !== -1) STATE.team[elsewhere] = previousHere;
      }
      STATE.team[index] = chosen;
      renderTeamSlots();
      recalc();
    });
  });
}

/* ------------------------------------------------------------- characters */

function renderCharacters() {
  const rail = $('#rosterRail');
  rail.innerHTML = '';
  CONST.roster.forEach((name) => {
    const item = el('button', 'roster-item');
    if (name === SELECTED) item.classList.add('is-active');
    if (!onTeam(name)) item.classList.add('is-benched');
    item.appendChild(conPip(character(name).con_level));
    item.appendChild(el('span', null, name));
    if (!onTeam(name)) item.appendChild(el('span', 'roster-flag', 'benched'));
    else if (name === CONST.locked) item.appendChild(el('span', 'roster-flag', 'slot 1'));
    item.addEventListener('click', () => { SELECTED = name; renderCharacters(); });
    rail.appendChild(item);
  });
  renderEditor();
}

function renderStatPanel(host, name) {
  const stats = RESULT ? RESULT.stat_panels[name] : null;
  host.innerHTML = '';
  const row = el('div', 'stat-row');
  // Albedo is DEF-scaling (see VC.Albedo.final_defense), so his panel leads
  // with Defense instead of Attack; everyone else still leads with Attack.
  // EM only ever does anything through a swirl formula, and only
  // Venti/Prune/Faruzan's kits have one -- it's a dead stat for anyone else,
  // so it's left off their panel entirely.
  const isAnemo = meta(name).element === 'Anemo';
  const cells = stats ? [
    stats.defense !== undefined ? ['Defense', num(stats.defense)] : ['Attack', num(stats.attack)],
    ['Crit Rate', pct(stats.crit_rate)],
    ['Crit DMG', pct(stats.crit_damage)],
    [`${stats.element} DMG Bonus`, pct(stats.damage_bonus)],
    ...(isAnemo ? [['Elemental Mastery', num(stats.elemental_mastery)]] : []),
  ] : [['Attack', '—'], ['Crit Rate', '—'], ['Crit DMG', '—'], ['DMG Bonus', '—'], ...(isAnemo ? [['Elemental Mastery', '—']] : [])];

  cells.forEach(([title, value]) => {
    const cell = el('div', 'stat-cell');
    cell.appendChild(el('span', null, title));
    cell.appendChild(el('strong', null, value));
    row.appendChild(cell);
  });
  host.appendChild(row);
  host.appendChild(el('p', 'note', 'Stats include base kit, weapon, and artifacts.'));
}

function switchRow(title, description, value, onChange) {
  const row = el('div', 'switch-row');
  const text = el('div');
  text.appendChild(el('strong', null, title));
  if (description) text.appendChild(el('span', 'hint', description));
  row.appendChild(text);

  const toggle = el('button', `switch${value ? ' is-on' : ''}`);
  toggle.setAttribute('aria-label', title);
  toggle.setAttribute('aria-pressed', String(!!value));
  toggle.addEventListener('click', () => onChange(!value));
  row.appendChild(toggle);
  return row;
}

function dropdown(title, options, value, onChange) {
  const block = el('label', 'field-block');
  block.appendChild(el('span', null, title));
  const select = el('select');
  options.forEach((option) => select.appendChild(new Option(option, option)));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  block.appendChild(select);
  return block;
}

/* Refinement (R1-R5): most weapons have some stat that scales with it, but
 * not all (Favonius series, Sapwood Blade, Lost Prayer are always inert --
 * see ``info.weapon_refinable``, which is worked out per class since the
 * same weapon name can matter for one wielder and not another). The control
 * itself still always shows, since it's harmless to leave on an inert
 * weapon; only the hint changes. */
function refinementField(build, info) {
  const block = dropdown('Refinement', WEAPON_REFINEMENTS, build.weapon_refinement, (value) => {
    build.weapon_refinement = Number(value);
    recalc();
  });
  block.querySelectorAll('option').forEach((option) => { option.textContent = `R${option.value}`; });
  return block;
}

/* Base ATK/DEF is level-dependent (see the Character level dropdown in this
 * same editor), so this reads the live, freshly-calculated figure for
 * whichever level is currently selected rather than static metadata --
 * falling back to that metadata's level-90 default only for the brief window
 * before the first calc response lands. Split out from ``renderEditor`` so
 * ``refreshLive`` can refresh just this line after every recalc, without
 * tearing down and rebuilding the whole editor (and losing focus) on every
 * level-dropdown change. */
function renderStatEyebrow(eyebrow, name) {
  const info = meta(name);
  const panel = RESULT && RESULT.stat_panels[name];
  const liveBaseDefense = panel ? panel.base_defense : info.base_defense;
  const liveBaseAttack = panel ? panel.base_attack : info.base_attack;
  const baseStatLabel = liveBaseDefense !== null && liveBaseDefense !== undefined
    ? `base DEF ${num(liveBaseDefense, 1)}` : `base ATK ${num(liveBaseAttack, 1)}`;
  eyebrow.textContent = `${info.element} · ${baseStatLabel}`;
}

function renderEditor() {
  const host = $('#characterEditor');
  const name = SELECTED;
  const build = character(name);
  const info = meta(name);
  host.innerHTML = '';

  /* --- totals ------------------------------------------------------- */
  const statsPanel = el('section', 'panel');
  const statsHead = el('div', 'panel-head');
  const statsTitle = el('div');
  const eyebrow = el('p', 'eyebrow');
  eyebrow.id = 'statEyebrow';
  statsTitle.appendChild(eyebrow);
  renderStatEyebrow(eyebrow, name);
  statsTitle.appendChild(el('h2', null, `${name} — total stats`));
  statsHead.appendChild(statsTitle);
  if (!onTeam(name)) statsHead.appendChild(el('span', 'hint', 'Not on the team — edits are kept, but contribute nothing.'));
  statsPanel.appendChild(statsHead);
  const panelBody = el('div');
  panelBody.id = 'statPanel';
  renderStatPanel(panelBody, name);
  statsPanel.appendChild(panelBody);
  host.appendChild(statsPanel);

  /* --- constellations ----------------------------------------------- */
  const conPanel = el('section', 'panel');
  const conHead = el('div', 'panel-head');
  const conTitle = el('div');
  conTitle.appendChild(el('p', 'eyebrow', 'Constellations'));
  conTitle.appendChild(el('h2', null, `C${build.con_level}`));
  conHead.appendChild(conTitle);
  conPanel.appendChild(conHead);

  const conRow = el('div', 'con-row');
  const zeroButton = el('button', 'con-toggle con-toggle--zero', 'C0');
  zeroButton.title = 'Clear every constellation';
  if (build.con_level === 0) zeroButton.classList.add('is-on');
  zeroButton.addEventListener('click', () => {
    build.con_level = 0;
    renderCharacters();
    recalc();
  });
  conRow.appendChild(zeroButton);
  for (let n = 1; n <= 6; n += 1) {
    const modelled = info.modelled_constellations.includes(n);
    const button = el('button', 'con-toggle', `C${n}`);
    if (n <= build.con_level) button.classList.add('is-on');
    if (n === 6 && build.con_level >= 6) button.classList.add('is-max');
    if (!modelled) {
      button.classList.add('is-inert');
      button.title = `${name} C${n} has no modelled effect in the calculator`;
    }
    button.addEventListener('click', () => {
      /* Clicking the current level clears it; otherwise jump straight to it.
       * Storing one integer is what makes the cascade automatic. */
      build.con_level = build.con_level === n ? n - 1 : n;
      renderCharacters();
      recalc();
    });
    conRow.appendChild(button);
  }
  conPanel.appendChild(conRow);

  host.appendChild(conPanel);

  /* --- gear and toggles --------------------------------------------- */
  const gearPanel = el('section', 'panel');
  const gearHead = el('div', 'panel-head');
  const gearTitle = el('div');
  gearTitle.appendChild(el('p', 'eyebrow', 'Loadout'));
  gearTitle.appendChild(el('h2', null, 'Weapon & artifact set'));
  gearHead.appendChild(gearTitle);
  gearPanel.appendChild(gearHead);

  const gearGrid = el('div', 'grid-2');
  gearGrid.appendChild(dropdown('Weapon', info.weapons, build.weapon, (value) => {
    build.weapon = value;
    // Refinement is a property of the weapon, not the character -- R5
    // Stringless and Harbinger of Dawn default to R5, everything else to
    // R1 (see ``weapon_default_refinement``), so switching weapons resets
    // to whatever that new weapon's own numbers were already pinned to,
    // rather than carrying over whatever refinement the old one was at.
    build.weapon_refinement = info.weapon_default_refinement[value];
    renderEditor();
    recalc();
  }));
  gearGrid.appendChild(refinementField(build, info));
  gearGrid.appendChild(dropdown('Artifact set', CONST.artifact_sets, build.artifact_set, (value) => {
    build.artifact_set = value;
    renderEditor();   // keeps the active loadout tab's label in step
    recalc();
  }));
  /* Every character levels independently -- this drives their own base
   * ATK/DEF, their own share of enemy defense, and (via swirls they own) the
   * EM reaction multiplier. Only these eleven levels have real data (see
   * ``VC.CHARACTER_LEVELS``), so it's a dropdown rather than a free number. */
  gearGrid.appendChild(dropdown('Character level', CONST.character_levels, build.character_level, (value) => {
    build.character_level = Number(value);
    recalc();
  }));
  gearPanel.appendChild(gearGrid);

  const toggles = el('div', 'grid-2');
  toggles.style.marginTop = '11px';
  if (info.has_burst_toggle) {
    toggles.appendChild(switchRow(
      'Burst enabled',
      build.burst_enabled
        ? ''
        : 'Off: field time drops, and Venti loses the q3 projection ticks her burst grants.',
      build.burst_enabled,
      (value) => { build.burst_enabled = value; renderEditor(); recalc(); },
    ));
  }
  if (toggles.childElementCount) gearPanel.appendChild(toggles);
  host.appendChild(gearPanel);

  /* --- artifacts ----------------------------------------------------- */
  host.appendChild(renderArtifacts(name, build));
}

/* Up to 3 saved (artifact_set, artifacts, substat_preset) bundles per
 * character (see ``character_default_state`` in state.py) so a comparison
 * like "Rising Winds vs. Noblesse" is a click away instead of re-entering
 * substats from scratch every time. ``artifact_set``/``artifacts``/
 * ``substat_preset`` on ``build`` are always whichever loadout is active;
 * this stash holds the others. */
const MAX_ARTIFACT_LOADOUTS = 3;

/* Copies the live loadout fields onto whichever slot is currently marked
 * active, so edits made since the last switch aren't lost when moving away
 * from it. */
function syncActiveLoadout(build) {
  const active = build.artifact_loadouts[build.active_loadout_index];
  active.artifact_set = build.artifact_set;
  active.artifacts = JSON.parse(JSON.stringify(build.artifacts));
  active.substat_preset = build.substat_preset;
}

function applyLoadout(build, index) {
  const loadout = build.artifact_loadouts[index];
  build.active_loadout_index = index;
  build.artifact_set = loadout.artifact_set;
  build.artifacts = JSON.parse(JSON.stringify(loadout.artifacts));
  build.substat_preset = loadout.substat_preset;
}

function switchLoadout(build, index) {
  if (index === build.active_loadout_index) return;
  syncActiveLoadout(build);
  applyLoadout(build, index);
  renderEditor();
  recalc();
}

function addLoadout(build) {
  if (build.artifact_loadouts.length >= MAX_ARTIFACT_LOADOUTS) return;
  syncActiveLoadout(build);
  const copy = JSON.parse(JSON.stringify(build.artifact_loadouts[build.active_loadout_index]));
  build.artifact_loadouts.push(copy);
  applyLoadout(build, build.artifact_loadouts.length - 1);
  renderEditor();
  recalc();
}

function removeLoadout(build, index) {
  if (build.artifact_loadouts.length <= 1) return;
  if (!confirm('Remove this saved artifact set? This cannot be undone.')) return;
  build.artifact_loadouts.splice(index, 1);
  if (index === build.active_loadout_index) {
    applyLoadout(build, Math.max(0, index - 1));
  } else if (index < build.active_loadout_index) {
    build.active_loadout_index -= 1;
  }
  renderEditor();
  recalc();
}

function renderLoadoutTabs(build) {
  const row = el('div', 'loadout-tabs');
  build.artifact_loadouts.forEach((loadout, index) => {
    const isActive = index === build.active_loadout_index;
    const tab = el('div', 'loadout-tab' + (isActive ? ' is-active' : ''));

    const label = el('button', 'loadout-tab-label', isActive ? build.artifact_set : loadout.artifact_set);
    label.type = 'button';
    label.addEventListener('click', () => switchLoadout(build, index));
    tab.appendChild(label);

    if (build.artifact_loadouts.length > 1) {
      const remove = el('button', 'loadout-tab-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove this set';
      remove.addEventListener('click', () => removeLoadout(build, index));
      tab.appendChild(remove);
    }
    row.appendChild(tab);
  });

  if (build.artifact_loadouts.length < MAX_ARTIFACT_LOADOUTS) {
    const add = el('button', 'loadout-tab loadout-tab--add', '+ New set');
    add.type = 'button';
    add.title = 'Add a new artifact set to compare, starting from the active one';
    add.addEventListener('click', () => addLoadout(build));
    row.appendChild(add);
  }
  return row;
}

function renderArtifacts(name, build) {
  const panel = el('section', 'panel');
  const head = el('div', 'panel-head');
  const title = el('div');
  title.appendChild(el('p', 'eyebrow', 'Artifacts'));
  title.appendChild(el('h2', null, 'Main stats & substats'));
  head.appendChild(title);

  /* preset bar -- shares the header line with the title instead of its own row */
  const bar = el('div', 'preset-bar');
  const presetRow = el('label', 'preset-bar-row');
  presetRow.appendChild(el('span', 'hint', 'Presets:'));
  const presetSelect = el('select');
  CONST.presets.forEach((preset) => presetSelect.appendChild(new Option(preset, preset)));
  presetSelect.value = build.substat_preset;
  presetSelect.addEventListener('change', () => { build.substat_preset = presetSelect.value; });
  presetRow.appendChild(presetSelect);
  bar.appendChild(presetRow);

  const apply = el('button', 'accent-button preset-bar-apply', 'Overwrite');
  apply.addEventListener('click', async () => {
    if (!confirm(`Overwrite every substat on ${name} with the "${presetSelect.value}" preset? Hand-entered rolls will be lost. Main stats are kept.`)) return;
    const mainStats = {};
    CONST.pieces.forEach((piece) => { mainStats[piece] = build.artifacts[piece].main_stat.stat; });
    // Crit is optimized against this character's actual weapon/artifact set
    // (e.g. a Crit DMG-heavy, 0% Crit Rate weapon like Uraku frees substats
    // to lean harder into Crit Rate, right up to the 100% cap) plus a
    // present Mona C4's teamwide +15% crit rate -- see VC.generate_preset_substats.
    const monaC4Active = onTeam('Mona') && character('Mona').con_level >= 4;
    const payload = await post('/api/preset', {
      preset: presetSelect.value, character: name,
      weapon: build.weapon, weapon_refinement: build.weapon_refinement, artifact_set: build.artifact_set,
      mona_c4_active: monaC4Active,
      main_stats: mainStats,
    });
    if (payload.error) return showError(payload.error);
    CONST.pieces.forEach((piece) => { build.artifacts[piece].substats = payload.substats[piece]; });
    build.substat_preset = presetSelect.value;
    renderEditor();
    recalc();
  });
  bar.appendChild(apply);
  head.appendChild(bar);
  panel.appendChild(head);

  panel.appendChild(renderLoadoutTabs(build));

  CONST.pieces.forEach((piece) => panel.appendChild(renderPiece(build, piece, name)));
  return panel;
}

function renderPiece(build, piece, name) {
  const artifact = build.artifacts[piece];
  const box = el('div', 'artifact-piece');

  const head = el('div', 'artifact-head');
  head.appendChild(el('span', 'artifact-name', piece[0].toUpperCase() + piece.slice(1)));

  /* main stat: pick the stat, then edit its value */
  const controls = el('div', 'main-stat-controls');
  const statSelect = el('select');
  // EM only ever does anything through a swirl formula, and only
  // Venti/Prune/Faruzan's kits have one -- it's a dead stat for anyone else.
  CONST.piece_main_stat_options[piece]
    .filter((stat) => stat !== 'elemental_mastery' || meta(name).element === 'Anemo')
    .forEach((stat) => statSelect.appendChild(new Option(label(stat), stat)));
  statSelect.value = artifact.main_stat.stat;
  statSelect.addEventListener('change', () => {
    artifact.main_stat.stat = statSelect.value;
    renderEditor();   // the circlet's substat slots depend on its main stat
    recalc();
  });
  controls.appendChild(statSelect);

  const valueInput = el('input');
  valueInput.type = 'number';
  valueInput.step = isPercent(artifact.main_stat.stat) ? '0.1' : '1';
  valueInput.value = toDisplay(artifact.main_stat.stat, artifact.main_stat.value);
  valueInput.addEventListener('input', () => {
    artifact.main_stat.value = fromDisplay(artifact.main_stat.stat, valueInput.value);
    recalc();
  });
  controls.appendChild(valueInput);
  controls.appendChild(el('span', 'unit', isPercent(artifact.main_stat.stat) ? '%' : ''));
  head.appendChild(controls);

  /* the circlet's crit toggle */
  if (piece === 'circlet') {
    const isCritDamage = artifact.main_stat.stat === 'crit_damage';
    const button = el('button', 'ghost-button',
      isCritDamage ? 'Crit DMG ⇄ switch to Crit Rate' : 'Crit Rate ⇄ switch to Crit DMG');
    button.addEventListener('click', () => {
      const oldMain = artifact.main_stat.stat;
      const newMain = oldMain === 'crit_damage' ? 'crit_rate' : 'crit_damage';
      /* A crit circlet carries only the *other* crit stat as a substat, so
       * the visible substat (oldSubstatStat) is always whatever the new main
       * is about to become. Carrying its roll across the swap -- rather than
       * dropping it -- means repeated toggles convert the same roll back and
       * forth: 10% CR -> 20% CD -> 10% CR, doubling into Crit DMG and halving
       * back into Crit Rate each time, matching the game's rough CR:CD value. */
      const oldSubstatStat = newMain;
      const newSubstatStat = oldMain;
      const oldValue = artifact.substats[oldSubstatStat] || 0;
      const convertedValue = oldSubstatStat === 'crit_rate' ? oldValue * 2 : oldValue / 2;

      artifact.main_stat.stat = newMain;
      artifact.main_stat.value = CONST.circlet_crit_main_stats[newMain];
      artifact.substats[oldSubstatStat] = 0;
      artifact.substats[newSubstatStat] = convertedValue;
      renderEditor();
      recalc();
    });
    head.appendChild(button);
  }
  box.appendChild(head);

  /* substats */
  const fields = piece === 'circlet'
    ? circletSubstatFields(artifact.main_stat.stat, name)
    : meta(name).piece_substat_fields[piece];

  const grid = el('div', 'substat-grid');
  fields.forEach((stat) => {
    const block = el('label', 'field-block');
    block.appendChild(el('span', null, fieldLabel(stat)));
    const input = el('input');
    input.type = 'number';
    input.step = isPercent(stat) ? '0.1' : '1';
    input.value = toDisplay(stat, artifact.substats[stat]);
    input.dataset.substat = `${piece}.${stat}`;
    input.addEventListener('input', () => {
      artifact.substats[stat] = fromDisplay(stat, input.value);
      recalc();
    });
    block.appendChild(input);
    grid.appendChild(block);
  });
  box.appendChild(grid);
  return box;
}

/* A crit circlet never doubles up its own main stat as a substat. */
function circletSubstatFields(mainStat, name) {
  const base = meta(name).piece_substat_fields.circlet;
  if (mainStat === 'crit_damage') return base.concat(['crit_rate']);
  if (mainStat === 'crit_rate') return base.concat(['crit_damage']);
  return base.concat(['crit_rate', 'crit_damage']);
}

/* --------------------------------------------------------------- rotation */

// A few known-good rotation notations, quick-selectable instead of typing
// them out by hand each time -- see ``renderRotation``'s own preset select.
const ROTATION_PRESETS = [
  'eq n5d n2e n5d n5e',
  'eq n5d n5e n5d n2',
  'eq n2e n5d n5e n5d',
];

function renderRotation() {
  const input = $('#rotationInput');
  input.value = STATE.rotation.notation;
  input.addEventListener('input', () => {
    STATE.rotation.notation = input.value;
    presetSelect.value = ROTATION_PRESETS.includes(input.value) ? input.value : '';
    recalc();
  });

  const label = input.closest('label');
  const bar = el('div', 'preset-bar');
  const presetRow = el('label', 'preset-bar-row');
  presetRow.appendChild(el('span', 'hint', 'Presets:'));
  const presetSelect = el('select');
  presetSelect.appendChild(new Option('Custom', '', true));
  ROTATION_PRESETS.forEach((notation) => presetSelect.appendChild(new Option(notation, notation)));
  presetSelect.value = ROTATION_PRESETS.includes(STATE.rotation.notation) ? STATE.rotation.notation : '';
  presetSelect.addEventListener('change', () => {
    if (!presetSelect.value) return;
    input.value = presetSelect.value;
    STATE.rotation.notation = presetSelect.value;
    recalc();
  });
  presetRow.appendChild(presetSelect);
  bar.appendChild(presetRow);
  label.parentNode.insertBefore(bar, label);

  renderFieldTimes();
  renderEnemyTable();
  updateSkillCastNote();
}

/* Venti can only actually land a third skill cast in a rotation with Anemo
 * Resonance (another Anemo character on the team) or his own C2 -- see
 * ``VC.venti_effective_skill_casts``. Anything beyond that in the notation
 * is silently dropped rather than erroring, so this flags it instead of
 * leaving the drop invisible. */
function updateSkillCastNote() {
  const note = $('#rotationSkillCastNote');
  if (!note) return;
  const rotation = RESULT && RESULT.debug.rotation;
  if (!rotation || !rotation.skill_casts_truncated) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = `Skill cast truncated: ${rotation.skill_casts} → ${rotation.effective_skill_casts}.`;
}

function tableHead(columns) {
  const thead = el('thead');
  const row = el('tr');
  columns.forEach(([text, cls]) => row.appendChild(el('th', cls, text)));
  thead.appendChild(row);
  return thead;
}

/* Whether one of a character's conditional field time modifiers (see
 * ``FIELD_TIME_MODIFIERS`` in state.py) is currently in effect. Every
 * condition here reads a toggle the browser already renders elsewhere, so no
 * extra bookkeeping is needed just to know whether a modifier applies. */
function fieldTimeModifierActive(name, condition) {
  const build = character(name);
  switch (condition) {
    case 'burst_enabled': return !!build.burst_enabled;
    case 'weapon_patrol_song': return build.weapon === 'Patrol Song';
    case 'c6_enabled': return build.con_level >= 6;
    default: return false;
  }
}

/* A client-side preview of one character's total field time -- base plus
 * whichever modifiers currently apply. Used for benched characters, which
 * the server never computes a field time for since they don't enter the
 * rotation; a character actually on the team instead shows the server's own
 * number (see ``updateFieldTimeTotals``), so the two can never drift apart
 * for anyone whose seconds actually count toward the rotation length. */
function previewFieldTime(name) {
  const info = meta(name);
  const build = character(name);
  const base = Number(build[info.field_time_base_field]) || 0;
  const bonus = (info.field_time_modifiers || []).reduce((sum, modifier) => {
    if (!fieldTimeModifierActive(name, modifier.condition)) return sum;
    const value = Number(build[modifier.field]) || 0;
    return sum + (modifier.sign === -1 ? -value : value);
  }, 0);
  return base + bonus;
}

/* One self-contained card per character rather than a shared table.
 *
 * The table version kept coming back with misaligned rows: every row's
 * height is forced by its tallest cell (usually the Base input), so
 * whichever *other* cell in that row happened to be shorter -- a bare "none"
 * where a character has no modifiers, one modifier's worth of height where
 * another has two -- ended up padded differently, and no vertical-align
 * tweak fixed it for every combination at once, because the underlying
 * problem is structural: a table forces unrelated rows to negotiate a shared
 * height and shared column grid at all. A card has neither -- each
 * character's fields lay out purely against their own siblings, so there is
 * nothing left for a neighboring character's content to misalign with. */
function renderFieldTimes() {
  const host = $('#fieldTimeTable');
  host.innerHTML = '';

  CONST.roster.forEach((name) => {
    const info = meta(name);
    const card = el('div', 'character-detail-card');
    if (!onTeam(name)) card.classList.add('is-benched');

    const head = el('div', 'character-detail-head');
    head.appendChild(el('span', 'character-detail-name', name));

    const slotIndex = name === CONST.locked ? -1 : STATE.team.indexOf(name);
    const slotLabel = name === CONST.locked ? 'Slot 1' : (slotIndex === -1 ? 'Benched' : `Slot ${slotIndex + 2}`);
    head.appendChild(el('span', 'character-detail-slot', slotLabel));
    card.appendChild(head);

    const fieldTimeRow = el('div', 'character-detail-field-time');

    const baseField = el('label', 'detail-field');
    baseField.appendChild(el('span', 'hint', 'Base (s)'));
    const baseInput = el('input');
    baseInput.type = 'number';
    baseInput.step = '0.5';
    baseInput.min = '0';
    baseInput.value = character(name)[info.field_time_base_field];
    baseInput.addEventListener('input', () => {
      character(name)[info.field_time_base_field] = Number(baseInput.value) || 0;
      recalc();
      updateFieldTimeTotals();
    });
    baseField.appendChild(baseInput);
    fieldTimeRow.appendChild(baseField);

    (info.field_time_modifiers || []).forEach((modifier) => {
      const modField = el('label', 'detail-field field-time-modifier');
      if (fieldTimeModifierActive(name, modifier.condition)) modField.classList.add('is-active');
      if (modifier.note) modField.title = modifier.note;
      modField.appendChild(el('span', 'hint', `${modifier.sign === -1 ? '−' : '+'} ${modifier.label}${modifier.note ? ' ⓘ' : ''}`));
      const input = el('input');
      input.type = 'number';
      input.step = '0.1';
      input.min = '0';
      input.value = character(name)[modifier.field];
      input.addEventListener('input', () => {
        character(name)[modifier.field] = Number(input.value) || 0;
        recalc();
        updateFieldTimeTotals();
      });
      modField.appendChild(input);
      fieldTimeRow.appendChild(modField);
    });

    const totalField = el('div', 'detail-field field-time-total');
    totalField.appendChild(el('span', 'hint', 'Total'));
    const totalValue = el('strong');
    totalValue.dataset.fieldTimeTotal = name;
    totalField.appendChild(totalValue);
    fieldTimeRow.appendChild(totalField);

    card.appendChild(fieldTimeRow);
    host.appendChild(card);
  });

  const summary = el('div', 'character-detail-summary');
  summary.appendChild(el('span', null, 'Rotation length'));
  const rotationValue = el('span');
  rotationValue.id = 'fieldTimeRotationLength';
  summary.appendChild(rotationValue);
  host.appendChild(summary);

  updateFieldTimeTotals();
}

/* Repaints just the computed numbers (per-character totals, rotation length)
 * without rebuilding the cards, so it can run after every keystroke without
 * losing focus on whichever input the user is mid-edit in. */
function updateFieldTimeTotals() {
  const host = $('#fieldTimeTable');
  if (!host) return;
  CONST.roster.forEach((name) => {
    const cell = host.querySelector(`[data-field-time-total="${name}"]`);
    if (!cell) return;
    const slotEntry = RESULT && onTeam(name) ? RESULT.debug.slots.find((s) => s.name === name) : null;
    const seconds = slotEntry ? slotEntry.field_time : previewFieldTime(name);
    cell.textContent = `${seconds.toFixed(2)}s`;
    cell.classList.toggle('hint', !slotEntry);
  });
  const rotationCell = $('#fieldTimeRotationLength');
  if (rotationCell) rotationCell.textContent = RESULT ? `${RESULT.rotation_length.toFixed(2)}s` : '—';
}

function renderEnemyTable() {
  const table = $('#enemyTable');
  table.innerHTML = '';
  table.appendChild(tableHead([['Setting'], ['Value', 'numeric']]));
  const body = el('tbody');

  const rows = [
    ['Enemy level', STATE.enemy, 'level', 1, false],
    ['Enemy elemental RES', STATE.enemy, 'base_resistance', 1, true],
    ['Enemy physical RES', STATE.enemy, 'physical_resistance', 1, true],
  ];

  rows.forEach(([title, target, key, step, percent]) => {
    const row = el('tr');
    row.appendChild(el('td', null, title));
    const cell = el('td', 'numeric');
    const input = el('input');
    input.type = 'number';
    input.step = percent ? '0.1' : String(step);
    input.value = percent ? Number(target[key]) * 100 : target[key];
    input.addEventListener('input', () => {
      const value = Number(input.value) || 0;
      target[key] = percent ? value / 100 : value;
      recalc();
    });
    cell.appendChild(input);
    row.appendChild(cell);
    body.appendChild(row);
  });

  table.appendChild(body);
}

/* ------------------------------------------------------------ damage stats */

function renderStats() {
  renderSources();
  renderDebug();
}

/* A single reusable <dialog> listing every individual timestamped hit
 * behind one ability row, in the order it landed -- only shown once
 * ``_hits_for_row`` (state.py) confirms every hit making up that row's
 * damage is actually tracked. */
function showHitLogModal(characterName, abilityName, hitLog) {
  let dialog = $('#hitLogModal');
  if (!dialog) {
    dialog = el('dialog', 'breakdown-modal');
    dialog.id = 'hitLogModal';
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  dialog.innerHTML = '';
  const heading = el('h3', null, `${characterName} — ${abilityName} — individual hits`);
  dialog.appendChild(heading);
  const table = el('table', 'data-table');
  table.appendChild(tableHead([
    ['#', 'numeric'], ['Time (s)', 'numeric'], ['Adjusted', 'numeric'], ['Not crit', 'numeric'], ['Crit', 'numeric'],
  ]));
  const body = el('tbody');
  const total = hitLog.reduce((sum, hit) => sum + hit.damage, 0);
  hitLog.forEach((hit, index) => {
    const row = el('tr');
    row.appendChild(el('td', 'numeric', String(index + 1)));
    row.appendChild(el('td', 'numeric', num(hit.time, 2)));
    row.appendChild(el('td', 'numeric', num(hit.damage)));
    row.appendChild(el('td', 'numeric', num(hit.no_crit)));
    row.appendChild(el('td', 'numeric', num(hit.guaranteed_crit)));
    body.appendChild(row);
  });
  const totalRow = el('tr', 'row-total');
  totalRow.appendChild(el('td'));
  totalRow.appendChild(el('td', null, 'Total'));
  totalRow.appendChild(el('td', 'numeric', num(total)));
  totalRow.appendChild(el('td'));
  totalRow.appendChild(el('td'));
  body.appendChild(totalRow);
  table.appendChild(body);
  dialog.appendChild(table);
  const closeButton = el('button', 'ghost-button breakdown-modal-close', 'Close');
  closeButton.type = 'button';
  closeButton.addEventListener('click', () => dialog.close());
  dialog.appendChild(closeButton);
  dialog.showModal();
}

function renderSources() {
  const host = $('#sourceList');
  if (!host) return;
  host.innerHTML = '';
  if (!RESULT) return;

  RESULT.results.forEach((result) => {
    const group = el('details', 'source-group');
    group.open = true;
    const summary = el('summary');
    summary.appendChild(el('span', null, `${result.name} — ${result.abilities.length} sources`));
    summary.appendChild(el('span', 'source-summary-figures',
      `${num(result.total)}  ·  ${pct(result.share)} of team`));
    group.appendChild(summary);

    const wrap = el('div', 'table-wrap');
    const table = el('table', 'data-table');
    table.appendChild(tableHead([
      ['Damage source'], ['From'], ['Damage', 'numeric'],
      ['% of character', 'numeric'], ['% of team', 'numeric'], ['Hit log'], [''],
    ]));
    const body = el('tbody');
    result.abilities.forEach((ability) => {
      const row = el('tr');
      row.appendChild(el('td', null, ability.name));
      row.appendChild(el('td', null, result.name));
      row.appendChild(el('td', 'numeric', num(ability.damage)));
      row.appendChild(el('td', 'numeric', pct(ability.share_of_character)));
      row.appendChild(el('td', 'numeric', pct(ability.share_of_team)));
      const hitLogCell = el('td');
      if (ability.hit_log) {
        const hitLogButton = el('button', 'ghost-button breakdown-button', 'Hits');
        hitLogButton.type = 'button';
        hitLogButton.addEventListener('click', () => showHitLogModal(result.name, ability.name, ability.hit_log));
        hitLogCell.appendChild(hitLogButton);
      } else {
        hitLogCell.textContent = '—';
      }
      row.appendChild(hitLogCell);
      const barCell = el('td', 'bar-cell');
      const bar = el('div', 'bar');
      bar.style.width = `${Math.max(ability.share_of_character * 100, 1)}%`;
      barCell.appendChild(bar);
      row.appendChild(barCell);
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    group.appendChild(wrap);
    host.appendChild(group);
  });

  // Clarification, kept for reference but no longer shown in the UI:
  // Sources named after another character (for example "durin c1 quill" under Prune) are damage
  // that character's kit grants, but which lands on and scales with the listed character's hits.
  // It is counted once, against whoever takes the hit.
}

function simpleTable(rows, columns) {
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data-table');
  table.appendChild(tableHead(columns));
  const body = el('tbody');
  rows.forEach((cells) => {
    const row = el('tr');
    cells.forEach((cell, index) => {
      row.appendChild(el('td', index === 0 ? null : 'numeric', cell));
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function debugPanel(eyebrow, title, node, note) {
  const panel = el('section', 'panel');
  const head = el('div', 'panel-head');
  const heading = el('div');
  heading.appendChild(el('p', 'eyebrow', eyebrow));
  heading.appendChild(el('h2', null, title));
  head.appendChild(heading);
  panel.appendChild(head);
  panel.appendChild(node);
  // `note` (clarification text passed by callers) is intentionally not
  // rendered -- kept as a parameter so the explanatory text stays in the
  // code for reference without bleeding into the UI.
  return panel;
}

/* Buff timeline -- a visual read of RESULT.debug.buff_timeline (built by
 * ``state.py``'s ``_buff_timeline``, generic over whatever team is
 * currently selected). One row per present buff source showing WHEN it's
 * actually active over the rotation, plus a curve for the handful of
 * buffs that ramp live rather than switching on/off (Prune's team DMG%
 * bonus). This is deliberately recipient-agnostic -- see the "On field"
 * row to reason about which on-field-only buffs (Bennett's flat ATK,
 * Nicole's base 300) reach whoever's actually up at a given instant; the
 * per-character "Team buffs applied to X" panels below already give the
 * exact damage-weighted number for that. */
const BT_CHAR_COLORS = ['var(--green)', 'var(--blue)', 'var(--gold)', 'var(--red)'];

function buffTimelinePanel(bt) {
  const wrap = el('div', 'bt-wrap');
  if (!bt || (!bt.windows.length && !bt.curves.length)) {
    wrap.appendChild(el('p', 'hint', 'No teammate-sourced buffs are active for this team right now.'));
    return wrap;
  }

  const rowH = 22, rowGap = 5, curveH = 96;
  const period = bt.period;
  const svgW = 640, marginL = 4, marginR = 6;
  const plotW = svgW - marginL - marginR;
  const xScale = (t) => marginL + (t / period) * plotW;

  const charColor = {};
  bt.characters.forEach((c, i) => { charColor[c.name] = BT_CHAR_COLORS[i % BT_CHAR_COLORS.length]; });

  // Bars draw straight from ``bt.windows`` -- the real engine's own windows
  // (RotationTimeline's default "(re)cast the instant source leaves the
  // field" model, Nicole's own kit buffs excepted -- see
  // ``RotationTimeline``'s own class docstring in VentiCalcs.py), same as
  // the "Team buffs applied to X" tables below.
  bt.windows.forEach((w) => { w._displayWindows = w.windows; });

  // rows: on-field + one per window; curves get their own taller row(s) after
  const rows = [{ kind: 'onfield' }, ...bt.windows.map((w) => ({ kind: 'window', w }))];
  const bodyH = rows.length * (rowH + rowGap);
  const curvesH = bt.curves.length * (curveH + rowGap);
  const totalH = bodyH + curvesH + 16; // + axis strip

  const labelCol = el('div', 'bt-labels');
  labelCol.style.height = totalH + 'px';
  const onfieldLabel = el('div', 'bt-label', 'On field');
  onfieldLabel.style.height = rowH + 'px';
  labelCol.appendChild(onfieldLabel);
  bt.windows.forEach((w) => {
    const lbl = el('div', 'bt-label', `${w.source} — ${w.label}`);
    lbl.title = `${w.source} — ${w.label}: ${w.kind === 'percent' ? pct(w.value) : num(w.value, 1)}`;
    lbl.style.height = rowH + 'px';
    labelCol.appendChild(lbl);
  });
  bt.curves.forEach((c) => {
    const lbl = el('div', 'bt-label bt-label-curve', `${c.source} — ${c.label}`);
    lbl.style.height = curveH + 'px';
    labelCol.appendChild(lbl);
  });

  let svg = `<svg viewBox="0 0 ${svgW} ${totalH}" width="${svgW}" height="${totalH}" preserveAspectRatio="none" class="bt-svg">`;

  // vertical gridlines at each integer second, spanning the full height
  for (let s = 0; s <= Math.floor(period); s++) {
    const x = xScale(s);
    svg += `<line class="bt-grid" x1="${x}" y1="0" x2="${x}" y2="${bodyH + curvesH}" />`;
  }

  let y = 0;
  // on-field row
  bt.characters.forEach((c) => {
    const x = xScale(c.start), w = xScale(c.start + c.field_time) - x;
    svg += `<rect class="bt-band" x="${x.toFixed(1)}" y="${y}" width="${Math.max(0.5, w).toFixed(1)}" height="${rowH}" rx="3" fill="${charColor[c.name]}" />`;
  });
  y += rowH + rowGap;

  // one row per window buff
  bt.windows.forEach((w) => {
    w._displayWindows.forEach(([a, b]) => {
      const x = xScale(a), width = xScale(b) - x;
      svg += `<rect class="bt-band bt-band-buff" x="${x.toFixed(1)}" y="${y}" width="${Math.max(0.5, width).toFixed(1)}" height="${rowH}" rx="3" />`;
    });
    y += rowH + rowGap;
  });

  // curves
  const hoverCurves = [];
  bt.curves.forEach((c) => {
    const vals = c.points.map((p) => p[1]);
    const yMax = Math.max(10, Math.ceil(Math.max(...vals) * 1.15 / 10) * 10);
    const yScale = (v) => y + curveH - (v / yMax) * curveH;
    [0, yMax / 2, yMax].forEach((v) => {
      const cy = yScale(v);
      svg += `<line class="bt-grid" x1="0" y1="${cy}" x2="${svgW}" y2="${cy}" />`;
      svg += `<text class="bt-axis-label" x="2" y="${cy - 2}">${Math.round(v)}%</text>`;
    });
    let path = '';
    c.points.forEach((p, i) => {
      const px = xScale(p[0]), py = yScale(p[1]);
      path += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1) + ' ';
    });
    svg += `<path class="bt-curve" d="${path}" />`;
    hoverCurves.push({ top: y, yScale, points: c.points });
    y += curveH + rowGap;
  });

  // axis (seconds) along the bottom
  for (let s = 0; s <= Math.floor(period); s += Math.ceil(period / 10)) {
    svg += `<text class="bt-axis-label" x="${xScale(s)}" y="${y + 11}" text-anchor="middle">${s}s</text>`;
  }

  // hover crosshair + tooltip target
  svg += `<line class="bt-hover-line" x1="0" y1="0" x2="0" y2="${bodyH + curvesH}" />`;
  hoverCurves.forEach((_, i) => { svg += `<circle class="bt-hover-dot" r="3.5" data-curve="${i}" />`; });
  svg += `<rect x="0" y="0" width="${svgW}" height="${totalH}" fill="transparent" class="bt-hover-target" />`;
  svg += `</svg>`;

  const chartCol = el('div', 'bt-chart');
  chartCol.innerHTML = svg;

  const row = el('div', 'bt-row');
  row.appendChild(labelCol);
  row.appendChild(chartCol);
  wrap.appendChild(row);
  wrap.appendChild(el('p', 'hint',
    `One rotation = ${num(period, 1)}s. Solid bars show exactly when a buff is live (by default, (re)cast the `
    + 'instant its source leaves the field, every cycle, running for its stated duration from there -- Nicole’s '
    + 'own kit buffs are the one exception, still cast the instant she comes on field -- same timing the "Team '
    + 'buffs applied to X" tables below use); full-uptime buffs are left off the list entirely. The line is a buff '
    + 'that ramps continuously instead of switching on/off. Hover to read exact values.'));

  // hover wiring
  const svgEl = chartCol.querySelector('svg');
  const hoverLine = svgEl.querySelector('.bt-hover-line');
  const hoverDots = svgEl.querySelectorAll('.bt-hover-dot');
  const target = svgEl.querySelector('.bt-hover-target');
  let tooltip = $('#btTooltip');
  if (!tooltip) {
    tooltip = el('div', 'bt-tooltip');
    tooltip.id = 'btTooltip';
    document.body.appendChild(tooltip);
  }

  function activeAt(intervals, t) {
    return intervals.some(([a, b]) => t >= a && t < b);
  }

  target.addEventListener('mousemove', (evt) => {
    const box = svgEl.getBoundingClientRect();
    const localX = (evt.clientX - box.left) * (svgW / box.width);
    const t = Math.max(0, Math.min(period, ((localX - marginL) / plotW) * period));
    const x = xScale(t);
    hoverLine.setAttribute('x1', x); hoverLine.setAttribute('x2', x); hoverLine.style.opacity = 1;

    const onfieldChar = bt.characters.find((c) => t >= c.start && t < c.start + c.field_time);
    let html = `<b>t = ${t.toFixed(1)}s</b><br>on field: ${onfieldChar ? onfieldChar.name : '—'}`;
    bt.windows.forEach((w) => {
      const on = activeAt(w._displayWindows, t);
      html += `<br>${w.source} ${w.label}: ${on ? (w.kind === 'percent' ? pct(w.value) : `+${num(w.value, 1)}`) : 'off'}`;
    });
    hoverCurves.forEach((hc, i) => {
      let nearest = hc.points[0];
      for (const p of hc.points) { if (Math.abs(p[0] - t) < Math.abs(nearest[0] - t)) nearest = p; }
      const dot = hoverDots[i];
      dot.setAttribute('cx', xScale(nearest[0]));
      dot.setAttribute('cy', hc.yScale(nearest[1]));
      dot.style.opacity = 1;
      html += `<br>${bt.curves[i].source} ${bt.curves[i].label}: ${nearest[1].toFixed(1)}%`;
    });
    tooltip.innerHTML = html;
    tooltip.style.opacity = 1;
    tooltip.style.left = (evt.clientX + 14) + 'px';
    tooltip.style.top = (evt.clientY + 14) + 'px';
  });
  target.addEventListener('mouseleave', () => {
    hoverLine.style.opacity = 0;
    hoverDots.forEach((dot) => { dot.style.opacity = 0; });
    tooltip.style.opacity = 0;
  });

  return wrap;
}

function renderDebug() {
  const host = $('#debugPanels');
  if (!host) return;
  host.innerHTML = '';
  if (!RESULT) return;
  const d = RESULT.debug;

  host.appendChild(debugPanel('Team', 'Buff timeline', buffTimelinePanel(d.buff_timeline)));

  host.appendChild(debugPanel('Target', 'Resistance after shred', simpleTable(
    d.resistances.map((r) => [r.element, pct(r.value), r.multiplier.toFixed(4)]),
    [['Element'], ['RES', 'numeric'], ['Multiplier', 'numeric']],
  ), 'RES below 0 is halved rather than fully credited, and RES at or above 75% uses the '
     + 'diminishing form 1 / (4·RES + 1) — the calculator’s resistance_multiplier.'));

  host.appendChild(debugPanel('Target', 'Where the shred comes from', simpleTable(
    d.shred_sources.map((s) => [s.name, pct(s.value)]),
    [['Source'], ['RES reduction', 'numeric']],
  )));

  host.appendChild(debugPanel('Target', 'Defense', simpleTable(
    d.defense.by_character.map((c) => [c.name, String(c.character_level), c.multiplier.toFixed(4)]),
    [['Character'], ['Level', 'numeric'], ['Defense multiplier', 'numeric']],
  ), `Enemy level ${d.defense.enemy_level} · defense ignored (Nicole C6) ${pct(d.defense.defense_ignore)} · `
  + `defense reduced (Durin C6) ${pct(d.defense.defense_reduction)}. Each character levels independently, `
  + 'so the multiplier is per-character; ignore and reduction are separate multipliers and stack with each other.'));

  const b = d.team_buffs;

  // One shared renderer for every present character's own "team buffs
  // applied to X" panel (skipped when a character receives none) --
  // ``uptime``/``hit_coverage`` are now the REAL, damage-weighted fraction
  // of that character's own actual timestamped hits where the buff is
  // genuinely active at that hit's own instant (see state.py's
  // ``_real_uptime``), not a blended average over their whole on-field arc.
  // With the tick engine a buff can be up for some of a character's real
  // hits and not others -- Durin's dagger ticks are the clearest example,
  // but Prune's own Hex ticks and Nicole's projections work the same way --
  // so every row reads "N of M real hits" instead of a single seconds figure.
  function renderTeamBuffsPanel(name, rows) {
    if (!rows.length) return;
    host.appendChild(debugPanel(name, `Team buffs applied to ${name}`, simpleTable(
      rows.map((row) => [
        row.source,
        row.buff + (row.note ? ` *` : ''),
        row.kind === 'percent' ? pct(row.value) : num(row.value, 1),
        `${pct(row.uptime)} (${row.hit_coverage})`,
      ]),
      [['Source'], ['Buff'], ['Value', 'numeric'], ['Real uptime', 'numeric']]),
    `One independent row per source and per buff -- nothing from ${name}'s own artifacts, weapon, or `
    + 'constellations is listed here, only what a teammate’s kit or a team-wide artifact set effect actually '
    + `grants them. "Real uptime" is the damage-weighted fraction of ${name}'s own REAL, individually-timestamped `
    + 'hits this rotation where the buff is genuinely active at that hit’s own instant -- e.g. "73% (16 of 22 real '
    + 'hits)" means 16 of that character’s 22 actual hits landed while it was up, weighted by how much damage each '
    + 'one did. This is a TIMING check only, not element-aware, so an element-locked bonus (Faruzan’s Anemo-only '
    + 'crit DMG, Celestial Gift’s two separate components) can show as "active" against a hit it wouldn’t actually '
    + 'touch -- those rows carry their own note calling that out. A row marked * has a caveat (hover isn’t '
    + 'available here, so see below): '
    + rows.filter((row) => row.note).map((row) => `${row.source} ${row.buff} — ${row.note}.`).join(' ')));
  }

  RESULT.members.forEach((name) => renderTeamBuffsPanel(name, d.team_buffs_by_character[name] || []));

  host.appendChild(debugPanel('Venti', 'Elemental absorption', simpleTable([
    ['Absorption source', b.venti_absorption_source || 'nobody'],
    ['Absorbed element', b.venti_absorption_element || '—'],
    ['Absorption active', b.venti_absorption_active ? 'yes' : 'no'],
  ], [['Quantity'], ['Value', 'numeric']]),
  'Venti’s burst only imbues an element — and only then does his kit get burst 2’s 16 hits, his swirls, and '
  + 'the flat 50% elemental-absorption damage bonus his kit otherwise carries entirely — while someone present '
  + 'actually grants him one, by priority: Fischl (Electro) > Durin (Pyro) > Mona (Hydro) > '
  + 'Bennett (Pyro). The other Anemo characters share the same dependency. Prune’s entire kit runs on this same '
  + 'Hex: her burst 3 (her own absorbed-element ticks, switching element right alongside Venti’s) and every '
  + 'swirl she triggers, the 60% ATK to herself (only while Venti’s own field-time window is active — see her own '
  + 'Damage Stats panel), her C2’s 20%→40% ramp (builds up over the 4s after her Hex ticks begin, not a flat 40%), '
  + 'the 350 flat ATK her C6 grants both herself and Venti, the 30% ATK her Hex grants Venti (same field-time '
  + 'window as her own 60%), and her team-wide up-to-50% damage bonus (her one non-artifact/weapon team buff, '
  + 'reaching every other present teammate but never herself) — all of it disappears together with nobody to absorb. '
  + 'Faruzan’s C6 swirl needs it for '
  + 'the same reason. Absent all four candidates, the source is “nobody” and every one of those disappears '
  + 'rather than defaulting to Pyro — see the burst 2/3 and swirl rows above under Damage Stats. (Prune’s own '
  + 'stat panel under Edit Characters never included these kit buffs to begin with — it’s build-only, same '
  + 'as everyone else’s — so it looks the same either way.)'));

  host.appendChild(debugPanel('Team', 'Slots and field time', simpleTable(
    d.slots.map((s) => [s.name, String(s.slot), `${s.field_time}s`]),
    [['Character'], ['Slot', 'numeric'], ['Field time', 'numeric']],
  ), `Rotation length is the sum of field times (${RESULT.rotation_length.toFixed(2)}s), not a fixed `
     + 'constant — swapping the team changes it, and DPS with it. Slot order (highest slot first, Venti '
     + 'always last) decides how far each buff’s real duration reaches — see the per-buff uptime in '
     + '"Team buffs applied to Venti" below.'));

  const r = d.rotation;
  host.appendChild(debugPanel('Rotation', 'Parsed rotation', simpleTable([
    ['Notation', r.notation],
    ['Skill casts (e)', String(r.skill_casts)],
    ['Burst casts (q)', String(r.burst_casts)],
    ['Dashes (d)', String(r.dash_count)],
    ['Normal strings', r.normal_sequences.map((n) => `n${n}`).join(' ') || 'none'],
    ['Arrows per normal (N1–N6)', r.normal_arrow_counts.join(' / ')],
    ['C1 extra arrows (N1–N6)', r.c1_arrow_counts.join(' / ')],
    ['Total normal arrows', String(r.total_normal_arrows)],
    ['Burst 1 hits per cast', String(r.burst_first_hits_per_cast)],
    ['Burst 2 hits per cast', String(r.burst_second_hits_per_cast)],
    ['Swirls per burst', String(r.swirls_per_burst)],
    ['Harp procs', String(r.harp_trigger_count)],
  ], [['Quantity'], ['Value', 'numeric']]),
  'The first e is the activation cast: it deals damage before Venti’s 4pc set and Prune’s '
  + 'Hex/C6 buffs are live, then enables them for the rest of the rotation. C1 arrows are each worth '
  + '20% of their base arrow.'));
}

/* -------------------------------------------------------- cost scaling */

/* Kept outside renderCostScaling so the form remembers its own values
 * across a Home round-trip (or a failed/slow search) instead of resetting
 * every time the view is reopened. */
const COST_SCALING_FORM = {
  artifact_investment: 'mine',
  f2p: false,
  four_star_con_level: 'mine',
  total_cost: 6,
  exclude_bennett_absorption: true,
};

function relabelOptions(block, labels) {
  block.querySelectorAll('option').forEach((option) => {
    option.textContent = labels[option.value] || option.value;
  });
  return block;
}

function renderCostScaling() {
  const form = $('#costScalingForm');
  form.innerHTML = '';

  form.appendChild(relabelOptions(
    dropdown('Artifact investment', ['low', 'medium', 'high', 'KQM', 'mine'], COST_SCALING_FORM.artifact_investment,
      (value) => { COST_SCALING_FORM.artifact_investment = value; }),
    { low: 'Low', medium: 'Medium', high: 'High', KQM: 'KQM', mine: 'Use mine' },
  ));

  const f2pField = relabelOptions(
    dropdown('F2P', ['no', 'yes'], COST_SCALING_FORM.f2p ? 'yes' : 'no',
      (value) => { COST_SCALING_FORM.f2p = value === 'yes'; }),
    { no: 'No', yes: 'Yes' },
  );
  f2pField.appendChild(el('span', 'hint', 'Cheap weapons and C0 standard characters.'));
  form.appendChild(f2pField);

  const fourStarConField = relabelOptions(
    dropdown('4-star constellation level', ['0', '2', '6', 'mine'], COST_SCALING_FORM.four_star_con_level,
      (value) => { COST_SCALING_FORM.four_star_con_level = value; }),
    { 0: 'C0', 2: 'C2', 6: 'C6', mine: 'Use mine' },
  );
  form.appendChild(fourStarConField);

  const bennettField = relabelOptions(
    dropdown('Bennett absorption', ['yes', 'no'], COST_SCALING_FORM.exclude_bennett_absorption ? 'no' : 'yes',
      (value) => { COST_SCALING_FORM.exclude_bennett_absorption = value === 'no'; }),
    { yes: 'Allow (optimistic)', no: "Don't count on it" },
  );
  bennettField.appendChild(el('span', 'hint', 'Allow Bennett to apply Pyro for absorption.'));
  form.appendChild(bennettField);

  const costBlock = el('label', 'field-block');
  costBlock.appendChild(el('span', null, 'Total cost'));
  const costInput = el('input');
  costInput.type = 'number';
  costInput.min = '1';
  costInput.step = '1';
  costInput.value = COST_SCALING_FORM.total_cost;
  costInput.addEventListener('input', () => {
    COST_SCALING_FORM.total_cost = Math.max(1, Number(costInput.value) || 1);
  });
  costBlock.appendChild(costInput);
  form.appendChild(costBlock);

  $('#costScalingCalculate').onclick = runCostScalingOptimize;
  syncOptimizePanel();
}

/* Kicks the optimizer off and returns immediately -- it does not await the
 * request, so clicking off to another menu never interrupts it. Whichever
 * view is showing when the request settles decides how that's reported:
 * repaint the panel in place if still here, otherwise pop the corner toast. */
async function runCostScalingOptimize() {
  if (OPTIMIZE.status === 'running') return;

  const params = {
    state: STATE,
    artifact_investment: COST_SCALING_FORM.artifact_investment,
    f2p: COST_SCALING_FORM.f2p,
    four_star_con_level: COST_SCALING_FORM.four_star_con_level,
    total_cost: COST_SCALING_FORM.total_cost,
    exclude_bennett_absorption: COST_SCALING_FORM.exclude_bennett_absorption,
  };

  OPTIMIZE = { status: 'running' };
  hideOptimizeToast();
  syncOptimizePanel();

  try {
    const payload = await post('/api/optimize', params);
    // Deliberately NOT applied to STATE here -- the result is only loaded
    // onto the live team if the user clicks "Apply this team" below, so
    // running the optimizer never silently overwrites whatever build they
    // currently have set up.
    OPTIMIZE = payload.error
      ? { status: 'error', error: payload.error }
      : { status: 'done', payload };
  } catch (error) {
    OPTIMIZE = { status: 'error', error: `Could not reach the calculator: ${error.message}` };
  }

  if (VIEW === 'costscaling') syncOptimizePanel();
  else showOptimizeToast();
}

/* Repaints the Cost Scamming panel to match OPTIMIZE. Called both right
 * after a render and again whenever a run settles while still on this
 * view -- a no-op the rest of the time since the elements it looks up
 * won't exist once the user has navigated elsewhere. */
function syncOptimizePanel() {
  const panel = $('#costScalingResultPanel');
  const host = $('#costScalingResult');
  const errorBox = $('#costScalingError');
  const button = $('#costScalingCalculate');
  if (!panel || !host || !errorBox || !button) return;

  /* The button itself is the "it's running" signal -- it vanishes on click
   * rather than sitting there disabled, so there's nothing left implying a
   * second click would do anything (with settings mid-edit or otherwise). */
  if (OPTIMIZE.status === 'running') {
    button.hidden = true;
    errorBox.hidden = true;
    panel.hidden = false;
    host.innerHTML = '';
    host.appendChild(renderOptimizeLoading());
    return;
  }

  button.hidden = false;

  if (OPTIMIZE.status === 'error') {
    errorBox.textContent = OPTIMIZE.error;
    errorBox.hidden = false;
    panel.hidden = true;
    return;
  }

  errorBox.hidden = true;
  if (OPTIMIZE.status === 'done') renderCostScalingResult(OPTIMIZE.payload);
  else panel.hidden = true;
}

function renderOptimizeLoading() {
  const wrap = el('div', 'optimize-loading');
  wrap.appendChild(el('div', 'optimize-spinner'));
  wrap.appendChild(el('span', null, 'Running the optimizer… this can take several minutes.'));
  return wrap;
}

/* Bound once in boot() -- #optimizeToast is static markup outside #view,
 * never replaced by go(), so this only needs wiring up a single time. */
function bindOptimizeToast() {
  $('#optimizeToastClose').addEventListener('click', hideOptimizeToast);
}

function showOptimizeToast() {
  const toast = $('#optimizeToast');
  toast.classList.toggle('is-error', OPTIMIZE.status === 'error');
  $('#optimizeToastIcon').textContent = OPTIMIZE.status === 'error' ? '!' : '✓';
  $('#optimizeToastTitle').textContent =
    OPTIMIZE.status === 'error' ? 'Optimization failed' : 'Optimization complete';
  $('#optimizeToastSubtitle').textContent = OPTIMIZE.status === 'error'
    ? OPTIMIZE.error
    : `DPS ${num(OPTIMIZE.payload.dps)} · cost ${OPTIMIZE.payload.cost}`;
  $('#optimizeToastView').onclick = () => go('costscaling');
  toast.hidden = false;
}

function hideOptimizeToast() {
  $('#optimizeToast').hidden = true;
}

function renderCostScalingResult(payload) {
  const panel = $('#costScalingResultPanel');
  const host = $('#costScalingResult');
  host.innerHTML = '';
  panel.hidden = false;

  const row = el('div', 'stat-row');
  const dpsCell = el('div', 'stat-cell');
  dpsCell.appendChild(el('span', null, 'DPS'));
  dpsCell.appendChild(el('strong', null, num(payload.dps)));
  row.appendChild(dpsCell);
  const costCell = el('div', 'stat-cell');
  costCell.appendChild(el('span', null, 'Team cost'));
  costCell.appendChild(el('strong', null, String(payload.cost)));
  row.appendChild(costCell);
  host.appendChild(row);

  const teamGrid = el('div', 'team-grid');
  const slotNames = [CONST.locked, ...payload.state.team];
  slotNames.forEach((name, index) => {
    const isLocked = index === 0;
    const slot = el('div', `slot${isLocked ? ' slot--locked' : ''}`);
    slot.appendChild(el('span', 'slot-label', `Slot ${index + 1}`));
    const nameRow = el('div', 'slot-locked-name');
    nameRow.appendChild(document.createTextNode(name || '— empty —'));
    if (name) nameRow.appendChild(conPip(payload.state.characters[name].con_level || 0));
    slot.appendChild(nameRow);
    if (name) {
      const build = payload.state.characters[name];
      slot.appendChild(el('span', 'hint', `R${build.weapon_refinement} ${build.weapon}`));
      slot.appendChild(el('span', 'hint', build.artifact_set));
    }
    teamGrid.appendChild(slot);
  });
  host.appendChild(teamGrid);

  const apply = el('button', 'menu-button', '');
  apply.style.marginTop = '14px';
  apply.appendChild(el('strong', null, 'Apply this team'));
  apply.appendChild(el('span', null, 'Load this build into Edit Characters, replacing your current team'));
  apply.addEventListener('click', () => {
    STATE = payload.state;
    // The optimizer only ever writes the active artifact_set/artifacts, so
    // any OTHER saved loadout tabs left over from before this team was
    // applied would now be stale builds for whatever the optimizer just
    // picked -- collapse each character back down to a single loadout
    // matching what's actually live, rather than risk switching a tab into
    // silently overwriting the optimizer's own build with old data.
    Object.values(STATE.characters).forEach((build) => {
      build.artifact_loadouts = [{
        artifact_set: build.artifact_set,
        artifacts: JSON.parse(JSON.stringify(build.artifacts)),
        substat_preset: build.substat_preset,
      }];
      build.active_loadout_index = 0;
    });
    recalc();
    go('characters');
  });
  host.appendChild(apply);
}

/* ------------------------------------------------------------------- boot */

/* Clicking a chip opens that character (see bindChipNav, which stops the
 * click here); clicking anywhere else on the banner returns home. Bound once
 * -- #banner itself is static markup, never replaced by go(). */
function bindBannerNav() {
  $('#banner').addEventListener('click', () => {
    if (VIEW !== 'home') go('home');
  });
}

async function boot() {
  const payload = await post('/api/bootstrap');
  STATE = payload.state;
  CONST = payload.constants;
  bindBannerNav();
  bindOptimizeToast();
  go('home');
  recalc();
}

boot();
