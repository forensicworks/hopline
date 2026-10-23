'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../public/js/hopline-group.js');

let n = 0;
const row = (dir, amount, parties, time) => ({ id: 'tx:' + (++n), dir, amount, time: time === undefined ? 1650000000 + n * 60 : time, parties: parties || [] });

test('stats: count, total, smallest, largest and the dates (unknown times ignored)', () => {
  const s = G.stats([row('in', 500, [], 1000), row('in', 100, [], null), row('in', 900, [], 3000)]);
  assert.deepEqual(s, { count: 3, total: 1500, min: 100, max: 900, first: 1000, last: 3000 });
  assert.deepEqual(G.stats([]), { count: 0, total: 0, min: 0, max: 0, first: null, last: null });
});

test('make: rows that share a wallet on the other side become one group, from three rows up', () => {
  const rows = [row('out', 50000, ['addr:X']), row('out', 60000, ['addr:X', 'addr:chg1']), row('out', 70000, ['addr:X', 'addr:chg2']), row('out', 80000, ['addr:Y']), row('out', 90000, ['addr:Z'])];
  const g = G.make(rows, { dustSats: 0 });
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'party'); assert.equal(g[0].party, 'addr:X'); assert.equal(g[0].dir, 'out'); assert.equal(g[0].members.length, 3);
  assert.equal(g[0].key, 'party|out|addr:X');
  assert.equal(G.make(rows.slice(0, 2), { dustSats: 0 }).length, 0, 'two alike are not a group');
});

test('make: direction matters, so the same wallet paying and being paid makes two groups', () => {
  const rows = [row('in', 20000, ['addr:X']), row('in', 21000, ['addr:X']), row('in', 22000, ['addr:X']), row('out', 20000, ['addr:X']), row('out', 21000, ['addr:X']), row('out', 22000, ['addr:X'])];
  const g = G.make(rows, { dustSats: 0 });
  assert.deepEqual(g.map((x) => x.key).sort(), ['party|in|addr:X', 'party|out|addr:X']);
});

test('make: a row lands in at most one group; the wallet shared by the most rows goes first', () => {
  const a = row('out', 30000, ['addr:A', 'addr:B']), b = row('out', 30000, ['addr:A', 'addr:B']), c = row('out', 30000, ['addr:A', 'addr:B']), d = row('out', 30000, ['addr:B']), e = row('out', 30000, ['addr:B']);
  const g = G.make([a, b, c, d, e], { dustSats: 0 });
  assert.equal(g.length, 1, 'B is shared by five rows, A only by three, and the three are taken by B');
  assert.equal(g[0].party, 'addr:B'); assert.equal(g[0].members.length, 5);
});

test('make: after the wallet groups, small rows of one direction are gathered, but only from three up', () => {
  const rows = [row('in', 500, []), row('in', 900, []), row('in', 9999, []), row('in', 10000, []), row('out', 100, []), row('out', 200, [])];
  const g = G.make(rows, { dustSats: 10000 });
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'small'); assert.equal(g[0].dir, 'in'); assert.equal(g[0].members.length, 3, '10000 is not under 10000');
  assert.equal(G.make(rows, { dustSats: 0 }).length, 0, 'zero switches the small-amount groups off');
});

test('make: a wallet group takes its small rows with it, and the small group only gets what is left', () => {
  const rows = [row('out', 500, ['addr:X']), row('out', 600, ['addr:X']), row('out', 700, ['addr:X']), row('out', 800, []), row('out', 900, []), row('out', 950, [])];
  const g = G.make(rows, { dustSats: 10000 });
  assert.deepEqual(g.map((x) => x.kind + ':' + x.members.length), ['party:3', 'small:3']);
});

test('make: rows without a wallet on the other side never form a wallet group, and duplicates in one row count once', () => {
  assert.equal(G.make([row('in', 50000, []), row('in', 50000, []), row('in', 50000, [])], { dustSats: 0 }).length, 0);
  const g = G.make([row('in', 50000, ['addr:X', 'addr:X']), row('in', 50000, ['addr:X']), row('in', 50000, ['addr:X'])], { dustSats: 0 });
  assert.equal(g.length, 1); assert.equal(g[0].members.length, 3);
});

test('make is deterministic and does not change its input', () => {
  const rows = [row('out', 50000, ['addr:Y']), row('out', 60000, ['addr:Y']), row('out', 70000, ['addr:Y']), row('out', 1, ['addr:X']), row('out', 2, ['addr:X']), row('out', 3, ['addr:X'])];
  const copy = rows.slice();
  const a = G.make(rows, { dustSats: 0 }), b = G.make(rows.slice().reverse(), { dustSats: 0 });
  assert.deepEqual(rows, copy);
  assert.deepEqual(a.map((x) => x.key), b.map((x) => x.key), 'a tie is broken by the total, then by name, not by the order of the rows');
  assert.equal(a[0].party, 'addr:Y', 'the larger total first');
});

test('layout: a group sits where its first member is, the others disappear into it, numbers are attached', () => {
  const r1 = row('out', 100, ['addr:X'], 10), r2 = row('out', 50000, ['addr:Q'], 20), r3 = row('out', 200, ['addr:X'], 30), r4 = row('out', 300, ['addr:X'], 40), r5 = row('out', 60000, ['addr:R'], 50);
  const sorted = [r2, r1, r5, r3, r4];                                          // the order being shown
  const groups = G.make(sorted, { dustSats: 0 });
  const items = G.layout(sorted, groups);
  assert.deepEqual(items.map((i) => i.type), ['row', 'group', 'row']);
  assert.equal(items[0].row, r2); assert.equal(items[2].row, r5);
  const g = items[1].group;
  assert.deepEqual(g.members, [r1, r3, r4], 'members in the order shown');
  assert.equal(g.stats.count, 3); assert.equal(g.stats.total, 600); assert.equal(g.stats.first, 10); assert.equal(g.stats.last, 40);
});

test('layout: every row is accounted for exactly once', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row(i % 2 ? 'in' : 'out', 100 + i * 1000, i % 5 === 0 ? ['addr:big'] : ['addr:p' + i]));
  const groups = G.make(rows, { dustSats: 5000 });
  const items = G.layout(rows, groups);
  const seen = [];
  items.forEach((it) => { if (it.type === 'row') seen.push(it.row); else it.group.members.forEach((m) => seen.push(m)); });
  assert.equal(seen.length, 40); assert.equal(new Set(seen).size, 40);
});

test('layout drops members that are not in the list being shown (a filter) and keeps the rest', () => {
  const a = row('in', 50000, ['addr:X']), b = row('in', 50000, ['addr:X']), c = row('in', 50000, ['addr:X']);
  const groups = G.make([a, b, c], { dustSats: 0 });
  const items = G.layout([a, c], groups);
  assert.equal(items.length, 1); assert.deepEqual(items[0].group.members, [a, c]); assert.equal(items[0].group.stats.count, 2);
});

test('vertex: a group behind a wallet acts as the transaction, so the edge has the shape the rest of the page expects', () => {
  const rows = [{ id: 'tx:a', amount: 500, time: 100 }, { id: 'tx:b', amount: 700, time: 300 }, { id: 'tx:c', amount: 200, time: 200 }];
  const spec = { id: 'grp:1', anchor: 'addr:W', dir: 'next', kind: 'party', party: 'addr:X', members: ['tx:a', 'tx:b', 'tx:c'] };
  const v = G.vertex(spec, 'addr', rows);
  assert.equal(v.node.type, 'group'); assert.equal(v.node.virtual, true); assert.equal(v.node.count, 3);
  assert.equal(v.node.received, 1400, 'the total is the size the vertex is drawn at'); assert.equal(v.node.time, 100); assert.equal(v.node.lastSeen, 300);
  assert.equal(v.node.min, 200); assert.equal(v.node.max, 700); assert.deepEqual(v.node.members, ['tx:a', 'tx:b', 'tx:c']);
  assert.deepEqual([v.edge.kind, v.edge.source, v.edge.target, v.edge.amount], ['in', 'addr:W', 'grp:1', 1400], 'money flows wallet -> group; an input edge belongs to the transaction at its target');
  assert.equal(v.edge.virtual, true); assert.equal(v.edge.id, 'grpe:grp:1');
  const back = G.vertex(Object.assign({}, spec, { dir: 'prev' }), 'addr', rows);
  assert.deepEqual([back.edge.kind, back.edge.source, back.edge.target], ['out', 'grp:1', 'addr:W'], 'transactions that paid the wallet: an output edge of the group');
});

test('vertex: a group behind a transaction acts as the wallets', () => {
  const rows = [{ id: 'addr:a', amount: 10, time: 5 }, { id: 'addr:b', amount: 20, time: 5 }];
  const fwd = G.vertex({ id: 'grp:2', anchor: 'tx:T', dir: 'next', kind: 'small', party: null, members: ['addr:a', 'addr:b'] }, 'tx', rows);
  assert.deepEqual([fwd.edge.kind, fwd.edge.source, fwd.edge.target], ['out', 'tx:T', 'grp:2']);
  const bwd = G.vertex({ id: 'grp:2', anchor: 'tx:T', dir: 'prev', kind: 'small', party: null, members: ['addr:a', 'addr:b'] }, 'tx', rows);
  assert.deepEqual([bwd.edge.kind, bwd.edge.source, bwd.edge.target], ['in', 'grp:2', 'tx:T']);
  assert.equal(fwd.node.party, null);
});

test('isGroupId only accepts the ids groups are given', () => {
  assert.equal(G.isGroupId('grp:1'), true); assert.equal(G.isGroupId('grp:123456789'), true);
  ['grp:', 'grp:x', 'tx:abc', 'grp:1234567890', 'grpe:grp:1', '', null, undefined, 5].forEach((x) => assert.equal(G.isGroupId(x), false, String(x)));
});

// ---- grouping by the period rows happened in ------------------------------------------------------------------------------
const utc = (y, m, d, h = 0, mi = 0, s = 0) => Math.floor(Date.UTC(y, m - 1, d, h, mi, s) / 1000);

test('bucketOf: the UTC day, ISO week, month and year of a time, with the edges where they are easy to get wrong', () => {
  const t = 1650000000;                                                              // 2022-04-15 05:20:00 UTC, a Friday
  assert.equal(G.bucketOf(t, 'day'), '2022-04-15'); assert.equal(G.bucketOf(t, 'week'), '2022-W15');
  assert.equal(G.bucketOf(t, 'month'), '2022-04'); assert.equal(G.bucketOf(t, 'year'), '2022');
  assert.equal(G.bucketOf(utc(2022, 4, 30, 23, 59, 59), 'month'), '2022-04'); assert.equal(G.bucketOf(utc(2022, 5, 1), 'month'), '2022-05', 'the midnight is UTC, not local');
  assert.equal(G.bucketOf(utc(2021, 1, 1), 'week'), '2020-W53', 'the first days of January can belong to the last week of the year before');
  assert.equal(G.bucketOf(utc(2024, 12, 30), 'week'), '2025-W01', 'and the last days of December to the first week of the next');
  assert.equal(G.bucketOf(utc(2024, 12, 29), 'week'), '2024-W52', 'Sunday ends a week; Monday starts the next');
  assert.equal(G.bucketOf(utc(2022, 1, 3), 'week'), '2022-W01'); assert.equal(G.bucketOf(utc(2022, 1, 2), 'week'), '2021-W52');
  assert.equal(G.bucketOf(0, 'day'), '1970-01-01'); assert.equal(G.bucketOf(utc(2009, 1, 3), 'year'), '2009');
});

test('bucketLabel and isBucketKey: for people, and for checking what a saved file says', () => {
  assert.equal(G.bucketLabel('2022-04'), 'Apr 2022'); assert.equal(G.bucketLabel('2022-W15'), 'week 15 of 2022'); assert.equal(G.bucketLabel('2022-04-15'), '2022-04-15'); assert.equal(G.bucketLabel('2022'), '2022');
  ['2022', '2022-04', '2022-04-15', '2022-W15'].forEach((k) => assert.equal(G.isBucketKey(k), true, k));
  ['', '22-04', '2022-4', '2022-W1', '2022-04-15x', '<b>2022</b>', null, 5, '2022-W15-1'].forEach((k) => assert.equal(G.isBucketKey(k), false, String(k)));
  assert.deepEqual(G.BUCKETS.slice().sort(), ['day', 'month', 'week', 'year']);
});

test('make by month: a group for each direction and month with enough rows, the rest stay rows', () => {
  const rows = [];
  const add = (n, dir, y, m, id) => { for (let i = 0; i < n; i++) rows.push({ id: id + i, dir, amount: 1000 + i, time: utc(y, m, 1 + i), parties: ['addr:p' + id + i] }); };
  add(4, 'out', 2022, 3, 'a'); add(3, 'out', 2022, 4, 'b'); add(2, 'out', 2022, 5, 'c'); add(3, 'in', 2022, 4, 'd');
  rows.push({ id: 'noDate', dir: 'out', amount: 5, time: null, parties: [] });
  const groups = G.make(rows, { by: 'month' });
  assert.deepEqual(groups.map((g) => [g.key, g.members.length]), [['time|out|2022-03', 4], ['time|in|2022-04', 3], ['time|out|2022-04', 3]], 'the biggest first; two in May is not enough');
  assert.ok(groups.every((g) => g.kind === 'time' && g.party === null && /^2022-0[34]$/.test(g.bucket)));
  assert.ok(groups.every((g) => g.members.every((r) => G.bucketOf(r.time, 'month') === g.bucket && r.dir === g.dir)));
  const used = new Set(groups.flatMap((g) => g.members.map((r) => r.id)));
  assert.ok(!used.has('noDate') && !used.has('c0'), 'a row with no date, and a month with too few, are not folded');
  assert.equal(G.make(rows, { by: 'month', minSize: 2 }).length, 4, 'minSize still decides how many make a group');
});

test('make by period: week, day and year work the same way, an unknown period falls back to the usual grouping', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: 'r' + i, dir: 'out', amount: 50, time: utc(2022, 4, 11 + i, 12), parties: ['addr:same'] }));      // Mon 11 .. Sat 16 April
  assert.deepEqual(G.make(rows, { by: 'week' }).map((g) => [g.bucket, g.members.length]), [['2022-W15', 6]]);
  assert.equal(G.make(rows, { by: 'day' }).length, 0, 'one a day is not a group');
  assert.deepEqual(G.make(rows, { by: 'year' }).map((g) => [g.bucket, g.members.length]), [['2022', 6]]);
  assert.equal(G.make(rows, { by: 'fortnight' })[0].kind, 'party', 'an unknown period is ignored');
  assert.equal(G.make(rows, {})[0].kind, 'party'); assert.equal(G.make(rows, { by: 'party' })[0].kind, 'party');
  const split = rows.slice(); split[5] = Object.assign({}, rows[5], { time: utc(2022, 4, 17, 12) });         // Sunday: still week 15
  assert.equal(G.make(split, { by: 'week' })[0].members.length, 6);
  split[5] = Object.assign({}, rows[5], { time: utc(2022, 4, 18, 0, 0, 1) });                                    // Monday 00:00:01: week 16
  assert.deepEqual(G.make(split, { by: 'week' }).map((g) => [g.bucket, g.members.length]), [['2022-W15', 5]]);
});

test('layout and stats work on groups made by period like on any other', () => {
  const rows = [3, 1, 2].map((i) => ({ id: 'x' + i, dir: 'in', amount: 100 * i, time: utc(2022, 6, i), parties: [] }));
  const items = G.layout(rows, G.make(rows, { by: 'month' }));
  assert.equal(items.length, 1); assert.equal(items[0].group.stats.count, 3); assert.equal(items[0].group.stats.total, 600);
  assert.deepEqual(items[0].group.members.map((r) => r.id), ['x3', 'x1', 'x2'], 'members in the order the list shows them');
});
