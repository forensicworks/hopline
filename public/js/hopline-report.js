/*
 * Hopline report: turns what is on screen into one self-contained HTML file an investigator can hand over: findings, the
 * transactions in time order with their inputs and outputs, the wallets, the graph as a picture, how every finding was reached,
 * where and when each transaction was fetched, and a SHA-256 of the evidence data embedded in the file so a reader can
 * check that it was not changed afterwards (tools/verify_report.py does that).
 *
 * Pure: it builds text from the model it is given. Everything that came from outside (labels, notes, names from a label
 * pack, an imported file) goes through esc() before it reaches the HTML; the file contains no script except the inert JSON
 * data block, whose text is escaped so it cannot end early.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-style.js'), require('./hopline-address.js'));
  else root.HoplineReport = factory(root.HoplineStyle, root.HoplineAddress);
}(typeof self !== 'undefined' ? self : this, function (Style, Addr) {
  'use strict';

  var MAX_TX = 500, MAX_WALLETS = 1000, MAX_ROWS = 60;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function host(url) { return String(url || '').replace(/^https?:\/\//i, '').replace(/\/api\/?$/, ''); }
  function t(unix) { return unix == null ? 'unknown' : Style.fmtTimeFull(unix); }
  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /**
   * The findings of an analysis (HoplineAnalysis.analyse), cut to the vertices that are in the report: has(vertexId) says which. A chain or a cluster keeps only
   * those vertices, so nothing left out can come in through it. Returns the shape build() takes as model.analysis, without `skipped`: { tx, chains, clusters }.
   */
  function analysisFor(an, has) {
    var tx = {};
    an.tx.forEach(function (r, id) {
      if (!has(id) || !(r.flags.length || r.change || r.chain)) return;
      tx[id] = { flags: r.flags.map(function (f) { return { kind: f.kind, short: f.short, title: f.title }; }),
                 change: r.change && has(r.change.id) ? { vout: r.change.vout, edgeId: r.change.edgeId, address: r.change.address, confidence: r.change.confidence, reasons: r.change.reasons } : null, chain: r.chain };
    });
    var chains = an.chains.filter(function (c) { return c.ids.some(has); }).map(function (c) {
      return { label: c.label, ids: c.ids.filter(has), start: c.start, end: c.end, totalPeeled: c.totalPeeled, continues: c.continues };
    });
    var clusters = an.clusters.list.filter(function (c) { return c.addrs.some(has); }).map(function (c) {
      return { label: c.label, size: c.size, addrs: c.addrs.filter(has), txs: c.txs.filter(function (txid) { return has('tx:' + txid); }) };
    });
    return { tx: tx, chains: chains, clusters: clusters };
  }

  /** The text embedded in the report: compact JSON in which < is escaped, so it can never end the script element. */
  function evidenceText(evidence) {
    return JSON.stringify(evidence).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  function hex(bytes) { return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  /** SHA-256 of a text (UTF-8), as lower-case hex. */
  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    function pure() { return hex(Addr.sha256(Array.from(bytes))); }
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try { return crypto.subtle.digest('SHA-256', bytes).then(function (d) { return hex(new Uint8Array(d)); }, function () { return pure(); }); } catch (e) { /* fall through */ }
    }
    return Promise.resolve(pure());
  }

  var CSS = 'body{font:14px/1.45 Calibri,Arial,sans-serif;color:#1b1b1f;max-width:1100px;margin:24px auto;padding:0 16px}h1{margin:0 0 4px;font-size:26px}h2{margin:28px 0 8px;font-size:19px;border-bottom:2px solid #1b1b1f;padding-bottom:3px}h3{margin:0;font-size:14px}'
    + '.meta,.hint{color:#555;font-size:12.5px}.notice{border:1px solid #c9a227;background:#fff8dc;padding:8px 12px;border-radius:6px;margin:12px 0;font-size:13px}'
    + 'table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}th{background:#eee}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}'
    + 'code{font:12px Consolas,monospace;overflow-wrap:anywhere}.tx{border:1px solid #888;border-radius:6px;margin:12px 0;padding:8px 10px;page-break-inside:avoid}.tx header{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;margin-bottom:4px}'
    + '.chip{display:inline-block;border:1px solid #555;border-radius:10px;padding:0 7px;font-size:11.5px;font-weight:700;margin-right:4px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:700px){.cols{grid-template-columns:1fr}}'
    + '.chg{background:#fff1d6}.fp{font-size:12px;color:#444}.hash{font:13px Consolas,monospace;overflow-wrap:anywhere;background:#f1f1f1;padding:6px 8px;border-radius:4px}img.graph{max-width:100%;border:1px solid #888;background:#1c141d}'
    + 'ul.reasons{margin:2px 0 4px;padding-left:18px;font-size:12px;color:#444}@media print{body{margin:0}.tx{break-inside:avoid}}';

  function walletName(model, n) {
    var parts = [];
    if (n.label) parts.push(n.label);
    var k = model.known && n.address ? model.known(n.address) : null;
    if (k && k.label && k.label !== n.label) parts.push('known: ' + k.label + (k.pack ? ' (' + k.pack + ')' : ''));
    if (k) (k.alt || []).forEach(function (a) { parts.push('also listed as: ' + a); });
    if (k && k.sanctions) parts.push('ON A SANCTIONS LIST (as the pack says)');
    if (n.tag) parts.push('tag ' + n.tag);
    return parts.join(' · ');
  }

  /** One line for each label pack that names a wallet in the report: the pack, where its data came from, its licence, who to credit and the date of its data. `model.packs` carries what each pack says about itself. */
  function packSources(model, wallets) {
    var used = new Set();
    wallets.forEach(function (n) {
      var k = model.known && n.address ? model.known(n.address) : null;
      if (k) (k.claims && k.claims.length ? k.claims : [{ pack: k.pack || '' }]).forEach(function (c) { if (c.pack) used.add(c.pack); });
    });
    return (model.packs || []).filter(function (p) { return used.has(p.name); }).map(function (p) {
      var bits = [p.source, p.licence && 'licence: ' + p.licence, p.attribution && 'credit: ' + p.attribution, p.asOf && 'data as of ' + p.asOf].filter(Boolean);
      return p.name + (bits.length ? ' - ' + bits.join('; ') : '');
    });
  }

  /**
   * The outside look-ups in the report: what third-party services said about wallets on screen, asked for one wallet at a time on request (HoplineExternal.entries).
   * `model.lookups` is [{ address, source, sourceName, found, label, category, tags, note, at }]. Returns { sources: [text per source], rows }, or null when there are none.
   */
  function lookupInfo(model) {
    var list = (model.lookups || []).filter(function (l) { return l && l.address && l.source; });
    if (!list.length) return null;
    var by = {}, order = [];
    list.forEach(function (l) {
      var b = by[l.source]; if (!b) { b = by[l.source] = { name: l.sourceName || l.source, asked: 0, named: 0, first: null, last: null }; order.push(l.source); }
      b.asked++; if (l.found) b.named++;
      if (l.at) { b.first = b.first == null ? l.at : Math.min(b.first, l.at); b.last = b.last == null ? l.at : Math.max(b.last, l.at); }
    });
    return { sources: order.map(function (id) {
      var b = by[id], when = b.first == null ? '' : b.first === b.last ? ', asked ' + Style.fmtTimeFull(b.first) : ', asked between ' + Style.fmtTimeFull(b.first) + ' and ' + Style.fmtTimeFull(b.last);
      return b.name + ' - ' + plural(b.asked, 'wallet') + ' asked, ' + b.named + ' named' + when;
    }), rows: list };
  }

  /**
   * When a service first saw some of the transactions, from the look-ups asked on request (HoplineExternal.timeRows). `model.timeEvidence` is [{ txid, time, source, sourceName, found, seen,
   * received, confirmed, relay, height, at }]; the peers are shown only when `model.timeRelay` is true. Returns { sources: [text per source], rows }, or null when there are none.
   */
  function timeInfo(model) {
    var list = (model.timeEvidence || []).filter(function (r) { return r && r.txid && r.source; });
    if (!list.length) return null;
    var by = {}, order = [];
    list.forEach(function (r) {
      var b = by[r.source]; if (!b) { b = by[r.source] = { name: r.sourceName || r.source, asked: 0, seen: 0, first: null, last: null }; order.push(r.source); }
      b.asked++; if (r.seen) b.seen++;
      if (r.at) { b.first = b.first == null ? r.at : Math.min(b.first, r.at); b.last = b.last == null ? r.at : Math.max(b.last, r.at); }
    });
    return { sources: order.map(function (id) {
      var b = by[id], when = b.first == null ? '' : b.first === b.last ? ', asked ' + Style.fmtTimeFull(b.first) : ', asked between ' + Style.fmtTimeFull(b.first) + ' and ' + Style.fmtTimeFull(b.last);
      return b.name + ' - ' + plural(b.asked, 'transaction') + ' asked, ' + b.seen + ' with a first-seen time, ' + (b.asked - b.seen) + ' with no record from before the block' + when;
    }), rows: list.slice().sort(function (a, b) { return (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time); }) };
  }
  function gapWords(sec) {
    sec = Math.round(Math.abs(sec));
    return sec < 60 ? sec + ' s' : sec < 3600 ? Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s' : Math.floor(sec / 3600) + ' h ' + Math.floor(sec % 3600 / 60) + ' min';
  }

  function amountCell(model, sats, time) {
    var fx = model.fiat ? model.fiat(sats, time) : '';
    return esc(Style.fmtBtc(sats)) + ' BTC' + (fx ? ' <span class="hint">· ' + esc(fx) + '</span>' : '');
  }

  /** What a wallet held when the server was asked (its confirmed balance, with the time), or "not read". */
  function balanceCell(model, n) {
    if (n.fundedSum == null || n.spentSum == null) return '<span class="hint">not read</span>';
    var pending = (n.mempoolFundedSum || 0) - (n.mempoolSpentSum || 0);
    return amountCell(model, n.fundedSum - n.spentSum, n.statsAt) + '<div class="hint">as of ' + esc(n.statsAt != null ? t(n.statsAt) : 'an unknown time') + (pending ? '; ' + (pending > 0 ? '+' : '') + esc(Style.fmtBtc(pending)) + ' BTC unconfirmed' : '') + '</div>';
  }

  /** One sentence on the balances in the table: how many wallets had theirs read and what they held then. A wallet not read is not counted as empty. */
  function balanceSummary(model, wallets) {
    var min = model.dustSats > 0 ? model.dustSats : 0, holds = 0, small = 0, empty = 0, unread = 0, oldest = null;
    wallets.forEach(function (n) {
      if (n.fundedSum == null || n.spentSum == null) { unread++; return; }
      var c = n.fundedSum - n.spentSum;
      if (c <= 0) empty++; else if (min && c < min) small++; else holds++;
      if (n.statsAt != null && (oldest == null || n.statsAt < oldest)) oldest = n.statsAt;
    });
    var read = holds + small + empty;
    if (!read) return '';
    return '<p class="hint">Balances were read for ' + read + ' of ' + plural(wallets.length, 'wallet') + (oldest != null ? ' (the oldest read ' + esc(t(oldest)) + ')' : '') + ': ' + holds + ' held funds' + (min ? ' (' + esc(Style.fmtBtc(min)) + ' BTC or more), ' + small + ' a smaller amount' : '')
      + ', ' + empty + ' held nothing.' + (unread ? ' The ' + unread + ' not read are not counted as empty.' : '') + ' A balance is what the server said when it was read, for that address only.</p>';
  }

  function vertexText(model, nodes, id) {
    var n = nodes.get(id);
    if (!n) return esc(id);
    if (n.type === 'addr') { var nm = walletName(model, n); return '<code>' + esc(n.address) + '</code>' + (nm ? ' <b>' + esc(nm) + '</b>' : ''); }
    if (n.type === 'coinbase') return 'coinbase (newly created coins)';
    if (n.type === 'data') return 'OP_RETURN ' + esc(n.dataText || (n.dataHex ? n.dataHex.slice(0, 40) : 'empty'));
    if (n.type === 'nonstd') return 'non-standard output';
    return '<code>' + esc(id) + '</code>';
  }

  /** "3", or "1 of 3 shown" when part of a transaction's inputs or outputs was not on screen (the embedded data has what was). */
  function countText(shown, total) { return total != null && shown < total ? shown + ' of ' + total + ' shown' : String(shown); }

  function txBlock(model, nodes, edgesByTx, n) {
    var a = model.analysis && model.analysis.tx && model.analysis.tx[n.id] || { flags: [], change: null, chain: null };
    var es = edgesByTx.get(n.txid) || { ins: [], outs: [] };
    var h = '<section class="tx" id="tx-' + esc(n.txid) + '"><header><h3>' + esc(t(n.time)) + '</h3><code>' + esc(n.txid) + '</code>'
      + '<span>' + (n.confirmed ? 'block ' + esc(n.height) : n.confirmed === false ? 'unconfirmed' : '') + '</span>'
      + '<span>' + (n.fee != null ? 'fee ' + esc(n.fee) + ' sat' : '') + '</span></header>';
    if (a.flags.length) h += '<p>' + a.flags.map(function (f) { return '<span class="chip" title="' + esc(f.title) + '">' + esc(f.short) + '</span>'; }).join('') + '</p>' + '<ul class="reasons">' + a.flags.map(function (f) { return '<li>' + esc(f.title) + '</li>'; }).join('') + '</ul>';
    h += '<div class="cols"><table><tr><th colspan="2">Inputs (' + countText(es.ins.length, n.nIn) + ')</th></tr>';
    es.ins.slice(0, MAX_ROWS).forEach(function (e) { h += '<tr><td>' + vertexText(model, nodes, e.source) + '</td><td class="num">' + amountCell(model, e.amount, n.time) + '</td></tr>'; });
    if (es.ins.length > MAX_ROWS) h += '<tr><td colspan="2" class="hint">… and ' + (es.ins.length - MAX_ROWS) + ' more (all of them are in the embedded data)</td></tr>';
    h += '</table><table><tr><th colspan="2">Outputs (' + countText(es.outs.length, n.nOut) + ')</th></tr>';
    es.outs.slice(0, MAX_ROWS).forEach(function (e) {
      var isChange = a.change && a.change.edgeId === e.id;
      var spent = e.spent === true ? 'spent by <code>' + esc(e.spentBy ? e.spentBy.txid.slice(0, 12) + '…' : '?') + '</code>' : e.spent === false ? 'unspent' : 'spending unknown';
      h += '<tr class="' + (isChange ? 'chg' : '') + '"><td>' + vertexText(model, nodes, e.target) + '<div class="hint">' + spent + (isChange ? ' · <b>' + (a.change.confidence === 'high' ? 'likely' : 'possible') + ' change</b> (' + esc(a.change.confidence) + ' confidence)' : '') + '</div></td><td class="num">' + amountCell(model, e.amount, n.time) + '</td></tr>';
    });
    if (es.outs.length > MAX_ROWS) h += '<tr><td colspan="2" class="hint">… and ' + (es.outs.length - MAX_ROWS) + ' more</td></tr>';
    h += '</table></div>';
    if (a.change) h += '<p><b>' + (a.change.confidence === 'high' ? 'Likely' : 'Possible') + ' change:</b> output ' + esc(a.change.vout) + ' (a guess, ' + esc(a.change.confidence) + ' confidence). Reasons:</p><ul class="reasons">' + a.change.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>'
      + (a.change.confidence === 'high' ? '' : '<p class="hint">' + (a.change.reasons.length === 1 ? 'Only one sign points to this output. ' : '') + 'Treat it as a lead to check, not as the change: both outputs should be followed before relying on it.</p>');
    if (a.chain && !a.flags.some(function (f) { return f.kind === 'peel'; })) h += '<p class="hint">Step ' + esc(a.chain.step) + ' of ' + esc(a.chain.of) + ' in the possible peel chain ' + esc(a.chain.label) + '.</p>';
    if (n.fingerprintText) h += '<p class="fp">Wallet habits: ' + esc(n.fingerprintText) + '</p>';
    h += '<p class="hint">Retrieved ' + (n.fetchedAt != null ? esc(t(n.fetchedAt)) + (n.source ? ' from ' + esc(host(n.source)) : '') : 'at an unknown time (loaded before provenance was recorded, or imported)')
      + (n.spendsCheckedAt != null ? '; spent/unspent status as of ' + esc(t(n.spendsCheckedAt)) : '') + '.</p></section>';
    return h;
  }

  /**
   * model = {
   *   title, preparedBy, generated (ms),
   *   evidence: the object to embed (a workspace export of what is on screen plus an `evidence` block),
   *   nodes: [vertex objects], edges: [edge objects]  (what is on screen),
   *   analysis: { tx: {id: {flags:[{short,title}], change:{vout,edgeId,confidence,reasons}, chain:{label,step,of}}}, chains:[...], clusters:[...], skipped:{...} },
   *   known(address) -> {label, pack} | null,  fiat(sats, time) -> text | '',  fiatNote, image (a PNG data URL) | null,
   *   fingerprint(node) -> text | ''
   *   madeWith (the page that made it, 'Hopline workspace' when left out), scopeText (what the report covers, "what was on screen" when left out)
   * }
   * Resolves to { html, hash, docHash, text }:
   *   text      the embedded evidence, hash = its SHA-256 (robust: it covers one line of JSON, so line endings do not matter)
   *   docHash   the SHA-256 of the whole file with the document hash itself written as 64 zeros (strict: it covers every
   *             word of the report, so any edit to the readable part shows, and so does re-saving it with other line endings)
   */
  var ZERO = new Array(65).join('0'), DOC_P = '<p class="hash" id="document-hash">' + ZERO + '</p>';
  function build(model) {
    var text = evidenceText(model.evidence);
    return sha256Hex(text).then(function (hash) {
      var html = render(model, text, hash);
      return sha256Hex(html).then(function (docHash) { return { html: html.replace(DOC_P, function () { return DOC_P.replace(ZERO, docHash); }), hash: hash, docHash: docHash, text: text }; });
    });
  }

  function render(model, text, hash) {
    var nodes = new Map(), edgesByTx = new Map();
    model.nodes.forEach(function (n) { nodes.set(n.id, n); });
    model.edges.forEach(function (e) {
      var tx = nodes.get(e.kind === 'out' ? e.source : e.target); if (!tx || tx.type !== 'tx') return;
      var rec = edgesByTx.get(tx.txid) || { ins: [], outs: [] }; edgesByTx.set(tx.txid, rec);
      (e.kind === 'out' ? rec.outs : rec.ins).push(e);
    });
    edgesByTx.forEach(function (r) { r.ins.sort(function (a, b) { return (a.vin || 0) - (b.vin || 0); }); r.outs.sort(function (a, b) { return (a.vout || 0) - (b.vout || 0); }); });
    var txs = model.nodes.filter(function (n) { return n.type === 'tx' && n.loaded; }).sort(function (a, b) { return (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time) || (a.txid < b.txid ? -1 : 1); });
    var stubs = model.nodes.filter(function (n) { return n.type === 'tx' && !n.loaded; }).length;
    var wallets = model.nodes.filter(function (n) { return n.type === 'addr'; });
    var an = model.analysis || { tx: {}, chains: [], clusters: [], skipped: { coinjoin: 0, excluded: 0 } };
    var times = txs.map(function (n) { return n.time; }).filter(function (x) { return x != null; });
    var fetched = txs.map(function (n) { return n.fetchedAt; }).filter(function (x) { return x != null; });
    var sources = {}; txs.forEach(function (n) { if (n.source) sources[host(n.source)] = (sources[host(n.source)] || 0) + 1; });
    var title = model.title || 'Hopline investigation report', h = [];
    model.nodes.forEach(function (n) { if (n.type === 'tx' && n.loaded && model.fingerprint) n.fingerprintText = model.fingerprint(n) || ''; });

    h.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body>');
    h.push('<h1>' + esc(title) + '</h1><p class="meta">' + (model.preparedBy ? 'Prepared by ' + esc(model.preparedBy) + ' · ' : '') + 'generated ' + esc(t(Math.floor((model.generated || Date.now()) / 1000))) + ' · made with ' + esc(model.madeWith || 'Hopline workspace') + ' · all times UTC · a transaction\'s time is the time of its block</p>');
    h.push('<div class="notice"><b>Read this first.</b> The facts here (transactions, amounts, times, which output was spent by which transaction) come from the blockchain data source named below and were fetched at the times shown. The <i>findings</i> (patterns, likely change, address clusters) are heuristics: they are guesses with their reasons stated, not proof of who controls what.</div>');
    if (model.leftOut && model.leftOut.left > 0) {                              // the workspace holds more than was on screen: say how much this report leaves out
      var lo = model.leftOut;
      h.push('<div class="notice"><b>Not everything that was loaded is in this report.</b> ' + esc(fmtInt(lo.left)) + ' of the ' + esc(fmtInt(lo.total)) + ' vertices in the workspace (' + esc(fmtInt(lo.transactions)) + (lo.transactions === 1 ? ' transaction' : ' transactions') + ', ' + esc(fmtInt(lo.wallets)) + (lo.wallets === 1 ? ' wallet' : ' wallets') + (lo.other ? ', ' + esc(fmtInt(lo.other)) + ' of other kinds' : '')
        + ') were not on screen when it was made, so nothing about them is here, including any finding that rests on them. To keep all of it, export the workspace as JSON without <i>Visible part only</i>, or show them and make the report again.</div>');
    }

    h.push('<h2>Summary</h2><table><tr><th>What is covered</th><td>' + plural(txs.length, 'transaction') + ' loaded' + (stubs ? ' (and ' + stubs + ' more referenced but not loaded)' : '') + ', ' + plural(wallets.length, 'wallet') + ', ' + plural(model.edges.length, 'movement') + '. ' + esc(model.scopeText || 'This is what was on screen when the report was made.') + '</td></tr>'
      + '<tr><th>Time span</th><td>' + (times.length ? esc(t(Math.min.apply(null, times))) + ' to ' + esc(t(Math.max.apply(null, times))) : 'no confirmed transaction') + '</td></tr>'
      + '<tr><th>Data source</th><td>' + (Object.keys(sources).length ? Object.keys(sources).map(function (k) { return esc(k) + ' (' + plural(sources[k], 'transaction') + ')'; }).join(', ') : 'not recorded') + (fetched.length ? '; fetched between ' + esc(t(Math.min.apply(null, fetched))) + ' and ' + esc(t(Math.max.apply(null, fetched))) : '') + '</td></tr>'
      + (model.fiatNote ? '<tr><th>Fiat values</th><td>' + esc(model.fiatNote) + '</td></tr>' : '') + '</table>');

    h.push('<h2>Key findings</h2>');
    var flagged = txs.filter(function (n) { return (an.tx[n.id] || { flags: [] }).flags.length; });
    if (!flagged.length && !an.chains.length && !an.clusters.length && !wallets.some(function (n) { return n.label || n.tag || (model.known && n.address && model.known(n.address)); })) h.push('<p>Nothing notable was flagged in this selection.</p>');
    if (flagged.length) {
      h.push('<h3>Transaction patterns (' + flagged.length + ')</h3><table><tr><th>Time</th><th>Transaction</th><th>Pattern and why</th></tr>');
      flagged.slice(0, 200).forEach(function (n) { h.push('<tr><td>' + esc(t(n.time)) + '</td><td><a href="#tx-' + esc(n.txid) + '"><code>' + esc(n.txid.slice(0, 16)) + '…</code></a></td><td>' + an.tx[n.id].flags.map(function (f) { return '<span class="chip">' + esc(f.short) + '</span> ' + esc(f.title); }).join('<br>') + '</td></tr>'); });
      h.push('</table>');
    }
    if (an.chains.length) {
      h.push('<h3>Possible peel chains (' + an.chains.length + ')</h3><p class="hint">A run of transactions that each pay a smaller amount out of a single coin and pass the rest on. Ordinary wallets paying from one coin look the same.</p><table><tr><th>Chain</th><th>Transactions</th><th>Started with</th><th>Peeled off</th><th>Ended with</th><th>Last coin</th></tr>');
      an.chains.forEach(function (c) { h.push('<tr><td>' + esc(c.label) + '</td><td class="num">' + esc(c.ids.length) + '</td><td class="num">' + amountCell(model, c.start, null) + '</td><td class="num">' + amountCell(model, c.totalPeeled, null) + '</td><td class="num">' + amountCell(model, c.end, null) + '</td><td>' + esc(c.continues) + '</td></tr>'); });
      h.push('</table>');
    }
    if (an.clusters.length) {
      h.push('<h3>Address clusters (' + an.clusters.length + ')</h3><p class="hint">Addresses that were spent together as inputs of one transaction, which usually means one owner. CoinJoin-like transactions and any you excluded are not used'
        + (an.skipped && (an.skipped.coinjoin || an.skipped.excluded) ? ' (' + (an.skipped.coinjoin || 0) + ' CoinJoin-like, ' + (an.skipped.excluded || 0) + ' excluded by hand)' : '') + '.</p><table><tr><th>Cluster</th><th>Addresses</th><th>Linked by</th></tr>');
      an.clusters.slice(0, 100).forEach(function (c) {
        h.push('<tr><td>' + esc(c.label) + (c.size > c.addrs.length ? '<div class="hint">' + c.addrs.length + ' of ' + c.size + ' shown</div>' : '') + '</td><td>' + c.addrs.slice(0, 12).map(function (id) { return '<code>' + esc(id.replace(/^addr:/, '')) + '</code>'; }).join('<br>') + (c.addrs.length > 12 ? '<br>… and ' + (c.addrs.length - 12) + ' more' : '') + '</td><td>' + plural(c.txs.length, 'transaction') + ' shown</td></tr>');
      });
      h.push('</table>');
    }
    var noted = wallets.filter(function (n) { return n.label || n.tag || n.note || (model.known && model.known(n.address)); });
    if (noted.length) {
      h.push('<h3>Labelled wallets (' + noted.length + ')</h3><table><tr><th>Address</th><th>Name</th><th>Note</th></tr>');
      noted.slice(0, MAX_WALLETS).forEach(function (n) { var k = model.known && model.known(n.address); h.push('<tr><td><code>' + esc(n.address) + '</code></td><td>' + esc(walletName(model, n)) + (k && k.category ? ' <span class="hint">[' + esc(k.category) + ']</span>' : '') + '</td><td>' + esc(n.note || (k && k.note) || '') + '</td></tr>'); });
      h.push('</table>');
      var src = packSources(model, noted);
      if (src.length) h.push('<h3>Sources of the names</h3><ul class="reasons">' + src.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>');
    }

    if (model.trace) {                                                         // how far the trace got: the lit route, the hand-offs to services, where the trail is still open
      var tr = model.trace, plainId = function (id) { return String(id).replace(/^(addr|tx):/, ''); };
      h.push('<h2>How far the trace got</h2><p class="hint">Money is followed coin by coin: each step is the transaction that spent the coin before it, never a match of addresses. Only what is on screen and was loaded is covered, so a missing row only means none was found there. Reference: <b>' + esc(tr.referenceName || plainId(tr.reference)) + '</b> <code>' + esc(plainId(tr.reference)) + '</code>.</p>');
      if (tr.route) {
        var rt = tr.route;
        h.push('<h3>Route: ' + esc(rt.fromName) + ' to ' + esc(rt.toName) + ' (' + plural(rt.steps.length, 'transaction') + ')</h3>'
          + (rt.viaHub && rt.viaHub.length ? '<div class="notice"><b>Only found across ' + esc(rt.viaHub.join(', ')) + '</b>, a service wallet that mixes everyone\'s coins: this is not evidence of a link.</div>' : '')
          + '<table><tr><th>#</th><th>Transaction</th><th>Time</th><th>Inputs → outputs</th><th>The coin</th><th>Note</th></tr>');
        rt.steps.forEach(function (st, i) {
          h.push('<tr><td>' + (i + 1) + '</td><td><a href="#tx-' + esc(st.txid) + '"><code>' + esc(st.txid.slice(0, 16)) + '…</code></a></td><td>' + esc(t(st.time)) + '</td><td class="num">' + esc((st.nIn == null ? '?' : st.nIn) + ' → ' + (st.nOut == null ? '?' : st.nOut))
            + '</td><td class="num">' + (st.coinOut == null ? '' : amountCell(model, st.coinOut, st.time)) + '</td><td>' + [st.merges ? 'merges many inputs: coins of other origins join the route here' : '', st.loaded === false ? 'not loaded: known from the spends on either side of it' : ''].filter(Boolean).join('; ') + '</td></tr>');
        });
        h.push('</table>');
      }
      if (tr.handoffs && tr.handoffs.length) {
        var anyNamed = tr.handoffs.some(function (r) { return r.kind === 'named'; });
        h.push('<h3>' + (anyNamed ? 'Hand-offs' : 'Service hand-offs') + ' (' + tr.handoffs.length + ')</h3><p class="hint">Where the trail meets a wallet that a list names as a service: money going into it (a deposit) or coming out of it (a withdrawal), oldest first. The wallet just before a deposit, or just after a withdrawal, is a candidate for the deposit address or the customer\'s wallet; a request to the service names the transaction, the time and the amount. '
          + (anyNamed ? 'A row marked <i>named</i> is a wallet a sanctions or ransomware list names, not a service: the trail goes on through it. ' : '') + 'A name is the list\'s claim, not proof.</p>'
          + '<table><tr><th>Direction</th><th>' + (anyNamed ? 'Name' : 'Service') + '</th><th>' + (anyNamed ? 'Wallet' : 'Service wallet') + '</th><th>Transaction</th><th>Time</th><th>Amount</th><th>Wallet before / after</th><th>Steps</th></tr>');
        tr.handoffs.slice(0, MAX_ROWS * 2).forEach(function (r) {
          var nm = r.kind === 'named', dep = r.dir === 'deposit';
          h.push('<tr><td>' + (nm ? (dep ? 'into the wallet' : 'out of the wallet') : (dep ? 'deposit (into the service)' : 'withdrawal (out of the service)')) + '</td><td>' + (nm ? '<i>named</i> ' : '') + esc(r.service) + '</td><td><code>' + esc(r.address) + '</code></td><td><a href="#tx-' + esc(r.txid) + '"><code>' + esc(r.txid.slice(0, 16)) + '…</code></a></td><td>'
            + esc(t(r.time)) + '</td><td class="num">' + amountCell(model, r.amount, r.time) + '</td><td>' + (r.walletAddress ? '<code>' + esc(r.walletAddress) + '</code>' : '') + '</td><td class="num">' + esc(r.depth) + '</td></tr>');
        });
        h.push('</table>' + (tr.handoffs.length > MAX_ROWS * 2 ? '<p class="hint">The first ' + (MAX_ROWS * 2) + ' of ' + tr.handoffs.length + ' are listed.</p>' : ''));
      }
      [['next', 'Where the money went'], ['prev', 'Where the money came from']].forEach(function (d) {
        var o = tr.openEnds && tr.openEnds[d[0]];
        if (!o || !(o.count || (o.named && o.named.length))) return;
        h.push('<h3>' + d[1] + ': open ends (' + o.count + ')</h3>');
        if (o.count) h.push('<p class="hint">' + plural(o.count, 'branch', 'branches') + (o.sats ? ' (' + esc(Style.fmtBtc(o.sats)) + ' BTC in the outputs)' : '') + ' could be followed further: ' + (d[0] === 'next'
          ? (o.unchecked ? plural(o.unchecked, 'output') + ' never looked up to see whether it was spent' : '') + (o.unchecked && o.notLoaded ? ', ' : '') + (o.notLoaded ? plural(o.notLoaded, 'spender') + ' not loaded' : '')
          : plural(o.count, 'input') + ' whose funding transaction is not loaded') + '.</p>');
        if (o.named && o.named.length) h.push('<p class="hint">Branches that ended at a named wallet: ' + o.named.map(function (n) { return esc(n.label) + ' (' + esc(Style.fmtBtc(n.sats)) + ' BTC)'; }).join(', ') + '.</p>');
        if (o.rows && o.rows.length) {
          h.push('<table><tr><th>Wallet</th><th>Amount</th><th>Transaction</th><th>Steps from the reference</th></tr>');
          o.rows.forEach(function (r) {
            h.push('<tr><td>' + (r.address ? '<code>' + esc(r.address) + '</code>' : 'spender not loaded') + '</td><td class="num">' + (r.amount == null ? '' : amountCell(model, r.amount, null)) + '</td><td><a href="#tx-' + esc(r.txid) + '"><code>' + esc(String(r.txid).slice(0, 16)) + '…</code></a></td><td class="num">' + esc(r.depth) + '</td></tr>');
          });
          h.push('</table>' + (o.count > o.rows.length ? '<p class="hint">The first ' + o.rows.length + ' of ' + o.count + ' are listed; the embedded data has the transactions.</p>' : ''));
        }
      });
    }

    if (model.groups && model.groups.length) {                                 // vertices on the screen that stood for several others: say what, and list every one of them
      h.push('<h2>Groups shown as one vertex</h2><p class="hint">On the screen each of these was a single vertex standing for several transactions or outputs that were not drawn one by one. They are listed here in full: none was left out.</p>');
      model.groups.forEach(function (g) {
        h.push('<h3>' + esc(g.label ? g.label + ' (' + g.text + ')' : g.text) + '</h3>' + (g.tag || g.note ? '<p>' + (g.tag ? '<span class="chip">' + esc(g.tag) + '</span> ' : '') + esc(g.note || '') + '</p>' : '') + '<p class="hint">' + plural(g.count, 'member') + ' · ' + esc(Style.fmtBtc(g.total)) + ' BTC in total (each ' + esc(Style.fmtBtc(g.min)) + ' to ' + esc(Style.fmtBtc(g.max)) + ') · '
          + (g.first == null ? 'times unknown' : esc(t(g.first)) + (g.last !== g.first ? ' to ' + esc(t(g.last)) : '')) + ' · ' + (g.dir === 'next' ? 'forward from' : 'behind') + ' <code>' + esc(String(g.anchor).replace(/^(tx|addr):/, '')) + '</code></p>'
          + '<table><tr><th>Member</th><th>Amount</th><th>Time</th></tr>');
        g.members.slice(0, MAX_TX).forEach(function (m) { h.push('<tr><td><code>' + esc(String(m.id).replace(/^(tx|addr):/, '')) + '</code></td><td class="num">' + amountCell(model, m.amount, m.time) + '</td><td>' + esc(t(m.time)) + '</td></tr>'); });
        h.push('</table>' + (g.members.length > MAX_TX ? '<p class="hint">The first ' + MAX_TX + ' of ' + g.members.length + ' are listed; the embedded data has them all.</p>' : ''));
      });
    }

    if (model.image) h.push('<h2>The graph</h2><p class="hint">The view as it was on screen.</p><img class="graph" alt="The transaction graph as it was on screen" src="' + esc(model.image) + '">');

    var mo = model.money;
    if (mo && (mo.received > 0 || mo.coins > 0)) {
      var bt = function (sats) { return esc(Style.fmtBtc(sats)) + ' BTC'; };
      var place = function (label, p, hint) {
        if (!p || !p.count) return '';
        return '<tr><td>' + esc(label) + (hint ? ' <span class="hint">' + esc(hint) + '</span>' : '') + '</td><td class="num">' + p.count + '</td><td class="num">' + bt(p.sats) + '</td><td>'
          + p.wallets.slice(0, 6).map(function (x) { return '<code>' + esc(x.address) + '</code>' + (x.name ? ' ' + esc(x.name) : '') + ' <span class="hint">' + bt(x.amount) + (x.readAt != null ? ', read ' + esc(t(x.readAt)) : '') + '</span>'; }).join('<br>')
          + (p.walletCount > 6 ? '<br><span class="hint">… and ' + (p.walletCount - 6) + ' more wallets</span>' : '') + '</td></tr>';
      };
      h.push('<h2>Where the money is now</h2><p class="hint">The money that reached ' + esc((mo.refs || []).join(', ')) + ' (' + bt(mo.received) + ' in this report), followed coin by coin through the transactions in this report to where each coin is now. '
        + 'What is <i>resting</i> was unspent when the spends of its transaction were read (the time is shown); it is not a finding, because the server\'s answer changes. A coin <i>not checked</i> is one nobody asked the server about, which is not the same as still there. '
        + 'A coin <i>moved on</i> was spent by a transaction that is not in this report, so the trail is open there. A transaction that spent these coins together with others is <i>mixed</i>: nothing is guessed about its outputs.</p>'
        + '<table><tr><th>Where</th><th>Coins</th><th>Amount</th><th>Wallets</th></tr>'
        + place('Resting (unspent)', mo.resting) + place('Not checked', mo.unchecked, 'not known whether spent') + place('Moved on, not followed', mo.movedOn, 'spent by a transaction that is not in this report') + place('Named wallets', mo.named, 'a name that ends a trail')
        + (mo.mixed && mo.mixed.count ? '<tr><td>Mixed with other money <span class="hint">not followed</span></td><td class="num">' + mo.mixed.count + '</td><td class="num">' + bt(mo.mixed.sats) + '</td><td><span class="hint">together with ' + bt(mo.mixed.foreign) + ' from others, in ' + mo.mixed.txids.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(', ') + '</span></td></tr>' : '')
        + (mo.gap && mo.gap.count ? '<tr><td>Not in this report <span class="hint">outputs of partly loaded transactions</span></td><td class="num">' + mo.gap.count + '</td><td class="num">' + bt(mo.gap.sats) + '</td><td></td></tr>' : '')
        + '<tr><td>Fees on the way</td><td class="num">' + mo.txs + '</td><td class="num">' + esc(fmtInt(mo.fees)) + ' sat</td><td></td></tr>'
        + '<tr><th>Received</th><th></th><th class="num">' + bt(mo.received) + '</th><th>' + (mo.closes ? 'Everything received is accounted for.' : mo.truncated ? 'The trail was cut short: the numbers do not add up.' : 'Does not add up: ' + bt(mo.sum) + ' accounted for, ' + esc(fmtInt(Math.abs(mo.off))) + ' sat ' + (mo.off > 0 ? 'unaccounted' : 'too many') + '.') + '</th></tr></table>');
    }

    var ls = model.losses;
    if (ls && (ls.paid.length || ls.returned.length)) {
      var lb = function (sats) { return esc(Style.fmtBtc(sats)) + ' BTC'; };
      h.push('<h2>Payments from victim wallets</h2><p class="hint">What wallets tagged VICTIM (and the wallets spent together with them) paid to the wallets tagged THREAT or chosen as the reference. The tags are the analyst\'s: Hopline does not find who is whose. '
        + 'Each amount is what the transaction paid to that wallet, not what the victim\'s wallet spent, so change that went back is not counted; a payment that was a small test and the larger one that followed it are named. '
        + (ls.fiat ? 'Values are indicative, at the time of each transaction' + (model.fiatNote ? ': ' + esc(model.fiatNote) : '') + '. ' : '')
        + (ls.mixed ? plural(ls.mixed, 'transaction') + ' that spent coins of both sides ' + (ls.mixed === 1 ? 'is' : 'are') + ' left out. ' : '') + '</p>'
        + '<table><tr><th>When (UTC)</th><th>Transaction</th><th>Paid to</th><th>Amount</th>' + (ls.fiat ? '<th>Value then (' + esc(ls.fiat.currency) + ')</th>' : '') + '<th>What</th></tr>'
        + ls.paid.map(function (p) { return '<tr><td>' + esc(p.time != null ? t(p.time) : 'not in a block') + '</td><td><code>' + esc(p.txid) + '</code></td><td><code>' + esc(p.to) + '</code></td><td class="num">' + lb(p.amount) + '</td>' + (ls.fiat ? '<td class="num">' + esc(p.fiat) + '</td>' : '') + '<td>' + esc(p.roles.map(function (x) { return x === 'test' ? 'test payment' : 'main payment'; }).join(' and ')) + '</td></tr>'; }).join('')
        + ls.returned.map(function (p) { return '<tr><td>' + esc(p.time != null ? t(p.time) : 'not in a block') + '</td><td><code>' + esc(p.txid) + '</code></td><td><code>' + esc(p.to) + '</code></td><td class="num">-' + lb(p.amount) + '</td>' + (ls.fiat ? '<td class="num">' + esc(p.fiat) + '</td>' : '') + '<td>returned to the victim</td></tr>'; }).join('')
        + '<tr><th>Net</th><th></th><th></th><th class="num">' + lb(ls.net) + '</th>' + (ls.fiat ? '<th class="num">' + esc(ls.fiat.net) + '</th>' : '') + '<th>' + plural(ls.paidCount, 'payment') + ' paid' + (ls.returned.length ? ', ' + plural(ls.returned.length, 'return') : '') + (ls.fiat && ls.fiat.today ? '; worth ' + esc(ls.fiat.today) + ' today' : '') + '</th></tr></table>'
        + (ls.paidCount > ls.paid.length ? '<p class="hint">The first ' + ls.paid.length + ' of ' + ls.paidCount + ' payments are listed; the embedded data has them all.</p>' : '')
        + (ls.recipients.length > 1 ? '<p class="hint">By receiving wallet: ' + ls.recipients.map(function (x) { return '<code>' + esc(x.address) + '</code> ' + lb(x.paid) + ' in ' + plural(x.count, 'payment'); }).join('; ') + '.</p>' : ''));
    }

    var zn = model.zone;
    if (zn && zn.n > 0) {
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], few = zn.events.length <= 8;
      h.push('<h2>When the trail moved</h2><p class="hint">The time of day of the transactions that spent the money: those within half an hour of each other count as one event, and a time is when a service first saw the transaction where that was asked, else the time of its block, which can be minutes or hours after it was sent. '
        + 'This is a hypothesis about the local time of whoever sent them, not a finding: people work nights, scripts run at any hour, and a few events fit many offsets.</p><p>' + esc(zn.text) + '</p>'
        + '<table><tr><th>Event (UTC)</th><th>Weekday</th><th>Time is</th><th>Transactions</th></tr>'
        + zn.events.slice(0, 40).map(function (e) { return '<tr><td>' + esc(t(Math.floor(e.time))) + '</td><td>' + days[new Date(e.time * 1000).getUTCDay()] + '</td><td>' + esc(e.basis) + '</td><td>' + e.txids.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(', ') + (e.count > e.txids.length ? ' <span class="hint">and ' + (e.count - e.txids.length) + ' more</span>' : '') + '</td></tr>'; }).join('')
        + '</table>' + (zn.events.length > 40 ? '<p class="hint">The first 40 of ' + zn.events.length + ' events are listed.</p>' : '')
        + '<table><tr><th>Offset</th>' + (few ? zn.events.map(function (e, i) { return '<th>Event ' + (i + 1) + '</th>'; }).join('') : '') + '<th>In waking hours (07:00 to 22:59)</th><th>At night (00:00 to 05:59)</th></tr>'
        + zn.offsets.map(function (o) { return '<tr' + (o.all ? ' class="fit"' : '') + '><td>' + esc(o.text) + '</td>' + (few ? o.hours.map(function (x) { return '<td class="num">' + esc(x) + '</td>'; }).join('') : '') + '<td class="num">' + o.waking + ' of ' + zn.n + (o.all ? ' (all)' : '') + '</td><td class="num">' + o.night + '</td></tr>'; }).join('')
        + '</table>');
    }
    var pt = model.patterns;
    if (pt && pt.test.length + pt.handoff.length + pt.split.length) {
      h.push('<h2>Patterns that are context</h2><p class="hint">Shapes found in the transactions of this report that are common in ordinary use and say nothing about who is behind them. They are not findings and are not counted with them: each is a thing to look at, not a lead.</p>');
      [['Test payment', pt.test, 'A small payment and soon after a much larger one from the same sender to the same wallet (at least 50 times as much, within a week or in the same block). People often send a small amount first to see that it arrives; a scam often asks for one.'],
       ['Hand-off before confirming', pt.handoff, 'Chains of at least two transactions in one block, each spending coins that the one before had paid to a different owner, so the coins were passed on before the first payment was confirmed. A script watching the mempool does it; so does anybody in a hurry. Spending your own unconfirmed change is not counted, and a single hand-off is too common to list.'],
       ['Split and collect', pt.split, 'A run of at least three transactions with one input and two outputs that each pay the same wallet and pass the rest on, listed when the amounts are round or the pieces were later spent together.']].forEach(function (g) {
        if (!g[1].length) return;
        h.push('<h3>' + esc(g[0]) + ' (' + g[1].length + ')</h3><p class="hint">' + esc(g[2]) + '</p><table><tr><th>When (UTC)</th><th>Transactions</th><th>What</th></tr>'
          + g[1].map(function (r) { return '<tr><td>' + esc(r.time != null ? t(r.time) : '') + '</td><td>' + r.txids.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join('<br>') + '</td><td>' + esc(r.text) + '</td></tr>'; }).join('') + '</table>');
      });
    }

    h.push('<h2>Transactions in time order</h2><p class="hint">Inputs are the wallets whose coins were spent, outputs the wallets that received them.' + (txs.length > MAX_TX ? ' Only the first ' + MAX_TX + ' of ' + txs.length + ' are listed here; the embedded data has them all.' : '') + '</p>');
    txs.slice(0, MAX_TX).forEach(function (n) { h.push(txBlock(model, nodes, edgesByTx, n)); });
    if (!txs.length) h.push('<p>No loaded transaction in this selection.</p>');

    h.push('<h2>Wallets</h2><table><tr><th>Address</th><th>Name</th><th>First on chain</th><th>Last on chain</th><th>Received</th><th>Sent</th><th>Balance</th><th>Cluster</th></tr>');
    var clusterOf = {}; (an.clusters || []).forEach(function (c) { c.addrs.forEach(function (id) { clusterOf[id] = c.label; }); });
    wallets.slice().sort(function (a, b) { return (b.received || 0) - (a.received || 0); }).slice(0, MAX_WALLETS).forEach(function (n) {
      h.push('<tr><td><code>' + esc(n.address) + '</code></td><td>' + esc(walletName(model, n)) + '</td><td>' + esc(n.firstSeen != null ? t(n.firstSeen) : '') + '</td><td>' + esc(n.lastSeen != null ? t(n.lastSeen) : '') + '</td><td class="num">' + amountCell(model, n.received || 0, n.firstSeen) + '</td><td class="num">' + amountCell(model, n.sent || 0, n.lastSeen) + '</td><td class="num">' + balanceCell(model, n) + '</td><td>' + esc(clusterOf[n.id] || '') + '</td></tr>');
    });
    h.push('</table>' + balanceSummary(model, wallets) + (wallets.length > MAX_WALLETS ? '<p class="hint">Showing the ' + MAX_WALLETS + ' wallets that received most; the embedded data has all ' + wallets.length + '.</p>' : ''));

    var lk = lookupInfo(model);
    if (lk) {
      h.push('<h2>Outside look-ups</h2><p class="hint">What third-party services said about wallets in this report. Each wallet was sent to the service on request, one at a time, and nothing a service said was applied to a wallet automatically. A name is that service\'s claim, not proof.</p><ul>'
        + lk.sources.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        + '<table><tr><th>Address</th><th>Source</th><th>Said</th><th>Category</th><th>Tags</th><th>Asked</th></tr>');
      lk.rows.slice(0, MAX_WALLETS).forEach(function (l) {
        h.push('<tr><td><code>' + esc(l.address) + '</code></td><td>' + esc(l.sourceName || l.source) + '</td><td>' + (l.found ? esc(l.label || '') + (l.note ? ' <span class="hint">' + esc(l.note) + '</span>' : '') : '<span class="hint">no entry</span>') + '</td><td>'
          + esc(l.category || '') + '</td><td>' + esc((l.tags || []).join(', ')) + '</td><td>' + esc(l.at ? t(l.at) : '') + '</td></tr>');
      });
      h.push('</table>' + (lk.rows.length > MAX_WALLETS ? '<p class="hint">The first ' + MAX_WALLETS + ' of ' + lk.rows.length + ' are listed; the embedded data has them all.</p>' : ''));
    }

    var te = timeInfo(model);
    if (te) {
      var anyPeer = te.rows.some(function (r) { return r.relay; });
      h.push('<h2>When transactions were first seen</h2><p class="hint">A transaction\'s time above is the time of the block that holds it. A service that watches the network as it happens can say when it first saw a transaction, which is nearer to when it was sent. '
        + 'That is the service\'s record, asked for on request and kept with the time it was asked; it is not part of the blockchain. <i>No record</i> means the service learned of the transaction from its block, which says nothing about when it was sent. '
        + (model.timeRelay ? 'The peer is the first node that passed the transaction to the service; it is not necessarily the sender, and an address in a network range says who runs the range, not who used it.' : 'The peers that passed the transactions on were left out of this report' + (anyPeer ? '' : ' (none was recorded)') + '.') + '</p><ul>'
        + te.sources.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        + '<table><tr><th>Transaction</th><th>Block time</th><th>First seen</th><th>Before its block</th>' + (model.timeRelay ? '<th>Peer</th>' : '') + '<th>Source, asked</th></tr>');
      te.rows.slice(0, MAX_WALLETS).forEach(function (r) {
        h.push('<tr><td><code>' + esc(r.txid) + '</code></td><td>' + esc(r.time != null ? t(r.time) : '') + '</td><td>' + (r.seen ? esc(t(Math.floor(r.received))) : '<span class="hint">no record</span>') + '</td><td>'
          + (r.seen && r.confirmed != null ? (r.received <= r.confirmed ? esc(gapWords(r.confirmed - r.received)) : '<span class="hint">none</span>') : '') + '</td>' + (model.timeRelay ? '<td>' + (r.relay ? '<code>' + esc(r.relay) + '</code>' : '') + '</td>' : '')
          + '<td>' + esc(r.sourceName || r.source) + (r.at ? ', ' + esc(t(r.at)) : '') + '</td></tr>');
      });
      h.push('</table>' + (te.rows.length > MAX_WALLETS ? '<p class="hint">The first ' + MAX_WALLETS + ' of ' + te.rows.length + ' are listed; the embedded data has them all.</p>' : ''));
    }

    var wi = (model.windowEvidence || []).filter(function (r) { return r && r.txid; });
    if (wi.length) {
      h.push('<h2>Time window from block data</h2><p class="hint">A transaction\'s time above is the time of its block. The blocks before it show how much earlier it can have been sent: a miner builds a block from what it has seen and takes the best paying first, '
        + 'so a transaction that the block before would have taken, had it been waiting, was sent after that block was built. And a wallet that sets a transaction\'s locktime to the height of the newest block signed it after that block was found. '
        + 'This is Hopline\'s reading of the blocks the data source gave, not a measurement and not part of the blockchain; a margin of a few minutes is taken off because a miner builds a block before it finds it and sets the time stamp itself. '
        + 'Where there is no window, the blocks before did not allow one (for example because they were full and the transaction paid little above what they took).</p>'
        + '<table><tr><th>Transaction</th><th>Not before (about)</th><th>Not after (its block)</th><th>Window</th><th>From the blocks before</th><th>From its locktime</th><th>Asked</th></tr>');
      wi.slice(0, MAX_WALLETS).forEach(function (r) {
        h.push('<tr><td><code>' + esc(r.txid) + '</code></td><td>' + (r.notBefore != null ? esc(t(r.notBefore)) : '<span class="hint">no window</span>') + '</td><td>' + esc(r.blockTime != null ? t(r.blockTime) : '') + '</td><td>'
          + (r.window != null ? esc(gapWords(r.window)) : '') + '</td><td>' + (r.after != null ? 'about ' + esc(t(r.after)) + '. ' : '') + esc(r.because || '') + '</td><td>'
          + (r.signedBlock != null ? 'about ' + esc(t(r.signedAfter)) + ', after block ' + esc(String(r.signedBlock)) + ', if its wallet sets the locktime to the height of the newest block' : '') + '</td><td>' + esc(r.at ? t(r.at) : '') + '</td></tr>');
      });
      h.push('</table>' + (wi.length > MAX_WALLETS ? '<p class="hint">The first ' + MAX_WALLETS + ' of ' + wi.length + ' are listed; the embedded data has them all.</p>' : ''));
    }

    h.push('<h2>Method and limits</h2><ul>'
      + '<li><b>Data:</b> transactions, amounts, times and spending status were read from the source named in the summary at the retrieval times shown. "Unspent" means unspent when its status was last checked, not now. A wallet\'s <i>Received</i> and <i>Sent</i> count only the transactions in this report; its <i>Balance</i> is what the server reported for the whole address at the time shown, and is not read for every wallet.</li>'
      + '<li><b>Times:</b> a transaction\'s time is the time of the block that holds it, which the miner sets: the transaction may have been sent minutes or hours earlier.' + (te ? ' A first-seen time is what an outside service recorded; it is that service\'s claim and is not part of the chain.' : '') + (wi.length ? ' A time window is Hopline\'s reading of the blocks before the transaction\'s block, with a margin of a few minutes; it is an inference and says when a transaction can have been sent, not when it was.' : '') + '</li>'
      + '<li><b>Patterns</b> are rules over the loaded transactions: consolidation (5 or more inputs into 1 or 2 outputs), batch payment (up to 3 inputs, 6 or more outputs), CoinJoin-like (3 or more input wallets and several outputs of exactly the same value to different addresses), peel chain (4 or more linked one-input, two-output transactions whose small output is at most half the large one and not dust-sized), round amount (an output of at least 0.01 BTC that is a multiple of 0.0001 BTC, in a transaction that is none of the others, does not spend from a service wallet and does not pay the same amount to three or more recipients: a number somebody chose, not a statement of who), swap or bridge memo (an OP_RETURN in THORChain\'s format that asks for the payment to be swapped into an asset on another chain, with the address it is to be paid out to; the OUT: or REFUND: memo THORChain writes on a payment it makes, with the hash it names; the request ID of a cross-chain service such as Relay; or a Rootstock peg-in with its destination address: what the sender wrote, not proof that anything was carried out).</li>'
      + '<li><b>Likely change</b> weighs: the output address is also an input; the only output of the same address type as the inputs; a round payment amount; the other output paying a known or tagged wallet; an output smaller than every input; the spender having the same wallet habits. Each reason is listed beside the finding. Close calls are not named, and neither are two outputs within 1% of each other unless one address is also an input (an even split looks like two payments). Only a strong guess is called likely; the rest are called possible, and a lead to follow from both outputs.</li>'
      + '<li><b>Clusters</b> use the common-input rule (inputs spent together share an owner). A CoinJoin, a PayJoin or a shared wallet can break it.</li>'
      + (model.trace ? '<li><b>Routes, hand-offs and open ends</b> follow each coin to the transaction that spent it (never a match of addresses), within what was loaded and on screen. A route is not carried across a service wallet unless there is no other way, and then it says so; a step that merges many inputs is named, because coins of other origins join there. A route shows that the money could have travelled that way, not who controls the wallets between. "No route" and a missing hand-off only mean none was found in the loaded transactions.</li>' : '')
      + '<li>Only loaded transactions can be analysed; loading more can add, change or remove a finding. Names from label packs' + (lk ? ' and from outside look-ups' : '') + ' are third-party claims, shown with the pack or the service they came from.</li>'
      + (model.fiatNote ? '<li><b>Fiat values</b> are indicative: ' + esc(model.fiatNote) + ' Quote an exchange\'s price for the exact moment where it matters.</li>' : '') + '</ul>');

    h.push('<h2>Integrity</h2><p>The evidence data embedded in this file (every vertex and movement above, with where and when it was fetched, and the settings used) has this SHA-256:</p><p class="hash" id="evidence-hash">' + esc(hash) + '</p>'
      + '<p>The whole of this file, with the line below written as 64 zeros, has this SHA-256 (it changes if a single word of the readable report is edited, or if the file is re-saved with other line endings):</p>' + DOC_P
      + '<p class="hint">To check that nothing was changed since the report was made, run <code>python tools/verify_report.py this-file.html</code> from the Hopline repository, or hash the text of the <code>hopline-evidence</code> data block at the end of this file yourself and compare. Do not open and re-save the file in an editor. The block is a workspace file: save its text as .json and Hopline\'s Import opens it.</p>');
    h.push('<script type="application/json" id="hopline-evidence">' + text + '</script></body></html>');
    return h.join('\n');
  }

  return { build: build, render: render, analysisFor: analysisFor, esc: esc, evidenceText: evidenceText, sha256Hex: sha256Hex, ZERO: ZERO };
}));
