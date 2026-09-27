/* Cost-constrained team optimizer -- the "Cost Scamming" feature.
 *
 * Searches weapon, artifact set, constellation level (on Venti/Nicole/Durin/
 * Albedo) and team-slot order for the highest-DPS team under a total-cost cap
 * and a few coarse build assumptions (artifact investment tier, an F2P weapon
 * restriction, a locked literal 4-star constellation level, plus Mona's own
 * F2P-keyed rule). It never invents its own damage formula -- every candidate
 * is scored by running the exact same pipeline the live UI uses, so the
 * optimizer only ever *chooses between* states the calculator would produce.
 *
 * ## Why this isn't a coordinate-ascent search
 *
 * Weapon-refinement cost and constellation cost draw from ONE shared linear
 * cost budget across MULTIPLE characters, and no single character's own sweep
 * will ever unilaterally sacrifice value on its own axis to let a teammate
 * claim more, even when that trade is jointly better.
 *
 * ## The knapsack-DP design
 *
 * Every present character with at least one nonzero-cost item in their own
 * build space is a **budget player**. For each composition,
 * ``optimizeBudgetPlayers`` runs a fixed-point loop: each round, it measures
 * every budget player's DPS delta at every affordable (weapon, constellation)
 * choice against a FROZEN snapshot of everyone else's current build
 * (``playerValueTable``), solves a multiple-choice knapsack DP over all
 * players at once (``knapsackBestCombo``), and only commits it if a real
 * score confirms it doesn't regress. The top few ranked compositions then get
 * a cheap EXACT polish pass (``exactPolish``) to close the knapsack's residual
 * approximation error.
 *
 * Artifact set is resolved OUTSIDE the budget-sharing machinery entirely (via
 * the ordinary ``optimizeLoadout`` sweep): a set never costs anything.
 *
 * The two big passes (scoring every composition, polishing the finalists) are
 * embarrassingly parallel; the browser layer fans them out across a pool of
 * Web Workers via ``scoreComposition``/``polishFinalist``. ``optimize`` below
 * runs the same steps sequentially. */
import * as VC from './index.js';
import * as ui from './state.js';
import { ValueError, deepCopy, get, pyInt, pyRepr, pyTruthy } from './py.js';

export const ARTIFACT_INVESTMENTS = ['low', 'medium', 'high', 'KQM', 'mine'];

/* Weapons a free-to-play build can reasonably have, at their own default
 * refinement. Anything already cost-bearing is *also* allowed under F2P. */
export const F2P_WEAPONS = new Set([
  'Rust', 'Flowing Purity', 'TTDS', 'Favonius Codex', "Moonweaver's Dawn",
  'Sapwood Blade', 'Favonius Sword', 'Favonius Bow', 'Stringless',
  'Harbinger of Dawn', 'Cinnabar Spindle', 'Slingshot', 'Exaiphanes',
]);

/* An untracked-cost 5-star (or a coincidentally-R5-default 4-star) that an
 * F2P player realistically wouldn't have -- deliberately excluded from
 * ``F2P_WEAPONS``, named explicitly so a genuine gap is noticeable. */
export const KNOWN_UNTRACKED_FIVE_STARS = new Set([
  'Skyward Atlas', 'Skyward Sword', 'Skyward Harp', "Amos' Bow", 'Lost Prayer', 'Aquila', 'Wolf Fang',
]);

/* Constellations the optimizer searches directly, via the knapsack -- these
 * cost real cost-budget points per level. */
export const TWEAKABLE_CON_CHARACTERS = ['Venti', 'Nicole', 'Durin', 'Albedo'];

/* Every other character with a modelled constellation: theirs cost nothing,
 * and a free/4-star constellation is purely luck-of-the-pull, so they're
 * locked up front to whichever single literal level ``four_star_con_level``
 * says, or left as ``base_state`` has them ("mine"). Mona is deliberately NOT
 * here -- her own ceiling is keyed to F2P status (``MONA_CON_LEVEL_BY_F2P``). */
export const FOUR_STAR_CON_CHARACTERS = ['Bennett', 'Faruzan', 'Fischl', 'Prune'];
export const FOUR_STAR_CON_LEVEL_OPTIONS = ['0', '2', '6', 'mine'];
const MONA_CON_LEVEL_BY_F2P = { true: 2, false: 4 };

const NON_LOCKED_ROSTER = Object.keys(VC.CHARACTER_ROSTER).filter((name) => name !== ui.LOCKED);

/* How many of the scored team compositions get the exact polish pass. */
export const FINALISTS_TO_POLISH = 3;

/* Every weapon ``name`` is allowed to try, under the current F2P setting. */
export function weaponPool(name, f2p) {
  const cls = VC.CHARACTER_ROSTER[name];
  if (!f2p) return Object.keys(cls.WEAPONS);
  return Object.keys(cls.WEAPONS).filter((weapon) => F2P_WEAPONS.has(weapon) || VC.TEAM_COST_WEAPONS.has(weapon));
}

/* This character's own main-stat structure -- independent of whichever
 * weapon/artifact-set the search is currently trying. */
function artifactShape(name) {
  return deepCopy(ui.characterDefaultState(name).artifacts);
}

/* A from-scratch artifact loadout at a given substat-investment tier, for a
 * specific (weapon, artifact set) pair. */
function investmentArtifacts(name, preset, weapon, artifactSet, weaponRefinement) {
  const shape = artifactShape(name);
  const mainStats = Object.fromEntries(ui.PIECES.map((piece) => [piece, shape[piece].main_stat.stat]));
  const substats = ui.presetLoadoutSubstats(name, preset, weapon, artifactSet, mainStats, { weaponRefinement });
  for (const piece of ui.PIECES) shape[piece].substats = substats[piece];
  return shape;
}

/* Mirrors the "Crit DMG <-> Crit Rate" shortcut button in app.js exactly,
 * roll-conversion convention included. */
function swapCircletCritMain(circlet) {
  const oldMain = circlet.main_stat.stat;
  const newMain = oldMain === 'crit_damage' ? 'crit_rate' : 'crit_damage';
  const oldSubstatStat = newMain;
  const newSubstatStat = oldMain;
  const oldValue = get(circlet.substats, oldSubstatStat, 0) || 0;
  const convertedValue = oldSubstatStat === 'crit_rate' ? oldValue * 2 : oldValue / 2;
  const swapped = deepCopy(circlet);
  swapped.main_stat = {
    stat: newMain,
    value: newMain === 'crit_rate' ? VC.CIRCLET_CRIT_RATE_MAIN_STAT : VC.CIRCLET_CRIT_DAMAGE_MAIN_STAT,
  };
  swapped.substats[oldSubstatStat] = 0;
  swapped.substats[newSubstatStat] = convertedValue;
  return swapped;
}

/* The real ``Team.cost()`` figure, plus one F2P-only surcharge: Albedo's C1
 * is free in the real cost model but realistically still costs an F2P player
 * a pull. The single source of truth for whether a candidate is affordable. */
function effectiveCost(state, resultCost, f2p) {
  let cost = resultCost;
  if (f2p && state.team.includes('Albedo')) {
    if (pyInt(get(state.characters.Albedo, 'con_level', 0)) >= 1) cost += 1;
  }
  return cost;
}

/* The total cost ``name`` alone contributes to the team for a given (weapon,
 * refinement, constellation) choice -- a cheap analytic mirror used only to
 * guide the knapsack, never trusted as the final word. */
function itemCost(name, weapon, weaponRefinement, conLevel, f2p) {
  let cost = VC.TEAM_COST_BASE_CHARACTERS.has(name) ? 1 : 0;
  cost += (VC.TEAM_COST_CONSTELLATIONS[name] ?? []).filter((level) => level <= conLevel).length;
  if (VC.TEAM_COST_WEAPONS.has(weapon)) cost += weaponRefinement;
  if (f2p && name === 'Albedo' && conLevel >= 1) cost += 1;
  return cost;
}

const shallowEqual = (a, b) => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
};

/* Every refinement level worth trying for ``weapon``. Only cost-bearing
 * weapons cost anything to refine; every other weapon is pinned to its own
 * default. A cost-bearing weapon whose stats are identical at R1 and R5 is
 * pruned down to just R1. */
function refinementLevelsToSearch(name, weapon) {
  const cls = VC.CHARACTER_ROSTER[name];
  if (!VC.TEAM_COST_WEAPONS.has(weapon)) return [cls.WEAPON_DEFAULT_REFINEMENT[weapon]];
  const raw = cls.WEAPONS[weapon];
  if (shallowEqual(VC.weaponStatsAtRefinement(raw, 1), VC.weaponStatsAtRefinement(raw, 5))) return [1];
  return VC.WEAPON_REFINEMENTS;
}

/* Fixed reference teammates used only to give a character something to stand
 * next to while ``ceilingLoadoutFor`` sizes up their own best gear. */
const REFERENCE_FILLERS = ['Nicole', 'Durin', 'Bennett', 'Fischl'];

/* Comfortably clears the reference team's own small fixed cost overhead -- a
 * real budget as low as 1-2 couldn't even fit it. */
const CEILING_SEARCH_BUDGET = 999;

function referenceTeamFor(name) {
  if (name === ui.LOCKED) return REFERENCE_FILLERS.slice(0, 3);
  const others = REFERENCE_FILLERS.filter((filler) => filler !== name);
  return [name, ...others.slice(0, 2)];
}

/* The cheapest this team composition could possibly cost. */
function floorCost(composition) {
  return 1 + composition.filter((name) => VC.TEAM_COST_BASE_CHARACTERS.has(name)).length;
}

function applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts) {
  const charState = state.characters[name];
  charState.weapon = weapon;
  charState.weapon_refinement = weaponRefinement;
  charState.artifact_set = artifactSet;
  charState.artifacts = artifacts;
}

/* One coordinate-ascent sweep over ``name``'s own weapon and artifact set,
 * teammates held fixed. Mutates ``state`` to the best feasible combo found
 * (or restores what they had going in). ``weapons``/``artifactSets`` override
 * the pools to search. When a candidate weapon is the one ``name`` already
 * wields, its refinement is kept as-is rather than reset to the default. */
function optimizeLoadout(state, name, f2p, artifactInvestment, totalCost, weapons = null, artifactSets = null) {
  const cls = VC.CHARACTER_ROSTER[name];
  const charState = state.characters[name];
  const original = [charState.weapon, charState.weapon_refinement, charState.artifact_set, charState.artifacts];
  const mineArtifacts = original[3]; // only actually read when artifactInvestment === "mine"
  const candidateWeapons = weapons !== null ? weapons : weaponPool(name, f2p);
  const candidateArtifactSets = artifactSets !== null ? artifactSets : Object.keys(VC.ARTIFACT_SETS);

  let best = null; // [dps, weapon, weaponRefinement, artifactSet, artifacts]
  for (const weapon of candidateWeapons) {
    const weaponRefinement = weapon === original[0] ? original[1] : cls.WEAPON_DEFAULT_REFINEMENT[weapon];
    for (const artifactSet of candidateArtifactSets) {
      const artifacts = artifactInvestment === 'mine'
        ? mineArtifacts : investmentArtifacts(name, artifactInvestment, weapon, artifactSet, weaponRefinement);
      applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
      const result = ui.score(state);
      const cost = effectiveCost(state, result.cost, f2p);
      if (cost > totalCost) continue;
      if (best === null || result.dps > best[0]) best = [result.dps, weapon, weaponRefinement, artifactSet, artifacts];
    }
  }

  if (best === null) {
    applyLoadout(state, name, ...original);
    return;
  }
  const [bestDps, weapon, weaponRefinement, artifactSet, artifacts] = best;

  if (artifactInvestment === 'mine') {
    // A user's own artifacts might have the "wrong" crit stat as their
    // circlet main for this build -- try flipping it, keep it only if it helps.
    const swapped = deepCopy(artifacts);
    swapped.circlet = swapCircletCritMain(swapped.circlet);
    applyLoadout(state, name, weapon, weaponRefinement, artifactSet, swapped);
    const swappedResult = ui.score(state);
    const swappedCost = effectiveCost(state, swappedResult.cost, f2p);
    if (swappedCost <= totalCost && swappedResult.dps > bestDps) return; // already live in ``state``
  }

  applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
}

/* ``name``'s own best (weapon, artifact set) among their NON-COST weapons,
 * constellations pinned to 0, evaluated in a small reference team. This makes
 * per-composition scoring start from a realistic loadout -- a zero-investment
 * baseline badly undervalues characters whose kit scales with their own gear.
 * VV is deliberately excluded: its value depends on which *slot* its wearer
 * sits in, which this single-character evaluation can't know. */
export function ceilingLoadoutFor(baseState, name, f2p, artifactInvestment) {
  const reference = deepCopy(baseState);
  reference.team = referenceTeamFor(name);
  // Reset EVERYONE else to a cost-free baseline first, so this sweep's cost
  // checks reflect only ``name``'s own candidate gear.
  for (const other of Object.keys(VC.CHARACTER_ROSTER)) {
    if (other === name) continue;
    if (TWEAKABLE_CON_CHARACTERS.includes(other)) reference.characters[other].con_level = 0;
    const otherPool = weaponPool(other, f2p);
    const otherNonCost = otherPool.filter((weapon) => !VC.TEAM_COST_WEAPONS.has(weapon));
    const weapon = otherNonCost.length ? otherNonCost[0] : otherPool[0];
    reference.characters[other].weapon = weapon;
    reference.characters[other].weapon_refinement = VC.CHARACTER_ROSTER[other].WEAPON_DEFAULT_REFINEMENT[weapon];
  }
  if (TWEAKABLE_CON_CHARACTERS.includes(name)) reference.characters[name].con_level = 0;
  const nonCostWeapons = weaponPool(name, f2p).filter((weapon) => !VC.TEAM_COST_WEAPONS.has(weapon));
  const nonVvSets = Object.keys(VC.ARTIFACT_SETS).filter((artifactSet) => artifactSet !== 'VV');
  optimizeLoadout(reference, name, f2p, artifactInvestment, CEILING_SEARCH_BUDGET, nonCostWeapons, nonVvSets);
  const charState = reference.characters[name];
  return {
    weapon: charState.weapon, weapon_refinement: charState.weapon_refinement,
    artifact_set: charState.artifact_set, artifacts: charState.artifacts,
  };
}

/* Present characters with at least one nonzero-cost item in their own build
 * space: every tweakable-constellation character, plus anyone whose weapon
 * pool includes a cost-bearing weapon (Fischl, Faruzan). */
function budgetPlayers(present, f2p) {
  return present.filter((name) => TWEAKABLE_CON_CHARACTERS.includes(name)
    || weaponPool(name, f2p).some((weapon) => VC.TEAM_COST_WEAPONS.has(weapon)));
}

/* 0, plus every real modelled constellation breakpoint up to ``maxCon``. A
 * level between two breakpoints delivers identical DPS at strictly higher
 * cost, so it's never worth searching. */
function conLevelsToSearch(name, maxCon) {
  const breakpoints = ui.modelledConstellations(VC.CHARACTER_ROSTER[name]);
  return [0, ...breakpoints.filter((level) => level <= maxCon)];
}

/* Every (weapon, refinement, constellation) candidate for one budget player,
 * at each weapon's own default refinement -- refinement is only searched
 * during ``exactPolish``. Pruned to what could possibly fit ``totalCost``. */
function playerItems(name, f2p, totalCost) {
  const isTweakable = TWEAKABLE_CON_CHARACTERS.includes(name);
  const maxCon = isTweakable ? ((f2p && name === 'Albedo') ? 1 : 6) : 0;
  const conLevels = isTweakable ? conLevelsToSearch(name, maxCon) : [0];
  const cls = VC.CHARACTER_ROSTER[name];
  const items = [];
  for (const weapon of weaponPool(name, f2p)) {
    const weaponRefinement = cls.WEAPON_DEFAULT_REFINEMENT[weapon];
    for (const conLevel of conLevels) {
      if (itemCost(name, weapon, weaponRefinement, conLevel, f2p) > totalCost) continue;
      items.push([weapon, weaponRefinement, conLevel]);
    }
  }
  return items;
}

/* For each item, applies it to ``name`` ALONE against the frozen rest of
 * ``state`` and records ``[cost, dpsDeltaVsCurrent, build]``. Restores
 * ``name``'s original build before returning. Every player's table in a
 * round must be built against the SAME frozen snapshot. */
function playerValueTable(state, name, items, f2p, artifactInvestment) {
  const charState = state.characters[name];
  const isTweakable = TWEAKABLE_CON_CHARACTERS.includes(name);
  const original = [charState.weapon, charState.weapon_refinement, charState.artifacts, pyInt(get(charState, 'con_level', 0))];
  const artifactSet = charState.artifact_set;
  const mineArtifacts = original[2];
  const baselineDps = ui.score(state).dps;

  const table = [];
  for (const [weapon, weaponRefinement, conLevel] of items) {
    const artifacts = artifactInvestment === 'mine'
      ? mineArtifacts : investmentArtifacts(name, artifactInvestment, weapon, artifactSet, weaponRefinement);
    applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
    if (isTweakable) charState.con_level = conLevel;
    const result = ui.score(state);
    const cost = itemCost(name, weapon, weaponRefinement, conLevel, f2p);
    const build = {
      weapon, weapon_refinement: weaponRefinement, artifact_set: artifactSet,
      artifacts, con_level: isTweakable ? conLevel : original[3],
    };
    table.push([cost, result.dps - baselineDps, build]);
  }

  applyLoadout(state, name, original[0], original[1], artifactSet, original[2]);
  if (isTweakable) charState.con_level = original[3];
  return table;
}

/* Multiple-choice knapsack DP: exactly one item per player, maximizing summed
 * DPS delta, total cost <= ``budget``. ``null`` only for a negative budget. */
function knapsackBestCombo(tables, budget) {
  const names = Object.keys(tables);
  if (budget < 0) return null;
  if (!names.length) return {};
  let bestValue = Array(budget + 1).fill(-Infinity);
  bestValue[0] = 0.0;
  let bestChoice = Array(budget + 1).fill(null);
  bestChoice[0] = {};

  for (const name of names) {
    const newValue = Array(budget + 1).fill(-Infinity);
    const newChoice = Array(budget + 1).fill(null);
    for (let costSoFar = 0; costSoFar <= budget; costSoFar++) {
      if (bestValue[costSoFar] === -Infinity) continue;
      for (const [itemCostValue, itemDelta, itemBuild] of tables[name]) {
        const totalCostHere = costSoFar + itemCostValue;
        if (totalCostHere > budget) continue;
        const candidateValue = bestValue[costSoFar] + itemDelta;
        if (candidateValue > newValue[totalCostHere]) {
          newValue[totalCostHere] = candidateValue;
          newChoice[totalCostHere] = { ...bestChoice[costSoFar], [name]: itemBuild };
        }
      }
    }
    bestValue = newValue;
    bestChoice = newChoice;
  }

  let bestTotal = -Infinity;
  let bestResult = null;
  for (let costHere = 0; costHere <= budget; costHere++) {
    if (bestValue[costHere] > bestTotal) {
      bestTotal = bestValue[costHere];
      bestResult = bestChoice[costHere];
    }
  }
  return bestResult;
}

function applyBudgetCombo(state, combo) {
  for (const [name, build] of Object.entries(combo)) {
    applyLoadout(state, name, build.weapon, build.weapon_refinement, build.artifact_set, build.artifacts);
    if (TWEAKABLE_CON_CHARACTERS.includes(name)) state.characters[name].con_level = build.con_level;
  }
}

/* The fixed-point loop for characters who share the cost budget: each round,
 * measure every player's DPS delta at every affordable choice against the
 * CURRENT frozen state, solve the knapsack, and only commit it if a real
 * score confirms it's affordable and an improvement. Stops at the first
 * non-improving round. */
function optimizeBudgetPlayers(state, players, f2p, artifactInvestment, totalCost, rounds = 2) {
  if (!players.length) return;
  let currentDps = ui.score(state).dps;
  for (let round = 0; round < rounds; round++) {
    const tables = {};
    for (const name of players) tables[name] = playerValueTable(state, name, playerItems(name, f2p, totalCost), f2p, artifactInvestment);
    const combo = knapsackBestCombo(tables, totalCost);
    if (combo === null || !Object.keys(combo).length) break;

    const snapshot = {};
    for (const name of players) {
      const charState = state.characters[name];
      snapshot[name] = [charState.weapon, charState.weapon_refinement, charState.artifact_set,
        charState.artifacts, pyInt(get(charState, 'con_level', 0))];
    }

    applyBudgetCombo(state, combo);
    const result = ui.score(state);
    const cost = effectiveCost(state, result.cost, f2p);
    if (cost <= totalCost && result.dps > currentDps) {
      currentDps = result.dps;
      continue;
    }

    for (const [name, [weapon, weaponRefinement, artifactSet, artifacts, conLevel]] of Object.entries(snapshot)) {
      applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
      if (TWEAKABLE_CON_CHARACTERS.includes(name)) state.characters[name].con_level = conLevel;
    }
    break;
  }
}

/* Every (weapon, refinement, artifacts, constellation) candidate for
 * ``name``, artifact set FIXED at whatever ``state`` currently has -- used by
 * ``exactPolish``'s full enumeration. Constellation only varies for tweakable
 * characters; everyone else keeps their current, fixed level. */
function weaponConItems(state, name, f2p, artifactInvestment, totalCost) {
  const artifactSet = state.characters[name].artifact_set;
  const mineArtifacts = state.characters[name].artifacts;
  const isTweakable = TWEAKABLE_CON_CHARACTERS.includes(name);
  const maxCon = isTweakable ? ((f2p && name === 'Albedo') ? 1 : 6) : 0;
  const currentCon = pyInt(get(state.characters[name], 'con_level', 0));
  const conLevels = isTweakable ? conLevelsToSearch(name, maxCon) : [currentCon];
  const items = [];
  for (const weapon of weaponPool(name, f2p)) {
    for (const weaponRefinement of refinementLevelsToSearch(name, weapon)) {
      const artifacts = artifactInvestment === 'mine'
        ? mineArtifacts : investmentArtifacts(name, artifactInvestment, weapon, artifactSet, weaponRefinement);
      for (const conLevel of conLevels) {
        if (itemCost(name, weapon, weaponRefinement, conLevel, f2p) > totalCost) continue;
        items.push([weapon, weaponRefinement, artifacts, conLevel]);
      }
    }
  }
  return items;
}

/* Exact (weapon x constellation) sweep for one budget player, set fixed. */
function exactPolishSingle(state, name, f2p, artifactInvestment, totalCost) {
  const charState = state.characters[name];
  const artifactSet = charState.artifact_set;
  const original = [charState.weapon, charState.weapon_refinement, charState.artifacts, pyInt(get(charState, 'con_level', 0))];

  let best = null;
  for (const [weapon, weaponRefinement, artifacts, conLevel] of weaponConItems(state, name, f2p, artifactInvestment, totalCost)) {
    applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
    charState.con_level = conLevel;
    const result = ui.score(state);
    const cost = effectiveCost(state, result.cost, f2p);
    if (cost > totalCost) continue;
    if (best === null || result.dps > best[0]) best = [result.dps, weapon, weaponRefinement, artifacts, conLevel];
  }

  if (best === null) {
    applyLoadout(state, name, original[0], original[1], artifactSet, original[2]);
    charState.con_level = original[3];
    return;
  }
  const [, weapon, weaponRefinement, artifacts, conLevel] = best;
  applyLoadout(state, name, weapon, weaponRefinement, artifactSet, artifacts);
  charState.con_level = conLevel;
}

/* Full O(N^2) exact joint search over BOTH players' own (weapon,
 * constellation), artifact set fixed for each. */
function exactPolishPair(state, nameA, nameB, f2p, artifactInvestment, totalCost) {
  const charA = state.characters[nameA];
  const charB = state.characters[nameB];
  const setA = charA.artifact_set;
  const setB = charB.artifact_set;
  const originalA = [charA.weapon, charA.weapon_refinement, charA.artifacts, pyInt(get(charA, 'con_level', 0))];
  const originalB = [charB.weapon, charB.weapon_refinement, charB.artifacts, pyInt(get(charB, 'con_level', 0))];
  const itemsA = weaponConItems(state, nameA, f2p, artifactInvestment, totalCost);
  const itemsB = weaponConItems(state, nameB, f2p, artifactInvestment, totalCost);

  let best = null;
  for (const [weaponA, refA, artifactsA, conA] of itemsA) {
    applyLoadout(state, nameA, weaponA, refA, setA, artifactsA);
    charA.con_level = conA;
    for (const [weaponB, refB, artifactsB, conB] of itemsB) {
      applyLoadout(state, nameB, weaponB, refB, setB, artifactsB);
      charB.con_level = conB;
      const result = ui.score(state);
      const cost = effectiveCost(state, result.cost, f2p);
      if (cost > totalCost) continue;
      if (best === null || result.dps > best[0]) {
        best = [result.dps, weaponA, refA, artifactsA, conA, weaponB, refB, artifactsB, conB];
      }
    }
  }

  if (best === null) {
    applyLoadout(state, nameA, originalA[0], originalA[1], setA, originalA[2]);
    charA.con_level = originalA[3];
    applyLoadout(state, nameB, originalB[0], originalB[1], setB, originalB[2]);
    charB.con_level = originalB[3];
    return;
  }
  const [, weaponA, refA, artifactsA, conA, weaponB, refB, artifactsB, conB] = best;
  applyLoadout(state, nameA, weaponA, refA, setA, artifactsA);
  charA.con_level = conA;
  applyLoadout(state, nameB, weaponB, refB, setB, artifactsB);
  charB.con_level = conB;
}

/* The exact backstop for the knapsack's residual approximation error -- only
 * ever run on ``FINALISTS_TO_POLISH`` compositions:
 *   - 0 or 1 budget player: a single exact (weapon, con) sweep.
 *   - Exactly 2: the full O(N^2) joint search.
 *   - 3 or 4: a couple of rounds of pairwise joint optimization over every
 *     pair (not a true N-way optimum, but converges much better than
 *     one-at-a-time coordinate ascent). */
function exactPolish(state, players, f2p, artifactInvestment, totalCost) {
  if (!players.length) return;
  if (players.length === 1) {
    exactPolishSingle(state, players[0], f2p, artifactInvestment, totalCost);
    return;
  }
  if (players.length === 2) {
    exactPolishPair(state, players[0], players[1], f2p, artifactInvestment, totalCost);
    return;
  }
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        exactPolishPair(state, players[i], players[j], f2p, artifactInvestment, totalCost);
      }
    }
  }
}

/* Nicole's own ``burst_enabled`` toggle costs nothing but isn't a strict
 * upgrade: it adds her burst damage and projections but also +2s of field
 * time, stretching the whole rotation. Both are tried; the better one kept. */
function optimizeNicoleBurst(state, present) {
  if (!present.includes('Nicole')) return;
  const charState = state.characters.Nicole;
  const original = pyTruthy(get(charState, 'burst_enabled', true));
  const originalDps = ui.score(state).dps;
  charState.burst_enabled = !original;
  const flippedDps = ui.score(state).dps;
  if (flippedDps <= originalDps) charState.burst_enabled = original;
}

/* One full loadout pass for every present character. Order: settle artifact
 * set for everyone with weapon pinned; optimize budget players' weapon +
 * constellation (approximate or exact); let non-budget-players' weapon react;
 * let budget players' artifact set react; finally Nicole's burst toggle. */
function refineComposition(state, present, f2p, artifactInvestment, totalCost, polish) {
  const allArtifactSets = Object.keys(VC.ARTIFACT_SETS);
  const players = budgetPlayers(present, f2p);
  const nonPlayers = present.filter((name) => !players.includes(name));

  for (const name of present) {
    optimizeLoadout(state, name, f2p, artifactInvestment, totalCost, [state.characters[name].weapon], allArtifactSets);
  }

  if (polish) exactPolish(state, players, f2p, artifactInvestment, totalCost);
  else optimizeBudgetPlayers(state, players, f2p, artifactInvestment, totalCost);

  for (const name of nonPlayers) optimizeLoadout(state, name, f2p, artifactInvestment, totalCost);
  for (const name of players) {
    optimizeLoadout(state, name, f2p, artifactInvestment, totalCost, [state.characters[name].weapon], allArtifactSets);
  }

  optimizeNicoleBurst(state, present);
}

/* Worker task for the coarse-scoring pass: every team-slot permutation is
 * scored independently. ``state`` is this worker's own copy, safe to mutate.
 * Returns ``[dps, composition, state]``, or ``null`` if it doesn't fit. */
export function scoreComposition({ composition, state, f2p, artifactInvestment, totalCost, ceilingLoadouts }) {
  state.team = [...composition];
  const present = [ui.LOCKED, ...composition];
  for (const name of present) {
    const loadout = ceilingLoadouts[name];
    applyLoadout(state, name, loadout.weapon, loadout.weapon_refinement, loadout.artifact_set, loadout.artifacts);
  }
  refineComposition(state, present, f2p, artifactInvestment, totalCost, false);
  const result = ui.score(state);
  const cost = effectiveCost(state, result.cost, f2p);
  if (cost > totalCost) return null;
  return [result.dps, composition, state];
}

/* Worker task for the finalist exact-polish pass. Returns
 * ``[dps, state, cost]``, or ``null``. */
export function polishFinalist({ composition, state, f2p, artifactInvestment, totalCost }) {
  const present = [ui.LOCKED, ...composition];
  refineComposition(state, present, f2p, artifactInvestment, totalCost, true);
  const result = ui.score(state);
  const cost = effectiveCost(state, result.cost, f2p);
  if (cost > totalCost) return null;
  return [result.dps, state, cost];
}

function* permutations(items, size) {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest, size - 1)) yield [items[i], ...tail];
  }
}

/* Validation plus the fixed, non-searched assumptions: the ready-to-search
 * state and every composition that could possibly fit ``total_cost``.
 * ``fourStarConLevel`` is the shared, literal, non-searched constellation
 * level locked onto every free-constellation character except Mona (or
 * ``"mine"`` to keep ``baseState``'s own levels). ``excludeBennettAbsorption``
 * stops the search crediting Bennett with granting Venti's absorption. */
export function prepareOptimize(baseState, {
  artifactInvestment, f2p, fourStarConLevel, totalCost, excludeBennettAbsorption = false,
}) {
  if (!ARTIFACT_INVESTMENTS.includes(artifactInvestment)) throw new ValueError(`Unknown artifact_investment ${pyRepr(artifactInvestment)}`);
  if (!FOUR_STAR_CON_LEVEL_OPTIONS.includes(fourStarConLevel)) throw new ValueError(`Unknown four_star_con_level ${pyRepr(fourStarConLevel)}`);
  const cost = pyInt(totalCost);
  if (cost < 1) throw new ValueError('total_cost must be at least 1');

  const state = deepCopy(baseState);

  // -- fixed, non-searched assumptions
  if (fourStarConLevel !== 'mine') {
    const level = pyInt(fourStarConLevel);
    for (const name of FOUR_STAR_CON_CHARACTERS) state.characters[name].con_level = level;
  }
  state.characters.Mona.con_level = MONA_CON_LEVEL_BY_F2P[f2p];
  state.settings.bennett_absorption_eligible = !excludeBennettAbsorption;

  const compositions = [...permutations(NON_LOCKED_ROSTER, 3)].filter((c) => floorCost(c) <= cost);
  if (!compositions.length) throw new ValueError(`No team composition can fit within a total cost of ${cost}`);
  return { state, compositions, totalCost: cost };
}

/* ``state`` after the ceiling pass: tweakable constellations reset to 0. */
export function resetTweakableCons(state) {
  for (const name of TWEAKABLE_CON_CHARACTERS) state.characters[name].con_level = 0;
}

/* The coarse pass's survivors, best first (stable), cut to the finalists. */
export function selectFinalists(outcomes, totalCost) {
  const scored = outcomes.filter((outcome) => outcome !== null);
  if (!scored.length) throw new ValueError(`No team composition fits within a total cost of ${totalCost} with these settings`);
  scored.sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0));
  return scored.slice(0, FINALISTS_TO_POLISH);
}

export function pickBest(outcomes, totalCost) {
  let best = null;
  for (const outcome of outcomes) {
    if (outcome === null) continue;
    const [dps, polishedState, cost] = outcome;
    if (best === null || dps > best[0]) best = [dps, polishedState, cost];
  }
  if (best === null) throw new ValueError(`Could not find a feasible build within a total cost of ${totalCost}`);
  const [dps, winningState, cost] = best;
  return { state: winningState, dps, cost };
}

/* Find the highest-DPS team reachable within ``totalCost``. Returns a
 * ready-to-load UI state plus the winning ``dps``/``cost``. Sequential -- the
 * browser runs the same steps in parallel (see ``client.js``). */
export function optimize(baseState, params) {
  const { artifactInvestment, f2p } = params;
  const { state, compositions, totalCost } = prepareOptimize(baseState, params);
  const ceilingLoadouts = {};
  for (const name of Object.keys(VC.CHARACTER_ROSTER)) ceilingLoadouts[name] = ceilingLoadoutFor(state, name, f2p, artifactInvestment);
  resetTweakableCons(state);

  const coarse = compositions.map((composition) => scoreComposition({
    composition, state: deepCopy(state), f2p, artifactInvestment, totalCost, ceilingLoadouts: deepCopy(ceilingLoadouts),
  }));
  const finalists = selectFinalists(coarse, totalCost);
  const polished = finalists.map(([, composition, snapshot]) => polishFinalist({
    composition, state: deepCopy(snapshot), f2p, artifactInvestment, totalCost,
  }));
  return pickBest(polished, totalCost);
}
