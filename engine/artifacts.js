/* Artifact/set data model and the team-wide artifact-set buff resolver.
 *
 * ``resolveTeamArtifactBuffs`` dispatches character-specific eligibility by
 * class name rather than importing any character class -- this module sits
 * below the characters in the dependency order, on purpose. */
import { slotOf } from './formulas.js';
import { ValueError, pyMin, pyRepr, pySumMap } from './py.js';

export const ARTIFACT_STAT_FIELDS = [
  'hp', 'hp_percent', 'flat_attack', 'attack_percent', 'flat_defense', 'defense_percent',
  'anemo_damage_bonus', 'pyro_damage_bonus', 'electro_damage_bonus', 'hydro_damage_bonus', 'geo_damage_bonus',
  'crit_rate', 'crit_damage', 'elemental_mastery', 'energy_recharge',
];
const ARTIFACT_STAT_FIELD_SET = new Set(ARTIFACT_STAT_FIELDS);

export const isArtifactStat = (name) => ARTIFACT_STAT_FIELD_SET.has(name);

/* Stats from either one artifact's main stat or its substats. hp, hp_percent
 * and energy_recharge are unused by any damage formula. */
export class ArtifactStats {
  constructor(values = {}) {
    for (const name of ARTIFACT_STAT_FIELDS) this[name] = 0;
    for (const [name, value] of Object.entries(values)) {
      if (!ARTIFACT_STAT_FIELD_SET.has(name)) {
        throw new TypeError(`ArtifactStats.__init__() got an unexpected keyword argument ${pyRepr(name)}`);
      }
      this[name] = value;
    }
  }

  add(other) {
    const sum = new ArtifactStats();
    for (const name of ARTIFACT_STAT_FIELDS) sum[name] = this[name] + other[name];
    return sum;
  }
}

/* An artifact's single fixed main stat (one stat, one value). */
export class MainStat {
  constructor(stat, value) {
    if (!ARTIFACT_STAT_FIELD_SET.has(stat)) throw new ValueError(`Unknown main stat ${pyRepr(stat)}`);
    this.stat = stat;
    this.value = value;
  }

  asArtifactStats() {
    return new ArtifactStats({ [this.stat]: this.value });
  }
}

/* One editable artifact slot. ``main_stat`` is fixed; only ``substats``
 * should be edited after creation. */
export class Artifact {
  constructor(slot, mainStat, substats = new ArtifactStats()) {
    this.slot = slot;
    this.main_stat = mainStat;
    this.substats = substats;
    this._stats = null;
  }

  /* Cached: every damage/attack formula re-reads this on a hot loop, and it's
   * fixed for the object's whole lifetime. */
  get stats() {
    if (this._stats === null) this._stats = this.main_stat.asArtifactStats().add(this.substats);
    return this._stats;
  }
}

/* A complete five-piece loadout. */
export class ArtifactLoadout {
  constructor({ flower, feather, sands, goblet, circlet }) {
    this.flower = flower;
    this.feather = feather;
    this.sands = sands;
    this.goblet = goblet;
    this.circlet = circlet;
    this._total = null;
  }

  /* Cached for the same reason as ``Artifact.stats``. */
  get total() {
    if (this._total === null) {
      let total = new ArtifactStats();
      for (const piece of [this.flower, this.feather, this.sands, this.goblet, this.circlet]) total = total.add(piece.stats);
      this._total = total;
    }
    return this._total;
  }
}

/* Set data. Team effects are resolved once for the whole roster. */
export class ArtifactSet {
  constructor(name, values = {}) {
    this.name = name;
    this.two_piece_attack_percent = 0;
    this.two_piece_burst_damage_bonus = 0;
    this.two_piece_anemo_damage_bonus = 0;
    this.two_piece_defense_percent = 0;
    this.four_piece_triggered_attack_percent = 0;
    this.four_piece_triggered_crit_rate = 0;
    this.four_piece_team_attack_percent = 0;
    this.four_piece_team_damage_bonus = 0;
    this.four_piece_celestial_damage_bonus = 0;
    // Personal, unconditional Geo DMG bonus (Husk).
    this.four_piece_geo_damage_bonus = 0;
    // Personal Elemental Skill DMG bonus (Golden Troupe) -- applies to
    // whichever of a character's own entries are genuinely Skill-type damage.
    this.four_piece_skill_damage_bonus = 0;
    // Shreds whichever element Venti's burst currently absorbs.
    this.four_piece_absorption_resistance_shred = 0;
    Object.assign(this, values);
  }
}

export const ARTIFACT_SETS = {
  'Rising Winds': new ArtifactSet('Rising Winds', {
    two_piece_attack_percent: 0.18, four_piece_triggered_attack_percent: 0.25, four_piece_triggered_crit_rate: 0.20,
  }),
  Noblesse: new ArtifactSet('Noblesse', { two_piece_burst_damage_bonus: 0.20, four_piece_team_attack_percent: 0.20 }),
  'Celestial Gift': new ArtifactSet('Celestial Gift', { four_piece_celestial_damage_bonus: 0.40 }),
  Tenacity: new ArtifactSet('Tenacity', { four_piece_team_attack_percent: 0.20 }),
  Scroll: new ArtifactSet('Scroll', { four_piece_team_damage_bonus: 0.12 }),
  VV: new ArtifactSet('VV', { two_piece_anemo_damage_bonus: 0.15, four_piece_absorption_resistance_shred: 0.40 }),
  Husk: new ArtifactSet('Husk', { two_piece_defense_percent: 0.54, four_piece_geo_damage_bonus: 0.24 }),
  'Golden Troupe': new ArtifactSet('Golden Troupe', { four_piece_skill_damage_bonus: 0.75 }),
  None: new ArtifactSet('None'),
};

export const hasArtifactSet = (name) => Object.prototype.hasOwnProperty.call(ARTIFACT_SETS, name);

/* Real durations for team-wide buffs whose reach is computed from the actual
 * field-time timeline (see ``RotationTimeline``). */
export const NOBLESSE_BUFF_DURATION = 12.0;
export const SCROLL_BUFF_DURATION = 15.0;
export const ELEGY_BUFF_DURATION = 12.0;
export const CELESTIAL_GIFT_BUFF_DURATION = 20.0;
/* Fischl's Pyro-presence team ATK% -- 10s, re-cast the instant she leaves the
 * field every cycle. ``null`` is used instead whenever Durin is present,
 * since his kit keeps it up permanently. */
export const FISCHL_PYRO_ATTACK_BUFF_DURATION = 10.0;
/* Angelos (Nicole's weapon) -- consumed entirely inside ``Team.damageResults``,
 * since its value is also tiered by recipient. */
export const ANGELOS_BUFF_DURATION = 20.0;

const className = (character) => character.constructor.NAME;

/* Non-stacking team set buffs, plus any team buffs granted by a character's
 * weapon. Everything with a real duration is resolved against ``timeline``
 * per-recipient rather than broadcast at a flat value. */
export class TeamArtifactBuffs {
  constructor({
    timeline,
    noblesse_wearer = null,
    tenacity_attack_percent = 0,
    // True only when Faruzan's own C6 is the SOLE eligible Tenacity source --
    // her copy needs an Elemental Skill to actually connect, so it's excluded
    // from Venti's pre-activation hit.
    tenacity_requires_activation = false,
    scroll_wearer = null,
    // True when the wearer's own kit keeps re-triggering swirl often enough
    // that Scroll's 15s timer never lapses (Prune's Hex, Faruzan's C6).
    scroll_full_uptime = false,
    // One [wielder name, value] pair per present Elegy-style wielder.
    windowed_attack_percent_sources = [],
    windowed_elemental_mastery_sources = [],
    // Fischl's Hydro-presence EM bonus -- unconditional/full uptime.
    full_uptime_elemental_mastery = 0,
    // Fischl's Pyro-presence team ATK% (0 if absent/untriggered).
    fischl_pyro_attack_percent = 0,
    // True when Durin is present -- keeps Fischl's Pyro ATK% up permanently.
    fischl_pyro_full_uptime = false,
    // Athame -- reaches only the wielder's teammates, always full uptime.
    weapon_team_attack_percent_others = 0,
    // Celestial Gift: capped, per-element bonus, plus whichever wearer's slot
    // the 20s propagation is measured from.
    elemental_damage_bonuses = new Map(),
    celestial_gift_wearer = null,
  }) {
    this.timeline = timeline;
    this.noblesse_wearer = noblesse_wearer;
    this.tenacity_attack_percent = tenacity_attack_percent;
    this.tenacity_requires_activation = tenacity_requires_activation;
    this.scroll_wearer = scroll_wearer;
    this.scroll_full_uptime = scroll_full_uptime;
    this.windowed_attack_percent_sources = windowed_attack_percent_sources;
    this.windowed_elemental_mastery_sources = windowed_elemental_mastery_sources;
    this.full_uptime_elemental_mastery = full_uptime_elemental_mastery;
    this.fischl_pyro_attack_percent = fischl_pyro_attack_percent;
    this.fischl_pyro_full_uptime = fischl_pyro_full_uptime;
    this.weapon_team_attack_percent_others = weapon_team_attack_percent_others;
    this.elemental_damage_bonuses = elemental_damage_bonuses;
    this.celestial_gift_wearer = celestial_gift_wearer;
  }

  get _fischlPyroDuration() {
    return this.fischl_pyro_full_uptime ? null : FISCHL_PYRO_ATTACK_BUFF_DURATION;
  }

  _windowedAttackPercentExcludingTenacity(recipient) {
    let total = 0.0;
    if (this.noblesse_wearer !== null) {
      total += ARTIFACT_SETS.Noblesse.four_piece_team_attack_percent * this.timeline.windowedUptime(this.noblesse_wearer, NOBLESSE_BUFF_DURATION, recipient);
    }
    for (const [wielder, value] of this.windowed_attack_percent_sources) {
      total += value * this.timeline.windowedUptime(wielder, ELEGY_BUFF_DURATION, recipient);
    }
    if (this.fischl_pyro_attack_percent) {
      total += this.fischl_pyro_attack_percent * this.timeline.windowedUptime('Fischl', this._fischlPyroDuration, recipient);
    }
    return total;
  }

  _snapshotAttackPercentExcludingTenacity(at) {
    let total = 0.0;
    if (this.noblesse_wearer !== null && this.timeline.snapshotActive(this.noblesse_wearer, NOBLESSE_BUFF_DURATION, at)) {
      total += ARTIFACT_SETS.Noblesse.four_piece_team_attack_percent;
    }
    for (const [wielder, value] of this.windowed_attack_percent_sources) {
      if (this.timeline.snapshotActive(wielder, ELEGY_BUFF_DURATION, at)) total += value;
    }
    if (this.fischl_pyro_attack_percent && this.timeline.snapshotActive('Fischl', this._fischlPyroDuration, at)) {
      total += this.fischl_pyro_attack_percent;
    }
    return total;
  }

  _attackPercentExcludingTenacityAt(instant) {
    let total = 0.0;
    if (this.noblesse_wearer !== null && this.timeline.recastActiveAt(this.noblesse_wearer, NOBLESSE_BUFF_DURATION, instant)) {
      total += ARTIFACT_SETS.Noblesse.four_piece_team_attack_percent;
    }
    for (const [wielder, value] of this.windowed_attack_percent_sources) {
      if (this.timeline.recastActiveAt(wielder, ELEGY_BUFF_DURATION, instant)) total += value;
    }
    if (this.fischl_pyro_attack_percent && this.timeline.recastActiveAt('Fischl', this._fischlPyroDuration, instant)) {
      total += this.fischl_pyro_attack_percent;
    }
    return total;
  }

  teamAttackPercent(recipient) {
    return this.tenacity_attack_percent + this._windowedAttackPercentExcludingTenacity(recipient);
  }

  /* Same as ``teamAttackPercent`` but for a snapshot ability -- each source
   * is either fully on or fully off at the instant ``at``'s arc begins. */
  teamAttackPercentSnapshot(at) {
    return this.tenacity_attack_percent + this._snapshotAttackPercentExcludingTenacity(at);
  }

  /* Venti-only: he needs Tenacity added separately with his own activation
   * gating (see ``Venti.attackPercent``). */
  teamAttackPercentExcludingTenacity(recipient) {
    return this._windowedAttackPercentExcludingTenacity(recipient);
  }

  teamAttackPercentExcludingTenacitySnapshot(at) {
    return this._snapshotAttackPercentExcludingTenacity(at);
  }

  teamAttackPercentExcludingTenacityAt(instant) {
    return this._attackPercentExcludingTenacityAt(instant);
  }

  /* Point-in-time sibling of ``teamAttackPercent``. */
  teamAttackPercentAt(instant) {
    return this.tenacity_attack_percent + this._attackPercentExcludingTenacityAt(instant);
  }

  teamElementalMastery(recipient) {
    return this.full_uptime_elemental_mastery + pySumMap(this.windowed_elemental_mastery_sources,
      ([wielder, value]) => value * this.timeline.windowedUptime(wielder, ELEGY_BUFF_DURATION, recipient));
  }

  teamElementalMasterySnapshot(at) {
    const active = this.windowed_elemental_mastery_sources.filter(([wielder]) => this.timeline.snapshotActive(wielder, ELEGY_BUFF_DURATION, at));
    return this.full_uptime_elemental_mastery + pySumMap(active, ([, value]) => value);
  }

  get _scrollDuration() {
    return this.scroll_full_uptime ? null : SCROLL_BUFF_DURATION;
  }

  scrollDamageBonus(recipient) {
    if (this.scroll_wearer === null) return 0;
    return ARTIFACT_SETS.Scroll.four_piece_team_damage_bonus * this.timeline.windowedUptime(this.scroll_wearer, this._scrollDuration, recipient);
  }

  scrollDamageBonusSnapshot(at) {
    if (this.scroll_wearer === null || !this.timeline.snapshotActive(this.scroll_wearer, this._scrollDuration, at)) return 0;
    return ARTIFACT_SETS.Scroll.four_piece_team_damage_bonus;
  }

  /* Point-in-time sibling of ``scrollDamageBonus``. */
  scrollDamageBonusAt(instant) {
    if (this.scroll_wearer === null || !this.timeline.recastActiveAt(this.scroll_wearer, this._scrollDuration, instant)) return 0;
    return ARTIFACT_SETS.Scroll.four_piece_team_damage_bonus;
  }

  /* Each Celestial Gift component (Anemo%, wearer's-element%) only applies to
   * a hit whose own element actually matches it -- ``element`` is the HIT's
   * element, not the character's. */
  elementalDamageBonus(element, recipient) {
    const value = this.elemental_damage_bonuses.get(element) ?? 0;
    if (!value || this.celestial_gift_wearer === null) return value;
    return value * this.timeline.windowedUptime(this.celestial_gift_wearer, CELESTIAL_GIFT_BUFF_DURATION, recipient);
  }

  elementalDamageBonusSnapshot(element, at) {
    const value = this.elemental_damage_bonuses.get(element) ?? 0;
    if (!value || this.celestial_gift_wearer === null) return value;
    return this.timeline.snapshotActive(this.celestial_gift_wearer, CELESTIAL_GIFT_BUFF_DURATION, at) ? value : 0;
  }

  elementalDamageBonusAt(element, instant) {
    const value = this.elemental_damage_bonuses.get(element) ?? 0;
    if (!value || this.celestial_gift_wearer === null) return value;
    return this.timeline.recastActiveAt(this.celestial_gift_wearer, CELESTIAL_GIFT_BUFF_DURATION, instant) ? value : 0;
  }
}

export const ELEGY_FULL_UPTIME_ROTATION_LENGTH = 24.0;

/* Tenacity's 4pc team ATK% can only actually be triggered by Fischl, Albedo,
 * or Faruzan at C6. */
export function tenacityEligible(character) {
  const name = className(character);
  if (name === 'Faruzan') return Boolean(character.c6_enabled ?? false);
  return name === 'Fischl' || name === 'Albedo';
}

/* Noblesse's 4pc team ATK% can be triggered by anyone except Fischl and a
 * non-C6 Albedo; Nicole additionally needs her own burst toggled on. */
export function noblesseEligible(character) {
  const name = className(character);
  if (name === 'Fischl') return false;
  if (name === 'Albedo') return Boolean(character.c6_enabled ?? false);
  if (name === 'Nicole') return Boolean(character.burst_enabled ?? true);
  return true;
}

/* Scroll's 4pc team dmg bonus can only be triggered by an Anemo character. */
export function scrollEligible(character) {
  return character.element === 'Anemo';
}

/* Celestial Gift's personal dmg bonus simply does nothing for these two. */
export const CELESTIAL_GIFT_INELIGIBLE = new Set(['Faruzan', 'Bennett']);

const firstBySlot = (characters) => {
  let best = characters[0];
  for (let i = 1; i < characters.length; i++) if (slotOf(characters[i]) < slotOf(best)) best = characters[i];
  return best;
};

const presentElements = (characters) => new Set(characters.filter((c) => c.team_buffs_enabled ?? true).map((c) => c.element));

/* Apply each teamwide set effect once, even when several wear it, and collect
 * any team ATK%/EM buffs granted by weapons (Elegy for the End et al.) -- a
 * weapon declares these as ``team_attack_percent``/``team_elemental_mastery``
 * keys (scaled by an optional ``team_buff_uptime``, which becomes full value
 * once the rotation reaches ``team_buff_full_uptime_rotation_length``). Each
 * wielder's contribution is kept separate since each has its own slot and
 * therefore its own real propagation to any given recipient.
 *
 * Noblesse/Tenacity/Scroll only trigger their team-wide bonus when an
 * *eligible* character wears them; Celestial Gift's personal bonus is skipped
 * outright for ``CELESTIAL_GIFT_INELIGIBLE`` wearers. */
export function resolveTeamArtifactBuffs(characters, rotationLength, timeline, absorptionActive = false) {
  const unknownSets = [...new Set(characters.map((c) => c.artifact_set))].filter((name) => !hasArtifactSet(name));
  if (unknownSets.length) throw new ValueError(`Unknown artifact set(s): ${unknownSets.sort().join(', ')}`);
  const noblesseWearers = characters.filter((c) => c.artifact_set === 'Noblesse' && noblesseEligible(c));
  const noblesseWearer = noblesseWearers.length ? firstBySlot(noblesseWearers) : null;
  const tenacityWearersEligible = characters.filter((c) => c.artifact_set === 'Tenacity' && tenacityEligible(c));
  const tenacityActive = tenacityWearersEligible.length > 0;
  const tenacityRequiresActivation = tenacityActive && tenacityWearersEligible.every((c) => className(c) === 'Faruzan');
  const scrollWearers = characters.filter((c) => c.artifact_set === 'Scroll' && scrollEligible(c));
  const scrollWearer = scrollWearers.length ? firstBySlot(scrollWearers) : null;
  // Scroll's 15s timer refreshes on the WEARER's own swirl trigger. Prune's
  // Hex keeps generating fresh Anemo ticks once absorption is active, and
  // Faruzan's C6 swirl repeats every 3s -- both keep it permanently up.
  let scrollFullUptime = false;
  if (scrollWearer !== null) {
    const scrollWearerName = className(scrollWearer);
    if (scrollWearerName === 'Prune') scrollFullUptime = absorptionActive;
    else if (scrollWearerName === 'Faruzan') scrollFullUptime = absorptionActive && (scrollWearer.c6_enabled ?? false);
  }
  const elementalBonuses = new Map();
  let celestialGiftWearer = null;
  const windowedAttackPercentSources = [];
  const windowedElementalMasterySources = [];
  let weaponTeamAttackPercentOthers = 0.0;
  let fullUptimeElementalMastery = 0.0;
  let fischlPyroAttackPercent = 0.0;
  const fischlPyroFullUptime = characters.some((c) => className(c) === 'Durin' && (c.team_buffs_enabled ?? true));
  for (const character of characters) {
    const name = className(character);
    const setData = ARTIFACT_SETS[character.artifact_set];
    if (setData.four_piece_celestial_damage_bonus && !CELESTIAL_GIFT_INELIGIBLE.has(name)) {
      // Celestial always buffs Anemo and the wearer's own element, at whatever
      // per-wearer quirk their kit allows (Fischl's copy holds at 50%). Values
      // cap at 40% per element rather than stacking across wearers.
      const uptime = typeof character.celestialGiftUptime === 'function' ? character.celestialGiftUptime() : 1;
      const bonus = setData.four_piece_celestial_damage_bonus * uptime;
      for (const element of ['Anemo', character.element]) {
        elementalBonuses.set(element, pyMin(
          setData.four_piece_celestial_damage_bonus,
          (elementalBonuses.get(element) ?? 0) + bonus,
        ));
      }
      if (celestialGiftWearer === null) celestialGiftWearer = name;
    }
    if (character.team_buffs_enabled ?? true) {
      const weapon = character.weaponStats();
      let uptime = weapon.team_buff_uptime ?? 1;
      const fullUptimeThreshold = weapon.team_buff_full_uptime_rotation_length ?? null;
      if (fullUptimeThreshold !== null && rotationLength >= fullUptimeThreshold) uptime = 1;
      if (weapon.team_attack_percent) windowedAttackPercentSources.push([name, weapon.team_attack_percent * uptime]);
      if (weapon.team_elemental_mastery) windowedElementalMasterySources.push([name, weapon.team_elemental_mastery * uptime]);
      weaponTeamAttackPercentOthers += (weapon.team_attack_percent_others ?? 0) * uptime;
    }
    if (typeof character.teamElementalMasteryBonus === 'function') {
      fullUptimeElementalMastery += character.teamElementalMasteryBonus(presentElements(characters));
    }
    if (name === 'Fischl' && typeof character.teamAttackPercentBonus === 'function') {
      fischlPyroAttackPercent = character.teamAttackPercentBonus(presentElements(characters));
    }
  }
  return new TeamArtifactBuffs({
    timeline,
    noblesse_wearer: noblesseWearer !== null ? className(noblesseWearer) : null,
    tenacity_attack_percent: tenacityActive ? ARTIFACT_SETS.Tenacity.four_piece_team_attack_percent : 0,
    tenacity_requires_activation: tenacityRequiresActivation,
    scroll_wearer: scrollWearer !== null ? className(scrollWearer) : null,
    scroll_full_uptime: scrollFullUptime,
    windowed_attack_percent_sources: windowedAttackPercentSources,
    windowed_elemental_mastery_sources: windowedElementalMasterySources,
    weapon_team_attack_percent_others: weaponTeamAttackPercentOthers,
    elemental_damage_bonuses: elementalBonuses,
    celestial_gift_wearer: celestialGiftWearer,
    fischl_pyro_attack_percent: fischlPyroAttackPercent,
    fischl_pyro_full_uptime: fischlPyroFullUptime,
  });
}
