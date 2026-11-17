/*
 * Hopline losses: what wallets of the victim paid to the wallets of the threat actor, what came back, and the total, for a complaint. Pure functions over the graph and its analysis; nothing here touches
 * the DOM or the network.
 *
 * Which wallets are whose is what the analyst says (the VICTIM and THREAT tags, and the reference), not something Hopline finds: the victim's wallets are the ones given and the other wallets spent together
 * with them (the common-input rule), the threat's are exactly the ones given. A payment is a transaction with an input from a victim wallet and an output to a threat wallet, and its amount is what the transaction paid
 * to that wallet, not what the victim's wallet spent (the change that went back is not a loss). What the threat wallets paid back to a victim wallet is `returned`. A transaction that spends coins of both sides is
 * left out and counted in `mixed`: nothing says who paid whom.
 *
 *   find(graph, an, { victims: [wallet id], threats: [wallet id] }) ->
 *     { paid: [row], returned: [row], totalPaid, totalReturned, net, recipients: [{ id, address, paid, count }], mixed, first, last, victimWallets, threatWallets }
 *     row = { txid, time (null when unconfirmed), height, from: [address], to (address), toId, amount (sats), roles: ['test' | 'main'] }
 *   toCsv(result, { fiat(sats, time) -> number | null, today(sats) -> number | null, currency, firstSeen(txid) -> seconds | null }) -> CSV text
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'), require('./hopline-analysis.js'), require('./hopline-patterns.js'), require('./hopline-io.js'));
  else root.HoplineLosses = factory(root.HoplineModel, root.HoplineAnalysis, root.HoplinePatterns, root.HoplineIO);
}(typeof self !== 'undefined' ? self : this, function (Model, AN, PT, IO) {
  'use strict';

  /** The wallets given and, for the victim, the wallets spent together with them: a Set of vertex ids. */
  function expand(an, ids, byOwner) {
    var set = new Set();
    (ids || []).forEach(function (id) {
      if (typeof id !== 'string') return;
      set.add(id);
      var c = byOwner && an && an.clusters && an.clusters.byAddr ? an.clusters.byAddr.get(id) : null;
      if (c) c.addrs.forEach(function (a) { set.add(a); });
    });
    return set;
  }

  function find(graph, an, opts) {
    opts = opts || {};
    var victims = expand(an, opts.victims, true), threats = expand(an, opts.threats, false);
    var res = { paid: [], returned: [], totalPaid: 0, totalReturned: 0, net: 0, recipients: [], mixed: 0, first: null, last: null, victimWallets: victims.size, threatWallets: threats.size };
    if (!victims.size || !threats.size) return res;
    var roles = new Map();
    PT.testPayments(graph, an).forEach(function (p) {
      if (!threats.has(p.test.receiver)) return;
      [['test', p.test.txid], ['main', p.main.txid]].forEach(function (r) { var l = roles.get(r[1]) || []; if (l.indexOf(r[0]) < 0) l.push(r[0]); roles.set(r[1], l); });
    });
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx' || n.loaded !== true || n.coinbase) return;
      var v = AN.txView(graph, id); if (!v) return;
      var fromV = [], fromT = [];
      v.inputs.forEach(function (i) { if (i.type !== 'addr') return; if (victims.has(i.id) && fromV.indexOf(i.address) < 0) fromV.push(i.address); if (threats.has(i.id) && fromT.indexOf(i.address) < 0) fromT.push(i.address); });
      if (!fromV.length && !fromT.length) return;
      if (fromV.length && fromT.length) { if (v.outputs.some(function (o) { return o.type === 'addr' && (threats.has(o.id) || victims.has(o.id)); })) res.mixed++; return; }
      v.outputs.forEach(function (o) {
        if (o.type !== 'addr') return;
        var row = { txid: n.txid, time: n.time == null ? null : n.time, height: n.height == null ? null : n.height, from: fromV.length ? fromV : fromT, to: o.address, toId: o.id, amount: o.amount, roles: roles.get(n.txid) || [] };
        if (fromV.length && threats.has(o.id)) res.paid.push(row);
        else if (fromT.length && victims.has(o.id)) res.returned.push(row);
      });
    });
    var byTime = function (a, b) { return (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0); };
    res.paid.sort(byTime); res.returned.sort(byTime);
    res.totalPaid = res.paid.reduce(function (s, r) { return s + r.amount; }, 0);
    res.totalReturned = res.returned.reduce(function (s, r) { return s + r.amount; }, 0);
    res.net = res.totalPaid - res.totalReturned;
    var by = new Map();
    res.paid.forEach(function (r) { var x = by.get(r.toId); if (!x) by.set(r.toId, x = { id: r.toId, address: r.to, paid: 0, count: 0 }); x.paid += r.amount; x.count++; });
    res.recipients = Array.from(by.values()).sort(function (a, b) { return b.paid - a.paid; });
    var times = res.paid.concat(res.returned).map(function (r) { return r.time; }).filter(function (t) { return t != null; });
    if (times.length) { res.first = Math.min.apply(null, times); res.last = Math.max.apply(null, times); }
    return res;
  }

  function utc(sec) { return sec == null ? '' : new Date(Math.floor(sec) * 1000).toISOString().slice(0, 19).replace('T', ' '); }
  function cell(v) {
    if (v === null || v === undefined) return '';
    var s = typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : IO.defuse(String(v));         // a number is never a formula: a negative one must stay a number in a spreadsheet
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? String(Math.round(v * 100) / 100) : ''; }

  /**
   * The payments and returns as CSV, one row each, oldest first, with a TOTAL row. opts: { fiat(sats, time) and today(sats): numbers or null (fiat off), currency, firstSeen(txid): seconds or null }.
   * Amounts are sats and BTC; a return has a negative amount, so that the column adds up to the net loss.
   */
  function toCsv(res, opts) {
    opts = opts || {};
    var head = ['time_utc', 'txid', 'kind', 'from', 'to', 'amount_sat', 'amount_btc', 'roles', 'block_height', 'first_seen_utc', 'fiat_at_time', 'fiat_today', 'currency'];
    var rows = res.paid.map(function (r) { return [r, 1]; }).concat(res.returned.map(function (r) { return [r, -1]; })).sort(function (a, b) { return (a[0].time == null ? Infinity : a[0].time) - (b[0].time == null ? Infinity : b[0].time); });
    var lines = [head.join(',')], fx = 0, fxToday = 0, fxAny = false, todayAny = false;
    rows.forEach(function (p) {
      var r = p[0], sign = p[1], sats = sign * r.amount, at = typeof opts.fiat === 'function' ? opts.fiat(r.amount, r.time) : null, td = typeof opts.today === 'function' ? opts.today(r.amount) : null;
      if (at != null) { fx += sign * at; fxAny = true; }
      if (td != null) { fxToday += sign * td; todayAny = true; }
      var seen = typeof opts.firstSeen === 'function' ? opts.firstSeen(r.txid) : null;
      lines.push([utc(r.time), r.txid, sign > 0 ? 'paid' : 'returned', r.from.join(' '), r.to, sats, (sats / 1e8).toFixed(8), r.roles.join(' '), r.height, utc(seen), at == null ? '' : num(sign * at), td == null ? '' : num(sign * td), opts.currency && (at != null || td != null) ? opts.currency : ''].map(cell).join(','));
    });
    lines.push(['TOTAL', '', 'net', '', '', res.net, (res.net / 1e8).toFixed(8), '', '', '', fxAny ? num(fx) : '', todayAny ? num(fxToday) : '', opts.currency && (fxAny || todayAny) ? opts.currency : ''].map(cell).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  return { find: find, toCsv: toCsv };
}));
