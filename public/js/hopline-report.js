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
    h.push('<h1>' + esc(title) + '</h1><p class="meta">' + (model.preparedBy ? 'Prepared by ' + esc(model.preparedBy) + ' · ' : '') + 'generated ' + esc(t(Math.floor((model.generated || Date.now()) / 1000))) + ' · made with Hopline workspace · all times UTC</p>');
    h.push('<div class="notice"><b>Read this first.</b> The facts here (transactions, amounts, times, which output was spent by which transaction) come from the blockchain data source named below and were fetched at the times shown. The <i>findings</i> (patterns, likely change, address clusters) are heuristics: they are guesses with their reasons stated, not proof of who controls what.</div>');

    h.push('<h2>Summary</h2><table><tr><th>What is covered</th><td>' + plural(txs.length, 'transaction') + ' loaded' + (stubs ? ' (and ' + stubs + ' more referenced but not loaded)' : '') + ', ' + plural(wallets.length, 'wallet') + ', ' + plural(model.edges.length, 'movement') + '. This is what was on screen when the report was made.</td></tr>'
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

    h.push('<h2>Transactions in time order</h2><p class="hint">Inputs are the wallets whose coins were spent, outputs the wallets that received them.' + (txs.length > MAX_TX ? ' Only the first ' + MAX_TX + ' of ' + txs.length + ' are listed here; the embedded data has them all.' : '') + '</p>');
    txs.slice(0, MAX_TX).forEach(function (n) { h.push(txBlock(model, nodes, edgesByTx, n)); });
    if (!txs.length) h.push('<p>No loaded transaction in this selection.</p>');

    h.push('<h2>Wallets</h2><table><tr><th>Address</th><th>Name</th><th>First seen</th><th>Last seen</th><th>Received</th><th>Sent</th><th>Balance</th><th>Cluster</th></tr>');
    var clusterOf = {}; (an.clusters || []).forEach(function (c) { c.addrs.forEach(function (id) { clusterOf[id] = c.label; }); });
    wallets.slice().sort(function (a, b) { return (b.received || 0) - (a.received || 0); }).slice(0, MAX_WALLETS).forEach(function (n) {
      h.push('<tr><td><code>' + esc(n.address) + '</code></td><td>' + esc(walletName(model, n)) + '</td><td>' + esc(n.firstSeen != null ? t(n.firstSeen) : '') + '</td><td>' + esc(n.lastSeen != null ? t(n.lastSeen) : '') + '</td><td class="num">' + amountCell(model, n.received || 0, n.firstSeen) + '</td><td class="num">' + amountCell(model, n.sent || 0, n.lastSeen) + '</td><td class="num">' + balanceCell(model, n) + '</td><td>' + esc(clusterOf[n.id] || '') + '</td></tr>');
    });
    h.push('</table>' + (wallets.length > MAX_WALLETS ? '<p class="hint">Showing the ' + MAX_WALLETS + ' wallets that received most; the embedded data has all ' + wallets.length + '.</p>' : ''));

    h.push('<h2>Method and limits</h2><ul>'
      + '<li><b>Data:</b> transactions, amounts, times and spending status were read from the source named in the summary at the retrieval times shown. "Unspent" means unspent when its status was last checked, not now. A wallet\'s <i>Received</i> and <i>Sent</i> count only the transactions in this report; its <i>Balance</i> is what the server reported for the whole address at the time shown, and is not read for every wallet.</li>'
      + '<li><b>Patterns</b> are rules over the loaded transactions: consolidation (5 or more inputs into 1 or 2 outputs), batch payment (up to 3 inputs, 6 or more outputs), CoinJoin-like (3 or more input wallets and several outputs of exactly the same value to different addresses), peel chain (4 or more linked one-input, two-output transactions whose small output is at most half the large one and not dust-sized).</li>'
      + '<li><b>Likely change</b> weighs: the output address is also an input; the only output of the same address type as the inputs; a round payment amount; the other output paying a known or tagged wallet; an output smaller than every input; the spender having the same wallet habits. Each reason is listed beside the finding. Close calls are not named, and neither are two outputs within 1% of each other unless one address is also an input (an even split looks like two payments). Only a strong guess is called likely; the rest are called possible, and a lead to follow from both outputs.</li>'
      + '<li><b>Clusters</b> use the common-input rule (inputs spent together share an owner). A CoinJoin, a PayJoin or a shared wallet can break it.</li>'
      + '<li>Only loaded transactions can be analysed; loading more can add, change or remove a finding. Names from label packs are third-party claims, shown with the pack they came from.</li>'
      + (model.fiatNote ? '<li><b>Fiat values</b> are indicative: ' + esc(model.fiatNote) + ' Quote an exchange\'s price for the exact moment where it matters.</li>' : '') + '</ul>');

    h.push('<h2>Integrity</h2><p>The evidence data embedded in this file (every vertex and movement above, with where and when it was fetched, and the settings used) has this SHA-256:</p><p class="hash" id="evidence-hash">' + esc(hash) + '</p>'
      + '<p>The whole of this file, with the line below written as 64 zeros, has this SHA-256 (it changes if a single word of the readable report is edited, or if the file is re-saved with other line endings):</p>' + DOC_P
      + '<p class="hint">To check that nothing was changed since the report was made, run <code>python tools/verify_report.py this-file.html</code> from the Hopline repository, or hash the text of the <code>hopline-evidence</code> data block at the end of this file yourself and compare. Do not open and re-save the file in an editor. The block is a workspace file: save its text as .json and Hopline\'s Import opens it.</p>');
    h.push('<script type="application/json" id="hopline-evidence">' + text + '</script></body></html>');
    return h.join('\n');
  }

  return { build: build, render: render, esc: esc, evidenceText: evidenceText, sha256Hex: sha256Hex, ZERO: ZERO };
}));
