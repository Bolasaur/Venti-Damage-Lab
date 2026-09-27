/* The page's side of the engine: stands in for the old Python server's HTTP
 * API. ``request(path, body)`` takes the same paths and returns the same
 * payloads the server did, but every number is computed locally, in Web
 * Workers, so the page runs as plain static files with no server at all.
 *
 *   /api/bootstrap  -- starting state + static UI constants
 *   /api/calc       -- a full calculation of the posted state
 *   /api/preset     -- rolled-out substats for one "Apply preset"
 *   /api/optimize   -- the "Cost Scamming" optimizer
 *
 * The last calculated state is kept in localStorage (what the server used to
 * write to last_state.json) and restored on the next visit. Open the page
 * with ``?reset`` to discard it and start from the calculator's defaults. */

import { pickBest, resetTweakableCons, selectFinalists } from './optimizer.js';
import { errorPayload } from './py.js';

const STORAGE_KEY = 'venti-calculator:last-state';
const UNEXPECTED = 'Unexpected calculator error, see console';

const workerUrl = new URL('./worker.js', import.meta.url);

/* One worker, answering requests strictly in order. */
class EngineWorker {
  constructor() {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.nextId = 0;
    this.pending = new Map();
    this.worker.onmessage = (event) => {
      const { id, payload } = event.data;
      const callbacks = this.pending.get(id);
      this.pending.delete(id);
      if (callbacks) callbacks.resolve(payload);
    };
    this.worker.onerror = (event) => {
      console.error(event.message || event);
      for (const callbacks of this.pending.values()) callbacks.resolve({ error: UNEXPECTED });
      this.pending.clear();
    };
  }

  call(op, body) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ id, op, body });
    });
  }
}

let mainWorker = null;
const main = () => {
  if (mainWorker === null) mainWorker = new EngineWorker();
  return mainWorker;
};

/* The optimizer's worker pool -- one per logical core, like the old
 * server's process pool -- created on first use and kept for later runs. */
let pool = null;
function workerPool() {
  if (pool === null) {
    const size = Math.max(1, navigator.hardwareConcurrency || 4);
    pool = Array.from({ length: size }, () => new EngineWorker());
  }
  return pool;
}

/* ``executor.map``: runs every task across the pool, results in task order.
 * If any task failed, the error of the earliest failing task wins. */
async function poolMap(op, tasks) {
  const workers = workerPool();
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(workers.map(async (worker) => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker.call(op, tasks[index]);
    }
  }));
  const failed = results.find(isErrorPayload);
  if (failed) throw failed;
  return results;
}

const isErrorPayload = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload;

function loadSavedState() {
  try {
    if (new URLSearchParams(location.search).has('reset')) localStorage.removeItem(STORAGE_KEY);
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === null ? null : JSON.parse(saved);
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode, quota) -- restoring is a convenience only.
  }
}

async function bootstrap() {
  const payload = await main().call('bootstrap');
  const saved = loadSavedState();
  return saved === null ? payload : { ...payload, state: saved };
}

async function calc(state) {
  // Mirrors the server writing last_state.json before every calculation.
  saveState(state);
  return main().call('calc', state);
}

/* The Cost Scamming search, with its two heavy passes spread across the pool:
 * prepare (validation + fixed assumptions), each character's ceiling loadout,
 * score every composition, polish the top finalists, pick the winner. */
async function optimize(body) {
  const prepared = await main().call('optimizePrepare', body);
  if (prepared.error) return prepared;
  const { state, compositions, totalCost, f2p, artifactInvestment } = prepared;
  try {
    const names = Object.keys(state.characters);
    const ceilings = await poolMap('ceiling', names.map((name) => ({ state, name, f2p, artifactInvestment })));
    const ceilingLoadouts = Object.fromEntries(names.map((name, index) => [name, ceilings[index]]));
    resetTweakableCons(state);

    const coarse = await poolMap('score', compositions.map((composition) => ({
      composition, state, f2p, artifactInvestment, totalCost, ceilingLoadouts,
    })));
    const finalists = selectFinalists(coarse, totalCost);

    const polished = await poolMap('polish', finalists.map(([, composition, snapshot]) => ({
      composition, state: snapshot, f2p, artifactInvestment, totalCost,
    })));
    // Round-trip through JSON like the server's response did, so the result
    // shares no object references with anything else.
    return JSON.parse(JSON.stringify(pickBest(polished, totalCost)));
  } catch (failure) {
    return isErrorPayload(failure) ? failure : errorPayload(failure);
  }
}

/* Drop-in replacement for the old ``fetch`` calls: same paths, same payloads. */
export async function request(path, body) {
  if (path.startsWith('/api/bootstrap')) return bootstrap();
  if (path.startsWith('/api/calc')) return calc(body);
  if (path.startsWith('/api/preset')) return main().call('preset', body);
  if (path.startsWith('/api/defaults')) return main().call('defaults');
  if (path.startsWith('/api/optimize')) return optimize(body);
  return { error: 'Unknown endpoint' };
}
