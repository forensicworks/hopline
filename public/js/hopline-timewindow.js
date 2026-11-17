/*
 * Hopline time window: what the blocks say about when a transaction can have been sent.
 *
 * The time on a transaction is the time of the block that holds it, which a miner sets. The transaction was sent earlier, by minutes or by hours. Two readings of the blocks narrow that,
 * and both are INFERENCES, kept apart from the chain's facts:
 *
 *   NOT BEFORE   A miner builds a block from the transactions it has seen and takes the best paying first. If the block before this transaction's block had room, or was full but this
 *                transaction paid well above what a quarter of its transactions paid, the transaction would have been taken into that block had it been waiting. So it was sent after that block's
 *                template was made: about the time of that block, less a few minutes for the time a miner takes to build one and because the time stamp is the miner's own.
 *   SIGNED AFTER Wallets such as Bitcoin Core and Electrum (and others) set a transaction's locktime to the height of the newest block when they sign (to discourage fee sniping), or up to
 *                a hundred blocks lower. A transaction with such a locktime was signed after the block at that height was found.
 *
 * Only the facts the data source gave are kept on the transaction (under ext.chainwindow): the blocks' times, weights, sizes and fee percentiles and the transaction's own fee, size and locktime.
 * The reading is worked out from them each time (infer), so it can be checked, and it is never stored as if it were data.
 * Pure functions over plain data, apart from lookup(), which asks the data source's client for the blocks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineTimeWindow = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROOM_MAX = 3900000;        // a block lighter than this (of 4,000,000 weight units) had room: nothing paying the usual fee was left out of it
  var MARGIN = 180;              // seconds: a miner starts building a block before it finds it, and the time stamp of a block is the miner's own
  var LOOKBACK = 3;              // how many blocks before the transaction's own are looked at, nearest first, until one can be used
  var LOCK_SPAN = 200;           // a locktime this many blocks (or fewer) below the block that holds the transaction looks like the height at the time of signing
  var MIN_RATE = 1;              // sat/vB: what nodes relay by default
  var FULL_FACTOR = 1.2;         // in a full block the transaction must pay this much above the 25th percentile of what its transactions paid
  var MIN_TIME = 1230768000, MAX_TIME = 4102444800;

  function fail(kind, message) { var e = new Error(message); e.kind = kind; return e; }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function num(v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null; }
  function int(v, lo, hi) { v = num(v, lo, hi); return v == null ? null : Math.floor(v); }

  /** A time as "2026-03-04 10:21:32 UTC". */
  function utcText(sec) { return typeof sec === 'number' && isFinite(sec) ? new Date(Math.floor(sec) * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : ''; }
  /** A length of time in words: "16 min 24 s". */
  function gapText(sec) {
    sec = Math.round(Math.abs(sec));
    if (sec < 60) return sec + ' s';
    if (sec < 3600) return Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s';
    return Math.floor(sec / 3600) + ' h ' + Math.floor(sec % 3600 / 60) + ' min';
  }
  function rateText(r) { return (Math.round(r * 10) / 10) + ' sat/vB'; }

  // ---- the reading -------------------------------------------------------------------------------------------------------------------

  /** The fee rate of the transaction in sat/vB, or null. */
  function rateOf(e) { return e && typeof e.fee === 'number' && e.vsize > 0 ? e.fee / e.vsize : null; }

  /**
   * Whether a block before the transaction's own says the transaction was not waiting when it was built: { ok, why } with why one of
   * room | above | empty | order | lowrate | full | nofees.
   */
  function judge(b, e, rate) {
    if (!b || typeof b.time !== 'number') return { ok: false, why: 'nodata' };
    if (!(b.txCount >= 2)) return { ok: false, why: 'empty' };                                       // a block with no transactions says nothing about the mempool
    if (!(b.time < e.blockTime)) return { ok: false, why: 'order' };                                 // time stamps are the miners' own and are not always in order
    if (rate == null || rate < MIN_RATE) return { ok: false, why: 'lowrate' };
    if (typeof b.weight === 'number' && b.weight <= ROOM_MAX) return { ok: true, why: 'room' };
    if (typeof b.p25 !== 'number') return { ok: false, why: 'nofees' };
    return rate >= Math.max(b.p25, 1) * FULL_FACTOR ? { ok: true, why: 'above' } : { ok: false, why: 'full' };
  }

  /** The locktime looks like the height at the time of signing, and its block is known. */
  function lockOk(e) {
    return !!(e && e.lock && typeof e.locktime === 'number' && e.locktime >= 1 && e.locktime < e.height && e.height - e.locktime <= LOCK_SPAN && e.seqFinal !== true && e.lock.height === e.locktime && typeof e.lock.time === 'number');
  }

  /**
   * What the facts say: { found, by, after, afterBlock, afterWhy, tried: [{ block, why }], signedAfter, signedBlock, notBefore, window, rate }.
   * `by` is the time of the transaction's block (it was sent by then); `after` the earliest the blocks before allow; `signedAfter` the earliest its locktime allows; `notBefore` the later of the two.
   */
  function infer(e) {
    var out = { found: false, by: null, after: null, afterBlock: null, afterWhy: '', tried: [], signedAfter: null, signedBlock: null, notBefore: null, window: null, rate: null };
    if (!e || e.found !== true || typeof e.blockTime !== 'number') return out;
    out.found = true; out.by = e.blockTime; out.rate = rateOf(e);
    if (!(out.rate >= MIN_RATE) && !(e.prev || []).length) out.tried.push({ block: null, why: 'lowrate' });          // no block can help: none was asked for
    (e.prev || []).some(function (b) {
      var r = judge(b, e, out.rate);
      if (r.ok) { out.after = b.time - MARGIN; out.afterBlock = b.height; out.afterWhy = r.why; return true; }
      out.tried.push({ block: b.height, why: r.why }); return false;
    });
    if (lockOk(e)) { out.signedAfter = e.lock.time - MARGIN; out.signedBlock = e.lock.height; }
    var lo = [out.after, out.signedAfter].filter(function (x) { return x != null; });
    if (lo.length) { out.notBefore = Math.max.apply(null, lo); out.window = Math.max(0, out.by - out.notBefore); }
    return out;
  }

  /** In words why a block did or did not narrow the time. `b` is the block's facts (or undefined). */
  function whyText(why, b, e, rate) {
    var at = b ? 'Block ' + b.height + ' (' + utcText(b.time) + ')' : 'The block before';
    switch (why) {
      case 'room': return at + ' had room left, so a miner building it would have taken this transaction if it had been waiting.';
      case 'above': return at + ' was full, but this transaction paid ' + rateText(rate) + ', well above the ' + rateText(b.p25) + ' that a quarter of that block\'s transactions paid, so it would have been taken if it had been waiting.';
      case 'empty': return at + ' held no transactions, which says nothing about what was waiting.';
      case 'order': return at + ' has a time stamp that is not earlier than this transaction\'s block: the miners\' time stamps are out of order.';
      case 'lowrate': return 'This transaction paid ' + (rate == null ? 'an unknown fee' : rateText(rate)) + ', under what nodes relay by default, so a miner may have left it waiting.';
      case 'full': return at + ' was full and this transaction paid too little above what it took, so it may have been waiting.';
      case 'nofees': return at + ' was full and the data source does not say what its cheaper transactions paid, so it cannot be told whether this one was waiting.';
      default: return 'The data source gave nothing about the block before.';
    }
  }

  /**
   * The rows a card shows for the facts: [[label, value], ...]. Each reading has its own time and its own reason; when there are two, the later one is the time that counts, and it says so.
   */
  function rows(e) {
    var i = infer(e), out = [], both = i.after != null && i.signedAfter != null;
    if (!i.found) return out;
    if (i.notBefore != null) out.push(['Not before', 'about ' + utcText(i.notBefore) + (both ? ' (the later of the two readings below)' : '')], ['Not after', utcText(i.by) + ' (its block)'], ['Window', gapText(i.window)]);
    if (i.after != null) out.push(['From the blocks before', (both ? 'about ' + utcText(i.after) + '. ' : '') + whyText(i.afterWhy, (e.prev || []).filter(function (b) { return b.height === i.afterBlock; })[0], e, i.rate)]);
    if (i.signedAfter != null) out.push(['From its locktime', (both ? 'about ' + utcText(i.signedAfter) + '. ' : '') + 'Signed after block ' + i.signedBlock + ' (' + utcText(e.lock.time) + '), if its wallet sets the locktime to the height of the newest block.']);
    if (i.after == null && i.tried.length) {
      var t = i.tried[i.tried.length - 1];
      out.push(['The blocks before', whyText(t.why, (e.prev || []).filter(function (b) { return b.height === t.block; })[0], e, i.rate)]);
    }
    return out;
  }
  var EXPLAIN = 'Hopline\'s reading of the blocks, not a measurement: the time on a transaction is its block\'s, the transaction was sent earlier, and the blocks before it show how much earlier it can have been. '
    + 'A margin of a few minutes is taken off because a miner builds a block before it finds it and sets the time stamp itself.';

  // ---- what is kept ------------------------------------------------------------------------------------------------------------------

  function cleanBlock(b) {
    if (!isObj(b)) return null;
    var height = int(b.height, 0, 10000000), time = num(b.time, MIN_TIME, MAX_TIME);
    if (height == null || time == null) return null;
    return { height: height, time: time, weight: int(b.weight, 0, 100000000), txCount: int(b.txCount, 0, 1000000), p25: num(b.p25, 0, 100000000) };
  }
  /** Validate the chainwindow entry of an `ext` read from a file. */
  function clean(a) {
    if (!isObj(a)) return null;
    var lock = isObj(a.lock) && int(a.lock.height, 1, 10000000) != null && num(a.lock.time, MIN_TIME, MAX_TIME) != null ? { height: int(a.lock.height, 1, 10000000), time: num(a.lock.time, MIN_TIME, MAX_TIME) } : null;
    var c = { found: a.found === true, at: typeof a.at === 'number' && isFinite(a.at) ? Math.floor(a.at) : 0, source: typeof a.source === 'string' ? a.source.replace(/[^\w.\-:]/g, '').slice(0, 80) : '',
              height: int(a.height, 0, 10000000), blockTime: num(a.blockTime, MIN_TIME, MAX_TIME), vsize: int(a.vsize, 1, 10000000), fee: int(a.fee, 0, 2100000000000000),
              locktime: int(a.locktime, 0, 4294967295), seqFinal: a.seqFinal === true, prev: (Array.isArray(a.prev) ? a.prev : []).map(cleanBlock).filter(Boolean).slice(0, LOOKBACK), lock: lock };
    if (c.found && (c.height == null || c.blockTime == null)) c.found = false;
    return c;
  }

  // ---- asking the data source ----------------------------------------------------------------------------------------------------------

  /** A block's time, weight, size and (when the source has them, and the block is full) the 25th percentile of its fee rates. client.get(path, asText) -> Promise. */
  function blockFacts(client, height, ctx) {
    return client.get('/block-height/' + height, true).then(function (hash) {
      hash = String(hash == null ? '' : hash).trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw fail('bad', 'The data source did not name the block at height ' + height + '.');
      return client.get('/block/' + hash).then(function (b) {
        var f = cleanBlock({ height: height, time: b && b.timestamp, weight: b && b.weight, txCount: b && b.tx_count, p25: null });
        if (!f) throw fail('bad', 'The data source gave no time for block ' + height + '.');
        if (!(f.weight > ROOM_MAX)) return f;                                                         // it had room: nothing more is needed
        return client.get('/v1/block/' + hash).then(function (v) {                                    // mempool.space only: the fee percentiles of a full block
          var r = v && v.extras && v.extras.feeRange;
          if (Array.isArray(r) && typeof r[2] === 'number' && isFinite(r[2])) f.p25 = r[2];
          return f;
        }, function () { return f; });
      });
    });
  }

  /**
   * Work out what the blocks before a loaded transaction say, asking the data source for them (one or two requests for each block, and one for the block its locktime names).
   * ctx: { client, node(txid) -> the transaction's vertex, host }. Resolves { found, ext }; rejects with .kind 'bad' when the transaction is not loaded or not in a block.
   */
  function lookup(txid, ctx) {
    var n = ctx && typeof ctx.node === 'function' ? ctx.node(txid) : null, client = ctx && ctx.client;
    if (!client) return Promise.reject(fail('setup', 'There is no data source to ask.'));
    if (!n || n.type !== 'tx' || n.loaded !== true || n.confirmed === false || typeof n.height !== 'number' || typeof n.time !== 'number') {
      return Promise.reject(fail('bad', 'Only a loaded transaction that is in a block can be narrowed: load it, and wait for it to be confirmed.'));
    }
    var seqs = Array.isArray(n.seqs) ? n.seqs : [];
    var e = { found: true, at: Math.floor(Date.now() / 1000), source: ctx.host || '', height: n.height, blockTime: n.time, vsize: n.vsize, fee: n.fee, locktime: typeof n.locktime === 'number' ? n.locktime : null,
              seqFinal: seqs.length > 0 && seqs.every(function (s) { return s === 4294967295; }), prev: [], lock: null };
    var rate = rateOf(e), k = 1;
    function nextPrev() {
      if (!(rate >= MIN_RATE) || k > LOOKBACK || n.height - k < 0) return Promise.resolve();                       // under the relay minimum no block can help: none is asked for
      var h = n.height - k; k++;
      return blockFacts(client, h, ctx).then(function (f) { e.prev.push(f); if (!judge(f, e, rate).ok) return nextPrev(); });                 // until one block can be used
    }
    function lockBlock() {
      if (!(e.locktime >= 1 && e.locktime < e.height && e.height - e.locktime <= LOCK_SPAN) || e.seqFinal) return Promise.resolve();
      var have = e.prev.filter(function (b) { return b.height === e.locktime; })[0];
      if (have) { e.lock = { height: have.height, time: have.time }; return Promise.resolve(); }
      return blockFacts(client, e.locktime, ctx).then(function (f) { e.lock = { height: f.height, time: f.time }; });
    }
    return nextPrev().then(lockBlock).then(function () { return { found: true, ext: e }; });
  }

  /** The readings of the vertices that carry them, for the report: [{ txid, blockTime, notBefore, window, after, afterBlock, signedAfter, signedBlock, because, at }], in the order of the vertices. */
  function reportRows(nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      var e = n && n.type === 'tx' && isObj(n.ext) ? n.ext.chainwindow : null; if (!e || e.found !== true) return;
      var i = infer(e), b = (e.prev || []).filter(function (x) { return x.height === i.afterBlock; })[0];
      var t = i.tried[i.tried.length - 1];
      var because = i.after != null ? whyText(i.afterWhy, b, e, i.rate) : t ? whyText(t.why, (e.prev || []).filter(function (x) { return x.height === t.block; })[0], e, i.rate) : '';
      out.push({ txid: n.txid, blockTime: i.by, notBefore: i.notBefore, window: i.window, after: i.after, afterBlock: i.afterBlock, signedAfter: i.signedAfter, signedBlock: i.signedBlock, because: because, at: typeof e.at === 'number' ? e.at : 0 });
    });
    return out;
  }

  return { infer: infer, judge: judge, rows: rows, whyText: whyText, lookup: lookup, clean: clean, blockFacts: blockFacts, reportRows: reportRows, rateOf: rateOf, utcText: utcText, gapText: gapText,
           EXPLAIN: EXPLAIN, ROOM_MAX: ROOM_MAX, MARGIN: MARGIN, LOOKBACK: LOOKBACK, LOCK_SPAN: LOCK_SPAN, FULL_FACTOR: FULL_FACTOR };
}));
