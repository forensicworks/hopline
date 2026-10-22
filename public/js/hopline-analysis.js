/*
 * Hopline analysis: patterns in the transactions that are loaded. Pure functions over the graph, no DOM, no network.
 *
 * EVERYTHING HERE IS A HEURISTIC. Each result carries the reasons it was reached so a person can judge it; none of it
 * is proof of who controls what. In particular:
 *   - change guess       which output of a transaction most likely returns to the sender (never "certain")
 *   - patterns           consolidation, batch payment, CoinJoin-like, peel chain (a chain of single-coin payments)
 *   - clusters           addresses spent together in one transaction (the "common-input" rule), leaving out
 *                        transactions that look like CoinJoins and any you excluded by hand
 *   - successors         which way an automatic expansion should go from a transaction, and why it stops
 * Only loaded transactions can be analysed (a transaction not loaded has no inputs or outputs to look at).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'));
  else root.HoplineAnalysis = factory(root.HoplineModel);
}(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var ID = Model.ID;

  var DEFAULTS = {
    consolidation: { minIn: 5, maxOut: 2 },             // many inputs gathered into one or two outputs
    batch: { minOut: 6, maxIn: 3 },                     // a few inputs paying many outputs
    coinjoin: { minIn: 3, minEqual: 3 },                // several owners' inputs, several outputs of exactly the same value
    peel: { maxRatio: 0.5, minLength: 4 }               // one input, two outputs, the small one at most half the large; this many in a row
  };

  var COLORS = { consolidation: '#b58cff', batch: '#6be675', coinjoin: '#ff7aa2', peel: '#ffb347', change: '#ff9f43' };
  var CONFIDENCE = { low: 1, medium: 2, high: 3 };

  function byKey(k) { return function (a, b) { return a[k] - b[k]; }; }
  function fmtSat(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function btc(sats) { return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BTC'; }

  // ---- reading a transaction out of the graph ----------------------------------------------------
  /**
   * A loaded transaction as plain lists: inputs (with the wallet and amount each spent) and outputs (with where each
   * went and whether it was spent). null when the transaction is not loaded. `complete` is false when edges are missing
   * (a partial import), in which case nothing should be concluded from it.
   */
  function txView(graph, txId) {
    var n = graph.nodes.get(txId);
    if (!n || n.type !== 'tx' || n.loaded !== true) return null;
    var ins = [], outs = [];
    graph.edgesOf(txId).forEach(function (e) {
      var other;
      if (e.kind === 'in' && e.target === txId) {
        other = graph.nodes.get(e.source);
        ins.push({ vin: e.vin, edgeId: e.id, id: e.source, type: other ? other.type : 'unknown', address: other && other.type === 'addr' ? other.address : null,
                   scriptType: other && other.scriptType ? other.scriptType : null, amount: e.amount, prev: e.prev || null });
      } else if (e.kind === 'out' && e.source === txId) {
        other = graph.nodes.get(e.target);
        outs.push({ vout: e.vout, edgeId: e.id, id: e.target, type: other ? other.type : 'unknown', address: other && other.type === 'addr' ? other.address : null,
                    scriptType: other && other.scriptType ? other.scriptType : null, amount: e.amount,
                    spent: e.spent === true ? true : e.spent === false ? false : null, spender: e.spentBy ? e.spentBy.txid : null });
      }
    });
    ins.sort(byKey('vin')); outs.sort(byKey('vout'));
    return { id: txId, txid: n.txid, node: n, graph: graph, coinbase: !!n.coinbase, time: n.time, inputs: ins, outputs: outs,
             complete: ins.length === n.nIn && outs.length === n.nOut };
  }

  /** The outputs that carry value to somewhere (OP_RETURN data outputs are not payments). */
  function payOuts(v) { return v.outputs.filter(function (o) { return o.type !== 'data'; }); }
  function inputAddresses(v) {
    var seen = new Set(), out = [];
    v.inputs.forEach(function (i) { if (i.address && !seen.has(i.address)) { seen.add(i.address); out.push(i); } });
    return out;
  }
  function trailingZeros(v) { var k = 0; while (v > 0 && v % 10 === 0) { v /= 10; k++; } return k; }
  /** The most outputs sharing one exact value, and that value. */
  function mostEqual(outs) {
    var count = new Map(), best = 0, val = null;
    outs.forEach(function (o) { var c = (count.get(o.amount) || 0) + 1; count.set(o.amount, c); if (c > best) { best = c; val = o.amount; } });
    return { count: best, amount: val };
  }

  // ---- the habits of the wallet that made a transaction -----------------------------------------------
  var COMMON_FP = /^v2\|(none|height-near)\|seq:(fffffffd|fffffffe)\|/;                 // what Bitcoin Core and many other wallets do by default

  /**
   * What a transaction gives away about the software that built it: its version, whether its locktime is the recent block
   * height ("anti-fee-sniping"), the sequence numbers it uses (RBF or not) and whether it sorts its inputs and outputs (BIP 69).
   * Returns { key, version, lock, seqs, bip69, common, text } or null when the transaction was loaded without those fields.
   * Two transactions with the same key were probably made by the same kind of wallet; `common` says the key is a default
   * shared by many wallets, so a match then means little.
   */
  function fingerprint(n) {
    if (!n || n.type !== 'tx' || n.loaded !== true || n.version == null || n.locktime == null) return null;
    var lock = n.locktime === 0 ? 'none' : n.locktime >= 500000000 ? 'time'
             : (n.height != null && n.height - n.locktime >= 0 && n.height - n.locktime <= 100 ? 'height-near' : 'height-far');
    var seqs = (n.seqs || []).map(function (s) { return s.toString(16); }).join(',');
    var key = 'v' + n.version + '|' + lock + '|seq:' + seqs;
    var seqText = (n.seqs || []).map(function (s) { return s === 0xffffffff ? 'final (ffffffff)' : s === 0xfffffffe ? 'locktime, no RBF (fffffffe)' : 'RBF signalled (' + s.toString(16) + ')'; }).join(', ');
    var text = 'version ' + n.version + ' · locktime ' + (lock === 'none' ? 'none' : lock === 'height-near' ? 'a recent block height (anti-fee-sniping)' : lock === 'time' ? 'a date' : 'an old block height')
             + (seqText ? ' · sequence ' + seqText : '') + (n.bip69 === true ? ' · inputs and outputs BIP 69 sorted' : n.bip69 === false ? ' · not BIP 69 sorted' : '');
    return { key: key, version: n.version, lock: lock, seqs: seqs, bip69: n.bip69, common: COMMON_FP.test(key + '|'), text: text };
  }
  /** Same kind of wallet? The key must match, and the ordering habit too wherever both transactions are big enough to show one. */
  function sameWallet(a, b) {
    return !!a && !!b && a.key === b.key && (a.bip69 == null || b.bip69 == null || a.bip69 === b.bip69);
  }

  // ---- patterns ------------------------------------------------------------------------------------
  /** A transaction that looks like several people's coins mixed together: the common-input rule does not hold for it. */
  function coinjoinLike(v, opts) {
    var c = Object.assign({}, DEFAULTS.coinjoin, opts && opts.coinjoin);
    if (!v || v.coinbase || !v.complete) return null;
    var outs = payOuts(v), owners = inputAddresses(v).length;
    if (owners < c.minIn) return null;
    var eq = mostEqual(outs);
    if (eq.count < c.minEqual) return null;
    if (!(eq.count >= 5 || eq.count * 2 >= outs.length)) return null;
    return { equal: eq.count, amount: eq.amount, inputs: owners, outputs: outs.length };
  }

  /** The patterns a single transaction shows by itself. Peel chains need several transactions: see peelChains. */
  function classify(v, opts) {
    var flags = [];
    if (!v || v.coinbase || !v.complete) return flags;
    var cfg = { consolidation: Object.assign({}, DEFAULTS.consolidation, opts && opts.consolidation), batch: Object.assign({}, DEFAULTS.batch, opts && opts.batch) };
    var outs = payOuts(v), nIn = v.inputs.length;
    var mix = coinjoinLike(v, opts);
    if (mix) flags.push({ kind: 'coinjoin', short: 'COINJOIN?', color: COLORS.coinjoin,
                          title: 'Looks like a CoinJoin: ' + mix.inputs + ' input wallets and ' + mix.equal + ' outputs of exactly ' + btc(mix.amount) + '. Addresses spent together here are probably not one owner, so they are not clustered.' });
    else if (nIn >= cfg.consolidation.minIn && outs.length <= cfg.consolidation.maxOut) {
      flags.push({ kind: 'consolidation', short: 'CONSOL ' + nIn + '→' + outs.length, color: COLORS.consolidation,
                   title: 'Consolidation: ' + nIn + ' inputs gathered into ' + outs.length + ' output' + (outs.length === 1 ? '' : 's') + '. Usually one owner tidying up their coins.' });
    } else if (outs.length >= cfg.batch.minOut && nIn <= cfg.batch.maxIn) {
      flags.push({ kind: 'batch', short: 'BATCH ' + nIn + '→' + outs.length, color: COLORS.batch,
                   title: 'Batch payment: ' + nIn + ' input' + (nIn === 1 ? '' : 's') + ' paying ' + outs.length + ' outputs. Typical of an exchange or service paying many people at once.' });
    }
    return flags;
  }

  // ---- change ---------------------------------------------------------------------------------------
  /**
   * Which output most likely returns to the sender. Returns null when nothing can be said, otherwise
   * { vout, id, address, amount, confidence: 'high'|'medium'|'low', score, reasons: [text] }.
   * Signals, each adding to the score of the output it points at:
   *   100  the output's address is also an input address (the wallet paid itself)
   *    40  it is the only output of the same address type as every input
   *    35  the other output pays a wallet you tagged or that is on the known list
   *    30  the other output is a round amount and this one is not
   *    20  it is smaller than every input (a wallet would not have added the extra inputs to pay it)
   *    15/30  its spender has this transaction's wallet fingerprint and the other output's spender does not (15 when it is a common default)
   * The best output needs to lead the next by enough to be named, so close calls give null.
   * opts.known(address) -> true for a wallet that is labelled or tagged.
   */
  function guessChange(v, opts) {
    if (!v || v.coinbase || !v.complete) return null;
    var outs = payOuts(v);
    if (outs.length < 2) return null;
    var votes = outs.map(function () { return { score: 0, reasons: [], reuse: false }; });
    function vote(i, pts, why, reuse) { votes[i].score += pts; votes[i].reasons.push(why); if (reuse) votes[i].reuse = true; }

    var inAddr = new Set(inputAddresses(v).map(function (i) { return i.address; }));
    var reused = []; outs.forEach(function (o, i) { if (o.address && inAddr.has(o.address)) reused.push(i); });
    if (reused.length === 1) vote(reused[0], 100, 'its address is also one of the inputs: the wallet paid itself back', true);

    var types = new Set(); v.inputs.forEach(function (i) { if (i.scriptType) types.add(i.scriptType); });
    if (types.size === 1) {
      var t = Array.from(types)[0], same = [], other = 0;
      outs.forEach(function (o, i) { if (o.scriptType === t) same.push(i); else if (o.scriptType) other++; });
      if (same.length === 1 && other >= 1) vote(same[0], 40, 'the only output of the same address type as the inputs (' + t + ')');
    }

    if (opts && typeof opts.known === 'function') {
      var knownIdx = []; outs.forEach(function (o, i) { if (o.address && opts.known(o.address)) knownIdx.push(i); });
      if (knownIdx.length === 1) outs.forEach(function (o, i) { if (i !== knownIdx[0]) vote(i, 35, 'the other output pays a known or tagged wallet'); });
    }

    if (v.graph) {                                                                      // the next spender of an output looks like it came from the same wallet software, the other does not
      var fp = fingerprint(v.node), same = [], differ = [];
      if (fp) outs.forEach(function (o, i) {
        if (!o.spender) return;
        var sp = v.graph.nodes.get(ID.tx(o.spender)), f2 = sp ? fingerprint(sp) : null;
        if (f2) (sameWallet(fp, f2) ? same : differ).push(i);
      });
      if (same.length === 1 && differ.length >= 1) vote(same[0], fp.common ? 15 : 30, 'it was spent by a transaction that looks like it came from the same wallet software as this one (same version, locktime and sequence habits)' + (fp.common ? ', a weak sign because those are the defaults of many wallets' : '') + ', while the other output went to a different kind');
    }

    var zeros = outs.map(function (o) { return trailingZeros(o.amount); }), roundIdx = [];
    zeros.forEach(function (z, i) { if (z >= 4) roundIdx.push(i); });
    if (roundIdx.length === 1) outs.forEach(function (o, i) { if (i !== roundIdx[0] && zeros[i] <= 2) vote(i, 30, 'the other output is a round amount (' + fmtSat(outs[roundIdx[0]].amount) + ' sat) and this one is not'); });

    if (v.inputs.length >= 2) {
      var minIn = Math.min.apply(null, v.inputs.map(function (i) { return i.amount; })), small = [];
      outs.forEach(function (o, i) { if (o.amount < minIn) small.push(i); });
      if (small.length === 1 && small.length < outs.length) vote(small[0], 20, 'smaller than every input: a wallet would not have added the extra inputs just to pay it');
    }

    var order = votes.map(function (x, i) { return i; }).sort(function (a, b) { return votes[b].score - votes[a].score || a - b; });
    var top = votes[order[0]], second = votes[order[1]], margin = top.score - second.score;
    var confidence = margin >= 60 ? 'high' : margin >= 35 ? 'medium' : margin >= 20 ? 'low' : null;
    if (!confidence) return null;
    var o = outs[order[0]];
    return { vout: o.vout, id: o.id, edgeId: o.edgeId, address: o.address, amount: o.amount, confidence: confidence, score: top.score, reasons: top.reasons.slice() };
  }

  // ---- peel chains ----------------------------------------------------------------------------------
  /** One input, two outputs, the small one at most `maxRatio` of the large one. */
  function peelStep(v, opts) {
    var c = Object.assign({}, DEFAULTS.peel, opts && opts.peel);
    if (!v || v.coinbase || !v.complete || v.inputs.length !== 1) return null;
    var outs = payOuts(v);
    if (outs.length !== 2 || outs[0].amount <= 0 || outs[1].amount <= 0) return null;
    var large = outs[0].amount >= outs[1].amount ? outs[0] : outs[1], small = large === outs[0] ? outs[1] : outs[0];
    if (small.amount / large.amount > c.maxRatio) return null;
    return { large: large, small: small, ratio: small.amount / large.amount };
  }

  /**
   * Runs of transactions that each peel a smaller output off one coin and pass the rest on to the next, in what is loaded.
   * [{ txids, peeled: [{txid, vout, id, amount}], start, end, totalPeeled, continues: 'spent'|'unspent'|'unknown' }]
   * The same shape is what ordinary wallets produce when they pay out of a single coin, so a chain is a pattern to look at, not a finding.
   */
  function peelChains(graph, opts) {
    var c = Object.assign({}, DEFAULTS.peel, opts && opts.peel), steps = new Map(), next = new Map(), hasPrev = new Set();
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.loaded !== true) return;
      var v = txView(graph, n.id), s = v && peelStep(v, opts); if (s) steps.set(n.id, { v: v, s: s });
    });
    steps.forEach(function (st, id) {
      var sp = st.s.large.spender; if (!sp) return;
      var nid = ID.tx(sp), nx = steps.get(nid);
      if (nx && nx.v.inputs[0].prev && nx.v.inputs[0].prev.txid === st.v.txid && nx.v.inputs[0].prev.vout === st.s.large.vout) { next.set(id, nid); hasPrev.add(nid); }
    });
    var chains = [];
    steps.forEach(function (st, id) {
      if (hasPrev.has(id)) return;
      var ids = [id], cur = id;
      while (next.has(cur)) { cur = next.get(cur); ids.push(cur); }
      if (ids.length < c.minLength) return;
      var last = steps.get(ids[ids.length - 1]).s.large;
      chains.push({
        txids: ids.map(function (x) { return x.slice(3); }), ids: ids,
        peeled: ids.map(function (x) { var s = steps.get(x), o = s.s.small; return { txid: s.v.txid, vout: o.vout, id: o.id, amount: o.amount }; }),
        start: steps.get(id).v.inputs[0].amount, end: last.amount,
        totalPeeled: ids.reduce(function (sum, x) { return sum + steps.get(x).s.small.amount; }, 0),
        continues: last.spent === true ? 'spent' : last.spent === false ? 'unspent' : 'unknown'
      });
    });
    chains.sort(function (a, b) { return b.ids.length - a.ids.length || (a.ids[0] < b.ids[0] ? -1 : 1); });
    chains.forEach(function (ch, i) { ch.label = 'P' + (i + 1); });
    return chains;
  }

  // ---- clusters -------------------------------------------------------------------------------------
  /**
   * Addresses spent together as inputs of one transaction are assumed to share an owner (the common-input rule).
   * Not applied to CoinJoin-like transactions, nor to any whose node has noCluster = true (excluded by hand).
   * Returns { list: [{label, id, addrs: [vertexId], txs: [txid], size}], byAddr: Map(vertexId -> cluster), skipped: {coinjoin, excluded} }.
   */
  function clusters(graph, opts) {
    var parent = new Map(), links = [], skipped = { coinjoin: 0, excluded: 0 };
    function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    function add(x) { if (!parent.has(x)) parent.set(x, x); }
    function union(a, b) { add(a); add(b); var ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.loaded !== true) return;
      var v = txView(graph, n.id);
      if (!v || v.coinbase || !v.complete) return;
      var addrs = inputAddresses(v);
      if (addrs.length < 2) return;
      if (n.noCluster === true) { skipped.excluded++; return; }
      if (coinjoinLike(v, opts)) { skipped.coinjoin++; return; }
      for (var i = 1; i < addrs.length; i++) union(addrs[0].id, addrs[i].id);
      links.push({ txid: v.txid, first: addrs[0].id });
    });
    var groups = new Map();
    parent.forEach(function (p, id) { var r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); });
    var list = [];
    groups.forEach(function (members, root) {
      if (members.length < 2) return;
      members.sort();
      list.push({ id: root, addrs: members, size: members.length, txs: [] });
    });
    var byRoot = new Map(); list.forEach(function (cl) { byRoot.set(cl.id, cl); });
    links.forEach(function (l) { var cl = byRoot.get(find(l.first)); if (cl) cl.txs.push(l.txid); });
    list.sort(function (a, b) { return b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var byAddr = new Map();
    list.forEach(function (cl, i) { cl.label = 'C' + (i + 1); cl.addrs.forEach(function (a) { byAddr.set(a, cl); }); });
    return { list: list, byAddr: byAddr, skipped: skipped };
  }

  // ---- everything at once ----------------------------------------------------------------------------
  /**
   * Analyse the whole graph. opts: { known(address), minConfidence ('medium'), consolidation, batch, coinjoin, peel }.
   * Returns { tx: Map(txId -> {flags, change, chain}), changeEdges: Map(edgeId -> guess), chains, clusters, counts }.
   */
  function analyse(graph, opts) {
    opts = opts || {};
    var minRank = CONFIDENCE[opts.minConfidence || 'medium'] || 2;
    var res = { tx: new Map(), changeEdges: new Map(), chains: [], clusters: null, counts: { flagged: 0, chains: 0, change: 0 } };
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.loaded !== true) return;
      var v = txView(graph, n.id); if (!v) return;
      var flags = classify(v, opts), change = guessChange(v, opts);
      res.tx.set(n.id, { flags: flags, change: change, chain: null });
      if (change && CONFIDENCE[change.confidence] >= minRank) { res.changeEdges.set(change.edgeId, change); res.counts.change++; }
    });
    res.chains = peelChains(graph, opts);
    res.chains.forEach(function (ch) {
      ch.ids.forEach(function (id, i) {
        var rec = res.tx.get(id); if (!rec) return;
        rec.chain = { label: ch.label, step: i + 1, of: ch.ids.length };
        rec.flags.push({ kind: 'peel', short: 'PEEL ' + (i + 1) + '/' + ch.ids.length, color: COLORS.peel,
                         title: 'Step ' + (i + 1) + ' of ' + ch.ids.length + ' in a possible peel chain (' + ch.label + '): each transaction pays a smaller amount out of a single coin and passes the rest on. Ordinary wallets paying from one coin look the same.' });
      });
    });
    res.tx.forEach(function (r) { if (r.flags.length) res.counts.flagged++; });
    res.counts.chains = res.chains.length;
    res.clusters = clusters(graph, opts);
    return res;
  }

  // ---- automatic expansion ----------------------------------------------------------------------------
  /**
   * Where to go from a loaded transaction when expanding automatically. dir: 'next' (what spent its outputs) or 'prev'
   * (what funded it). Returns { next: [txid], items: [...], stop: null | reason }.
   *   next    transactions to continue with, largest amount first
   *   items   the wallets on that side of the transaction, with what happens to each:
   *           { index, id, address, amount, followed: bool, why: reason it is not followed | null, spender }
   * opts: { follow: 'all' | 'largest' | 'change' | 'peel', perTx (default 10), minSats, stopAtMix, mark(address) -> text|null, known(address) }
   *   'change' and 'peel' look forward only; backward they behave like 'largest'. A rule that cannot decide stops rather than guessing.
   */
  function successors(graph, txId, dir, opts) {
    opts = opts || {};
    var res = { next: [], items: [], stop: null }, v = txView(graph, txId);
    if (!v) { res.stop = 'not loaded'; return res; }
    if (!v.complete) { res.stop = 'incomplete data'; return res; }
    if (v.coinbase && dir === 'prev') { res.stop = 'coinbase: newly created coins'; return res; }
    if (opts.stopAtMix && coinjoinLike(v, opts)) { res.stop = 'looks like a CoinJoin'; return res; }
    var forward = dir === 'next', rule = opts.follow || 'all', perTx = Math.max(1, opts.perTx || 10), minSats = opts.minSats || 0;
    var list = forward ? payOuts(v) : v.inputs.filter(function (i) { return i.type !== 'coinbase'; });
    var items = list.map(function (x, k) {
      return { index: forward ? x.vout : x.vin, id: x.id, address: x.address, amount: x.amount, followed: false, why: null, spender: forward ? x.spender : (x.prev ? x.prev.txid : null),
               spent: forward ? x.spent : null, ord: k };
    });
    var ranked = items.slice().sort(function (a, b) { return b.amount - a.amount || a.ord - b.ord; });
    var chosen = [];
    if (forward && rule === 'peel') {
      var st = peelStep(v, opts);
      if (!st) { res.stop = 'not a peel step (needs one input and two outputs, the small one at most ' + Math.round((Object.assign({}, DEFAULTS.peel, opts.peel).maxRatio) * 100) + '% of the large one)'; res.items = ranked.slice(0, perTx); return res; }
      chosen = ranked.filter(function (it) { return it.index === st.large.vout; });
    } else if (forward && rule === 'change') {
      if (items.length === 1) chosen = items.slice();
      else {
        var g = guessChange(v, opts);
        if (!g) { res.stop = 'no clear change output (not enough evidence to tell which output returns to the sender)'; res.items = ranked.slice(0, perTx); return res; }
        chosen = ranked.filter(function (it) { return it.index === g.vout; });
      }
    } else if (rule === 'largest' || rule === 'change' || rule === 'peel') chosen = ranked.slice(0, 1);
    else chosen = ranked.slice(0, perTx);
    var pick = new Set(chosen.filter(function (it) { return it.amount >= minSats; }).map(function (it) { return it.index; }));
    var seen = new Set();
    ranked.forEach(function (it) {
      if (!pick.has(it.index)) { if (chosen.indexOf(it) >= 0) it.why = 'below the minimum amount'; return; }
      var m = opts.mark && it.address ? opts.mark(it.address) : null;
      if (m) it.why = 'labelled: ' + m;
      else if (forward && it.spent === false) it.why = 'unspent';
      else if (!it.spender) it.why = forward ? 'spender not known' : 'funding transaction not known';
      else { it.followed = true; if (!seen.has(it.spender)) { seen.add(it.spender); res.next.push(it.spender); } }
    });
    // what is shown for context: everything followed, then the largest of the rest, up to perTx
    var shown = ranked.filter(function (it) { return it.followed || it.why; });
    ranked.forEach(function (it) { if (shown.length < perTx && shown.indexOf(it) < 0) shown.push(it); });
    res.items = shown;
    return res;
  }

  return {
    DEFAULTS: DEFAULTS, COLORS: COLORS, txView: txView, fingerprint: fingerprint, sameWallet: sameWallet, payOuts: payOuts, classify: classify, coinjoinLike: coinjoinLike, guessChange: guessChange,
    peelStep: peelStep, peelChains: peelChains, clusters: clusters, analyse: analyse, successors: successors, rank: function (c) { return CONFIDENCE[c] || 0; }
  };
}));
