import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import { attack, expectedCritMultiplier, refinementScale, resistanceMultiplier, statAtLevel, weightedQuillMultiplier } from '../formulas.js';
import { pyMin } from '../py.js';
import { nicoleArtifacts } from '../substats.js';
import { Character } from './base.js';

const NICOLE_BASE_ATTACK_BY_LEVEL = {
  10: 47.85, 20: 69.07, 30: 114.70, 40: 137.51, 50: 176.87, 60: 221.87, 70: 261.68, 80: 301.76, 90: 342.03, 95: 380.50, 100: 418.98,
};

/* Nicole's build, plus the buffs her build provides to the roster. */
export class Nicole extends Character {
  static NAME = 'Nicole';

  static DEFAULTS = {
    team_buffs_enabled: true,
    // Toggle off to remove her own burst's motion value and the 4 projection
    // ticks per cast it grants the team; her C1 projections are unaffected.
    burst_enabled: true,
    c1_enabled: false,
    c2_enabled: false,
    c3_enabled: false,
    c4_enabled: false,
    c5_enabled: false,
    c6_enabled: false,
    weapon: 'Flowing Purity',
    weapon_refinement: 1,
    character_level: 90,
    artifacts: null,
    substat_preset: 'KQM',
    artifact_set: 'Celestial Gift',
    element: 'Pyro',
    ascension_attack_percent: 0.288,
    team_attack_scaling: 0.15,
    team_flat_attack_cap: 600,
    on_field_flat_attack: 300,
    // C1: 3 extra projections per burst cast. Unaffected by ``burst_enabled``.
    c1_projection_mv: 6.0,
    c1_projection_hits: 3,
    // C2: raises the team_flat_attack range from 0-600 to 300-900, plus a
    // shred -- Anemo and Pyro RES at C2, every element once C6 widens it.
    c2_team_attack_bonus: 300,
    c2_resistance_shred: 0.25,
    // C3: raises team_flat_attack's cap/ratio and her own skill's motion value.
    c3_team_attack_scaling: 0.177,
    c3_team_flat_attack_cap: 708,
    c3_skill_mv: 2.914,
    // C4: a quill landing on any non-swirl hit -- Venti-only below C6; at C6
    // it reaches every other present character too.
    c4_quill_percent: 0.70,
    c4_quill_hits: 8,
    // C5: raises the projection's Venti-attack coefficient and her burst MV.
    c5_projection_attack_mv: 2.124,
    c5_burst_mv: 6.732,
    // C6: the on-field-only 300 flat ATK becomes team-wide, and the whole team
    // ignores a fraction of enemy defense.
    c6_defense_ignore: 0.40,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 2,
    // Seconds on-field with no burst cast at all.
    field_time_base: 1,
    // Casting her burst adds this many seconds on top of the base.
    field_time_burst_bonus: 2,
  };

  /* Real duration of every one of Nicole's own team-wide buffs. */
  static BUFF_DURATION = 20.0;

  static WEAPONS = {
    Angelos: {
      base_attack: 741, attack_percent: refinementScale(0.285, 0.405), damage_bonus: 0.0,
      team_damage_bonus: refinementScale(0.26, 0.58),
    },
    'Flowing Purity': { base_attack: 565, attack_percent: 0.276, damage_bonus: refinementScale(0.08, 0.16), team_damage_bonus: 0.0 },
    'Skyward Atlas': { base_attack: 674, attack_percent: 0.331, damage_bonus: refinementScale(0.12, 0.24), team_damage_bonus: 0.0 },
    // No attack%/damage bonus of its own -- see ``ttdsWielder`` for its
    // Venti-only passive.
    TTDS: { base_attack: 401, attack_percent: 0.0, damage_bonus: 0.0, team_damage_bonus: 0.0 },
  };

  static WEAPON_DEFAULT_REFINEMENT = { Angelos: 1, 'Flowing Purity': 1, 'Skyward Atlas': 1, TTDS: 5 };

  /* Seconds Nicole spends on-field during one full rotation: the base plus
   * her burst bonus, only while ``burst_enabled``. */
  get field_time() {
    return this.field_time_base + (this.burst_enabled ? this.field_time_burst_bonus : 0);
  }

  get base_attack() {
    return statAtLevel(NICOLE_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = nicoleArtifacts(this);
  }

  attackPercent(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    return (artifactBuffs.teamAttackPercent('Nicole') + artifactBuffs.weapon_team_attack_percent_others
      + artifacts.attack_percent + w.attack_percent + this.ascension_attack_percent + settings.pyro_resonance_attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  attackForTeamBuff(settings, artifactBuffs) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs), artifacts.flat_attack);
  }

  /* The scaled 0-600/708 portion AND C2's own +300 -- both unconditional/
   * team-wide, unlike ``on_field_flat_attack``'s own 300, which is
   * on-field-gated (see ``skillOnFieldAttack``/``teamWideFlatAttack``). The
   * scaled portion is a "stat-scaled buff", so it's excluded from anything
   * that scales off attack in turn; C2's +300 is not, so it's added here.
   * ``uptime`` is the recipient's own real timeline uptime on her 20s window. */
  teamFlatAttack(settings, artifactBuffs, uptime) {
    if (!this.team_buffs_enabled) return 0;
    const scaling = this.c3_enabled ? this.c3_team_attack_scaling : this.team_attack_scaling;
    const cap = this.c3_enabled ? this.c3_team_flat_attack_cap : this.team_flat_attack_cap;
    const base = pyMin(this.attackForTeamBuff(settings, artifactBuffs) * scaling, cap);
    return (base + this.c2FlatAttackBonus()) * uptime;
  }

  /* C2's +300 flat ATK -- NOT a stat-scaled buff, so Prune's dmg% bonus does
   * consider it. */
  c2FlatAttackBonus() {
    return this.team_buffs_enabled && this.c2_enabled ? this.c2_team_attack_bonus : 0;
  }

  /* C2's RES shred against ``element`` -- Anemo and Pyro at C2; every element
   * once C6 widens its scope (Physical stays untouched). */
  resistanceShred(element) {
    if (!(this.team_buffs_enabled && this.c2_enabled)) return 0;
    if (this.c6_enabled || element === 'Anemo' || element === 'Pyro') return this.c2_resistance_shred;
    return 0;
  }

  /* C6's teamwide defense ignore. */
  defenseIgnore() {
    return this.team_buffs_enabled && this.c6_enabled ? this.c6_defense_ignore : 0;
  }

  /* C6: the previously on-field-only 300 flat ATK now reaches everyone. */
  teamWideFlatAttack(uptime) {
    return this.team_buffs_enabled && this.c6_enabled ? this.on_field_flat_attack * uptime : 0;
  }

  /* Outside C6, the 300 flat ATK applies to Venti's whole rotation and, for
   * anyone else, to their skill cast plus the "initial" hit(s) of their burst
   * -- not their other hits, which only get it via ``teamWideFlatAttack``. */
  skillOnFieldAttack(uptime) {
    return this.team_buffs_enabled ? this.on_field_flat_attack * uptime : 0;
  }

  /* ``nicoleUptime`` is the RECIPIENT's own uptime on Nicole's kit -- callers
   * computing Nicole's own attack for their OWN formula use the default 1.0.
   * ``bennettUptimeToNicole`` likewise defaults to 1.0 outside her own
   * ``damage`` (a documented simplification). */
  finalAttack(settings, bennett, artifactBuffs, nicoleUptime = 1.0, bennettUptimeToNicole = 1.0) {
    const w = this.weaponStats();
    const artifacts = this.artifacts.total;
    return attack(this.base_attack, w.base_attack, this.attackPercent(settings, artifactBuffs),
      this.teamFlatAttack(settings, artifactBuffs, nicoleUptime), this.skillOnFieldAttack(nicoleUptime),
      bennett.teamAttackBuff(bennettUptimeToNicole), artifacts.flat_attack);
  }

  c4QuillBonus(settings, bennett, artifactBuffs) {
    if (!(this.team_buffs_enabled && this.c4_enabled)) return 0;
    return this.c4_quill_percent * this.finalAttack(settings, bennett, artifactBuffs);
  }

  damage(settings, enemy, bennett, durin, artifactBuffs, skillBuffs, burstBuffs, skillTime = 0.0, burstTime = 0.0) {
    const w = this.weaponStats();
    const artifactSet = ARTIFACT_SETS[this.artifact_set];

    const critStats = (buffs) => [0.05 + artifactSet.four_piece_triggered_crit_rate + buffs.crit_rate_bonus, 0.72 + buffs.crit_damage_bonus];

    const hitMultiplier = (buffs) => settings.defenseMultiplier(enemy, this.character_level) * resistanceMultiplier(buffs.resistance)
      * expectedCritMultiplier(...critStats(buffs));

    const hitBonus = (buffs) => buffs.elemental_damage_bonus + w.damage_bonus + buffs.shared_bonus
      + bennett.pyroDamageBonus(buffs.bennett_uptime) + durin.pyroAnemoDamageBonus();

    const skillMv = this.c3_enabled ? this.c3_skill_mv : 2.491;
    const burstMv = this.c5_enabled ? this.c5_burst_mv : 5.702;
    // Nicole's own skill is excluded from her stat-scaled buffs (team flat
    // ATK, on-field flat ATK, Bennett's buff); her burst uses her full attack.
    const skillAttack = this.attackForTeamBuff(settings, artifactBuffs);
    // Golden Troupe's Skill DMG bonus only ever touches her own "skill" entry.
    const skillBonus = artifactSet.four_piece_skill_damage_bonus;
    const skillMultiplier = hitMultiplier(skillBuffs);
    const skillDamage = skillMv * skillAttack * (1 + hitBonus(skillBuffs) + skillBonus) * skillMultiplier;
    const result = new Map([['skill', skillDamage]]);
    const hits = [new Hit('Nicole', 'skill', skillTime, skillDamage, ...critStats(skillBuffs))];
    const burstMultiplier = hitMultiplier(burstBuffs);
    if (this.burst_enabled) {
      const burstAttack = this.finalAttack(settings, bennett, artifactBuffs, 1.0, burstBuffs.bennett_uptime);
      const burstDamage = burstMv * burstAttack * (1 + hitBonus(burstBuffs) + artifactSet.two_piece_burst_damage_bonus) * burstMultiplier;
      result.set('burst', burstDamage);
      hits.push(new Hit('Nicole', 'burst', burstTime, burstDamage, ...critStats(burstBuffs)));
    }
    // Durin's C1 quill lands on any of Nicole's hits -- her own independent
    // pool of procs.
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      const quillBuckets = [[1, skillMultiplier * (1 + hitBonus(skillBuffs) + skillBonus)]];
      if (this.burst_enabled) {
        quillBuckets.push([1, burstMultiplier * (1 + hitBonus(burstBuffs) + artifactSet.two_piece_burst_damage_bonus)]);
      }
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, this, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Nicole', result, new Map(), hits);
  }
}
