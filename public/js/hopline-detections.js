/*
 * Hopline detections: every pattern the analysis found in what is loaded, as one list in time order, the way the report lists them.
 * Pure functions, no DOM, no network. It only arranges what the analysis returned (analyse() in hopline-analysis.js); it detects nothing itself.
 *
 *   build(graph, analysis, { kinds, fmt }) -> { rows, chains, counts }
 *     rows    one per flag per transaction, oldest first (an unconfirmed transaction last):
 *             { id, txid, time, height, kind, short, color, chain, step, of, reason }
 *     chains  every possible peel chain (not only the longest), longest first, with the time it ran from and to
 *     counts  { peel, consolidation, batch, coinjoin, total } of the rows, before any filter
 *   kinds   which kinds to include ({ peel: false } leaves peel steps out); all by default
 *   fmt     sats -> text for the amounts in the reasons (default: a plain number of sats)
 *   pick(rows, { kind, chain }) keeps one kind and / or one chain's rows.
 *   toText(rows, fmtTime) is the list as tab-separated text (time, transaction id, pattern, why), for the clipboard.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineDetections = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['peel', 'consolidation', 'batch', 'coinjoin'];
  var ORDER = { coinjoin: 0, consolidation: 1, batch: 2, peel: 3 };

  function plainSats(n) { return n + ' sats'; }

  /** The reason shown beside a peel step: what it paid out and what it passed on. */
  function peelReason(ch, i, fmt) {
    var out = ch.peeled && ch.peeled[i] ? ch.peeled[i].amount : null, on = ch.passed && ch.passed[i] != null ? ch.passed[i] : null;
    var head = out == null ? 'Pays a smaller amount out of a single coin and passes the rest on' : 'Pays ' + fmt(out) + ' out' + (on == null ? ' and passes the rest on' : ' and passes ' + fmt(on) + ' on');
    return head + ' (step ' + (i + 1) + ' of ' + ch.ids.length + ' in ' + ch.label + ').';
  }

  function build(graph, an, opts) {
    opts = opts || {};
    var fmt = typeof opts.fmt === 'function' ? opts.fmt : plainSats, kinds = opts.kinds || {};
    var rows = [], counts = { peel: 0, consolidation: 0, batch: 0, coinjoin: 0, total: 0 }, chains = [];
    if (!graph || !an) return { rows: rows, chains: chains, counts: counts };
    var byLabel = new Map(); (an.chains || []).forEach(function (ch) { byLabel.set(ch.label, ch); });

    an.tx.forEach(function (rec, id) {
      var n = graph.nodes.get(id); if (!n || !rec.flags.length) return;
      rec.flags.forEach(function (f) {
        if (kinds[f.kind] === false) return;
        var ch = f.kind === 'peel' && rec.chain ? byLabel.get(rec.chain.label) : null;
        rows.push({
          id: id, txid: n.txid, time: n.time == null ? null : n.time, height: n.height == null ? null : n.height,
          kind: f.kind, short: f.short, color: f.color, chain: f.kind === 'peel' && rec.chain ? rec.chain.label : '',
          step: f.kind === 'peel' && rec.chain ? rec.chain.step : 0, of: f.kind === 'peel' && rec.chain ? rec.chain.of : 0,
          reason: ch ? peelReason(ch, rec.chain.step - 1, fmt) : f.title
        });
        counts[f.kind] = (counts[f.kind] || 0) + 1; counts.total++;
      });
    });
    rows.sort(function (a, b) {
      if ((a.time == null) !== (b.time == null)) return a.time == null ? 1 : -1;
      if (a.time !== b.time) return a.time - b.time;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return (ORDER[a.kind] || 0) - (ORDER[b.kind] || 0);
    });

    if (kinds.peel !== false) (an.chains || []).forEach(function (ch) {
      var times = ch.ids.map(function (id) { var n = graph.nodes.get(id); return n && n.time != null ? n.time : null; }).filter(function (t) { return t != null; });
      chains.push({ label: ch.label, color: ch.color, ids: ch.ids.slice(), n: ch.ids.length, start: ch.start, end: ch.end, totalPeeled: ch.totalPeeled, continues: ch.continues,
                    firstTime: times.length ? Math.min.apply(null, times) : null, lastTime: times.length ? Math.max.apply(null, times) : null });
    });
    return { rows: rows, chains: chains, counts: counts };
  }

  /** Keep the rows of one kind ('all' or empty keeps every kind) and / or of one peel chain (by name). */
  function pick(rows, f) {
    f = f || {};
    return rows.filter(function (r) { return (!f.kind || f.kind === 'all' || r.kind === f.kind) && (!f.chain || r.chain === f.chain); });
  }

  /** Tab-separated, one line per row under a heading line. */
  function toText(rows, fmtTime) {
    var t = typeof fmtTime === 'function' ? fmtTime : function (x) { return x == null ? '' : String(x); };
    return ['Time\tTransaction\tPattern\tWhy'].concat(rows.map(function (r) {
      return [t(r.time), r.txid, r.short + (r.chain ? ' ' + r.chain : ''), r.reason].map(function (c) { return String(c).replace(/[\t\r\n]+/g, ' '); }).join('\t');
    })).join('\n');
  }

  return { KINDS: KINDS, build: build, pick: pick, toText: toText };
}));
