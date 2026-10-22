/*
 * Hopline layouts. Each takes (graph, visible, opts) and returns
 *   { pos: Map<id,{x,y}>, axis: null | { tMin, tMax, x0, x1, pendingX } }
 * x grows to the right, y downwards. Pure functions; deterministic for the same input.
 *
 *   flow      left-to-right in the direction money moves, ordered to reduce crossings
 *   timeline  x = confirmation time, y = lanes packed so nothing overlaps
 *   force     spring layout; starts from existing positions so it can be re-run to tidy up. With opts.radius(id) -> pixels
 *             each shape takes room by its size: bigger shapes push their neighbours further away and never overlap them
 *   timeamount  x = confirmation time (as timeline), y = amount on a log scale (bigger is higher), nothing overlapping
 *   timeforce   x = confirmation time (as timeline), y = a spring layout: connected vertices are pulled to the same height
 *               and unconnected ones pushed apart, so a chain runs straight across and branches fan out above and below
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // deterministic PRNG (mulberry32) so layouts and tests are repeatable
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function visibleEdges(graph, visible) {
    var out = [];
    visible.edges.forEach(function (id) { out.push(graph.edges.get(id)); });
    return out;
  }

  // ---- flow -----------------------------------------------------------------------------------
  function layoutFlow(graph, visible, opts) {
    opts = opts || {};
    var dx = opts.layerGap || 170, dy = opts.rowGap || 46;
    var ids = Array.from(visible.nodes), edges = visibleEdges(graph, visible);
    var preds = new Map(), succs = new Map();
    ids.forEach(function (id) { preds.set(id, []); succs.set(id, []); });
    edges.forEach(function (e) { succs.get(e.source).push(e.target); preds.get(e.target).push(e.source); });

    // longest-path layering (Kahn). Address reuse makes real data cyclic (an address that is spent from and paid
    // change to its own address), so when the queue runs dry the node with the fewest unresolved inputs is
    // released and its remaining inbound edges are treated as back edges.
    var layer = new Map(), indeg = new Map(), queue = [], done = new Set();
    ids.forEach(function (id) { indeg.set(id, preds.get(id).length); layer.set(id, 0); if (!indeg.get(id)) queue.push(id); });
    var sortedIds = ids.slice().sort();
    while (done.size < ids.length) {
      if (!queue.length) {
        var pick = null;
        sortedIds.forEach(function (id) { if (!done.has(id) && (pick == null || indeg.get(id) < indeg.get(pick))) pick = id; });
        queue.push(pick);
      }
      var u = queue.shift();
      if (done.has(u)) continue;
      done.add(u);
      succs.get(u).forEach(function (v) {
        if (done.has(v)) return;                                    // back edge
        if (layer.get(u) + 1 > layer.get(v)) layer.set(v, layer.get(u) + 1);
        indeg.set(v, indeg.get(v) - 1);
        if (!indeg.get(v)) queue.push(v);
      });
    }

    var cols = new Map();
    ids.forEach(function (id) { var l = layer.get(id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(id); });
    var order = Array.from(cols.keys()).sort(function (a, b) { return a - b; });

    // initial order: stable by id; then barycentre sweeps down and up
    var rank = new Map();
    order.forEach(function (l) { cols.get(l).sort(); cols.get(l).forEach(function (id, i) { rank.set(id, i); }); });
    function bary(id, nbrs) {
      var xs = nbrs.get(id).map(function (n) { return rank.get(n); });
      return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : rank.get(id);
    }
    for (var sweep = 0; sweep < 4; sweep++) {
      var seq = sweep % 2 === 0 ? order : order.slice().reverse(), nb = sweep % 2 === 0 ? preds : succs;
      seq.forEach(function (l) {
        var col = cols.get(l);
        var keyed = col.map(function (id) { return { id: id, k: bary(id, nb) }; });
        keyed.sort(function (a, b) { return a.k - b.k || (a.id < b.id ? -1 : 1); });
        col.length = 0; keyed.forEach(function (o, i) { col.push(o.id); rank.set(o.id, i); });
      });
    }

    var pos = new Map();
    order.forEach(function (l, ci) {
      var col = cols.get(l), h = (col.length - 1) * dy;
      col.forEach(function (id, i) { pos.set(id, { x: ci * dx, y: i * dy - h / 2 }); });
    });
    return { pos: pos, axis: null };
  }

  // ---- timeline -------------------------------------------------------------------------------
  /**
   * Maps times to x. 'proportional': x is linear in time. 'compact': gaps are limited to `cap` pixels (and spacing
   * between distinct times to at least `minPx`), so one outlier years later cannot squash a burst of activity into
   * a few pixels. Compressed gaps are reported in `breaks` so the axis can mark them honestly.
   */
  function timeMapper(times, mode, width, minPx, cap) {
    var ts = Array.from(new Set(times)).sort(function (a, b) { return a - b; });
    var tMin = ts.length ? ts[0] : 0, tMax = ts.length ? ts[ts.length - 1] : 0;
    var res = { tMin: tMin, tMax: tMax, mode: mode, pxPerSec: 0, knots: [], breaks: [], x1: 0 };
    if (ts.length < 2) { res.knots = ts.map(function (t) { return { t: t, x: 0 }; }); res.xOf = function () { return 0; }; res.tAt = function () { return ts.length ? { t: tMin, gap: false } : null; }; return res; }
    var span = tMax - tMin, pps = width / span;
    if (mode !== 'compact') {
      res.pxPerSec = pps; res.x1 = width;
      res.knots = ts.map(function (t) { return { t: t, x: (t - tMin) * pps }; });
      res.xOf = function (t) { return (t - tMin) * pps; };
      res.tAt = function (x) { return x < 0 || x > res.x1 ? null : { t: tMin + x / pps, gap: false }; };
      return res;
    }
    // A gap is "long" when it is more than 8x the median gap. Long gaps are squeezed to `cap` pixels; the rest share
    // the remaining width in proportion to elapsed time (never narrower than minPx, so neighbours stay apart).
    var dts = ts.slice(1).map(function (t, i) { return t - ts[i]; });
    var sorted = dts.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    var longGap = dts.map(function (d) { return d > 8 * median; });
    var nLong = longGap.filter(Boolean).length;
    var normalSeconds = dts.reduce(function (s, d, i) { return longGap[i] ? s : s + d; }, 0);
    pps = Math.max(width - nLong * cap, width / 2) / normalSeconds;
    var w = dts.map(function (d, i) { return longGap[i] ? Math.min(cap, d * pps) : Math.max(minPx, d * pps); }), x = [0];
    w.forEach(function (d) { x.push(x[x.length - 1] + d); });
    res.pxPerSec = pps; res.x1 = x[x.length - 1];
    res.knots = ts.map(function (t, i) { return { t: t, x: x[i] }; });
    dts.forEach(function (d, i) { if (longGap[i]) res.breaks.push({ x0: x[i], x1: x[i + 1], seconds: d, t0: ts[i], t1: ts[i + 1] }); });
    res.tAt = function (px) {                                          // the time at a place on the line; `gap` when it falls inside a gap that was shortened (the time there is only interpolated)
      if (px < 0 || px > res.x1) return null;
      var lo = 0, hi = ts.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (x[mid] <= px) lo = mid; else hi = mid; }
      var span = x[hi] - x[lo];
      return { t: span > 0 ? ts[lo] + (px - x[lo]) / span * (ts[hi] - ts[lo]) : ts[lo], gap: !!longGap[lo] };
    };
    res.xOf = function (t) {
      if (t <= tMin) return 0;
      if (t >= tMax) return res.x1;
      var lo = 0, hi = ts.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
      return x[lo] + (t - ts[lo]) / (ts[hi] - ts[lo]) * (x[hi] - x[lo]);
    };
    return res;
  }

  function layoutTimeline(graph, visible, opts) {
    opts = opts || {};
    var width = opts.width || 1600, gap = opts.gap || 70, laneH = opts.laneHeight || 40, minSep = opts.minSep || 54;
    var ids = Array.from(visible.nodes), edges = visibleEdges(graph, visible);

    var times = [];
    ids.forEach(function (id) { var n = graph.nodes.get(id); if (n.type === 'tx' && n.time != null) times.push(n.time); });
    var tm = timeMapper(times, opts.scale === 'compact' ? 'compact' : 'proportional', width, opts.minPx || 40, opts.gapCap || Math.max(120, width * 0.1));
    var tMin = tm.tMin, tMax = tm.tMax, xOf = tm.xOf;
    var pendingX = tm.x1 + gap * 1.5;

    var adjacent = new Map();
    ids.forEach(function (id) { adjacent.set(id, []); });
    edges.forEach(function (e) { adjacent.get(e.source).push(e.target); adjacent.get(e.target).push(e.source); });

    var x = new Map();
    // 1. transactions with a known time
    ids.forEach(function (id) {
      var n = graph.nodes.get(id);
      if (n.type === 'tx') {
        if (n.time != null) x.set(id, xOf(n.time));
        else if (n.confirmed === false) x.set(id, pendingX);
      }
    });
    // 2. other vertices sit between the transaction that creates them and the one that spends them
    var order = ids.filter(function (id) { return !x.has(id); }).sort();
    function resolve(id) {
      var n = graph.nodes.get(id), before = [], after = [];
      graph.edgesOf(id).forEach(function (e) {
        if (!visible.edges.has(e.id)) return;
        if (e.target === id) { var s = x.get(e.source); if (s != null) before.push(s); }
        else { var t = x.get(e.target); if (t != null) after.push(t); }
      });
      if (before.length && after.length) return (Math.max.apply(null, before) + Math.min.apply(null, after)) / 2;
      if (before.length) return Math.max.apply(null, before) + gap;
      if (after.length) return Math.min.apply(null, after) - gap;
      return null;
    }
    // addresses/data/coinbase first (they hang off transactions), then unknown-time stubs, repeated until stable
    for (var pass = 0; pass < 4; pass++) {
      order.forEach(function (id) {
        if (x.has(id)) return;
        var v = resolve(id);
        if (v != null) x.set(id, v);
      });
    }
    var fallback = 0;
    order.forEach(function (id) { if (!x.has(id)) { x.set(id, fallback); fallback += gap; } });

    // 3. lane packing: left to right, each vertex takes the free lane closest to where its neighbours are
    var sorted = ids.slice().sort(function (a, b) { return x.get(a) - x.get(b) || (a < b ? -1 : 1); });
    var laneEnd = [];                    // lane index (0, 1, -1, 2, -2 ... mapped to slots) -> last x used
    var laneOf = new Map();
    function slotToLane(k) { return k % 2 === 0 ? k / 2 : -(k + 1) / 2; }
    function laneToSlot(l) { return l >= 0 ? l * 2 : -l * 2 - 1; }
    sorted.forEach(function (id) {
      var placed = adjacent.get(id).filter(function (n) { return laneOf.has(n); }).map(function (n) { return laneOf.get(n); });
      var want = placed.length ? Math.round(placed.reduce(function (a, b) { return a + b; }, 0) / placed.length) : 0;
      var best = null;
      for (var d = 0; d < sorted.length + 2 && best == null; d++) {
        var cands = d === 0 ? [want] : [want + d, want - d];
        for (var c = 0; c < cands.length; c++) {
          var slot = laneToSlot(cands[c]);
          if (laneEnd[slot] == null || x.get(id) - laneEnd[slot] >= minSep) { best = cands[c]; break; }
        }
      }
      laneEnd[laneToSlot(best)] = x.get(id);
      laneOf.set(id, best);
    });

    var pos = new Map();
    ids.forEach(function (id) { pos.set(id, { x: x.get(id), y: laneOf.get(id) * laneH }); });
    return { pos: pos, axis: { tMin: tMin, tMax: tMax, x0: 0, x1: tm.x1, pendingX: pendingX, pxPerSec: tm.pxPerSec, mode: tm.mode, knots: tm.knots, breaks: tm.breaks, xOf: xOf, tAt: tm.tAt,
                               hasPending: ids.some(function (id) { var n = graph.nodes.get(id); return n.type === 'tx' && n.time == null && n.confirmed === false; }) } };
  }

  // ---- force ----------------------------------------------------------------------------------
  function layoutForce(graph, visible, opts) {
    opts = opts || {};
    var ids = Array.from(visible.nodes).sort(), edges = visibleEdges(graph, visible);
    var n = ids.length, rand = rng(opts.seed == null ? 1 : opts.seed);
    var k = opts.spacing || 70;
    var idx = new Map(); ids.forEach(function (id, i) { idx.set(id, i); });
    var px = new Float64Array(n), py = new Float64Array(n), dxs = new Float64Array(n), dys = new Float64Array(n);
    var start = opts.start;                                           // Map id -> {x,y}: continue from where things are
    ids.forEach(function (id, i) {
      var p = start && start.get(id);
      if (p) { px[i] = p.x; py[i] = p.y; }
      else { var r = k * Math.sqrt(n) * 0.5 * rand(), a = rand() * Math.PI * 2; px[i] = Math.cos(a) * r; py[i] = Math.sin(a) * r; }
    });
    var links = edges.map(function (e) { return [idx.get(e.source), idx.get(e.target)]; });
    var rad = new Float64Array(n), sized = typeof opts.radius === 'function';
    if (sized) ids.forEach(function (id, i) { rad[i] = Math.max(0, Number(opts.radius(id)) || 0); });
    var pad = opts.pad == null ? 8 : opts.pad;
    var iters = opts.iterations || Math.max(n > 2000 ? 10 : 30, Math.min(300, Math.floor(4e7 / Math.max(1, n * n))));
    var temp = k * 3, cool = temp / (iters + 1);
    for (var it = 0; it < iters; it++) {
      dxs.fill(0); dys.fill(0);
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var ddx = px[i] - px[j], ddy = py[i] - py[j];
          var d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) { ddx = rand() - 0.5; ddy = rand() - 0.5; d2 = ddx * ddx + ddy * ddy + 0.01; }
          var room = sized ? rad[i] + rad[j] : 0, kk = (k + room) * (k + room);   // two big shapes need more room between them than two small ones
          var f = kk / d2;                                            // repulsion ~ k^2/d, applied along the unit vector
          dxs[i] += ddx * f; dys[i] += ddy * f; dxs[j] -= ddx * f; dys[j] -= ddy * f;
        }
      }
      links.forEach(function (l) {
        var a = l[0], b = l[1], ex = px[a] - px[b], ey = py[a] - py[b];
        var d = Math.sqrt(ex * ex + ey * ey) || 0.01, f = d / k;      // attraction ~ d^2/k along the unit vector
        dxs[a] -= ex * f; dys[a] -= ey * f; dxs[b] += ex * f; dys[b] += ey * f;
      });
      for (var m = 0; m < n; m++) {                                    // gentle pull to the centre keeps components together
        dxs[m] -= px[m] * 0.06; dys[m] -= py[m] * 0.06;
        var len = Math.sqrt(dxs[m] * dxs[m] + dys[m] * dys[m]) || 0.01, step = Math.min(len, temp);
        px[m] += dxs[m] / len * step; py[m] += dys[m] / len * step;
      }
      temp -= cool;
    }
    if (sized && n <= 800) {                                           // finally, no overlaps: push apart whatever still touches (a few quick passes)
      for (var pass = 0; pass < 40; pass++) {
        var moved = false;
        for (var a = 0; a < n; a++) {
          for (var b = a + 1; b < n; b++) {
            var ex = px[a] - px[b], ey = py[a] - py[b], dist = Math.sqrt(ex * ex + ey * ey), need = rad[a] + rad[b] + pad;
            if (dist >= need) continue;
            if (dist < 0.01) { ex = rand() - 0.5; ey = rand() - 0.5; dist = Math.sqrt(ex * ex + ey * ey) || 1; }
            var push = (need - dist) / 2 + 0.5, ux = ex / dist, uy = ey / dist;
            px[a] += ux * push; py[a] += uy * push; px[b] -= ux * push; py[b] -= uy * push; moved = true;
          }
        }
        if (!moved) break;
      }
    }
    var pos = new Map();
    ids.forEach(function (id, i) { pos.set(id, { x: px[i], y: py[i] }); });
    return { pos: pos, axis: null };
  }

  // ---- time + force ----------------------------------------------------------------------------
  /**
   * Time along x exactly as the timeline places it, and a force layout up and down: only y moves. Edges pull the vertices
   * they join to the same height, vertices that are close in time push each other apart, and what is left is resolved so
   * nothing overlaps (shapes take room by opts.radius(id), as in the force layout). opts.start (id -> {x, y}) continues
   * from where things are, so adding to the picture does not reshuffle it.
   */
  function layoutTimeForce(graph, visible, opts) {
    opts = opts || {};
    var base = layoutTimeline(graph, visible, opts), ids = Array.from(visible.nodes).sort(), edges = visibleEdges(graph, visible);
    var n = ids.length, k = opts.spacing || 64, pad = opts.pad == null ? 8 : opts.pad, rand = rng(opts.seed == null ? 1 : opts.seed);
    var idx = new Map(); ids.forEach(function (id, i) { idx.set(id, i); });
    var xs = new Float64Array(n), ys = new Float64Array(n), rad = new Float64Array(n), dy = new Float64Array(n), start = opts.start, sized = typeof opts.radius === 'function', maxRad = 0;
    ids.forEach(function (id, i) {
      var p = base.pos.get(id), s = start && start.get(id);
      xs[i] = p.x; ys[i] = s ? s.y + (rand() - 0.5) * 0.5 : (rand() - 0.5) * k * 0.5;   // from where it was, else near the middle, a little apart (the forces decide which way)
      rad[i] = sized ? Math.max(0, Number(opts.radius(id)) || 0) : 0; if (rad[i] > maxRad) maxRad = rad[i];
    });
    var links = edges.map(function (e) { return [idx.get(e.source), idx.get(e.target)]; });
    var order = ids.map(function (id, i) { return i; }).sort(function (a, b) { return xs[a] - xs[b] || a - b; });      // left to right: only neighbours in time are compared
    var reach = k + 2 * maxRad;                                                          // beyond this in x two vertices never interact
    var iters = opts.iterations || Math.max(40, Math.min(220, Math.floor(2e7 / Math.max(1, n * n)))), temp = k * 1.5, cool = temp / (iters + 1);
    for (var it = 0; it < iters; it++) {
      dy.fill(0);
      for (var a = 0; a < n; a++) {
        var i = order[a];
        for (var b = a + 1; b < n; b++) {
          var j = order[b], ddx = xs[i] - xs[j];
          if (-ddx > reach) break;                                                        // sorted by x: nothing further right is close enough
          var ddy = ys[i] - ys[j];
          if (Math.abs(ddy) < 0.01) ddy = (rand() < 0.5 ? 1 : -1) * (0.01 + rand() * 0.5);        // a tie: either way, so a chain is not tilted by always pushing the same direction
          var want = k + rad[i] + rad[j], d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d >= want) continue;                                                        // a soft core: vertices only push each other when they are closer than `want`
          var push = (want - d) * 1.5 * (ddy / Math.max(d, 1));
          dy[i] += push; dy[j] -= push;
        }
      }
      links.forEach(function (l) { var ey = ys[l[0]] - ys[l[1]]; dy[l[0]] -= ey * 0.4; dy[l[1]] += ey * 0.4; });    // edges pull their ends to the same height
      for (var m = 0; m < n; m++) {
        dy[m] -= ys[m] * 0.04;                                                            // a gentle pull to the middle keeps separate chains together
        var len = Math.abs(dy[m]) || 0.0001;
        ys[m] += dy[m] / len * Math.min(len, temp);
      }
      temp -= cool;
    }
    for (var pass = 0; pass < 60; pass++) {                                               // finally, no overlaps: x is fixed, so whatever touches is moved up or down
      var moved = false;
      for (var a2 = 0; a2 < n; a2++) {
        var p = order[a2];
        for (var b2 = a2 + 1; b2 < n; b2++) {
          var q = order[b2], dx = xs[q] - xs[p], need = rad[p] + rad[q] + pad;
          if (dx > 2 * maxRad + pad) break;
          if (dx >= need) continue;
          var needY = Math.sqrt(need * need - dx * dx), gapY = ys[p] - ys[q];
          if (Math.abs(gapY) >= needY) continue;
          var dir = gapY === 0 ? (p < q ? 1 : -1) : (gapY > 0 ? 1 : -1), push = (needY - Math.abs(gapY)) / 2 + 0.25;
          ys[p] += dir * push; ys[q] -= dir * push; moved = true;
        }
      }
      if (!moved) break;
    }
    var pos = new Map();
    ids.forEach(function (id, i) { pos.set(id, { x: xs[i], y: ys[i] }); });
    return { pos: pos, axis: base.axis };
  }

  // ---- time x amount --------------------------------------------------------------------------
  /**
   * What a vertex stands for in the amount layout and in "select by amount": a transaction's total output, otherwise the
   * largest single movement among the visible edges that touch it (so a wallet sits level with what it received).
   */
  function vertexAmount(graph, visible, id) {
    var n = graph.nodes.get(id);
    if (n && n.type === 'tx' && n.loaded && n.valueOut != null) return n.valueOut;
    var best = 0;
    graph.edgesOf(id).forEach(function (e) { if ((!visible || visible.edges.has(e.id)) && e.amount > best) best = e.amount; });
    return best;
  }

  function fmtAmount(sats) {
    if (sats < 1e4) return String(sats).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' sat';
    return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BTC';
  }

  /**
   * Time along x exactly as the timeline places it (compact or proportional), amount up the page on a log scale, so big
   * movements stand high and a burst of small ones sits low. Vertices that would land on each other are moved up or down
   * to the nearest free place. The axis gains `yTicks` ([{y, label}], one per power of ten) for the amount scale.
   */
  function layoutTimeAmount(graph, visible, opts) {
    opts = opts || {};
    var base = layoutTimeline(graph, visible, opts), ids = Array.from(visible.nodes);
    var height = opts.height || 560, stepY = opts.stepY || 30, minDx = opts.minSep || 70;
    var amt = new Map(), lo = Infinity, hi = -Infinity;
    ids.forEach(function (id) {
      var a = vertexAmount(graph, visible, id), l = Math.log10(1 + a);
      amt.set(id, a); if (l < lo) lo = l; if (l > hi) hi = l;
    });
    function yOf(sats) { return hi > lo ? -(Math.log10(1 + sats) - lo) / (hi - lo) * height : 0; }
    var order = ids.slice().sort(function (a, b) { return base.pos.get(a).x - base.pos.get(b).x || amt.get(b) - amt.get(a) || (a < b ? -1 : 1); });
    var placed = [], pos = new Map();
    order.forEach(function (id) {
      var x = base.pos.get(id).x, want = yOf(amt.get(id)), y = want;
      for (var k = 0; k < 2000; k++) {
        var cand = want + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * stepY), clash = false;
        for (var i = placed.length - 1; i >= 0 && x - placed[i].x < minDx; i--) { if (Math.abs(placed[i].y - cand) < stepY * 0.9) { clash = true; break; } }
        if (!clash) { y = cand; break; }
      }
      placed.push({ x: x, y: y }); pos.set(id, { x: x, y: y });
    });
    var ticks = [];
    if (hi > lo) for (var k = Math.ceil(lo); k <= Math.floor(hi) && ticks.length < 14; k++) { var s = Math.pow(10, k); ticks.push({ sats: s, y: yOf(s), label: fmtAmount(s) }); }
    return { pos: pos, axis: Object.assign({}, base.axis, { yTicks: ticks }) };
  }

  function layout(name, graph, visible, opts) {
    if (name === 'timeforce') return layoutTimeForce(graph, visible, opts);
    if (name === 'timeamount') return layoutTimeAmount(graph, visible, opts);
    if (name === 'timeline') return layoutTimeline(graph, visible, opts);
    if (name === 'force') return layoutForce(graph, visible, opts);
    return layoutFlow(graph, visible, opts);
  }

  /** Bounding box of positions: {minX,minY,maxX,maxY}; null if empty. */
  function bounds(pos) {
    var b = null;
    pos.forEach(function (p) {
      if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      else { if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y; }
    });
    return b;
  }

  return { layout: layout, timeMapper: timeMapper, layoutFlow: layoutFlow, layoutTimeline: layoutTimeline, layoutForce: layoutForce, layoutTimeAmount: layoutTimeAmount, layoutTimeForce: layoutTimeForce, vertexAmount: vertexAmount, bounds: bounds, rng: rng };
}));
