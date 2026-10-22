/*
 * Hopline find: which of the vertices already loaded match what was typed. Pure functions, no DOM, no network.
 *
 * What is searched, for every transaction and wallet in the graph (shown or not):
 *   its id or address, your label, tag (the short name and the preset's full name) and note, for a transaction its block height,
 *   for a wallet the names that come from outside (the built-in list and label packs: name, category, pack, note and the other
 *   names it is listed as) and its cluster ("C3", exactly).
 * Several words must ALL match (each in any field), case does not matter, and a query shorter than two characters matches nothing.
 * The best matches come first: a whole id or label, then one that starts with the word, then one that only contains it, with
 * the vertex's own id, label and tag counting more than a note. Only text is returned; the page puts it on the screen as text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineFind = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMIT = 50, MAX_WORDS = 6;

  function low(s) { return String(s == null ? '' : s).toLowerCase(); }

  /** The searchable text of one vertex: [{ field, text, weight, exact }]. */
  function fieldsOf(n, opts) {
    var f = [];
    function add(field, text, weight, exact) { if (text != null && text !== '') f.push({ field: field, text: String(text), weight: weight, exact: !!exact }); }
    if (n.type === 'tx') { add('id', n.txid, 40); if (n.height != null) add('block', n.height, 20); }
    else if (n.type === 'addr') add('id', n.address, 40);
    else return f;
    add('label', n.label, 50);
    add('tag', n.tag, 45);
    if (n.tag && opts.tagName) add('tag', opts.tagName(n.tag), 45);
    add('note', n.note, 30);
    if (n.type === 'addr') {
      var k = opts.known ? opts.known(n.address) : null;
      if (k) {
        add('known', k.label, 45); add('known', k.category, 40); add('known', k.pack, 35); add('known', k.note, 28);
        (k.alt || []).forEach(function (a) { add('known', a, 40); });
      }
      var cl = opts.clusterOf ? opts.clusterOf(n.id) : null;
      if (cl && cl.label) add('cluster', cl.label, 55, true);
    }
    return f;
  }

  /** The best field a word matches in, or null. */
  function matchWord(word, fields) {
    var best = null;
    fields.forEach(function (fl) {
      var t = low(fl.text), at = t.indexOf(word);
      if (at < 0) return;
      if (fl.exact && t !== word) return;                                    // a cluster is "C3", not anything that contains c3
      var w = fl.weight + (t === word ? 60 : at === 0 ? 30 : 0);
      if (!best || w > best.weight) best = { field: fl.field, text: fl.text, at: at, len: word.length, weight: w };
    });
    return best;
  }

  /**
   * { results, total } for the vertices of `graph` that match `query`. Each result:
   *   { id, type: 'tx' | 'addr', value (the txid or address), label, score, why: [{ field, text, at, len }] }
   * opts: { known(address) -> { label, category, pack, note, alt } | null, clusterOf(vertexId) -> { label } | null,
   *         tagName(tag) -> the preset's full name, limit (default 50) }
   */
  function search(graph, query, opts) {
    opts = opts || {};
    var q = low(query).trim();
    if (q.length < 2) return { results: [], total: 0 };
    var words = q.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS), out = [], limit = opts.limit > 0 ? opts.limit : LIMIT;
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' && n.type !== 'addr') return;
      var fields = fieldsOf(n, opts), score = 0, why = [], seen = {};
      for (var i = 0; i < words.length; i++) {
        var m = matchWord(words[i], fields);
        if (!m) return;                                                       // every word has to be found somewhere
        score += m.weight;
        var key = m.field + '|' + m.text;
        if (!seen[key]) { seen[key] = true; why.push({ field: m.field, text: m.text, at: m.at, len: m.len }); }
      }
      out.push({ id: n.id, type: n.type, value: n.type === 'tx' ? n.txid : n.address, label: n.label || '', score: score, why: why });
    });
    out.sort(function (a, b) { return b.score - a.score || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return { results: out.slice(0, limit), total: out.length };
  }

  /** A short piece of `text` around a match, as { before, hit, after } (with an ellipsis where it was cut). */
  function snippet(text, at, len, max) {
    text = String(text); max = max || 60;
    if (text.length <= max) return { before: text.slice(0, at), hit: text.slice(at, at + len), after: text.slice(at + len) };
    var from = Math.max(0, Math.min(at - Math.floor((max - len) / 2), text.length - max)), to = Math.min(text.length, from + max);
    var s = (from > 0 ? '…' : ''), e = (to < text.length ? '…' : '');
    var a = Math.max(from, at), b = Math.min(to, at + len);
    return { before: s + text.slice(from, a), hit: text.slice(a, b), after: text.slice(b, to) + e };
  }

  return { LIMIT: LIMIT, search: search, snippet: snippet };
}));
