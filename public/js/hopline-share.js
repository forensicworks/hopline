/*
 * Hopline share links: a canvas as a link. The page is opened with the canvas in the part of the address after the "#", so nothing is
 * stored anywhere and the browser never sends that part to a server (the page's own host sees only the address of the page).
 *
 *   #s1/<the workspace as JSON, deflated, in base64url>
 *
 * The text inside is the ordinary workspace file (HoplineIO), cut down: only the vertices near START, only the edges between
 * them, no notes unless asked, no look-ups from other services, and only the parts of the view that describe the picture (layout,
 * colouring, the trace). Opening it goes through the same checks as importing a file (HoplineIO.fromJson), after these extra ones:
 * a longest link, a largest unpacked size and a largest number of vertices, so a link made by someone else cannot freeze the page.
 *
 * A second kind of link carries only the transaction IDs of what is on the canvas, no vertices, amounts or times:
 *
 *   #i1/<{ format, version, t: [txid, ...], f: focus, of: how many, view: {...}, l: [labels], trace: {...} } as JSON, deflated, in base64url>
 *
 * Whoever opens it loads those transactions from their own data source and gets the picture drawn afresh. It costs about 45 characters
 * for a transaction, so it holds far more than a canvas link, but the reader needs the network. Two things can be added, each only when the sender asks:
 * `l`, the labels and tags (and notes) of the vertices, as [reference, label, tag, note] with the reference the position of a transaction in `t` or the address of a wallet,
 * and `trace`, the trace as the workspace file saves it (starting points, the vertices it shows, their places and where each came from, without groups).
 *
 * A transaction the link cuts (it keeps fewer of its inputs or outputs than it has) cannot be analysed by the reader, so it carries the short names of the patterns the sender's analysis
 * showed on it (o.carry: Map of vertex id -> names; node.carried). They are the sender's claim, shown apart and unchecked (see HoplineAnalysis.carriedFlags); a mark the sender itself was
 * only carried (it opened a link) is not passed on.
 *
 * A link has a limit: at most `limit` vertices (default 50, about 4,000 characters on real data), and in any case no more than
 * MAX_CHARS characters. Over the limit it keeps the vertices nearest START (hop by hop, along the edges in either direction) and says
 * how many it left out; build() reports that, and the page warns. Pure functions apart from the compression, which uses the
 * browser's CompressionStream (and Node's, so it can be tested).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineShare = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PREFIX = '#s1/', IDS_PREFIX = '#i1/';
  var IDS_FORMAT = 'hopline-ids', MAX_IDS = 3000;               // an IDs link: its own format name, and the most transactions one may list (made or opened)
  var IDS_VIEW = ['layout', 'arrange', 'colorBy', 'arrowDir', 'dirPalette', 'sizeBy', 'timeScale', 'focusOn', 'hops'];                    // the settings an IDs link carries; the reader's own checks do the rest
  var HEX64 = /^[0-9a-f]{64}$/, FOCUS_OK = /^(tx|addr):[A-Za-z0-9]{8,120}$/, ADDR_OK = /^[A-Za-z0-9]{8,120}$/;
  var MAX_LABELS = 6000, LABEL_MAX = 200, TAG_MAX = 60, NOTE_MAX = 4000, MAX_TRACE = 5000;      // what an IDs link may carry besides the ids
  var FORMAT = 'hopline-workspace', VERSION = 1;               // the workspace file's own names (HoplineIO): a link carries one, so a test keeps these two honest
  var DEFAULT_LIMIT = 50, MIN_LIMIT = 5, MAX_LIMIT = 500;       // vertices in a link
  var MAX_CHARS = 60000;                                        // the longest link made, after the "#": more than this does not survive chat and mail
  var MAX_FRAGMENT = 200000;                                    // the longest link opened
  var MAX_JSON = 4000000;                                       // the largest text a link may unpack to
  var MAX_NODES_IN = 5000;                                      // the most vertices a link may claim
  var DROP = ['ext', 'fetchedAt', 'spendsCheckedAt', 'statsAt', 'statsSource', 'source', 'carried'];                       // what other services said, and where and when a vertex was fetched from
  var VIEW_KEYS = ['layout', 'arrange', 'colorBy', 'arrowDir', 'dirPalette', 'sizeBy', 'timeScale', 'focus', 'focusOn', 'hops'];          // the parts of the view that make the same picture; the rest is the reader's own
  var TOO_BIG = 'unpacked size over the limit';

  function limitOf(v) { var n = Math.floor(Number(v)); return isFinite(n) ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n)) : DEFAULT_LIMIT; }

  // ---- which vertices ---------------------------------------------------------------------------
  /**
   * The `limit` vertices nearest the starting points: the starts first, then their neighbours, then theirs, along edges in either
   * direction (only edges whose two ends are allowed, and which are in o.edges when that is given). A ring that does not fit whole
   * is taken in the order the graph lists it. Vertices not connected to a start come last, in the graph's order, if room is left.
   *   o: { nodes: Set of vertex ids allowed (null: all), edges: Set of edge ids allowed (null: all), starts: [ids], limit }
   * Returns { kept: Set, order: [ids, nearest first], total } where total is how many vertices were allowed.
   */
  function nearest(graph, o) { return walk(graph, o || {}, limitOf((o || {}).limit)); }
  function walk(graph, o, limit) {
    function ok(id) { return graph.nodes.has(id) && (!o.nodes || o.nodes.has(id)); }
    var pool = [];
    graph.nodes.forEach(function (n, id) { if (ok(id)) pool.push(id); });
    var seen = new Set(), order = [], frontier = [];
    function take(id) { seen.add(id); order.push(id); frontier.push(id); }
    (o.starts || []).forEach(function (id) { if (ok(id) && !seen.has(id) && order.length < limit) take(id); });
    if (!order.length && pool.length) take(pool[0]);                                              // no start on screen: the first vertex stands in
    while (frontier.length && order.length < limit) {
      var ring = frontier; frontier = [];
      for (var i = 0; i < ring.length && order.length < limit; i++) {
        var id = ring[i], es = graph.edgesOf(id);
        for (var j = 0; j < es.length && order.length < limit; j++) {
          var e = es[j], other = e.source === id ? e.target : e.source;
          if (seen.has(other) || !ok(other) || (o.edges && !o.edges.has(e.id))) continue;
          take(other);
        }
      }
    }
    for (var k = 0; k < pool.length && order.length < limit; k++) if (!seen.has(pool[k])) { seen.add(pool[k]); order.push(pool[k]); }
    return { kept: new Set(order), order: order, total: pool.length };
  }

  // ---- what goes in -----------------------------------------------------------------------------
  /** A vertex as the link carries it: everything but what other services said about it, where it was fetched from, and (unless asked) the note. */
  function slim(n, notes) {
    var c = {};
    Object.keys(n).forEach(function (k) { if (DROP.indexOf(k) < 0 && !(k === 'note' && !notes)) c[k] = n[k]; });
    return c;
  }

  /** The view cut to the vertices that are kept: the layout and colouring, and the trace with only the vertices that are still there. */
  function pruneView(v, kept) {
    if (!v || typeof v !== 'object') return null;
    var out = {};
    VIEW_KEYS.forEach(function (k) { if (v[k] !== undefined && v[k] !== null) out[k] = v[k]; });
    if (typeof out.focus === 'string' && !kept.has(out.focus)) delete out.focus;
    var t = v.trace;
    if (t && typeof t === 'object' && Array.isArray(t.shown)) {
      var shown = t.shown.filter(function (id) { return kept.has(id); });
      if (shown.length) {
        var seeds = (Array.isArray(t.seeds) ? t.seeds : []).filter(function (id) { return kept.has(id); });
        var seed = seeds.length ? seeds[0] : (kept.has(t.seed) ? t.seed : shown[0]);
        if (seeds.indexOf(seed) < 0) seeds.unshift(seed);
        var pos = {}, prov = {};
        Object.keys(t.pos || {}).forEach(function (id) { if (kept.has(id)) pos[id] = t.pos[id]; });
        Object.keys(t.prov || {}).forEach(function (id) { var p = t.prov[id]; if (kept.has(id) && Array.isArray(p) && kept.has(p[0])) prov[id] = p; });
        out.trace = { seed: seed, seeds: seeds, shown: shown, pos: pos, prov: prov };
      }
    }
    if (out.layout === 'trace' && !out.trace) out.layout = 'flow';
    return out;
  }

  /**
   * The workspace file text for the vertices nearest START. o: { nodes, edges, starts, limit, notes (bool), view, now, carry (Map of vertex id -> pattern names) }.
   * Returns { text, kept, total }.
   */
  function pack(graph, o) {
    var near = nearest(graph, o), nodes = [], edges = [], have = new Map();
    graph.edges.forEach(function (e) {
      if (!(near.kept.has(e.source) && near.kept.has(e.target) && (!o.edges || o.edges.has(e.id)))) return;
      edges.push(e);
      var t = e.kind === 'in' ? e.target : e.kind === 'out' ? e.source : null; if (!t) return;
      var h = have.get(t); if (!h) { h = { i: 0, o: 0 }; have.set(t, h); }
      if (e.kind === 'in') h.i++; else h.o++;
    });
    near.order.forEach(function (id) {
      var c = slim(graph.nodes.get(id), !!o.notes), marks = o.carry && o.carry.get ? o.carry.get(id) : null, h = have.get(id) || { i: 0, o: 0 };
      if (marks && marks.length && c.type === 'tx' && c.loaded === true && typeof c.nIn === 'number' && typeof c.nOut === 'number' && (h.i < c.nIn || h.o < c.nOut)) c.carried = marks.slice(0, 6);
      nodes.push(c);
    });
    var text = JSON.stringify({ format: FORMAT, version: VERSION, exported: new Date(o.now != null ? o.now : Date.now()).toISOString(), share: { kept: near.kept.size, of: near.total },
                                view: pruneView(o.view, near.kept), nodes: nodes, edges: edges });
    return { text: text, kept: near.kept.size, total: near.total };
  }

  // ---- a link of IDs ----------------------------------------------------------------------------
  /** The settings of the view an IDs link carries. The Trace layout stays only when the link carries a trace (`hasTrace`): without its places the reader gets the automatic Flow layout. */
  function idsView(v, hasTrace) {
    var out = {};
    if (v && typeof v === 'object') IDS_VIEW.forEach(function (k) { var x = v[k]; if (typeof x === 'string' ? x.length <= 40 : typeof x === 'boolean' || (typeof x === 'number' && isFinite(x))) out[k] = x; });
    if (out.layout === 'trace' && !hasTrace) out.layout = 'flow';
    return out;
  }
  function clip(x, max) { return typeof x === 'string' ? x.slice(0, max) : ''; }
  /**
   * The labels, tags and (when asked) notes of the vertices that go in the link: [reference, label, tag, note] with the note, and then the tag, left off when empty. The reference is the
   * position of a transaction in `ids`, or the address of a wallet. A vertex that is not among `vertices` (cut off, or not next to a transaction in the link) is not in it.
   */
  function labelsOf(graph, ids, vertices, notes) {
    var out = [], at = new Map();
    ids.forEach(function (t, i) { at.set('tx:' + t, i); });
    vertices.forEach(function (id) {
      var n = graph.nodes.get(id);
      if (!n) return;
      var label = clip(n.label, LABEL_MAX), tag = clip(n.tag, TAG_MAX), note = notes ? clip(n.note, NOTE_MAX) : '';
      if (!label && !tag && !note) return;
      var ref = n.type === 'tx' ? at.get(id) : n.type === 'addr' && ADDR_OK.test(n.address || '') ? n.address : undefined;
      if (ref === undefined) return;
      out.push(note ? [ref, label, tag, note] : tag ? [ref, label, tag] : [ref, label]);
    });
    return out.slice(0, MAX_LABELS);
  }
  /** A trace as an IDs link carries it, checked: { seed, seeds, shown, pos, prov } in the workspace file's own form (vertex ids, places as [x, y], where each came from), without groups; null when it is not one. */
  function cleanTrace(t) {
    if (!t || typeof t !== 'object' || typeof t.seed !== 'string' || !FOCUS_OK.test(t.seed)) return null;
    function ids(a) { return (Array.isArray(a) ? a : []).slice(0, MAX_TRACE).filter(function (x) { return typeof x === 'string' && FOCUS_OK.test(x); }); }
    var shown = ids(t.shown), pos = {}, prov = {};
    if (!shown.length) return null;
    if (t.pos && typeof t.pos === 'object') Object.keys(t.pos).slice(0, MAX_TRACE).forEach(function (id) {
      var a = t.pos[id];
      if (FOCUS_OK.test(id) && Array.isArray(a) && a.length === 2 && isFinite(a[0]) && isFinite(a[1]) && Math.abs(a[0]) < 1e6 && Math.abs(a[1]) < 1e6) pos[id] = [a[0], a[1]];
    });
    if (t.prov && typeof t.prov === 'object') Object.keys(t.prov).slice(0, MAX_TRACE).forEach(function (id) {
      var a = t.prov[id];
      if (FOCUS_OK.test(id) && Array.isArray(a) && typeof a[0] === 'string' && FOCUS_OK.test(a[0]) && (a[1] === 'next' || a[1] === 'prev')) prov[id] = [a[0], a[1]];
    });
    return { seed: t.seed, seeds: ids(t.seeds), shown: shown, pos: pos, prov: prov };
  }

  /**
   * The transactions for an IDs link: the loaded transactions among the allowed vertices (o.nodes, o.edges: what is on screen), nearest START first, at most o.limit (default MAX_IDS).
   * Returns { payload, ids, total } where total is how many loaded transactions were allowed; the payload is what goes in the link.
   */
  function packIds(graph, o) {
    o = o || {};
    var cap = Math.max(1, Math.min(MAX_IDS, Math.floor(Number(o.limit)) || MAX_IDS));
    var order = walk(graph, o, graph.nodes.size || 1).order, txs = [];
    order.forEach(function (id) { var n = graph.nodes.get(id); if (n && n.type === 'tx' && n.loaded !== false && HEX64.test(n.txid || '')) txs.push(n.txid); });
    var ids = txs.slice(0, cap), keep = new Set(ids.map(function (t) { return 'tx:' + t; }));
    var start = (o.starts || [])[0], focus = null;
    if (start && keep.has(start)) focus = start;
    else if (start && graph.nodes.has(start) && graph.nodes.get(start).type === 'addr' && graph.edgesOf(start).some(function (e) { return keep.has(e.source) || keep.has(e.target); })) focus = start;
    // what the reader's graph will hold once it has loaded the transactions: them, and the wallets next to them along the edges that are on screen
    var vertices = new Set(keep);
    ids.forEach(function (t) {
      graph.edgesOf('tx:' + t).forEach(function (e) {
        if (o.edges && !o.edges.has(e.id)) return;
        var other = e.source === 'tx:' + t ? e.target : e.source;
        if (graph.nodes.has(other) && (!o.nodes || o.nodes.has(other))) vertices.add(other);
      });
    });
    var tv = o.trace ? pruneView({ trace: o.trace }, vertices) : null, trace = tv && tv.trace ? tv.trace : null;
    var payload = { format: IDS_FORMAT, version: 1, t: ids, f: focus, of: txs.length, view: idsView(o.view, !!trace) };
    var labels = o.labels ? labelsOf(graph, ids, vertices, !!o.notes) : [];
    if (labels.length) payload.l = labels;
    if (trace) payload.trace = trace;
    return { ids: ids, total: txs.length, labels: labels.length, trace: !!trace, payload: payload };
  }

  // ---- compression and base64url ----------------------------------------------------------------
  function supported() { return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function'; }

  function toBase64Url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(text) {
    var b = text.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    var s = atob(b), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function deflate(text) {
    var stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  /** The text inside, never reading more than `max` characters of it (a few bytes can unpack to gigabytes). */
  function inflate(bytes, max) {
    var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = [], size = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        size += r.value.length;
        if (size > max) { reader.cancel().catch(function () { /* already closed */ }); throw new Error(TOO_BIG); }
        chunks.push(r.value);
        return pump();
      });
    }
    return pump().then(function () {
      var all = new Uint8Array(size), at = 0;
      chunks.forEach(function (c) { all.set(c, at); at += c.length; });
      return new TextDecoder('utf-8', { fatal: true }).decode(all);
    });
  }

  // ---- making and reading a link ----------------------------------------------------------------
  function isShareHash(hash) { return typeof hash === 'string' && hash.indexOf(PREFIX) === 0; }
  function isIdsHash(hash) { return typeof hash === 'string' && hash.indexOf(IDS_PREFIX) === 0; }

  /**
   * The link (the part after the "#") for the vertices nearest START, as many as the limit allows and as fit MAX_CHARS.
   * Resolves { fragment, kept, total, chars, trimmed, bySize }: trimmed is true when vertices were left out, bySize when the length
   * of the link, not the limit, decided it. Rejects with a message the person can read.
   */
  function build(graph, o) {
    o = o || {};
    if (!supported()) return Promise.reject(new Error('This browser cannot make share links (it has no compression built in). Export the workspace (.json) instead.'));
    var asked = limitOf(o.limit);
    function attempt(lim) {
      var p = pack(graph, Object.assign({}, o, { limit: lim }));
      return deflate(p.text).then(function (z) {
        var fragment = PREFIX + toBase64Url(z);
        if (fragment.length > MAX_CHARS) {
          if (p.kept <= MIN_LIMIT) throw new Error('Even ' + p.kept + ' vertices make a link of ' + fragment.length + ' characters (long labels or notes?), more than the ' + MAX_CHARS + ' that chat and mail carry. Export the workspace (.json) instead.');
          return attempt(Math.max(MIN_LIMIT, Math.min(p.kept - 1, Math.floor(p.kept * MAX_CHARS / fragment.length * 0.9))));
        }
        return { fragment: fragment, kept: p.kept, total: p.total, chars: fragment.length, trimmed: p.kept < p.total, bySize: lim < Math.min(asked, p.total) };
      });
    }
    return attempt(asked);
  }

  /**
   * The IDs link (the part after the "#") for the loaded transactions on screen, nearest START first, as many as fit MAX_CHARS.
   * Resolves { fragment, kept, total, chars, trimmed }; rejects with a message the person can read.
   */
  function buildIds(graph, o) {
    o = o || {};
    if (!supported()) return Promise.reject(new Error('This browser cannot make share links (it has no compression built in). Export the workspace (.json) instead.'));
    function attempt(lim) {
      var p = packIds(graph, Object.assign({}, o, { limit: lim }));
      if (!p.ids.length) throw new Error('No loaded transaction is on the canvas to put in a link.');
      return deflate(JSON.stringify(p.payload)).then(function (z) {
        var fragment = IDS_PREFIX + toBase64Url(z);
        if (fragment.length > MAX_CHARS) {
          if (p.ids.length <= 1) throw new Error('Even one transaction makes a link of ' + fragment.length + ' characters, more than the ' + MAX_CHARS + ' that chat and mail carry.');
          return attempt(Math.max(1, Math.min(p.ids.length - 1, Math.floor(p.ids.length * MAX_CHARS / fragment.length * 0.95))));
        }
        return { fragment: fragment, kept: p.ids.length, total: p.total, chars: fragment.length, trimmed: p.ids.length < p.total, labels: p.labels, trace: p.trace };
      });
    }
    return Promise.resolve().then(function () { return attempt(o.limit); });
  }

  /**
   * The transactions an IDs link lists, after the length, character, unpacked-size and count checks, and every entry checked to be a transaction ID.
   * Resolves { ids, focus, view, of } (of: how many the sender had before cutting the list down, or null). Rejects with a message the person can read.
   */
  function decodeIds(hash) {
    if (!isIdsHash(hash)) return Promise.reject(new Error('This is not a Hopline link to transactions.'));
    if (!supported()) return Promise.reject(new Error('This browser cannot open share links (it has no compression built in).'));
    var body = hash.slice(IDS_PREFIX.length);
    if (!body) return Promise.reject(new Error('The link is empty.'));
    if (body.length > MAX_FRAGMENT) return Promise.reject(new Error('The link is longer than ' + MAX_FRAGMENT + ' characters, which is more than Hopline makes.'));
    if (!/^[A-Za-z0-9_-]+$/.test(body)) return Promise.reject(new Error('The link is damaged: it has characters that do not belong in it. A chat or mail program may have changed it.'));
    var bytes;
    try { bytes = fromBase64Url(body); } catch (e) { return Promise.reject(new Error('The link is damaged or was cut short: it cannot be unpacked. A chat or mail program may have shortened it.')); }
    return inflate(bytes, MAX_JSON).then(function (text) {
      var d; try { d = JSON.parse(text); } catch (e) { throw new Error('The link is damaged: what is inside is cut short or changed.'); }
      if (!d || d.format !== IDS_FORMAT || !Array.isArray(d.t)) throw new Error('The link does not hold a list of transactions.');
      if (d.t.length > MAX_IDS) throw new Error('The link lists ' + d.t.length + ' transactions; a link holds at most ' + MAX_IDS + '.');
      var seen = new Set(), ids = [];
      d.t.forEach(function (t) {
        if (typeof t !== 'string' || !HEX64.test(t)) throw new Error('The link has an entry that is not a transaction ID.');
        if (!seen.has(t)) { seen.add(t); ids.push(t); }
      });
      if (!ids.length) throw new Error('The link lists no transactions.');
      var of = typeof d.of === 'number' && isFinite(d.of) && d.of >= ids.length ? Math.floor(d.of) : null, labels = [], trace = cleanTrace(d.trace);
      if (Array.isArray(d.l)) d.l.slice(0, MAX_LABELS).forEach(function (e) {              // [reference, label, tag, note]: a position in the list of transactions, or a wallet's address
        if (!Array.isArray(e) || e.length < 2 || e.length > 4) return;
        var ref = e[0], id = null;
        if (typeof ref === 'number' && ref === Math.floor(ref) && ref >= 0 && ref < d.t.length && typeof d.t[ref] === 'string' && HEX64.test(d.t[ref])) id = 'tx:' + d.t[ref];
        else if (typeof ref === 'string' && ADDR_OK.test(ref)) id = 'addr:' + ref;
        if (!id) return;
        var label = clip(e[1], LABEL_MAX), tag = clip(e[2], TAG_MAX), note = clip(e[3], NOTE_MAX);
        if (label || tag || note) labels.push({ id: id, label: label, tag: tag, note: note });
      });
      return { ids: ids, focus: typeof d.f === 'string' && FOCUS_OK.test(d.f) ? d.f : null, view: idsView(d.view, !!trace), of: of, labels: labels, trace: trace };
    }, function (err) {
      if (err && err.message === TOO_BIG) throw new Error('The link unpacks to more than ' + Math.round(MAX_JSON / 1e6) + ' MB, so it is not one Hopline made.');
      throw new Error('The link is damaged or was cut short: it cannot be unpacked. A chat or mail program may have shortened it.');
    });
  }

  /**
   * The workspace file text inside a link, after the length, character, unpacked-size and vertex-count checks (HoplineIO.fromJson then does the rest).
   * Resolves { text, kept, of } where `of` is how many vertices the sender had before cutting it down (null if not said). Rejects with a message.
   */
  function decode(hash) {
    if (!isShareHash(hash)) return Promise.reject(new Error('This is not a Hopline share link.'));
    if (!supported()) return Promise.reject(new Error('This browser cannot open share links (it has no compression built in).'));
    var body = hash.slice(PREFIX.length);
    if (!body) return Promise.reject(new Error('The link is empty.'));
    if (body.length > MAX_FRAGMENT) return Promise.reject(new Error('The link is longer than ' + MAX_FRAGMENT + ' characters, which is more than Hopline makes.'));
    if (!/^[A-Za-z0-9_-]+$/.test(body)) return Promise.reject(new Error('The link is damaged: it has characters that do not belong in it. A chat or mail program may have changed it.'));
    var bytes;
    try { bytes = fromBase64Url(body); } catch (e) { return Promise.reject(new Error('The link is damaged or was cut short: it cannot be unpacked. A chat or mail program may have shortened it.')); }
    return inflate(bytes, MAX_JSON).then(function (text) {
      var d; try { d = JSON.parse(text); } catch (e) { throw new Error('The link is damaged: what is inside is cut short or changed.'); }
      if (!d || d.format !== FORMAT || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('The link does not hold a Hopline canvas.');
      if (d.nodes.length > MAX_NODES_IN) throw new Error('The link claims ' + d.nodes.length + ' vertices; a link holds at most ' + MAX_NODES_IN + '.');
      var of = d.share && typeof d.share.of === 'number' && isFinite(d.share.of) ? Math.floor(d.share.of) : null;
      return { text: text, kept: d.nodes.length, of: of };
    }, function (err) {
      if (err && err.message === TOO_BIG) throw new Error('The link unpacks to more than ' + Math.round(MAX_JSON / 1e6) + ' MB, so it is not one Hopline made.');
      throw new Error('The link is damaged or was cut short: it cannot be unpacked. A chat or mail program may have shortened it.');
    });
  }

  return { PREFIX: PREFIX, IDS_PREFIX: IDS_PREFIX, MAX_IDS: MAX_IDS, FORMAT: FORMAT, VERSION: VERSION, DEFAULT_LIMIT: DEFAULT_LIMIT, MIN_LIMIT: MIN_LIMIT, MAX_LIMIT: MAX_LIMIT, MAX_CHARS: MAX_CHARS,
           limitOf: limitOf, nearest: nearest, slim: slim, pruneView: pruneView, pack: pack, isShareHash: isShareHash, isIdsHash: isIdsHash, supported: supported, build: build, decode: decode, packIds: packIds, buildIds: buildIds, decodeIds: decodeIds, idsView: idsView,
           toBase64Url: toBase64Url, fromBase64Url: fromBase64Url, deflate: deflate };
}));
