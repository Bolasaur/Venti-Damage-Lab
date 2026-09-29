/* Core math helpers shared by every character's damage formulas, plus the
 * level-gated stat tables that key into ``statAtLevel``. No dependency on any
 * other engine module -- this sits at the bottom of the package. */
import { ValueError, div, pyMax, pyMin, pyRepr, pySum, pySumMap } from './py.js';

export function resistanceMultiplier(resistance) {
  if (resistance < 0) return 1 - resistance / 2;
  if (resistance < 0.75) return 1 - resistance;
  return div(1, 4 * resistance + 1);
}

export function expectedCritMultiplier(rate, damage) {
  return 1 + pyMin(rate, 1) * damage;
}

export function attack(base, weapon, percent, ...flat) {
  return (base + weapon) * (1 + percent) + pySum(flat);
}

/* Same shape as ``attack`` -- no weapon grants a base DEF stat in this model,
 * so there's no weapon-base term to add before the percent. */
export function defense(base, percent, ...flat) {
  return base * (1 + percent) + pySum(flat);
}

export function transformativeDamage(em, resistance, reactionMultiplier) {
  return 0.6 * reactionMultiplier * (1 + div(16 * em, 2000 + em)) * resistance;
}

/* Look a level-gated stat (a character's base ATK/DEF, the swirl reaction
 * multiplier) up from one of the ``*_BY_LEVEL`` tables. Every table shares the
 * same eleven keys (``CHARACTER_LEVELS``) -- an unlisted level is rejected
 * rather than interpolated or extrapolated. */
export function statAtLevel(table, level) {
  if (!Object.prototype.hasOwnProperty.call(table, level)) {
    throw new ValueError(`Unknown character level ${pyRepr(level)}`);
  }
  return table[level];
}

export const WEAPON_REFINEMENTS = [1, 2, 3, 4, 5];

/* A refinement-scaled stat table ``{1: r1, ..., 5: r5}``. Kept as its own
 * class (the Python version used a plain dict) so ``weaponStatsAtRefinement``
 * can tell a table apart from an ordinary number. Every refinable stat scales
 * exactly linearly from R1 to R5, except the explicit per-refinement tables
 * built with ``RefinementTable.of`` (Skyward Harp's trigger count, Jade
 * Cutter's flat ATK). */
export class RefinementTable {
  constructor(values) {
    Object.assign(this, values);
  }

  static of(values) {
    return new RefinementTable(values);
  }
}

export function refinementScale(r1, r5) {
  const step = (r5 - r1) / 4;
  const values = {};
  for (const r of WEAPON_REFINEMENTS) values[r] = r1 + step * (r - 1);
  return new RefinementTable(values);
}

/* Skyward Harp's physical proc count per rotation, by refinement -- the one
 * refinable number that doesn't scale linearly (3, 3, 4, 5, 6). */
export const HARP_TRIGGER_COUNT_BY_REFINEMENT = { 1: 3, 2: 3, 3: 4, 4: 5, 5: 6 };

export function valueAtRefinement(table, refinement) {
  if (!Object.prototype.hasOwnProperty.call(table, refinement)) {
    throw new ValueError(`Unknown weapon refinement ${pyRepr(refinement)}`);
  }
  return table[refinement];
}

/* Resolve one weapon's raw ``WEAPONS`` entry at a specific refinement: any
 * value that's itself a refinement table is replaced by its entry at
 * ``refinement``; every other value passes through unchanged. */
export function weaponStatsAtRefinement(stats, refinement) {
  if (!WEAPON_REFINEMENTS.includes(refinement)) {
    throw new ValueError(`Unknown weapon refinement ${pyRepr(refinement)}`);
  }
  const resolved = {};
  for (const [key, value] of Object.entries(stats)) {
    resolved[key] = value instanceof RefinementTable ? value[refinement] : value;
  }
  return resolved;
}

/* The only levels this calculator has data for -- matches the keys of every
 * ``*_BY_LEVEL`` table. */
export const CHARACTER_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];

/* The Elemental Mastery reaction multiplier that scales every transformative
 * (swirl) hit, by character level. */
export const REACTION_MULTIPLIER_BY_LEVEL = {
  10: 34.14, 20: 80.58, 30: 135.53, 40: 207.38, 50: 323.60,
  60: 492.88, 70: 765.64, 80: 1077.44, 90: 1446.85, 95: 1558.29, 100: 1674.81,
};

/* A quill's flat bonus damage lands on one of several hit categories at
 * random, each with its own "rest of scaling" multiplier -- this averages
 * those multipliers, weighted by each category's share of eligible hits.
 * ``buckets`` is a list of ``[count, multiplier]`` pairs. */
export function weightedQuillMultiplier(buckets) {
  const total = pySumMap(buckets, ([count]) => count);
  return total ? div(pySumMap(buckets, ([count, mult]) => count * mult), total) : 0;
}

/* Names a multi-hit ability's own key with its per-rotation hit count, e.g.
 * "burst 2 (14 hits)" -- the UI parses this back out for a dmg/hit figure.
 * Omitted entirely when ``hits`` is 0. */
export function hitSuffix(baseName, hits) {
  return hits ? `${baseName} (${hits} hits)` : baseName;
}

/* Team position: Venti is always slot 1 (no ``slot`` field). */
export function slotOf(character) {
  return character.slot ?? 1;
}

/* A rotation shorter than this is treated as having this much idle time
 * tacked on before the cycle repeats. Raised whenever Faruzan, or Prune or
 * Durin, is on the team (whichever's higher). */
export const MINIMUM_ROTATION_LENGTH = 16.0;
export const MINIMUM_ROTATION_LENGTH_WITH_FARUZAN = 20.0;
export const MINIMUM_ROTATION_LENGTH_WITH_PRUNE_OR_DURIN = 18.0;
// Anemo Resonance's 5% CD reduction cuts whichever minimum applies (20s -> 19s with Faruzan).
export const ANEMO_RESONANCE_MINIMUM_ROTATION_REDUCTION = 0.05;

export function effectiveRotationLength(rawFieldTimeSum, faruzanPresent = false, pruneOrDurinPresent = false,
  anemoResonanceActive = false) {
  let minimum = MINIMUM_ROTATION_LENGTH;
  if (faruzanPresent) minimum = pyMax(minimum, MINIMUM_ROTATION_LENGTH_WITH_FARUZAN);
  if (pruneOrDurinPresent) minimum = pyMax(minimum, MINIMUM_ROTATION_LENGTH_WITH_PRUNE_OR_DURIN);
  if (anemoResonanceActive) minimum *= 1 - ANEMO_RESONANCE_MINIMUM_ROTATION_REDUCTION;
  return pyMax(minimum, rawFieldTimeSum);
}
