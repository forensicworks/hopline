/*
 * Hopline graph model.
 *
 * A Bitcoin investigation graph with TWO kinds of vertex that matter and a few special ones:
 *   tx        a transaction                       id "tx:<txid>"
 *   addr      an address                          id "addr:<address>"
 *   coinbase  newly minted coins (coinbase input) id "cb:<txid>"
 *   data      an OP_RETURN output                 id "data:<txid>:<vout>"
 *   nonstd    an output with no address           id "ns:<txid>:<vout>"
 *
 * Edges always run in the direction money moves, and every edge belongs to ONE transaction:
 *   in   addr|coinbase|nonstd -> tx    id "in:<txid>:<vin>"    (amount = value of the spent output)
 *   out  tx -> addr|data|nonstd        id "out:<txid>:<vout>"  (amount = value of the output)
 *
 * Unlike the original Orion pages this keeps what the API returns: confirmation time, amounts in
 * satoshis and script types. Plain data (no DOM), so it runs in a browser and under `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID = {
    tx: function (txid) { return 'tx:' + txid; },
    addr: function (a) { return 'addr:' + a; },
    coinbase: function (txid) { return 'cb:' + txid; },
    data: function (txid, n) { return 'data:' + txid + ':' + n; },
    nonstd: function (txid, n) { return 'ns:' + txid + ':' + n; },
    edgeIn: function (txid, i) { return 'in:' + txid + ':' + i; },
    edgeOut: function (txid, n) { return 'out:' + txid + ':' + n; }
  };

  // ---- OP_RETURN payload ---------------------------------------------------------------------
  function hexToBytes(hex) {
    var out = [];
    for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  /** Decode an OP_RETURN script (hex) into {hex, text}. text is '' unless the payload is mostly printable. */
  function decodeOpReturn(scriptHex) {
    var b = hexToBytes(scriptHex || '');
    var payload = [];
    var i = (b[0] === 0x6a) ? 1 : 0;
    while (i < b.length) {
      var op = b[i++];
      var len;
      if (op >= 1 && op <= 75) len = op;
      else if (op === 0x4c) { len = b[i]; i += 1; }
      else if (op === 0x4d) { len = b[i] | (b[i + 1] << 8); i += 2; }
      else if (op === 0x4e) { len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) >>> 0; i += 4; }   // 4-byte length; payloads this size don't occur on-chain
      else continue;                                                                                // OP_0 / other opcodes carry no data
      if (!(len >= 0)) break;
      for (var k = 0; k < len && i < b.length; k++) payload.push(b[i++]);
    }
    var hex = payload.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    var printable = payload.filter(function (x) { return x >= 32 && x < 127; }).length;
    var text = '';
    if (payload.length >= 4 && printable / payload.length >= 0.8) {
      text = payload.slice(0, 120).map(function (x) { return (x >= 32 && x < 127) ? String.fromCharCode(x) : '.'; }).join('');
    }
    return { hex: hex, text: text };
  }

  // ---- Graph ----------------------------------------------------------------------------------
  function Graph() {
    this.nodes = new Map();
    this.edges = new Map();
    this.adj = new Map();            // node id -> Set of incident edge ids
  }

  // Merge rule used everywhere: null/undefined never overwrite a value we already know.
  function mergeInto(target, incoming) {
    Object.keys(incoming).forEach(function (k) {
      var v = incoming[k];
      if (v !== undefined && v !== null) target[k] = v;
    });
    return target;
  }

  Graph.prototype.node = function (id) { return this.nodes.get(id); };

  Graph.prototype.upsertNode = function (n) {
    var cur = this.nodes.get(n.id);
    if (!cur) { cur = { id: n.id, type: n.type }; this.nodes.set(n.id, cur); this.adj.set(n.id, new Set()); }
    if (cur.loaded === true && n.loaded === false) { n = Object.assign({}, n); delete n.loaded; }   // a stub never demotes a loaded tx
    mergeInto(cur, n);
    return cur;
  };

  Graph.prototype.upsertEdge = function (e) {
    var cur = this.edges.get(e.id);
    if (!cur) {
      cur = { id: e.id };
      this.edges.set(e.id, cur);
    }
    mergeInto(cur, e);
    if (!this.adj.has(cur.source)) this.adj.set(cur.source, new Set());
    if (!this.adj.has(cur.target)) this.adj.set(cur.target, new Set());
    this.adj.get(cur.source).add(cur.id);
    this.adj.get(cur.target).add(cur.id);
    return cur;
  };

  Graph.prototype.edgesOf = function (id) {
    var s = this.adj.get(id), out = [];
    if (s) s.forEach(function (eid) { out.push(this.edges.get(eid)); }, this);
    return out;
  };

  function outputNode(g, txid, o, n) {
    // returns the vertex id that receives output n of txid
    if (o.scriptpubkey_address) {
      g.upsertNode({ id: ID.addr(o.scriptpubkey_address), type: 'addr', address: o.scriptpubkey_address, scriptType: o.scriptpubkey_type });
      return ID.addr(o.scriptpubkey_address);
    }
    if (o.scriptpubkey_type === 'op_return') {
      var d = decodeOpReturn(o.scriptpubkey);
      g.upsertNode({ id: ID.data(txid, n), type: 'data', txid: txid, vout: n, scriptType: 'op_return', dataHex: d.hex, dataText: d.text });
      return ID.data(txid, n);
    }
    g.upsertNode({ id: ID.nonstd(txid, n), type: 'nonstd', txid: txid, vout: n, scriptType: o.scriptpubkey_type || 'nonstandard' });
    return ID.nonstd(txid, n);
  }

  /** Your own label and note for a vertex. Empty text clears it. Returns false when the vertex is unknown. */
  Graph.prototype.annotate = function (id, label, note) {
    var n = this.nodes.get(id);
    if (!n) return false;
    label = (label || '').trim(); note = (note || '').trim();
    if (label) n.label = label; else delete n.label;
    if (note) n.note = note; else delete n.note;
    return true;
  };

  /**
   * BIP 69 (lexicographic ordering of inputs and outputs) is a habit of some wallets. true / false once there are enough
   * inputs and outputs for an ordering to mean anything (a random order would be sorted by chance at most 1 time in 6:
   * inputs! x outputs! >= 6), otherwise null (not known).
   */
  function factorial(n) { var f = 1; for (var i = 2; i <= n && i < 10; i++) f *= i; return f; }
  function sortedBip69(t) {
    if (!t.vin || !t.vout || factorial(t.vin.length) * factorial(t.vout.length) < 6) return null;
    if (t.vin.some(function (v) { return v.is_coinbase; })) return null;
    var inOk = true, outOk = true, i;
    for (i = 1; i < t.vin.length; i++) {
      var a = t.vin[i - 1], b = t.vin[i];
      if (a.txid > b.txid || (a.txid === b.txid && a.vout > b.vout)) inOk = false;
    }
    for (i = 1; i < t.vout.length; i++) {
      var p = t.vout[i - 1], q = t.vout[i];
      if (typeof p.scriptpubkey !== 'string' || typeof q.scriptpubkey !== 'string') return null;
      if (p.value > q.value || (p.value === q.value && p.scriptpubkey > q.scriptpubkey)) outOk = false;
    }
    return inOk && outOk;
  }

  /** Ingest one Esplora transaction object. Safe to call repeatedly (idempotent). */
  Graph.prototype.addTx = function (t) {
    var txid = t.txid;
    var confirmed = !!(t.status && t.status.confirmed);
    var time = confirmed && t.status.block_time != null ? t.status.block_time : null;
    var isCoinbase = !!(t.vin && t.vin[0] && t.vin[0].is_coinbase);
    var valueOut = t.vout.reduce(function (s, o) { return s + (o.value || 0); }, 0);
    var valueIn = isCoinbase ? null : t.vin.reduce(function (s, v) { return s + ((v.prevout && v.prevout.value) || 0); }, 0);
    var txId = ID.tx(txid);
    this.upsertNode({
      id: txId, type: 'tx', txid: txid, loaded: true, confirmed: confirmed, time: time,
      height: confirmed ? t.status.block_height : null,
      fee: t.fee != null ? t.fee : null,
      vsize: t.weight ? Math.ceil(t.weight / 4) : (t.size || null),
      nIn: t.vin.length, nOut: t.vout.length, valueIn: valueIn, valueOut: valueOut, coinbase: isCoinbase,
      // the habits of the wallet that made it (see HoplineAnalysis.fingerprint): version, locktime, the sequence numbers used, BIP 69 ordering
      version: typeof t.version === 'number' ? t.version : null, locktime: typeof t.locktime === 'number' ? t.locktime : null,
      seqs: t.vin.map(function (v) { return v.sequence; }).filter(function (s, i, a) { return typeof s === 'number' && a.indexOf(s) === i; }).sort(function (x, y) { return x - y; }).slice(0, 4),
      bip69: sortedBip69(t)
    });

    var g = this;
    t.vout.forEach(function (o, n) {
      var target = outputNode(g, txid, o, n);
      g.upsertEdge({ id: ID.edgeOut(txid, n), source: txId, target: target, kind: 'out', txid: txid, vout: n,
                     amount: o.value || 0, time: time, confirmed: confirmed });
    });

    t.vin.forEach(function (v, i) {
      var source, prev = null;
      if (v.is_coinbase || !v.prevout) {
        source = ID.coinbase(txid);
        g.upsertNode({ id: source, type: 'coinbase', txid: txid });
      } else {
        source = outputNode(g, v.txid, v.prevout, v.vout);
        prev = { txid: v.txid, vout: v.vout };
        // the funding transaction: a stub until it is loaded (its own addTx fills in the rest)
        var stubId = ID.tx(v.txid);
        if (!g.nodes.has(stubId)) g.upsertNode({ id: stubId, type: 'tx', txid: v.txid, loaded: false, confirmed: null, time: null });
        var fundId = ID.edgeOut(v.txid, v.vout);
        if (!g.edges.has(fundId)) {
          g.upsertEdge({ id: fundId, source: stubId, target: source, kind: 'out', txid: v.txid, vout: v.vout, amount: v.prevout.value || 0, time: null });
        }
        g.edges.get(fundId).spent = true; delete g.edges.get(fundId).spentInferred;
        g.edges.get(fundId).spentBy = { txid: txid, vin: i, time: time };
      }
      g.upsertEdge({ id: ID.edgeIn(txid, i), source: source, target: txId, kind: 'in', txid: txid, vin: i,
                     amount: v.is_coinbase || !v.prevout ? valueOut : (v.prevout.value || 0), time: time, confirmed: confirmed, prev: prev });
    });
    delete g.nodes.get(txId).carried;                                                   // the marks a link carried (hopline-analysis.js) were for a transaction that was only partly there
    return txId;
  };

  /**
   * Ingest GET /address/<addr> (the totals the server keeps for an address): what it ever received and spent on chain, and the
   * same for unconfirmed transactions. meta = { at: unix seconds it was read, source: the API, history: true when the wallet's
   * transactions are read with it }. Without that the wallet is marked balanceOnly: the totals say how many transactions it has
   * and what it holds, but none of its history is loaded (see historyRead). See balanceOf.
   */
  Graph.prototype.addAddressStats = function (addr, a, meta) {
    var cs = (a && a.chain_stats) || {}, ms = (a && a.mempool_stats) || {}, cur = this.nodes.get(ID.addr(addr));
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
    var only = !(meta && meta.history) && !(cur && cur.txCount != null && !cur.balanceOnly);          // a wallet whose history was asked for stays so
    var node = this.upsertNode({ id: ID.addr(addr), type: 'addr', address: addr, balanceOnly: only ? true : null, txCount: (num(cs.tx_count) || 0) + (num(ms.tx_count) || 0),
                                 fundedSum: num(cs.funded_txo_sum), spentSum: num(cs.spent_txo_sum), mempoolFundedSum: num(ms.funded_txo_sum), mempoolSpentSum: num(ms.spent_txo_sum),
                                 statsAt: meta && meta.at != null ? meta.at : null, statsSource: meta && meta.source ? meta.source : null });
    if (!only) delete node.balanceOnly;
    return node;
  };

  /**
   * What an address holds, from its stats: { confirmed, pending, total, received, sent } in satoshis (pending = unconfirmed
   * received minus unconfirmed spent, which can be negative), or null when its stats were never loaded.
   */
  function balanceOf(n) {
    if (!n || n.type !== 'addr' || n.fundedSum == null || n.spentSum == null) return null;
    var confirmed = n.fundedSum - n.spentSum, pending = (n.mempoolFundedSum || 0) - (n.mempoolSpentSum || 0);
    return { confirmed: confirmed, pending: pending, total: confirmed + pending, received: n.fundedSum, sent: n.spentSum };
  }

  /**
   * Has the transaction history of this wallet been asked for? Its transaction count alone does not say so: the totals the server
   * keeps (what a balance read brings) include it, and then the transactions themselves are still to load.
   */
  function historyRead(n) { return !!n && n.type === 'addr' && n.txCount != null && !n.balanceOnly; }

  /**
   * Does the graph hold everything this wallet ever spent? True when its whole history was read (no further page, nothing cut off), or when its totals say that what it spent is what the graph
   * holds of it (a wallet that never spent: both are 0). Then a coin that came to it and that no loaded transaction spends is unspent, whether or not the outspends of the transaction that paid it
   * were ever read. False when it is not known (no history, no totals) or when more of its spending exists than the graph holds.
   */
  function spendingComplete(n) {
    if (!n || n.type !== 'addr' || n.histNext) return false;
    if (historyRead(n) && n.histDone === true) return true;
    if (n.fundedSum == null || n.spentSum == null) return false;
    return (n.sent || 0) >= n.spentSum + (n.mempoolSpentSum || 0);
  }

  /**
   * Could more of this wallet's transactions exist than the graph holds, going `dir` ('next': what it spent, 'prev': what it received, none: either)?
   * Yes while a further page of its history is waiting, or its history was never asked for. Then its totals decide when they were read: what the
   * graph holds of what it received (spent) adding up to what the server counts means nothing is left that way, and a wallet that never spent
   * has nothing going forward.
   */
  function historyOpen(n, dir) {
    if (!n || n.type !== 'addr') return false;
    if (n.histNext) return true;
    if (historyRead(n)) return false;
    if (n.fundedSum == null || n.spentSum == null) return true;
    var spends = (n.sent || 0) < n.spentSum + (n.mempoolSpentSum || 0), funds = (n.received || 0) < n.fundedSum + (n.mempoolFundedSum || 0);
    return dir === 'next' ? spends : dir === 'prev' ? funds : spends || funds;
  }

  /**
   * Does the graph hold fewer of this loaded transaction's inputs (dir 'prev'), outputs (dir 'next') or either (no dir) than the transaction has? A canvas link leaves it so:
   * the transaction is there with its totals (nIn, nOut) but only the edges between the vertices that were kept. Nothing can be concluded from such a transaction (the analysis
   * skips it), and loading it again fills it in. null when nothing is missing, or when the transaction is not loaded at all (that has its own mark: loaded === false).
   * Otherwise { inHave, nIn, outHave, nOut }, both sides counted.
   */
  function txPartial(graph, n, dir) {
    if (!n || n.type !== 'tx' || n.loaded !== true || typeof n.nIn !== 'number' || typeof n.nOut !== 'number') return null;
    var inHave = 0, outHave = 0;
    graph.edgesOf(n.id).forEach(function (e) { if (e.kind === 'in' && e.target === n.id) inHave++; else if (e.kind === 'out' && e.source === n.id) outHave++; });
    var lackIn = inHave < n.nIn, lackOut = outHave < n.nOut;
    if (dir === 'prev' ? !lackIn : dir === 'next' ? !lackOut : !(lackIn || lackOut)) return null;
    return { inHave: inHave, nIn: n.nIn, outHave: outHave, nOut: n.nOut };
  }

  /** Ingest GET /tx/<id>/outspends: marks which outputs are spent, and by whom (with the spender's time). */
  Graph.prototype.addOutspends = function (txid, outspends) {
    var g = this;
    if (g.nodes.has(ID.tx(txid))) g.nodes.get(ID.tx(txid)).outspendsLoaded = true;
    outspends.forEach(function (o, n) {
      var edge = g.edges.get(ID.edgeOut(txid, n));
      if (!edge) return;
      delete edge.spentInferred;
      if (!o || !o.spent) { edge.spent = false; return; }
      var confirmed = !!(o.status && o.status.confirmed);
      var time = confirmed && o.status.block_time != null ? o.status.block_time : null;
      edge.spent = true;
      edge.spentBy = { txid: o.txid, vin: o.vin, time: time };
      var spenderId = ID.tx(o.txid);
      if (!g.nodes.has(spenderId)) {
        g.upsertNode({ id: spenderId, type: 'tx', txid: o.txid, loaded: false, confirmed: confirmed, time: time });
      } else if (!g.nodes.get(spenderId).loaded) {
        mergeInto(g.nodes.get(spenderId), { confirmed: confirmed, time: time });
      }
      g.upsertEdge({ id: ID.edgeIn(o.txid, o.vin), source: edge.target, target: spenderId, kind: 'in', txid: o.txid, vin: o.vin,
                     amount: edge.amount, time: time, confirmed: confirmed, prev: { txid: txid, vout: n } });
    });
  };

  Graph.prototype.removeEdge = function (id) {
    var e = this.edges.get(id);
    if (!e) return;
    var a = this.adj.get(e.source), b = this.adj.get(e.target);
    if (a) a.delete(id);
    if (b) b.delete(id);
    this.edges.delete(id);
  };

  Graph.prototype.dropNode = function (id) {
    this.nodes.delete(id); this.adj.delete(id);
  };

  /**
   * Remove a vertex and its edges, then whatever it leaves dangling: vertices with no edges, and
   * unloaded transaction stubs that only hang off vertices nothing else touches. Returns removed ids.
   */
  Graph.prototype.removeNode = function (id) {
    if (!this.nodes.has(id)) return [];
    var removed = [id], g = this, touched = new Set();
    this.edgesOf(id).forEach(function (e) { touched.add(e.source); touched.add(e.target); g.removeEdge(e.id); });
    this.dropNode(id);
    touched.delete(id);
    // candidates: the old neighbours and their neighbours (a funding stub sits one step beyond an input address)
    var queue = [];
    touched.forEach(function (nid) {
      queue.push(nid);
      g.edgesOf(nid).forEach(function (e) { queue.push(e.source === nid ? e.target : e.source); });
    });
    while (queue.length) {
      var nid = queue.pop(), n = this.nodes.get(nid);
      if (!n) continue;
      var edges = this.edgesOf(nid);
      var dangling = edges.length === 0;
      if (!dangling && n.type === 'tx' && n.loaded === false) {
        // a stub whose every neighbour has no other connection: it only existed because of what was removed
        dangling = edges.every(function (e) {
          var other = e.source === nid ? e.target : e.source;
          return g.adj.get(other).size === 1;
        });
      }
      if (!dangling) continue;
      edges.forEach(function (e) {
        var other = e.source === nid ? e.target : e.source;
        g.removeEdge(e.id);
        queue.push(other);
      });
      this.dropNode(nid);
      removed.push(nid);
    }
    return removed;
  };

  /** Compute per-vertex first/last seen, received/sent and degree from the edges. */
  Graph.prototype.refreshDerived = function () {
    this.nodes.forEach(function (n) { n.firstSeen = null; n.lastSeen = null; n.received = 0; n.sent = 0; n.degree = 0; });
    var g = this;
    this.edges.forEach(function (e) { if (e.spentInferred) { delete e.spent; delete e.spentInferred; } });       // what was worked out is worked out again below, from what the graph holds now
    function touch(n, t) {
      if (t == null) return;
      if (n.firstSeen == null || t < n.firstSeen) n.firstSeen = t;
      if (n.lastSeen == null || t > n.lastSeen) n.lastSeen = t;
    }
    this.edges.forEach(function (e) {
      var s = g.nodes.get(e.source), t = g.nodes.get(e.target);
      if (!s || !t) return;
      s.degree++; t.degree++;
      if (e.kind === 'out') t.received += e.amount; else s.sent += e.amount;
      touch(s, e.time); touch(t, e.time);
    });
    this.nodes.forEach(function (n) { if (n.type === 'tx' && n.time != null) { n.firstSeen = n.time; n.lastSeen = n.time; } });
    this.edges.forEach(function (e) {                                       // a coin into a wallet whose spending the graph holds in full, and that nothing in the graph spends: unspent
      if (e.kind !== 'out' || e.spent != null) return;
      var t = g.nodes.get(e.target);
      if (t && spendingComplete(t)) { e.spent = false; e.spentInferred = true; }
    });
  };

  /**
   * What an address received and sent in the graph, told into money from and to others and its own change: in a transaction that spent from the address and paid some of it
   * back to it, the part that came back (the smaller of what it received and what it sent there) is its own, and counts both ways. So `received` and `sent` are the totals
   * (what refreshDerived puts on the vertex), `fromOthers` and `toOthers` leave the own change out, and received minus sent equals fromOthers minus toOthers.
   * Returns { received, sent, own, ownTxs (in how many transactions), fromOthers, toOthers, txs: [{ id, time, recv, sent }] } in satoshis.
   */
  Graph.prototype.flowOf = function (id) {
    var per = new Map(), g = this, received = 0, sent = 0;
    this.edgesOf(id).forEach(function (e) {
      var tx, side;
      if (e.kind === 'out' && e.target === id) { tx = e.source; side = 'recv'; received += e.amount; }
      else if (e.kind === 'in' && e.source === id) { tx = e.target; side = 'sent'; sent += e.amount; }
      else return;
      var r = per.get(tx);
      if (!r) { var t = g.nodes.get(tx); r = { id: tx, time: t ? t.time : null, recv: 0, sent: 0 }; per.set(tx, r); }
      r[side] += e.amount;
    });
    var own = 0, ownTxs = 0, txs = [];
    per.forEach(function (r) { var m = Math.min(r.recv, r.sent); if (m > 0) { own += m; ownTxs++; } txs.push(r); });
    return { received: received, sent: sent, own: own, ownTxs: ownTxs, fromOthers: received - own, toOthers: sent - own, txs: txs };
  };

  /** {min, max, pending, unknown} over confirmed transaction times in the graph (or only the vertices in `only`). */
  Graph.prototype.timeBounds = function (only) {
    var min = null, max = null, pending = 0, unknown = 0;
    this.nodes.forEach(function (n) {
      if (n.type !== 'tx' || (only && !only.has(n.id))) return;
      if (n.time != null) { if (min == null || n.time < min) min = n.time; if (max == null || n.time > max) max = n.time; }
      else if (n.confirmed === false) pending++;
      else unknown++;
    });
    return { min: min, max: max, pending: pending, unknown: unknown };
  };

  Graph.prototype.stats = function () {
    var c = { nodes: this.nodes.size, edges: this.edges.size, tx: 0, txLoaded: 0, addr: 0, data: 0, nonstd: 0, coinbase: 0 };
    this.nodes.forEach(function (n) {
      c[n.type] = (c[n.type] || 0) + 1;
      if (n.type === 'tx' && n.loaded) c.txLoaded++;
    });
    return c;
  };

  Graph.prototype.toData = function () {
    return { nodes: Array.from(this.nodes.values()).map(function (n) { return Object.assign({}, n); }),
             edges: Array.from(this.edges.values()).map(function (e) { return Object.assign({}, e); }) };
  };

  Graph.fromData = function (data) {
    var g = new Graph();
    (data.nodes || []).forEach(function (n) { g.upsertNode(n); });
    (data.edges || []).forEach(function (e) { g.upsertEdge(e); });
    return g;
  };

  return { Graph: Graph, ID: ID, decodeOpReturn: decodeOpReturn, mergeInto: mergeInto, balanceOf: balanceOf, historyRead: historyRead, historyOpen: historyOpen, txPartial: txPartial, spendingComplete: spendingComplete };
}));
