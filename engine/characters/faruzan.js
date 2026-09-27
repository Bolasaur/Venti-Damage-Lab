import { ARTIFACT_SETS, ELEGY_FULL_UPTIME_ROTATION_LENGTH } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import {
  attack, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier, statAtLevel, transformativeDamage,
  weightedQuillMultiplier,
} from '../formulas.js';
import { div, pyMin, pySumMap } from '../py.js';
import { faruzanArtifacts } from '../substats.js';
import { Character } from './base.js';

const FARUZAN_BASE_ATTACK_BY_LEVEL = {
  10: 29.57, 20: 42.32, 30: 68.22, 40: 81.82, 50: 104.17, 60: 129.43, 70: 151.77, 80: 174.12, 90: 196.47, 95: 221.52, 100: 246.59,
};

/* Faruzan's build, plus the team-wide buffs and Venti-only quill her kit
 * provides. The quill is resolved in ``VentiRotation.damage``. */
export class Faruzan extends Character {
  static NAME = 'Faruzan';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c2_enabled: false,
    c3_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: 'Favonius Bow',
    weapon_refinement: 1,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Faruzan's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: false,
    artifact_set: 'Tenacity',
    element: 'Anemo',
    ascension_attack_percent: 0.24,
    anemo_resistance_shred: 0.30,
    anemo_damage_bonus_percent: 0.324,
    c5_anemo_damage_bonus_percent: 0.383,
    c6_crit_damage_bonus: 0.40,
    quill_percent: 0.32,
    // A quill every 0.8s over her buff duration -- 16/0.8 = 20 exactly;
    // 22/0.8 = 27.5, floored to 27.
    quill_hits_base: 20,
    quill_hits_c2: 27,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 2,
    // Seconds Faruzan spends on-field during one full rotation.
    field_time: 2,
  };

  /* Real duration of her dmg bonus/resistance shred/C6 crit dmg (all share
   * one window) -- 22s once C2 extends it. */
  static BUFF_DURATION = 16.0;
  static C2_BUFF_DURATION = 22.0;

  static WEAPONS = {
    // No change across refinements.
    'Favonius Bow': { base_attack: 454, attack_percent: 0.0, elemental_mastery: 0.0 },
    'Elegy for the End': {
      base_attack: 608, attack_percent: 0.0, elemental_mastery: refinementScale(60.0, 120.0),
      team_attack_percent: refinementScale(0.20, 0.40), team_elemental_mastery: refinementScale(100.0, 200.0),
      team_buff_uptime: 0.5, team_buff_full_uptime_rotation_length: ELEGY_FULL_UPTIME_ROTATION_LENGTH,
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = { 'Favonius Bow': 1, 'Elegy for the End': 1 };

  get buff_duration() {
    return this.c2_enabled ? Faruzan.C2_BUFF_DURATION : Faruzan.BUFF_DURATION;
  }

  get base_attack() {
    return statAtLevel(FARUZAN_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = faruzanArtifacts(this);
  }

  attackPercent(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercent('Faruzan') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + w.attack_percent + this.ascension_attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  finalAttack(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs), artifacts.flat_attack);
  }

  elementalMastery(artifactBuffs) {
    return this.artifacts.total.elemental_mastery + this.weaponStats().elemental_mastery + artifactBuffs.teamElementalMastery('Faruzan');
  }

  /* ``uptime`` is the recipient's own real uptime on her 16s/22s window --
   * always 1.0 for her own hits. */
  anemoDamageBonus(uptime = 1.0) {
    if (!this.team_buffs_enabled) return 0;
    return (this.c5_enabled ? this.c5_anemo_damage_bonus_percent : this.anemo_damage_bonus_percent) * uptime;
  }

  critDamageBonus(uptime = 1.0) {
    return this.team_buffs_enabled && this.c6_enabled ? this.c6_crit_damage_bonus * uptime : 0;
  }

  /* Raw (un-scaled) shred value -- ``Team.damageResults`` applies the real
   * per-recipient uptime. */
  resistanceShred() {
    return this.team_buffs_enabled ? this.anemo_resistance_shred : 0;
  }

  quillHits() {
    return this.c2_enabled ? this.quill_hits_c2 : this.quill_hits_base;
  }

  /* Flat bonus damage added to one Venti Anemo hit, before that hit's own
   * multiplier stack. */
  quillBonus() {
    return this.team_buffs_enabled ? this.quill_percent * this.base_attack : 0;
  }

  damage(settings, enemy, nicole, bennett, durin, artifactBuffs, skillBuffs, burstBuffs, swirlBonus, absorptionSource,
    c6Ticks = [], skillTime = 0.0, burstTime = 0.0) {
    const absorptionActive = absorptionSource !== null;
    const finalAttack = this.finalAttack(settings, artifactBuffs);
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];

    // Nicole's 300 on-field ATK and Bennett's team ATK buff both apply to
    // Faruzan's skill and her burst (genuinely on-field hits).
    const onFieldAttack = (buffs) => finalAttack + nicole.skillOnFieldAttack(buffs.nicole_uptime) + bennett.teamAttackBuff(buffs.bennett_uptime);

    const hitBonus = (buffs) => (artifacts.anemo_damage_bonus + buffs.elemental_damage_bonus + buffs.shared_bonus + artifactSet.two_piece_anemo_damage_bonus
      + this.anemoDamageBonus() + durin.pyroAnemoDamageBonus());

    // Rising Winds' 20% crit rate doesn't trigger for Faruzan either.
    const critStats = (buffs) => [
      0.05 + artifacts.crit_rate + buffs.crit_rate_bonus,
      0.5 + artifacts.crit_damage + this.critDamageBonus() + buffs.crit_damage_bonus,
    ];

    const hitCrit = (buffs) => expectedCritMultiplier(...critStats(buffs));

    const plainMultiplier = (buffs) => (1 + hitBonus(buffs)) * hitCrit(buffs) * settings.defenseMultiplier(enemy, this.character_level)
      * resistanceMultiplier(buffs.resistance);

    // Golden Troupe's Skill DMG bonus only touches her "skill" entry; Noblesse's
    // 2pc only touches "burst".
    const skillMultiplier = (1 + hitBonus(skillBuffs) + artifactSet.four_piece_skill_damage_bonus) * hitCrit(skillBuffs)
      * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(skillBuffs.resistance);
    const burstMultiplier = (1 + hitBonus(burstBuffs) + artifactSet.two_piece_burst_damage_bonus) * hitCrit(burstBuffs)
      * settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(burstBuffs.resistance);
    const skillMv = this.c3_enabled ? 3.162 : 2.76;
    const burstMv = this.c5_enabled ? 8.024 : 6.797;
    const skillDamage = skillMv * onFieldAttack(skillBuffs) * skillMultiplier;
    const burstDamage = burstMv * onFieldAttack(burstBuffs) * burstMultiplier;
    const result = new Map([['skill', skillDamage], ['burst', burstDamage]]);
    let ownHits = [
      new Hit('Faruzan', 'skill', skillTime, skillDamage, ...critStats(skillBuffs)),
      new Hit('Faruzan', 'burst', burstTime, burstDamage, ...critStats(burstBuffs)),
    ];
    let c6Hits = [];
    if (this.c6_enabled) {
      // Her C6 hits trigger alongside Venti's own field time (1 every 3s),
      // each reading whatever's actually active at its own instant.
      c6Hits = c6Ticks.map(([time, buffs]) => new Hit('Faruzan', 'c6 hit', time,
        2.295 * (finalAttack + nicole.teamWideFlatAttack(buffs.nicole_uptime)) * plainMultiplier(buffs), ...critStats(buffs)));
      result.set(hitSuffix('c6 hit', c6Hits.length), pySumMap(c6Hits, (hit) => hit.damage));
      // Every swirl spreads whichever element Venti's burst actually absorbs;
      // zeroed entirely when nobody present grants one. Uses the last C6
      // tick's own resistance for that element.
      const swirlResistanceMultiplier = c6Ticks.length
        ? resistanceMultiplier(c6Ticks[c6Ticks.length - 1][1].resistance) : resistanceMultiplier(0.0);
      const c6SwirlTotal = transformativeDamage(this.elementalMastery(artifactBuffs), swirlResistanceMultiplier,
        settings.reactionMultiplier(this.character_level)) * 4 * (1 + swirlBonus) * absorptionActive;
      result.set('c6 swirl (4 hits)', c6SwirlTotal);
      if (absorptionActive) {
        const count = pyMin(4, c6Ticks.length);
        const swirls = [];
        for (let i = 0; i < count; i++) swirls.push(new Hit('Faruzan', 'c6 swirl', c6Ticks[i][0], div(c6SwirlTotal, 4)));
        ownHits = [...ownHits, ...swirls];
      }
    }
    // Durin's C1 (and, at C6, Nicole's C4) quill lands on any of Faruzan's
    // (non-transformative) hits. The C6 bucket averages each tick's multiplier.
    const quillBuckets = [[1, skillMultiplier], [1, burstMultiplier]];
    if (this.c6_enabled && c6Ticks.length) {
      const averageC6Multiplier = div(pySumMap(c6Ticks, ([, buffs]) => plainMultiplier(buffs)), c6Ticks.length);
      quillBuckets.push([c6Ticks.length, averageC6Multiplier]);
    }
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Faruzan', result, new Map(), [...c6Hits, ...ownHits]);
  }
}
