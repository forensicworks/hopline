/*
 * Hopline same block: transactions on the canvas that were confirmed in the same block although nothing ties them together.
 *
 * A block holds thousands of transactions, so two unrelated ones landing in the same block is ordinary when a canvas is large. It is worth a look when the two have no wallet in common and the
 * canvas is small: whoever moved the coins of two wallets in one sitting, one after the other, gets both into the next block. That is a COINCIDENCE the analyst may want to weigh, kept apart
 * from the findings: it says nothing about who is behind either transaction, and a service or a busy hour makes it happen by itself.
 *
 * Two transactions count when both are loaded, confirmed, not coinbase and complete on the canvas (every input and output is there, so "no wallet in common" can be told), and they
 *   - are in the same block, and
 *   - are not tied: no wallet in common among their inputs and outputs, not even by way of a third transaction of that block that has a wallet in common with each (a chain passed on within
 *     one block is one group: the HAND-OFF pattern is about that). A transaction spending the other's output has a wallet in common with it.
 * Pairs that are tied are left out because they are expected: deposits to one wallet, one wallet paying twice, or a chain confirmed together.
 *
 * `expected` says how many pairs of any two of the canvas's transactions would share a block if they had been confirmed at random among the blocks they span (n(n-1)/2 over the span). Activity
 * comes in bursts, so the real chance is higher than that: it is a yardstick, not a probability.
 * Pure functions over the graph; nothing here touches the DOM or the network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'));
  else root.HoplineSameBlock = factory(root.HoplineModel);
}(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var CROWDED = 400;                                                       // a block with more of the canvas's transactions than this is not compared: a service's block, and the pairs would be too many to read

  function walletsOf(graph, n) {
    var set = new Set();
    graph.edgesOf(n.id).forEach(function (e) {
      var other = e.kind === 'in' && e.target === n.id ? e.source : e.kind === 'out' && e.source === n.id ? e.target : null;
      var o = other ? graph.nodes.get(other) : null;
      if (o && o.type === 'addr') set.add(other);
    });
    return set;
  }
  function share(a, b) {
    var small = a.size <= b.size ? a : b, big = small === a ? b : a, hit = false;
    small.forEach(function (w) { if (!hit && big.has(w)) hit = true; });
    return hit;
  }
  function byTime(a, b) { return (a.time || 0) - (b.time || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  /**
   * { blocks: [{ height, time, ids, pairs }] (oldest first), ids (every transaction in a pair, block by block), pairs, byTx: Map(id -> { height, others: [ids] }),
   *   eligible, span (blocks from the first to the last of the eligible ones), expected,
   *   left: { notLoaded, unconfirmed, partial, crowded } (transactions that could not be compared) }.
   */
  function find(graph) {
    var left = { notLoaded: 0, unconfirmed: 0, partial: 0, crowded: 0 }, eligible = 0, lo = null, hi = null, byHeight = new Map();
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.coinbase) return;
      if (n.loaded !== true) { left.notLoaded++; return; }
      if (n.height == null) { left.unconfirmed++; return; }
      if (Model.txPartial(graph, n)) { left.partial++; return; }
      eligible++;
      lo = lo == null ? n.height : Math.min(lo, n.height); hi = hi == null ? n.height : Math.max(hi, n.height);
      var l = byHeight.get(n.height); if (!l) byHeight.set(n.height, l = []); l.push(n);
    });
    var blocks = [], byTx = new Map(), ids = [], pairs = 0;
    Array.from(byHeight.keys()).sort(function (a, b) { return a - b; }).forEach(function (height) {
      var list = byHeight.get(height);
      if (list.length < 2) return;
      if (list.length > CROWDED) { left.crowded += list.length; return; }
      list.sort(byTime);
      var wallets = list.map(function (n) { return walletsOf(graph, n); }), group = list.map(function (_, i) { return i; }), others = list.map(function () { return []; }), n = 0;
      function root(i) { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; }
      for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) if (share(wallets[i], wallets[j])) group[root(j)] = root(i);       // tied, directly or through others
      for (i = 0; i < list.length; i++) for (j = i + 1; j < list.length; j++) {
        if (root(i) === root(j)) continue;
        n++; others[i].push(list[j].id); others[j].push(list[i].id);
      }
      if (!n) return;
      var here = [];
      list.forEach(function (t, k) { if (others[k].length) { here.push(t.id); ids.push(t.id); byTx.set(t.id, { height: height, others: others[k] }); } });
      blocks.push({ height: height, time: list[0].time, ids: here, pairs: n });
      pairs += n;
    });
    var span = eligible ? hi - lo + 1 : 0;
    return { blocks: blocks, ids: ids, pairs: pairs, byTx: byTx, eligible: eligible, span: span, expected: span ? eligible * (eligible - 1) / 2 / span : 0, left: left };
  }

  /** The expected number in words: "about 0.3", "about 2", "under 0.01". */
  function chanceText(e) {
    if (!(e > 0)) return 'none';
    if (e >= 0.095) return 'about ' + (e >= 9.5 ? Math.round(e) : Number(e.toPrecision(e >= 1 ? 2 : 1)));
    if (e >= 0.0095) return 'about ' + e.toFixed(2);
    return 'under 0.01';
  }

  return { find: find, chanceText: chanceText, CROWDED: CROWDED };
}));
