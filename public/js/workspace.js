/*
 * Orion workspace controller: wires the model, filters, layouts, data source, import/export and the renderer
 * to workspace.html. Everything that comes from the network or from a file reaches the page through
 * textContent / canvas drawing only, never as HTML.
 */
(function () {
  'use strict';

  var M = OrionModel, S = OrionStyle, F = OrionFilter, L = OrionLayout, A = OrionApi, IO = OrionIO, R = OrionRender, NV = OrionNav, AD = OrionAddress, PR = OrionPrice, ST = OrionSteps, TG = OrionTags, XT = OrionExternal, TR = OrionTrace, AN = OrionAnalysis, LB = OrionLabels, RP = OrionReport, balanceOf = M.balanceOf;
  var ID = M.ID;
  var KNOWN_BASE = window.ORION_KNOWN || {};
  var KNOWN = Object.assign({}, KNOWN_BASE);              // the built-in list plus the label packs that are switched on, rebuilt in place by rebuildKnown()
  var SAMPLE = '0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d';
  var SAVE_KEY = 'orion.workspace.v1', PREF_KEY = 'orion.prefs.v1', TOKEN_KEY = 'orion.ext.token', PACKS_KEY = 'orion.packs.v1';
  var ARRANGE = { columns: 1, timeline: 1, timeforce: 1, force: 1, timeamount: 1 }, TIME_ARR = { timeline: 1, timeforce: 1, timeamount: 1 };
  var LAYOUTS = { flow: 1, timeline: 1, force: 1, trace: 1 }, COLORS = { type: 1, age: 1, script: 1 }, SIZES = { auto: 1, area: 1, log: 1 }, SCALES = { compact: 1, proportional: 1 };

  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (props[k] === null || props[k] === undefined || props[k] === false) return;           // no attribute at all (setAttribute('disabled', null) would still disable)
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function num(v, lo, hi, dflt) { v = parseInt(v, 10); return isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v)); }

  // ---- state ----------------------------------------------------------------------------------
  var state = {
    graph: new M.Graph(), layout: 'flow', colorBy: 'type', sizeBy: 'auto', timeScale: 'compact', filter: F.defaults(),
    keep: new Set(), pinned: new Map(), selected: new Set(), selectedEdge: null,
    source: 'clearnet', fallback: true, customBase: '', capTx: 25, capReq: 80, capPages: 2, showLabels: true, persist: true,
    customPrices: 'server', focus: null, focusOn: true, hops: 2, nav: new NV(), histOk: false, scopeNodes: null,
    fiat: { currency: 'off', basis: 'each', show: 'both', ref: null }, books: {},
    sideCollapsed: false, inspCollapsed: false, tbCollapsed: false, tbTxs: [], tbHover: null, tbGeom: null, edgeLabels: true, viaWallets: true,
    trace: { seed: null, seeds: [], shown: new Set(), pos: new Map(), prov: new Map(), undo: [] },
    undoLoads: [], analysis: { flags: true, change: true, clusters: true }, an: null, anSig: '', anGraph: null, packs: [], knownVersion: 0,
    hidden: new Set(), hideUndo: [], arrange: 'columns', boxMode: false,
    stepMode: 'ask', stepSize: 5, chooseSort: 'big', walletView: { dir: 'all', sort: 'new', more: 40 },
    auto: { dir: 'next', hops: 3, follow: 'all', maxTx: 40, maxReq: 150, perTx: 6, minSats: 0, stopLabel: true, stopMix: true },
    ext: { proxy: 'http://127.0.0.1:8787', token: '', remember: false, consented: false, busy: false }, today: null, todayAt: 0, fiatError: '', priceClient: null,
    retired: { data: 0, price: 0, retried: 0, failed: 0 },
    busy: false, playMs: 90, layoutRes: null, client: null, explorer: null, tb: { min: null, max: null }, amountMax: 0, playTimer: null,
    log: []
  };
  var renderer = null, saveTimer = null, toastTimer = null, clearTimer = null;

  // ---- messages -------------------------------------------------------------------------------
  function log(msg, bad) {
    state.log.unshift({ msg: msg, bad: !!bad });
    state.log.length = Math.min(state.log.length, 60);
    var ul = $('logList'); ul.textContent = '';
    state.log.forEach(function (l) { ul.appendChild(el('li', { text: l.msg, 'class': l.bad ? 'bad' : '' })); });
    $('logCount').textContent = '(' + state.log.length + ')';
  }
  function toast(msg, bad, action) {
    var t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    if (action) t.appendChild(el('button', { type: 'button', text: action.text, onclick: function () { t.hidden = true; action.fn(); } }));
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, action ? 15000 : bad ? 9000 : 5000);
    log(msg, bad);
  }

  // ---- data source ----------------------------------------------------------------------------
  function sourceBase() { return state.source === 'custom' ? state.customBase.trim() : A.PRESETS[state.source].base; }

  function retire(c, key) {
    if (!c) return;
    state.retired[key] += c.total.network; state.retired.retried += c.total.retried; state.retired.failed += c.total.failed;
  }

  /** Where fiat prices come from: the source itself when it is a mempool, otherwise mempool.space. null = nowhere to ask. */
  function priceBase() {
    var p = A.PRESETS[state.source] || A.PRESETS.custom;
    if (p.prices) return p.prices;
    if (state.customPrices === 'off') return null;
    if (state.customPrices === 'mempool') return A.PRESETS.clearnet.prices;                      // a plain Esplora has no price service: only the currency and the dates go to mempool.space
    return /^https?:\/\//i.test(state.customBase.trim()) ? state.customBase.trim() : null;
  }

  function makePriceClient() {
    retire(state.priceClient, 'price'); state.priceClient = null;
    var base = priceBase();
    if (!base) return;
    state.priceClient = new A.Client({ base: base, concurrency: 2, delayMs: 300, timeoutMs: state.source === 'tor' ? 120000 : 40000, retries: 2 });
  }

  function updateReqStats() {
    var c = state.client, p = state.priceClient, r = state.retired;
    var data = r.data + (c ? c.total.network : 0), price = r.price + (p ? p.total.network : 0);
    var retried = r.retried + (c ? c.total.retried : 0) + (p ? p.total.retried : 0), failed = r.failed + (c ? c.total.failed : 0) + (p ? p.total.failed : 0);
    $('reqStats').textContent = 'Requests this session: ' + data + ' data' + (price ? ', ' + price + ' price' : '') + (retried ? ' · ' + retried + ' retried' : '') + (failed ? ' · ' + failed + ' failed' : '') + '.';
  }

  /** The other public server, when the backup option is on and this one has such a partner (never for Tor or your own server: those must not leave). */
  function backupPreset() {
    if (!state.fallback) return null;
    return state.source === 'clearnet' ? A.PRESETS.blockstream : state.source === 'blockstream' ? A.PRESETS.clearnet : null;
  }
  function hostOf(base) { return String(base).replace(/^https?:[/][/]/i, '').split('/')[0]; }
  var SWITCH_WHY = { rate: 'is throttling (HTTP 429)', server: 'returned a server error', timeout: 'did not answer in time', network: 'could not be reached' };

  function makeClient() {
    retire(state.client, 'data');
    var p = A.PRESETS[state.source] || A.PRESETS.custom, bk = backupPreset();
    state.client = new A.Client({
      base: sourceBase(), concurrency: p.concurrency, delayMs: p.delayMs, timeoutMs: p.timeoutMs, retries: p.retries,
      backup: bk ? { base: bk.base, concurrency: bk.concurrency, delayMs: bk.delayMs } : null,
      onSwitch: function (i) { toast(hostOf(i.from) + ' ' + (SWITCH_WHY[i.reason] || 'failed') + ': using ' + hostOf(i.to) + ' for about ' + i.seconds + ' seconds.'); },
      onRestore: function (i) { log(hostOf(i.base) + ' is answering again.'); },
      onRequest: function (path, c) { if (state.busy) $('progressText').textContent = $('progressText').dataset.title + ' — ' + c.network + ' request' + (c.network === 1 ? '' : 's'); }
    });
    state.explorer = new A.Explorer(state.client, state.graph);
    makePriceClient();
    if ($('reqStats')) updateReqStats();
  }

  function setGraph(g) { state.graph = g; state.explorer = new A.Explorer(state.client, g); state.layoutRes = null; }

  function explorerOrigin() {
    if (state.source === 'tor') return A.ONION.replace(/\/api$/, '');
    if (state.source === 'custom' && /^https?:\/\//i.test(state.customBase.trim())) return state.customBase.trim().replace(/\/(api\/?)?$/, '');
    return 'https://mempool.space';
  }

  var SOURCE_HINT = {
    clearnet: 'Requests go from your browser straight to mempool.space, which can see your IP address and what you look up. It publishes no rate limit; if it throttles you (HTTP 429) the page waits and retries.',
    blockstream: 'Blockstream\'s public Esplora API, same format as mempool.space, with no published limit either. It has no price API, so fiat prices still come from mempool.space (only the currency and the dates are sent there).',
    tor: 'Needs Tor Browser (it routes .onion addresses). In an ordinary browser this will not connect. Slower on purpose: 2 requests at a time, 0.8 s apart, 60 s timeout.',
    custom: 'Any Esplora-compatible API, for example your own mempool/electrs. The server must allow cross-origin requests (CORS).'
  };
  function applySourceUi() {
    $('source').value = state.source;
    var partner = state.source === 'clearnet' ? A.PRESETS.blockstream : state.source === 'blockstream' ? A.PRESETS.clearnet : null;
    $('fallbackRow').hidden = !partner; $('fallbackOn').checked = state.fallback;
    if (partner) $('fallbackName').textContent = hostOf(partner.base);
    $('customBase').hidden = state.source !== 'custom'; $('customPricesRow').hidden = state.source !== 'custom'; $('customPrices').value = state.customPrices;
    $('customBase').value = state.customBase;
    $('sourceHint').textContent = SOURCE_HINT[state.source] + (backupPreset() ? ' If it keeps failing, ' + hostOf(backupPreset().base) + ' answers instead for about a minute (it then sees those look-ups too).' : '');
    $('testResult').textContent = ''; $('testResult').className = '';
  }
  function cleanFiat(f) {
    var out = { currency: 'off', basis: 'each', show: 'both', ref: null };
    if (!f || typeof f !== 'object') return out;
    if (f.currency === 'off' || PR.CURRENCIES.indexOf(f.currency) >= 0) out.currency = f.currency;
    if (f.basis === 'each' || f.basis === 'ref' || f.basis === 'today') out.basis = f.basis;
    if (f.show === 'btc' || f.show === 'both' || f.show === 'fiat') out.show = f.show;
    if (f.ref && typeof f.ref.txid === 'string' && /^[0-9a-f]{64}$/.test(f.ref.txid) && typeof f.ref.time === 'number' && isFinite(f.ref.time)) out.ref = { txid: f.ref.txid, time: f.ref.time };
    return out;
  }

  var AUTO_FOLLOW = { all: 1, largest: 1, change: 1, peel: 1 };
  function cleanAuto(a) {
    var d = { dir: 'next', hops: 3, follow: 'all', maxTx: 40, maxReq: 150, perTx: 6, minSats: 0, stopLabel: true, stopMix: true };
    if (!a || typeof a !== 'object') return d;
    if (a.dir === 'next' || a.dir === 'prev') d.dir = a.dir;
    if (AUTO_FOLLOW[a.follow] === 1) d.follow = a.follow;
    d.hops = num(a.hops, 1, 12, 3); d.maxTx = num(a.maxTx, 1, 500, 40); d.maxReq = num(a.maxReq, 1, 1000, 150); d.perTx = num(a.perTx, 1, 50, 6); d.minSats = num(a.minSats, 0, 2100000000000000, 0);
    d.stopLabel = a.stopLabel !== false; d.stopMix = a.stopMix !== false;
    return d;
  }
  function cleanAnalysis(a) { a = a && typeof a === 'object' ? a : {}; return { flags: a.flags !== false, change: a.change !== false, clusters: a.clusters !== false }; }

  function savePrefs() {
    store.set(PREF_KEY, JSON.stringify({ stepMode: state.stepMode, stepSize: state.stepSize, chooseSort: state.chooseSort, source: state.source, fallback: state.fallback, customBase: state.customBase, capTx: state.capTx, capReq: state.capReq, capPages: state.capPages, showLabels: state.showLabels, persist: state.persist, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, sideCollapsed: state.sideCollapsed, inspCollapsed: state.inspCollapsed, tbCollapsed: state.tbCollapsed, edgeLabels: state.edgeLabels, viaWallets: state.viaWallets, customPrices: state.customPrices, reportBy: ($('reportBy') && $('reportBy').value) || '', analysis: state.analysis, auto: state.auto, extProxy: state.ext.proxy, extRemember: state.ext.remember }));
  }
  function loadPrefs() {
    var raw = store.get(PREF_KEY); if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (A.PRESETS[p.source]) state.source = p.source;
      state.fallback = p.fallback !== false;
      if (p.stepMode === 'ask' || p.stepMode === 'batch' || p.stepMode === 'all') state.stepMode = p.stepMode;
      state.stepSize = num(p.stepSize, 1, 50, 5);
      if (p.chooseSort === 'big' || p.chooseSort === 'small' || p.chooseSort === 'new' || p.chooseSort === 'old') state.chooseSort = p.chooseSort;
      if (typeof p.customBase === 'string') state.customBase = p.customBase.slice(0, 300);
      state.capTx = num(p.capTx, 1, 500, 25); state.capReq = num(p.capReq, 1, 1000, 80); state.capPages = num(p.capPages, 1, 20, 2);
      state.showLabels = p.showLabels !== false;
      state.persist = p.persist !== false;
      state.focusOn = p.focusOn !== false; state.hops = num(p.hops, 1, 3, 2);
      state.fiat = cleanFiat(p.fiat);
      state.sideCollapsed = p.sideCollapsed === true; state.inspCollapsed = p.inspCollapsed === true; state.tbCollapsed = p.tbCollapsed === true;
      state.edgeLabels = p.edgeLabels !== false; state.viaWallets = p.viaWallets !== false;
      state.analysis = cleanAnalysis(p.analysis); state.auto = cleanAuto(p.auto);
      state.reportBy = typeof p.reportBy === 'string' ? LB.cleanText(p.reportBy, 80) : '';
      if (p.customPrices === 'server' || p.customPrices === 'mempool' || p.customPrices === 'off') state.customPrices = p.customPrices;
      if (typeof p.extProxy === 'string' && proxyUrlOk(p.extProxy)) state.ext.proxy = p.extProxy;
      state.ext.remember = p.extRemember === true;
      if (state.ext.remember) state.ext.token = store.get(TOKEN_KEY) || '';
    } catch (e) { /* ignore corrupt prefs */ }
  }

  // ---- running actions ------------------------------------------------------------------------
  function showProgress(title) {
    $('progressText').dataset.title = title; $('progressText').textContent = title + '…'; $('progress').hidden = false;
  }

  /** Runs fn() (resolving to an Explorer result) with a request cap and a cancel button, then reports. */
  function run(title, fn, o) {
    if (state.busy) { toast('Busy: wait for the current action or cancel it.', true); return Promise.resolve(null); }
    if (state.source === 'custom' && !/^https?:\/\//i.test(state.customBase.trim())) { toast('Enter the URL of your Esplora API first (https://… or http://…).', true); return Promise.resolve(null); }
    state.busy = true;
    var c = state.client; c.resume(); c.resetCount(); c.maxRequests = (o && o.maxRequests) || state.capReq;
    showProgress(title); updateUndoLoad();
    var wasEmpty = state.graph.nodes.size === 0, snap = snapshotGraph(title), g0 = state.graph, n0 = g0.nodes.size, e0 = g0.edges.size, big = null;
    if (o && o.before && snap && !snap.tooBig) {                                                         // the caller changed the focus before running: undo goes back to what it was
      if ('focus' in o.before) snap.focus = o.before.focus;
      if (o.before.dropKeep) snap.keep = snap.keep.filter(function (k) { return k !== o.before.dropKeep; });
    }
    return fn().then(function (r) {
      if (!r) return r;
      var grew = state.graph === g0 ? state.graph.nodes.size - n0 : 0;
      if (state.graph !== g0 || state.graph.nodes.size !== n0 || state.graph.edges.size !== e0) {           // something was added: remember how it was before
        pushUndoLoad(snap, '+' + plural(Math.max(0, grew), 'vertex', 'vertices'));
        if (grew >= BIG_LOAD) big = { text: 'Undo load', fn: undoLoad };
      }
      var capHit = (r.errors || []).some(function (e) { return /request cap/.test(e); });
      var msg = title + ': ' + (r.added ? '+' + r.added + ' vertices' : 'nothing new') + ', ' + r.requests + ' request' + (r.requests === 1 ? '' : 's') + '.';
      if (c.count.backup && c.backup) msg += ' ' + c.count.backup + ' of them went to ' + hostOf(c.backup.base) + '.';
      if (r.truncated) msg += ' Stopped at the per-expand limit; raise it under Expansion limits.';
      if (capHit) msg += ' Stopped at the request limit.';
      var errs = (r.errors || []).filter(function (e) { return !/request cap/.test(e); });
      if (errs.length) msg += ' ' + errs.length + ' request(s) failed: ' + errs[0] + (errs.length > 1 ? ' …' : '');
      if (big) msg += ' That is a lot: Undo load takes it back.';
      toast(msg, !!errs.length || !!r.failed, big);
      return r;
    }).catch(function (e) {
      toast(title + ' failed: ' + (e && e.message ? e.message : e), true); return null;
    }).then(function (r) {
      state.busy = false; $('progress').hidden = true; updateReqStats(); updateUndoLoad();
      state.graph.refreshDerived();
      afterGraphChange({ fit: wasEmpty });
      scheduleSave();
      return r;
    });
  }

  // ---- undo for loads, imports and removals ----------------------------------------------------
  // Before anything that changes what is loaded, the graph is kept as text (compact), with what depends on it. "Undo load" puts it back.
  var UNDO_DEPTH = 10, UNDO_BUDGET = 30000000, BIG_LOAD = 150;
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function snapshotGraph(title) {
    var g = state.graph, text;
    try { text = JSON.stringify(g.toData()); } catch (e) { return { title: title, tooBig: true }; }
    if (text.length > UNDO_BUDGET) return { title: title, tooBig: true };
    return { title: title, graph: text, nodes: g.nodes.size, keep: Array.from(state.keep), focus: state.focus, trace: traceData(), traceUndo: clone(state.trace.undo || []), hidden: Array.from(state.hidden), hideUndo: clone(state.hideUndo) };
  }
  function pushUndoLoad(snap, info) {
    if (!snap) return;
    snap.info = info; state.undoLoads.push(snap);
    while (state.undoLoads.length > UNDO_DEPTH) state.undoLoads.shift();
    var total = 0;
    for (var i = state.undoLoads.length - 1; i >= 0; i--) { total += (state.undoLoads[i].graph || '').length; if (total > UNDO_BUDGET) { state.undoLoads.splice(0, i + 1); break; } }
    updateUndoLoad();
  }
  function updateUndoLoad() {
    var b = $('btnUndoLoad'), top = state.undoLoads[state.undoLoads.length - 1];
    b.disabled = !top || state.busy;
    b.textContent = '↶ Undo load' + (state.undoLoads.length > 1 ? ' (' + state.undoLoads.length + ')' : '');
    b.title = !top ? 'Nothing to undo: a load, an import or a removal can be taken back here'
      : top.tooBig ? 'Too large to undo (no copy was kept): ' + top.title
      : 'Undo: ' + top.title + (top.info ? ' (' + top.info + ')' : '') + ' — back to ' + plural(top.nodes, 'vertex', 'vertices');
  }
  function undoLoad() {
    if (state.busy) { toast('Wait for the current action to finish, or press Cancel first.', true); return; }
    var s = state.undoLoads.pop();
    if (!s) return;
    if (s.tooBig) { toast('That change was too large to keep a copy of, so it cannot be undone. Remove the vertices you do not want instead.', true); updateUndoLoad(); return; }
    stopPlay(); $('tooltip').hidden = true;
    setGraph(M.Graph.fromData(JSON.parse(s.graph)));
    state.keep = new Set(s.keep); state.hidden = new Set(s.hidden); state.hideUndo = s.hideUndo;
    state.focus = s.focus && state.graph.nodes.has(s.focus) ? s.focus : null;
    if (s.trace && loadTraceData(s.trace)) { state.trace.undo = s.traceUndo; traceSanitize(); } else state.trace = emptyTrace();
    if (traceOn() && !state.trace.seed) { state.layout = 'flow'; setSeg('layoutSeg', 'data-layout', 'flow'); document.body.classList.remove('trace-on'); updateScaleRow(); }
    state.selected = new Set(); state.selectedEdge = null; state.pinned = new Map();
    state.graph.refreshDerived(); afterGraphChange({ fit: true }); syncSelection(); updateNavUi(); updateTraceUi(); scheduleSave(); updateUndoLoad();
    toast('Undid: ' + s.title + '. Back to ' + plural(s.nodes, 'vertex', 'vertices') + '.');
  }

  function openQuery(raw) {
    if (!(raw || '').trim()) return;
    var q = A.checkQuery(raw);
    if (!q.ok) { toast(q.message, true); return; }
    if ($('q').value.trim() === String(raw).trim()) $('q').value = q.value;                                           // show what was actually looked up
    navigate(q.kind === 'tx' ? ID.tx(q.value) : ID.addr(q.value));
  }

  // ---- focus and navigation -------------------------------------------------------------------
  /** The vertex whose neighbourhood is shown, or null when the whole graph is. */
  function focusOpt() { return state.focusOn && state.layout !== 'trace' && state.focus && state.graph.nodes.has(state.focus) ? { id: state.focus, hops: state.hops } : null; }

  /** What the graph shows before the time range is applied: every other filter, limited to the focus neighbourhood. */
  function scope(extra) {
    return F.computeVisible(state.graph, Object.assign({}, state.filter, { timeFrom: null, timeTo: null }, extra || {}), state.keep, focusOpt(), traceOnly(), hiddenOpt());
  }

  function needsLoad(id) {
    var n = state.graph.nodes.get(id), kind = id.slice(0, id.indexOf(':'));
    if (kind === 'tx') return !n || !n.loaded || !n.outspendsLoaded;
    if (kind === 'addr') return !n || n.txCount == null;
    return false;
  }
  function loaderFor(id) {
    var kind = id.slice(0, id.indexOf(':')), val = id.slice(id.indexOf(':') + 1);
    if (kind === 'tx') return { title: 'Open ' + S.shortId(val, 8), fn: function () { return state.explorer.loadTx(val); }, done: function (n) { return !!(n && n.loaded); } };
    if (kind === 'addr') return { title: 'Open ' + S.shortId(val, 8), fn: function () { return state.explorer.expandAddress(val, { pages: state.capPages, cap: state.capPages * 25 }); }, done: function (n) { return !!(n && n.txCount != null); } };
    return null;
  }

  function focusLabel(id) {
    var n = state.graph.nodes.get(id), kind = id.slice(0, id.indexOf(':')), val = id.slice(id.indexOf(':') + 1);
    var text = n && n.label ? n.label : (n && n.type === 'addr' && KNOWN[n.address]) ? KNOWN[n.address].label : (kind === 'tx' ? S.shortId(val, 5) : kind === 'addr' ? S.shortId(val, 6) : kind === 'cb' ? 'coinbase' : kind === 'data' ? 'OP_RETURN' : 'output');
    return (kind === 'tx' ? 'tx ' : kind === 'addr' ? '' : '') + text;
  }

  /** Record a new place in the trail and in the browser's own history (so its Back/Forward buttons work too). */
  function visitNav(id) {
    var first = state.nav.entries.length === 0;
    if (!state.nav.visit(id)) return;
    var hash = NV.toHash(state.nav.index, id);
    try {
      if (first) window.history.replaceState({ orion: 1 }, '', hash); else window.history.pushState({ orion: 1 }, '', hash);
      state.histOk = true;
    } catch (e) { state.histOk = false; }
  }

  function updateNavUi() {
    $('navBack').disabled = !state.nav.canBack(); $('navFwd').disabled = !state.nav.canForward();
    var trail = $('trail'), es = state.nav.entries, cur = state.nav.index;
    trail.textContent = '';
    trail.hidden = es.length === 0;
    if (!es.length) return;
    var from = Math.max(0, cur - 7);
    if (from > 0) trail.appendChild(el('span', { 'class': 'sep', text: '… ›' }));
    for (var i = from; i < es.length && i < from + 14; i++) {
      (function (i) {
        var isCur = i === cur;
        if (i > from) trail.appendChild(el('span', { 'class': 'sep', text: '›' }));
        trail.appendChild(el('button', { type: 'button', 'class': 'crumb' + (isCur ? ' current' : '') + (i > cur ? ' ahead' : ''), title: es[i], 'aria-current': isCur ? 'true' : null,
                                         text: focusLabel(es[i]), onclick: function () { if (!isCur) stepNav(i - cur); } }));
      }(i));
    }
    var c = trail.querySelector('.current'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Make a vertex the focus. Loads it first when needed (a transaction with its outspends, an address with its
   * history). o.fromHistory = a Back/Forward step, which must not add a new entry to the trail.
   */
  function navigate(id, o) {
    o = o || {};
    id = canonicalId(id);
    var load = loaderFor(id);
    if (!state.graph.nodes.has(id) && !load) { toast('That vertex is no longer in the workspace.', true); return Promise.resolve(false); }
    var prev = state.focus, hadKeep = state.keep.has(id);

    function commit() {
      stopPlay(); $('tooltip').hidden = true;
      state.focus = id; state.keep.add(id);
      if (traceOn()) { if (o.replaceTrace || !state.trace.shown.size) traceStart(id); else traceAddSeed(id, false); }       // a new vertex is ADDED to the trace; only "Start over" replaces it
      state.filter.timeFrom = null; state.filter.timeTo = null;       // a window chosen for the old neighbourhood may hide the whole new one
      state.pinned.clear();
      if (!o.fromHistory) visitNav(id);
      state.selected = new Set([id]); state.selectedEdge = null;
      syncSelection();                                                  // open the details panel first, so the fit below sees the canvas at its final size
      var pan = !state.focusOn && o.fromHistory;                        // whole-graph view: Back/Forward move the camera, opening something new still fits everything
      afterGraphChange({ fit: !pan });
      if (pan) renderer.centerOn(id);
      updateNavUi(); scheduleSave();
      return true;
    }

    // stepping onto a wallet shows what is already known about it; its whole history is one click away (Load history)
    var must = needsLoad(id) && !(o.light && id.indexOf('addr:') === 0 && state.graph.nodes.has(id));
    if (!must) return Promise.resolve(commit());
    state.focus = id; state.keep.add(id);                              // provisional, so the refresh at the end of the load already looks right
    return run(load.title, load.fn, { before: { focus: prev, dropKeep: hadKeep ? null : id } }).then(function () {
      if (load.done(state.graph.nodes.get(id))) return commit();
      state.focus = prev; if (!hadKeep) state.keep.delete(id);          // failed: stay where we were
      afterGraphChange(); updateNavUi();
      return false;
    });
  }

  // ---- Trace: build the chain by hand ---------------------------------------------------------
  // Nothing here ever removes a vertex on its own: a click only adds. What goes is what you hide, and every hide can be undone.
  function traceOn() { return state.layout === 'trace'; }
  function traceOnly() { return traceOn() ? state.trace.shown : null; }
  function walletOrTx(id) { return /^(tx|addr):/.test(id) && state.graph.nodes.has(id); }
  function emptyTrace() { return { seed: null, seeds: [], shown: new Set(), pos: new Map(), prov: new Map(), undo: [] }; }
  function syncSeed() { var T = state.trace; T.seeds = T.seeds.filter(function (s) { return T.shown.has(s); }); T.seed = T.seeds.length ? T.seeds[0] : null; }
  function traceDrop(id) { var T = state.trace; T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); state.selected.delete(id); }

  /** Begin again from one vertex: only it is shown. */
  function traceStart(id) {
    var T = state.trace;
    T.seed = id; T.seeds = [id]; T.shown = new Set([id]); T.pos = new Map([[id, { x: 0, y: 0 }]]); T.prov = new Map(); T.undo = [];
    state.keep.add(id);
  }

  /** The area the trace covers, to put a new starting point clear of it. */
  function traceBox() {
    var minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.trace.shown.forEach(function (id) { var p = state.trace.pos.get(id); if (!p) return; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    return isFinite(minX) ? { cx: Math.round((minX + maxX) / 20) * 10, bottom: maxY } : { cx: 0, bottom: -150 };
  }

  /**
   * Another starting point, next to what is already there: nothing is removed or moved. A vertex that is already on
   * screen is left where it is (and marked as a starting point only when `mark` is true). Returns true if it was added.
   */
  function traceAddSeed(id, mark) {
    var T = state.trace;
    state.keep.add(id);
    if (T.shown.has(id)) {
      if (mark && T.seeds.indexOf(id) < 0) { T.seeds.push(id); T.undo.push({ type: 'seed', id: id, added: false }); syncSeed(); }
      return false;
    }
    var b = traceBox();
    T.shown.add(id); T.pos.set(id, { x: b.cx, y: b.bottom + 150 }); T.seeds.push(id);
    T.undo.push({ type: 'seed', id: id, added: true }); syncSeed();
    return true;
  }

  /** What to start from when the layout is switched on: the selected vertex, else the focus, else the first one loaded. */
  function traceCandidate() {
    var g = state.graph, sel = Array.from(state.selected).filter(walletOrTx)[0];
    if (sel) return sel;
    if (state.focus && walletOrTx(state.focus)) return state.focus;
    var first = null;
    g.nodes.forEach(function (n) { if (!first && (n.type === 'tx' || n.type === 'addr')) first = n.id; });
    return first;
  }

  var TRACE_WHAT = { tx: { next: 'wallets this transaction paid', prev: 'wallets that paid into it' }, addr: { next: 'transactions that spent from this wallet', prev: 'transactions that paid this wallet' } };

  /** The two expand handles of a vertex: { left, right } each { label, known, tip } or null. */
  function handlesFor(id) {
    var n = state.graph.nodes.get(id);
    if (!n || (n.type !== 'tx' && n.type !== 'addr')) return null;
    function one(dir) {
      var h = TR.hidden(state.graph, state.trace.shown, id, dir), label = TR.handleLabel(h);
      if (!label) return null;
      var came = state.trace.prov.get(id);                                       // a bare "?" on the side the trace came from is noise: it stays one key press or menu item away
      if (label === '?' && came && ((came.dir === 'next' && dir === 'prev') || (came.dir === 'prev' && dir === 'next'))) return null;
      var what = TRACE_WHAT[n.type][dir], N = state.stepSize;
      var click = !h.known || h.known <= N || state.stepMode === 'all' ? ' Shift-click to choose which.'
                : state.stepMode === 'ask' ? ' Click to choose which: the top ' + N + ' come ticked.' : ' Click shows the largest ' + N + '; click again for the next.';
      var tip = h.known ? 'Show ' + h.known + ' ' + what + (h.unknown ? ' (more may exist: ' + (n.type === 'addr' ? 'the wallet\'s history is not fully loaded' : 'this transaction is not loaded') + ')' : '') + '.' + click
                        : 'Look for ' + what + ' (loads data)';
      return { label: label, known: h.known, tip: tip };
    }
    return { left: one('prev'), right: one('next') };
  }

  /** What is hidden in numbers, for the tip over an arrow: "83 transactions · 12.4 BTC in total · largest 3.2 BTC · 2021-03-02 to 2022-06-10". */
  function summaryText(s) {
    return S.fmtBtc(s.total) + ' BTC in total · largest ' + S.fmtBtc(s.largest) + ' BTC' + (s.first != null ? ' · ' + S.fmtTime(s.first, false) + (s.last !== s.first ? ' to ' + S.fmtTime(s.last, false) : '') : '');
  }
  /** The extra line under an arrow's tip (on hover only: computing it for every vertex on every frame would be wasteful). */
  function handleSummary(id, side) {
    var n = state.graph.nodes.get(id), dir = side === 'left' ? 'prev' : 'next', s = TR.summary(state.graph, state.trace.shown, id, dir);
    if (!n || !s.count) return '';
    var noun = n.type === 'addr' ? plural(s.count, 'transaction') : dir === 'next' ? plural(s.count, 'output') : plural(s.count, 'input');
    return '\n' + noun + ' · ' + summaryText(s);
  }

  function traceNote(n) {
    if (n.type === 'tx') return n.time != null ? S.fmtTime(n.time, false) : (n.confirmed === false ? 'unconfirmed' : (n.loaded === false ? 'not loaded' : ''));
    if (n.type === 'addr') return n.txCount != null ? fmtInt(n.txCount) + ' txs' : '';
    return '';
  }

  function traceSelected() { return Array.from(state.selected).filter(function (id) { return state.trace.shown.has(id); }); }

  function updateTraceUi() {
    var on = traceOn(), T = state.trace, has = state.graph.nodes.size > 0, hid = hiddenCount();
    var sel = on ? traceSelected().length : Array.from(state.selected).filter(function (id) { return state.graph.nodes.has(id); }).length;
    var vis = renderer && renderer.data ? renderer.data.visible.nodes.size : 0;
    document.body.classList.toggle('trace-on', on);
    $('traceBar').hidden = !(on || has);
    $('barTitle').textContent = on ? 'Trace' : 'Selection';
    $('focusOn').disabled = on; $('depth').disabled = on;
    $('focusOn').title = on ? 'Not used in the Trace layout: the trace shows what you reveal' : 'Show only the neighbourhood of the vertex you are looking at';
    $('traceUndo').disabled = on ? !T.undo.length : !state.hideUndo.length;
    $('traceHide').disabled = !sel; $('traceKeep').disabled = !sel || sel >= (on ? T.shown.size : vis);
    $('hiddenBtn').hidden = on || !hid; $('hiddenBtn').textContent = 'Hidden (' + hid + ') ▾';
    $('boxSel').setAttribute('aria-pressed', String(state.boxMode));
    $('traceArrange').value = state.arrange;
    $('traceInfo').textContent = on ? (!T.shown.size ? 'Nothing shown: open a wallet or a transaction.'
        : T.shown.size === 1 ? 'Click ◀ or ▶ beside the vertex to show what came before or after it.'
        : T.shown.size + ' vertices shown' + (sel ? ' · ' + sel + ' selected' : ''))
      : sel ? sel + ' selected' : 'Click, Shift-click or drag a box to select';
  }

  /** Redraw after the shown set changed. `fit` refits the whole trace; otherwise the view only pans to what was added. */
  function traceChanged(newIds, fit) {
    state.graph.refreshDerived();
    updateTimebar(); updateAmount(); updateScriptChips();
    refresh({ relayout: true, traceChanged: true, fit: !!fit });
    if (!fit && newIds && newIds.length) renderer.ensureVisible(newIds);
    updateTraceUi(); showInspector(true); scheduleSave();
  }

  /**
   * One click on a handle (or ] / [ / double-click): reveal one wallet hop in a direction, loading what is needed.
   * o.only = a Set of ids: show just those (the chooser).
   */
  function traceExpand(id, dir, o) {
    o = o || {};
    var g = state.graph, T = state.trace, n = g.nodes.get(id);
    if (!traceOn() || !n) return Promise.resolve(false);
    if (n.type !== 'tx' && n.type !== 'addr') { toast('Nothing lies beyond ' + (n.type === 'coinbase' ? 'a coinbase' : n.type === 'data' ? 'an OP_RETURN output' : 'this output') + '.'); return Promise.resolve(false); }
    var mode = o.mode || state.stepMode, N = state.stepSize, nodes0 = g.nodes.size, asked = false;
    var opts = { limit: o.only ? 100000 : mode === 'batch' ? Math.min(N, state.capTx) : state.capTx, inner: 8, only: o.only || null }, combined = null, revealedIds = [];
    function add(r) {
      if (!r) return;
      combined = combined || { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] };
      combined.requests += r.requests || 0; combined.truncated = combined.truncated || !!r.truncated; combined.errors = combined.errors.concat(r.errors || []);
      if (r.failed) combined.failed = true;
    }
    var title = (dir === 'next' ? 'Show forward from ' : 'Show backward from ') + S.shortId(n.type === 'tx' ? n.txid : n.address, 6);
    return run(title, function () {
      var ex = state.explorer, chain = Promise.resolve();
      if (n.type === 'tx' && (n.loaded === false || (dir === 'next' && !n.outspendsLoaded))) chain = chain.then(function () { return ex.loadTx(n.txid).then(add); });
      chain = chain.then(function () {
        var h = TR.hidden(g, T.shown, id, dir), nd = g.nodes.get(id);
        if (nd.type === 'addr' && h.known === 0 && h.unknown) {                    // nothing known yet: ask for the wallet's history
          return ex.expandAddress(nd.address, { pages: state.capPages, cap: state.capPages * 25, after: nd.histNext || undefined }).then(function (r) {
            nd.histNext = r.last || null; nd.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); add(r);
          });
        }
      });
      chain = chain.then(function () {
        if (!o.only && mode === 'ask' && TR.hidden(g, T.shown, id, dir).known > N) { asked = true; return; }   // too many to show unasked: the list opens instead, and nothing more is loaded for it
        var p = TR.plan(g, T.shown, id, dir, opts);
        if (p.needLoad.length) return ex.loadMany(p.needLoad, opts.limit, dir === 'next').then(add);       // the transactions between wallets, to see the wallets beyond
      });
      return chain.then(function () {
        g.refreshDerived();
        if (asked) { combined = combined || { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] }; combined.added = Math.max(0, g.nodes.size - nodes0); return combined; }
        var p = TR.plan(g, T.shown, id, dir, opts), rev = TR.revealed(p, id, dir);
        if (rev.length) {
          TR.place(T.pos, id, dir, p).forEach(function (v, k) { T.pos.set(k, v); });
          rev.forEach(function (x) { T.shown.add(x.id); T.prov.set(x.id, { via: x.via, dir: x.dir }); revealedIds.push(x.id); });
          T.undo.push({ type: 'reveal', ids: revealedIds.slice() });
        }
        combined = combined || { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] };
        combined.added = revealedIds.length;
        return combined;
      });
    }).then(function (r) {
      if (!r) return false;
      if (asked) { traceChoose(id, dir, o.at); return false; }
      if (!revealedIds.length) { if (!r.failed) toast(ST.emptyReason(g, id, dir, { viaWallets: true })); return false; }
      traceChanged(revealedIds, false);
      return true;
    });
  }

  /**
   * The list behind an arrow: what is hidden in that direction, to tick the ones to show. It opens by itself when a click would
   * show more than the step size (so nothing floods the screen), and on Shift-click. The largest few come ticked; the list can be
   * sorted, narrowed by amount and by date, and each row says who is on the other side.
   */
  function traceChoose(id, dir, at) {
    var g = state.graph, T = state.trace, n = g.nodes.get(id);
    if (!n || !walletOrTx(id)) return;
    var h = TR.hidden(g, T.shown, id, dir);
    if (!h.known) { traceExpand(id, dir, { at: at }); return; }                      // nothing to choose from yet: this loads it
    var N = state.stepSize, rows = TR.rows(g, T.shown, id, dir), sm = TR.summary(g, T.shown, id, dir);
    var m = $('ctxMenu'); m.textContent = ''; m.classList.add('choosing'); closeStepMenu(); $('tooltip').hidden = true;
    m.appendChild(el('div', { 'class': 'ctxhead', text: 'Choose what to show ' + (dir === 'next' ? '▶' : '◀') + ' · ' + rows.length + ' hidden' }));
    m.appendChild(el('div', { 'class': 'chooserinfo', text: summaryText(sm) }));
    var sortSel = el('select', { 'aria-label': 'Order' }, [el('option', { value: 'big', text: 'Largest first' }), el('option', { value: 'small', text: 'Smallest first' }), el('option', { value: 'new', text: 'Newest first' }), el('option', { value: 'old', text: 'Oldest first' })]);
    sortSel.value = state.chooseSort;                                                  // the order you used last time
    var minIn = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0', size: '6', 'aria-label': 'Smallest amount, in BTC' });
    var fromIn = el('input', { type: 'date', 'aria-label': 'From date' }), toIn = el('input', { type: 'date', 'aria-label': 'To date' });
    var info = el('span', { 'class': 'chooserinfo' });
    m.appendChild(el('div', { 'class': 'choosertools' }, [el('div', { 'class': 'toolrow' }, [sortSel, el('label', {}, ['at least ', minIn, ' BTC'])]), el('div', { 'class': 'toolrow' }, [el('label', {}, ['from ', fromIn]), el('label', {}, ['to ', toIn]), info])]));
    var list = el('div', { 'class': 'chooser' });
    var items = rows.map(function (r) {
      var t = stepRowText(r), parties = n.type === 'addr' && r.type === 'tx' ? partiesOf(r.id, dir === 'next' ? 'out' : 'in', id) : null;
      var who = parties ? (dir === 'next' ? 'to ' : 'from ') + partiesText(parties, 'itself') : '';
      var sub = [who, t.sub].filter(Boolean).join(' · ');
      var cb = el('input', { type: 'checkbox', 'aria-label': t.what });
      cb.addEventListener('change', count);
      return { r: r, cb: cb, row: el('label', { 'class': 'chooserrow' }, [cb, el('span', { 'class': 'what' }, [t.what, sub ? el('small', { text: sub }) : null]), el('span', { 'class': 'amt', text: t.amt })]) };
    });
    function matches(r) {
      var min = parseFloat(String(minIn.value).replace(',', '.')), from = fromIn.value ? Date.parse(fromIn.value + 'T00:00:00Z') / 1000 : null, to = toIn.value ? Date.parse(toIn.value + 'T23:59:59Z') / 1000 : null;
      if (isFinite(min) && min > 0 && r.amount < Math.round(min * 1e8)) return false;
      if (from != null && isFinite(from) && (r.time == null || r.time < from)) return false;
      if (to != null && isFinite(to) && (r.time == null || r.time > to)) return false;
      return true;
    }
    function ordered() {
      var k = sortSel.value;
      return items.slice().sort(function (x, y) {
        var byAmt = y.r.amount - x.r.amount || (x.r.id < y.r.id ? -1 : 1);
        if (k === 'big') return byAmt;
        if (k === 'small') return x.r.amount - y.r.amount || (x.r.id < y.r.id ? -1 : 1);
        var tx = x.r.time, ty = y.r.time;
        if (tx == null || ty == null) return (tx == null ? 1 : 0) - (ty == null ? 1 : 0) || byAmt;                // unknown times last
        return (k === 'new' ? ty - tx : tx - ty) || byAmt;
      });
    }
    var go = el('button', { type: 'button', 'class': 'primary', onclick: function () {
      var only = new Set(items.filter(function (it) { return it.cb.checked; }).map(function (it) { return it.r.id; }));
      closeCtx(); if (only.size) traceExpand(id, dir, { only: only });
    } });
    function count() { var k = items.filter(function (it) { return it.cb.checked; }).length; go.textContent = 'Show ' + k + ' ticked'; go.disabled = !k; }
    function visible() { return ordered().filter(function (it) { return !it.row.hidden; }); }
    function topN() { visible().forEach(function (it, i) { it.cb.checked = i < N; }); count(); }
    function render() {
      var ok = 0;
      ordered().forEach(function (it) { list.appendChild(it.row); var yes = matches(it.r); it.row.hidden = !yes; if (!yes) it.cb.checked = false; else ok++; });
      info.textContent = ok === items.length ? '' : ok + ' of ' + items.length + ' match';
      count();
    }
    [sortSel, minIn, fromIn, toIn].forEach(function (c) { c.addEventListener(c === sortSel || c.type === 'date' ? 'change' : 'input', function () { if (c === sortSel) { state.chooseSort = sortSel.value; savePrefs(); } render(); }); });
    m.appendChild(list);
    list.addEventListener('keydown', function (e) {
      var boxes = visible().map(function (it) { return it.cb; }), i = boxes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i >= 0) { boxes[Math.min(boxes.length - 1, i + 1)].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && i >= 0) { boxes[Math.max(0, i - 1)].focus(); e.preventDefault(); }
      else if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); }
    });
    m.appendChild(el('div', { 'class': 'chooserfoot' }, [go,
      el('button', { type: 'button', text: 'Top ' + Math.min(N, items.length), title: 'Tick only the first ' + N + ' in the order shown', onclick: topN }),
      el('button', { type: 'button', text: 'All', title: 'Tick everything listed', onclick: function () { visible().forEach(function (it) { it.cb.checked = true; }); count(); } }),
      el('button', { type: 'button', text: 'None', onclick: function () { items.forEach(function (it) { it.cb.checked = false; }); count(); } }),
      el('button', { type: 'button', text: 'Cancel', onclick: closeCtx })]));
    render(); topN();
    placeCtx(at || clientPosOf(id));
    var first = m.querySelector('.chooser input'); if (first) first.focus();
  }

  // ---- taking things off the screen (always undoable) -------------------------------------------
  /** Hide vertices. They stay loaded and their neighbours' handles count them again, so they can be shown again. */
  function traceHideIds(ids) {
    var T = state.trace; ids = ids.filter(function (id) { return T.shown.has(id); });
    if (!ids.length) return 0;
    if (ids.length >= T.shown.size) { toast('Keep at least one vertex on screen: use "Reset to start" or open something else.', true); return 0; }
    var items = ids.map(function (id) { var p = T.pos.get(id); return { id: id, pos: p ? { x: p.x, y: p.y } : null, prov: T.prov.get(id) || null, seed: T.seeds.indexOf(id) >= 0 }; });
    ids.forEach(traceDrop);
    var hadSeed = T.seeds.length; syncSeed();
    if (!T.seeds.length) {                                                         // every starting point was hidden: the oldest remaining vertex becomes the start
      var first = Array.from(T.shown)[0]; T.seeds = [first]; T.seed = first;
    }
    T.undo.push({ type: 'hide', items: items });
    syncSelection(); traceChanged(null, false);
    return ids.length;
  }
  function traceHideSelected() {
    var ids = traceSelected();
    if (!ids.length) { toast('Select the vertices to hide first (click, Shift-click, or Ctrl+A).'); return; }
    var k = traceHideIds(ids); if (k) toast('Hid ' + k + (k === 1 ? ' vertex' : ' vertices') + ' (they stay loaded; Ctrl+Z brings them back).');
  }
  function traceKeepOnly(ids) {
    var T = state.trace; ids = ids.filter(function (id) { return T.shown.has(id); });
    if (!ids.length) { toast('Select the vertices to keep first.'); return; }
    var keep = new Set(ids), rest = Array.from(T.shown).filter(function (id) { return !keep.has(id); });
    if (!rest.length) { toast('Everything shown is selected: nothing to hide.'); return; }
    var k = traceHideIds(rest); if (k) toast('Kept ' + ids.length + ', hid ' + k + ' (Ctrl+Z brings them back).');
  }
  /** A vertex and everything that was revealed because of it. */
  function traceBranch(id) { return [id].concat(TR.descendants(state.trace.prov, id)).filter(function (x) { return state.trace.shown.has(x); }); }
  function traceHideBranch(id) {
    var ids = traceBranch(id), k = traceHideIds(ids);
    if (k) toast('Hid ' + k + (k === 1 ? ' vertex' : ' vertices') + ' (Ctrl+Z brings them back).');
  }
  function traceSelectBranch(id) { state.selected = new Set(traceBranch(id)); state.selectedEdge = null; syncSelection(); }
  function traceSelectAll() { state.selected = new Set(Array.from(state.trace.shown).filter(function (id) { return state.graph.nodes.has(id); })); state.selectedEdge = null; syncSelection(); }

  function traceUndo() {
    var T = state.trace, last = T.undo.pop();
    if (!last) return;
    var back = [];
    if (last.type === 'hide') {
      last.items.forEach(function (it) {
        T.shown.add(it.id); back.push(it.id);
        if (it.pos) T.pos.set(it.id, it.pos);
        if (it.prov) T.prov.set(it.id, it.prov);
        if (it.seed && T.seeds.indexOf(it.id) < 0) T.seeds.push(it.id);
      });
    } else if (last.type === 'seed') {
      T.seeds = T.seeds.filter(function (s) { return s !== last.id; });
      if (last.added) traceDrop(last.id);
    } else last.ids.forEach(traceDrop);
    if (!T.seeds.length && T.shown.size) T.seeds = [Array.from(T.shown)[0]];
    syncSeed(); syncSelection(); traceChanged(back, false);
  }
  function traceReset() {
    var T = state.trace; if (!T.seed) return;
    traceStart(T.seed); state.selected = new Set([T.seed]); syncSelection(); traceChanged(null, true);
  }
  /** [ and ] in a trace: expand the selected wallet or transaction, or the start. */
  function traceKey(dir) {
    var id = Array.from(state.selected).filter(function (x) { return state.trace.shown.has(x) && walletOrTx(x); })[0] || state.trace.seed;
    if (id) traceExpand(id, dir);
  }
  /** Re-run the automatic left-to-right layout over what is shown (positions are otherwise yours). */
  function traceTidy() {
    if (state.arrange !== 'columns') { state.pinned.clear(); refresh({ relayout: true, fit: true }); return; }
    var T = state.trace, vis = F.computeVisible(state.graph, state.filter, state.keep, null, traceOnly());
    L.layoutFlow(state.graph, vis, {}).pos.forEach(function (p, id) { T.pos.set(id, { x: p.x, y: p.y }); });
    traceChanged(null, true);
  }

  /** The trace as plain data for the saved session and the export. */
  function traceData() {
    var T = state.trace; if (!T.seed) return null;
    var pos = {}, prov = {};
    T.pos.forEach(function (p, id) { if (T.shown.has(id)) pos[id] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; });
    T.prov.forEach(function (p, id) { if (T.shown.has(id)) prov[id] = [p.via, p.dir]; });
    return { seed: T.seed, seeds: T.seeds.slice(), shown: Array.from(T.shown), pos: pos, prov: prov };
  }
  function loadTraceData(d) {
    if (!d || typeof d !== 'object' || typeof d.seed !== 'string' || !NV.isId(d.seed)) return false;
    var T = state.trace, shown = new Set(), pos = new Map(), prov = new Map();
    (Array.isArray(d.shown) ? d.shown : []).slice(0, 5000).forEach(function (id) { if (typeof id === 'string' && NV.isId(id)) shown.add(canonicalId(id)); });
    var seed = canonicalId(d.seed); shown.add(seed);
    var seeds = (Array.isArray(d.seeds) ? d.seeds : []).filter(function (id) { return typeof id === 'string' && NV.isId(id); }).map(canonicalId).filter(function (id) { return shown.has(id); });
    if (seeds.indexOf(seed) < 0) seeds.unshift(seed);
    if (d.pos && typeof d.pos === 'object') Object.keys(d.pos).forEach(function (id) {
      var a = d.pos[id]; if (NV.isId(id) && Array.isArray(a) && a.length === 2 && isFinite(a[0]) && isFinite(a[1]) && Math.abs(a[0]) < 1e6 && Math.abs(a[1]) < 1e6) pos.set(canonicalId(id), { x: a[0], y: a[1] });
    });
    if (d.prov && typeof d.prov === 'object') Object.keys(d.prov).forEach(function (id) {
      var a = d.prov[id]; if (NV.isId(id) && Array.isArray(a) && typeof a[0] === 'string' && NV.isId(a[0]) && (a[1] === 'next' || a[1] === 'prev')) prov.set(canonicalId(id), { via: canonicalId(a[0]), dir: a[1] });
    });
    var i = 0;
    shown.forEach(function (id) { if (!pos.has(id)) { pos.set(id, id === seed ? { x: 0, y: 0 } : { x: (i % 8) * 200, y: Math.floor(i / 8) * 60 + 120 }); i++; } });
    T.seed = seeds[0]; T.seeds = seeds; T.shown = shown; T.pos = pos; T.prov = prov; T.undo = [];
    return true;
  }
  /** After a graph was merged in: forget trace vertices that are not in it. */
  function traceSanitize() {
    var T = state.trace, g = state.graph;
    Array.from(T.shown).forEach(function (id) { if (!g.nodes.has(id)) { T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); } });
    syncSeed();
    if (!T.seeds.length && T.shown.size) { T.seeds = [Array.from(T.shown)[0]]; T.seed = T.seeds[0]; }
    if (!T.shown.size) state.trace = emptyTrace();
  }
  /** A vertex was deleted from the workspace altogether. */
  function traceForget(ids) {
    var T = state.trace;
    ids.forEach(function (id) { T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); });
    syncSeed();
    if (!T.seeds.length && T.shown.size) { T.seeds = [Array.from(T.shown)[0]]; T.seed = T.seeds[0]; }
    if (!T.shown.size) state.trace = emptyTrace();
  }

  // ---- Previous / Next: follow the money ------------------------------------------------------
  function stepOpts() { return { viaWallets: state.viaWallets }; }
  function closeStepMenu() {
    var m = $('stepMenu'); if (m.hidden) return;
    m.hidden = true; $('stepPrev').setAttribute('aria-expanded', 'false'); $('stepNext').setAttribute('aria-expanded', 'false');
  }

  var KIND_NAME = { tx: 'Transaction', addr: 'Wallet', coinbase: 'Coinbase', data: 'OP_RETURN', nonstd: 'Output' };

  function renderStepBar() {
    var bar = $('stepbar'), g = state.graph, id = state.focus, n = id && g.nodes.get(id);
    closeStepMenu();
    if (!n || traceOn()) { bar.hidden = true; return; }
    bar.hidden = false;
    var c = ST.counts(g, id, stepOpts());
    [['prev', c.prev, $('stepPrev'), $('stepPrevN')], ['next', c.next, $('stepNext'), $('stepNextN')]].forEach(function (x) {
      x[2].disabled = x[1] === 0; x[3].textContent = x[1] ? String(x[1]) : '';
      x[2].title = x[1] === 0 ? ST.emptyReason(g, id, x[0], stepOpts()) : (x[0] === 'prev' ? 'Where the money came from ([)' : 'Where the money went (])');
    });
    $('stepKind').textContent = KIND_NAME[n.type] || 'Vertex';
    $('stepName').textContent = focusLabel(id).replace(/^tx /, '');
    var sc = $('stepCopy'), plain = n.type === 'tx' ? n.txid : n.type === 'addr' ? n.address : null, what = n.type === 'tx' ? 'transaction id' : 'address';
    sc.hidden = !plain; sc.title = 'Copy ' + what; sc.setAttribute('aria-label', 'Copy ' + what); sc.onclick = plain ? function () { copy(plain, what); sc.classList.add('done'); setTimeout(function () { sc.classList.remove('done'); }, 1200); } : null;
    var amt = '';
    if (n.type === 'tx') amt = (n.time != null ? S.fmtTime(n.time, false) + ' · ' : n.confirmed === false ? 'unconfirmed · ' : '') + (n.loaded ? amountText(n.valueOut, n.time) : 'not loaded');
    else if (n.type === 'addr') amt = 'received ' + mixText(S.fmtBtc(n.received) + ' BTC', fiatSum(n, true)) + (n.txCount != null ? ' · ' + fmtInt(n.txCount) + ' txs on chain' : ' · history not loaded');
    $('stepAmt').textContent = amt;
    var load = $('stepLoad');
    load.hidden = !(n.type === 'addr' && (n.txCount == null || n.histNext));
    load.textContent = n.histNext ? 'Load more history' : 'Load history';
  }

  /** Describe one step row for the list: { what, sub, amt, title }. */
  function stepRowText(r) {
    var g = state.graph, node = r.id && g.nodes.get(r.id), via = r.via && g.nodes.get(r.via);
    var viaText = via ? 'via ' + focusLabel(via.id) : '';
    var what, sub = '';
    if (r.type === 'addr') {
      what = focusLabel(r.id);
      var known = node && node.address && KNOWN[node.address];
      if (known && node.label) what += ' (' + known.label + ')';              // without your own label the known one is already the name
      sub = r.spent === true ? 'spent' + (r.spender ? ' in ' + S.shortId(r.spender, 5) : '') : r.spent === false ? 'unspent so far' : '';
    } else if (r.type === 'tx') {
      what = 'tx ' + S.shortId(node ? node.txid : r.id.slice(3), 6);
      sub = [node && node.time != null ? S.fmtTime(node.time, false) : (node && node.confirmed === false ? 'unconfirmed' : ''), viaText, node && node.loaded === false ? 'not loaded yet' : ''].filter(Boolean).join(' · ');
    } else {
      what = r.type === 'coinbase' ? 'Coinbase' : r.type === 'unspent' ? 'Unspent output' : r.type === 'data' ? 'OP_RETURN data' : 'Non-standard output';
      sub = [r.note, viaText].filter(Boolean).join(' · ');
    }
    if (r.count > 1) sub = (sub ? sub + ' · ' : '') + r.count + ' transfers';
    return { what: what, sub: sub, amt: mixText(S.fmtBtc(r.amount) + ' BTC', fiatOf(r.amount, r.time)) };
  }

  function openStepMenu(dir) {
    var g = state.graph, rows = ST.neighbours(g, state.focus, dir, stepOpts()), menu = $('stepMenu');
    menu.textContent = '';
    menu.appendChild(el('div', { 'class': 'menuhead', text: dir === 'prev' ? 'Previous: where the money came from' : 'Next: where the money went' }));
    rows.forEach(function (r) {
      var t = stepRowText(r), kids = [el('span', { 'class': 'what' }, [t.what, t.sub ? el('small', { text: t.sub }) : null]), el('span', { 'class': 'amt', text: t.amt })];
      if (r.navigable) {
        var rowBtn = el('button', { type: 'button', 'class': 'steprow', role: 'menuitem', title: r.id, onclick: function () { closeStepMenu(); stepTo(r); } }, kids);
        menu.appendChild(/^(tx|addr):/.test(r.id) ? el('div', { 'class': 'steprowwrap' }, [rowBtn, copyBtn(plainId(r.id), r.id.indexOf('tx:') === 0 ? 'transaction id' : 'address')]) : rowBtn);
      }
      else menu.appendChild(el('div', { 'class': 'steprow info' }, kids));
    });
    $('toast').hidden = true;
    menu.style.left = dir === 'prev' ? '0' : 'auto'; menu.style.right = dir === 'next' ? '0' : 'auto';
    menu.hidden = false;
    $('stepPrev').setAttribute('aria-expanded', String(dir === 'prev')); $('stepNext').setAttribute('aria-expanded', String(dir === 'next'));
    var first = menu.querySelector('button'); if (first) first.focus();
  }

  function stepTo(row) { navigate(row.id, { light: true }); }

  /** Previous / Next: one place to go means going; several open the list. */
  function stepClick(dir) {
    if (!state.focus || !state.graph.nodes.has(state.focus)) return;
    var menuOpenFor = !$('stepMenu').hidden && $('stepMenu').firstChild && $('stepMenu').firstChild.textContent.indexOf(dir === 'prev' ? 'Previous' : 'Next') === 0;
    if (menuOpenFor) { closeStepMenu(); return; }
    var go = ST.neighbours(state.graph, state.focus, dir, stepOpts()).filter(function (r) { return r.navigable; });
    if (!go.length) { toast(ST.emptyReason(state.graph, state.focus, dir, stepOpts())); return; }
    if (go.length === 1) { stepTo(go[0]); return; }
    openStepMenu(dir);
  }

  /** Back / forward by `delta` steps through the trail. */
  function stepNav(delta) {
    var target = state.nav.index + delta;
    if (target < 0 || target >= state.nav.entries.length || !delta) return;
    if (state.histOk) window.history.go(delta);                        // the popstate handler does the rest
    else { var id = state.nav.goto(target); if (id) navigate(id, { fromHistory: true }); }
  }

  function onPopState() {
    var p = NV.parseHash(window.location.hash);
    if (!p) return;
    p.id = canonicalId(p.id);
    if (state.nav.entries[p.index] === p.id) {
      if (p.index !== state.nav.index) { state.nav.goto(p.index); navigate(p.id, { fromHistory: true }); }
    } else {                                                           // an address typed or shared by hand
      state.nav.reset(); navigate(p.id);
    }
  }

  function expandNode(id, direction) {
    var n = state.graph.nodes.get(id); if (!n) return;
    if (n.type === 'tx') {
      var dirLabel = direction === 'forward' ? 'spenders' : direction === 'backward' ? 'funding transactions' : 'both directions';
      run('Expand ' + S.shortId(n.txid, 6) + ' (' + dirLabel + ')', function () { return state.explorer.expandTx(n.txid, direction || 'both', state.capTx); });
    } else if (n.type === 'addr') {
      var more = n.histNext;
      run((more ? 'More history of ' : 'History of ') + S.shortId(n.address, 8), function () {
        return state.explorer.expandAddress(n.address, { pages: state.capPages, cap: state.capPages * 25, after: more || undefined }).then(function (r) {
          var node = state.graph.nodes.get(id);
          if (node) { node.histNext = r.last || null; node.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); }
          return r;
        });
      }).then(function () { showInspector(); });
    } else {
      toast('Nothing to expand here: this is a ' + (n.type === 'coinbase' ? 'coinbase (newly created coins)' : n.type === 'data' ? 'OP_RETURN data output' : 'non-standard output') + '.');
    }
  }

  // ---- hiding and selecting, in every layout -----------------------------------------------------
  // Hiding never deletes: a hidden vertex stays loaded, every hide can be undone, and what you hid is saved with the session.
  // (In the Trace layout the same buttons work on what the trace shows: see traceHideIds.)
  function hiddenOpt() { return traceOn() || !state.hidden.size ? null : state.hidden; }
  function hiddenCount() { var k = 0; state.hidden.forEach(function (id) { if (state.graph.nodes.has(id)) k++; }); return k; }
  function visibleIds() { return renderer && renderer.data ? Array.from(renderer.data.visible.nodes) : []; }
  function afterHide() { afterGraphChange(); syncSelection(); scheduleSave(); }

  /** Hide vertices (outside a trace). The focused vertex stays: the Focus view needs it. Returns how many were hidden. */
  function hideIds(ids) {
    if (traceOn()) return traceHideIds(ids);
    var g = state.graph, list = [], skipped = false;
    ids.forEach(function (id) {
      if (!g.nodes.has(id) || state.hidden.has(id) || list.indexOf(id) >= 0) return;
      if (state.focusOn && state.focus === id) { skipped = true; return; }
      list.push(id);
    });
    if (!list.length) { if (skipped) toast('The focused vertex stays: move the focus first, or untick Focus.'); return 0; }
    list.forEach(function (id) { state.hidden.add(id); state.selected.delete(id); });
    state.selectedEdge = null; state.hideUndo.push({ type: 'hide', ids: list });
    if (skipped) toast('The focused vertex was not hidden: move the focus first, or untick Focus.');
    afterHide();
    return list.length;
  }
  function showIds(ids) {
    var list = ids.filter(function (id) { return state.hidden.has(id); });
    if (!list.length) return 0;
    list.forEach(function (id) { state.hidden.delete(id); });
    state.hideUndo.push({ type: 'show', ids: list }); afterHide();
    return list.length;
  }
  function hideUndoLast() {
    var e = state.hideUndo.pop(); if (!e) return;
    e.ids.forEach(function (id) { if (e.type === 'hide') state.hidden.delete(id); else state.hidden.add(id); });
    afterHide();
  }
  function undoLast() { if (traceOn()) traceUndo(); else hideUndoLast(); }
  function hideSelected() {
    if (traceOn()) { traceHideSelected(); return; }
    var ids = Array.from(state.selected).filter(function (id) { return state.graph.nodes.has(id); });
    if (!ids.length) { toast('Select the vertices to hide first (click, Shift-click, drag a box, or use Select).'); return; }
    var k = hideIds(ids);
    if (k) toast('Hid ' + plural(k, 'vertex', 'vertices') + ' (they stay loaded; Ctrl+Z brings them back).');
  }
  function keepOnly(ids) {
    if (traceOn()) { traceKeepOnly(ids); return; }
    var vis = visibleIds(), keep = new Set(ids.filter(function (id) { return vis.indexOf(id) >= 0; }));
    if (!keep.size) { toast('Select the vertices to keep first.'); return; }
    var rest = vis.filter(function (id) { return !keep.has(id); });
    if (!rest.length) { toast('Everything shown is selected: nothing to hide.'); return; }
    var k = hideIds(rest);
    if (k) toast('Kept ' + keep.size + ', hid ' + k + ' (Ctrl+Z brings them back).');
  }
  function hideBtn(ids) {
    if (traceOn()) return null;                                                     // in a trace the "Hide … from the trace" button is the hide
    return el('button', { type: 'button', text: ids.length > 1 ? 'Hide ' + ids.length : 'Hide', title: 'Take off the screen; it stays loaded and Ctrl+Z brings it back',
                          onclick: function () { var k = hideIds(ids); if (k) toast('Hid ' + plural(k, 'vertex', 'vertices') + ' (Ctrl+Z brings them back).'); } });
  }

  function setSel(ids) { state.selected = new Set(ids); state.selectedEdge = null; syncSelection(); }
  function selectAllVisible() { setSel(visibleIds()); }
  function setBoxMode(on) {
    state.boxMode = !!on; renderer.boxMode = state.boxMode;
    document.body.classList.toggle('box-mode', state.boxMode); $('boxSel').setAttribute('aria-pressed', String(state.boxMode));
    renderer.canvas.style.cursor = state.boxMode ? 'crosshair' : 'grab';
  }
  /** Keep only the wallets (or only the transactions) of the current selection. */
  function narrowSelection(type) { setSel(Array.from(state.selected).filter(function (id) { var n = state.graph.nodes.get(id); return n && n.type === type; })); }

  /** What a balance is worth now (today's price, whatever basis the rest of the view uses): {text, title, approx} or null. */
  function fiatToday(sats) {
    if (sats == null || !fiatOn()) return null;
    var td = todayRate(); if (!td) return null;
    var cur = state.fiat.currency, v = PR.convert(sats, td.price);
    return { value: v, text: PR.format(v, cur), approx: false, title: PR.format(td.price, cur) + ' per BTC today' };
  }
  /** Read the totals the server keeps for these addresses (what they hold now): one request each. */
  function loadBalances(ids) {
    var g = state.graph, addrs = ids.map(function (id) { var n = g.nodes.get(id); return n && n.type === 'addr' ? n.address : null; }).filter(Boolean);
    if (!addrs.length) { toast('Select wallets to read the balance of.'); return Promise.resolve(null); }
    return run('Read ' + plural(addrs.length, 'balance'), function () { return state.explorer.loadBalances(addrs, 100); }).then(function (r) { showInspector(true); return r; });
  }
  function balanceText(b) { return S.fmtBtc(b.confirmed) + ' BTC'; }
  /** The balance rows of one wallet's details, or what to do to get them. */
  function balanceRows(dl, n, box) {
    var b = balanceOf(n);
    if (!b) {
      dl.appendChild(el('dt', { text: 'Balance' })); dl.appendChild(el('dd', { text: 'not loaded yet' }));
      return el('button', { type: 'button', text: 'Load balance', title: 'Ask the server what this wallet holds now (one request, no history)', onclick: function () { loadBalances([n.id]); } });
    }
    kvf(dl, 'Balance', balanceText(b), fiatToday(b.confirmed));
    if (b.pending) kv(dl, 'Unconfirmed', (b.pending > 0 ? '+' : '') + S.fmtBtc(b.pending) + ' BTC (not in the balance above)');
    kv(dl, 'On chain', 'received ' + S.fmtBtc(b.received) + ' BTC, sent ' + S.fmtBtc(b.sent) + ' BTC');
    if (n.statsAt != null) kv(dl, 'Balance as of', S.fmtTimeFull(n.statsAt) + (n.statsSource ? ' from ' + n.statsSource.replace(/^https?:\/\//i, '').replace(/\/api\/?$/, '') : ''));
    return null;
  }

  /** The balance of every selected wallet in one list, largest first, with the total of those that are known. */
  function balanceList(addrIds) {
    var g = state.graph, rows = [], total = 0, known = 0, unknown = [];
    addrIds.forEach(function (id) {
      var n = g.nodes.get(id), b = balanceOf(n);
      if (b) { rows.push({ id: id, n: n, b: b }); total += b.confirmed; known++; } else unknown.push(id);
    });
    rows.sort(function (a, c) { return c.b.confirmed - a.b.confirmed; });
    var list = el('div', { 'class': 'balrows' });
    rows.slice(0, 30).forEach(function (r) {
      var who = r.n.label || (KNOWN[r.n.address] && KNOWN[r.n.address].label) || S.shortId(r.n.address, 8), fx = fiatToday(r.b.confirmed);
      list.appendChild(withCopy(el('div', { 'class': 'balrow', title: r.n.address + (fx ? ' · ' + fx.text : '') }, [el('span', { text: who }), el('span', { 'class': 'amt', text: balanceText(r.b) })]), r.n.address, 'address'));
    });
    if (rows.length > 30) list.appendChild(el('div', { 'class': 'hint', text: '… and ' + (rows.length - 30) + ' more' }));
    var kids = [el('span', { 'class': 'lbl', text: 'Balances (' + addrIds.length + ' wallet' + (addrIds.length === 1 ? '' : 's') + ')' })];
    if (known) { var dl = el('dl', { 'class': 'kv' }); kvf(dl, 'Total of ' + known, S.fmtBtc(total) + ' BTC', fiatToday(total)); kids.push(dl); kids.push(list); }
    if (unknown.length) {
      kids.push(el('p', { 'class': 'hint', text: plural(unknown.length, 'wallet') + (known ? ' not loaded yet.' : ': balances not loaded yet.') }));
      kids.push(el('div', { 'class': 'insp-actions' }, [el('button', { type: 'button', text: 'Load ' + plural(unknown.length, 'balance'), title: 'One request per wallet, no history', onclick: function () { loadBalances(unknown); } })]));
    }
    return el('div', { 'class': 'insp-section' }, kids);
  }

  /** The Select menu: everything on screen, by kind, by amount, by tag. */
  function openSelectMenu() {
    var m = $('ctxMenu'), g = state.graph, vis = visibleIds(), r = $('selMenu').getBoundingClientRect();
    closeStepMenu(); $('tooltip').hidden = true; m.textContent = '';
    function ofType(t) { return vis.filter(function (id) { var n = g.nodes.get(id); return n && n.type === t; }); }
    var wallets = ofType('addr'), txs = ofType('tx');
    m.appendChild(el('div', { 'class': 'ctxhead', text: 'Select (what is on screen)' }));
    ctxItem(m, 'All', function () { selectAllVisible(); }, { right: vis.length + ' · Ctrl+A' });
    ctxItem(m, 'None', function () { setSel([]); }, { disabled: !state.selected.size });
    ctxItem(m, 'Invert', function () { var cur = state.selected; setSel(vis.filter(function (id) { return !cur.has(id); })); });
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, 'All wallets', function () { setSel(wallets); }, { right: String(wallets.length), disabled: !wallets.length });
    ctxItem(m, 'All transactions', function () { setSel(txs); }, { right: String(txs.length), disabled: !txs.length });
    m.appendChild(el('div', { 'class': 'sep' }));
    var input = el('input', { type: 'number', min: '0', step: 'any', value: '0.1', 'aria-label': 'Amount in BTC', style: 'width:90px' });
    function byAmount(types) {
      var sats = Math.round(Number(input.value) * 1e8);
      if (!isFinite(sats) || sats < 0) { toast('Enter an amount in BTC.', true); return; }
      var vs = renderer.data.visible;
      var ids = vis.filter(function (id) { var n = g.nodes.get(id); return n && types.indexOf(n.type) >= 0 && L.vertexAmount(g, vs, id) >= sats; });
      closeCtx(); setSel(ids); toast(plural(ids.length, 'vertex', 'vertices') + ' of ' + S.fmtBtc(sats) + ' BTC or more selected.');
    }
    m.appendChild(el('div', { 'class': 'chooserfoot' }, [el('span', { text: 'Amount ≥' }), input, el('span', { text: 'BTC' })]));
    m.appendChild(el('div', { 'class': 'chooserfoot' }, [
      el('button', { type: 'button', text: 'Wallets', onclick: function () { byAmount(['addr']); } }), el('button', { type: 'button', text: 'Transactions', onclick: function () { byAmount(['tx']); } }),
      el('button', { type: 'button', text: 'Both', onclick: function () { byAmount(['addr', 'tx']); } })]));
    var tags = TG.summarise(Array.from(g.nodes.values()));
    if (tags.length) {
      m.appendChild(el('div', { 'class': 'sep' }));
      tags.forEach(function (t) {
        var ids = vis.filter(function (id) { var n = g.nodes.get(id); return n && n.tag === t.tag; });
        ctxItem(m, 'Tagged ' + t.tag, function () { setSel(ids); }, { right: String(ids.length), disabled: !ids.length, glyph: SHAPE_GLYPH[t.shape] || '●', glyphColor: t.color });
      });
    }
    placeCtx({ x: r.left, y: r.bottom + 4 });
  }

  /** The Hidden menu: the vertices you hid, to show some or all of them again. */
  function openHiddenMenu() {
    var g = state.graph, ids = Array.from(state.hidden).filter(function (id) { return g.nodes.has(id); }), r = $('hiddenBtn').getBoundingClientRect();
    if (!ids.length) { toast('Nothing is hidden.'); return; }
    ids.sort(function (a, b) { return L.vertexAmount(g, null, b) - L.vertexAmount(g, null, a); });
    var m = $('ctxMenu'); m.textContent = ''; closeStepMenu(); $('tooltip').hidden = true;
    m.appendChild(el('div', { 'class': 'ctxhead', text: 'Hidden · ' + ids.length }));
    var boxes = [], list = el('div', { 'class': 'chooser' });
    ids.slice(0, 300).forEach(function (id) {
      var n = g.nodes.get(id), cb = el('input', { type: 'checkbox', 'aria-label': focusLabel(id) });
      cb.addEventListener('change', count); boxes.push({ cb: cb, id: id });
      list.appendChild(el('label', { 'class': 'chooserrow' }, [cb, el('span', { 'class': 'what' }, [focusLabel(id), el('small', { text: (KIND_NAME[n.type] || 'Vertex') + (n.tag ? ' · ' + n.tag : '') })]), el('span', { 'class': 'amt', text: S.fmtBtcShort(L.vertexAmount(g, null, id)) })]));
    });
    m.appendChild(list);
    if (ids.length > 300) m.appendChild(el('div', { 'class': 'hint', text: '… and ' + (ids.length - 300) + ' more (Show all brings them back)' }));
    var go = el('button', { type: 'button', 'class': 'primary', onclick: function () {
      var pick = boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.id; });
      closeCtx(); if (pick.length) { var k = showIds(pick); toast('Showing ' + plural(k, 'vertex', 'vertices') + ' again.'); }
    } });
    function count() { var k = boxes.filter(function (b) { return b.cb.checked; }).length; go.textContent = 'Show ' + k + ' selected'; go.disabled = !k; }
    m.appendChild(el('div', { 'class': 'chooserfoot' }, [go,
      el('button', { type: 'button', text: 'Show all ' + ids.length, onclick: function () { closeCtx(); var k = showIds(ids); toast('Showing ' + plural(k, 'vertex', 'vertices') + ' again.'); } }),
      el('button', { type: 'button', text: 'Cancel', onclick: closeCtx })]));
    count(); placeCtx({ x: r.left, y: r.bottom + 4 });
  }

  // ---- how a trace is arranged: columns you build, or spread over time / by force / by time and amount ----
  function timeScaleOn() { return state.layout === 'timeline' || (traceOn() && !!TIME_ARR[state.arrange]); }           // x IS time: a real axis, with its scale choice
  /** Columns in a trace: x is not time, but the transactions on screen have times, so the line over them carries their timestamps. */
  function marksOn() {
    if (!traceOn() || state.arrange !== 'columns') return false;
    var any = false;
    state.trace.shown.forEach(function (id) { var n = state.graph.nodes.get(id); if (n && n.type === 'tx' && n.time != null) any = true; });
    return any;
  }
  function usesAxis() { return timeScaleOn() || marksOn(); }
  function updateScaleRow() { $('scaleRow').hidden = !timeScaleOn(); }
  function setArrange(name) {
    if (!ARRANGE[name]) return;
    state.arrange = name; $('traceArrange').value = name; updateScaleRow();
    state.pinned.clear(); state.layoutRes = null; refresh({ relayout: true, fit: true }); scheduleSave();
  }

  // ---- selection and inspector ----------------------------------------------------------------
  function selectOnly(id) { state.selected = id ? new Set([id]) : new Set(); state.selectedEdge = null; syncSelection(); }
  function syncSelection() {
    renderer.setSelection(Array.from(state.selected)); renderer.selectedEdge = state.selectedEdge;
    showInspector(); updateTraceUi(); updateAutoUi();
  }

  /** Put text on the clipboard. `what` names it in the message ("address", "3 transaction ids"). Falls back to the old way where the clipboard API is not offered. */
  function copy(text, what) {
    var done = function () { toast(what ? 'Copied ' + what + '.' : 'Copied.'); };
    function legacy() {
      try {
        var ta = el('textarea', { readonly: 'readonly', 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
        ta.value = text; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { if (legacy()) done(); else toast('Could not copy; select the text manually.', true); });
    else if (legacy()) done();
    else toast('Copy is not available in this browser.', true);
  }
  var NL = String.fromCharCode(10);
  /** The address or transaction id inside a vertex id ("tx:abc" -> "abc"). */
  function plainId(id) { return /^(tx|addr):/.test(id) ? id.slice(id.indexOf(':') + 1) : id; }
  function copyIconSvg() {
    var NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
    ['viewBox', '0 0 16 16', 'width', '13', 'height', '13', 'fill', 'none', 'stroke', 'currentColor', 'stroke-width', '1.5', 'stroke-linecap', 'round', 'stroke-linejoin', 'round', 'aria-hidden', 'true'].forEach(function (v, i, a) { if (i % 2 === 0) s.setAttribute(v, a[i + 1]); });
    var back = document.createElementNS(NS, 'path'); back.setAttribute('d', 'M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5');
    var front = document.createElementNS(NS, 'rect'); ['x', '5', 'y', '5', 'width', '9', 'height', '9', 'rx', '1.5'].forEach(function (v, i, a) { if (i % 2 === 0) front.setAttribute(v, a[i + 1]); });
    s.appendChild(back); s.appendChild(front);
    return s;
  }
  /** A small copy icon: copies `text`, flashes green, and says what it copied. */
  function copyBtn(text, what) {
    var b = el('button', { type: 'button', 'class': 'copybtn', title: 'Copy ' + what, 'aria-label': 'Copy ' + what,
                           onclick: function (e) { e.stopPropagation(); copy(text, what); b.classList.add('done'); setTimeout(function () { b.classList.remove('done'); }, 1200); } });
    b.appendChild(copyIconSvg());
    return b;
  }
  /** An element with a copy icon beside it (the element stays whatever it was: a row you can click keeps working). */
  function withCopy(node, text, what) { return el('div', { 'class': 'rowcopy' }, [node, copyBtn(text, what)]); }
  /** An id shown in full with its copy icon. */
  function idRow(text, what) { return el('div', { 'class': 'idrow' }, [el('span', { 'class': 'mono', text: text }), copyBtn(text, what)]); }
  /** What a set of vertices is made of for copying: the addresses and the transaction ids among them. */
  function idLists(ids) {
    var g = state.graph, addrs = [], txs = [];
    ids.forEach(function (id) { var n = g.nodes.get(id); if (!n) return; if (n.type === 'addr') addrs.push(n.address); else if (n.type === 'tx') txs.push(n.txid); });
    return { addrs: addrs, txs: txs };
  }
  function copyButtons(ids) {
    var l = idLists(ids), out = [];
    if (l.addrs.length) out.push(el('button', { type: 'button', text: 'Copy ' + plural(l.addrs.length, 'address', 'addresses'), title: 'One per line', onclick: function () { copy(l.addrs.join(NL), plural(l.addrs.length, 'address', 'addresses')); } }));
    if (l.txs.length) out.push(el('button', { type: 'button', text: 'Copy ' + plural(l.txs.length, 'transaction id'), title: 'One per line', onclick: function () { copy(l.txs.join(NL), plural(l.txs.length, 'transaction id')); } }));
    return out;
  }
  /** Ctrl+C on the graph: the selected addresses and transaction ids, one per line. False when there is nothing to copy (or text is selected, which keeps its normal copy). */
  function copySelection() {
    var sel = window.getSelection && window.getSelection().toString();
    if (sel) return false;
    var l = idLists(Array.from(state.selected));
    var lines = l.addrs.concat(l.txs);
    if (!lines.length) return false;
    copy(lines.join(NL), lines.length === 1 ? (l.addrs.length ? 'the address' : 'the transaction id') : (l.addrs.length ? plural(l.addrs.length, 'address', 'addresses') : '') + (l.addrs.length && l.txs.length ? ' and ' : '') + (l.txs.length ? plural(l.txs.length, 'transaction id') : ''));
    return true;
  }
  function kv(dl, k, v) { if (v === null || v === undefined || v === '') return; dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: String(v) })); }
  /** A row with a Bitcoin amount and, when conversion is on, its fiat value beside it. */
  function kvf(dl, k, btcText, fx) {
    var mode = fiatOn() && fx ? state.fiat.show : 'btc';
    dl.appendChild(el('dt', { text: k }));
    if (mode === 'fiat') {
      var sp = fiatSpan(fx); sp.className += ' primary'; sp.title = fx.title + ' · ' + btcText;
      dl.appendChild(el('dd', {}, [sp]));
    } else dl.appendChild(el('dd', { text: btcText }, mode === 'both' ? [fiatSpan(fx)] : []));
  }
  /** One line of text for an amount, following the chosen display (Bitcoin / both / fiat). */
  function mixText(btcText, fx) {
    var mode = fiatOn() && fx ? state.fiat.show : 'btc';
    return mode === 'fiat' ? fx.text : mode === 'both' ? btcText + ' · ' + fx.text : btcText;
  }
  function amountText(sats, time) { return mixText(S.fmtBtc(sats) + ' BTC', fiatOn() ? fiatOf(sats, time) : null); }

  var edgeLabelCache = new Map();
  /** The short text drawn along an edge. Cached until the data or the display choice changes. */
  function edgeLabelFor(e) {
    var hit = edgeLabelCache.get(e.id); if (hit !== undefined) return hit;
    var fx = fiatOn() ? fiatOfEdge(e) : null, mode = fx ? state.fiat.show : 'btc', btc = S.fmtBtcShort(e.amount);
    var t = mode === 'fiat' ? fx.text : mode === 'both' ? btc + ' · ' + fx.text : btc;
    var cm = state.analysis.change && state.an ? state.an.changeEdges.get(e.id) : null;
    if (cm) t += ' · ' + (cm.confidence === 'high' ? 'likely change' : 'change?');
    edgeLabelCache.set(e.id, t);
    return t;
  }
  function fiatSpan(fx) { return el('span', { 'class': 'fiat' + (fx.approx ? ' approx' : ''), title: fx.title, text: fx.text }); }

  // ---- fiat conversion ------------------------------------------------------------------------
  function fiatOn() { return state.fiat.currency !== 'off'; }

  /** Today's price, or null when not loaded. */
  function todayRate() { return state.today ? PR.parseToday(state.today, state.fiat.currency) : null; }

  /**
   * The price to use for something that happened at `time` (unix seconds; null = not confirmed yet), following the
   * chosen basis. Returns {price, label, approx, note} or null when the prices are not loaded (yet).
   */
  function fiatRate(time) {
    var f = state.fiat;
    if (f.currency === 'off') return null;
    var basis = f.basis, t = time;
    if (basis === 'ref') { if (f.ref) t = f.ref.time; else basis = 'today'; }
    if (basis === 'today' || t == null) {
      var td = todayRate(); if (!td) return null;
      var when = td.time ? S.fmtTime(td.time, false) : 'today';
      return { price: td.price, label: 'today ' + when, approx: false, note: basis === 'today' ? "today's price" : 'not confirmed yet, so today\'s price' };
    }
    var book = state.books[f.currency]; if (!book) return null;
    var r = book.rateAt(t); if (!r) return null;
    var note = r.derived ? 'USD price converted at today\'s exchange rate (no ' + f.currency + ' data that early)' : r.outside ? 'outside the price history, nearest point used'
             : r.approx ? 'interpolated between price points ' + r.spanDays.toFixed(1) + ' days apart' : 'hourly/daily data';
    return { price: r.price, label: S.fmtTime(t, false), approx: r.approx, note: note };
  }

  /** {value, text, title, approx, rate} for `sats` at `time`, or null. */
  function fiatOf(sats, time) {
    if (sats == null) return null;
    var r = fiatRate(time); if (!r) return null;
    var v = PR.convert(sats, r.price), cur = state.fiat.currency;
    return { value: v, text: (r.approx ? '≈ ' : '') + PR.format(v, cur), approx: r.approx, rate: r,
             title: PR.format(r.price, cur) + ' per BTC at ' + r.label + ' (' + r.note + ')' };
  }
  /** The moment an edge's amount is worth: its transaction's time; for a transaction not loaded yet, when its output was spent. */
  function edgeMoment(e) {
    var t = F.edgeTime(state.graph, e);
    if (t != null) return t;
    var tx = state.graph.nodes.get(e.kind === 'out' ? e.source : e.target);
    if (tx && tx.confirmed === false) return null;                                       // genuinely unconfirmed: today's price
    return e.spentBy && e.spentBy.time != null ? e.spentBy.time : null;
  }
  function fiatOfEdge(e) { return fiatOf(e.amount, edgeMoment(e)); }

  /** Sum over an address's edges, each at its own transaction's time: what it received or sent. */
  function fiatSum(n, received) {
    var sum = 0, any = false, approx = false, cur = state.fiat.currency;
    state.graph.edgesOf(n.id).forEach(function (e) {
      var hit = received ? (e.kind === 'out' && e.target === n.id) : (e.kind === 'in' && e.source === n.id);
      if (!hit) return;
      var x = fiatOfEdge(e); if (!x) return;
      sum += x.value; any = true; approx = approx || x.approx;
    });
    if (!any) return null;
    return { value: sum, approx: approx, text: (approx ? '≈ ' : '') + PR.format(sum, cur),
             title: 'Sum of each transfer converted at its own ' + (state.fiat.basis === 'today' ? "(today's)" : state.fiat.basis === 'ref' ? '(reference)' : 'transaction') + ' price' };
  }

  function fiatLoaded() {
    var f = state.fiat;
    if (f.currency === 'off') return false;
    return !!state.today && (f.basis === 'today' || !!state.books[f.currency]);
  }

  /** For exports: edge -> {value, currency, price, basis} as strings, or null. */
  function exportFiat() {
    if (!fiatOn()) return null;
    var cur = state.fiat.currency;
    return function (e) {
      var x = fiatOfEdge(e); if (!x) return null;
      return { value: PR.plain(x.value, cur), currency: cur, price: String(Math.round(x.rate.price * 100) / 100), basis: x.rate.label + (x.approx ? ' ~' : '') };
    };
  }

  function setFiatStatus(text, bad) { var s = $('fiatStatus'); s.textContent = text; s.style.color = bad ? 'var(--danger)' : ''; }

  function updateFiatStatus() {
    var f = state.fiat;
    if (f.currency === 'off') { setFiatStatus(''); return; }
    if (state.fiatError) { setFiatStatus(state.fiatError, true); return; }
    var parts = [], book = state.books[f.currency], td = todayRate();
    if (!priceBase()) { setFiatStatus('Prices need a mempool-compatible server: enter your URL under Data source or pick another source.', true); return; }
    if (td) parts.push('1 BTC = ' + PR.format(td.price, f.currency) + ' today');
    if (book && f.basis !== 'today') parts.push('history to ' + S.fmtTime(book.lastTime(), false) + ' (' + fmtInt(book.size()) + ' points)');
    if (f.basis === 'ref' && !f.ref) parts.push('no reference transaction chosen: using today\'s price');
    if (!parts.length) parts.push('Prices not loaded yet.');
    var base = priceBase();
    setFiatStatus('Prices from ' + (base === A.ONION ? 'mempool.space over Tor' : base.replace(/^https?:\/\//, '').replace(/\/api\/?$/, '')) + '. ' + parts.join(' · '));
  }

  function syncFiatUi() {
    var f = state.fiat, on = fiatOn();
    $('fiatCur').value = f.currency;
    Array.prototype.forEach.call(document.querySelectorAll('input[name=fiatBasis]'), function (r) { r.disabled = !on; r.checked = r.value === f.basis; });
    $('fiatPick').disabled = !on;
    Array.prototype.forEach.call($('showSeg').querySelectorAll('button'), function (b) { b.disabled = !on; b.setAttribute('aria-checked', String(b.getAttribute('data-show') === f.show)); });
    var ab = $('btnAmounts'); ab.hidden = !on;
    ab.textContent = f.show === 'btc' ? '₿ only' : f.show === 'fiat' ? f.currency + ' only' : '₿ + ' + f.currency;
    $('fiatRefRow').hidden = f.basis !== 'ref';
    $('fiatRef').textContent = f.ref ? 'tx ' + S.shortId(f.ref.txid, 5) + ' · ' + S.fmtTime(f.ref.time) : 'none chosen';
    updateFiatStatus();
  }

  /** Fetch whatever prices the current choice needs, then redraw what shows amounts. */
  function ensurePrices() {
    var f = state.fiat; state.fiatError = '';
    if (f.currency === 'off') { syncFiatUi(); refreshFiatViews(); return Promise.resolve(); }
    var pc = state.priceClient, cur = f.currency, jobs = [];
    if (!pc) { state.fiatError = 'Prices need a mempool-compatible server: enter your URL under Data source or pick another source.'; syncFiatUi(); return Promise.resolve(); }
    pc.resume();
    if (!state.today || Date.now() - state.todayAt > 600000) jobs.push(pc.prices().then(function (j) { state.today = j; state.todayAt = Date.now(); }));
    if (f.basis !== 'today' && !state.books[cur]) {
      jobs.push(pc.historicalPrices(cur).then(function (j) {
        var b = new PR.PriceBook(j, cur);
        if (!b.size() && !b.usd.length) throw new Error('the server returned no price history');
        state.books[cur] = b;
      }));
    }
    if (!jobs.length) { syncFiatUi(); refreshFiatViews(); return Promise.resolve(); }
    setFiatStatus('Loading prices…');
    return Promise.all(jobs).catch(function (e) {
      state.fiatError = 'Could not load prices: ' + (e && e.message ? e.message : e) + (state.source === 'tor' ? ' (the onion service may not offer prices; try another source)' : '');
    }).then(function () { syncFiatUi(); refreshFiatViews(); updateReqStats(); });
  }

  function refreshFiatViews() { $('tooltip').hidden = true; showInspector(); refresh(); renderStepBar(); }

  function setShow(mode) {
    if (mode !== 'btc' && mode !== 'both' && mode !== 'fiat') return;
    state.fiat.show = mode; savePrefs(); scheduleSave(); syncFiatUi(); refreshFiatViews();
  }

  /** Make `n` (a confirmed transaction) the one moment every amount is converted at. */
  function setRef(n) {
    if (!n || n.type !== 'tx' || n.time == null) { toast('Choose a confirmed transaction: it needs a timestamp.', true); return; }
    if (!fiatOn()) state.fiat.currency = 'USD';
    state.fiat.ref = { txid: n.txid, time: n.time }; state.fiat.basis = 'ref';
    savePrefs(); scheduleSave(); syncFiatUi(); ensurePrices();
  }
  /** The transaction to use as the price moment: the selected confirmed one, else the focused one. */
  function refCandidate() {
    var g = state.graph, ok = function (n) { return n && n.type === 'tx' && n.time != null; };
    var sel = Array.from(state.selected).map(function (id) { return g.nodes.get(id); }).filter(ok)[0];
    if (sel) return sel;
    var foc = state.focus && g.nodes.get(state.focus);
    return ok(foc) ? foc : null;
  }
  function pickRef() {
    var n = refCandidate();
    if (!n) { toast('Select (or focus) a confirmed transaction first.', true); return; }
    setRef(n);
  }
  function refBtn(n) {
    if (!fiatOn() || n.time == null) return null;
    var isRef = state.fiat.basis === 'ref' && state.fiat.ref && state.fiat.ref.txid === n.txid;
    return el('button', { type: 'button', text: isRef ? 'Converting at this time' : 'Convert all at this time', disabled: isRef ? 'disabled' : null,
                          title: 'Use this transaction\'s timestamp as the price moment for every amount', onclick: function () { setRef(n); } });
  }

  /** A vertex id with the address part in its proper case (bech32 lower-cased). */
  function canonicalId(id) { return typeof id === 'string' && id.indexOf('addr:') === 0 ? 'addr:' + AD.normalise(id.slice(5)) : id; }
  function extLink(path, text) { return el('a', { href: explorerOrigin() + path, target: '_blank', rel: 'noopener noreferrer', text: text }); }

  function annotateBox(n) {
    var lab = el('input', { type: 'text', id: 'fLabel', maxlength: '120', placeholder: 'Your label (shown on the graph)' });
    var note = el('textarea', { id: 'fNote', maxlength: '4000', placeholder: 'Notes' });
    lab.value = n.label || ''; note.value = n.note || '';
    var apply = function () { state.graph.annotate(n.id, lab.value, note.value); refresh(); scheduleSave(); };
    lab.addEventListener('input', apply); note.addEventListener('input', apply);
    return el('div', { 'class': 'insp-section' }, [el('label', { 'for': 'fLabel', 'class': 'lbl', text: 'Label' }), lab, tagControls([n.id]),
                                                  el('label', { 'for': 'fNote', 'class': 'lbl', text: 'Notes' }), note]);
  }

  var SHAPE_GLYPH = { circle: '●', square: '■', diamond: '◆', hexagon: '⬢', triangle: '▲', star: '★', cross: '✚' };
  var SHAPE_NAME = { circle: 'Circle', square: 'Square', diamond: 'Diamond', hexagon: 'Hexagon', triangle: 'Triangle', star: 'Star', cross: 'Cross' };
  var DEFAULT_SHAPE_OF = { tx: 'square', coinbase: 'diamond', data: 'hexagon' };

  /** Tag, colour and shape for one vertex, or for every selected vertex at once. */
  function tagControls(ids) {
    var g = state.graph, nodes = ids.map(function (id) { return g.nodes.get(id); }).filter(Boolean), first = nodes[0] || {};
    var sel = el('select', { id: 'fTag', 'aria-label': 'Tag' });
    sel.appendChild(el('option', { value: '', text: 'No tag' }));
    TG.PRESETS.forEach(function (p) { sel.appendChild(el('option', { value: p.id, text: p.id + ' — ' + p.name })); });
    sel.appendChild(el('option', { value: '__custom', text: 'Custom…' }));
    var preset = first.tag && TG.preset(first.tag);
    sel.value = !first.tag ? '' : preset ? first.tag : '__custom';
    var custom = el('input', { type: 'text', id: 'fTagCustom', maxlength: '20', placeholder: 'Tag name', 'aria-label': 'Custom tag name' });
    custom.value = first.tag && !preset ? first.tag : ''; custom.hidden = sel.value !== '__custom';
    var color = el('input', { type: 'color', id: 'fColor', 'aria-label': 'Colour', title: 'Colour' });
    var shapeSel = el('select', { id: 'fShape', 'aria-label': 'Shape', title: 'Shape' });
    shapeSel.appendChild(el('option', { value: '', text: 'Usual shape' }));
    TG.SHAPES.forEach(function (s) { shapeSel.appendChild(el('option', { value: s, text: SHAPE_GLYPH[s] + ' ' + SHAPE_NAME[s] })); });
    var preview = el('span', { 'class': 'tagpreview', 'aria-hidden': 'true' });
    var swatches = el('div', { 'class': 'swatches', role: 'group', 'aria-label': 'Quick colours' });

    function sync() {
      var n = g.nodes.get(ids[0]) || {};
      var c = n.color || (TG.preset(n.tag) || {}).color;
      color.value = c || '#8d7f8d'; shapeSel.value = n.shape || '';
      preview.textContent = SHAPE_GLYPH[n.shape || DEFAULT_SHAPE_OF[n.type] || 'circle'];
      preview.style.color = c || '';
      Array.prototype.forEach.call(swatches.children, function (b) { b.setAttribute('aria-pressed', String(!!c && b.getAttribute('data-color') === c)); });
    }
    function apply(fields, keepStyle) {
      ids.forEach(function (id) { var nd = g.nodes.get(id); if (nd) TG.apply(nd, fields, keepStyle); });
      sync(); refresh(); scheduleSave();
    }
    TG.COLORS.forEach(function (c) {
      var b = el('button', { type: 'button', 'class': 'swatch', 'aria-label': 'Colour ' + c, title: c, 'data-color': c, onclick: function () { apply({ color: c }); } });
      b.style.background = c; swatches.appendChild(b);
    });
    sel.addEventListener('change', function () {
      custom.hidden = sel.value !== '__custom';
      if (sel.value === '__custom') { custom.focus(); if (custom.value) apply({ tag: custom.value }, true); return; }
      apply({ tag: sel.value });
    });
    custom.addEventListener('input', function () { apply({ tag: custom.value }, true); });
    color.addEventListener('input', function () { apply({ color: color.value }); });
    shapeSel.addEventListener('change', function () { apply({ shape: shapeSel.value }); });
    var reset = el('button', { type: 'button', text: 'Reset look', title: 'Back to the usual colour and shape (the tag stays)', onclick: function () { apply({ color: '', shape: '' }); } });
    sync();
    return el('div', { 'class': 'tagbox' }, [el('label', { 'for': 'fTag', 'class': 'lbl', text: 'Tag' }),
      el('div', { 'class': 'tagrow' }, [sel, custom]),
      el('div', { 'class': 'tagrow' }, [preview, color, shapeSel, reset]), swatches]);
  }

  // ---- external lookups (on request, one wallet) ----------------------------------------------
  function proxyUrlOk(u) { return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/.*)?$/i.test(u) || /^https:\/\/[^\s/]+(\/.*)?$/i.test(u); }

  function externalCard(n) {
    var ark = n.ext && n.ext.arkham, box = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'External sources' })]);
    box.appendChild(el('div', { 'class': 'insp-actions' }, [
      el('button', { type: 'button', id: 'btnArkham', text: ark ? 'Look up again in Arkham' : 'Look up in Arkham', title: 'Sends this wallet\'s address to Arkham Intelligence, through your local proxy', onclick: function () { lookupArkham(n.id); } })]));
    if (ark) box.appendChild(arkhamCard(n, ark));
    return box;
  }

  function arkhamCard(n, a) {
    var card = el('div', { 'class': 'extcard' }), dl = el('dl', { 'class': 'kv' });
    card.appendChild(el('h4', {}, [el('span', { text: 'Arkham Intelligence' }), el('small', { text: a.at ? S.fmtTime(a.at, false) : '' })]));
    if (!a.found) card.appendChild(el('p', { 'class': 'hint', text: 'Arkham has no entry for this wallet.' }));
    else {
      kv(dl, 'Entity', a.name); kv(dl, 'Type', a.type); kv(dl, 'Label', a.label); kv(dl, 'Tags', (a.tags || []).join(', ')); kv(dl, 'Predicted', a.predicted); kv(dl, 'Website', a.website); kv(dl, 'Note', a.note);
      card.appendChild(dl);
    }
    var acts = [];
    var text = [a.name, a.label].filter(Boolean).join(' · ').slice(0, 120);
    if (a.found && text) acts.push(el('button', { type: 'button', text: 'Use as label', title: 'Set your label to “' + text + '”', onclick: function () { state.graph.annotate(n.id, text, n.note); showInspector(); refresh(); scheduleSave(); } }));
    if (a.suggest && TG.preset(a.suggest)) acts.push(el('button', { type: 'button', text: 'Tag as ' + a.suggest, title: 'Suggested from Arkham\'s entity type: ' + TG.preset(a.suggest).name, onclick: function () { TG.apply(n, { tag: a.suggest }); showInspector(); refresh(); scheduleSave(); } }));
    acts.push(el('button', { type: 'button', text: 'Remove result', onclick: function () { delete n.ext.arkham; if (!Object.keys(n.ext).length) delete n.ext; showInspector(); refresh(); scheduleSave(); } }));
    card.appendChild(el('div', { 'class': 'insp-actions' }, acts));
    if (a.raw) card.appendChild(el('details', {}, [el('summary', { text: 'Raw reply' }), el('pre', { text: a.raw })]));
    return card;
  }

  function lookupArkham(id) {
    var n = state.graph.nodes.get(id), x = state.ext;
    if (!n || n.type !== 'addr') { toast('Look-ups are for wallets: choose a wallet.', true); return; }
    if (state.source === 'tor') { toast('Look-ups are switched off while the data source is Tor: they would go outside Tor and tell Arkham which wallet you are looking at.', true); return; }
    if (!x.token) {
      toast('Set up the lookup proxy first (Controls › External sources): run tools/arkham_proxy.py and enter its URL and token.', true);
      setSideCollapsed(false); $('extSection').open = true; $('arkToken').focus(); return;
    }
    if (x.busy) { toast('A look-up is already running.', true); return; }
    if (!x.consented) {
      if (!window.confirm('This sends the wallet address\n\n' + n.address + '\n\nto Arkham Intelligence (through your local proxy). Continue?')) return;
      x.consented = true;
    }
    x.busy = true; toast('Asking Arkham about ' + S.shortId(n.address, 8) + '…');
    XT.lookupArkham({ fetch: window.fetch.bind(window), base: x.proxy, token: x.token, address: n.address }).then(function (r) {
      var node = state.graph.nodes.get(id);
      if (node) { node.ext = node.ext || {}; node.ext.arkham = r.ext; }
      toast(r.found ? 'Arkham: ' + (r.ext.name || r.ext.label || 'tagged wallet') + (r.ext.type ? ' (' + r.ext.type + ')' : '') + '. Use the buttons in the details to apply it.' : 'Arkham has no entry for this wallet.');
      showInspector(); refresh(); scheduleSave();
    }, function (e) { toast((e && e.message) || 'The look-up failed.', true); }).then(function () { x.busy = false; });
  }

  // ---- right-click menu -----------------------------------------------------------------------
  function closeCtx() { var m = $('ctxMenu'); m.classList.remove('choosing'); if (!m.hidden) { m.hidden = true; m.textContent = ''; } }

  function placeCtx(at) {
    var m = $('ctxMenu'); m.hidden = false;
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(at.x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(at.y, window.innerHeight - h - 8)) + 'px';
    var first = m.querySelector('button:not(:disabled), a'); if (first) first.focus();
  }

  function ctxItem(m, text, fn, o) {
    o = o || {};
    var b = el('button', { type: 'button', role: 'menuitem', disabled: o.disabled ? 'disabled' : null, title: o.title, 'class': o.danger ? 'danger' : null,
                           onclick: function () { if (o.keep) { fn(); } else { closeCtx(); fn(); } } },
               [el('span', {}, [o.glyph ? el('span', { 'class': 'sw', text: o.glyph, style: o.glyphColor ? 'color:' + o.glyphColor : null }) : null, text]), o.right ? el('span', { 'class': 'hint', text: o.right }) : null]);
    m.appendChild(b); return b;
  }

  function openCtx(nodeId, edgeId, at) {
    closeStepMenu(); $('tooltip').hidden = true;
    if (nodeId && !state.selected.has(nodeId)) { state.selected = new Set([nodeId]); state.selectedEdge = null; syncSelection(); }
    buildCtx(nodeId ? Array.from(state.selected) : null, at);
  }

  function buildCtx(ids, at) {
    var m = $('ctxMenu'), g = state.graph; m.textContent = ''; m.classList.remove('choosing');
    if (!ids) {
      m.appendChild(el('div', { 'class': 'ctxhead', text: 'Graph' }));
      ctxItem(m, 'Select all', function () { selectAllVisible(); }, { right: 'Ctrl+A' });
      ctxItem(m, 'Fit view', function () { renderer.fit(); });
      ctxItem(m, 'Re-layout', function () { state.pinned.clear(); refresh({ relayout: true, fit: true }); });
      placeCtx(at); return;
    }
    if (ids.length > 1) {
      m.appendChild(el('div', { 'class': 'ctxhead', text: ids.length + ' selected' }));
      ctxItem(m, 'Tag as…', function () { buildTagMenu(ids, at); }, { keep: true, right: '▸' });
      var lst = idLists(ids);
      if (lst.addrs.length) ctxItem(m, 'Copy ' + plural(lst.addrs.length, 'address', 'addresses'), function () { copy(lst.addrs.join(NL), plural(lst.addrs.length, 'address', 'addresses')); });
      if (lst.txs.length) ctxItem(m, 'Copy ' + plural(lst.txs.length, 'transaction id'), function () { copy(lst.txs.join(NL), plural(lst.txs.length, 'transaction id')); });
      if (traceOn()) {
        var sel = ids.filter(function (x) { return state.trace.shown.has(x); });
        ctxItem(m, 'Hide ' + sel.length + ' from the trace', function () { traceHideIds(sel); }, { danger: true, disabled: !sel.length || sel.length >= state.trace.shown.size });
        ctxItem(m, 'Keep only these ' + sel.length, function () { traceKeepOnly(sel); }, { disabled: !sel.length || sel.length >= state.trace.shown.size });
      } else {
        ctxItem(m, 'Hide ' + ids.length, function () { var k = hideIds(ids); if (k) toast('Hid ' + plural(k, 'vertex', 'vertices') + ' (Ctrl+Z brings them back).'); });
        ctxItem(m, 'Keep only these ' + ids.length, function () { keepOnly(ids); });
        ctxItem(m, 'Remove ' + ids.length + ' from view', function () { removeIds(ids); }, { danger: true, title: 'Delete them from the workspace (Hide keeps them loaded)' });
      }
      placeCtx(at); return;
    }
    var n = g.nodes.get(ids[0]); if (!n) return;
    m.appendChild(el('div', { 'class': 'ctxhead', text: (KIND_NAME[n.type] || 'Vertex') + ' · ' + focusLabel(n.id).replace(/^tx /, '') }));
    if (traceOn() && (n.type === 'tx' || n.type === 'addr')) {
      function lab(dir) { return TR.handleLabel(TR.hidden(state.graph, state.trace.shown, n.id, dir)); }
      var T0 = state.trace, isSeed = T0.seeds.indexOf(n.id) >= 0, inTrace = T0.shown.has(n.id), branch = inTrace ? traceBranch(n.id) : [];
      ctxItem(m, 'Show forward ▶', function () { traceExpand(n.id, 'next', { at: at }); }, { right: lab('next') });
      ctxItem(m, '◀ Show backward', function () { traceExpand(n.id, 'prev', { at: at }); }, { right: lab('prev') });
      ctxItem(m, 'Choose what to show ▶…', function () { traceChoose(n.id, 'next', at); }, { keep: true, disabled: !TR.hidden(state.graph, T0.shown, n.id, 'next').known });
      ctxItem(m, '◀ Choose what to show…', function () { traceChoose(n.id, 'prev', at); }, { keep: true, disabled: !TR.hidden(state.graph, T0.shown, n.id, 'prev').known });
      m.appendChild(el('div', { 'class': 'sep' }));
      ctxItem(m, 'Hide this vertex', function () { traceHideIds([n.id]); }, { disabled: T0.shown.size <= 1, title: 'Take only this vertex off the screen; what it revealed stays' });
      ctxItem(m, 'Hide this branch', function () { traceHideBranch(n.id); }, { disabled: branch.length >= T0.shown.size, right: branch.length > 1 ? String(branch.length) : '', title: 'Hide this vertex and everything that was revealed because of it' });
      ctxItem(m, 'Select this branch', function () { traceSelectBranch(n.id); }, { disabled: branch.length < 2 });
      m.appendChild(el('div', { 'class': 'sep' }));
      ctxItem(m, isSeed ? 'Is a starting point' : 'Add as a starting point', function () { traceAddSeed(n.id, true); traceChanged(null, false); }, { disabled: isSeed });
      ctxItem(m, 'Start over from here', function () { navigate(n.id, { replaceTrace: true, light: true }); }, { title: 'Replace the trace with just this vertex' });
    } else if (n.type === 'tx' || n.type === 'addr') ctxItem(m, 'Focus here', function () { navigate(n.id); });
    if (n.type === 'tx') {
      ctxItem(m, 'Spenders →', function () { expandNode(n.id, 'forward'); });
      ctxItem(m, '← Funding', function () { expandNode(n.id, 'backward'); });
    }
    if (n.type === 'addr') {
      ctxItem(m, n.histNext ? 'Load more history' : 'Load history', function () { expandNode(n.id); }, { disabled: !!n.histDone });
      ctxItem(m, n.ext && n.ext.arkham ? 'Look up again in Arkham…' : 'Look up in Arkham…', function () { lookupArkham(n.id); },
              { right: 'external', title: 'Sends this wallet\'s address to Arkham Intelligence, through your local proxy' });
    }
    if (n.type === 'tx' || n.type === 'addr') {
      var au = state.auto;
      m.appendChild(el('div', { 'class': 'sep' }));
      ctxItem(m, 'Auto-expand forward ▶▶', function () { autoExpand(n.id, { dir: 'next' }); }, { right: au.hops + ' hops', title: 'Follow the money forward with the settings under Auto-expand' });
      ctxItem(m, '◀◀ Auto-expand backward', function () { autoExpand(n.id, { dir: 'prev' }); }, { right: au.hops + ' hops', title: 'Follow the money backward with the settings under Auto-expand' });
      if (n.type === 'tx') ctxItem(m, 'Follow a peel chain ▶▶', function () { autoExpand(n.id, { dir: 'next', follow: 'peel', hops: Math.max(au.hops, 10) }); }, { title: 'Follow a run of single-coin payments for up to 10 hops' });
      var cl0 = n.type === 'addr' ? analysis().clusters.byAddr.get(n.id) : null;
      if (cl0) ctxItem(m, 'Select its cluster (' + cl0.size + ')', function () { selectIds(cl0.addrs, 'addresses of ' + cl0.label); }, { title: 'The addresses that were spent together with this one' });
    }
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, n.tag ? 'Tag: ' + n.tag + ' — change…' : 'Tag as…', function () { buildTagMenu(ids, at); }, { keep: true, right: '▸' });
    var idText = n.type === 'tx' ? n.txid : n.type === 'addr' ? n.address : n.id;
    ctxItem(m, n.type === 'tx' ? 'Copy txid' : n.type === 'addr' ? 'Copy address' : 'Copy id', function () { copy(idText, n.type === 'tx' ? 'the transaction id' : n.type === 'addr' ? 'the address' : ''); });
    if (n.type === 'tx' || n.type === 'addr') {
      var link = el('a', { href: explorerOrigin() + (n.type === 'tx' ? '/tx/' + n.txid : '/address/' + n.address), target: '_blank', rel: 'noopener noreferrer', role: 'menuitem', onclick: function () { closeCtx(); } }, [el('span', { text: 'Open in explorer' }), el('span', { 'class': 'hint', text: '↗' })]);
      m.appendChild(link);
    }
    m.appendChild(el('div', { 'class': 'sep' }));
    if (traceOn()) ctxItem(m, 'Hide from the trace', function () { traceHideIds(ids); }, { danger: true, disabled: state.trace.shown.size <= 1 });
    else {
      ctxItem(m, 'Hide this vertex', function () { var k = hideIds(ids); if (k) toast('Hid it (Ctrl+Z brings it back).'); }, { title: 'Take it off the screen; it stays loaded' });
      ctxItem(m, 'Remove from view', function () { removeIds(ids); }, { danger: true, title: 'Delete it from the workspace (Hide keeps it loaded)' });
    }
    placeCtx(at);
  }

  function buildTagMenu(ids, at) {
    var m = $('ctxMenu'); m.textContent = '';
    m.appendChild(el('div', { 'class': 'ctxhead', text: ids.length > 1 ? 'Tag ' + ids.length + ' vertices as' : 'Tag as' }));
    TG.PRESETS.forEach(function (p) {
      ctxItem(m, p.id + ' — ' + p.name, function () { applyTagTo(ids, { tag: p.id }); }, { glyph: SHAPE_GLYPH[p.shape], glyphColor: p.color });
    });
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, 'Custom tag, colour or shape…', function () { openTagEditor(ids); });
    ctxItem(m, 'No tag', function () { applyTagTo(ids, { tag: '' }); });
    ctxItem(m, '← Back', function () { buildCtx(ids, at); }, { keep: true });
    placeCtx(at);
  }

  function applyTagTo(ids, fields) {
    ids.forEach(function (id) { var nd = state.graph.nodes.get(id); if (nd) TG.apply(nd, fields); });
    showInspector(); refresh(); scheduleSave();
  }

  /** Bring the details (with the tag controls) up for these vertices. */
  function openTagEditor(ids) {
    state.selected = new Set(ids); state.selectedEdge = null; syncSelection();
    setInspCollapsed(false);
    var s = $('fTag'); if (s) s.focus();
  }

  function ctxKeys(e) {
    var m = $('ctxMenu'); if (m.hidden) return false;
    if (m.classList.contains('choosing')) {                                              // the list of things to show: Tab and the arrow keys belong to its fields
      if (e.key === 'Escape') { closeCtx(); $('cv').focus(); e.preventDefault(); return true; }
      return false;
    }
    var items = Array.prototype.slice.call(m.querySelectorAll('button:not(:disabled), a')), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { items[0].focus(); }
    else if (e.key === 'End') { items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { closeCtx(); if (e.key === 'Escape') $('cv').focus(); }
    else return false;
    e.preventDefault(); return true;
  }

  /** Where a vertex is on the screen, for opening the menu from the keyboard. */
  function clientPosOf(id) {
    var p = renderer.positionOf(id), b = $('cv').getBoundingClientRect(), v = renderer.view;
    return p ? { x: b.left + p.x * v.k + v.x + 12, y: b.top + p.y * v.k + v.y + 12 } : { x: b.left + 40, y: b.top + 40 };
  }

  /** In a trace: show forward / backward from this vertex, hide it or its branch, start over from it. */
  function traceActions(n) {
    if (!traceOn() || !state.trace.shown.has(n.id)) return null;
    var T = state.trace, branch = traceBranch(n.id);
    function lbl(dir) { return TR.handleLabel(TR.hidden(state.graph, T.shown, n.id, dir)); }
    return el('div', { 'class': 'insp-section' }, [
      el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: '◀ Show backward ' + lbl('prev'), title: 'Show what came before ([). Shift-click a handle on the graph to choose which.', onclick: function () { traceExpand(n.id, 'prev'); } }),
        el('button', { type: 'button', text: 'Show forward ' + lbl('next') + ' ▶', title: 'Show what came after (])', onclick: function () { traceExpand(n.id, 'next'); } })]),
      el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Hide vertex', disabled: T.shown.size <= 1 ? 'disabled' : null, title: 'Only this one; what it revealed stays', onclick: function () { traceHideIds([n.id]); } }),
        el('button', { type: 'button', text: 'Hide branch' + (branch.length > 1 ? ' (' + branch.length + ')' : ''), disabled: branch.length >= T.shown.size ? 'disabled' : null, onclick: function () { traceHideBranch(n.id); } }),
        el('button', { type: 'button', text: 'Start over from here', title: 'Replace the trace with just this vertex', onclick: function () { navigate(n.id, { replaceTrace: true, light: true }); } })])]);
  }

  function focusBtn(n) {
    if (traceOn()) {
      var start = state.trace.seeds.indexOf(n.id) >= 0;
      return el('button', { type: 'button', 'class': 'primary', text: start ? 'A starting point' : 'Add as a starting point', disabled: start ? 'disabled' : null,
                            title: 'Mark this vertex as another place the trace starts from', onclick: function () { traceAddSeed(n.id, true); traceChanged(null, false); } });
    }
    var here = state.focusOn && state.focus === n.id;
    return el('button', { type: 'button', 'class': 'primary', text: here ? 'Focused here' : 'Focus here', disabled: here ? 'disabled' : null,
                          title: 'Show this vertex and what is around it', onclick: function () { if (!state.focusOn) { state.focusOn = true; $('focusOn').checked = true; savePrefs(); } navigate(n.id); } });
  }

  /** One row per neighbouring transaction; clicking moves the focus there. `row` = {id, label, amount, time, dir}. */
  function linkRows(title, rows) {
    var LIMIT = 40, list = el('div', { 'class': 'linkrows' });
    rows.slice(0, LIMIT).forEach(function (r) {
      var kids = [el('span', { text: r.label })];
      if (r.time != null) kids.push(el('span', { 'class': 'when', text: S.fmtTime(r.time, false) }));
      if (r.amount != null) kids.push(el('span', { 'class': 'amt', text: (r.sign || '') + mixText(S.fmtBtc(r.amount) + ' BTC', r.amount != null ? fiatOf(r.amount, r.time) : null) }));
      var fx = r.amount != null ? fiatOf(r.amount, r.time) : null;
      var line = r.id && state.graph.nodes.has(r.id) ? el('button', { type: 'button', 'class': 'linkrow', title: r.id + (fx ? ' · ' + fx.text : ''), onclick: function () { navigate(r.id); } }, kids)
                                                        : el('div', { 'class': 'linkrow plain' }, kids);
      list.appendChild(r.id && /^(tx|addr):/.test(r.id) ? withCopy(line, plainId(r.id), r.id.indexOf('tx:') === 0 ? 'transaction id' : 'address') : line);
    });
    if (rows.length > LIMIT) list.appendChild(el('div', { 'class': 'hint', text: '… and ' + (rows.length - LIMIT) + ' more' }));
    return el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: title + ' (' + rows.length + ')' }), list]);
  }

  // ---- a wallet's transactions, told apart: in and out ----------------------------------------------
  /** The other side of a transaction, without `selfId`: its output wallets (side 'out') or its input wallets (side 'in'). null when the transaction is not loaded. */
  function partiesOf(txId, side, selfId) {
    var g = state.graph, t = g.nodes.get(txId);
    if (!t || t.type !== 'tx' || t.loaded === false) return null;
    var seen = new Set(), names = [];
    g.edgesOf(txId).forEach(function (e) {
      var other = side === 'out' ? (e.kind === 'out' && e.source === txId ? e.target : null) : (e.kind === 'in' && e.target === txId ? e.source : null);
      if (!other || other === selfId || seen.has(other) || !g.nodes.has(other)) return;
      seen.add(other); names.push(focusLabel(other));
    });
    return { names: names };
  }
  /** "Robinhood Hot Wallet, bc1qdg…  +2", or `itself` when nobody else is on that side. */
  function partiesText(p, itself) {
    if (!p) return '';
    if (!p.names.length) return itself;
    return p.names.slice(0, 2).join(', ') + (p.names.length > 2 ? '  +' + (p.names.length - 2) : '');
  }

  /**
   * One row per transaction that touches a wallet, with what it did to the wallet: money 'in', money 'out', or 'self'.
   * Change that came back to the same wallet is netted off, so a payment with change reads as one 'out' for what really left.
   * Row: { id, txid, time, recv, sent, dir, mixed, amount }.
   */
  function walletRows(n) {
    var g = state.graph, byTx = new Map(), rows = [];
    g.edgesOf(n.id).forEach(function (e) {
      var received = e.kind === 'out' && e.target === n.id, spent = e.kind === 'in' && e.source === n.id;
      if (!received && !spent) return;
      var r = byTx.get(e.txid) || { recv: 0, sent: 0 };
      if (received) r.recv += e.amount; else r.sent += e.amount;
      byTx.set(e.txid, r);
    });
    byTx.forEach(function (r, txid) {
      var id = ID.tx(txid), t = g.nodes.get(id), net = r.recv - r.sent, mixed = r.recv > 0 && r.sent > 0;
      var dir = !r.sent ? 'in' : !r.recv ? 'out' : net > 0 ? 'in' : net < 0 ? 'out' : 'self';
      if (mixed && dir === 'out') { var po = partiesOf(id, 'out', n.id); if (po && !po.names.length) dir = 'self'; }          // every output came back to the wallet: it only moved money to itself
      rows.push({ id: id, txid: txid, time: t ? t.time : null, pending: !!t && t.confirmed === false, unloaded: !!t && t.loaded === false, recv: r.recv, sent: r.sent, dir: dir, mixed: mixed, amount: dir === 'self' ? r.sent : mixed ? Math.abs(net) : (dir === 'in' ? r.recv : r.sent) });
    });
    return rows;
  }

  var DIR_TAG = { 'in': '↓ in', out: '↑ out', self: '↔ self' };

  /** The Transactions list of a selected wallet: In / Out told apart, who is on the other side, sortable, with a button to put one on the trace. */
  function walletTxSection(n) {
    var rows = walletRows(n); if (!rows.length) return null;
    var V = state.walletView, box = el('div', { 'class': 'insp-section walletsec' });
    var inRows = rows.filter(function (r) { return r.dir === 'in'; }), outRows = rows.filter(function (r) { return r.dir === 'out'; });
    function total(list) { return list.reduce(function (t, r) { return t + r.amount; }, 0); }
    function when(r) { return r.pending ? Infinity : r.time == null ? -Infinity : r.time; }                       // unconfirmed is the newest; a transaction not loaded yet has no date: last
    function byTime(a, b) { var ta = when(a), tb = when(b); return ta === tb ? (b.amount - a.amount) : (tb > ta ? 1 : -1); }
    function draw() {
      if (renderer) renderer.setHighlight(null);
      box.textContent = '';
      var want = rows.filter(function (r) { return V.dir === 'all' || r.dir === V.dir; });
      want.sort(V.sort === 'big' ? function (a, b) { return b.amount - a.amount || (a.id < b.id ? -1 : 1); } : byTime);
      box.appendChild(el('span', { 'class': 'lbl', text: 'Transactions (' + rows.length + ')' }));
      box.appendChild(el('div', { 'class': 'walletsum', title: 'Per transaction: what the wallet received minus what it spent in it, so change that came back is netted off' },
        ['↓ in ', el('span', { 'class': 'strong', text: S.fmtBtc(total(inRows)) + ' BTC' }), ' (' + inRows.length + ')  ·  ↑ out ', el('span', { 'class': 'strong', text: S.fmtBtc(total(outRows)) + ' BTC' }), ' (' + outRows.length + ')']));
      var seg = el('div', { 'class': 'seg walletseg', role: 'radiogroup', 'aria-label': 'Which transactions' }, [['all', 'All ' + rows.length], ['in', '↓ In ' + inRows.length], ['out', '↑ Out ' + outRows.length]].map(function (x) {
        return el('button', { type: 'button', role: 'radio', 'data-dir': x[0], 'aria-checked': String(V.dir === x[0]), text: x[1], onclick: function () { V.dir = x[0]; V.more = 40; draw(); } });
      }));
      var sortSel = el('select', { 'aria-label': 'Order', title: 'Order' }, [el('option', { value: 'new', text: 'Newest first' }), el('option', { value: 'big', text: 'Largest first' })]);
      sortSel.value = V.sort; sortSel.addEventListener('change', function () { V.sort = sortSel.value; draw(); });
      box.appendChild(el('div', { 'class': 'walletbar' }, [seg, sortSel]));
      var list = el('div', { 'class': 'linkrows' }), T = state.trace;
      want.slice(0, V.more).forEach(function (r) {
        var t = state.graph.nodes.get(r.id), fx = fiatOf(r.amount, r.time);
        var parties = r.dir === 'self' ? { names: [] } : partiesOf(r.id, r.dir === 'in' ? 'in' : 'out', n.id);
        var who = partiesText(parties, 'itself');
        var tag = el('span', { 'class': 'dirtag ' + r.dir, text: DIR_TAG[r.dir],
                               title: r.dir === 'in' ? 'Money came in' + (r.mixed ? ' (the wallet also spent in this transaction; net shown)' : '') : r.dir === 'out' ? 'Money went out' + (r.mixed ? ' (some came back to the wallet as change; net shown)' : '') : 'Moved within the wallet' });
        var kids = [tag, el('span', { 'class': 'who' }, [who ? (r.dir === 'in' ? 'from ' : r.dir === 'out' ? 'to ' : '') + who : S.shortId(r.txid, 6), who ? el('small', { text: S.shortId(r.txid, 6) }) : r.unloaded ? el('small', { text: 'no details yet' }) : null])];
        if (r.time != null) kids.push(el('span', { 'class': 'when', text: S.fmtTime(r.time, false) }));
        kids.push(el('span', { 'class': 'amt', text: (r.dir === 'in' ? '+' : r.dir === 'out' ? '−' : '') + mixText(S.fmtBtc(r.amount) + ' BTC', fx) }));
        var line = el('button', { type: 'button', 'class': 'linkrow ' + r.dir, title: r.id + (fx ? ' · ' + fx.text : ''), onclick: function () { navigate(r.id); } }, kids);
        var onTrace = !traceOn() || T.shown.has(r.id), parts = [line];
        if (!onTrace && T.shown.has(n.id)) {
          parts.push(el('button', { type: 'button', 'class': 'showbtn', text: '+ show', title: 'Put this transaction on the trace',
                                    onclick: function (ev) { ev.stopPropagation(); traceExpand(n.id, r.sent > 0 ? 'next' : 'prev', { only: new Set([r.id]) }); } }));
        }
        parts.push(copyBtn(r.txid, 'transaction id'));
        var wrap = el('div', { 'class': 'rowcopy' + (onTrace ? '' : ' off') }, parts);
        wrap.addEventListener('mouseenter', function () { if (renderer) renderer.setHighlight(r.id); });
        wrap.addEventListener('mouseleave', function () { if (renderer) renderer.setHighlight(null); });
        list.appendChild(wrap);
      });
      if (want.length > V.more) list.appendChild(el('button', { type: 'button', 'class': 'moreRows', text: 'Show ' + Math.min(40, want.length - V.more) + ' more (' + (want.length - V.more) + ' not listed)', onclick: function () { V.more += 40; draw(); } }));
      if (!want.length) list.appendChild(el('div', { 'class': 'hint', text: 'None of these.' }));
      box.appendChild(list);
    }
    draw();
    return box;
  }

  function connectedTxSections(n) {
    var g = state.graph, out = [];
    function txTime(txid) { var t = g.nodes.get(ID.tx(txid)); return t ? t.time : null; }
    if (n.type === 'tx') {
      var funded = [], spent = [];
      g.edgesOf(n.id).forEach(function (e) {
        if (e.kind === 'in' && e.target === n.id && e.prev) funded.push({ id: ID.tx(e.prev.txid), label: '← ' + S.shortId(e.prev.txid, 6), amount: e.amount, time: txTime(e.prev.txid) });
        else if (e.kind === 'out' && e.source === n.id) {
          if (e.spentBy) spent.push({ id: ID.tx(e.spentBy.txid), label: '→ ' + S.shortId(e.spentBy.txid, 6), amount: e.amount, time: e.spentBy.time != null ? e.spentBy.time : txTime(e.spentBy.txid) });
          else spent.push({ id: null, label: e.spent === false ? '→ unspent' : '→ spender unknown', amount: e.amount, time: null });
        }
      });
      if (funded.length) out.push(linkRows('Funded by', funded));
      if (spent.length) out.push(linkRows('Spent by', spent));
      if (!funded.length && !spent.length && n.loaded && !n.outspendsLoaded) out.push(el('p', { 'class': 'hint', text: 'Focus here to load what spent its outputs.' }));
    } else if (n.type === 'addr') {
      var sec = walletTxSection(n); if (sec) out.push(sec);
    }
    return out;
  }

  function removeBtn(ids) {
    if (traceOn()) return el('button', { type: 'button', 'class': 'danger', text: ids.length > 1 ? 'Hide ' + ids.length + ' from the trace' : 'Hide from the trace', disabled: state.trace.shown.size <= ids.length ? 'disabled' : null,
                                        title: 'They stay loaded; Ctrl+Z brings them back', onclick: function () { traceHideIds(ids); } });
    return el('button', { type: 'button', 'class': 'danger', text: ids.length > 1 ? 'Remove ' + ids.length + ' from view' : 'Remove from view', onclick: function () { removeIds(ids); } });
  }

  function renderInspector(soft) {
    var box = $('inspBody'), insp = $('inspector'), g = state.graph;
    if (soft && box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && state.selected.size === 1) return;   // user is typing
    box.textContent = '';
    var ids = Array.from(state.selected).filter(function (id) { return g.nodes.has(id); });
    if (!ids.length && state.selectedEdge && g.edges.has(state.selectedEdge)) { insp.hidden = false; return showEdge(g.edges.get(state.selectedEdge)); }
    if (!ids.length) { insp.hidden = true; return; }
    insp.hidden = false;
    if (ids.length > 1) {
      box.appendChild(el('h3', { text: ids.length + ' selected' }));
      var tot = 0; ids.forEach(function (id) { var n = g.nodes.get(id); tot += (n.type === 'tx' ? n.valueOut : n.received) || 0; });
      var dl0 = el('dl', { 'class': 'kv' }); kv(dl0, 'Total value', S.fmtBtc(tot) + ' BTC'); box.appendChild(dl0);
      var kinds = { addr: 0, tx: 0 }; ids.forEach(function (id) { var t = g.nodes.get(id).type; if (t in kinds) kinds[t]++; });
      if (kinds.addr) box.appendChild(balanceList(ids.filter(function (id) { return g.nodes.get(id).type === 'addr'; })));
      var total = traceOn() ? state.trace.shown.size : visibleIds().length;
      var cps = copyButtons(ids); if (cps.length) box.appendChild(el('div', { 'class': 'insp-actions' }, cps));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [hideBtn(ids), removeBtn(ids),
        el('button', { type: 'button', text: 'Keep only these ' + ids.length, disabled: ids.length >= total ? 'disabled' : null, title: 'Hide everything else on screen', onclick: function () { keepOnly(ids); } })]));
      var narrow = [];
      if (kinds.addr && kinds.addr < ids.length) narrow.push(el('button', { type: 'button', text: 'Wallets only (' + kinds.addr + ')', title: 'Narrow the selection to its wallets', onclick: function () { narrowSelection('addr'); } }));
      if (kinds.tx && kinds.tx < ids.length) narrow.push(el('button', { type: 'button', text: 'Transactions only (' + kinds.tx + ')', title: 'Narrow the selection to its transactions', onclick: function () { narrowSelection('tx'); } }));
      if (narrow.length) box.appendChild(el('div', { 'class': 'insp-actions' }, narrow));
      box.appendChild(el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Tag all ' + ids.length }), tagControls(ids)]));
      return;
    }
    var n = g.nodes.get(ids[0]), dl = el('dl', { 'class': 'kv' });
    var kind = { tx: 'Transaction', addr: 'Address', coinbase: 'Coinbase', data: 'OP_RETURN', nonstd: 'Non-standard' }[n.type];
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: kind }), n.label ? el('span', { text: n.label }) : null]));

    if (n.type === 'tx') {
      box.appendChild(idRow(n.txid, 'transaction id'));
      kv(dl, 'Status', n.loaded === false ? 'not loaded yet' : n.confirmed ? 'confirmed' : n.confirmed === false ? 'unconfirmed' : 'unknown');
      kv(dl, 'Time', n.time != null ? S.fmtTimeFull(n.time) : null);
      kv(dl, 'Block', n.height);
      if (n.loaded) {
        kv(dl, 'Inputs', n.nIn); kv(dl, 'Outputs', n.nOut);
        kvf(dl, 'Value out', S.fmtBtc(n.valueOut) + ' BTC', fiatOf(n.valueOut, n.time));
        if (!n.coinbase) kvf(dl, 'Value in', S.fmtBtc(n.valueIn) + ' BTC', fiatOf(n.valueIn, n.time));
        if (n.fee != null) kvf(dl, 'Fee', fmtInt(n.fee) + ' sat' + (n.vsize ? ' (' + (n.fee / n.vsize).toFixed(1) + ' sat/vB)' : ''), fiatOf(n.fee, n.time));
        if (n.coinbase) kv(dl, 'Note', 'Coinbase: creates new coins');
        var fpr = AN.fingerprint(n); if (fpr) kv(dl, 'Wallet habits', fpr.text);
        if (n.fetchedAt != null) kv(dl, 'Fetched', S.fmtTimeFull(n.fetchedAt) + (n.source ? ' from ' + n.source.replace(/^https?:\/\//i, '').replace(/\/api\/?$/, '') : ''));
      }
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [focusBtn(n), refBtn(n)]));
      var ta = traceActions(n); if (ta) box.appendChild(ta);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Spenders →', title: 'Load the transactions that spent its outputs', onclick: function () { expandNode(n.id, 'forward'); } }),
        el('button', { type: 'button', text: '← Funding', title: 'Load the transactions it spends from', onclick: function () { expandNode(n.id, 'backward'); } }),
        el('button', { type: 'button', text: '↔ Both', onclick: function () { expandNode(n.id, 'both'); } })
      ]));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Copy txid', onclick: function () { copy(n.txid); } }), extLink('/tx/' + n.txid, 'Open in explorer ↗'), hideBtn([n.id]), removeBtn([n.id])
      ]));
      box.appendChild(autoButtons(n));
      (txAnalysisSection(n) || []).forEach(function (s) { box.appendChild(s); });
      connectedTxSections(n).forEach(function (s) { box.appendChild(s); });
    } else if (n.type === 'addr') {
      box.appendChild(idRow(n.address, 'address'));
      var known = KNOWN[n.address];
      if (known) {
        var tags = el('div', {}, [el('span', { 'class': 'tag known', text: 'known: ' + known.label + (known.pack ? ' (' + known.pack + ')' : '') })]);
        if (known.category) tags.appendChild(el('span', { 'class': 'tag', text: known.category }));
        (known.alt || []).forEach(function (a) { tags.appendChild(el('span', { 'class': 'tag', text: 'also listed as: ' + a })); });
        if (known.note) tags.appendChild(el('p', { 'class': 'hint', text: known.note }));
        if (known.url && LB.cleanUrl(known.url)) tags.appendChild(el('a', { href: known.url, target: '_blank', rel: 'noopener noreferrer', text: 'source ↗' }));
        box.appendChild(tags);
      }
      kv(dl, 'Script type', n.scriptType);
      kvf(dl, 'Received here', S.fmtBtc(n.received) + ' BTC (in this graph)', fiatSum(n, true));
      kvf(dl, 'Sent from here', S.fmtBtc(n.sent) + ' BTC (in this graph)', fiatSum(n, false));
      var balButton = balanceRows(dl, n, box);
      kv(dl, 'First seen', n.firstSeen != null ? S.fmtTime(n.firstSeen) : null);
      kv(dl, 'Last seen', n.lastSeen != null ? S.fmtTime(n.lastSeen) : null);
      if (n.txCount != null) kv(dl, 'Transactions', fmtInt(n.txCount) + ' on chain' + (n.histNext || !n.histDone ? '' : ' (all loaded)'));
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [focusBtn(n), balButton]));
      var ta2 = traceActions(n); if (ta2) box.appendChild(ta2);
      var acts = [el('button', { type: 'button', text: n.histNext ? 'Load more history' : 'Load history', disabled: n.histDone ? 'disabled' : null, onclick: function () { expandNode(n.id); } }),
                  el('button', { type: 'button', text: 'Copy address', onclick: function () { copy(n.address); } }), extLink('/address/' + n.address, 'Open in explorer ↗'), hideBtn([n.id]), removeBtn([n.id])];
      box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
      box.appendChild(autoButtons(n));
      var cs = addrClusterSection(n); if (cs) box.appendChild(cs);
      connectedTxSections(n).forEach(function (s) { box.appendChild(s); });
      box.appendChild(externalCard(n));
    } else {
      if (n.type === 'data') {
        kv(dl, 'Output', S.shortId(n.txid, 8) + ':' + n.vout);
        kv(dl, 'Text', n.dataText); kv(dl, 'Hex', n.dataHex ? (n.dataHex.length > 160 ? n.dataHex.slice(0, 160) + '…' : n.dataHex) : '(empty)');
      } else if (n.type === 'nonstd') {
        kv(dl, 'Output', S.shortId(n.txid, 8) + ':' + n.vout); kv(dl, 'Script type', n.scriptType);
      } else kv(dl, 'Note', 'Newly created coins paid to the miner of the block');
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [hideBtn([n.id]), removeBtn([n.id])]));
    }
    box.appendChild(annotateBox(n));
  }

  function showInspector(soft) { renderInspector(soft); updateInspTab(); }

  // ---- collapsible panels ---------------------------------------------------------------------
  function setSideCollapsed(c) {
    state.sideCollapsed = !!c;
    document.body.classList.toggle('side-collapsed', state.sideCollapsed);
    $('sideTab').hidden = !state.sideCollapsed; $('sideCollapse').setAttribute('aria-expanded', String(!state.sideCollapsed));
    savePrefs();
  }
  function setInspCollapsed(c) {
    state.inspCollapsed = !!c;
    document.body.classList.toggle('insp-collapsed', state.inspCollapsed);
    $('inspCollapse').setAttribute('aria-expanded', String(!state.inspCollapsed));
    updateInspTab(); savePrefs();
  }
  /** The tab that brings the details back: only while they are collapsed and something is selected. */
  function updateInspTab() {
    var has = !$('inspector').hidden, tab = $('inspTab');
    tab.hidden = !(state.inspCollapsed && has);
    if (!tab.hidden) {
      var id = Array.from(state.selected)[0], n = id && state.graph.nodes.get(id);
      $('inspTabText').textContent = state.selected.size > 1 ? state.selected.size + ' selected' : n ? focusLabel(id) : 'Details';
    }
  }

  function showEdge(e) {
    var box = $('inspBody'), g = state.graph, dl = el('dl', { 'class': 'kv' });
    var txn = g.nodes.get(e.kind === 'out' ? e.source : e.target);
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: e.kind === 'out' ? 'Output' : 'Input' })]));
    kvf(dl, 'Amount', S.fmtBtc(e.amount) + ' BTC (' + fmtInt(e.amount) + ' sat)', fiatOfEdge(e));
    kv(dl, 'Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
    kv(dl, 'Transaction', S.shortId(e.txid, 8));
    if (e.kind === 'out') {
      kv(dl, 'Spent', e.spent === true ? 'yes' : e.spent === false ? 'no (unspent so far)' : 'unknown');
      if (e.spentBy) kv(dl, 'Spent by', S.shortId(e.spentBy.txid, 8));
    }
    box.appendChild(dl);
    var acts = [];
    if (txn) acts.push(el('button', { type: 'button', text: 'Select transaction', onclick: function () { selectOnly(txn.id); } }));
    acts.push(el('button', { type: 'button', text: 'Copy txid', onclick: function () { copy(e.txid, 'the transaction id'); } }));
    if (e.spentBy) acts.push(el('button', { type: 'button', text: 'Copy spender txid', onclick: function () { copy(e.spentBy.txid, 'the spender\'s transaction id'); } }));
    if (e.spentBy && g.nodes.has(ID.tx(e.spentBy.txid))) acts.push(el('button', { type: 'button', text: 'Select spender', onclick: function () { selectOnly(ID.tx(e.spentBy.txid)); } }));
    box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
  }

  function removeIds(ids) {
    pushUndoLoad(snapshotGraph('Remove ' + plural(ids.length, 'vertex', 'vertices')), 'removed ' + ids.length);
    ids.forEach(function (id) {
      state.graph.removeNode(id); state.keep.delete(id); state.pinned.delete(id); state.hidden.delete(id); if (state.focus === id) state.focus = null;
    });
    traceForget(ids);
    state.selected = new Set(); state.selectedEdge = null;
    state.graph.refreshDerived(); afterGraphChange(); syncSelection(); updateTraceUi(); scheduleSave();
  }

  // ---- tooltip --------------------------------------------------------------------------------
  function onHover(nodeId, edgeId, at) {
    var tip = $('tooltip');
    if (!at || (!nodeId && !edgeId)) { tip.hidden = true; return; }
    var g = state.graph; tip.textContent = '';
    function line(k, v) { if (v === null || v === undefined || v === '') return; tip.appendChild(el('div', {}, [el('b', { text: k + ' ' }), String(v)])); }
    function fline() { /* amounts follow the display choice through mixText now */ }
    if (nodeId) {
      var n = g.nodes.get(nodeId); if (!n) { tip.hidden = true; return; }
      if (n.type === 'tx') {
        line('Transaction', S.shortId(n.txid, 10)); line('Time', n.time != null ? S.fmtTimeFull(n.time) : (n.confirmed === false ? 'unconfirmed' : 'unknown'));
        if (n.loaded) { line('Value', mixText(S.fmtBtc(n.valueOut) + ' BTC', fiatOf(n.valueOut, n.time)) + ' · ' + n.nIn + ' in / ' + n.nOut + ' out'); } else line('', 'Not loaded: double-click to load');
        var ar = n.loaded ? analysis().tx.get(n.id) : null;
        if (ar && ar.flags.length) line('Pattern', ar.flags.map(function (f) { return f.short; }).join(', '));
        if (ar && ar.change && AN.rank(ar.change.confidence) >= 2) line('Likely change', 'output ' + ar.change.vout + ' (' + ar.change.confidence + ' confidence)');
      } else if (n.type === 'addr') {
        line('Address', S.shortId(n.address, 12)); if (KNOWN[n.address]) line('Known', KNOWN[n.address].label);
        line('Type', n.scriptType); line('Received', mixText(S.fmtBtc(n.received) + ' BTC', fiatSum(n, true))); line('First seen', n.firstSeen != null ? S.fmtTime(n.firstSeen) : null);
        var cl = analysis().clusters.byAddr.get(n.id); if (cl) line('Cluster', cl.label + ' · ' + cl.size + ' addresses spent together');
      } else if (n.type === 'data') { line('OP_RETURN', n.dataText || (n.dataHex ? n.dataHex.slice(0, 48) + (n.dataHex.length > 48 ? '…' : '') : 'empty')); }
      else if (n.type === 'coinbase') line('Coinbase', 'newly created coins');
      else line('Non-standard output', n.scriptType);
      if (n.label) line('Label', n.label);
      if (n.note) line('Note', n.note.length > 140 ? n.note.slice(0, 140) + '…' : n.note);
    } else {
      var e = g.edges.get(edgeId); if (!e) { tip.hidden = true; return; }
      line(e.kind === 'out' ? 'Output' : 'Input', mixText(S.fmtBtc(e.amount) + ' BTC', fiatOfEdge(e))); line('Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
      if (e.kind === 'out') line('Spent', e.spent === true ? 'yes' : e.spent === false ? 'no' : 'unknown');
    }
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(at.x + 14, window.innerWidth - w - 8) + 'px';
    tip.style.top = Math.min(at.y + 14, window.innerHeight - h - 8) + 'px';
  }

  // ---- label packs: other people's lists of wallets and names ----------------------------------------
  var PACK_STORE_LIMIT = 2500000;                                          // characters kept in this browser; a bigger pack works until the page is closed
  function rebuildKnown() {
    Object.keys(KNOWN).forEach(function (k) { delete KNOWN[k]; });
    Object.keys(KNOWN_BASE).forEach(function (k) { KNOWN[k] = KNOWN_BASE[k]; });
    state.packs.forEach(function (p) {
      if (!p.enabled) return;
      p.entries.forEach(function (e) {
        var cur = KNOWN[e.address];
        if (!cur) KNOWN[e.address] = { label: e.label, pack: p.name, category: e.category || undefined, url: e.url || undefined, note: e.note || undefined };
        else { cur = Object.assign({}, cur); cur.alt = (cur.alt || []).concat([e.label + ' (' + p.name + ')']).slice(0, 5); KNOWN[e.address] = cur; }
      });
    });
    state.knownVersion++;
  }
  function savePacks() {
    var text = JSON.stringify(state.packs.map(function (p) { return { id: p.id, name: p.name, source: p.source, enabled: p.enabled, entries: p.entries.map(function (e) { return [e.address, e.label, e.category, e.url, e.note]; }) }; }));
    state.packs.forEach(function (p) { p.stored = true; });
    if (text.length > PACK_STORE_LIMIT || !store.set(PACKS_KEY, text)) {
      store.del(PACKS_KEY); state.packs.forEach(function (p) { p.stored = false; });
      if (state.packs.length) log('The label packs are too large to keep in this browser: they stay until the page is closed.', true);
    }
  }
  function loadPacks() {
    var raw = store.get(PACKS_KEY); if (!raw) return;
    try {
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      state.packs = list.slice(0, 20).map(function (p, i) {
        var entries = (Array.isArray(p.entries) ? p.entries : []).filter(function (e) { return Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string'; })
          .map(function (e) { return { address: e[0], label: LB.cleanText(e[1], 120), category: LB.cleanText(e[2], 40), url: LB.cleanUrl(e[3]), note: LB.cleanText(e[4], 500) }; });
        return { id: String(p.id || 'p' + i).slice(0, 40), name: LB.cleanText(p.name, 80) || 'Labels', source: LB.cleanText(p.source, 200), enabled: p.enabled !== false, entries: entries, stored: true };
      });
    } catch (e) { /* ignore corrupt data */ }
    rebuildKnown();
  }
  function packMatches(p) {
    var k = 0;
    state.graph.nodes.forEach(function (n) { if (n.type === 'addr' && p.entries.length && p.index && p.index.has(n.address)) k++; });
    return k;
  }
  function renderPacks() {
    var box = $('packList'); box.textContent = '';
    state.packs.forEach(function (p) {
      if (!p.index) p.index = new Set(p.entries.map(function (e) { return e.address; }));
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Use ' + p.name }); cb.checked = p.enabled;
      cb.addEventListener('change', function () { p.enabled = cb.checked; rebuildKnown(); savePacks(); refresh(); showInspector(true); renderPacks(); });
      var hits = packMatches(p);
      box.appendChild(el('div', { 'class': 'packrow' }, [cb,
        el('span', { 'class': 'packname', title: p.source || p.name }, [p.name, el('small', { text: fmtInt(p.entries.length) + ' wallets' + (hits ? ' · ' + hits + ' on screen or loaded' : '') + (p.stored === false ? ' · not kept in this browser' : '') })]),
        el('button', { type: 'button', title: 'Remove this pack', 'aria-label': 'Remove ' + p.name, onclick: function () { removePack(p.id); } , text: '×' })]));
    });
    $('packHint').textContent = state.packs.length ? '' : 'No packs imported yet.';
  }
  function removePack(id) {
    state.packs = state.packs.filter(function (p) { return p.id !== id; });
    rebuildKnown(); savePacks(); renderPacks(); refresh(); showInspector(true);
  }
  function importPack(text, filename) {
    var r;
    try { r = LB.parse(text, String(filename || 'Imported labels').replace(/\.(csv|json|txt)$/i, '')); } catch (e) { toast('Import failed: ' + e.message, true); return; }
    var replaced = state.packs.filter(function (p) { return p.name === r.name; }).length;
    state.packs = state.packs.filter(function (p) { return p.name !== r.name; }).slice(0, 19);
    var pack = { id: 'p' + Date.now().toString(36), name: r.name, source: r.source, enabled: true, entries: r.entries, stored: true, index: new Set(r.entries.map(function (e) { return e.address; })) };
    state.packs.push(pack);
    rebuildKnown(); savePacks(); renderPacks(); refresh(); showInspector(true);
    var s = r.skipped, left = [];
    if (s.invalid) left.push(s.invalid + ' failed the address checksum');
    if (s.otherChain) left.push(s.otherChain + ' were not Bitcoin addresses');
    if (s.duplicate) left.push(s.duplicate + ' repeated');
    if (s.empty) left.push(s.empty + ' had no label');
    toast((replaced ? 'Replaced the pack "' + r.name + '": ' : 'Imported ') + fmtInt(r.entries.length) + ' labelled wallets' + (packMatches(pack) ? ', ' + packMatches(pack) + ' of them already in the workspace' : '') + '.'
      + (left.length ? ' Left out: ' + left.join(', ') + '.' : '') + (r.truncated ? ' Stopped at ' + fmtInt(LB.MAX_ENTRIES) + ' entries.' : ''), !!left.length && !r.entries.length);
  }
  function exportOwnLabels(kind) {
    var entries = LB.fromGraph(state.graph);
    if (!entries.length) { toast('Nothing to export: label or tag a wallet first (its details panel).', true); return; }
    var name = 'orion-labels-' + stamp();
    if (kind === 'json') download(name + '.json', LB.toJson(entries, { name: 'Orion labels ' + stamp(), source: 'exported from Orion' }), 'application/json');
    else download(name + '.csv', '\ufeff' + LB.toCsv(entries), 'text/csv;charset=utf-8');
    log('Exported ' + entries.length + ' labelled wallets (' + kind + ')');
  }

  // ---- analysis: patterns, likely change, clusters ----------------------------------------------
  // All of it is a guess from what is loaded; every result carries its reasons (see orion-analysis.js).
  var CLUSTER_COLORS = ['#00d1b2', '#ff7aa2', '#ffd23f', '#7aa2ff', '#b58cff', '#ff9f43', '#6be675', '#e0e0e0'];
  var FLAG_NAME = { consolidation: 'CONSOL', batch: 'BATCH', coinjoin: 'COINJOIN?', peel: 'PEEL' };

  /** What marks a wallet as already known: your label, your tag, or the known list. null when nothing does. */
  function markOf(address) {
    var n = state.graph.nodes.get(ID.addr(address));
    if (n && n.label) return n.label;
    if (n && n.tag) return n.tag;
    return KNOWN[address] ? KNOWN[address].label : null;
  }

  /** What the analysis found in everything loaded. Recomputed only when something it depends on has changed. */
  function analysis() {
    var g = state.graph, loaded = 0, outs = 0, marked = 0, excluded = 0;
    g.nodes.forEach(function (n) {
      if (n.type === 'tx') { if (n.loaded) loaded++; if (n.outspendsLoaded) outs++; if (n.noCluster) excluded++; }
      else if (n.label || n.tag) marked++;
    });
    var sig = g.nodes.size + '/' + g.edges.size + '/' + loaded + '/' + outs + '/' + marked + '/' + excluded + '/' + state.knownVersion;
    if (!state.an || state.anSig !== sig || state.anGraph !== g) {
      state.an = AN.analyse(g, { known: function (a) { return !!markOf(a); } }); state.anSig = sig; state.anGraph = g;
    }
    return state.an;
  }
  // the three hooks the canvas calls for every vertex it draws: they only read what refresh() computed
  function nodeFlags(n) {
    var r = n.type === 'tx' && state.an ? state.an.tx.get(n.id) : null;
    return r && r.flags.length ? r.flags.map(function (f) { return { text: f.short, color: f.color }; }) : null;
  }
  function clusterColorOf(cl) { return CLUSTER_COLORS[(parseInt(cl.label.slice(1), 10) - 1) % CLUSTER_COLORS.length]; }
  function clusterColor(id) { var cl = state.an ? state.an.clusters.byAddr.get(id) : null; return cl ? clusterColorOf(cl) : null; }
  function changeEdgeMark(e) { return e.kind === 'out' && state.an && state.an.changeEdges.has(e.id) ? AN.COLORS.change : null; }

  /** Select the given vertices that are on screen, and say so when some are not. */
  function selectIds(ids, what) {
    var vis = renderer.data ? renderer.data.visible.nodes : null;
    var show = vis ? ids.filter(function (id) { return vis.has(id); }) : ids.slice();
    if (!show.length) { toast('None of the ' + what + ' is on screen (the layout or a filter hides them).'); return; }
    state.selected = new Set(show); state.selectedEdge = null; syncSelection(); renderer.ensureVisible(show);
    if (show.length < ids.length) toast(show.length + ' of ' + ids.length + ' ' + what + ' are on screen; the rest are hidden by the layout or a filter.');
  }
  function setNoCluster(txId, on) {
    var n = state.graph.nodes.get(txId); if (!n) return;
    if (on) n.noCluster = true; else delete n.noCluster;
    showInspector(); refresh(); scheduleSave();
  }

  /** The Analysis panel: what was found, as lists that select the vertices involved. */
  var findingsFor = null;
  function updateFindings() {
    var box = $('anFindings');
    if (!state.graph.nodes.size) { box.textContent = ''; findingsFor = null; return; }
    var an = analysis(), byKind = {}, kinds, loaded = 0;
    if (findingsFor === an && box.firstChild) return;                       // nothing it shows has changed: leave the buttons alone (a replay refreshes many times a second)
    findingsFor = an; box.textContent = '';
    state.graph.nodes.forEach(function (n) { if (n.type === 'tx' && n.loaded) loaded++; });
    an.tx.forEach(function (r, id) { r.flags.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || { f: f, ids: [] }).ids.push(id); }); });
    kinds = Object.keys(byKind);
    function row(left, amt, title, fn, copyText, copyWhat) { var b = el('button', { type: 'button', 'class': 'linkrow', title: title, onclick: fn }, [left, el('span', { 'class': 'amt', text: amt })]); return copyText ? withCopy(b, copyText, copyWhat) : b; }
    function more(list, shown) { if (list.length > shown) box.appendChild(el('div', { 'class': 'hint', text: '… and ' + (list.length - shown) + ' more' })); }
    if (kinds.length) {
      box.appendChild(el('span', { 'class': 'lbl', text: 'Patterns' }));
      kinds.forEach(function (k) {
        var e = byKind[k], tag = el('span', { 'class': 'flagtag', text: FLAG_NAME[k] }); tag.style.color = e.f.color;
        box.appendChild(row(tag, String(e.ids.length), 'Select these ' + e.ids.length + ' transactions', function () { selectIds(e.ids, FLAG_NAME[k] + ' transactions'); }));
      });
    }
    if (an.chains.length) {
      box.appendChild(el('span', { 'class': 'lbl', text: 'Possible peel chains' }));
      an.chains.slice(0, 6).forEach(function (ch) {
        box.appendChild(row(el('span', { text: ch.label + ' · ' + ch.ids.length + ' transactions' }), 'peeled ' + S.fmtBtc(ch.totalPeeled), 'Select the ' + ch.ids.length + ' transactions of this chain', function () { selectIds(ch.ids, 'transactions of ' + ch.label); }, ch.ids.map(plainId).join(NL), plural(ch.ids.length, 'transaction id')));
      });
      more(an.chains, 6);
    }
    var cl = an.clusters.list;
    if (cl.length) {
      box.appendChild(el('span', { 'class': 'lbl', text: 'Address clusters' }));
      cl.slice(0, 6).forEach(function (c) {
        var sw = el('span', { 'class': 'sw' }); sw.style.color = clusterColorOf(c);
        box.appendChild(row(el('span', { 'class': 'rowtext' }, [sw, ' ' + c.label + ' · ' + c.size + ' addresses']), c.txs.length + ' tx', 'Select the addresses of this cluster (they were spent together in ' + c.txs.length + ' transaction' + (c.txs.length === 1 ? '' : 's') + ')', function () { selectIds(c.addrs, 'addresses of ' + c.label); }, c.addrs.map(plainId).join(NL), plural(c.addrs.length, 'address', 'addresses')));
      });
      more(cl, 6);
    }
    var sk = an.clusters.skipped;
    if (sk.coinjoin || sk.excluded) box.appendChild(el('p', { 'class': 'hint', text: (sk.coinjoin ? sk.coinjoin + ' CoinJoin-like transaction' + (sk.coinjoin === 1 ? '' : 's') : '') + (sk.coinjoin && sk.excluded ? ' and ' : '') + (sk.excluded ? sk.excluded + ' you excluded' : '') + ' not used to link addresses.' }));
    if (!kinds.length && !cl.length) box.appendChild(el('p', { 'class': 'hint', text: loaded ? 'Nothing notable in the ' + loaded + ' transaction' + (loaded === 1 ? '' : 's') + ' loaded.' : 'Load transactions to look for patterns.' }));
  }

  /** Patterns, the change guess and the common-input link for one transaction, in the details panel. */
  function txAnalysisSection(n) {
    if (!n.loaded) return null;
    var r = analysis().tx.get(n.id), v = AN.txView(state.graph, n.id), parts = [], ch = r && r.change;
    if (r && r.flags.length) {
      var s = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Patterns' })]);
      r.flags.forEach(function (f) { var t = el('span', { 'class': 'flagtag', text: f.short }); t.style.color = f.color; s.appendChild(el('p', { 'class': 'hint' }, [t, f.title])); });
      parts.push(s);
    }
    if (ch) {
      var s2 = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Likely change' })]);
      s2.appendChild(el('p', { 'class': 'hint' }, [el('b', { text: 'Output ' + ch.vout + (ch.address ? ' → ' + S.shortId(ch.address, 8) : '') }), ' · ' + amountText(ch.amount, n.time) + ' · ' + ch.confidence + ' confidence']));
      var ul = el('ul', { 'class': 'reasons' }); ch.reasons.forEach(function (x) { ul.appendChild(el('li', { text: x })); }); s2.appendChild(ul);
      s2.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Select that output', onclick: function () { selectIds([ch.id], 'outputs'); } }),
        el('button', { type: 'button', text: 'Follow the change ▶▶', title: 'Auto-expand forward along this output only', onclick: function () { autoExpand(n.id, { dir: 'next', follow: 'change' }); } })]));
      s2.appendChild(el('p', { 'class': 'hint', text: 'A guess from the evidence above, not a certainty.' }));
      parts.push(s2);
    } else if (v && v.complete && !v.coinbase && AN.payOuts(v).length >= 2) {
      parts.push(el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Likely change' }), el('p', { 'class': 'hint', text: 'None named: the evidence does not single out one output.' })]));
    }
    if (v && v.complete && !v.coinbase) {
      var owners = new Set(v.inputs.filter(function (i) { return i.address; }).map(function (i) { return i.address; })).size;
      if (owners >= 2) {
        var mix = AN.coinjoinLike(v), btn = null, text;
        if (n.noCluster) { text = 'Its ' + owners + ' input addresses are NOT linked: you excluded this transaction.'; btn = el('button', { type: 'button', text: 'Link them again', onclick: function () { setNoCluster(n.id, false); } }); }
        else if (mix) text = 'Its input addresses are not linked: it looks like a CoinJoin, so they are probably different owners.';
        else { text = 'Its ' + owners + ' input addresses are treated as one owner (they were spent together).'; btn = el('button', { type: 'button', text: 'Not the same owner: exclude', title: 'Leave this transaction out of address clusters (a CoinJoin, a PayJoin, a shared wallet)', onclick: function () { setNoCluster(n.id, true); } }); }
        parts.push(el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Address link' }), el('p', { 'class': 'hint', text: text }), btn ? el('div', { 'class': 'insp-actions' }, [btn]) : null]));
      }
    }
    return parts;
  }

  /** The cluster an address belongs to, in the details panel. */
  function addrClusterSection(n) {
    var cl = analysis().clusters.byAddr.get(n.id); if (!cl) return null;
    var s = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Cluster ' + cl.label })]), g = state.graph;
    s.appendChild(el('p', { 'class': 'hint', text: cl.size + ' addresses were spent together in ' + cl.txs.length + ' transaction' + (cl.txs.length === 1 ? '' : 's') + ', which usually means one owner. It is a guess: a CoinJoin or a service sharing a wallet can break it.' }));
    s.appendChild(el('div', { 'class': 'insp-actions' }, [
      el('button', { type: 'button', text: 'Select the cluster', onclick: function () { selectIds(cl.addrs, 'addresses of ' + cl.label); } }),
      el('button', { type: 'button', text: 'Copy ' + plural(cl.addrs.length, 'address', 'addresses'), title: 'One per line', onclick: function () { copy(cl.addrs.map(plainId).join(NL), plural(cl.addrs.length, 'address', 'addresses')); } }),
      el('button', { type: 'button', text: 'Tag the cluster…', title: 'Tag every address of the cluster at once', onclick: function () { openTagEditor(cl.addrs.filter(function (id) { return g.nodes.has(id); })); } })]));
    var list = el('div', { 'class': 'linkrows' });
    cl.addrs.slice(0, 8).forEach(function (id) {
      var a = g.nodes.get(id), who = a ? (a.label || (KNOWN[a.address] && KNOWN[a.address].label) || S.shortId(a.address, 8)) : id;
      list.appendChild(withCopy(el('button', { type: 'button', 'class': 'linkrow', title: id, onclick: function () { navigate(id, { light: true }); } }, [el('span', { text: (id === n.id ? '● ' : '') + who })]), a ? a.address : plainId(id), 'address'));
    });
    if (cl.addrs.length > 8) list.appendChild(el('div', { 'class': 'hint', text: '… and ' + (cl.addrs.length - 8) + ' more' }));
    s.appendChild(list);
    return s;
  }

  function autoButtons(n) {
    var hops = state.auto.hops;
    return el('div', { 'class': 'insp-actions' }, [
      el('button', { type: 'button', text: 'Auto-expand ▶▶', title: 'Follow the money forward, ' + hops + ' transactions deep (settings under Auto-expand)', onclick: function () { autoExpand(n.id, { dir: 'next' }); } }),
      el('button', { type: 'button', text: '◀◀ Auto-expand', title: 'Follow the money backward, ' + hops + ' transactions deep', onclick: function () { autoExpand(n.id, { dir: 'prev' }); } })]);
  }

  // ---- auto-expand: follow the money several transactions deep -------------------------------------
  var FOLLOW_HINT = {
    all: 'Follows every spent output, the largest first, up to the limit per transaction. The wallets it does not follow stay on screen so you can expand them by hand.',
    largest: 'Follows only the largest output of each transaction.',
    change: 'Follows the output that most likely returns to the sender, and stops where the evidence is not clear enough to name one.',
    peel: 'Follows the large output of each transaction that has one input and two outputs, the small one at most half the large one, and stops at anything else. Forward only.'
  };
  function autoTarget() {
    var sel = Array.from(state.selected).filter(walletOrTx);
    if (sel.length === 1) return sel[0];
    return !sel.length && state.focus && walletOrTx(state.focus) ? state.focus : null;
  }
  function syncAutoUi() {
    var a = state.auto;
    setSeg('autoDirSeg', 'data-dir', a.dir);
    $('autoHops').value = a.hops; $('autoFollow').value = a.follow; $('autoMaxTx').value = a.maxTx; $('autoMaxReq').value = a.maxReq; $('autoPerTx').value = a.perTx; $('autoMin').value = a.minSats;
    $('autoStopLabel').checked = a.stopLabel; $('autoStopMix').checked = a.stopMix;
    $('anFlags').checked = state.analysis.flags; $('anChange').checked = state.analysis.change; $('anClusters').checked = state.analysis.clusters;
    updateAutoUi();
  }
  function updateAutoUi() {
    var a = state.auto, id = autoTarget(), btn = $('autoGo');
    $('autoFollowHint').textContent = FOLLOW_HINT[a.follow] + (a.dir === 'prev' && (a.follow === 'change' || a.follow === 'peel') ? ' Backward this follows the largest input instead.' : '');
    btn.disabled = !id;
    btn.textContent = id ? 'Auto-expand from ' + focusLabel(id).replace(/^tx /, '') : 'Auto-expand from selected';
    $('autoHint').textContent = id ? '' : 'Select a transaction or a wallet first.';
  }
  function readAuto() {
    state.auto = cleanAuto({ dir: state.auto.dir, hops: $('autoHops').value, follow: $('autoFollow').value, maxTx: $('autoMaxTx').value, maxReq: $('autoMaxReq').value, perTx: $('autoPerTx').value, minSats: $('autoMin').value,
                             stopLabel: $('autoStopLabel').checked, stopMix: $('autoStopMix').checked });
    syncAutoUi(); savePrefs();
  }

  function successorOpts(o) {
    return { follow: o.follow, perTx: o.perTx, minSats: o.minSats, stopAtMix: o.stopMix, mark: o.stopLabel ? markOf : null, known: function (a) { return !!markOf(a); } };
  }
  /** The transactions a wallet's money went through (forward) or came from (backward), largest first. */
  function txNeighbourIds(id, dir, limit) {
    var g = state.graph, rows = Array.from(TR.neighbours(g, id, dir).values()).filter(function (r) { return r.type === 'tx'; });
    rows.sort(function (a, b) { return b.amount - a.amount; });
    return rows.slice(0, limit).map(function (r) { return g.nodes.get(r.id).txid; });
  }
  /** Where the walk went, transaction by transaction, as the rules see it now (the same call the walk made). */
  function walkSteps(w, dir, sopts) {
    return (w.asked || []).map(function (a) { return { txid: a.txid, level: a.level, res: AN.successors(state.graph, ID.tx(a.txid), dir, sopts) }; });
  }

  /** In the Trace layout: show what the walk loaded, placed in columns beside the vertex it came from. Returns the ids shown. */
  function traceRevealWalk(startId, dir, w, steps) {
    var g = state.graph, T = state.trace, revealed = [], loadedAt = new Set();
    w.levels.forEach(function (l) { l.forEach(function (t) { loadedAt.add(t); }); });
    function put(parentId, ids) {
      var fresh = []; ids.forEach(function (id) { if (g.nodes.has(id) && !T.shown.has(id) && fresh.indexOf(id) < 0) fresh.push(id); });
      if (!fresh.length) return;
      TR.place(T.pos, parentId, dir, { primary: fresh.map(function (id) { return { id: id }; }), secondary: [] }).forEach(function (p, id) { T.pos.set(id, p); });
      fresh.forEach(function (id) { T.shown.add(id); T.prov.set(id, { via: parentId, dir: dir }); revealed.push(id); });
    }
    if (g.nodes.get(startId).type === 'addr') put(startId, (w.levels[0] || []).map(ID.tx));
    steps.forEach(function (st) {
      var tx = ID.tx(st.txid);
      if (!T.shown.has(tx)) return;
      put(tx, st.res.items.map(function (it) { return it.id; }));
      st.res.items.forEach(function (it) { if (it.followed && it.spender && loadedAt.has(it.spender)) put(it.id, [ID.tx(it.spender)]); });
    });
    return revealed;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

  /** One sentence on what happened, one on why it stopped, and the details of how each branch ended. */
  function autoMessage(w, steps, dir, o) {
    var hops = Math.max(0, w.levels.length - 1);
    var msg = 'Followed ' + (dir === 'next' ? 'forward' : 'backward') + ' ' + plural(hops, 'hop') + ': ' + plural(w.loadedNew, 'new transaction') + ' loaded, ' + plural(w.requests, 'request') + '.';
    var ends = { unspent: 0, labelled: 0, mix: 0, change: 0, peel: 0, unknown: 0, coinbase: 0 }, names = [];
    steps.forEach(function (st) {
      var s = st.res.stop;
      if (s) { if (/CoinJoin/.test(s)) ends.mix++; else if (/clear change/.test(s)) ends.change++; else if (/peel step/.test(s)) ends.peel++; else if (/coinbase/.test(s)) ends.coinbase++; }
      st.res.items.forEach(function (it) {
        if (!it.why) return;
        if (/^labelled/.test(it.why)) { ends.labelled++; var nm = it.why.slice(10); if (names.indexOf(nm) < 0 && names.length < 3) names.push(nm); }
        else if (it.why === 'unspent') ends.unspent++;
        else if (/not known/.test(it.why)) ends.unknown++;
      });
    });
    var bits = [];
    if (ends.labelled) bits.push(plural(ends.labelled, 'output') + ' reached a labelled wallet (' + names.join(', ') + ')');
    if (ends.mix) bits.push(plural(ends.mix, 'transaction') + ' looked like a CoinJoin');
    if (ends.change) bits.push(plural(ends.change, 'transaction') + ' had no clear change output');
    if (ends.peel) bits.push(plural(ends.peel, 'transaction') + ' was not a peel step');
    if (ends.unspent) bits.push(plural(ends.unspent, 'output') + ' unspent');
    if (ends.unknown) bits.push(plural(ends.unknown, 'output') + ' with no known spender');
    if (bits.length) msg += ' Ended at: ' + bits.join(', ') + '.';
    if (w.reason === 'cap-tx') msg += ' Stopped at the limit of ' + plural(o.maxTx, 'transaction') + (w.left ? ' (' + w.left + ' more known, not loaded)' : '') + '.';
    else if (w.reason === 'cap-requests') msg += ' Stopped at the limit of ' + plural(o.maxReq, 'request') + '.';
    else if (w.reason === 'cancelled') msg += ' Cancelled: what was loaded is kept.';
    else if (hops < o.hops && !bits.length) msg += ' Nothing further to follow.';
    return msg;
  }

  /**
   * Follow the money several transactions deep from a transaction or a wallet. `over` overrides the panel's settings
   * ({dir, follow, hops, ...}). The load is one cancellable action under the request limit; in the Trace layout what it
   * loaded is shown, in one step that Ctrl+Z takes back.
   */
  function autoExpand(id, over) {
    var o = Object.assign({}, state.auto, over || {}), g = state.graph, n = g.nodes.get(id);
    if (!n || (n.type !== 'tx' && n.type !== 'addr')) { toast('Select a transaction or a wallet to expand from.'); return Promise.resolve(false); }
    if (traceOn() && !state.trace.shown.has(id)) { toast('That vertex is not on screen: show it first.'); return Promise.resolve(false); }
    var dir = o.dir === 'prev' ? 'prev' : 'next', sopts = successorOpts(o), walk = null;
    var title = 'Auto-expand ' + (dir === 'next' ? 'forward' : 'backward') + ' from ' + S.shortId(n.type === 'tx' ? n.txid : n.address, 6);
    return run(title, function () {
      var ex = state.explorer, total = { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] };
      function add(r) {
        if (!r) return;
        total.added += r.added || 0; total.requests += r.requests || 0; total.truncated = total.truncated || !!r.truncated; total.errors = total.errors.concat(r.errors || []);
        if (r.failed) total.failed = true;
      }
      return Promise.resolve().then(function () {
        var nd = g.nodes.get(id);
        if (nd.type === 'addr' && !txNeighbourIds(id, dir, 1).length && (nd.txCount == null || nd.histNext)) {            // nothing known on this side yet: ask for the wallet's history
          return ex.expandAddress(nd.address, { pages: state.capPages, cap: state.capPages * 25, after: nd.histNext || undefined }).then(function (r) {
            nd.histNext = r.last || null; nd.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); add(r);
          });
        }
      }).then(function () {
        var nd = g.nodes.get(id), starts = nd.type === 'tx' ? [nd.txid] : txNeighbourIds(id, dir, o.perTx);
        if (!starts.length) return;
        return ex.walk(starts, { dir: dir, hops: o.hops, maxTx: o.maxTx, successors: function (txid) { return AN.successors(g, ID.tx(txid), dir, sopts); } }).then(function (w) { walk = w; add(w); });
      }).then(function () { return total; });
    }, { maxRequests: o.maxReq }).then(function (r) {
      if (!r) return false;
      if (!walk) { if (!r.failed) toast(n.type === 'addr' ? 'No transactions known ' + (dir === 'next' ? 'spending from' : 'paying') + ' this wallet.' : 'Nothing to follow from here.'); return false; }
      var steps = walkSteps(walk, dir, sopts), msg = autoMessage(walk, steps, dir, o), shownNow = 0;
      if (traceOn()) {
        var T = state.trace, rev = traceRevealWalk(id, dir, walk, steps);
        if (rev.length) { T.undo.push({ type: 'reveal', ids: rev.slice() }); traceChanged(rev, false); shownNow = rev.length; msg += ' ' + plural(rev.length, 'vertex', 'vertices') + ' shown (Ctrl+Z takes them back).'; }
      } else if (state.focusOn && walk.loadedNew) {
        state.focusOn = false; $('focusOn').checked = false; savePrefs(); afterGraphChange({ fit: true });                // a focus view shows at most 3 steps: show the whole path
        msg += ' The Focus view was switched off so the whole path shows.';
      }
      toast(msg, !!(r.errors || []).filter(function (e) { return !/request cap/.test(e); }).length);
      return walk.loadedNew > 0 || shownNow > 0;
    });
  }

  // ---- refresh --------------------------------------------------------------------------------
  function seedPositions(structural) {
    var start = new Map(), rnd = L.rng(5);
    structural.nodes.forEach(function (id) { var p = renderer.positionOf(id); if (p) start.set(id, { x: p.x, y: p.y }); });
    structural.nodes.forEach(function (id) {
      if (start.has(id)) return;
      var near = state.graph.edgesOf(id).map(function (e) { return start.get(e.source === id ? e.target : e.source); }).filter(Boolean)[0];
      if (near) start.set(id, { x: near.x + (rnd() - 0.5) * 80, y: near.y + (rnd() - 0.5) * 80 });
    });
    return start;
  }

  /** o: { relayout, fit, instant } */
  function refresh(o) {
    o = o || {};
    var g = state.graph, f = state.filter;
    edgeLabelCache.clear();
    renderer.fitPad = traceOn() ? 120 : 60;                                  // a trace needs room for the expand handles beside the outer vertices
    renderer.insets.bottom = state.focus && g.nodes.has(state.focus) && !traceOn() ? Math.max(84, $('stepbar').offsetHeight + 22) : 0;       // keep the graph clear of the step bar
    analysis();                                                              // the canvas hooks below read the cached result
    var structural = scope();
    var style = S.makeStyle(g, structural, { colorBy: state.colorBy, sizeBy: effectiveSizeBy() });
    function radiusOf(id) { var nd = g.nodes.get(id); return nd ? style.nodeRadius(nd) : 0; }       // how big a shape is drawn: the force layout leaves room for it
    if (traceOn() && state.arrange !== 'columns') {                          // a trace spread over time, by force, or by time and amount: the same layouts as the other views, over what is shown
      if (o.relayout || o.traceChanged || !state.layoutRes || state.layoutRes.arr !== state.arrange) {
        var aopts = state.arrange === 'force' ? { start: seedPositions(structural), seed: 1, radius: radiusOf }
                   : state.arrange === 'timeforce' ? { width: 1600, scale: state.timeScale, start: seedPositions(structural), seed: 1, radius: radiusOf } : { width: 1600, scale: state.timeScale };
        state.layoutRes = L.layout(state.arrange, g, structural, aopts); state.layoutRes.arr = state.arrange;
        state.pinned.forEach(function (p, id) { if (state.layoutRes.pos.has(id)) state.layoutRes.pos.set(id, { x: p.x, y: p.y }); });
        renderer.setPositions(state.layoutRes.pos, !!o.instant || !renderer.cur.size);
      }
    } else if (traceOn()) {
      var T = state.trace, tpos = new Map();
      T.shown.forEach(function (id) { if (g.nodes.has(id) && T.pos.has(id)) tpos.set(id, { x: T.pos.get(id).x, y: T.pos.get(id).y }); });
      if (o.relayout || o.traceChanged || !state.layoutRes || !state.layoutRes.trace) {
        tpos.forEach(function (p, id) {                                    // new vertices grow out of the one that revealed them
          if (renderer.cur.has(id)) return;
          var via = T.prov.get(id), a = via && renderer.positionOf(via.via);
          if (a) renderer.cur.set(id, { x: a.x, y: a.y });
        });
        state.layoutRes = { pos: tpos, axis: null, trace: true };
        renderer.setPositions(tpos, !!o.instant || !renderer.cur.size);
      }
    } else if (o.relayout || !state.layoutRes || state.layoutRes.trace || state.layoutRes.arr) {
      var opts = state.layout === 'force' ? { start: seedPositions(structural), seed: 1, radius: radiusOf } : state.layout === 'timeline' ? { width: 1600, scale: state.timeScale } : {};
      state.layoutRes = L.layout(state.layout, g, structural, opts);
      state.pinned.forEach(function (p, id) { if (state.layoutRes.pos.has(id)) state.layoutRes.pos.set(id, { x: p.x, y: p.y }); });
      renderer.setPositions(state.layoutRes.pos, !!o.instant || !renderer.cur.size);
    }
    var visible = F.computeVisible(g, f, state.keep, focusOpt(), traceOnly(), hiddenOpt());
    renderer.setData({ graph: g, visible: visible, style: style, known: KNOWN, axis: timeScaleOn() && state.layoutRes ? state.layoutRes.axis : marksOn() ? { mode: 'marks' } : null,
                       range: { from: f.timeFrom, to: f.timeTo }, showLabels: state.showLabels, focusId: focusOpt() ? state.focus : null,
                       edgeLabel: state.edgeLabels ? edgeLabelFor : null,
                       handles: traceOn() ? handlesFor : null, handleMore: traceOn() ? handleSummary : null, seedIds: traceOn() ? new Set(state.trace.seeds) : null, noDim: traceOn(), labelAll: traceOn(), nodeNote: traceOn() ? traceNote : null,
                       nodeFlags: state.analysis.flags ? nodeFlags : null, clusterColor: state.analysis.clusters ? clusterColor : null, edgeMark: state.analysis.change ? changeEdgeMark : null });
    document.body.classList.toggle('axis-on', usesAxis());
    if (o.fit) renderer.fit();
    var fo = focusOpt();
    if (traceOn() && state.trace.seed) $('counts').textContent = 'Trace from ' + focusLabel(state.trace.seed) + ' · ' + visible.nodes.size + ' shown · ' + Math.max(0, g.nodes.size - visible.nodes.size) + ' more loaded';
    else $('counts').textContent = g.nodes.size ? (fo ? 'Focus: ' + focusLabel(fo.id) + ' · depth ' + fo.hops + ' · ' : '') + visible.nodes.size + ' of ' + g.nodes.size + ' vertices · ' + visible.edges.size + ' of ' + g.edges.size + ' edges' : '';
    $('empty').hidden = g.nodes.size > 0;
    updateLegend(); updateFindings(); updateAutoUi(); updateTraceUi();
  }

  function afterGraphChange(o) {
    o = o || {};
    state.graph.refreshDerived();
    updateTimebar(); updateAmount(); updateScriptChips();
    refresh({ relayout: true, fit: !!o.fit });
    showInspector(true);
    renderStepBar();
  }

  // ---- legend / filters -----------------------------------------------------------------------
  function updateLegend() {
    var box = $('legend'); box.textContent = '';
    var types = Object.keys(F.scriptTypeCounts(state.graph));
    var lg = S.legend(state.colorBy, types);
    if (lg.gradient) {
      var grad = el('div', { 'class': 'grad' });
      grad.style.background = 'linear-gradient(to right,' + lg.gradient.map(function (s) { return s[1] + ' ' + Math.round(s[0] * 100) + '%'; }).join(',') + ')';
      box.appendChild(grad);
      box.appendChild(el('div', { 'class': 'grad-labels' }, [el('span', { text: 'older' }), el('span', { text: 'newer' })]));
      box.appendChild(legendItem(lg.unknown, 'time unknown'));
    } else lg.items.forEach(function (i) { box.appendChild(legendItem(i.color, i.label)); });
    box.appendChild(el('div', { 'class': 'item', text: 'Edge width = amount · dashed = unspent output' }));
    box.appendChild(el('div', { 'class': 'item', text: effectiveSizeBy() === 'area' ? 'Shape size = value (area proportional to the amount)' : 'Shape size = value (compact scale: sizes differ little)' }));
    if (state.analysis.change && state.an && state.an.changeEdges.size) box.appendChild(legendItem(AN.COLORS.change, 'amber edge = likely change (a guess)'));
    var tags = TG.summarise(Array.from(state.graph.nodes.values()));
    if (tags.length) {
      box.appendChild(el('div', { 'class': 'item', style: 'margin-top:6px;color:var(--text)', text: 'Tags (click to select them)' }));
      tags.forEach(function (t) {
        var glyph = el('span', { 'class': 'tagsw', text: SHAPE_GLYPH[t.shape] || '●' }); if (t.color) glyph.style.color = t.color;
        box.appendChild(el('div', { 'class': 'item tagitem', role: 'button', tabindex: '0', title: t.name,
                                    onclick: function () { selectTag(t.tag); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTag(t.tag); } } },
                           [glyph, el('span', { text: t.tag + ' ' + t.count })]));
      });
    }
  }
  function selectTag(tag) {
    var ids = Array.from(state.graph.nodes.values()).filter(function (n) { return n.tag === tag; }).map(function (n) { return n.id; });
    state.selected = new Set(ids); state.selectedEdge = null; syncSelection();
    toast(ids.length + ' vertices tagged ' + tag + ' selected.');
  }
  function legendItem(color, text) {
    var sw = el('span', { 'class': 'sw' }); sw.style.background = color;
    return el('div', { 'class': 'item' }, [sw, el('span', { text: text })]);
  }

  function updateScriptChips() {
    var box = $('scriptTypes'); box.textContent = '';
    var counts = F.scriptTypeCounts(state.graph), hidden = new Set(state.filter.hiddenScriptTypes);
    var names = Object.keys(counts).sort();
    if (!names.length) { box.appendChild(el('span', { 'class': 'hint', text: 'none yet' })); return; }
    names.forEach(function (t) {
      var cb = el('input', { type: 'checkbox', 'aria-label': t }); cb.checked = !hidden.has(t);
      cb.addEventListener('change', function () {
        var set = new Set(state.filter.hiddenScriptTypes); if (cb.checked) set.delete(t); else set.add(t);
        state.filter.hiddenScriptTypes = Array.from(set); refresh({ relayout: true }); scheduleSave();
      });
      var sw = el('span', { 'class': 'sw' }); sw.style.background = S.SCRIPT_COLORS[t] || S.SCRIPT_COLORS.unknown;
      box.appendChild(el('label', { 'class': 'chip' }, [cb, sw, el('span', { text: t + ' ' + counts[t] })]));
    });
  }

  // amount slider: log scale between 0 and the largest edge
  function amountFromSlider(p) { p = Number(p); if (p <= 0 || state.amountMax < 1) return 0; return Math.max(1, Math.round(Math.pow(10, p / 1000 * Math.log10(state.amountMax + 1)) - 1)); }
  function sliderFromAmount(a) { if (!a || state.amountMax < 1) return 0; return Math.min(1000, Math.round(Math.log10(a + 1) / Math.log10(state.amountMax + 1) * 1000)); }
  function updateAmount() {
    state.amountMax = F.amountRange(state.graph, scope({ minAmount: 0, maxAmount: null }).edges).max;
    $('minAmount').disabled = state.amountMax < 1;
    $('minAmount').value = sliderFromAmount(state.filter.minAmount);
    var a = state.filter.minAmount;
    $('minAmountOut').textContent = a ? '≥ ' + fmtInt(a) + ' sat (' + S.fmtBtc(a) + ' BTC)' : 'off';
  }
  function setMinAmount(a, fromSlider) {
    state.filter.minAmount = a;
    if (!fromSlider) $('minAmount').value = sliderFromAmount(a);
    $('minAmountOut').textContent = a ? '≥ ' + fmtInt(a) + ' sat (' + S.fmtBtc(a) + ' BTC)' : 'off';
    refresh({ relayout: true }); scheduleSave();
  }

  // ---- time bar -------------------------------------------------------------------------------
  function timeOfSlider(v) { var b = state.tb; return Math.round(b.min + (Number(v) / 1000) * (b.max - b.min)); }
  function sliderOfTime(t) { var b = state.tb; return Math.round((t - b.min) / (b.max - b.min) * 1000); }
  function timebarEnabled() { return state.tb.min != null && state.tb.max > state.tb.min; }

  function updateTimebar() {
    var sc = scope(); state.scopeNodes = sc.nodes;
    var b = state.graph.timeBounds(sc.nodes); state.tb = b;
    var dots = [];
    state.graph.nodes.forEach(function (n) { if (n.type === 'tx' && n.time != null && sc.nodes.has(n.id)) dots.push({ id: n.id, time: n.time, value: n.valueOut, loaded: n.loaded !== false }); });
    dots.sort(function (a, c) { return a.time - c.time; }); state.tbTxs = dots;
    var on = timebarEnabled(), f = state.filter;
    $('tFrom').disabled = $('tTo').disabled = !on; $('tbPlay').disabled = $('tbReset').disabled = !on;
    if (on) {
      $('tFrom').value = f.timeFrom == null ? 0 : sliderOfTime(f.timeFrom);
      $('tTo').value = f.timeTo == null ? 1000 : sliderOfTime(f.timeTo);
    }
    syncTimeLabels(); drawHistogram();
    var txs = 0, stubs = 0;
    state.graph.nodes.forEach(function (n) { if (n.type === 'tx' && sc.nodes.has(n.id)) { if (n.loaded) txs++; else stubs++; } });
    var info = txs + ' transaction' + (txs === 1 ? '' : 's') + ' loaded';
    if (stubs) info += ' · ' + stubs + ' more known, not loaded';
    if (b.pending) info += ' · ' + b.pending + ' unconfirmed';
    if (b.min != null && b.min === b.max) info += ' · all in one moment, nothing to slide';
    $('tbInfo').textContent = info;
  }
  function syncTimeLabels() {
    var b = state.tb, f = state.filter, on = timebarEnabled();
    $('tbFrom').textContent = b.min == null ? '—' : S.fmtTime(f.timeFrom != null ? f.timeFrom : b.min);
    $('tbTo').textContent = b.max == null ? '—' : S.fmtTime(f.timeTo != null ? f.timeTo : b.max);
    var a = on ? Number($('tFrom').value) / 10 : 0, z = on ? Number($('tTo').value) / 10 : 100;
    var fill = $('dualFill'); fill.style.left = a + '%'; fill.style.width = Math.max(0, z - a) + '%';
  }
  function onTimeSlider(which) {
    if (!timebarEnabled()) return;
    var a = Number($('tFrom').value), z = Number($('tTo').value);
    if (a > z) { if (which === 'from') { a = z; $('tFrom').value = a; } else { z = a; $('tTo').value = z; } }
    state.filter.timeFrom = a <= 0 ? null : timeOfSlider(a);
    state.filter.timeTo = z >= 1000 ? null : timeOfSlider(z);
    syncTimeLabels(); drawHistogram(); refresh(); scheduleSave();
  }
  var TB_PAD = 8;                                       // room at each end of the time line for the slider handles
  function timeX(t, w) { var b = state.tb; return TB_PAD + (t - b.min) / (b.max - b.min) * (w - 2 * TB_PAD); }

  /** The time line: a time scale, a bar per slice of time, and one dot per transaction at its exact time. */
  function drawHistogram() {
    var cv = $('hist'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var b = state.tb; state.tbGeom = null;
    if (!timebarEnabled()) return;
    var barsH = h - 18, f = state.filter, from = f.timeFrom == null ? b.min : f.timeFrom, to = f.timeTo == null ? b.max : f.timeTo, span = b.max - b.min, inner = w - 2 * TB_PAD;
    var bins = Math.max(10, Math.floor(inner / 6)), bw = inner / bins, counts = new Array(bins).fill(0), max = 1, txs = state.tbTxs || [];
    txs.forEach(function (t) { var i = Math.min(bins - 1, Math.floor((t.time - b.min) / span * bins)); counts[i]++; if (counts[i] > max) max = counts[i]; });

    // time scale: calendar-aligned ticks with labels along the bottom
    ctx.font = '10px Calibri, Arial, sans-serif'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 1;
    var ticks = R.niceTicks(b.min, b.max, inner / span, 90);
    ticks.forEach(function (tk) {
      var x = Math.round(timeX(tk.t, w)) + 0.5, tw = ctx.measureText(tk.label).width;
      ctx.strokeStyle = 'rgba(242,242,242,0.10)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, barsH + 4); ctx.stroke();
      ctx.fillStyle = '#9d8f9d'; ctx.textAlign = 'left'; ctx.fillText(tk.label, x + tw + 6 > w ? x - tw - 3 : x + 3, h - 3);
    });
    if (!ticks.length) {                                                          // too short a span for round dates: label the two ends
      ctx.fillStyle = '#9d8f9d'; ctx.textAlign = 'left'; ctx.fillText(S.fmtTime(b.min), TB_PAD, h - 3);
      ctx.textAlign = 'right'; ctx.fillText(S.fmtTime(b.max), w - TB_PAD, h - 3);
    }
    counts.forEach(function (c, i) {
      if (!c) return;
      var t0 = b.min + i / bins * span, t1 = b.min + (i + 1) / bins * span, inside = t1 >= from && t0 <= to;
      ctx.fillStyle = inside ? '#aee7f8' : '#5a4a5a';
      var bh = Math.max(3, (c / max) * (barsH - 6)); ctx.fillRect(TB_PAD + i * bw, barsH - bh, Math.max(1, bw - 1), bh);
    });
    ctx.strokeStyle = 'rgba(242,242,242,0.28)'; ctx.beginPath(); ctx.moveTo(TB_PAD, barsH + 0.5); ctx.lineTo(w - TB_PAD, barsH + 0.5); ctx.stroke();
    if (txs.length <= 300) txs.forEach(function (t) {                             // one dot per transaction, at its exact time
      var x = timeX(t.time, w), inside = t.time >= from && t.time <= to;
      ctx.beginPath(); ctx.arc(x, barsH + 0.5, 3, 0, Math.PI * 2); ctx.fillStyle = inside ? '#ffffff' : '#7a6a7a'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = inside ? '#4a8ca8' : '#3a2c3a'; ctx.stroke();
    });
    if (state.tbHover) { ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(state.tbHover.x) + 0.5, 0); ctx.lineTo(Math.round(state.tbHover.x) + 0.5, barsH + 6); ctx.stroke(); }
    state.tbGeom = { w: w, h: h, barsH: barsH, bins: bins, bw: bw };
  }

  /** What is under a point on the time line: the dot within reach, else the slice of time (with the transactions in it). */
  function timeHit(x) {
    var g = state.tbGeom, b = state.tb;
    if (!g || !timebarEnabled()) return null;
    var span = b.max - b.min, txs = state.tbTxs || [], near = null, best = 7;
    txs.forEach(function (t) { var d = Math.abs(timeX(t.time, g.w) - x); if (d < best) { near = t; best = d; } });
    var dots = near ? txs.filter(function (t) { return Math.abs(timeX(t.time, g.w) - timeX(near.time, g.w)) <= 3; }) : [];      // dots drawn on top of each other (e.g. one block) act as one
    var bin = Math.min(g.bins - 1, Math.max(0, Math.floor((x - TB_PAD) / g.bw))), t0 = b.min + bin / g.bins * span, t1 = b.min + (bin + 1) / g.bins * span;
    var inBin = txs.filter(function (t) { return t.time >= t0 && (t.time < t1 || (bin === g.bins - 1 && t.time <= t1)); });
    var at = b.min + Math.max(0, Math.min(1, (x - TB_PAD) / (g.w - 2 * TB_PAD))) * span;
    return { dots: dots, bin: bin, inBin: inBin, at: Math.round(at) };
  }

  function showTimeTip(e) {
    var tip = $('tooltip'), r = $('hist').getBoundingClientRect(), hit = timeHit(e.clientX - r.left);
    if (!hit) { tip.hidden = true; return; }
    tip.textContent = '';
    function line(k, v) { tip.appendChild(el('div', {}, k ? [el('b', { text: k + ' ' }), String(v)] : [String(v)])); }
    if (hit.dots.length === 1) {
      var d = hit.dots[0];
      line('Transaction', S.shortId(d.id.slice(3), 8)); line('Time', S.fmtTimeFull(d.time));
      if (d.loaded) line('Value', amountText(d.value, d.time)); else line('', 'Not loaded yet');
      line('', 'Click to select it');
    } else if (hit.dots.length) {
      line('Time', S.fmtTimeFull(hit.dots[0].time));
      line('', hit.dots.length + ' transactions here');
      hit.dots.slice(0, 4).forEach(function (t) { line('', S.shortId(t.id.slice(3), 6) + (t.loaded ? ' · ' + amountText(t.value, t.time) : ' · not loaded')); });
      if (hit.dots.length > 4) line('', '… and ' + (hit.dots.length - 4) + ' more');
      line('', 'Click to select them');
    } else {
      line('Time', S.fmtTimeFull(hit.at));
      if (!hit.inBin.length) line('', 'No transactions here');
      else {
        line('', hit.inBin.length + (hit.inBin.length === 1 ? ' transaction' : ' transactions') + (hit.inBin.length > 1 ? ', ' + S.fmtTime(hit.inBin[0].time) + ' to ' + S.fmtTime(hit.inBin[hit.inBin.length - 1].time) : ''));
        hit.inBin.slice(0, 4).forEach(function (t) { line('', S.shortId(t.id.slice(3), 6) + ' · ' + S.fmtTimeFull(t.time)); });
        if (hit.inBin.length > 4) line('', '… and ' + (hit.inBin.length - 4) + ' more');
        line('', 'Click to select ' + (hit.inBin.length === 1 ? 'it' : 'them'));
      }
    }
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(e.clientX + 14, window.innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(4, e.clientY - h - 14) + 'px';                         // above the pointer: the time line is at the bottom of the window
  }

  function onTimeHover(e) {
    var r = $('hist').getBoundingClientRect(); state.tbHover = { x: e.clientX - r.left }; drawHistogram(); showTimeTip(e);
  }
  function onTimeLeave() { state.tbHover = null; $('tooltip').hidden = true; drawHistogram(); }
  function onTimeClick(e) {
    var r = $('hist').getBoundingClientRect(), hit = timeHit(e.clientX - r.left);
    if (!hit) return;
    var ids = (hit.dots.length ? hit.dots : hit.inBin).map(function (t) { return t.id; });
    var on = renderer.data ? renderer.data.visible.nodes : new Set(), vis = ids.filter(function (id) { return on.has(id); });
    if (!ids.length) return;
    if (!vis.length) { toast('Those transactions are not on screen (a filter or the layout is hiding them).'); return; }
    state.selected = new Set(vis); state.selectedEdge = null; syncSelection(); renderer.ensureVisible(vis);
  }

  function setTbCollapsed(c) {
    state.tbCollapsed = !!c;
    document.body.classList.toggle('tb-collapsed', state.tbCollapsed);
    var b = $('tbCollapse');
    b.setAttribute('aria-expanded', String(!state.tbCollapsed)); b.textContent = state.tbCollapsed ? '▴' : '▾';
    b.title = (state.tbCollapsed ? 'Show' : 'Hide') + ' the time line (T)'; b.setAttribute('aria-label', (state.tbCollapsed ? 'Show' : 'Hide') + ' the time line');
    $('tooltip').hidden = true; state.tbHover = null;
    savePrefs();
    if (!state.tbCollapsed) requestAnimationFrame(function () { drawHistogram(); });
  }

  function resetTime() {
    stopPlay(); state.filter.timeFrom = null; state.filter.timeTo = null;
    $('tFrom').value = 0; $('tTo').value = 1000; syncTimeLabels(); drawHistogram(); refresh(); scheduleSave();
  }
  function stopPlay() { if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; } $('tbPlay').textContent = '▶ Replay'; }
  function togglePlay() {
    if (state.playTimer) { stopPlay(); return; }
    if (!timebarEnabled()) return;
    var steps = 120, i = 0;
    state.filter.timeFrom = null; $('tFrom').value = 0; $('tbPlay').textContent = '⏸ Pause';
    state.playTimer = setInterval(function () {
      i++;
      var done = i >= steps;
      state.filter.timeTo = done ? null : Math.round(state.tb.min + (state.tb.max - state.tb.min) * i / steps);
      $('tTo').value = done ? 1000 : Math.round(i / steps * 1000);
      syncTimeLabels(); drawHistogram(); refresh();
      if (done) stopPlay();
    }, state.playMs);
  }

  // ---- layout / colour controls ---------------------------------------------------------------
  function setSeg(groupId, attr, value) {
    Array.prototype.forEach.call($(groupId).querySelectorAll('button'), function (b) { b.setAttribute('aria-checked', b.getAttribute(attr) === value ? 'true' : 'false'); });
  }
  function setLayout(name, o) {
    if (!LAYOUTS[name]) return;
    if (name === 'trace' && (!state.trace.seed || !state.graph.nodes.has(state.trace.seed))) {
      var c = traceCandidate();
      if (!c) { toast('Open a transaction or a wallet first, then switch to Trace.', true); return; }
      traceStart(c);
    }
    state.layout = name; document.body.classList.toggle('trace-on', name === 'trace'); setSeg('layoutSeg', 'data-layout', name); updateScaleRow();
    state.pinned.clear(); refresh({ relayout: true, fit: !o || o.fit !== false }); updateTraceUi(); renderStepBar(); scheduleSave();
  }
  function setScale(name) {
    if (!SCALES[name]) return;
    state.timeScale = name; setSeg('scaleSeg', 'data-scale', name);
    state.pinned.clear(); refresh({ relayout: true, fit: true }); scheduleSave();
  }
  /** What 'Auto' means for the shape size: proportional to value in the Force layout (where position says nothing about amounts), compact elsewhere. */
  function effectiveSizeBy() { return state.sizeBy === 'auto' ? (state.layout === 'force' || (traceOn() && (state.arrange === 'force' || state.arrange === 'timeforce')) ? 'area' : 'log') : state.sizeBy; }
  function setSizeBy(name) {
    if (!SIZES[name]) return;
    state.sizeBy = name; setSeg('sizeSeg', 'data-size', name); state.layoutRes = null;
    refresh({ relayout: true }); scheduleSave();                    // the force layout leaves room for the shapes, so it is placed again (from where things are)
  }
  function setColor(name) {
    if (!COLORS[name]) return;
    state.colorBy = name; setSeg('colorSeg', 'data-color', name); refresh(); scheduleSave();
  }

  // ---- export / import ------------------------------------------------------------------------
  function viewState() { return { sizeBy: state.sizeBy, trace: traceData(), arrange: state.arrange, hidden: Array.from(state.hidden).filter(function (id) { return state.graph.nodes.has(id); }).slice(0, 5000), layout: state.layout, timeScale: state.timeScale, colorBy: state.colorBy, focus: state.focus, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, filter: state.filter, source: state.source === 'custom' ? 'clearnet' : state.source }; }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime }), a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function stamp() { var d = new Date(); return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + '-' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** What the analysis found, as extra export columns: patterns and cluster per vertex, the likely change per output. */
  function exportAnalysis() {
    var an = analysis();
    return {
      node: function (n) {
        var r = n.type === 'tx' ? an.tx.get(n.id) : null, cl = n.type === 'addr' ? an.clusters.byAddr.get(n.id) : null;
        return { patterns: r ? r.flags.map(function (f) { return f.short; }).join('; ') : '', cluster: cl ? cl.label : '', clusterSize: cl ? cl.size : '' };
      },
      edge: function (e) { var c = an.changeEdges.get(e.id); return c ? c.confidence : ''; }
    };
  }

  /** How the fiat values in a report were worked out, in words. */
  function fiatNoteText() {
    if (!fiatOn()) return '';
    var f = state.fiat, cur = f.currency;
    return 'Shown in ' + cur + ' at ' + (f.basis === 'today' ? 'today\'s price' : f.basis === 'ref' && f.ref ? 'the price at ' + S.fmtTimeFull(f.ref.time) + ' for every amount' : 'the price at each transaction\'s own time')
      + ', from the mempool.space price history, interpolated between its points (a value marked ≈ was interpolated across more than two days and is rough).';
  }

  /** The investigation report: what is on screen, as one file with its evidence embedded. */
  function doReport() {
    var g = state.graph; g.refreshDerived();
    var vis = F.computeVisible(g, state.filter, state.keep, focusOpt(), traceOnly(), hiddenOpt());
    if (!vis.nodes.size) { toast('Nothing on screen to put in a report.', true); return Promise.resolve(false); }
    var an = analysis(), title = LB.cleanText($('reportTitle').value, 120) || 'Orion investigation report', by = LB.cleanText($('reportBy').value, 80);
    var base = JSON.parse(IO.toJson(g, { only: vis, view: viewState(), source: sourceBase() }));
    if (base.view) delete base.view.hidden;                                    // what you hid is not part of what is reported
    var atx = {};
    vis.nodes.forEach(function (id) {
      var r = an.tx.get(id);
      if (r && (r.flags.length || r.change || r.chain)) atx[id] = { flags: r.flags.map(function (f) { return { kind: f.kind, short: f.short, title: f.title }; }),
        change: r.change && vis.nodes.has(r.change.id) ? { vout: r.change.vout, edgeId: r.change.edgeId, address: r.change.address, confidence: r.change.confidence, reasons: r.change.reasons } : null, chain: r.chain };
    });
    // the report describes what is on screen: a chain or cluster is cut to the vertices that are shown, so nothing hidden leaks in through them
    var chains = an.chains.filter(function (c) { return c.ids.some(function (id) { return vis.nodes.has(id); }); }).map(function (c) { return { label: c.label, ids: c.ids.filter(function (id) { return vis.nodes.has(id); }), start: c.start, end: c.end, totalPeeled: c.totalPeeled, continues: c.continues }; });
    var clusters = an.clusters.list.filter(function (c) { return c.addrs.some(function (id) { return vis.nodes.has(id); }); }).map(function (c) {
      return { label: c.label, size: c.size, addrs: c.addrs.filter(function (id) { return vis.nodes.has(id); }), txs: c.txs.filter(function (txid) { return vis.nodes.has(ID.tx(txid)); }) };
    });
    var loadedTx = base.nodes.filter(function (n) { return n.type === 'tx' && n.loaded; }).length;
    base.evidence = { generatedBy: 'Orion workspace', title: title, preparedBy: by, generated: new Date().toISOString(), source: sourceBase(), fiat: state.fiat,
                      counts: { nodes: base.nodes.length, edges: base.edges.length, transactionsLoaded: loadedTx },
                      analysis: { transactions: atx, chains: chains, clusters: clusters, skipped: an.clusters.skipped, thresholds: AN.DEFAULTS } };
    var image = null; try { image = renderer.toDataUrl(); } catch (e) { /* a tainted or empty canvas: the report simply has no picture */ }
    var model = { title: title, preparedBy: by, generated: Date.now(), evidence: base, nodes: base.nodes, edges: base.edges,
                  analysis: { tx: atx, chains: chains, clusters: clusters, skipped: an.clusters.skipped },
                  known: function (a) { return KNOWN[a] || null; }, fiat: fiatOn() ? function (s, t) { var f = fiatOf(s, t); return f ? f.text : ''; } : null, fiatNote: fiatNoteText(),
                  image: image, fingerprint: function (n) { var f = AN.fingerprint(n); return f ? f.text : ''; } };
    return RP.build(model).then(function (r) {
      download('orion-report-' + stamp() + '.html', r.html, 'text/html;charset=utf-8');
      toast('Report written: ' + plural(loadedTx, 'transaction') + ', ' + plural(base.edges.length, 'movement') + '. SHA-256 of its evidence: ' + r.hash.slice(0, 16) + '…', false);
      log('Report SHA-256 ' + r.hash);
      return true;
    }, function (e) { toast('The report could not be made: ' + (e && e.message ? e.message : e), true); return false; });
  }

  function doExport(kind) {
    var g = state.graph;
    if (!g.nodes.size) { toast('Nothing to export yet.', true); return; }
    if (kind === 'report') { $('exportMenu').open = false; doReport(); return; }
    g.refreshDerived();
    var only = $('exportVisible').checked ? F.computeVisible(g, state.filter, state.keep, focusOpt(), traceOnly(), hiddenOpt()) : null;
    var name = 'orion-' + stamp();
    if (fiatOn() && !fiatLoaded() && (kind === 'csv-edges' || kind === 'graphml')) toast('Prices are not loaded, so the fiat columns are empty.', true);
    if (kind === 'json') download(name + '.json', IO.toJson(g, { only: only, view: viewState(), source: sourceBase() }), 'application/json');
    else if (kind === 'csv-nodes') download(name + '-nodes.csv', '﻿' + IO.toCsv(g, 'nodes', { only: only, analysis: exportAnalysis() }), 'text/csv;charset=utf-8');
    else if (kind === 'csv-edges') download(name + '-edges.csv', '﻿' + IO.toCsv(g, 'edges', { only: only, fiat: exportFiat(), analysis: exportAnalysis() }), 'text/csv;charset=utf-8');
    else if (kind === 'graphml') download(name + '.graphml', IO.toGraphMl(g, { only: only, fiat: exportFiat(), analysis: exportAnalysis() }), 'application/xml');
    else if (kind === 'png') { var a = el('a', { href: renderer.toDataUrl(), download: name + '.png' }); document.body.appendChild(a); a.click(); a.remove(); }
    $('exportMenu').open = false;
    log('Exported ' + kind + (only ? ' (visible part)' : ''));
  }

  function applyView(v) {
    if (!v || typeof v !== 'object') return;
    var traceOk = loadTraceData(v.trace);
    if (ARRANGE[v.arrange]) state.arrange = v.arrange;
    if (Array.isArray(v.hidden)) { state.hidden = new Set(v.hidden.filter(function (id) { return typeof id === 'string' && NV.isId(id); }).slice(0, 5000).map(canonicalId)); state.hideUndo = []; }
    if (v.layout === 'trace' && !traceOk) v = Object.assign({}, v, { layout: 'flow' });
    if (LAYOUTS[v.layout]) { state.layout = v.layout; document.body.classList.toggle('trace-on', v.layout === 'trace'); setSeg('layoutSeg', 'data-layout', v.layout); }
    if (SCALES[v.timeScale]) { state.timeScale = v.timeScale; setSeg('scaleSeg', 'data-scale', v.timeScale); }
    $('traceArrange').value = state.arrange; updateScaleRow();
    if (COLORS[v.colorBy]) { state.colorBy = v.colorBy; setSeg('colorSeg', 'data-color', v.colorBy); }
    if (SIZES[v.sizeBy]) { state.sizeBy = v.sizeBy; setSeg('sizeSeg', 'data-size', v.sizeBy); }
    if (typeof v.focusOn === 'boolean') { state.focusOn = v.focusOn; $('focusOn').checked = v.focusOn; }
    if (typeof v.hops === 'number') { state.hops = num(v.hops, 1, 3, 2); $('depth').value = String(state.hops); }
    state.focus = typeof v.focus === 'string' && NV.isId(v.focus) ? canonicalId(v.focus) : null;
    if (v.fiat) { state.fiat = cleanFiat(v.fiat); syncFiatUi(); }
    if (v.filter && typeof v.filter === 'object') {
      var d = F.defaults(), f = v.filter;
      ['timeFrom', 'timeTo', 'maxAmount'].forEach(function (k) { d[k] = typeof f[k] === 'number' && isFinite(f[k]) ? f[k] : null; });
      d.minAmount = typeof f.minAmount === 'number' && f.minAmount > 0 ? Math.floor(f.minAmount) : 0;
      ['includePending', 'includeUnknownTime', 'showData', 'showNonstd'].forEach(function (k) { if (typeof f[k] === 'boolean') d[k] = f[k]; });
      d.hiddenScriptTypes = Array.isArray(f.hiddenScriptTypes) ? f.hiddenScriptTypes.filter(function (s) { return typeof s === 'string'; }).slice(0, 30) : [];
      state.filter = d; syncFilterControls();
    }
  }
  function syncFilterControls() {
    var f = state.filter;
    $('showData').checked = f.showData; $('showNonstd').checked = f.showNonstd; $('incPending').checked = f.includePending; $('incUnknown').checked = f.includeUnknownTime;
  }

  function doImport(text) {
    var r;
    try { r = IO.fromJson(text); } catch (e) { toast('Import failed: ' + e.message, true); return; }
    var wasEmpty = state.graph.nodes.size === 0, g = state.graph, snap = snapshotGraph('Import'), n0 = g.nodes.size;
    r.graph.nodes.forEach(function (n) { g.upsertNode(n); });
    r.graph.edges.forEach(function (e) { g.upsertEdge(e); });
    r.graph.nodes.forEach(function (n) { if (n.label !== undefined || n.note !== undefined) { var cur = g.nodes.get(n.id); if (n.label) cur.label = n.label; if (n.note) cur.note = n.note; } });
    if (wasEmpty) applyView(r.view);
    if (wasEmpty && fiatOn()) ensurePrices();
    if (state.focus && !g.nodes.has(state.focus)) state.focus = null;
    traceSanitize(); if (traceOn() && !state.trace.seed) { state.layout = 'flow'; setSeg('layoutSeg', 'data-layout', 'flow'); document.body.classList.remove('trace-on'); }
    if (wasEmpty && state.focus) { state.keep.add(state.focus); state.nav.reset(); visitNav(state.focus); }
    state.layoutRes = null; state.graph.refreshDerived();
    afterGraphChange({ fit: true }); updateNavUi(); updateTraceUi(); scheduleSave();
    pushUndoLoad(snap, '+' + plural(g.nodes.size - n0, 'vertex', 'vertices'));
    toast('Imported ' + r.graph.nodes.size + ' vertices and ' + r.graph.edges.size + ' edges' + (wasEmpty ? '' : ' (merged into the current workspace)') + '.' + (r.warnings.length ? ' ' + r.warnings.join('; ') + '.' : ''), !!r.warnings.length);
  }

  function clearAll() {
    if (state.graph.nodes.size) pushUndoLoad(snapshotGraph('Clear'), 'cleared ' + plural(state.graph.nodes.size, 'vertex', 'vertices'));
    stopPlay(); state.client.abort(); state.client.resume();
    setGraph(new M.Graph()); state.keep = new Set(); state.pinned = new Map(); state.selected = new Set(); state.selectedEdge = null;
    state.filter.timeFrom = null; state.filter.timeTo = null;
    state.focus = null; state.nav.reset();
    state.trace = emptyTrace(); state.hidden = new Set(); state.hideUndo = []; state.arrange = 'columns';
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* not allowed here: the old hash stays, harmless */ }
    renderer.cur = new Map(); renderer.target = new Map(); renderer.anim = null;
    afterGraphChange({ fit: true }); syncSelection(); updateNavUi(); updateTraceUi(); store.del(SAVE_KEY); log('Workspace cleared');
  }

  // ---- autosave -------------------------------------------------------------------------------
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!state.persist) return;
    saveTimer = setTimeout(function () {
      if (!$('restore').hidden) return;                                  // the saved session is still waiting for a decision
      if (!state.graph.nodes.size) { store.del(SAVE_KEY); return; }
      var text = IO.toJson(state.graph, { view: viewState() });
      if (text.length > 3500000 || !store.set(SAVE_KEY, text)) log('Workspace is too large for browser storage; export it to keep it.', true);
    }, 800);
  }
  /**
   * Offers the saved session. Returns true when the banner is shown. Until the user decides, nothing is autosaved, so a
   * reload (whose URL now names the vertex you were on) cannot overwrite the saved labels and notes with a bare graph.
   * `afterDiscard` runs when the saved session is thrown away (e.g. to open the vertex named in the URL instead).
   */
  function offerRestore(afterDiscard) {
    if (!state.persist) return false;
    var raw = store.get(SAVE_KEY); if (!raw) return false;
    var meta; try { meta = JSON.parse(raw); } catch (e) { store.del(SAVE_KEY); return false; }
    if (!meta || meta.format !== IO.FORMAT || !Array.isArray(meta.nodes) || !meta.nodes.length) return false;
    $('restoreText').textContent = 'A saved session with ' + meta.nodes.length + ' vertices from ' + S.fmtTime(Date.parse(meta.exported) / 1000) + ' is stored in this browser.';
    $('restore').hidden = false;
    $('restoreYes').onclick = function () { $('restore').hidden = true; doImport(raw); };
    $('restoreNo').onclick = function () { $('restore').hidden = true; store.del(SAVE_KEY); if (afterDiscard) afterDiscard(); };
    renderer.resize();
    return true;
  }

  // ---- wiring ---------------------------------------------------------------------------------
  function init() {
    renderer = new R.Renderer($('cv'), {
      onSelect: function (id, additive) {
        if (!id) { state.selected = new Set(); state.selectedEdge = null; }
        else if (additive) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); state.selectedEdge = null; }
        else { state.selected = new Set([id]); state.selectedEdge = null; }
        syncSelection();
      },
      onSelectEdge: function (id) { state.selected = new Set(); state.selectedEdge = id; syncSelection(); },
      onHover: onHover,
      onMove: function (id, p) { state.pinned.set(id, { x: p.x, y: p.y }); if (traceOn() && state.arrange === 'columns' && state.trace.shown.has(id)) { state.trace.pos.set(id, { x: p.x, y: p.y }); scheduleSave(); } },
      onHandle: function (id, dir, shift, at) { if (shift) traceChoose(id, dir === 'left' ? 'prev' : 'next', at); else traceExpand(id, dir === 'left' ? 'prev' : 'next', { at: at }); },
      onContext: openCtx,
      onBox: function (ids, additive) { setSel(additive ? Array.from(state.selected).concat(ids) : ids); },
      onExpand: function (id) { if (traceOn()) traceExpand(id, 'next'); else if (state.focusOn) navigate(id); else expandNode(id, 'both'); }
    });
    loadPrefs();
    makeClient();
    $('stepMode').value = state.stepMode; $('stepSize').value = state.stepSize;
    $('capTx').value = state.capTx; $('capReq').value = state.capReq; $('capPages').value = state.capPages; $('showLabels').checked = state.showLabels; $('persist').checked = state.persist; $('focusOn').checked = state.focusOn; $('depth').value = String(state.hops);
    applySourceUi(); syncFiatUi(); updateReqStats();
    $('edgeLabels').checked = state.edgeLabels; $('viaWallets').checked = state.viaWallets;
    setSideCollapsed(state.sideCollapsed); setInspCollapsed(state.inspCollapsed); setTbCollapsed(state.tbCollapsed);
    loadPacks(); renderPacks();
    $('stepCopy').appendChild(copyIconSvg());
    $('reportBy').value = state.reportBy || ''; $('reportBy').addEventListener('change', savePrefs);
    $('packImport').addEventListener('click', function () { $('packFile').click(); });
    $('packFile').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (f.size > 40 * 1024 * 1024) { toast('That file is too large (limit 40 MB).', true); return; }
      var rd = new FileReader(); rd.onload = function () { importPack(String(rd.result), f.name); }; rd.onerror = function () { toast('Could not read the file.', true); }; rd.readAsText(f);
    });
    $('packExportCsv').addEventListener('click', function () { exportOwnLabels('csv'); });
    $('packExportJson').addEventListener('click', function () { exportOwnLabels('json'); });
    syncAutoUi();
    Array.prototype.forEach.call($('autoDirSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { state.auto.dir = b.getAttribute('data-dir'); syncAutoUi(); savePrefs(); }); });
    ['autoHops', 'autoFollow', 'autoMaxTx', 'autoMaxReq', 'autoPerTx', 'autoMin', 'autoStopLabel', 'autoStopMix'].forEach(function (id) { $(id).addEventListener('change', readAuto); });
    $('autoGo').addEventListener('click', function () { var id = autoTarget(); if (id) autoExpand(id); });
    [['anFlags', 'flags'], ['anChange', 'change'], ['anClusters', 'clusters']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.analysis[p[1]] = this.checked; savePrefs(); edgeLabelCache.clear(); refresh(); });
    });

    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); openQuery($('q').value); });
    // the box shows the proper form of whatever was pasted
    function tidyQuery() { var r = A.checkQuery($('q').value); if (r.ok) $('q').value = r.value; }
    $('q').addEventListener('change', tidyQuery);
    $('q').addEventListener('paste', function () { setTimeout(tidyQuery, 0); });
    $('fiatCur').addEventListener('change', function () {
      state.fiat.currency = this.value; savePrefs(); scheduleSave(); syncFiatUi(); ensurePrices();
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=fiatBasis]'), function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.fiat.basis = r.value; savePrefs(); scheduleSave(); syncFiatUi();
        if (r.value === 'ref' && !state.fiat.ref) pickRefQuietly();
        else ensurePrices();
      });
    });
    $('fiatPick').addEventListener('click', pickRef);
    function pickRefQuietly() {
      var n = refCandidate();
      if (n) setRef(n); else ensurePrices();                                                                           // nothing suitable yet: today's price is used until one is chosen
    }
    // external sources
    $('arkUrl').value = state.ext.proxy; $('arkToken').value = state.ext.token; $('arkRemember').checked = state.ext.remember;
    $('arkUrl').addEventListener('change', function () {
      var u = this.value.trim().replace(/\/+$/, '');
      if (!proxyUrlOk(u)) { toast('The lookup proxy must run on this machine (http://127.0.0.1:…) or use https: the token would otherwise travel in the clear.', true); this.value = state.ext.proxy; return; }
      state.ext.proxy = u; this.value = u; savePrefs();
    });
    $('arkToken').addEventListener('input', function () { state.ext.token = this.value.trim(); if (state.ext.remember) store.set(TOKEN_KEY, state.ext.token); });
    $('arkRemember').addEventListener('change', function () {
      state.ext.remember = this.checked; savePrefs();
      if (this.checked) store.set(TOKEN_KEY, state.ext.token); else store.del(TOKEN_KEY);
    });
    $('arkTest').addEventListener('click', function () {
      var out = $('arkResult'); out.className = ''; out.textContent = 'Testing…';
      XT.proxyHealth({ fetch: window.fetch.bind(window), base: state.ext.proxy, token: state.ext.token }).then(function (h) {
        out.className = h.keyConfigured ? 'ok' : 'bad';
        out.textContent = h.keyConfigured ? 'Proxy reachable, API key configured (' + String(h.upstream || '').replace(/^https?:\/\//, '') + ').' : 'Proxy reachable, but it has no API key.';
      }, function (e) { out.className = 'bad'; out.textContent = e.message; });
    });
    document.addEventListener('mousedown', function (e) { if (!$('ctxMenu').hidden && !$('ctxMenu').contains(e.target)) closeCtx(); });
    $('ctxMenu').addEventListener('keydown', function (e) { ctxKeys(e); });
    window.addEventListener('blur', closeCtx);
    $('stepPrev').addEventListener('click', function () { stepClick('prev'); });
    $('stepNext').addEventListener('click', function () { stepClick('next'); });
    $('stepLoad').addEventListener('click', function () { if (state.focus) expandNode(state.focus); });
    $('viaWallets').addEventListener('change', function () { state.viaWallets = this.checked; savePrefs(); renderStepBar(); });
    document.addEventListener('click', function (e) { if (!$('stepMenu').hidden && !$('stepbar').contains(e.target)) closeStepMenu(); });
    $('sideCollapse').addEventListener('click', function () { setSideCollapsed(true); });
    $('sideTab').addEventListener('click', function () { setSideCollapsed(false); });
    $('inspCollapse').addEventListener('click', function () { setInspCollapsed(true); });
    $('inspTab').addEventListener('click', function () { setInspCollapsed(false); });
    $('edgeLabels').addEventListener('change', function () { state.edgeLabels = this.checked; savePrefs(); refresh(); });
    Array.prototype.forEach.call($('showSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setShow(b.getAttribute('data-show')); }); });
    $('btnAmounts').addEventListener('click', function () { setShow({ both: 'fiat', fiat: 'btc', btc: 'both' }[state.fiat.show] || 'both'); });
    $('navBack').addEventListener('click', function () { stepNav(-1); });
    $('navFwd').addEventListener('click', function () { stepNav(1); });
    window.addEventListener('popstate', onPopState);
    $('focusOn').addEventListener('change', function () {
      state.focusOn = this.checked; savePrefs();
      if (state.focusOn && !state.focus) state.focus = state.nav.current() || Array.from(state.selected)[0] || null;
      if (state.focus) state.keep.add(state.focus);
      afterGraphChange({ fit: true }); scheduleSave();
    });
    $('depth').addEventListener('change', function () { state.hops = num(this.value, 1, 3, 2); savePrefs(); afterGraphChange({ fit: true }); scheduleSave(); });
    $('btnFit').addEventListener('click', function () { renderer.fit(); });
    $('btnUndoLoad').addEventListener('click', undoLoad);
    $('btnRelayout').addEventListener('click', function () { if (traceOn()) { traceTidy(); return; } state.pinned.clear(); refresh({ relayout: true, fit: true }); });
    $('traceUndo').addEventListener('click', undoLast);
    $('traceHide').addEventListener('click', hideSelected);
    $('traceKeep').addEventListener('click', function () { keepOnly(traceOn() ? traceSelected() : Array.from(state.selected)); });
    $('selMenu').addEventListener('click', openSelectMenu);
    $('hiddenBtn').addEventListener('click', openHiddenMenu);
    $('boxSel').addEventListener('click', function () { setBoxMode(!state.boxMode); });
    $('traceArrange').addEventListener('change', function () { setArrange(this.value); });
    $('traceReset').addEventListener('click', traceReset);
    $('zoomIn').addEventListener('click', function () { renderer.zoomBy(1.3); });
    $('zoomOut').addEventListener('click', function () { renderer.zoomBy(1 / 1.3); });
    $('cancel').addEventListener('click', function () { state.client.abort(); });
    $('sample').addEventListener('click', function () { $('q').value = SAMPLE; openQuery(SAMPLE); });
    $('emptyImport').addEventListener('click', function () { $('fileImport').click(); });
    $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
    $('fileImport').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (f.size > 60 * 1024 * 1024) { toast('That file is too large (limit 60 MB).', true); return; }
      var rd = new FileReader(); rd.onload = function () { doImport(String(rd.result)); }; rd.onerror = function () { toast('Could not read the file.', true); }; rd.readAsText(f);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), function (b) { b.addEventListener('click', function () { doExport(b.getAttribute('data-export')); }); });
    $('btnClear').addEventListener('click', function () {
      var b = $('btnClear');
      if (!state.graph.nodes.size) return;
      if (b.dataset.armed) { clearTimeout(clearTimer); delete b.dataset.armed; b.textContent = 'Clear'; clearAll(); return; }
      b.dataset.armed = '1'; b.textContent = 'Click again to clear';
      clearTimer = setTimeout(function () { delete b.dataset.armed; b.textContent = 'Clear'; }, 3000);
    });
    $('btnSide').addEventListener('click', function () { document.body.classList.toggle('side-open'); });
    $('inspClose').addEventListener('click', function () { state.selected = new Set(); state.selectedEdge = null; syncSelection(); });

    // source
    $('source').addEventListener('change', function () { state.source = this.value; applySourceUi(); makeClient(); savePrefs(); });
    $('fallbackOn').addEventListener('change', function () { state.fallback = this.checked; applySourceUi(); makeClient(); savePrefs(); });
    $('customBase').addEventListener('change', function () { state.customBase = this.value.trim(); makeClient(); savePrefs(); });
    $('customPrices').addEventListener('change', function () { state.customPrices = this.value; state.books = {}; state.today = null; makePriceClient(); savePrefs(); if (fiatOn()) ensurePrices(); else syncFiatUi(); });
    $('testSource').addEventListener('click', function () {
      var out = $('testResult'), t0 = performance.now();
      if (state.source === 'custom' && !/^https?:\/\//i.test(state.customBase.trim())) { out.textContent = 'Enter a URL first.'; out.className = 'bad'; return; }
      out.textContent = 'Testing…'; out.className = '';
      var probe = new A.Client({ base: sourceBase(), timeoutMs: A.PRESETS[state.source].timeoutMs, retries: 0, delayMs: 0 });
      probe.tipHeight().then(function (h) { out.textContent = 'OK: chain height ' + fmtInt(h) + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s'; out.className = 'ok'; },
        function (e) { out.textContent = 'Failed: ' + e.message + (state.source === 'tor' ? ' (open this page in Tor Browser)' : ''); out.className = 'bad'; });
    });

    // view
    Array.prototype.forEach.call($('layoutSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setLayout(b.getAttribute('data-layout')); }); });
    Array.prototype.forEach.call($('scaleSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setScale(b.getAttribute('data-scale')); }); });
    Array.prototype.forEach.call($('colorSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setColor(b.getAttribute('data-color')); }); });
    Array.prototype.forEach.call($('sizeSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setSizeBy(b.getAttribute('data-size')); }); });
    $('showLabels').addEventListener('change', function () { state.showLabels = this.checked; refresh(); savePrefs(); });
    $('persist').addEventListener('change', function () {
      state.persist = this.checked; savePrefs();
      if (state.persist) scheduleSave(); else { clearTimeout(saveTimer); store.del(SAVE_KEY); toast('Saved session deleted from this browser.'); }
    });

    // filters
    $('minAmount').addEventListener('input', function () { setMinAmount(amountFromSlider(this.value), true); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-min]'), function (b) { b.addEventListener('click', function () { setMinAmount(Number(b.getAttribute('data-min')), false); }); });
    [['showData', 'showData'], ['showNonstd', 'showNonstd'], ['incPending', 'includePending'], ['incUnknown', 'includeUnknownTime']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.filter[p[1]] = this.checked; refresh({ relayout: p[1] === 'showData' || p[1] === 'showNonstd' }); scheduleSave(); });
    });
    $('stepMode').addEventListener('change', function () { state.stepMode = this.value; savePrefs(); renderer.dirty = true; });
    $('stepSize').addEventListener('change', function () { state.stepSize = num(this.value, 1, 50, 5); this.value = state.stepSize; savePrefs(); renderer.dirty = true; });
    ['capTx', 'capReq', 'capPages'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.capTx = num($('capTx').value, 1, 500, 25); state.capReq = num($('capReq').value, 1, 1000, 80); state.capPages = num($('capPages').value, 1, 20, 2);
        $('capTx').value = state.capTx; $('capReq').value = state.capReq; $('capPages').value = state.capPages; savePrefs();
      });
    });

    // time
    $('tFrom').addEventListener('input', function () { stopPlay(); onTimeSlider('from'); });
    $('tTo').addEventListener('input', function () { stopPlay(); onTimeSlider('to'); });
    $('tbReset').addEventListener('click', resetTime);
    $('tbCollapse').addEventListener('click', function () { setTbCollapsed(!state.tbCollapsed); });
    $('hist').addEventListener('pointermove', onTimeHover);
    $('hist').addEventListener('pointerleave', onTimeLeave);
    $('hist').addEventListener('click', onTimeClick);
    $('tbPlay').addEventListener('click', togglePlay);

    // keyboard
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!$('ctxMenu').hidden && e.key === 'Escape') { closeCtx(); return; }
      var mod = e.ctrlKey || e.metaKey || e.altKey;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAllVisible(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) { if (copySelection()) e.preventDefault(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selected.size) { e.preventDefault(); if (e.shiftKey && !traceOn()) removeIds(Array.from(state.selected)); else hideSelected(); } }
      else if (e.key === 'Escape') { if (!$('stepMenu').hidden) closeStepMenu(); else if (state.boxMode) setBoxMode(false); else { state.selected = new Set(); state.selectedEdge = null; syncSelection(); } }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        var id = state.selected.size ? Array.from(state.selected)[0] : state.focus;
        if (id && state.graph.nodes.has(id)) { e.preventDefault(); openCtx(id, null, clientPosOf(id)); }
      }
      else if (e.key === '[') { e.preventDefault(); if (traceOn()) traceKey('prev'); else stepClick('prev'); }
      else if (e.key === ']') { e.preventDefault(); if (traceOn()) traceKey('next'); else stepClick('next'); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoLast(); }
      else if (mod) { /* a shortcut with Ctrl, Alt or Cmd held belongs to the browser */ }
      else if (e.key === 'b' || e.key === 'B') { setBoxMode(!state.boxMode); }
      else if (e.key === 'c' || e.key === 'C') { setSideCollapsed(!state.sideCollapsed); }
      else if (e.key === 'd' || e.key === 'D') { setInspCollapsed(!state.inspCollapsed); }
      else if (e.key === 't' || e.key === 'T') { setTbCollapsed(!state.tbCollapsed); }
      else if (e.key === 'f' || e.key === 'F') { renderer.fit(); }
      else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
    });
    window.addEventListener('resize', function () { renderer.resize(); drawHistogram(); });
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { renderer.resize(); if (renderer.autoFit) renderer.fit(); drawHistogram(); });
      ro.observe($('stage')); ro.observe($('cv'));                                         // the canvas also changes size when the time line folds away
    }

    updateLegend(); updateTimebar(); updateAmount(); updateScriptChips();
    refresh({ relayout: true });
    var hp = NV.parseHash(location.hash);
    if (hp) hp.id = canonicalId(hp.id);
    var q = new URLSearchParams(location.search).get('q');
    var src = new URLSearchParams(location.search).get('source');
    if (src && A.PRESETS[src] && src !== 'custom') { state.source = src; applySourceUi(); makeClient(); }
    var openTarget = null;
    if (hp && (hp.id.indexOf('tx:') === 0 || hp.id.indexOf('addr:') === 0)) openTarget = function () { navigate(hp.id); };
    else if (q) openTarget = function () { $('q').value = q; openQuery(q); };
    if (!offerRestore(openTarget) && openTarget) openTarget();
    updateNavUi();
    if (fiatOn()) ensurePrices();
  }

  window.__orion = { state: state, refresh: refresh, afterGraphChange: afterGraphChange, navigate: navigate, drawHistogram: drawHistogram, timeX: timeX, analysis: analysis, autoExpand: autoExpand, importPack: importPack, undoLoad: undoLoad, traceExpand: traceExpand, traceStart: traceStart, traceHideIds: traceHideIds, hideIds: hideIds, showIds: showIds, setSel: setSel, selectAllVisible: selectAllVisible, setArrange: setArrange, fiatOf: fiatOf, openCtx: openCtx, lookupArkham: lookupArkham, renderStepBar: renderStepBar, stepClick: stepClick, get renderer() { return renderer; } };   // read by the end-to-end tests
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
