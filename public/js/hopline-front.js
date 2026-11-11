/*
 * Hopline start page: what was typed or pasted into the box, and which pages can open it.
 *
 *   one address            -> the wallet overview (what the start page has always opened), or the workspace to start a trace from it
 *   one transaction ID     -> the workspace (a transaction has no overview of its own)
 *   2 to 10 of either      -> the workspace (the overview is for one address)
 *   a Hopline link         -> the workspace, with the link's own part after the "#" (a canvas link, #s1/..., or a link to transactions, #i1/...)
 *   anything else          -> nothing is offered, and the sentence says why
 *
 * Every address is checked here (the same local checksum test the two pages use), so a typo is reported before a page is opened.
 * Explorer links (mempool.space/address/..., blockstream.info/tx/...) and bitcoin: URIs are understood, as they were before.
 * Pure functions, no DOM: the page only draws what classify() returns.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-address.js'));
  else root.HoplineFront = factory(root.HoplineAddress);
}(typeof self !== 'undefined' ? self : this, function (Addr) {
  'use strict';

  var MAX_ITEMS = 10;                                   // what the workspace takes at once
  var SHORTEST = 26;                                    // no address is shorter: anything below this is taken to be unfinished while someone types
  var WALLET = 'public/wallet.html', WORKSPACE = 'public/workspace.html';
  var WALLET_NOTE = 'the ledger: balance, history, counterparties';
  var LINK = /^\S*(#(?:s1|i1)\/[A-Za-z0-9_-]+)$/;       // the part after the "#" of a share link: a prefix and base64url

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /** One piece of the text as {kind:'tx'|'addr', value}, or {bad:true, text, message}. */
  function token(raw) {
    var v = String(raw).trim().replace(/^bitcoin:/i, '').split(/[?#]/)[0].trim();
    var m = /\/(?:address|tx)\/([A-Za-z0-9]+)\/?$/.exec(v);                       // https://mempool.space/address/..., https://blockstream.info/tx/...
    if (m) v = m[1];
    if (/^[0-9a-fA-F]{64}$/.test(v)) return { kind: 'tx', value: v.toLowerCase() };
    var a = Addr.normalise(v), r = /^[A-Za-z0-9]{14,90}$/.test(a) ? Addr.validate(a) : { ok: false, reason: 'format' };
    return r.ok ? { kind: 'addr', value: a } : { bad: true, text: v, message: Addr.explain(r) };
  }

  function offer(page, title, note, url, why) { return { page: page, title: title, note: note, url: url || null, why: why || '' }; }

  /**
   * What the box holds. Returns
   *   kind     'empty' | 'typing' | 'invalid' | 'toomany' | 'link' | 'address' | 'transaction' | 'several'
   *   chip     the short name of what was recognised ('Bitcoin address', '3 addresses and 1 transaction', ...), '' when there is nothing to say
   *   message  one sentence under it ('' when there is none)
   *   items    the addresses and transaction IDs, each once, in order: {kind, value}
   *   offers   the pages to open it in, the first one is the one Enter opens: {page, title, note, url, why}; url is null (and why says why) for a page that cannot take it
   */
  function classify(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { kind: 'empty', chip: '', message: '', items: [], offers: [] };

    var link = LINK.exec(s);
    if (link) return { kind: 'link', chip: 'Hopline link', message: 'Enter opens it in the workspace.', items: [], offers: [offer('workspace', 'Workspace', 'opens the canvas or transactions in the link', WORKSPACE + link[1])] };

    var parts = s.split(/[\s,;]+/).filter(Boolean), items = [], bad = [], seen = {};
    parts.forEach(function (p) {
      var t = token(p);
      if (t.bad) { bad.push(t); return; }
      var key = t.kind + ':' + t.value;
      if (!seen[key]) { seen[key] = true; items.push(t); }
    });

    if (bad.length) {
      if (parts.length === 1 && /^[A-Za-z0-9]+$/.test(bad[0].text) && bad[0].text.length < SHORTEST)
        return { kind: 'typing', chip: 'Keep going', message: 'A Bitcoin address has 26 to 62 characters; a transaction ID has 64.', items: [], offers: [] };
      return {
        kind: 'invalid', items: [], offers: [],
        chip: parts.length === 1 ? 'Not recognised' : bad.length + ' of ' + parts.length + ' not recognised',
        message: parts.length === 1 ? bad[0].message : 'Check each one: a Bitcoin address has 26 to 62 characters, a transaction ID has 64 (0-9, a-f). Nothing is opened until all of them fit.'
      };
    }
    if (items.length > MAX_ITEMS)
      return { kind: 'toomany', chip: items.length + ' entries', message: 'The workspace takes up to ' + MAX_ITEMS + ' at once. Paste fewer.', items: items, offers: [] };

    var addrs = items.filter(function (i) { return i.kind === 'addr'; }), txs = items.length - addrs.length;
    var workspace = WORKSPACE + '?q=' + encodeURIComponent(items.map(function (i) { return i.value; }).join(' '));

    if (items.length === 1 && addrs.length === 1)
      return { kind: 'address', chip: 'Bitcoin address', message: 'Enter opens the wallet overview.', items: items, offers: [
        offer('wallet', 'Wallet overview', WALLET_NOTE, WALLET + '?q=' + encodeURIComponent(items[0].value)),
        offer('workspace', 'Workspace', 'start a trace from this wallet', workspace)] };
    if (items.length === 1)
      return { kind: 'transaction', chip: 'Transaction ID', message: 'Enter opens the workspace.', items: items, offers: [
        offer('workspace', 'Workspace', 'a transaction is traced here', workspace),
        offer('wallet', 'Wallet overview', WALLET_NOTE, null, 'A transaction has no overview of its own. The workspace shows it.')] };
    var names = [];
    if (addrs.length) names.push(plural(addrs.length, 'address', 'addresses'));
    if (txs) names.push(plural(txs, 'transaction', 'transactions'));
    return { kind: 'several', chip: names.join(' and '), message: 'Enter opens the workspace.', items: items, offers: [
      offer('workspace', 'Workspace', 'trace from all of them', workspace),
      offer('wallet', 'Wallet overview', WALLET_NOTE, null, 'The overview is for one address. The workspace takes several.')] };
  }

  return { classify: classify, token: token, MAX_ITEMS: MAX_ITEMS, WALLET: WALLET, WORKSPACE: WORKSPACE };
}));
