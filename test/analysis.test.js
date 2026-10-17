'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/orion-model.js');
const An = require('../public/js/orion-analysis.js');

// ---- a tiny chain builder -----------------------------------------------------------------------
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);                    // 64 hex characters
const a = (name) => 'bc1q' + name.padEnd(20, 'x');                                  // readable fake addresses (the model does not validate)
const IN = (txn, vout, addr, value, type) => ({ txid: tid(txn), vout, addr, value, type });
const OUT = (addr, value, type) => ({ addr, value, type });

function esplora(n, ins, outs, time) {
  return {
    txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: time || 1650000000 + n * 600 },
    vin: ins.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, prevout: { scriptpubkey_address: i.addr, scriptpubkey_type: i.type || 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => (o.data ? { scriptpubkey: '6a0568656c6c6f', scriptpubkey_type: 'op_return', value: 0 } : { scriptpubkey_address: o.addr, scriptpubkey_type: o.type || 'v0_p2wpkh', value: o.value }))
  };
}
function add(g, n, ins, outs, time) { g.addTx(esplora(n, ins, outs, time)); return ID.tx(tid(n)); }
function spend(g, from, vout, by, vin) {                                           // `from` output n is spent by tx `by`
  const outs = g.edgesOf(ID.tx(tid(from))).filter((e) => e.kind === 'out' && e.source === ID.tx(tid(from))).length;
  const list = Array.from({ length: outs }, () => ({ spent: false }));
  list[vout] = { spent: true, txid: tid(by), vin: vin || 0, status: { confirmed: true, block_time: 1650000000 + by * 600 } };
  g.addOutspends(tid(from), list);
}

// ---- txView -------------------------------------------------------------------------------------
test('txView: inputs and outputs in order, with wallet, amount and spend information', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('in1'), 5000), IN(91, 1, a('in2'), 7000)], [OUT(a('o1'), 9000), OUT(a('o2'), 2800)]);
  spend(g, 1, 1, 2);
  const v = An.txView(g, id);
  assert.equal(v.inputs.length, 2); assert.equal(v.outputs.length, 2); assert.ok(v.complete);
  assert.deepEqual(v.inputs.map((i) => i.amount), [5000, 7000]);
  assert.equal(v.inputs[0].address, a('in1')); assert.equal(v.inputs[0].scriptType, 'v0_p2wpkh');
  assert.deepEqual(v.outputs.map((o) => [o.vout, o.amount, o.spent]), [[0, 9000, null], [1, 2800, true]]);
  assert.equal(v.outputs[1].spender, tid(2));
});

test('txView: a stub (not loaded) has no view, and a partial import is marked incomplete', () => {
  const g = new Graph();
  add(g, 1, [IN(90, 0, a('in1'), 5000)], [OUT(a('o1'), 4000)]);
  assert.equal(An.txView(g, ID.tx(tid(90))), null, 'the funding transaction is only a stub');
  g.removeEdge('out:' + tid(1) + ':0');
  assert.equal(An.txView(g, ID.tx(tid(1))).complete, false);
  assert.deepEqual(An.classify(An.txView(g, ID.tx(tid(1)))), [], 'nothing is concluded from incomplete data');
  assert.equal(An.guessChange(An.txView(g, ID.tx(tid(1)))), null);
});

// ---- patterns -----------------------------------------------------------------------------------
test('classify: consolidation, batch payment, and nothing for an ordinary payment', () => {
  const g = new Graph();
  const many = Array.from({ length: 6 }, (_, i) => IN(80 + i, 0, a('c' + i), 10000));
  const c = add(g, 1, many, [OUT(a('dest'), 59000)]);
  const b = add(g, 2, [IN(70, 0, a('hot'), 900000)], Array.from({ length: 8 }, (_, i) => OUT(a('p' + i), 10000 + i * 131)));
  const o = add(g, 3, [IN(71, 0, a('x'), 50000)], [OUT(a('y'), 30000), OUT(a('z'), 19000)]);
  const f1 = An.classify(An.txView(g, c)), f2 = An.classify(An.txView(g, b)), f3 = An.classify(An.txView(g, o));
  assert.deepEqual(f1.map((x) => x.kind), ['consolidation']); assert.match(f1[0].short, /^CONSOL 6→1$/);
  assert.deepEqual(f2.map((x) => x.kind), ['batch']); assert.match(f2[0].short, /^BATCH 1→8$/);
  assert.deepEqual(f3, []);
  assert.ok(f1[0].title.length > 20 && f1[0].color);
});

test('classify: a coinbase is never flagged, 4 inputs is not enough for a consolidation, an OP_RETURN output is not a payment', () => {
  const g = new Graph();
  const four = add(g, 1, Array.from({ length: 4 }, (_, i) => IN(80 + i, 0, a('c' + i), 10000)), [OUT(a('dest'), 39000)]);
  const five = add(g, 2, Array.from({ length: 5 }, (_, i) => IN(60 + i, 0, a('d' + i), 10000)), [OUT(a('dest2'), 49000), { data: true }]);
  assert.deepEqual(An.classify(An.txView(g, four)), []);
  assert.deepEqual(An.classify(An.txView(g, five)).map((x) => x.kind), ['consolidation'], 'the data output does not count as an output');
  g.addTx({ txid: tid(9), status: { confirmed: true, block_height: 1, block_time: 1 }, vin: [{ is_coinbase: true, vout: 0 }], vout: Array.from({ length: 8 }, (_, i) => ({ scriptpubkey_address: a('m' + i), scriptpubkey_type: 'p2pkh', value: 100 })) });
  assert.deepEqual(An.classify(An.txView(g, ID.tx(tid(9)))), []);
});

test('coinjoin-like: several owners and several outputs of one exact value; a plain batch with equal amounts is not one', () => {
  const g = new Graph();
  const ins = Array.from({ length: 5 }, (_, i) => IN(50 + i, 0, a('w' + i), 1000000 + i * 777));
  const cj = add(g, 1, ins, [...Array.from({ length: 5 }, (_, i) => OUT(a('e' + i), 1000000)), OUT(a('chg1'), 1234), OUT(a('chg2'), 4321)]);
  const v = An.txView(g, cj), mix = An.coinjoinLike(v);
  assert.equal(mix.equal, 5); assert.equal(mix.amount, 1000000);
  assert.deepEqual(An.classify(v).map((x) => x.kind), ['coinjoin'], 'a CoinJoin is not reported as a consolidation or a batch as well');
  const airdrop = add(g, 2, [IN(40, 0, a('src'), 9000000)], Array.from({ length: 8 }, (_, i) => OUT(a('r' + i), 1000)));
  assert.equal(An.coinjoinLike(An.txView(g, airdrop)), null, 'one sender: not a CoinJoin');
  assert.deepEqual(An.classify(An.txView(g, airdrop)).map((x) => x.kind), ['batch']);
});

// ---- change -------------------------------------------------------------------------------------
test('change: paying yourself back is the strongest signal', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('me'), 100000, 'p2pkh')], [OUT(a('shop'), 60000, 'p2pkh'), OUT(a('me'), 39000, 'p2pkh')]);
  const ch = An.guessChange(An.txView(g, id));
  assert.equal(ch.vout, 1); assert.equal(ch.confidence, 'high'); assert.equal(ch.address, a('me'));
  assert.match(ch.reasons[0], /also one of the inputs/);
});

test('change: the only output of the same address type as the inputs', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('me'), 100000, 'v0_p2wpkh')], [OUT(a('legacy'), 61234, 'p2pkh'), OUT(a('mine'), 38000, 'v0_p2wpkh')]);
  const ch = An.guessChange(An.txView(g, id));
  assert.equal(ch.vout, 1); assert.equal(ch.confidence, 'medium'); assert.match(ch.reasons.join(' '), /same address type/);
});

test('change: a round payment points at the other output, weakly', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('me'), 5000000)], [OUT(a('pay'), 1000000), OUT(a('back'), 3987654)]);
  const ch = An.guessChange(An.txView(g, id));
  assert.equal(ch.vout, 1); assert.equal(ch.confidence, 'low'); assert.match(ch.reasons[0], /round amount/);
});

test('change: the unnecessary-input rule, and evidence adds up', () => {
  const g = new Graph();
  const uih = add(g, 1, [IN(90, 0, a('i1'), 60000), IN(91, 0, a('i2'), 50000)], [OUT(a('big'), 99873), OUT(a('rest'), 9927)]);
  const c1 = An.guessChange(An.txView(g, uih));
  assert.equal(c1.vout, 1); assert.equal(c1.confidence, 'low');
  const both = add(g, 2, [IN(92, 0, a('j1'), 6000000, 'v0_p2wpkh')], [OUT(a('x'), 1000000, 'p2pkh'), OUT(a('y'), 4987654, 'v0_p2wpkh')]);
  const c2 = An.guessChange(An.txView(g, both));
  assert.equal(c2.vout, 1); assert.equal(c2.confidence, 'high', 'same type (40) + round payment (30) = 70'); assert.equal(c2.reasons.length, 2);
});

test('change: a known or tagged payee makes the other output the change', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('exchange'), 63217), OUT(a('mine'), 36600)]);
  assert.equal(An.guessChange(An.txView(g, id)), null, 'nothing to go on without the known list');
  const ch = An.guessChange(An.txView(g, id), { known: (ad) => ad === a('exchange') });
  assert.equal(ch.vout, 1); assert.equal(ch.confidence, 'medium'); assert.match(ch.reasons[0], /known or tagged/);
});

test('change: a close call gives no answer; so do a single output, a coinbase and a sweep', () => {
  const g = new Graph();
  const even = add(g, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('p'), 51234), OUT(a('q'), 48500)]);
  assert.equal(An.guessChange(An.txView(g, even)), null);
  const one = add(g, 2, [IN(91, 0, a('me2'), 100000)], [OUT(a('only'), 99000)]);
  assert.equal(An.guessChange(An.txView(g, one)), null);
  const conflict = add(g, 3, [IN(92, 0, a('me3'), 100000, 'p2pkh')], [OUT(a('pp'), 40000, 'p2pkh'), OUT(a('me3'), 59000, 'p2pkh'), OUT(a('qq'), 400, 'p2pkh')]);
  assert.equal(An.guessChange(An.txView(g, conflict)).vout, 1, 'reuse wins, and the other two are never named');
});

test('change: a reused address that appears on two outputs is not a signal', () => {
  const g = new Graph();
  const id = add(g, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('me'), 40000), OUT(a('me'), 59000), OUT(a('someone'), 800)]);
  const ch = An.guessChange(An.txView(g, id));
  assert.ok(!ch || !/also one of the inputs/.test(ch.reasons.join(' ')));
});

// ---- peel chains ----------------------------------------------------------------------------------
function peelChain(g, n, from) {
  // tx from+0 ... from+n-1: each pays 1,000 and passes on the rest; the next one spends the large output
  let value = 1000000;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const t = from + i, prev = i === 0 ? IN(5, 0, a('origin'), value) : IN(t - 1, 1, a('c' + (i - 1)), value);
    const small = 1000 + i * 13, large = value - small - 200;
    ids.push(add(g, t, [prev], [OUT(a('peel' + i), small), OUT(a('c' + i), large)]));
    if (i > 0) spend(g, t - 1, 1, t);
    value = large;
  }
  return ids;
}

test('peelStep: one input, two outputs, the small one at most half the large one', () => {
  const g = new Graph();
  const yes = add(g, 1, [IN(90, 0, a('s'), 100000)], [OUT(a('p'), 5000), OUT(a('c'), 94800)]);
  const even = add(g, 2, [IN(91, 0, a('s2'), 100000)], [OUT(a('p2'), 49000), OUT(a('c2'), 50800)]);
  const two = add(g, 3, [IN(92, 0, a('s3'), 60000), IN(93, 0, a('s4'), 60000)], [OUT(a('p3'), 5000), OUT(a('c3'), 114800)]);
  const st = An.peelStep(An.txView(g, yes));
  assert.equal(st.large.vout, 1); assert.equal(st.small.vout, 0); assert.ok(st.ratio < 0.06);
  assert.equal(An.peelStep(An.txView(g, even)), null);
  assert.equal(An.peelStep(An.txView(g, two)), null, 'two inputs');
});

test('peelChains: finds a run of linked peel steps and what it peeled', () => {
  const g = new Graph();
  const ids = peelChain(g, 6, 10);
  spend(g, 15, 1, 40);                                                              // the last coin moves on to something else, loaded or not
  const chains = An.peelChains(g);
  assert.equal(chains.length, 1);
  const c = chains[0];
  assert.deepEqual(c.ids, ids); assert.equal(c.label, 'P1');
  assert.equal(c.peeled.length, 6); assert.equal(c.peeled[0].amount, 1000); assert.equal(c.totalPeeled, 6 * 1000 + 13 * (0 + 1 + 2 + 3 + 4 + 5));
  assert.equal(c.start, 1000000); assert.equal(c.continues, 'spent');
});

test('peelChains: too short, or broken by a different shape, is not a chain', () => {
  const g = new Graph();
  peelChain(g, 3, 10);
  assert.equal(An.peelChains(g).length, 0, '3 in a row is below the default of 4');
  assert.equal(An.peelChains(g, { peel: { minLength: 3 } }).length, 1);
  const g2 = new Graph();
  peelChain(g2, 6, 10);
  g2.removeEdge('out:' + tid(13) + ':1');                                            // break the link: tx 13's large output is gone
  assert.equal(An.peelChains(g2).length, 0, 'two halves of 3 and 2');
});

test('peelChains: a second input, or spending a different output, ends the chain', () => {
  const g = new Graph();
  peelChain(g, 5, 10);
  assert.equal(An.peelChains(g).length, 1);
  const g2 = new Graph();
  peelChain(g2, 5, 10);
  spend(g2, 11, 0, 12);                                                              // tx 12 now claims to spend output 0 of tx 11, not the large output
  const c = An.peelChains(g2);
  assert.ok(c.length === 0 || c[0].ids.length < 5);
});

// ---- clusters -----------------------------------------------------------------------------------
test('clusters: addresses spent together are linked, and linking is transitive across transactions', () => {
  const g = new Graph();
  add(g, 1, [IN(90, 0, a('A'), 1000), IN(91, 0, a('B'), 1000)], [OUT(a('x1'), 1800)]);
  add(g, 2, [IN(92, 0, a('B'), 1000), IN(93, 0, a('C'), 1000)], [OUT(a('x2'), 1800)]);
  add(g, 3, [IN(94, 0, a('D'), 1000), IN(95, 0, a('E'), 1000)], [OUT(a('x3'), 1800)]);
  add(g, 4, [IN(96, 0, a('F'), 1000)], [OUT(a('x4'), 800)]);
  const r = An.clusters(g);
  assert.equal(r.list.length, 2);
  assert.deepEqual(r.list[0].addrs.sort(), [a('A'), a('B'), a('C')].map(ID.addr).sort()); assert.equal(r.list[0].label, 'C1'); assert.equal(r.list[0].size, 3);
  assert.deepEqual(r.list[0].txs.sort(), [tid(1), tid(2)].sort());
  assert.equal(r.list[1].size, 2);
  assert.equal(r.byAddr.get(ID.addr(a('C'))), r.list[0]);
  assert.equal(r.byAddr.get(ID.addr(a('F'))), undefined, 'one address alone is not a cluster');
});

test('clusters: CoinJoin-like transactions and transactions you excluded do not link anything', () => {
  const g = new Graph();
  const ins = Array.from({ length: 5 }, (_, i) => IN(50 + i, 0, a('w' + i), 1000000));
  add(g, 1, ins, [...Array.from({ length: 5 }, (_, i) => OUT(a('e' + i), 990000)), OUT(a('chg'), 77)]);
  const manual = add(g, 2, [IN(60, 0, a('M1'), 5000), IN(61, 0, a('M2'), 5000)], [OUT(a('mm'), 9000)]);
  let r = An.clusters(g);
  assert.equal(r.list.length, 1, 'only the manual one is left'); assert.equal(r.skipped.coinjoin, 1);
  g.nodes.get(manual).noCluster = true;
  r = An.clusters(g);
  assert.equal(r.list.length, 0); assert.equal(r.skipped.excluded, 1);
});

test('clusters: ids are stable and the biggest cluster comes first', () => {
  const g = new Graph();
  add(g, 1, [IN(90, 0, a('P'), 1), IN(91, 0, a('Q'), 1)], [OUT(a('o1'), 1)]);
  add(g, 2, [IN(92, 0, a('R'), 1), IN(93, 0, a('S'), 1), IN(94, 0, a('T'), 1)], [OUT(a('o2'), 1)]);
  const r1 = An.clusters(g), r2 = An.clusters(g);
  assert.deepEqual(r1.list.map((c) => [c.label, c.size, c.id]), r2.list.map((c) => [c.label, c.size, c.id]));
  assert.deepEqual(r1.list.map((c) => c.size), [3, 2]);
});

// ---- analyse ------------------------------------------------------------------------------------
test('analyse: flags per transaction, peel membership, change marks only for medium or better, clusters', () => {
  const g = new Graph();
  const ids = peelChain(g, 5, 10);
  add(g, 30, Array.from({ length: 6 }, (_, i) => IN(80 + i, 0, a('k' + i), 10000)), [OUT(a('sink'), 59000)]);
  const r = An.analyse(g);
  assert.equal(r.chains.length, 1);
  assert.deepEqual(r.tx.get(ids[2]).chain, { label: 'P1', step: 3, of: 5 });
  assert.deepEqual(r.tx.get(ids[2]).flags.map((f) => f.short), ['PEEL 3/5']);
  assert.equal(r.tx.get(ID.tx(tid(30))).flags[0].kind, 'consolidation');
  assert.equal(r.counts.chains, 1); assert.ok(r.counts.flagged >= 6);
  assert.equal(r.clusters.list.length, 1, 'the six consolidated wallets');
  const withKnown = An.analyse(g, { known: () => false });
  assert.ok(withKnown.changeEdges.size >= 0);
  r.changeEdges.forEach((c) => assert.ok(An.rank(c.confidence) >= 2));
});

// ---- successors (automatic expansion) ---------------------------------------------------------------
function branching(g) {
  const t = add(g, 1, [IN(90, 0, a('me'), 1000000, 'v0_p2wpkh')], [OUT(a('big'), 600000, 'p2pkh'), OUT(a('mid'), 300000, 'p2pkh'), OUT(a('mine'), 99000, 'v0_p2wpkh'), OUT(a('dust'), 300, 'p2pkh')]);
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0, status: { confirmed: true, block_time: 1650000100 } }, { spent: true, txid: tid(3), vin: 0, status: { confirmed: true, block_time: 1650000200 } },
                          { spent: true, txid: tid(4), vin: 0, status: { confirmed: true, block_time: 1650000300 } }, { spent: false }]);
  return t;
}

test('successors: "all" follows every spent output, largest first, with context for the rest', () => {
  const g = new Graph(); const t = branching(g);
  const s = An.successors(g, t, 'next', { follow: 'all' });
  assert.deepEqual(s.next, [tid(2), tid(3), tid(4)]); assert.equal(s.stop, null);
  assert.equal(s.items.length, 4);
  const dust = s.items.find((i) => i.amount === 300); assert.equal(dust.followed, false); assert.equal(dust.why, 'unspent');
});

test('successors: "largest" follows one output; perTx limits "all"; minSats skips small ones', () => {
  const g = new Graph(); const t = branching(g);
  assert.deepEqual(An.successors(g, t, 'next', { follow: 'largest' }).next, [tid(2)]);
  assert.deepEqual(An.successors(g, t, 'next', { follow: 'all', perTx: 2 }).next, [tid(2), tid(3)]);
  const s = An.successors(g, t, 'next', { follow: 'all', minSats: 100000 });
  assert.deepEqual(s.next, [tid(2), tid(3)]);
  assert.equal(s.items.find((i) => i.address === a('mine')).followed, false);
});

test('successors: "change" follows the guessed change, and stops instead of guessing', () => {
  const g = new Graph(); const t = branching(g);
  const s = An.successors(g, t, 'next', { follow: 'change' });
  assert.deepEqual(s.next, [tid(4)], 'the only output of the inputs\' own type');
  const g2 = new Graph();
  const even = add(g2, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('p'), 51234), OUT(a('q'), 48500)]);
  g2.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }]);
  const s2 = An.successors(g2, even, 'next', { follow: 'change' });
  assert.deepEqual(s2.next, []); assert.match(s2.stop, /no clear change/);
  assert.equal(s2.items.length, 2, 'the outputs are still reported, so they can be shown');
  const g3 = new Graph();
  const single = add(g3, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('only'), 99000)]);
  g3.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }]);
  assert.deepEqual(An.successors(g3, single, 'next', { follow: 'change' }).next, [tid(2)], 'a single output is the continuation');
});

test('successors: "peel" follows the large output of a peel step and stops at anything else', () => {
  const g = new Graph();
  const p = add(g, 1, [IN(90, 0, a('me'), 100000)], [OUT(a('pay'), 3000), OUT(a('rest'), 96800)]);
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }]);
  assert.deepEqual(An.successors(g, p, 'next', { follow: 'peel' }).next, [tid(3)]);
  const g2 = new Graph(); const t = branching(g2);
  const s = An.successors(g2, t, 'next', { follow: 'peel' });
  assert.deepEqual(s.next, []); assert.match(s.stop, /not a peel step/);
});

test('successors: stops at CoinJoins, labelled wallets, unspent outputs and what is not loaded', () => {
  const g = new Graph();
  const ins = Array.from({ length: 5 }, (_, i) => IN(50 + i, 0, a('w' + i), 1000000));
  const cj = add(g, 1, ins, [...Array.from({ length: 5 }, (_, i) => OUT(a('e' + i), 990000)), OUT(a('chg'), 77)]);
  assert.match(An.successors(g, cj, 'next', { stopAtMix: true }).stop, /CoinJoin/);
  g.addOutspends(tid(1), Array.from({ length: 6 }, (_, i) => ({ spent: true, txid: tid(20 + i), vin: 0 })));
  assert.equal(An.successors(g, cj, 'next', { stopAtMix: false }).next.length, 6, 'unless you ask to go through it');
  const g2 = new Graph(); const t = branching(g2);
  const s = An.successors(g2, t, 'next', { follow: 'all', mark: (ad) => (ad === a('big') ? 'Exchange X' : null) });
  assert.deepEqual(s.next, [tid(3), tid(4)]);
  assert.equal(s.items.find((i) => i.address === a('big')).why, 'labelled: Exchange X');
  assert.equal(An.successors(g2, ID.tx(tid(2)), 'next', {}).stop, 'not loaded');
});

test('successors: backward follows the funding transactions, never a coinbase', () => {
  const g = new Graph();
  const t = add(g, 1, [IN(90, 0, a('f1'), 700000), IN(91, 1, a('f2'), 300000), IN(90, 1, a('f3'), 5000)], [OUT(a('dest'), 990000)]);
  assert.deepEqual(An.successors(g, t, 'prev', { follow: 'all' }).next, [tid(90), tid(91)], 'one entry per funding transaction, largest first');
  assert.deepEqual(An.successors(g, t, 'prev', { follow: 'largest' }).next, [tid(90)]);
  assert.deepEqual(An.successors(g, t, 'prev', { follow: 'change' }).next, [tid(90)], 'change and peel only make sense forward: they fall back to the largest');
  g.addTx({ txid: tid(9), status: { confirmed: true, block_height: 1, block_time: 1 }, vin: [{ is_coinbase: true, vout: 0 }], vout: [{ scriptpubkey_address: a('miner'), scriptpubkey_type: 'p2pkh', value: 5000000000 }] });
  assert.match(An.successors(g, ID.tx(tid(9)), 'prev', {}).stop, /coinbase/);
});

// ---- wallet habits (fingerprint) ----------------------------------------------------------------
function fpTx(g, n, ins, outs, fp, time) {
  const t = esplora(n, ins, outs, time);
  t.version = fp.version; t.locktime = fp.locktime; t.vin.forEach((v) => { v.sequence = fp.sequence; });
  g.addTx(t); return ID.tx(tid(n));
}
const CORE = { version: 2, locktime: 700000, sequence: 4294967293 };           // the defaults: version 2, a recent block height, RBF
const OTHER = { version: 1, locktime: 0, sequence: 4294967295 };               // an older habit: version 1, no locktime, final sequence

test('fingerprint: version, locktime kind, sequence numbers and ordering; defaults are marked common', () => {
  const g = new Graph();
  const x1 = fpTx(g, 1, [IN(90, 0, 'p', 10000)], [OUT('q', 9000)], CORE);
  const x2 = fpTx(g, 2, [IN(91, 0, 'r', 10000)], [OUT('s', 9000)], OTHER);
  const fa = An.fingerprint(g.nodes.get(x1)), fb = An.fingerprint(g.nodes.get(x2));
  assert.equal(fa.version, 2); assert.equal(fa.lock, 'height-near'); assert.equal(fa.common, true); assert.match(fa.text, /anti-fee-sniping/); assert.match(fa.text, /RBF signalled/);
  assert.equal(fb.lock, 'none'); assert.equal(fb.common, false); assert.match(fb.text, /final \(ffffffff\)/);
  assert.notEqual(fa.key, fb.key);
  const far = fpTx(g, 3, [IN(92, 0, 't', 10000)], [OUT('u', 9000)], { version: 2, locktime: 100, sequence: 4294967293 });
  assert.equal(An.fingerprint(g.nodes.get(far)).lock, 'height-far', 'an old block height is not anti-fee-sniping');
  const dated = fpTx(g, 4, [IN(93, 0, 'v', 10000)], [OUT('w', 9000)], { version: 2, locktime: 1700000000, sequence: 4294967294 });
  assert.equal(An.fingerprint(g.nodes.get(dated)).lock, 'time');
  assert.equal(An.fingerprint(g.nodes.get(ID.tx(tid(99)))), null, 'a transaction that is not loaded has none');
  const plain = add(g, 5, [IN(94, 0, 'x', 10000)], [OUT('y', 9000)]);
  assert.equal(An.fingerprint(g.nodes.get(plain)), null, 'nor one loaded without those fields (an old session)');
});

test('change: an output spent by a transaction with the same unusual wallet habits as this one is the likelier change', () => {
  const g = new Graph();
  const t = fpTx(g, 1, [IN(90, 0, 'me', 100000)], [OUT('pay', 51234), OUT('back', 48500)], OTHER);
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }]);
  fpTx(g, 2, [IN(1, 0, 'pay', 51234)], [OUT('z1', 50000)], CORE);                              // the payee's wallet: other habits
  fpTx(g, 3, [IN(1, 1, 'back', 48500)], [OUT('z2', 47000)], OTHER);                            // the sender's own wallet again
  const ch = An.guessChange(An.txView(g, t));
  assert.equal(ch.vout, 1); assert.equal(ch.confidence, 'low');
  assert.match(ch.reasons.join(' '), /same wallet software/); assert.ok(!/weak sign/.test(ch.reasons.join(' ')));
});

test('change: with common defaults the evidence is weak and is not enough on its own; unloaded spenders count for nothing', () => {
  const g = new Graph();
  const t = fpTx(g, 1, [IN(90, 0, 'me', 100000)], [OUT('pay', 51234), OUT('back', 48500)], CORE);
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }]);
  fpTx(g, 2, [IN(1, 0, 'pay', 51234)], [OUT('z1', 50000)], OTHER);
  fpTx(g, 3, [IN(1, 1, 'back', 48500)], [OUT('z2', 47000)], CORE);
  assert.equal(An.guessChange(An.txView(g, t)), null, '15 points are below the 20 needed to name anything');
  const g2 = new Graph();
  const t2 = fpTx(g2, 1, [IN(90, 0, 'me', 100000)], [OUT('pay', 51234), OUT('back', 48500)], OTHER);
  g2.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }]);
  fpTx(g2, 3, [IN(1, 1, 'back', 48500)], [OUT('z2', 47000)], OTHER);                           // only one spender is loaded: nothing to contrast it with
  assert.equal(An.guessChange(An.txView(g2, t2)), null);
});
