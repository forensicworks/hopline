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

  var PREFIX = '#s1/';
  var FORMAT = 'hopline-workspace', VERSION = 1;               // the workspace file's own names (HoplineIO): a link carries one, so a test keeps these two honest
  var DEFAULT_LIMIT = 50, MIN_LIMIT = 5, MAX_LIMIT = 500;       // vertices in a link
  var MAX_CHARS = 60000;                                        // the longest link made, after the "#": more than this does not survive chat and mail
  var MAX_FRAGMENT = 200000;                                    // the longest link opened
  var MAX_JSON = 4000000;                                       // the largest text a link may unpack to
  var MAX_NODES_IN = 5000;                                      // the most vertices a link may claim
  var DROP = ['ext', 'fetchedAt', 'spendsCheckedAt', 'statsAt', 'statsSource', 'source'];                       // what other services said, and where and when a vertex was fetched from
  var VIEW_KEYS = ['layout', 'arrange', 'colorBy', 'sizeBy', 'timeScale', 'focus', 'focusOn', 'hops'];          // the parts of the view that make the same picture; the rest is the reader's own
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
  function nearest(graph, o) {
    o = o || {};
    var limit = limitOf(o.limit);
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
   * The workspace file text for the vertices nearest START. o: { nodes, edges, starts, limit, notes (bool), view, now }.
   * Returns { text, kept, total }.
   */
  function pack(graph, o) {
    var near = nearest(graph, o), nodes = [], edges = [];
    near.order.forEach(function (id) { nodes.push(slim(graph.nodes.get(id), !!o.notes)); });
    graph.edges.forEach(function (e) { if (near.kept.has(e.source) && near.kept.has(e.target) && (!o.edges || o.edges.has(e.id))) edges.push(e); });
    var text = JSON.stringify({ format: FORMAT, version: VERSION, exported: new Date(o.now != null ? o.now : Date.now()).toISOString(), share: { kept: near.kept.size, of: near.total },
                                view: pruneView(o.view, near.kept), nodes: nodes, edges: edges });
    return { text: text, kept: near.kept.size, total: near.total };
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

  return { PREFIX: PREFIX, FORMAT: FORMAT, VERSION: VERSION, DEFAULT_LIMIT: DEFAULT_LIMIT, MIN_LIMIT: MIN_LIMIT, MAX_LIMIT: MAX_LIMIT, MAX_CHARS: MAX_CHARS,
           limitOf: limitOf, nearest: nearest, slim: slim, pruneView: pruneView, pack: pack, isShareHash: isShareHash, supported: supported, build: build, decode: decode,
           toBase64Url: toBase64Url, fromBase64Url: fromBase64Url, deflate: deflate };
}));
