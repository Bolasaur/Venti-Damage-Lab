import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import { attack, expectedCritMultiplier, hitSuffix, resistanceMultiplier, statAtLevel, weightedQuillMultiplier } from '../formulas.js';
import { div, pySum, pySumMap } from '../py.js';
import { monaArtifacts } from '../substats.js';
import { Character } from './base.js';

const MONA_BASE_ATTACK_BY_LEVEL = {
  10: 40.15, 20: 57.96, 30: 96.25, 40: 115.39, 50: 148.42, 60: 186.19, 70: 219.59, 80: 253.23, 90: 287.01, 95: 319.30, 100: 351.59,
};

/* Mona's build, plus the team-wide buffs her kit provides. Her own on-field
 * sequence is fixed -- skill, burst, then a normal string through the 4th hit
 * -- for one combo per team rotation. Her dmg bonus and C4 crit buffs last
 * 11s, propagated from her own slot like every other real-duration buff. */
export class Mona extends Character {
  static NAME = 'Mona';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c1_enabled: false,
    c2_enabled: false,
    c3_enabled: false,
    c4_enabled: false,
    weapon: 'Lost Prayer',
    weapon_refinement: 1,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Mona's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: false,
    artifact_set: 'Celestial Gift',
    element: 'Hydro',
    hydro_damage_bonus_percent: 0.10,
    // Motion values for her fixed "eq n4" sequence: 3 skill ticks plus a
    // finale, one burst hit, and four individual normal-attack hits.
    skill_tick_mv: 0.576,
    skill_tick_count: 3,
    skill_finale_mv: 2.39,
    burst_mv: 7.96,
    c3_burst_mv: 9.40,
    normal_mvs: [0.526, 0.504, 0.627, 0.78],
    // 60% teamwide damage bonus (all elements alike), partial uptime.
    team_damage_bonus_percent: 0.60,
    // C1: teamwide swirl DMG bonus (any character's swirls).
    c1_swirl_damage_bonus: 0.15,
    // C2: teamwide EM buff, unconditional.
    c2_team_elemental_mastery: 80,
    // C4: teamwide crit rate/crit dmg buff, same partial uptime as her dmg bonus.
    c4_team_crit_rate: 0.15,
    c4_team_crit_damage: 0.15,
    // Priority for granting Venti's burst an elemental absorption. Lower wins.
    absorption_priority: 3,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 2,
    // Seconds Mona spends on-field during one full rotation.
    field_time: 4,
  };

  /* Real duration of her dmg bonus and C4 crit rate/dmg buffs. */
  static BUFF_DURATION = 11.0;

  static WEAPONS = {
    // No change across refinements.
    'Lost Prayer': { base_attack: 608, attack_percent: 0.0, crit_rate: 0.331, damage_bonus: 0.0 },
    // No attack%/damage bonus of its own -- see ``ttdsWielder``.
    TTDS: { base_attack: 401, attack_percent: 0.0, crit_rate: 0.0, damage_bonus: 0.0 },
    'Favonius Codex': { base_attack: 510, attack_percent: 0.0, crit_rate: 0.0, damage_bonus: 0.0 },
  };

  static WEAPON_DEFAULT_REFINEMENT = { 'Lost Prayer': 1, TTDS: 5, 'Favonius Codex': 1 };

  get base_attack() {
    return statAtLevel(MONA_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = monaArtifacts(this);
  }

  attackPercent(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercent('Mona') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + w.attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  /* Bennett's team ATK buff is deliberately NOT baked in here -- it's
   * on-field-only, so a caller adds it itself where that applies. */
  finalAttack(settings, nicole, artifactBuffs, nicoleUptime = 1.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs),
      nicole.teamFlatAttack(settings, artifactBuffs, nicoleUptime), artifacts.flat_attack);
  }

  /* 60% teamwide damage bonus. ``uptime`` is the recipient's own real uptime
   * on her 11s window. */
  teamDamageBonus(uptime = 1.0) {
    return this.team_buffs_enabled ? this.team_damage_bonus_percent * uptime : 0;
  }

  /* C1: teamwide swirl DMG bonus. */
  swirlDamageBonus() {
    return this.team_buffs_enabled && this.c1_enabled ? this.c1_swirl_damage_bonus : 0;
  }

  /* C2: teamwide EM buff, unconditional on team composition. */
  teamElementalMasteryBonus(presentElements) {
    return this.team_buffs_enabled && this.c2_enabled ? this.c2_team_elemental_mastery : 0;
  }

  /* C4: teamwide crit rate buff, same window as her dmg bonus. */
  teamCritRateBonus(uptime = 1.0) {
    return this.team_buffs_enabled && this.c4_enabled ? this.c4_team_crit_rate * uptime : 0;
  }

  /* C4: teamwide crit dmg buff, same window as her dmg bonus. */
  teamCritDamageBonus(uptime = 1.0) {
    return this.team_buffs_enabled && this.c4_enabled ? this.c4_team_crit_damage * uptime : 0;
  }

  damage(settings, enemy, nicole, bennett, durin, artifactBuffs, onFieldBuffs, skillTicks = [], burstTime = 0.0) {
    // Her burst + normal-attack string is her one on-field instant; her Skill
    // is an off-field ticking ability -- 3 ticks plus a finale, once every 2s
    // starting when she leaves the field.
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];

    const hitFinalAttack = (buffs) => this.finalAttack(settings, nicole, artifactBuffs, buffs.nicole_uptime);

    // Nicole's on-field ATK and Bennett's team ATK buff are both
    // on-field-only -- deliberately absent from ``tickAttack`` below.
    const onFieldAttack = (buffs) => hitFinalAttack(buffs) + nicole.skillOnFieldAttack(buffs.nicole_uptime) + bennett.teamAttackBuff(buffs.bennett_uptime);

    const tickAttack = (buffs) => hitFinalAttack(buffs) + nicole.teamWideFlatAttack(buffs.nicole_uptime);

    const critStats = (buffs) => [
      0.05 + this.weaponStats().crit_rate + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate + buffs.crit_rate_bonus,
      0.5 + artifacts.crit_damage + buffs.crit_damage_bonus,
    ];

    const hitCrit = (buffs) => expectedCritMultiplier(...critStats(buffs));

    const hitBonus = (buffs) => buffs.elemental_damage_bonus + buffs.shared_bonus + this.weaponStats().damage_bonus + this.hydro_damage_bonus_percent;

    const plainMultiplier = (buffs) => (1 + hitBonus(buffs)) * hitCrit(buffs) * settings.defenseMultiplier(enemy, this.character_level)
      * resistanceMultiplier(buffs.resistance);

    const burstMv = this.c3_enabled ? this.c3_burst_mv : this.burst_mv;
    const burstMultiplier = (1 + hitBonus(onFieldBuffs) + artifactSet.two_piece_burst_damage_bonus) * hitCrit(onFieldBuffs)
      * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(onFieldBuffs.resistance);
    const normalsMultiplier = plainMultiplier(onFieldBuffs);
    const burstDamage = burstMv * onFieldAttack(onFieldBuffs) * burstMultiplier;
    const normalsDamage = pySum(this.normal_mvs) * onFieldAttack(onFieldBuffs) * normalsMultiplier;

    // Golden Troupe's Skill DMG bonus only touches her "skill" entry.
    const skillTickMultiplier = (buffs) => (1 + hitBonus(buffs) + artifactSet.four_piece_skill_damage_bonus) * hitCrit(buffs)
      * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(buffs.resistance);

    const skillMvs = [...Array(this.skill_tick_count).fill(this.skill_tick_mv), this.skill_finale_mv];
    const pairCount = Math.min(skillMvs.length, skillTicks.length);
    const skillHits = [];
    for (let i = 0; i < pairCount; i++) {
      const mv = skillMvs[i];
      const [time, buffs] = skillTicks[i];
      skillHits.push(new Hit('Mona', 'skill', time, mv * tickAttack(buffs) * skillTickMultiplier(buffs), ...critStats(buffs)));
    }
    const skillDamage = pySumMap(skillHits, (hit) => hit.damage);
    const result = new Map([[hitSuffix('skill', skillHits.length), skillDamage]]);
    result.set('burst', burstDamage);
    result.set('normals (4 hits)', normalsDamage);
    const ownHits = [new Hit('Mona', 'burst', burstTime, burstDamage, ...critStats(onFieldBuffs))];
    for (let i = 0; i < this.normal_mvs.length; i++) {
      ownHits.push(new Hit('Mona', 'normals', burstTime, div(normalsDamage, this.normal_mvs.length), ...critStats(onFieldBuffs)));
    }
    // Durin's C1 (and, at C6, Nicole's C4) quill lands on any of Mona's hits.
    // The skill bucket averages each real tick's own multiplier.
    const averageSkillMultiplier = skillTicks.length
      ? div(pySumMap(skillTicks, ([, buffs]) => skillTickMultiplier(buffs)), skillTicks.length) : 0;
    const quillBuckets = [
      [skillTicks.length, averageSkillMultiplier],
      [this.normal_mvs.length, normalsMultiplier],
      [1, burstMultiplier],
    ];
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Mona', result, new Map(), [...skillHits, ...ownHits]);
  }
}
