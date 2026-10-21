/*
 * Orion trace: build a chain of transactions by hand, one click at a time, starting from a single wallet or
 * transaction. Pure functions over the graph; nothing here touches the DOM or the network.
 *
 * The unit of a click is "one wallet hop":
 *   transaction, forward   -> the wallets (and data outputs) it paid
 *   transaction, backward  -> the wallets that paid into it
 *   wallet, forward        -> the transactions that spent from it AND the wallets those paid
 *   wallet, backward       -> the transactions that paid it AND the wallets that funded those
 * so the picture alternates wallet, transaction, wallet, ... and one click moves one wallet along the money.
 *
 * What is shown is a set of ids (`shown`) that only grows when you ask. Vertices keep the place they were given, and
 * new ones are put next to the vertex that was clicked, in the next column, without landing on anything.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-model.js'));
  else root.OrionTrace = factory(root.OrionModel);
}(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var ID = Model.ID;

  /**
   * The vertices one step away in a direction, merged by id: Map otherId -> {id, type, amount, time, unspent}.
   * unspent: true when an output between the two is still unspent, false when every such output is spent, null when that does not
   * apply (the link is an input) or is not known.
   */
  function neighbours(graph, id, dir) {
    var n = graph.nodes.get(id), out = new Map();
    if (!n) return out;
    function add(other, e) {
      var o = graph.nodes.get(other); if (!o) return;
      var tx = graph.nodes.get(e.kind === 'out' ? e.source : e.target);
      var time = tx && tx.time != null ? tx.time : (e.time != null ? e.time : null);
      var cur = out.get(other), sp = e.kind === 'out' ? (e.spent === false ? 1 : e.spent === true ? 0 : -1) : -1;           // 1 unspent, 0 spent, -1 not applicable / unknown
      if (cur) { cur.amount += e.amount; if (time != null && (cur.time == null || time < cur.time)) cur.time = time; cur._sp = Math.max(cur._sp, sp); }
      else out.set(other, { id: other, type: o.type, amount: e.amount, time: time, _sp: sp });
    }
    graph.edgesOf(id).forEach(function (e) {
      if (n.type === 'tx') {
        if (dir === 'next' && e.kind === 'out' && e.source === id) add(e.target, e);
        else if (dir === 'prev' && e.kind === 'in' && e.target === id) add(e.source, e);
      } else if (n.type === 'addr') {
        if (dir === 'next' && e.kind === 'in' && e.source === id) add(e.target, e);          // a transaction spent from this wallet
        else if (dir === 'prev' && e.kind === 'out' && e.target === id) add(e.source, e);    // a transaction paid this wallet
      }
    });
    out.forEach(function (r) { r.unspent = r._sp === 1 ? true : r._sp === 0 ? false : null; delete r._sp; });
    return out;
  }

  /** Is a row inside the time window { from, to } (unix seconds, either may be null)? A row with no known time is kept: it cannot be ruled out. */
  function inRange(r, range) {
    if (!range || r.time == null) return true;
    if (range.from != null && r.time < range.from) return false;
    if (range.to != null && r.time > range.to) return false;
    return true;
  }

  function sortRows(rows) {
    return rows.sort(function (a, b) { return b.amount - a.amount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  }

  /**
   * What is still hidden in a direction: { ids, known, unknown, outside }.
   *   known    how many hidden neighbours the graph already knows about (inside `range` when one is given)
   *   outside  how many more fall outside the time window `range` { from, to } and are therefore left out
   *   unknown  true when more may exist that have not been loaded (an unloaded transaction; a wallet whose history is
   *            not, or not completely, loaded)
   */
  function hidden(graph, shown, id, dir, range) {
    var n = graph.nodes.get(id);
    if (!n || (n.type !== 'tx' && n.type !== 'addr')) return { ids: [], known: 0, unknown: false, outside: 0 };
    var ids = [], outside = 0;
    neighbours(graph, id, dir).forEach(function (r) { if (shown.has(r.id)) return; if (inRange(r, range)) ids.push(r.id); else outside++; });
    var unknown = n.type === 'tx' ? n.loaded === false : (n.txCount == null || !!n.histNext);
    return { ids: ids, known: ids.length, unknown: unknown, outside: outside };
  }

  /** The label on a handle: "3", "3+" (more may exist), "?" (nothing known yet) or '' (nothing to show). */
  function handleLabel(h) { return h.known > 0 ? String(h.known) + (h.unknown ? '+' : '') : (h.unknown ? '?' : ''); }

  function rowsFor(graph, exclude, id, dir, range) {
    var rows = [];
    neighbours(graph, id, dir).forEach(function (r) { if (!exclude.has(r.id) && inRange(r, range)) rows.push(r); });
    return sortRows(rows);
  }

  /** The hidden vertices one step away in a direction, largest first: rows {id, type, amount, time, unspent}; only those inside the time window `range` when given. */
  function hiddenRows(graph, shown, id, dir, range) { return rowsFor(graph, shown, id, dir, range); }

  /**
   * What is hidden in a direction, in numbers, so a click can be weighed before it is made:
   * { count, total (sats), largest (sats), first, last (earliest / latest time known, or null) }.
   */
  function summary(graph, shown, id, dir, range) {
    var rows = rowsFor(graph, shown, id, dir, range), out = { count: rows.length, total: 0, largest: 0, first: null, last: null };
    rows.forEach(function (r) {
      out.total += r.amount; if (r.amount > out.largest) out.largest = r.amount;
      if (r.time != null) { if (out.first == null || r.time < out.first) out.first = r.time; if (out.last == null || r.time > out.last) out.last = r.time; }
    });
    return out;
  }

  /**
   * Decide what one click reveals.
   *   returns { primary: [rows], secondary: [{parent, rows}], needLoad: [txid], remaining, remainingInner }
   * primary    the first-step vertices (the wallets a transaction paid; the transactions a wallet spent in)
   * secondary  for a wallet, the wallets each of those transactions paid (needs the transactions to be loaded)
   * needLoad   transactions that must be fetched before `secondary` can be known: call again after loading
   * opts: { limit (primary, default 10), inner (per transaction, default 8), only (a Set of ids: show just these),
   *         range ({ from, to }: leave out what falls outside this time window) }
   */
  function plan(graph, shown, id, dir, opts) {
    opts = opts || {};
    var limit = Math.max(1, opts.limit || 10), inner = Math.max(1, opts.inner || 8);
    var n = graph.nodes.get(id);
    var res = { primary: [], secondary: [], needLoad: [], remaining: 0, remainingInner: 0 };
    if (!n || (n.type !== 'tx' && n.type !== 'addr')) return res;
    var rows = rowsFor(graph, shown, id, dir, opts.range);
    if (opts.only) rows = rows.filter(function (r) { return opts.only.has(r.id); });          // the user chose which ones to show
    res.primary = rows.slice(0, limit);
    res.remaining = Math.max(0, rows.length - limit);
    if (n.type === 'addr') {
      var taken = new Set(shown); res.primary.forEach(function (r) { taken.add(r.id); });
      res.primary.forEach(function (r) {
        var t = graph.nodes.get(r.id);
        if (!t || t.type !== 'tx') return;
        if (t.loaded === false) { res.needLoad.push(t.txid); return; }
        var more = rowsFor(graph, taken, r.id, dir, opts.range);
        var take = more.slice(0, inner);
        res.remainingInner += Math.max(0, more.length - inner);
        take.forEach(function (x) { taken.add(x.id); });
        if (take.length) res.secondary.push({ parent: r.id, rows: take });
      });
    }
    return res;
  }

  // ---- placing new vertices -------------------------------------------------------------------
  /**
   * Positions for the vertices a click reveals. `pos` (Map id -> {x,y}) is what is already on the canvas and is not
   * changed. New vertices go in the next column (to the right for 'next', left for 'prev'), centred on the vertex that
   * was clicked, moved up or down just enough not to land on anything. Returns Map id -> {x,y} for the new ones only.
   */
  function place(pos, anchorId, dir, p, opts) {
    opts = opts || {};
    var colGap = opts.colGap || 200, rowGap = opts.rowGap || 58, sign = dir === 'prev' ? -1 : 1;
    var placed = new Map(), anchor = pos.get(anchorId) || { x: 0, y: 0 };

    function taken(x, y) {
      var hit = false;
      function check(q) { if (Math.abs(q.x - x) < colGap * 0.45 && Math.abs(q.y - y) < rowGap * 0.85) hit = true; }
      pos.forEach(check); if (!hit) placed.forEach(check);
      return hit;
    }
    function slot(x, wantY) {
      for (var k = 0; k < 600; k++) {
        var off = (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2)) * rowGap;
        if (!taken(x, wantY + off)) return wantY + off;
      }
      return wantY;
    }
    function group(parent, rows, x) {
      rows.forEach(function (r, i) {
        if (pos.has(r.id) || placed.has(r.id)) return;
        var want = parent.y + (i - (rows.length - 1) / 2) * rowGap;
        placed.set(r.id, { x: x, y: slot(x, want) });
      });
    }
    group(anchor, p.primary, anchor.x + sign * colGap);
    p.secondary.forEach(function (s) {
      var par = pos.get(s.parent) || placed.get(s.parent) || anchor;
      group(par, s.rows, par.x + sign * colGap);
    });
    return placed;
  }

  // ---- provenance (for "hide this branch") and undo ---------------------------------------------
  /** All ids revealed, directly or through others, because of `id`. prov: Map id -> {via, dir}. */
  function descendants(prov, id) {
    var kids = new Map();
    prov.forEach(function (p, child) { if (!kids.has(p.via)) kids.set(p.via, []); kids.get(p.via).push(child); });
    var out = [], queue = [id], seen = new Set([id]);
    while (queue.length) {
      var u = queue.shift();
      (kids.get(u) || []).forEach(function (c) { if (!seen.has(c)) { seen.add(c); out.push(c); queue.push(c); } });
    }
    return out;
  }

  /** The ids a plan reveals, in order, with what revealed each: [{id, via, dir}]. */
  function revealed(p, anchorId, dir) {
    var out = [];
    p.primary.forEach(function (r) { out.push({ id: r.id, via: anchorId, dir: dir }); });
    p.secondary.forEach(function (s) { s.rows.forEach(function (r) { out.push({ id: r.id, via: s.parent, dir: dir }); }); });
    return out;
  }

  return { neighbours: neighbours, inRange: inRange, hidden: hidden, rows: hiddenRows, summary: summary, handleLabel: handleLabel, plan: plan, place: place, descendants: descendants, revealed: revealed };
}));
