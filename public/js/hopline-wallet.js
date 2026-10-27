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
    if (opts.stats) g.addAddressStats(address, opts.stats, { at: opts.at, source: opts.source });
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

  return { ledger: ledger, summary: summary, csv: csv, COLUMNS: COLUMNS, FIAT_COLUMNS: FIAT_COLUMNS, filterRows: filterRows, rowAmount: rowAmount, counterparties: counterparties, balanceSeries: balanceSeries, cluster: cluster, traceQuery: traceQuery, graphOf: graphOf };
}));
