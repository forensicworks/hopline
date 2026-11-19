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
      var x = a.dominant[f], y = b.dominant[f], xs = !!x && x.share >= cfg.dominant, ys = !!y && y.share >= cfg.dominant;
      if (!x || !y) { rows.push({ feature: f, a: x ? x.value : null, b: y ? y.value : null, same: false, mixed: false, missing: true, common: false }); return; }                // no transaction of one of them carries it: not known
      if (!xs || !ys) { rows.push({ feature: f, a: xs ? x.value : null, b: ys ? y.value : null, same: false, mixed: true, common: false }); return; }      // one of them has no single habit: not the same, not different either
      rows.push({ feature: f, a: x.value, b: y.value, same: x.value === y.value, mixed: false, common: f === 'shape' ? false : a.commonShare >= 0.8 && b.commonShare >= 0.8 });
    });
    if (a.fee && b.fee) {
      var wa = a.fee.wholeNumberShare >= cfg.dominant, wb = b.fee.wholeNumberShare >= cfg.dominant, na = a.fee.wholeNumberShare <= 1 - cfg.dominant, nb = b.fee.wholeNumberShare <= 1 - cfg.dominant;
      if ((wa || na) && (wb || nb)) rows.push({ feature: 'feeRate', a: wa ? 'whole numbers' : 'fractions', b: wb ? 'whole numbers' : 'fractions', same: wa === wb, mixed: false, common: false });
      else rows.push({ feature: 'feeRate', a: wa ? 'whole numbers' : na ? 'fractions' : null, b: wb ? 'whole numbers' : nb ? 'fractions' : null, same: false, mixed: true, common: false });
    }
    var overlap = 0; for (var h = 0; h < 24; h++) overlap += Math.min(a.hoursUtc[h] / a.signed, b.hoursUtc[h] / b.signed);
    return { rows: rows, hoursOverlap: round3(overlap), agree: rows.filter(function (r) { return r.same && !r.common; }).length, agreeCommon: rows.filter(function (r) { return r.same && r.common; }).length };
  }

  /** The changes of habit two groups share: the same feature changing the same way. Each group changed somewhere between its last transaction before and its first after, so each has a window; `overlap` is where the windows meet, or null. */
  function changeMatches(a, b) {
    var out = [];
    a.changes.forEach(function (ca) {
      b.changes.forEach(function (cb) {
        if (ca.feature !== cb.feature || ca.from !== cb.from || ca.to !== cb.to) return;
        var lo = Math.max(ca.lastBefore, cb.lastBefore), hi = Math.min(ca.firstAfter, cb.firstAfter);
        out.push({ feature: ca.feature, from: ca.from, to: ca.to, windowA: [ca.lastBefore, ca.firstAfter], windowB: [cb.lastBefore, cb.firstAfter], overlap: lo <= hi ? [lo, hi] : null });
      });
    });
    return out;
  }

  /**
   * graph, an: a loaded graph and its analysis. opts: { windowSeconds (120), minSigned (3), peers (false), caps, role(groupKey, group) -> the tags of its wallets (a group of VICTIM only is left out), trails (Map of transaction vertex id -> the starting points it descends from), label(groupKey, group) -> text, sameBlock (a module with find(); default the loaded one; false for none) }.
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
    // groups made only of wallets tagged VICTIM are not actors: they are left out of the pairs and the habits (and counted)
    var victims = 0;
    if (typeof cfg.role === 'function') {
      Array.from(byGroup.keys()).forEach(function (key) {
        var list = byGroup.get(key);
        if (String(cfg.role(key, { cluster: list[0].cluster }) || '').trim() === 'VICTIM') { list.forEach(function (f) { facts.delete(f.id); }); byGroup.delete(key); victims++; }
      });
    }
    // the starting points each transaction descends from (coins followed forward from each): a Map of transaction vertex id -> [starting point ids]
    var trails = cfg.trails instanceof Map ? cfg.trails : null;
    facts.forEach(function (f, id) { f.trails = trails && trails.get(id) ? trails.get(id).slice().sort() : []; });
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
      p.trails = [fa ? fa.trails : [], fb ? fb.trails : []];
      p.linksTwoTrails = p.trails[0].length > 0 && p.trails[1].length > 0 && !p.trails[0].some(function (s) { return p.trails[1].indexOf(s) >= 0; });
      if (p.gapSeconds == null && fa && fb) p.gapSeconds = Math.abs(fa.time - fb.time);
      if (fa && fb && fa.fs && fb.fs) p.firstSeenGapSeconds = Math.abs(fa.fs.time - fb.fs.time);
      if (p.gapSeconds != null) p.gapSeconds = round3(p.gapSeconds);                        // first-seen times have fractions of a second: milliseconds are enough
      if (p.firstSeenGapSeconds != null) p.firstSeenGapSeconds = round3(p.firstSeenGapSeconds);
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
    for (var a = 0; a < groups.length; a++) for (var b = a + 1; b < groups.length; b++) {
      var c = compare(groups[a], groups[b], cfg), cm = changeMatches(groups[a], groups[b]), meet = cm.filter(function (m) { return m.overlap; }).length;
      var ta = unionTrails(groups[a].facts), tb = unionTrails(groups[b].facts), shared = ta.filter(function (x) { return tb.indexOf(x) >= 0; });
      cmp.push({ groups: [groups[a].key, groups[b].key], rows: c.rows, agree: c.agree, agreeCommon: c.agreeCommon, hoursOverlap: c.hoursOverlap, changeMatches: cm, score: c.agree + meet,
                 trails: [ta, tb], sharedStartingPoints: shared, linksTwoTrails: ta.length > 0 && tb.length > 0 && shared.length === 0 });
    }
    cmp.sort(function (x, y) { return y.score - x.score || y.hoursOverlap - x.hoursOverlap || (x.groups[0] < y.groups[0] ? -1 : 1); });
    var cmpTotal = cmp.length; cmp = cut(cmp, caps.compare, 'comparisons of two groups', limits);
    var anyTrail = false; facts.forEach(function (f) { if (f.trails.length) anyTrail = true; });
    var haveHabits = new Set(groups.map(function (g) { return g.key; })), sourcesOf = new Map(fsRows.map(function (r) { return [r.txid, r.sources]; }));
    pairList.forEach(function (p) {                                                       // what limits a pair, said by code so that a model need not guess it
      var cons = [], sa = sourcesOf.get(p.txids[0]), sb = sourcesOf.get(p.txids[1]);
      if (sa && sb && sa.join(' + ') !== sb.join(' + ')) cons.push('the first-seen times come from different services (' + p.txids[0] + ': ' + sa.join(' + ') + '; ' + p.txids[1] + ': ' + sb.join(' + ') + ')');
      [0, 1].forEach(function (i) {
        var f = facts.get('tx:' + p.txids[i]);
        if (f && !haveHabits.has(f.group)) cons.push('no habit record for ' + p.txids[i] + ': its signing group has fewer than ' + cfg.minSigned + ' signed transactions, so its habits cannot be compared');
      });
      var shared = p.trails[0].filter(function (s) { return p.trails[1].indexOf(s) >= 0; });
      if (shared.length) cons.push('both transactions descend from the same starting point (' + shared.join(', ') + '), so this pair does not link two trails');
      p.considerations = cons;
    });
    // what the habits of the two groups of a pair say, compared here so that nobody has to borrow the comparison of two other groups; a group with too few signed transactions cannot be compared
    function habitsOfGroups(ka, kb) {
      var la = byGroup.get(ka) || [], lb = byGroup.get(kb) || [], thin = [];
      [[ka, la], [kb, lb]].forEach(function (x) { if (x[1].length < cfg.minSigned) thin.push({ group: x[0], signed: x[1].length }); });
      if (thin.length) return { comparable: false, thin: thin };
      var ga = groupStats(ka, la, cfg), gb = groupStats(kb, lb, cfg), c = compare(ga, gb, cfg);
      return { comparable: true, rows: c.rows, agree: c.agree, agreeCommon: c.agreeCommon, changeMatches: changeMatches(ga, gb) };
    }
    // the pairs that connect two starting points, grouped by the two (null when no transaction has a trail: nothing is claimed)
    var linkMap = new Map();
    pairList.forEach(function (p) {
      if (!p.linksTwoTrails) return;
      p.trails[0].forEach(function (sa) {
        p.trails[1].forEach(function (sb) {
          if (sa === sb) return;
          var two = sa < sb ? [sa, sb] : [sb, sa], key = two.join('|'), l = linkMap.get(key);
          if (!l) linkMap.set(key, l = { startingPoints: two, pairs: [] });
          var iA = sa < sb ? 0 : 1, iB = 1 - iA;                                      // which side of the pair descends from the first of the two starting points
          l.pairs.push({ txids: p.txids, fromStartingPointA: p.txids[iA], fromStartingPointB: p.txids[iB], groupOfA: p.groups[iA], groupOfB: p.groups[iB], gapSeconds: p.gapSeconds, why: p.why, height: p.height, considerations: p.considerations,
                              habits: habitsOfGroups(p.groups[iA], p.groups[iB]) });
        });
      });
    });
    var trailLinks = anyTrail ? Array.from(linkMap.values()) : null;
    var habitGroups = groups.map(function (g) {
      return { group: g.key, label: typeof cfg.label === 'function' ? cfg.label(g.key, g) : g.key, wallets: g.cluster ? g.cluster.size : 1, signed: g.signed, first: g.first, last: g.last,
               version: g.version, locktime: g.lock, sequence: g.sequence, shape: top2(g.shape), outputTypes: g.outputTypes, flags: g.flags, fee: g.fee, commonShare: g.commonShare,
               eventBasis: g.basis, hoursUtc: g.hoursUtc, changes: g.changes.slice(0, caps.changes), txids: g.facts.slice(0, 8).map(function (f) { return f.txid; }),
               role: typeof cfg.role === 'function' ? String(cfg.role(g.key, g) || '') : '', trails: unionTrails(g.facts) };
    });
    if (!firstSeen && !pairList.length && !habitGroups.length && !(sameBlock && sameBlock.pairs)) return null;
    return { firstSeen: firstSeen, pairs: pairList, pairsTotal: pairTotal, trailLinks: trailLinks, sameBlock: sameBlock, habits: { minSigned: cfg.minSigned, groupsTotal: groupTotal, victimGroupsLeftOut: victims, groups: habitGroups, compare: cmp, compareTotal: cmpTotal },
             limits: limits, notes: NOTES };
  }
  function unionTrails(list) { var s = new Set(); list.forEach(function (f) { (f.trails || []).forEach(function (t) { s.add(t); }); }); return Array.from(s).sort(); }
  function top2(map) { return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || (a < b ? -1 : 1); }).slice(0, 6).reduce(function (o, k) { o[k] = map[k]; return o; }, {}); }

  /** The group a vertex belongs to: a wallet's owner (its cluster, else itself) or the signing group of a transaction; null for anything else. */
  function groupOf(graph, an, id) {
    var n = graph.nodes.get(id);
    if (!n) return null;
    if (n.type === 'addr') return owner(an, id).key;
    if (n.type === 'tx') { var f = factsOf(graph, an, id); return f ? f.group : null; }
    return null;
  }

  /**
   * Two signing groups side by side, from what is loaded. NOT A FINDING: a similarity or a coincidence to weigh, with how many such pairs a random spread would give.
   * keyA, keyB: group keys (from groupOf). opts: the same as build() (windowSeconds, minSigned, label, trails, sameBlock).
   * Returns { groups: [{ key, label, signed, first, last, wallets, trails, version, locktime, sequence, shape, fee, hoursUtc, changes }], pairs: [{ txids, why, gapSeconds, firstSeenGapSeconds, height, considerations }],
   *           expected: { sameBlock, closeFirstSeen }, habits: { rows, agree, agreeCommon, hoursOverlap, changeMatches }, startingPoints: { a, b, shared, linksTwoTrails }, considerations }
   * or { error } when a group has no signed transaction loaded.
   */
  function compareGroups(graph, an, keyA, keyB, opts) {
    var cfg = Object.assign({}, DEFAULTS, opts || {}), sb = opts && 'sameBlock' in opts ? opts.sameBlock : SB, trails = cfg.trails instanceof Map ? cfg.trails : null;
    var lists = { a: [], b: [] };
    graph.nodes.forEach(function (n, id) {
      if (n.type !== 'tx') return;
      var f = factsOf(graph, an, id);
      if (!f || (f.group !== keyA && f.group !== keyB)) return;
      f.trails = trails && trails.get(id) ? trails.get(id).slice().sort() : [];
      (f.group === keyA ? lists.a : lists.b).push(f);
    });
    if (keyA === keyB) return { error: 'Both belong to one group: pick wallets of two different groups.' };
    if (!lists.a.length || !lists.b.length) return { error: 'No signed transaction is loaded for ' + (!lists.a.length ? 'the first' : 'the second') + ' group, so there is nothing to compare.' };
    var ga = groupStats(keyA, lists.a, cfg), gb = groupStats(keyB, lists.b, cfg);
    // the pairs between the two: first seen close in time, or the same block with no wallet in common
    var sbRes = sb && typeof sb.find === 'function' ? sb.find(graph) : null, pairs = [], sourcesOf = function (f) { return f.fs ? XT.timeRows([graph.nodes.get(f.id)]).filter(function (r) { return r.seen && typeof r.received === 'number'; }).map(function (r) { return r.sourceName; }) : null; };
    lists.a.forEach(function (fa) {
      lists.b.forEach(function (fb) {
        var why = [], gap = null;
        if (fa.fs && fb.fs && Math.abs(fa.fs.time - fb.fs.time) <= cfg.windowSeconds) { why.push('first seen within ' + cfg.windowSeconds + ' s'); gap = Math.abs(fa.fs.time - fb.fs.time); }
        var info = sbRes ? sbRes.byTx.get(fa.id) : null;
        if (info && info.others.indexOf(fb.id) >= 0) why.push('same block, no wallet in common');
        if (!why.length) return;
        var cons = [], sa = sourcesOf(fa), sbb = sourcesOf(fb), shared = fa.trails.filter(function (t) { return fb.trails.indexOf(t) >= 0; });
        if (sa && sbb && sa.join(' + ') !== sbb.join(' + ')) cons.push('the first-seen times come from different services (' + fa.txid + ': ' + sa.join(' + ') + '; ' + fb.txid + ': ' + sbb.join(' + ') + ')');
        if (shared.length) cons.push('both transactions descend from the same starting point (' + shared.join(', ') + '), so this pair does not link two trails');
        pairs.push({ txids: [fa.txid, fb.txid], why: why, gapSeconds: round3(gap == null ? Math.abs(fa.time - fb.time) : gap), firstSeenGapSeconds: fa.fs && fb.fs ? round3(Math.abs(fa.fs.time - fb.fs.time)) : null,
                     height: fa.height != null && fa.height === fb.height ? fa.height : null, considerations: cons });
      });
    });
    pairs.sort(function (x, y) { return x.gapSeconds - y.gapSeconds || (x.txids[0] < y.txids[0] ? -1 : 1); });
    // how many such pairs a random spread of these two groups' transactions would give (a yardstick: activity comes in bursts, so the real chance is higher)
    var all = lists.a.concat(lists.b), heights = all.filter(function (f) { return f.height != null; }).map(function (f) { return f.height; });
    var spanBlocks = heights.length ? Math.max.apply(null, heights) - Math.min.apply(null, heights) + 1 : 0;
    var fsA = lists.a.filter(function (f) { return f.fs; }), fsB = lists.b.filter(function (f) { return f.fs; }), fsTimes = fsA.concat(fsB).map(function (f) { return f.fs.time; });
    var spanFs = fsTimes.length > 1 ? Math.max.apply(null, fsTimes) - Math.min.apply(null, fsTimes) : 0;
    var expected = { sameBlock: spanBlocks ? round3(lists.a.length * lists.b.length / spanBlocks) : null,
                     closeFirstSeen: spanFs > 0 ? round3(fsA.length * fsB.length * Math.min(1, 2 * cfg.windowSeconds / spanFs)) : null };
    var c = compare(ga, gb, cfg), ta = unionTrails(lists.a), tb = unionTrails(lists.b), sharedStarts = ta.filter(function (x) { return tb.indexOf(x) >= 0; }), cons = [];
    [[ga, lists.a], [gb, lists.b]].forEach(function (pair) { if (pair[1].length < cfg.minSigned) cons.push('the group of ' + pair[1][0].txid + ' has only ' + pair[1].length + ' signed transaction' + (pair[1].length === 1 ? '' : 's') + ' (fewer than ' + cfg.minSigned + '), so its habits are thin'); });
    if (sharedStarts.length) cons.push('both groups descend from the same starting point (' + sharedStarts.join(', ') + '), so their similarity does not link two starting points');
    function view(g, list) {
      return { key: g.key, label: typeof cfg.label === 'function' ? cfg.label(g.key, g) : g.key, signed: g.signed, first: g.first, last: g.last, wallets: g.cluster ? g.cluster.size : 1, trails: unionTrails(list),
               version: g.version, locktime: g.lock, sequence: g.sequence, shape: top2(g.shape), fee: g.fee, hoursUtc: g.hoursUtc, changes: g.changes, txids: list.slice(0, 8).map(function (f) { return f.txid; }) };
    }
    return { groups: [view(ga, lists.a), view(gb, lists.b)], pairs: pairs, expected: expected,
             habits: { rows: c.rows, agree: c.agree, agreeCommon: c.agreeCommon, hoursOverlap: c.hoursOverlap, changeMatches: changeMatches(ga, gb) },
             startingPoints: { a: ta, b: tb, shared: sharedStarts, linksTwoTrails: ta.length > 0 && tb.length > 0 && sharedStarts.length === 0 }, considerations: cons };
  }

  return { build: build, compareGroups: compareGroups, groupOf: groupOf, DEFAULTS: DEFAULTS, NOTES: NOTES };
}));
