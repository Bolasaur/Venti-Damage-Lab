/* The calculator's "server": a Web Worker that runs the engine off the main
 * thread. The page posts ``{id, op, body}`` and gets ``{id, payload}`` back,
 * where ``payload`` is exactly what the old Python server's endpoint returned
 * -- including ``{error}`` for anything that went wrong, so the UI keeps its
 * last good numbers on screen.
 *
 * The optimizer's parallel passes run on a pool of these same workers (see
 * ``client.js``); ``ceiling``/``score``/``polish`` are those per-task ops. */
import * as optimizer from './optimizer.js';
import { errorPayload, get, pyTruthy } from './py.js';
import * as ui from './state.js';
import { at } from './state.js';

const OPS = {
  bootstrap: () => ({ state: ui.defaultState(), constants: ui.uiConstants() }),
  defaults: () => ({ state: ui.defaultState() }),
  calc: (body) => ui.calculate(body),
  // Substats only -- the edited main stats are left alone. Crit is optimized
  // jointly across all five pieces (needs the weapon/artifact set for context).
  preset: (body) => ({
    substats: ui.presetLoadoutSubstats(get(body, 'character', null), at(body, 'preset'), at(body, 'weapon'),
      at(body, 'artifact_set'), at(body, 'main_stats'), {
        weaponRefinement: get(body, 'weapon_refinement', 1),
        monaC4Active: get(body, 'mona_c4_active', false),
      }),
  }),
  // -- "Cost Scamming" optimizer steps, orchestrated by client.js --
  optimizePrepare: (body) => {
    const params = optimizeParams(body);
    const prepared = optimizer.prepareOptimize(at(body, 'state'), params);
    return { ...prepared, f2p: params.f2p, artifactInvestment: params.artifactInvestment };
  },
  ceiling: ({ state, name, f2p, artifactInvestment }) => optimizer.ceilingLoadoutFor(state, name, f2p, artifactInvestment),
  score: (task) => optimizer.scoreComposition(task),
  polish: (task) => optimizer.polishFinalist(task),
  // The whole search in one worker, sequentially -- for testing.
  optimize: (body) => optimizer.optimize(at(body, 'state'), optimizeParams(body)),
};

function optimizeParams(body) {
  return {
    artifactInvestment: at(body, 'artifact_investment'),
    f2p: pyTruthy(at(body, 'f2p')),
    fourStarConLevel: at(body, 'four_star_con_level'),
    totalCost: at(body, 'total_cost'),
    excludeBennettAbsorption: pyTruthy(get(body, 'exclude_bennett_absorption', false)),
  };
}

self.onmessage = (event) => {
  const { id, op, body } = event.data;
  let payload;
  try {
    const handler = OPS[op];
    payload = handler ? handler(body) : { error: 'Unknown endpoint' };
  } catch (error) {
    payload = errorPayload(error);
  }
  self.postMessage({ id, payload });
};
