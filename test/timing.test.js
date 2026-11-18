'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const AN = require('../public/js/hopline-analysis.js');
const TM = require('../public/js/hopline-timing.js');

const tid = (n) => n.toString(16).padStart(64, '0');
const adr = (name) => 'bc1q' + name.padEnd(20, 'x');
// An Esplora-shaped transaction: ins [spentTxNumber, vout, wallet, value], outs [wallet, value]; `at` is seconds after T0 (the block is the ten-minute slot, height 1000 + slot)
const T0 = 1700006400;                                              // a round day: 2023-11-15 00:00:00 UTC
function tx(n, ins, outs, at, over) {
  const vin = ins.map(([p, vout, who, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value } }));
  const fee = ins.reduce((s, i) => s + i[3], 0) - outs.reduce((s, o) => s + o[1], 0);
  return Object.assign({ txid: tid(n), fee, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 1000 + Math.floor((at || 0) / 600), block_time: T0 + (at || 0) },
                         vin, vout: outs.map(([who, value]) => ({ scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value })) }, over);
}
// A transaction of one wallet: one input, one output, a fee of 400 sat on 200 vB (a whole 2.00 sat/vB). `o` = { version, seq, fee }
function signed(n, who, at, o) {
  o = o || {};
  const t = tx(n, [[500 + n, 0, who, 50000]], [[who + 'to' + n, 50000 - (o.fee || 400)]], at, o.version ? { version: o.version } : null);
  if (o.seq != null) t.vin.forEach((v) => { v.sequence = o.seq; });
  return t;
}
const build = (txs) => { const g = new Graph(); txs.forEach((t) => g.addTx(t)); g.refreshDerived(); return g; };
const seen = (g, n, received, extra) => { g.nodes.get(ID.tx(tid(n))).ext = { blockcypher: Object.assign({ found: true, seen: true, received, confirmed: T0, relay: '203.0.113.7:8333', height: 1000, at: 0 }, extra) }; };
const SBK = require('../public/js/hopline-sameblock.js');
const run = (g, opts) => TM.build(g, AN.analyse(g, {}), Object.assign({ sameBlock: false }, opts));      // no same-block pairs unless a test asks for them
const group = (r, who) => r.habits.groups.find((x) => x.group === ID.addr(adr(who)));

test('nothing to say: no first-seen times, no group of three, no pairs: null', () => {
  assert.equal(run(build([signed(1, 'aa', 0), signed(2, 'bb', 100)])), null);
  assert.equal(run(new Graph()), null);
});

test('first seen: the earliest of the services, the wait until the block, which services, and the relay peer only when asked for', () => {
  const g = build([signed(1, 'aa', 600)]);
  seen(g, 1, T0 + 540.5);
  g.nodes.get(ID.tx(tid(1))).ext.blockchaincom = { found: true, seen: true, received: T0 + 560, confirmed: T0 + 600, height: 1001, at: 0 };
  const r = run(g);
  assert.equal(r.firstSeen.count, 1);
  const row = r.firstSeen.rows[0];
  assert.deepEqual([row.txid, row.blockTime, row.firstSeen, row.waitSeconds, row.group], [tid(1), T0 + 600, T0 + 540.5, 60, ID.addr(adr('aa'))]);
  assert.deepEqual(row.sources, ['BlockCypher', 'Blockchain.com']);
  assert.equal(row.relayRecorded, true);
  assert.equal('relay' in row, false, 'the peer is left out by default');
  assert.equal(JSON.stringify(r).includes('203.0.113.7'), false, 'and nowhere else in the block');
  const withPeers = run(g, { peers: true });
  assert.equal(withPeers.firstSeen.rows[0].relay, '203.0.113.7:8333');
  assert.equal(withPeers.firstSeen.peersIncluded, true);
});

test('a service that had no record does not make a first-seen row', () => {
  const g = build([signed(1, 'aa', 0), signed(2, 'bb', 0)]);
  seen(g, 1, null, { seen: false, received: null });
  assert.equal(run(g), null);
});

test('pairs: transactions of different groups first seen within the window, with the gap; the same group and a later one are not pairs', () => {
  const g = build([signed(1, 'aa', 600), signed(2, 'bb', 600), signed(3, 'aa', 1200), signed(4, 'cc', 1200)]);
  seen(g, 1, T0 + 520); seen(g, 2, T0 + 578); seen(g, 3, T0 + 1100); seen(g, 4, T0 + 1300);        // 1 and 2: 58 s apart; 3 is the same group as 1 (but 580 s later); 4 is 200 s after 3
  const r = run(g);
  assert.equal(r.pairs.length, 1);
  assert.deepEqual([r.pairs[0].txids, r.pairs[0].why, r.pairs[0].gapSeconds, r.pairs[0].firstSeenGapSeconds], [[tid(1), tid(2)], ['first seen within 120 s'], 58, 58]);
  assert.deepEqual(r.pairs[0].groups, [ID.addr(adr('aa')), ID.addr(adr('bb'))]);
  assert.equal(run(g, { windowSeconds: 250 }).pairs.length, 2, 'a wider window adds 3-4 (200 s); 1-3 are the same group and 2-3 are 522 s apart');
  assert.ok(r.firstSeen.expectedClosePairs > 0, 'a yardstick for how many close pairs a random spread would give');
  seen(g, 2, T0 + 700);
  assert.equal(run(g).pairs.length, 0, 'now 180 s apart');
  seen(g, 2, T0 + 640);
  assert.equal(run(g).pairs.length, 1, 'exactly 120 s apart: inside the window');
  seen(g, 2, T0 + 641);
  assert.equal(run(g).pairs.length, 0, '121 s: outside it');
  seen(g, 2, T0 + 578); seen(g, 3, T0 + 530);
  assert.deepEqual(run(g).pairs.map((p) => p.txids), [[tid(2), tid(3)], [tid(1), tid(2)]], 'the closest first; 1 and 3 are 10 s apart but of one group: not a pair');
});

test('pairs: gaps between first-seen times are rounded to milliseconds', () => {
  const g = build([signed(1, 'aa', 600), signed(2, 'bb', 600), signed(3, 'aa', 1200)]);
  seen(g, 1, T0 + 520.1234567); seen(g, 2, T0 + 578.4);
  const r = run(g);
  assert.deepEqual([r.pairs[0].gapSeconds, r.pairs[0].firstSeenGapSeconds], [58.277, 58.277]);
});

test('pairs: the same block with no wallet in common comes from the same-block module, and a pair that is both is one pair with both reasons', () => {
  const g = build([signed(1, 'aa', 600), signed(2, 'bb', 650), signed(3, 'cc', 700), signed(4, 'aa', 1800)]);
  seen(g, 1, T0 + 520); seen(g, 2, T0 + 578);
  const stub = { find: () => ({ pairs: 2, blocks: [{ height: 1001, ids: [ID.tx(tid(1)), ID.tx(tid(2)), ID.tx(tid(3))] }], eligible: 4, span: 3, expected: 2,
                                 byTx: new Map([[ID.tx(tid(1)), { others: [ID.tx(tid(2)), ID.tx(tid(3))] }], [ID.tx(tid(2)), { others: [ID.tx(tid(1))] }], [ID.tx(tid(3)), { others: [ID.tx(tid(1))] }]]) }) };
  const r = run(g, { sameBlock: stub });
  assert.deepEqual(r.sameBlock, { pairs: 2, blocks: [1001], eligible: 4, span: 3, expected: 2 });
  assert.equal(r.pairs.length, 2);
  const both = r.pairs.find((p) => p.txids[1] === tid(2)), only = r.pairs.find((p) => p.txids[1] === tid(3));
  assert.deepEqual(both.why, ['first seen within 120 s', 'same block, no wallet in common']);
  assert.deepEqual([both.height, both.gapSeconds], [1001, 58]);
  assert.deepEqual(only.why, ['same block, no wallet in common']);
  assert.equal(only.gapSeconds, 100, 'the gap between block times when there is no first-seen time for both');
});

test('pairs: with the real same-block module, two unrelated transactions in one block are a pair without any first-seen time', () => {
  const g = build([signed(1, 'aa', 600), signed(2, 'aa', 1800), signed(3, 'aa', 2400), signed(4, 'bb', 650), signed(5, 'bb', 3000), signed(6, 'bb', 3600)]);
  const r = run(g, { sameBlock: SBK });                               // the module the page loads
  assert.ok(r.sameBlock && r.sameBlock.pairs === 1 && r.sameBlock.blocks[0] === 1001, JSON.stringify(r.sameBlock));
  assert.equal(r.pairs.length, 1);
  assert.deepEqual([r.pairs[0].txids, r.pairs[0].why, r.pairs[0].height, r.pairs[0].gapSeconds], [[tid(1), tid(4)], ['same block, no wallet in common'], 1001, 50]);
  assert.equal(r.firstSeen, null);
});

test('pairs: two transactions of one owner in one block are not a pair between groups (their wallets were spent together elsewhere)', () => {
  const together = tx(1, [[501, 0, 'aa', 30000], [502, 0, 'ab', 30000]], [['dest', 59600]], 0);      // aa and ab are spent together: one owner by the common-input rule
  const g = build([together, signed(2, 'aa', 1200), signed(3, 'ab', 1250)]);
  const r = run(g, { sameBlock: SBK });
  assert.equal(r.sameBlock.pairs, 1, 'the two share no wallet, so the module sees a pair');
  assert.equal(r.pairs.length, 0, 'but it is one owner: not a coincidence between two groups');
  const other = build([together, signed(2, 'aa', 1200), signed(3, 'zz', 1250)]);
  assert.equal(run(other, { sameBlock: SBK }).pairs.length, 1, 'with another owner it is');
});

test('habits: a group needs three signed transactions, and its counts, fee rates and hours are told', () => {
  const g = build([signed(1, 'aa', 0), signed(2, 'aa', 3600), signed(3, 'aa', 7200, { fee: 402 }), signed(4, 'bb', 0), signed(5, 'bb', 100)]);
  const r = run(g);
  assert.equal(r.habits.groups.length, 1, 'bb has two');
  const a = group(r, 'aa');
  assert.deepEqual([a.signed, a.first, a.last, a.version, a.locktime], [3, T0, T0 + 7200, { v2: 3 }, { none: 3 }]);
  assert.deepEqual(a.sequence, { fffffffd: 3 });
  assert.deepEqual(a.shape, { '1in/1out': 3 });
  assert.deepEqual([a.fee.n, a.fee.wholeNumberShare, a.fee.min, a.fee.max], [3, 0.667, 2, 2.01]);
  assert.equal(a.hoursUtc.length, 24);
  assert.deepEqual([a.hoursUtc[0], a.hoursUtc[1], a.hoursUtc[2], a.eventBasis], [1, 1, 1, { firstSeen: 0, blockTime: 3 }]);
  assert.equal(a.commonShare, 1, 'version 2, no locktime, RBF: what many wallets do');
  assert.deepEqual(a.txids, [tid(1), tid(2), tid(3)]);
});

test('habits: the hour uses the first-seen time where there is one', () => {
  const g = build([signed(1, 'aa', 0), signed(2, 'aa', 100), signed(3, 'aa', 200)]);
  seen(g, 1, T0 - 7200);                                              // first seen at 22:00 the day before
  const a = group(run(g), 'aa');
  assert.deepEqual([a.hoursUtc[22], a.hoursUtc[0], a.eventBasis], [1, 2, { firstSeen: 1, blockTime: 2 }]);
});

test('habits: a change of habit that stays is a switch point, and one that flips back and forth is not', () => {
  const move = build([1, 2, 3].map((n) => signed(n, 'aa', n * 1000, { version: 1 })).concat([4, 5, 6].map((n) => signed(n, 'aa', n * 1000, { version: 2 }))));
  const a = group(run(move), 'aa');
  assert.deepEqual(a.version, { v1: 3, v2: 3 });
  assert.deepEqual(a.changes, [{ feature: 'version', from: 'v1', to: 'v2', lastBefore: T0 + 3000, firstAfter: T0 + 4000, txidBefore: tid(3), txidAfter: tid(4) }]);
  const flip = build([1, 2, 3, 4, 5, 6].map((n) => signed(n, 'aa', n * 1000, { version: n % 2 ? 1 : 2 })));
  assert.deepEqual(group(run(flip), 'aa').changes, [], 'six runs of one: a feature that alternates is not a change of habit');
  const slow = build([1, 1, 2, 2, 1, 1, 2, 2, 1, 1].map((v, i) => signed(i + 1, 'aa', (i + 1) * 1000, { version: v })));
  assert.deepEqual(group(run(slow), 'aa').changes, [], 'five runs of two: it switches back and forth, which is a way of working and not a change of habit');
  const once = build([1, 2, 3, 4].map((n) => signed(n, 'aa', n * 1000, { version: n < 4 ? 1 : 2 })));
  assert.deepEqual(group(run(once), 'aa').changes, [], 'one transaction after the change is not a run');
});

test('compare: what two groups agree on and differ in, and the common settings are marked so', () => {
  const txs = [];
  [1, 2, 3].forEach((n) => txs.push(signed(n, 'aa', n * 100, { version: 2, seq: 4294967295 })));           // final sequence, version 2: not the default of the common wallets
  [4, 5, 6].forEach((n) => txs.push(signed(n, 'bb', n * 100, { version: 2, seq: 4294967295 })));
  [7, 8, 9].forEach((n) => txs.push(signed(n, 'cc', n * 100, { version: 2 })));                              // RBF: what Bitcoin Core and many wallets do
  [10, 11, 12].forEach((n) => txs.push(signed(n, 'dd', n * 100, { version: 2 })));
  const r = run(build(txs));
  assert.equal(r.habits.groups.length, 4);
  const ab = r.habits.compare.find((c) => c.groups.join() === [ID.addr(adr('aa')), ID.addr(adr('bb'))].join());
  const row = (c, f) => c.rows.find((x) => x.feature === f);
  assert.deepEqual([row(ab, 'version').same, row(ab, 'sequence').same, row(ab, 'sequence').a, row(ab, 'shape').same], [true, true, 'ffffffff', true]);
  assert.deepEqual([row(ab, 'version').common, row(ab, 'sequence').common], [false, false], 'final sequence is not the default of the common wallets');
  assert.deepEqual([row(ab, 'feeRate').same, ab.agree], [true, 5], 'version, locktime, sequence, shape and fee rate all agree');
  const ac = r.habits.compare.find((c) => c.groups.join() === [ID.addr(adr('aa')), ID.addr(adr('cc'))].join());
  assert.equal(row(ac, 'sequence').same, false);
  const cd = r.habits.compare.find((c) => c.groups.join() === [ID.addr(adr('cc')), ID.addr(adr('dd'))].join());
  assert.deepEqual([row(cd, 'version').same, row(cd, 'version').common, row(cd, 'sequence').common, cd.agree, cd.agreeCommon], [true, true, true, 2, 3], 'the two ordinary wallets agree, and that is marked common (and not counted as agreement)');
  assert.equal(r.habits.compare[0].groups.join(), ab.groups.join(), 'the most alike pair comes first');
  assert.ok(ab.hoursOverlap > 0);
});

test('compare: a group with no single habit is mixed, not different, and a group with 5 v1 and 6 v2 is not called v2', () => {
  const txs = [];
  [1, 2, 3, 4, 5].forEach((n) => txs.push(signed(n, 'aa', n * 100, { version: 1 })));                        // aa: 5 v1 and 6 v2: no single version
  [6, 7, 8, 9, 10, 11].forEach((n) => txs.push(signed(n, 'aa', n * 100, { version: 2 })));
  [12, 13, 14].forEach((n) => txs.push(signed(n, 'bb', n * 100, { version: 2 })));                           // bb: v2 throughout
  const r = run(build(txs)), c = r.habits.compare[0];
  const row = (f) => c.rows.find((x) => x.feature === f);
  assert.deepEqual([row('version').mixed, row('version').same, row('version').a, row('version').b], [true, false, null, 'v2']);
  assert.deepEqual([row('sequence').mixed, row('sequence').same], [false, true], 'a clear habit is still compared');
  assert.equal(c.agree, 4, 'locktime, sequence, shape and fee rate agree; the mixed version is not counted as agreement');
});

test('compare: the same change of habit in two groups, with the windows each group changed in and where they meet', () => {
  const mk = (who, base, versions) => versions.map((v, i) => signed(base + i, who, (base + i) * 1000, { version: v }));
  const g = build(mk('aa', 10, [1, 1, 1, 2, 2, 2]).concat(mk('bb', 30, [1, 1, 2, 2]), mk('cc', 50, [2, 2, 1, 1]), mk('dd', 70, [1, 1, 2, 2, 2])));
  const r = run(g), find = (x, y) => r.habits.compare.find((c) => c.groups.join() === [ID.addr(adr(x)), ID.addr(adr(y))].join());
  const ab = find('aa', 'bb');
  assert.equal(ab.changeMatches.length, 1);
  const m = ab.changeMatches[0];
  assert.deepEqual([m.feature, m.from, m.to], ['version', 'v1', 'v2']);
  assert.deepEqual(m.windowA, [T0 + 12000, T0 + 13000]);                                                     // aa: its last v1 is transaction 12 and its first v2 transaction 13
  assert.deepEqual(m.windowB, [T0 + 31000, T0 + 32000]);
  assert.equal(m.overlap, null, 'transaction numbers 12-13 and 31-32 are far apart in time: the windows do not meet');
  const ad = find('aa', 'dd');
  assert.equal(ad.changeMatches.length, 1, 'aa and dd both went from v1 to v2');
  assert.equal(find('aa', 'cc').changeMatches.length, 0, 'cc went the other way: not the same change');
});

test('compare: the windows of two groups that changed at the same time overlap, and a pair with an overlap scores higher', () => {
  const txs = [];
  [1, 1, 1, 2, 2, 2].forEach((v, i) => txs.push(signed(i + 1, 'aa', i * 1000, { version: v })));               // aa changes between 2000 and 3000
  [1, 1, 1, 2, 2, 2].forEach((v, i) => txs.push(signed(i + 11, 'bb', i * 1000 + 400, { version: v })));       // bb between 2400 and 3400
  [1, 1, 1, 2, 2, 2].forEach((v, i) => txs.push(signed(i + 21, 'cc', i * 1000 + 90000, { version: v })));     // cc a day later
  const r = run(build(txs)), find = (x, y) => r.habits.compare.find((c) => c.groups.join() === [ID.addr(adr(x)), ID.addr(adr(y))].join());
  assert.deepEqual(find('aa', 'bb').changeMatches[0].overlap, [T0 + 2400, T0 + 3000]);
  assert.equal(find('aa', 'cc').changeMatches[0].overlap, null);
  assert.ok(find('aa', 'bb').score > find('aa', 'cc').score, 'a change in common that overlaps counts as one more agreement');
  assert.equal(r.habits.compare[0].groups.join(), [ID.addr(adr('aa')), ID.addr(adr('bb'))].join(), 'and it puts the pair first');
});

test('pairs: what limits a pair is written by code: the services differ, and a side with no habit record', () => {
  const g = build([signed(1, 'aa', 600), signed(2, 'aa', 1200), signed(3, 'aa', 1800), signed(4, 'bb', 600)]);
  seen(g, 1, T0 + 520); seen(g, 4, T0 + 578);
  g.nodes.get(ID.tx(tid(1))).ext.blockchaincom = { found: true, seen: true, received: T0 + 530, confirmed: T0 + 600, height: 1001, at: 0 };
  const p = run(g).pairs[0];
  assert.equal(p.considerations.length, 2);
  assert.match(p.considerations[0], /first-seen times come from different services/);
  assert.ok(p.considerations[0].includes('BlockCypher + Blockchain.com') && p.considerations[0].includes(tid(1)) && p.considerations[0].includes(tid(4)));
  assert.match(p.considerations[1], /no habit record for 0{63}4: its signing group has fewer than 3 signed transactions/);
  const both = build([signed(1, 'aa', 600), signed(2, 'aa', 1200), signed(3, 'aa', 1800), signed(4, 'bb', 600), signed(5, 'bb', 1200), signed(6, 'bb', 1800)]);
  seen(both, 1, T0 + 520); seen(both, 4, T0 + 578);
  assert.deepEqual(run(both).pairs[0].considerations, [], 'one service for both and a habit record on both sides: nothing limits it');
});

test('the lists are capped and say so', () => {
  const txs = []; let n = 1;
  for (let w = 0; w < 4; w++) for (let k = 0; k < 3; k++) txs.push(signed(n++, 'w' + w, n * 10));
  const r = run(build(txs), { caps: { groups: 2, compare: 1 } });
  assert.equal(r.habits.groups.length, 2);
  assert.equal(r.habits.groupsTotal, 4);
  assert.ok(r.limits.some((l) => /Only the first 2 of 4 signing groups/.test(l)), r.limits.join('|'));
  const g = build([signed(1, 'aa', 0), signed(2, 'bb', 0), signed(3, 'cc', 0), signed(4, 'dd', 0)]);
  [1, 2, 3, 4].forEach((k) => seen(g, k, T0 + 10 * k));
  const p = run(g, { caps: { rows: 2, pairs: 3 } });
  assert.equal(p.firstSeen.rows.length, 2);
  assert.equal(p.pairs.length, 3);
  assert.equal(p.pairsTotal, 6);
  assert.ok(p.limits.some((l) => /first-seen rows/.test(l)) && p.limits.some((l) => /3 of 6 pairs|first 3 of 6 pairs/.test(l)), p.limits.join('|'));
});

test('a coinbase and a transaction that is not complete on the canvas have no group', () => {
  const g = build([signed(1, 'aa', 0), signed(2, 'aa', 100), signed(3, 'aa', 200)]);
  const victim = g.edgesOf(ID.tx(tid(3))).find((e) => e.kind === 'out');
  g.removeEdge(victim.id);                                                                         // as a canvas link leaves it: the transaction is there, but not all of its edges
  const r = run(g);
  assert.equal(r, null, 'two complete transactions are under the three a group needs');
});
