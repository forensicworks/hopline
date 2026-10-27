/*
 * Hopline wallet overview: one address as a ledger. Everything that came from outside (names, notes, addresses, OP_RETURN text) reaches
 * the page through textContent only, never as HTML.
 */
(function () {
  'use strict';

  var A = HoplineApi, AD = HoplineAddress, S = HoplineStyle, W = HoplineWallet, LB = HoplineLabels, PK = HoplinePacks, PR = HoplinePrice, XT = HoplineExternal, IO = HoplineIO, RP = HoplineReport, AN = HoplineAnalysis;
  var PREF_KEY = 'hopline.prefs.v1', PACKS_KEY = 'hopline.packs.v1', SESSION_KEY = 'hopline.workspace.v1', PAGE = 25, NL = String.fromCharCode(10);

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
  // reads the new name first, then the one an older version (called Orion) used
  var store = { get: function (k) { try { var v = window.localStorage.getItem(k); return v != null ? v : window.localStorage.getItem(k.replace(/^hopline\./, 'orion.')); } catch (e) { return null; } } };
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function btc(sats) { return S.fmtBtc(sats) + ' BTC'; }

  // ---- what the workspace saved: which server to ask, and the label lists --------------------------------
  var prefs = {};
  try { prefs = JSON.parse(store.get(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  var qs = new URLSearchParams(location.search);
  var choice = { source: A.PRESETS[prefs.source] ? prefs.source : 'clearnet', customBase: typeof prefs.customBase === 'string' ? prefs.customBase : '', fallback: prefs.fallback !== false,
                 pace: A.cleanPace(prefs.pace), keys: {}, customPrices: prefs.customPrices };
  if (prefs.keyRemember === true) {                                                  // a key you chose to keep in this browser is used here as well
    try { var savedKeys = JSON.parse(store.get('hopline.keys.v1') || '{}') || {}; Object.keys(savedKeys).forEach(function (id) { if (A.PRESETS[id] && A.cleanKey(savedKeys[id])) choice.keys[id] = A.cleanKey(savedKeys[id]); }); } catch (e) { choice.keys = {}; }
  }
  if (qs.get('source') && A.PRESETS[qs.get('source')] && qs.get('source') !== 'custom') choice.source = qs.get('source');
  if (choice.source === 'custom' && !/^https?:\/\//i.test(choice.customBase.trim())) choice.source = 'clearnet';
  var imported = LB.parseStored(store.get(PACKS_KEY)), own = LB.fromSession(store.get(SESSION_KEY)), shipped = [];                         // packs you imported, what you wrote yourself in the workspace, and the packs that come with the site
  function buildKnown() { return LB.buildKnown(window.HOPLINE_KNOWN || {}, imported.concat(PK.active(shipped, imported)), own); }
  var KNOWN = buildKnown();
  function known(a) { return KNOWN[a] || null; }

  /** Load the packs that come with the site and are switched on (the OFAC list unless it was switched off in the workspace). Always resolves; a pack that cannot be loaded is said so on the page. */
  function loadShipped() {
    var choices = PK.cleanChoices(prefs.shippedPacks), failed = [];
    return Promise.all(PK.cleanIndex(window.HOPLINE_PACK_INDEX).filter(function (e) { return PK.isOn(e, choices); }).map(function (e) {
      return PK.load(e, window).then(function (r) {
        shipped.push(Object.assign({}, e, { entries: r.entries, sanctions: r.sanctions === true, asOf: r.asOf || e.asOf, enabled: true, loaded: true }));
      }, function () { failed.push(e); });
    })).then(function () {
      KNOWN = buildKnown();
      if (failed.length) {
        var w = $('packWarn');
        w.textContent = failed.map(function (e) { return 'The built-in list "' + e.name + '" could not be loaded' + (e.sanctions ? ', so a wallet on it is not marked as sanctioned here' : ''); }).join('. ') + '. Reload the page to try again.';
        w.hidden = false;
      }
    });
  }

  var state = { addr: null, stats: null, txs: [], done: false, busy: false, dir: 'all', client: null, led: null,
                fiat: PR.cleanFiat(prefs.fiat), books: {}, today: null, todayAt: 0, fiatError: '', priceClient: null,
                f: { text: '', from: null, to: null, min: null, max: null }, shown: 100, picked: [], cpShown: 10,
                fetched: new Map(), statsAt: null, statsSource: null };                                // when, and from which server, the totals and each transaction arrived: what an export says about its evidence

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
  var SAMPLE = 'bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfsegq';                       // the wallet "Try a sample wallet" opens: a real one with a short history
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
    lab.hidden = !k; lab.textContent = k ? k.label : ''; lab.title = k ? nameTip(k) : ''; lab.classList.toggle('sanctioned', !!(k && k.sanctions));
    $('addrNote').textContent = k && k.note ? k.note : '';
    var tg = $('addrTag'); tg.hidden = !(k && k.category); tg.textContent = k && k.category ? k.category : '';
    var ark = $('arkLink'), arkHref = choice.source === 'tor' ? '' : XT.arkhamUrl('address', a);      // a link to Arkham's own page: not offered over Tor, where it would go outside Tor
    ark.hidden = !arkHref;
    if (arkHref) { ark.href = arkHref; ark.title = 'Opens Arkham in a new tab, with your own Arkham account if you are signed in there. Arkham is told which wallet you are looking at; no key or proxy is used.'; }
    drawClaims(k);
    $('head').hidden = false;
    $('toWorkspace').href = 'workspace.html?q=' + encodeURIComponent(a); $('toWorkspace').hidden = false;
    document.title = 'Hopline Wallet · ' + S.shortId(a, 8);
  }

  /** Every list that names this wallet, with its own category, source and note; a banner when one of them is a sanctions list. */
  function drawClaims(k) {
    var box = $('claims'), ban = $('sanctionBanner'); box.textContent = '';
    var claims = LB.claimsOf(k), sanc = claims.filter(function (c) { return c.sanctions; });
    ban.hidden = !sanc.length;
    ban.textContent = sanc.length ? 'On a sanctions list according to ' + sanc.map(function (c) { return c.pack; }).join(', ') + '. A listing is that list\'s claim: open its source before relying on it.' : '';
    box.hidden = claims.length < 2;
    if (claims.length < 2) return;
    box.appendChild(el('span', { 'class': 'lbl', text: 'Listed by ' + claims.length + ' sources' }));
    claims.forEach(function (c) {
      var row = el('div', { 'class': 'claimrow' }, [el('b', { text: c.label }), el('span', { 'class': 'chip dim', text: c.pack || 'built-in list' }), c.category ? el('span', { 'class': 'chip dim', text: c.category }) : null,
                                                    c.sanctions ? el('span', { 'class': 'chip bad', text: 'sanctions list' }) : null]);
      if (c.url && LB.cleanUrl(c.url)) row.appendChild(el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', text: 'source ↗' }));
      if (c.note) row.appendChild(el('div', { 'class': 'hint', text: c.note }));
      box.appendChild(row);
    });
  }

  function drawSummary() {
    var s = W.summary(state.stats), led = state.led, t = led.totals;
    setAmount($('sBalance'), s.balance, fxNow(s.balance), 'at today\'s price');
    var rv = fxTotal(s.received, 'recv'), sn = fxTotal(s.sent, 'sent');
    setAmount($('sReceived'), s.received, rv && rv.x, rv && rv.note);
    setAmount($('sSent'), s.sent, sn && sn.x, sn && sn.note);
    var pend = $('sPending'); pend.textContent = '';
    if (!s.pendingCount) pend.textContent = 'none';
    else { pend.appendChild(document.createTextNode(plural(s.pendingCount, 'transaction'))); pend.appendChild(el('small', { text: (s.pendingNet >= 0 ? '+' : '−') + amt(Math.abs(s.pendingNet), null) + ' when confirmed' })); }
    var c = $('sCount'); c.textContent = '';
    c.appendChild(document.createTextNode(String(s.txCount) + ' on chain'));
    c.appendChild(el('small', { text: state.txs.length + ' loaded' + (state.done ? ' (all)' : '') }));
    $('sFirst').textContent = t.first == null ? '—' : S.fmtTime(t.first);
    $('sLast').textContent = t.last == null ? '—' : S.fmtTime(t.last);
    $('summary').hidden = false;
  }

  function drawAssoc() {
    var box = $('assoc'); box.textContent = '';
    var list = state.led.assoc, fv = fxByWallet(new Set(list.map(function (a) { return a.address; })));
    $('assocSec').hidden = !list.length;
    list.forEach(function (a) {
      var nums = [], f = fv.get(a.address);
      if (a.asInput) nums.push('paid in ' + mix(a.asInput, f && fxValue(f.inV, f.approx)));
      if (a.asOutput) nums.push('received ' + mix(a.asOutput, f && fxValue(f.outV, f.approx)));
      var row = el('div', { 'class': 'assocrow' }, [el('span', { 'class': 'lbl', text: a.label }), a.category ? el('span', { 'class': 'chip dim', text: a.category }) : null, a.pack ? el('span', { 'class': 'chip dim', text: a.pack }) : null, a.sanctions ? el('span', { 'class': 'chip bad', text: 'sanctions list' }) : null,
        el('a', { 'class': 'mono', href: walletHref(a.address), text: a.address }), el('span', { 'class': 'nums', text: plural(a.txs, 'transaction') + ' · ' + nums.join(' · ') })]);
      box.appendChild(row);
    });
  }

  function side(list, kind, time) {
    var col = el('div', { 'class': 'col' }, [el('h4', { text: (kind === 'in' ? 'Inputs' : 'Outputs') + ' (' + list.length + ')' })]);
    list.forEach(function (x) {
      var who;
      if (x.coinbase) who = el('span', { 'class': 'who', text: 'Newly minted coins (coinbase)' });
      else if (!x.address) who = el('span', { 'class': 'who' }, [x.data ? 'OP_RETURN' + (x.data.text ? ' “' + x.data.text + '”' : x.data.hex ? ' ' + x.data.hex.slice(0, 40) + (x.data.hex.length > 40 ? '…' : '') : '') : 'Output without an address']);
      else if (x.self) who = el('span', { 'class': 'who' }, [el('span', { 'class': 'you', text: 'this wallet' }), ' ', el('span', { 'class': 'mono', text: x.address })]);
      else who = el('span', { 'class': 'who' }, [x.label ? el('span', { 'class': 'lbl', title: nameTip({ label: x.label, pack: x.pack }), text: x.label + ' ' }) : null, el('a', { 'class': 'mono', href: walletHref(x.address), text: x.address })]);
      col.appendChild(el('div', { 'class': 'line' + (x.self ? ' self' : '') }, [who, x.coinbase ? null : amtEl(x.value, time, 'amt ' + kind)]));
    });
    return col;
  }

  function txCard(r) {
    var head = el('div', { 'class': 'txhead' }, [
      el('span', { 'class': 'time', text: r.time == null ? 'Unconfirmed' : S.fmtTimeFull(r.time) }),
      el('span', { 'class': 'net ' + r.dir }, r.dir === 'none' ? ['not involved'] : [(r.net > 0 ? '+' : r.net < 0 ? '−' : ''), amtEl(Math.abs(r.net), r.time), (r.dir === 'in' ? ' received' : r.dir === 'out' ? ' sent' : r.dir === 'self' ? ' moved within' : '')])]);
    var meta = [];
    if (r.confirmed && r.height != null) meta.push('block ' + r.height);
    if (r.fee != null) meta.push('fee ' + r.fee + ' sat');
    if (r.balanceAfter != null) meta.push('balance after ' + amt(r.balanceAfter, r.time));
    if (meta.length) head.appendChild(el('span', { 'class': 'meta', text: meta.join(' · ') }));
    var foot = el('div', { 'class': 'txfoot' }, [el('span', { 'class': 'mono', text: r.txid }), copyBtn(r.txid, 'the transaction id'),
      el('a', { href: 'workspace.html?q=' + encodeURIComponent(r.txid), text: 'Open in workspace ↗' }),
      el('a', { href: explorerOrigin() + '/tx/' + r.txid, target: '_blank', rel: 'noopener noreferrer', text: 'Explorer ↗' })]);
    head.appendChild(pickLabel(r));
    return el('article', { 'class': 'tx ' + r.dir, 'data-txid': r.txid }, [head, el('div', { 'class': 'cols' }, [side(r.inputs, 'in', r.time), side(r.outputs, 'out', r.time)]), foot]);
  }

  function drawLedger() {
    var all = state.led.rows, rows = visibleRows(), box = $('ledger'); box.textContent = '';
    rows.slice(0, state.shown).forEach(function (r) { box.appendChild(txCard(r)); });
    if (rows.length > state.shown) box.appendChild(el('button', { type: 'button', id: 'showMore', 'class': 'moreRows', text: 'Show ' + Math.min(SHOW, rows.length - state.shown) + ' more (' + (rows.length - state.shown) + ' not shown)',
                                                                 onclick: function () { state.shown += SHOW; drawLedger(); } }));
    if (!rows.length) box.appendChild(el('p', { 'class': 'hint', text: !all.length ? 'No transactions yet.' : filtersOn() ? 'None of the loaded transactions match. Change the search or the limits, or Load all.' : 'None of the loaded transactions are like that. Load more, or choose All.' }));
    Array.prototype.forEach.call($('dirSeg').querySelectorAll('button'), function (b) {
      var d = b.getAttribute('data-dir'), n = W.filterRows(all, filterSpec(d)).length;
      b.setAttribute('aria-checked', String(state.dir === d));
      b.textContent = (d === 'in' ? '↓ In ' : d === 'out' ? '↑ Out ' : 'All ') + n;
    });
    var on = filtersOn();
    $('fClear').hidden = !on; $('fCount').textContent = on || state.dir !== 'all' ? rows.length + ' of ' + all.length + ' loaded match' : '';
    var total = totalTxs();
    $('loaded').textContent = all.length + ' of ' + total + ' loaded';
    var more = $('more');
    more.disabled = state.busy || state.done;
    more.textContent = state.done ? 'All loaded' : state.busy ? 'Loading…' : 'Load ' + PAGE + ' more';
    $('loadAll').disabled = state.busy || state.done; $('loadCap').disabled = state.busy || state.done; $('exportAll').disabled = state.busy || state.done;
    Array.prototype.forEach.call($('exportMenu').querySelectorAll('[data-export]'), function (b) { b.disabled = !all.length; });
    $('ledgerSec').hidden = false;
    updatePickBar();
  }

  function redraw() {
    state.led = W.ledger(state.addr, state.txs, { known: known, balance: W.summary(state.stats).balance });
    drawSummary(); drawChart(); drawAssoc(); drawCounterparties(); drawCluster(); drawLedger();
    $('source').textContent = 'Data: ' + A.hostOf(state.client.base) + (state.client.backup ? ' (backup ' + A.hostOf(state.client.backup.base) + ')' : '') + ' · ' + plural(state.client.total.network, 'request') + ' so far. Names come from the built-in list and the label lists saved by the workspace.';
  }

  // ---- amounts: Bitcoin, and in a currency when you chose one (the choice is the workspace's, and is saved for both) -----------------
  function fiatCtx() { return { books: state.books, today: state.today, fmtTime: S.fmtTime }; }
  function fiatOn() { return state.fiat.currency !== 'off'; }
  function fx(sats, time) { return fiatOn() ? PR.amountOf(state.fiat, sats, time, fiatCtx()) : null; }
  /** What a holding is worth now, whatever price moment was chosen: a balance is valued at today's price. */
  function fxNow(sats) { return fiatOn() ? PR.amountOf({ currency: state.fiat.currency, basis: 'today' }, sats, null, fiatCtx()) : null; }
  /** The value of a sum of amounts that each have their own moment, as { value, approx, text, title }; fn(add) calls add(sats, time) for each. Null when a price is missing. */
  function fxSum(fn) {
    var cur = state.fiat.currency, ctx = fiatCtx(), sum = 0, approx = false, ok = true;
    fn(function (sats, time) {
      if (!ok || !sats) return;
      var r = PR.rateFor(state.fiat, time, ctx); if (!r) { ok = false; return; }
      sum += PR.convert(sats, r.price); approx = approx || r.approx;
    });
    return ok ? sumResult(sum, approx) : null;
  }
  function sumResult(sum, approx) {
    var b = state.fiat.basis;
    return { value: sum, approx: approx, text: (approx ? '≈ ' : '') + PR.format(sum, state.fiat.currency),
             title: b === 'today' ? 'Each amount converted at today\'s price' : b === 'ref' ? 'Each amount converted at the price of the moment chosen in the workspace' : 'Each amount converted at the price of its own transaction, then added up' };
  }
  /** What the loaded transactions moved with each of the wallets in `wanted`: Map(address -> { inV (what they paid in), outV (what they received), approx }), in the currency. Empty when prices are missing. */
  function fxByWallet(wanted) {
    var out = new Map(); if (!fiatOn() || !wanted.size) return out;
    var ctx = fiatCtx(), ok = true;
    state.led.rows.forEach(function (r) {
      if (!ok) return;
      var rate = PR.rateFor(state.fiat, r.time, ctx); if (!rate) { ok = false; return; }
      function add(x, key) {
        if (!x.address || !wanted.has(x.address)) return;
        var e = out.get(x.address); if (!e) { e = { inV: 0, outV: 0, approx: false }; out.set(x.address, e); }
        e[key] += PR.convert(x.value, rate.price); e.approx = e.approx || rate.approx;
      }
      r.inputs.forEach(function (x) { add(x, 'inV'); }); r.outputs.forEach(function (x) { add(x, 'outV'); });
    });
    return ok ? out : new Map();
  }
  /** A value in the currency as an amount object, for what was added up by hand: { text, title, approx }. */
  function fxValue(value, approx) { return value == null ? null : sumResult(value, approx); }
  /** An amount as text following the choice: Bitcoin, Bitcoin and the currency, or the currency alone (Bitcoin where the price is not there). x is what fx() gave, or null. */
  function mix(sats, x) {
    var b = btc(sats), mode = state.fiat.show;
    if (!x) return b;
    return mode === 'fiat' ? x.text : mode === 'both' ? b + ' · ' + x.text : b;
  }
  function amt(sats, time) { return mix(sats, fx(sats, time)); }
  /** One of the summary figures: Bitcoin with the currency under it, the currency alone with the note under it, or Bitcoin alone. `note` says which price was used when that is not the amount's own moment. */
  function setAmount(box, sats, x, note) {
    var mode = x ? state.fiat.show : 'btc';
    box.textContent = ''; box.title = x ? x.title : '';
    if (mode !== 'fiat') box.appendChild(document.createTextNode(btc(sats)));
    if (mode === 'both') box.appendChild(el('small', { text: x.text + (note ? ' ' + note : '') }));
    else if (mode === 'fiat') { box.appendChild(document.createTextNode(x.text)); if (note) box.appendChild(el('small', { text: note })); }
  }
  /**
   * The value of everything the wallet ever received or sent. That has no single moment: a fixed price (today, or the moment chosen in the workspace) converts the total as it is;
   * "each transaction's own time" adds up the transactions one by one, which is the whole history only when all of it is loaded. Until then today's price stands in, and says so.
   * Returns { x, note } or null.
   */
  function fxTotal(sats, key) {
    if (!fiatOn()) return null;
    var f = state.fiat;
    if (f.basis === 'each') {
      if (historyComplete()) { var s = fxSum(function (add) { state.led.rows.forEach(function (r) { if (r.confirmed) add(r[key], r.time); }); }); return s ? { x: s, note: '' } : null; }
      var n = fxNow(sats); if (!n) return null;
      return { x: { text: n.text, approx: n.approx, title: n.title + '. Load the whole history to price each transaction at its own time.' }, note: 'at today\'s price' };
    }
    var y = fx(sats, null); return y ? { x: y, note: f.basis === 'today' ? 'at today\'s price' : '' } : null;
  }
  /** The same as a small element that says, on hover, which price it used. */
  function amtEl(sats, time, cls) {
    var x = fx(sats, time), s = el('span', { 'class': cls || '', text: amt(sats, time) });
    if (x) s.title = x.title;
    return s;
  }
  function makePriceClient() {
    var base = A.priceBaseFor(choice);
    state.priceClient = base ? new A.Client({ base: base, concurrency: 2, delayMs: 300, timeoutMs: choice.source === 'tor' ? 120000 : 40000, retries: 2, auth: A.authFor(choice) }) : null;
  }
  function setFiatStatus(text, bad) { var s = $('fiatStatus'); s.textContent = text; s.className = 'hint' + (bad ? ' bad' : ''); }
  function saveFiat() {
    try { var cur = JSON.parse(store.get(PREF_KEY) || '{}') || {}; cur.fiat = state.fiat; window.localStorage.setItem(PREF_KEY, JSON.stringify(cur)); } catch (e) { /* no storage: the choice lasts while the page is open */ }
  }
  function syncFiatUi() {
    var f = state.fiat, on = fiatOn();
    $('fiatCur').value = f.currency; $('fiatShow').value = f.show; $('fiatShow').disabled = !on;
    var basis = $('fiatBasis'); basis.disabled = !on;
    var hasRef = Array.prototype.some.call(basis.options, function (o) { return o.value === 'ref'; });
    if (f.ref && !hasRef) basis.appendChild(el('option', { value: 'ref', text: 'at the moment of tx ' + S.shortId(f.ref.txid, 5) + ' (chosen in the workspace)' }));
    basis.value = f.basis;
    if (!on) { setFiatStatus(''); return; }
    if (state.fiatError) { setFiatStatus(state.fiatError, true); return; }
    var td = state.today ? PR.parseToday(state.today, f.currency) : null, book = state.books[f.currency], parts = [];
    if (td) parts.push('1 BTC = ' + PR.format(td.price, f.currency) + ' today');
    if (book && f.basis !== 'today') parts.push('history to ' + S.fmtTime(book.lastTime(), false));
    setFiatStatus('Prices from ' + A.hostOf(A.priceBaseFor(choice) || '') + '. ' + (parts.length ? parts.join(' · ') : 'Not loaded yet.'));
  }
  /** Fetch whatever prices the current choice needs, then draw the amounts again. */
  function ensurePrices() {
    var f = state.fiat; state.fiatError = '';
    if (f.currency === 'off') { syncFiatUi(); if (state.led) redraw(); return Promise.resolve(); }
    var pc = state.priceClient, cur = f.currency, jobs = [];
    if (!pc) { state.fiatError = 'Prices need a mempool-compatible server: choose one in the workspace (Controls, Data source).'; syncFiatUi(); if (state.led) redraw(); return Promise.resolve(); }
    if (!state.today || Date.now() - state.todayAt > 600000) jobs.push(pc.prices().then(function (j) { state.today = j; state.todayAt = Date.now(); }));
    if (f.basis !== 'today' && !state.books[cur]) {
      jobs.push(pc.historicalPrices(cur).then(function (j) {
        var b = new PR.PriceBook(j, cur);
        if (!b.size() && !b.usd.length) throw new Error('the server returned no price history');
        state.books[cur] = b;
      }));
    }
    if (!jobs.length) { syncFiatUi(); if (state.led) redraw(); return Promise.resolve(); }
    setFiatStatus('Loading prices…');
    return Promise.all(jobs).catch(function (e) { state.fiatError = 'Could not load prices: ' + (e && e.message ? e.message : e); })
      .then(function () { syncFiatUi(); if (state.led) redraw(); });
  }
  function wireFiat() {
    PR.CURRENCIES.forEach(function (c) { $('fiatCur').appendChild(el('option', { value: c, text: c })); });
    $('fiatCur').addEventListener('change', function () { state.fiat.currency = this.value; saveFiat(); ensurePrices(); });
    $('fiatShow').addEventListener('change', function () { state.fiat.show = this.value; saveFiat(); syncFiatUi(); if (state.led) redraw(); });
    $('fiatBasis').addEventListener('change', function () { state.fiat.basis = this.value; saveFiat(); ensurePrices(); });
    syncFiatUi();
    if (fiatOn()) ensurePrices();
  }

  // ---- the balance over time -------------------------------------------------------------------------------------
  var chart = { pts: [], sel: -1, w: 0, h: 190 };
  function themeColor(name, fallback) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; }
  /** Everything the server has for this wallet is loaded: the last page was short, or the confirmed ones loaded are as many as the wallet's own count. */
  function historyComplete() { return state.done || state.txs.filter(function (t) { return t.status && t.status.confirmed; }).length >= W.summary(state.stats).txCount; }
  function drawChart() {
    var s = W.balanceSeries(state.led.rows), sec = $('chartSec'), cv = $('chart');
    sec.hidden = !s.points.length; chart.pts = []; chart.sel = -1; $('chartTip').hidden = true; $('chartDot').hidden = true;
    if (!s.points.length) return;
    var P = s.points, t0 = P[0].time, t1 = P[P.length - 1].time;
    if (t1 <= t0) t1 = t0 + 86400;                                                     // all in one moment: give it a day's width
    var lo = Math.min(0, s.start.balance), hi = Math.max(0, s.start.balance), low = s.start.balance, high = s.start.balance, lowAt = s.start.time, highAt = s.start.time;
    P.forEach(function (p) { lo = Math.min(lo, p.balance); hi = Math.max(hi, p.balance); if (p.balance < low) { low = p.balance; lowAt = p.time; } if (p.balance > high) { high = p.balance; highAt = p.time; } });
    if (hi === lo) hi = lo + 1;
    var w = Math.max(280, Math.floor(cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 640)), h = chart.h, dpr = window.devicePixelRatio || 1;
    chart.w = w;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var L = 96, R = 14, T = 12, B = 26, pw = w - L - R, ph = h - T - B;
    function X(t) { return L + (t - t0) / (t1 - t0) * pw; }
    function Y(b) { return T + (1 - (b - lo) / (hi - lo)) * ph; }
    var accent = themeColor('--accent', '#aee7f8'), dim = themeColor('--dim', '#b9a9b9'), grid = themeColor('--line', '#4a3a4a');
    g.font = '11.5px Calibri, "Segoe UI", Arial, sans-serif'; g.textBaseline = 'middle'; g.lineWidth = 1;
    [lo, lo + (hi - lo) / 2, hi].forEach(function (v) {
      var y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
      g.fillStyle = dim; g.textAlign = 'right'; g.fillText(S.fmtBtcShort(Math.round(v)), L - 6, y);
    });
    g.textBaseline = 'top';
    g.textAlign = 'left'; g.fillText(S.fmtTime(t0, false), L, h - B + 7);
    g.textAlign = 'right'; g.fillText(S.fmtTime(P[P.length - 1].time, false), w - R, h - B + 7);
    // the balance is steady between two transactions: a step line, with the area under it lightly filled
    var prev = s.start.balance, path = new Path2D(), fill = new Path2D();
    path.moveTo(X(t0), Y(prev)); fill.moveTo(X(t0), Y(Math.max(lo, 0))); fill.lineTo(X(t0), Y(prev));
    P.forEach(function (p) { path.lineTo(X(p.time), Y(prev)); path.lineTo(X(p.time), Y(p.balance)); fill.lineTo(X(p.time), Y(prev)); fill.lineTo(X(p.time), Y(p.balance)); prev = p.balance; });
    fill.lineTo(X(t1), Y(prev)); fill.lineTo(X(t1), Y(Math.max(lo, 0))); fill.closePath(); path.lineTo(X(t1), Y(prev));
    g.globalAlpha = 0.16; g.fillStyle = accent; g.fill(fill); g.globalAlpha = 1;
    g.strokeStyle = accent; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke(path);
    chart.pts = P.map(function (p) { return { x: X(p.time), y: Y(p.balance), p: p }; });
    if (P.length <= 150) { g.fillStyle = accent; chart.pts.forEach(function (q) { g.beginPath(); g.arc(q.x, q.y, 2.2, 0, 6.2832); g.fill(); }); }
    var note = historyComplete() ? '' : ' Only part of the history is loaded: the balance before it is worked back from today\'s balance. Load all for the whole picture.';
    var text = 'The balance after each of the ' + fmtInt(P.length) + ' confirmed transactions loaded, from ' + S.fmtTime(t0, false) + ' to ' + S.fmtTime(P[P.length - 1].time, false) + '. Highest ' + amt(high, highAt) + ', lowest ' + amt(low, lowAt) + '. Hover for a transaction, click it to find it below.' + note;
    $('chartText').textContent = text; cv.setAttribute('aria-label', 'Balance over time. ' + text);
  }
  function chartNearest(clientX) {
    var cv = $('chart'), x = clientX - cv.getBoundingClientRect().left, pts = chart.pts, lo = 0, hi = pts.length - 1;
    if (!pts.length) return -1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid].x < x) lo = mid; else hi = mid; }
    return Math.abs(pts[lo].x - x) <= Math.abs(pts[hi].x - x) ? lo : hi;
  }
  function chartSelect(i) {
    var tip = $('chartTip'), dot = $('chartDot'), q = chart.pts[i];
    if (!q) { chart.sel = -1; tip.hidden = true; dot.hidden = true; return; }
    chart.sel = i;
    var p = q.p;
    tip.textContent = '';
    tip.appendChild(el('b', { text: S.fmtTimeFull(p.time) }));
    tip.appendChild(el('div', { text: 'Balance after: ' + amt(p.balance, p.time) }));
    tip.appendChild(el('div', { 'class': p.net >= 0 ? 'up' : 'down', text: (p.net >= 0 ? '+' : '−') + amt(Math.abs(p.net), p.time) }));
    tip.appendChild(el('div', { 'class': 'mono small', text: S.shortId(p.txid, 8) + (p.height != null ? ' · block ' + p.height : '') }));
    tip.hidden = false; dot.hidden = false;
    dot.style.left = q.x + 'px'; dot.style.top = q.y + 'px';
    var tw = tip.offsetWidth || 200;
    tip.style.left = Math.max(4, Math.min(chart.w - tw - 4, q.x + 12)) + 'px'; tip.style.top = Math.max(2, q.y - tip.offsetHeight - 10) + 'px';
  }
  function wireChart() {
    var cv = $('chart');
    cv.addEventListener('mousemove', function (e) { chartSelect(chartNearest(e.clientX)); });
    cv.addEventListener('mouseleave', function () { if (document.activeElement !== cv) chartSelect(-1); });
    cv.addEventListener('click', function (e) { var i = chartNearest(e.clientX); if (i >= 0) { chartSelect(i); focusTx(chart.pts[i].p.txid); } });
    cv.addEventListener('blur', function () { chartSelect(-1); });
    cv.addEventListener('keydown', function (e) {
      var n = chart.pts.length; if (!n) return;
      var i = chart.sel < 0 ? n - 1 : chart.sel;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1); else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Enter' && chart.sel >= 0) { e.preventDefault(); focusTx(chart.pts[chart.sel].p.txid); return; }
      else return;
      e.preventDefault(); chartSelect(i);
    });
    var timer = null;
    window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(function () { if (state.led && Math.abs(($('chart').clientWidth || 0) - chart.w) > 2) drawChart(); }, 120); });
  }
  /** Show one transaction among the cards: take off whatever hides it, draw as many as needed, scroll to it and mark it for a moment. */
  function focusTx(txid) {
    var rows = visibleRows(), i = rows.findIndex(function (r) { return r.txid === txid; });
    if (i < 0) { clearFilters(true); rows = visibleRows(); i = rows.findIndex(function (r) { return r.txid === txid; }); }
    if (i < 0) return false;
    if (i >= state.shown) state.shown = Math.ceil((i + 1) / SHOW) * SHOW;
    drawLedger();
    var card = null; Array.prototype.forEach.call($('ledger').children, function (c) { if (c.getAttribute('data-txid') === txid) card = c; });
    if (!card) return false;
    if (card.scrollIntoView) card.scrollIntoView({ block: 'center' });
    card.classList.add('flash'); setTimeout(function () { card.classList.remove('flash'); }, 2200);
    return true;
  }

  // ---- the biggest counterparties ---------------------------------------------------------------------------------------
  var CP_STEP = 10, CP_MAX = 100;
  function findAddress(a) {
    state.dir = 'all'; $('fText').value = a; onFilter();
    var sec = $('ledgerSec'); if (sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
  }
  function drawCounterparties() {
    var list = W.counterparties(state.led.rows, state.addr, known), box = $('cp'), more = $('cpMore'), note = $('cpNote');
    box.textContent = ''; more.hidden = true; note.hidden = true; $('cpSec').hidden = !list.length;
    if (!list.length) return;
    var top = list[0].volume || 1, n = Math.min(state.cpShown, list.length, CP_MAX);
    var fv = fxByWallet(new Set(list.slice(0, n).map(function (c) { return c.address; })));
    list.slice(0, n).forEach(function (c, i) {
      var nums = [plural(c.txs, 'transaction')], f = fv.get(c.address);
      if (c.asInput) nums.push('paid in ' + mix(c.asInput, f && fxValue(f.inV, f.approx)));
      if (c.asOutput) nums.push('received ' + mix(c.asOutput, f && fxValue(f.outV, f.approx)));
      var bar = el('span', { 'class': 'bar', 'aria-hidden': 'true' }), fillBar = el('i'); fillBar.style.width = Math.max(2, Math.round(c.volume / top * 100)) + '%'; bar.appendChild(fillBar);
      box.appendChild(el('div', { 'class': 'cprow' + (c.sanctions ? ' sanctioned' : ''), 'data-address': c.address }, [
        el('span', { 'class': 'rank', text: String(i + 1) }),
        el('div', { 'class': 'cpwho' }, [c.label ? el('span', { 'class': 'lbl', title: nameTip(c), text: c.label }) : null, c.category ? el('span', { 'class': 'chip dim', text: c.category }) : null,
                                         c.pack ? el('span', { 'class': 'chip dim', text: c.pack }) : null, c.sanctions ? el('span', { 'class': 'chip bad', text: 'sanctions list' }) : null,
                                         el('a', { 'class': 'mono', href: walletHref(c.address), text: c.address })]),
        el('span', { 'class': 'nums', text: nums.join(' · ') }),
        el('span', { 'class': 'vol', text: mix(c.volume, f && fxValue(f.inV + f.outV, f.approx)) }), bar,
        el('button', { type: 'button', 'class': 'findbtn', text: 'Transactions', title: 'Show only the loaded transactions that involve this wallet', onclick: function () { findAddress(c.address); } })]));
    });
    if (list.length > n && n < CP_MAX) {
      more.hidden = false; more.textContent = 'Show ' + Math.min(CP_STEP, list.length - n, CP_MAX - n) + ' more (' + fmtInt(list.length - n) + ' not shown)';
    } else if (list.length > n) { note.hidden = false; note.textContent = 'The biggest ' + CP_MAX + ' of ' + fmtInt(list.length) + ' wallets are shown. Search the transactions below for the others.'; }
  }

  // ---- trace from here: tick transactions, then open the workspace with the wallet and those ----------------------------------------
  var PICK_MAX = 9;                                                                    // the workspace starts from ten places at a time: the wallet and nine more
  function pickLabel(r) {
    var box = el('input', { type: 'checkbox', 'data-pick': r.txid, 'aria-label': 'Trace from transaction ' + S.shortId(r.txid, 6) });
    box.checked = state.picked.indexOf(r.txid) >= 0;
    box.addEventListener('change', function () {
      var at = state.picked.indexOf(r.txid);
      if (box.checked && at < 0) {
        if (state.picked.length >= PICK_MAX) { box.checked = false; message('At most ' + PICK_MAX + ' transactions can be ticked: the workspace starts a trace from ten places at a time, and the wallet is one of them.', true); return; }
        state.picked.push(r.txid);
      } else if (!box.checked && at >= 0) state.picked.splice(at, 1);
      updatePickBar();
    });
    return el('label', { 'class': 'pick', title: 'Tick to start a trace from this transaction' }, [box, ' Trace']);
  }
  function updatePickBar() {
    var bar = $('pickBar'), q = W.traceQuery(state.addr, state.picked, PICK_MAX + 1);
    bar.hidden = !state.picked.length;
    Array.prototype.forEach.call($('ledger').querySelectorAll('input[data-pick]'), function (b) { b.checked = state.picked.indexOf(b.getAttribute('data-pick')) >= 0; });
    if (!state.picked.length) return;
    $('pickText').textContent = plural(q.txids.length, 'transaction') + ' ticked, to be traced together with this wallet.';
    $('pickGo').href = 'workspace.html?q=' + encodeURIComponent(q.query);
  }
  function pickShown() {
    var rows = visibleRows(), added = 0;
    if (!rows.length) { message('Nothing is shown to tick.', true); return; }
    for (var i = 0; i < rows.length && state.picked.length < PICK_MAX; i++) if (state.picked.indexOf(rows[i].txid) < 0) { state.picked.push(rows[i].txid); added++; }
    var left = rows.filter(function (r) { return state.picked.indexOf(r.txid) < 0; }).length;
    updatePickBar();
    message(added ? 'Ticked ' + plural(added, 'transaction') + (left ? '; ' + fmtInt(left) + ' more shown ' + (left === 1 ? 'is' : 'are') + ' not ticked (at most ' + PICK_MAX + ' fit).' : '.')
                  : left ? 'At most ' + PICK_MAX + ' transactions can be ticked.' : 'They are all ticked already.');
  }

  // ---- the whole wallet: addresses spent together ------------------------------------------------------------------------
  var CL_ROUND = 25, CL_BALANCES = 50, CL_SHOW = 12;
  var cl = { extra: new Map(), looked: new Set(), bal: new Map(), running: false, cancel: false, shown: CL_SHOW, last: null };
  function clusterTxs() {
    var all = state.txs.slice(), seen = new Set(all.map(function (t) { return t.txid; }));
    cl.extra.forEach(function (list) { list.forEach(function (t) { if (t && t.txid && !seen.has(t.txid)) { seen.add(t.txid); all.push(t); } }); });
    return all;
  }
  function computeCluster() { return W.cluster(state.addr, clusterTxs(), { isMix: HoplineAnalysis.coinjoinLike }); }
  function clusterOpenHref(members) { return 'workspace.html?q=' + encodeURIComponent(members.slice(0, 10).join(' ')); }
  function drawCluster() {
    var c = computeCluster(), members = c.members, n = members.length; cl.last = c;
    var sec = $('clusterSec'); sec.hidden = false;
    var loaded = fmtInt(state.txs.length), mixes = c.skipped.mix ? ' ' + plural(c.skipped.mix, 'transaction') + ' that ' + (c.skipped.mix === 1 ? 'looks like a CoinJoin was' : 'look like a CoinJoin were') + ' left out.' : '';
    var extra = cl.looked.size ? ' The newest transactions of ' + plural(cl.looked.size, 'other wallet') + ' were loaded as well.' : '';
    $('clIntro').textContent = n === 1 ? 'No other wallet was spent together with this one in the ' + loaded + ' loaded transactions.' + mixes + extra
      : 'This wallet and ' + plural(n - 1, 'other') + ' signed the same transactions (' + plural(c.links.length, 'transaction') + ' joined them), so they are probably one owner.' + mixes + extra;
    var sanc = members.filter(function (a) { var k = known(a); return k && k.sanctions; });
    $('clSanction').hidden = !sanc.length;
    $('clSanction').textContent = sanc.length ? (sanc.length === 1 ? 'One wallet in this group is' : sanc.length + ' wallets in this group are') + ' on a sanctions list. A listing is that list\'s claim: open its source before relying on it.' : '';
    var box = $('clList'); box.textContent = '';
    members.slice(0, cl.shown).forEach(function (a, i) {
      var k = known(a), b = a === state.addr ? W.summary(state.stats).balance : cl.bal.get(a);
      box.appendChild(el('div', { 'class': 'clrow' + (k && k.sanctions ? ' sanctioned' : ''), 'data-address': a }, [
        i === 0 ? el('span', { 'class': 'you', text: 'this wallet' }) : null,
        k ? el('span', { 'class': 'lbl', title: nameTip(k), text: k.label }) : null, k && k.category ? el('span', { 'class': 'chip dim', text: k.category }) : null, k && k.sanctions ? el('span', { 'class': 'chip bad', text: 'sanctions list' }) : null,
        i === 0 ? el('span', { 'class': 'mono', text: a }) : el('a', { 'class': 'mono', href: walletHref(a), text: a }),
        cl.looked.has(a) ? el('span', { 'class': 'hint', text: 'newest transactions loaded' }) : null,
        b != null ? el('span', { 'class': 'nums', title: (fxNow(b) || {}).title || '', text: mix(b, fxNow(b)) }) : null]));
    });
    var more = $('clMore'); more.hidden = n <= cl.shown;
    if (n > cl.shown) more.textContent = 'Show ' + Math.min(50, n - cl.shown) + ' more (' + fmtInt(n - cl.shown) + ' not shown)';
    var withBal = members.filter(function (a) { return a === state.addr || cl.bal.has(a); }), tot = $('clTotal');
    tot.hidden = withBal.length < 2 || n === 1;
    if (!tot.hidden) { var held = withBal.reduce(function (s, a) { return s + (a === state.addr ? W.summary(state.stats).balance : cl.bal.get(a)); }, 0); tot.textContent = 'Together the ' + withBal.length + ' wallets read hold ' + mix(held, fxNow(held)) + (fiatOn() && fxNow(held) ? ' (at today\'s price)' : '') + (withBal.length < n ? ' (' + fmtInt(n - withBal.length) + ' not read yet)' : '') + '.'; }
    var busy = cl.running || state.busy, alone = n === 1;
    $('clLook').disabled = busy || alone; $('clBalances').disabled = busy || alone; $('clCopy').disabled = alone;
    $('clLook').hidden = alone; $('clBalances').hidden = alone; $('clCopy').hidden = alone; $('clOpen').hidden = alone;
    $('clOpen').href = clusterOpenHref(members);
    $('clOpen').textContent = (n > 10 ? 'Open the first 10 in the workspace' : 'Open in workspace') + ' ↗';
  }
  function clBar(text) { $('clBar').hidden = !text; $('clText').textContent = text || ''; }
  /** Walk through some wallets one request at a time, with a line that says how far it is; Cancel stops after the request in flight. */
  function clWalk(list, what, failWhat, fetch, done) {
    var i = 0, reqs = 0; cl.running = true; cl.cancel = false; drawCluster();
    function fin(note, bad) { cl.running = false; clBar(''); drawCluster(); if (note) message(note, !!bad); else if (done) done(); }   // done() runs only when it ended without a stop or a failure
    (function step() {
      if (cl.cancel) return fin('Stopped after ' + plural(reqs, 'request') + '.');
      if (i >= list.length) return fin('');
      var a = list[i++]; clBar(what + ': ' + (i) + ' of ' + list.length + ' (' + plural(reqs, 'request') + ' so far)');
      fetch(a).then(function () { reqs++; step(); }, function (e) { fin('Could not ' + failWhat + ' ' + S.shortId(a, 8) + ': ' + (e && e.message ? e.message : e) + '. What was loaded so far is kept.', true); });
    }());
  }
  function lookFurther() {
    if (cl.running || !cl.last) return;
    var before = cl.last.members.length, list = cl.last.members.filter(function (a) { return a !== state.addr && !cl.looked.has(a); }).slice(0, CL_ROUND);
    if (!list.length) { message('The newest transactions of every wallet in this group are loaded already.'); return; }
    clWalk(list, 'Loading transactions', 'load the transactions of', function (a) { return state.client.addressTxs(a).then(function (txs) { cl.extra.set(a, txs); cl.looked.add(a); }); }, function () {
      var now = computeCluster().members.length;
      message('Looked at ' + plural(list.length, 'wallet') + ': the group ' + (now > before ? 'grew from ' + before + ' to ' + now + ' wallets.' : 'did not grow (' + now + ' wallets).'));
    });
  }
  function readBalances() {
    if (cl.running || !cl.last) return;
    var list = cl.last.members.filter(function (a) { return a !== state.addr && !cl.bal.has(a); }).slice(0, CL_BALANCES);
    if (!list.length) { message('Every wallet in this group has been read already.'); return; }
    clWalk(list, 'Reading balances', 'read the balance of', function (a) { return state.client.address(a).then(function (st) { cl.bal.set(a, W.summary(st).balance); }); }, function () {
      message('Read ' + plural(list.length, 'balance') + '.');
    });
  }
  function wireCluster() {
    $('clLook').addEventListener('click', lookFurther);
    $('clBalances').addEventListener('click', readBalances);
    $('clCancel').addEventListener('click', function () { cl.cancel = true; $('clText').textContent = 'Stopping after this request…'; });
    $('clMore').addEventListener('click', function () { cl.shown += 50; drawCluster(); });
    $('clCopy').addEventListener('click', function () { if (cl.last) copy(cl.last.members.join(NL), plural(cl.last.members.length, 'address', 'addresses')); });
  }

  // ---- finding things in what is loaded -------------------------------------------------------------------------
  var SHOW = 100;                                                                      // cards drawn at once; the rest are one button away
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function utcStart(v) { var t = v ? Date.parse(v + 'T00:00:00Z') / 1000 : NaN; return isFinite(t) ? t : null; }
  function utcEnd(v) { var t = v ? Date.parse(v + 'T23:59:59Z') / 1000 : NaN; return isFinite(t) ? t : null; }
  function satsOf(v) { var x = parseFloat(String(v).replace(',', '.')); return isFinite(x) && x >= 0 ? Math.round(x * 1e8) : null; }
  function readFilters() {
    state.f = { text: $('fText').value, from: utcStart($('fFrom').value), to: utcEnd($('fTo').value), min: satsOf($('fMin').value), max: satsOf($('fMax').value) };
  }
  function filtersOn() { var f = state.f; return !!(f.text.trim() || f.from != null || f.to != null || f.min != null || f.max != null); }
  function filterSpec(dir) { var f = state.f; return { dir: dir || state.dir, text: f.text, from: f.from, to: f.to, minSats: f.min, maxSats: f.max }; }
  /** The loaded transactions that match the direction and the search, the dates and the amounts. */
  function visibleRows() { return W.filterRows(state.led.rows, filterSpec()); }
  function onFilter() { readFilters(); state.shown = SHOW; if (state.led) drawLedger(); }
  var filterTimer = null;
  function wireFilters() {
    $('fText').addEventListener('input', function () { clearTimeout(filterTimer); filterTimer = setTimeout(onFilter, 150); });
    ['fFrom', 'fTo', 'fMin', 'fMax'].forEach(function (id) { $(id).addEventListener('change', onFilter); });
    $('fMin').addEventListener('input', function () { clearTimeout(filterTimer); filterTimer = setTimeout(onFilter, 250); });
    $('fMax').addEventListener('input', function () { clearTimeout(filterTimer); filterTimer = setTimeout(onFilter, 250); });
    $('fClear').addEventListener('click', function () { clearFilters(); });
  }
  /** Empty the search and the limits; with `andDirection` the All/In/Out choice goes back to All as well. */
  function clearFilters(andDirection) {
    $('fText').value = ''; $('fFrom').value = ''; $('fTo').value = ''; $('fMin').value = ''; $('fMax').value = '';
    if (andDirection) state.dir = 'all';
    onFilter();
  }

  // ---- loading the whole history ----------------------------------------------------------------------------------------
  var allLoad = { running: false, cancel: false };
  function totalTxs() { var s = W.summary(state.stats); return s.txCount + s.pendingCount; }
  function capValue() { var n = Math.round(Number($('loadCap').value)); return isFinite(n) ? Math.max(PAGE, Math.min(50000, n)) : 1000; }
  /** Fetch the rest of the history a page at a time, with a line that says how far it is, up to the limit; Cancel stops after the page in flight. then() runs when it ended well. */
  function loadAll(then) {
    if (state.busy || state.done || allLoad.running || !state.led) return;
    var cap = capValue(), start = state.txs.length, reqs = 0;
    allLoad.running = true; allLoad.cancel = false; state.busy = true; drawLedger();
    $('allBar').hidden = false;
    function progress() { $('allText').textContent = 'Loading the whole history: ' + fmtInt(state.txs.length) + ' of ' + fmtInt(totalTxs()) + ' transactions · ' + plural(reqs, 'request'); }
    function finish(note, bad) {
      allLoad.running = false; state.busy = false; $('allBar').hidden = true; redraw();
      message(note || 'Loaded ' + plural(state.txs.length - start, 'more transaction') + (state.done ? ': the whole history is here.' : '.'), !!bad);
      if (!bad && !note && then) then();
    }
    progress();
    (function step() {
      if (allLoad.cancel) return finish('Stopped: ' + fmtInt(state.txs.length) + ' of ' + fmtInt(totalTxs()) + ' transactions are loaded.');
      var cursor = lastChainTxid();
      if (state.done || !cursor) return finish();
      if (state.txs.length >= cap) return finish('Stopped at the limit of ' + fmtInt(cap) + ' transactions: ' + fmtInt(state.txs.length) + ' of ' + fmtInt(totalTxs()) + ' are loaded. Raise "up to" and press Load all again for more.');
      state.client.addressTxs(state.addr, cursor).then(function (list) {
        reqs++; addPage(list, false); progress();
        if (reqs % 8 === 0) redraw();                                                  // now and then, so the page does not sit still for minutes
        step();
      }, function (e) { finish('Could not load the rest: ' + (e && e.message ? e.message : e) + '. ' + fmtInt(state.txs.length) + ' transactions are loaded.', true); });
    }());
  }

  // ---- loading -------------------------------------------------------------------------------------------
  function lastChainTxid() {
    for (var i = state.txs.length - 1; i >= 0; i--) if (state.txs[i].status && state.txs[i].status.confirmed) return state.txs[i].txid;
    return null;
  }
  function addPage(list, first) {
    var seen = new Set(state.txs.map(function (t) { return t.txid; })), chain = 0, at = Math.floor(Date.now() / 1000), source = state.client.sourceOf(list);
    list.forEach(function (t) { if (t.status && t.status.confirmed) chain++; if (!seen.has(t.txid)) { state.txs.push(t); seen.add(t.txid); state.fetched.set(t.txid, { at: at, source: source }); } });
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
    }, window.HOPLINE_WAIT_MS || 20000);
    return Promise.all([state.client.address(state.addr), state.client.addressTxs(state.addr)]).then(function (r) {
      clearTimeout(waitTimer);
      state.stats = r[0]; state.txs = []; state.done = false;
      state.fetched = new Map(); state.statsAt = Math.floor(Date.now() / 1000); state.statsSource = state.client.sourceOf(r[0]);
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

  // ---- export: the transactions as CSV, as a workspace file, or as a report ------------------------------------------------------------
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime }), a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function fileName(ext, what) { return 'hopline-wallet-' + (what ? what + '-' : '') + state.addr.slice(0, 12) + '.' + ext; }

  function exportCsv(rows) {
    var cur = state.fiat.currency, opts = {};
    if (fiatOn()) opts = { currency: cur, fiat: function (sats, time) { var x = fx(sats, time); return x ? { value: PR.plain(x.value, cur), price: String(Math.round(x.rate.price * 100) / 100) } : null; } };
    download(fileName('csv'), String.fromCharCode(0xFEFF) + W.csv(rows, opts), 'text/csv;charset=utf-8');
  }

  /** The loaded transactions behind `rows`, as a graph the workspace can open. */
  function exportGraph(rows) {
    var want = new Set(rows.map(function (r) { return r.txid; }));
    return W.graphOf(state.addr, state.txs.filter(function (t) { return want.has(t.txid); }), { stats: state.stats, at: state.statsAt, source: state.statsSource, fetched: state.fetched });
  }
  function exportJson(rows) { download(fileName('json'), IO.toJson(exportGraph(rows), { source: state.client.base }), 'application/json'); }

  /** What the report covers, in words: the whole history, the part that is loaded, or the part the search and limits showed. */
  function scopeText(n, only) {
    var wallet = 'the wallet ' + state.addr, all = ' The wallet has ' + fmtInt(totalTxs()) + ' in all.';
    if (only) return 'This is ' + plural(n, 'transaction') + ' of ' + wallet + ': the ones the search and limits showed among the ' + fmtInt(state.txs.length) + ' loaded on the wallet page.' + all;
    if (historyComplete()) return 'This is the whole history of ' + wallet + ': ' + plural(n, 'transaction') + '.';
    return 'This is ' + plural(n, 'transaction') + ' of ' + wallet + ': the ones loaded on the wallet page when the report was made.' + all;
  }
  /** What each label pack that is switched on says about itself, for the report's list of where names came from. */
  function reportPacks() {
    return PK.active(shipped, imported).concat(imported.filter(function (p) { return p.enabled; })).map(function (p) {
      return { name: p.name, source: p.source || '', licence: p.licence || '', attribution: p.attribution || '', asOf: p.asOf || '' };
    });
  }
  function exportReport(rows, only) {
    var g = exportGraph(rows), an = AN.analyse(g, { known: function (a) { return !!known(a); } }), found = RP.analysisFor(an, function () { return true; });
    var title = LB.cleanText($('reportTitle').value, 120) || 'Hopline wallet report', by = LB.cleanText($('reportBy').value, 80), source = state.client.base;
    var base = JSON.parse(IO.toJson(g, { source: source })), loaded = base.nodes.filter(function (n) { return n.type === 'tx' && n.loaded; }).length;
    base.evidence = { generatedBy: 'Hopline wallet', title: title, preparedBy: by, generated: new Date().toISOString(), source: source, fiat: state.fiat,
                      counts: { nodes: base.nodes.length, edges: base.edges.length, transactionsLoaded: loaded },
                      analysis: { transactions: found.tx, chains: found.chains, clusters: found.clusters, skipped: an.clusters.skipped, thresholds: AN.DEFAULTS } };
    var model = { title: title, preparedBy: by, generated: Date.now(), evidence: base, nodes: base.nodes, edges: base.edges, analysis: { tx: found.tx, chains: found.chains, clusters: found.clusters, skipped: an.clusters.skipped }, groups: [],
                  known: known, packs: reportPacks(), fiat: fiatOn() ? function (s, t) { var x = fx(s, t); return x ? x.text : ''; } : null, fiatNote: PR.note(state.fiat, S.fmtTimeFull),
                  image: null, fingerprint: function (n) { var f = AN.fingerprint(n); return f ? f.text : ''; }, madeWith: 'Hopline wallet', scopeText: scopeText(loaded, only) };
    return RP.build(model).then(function (r) {
      download(fileName('html', 'report'), r.html, 'text/html;charset=utf-8');
      message('Report written: ' + plural(loaded, 'transaction') + '. SHA-256 of its evidence: ' + r.hash.slice(0, 16) + '…');
    }, function (e) { message('The report could not be made: ' + (e && e.message ? e.message : e), true); });
  }

  /** kind: 'csv', 'json' or 'report'. With "Load the whole history first" the rest is loaded before anything is written. */
  function doExport(kind) {
    $('exportMenu').open = false;
    if (state.busy || allLoad.running) { message('Wait until loading has finished, then export.', true); return; }
    if (!state.led || !state.led.rows.length) { message('Nothing to export yet.', true); return; }
    function run() {
      var only = $('exportShown').checked, rows = only ? visibleRows() : state.led.rows;
      if (!rows.length) { message('No loaded transaction is shown, so there is nothing to export. Clear the search and limits, or untick "Only the transactions shown".', true); return; }
      if (window.HoplineStats) window.HoplineStats.hit('wallet-' + kind);
      if (kind === 'csv') exportCsv(rows); else if (kind === 'json') exportJson(rows); else exportReport(rows, only);
    }
    if ($('exportAll').checked && !state.done) loadAll(run); else run();
  }

  function showQR() {
    var f = $('qrfloat'); f.textContent = ''; f.hidden = false;
    try { new QRCode(f, { text: state.addr, width: 160, height: 160 }); } catch (e) { f.hidden = true; }
  }
  function hideQR() { $('qrfloat').hidden = true; }

  function init() {
    var packsReady = loadShipped();
    makePriceClient(); wireFiat();
    state.client = A.buildClient(choice, {
      onSwitch: function (i) { state.switched = A.hostOf(i.from) + ' did not answer well, so ' + A.hostOf(i.to) + ' was used.'; message(state.switched); }
    });
    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); open($('q').value); });
    $('more').addEventListener('click', more);
    $('loadAll').addEventListener('click', function () { loadAll(); });
    $('allCancel').addEventListener('click', function () { allLoad.cancel = true; $('allText').textContent = 'Stopping after this page…'; });
    wireFilters(); wireChart(); wireCluster();
    $('cpMore').addEventListener('click', function () { state.cpShown += CP_STEP; drawCounterparties(); });
    $('pickShown').addEventListener('click', pickShown);
    $('pickClear').addEventListener('click', function () { state.picked = []; updatePickBar(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), function (b) { b.addEventListener('click', function () { doExport(b.getAttribute('data-export')); }); });
    $('copyAddr').addEventListener('click', function () { if (state.addr) copy(state.addr, 'the address'); });
    Array.prototype.forEach.call($('dirSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { state.dir = b.getAttribute('data-dir'); if (state.led) drawLedger(); }); });
    var addr = $('addr');
    addr.addEventListener('mouseenter', showQR); addr.addEventListener('mouseleave', hideQR); addr.addEventListener('focus', showQR); addr.addEventListener('blur', hideQR);
    var q = qs.get('q');
    $('sample').addEventListener('click', function () {
      var stats = window.HoplineStats, go = function () { window.location.href = walletHref(SAMPLE); };
      if (stats && stats.enabled) { stats.hit('sample-wallet'); setTimeout(go, 150); }                 // a page that is left at once may cancel the count that was just sent
      else go();
    });
    if (!q) { $('empty').hidden = false; return; }
    $('q').value = q;
    var c = A.checkQuery(q);
    if (!c.ok) { message(c.message, true); return; }
    if (c.kind === 'tx') { window.location.replace('workspace.html?q=' + encodeURIComponent(c.value)); return; }
    state.addr = c.value;
    packsReady.then(load);                                                        // so the first drawing already knows the names on the built-in lists
  }

  window.addEventListener('unhandledrejection', function (ev) { showFailure('Something went wrong', ev.reason, null); });
  window.__wallet = { state: state, known: known, chart: chart, cluster: cl };                                  // read by the end-to-end tests
  function boot() { init(); window.__booted = true; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());
