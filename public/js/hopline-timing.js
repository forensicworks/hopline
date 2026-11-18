/*
 * Hopline timing and habits: the facts about WHEN and HOW the transactions on the canvas were made, as plain data for the evidence summary (hopline-assist.js).
 * They are what a person compares by hand when asking whether two wallets are moved by the same hand: when each transaction was first seen, how close in time two transactions of different
 * wallets sit, and the habits of whoever signed them. NONE OF IT IS A FINDING: a time is a service's claim, a habit is a setting that many wallets share, and a coincidence links nothing by itself.
 *
 *   firstSeen   one row per transaction a service was asked about (the earliest time any service recorded, which services, the wait until its block), with a count of how many are close in time
 *   pairs       transactions of DIFFERENT signing groups that are close in time: in one block with no wallet in common (hopline-sameblock.js, when present) or first seen within a few minutes
 *   habits      for each signing group of at least three transactions: version, locktime, sequence, shape, fee rate, the pattern flags, the hours of the day it moves money (UTC), and the points where a habit
 *               changes; and for the most alike pairs of groups what agrees and what differs, each marked `common` when ordinary wallets do the same
 *
 * A SIGNING GROUP is the owner the analysis gives the inputs of a transaction: the cluster they are in (wallets spent together are one owner), else the single wallet. A transaction whose inputs
 * belong to several owners, that looks like a CoinJoin, is a coinbase or is not complete on the canvas has no group.
 * The times of events are the time a service first saw the transaction where one did, else the time of its block (the transaction may have been sent minutes or hours earlier).
 * The relay peer is left out unless opts.peers is true: an address is sensitive, and the summary can be copied or written to a file.
 * Pure functions over the graph and its analysis; nothing here touches the DOM or the network. All text that came from outside (labels) is cleaned by the caller (hopline-assist.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var sb = null; try { sb = require('./hopline-sameblock.js'); } catch (e) { sb = null; }
    module.exports = factory(require('./hopline-analysis.js'), require('./hopline-external.js'), sb);
  } else root.HoplineTiming = factory(root.HoplineAnalysis, root.HoplineExternal, root.HoplineSameBlock || null);
}(typeof self !== 'undefined' ? self : this, function (AN, XT, SB) {
  'use strict';

  var DEFAULTS = { windowSeconds: 120, minSigned: 3, minRun: 2, dominant: 0.8, caps: { rows: 80, pairs: 40, groups: 12, compare: 20, changes: 6 }, peers: false };
  var NOTES = [
    'A first-seen time is a claim by a service about when its own node first saw the transaction. It is not the time of broadcast, two services can differ, and a time equal to the block\'s means it had no record.',
    'A habit is a setting of the wallet software. Many wallets share the common ones (marked common), so agreement on them says little; an unusual combination, or a change of habit on the same day in two groups, says more.',
    'Two transactions close in time are a coincidence to weigh, not a link. A block holds thousands of transactions; expectedByChance says how many such pairs a random spread would give. Say how strong a link is and what would change it.',
    'The hours are UTC and come from first-seen times where known, else from block times. People work at night and scripts run at any hour.'
  ];

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function owner(an, id) { var c = an && an.clusters && an.clusters.byAddr ? an.clusters.byAddr.get(id) : null; return c ? { key: c.label, cluster: c } : { key: id, cluster: null }; }
  function bump(map, key) { map[key] = (map[key] || 0) + 1; }
  function top(map) { var best = null, total = 0; Object.keys(map).forEach(function (k) { total += map[k]; if (best === null || map[k] > map[best]) best = k; }); return best === null ? null : { value: best, count: map[best], share: map[best] / total }; }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function round3(x) { return Math.round(x * 1000) / 1000; }
  function cut(list, n, what, limits) { if (list.length > n) { limits.push('Only the first ' + n + ' of ' + list.length + ' ' + what + ' are listed.'); return list.slice(0, n); } return list; }

  /** The facts about one signed transaction, or null: { id, txid, group, time, height, event, basis, fp, rate, whole, shape, flags, outTypes }. */
  function factsOf(graph, an, id) {
    var n = graph.nodes.get(id);
    if (!n || n.type !== 'tx' || n.loaded !== true || n.coinbase || n.time == null) return null;
    var v = AN.txView(graph, id);
    if (!v || !v.complete) return null;
    var r = an && an.tx ? an.tx.get(id) : null, flags = r && Array.isArray(r.flags) ? r.flags.map(function (f) { return f.kind; }) : [];
    if (flags.indexOf('coinjoin') >= 0) return null;
    var owners = {}, first = null;
    v.inputs.forEach(function (i) { if (i.type === 'addr') { var o = owner(an, i.id); owners[o.key] = o; first = first || o; } });
    var keys = Object.keys(owners);
    if (keys.length !== 1) return null;
    var fs = XT && n.ext ? XT.firstSeen(n.ext) : null, fp = AN.fingerprint(n);
    var rate = typeof n.fee === 'number' && n.vsize > 0 ? n.fee / n.vsize : null;
    var outTypes = {}; v.outputs.forEach(function (o) { bump(outTypes, o.scriptType || (o.type === 'data' ? 'op_return' : 'unknown')); });
    return { id: id, txid: n.txid, group: first.key, cluster: first.cluster, wallet: first.cluster ? null : id, time: n.time, height: n.height == null ? null : n.height,
             event: fs ? fs.time : n.time, basis: fs ? 'firstSeen' : 'blockTime', fs: fs, fp: fp, rate: rate, whole: rate != null && Math.abs(rate - Math.round(rate)) < 0.005,
             shape: n.nIn + 'in/' + n.nOut + 'out', flags: flags, outTypes: outTypes };
  }

  /** Where a feature changes from one value to another and stays: runs of at least `minRun` on both sides. [{ feature, from, to, lastBefore, firstAfter, txidBefore, txidAfter }] (none when it flips back and forth). */
  function changesOf(list, feature, get, minRun) {
    var runs = [];
    list.forEach(function (f) {
      var val = get(f); if (val == null) return;
      var last = runs[runs.length - 1];
      if (last && last.value === val) { last.n++; last.end = f; } else runs.push({ value: val, n: 1, start: f, end: f });
    });
    if (runs.length < 2 || runs.length > 4) return [];                                   // one run: no change; many runs: a feature that flips back and forth is not a change of habit
    var out = [];
    for (var i = 0; i + 1 < runs.length; i++) {
      if (runs[i].n < minRun || runs[i + 1].n < minRun) return [];
      out.push({ feature: feature, from: runs[i].value, to: runs[i + 1].value, lastBefore: runs[i].end.time, firstAfter: runs[i + 1].start.time, txidBefore: runs[i].end.txid, txidAfter: runs[i + 1].start.txid });
    }
    return out;
  }

  function groupStats(key, list, cfg) {
    list.sort(function (a, b) { return a.time - b.time || (a.txid < b.txid ? -1 : 1); });
    var g = { key: key, cluster: list[0].cluster, wallet: list[0].wallet, facts: list, signed: list.length, first: list[0].time, last: list[list.length - 1].time,
              version: {}, lock: {}, sequence: {}, shape: {}, outputTypes: {}, flags: {}, hoursUtc: [], basis: { firstSeen: 0, blockTime: 0 } }, rates = [], whole = 0, common = 0, i;
    for (i = 0; i < 24; i++) g.hoursUtc.push(0);
    list.forEach(function (f) {
      if (f.fp) { bump(g.version, 'v' + f.fp.version); bump(g.lock, f.fp.lock); bump(g.sequence, f.fp.seqs || 'none'); if (f.fp.common) common++; }
      bump(g.shape, f.shape); Object.keys(f.outTypes).forEach(function (t) { g.outputTypes[t] = (g.outputTypes[t] || 0) + f.outTypes[t]; });
      f.flags.forEach(function (k) { bump(g.flags, k); });
      g.hoursUtc[new Date(f.event * 1000).getUTCHours()]++; g.basis[f.basis]++;
      if (f.rate != null) { rates.push(f.rate); if (f.whole) whole++; }
    });
    g.fee = rates.length ? { n: rates.length, wholeNumberShare: round3(whole / rates.length), min: round3(Math.min.apply(null, rates)), median: round3(median(rates)), max: round3(Math.max.apply(null, rates)) } : null;
    g.commonShare = round3(common / list.length);
    g.changes = [].concat(changesOf(list, 'version', function (f) { return f.fp ? 'v' + f.fp.version : null; }, cfg.minRun),
                          changesOf(list, 'locktime', function (f) { return f.fp ? f.fp.lock : null; }, cfg.minRun),
                          changesOf(list, 'sequence', function (f) { return f.fp ? (f.fp.seqs || 'none') : null; }, cfg.minRun));
    g.dominant = { version: top(g.version), lock: top(g.lock), sequence: top(g.sequence), shape: top(g.shape) };
    return g;
  }

  /** What agrees and what differs between two groups, as { feature, a, b, same, common }; `common` when the value is what ordinary wallets do. */
  function compare(a, b, cfg) {
    var rows = [];
    ['version', 'lock', 'sequence', 'shape'].forEach(function (f) {
      var x = a.dominant[f], y = b.dominant[f];
      if (!x || !y || x.share < cfg.dominant || y.share < cfg.dominant) { rows.push({ feature: f, a: x ? x.value : null, b: y ? y.value : null, same: false, common: false, unclear: true }); return; }
      rows.push({ feature: f, a: x.value, b: y.value, same: x.value === y.value, common: f === 'shape' ? false : a.commonShare >= 0.8 && b.commonShare >= 0.8 });
    });
    if (a.fee && b.fee) {
      var wa = a.fee.wholeNumberShare >= cfg.dominant, wb = b.fee.wholeNumberShare >= cfg.dominant, na = a.fee.wholeNumberShare <= 1 - cfg.dominant, nb = b.fee.wholeNumberShare <= 1 - cfg.dominant;
      if ((wa || na) && (wb || nb)) rows.push({ feature: 'feeRate', a: wa ? 'whole numbers' : 'fractions', b: wb ? 'whole numbers' : 'fractions', same: wa === wb, common: false });
    }
    var overlap = 0; for (var h = 0; h < 24; h++) overlap += Math.min(a.hoursUtc[h] / a.signed, b.hoursUtc[h] / b.signed);
    return { rows: rows, hoursOverlap: round3(overlap), agree: rows.filter(function (r) { return r.same && !r.common; }).length, agreeCommon: rows.filter(function (r) { return r.same && r.common; }).length };
  }

  /**
   * graph, an: a loaded graph and its analysis. opts: { windowSeconds (120), minSigned (3), peers (false), caps, label(groupKey, group) -> text, sameBlock (a module with find(); default the loaded one; false for none) }.
   * Returns { firstSeen, pairs, sameBlock, habits, limits, notes } or null when there is nothing to say.
   */
  function build(graph, an, opts) {
    var cfg = Object.assign({}, DEFAULTS, opts || {}), caps = Object.assign({}, DEFAULTS.caps, opts && opts.caps), limits = [], sb = opts && 'sameBlock' in opts ? opts.sameBlock : SB;
    var facts = new Map(), byGroup = new Map(), fsRows = [], timeRows = [];
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx') return;
      var f = factsOf(graph, an, id);
      if (f) { facts.set(id, f); var l = byGroup.get(f.group); if (!l) byGroup.set(f.group, l = []); l.push(f); }
    });
    // first-seen rows: every transaction a service was asked about (signed by a group or not)
    graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.loaded !== true || !XT || !n.ext) return;
      var fs = XT.firstSeen(n.ext);
      if (!fs) return;
      var rows = XT.timeRows([n]).filter(function (r) { return r.seen && typeof r.received === 'number'; }), ow = facts.get(n.id);
      var row = { txid: n.txid, blockTime: typeof n.time === 'number' ? n.time : null, firstSeen: fs.time, sources: rows.map(function (r) { return r.sourceName; }), waitSeconds: typeof n.time === 'number' ? Math.round(n.time - fs.time) : null,
                  group: ow ? ow.group : null };
      var peer = rows.filter(function (r) { return r.relay; });
      row.relayRecorded = peer.length > 0;
      if (cfg.peers && peer.length) row.relay = peer[0].relay;
      fsRows.push(row); timeRows.push({ id: n.id, time: fs.time });
    });
    fsRows.sort(function (a, b) { return a.firstSeen - b.firstSeen || (a.txid < b.txid ? -1 : 1); });
    var n = fsRows.length, spanFs = n > 1 ? fsRows[n - 1].firstSeen - fsRows[0].firstSeen : 0;
    var firstSeen = n ? { count: n, windowSeconds: cfg.windowSeconds, expectedClosePairs: spanFs > 0 ? round3(n * (n - 1) / 2 * Math.min(1, 2 * cfg.windowSeconds / spanFs)) : null, peersIncluded: !!cfg.peers,
                          rows: cut(fsRows, caps.rows, 'first-seen rows', limits) } : null;

    // pairs between different groups
    var pairs = new Map();
    function addPair(a, b, why, extra) {
      var fa = facts.get(a), fb = facts.get(b);
      if (!fa || !fb || fa.group === fb.group) return;
      var key = fa.txid < fb.txid ? fa.txid + '|' + fb.txid : fb.txid + '|' + fa.txid, p = pairs.get(key);
      if (!p) { p = { txids: fa.txid < fb.txid ? [fa.txid, fb.txid] : [fb.txid, fa.txid], groups: fa.txid < fb.txid ? [fa.group, fb.group] : [fb.group, fa.group], why: [], gapSeconds: null, height: null }; pairs.set(key, p); }
      if (p.why.indexOf(why) < 0) p.why.push(why);
      Object.keys(extra).forEach(function (k) { if (extra[k] != null) p[k] = extra[k]; });
    }
    timeRows.sort(function (a, b) { return a.time - b.time; });
    for (var i = 0; i < timeRows.length; i++) {
      for (var j = i + 1; j < timeRows.length && timeRows[j].time - timeRows[i].time <= cfg.windowSeconds; j++) addPair(timeRows[i].id, timeRows[j].id, 'first seen within ' + cfg.windowSeconds + ' s', { gapSeconds: timeRows[j].time - timeRows[i].time });
    }
    var sbResult = null;
    if (sb && typeof sb.find === 'function') {
      sbResult = sb.find(graph);
      sbResult.blocks.forEach(function (bl) {
        for (var x = 0; x < bl.ids.length; x++) {
          var info = sbResult.byTx.get(bl.ids[x]);
          if (info) info.others.forEach(function (o) { if (bl.ids[x] < o) addPair(bl.ids[x], o, 'same block, no wallet in common', { height: bl.height }); });
        }
      });
    }
    var pairList = Array.from(pairs.values());
    pairList.forEach(function (p) {                                                       // the gap between the two first-seen times, or between the block times
      var fa = facts.get('tx:' + p.txids[0]), fb = facts.get('tx:' + p.txids[1]);
      if (p.gapSeconds == null && fa && fb) p.gapSeconds = Math.abs(fa.time - fb.time);
      if (fa && fb && fa.fs && fb.fs) p.firstSeenGapSeconds = Math.abs(fa.fs.time - fb.fs.time);
    });
    pairList.sort(function (a, b) { return (a.gapSeconds == null ? 1e12 : a.gapSeconds) - (b.gapSeconds == null ? 1e12 : b.gapSeconds) || (a.txids[0] < b.txids[0] ? -1 : 1); });
    var pairTotal = pairList.length; pairList = cut(pairList, caps.pairs, 'pairs', limits);
    var sameBlock = sbResult ? { pairs: sbResult.pairs, blocks: sbResult.blocks.map(function (b) { return b.height; }).slice(0, 20), eligible: sbResult.eligible, span: sbResult.span, expected: round3(sbResult.expected) } : null;

    // habits
    var groups = [];
    byGroup.forEach(function (list, key) { if (list.length >= cfg.minSigned) groups.push(groupStats(key, list, cfg)); });
    groups.sort(function (a, b) { return b.signed - a.signed || (a.key < b.key ? -1 : 1); });
    var groupTotal = groups.length; groups = cut(groups, caps.groups, 'signing groups', limits);
    var cmp = [];
    for (var a = 0; a < groups.length; a++) for (var b = a + 1; b < groups.length; b++) { var c = compare(groups[a], groups[b], cfg); cmp.push({ groups: [groups[a].key, groups[b].key], rows: c.rows, agree: c.agree, agreeCommon: c.agreeCommon, hoursOverlap: c.hoursOverlap }); }
    cmp.sort(function (x, y) { return y.agree - x.agree || y.hoursOverlap - x.hoursOverlap || (x.groups[0] < y.groups[0] ? -1 : 1); });
    var cmpTotal = cmp.length; cmp = cut(cmp, caps.compare, 'comparisons of two groups', limits);
    var habitGroups = groups.map(function (g) {
      return { group: g.key, label: typeof cfg.label === 'function' ? cfg.label(g.key, g) : g.key, wallets: g.cluster ? g.cluster.size : 1, signed: g.signed, first: g.first, last: g.last,
               version: g.version, locktime: g.lock, sequence: g.sequence, shape: top2(g.shape), outputTypes: g.outputTypes, flags: g.flags, fee: g.fee, commonShare: g.commonShare,
               eventBasis: g.basis, hoursUtc: g.hoursUtc, changes: g.changes.slice(0, caps.changes), txids: g.facts.slice(0, 8).map(function (f) { return f.txid; }) };
    });
    if (!firstSeen && !pairList.length && !habitGroups.length && !(sameBlock && sameBlock.pairs)) return null;
    return { firstSeen: firstSeen, pairs: pairList, pairsTotal: pairTotal, sameBlock: sameBlock, habits: { minSigned: cfg.minSigned, groupsTotal: groupTotal, groups: habitGroups, compare: cmp, compareTotal: cmpTotal },
             limits: limits, notes: NOTES };
  }
  function top2(map) { return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || (a < b ? -1 : 1); }).slice(0, 6).reduce(function (o, k) { o[k] = map[k]; return o; }, {}); }

  return { build: build, DEFAULTS: DEFAULTS, NOTES: NOTES };
}));
