/* ``RotationTimeline`` -- a team's real per-rotation play order and per-
 * character on-field windows, used to compute exactly how much of any given
 * buff's real duration actually reaches any given recipient. */
import { effectiveRotationLength, slotOf } from './formulas.js';
import { div, pyMax, pyMin, pyMod } from './py.js';

/* The team plays in a fixed cyclic order: highest slot first, Venti (slot 1)
 * always last, then back to the highest slot again. Each present character
 * occupies one contiguous arc of a circular timeline whose total length is
 * the rotation's own period, sized to their own ``field_time``.
 *
 * Every buff is treated as (re)cast the instant its own source LEAVES the
 * field (the end of that source's arc), every cycle -- except Nicole's own kit
 * buffs, which are (re)cast at the start of HER arc; callers pass
 * ``castAtSwapOut = false`` for those. Either way, a (re)cast is always fresh
 * by the time play returns to the source, so only one lap is ever modelled.
 *
 * ``field_time``/``arc_start`` are Maps keyed by character name. */
export class RotationTimeline {
  constructor(order, fieldTime, arcStart, period) {
    this.order = order;
    this.field_time = fieldTime;
    this.arc_start = arcStart;
    this.period = period;
  }

  static build(memberNames, characterLookup) {
    const order = [...memberNames].sort((a, b) => (-slotOf(characterLookup(a))) - (-slotOf(characterLookup(b))));
    const fieldTime = new Map(order.map((name) => [name, characterLookup(name).field_time]));
    const arcStart = new Map();
    let cursor = 0.0;
    for (const name of order) {
      arcStart.set(name, cursor);
      cursor += fieldTime.get(name);
    }
    return new RotationTimeline(order, fieldTime, arcStart, effectiveRotationLength(
      cursor, memberNames.includes('Faruzan'), memberNames.includes('Prune') || memberNames.includes('Durin'),
      order.filter((name) => characterLookup(name).element === 'Anemo').length >= 2));
  }

  /* A copy with one extra named recipient registered at an arbitrary
   * ``[start, start + span)`` window -- bookkeeping so an off-field ticking
   * sub-ability can reuse every per-recipient query. Never added to ``order``. */
  withVirtualRecipient(name, start, span) {
    const fieldTime = new Map(this.field_time);
    fieldTime.set(name, span);
    const arcStart = new Map(this.arc_start);
    arcStart.set(name, pyMod(start, this.period));
    return new RotationTimeline(this.order, fieldTime, arcStart, this.period);
  }

  /* The real (re)cast instant of a buff sourced from ``source``: the start of
   * its arc, or (by default) the END of it. */
  _castStart(source, castAtSwapOut) {
    const start = this.arc_start.get(source);
    return castAtSwapOut ? pyMod(start + this.field_time.get(source), this.period) : start;
  }

  _offsetFrom(castStart, targetStart) {
    const delta = targetStart - castStart;
    return delta < 0 ? delta + this.period : delta;
  }

  /* Fraction of ``recipient``'s own arc covered by a buff (re)cast every
   * cycle, lasting ``duration`` seconds from that (re)cast (``null`` = never
   * decays). For ``recipient == source`` under the default swap-out cast this
   * reads ~0 -- callers needing a source's own uptime on its own buff use a
   * hardcoded 1.0 instead. */
  windowedUptime(source, duration, recipient, castAtSwapOut = true) {
    if (!this.field_time.has(recipient) || !this.field_time.has(source)) return 0.0;
    if (duration === null) return 1.0;
    const offset = this._offsetFrom(this._castStart(source, castAtSwapOut), this.arc_start.get(recipient));
    const remaining = duration - offset;
    const fieldTime = this.field_time.get(recipient);
    return div(pyMax(0.0, pyMin(remaining, fieldTime)), fieldTime);
  }

  /* Whether that same (re)cast buff is still active at the exact instant
   * ``at``'s own arc begins -- for the snapshot abilities. */
  snapshotActive(source, duration, at, castAtSwapOut = true) {
    if (!this.field_time.has(at) || !this.field_time.has(source)) return false;
    if (duration === null) return true;
    return duration > this._offsetFrom(this._castStart(source, castAtSwapOut), this.arc_start.get(at));
  }

  /* Whether a buff (re)cast every cycle is active at an arbitrary absolute
   * ``instant`` -- the point-in-time primitive the per-hit engine uses. */
  activeAt(source, duration, instant, castAtSwapOut = true) {
    if (!this.arc_start.has(source)) return false;
    if (duration === null) return true;
    if (duration >= this.period) return true;
    const castStart = this._castStart(source, castAtSwapOut);
    let offset = pyMod(instant - castStart, this.period);
    // A hit landing exactly on a (re)cast instant AFTER wrapping one or more
    // full laps resolves to offset 0 by bare modulo arithmetic -- but real
    // play is strictly sequential, so that hit happens before the next lap's
    // opening cast and can only see the PREVIOUS cast, a full lap stale.
    if (offset === 0 && instant !== castStart) offset = this.period;
    return offset < duration;
  }

  /* ``activeAt``, spelled out for call sites that want to name the
   * "(re)cast every cycle" per-hit query explicitly. */
  recastActiveAt(source, duration, instant, castAtSwapOut = true) {
    return this.activeAt(source, duration, instant, castAtSwapOut);
  }

  /* Whoever plays immediately after ``source`` this cycle, or ``null`` if
   * ``source`` plays last (always true for Venti) or isn't present. */
  nextInPlayOrder(source) {
    const index = this.order.indexOf(source);
    if (index === -1) return null;
    return index + 1 < this.order.length ? this.order[index + 1] : null;
  }

  /* Whoever is actually on-field at the real, absolute ``instant``. Falls
   * back to whoever plays last during any idle gap after the last arc ends. */
  characterAt(instant) {
    if (!this.order.length) return null;
    const t = pyMod(instant, this.period);
    for (const name of this.order) {
      const start = this.arc_start.get(name);
      if (start <= t && t < start + this.field_time.get(name)) return name;
    }
    return this.order[this.order.length - 1];
  }
}
