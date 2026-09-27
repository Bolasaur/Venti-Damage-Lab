/* Translate the UI's JSON state into engine objects, and back again.
 *
 * Nothing in this module computes damage. Every damage number the UI shows
 * comes out of the engine itself, so the two can never drift apart. The only
 * formulae written out here are the *display-only* stat panel and the debug
 * mirror -- both are built from the same primitives as the real calculator.
 *
 * The JSON state uses the calculator's own native units: percentages are
 * fractions (.466, not 46.6). The browser scales them for display. */
import * as VC from './index.js';
import {
  KeyError, PyError, PyTypeError, ValueError, deepCopy, div, get, pyFloat, pyInt, pyMin, pyMod, pyRepr, pyRound, pyRoundInt, pySumMap,
  pyTruthy,
} from './py.js';

export const LOCKED = VC.LOCKED_TEAM_MEMBER; // "Venti" -- always slot 1
export const TEAM_SLOT_COUNT = 3; // the three editable dropdowns (slots 2-4)
export const PIECES = ['flower', 'feather', 'sands', 'goblet', 'circlet'];

export const ALL_STATS = VC.ARTIFACT_STAT_FIELDS;

/* Python's strict ``obj[key]``: a missing key raises KeyError. */
export function at(obj, key) {
  if (obj === null || obj === undefined) throw new PyTypeError("'NoneType' object is not subscriptable");
  if (Array.isArray(obj)) {
    if (typeof key === 'number' && key >= -obj.length && key < obj.length) return obj[key < 0 ? obj.length + key : key];
    throw new PyError('list index out of range');
  }
  if (typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) throw new KeyError(pyRepr(key));
  return obj[key];
}

/* Which substats the UI offers per piece. This is the ATK-scaling table --
 * every character except Albedo uses it. */
const PIECE_SUBSTAT_FIELDS = {
  flower: ['attack_percent', 'flat_attack', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  feather: ['attack_percent', 'flat_attack', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  goblet: ['attack_percent', 'flat_attack', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  sands: ['attack_percent', 'flat_attack', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  circlet: ['attack_percent', 'flat_attack', 'elemental_mastery'],
};
/* Albedo is the only DEF-scaling character: ATK%/Flat ATK are swapped for
 * DEF%/Flat DEF. */
const ALBEDO_PIECE_SUBSTAT_FIELDS = {
  flower: ['defense_percent', 'flat_defense', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  feather: ['defense_percent', 'flat_defense', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  goblet: ['defense_percent', 'flat_defense', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  sands: ['defense_percent', 'flat_defense', 'crit_rate', 'crit_damage', 'elemental_mastery'],
  circlet: ['defense_percent', 'flat_defense', 'elemental_mastery'],
};

export function pieceSubstatFieldsFor(characterName) {
  let fields = characterName === 'Albedo' ? ALBEDO_PIECE_SUBSTAT_FIELDS : PIECE_SUBSTAT_FIELDS;
  // EM only ever does anything through a swirl formula, and only Anemo kits
  // have one -- for everyone else it's a dead stat, so it isn't offered.
  if (characterName !== null && VC.CHARACTER_ROSTER[characterName].DEFAULTS.element !== 'Anemo') {
    fields = Object.fromEntries(Object.entries(fields).map(([piece, stats]) => [piece, stats.filter((stat) => stat !== 'elemental_mastery')]));
  }
  return fields;
}

/* Main stats the UI lets you pick per piece. Values stay freely editable. */
const PIECE_MAIN_STAT_OPTIONS = {
  flower: ['hp'],
  feather: ['flat_attack'],
  sands: ['attack_percent', 'defense_percent', 'elemental_mastery', 'energy_recharge', 'hp'],
  goblet: ['attack_percent', 'anemo_damage_bonus', 'pyro_damage_bonus',
    'electro_damage_bonus', 'hydro_damage_bonus', 'geo_damage_bonus', 'elemental_mastery', 'hp'],
  circlet: ['crit_rate', 'crit_damage', 'attack_percent', 'elemental_mastery', 'hp'],
};

/* Stats stored as fractions and shown as percentages in the browser. */
const PERCENT_STATS = [
  'attack_percent', 'defense_percent', 'crit_rate', 'crit_damage',
  'anemo_damage_bonus', 'pyro_damage_bonus', 'electro_damage_bonus', 'hydro_damage_bonus', 'geo_damage_bonus',
];

const STAT_LABELS = {
  hp: 'Flat HP', hp_percent: 'HP%', flat_attack: 'Flat ATK', attack_percent: 'ATK%',
  flat_defense: 'Flat DEF', defense_percent: 'DEF%',
  crit_rate: 'Crit Rate', crit_damage: 'Crit DMG',
  anemo_damage_bonus: 'Anemo DMG', pyro_damage_bonus: 'Pyro DMG',
  electro_damage_bonus: 'Electro DMG', hydro_damage_bonus: 'Hydro DMG', geo_damage_bonus: 'Geo DMG',
  elemental_mastery: 'EM', energy_recharge: 'Energy Recharge',
};

/* Element -> the artifact bonus field that actually buffs that element. */
const ELEMENT_BONUS_FIELD = {
  Anemo: 'anemo_damage_bonus',
  Pyro: 'pyro_damage_bonus',
  Electro: 'electro_damage_bonus',
  Hydro: 'hydro_damage_bonus',
  Geo: 'geo_damage_bonus',
};

const CIRCLET_CRIT_MAIN_STATS = {
  crit_rate: VC.CIRCLET_CRIT_RATE_MAIN_STAT,
  crit_damage: VC.CIRCLET_CRIT_DAMAGE_MAIN_STAT,
};

/* Max-level 5-star main stat values, applied when a piece's main stat is
 * switched in the editor. Stored in the same units as the artifacts
 * (fractions for PERCENT_STATS, raw numbers otherwise). */
const MAIN_STAT_PRESETS = {
  ...CIRCLET_CRIT_MAIN_STATS,
  attack_percent: 0.466,
  defense_percent: 0.583,
  anemo_damage_bonus: 0.466,
  pyro_damage_bonus: 0.466,
  electro_damage_bonus: 0.466,
  hydro_damage_bonus: 0.466,
  geo_damage_bonus: 0.466,
  elemental_mastery: 187,
  energy_recharge: 51.8,
};

/* Every dataclass field that can hold a piece of a character's field time --
 * either the plain ``field_time`` most characters have, or a
 * ``field_time_base`` plus whichever conditional modifiers apply. */
const FIELD_TIME_FIELDS = [
  'field_time', 'field_time_base',
  'field_time_burst_bonus',
  'field_time_patrol_song_bonus', 'field_time_c6_bonus',
];

/* Which characters' field time is a base plus conditional modifiers, and what
 * the UI should call/gate each modifier on. */
const FIELD_TIME_MODIFIERS = {
  Nicole: [
    { field: 'field_time_burst_bonus', label: 'Burst', condition: 'burst_enabled' },
  ],
  Albedo: [
    { field: 'field_time_patrol_song_bonus', label: 'Patrol Song', condition: 'weapon_patrol_song' },
    { field: 'field_time_c6_bonus', label: 'C6', condition: 'c6_enabled' },
  ],
};

const fieldNames = (characterClass) => new Set(characterClass.FIELDS);
const className = (character) => character.constructor.NAME;

/* Which of C1-C6 this class actually models. A class can additionally declare
 * ``NO_EFFECT_CONSTELLATIONS`` (Albedo's C4/C5) for a field that exists --
 * and is tracked for Team Cost -- but carries no damage effect. */
export function modelledConstellations(characterClass) {
  const names = fieldNames(characterClass);
  const noEffect = characterClass.NO_EFFECT_CONSTELLATIONS ?? new Set();
  return [1, 2, 3, 4, 5, 6].filter((n) => names.has(`c${n}_enabled`) && !noEffect.has(n));
}

/* The highest constellation a freshly-built character has on by default. */
function defaultConstellationLevel(character) {
  const enabled = [1, 2, 3, 4, 5, 6].filter((n) => character[`c${n}_enabled`] ?? false);
  return enabled.length ? Math.max(...enabled) : 0;
}

/* Set every modelled constellation from one integer level -- the cascade the
 * UI promises. Constellations a character doesn't model are skipped. */
function applyConstellationLevel(character, level) {
  const names = fieldNames(character.constructor);
  for (let n = 1; n <= 6; n++) {
    const name = `c${n}_enabled`;
    if (names.has(name)) character[name] = level >= n;
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function statsToDict(stats) {
  const out = {};
  for (const name of ALL_STATS) out[name] = stats[name];
  return out;
}

function artifactToState(artifact) {
  return {
    main_stat: { stat: artifact.main_stat.stat, value: artifact.main_stat.value },
    substats: statsToDict(artifact.substats),
  };
}

function loadoutToState(loadout) {
  return Object.fromEntries(PIECES.map((piece) => [piece, artifactToState(loadout[piece])]));
}

function stateToLoadout(state) {
  const pieces = {};
  for (const piece of PIECES) {
    const entry = at(state, piece);
    const main = at(entry, 'main_stat');
    const stat = at(main, 'stat');
    if (!VC.isArtifactStat(stat)) throw new ValueError(`Unknown ${piece} main stat ${pyRepr(stat)}`);
    const substats = {};
    for (const [name, value] of Object.entries(at(entry, 'substats'))) {
      if (!VC.isArtifactStat(name)) throw new ValueError(`Unknown ${piece} substat ${pyRepr(name)}`);
      substats[name] = pyFloat(pyTruthy(value) ? value : 0);
    }
    const mainValue = at(main, 'value');
    pieces[piece] = new VC.Artifact(
      piece.charAt(0).toUpperCase() + piece.slice(1),
      new VC.MainStat(stat, pyFloat(pyTruthy(mainValue) ? mainValue : 0)),
      new VC.ArtifactStats(substats),
    );
  }
  return new VC.ArtifactLoadout(pieces);
}

const presetCache = new Map();

/* All five pieces' substats for one "Apply preset" pass -- a thin wrapper
 * around ``VC.generatePresetSubstats`` that resolves the two pieces of
 * context only the live UI knows: the wielded weapon's own
 * (refinement-scaled) crit stats, and Mona's C4 bonus (credited at its full
 * +15%) when she's actually on the team with C4 enabled. Memoized -- it's a
 * pure function of its arguments. */
export function presetLoadoutSubstats(characterName, preset, weapon, artifactSet, mainStats,
  { weaponRefinement = 1, monaC4Active = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(VC.CHARACTER_ROSTER, characterName)) {
    throw new ValueError(`Unknown character ${pyRepr(characterName)}`);
  }
  const cls = VC.CHARACTER_ROSTER[characterName];
  if (!Object.prototype.hasOwnProperty.call(cls.WEAPONS, weapon)) throw new ValueError(`${characterName} cannot equip ${pyRepr(weapon)}`);
  if (!VC.hasArtifactSet(artifactSet)) throw new ValueError(`Unknown artifact set ${pyRepr(artifactSet)}`);
  if (!VC.WEAPON_REFINEMENTS.includes(weaponRefinement)) throw new ValueError(`Unknown weapon refinement ${pyRepr(weaponRefinement)}`);
  if (!VC.PRESET_TIERS.includes(preset)) throw new ValueError(`Unknown substat preset ${pyRepr(preset)}`);
  const mainStatsItems = Object.entries(mainStats).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = JSON.stringify([characterName, preset, weapon, artifactSet, mainStatsItems, weaponRefinement, pyTruthy(monaC4Active)]);
  let cached = presetCache.get(key);
  if (cached === undefined) {
    cached = cachedPresetLoadoutSubstats(characterName, preset, weapon, artifactSet, Object.fromEntries(mainStatsItems),
      weaponRefinement, pyTruthy(monaC4Active));
    presetCache.set(key, cached);
  }
  return deepCopy(cached);
}

function cachedPresetLoadoutSubstats(characterName, preset, weapon, artifactSet, mainStats, weaponRefinement, monaC4Active) {
  const cls = VC.CHARACTER_ROSTER[characterName];
  // Resolved at this weapon's actual refinement -- crit stats are
  // refinement-scaled tables for some weapons.
  const weaponStats = VC.weaponStatsAtRefinement(cls.WEAPONS[weapon], weaponRefinement);
  const teamCritRateBonus = monaC4Active ? VC.Mona.DEFAULTS.c4_team_crit_rate : 0;
  // Wolf Fang's front_burst_crit_rate only actually applies to Durin's
  // front-burst hits, but is folded in here at full value anyway.
  const substats = VC.generatePresetSubstats(characterName, preset, mainStats, {
    weaponCritRate: (weaponStats.crit_rate ?? 0) + (weaponStats.front_burst_crit_rate ?? 0),
    weaponCritDamage: weaponStats.crit_damage ?? 0,
    artifactSet,
    // Rising Winds' 20% crit rate doesn't trigger for Bennett/Faruzan.
    artifactSetCritRateEligible: characterName !== 'Bennett' && characterName !== 'Faruzan',
    teamCritRateBonus,
    ascensionCritDamage: cls.DEFAULTS.ascension_crit_damage ?? 0,
  });
  return Object.fromEntries(Object.entries(substats).map(([piece, stats]) => [piece, statsToDict(stats)]));
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

/* Whether any of this weapon's stats -- for this particular wielder --
 * actually varies by refinement. */
function weaponIsRefinable(stats) {
  return Object.values(stats).some((value) => value instanceof VC.RefinementTable);
}

const sampleCache = new Map();

/* A freshly-built, default instance of a class (never mutated). */
function sample(name) {
  if (!sampleCache.has(name)) sampleCache.set(name, new VC.CHARACTER_ROSTER[name]());
  return sampleCache.get(name);
}

/* Static per-character facts the browser needs to render its controls. */
function characterMetadata() {
  const meta = {};
  for (const [name, cls] of Object.entries(VC.CHARACTER_ROSTER)) {
    const character = sample(name);
    const names = fieldNames(cls);
    meta[name] = {
      element: character.element,
      weapons: Object.keys(cls.WEAPONS),
      weapon_default_refinement: { ...cls.WEAPON_DEFAULT_REFINEMENT },
      // TTDS's own refinement effect lives entirely outside its WEAPONS entry,
      // so it's forced true here rather than inferred.
      weapon_refinable: Object.fromEntries(Object.entries(cls.WEAPONS).map(([w, stats]) => [w, weaponIsRefinable(stats) || w === 'TTDS'])),
      modelled_constellations: modelledConstellations(cls),
      has_burst_toggle: names.has('burst_enabled'),
      field_time_base_field: names.has('field_time_base') ? 'field_time_base' : 'field_time',
      field_time_modifiers: deepCopy(FIELD_TIME_MODIFIERS[name] ?? []),
      base_attack: character.base_attack,
      base_defense: character.base_defense ?? null,
      locked: name === LOCKED,
      default_slot: character.slot ?? 1,
      piece_substat_fields: Object.fromEntries(Object.entries(pieceSubstatFieldsFor(name)).map(([p, v]) => [p, [...v]])),
    };
  }
  return meta;
}

function characterDefaultState(name) {
  const cls = VC.CHARACTER_ROSTER[name];
  const character = sample(name);
  const names = fieldNames(cls);
  const state = {
    weapon: character.weapon,
    weapon_refinement: character.weapon_refinement,
    artifact_set: character.artifact_set,
    con_level: defaultConstellationLevel(character),
    substat_preset: character.substat_preset,
    artifacts: loadoutToState(character.artifacts),
    character_level: character.character_level,
    // Up to 3 saved (artifact_set, artifacts, substat_preset) bundles the UI
    // can flip between -- purely the browser's own bookkeeping, never read by
    // the calculator, seeded with one entry mirroring the active fields.
    artifact_loadouts: [{
      artifact_set: character.artifact_set,
      artifacts: loadoutToState(character.artifacts),
      substat_preset: character.substat_preset,
    }],
    active_loadout_index: 0,
  };
  for (const fieldName of FIELD_TIME_FIELDS) {
    if (names.has(fieldName)) state[fieldName] = character[fieldName];
  }
  if (names.has('burst_enabled')) state.burst_enabled = character.burst_enabled;
  return state;
}

export { characterDefaultState };

/* The UI's starting point, which reproduces ``buildDefaultTeam()``. (The
 * browser layer restores the last saved state instead, when there is one.) */
export function defaultState() {
  // Ordered by each character's own default slot, so the starting dropdowns
  // place everyone where the calculator's defaults put them.
  const selected = VC.SELECTED_TEAM.filter((n) => n !== LOCKED)
    .map((name, index) => [name, sample(name).slot ?? 1, index])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([name]) => name);
  const team = [...selected, ...Array(TEAM_SLOT_COUNT).fill(null)].slice(0, TEAM_SLOT_COUNT);
  const settings = new VC.TeamSettings();
  const enemy = new VC.Enemy();
  const rotation = new VC.VentiRotation();
  return {
    team,
    characters: Object.fromEntries(Object.keys(VC.CHARACTER_ROSTER).map((name) => [name, characterDefaultState(name)])),
    enemy: {
      level: enemy.level,
      base_resistance: enemy.base_resistance,
      physical_resistance: enemy.physical_resistance,
    },
    settings: {
      pyro_resonance_attack_percent: settings.pyro_resonance_attack_percent,
      // No control for this in the main UI; only the "Cost Scamming"
      // optimizer overrides it.
      bennett_absorption_eligible: true,
    },
    rotation: {
      notation: rotation.notation,
      burst_first_hits_per_cast: rotation.burst_first_hits_per_cast,
      burst_second_hits_per_cast: rotation.burst_second_hits_per_cast,
      swirls_per_burst: rotation.swirls_per_burst,
    },
  };
}

/* Everything static the browser needs, pulled from the calculator so the two
 * stay in step when the roster or the set list grows. */
export function uiConstants() {
  return {
    roster: Object.keys(VC.CHARACTER_ROSTER),
    locked: LOCKED,
    team_slot_count: TEAM_SLOT_COUNT,
    pieces: [...PIECES],
    piece_main_stat_options: deepCopy(PIECE_MAIN_STAT_OPTIONS),
    percent_stats: [...PERCENT_STATS],
    stat_labels: { ...STAT_LABELS },
    artifact_sets: Object.keys(VC.ARTIFACT_SETS),
    presets: [...VC.PRESET_TIERS],
    circlet_crit_main_stats: { ...CIRCLET_CRIT_MAIN_STATS },
    main_stat_presets: { ...MAIN_STAT_PRESETS },
    characters: characterMetadata(),
    character_levels: [...VC.CHARACTER_LEVELS],
  };
}

// ---------------------------------------------------------------------------
// State -> Team
// ---------------------------------------------------------------------------

/* Venti is locked into slot 1; the three dropdowns fill slots 2-4. */
function teamMembers(state) {
  const chosen = at(state, 'team').slice(0, TEAM_SLOT_COUNT).filter((name) => pyTruthy(name));
  if (new Set(chosen).size !== chosen.length) throw new ValueError('The same character cannot occupy two team slots');
  const unknown = chosen.filter((name) => !Object.prototype.hasOwnProperty.call(VC.CHARACTER_ROSTER, name));
  if (unknown.length) throw new ValueError(`Unknown character(s): ${unknown.join(', ')}`);
  return [LOCKED, ...chosen];
}

/* Create one character from its UI state. Characters left off the team are
 * still built -- with ``team_buffs_enabled = false`` -- so the present
 * characters' formulae have something to call. */
function buildCharacter(name, state, present, slot) {
  const cls = VC.CHARACTER_ROSTER[name];
  const names = fieldNames(cls);
  const kwargs = { artifacts: stateToLoadout(at(state, 'artifacts')) };

  const characterLevel = pyInt(get(state, 'character_level', 90));
  if (!VC.CHARACTER_LEVELS.includes(characterLevel)) throw new ValueError(`${name}: unknown character level ${pyRepr(characterLevel)}`);
  kwargs.character_level = characterLevel;

  const weapon = at(state, 'weapon');
  if (typeof weapon !== 'string' || !Object.prototype.hasOwnProperty.call(cls.WEAPONS, weapon)) {
    throw new ValueError(`${name} cannot equip ${pyRepr(weapon)}`);
  }
  kwargs.weapon = weapon;

  const weaponRefinement = pyInt(get(state, 'weapon_refinement', 1));
  if (!VC.WEAPON_REFINEMENTS.includes(weaponRefinement)) throw new ValueError(`${name}: unknown weapon refinement ${pyRepr(weaponRefinement)}`);
  kwargs.weapon_refinement = weaponRefinement;

  const artifactSet = at(state, 'artifact_set');
  if (!VC.hasArtifactSet(artifactSet)) throw new ValueError(`Unknown artifact set ${pyRepr(artifactSet)}`);
  kwargs.artifact_set = artifactSet;

  if (names.has('substat_preset')) kwargs.substat_preset = at(state, 'substat_preset');
  if (names.has('team_buffs_enabled')) kwargs.team_buffs_enabled = present;
  if (names.has('burst_enabled')) kwargs.burst_enabled = pyTruthy(get(state, 'burst_enabled', true));
  // Nicole/Albedo's ``field_time`` is a derived, read-only property, so it's
  // absent from their fields and correctly skipped here.
  for (const fieldName of FIELD_TIME_FIELDS) {
    const value = get(state, fieldName, null);
    if (names.has(fieldName) && value !== null) kwargs[fieldName] = pyFloat(value);
  }
  // Venti has no ``slot`` field at all -- ``slotOf`` pins him to slot 1.
  if (names.has('slot') && slot !== null) kwargs.slot = slot;

  const character = new cls(kwargs);
  applyConstellationLevel(character, pyInt(get(state, 'con_level', 0)));
  return character;
}

export function buildTeam(state) {
  const members = teamMembers(state);
  // Slot is decided by which dropdown a character sits in, not by class default.
  const slotByName = new Map(members.slice(1).map((name, index) => [name, index + 2]));
  const characterStates = at(state, 'characters');
  const characters = {};
  for (const name of Object.keys(VC.CHARACTER_ROSTER)) {
    characters[name] = buildCharacter(name, at(characterStates, name), members.includes(name), slotByName.get(name) ?? null);
  }
  const settingsState = at(state, 'settings');
  const settings = new VC.TeamSettings({
    pyro_resonance_attack_percent: pyFloat(at(settingsState, 'pyro_resonance_attack_percent')),
  });
  const enemyState = at(state, 'enemy');
  const enemy = new VC.Enemy({
    level: pyInt(at(enemyState, 'level')),
    base_resistance: pyFloat(at(enemyState, 'base_resistance')),
    physical_resistance: pyFloat(at(enemyState, 'physical_resistance')),
  });
  const rotationState = at(state, 'rotation');
  const notation = at(rotationState, 'notation');
  if (typeof notation !== 'string') throw new Error("rotation notation isn't a string");
  const rotation = new VC.VentiRotation({
    notation,
    burst_first_hits_per_cast: pyInt(at(rotationState, 'burst_first_hits_per_cast')),
    burst_second_hits_per_cast: pyInt(at(rotationState, 'burst_second_hits_per_cast')),
    swirls_per_burst: pyInt(at(rotationState, 'swirls_per_burst')),
  });
  return new VC.Team(
    settings, enemy, members,
    characters.Nicole, characters.Durin, characters.Prune,
    characters.Venti, characters.Bennett, characters.Faruzan,
    characters.Fischl, characters.Mona, characters.Albedo, rotation,
    { bennettAbsorptionEligible: pyTruthy(get(settingsState, 'bennett_absorption_eligible', true)) },
  );
}

// ---------------------------------------------------------------------------
// Display-only stat panel
// ---------------------------------------------------------------------------

/* The character's own totals, with **no team buffs of any kind**. Display
 * only -- never fed back into a damage number. */
function characterStatPanel(character, resonanceAttackPercent) {
  const weapon = character.weaponStats();
  const artifacts = character.artifacts.total;
  const artifactSet = VC.ARTIFACT_SETS[character.artifact_set];

  const attackPercent = (artifacts.attack_percent
    + (weapon.attack_percent ?? 0)
    + (character.ascension_attack_percent ?? 0)
    + artifactSet.two_piece_attack_percent
    + artifactSet.four_piece_triggered_attack_percent
    + resonanceAttackPercent);
  const totalAttack = VC.attack(character.base_attack, weapon.base_attack, attackPercent, artifacts.flat_attack);
  const critRate = (0.05 + (weapon.crit_rate ?? 0) + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate);
  const critDamage = (0.5 + (weapon.crit_damage ?? 0) + artifacts.crit_damage + (character.ascension_crit_damage ?? 0));
  const elementField = ELEMENT_BONUS_FIELD[character.element];
  let damageBonus = weapon.damage_bonus ?? 0;
  if (elementField) damageBonus += artifacts[elementField];
  // VV's 2pc (Anemo) and Husk's 4pc (Geo) are personal DMG bonuses; Golden
  // Troupe's Skill DMG bonus is shown as the same kind of simplified aggregate.
  if (character.element === 'Anemo') damageBonus += artifactSet.two_piece_anemo_damage_bonus;
  if (character.element === 'Geo') damageBonus += artifactSet.four_piece_geo_damage_bonus;
  damageBonus += artifactSet.four_piece_skill_damage_bonus;
  const elementalMastery = artifacts.elemental_mastery + (weapon.elemental_mastery ?? 0);
  const result = {
    attack: totalAttack,
    attack_percent: attackPercent,
    crit_rate: critRate,
    crit_damage: critDamage,
    damage_bonus: damageBonus,
    elemental_mastery: elementalMastery,
    expected_crit_multiplier: VC.expectedCritMultiplier(critRate, critDamage),
    element: character.element,
    weapon_base_attack: weapon.base_attack,
    flat_attack: artifacts.flat_attack,
    base_attack: character.base_attack,
  };
  // Albedo exposes his own exact DEF formula directly.
  if (typeof character.finalDefense === 'function') {
    result.defense_percent = character.defensePercent();
    result.defense = character.finalDefense();
    result.flat_defense = artifacts.flat_defense;
    result.base_defense = character.base_defense;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Debug payload
// ---------------------------------------------------------------------------

const sumDamage = (hits) => pySumMap(hits, (h) => h.damage);

/* Every buff reaching ``recipient``'s damage that isn't part of their own
 * build -- one independent row per source and per buff, mirroring the real
 * formulae (display-only). ``uptime`` is the REAL, damage-weighted fraction of
 * ``recipient``'s own timestamped hits where that buff is active at that
 * hit's own instant. This is a TIMING check only -- it doesn't know which
 * element any specific hit is. */
function teamBuffsFor(recipient, hits, team, resolvedSettings, buffs, timeline, present, absorptionActive,
  ttdsWielder, ttdsFullDelta, resonanceActive, absorbedElement = null) {
  const { nicole, durin, prune, bennett, faruzan, fischl, mona, albedo } = team;
  const rows = [];

  const realUptimeOf = (source, duration, hitSet = hits, castAtSwapOut = true) => realUptime(timeline, source, duration, hitSet, castAtSwapOut);

  // Nicole's on_field_flat_attack and Bennett's team ATK buff are BOTH
  // on-field-only -- reaching this character's genuinely on-field hits but NOT
  // their off-field ticks.
  const ON_FIELD_ABILITIES = { Durin: new Set(['skill', 'burst 1', 'burst 2', 'burst 3']), Prune: new Set(['skill', 'burst 1']) };
  const OFF_FIELD_TICK_ABILITIES = { Durin: new Set(['burst front', 'burst back']), Prune: new Set(['burst 2', 'burst 3']) };
  const onFieldSet = ON_FIELD_ABILITIES[recipient];
  const onFieldHits = onFieldSet !== undefined ? hits.filter((h) => onFieldSet.has(h.ability)) : hits;
  const offFieldSet = OFF_FIELD_TICK_ABILITIES[recipient] ?? new Set();
  const offFieldHits = hits.filter((h) => offFieldSet.has(h.ability));

  const add = (source, buff, value, kind, duration, note = null, hitSet = hits, castAtSwapOut = true) => {
    // A source never buffs itself here.
    if (!pyTruthy(value) || source === recipient) return;
    const [fraction, activeCount, totalCount] = realUptimeOf(source, duration, hitSet, castAtSwapOut);
    const row = {
      source, buff, value, kind,
      uptime: fraction, hit_coverage: totalCount ? `${activeCount} of ${totalCount} real hits` : 'no real hits yet',
    };
    if (note) row.note = note;
    rows.push(row);
  };

  const elementNote = hits.length ? 'timing only, not element-aware -- see this panel\'s own note above' : null;

  // -- Team composition / resonance
  add('Team', 'Pyro Resonance ATK%', resonanceActive ? resolvedSettings.pyro_resonance_attack_percent : 0, 'percent', null);

  // -- Nicole (20s window) -- her own kit buffs are still (re)cast at the
  // START of her own arc, hence ``castAtSwapOut = false`` on every row.
  const [nicoleFraction] = realUptimeOf('Nicole', VC.Nicole.BUFF_DURATION, hits, false);
  add('Nicole', 'Team flat ATK', nicole.teamFlatAttack(resolvedSettings, buffs, nicoleFraction), 'flat', VC.Nicole.BUFF_DURATION,
    null, hits, false);
  const [nicoleOnfieldFraction] = realUptimeOf('Nicole', VC.Nicole.BUFF_DURATION, onFieldHits, false);
  add('Nicole', 'On-field flat ATK', nicole.skillOnFieldAttack(nicoleOnfieldFraction), 'flat', VC.Nicole.BUFF_DURATION,
    offFieldHits.length ? 'only her genuinely on-field hits -- never his/her own off-field ticks, which only get this via the row below at C6' : null,
    onFieldHits, false);
  if (offFieldHits.length) {
    const [nicoleOfffieldFraction] = realUptimeOf('Nicole', VC.Nicole.BUFF_DURATION, offFieldHits, false);
    add('Nicole', 'Team-wide flat ATK (C6 only)', nicole.teamWideFlatAttack(nicoleOfffieldFraction), 'flat', VC.Nicole.BUFF_DURATION,
      'only reaches off-field ticks once Nicole\'s C6 widens it -- zero without it', offFieldHits, false);
  }
  const angelosTier = recipient === 'Venti' ? 1.0 : ((recipient === 'Bennett' || recipient === 'Faruzan') ? 0.0 : 0.5);
  add('Nicole', 'Weapon (Angelos) team DMG bonus',
    (nicole.team_buffs_enabled ? nicole.weaponStats().team_damage_bonus : 0) * nicoleFraction * angelosTier,
    'percent', VC.Nicole.BUFF_DURATION, 'full value to Venti, half to most others, none to Faruzan/Bennett', hits, false);

  // -- Durin's C2 (full uptime, no real window)
  add('Durin', 'C2 Pyro/Anemo DMG bonus', durin.pyroAnemoDamageBonus(), 'percent', null);

  // -- Prune -- her Hex-derived onfield buffs to VENTI are gated on his own
  // presence (anchored to his arc, with the shortened effective duration), so
  // these two rows are built by hand.
  if (recipient === 'Venti' && hits.length && prune.team_buffs_enabled) {
    const ventiTotalDamage = sumDamage(hits);
    if (ventiTotalDamage) {
      const pruneAtkBuffActiveAt = (instant) => absorptionActive && timeline.activeAt('Venti', prune.atkBuffDuration(timeline), instant, false);

      const activeCount = hits.filter((h) => pruneAtkBuffActiveAt(h.time)).length;
      const atkPctAvg = div(pySumMap(hits, (h) => h.damage * (pruneAtkBuffActiveAt(h.time) ? prune.hex_onfield_attack_percent : 0)), ventiTotalDamage);
      rows.push({
        source: 'Prune', buff: 'Hex on-field ATK%', value: atkPctAvg, kind: 'percent',
        uptime: prune.hex_onfield_attack_percent ? div(atkPctAvg, prune.hex_onfield_attack_percent) : 0.0,
        hit_coverage: `${activeCount} of ${hits.length} real hits`,
        note: 'only up while Venti is genuinely on field -- damage-weighted average across his real hits',
      });
      if (prune.c6_enabled) {
        const c6Avg = div(pySumMap(hits, (h) => h.damage * (pruneAtkBuffActiveAt(h.time) ? prune.c6_flat_attack : 0)), ventiTotalDamage);
        rows.push({
          source: 'Prune', buff: 'C6 flat ATK', value: c6Avg, kind: 'flat',
          uptime: prune.c6_flat_attack ? div(c6Avg, prune.c6_flat_attack) : 0.0,
          hit_coverage: `${activeCount} of ${hits.length} real hits`,
          note: 'only up while Venti is genuinely on field -- damage-weighted average across his real hits',
        });
      }
    }
  }
  if (recipient !== 'Prune') {
    // Genuinely dynamic -- reflects her own attack AT EACH of the recipient's
    // own real hits. The VALUE itself is the damage-weighted real average.
    const pruneBonusHits = hits.map((h) => [h.damage, prune.teamDamageBonusAt(resolvedSettings, nicole, buffs, absorptionActive, timeline, h.time)]);
    const pruneBonusTotalDamage = pySumMap(pruneBonusHits, ([d]) => d);
    const pruneBonusAvg = pruneBonusTotalDamage ? div(pySumMap(pruneBonusHits, ([d, v]) => d * v), pruneBonusTotalDamage) : 0.0;
    add('Prune', 'Team DMG bonus (damage-weighted average across their real hits)', pruneBonusAvg, 'percent', null);
  }

  // -- Prune's OWN Hex self-buffs -- the one exception to the "never buffs
  // itself" rule, since these are exactly the mechanics worth surfacing.
  if (recipient === 'Prune' && hits.length && timeline.field_time.has('Prune')) {
    const totalDamage = sumDamage(hits);
    if (totalDamage) {
      const pruneTickStart = timeline.arc_start.get('Prune') + timeline.field_time.get('Prune');

      const hexActiveAt = (instant) => absorptionActive && timeline.activeAt('Venti', prune.atkBuffDuration(timeline), instant, false);

      const hexCount = hits.filter((h) => hexActiveAt(h.time)).length;
      const hexAvg = div(pySumMap(hits, (h) => h.damage * (hexActiveAt(h.time) ? prune.hex_attack_percent : 0)), totalDamage);
      const elapsedValues = hits.map((h) => [h.damage, pyMod(h.time - pruneTickStart, timeline.period)]);
      const c2Avg = absorptionActive ? div(pySumMap(elapsedValues, ([d, e]) => d * prune.c2AttackPercentAt(e)), totalDamage) : 0.0;
      rows.push({
        source: 'Prune', buff: 'Hex self ATK% (60% base)', value: hexAvg, kind: 'percent',
        uptime: prune.hex_attack_percent ? div(hexAvg, prune.hex_attack_percent) : 0.0,
        hit_coverage: `${hexCount} of ${hits.length} real hits`,
        note: 'only up while Venti\'s own field-time window is active (see the Hex on-field rows in his own panel) -- damage-weighted average across her real hits, not the flat 60% max',
      });
      rows.push({
        source: 'Prune', buff: 'C2 self ATK ramp (20% -> 40%)', value: c2Avg, kind: 'percent',
        uptime: 1.0, hit_coverage: `${hits.length} of ${hits.length} real hits`,
        note: 'ramps 20% -> 30% -> 40% over the 4s after her Hex ticks begin -- damage-weighted average across her real hits, not the flat 40% max',
      });
      if (prune.team_buffs_enabled && prune.c6_enabled) {
        const c6Avg = div(pySumMap(hits, (h) => h.damage * (hexActiveAt(h.time) ? prune.c6_flat_attack : 0)), totalDamage);
        rows.push({
          source: 'Prune', buff: 'C6 self flat ATK (350)', value: c6Avg, kind: 'flat',
          uptime: prune.c6_flat_attack ? div(c6Avg, prune.c6_flat_attack) : 0.0,
          hit_coverage: `${hexCount} of ${hits.length} real hits`,
          note: 'only up while Venti\'s own field-time window is active, same as her Hex self ATK% above -- damage-weighted average across her real hits, not the flat 350 max',
        });
      }
    }
  }

  // -- Bennett (14s window) -- his team ATK buff is on-field-only; his Pyro
  // DMG bonus is a generic dmg% bonus, so it uses the full hit set.
  const [bennettOnfieldFraction] = realUptimeOf('Bennett', VC.Bennett.BUFF_DURATION, onFieldHits);
  add('Bennett', 'Team ATK buff', bennett.teamAttackBuff(bennettOnfieldFraction), 'flat', VC.Bennett.BUFF_DURATION,
    offFieldHits.length ? 'only genuinely on-field hits -- his off-field ticks never receive this, not even at C6' : null,
    onFieldHits);
  const [bennettFraction] = realUptimeOf('Bennett', VC.Bennett.BUFF_DURATION, hits);
  add('Bennett', 'C6 Pyro DMG bonus', bennett.pyroDamageBonus(bennettFraction), 'percent', VC.Bennett.BUFF_DURATION);

  // -- Faruzan (16s, 22s at C2)
  const [faruzanFraction] = realUptimeOf('Faruzan', faruzan.buff_duration);
  add('Faruzan', 'Anemo DMG bonus', faruzan.anemoDamageBonus(faruzanFraction), 'percent', faruzan.buff_duration);
  add('Faruzan', 'C6 crit DMG bonus (Anemo hits only)', faruzan.critDamageBonus(faruzanFraction), 'percent', faruzan.buff_duration, elementNote);

  // -- Fischl -- her Pyro-ally team ATK% (10s, full uptime whenever Durin is
  // present); her Hydro-ally EM stays teamwide/full uptime.
  const presentElements = new Set(present.filter((c) => c.team_buffs_enabled ?? true).map((c) => c.element));
  const fischlPyroDuration = buffs.fischl_pyro_full_uptime ? null : VC.FISCHL_PYRO_ATTACK_BUFF_DURATION;
  add('Fischl', 'Pyro-ally team ATK% (kit passive)', buffs.fischl_pyro_attack_percent, 'percent', fischlPyroDuration,
    buffs.fischl_pyro_full_uptime ? 'full uptime -- Durin is on the team' : null);
  add('Fischl', 'Hydro-ally team EM (kit passive)', fischl.teamElementalMasteryBonus(presentElements), 'flat', null);

  // -- Mona (11s window)
  const [monaFraction] = realUptimeOf('Mona', VC.Mona.BUFF_DURATION);
  add('Mona', 'Team DMG bonus', mona.teamDamageBonus(monaFraction), 'percent', VC.Mona.BUFF_DURATION);
  add('Mona', 'C1 swirl DMG bonus', mona.swirlDamageBonus(), 'percent', null);
  add('Mona', 'C4 team crit rate bonus', mona.teamCritRateBonus(monaFraction), 'percent', VC.Mona.BUFF_DURATION);
  add('Mona', 'C4 team crit DMG bonus', mona.teamCritDamageBonus(monaFraction), 'percent', VC.Mona.BUFF_DURATION);
  add('Mona', 'C2 team EM', mona.team_buffs_enabled && mona.c2_enabled ? mona.c2_team_elemental_mastery : 0, 'flat', null);

  // -- Albedo -- his own kit bonus and C6 are full-uptime; Patrol Song has a
  // real 15s window.
  const [patrolSongFraction] = realUptimeOf('Albedo', VC.Albedo.PATROL_SONG_BUFF_DURATION);
  add('Albedo', 'Team DMG bonus', albedo.teamDamageBonus(), 'percent', null);
  add('Albedo', 'Patrol Song team DMG bonus', albedo.patrolSongTeamDamageBonus() * patrolSongFraction, 'percent', VC.Albedo.PATROL_SONG_BUFF_DURATION);
  add('Albedo', 'C6 team DMG bonus', albedo.c6TeamDamageBonus(), 'percent', null);
  add('Albedo', 'C2 team EM', albedo.team_buffs_enabled && albedo.c2_enabled ? albedo.c2_team_elemental_mastery : 0, 'flat', null);

  // -- Weapon-granted team buffs (Elegy-style), attributed to the wielder.
  for (const character of present) {
    if (!(character.team_buffs_enabled ?? true)) continue;
    const weapon = character.weaponStats();
    let valueScale = weapon.team_buff_uptime ?? 1;
    const threshold = weapon.team_buff_full_uptime_rotation_length ?? null;
    if (threshold !== null && team.rotationLength() >= threshold) valueScale = 1;
    const wielder = className(character);
    const [elegyFraction] = realUptimeOf(wielder, VC.ELEGY_BUFF_DURATION);
    add(wielder, 'Weapon team ATK%', (weapon.team_attack_percent ?? 0) * valueScale * elegyFraction, 'percent', VC.ELEGY_BUFF_DURATION);
    add(wielder, 'Weapon team ATK% (teammates only)', weapon.team_attack_percent_others ?? 0, 'percent', null);
    add(wielder, 'Weapon team EM', (weapon.team_elemental_mastery ?? 0) * valueScale * elegyFraction, 'flat', VC.ELEGY_BUFF_DURATION);
  }

  // -- TTDS -- Venti-only in the real formulae.
  if (recipient === 'Venti' && ttdsWielder !== null && timeline.nextInPlayOrder(className(ttdsWielder)) === 'Venti') {
    const ttdsWielderName = className(ttdsWielder);
    const [ttdsFraction] = realUptimeOf(ttdsWielderName, VC.TTDS_BUFF_DURATION);
    add(ttdsWielderName, 'TTDS ATK delta', ttdsFullDelta * ttdsFraction, 'flat', VC.TTDS_BUFF_DURATION);
  }

  // -- Artifact-set team buffs, attributed to whichever eligible present
  // character actually wears the set.
  if (buffs.noblesse_wearer !== null) {
    const [noblesseFraction] = realUptimeOf(buffs.noblesse_wearer, VC.NOBLESSE_BUFF_DURATION);
    add(buffs.noblesse_wearer, 'Noblesse team ATK%', VC.ARTIFACT_SETS.Noblesse.four_piece_team_attack_percent * noblesseFraction,
      'percent', VC.NOBLESSE_BUFF_DURATION);
  }
  const tenacityWearer = present.find((c) => c.artifact_set === 'Tenacity' && VC.tenacityEligible(c)) ?? null;
  if (tenacityWearer !== null) {
    add(className(tenacityWearer), 'Tenacity team ATK%', buffs.tenacity_attack_percent, 'percent', null,
      buffs.tenacity_requires_activation ? 'off for the pre-activation hit only' : null);
  }
  if (buffs.scroll_wearer !== null) {
    const [scrollFraction] = realUptimeOf(buffs.scroll_wearer, VC.SCROLL_BUFF_DURATION);
    add(buffs.scroll_wearer, 'Scroll team DMG bonus', VC.ARTIFACT_SETS.Scroll.four_piece_team_damage_bonus * scrollFraction,
      'percent', VC.SCROLL_BUFF_DURATION);
  }
  if (buffs.celestial_gift_wearer !== null && hits.length) {
    // Celestial grants TWO separate 40%-capped components -- Anemo and the
    // wearer's own element -- each only applying to a hit tagged with that
    // same element. Averaged (damage-weighted) across the recipient's own
    // REAL hits via the exact point-in-time query the engine uses.
    const totalDamage = sumDamage(hits);
    const anemoAvg = totalDamage ? div(pySumMap(hits, (h) => h.damage * buffs.elementalDamageBonusAt('Anemo', h.time)), totalDamage) : 0.0;
    add(buffs.celestial_gift_wearer, 'Celestial Gift Anemo DMG bonus', anemoAvg, 'percent',
      VC.CELESTIAL_GIFT_BUFF_DURATION,
      `only Anemo-tagged hits${recipient === 'Venti' || recipient === 'Prune' ? ' -- never his absorbed-element burst 2/her burst 3' : ''}`);
    const wearer = present.find((c) => className(c) === buffs.celestial_gift_wearer) ?? null;
    const secondaryElement = wearer !== null ? wearer.element : null;
    if (secondaryElement !== null && secondaryElement !== 'Anemo') {
      const secondaryValue = totalDamage
        ? div(pySumMap(hits, (h) => h.damage * buffs.elementalDamageBonusAt(secondaryElement, h.time)), totalDamage) : 0.0;
      let note;
      if (recipient === 'Venti' || recipient === 'Prune') {
        const liveNote = absorbedElement === secondaryElement
          ? `currently active -- the absorbed element is ${absorbedElement} right now`
          : `currently INACTIVE -- needs the absorbed element to be ${secondaryElement}, and it's ${absorbedElement || 'nothing'} right now`;
        note = `only the absorbed-element hits (his burst 2/her burst 3), and only while that element is ${secondaryElement} -- ${liveNote}`;
      } else {
        note = `only his ${secondaryElement}-tagged hits`;
      }
      add(buffs.celestial_gift_wearer, `Celestial Gift ${secondaryElement} DMG bonus`, secondaryValue, 'percent',
        VC.CELESTIAL_GIFT_BUFF_DURATION, note);
    }
  }

  return rows;
}

/* Damage-weighted fraction of ``hits`` that actually has a buff active AT
 * THAT HIT'S OWN INSTANT, via the exact same primitive the engine uses.
 * ``duration = null`` means the buff never decays. Also returns
 * [activeCount, totalCount]. */
function realUptime(timeline, source, duration, hits, castAtSwapOut = true) {
  if (!hits.length) return [0.0, 0, 0];
  if (duration === null) return [1.0, hits.length, hits.length];
  const totalDamage = sumDamage(hits);
  const active = hits.filter((h) => timeline.recastActiveAt(source, duration, h.time, castAtSwapOut));
  const activeDamage = sumDamage(active);
  return [totalDamage ? div(activeDamage, totalDamage) : 0.0, active.length, hits.length];
}

/* The literal [start, end) interval(s), within one rotation period, where a
 * buff (re)cast every cycle is active. A window that wraps produces TWO
 * intervals. ``source`` absent from this team returns no interval at all. */
function onOffWindows(timeline, source, duration, period, castAtSwapOut = true) {
  if (source === null || !timeline.arc_start.has(source)) return [];
  if (duration === null || duration >= period) return [[0.0, pyRound(period, 3)]];
  let start = timeline.arc_start.get(source);
  if (castAtSwapOut) start = pyMod(start + timeline.field_time.get(source), period);
  const end = start + duration;
  if (end <= period) return [[pyRound(start, 3), pyRound(end, 3)]];
  return [[pyRound(start, 3), pyRound(period, 3)], [0.0, pyRound(end - period, 3)]];
}

/* Team-wide version of ``teamBuffsFor``'s per-recipient rows -- WHEN each
 * present buff source is live over one rotation. Prune's team DMG% bonus is
 * genuinely continuous, so it gets a densely-sampled curve instead. */
function buffTimeline(team, present, buffs, timeline, absorptionActive, resolvedSettings, resonanceActive,
  vvWearer, vvTargetElement, ttdsWielderObj, period) {
  const { nicole, durin, prune, bennett, faruzan, mona, albedo } = team;
  const presentNames = new Set(present.map(className));

  const enabled = (name) => presentNames.has(name) && (team.character(name).team_buffs_enabled ?? true);

  const windows = [];

  const addWindow = (source, label, value, kind, duration, castAtSwapOut = true) => {
    if (!pyTruthy(value) || source === null) return;
    // A buff whose own duration already covers the whole rotation draws as one
    // full-width bar with zero information in it -- skipped entirely.
    if (duration === null || duration >= period) return;
    const intervals = onOffWindows(timeline, source, duration, period, castAtSwapOut);
    if (!intervals.length) return;
    windows.push({ source, label, value, kind, duration: pyRound(duration, 3), windows: intervals });
  };

  if (resonanceActive) addWindow('Team', 'Pyro Resonance ATK%', resolvedSettings.pyro_resonance_attack_percent, 'percent', null);
  if (enabled('Nicole')) {
    addWindow('Nicole', 'Team flat ATK (base kit)', nicole.on_field_flat_attack, 'flat', VC.Nicole.BUFF_DURATION, false);
    const angelos = nicole.weaponStats().team_damage_bonus ?? 0;
    addWindow('Nicole', 'Weapon (Angelos) team DMG%', angelos, 'percent', VC.ANGELOS_BUFF_DURATION, false);
  }
  if (enabled('Bennett')) {
    addWindow('Bennett', 'Team flat ATK', bennett.teamAttackBuff(1.0), 'flat', VC.Bennett.BUFF_DURATION);
    addWindow('Bennett', 'C6 Pyro DMG bonus', bennett.pyroDamageBonus(1.0), 'percent', VC.Bennett.BUFF_DURATION);
  }
  if (pyTruthy(buffs.noblesse_wearer)) {
    addWindow(buffs.noblesse_wearer, 'Noblesse team ATK%', VC.ARTIFACT_SETS.Noblesse.four_piece_team_attack_percent, 'percent', VC.NOBLESSE_BUFF_DURATION);
  }
  if (pyTruthy(buffs.scroll_wearer)) {
    const scrollDuration = buffs.scroll_full_uptime ? null : VC.SCROLL_BUFF_DURATION;
    addWindow(buffs.scroll_wearer, 'Scroll team DMG%', VC.ARTIFACT_SETS.Scroll.four_piece_team_damage_bonus, 'percent', scrollDuration);
  }
  for (const [wielder, value] of buffs.windowed_attack_percent_sources) addWindow(wielder, 'Elegy team ATK%', value, 'percent', VC.ELEGY_BUFF_DURATION);
  for (const [wielder, value] of buffs.windowed_elemental_mastery_sources) addWindow(wielder, 'Elegy team EM', value, 'flat', VC.ELEGY_BUFF_DURATION);
  if (enabled('Faruzan')) {
    addWindow('Faruzan', 'Anemo DMG bonus', faruzan.anemoDamageBonus(1.0), 'percent', faruzan.buff_duration);
    addWindow('Faruzan', 'C6 crit DMG bonus (Anemo hits only)', faruzan.critDamageBonus(1.0), 'percent', faruzan.buff_duration);
  }
  if (enabled('Fischl') && buffs.fischl_pyro_attack_percent) {
    const fischlDuration = buffs.fischl_pyro_full_uptime ? null : VC.FISCHL_PYRO_ATTACK_BUFF_DURATION;
    addWindow('Fischl', 'Pyro-ally team ATK% (kit passive)', buffs.fischl_pyro_attack_percent, 'percent', fischlDuration);
  }
  if (enabled('Mona')) {
    addWindow('Mona', 'Team DMG bonus', mona.teamDamageBonus(1.0), 'percent', VC.Mona.BUFF_DURATION);
    addWindow('Mona', 'C4 team crit rate', mona.teamCritRateBonus(1.0), 'percent', VC.Mona.BUFF_DURATION);
    addWindow('Mona', 'C4 team crit DMG', mona.teamCritDamageBonus(1.0), 'percent', VC.Mona.BUFF_DURATION);
  }
  if (enabled('Albedo')) {
    const alwaysOn = albedo.teamDamageBonus() + albedo.c6TeamDamageBonus();
    addWindow('Albedo', 'Team DMG bonus (full uptime)', alwaysOn, 'percent', null);
    if (albedo.weapon === 'Patrol Song') {
      addWindow('Albedo', 'Patrol Song team DMG bonus', albedo.patrolSongTeamDamageBonus(), 'percent', VC.Albedo.PATROL_SONG_BUFF_DURATION);
    }
  }
  if (enabled('Durin')) addWindow('Durin', 'C2 Pyro/Anemo DMG bonus (full uptime)', durin.pyroAnemoDamageBonus(), 'percent', null);
  if (pyTruthy(vvWearer) && pyTruthy(vvTargetElement) && absorptionActive) {
    addWindow(vvWearer, `VV 4pc RES shred (${vvTargetElement}, on enemy)`, VC.ARTIFACT_SETS.VV.four_piece_absorption_resistance_shred, 'percent', VC.VV_BUFF_DURATION);
  }
  if (ttdsWielderObj !== null) {
    const ttdsSource = className(ttdsWielderObj);
    if (timeline.nextInPlayOrder(ttdsSource) === 'Venti') {
      let ttdsPercent = VC.valueAtRefinement(VC.TTDS_VENTI_ATTACK_PERCENT_BY_REFINEMENT, ttdsWielderObj.weapon_refinement);
      if (period < VC.TTDS_SHORT_ROTATION_THRESHOLD) ttdsPercent /= 2;
      const { venti } = team;
      const ttdsDelta = (venti.base_attack + venti.weaponStats().base_attack) * ttdsPercent;
      addWindow(ttdsSource, 'TTDS flat ATK (reaches Venti only)', ttdsDelta, 'flat', VC.TTDS_BUFF_DURATION);
    }
  }

  // Prune's team DMG% bonus is the one genuinely continuous, live-ramping
  // buff here -- sampled densely rather than reduced to an interval.
  const curves = [];
  if (enabled('Prune') && absorptionActive) {
    const step = 0.2;
    const n = pyRoundInt(div(period, step));
    const points = [];
    for (let i = 0; i <= n; i++) {
      const t = pyMin(pyRound(i * step, 3), period);
      points.push([t, pyRound(prune.teamDamageBonusAt(resolvedSettings, nicole, buffs, absorptionActive, timeline, t) * 100, 2)]);
      if (t >= period) break;
    }
    const capPercent = pyRoundInt(prune.team_damage_bonus_cap * 100);
    curves.push({ source: 'Prune', label: `Team DMG% bonus (live, capped ${capPercent}%)`, points });
  }

  return {
    period: pyRound(period, 3),
    characters: timeline.order.map((name) => ({
      name, start: pyRound(timeline.arc_start.get(name), 3), field_time: pyRound(timeline.field_time.get(name), 3),
    })),
    windows,
    curves,
  };
}

/* A read-only mirror of the resolution block in ``Team.damageResults``,
 * recomputed here purely so the debug menu can show the intermediate values.
 * It never feeds back into a damage number. ``results`` is the SAME
 * ``DamageResult`` list ``calculate`` already computed (keyed by name). */
function debugPayload(team, results, resonanceActive, anemoResonanceActive) {
  const { enemy, settings, nicole, durin, venti, faruzan, bennett, fischl, mona, albedo } = team;

  const resolvedSettings = settings.replace({
    defense_ignore: nicole.defenseIgnore(),
    defense_reduction: durin.defenseReduction(),
    pyro_resonance_attack_percent: resonanceActive ? settings.pyro_resonance_attack_percent : 0,
  });
  const present = team.member_names.map((name) => team.character(name));
  const absorptionSource = VC.ventiAbsorptionSource(fischl, durin, mona, bennett);
  const absorptionActive = absorptionSource !== null;
  const timeline = VC.RotationTimeline.build(team.member_names, (name) => team.character(name));
  const rotationLength = team.rotationLength();
  const buffs = VC.resolveTeamArtifactBuffs(present, rotationLength, timeline, absorptionActive);

  const durinShred = durin.team_buffs_enabled ? durin.team_resistance_shred : 0;
  const ventiC2 = venti.c2_enabled ? venti.c2_resistance_shred : 0;
  const ventiC6 = venti.c6_enabled ? venti.c6_resistance_shred : 0;
  const faruzanUptime = timeline.windowedUptime('Faruzan', faruzan.buff_duration, 'Venti');
  // Nicole's own kit buffs stay cast at the start of her own arc.
  const nicoleUptime = timeline.windowedUptime('Nicole', VC.Nicole.BUFF_DURATION, 'Venti', false);
  const [vvWearer, vvTargetElement] = VC.vvShredTarget(present);
  const vvUptime = pyTruthy(vvWearer) && absorptionActive ? timeline.windowedUptime(vvWearer, VC.VV_BUFF_DURATION, 'Venti') : 0;
  const vvShred = pyTruthy(vvTargetElement) ? VC.ARTIFACT_SETS.VV.four_piece_absorption_resistance_shred * vvUptime : 0;

  // Faruzan's/Nicole's C2/VV's shreds are real-duration, so what's shown here
  // is Venti's own BLENDED uptime on each.
  const anemo = (enemy.base_resistance - durinShred - ventiC2 - ventiC6
    - faruzan.resistanceShred() * faruzanUptime - nicole.resistanceShred('Anemo') * nicoleUptime);
  let pyro = enemy.base_resistance - durinShred - ventiC6 - nicole.resistanceShred('Pyro') * nicoleUptime;
  const physical = enemy.physical_resistance - ventiC2;
  let electro = enemy.base_resistance - durinShred - nicole.resistanceShred('Electro') * nicoleUptime;
  let hydro = enemy.base_resistance - nicole.resistanceShred('Hydro') * nicoleUptime;
  const geo = enemy.base_resistance - durinShred - nicole.resistanceShred('Geo') * nicoleUptime;
  if (vvTargetElement === 'Pyro') pyro -= vvShred;
  else if (vvTargetElement === 'Electro') electro -= vvShred;
  else if (vvTargetElement === 'Hydro') hydro -= vvShred;

  const monaUptime = timeline.windowedUptime('Mona', VC.Mona.BUFF_DURATION, 'Venti');
  // Computed (and discarded) exactly as the original did -- kept so any error
  // it raises (e.g. a zero Venti field time) surfaces identically.
  void ((nicole.team_buffs_enabled ? nicole.weaponStats().team_damage_bonus : 0) * nicoleUptime
    + buffs.scrollDamageBonus('Venti') + mona.teamDamageBonus(monaUptime)
    + albedo.teamDamageBonus() + albedo.patrolSongTeamDamageBonus() * timeline.windowedUptime('Albedo', VC.Albedo.PATROL_SONG_BUFF_DURATION, 'Venti')
    + albedo.c6TeamDamageBonus());
  const parsed = team.venti_rotation.parse();

  const ttdsWielder = VC.ttdsWielder(nicole, team.prune, mona);
  const ttdsShortRotation = rotationLength < VC.TTDS_SHORT_ROTATION_THRESHOLD;
  const ttdsFullPercent = ttdsWielder ? VC.valueAtRefinement(VC.TTDS_VENTI_ATTACK_PERCENT_BY_REFINEMENT, ttdsWielder.weapon_refinement) : 0;
  const ttdsPercent = ttdsShortRotation ? ttdsFullPercent / 2 : ttdsFullPercent;
  const ventiBaseCoeff = venti.base_attack + venti.weaponStats().base_attack;
  const ttdsFullDelta = ttdsWielder ? ventiBaseCoeff * ttdsPercent : 0;

  const effectiveSkillCasts = VC.ventiEffectiveSkillCasts(parsed.skill_casts, anemoResonanceActive, venti.c2_enabled);

  const teamBuffsByCharacter = {};
  for (const name of team.member_names) {
    const hits = results.has(name) ? results.get(name).hits : [];
    teamBuffsByCharacter[name] = teamBuffsFor(name, hits, team, resolvedSettings, buffs, timeline, present,
      absorptionActive, ttdsWielder, ttdsFullDelta, resonanceActive,
      absorptionSource ? absorptionSource.element : null);
  }

  return {
    resistances: [
      { element: 'Anemo', value: anemo, multiplier: VC.resistanceMultiplier(anemo) },
      { element: 'Pyro', value: pyro, multiplier: VC.resistanceMultiplier(pyro) },
      { element: 'Electro', value: electro, multiplier: VC.resistanceMultiplier(electro) },
      { element: 'Hydro', value: hydro, multiplier: VC.resistanceMultiplier(hydro) },
      { element: 'Geo', value: geo, multiplier: VC.resistanceMultiplier(geo) },
      { element: 'Physical', value: physical, multiplier: VC.resistanceMultiplier(physical) },
    ],
    shred_sources: [
      { name: 'Durin team shred (all elements except Hydro)', value: durinShred },
      { name: 'Venti C2 (Anemo + Physical)', value: ventiC2 },
      { name: 'Venti C6 (Anemo + Pyro)', value: ventiC6 },
      { name: 'Faruzan (Anemo)', value: faruzan.resistanceShred() },
      { name: `Nicole C2 (${nicole.c6_enabled ? 'all elements except Physical' : 'Anemo + Pyro'})`, value: nicole.resistanceShred('Anemo') },
      { name: 'VV 4pc (next-slot element from an Anemo wearer -- see team_buffs)', value: vvShred },
    ],
    defense: {
      // Every character levels independently, so the defense multiplier is
      // one row per team member.
      by_character: team.member_names.map((name) => ({
        name,
        character_level: team.character(name).character_level,
        multiplier: resolvedSettings.defenseMultiplier(enemy, team.character(name).character_level),
      })),
      enemy_level: enemy.level,
      defense_ignore: resolvedSettings.defense_ignore,
      defense_reduction: resolvedSettings.defense_reduction,
    },
    team_buffs_by_character: teamBuffsByCharacter,
    buff_timeline: buffTimeline(team, present, buffs, timeline, absorptionActive, resolvedSettings, resonanceActive,
      vvWearer, vvTargetElement, ttdsWielder, rotationLength),
    // Just what the UI actually reads (the resonance lights and the
    // absorption-source line).
    team_buffs: {
      pyro_resonance_active: resonanceActive,
      anemo_resonance_active: anemoResonanceActive,
      venti_absorption_source: absorptionSource ? className(absorptionSource) : null,
      venti_absorption_element: absorptionSource ? absorptionSource.element : null,
      venti_absorption_active: absorptionActive,
    },
    slots: team.member_names.map((name) => ({
      name,
      slot: VC.slotOf(team.character(name)),
      field_time: team.character(name).field_time,
    })),
    rotation: {
      notation: team.venti_rotation.notation,
      skill_casts: parsed.skill_casts,
      effective_skill_casts: effectiveSkillCasts,
      skill_casts_truncated: parsed.skill_casts > effectiveSkillCasts,
      burst_casts: parsed.burst_casts,
      dash_count: parsed.dash_count,
      normal_sequences: [...parsed.normal_sequences],
      normal_arrow_counts: [...parsed.normal_arrow_counts],
      c1_arrow_counts: [...parsed.c1_arrow_counts],
      total_normal_arrows: pySumMap(parsed.normal_arrow_counts, (count) => count),
      burst_first_hits_per_cast: team.venti_rotation.burst_first_hits_per_cast,
      burst_second_hits_per_cast: team.venti_rotation.burst_second_hits_per_cast,
      swirls_per_burst: team.venti_rotation.swirls_per_burst,
      // Non-linear by refinement (3/3/4/5/6).
      harp_trigger_count: VC.HARP_TRIGGER_COUNT_BY_REFINEMENT[venti.weapon_refinement],
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/* Display-only relabeling for the Damage Stats breakdown -- purely cosmetic.
 * Multiple old keys mapping to the same new label get folded into one bucket. */
const ABILITY_DISPLAY_LABELS = {
  Venti: {
    'burst 1': 'burst anemo',
    'burst 2': 'burst non-anemo',
    'activation skill': 'skill',
    'skill after activation': 'skill',
  },
  Prune: {
    'burst 2': 'burst anemo',
    'burst 3': 'burst non-anemo',
  },
};

/* Exact match first; otherwise, a prefix match renames just the prefix and
 * keeps whatever follows (e.g. a dynamic "(N hits)" suffix). */
function relabelAbility(ability, relabel) {
  if (Object.prototype.hasOwnProperty.call(relabel, ability)) return relabel[ability];
  for (const [oldPrefix, newPrefix] of Object.entries(relabel)) {
    if (ability.startsWith(`${oldPrefix} `)) return newPrefix + ability.slice(oldPrefix.length);
  }
  return ability;
}

function displayAbilities(name, abilities) {
  const relabel = ABILITY_DISPLAY_LABELS[name];
  if (!relabel) return abilities;
  const grouped = new Map();
  for (const [ability, damage] of abilities) {
    const label = relabelAbility(ability, relabel);
    grouped.set(label, (grouped.get(label) ?? 0) + damage);
  }
  return grouped;
}

/* Strip the dynamic "(N hits)" suffix, if present, to recover the base name
 * a row's individual hits are tracked under. */
function baseAbility(ability) {
  if (ability.endsWith(')') && ability.includes(' (') && (ability.includes('hit)') || ability.includes('hits)'))) {
    return ability.slice(0, ability.lastIndexOf(' ('));
  }
  return ability;
}

/* Which raw ``Hit.ability`` labels roll up into a given row's per-hit list --
 * only Venti's "normals"/"C1 normals" combine more than one label. */
const HIT_ROW_LABELS = {
  Venti: {
    normals: new Set(['N1', 'N2', 'N3', 'N4', 'N5', 'N6']),
    'C1 normals': new Set(['C1 N1', 'C1 N2', 'C1 N3', 'C1 N4', 'C1 N5', 'C1 N6']),
  },
};

/* The individual timestamped hits behind one displayed ability row, in
 * landing order, or ``null`` if that row isn't fully covered by the per-hit
 * engine (the matched hits' total must reconcile with the row's damage). */
function hitsForRow(name, hits, displayAbility, damage) {
  if (!hits.length) return null;

  const reconcile = (matched) => {
    if (!matched.length) return null;
    if (Math.abs(sumDamage(matched) - damage) > Math.max(1e-6, Math.abs(damage) * 1e-6)) return null;
    // "no_crit"/"guaranteed_crit" recompute the same hit at 0%/100% crit rate
    // -- display-only, never fed back into any total.
    return [...matched].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
      .map((hit) => ({ time: hit.time, damage: hit.damage, no_crit: hit.noCritDamage, guaranteed_crit: hit.guaranteedCritDamage }));
  };

  // Exact match first -- handles ability strings that collide once the
  // "(N hits)" suffix is stripped.
  const exact = reconcile(hits.filter((hit) => hit.ability === displayAbility));
  if (exact !== null) return exact;
  const relabel = ABILITY_DISPLAY_LABELS[name] ?? {};
  const base = baseAbility(displayAbility);
  let originalBases = Object.entries(relabel).filter(([, label]) => label === base).map(([old]) => old);
  if (!originalBases.length) originalBases = [base];
  const labels = new Set();
  for (const originalBase of originalBases) {
    for (const label of (HIT_ROW_LABELS[name] ?? {})[originalBase] ?? [originalBase]) labels.add(label);
  }
  return reconcile(hits.filter((hit) => labels.has(hit.ability)));
}

/* Run the real calculator over a UI state and return everything the browser
 * needs to repaint. */
export function calculate(state) {
  const team = buildTeam(state);
  const results = team.damageResults();
  const rotationLength = team.rotationLength();
  const total = pySumMap(results, (result) => result.total);

  const resonanceActive = team.member_names.filter((name) => team.character(name).element === 'Pyro').length >= 2;
  const resonancePercent = resonanceActive ? team.settings.pyro_resonance_attack_percent : 0;
  const anemoResonanceActive = team.anemoResonanceActive();
  const characterStates = at(state, 'characters');

  return {
    results: results.map((result) => {
      const resultTotal = result.total;
      const abilities = [...displayAbilities(result.name, result.abilities)]
        .sort((a, b) => (-a[1] < -b[1] ? -1 : -b[1] < -a[1] ? 1 : 0));
      return {
        name: result.name,
        total: resultTotal,
        share: total ? div(resultTotal, total) : 0,
        con_level: pyInt(get(at(characterStates, result.name), 'con_level', 0)),
        abilities: abilities.map(([ability, damage]) => {
          const row = {
            name: ability,
            damage,
            share_of_character: resultTotal ? div(damage, resultTotal) : 0,
            share_of_team: total ? div(damage, total) : 0,
          };
          // Individual timestamped hits behind this row, in landing order --
          // only present once every hit that makes up this row is tracked.
          const hitLog = hitsForRow(result.name, result.hits, ability, damage);
          if (hitLog !== null) row.hit_log = hitLog;
          return row;
        }),
      };
    }),
    members: [...team.member_names],
    total,
    cost: team.cost(),
    dps: rotationLength ? div(total, rotationLength) : 0,
    rotation_length: rotationLength,
    stat_panels: Object.fromEntries(Object.keys(VC.CHARACTER_ROSTER).map((name) => [
      name, characterStatPanel(team.character(name), resonancePercent),
    ])),
    debug: debugPayload(team, new Map(results.map((result) => [result.name, result])), resonanceActive, anemoResonanceActive),
  };
}

/* The optimizer only ever reads a candidate's ``dps`` and ``cost`` -- this is
 * ``calculate`` without the (display-only) stat panels and debug payload,
 * which is most of its cost. Same numbers, same errors from the real engine. */
export function score(state) {
  const team = buildTeam(state);
  const results = team.damageResults();
  const rotationLength = team.rotationLength();
  const total = pySumMap(results, (result) => result.total);
  debugPreflight(team);
  return { cost: team.cost(), dps: rotationLength ? div(total, rotationLength) : 0 };
}

/* The only part of ``debugPayload`` that can fail where ``damageResults``
 * didn't: its blended uptimes are measured against Venti's own arc, so a zero
 * Venti field time divides by zero there. Run just those, so ``score`` fails
 * on exactly the states ``calculate`` fails on. */
function debugPreflight(team) {
  const { durin, faruzan, fischl, mona, bennett } = team;
  const present = team.member_names.map((name) => team.character(name));
  const absorptionActive = VC.ventiAbsorptionSource(fischl, durin, mona, bennett) !== null;
  const timeline = VC.RotationTimeline.build(team.member_names, (name) => team.character(name));
  timeline.windowedUptime('Faruzan', faruzan.buff_duration, 'Venti');
  timeline.windowedUptime('Nicole', VC.Nicole.BUFF_DURATION, 'Venti', false);
  const [vvWearer] = VC.vvShredTarget(present);
  if (pyTruthy(vvWearer) && absorptionActive) timeline.windowedUptime(vvWearer, VC.VV_BUFF_DURATION, 'Venti');
  timeline.windowedUptime('Mona', VC.Mona.BUFF_DURATION, 'Venti');
  timeline.windowedUptime('Albedo', VC.Albedo.PATROL_SONG_BUFF_DURATION, 'Venti');
}
