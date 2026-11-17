/*
 * Hopline money: where the money that reached some wallets is now, with every satoshi accounted for.
 *
 * It follows COINS, not addresses: the coins that were paid to the starting wallets (or the outputs of a starting transaction) are followed to the transaction that spent each of them,
 * and the outputs of that transaction are followed in turn, as far as the loaded transactions go. Each coin ends in one of these places:
 *   resting     an unspent output (as of the time its spends were read)
 *   unchecked   an output whose spend status was never read: it may or may not still be there
 *   movedOn     spent by a transaction that is not loaded: the trail is open there
 *   named       paid to a wallet that has a name that ends a trail (an exchange, a service): `opts.stop(vertexId)` says which
 *   mixed       a transaction that spent some of these coins together with coins that are not from them: nothing is guessed about its outputs; the trail stops and says how much of each went in
 *   gap         outputs of a loaded transaction that the graph does not hold (a transaction that is only partly loaded)
 * and the fees of the transactions that were followed. The numbers are exact integers of satoshis and are added up: `closes` says whether what was received equals what is accounted for.
 * Pure functions over the graph; nothing here touches the DOM or the network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'));
  else root.HoplineMoney = factory(root.HoplineModel);
}(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var ID = Model.ID;
  var MAX_COINS = 20000;

  function coinKey(txid, vout) { return txid + ':' + vout; }

  /**
   * Where the money that reached `refIds` (wallet ids, or a transaction id: its outputs) is now.
   * opts: { stop(vertexId) -> a name or null: a wallet with a name ends a trail (a starting wallet never does), max (coins followed, default 20000) }
   * Returns { refs, received, coins, truncated, resting, unchecked, movedOn, named, mixed, gap, fees, txs, sum, off, closes }, where resting, unchecked, movedOn and named are
   * { count, sats, rows } with rows [{ id (the wallet), address, amount, txid, vout, readAt (when the spends of the transaction were read, or null), label (named), next (movedOn: the transaction to load) }]
   * largest first; mixed is { count, sats (what went in from these coins), foreign (what went in from others), rows: [{ txid, trailIn, foreign, time }] }; gap is { count, sats, rows: [{ txid, sats }] };
   * fees is the sum of the fees of the transactions followed and txs their number.
   */
  function where(graph, refIds, opts) {
    opts = opts || {};
    var stop = opts.stop, max = opts.max || MAX_COINS;
    var refs = new Set((Array.isArray(refIds) ? refIds : [refIds]).filter(function (id) { return typeof id === 'string' && graph.nodes.has(id); }));
    var coins = new Map(), pending = [], seeds = [], candidates = new Map(), expanded = new Set(), truncated = false;
    var out = { refs: Array.from(refs), received: 0, coins: 0, truncated: false, resting: bucket(), unchecked: bucket(), movedOn: bucket(), named: bucket(),
                mixed: { count: 0, sats: 0, foreign: 0, rows: [] }, gap: { count: 0, sats: 0, rows: [] }, fees: 0, txs: 0, sum: 0, off: 0, closes: true };
    function bucket() { return { count: 0, sats: 0, rows: [] }; }

    function outEdges(txId) { return graph.edgesOf(txId).filter(function (e) { return e.kind === 'out' && e.source === txId; }); }
    function inEdges(txId) { return graph.edgesOf(txId).filter(function (e) { return e.kind === 'in' && e.target === txId; }); }
    function readAt(txid) { var n = graph.nodes.get(ID.tx(txid)); return n && n.spendsCheckedAt != null ? n.spendsCheckedAt : null; }
    function addCoin(e) {
      var k = coinKey(e.txid, e.vout);
      if (coins.has(k)) return;
      if (coins.size >= max) { truncated = true; return; }
      coins.set(k, e); pending.push(e);
    }

    refs.forEach(function (id) {
      var n = graph.nodes.get(id);
      (n.type === 'tx' ? outEdges(id) : graph.edgesOf(id).filter(function (e) { return e.kind === 'out' && e.target === id; })).forEach(function (e) { seeds.push(e); addCoin(e); });
    });

    function row(e, extra) {
      var t = graph.nodes.get(e.target), r = { id: e.target, address: t && t.address ? t.address : null, amount: e.amount, txid: e.txid, vout: e.vout, readAt: readAt(e.txid) };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }
    function put(b, r) { b.count++; b.sats += r.amount; b.rows.push(r); }

    /** Where one coin ends, or which transaction spent it (a candidate to follow). */
    function classify(e) {
      var target = graph.nodes.get(e.target);
      if (!target || target.type !== 'addr') { put(out.gap, { txid: e.txid, vout: e.vout, sats: e.amount, amount: e.amount }); return; }     // data and outputs with no address: counted apart
      var label = !refs.has(e.target) && stop ? stop(e.target) : null;
      if (label) { put(out.named, row(e, { label: label })); return; }
      if (e.spent === false) { put(out.resting, row(e)); return; }
      if (e.spent === true && e.spentBy && e.spentBy.txid) {
        var s = graph.nodes.get(ID.tx(e.spentBy.txid));
        if (s && s.loaded === true) { var set = candidates.get(s.txid); if (!set) candidates.set(s.txid, set = new Set()); set.add(coinKey(e.txid, e.vout)); return; }
        put(out.movedOn, row(e, { next: e.spentBy.txid })); return;
      }
      put(out.unchecked, row(e));
    }

    /** What went into a transaction from the coins followed so far, and what went in from others. */
    function inputsOf(txid, via) {
      var s = graph.nodes.get(ID.tx(txid)), keys = new Set(via), trailIn = 0, loadedIn = 0, byKey = new Map();
      inEdges(ID.tx(txid)).forEach(function (e) { loadedIn += e.amount; if (e.prev && e.prev.txid != null) byKey.set(coinKey(e.prev.txid, e.prev.vout), e.amount); });
      keys.forEach(function (k) { trailIn += byKey.has(k) ? byKey.get(k) : (coins.get(k) ? coins.get(k).amount : 0); });
      coins.forEach(function (e, k) { if (!keys.has(k) && byKey.has(k)) { keys.add(k); trailIn += byKey.get(k); } });         // coins that arrived by another branch
      var total = s && typeof s.valueIn === 'number' ? s.valueIn : loadedIn;
      return { trailIn: trailIn, foreign: Math.max(0, total - trailIn), total: total, node: s };
    }

    function expand(txid, inp) {
      var s = inp.node, txId = ID.tx(txid), seen = 0;
      expanded.add(txid); out.txs++;
      out.fees += typeof s.fee === 'number' ? s.fee : Math.max(0, (s.valueIn || 0) - (s.valueOut || 0));
      outEdges(txId).forEach(function (e) { seen += e.amount; addCoin(e); });
      var missing = (s.valueOut || 0) - seen;
      if (missing > 0) { out.gap.count++; out.gap.sats += missing; out.gap.rows.push({ txid: txid, sats: missing, amount: missing }); }
    }

    var guard = 0, progress;
    do {
      while (pending.length) classify(pending.pop());
      progress = false;
      Array.from(candidates.keys()).forEach(function (txid) {
        if (expanded.has(txid)) return;
        var inp = inputsOf(txid, candidates.get(txid));
        if (inp.foreign === 0 && inp.node) { expand(txid, inp); progress = true; }
      });
    } while ((progress || pending.length) && ++guard < 100000);

    candidates.forEach(function (via, txid) {                                                       // spent together with coins from elsewhere: nothing is guessed about what came out
      if (expanded.has(txid)) return;
      var inp = inputsOf(txid, via), n = inp.node || {};
      out.mixed.count++; out.mixed.sats += inp.trailIn; out.mixed.foreign += inp.foreign; out.mixed.rows.push({ txid: txid, trailIn: inp.trailIn, foreign: inp.foreign, time: n.time == null ? null : n.time });
    });

    // what was received from outside: the coins paid to the starting wallets by a transaction that is not itself followed (a transaction that passed change back is part of the trail, and one that was mixed is counted as mixed)
    seeds.forEach(function (e) { if (!expanded.has(e.txid) && !out.mixed.rows.some(function (m) { return m.txid === e.txid; })) out.received += e.amount; });
    [out.resting, out.unchecked, out.movedOn, out.named].forEach(function (b) { b.rows.sort(function (a, c) { return c.amount - a.amount || (a.txid < c.txid ? -1 : 1); }); });
    out.mixed.rows.sort(function (a, c) { return c.trailIn - a.trailIn; }); out.gap.rows.sort(function (a, c) { return c.sats - a.sats; });
    out.coins = coins.size; out.truncated = truncated;
    out.sum = out.resting.sats + out.unchecked.sats + out.movedOn.sats + out.named.sats + out.mixed.sats + out.gap.sats + out.fees;
    out.off = out.received - out.sum;
    out.closes = !truncated && out.off === 0;
    return out;
  }

  /** Rows of one bucket grouped by wallet, largest first: [{ id, address, amount, count, txids, readAt (the oldest) }]. */
  function byWallet(rows) {
    var by = new Map();
    (rows || []).forEach(function (r) {
      var w = by.get(r.id); if (!w) by.set(r.id, w = { id: r.id, address: r.address, amount: 0, count: 0, txids: [], readAt: null, label: r.label || '' });
      w.amount += r.amount; w.count++; if (w.txids.indexOf(r.txid) < 0) w.txids.push(r.txid);
      if (r.readAt != null && (w.readAt == null || r.readAt < w.readAt)) w.readAt = r.readAt;
    });
    return Array.from(by.values()).sort(function (a, b) { return b.amount - a.amount || (a.id < b.id ? -1 : 1); });
  }

  /** The transactions whose spends have to be read to settle the coins of these rows (unchecked ones, and resting ones to see that they still rest): unique txids. */
  function txidsOf(rows) { var seen = {}, list = []; (rows || []).forEach(function (r) { if (!seen[r.txid]) { seen[r.txid] = 1; list.push(r.txid); } }); return list; }

  return { where: where, byWallet: byWallet, txidsOf: txidsOf, MAX_COINS: MAX_COINS };
}));
