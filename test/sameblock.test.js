'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const SB = require('../public/js/hopline-sameblock.js');

const tid = (n) => n.toString(16).padStart(64, '0');
const adr = (name) => 'bc1q' + name.padEnd(20, 'x');
// An Esplora-shaped transaction: ins [spentTxNumber, vout, wallet, value], outs [wallet, value]; `at` is seconds after T0, and the block is the ten-minute slot it falls in (height 1000 + slot)
const T0 = 1700000000;
function tx(n, ins, outs, at, over) {
  const vin = ins.map(([p, vout, who, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value } }));
  const fee = ins.reduce((s, i) => s + i[3], 0) - outs.reduce((s, o) => s + o[1], 0);
  return Object.assign({ txid: tid(n), fee, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 1000 + Math.floor((at || 0) / 600), block_time: T0 + (at || 0) },
                         vin, vout: outs.map(([who, value]) => ({ scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value })) }, over);
}
const build = (txs) => { const g = new Graph(); txs.forEach((t) => g.addTx(t)); g.refreshDerived(); return g; };
const T = (n) => ID.tx(tid(n));

// Two wallets that have nothing to do with each other, each spending to a payee and to its own change
const lone = (n, who, at, over) => tx(n, [[200 + n, 0, who, 50000]], [[who + 'pay', 30000], [who + 'chg', 19000]], at, over);

test('two transactions in one block with no wallet in common are a pair, listed for each of them', () => {
  const r = SB.find(build([lone(1, 'aa', 0), lone(2, 'bb', 100)]));
  assert.equal(r.pairs, 1);
  assert.deepEqual(r.blocks.map((b) => [b.height, b.ids, b.pairs]), [[1000, [T(1), T(2)], 1]]);
  assert.deepEqual(r.ids, [T(1), T(2)]);
  assert.deepEqual(r.byTx.get(T(1)), { height: 1000, others: [T(2)] });
  assert.deepEqual(r.byTx.get(T(2)), { height: 1000, others: [T(1)] });
  assert.equal(r.blocks[0].time, T0, 'the time of the block is the time of its first transaction here');
});

test('not a pair: another block, one wallet in common, or one spending what the other paid', () => {
  assert.equal(SB.find(build([lone(1, 'aa', 0), lone(2, 'bb', 700)])).pairs, 0, 'the next block');
  const sharedPayee = [tx(1, [[201, 0, 'aa', 50000]], [['rr', 30000], ['c1', 19000]], 0), tx(2, [[202, 0, 'bb', 50000]], [['rr', 30000], ['c2', 19000]], 100)];
  assert.equal(SB.find(build(sharedPayee)).pairs, 0, 'both paid the same wallet: expected, not a coincidence');
  const sharedSender = [tx(1, [[201, 0, 'aa', 50000]], [['p1', 30000], ['c1', 19000]], 0), tx(2, [[202, 0, 'aa', 50000]], [['p2', 30000], ['c2', 19000]], 100)];
  assert.equal(SB.find(build(sharedSender)).pairs, 0, 'one wallet spent twice');
  const handoff = [tx(1, [[201, 0, 'aa', 50000]], [['px', 30000], ['c1', 19000]], 0), tx(2, [[1, 0, 'px', 30000]], [['py', 29000]], 100)];
  assert.equal(SB.find(build(handoff)).pairs, 0, 'a hand-off is a link by coins, which has its own pattern');
});

test('a chain confirmed together is one group: the ends share no wallet, but the middle ties them', () => {
  const chain = [tx(1, [[201, 0, 'aa', 50000]], [['px', 30000], ['c1', 19000]], 0), tx(2, [[1, 0, 'px', 30000]], [['py', 29000]], 50), tx(3, [[2, 0, 'py', 29000]], [['pz', 28000]], 100)];
  assert.equal(SB.find(build(chain)).pairs, 0, 'three transactions, one group');
  const r = SB.find(build(chain.concat([lone(4, 'dd', 150)])));
  assert.equal(r.pairs, 3, 'the independent one against each of the three');
  assert.deepEqual(r.byTx.get(T(4)).others, [T(1), T(2), T(3)]);
  assert.deepEqual(r.byTx.get(T(2)).others, [T(4)]);
  assert.deepEqual(r.blocks[0].ids, [T(1), T(2), T(3), T(4)]);
});

test('three in a block: only the pairs with nothing in common are listed', () => {
  const g = build([tx(1, [[201, 0, 'aa', 50000]], [['rr', 30000], ['c1', 19000]], 0), tx(2, [[202, 0, 'bb', 50000]], [['rr', 30000], ['c2', 19000]], 50), lone(3, 'cc', 100)]);
  const r = SB.find(g);
  assert.equal(r.pairs, 2, '1-3 and 2-3; 1 and 2 share the payee');
  assert.deepEqual(r.byTx.get(T(3)).others, [T(1), T(2)]);
  assert.deepEqual(r.byTx.get(T(1)).others, [T(3)]);
  assert.deepEqual(r.byTx.get(T(2)).others, [T(3)]);
  assert.deepEqual(r.blocks[0].ids, [T(1), T(2), T(3)]);
});

test('blocks come oldest first, and a transaction alone in its block is not listed', () => {
  const g = build([lone(1, 'aa', 1300), lone(2, 'bb', 1400), lone(3, 'cc', 0), lone(4, 'dd', 100), lone(5, 'ee', 650)]);
  const r = SB.find(g);
  assert.deepEqual(r.blocks.map((b) => b.height), [1000, 1002]);
  assert.deepEqual(r.ids, [T(3), T(4), T(1), T(2)]);
  assert.equal(r.byTx.has(T(5)), false);
});

test('what cannot be compared is counted, not guessed: unconfirmed, partly on the canvas, and coinbase', () => {
  const g = build([lone(1, 'aa', 0), lone(2, 'bb', 100), lone(3, 'cc', 150, { status: { confirmed: false } })]);
  const partial = build([lone(1, 'aa', 0), lone(2, 'bb', 100)]);
  const victim = partial.edgesOf(T(2)).find((e) => e.kind === 'out');
  partial.removeEdge(victim.id);                                         // as a canvas link leaves it: the transaction is there with its totals, but not all of its edges
  const r = SB.find(g), p = SB.find(partial);
  assert.deepEqual([r.pairs, r.left.unconfirmed, r.eligible], [1, 1, 2]);
  assert.deepEqual([p.pairs, p.left.partial, p.eligible], [0, 1, 1], 'a transaction that is only partly on the canvas could share a wallet that is not there');
  const cb = build([lone(1, 'aa', 0), { txid: tid(9), fee: 0, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 1000, block_time: T0 + 10 },
                                         vin: [{ txid: '00'.repeat(32), vout: 4294967295, is_coinbase: true, sequence: 4294967295 }], vout: [{ scriptpubkey_address: adr('miner'), scriptpubkey_type: 'v0_p2wpkh', value: 625000000 }] }]);
  assert.equal(SB.find(cb).pairs, 0, 'every block has a coinbase: it would pair with everything');
});

test('a block with more of the canvas than the limit is a service\'s: it is skipped, and said', () => {
  const txs = [];
  for (let i = 0; i <= SB.CROWDED; i++) txs.push(tx(300 + i, [[1000 + i, 0, 'w' + i, 50000]], [['p' + i, 30000], ['c' + i, 19000]], 0 + (i % 5)));
  const r = SB.find(build(txs));
  assert.deepEqual([r.pairs, r.left.crowded], [0, SB.CROWDED + 1]);
});

test('expected: the pairs of any two transactions, shared out over the blocks they span', () => {
  const g = build([lone(1, 'aa', 0), lone(2, 'bb', 100), lone(3, 'cc', 6000 + 100), lone(4, 'dd', 11400)]);       // heights 1000, 1000, 1010 and 1019: four transactions over 20 blocks
  const r = SB.find(g);
  assert.deepEqual([r.eligible, r.span], [4, 20]);
  assert.ok(Math.abs(r.expected - 6 / 20) < 1e-9, 'six pairs of four transactions over twenty blocks');
  const none = SB.find(new Graph());
  assert.deepEqual([none.pairs, none.eligible, none.span, none.expected], [0, 0, 0, 0]);
});

test('chanceText: a number a person can read', () => {
  assert.equal(SB.chanceText(0.29), 'about 0.3');
  assert.equal(SB.chanceText(0.05), 'about 0.05');
  assert.equal(SB.chanceText(0.004), 'under 0.01');
  assert.equal(SB.chanceText(1.44), 'about 1.4');
  assert.equal(SB.chanceText(12.6), 'about 13');
  assert.equal(SB.chanceText(0), 'none');
});
