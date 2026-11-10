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
    var exp = $('explorerLink'), origin = explorerOrigin();                                                   // the block explorer of the chosen data source (mempool.space unless another was chosen)
    exp.href = origin + '/address/' + a; exp.hidden = false;
    exp.title = 'Opens this wallet on ' + A.hostOf(origin) + ' in a new tab. That site is told which wallet you are looking at.';
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
    drawFlow(W.flow(state.led.rows));
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

  /**
   * From others / To others: the totals above without the wallet's own change. Shown only when there is some (a wallet that never paid itself change has nothing to take out). The two are worked out
   * from the transactions that are loaded, so until the whole history is here they say so: the totals above are the address's own, for all of it.
   */
  function drawFlow(fl) {
    var show = fl.own > 0, complete = historyComplete();
    $('sFromRow').hidden = $('sToRow').hidden = $('sFlowHint').hidden = !show;
    if (!show) return;
    var fo = fxOthers(fl.fromOthers, 'from'), to = fxOthers(fl.toOthers, 'to');
    setAmount($('sFrom'), fl.fromOthers, fo && fo.x, fo && fo.note);
    setAmount($('sTo'), fl.toOthers, to && to.x, to && to.note);
    if (!complete) [$('sFrom'), $('sTo')].forEach(function (b) { b.appendChild(el('small', { text: 'in the ' + plural(fl.count, 'loaded transaction') })); });
    $('sFlowHint').textContent = btc(fl.own) + ' of what this wallet received and of what it sent is its own change: it was spent in ' + plural(fl.ownTxs, 'transaction')
      + ' that paid it back to the same wallet, so the totals count it both ways. From others and To others leave it out: what other wallets paid it, and what it paid out, fees included.'
      + (complete ? '' : ' They are worked out from the ' + plural(fl.count, 'confirmed transaction') + ' loaded so far: Load all for the whole history.');
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
  /**
   * The value of what others paid the wallet (which = 'from') or what it paid them ('to'): a fixed price converts the figure as it is, "each transaction's own time" adds up the loaded transactions one by one
   * (the figure is made of those same transactions, so that is exact even before the whole history is here). Returns { x, note } or null.
   */
  function fxOthers(sats, which) {
    if (!fiatOn()) return null;
    var f = state.fiat;
    if (f.basis === 'each') { var s = fxSum(function (add) { state.led.rows.forEach(function (r) { if (r.confirmed) add(W.rowOthers(r)[which], r.time); }); }); return s ? { x: s, note: '' } : null; }
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
  // key is the period shown: 'all', or '1m' / '6m' / '1y' counted back from the newest transaction loaded, or 'custom' (a dragged or pinched selection, kept in view = { from, to });
  // follow: the From and To dates of the list choose the period instead. pts, buckets, xticks and yticks are what is on the chart (the end-to-end tests read them).
  var chart = { pts: [], sel: -1, w: 0, h: 260, key: 'all', view: null, follow: false, drag: null, swallow: false, xticks: [], yticks: [], buckets: [], unit: '', strip: null, fiat: false,
                L: 0, T: 0, pw: 0, ph: 0, from: 0, to: 0, bounds: { from: 0, to: 0 } };
  // what is kept for the chart in this browser: the bars of what came in and went out, and loading the whole history by itself (kept apart from the workspace's settings, which it rewrites)
  var WPREF_KEY = 'hopline.walletchart.v1', wprefs = { auto: true, bars: true }, AUTO_MAX = 250, BAR_H = 64, BAR_GAP = 14, UP = '#6be675', DOWN = '#ff9f43';
  try { var wp = JSON.parse(store.get(WPREF_KEY) || '{}') || {}; wprefs.auto = wp.auto !== false; wprefs.bars = wp.bars !== false; } catch (e) { /* nothing saved: both are on */ }
  function saveWprefs() { try { window.localStorage.setItem(WPREF_KEY, JSON.stringify(wprefs)); } catch (e) { /* no storage: the choice lasts while the page is open */ } }
  function themeColor(name, fallback) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; }
  var rgbOf = {};
  /** A colour of the theme (in whatever form it is written) with an opacity, for a fade. */
  function colorAlpha(color, a) {
    try {
      if (!rgbOf[color]) {
        var c = document.createElement('canvas'); c.width = c.height = 1;
        var x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 1, 1);
        var d = x.getImageData(0, 0, 1, 1).data; rgbOf[color] = d[0] + ',' + d[1] + ',' + d[2];
      }
      return 'rgba(' + rgbOf[color] + ',' + a + ')';
    } catch (e) { return color; }
  }
  /** Everything the server has for this wallet is loaded: the last page was short, or the confirmed ones loaded are as many as the wallet's own count. */
  function historyComplete() { return state.done || state.txs.filter(function (t) { return t.status && t.status.confirmed; }).length >= W.summary(state.stats).txCount; }
  /** The period the chart shows, { from, to, zoomed, following } in unix seconds: within the loaded transactions, except that the From and To dates may reach beyond them. */
  function chartWindow(s) {
    var P = s.points, t0 = P[0].time, last = P[P.length - 1].time, t1 = last <= t0 ? t0 + 86400 : last;   // all in one moment: give it a day's width
    chart.bounds = { from: t0, to: t1 };
    if (chart.follow && (state.f.from != null || state.f.to != null)) {
      var a = state.f.from != null ? state.f.from : t0, b = state.f.to != null ? state.f.to : t1;
      return { from: a, to: b <= a ? a + 86400 : b, zoomed: true, following: true };
    }
    var win = chart.key === 'custom' ? chart.view : W.presetWindow(chart.key, last);
    if (win) {
      var from = Math.max(t0, win.from), to = Math.min(t1, win.to);
      if (to - from >= 60) return { from: from, to: to, zoomed: from > t0 || to < t1, following: false };
    }
    return { from: t0, to: t1, zoomed: false, following: false };
  }
  /** A number for the edge of the bars: bare (the unit is on the axis above), short. */
  function bareAmt(v, fiatPlot, inSat) {
    if (fiatPlot) return fiatShort(v);
    if (inSat) return fmtInt(Math.round(v));
    return String(Number((v / 1e8).toPrecision(2)).toFixed(8)).replace(/0+$/, '').replace(/\.$/, '');
  }
  function drawChart() {
    var s = W.balanceSeries(state.led.rows), sec = $('chartSec'), cv = $('chart');
    sec.hidden = !s.points.length; chart.pts = []; chart.xticks = []; chart.yticks = []; chart.buckets = []; chart.strip = null; chartSelect(-1);
    if (!s.points.length) { chartBanner(); return; }
    var win = chartWindow(s), ws = W.windowSeries(s, win.from, win.to), P = ws.points, a = win.from, b = win.to;
    // In the currency alone (Show: the currency), the curve is the value of the balance after each transaction at the price chosen for that moment, and so is the axis; if a price is
    // missing anywhere it stays in Bitcoin and says so. With Bitcoin, or Bitcoin and the currency, the curve is in Bitcoin and the tooltip carries the currency.
    var wantFiat = fiatOn() && state.fiat.show === 'fiat', fiatPlot = wantFiat && [{ balance: ws.start.balance, time: ws.start.at }].concat(P).every(function (q) { return !!fx(q.balance, q.time); });
    chart.fiat = fiatPlot;
    function pv(bal, t) { return fiatPlot ? fx(bal, t).value : bal; }
    var v0 = pv(ws.start.balance, ws.start.at), lo = v0, hi = v0, low = v0, high = v0, lowAt = ws.start.at, highAt = ws.start.at, lowS = ws.start.balance, highS = ws.start.balance;
    P.forEach(function (p) {
      var v = pv(p.balance, p.time); lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (v < low) { low = v; lowAt = p.time; lowS = p.balance; } if (v > high) { high = v; highAt = p.time; highS = p.balance; }
    });
    if (!win.zoomed) { lo = Math.min(0, lo); hi = Math.max(0, hi); }                  // the whole history is drawn from nothing; a period is drawn as close as it needs
    if (hi === lo) { if (lo === 0) hi = 1; else { var pad = Math.abs(lo) * 0.05; lo = lo > 0 ? Math.max(0, lo - pad) : lo - pad; hi += pad; } }
    var w = Math.max(280, Math.floor(cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 640)), dpr = window.devicePixelRatio || 1;
    var barsOn = wprefs.bars, h = chart.h + (barsOn ? BAR_H + BAR_GAP : 0);
    chart.w = w;
    cv.style.height = h + 'px'; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var T = 20, B = 28, R = 16, ph = chart.h - T - B;
    var nt = W.niceTicks(lo, hi, Math.max(3, Math.min(7, Math.floor(ph / 42))), { integer: !fiatPlot }); lo = nt.lo; hi = nt.hi;
    var inSat = !fiatPlot && hi < 100000, unit = fiatPlot ? '' : inSat ? 'sat' : 'BTC';
    var dec = Math.max(0, Math.min(8, 8 - Math.floor(Math.log(nt.step) / Math.LN10 + 1e-9)));
    function axisText(v) {
      if (fiatPlot) return fiatShort(v);
      if (inSat) return fmtInt(Math.round(v));
      return (v / 1e8).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    // what came in and what went out in each period, by what each transaction did to the balance (so in minus out is how the balance changed)
    var bars = null, peak = 0;
    if (barsOn) {
      var plan = W.barBuckets(a, b, Math.max(8, Math.floor((w - 100) / 7)));
      chart.unit = plan.unit;
      bars = W.barTotals(s.points, plan.buckets, function (p) { if (!fiatPlot) return p.net; var x = fx(Math.abs(p.net), p.time); return x ? (p.net < 0 ? -1 : 1) * x.value : 0; });
      bars.forEach(function (k) { if (k.to > a && k.from < b) peak = Math.max(peak, k.inn, k.out); });
    }
    var accent = themeColor('--accent', '#aee7f8'), dim = themeColor('--dim', '#b9a9b9'), grid = themeColor('--line', '#4a3a4a');
    g.font = '11.5px Calibri, "Segoe UI", Arial, sans-serif'; g.lineWidth = 1;
    var yText = nt.ticks.map(axisText), edge = peak ? '+' + bareAmt(peak, fiatPlot, inSat) : '';
    var L = Math.ceil(Math.max.apply(null, yText.concat([unit, edge]).map(function (t) { return g.measureText(t).width; }))) + 14, pw = w - L - R;
    chart.L = L; chart.T = T; chart.pw = pw; chart.ph = ph; chart.from = a; chart.to = b;
    var stripTop = T + ph + BAR_GAP, stripBottom = stripTop + BAR_H, axisY = (barsOn ? stripBottom : T + ph);
    function X(t) { return L + (t - a) / (b - a) * pw; }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * ph; }
    // the time axis: round moments, a faint line down from each
    g.textBaseline = 'top';
    W.timeTicks(a, b, Math.max(2, Math.floor(pw / 100))).forEach(function (k) {
      var x = Math.round(X(k.time)) + 0.5, tw = g.measureText(k.label).width;
      g.strokeStyle = grid; g.globalAlpha = 0.45; g.beginPath(); g.moveTo(x, T); g.lineTo(x, axisY + 4); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = dim; g.textAlign = x - tw / 2 < 2 ? 'left' : x + tw / 2 > w - 2 ? 'right' : 'center';
      g.fillText(k.label, g.textAlign === 'left' ? 2 : g.textAlign === 'right' ? w - 2 : x, axisY + 9);
      chart.xticks.push({ x: x, label: k.label });
    });
    // the side axis: round values, a line across at each
    g.textBaseline = 'middle'; g.textAlign = 'right';
    nt.ticks.forEach(function (v, i) {
      var y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
      g.fillStyle = dim; g.fillText(yText[i], L - 8, y);
      chart.yticks.push({ y: y, label: yText[i] });
    });
    if (unit) { g.textAlign = 'right'; g.fillStyle = dim; g.fillText(unit, L - 8, 7); }
    // the balance is steady between two transactions: a step line, with the area under it faded
    var base = Y(Math.max(lo, 0)), prev = v0, path = new Path2D(), fill = new Path2D();
    path.moveTo(X(a), Y(prev)); fill.moveTo(X(a), base); fill.lineTo(X(a), Y(prev));
    P.forEach(function (p) { var v = pv(p.balance, p.time); path.lineTo(X(p.time), Y(prev)); path.lineTo(X(p.time), Y(v)); fill.lineTo(X(p.time), Y(prev)); fill.lineTo(X(p.time), Y(v)); prev = v; });
    fill.lineTo(X(b), Y(prev)); fill.lineTo(X(b), base); fill.closePath(); path.lineTo(X(b), Y(prev));
    var fade = g.createLinearGradient(0, T, 0, T + ph); fade.addColorStop(0, colorAlpha(accent, 0.34)); fade.addColorStop(1, colorAlpha(accent, 0.03));
    g.fillStyle = fade; g.fill(fill);
    g.strokeStyle = accent; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke(path);
    chart.pts = P.map(function (p) { return { x: X(p.time), y: Y(pv(p.balance, p.time)), p: p }; });
    if (P.length <= 150) { g.fillStyle = accent; chart.pts.forEach(function (q) { g.beginPath(); g.arc(q.x, q.y, 2.2, 0, 6.2832); g.fill(); }); }
    // the bars: what came in above the line, what went out below it, on one scale
    if (bars) {
      var mid = stripTop + BAR_H / 2, half = BAR_H / 2 - 3, k = peak ? half / peak : 0;
      chart.strip = { top: stripTop, bottom: stripBottom };
      g.lineWidth = 1; g.strokeStyle = grid; g.beginPath(); g.moveTo(L, Math.round(mid) + 0.5); g.lineTo(w - R, Math.round(mid) + 0.5); g.stroke();
      g.font = '10.5px Calibri, "Segoe UI", Arial, sans-serif'; g.fillStyle = dim; g.textAlign = 'right'; g.textBaseline = 'middle';
      if (peak) { g.fillText(edge, L - 8, stripTop + 6); g.fillText('−' + edge.slice(1), L - 8, stripBottom - 6); }
      bars.forEach(function (bk) {
        var x0 = X(Math.max(bk.from, a)), x1 = X(Math.min(bk.to, b)), bw = x1 - x0;
        if (bw < 0.5 || bk.to <= a || bk.from > b) return;
        var gap = bw > 4 ? 1 : 0, x = x0 + gap / 2, ww = Math.max(1, bw - gap);
        g.globalAlpha = 0.85;
        if (bk.inn) { g.fillStyle = UP; g.fillRect(x, mid - Math.max(1, bk.inn * k), ww, Math.max(1, bk.inn * k)); }
        if (bk.out) { g.fillStyle = DOWN; g.fillRect(x, mid, ww, Math.max(1, bk.out * k)); }
        g.globalAlpha = 1;
        chart.buckets.push({ x0: x0, x1: x1, b: bk });
      });
    }
    var text = !P.length
      ? 'No confirmed transaction from ' + S.fmtTime(a, false) + ' to ' + S.fmtTime(b, false) + ' among the ' + fmtInt(s.points.length) + ' loaded: the balance stayed at ' + amt(ws.start.balance, ws.start.at) + '.'
      : 'The balance after each of the ' + fmtInt(P.length) + ' confirmed transactions ' + (win.zoomed ? 'in this period (of ' + fmtInt(s.points.length) + ' loaded)' : 'loaded') + ', from ' + S.fmtTime(P[0].time, false) + ' to ' + S.fmtTime(P[P.length - 1].time, false)
        + '. Highest ' + amt(highS, highAt) + ', lowest ' + amt(lowS, lowAt) + '. Hover for a transaction, click it to find it below, drag across the chart to zoom in.';
    if (bars) text += ' The bars below show, for each ' + chart.unit + ', what came in (up) and what went out (down): the sum of what its transactions did to the balance. Click a bar to zoom to that ' + chart.unit + '.';
    text += fiatPlot ? ' The axis is in ' + state.fiat.currency + ': the balance after each transaction at ' + (state.fiat.basis === 'today' ? 'today\'s price' : state.fiat.basis === 'ref' ? 'the price of the moment chosen in the workspace' : 'the price of its own moment') + '.'
         : wantFiat ? ' A price is missing for some of these moments, so the chart is in Bitcoin.' : '';
    $('chartText').textContent = text; cv.setAttribute('aria-label', 'Balance over time. ' + text);
    chartBar(win); chartBanner(s.points[0].time);
  }
  /** The period buttons, the dates of the period shown, the way back and the two settings. */
  function chartBar(win) {
    var key = chart.follow ? '' : chart.key === 'custom' ? '' : chart.key;
    Array.prototype.forEach.call($('rangeSeg').querySelectorAll('button'), function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-range') === key)); });
    $('chartFollow').checked = chart.follow; $('chartBars').checked = wprefs.bars; $('chartAuto').checked = wprefs.auto;
    $('chartReset').hidden = !win.zoomed;
    $('chartRange').textContent = win.zoomed ? S.fmtTime(win.from, false) + ' to ' + S.fmtTime(win.to, false) + (win.following ? ' (the From and To dates)' : '') : '';
  }
  /** The line on the chart that says the history is only partly loaded (with the way to load the rest), or how far the loading is. */
  function chartBanner(oldest) {
    var bar = $('chartBanner'), txt = $('chartBannerText'), go = $('chartLoadAll'), stop = $('chartCancel');
    if (!state.led || $('chartSec').hidden) { bar.hidden = true; return; }
    if (allLoad.running) {
      bar.hidden = false; go.hidden = true; stop.hidden = false;
      txt.textContent = 'Loading the whole history: ' + fmtInt(state.txs.length) + ' of ' + fmtInt(totalTxs()) + ' transactions…';
      return;
    }
    stop.hidden = true; go.hidden = false;
    if (historyComplete()) { bar.hidden = true; return; }
    var n = W.balanceSeries(state.led.rows).points.length;
    bar.hidden = false;
    txt.textContent = 'Only the newest ' + fmtInt(n) + ' of ' + fmtInt(W.summary(state.stats).txCount) + ' transactions are loaded: the chart starts on ' + S.fmtTime(oldest != null ? oldest : state.led.rows[state.led.rows.length - 1].time, false)
      + ', and the balance is worked back from today\'s balance.';
    go.disabled = state.busy || state.done;
  }
  /** A value in the chosen currency for an axis: "$12.5K", "¥3.1M"; the full format where the browser cannot abbreviate. */
  function fiatShort(v) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: state.fiat.currency, notation: 'compact', maximumFractionDigits: 1 }).format(v); }
    catch (e) { return PR.format(v, state.fiat.currency); }
  }
  function chartNearest(clientX) {
    var cv = $('chart'), x = clientX - cv.getBoundingClientRect().left, pts = chart.pts, lo = 0, hi = pts.length - 1;
    if (!pts.length) return -1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid].x < x) lo = mid; else hi = mid; }
    return Math.abs(pts[lo].x - x) <= Math.abs(pts[hi].x - x) ? lo : hi;
  }
  /** Is this pointer over the bars of what came in and went out? And which bar (an index into chart.buckets, or -1)? */
  function inStrip(e) { var y = e.clientY - $('chart').getBoundingClientRect().top; return !!chart.strip && y >= chart.strip.top - 4 && y <= chart.strip.bottom + 4; }
  function barAt(clientX) {
    var x = clientX - $('chart').getBoundingClientRect().left;
    for (var i = 0; i < chart.buckets.length; i++) if (x >= chart.buckets[i].x0 && x < chart.buckets[i].x1) return i;
    return -1;
  }
  function chartSelect(i) {
    var tip = $('chartTip'), dot = $('chartDot'), line = $('chartLine'), cv = $('chart'), q = chart.pts[i];
    $('chartBand').hidden = true;
    if (!q) { chart.sel = -1; tip.hidden = true; dot.hidden = true; line.hidden = true; return; }
    chart.sel = i;
    var p = q.p, ox = cv.offsetLeft, oy = cv.offsetTop;
    tip.textContent = '';
    tip.appendChild(el('b', { text: S.fmtTimeFull(p.time) }));
    tip.appendChild(el('div', { text: 'Balance after: ' + amt(p.balance, p.time) }));
    tip.appendChild(el('div', { 'class': p.net >= 0 ? 'up' : 'down', text: (p.net >= 0 ? '+' : '−') + amt(Math.abs(p.net), p.time) }));
    tip.appendChild(el('div', { 'class': 'mono small', text: S.shortId(p.txid, 8) + (p.height != null ? ' · block ' + p.height : '') }));
    tip.hidden = false; dot.hidden = false; line.hidden = false;
    dot.style.left = (ox + q.x) + 'px'; dot.style.top = (oy + q.y) + 'px';
    line.style.left = (ox + Math.round(q.x)) + 'px'; line.style.top = (oy + chart.T) + 'px'; line.style.height = chart.ph + 'px';
    var tw = tip.offsetWidth || 200;
    tip.style.left = Math.max(4, Math.min(ox + chart.w - tw - 4, ox + q.x + 12)) + 'px'; tip.style.top = Math.max(2, oy + q.y - tip.offsetHeight - 10) + 'px';
  }
  /** The name of a bar's period: a day, "Week of 2022-06-06 to 2022-06-12", a month, a year. */
  function bucketName(unit, from, to) {
    var d = function (t) { return S.fmtTime(t, false); };
    return unit === 'hour' ? S.fmtTime(from) : unit === 'day' ? d(from) : unit === 'week' ? 'Week of ' + d(from) + ' to ' + d(to - 1) : unit === 'month' ? d(from).slice(0, 7) : d(from).slice(0, 4);
  }
  function chartAmt(v) { return chart.fiat ? PR.format(v, state.fiat.currency) : btc(v); }
  /** Point at a bar: its period, what came in and went out and how the balance changed, with the period marked. */
  function barSelect(i) {
    var tip = $('chartTip'), band = $('chartBand'), cv = $('chart'), q = chart.buckets[i];
    chartSelect(-1);
    if (!q) return;
    var k = q.b, ox = cv.offsetLeft, oy = cv.offsetTop, net = k.inn - k.out;
    tip.textContent = '';
    tip.appendChild(el('b', { text: bucketName(chart.unit, k.from, k.to) }));
    if (k.ins) tip.appendChild(el('div', { 'class': 'up', text: 'Came in: +' + chartAmt(k.inn) + ' (' + plural(k.ins, 'transaction') + ')' }));
    if (k.outs) tip.appendChild(el('div', { 'class': 'down', text: 'Went out: −' + chartAmt(k.out) + ' (' + plural(k.outs, 'transaction') + ')' }));
    tip.appendChild(el('div', { 'class': 'small', text: k.count ? 'The balance changed by ' + (net < 0 ? '−' : '+') + chartAmt(Math.abs(net)) : 'No transaction' }));
    tip.hidden = false; band.hidden = false;
    band.style.left = (ox + q.x0) + 'px'; band.style.width = Math.max(2, q.x1 - q.x0) + 'px'; band.style.top = (oy + chart.strip.top) + 'px'; band.style.height = (chart.strip.bottom - chart.strip.top) + 'px';
    var tw = tip.offsetWidth || 200;
    tip.style.left = Math.max(4, Math.min(ox + chart.w - tw - 4, ox + (q.x0 + q.x1) / 2 - tw / 2)) + 'px'; tip.style.top = Math.max(2, oy + chart.strip.top - tip.offsetHeight - 6) + 'px';
  }
  /** Show another period: one of the buttons ('1m', '6m', '1y', 'all'), or 'custom' with the period in `view`. The From and To dates stop choosing it. */
  function setRange(key, view) {
    chart.key = key; chart.view = view || null; chart.follow = false;
    if (state.led) drawChart();
  }
  function wireChart() {
    var cv = $('chart');
    cv.addEventListener('mousemove', function (e) {
      if (chart.drag && chart.drag.moved) return;
      if (inStrip(e)) barSelect(barAt(e.clientX)); else chartSelect(chartNearest(e.clientX));
    });
    cv.addEventListener('mouseleave', function () { if (document.activeElement !== cv) chartSelect(-1); });
    cv.addEventListener('click', function (e) {
      if (chart.swallow) { chart.swallow = false; return; }                           // the click that ends a drag is not a click on a point
      if (inStrip(e)) {                                                              // a bar: look at its period
        var j = barAt(e.clientX), k = j >= 0 ? chart.buckets[j].b : null;
        if (k) { var from = Math.max(k.from, chart.bounds.from), to = Math.min(k.to - 1, chart.bounds.to); if (to - from >= 60 && to - from < chart.to - chart.from - 1) setRange('custom', { from: from, to: to }); }
        return;
      }
      var i = chartNearest(e.clientX); if (i >= 0) { chartSelect(i); focusTx(chart.pts[i].p.txid); }
    });
    cv.addEventListener('blur', function () { chartSelect(-1); });
    cv.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && chart.drag) { cancelDrag(); return; }
      var n = chart.pts.length; if (!n) return;
      var i = chart.sel < 0 ? n - 1 : chart.sel;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1); else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Enter' && chart.sel >= 0) { e.preventDefault(); focusTx(chart.pts[chart.sel].p.txid); return; }
      else return;
      e.preventDefault(); chartSelect(i);
    });
    // a mouse drags across the chart to look at that period
    function plotX(e) { return Math.max(chart.L, Math.min(chart.L + chart.pw, e.clientX - cv.getBoundingClientRect().left)); }
    function cancelDrag() { if (chart.drag && chart.drag.moved) chart.swallow = true; chart.drag = null; $('chartSel').hidden = true; }
    // fingers: two pinch (and move together) to zoom and pan the period, one slides a zoomed chart along
    var fingers = new Map(), grip = null, frame = 0, wanted = null;
    function plotPx(clientX) { return clientX - cv.getBoundingClientRect().left - chart.L; }
    function regrip() {
      var ids = [];
      fingers.forEach(function (x, id) { ids.push(id); });
      if (ids.length === 2) {
        ids.sort(function (p, q) { return fingers.get(p) - fingers.get(q); });
        var span = chart.to - chart.from;
        grip = { kind: 'pinch', ids: ids, ta: chart.from + plotPx(fingers.get(ids[0])) / chart.pw * span, tb: chart.from + plotPx(fingers.get(ids[1])) / chart.pw * span };
      } else if (ids.length === 1) grip = { kind: 'pan', id: ids[0], x: fingers.get(ids[0]), from: chart.from, to: chart.to, moved: false };
      else grip = null;
    }
    function showWindow(win) {
      wanted = win;
      if (frame) return;
      frame = (window.requestAnimationFrame || window.setTimeout)(function () {
        frame = 0; var x = wanted; wanted = null; if (!x) return;
        if (x.from <= chart.bounds.from + 1 && x.to >= chart.bounds.to - 1) setRange('all'); else setRange('custom', x);
      });
    }
    cv.addEventListener('pointerdown', function (e) {
      chart.swallow = false;
      if (e.pointerType === 'touch') {
        chart.drag = null; fingers.set(e.pointerId, e.clientX); regrip();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* a browser without it: the fingers still work inside the chart */ }
        return;
      }
      var x = e.clientX - cv.getBoundingClientRect().left;
      if (e.button > 0 || !chart.pw || x < chart.L - 4 || x > chart.L + chart.pw + 4) { chart.drag = null; return; }
      chart.drag = { x0: plotX(e), x1: plotX(e), moved: false, id: e.pointerId };
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* a browser without it: the drag still works inside the chart */ }
    });
    cv.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') {
        if (!fingers.has(e.pointerId) || !grip) return;
        fingers.set(e.pointerId, e.clientX);
        var win = null;
        if (grip.kind === 'pinch') win = W.pinchWindow(grip.ta, grip.tb, plotPx(fingers.get(grip.ids[0])), plotPx(fingers.get(grip.ids[1])), chart.pw, chart.bounds, 3600);
        else {
          var dx = fingers.get(grip.id) - grip.x;
          if (!grip.moved && Math.abs(dx) < 8) return;
          grip.moved = true; win = W.panWindow(grip.from, grip.to, dx, chart.pw, chart.bounds);
        }
        if (win) { chart.swallow = true; showWindow(win); }
        return;
      }
      var d = chart.drag; if (!d || e.pointerId !== d.id) return;
      d.x1 = plotX(e); if (Math.abs(d.x1 - d.x0) > 4) d.moved = true;
      if (!d.moved) return;
      chartSelect(-1);
      var sel = $('chartSel'); sel.hidden = false;
      sel.style.left = (cv.offsetLeft + Math.min(d.x0, d.x1)) + 'px'; sel.style.width = Math.abs(d.x1 - d.x0) + 'px'; sel.style.top = (cv.offsetTop + chart.T) + 'px'; sel.style.height = chart.ph + 'px';
    });
    function lift(e) { if (fingers.delete(e.pointerId)) regrip(); }
    cv.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') { lift(e); return; }
      var d = chart.drag; if (!d || e.pointerId !== d.id) return;
      cancelDrag();
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      if (!d.moved) return;
      var span = chart.to - chart.from, from = Math.round(chart.from + (Math.min(d.x0, d.x1) - chart.L) / chart.pw * span), to = Math.round(chart.from + (Math.max(d.x0, d.x1) - chart.L) / chart.pw * span);
      if (to - from >= 60) setRange('custom', { from: from, to: to });
    });
    cv.addEventListener('pointercancel', function (e) { if (e.pointerType === 'touch') lift(e); else cancelDrag(); });
    Array.prototype.forEach.call($('rangeSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); }); });
    $('chartReset').addEventListener('click', function () { setRange('all'); });
    $('chartFollow').addEventListener('change', function () { chart.follow = this.checked; if (state.led) drawChart(); });
    $('chartBars').addEventListener('change', function () { wprefs.bars = this.checked; saveWprefs(); if (state.led) drawChart(); });
    $('chartAuto').addEventListener('change', function () { wprefs.auto = this.checked; saveWprefs(); if (this.checked) autoLoad(); });
    $('chartLoadAll').addEventListener('click', function () { $('loadAll').click(); });
    $('chartCancel').addEventListener('click', function () { $('allCancel').click(); });
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
  function wantFiatOrder() { return fiatOn() && state.fiat.show === 'fiat'; }
  function drawCounterparties() {
    var list = W.counterparties(state.led.rows, state.addr, known), box = $('cp'), more = $('cpMore'), note = $('cpNote');
    box.textContent = ''; more.hidden = true; note.hidden = true; $('cpSec').hidden = !list.length;
    if (!list.length) return;
    // In the currency alone the biggest are those that moved the most in the currency (the price changes over the years, so the order can differ); Bitcoin first otherwise,
    // and always when a price is missing for any of them
    var fvAll = wantFiatOrder() ? fxByWallet(new Set(list.map(function (c) { return c.address; }))) : new Map(), byFiat = fvAll.size === list.length, vol = function (c) { var f = fvAll.get(c.address); return f.inV + f.outV; };
    if (byFiat) list = list.map(function (c, i) { return { c: c, i: i }; }).sort(function (a, b) { return vol(b.c) - vol(a.c) || a.i - b.i; }).map(function (x) { return x.c; });
    var top = (byFiat ? vol(list[0]) : list[0].volume) || 1, n = Math.min(state.cpShown, list.length, CP_MAX);
    var fv = byFiat ? fvAll : fxByWallet(new Set(list.slice(0, n).map(function (c) { return c.address; })));
    list.slice(0, n).forEach(function (c, i) {
      var nums = [plural(c.txs, 'transaction')], f = fv.get(c.address);
      if (c.asInput) nums.push('paid in ' + mix(c.asInput, f && fxValue(f.inV, f.approx)));
      if (c.asOutput) nums.push('received ' + mix(c.asOutput, f && fxValue(f.outV, f.approx)));
      var bar = el('span', { 'class': 'bar', 'aria-hidden': 'true' }), fillBar = el('i'); fillBar.style.width = Math.max(2, Math.round((byFiat ? vol(c) : c.volume) / top * 100)) + '%'; bar.appendChild(fillBar);
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
  var CL_ROUND = 25, CL_BALANCES = 50, CL_SHOW = 12, CL_MAX_REQ = 250, CL_MAX_WALLETS = 500;                 // Follow further: at most this many requests in all, and it stops when the group reaches this size
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
    $('clLook').disabled = busy || alone; $('clFollow').disabled = busy || alone; $('clRounds').disabled = busy; $('clBalances').disabled = busy || alone; $('clCopy').disabled = alone;
    $('clLook').hidden = alone; $('clFollow').hidden = alone; $('clRoundsWrap').hidden = alone; $('clBalances').hidden = alone; $('clCopy').hidden = alone; $('clOpen').hidden = alone;
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
  /**
   * Look further, round after round: each round loads the newest transactions of up to 25 wallets of the group that were not looked at yet, and the group is worked out again.
   * It stops, and says which of these it was: the group did not grow in the last round; every wallet was looked at; the rounds asked for were done; the request limit or the
   * size limit was reached (a group that large is probably a service, not one owner); Cancel; a request failed. What was loaded stays.
   */
  function followFurther() {
    if (cl.running || !cl.last) return;
    var rounds = Math.max(1, Math.min(20, parseInt($('clRounds').value, 10) || 5)), startSize = cl.last.members.length, startLooked = cl.looked.size, f = { round: 0, reqs: 0 };
    $('clRounds').value = rounds;
    function summary(why) {
      var now = computeCluster().members.length;
      return 'Followed ' + plural(f.round, 'round') + ' (' + plural(f.reqs, 'request') + ', ' + plural(cl.looked.size - startLooked, 'wallet') + ' looked at): the group ' + (now > startSize ? 'grew from ' + startSize + ' to ' + now + ' wallets' : 'stayed at ' + now + ' wallets') + '. ' + why;
    }
    function next() {
      var members = computeCluster().members, list = members.filter(function (a) { return a !== state.addr && !cl.looked.has(a); }).slice(0, CL_ROUND);
      if (f.round > 0 && members.length === f.size) { message(summary('Stopped: the last round added no wallet to the group.')); return; }
      if (members.length >= CL_MAX_WALLETS) { message(summary('Stopped: the group reached ' + CL_MAX_WALLETS + ' wallets. A group that large is probably a service or a shared wallet, not one owner.'), true); return; }
      if (!list.length) { message(summary('Stopped: the newest transactions of every wallet in the group are loaded.')); return; }
      if (f.round >= rounds) { message(summary('Stopped: ' + (rounds === 1 ? 'the round asked for is' : 'the ' + rounds + ' rounds asked for are') + ' done. Follow further goes on from here.')); return; }
      if (f.reqs >= CL_MAX_REQ) { message(summary('Stopped: the limit of ' + CL_MAX_REQ + ' requests was reached.'), true); return; }
      list = list.slice(0, Math.max(1, Math.min(list.length, CL_MAX_REQ - f.reqs)));
      f.round++; f.size = members.length;
      clWalk(list, 'Round ' + f.round + ' of up to ' + rounds + ', loading transactions', 'load the transactions of', function (a) {
        return state.client.addressTxs(a).then(function (txs) { cl.extra.set(a, txs); cl.looked.add(a); f.reqs++; });
      }, next);
    }
    next();
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
    $('clFollow').addEventListener('click', followFurther);
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
  function onFilter() { readFilters(); state.shown = SHOW; if (state.led) { drawLedger(); if (chart.follow) drawChart(); } }
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
    function progress() { $('allText').textContent = 'Loading the whole history: ' + fmtInt(state.txs.length) + ' of ' + fmtInt(totalTxs()) + ' transactions · ' + plural(reqs, 'request'); chartBanner(); }
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

  /**
   * With "Load the whole history by itself" on, a wallet of up to AUTO_MAX transactions (and within the limit beside Load all) has the rest of its history loaded as soon as the first
   * page is here, so the chart is complete. A bigger wallet waits for Load all.
   */
  function autoLoad() {
    if (!wprefs.auto || state.busy || state.done || allLoad.running || !state.led) return;
    var total = W.summary(state.stats).txCount;
    if (!total || total > Math.min(AUTO_MAX, capValue()) || historyComplete()) return;
    loadAll();
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
      state.stats = r[0]; state.txs = []; state.done = false; chart.key = 'all'; chart.view = null;
      state.fetched = new Map(); state.statsAt = Math.floor(Date.now() / 1000); state.statsSource = state.client.sourceOf(r[0]);
      try { addPage(r[1], true); state.busy = false; message(state.switched || ''); drawHead(); redraw(); autoLoad(); }
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
