/*
 * Orion wallet overview: one address as a ledger. Everything that came from outside (names, notes, addresses, OP_RETURN text) reaches
 * the page through textContent only, never as HTML.
 */
(function () {
  'use strict';

  var A = OrionApi, AD = OrionAddress, S = OrionStyle, W = OrionWallet, LB = OrionLabels;
  var PREF_KEY = 'orion.prefs.v1', PACKS_KEY = 'orion.packs.v1', PAGE = 25, NL = String.fromCharCode(10);

  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var store = { get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } } };
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function btc(sats) { return S.fmtBtc(sats) + ' BTC'; }

  // ---- what the workspace saved: which server to ask, and the label lists --------------------------------
  var prefs = {};
  try { prefs = JSON.parse(store.get(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  var qs = new URLSearchParams(location.search);
  var choice = { source: A.PRESETS[prefs.source] ? prefs.source : 'clearnet', customBase: typeof prefs.customBase === 'string' ? prefs.customBase : '', fallback: prefs.fallback !== false };
  if (qs.get('source') && A.PRESETS[qs.get('source')] && qs.get('source') !== 'custom') choice.source = qs.get('source');
  if (choice.source === 'custom' && !/^https?:\/\//i.test(choice.customBase.trim())) choice.source = 'clearnet';
  var KNOWN = LB.buildKnown(window.ORION_KNOWN || {}, LB.parseStored(store.get(PACKS_KEY)));
  function known(a) { return KNOWN[a] || null; }

  var state = { addr: null, stats: null, txs: [], done: false, busy: false, dir: 'all', client: null, led: null };

  // ---- small pieces --------------------------------------------------------------------------------------
  function message(text, bad, retry) {
    var m = $('message');
    m.textContent = text; m.className = bad ? 'bad' : ''; m.hidden = !text;
    m.setAttribute('role', bad ? 'alert' : 'status');
    if (text && retry) m.appendChild(el('button', { type: 'button', text: 'Try again', onclick: retry }));
  }
  function copyIcon() {
    var NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '13'); s.setAttribute('height', '13'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.5'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    var back = document.createElementNS(NS, 'path'); back.setAttribute('d', 'M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5');
    var front = document.createElementNS(NS, 'rect'); front.setAttribute('x', '5'); front.setAttribute('y', '5'); front.setAttribute('width', '9'); front.setAttribute('height', '9'); front.setAttribute('rx', '1.5');
    s.appendChild(back); s.appendChild(front);
    return s;
  }
  function copy(text, what) {
    function done() { message('Copied ' + what + '.'); }
    function legacy() {
      try {
        var ta = el('textarea', { readonly: 'readonly', 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
        ta.value = text; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { if (legacy()) done(); else message('Could not copy; select the text instead.', true); });
    else if (legacy()) done();
    else message('Copy is not available in this browser.', true);
  }
  function copyBtn(text, what) {
    var b = el('button', { type: 'button', 'class': 'copybtn', title: 'Copy ' + what, 'aria-label': 'Copy ' + what,
                           onclick: function () { copy(text, what); b.classList.add('done'); setTimeout(function () { b.classList.remove('done'); }, 1200); } });
    b.appendChild(copyIcon());
    return b;
  }
  function walletHref(a) { return 'wallet.html?q=' + encodeURIComponent(a); }
  function explorerOrigin() {
    if (choice.source === 'tor') return A.ONION.replace(/\/api$/, '');
    if (choice.source === 'custom') return choice.customBase.trim().replace(/\/(api\/?)?$/, '');
    return 'https://mempool.space';
  }
  function nameTip(k) { return k.label + (k.pack ? ' (list: ' + k.pack + ')' : '') + (k.category ? ' · ' + k.category : ''); }

  // ---- drawing -------------------------------------------------------------------------------------------
  function drawHead() {
    var a = state.addr, k = known(a);
    $('addr').textContent = a;
    $('copyAddr').textContent = ''; $('copyAddr').appendChild(copyIcon());
    var lab = $('addrLabel');
    lab.hidden = !k; lab.textContent = k ? k.label : ''; lab.title = k ? nameTip(k) : '';
    $('addrNote').textContent = k && k.note ? k.note : '';
    $('head').hidden = false;
    $('toWorkspace').href = 'workspace.html?q=' + encodeURIComponent(a); $('toWorkspace').hidden = false;
    document.title = 'Orion Wallet · ' + S.shortId(a, 8);
  }

  function drawSummary() {
    var s = W.summary(state.stats), led = state.led, t = led.totals;
    $('sBalance').textContent = btc(s.balance);
    $('sReceived').textContent = btc(s.received);
    $('sSent').textContent = btc(s.sent);
    var pend = $('sPending'); pend.textContent = '';
    if (!s.pendingCount) pend.textContent = 'none';
    else { pend.appendChild(document.createTextNode(plural(s.pendingCount, 'transaction'))); pend.appendChild(el('small', { text: (s.pendingNet >= 0 ? '+' : '−') + btc(Math.abs(s.pendingNet)) + ' when confirmed' })); }
    var c = $('sCount'); c.textContent = '';
    c.appendChild(document.createTextNode(String(s.txCount) + ' on chain'));
    c.appendChild(el('small', { text: state.txs.length + ' loaded' + (state.done ? ' (all)' : '') }));
    $('sFirst').textContent = t.first == null ? '—' : S.fmtTime(t.first);
    $('sLast').textContent = t.last == null ? '—' : S.fmtTime(t.last);
    $('summary').hidden = false;
  }

  function drawAssoc() {
    var box = $('assoc'); box.textContent = '';
    var list = state.led.assoc;
    $('assocSec').hidden = !list.length;
    list.forEach(function (a) {
      var nums = [];
      if (a.asInput) nums.push('paid in ' + btc(a.asInput));
      if (a.asOutput) nums.push('received ' + btc(a.asOutput));
      var row = el('div', { 'class': 'assocrow' }, [el('span', { 'class': 'lbl', text: a.label }), a.category ? el('span', { 'class': 'chip dim', text: a.category }) : null, a.pack ? el('span', { 'class': 'chip dim', text: a.pack }) : null,
        el('a', { 'class': 'mono', href: walletHref(a.address), text: a.address }), el('span', { 'class': 'nums', text: plural(a.txs, 'transaction') + ' · ' + nums.join(' · ') })]);
      box.appendChild(row);
    });
  }

  function side(list, kind) {
    var col = el('div', { 'class': 'col' }, [el('h4', { text: (kind === 'in' ? 'Inputs' : 'Outputs') + ' (' + list.length + ')' })]);
    list.forEach(function (x) {
      var who;
      if (x.coinbase) who = el('span', { 'class': 'who', text: 'Newly minted coins (coinbase)' });
      else if (!x.address) who = el('span', { 'class': 'who' }, [x.data ? 'OP_RETURN' + (x.data.text ? ' “' + x.data.text + '”' : x.data.hex ? ' ' + x.data.hex.slice(0, 40) + (x.data.hex.length > 40 ? '…' : '') : '') : 'Output without an address']);
      else if (x.self) who = el('span', { 'class': 'who' }, [el('span', { 'class': 'you', text: 'this wallet' }), ' ', el('span', { 'class': 'mono', text: x.address })]);
      else who = el('span', { 'class': 'who' }, [x.label ? el('span', { 'class': 'lbl', title: nameTip({ label: x.label, pack: x.pack }), text: x.label + ' ' }) : null, el('a', { 'class': 'mono', href: walletHref(x.address), text: x.address })]);
      col.appendChild(el('div', { 'class': 'line' + (x.self ? ' self' : '') }, [who, x.coinbase ? null : el('span', { 'class': 'amt ' + kind, text: btc(x.value) })]));
    });
    return col;
  }

  function txCard(r) {
    var head = el('div', { 'class': 'txhead' }, [
      el('span', { 'class': 'time', text: r.time == null ? 'Unconfirmed' : S.fmtTimeFull(r.time) }),
      el('span', { 'class': 'net ' + r.dir, text: r.dir === 'none' ? 'not involved' : (r.net > 0 ? '+' : r.net < 0 ? '−' : '') + btc(Math.abs(r.net)) + (r.dir === 'in' ? ' received' : r.dir === 'out' ? ' sent' : r.dir === 'self' ? ' moved within' : '') })]);
    var meta = [];
    if (r.confirmed && r.height != null) meta.push('block ' + r.height);
    if (r.fee != null) meta.push('fee ' + r.fee + ' sat');
    if (r.balanceAfter != null) meta.push('balance after ' + btc(r.balanceAfter));
    if (meta.length) head.appendChild(el('span', { 'class': 'meta', text: meta.join(' · ') }));
    var foot = el('div', { 'class': 'txfoot' }, [el('span', { 'class': 'mono', text: r.txid }), copyBtn(r.txid, 'the transaction id'),
      el('a', { href: 'workspace.html?q=' + encodeURIComponent(r.txid), text: 'Open in workspace ↗' }),
      el('a', { href: explorerOrigin() + '/tx/' + r.txid, target: '_blank', rel: 'noopener noreferrer', text: 'Explorer ↗' })]);
    return el('article', { 'class': 'tx ' + r.dir, 'data-txid': r.txid }, [head, el('div', { 'class': 'cols' }, [side(r.inputs, 'in'), side(r.outputs, 'out')]), foot]);
  }

  function drawLedger() {
    var rows = state.led.rows.filter(function (r) { return state.dir === 'all' || r.dir === state.dir; });
    var box = $('ledger'); box.textContent = '';
    rows.forEach(function (r) { box.appendChild(txCard(r)); });
    if (!rows.length) box.appendChild(el('p', { 'class': 'hint', text: state.led.rows.length ? 'None of the loaded transactions are like that. Load more, or choose All.' : 'No transactions yet.' }));
    var all = state.led.rows;
    Array.prototype.forEach.call($('dirSeg').querySelectorAll('button'), function (b) {
      var d = b.getAttribute('data-dir'), n = d === 'all' ? all.length : all.filter(function (r) { return r.dir === d; }).length;
      b.setAttribute('aria-checked', String(state.dir === d));
      b.textContent = (d === 'in' ? '↓ In ' : d === 'out' ? '↑ Out ' : 'All ') + n;
    });
    var total = W.summary(state.stats).txCount + W.summary(state.stats).pendingCount;
    $('loaded').textContent = state.led.rows.length + ' of ' + total + ' loaded';
    var more = $('more');
    more.disabled = state.busy || state.done;
    more.textContent = state.done ? 'All loaded' : state.busy ? 'Loading…' : 'Load ' + PAGE + ' more';
    $('csv').disabled = !state.led.rows.length;
    $('ledgerSec').hidden = false;
  }

  function redraw() {
    state.led = W.ledger(state.addr, state.txs, { known: known, balance: W.summary(state.stats).balance });
    drawSummary(); drawAssoc(); drawLedger();
    $('source').textContent = 'Data: ' + A.hostOf(state.client.base) + (state.client.backup ? ' (backup ' + A.hostOf(state.client.backup.base) + ')' : '') + ' · ' + plural(state.client.total.network, 'request') + ' so far. Names come from the built-in list and the label lists saved by the workspace.';
  }

  // ---- loading -------------------------------------------------------------------------------------------
  function lastChainTxid() {
    for (var i = state.txs.length - 1; i >= 0; i--) if (state.txs[i].status && state.txs[i].status.confirmed) return state.txs[i].txid;
    return null;
  }
  function addPage(list, first) {
    var seen = new Set(state.txs.map(function (t) { return t.txid; })), chain = 0;
    list.forEach(function (t) { if (t.status && t.status.confirmed) chain++; if (!seen.has(t.txid)) { state.txs.push(t); seen.add(t.txid); } });
    if (chain < PAGE) state.done = true;
  }
  /** Something went wrong while drawing: say so on the page (with what it was) instead of leaving it blank. */
  function showFailure(what, e, retry) { state.busy = false; message(what + ': ' + (e && e.message ? e.message : e), true, retry); }
  var waitTimer = null;
  function load() {
    state.busy = true; message('Loading…');
    clearTimeout(waitTimer);
    waitTimer = setTimeout(function () {                                              // a server that neither answers nor refuses: say what is happening
      if (state.busy) message('Still waiting for ' + A.hostOf(state.client.base) + '… If this goes on, the server may be slow or blocked here; you can try the other one (add &source=blockstream to the address of this page).', false, load);
    }, window.ORION_WAIT_MS || 20000);
    return Promise.all([state.client.address(state.addr), state.client.addressTxs(state.addr)]).then(function (r) {
      clearTimeout(waitTimer);
      state.stats = r[0]; state.txs = []; state.done = false;
      try { addPage(r[1], true); state.busy = false; message(state.switched || ''); drawHead(); redraw(); }
      catch (e) { showFailure('The data arrived but could not be shown', e, load); }
    }, function (e) {
      clearTimeout(waitTimer);
      state.busy = false;
      message(e && e.kind === 'notfound' ? 'The server does not know that address. Check it for a typing mistake.' : 'Could not load this address: ' + (e && e.message ? e.message : e), true, load);
    });
  }
  function more() {
    var cursor = lastChainTxid();
    if (state.busy || state.done || !cursor) return;
    state.busy = true; drawLedger();
    return state.client.addressTxs(state.addr, cursor).then(function (list) {
      try { addPage(list, false); state.busy = false; redraw(); } catch (e) { showFailure('More data arrived but could not be shown', e, more); }
    }, function (e) {
      state.busy = false; drawLedger(); message('Could not load more: ' + (e && e.message ? e.message : e), true, more);
    });
  }

  function open(q) {
    var c = A.checkQuery(q);
    if (!c.ok) { message(c.message, true); return; }
    if (c.kind === 'tx') { window.location.href = 'workspace.html?q=' + encodeURIComponent(c.value); return; }       // a transaction is looked at in the workspace
    window.location.href = walletHref(c.value);
  }

  function csv() {
    var blob = new Blob([String.fromCharCode(0xFEFF) + W.csv(state.led.rows)], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'orion-wallet-' + state.addr.slice(0, 12) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function showQR() {
    var f = $('qrfloat'); f.textContent = ''; f.hidden = false;
    try { new QRCode(f, { text: state.addr, width: 160, height: 160 }); } catch (e) { f.hidden = true; }
  }
  function hideQR() { $('qrfloat').hidden = true; }

  function init() {
    state.client = A.buildClient(choice, {
      onSwitch: function (i) { state.switched = A.hostOf(i.from) + ' did not answer well, so ' + A.hostOf(i.to) + ' was used.'; message(state.switched); }
    });
    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); open($('q').value); });
    $('more').addEventListener('click', more);
    $('csv').addEventListener('click', csv);
    $('copyAddr').addEventListener('click', function () { if (state.addr) copy(state.addr, 'the address'); });
    Array.prototype.forEach.call($('dirSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { state.dir = b.getAttribute('data-dir'); if (state.led) drawLedger(); }); });
    var addr = $('addr');
    addr.addEventListener('mouseenter', showQR); addr.addEventListener('mouseleave', hideQR); addr.addEventListener('focus', showQR); addr.addEventListener('blur', hideQR);
    var q = qs.get('q');
    if (!q) { message('Enter a Bitcoin address above.'); return; }
    $('q').value = q;
    var c = A.checkQuery(q);
    if (!c.ok) { message(c.message, true); return; }
    if (c.kind === 'tx') { window.location.replace('workspace.html?q=' + encodeURIComponent(c.value)); return; }
    state.addr = c.value;
    load();
  }

  window.addEventListener('unhandledrejection', function (ev) { showFailure('Something went wrong', ev.reason, null); });
  window.__wallet = { state: state, known: known };                                  // read by the end-to-end tests
  function boot() { init(); window.__booted = true; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());
