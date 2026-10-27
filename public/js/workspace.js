/*
 * Hopline workspace controller: wires the model, filters, layouts, data source, import/export and the renderer
 * to workspace.html. Everything that comes from the network or from a file reaches the page through
 * textContent / canvas drawing only, never as HTML.
 */
(function () {
  'use strict';

  var M = HoplineModel, S = HoplineStyle, F = HoplineFilter, L = HoplineLayout, A = HoplineApi, IO = HoplineIO, R = HoplineRender, NV = HoplineNav, AD = HoplineAddress, PR = HoplinePrice, ST = HoplineSteps, TG = HoplineTags, XT = HoplineExternal, TR = HoplineTrace, GR = HoplineGroup, AN = HoplineAnalysis, LB = HoplineLabels, OF = HoplineOfac, PK = HoplinePacks, FD = HoplineFind, DT = HoplineDetections, AS = HoplineAssist, RP = HoplineReport, balanceOf = M.balanceOf;
  var ID = M.ID;
  var KNOWN_BASE = window.HOPLINE_KNOWN || {};
  var KNOWN = Object.assign({}, KNOWN_BASE);              // the built-in list plus the label packs that are switched on, rebuilt in place by rebuildKnown()
  var SAMPLE = '0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d';
  var SAVE_KEY = 'hopline.workspace.v1', PREF_KEY = 'hopline.prefs.v1', TOKEN_KEY = 'hopline.ext.token', PACKS_KEY = 'hopline.packs.v1', KEYS_KEY = 'hopline.keys.v1';
  var ARRANGE = { columns: 1, flow: 1, timeline: 1, timeforce: 1, force: 1, timeamount: 1 }, TIME_ARR = { timeline: 1, timeforce: 1, timeamount: 1 }, DEFAULT_ARRANGE = 'columns';
  var HOSTED = !!(window.HOPLINE_CONFIG && window.HOPLINE_CONFIG.hosted);                 // a published copy: see public/config.js
  function stat(name) { if (window.HoplineStats) window.HoplineStats.hit(name); }          // counts that a feature was used, by name only (public/js/hopline-stats.js)
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
  // The project was called Orion before it was Hopline: move what an older version saved in this browser to the new names (once).
  ['workspace.v1', 'prefs.v1', 'ext.token', 'packs.v1'].forEach(function (k) {
    var old = store.get('orion.' + k);
    if (old == null) return;
    if (store.get('hopline.' + k) == null && !store.set('hopline.' + k, old)) return;
    store.del('orion.' + k);
  });
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function num(v, lo, hi, dflt) { v = parseInt(v, 10); return isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v)); }

  // ---- state ----------------------------------------------------------------------------------
  var state = {
    graph: new M.Graph(), layout: 'trace', colorBy: 'type', sizeBy: 'auto', timeScale: 'compact', filter: F.defaults(),
    keep: new Set(), pinned: new Map(), selected: new Set(), selectedEdge: null,
    source: 'clearnet', fallback: true, customBase: '', keys: {}, keyRemember: false, pace: { concurrency: 8, delayMs: 20 }, capTx: 25, capReq: 80, capPages: 2, showLabels: true, persist: !HOSTED,
    customPrices: 'server', focus: null, focusOn: true, hops: 2, nav: new NV(), histOk: false, scopeNodes: null,
    fiat: { currency: 'off', basis: 'each', show: 'both', ref: null }, books: {},
    rightTab: 'details', findTotal: 0, findForce: false, sideCollapsed: false, inspCollapsed: false, tbCollapsed: false, tbTxs: [], tbHover: null, tbGeom: null, edgeLabels: true, viaWallets: true, bundleEdges: true,
    trace: emptyTrace(),
    undoLoads: [], redoLoads: [], redoSig: '', expandRange: null, tbSuppress: false, analysis: { flags: true, change: true, clusters: true, kinds: { peel: true, consolidation: true, batch: true, coinjoin: true } }, assist: { endpoint: 'http://127.0.0.1:11434/v1', model: '', rows: 60 }, an: null, anSig: '', anGraph: null, packs: [], shipped: [], shippedChoices: {}, knownVersion: 0,
    hidden: new Set(), hideUndo: [], hideRedo: [], arrange: DEFAULT_ARRANGE, boxMode: false,
    stepMode: 'ask', stepSize: 5, arrowsInRange: true, chooseSort: 'big', groupRows: true, groupBy: 'party', dustSats: 10000, walletView: { dir: 'all', sort: 'new', who: 'any', unspent: false, more: 40, open: new Set(), groupMore: {}, ticked: new Set(), tickFor: null },
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
  function sourceBase() { return A.sourceBase(state); }

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
    state.priceClient = new A.Client({ base: base, concurrency: 2, delayMs: 300, timeoutMs: state.source === 'tor' ? 120000 : 40000, retries: 2, auth: A.authFor(state) });
  }

  function updateReqStats() {
    var c = state.client, p = state.priceClient, r = state.retired;
    var data = r.data + (c ? c.total.network : 0), price = r.price + (p ? p.total.network : 0);
    var retried = r.retried + (c ? c.total.retried : 0) + (p ? p.total.retried : 0), failed = r.failed + (c ? c.total.failed : 0) + (p ? p.total.failed : 0);
    $('reqStats').textContent = 'Requests this session: ' + data + ' data' + (price ? ', ' + price + ' price' : '') + (retried ? ' · ' + retried + ' retried' : '') + (failed ? ' · ' + failed + ' failed' : '') + '.';
  }

  /** The other public server, when the backup option is on and this one has such a partner (never for Tor or your own server: those must not leave). */
  function backupPreset() { return A.backupFor(state); }
  var hostOf = A.hostOf;
  var SWITCH_WHY = { rate: 'is throttling (HTTP 429)', server: 'returned a server error', timeout: 'did not answer in time', network: 'could not be reached' };

  function makeClient() {
    retire(state.client, 'data');
    state.client = A.buildClient(state, {
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
  /** The keys are kept in this browser only when you ask for that, apart from everything else (never in the saved session, an export or a report). */
  function loadKeys() {
    try {
      var d = JSON.parse(store.get(KEYS_KEY) || '{}'), out = {};
      Object.keys(d || {}).forEach(function (id) { if (A.PRESETS[id]) { var k = A.cleanKey(d[id]); if (k) out[id] = k; } });
      state.keys = out;
    } catch (e) { state.keys = {}; }
  }
  function saveKeys() {
    if (state.keyRemember && Object.keys(state.keys).length) store.set(KEYS_KEY, JSON.stringify(state.keys)); else store.del(KEYS_KEY);
  }
  function keyUrlNote() {
    var b = state.customBase.trim();
    if (state.source !== 'custom' || !state.keys.custom) return '';
    if (/^http:\/\//i.test(b) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])([:/]|$)/i.test(b)) return ' This address is http, not https: anyone on the network between you and the server can read the key.';
    return '';
  }
  function applySourceUi() {
    $('source').value = state.source;
    var partner = state.source === 'clearnet' ? A.PRESETS.blockstream : state.source === 'blockstream' ? A.PRESETS.clearnet : null;
    $('fallbackRow').hidden = !partner; $('fallbackOn').checked = state.fallback;
    if (partner) $('fallbackName').textContent = hostOf(partner.base);
    $('customBase').hidden = state.source !== 'custom'; $('customPricesRow').hidden = state.source !== 'custom'; $('customPrices').value = state.customPrices;
    $('customBase').value = state.customBase;
    $('customAuthRow').hidden = state.source !== 'custom'; $('customPaceRow').hidden = state.source !== 'custom';
    var ck = state.keys.custom || { header: '', value: '' };
    $('srcKey').value = ck.value; $('srcKeyHeader').value = ck.header || ''; $('srcKeyRemember').checked = state.keyRemember;
    $('keyHint').textContent = 'Sent only to this server, never put in a web address, an export, a report or the saved session. A browser sends a key as a header, so your server has to allow that header from this page (CORS: Access-Control-Allow-Headers).' + keyUrlNote();
    $('paceConc').value = state.pace.concurrency; $('paceDelay').value = state.pace.delayMs; $('paceConcOut').textContent = state.pace.concurrency;
    $('sourceHint').textContent = SOURCE_HINT[state.source] + (backupPreset() ? ' If it keeps failing, ' + hostOf(backupPreset().base) + ' answers instead for about a minute (it then sees those look-ups too).' : '');
    $('testResult').textContent = ''; $('testResult').className = '';
  }
  function cleanFiat(f) { return PR.cleanFiat(f); }

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
  function cleanAnalysis(a) {
    a = a && typeof a === 'object' ? a : {};
    var k = a.kinds && typeof a.kinds === 'object' ? a.kinds : {};
    return { flags: a.flags !== false, change: a.change !== false, clusters: a.clusters !== false, kinds: { peel: k.peel !== false, consolidation: k.consolidation !== false, batch: k.batch !== false, coinjoin: k.coinjoin !== false } };
  }

  function savePrefs() {
    store.set(PREF_KEY, JSON.stringify({ stepMode: state.stepMode, stepSize: state.stepSize, arrowsInRange: state.arrowsInRange, chooseSort: state.chooseSort, groupRows: state.groupRows, groupBy: state.groupBy, dustSats: state.dustSats, source: state.source, fallback: state.fallback, customBase: state.customBase, capTx: state.capTx, capReq: state.capReq, capPages: state.capPages, showLabels: state.showLabels, persist: state.persist, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, sideCollapsed: state.sideCollapsed, inspCollapsed: state.inspCollapsed, tbCollapsed: state.tbCollapsed, edgeLabels: state.edgeLabels, viaWallets: state.viaWallets, bundleEdges: state.bundleEdges, customPrices: state.customPrices, reportBy: ($('reportBy') && $('reportBy').value) || '', analysis: state.analysis, assist: state.assist, keyRemember: state.keyRemember, pace: state.pace, auto: state.auto, extProxy: state.ext.proxy, extRemember: state.ext.remember, shippedPacks: state.shippedChoices }));
  }
  function loadPrefs() {
    var raw = store.get(PREF_KEY); if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (A.PRESETS[p.source]) state.source = p.source;
      state.fallback = p.fallback !== false;
      if (p.stepMode === 'ask' || p.stepMode === 'batch' || p.stepMode === 'all') state.stepMode = p.stepMode;
      state.stepSize = num(p.stepSize, 1, 50, 5); state.arrowsInRange = p.arrowsInRange !== false;
      state.groupRows = p.groupRows !== false; state.groupBy = cleanGroupBy(p.groupBy); state.dustSats = num(p.dustSats, 0, 1000000000, 10000);
      if (p.chooseSort === 'big' || p.chooseSort === 'small' || p.chooseSort === 'new' || p.chooseSort === 'old' || p.chooseSort === 'known') state.chooseSort = p.chooseSort;
      if (typeof p.customBase === 'string') state.customBase = p.customBase.slice(0, 300);
      state.keyRemember = p.keyRemember === true; state.pace = A.cleanPace(p.pace); state.shippedChoices = PK.cleanChoices(p.shippedPacks);
      if (state.keyRemember) loadKeys();
      state.capTx = num(p.capTx, 1, 500, 25); state.capReq = num(p.capReq, 1, 1000, 80); state.capPages = num(p.capPages, 1, 20, 2);
      state.showLabels = p.showLabels !== false;
      state.persist = typeof p.persist === 'boolean' ? p.persist : !HOSTED;                  // on a published copy the session is kept only when the visitor ticks it
      state.focusOn = p.focusOn !== false; state.hops = num(p.hops, 1, 3, 2);
      state.fiat = cleanFiat(p.fiat);
      state.sideCollapsed = p.sideCollapsed === true; state.inspCollapsed = p.inspCollapsed === true; state.tbCollapsed = p.tbCollapsed === true;
      state.edgeLabels = p.edgeLabels !== false; state.viaWallets = p.viaWallets !== false; state.bundleEdges = p.bundleEdges !== false;
      state.analysis = cleanAnalysis(p.analysis); state.assist = cleanAssist(p.assist); state.auto = cleanAuto(p.auto);
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
  /** Keep a list of snapshots within the depth and the memory budget (the oldest go first). */
  function trimSnapshots(list) {
    while (list.length > UNDO_DEPTH) list.shift();
    var total = 0;
    for (var i = list.length - 1; i >= 0; i--) { total += (list[i].graph || '').length; if (total > UNDO_BUDGET) { list.splice(0, i + 1); break; } }
  }
  function pushUndoLoad(snap, info) {
    if (!snap) return;
    snap.info = info; state.undoLoads.push(snap); state.redoLoads = [];                         // a new change: what was undone can no longer be redone
    trimSnapshots(state.undoLoads);
    updateUndoLoad();
  }
  /** What a Redo would overwrite: the size of the graph and what you wrote on it. If it differs from the moment of the Undo, the Redo is dropped rather than lose that. */
  function graphSig() {
    var g = state.graph, marked = 0, chars = 0, flags = 0;
    g.nodes.forEach(function (n) { if (n.label || n.tag || n.note) { marked++; chars += String(n.label || '').length + String(n.tag || '').length + String(n.note || '').length; } if (n.noCluster) flags++; });
    return g.nodes.size + '/' + g.edges.size + '/' + marked + '/' + chars + '/' + flags;
  }
  function redoStillValid() {
    if (state.redoLoads.length && state.redoSig !== graphSig()) { state.redoLoads = []; updateUndoLoad(); }
  }
  function updateUndoLoad() {
    var b = $('btnUndoLoad'), top = state.undoLoads[state.undoLoads.length - 1];
    b.disabled = !top || state.busy;
    b.textContent = '↶ Undo load' + (state.undoLoads.length > 1 ? ' (' + state.undoLoads.length + ')' : '');
    b.title = !top ? 'Nothing to undo: a load, an import or a removal can be taken back here'
      : top.tooBig ? 'Too large to undo (no copy was kept): ' + top.title
      : 'Undo: ' + top.title + (top.info ? ' (' + top.info + ')' : '') + ' — back to ' + plural(top.nodes, 'vertex', 'vertices');
    var rb = $('btnRedoLoad'), next = state.redoLoads[state.redoLoads.length - 1];
    rb.disabled = !next || state.busy;
    rb.title = !next ? 'Nothing to redo: Undo load can be taken back here, until you change something else'
      : 'Redo: ' + next.title + (next.info ? ' (' + next.info + ')' : '') + ' — ' + plural(next.nodes, 'vertex', 'vertices') + ' again';
    rb.setAttribute('aria-label', next ? 'Redo load: ' + next.title : 'Redo load');
  }
  /** Put a kept copy back: the graph, and what depends on it (what you kept, hid, focused and traced). Used by Undo and Redo. */
  function restoreSnapshot(s) {
    stopPlay(); $('tooltip').hidden = true;
    setGraph(M.Graph.fromData(JSON.parse(s.graph)));
    state.keep = new Set(s.keep); state.hidden = new Set(s.hidden); state.hideUndo = s.hideUndo; state.hideRedo = [];
    state.focus = s.focus && state.graph.nodes.has(s.focus) ? s.focus : null;
    if (s.trace && loadTraceData(s.trace)) { state.trace.undo = s.traceUndo; traceSanitize(); } else state.trace = emptyTrace();
    if (traceOn() && !state.trace.seed && state.graph.nodes.size) { state.layout = 'flow'; setSeg('layoutSeg', 'data-layout', 'flow'); document.body.classList.remove('trace-on'); updateScaleRow(); }
    state.selected = new Set(); state.selectedEdge = null; state.pinned = new Map();
    state.redoSig = graphSig();
    state.graph.refreshDerived(); afterGraphChange({ fit: true }); syncSelection(); updateNavUi(); updateTraceUi(); scheduleSave(); updateUndoLoad();
  }
  function undoLoad() {
    if (state.busy) { toast('Wait for the current action to finish, or press Cancel first.', true); return; }
    var s = state.undoLoads.pop();
    if (!s) return;
    if (s.tooBig) { toast('That change was too large to keep a copy of, so it cannot be undone. Remove the vertices you do not want instead.', true); updateUndoLoad(); return; }
    var now = snapshotGraph(s.title);                                                          // how it is now: what Redo puts back
    if (now && !now.tooBig) { now.title = s.title; now.info = s.info; state.redoLoads.push(now); trimSnapshots(state.redoLoads); } else state.redoLoads = [];
    restoreSnapshot(s);
    toast('Undid: ' + s.title + '. Back to ' + plural(s.nodes, 'vertex', 'vertices') + '.', false, state.redoLoads.length ? { text: 'Redo', fn: redoLoad } : null);
  }
  /** Put back what Undo load took away (as it was at that moment; Undo load brings the other way again). */
  function redoLoad() {
    if (state.busy) { toast('Wait for the current action to finish, or press Cancel first.', true); return; }
    redoStillValid();
    var r = state.redoLoads.pop();
    if (!r) { toast('Nothing to redo: you changed the workspace after undoing, and Redo would lose that.', true); return; }
    var now = snapshotGraph(r.title);
    if (now && !now.tooBig) { now.title = r.title; now.info = r.info; state.undoLoads.push(now); trimSnapshots(state.undoLoads); }
    restoreSnapshot(r);
    toast('Redid: ' + r.title + '. ' + plural(r.nodes, 'vertex', 'vertices') + ' again.', false, { text: 'Undo', fn: undoLoad });
  }

  function openQuery(raw, o) {
    o = o || {};
    if (!(raw || '').trim()) return;
    var parts = String(raw).trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length > 1) { addMany(parts, o, raw); return; }
    var q = A.checkQuery(raw);
    if (!q.ok) { toast(q.message, true); return; }
    if ($('q').value.trim() === String(raw).trim()) $('q').value = q.value;                                           // show what was actually looked up
    navigate(q.kind === 'tx' ? ID.tx(q.value) : ID.addr(q.value), { replaceTrace: !!o.replace });
  }

  var ADD_MAX = 10;
  /** Several transaction ids and addresses pasted into the box: each is checked and the good ones are added one after the other. */
  function addMany(parts, o, raw) {
    var seen = new Set(), ids = [], bad = [];
    parts.forEach(function (p) {
      var q = A.checkQuery(p);
      if (!q.ok) { bad.push(p); return; }
      var id = q.kind === 'tx' ? ID.tx(q.value) : ID.addr(q.value);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    });
    var cut = Math.max(0, ids.length - ADD_MAX); ids = ids.slice(0, ADD_MAX);
    if (!ids.length) { toast(A.checkQuery(raw).message, true); return; }                  // nothing usable: say what a valid id looks like, as for a single entry
    var chain = Promise.resolve(), done = 0, failed = 0;
    ids.forEach(function (id, k) {
      chain = chain.then(function () { return navigate(id, { replaceTrace: !!o.replace && k === 0 }); }).then(function (ok) { if (ok !== false) done++; else failed++; });
    });
    chain.then(function () {
      $('q').value = '';
      toast('Added ' + plural(done, 'transaction or wallet', 'transactions and wallets') + (bad.length ? ' · not recognised: ' + bad.slice(0, 3).map(function (b) { return S.shortId(b, 8); }).join(', ') + (bad.length > 3 ? ' and ' + (bad.length - 3) + ' more' : '') : '')
        + (failed ? ' · ' + failed + ' could not be loaded' : '') + (cut ? ' · ' + cut + ' more left out (at most ' + ADD_MAX + ' at a time)' : ''), !done);
    });
  }
  /** The top box opens what you type; once something is loaded it adds to it, and says so. */
  function syncOpenBox() {
    var has = state.graph.nodes.size > 0, b = $('btnOpen'), q = $('q');
    if (!b || !q) return;
    b.textContent = has ? 'Add' : 'Open';
    b.title = has ? 'Add this to the workspace: in a trace it becomes another starting point and what is there stays. Several ids can be pasted at once. Shift-click (or Shift+Enter) starts over with it instead.' : 'Open a transaction or a wallet (several can be pasted at once)';
    q.placeholder = has ? 'Add a transaction ID or address' : 'Transaction ID or address';
  }

  // ---- focus and navigation -------------------------------------------------------------------
  /** The vertex whose neighbourhood is shown, or null when the whole graph is. */
  function focusOpt() { return state.focusOn && state.layout !== 'trace' && state.focus && state.graph.nodes.has(state.focus) ? { id: state.focus, hops: state.hops } : null; }

  /** What the graph shows before the time range is applied: every other filter, limited to the focus neighbourhood. */
  function scope(extra) {
    return F.computeVisible(viewGraph(), Object.assign({}, state.filter, { timeFrom: null, timeTo: null }, extra || {}), state.keep, focusOpt(), traceOnly(), hiddenOpt());
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
    if (kind === 'addr') return { title: 'Open ' + S.shortId(val, 8), fn: function () {
      return state.explorer.expandAddress(val, { pages: state.capPages, cap: state.capPages * 25 }).then(function (r) {          // remember whether there is more history than was loaded
        var node = state.graph.nodes.get(id);
        if (node && r) { node.histNext = r.last || null; node.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); }
        return r;
      });
    }, done: function (n) { return !!(n && n.txCount != null); } };
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
      if (first) window.history.replaceState({ hopline: 1 }, '', hash); else window.history.pushState({ hopline: 1 }, '', hash);
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
      if (traceOn()) { if (!state.trace.shown.size) traceStart(id); else if (o.replaceTrace) traceRestart(id); else traceAddSeed(id, false); }       // a new vertex is ADDED to the trace; only "Start over" replaces it
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
  /** What the trace shows: the vertices that were revealed, and the group vertices that stand for several still-hidden ones. */
  function traceOnly() {
    if (!traceOn()) return null;
    var T = state.trace;
    if (!T.groups.size) return T.shown;
    var s = new Set(T.shown); T.groups.forEach(function (g) { s.add(g.id); });
    return s;
  }
  function walletOrTx(id) { return /^(tx|addr):/.test(id) && state.graph.nodes.has(id); }
  function emptyTrace() { return { seed: null, seeds: [], shown: new Set(), pos: new Map(), prov: new Map(), undo: [], redo: [], groups: new Map(), seq: 0 }; }
  function syncSeed() { var T = state.trace; T.seeds = T.seeds.filter(function (s) { return T.shown.has(s); }); T.seed = T.seeds.length ? T.seeds[0] : null; }
  function traceDrop(id) { var T = state.trace; T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); state.selected.delete(id); }

  /** Begin again from one vertex: only it is shown. */
  function traceStart(id) {
    var T = state.trace;
    stat('trace-start');
    T.seed = id; T.seeds = [id]; T.shown = new Set([id]); T.pos = new Map([[id, { x: 0, y: 0 }]]); T.prov = new Map(); T.undo = []; T.redo = []; T.groups = new Map(); T.seq = 0;
    state.keep.add(id);
  }

  /**
   * Begin again from one vertex, in a way that can be taken back: the trace as it was (every vertex, place, starting point and its own
   * undo steps) is kept as one step, so Undo / Ctrl+Z puts it all back. Used by "Reset to start" and "Start over from here".
   */
  function traceRestart(id) {
    var T = state.trace, snap = null;
    if (T.seed && !(T.shown.size <= 1 && T.seeds.length <= 1 && !T.undo.length && T.seed === id)) snap = { data: traceData(), undo: clone(T.undo) };      // nothing to put back when it was already just this vertex
    traceStart(id);
    if (snap && snap.data) {
      traceRecord({ type: 'restart', snap: snap });
      toast('Started over from one vertex.', false, { text: 'Undo', fn: traceUndo });
    }
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
      if (mark && T.seeds.indexOf(id) < 0) { T.seeds.push(id); traceRecord({ type: 'seed', id: id, added: false }); syncSeed(); }
      return false;
    }
    var b = traceBox(); unfoldLog = [];
    traceUnfold(id); T.shown.add(id); T.pos.set(id, { x: b.cx, y: b.bottom + 150 }); T.seeds.push(id);
    traceRecord({ type: 'seed', id: id, added: true, unfolded: unfoldLog }); unfoldLog = null; syncSeed();
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

  /** The time bar's window as { from, to } while the arrows are to stay inside it and it is narrowed; null otherwise. */
  function traceRange() {
    if (state.expandRange) return { from: state.expandRange.from, to: state.expandRange.to };       // a range drawn on purpose beats the preference below
    if (!state.arrowsInRange) return null;
    var f = state.filter;
    return f.timeFrom == null && f.timeTo == null ? null : { from: f.timeFrom, to: f.timeTo };
  }
  /** What counts as already shown when asking about one arrow of one vertex: the shown vertices, and what is folded into a group that hangs from this arrow. */
  function trShown(id, dir) {
    var T = state.trace, s = null;
    T.groups.forEach(function (g) { if (g.anchor === id && g.dir === dir) { s = s || new Set(T.shown); g.members.forEach(function (m) { s.add(m); }); } });
    return s || T.shown;
  }
  function trHidden(id, dir) { return TR.hidden(state.graph, trShown(id, dir), id, dir, traceRange()); }
  function trSummary(id, dir) { return TR.summary(state.graph, trShown(id, dir), id, dir, traceRange()); }
  function trRows(id, dir) { return TR.rows(state.graph, trShown(id, dir), id, dir, traceRange()); }

  /** The two expand handles of a vertex: { left, right } each { label, known, tip } or null. */
  function handlesFor(id) {
    var n = state.graph.nodes.get(id);
    if (!n || (n.type !== 'tx' && n.type !== 'addr')) return null;
    function one(dir) {
      var h = trHidden(id, dir), label = TR.handleLabel(h);
      if (!label && h.outside) label = '0';                                          // something is there, but outside the time bar's range
      if (!label) return null;
      var came = state.trace.prov.get(id);                                       // a bare "?" on the side the trace came from is noise: it stays one key press or menu item away
      if (label === '?' && came && ((came.dir === 'next' && dir === 'prev') || (came.dir === 'prev' && dir === 'next'))) return null;
      var what = TRACE_WHAT[n.type][dir], N = state.stepSize;
      var click = !h.known || h.known <= N || state.stepMode === 'all' ? ' Shift-click to choose which.'
                : state.stepMode === 'ask' ? ' Click to choose which: the top ' + N + ' come ticked.' : ' Click shows the largest ' + N + '; click again for the next.';
      var tip = h.known ? 'Show ' + h.known + ' ' + what + (h.unknown ? ' (more may exist: ' + (n.type === 'addr' ? 'the wallet\'s history is not fully loaded' : 'this transaction is not loaded') + ')' : '') + '.' + click
                        : h.outside && !h.unknown ? 'Nothing inside ' + rangeWhat() + '.' : 'Look for ' + what + ' (loads data)';
      if (h.outside) tip += ' ' + h.outside + ' more fall outside ' + rangeWhat() + '.';
      return { label: label, known: h.known, tip: tip };
    }
    return { left: one('prev'), right: one('next') };
  }

  /** "2022-03-02 to 2022-06-10", or just one date when both ends fall on the same day; '' when no time is known. */
  function dateRange(a, b, sep) {
    if (a == null) return '';
    var x = S.fmtTime(a, false), y = S.fmtTime(b == null ? a : b, false);
    return x === y ? x : x + (sep || ' to ') + y;
  }
  /** How well known a wallet is: 2 = you labelled or tagged it, 1 = it is on the built-in list or a label list you loaded, 0 = neither (or not a wallet). */
  function knownLevel(id) {
    var n = state.graph.nodes.get(id);
    if (!n || n.type !== 'addr') return 0;
    if (n.label || n.tag) return 2;
    return KNOWN[n.address] ? 1 : 0;
  }

  /** What is hidden in numbers, for the tip over an arrow: "83 transactions · 12.4 BTC in total · largest 3.2 BTC · 2021-03-02 to 2022-06-10". */
  function summaryText(s) {
    return S.fmtBtc(s.total) + ' BTC in total · largest ' + S.fmtBtc(s.largest) + ' BTC' + (s.first != null ? ' · ' + dateRange(s.first, s.last) : '');
  }
  /** The extra line under an arrow's tip (on hover only: computing it for every vertex on every frame would be wasteful). */
  function handleSummary(id, side) {
    var n = state.graph.nodes.get(id), dir = side === 'left' ? 'prev' : 'next', s = trSummary(id, dir);
    if (!n || !s.count) return '';
    var noun = n.type === 'addr' ? plural(s.count, 'transaction') : dir === 'next' ? plural(s.count, 'output') : plural(s.count, 'input');
    return '\n' + noun + ' · ' + summaryText(s) + (n.type === 'addr' && n.histNext && !n.histDone ? '\nMore of its history is not loaded: Shift-click the arrow for the list, which can load it.' : '');
  }

  function traceNote(n) {
    if (n.type === 'group') return S.fmtBtc(n.received) + ' BTC';
    if (n.type === 'tx') return n.time != null ? S.fmtTime(n.time, false) : (n.confirmed === false ? 'unconfirmed' : (n.loaded === false ? 'not loaded' : ''));
    if (n.type === 'addr') return n.txCount != null ? fmtInt(n.txCount) + ' txs' : '';
    return '';
  }

  function traceSelected() { return Array.from(state.selected).filter(function (id) { return state.trace.shown.has(id) || state.trace.groups.has(id); }); }

  function updateTraceUi() {
    var on = traceOn(), T = state.trace, has = state.graph.nodes.size > 0, hid = hiddenCount();
    var sel = on ? traceSelected().length : Array.from(state.selected).filter(function (id) { return state.graph.nodes.has(id); }).length;
    var vis = renderer && renderer.data ? renderer.data.visible.nodes.size : 0;
    document.body.classList.toggle('trace-on', on);
    $('traceBar').hidden = !has;
    $('barTitle').textContent = on ? 'Trace' : 'Selection';
    $('focusOn').disabled = on; $('depth').disabled = on;
    $('focusOn').title = on ? 'Not used in the Trace layout: the trace shows what you reveal' : 'Show only the neighbourhood of the vertex you are looking at';
    $('traceUndo').disabled = on ? !T.undo.length : !state.hideUndo.length;
    $('traceRedo').disabled = !canRedo();
    syncOpenBox();
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
    var opts = { limit: o.only ? 100000 : mode === 'batch' ? Math.min(N, state.capTx) : state.capTx, inner: 8, only: o.only || null, range: o.only ? null : traceRange() }, combined = null, revealedIds = [];
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
        var h = TR.hidden(g, trShown(id, dir), id, dir), nd = g.nodes.get(id);                  // not narrowed by the time window: this asks whether anything is known at all
        if (nd.type === 'addr' && h.known === 0 && h.unknown) {                    // nothing known yet: ask for the wallet's history
          return ex.expandAddress(nd.address, { pages: state.capPages, cap: state.capPages * 25, after: nd.histNext || undefined }).then(function (r) {
            nd.histNext = r.last || null; nd.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); add(r);
          });
        }
      });
      chain = chain.then(function () {
        if (!o.only && mode === 'ask' && trHidden(id, dir).known > N) { asked = true; return; }   // too many to show unasked: the list opens instead, and nothing more is loaded for it
        var p = TR.plan(g, trShown(id, dir), id, dir, opts);
        if (p.needLoad.length) return ex.loadMany(p.needLoad, opts.limit, dir === 'next').then(add);       // the transactions between wallets, to see the wallets beyond
      });
      return chain.then(function () {
        g.refreshDerived();
        if (asked) { combined = combined || { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] }; combined.added = Math.max(0, g.nodes.size - nodes0); return combined; }
        var p = TR.plan(g, trShown(id, dir), id, dir, opts), rev = TR.revealed(p, id, dir);
        if (rev.length) {
          TR.place(T.pos, id, dir, p).forEach(function (v, k) { T.pos.set(k, v); });
          unfoldLog = [];
          rev.forEach(function (x) { traceUnfold(x.id); T.shown.add(x.id); T.prov.set(x.id, { via: x.via, dir: x.dir }); revealedIds.push(x.id); });
          traceRecord({ type: 'reveal', ids: revealedIds.slice(), unfolded: unfoldLog }); unfoldLog = null;
        }
        combined = combined || { added: 0, addedEdges: 0, requests: 0, truncated: false, errors: [] };
        combined.added = revealedIds.length;
        return combined;
      });
    }).then(function (r) {
      if (!r) return false;
      if (asked) { traceChoose(id, dir, o.at); return false; }
      if (!revealedIds.length) {
        var hh = trHidden(id, dir);
        if (!r.failed) toast(!hh.known && hh.outside ? (state.expandRange ? 'Nothing inside the range you drew on the time line: ' + hh.outside + ' more fall outside it (draw another range, or clear it with the × beside the time line).' : 'Nothing inside the time bar\'s range: ' + hh.outside + ' more fall outside it (widen the range, or switch off "Arrows stay within the time bar" under Expansion limits).') : ST.emptyReason(g, id, dir, { viaWallets: true }));
        return false;
      }
      traceChanged(revealedIds, false);
      return true;
    });
  }

  /**
   * The list behind an arrow: what is hidden in that direction, to tick the ones to show. It opens by itself when a click would
   * show more than the step size (so nothing floods the screen), and on Shift-click. The top few (in the order shown) come ticked;
   * the list can be sorted, narrowed by amount and by date, and each row says who is on the other side. Rows that look alike fold
   * into one line with a box that ticks them all; its arrow opens them.
   */
  function traceChoose(id, dir, at, opts) {
    opts = opts || {};
    var g = state.graph, T = state.trace, n = g.nodes.get(id), grp = opts.group ? T.groups.get(opts.group) : null;       // grp: choose from what is folded in this group
    if (!n || !walletOrTx(id)) return;
    var h = grp ? { known: grp.members.length, outside: 0 } : trHidden(id, dir);
    if (!h.known) { traceExpand(id, dir, { at: at }); return; }                      // nothing to choose from yet: this loads it
    var N = state.stepSize, rows = grp ? groupRows(grp) : trRows(id, dir), gdir = dir === 'next' ? 'out' : 'in';
    var sm = grp ? (function (s) { return { total: s.total, largest: s.max, first: s.first, last: s.last }; }(GR.stats(rows))) : trSummary(id, dir);
    var noun = n.type === 'addr' ? 'transaction' : dir === 'next' ? 'output' : 'input';
    var m = $('ctxMenu'); m.textContent = ''; m.classList.add('choosing'); closeStepMenu(); $('tooltip').hidden = true;
    m.appendChild(el('div', { 'class': 'ctxhead', text: (grp ? 'Choose from the group · ' : 'Choose what to show ' + (dir === 'next' ? '▶' : '◀') + ' · ') + rows.length + ' hidden' }));
    m.appendChild(el('div', { 'class': 'chooserinfo', text: summaryText(sm) + (h.outside ? ' · ' + h.outside + ' more fall outside ' + rangeWhat() + ' and are not listed' : '') }));
    if (!grp && n.type === 'addr' && !n.histDone && (n.histNext || n.txCount == null)) {            // the wallet has more history than is loaded: the list can fetch it
      m.appendChild(el('div', { 'class': 'choosermore' }, [
        el('button', { type: 'button', 'class': 'loadmore', text: 'Load more history', title: 'Fetch the next ' + plural(state.capPages * 25, 'transaction') + ' of this wallet, then open this list again',
                       onclick: function () { closeCtx(); loadMoreHistory(id).then(function () { traceChoose(id, dir, at, opts); }); } }),
        el('span', { 'class': 'chooserinfo', text: n.txCount != null ? fmtInt(n.txCount) + ' on chain, not all loaded' : 'not fully loaded' })]));
    }
    var sortSel = el('select', { 'aria-label': 'Order' }, [el('option', { value: 'big', text: 'Largest first' }), el('option', { value: 'small', text: 'Smallest first' }), el('option', { value: 'new', text: 'Newest first' }), el('option', { value: 'old', text: 'Oldest first' }), el('option', { value: 'known', text: 'Known or labelled first' })]);
    sortSel.value = state.chooseSort;                                                  // the order you used last time
    var minIn = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0', size: '6', 'aria-label': 'Smallest amount, in BTC' });
    var fromIn = el('input', { type: 'date', 'aria-label': 'From date' }), toIn = el('input', { type: 'date', 'aria-label': 'To date' });
    var info = el('span', { 'class': 'chooserinfo' });
    var groupChk = el('input', { type: 'checkbox', 'aria-label': 'Group similar rows' });
    groupChk.checked = state.groupRows;
    var knownSel = el('select', { 'aria-label': 'Which wallets', title: 'Known = on the built-in list or a label list you loaded (exchanges, services); labelled = a label or tag you gave it' }, [el('option', { value: 'any', text: 'any wallet' }), el('option', { value: 'skip', text: 'skip known services' }), el('option', { value: 'only', text: 'only known or labelled' })]);
    var unspentChk = el('input', { type: 'checkbox', 'aria-label': 'Unspent only' });
    // One box that rotates on each click: all listed, none, the top few, and round again. Ticked = all, empty = none, a dash = the top few (or some other mix).
    var tickAll = el('input', { type: 'checkbox', 'class': 'tickall', 'aria-label': 'Tick all listed, none, or the top few: click to rotate' });
    var tickWord = { all: el('span', { text: 'all' }), none: el('span', { text: 'none' }), top: el('span', { text: 'top ' + Math.min(state.stepSize, rows.length) }) }, tickTop = el('span', {}, [' · ', tickWord.top]);
    m.appendChild(el('div', { 'class': 'choosertools' }, [el('div', { 'class': 'toolrow' }, [sortSel, el('label', {}, ['at least ', minIn, ' BTC'])]), el('div', { 'class': 'toolrow' }, [el('label', {}, ['from ', fromIn]), el('label', {}, ['to ', toIn]), info]),
      el('div', { 'class': 'toolrow' }, [el('label', {}, ['show ', knownSel]), el('label', { 'class': 'unspentopt', title: 'Only where the output between the two is still unspent' }, [unspentChk, ' unspent only'])]),
      grp ? null : el('div', { 'class': 'toolrow' }, [el('label', { title: 'Fold rows that look alike into one line: the same wallet on the other side three times or more, or small amounts, or the same month, week, day or year' }, [groupChk, ' Group similar rows']), groupBySelect(render)]),
      el('div', { 'class': 'toolrow' }, [el('label', { 'class': 'tickallrow', title: 'Click to rotate: tick every row listed, then none, then only the top ' + Math.min(state.stepSize, rows.length) + ' in the order shown, and round again. Rows that do not match the choices above are not listed and are never ticked' },
                                              [tickAll, ' Tick ', tickWord.all, ' · ', tickWord.none, tickTop])])]));
    var list = el('div', { 'class': 'chooser' }), openG = new Set(), heads = [], grp0 = grp;                         // grp0: inside a group's own list nothing is folded again
    var items = rows.map(function (r) {
      var t = stepRowText(r), parties = n.type === 'addr' && r.type === 'tx' ? partiesOf(r.id, dir === 'next' ? 'out' : 'in', id) : null;
      var who = parties ? (dir === 'next' ? 'to ' : 'from ') + partiesText(parties, 'itself') : '';
      var sub = [who, t.sub].filter(Boolean).join(' · ');
      var cb = el('input', { type: 'checkbox', 'aria-label': t.what });
      var pids = parties ? parties.ids : (r.type === 'addr' ? [r.id] : []), levels = pids.map(knownLevel);                // how well known the wallets on the other side are
      var it = { r: r, cb: cb, ok: true, level: levels.reduce(function (a, b) { return Math.max(a, b); }, 0), service: levels.indexOf(1) >= 0, row: el('label', { 'class': 'chooserrow' }, [cb, el('span', { 'class': 'what' }, [t.what, sub ? el('small', { text: sub }) : null]), el('span', { 'class': 'amt', text: t.amt })]) };
      it.g = { id: r.id, dir: gdir, amount: r.amount, time: r.time, parties: parties ? parties.ids : [], item: it };      // what the grouping sees
      cb.addEventListener('change', ticks);
      return it;
    });
    var canUnspent = items.some(function (it) { return it.r.unspent !== null && it.r.unspent !== undefined; });
    unspentChk.parentNode.hidden = !canUnspent;
    function matches(it) {
      var r = it.r;
      if (knownSel.value === 'skip' && it.service) return false;
      if (knownSel.value === 'only' && it.level < 1) return false;
      if (canUnspent && unspentChk.checked && r.unspent !== true) return false;
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
        if (k === 'known') return (y.level - x.level) || byAmt;                                                   // labelled by you, then known, then the rest, each largest first
        var tx = x.r.time, ty = y.r.time;
        if (tx == null || ty == null) return (tx == null ? 1 : 0) - (ty == null ? 1 : 0) || byAmt;                // unknown times last
        return (k === 'new' ? ty - tx : tx - ty) || byAmt;
      });
    }
    var go = el('button', { type: 'button', 'class': 'primary', onclick: function () {
      var only = new Set(items.filter(function (it) { return it.cb.checked; }).map(function (it) { return it.r.id; }));
      closeCtx(); if (!only.size) return;
      if (grp) traceExpandGroup(grp.id, { ids: Array.from(only), at: at }); else traceExpand(id, dir, { only: only });
    } });
    var count = function () { var k = items.filter(function (it) { return it.cb.checked; }).length; go.textContent = 'Show ' + k + ' ticked'; go.disabled = !k; };
    function syncHeads() {                                                                 // a group's box: ticked when all its listed rows are, half-ticked when some are
      heads.forEach(function (hd) {
        var vis = hd.g.members.filter(function (x) { return x.item.ok; }), on = vis.filter(function (x) { return x.item.cb.checked; }).length;
        hd.cb.checked = on > 0 && on === vis.length; hd.cb.indeterminate = on > 0 && on < vis.length;
      });
    }
    function tickMode() {                                                                  // what is ticked now: all that are listed, none, exactly the top few, or some other mix
      var vis = visible(), on = vis.filter(function (it) { return it.cb.checked; });
      if (!vis.length || !on.length) return 'none';
      if (on.length === vis.length) return 'all';
      var top = vis.slice(0, N);
      return on.length === top.length && top.every(function (it) { return it.cb.checked; }) ? 'top' : 'custom';
    }
    function syncAll() {                                                                   // the box follows the rows, and the word for what is ticked now is lit
      var vis = visible(), mode = tickMode();
      tickAll.setAttribute('data-mode', mode); tickAll.checked = mode === 'all'; tickAll.indeterminate = mode === 'top' || mode === 'custom'; tickAll.disabled = !vis.length;
      Object.keys(tickWord).forEach(function (k) { tickWord[k].classList.toggle('on', mode === k); });
      tickTop.hidden = vis.length <= N;                                                    // with no more rows than the top few, "top" is "all": the rotation is all, none
    }
    function ticks() { count(); syncHeads(); syncAll(); }
    function visible() { return ordered().filter(function (it) { return it.ok; }); }
    function topN() { visible().forEach(function (it, i) { it.cb.checked = i < N; }); ticks(); }
    function groupBlock(grp) {
      var st = grp.stats, open = openG.has(grp.key), vis = grp.members.filter(function (x) { return x.item.ok; });
      var wrap = el('div', { 'class': 'choosergroup' });
      grp.members.forEach(function (x) { x.item.row.hidden = !x.item.ok; });
      var what = groupWhat(grp, noun, st);
      var range = dateRange(st.first, st.last, ' → ');
      var sub = [range, S.fmtBtc(st.min) + ' to ' + S.fmtBtc(st.max) + ' BTC each', vis.length < st.count ? vis.length + ' of ' + st.count + ' match' : ''].filter(Boolean).join(' · ');
      var hcb = el('input', { type: 'checkbox', 'aria-label': 'Tick all: ' + what });
      heads.push({ g: grp, cb: hcb });
      hcb.addEventListener('change', function () { vis.forEach(function (x) { x.item.cb.checked = hcb.checked; }); ticks(); });
      var asOne = grp0 ? null : el('button', { type: 'button', 'class': 'groupone', text: '◼ as one', title: 'Show these ' + vis.length + ' as ONE vertex on the trace (one click shows them one by one later)',
                                               onclick: function () { var ids = vis.map(function (x) { return x.item.r.id; }); closeCtx(); traceMakeGroup(id, dir, ids, { kind: grp.kind, party: grp.party, bucket: grp.bucket }); } });
      var fold = el('button', { type: 'button', 'class': 'groupfold', 'aria-expanded': String(open), text: open ? '▾' : '▸', title: open ? 'Fold them' : 'List them one by one',
                                onclick: function () { if (openG.has(grp.key)) openG.delete(grp.key); else openG.add(grp.key); render(); } });
      wrap.appendChild(el('div', { 'class': 'chooserrow grouphead' }, [hcb, el('span', { 'class': 'what' }, [what, el('small', { text: sub })]),
        el('span', { 'class': 'amt', text: S.fmtBtc(vis.reduce(function (t, x) { return t + x.amount; }, 0)) + ' BTC' }), asOne, fold]));
      var body = el('div', { 'class': 'groupmembers' });
      grp.members.forEach(function (x) { body.appendChild(x.item.row); });
      body.hidden = !open; wrap.appendChild(body);
      wrap.hidden = !vis.length;
      return wrap;
    }
    function render() {
      var order = ordered(), ok = 0;
      order.forEach(function (it) { it.ok = matches(it); if (!it.ok) it.cb.checked = false; else ok++; });
      list.textContent = ''; heads = [];
      var flat = order.map(function (it) { return it.g; });
      var lay = state.groupRows && !grp ? GR.layout(flat, GR.make(flat, { minSize: 3, dustSats: state.dustSats, by: state.groupBy })) : flat.map(function (x) { return { type: 'row', row: x }; });          // inside a group's own list nothing is folded again
      lay.forEach(function (x) {
        if (x.type === 'row') { x.row.item.row.hidden = !x.row.item.ok; list.appendChild(x.row.item.row); }
        else list.appendChild(groupBlock(x.group));
      });
      info.textContent = ok === items.length ? '' : ok + ' of ' + items.length + ' match';
      ticks(); clampCtx();
    }
    [knownSel, unspentChk].forEach(function (c) { c.addEventListener('change', render); });
    [sortSel, minIn, fromIn, toIn].forEach(function (c) { c.addEventListener(c === sortSel || c.type === 'date' ? 'change' : 'input', function () { if (c === sortSel) { state.chooseSort = sortSel.value; savePrefs(); } render(); }); });
    groupChk.addEventListener('change', function () { state.groupRows = groupChk.checked; $('groupRows').checked = groupChk.checked; savePrefs(); render(); });
    tickAll.addEventListener('change', function () {                                       // each click goes one step round: top few -> all -> none -> top few; anything else -> all
      var mode = tickMode(), hasTop = visible().length > N, next = mode === 'all' ? 'none' : mode === 'none' ? (hasTop ? 'top' : 'all') : 'all';
      if (next === 'top') topN(); else { items.forEach(function (it) { it.cb.checked = next === 'all' && it.ok; }); ticks(); }
    });
    m.appendChild(list);
    list.addEventListener('keydown', function (e) {
      var boxes = Array.prototype.slice.call(list.querySelectorAll('input[type=checkbox]')).filter(function (b) { return b.offsetParent !== null; }), i = boxes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i >= 0) { boxes[Math.min(boxes.length - 1, i + 1)].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && i >= 0) { boxes[Math.max(0, i - 1)].focus(); e.preventDefault(); }
      else if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); }
    });
    var oneBtn = grp ? null : el('button', { type: 'button', 'class': 'oneticked', text: 'Ticked as one', disabled: 'disabled', title: 'Show the ticked rows as ONE vertex on the trace',
                                             onclick: function () { var ids = items.filter(function (it) { return it.cb.checked; }).map(function (it) { return it.r.id; }); closeCtx(); traceMakeGroup(id, dir, ids, { kind: 'picked' }); } });
    var tickCount = count;
    count = function () { tickCount(); if (oneBtn) oneBtn.disabled = items.filter(function (it) { return it.cb.checked; }).length < 2; };
    m.appendChild(el('div', { 'class': 'chooserfoot' }, [go, oneBtn,
      el('button', { type: 'button', text: 'Cancel', onclick: closeCtx })]));
    render(); topN();
    placeCtx(at || clientPosOf(id));
    var first = m.querySelector('.chooser input'); if (first) first.focus();
  }

  // ---- groups: several hidden neighbours shown as ONE vertex on the trace -----------------------------
  // A group is a view device: it lives in the trace (and the saved session), is drawn on the canvas, and is never written into the graph,
  // so the exports, the analysis and the report's evidence see only what is on the chain. Its members stay hidden until you show them.
  function groupSpecClone(g) {
    var c = { id: g.id, anchor: g.anchor, dir: g.dir, kind: g.kind, party: g.party || null, members: g.members.slice() };
    ['bucket', 'label', 'note', 'tag', 'color', 'shape'].forEach(function (k) { if (g[k]) c[k] = g[k]; });           // its period and what you wrote on it stay with it (Undo, Hide)
    return c;
  }

  /** The members of a group as rows { id, type, amount, time, unspent }, largest first (members that are no longer neighbours of the anchor are left out). */
  /** The "group by" choice as a small select (the same one in the wallet's list, the list behind an arrow and Expansion limits). */
  function groupBySelect(onChange) {
    var s = el('select', { 'aria-label': 'Group rows by', title: 'How rows that look alike are folded together' }, [
      el('option', { value: 'party', text: 'by wallet and small amounts' }), el('option', { value: 'month', text: 'by month' }), el('option', { value: 'week', text: 'by week' }),
      el('option', { value: 'day', text: 'by day' }), el('option', { value: 'year', text: 'by year' })]);
    s.value = state.groupBy;
    s.addEventListener('change', function () { state.groupBy = cleanGroupBy(s.value); $('groupBy').value = state.groupBy; savePrefs(); onChange(); });
    return s;
  }
  function cleanGroupBy(v) { return v === 'party' || GR.BUCKETS.indexOf(v) >= 0 ? v : 'party'; }
  /** What a group of rows is called: "6 transactions to bc1q…", "12 small transactions (each under …)", "9 transactions in Apr 2022". */
  function groupWhat(g, noun, st) {
    if (g.kind === 'time') return plural(st.count, noun) + ' in ' + GR.bucketLabel(g.bucket) + (g.dir === 'in' ? ' (in)' : g.dir === 'out' ? ' (out)' : '');
    if (g.kind === 'party') return plural(st.count, noun) + (g.dir === 'in' ? ' from ' : ' to ') + focusLabel(g.party);
    return plural(st.count, 'small ' + noun) + ' (each under ' + S.fmtBtc(state.dustSats) + ' BTC)';
  }

  function groupRows(grp) {
    var nb = TR.neighbours(state.graph, grp.anchor, grp.dir), rows = [];
    grp.members.forEach(function (id) { var r = nb.get(id); if (r) rows.push(r); });
    return rows.sort(function (a, b) { return b.amount - a.amount || (a.id < b.id ? -1 : 1); });
  }
  /** The text on the canvas: "6 transactions to bc1q…", "12 outputs (small)". */
  function groupText(grp, anchorType, count) {
    var noun = anchorType === 'addr' ? plural(count, 'transaction') : grp.dir === 'next' ? plural(count, 'output') : plural(count, 'input');
    if (grp.kind === 'party' && grp.party) return noun + (grp.dir === 'prev' ? ' from ' : ' to ') + focusLabel(grp.party);
    if (grp.kind === 'time' && grp.bucket) return noun + ' in ' + GR.bucketLabel(grp.bucket);
    return noun + (grp.kind === 'small' ? ' (small)' : '');
  }
  /** The vertex and the edge that stand for a group on the canvas; null when its anchor is gone or none of its members is left. */
  function groupVertex(grp) {
    var a = state.graph.nodes.get(grp.anchor); if (!a) return null;
    var rows = groupRows(grp); if (!rows.length) return null;
    var v = GR.vertex(grp, a.type, rows);
    v.node.groupText = groupText(grp, a.type, rows.length);
    ['label', 'note', 'tag', 'color', 'shape'].forEach(function (k) { if (grp[k]) v.node[k] = grp[k]; });
    return v;
  }
  /** The graph as the canvas draws it: the real one, plus a vertex and an edge for each group in the trace. The real graph is not touched. */
  function viewGraph() {
    var g = state.graph, T = state.trace;
    if (!traceOn() || !T.groups.size) return g;
    var v = Object.create(Object.getPrototypeOf(g));
    v.nodes = new Map(g.nodes); v.edges = new Map(g.edges); v.adj = new Map(g.adj);
    T.groups.forEach(function (grp) {
      var gv = groupVertex(grp); if (!gv) return;
      v.nodes.set(gv.node.id, gv.node); v.edges.set(gv.edge.id, gv.edge); v.adj.set(gv.node.id, new Set([gv.edge.id]));
      var adj = new Set(v.adj.get(grp.anchor) || []); adj.add(gv.edge.id); v.adj.set(grp.anchor, adj);        // a copy: the real graph's set stays as it is
    });
    return v;
  }
  /** The vertex of a group by id, or undefined (for the tooltip, the details and the menu). */
  function groupNodeOf(id) { var grp = state.trace.groups.get(id), gv = grp && groupVertex(grp); return gv ? gv.node : undefined; }

  function traceDropGroup(id) { var T = state.trace; T.groups.delete(id); T.pos.delete(id); T.prov.delete(id); state.selected.delete(id); }
  /** Forget groups whose anchor is gone, and members that are no longer neighbours or are shown; a group of fewer than two is no group. */
  function traceCleanGroups() {
    var T = state.trace, g = state.graph;
    Array.from(T.groups.keys()).forEach(function (gid) {
      var grp = T.groups.get(gid);
      if (!T.shown.has(grp.anchor) || !g.nodes.has(grp.anchor)) { traceDropGroup(gid); return; }
      var nb = TR.neighbours(g, grp.anchor, grp.dir);
      grp.members = grp.members.filter(function (m) { return nb.has(m) && !T.shown.has(m); });
      if (grp.members.length < 2) traceDropGroup(gid);
    });
  }
  var unfoldLog = null;                                                          // while a step that shows vertices is made: the groups they left, as they were, so Undo can fold them back
  /** A vertex that is about to be shown for real leaves any group it was folded into. */
  function traceUnfold(id) {
    var T = state.trace;
    Array.from(T.groups.keys()).forEach(function (gid) {
      var grp = T.groups.get(gid), i = grp.members.indexOf(id);
      if (i < 0) return;
      if (unfoldLog && !unfoldLog.some(function (u) { return u.before.id === gid; })) { var gp = T.pos.get(gid); unfoldLog.push({ before: groupSpecClone(grp), pos: gp ? { x: gp.x, y: gp.y } : null, prov: T.prov.get(gid) || null }); }
      grp.members.splice(i, 1);
      if (grp.members.length < 2) traceDropGroup(gid);
    });
  }

  /**
   * Fold hidden neighbours of `anchor` (the vertices behind its arrow in direction `dir`) into one group vertex beside it. `ids` are the members;
   * spec = { kind: 'party' | 'small' | 'picked', party }. Returns the group's id, or null (fewer than two usable members).
   */
  function traceMakeGroup(anchor, dir, ids, spec) {
    var T = state.trace, g = state.graph; spec = spec || {};
    if (!traceOn() || !T.shown.has(anchor) || !g.nodes.has(anchor)) return null;
    var taken = new Set(); T.groups.forEach(function (x) { if (x.anchor === anchor && x.dir === dir) x.members.forEach(function (m) { taken.add(m); }); });
    var nb = TR.neighbours(g, anchor, dir), members = [];
    ids.forEach(function (id) { if (nb.has(id) && !T.shown.has(id) && !taken.has(id) && members.indexOf(id) < 0) members.push(id); });
    if (members.length < 2) { toast('A group needs at least two vertices that are not shown yet.'); return null; }
    var id = 'grp:' + (++T.seq);
    var made = { id: id, anchor: anchor, dir: dir, kind: spec.kind === 'party' || spec.kind === 'small' || (spec.kind === 'time' && GR.isBucketKey(spec.bucket)) ? spec.kind : 'picked', party: spec.party || null, members: members };
    if (made.kind === 'time') made.bucket = spec.bucket;
    T.groups.set(id, made);
    TR.place(T.pos, anchor, dir, { primary: [{ id: id }], secondary: [] }).forEach(function (v, k) { T.pos.set(k, v); });
    T.prov.set(id, { via: anchor, dir: dir });
    traceRecord({ type: 'group', id: id });
    state.selected = new Set([id]); state.selectedEdge = null; syncSelection();
    traceChanged([id], false);
    return id;
  }

  /**
   * Show members of a group as ordinary vertices: o.limit = the largest few, o.ids = these, neither = all of them. What is left stays folded
   * (a group of fewer than two is dissolved). One undo step takes the shown vertices back and restores the group as it was.
   */
  function traceExpandGroup(gid, o) {
    o = o || {};
    var T = state.trace, grp = T.groups.get(gid);
    if (!grp) return Promise.resolve(false);
    var rows = groupRows(grp), pick = o.ids ? rows.filter(function (r) { return o.ids.indexOf(r.id) >= 0; }) : o.limit ? rows.slice(0, o.limit) : rows;
    if (!pick.length) return Promise.resolve(false);
    var before = groupSpecClone(grp), p0 = T.pos.get(gid), pos = p0 ? { x: p0.x, y: p0.y } : null, prov = T.prov.get(gid) || null, n0 = T.undo.length;
    var chosen = new Set(pick.map(function (r) { return r.id; }));
    grp.members = grp.members.filter(function (m) { return !chosen.has(m); });
    if (grp.members.length < 2) traceDropGroup(gid);                                // one left is just that one
    syncSelection();
    return traceExpand(before.anchor, before.dir, { only: chosen, at: o.at }).then(function (ok) {
      if (!ok) {                                                                    // nothing was shown (an error, or busy): the group stays as it was
        T.groups.set(gid, groupSpecClone(before));
        if (pos) T.pos.set(gid, pos);
        if (prov) T.prov.set(gid, prov);
        traceChanged(null, false);
        return false;
      }
      var revealed = []; T.undo.splice(n0).forEach(function (u) { if (u.type === 'reveal') revealed = revealed.concat(u.ids); });
      traceRecord({ type: 'regroup', before: before, pos: pos, prov: prov, ids: revealed });
      return true;
    });
  }

  // ---- taking things off the screen (always undoable) -------------------------------------------
  /** Hide vertices. They stay loaded and their neighbours' handles count them again, so they can be shown again. */
  function traceHideIds(ids) {
    var T = state.trace, gids = ids.filter(function (id) { return T.groups.has(id); });
    ids = ids.filter(function (id) { return T.shown.has(id); });
    if (!ids.length && !gids.length) return 0;
    if (ids.length && ids.length >= T.shown.size) { toast('Keep at least one vertex on screen: use "Reset to start" or open something else.', true); return 0; }
    T.groups.forEach(function (g, gid) { if (ids.indexOf(g.anchor) >= 0 && gids.indexOf(gid) < 0) gids.push(gid); });         // a group hangs from its anchor: it goes with it
    var items = ids.map(function (id) { var p = T.pos.get(id); return { id: id, pos: p ? { x: p.x, y: p.y } : null, prov: T.prov.get(id) || null, seed: T.seeds.indexOf(id) >= 0 }; });
    gids.forEach(function (gid) { var p = T.pos.get(gid); items.push({ id: gid, pos: p ? { x: p.x, y: p.y } : null, prov: T.prov.get(gid) || null, group: groupSpecClone(T.groups.get(gid)) }); });
    ids.forEach(traceDrop); gids.forEach(traceDropGroup);
    var hadSeed = T.seeds.length; syncSeed();
    if (!T.seeds.length && T.shown.size) {                                         // every starting point was hidden: the oldest remaining vertex becomes the start
      var first = Array.from(T.shown)[0]; T.seeds = [first]; T.seed = first;
    }
    traceRecord({ type: 'hide', items: items });
    syncSelection(); traceChanged(null, false);
    return ids.length + gids.length;
  }
  function traceHideSelected() {
    var ids = traceSelected();
    if (!ids.length) { toast('Select the vertices to hide first (click, Shift-click, or Ctrl+A).'); return; }
    var k = traceHideIds(ids); if (k) toast('Hid ' + k + (k === 1 ? ' vertex' : ' vertices') + ' (they stay loaded; Ctrl+Z brings them back).');
  }
  function traceKeepOnly(ids) {
    var T = state.trace; ids = ids.filter(function (id) { return T.shown.has(id) || T.groups.has(id); });
    if (!ids.length) { toast('Select the vertices to keep first.'); return; }
    var keep = new Set(ids), rest = Array.from(T.shown).filter(function (id) { return !keep.has(id); }).concat(Array.from(T.groups.keys()).filter(function (id) { return !keep.has(id); }));
    if (!rest.length) { toast('Everything shown is selected: nothing to hide.'); return; }
    var k = traceHideIds(rest); if (k) toast('Kept ' + ids.length + ', hid ' + k + ' (Ctrl+Z brings them back).');
  }
  /** A vertex and everything that was revealed because of it. */
  function traceBranch(id) { return [id].concat(TR.descendants(state.trace.prov, id)).filter(function (x) { return state.trace.shown.has(x) || state.trace.groups.has(x); }); }
  function traceHideBranch(id) {
    var ids = traceBranch(id), k = traceHideIds(ids);
    if (k) toast('Hid ' + k + (k === 1 ? ' vertex' : ' vertices') + ' (Ctrl+Z brings them back).');
  }
  function traceSelectBranch(id) { state.selected = new Set(traceBranch(id)); state.selectedEdge = null; syncSelection(); }
  function traceSelectAll() { state.selected = new Set(Array.from(state.trace.shown).filter(function (id) { return state.graph.nodes.has(id); }).concat(Array.from(state.trace.groups.keys()))); state.selectedEdge = null; syncSelection(); }

  function traceUndoStep() {
    var T = state.trace, last = T.undo.pop();
    if (!last) return false;
    var back = [], fit = false, ok = true, direct = false;
    /** The groups a step had taken vertices out of, as they were before it (only where their anchor is still on the trace). */
    function refold(list) {
      (list || []).forEach(function (u) {
        var S0 = state.trace; if (!S0.shown.has(u.before.anchor)) return;
        S0.groups.set(u.before.id, groupSpecClone(u.before));
        if (u.pos) S0.pos.set(u.before.id, u.pos); if (u.prov) S0.prov.set(u.before.id, u.prov);
        back.push(u.before.id);
      });
    }
    if (last.type === 'restart') {                                                 // the trace as it was before "Reset to start" / "Start over", with its own steps
      var keepUndo = last.snap.undo;
      if (loadTraceData(last.snap.data)) { state.trace.undo = keepUndo; T = state.trace; traceSanitize(); T = state.trace; back = Array.from(T.shown); fit = true; }
      else { T.undo.push(last); ok = false; }
    } else if (last.type === 'group') {                                            // a group was made: take it apart (its members were never shown)
      traceDropGroup(last.id);
    } else if (last.type === 'regroup') {                                          // some of a group were shown: hide those again and put the group back as it was
      last.ids.forEach(traceDrop);
      T.groups.set(last.before.id, groupSpecClone(last.before));
      if (last.pos) T.pos.set(last.before.id, last.pos);
      if (last.prov) T.prov.set(last.before.id, last.prov);
      back.push(last.before.id);
    } else if (last.type === 'hide') {
      last.items.forEach(function (it) {
        if (it.group) {                                                            // a hidden group comes back as a group
          T.groups.set(it.id, groupSpecClone(it.group)); back.push(it.id);
          if (it.pos) T.pos.set(it.id, it.pos);
          if (it.prov) T.prov.set(it.id, it.prov);
          return;
        }
        T.shown.add(it.id); back.push(it.id);
        if (it.pos) T.pos.set(it.id, it.pos);
        if (it.prov) T.prov.set(it.id, it.prov);
        if (it.seed && T.seeds.indexOf(it.id) < 0) T.seeds.push(it.id);
      });
    } else if (last.type === 'seed') {
      T.seeds = T.seeds.filter(function (s) { return s !== last.id; });
      if (last.added) { traceDrop(last.id); refold(last.unfolded); }
    } else if (last.type === 'layout') {                                           // a Re-layout: every vertex goes back to where it was
      if (last.pos) { last.pos.forEach(function (a) { if (T.shown.has(a[0]) || T.groups.has(a[0])) T.pos.set(a[0], { x: a[1], y: a[2] }); }); fit = true; }
      else if (last.arr === state.arrange) { posSnapRestore(last.snap); direct = true; }
      else { toast('That Re-layout was in another arrangement: nothing to take back here.'); ok = false; }
    } else { last.ids.forEach(traceDrop); refold(last.unfolded); }
    if (!T.seeds.length && T.shown.size) T.seeds = [Array.from(T.shown)[0]];
    syncSeed(); syncSelection();
    if (direct) { refresh({}); updateTraceUi(); } else traceChanged(back, fit);
    return ok;
  }
  // ---- Undo, Redo and taking back a Re-layout ---------------------------------------------------------
  /** Record a step the Undo button can take back. A new step also ends the chain of steps Redo could put back. */
  function traceRecord(step) { var T = state.trace; T.undo.push(step); T.redo = []; }

  /** The trace as plain data, with its Undo steps: what Redo puts back after an Undo. null for an empty trace. */
  function traceSnap() { var d = traceData(); return d ? { data: d, undo: clone(state.trace.undo) } : null; }

  /** Where every vertex is drawn and which ones were dragged: what a Re-layout overwrites and Undo puts back. */
  function posSnap() {
    var cur = [], pinned = [];
    renderer.cur.forEach(function (p, id) { cur.push([id, p.x, p.y]); });
    state.pinned.forEach(function (p, id) { pinned.push([id, p.x, p.y]); });
    return { cur: cur, pinned: pinned };
  }
  function posSnapRestore(s) {
    var m = new Map();
    s.cur.forEach(function (a) { m.set(a[0], { x: a[1], y: a[2] }); });
    state.pinned = new Map(s.pinned.map(function (a) { return [a[0], { x: a[1], y: a[2] }]; }));
    if (state.layoutRes) state.layoutRes.pos = m;
    renderer.setPositions(m, false);
  }
  function posKey(list) { return JSON.stringify(list.map(function (a) { return [a[0], Math.round(a[1] * 10), Math.round(a[2] * 10)]; }).sort()); }

  function traceUndo() {
    var T = state.trace; if (!T.undo.length) return;
    var snap = traceSnap(), last = T.undo[T.undo.length - 1], redo = T.redo, arr = state.arrange;
    var view = last.type === 'layout' && last.arr ? posSnap() : null;
    var ok = traceUndoStep();
    var N = state.trace; N.redo = redo;
    if (ok && snap) redo.push({ snap: snap, len: N.undo.length, view: view, arr: arr });
    updateTraceUi();
  }
  function traceRedo() {
    var T = state.trace, e = T.redo.length ? T.redo[T.redo.length - 1] : null;
    if (!e) return;
    if (e.len !== T.undo.length) { T.redo = []; updateTraceUi(); return; }           // something new was done since: there is nothing to put back any more
    T.redo.pop();
    var redo = T.redo, was = new Set(T.shown);
    if (!loadTraceData(e.snap.data)) { T.redo = redo; toast('Could not put that back.', true); return; }
    state.trace.undo = clone(e.snap.undo); traceSanitize(); state.trace.redo = redo;
    var N = state.trace, added = Array.from(N.shown).filter(function (id) { return !was.has(id); });
    syncSeed(); syncSelection();
    if (e.view && e.arr === state.arrange) { posSnapRestore(e.view); refresh({}); updateTraceUi(); }
    else traceChanged(added, !added.length);
  }
  function canRedo() {
    if (traceOn()) { var T = state.trace, e = T.redo.length ? T.redo[T.redo.length - 1] : null; return !!e && e.len === T.undo.length; }
    return state.hideRedo.length > 0;
  }
  function redoLast() { if (traceOn()) traceRedo(); else hideRedoLast(); }

  /** The positions of what the trace shows, as [id, x, y]: what the Columns arrangement keeps and a Re-layout overwrites. */
  function tracePosList() {
    var T = state.trace, out = [];
    T.pos.forEach(function (p, id) { if (T.shown.has(id) || T.groups.has(id)) out.push([id, p.x, p.y]); });
    return out;
  }
  /** Re-layout outside the Columns arrangement: release the dragged vertices and place everything again, as one step Undo can take back. */
  function relayoutAll() {
    var before = posSnap(), arr = state.arrange, lay = state.layout, inTrace = traceOn();
    state.pinned.clear(); refresh({ relayout: true, fit: true });
    var after = [];
    if (state.layoutRes && state.layoutRes.pos) state.layoutRes.pos.forEach(function (p, id) { after.push([id, p.x, p.y]); });
    var ids = new Set(after.map(function (a) { return a[0]; }));
    if (!before.pinned.length && posKey(before.cur.filter(function (a) { return ids.has(a[0]); })) === posKey(after)) return;      // nothing moved
    if (inTrace) traceRecord({ type: 'layout', arr: arr, snap: before });
    else { state.hideUndo.push({ type: 'layout', layout: lay, snap: before }); state.hideRedo = []; }
    updateTraceUi();
    toast('Re-arranged. Undo (Ctrl+Z) puts every vertex back where it was.', false, { text: 'Undo', fn: undoLast });
  }
  function layoutStepUndo(e) {
    if (e.layout !== state.layout) { toast('That Re-layout was in another layout: nothing to take back here.'); return; }
    e.after = posSnap(); posSnapRestore(e.snap); state.hideRedo.push(e); refresh({}); updateTraceUi();
  }
  function layoutStepRedo(e) {
    if (e.layout !== state.layout || !e.after) { toast('That Re-layout was in another layout: nothing to put back here.'); return; }
    posSnapRestore(e.after); state.hideUndo.push(e); refresh({}); updateTraceUi();
  }

  function traceReset() {
    var T = state.trace; if (!T.seed) return;
    var seed = T.seed;
    traceRestart(seed); state.selected = new Set([seed]); syncSelection(); traceChanged(null, true);
  }
  /** [ and ] in a trace: expand the selected wallet or transaction, or the start. */
  function traceKey(dir) {
    var id = Array.from(state.selected).filter(function (x) { return state.trace.shown.has(x) && walletOrTx(x); })[0] || state.trace.seed;
    if (id) traceExpand(id, dir);
  }
  /** Re-run the automatic left-to-right layout over what is shown (positions are otherwise yours). */
  function traceTidy() {
    if (state.arrange !== 'columns') { relayoutAll(); return; }
    var T = state.trace, before = tracePosList(), vg = viewGraph(), vis = F.computeVisible(vg, state.filter, state.keep, null, traceOnly());
    L.layoutFlow(vg, vis, {}).pos.forEach(function (p, id) { T.pos.set(id, { x: p.x, y: p.y }); });
    if (posKey(before) !== posKey(tracePosList())) {
      traceRecord({ type: 'layout', pos: before });
      toast('Re-arranged. Undo (Ctrl+Z) puts every vertex back where it was.', false, { text: 'Undo', fn: undoLast });
    }
    traceChanged(null, true);
  }

  /** The trace as plain data for the saved session and the export. */
  function traceData() {
    var T = state.trace; if (!T.seed) return null;
    var pos = {}, prov = {};
    T.pos.forEach(function (p, id) { if (T.shown.has(id)) pos[id] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; });
    T.prov.forEach(function (p, id) { if (T.shown.has(id)) prov[id] = [p.via, p.dir]; });
    var out = { seed: T.seed, seeds: T.seeds.slice(), shown: Array.from(T.shown), pos: pos, prov: prov };
    if (T.groups.size) {                                                           // groups are saved by what they stand for; their vertex and edge are rebuilt from the graph
      out.groups = Array.from(T.groups.values()).map(function (g) { var p = T.pos.get(g.id); var o = { id: g.id, anchor: g.anchor, dir: g.dir, kind: g.kind, party: g.party, members: g.members.slice(), pos: p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] : null };
        ['bucket', 'label', 'note', 'tag', 'color', 'shape'].forEach(function (k) { if (g[k]) o[k] = g[k]; });
        return o; });
      out.seq = T.seq;
    }
    return out;
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
    T.seed = seeds[0]; T.seeds = seeds; T.shown = shown; T.pos = pos; T.prov = prov; T.undo = []; T.redo = []; T.groups = new Map(); T.seq = 0;
    if (Array.isArray(d.groups)) d.groups.slice(0, 200).forEach(function (x) {      // groups: only well-formed ones whose anchor is on the trace
      if (!x || typeof x !== 'object' || !GR.isGroupId(x.id) || T.groups.has(x.id)) return;
      var anchor = typeof x.anchor === 'string' && NV.isId(x.anchor) ? canonicalId(x.anchor) : null;
      if (!anchor || !shown.has(anchor) || (x.dir !== 'next' && x.dir !== 'prev') || !Array.isArray(x.members)) return;
      var members = x.members.slice(0, 5000).filter(function (m) { return typeof m === 'string' && NV.isId(m); }).map(canonicalId);
      if (members.length < 2) return;
      var spec = { id: x.id, anchor: anchor, dir: x.dir, kind: x.kind === 'party' || x.kind === 'small' || (x.kind === 'time' && GR.isBucketKey(x.bucket)) ? x.kind : 'picked',
                   party: typeof x.party === 'string' && NV.isId(x.party) ? canonicalId(x.party) : null, members: members };
      var lab = typeof x.label === 'string' ? LB.cleanText(x.label, 120) : '', nt = typeof x.note === 'string' ? x.note.slice(0, 4000) : '';
      if (spec.kind === 'time') spec.bucket = x.bucket;
      if (lab) spec.label = lab; if (nt) spec.note = nt;
      ['tag', 'color', 'shape'].forEach(function (k) { if (typeof x[k] === 'string') spec[k] = x[k]; }); TG.sanitize(spec);                    // only valid tags, colours and shapes ever reach a canvas
      T.groups.set(x.id, spec);
      var gp = Array.isArray(x.pos) && x.pos.length === 2 && isFinite(x.pos[0]) && isFinite(x.pos[1]) && Math.abs(x.pos[0]) < 1e6 && Math.abs(x.pos[1]) < 1e6 ? { x: x.pos[0], y: x.pos[1] } : null, ap = pos.get(anchor) || { x: 0, y: 0 };
      T.pos.set(x.id, gp || { x: ap.x + (x.dir === 'next' ? 200 : -200), y: ap.y });
      T.prov.set(x.id, { via: anchor, dir: x.dir });
      T.seq = Math.max(T.seq, parseInt(x.id.slice(4), 10) || 0);
    });
    if (typeof d.seq === 'number' && isFinite(d.seq)) T.seq = Math.max(T.seq, Math.min(1000000000, Math.floor(d.seq)));
    return true;
  }
  /** After a graph was merged in: forget trace vertices that are not in it. */
  function traceSanitize() {
    var T = state.trace, g = state.graph;
    Array.from(T.shown).forEach(function (id) { if (!g.nodes.has(id)) { T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); } });
    syncSeed();
    if (!T.seeds.length && T.shown.size) { T.seeds = [Array.from(T.shown)[0]]; T.seed = T.seeds[0]; }
    if (!T.shown.size) state.trace = emptyTrace(); else traceCleanGroups();
  }
  /** A vertex was deleted from the workspace altogether. */
  function traceForget(ids) {
    var T = state.trace;
    ids.forEach(function (id) { T.shown.delete(id); T.pos.delete(id); T.prov.delete(id); });
    syncSeed();
    if (!T.seeds.length && T.shown.size) { T.seeds = [Array.from(T.shown)[0]]; T.seed = T.seeds[0]; }
    if (!T.shown.size) state.trace = emptyTrace(); else traceCleanGroups();
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

  /** More of a wallet's history (the next pages after what is loaded). Resolves when it is done; the details panel is drawn again. */
  function loadMoreHistory(id) {
    var n = state.graph.nodes.get(id);
    if (!n || n.type !== 'addr') return Promise.resolve(null);
    var more = n.histNext;
    return run((more ? 'More history of ' : 'History of ') + S.shortId(n.address, 8), function () {
      return state.explorer.expandAddress(n.address, { pages: state.capPages, cap: state.capPages * 25, after: more || undefined }).then(function (r) {
        var node = state.graph.nodes.get(id);
        if (node) { node.histNext = r.last || null; node.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); }
        return r;
      });
    }).then(function (r) { showInspector(); return r; });
  }
  function expandNode(id, direction) {
    var n = state.graph.nodes.get(id); if (!n) return;
    if (n.type === 'tx') {
      var dirLabel = direction === 'forward' ? 'spenders' : direction === 'backward' ? 'funding transactions' : 'both directions';
      run('Expand ' + S.shortId(n.txid, 6) + ' (' + dirLabel + ')', function () { return state.explorer.expandTx(n.txid, direction || 'both', state.capTx); });
    } else if (n.type === 'addr') {
      loadMoreHistory(id);
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
    state.selectedEdge = null; state.hideUndo.push({ type: 'hide', ids: list }); state.hideRedo = [];
    if (skipped) toast('The focused vertex was not hidden: move the focus first, or untick Focus.');
    afterHide();
    return list.length;
  }
  function showIds(ids) {
    var list = ids.filter(function (id) { return state.hidden.has(id); });
    if (!list.length) return 0;
    list.forEach(function (id) { state.hidden.delete(id); });
    state.hideUndo.push({ type: 'show', ids: list }); state.hideRedo = []; afterHide();
    return list.length;
  }
  function hideUndoLast() {
    var e = state.hideUndo.pop(); if (!e) return;
    if (e.type === 'layout') { layoutStepUndo(e); return; }
    e.ids.forEach(function (id) { if (e.type === 'hide') state.hidden.delete(id); else state.hidden.add(id); });
    state.hideRedo.push(e);
    afterHide();
  }
  function hideRedoLast() {
    var e = state.hideRedo.pop(); if (!e) return;
    if (e.type === 'layout') { layoutStepRedo(e); return; }
    e.ids.forEach(function (id) { if (e.type === 'hide') state.hidden.add(id); else state.hidden.delete(id); });
    state.hideUndo.push(e);
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
      dl.appendChild(el('dt', { text: 'Balance' })); dl.appendChild(el('dd', { text: 'not loaded yet: press Load balance to read it' }));
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
      var loadText = 'Load ' + plural(unknown.length, 'balance');
      kids.push(el('p', { 'class': 'hint', text: plural(unknown.length, 'wallet') + (known ? ' not loaded yet: press ' : ': balances not loaded yet. Press ') + loadText + ' to read ' + (unknown.length === 1 ? 'it' : 'them') + '.' }));
      kids.push(el('div', { 'class': 'insp-actions' }, [el('button', { type: 'button', text: loadText, title: 'One request per wallet, no history', onclick: function () { loadBalances(unknown); } })]));
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
  /** Where x is time a transaction may only be dragged up and down (Shift frees it); wallets, coinbase, data outputs and groups have no time of their own and move freely. */
  function lockedToTime(id) {
    if (!timeScaleOn()) return false;
    var n = state.graph.nodes.get(id);
    return !!n && n.type === 'tx';
  }
  var MOVE_HINT = 'Dragging moves a transaction up and down only, so it stays at its time. Hold Shift to move it sideways too.';
  function moveHint(id) {                                                                  // said once per visit when a transaction is clicked; the details panel says it every time
    if (state.moveHinted || !lockedToTime(id)) return;
    state.moveHinted = true; toast(MOVE_HINT);
  }
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

  // ---- Find: which of the loaded vertices match what was typed -----------------------------------------------
  var find = { open: false, results: [], total: 0, index: 0, timer: null, pending: false, query: '' };
  var FIND_FIELDS = { id: 'id', label: 'label', tag: 'tag', note: 'note', known: 'known as', cluster: 'cluster', block: 'block' };

  function findTagName(tag) { var p = TG.PRESETS.filter(function (x) { return x.id === tag; })[0]; return p ? p.name : ''; }
  function findIsShown(id) { return !!(renderer && renderer.data && renderer.data.visible.nodes.has(id)); }
  function findStatus(id) { return findIsShown(id) ? 'on screen' : state.hidden.has(id) ? 'hidden by you' : 'not shown'; }
  function findLoaded() { var n = 0; state.graph.nodes.forEach(function (v) { if (v.type === 'tx' || v.type === 'addr') n++; }); return n; }
  function findMarked(text, at, len, max) { var s = FD.snippet(text, at, len, max); return [s.before, el('mark', { text: s.hit }), s.after]; }

  function findRun() {
    clearTimeout(find.timer); find.pending = false;
    var q = $('findQ').value; find.query = q;
    var r = FD.search(state.graph, q, {
      known: function (a) { return KNOWN[a] || null; },
      clusterOf: function (id) { var cl = analysis().clusters.byAddr.get(id); return cl ? { label: cl.label } : null; },
      tagName: findTagName, limit: FD.LIMIT
    });
    find.results = r.results; find.total = r.total; find.index = 0;
    findRender();
  }
  function findRender() {
    var list = $('findList'), foot = $('findFoot'), q = find.query.trim();
    list.textContent = '';
    $('findQ').setAttribute('aria-expanded', String(find.results.length > 0));
    $('findQ').removeAttribute('aria-activedescendant');
    if (!q) { foot.textContent = 'Type part of an id or address, a label, a note, a tag, a name (for example Binance) or a cluster (C3). Several words must all match. ' + plural(findLoaded(), 'transaction or wallet is', 'transactions and wallets are') + ' loaded.'; return; }
    if (q.length < 2) { foot.textContent = 'Keep typing: at least two characters.'; return; }
    if (!find.results.length) {
      foot.textContent = '';
      var chk = A.checkQuery(q), kids = [el('span', { text: 'Nothing among the ' + plural(findLoaded(), 'loaded transaction or wallet', 'loaded transactions and wallets') + '.' })];
      if (chk.ok) { kids.push(el('span', { text: 'That looks like an id that is not in the workspace yet.' })); kids.push(el('button', { type: 'button', 'class': 'primary', text: 'Add ' + S.shortId(chk.value, 8), onclick: function () { findReset(); findClose(false); openQuery(q); } })); }
      list.appendChild(el('div', { 'class': 'findnone' }, kids));
      return;
    }
    find.results.forEach(function (r, i) {
      var st = findStatus(r.id), why = r.why, titleKids, subs = [], idShown = false;
      var lab = why.filter(function (w) { return w.field === 'label' && w.text === r.label; })[0];
      titleKids = r.label ? (lab ? findMarked(r.label, lab.at, lab.len, 80) : [r.label]) : [S.shortId(r.value, 14)];
      why.forEach(function (w) {
        if (w === lab) return;
        if (w.field === 'id') idShown = true;
        subs.push(el('div', { 'class': 'findsub' }, [el('b', { text: FIND_FIELDS[w.field] + ': ' })].concat(findMarked(w.text, w.at, w.len, 64))));
      });
      if (r.label && !idShown) subs.push(el('div', { 'class': 'findsub', text: S.shortId(r.value, 16) }));
      list.appendChild(el('div', { 'class': 'findrow' + (i === find.index ? ' on' : ''), role: 'option', id: 'findOpt' + i, 'aria-selected': i === find.index ? 'true' : 'false',
        title: r.value, onclick: function () { findPick(i); }, onmouseenter: function () { findSet(i, false); } }, [
        el('span', { 'class': 'tag', text: r.type === 'tx' ? 'TX' : 'WALLET' }),
        el('div', { 'class': 'findmain' }, [el('div', null, titleKids)].concat(subs)),
        el('span', { 'class': 'findstat' + (st === 'on screen' ? ' on' : ''), text: st })]));
    });
    foot.textContent = (find.total > find.results.length ? 'The best ' + find.results.length + ' of ' + find.total + ': type more to narrow it down.' : plural(find.total, 'match', 'matches')) + ' · ↑ ↓ choose · Enter goes to it · Esc closes';
    $('findQ').setAttribute('aria-activedescendant', 'findOpt' + find.index);
  }
  function findSet(i, scroll) {
    find.index = i;
    Array.prototype.forEach.call($('findList').querySelectorAll('.findrow'), function (row, k) {
      var on = k === i; row.classList.toggle('on', on); row.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    });
    $('findQ').setAttribute('aria-activedescendant', 'findOpt' + i);
  }
  function findMove(d) { if (!find.results.length) return; findSet((find.index + d + find.results.length) % find.results.length, true); }
  /** Drop the matches down from the field in the top bar (the field has the keyboard, or was clicked). */
  function findShow() {
    var box = $('findBox');
    box.style.top = Math.round($('top').getBoundingClientRect().bottom + 6) + 'px';
    box.hidden = false; find.open = true; findRun();
  }
  function findOpen() { var inp = $('findQ'); inp.focus(); inp.select(); if (!find.open) findShow(); }
  function findClose(refocus) {
    $('findBox').hidden = true; find.open = false; clearTimeout(find.timer); find.pending = false;
    $('findQ').setAttribute('aria-expanded', 'false');
    if (refocus !== false) $('cv').focus();
  }
  function findReset() { $('findQ').value = ''; find.query = ''; find.results = []; find.total = 0; }
  function findPick(i) {
    var r = find.results[i]; if (!r) return;
    findReset(); findClose(); findGo(r.id);
  }
  /** Select the vertex and bring it into view. One that is loaded but not on screen is brought in: in a trace it is added as another starting point (Undo takes it back), elsewhere it is un-hidden or the focus moves to it. */
  /** Select a vertex and bring it into view (adding it first when it is not there). `keep`: from the Findings, so the right-hand panel stays on them. */
  function findGo(id, keep) {
    if (!state.graph.nodes.has(id)) return;
    function show() { if (keep) holdRight++; try { setSel([id]); } finally { if (keep) holdRight--; } renderer.centerOn(id); renderer.pulse([id]); }
    if (findIsShown(id)) { show(); return; }
    if (!traceOn() && state.hidden.has(id)) { showIds([id]); if (findIsShown(id)) { show(); return; } }
    navigate(id).then(function (ok) {
      if (ok === false) return;
      if (keep) { state.rightTab = 'findings'; showInspector(true); }
      if (findIsShown(id)) { show(); if (traceOn()) toast('Added to the trace as another starting point (Ctrl+Z takes it back).'); }
      else toast('It is loaded but not on screen: a filter or the time bar hides it (see Filters and the time range).', true);
    });
  }
  function findEnter() {
    if (find.pending) findRun();
    if (find.results.length) { findPick(find.index); return; }
    var chk = A.checkQuery(find.query);
    if (chk.ok) { var again = find.query; findReset(); findClose(false); openQuery(again); }
  }

  // ---- selection and inspector ----------------------------------------------------------------
  function selectOnly(id) { state.selected = id ? new Set([id]) : new Set(); state.selectedEdge = null; syncSelection(); }
  function syncSelection() {
    renderer.setSelection(Array.from(state.selected)); renderer.selectedEdge = state.selectedEdge;
    if (!holdRight && (state.selected.size || state.selectedEdge)) state.rightTab = 'details';
    showInspector(); updateTraceUi(); updateAutoUi(); detMarkSel();
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
    var key = e.count > 1 ? 'b' + e.id : e.id, hit = edgeLabelCache.get(key); if (hit !== undefined) return hit;
    var fx = fiatOn() && !e.virtual ? fiatOfEdge(e) : null, mode = fx ? state.fiat.show : 'btc', btc = S.fmtBtcShort(e.amount);      // a group's total spans many moments: no single price fits, so it is shown in BTC only
    var t = mode === 'fiat' ? fx.text : mode === 'both' ? btc + ' · ' + fx.text : btc;
    if (e.count > 1) t = e.count + (e.kind === 'out' ? ' outputs' : ' inputs') + ' · ' + t;                                             // several coins drawn as one arrow: how many, and their total
    var cm = null;
    if (state.analysis.change && state.an) {
      if (e.parts) { for (var i = 0; i < e.parts.length && !cm; i++) cm = state.an.changeEdges.get(e.parts[i]); }
      else cm = state.an.changeEdges.get(e.id);
    }
    if (cm) t += ' · ' + (cm.confidence === 'high' ? 'likely change' : 'change?');
    edgeLabelCache.set(key, t);
    return t;
  }
  /** The coins on the same arrow as this edge (the same two ends and kind, on screen), this one first; just [e] when the option is off or it is alone. */
  function parallelEdges(e) {
    if (!state.bundleEdges || e.virtual) return [e];
    var vis = renderer && renderer.data ? renderer.data.visible.edges : null, out = [e];
    state.graph.edgesOf(e.source).forEach(function (x) { if (x !== e && x.kind === e.kind && x.source === e.source && x.target === e.target && (!vis || vis.has(x.id))) out.push(x); });
    return out;
  }
  /** Every coin of an arrow in the details: where it came from (or whether it is spent) and its amount, largest first; a click selects that coin. */
  function parallelList(sel, par) {
    var rows = par.slice().sort(function (a, b) { return (b.amount || 0) - (a.amount || 0); }), list = el('div', { 'class': 'linkrows' });
    rows.slice(0, 60).forEach(function (x) {
      var what = x.kind === 'in' ? (x.prev ? 'from ' + S.shortId(x.prev.txid, 6) + ' : ' + x.prev.vout : 'input ' + x.vin) : 'output ' + x.vout + (x.spent === true ? ' · spent' : x.spent === false ? ' · unspent' : '');
      list.appendChild(el('button', { type: 'button', 'class': 'linkrow' + (x.id === sel.id ? ' on' : ''), title: 'Select this coin', onclick: function () { state.selectedEdge = x.id; state.selected = new Set(); syncSelection(); } },
                          [el('span', { 'class': 'who', text: what }), el('span', { 'class': 'amt', text: S.fmtBtc(x.amount) + ' BTC' })]));
    });
    var box = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Coins on this arrow' }), list]);
    if (rows.length > 60) box.appendChild(el('p', { 'class': 'hint', text: '… and ' + (rows.length - 60) + ' more, smaller' }));
    return box;
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
  function fiatCtx() { return { books: state.books, today: state.today, fmtTime: S.fmtTime }; }
  function fiatRate(time) { return PR.rateFor(state.fiat, time, fiatCtx()); }

  /** {value, text, title, approx, rate} for `sats` at `time`, or null. */
  function fiatOf(sats, time) { return PR.amountOf(state.fiat, sats, time, fiatCtx()); }
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
  var ARKHAM_TITLE = 'Opens Arkham in a new tab, with your own Arkham account if you are signed in there. Arkham is told which one you are looking at; no key or proxy is used.';
  /** Arkham's page for a wallet or transaction vertex, or '' (not for Tor: it would go outside Tor and tell Arkham what you are looking at). */
  function arkhamHref(n) {
    if (!n || state.source === 'tor') return '';
    return n.type === 'tx' ? XT.arkhamUrl('tx', n.txid) : n.type === 'addr' ? XT.arkhamUrl('address', n.address) : '';
  }
  function arkhamLink(n) {
    var href = arkhamHref(n);
    return href ? el('a', { href: href, target: '_blank', rel: 'noopener noreferrer', title: ARKHAM_TITLE, text: 'Check in Arkham ↗' }) : null;
  }

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
  function tagControls(ids, getNode) {
    var g = state.graph, get = getNode || function (id) { return g.nodes.get(id); }, nodes = ids.map(get).filter(Boolean), first = nodes[0] || {};
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
      var n = get(ids[0]) || {};
      var c = n.color || (TG.preset(n.tag) || {}).color;
      color.value = c || '#8d7f8d'; shapeSel.value = n.shape || '';
      preview.textContent = SHAPE_GLYPH[n.shape || DEFAULT_SHAPE_OF[n.type] || 'circle'];
      preview.style.color = c || '';
      Array.prototype.forEach.call(swatches.children, function (b) { b.setAttribute('aria-pressed', String(!!c && b.getAttribute('data-color') === c)); });
    }
    function apply(fields, keepStyle) {
      ids.forEach(function (id) { var nd = get(id); if (nd) TG.apply(nd, fields, keepStyle); });
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

  /** Keep the menu on the screen after its content grew (a group was opened in the list behind an arrow). */
  function clampCtx() {
    var m = $('ctxMenu'); if (m.hidden) return;
    var r = m.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) m.style.top = Math.max(4, window.innerHeight - r.height - 8) + 'px';
    if (r.right > window.innerWidth - 8) m.style.left = Math.max(4, window.innerWidth - r.width - 8) + 'px';
  }

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

  /** The right-click menu of a group vertex. */
  function groupCtx(gid, m, at) {
    var grp = state.trace.groups.get(gid), gn = groupNodeOf(gid); if (!grp || !gn) return;
    var rows = groupRows(grp), N = state.stepSize;
    m.appendChild(el('div', { 'class': 'ctxhead', text: 'Group · ' + gn.groupText }));
    if (rows.length > N) ctxItem(m, 'Show the largest ' + N, function () { traceExpandGroup(gid, { limit: N }); }, { title: 'The rest stay in the group' });
    ctxItem(m, 'Show all ' + rows.length, function () { traceExpandGroup(gid, {}); });
    if (rows.length > 2) ctxItem(m, 'Choose which…', function () { traceChoose(grp.anchor, grp.dir, at, { group: gid }); }, { keep: true });
    m.appendChild(el('div', { 'class': 'sep' }));
    var anchorIsAddr = state.graph.nodes.get(grp.anchor).type === 'addr', what = plural(rows.length, anchorIsAddr ? 'transaction id' : 'address', anchorIsAddr ? undefined : 'addresses');
    ctxItem(m, 'Copy ' + what, function () { copy(rows.map(function (r) { return plainId(r.id); }).join(NL), what); });
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, 'Hide group', function () { traceHideIds([gid]); }, { danger: true, title: 'What is in it stays hidden (Ctrl+Z brings it back)' });
    placeCtx(at);
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
        ctxItem(m, 'Delete ' + ids.length + ' from workspace', function () { deleteIds(ids); }, { danger: true, title: 'Deletes them from the workspace (Hide only takes them off the screen); Undo load in the top bar brings them back' });
      } else {
        ctxItem(m, 'Hide ' + ids.length, function () { var k = hideIds(ids); if (k) toast('Hid ' + plural(k, 'vertex', 'vertices') + ' (Ctrl+Z brings them back).'); });
        ctxItem(m, 'Keep only these ' + ids.length, function () { keepOnly(ids); });
        ctxItem(m, 'Delete ' + ids.length + ' from workspace', function () { deleteIds(ids); }, { danger: true, title: 'Deletes them from the workspace (Hide only takes them off the screen); Undo load in the top bar brings them back' });
      }
      placeCtx(at); return;
    }
    if (ids.length === 1 && traceOn() && state.trace.groups.has(ids[0])) { groupCtx(ids[0], m, at); return; }
    var n = g.nodes.get(ids[0]); if (!n) return;
    m.appendChild(el('div', { 'class': 'ctxhead', text: (KIND_NAME[n.type] || 'Vertex') + ' · ' + focusLabel(n.id).replace(/^tx /, '') }));
    if (traceOn() && (n.type === 'tx' || n.type === 'addr')) {
      function lab(dir) { return TR.handleLabel(trHidden(n.id, dir)); }
      var T0 = state.trace, isSeed = T0.seeds.indexOf(n.id) >= 0, inTrace = T0.shown.has(n.id), branch = inTrace ? traceBranch(n.id) : [];
      ctxItem(m, 'Show forward ▶', function () { traceExpand(n.id, 'next', { at: at }); }, { right: lab('next') });
      ctxItem(m, '◀ Show backward', function () { traceExpand(n.id, 'prev', { at: at }); }, { right: lab('prev') });
      ctxItem(m, 'Choose what to show ▶…', function () { traceChoose(n.id, 'next', at); }, { keep: true, disabled: !trHidden(n.id, 'next').known });
      ctxItem(m, '◀ Choose what to show…', function () { traceChoose(n.id, 'prev', at); }, { keep: true, disabled: !trHidden(n.id, 'prev').known });
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
      var arkHref = arkhamHref(n);
      if (arkHref) m.appendChild(el('a', { href: arkHref, target: '_blank', rel: 'noopener noreferrer', role: 'menuitem', title: ARKHAM_TITLE, onclick: function () { closeCtx(); } }, [el('span', { text: 'Check in Arkham' }), el('span', { 'class': 'hint', text: '↗' })]));
    }
    m.appendChild(el('div', { 'class': 'sep' }));
    if (traceOn()) {
      ctxItem(m, 'Hide from the trace', function () { traceHideIds(ids); }, { danger: true, disabled: state.trace.shown.size <= 1 });
      ctxItem(m, 'Delete from workspace', function () { deleteIds(ids); }, { danger: true, title: 'Deletes it from the workspace (Hide only takes it off the screen); Undo load in the top bar brings it back' });
    } else {
      ctxItem(m, 'Hide this vertex', function () { var k = hideIds(ids); if (k) toast('Hid it (Ctrl+Z brings it back).'); }, { title: 'Take it off the screen; it stays loaded' });
      ctxItem(m, 'Delete from workspace', function () { deleteIds(ids); }, { danger: true, title: 'Deletes it from the workspace (Hide only takes it off the screen); Undo load in the top bar brings it back' });
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
    function lbl(dir) { return TR.handleLabel(trHidden(n.id, dir)); }
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
    var seen = new Set(), names = [], ids = [];
    g.edgesOf(txId).forEach(function (e) {
      var other = side === 'out' ? (e.kind === 'out' && e.source === txId ? e.target : null) : (e.kind === 'in' && e.target === txId ? e.source : null);
      if (!other || other === selfId || seen.has(other) || !g.nodes.has(other)) return;
      seen.add(other); names.push(focusLabel(other));
      if (g.nodes.get(other).type === 'addr') ids.push(other);                       // the wallets (not a coinbase or a data output): what rows can be grouped by
    });
    return { names: names, ids: ids };
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
  /**
   * Outside the Trace layout: bring transactions onto the graph. What you hid is shown again (Undo hides it again), and the Focus view is
   * switched off when it is what keeps them out. The selection is left alone. Nothing happens to what a filter or the time bar hides.
   */
  function showOnGraph(ids) {
    ids = ids.filter(function (id) { return state.graph.nodes.has(id); });
    if (!ids.length || traceOn()) return;
    var said = [], visible = function () { return renderer.data ? renderer.data.visible.nodes : new Set(); };
    if (showIds(ids)) said.push('showed what you had hidden');
    if (ids.some(function (id) { return !visible().has(id); }) && state.focusOn) {
      state.focusOn = false; $('focusOn').checked = false; afterGraphChange({ fit: false });
      if (ids.some(function (id) { return visible().has(id); })) { said.push('switched the Focus view off'); savePrefs(); }
      else { state.focusOn = true; $('focusOn').checked = true; afterGraphChange({ fit: false }); }          // the Focus view was not the reason: leave it as it was
    }
    var on = ids.filter(function (id) { return visible().has(id); });
    if (!on.length) { toast('A filter or the time bar keeps ' + (ids.length === 1 ? 'it' : 'them') + ' off the screen (see Filters and the time range).', true); return; }
    renderer.ensureVisible(on);
    var left = ids.length - on.length;
    toast(plural(on.length, 'transaction') + ' on the graph' + (said.length ? ' (' + said.join(' and ') + ')' : '') + (left ? '; ' + left + ' stay off it because of a filter or the time bar' : '') + '.');
  }

  function walletRows(n) {
    var g = state.graph, byTx = new Map(), rows = [];
    g.edgesOf(n.id).forEach(function (e) {
      var received = e.kind === 'out' && e.target === n.id, spent = e.kind === 'in' && e.source === n.id;
      if (!received && !spent) return;
      var r = byTx.get(e.txid) || { recv: 0, sent: 0, keep: 0, unsure: false };
      if (received) { r.recv += e.amount; if (e.spent === false) r.keep += e.amount; else if (e.spent !== true) r.unsure = true; } else r.sent += e.amount;      // keep: what is still unspent here
      byTx.set(e.txid, r);
    });
    byTx.forEach(function (r, txid) {
      var id = ID.tx(txid), t = g.nodes.get(id), net = r.recv - r.sent, mixed = r.recv > 0 && r.sent > 0;
      var dir = !r.sent ? 'in' : !r.recv ? 'out' : net > 0 ? 'in' : net < 0 ? 'out' : 'self';
      var party = partiesOf(id, dir === 'in' ? 'in' : 'out', n.id);                                          // who is on the other side; null while the transaction is not loaded
      if (mixed && dir === 'out' && party && !party.names.length) dir = 'self';                              // every output came back to the wallet: it only moved money to itself
      var lv = (party ? party.ids : []).map(knownLevel);
      rows.push({ id: id, txid: txid, unspent: r.recv ? (r.unsure ? null : r.keep > 0) : false, level: lv.reduce(function (a, b) { return Math.max(a, b); }, 0), service: lv.indexOf(1) >= 0, party: party, parties: party ? party.ids : [], time: t ? t.time : null, pending: !!t && t.confirmed === false, unloaded: !!t && t.loaded === false, recv: r.recv, sent: r.sent, dir: dir, mixed: mixed, amount: dir === 'self' ? r.sent : mixed ? Math.abs(net) : (dir === 'in' ? r.recv : r.sent) });
    });
    return rows;
  }

  var DIR_TAG = { 'in': '↓ in', out: '↑ out', self: '↔ self' };

  /**
   * The Transactions list of a selected wallet: In / Out told apart, who is on the other side, sortable, with a button to put one on the
   * trace. Rows that look alike (the same wallet on the other side three times or more, or small amounts) fold into one line that can be
   * opened, copied, or put on the trace as the largest few or all of them.
   */
  function walletTxSection(n) {
    var rows = walletRows(n); if (!rows.length) return null;
    var V = state.walletView, box = el('div', { 'class': 'insp-section walletsec' });
    if (V.tickFor !== n.id) { V.tickFor = n.id; V.ticked = new Set(); }                                      // the ticks belong to the wallet they were made on
    var tickers = [], wantSet = new Set(), bar = null, pickInfo = null, pickActs = null;
    var inRows = rows.filter(function (r) { return r.dir === 'in'; }), outRows = rows.filter(function (r) { return r.dir === 'out'; });
    function total(list) { return list.reduce(function (t, r) { return t + r.amount; }, 0); }
    function when(r) { return r.pending ? Infinity : r.time == null ? -Infinity : r.time; }                       // unconfirmed is the newest; a transaction not loaded yet has no date: last
    function byTime(a, b) { var ta = when(a), tb = when(b); return ta === tb ? (b.amount - a.amount) : (tb > ta ? 1 : -1); }
    function onTrace(r) { return traceOn() ? state.trace.shown.has(r.id) : !renderer || !renderer.data || renderer.data.visible.nodes.has(r.id); }       // on the trace, or (elsewhere) on the screen
    function canShow(r) { return !traceOn() && !onTrace(r); }                                                // not on the screen: it can be brought in
    /** The same choices as the arrow list: which wallets are on the other side, only coins still unspent here, and five orders. */
    var canUnspent = rows.some(function (r) { return r.recv > 0 && r.unspent !== null; });                       // some payment in has a known spent / unspent state
    function matches(r) {
      if (V.who === 'skip' && r.service) return false;
      if (V.who === 'only' && r.level < 1) return false;
      if (canUnspent && V.unspent && r.unspent !== true) return false;
      return true;
    }
    function orderFn(k) {
      function byAmt(a, b) { return b.amount - a.amount || (a.id < b.id ? -1 : 1); }
      if (k === 'big') return byAmt;
      if (k === 'small') return function (a, b) { return a.amount - b.amount || (a.id < b.id ? -1 : 1); };
      if (k === 'known') return function (a, b) { return (b.level - a.level) || byAmt(a, b); };                  // labelled by you, then known, then the rest, each largest first
      if (k === 'old') return function (a, b) {
        var ta = a.pending ? Infinity : a.time, tb = b.pending ? Infinity : b.time;
        if (ta == null || tb == null) return (ta == null ? 1 : 0) - (tb == null ? 1 : 0) || byAmt(a, b);               // a transaction with no date comes last in either order
        return (ta - tb) || byAmt(a, b);
      };
      return byTime;
    }
    function canPut(r) { return traceOn() && state.trace.shown.has(n.id) && !state.trace.shown.has(r.id); }
    /** Put these transactions on the trace: the ones the wallet spent in come forward, the ones that paid it come from behind. */
    function putOnTrace(list) {
      var chain = Promise.resolve();
      ['next', 'prev'].forEach(function (d) {
        var ids = list.filter(function (r) { return canPut(r) && (r.sent > 0 ? 'next' : 'prev') === d; }).map(function (r) { return r.id; });
        if (ids.length) chain = chain.then(function () { return traceExpand(n.id, d, { only: new Set(ids) }); });
      });
      return chain;
    }
    /** Put these on the trace as one group vertex per direction (the ones the wallet spent in hang forward, the ones that paid it hang behind). */
    function putAsGroup(g, list) {
      ['next', 'prev'].forEach(function (d) {
        var m = list.filter(function (r) { return canPut(r) && (r.sent > 0 ? 'next' : 'prev') === d; });
        if (m.length >= 2) traceMakeGroup(n.id, d, m.map(function (r) { return r.id; }), { kind: g.kind, party: g.party, bucket: g.bucket });
        else if (m.length === 1) putOnTrace(m);
      });
    }
    /** A tick box for these transactions (one row, or every member of a group): ticked when all are, half-ticked when some are. */
    function tickBox(ids, label) {
      var cb = el('input', { type: 'checkbox', 'class': 'rowtick', 'aria-label': label });
      cb.addEventListener('change', function () { ids.forEach(function (id) { if (cb.checked) V.ticked.add(id); else V.ticked.delete(id); }); syncTicks(); });
      tickers.push({ cb: cb, ids: ids });
      return cb;
    }
    /** The ticked rows that are in the list right now (a tick on a row the filter hides does not count until it is listed again). */
    function picked() { return rows.filter(function (r) { return V.ticked.has(r.id) && wantSet.has(r.id); }); }
    function clearTicks(list) { list.forEach(function (r) { V.ticked.delete(r.id); }); }
    function syncTicks() {
      tickers.forEach(function (t) {
        var on = t.ids.filter(function (id) { return V.ticked.has(id); }).length;
        t.cb.checked = on > 0 && on === t.ids.length; t.cb.indeterminate = on > 0 && on < t.ids.length;
      });
      if (!bar) return;
      var list = picked(), k = list.length;
      pickInfo.textContent = k ? k + ' ticked' : 'Tick rows to act on several at once';
      pickActs.textContent = '';
      if (!k) return;
      function btn(text, title, fn, off) { return el('button', { type: 'button', text: text, title: title, disabled: off ? 'disabled' : null, onclick: fn }); }
      if (traceOn() && state.trace.shown.has(n.id)) {
        var fresh = list.filter(canPut);
        pickActs.appendChild(btn('Show on graph (' + fresh.length + ')', fresh.length ? 'Put these transactions on the trace' : 'They are all on the trace already',
          function () { clearTicks(fresh); putOnTrace(fresh); }, !fresh.length));
        pickActs.appendChild(btn('As one vertex', fresh.length > 1 ? 'Put these on the trace as ONE vertex (it can be opened later)' : 'Needs at least two that are not on the trace yet',
          function () { clearTicks(fresh); putAsGroup({ kind: 'picked', party: null }, fresh); }, fresh.length < 2));
      } else if (!traceOn()) {
        var off = list.filter(canShow);
        pickActs.appendChild(btn('Show on graph (' + k + ')', off.length ? plural(off.length, 'of these is', 'of these are') + ' not on screen: ' + (off.length === 1 ? 'it is' : 'they are') + ' brought in (shown again if you hid ' + (off.length === 1 ? 'it' : 'them') + ', or the Focus view is switched off), and the view moves to take them in'
                                                                  : 'They are all on screen: the view moves to take them in',
          function () { showOnGraph(list.map(function (r) { return r.id; })); }, false));
        pickActs.appendChild(btn('Select on graph', 'Select these transactions on the graph (the ones that are on screen)', function () { selectIds(list.map(function (r) { return r.id; }), 'the ticked transactions'); }, false));
      }
      pickActs.appendChild(btn('Copy ids', 'One transaction id per line', function () { copy(list.map(function (r) { return r.txid; }).join(NL), plural(k, 'transaction id')); }, false));
      pickActs.appendChild(btn('Clear', 'Untick everything', function () { clearTicks(list); syncTicks(); }, false));
    }
    function rowEl(r) {
      var fx = fiatOf(r.amount, r.time), parties = r.dir === 'self' ? { names: [] } : r.party;
      var who = partiesText(parties, 'itself');
      var tag = el('span', { 'class': 'dirtag ' + r.dir, text: DIR_TAG[r.dir],
                             title: r.dir === 'in' ? 'Money came in' + (r.mixed ? ' (the wallet also spent in this transaction; net shown)' : '') : r.dir === 'out' ? 'Money went out' + (r.mixed ? ' (some came back to the wallet as change; net shown)' : '') : 'Moved within the wallet' });
      var kids = [tag, el('span', { 'class': 'who' }, [who ? (r.dir === 'in' ? 'from ' : r.dir === 'out' ? 'to ' : '') + who : S.shortId(r.txid, 6), who ? el('small', { text: S.shortId(r.txid, 6) }) : r.unloaded ? el('small', { text: 'no details yet' }) : null])];
      if (r.time != null) kids.push(el('span', { 'class': 'when', text: S.fmtTime(r.time, false) }));
      kids.push(el('span', { 'class': 'amt', text: (r.dir === 'in' ? '+' : r.dir === 'out' ? '−' : '') + mixText(S.fmtBtc(r.amount) + ' BTC', fx) }));
      var line = el('button', { type: 'button', 'class': 'linkrow ' + r.dir, title: r.id + (fx ? ' · ' + fx.text : ''), onclick: function () { navigate(r.id); } }, kids);
      var parts = [tickBox([r.id], 'Tick this transaction'), line];
      if (canPut(r)) parts.push(el('button', { type: 'button', 'class': 'showbtn', text: '+ show', title: 'Put this transaction on the trace', onclick: function (ev) { ev.stopPropagation(); putOnTrace([r]); } }));
      else if (canShow(r)) parts.push(el('button', { type: 'button', 'class': 'showbtn', text: '+ show', title: 'Bring this transaction onto the graph (shown again if you hid it, or the Focus view is switched off)', onclick: function (ev) { ev.stopPropagation(); showOnGraph([r.id]); } }));
      parts.push(copyBtn(r.txid, 'transaction id'));
      var wrap = el('div', { 'class': 'rowcopy tickable' + (onTrace(r) ? '' : ' off') }, parts);
      wrap.addEventListener('mouseenter', function () { if (renderer) renderer.setHighlight(r.id); });
      wrap.addEventListener('mouseleave', function () { if (renderer) renderer.setHighlight(null); });
      return wrap;
    }
    function groupEl(g) {
      var st = g.stats, open = V.open.has(g.key), sign = g.dir === 'in' ? '+' : g.dir === 'out' ? '−' : '';
      var what = groupWhat(g, 'transaction', st);
      var range = dateRange(st.first, st.last, ' → ');
      var each = S.fmtBtc(st.min) + ' to ' + S.fmtBtc(st.max) + ' BTC each';
      var head = el('button', { type: 'button', 'class': 'linkrow groupbtn ' + g.dir, 'aria-expanded': String(open), title: each + '. Click to ' + (open ? 'fold them' : 'list them'),
                                onclick: function () { if (V.open.has(g.key)) V.open.delete(g.key); else V.open.add(g.key); draw(); } },
        [el('span', { 'class': 'dirtag ' + g.dir, text: DIR_TAG[g.dir] }), el('span', { 'class': 'who' }, [(open ? '▾ ' : '▸ ') + what, el('small', { text: each })]),
         el('span', { 'class': 'when', text: range }), el('span', { 'class': 'amt', text: sign + S.fmtBtc(st.total) + ' BTC' })]);
      var wrap = el('div', { 'class': 'groupwrap' + (open ? ' open' : '') }, [el('div', { 'class': 'rowcopy tickable' }, [tickBox(g.members.map(function (r) { return r.id; }), 'Tick all ' + st.count + ' in this group'), head, copyBtn(g.members.map(function (r) { return r.txid; }).join(NL), plural(st.count, 'transaction id'))])]);
      var off = g.members.filter(canPut);
      if (off.length) {                                                                // in a trace: the biggest few, or all of them, without opening the group
        var largest = off.slice().sort(function (a, b) { return b.amount - a.amount; }).slice(0, state.stepSize), acts = [el('span', { 'class': 'hint', text: 'On the trace:' })];
        if (off.length > largest.length) acts.push(el('button', { type: 'button', 'class': 'showbtn', text: '+ largest ' + largest.length, title: 'Put the largest ' + largest.length + ' of them on the trace', onclick: function () { putOnTrace(largest); } }));
        acts.push(el('button', { type: 'button', 'class': 'showbtn', text: '+ all ' + off.length, title: 'Put all of them on the trace', onclick: function () { putOnTrace(off); } }));
        if (off.length > 1) acts.push(el('button', { type: 'button', 'class': 'showbtn', text: '◼ as one', title: 'Put them on the trace as ONE vertex (it can be opened later)', onclick: function () { putAsGroup(g, off); } }));
        wrap.appendChild(el('div', { 'class': 'groupacts' }, acts));
      }
      if (open) {
        var cap = V.groupMore[g.key] || 40, list = el('div', { 'class': 'groupmembers' });
        g.members.slice(0, cap).forEach(function (r) { list.appendChild(rowEl(r)); });
        if (g.members.length > cap) list.appendChild(el('button', { type: 'button', 'class': 'moreRows', text: 'Show ' + Math.min(40, g.members.length - cap) + ' more', onclick: function () { V.groupMore[g.key] = cap + 40; draw(); } }));
        wrap.appendChild(list);
      }
      return wrap;
    }
    function draw() {
      if (renderer) renderer.setHighlight(null);
      box.textContent = ''; tickers = [];
      var inDir = rows.filter(function (r) { return V.dir === 'all' || r.dir === V.dir; });
      var want = inDir.filter(matches);
      want.sort(orderFn(V.sort));
      wantSet = new Set(want.map(function (r) { return r.id; }));
      box.appendChild(el('span', { 'class': 'lbl', text: 'Transactions (' + rows.length + ')' }));
      box.appendChild(el('div', { 'class': 'walletsum', title: 'Per transaction: what the wallet received minus what it spent in it, so change that came back is netted off' },
        ['↓ in ', el('span', { 'class': 'strong', text: S.fmtBtc(total(inRows)) + ' BTC' }), ' (' + inRows.length + ')  ·  ↑ out ', el('span', { 'class': 'strong', text: S.fmtBtc(total(outRows)) + ' BTC' }), ' (' + outRows.length + ')']));
      var seg = el('div', { 'class': 'seg walletseg', role: 'radiogroup', 'aria-label': 'Which transactions' }, [['all', 'All ' + rows.length], ['in', '↓ In ' + inRows.length], ['out', '↑ Out ' + outRows.length]].map(function (x) {
        return el('button', { type: 'button', role: 'radio', 'data-dir': x[0], 'aria-checked': String(V.dir === x[0]), text: x[1], onclick: function () { V.dir = x[0]; V.more = 40; draw(); } });
      }));
      var sortSel = el('select', { 'aria-label': 'Order', title: 'Order' }, [el('option', { value: 'new', text: 'Newest first' }), el('option', { value: 'old', text: 'Oldest first' }), el('option', { value: 'big', text: 'Largest first' }),
                                                                              el('option', { value: 'small', text: 'Smallest first' }), el('option', { value: 'known', text: 'Known or labelled first' })]);
      sortSel.value = V.sort; sortSel.addEventListener('change', function () { V.sort = sortSel.value; draw(); });
      box.appendChild(el('div', { 'class': 'walletbar' }, [seg, sortSel]));
      var whoSel = el('select', { 'aria-label': 'Which wallets', title: 'Known = on the built-in list or a label list you loaded (exchanges, services); labelled = a label or tag you gave it. This looks at the wallet on the other side of each transaction.' },
                      [el('option', { value: 'any', text: 'any wallet' }), el('option', { value: 'skip', text: 'skip known services' }), el('option', { value: 'only', text: 'only known or labelled' })]);
      whoSel.value = V.who; whoSel.addEventListener('change', function () { V.who = whoSel.value; V.more = 40; draw(); });
      var unspChk = el('input', { type: 'checkbox', 'aria-label': 'Unspent only' }); unspChk.checked = V.unspent;
      unspChk.addEventListener('change', function () { V.unspent = unspChk.checked; V.more = 40; draw(); });
      var unknownSpend = V.unspent ? inDir.filter(function (r) { return r.recv > 0 && r.unspent === null; }).length : 0;                    // loading what spent them (Spenders) tells
      var cutInfo = want.length < inDir.length ? el('span', { 'class': 'hint', text: want.length + ' of ' + inDir.length + ' listed' + (unknownSpend ? ' · ' + plural(unknownSpend, 'payment') + ' with no spend information left out' : '') }) : null;
      box.appendChild(el('div', { 'class': 'walletfilters' }, [el('label', {}, ['show ', whoSel]),
                                                               canUnspent ? el('label', { 'class': 'unspentopt', title: 'Only transactions where this wallet was paid and has not spent that money yet. It is known where the spending transaction is loaded, or where the transactions were opened one by one: a payment with no information is left out.' }, [unspChk, ' unspent only']) : null, cutInfo]));
      var chk = el('input', { type: 'checkbox', 'aria-label': 'Group similar rows' });
      chk.checked = state.groupRows;
      chk.addEventListener('change', function () { state.groupRows = chk.checked; $('groupRows').checked = chk.checked; savePrefs(); draw(); });
      box.appendChild(el('div', { 'class': 'walletgroup' }, [el('label', { 'class': 'check', title: 'Fold rows that look alike into one line: the same wallet on the other side three times or more, or small amounts (the limit is under Expansion limits), or the same month, week, day or year' }, [chk, ' Group similar rows']), groupBySelect(draw)]));
      var master = tickBox(want.map(function (r) { return r.id; }), 'Tick every listed transaction (' + want.length + ')');
      pickInfo = el('span', { 'class': 'pickcount' }); pickActs = el('span', { 'class': 'pickacts' });
      bar = el('div', { 'class': 'walletpick' }, [el('label', { title: 'Tick or untick every listed transaction, including the ones inside a group' }, [master, ' all listed']), pickInfo, pickActs]);
      box.appendChild(bar);
      var items = state.groupRows ? GR.layout(want, GR.make(want, { minSize: 3, dustSats: state.dustSats, by: state.groupBy })) : want.map(function (r) { return { type: 'row', row: r }; });
      var list = el('div', { 'class': 'linkrows' });
      items.slice(0, V.more).forEach(function (it) { list.appendChild(it.type === 'row' ? rowEl(it.row) : groupEl(it.group)); });
      if (items.length > V.more) list.appendChild(el('button', { type: 'button', 'class': 'moreRows', text: 'Show ' + Math.min(40, items.length - V.more) + ' more (' + (items.length - V.more) + ' not listed)', onclick: function () { V.more += 40; draw(); } }));
      if (!items.length) list.appendChild(el('div', { 'class': 'hint', text: 'None of these.' }));
      box.appendChild(list);
      if (n.type === 'addr' && !n.histDone && (n.histNext || n.txCount == null)) {                              // there is more of this wallet's history than is listed
        box.appendChild(el('div', { 'class': 'moreHistory' }, [
          el('button', { type: 'button', 'class': 'loadmore', text: 'Load more history', title: 'Fetch the next ' + plural(state.capPages * 25, 'transaction') + ' of this wallet', onclick: function () { loadMoreHistory(n.id); } }),
          el('span', { 'class': 'hint', text: n.txCount != null ? fmtInt(n.txCount) + ' on chain, ' + plural(rows.length, 'transaction') + ' listed' : 'its history may not be fully loaded' })]));
      }
      syncTicks();
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
    return el('button', { type: 'button', 'class': 'danger', text: ids.length > 1 ? 'Delete ' + ids.length + ' from workspace' : 'Delete from workspace',
                          title: ids.length > 1 ? 'Deletes them from the workspace (Hide only takes them off the screen); Undo load in the top bar brings them back' : 'Deletes it from the workspace (Hide only takes it off the screen); Undo load in the top bar brings it back', onclick: function () { deleteIds(ids); } });
  }
  /** In a trace the button above only hides; this one deletes (in the other layouts removeBtn already does). */
  function deleteBtn(ids) {
    if (!traceOn()) return null;
    return el('button', { type: 'button', 'class': 'danger', text: ids.length > 1 ? 'Delete ' + ids.length + ' from workspace' : 'Delete from workspace',
                          title: ids.length > 1 ? 'Deletes them from the workspace (Hide only takes them off the screen); Undo load in the top bar brings them back' : 'Deletes it from the workspace (Hide only takes it off the screen); Undo load in the top bar brings it back', onclick: function () { deleteIds(ids); } });
  }

  /** The details of a selected group vertex: what it stands for, and how to show some or all of it. */
  /** Your label, tag, colour and notes for a group vertex: kept with the group in the trace (and the saved session), never written into the graph. */
  function groupAnnotateBox(gid) {
    var T = state.trace;
    function spec() { return T.groups.get(gid); }
    var lab = el('input', { type: 'text', id: 'fLabel', maxlength: '120', placeholder: 'Your label (shown on the graph)' });
    var note = el('textarea', { id: 'fNote', maxlength: '4000', placeholder: 'Notes' });
    lab.value = spec().label || ''; note.value = spec().note || '';
    function apply() {
      var g = spec(); if (!g) return;
      var l = LB.cleanText(lab.value, 120), nt = String(note.value).slice(0, 4000);
      if (l) g.label = l; else delete g.label;
      if (nt) g.note = nt; else delete g.note;
      refresh(); scheduleSave();
    }
    lab.addEventListener('input', apply); note.addEventListener('input', apply);
    return el('div', { 'class': 'insp-section' }, [el('label', { 'for': 'fLabel', 'class': 'lbl', text: 'Label' }), lab, tagControls([gid], function (id) { return T.groups.get(id); }),
                                                  el('label', { 'for': 'fNote', 'class': 'lbl', text: 'Notes' }), note]);
  }

  function showGroup(gid, box) {
    var T = state.trace, grp = T.groups.get(gid), gn = groupNodeOf(gid), g = state.graph;
    if (!grp || !gn) { $('inspector').hidden = true; return; }
    var anchor = g.nodes.get(grp.anchor), rows = groupRows(grp), st = GR.stats(rows), N = state.stepSize;
    var noun = anchor.type === 'addr' ? 'transaction' : grp.dir === 'next' ? 'output' : 'input';
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: 'Group' }), el('span', { text: gn.groupText })]));
    box.appendChild(groupAnnotateBox(gid));
    var dl = el('dl', { 'class': 'kv' });
    kv(dl, 'Stands for', plural(st.count, noun) + ', not shown yet');
    kv(dl, 'Total', S.fmtBtc(st.total) + ' BTC');
    kv(dl, 'Each', S.fmtBtc(st.min) + ' to ' + S.fmtBtc(st.max) + ' BTC');
    kv(dl, 'Dates', dateRange(st.first, st.last));
    kv(dl, grp.dir === 'next' ? (anchor.type === 'addr' ? 'Spent from' : 'Outputs of') : (anchor.type === 'addr' ? 'Paid' : 'Inputs of'), focusLabel(grp.anchor));
    if (grp.kind === 'party' && grp.party) kv(dl, grp.dir === 'prev' ? 'Paid by' : 'Paid to', focusLabel(grp.party));
    if (grp.kind === 'time' && grp.bucket) kv(dl, 'Period', GR.bucketLabel(grp.bucket) + ' (UTC)');
    box.appendChild(dl);
    var acts = [];
    if (rows.length > N) acts.push(el('button', { type: 'button', text: 'Show the largest ' + N, title: 'Put the largest ' + N + ' on the trace; the rest stay in the group', onclick: function () { traceExpandGroup(gid, { limit: N }); } }));
    acts.push(el('button', { type: 'button', text: 'Show all ' + rows.length, title: 'Put every one of them on the trace', onclick: function () { traceExpandGroup(gid, {}); } }));
    if (rows.length > 2) acts.push(el('button', { type: 'button', text: 'Choose which…', onclick: function (ev) { var r = ev.currentTarget.getBoundingClientRect(); traceChoose(grp.anchor, grp.dir, { x: r.left, y: r.bottom + 4 }, { group: gid }); } }));
    box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
    box.appendChild(el('div', { 'class': 'insp-actions' }, [
      el('button', { type: 'button', text: 'Copy ' + plural(rows.length, anchor.type === 'addr' ? 'transaction id' : 'address', anchor.type === 'addr' ? undefined : 'addresses'), title: 'One per line', onclick: function () { copy(rows.map(function (r) { return plainId(r.id); }).join(NL), plural(rows.length, anchor.type === 'addr' ? 'transaction id' : 'address', anchor.type === 'addr' ? undefined : 'addresses')); } }),
      el('button', { type: 'button', text: 'Hide group', title: 'Take the group off the screen; what is in it stays hidden (Ctrl+Z brings it back)', onclick: function () { traceHideIds([gid]); } })]));
    var cap = (state.groupCap && state.groupCap[gid]) || 40, list = el('div', { 'class': 'linkrows' });
    rows.slice(0, cap).forEach(function (r) {
      var kids = [el('span', { 'class': 'who' }, [focusLabel(r.id)])];
      if (r.time != null) kids.push(el('span', { 'class': 'when', text: S.fmtTime(r.time, false) }));
      kids.push(el('span', { 'class': 'amt', text: S.fmtBtc(r.amount) + ' BTC' }));
      list.appendChild(el('div', { 'class': 'rowcopy' }, [el('div', { 'class': 'linkrow plain', title: r.id }, kids),
        el('button', { type: 'button', 'class': 'showbtn', text: '+ show', title: 'Put just this one on the trace', onclick: function () { traceExpandGroup(gid, { ids: [r.id] }); } }),
        copyBtn(plainId(r.id), r.type === 'tx' ? 'transaction id' : 'address')]));
    });
    if (rows.length > cap) list.appendChild(el('button', { type: 'button', 'class': 'moreRows', text: 'Show ' + Math.min(40, rows.length - cap) + ' more (' + (rows.length - cap) + ' not listed)',
      onclick: function () { state.groupCap = state.groupCap || {}; state.groupCap[gid] = cap + 40; showInspector(); } }));
    box.appendChild(el('div', { 'class': 'insp-section walletsec groupmembers' }, [el('span', { 'class': 'lbl', text: 'In this group (' + rows.length + ')' }), list]));
  }

  function renderInspector(soft) {
    var box = $('inspBody'), insp = $('inspector'), g = state.graph, view = syncRightPanel();
    if (view === 'none') { insp.hidden = true; return; }
    if (view === 'findings') { insp.hidden = false; return; }
    if (soft && box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && state.selected.size === 1) return;   // user is typing
    box.textContent = '';
    var gsel = traceOn() ? Array.from(state.selected).filter(function (id) { return state.trace.groups.has(id); }) : [];
    if (gsel.length === 1 && state.selected.size === 1) { insp.hidden = false; return showGroup(gsel[0], box); }
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
      box.appendChild(el('div', { 'class': 'insp-actions' }, [hideBtn(ids), removeBtn(ids), deleteBtn(ids),
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
      if (lockedToTime(n.id)) box.appendChild(el('p', { 'class': 'hint movehint', text: MOVE_HINT }));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [focusBtn(n), refBtn(n)]));
      var ta = traceActions(n); if (ta) box.appendChild(ta);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Spenders →', title: 'Load the transactions that spent its outputs', onclick: function () { expandNode(n.id, 'forward'); } }),
        el('button', { type: 'button', text: '← Funding', title: 'Load the transactions it spends from', onclick: function () { expandNode(n.id, 'backward'); } }),
        el('button', { type: 'button', text: '↔ Both', onclick: function () { expandNode(n.id, 'both'); } })
      ]));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Copy txid', onclick: function () { copy(n.txid); } }), extLink('/tx/' + n.txid, 'Open in explorer ↗'), arkhamLink(n), hideBtn([n.id]), removeBtn([n.id]), deleteBtn([n.id])
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
        if (known.sanctions) tags.appendChild(el('span', { 'class': 'tag danger', text: 'on a sanctions list: ' + LB.claimsOf(known).filter(function (c) { return c.sanctions; }).map(function (c) { return c.pack; }).join(', ') }));
        if (known.note) tags.appendChild(el('p', { 'class': 'hint', text: known.note }));
        if (known.url && LB.cleanUrl(known.url)) tags.appendChild(el('a', { href: known.url, target: '_blank', rel: 'noopener noreferrer', text: 'source ↗' }));
        box.appendChild(tags);
        var claims = LB.claimsOf(known);
        if (claims.length > 1) {                                                         // a wallet on two lists: every claim, with its own source, category and note
          var cl = el('div', { 'class': 'insp-section claims' }, [el('span', { 'class': 'lbl', text: 'Listed by ' + claims.length + ' sources' })]);
          claims.forEach(function (c) {
            var row = el('p', { 'class': 'hint' }, [el('b', { text: c.label }), ' · ' + (c.pack || 'built-in list') + (c.category ? ' · ' + c.category : '') + (c.sanctions ? ' · sanctions list' : '')]);
            if (c.note) row.appendChild(el('span', { 'class': 'claimnote', text: ' ' + c.note }));
            if (c.url && LB.cleanUrl(c.url)) { row.appendChild(document.createTextNode(' ')); row.appendChild(el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', text: 'source ↗' })); }
            cl.appendChild(row);
          });
          box.appendChild(cl);
        }
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
                  el('button', { type: 'button', text: 'Copy address', onclick: function () { copy(n.address); } }), extLink('/address/' + n.address, 'Open in explorer ↗'), arkhamLink(n),
                  el('a', { href: 'wallet.html?q=' + encodeURIComponent(n.address), target: '_blank', rel: 'noopener', title: 'This wallet as a ledger: every transaction with its inputs and outputs', text: 'Wallet overview ↗' }), hideBtn([n.id]), removeBtn([n.id]), deleteBtn([n.id])];
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
      box.appendChild(el('div', { 'class': 'insp-actions' }, [hideBtn([n.id]), removeBtn([n.id]), deleteBtn([n.id])]));
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
  // ---- full screen: the graph alone ----------------------------------------------------------
  var fullScr = { on: false };
  /**
   * Hide everything but the graph (the top bar, the left panel, the trail, the activity log) and ask the browser for real full screen.
   * Where the browser refuses (some embedded views) the page is still cleared, and Esc or the same button brings everything back.
   * The details panel is left alone: it only shows while something is selected, and D folds it away.
   */
  function setFullScreen(on) {
    on = !!on; if (on === fullScr.on) return;
    fullScr.on = on;
    document.body.classList.toggle('canvas-full', on);
    if (!on) setFullSide(false);
    var b = $('fullBtn'); b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
    b.title = on ? 'Leave full screen (M or Esc)' : 'Full screen (M): the graph alone. Its Controls button (or C) opens the left panel over it. Esc or this button leaves it.';
    var de = document.documentElement;
    try {
      if (on) { var rq = de.requestFullscreen || de.webkitRequestFullscreen; var p = rq && rq.call(de); if (p && p.catch) p.catch(function () { /* the page is cleared anyway */ }); }
      else if (document.fullscreenElement || document.webkitFullscreenElement) { var ex = document.exitFullscreen || document.webkitExitFullscreen; var q = ex && ex.call(document); if (q && q.catch) q.catch(function () { /* already out */ }); }
    } catch (e) { /* no full screen API: the cleared page is what there is */ }
    renderer.resize(); if (renderer.autoFit) renderer.fit(); drawHistogram();
  }
  /** In full screen the left panel (Controls) is a drawer over the graph: it opens from its button or C, and Esc closes it before it leaves full screen. */
  function fullSideOpen() { return document.body.classList.contains('full-side-open'); }
  function setFullSide(open) {
    open = !!open && fullScr.on;
    if (open === fullSideOpen()) return;
    var hadFocus = $('side').contains(document.activeElement);
    document.body.classList.toggle('full-side-open', open);
    $('fullControls').setAttribute('aria-expanded', String(open));
    if (open) { var first = $('side').querySelector('summary, button, input, select'); if (first) first.focus(); }
    else if (hadFocus) $('fullControls').focus();
  }
  function wireFullScreen() {
    $('fullBtn').addEventListener('click', function () { setFullScreen(!fullScr.on); });
    $('fullControls').addEventListener('click', function () { setFullSide(!fullSideOpen()); });
    $('side').addEventListener('keydown', function (e) { if (e.key === 'Escape' && fullSideOpen()) { e.preventDefault(); e.stopPropagation(); setFullSide(false); } });       // also from inside a field of the drawer
    function left() { if (fullScr.on && !document.fullscreenElement && !document.webkitFullscreenElement) setFullScreen(false); }       // the browser's own Esc or F11 ended it
    document.addEventListener('fullscreenchange', left); document.addEventListener('webkitfullscreenchange', left);
  }

  /** The tab that brings the details back: only while they are collapsed and something is selected. */
  function updateInspTab() {
    var has = !$('inspector').hidden, tab = $('inspTab');
    tab.hidden = !(state.inspCollapsed && has);
    if (!tab.hidden) {
      var id = Array.from(state.selected)[0], n = id && state.graph.nodes.get(id), fv = rightView() === 'findings';
      $('inspTabText').textContent = fv ? 'Findings (' + state.findTotal + ')' : state.selected.size > 1 ? state.selected.size + ' selected' : n ? focusLabel(id) : 'Details';
      tab.title = fv ? 'Show the findings (D)' : 'Show details (D)';
    }
  }

  function showEdge(e) {
    var box = $('inspBody'), g = state.graph, dl = el('dl', { 'class': 'kv' });
    var txn = g.nodes.get(e.kind === 'out' ? e.source : e.target);
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: e.kind === 'out' ? 'Output' : 'Input' })]));
    var par = parallelEdges(e);
    if (par.length > 1) { var tot = par.reduce(function (s, x) { return s + (x.amount || 0); }, 0); kv(dl, e.kind === 'out' ? 'Outputs on this arrow' : 'Inputs on this arrow', par.length + ' · ' + S.fmtBtc(tot) + ' BTC in all'); }
    kvf(dl, par.length > 1 ? 'This coin' : 'Amount', S.fmtBtc(e.amount) + ' BTC (' + fmtInt(e.amount) + ' sat)', fiatOfEdge(e));
    kv(dl, 'Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
    kv(dl, 'Transaction', S.shortId(e.txid, 8));
    if (e.kind === 'out') {
      kv(dl, 'Spent', e.spent === true ? 'yes' : e.spent === false ? 'no (unspent so far)' : 'unknown');
      if (e.spentBy) kv(dl, 'Spent by', S.shortId(e.spentBy.txid, 8));
    }
    box.appendChild(dl);
    if (par.length > 1) box.appendChild(parallelList(e, par));
    var acts = [];
    if (txn) acts.push(el('button', { type: 'button', text: 'Select transaction', onclick: function () { selectOnly(txn.id); } }));
    acts.push(el('button', { type: 'button', text: 'Copy txid', onclick: function () { copy(e.txid, 'the transaction id'); } }));
    if (e.spentBy) acts.push(el('button', { type: 'button', text: 'Copy spender txid', onclick: function () { copy(e.spentBy.txid, 'the spender\'s transaction id'); } }));
    if (e.spentBy && g.nodes.has(ID.tx(e.spentBy.txid))) acts.push(el('button', { type: 'button', text: 'Select spender', onclick: function () { selectOnly(ID.tx(e.spentBy.txid)); } }));
    box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
  }

  /** Delete vertices from the workspace (Hide only takes them off the screen). One step in Undo load, offered in the message. */
  function deleteIds(ids) {
    var real = ids.filter(function (id) { return state.graph.nodes.has(id); });
    if (!real.length) { toast('Select a wallet or a transaction to delete.', true); return; }
    removeIds(real);
    toast('Deleted ' + plural(real.length, 'vertex', 'vertices') + ' from the workspace.', false, { text: 'Undo', fn: undoLoad });
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
      var n = g.nodes.get(nodeId) || groupNodeOf(nodeId); if (!n) { tip.hidden = true; return; }
      if (n.type === 'tx') {
        line('Transaction', S.shortId(n.txid, 10)); line('Time', n.time != null ? S.fmtTimeFull(n.time) : (n.confirmed === false ? 'unconfirmed' : 'unknown'));
        if (n.loaded) { line('Value', mixText(S.fmtBtc(n.valueOut) + ' BTC', fiatOf(n.valueOut, n.time)) + ' · ' + n.nIn + ' in / ' + n.nOut + ' out'); } else line('', 'Not loaded: double-click to load');
        var ar = n.loaded ? analysis().tx.get(n.id) : null;
        if (ar && ar.flags.length) line('Pattern', ar.flags.map(function (f) { return f.short; }).join(', '));
        if (ar && ar.change && AN.rank(ar.change.confidence) >= 2) line(AN.changeTitle(ar.change.confidence), 'output ' + ar.change.vout + ' (' + ar.change.confidence + ' confidence)');
      } else if (n.type === 'addr') {
        line('Address', S.shortId(n.address, 12)); if (KNOWN[n.address]) line('Known', KNOWN[n.address].label);
        line('Type', n.scriptType); line('Received', mixText(S.fmtBtc(n.received) + ' BTC', fiatSum(n, true))); line('First seen', n.firstSeen != null ? S.fmtTime(n.firstSeen) : null);
        var cl = analysis().clusters.byAddr.get(n.id); if (cl) line('Cluster', cl.label + ' · ' + cl.size + ' addresses spent together');
      } else if (n.type === 'data') { line('OP_RETURN', n.dataText || (n.dataHex ? n.dataHex.slice(0, 48) + (n.dataHex.length > 48 ? '…' : '') : 'empty')); }
      else if (n.type === 'coinbase') line('Coinbase', 'newly created coins');
      else if (n.type === 'group') {
        line('Group', n.groupText); line('Total', S.fmtBtc(n.received) + ' BTC'); line('Each', S.fmtBtc(n.min) + ' to ' + S.fmtBtc(n.max) + ' BTC'); line('Dates', dateRange(n.firstSeen, n.lastSeen));
        line('', 'Double-click: show the largest ' + state.stepSize + '. Click for the details.');
      }
      else line('Non-standard output', n.scriptType);
      if (n.label) line('Label', n.label);
      if (n.note) line('Note', n.note.length > 140 ? n.note.slice(0, 140) + '…' : n.note);
    } else {
      var e = g.edges.get(edgeId); if (!e) { tip.hidden = true; return; }
      var par = parallelEdges(e);
      if (par.length > 1) { var tot = par.reduce(function (s, x) { return s + (x.amount || 0); }, 0); line(e.kind === 'out' ? 'Outputs' : 'Inputs', par.length + ' coins · ' + mixText(S.fmtBtc(tot) + ' BTC', fiatOfEdge(Object.assign({}, e, { amount: tot }))) + ' in all (click for the list)'); }
      else line(e.kind === 'out' ? 'Output' : 'Input', mixText(S.fmtBtc(e.amount) + ' BTC', fiatOfEdge(e))); line('Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
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
    Object.assign(KNOWN, LB.buildKnown(KNOWN_BASE, state.packs.concat(PK.active(state.shipped, state.packs))));
    state.knownVersion++;
  }
  function savePacks() {
    var text = JSON.stringify(state.packs.map(function (p) { return { id: p.id, name: p.name, source: p.source, enabled: p.enabled, sanctions: p.sanctions === true ? true : undefined, licence: p.licence || undefined, attribution: p.attribution || undefined, asOf: p.asOf || undefined, sourceUrl: p.sourceUrl || undefined, entries: p.entries.map(function (e) { return [e.address, e.label, e.category, e.url, e.note]; }) }; }));
    state.packs.forEach(function (p) { p.stored = true; });
    if (text.length > PACK_STORE_LIMIT || !store.set(PACKS_KEY, text)) {
      store.del(PACKS_KEY); state.packs.forEach(function (p) { p.stored = false; });
      if (state.packs.length) log('The label packs are too large to keep in this browser: they stay until the page is closed.', true);
    }
  }
  function loadPacks() {
    var raw = store.get(PACKS_KEY); if (!raw) return;
    state.packs = LB.parseStored(raw);
    rebuildKnown();
  }
  function packMatches(p) {
    var k = 0;
    state.graph.nodes.forEach(function (n) { if (n.type === 'addr' && p.entries.length && p.index && p.index.has(n.address)) k++; });
    return k;
  }
  // The packs that come with the site (packs/index.js): switched on or off here, the choice kept with the other preferences. The OFAC list ships switched on.
  function initShipped() {
    state.shipped = PK.cleanIndex(window.HOPLINE_PACK_INDEX).map(function (e) {
      return Object.assign({}, e, { count: e.entries, entries: [], enabled: PK.isOn(e, state.shippedChoices), loaded: false, loading: false, failed: '', index: null });
    });
    state.shipped.forEach(function (p) { if (p.enabled) loadShipped(p); });
  }
  function loadShipped(p) {
    if (p.loaded || p.loading) return;
    p.loading = true; p.failed = '';
    PK.load(p, window).then(function (r) {
      p.entries = r.entries; p.index = new Set(r.entries.map(function (e) { return e.address; }));
      p.sanctions = r.sanctions === true; p.asOf = r.asOf || p.asOf; p.loaded = true; p.loading = false;
      rebuildKnown(); renderShipped(); refresh(); showInspector(true);
    }, function (e) {
      p.loading = false; p.failed = 'could not be loaded';
      renderShipped();
      toast('The built-in list "' + p.name + '" could not be loaded (' + (e && e.message ? e.message : 'error') + ')' + (p.sanctions ? ', so a wallet on it is not marked as sanctioned.' : '.'), true);
    });
  }
  function setShipped(p, on) {
    p.enabled = on; state.shippedChoices[p.id] = on; savePrefs();
    if (on) loadShipped(p);
    rebuildKnown(); renderShipped(); refresh(); showInspector(true);
  }
  // The rows of both lists are made once and then only updated, never replaced: a row that is redrawn takes away the checkbox someone is pointing at or has the keyboard focus on, and a row that
  // changes size moves what is under it.
  function packRow(box, id) { return box.querySelector('[data-id="' + id + '"]'); }
  function shippedNote(p) {
    var bits = [fmtInt(p.loaded ? p.entries.length : p.count) + ' wallets'], hits = p.loaded ? packMatches(p) : 0, stale = PK.staleness(p.asOf, Date.now());
    if (p.sanctions) bits.push('sanctions list');
    if (p.asOf) bits.push('as of ' + p.asOf);
    if (stale) bits.push(stale);
    if (p.licence) bits.push(p.licence);
    if (hits) bits.push(hits + ' on screen or loaded');
    if (p.failed) bits.push(p.failed + (p.sanctions ? ': a wallet on it is not marked' : ''));
    if (PK.shadowed(p, state.packs)) bits.push('your imported pack of the same name is used instead');
    return bits.join(' · ');
  }
  function renderShipped() {
    var box = $('shippedList');
    $('shippedSec').hidden = !state.shipped.length;
    state.shipped.forEach(function (p) {
      var row = packRow(box, p.id);
      if (!row) {
        var cb = el('input', { type: 'checkbox', 'aria-label': 'Use ' + p.name });
        cb.addEventListener('change', function () { setShipped(p, cb.checked); });
        row = el('div', { 'class': 'packrow', 'data-id': p.id }, [cb, el('span', { 'class': 'packname' }, [p.name, el('small')]),
          p.sourceUrl ? el('a', { href: p.sourceUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Where this list comes from', text: 'source ↗' }) : null]);
        box.appendChild(row);
      }
      var cb2 = row.querySelector('input');
      if (cb2.checked !== p.enabled) cb2.checked = p.enabled;
      row.className = 'packrow' + (p.loading ? ' loading' : '');
      if (p.loading) row.setAttribute('aria-busy', 'true'); else row.removeAttribute('aria-busy');
      row.querySelector('.packname').title = [p.source, p.attribution ? 'Credit: ' + p.attribution : '', p.licence ? 'Licence: ' + p.licence : ''].filter(Boolean).join(NL);
      var note = shippedNote(p), small = row.querySelector('small');
      if (small.textContent !== note) small.textContent = note;
    });
  }
  function packNote(p) {
    var hits = packMatches(p);
    return fmtInt(p.entries.length) + ' wallets' + (p.sanctions ? ' · sanctions list' : '') + (hits ? ' · ' + hits + ' on screen or loaded' : '') + (p.stored === false ? ' · not kept in this browser' : '');
  }
  function renderPacks() {
    renderShipped();
    var box = $('packList'), ids = state.packs.map(function (p) { return p.id; });
    Array.prototype.slice.call(box.children).forEach(function (r) { if (ids.indexOf(r.getAttribute('data-id')) < 0) box.removeChild(r); });         // a pack that was removed or replaced
    state.packs.forEach(function (p) {
      if (!p.index) p.index = new Set(p.entries.map(function (e) { return e.address; }));
      var row = packRow(box, p.id);
      if (!row) {
        var cb = el('input', { type: 'checkbox', 'aria-label': 'Use ' + p.name });
        cb.addEventListener('change', function () { p.enabled = cb.checked; rebuildKnown(); savePacks(); renderPacks(); refresh(); showInspector(true); });
        row = el('div', { 'class': 'packrow', 'data-id': p.id }, [cb, el('span', { 'class': 'packname', title: p.source || p.name }, [p.name, el('small')]),
          el('button', { type: 'button', title: 'Remove this pack', 'aria-label': 'Remove ' + p.name, onclick: function () { removePack(p.id); }, text: '×' })]);
        box.appendChild(row);                                          // a new pack goes last, as it does in the list in memory
      }
      var cb2 = row.querySelector('input');
      if (cb2.checked !== p.enabled) cb2.checked = p.enabled;
      var note = packNote(p), small = row.querySelector('small');
      if (small.textContent !== note) small.textContent = note;
    });
    $('packHint').textContent = state.packs.length ? '' : 'No packs imported yet.';
  }
  function removePack(id) {
    state.packs = state.packs.filter(function (p) { return p.id !== id; });
    rebuildKnown(); savePacks(); renderPacks(); refresh(); showInspector(true);
  }
  function importPack(text, filename, note) {
    var r;
    try { r = LB.parse(text, String(filename || 'Imported labels').replace(/\.(csv|json|txt)$/i, '')); } catch (e) { toast('Import failed: ' + e.message, true); return; }
    var replaced = state.packs.filter(function (p) { return p.name === r.name; }).length;
    state.packs = state.packs.filter(function (p) { return p.name !== r.name; }).slice(0, 19);
    var pack = { id: 'p' + Date.now().toString(36), name: r.name, source: r.source, enabled: true, sanctions: r.sanctions === true, licence: r.licence, attribution: r.attribution, asOf: r.asOf, sourceUrl: r.sourceUrl, entries: r.entries, stored: true, index: new Set(r.entries.map(function (e) { return e.address; })) };
    state.packs.push(pack); stat('labels-imported');
    rebuildKnown(); savePacks(); renderPacks(); refresh(); showInspector(true);
    var s = r.skipped, left = [];
    if (s.invalid) left.push(s.invalid + ' failed the address checksum');
    if (s.otherChain) left.push(s.otherChain + ' were not Bitcoin addresses');
    if (s.duplicate) left.push(s.duplicate + ' repeated');
    if (s.empty) left.push(s.empty + ' had no label');
    toast((replaced ? 'Replaced the pack "' + r.name + '": ' : 'Imported ') + fmtInt(r.entries.length) + ' labelled wallets' + (packMatches(pack) ? ', ' + packMatches(pack) + ' of them already in the workspace' : '') + '.'
      + (left.length ? ' Left out: ' + left.join(', ') + '.' : '') + (r.truncated ? ' Stopped at ' + fmtInt(LB.MAX_ENTRIES) + ' entries.' : '') + (note && note.text ? ' ' + note.text : ''), (!!left.length && !r.entries.length) || !!(note && note.warn));
    if (note && note.text) log(note.text);
  }
  /** OFAC's SDN list (SDN_XML.ZIP or SDN.XML): read here, in the browser, into a pack, then imported like any other. */
  function importOfac(f) {
    toast('Reading the OFAC list…');
    f.arrayBuffer().then(function (buf) { return OF.convertFile(buf); }).then(function (r) {
      var i = r.info, txt = 'OFAC list dated ' + (i.date || 'unknown') + ': ' + fmtInt(r.pack.labels.length) + (r.pack.labels.length === 1 ? ' Bitcoin address' : ' Bitcoin addresses') + ' from ' + fmtInt(i.withAddress) + ' of its ' + fmtInt(i.entries) + ' entries.' + (i.warning ? ' Warning: ' + i.warning : '');
      importPack(JSON.stringify(r.pack), r.pack.name, { text: txt, warn: !!i.warning });
    }).catch(function (e) { toast('Import failed: ' + (e && e.message ? e.message : 'the file could not be read') + '', true); });
  }
  function exportOwnLabels(kind) {
    var entries = LB.fromGraph(state.graph);
    if (!entries.length) { toast('Nothing to export: label or tag a wallet first (its details panel).', true); return; }
    var name = 'hopline-labels-' + stamp();
    if (kind === 'json') download(name + '.json', LB.toJson(entries, { name: 'Hopline labels ' + stamp(), source: 'exported from Hopline' }), 'application/json');
    else download(name + '.csv', '\ufeff' + LB.toCsv(entries), 'text/csv;charset=utf-8');
    log('Exported ' + entries.length + ' labelled wallets (' + kind + ')');
  }

  // ---- analysis: patterns, likely change, clusters ----------------------------------------------
  // All of it is a guess from what is loaded; every result carries its reasons (see hopline-analysis.js).
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
    if (!r || !r.flags.length) return null;
    var out = [];
    r.flags.forEach(function (f) { if (state.analysis.kinds[f.kind] !== false) out.push({ text: f.short, color: f.color, kind: f.kind, chain: f.kind === 'peel' && r.chain ? r.chain.label : '' }); });
    return out.length ? out : null;
  }
  function clusterColorOf(cl) { return CLUSTER_COLORS[(parseInt(cl.label.slice(1), 10) - 1) % CLUSTER_COLORS.length]; }
  function clusterColor(id) { var cl = state.an ? state.an.clusters.byAddr.get(id) : null; return cl ? clusterColorOf(cl) : null; }
  function changeEdgeMark(e) { return e.kind === 'out' && state.an && state.an.changeEdges.has(e.id) ? AN.COLORS.change : null; }

  /** Select the given vertices that are on screen, and say so when some are not. */
  function selectIds(ids, what) {
    var vis = renderer.data ? renderer.data.visible.nodes : null;
    var show = vis ? ids.filter(function (id) { return vis.has(id); }) : ids.slice();
    if (!show.length) { toast('None of the ' + what + ' is on screen (the layout or a filter hides them).'); return; }
    state.selected = new Set(show); state.selectedEdge = null; holdRight++; syncSelection(); holdRight--; renderer.ensureVisible(show); renderer.pulse(show);
    if (show.length < ids.length) toast(show.length + ' of ' + ids.length + ' ' + what + ' are on screen; the rest are hidden by the layout or a filter.');
  }
  function setNoCluster(txId, on) {
    var n = state.graph.nodes.get(txId); if (!n) return;
    if (on) n.noCluster = true; else delete n.noCluster;
    showInspector(); refresh(); scheduleSave();
  }

  // ---- detections: every pattern found, oldest first ------------------------------------------------
  var DET_ROWS = 400;                                                                   // rows drawn at once; Select these and Copy list still take all of them
  var DET_KINDS = [['all', 'All'], ['peel', 'PEEL'], ['consolidation', 'CONSOL'], ['batch', 'BATCH'], ['coinjoin', 'COINJOIN?']];
  var det = { kind: 'all', chain: '', data: null, an: null, graph: null, rows: [] };
  function detOpenNow() { return $('detSection').open; }
  /** The detections of the current analysis; built again only when the analysis was. */
  function detData() {
    var an = analysis();
    if (det.an !== an || det.graph !== state.graph) { det.data = DT.build(state.graph, an, { fmt: function (s) { return S.fmtBtc(s) + ' BTC'; } }); det.an = an; det.graph = state.graph; }
    return det.data;
  }
  function detRefresh() {
    var d = state.graph.nodes.size ? detData() : { rows: [], chains: [], counts: { total: 0 } };
    $('detCount').textContent = d.counts.total ? '(' + d.counts.total + ')' : '';
    if (detOpenNow()) detRender(d);
  }
  function detRender(d) {
    d = d || (state.graph.nodes.size ? detData() : { rows: [], chains: [], counts: { total: 0 } });
    if (det.kind !== 'all' && !d.counts[det.kind]) det.kind = 'all';
    if (det.chain && !d.chains.some(function (c) { return c.label === det.chain; })) det.chain = '';
    var kinds = $('detKinds'), sel = $('detChain'), list = $('detList');
    kinds.textContent = '';
    DET_KINDS.forEach(function (k) {
      var n = k[0] === 'all' ? d.counts.total : d.counts[k[0]] || 0;
      if (k[0] !== 'all' && !n) return;
      kinds.appendChild(el('button', { type: 'button', 'aria-pressed': det.kind === k[0] ? 'true' : 'false', text: k[1] + ' ' + n, title: k[0] === 'all' ? 'Every pattern' : 'Only ' + k[1],
                                       onclick: function () { det.kind = k[0]; if (k[0] !== 'all' && k[0] !== 'peel') det.chain = ''; detRender(); } }));
    });
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: d.chains.length ? 'All peel chains (' + d.chains.length + ')' : 'No peel chains' }));
    d.chains.forEach(function (c) { sel.appendChild(el('option', { value: c.label, text: c.label + ' · ' + plural(c.n, 'transaction') + ' · from ' + S.fmtTime(c.firstTime, false) })); });
    sel.value = det.chain; sel.disabled = !d.chains.length;
    var rows = DT.pick(d.rows, { kind: det.kind, chain: det.chain }), ids = [];
    det.rows = rows; rows.forEach(function (r) { if (ids.indexOf(r.id) < 0) ids.push(r.id); });
    list.textContent = '';
    rows.slice(0, DET_ROWS).forEach(function (r) {
      var tag = el('span', { 'class': 'flagtag', text: r.short + (r.chain ? ' · ' + r.chain : '') }); tag.style.color = r.color;
      var b = el('button', { type: 'button', 'class': 'detrow' + (state.selected.has(r.id) ? ' on' : ''), 'data-id': r.id, title: 'Select it and bring it into view', onclick: function () { findKeep(r.id); } }, [
        el('span', { 'class': 'dethead' }, [el('span', { 'class': 'dettime', text: S.fmtTime(r.time) }), el('span', { 'class': 'dettx mono', text: S.shortId(r.txid, 5) })]),
        el('span', { 'class': 'detwhy' }, [tag, r.reason])
      ]);
      list.appendChild(withCopy(b, r.txid, 'transaction id'));
    });
    $('detSelectAll').textContent = 'Select these' + (ids.length ? ' ' + ids.length : ''); $('detSelectAll').disabled = !ids.length;
    $('detCopy').disabled = !rows.length; syncChainButtons();
    $('detFoot').textContent = !d.counts.total ? (state.graph.nodes.size ? 'Nothing notable in what is loaded.' : 'Load transactions to look for patterns.')
      : rows.length > DET_ROWS ? 'The first ' + DET_ROWS + ' of ' + rows.length + ' are listed: narrow the list with the buttons above, or copy it to get them all.'
      : plural(rows.length, 'detection') + '. These are shapes ordinary wallets also produce; none of them proves anything.';
  }
  /** Mark the rows of the vertices that are selected. */
  function detMarkSel() {
    if (!detOpenNow()) return;
    Array.prototype.forEach.call($('detList').querySelectorAll('.detrow'), function (b) { b.classList.toggle('on', state.selected.has(b.getAttribute('data-id'))); });
  }
  /** Open the list (optionally already narrowed to one kind) and bring it into view. */
  function detShow(kind) {
    if (kind) { det.kind = kind; if (kind !== 'peel') det.chain = ''; }
    $('detSection').open = true; detRender();
    $('detSection').scrollIntoView({ block: 'nearest' });
  }
  function wireDetections() {
    $('detSection').addEventListener('toggle', function () { if (this.open) detRender(); });
    $('detShowChain').addEventListener('click', function () { if (det.chain) toggleChain(det.chain); });
    $('detTraceChain').addEventListener('click', function () { if (det.chain) traceChain(det.chain); });
    $('chainChipClear').addEventListener('click', clearChain);
    $('detChain').addEventListener('change', function () { det.chain = this.value; if (det.chain) det.kind = 'peel'; detRender(); });
    $('detSelectAll').addEventListener('click', function () { var ids = []; det.rows.forEach(function (r) { if (ids.indexOf(r.id) < 0) ids.push(r.id); }); selectIds(ids, 'detections'); });
    $('detCopy').addEventListener('click', function () { copy(DT.toText(det.rows, function (t) { return t == null ? '' : S.fmtTime(t); }), 'the list of ' + plural(det.rows.length, 'detection')); });
    $('detList').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var rows = Array.prototype.slice.call(this.querySelectorAll('.detrow')), i = rows.indexOf(document.activeElement);
      if (i < 0) return; e.preventDefault();
      var t = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (t) t.focus();
    });
  }

  // ---- a peel chain on the canvas ----------------------------------------------------------------
  function chainByLabel(label) {
    var cs = analysis().chains;
    for (var i = 0; i < cs.length; i++) if (cs[i].label === label) return cs[i];
    return null;
  }
  function chainView(ch) {
    var index = new Map(); ch.ids.forEach(function (id, i) { index.set(id, i + 1); });
    return { label: ch.label, color: ch.color, ids: ch.ids.slice(), index: index, path: new Set(ch.path), pay: new Set(ch.pay) };
  }
  /** Give the canvas the chain that is lit (or none). A chain that is gone (deleted, another workspace) clears itself. */
  function applyChain() {
    var ch = state.chainFocus ? chainByLabel(state.chainFocus) : null;
    if (state.chainFocus && !ch) state.chainFocus = null;
    renderer.setChain(ch ? chainView(ch) : null);
    var chip = $('chainChip'); chip.hidden = !ch;
    if (ch) {
      $('chainChipName').textContent = ch.label; $('chainChipName').style.color = ch.color;
      $('chainChipText').textContent = plural(ch.ids.length, 'transaction') + ' · peeled ' + S.fmtBtc(ch.totalPeeled) + ' BTC';
    }
    syncChainButtons();
  }
  function syncChainButtons() {
    var acts = $('detChainActs'), on = !!state.chainFocus && det.chain === state.chainFocus;
    acts.hidden = !det.chain;
    $('detShowChain').setAttribute('aria-pressed', on ? 'true' : 'false'); $('detShowChain').textContent = on ? 'Clear the highlight' : 'Show on graph';
  }
  function showChain(label) {
    var ch = chainByLabel(label); if (!ch) return;
    state.chainFocus = label; applyChain();
    var vis = renderer.data ? renderer.data.visible.nodes : null, on = vis ? ch.ids.filter(function (id) { return vis.has(id); }) : ch.ids;
    if (on.length) renderer.frame(on);
    if (on.length < ch.ids.length) toast((on.length ? 'Only ' + on.length + ' of the ' + ch.ids.length + ' steps are on screen' : 'None of its ' + ch.ids.length + ' steps is on screen')
      + (traceOn() ? ': Trace this chain shows them all.' : ': the Focus view, a filter or the time bar hides the others.'), !on.length);
  }
  function clearChain() { state.chainFocus = null; applyChain(); }
  function toggleChain(label) { if (state.chainFocus === label) clearChain(); else showChain(label); }
  /** The Trace layout with just this chain: its first step is the starting point and the other steps are revealed in order (Undo takes it back in two steps: the reveal, then the restart). */
  function traceChain(label) {
    var ch = chainByLabel(label); if (!ch) return Promise.resolve(false);
    var first = ch.ids[0];
    if (state.trace.seed) traceRestart(first); else traceStart(first);
    if (!traceOn()) setLayout('trace');
    state.chainFocus = label; state.selected = new Set([first]); syncSelection(); traceChanged(null, true);
    return autoExpand(first, { dir: 'next', follow: 'peel', hops: ch.ids.length }).then(function (ok) {            // one more than the steps after the first: the last step's own outputs show too
      applyChain(); var vis = renderer.data ? renderer.data.visible.nodes : null;
      renderer.frame(vis ? ch.ids.filter(function (id) { return vis.has(id); }) : ch.ids);
      return ok;
    });
  }
  /** In the details of a step: the steps either side, the chain on the graph, the chain as a trace, and carrying on. */
  function chainActions(id, c) {
    var ch = chainByLabel(c.label); if (!ch) return null;
    var on = state.chainFocus === c.label, row = [];
    if (c.step > 1) row.push(el('button', { type: 'button', text: '◀ Step ' + (c.step - 1), title: 'Go to the previous step of ' + c.label, onclick: function () { findGo(ch.ids[c.step - 2]); } }));
    if (c.step < c.of) row.push(el('button', { type: 'button', text: 'Step ' + (c.step + 1) + ' ▶', title: 'Go to the next step of ' + c.label, onclick: function () { findGo(ch.ids[c.step]); } }));
    row.push(el('button', { type: 'button', text: on ? 'Clear the highlight' : 'Show the chain', title: 'Light up ' + c.label + ' on the graph, number its steps and fade the rest',
                            onclick: function () { toggleChain(c.label); showInspector(); } }));
    row.push(el('button', { type: 'button', text: 'Trace this chain', title: 'Show only this chain in the Trace layout, step by step', onclick: function () { traceChain(c.label); } }));
    row.push(el('button', { type: 'button', text: 'Follow ▶▶', title: 'Auto-expand forward from this step along the large output only (the peel rule)', onclick: function () { autoExpand(id, { dir: 'next', follow: 'peel' }); } }));
    return el('div', { 'class': 'insp-actions' }, row);
  }

  // ---- assistant: the evidence for an AI assistant, an optional model on this computer, and a check of what it answers ----------------------
  var DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/v1';
  function cleanAssist(a) {
    a = a && typeof a === 'object' ? a : {};
    return { endpoint: typeof a.endpoint === 'string' && a.endpoint ? a.endpoint.slice(0, 300) : DEFAULT_ENDPOINT,
             model: typeof a.model === 'string' ? a.model.replace(/[^\w.:\/@+\-]/g, '').slice(0, 100) : '', rows: num(a.rows, 5, 400, 60) };
  }
  var ai = { busy: null, focus: null };                                                  // busy: the controller of a question in flight
  function assistKnown(a) { var k = KNOWN[a]; return k ? { label: k.label, category: k.category, source: k.pack || k.source || 'built-in list', sanctions: k.sanctions === true, alsoListedAs: k.alt || [] } : null; }
  function assistSummary() { return AS.summary(state.graph, analysis(), { generated: new Date().toISOString(), title: LB.cleanText($('reportTitle').value, 120), known: assistKnown }); }

  /** The prompt for the chosen task, or null (with a message) when it cannot be made. */
  function assistPrompt() {
    if (!state.graph.nodes.size) { toast('Nothing is loaded yet.', true); return null; }
    var task = $('aiTask').value, focus = null;
    if (task === 'explain') {
      var sel = Array.from(state.selected)[0];
      if (!sel) { toast('Select a transaction or a wallet first: that is what the assistant is asked to explain.', true); return null; }
      focus = AS.focus(state.graph, analysis(), plainId(sel), { known: assistKnown });
      if (!focus) { toast('Select a transaction or a wallet: that is what the assistant can be asked to explain.', true); return null; }
    }
    var p;
    try { p = AS.prompt(assistSummary(), task, { maxRows: state.assist.rows, focus: focus }); } catch (e) { toast(e.message, true); return null; }
    ai.focus = focus;
    $('aiSize').textContent = 'About ' + p.tokens.toLocaleString() + ' tokens: ' + plural(p.shown.patterns, 'pattern row') + ', ' + plural(p.shown.peelChains, 'peel chain') + ', ' + plural(p.shown.clusters, 'cluster') + ', ' + plural(p.shown.wallets, 'noted wallet') + '.'
      + (p.tokens > 3500 ? ' That is more than many local models read by default: lower the pattern rows, or raise the context window of the model.' : '');
    return p;
  }

  function aiNoteSet(text, bad) { var n = $('aiNote'); n.textContent = text; n.className = 'hint' + (bad ? ' bad' : ''); }
  function syncAssistUi() {
    var ep = AS.localEndpoint(state.assist.endpoint);
    if (document.activeElement !== $('aiEndpoint')) $('aiEndpoint').value = state.assist.endpoint;
    if (document.activeElement !== $('aiModel')) $('aiModel').value = state.assist.model;
    if (document.activeElement !== $('aiRows')) $('aiRows').value = state.assist.rows;
    $('aiRowsOut').textContent = state.assist.rows;
    $('aiEndpoint').setAttribute('aria-invalid', ep.ok ? 'false' : 'true'); $('aiEndpoint').title = ep.ok ? '' : ep.error;
    $('aiAsk').textContent = ai.busy ? 'Cancel' : 'Ask the local model';
    $('aiAsk').disabled = !ai.busy && (!ep.ok || !state.assist.model);
    $('aiAsk').title = ai.busy ? 'Stop waiting for the model' : !ep.ok ? ep.error : !state.assist.model ? 'Name the model under Local model first' : 'Send the instructions and the evidence to the model on this computer';
    $('aiTest').disabled = !ep.ok;
  }

  function aiCopyPrompt() {
    var p = assistPrompt(); if (!p) return;
    copy(p.text, 'the prompt for an assistant (about ' + p.tokens.toLocaleString() + ' tokens)');
  }

  /** A failed request to the model, in words: it was stopped, it could not be reached, or the server said no. */
  function aiErrorText(e, base) {
    if (e && e.name === 'AbortError') return 'Stopped: no answer was received.';
    if (e && e.name === 'TypeError') return 'Could not reach the model at ' + base + '. Is the server running? If it is, the browser may have blocked the request: allow this page\'s address in the server (for Ollama, set OLLAMA_ORIGINS).';
    return e && e.message ? e.message : 'The question failed.';
  }

  function aiAsk() {
    if (ai.busy) { ai.busy.abort(); return; }                                              // while a question is out the button says Cancel
    var ep = AS.localEndpoint(state.assist.endpoint);
    if (!ep.ok) { toast(ep.error, true); return; }
    if (!state.assist.model) { toast('Name the model to ask (for example llama3.1).', true); return; }
    var p = assistPrompt(); if (!p) return;
    var req; try { req = AS.chatRequest({ base: state.assist.endpoint, model: state.assist.model, system: p.system, user: p.user }); } catch (e) { toast(e.message, true); return; }
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 10 * 60 * 1000), model = state.assist.model;
    req.init.signal = ctl.signal; ai.busy = ctl; syncAssistUi();
    aiNoteSet('Asking ' + model + '… (about ' + p.tokens.toLocaleString() + ' tokens; a local model can take a few minutes)');
    log('Asked the local model ' + model + ' (' + p.task + ', about ' + p.tokens + ' tokens). It stayed on this computer.');
    fetch(req.url, req.init).then(function (r) {
      return r.text().then(function (body) {
        if (!r.ok) throw new Error('The model server answered ' + r.status + ': ' + AS.plainText(body, 200));
        return { text: AS.parseChat(body), cut: AS.chatFinish(body).truncated };
      });
    }).then(function (a) {
      $('aiText').value = a.cut ? a.text + '\n\n[Cut off: the model stopped before it finished.]' : a.text;                  // the marker travels with the text if it is copied
      aiNoteSet('Written by ' + model + ' at ' + new Date().toISOString().slice(11, 16) + ' UTC. It is a draft by a model, not evidence.' + (a.cut ? ' ' + AS.CUT_OFF : ''), a.cut);
      aiCheckNow();
    }, function (e) {
      aiNoteSet(aiErrorText(e, ep.base), !(e && e.name === 'AbortError'));
    }).then(function () { clearTimeout(timer); ai.busy = null; syncAssistUi(); });
  }

  function aiTest() {
    var ep = AS.localEndpoint(state.assist.endpoint);
    if (!ep.ok) { toast(ep.error, true); return; }
    aiNoteSet('Asking ' + ep.base + ' which models it has…');
    fetch(ep.base + '/models').then(function (r) {
      return r.text().then(function (body) {
        if (!r.ok) throw new Error('The server answered ' + r.status + '.');
        var d; try { d = JSON.parse(body); } catch (e) { throw new Error('The server did not send a list of models.'); }
        var names = (Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models : []).map(function (m) { return m && (m.id || m.name); }).filter(function (x) { return typeof x === 'string'; }).map(function (x) { return AS.plainText(x, 80); });
        if (!names.length) return aiNoteSet('Connected to ' + ep.base + ', but it lists no models.', true);
        var has = state.assist.model && names.indexOf(state.assist.model) >= 0;
        aiNoteSet('Connected. Models: ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' and ' + (names.length - 12) + ' more' : '') + '.' + (state.assist.model && !has ? ' "' + state.assist.model + '" is not among them.' : ''), !!state.assist.model && !has);
      });
    }).catch(function (e) { aiNoteSet(aiErrorText(e, ep.base), true); });
  }

  /** Compare every id in the answer box with the evidence and say which ones are not there. The text is shown as text only. */
  function aiCheckNow() {
    var text = $('aiText').value, box = $('aiResult'); box.textContent = '';
    if (!text.trim()) { box.appendChild(el('p', { 'class': 'hint', text: 'Paste an answer, or ask the model, then check the ids it cites.' })); return; }
    var r = AS.checkCitations(text, AS.idSets(assistSummary(), state.graph, ai.focus));
    var nTx = r.cited.txids.length, nAd = r.cited.addresses.length, bad = r.unknown.txids.length + r.unknown.addresses.length;
    if (bad) box.appendChild(el('p', { 'class': 'hint bad', text: plural(bad, 'id') + (bad === 1 ? ' is' : ' are') + ' NOT in this workspace: a model made up or garbled ' + (bad === 1 ? 'it' : 'them') + '. Do not use what is said about ' + (bad === 1 ? 'it' : 'them') + '.' }));
    else if (r.ok && nTx + nAd + r.abbreviated.length) box.appendChild(el('p', { 'class': 'hint ok', text: 'Every id it cites is in the workspace: ' + plural(nTx, 'transaction id') + ', ' + plural(nAd, 'address', 'addresses') + '.' }));
    else if (r.ok) box.appendChild(el('p', { 'class': 'hint bad', text: 'It cites no transaction id or address, so there is nothing here to check: treat it as unsupported.' }));
    r.unknown.txids.concat(r.unknown.addresses).slice(0, 20).forEach(function (id) { box.appendChild(idRow(id, 'the id that is not in the workspace')); });
    r.abbreviated.forEach(function (x) {
      if (x.id) box.appendChild(el('p', { 'class': 'hint', text: 'Shortened id ' + x.text + ' matches one transaction.' }));
      else box.appendChild(el('p', { 'class': 'hint bad', text: 'Shortened id ' + x.text + ' matches no single transaction.' }));
    });
    r.uncited.slice(0, 5).forEach(function (u) { box.appendChild(el('p', { 'class': 'hint', text: 'States an amount without citing an id: "' + u + '"' })); });
    var shown = r.cited.txids.map(function (c) { return { id: 'tx:' + c.id, where: c.where, text: S.shortId(c.id, 8) }; }).concat(r.cited.addresses.map(function (c) { return { id: 'addr:' + c.id, where: c.where, text: S.shortId(c.id, 8) }; }));
    if (shown.length) box.appendChild(el('span', { 'class': 'lbl', text: 'Cited (click to find it)' }));
    shown.slice(0, 30).forEach(function (c) {
      box.appendChild(el('button', { type: 'button', 'class': 'linkrow', title: 'Select it and bring it into view', onclick: function () { findGo(c.id); } },
                         [el('span', { 'class': 'mono', text: c.text }), el('span', { 'class': 'amt', text: c.where === 'evidence' ? 'in the evidence' : 'loaded, not in the evidence' })]));
    });
    box.appendChild(el('p', { 'class': 'hint', text: 'A model\'s text is not evidence. Check each claim against the transactions before it goes into a report.' }));
  }

  function wireAssistant() {
    $('aiCopy').addEventListener('click', aiCopyPrompt);
    $('aiAsk').addEventListener('click', aiAsk);
    $('aiTest').addEventListener('click', aiTest);
    $('aiCheck').addEventListener('click', aiCheckNow);
    $('aiCopyAnswer').addEventListener('click', function () { var t = $('aiText').value; if (t.trim()) copy(t, 'the answer'); else toast('There is no answer to copy.', true); });
    $('aiEndpoint').addEventListener('input', function () { state.assist.endpoint = this.value.slice(0, 300); savePrefs(); syncAssistUi(); });
    $('aiModel').addEventListener('input', function () { state.assist.model = cleanAssist({ model: this.value }).model; savePrefs(); syncAssistUi(); });
    $('aiRows').addEventListener('change', function () { state.assist.rows = num(this.value, 5, 400, 60); this.value = state.assist.rows; savePrefs(); syncAssistUi(); });
    $('aiRows').addEventListener('input', function () { $('aiRowsOut').textContent = this.value; });
    $('aiEndpoint').addEventListener('blur', function () { this.value = state.assist.endpoint; });
    $('aiModel').addEventListener('blur', function () { this.value = state.assist.model; });
  }

  /** The Analysis panel: what was found, as lists that select the vertices involved. */
  var findingsFor = null;
  // ---- what was found, in one strip over the graph ----------------------------------------------------------------------
  var FIND_NAME = { coinjoin: 'COINJOIN?', consolidation: 'CONSOL', batch: 'BATCH', peel: 'PEEL' };
  /**
   * The findings as chips, most important first: [{ key, text, count, ids, color, bad, what, title }]. They count what is loaded and found (the switches under Analysis only
   * decide what is drawn on the graph), and a click selects the vertices they count. Wallets on a sanctions list come first; known wallets are listed last and are not a finding.
   */
  function findingChips() {
    var an = analysis(), out = [], sanc = [], known = [], byKind = {};
    state.graph.nodes.forEach(function (n) {
      if (n.type !== 'addr' || !KNOWN[n.address]) return;
      known.push(n.id); if (KNOWN[n.address].sanctions) sanc.push(n.id);
    });
    function add(key, text, ids, color, what, title, bad) { if (ids.length) out.push({ key: key, text: text, count: ids.length, ids: ids, color: color, bad: !!bad, what: what, title: title }); }
    add('sanctions', 'Sanctions', sanc, '#ff4d4f', 'wallets on a sanctions list', 'Wallets on a sanctions list (a list\'s claim: open its source before relying on it). Click to select them.', true);
    {
      an.tx.forEach(function (r, id) { r.flags.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || { f: f, ids: [] }).ids.push(id); }); });
      ['coinjoin', 'consolidation', 'batch'].forEach(function (k) {
        if (byKind[k]) add(k, FIND_NAME[k], byKind[k].ids, byKind[k].f.color, FIND_NAME[k] + ' transactions', plural(byKind[k].ids.length, 'transaction') + ' flagged ' + FIND_NAME[k] + '. Click to select them.');
      });
      if (byKind.peel && an.chains.length) {
        var pids = []; an.chains.forEach(function (c) { c.ids.forEach(function (id) { if (pids.indexOf(id) < 0) pids.push(id); }); });
        var chainCount = an.chains.length;
        out.push({ key: 'peel', text: 'PEEL', count: chainCount, ids: pids, color: byKind.peel.f.color, bad: false, what: 'transactions of the possible peel chains',
                   title: plural(chainCount, 'possible peel chain') + ' (' + plural(pids.length, 'transaction') + '). Click to select them.' });
      }
    }
    {
      var caddrs = []; an.clusters.list.forEach(function (c) { c.addrs.forEach(function (a) { if (caddrs.indexOf(a) < 0) caddrs.push(a); }); });
      if (an.clusters.list.length) out.push({ key: 'clusters', text: 'Clusters', count: an.clusters.list.length, ids: caddrs, color: '#8fd3ff', bad: false, what: 'addresses spent together',
                                             title: plural(an.clusters.list.length, 'address cluster') + ' (wallets spent together, so probably one owner). Click to select their addresses.' });
    }
    {
      var chg = []; an.tx.forEach(function (r) { if (r.change && r.change.id) chg.push(r.change.id); });
      add('change', 'Change guesses', chg, AN.COLORS.change, 'outputs guessed to be change', plural(chg.length, 'output') + ' guessed to be change. These are guesses, not findings: follow both outputs. Click to select them.');
    }
    add('known', 'Known wallets', known, '#f2c94c', 'known wallets', plural(known.length, 'wallet') + ' on the built-in list or a label list (a name is a claim, not proof). Click to select them.');
    return out;
  }
  var findSig = null;
  function updateFindStrip() {
    var box = $('findStrip'), chips = state.graph.nodes.size ? findingChips() : [];
    var sig = chips.map(function (c) { return c.key + ':' + c.count; }).join('|');
    var total = 0; chips.forEach(function (c) { if (c.key !== 'known') total += c.count; });
    $('anCount').textContent = total ? '(' + total + ')' : ''; $('findCount').textContent = total ? '(' + total + ')' : '';
    var was = state.findTotal, forced = state.findForce; state.findTotal = total; if (!chips.length) state.findForce = false;
    if (was !== total || forced !== state.findForce) showInspector(true);                // the panel appears when there is something to show in it, and goes when there is not
    if (sig === findSig) return;
    findSig = sig; box.textContent = '';
    box.hidden = !chips.length;
    chips.forEach(function (c) {
      var dot = el('span', { 'class': 'dot' }); dot.style.background = c.color;
      box.appendChild(el('button', { type: 'button', 'class': 'findchip' + (c.bad ? ' bad' : ''), 'data-key': c.key, title: c.title, 'aria-label': c.count + ' ' + c.text + ': ' + c.title,
                                     onclick: function () { var now = findingChips().filter(function (x) { return x.key === c.key; })[0]; if (now) { selectIds(now.ids, now.what); openFindings(now.key); } } }, [dot, c.text, el('b', { text: String(c.count) })]));
    });
    if (chips.length) box.appendChild(el('button', { type: 'button', 'class': 'findchip more', 'data-key': 'details', title: 'Open the Findings panel on the right: every finding listed, and the Detections list', onclick: function () { openFindings(); }, text: 'Findings ▸' }));
  }
  // ---- the right-hand panel: Details of what is selected, and Findings --------------------------------------------------------------------
  var holdRight = 0;                                                                     // while the Findings act on the graph (select, go to), a selection does not switch the panel to Details
  function detailsAvailable() {
    var g = state.graph;
    if (state.selected.size === 1 && traceOn() && state.trace.groups.has(Array.from(state.selected)[0])) return true;
    if (Array.from(state.selected).some(function (id) { return g.nodes.has(id); })) return true;
    return !!(state.selectedEdge && g.edges.has(state.selectedEdge));
  }
  function findingsAvailable() { return state.findTotal > 0 || state.findForce; }
  /** What the panel shows: 'details', 'findings' or 'none'. With both available it shows the tab last chosen. */
  function rightView() {
    var d = detailsAvailable(), f = findingsAvailable();
    if (d && f) return state.rightTab === 'findings' ? 'findings' : 'details';
    return d ? 'details' : f ? 'findings' : 'none';
  }
  function syncRightPanel() {
    var view = rightView(), both = detailsAvailable() && findingsAvailable();
    if (view !== 'none') state.rightTab = view;
    $('rpTabs').hidden = !both; $('findTitle').hidden = both;
    $('inspBody').hidden = view !== 'details'; $('findPane').hidden = view !== 'findings';
    ['Details', 'Findings'].forEach(function (name) {
      var on = (name === 'Details') === (view === 'details'), b = $('tab' + name);
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    });
    var n = state.selected.size; $('tabDetails').textContent = n > 1 ? 'Details · ' + n : 'Details';
    return view;
  }
  function setRightTab(tab) { state.rightTab = tab === 'findings' ? 'findings' : 'details'; showInspector(); }
  /** Show the Findings (from a chip, the left panel or a key): open the panel if it was folded, and bring one group of findings into view. */
  function openFindings(key) {
    state.findForce = true; state.rightTab = 'findings';
    if (state.inspCollapsed) setInspCollapsed(false);
    showInspector(true);
    var g = key ? $('anFindings').querySelector('[data-group="' + String(key).replace(/[^a-z]/g, '') + '"]') : null;      // the key is one of our own words
    if (g) { g.scrollIntoView({ block: 'start' }); g.classList.add('flash'); setTimeout(function () { g.classList.remove('flash'); }, 1600); }
    else $('inspector').scrollTop = 0;
  }
  /** Go to a vertex from the Findings: select it and bring it into view without the panel turning to Details. */
  function findKeep(id) { findGo(id, true); }

  function updateFindings() {
    updateFindStrip();
    var box = $('anFindings');
    if (!state.graph.nodes.size) { box.textContent = ''; findingsFor = null; detRefresh(); return; }
    var an = analysis(), byKind = {}, kinds, loaded = 0;
    if (findingsFor === an && box.firstChild) return;                       // nothing it shows has changed: leave the buttons alone (a replay refreshes many times a second)
    findingsFor = an; box.textContent = ''; detRefresh();
    state.graph.nodes.forEach(function (n) { if (n.type === 'tx' && n.loaded) loaded++; });
    an.tx.forEach(function (r, id) { r.flags.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || { f: f, ids: [] }).ids.push(id); }); });
    kinds = Object.keys(byKind);
    function row(left, amt, title, fn, copyText, copyWhat) { var b = el('button', { type: 'button', 'class': 'linkrow', title: title, onclick: fn }, [left, el('span', { 'class': 'amt', text: amt })]); return copyText ? withCopy(b, copyText, copyWhat) : b; }
    function more(list, shown) { if (list.length > shown) box.appendChild(el('div', { 'class': 'hint', text: '… and ' + (list.length - shown) + ' more' })); }
    function head(text, key) { return el('span', { 'class': 'lbl', text: text, 'data-group': key }); }
    function walletRow(n) {
      var k = KNOWN[n.address];
      return row(el('span', { 'class': 'rowtext' }, [k.label, el('small', { 'class': 'mono', text: S.shortId(n.address, 6) })]), k.pack || 'built-in list', 'Select it and bring it into view', function () { findKeep(n.id); });
    }
    var sanc = [], known = [];
    state.graph.nodes.forEach(function (n) { if (n.type === 'addr' && KNOWN[n.address]) { known.push(n); if (KNOWN[n.address].sanctions) sanc.push(n); } });
    if (sanc.length) {
      box.appendChild(head('Sanctions', 'sanctions'));
      sanc.slice(0, 30).forEach(function (n) { box.appendChild(walletRow(n)); }); more(sanc, 30);
      box.appendChild(el('p', { 'class': 'hint', text: 'A listing is that list\'s claim: select the wallet and open its source before relying on it.' }));
    }
    if (kinds.length) {
      box.appendChild(head('Patterns', 'patterns'));
      kinds.forEach(function (k) {
        var e = byKind[k], tag = el('span', { 'class': 'flagtag', text: FLAG_NAME[k] }); tag.style.color = e.f.color;
        var pr = row(tag, String(e.ids.length), 'Select these ' + e.ids.length + ' transactions', function () { holdRight++; selectIds(e.ids, FLAG_NAME[k] + ' transactions'); holdRight--; });
        pr.setAttribute('data-group', k); box.appendChild(pr);
      });
    }
    if (an.chains.length) {
      box.appendChild(head('Possible peel chains', 'peel'));
      an.chains.slice(0, 6).forEach(function (ch) {
        box.appendChild(row(el('span', { text: ch.label + ' · ' + ch.ids.length + ' transactions' }), 'peeled ' + S.fmtBtc(ch.totalPeeled), 'Select the ' + ch.ids.length + ' transactions of this chain', function () { selectIds(ch.ids, 'transactions of ' + ch.label); }, ch.ids.map(plainId).join(NL), plural(ch.ids.length, 'transaction id')));
      });
      if (an.chains.length > 6) box.appendChild(el('button', { type: 'button', 'class': 'linkrow', title: 'List every chain, oldest first, with the reason for each step',
                                                              onclick: function () { detShow('peel'); } }, [el('span', { text: 'All ' + an.chains.length + ' chains in the Detections list ▾' })]));
    }
    var cl = an.clusters.list;
    if (cl.length) {
      box.appendChild(head('Address clusters', 'clusters'));
      cl.slice(0, 6).forEach(function (c) {
        var sw = el('span', { 'class': 'sw' }); sw.style.color = clusterColorOf(c);
        box.appendChild(row(el('span', { 'class': 'rowtext' }, [sw, ' ' + c.label + ' · ' + c.size + ' addresses']), c.txs.length + ' tx', 'Select the addresses of this cluster (they were spent together in ' + c.txs.length + ' transaction' + (c.txs.length === 1 ? '' : 's') + ')', function () { selectIds(c.addrs, 'addresses of ' + c.label); }, c.addrs.map(plainId).join(NL), plural(c.addrs.length, 'address', 'addresses')));
      });
      more(cl, 6);
    }
    {
      var chg = []; an.tx.forEach(function (r, id) { if (r.change) chg.push({ id: id, c: r.change }); });
      if (chg.length) {
        box.appendChild(head('Change guesses', 'change'));
        chg.slice(0, 30).forEach(function (x) {
          box.appendChild(row(el('span', { 'class': 'rowtext' }, ['tx ', el('span', { 'class': 'mono', text: S.shortId(x.id.slice(3), 5) }), ' → output ' + x.c.vout]), x.c.confidence, 'Select the transaction and bring it into view: its details give the reasons', function () { findKeep(x.id); }));
        });
        more(chg, 30);
        box.appendChild(el('p', { 'class': 'hint', text: 'Guesses from the shape of each transaction, not findings: follow both outputs before relying on one.' }));
      }
    }
    if (known.length) {
      box.appendChild(head('Known wallets', 'known'));
      known.slice(0, 30).forEach(function (n) { box.appendChild(walletRow(n)); }); more(known, 30);
      box.appendChild(el('p', { 'class': 'hint', text: 'On the built-in list or a label list you loaded. A name is somebody\'s claim, not proof.' }));
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
      if (r.chain) s.appendChild(chainActions(n.id, r.chain));
      parts.push(s);
    }
    if (ch) {
      var s2 = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: AN.changeTitle(ch.confidence) })]);
      s2.appendChild(el('p', { 'class': 'hint' }, [el('b', { text: 'Output ' + ch.vout + (ch.address ? ' → ' + S.shortId(ch.address, 8) : '') }), ' · ' + amountText(ch.amount, n.time) + ' · ' + ch.confidence + ' confidence']));
      var ul = el('ul', { 'class': 'reasons' }); ch.reasons.forEach(function (x) { ul.appendChild(el('li', { text: x })); }); s2.appendChild(ul);
      s2.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Select that output', onclick: function () { selectIds([ch.id], 'outputs'); } }),
        el('button', { type: 'button', text: 'Follow the change ▶▶', title: 'Auto-expand forward along this output only', onclick: function () { autoExpand(n.id, { dir: 'next', follow: 'change' }); } })]));
      s2.appendChild(el('p', { 'class': 'hint', text: AN.changeCaution(ch) }));
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
    peel: 'Follows the large output of each transaction that has one input and two outputs, the small one at most half the large one and not dust-sized (under 1,000 satoshis), and stops at anything else. Forward only.'
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
    $('anKPeel').checked = state.analysis.kinds.peel; $('anKConsol').checked = state.analysis.kinds.consolidation; $('anKBatch').checked = state.analysis.kinds.batch; $('anKCoinjoin').checked = state.analysis.kinds.coinjoin; syncAssistUi();
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
    unfoldLog = [];
    w.levels.forEach(function (l) { l.forEach(function (t) { loadedAt.add(t); }); });
    function put(parentId, ids) {
      var fresh = []; ids.forEach(function (id) { if (g.nodes.has(id) && !T.shown.has(id) && fresh.indexOf(id) < 0) fresh.push(id); });
      if (!fresh.length) return;
      TR.place(T.pos, parentId, dir, { primary: fresh.map(function (id) { return { id: id }; }), secondary: [] }).forEach(function (p, id) { T.pos.set(id, p); });
      fresh.forEach(function (id) { traceUnfold(id); T.shown.add(id); T.prov.set(id, { via: parentId, dir: dir }); revealed.push(id); });
    }
    if (g.nodes.get(startId).type === 'addr') put(startId, (w.levels[0] || []).map(ID.tx));
    steps.forEach(function (st) {
      var tx = ID.tx(st.txid);
      if (!T.shown.has(tx)) return;
      put(tx, st.res.items.map(function (it) { return it.id; }));
      st.res.items.forEach(function (it) { if (it.followed && it.spender && loadedAt.has(it.spender)) put(it.id, [ID.tx(it.spender)]); });
    });
    revealed.unfolded = unfoldLog; unfoldLog = null;
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
    stat('auto-follow');
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
        if (rev.length) { traceRecord({ type: 'reveal', ids: rev.slice(), unfolded: rev.unfolded }); traceChanged(rev, false); shownNow = rev.length; msg += ' ' + plural(rev.length, 'vertex', 'vertices') + ' shown (Ctrl+Z takes them back).'; }
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
    var rg = state.graph, g = viewGraph(), f = state.filter;                  // g: the real graph plus the group vertices of a trace; rg: only what is on the chain
    edgeLabelCache.clear();
    renderer.fitPad = traceOn() ? 120 : 60;                                  // a trace needs room for the expand handles beside the outer vertices
    renderer.insets.bottom = state.focus && g.nodes.has(state.focus) && !traceOn() ? Math.max(84, $('stepbar').offsetHeight + 22) : 0;       // keep the graph clear of the step bar
    analysis();                                                              // the canvas hooks below read the cached result
    applyChain(); redoStillValid();
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
      T.groups.forEach(function (grp, gid) { if (g.nodes.has(gid) && T.pos.has(gid)) tpos.set(gid, { x: T.pos.get(gid).x, y: T.pos.get(gid).y }); });
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
    renderer.setData({ graph: g, visible: visible, style: style, known: KNOWN, lockX: lockedToTime, axis: timeScaleOn() && state.layoutRes ? state.layoutRes.axis : marksOn() ? { mode: 'marks' } : null,
                       range: { from: f.timeFrom, to: f.timeTo }, showLabels: state.showLabels, focusId: focusOpt() ? state.focus : null,
                       edgeLabel: state.edgeLabels ? edgeLabelFor : null, bundle: state.bundleEdges,
                       handles: traceOn() ? handlesFor : null, handleMore: traceOn() ? handleSummary : null, seedIds: traceOn() ? new Set(state.trace.seeds) : null, noDim: traceOn(), labelAll: traceOn(), nodeNote: traceOn() ? traceNote : null,
                       nodeFlags: state.analysis.flags ? nodeFlags : null, clusterColor: state.analysis.clusters ? clusterColor : null, edgeMark: state.analysis.change ? changeEdgeMark : null });
    document.body.classList.toggle('axis-on', usesAxis());
    if (o.fit) renderer.fit();
    var fo = focusOpt();
    if (traceOn() && state.trace.seed) $('counts').textContent = 'Trace from ' + focusLabel(state.trace.seed) + ' · ' + visible.nodes.size + ' shown · ' + Math.max(0, rg.nodes.size - (visible.nodes.size - state.trace.groups.size)) + ' more loaded';
    else $('counts').textContent = rg.nodes.size ? (fo ? 'Focus: ' + focusLabel(fo.id) + ' · depth ' + fo.hops + ' · ' : '') + visible.nodes.size + ' of ' + rg.nodes.size + ' vertices · ' + visible.edges.size + ' of ' + rg.edges.size + ' edges' : '';
    $('empty').hidden = rg.nodes.size > 0;
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
    if (state.analysis.change && state.an && state.an.changeEdges.size) box.appendChild(legendItem(AN.COLORS.change, 'amber edge = possible or likely change (a guess)'));
    if (traceOn() && state.trace.groups.size) box.appendChild(el('div', { 'class': 'item groupitem' }, [el('span', { 'class': 'tagsw', text: '▤' }), el('span', { text: 'Stack = several vertices folded into one group (click it to open them)' })]));
    var tags = TG.summarise(Array.from(state.graph.nodes.values()).concat(traceOn() ? Array.from(state.trace.groups.values()) : []));
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
    if (traceOn()) state.trace.groups.forEach(function (gr, gid) { if (gr.tag === tag) ids.push(gid); });
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
  // ---- a range for the arrows alone --------------------------------------------------------------
  // In the Trace layout, dragging across the time line chooses the stretch of time the arrows (and their lists) reach. It hides nothing:
  // the time bar's own window is the one that filters. A click without a drag still selects the transactions under it.
  var tbDrag = null;                                                                       // { x0, x1, moved } while the pointer is down on the time line
  function timeFromX(x, w) { var b = state.tb; return Math.round(b.min + Math.max(0, Math.min(1, (x - TB_PAD) / (w - 2 * TB_PAD))) * (b.max - b.min)); }
  function cleanRange(r) {
    if (!r || typeof r !== 'object' || typeof r.from !== 'number' || typeof r.to !== 'number' || !isFinite(r.from) || !isFinite(r.to) || r.from >= r.to) return null;
    return { from: Math.round(r.from), to: Math.round(r.to) };
  }
  function syncExpandChip() {
    var r = state.expandRange, chip = $('expandChip');
    chip.hidden = !r;
    if (r) $('expandChipText').textContent = 'Arrows reach ' + S.fmtTime(r.from, false) + ' → ' + S.fmtTime(r.to, false);
  }
  function setExpandRange(from, to) {
    var b = state.tb, span = b && b.max != null ? b.max - b.min : 0;
    if (!span || to - from < Math.max(1, span / 150)) return;                                // a wobble of the hand, not a range
    state.expandRange = cleanRange({ from: Math.max(b.min, from), to: Math.min(b.max, to) });
    syncExpandChip(); drawHistogram(); refresh(); showInspector(true); scheduleSave();
  }
  function clearExpandRange() {
    if (!state.expandRange) return;
    state.expandRange = null; syncExpandChip(); drawHistogram(); refresh(); showInspector(true); scheduleSave();
  }
  /** The words for the window the arrows are held to: the time bar's, or the stretch you dragged. */
  function rangeWhat() { return state.expandRange ? 'the range you drew on the time line' : 'the time bar\'s range'; }
  function onTimeDown(e) {
    if (e.button !== 0 || !traceOn() || !timebarEnabled() || !state.tbGeom) return;
    var r = $('hist').getBoundingClientRect();
    tbDrag = { x0: e.clientX - r.left, x1: e.clientX - r.left, moved: false };
    try { $('hist').setPointerCapture(e.pointerId); } catch (x) { /* the drag still works while the pointer stays over the line */ }
  }
  function onTimeUp(e) {
    if (!tbDrag) return;
    var d = tbDrag, w = state.tbGeom ? state.tbGeom.w : 0; tbDrag = null;
    try { $('hist').releasePointerCapture(e.pointerId); } catch (x) { /* not held */ }
    if (!d.moved) { drawHistogram(); return; }
    state.tbSuppress = true; setTimeout(function () { state.tbSuppress = false; }, 0);      // the click that follows a drag is not a selection
    if (w) setExpandRange(timeFromX(Math.min(d.x0, d.x1), w), timeFromX(Math.max(d.x0, d.x1), w));
    else drawHistogram();
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
    var band = tbDrag && tbDrag.moved ? { from: timeFromX(Math.min(tbDrag.x0, tbDrag.x1), w), to: timeFromX(Math.max(tbDrag.x0, tbDrag.x1), w) } : state.expandRange;
    if (band) {                                                                   // the stretch of time the arrows reach (amber: the time bar's own window is the blue one)
      var bx0 = timeX(band.from, w), bx1 = timeX(band.to, w), bwid = Math.max(2, bx1 - bx0);
      ctx.fillStyle = 'rgba(255,179,71,0.20)'; ctx.fillRect(bx0, 0, bwid, barsH + 4);
      ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 1.5; ctx.strokeRect(bx0 + 0.5, 0.5, bwid, barsH + 3);
    }
    ctx.strokeStyle = 'rgba(242,242,242,0.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(TB_PAD, barsH + 0.5); ctx.lineTo(w - TB_PAD, barsH + 0.5); ctx.stroke();
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
    var r = $('hist').getBoundingClientRect(), x = e.clientX - r.left;
    if (tbDrag) {
      tbDrag.x1 = x;
      if (!tbDrag.moved && Math.abs(tbDrag.x1 - tbDrag.x0) > 5) { tbDrag.moved = true; $('tooltip').hidden = true; }
      if (tbDrag.moved) { state.tbHover = null; drawHistogram(); return; }
    }
    state.tbHover = { x: x }; drawHistogram(); showTimeTip(e);
  }
  function onTimeLeave() { state.tbHover = null; $('tooltip').hidden = true; drawHistogram(); }
  function onTimeClick(e) {
    if (state.tbSuppress) { state.tbSuppress = false; return; }
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
    stopPlay(); state.filter.timeFrom = null; state.filter.timeTo = null; state.expandRange = null; syncExpandChip();
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
      if (c) traceStart(c);
      else if (state.graph.nodes.size) { toast('Open a transaction or a wallet first, then switch to Trace.', true); return; }       // with nothing loaded the trace simply waits: what you open next starts it
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
  function viewState() { return { sizeBy: state.sizeBy, trace: traceData(), arrange: state.arrange, hidden: Array.from(state.hidden).filter(function (id) { return state.graph.nodes.has(id); }).slice(0, 5000), layout: state.layout, timeScale: state.timeScale, colorBy: state.colorBy, focus: state.focus, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, filter: state.filter, expandRange: state.expandRange, source: state.source === 'custom' ? 'clearnet' : state.source }; }

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

  /** What each label pack that is switched on says about itself, for the report's list of where names came from. */
  function reportPacks() {
    return PK.active(state.shipped, state.packs).concat(state.packs.filter(function (p) { return p.enabled; })).map(function (p) {
      return { name: p.name, source: p.source || '', licence: p.licence || '', attribution: p.attribution || '', asOf: p.asOf || '' };
    });
  }

  /** How the fiat values in a report were worked out, in words. */
  function fiatNoteText() { return PR.note(state.fiat, S.fmtTimeFull); }

  /** A group of the trace as plain data for the report: what it stands for and every member (none is left out). */
  function reportGroup(grp) {
    var gn = groupNodeOf(grp.id), rows = groupRows(grp); if (!gn || !rows.length) return null;
    var st = GR.stats(rows);
    return { id: grp.id, text: gn.groupText, label: grp.label || '', tag: grp.tag || '', note: grp.note || '', anchor: grp.anchor, dir: grp.dir, kind: grp.kind, party: grp.party, count: st.count, total: st.total, min: st.min, max: st.max, first: st.first, last: st.last,
             members: rows.slice(0, 5000).map(function (r) { return { id: r.id, amount: r.amount, time: r.time }; }) };
  }

  /** The investigation report: what is on screen, as one file with its evidence embedded. */
  function doReport() {
    var g = state.graph; g.refreshDerived();
    var vis = F.computeVisible(g, state.filter, state.keep, focusOpt(), traceOnly(), hiddenOpt());
    if (!vis.nodes.size) { toast('Nothing on screen to put in a report.', true); return Promise.resolve(false); }
    var an = analysis(), title = LB.cleanText($('reportTitle').value, 120) || 'Hopline investigation report', by = LB.cleanText($('reportBy').value, 80);
    var base = JSON.parse(IO.toJson(g, { only: vis, view: viewState(), source: sourceBase() }));
    if (base.view) delete base.view.hidden;                                    // what you hid is not part of what is reported
    // the report describes what is on screen: a chain or cluster is cut to the vertices that are shown, so nothing hidden leaks in through them
    var found = RP.analysisFor(an, function (id) { return vis.nodes.has(id); }), atx = found.tx, chains = found.chains, clusters = found.clusters;
    var loadedTx = base.nodes.filter(function (n) { return n.type === 'tx' && n.loaded; }).length;
    var groups = traceOn() ? Array.from(state.trace.groups.values()).map(reportGroup).filter(Boolean) : [];
    if (base.view && base.view.trace) { delete base.view.trace.groups; delete base.view.trace.seq; }              // the members of a group are not among this file's vertices: they are listed under groups instead
    base.evidence = { generatedBy: 'Hopline workspace', title: title, preparedBy: by, generated: new Date().toISOString(), source: sourceBase(), fiat: state.fiat,
                      counts: { nodes: base.nodes.length, edges: base.edges.length, transactionsLoaded: loadedTx },
                      analysis: { transactions: atx, chains: chains, clusters: clusters, skipped: an.clusters.skipped, thresholds: AN.DEFAULTS } };
    if (groups.length) base.evidence.groups = groups;
    var image = null; try { image = renderer.toDataUrl(); } catch (e) { /* a tainted or empty canvas: the report simply has no picture */ }
    var model = { title: title, preparedBy: by, generated: Date.now(), evidence: base, nodes: base.nodes, edges: base.edges,
                  analysis: { tx: atx, chains: chains, clusters: clusters, skipped: an.clusters.skipped }, groups: groups,
                  known: function (a) { return KNOWN[a] || null; }, packs: reportPacks(), fiat: fiatOn() ? function (s, t) { var f = fiatOf(s, t); return f ? f.text : ''; } : null, fiatNote: fiatNoteText(),
                  image: image, fingerprint: function (n) { var f = AN.fingerprint(n); return f ? f.text : ''; } };
    return RP.build(model).then(function (r) {
      download('hopline-report-' + stamp() + '.html', r.html, 'text/html;charset=utf-8'); stat('report');
      toast('Report written: ' + plural(loadedTx, 'transaction') + ', ' + plural(base.edges.length, 'movement') + '. SHA-256 of its evidence: ' + r.hash.slice(0, 16) + '…', false);
      log('Report SHA-256 ' + r.hash);
      return true;
    }, function (e) { toast('The report could not be made: ' + (e && e.message ? e.message : e), true); return false; });
  }

  /**
   * The visible part of a trace, plus what its group vertices stand for: each group's members and the edges that join them to the vertex the group
   * hangs from. Without them the saved groups would be dropped when the file is opened again (a group needs its members to be a group).
   */
  function withGroupMembers(vis) {
    var out = { nodes: new Set(vis.nodes), edges: new Set(vis.edges) }, g = state.graph;
    state.trace.groups.forEach(function (grp) {
      grp.members.forEach(function (m) {
        if (!g.nodes.has(m)) return;
        out.nodes.add(m);
        g.edgesOf(m).forEach(function (e) { if (e.source === grp.anchor || e.target === grp.anchor) out.edges.add(e.id); });
      });
    });
    return out;
  }

  function doExport(kind) {
    var g = state.graph;
    if (!g.nodes.size) { toast('Nothing to export yet.', true); return; }
    if (kind === 'report') { $('exportMenu').open = false; doReport(); return; }
    g.refreshDerived(); stat('export-' + kind);
    var only = $('exportVisible').checked ? F.computeVisible(g, state.filter, state.keep, focusOpt(), traceOnly(), hiddenOpt()) : null;
    if (only && kind === 'json' && traceOn()) only = withGroupMembers(only);
    var name = 'hopline-' + stamp();
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
    if (Array.isArray(v.hidden)) { state.hidden = new Set(v.hidden.filter(function (id) { return typeof id === 'string' && NV.isId(id); }).slice(0, 5000).map(canonicalId)); state.hideUndo = []; state.hideRedo = []; }
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
    state.expandRange = cleanRange(v.expandRange); syncExpandChip();
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
    state.filter.timeFrom = null; state.filter.timeTo = null; state.expandRange = null; syncExpandChip();
    state.focus = null; state.nav.reset();
    state.trace = emptyTrace(); state.hidden = new Set(); state.hideUndo = []; state.hideRedo = []; state.arrange = DEFAULT_ARRANGE;
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
   * `alongside` says something is being opened already, so Restore merges the saved session into it.
   */
  function offerRestore(afterDiscard, alongside) {
    if (!state.persist) return false;
    var raw = store.get(SAVE_KEY); if (!raw) return false;
    var meta; try { meta = JSON.parse(raw); } catch (e) { store.del(SAVE_KEY); return false; }
    if (!meta || !IO.isFormat(meta.format) || !Array.isArray(meta.nodes) || !meta.nodes.length) return false;
    $('restoreText').textContent = 'A saved session with ' + meta.nodes.length + ' vertices from ' + S.fmtTime(Date.parse(meta.exported) / 1000) + ' is stored in this browser.' + (alongside ? ' Restore adds it to what is open now.' : '');
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
        else { state.selected = new Set([id]); state.selectedEdge = null; moveHint(id); }
        syncSelection();
      },
      onSelectEdge: function (id) {
        if (/^grpe:/.test(id)) { state.selected = new Set([id.slice(5)]); state.selectedEdge = null; }                    // the line to a group stands for the group
        else { state.selected = new Set(); state.selectedEdge = id; }
        syncSelection();
      },
      onHover: onHover,
      onMove: function (id, p) { state.pinned.set(id, { x: p.x, y: p.y }); if (traceOn() && state.arrange === 'columns' && (state.trace.shown.has(id) || state.trace.groups.has(id))) { state.trace.pos.set(id, { x: p.x, y: p.y }); scheduleSave(); } },
      onHandle: function (id, dir, shift, at) { if (shift) traceChoose(id, dir === 'left' ? 'prev' : 'next', at); else traceExpand(id, dir === 'left' ? 'prev' : 'next', { at: at }); },
      onContext: openCtx,
      onBox: function (ids, additive) { setSel(additive ? Array.from(state.selected).concat(ids) : ids); },
      onExpand: function (id) { if (traceOn() && state.trace.groups.has(id)) traceExpandGroup(id, { limit: state.stepSize }); else if (traceOn()) traceExpand(id, 'next'); else if (state.focusOn) navigate(id); else expandNode(id, 'both'); }
    });
    if (!A.PRESETS.tor) { var torOpt = document.querySelector('#source option[value="tor"]'); if (torOpt) torOpt.remove(); }          // a published copy does not offer Tor
    loadPrefs();
    makeClient();
    $('stepMode').value = state.stepMode; $('stepSize').value = state.stepSize; $('groupRows').checked = state.groupRows; $('groupBy').value = state.groupBy; $('dustSats').value = state.dustSats; $('arrowsInRange').checked = state.arrowsInRange;
    $('capTx').value = state.capTx; $('capReq').value = state.capReq; $('capPages').value = state.capPages; $('showLabels').checked = state.showLabels; $('persist').checked = state.persist; $('focusOn').checked = state.focusOn; $('depth').value = String(state.hops);
    applySourceUi(); syncFiatUi(); updateReqStats();
    $('edgeLabels').checked = state.edgeLabels; $('viaWallets').checked = state.viaWallets; $('bundleEdges').checked = state.bundleEdges;
    setSideCollapsed(state.sideCollapsed); setInspCollapsed(state.inspCollapsed); setTbCollapsed(state.tbCollapsed);
    loadPacks(); initShipped(); renderPacks();
    document.body.classList.toggle('trace-on', traceOn()); setSeg('layoutSeg', 'data-layout', state.layout); updateScaleRow();
    $('stepCopy').appendChild(copyIconSvg());
    $('reportBy').value = state.reportBy || ''; $('reportBy').addEventListener('change', savePrefs);
    $('packImport').addEventListener('click', function () { $('packFile').click(); });
    $('packFile').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (/\.(xml|zip)$/i.test(f.name)) {
        if (f.size > 200 * 1024 * 1024) { toast('That file is too large (limit 200 MB).', true); return; }
        importOfac(f); return;
      }
      if (f.size > 40 * 1024 * 1024) { toast('That file is too large (limit 40 MB).', true); return; }
      var rd = new FileReader();
      rd.onload = function () {
        var txt = String(rd.result);
        if (OF.looksLikeSdnCsv(txt)) { toast('That looks like the OFAC file SDN.CSV, which cannot be used: it cuts long entries and loses addresses. Download SDN_XML.ZIP or SDN.XML from the OFAC SDN list page and choose that.', true); return; }
        importPack(txt, f.name);
      };
      rd.onerror = function () { toast('Could not read the file.', true); }; rd.readAsText(f);
    });
    $('packExportCsv').addEventListener('click', function () { exportOwnLabels('csv'); });
    $('packExportJson').addEventListener('click', function () { exportOwnLabels('json'); });
    syncAutoUi();
    Array.prototype.forEach.call($('autoDirSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { state.auto.dir = b.getAttribute('data-dir'); syncAutoUi(); savePrefs(); }); });
    ['autoHops', 'autoFollow', 'autoMaxTx', 'autoMaxReq', 'autoPerTx', 'autoMin', 'autoStopLabel', 'autoStopMix'].forEach(function (id) { $(id).addEventListener('change', readAuto); });
    $('autoGo').addEventListener('click', function () { var id = autoTarget(); if (id) autoExpand(id); });
    wireDetections(); wireAssistant();
    [['anKPeel', 'peel'], ['anKConsol', 'consolidation'], ['anKBatch', 'batch'], ['anKCoinjoin', 'coinjoin']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.analysis.kinds[p[1]] = this.checked; savePrefs(); refresh(); });
    });
    [['anFlags', 'flags'], ['anChange', 'change'], ['anClusters', 'clusters']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.analysis[p[1]] = this.checked; savePrefs(); edgeLabelCache.clear(); refresh(); });
    });

    var openShift = false;
    $('btnOpen').addEventListener('click', function (e) { openShift = !!e.shiftKey; });
    $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); openQuery($('q').value, { replace: true }); } });
    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); var again = openShift; openShift = false; openQuery($('q').value, { replace: again }); });
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
    $('sideCollapse').addEventListener('click', function () { if (fullScr.on) setFullSide(false); else setSideCollapsed(true); });          // in full screen « closes the drawer and leaves the saved choice alone
    $('sideTab').addEventListener('click', function () { setSideCollapsed(false); });
    $('inspCollapse').addEventListener('click', function () { setInspCollapsed(true); });
    $('inspTab').addEventListener('click', function () { setInspCollapsed(false); });
    $('edgeLabels').addEventListener('change', function () { state.edgeLabels = this.checked; savePrefs(); refresh(); });
    $('bundleEdges').addEventListener('change', function () { state.bundleEdges = this.checked; savePrefs(); edgeLabelCache.clear(); refresh(); showInspector(true); });
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
    $('btnUndoLoad').addEventListener('click', undoLoad); $('btnRedoLoad').addEventListener('click', redoLoad);
    $('btnRelayout').addEventListener('click', function () { if (traceOn()) { traceTidy(); return; } relayoutAll(); });
    $('traceUndo').addEventListener('click', undoLast);
    $('traceRedo').addEventListener('click', redoLast);
    $('findQ').addEventListener('focus', function () { if (!find.open) findShow(); });
    $('findQ').addEventListener('click', function () { if (!find.open) findShow(); });
    $('findQ').addEventListener('input', function () { clearTimeout(find.timer); find.pending = true; find.timer = setTimeout(findRun, 60); });
    $('findQ').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); findMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); findMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); findEnter(); }
      else if (e.key === 'Escape') { e.preventDefault(); findClose(); }
      else if (e.key === 'Tab') findClose(false);
    });
    document.addEventListener('mousedown', function (e) { if (find.open && !$('findQ').parentNode.contains(e.target)) findClose(false); });
    $('traceHide').addEventListener('click', hideSelected);
    $('traceKeep').addEventListener('click', function () { keepOnly(traceOn() ? traceSelected() : Array.from(state.selected)); });
    $('selMenu').addEventListener('click', openSelectMenu);
    $('hiddenBtn').addEventListener('click', openHiddenMenu);
    $('boxSel').addEventListener('click', function () { setBoxMode(!state.boxMode); });
    $('traceArrange').addEventListener('change', function () { setArrange(this.value); });
    $('traceReset').addEventListener('click', traceReset);
    $('zoomIn').addEventListener('click', function () { renderer.zoomBy(1.3); });
    wireFullScreen();
    $('zoomOut').addEventListener('click', function () { renderer.zoomBy(1 / 1.3); });
    $('cancel').addEventListener('click', function () { state.client.abort(); });
    $('sample').addEventListener('click', function () { stat('sample'); $('q').value = SAMPLE; openQuery(SAMPLE); });
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
    $('inspClose').addEventListener('click', function () {
      if (rightView() === 'findings') { setInspCollapsed(true); return; }
      state.selected = new Set(); state.selectedEdge = null; syncSelection();
    });
    $('tabDetails').addEventListener('click', function () { setRightTab('details'); });
    $('tabFindings').addEventListener('click', function () { setRightTab('findings'); });
    $('rpTabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); var next = e.key === 'ArrowRight' ? 'findings' : 'details'; setRightTab(next); $(next === 'findings' ? 'tabFindings' : 'tabDetails').focus();
    });
    $('anOpenFindings').addEventListener('click', function () { openFindings(); });

    // source
    $('source').addEventListener('change', function () { state.source = this.value; applySourceUi(); makeClient(); savePrefs(); });
    $('fallbackOn').addEventListener('change', function () { state.fallback = this.checked; applySourceUi(); makeClient(); savePrefs(); });
    $('customBase').addEventListener('change', function () { state.customBase = this.value.trim(); makeClient(); savePrefs(); applySourceUi(); });
    function setKey() {
      var k = A.cleanKey({ header: $('srcKeyHeader').value, value: $('srcKey').value });
      if (k) state.keys.custom = k; else delete state.keys.custom;
      saveKeys(); makeClient(); makePriceClient(); applySourceUi();
    }
    $('srcKey').addEventListener('change', setKey); $('srcKeyHeader').addEventListener('change', setKey);
    $('srcKeyRemember').addEventListener('change', function () { state.keyRemember = this.checked; saveKeys(); savePrefs(); });
    function setPace() { state.pace = A.cleanPace({ concurrency: $('paceConc').value, delayMs: $('paceDelay').value }); makeClient(); savePrefs(); applySourceUi(); }
    $('paceConc').addEventListener('change', setPace); $('paceDelay').addEventListener('change', setPace);
    $('paceConc').addEventListener('input', function () { $('paceConcOut').textContent = this.value; });
    $('customPrices').addEventListener('change', function () { state.customPrices = this.value; state.books = {}; state.today = null; makePriceClient(); savePrefs(); if (fiatOn()) ensurePrices(); else syncFiatUi(); });
    $('testSource').addEventListener('click', function () {
      var out = $('testResult'), t0 = performance.now();
      if (state.source === 'custom' && !/^https?:\/\//i.test(state.customBase.trim())) { out.textContent = 'Enter a URL first.'; out.className = 'bad'; return; }
      out.textContent = 'Testing…'; out.className = '';
      var probe = new A.Client({ base: sourceBase(), timeoutMs: A.PRESETS[state.source].timeoutMs, retries: 0, delayMs: 0, auth: A.authFor(state), keyHint: state.source === 'custom' });
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
    $('arrowsInRange').addEventListener('change', function () { state.arrowsInRange = this.checked; savePrefs(); renderer.dirty = true; showInspector(true); });
    $('groupRows').addEventListener('change', function () { state.groupRows = this.checked; savePrefs(); showInspector(true); });
    $('groupBy').addEventListener('change', function () { state.groupBy = cleanGroupBy(this.value); savePrefs(); showInspector(true); });
    $('dustSats').addEventListener('change', function () { state.dustSats = num(this.value, 0, 1000000000, 10000); this.value = state.dustSats; savePrefs(); showInspector(true); });
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
    $('hist').addEventListener('pointerdown', onTimeDown); $('hist').addEventListener('pointerup', onTimeUp); $('hist').addEventListener('pointercancel', onTimeUp);
    $('expandChipClear').addEventListener('click', clearExpandRange);
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
      if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selected.size) { e.preventDefault(); if (e.shiftKey) deleteIds(Array.from(state.selected)); else hideSelected(); } }
      else if (e.key === 'Escape') { if (!$('stepMenu').hidden) closeStepMenu(); else if (state.boxMode) setBoxMode(false); else if (fullSideOpen()) setFullSide(false); else if (fullScr.on) setFullScreen(false); else { state.selected = new Set(); state.selectedEdge = null; syncSelection(); } }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        var id = state.selected.size ? Array.from(state.selected)[0] : state.focus;
        if (id && state.graph.nodes.has(id)) { e.preventDefault(); openCtx(id, null, clientPosOf(id)); }
      }
      else if (e.key === '[') { e.preventDefault(); if (traceOn()) traceKey('prev'); else stepClick('prev'); }
      else if (e.key === ']') { e.preventDefault(); if (traceOn()) traceKey('next'); else stepClick('next'); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redoLast(); else undoLast(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoLast(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && e.target === $('cv')) { e.preventDefault(); setFullScreen(false); findOpen(); }
      else if (mod) { /* a shortcut with Ctrl, Alt or Cmd held belongs to the browser */ }
      else if (e.key === 'b' || e.key === 'B') { setBoxMode(!state.boxMode); }
      else if (e.key === 'c' || e.key === 'C') { if (fullScr.on) setFullSide(!fullSideOpen()); else setSideCollapsed(!state.sideCollapsed); }
      else if (e.key === 'd' || e.key === 'D') { setInspCollapsed(!state.inspCollapsed); }
      else if (e.key === 't' || e.key === 'T') { setTbCollapsed(!state.tbCollapsed); }
      else if (e.key === 'f' || e.key === 'F') { renderer.fit(); }
      else if (e.key === 'm' || e.key === 'M') { setFullScreen(!fullScr.on); }
      else if (e.key === '/') { e.preventDefault(); setFullScreen(false); $('q').focus(); }
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
    if (openTarget && !hp) { offerRestore(null, true); openTarget(); }                 // a link that names what to open (the wallet page's "Open in workspace") is followed at once; the saved session waits beside it and nothing is autosaved until it is answered
    else if (!offerRestore(openTarget) && openTarget) openTarget();
    updateNavUi();
    if (fiatOn()) ensurePrices();
    window.__booted = true;                                                    // the page started: the start-up error banner stays out of the way from here
  }

  window.__hopline = { state: state, openFindings: openFindings, refresh: refresh, afterGraphChange: afterGraphChange, navigate: navigate, drawHistogram: drawHistogram, timeX: timeX, analysis: analysis, autoExpand: autoExpand, importPack: importPack, undoLoad: undoLoad, traceExpand: traceExpand, traceMakeGroup: traceMakeGroup, traceExpandGroup: traceExpandGroup, traceStart: traceStart, traceHideIds: traceHideIds, hideIds: hideIds, showIds: showIds, setSel: setSel, selectAllVisible: selectAllVisible, setArrange: setArrange, fiatOf: fiatOf, openCtx: openCtx, lookupArkham: lookupArkham, renderStepBar: renderStepBar, stepClick: stepClick, get renderer() { return renderer; } };   // read by the end-to-end tests
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
