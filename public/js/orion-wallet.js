/*
 * Orion wallet ledger: turns the transactions the API returns for one address into the rows of a wallet overview (the kind of page
 * a wallet explorer shows): every transaction with its inputs on one side and its outputs on the other, what it did to the wallet,
 * the balance after it, and the labelled wallets it dealt with. Pure functions over plain data, no DOM, no network.
 *
 * Everything here is arithmetic on what the server said; it adds no guesses. Amounts are satoshis.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-model.js'), require('./orion-io.js'), require('./orion-style.js'));
  else root.OrionWallet = factory(root.OrionModel, root.OrionIO, root.OrionStyle);
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
        if (nm && !self && addr) { var a = assoc.get(addr) || { address: addr, label: nm.label, pack: nm.pack || null, category: nm.category || null, txs: 0, asInput: 0, asOutput: 0 }; a.asInput += value; if (!seen.has('i' + addr)) { seen.add('i' + addr); a.txs++; } assoc.set(addr, a); }
      });
      (t.vout || []).forEach(function (o) {
        var addr = o.scriptpubkey_address || null, value = o.value || 0, self = addr === address, nm = nameOf(known, addr);
        var data = o.scriptpubkey_type === 'op_return' ? Model.decodeOpReturn(o.scriptpubkey) : null;
        outputs.push({ address: addr, value: value, type: o.scriptpubkey_type || null, self: self, label: nm ? nm.label : null, pack: nm ? nm.pack || null : null, data: data });
        outTotal += value; if (self) recv += value;
        if (nm && !self && addr) { var a = assoc.get(addr) || { address: addr, label: nm.label, pack: nm.pack || null, category: nm.category || null, txs: 0, asInput: 0, asOutput: 0 }; a.asOutput += value; if (!seen.has('o' + addr) && !seen.has('i' + addr)) a.txs++; seen.add('o' + addr); assoc.set(addr, a); }
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

  var COLUMNS = ['txid', 'time_utc', 'time_unix', 'status', 'height', 'direction', 'received_sat', 'sent_sat', 'net_sat', 'fee_sat', 'balance_after_sat', 'inputs', 'outputs'];
  function cell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    var s = IO.defuse(String(v));
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function side(list) { return list.map(function (x) { return (x.address || (x.data ? 'OP_RETURN' : 'non-standard')) + '=' + x.value; }).join(' '); }
  /** The ledger as CSV text (one line per transaction; inputs and outputs as "address=sats" separated by spaces). */
  function csv(rows) {
    var out = [COLUMNS.join(',')];
    rows.forEach(function (r) {
      out.push([r.txid, r.time == null ? '' : Style.fmtTimeFull(r.time), r.time, r.confirmed ? 'confirmed' : 'unconfirmed', r.height, r.dir, r.recv, r.sent, r.net, r.fee, r.balanceAfter, side(r.inputs), side(r.outputs)].map(cell).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  return { ledger: ledger, summary: summary, csv: csv, COLUMNS: COLUMNS };
}));
