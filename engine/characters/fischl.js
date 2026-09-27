import { ARTIFACT_SETS, ELEGY_FULL_UPTIME_ROTATION_LENGTH } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import {
  HARP_TRIGGER_COUNT_BY_REFINEMENT, attack, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier,
  statAtLevel, weightedQuillMultiplier,
} from '../formulas.js';
import { div, pySumMap } from '../py.js';
import { fischlArtifacts } from '../substats.js';
import { Character } from './base.js';

const FISCHL_BASE_ATTACK_BY_LEVEL = {
  10: 36.76, 20: 52.61, 30: 84.81, 40: 101.72, 50: 129.51, 60: 160.92, 70: 188.68, 80: 216.47, 90: 244.26, 95: 275.41, 100: 306.57,
};

/* Fischl's build. Her Skill summons Oz, who then keeps attacking off-field
 * for the rest of the fight -- see ``damage``. */
export class Fischl extends Character {
  static NAME = 'Fischl';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c2_enabled: false,
    c3_enabled: false,
    c6_enabled: false,
    weapon: 'Stringless',
    weapon_refinement: 5,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Fischl's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: false,
    artifact_set: 'Rising Winds',
    element: 'Electro',
    ascension_attack_percent: 0.24,
    // C6: Oz's off-field ("primary") hit count, up from 10.
    c6_oz_primary_hits: 12,
    // Priority for granting Venti's burst an elemental absorption. Lower wins.
    absorption_priority: 1,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 4,
    // Seconds Fischl spends on-field -- she casts her Skill and swaps out.
    field_time: 1.5,
    // Conditional team buffs -- see ``teamAttackPercentBonus``/
    // ``teamElementalMasteryBonus``.
    pyro_present_attack_percent: 0.225,
    c6_pyro_present_attack_percent: 0.45,
    hydro_present_elemental_mastery: 90,
    c6_hydro_present_elemental_mastery: 180,
  };

  static WEAPONS = {
    'Daybreak Chronicles': {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.442,
      damage_bonus: refinementScale(0.60, 1.20), has_harp_trigger: false,
    },
    'Skyward Harp': {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.221, crit_damage: refinementScale(0.20, 0.40),
      damage_bonus: 0.0, has_harp_trigger: true,
    },
    Stringless: {
      base_attack: 510, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.0,
      damage_bonus: refinementScale(0.24, 0.48), has_harp_trigger: false,
    },
    // No change across refinements.
    'Favonius Bow': { base_attack: 454, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0, has_harp_trigger: false },
    'Elegy for the End': {
      base_attack: 608, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0, has_harp_trigger: false,
      elemental_mastery: refinementScale(60.0, 120.0), team_attack_percent: refinementScale(0.20, 0.40),
      team_elemental_mastery: refinementScale(100.0, 200.0), team_buff_uptime: 0.5,
      team_buff_full_uptime_rotation_length: ELEGY_FULL_UPTIME_ROTATION_LENGTH,
    },
    // No effect modeled beyond base stats -- she has no on-field normal attacks.
    Slingshot: { base_attack: 354, attack_percent: 0.0, crit_rate: 0.312, crit_damage: 0.0, damage_bonus: 0.0, has_harp_trigger: false },
    "Amos' Bow": { base_attack: 608, attack_percent: 0.496, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0, has_harp_trigger: false },
    'Aqua Simulacra': {
      base_attack: 542, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.882,
      damage_bonus: refinementScale(0.20, 0.40), has_harp_trigger: false,
    },
    "Hunter's Path": {
      base_attack: 542, attack_percent: 0.0, crit_rate: 0.441, crit_damage: 0.0,
      damage_bonus: refinementScale(0.12, 0.24), has_harp_trigger: false,
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = {
    'Daybreak Chronicles': 1, 'Skyward Harp': 1, Stringless: 5, 'Favonius Bow': 1, 'Elegy for the End': 1,
    Slingshot: 5, "Amos' Bow": 1, 'Aqua Simulacra': 1, "Hunter's Path": 1,
  };

  get base_attack() {
    return statAtLevel(FISCHL_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  /* Skyward Harp's physical proc count per rotation. */
  get harp_trigger_count() {
    return HARP_TRIGGER_COUNT_BY_REFINEMENT[this.weapon_refinement];
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = fischlArtifacts(this);
  }

  /* Her whole kit snapshots at her Skill cast, so every external team buff
   * here uses the SNAPSHOT (binary, not blended) query. */
  attackPercent(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercentSnapshot('Fischl') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + w.attack_percent + this.ascension_attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  finalAttack(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs), artifacts.flat_attack);
  }

  /* The whole team's ATK% while a Pyro character is present -- doubled at C6. */
  teamAttackPercentBonus(presentElements) {
    if (!(this.team_buffs_enabled && presentElements.has('Pyro'))) return 0;
    return this.c6_enabled ? this.c6_pyro_present_attack_percent : this.pyro_present_attack_percent;
  }

  /* The whole team's EM while a Hydro character is present -- doubled at C6. */
  teamElementalMasteryBonus(presentElements) {
    if (!(this.team_buffs_enabled && presentElements.has('Hydro'))) return 0;
    return this.c6_enabled ? this.c6_hydro_present_elemental_mastery : this.hydro_present_elemental_mastery;
  }

  /* Fischl's Celestial Gift only holds its bonus up half the time. */
  celestialGiftUptime() {
    return 0.5;
  }

  damage(settings, enemy, nicole, bennett, durin, artifactBuffs, snap, physicalResistance, primaryTimes = [], secondaryTimes = [],
    tertiaryTimes = [], skillTime = 0.0, burstTime = 0.0) {
    // Every one of Fischl's hits snapshots her stats at the instant she casts
    // her Skill (``snap``), and that one frozen buff bundle covers the entire
    // rest of her rotation.
    const onFieldAttack = (this.finalAttack(settings, artifactBuffs) + nicole.skillOnFieldAttack(snap.nicole_uptime)
      + bennett.teamAttackBuff(snap.bennett_uptime));
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    const w = this.weaponStats();
    const critStats = [
      0.05 + w.crit_rate + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate + snap.crit_rate_bonus,
      0.5 + w.crit_damage + artifacts.crit_damage + snap.crit_damage_bonus,
    ];
    const crit = expectedCritMultiplier(...critStats);
    // Golden Troupe's Skill DMG bonus applies to all of Fischl's Electro hits
    // (Oz is her Skill's ongoing effect) -- not to "harp trigger" below.
    const bonus = artifacts.electro_damage_bonus + snap.elemental_damage_bonus + snap.shared_bonus + w.damage_bonus
      + artifactSet.four_piece_skill_damage_bonus;
    const skillMv = this.c3_enabled ? 4.45 : (this.c2_enabled ? 4.08 : 2.08);
    const ozPrimaryMv = this.c3_enabled ? 1.887 : 1.598;
    const multiplier = (1 + bonus) * crit * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(snap.resistance);

    const primaryHits = primaryTimes.map((time) => new Hit('Fischl', 'oz primary', time, ozPrimaryMv * onFieldAttack * multiplier, ...critStats));
    const secondaryHits = secondaryTimes.map((time) => new Hit('Fischl', 'oz secondary', time, 0.80 * onFieldAttack * multiplier, ...critStats));
    const skillDamage = skillMv * onFieldAttack * multiplier;
    const result = new Map([['skill', skillDamage]]);
    result.set(hitSuffix('oz primary', primaryHits.length), pySumMap(primaryHits, (hit) => hit.damage));
    result.set(hitSuffix('oz secondary', secondaryHits.length), pySumMap(secondaryHits, (hit) => hit.damage));
    let ownHits = [new Hit('Fischl', 'skill', skillTime, skillDamage, ...critStats)];
    // Durin's C1 quill lands on any of Fischl's hits; everything shares one
    // frozen ``multiplier``.
    const quillBuckets = [[1, multiplier], [primaryHits.length, multiplier], [secondaryHits.length, multiplier]];
    // C6: an additional personal hit worth 30% MV for every normal-attack
    // arrow Venti fires, one per real Venti normal-attack tick.
    if (this.team_buffs_enabled && this.c6_enabled) {
      const tertiaryHits = tertiaryTimes.map((time) => new Hit('Fischl', 'c6 coordinated attack', time, 0.30 * onFieldAttack * multiplier, ...critStats));
      const coordinatedTotal = pySumMap(tertiaryHits, (hit) => hit.damage);
      result.set(hitSuffix('c6 coordinated attack', tertiaryHits.length), coordinatedTotal);
      quillBuckets.push([tertiaryHits.length, multiplier]);
      ownHits = [...ownHits, ...tertiaryHits];
    }
    // Skyward Harp's proc is Physical DMG -- only the generic bonus applies.
    if (w.has_harp_trigger) {
      const physicalBonus = snap.shared_bonus + w.damage_bonus;
      const harpRest = ((1 + physicalBonus) * crit * settings.defenseMultiplier(enemy, this.character_level)
        * resistanceMultiplier(physicalResistance));
      const harpTotal = 1.25 * onFieldAttack * harpRest * this.harp_trigger_count;
      result.set('harp trigger', harpTotal);
      quillBuckets.push([this.harp_trigger_count, harpRest]);
      const harpHits = [];
      for (let i = 0; i < this.harp_trigger_count; i++) {
        harpHits.push(new Hit('Fischl', 'harp trigger', skillTime, div(harpTotal, this.harp_trigger_count), ...critStats));
      }
      ownHits = [...ownHits, ...harpHits];
    }
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Fischl', result, new Map(), [...primaryHits, ...secondaryHits, ...ownHits]);
  }
}
