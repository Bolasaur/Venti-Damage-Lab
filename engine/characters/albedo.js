import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import {
  attack, defense, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier, statAtLevel, valueAtRefinement,
  weightedQuillMultiplier,
} from '../formulas.js';
import { div, pyMin } from '../py.js';
import { albedoArtifacts } from '../substats.js';
import { Character } from './base.js';

const ALBEDO_BASE_ATTACK_BY_LEVEL = {
  10: 35.13, 20: 50.72, 30: 84.22, 40: 100.97, 50: 129.87, 60: 162.91, 70: 192.15, 80: 221.57, 90: 251.14, 95: 279.39, 100: 307.64,
};
const ALBEDO_BASE_DEFENSE_BY_LEVEL = {
  10: 122.57, 20: 176.93, 30: 293.81, 40: 352.25, 50: 453.07, 60: 568.36, 70: 670.34, 80: 773.01, 90: 876.15, 95: 907.25, 100: 938.42,
};

/* Albedo's build -- the first character whose damage scales off DEF rather
 * than ATK. His skill is two independent hits: a single ATK-scaling hit at
 * his own Skill cast, plus a separate DEF-scaling hit that ticks off-field
 * every 2 seconds for the rest of the rotation. His whole kit snapshots its
 * stats once, at his Skill cast. C2's extra hit is classified as Burst-type
 * damage for buff purposes even though nothing actually casts a Burst. */
export class Albedo extends Character {
  static NAME = 'Albedo';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c1_enabled: false,
    c2_enabled: false,
    c3_enabled: false,
    // C4/C5 have no modelled damage effect -- tracked purely so the
    // constellation cascade has somewhere to land and so enabling them still
    // counts toward Team Cost (see ``NO_EFFECT_CONSTELLATIONS``).
    c4_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: 'Harbinger of Dawn',
    weapon_refinement: 5,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Albedo's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: false,
    artifact_set: 'Husk',
    element: 'Geo',
    ascension_geo_damage_bonus: 0.288,
    // His skill's own coefficients (an ATK-scaling hit at cast, plus a
    // DEF-scaling term that ticks off-field every 2s afterward).
    skill_attack_mv: 2.35,
    skill_defense_mv: 2.40,
    c3_skill_attack_mv: 2.77,
    c3_skill_defense_mv: 2.84,
    // His own permanent quill on those same DEF-scaling ticks.
    quill_defense_percent: 2.40,
    c6_quill_defense_percent: 2.50,
    // C1: +50% DEF.
    c1_defense_percent: 0.50,
    // C2: an extra Burst-type hit plus a flat, unconditional teamwide EM buff.
    c2_burst_defense_mv: 3.00,
    c2_burst_hits: 3,
    c2_team_elemental_mastery: 125,
    // C6: a flat teamwide damage bonus.
    c6_team_damage_bonus_percent: 0.17,
    // His own kit's teamwide damage bonus (himself included), scaling off his
    // own final DEF -- 1% per 100 DEF, capped at 30%.
    team_damage_bonus_per_defense: 0.01,
    team_damage_bonus_defense_step: 100,
    team_damage_bonus_cap: 0.30,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 4,
    // Seconds on-field with neither Patrol Song nor C6, plus the two
    // conditional bonuses below.
    field_time_base: 1.5,
    field_time_patrol_song_bonus: 0.5,
    field_time_c6_bonus: 1.0,
  };

  /* Which of his c{n}_enabled fields carry no modelled damage effect. */
  static NO_EFFECT_CONSTELLATIONS = new Set([4, 5]);

  static WEAPONS = {
    'Harbinger of Dawn': {
      base_attack: 401, crit_rate: refinementScale(0.14, 0.28), crit_damage: 0.469, defense_percent: 0.0, damage_bonus: 0.0,
    },
    'Cinnabar Spindle': {
      base_attack: 454, crit_rate: 0.0, crit_damage: 0.0, defense_percent: 0.69, damage_bonus: 0.0,
      quill_defense_percent: refinementScale(0.40, 0.80),
    },
    // Patrol Song's own passive is a *second* teamwide dmg bonus (see
    // ``patrolSongTeamDamageBonus``) plus a DEF% bonus and a personal dmg
    // bonus layered onto its plain 82.7% DEF% substat.
    'Patrol Song': {
      base_attack: 542, crit_rate: 0.0, crit_damage: 0.0,
      defense_percent: refinementScale(0.827 + 0.08, 0.827 + 0.16),
      damage_bonus: refinementScale(0.10, 0.20),
    },
    Uraku: {
      base_attack: 542, crit_rate: 0.0, crit_damage: 0.882,
      defense_percent: refinementScale(0.20, 0.40), damage_bonus: 0.0,
      skill_damage_bonus: refinementScale(0.48, 0.96),
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = { 'Harbinger of Dawn': 5, 'Cinnabar Spindle': 5, 'Patrol Song': 1, Uraku: 1 };

  /* Patrol Song's rate (per 1000 final DEF) and cap, by refinement. */
  static PATROL_SONG_TEAM_DAMAGE_BONUS_RATE_PER_1000_DEF = refinementScale(0.08, 0.16);
  static PATROL_SONG_TEAM_DAMAGE_BONUS_CAP = refinementScale(0.256, 0.512);
  /* Real duration of Patrol Song's dmg bonus. */
  static PATROL_SONG_BUFF_DURATION = 15.0;

  postInit() {
    if (this.artifacts === null) this.artifacts = albedoArtifacts(this);
  }

  /* His base, plus Patrol Song's own bonus and/or C6's bonus. */
  get field_time() {
    let time = this.field_time_base;
    if (this.weapon === 'Patrol Song') time += this.field_time_patrol_song_bonus;
    if (this.c6_enabled) time += this.field_time_c6_bonus;
    return time;
  }

  get base_attack() {
    return statAtLevel(ALBEDO_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  get base_defense() {
    return statAtLevel(ALBEDO_BASE_DEFENSE_BY_LEVEL, this.character_level);
  }

  defensePercent() {
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifacts.defense_percent + this.weaponStats().defense_percent + artifactSet.two_piece_defense_percent
      + (this.c1_enabled ? this.c1_defense_percent : 0));
  }

  finalDefense() {
    return defense(this.base_defense, this.defensePercent(), this.artifacts.total.flat_defense);
  }

  /* His whole kit snapshots at his Skill cast, so every external team buff
   * here uses the SNAPSHOT query. */
  attackPercent(settings, artifactBuffs) {
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercentSnapshot('Albedo') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  finalAttack(settings, nicole, bennett, artifactBuffs, nicoleSnapshot = 0.0, bennettSnapshot = 0.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs),
      nicole.skillOnFieldAttack(nicoleSnapshot), bennett.teamAttackBuff(bennettSnapshot),
      artifacts.flat_attack);
  }

  /* His own kit's teamwide damage bonus -- 1% per 100 of his own final DEF,
   * capped at 30%. Full-uptime. */
  teamDamageBonus() {
    if (!this.team_buffs_enabled) return 0;
    return pyMin(div(this.finalDefense(), this.team_damage_bonus_defense_step) * this.team_damage_bonus_per_defense,
      this.team_damage_bonus_cap);
  }

  /* Patrol Song: a second, separate teamwide dmg bonus -- 8%-16% (by
   * refinement) per 1000 of his own final DEF, capped at 25.6%-51.2%. */
  patrolSongTeamDamageBonus() {
    if (!this.team_buffs_enabled || this.weapon !== 'Patrol Song') return 0;
    const rate = valueAtRefinement(Albedo.PATROL_SONG_TEAM_DAMAGE_BONUS_RATE_PER_1000_DEF, this.weapon_refinement);
    const cap = valueAtRefinement(Albedo.PATROL_SONG_TEAM_DAMAGE_BONUS_CAP, this.weapon_refinement);
    return pyMin(this.finalDefense() / 1000 * rate, cap);
  }

  c6TeamDamageBonus() {
    return this.team_buffs_enabled && this.c6_enabled ? this.c6_team_damage_bonus_percent : 0;
  }

  /* C2: a flat, unconditional teamwide EM buff. */
  teamElementalMasteryBonus(presentElements) {
    return this.team_buffs_enabled && this.c2_enabled ? this.c2_team_elemental_mastery : 0;
  }

  damage(settings, enemy, nicole, bennett, durin, artifactBuffs, sharedBonus, geoResistance, critRateBonus, critDamageBonus,
    nicoleSnapshot = 0.0, bennettSnapshot = 0.0, skillTicks = [], skillTime = 0.0, burstTime = 0.0) {
    // His whole kit snapshots at his Skill cast: attack, dmg%, crit, and
    // resistance are all locked once, and that one frozen multiplier stack
    // covers his whole kit -- including his off-field DEF-scaling ticks.
    const w = this.weaponStats();
    const finalAttack = this.finalAttack(settings, nicole, bennett, artifactBuffs, nicoleSnapshot, bennettSnapshot);
    const finalDefense = this.finalDefense();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    const critStats = [
      0.05 + w.crit_rate + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate + critRateBonus,
      0.5 + w.crit_damage + artifacts.crit_damage + critDamageBonus,
    ];
    const crit = expectedCritMultiplier(...critStats);
    // Husk's 4pc Geo DMG bonus is unconditional; Golden Troupe's Skill DMG
    // bonus and Uraku's +48% only touch his "skill"/"quill" entries.
    const bonus = (artifacts.geo_damage_bonus + artifactBuffs.elementalDamageBonusSnapshot('Geo', 'Albedo') + sharedBonus + w.damage_bonus
      + this.ascension_geo_damage_bonus + artifactSet.four_piece_geo_damage_bonus);
    const skillBonus = bonus + artifactSet.four_piece_skill_damage_bonus + (w.skill_damage_bonus ?? 0);
    const skillMultiplier = (1 + skillBonus) * crit * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(geoResistance);
    const burstMultiplier = (1 + bonus + artifactSet.two_piece_burst_damage_bonus) * crit * settings.defenseMultiplier(enemy, this.character_level)
      * resistanceMultiplier(geoResistance);
    const [skillAttackMv, skillDefenseMv] = this.c3_enabled
      ? [this.c3_skill_attack_mv, this.c3_skill_defense_mv] : [this.skill_attack_mv, this.skill_defense_mv];
    // His innate 240% DEF quill always applies; Cinnabar Spindle and C6 stack
    // additively alongside it, and each quill source procs once per tick.
    const quillPercent = this.quill_defense_percent + (w.quill_defense_percent ?? 0) + (this.c6_enabled ? this.c6_quill_defense_percent : 0);
    const tickCount = skillTicks.length;
    const skillAtkDamage = skillAttackMv * finalAttack * skillMultiplier;
    const skillDefPerTick = skillDefenseMv * finalDefense * skillMultiplier;
    const quillPerTick = quillPercent * finalDefense * skillMultiplier;
    const defHits = skillTicks.map((time) => new Hit('Albedo', hitSuffix('skill', tickCount), time, skillDefPerTick, ...critStats));
    const quillHits = skillTicks.map((time) => new Hit('Albedo', hitSuffix('quill', tickCount), time, quillPerTick, ...critStats));
    const skillDefTotal = skillDefPerTick * tickCount;
    const quillTotal = quillPerTick * tickCount;
    const result = new Map([['skill (1 hit)', skillAtkDamage]]);
    result.set(hitSuffix('skill', tickCount), skillDefTotal);
    result.set(hitSuffix('quill', tickCount), quillTotal);
    let ownHits = [new Hit('Albedo', 'skill (1 hit)', skillTime, skillAtkDamage, ...critStats), ...defHits, ...quillHits];
    if (this.c2_enabled) {
      const c2BurstTotal = this.c2_burst_defense_mv * finalDefense * burstMultiplier * this.c2_burst_hits;
      result.set('c2 burst', c2BurstTotal);
      const c2Hits = [];
      for (let i = 0; i < this.c2_burst_hits; i++) {
        c2Hits.push(new Hit('Albedo', 'c2 burst', burstTime, div(c2BurstTotal, this.c2_burst_hits), ...critStats));
      }
      ownHits = [...ownHits, ...c2Hits];
    }
    // Durin's C1 (and, at C6, Nicole's C4) quill lands on any of his hits.
    const quillBuckets = [[tickCount + 1, skillMultiplier]];
    if (this.c2_enabled) quillBuckets.push([this.c2_burst_hits, burstMultiplier]);
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Albedo', result, new Map(), ownHits);
  }
}
