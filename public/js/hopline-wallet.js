/*
 * Hopline wallet ledger: turns the transactions the API returns for one address into the rows of a wallet overview (the kind of page
 * a wallet explorer shows): every transaction with its inputs on one side and its outputs on the other, what it did to the wallet,
 * the balance after it, and the labelled wallets it dealt with. Pure functions over plain data, no DOM, no network.
 *
 * Everything here is arithmetic on what the server said; it adds no guesses. Amounts are satoshis.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'), require('./hopline-io.js'), require('./hopline-style.js'));
  else root.HoplineWallet = factory(root.HoplineModel, root.HoplineIO, root.HoplineStyle);
}(typeof self !== 'undefined' ? self : this, function (Model, IO, Style) {
  'use strict';

  function nameOf(known, address) {
    var k = known && address ? known(address) : null;
    return k && k.label ? k : null;
  }

  /**
   * The rows of the ledger, newest first (the order the API gives them: unconfirmed first, then by block).
   *   address  the wallet
   *   txs      transactions in the API's format
   *   opts     { known(address) -> {label, pack?, category?} | null, balance (the confirmed balance in sats, when known) }
   * Returns { rows, assoc, totals }.
   * Row: { txid, confirmed, height, time, fee, weight, inputs, outputs, recv, sent, net, dir ('in'|'out'|'self'|'none'),
   *        inTotal, outTotal, balanceAfter (null for an unconfirmed transaction, or when the balance is not known) }.
   * The balance after a transaction is worked backwards from today's confirmed balance, so it is right even when only the newest
   * part of the history has been loaded.
   */
  function ledger(address, txs, opts) {
    opts = opts || {};
    var known = opts.known || null, rows = [], assoc = new Map();
    (txs || []).forEach(function (t) {
      var st = t.status || {}, inputs = [], outputs = [], recv = 0, sent = 0, inTotal = 0, outTotal = 0, seen = new Set();
      (t.vin || []).forEach(function (v) {
        var pv = v.prevout || {}, addr = pv.scriptpubkey_address || null, value = pv.value || 0, self = addr === address;
        var nm = nameOf(known, addr);
        inputs.push({ address: addr, value: value, coinbase: !!v.is_coinbase, self: self, label: nm ? nm.label : null, pack: nm ? nm.pack || null : null, prevTxid: v.txid || null, prevVout: v.vout });
        inTotal += value; if (self) sent += value;
        if (nm && !self && addr) { var a = assoc.get(addr) || { address: addr, label: nm.label, pack: nm.pack || null, category: nm.category || null, sanctions: nm.sanctions === true, txs: 0, asInput: 0, asOutput: 0 }; a.asInput += value; if (!seen.has('i' + addr)) { seen.add('i' + addr); a.txs++; } assoc.set(addr, a); }
      });
      (t.vout || []).forEach(function (o) {
        var addr = o.scriptpubkey_address || null, value = o.value || 0, self = addr === address, nm = nameOf(known, addr);
        var data = o.scriptpubkey_type === 'op_return' ? Model.decodeOpReturn(o.scriptpubkey) : null;
        outputs.push({ address: addr, value: value, type: o.scriptpubkey_type || null, self: self, label: nm ? nm.label : null, pack: nm ? nm.pack || null : null, data: data });
        outTotal += value; if (self) recv += value;
        if (nm && !self && addr) { var a = assoc.get(addr) || { address: addr, label: nm.label, pack: nm.pack || null, category: nm.category || null, sanctions: nm.sanctions === true, txs: 0, asInput: 0, asOutput: 0 }; a.asOutput += value; if (!seen.has('o' + addr) && !seen.has('i' + addr)) a.txs++; seen.add('o' + addr); assoc.set(addr, a); }
      });
      var net = recv - sent;
      rows.push({ txid: t.txid, confirmed: !!st.confirmed, height: st.block_height == null ? null : st.block_height, time: st.block_time == null ? null : st.block_time,
                  fee: t.fee == null ? null : t.fee, weight: t.weight == null ? null : t.weight, inputs: inputs, outputs: outputs, recv: recv, sent: sent, net: net,
                  dir: net > 0 ? 'in' : net < 0 ? 'out' : sent > 0 ? 'self' : 'none', inTotal: inTotal, outTotal: outTotal, balanceAfter: null });
    });
    if (opts.balance != null) {                                           // newest confirmed transaction: today's balance; each older one: that minus what the newer ones did
      var bal = opts.balance;
      rows.forEach(function (r) { if (!r.confirmed) return; r.balanceAfter = bal; bal -= r.net; });
    }
    var list = Array.from(assoc.values()).sort(function (a, b) { return b.txs - a.txs || (b.asInput + b.asOutput) - (a.asInput + a.asOutput) || (a.address < b.address ? -1 : 1); });
    var times = rows.map(function (r) { return r.time; }).filter(function (x) { return x != null; });
    var totals = { count: rows.length, pending: rows.filter(function (r) { return !r.confirmed; }).length, first: times.length ? Math.min.apply(null, times) : null, last: times.length ? Math.max.apply(null, times) : null,
                   recv: rows.reduce(function (t, r) { return t + r.recv; }, 0), sent: rows.reduce(function (t, r) { return t + r.sent; }, 0) };
    return { rows: rows, assoc: list, totals: totals };
  }

  /** What one transaction paid the wallet and took from it, leaving its own change out: in a transaction that spent from the wallet and paid part of it back, the part that came back (the smaller of the two) is the wallet's own. */
  function rowOthers(r) {
    var own = Math.min(r.recv, r.sent);
    return { from: r.recv - own, to: r.sent - own, own: own };
  }

  /**
   * What the wallet received from and sent to others, and what it only passed on to itself as change. The address's totals count that change both ways (it was sent, and it was received
   * again), so a wallet that was emptied and refilled by its own transactions shows far more received than other wallets ever paid it. Confirmed transactions only, as the totals are.
   * Returns { received, sent, own, ownTxs (in how many transactions), fromOthers, toOthers, count (the confirmed transactions it looked at) } in satoshis, over `rows` (the loaded ones):
   * received - sent equals fromOthers - toOthers. To others includes the fees.
   */
  function flow(rows) {
    var out = { received: 0, sent: 0, own: 0, ownTxs: 0, fromOthers: 0, toOthers: 0, count: 0 };
    (rows || []).forEach(function (r) {
      if (!r.confirmed) return;
      var o = rowOthers(r);
      out.count++; out.received += r.recv; out.sent += r.sent; out.fromOthers += o.from; out.toOthers += o.to;
      if (o.own > 0) { out.own += o.own; out.ownTxs++; }
    });
    return out;
  }

  /** The numbers of the summary from the address's own totals (the whole history, not just what is loaded). */
  function summary(stats) {
    var c = (stats && stats.chain_stats) || {}, m = (stats && stats.mempool_stats) || {};
    var funded = c.funded_txo_sum || 0, spent = c.spent_txo_sum || 0;
    return { received: funded, sent: spent, balance: funded - spent, txCount: c.tx_count || 0, pendingCount: m.tx_count || 0,
             pendingIn: m.funded_txo_sum || 0, pendingOut: m.spent_txo_sum || 0, pendingNet: (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0) };
  }


  // ---- finding things in a long history ---------------------------------------------------------------------
  /** What a row did, as one amount in sats: the net for a payment in or out, the amount moved for a move to itself. */
  function rowAmount(r) { return r.dir === 'self' ? r.sent : Math.abs(r.net); }

  /**
   * The rows that match f = { dir ('all' | 'in' | 'out'), text, from, to (unix seconds, both ends included), minSats, maxSats }; every part is optional.
   * text: every word must be found (case does not matter) in the transaction id, the block height, an address on either side, or the name of a labelled
   * wallet (its label and the list it came from). The amount range is on what the transaction did to the wallet. An unconfirmed transaction counts as the newest.
   */
  function filterRows(rows, f) {
    f = f || {};
    var words = String(f.text == null ? '' : f.text).toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(function (r) {
      if (f.dir && f.dir !== 'all' && r.dir !== f.dir) return false;
      var t = r.time == null ? Infinity : r.time;
      if (f.from != null && t < f.from) return false;
      if (f.to != null && t > f.to) return false;
      var a = rowAmount(r);
      if (f.minSats != null && a < f.minSats) return false;
      if (f.maxSats != null && a > f.maxSats) return false;
      if (words.length) {
        var hay = [r.txid, r.height == null ? '' : String(r.height)];
        r.inputs.concat(r.outputs).forEach(function (x) { if (x.address) hay.push(x.address); if (x.label) hay.push(x.label); if (x.pack) hay.push(x.pack); });
        hay = hay.join('\n').toLowerCase();
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
      }
      return true;
    });
  }

  // ---- who the wallet dealt with ----------------------------------------------------------------------------
  /**
   * Every wallet this one dealt with, labelled or not, biggest first: [{ address, label, pack, category, sanctions, txs, asInput, asOutput, volume }].
   * asInput is what they paid in (their inputs), asOutput what they received (their outputs); volume is the two together. known(address) gives the name, if any.
   */
  function counterparties(rows, address, known) {
    var map = new Map();
    rows.forEach(function (r) {
      var seen = new Set();
      function add(x, kind) {
        if (!x.address || x.address === address || x.self || x.coinbase) return;
        var c = map.get(x.address);
        if (!c) { c = { address: x.address, txs: 0, asInput: 0, asOutput: 0, volume: 0 }; map.set(x.address, c); }
        if (kind === 'in') c.asInput += x.value; else c.asOutput += x.value;
        c.volume += x.value;
        if (!seen.has(x.address)) { seen.add(x.address); c.txs++; }
      }
      r.inputs.forEach(function (x) { add(x, 'in'); }); r.outputs.forEach(function (x) { add(x, 'out'); });
    });
    var list = Array.from(map.values());
    list.forEach(function (c) {
      var k = known ? known(c.address) : null;
      c.label = k && k.label ? k.label : null; c.pack = k && k.pack ? k.pack : null; c.category = k && k.category ? k.category : null; c.sanctions = !!(k && k.sanctions);
    });
    return list.sort(function (a, b) { return b.volume - a.volume || b.txs - a.txs || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0); });
  }

  // ---- the balance over time ------------------------------------------------------------------------------------
  /**
   * The balance after each confirmed transaction, oldest first: { points: [{ time, balance, txid, net, height }], start: { time, balance } | null }.
   * `start` is the balance just before the oldest loaded transaction (0 when the whole history is loaded). Rows with no known balance are left out.
   */
  function balanceSeries(rows) {
    var pts = rows.filter(function (r) { return r.confirmed && r.time != null && r.balanceAfter != null; }).reverse()
      .map(function (r) { return { time: r.time, balance: r.balanceAfter, txid: r.txid, net: r.net, height: r.height }; });
    pts.sort(function (a, b) { return a.time - b.time; });                       // rows come newest first, so after reversing, equal times keep their order (stable sort)
    return { points: pts, start: pts.length ? { time: pts[0].time, balance: pts[0].balance - pts[0].net } : null };
  }

  // ---- the balance chart: round axes and a period ----------------------------------------------------------------------
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function utcParts(sec) { var d = new Date(sec * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), i: d.getUTCMinutes() }; }

  /** The smallest 1, 2 or 5 times a power of ten that is at least `raw`. */
  function niceStep(raw) {
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10 + 1e-12)), f = raw / pow;
    return (f <= 1.0000001 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  /**
   * Round values for the side axis of a chart: about `n` of them, from a multiple of the step at or below `lo` to one at or above `hi`.
   * Returns { ticks, lo, hi, step } where lo and hi are the first and last tick (so the axis can be stretched to them). `opts.integer` keeps the step a whole number (satoshis).
   */
  function niceTicks(lo, hi, n, opts) {
    n = Math.max(2, Math.round(n) || 5);
    if (!(hi > lo)) hi = lo + 1;
    var step = niceStep((hi - lo) / (n - 1));
    if (opts && opts.integer && step < 1) step = 1;
    var first = Math.floor(lo / step + 1e-9), last = Math.ceil(hi / step - 1e-9), ticks = [];
    for (var k = first; k <= last; k++) ticks.push(Number((k * step).toPrecision(12)));
    return { ticks: ticks, lo: ticks[0], hi: ticks[ticks.length - 1], step: step };
  }

  // From the finest step to the coarsest: the first one that gives no more ticks than the chart has room for is used.
  var TICK_PLANS = [['minute', 5], ['minute', 15], ['minute', 30], ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12], ['day', 1], ['day', 2], ['day', 5], ['day', 10], ['day', 15],
                    ['month', 1], ['month', 2], ['month', 3], ['month', 6], ['year', 1], ['year', 2], ['year', 5], ['year', 10], ['year', 20], ['year', 50], ['year', 100]];
  function ticksOf(unit, step, t0, t1) {
    var out = [], t, guard = 0;
    if (unit === 'minute' || unit === 'hour') {
      var gap = step * (unit === 'minute' ? 60 : 3600);
      for (t = Math.ceil(t0 / gap) * gap; t <= t1 && guard < 500; t += gap, guard++) out.push(t);
    } else if (unit === 'day') {
      var p0 = utcParts(t0), day = Date.UTC(p0.y, p0.m, p0.d) / 1000;
      for (; day <= t1 && guard < 500; day += 86400, guard++) {
        var dt = new Date(day * 1000), dom = dt.getUTCDate(), left = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate() - dom + 1;   // days left in the month, this one included
        if (day >= t0 && (dom - 1) % step === 0 && (step === 1 || left > step / 2)) out.push(day);                                                   // not one that crowds the 1st of the next month
      }
    } else if (unit === 'month') {
      var q = utcParts(t0), y = q.y, m = q.m;
      for (; guard < 2000; m++, guard++) {
        if (m > 11) { m = 0; y++; }
        t = Date.UTC(y, m, 1) / 1000; if (t > t1) break;
        if (t >= t0 && m % step === 0) out.push(t);
      }
    } else {
      for (var yr = utcParts(t0).y; guard < 500; yr++, guard++) {
        t = Date.UTC(yr, 0, 1) / 1000; if (t > t1) break;
        if (t >= t0 && yr % step === 0) out.push(t);
      }
    }
    return out;
  }
  function tickLabel(unit, t, first, withYear) {
    var p = utcParts(t);
    if (unit === 'minute' || unit === 'hour') return p.h === 0 && p.i === 0 ? p.d + ' ' + MONTH_NAMES[p.m] : pad2(p.h) + ':' + pad2(p.i);
    if (unit === 'day') return p.d + ' ' + MONTH_NAMES[p.m] + (withYear ? ' ' + p.y : '');
    if (unit === 'month') return MONTH_NAMES[p.m] + (p.m === 0 || first ? ' ' + p.y : '');
    return String(p.y);
  }
  /**
   * Ticks for a time axis between t0 and t1 (unix seconds), on round UTC moments (whole hours, days of the month, months, years), at most `max` of them:
   * [{ time, label }], oldest first. Where no step fits (a very short span, or one moment) the two ends are given with their date.
   */
  function timeTicks(t0, t1, max) {
    max = Math.max(2, Math.round(max) || 6);
    var span = t1 - t0, chosen = null;
    if (span > 0) {
      for (var i = 0; i < TICK_PLANS.length && !chosen; i++) {
        var unit = TICK_PLANS[i][0], step = TICK_PLANS[i][1];
        if (unit === 'day' && span > 400 * 86400) continue;
        var times = ticksOf(unit, step, t0, t1);
        if (times.length <= max) chosen = { unit: unit, times: times };
      }
    }
    if (!chosen || chosen.times.length < 2) {
      var short = span < 2 * 86400;
      var end = function (t) { var p = utcParts(t); return p.y + '-' + pad2(p.m + 1) + '-' + pad2(p.d) + (short ? ' ' + pad2(p.h) + ':' + pad2(p.i) : ''); };
      return span > 0 ? [{ time: t0, label: end(t0) }, { time: t1, label: end(t1) }] : [{ time: t0, label: end(t0) }];
    }
    var withYear = utcParts(chosen.times[0]).y !== utcParts(chosen.times[chosen.times.length - 1]).y;
    return chosen.times.map(function (t, i) { return { time: t, label: tickLabel(chosen.unit, t, i === 0, withYear) }; });
  }

  /**
   * The balance series cut to the period from..to (unix seconds): { start: { time, balance, at }, points }. `start` is the balance as the period opens
   * (that of the last transaction before it, or where the whole series started) and `at` is the moment that balance was struck, which is the moment a price is wanted for.
   */
  function windowSeries(series, from, to) {
    var before = null, inside = [];
    series.points.forEach(function (p) { if (p.time < from) before = p; else if (p.time <= to) inside.push(p); });
    return { start: { time: from, balance: before ? before.balance : series.start.balance, at: before ? before.time : series.start.time }, points: inside };
  }

  var PRESET_MONTHS = { '1m': 1, '6m': 6, '1y': 12 };
  /** The last month, six months or year up to `end` (unix seconds, UTC calendar months): { from, to }, or null for any other key. */
  function presetWindow(key, end) {
    var months = PRESET_MONTHS[key];
    if (!months || end == null) return null;
    var d = new Date(end * 1000), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    return { from: Math.floor(d.getTime() / 1000), to: end };
  }

  function isoDay(t) { return new Date(t * 1000).toISOString().slice(0, 10); }
  /** The From and To dates ("YYYY-MM-DD", UTC, both days included) that make the list show a period of the chart (unix seconds); the list takes whole days, so it reaches to the ends of the first and last day. */
  function periodDates(from, to) { return { from: isoDay(from), to: isoDay(to) }; }

  // ---- in and out per period: the bars under the balance chart, and moving the period with fingers --------------------------------
  var DAY = 86400;
  function startOf(unit, t) {
    if (unit === 'hour') return Math.floor(t / 3600) * 3600;
    if (unit === 'day') return Math.floor(t / DAY) * DAY;
    if (unit === 'week') return Math.floor((t - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY;      // weeks begin on a Monday (1 January 1970 was a Thursday)
    var p = utcParts(t);
    return (unit === 'month' ? Date.UTC(p.y, p.m, 1) : Date.UTC(p.y, 0, 1)) / 1000;
  }
  function nextStart(unit, t) {
    if (unit === 'hour') return t + 3600;
    if (unit === 'day') return t + DAY;
    if (unit === 'week') return t + 7 * DAY;
    var p = utcParts(t);
    return (unit === 'month' ? Date.UTC(p.y, p.m + 1, 1) : Date.UTC(p.y + 1, 0, 1)) / 1000;
  }
  /**
   * The periods for the in and out bars over a..b (unix seconds): the finest of hours, days, weeks (Monday to Sunday), months and years, in UTC, that gives no more than `max` of them.
   * Returns { unit, buckets: [{ from, to }] } (`to` is where the next one begins); the first and last may reach beyond a and b.
   */
  function barBuckets(a, b, max) {
    var units = ['hour', 'day', 'week', 'month', 'year'], list = [];
    for (var i = 0; i < units.length; i++) {
      var cap = i === units.length - 1 ? 1000 : Math.max(1, max);                       // years are the coarsest there is: all of them, however many
      list = [];
      for (var s = startOf(units[i], a); s <= b && list.length <= cap; s = list[list.length - 1].to) list.push({ from: s, to: nextStart(units[i], s) });
      if (list.length <= cap) return { unit: units[i], buckets: list };
    }
    return { unit: 'year', buckets: list };
  }
  /**
   * What came in and what went out in each of the periods: by what each transaction did to the wallet (its net), so in minus out is the change of the balance over the period.
   * `points` are balanceSeries points, oldest first; amountOf(point) gives a signed amount in the unit drawn (default: the net, in satoshis).
   * Returns [{ from, to, inn, out, ins, outs, count }]: the two totals (both positive), how many transactions came in and went out, and how many there were.
   */
  function barTotals(points, buckets, amountOf) {
    var out = buckets.map(function (k) { return { from: k.from, to: k.to, inn: 0, out: 0, ins: 0, outs: 0, count: 0 }; }), i = 0;
    amountOf = amountOf || function (p) { return p.net; };
    for (var j = 0; j < points.length && i < out.length; j++) {
      var p = points[j];
      while (i < out.length && p.time >= out[i].to) i++;
      if (i >= out.length) break;
      if (p.time < out[i].from) continue;
      var v = amountOf(p);
      out[i].count++;
      if (v > 0) { out[i].inn += v; out[i].ins++; } else if (v < 0) { out[i].out -= v; out[i].outs++; }
    }
    return out;
  }

  /** A period of the same length (or `minSpan` at least, the length of `bounds` at most) that lies within bounds { from, to }, as near to from..to as it can be. */
  function fitWindow(from, to, bounds, minSpan) {
    var span = Math.min(bounds.to - bounds.from, Math.max(minSpan || 0, to - from));
    if (from + span > bounds.to) from = bounds.to - span;
    if (from < bounds.from) from = bounds.from;
    return { from: Math.round(from), to: Math.round(from + span) };
  }
  /**
   * Two fingers moved: the period that puts the time under each finger (ta before tb, as they went down) under it again. xa and xb are where the fingers are now, in pixels from the
   * left edge of a plot that is pw wide. Null when the fingers crossed or came together. Kept within bounds { from, to } and no shorter than minSpan seconds.
   */
  function pinchWindow(ta, tb, xa, xb, pw, bounds, minSpan) {
    if (!(tb > ta) || !(xb - xa > 1) || !(pw > 0)) return null;
    var span = (tb - ta) / ((xb - xa) / pw), from = ta - xa / pw * span;
    return fitWindow(from, from + span, bounds, minSpan);
  }
  /** One finger moved dx pixels across a plot pw wide: the period from..to slides the other way, and stays within bounds { from, to }. */
  function panWindow(from, to, dx, pw, bounds) {
    var span = to - from, shift = -dx / pw * span;
    return fitWindow(from + shift, to + shift, bounds, 0);
  }

  // ---- the whole wallet: addresses spent together ------------------------------------------------------------------
  /**
   * Addresses that were spent together with this one in the transactions given (the common-input rule: inputs of one transaction usually share an owner),
   * and through them the addresses spent with those, and so on. A transaction that looks like a CoinJoin (opts.isMix(view) says so) links nothing.
   * Returns { members: [address, this one first], links: [{ txid, time, addresses }] (the transactions that joined members), skipped: { mix } }.
   * A heuristic: a CoinJoin, a PayJoin, a shared custodial wallet or a multisig breaks the assumption.
   */
  function cluster(address, txs, opts) {
    opts = opts || {};
    var parent = new Map(), links = [], skipped = { mix: 0 };
    function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    function add(x) { if (!parent.has(x)) parent.set(x, x); }
    function union(a, b) { add(a); add(b); var ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
    (txs || []).forEach(function (t) {
      var seen = new Set(), addrs = [];
      (t.vin || []).forEach(function (v) { var a = v.prevout && v.prevout.scriptpubkey_address; if (a && !seen.has(a)) { seen.add(a); addrs.push(a); } });
      if (addrs.length < 2) return;
      if (typeof opts.isMix === 'function') {
        var view = { coinbase: false, complete: true,
                     inputs: (t.vin || []).map(function (v) { var p = v.prevout || {}; return { address: p.scriptpubkey_address || null, amount: p.value || 0 }; }),
                     outputs: (t.vout || []).map(function (o) { return { address: o.scriptpubkey_address || null, amount: o.value || 0, type: o.scriptpubkey_type === 'op_return' ? 'data' : 'addr' }; }) };
        if (opts.isMix(view)) { skipped.mix++; return; }
      }
      for (var i = 1; i < addrs.length; i++) union(addrs[0], addrs[i]);
      links.push({ txid: t.txid, time: t.status && t.status.block_time != null ? t.status.block_time : null, addresses: addrs });
    });
    if (!parent.has(address)) return { members: [address], links: [], skipped: skipped };
    var root = find(address), members = [];
    parent.forEach(function (p, a) { if (find(a) === root && a !== address) members.push(a); });
    members.sort();
    var inCluster = new Set([address].concat(members));
    return { members: [address].concat(members), links: links.filter(function (l) { return l.addresses.some(function (a) { return inCluster.has(a); }); }), skipped: skipped };
  }

  // ---- starting a trace from the wallet page ---------------------------------------------------------------------
  /**
   * What the workspace is asked to open for "Trace from here": the wallet first, then the ticked transactions (only well-formed ids, each once, in the order given),
   * at most `max` entries in all (the workspace takes ten at a time). Returns { query (ids separated by spaces), txids (the ones kept), cut (how many did not fit) }.
   */
  function traceQuery(address, txids, max) {
    max = max || 10;
    var seen = new Set(), ids = [];
    (txids || []).forEach(function (t) { t = String(t == null ? '' : t).toLowerCase(); if (/^[0-9a-f]{64}$/.test(t) && !seen.has(t)) { seen.add(t); ids.push(t); } });
    var kept = ids.slice(0, Math.max(0, max - 1));
    return { query: [address].concat(kept).join(' '), txids: kept, cut: ids.length - kept.length };
  }

  /**
   * The transactions of one wallet as a graph, the way the workspace holds them, so the wallet page can hand over a workspace file and a report.
   *   txs   transactions in the API's format
   *   opts  { stats: GET /address/<address> (the totals the server keeps), at: when it was read (unix seconds), source: the API that answered,
   *           fetched: Map(txid -> { at, source }) saying when and from where each transaction arrived }
   */
  function graphOf(address, txs, opts) {
    opts = opts || {};
    var g = new Model.Graph();
    (txs || []).forEach(function (t) {
      var n = g.nodes.get(g.addTx(t)), f = opts.fetched && opts.fetched.get(t.txid);
      if (n && f) { n.source = f.source; n.fetchedAt = f.at; }
    });
    if (opts.stats) g.addAddressStats(address, opts.stats, { at: opts.at, source: opts.source, history: true });
    g.refreshDerived();
    return g;
  }

  var COLUMNS = ['txid', 'time_utc', 'time_unix', 'status', 'height', 'direction', 'received_sat', 'sent_sat', 'net_sat', 'fee_sat', 'balance_after_sat', 'inputs', 'outputs'];
  var FIAT_COLUMNS = ['fiat_currency', 'fiat_price_per_btc', 'fiat_received', 'fiat_sent', 'fiat_net'];
  function cell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    var s = /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : IO.defuse(String(v));                // a plain number is not a formula: a negative amount keeps its sign
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function side(list) { return list.map(function (x) { return (x.address || (x.data ? 'OP_RETURN' : 'non-standard')) + '=' + x.value; }).join(' '); }
  /**
   * The ledger as CSV text (one line per transaction; inputs and outputs as "address=sats" separated by spaces).
   * opts.fiat(sats, time) -> { value, price } as plain strings, or null, adds the columns fiat_currency, fiat_price_per_btc, fiat_received, fiat_sent and fiat_net; opts.currency names the currency.
   */
  function csv(rows, opts) {
    opts = opts || {};
    var fiat = typeof opts.fiat === 'function' ? opts.fiat : null;
    var out = [COLUMNS.concat(fiat ? FIAT_COLUMNS : []).join(',')];
    rows.forEach(function (r) {
      var line = [r.txid, r.time == null ? '' : Style.fmtTimeFull(r.time), r.time, r.confirmed ? 'confirmed' : 'unconfirmed', r.height, r.dir, r.recv, r.sent, r.net, r.fee, r.balanceAfter, side(r.inputs), side(r.outputs)];
      if (fiat) {
        var rv = fiat(r.recv, r.time), sn = fiat(r.sent, r.time), nt = fiat(r.net, r.time), any = rv || sn || nt;
        line = line.concat([any ? opts.currency || '' : '', any ? any.price : '', rv ? rv.value : '', sn ? sn.value : '', nt ? nt.value : '']);
      }
      out.push(line.map(cell).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  return { ledger: ledger, summary: summary, flow: flow, rowOthers: rowOthers, csv: csv, COLUMNS: COLUMNS, FIAT_COLUMNS: FIAT_COLUMNS, filterRows: filterRows, rowAmount: rowAmount, counterparties: counterparties, balanceSeries: balanceSeries, niceTicks: niceTicks, timeTicks: timeTicks, windowSeries: windowSeries, presetWindow: presetWindow, periodDates: periodDates, barBuckets: barBuckets, barTotals: barTotals, pinchWindow: pinchWindow, panWindow: panWindow, cluster: cluster, traceQuery: traceQuery, graphOf: graphOf };
}));
