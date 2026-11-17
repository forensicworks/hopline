'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const MN = require('../public/js/hopline-money.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const adr = (name) => 'bc1q' + name.padEnd(20, 'x');
// An Esplora-shaped transaction. ins: [spentTxNumber, vout, wallet, value]; outs: [wallet, value]. The fee is what is left.
function tx(n, ins, outs, over) {
  const vin = ins.map(([p, vout, who, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value } }));
  const fee = ins.reduce((s, i) => s + i[3], 0) - outs.reduce((s, o) => s + o[1], 0);
  return Object.assign({ txid: tid(n), fee, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 700000 + n, block_time: 1650000000 + n * 600 },
                         vin, vout: outs.map(([who, value]) => ({ scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value })) }, over);
}
const sp = (n) => ({ spent: true, txid: tid(n), vin: 0, status: { confirmed: true, block_time: 1650000000 + n * 600 } });
const open = { spent: false };
function build(txs, spends) {
  const g = new Graph();
  txs.forEach((t) => g.addTx(t));
  Object.keys(spends || {}).forEach((n) => g.addOutspends(tid(Number(n)), spends[n]));
  g.refreshDerived();
  return g;
}
const REF = ID.addr(adr('ref'));
// the victim pays the reference wallet 60,000 sat (and gets 9,800 back as change)
const t1 = tx(1, [[90, 0, 'victim', 70000]], [['ref', 60000], ['victim', 9800]]);

test('where: every satoshi that reached the wallet is accounted for, and the numbers close', () => {
  // ref -> a (30,000) and b (29,000), 1,000 fee; a -> c (28,500), 1,500 fee, c never asked; b still rests
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]]), tx(3, [[2, 0, 'a', 30000]], [['c', 28500]])], { 1: [sp(2), open], 2: [sp(3), open] });
  const w = MN.where(g, [REF]);
  assert.deepEqual([w.received, w.coins, w.txs, w.fees], [60000, 4, 2, 2500]);
  assert.deepEqual([w.resting.sats, w.resting.count, w.resting.rows[0].address], [29000, 1, adr('b')]);
  assert.deepEqual([w.unchecked.sats, w.unchecked.count, w.unchecked.rows[0].address], [28500, 1, adr('c')]);
  assert.deepEqual([w.movedOn.sats, w.named.sats, w.mixed.sats, w.gap.sats], [0, 0, 0, 0]);
  assert.deepEqual([w.sum, w.off, w.closes], [60000, 0, true]);
});

test('where: a coin spent by a transaction that is not loaded is moved on, with the transaction to load; one with a name ends the trail', () => {
  const base = [t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]])];
  const away = MN.where(build(base, { 1: [sp(2), open], 2: [sp(77), open] }), [REF]);          // transaction 77 is not loaded
  assert.deepEqual([away.movedOn.sats, away.movedOn.rows[0].next, away.movedOn.rows[0].address], [30000, tid(77), adr('a')]);
  assert.deepEqual([away.resting.sats, away.fees, away.closes], [29000, 1000, true]);
  const named = MN.where(build(base, { 1: [sp(2), open], 2: [open, open] }), [REF], { stop: (id) => (id === ID.addr(adr('a')) ? 'Exchange' : null) });
  assert.deepEqual([named.named.sats, named.named.rows[0].label, named.resting.sats, named.closes], [30000, 'Exchange', 29000, true]);
  const own = MN.where(build(base, { 1: [sp(2), open], 2: [open, open] }), [REF], { stop: () => 'Named' });
  assert.deepEqual([own.txs, own.named.sats, own.named.rows.map((r) => r.address).sort(), own.fees, own.closes], [1, 59000, [adr('a'), adr('b')], 1000, true],
    'a starting wallet is never ended by its own name: its coin is followed to the transaction that spent it, and the wallets it paid are the ones that are named');
});

test('where: money spent together with other money is mixed: it is not followed and both amounts are said', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]]), tx(3, [[2, 0, 'a', 30000], [91, 0, 'z', 20000]], [['c', 48500]])], { 1: [sp(2), open], 2: [sp(3), open] });
  const w = MN.where(g, [REF]);
  assert.deepEqual([w.mixed.count, w.mixed.sats, w.mixed.foreign, w.mixed.rows[0].txid], [1, 30000, 20000, tid(3)]);
  assert.equal(w.unchecked.sats, 0, 'c was not followed: nothing is guessed about what came out of a mixed transaction');
  assert.deepEqual([w.resting.sats, w.fees, w.sum, w.closes], [29000, 1000, 60000, true]);
});

test('where: change that comes back to the wallet is part of the trail and is not received twice', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['ref', 29000]])], { 1: [sp(2), open], 2: [open, open] });
  const w = MN.where(g, [REF]);
  assert.equal(w.received, 60000, 'the 29,000 paid back by a transaction that spent the wallet\'s coin is the same money');
  assert.deepEqual([w.resting.sats, w.unchecked.sats === 0, w.resting.rows.map((r) => r.address).sort()], [59000, true, [adr('a'), adr('ref')]]);
  assert.deepEqual([w.fees, w.closes], [1000, true]);
});

test('where: branches that come together are not mixed with each other, however the trail reaches the transaction that joins them', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]]), tx(3, [[2, 0, 'a', 30000]], [['c', 29500]]), tx(4, [[2, 1, 'b', 29000]], [['d', 28500]]),
                   tx(5, [[3, 0, 'c', 29500], [4, 0, 'd', 28500]], [['e', 57000]])], { 1: [sp(2), open], 2: [sp(3), sp(4)], 3: [sp(5)], 4: [sp(5)] });
  const w = MN.where(g, [REF]);
  assert.deepEqual([w.mixed.count, w.unchecked.sats, w.unchecked.rows[0].address, w.txs, w.fees, w.closes], [0, 57000, adr('e'), 4, 3000, true]);
});

test('where: outputs of a transaction that the graph does not hold are a gap, and what the data says that does not add up is said', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]])], { 1: [sp(2), open], 2: [open, open] });
  g.removeEdge(ID.edgeOut(tid(2), 1));                                                         // the output to b is not in the graph (a link left it out)
  const w = MN.where(g, [REF]);
  assert.deepEqual([w.gap.sats, w.gap.count, w.gap.rows[0].txid, w.resting.sats, w.closes], [29000, 1, tid(2), 30000, true]);
  const g2 = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]])], { 1: [sp(2), open], 2: [open, open] });
  g2.nodes.get(ID.tx(tid(2))).valueOut += 5000;                                                // a total that is more than the outputs and the fee explain
  const bad = MN.where(g2, [REF]);
  assert.deepEqual([bad.closes, bad.off], [false, -5000]);
});

test('where: a transaction can be the starting point (its outputs are the money), and nothing known is nothing', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]])], { 1: [sp(2), open], 2: [open, open] });
  const w = MN.where(g, [ID.tx(tid(2))]);
  assert.deepEqual([w.received, w.resting.sats, w.fees, w.closes], [59000, 59000, 0, true]);
  const none = MN.where(g, ['addr:nobody', null, 5]);
  assert.deepEqual([none.refs, none.received, none.sum, none.closes], [[], 0, 0, true]);
  assert.equal(MN.where(g, [REF]).received, 60000);
});

test('where: when the spends were read is kept with each coin, and a run that is cut short says so', () => {
  const g = build([t1, tx(2, [[1, 0, 'ref', 60000]], [['a', 30000], ['b', 29000]])], { 1: [sp(2), open], 2: [open, open] });
  g.nodes.get(ID.tx(tid(2))).spendsCheckedAt = 1700000000;
  const w = MN.where(g, [REF]);
  assert.deepEqual(w.resting.rows.map((r) => r.readAt), [1700000000, 1700000000]);
  const cut = MN.where(g, [REF], { max: 2 });
  assert.deepEqual([cut.truncated, cut.closes], [true, false]);
});

test('byWallet and txidsOf group the rows for the panel and for the request that settles them', () => {
  const rows = [{ id: 'addr:a', address: 'a', amount: 5, txid: 't1', readAt: 10 }, { id: 'addr:b', address: 'b', amount: 9, txid: 't2', readAt: null }, { id: 'addr:a', address: 'a', amount: 7, txid: 't3', readAt: 4 }];
  const by = MN.byWallet(rows);
  assert.deepEqual(by.map((w) => [w.id, w.amount, w.count, w.txids, w.readAt]), [['addr:a', 12, 2, ['t1', 't3'], 4], ['addr:b', 9, 1, ['t2'], null]]);
  assert.deepEqual(MN.txidsOf(rows.concat(rows)), ['t1', 't2', 't3']);
  assert.deepEqual([MN.byWallet(null), MN.txidsOf(undefined)], [[], []]);
});
