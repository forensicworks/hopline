'use strict';
/** Small statistics for the benchmark: proportions with a 95% interval, and the way they are written. */

/** k out of n with the Wilson score interval: { k, n, p, lo, hi }. p, lo and hi are null when n is 0. */
function wilson(k, n, z) {
  z = z || 1.96;
  if (!n) return { k: k || 0, n: 0, p: null, lo: null, hi: null };
  const p = k / n, z2 = z * z, denom = 1 + z2 / n, centre = (p + z2 / (2 * n)) / denom, half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** 0.9234 -> "92.3%"; null -> "n/a". */
function pct(x, digits) { return x == null ? 'n/a' : (x * 100).toFixed(digits == null ? 1 : digits) + '%'; }

/** "92.3% (88.1 to 95.1), 231 of 250" for a proportion made by wilson(); "none" when there were none. */
function prop(w) {
  if (!w || !w.n) return 'none';
  return pct(w.p) + ' (' + pct(w.lo) + ' to ' + pct(w.hi) + '), ' + w.k + ' of ' + w.n;
}

function mean(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; }

module.exports = { wilson, pct, prop, mean };
