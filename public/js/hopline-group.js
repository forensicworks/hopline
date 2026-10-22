/*
 * Hopline grouping: collapse many similar rows of a list into one line, so a busy wallet does not bury the investigator.
 * Pure functions over plain rows, no DOM, no network, nothing about the graph itself: a group is only a way of showing a list,
 * and every member stays individually reachable (nothing is hidden or dropped).
 *
 * A row is { id, dir, amount (sats), time (unix or null), parties: [ids of the wallets on the other side] }. Rows are grouped when
 *   party   at least `minSize` rows of the same direction share a wallet on the other side ("5 payments to bc1q..."). A row can
 *           name several wallets; the wallet shared by the most rows goes first, so each row lands in at most one group;
 *   small   at least `minSize` of the remaining rows of one direction are under `dustSats` ("12 small payments").
 * Everything else stays a row of its own. Both rules are plain counting: they say how many rows look alike, not what they mean.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineGroup = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = { minSize: 3, dustSats: 10000 };

  /** Numbers about a set of rows: { count, total, min, max, first, last } (first / last = earliest / latest time known, else null). */
  function stats(rows) {
    var s = { count: rows.length, total: 0, min: rows.length ? Infinity : 0, max: 0, first: null, last: null };
    rows.forEach(function (r) {
      s.total += r.amount; if (r.amount < s.min) s.min = r.amount; if (r.amount > s.max) s.max = r.amount;
      if (r.time != null) { if (s.first == null || r.time < s.first) s.first = r.time; if (s.last == null || r.time > s.last) s.last = r.time; }
    });
    return s;
  }

  /**
   * The groups of a list: [{ key, kind: 'party' | 'small', dir, party (id or null), members: [rows] }], largest first.
   * Members keep the order the rows came in. opts: { minSize (default 3), dustSats (default 10000; 0 = no small-amount groups) }.
   */
  function make(rows, opts) {
    opts = opts || {};
    var minSize = Math.max(2, opts.minSize == null ? DEFAULTS.minSize : opts.minSize), dust = opts.dustSats == null ? DEFAULTS.dustSats : opts.dustSats;
    var left = rows.slice(), groups = [];
    function uniq(a) { var seen = {}, out = []; (a || []).forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }

    for (;;) {                                                                        // 1. the wallet shared by the most rows, again and again
      var count = new Map();
      left.forEach(function (r) {
        uniq(r.parties).forEach(function (p) {
          var k = r.dir + '|' + p, c = count.get(k);
          if (!c) { c = { dir: r.dir, party: p, rows: [], total: 0 }; count.set(k, c); }
          c.rows.push(r); c.total += r.amount;
        });
      });
      var best = null;
      count.forEach(function (c) {
        if (c.rows.length < minSize) return;
        if (!best || c.rows.length > best.rows.length || (c.rows.length === best.rows.length && (c.total > best.total || (c.total === best.total && (c.dir + c.party) < (best.dir + best.party))))) best = c;
      });
      if (!best) break;
      var taken = new Set(best.rows);
      groups.push({ key: 'party|' + best.dir + '|' + best.party, kind: 'party', dir: best.dir, party: best.party, members: best.rows.slice() });
      left = left.filter(function (r) { return !taken.has(r); });
    }
    if (dust > 0) {                                                                   // 2. what is left and small
      var byDir = new Map();
      left.forEach(function (r) { if (r.amount < dust) { if (!byDir.has(r.dir)) byDir.set(r.dir, []); byDir.get(r.dir).push(r); } });
      Array.from(byDir.keys()).sort().forEach(function (d) {
        var m = byDir.get(d);
        if (m.length >= minSize) groups.push({ key: 'small|' + d + '|', kind: 'small', dir: d, party: null, members: m });
      });
    }
    return groups;
  }

  /**
   * The display order: `sorted` is the list in the order it is shown; each group appears once, where its first member is, followed by
   * nothing else of its members. Returns [{ type: 'row', row } | { type: 'group', group }], with every group's members put in the
   * order of `sorted` and its numbers in group.stats.
   */
  function layout(sorted, groups) {
    var owner = new Map(), index = new Map();
    sorted.forEach(function (r, i) { index.set(r, i); });
    groups.forEach(function (g) {
      g.members = g.members.filter(function (r) { return index.has(r); }).sort(function (a, b) { return index.get(a) - index.get(b); });
      g.stats = stats(g.members);
      g.members.forEach(function (r) { owner.set(r, g); });
    });
    var out = [], done = new Set();
    sorted.forEach(function (r) {
      var g = owner.get(r);
      if (!g) { out.push({ type: 'row', row: r }); return; }
      if (done.has(g)) return;
      done.add(g); out.push({ type: 'group', group: g });
    });
    return out;
  }

  /**
   * A group shown as ONE vertex on the trace: the vertex and the edge that join it to the vertex it hangs from. They are drawn but never
   * written into the graph (so exports, the report's evidence and the analysis see only what is on the chain).
   *   spec       { id, anchor, dir ('next' | 'prev'), kind, party, members: [ids] }
   *   anchorType 'tx' | 'addr': what the anchor is. The group plays the other part, so the edge has the shape the rest of the page expects:
   *              a group of transactions behind a wallet acts as the transaction, a group of wallets behind a transaction as the wallets.
   *   rows       the members as { id, amount, time } (amounts in sats)
   * Returns { node, edge }; amounts add up, the earliest time is the vertex's time.
   */
  function vertex(spec, anchorType, rows) {
    var st = stats(rows), next = spec.dir === 'next';
    var node = { id: spec.id, type: 'group', virtual: true, anchor: spec.anchor, dir: spec.dir, kind: spec.kind, party: spec.party || null,
                 count: st.count, min: st.min, max: st.max, received: st.total, sent: 0, firstSeen: st.first, lastSeen: st.last,
                 time: st.first, confirmed: true, members: spec.members.slice() };
    var isOut = (anchorType === 'addr') === !next;                                           // an 'out' edge runs from a transaction to a wallet
    var edge = { id: 'grpe:' + spec.id, kind: isOut ? 'out' : 'in', source: next ? spec.anchor : spec.id, target: next ? spec.id : spec.anchor,
                 amount: st.total, txid: spec.id, time: st.first, virtual: true, group: spec.id };
    return { node: node, edge: edge };
  }

  /** Is this the id of a group vertex? */
  function isGroupId(id) { return typeof id === 'string' && /^grp:[0-9]{1,9}$/.test(id); }

  return { make: make, layout: layout, stats: stats, vertex: vertex, isGroupId: isGroupId, DEFAULTS: DEFAULTS };
}));
