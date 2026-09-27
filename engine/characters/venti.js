import { ARTIFACT_SETS } from '../artifacts.js';
import { attack, expectedCritMultiplier, refinementScale, statAtLevel } from '../formulas.js';
import { pyIntValue, pyMin } from '../py.js';
import { ventiArtifacts } from '../substats.js';
import { Character } from './base.js';

const VENTI_BASE_ATTACK_BY_LEVEL = {
  10: 36.81, 20: 53.13, 30: 88.23, 40: 105.78, 50: 136.05, 60: 170.67, 70: 201.30, 80: 232.12, 90: 263.10, 95: 292.69, 100: 322.29,
};

export class Venti extends Character {
  static NAME = 'Venti';

  static DEFAULTS = {
    c1_enabled: true,
    c2_enabled: true,
    c3_enabled: false,
    c4_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: 'Daybreak Chronicles',
    // One of ``WEAPON_REFINEMENTS``.
    weapon_refinement: 1,
    // One of the eleven levels in ``CHARACTER_LEVELS``.
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    // Whether Venti's circlet main stat is Crit DMG (true) or Crit Rate (false).
    circlet_crit_damage: true,
    artifact_set: 'Rising Winds',
    element: 'Anemo',
    hex_damage_bonus: 0.5,
    c2_resistance_shred: 0.24,
    c6_resistance_shred: 0.2,
    c6_crit_damage: 1.0,
    c4_anemo_damage_bonus: 0.25,
    // Seconds on-field in one rotation.
    field_time: 13.0,
  };

  /* Every entry carries the same key set even when a given weapon's own
   * effect doesn't touch one -- ``damage``/``attackPercent`` read every key
   * unconditionally. ``skill_damage_bonus`` (Polar Star) folds into both skill
   * entries and burst 1/2. ``attack_percent_per_anemo``/``_cap`` (First Great
   * Magic) scale with however many Anemo characters are on the team. */
  static WEAPONS = {
    Rust: {
      base_attack: 510, attack_percent: 0.413, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0,
      normal_attack_bonus: refinementScale(0.40, 0.80), has_harp_trigger: false, burst_damage_bonus: 0.0,
      skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'Daybreak Chronicles': {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.442,
      damage_bonus: refinementScale(0.60, 1.20), normal_attack_bonus: 0.0, has_harp_trigger: false,
      burst_damage_bonus: 0.0, skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'Skyward Harp': {
      base_attack: 674, attack_percent: 0.0, crit_rate: 0.221, crit_damage: refinementScale(0.20, 0.40),
      damage_bonus: 0.0, normal_attack_bonus: 0.0, has_harp_trigger: true, burst_damage_bonus: 0.0,
      skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'Crimson Plumage': {
      base_attack: 608, attack_percent: refinementScale(0.24, 0.48), crit_rate: 0.0, crit_damage: 0.662,
      damage_bonus: 0.0, normal_attack_bonus: 0.0, has_harp_trigger: false,
      burst_damage_bonus: refinementScale(0.10, 0.20), skill_damage_bonus: 0.0,
      attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    // F2P (3-star, craftable).
    Slingshot: {
      base_attack: 354, attack_percent: 0.0, crit_rate: 0.312, crit_damage: 0.0, damage_bonus: 0.0,
      normal_attack_bonus: refinementScale(0.36, 0.60), has_harp_trigger: false, burst_damage_bonus: 0.0,
      skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    // Standard-banner 5-star -- untracked cost.
    "Amos' Bow": {
      base_attack: 608, attack_percent: 0.496, crit_rate: 0.0, crit_damage: 0.0, damage_bonus: 0.0,
      normal_attack_bonus: refinementScale(0.20, 0.40), has_harp_trigger: false, burst_damage_bonus: 0.0,
      skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'Aqua Simulacra': {
      base_attack: 542, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.882,
      damage_bonus: refinementScale(0.20, 0.40), normal_attack_bonus: 0.0, has_harp_trigger: false,
      burst_damage_bonus: 0.0, skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    "Hunter's Path": {
      base_attack: 542, attack_percent: 0.0, crit_rate: 0.441, crit_damage: 0.0,
      damage_bonus: refinementScale(0.12, 0.24), normal_attack_bonus: 0.0, has_harp_trigger: false,
      burst_damage_bonus: 0.0, skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'First Great Magic': {
      base_attack: 608, attack_percent: 0.0, crit_rate: 0.0, crit_damage: 0.662, damage_bonus: 0.0,
      normal_attack_bonus: 0.0, has_harp_trigger: false, burst_damage_bonus: 0.0, skill_damage_bonus: 0.0,
      attack_percent_per_anemo: refinementScale(0.16, 0.32), attack_percent_per_anemo_cap: refinementScale(0.48, 0.96),
    },
    'Thundering Pulse': {
      base_attack: 608, attack_percent: refinementScale(0.20, 0.40), crit_rate: 0.0, crit_damage: 0.662,
      damage_bonus: 0.0, normal_attack_bonus: refinementScale(0.40, 0.80), has_harp_trigger: false,
      burst_damage_bonus: 0.0, skill_damage_bonus: 0.0, attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
    'Polar Star': {
      base_attack: 608, attack_percent: refinementScale(0.30, 0.60), crit_rate: 0.331, crit_damage: 0.0,
      damage_bonus: 0.0, normal_attack_bonus: 0.0, has_harp_trigger: false, burst_damage_bonus: 0.0,
      skill_damage_bonus: refinementScale(0.12, 0.24), attack_percent_per_anemo: 0.0, attack_percent_per_anemo_cap: 0.0,
    },
  };

  static WEAPON_DEFAULT_REFINEMENT = {
    Rust: 5, 'Daybreak Chronicles': 1, 'Skyward Harp': 1, 'Crimson Plumage': 1, Slingshot: 5, "Amos' Bow": 1,
    'Aqua Simulacra': 1, "Hunter's Path": 1, 'First Great Magic': 1, 'Thundering Pulse': 1, 'Polar Star': 1,
  };

  get base_attack() {
    return statAtLevel(VENTI_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = ventiArtifacts(this);
  }

  /* ``activated`` is whether Venti's first (activation) skill hit has already
   * landed -- it gates his own kit (Rising Winds' 4pc, Tenacity's
   * activation-gated case). ``pruneActive`` is whether Prune's Hex is up for
   * him. ``externalAttackPercent`` is every OTHER character's team ATK%
   * already resolved to this hit's own tick. */
  attackPercent(settings, prune, artifactBuffs, activated, pruneActive, anemoCharacterCount = 0, externalAttackPercent = 0.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const risingWinds = ARTIFACT_SETS[this.artifact_set];
    return (artifacts.attack_percent + risingWinds.two_piece_attack_percent
      + (activated ? risingWinds.four_piece_triggered_attack_percent : 0)
      // Tenacity's 4pc only needs Venti's own activation event when Faruzan's
      // C6 is the sole eligible source.
      + ((!artifactBuffs.tenacity_requires_activation || activated) ? artifactBuffs.tenacity_attack_percent : 0)
      + artifactBuffs.weapon_team_attack_percent_others
      + externalAttackPercent
      + (prune.team_buffs_enabled && pruneActive ? prune.hex_onfield_attack_percent : 0)
      + settings.pyro_resonance_attack_percent
      + w.attack_percent
      + pyMin(w.attack_percent_per_anemo * anemoCharacterCount, w.attack_percent_per_anemo_cap));
  }

  finalAttack(settings, nicole, prune, bennett, artifactBuffs, activated, pruneActive, anemoCharacterCount = 0,
    externalAttackPercent = 0.0, nicoleUptime = 1.0, bennettUptime = 1.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack,
      this.attackPercent(settings, prune, artifactBuffs, activated, pruneActive, anemoCharacterCount, externalAttackPercent),
      nicole.teamFlatAttack(settings, artifactBuffs, nicoleUptime) + nicole.skillOnFieldAttack(nicoleUptime)
        + bennett.teamAttackBuff(bennettUptime),
      pyIntValue(prune.team_buffs_enabled && prune.c6_enabled && pruneActive ? prune.c6_flat_attack : 0),
      artifacts.flat_attack);
  }

  critStats(activated, extraCritDamage = 0, extraCritRate = 0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const risingWinds = ARTIFACT_SETS[this.artifact_set];
    return [
      0.05 + w.crit_rate + artifacts.crit_rate + extraCritRate + (activated ? risingWinds.four_piece_triggered_crit_rate : 0),
      0.5 + w.crit_damage + artifacts.crit_damage + (this.c6_enabled ? this.c6_crit_damage : 0) + extraCritDamage,
    ];
  }

  critMultiplier(activated, extraCritDamage = 0, extraCritRate = 0) {
    return expectedCritMultiplier(...this.critStats(activated, extraCritDamage, extraCritRate));
  }
}
