/* TTDS/elemental-absorption/VV-shred resolution helpers, and Venti's own
 * editable rotation-notation damage engine (``VentiRotation``).
 *
 * Every helper here takes generic character objects and dispatches by
 * attribute/class name, so this module has no dependency on the character
 * classes -- it is, in fact, a dependency *of* several of them. */
import { ARTIFACT_SETS } from './artifacts.js';
import { DamageResult, Hit } from './combat.js';
import {
  HARP_TRIGGER_COUNT_BY_REFINEMENT, expectedCritMultiplier, hitSuffix, refinementScale, resistanceMultiplier, slotOf,
  transformativeDamage, valueAtRefinement, weightedQuillMultiplier,
} from './formulas.js';
import { ValueError, div, minBy, pyInt, pyMin, pyRepr, pySum, pySumMap, stripAllWhitespace } from './py.js';

const className = (character) => character.constructor.NAME;

/* Whoever -- Nicole, Prune, or Mona -- is wielding TTDS while actually on the
 * team, or ``null`` if nobody qualifies. */
export function ttdsWielder(nicole, prune, mona) {
  for (const character of [nicole, prune, mona]) {
    if (character.team_buffs_enabled && character.weapon === 'TTDS') return character;
  }
  return null;
}

/* TTDS's own attack% bonus (by its wielder's refinement) and real duration.
 * Reaches only whoever plays immediately next after the wielder. */
export const TTDS_VENTI_ATTACK_PERCENT_BY_REFINEMENT = refinementScale(0.24, 0.48);
export const TTDS_SHORT_ROTATION_THRESHOLD = 20.0;
export const TTDS_BUFF_DURATION = 10.0;

/* How many of Venti's notated skill ('e') casts actually land in one
 * rotation. Without Anemo Resonance or his own C2 he can only recast once
 * after the activation hit -- 2 total; either lets him land a third, but no
 * more than that. */
export function ventiEffectiveSkillCasts(notatedSkillCasts, anemoResonanceActive, c2Enabled) {
  const cap = (anemoResonanceActive || c2Enabled) ? 3 : 2;
  return pyMin(notatedSkillCasts, cap);
}

/* How many of Venti's notated burst ('q') casts actually land -- capped to 1. */
export function ventiEffectiveBurstCasts(notatedBurstCasts) {
  return pyMin(notatedBurstCasts, 1);
}

/* Ordered list of Venti's own individual on-field hit slots this rotation
 * actually lands, derived directly from his notation string: "activation" for
 * the first landing skill cast, "skill" for each subsequent landing one, and
 * "normal1".."normal6" for each individual hit of an 'nK' string. 'q'/'d'
 * tokens contribute no slot. */
export function ventiNotationSlots(tokenOrder, effectiveSkillCasts) {
  const slots = [];
  let skillsSeen = 0;
  for (const token of tokenOrder) {
    if (token === 'e') {
      skillsSeen += 1;
      if (skillsSeen <= effectiveSkillCasts) slots.push(skillsSeen === 1 ? 'activation' : 'skill');
    } else if (token.startsWith('n')) {
      const finalNormal = Number(token.slice(1));
      for (let i = 1; i <= finalNormal; i++) slots.push(`normal${i}`);
    }
    // "q" and "d" contribute no slot.
  }
  return slots;
}

/* Whichever present character grants Venti's burst an elemental absorption,
 * by priority (lowest ``absorption_priority`` wins): Fischl > Durin > Mona >
 * Bennett. ``bennettEligible = false`` drops Bennett from consideration
 * entirely -- landing his Pyro absorption is much less reliable. */
export function ventiAbsorptionSource(fischl, durin, mona, bennett, { bennettEligible = true } = {}) {
  const candidates = [fischl, durin, mona].filter((character) => character.team_buffs_enabled);
  if (bennettEligible && bennett.team_buffs_enabled) candidates.push(bennett);
  return candidates.length ? minBy(candidates, (character) => character.absorption_priority) : null;
}

/* The element Venti's burst (and any mirrored ticks/swirls elsewhere in the
 * team) actually absorbs, from whichever character (if any) grants it. */
export function absorbedElement(source) {
  return source !== null ? source.element : null;
}

export const VV_SHREDDABLE_ELEMENTS = ['Pyro', 'Electro', 'Hydro'];
export const VV_BUFF_DURATION = 10.0;

/* VV's 4pc shreds whichever element sits in the *next* team slot after an
 * Anemo character wearing VV. The lowest-slot qualifying wearer wins.
 * Returns ``[wearerName, element]``, or ``[null, null]``. */
export function vvShredTarget(presentCharacters) {
  const bySlot = new Map();
  for (const character of presentCharacters) bySlot.set(slotOf(character), character);
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const wearer = bySlot.get(slot);
    if (wearer.artifact_set !== 'VV' || wearer.element !== 'Anemo') continue;
    const neighbor = bySlot.get(slot + 1);
    if (neighbor !== undefined && VV_SHREDDABLE_ELEMENTS.includes(neighbor.element)) return [className(wearer), neighbor.element];
  }
  return [null, null];
}

/* The damage-relevant counts extracted from a rotation-notation string.
 * ``token_order`` preserves WHEN each token occurs so the per-hit engine can
 * time Venti's own sequence directly off the notation. */
export class ParsedVentiRotation {
  constructor(skillCasts, burstCasts, dashCount, normalArrowCounts, c1ArrowCounts, normalSequences, tokenOrder) {
    this.skill_casts = skillCasts;
    this.burst_casts = burstCasts;
    this.dash_count = dashCount;
    this.normal_arrow_counts = normalArrowCounts;
    this.c1_arrow_counts = c1ArrowCounts;
    this.normal_sequences = normalSequences;
    this.token_order = tokenOrder;
  }
}

/* Venti's editable Genshin rotation.
 *
 * ``notation`` accepts ``e`` (skill), ``q`` (burst), ``d`` (dash), and ``n1``
 * through ``n6`` (a completed normal string up through that attack).
 * Whitespace is optional. Dashes are parsed for readability but do not enter
 * the damage model.
 *
 * The first ``e`` is an activation event. It deals damage before Venti's
 * artifact-set buff and Prune's Hex/C6 buffs apply; it then turns those buffs
 * on for every later Venti action in the rotation. */
export class VentiRotation {
  static ACTIVATION_TIME = 1.0;
  static BURST_START_OFFSET = 2.0;
  static BURST_DURATION = 10.0;

  /* Per normal animation: N1 and N4 fire two base arrows, the rest one; every
   * C1 normal fires two additional arrows worth 20% of its base arrow's MV. */
  static NORMAL_ARROW_COUNTS = [2, 1, 1, 2, 1, 1];
  static C1_ARROWS_PER_NORMAL = 2;

  constructor({
    notation = 'eq n5d n2e n5d n5e', burst_first_hits_per_cast = 24, burst_second_hits_per_cast = 16, swirls_per_burst = 16,
  } = {}) {
    this.notation = notation;
    this.burst_first_hits_per_cast = burst_first_hits_per_cast;
    this.burst_second_hits_per_cast = burst_second_hits_per_cast;
    this.swirls_per_burst = swirls_per_burst;
  }

  /* Parse notation and expand every ``nX`` into its preceding attacks. */
  parse() {
    const notation = stripAllWhitespace(this.notation.toLowerCase());
    let skills = 0;
    let bursts = 0;
    let dashes = 0;
    const normalInstances = [0, 0, 0, 0, 0, 0];
    const normalSequences = [];
    const tokenOrder = [];
    let position = 0;

    while (position < notation.length) {
      const token = notation[position];
      if (token === 'e') {
        skills += 1;
        tokenOrder.push('e');
        position += 1;
      } else if (token === 'q') {
        bursts += 1;
        tokenOrder.push('q');
        position += 1;
      } else if (token === 'd') {
        dashes += 1;
        tokenOrder.push('d');
        position += 1;
      } else if (token === 'n') {
        if (position + 1 >= notation.length || !'123456'.includes(notation[position + 1])) {
          throw new ValueError(`Expected n1 through n6 at character ${position + 1}: ${pyRepr(this.notation)}`);
        }
        const finalNormal = Number(notation[position + 1]);
        normalSequences.push(finalNormal);
        tokenOrder.push(`n${finalNormal}`);
        for (let normalIndex = 0; normalIndex < finalNormal; normalIndex++) normalInstances[normalIndex] += 1;
        position += 2;
      } else {
        throw new ValueError(`Unknown rotation token ${pyRepr(token)} at character ${position + 1}: ${pyRepr(this.notation)}`);
      }
    }

    const normalArrows = normalInstances.map((instances, i) => instances * VentiRotation.NORMAL_ARROW_COUNTS[i]);
    const c1Arrows = normalInstances.map((instances) => instances * VentiRotation.C1_ARROWS_PER_NORMAL);
    return new ParsedVentiRotation(skills, bursts, dashes, normalArrows, c1Arrows, normalSequences, tokenOrder);
  }

  /* Every hit is tagged on-field, off-field, or snapshot exactly like every
   * other character: the activation skill is its own on-field hit at the
   * first second of his field time (``activationBuffs``); his burst (both
   * hit-streams plus every swirl) snapshots once, 2 seconds into his field
   * time (``burstBuffs``/``burst2Buffs``); his skill recasts and every
   * individual normal-attack hit are on-field, each timed directly off his
   * notation and resolving buffs at its own real tick (``slotBuffs``). */
  damage(settings, enemy, venti, nicole, prune, bennett, faruzan, durin, fischl, mona, artifactBuffs, timeline, activationBuffs,
    burstBuffs, burst2Buffs, slotBuffs, anemoResonanceActive, physicalResistance, swirlBonus, rotationLength, absorptionSource,
    anemoCharacterCount = 0) {
    const parsed = this.parse();
    // With no 'e' there's no activation hit. His burst snapshots activated
    // stats only if an 'e' comes before his first 'q'; otherwise (no 'e', or
    // 'q' first) its ticks resolve with the pre-activation stats the
    // activation skill uses. Everything else (normals) counts as activated.
    const hasActivation = parsed.skill_casts > 0;
    const firstSkillIndex = parsed.token_order.indexOf('e');
    const firstBurstIndex = parsed.token_order.indexOf('q');
    const burstActivated = hasActivation && (firstBurstIndex === -1 || firstSkillIndex < firstBurstIndex);
    const effectiveSkillCasts = ventiEffectiveSkillCasts(parsed.skill_casts, anemoResonanceActive, venti.c2_enabled);
    const effectiveBurstCasts = ventiEffectiveBurstCasts(parsed.burst_casts);
    const w = venti.weaponStats();
    // Venti's burst only imbues an absorbed element (and only then does his
    // kit get the flat 50% bonus, his burst 2 ticks, and his swirls) while
    // someone present actually grants him one.
    const absorptionActive = absorptionSource !== null;
    const defense = settings.defenseMultiplier(enemy, venti.character_level);
    const activationTime = timeline.arc_start.get('Venti') + VentiRotation.ACTIVATION_TIME;
    const burstStart = timeline.arc_start.get('Venti') + VentiRotation.BURST_START_OFFSET;

    // TTDS: 48% ATK, halved under a 20s rotation, reaching only whoever plays
    // immediately after its wielder. Attack is linear in attack%, so this is a
    // flat delta added onto each hit's own attack, sampled at that hit's tick.
    const ttdsHolder = ttdsWielder(nicole, prune, mona);
    let ttdsSource = null;
    let ttdsDelta = 0.0;
    if (ttdsHolder !== null && timeline.nextInPlayOrder(className(ttdsHolder)) === 'Venti') {
      const ttdsFullPercent = valueAtRefinement(TTDS_VENTI_ATTACK_PERCENT_BY_REFINEMENT, ttdsHolder.weapon_refinement);
      const ttdsPercent = rotationLength < TTDS_SHORT_ROTATION_THRESHOLD ? ttdsFullPercent / 2 : ttdsFullPercent;
      ttdsDelta = (venti.base_attack + w.base_attack) * ttdsPercent;
      ttdsSource = className(ttdsHolder);
    }

    const ttdsBonus = (instant) => (ttdsSource !== null ? ttdsDelta * Number(timeline.activeAt(ttdsSource, TTDS_BUFF_DURATION, instant)) : 0.0);

    // Prune's onfield ATK%/flat-ATK buffs to Venti are gated on his own
    // presence -- ``atkBuffDuration`` is already swap-out-anchored.
    const pruneOnfieldActive = (instant) => absorptionActive && timeline.activeAt('Venti', prune.atkBuffDuration(timeline), instant, false);

    const firstSkillAttack = venti.finalAttack(settings, nicole, prune, bennett, artifactBuffs, false, false, anemoCharacterCount,
      activationBuffs.external_attack_percent, activationBuffs.nicole_uptime, activationBuffs.bennett_uptime) + ttdsBonus(activationTime);
    const finalAttack = venti.finalAttack(settings, nicole, prune, bennett, artifactBuffs, burstActivated,
      burstActivated && pruneOnfieldActive(burstStart), anemoCharacterCount,
      burstBuffs.external_attack_percent, burstBuffs.nicole_uptime, burstBuffs.bennett_uptime) + ttdsBonus(burstStart);

    // Faruzan's C6 crit damage bonus is Anemo-only.
    const anemoCritStats = (buffs, activated) => venti.critStats(activated,
      faruzan.critDamageBonus(buffs.faruzan_uptime) + buffs.crit_damage_bonus, buffs.crit_rate_bonus);

    const otherCritStats = (buffs, activated) => venti.critStats(activated, buffs.crit_damage_bonus, buffs.crit_rate_bonus);

    const anemoCrit = (buffs, activated) => expectedCritMultiplier(...anemoCritStats(buffs, activated));

    const otherCrit = (buffs, activated) => expectedCritMultiplier(...otherCritStats(buffs, activated));

    const firstSkillCritStats = anemoCritStats(activationBuffs, false);
    const firstSkillCritAnemo = expectedCritMultiplier(...firstSkillCritStats);
    const burstCritStats = anemoCritStats(burstBuffs, burstActivated);
    const critAnemoBurst = expectedCritMultiplier(...burstCritStats);
    const burst2CritStats = otherCritStats(burst2Buffs, burstActivated);
    const critOtherBurst = expectedCritMultiplier(...burst2CritStats);

    // Venti's own 50% hex_damage_bonus only turns on once his first skill has
    // actually activated -- excluded from ``firstSkillMultiplier``. Prune's
    // team DMG bonus arrives pre-baked into ``buffs.shared_bonus``.
    const hexBonus = absorptionActive ? venti.hex_damage_bonus : 0;
    const nonHexBonus = (buffs) => w.damage_bonus + buffs.shared_bonus;

    // Venti's own C4 Anemo DMG bonus likewise only turns on once activated.
    const nonC4AnemoBonus = (buffs) => (venti.artifacts.total.anemo_damage_bonus + buffs.elemental_damage_bonus
      + ARTIFACT_SETS[venti.artifact_set].two_piece_anemo_damage_bonus
      + faruzan.anemoDamageBonus(buffs.faruzan_uptime) + durin.pyroAnemoDamageBonus());

    const c4AnemoBonus = venti.c4_enabled ? venti.c4_anemo_damage_bonus : 0;

    const anemoBonus = (buffs) => nonC4AnemoBonus(buffs) + c4AnemoBonus;

    // The absorbed element decides which bonus/resistance the "burst 2"
    // hit-stream uses. Electro (Fischl) and Hydro (Mona) get only their own
    // generic elemental bonus; Pyro additionally gets Bennett's/Durin's.
    const sourceElement = absorbedElement(absorptionSource);
    const burst2Extra = (sourceElement === 'Electro' || sourceElement === 'Hydro')
      ? 0.0 : bennett.pyroDamageBonus(burst2Buffs.bennett_uptime) + durin.pyroAnemoDamageBonus();
    // ``shared_bonus`` is NOT repeated here -- ``nonHexBonus(burst2Buffs)``
    // (added alongside this at ``pyroBurstMult``) already includes it once.
    const burst2Bonus = burst2Buffs.elemental_damage_bonus + burst2Extra;

    // Noblesse's 2pc Elemental Burst DMG bonus only applies to Venti's own
    // burst hits (burst 1/2).
    const ventiBurstBonus = ARTIFACT_SETS[venti.artifact_set].two_piece_burst_damage_bonus;
    // Golden Troupe's Skill DMG bonus only applies to his two genuinely
    // Skill-type entries; Polar Star's "skill and burst DMG bonus" folds into
    // the Skill-type entries *and* both burst multipliers.
    const goldenTroupeSkillBonus = ARTIFACT_SETS[venti.artifact_set].four_piece_skill_damage_bonus;
    const weaponBurstBonus = w.burst_damage_bonus;
    const weaponSkillBonus = w.skill_damage_bonus;

    // ``burst2Buffs.resistance`` already has VV's shred baked in if it applies.
    const burst2ResistanceMultiplier = resistanceMultiplier(burst2Buffs.resistance);
    const burstHexBonus = burstActivated ? hexBonus : 0;
    const burstAnemoBonus = burstActivated ? anemoBonus(burstBuffs) : nonC4AnemoBonus(burstBuffs);
    const anemoBurstMult = (1 + burstHexBonus + nonHexBonus(burstBuffs) + burstAnemoBonus + ventiBurstBonus + weaponBurstBonus + weaponSkillBonus)
      * critAnemoBurst * defense * resistanceMultiplier(burstBuffs.resistance);
    const pyroBurstMult = (1 + burstHexBonus + nonHexBonus(burst2Buffs) + burst2Bonus + ventiBurstBonus + weaponBurstBonus + weaponSkillBonus)
      * critOtherBurst * defense * burst2ResistanceMultiplier;
    const firstSkillMultiplier = (1 + nonHexBonus(activationBuffs) + nonC4AnemoBonus(activationBuffs) + goldenTroupeSkillBonus + weaponSkillBonus)
      * firstSkillCritAnemo * defense * resistanceMultiplier(activationBuffs.resistance);
    const [skillMv, c2Mult] = [venti.c5_enabled ? 5.87 : 4.97, venti.c2_enabled ? 3 : 1];
    const [burst1Mv, burst2Mv] = [venti.c3_enabled ? 0.799 : 0.677, venti.c3_enabled ? 0.4 : 0.338];
    const normalMvs = [0.403, 0.877, 1.035, 0.515, 1.001, 1.403];

    const c1Counts = venti.c1_enabled ? parsed.c1_arrow_counts : [0, 0, 0, 0, 0, 0];

    // Venti's own skill-recast/normal-attack sequence is timed directly off
    // his rotation notation -- each slot gets its own timestamp and its own
    // point-in-time buff lookup (``slotBuffs``).
    const ventiSlots = ventiNotationSlots(parsed.token_order, effectiveSkillCasts);
    const nonActivationLabels = ventiSlots.filter((label) => label !== 'activation');
    if (nonActivationLabels.length !== slotBuffs.length) {
      throw new ValueError('slot_buffs must have one entry per non-activation notation slot (see Team.damage_results)');
    }

    const slotAttack = (buffs, time) => venti.finalAttack(settings, nicole, prune, bennett, artifactBuffs, true, pruneOnfieldActive(time),
      anemoCharacterCount, buffs.external_attack_percent, buffs.nicole_uptime, buffs.bennett_uptime) + ttdsBonus(time);

    // dmg%/Anemo-bonus/crit "rest of scaling" at one slot's own instant --
    // only the weapon-bonus term differs between skill and normal slots.
    const slotRest = (buffs, time, normal) => {
      const weaponBonus = !normal ? (goldenTroupeSkillBonus + weaponSkillBonus) : w.normal_attack_bonus;
      return (1 + hexBonus + nonHexBonus(buffs) + anemoBonus(buffs) + weaponBonus) * anemoCrit(buffs, true) * defense
        * resistanceMultiplier(buffs.resistance);
    };

    // Physical DMG -- excludes Prune's dmg% bonus and Faruzan's Anemo-only
    // crit damage bonus. ``buffs.shared_bonus`` was built WITH Prune's bonus,
    // so her contribution is subtracted back out at this hit's own instant.
    const harpRest = (buffs, time) => {
      const pruneBonus = prune.teamDamageBonusAt(settings, nicole, artifactBuffs, absorptionActive, timeline, time);
      const damageBonus = hexBonus + w.damage_bonus + buffs.shared_bonus - pruneBonus;
      return (1 + damageBonus) * otherCrit(buffs, true) * defense * resistanceMultiplier(physicalResistance);
    };

    const harpTriggerCount = HARP_TRIGGER_COUNT_BY_REFINEMENT[venti.weapon_refinement];
    const skillHits = [];
    const normalHits = [];
    const c1NormalHits = [];
    const harpHits = [];
    const skillRestValues = [];
    const normalRestValues = [];
    let normalSlotsSeen = 0;
    nonActivationLabels.forEach((label, index) => {
      const [time, buffs] = slotBuffs[index];
      const attack = slotAttack(buffs, time);
      if (label === 'skill') {
        const rest = slotRest(buffs, time, false);
        skillHits.push(new Hit('Venti', 'skill after activation', time, skillMv * c2Mult * attack * rest, ...anemoCritStats(buffs, true)));
        skillRestValues.push(rest);
        return;
      }
      const position = Number(label.slice(6)) - 1; // "normalK" -> K - 1
      const rest = slotRest(buffs, time, true);
      normalRestValues.push(rest);
      const base = attack * 2.5 * rest;
      const normalCritStats = anemoCritStats(buffs, true);
      // N1/N4 each fire two arrows in this one tick -- recorded as two
      // separate hit-log instances, one per real arrow.
      const perArrowDamage = normalMvs[position] * base;
      for (let i = 0; i < VentiRotation.NORMAL_ARROW_COUNTS[position]; i++) {
        normalHits.push(new Hit('Venti', `N${position + 1}`, time, perArrowDamage, ...normalCritStats));
      }
      if (venti.c1_enabled) {
        const perC1ArrowDamage = normalMvs[position] * 0.2 * base;
        for (let i = 0; i < VentiRotation.C1_ARROWS_PER_NORMAL; i++) {
          c1NormalHits.push(new Hit('Venti', `C1 N${position + 1}`, time, perC1ArrowDamage, ...normalCritStats));
        }
      }
      if (w.has_harp_trigger && normalSlotsSeen < harpTriggerCount) {
        harpHits.push(new Hit('Venti', 'harp trigger', time, 1.25 * attack * harpRest(buffs, time), ...otherCritStats(buffs, true)));
      }
      normalSlotsSeen += 1;
    });

    const groupByAbility = (hits) => {
      const grouped = new Map();
      for (const hit of hits) {
        if (!grouped.has(hit.ability)) grouped.set(hit.ability, []);
        grouped.get(hit.ability).push(hit.damage);
      }
      const out = new Map();
      for (const [ability, damages] of grouped) out.set(ability, [damages.length, pySum(damages)]);
      return out;
    };

    const normalsBreakdown = groupByAbility(normalHits);
    const c1NormalsBreakdown = groupByAbility(c1NormalHits);

    const swirlEm = venti.artifacts.total.elemental_mastery + artifactBuffs.teamElementalMasterySnapshot('Venti');

    // Venti's burst fires as two independent, parallel hit-streams, both
    // snapshotted at ``burstStart`` and spread evenly across its own 10s
    // window. Every swirl hits alongside its own burst-2 counterpart.
    const activationSkillDamage = hasActivation ? skillMv * c2Mult * firstSkillAttack * firstSkillMultiplier : 0.0;
    const activationHits = hasActivation
      ? [new Hit('Venti', 'activation skill', activationTime, activationSkillDamage, ...firstSkillCritStats)] : [];
    const skillAfterActivationDamage = pySumMap(skillHits, (hit) => hit.damage);

    const burst1HitsCount = effectiveBurstCasts * this.burst_first_hits_per_cast;
    const burst1Total = burst1HitsCount * burst1Mv * finalAttack * 1.35 * anemoBurstMult;
    const burst1Cadence = burst1HitsCount ? div(VentiRotation.BURST_DURATION, burst1HitsCount) : 0.0;
    const burst1HitList = [];
    for (let i = 0; i < burst1HitsCount; i++) {
      burst1HitList.push(new Hit('Venti', 'burst 1', burstStart + i * burst1Cadence, div(burst1Total, burst1HitsCount), ...burstCritStats));
    }

    const burst2HitsCount = pyInt(effectiveBurstCasts * this.burst_second_hits_per_cast * absorptionActive);
    const burst2Total = burst2HitsCount * burst2Mv * finalAttack * 1.35 * pyroBurstMult;
    const burst2Cadence = burst2HitsCount ? div(VentiRotation.BURST_DURATION, burst2HitsCount) : 0.0;
    const burst2HitList = [];
    for (let i = 0; i < burst2HitsCount; i++) {
      burst2HitList.push(new Hit('Venti', 'burst 2', burstStart + i * burst2Cadence, div(burst2Total, burst2HitsCount), ...burst2CritStats));
    }

    const swirlHitsCount = pyInt(effectiveBurstCasts * this.swirls_per_burst * absorptionActive);
    const swirlTotal = swirlHitsCount * transformativeDamage(swirlEm, burst2ResistanceMultiplier, settings.reactionMultiplier(venti.character_level))
      * (1 + swirlBonus);
    const swirlCadence = swirlHitsCount ? div(VentiRotation.BURST_DURATION, swirlHitsCount) : 0.0;
    const swirlHitList = [];
    for (let i = 0; i < swirlHitsCount; i++) {
      swirlHitList.push(new Hit('Venti', 'swirl', burstStart + i * swirlCadence, div(swirlTotal, swirlHitsCount)));
    }

    const result = new Map();
    result.set('activation skill', activationSkillDamage);
    result.set('skill after activation', skillAfterActivationDamage);
    result.set(hitSuffix('burst 1', burst1HitsCount), burst1Total);
    // Both zero out entirely when nobody present grants an absorption at all.
    result.set(hitSuffix('burst 2', burst2HitsCount), burst2Total);
    result.set('normals', pySumMap(normalHits, (hit) => hit.damage));
    result.set('C1 normals', pySumMap(c1NormalHits, (hit) => hit.damage));
    result.set(hitSuffix('swirl', swirlHitsCount), swirlTotal);
    // "skill" (the UI's own fold of "activation skill" + "skill after
    // activation") mixes two different per-hit values, so it gets a breakdown.
    const skillBreakdown = new Map(hasActivation ? [['Activation', [1, activationSkillDamage]]] : []);
    if (skillHits.length) skillBreakdown.set('After activation', [skillHits.length, skillAfterActivationDamage]);
    const breakdowns = new Map([['normals', normalsBreakdown], ['C1 normals', c1NormalsBreakdown], ['skill', skillBreakdown]]);
    // Only present at all while Venti actually wields Skyward Harp.
    if (w.has_harp_trigger) result.set('harp trigger', pySumMap(harpHits, (hit) => hit.damage));

    // All three quills (Faruzan's, Nicole's C4, Durin's C1) add a flat bonus
    // to whichever specific hit they land on -- so the quill's total
    // contribution is a weighted average of each eligible hit category's
    // "rest of scaling", weighted by that category's share of the hit count.
    const skillAfterRestAvg = skillRestValues.length ? div(pySum(skillRestValues), skillRestValues.length) : 0.0;
    const normalsRestAvg = normalRestValues.length ? div(pySum(normalRestValues), normalRestValues.length) : 0.0;
    const anemoHitBuckets = [
      [skillHits.length, skillAfterRestAvg],
      [burst1HitsCount, anemoBurstMult],
      [pySum(parsed.normal_arrow_counts), normalsRestAvg],
      [pySum(c1Counts), normalsRestAvg * 0.2],
    ];
    // Zero eligible hits (not just zero damage) when burst 2 doesn't fire.
    const pyroHitBuckets = [[burst2HitsCount, pyroBurstMult]];

    // Faruzan's quill only lands on Anemo hits.
    if (faruzan.team_buffs_enabled) {
      result.set('quill', faruzan.quillHits() * faruzan.quillBonus() * weightedQuillMultiplier(anemoHitBuckets));
    }

    // Nicole's C4 and Durin's C1 quills can land on Anemo or Pyro hits alike.
    const fullHitBuckets = [...anemoHitBuckets, ...pyroHitBuckets];
    if (nicole.team_buffs_enabled && nicole.c4_enabled) {
      result.set('nicole c4 quill', nicole.c4_quill_hits * nicole.c4QuillBonus(settings, bennett, artifactBuffs) * weightedQuillMultiplier(fullHitBuckets));
    }
    if (durin.team_buffs_enabled && durin.c1_enabled) {
      result.set('durin c1 quill', durin.c1QuillHits() * durin.c1QuillBonus(settings, nicole, artifactBuffs) * weightedQuillMultiplier(fullHitBuckets));
    }

    return new DamageResult('Venti', result, breakdowns, [
      ...activationHits, ...skillHits, ...normalHits, ...c1NormalHits, ...harpHits,
      ...burst1HitList, ...burst2HitList, ...swirlHitList,
    ]);
  }
}
