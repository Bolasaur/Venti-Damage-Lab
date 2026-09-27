/* Substat investment presets: low / medium / high / KQM.
 *
 * Every preset is built the same way: a fixed number of discrete "rolls",
 * each worth a fixed amount of one stat (``SUBSTAT_ROLL_VALUE`` -- the real
 * average 5-star roll values Keqing Mains publishes, hence "KQM"), spent
 * across the 5-piece loadout under three hard rules (see ``RollAllocator``):
 *   - at most ``rollsPerPieceCap`` rolls total on any one piece,
 *   - at most ``rollsPerStatCap`` rolls of any one stat on any one piece,
 *   - a piece can never roll a substat matching its own main stat.
 * Crit is always split via the same 1:2-ratio calculus (``addCrit``): every
 * roll is worth the same crit value (2 * .0331 == .0662), and this solves for
 * how much of the pool should become crit rate to bring the WHOLE build to a
 * 1:2 ratio before converting back to whole rolls.
 *
 * KQM has two phases: every one of the 10 substats gets exactly 2 rolls first,
 * then the remaining 20 go entirely to whatever that character's role wants.
 * low/medium/high skip the universal phase and spend their whole budget on
 * the role-specific buckets directly.
 *
 * Also holds each character's raw default-loadout builder -- these go through
 * the same roll engine as "Apply preset" and the optimizer. */
import { ARTIFACT_SETS, Artifact, ArtifactLoadout, ArtifactStats, MainStat } from './artifacts.js';
import { ValueError, minByTuple, pyMax, pyMin, pyRepr, pyRoundInt, pySumMap } from './py.js';

export const SUBSTAT_ROLL_VALUE = {
  attack_percent: 0.0496,
  flat_attack: 16.54,
  defense_percent: 0.0620,
  flat_defense: 19.68,
  elemental_mastery: 19.8,
  crit_rate: 0.0331,
  crit_damage: 0.0662,
  hp: 298.75,
  hp_percent: 0.0496,
  energy_recharge: 0.0551,
};
/* Iteration order for KQM's universal "every stat gets 2 rolls" phase. */
export const ROLL_STATS = Object.keys(SUBSTAT_ROLL_VALUE);

export const CIRCLET_CRIT_RATE_MAIN_STAT = 0.311;
export const CIRCLET_CRIT_DAMAGE_MAIN_STAT = 0.622;

export const PIECES_IN_ROLL_ORDER = ['flower', 'feather', 'sands', 'goblet', 'circlet'];

/* Distributes discrete substat rolls across a 5-piece loadout. */
class RollAllocator {
  constructor(mainStatByPiece, { rollsPerPieceCap, rollsPerStatCap }) {
    this.mainStatByPiece = mainStatByPiece;
    this.rollsPerPieceCap = rollsPerPieceCap;
    this.rollsPerStatCap = rollsPerStatCap;
    // piece -> Map(stat -> count), insertion-ordered like the Python dicts.
    this.rolls = Object.fromEntries(PIECES_IN_ROLL_ORDER.map((piece) => [piece, new Map()]));
    this.pieceTotals = Object.fromEntries(PIECES_IN_ROLL_ORDER.map((piece) => [piece, 0]));
  }

  _mainStat(piece) {
    return this.mainStatByPiece[piece];
  }

  _eligiblePieces(stat) {
    return PIECES_IN_ROLL_ORDER.filter((piece) => this._mainStat(piece) !== stat
      && this.pieceTotals[piece] < this.rollsPerPieceCap
      && (this.rolls[piece].get(stat) ?? 0) < this.rollsPerStatCap);
  }

  /* How many more rolls of ``stat`` could still be placed anywhere. */
  capacityFor(stat) {
    let total = 0;
    for (const piece of PIECES_IN_ROLL_ORDER) {
      if (this._mainStat(piece) === stat) continue;
      total += pyMin(this.rollsPerStatCap - (this.rolls[piece].get(stat) ?? 0), this.rollsPerPieceCap - this.pieceTotals[piece]);
    }
    return total;
  }

  placedCount(stat) {
    let total = 0;
    for (const piece of PIECES_IN_ROLL_ORDER) total += this.rolls[piece].get(stat) ?? 0;
    return total;
  }

  placedValue(stat) {
    return this.placedCount(stat) * SUBSTAT_ROLL_VALUE[stat];
  }

  _place(piece, stat) {
    this.rolls[piece].set(stat, (this.rolls[piece].get(stat) ?? 0) + 1);
    this.pieceTotals[piece] += 1;
  }

  /* Places up to ``count`` rolls of ``stat``, one at a time, each on whichever
   * eligible piece currently holds the FEWEST TOTAL rolls (ties broken by
   * fewest rolls of this stat, then fixed piece order). Returns how many
   * actually placed. */
  add(stat, count) {
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const eligible = this._eligiblePieces(stat);
      if (!eligible.length) break;
      const piece = minByTuple(eligible, (p) => [this.pieceTotals[p], this.rolls[p].get(stat) ?? 0, PIECES_IN_ROLL_ORDER.indexOf(p)]);
      this._place(piece, stat);
      placed += 1;
    }
    return placed;
  }

  /* Splits ``total`` rolls across ``statsInPriorityOrder``, maxing out each
   * stat's real remaining capacity before spilling to the next. */
  addPriority(statsInPriorityOrder, total) {
    let remaining = total;
    for (const stat of statsInPriorityOrder) {
      if (remaining <= 0) break;
      const placed = this.add(stat, pyMin(remaining, this.capacityFor(stat)));
      remaining -= placed;
    }
  }

  /* Splits ``totalRolls`` between crit rate/crit damage at the 1:2 ratio.
   * The circlet is the only piece with just ONE usable crit stat, so it first
   * reserves at LEAST the minimum it must contribute for everything to fit;
   * the rest is placed one roll at a time, alternating between the stats. */
  addCrit(totalRolls, { existingCritRate, existingCritDamage }) {
    if (totalRolls <= 0) return;
    const pool = totalRolls * SUBSTAT_ROLL_VALUE.crit_damage; // a CR roll and a CD roll are worth the same CV
    const idealDeltaCritRate = (existingCritDamage + pool - 2 * existingCritRate) / 4;
    const maxDeltaCritRate = pyMin(pool / 2, pyMax(0.0, 1.0 - existingCritRate));
    const deltaCritRate = pyMin(pyMax(idealDeltaCritRate, 0.0), maxDeltaCritRate);
    const targetCritRate = pyMax(0, pyMin(totalRolls, pyRoundInt(deltaCritRate / SUBSTAT_ROLL_VALUE.crit_rate)));
    const targets = { crit_rate: targetCritRate, crit_damage: totalRolls - targetCritRate };
    const placed = { crit_rate: 0, crit_damage: 0 };

    const circletMain = this._mainStat('circlet');
    const circletOnlyStat = { crit_rate: 'crit_damage', crit_damage: 'crit_rate' }[circletMain];
    if (circletOnlyStat !== undefined) {
      const circletCapacity = pyMin(this.rollsPerStatCap - (this.rolls.circlet.get(circletOnlyStat) ?? 0),
        this.rollsPerPieceCap - this.pieceTotals.circlet);
      const reserved = pyMax(0, pyMin(circletCapacity, targets[circletOnlyStat]));
      for (let i = 0; i < reserved; i++) {
        this._place('circlet', circletOnlyStat);
        placed[circletOnlyStat] += 1;
      }
      // Any of this stat's target beyond what circlet could hold stays THIS
      // stat's target -- it can still land on the other 4 pieces below.
    }

    while (placed.crit_rate < targets.crit_rate || placed.crit_damage < targets.crit_damage) {
      let progressed = false;
      for (const stat of ['crit_rate', 'crit_damage']) {
        if (placed[stat] >= targets[stat]) continue;
        const gained = this.add(stat, 1);
        placed[stat] += gained;
        progressed = progressed || gained > 0;
      }
      if (!progressed) break; // genuinely out of capacity
    }
  }

  toSubstats() {
    const substats = {};
    for (const piece of PIECES_IN_ROLL_ORDER) {
      const values = {};
      for (const [stat, count] of this.rolls[piece]) values[stat] = count * SUBSTAT_ROLL_VALUE[stat];
      substats[piece] = new ArtifactStats(values);
    }
    return substats;
  }
}

export const PRESET_TIERS = ['low', 'medium', 'high', 'KQM'];

const KQM_TOTAL_ROLLS = 40;
const KQM_ROLLS_PER_PIECE_CAP = 8;
const KQM_ROLLS_PER_STAT_CAP = 4;
const KQM_PHASE_ONE_ROLLS_PER_STAT = 2;
const KQM_PHASE_TWO_ROLLS = KQM_TOTAL_ROLLS - ROLL_STATS.length * KQM_PHASE_ONE_ROLLS_PER_STAT; // 20

const LOW_MEDIUM_ROLLS_PER_PIECE_CAP = 8;
const LOW_MEDIUM_ROLLS_PER_STAT_CAP = 4;
const HIGH_ROLLS_PER_PIECE_CAP = 9;
const HIGH_ROLLS_PER_STAT_CAP = 5;

/* Damage dealers (Venti/Albedo/Durin/Fischl). */
const DAMAGE_DEALER_ROLL_BUDGETS = {
  low: { crit: 20, percent: 5, flat: 2, useless: 13 },
  medium: { crit: 24, percent: 4, flat: 4, useless: 8 },
  high: { crit: 28, percent: 7, flat: 5, useless: 5 },
};
/* The "support" roster (Prune, Faruzan, Bennett, Mona): Energy Recharge is a
 * real bucket for them. */
const SUPPORT_PRESET_CHARACTERS = new Set(['Prune', 'Faruzan', 'Bennett', 'Mona']);
const SUPPORT_ROLL_BUDGETS = {
  low: { energy_recharge: 15, crit: 6, percent: 2, flat: 2, useless: 15 },
  medium: { energy_recharge: 15, crit: 10, percent: 3, flat: 4, useless: 8 },
  high: { energy_recharge: 18, crit: 16, percent: 4, flat: 2, useless: 5 },
};
/* Nicole: no crit investment at all -- pure ATK%/flat ATK plus inert filler. */
const NICOLE_ROLL_BUDGETS = {
  low: { percent: 6, flat: 6, useless: 28 },
  medium: { percent: 9, flat: 6, useless: 25 },
  high: { percent: 10, flat: 9, useless: 26 },
};
/* KQM's own character groupings. */
const KQM_CRIT_CHARACTERS = new Set(['Venti', 'Albedo', 'Durin', 'Fischl']);
const KQM_ENERGY_RECHARGE_CHARACTERS = new Set(['Mona', 'Bennett']);
const KQM_SPLIT_SUPPORT_CHARACTERS = new Set(['Prune', 'Faruzan']);

/* Which stats a character's own "useless" roll bucket spreads across. ``hp``
 * goes FIRST and ``hp_percent`` LAST deliberately: the budget exactly
 * saturates capacity, so the last-placed stat must be able to land anywhere,
 * and nothing is ever excluded from ``hp_percent``. */
function uselessStatsFor(characterName) {
  if (SUPPORT_PRESET_CHARACTERS.has(characterName)) return ['hp', 'hp_percent'];
  return ['hp', 'energy_recharge', 'hp_percent'];
}

function spreadEvenly(allocator, stats, total) {
  const base = Math.floor(total / stats.length);
  const extra = total % stats.length;
  stats.forEach((stat, index) => allocator.add(stat, base + (index < extra ? 1 : 0)));
}

/* Universal backstop: whatever's still short of the tier's real total after
 * every stat-specific rule has run is spent on inert filler, so the stated
 * roll budget is never silently under-delivered. */
function fillShortfall(allocator, characterName, expectedTotal) {
  const shortfall = expectedTotal - pySumMap(Object.values(allocator.pieceTotals), (count) => count);
  if (shortfall > 0) allocator.addPriority(uselessStatsFor(characterName), shortfall);
}

/* All five pieces' substats for one investment preset, rolled out via
 * ``RollAllocator``. Used both when a preset is applied to a live build and
 * when each character's raw default loadout is constructed. */
export function generatePresetSubstats(characterName, preset, mainStats, {
  weaponCritRate = 0, weaponCritDamage = 0, artifactSet = 'None', artifactSetCritRateEligible = true,
  teamCritRateBonus = 0, ascensionCritDamage = 0,
} = {}) {
  const isDefScaler = characterName === 'Albedo';
  const percentStat = isDefScaler ? 'defense_percent' : 'attack_percent';
  const flatStat = isDefScaler ? 'flat_defense' : 'flat_attack';

  let rollsPerPieceCap;
  let rollsPerStatCap;
  if (preset === 'KQM') [rollsPerPieceCap, rollsPerStatCap] = [KQM_ROLLS_PER_PIECE_CAP, KQM_ROLLS_PER_STAT_CAP];
  else if (preset === 'high') [rollsPerPieceCap, rollsPerStatCap] = [HIGH_ROLLS_PER_PIECE_CAP, HIGH_ROLLS_PER_STAT_CAP];
  else [rollsPerPieceCap, rollsPerStatCap] = [LOW_MEDIUM_ROLLS_PER_PIECE_CAP, LOW_MEDIUM_ROLLS_PER_STAT_CAP];
  const allocator = new RollAllocator(mainStats, { rollsPerPieceCap, rollsPerStatCap });

  const circletMain = mainStats.circlet ?? '';
  let existingCritRate = 0.05 + weaponCritRate + teamCritRateBonus;
  existingCritRate += artifactSetCritRateEligible ? ARTIFACT_SETS[artifactSet].four_piece_triggered_crit_rate : 0;
  let existingCritDamage = 0.5 + weaponCritDamage + ascensionCritDamage;
  if (circletMain === 'crit_rate') existingCritRate += CIRCLET_CRIT_RATE_MAIN_STAT;
  else if (circletMain === 'crit_damage') existingCritDamage += CIRCLET_CRIT_DAMAGE_MAIN_STAT;

  if (preset === 'KQM') {
    for (const stat of ROLL_STATS) allocator.add(stat, KQM_PHASE_ONE_ROLLS_PER_STAT);
    // Phase 1 already placed some crit -- fold it into "existing" so phase 2's
    // ratio math sees the WHOLE build.
    existingCritRate += allocator.placedValue('crit_rate');
    existingCritDamage += allocator.placedValue('crit_damage');

    if (KQM_CRIT_CHARACTERS.has(characterName)) {
      allocator.addCrit(KQM_PHASE_TWO_ROLLS, { existingCritRate, existingCritDamage });
    } else if (KQM_ENERGY_RECHARGE_CHARACTERS.has(characterName)) {
      allocator.addPriority(['energy_recharge', 'hp', 'hp_percent'], KQM_PHASE_TWO_ROLLS);
    } else if (KQM_SPLIT_SUPPORT_CHARACTERS.has(characterName)) {
      // ATK% goes first: Prune's sands/goblet/circlet are all ATK%-main, so it
      // has to claim flower/feather before the more flexible calls fill them.
      allocator.add('attack_percent', 5);
      allocator.add('energy_recharge', 10);
      allocator.addCrit(5, { existingCritRate, existingCritDamage });
    } else if (characterName === 'Nicole') {
      allocator.addPriority(['attack_percent', 'flat_attack', 'hp', 'energy_recharge', 'hp_percent'], KQM_PHASE_TWO_ROLLS);
    } else {
      throw new ValueError(`KQM has no roll rule for ${pyRepr(characterName)}`);
    }
    fillShortfall(allocator, characterName, KQM_TOTAL_ROLLS);
    return allocator.toSubstats();
  }

  const totalRolls = preset === 'high' ? 45 : 40;
  if (characterName === 'Nicole') {
    const budget = NICOLE_ROLL_BUDGETS[preset];
    allocator.add('attack_percent', budget.percent);
    allocator.add('flat_attack', budget.flat);
    spreadEvenly(allocator, uselessStatsFor(characterName), budget.useless);
  } else if (SUPPORT_PRESET_CHARACTERS.has(characterName)) {
    const budget = SUPPORT_ROLL_BUDGETS[preset];
    allocator.add(percentStat, budget.percent);
    allocator.add('energy_recharge', budget.energy_recharge);
    allocator.addCrit(budget.crit, { existingCritRate, existingCritDamage });
    allocator.add(flatStat, budget.flat);
    spreadEvenly(allocator, uselessStatsFor(characterName), budget.useless);
  } else {
    const budget = DAMAGE_DEALER_ROLL_BUDGETS[preset];
    allocator.addCrit(budget.crit, { existingCritRate, existingCritDamage });
    allocator.add(percentStat, budget.percent);
    allocator.add(flatStat, budget.flat);
    spreadEvenly(allocator, uselessStatsFor(characterName), budget.useless);
  }
  fillShortfall(allocator, characterName, totalRolls);
  return allocator.toSubstats();
}

function defaultCircletMainStat(critDamageCirclet, defScaling) {
  if (critDamageCirclet === null) {
    return defScaling ? new MainStat('defense_percent', 0.583) : new MainStat('attack_percent', 0.466);
  }
  return critDamageCirclet
    ? new MainStat('crit_damage', CIRCLET_CRIT_DAMAGE_MAIN_STAT)
    : new MainStat('crit_rate', CIRCLET_CRIT_RATE_MAIN_STAT);
}

/* Every character's raw default loadout (built once, at construction, from
 * whatever weapon/set/refinement/constellation they start with) goes through
 * the exact same roll engine "Apply preset" uses. */
function buildDefaultLoadout(character, characterName, {
  gobletMainStat, sandsMainStat = new MainStat('attack_percent', 0.466), critDamageCirclet = null, defScaling = false,
}) {
  const circletMainStat = defaultCircletMainStat(critDamageCirclet, defScaling);
  const mainStats = {
    flower: 'hp', feather: 'flat_attack', sands: sandsMainStat.stat, goblet: gobletMainStat.stat, circlet: circletMainStat.stat,
  };
  const weapon = character.weaponStats();
  const substats = generatePresetSubstats(characterName, character.substat_preset, mainStats, {
    weaponCritRate: (weapon.crit_rate ?? 0) + (weapon.front_burst_crit_rate ?? 0),
    weaponCritDamage: weapon.crit_damage ?? 0,
    artifactSet: character.artifact_set,
    artifactSetCritRateEligible: characterName !== 'Bennett' && characterName !== 'Faruzan',
    ascensionCritDamage: character.ascension_crit_damage ?? 0,
  });
  return new ArtifactLoadout({
    flower: new Artifact('Flower', new MainStat('hp', 4780), substats.flower),
    feather: new Artifact('Feather', new MainStat('flat_attack', 311), substats.feather),
    sands: new Artifact('Sands', sandsMainStat, substats.sands),
    goblet: new Artifact('Goblet', gobletMainStat, substats.goblet),
    circlet: new Artifact('Circlet', circletMainStat, substats.circlet),
  });
}

export const nicoleArtifacts = (c) => buildDefaultLoadout(c, 'Nicole', { gobletMainStat: new MainStat('attack_percent', 0.466) });

export const durinArtifacts = (c) => buildDefaultLoadout(c, 'Durin', {
  gobletMainStat: new MainStat('pyro_damage_bonus', 0.466), critDamageCirclet: c.circlet_crit_damage,
});

export const pruneArtifacts = (c) => buildDefaultLoadout(c, 'Prune', { gobletMainStat: new MainStat('attack_percent', 0.466) });

export const ventiArtifacts = (c) => buildDefaultLoadout(c, 'Venti', {
  gobletMainStat: new MainStat('anemo_damage_bonus', 0.466), critDamageCirclet: c.circlet_crit_damage,
});

export const bennettArtifacts = (c) => buildDefaultLoadout(c, 'Bennett', {
  gobletMainStat: new MainStat('pyro_damage_bonus', 0.466), sandsMainStat: new MainStat('energy_recharge', 51.8),
  critDamageCirclet: c.circlet_crit_damage,
});

export const faruzanArtifacts = (c) => buildDefaultLoadout(c, 'Faruzan', {
  gobletMainStat: new MainStat('anemo_damage_bonus', 0.466), sandsMainStat: new MainStat('energy_recharge', 51.8),
  critDamageCirclet: c.circlet_crit_damage,
});

export const fischlArtifacts = (c) => buildDefaultLoadout(c, 'Fischl', {
  gobletMainStat: new MainStat('electro_damage_bonus', 0.466), critDamageCirclet: c.circlet_crit_damage,
});

export const monaArtifacts = (c) => buildDefaultLoadout(c, 'Mona', {
  gobletMainStat: new MainStat('hydro_damage_bonus', 0.466), sandsMainStat: new MainStat('energy_recharge', 51.8),
  critDamageCirclet: c.circlet_crit_damage,
});

/* Albedo scales off DEF: his "percent"/"flat" buckets go to DEF%/Flat DEF,
 * on every piece including sands. Feather's main stat stays Flat ATK. */
export const albedoArtifacts = (c) => buildDefaultLoadout(c, 'Albedo', {
  gobletMainStat: new MainStat('geo_damage_bonus', 0.466), sandsMainStat: new MainStat('defense_percent', 0.583),
  critDamageCirclet: c.circlet_crit_damage, defScaling: true,
});
