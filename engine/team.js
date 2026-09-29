/* Team cost bookkeeping, the ``Team`` orchestrator (resolves every
 * character's buffs/damage together for one rotation), and the default
 * character roster/selection. */
import { ANGELOS_BUFF_DURATION, ARTIFACT_SETS, resolveTeamArtifactBuffs } from './artifacts.js';
import { Albedo } from './characters/albedo.js';
import { Bennett } from './characters/bennett.js';
import { Durin } from './characters/durin.js';
import { Faruzan } from './characters/faruzan.js';
import { Fischl } from './characters/fischl.js';
import { Mona } from './characters/mona.js';
import { Nicole } from './characters/nicole.js';
import { Prune } from './characters/prune.js';
import { Venti } from './characters/venti.js';
import { DamageResult, Enemy, Hit, HitBuffs, TeamSettings } from './combat.js';
import { effectiveRotationLength, expectedCritMultiplier, hitSuffix, resistanceMultiplier, slotOf } from './formulas.js';
import { KeyError, ValueError, pyFloorDiv, pyInt, pyMax, pyMod, pyRepr, pySumMap, pyTupleRepr } from './py.js';
import {
  VV_BUFF_DURATION, VentiRotation, absorbedElement, ventiAbsorptionSource, ventiEffectiveBurstCasts, ventiEffectiveSkillCasts,
  ventiNotationSlots, vvShredTarget,
} from './rotation.js';
import { RotationTimeline } from './timeline.js';

/* Team "cost" is a separate bookkeeping concept from damage -- purely a count
 * of how many notionally-expensive pulls/investments a team represents. A
 * character contributes its base cost (if any) once for being on the team,
 * plus one per constellation level actually enabled, plus one per refinement
 * of a cost-bearing weapon. Mona has no base cost, and her constellations
 * don't add cost either. */
export const TEAM_COST_BASE_CHARACTERS = new Set(['Venti', 'Nicole', 'Durin', 'Albedo']);
/* Which constellation levels count for each character; Albedo's C1 is
 * intentionally excluded even though C2-C6 all count. */
export const TEAM_COST_CONSTELLATIONS = {
  Venti: [1, 2, 3, 4, 5, 6],
  Nicole: [1, 2, 3, 4, 5, 6],
  Durin: [1, 2, 3, 4, 5, 6],
  Albedo: [2, 3, 4, 5, 6],
};
export const TEAM_COST_WEAPONS = new Set([
  'Daybreak Chronicles', 'Angelos', 'Athame', 'Elegy for the End', 'Uraku', 'Patrol Song', 'Haran', 'Crimson Plumage',
  'Aqua Simulacra', "Hunter's Path", 'First Great Magic', 'Thundering Pulse', 'Polar Star',
  'Jade Cutter', 'Mistsplitter', 'Azurelight', 'Absolution',
]);

/* Nicole's projections are "nondescript" real-time ticks landing on whoever's
 * actually on-field. */
export const ELEMENT_DAMAGE_BONUS_FIELD = {
  Anemo: 'anemo_damage_bonus', Pyro: 'pyro_damage_bonus', Electro: 'electro_damage_bonus', Hydro: 'hydro_damage_bonus', Geo: 'geo_damage_bonus',
};
const NICOLE_PROJECTION_TICK_INTERVAL = 3.0;
const NICOLE_C1_PROJECTION_TICK_INTERVAL = 6.0;

/* A character's own base crit stats -- the same generic formula the UI's own
 * stat panel uses, reused for Nicole's projections. */
export function personalCritStats(character) {
  const weapon = character.weaponStats();
  const artifacts = character.artifacts.total;
  const artifactSet = ARTIFACT_SETS[character.artifact_set];
  const critRate = 0.05 + (weapon.crit_rate ?? 0) + artifacts.crit_rate + artifactSet.four_piece_triggered_crit_rate;
  const critDamage = 0.5 + (weapon.crit_damage ?? 0) + artifacts.crit_damage + (character.ascension_crit_damage ?? 0);
  return [critRate, critDamage];
}

/* A team of 1-4 characters. ``member_names`` lists who is actually in the
 * party; anyone else's build objects are only kept around as buff-neutral
 * stand-ins (``team_buffs_enabled = false``) so the present characters'
 * formulae have something to call. */
export class Team {
  constructor(settings, enemy, memberNames, nicole, durin, prune, venti, bennett, faruzan, fischl, mona, albedo,
    ventiRotation = new VentiRotation(), { bennettAbsorptionEligible = true } = {}) {
    this.settings = settings;
    this.enemy = enemy;
    this.member_names = memberNames;
    this.nicole = nicole;
    this.durin = durin;
    this.prune = prune;
    this.venti = venti;
    this.bennett = bennett;
    this.faruzan = faruzan;
    this.fischl = fischl;
    this.mona = mona;
    this.albedo = albedo;
    this.venti_rotation = ventiRotation;
    // See ``ventiAbsorptionSource`` -- false drops Bennett from consideration
    // for granting Venti's burst an absorption entirely.
    this.bennett_absorption_eligible = bennettAbsorptionEligible;
    this._byName = {
      Venti: venti, Nicole: nicole, Durin: durin, Prune: prune, Bennett: bennett, Faruzan: faruzan, Fischl: fischl, Mona: mona, Albedo: albedo,
    };
  }

  character(name) {
    if (!Object.prototype.hasOwnProperty.call(this._byName, name)) throw new KeyError(pyRepr(name));
    return this._byName[name];
  }

  /* How many present characters (wielder included) are Anemo. */
  anemoCharacterCount() {
    return this.member_names.filter((name) => this.character(name).element === 'Anemo').length;
  }

  /* Anemo Resonance needs Venti plus at least one other Anemo character. */
  anemoResonanceActive() {
    return this.anemoCharacterCount() >= 2;
  }

  /* This team's total "cost". A cost-bearing weapon costs one point per
   * refinement (R3 costs 3). */
  cost() {
    let total = 0;
    for (const name of this.member_names) {
      const character = this.character(name);
      if (TEAM_COST_BASE_CHARACTERS.has(name)) total += 1;
      for (const level of TEAM_COST_CONSTELLATIONS[name] ?? []) {
        if (character[`c${level}_enabled`] ?? false) total += 1;
      }
      if (TEAM_COST_WEAPONS.has(character.weapon)) total += character.weapon_refinement;
    }
    return total;
  }

  /* Total rotation time: the sum of each present character's own
   * ``field_time``, floored via ``effectiveRotationLength`` -- the same
   * helper ``RotationTimeline.build`` uses for its own ``period``. */
  rotationLength() {
    return effectiveRotationLength(pySumMap(this.member_names, (name) => this.character(name).field_time),
      this.member_names.includes('Faruzan'),
      this.member_names.includes('Prune') || this.member_names.includes('Durin'),
      this.anemoResonanceActive());
  }

  _validateSlots() {
    const slots = this.member_names.map((name) => slotOf(this.character(name)));
    if (new Set(slots).size !== slots.length) {
      throw new ValueError(`Duplicate team slot(s) assigned among ${pyTupleRepr(this.member_names)}: ${pyRepr(slots)}`);
    }
  }

  damageResults() {
    this._validateSlots();
    // Nicole's C6 defense-ignore and Durin's C6 defense-reduction are resolved
    // once here. Pyro elemental resonance only applies with two-plus Pyro
    // characters present.
    const pyroCount = this.member_names.filter((name) => this.character(name).element === 'Pyro').length;
    const settings = this.settings.replace({
      defense_ignore: this.nicole.defenseIgnore(),
      defense_reduction: this.durin.defenseReduction(),
      pyro_resonance_attack_percent: pyroCount >= 2 ? this.settings.pyro_resonance_attack_percent : 0,
    });
    const anemoResonanceActive = this.anemoResonanceActive();
    const presentCharacters = this.member_names.map((name) => this.character(name));
    const absorptionSource = ventiAbsorptionSource(this.fischl, this.durin, this.mona, this.bennett,
      { bennettEligible: this.bennett_absorption_eligible });
    const absorptionActive = absorptionSource !== null;
    const timeline = RotationTimeline.build(this.member_names, (name) => this.character(name));
    // When each present character's own on-field arc ends -- off-field
    // ticking abilities start counting from here.
    const arcEnd = new Map(timeline.order.map((name) => [name, timeline.arc_start.get(name) + timeline.field_time.get(name)]));
    const artifactBuffs = resolveTeamArtifactBuffs(presentCharacters, this.rotationLength(), timeline, absorptionActive);

    // Durin's shred and Venti's C2/C6 shreds are permanent; Faruzan's,
    // Nicole's C2, and VV's are real-duration and only apply to a given hit
    // while genuinely active at that hit's own tick.
    const durinShred = this.durin.team_buffs_enabled ? this.durin.team_resistance_shred : 0;
    const ventiC2Shred = this.venti.c2_enabled ? this.venti.c2_resistance_shred : 0;
    const ventiC6Shred = this.venti.c6_enabled ? this.venti.c6_resistance_shred : 0;
    const faruzanShredRaw = this.faruzan.resistanceShred();
    const faruzanShredDuration = this.faruzan.buff_duration;
    const nicoleShredRaw = {};
    for (const element of ['Anemo', 'Pyro', 'Electro', 'Hydro', 'Geo']) nicoleShredRaw[element] = this.nicole.resistanceShred(element);
    const [vvWearer, vvElement] = vvShredTarget(presentCharacters);
    // Physical RES has only one (permanent) shred source.
    const physicalResistance = this.enemy.physical_resistance - ventiC2Shred;
    const angelosRaw = this.nicole.team_buffs_enabled ? this.nicole.weaponStats().team_damage_bonus : 0;
    // Mona's C1 (any character's swirl) is unlisted (full, unconditional).
    const swirlBonus = this.mona.swirlDamageBonus();

    // The single buff-membership primitive the whole tick engine uses.
    const uptimeAt = (source, duration, instant, castAtSwapOut = true) => Number(timeline.recastActiveAt(source, duration, instant, castAtSwapOut));

    // Nicole's own kit buffs are the one exception to the default swap-out
    // cast -- they stay (re)cast at the start of HER OWN arc.
    const resistanceAt = (element, instant) => {
      let value = this.enemy.base_resistance - nicoleShredRaw[element] * uptimeAt('Nicole', Nicole.BUFF_DURATION, instant, false);
      if (element !== 'Hydro') value -= durinShred;
      if (element === 'Anemo' || element === 'Pyro') value -= ventiC6Shred;
      if (element === 'Anemo') {
        value -= ventiC2Shred;
        value -= faruzanShredRaw * uptimeAt('Faruzan', faruzanShredDuration, instant);
      }
      if (vvWearer !== null && element === vvElement && absorptionActive) {
        value -= ARTIFACT_SETS.VV.four_piece_absorption_resistance_shred * uptimeAt(vvWearer, VV_BUFF_DURATION, instant);
      }
      return value;
    };

    const sharedBonusAt = (instant, angelosTier = 1.0, excludePruneBonus = false) => {
      const monaBonus = this.mona.teamDamageBonus(uptimeAt('Mona', Mona.BUFF_DURATION, instant));
      const patrolSong = this.albedo.patrolSongTeamDamageBonus() * uptimeAt('Albedo', Albedo.PATROL_SONG_BUFF_DURATION, instant);
      const angelos = angelosRaw * uptimeAt('Nicole', ANGELOS_BUFF_DURATION, instant, false) * angelosTier;
      // Prune's dynamic team DMG bonus reaches every present teammate through
      // this one shared resolver -- ``excludePruneBonus`` is set only for
      // hits that must not receive it.
      const pruneBonus = excludePruneBonus ? 0.0 : this.prune.teamDamageBonusAt(
        settings, this.nicole, artifactBuffs, absorptionActive, timeline, instant);
      return (artifactBuffs.scrollDamageBonusAt(instant) + monaBonus + patrolSong
        + this.albedo.teamDamageBonus() + this.albedo.c6TeamDamageBonus() + angelos + pruneBonus);
    };

    const critRateBonusAt = (instant) => this.mona.teamCritRateBonus(uptimeAt('Mona', Mona.BUFF_DURATION, instant));

    const critDamageBonusAt = (instant) => this.mona.teamCritDamageBonus(uptimeAt('Mona', Mona.BUFF_DURATION, instant));

    /* Every external, time-varying value one individual hit sees, evaluated
     * AT ITS OWN TICK. */
    const buffsAt = (element, instant, angelosTier = 1.0, excludePruneBonus = false) => new HitBuffs({
      elemental_damage_bonus: artifactBuffs.elementalDamageBonusAt(element, instant),
      shared_bonus: sharedBonusAt(instant, angelosTier, excludePruneBonus),
      nicole_uptime: uptimeAt('Nicole', Nicole.BUFF_DURATION, instant, false),
      bennett_uptime: uptimeAt('Bennett', Bennett.BUFF_DURATION, instant),
      faruzan_uptime: uptimeAt('Faruzan', this.faruzan.buff_duration, instant),
      crit_rate_bonus: critRateBonusAt(instant),
      crit_damage_bonus: critDamageBonusAt(instant),
      resistance: resistanceAt(element, instant),
      external_attack_percent: artifactBuffs.teamAttackPercentExcludingTenacityAt(instant),
    });

    /* ``count`` individually-timestamped ``[time, HitBuffs]`` pairs. */
    const hitSeries = (element, start, cadence, count, angelosTier = 1.0, excludePruneBonus = false) => {
      const series = [];
      for (let i = 0; i < count; i++) series.push([start + i * cadence, buffsAt(element, start + i * cadence, angelosTier, excludePruneBonus)]);
      return series;
    };

    const tickTimes = (start, cadence, count) => {
      const times = [];
      for (let i = 0; i < count; i++) times.push(start + i * cadence);
      return times;
    };

    const parsedRotation = this.venti_rotation.parse();
    const anemoCharacterCount = this.anemoCharacterCount();
    const effectiveSkillCasts = ventiEffectiveSkillCasts(parsedRotation.skill_casts, anemoResonanceActive, this.venti.c2_enabled);
    const effectiveBurstCasts = ventiEffectiveBurstCasts(parsedRotation.burst_casts);
    // Prune's absorbed-element ticks and Venti's own burst 2/swirl need the
    // actually-absorbed element.
    const absorbedBurstElement = { Electro: 'Electro', Hydro: 'Hydro' }[absorbedElement(absorptionSource)] ?? 'Pyro';
    const [pruneAnemoTickCount, prunePyroTickCount] = this.prune.c6_enabled ? [8, 6] : [7, 5];
    const fischlPrimaryHits = this.fischl.c6_enabled ? this.fischl.c6_oz_primary_hits : 10;

    /* (skillTime, burstTime) for a non-Venti character's own on-field arc --
     * skill at the first second, burst at the arc end. */
    const onFieldTimes = (name) => [timeline.arc_start.get(name) + 1, arcEnd.get(name)];

    // Off-field ticking abilities: start/cadence/count per ability, each tick
    // resolving buffs at its own real instant. Faruzan's C6 triggers
    // alongside VENTI's arc start.
    const durinFrontSeries = arcEnd.has('Durin') ? hitSeries('Pyro', arcEnd.get('Durin'), 1.0, 10, 0.5) : [];
    const durinBackSeries = arcEnd.has('Durin') ? hitSeries('Pyro', arcEnd.get('Durin') + 10.0, 1.0, 10, 0.5) : [];
    const monaSkillSeries = arcEnd.has('Mona') ? hitSeries('Hydro', arcEnd.get('Mona'), 2.0, 4, 0.5) : [];
    const pruneAnemoSeries = arcEnd.has('Prune') ? hitSeries('Anemo', arcEnd.get('Prune'), 2.0, pruneAnemoTickCount, 0.5, true) : [];
    const prunePyroSeries = arcEnd.has('Prune') ? hitSeries(absorbedBurstElement, arcEnd.get('Prune'), 2.0, prunePyroTickCount, 0.5, true) : [];
    const faruzanC6Series = hitSeries('Anemo', timeline.arc_start.get('Venti'), 3.0, 6, 1.0);

    // Venti's own on-field hit sequence is timed directly off his notation,
    // spread evenly across (field_time - 2) seconds, starting 2s into his
    // field time (right where his burst also begins).
    const ventiSlots = ventiNotationSlots(parsedRotation.token_order, effectiveSkillCasts);
    const nonActivationLabels = ventiSlots.filter((label) => label !== 'activation');
    const ventiSlotCount = nonActivationLabels.length;
    const ventiBurstStart = timeline.arc_start.get('Venti') + VentiRotation.BURST_START_OFFSET;
    const ventiAvailable = pyMax(timeline.field_time.get('Venti') - VentiRotation.BURST_START_OFFSET, 0.0);
    const ventiSlotCadence = ventiSlotCount > 1 ? ventiAvailable / (ventiSlotCount - 1) : 0.0;
    const ventiSlotTimes = tickTimes(ventiBurstStart, ventiSlotCadence, ventiSlotCount);
    const ventiSlotSeries = ventiSlotTimes.map((time) => [time, buffsAt('Anemo', time, 1.0)]);

    // Fischl's tertiary (C6 coordinated attack) hits land alongside Venti's
    // own normal-attack hits -- one per arrow.
    const fischlTertiaryTimes = [];
    nonActivationLabels.forEach((label, index) => {
      if (label.startsWith('normal')) {
        const position = Number(label.slice(6)) - 1;
        for (let i = 0; i < VentiRotation.NORMAL_ARROW_COUNTS[position]; i++) fischlTertiaryTimes.push(ventiSlotTimes[index]);
      }
    });
    // Fischl's secondary hits land alongside Venti's own burst-2 hits.
    const fischlSecondaryCount = pyInt(effectiveBurstCasts * this.venti_rotation.burst_second_hits_per_cast * absorptionActive);
    const fischlSecondaryCadence = fischlSecondaryCount ? VentiRotation.BURST_DURATION / fischlSecondaryCount : 0.0;
    const fischlSecondaryTimes = tickTimes(ventiBurstStart, fischlSecondaryCadence, fischlSecondaryCount);
    const fischlPrimaryTimes = arcEnd.has('Fischl') ? tickTimes(timeline.arc_start.get('Fischl'), 1.0, fischlPrimaryHits) : [];

    // Albedo's DEF-scaling skill hits/quill tick off-field every 2 seconds for
    // the rest of the rotation after he leaves the field.
    const albedoTickCount = arcEnd.has('Albedo') ? pyInt(pyFloorDiv(this.rotationLength(), 2)) : 0;
    const albedoSkillTimes = tickTimes(arcEnd.get('Albedo') ?? 0.0, 2.0, albedoTickCount);
    const albedoSnap = buffsAt('Geo', (timeline.arc_start.get('Albedo') ?? 0.0) + 1, 0.5);

    // Only the characters actually on the team have their personal damage computed.
    const damageByName = {
      Venti: () => this.venti_rotation.damage(
        settings, this.enemy, this.venti, this.nicole, this.prune, this.bennett, this.faruzan, this.durin, this.fischl, this.mona,
        artifactBuffs, timeline,
        buffsAt('Anemo', timeline.arc_start.get('Venti') + VentiRotation.ACTIVATION_TIME, 1.0),
        buffsAt('Anemo', ventiBurstStart, 1.0),
        buffsAt(absorbedBurstElement, ventiBurstStart, 1.0),
        ventiSlotSeries,
        anemoResonanceActive, physicalResistance, swirlBonus, this.rotationLength(), absorptionSource, anemoCharacterCount),
      Nicole: () => this.nicole.damage(settings, this.enemy, this.bennett, this.durin, artifactBuffs,
        buffsAt('Pyro', timeline.arc_start.get('Nicole') + 1, 0.5), buffsAt('Pyro', arcEnd.get('Nicole'), 0.5),
        ...onFieldTimes('Nicole')),
      Durin: () => this.durin.damage(settings, this.enemy, this.nicole, this.bennett, artifactBuffs,
        buffsAt('Pyro', timeline.arc_start.get('Durin') + 1, 0.5), buffsAt('Pyro', arcEnd.get('Durin'), 0.5),
        durinFrontSeries, durinBackSeries, ...onFieldTimes('Durin')),
      Prune: () => this.prune.damage(settings, this.enemy, this.nicole, this.bennett, this.faruzan, this.durin, artifactBuffs, timeline,
        buffsAt('Anemo', timeline.arc_start.get('Prune') + 1, 0.5, true), buffsAt('Anemo', arcEnd.get('Prune'), 0.5, true),
        swirlBonus, absorptionSource, pruneAnemoSeries, prunePyroSeries, ...onFieldTimes('Prune')),
      Bennett: () => this.bennett.damage(settings, this.enemy, this.nicole, this.durin, artifactBuffs,
        buffsAt('Pyro', timeline.arc_start.get('Bennett') + 1, 0), buffsAt('Pyro', arcEnd.get('Bennett'), 0),
        ...onFieldTimes('Bennett')),
      Faruzan: () => this.faruzan.damage(settings, this.enemy, this.nicole, this.bennett, this.durin, artifactBuffs,
        buffsAt('Anemo', timeline.arc_start.get('Faruzan') + 1, 0), buffsAt('Anemo', arcEnd.get('Faruzan'), 0),
        swirlBonus, absorptionSource, faruzanC6Series, ...onFieldTimes('Faruzan')),
      Fischl: () => this.fischl.damage(settings, this.enemy, this.nicole, this.bennett, this.durin, artifactBuffs,
        buffsAt('Electro', timeline.arc_start.get('Fischl') + 1, 0.5), physicalResistance,
        fischlPrimaryTimes, fischlSecondaryTimes, fischlTertiaryTimes,
        ...onFieldTimes('Fischl')),
      Mona: () => this.mona.damage(settings, this.enemy, this.nicole, this.bennett, this.durin, artifactBuffs,
        buffsAt('Hydro', arcEnd.get('Mona'), 0.5), monaSkillSeries,
        onFieldTimes('Mona')[1]),
      Albedo: () => this.albedo.damage(settings, this.enemy, this.nicole, this.bennett, this.durin, artifactBuffs,
        albedoSnap.shared_bonus, albedoSnap.resistance, albedoSnap.crit_rate_bonus, albedoSnap.crit_damage_bonus,
        albedoSnap.nicole_uptime, albedoSnap.bennett_uptime, albedoSkillTimes,
        ...onFieldTimes('Albedo')),
    };
    let results = this.member_names.map((name) => damageByName[name]());

    // Nicole's projections -- 4 from her burst (3s apart, starting the instant
    // her burst lands) plus 3 from C1 (6s apart, from the very front of the
    // rotation) -- each land on whoever is actually on-field AT THAT INSTANT,
    // using that character's own live attack and buffs right then. They're
    // "nondescript" damage: excluded from every burst-only bonus, from Prune's
    // own dmg% bonus, and from the landing character's own weapon dmg% stat.
    // A hit landing on Bennett or Faruzan drops Nicole's usual +300% term.
    if (timeline.arc_start.has('Nicole') && this.nicole.team_buffs_enabled) {
      const projectionAttackAt = (name, instant, buffs) => {
        const nUptime = buffs.nicole_uptime;
        const bUptime = buffs.bennett_uptime;
        if (name === 'Venti') {
          const pruneActive = absorptionActive && timeline.activeAt('Venti', this.prune.atkBuffDuration(timeline), instant, false);
          const extAtkPct = artifactBuffs.teamAttackPercentExcludingTenacityAt(instant);
          return this.venti.finalAttack(settings, this.nicole, this.prune, this.bennett, artifactBuffs, true, pruneActive,
            anemoCharacterCount, extAtkPct, nUptime, bUptime);
        }
        if (name === 'Nicole') return this.nicole.finalAttack(settings, this.bennett, artifactBuffs);
        if (name === 'Durin') {
          return this.durin.finalAttack(settings, this.nicole, artifactBuffs, nUptime, instant) + this.bennett.teamAttackBuff(bUptime);
        }
        if (name === 'Prune') {
          const elapsed = timeline.arc_start.has('Prune')
            ? pyMod(instant - (timeline.arc_start.get('Prune') + timeline.field_time.get('Prune')), timeline.period) : null;
          const hexActive = timeline.activeAt('Venti', this.prune.atkBuffDuration(timeline), instant, false);
          return this.prune.finalAttack(settings, this.nicole, artifactBuffs, absorptionActive, nUptime, elapsed, hexActive)
            + this.bennett.teamAttackBuff(bUptime);
        }
        if (name === 'Bennett') return this.bennett.finalAttack(settings, artifactBuffs);
        if (name === 'Faruzan') return this.faruzan.finalAttack(settings, artifactBuffs) + this.bennett.teamAttackBuff(bUptime);
        if (name === 'Fischl') return this.fischl.finalAttack(settings, artifactBuffs) + this.bennett.teamAttackBuff(bUptime);
        if (name === 'Mona') return this.mona.finalAttack(settings, this.nicole, artifactBuffs, nUptime) + this.bennett.teamAttackBuff(bUptime);
        if (name === 'Albedo') return this.albedo.finalAttack(settings, this.nicole, this.bennett, artifactBuffs, nUptime, bUptime);
        throw new ValueError(`no Nicole-projection attack dispatch for ${pyRepr(name)}`);
      };

      const projectionBonusAt = (name, character, element, buffs) => {
        const artifacts = character.artifacts.total;
        const artifactSet = ARTIFACT_SETS[character.artifact_set];
        const fieldName = ELEMENT_DAMAGE_BONUS_FIELD[element];
        let bonus = (fieldName ? (artifacts[fieldName] ?? 0) : 0) + buffs.elemental_damage_bonus + buffs.shared_bonus;
        // Weapon DMG% stats apply normally -- Daybreak Chronicles' is the one
        // exception (conditional on Oz being out).
        if (character.weapon !== 'Daybreak Chronicles') bonus += character.weaponStats().damage_bonus ?? 0;
        if (element === 'Anemo') {
          bonus += artifactSet.two_piece_anemo_damage_bonus + this.faruzan.anemoDamageBonus(buffs.faruzan_uptime) + this.durin.pyroAnemoDamageBonus();
        }
        if (element === 'Pyro') bonus += this.bennett.pyroDamageBonus(buffs.bennett_uptime) + this.durin.pyroAnemoDamageBonus();
        if (element === 'Geo') {
          bonus += artifactSet.four_piece_geo_damage_bonus;
          if (name === 'Albedo') bonus += this.albedo.ascension_geo_damage_bonus;
        }
        if (name === 'Mona') bonus += this.mona.hydro_damage_bonus_percent;
        if (name === 'Venti') {
          // His own kit's two non-burst-locked dmg% bonuses. Assumes he's
          // already activated by this instant (a documented simplification).
          bonus += absorptionActive ? this.venti.hex_damage_bonus : 0;
          if (this.venti.c4_enabled) bonus += this.venti.c4_anemo_damage_bonus;
        }
        return bonus;
      };

      const projectionHit = (name, instant, activeCoefficient, nicoleCoefficient, ability) => {
        const character = this.character(name);
        const { element } = character;
        const buffs = buffsAt(element, instant, 1.0, true);
        const activeAttack = projectionAttackAt(name, instant, buffs);
        const nicoleTerm = (name === 'Bennett' || name === 'Faruzan') ? 0.0
          : nicoleCoefficient * this.nicole.finalAttack(settings, this.bennett, artifactBuffs);
        const attackTerm = activeCoefficient * activeAttack + nicoleTerm;
        const bonus = projectionBonusAt(name, character, element, buffs);
        let [critRate, critDamage] = personalCritStats(character);
        critRate += buffs.crit_rate_bonus;
        critDamage += buffs.crit_damage_bonus;
        const damage = (attackTerm * (1 + bonus) * expectedCritMultiplier(critRate, critDamage)
          * settings.defenseMultiplier(this.enemy, character.character_level) * resistanceMultiplier(buffs.resistance));
        return new Hit(name, ability, instant, damage, critRate, critDamage);
      };

      const additions = new Map();
      const addHit = (name, hit) => {
        if (!additions.has(name)) additions.set(name, []);
        additions.get(name).push(hit);
      };
      if (this.nicole.burst_enabled) {
        const nicoleBurstTime = timeline.arc_start.get('Nicole') + timeline.field_time.get('Nicole');
        const mainCoefficient = this.nicole.c5_enabled ? this.nicole.c5_projection_attack_mv : 1.8;
        for (let i = 0; i < 4; i++) {
          const instant = nicoleBurstTime + i * NICOLE_PROJECTION_TICK_INTERVAL;
          const name = timeline.characterAt(instant);
          if (name !== null) addHit(name, projectionHit(name, instant, mainCoefficient, 3.0, 'nicole projections'));
        }
      }
      if (this.nicole.c1_enabled) {
        for (let i = 0; i < this.nicole.c1_projection_hits; i++) {
          const instant = i * NICOLE_C1_PROJECTION_TICK_INTERVAL;
          const name = timeline.characterAt(instant);
          if (name !== null) addHit(name, projectionHit(name, instant, this.nicole.c1_projection_mv, 3.0, 'nicole c1 projections'));
        }
      }

      if (additions.size) {
        results = results.map((result) => {
          const newHits = additions.get(result.name);
          if (!newHits || !newHits.length) return result;
          const newAbilities = new Map(result.abilities);
          for (const ability of ['nicole projections', 'nicole c1 projections']) {
            const abilityHits = newHits.filter((h) => h.ability === ability);
            if (abilityHits.length) newAbilities.set(hitSuffix(ability, abilityHits.length), pySumMap(abilityHits, (h) => h.damage));
          }
          return new DamageResult(result.name, newAbilities, result.breakdowns, [...result.hits, ...newHits]);
        });
      }
    }

    return results;
  }
}

/* Add a new character class here when its build and damage model are
 * implemented. Venti is locked into the first slot and is always on the team. */
export const CHARACTER_ROSTER = {
  Venti, Nicole, Durin, Prune, Bennett, Faruzan, Fischl, Mona, Albedo,
};

export const LOCKED_TEAM_MEMBER = 'Venti';
export const OPTIONAL_ROSTER = Object.fromEntries(Object.entries(CHARACTER_ROSTER).filter(([name]) => name !== LOCKED_TEAM_MEMBER));

export const SELECTED_TEAM = ['Venti', 'Nicole', 'Durin', 'Prune'];

/* Build the selected team using fresh character objects. Anyone left out of
 * ``SELECTED_TEAM`` still gets a build object, created with
 * ``team_buffs_enabled = false``. */
export function buildDefaultTeam() {
  const members = [...SELECTED_TEAM];
  const all = {};
  for (const name of members) all[name] = new CHARACTER_ROSTER[name]();
  for (const name of Object.keys(OPTIONAL_ROSTER)) {
    if (!(name in all)) all[name] = new OPTIONAL_ROSTER[name]({ team_buffs_enabled: false });
  }
  return new Team(new TeamSettings(), new Enemy(), members,
    all.Nicole, all.Durin, all.Prune, all.Venti, all.Bennett, all.Faruzan, all.Fischl, all.Mona, all.Albedo);
}
