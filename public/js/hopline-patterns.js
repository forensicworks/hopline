/*
 * Hopline patterns: three shapes that are CONTEXT, not leads, found in what is loaded. Each is common in ordinary use, none says who is behind it, and they are not counted with the findings
 * (the findings are the flags of hopline-analysis.js). Pure functions over the graph and its analysis; nothing here touches the DOM or the network.
 *
 *   TEST PAYMENT   A small payment, and soon after a much larger one from the same sender to the same wallet. People often send a small amount first to see that it arrives (a deposit address, a new
 *                  payee), and a scam often asks for one. { test, main, ratio, gap } with each payment { txid, time, sender, receiver, amount, address }.
 *   HAND-OFF       A transaction that spends coins paid to a wallet by another transaction in the SAME block: the wallet passed them on before the first one was confirmed. A wallet that spends its own
 *                  unconfirmed change is not one (the coin went to the owner who sent it). Chains of them are grouped. A script that watches the mempool does it; so does anybody in a hurry or who pays a fee
 *                  that gets the whole chain confirmed together. Only chains of at least two hand-offs are reported: one hand-off is on about one transaction in twenty of ordinary traffic (measured
 *                  on the sample of tier D of the benchmark), two or more on about one in a hundred. { ids (the transactions, in order), hops, height, time, links: [{ parent, child, address, amount }], childRate, parentRate }.
 *   SPLIT AND COLLECT  A run of transactions with one input and two outputs, each of which pays one output to the SAME wallet and passes the rest on to the next transaction, ending (when it does) in a
 *                  transaction that spends the pieces together. Reported only when the amounts are all round or the pieces were later spent together: the runs without either that the sample of real
 *                  traffic holds are all inside one block, which looks like a service paying out, not a person. { ids, steps, address, paid: [amounts], total, collected: { txid, pieces } | null, round }.
 *
 * "The same sender" is the owner the analysis gives a wallet (the wallets spent together in one transaction are one owner: the common-input rule), else the wallet itself.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'), require('./hopline-analysis.js'));
  else root.HoplinePatterns = factory(root.HoplineModel, root.HoplineAnalysis);
}(typeof self !== 'undefined' ? self : this, function (Model, AN) {
  'use strict';

  var ID = Model.ID;
  var DEFAULTS = {
    test: { ratio: 50, minSats: 546, maxDays: 7 },       // the main payment is at least this many times the test, the test is not dust, and the main follows within this many days (or the same block)
    handoff: { minHops: 2 },                              // chains of at least this many hand-offs
    split: { minSteps: 3, needSignal: true }              // this many transactions in a row, and the amounts round or the pieces collected
  };
  var DAY = 86400;

  function owner(an, id) {
    var c = an && an.clusters && an.clusters.byAddr ? an.clusters.byAddr.get(id) : null;
    return c ? c.label : id;
  }
  function rateOf(n) { return n && typeof n.fee === 'number' && n.vsize > 0 ? n.fee / n.vsize : null; }

  // ---- TEST PAYMENT ---------------------------------------------------------------------------------------------------------------------
  /** Every payment one owner made to a wallet that is not its own: [{ txid, time, sender, receiver, address, amount }]. A transaction with more than one owner among its inputs says nothing about who paid. */
  function payments(graph, an) {
    var out = [];
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx' || n.loaded !== true || n.coinbase || n.time == null) return;
      var v = AN.txView(graph, id); if (!v || !v.complete) return;
      var owners = new Set(), inputWallets = new Set();
      v.inputs.forEach(function (i) { if (i.type !== 'addr') return; owners.add(owner(an, i.id)); inputWallets.add(i.id); });
      if (owners.size !== 1) return;
      var sender = Array.from(owners)[0];
      v.outputs.forEach(function (o) {
        if (o.type !== 'addr' || inputWallets.has(o.id) || owner(an, o.id) === sender) return;               // data, and change that went back to the sender
        out.push({ txid: n.txid, time: n.time, sender: sender, receiver: o.id, address: o.address, amount: o.amount });
      });
    });
    return out;
  }

  function testPayments(graph, an, opts) {
    var cfg = Object.assign({}, DEFAULTS.test, opts && opts.test), by = new Map(), found = [];
    payments(graph, an).forEach(function (p) { var k = p.sender + '>' + p.receiver; if (!by.has(k)) by.set(k, []); by.get(k).push(p); });
    by.forEach(function (list) {
      list.sort(function (a, b) { return a.time - b.time || a.amount - b.amount; });
      list.forEach(function (a) {
        if (a.amount < cfg.minSats) return;
        var b = null;
        for (var i = 0; i < list.length && !b; i++) {
          var x = list[i];
          if (x.txid !== a.txid && x.time >= a.time && x.time - a.time <= cfg.maxDays * DAY && x.amount >= a.amount * cfg.ratio) b = x;       // the nearest one after it that is big enough
        }
        if (b) found.push({ test: a, main: b, ratio: Math.floor(b.amount / a.amount), gap: b.time - a.time });
      });
    });
    found.sort(function (x, y) { return x.main.time - y.main.time || (x.test.txid < y.test.txid ? -1 : 1); });
    return found;
  }

  // ---- HAND-OFF BEFORE CONFIRMING -------------------------------------------------------------------------------------------------------
  function handoffs(graph, an, opts) {
    var cfg = Object.assign({}, DEFAULTS.handoff, opts && opts.handoff), links = [], byChild = new Map(), byParent = new Map();
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx' || n.loaded !== true || n.coinbase || n.height == null) return;
      var v = AN.txView(graph, id); if (!v) return;
      v.inputs.forEach(function (i) {
        if (!i.prev || i.type !== 'addr') return;
        var p = graph.nodes.get(ID.tx(i.prev.txid));
        if (!p || p.loaded !== true || p.height == null || p.height !== n.height || p.txid === n.txid) return;
        var pv = AN.txView(graph, p.id); if (!pv) return;
        var senders = new Set(pv.inputs.filter(function (x) { return x.type === 'addr'; }).map(function (x) { return owner(an, x.id); }));
        if (senders.has(owner(an, i.id))) return;                                                          // its own unconfirmed change: the coin went back to the owner that sent it
        var l = { parent: p.txid, child: n.txid, address: i.address, amount: i.amount, height: n.height, time: n.time };
        links.push(l);
        if (!byChild.has(l.child)) byChild.set(l.child, []); byChild.get(l.child).push(l);
        if (!byParent.has(l.parent)) byParent.set(l.parent, []); byParent.get(l.parent).push(l);
      });
    });
    // chains: the transactions joined by links, in the order they were passed on
    var seen = new Set(), chains = [];
    function members(start) {
      var ids = new Set([start]), queue = [start];
      while (queue.length) {
        var t = queue.pop();
        (byChild.get(t) || []).forEach(function (l) { if (!ids.has(l.parent)) { ids.add(l.parent); queue.push(l.parent); } });
        (byParent.get(t) || []).forEach(function (l) { if (!ids.has(l.child)) { ids.add(l.child); queue.push(l.child); } });
      }
      return ids;
    }
    links.forEach(function (l0) {
      if (seen.has(l0.child)) return;
      var ids = members(l0.child); ids.forEach(function (t) { seen.add(t); });
      var ls = links.filter(function (l) { return ids.has(l.child); }), depth = new Map();
      function d(t) { if (depth.has(t)) return depth.get(t); depth.set(t, 0); var best = 0; (byChild.get(t) || []).forEach(function (l) { best = Math.max(best, 1 + d(l.parent)); }); depth.set(t, best); return best; }
      var order = Array.from(ids).sort(function (a, b) { return d(a) - d(b) || (a < b ? -1 : 1); });
      var last = order[order.length - 1], root0 = order[0], cn = graph.nodes.get(ID.tx(last)), pn = graph.nodes.get(ID.tx(root0));
      chains.push({ ids: order, hops: d(last), height: l0.height, time: l0.time, links: ls.sort(function (a, b) { return d(a.child) - d(b.child); }), childRate: rateOf(cn), parentRate: rateOf(pn) });
    });
    chains = chains.filter(function (c) { return c.hops >= cfg.minHops; });
    chains.sort(function (a, b) { return b.hops - a.hops || (a.time || 0) - (b.time || 0); });
    return chains;
  }

  // ---- SPLIT AND COLLECT ----------------------------------------------------------------------------------------------------------------
  function splitCollect(graph, an, opts) {
    var cfg = Object.assign({}, DEFAULTS.split, opts && opts.split), shape = new Map(), found = [];
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx' || n.loaded !== true || n.coinbase) return;
      var v = AN.txView(graph, id);
      if (v && v.complete && v.inputs.length === 1 && v.outputs.length === 2 && v.inputs[0].type === 'addr' && v.outputs.every(function (o) { return o.type === 'addr'; })) shape.set(n.txid, v);
    });
    /** The next transaction of the run: the one that spent the output that is not paid to `target`, when it has the same shape and pays `target` too. */
    function next(v, target) {
      var other = v.outputs.filter(function (o) { return o.address !== target; });
      if (other.length !== 1 || !other[0].spender) return null;
      var s = shape.get(other[0].spender);
      return s && s.outputs.some(function (o) { return o.address === target; }) && s.outputs.some(function (o) { return o.address !== target; }) && s.inputs[0].address !== target ? { v: s, passed: other[0].amount } : null;
    }
    function viaTarget(v) { return v.outputs.map(function (o) { return o.address; }).filter(function (a) { return a && a !== v.inputs[0].address; }); }
    function startsRun(v, target) {                         // the run does not go on from an earlier step that paid the same wallet
      var prev = v.inputs[0].prev && shape.get(v.inputs[0].prev.txid);
      return !(prev && prev.outputs.some(function (o) { return o.address === target; }) && prev.outputs.some(function (o) { return o.address !== target && o.address === v.inputs[0].address; }));
    }
    shape.forEach(function (v) {
      var targets = new Set(viaTarget(v));
      targets.forEach(function (target) {
        if (!startsRun(v, target)) return;
        var run = [v], cur = v, step;
        while ((step = next(cur, target))) { run.push(step.v); cur = step.v; if (run.length > 500) break; }
        if (run.length < cfg.minSteps) return;
        var paid = run.map(function (x) { return x.outputs.filter(function (o) { return o.address === target; })[0].amount; });
        var pieces = new Set(); run.forEach(function (x) { x.outputs.forEach(function (o) { if (o.address === target) pieces.add(x.txid + ':' + o.vout); }); });
        var spenders = new Map();                                                                          // what later spent the pieces together
        run.forEach(function (x) { x.outputs.forEach(function (o) { if (o.address === target && o.spender) spenders.set(o.spender, (spenders.get(o.spender) || 0) + 1); }); });
        var collect = null; spenders.forEach(function (k, txid) { if (k >= 2 && (!collect || k > collect.pieces)) collect = { txid: txid, pieces: k }; });
        var round = paid.every(function (a) { return a % 10000 === 0; });
        if (cfg.needSignal && !round && !collect) return;                                                  // neither round nor collected: what a service paying out looks like
        found.push({ ids: run.map(function (x) { return x.txid; }), steps: run.length, address: target, paid: paid, total: paid.reduce(function (s, a) { return s + a; }, 0), collected: collect,
                     round: round, time: run[0].time, last: run[run.length - 1].time });
      });
    });
    found.sort(function (a, b) { return b.steps - a.steps || (a.time || 0) - (b.time || 0); });
    return found;
  }

  /** All three. { test, handoff, split, counts: { test, handoff (chains), links, split, total } }. */
  function find(graph, an, opts) {
    var t = testPayments(graph, an, opts), h = handoffs(graph, an, opts), s = splitCollect(graph, an, opts);
    return { test: t, handoff: h, split: s, counts: { test: t.length, handoff: h.length, links: h.reduce(function (n, c) { return n + c.links.length; }, 0), split: s.length, total: t.length + h.length + s.length } };
  }

  /** The vertex ids a pattern involves, for selecting and ringing them. */
  function idsOf(kind, item) {
    var tx = function (t) { return ID.tx(t); };
    if (kind === 'test') return [tx(item.test.txid), tx(item.main.txid)];
    if (kind === 'handoff') return item.ids.map(tx);
    if (kind === 'split') return item.ids.map(tx).concat(item.collected ? [tx(item.collected.txid)] : []);
    return [];
  }

  return { find: find, testPayments: testPayments, handoffs: handoffs, splitCollect: splitCollect, payments: payments, idsOf: idsOf, DEFAULTS: DEFAULTS };
}));
