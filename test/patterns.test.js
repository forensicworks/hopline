'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const AN = require('../public/js/hopline-analysis.js');
const PT = require('../public/js/hopline-patterns.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const adr = (name) => 'bc1q' + name.padEnd(20, 'x');
// An Esplora-shaped transaction: ins [spentTxNumber, vout, wallet, value], outs [wallet, value]; `at` is the block height and time (seconds after T0)
const T0 = 1700000000;
function tx(n, ins, outs, at, over) {
  const vin = ins.map(([p, vout, who, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value } }));
  const fee = ins.reduce((s, i) => s + i[3], 0) - outs.reduce((s, o) => s + o[1], 0);
  return Object.assign({ txid: tid(n), fee, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 1000 + Math.floor((at || 0) / 600), block_time: T0 + (at || 0) },
                         vin, vout: outs.map(([who, value]) => ({ scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value })) }, over);
}
const build = (txs) => { const g = new Graph(); txs.forEach((t) => g.addTx(t)); g.refreshDerived(); return g; };
const run = (txs, opts) => { const g = build(txs); return PT.find(g, AN.analyse(g, {}), opts); };

// ---- TEST PAYMENT -------------------------------------------------------------------------------------------------------------------------
test('test payment: a small payment and soon after a much larger one from the same sender to the same wallet', () => {
  const r = run([tx(1, [[90, 0, 'v', 2000000]], [['r', 10000], ['vchg', 1989000]], 0), tx(2, [[91, 0, 'v', 2000000]], [['r', 1000000], ['vchg2', 999000]], 3600)]);
  assert.equal(r.test.length, 1);
  const t = r.test[0];
  assert.deepEqual([t.test.txid, t.main.txid, t.test.amount, t.main.amount, t.ratio, t.gap, t.test.address], [tid(1), tid(2), 10000, 1000000, 100, 3600, adr('r')]);
  assert.deepEqual(PT.idsOf('test', t), [ID.tx(tid(1)), ID.tx(tid(2))]);
});

test('test payment: not under the ratio, not dust, not late, not to another wallet, not change, and the same block counts', () => {
  const pair = (small, big, gap, to2) => run([tx(1, [[90, 0, 'v', 9000000]], [['r', small], ['c1', 5000]], 0), tx(2, [[91, 0, 'v', 99000000]], [[to2 || 'r', big], ['c2', 5000]], gap)]).test.length;
  assert.equal(pair(10000, 1000000, 60), 1);
  assert.equal(pair(10000, 400000, 60), 0, 'only 40 times as much: under the ratio of 50');
  assert.equal(pair(10000, 500000, 60), 1, 'exactly the ratio');
  assert.equal(pair(500, 1000000, 60), 0, 'a test that is dust is not a test');
  assert.equal(pair(10000, 1000000, 7 * 86400 + 600), 0, 'a week and more later');
  assert.equal(pair(10000, 1000000, 6 * 86400), 1);
  assert.equal(pair(10000, 1000000, 60, 'other'), 0, 'another wallet');
  assert.equal(pair(10000, 1000000, 0), 1, 'in the same block (the same time)');
  const own = run([tx(1, [[90, 0, 'v', 100000]], [['v', 10000], ['x', 89000]], 0), tx(2, [[91, 0, 'v', 100000000]], [['v', 99000000], ['x', 900000]], 60)]);
  assert.equal(own.test.length, 0, 'paying itself is not paying somebody');
  assert.equal(run([tx(1, [[90, 0, 'v', 100000]], [['r', 10000], ['c', 89000]], 0), tx(2, [[91, 0, 'w', 100000000]], [['r', 99000000], ['c', 900000]], 60)]).test.length, 0, 'two senders are two senders');
});

test('test payment: the sender is the owner the analysis gives, and each small payment pairs with the nearest big one after it', () => {
  // s1 and s2 are spent together (one owner); the test is paid by both, the main by s1 alone
  const together = run([tx(1, [[90, 0, 's1', 5000], [91, 0, 's2', 6000]], [['r', 10000], ['c', 500]], 0), tx(2, [[92, 0, 's1', 90000000]], [['r', 80000000], ['c2', 9990000]], 3600)]);
  assert.equal(together.test.length, 1);
  const ladder = run([tx(1, [[90, 0, 'v', 100000]], [['r', 1000], ['c1', 98000]], 0), tx(2, [[91, 0, 'v', 99000000]], [['r', 100000], ['c2', 98000000]], 60), tx(3, [[92, 0, 'v', 999000000]], [['r', 100000000], ['c3', 800000000]], 120)]);
  assert.deepEqual(ladder.test.map((t) => [t.test.amount, t.main.amount]), [[1000, 100000], [100000, 100000000]], 'a small one is not paired with the biggest');
});

// ---- HAND-OFF BEFORE CONFIRMING ----------------------------------------------------------------------------------------------------------
test('hand-off: a transaction that spends what another paid in the same block, chained, with the fee rates', () => {
  const g = build([tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['achg', 9000]], 0, { fee: 1000 }), tx(2, [[1, 0, 'b', 90000]], [['c', 80000]], 10, { fee: 10000 }), tx(3, [[2, 0, 'c', 80000]], [['d', 70000]], 20, { fee: 10000 })]);
  const h = PT.handoffs(g, AN.analyse(g, {}));
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].ids, h[0].hops, h[0].links.length, h[0].links[0].address, h[0].links[0].amount, h[0].height], [[tid(1), tid(2), tid(3)], 2, 2, adr('b'), 90000, 1000]);
  assert.deepEqual([Math.round(h[0].parentRate), Math.round(h[0].childRate)], [5, 50], 'the first parent and the last child paid very different rates');
});

test('hand-off: one hand-off is not reported unless it is asked for', () => {
  const txs = [tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['achg', 9000]], 0), tx(2, [[1, 0, 'b', 90000]], [['c', 80000]], 10)];
  assert.equal(run(txs).handoff.length, 0, 'about one transaction in twenty of ordinary traffic is one');
  const one = run(txs, { handoff: { minHops: 1 } }).handoff;
  assert.deepEqual([one.length, one[0].hops, one[0].ids], [1, 1, [tid(1), tid(2)]]);
});

test('hand-off: not across blocks, and not a wallet spending its own unconfirmed change', () => {
  assert.equal(run([tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['achg', 9000]], 0), tx(2, [[1, 0, 'b', 90000]], [['c', 80000]], 700)]).handoff.length, 0, 'the next block');
  assert.equal(run([tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['a', 9000]], 0), tx(2, [[1, 1, 'a', 9000]], [['c', 8000]], 10)]).handoff.length, 0, 'the change came back to the same address');
  // the change went to a new address that is later spent together with the sender's own coin: the same owner
  const own = run([tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['achg', 9000]], 0), tx(2, [[1, 1, 'achg', 9000], [91, 0, 'a', 50000]], [['c', 55000]], 10)]);
  assert.equal(own.handoff.length, 0, 'change to a fresh address of the same owner is still its own change');
});

// ---- SPLIT AND COLLECT --------------------------------------------------------------------------------------------------------------------
const split = (steps, over) => {
  const txs = []; let prev = ['a0', 1000000];
  for (let i = 1; i <= steps; i++) {
    const pay = (steps - i + 1) * 20000, rest = prev[1] - pay - 100;
    txs.push(tx(i, [[i === 1 ? 90 : i - 1, i === 1 ? 0 : 1, prev[0], prev[1]]], [[(over && over.to && over.to(i)) || 'R', pay], ['a' + i, rest]], i * 60));
    prev = ['a' + i, rest];
  }
  return txs;
};

test('split and collect: single-input two-output transactions that each pay one wallet and pass the rest on', () => {
  const r = run(split(3));
  assert.equal(r.split.length, 1);
  const s = r.split[0];
  assert.deepEqual([s.ids, s.steps, s.address, s.paid, s.total, s.round, s.collected], [[tid(1), tid(2), tid(3)], 3, adr('R'), [60000, 40000, 20000], 120000, true, null]);
  assert.equal(run(split(2)).split.length, 0, 'two steps are not a run');
  assert.equal(run(split(2), { split: { minSteps: 2 } }).split.length, 1, 'unless it is asked for');
  const four = run(split(4)).split;
  assert.deepEqual([four.length, four[0].steps], [1, 4], 'one run of four, not a run of four and one of three');
  assert.equal(run(split(3, { to: (i) => (i === 2 ? 'S' : 'R') })).split.length, 0, 'the wallet is not the same at every step');
  const plain = split(3).map((t, i) => Object.assign({}, t, { vout: t.vout.map((o) => Object.assign({}, o, { value: o.scriptpubkey_address === adr('R') ? 33333 + i : o.value })) }));
  assert.equal(run(plain).split.length, 0, 'amounts that are not round and nothing that collected them: what a service paying out looks like');
  assert.equal(run(plain, { split: { needSignal: false } }).split.length, 1, 'unless the signal is not asked for');
});

test('split and collect: the transaction that later spent the pieces together is named', () => {
  const txs = split(3);
  txs.push(tx(9, [[1, 0, 'R', 60000], [2, 0, 'R', 40000], [3, 0, 'R', 20000], [95, 0, 'R', 5000]], [['sink', 124000]], 900));
  const s = run(txs).split[0];
  assert.deepEqual([s.collected.txid, s.collected.pieces], [tid(9), 3]);
  assert.deepEqual(PT.idsOf('split', s), [tid(1), tid(2), tid(3), tid(9)].map((t) => ID.tx(t)));
  const odd = run(split(3).map((t, i) => (i === 1 ? Object.assign({}, t, { vout: t.vout.map((o) => Object.assign({}, o, { value: o.scriptpubkey_address === adr('R') ? 33333 : o.value })) }) : t)).concat([
    tx(9, [[1, 0, 'R', 60000], [2, 0, 'R', 33333], [3, 0, 'R', 20000]], [['sink', 113000]], 900)]));
  assert.equal(odd.split.length, 1);
  assert.deepEqual([odd.split[0].round, odd.split[0].collected && odd.split[0].collected.pieces], [false, 3], 'not every piece is a round amount, but they were collected');
});

test('find: the counts, and nothing is found where nothing is', () => {
  const r = run([...split(3), tx(1 + 20, [[90, 0, 'v', 2000000]], [['z', 10000], ['vc', 1989000]], 5000), tx(22, [[91, 0, 'v', 2000000]], [['z', 1000000], ['vc2', 999000]], 5600)]);
  assert.deepEqual([r.counts.test, r.counts.split, r.counts.total], [1, 1, 2 + r.counts.handoff]);
  const none = run([tx(1, [[90, 0, 'a', 100000]], [['b', 90000], ['c', 9000]], 0)]);
  assert.deepEqual(none.counts, { test: 0, handoff: 0, links: 0, split: 0, total: 0 });
  const empty = PT.find(new Graph(), AN.analyse(new Graph(), {}));
  assert.equal(empty.counts.total, 0);
});
