import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import {
  RefinementTable, attack, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier, statAtLevel,
  weightedQuillMultiplier,
} from '../formulas.js';
import { div, pyIntValue, pySumMap } from '../py.js';
import { durinArtifacts } from '../substats.js';
import { Character } from './base.js';

const DURIN_BASE_ATTACK_BY_LEVEL = {
  10: 48.52, 20: 70.04, 30: 116.31, 40: 139.43, 50: 179.34, 60: 224.98, 70: 265.34, 80: 305.98, 90: 346.81, 95: 385.82, 100: 424.84,
};

/* Durin's build, plus the team-wide buffs and C1 quill his kit provides. C6
 * stacks two distinct defense effects: a personal ignore on Durin's own burst
 * damage only, and a separate, global defense reduction that multiplies in
 * alongside Nicole's C6 defense-ignore rather than replacing it. */
export class Durin extends Character {
  static NAME = 'Durin';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c1_enabled: false,
    c2_enabled: false,
    c3_enabled: false,
    c4_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: "Moonweaver's Dawn",
    weapon_refinement: 1,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Durin's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: true,
    artifact_set: 'Rising Winds',
    element: 'Pyro',
    ascension_crit_damage: 0.384,
    // Applies to every element except Hydro. Physical is untouched.
    team_resistance_shred: 0.35,
    // Priority for granting Venti's burst an elemental absorption. Lower wins;
    // Fischl(1) > Durin(2) > Mona(3) > Bennett(4).
    absorption_priority: 2,
    // C1: a quill landing on any hit of every OTHER present character -- each
    // gets their own pool of up to 20 (or, with C4, ~28.6) procs.
    c1_quill_percent: 0.60,
    c1_quill_hits_base: 20,
    // C2: teamwide Pyro and Anemo damage bonus.
    c2_pyro_anemo_damage_bonus: 0.50,
    // C3: raises his burst hits' and his 20-tick daggers' motion values.
    c3_burst_1_mv: 2.528,
    c3_burst_2_mv: 2.049,
    c3_burst_3_mv: 2.377,
    c3_tick_mv: 2.011,
    // C4: a personal burst damage bonus, plus a chance for a C1 quill stack to
    // not be consumed, which stretches its 20 hits further.
    c4_burst_damage_bonus: 0.40,
    c4_quill_retain_chance: 0.30,
    // C5: raises his skill's motion value.
    c5_skill_mv: 2.244,
    // C6: his own burst personally ignores defense, and (separately) the whole
    // team's hits get a flat defense reduction.
    c6_burst_defense_ignore: 0.30,
    c6_defense_reduction: 0.30,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 4,
    // Seconds Durin spends on-field during one full rotation.
    field_time: 3,
  };

  static WEAPONS = {
    Haran: {
      base_attack: 608, attack_percent: 0.0, crit_rate: 0.331, crit_damage: 0.0,
      skill_damage_bonus: refinementScale(0.12, 0.24), burst_damage_bonus: refinementScale(0.12, 0.24), front_burst_crit_rate: 0.0,
    },
    "Moonweaver's Dawn": {
      base_attack: 565, attack_percent: 0.276, crit_rate: 0.0, crit_damage: 0.0,
      skill_damage_bonus: 0.0, burst_damage_bonus: refinementScale(0.20, 0.40), front_burst_crit_rate: 0.0,
    },
    'Wolf Fang': {
      base_attack: 510, attack_percent: 0.0, crit_rate: 0.276, crit_damage: 0.0,
      skill_damage_bonus: refinementScale(0.16, 0.32), burst_damage_bonus: refinementScale(0.16, 0.32),
      front_burst_crit_rate: refinementScale(0.06, 0.12),
    },
    Athame: {
      base_attack: 608, attack_percent: refinementScale(0.35, 0.70), crit_rate: 0.331, crit_damage: 0.0,
      skill_damage_bonus: 0.0, burst_damage_bonus: 0.0, front_burst_crit_rate: 0.0,
      burst_crit_damage: refinementScale(0.16, 0.32), team_attack_percent_others: refinementScale(0.28, 0.56),
    },
    'Jade Cutter': {
      base_attack: 542, attack_percent: 0.0, crit_rate: 0.441, crit_damage: 0.0,
      skill_damage_bonus: 0.0, burst_damage_bonus: 0.0, front_burst_crit_rate: 0.0,
      // Not a linear refinement progression -- an explicit per-refinement table.
      flat_attack: RefinementTable.of({ 1: 259, 2: 334, 3: 412, 4: 495, 5: 581 }),
    },
    // A flat DMG bonus with no skill/burst distinction -- folded into both.
    Mistsplitter: {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.441,
      skill_damage_bonus: refinementScale(0.28, 0.56), burst_damage_bonus: refinementScale(0.28, 0.56), front_burst_crit_rate: 0.0,
    },
    // No refinement effect at all.
    Exaiphanes: {
      base_attack: 608, attack_percent: 0.0, crit_rate: 0.331, crit_damage: 0.0,
      skill_damage_bonus: 0.0, burst_damage_bonus: 0.0, front_burst_crit_rate: 0.0,
    },
    Azurelight: {
      base_attack: 674, attack_percent: refinementScale(0.24, 0.48), crit_rate: 0.221, crit_damage: 0.0,
      skill_damage_bonus: 0.0, burst_damage_bonus: 0.0, front_burst_crit_rate: 0.0,
    },
    Absolution: {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.0, crit_damage: refinementScale(0.641, 0.841),
      skill_damage_bonus: 0.0, burst_damage_bonus: 0.0, front_burst_crit_rate: 0.0,
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = {
    Haran: 1, "Moonweaver's Dawn": 1, 'Wolf Fang': 5, Athame: 1, 'Jade Cutter': 1, Mistsplitter: 1, Exaiphanes: 5,
    Azurelight: 1, Absolution: 1,
  };

  get base_attack() {
    return statAtLevel(DURIN_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = durinArtifacts(this);
  }

  /* ``instant``, when given, resolves Noblesse/Elegy's team ATK% at that real
   * timestamp instead of the blended average over Durin's own on-field arc. */
  finalAttack(settings, nicole, artifactBuffs, nicoleUptime = 1.0, instant = null) {
    const artifacts = this.artifacts.total;
    const risingWinds = ARTIFACT_SETS[this.artifact_set];
    const weapon = this.weaponStats();
    const teamAttackPercent = instant !== null ? artifactBuffs.teamAttackPercentAt(instant) : artifactBuffs.teamAttackPercent('Durin');
    const percent = (teamAttackPercent + artifacts.attack_percent
      + settings.pyro_resonance_attack_percent + risingWinds.two_piece_attack_percent
      + risingWinds.four_piece_triggered_attack_percent + weapon.attack_percent);
    return attack(this.base_attack, weapon.base_attack, percent, nicole.teamFlatAttack(settings, artifactBuffs, nicoleUptime),
      artifacts.flat_attack, pyIntValue(weapon.flat_attack ?? 0));
  }

  critStats(extraCritRate = 0, extraCritDamage = 0) {
    const artifacts = this.artifacts.total;
    const risingWinds = ARTIFACT_SETS[this.artifact_set];
    const weapon = this.weaponStats();
    return [
      0.05 + weapon.crit_rate + extraCritRate + artifacts.crit_rate + risingWinds.four_piece_triggered_crit_rate,
      0.5 + weapon.crit_damage + artifacts.crit_damage + this.ascension_crit_damage + extraCritDamage,
    ];
  }

  critMultiplier(extraCritRate = 0, extraCritDamage = 0) {
    return expectedCritMultiplier(...this.critStats(extraCritRate, extraCritDamage));
  }

  /* C2: teamwide Pyro and Anemo damage bonus. */
  pyroAnemoDamageBonus() {
    return this.team_buffs_enabled && this.c2_enabled ? this.c2_pyro_anemo_damage_bonus : 0;
  }

  c4OwnBurstDamageBonus() {
    return this.team_buffs_enabled && this.c4_enabled ? this.c4_burst_damage_bonus : 0;
  }

  /* C6: a global, team-wide defense reduction. */
  defenseReduction() {
    return this.team_buffs_enabled && this.c6_enabled ? this.c6_defense_reduction : 0;
  }

  /* C6: Durin's own burst damage additionally, personally ignores defense. */
  burstDefenseIgnore() {
    return this.team_buffs_enabled && this.c6_enabled ? this.c6_burst_defense_ignore : 0;
  }

  /* His personal C6 burst ignore stacks ADDITIVELY with any teamwide
   * defense-ignore (e.g. Nicole's C6). */
  burstDefenseMultiplier(settings, enemy) {
    return settings.defenseMultiplier(enemy, this.character_level, this.burstDefenseIgnore());
  }

  c1QuillHits() {
    if (!(this.team_buffs_enabled && this.c1_enabled)) return 0;
    // A 30% chance a trigger doesn't consume the stack stretches its expected
    // number of triggers by 1 / (1 - chance).
    if (this.c4_enabled) return div(this.c1_quill_hits_base, 1 - this.c4_quill_retain_chance);
    return this.c1_quill_hits_base;
  }

  c1QuillBonus(settings, nicole, artifactBuffs, nicoleUptime = 1.0) {
    if (!(this.team_buffs_enabled && this.c1_enabled)) return 0;
    return this.c1_quill_percent * this.finalAttack(settings, nicole, artifactBuffs, nicoleUptime);
  }

  damage(settings, enemy, nicole, bennett, artifactBuffs, skillBuffs, burstBuffs, front = [], back = [], skillTime = 0.0, burstTime = 0.0) {
    const weapon = this.weaponStats();

    // Prune's team DMG bonus arrives pre-baked into ``buffs.shared_bonus``.
    const hitBonus = (buffs) => (buffs.elemental_damage_bonus + this.artifacts.total.pyro_damage_bonus
      + buffs.shared_bonus
      + bennett.pyroDamageBonus(buffs.bennett_uptime) + this.pyroAnemoDamageBonus());

    // Nicole's 300 on-field ATK applies to Durin's skill and his three
    // burst-tick hits (not the 20 dagger ticks) outside C6.
    const onFieldAttack = (buffs) => (this.finalAttack(settings, nicole, artifactBuffs, buffs.nicole_uptime)
      + nicole.skillOnFieldAttack(buffs.nicole_uptime) + bennett.teamAttackBuff(buffs.bennett_uptime));

    const burstDamageBonus = (weapon.burst_damage_bonus + this.c4OwnBurstDamageBonus()
      + ARTIFACT_SETS[this.artifact_set].two_piece_burst_damage_bonus);
    // C6's personal burst-only defense ignore only affects burst entries.
    const skillDefenseResistance = settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(skillBuffs.resistance);
    const burstDefenseResistance = this.burstDefenseMultiplier(settings, enemy) * resistanceMultiplier(burstBuffs.resistance);
    const skillMv = this.c5_enabled ? this.c5_skill_mv : 1.901;
    const burst1Mv = this.c3_enabled ? this.c3_burst_1_mv : 2.141;
    const burst2Mv = this.c3_enabled ? this.c3_burst_2_mv : 1.735;
    const burst3Mv = this.c3_enabled ? this.c3_burst_3_mv : 2.013;
    const tickMv = this.c3_enabled ? this.c3_tick_mv : 1.704;
    const burstCritDamage = weapon.burst_crit_damage ?? 0;
    const skillCritStats = this.critStats(skillBuffs.crit_rate_bonus, skillBuffs.crit_damage_bonus);
    const burstCritStats = this.critStats(burstBuffs.crit_rate_bonus, burstCritDamage + burstBuffs.crit_damage_bonus);
    const skillMultiplier = (1 + hitBonus(skillBuffs) + weapon.skill_damage_bonus + ARTIFACT_SETS[this.artifact_set].four_piece_skill_damage_bonus)
      * skillDefenseResistance * expectedCritMultiplier(...skillCritStats);
    const burstMultiplier = (1 + hitBonus(burstBuffs) + burstDamageBonus) * burstDefenseResistance * expectedCritMultiplier(...burstCritStats);

    // The 20 front/back dagger ticks don't snapshot at all -- every value is
    // resolved fresh AT THAT TICK'S OWN INSTANT.
    const tickAttack = (buffs, time) => this.finalAttack(settings, nicole, artifactBuffs, buffs.nicole_uptime, time)
      + nicole.teamWideFlatAttack(buffs.nicole_uptime);

    // The very first front-dagger tick fires the instant his burst lands,
    // while he's still on-field -- so it gets Nicole's on-field bonus (and
    // Bennett's team ATK buff) like his skill/burst hits do.
    const firstTickAttack = (buffs, time) => (this.finalAttack(settings, nicole, artifactBuffs, buffs.nicole_uptime, time)
      + nicole.skillOnFieldAttack(buffs.nicole_uptime) + bennett.teamAttackBuff(buffs.bennett_uptime));

    const frontTickCritStats = (buffs) => this.critStats(weapon.front_burst_crit_rate + buffs.crit_rate_bonus, burstCritDamage + buffs.crit_damage_bonus);

    const backTickCritStats = (buffs) => this.critStats(buffs.crit_rate_bonus, burstCritDamage + buffs.crit_damage_bonus);

    const frontTickMultiplier = (buffs) => {
      const defenseResistance = this.burstDefenseMultiplier(settings, enemy) * resistanceMultiplier(buffs.resistance);
      return (1 + hitBonus(buffs) + burstDamageBonus) * defenseResistance * expectedCritMultiplier(...frontTickCritStats(buffs));
    };

    const backTickMultiplier = (buffs) => {
      const defenseResistance = this.burstDefenseMultiplier(settings, enemy) * resistanceMultiplier(buffs.resistance);
      return (1 + hitBonus(buffs) + burstDamageBonus) * defenseResistance * expectedCritMultiplier(...backTickCritStats(buffs));
    };

    const frontHits = front.map(([time, buffs], i) => new Hit('Durin', 'burst front', time,
      tickMv * (i === 0 ? firstTickAttack(buffs, time) : tickAttack(buffs, time)) * 1.75 * frontTickMultiplier(buffs),
      ...frontTickCritStats(buffs)));
    const backHits = back.map(([time, buffs]) => new Hit('Durin', 'burst back', time,
      tickMv * tickAttack(buffs, time) * backTickMultiplier(buffs), ...backTickCritStats(buffs)));
    const skillDamage = skillMv * onFieldAttack(skillBuffs) * skillMultiplier;
    const burst1Damage = burst1Mv * onFieldAttack(burstBuffs) * burstMultiplier;
    const burst2Damage = burst2Mv * onFieldAttack(burstBuffs) * burstMultiplier;
    const burst3Damage = burst3Mv * onFieldAttack(burstBuffs) * burstMultiplier;
    const result = new Map([
      ['skill', skillDamage],
      ['burst 1', burst1Damage],
      ['burst 2', burst2Damage],
      ['burst 3', burst3Damage],
    ]);
    result.set(hitSuffix('burst front', frontHits.length), pySumMap(frontHits, (hit) => hit.damage));
    result.set(hitSuffix('burst back', backHits.length), pySumMap(backHits, (hit) => hit.damage));
    const ownHits = [
      new Hit('Durin', 'skill', skillTime, skillDamage, ...skillCritStats),
      new Hit('Durin', 'burst 1', burstTime, burst1Damage, ...burstCritStats),
      new Hit('Durin', 'burst 2', burstTime, burst2Damage, ...burstCritStats),
      new Hit('Durin', 'burst 3', burstTime, burst3Damage, ...burstCritStats),
    ];
    // Nicole's C4 quill is Venti-only below C6 -- once C6 widens it, it lands
    // on any of Durin's own (non-transformative) hits too.
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      const quillBuckets = [
        [1, skillMultiplier],
        [3, burstMultiplier],
        [front.length, front.length ? div(pySumMap(front, ([, buffs]) => 1.75 * frontTickMultiplier(buffs)), front.length) : 0],
        [back.length, back.length ? div(pySumMap(back, ([, buffs]) => backTickMultiplier(buffs)), back.length) : 0],
      ];
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Durin', result, new Map(), [...frontHits, ...backHits, ...ownHits]);
  }
}
