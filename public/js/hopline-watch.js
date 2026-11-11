/*
 * Hopline wallet watch: the arithmetic behind "Watch this wallet" on the wallet page. The page asks the server for the wallet's totals every few minutes while it is open; when the totals
 * differ from the last ones it reads the newest transactions, and this file says what is new on them compared with what the page shows, how to merge it in, and what to tell the person.
 * It compares states, not events, so a tab that slept for an hour misses nothing: the next check sees everything that happened. Pure functions over plain data, no DOM, no network, no clock.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-wallet.js'));
  else root.HoplineWatch = factory(root.HoplineWallet);
}(typeof self !== 'undefined' ? self : this, function (Wallet) {
  'use strict';

  var INTERVALS = [1, 2, 5, 10, 30];                      // minutes the person can choose between
  var DEFAULT_MINUTES = 2;
  var MAX_WATCH_MS = 24 * 3600 * 1000;                    // a forgotten tab stops asking the server after this long
  var MAX_BACKOFF_MS = 15 * 60 * 1000;
  var PAGE = 25;                                          // confirmed transactions in one page of an address's history

  /** The minutes to use for a choice: one of INTERVALS, else the default. */
  function cleanMinutes(v) { v = Number(v); return INTERVALS.indexOf(v) >= 0 ? v : DEFAULT_MINUTES; }
  function intervalMs(minutes) { return cleanMinutes(minutes) * 60000; }

  /** The totals of a wallet that say whether anything happened to it: transaction counts and money in and out, confirmed and not. Two equal strings: nothing changed. */
  function fingerprint(stats) {
    var c = (stats && stats.chain_stats) || {}, m = (stats && stats.mempool_stats) || {};
    return [c.tx_count, c.funded_txo_sum, c.spent_txo_sum, m.tx_count, m.funded_txo_sum, m.spent_txo_sum].map(function (v) { return v == null ? '' : String(v); }).join('|');
  }
  function changed(lastFingerprint, stats) { return lastFingerprint !== fingerprint(stats); }

  function isConfirmed(t) { return !!(t && t.status && t.status.confirmed); }

  /**
   * What the newest page of the wallet's history holds that the page does not show yet.
   *   added      transactions the page does not hold
   *   confirmed  transactions the page holds as unconfirmed that are in a block now: { tx: as the server has it now, was: as the page holds it }
   *   gap        a whole page of confirmed transactions, none of which the page holds: more than a page happened since, so the newer ones cannot be joined to the older ones that are loaded
   */
  function diff(have, fresh) {
    have = have || []; fresh = fresh || [];
    var byId = new Map(), added = [], confirmed = [], chain = 0, chainKnown = 0;
    have.forEach(function (t) { byId.set(t.txid, t); });
    fresh.forEach(function (t) {
      var c = isConfirmed(t), h = byId.get(t.txid);
      if (c) chain++;
      if (!h) { added.push(t); return; }
      if (c) chainKnown++;
      if (c && !isConfirmed(h)) confirmed.push({ tx: t, was: h });
    });
    var haveChain = have.filter(isConfirmed).length;
    return { added: added, confirmed: confirmed, gap: haveChain > 0 && chain >= PAGE && chainKnown === 0 };
  }

  /**
   * The transactions the page holds with the new page of the history joined in: unconfirmed first, then confirmed from the newest block back; a transaction that was confirmed meanwhile has its
   * new status. Returns { txs, added, confirmed, gap } (the diff, and the merged list; with a gap the list is not to be used: read the wallet again).
   */
  function merge(have, fresh) {
    var d = diff(have, fresh), now = new Map();
    d.confirmed.forEach(function (c) { now.set(c.tx.txid, c.tx); });
    var list = d.added.concat((have || []).map(function (t) { return now.has(t.txid) ? Object.assign({}, t, { status: now.get(t.txid).status }) : t; }));
    var keyed = list.map(function (t, i) { return { t: t, i: i, k: isConfirmed(t) ? (t.status.block_height == null ? Number.MAX_SAFE_INTEGER - 1 : t.status.block_height) : Number.MAX_SAFE_INTEGER }; });
    keyed.sort(function (a, b) { return b.k - a.k || a.i - b.i; });
    return { txs: keyed.map(function (x) { return x.t; }), added: d.added, confirmed: d.confirmed, gap: d.gap };
  }

  /** Milliseconds until the next check: the interval, longer after failures (doubling, at most 15 minutes), and a little random, so that many open tabs do not all ask at the same second. */
  function nextDelay(baseMs, fails, rand) {
    var r = typeof rand === 'function' ? rand() : 0.5, f = Math.max(0, Math.min(3, fails | 0));
    var ms = baseMs * Math.pow(2, f);
    return Math.round(Math.min(MAX_BACKOFF_MS > baseMs ? MAX_BACKOFF_MS : baseMs, ms) * (0.9 + 0.2 * r));
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function sats(v) { return (v / 1e8).toFixed(8); }                    // eight decimals, as every amount on the pages

  /**
   * The words of an alert: { title, body }. address is the wallet; options: { label (the name of the wallet), amounts (false leaves every amount out), known (the page's name lookup, for the
   * wallets on the other side), fmtBtc (satoshis to text), shortId }. The body counts the new transactions and what they did to the wallet, says which are unconfirmed, names the labelled wallets on
   * the other side, and counts the ones that got confirmed.
   */
  function describe(address, added, confirmed, options) {
    options = options || {};
    var amounts = options.amounts !== false, fmt = options.fmtBtc || sats, short = options.shortId ? options.shortId(address, 8) : address.slice(0, 8) + '…' + address.slice(-5);
    var title = 'Hopline · ' + (options.label || short), parts = [];
    function signed(n) { return (n < 0 ? '-' : '+') + fmt(Math.abs(n)) + ' BTC'; }
    if (added && added.length) {
      var rows = Wallet.ledger(address, added, { known: options.known || null }).rows, net = 0, pending = 0, names = [];
      rows.forEach(function (r) {
        net += r.net; if (!r.confirmed) pending++;
        r.inputs.concat(r.outputs).forEach(function (x) { if (!x.self && x.label && names.indexOf(x.label) < 0) names.push(x.label); });
      });
      var text;
      if (rows.length === 1) {
        var r0 = rows[0], verb = r0.dir === 'in' ? 'received' : r0.dir === 'out' ? 'sent' : r0.dir === 'self' ? 'moved inside the wallet' : 'no change to the balance';
        text = '1 new transaction' + (amounts ? ': ' + (r0.dir === 'in' || r0.dir === 'out' ? signed(r0.net) + ' ' + verb : verb) : '') + (r0.confirmed ? '' : ' (unconfirmed)');
      } else {
        text = rows.length + ' new transactions' + (amounts ? ': ' + signed(net) + ' in all' : '') + (pending ? ' (' + pending + ' unconfirmed)' : '');
      }
      if (names.length) text += ' · with ' + names.slice(0, 2).join(', ') + (names.length > 2 ? ' and ' + (names.length - 2) + ' more' : '');
      parts.push(text);
    }
    if (confirmed && confirmed.length) parts.push(plural(confirmed.length, 'transaction') + ' confirmed');
    return { title: title, body: parts.join('. ') };
  }

  /** The line on the page about what is waiting to be shown ('' when nothing is). */
  function bannerText(added, confirmed, gap, totalsOnly) {
    var parts = [];
    if (added && added.length) parts.push(plural(added.length, 'new transaction'));
    if (confirmed && confirmed.length) parts.push(plural(confirmed.length, 'transaction') + ' confirmed');
    if (!parts.length && totalsOnly) parts.push('The totals changed (a transaction may have been replaced or dropped)');
    if (gap) parts.push('more than ' + PAGE + ' happened since this page was read, so Show reads the wallet again');
    return parts.join(' · ');
  }

  return { INTERVALS: INTERVALS, DEFAULT_MINUTES: DEFAULT_MINUTES, MAX_WATCH_MS: MAX_WATCH_MS, MAX_BACKOFF_MS: MAX_BACKOFF_MS, PAGE: PAGE,
           cleanMinutes: cleanMinutes, intervalMs: intervalMs, fingerprint: fingerprint, changed: changed, diff: diff, merge: merge, nextDelay: nextDelay, describe: describe, bannerText: bannerText };
}));
