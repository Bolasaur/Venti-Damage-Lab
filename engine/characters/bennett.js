import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import { attack, expectedCritMultiplier, refinementScale, resistanceMultiplier, statAtLevel, weightedQuillMultiplier } from '../formulas.js';
import { bennettArtifacts } from '../substats.js';
import { Character } from './base.js';

const BENNETT_BASE_ATTACK_BY_LEVEL = {
  10: 28.60, 20: 41.17, 30: 66.38, 40: 79.61, 50: 101.35, 60: 125.94, 70: 147.67, 80: 169.41, 90: 191.16, 95: 215.53, 100: 239.93,
};

/* Bennett's build, plus the on-field ATK buff his build provides. */
export class Bennett extends Character {
  static NAME = 'Bennett';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c1_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: 'Aquila',
    weapon_refinement: 1,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Bennett's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: false,
    artifact_set: 'Noblesse',
    element: 'Pyro',
    c6_pyro_damage_bonus: 0.15,
    // Priority for granting Venti's burst an elemental absorption. Lower wins.
    absorption_priority: 4,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 2,
    // Seconds Bennett spends on-field during one full rotation.
    field_time: 2,
  };

  /* Real duration of his field ATK buff and C6 Pyro bonus alike. */
  static BUFF_DURATION = 14.0;

  static WEAPONS = {
    Aquila: { base_attack: 674, attack_percent: refinementScale(0.20, 0.40), crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0 },
    'Skyward Sword': { base_attack: 608, attack_percent: 0.0, crit_rate: refinementScale(0.04, 0.08), crit_damage: 0.0, damage_bonus: 0.0 },
    // No change across refinements.
    'Sapwood Blade': { base_attack: 565, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0 },
    'Favonius Sword': { base_attack: 454, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0 },
    Mistsplitter: {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.441, damage_bonus: refinementScale(0.28, 0.56),
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = { Aquila: 1, 'Skyward Sword': 1, 'Sapwood Blade': 1, 'Favonius Sword': 1, Mistsplitter: 1 };

  get base_attack() {
    return statAtLevel(BENNETT_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = bennettArtifacts(this);
  }

  attackPercent(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercent('Bennett') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + w.attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  teamAttackBuffPercent() {
    if (this.c5_enabled) return 1.39;
    if (this.c1_enabled) return 1.21;
    return 1.01;
  }

  /* Flat ATK Bennett grants a recipient, scaled off his own base ATK
   * (character + weapon base) -- 101% at C0, 121% at C1, 139% at C5.
   * ``uptime`` is the recipient's own real uptime on his 14s window. */
  teamAttackBuff(uptime) {
    if (!this.team_buffs_enabled) return 0;
    return this.teamAttackBuffPercent() * (this.base_attack + this.weaponStats().base_attack) * uptime;
  }

  /* C6: a flat Pyro damage bonus, same 14s window as ``teamAttackBuff``. */
  pyroDamageBonus(uptime) {
    if (!(this.team_buffs_enabled && this.c6_enabled)) return 0;
    return this.c6_pyro_damage_bonus * uptime;
  }

  finalAttack(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs), this.teamAttackBuff(1.0), artifacts.flat_attack);
  }

  damage(settings, enemy, nicole, durin, artifactBuffs, skillBuffs, burstBuffs, skillTime = 0.0, burstTime = 0.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    const finalAttack = this.finalAttack(settings, artifactBuffs);

    // Rising Winds' 20% crit rate doesn't trigger for Bennett.
    const critStats = (buffs) => [
      0.05 + w.crit_rate + artifacts.crit_rate + buffs.crit_rate_bonus,
      0.5 + w.crit_damage + artifacts.crit_damage + buffs.crit_damage_bonus,
    ];

    const hitMultiplier = (buffs) => settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(buffs.resistance)
      * expectedCritMultiplier(...critStats(buffs));

    const hitBonus = (buffs) => buffs.elemental_damage_bonus + buffs.shared_bonus + durin.pyroAnemoDamageBonus() + w.damage_bonus;

    // Nicole's 300 on-field ATK applies to both Bennett's skill and his burst.
    const onFieldAttack = (buffs) => finalAttack + nicole.skillOnFieldAttack(buffs.nicole_uptime);

    // Golden Troupe's Skill DMG bonus only ever touches his "skill" entry.
    const skillBonus = artifactSet.four_piece_skill_damage_bonus;
    const skillMultiplier = hitMultiplier(skillBuffs);
    const burstMultiplier = hitMultiplier(burstBuffs);
    const skillDamage = 2.34 * onFieldAttack(skillBuffs) * (1 + hitBonus(skillBuffs) + skillBonus) * skillMultiplier;
    const burstDamage = 4.95 * onFieldAttack(burstBuffs) * (1 + hitBonus(burstBuffs) + artifactSet.two_piece_burst_damage_bonus) * burstMultiplier;
    const result = new Map([['skill', skillDamage], ['burst', burstDamage]]);
    const hits = [
      new Hit('Bennett', 'skill', skillTime, skillDamage, ...critStats(skillBuffs)),
      new Hit('Bennett', 'burst', burstTime, burstDamage, ...critStats(burstBuffs)),
    ];
    // Durin's C1 (and, at C6, Nicole's C4) quill lands on any of his hits.
    const quillBuckets = [
      [1, skillMultiplier * (1 + hitBonus(skillBuffs) + skillBonus)],
      [1, burstMultiplier * (1 + hitBonus(burstBuffs) + artifactSet.two_piece_burst_damage_bonus)],
    ];
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, this, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Bennett', result, new Map(), hits);
  }
}
