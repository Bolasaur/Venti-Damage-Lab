/* Shared dataclass-style plumbing for every character class.
 *
 * Each subclass declares ``static NAME`` (its class name, used everywhere the
 * engine dispatches on ``type(character).__name__``), ``static DEFAULTS``
 * (its dataclass fields and their default values, in declaration order),
 * ``static WEAPONS``/``WEAPON_DEFAULT_REFINEMENT``, and optionally a
 * ``postInit()`` hook (``__post_init__``). */
import { weaponStatsAtRefinement } from '../formulas.js';
import { PyTypeError, pyRepr } from '../py.js';

export class Character {
  constructor(options = {}) {
    const cls = this.constructor;
    const defaults = cls.DEFAULTS;
    for (const [name, value] of Object.entries(defaults)) this[name] = value;
    for (const [name, value] of Object.entries(options)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, name)) {
        throw new PyTypeError(`${cls.NAME}.__init__() got an unexpected keyword argument ${pyRepr(name)}`);
      }
      this[name] = value;
    }
    this._weaponStatsCache = null;
    this.postInit();
  }

  postInit() {}

  /* The class's dataclass field names (``dataclasses.fields``). */
  static get FIELDS() {
    return Object.keys(this.DEFAULTS);
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
