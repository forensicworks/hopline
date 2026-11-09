/*
 * Hopline tags: your own classification of a wallet or transaction (EXCH, THREAT, ...) with a colour and a shape.
 * Pure functions. A vertex carries three independent optional fields:
 *   tag    a short name: one of the presets below or your own text
 *   color  '#rrggbb' used instead of the usual colour
 *   shape  one of SHAPES, used instead of the usual shape
 * Choosing a preset copies its colour and shape onto the vertex, after which either can be changed on its own.
 * Everything coming from outside (an imported file, a lookup) is validated here before it reaches a canvas or the DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineTags = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SHAPES = ['circle', 'square', 'diamond', 'hexagon', 'triangle', 'triangle-down', 'star', 'cross'];

  var PRESETS = [
    { id: 'EXCH',     name: 'Exchange',                    color: '#2ecc71', shape: 'hexagon' },
    { id: 'THREAT',   name: 'Threat actor',                color: '#ff4d4d', shape: 'triangle' },
    { id: 'VICTIM',   name: 'Victim',                      color: '#4da3ff', shape: 'triangle-down' },    // the threat actor's triangle, turned over
    { id: 'PAYMENT',  name: 'Payment of interest',         color: '#ffd23f', shape: 'star' },
    { id: 'MIXER',    name: 'Mixer / tumbler',             color: '#b36bff', shape: 'diamond' },
    { id: 'MARKET',   name: 'Darknet market',              color: '#ff5fa2', shape: 'cross' },
    { id: 'SERVICE',  name: 'Service / merchant',          color: '#20c9c9', shape: 'square' },
    { id: 'GAMBLING', name: 'Gambling',                    color: '#ff9f43', shape: 'cross' },
    { id: 'SWAP',     name: 'Swap / bridge',               color: '#d98a3d', shape: 'hexagon' },     // a service that moves value to another chain
    { id: 'WATCH',    name: 'To review',                   color: '#ffffff', shape: 'circle' }
  ];

  // quick swatches next to the colour picker
  var COLORS = ['#ff4d4d', '#ff9f43', '#ffd23f', '#2ecc71', '#20c9c9', '#4da3ff', '#b36bff', '#ff5fa2', '#ffffff', '#8d7f8d'];

  var BY_ID = {};
  PRESETS.forEach(function (p) { BY_ID[p.id] = p; });

  function preset(id) { return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null; }

  /** A tag name: trimmed, at most 20 characters of letters, digits, space, - _ . Returns '' when nothing usable is left. */
  function cleanTag(t) {
    if (typeof t !== 'string') return '';
    var s = t.replace(/[^A-Za-z0-9 _\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    var p = preset(s.toUpperCase());
    return p ? p.id : s;
  }
  /** '#rrggbb' (lower case) or ''. Anything else, including CSS keywords and url(), is refused. */
  function cleanColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : ''; }
  function cleanShape(s) { return typeof s === 'string' && SHAPES.indexOf(s) >= 0 ? s : ''; }

  /**
   * Set, change or clear the tag/colour/shape of a vertex object. `fields` may contain any of tag, color, shape;
   * a field that is missing is left alone, an empty or invalid one clears it. Choosing a preset tag also copies its
   * colour and shape unless `keepStyle` is true.
   */
  function apply(node, fields, keepStyle) {
    if (!node || !fields) return node;
    function put(k, v) { if (v) node[k] = v; else delete node[k]; }
    if ('tag' in fields) {
      var tag = cleanTag(fields.tag);
      put('tag', tag);
      var p = preset(tag);
      if (!tag) { delete node.color; delete node.shape; }
      else if (p && !keepStyle) { node.color = p.color; node.shape = p.shape; }
    }
    if ('color' in fields) put('color', cleanColor(fields.color));
    if ('shape' in fields) put('shape', cleanShape(fields.shape));
    return node;
  }

  /** Validate the style fields of an object read from outside, in place. */
  function sanitize(node) {
    ['tag', 'color', 'shape'].forEach(function (k) {
      var v = node[k];
      if (v === undefined) return;
      var clean = k === 'tag' ? cleanTag(v) : k === 'color' ? cleanColor(v) : cleanShape(v);
      if (clean) node[k] = clean; else delete node[k];
    });
    return node;
  }

  /** What a vertex shows: { tag, name, color, shape } with the preset's name when it is one. */
  function resolve(node) {
    var p = node && node.tag ? preset(node.tag) : null;
    return { tag: node && node.tag || '', name: p ? p.name : (node && node.tag) || '', color: node && node.color || '', shape: node && node.shape || '' };
  }

  /** Counts per tag over some vertices, for the legend: [{tag, name, color, shape, count}] most used first. */
  function summarise(nodes) {
    var m = new Map();
    nodes.forEach(function (n) {
      if (!n.tag) return;
      var e = m.get(n.tag) || { tag: n.tag, name: resolve(n).name, color: n.color || (preset(n.tag) || {}).color || '', shape: n.shape || (preset(n.tag) || {}).shape || '', count: 0 };
      e.count++; m.set(n.tag, e);
    });
    return Array.from(m.values()).sort(function (a, b) { return b.count - a.count || (a.tag < b.tag ? -1 : 1); });
  }

  // ---- tags from the lists ------------------------------------------------------------------------
  // What a list says about a wallet (its category) can name a kind of service, and then the wallet can carry that tag without anyone setting it. Only the kinds of
  // service are mapped (an exchange, a mixer, a market, a gambling site, a swap or bridge, a merchant): THREAT, VICTIM, PAYMENT and WATCH are the analyst's own
  // judgement, and a sanctions or ransomware entry has its own marking, so a list never sets those.
  var CATEGORY_TAG = {
    'EXCHANGE': 'EXCH', 'EXCHANGES': 'EXCH', 'CRYPTO EXCHANGE': 'EXCH', 'CEX': 'EXCH', 'EXCH': 'EXCH',
    'MIXER': 'MIXER', 'MIXING': 'MIXER', 'MIXING SERVICE': 'MIXER', 'MIXERS': 'MIXER', 'TUMBLER': 'MIXER',
    'MARKET': 'MARKET', 'MARKETPLACE': 'MARKET', 'DARKNET MARKET': 'MARKET', 'DARKNET MARKETS': 'MARKET', 'DARKNET': 'MARKET',
    'GAMBLING': 'GAMBLING', 'CASINO': 'GAMBLING', 'BETTING': 'GAMBLING',
    'SWAP': 'SWAP', 'BRIDGE': 'SWAP', 'SWAP SERVICE': 'SWAP',
    'SERVICE': 'SERVICE', 'MERCHANT': 'SERVICE', 'PAYMENT PROCESSOR': 'SERVICE', 'PAYMENT SERVICE': 'SERVICE'
  };
  /** The preset tag a list's category names ('Exchange' -> 'EXCH'), or ''. Case, punctuation and spacing do not matter. */
  function fromCategory(category) {
    if (typeof category !== 'string') return '';
    var key = category.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    return Object.prototype.hasOwnProperty.call(CATEGORY_TAG, key) ? CATEGORY_TAG[key] : '';
  }
  /** The tag a wallet's claims point at: that of the first claim (the order the lists name it in) whose category names a kind of service, else ''. claims: [{ category }]. */
  function fromClaims(claims) {
    for (var i = 0; i < (claims || []).length; i++) { var t = claims[i] ? fromCategory(claims[i].category) : ''; if (t) return t; }
    return '';
  }

  /**
   * Is the tag on this vertex the one the lists give it and nothing more: the tag a known entry's claims name, with the preset's own colour and shape? Then it says nothing
   * the lists did not say, so it is not something you wrote (it is left out of your own labels, and the list's name, not the tag, stays the wallet's name).
   * node: a vertex; known: its entry in the lists (with `claims` when several lists name it) or null.
   */
  function isFromLists(node, known) {
    if (!node || !node.tag || !known) return false;
    var t = fromClaims(known.claims && known.claims.length ? known.claims : [known]), p = t ? preset(t) : null;
    return !!p && node.tag === t && (!node.color || node.color === p.color) && (!node.shape || node.shape === p.shape);
  }

  return { SHAPES: SHAPES, PRESETS: PRESETS, COLORS: COLORS, preset: preset, cleanTag: cleanTag, cleanColor: cleanColor, cleanShape: cleanShape, apply: apply, sanitize: sanitize, resolve: resolve, summarise: summarise, fromCategory: fromCategory, fromClaims: fromClaims, isFromLists: isFromLists };
}));
