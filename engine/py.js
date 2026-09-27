/* Python-semantics helpers.
 *
 * The engine is a line-by-line port of the original Python calculator, and a
 * few Python built-ins don't behave like their obvious JS equivalents. Every
 * damage number has to come out bit-for-bit identical to the Python version,
 * so each of those built-ins gets an exact re-implementation here:
 *
 *   - ``sum()`` over floats uses Neumaier compensated summation (CPython 3.12+),
 *     not a plain left-to-right add.
 *   - ``x % y`` on floats takes the sign of the divisor (JS ``%`` takes the
 *     dividend's), and ``x // y`` has its own floor-division algorithm.
 *   - ``round()`` is round-half-to-even on the exact binary value.
 *   - ``min``/``max`` keep the FIRST of equal values (matters for -0.0).
 *   - ``/`` raises ZeroDivisionError instead of producing Infinity/NaN.
 *   - ``int()``/``float()`` parse and validate like Python.
 *   - ``repr()`` of strings/sequences for error messages.
 */

export class PyError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
/* User-correctable errors the old server reported back to the UI verbatim
 * (it caught ValueError/KeyError/TypeError). */
export class ValueError extends PyError {}
export class KeyError extends PyError {}
export class PyTypeError extends PyError {}
/* Anything else was reported as a generic "Unexpected calculator error". */
export class ZeroDivisionError extends PyError {}

/* A value that is a Python ``int`` where it matters to ``pySum``: CPython
 * adds ints to a float sum WITHOUT compensation, and JS can't tell 350 from
 * 350.0, so the few nonzero int terms that reach a float sum are marked with
 * this (a zero never changes the result either way). */
export class PyIntValue {
  constructor(value) {
    this.value = value;
  }
}
export const pyIntValue = (value) => new PyIntValue(value);

/* ``sum(iterable)`` -- CPython 3.12+'s algorithm exactly: a leading run of
 * ints is summed exactly, the first float is added to that with a plain add,
 * and from then on every float goes through the Neumaier compensated update
 * while every int is added plainly; the compensation is applied at the end. */
export function pySum(values) {
  const n = values.length;
  let i = 0;
  let intSum = 0;
  while (i < n && values[i] instanceof PyIntValue) intSum += values[i++].value;
  if (i === n) return intSum;
  let f = intSum + values[i++];
  let c = 0;
  for (; i < n; i++) {
    const item = values[i];
    if (item instanceof PyIntValue) {
      f += item.value;
      continue;
    }
    const t = f + item;
    if (Math.abs(f) >= Math.abs(item)) c += (f - t) + item;
    else c += (item - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/* ``sum(fn(item) for item in items)``. */
export function pySumMap(items, fn) {
  return pySum(items.map(fn));
}

/* Python ``a / b`` for floats. */
export function div(a, b) {
  if (b === 0) throw new ZeroDivisionError('float division by zero');
  return a / b;
}

/* Python ``a % b`` for floats (CPython float_rem). */
export function pyMod(a, b) {
  if (b === 0) throw new ZeroDivisionError('float modulo');
  let mod = a % b;
  if (mod) {
    if ((b < 0) !== (mod < 0)) mod += b;
  } else {
    mod = b < 0 ? -0 : 0;
  }
  return mod;
}

/* Python ``a // b`` for floats (CPython float_floor_div / _float_div_mod). */
export function pyFloorDiv(a, b) {
  if (b === 0) throw new ZeroDivisionError('float floor division by zero');
  let mod = a % b;
  let q = (a - mod) / b;
  if (mod) {
    if ((b < 0) !== (mod < 0)) {
      mod += b;
      q -= 1.0;
    }
  }
  let floordiv;
  if (q) {
    floordiv = Math.floor(q);
    if (q - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = (a / b) < 0 || Object.is(a / b, -0) ? -0 : 0;
  }
  return floordiv;
}

/* Python ``max(a, b)``/``min(a, b)`` -- keep the first on ties. */
export const pyMax = (a, b) => (b > a ? b : a);
export const pyMin = (a, b) => (b < a ? b : a);

/* ``min(items, key=fn)`` -- first minimal item. */
export function minBy(items, key) {
  let best = items[0];
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]);
    if (k < bestKey) { best = items[i]; bestKey = k; }
  }
  return best;
}

/* ``min(items, key=lambda x: (a, b, c))`` -- lexicographic tuple key. */
export function minByTuple(items, key) {
  let best = items[0];
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]);
    if (tupleLess(k, bestKey)) { best = items[i]; bestKey = k; }
  }
  return best;
}

function tupleLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/* Python ``round(x)`` -- banker's rounding to an integer. */
export function pyRoundInt(x) {
  if (!Number.isFinite(x)) {
    throw new ValueError(Number.isNaN(x) ? 'cannot convert float NaN to integer' : 'cannot convert float infinity to integer');
  }
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/* Python ``round(x, ndigits)`` -- correctly rounded (half-even on the exact
 * binary value) to ``ndigits`` decimals, then back to the nearest double. */
export function pyRound(x, ndigits) {
  if (!Number.isFinite(x) || x === 0) return x;
  if (Math.abs(x) >= 1e21) return x;
  const negative = x < 0 || Object.is(x, -0);
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf('.');
  const intPart = exact.slice(0, point);
  const frac = exact.slice(point + 1);
  let kept = intPart + frac.slice(0, ndigits);
  const next = frac.charCodeAt(ndigits) - 48;
  const rest = frac.slice(ndigits + 1);
  const restNonZero = /[1-9]/.test(rest);
  const lastKept = kept.charCodeAt(kept.length - 1) - 48;
  const roundUp = next > 5 || (next === 5 && (restNonZero || lastKept % 2 === 1));
  if (roundUp) kept = incrementDigits(kept);
  const intLen = kept.length - ndigits;
  const text = `${kept.slice(0, intLen)}.${kept.slice(intLen)}`;
  const value = Number(text);
  return negative ? -value : value;
}

function incrementDigits(digits) {
  const chars = digits.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === '9') { chars[i] = '0'; i--; }
    else { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
  }
  return `1${chars.join('')}`;
}

/* Python ``int(value)`` for the value types a UI state can carry. */
export function pyInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw new PyError('cannot convert float infinity to integer');
    return Math.trunc(value) || 0;
  }
  if (typeof value === 'string') {
    const text = value.trim().replace(/_/g, (m, i, s) => (i > 0 && /\d/.test(s[i - 1]) && /\d/.test(s[i + 1] || '') ? '' : m));
    if (/^[+-]?\d+$/.test(text)) return Number(text) || 0;
    throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  if (value === null || value === undefined) {
    throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
}

/* Python ``float(value)``. */
export function pyFloat(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (/^[+-]?(\d+(_\d+)*)?(\.(\d+(_\d+)*)?)?(e[+-]?\d+(_\d+)*)?$/.test(text) && /\d/.test(text.split('e')[0])) {
      return Number(text.replace(/_/g, ''));
    }
    if (/^[+-]?(inf|infinity)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(text)) return NaN;
    throw new ValueError(`could not convert string to float: ${pyRepr(value)}`);
  }
  if (value === null || value === undefined) {
    throw new PyTypeError("float() argument must be a string or a real number, not 'NoneType'");
  }
  throw new PyTypeError(`float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}

/* Python truthiness, for ``bool(x)`` and ``x or default``. */
export function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0; // NaN is truthy in Python too
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/* ``dict.get(key, default)`` for plain objects -- only a genuinely missing
 * key falls back (a present ``null`` is returned as-is, like Python's None). */
export function get(obj, key, fallback) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

function pyTypeName(value) {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/* Python's str.isspace() set, for ``"".join(s.split())``. */
const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/* ``"".join(text.split())`` as a list of code points. */
export function stripAllWhitespace(text) {
  return Array.from(text).filter((ch) => !PY_WHITESPACE.has(ch.codePointAt(0)));
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/* Python ``repr()`` for the value types that appear in error messages. */
export function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return pyFloatRepr(value);
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return String(value);
}

/* ``repr(tuple)``. */
export function pyTupleRepr(values) {
  if (values.length === 1) return `(${pyRepr(values[0])},)`;
  return `(${values.map(pyRepr).join(', ')})`;
}

function pyFloatRepr(value) {
  // Integers stay integers here: every number that reaches an error message
  // in this engine came from ``int()`` (levels, refinements, positions).
  if (Number.isInteger(value)) return String(value);
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(text);
  if (match) {
    const [, sign, lead, rest, expSign, exp] = match;
    return `${sign}${lead}${rest ? `.${rest}` : ''}e${expSign}${exp.padStart(2, '0')}`;
  }
  return text;
}

function pyStrRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
      if (code < 0x100) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + quote;
}

/* What the old server sent back for an exception: a bad rotation string, an
 * unknown main stat, a duplicate slot -- all user-correctable -- are reported
 * verbatim so the UI can keep its last good numbers on screen. Anything else
 * is a genuine bug: logged, with a generic message. */
export function errorPayload(error) {
  if (error instanceof ValueError || error instanceof KeyError || error instanceof PyTypeError) {
    return { error: error.message || error.name };
  }
  console.error(error);
  return { error: 'Unexpected calculator error, see console' };
}

/* ``copy.deepcopy`` for JSON-shaped data. */
export function deepCopy(value) {
  return structuredClone(value);
}
