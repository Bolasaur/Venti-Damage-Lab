/* Per-hit combat primitives: the buff bundle a single hit sees, the enemy/
 * team-settings context, and the discrete-event ``Hit``/``DamageResult``
 * types damage formulas produce. */
import { REACTION_MULTIPLIER_BY_LEVEL, expectedCritMultiplier, statAtLevel } from './formulas.js';
import { div, pySum } from './py.js';

/* Every external, time-varying value one individual hit sees, evaluated AT
 * THAT HIT'S OWN TICK (via ``RotationTimeline.activeAt``) -- the single buff
 * bundle every hit in the tick engine uses, whether on-field, off-field or a
 * snapshot. ``external_attack_percent`` (team ATK% from weapons like Elegy,
 * excluding Tenacity) is only consumed by Venti's own ``finalAttack``. */
export class HitBuffs {
  constructor({
    elemental_damage_bonus = 0.0, shared_bonus = 0.0, nicole_uptime = 0.0, bennett_uptime = 0.0,
    faruzan_uptime = 0.0, crit_rate_bonus = 0.0, crit_damage_bonus = 0.0, external_attack_percent = 0.0,
    resistance = 0.0,
  } = {}) {
    this.elemental_damage_bonus = elemental_damage_bonus;
    this.shared_bonus = shared_bonus;
    this.nicole_uptime = nicole_uptime;
    this.bennett_uptime = bennett_uptime;
    this.faruzan_uptime = faruzan_uptime;
    this.crit_rate_bonus = crit_rate_bonus;
    this.crit_damage_bonus = crit_damage_bonus;
    this.external_attack_percent = external_attack_percent;
    this.resistance = resistance;
  }
}

export class Enemy {
  constructor({ level = 100, base_resistance = 0.1, physical_resistance = 0.1 } = {}) {
    this.level = level;
    this.base_resistance = base_resistance;
    this.physical_resistance = physical_resistance;
  }
}

export class TeamSettings {
  constructor({
    pyro_resonance_attack_percent = 0.25,
    // Nicole's C6: the whole team ignores this fraction of enemy defense.
    // Durin's C6: the enemy's defense is separately reduced by this fraction
    // (a distinct, stacking multiplier). ``Team.damageResults`` resolves both
    // once so every character's ``defenseMultiplier`` call picks them up.
    defense_ignore = 0,
    defense_reduction = 0,
    slot_3_buff_uptime = 0.90,
    slot_4_buff_uptime = 0.80,
  } = {}) {
    this.pyro_resonance_attack_percent = pyro_resonance_attack_percent;
    this.defense_ignore = defense_ignore;
    this.defense_reduction = defense_reduction;
    this.slot_3_buff_uptime = slot_3_buff_uptime;
    this.slot_4_buff_uptime = slot_4_buff_uptime;
  }

  /* ``dataclasses.replace(settings, **changes)``. */
  replace(changes) {
    return new TeamSettings({ ...this, ...changes });
  }

  /* ``characterLevel`` is the *attacking* character's own level.
   * ``extraDefenseIgnore`` (e.g. Durin's personal C6 burst ignore) stacks
   * ADDITIVELY with ``this.defense_ignore`` (e.g. Nicole's C6) into one
   * total-ignore fraction, which then multiplies in alongside
   * ``defense_reduction``. */
  defenseMultiplier(enemy, characterLevel, extraDefenseIgnore = 0) {
    const totalDefenseIgnore = this.defense_ignore + extraDefenseIgnore;
    return div(characterLevel + 100,
      (characterLevel + 100) + (enemy.level + 100) * (1 - this.defense_reduction) * (1 - totalDefenseIgnore));
  }

  /* The EM reaction multiplier a swirl hit scales by, at whichever
   * character's level triggers it. */
  reactionMultiplier(characterLevel) {
    return statAtLevel(REACTION_MULTIPLIER_BY_LEVEL, characterLevel);
  }
}

/* One individual, timestamped hit. ``time`` is seconds from the start of the
 * rotation. ``damage`` already includes any quill/projection bonus riding on
 * this hit -- it's the real (expected-value) number DPS is computed from.
 * ``crit_rate``/``crit_damage`` are display-only (0/0 for anything that
 * can't crit, e.g. swirl damage). */
export class Hit {
  constructor(character, ability, time, damage, critRate = 0.0, critDamage = 0.0) {
    this.character = character;
    this.ability = ability;
    this.time = time;
    this.damage = damage;
    this.crit_rate = critRate;
    this.crit_damage = critDamage;
  }

  get noCritDamage() {
    return div(this.damage, expectedCritMultiplier(this.crit_rate, this.crit_damage));
  }

  get guaranteedCritDamage() {
    return this.noCritDamage * (1 + this.crit_damage);
  }
}

/* ``abilities`` is an insertion-ordered Map of ability name -> damage.
 * ``breakdowns`` maps an ability name to a Map of sub-label -> [hits, damage]
 * (Venti's "normals"/"C1 normals"/"skill" mix several differently-scaled hit
 * types into one total). ``hits`` are the individual timestamped hits. */
export class DamageResult {
  constructor(name, abilities, breakdowns = new Map(), hits = []) {
    this.name = name;
    this.abilities = abilities;
    this.breakdowns = breakdowns;
    this.hits = hits;
  }

  get total() {
    return pySum([...this.abilities.values()]);
  }
}
