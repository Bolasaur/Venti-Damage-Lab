/* Shared dataclass-style plumbing for every character class.
 *
 * Each subclass declares ``static NAME`` (its class name, used everywhere the
 * engine dispatches on ``type(character).__name__``), ``static DEFAULTS``
 * (its dataclass fields and their default values, in declaration order),
 * ``static WEAPONS``/``WEAPON_DEFAULT_REFINEMENT``, and optionally a
 * ``postInit()`` hook (``__post_init__``). */
import { resolveArtifactSet } from '../artifacts.js';
import { weaponStatsAtRefinement } from '../formulas.js';
import { PyTypeError, pyRepr } from '../py.js';

/* Fields every character has on top of its own ``DEFAULTS``: the two picked
 * effects of a "2pc/2pc" set, and the Energy Recharge Emblem scales off
 * (a fraction -- 2.0 is 200%). Only read when that set is worn. */
export const COMMON_DEFAULTS = {
  two_piece_a: '18% ATK',
  two_piece_b: '18% ATK',
  energy_recharge: 1.0,
};

export class Character {
  constructor(options = {}) {
    const cls = this.constructor;
    const defaults = { ...cls.DEFAULTS, ...COMMON_DEFAULTS };
    for (const [name, value] of Object.entries(defaults)) this[name] = value;
    for (const [name, value] of Object.entries(options)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, name)) {
        throw new PyTypeError(`${cls.NAME}.__init__() got an unexpected keyword argument ${pyRepr(name)}`);
      }
      this[name] = value;
    }
    this._weaponStatsCache = null;
    this._artifactSet = resolveArtifactSet(this.artifact_set, {
      twoPieceA: this.two_piece_a, twoPieceB: this.two_piece_b, energyRecharge: this.energy_recharge,
    });
    this.postInit();
    if (this._artifactSet.stats !== null) this.artifacts = this.artifacts.withSetStats(this._artifactSet.stats);
  }

  postInit() {}

  /* The class's dataclass field names (``dataclasses.fields``). */
  static get FIELDS() {
    return [...Object.keys(this.DEFAULTS), ...Object.keys(COMMON_DEFAULTS)];
  }

  /* The worn set's bonuses, with "2pc/2pc"/Emblem resolved for this wearer --
   * always use this rather than ``ARTIFACT_SETS[this.artifact_set]``. Fixed
   * for the object's whole lifetime, like ``weaponStats``. */
  artifactSet() {
    return this._artifactSet;
  }

  /* Cached on the instance: fixed for the object's whole lifetime, since
   * ``weapon``/``weapon_refinement`` are set once at construction and never
   * reassigned. */
  weaponStats() {
    if (this._weaponStatsCache === null) {
      this._weaponStatsCache = weaponStatsAtRefinement(this.constructor.WEAPONS[this.weapon], this.weapon_refinement);
    }
    return this._weaponStatsCache;
  }
}
