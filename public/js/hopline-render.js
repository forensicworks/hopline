/*
 * Hopline Canvas 2D renderer: pan, zoom, drag, hover, selection, time axis, labels.
 * It draws what it is given (graph + visible set + positions + style) and reports interaction through callbacks.
 * No data is ever put into the DOM as HTML: everything is drawn on the canvas or handed to the host as plain values.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-style.js'));
  else root.HoplineRender = factory(root.HoplineStyle);
}(typeof self !== 'undefined' ? self : this, function (Style) {
  'use strict';

  var DAY = 86400;
  // [seconds, unit] - unit 'm' means calendar months, 'y' calendar years, otherwise seconds aligned to the epoch
  var STEPS = [[60, 's'], [300, 's'], [900, 's'], [3600, 's'], [3 * 3600, 's'], [6 * 3600, 's'], [12 * 3600, 's'], [DAY, 's'], [2 * DAY, 's'],
               [7 * DAY, 's'], [14 * DAY, 's'], [1, 'm'], [3, 'm'], [6, 'm'], [1, 'y'], [2, 'y'], [5, 'y'], [10, 'y'], [20, 'y']];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function labelFor(t, step) {
    var d = new Date(t * 1000), y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
    if (step[1] === 'y') return '' + y;
    if (step[1] === 'm') return y + '-' + mo;
    if (step[0] < DAY) return mo + '-' + da + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return y + '-' + mo + '-' + da;
  }

  /**
   * Axis ticks for a time span. pxPerSec is the SCREEN scale (world scale times zoom); minPx = least spacing.
   * Returns [{t, label}] sorted by t. Empty when the scale is degenerate.
   */
  function niceTicks(tMin, tMax, pxPerSec, minPx) {
    if (!(pxPerSec > 0) || !(tMax >= tMin)) return [];
    var step = STEPS[STEPS.length - 1];
    for (var i = 0; i < STEPS.length; i++) {
      var secs = STEPS[i][1] === 's' ? STEPS[i][0] : STEPS[i][1] === 'm' ? STEPS[i][0] * 30.4 * DAY : STEPS[i][0] * 365.25 * DAY;
      if (secs * pxPerSec >= minPx) { step = STEPS[i]; break; }
    }
    var out = [], t;
    if (step[1] === 's') {
      for (t = Math.ceil(tMin / step[0]) * step[0]; t <= tMax && out.length < 400; t += step[0]) out.push({ t: t, label: labelFor(t, step) });
    } else {
      var d = new Date(tMin * 1000), y = d.getUTCFullYear(), m = step[1] === 'y' ? 0 : d.getUTCMonth();
      var inc = step[1] === 'y' ? step[0] * 12 : step[0];
      if (step[1] === 'y') y = Math.floor(y / step[0]) * step[0]; else m = Math.floor(m / inc) * inc;
      var guard = 0;
      for (var months = y * 12 + m; guard < 400; months += inc, guard++) {
        t = Date.UTC(Math.floor(months / 12), months % 12, 1) / 1000;
        if (t > tMax) break;
        if (t >= tMin) out.push({ t: t, label: labelFor(t, step) });
      }
    }
    return out;
  }

  /** Distance from point p to segment ab (all {x,y}). */
  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  var AXIS_H = 22;                                                           // height of the time axis band at the top of the canvas, in pixels

  function Renderer(canvas, callbacks) {
    var self = this;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks || {};
    this.view = { x: 0, y: 0, k: 1 };
    this.data = null;
    this.cur = new Map();
    this.target = new Map();
    this.anim = null;
    this.hover = { node: null, edge: null };
    this.highlight = null;                    // a vertex outlined from outside the canvas (a list row under the pointer), without selecting it
    this.chain = null;                        // a peel chain picked out from outside: { ids, index: Map(id -> step), path: Set(edge id), pay: Set(edge id), color }
    this.axisPointer = null;                  // x of the pointer while it is over the time axis (top of the canvas): the axis then reads out the time there
    this.insets = { bottom: 0 };              // canvas rows covered by overlays (the step bar): fit() and centerOn() keep clear of them
    this.handleRects = [];                    // expand handles drawn this frame (trace layout): {id, dir, x, y, w, h, tip}
    this.autoFit = false;                     // true while the view is the result of fit(): it is then refitted when the canvas changes size
    this.selected = new Set();
    this.beacon = null;                       // { ids, t0, ms }: vertices that say "here" for a few seconds (a breathing glow and a ring that spreads), see pulse()
    this.boxMode = false;                     // true: dragging the background draws a box that selects what it covers (Shift-drag does it either way)
    this.box = null;                          // the box being drawn: {x0, y0, x1, y1} in canvas pixels
    this.dirty = true;
    this.dpr = 1;
    this.drag = null;
    this.theme = { bg: '#1c141d', text: '#f2f2f2', dim: '#8d7f8d', grid: 'rgba(242,242,242,0.07)', edge: 'rgba(174,231,248,0.42)', accent: '#AEE7F8', select: '#ffffff', known: '#f2c94c' };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', function (e) { self._down(e); });
    canvas.addEventListener('pointermove', function (e) { self._move(e); });
    canvas.addEventListener('pointerup', function (e) { self._up(e); });
    canvas.addEventListener('pointercancel', function (e) { self._up(e, true); });
    canvas.addEventListener('pointerleave', function () { if (self.axisPointer != null) { self.axisPointer = null; self.dirty = true; } if (!self.drag) self._setHover(null, null, null); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); self._wheel(e); }, { passive: false });
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var h = self._pick(self._local(e));
      if (self.cb.onContext) self.cb.onContext(h.node, h.edge, { x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener('dblclick', function (e) {
      var h = self._pick(self._local(e));
      if (h.node && self.cb.onExpand) self.cb.onExpand(h.node);
    });
    this.resize();
    (function loop() { self._frame(); (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(loop, 16); })();
  }

  Renderer.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect(), oldW = this.w, oldH = this.h;
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height));
    if (oldW && oldH) { this.view.x += (this.w - oldW) / 2; this.view.y += (this.h - oldH) / 2; }   // what was in the middle stays in the middle
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  };

  Renderer.prototype.invalidate = function () { this.dirty = true; };

  /** d = { graph, visible, style, known, axis, range:{from,to}, showLabels, lockX(id) -> true for a vertex that may only be dragged up and down (Shift frees it) } */
  Renderer.prototype.setData = function (d) { this.data = d; if (!d || !d.axis) this.axisPointer = null; this.dirty = true; };

  Renderer.prototype.setSelection = function (ids) { this.selected = new Set(ids || []); this.dirty = true; };

  /** Move the displayed positions to `pos`; animated unless `instant`. Vertices not in `pos` keep their old place. */
  Renderer.prototype.setPositions = function (pos, instant) {
    var self = this, fresh = new Map();
    pos.forEach(function (p, id) { fresh.set(id, { x: p.x, y: p.y }); });
    if (instant || !this.cur.size) {
      this.cur = fresh; this.target = new Map(); this.anim = null;
    } else {
      // vertices that appear for the first time start at a neighbour (or their target) instead of flying in from the origin
      fresh.forEach(function (p, id) { if (!self.cur.has(id)) self.cur.set(id, { x: p.x, y: p.y }); });
      var from = new Map(); self.cur.forEach(function (p, id) { from.set(id, { x: p.x, y: p.y }); });
      this.target = fresh; this.anim = { t0: performance.now(), ms: 350, from: from };
    }
    this.dirty = true;
  };

  Renderer.prototype.positionOf = function (id) { return this.cur.get(id) || null; };

  Renderer.prototype.fit = function (padding) {
    if (!this.data) return;
    var rect = this.canvas.getBoundingClientRect();                      // panels may have opened since the last resize event
    if (Math.round(rect.width) !== this.w || Math.round(rect.height) !== this.h) this.resize();
    var pad = padding == null ? (this.fitPad || 60) : padding, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false, self = this;
    var src = this.anim && this.target.size ? this.target : this.cur;
    this.data.visible.nodes.forEach(function (id) {
      var p = src.get(id) || self.cur.get(id); if (!p) return; any = true;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    this.autoFit = true;
    if (!any) { this.view = { x: this.w / 2, y: this.h / 2, k: 1 }; this.dirty = true; return; }
    var bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    var availH = Math.max(80, this.h - (this.insets.bottom || 0));
    var k = Math.min((this.w - 2 * pad) / bw, (availH - 2 * pad) / bh, 2.2);
    k = Math.max(k, 0.05);
    this.view = { k: k, x: this.w / 2 - (minX + bw / 2) * k, y: availH / 2 - (minY + bh / 2) * k };
    this.dirty = true;
  };

  /**
   * After vertices were added: when the view is the result of fit() it is simply refitted; otherwise it pans the least
   * that shows them (and zooms out only if they cannot all fit), so the user's own zoom is respected.
   */
  Renderer.prototype.ensureVisible = function (ids, pad) {
    if (this.autoFit) { this.fit(); return; }
    pad = pad == null ? 90 : pad;
    var self = this, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    ids.forEach(function (id) {
      var p = self.target.get(id) || self.cur.get(id); if (!p) return; any = true;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    if (!any) return;
    var v = this.view, k = v.k, availH = Math.max(80, this.h - (this.insets.bottom || 0));
    var x0 = minX * k + v.x - pad, x1 = maxX * k + v.x + pad, y0 = minY * k + v.y - pad, y1 = maxY * k + v.y + pad;
    if (x1 - x0 > this.w || y1 - y0 > availH) {                         // does not fit at this zoom: zoom out around the group
      var nk = Math.max(0.05, k * Math.min(this.w / (x1 - x0), availH / (y1 - y0)) * 0.97);
      var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      this.view = { k: nk, x: this.w / 2 - cx * nk, y: availH / 2 - cy * nk };
    } else {
      v.x += x0 < 0 ? -x0 : (x1 > this.w ? this.w - x1 : 0);
      v.y += y0 < 0 ? -y0 : (y1 > availH ? availH - y1 : 0);
    }
    this.dirty = true;
  };

  /** Pan so a vertex is in the middle, keeping the zoom. */
  Renderer.prototype.centerOn = function (id) {
    var p = this.target.get(id) || this.cur.get(id);
    if (!p) return;
    this.view.x = this.w / 2 - p.x * this.view.k; this.view.y = (this.h - (this.insets.bottom || 0)) / 2 - p.y * this.view.k; this.dirty = true; this.autoFit = false;
  };

  Renderer.prototype.zoomBy = function (factor, cx, cy) {
    var v = this.view, k = Math.max(0.03, Math.min(6, v.k * factor));
    cx = cx == null ? this.w / 2 : cx; cy = cy == null ? this.h / 2 : cy;
    v.x = cx - (cx - v.x) * (k / v.k); v.y = cy - (cy - v.y) * (k / v.k); v.k = k;
    this.dirty = true; this.autoFit = false;
  };

  // ---- coordinates ----------------------------------------------------------------------------
  Renderer.prototype._local = function (e) { var r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  Renderer.prototype._toWorld = function (p) { return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }; };
  Renderer.prototype._toScreen = function (p) { return { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y }; };
  Renderer.prototype._scale = function () { return Math.max(0.6, Math.min(1.7, this.view.k)); };

  /** Ids of the visible vertices whose centre is inside a box given in canvas pixels ({x0, y0, x1, y1}, any corner first). */
  Renderer.prototype.nodesIn = function (r) {
    var x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1), self = this, out = [];
    if (!this.data) return out;
    this.data.visible.nodes.forEach(function (id) {
      var p = self.cur.get(id); if (!p) return;
      var s = self._toScreen(p);
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) out.push(id);
    });
    return out;
  };

  // ---- picking --------------------------------------------------------------------------------
  Renderer.prototype._pick = function (pt) {
    var d = this.data; if (!d) return { node: null, edge: null };
    var self = this, s = this._scale(), best = null, bestD = Infinity;
    d.visible.nodes.forEach(function (id) {
      var p = self.cur.get(id); if (!p) return;
      var sp = self._toScreen(p), r = d.style.nodeRadius(d.graph.nodes.get(id)) * s + 3, dist = Math.hypot(pt.x - sp.x, pt.y - sp.y);
      if (dist <= r && dist < bestD) { best = id; bestD = dist; }
    });
    if (best) return { node: best, edge: null };
    var bestE = null; bestD = Infinity;
    d.visible.edges.forEach(function (id) {
      var e = d.graph.edges.get(id), a = self.cur.get(e.source), b = self.cur.get(e.target); if (!a || !b) return;
      var dist = distToSegment(pt, self._toScreen(a), self._toScreen(b)), tol = Math.max(4, d.style.edgeWidth(e) * s / 2 + 3);
      if (dist <= tol && dist < bestD) { bestE = id; bestD = dist; }
    });
    return { node: null, edge: bestE };
  };

  /** Outline a vertex (or none) without selecting it: used while the pointer is over its row in the details. */
  /** Light up one peel chain: its path glows in its colour, its steps are numbered, everything that does not touch it fades. null clears. */
  Renderer.prototype.setChain = function (c) { this.chain = c || null; this.dirty = true; };
  /** Zoom and pan so these vertices fill the view (never closer than 2.2x). */
  Renderer.prototype.frame = function (ids, pad) {
    var self = this, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    ids.forEach(function (id) {
      var p = self.target.get(id) || self.cur.get(id); if (!p) return; any = true;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    if (!any) return;
    pad = pad == null ? (this.fitPad || 60) + 30 : pad;
    var bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1), availH = Math.max(80, this.h - (this.insets.bottom || 0));
    var k = Math.max(0.05, Math.min((this.w - 2 * pad) / bw, (availH - 2 * pad) / bh, 2.2));
    this.view = { k: k, x: this.w / 2 - (minX + bw / 2) * k, y: availH / 2 - (minY + bh / 2) * k };
    this.autoFit = false; this.dirty = true;
  };
  Renderer.prototype.setHighlight = function (id) { id = id || null; if (this.highlight !== id) { this.highlight = id; this.dirty = true; } };

  Renderer.prototype._setHover = function (node, edge, evt) {
    if (this.hover.node !== node || this.hover.edge !== edge) { this.hover = { node: node, edge: edge }; this.dirty = true; }
    if (this.cb.onHover) this.cb.onHover(node, edge, evt ? { x: evt.clientX, y: evt.clientY } : null);
  };

  // ---- interaction ----------------------------------------------------------------------------
  /** The expand handle under a canvas point, or null. */
  Renderer.prototype._pickHandle = function (pt) {
    for (var i = this.handleRects.length - 1; i >= 0; i--) {
      var r = this.handleRects[i];
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return r;
    }
    return null;
  };

  Renderer.prototype._down = function (e) {
    if (e.button !== 0) return;
    var pt = this._local(e), hnd = this._pickHandle(pt);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
    if (hnd) { this.drag = { handle: hnd, start: pt, moved: false, shift: e.shiftKey || e.altKey }; return; }
    var h = this._pick(pt), here = h.node ? this.cur.get(h.node) : null, group = null;
    if (h.node && this.selected.has(h.node) && this.selected.size > 1) {            // pressing on one of several selected vertices: they all move together
      group = [];
      this.selected.forEach(function (id) { var p = this.cur.get(id); if (p && id !== h.node) group.push({ id: id, x: p.x, y: p.y }); }, this);
      if (!group.length) group = null;
    }
    this.drag = { id: h.node, x0: here ? here.x : null, y0: here ? here.y : null, group: group, edge: h.edge, start: pt, last: pt, moved: false, view0: { x: this.view.x, y: this.view.y }, shift: e.shiftKey || e.ctrlKey || e.metaKey, box: !h.node && (e.shiftKey || this.boxMode) };
  };

  Renderer.prototype._move = function (e) {
    var pt = this._local(e), d = this.drag;
    if (!d) {
      var onAxis = !!(this.data && this.data.axis && pt.y <= AXIS_H + 2);                // the time axis: it answers "what time is this?"
      if (onAxis !== (this.axisPointer != null) || (onAxis && this.axisPointer !== pt.x)) { this.axisPointer = onAxis ? pt.x : null; this.dirty = true; }
      if (onAxis) { this._setHover(null, null, null); this.canvas.style.cursor = 'crosshair'; this.canvas.title = ''; return; }
      var hnd = this._pickHandle(pt);
      if (hnd) { this._setHover(null, null, null); this.canvas.style.cursor = 'pointer'; this.canvas.title = (hnd.tip || '') + (this.data && this.data.handleMore ? this.data.handleMore(hnd.id, hnd.dir) : ''); return; }
      this.canvas.title = '';
      var h = this._pick(pt); this._setHover(h.node, h.edge, e); this.canvas.style.cursor = h.node ? 'pointer' : (h.edge ? 'help' : (this.boxMode ? 'crosshair' : 'grab')); return;
    }
    if (d.handle) return;                                               // a press on a handle is a click, never a drag
    if (!d.moved && Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 4) return;
    if (d.box) { d.moved = true; this.box = { x0: d.start.x, y0: d.start.y, x1: pt.x, y1: pt.y }; this.canvas.style.cursor = 'crosshair'; this.dirty = true; return; }
    d.moved = true;
    if (!d.id) this.autoFit = false;                                  // the user is panning
    if (d.id) {
      var w = this._toWorld(pt), p = this.cur.get(d.id);
      var up = d.x0 != null && !e.shiftKey && this.data && typeof this.data.lockX === 'function' && this.data.lockX(d.id);      // x means time: only up and down, unless Shift is held
      var nx = up ? d.x0 : w.x;
      if (p) { p.x = nx; p.y = w.y; }
      var t = this.target.get(d.id); if (t) { t.x = nx; t.y = w.y; }
      if (d.group && d.x0 != null) {                                  // the rest of the selection moves by the same amount, each by the rule of its own layout (x may mean time)
        var dx = nx - d.x0, dy = w.y - d.y0, self = this;                  // by what the dragged vertex itself moved: if its x is locked to time, so is the shift of the others
        d.group.forEach(function (g) {
          var gx = !e.shiftKey && self.data && typeof self.data.lockX === 'function' && self.data.lockX(g.id) ? g.x : g.x + dx, gp = self.cur.get(g.id), gt = self.target.get(g.id);
          if (gp) { gp.x = gx; gp.y = g.y + dy; }
          if (gt) { gt.x = gx; gt.y = g.y + dy; }
        });
      }
      this.canvas.style.cursor = up ? 'ns-resize' : 'grabbing';
    } else {
      this.view.x = d.view0.x + (pt.x - d.start.x); this.view.y = d.view0.y + (pt.y - d.start.y);
      this.canvas.style.cursor = 'grabbing';
    }
    this.dirty = true;
  };

  Renderer.prototype._up = function (e, cancelled) {
    var d = this.drag; this.drag = null;
    if (!d) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    this.canvas.style.cursor = this.boxMode ? 'crosshair' : 'grab';
    if (cancelled) { this.box = null; this.dirty = true; return; }
    if (d.box && d.moved) {                                               // the box ended: what it covers is selected
      var rect = this.box; this.box = null; this.dirty = true;
      if (rect && this.cb.onBox) this.cb.onBox(this.nodesIn(rect), d.shift);
      return;
    }
    if (d.handle) { if (this.cb.onHandle) this.cb.onHandle(d.handle.id, d.handle.dir, d.shift, { x: e.clientX, y: e.clientY }); return; }
    if (d.moved && d.id) {
      if (this.cb.onMove) {
        var self = this, ids = [d.id].concat((d.group || []).map(function (g) { return g.id; }));
        ids.forEach(function (id) { var p = self.cur.get(id); if (p) self.cb.onMove(id, { x: p.x, y: p.y }); });
      }
      return;
    }
    if (d.moved) return;
    if (d.id) { if (this.cb.onSelect) this.cb.onSelect(d.id, d.shift); }
    else if (d.edge) { if (this.cb.onSelectEdge) this.cb.onSelectEdge(d.edge); }
    else if (this.cb.onSelect) this.cb.onSelect(null, false);
  };

  Renderer.prototype._wheel = function (e) {
    var pt = this._local(e);
    this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), pt.x, pt.y);
  };

  // ---- drawing --------------------------------------------------------------------------------
  Renderer.prototype._frame = function () {
    if (this.anim) {
      var t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.ms), k = 1 - Math.pow(1 - t, 3), self = this;
      this.target.forEach(function (to, id) {
        var from = self.anim.from.get(id) || to, p = self.cur.get(id);
        if (!p) { p = { x: to.x, y: to.y }; self.cur.set(id, p); }
        p.x = from.x + (to.x - from.x) * k; p.y = from.y + (to.y - from.y) * k;
      });
      if (t >= 1) { this.anim = null; this.target = new Map(); }
      this.dirty = true;
    }
    if (this.beacon) {                                                       // a pulse is running: draw it every frame, and stop it when its time is up
      if (nowMs() - this.beacon.t0 > this.beacon.ms) { this.beacon = null; this.dirty = true; }
      else if (!reducedMotion()) this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  };

  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function reducedMotion() { try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  /**
   * Say "here" about these vertices for a few seconds, so one can be found in a crowded graph: a glow that breathes and a ring that spreads out from each,
   * drawn on top of everything and never smaller than a few pixels, so a vertex that is tiny at this zoom is still a beacon. With "reduce motion" set in the
   * system the ring and the glow stand still. At most 300 vertices; none clears it.
   */
  Renderer.prototype.pulse = function (ids, ms) {
    var list = Array.from(ids || []).slice(0, 300);
    this.beacon = list.length ? { ids: list, t0: nowMs(), ms: ms || 3600 } : null;
    this.dirty = true;
  };

  Renderer.prototype._drawBeacon = function () {
    var b = this.beacon, d = this.data; if (!b || !d) return;
    var t = nowMs() - b.t0, moving = !reducedMotion();
    var env = moving ? Math.max(0, Math.min(1, t / 180, (b.ms - t) / 500)) : 1;                  // eases in and out; standing still it is simply there until its time is up
    var ctx = this.ctx, s = this._scale(), self = this, many = b.ids.length > 40, TAU = Math.PI * 2;
    var p = moving ? (t % 1200) / 1200 : 0.3;
    var breath = moving ? 0.5 + 0.5 * Math.sin(p * TAU - Math.PI / 2) : 0.5;
    ctx.save(); ctx.setLineDash([]);
    b.ids.forEach(function (id) {
      if (!d.visible.nodes.has(id)) return;
      var n = d.graph.nodes.get(id), c = self.cur.get(id); if (!n || !c) return;
      var P = self._toScreen(c), r = Math.max(d.style.nodeRadius(n) * s, 6);
      if (P.x < -70 || P.y < -70 || P.x > self.w + 70 || P.y > self.h + 70) return;
      if (!many) {                                                                                // the breathing glow
        var gr = r + 14 + 8 * breath, grad = ctx.createRadialGradient(P.x, P.y, r * 0.5, P.x, P.y, gr);
        grad.addColorStop(0, 'rgba(255,210,63,' + (0.5 * env).toFixed(3) + ')'); grad.addColorStop(1, 'rgba(255,210,63,0)');
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(P.x, P.y, gr, 0, TAU); ctx.fill();
      }
      [0, 0.5].slice(0, many || !moving ? 1 : 2).forEach(function (off) {                          // rings that spread out and fade
        var q = (p + off) % 1, rr = r + 5 + q * 36;
        ctx.beginPath(); ctx.arc(P.x, P.y, rr, 0, TAU);
        ctx.lineWidth = 1 + 2.5 * (1 - q); ctx.strokeStyle = 'rgba(255,236,150,' + (Math.min(1, (moving ? 1 - q : 0.85)) * 0.95 * env).toFixed(3) + ')'; ctx.stroke();
      });
      ctx.beginPath(); ctx.arc(P.x, P.y, r + 5, 0, TAU);                                          // a steady bright ring close around it
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,' + env.toFixed(3) + ')'; ctx.stroke();
    });
    ctx.restore();
  };

  function neighbourhood(graph, ids) {
    var out = new Set();
    ids.forEach(function (id) {
      out.add(id);
      graph.edgesOf(id).forEach(function (e) { out.add(e.source); out.add(e.target); });
    });
    return out;
  }

  // the shape a vertex is drawn with: its own choice (a tag), otherwise by what it is
  var DEFAULT_SHAPE = { tx: 'square', coinbase: 'diamond', data: 'hexagon', group: 'stack' };
  function kindOf(n) { return n.shape || DEFAULT_SHAPE[n.type] || 'circle'; }

  function shape(ctx, kind, x, y, r) {
    var i, a;
    ctx.beginPath();
    if (kind === 'square') {
      var q = r * 0.85, c = r * 0.3;
      ctx.moveTo(x - q + c, y - q); ctx.lineTo(x + q - c, y - q); ctx.quadraticCurveTo(x + q, y - q, x + q, y - q + c);
      ctx.lineTo(x + q, y + q - c); ctx.quadraticCurveTo(x + q, y + q, x + q - c, y + q);
      ctx.lineTo(x - q + c, y + q); ctx.quadraticCurveTo(x - q, y + q, x - q, y + q - c);
      ctx.lineTo(x - q, y - q + c); ctx.quadraticCurveTo(x - q, y - q, x - q + c, y - q);
    } else if (kind === 'diamond') {
      ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 1.15, y);
    } else if (kind === 'stack') {                                      // three cards, one behind the other: several vertices drawn as one
      var sq = r * 0.78, k = r * 0.26, off = r * 0.34;
      [[-off, off], [0, 0], [off, -off]].forEach(function (o) {
        var cx = x + o[0], cy = y + o[1];
        ctx.moveTo(cx - sq + k, cy - sq); ctx.lineTo(cx + sq - k, cy - sq); ctx.quadraticCurveTo(cx + sq, cy - sq, cx + sq, cy - sq + k);
        ctx.lineTo(cx + sq, cy + sq - k); ctx.quadraticCurveTo(cx + sq, cy + sq, cx + sq - k, cy + sq);
        ctx.lineTo(cx - sq + k, cy + sq); ctx.quadraticCurveTo(cx - sq, cy + sq, cx - sq, cy + sq - k);
        ctx.lineTo(cx - sq, cy - sq + k); ctx.quadraticCurveTo(cx - sq, cy - sq, cx - sq + k, cy - sq);
      });
    } else if (kind === 'hexagon') {
      for (i = 0; i < 6; i++) { a = Math.PI / 3 * i + Math.PI / 6; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    } else if (kind === 'triangle') {
      ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.8); ctx.lineTo(x - r * 1.1, y + r * 0.8);
    } else if (kind === 'triangle-down') {
      ctx.moveTo(x, y + r * 1.2); ctx.lineTo(x + r * 1.1, y - r * 0.8); ctx.lineTo(x - r * 1.1, y - r * 0.8);
    } else if (kind === 'star') {
      for (i = 0; i < 10; i++) { a = -Math.PI / 2 + Math.PI / 5 * i; var rr = i % 2 ? r * 0.55 : r * 1.25; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    } else if (kind === 'cross') {
      var L = r * 1.15, w = r * 0.42;
      ctx.moveTo(x - w, y - L); ctx.lineTo(x + w, y - L); ctx.lineTo(x + w, y - w); ctx.lineTo(x + L, y - w); ctx.lineTo(x + L, y + w); ctx.lineTo(x + w, y + w);
      ctx.lineTo(x + w, y + L); ctx.lineTo(x - w, y + L); ctx.lineTo(x - w, y + w); ctx.lineTo(x - L, y + w); ctx.lineTo(x - L, y - w); ctx.lineTo(x - w, y - w);
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.closePath();
  }

  Renderer.prototype.draw = function () {
    var ctx = this.ctx, d = this.data, th = this.theme, v = this.view, self = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!d) return;
    var g = d.graph, st = d.style, s = this._scale();

    // time axis
    if (d.axis) this._drawAxis(d.axis, d.range);

    // focus: selection or hover dims everything outside its neighbourhood
    var focusIds = new Set(this.selected); if (this.hover.node) focusIds.add(this.hover.node);
    if (d.noDim) focusIds.clear();                                                           // a trace stays readable whatever is selected
    if (d.focusId && focusIds.size === 1 && focusIds.has(d.focusId)) focusIds.clear();      // the focus view is already narrowed to this vertex: do not fade the next steps
    var chain = this.chain && this.chain.ids.some(function (id) { return d.visible.nodes.has(id); }) ? this.chain : null;     // a chain with nothing on screen fades nothing
    if (chain) chain.ids.forEach(function (id) { if (d.visible.nodes.has(id)) focusIds.add(id); });                          // it and what touches it stay, the rest fades
    var near = focusIds.size ? neighbourhood(g, focusIds) : null;
    var hotEdge = this.hover.edge;

    // edges
    ctx.lineCap = 'round';
    var edgeTexts = [];
    // Coins that go between the same two vertices (several inputs of one transaction from one wallet) lie exactly on top of each other. With d.bundle they are drawn
    // as ONE arrow whose width and label are their total and number; the real edges are untouched (selecting, filters, analysis and exports still see every coin).
    var bundles = new Map(), bundled = new Set();
    if (d.bundle) {
      var byEnds = new Map();
      d.visible.edges.forEach(function (bid) {
        var be = g.edges.get(bid); if (!be || be.virtual || !self.cur.get(be.source) || !self.cur.get(be.target)) return;
        var k = be.kind + '|' + be.source + '|' + be.target, list = byEnds.get(k); if (!list) { list = []; byEnds.set(k, list); } list.push(bid);
      });
      byEnds.forEach(function (ids) { if (ids.length < 2) return; bundles.set(ids[0], ids); for (var bi = 1; bi < ids.length; bi++) bundled.add(ids[bi]); });
    }
    d.visible.edges.forEach(function (id) {
      if (bundled.has(id)) return;                                           // drawn as part of the first coin of its arrow
      var e = g.edges.get(id), a = self.cur.get(e.source), b = self.cur.get(e.target); if (!a || !b) return;
      var parts = bundles.get(id) || null, eDraw = e, hotHere = id === hotEdge || self.selectedEdge === id, markHere = null, pathHere = !!chain && chain.path.has(id), payHere = !!chain && chain.pay.has(id), allUnspent = e.spent === false;
      if (parts) {
        var sum = 0; allUnspent = true;
        parts.forEach(function (pid) {
          var pe = g.edges.get(pid); sum += pe.amount || 0;
          if (pid === hotEdge || pid === self.selectedEdge) hotHere = true;
          if (pe.spent !== false) allUnspent = false;
          if (!markHere && d.edgeMark) markHere = d.edgeMark(pe);
          if (chain && chain.path.has(pid)) pathHere = true;
          if (chain && chain.pay.has(pid)) payHere = true;
        });
        eDraw = Object.assign({}, e, { amount: sum, count: parts.length, parts: parts });
      } else markHere = d.edgeMark ? d.edgeMark(e) : null;
      var A = self._toScreen(a), B = self._toScreen(b);
      if ((A.x < -50 && B.x < -50) || (A.y < -50 && B.y < -50) || (A.x > self.w + 50 && B.x > self.w + 50) || (A.y > self.h + 50 && B.y > self.h + 50)) return;
      var inFocus = !near || ((focusIds.has(e.source) || focusIds.has(e.target)));
      var w = Math.max(1, st.edgeWidth(eDraw) * s * 0.8);
      var mark = markHere;                                                  // e.g. the output that most likely returns to the sender
      var onPath = pathHere, onPay = payHere;
      var colour = onPath || onPay ? chain.color : mark || st.edgeColor(e) || th.edge;
      ctx.globalAlpha = hotHere || onPath ? 1 : (inFocus ? (near ? 0.95 : 0.55) : 0.08);
      if (mark && inFocus && ctx.globalAlpha < 0.9) ctx.globalAlpha = 0.9;
      ctx.strokeStyle = parts ? (hotHere ? th.select : colour) : (id === hotEdge ? th.select : colour);
      ctx.lineWidth = onPath ? w + 1.5 : w;
      ctx.setLineDash(e.kind === 'out' && allUnspent ? [6, 4] : []);
      var ra = st.nodeRadius(g.nodes.get(e.source)) * s, rb = st.nodeRadius(g.nodes.get(e.target)) * s + 2;
      var dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      var x1 = A.x + ux * ra * 0.6, y1 = A.y + uy * ra * 0.6, x2 = B.x - ux * rb, y2 = B.y - uy * rb;
      if (onPath) {                                                         // the way the money went: a wide soft glow under the line
        ctx.save(); ctx.globalAlpha = 0.28; ctx.lineWidth = w + 8; ctx.strokeStyle = chain.color; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      }
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
      if (len > ra + rb + 14) {                                             // arrowhead
        var ah = 5 + w * 0.9, nx = -uy, ny = ux;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.moveTo(x2 + ux * 1, y2 + uy * 1); ctx.lineTo(x2 - ux * ah + nx * ah * 0.55, y2 - uy * ah + ny * ah * 0.55);
        ctx.lineTo(x2 - ux * ah - nx * ah * 0.55, y2 - uy * ah - ny * ah * 0.55); ctx.closePath(); ctx.fill();
      }
      if (d.edgeLabel && edgeTexts.length < 250) {
        var seg = Math.hypot(x2 - x1, y2 - y1);
        if (seg > 70 && x1 > -200 && x1 < self.w + 200) edgeTexts.push({ e: eDraw, id: id, hot: hotHere, x1: x1, y1: y1, x2: x2, y2: y2, seg: seg, alpha: ctx.globalAlpha });
      }
    });
    ctx.globalAlpha = 1;
    if (edgeTexts.length) {                                              // amounts along the edges, only where the edge is long enough to carry the text
      ctx.font = '10.5px Calibri, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      // Two amounts must never be drawn on top of each other (each has a dark outline, so the second would smear the first). The edge under the
      // mouse or selected picks its place first, then the edges in focus, then the bigger amounts. An amount tries the middle of its edge, then
      // slides along the edge (never past its ends) to a free spot; with none free it is left out (its details are on hover and in the panel).
      var placed = [];
      edgeTexts.map(function (t, i) { return { t: t, i: i, rank: (t.hot ? 2 : 0) + (t.alpha >= 0.9 ? 1 : 0) }; })
        .sort(function (a, b) { return (b.rank - a.rank) || ((b.t.e.amount || 0) - (a.t.e.amount || 0)) || (a.i - b.i); })
        .forEach(function (o) {
          var t = o.t, text = d.edgeLabel(t.e); if (!text) return;
          var tw = ctx.measureText(text).width, room = (t.seg - tw - 14) / 2;
          if (room < 0) return;
          var steps = [0, -0.5, 0.5, -1, 1];
          for (var k = 0; k < steps.length; k++) {
            var f = 0.5 + steps[k] * room / t.seg, px = t.x1 + (t.x2 - t.x1) * f, py = t.y1 + (t.y2 - t.y1) * f - 5;
            var box = { x0: px - tw / 2 - 2, x1: px + tw / 2 + 2, y0: py - 11, y1: py + 3 };
            if (placed.some(function (b) { return box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1; })) continue;
            placed.push(box);
            ctx.globalAlpha = Math.min(1, t.alpha + 0.15);
            ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(28,20,29,0.92)'; ctx.strokeText(text, px, py);
            ctx.fillStyle = '#d8eef5'; ctx.fillText(text, px, py);
            return;
          }
        });
      ctx.globalAlpha = 1;
    }

    // nodes
    var labels = [], badges = [], pills = [], flagItems = [], stepNums = [], notes = [];
    this.handleRects = [];
    d.visible.nodes.forEach(function (id) {
      var n = g.nodes.get(id), p = self.cur.get(id); if (!p) return;
      var P = self._toScreen(p), r = st.nodeRadius(n) * s;
      if (P.x < -r - 4 || P.y < -r - 4 || P.x > self.w + r + 4 || P.y > self.h + r + 4) return;
      var dimmed = near && !near.has(id), colour = st.nodeColor(n);
      var hollow = n.type === 'tx' && n.loaded === false;
      ctx.globalAlpha = dimmed ? 0.15 : 1;
      shape(ctx, kindOf(n), P.x, P.y, r);
      if (hollow) { ctx.fillStyle = 'rgba(28,20,29,0.9)'; ctx.fill(); ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]); }
      else {
        ctx.fillStyle = colour; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        if (n.type === 'tx' && n.confirmed === false) ctx.setLineDash([3, 2]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      var known = n.type === 'addr' && d.known && d.known[n.address];
      if (n.label || known || self.selected.has(id) || id === self.hover.node) {
        shape(ctx, kindOf(n), P.x, P.y, r + 3.5);
        ctx.lineWidth = self.selected.has(id) ? 3 : 2;
        ctx.strokeStyle = self.selected.has(id) ? th.select : (n.label ? th.accent : th.known);
        ctx.stroke();
      }
      if (id === self.highlight) { shape(ctx, kindOf(n), P.x, P.y, r + 7); ctx.lineWidth = 3; ctx.strokeStyle = th.select; ctx.setLineDash([]); ctx.stroke(); }
      if (known && known.sanctions) { shape(ctx, kindOf(n), P.x, P.y, r + 6.5); ctx.lineWidth = 3; ctx.strokeStyle = '#ff4d4f'; ctx.setLineDash([]); ctx.stroke(); }      // on a sanctions list (according to a pack)
      var ring = d.clusterColor && n.type === 'addr' ? d.clusterColor(id) : null;
      if (ring) {                                                           // a dashed ring in the cluster's colour: addresses spent together
        ctx.beginPath(); ctx.arc(P.x, P.y, r + 7.5, 0, Math.PI * 2); ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      var step = chain ? chain.index.get(id) : 0;
      if (step) {                                                          // a step of the lit chain: a ring in its colour and its number
        shape(ctx, kindOf(n), P.x, P.y, r + 5.5); ctx.lineWidth = 3; ctx.strokeStyle = chain.color; ctx.setLineDash([]); ctx.stroke();
        stepNums.push({ x: P.x + r * 0.9 + 6, y: P.y - r * 0.9 - 6, n: step });
      }
      if (n.ext) {                                                         // a small blue dot: something was looked up about this wallet
        ctx.beginPath(); ctx.arc(P.x + r * 0.85, P.y - r * 0.85, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#4da3ff'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
      if (n.note) notes.push({ x: P.x + r * 0.7 + 3.5, y: P.y + r * 0.7 + 3.5, alpha: dimmed ? 0.15 : 1 });
      ctx.globalAlpha = 1;
      if (n.tag && !dimmed) badges.push({ text: n.tag, x: P.x, y: P.y - r - 6 - ((d.seedIds ? d.seedIds.has(id) : d.seedId === id) ? 10 : 0), color: colour });
      var isSeed = d.seedIds ? d.seedIds.has(id) : d.seedId === id;
      if (isSeed) badges.push({ text: 'START', x: P.x, y: P.y - r - 6, color: '#ffd23f' });
      if (known && known.sanctions && !dimmed) badges.push({ text: 'SANCTIONS', x: P.x, y: P.y - r - 6 - (isSeed ? 10 : 0) - (n.tag ? 10 : 0), color: '#ff6b6b' });
      var flags = d.nodeFlags && !dimmed ? d.nodeFlags(n) : null;
      if (flags) {                                                         // decided below: text where there is room, a dot where there is not
        var lift = 6 + (isSeed ? 10 : 0) + (n.tag ? 10 : 0), hot = self.selected.has(id) || id === self.hover.node;
        flags.forEach(function (f, i) { flagItems.push({ x: P.x, y: P.y - r - lift - i * 10, px: P.x, py: P.y, r: r, i: i, f: f, hot: hot }); });
      }
      if (d.handles) {
        var hd = d.handles(id);
        if (hd) {
          if (hd.left) pills.push({ id: id, dir: 'left', x: P.x - r - 8, y: P.y, label: hd.left.label, tip: hd.left.tip, strong: hd.left.known > 0 });
          if (hd.right) pills.push({ id: id, dir: 'right', x: P.x + r + 8, y: P.y, label: hd.right.label, tip: hd.right.tip, strong: hd.right.known > 0 });
        }
      }
      var text = null;
      if (n.type === 'group') text = n.label || n.groupText;              // your label, else "6 transactions to bc1q…"
      else if (n.label) text = n.label;
      else if (known) text = known.label;
      else if (self.selected.has(id) || id === self.hover.node || d.labelAll || (d.showLabels && v.k >= 0.9)) {
        text = n.type === 'tx' ? Style.shortId(n.txid, 5) : n.type === 'addr' ? Style.shortId(n.address, 6) : n.type === 'coinbase' ? 'coinbase' : n.type === 'data' ? (n.dataText ? '“' + n.dataText.slice(0, 18) + '”' : 'OP_RETURN') : 'non-standard';
      }
      var note = d.nodeNote ? d.nodeNote(n) : '';
      if (text && !dimmed) labels.push({ text: text, sub: note, x: P.x, y: P.y + r + 12, strong: !!(n.label || known), sel: self.selected.has(id) });
    });
    notes.forEach(function (nt) {                                          // a small yellow note at the lower right of a vertex you wrote a note on, drawn after every vertex so none covers it
      var hs = 4.5, x = nt.x, y = nt.y;
      ctx.globalAlpha = nt.alpha;
      ctx.beginPath();
      ctx.moveTo(x - hs, y - hs); ctx.lineTo(x + hs - 3, y - hs); ctx.lineTo(x + hs, y - hs + 3); ctx.lineTo(x + hs, y + hs); ctx.lineTo(x - hs, y + hs); ctx.closePath();
      ctx.fillStyle = '#ffe27a'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
      if (self.view.k >= 0.5) {                                            // two lines of writing, when there is room for them
        ctx.beginPath(); ctx.moveTo(x - hs + 2, y - 0.5); ctx.lineTo(x + hs - 2, y - 0.5); ctx.moveTo(x - hs + 2, y + 2); ctx.lineTo(x + hs - 3, y + 2);
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(60,40,0,0.7)'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    ctx.font = 'bold 9.5px Calibri, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    // Pattern flags (PEEL 3/5, CONSOL 34>2 ...) only get their text where it fits: zoomed out, or where two would sit on top of each other, a small
    // dot in the pattern's colour stands in. The vertex under the pointer or selected is served first and also names its peel chain.
    var dots = [];
    if (flagItems.length) {
      var taken = badges.map(function (b) { var w = ctx.measureText(b.text).width; return { x0: b.x - w / 2 - 2, x1: b.x + w / 2 + 2, y0: b.y - 10, y1: b.y + 3 }; });
      var roomy = self.view.k >= 0.3;
      flagItems.sort(function (a, b) { return (b.hot ? 1 : 0) - (a.hot ? 1 : 0); });
      flagItems.forEach(function (it) {
        var text = it.hot && it.f.chain ? it.f.text + ' \u00b7 ' + it.f.chain : it.f.text, w = ctx.measureText(text).width;
        var box = { x0: it.x - w / 2 - 2, x1: it.x + w / 2 + 2, y0: it.y - 10, y1: it.y + 3 };
        var free = (roomy || it.hot) && !taken.some(function (b) { return box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1; });
        if (free) { taken.push(box); badges.push({ text: text, x: it.x, y: it.y, color: it.f.color }); }
        else dots.push(it);
      });
    }
    badges.forEach(function (b) {                                          // the tag, in its own colour, above the vertex
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(28,20,29,0.95)'; ctx.strokeText(b.text, b.x, b.y);
      ctx.fillStyle = b.color; ctx.fillText(b.text, b.x, b.y);
    });
    dots.forEach(function (it, k) {
      ctx.beginPath(); ctx.arc(it.px - it.r * 0.85 - it.i * 7, it.py - it.r * 0.85, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = it.f.color; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
    });
    stepNums.forEach(function (s) {
      var big = self.view.k >= 0.2;                                        // zoomed far out a number would be unreadable: a plain dot in the chain's colour
      ctx.beginPath(); ctx.arc(s.x, s.y, big ? 8 : 4, 0, Math.PI * 2); ctx.fillStyle = chain.color; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
      if (big) { ctx.font = 'bold 10px Calibri, Arial, sans-serif'; ctx.fillStyle = '#16111a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(s.n), s.x, s.y + 0.5); ctx.textBaseline = 'alphabetic'; }
    });
    ctx.font = '11px Calibri, Arial, sans-serif';
    labels.forEach(function (l) {
      var t = l.text.length > 34 ? l.text.slice(0, 33) + '…' : l.text;
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(28,20,29,0.9)'; ctx.strokeText(t, l.x, l.y);
      ctx.fillStyle = l.strong ? th.accent : th.text; ctx.fillText(t, l.x, l.y);
      if (l.sub) {
        ctx.font = '10px Calibri, Arial, sans-serif';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(28,20,29,0.9)'; ctx.strokeText(l.sub, l.x, l.y + 11);
        ctx.fillStyle = th.dim; ctx.fillText(l.sub, l.x, l.y + 11);
        ctx.font = '11px Calibri, Arial, sans-serif';
      }
    });
    ctx.globalAlpha = 1;
    if (pills.length) {                                                    // expand handles: "◀ 3" on the left of a vertex, "5+ ▶" on the right
      ctx.font = 'bold 10.5px Calibri, Arial, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      pills.forEach(function (p) {
        var text = p.dir === 'left' ? '◀ ' + p.label : p.label + ' ▶', w = Math.max(30, ctx.measureText(text).width + 12), h = 18;
        var x = p.dir === 'left' ? p.x - w : p.x, y = p.y - h / 2;
        if (x > self.w + 40 || x + w < -40 || y > self.h + 40 || y + h < -40) return;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 9); else ctx.rect(x, y, w, h);
        ctx.fillStyle = p.strong ? th.accent : 'rgba(28,20,29,0.92)'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = th.accent; ctx.stroke();
        ctx.fillStyle = p.strong ? '#0e0f0e' : th.accent; ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
        self.handleRects.push({ id: p.id, dir: p.dir, x: x, y: y, w: w, h: h, tip: p.tip });
      });
      ctx.textBaseline = 'alphabetic';
    }
    if (this.beacon) this._drawBeacon();
    if (d.axis) this._drawAxisReadout(d, s);
    if (this.box) {                                                        // the selection box
      var bx = Math.min(this.box.x0, this.box.x1), by = Math.min(this.box.y0, this.box.y1), bw = Math.abs(this.box.x1 - this.box.x0), bh = Math.abs(this.box.y1 - this.box.y0);
      ctx.fillStyle = 'rgba(174,231,248,0.10)'; ctx.fillRect(bx, by, bw, bh);
      ctx.lineWidth = 1; ctx.strokeStyle = th.accent; ctx.setLineDash([4, 3]); ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh); ctx.setLineDash([]);
    }
  };

  /**
   * The time axis answers two questions: what time is this place on the line (the pointer is over it), and what time did this
   * transaction happen (the pointer is over one): a guide runs down from the line and its exact time, to the second, is
   * written on it. In a gap that was shortened to keep a burst readable, the time at the pointer is only interpolated and says so.
   */
  Renderer.prototype._drawAxisReadout = function (d, s) {
    var ctx = this.ctx, th = this.theme, axis = d.axis, v = this.view, self = this, x = null, text = null, dashed = false;
    function label(px, t, hot) {
      ctx.font = 'bold 11px Calibri, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var w = ctx.measureText(t).width + 14, bx = Math.max(4, Math.min(self.w - w - 4, px - w / 2));
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, 3, w, 17, 8); else ctx.rect(bx, 3, w, 17);
      ctx.fillStyle = 'rgba(28,20,29,0.97)'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = hot ? '#ffffff' : th.accent; ctx.stroke();
      ctx.fillStyle = hot ? '#ffffff' : th.accent; ctx.fillText(t, bx + w / 2, 11.5); ctx.textBaseline = 'alphabetic';
    }
    if (this.axisPointer != null && axis.mode === 'marks') {                         // over the line: the nearest transaction's exact time
      var near = null;
      this._timeMarks().forEach(function (m) { var dist = Math.abs(m.x - self.axisPointer); if (dist <= 16 && (!near || dist < Math.abs(near.x - self.axisPointer))) near = m; });
      if (near) { x = near.x; text = Style.fmtTimeFull(near.t); }
    } else if (this.axisPointer != null && axis.tAt) {
      var hit = axis.tAt((this.axisPointer - v.x) / v.k - (axis.x0 || 0));
      if (hit) { x = this.axisPointer; text = (hit.gap ? '≈ ' : '') + Style.fmtTimeFull(Math.round(hit.t)) + (hit.gap ? ' · shortened gap' : ''); dashed = hit.gap; }
    } else if (this.hover.node) {
      var n = d.graph.nodes.get(this.hover.node), p = this.cur.get(this.hover.node);
      if (n && n.type === 'tx' && n.time != null && p) { x = this._toScreen(p).x; text = Style.fmtTimeFull(n.time); }
    }
    if (x == null) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.setLineDash(dashed ? [2, 4] : [4, 3]);
    var yEnd = this.axisPointer != null ? this.h : (this.cur.get(this.hover.node) ? this._toScreen(this.cur.get(this.hover.node)).y : this.h);
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, AXIS_H); ctx.lineTo(Math.round(x) + 0.5, yEnd); ctx.stroke(); ctx.setLineDash([]);
    label(x, text, this.axisPointer == null);
    ctx.restore();
  };

  function fmtGap(sec, short) {
    if (sec >= 365.25 * DAY * 1.5) return (sec / (365.25 * DAY)).toFixed(1) + (short ? 'y' : ' years');
    if (sec >= 60 * DAY) return Math.round(sec / (30.44 * DAY)) + (short ? 'mo' : ' months');
    if (sec >= 2 * DAY) return Math.round(sec / DAY) + (short ? 'd' : ' days');
    if (sec >= 3600) return Math.round(sec / 3600) + (short ? 'h' : ' hours');
    return Math.max(1, Math.round(sec / 60)) + (short ? 'm' : ' min');
  }

  /**
   * The transactions on screen with a known time, left to right: [{x, t, id}] (x in canvas pixels). The 'marks' axis of the
   * Trace layout's Columns arrangement is made of these: there x is not time, so the axis cannot be a scale, but it can
   * still put a tick and a timestamp over every transaction, so the order of events can be read along the top.
   */
  Renderer.prototype._timeMarks = function () {
    var d = this.data, out = [], self = this;
    d.visible.nodes.forEach(function (id) {
      var n = d.graph.nodes.get(id), p = self.cur.get(id);
      if (n && n.type === 'tx' && n.time != null && p) out.push({ x: self._toScreen(p).x, t: n.time, id: id });
    });
    return out.sort(function (a, b) { return a.x - b.x || a.t - b.t; });
  };

  Renderer.prototype._drawAxis = function (axis, range) {
    var ctx = this.ctx, v = this.view, th = this.theme, h = this.h, w = this.w;
    function sx(worldX) { return worldX * v.k + v.x; }
    ctx.font = '11px Calibri, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(242,242,242,0.04)'; ctx.fillRect(0, 0, w, AXIS_H);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(242,242,242,0.30)';                            // the line itself
    ctx.beginPath(); ctx.moveTo(0, AXIS_H + 0.5); ctx.lineTo(w, AXIS_H + 0.5); ctx.stroke();
    function tick(x) { ctx.strokeStyle = 'rgba(242,242,242,0.55)'; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, AXIS_H - 6); ctx.lineTo(Math.round(x) + 0.5, AXIS_H + 1); ctx.stroke(); }
    if (axis.mode === 'marks') {                                                     // a tick and a timestamp over each transaction, wherever it was put
      var lastMark = -1e9;
      this._timeMarks().forEach(function (m) {
        if (m.x < -20 || m.x > w + 20) return;
        tick(m.x);
        if (m.x - lastMark >= 104) { ctx.fillStyle = th.dim; ctx.fillText(Style.fmtTime(m.t).replace(' UTC', ''), m.x + 4, 15); lastMark = m.x; }
      });
      return;
    }
    if (axis.mode === 'compact' && axis.knots.length > 1) {
      var short = (axis.tMax - axis.tMin) < 3 * DAY, lastX = -1e9, step = [short ? 60 : DAY, 's'];
      axis.knots.forEach(function (kn) {
        var x = sx(axis.x0 + kn.x);
        if (x < -60 || x > w + 60) return;
        ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 22); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        if (x - lastX >= 92) { tick(x); ctx.fillStyle = th.dim; ctx.fillText(labelFor(kn.t, step), x + 4, 15); lastX = x; }
      });
      axis.breaks.forEach(function (b) {
        var xa = sx(axis.x0 + b.x0), xb = sx(axis.x0 + b.x1);
        if (xb < 0 || xa > w) return;
        ctx.fillStyle = 'rgba(242,201,76,0.05)'; ctx.fillRect(xa, 22, xb - xa, h);
        ctx.strokeStyle = 'rgba(242,201,76,0.35)'; ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(xa, 22); ctx.lineTo(xa, h); ctx.moveTo(xb, 22); ctx.lineTo(xb, h); ctx.stroke(); ctx.setLineDash([]);
        var room = xb - xa;
        if (room > 28) { ctx.fillStyle = '#f2c94c'; ctx.textAlign = 'center'; ctx.fillText(room > 110 ? '⋯ ' + fmtGap(b.seconds) + ' ⋯' : fmtGap(b.seconds, true), (xa + xb) / 2, 36); ctx.textAlign = 'left'; }
      });
    } else if (axis.pxPerSec > 0) {
      niceTicks(axis.tMin, axis.tMax, axis.pxPerSec * v.k, 90).forEach(function (tk) {
        var x = sx(axis.x0 + (tk.t - axis.tMin) * axis.pxPerSec);
        if (x < -40 || x > w + 40) return;
        ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 22); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        tick(x); ctx.fillStyle = th.dim; ctx.fillText(tk.label, x + 4, 15);
      });
    } else {
      ctx.fillStyle = th.dim; ctx.fillText(Style.fmtTime(axis.tMin), sx(axis.x0) + 4, 15);
    }
    if (axis.yTicks && axis.yTicks.length) {                                     // amount scale: a faint line per power of ten, labelled at the left edge
      ctx.font = '10.5px Calibri, Arial, sans-serif'; ctx.textAlign = 'left';
      axis.yTicks.forEach(function (t) {
        var y = t.y * v.k + v.y;
        if (y < 30 || y > h - 4) return;
        ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
        ctx.fillStyle = th.dim; ctx.fillText(t.label, 6, y - 3);
      });
    }
    if (range && axis.xOf && (range.from != null || range.to != null) && axis.knots.length > 1) {
      var xa2 = range.from != null ? sx(axis.xOf(range.from)) : 0, xb2 = range.to != null ? sx(axis.xOf(range.to)) : w;
      ctx.fillStyle = 'rgba(174,231,248,0.10)'; ctx.fillRect(Math.max(0, xa2), 0, Math.max(0, Math.min(w, xb2) - Math.max(0, xa2)), 22);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      if (xa2 > 0) ctx.fillRect(0, 22, Math.min(w, xa2), h);
      if (xb2 < w) ctx.fillRect(Math.max(0, xb2), 22, w - xb2, h);
    }
    if (axis.hasPending) {
      var px = sx(axis.pendingX);
      ctx.strokeStyle = 'rgba(242,201,76,0.5)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(px - 40 * v.k, 22); ctx.lineTo(px - 40 * v.k, h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f2c94c'; ctx.fillText('unconfirmed', px - 36 * v.k, 15);
    }
  };

  /** PNG data URL of the current view (for "save image"). */
  Renderer.prototype.toDataUrl = function () { this.draw(); return this.canvas.toDataURL('image/png'); };

  return { Renderer: Renderer, niceTicks: niceTicks, distToSegment: distToSegment, kindOf: kindOf, shape: shape };
}));
