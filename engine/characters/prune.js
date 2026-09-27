import { ARTIFACT_SETS } from '../artifacts.js';
import { DamageResult, Hit } from '../combat.js';
import {
  attack, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier, statAtLevel, transformativeDamage,
  weightedQuillMultiplier,
} from '../formulas.js';
import { div, pyFloorDiv, pyInt, pyIntValue, pyMax, pyMin, pyMod, pySumMap } from '../py.js';
import { absorbedElement } from '../rotation.js';
import { pruneArtifacts } from '../substats.js';
import { Character } from './base.js';

const PRUNE_BASE_ATTACK_BY_LEVEL = {
  10: 33.05, 20: 47.58, 30: 76.70, 40: 91.99, 50: 117.12, 60: 145.53, 70: 170.64, 80: 195.76, 90: 220.89, 95: 249.06, 100: 277.25,
};

export class Prune extends Character {
  static NAME = 'Prune';

  static DEFAULTS = {
    team_buffs_enabled: true,
    c2_enabled: true,
    c6_enabled: false,
    character_level: 90,
    weapon: 'Flowing Purity',
    weapon_refinement: 1,
    artifacts: null,
    substat_preset: 'KQM',
    artifact_set: 'Noblesse',
    element: 'Anemo',
    ascension_attack_percent: 0.24,
    hex_attack_percent: 0.6,
    // Activated by Venti's first skill for the on-field character.
    hex_onfield_attack_percent: 0.3,
    // C2: 20% ATK immediately once Hex is up, +10% more for every full
    // ``C2_RAMP_TICK_INTERVAL`` seconds elapsed since her Hex ticks start,
    // capping at ``C2_RAMP_MAX_STACKS`` stacks (40% total).
    c2_base_attack_percent: 0.2,
    c2_ramp_attack_percent_per_tick: 0.1,
    c6_flat_attack: 350,
    team_damage_bonus_attack_threshold: 2000,
    team_damage_bonus_per_attack: 0.00025,
    team_damage_bonus_cap: 0.5,
    // Team rotation position (2, 3, or 4 -- Venti is always slot 1).
    slot: 3,
    // Seconds Prune spends on-field during one full rotation.
    field_time: 2,
  };

  static C2_RAMP_TICK_INTERVAL = 2.0;
  static C2_RAMP_MAX_STACKS = 2;
  // Duration of her onfield ATK%/flat-ATK buffs to Venti, measured from the
  // start of his own arc every cycle -- 17s baseline, 21s once C6 extends it.
  static HEX_ONFIELD_BUFF_DURATION = 17.0;
  static HEX_ONFIELD_BUFF_DURATION_C6 = 21.0;

  static WEAPONS = {
    // Flowing Purity's passive isn't Hydro-specific, so it applies to any wielder.
    'Flowing Purity': { base_attack: 565, attack_percent: 0.276, damage_bonus: refinementScale(0.08, 0.16) },
    'Skyward Atlas': { base_attack: 674, attack_percent: 0.331, damage_bonus: refinementScale(0.12, 0.24) },
    // No attack%/damage bonus of its own -- see ``ttdsWielder``.
    TTDS: { base_attack: 401, attack_percent: 0.0, damage_bonus: 0.0 },
    'Favonius Codex': { base_attack: 510, attack_percent: 0.0, damage_bonus: 0.0 },
  };

  static WEAPON_DEFAULT_REFINEMENT = { 'Flowing Purity': 1, 'Skyward Atlas': 1, TTDS: 5, 'Favonius Codex': 1 };

  hexOnfieldBuffDuration() {
    return this.c6_enabled ? Prune.HEX_ONFIELD_BUFF_DURATION_C6 : Prune.HEX_ONFIELD_BUFF_DURATION;
  }

  /* Effective duration -- as measured from VENTI's own arc start -- of every
   * buff gated on Hex actually being up. All are really triggered back at HER
   * OWN arc, so whoever plays between them has already spent some of that
   * timer by the time Venti's arc starts. */
  atkBuffDuration(timeline) {
    if (!timeline.arc_start.has('Prune') || !timeline.arc_start.has('Venti')) return this.hexOnfieldBuffDuration();
    const gap = timeline.arc_start.get('Venti') - (timeline.arc_start.get('Prune') + timeline.field_time.get('Prune'));
    return pyMax(0.0, this.hexOnfieldBuffDuration() - gap);
  }

  get base_attack() {
    return statAtLevel(PRUNE_BASE_ATTACK_BY_LEVEL, this.character_level);
  }

  postInit() {
    if (this.artifacts === null) this.artifacts = pruneArtifacts(this);
  }

  /* 20% base once Hex is up, +10% more per full ``C2_RAMP_TICK_INTERVAL``
   * elapsed since her Hex ticks began. Negative elapsed gets 0 stacks; ``null``
   * (no real per-hit instant) uses the fully ramped value. */
  c2AttackPercentAt(elapsedSinceHexTicksStart) {
    if (!this.c2_enabled) return 0;
    let stacks;
    if (elapsedSinceHexTicksStart === null) stacks = Prune.C2_RAMP_MAX_STACKS;
    else {
      stacks = pyMin(Prune.C2_RAMP_MAX_STACKS,
        pyMax(0, pyInt(pyFloorDiv(elapsedSinceHexTicksStart, Prune.C2_RAMP_TICK_INTERVAL))));
    }
    return this.c2_base_attack_percent + stacks * this.c2_ramp_attack_percent_per_tick;
  }

  attackPercent(settings, artifactBuffs, absorptionActive, elapsedSinceHexTicksStart = null, hexWindowActive = true) {
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    // Both her Hex self-buff and her C2 ramp disappear along with the rest of
    // Hex when nobody present grants Venti's burst an absorption at all.
    const hexBonus = absorptionActive
      ? (this.hex_attack_percent * hexWindowActive + this.c2AttackPercentAt(elapsedSinceHexTicksStart))
      : 0;
    return (artifacts.attack_percent + this.ascension_attack_percent
      + artifactBuffs.teamAttackPercent('Prune') + artifactBuffs.weapon_team_attack_percent_others
      + hexBonus
      + settings.pyro_resonance_attack_percent
      + this.weaponStats().attack_percent
      + artifactSet.two_piece_attack_percent + artifactSet.four_piece_triggered_attack_percent);
  }

  attackForTeamBuff(settings, artifactBuffs, absorptionActive, elapsedSinceHexTicksStart = null, hexWindowActive = true) {
    return attack(this.base_attack, this.weaponStats().base_attack,
      this.attackPercent(settings, artifactBuffs, absorptionActive, elapsedSinceHexTicksStart, hexWindowActive),
      this.artifacts.total.flat_attack,
      pyIntValue(this.team_buffs_enabled && this.c6_enabled && absorptionActive && hexWindowActive ? this.c6_flat_attack : 0));
  }

  /* Bennett's team ATK buff is deliberately NOT baked in here -- it's an
   * on-field-only buff, so a caller adds it itself where that applies. */
  finalAttack(settings, nicole, artifactBuffs, absorptionActive, nicoleUptime = 1.0, elapsedSinceHexTicksStart = null, hexWindowActive = true) {
    return this.attackForTeamBuff(settings, artifactBuffs, absorptionActive, elapsedSinceHexTicksStart, hexWindowActive)
      + nicole.teamFlatAttack(settings, artifactBuffs, nicoleUptime);
  }

  /* ``attackForTeamBuff`` deliberately excludes every "stat-scaled" buff;
   * Nicole's C2 +300 flat ATK is the one exception, added back in here. The
   * whole bonus disappears when nobody grants Venti's burst an absorption. */
  teamDamageBonus(settings, nicole, artifactBuffs, absorptionActive, nicoleUptime = 1.0,
    elapsedSinceHexTicksStart = null, hexWindowActive = true) {
    if (!this.team_buffs_enabled || !absorptionActive) return 0;
    const attackForBonus = this.attackForTeamBuff(settings, artifactBuffs, absorptionActive, elapsedSinceHexTicksStart, hexWindowActive)
      + nicole.c2FlatAttackBonus() * nicoleUptime;
    return pyMin(pyMax(attackForBonus - this.team_damage_bonus_attack_threshold, 0)
      * this.team_damage_bonus_per_attack, this.team_damage_bonus_cap);
  }

  /* Point-in-time sibling of ``teamDamageBonus`` -- LIVE-tracks her own
   * attack (windowed Hex self-buff + C2 ramp) exactly as it stands at
   * ``instant``. Elapsed time is measured from her own Hex ticks' start (the
   * instant her own arc ends, recast every cycle). */
  teamDamageBonusAt(settings, nicole, artifactBuffs, absorptionActive, timeline, instant, nicoleUptime = 1.0) {
    if (!this.team_buffs_enabled || !absorptionActive || !timeline.arc_start.has('Prune')) return 0;
    const pruneTickStart = timeline.arc_start.get('Prune') + timeline.field_time.get('Prune');
    const elapsed = pyMod(instant - pruneTickStart, timeline.period);
    // ``atkBuffDuration`` already measures its own remaining lifespan from
    // Venti's arc start, so this must NOT also apply the cast-at-swap-out shift.
    const hexActive = timeline.activeAt('Venti', this.atkBuffDuration(timeline), instant, false);
    return this.teamDamageBonus(settings, nicole, artifactBuffs, absorptionActive, nicoleUptime, elapsed, hexActive);
  }

  damage(settings, enemy, nicole, bennett, faruzan, durin, artifactBuffs, timeline, skillBuffs, burstBuffs, swirlBonus,
    absorptionSource, anemoTicks = [], absorbedTicks = [], skillTime = 0.0, burstTime = 0.0) {
    // Her entire kit runs on Hex, which only exists once Venti's burst has an
    // element to absorb.
    const absorptionActive = absorptionSource !== null;
    const artifacts = this.artifacts.total;
    const artifactSet = ARTIFACT_SETS[this.artifact_set];
    const defenseSlot = settings.defenseMultiplier(enemy, this.character_level);
    const weaponDamageBonus = this.weaponStats().damage_bonus;
    const noblesseBurstBonus = artifactSet.two_piece_burst_damage_bonus;

    // Her Hex self-buffs share the exact same activation window as the copy
    // she grants Venti -- gated on VENTI's own presence.
    const hexWindowActive = (instant) => timeline.activeAt('Venti', this.atkBuffDuration(timeline), instant, false);

    // Her Hex ticks start the instant her own arc ends (``burstTime``), so
    // elapsed time for her C2 ramp is measured from there.
    const hitFinalAttack = (buffs, instant) => this.finalAttack(settings, nicole, artifactBuffs, absorptionActive, buffs.nicole_uptime,
      instant - burstTime, hexWindowActive(instant));

    // Nicole's on-field ATK and Bennett's team ATK buff are both
    // on-field-only -- added for her skill/burst 1 only.
    const onFieldAttack = (buffs, instant) => hitFinalAttack(buffs, instant) + nicole.skillOnFieldAttack(buffs.nicole_uptime)
      + bennett.teamAttackBuff(buffs.bennett_uptime);

    // Faruzan's C6 crit damage bonus is Anemo-only.
    const anemoCritStats = (buffs) => [
      0.05 + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate + buffs.crit_rate_bonus,
      0.5 + artifacts.crit_damage + faruzan.critDamageBonus(buffs.faruzan_uptime) + buffs.crit_damage_bonus,
    ];

    const anemoCrit = (buffs) => expectedCritMultiplier(...anemoCritStats(buffs));

    const anemoBonus = (buffs) => (buffs.elemental_damage_bonus + buffs.shared_bonus + weaponDamageBonus + artifactSet.two_piece_anemo_damage_bonus
      + faruzan.anemoDamageBonus(buffs.faruzan_uptime) + durin.pyroAnemoDamageBonus());

    // Burst 3 (her absorbed-element ticks) imbues whichever element Venti's
    // burst absorbs, exactly like his own burst 2.
    const sourceElement = absorbedElement(absorptionSource);

    const offFieldAttackAt = (buffs, time) => hitFinalAttack(buffs, time) + nicole.teamWideFlatAttack(buffs.nicole_uptime);

    const anemoTickDamage = (time, buffs) => {
      const offFieldAttack = offFieldAttackAt(buffs, time);
      return 1.497 * offFieldAttack * defenseSlot * anemoCrit(buffs) * (1 + anemoBonus(buffs) + noblesseBurstBonus) * resistanceMultiplier(buffs.resistance);
    };

    const absorbedTickCritStats = (buffs) => [
      0.05 + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate + buffs.crit_rate_bonus,
      0.5 + artifacts.crit_damage + buffs.crit_damage_bonus,
    ];

    const absorbedTickDamage = (time, buffs) => {
      const offFieldAttack = offFieldAttackAt(buffs, time);
      const crit = expectedCritMultiplier(...absorbedTickCritStats(buffs));
      let bonus;
      if (sourceElement === 'Electro' || sourceElement === 'Hydro') bonus = buffs.elemental_damage_bonus + buffs.shared_bonus;
      else {
        bonus = buffs.elemental_damage_bonus + noblesseBurstBonus + buffs.shared_bonus + weaponDamageBonus
          + bennett.pyroDamageBonus(buffs.bennett_uptime) + durin.pyroAnemoDamageBonus();
      }
      return 1.5 * offFieldAttack * defenseSlot * crit * (1 + bonus) * resistanceMultiplier(buffs.resistance);
    };

    const anemoTickHits = anemoTicks.map(([time, buffs]) => new Hit('Prune', 'burst 2', time, anemoTickDamage(time, buffs), ...anemoCritStats(buffs)));
    const absorbedTickHits = absorbedTicks.map(([time, buffs]) => new Hit('Prune', 'burst 3', time, absorbedTickDamage(time, buffs), ...absorbedTickCritStats(buffs)));
    // ``absorbedTicks`` is already empty when nobody grants an absorption at
    // all, so swirl/burst 3 zero out together with it automatically.
    const lastAbsorbedResistance = absorbedTicks.length ? absorbedTicks[absorbedTicks.length - 1][1].resistance : 0.0;
    const swirlResistanceMultiplier = resistanceMultiplier(lastAbsorbedResistance);
    const swirlEm = artifacts.elemental_mastery + artifactBuffs.teamElementalMastery('Prune');
    // Golden Troupe's Skill DMG bonus only ever touches her own "skill" entry.
    const skillBonus = artifactSet.four_piece_skill_damage_bonus;
    const skillMultiplier = defenseSlot * anemoCrit(skillBuffs);
    const burst1Multiplier = defenseSlot * anemoCrit(burstBuffs);
    const skillDamage = 2.846 * onFieldAttack(skillBuffs, skillTime) * skillMultiplier * (1 + anemoBonus(skillBuffs) + skillBonus) * resistanceMultiplier(skillBuffs.resistance);
    const burst1Damage = 2.06 * onFieldAttack(burstBuffs, burstTime) * burst1Multiplier * (1 + anemoBonus(burstBuffs) + noblesseBurstBonus) * resistanceMultiplier(burstBuffs.resistance);
    const swirlTotal = transformativeDamage(swirlEm, swirlResistanceMultiplier, settings.reactionMultiplier(this.character_level)) * 6 * (1 + swirlBonus) * absorptionActive;
    const swirlCount = absorptionActive ? 6 : 0;
    const result = new Map([['skill', skillDamage], ['burst 1', burst1Damage]]);
    result.set(hitSuffix('burst 2', anemoTickHits.length), pySumMap(anemoTickHits, (hit) => hit.damage));
    result.set(hitSuffix('burst 3', absorbedTickHits.length), pySumMap(absorbedTickHits, (hit) => hit.damage));
    result.set('swirl (6 hits)', swirlTotal);
    const ownHits = [
      new Hit('Prune', 'skill', skillTime, skillDamage, ...anemoCritStats(skillBuffs)),
      new Hit('Prune', 'burst 1', burstTime, burst1Damage, ...anemoCritStats(burstBuffs)),
    ];
    if (swirlCount) {
      for (let i = 0; i < swirlCount; i++) ownHits.push(new Hit('Prune', 'swirl', burstTime, div(swirlTotal, swirlCount)));
    }
    // Quills landing on her off-field ticks use the AVERAGE of each tick's own
    // "rest of scaling". Strips BOTH the motion value and the tick's own
    // attack -- a quill's flat bonus already carries its own attack term.
    const restOfScaling = (damageFn, time, buffs, motionValue) => div(damageFn(time, buffs), motionValue * offFieldAttackAt(buffs, time));

    const skillRest = skillMultiplier * resistanceMultiplier(skillBuffs.resistance);
    const burst1Rest = burst1Multiplier * resistanceMultiplier(burstBuffs.resistance);
    const anemoOffFieldRest = anemoTicks.length
      ? div(pySumMap(anemoTicks, ([t, b]) => restOfScaling(anemoTickDamage, t, b, 1.497)), anemoTicks.length) : 0;
    const absorbedRest = absorbedTicks.length
      ? div(pySumMap(absorbedTicks, ([t, b]) => restOfScaling(absorbedTickDamage, t, b, 1.5)), absorbedTicks.length) : 0;
    const quillBuckets = [
      [1, skillRest * (1 + anemoBonus(skillBuffs) + skillBonus)],
      [1, burst1Rest * (1 + anemoBonus(burstBuffs) + noblesseBurstBonus)],
      [anemoTickHits.length, anemoOffFieldRest],
      // Empty (not just zero damage) when burst 3 doesn't fire at all.
      [absorbedTickHits.length, absorbedRest],
    ];
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    if (nicole.team_buffs_enabled && nicole.c4_enabled && nicole.c6_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(quillBuckets));
    }
    return new DamageResult('Prune', result, new Map(), [...anemoTickHits, ...absorbedTickHits, ...ownHits]);
  }
}
