'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID, decodeOpReturn } = require('../public/js/hopline-model.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

test('normal tx: vertices, edges, times, amounts and script types are kept', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.loaded, true);
  assert.equal(tx.confirmed, true);
  assert.equal(tx.time, t.status.block_time);
  assert.equal(tx.height, t.status.block_height);
  assert.equal(tx.nIn, t.vin.length);
  assert.equal(tx.nOut, t.vout.length);
  assert.equal(tx.valueOut, t.vout.reduce((s, o) => s + o.value, 0));
  assert.equal(tx.valueIn - tx.valueOut, t.fee);

  t.vout.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.equal(e.amount, o.value);
    assert.equal(e.time, t.status.block_time);
    assert.equal(e.target, ID.addr(o.scriptpubkey_address));
    assert.equal(g.node(e.target).scriptType, o.scriptpubkey_type);
  });
  t.vin.forEach((v, i) => {
    const e = g.edges.get(ID.edgeIn(t.txid, i));
    assert.equal(e.amount, v.prevout.value);
    assert.equal(e.source, ID.addr(v.prevout.scriptpubkey_address));
    assert.equal(e.target, tx.id);
  });
});

test('funding transactions appear as unloaded stubs with the spent output as an edge', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const stub = g.node(ID.tx(t.vin[0].txid));
  assert.ok(stub, 'funding tx stub exists');
  assert.equal(stub.loaded, false);
  const fund = g.edges.get(ID.edgeOut(t.vin[0].txid, t.vin[0].vout));
  assert.equal(fund.source, stub.id);
  assert.equal(fund.amount, t.vin[0].prevout.value);
  assert.equal(fund.spent, true);
  assert.equal(fund.spentBy.txid, t.txid);
});

test('adding a funding tx later fills in the stub and does not duplicate edges', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const before = g.stats();
  // fabricate the funding tx minimally: same txid, one output matching the spent prevout
  const v = t.vin[0];
  const funding = {
    txid: v.txid, fee: 100, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1000 },
    vin: [{ txid: 'ab'.repeat(32), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'x', scriptpubkey_type: 'p2pkh', value: v.prevout.value + 100 } }],
    vout: []
  };
  funding.vout[v.vout] = v.prevout;
  for (let i = 0; i < v.vout; i++) funding.vout[i] = { scriptpubkey_address: 'filler' + i, scriptpubkey_type: 'p2pkh', value: 1 };
  g.addTx(funding);
  const stub = g.node(ID.tx(v.txid));
  assert.equal(stub.loaded, true);
  assert.equal(stub.time, 1000);
  assert.equal(g.edges.get(ID.edgeOut(v.txid, v.vout)).amount, v.prevout.value);
  // the spent-output edge is the same edge, not a second one
  const outs = [...g.edges.values()].filter((e) => e.id === ID.edgeOut(v.txid, v.vout));
  assert.equal(outs.length, 1);
  assert.ok(g.stats().edges >= before.edges);
});

test('ingesting the same tx twice is idempotent', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const a = g.stats();
  g.addTx(t);
  assert.deepEqual(g.stats(), a);
  // adjacency sets must not grow either
  const tx = g.node(ID.tx(t.txid));
  assert.equal(g.edgesOf(tx.id).length, t.vin.length + t.vout.length);
});

test('coinbase tx does not crash: coinbase vertex, address-less outputs become data/nonstd vertices', () => {
  const t = fx('tx_coinbase.json');
  const g = new Graph();
  assert.doesNotThrow(() => g.addTx(t));
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.coinbase, true);
  assert.equal(tx.valueIn, null);
  const cb = g.node(ID.coinbase(t.txid));
  assert.equal(cb.type, 'coinbase');
  const inEdge = g.edges.get(ID.edgeIn(t.txid, 0));
  assert.equal(inEdge.source, cb.id);
  assert.equal(inEdge.amount, tx.valueOut);
  // every output got a vertex of some kind: no vertex id is undefined / missing
  t.vout.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.ok(g.node(e.target), 'target vertex exists for vout ' + n);
    if (!o.scriptpubkey_address) assert.notEqual(g.node(e.target).type, 'addr');
  });
});

test('OP_RETURN output becomes a data vertex carrying the payload', () => {
  const t = fx('tx_opreturn.json');
  const g = new Graph();
  assert.doesNotThrow(() => g.addTx(t));
  const n = t.vout.findIndex((o) => o.scriptpubkey_type === 'op_return');
  assert.ok(n >= 0);
  const d = g.node(ID.data(t.txid, n));
  assert.equal(d.type, 'data');
  assert.equal(typeof d.dataHex, 'string');
  const e = g.edges.get(ID.edgeOut(t.txid, n));
  assert.equal(e.target, d.id);
  g.nodes.forEach((node) => assert.equal(typeof node.id, 'string'));
});

test('outspends mark outputs spent, create spender stubs and carry the spender time', () => {
  const t = fx('tx_normal.json');
  const sp = fx('outspends_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, sp);
  sp.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.equal(e.spent, !!o.spent);
    if (o.spent) {
      assert.equal(e.spentBy.txid, o.txid);
      const stub = g.node(ID.tx(o.txid));
      assert.ok(stub);
      assert.equal(stub.time, o.status.confirmed ? o.status.block_time : null);
      const inE = g.edges.get(ID.edgeIn(o.txid, o.vin));
      assert.equal(inE.source, e.target);
      assert.equal(inE.target, stub.id);
      assert.equal(inE.amount, e.amount);
    }
  });
});

test('spender transactions connect to the graph through the output they spend', () => {
  const t = fx('tx_normal.json');
  const sp = fx('outspends_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, sp);
  const before = g.stats().edges;
  const spender = fx('tx_spender_0.json');
  g.addTx(spender);
  assert.equal(g.node(ID.tx(spender.txid)).loaded, true);
  // the spender's own input edge for the spent output must be the one created from outspends
  const spentVin = spender.vin.findIndex((v) => v.txid === t.txid);
  assert.ok(spentVin >= 0);
  assert.ok(g.edges.has(ID.edgeIn(spender.txid, spentVin)));
  assert.ok(g.stats().edges > before);
});

test('removeNode drops the vertex, its edges and vertices left orphaned', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const removed = g.removeNode(ID.tx(t.txid));
  assert.ok(removed.includes(ID.tx(t.txid)));
  assert.equal(g.nodes.size, 0);
  assert.equal(g.edges.size, 0);
});

test('refreshDerived computes first/last seen, received, sent and degree', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.refreshDerived();
  const a = g.node(ID.addr(t.vout[0].scriptpubkey_address));
  assert.equal(a.received, t.vout[0].value);
  assert.equal(a.firstSeen, t.status.block_time);
  assert.equal(a.degree, 1);
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.degree, t.vin.length + t.vout.length);
});

test('timeBounds reports min/max of confirmed times and counts pending separately', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 100, confirmed: true });
  g.upsertNode({ id: 'tx:b', type: 'tx', txid: 'b', time: 300, confirmed: true });
  g.upsertNode({ id: 'tx:c', type: 'tx', txid: 'c', time: null, confirmed: false });
  g.upsertNode({ id: 'tx:d', type: 'tx', txid: 'd', time: null, confirmed: null });
  assert.deepEqual(g.timeBounds(), { min: 100, max: 300, pending: 1, unknown: 1 });
});

test('toData/fromData round-trips', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  const copy = Graph.fromData(JSON.parse(JSON.stringify(g.toData())));
  assert.deepEqual(copy.stats(), g.stats());
  assert.deepEqual(copy.toData(), g.toData());
});

test('null never overwrites known data on merge', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 5, confirmed: true, loaded: true });
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: null, confirmed: null, loaded: false });
  const n = g.node('tx:a');
  assert.equal(n.time, 5);
  assert.equal(n.confirmed, true);
  // `loaded: false` is a real value, but an unloaded stub must not demote a loaded tx
  assert.equal(n.loaded, true);
});

test('decodeOpReturn extracts printable text and raw hex', () => {
  // 6a 0b "hello world"
  const hex = '6a0b' + Buffer.from('hello world').toString('hex');
  const d = decodeOpReturn(hex);
  assert.equal(d.text, 'hello world');
  assert.equal(d.hex, Buffer.from('hello world').toString('hex'));
  // binary payload yields hex but no text
  const bin = decodeOpReturn('6a20' + '00'.repeat(16) + 'ff'.repeat(16));
  assert.equal(bin.text, '');
  assert.equal(bin.hex.length, 64);
  // PUSHDATA1
  const long = 'a'.repeat(80);
  const p1 = decodeOpReturn('6a4c50' + Buffer.from(long).toString('hex'));
  assert.equal(p1.text.length, 80);
  // empty / malformed never throws
  assert.deepEqual(decodeOpReturn('6a'), { hex: '', text: '' });
  assert.doesNotThrow(() => decodeOpReturn('6a4d'));
  assert.doesNotThrow(() => decodeOpReturn(undefined));
});

test('removeNode also drops spender stubs that only hung off the removed transaction', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  assert.ok(g.nodes.size > 5);
  g.removeNode(ID.tx(t.txid));
  assert.equal(g.nodes.size, 0);
  assert.equal(g.edges.size, 0);
});

test('removeNode keeps a stub that is still connected to something else', () => {
  const t = fx('tx_normal.json'), sp = fx('outspends_normal.json'), other = fx('tx_spender_0.json');
  const g = new Graph();
  g.addTx(t); g.addOutspends(t.txid, sp); g.addTx(other);          // `other` is loaded and spends one of t's outputs
  g.removeNode(ID.tx(t.txid));
  assert.ok(g.node(ID.tx(other.txid)), 'the loaded spender stays');
  assert.equal(g.node(ID.tx(other.txid)).loaded, true);
});

test('a transaction keeps the habits of its wallet: version, locktime, sequence numbers and whether it sorts (BIP 69)', () => {
  const t = fx('tx_normal.json'), g = new Graph();
  g.addTx(t);
  const n = g.node(ID.tx(t.txid));
  assert.equal(n.version, t.version); assert.equal(n.locktime, t.locktime);
  assert.deepEqual(n.seqs, [...new Set(t.vin.map((v) => v.sequence))].sort((a, b) => a - b));
  assert.equal(n.bip69, null, 'a 1-in 2-out transaction says nothing about ordering: half of all random orders are sorted');

  const mk = (ins, outs, extra) => Object.assign({ txid: 'a'.repeat(64), version: 2, locktime: 800000, fee: 1, weight: 400, status: { confirmed: true, block_height: 800001, block_time: 1 },
    vin: ins.map(([txid, vout, seq]) => ({ txid, vout, sequence: seq, is_coinbase: false, prevout: { scriptpubkey_address: 'x' + txid[0], scriptpubkey_type: 'v0_p2wpkh', value: 5000 } })),
    vout: outs.map(([value, spk]) => ({ scriptpubkey: spk, scriptpubkey_address: 'y' + spk, scriptpubkey_type: 'v0_p2wpkh', value })) }, extra);
  const sorted = mk([['1'.repeat(64), 0, 4294967293], ['1'.repeat(64), 1, 4294967293], ['2'.repeat(64), 0, 4294967293]], [[1000, '0014aa'], [2000, '0014bb']]);
  const gs = new Graph(); gs.addTx(sorted);
  assert.equal(gs.node(ID.tx(sorted.txid)).bip69, true);
  assert.deepEqual(gs.node(ID.tx(sorted.txid)).seqs, [4294967293]);
  const unsortedOut = mk([['1'.repeat(64), 0, 4294967293], ['2'.repeat(64), 0, 4294967294]], [[2000, '0014bb'], [1000, '0014aa'], [3000, '0014cc']], { txid: 'b'.repeat(64) });
  const gu = new Graph(); gu.addTx(unsortedOut);
  assert.equal(gu.node(ID.tx(unsortedOut.txid)).bip69, false, 'outputs not in ascending amount order');
  assert.deepEqual(gu.node(ID.tx(unsortedOut.txid)).seqs, [4294967293, 4294967294]);
  const unsortedIn = mk([['2'.repeat(64), 0, 1], ['1'.repeat(64), 0, 1], ['3'.repeat(64), 0, 1]], [[1000, '0014aa'], [2000, '0014bb']], { txid: 'c'.repeat(64) });
  const gi = new Graph(); gi.addTx(unsortedIn);
  assert.equal(gi.node(ID.tx(unsortedIn.txid)).bip69, false, 'inputs not in ascending txid order');
  const noScripts = mk([['1'.repeat(64), 0, 1], ['2'.repeat(64), 0, 1]], [[1000, 'x'], [2000, 'y'], [3000, 'z']], { txid: 'd'.repeat(64) });
  noScripts.vout.forEach((o) => { delete o.scriptpubkey; });
  const gn = new Graph(); gn.addTx(noScripts);
  assert.equal(gn.node(ID.tx(noScripts.txid)).bip69, null, 'without the scripts the output order cannot be judged');
});

test('a coinbase and a transaction without those fields are handled', () => {
  const g = new Graph(), cb = fx('tx_coinbase.json');
  g.addTx(cb);
  assert.equal(g.node(ID.tx(cb.txid)).bip69, null);
  const bare = { txid: 'e'.repeat(64), status: { confirmed: false }, vin: [{ txid: 'f'.repeat(64), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'q', scriptpubkey_type: 'p2pkh', value: 10 } }], vout: [{ scriptpubkey_address: 'r', scriptpubkey_type: 'p2pkh', value: 9 }] };
  g.addTx(bare);
  const n = g.node(ID.tx(bare.txid));
  assert.equal(n.version, null); assert.equal(n.locktime, null); assert.deepEqual(n.seqs, []);
});

test('address stats give a balance: confirmed, unconfirmed apart, and null until they are read', () => {
  const { balanceOf } = require('../public/js/hopline-model.js');
  const g = new Graph();
  g.upsertNode({ id: ID.addr('A'), type: 'addr', address: 'A' });
  assert.equal(balanceOf(g.node(ID.addr('A'))), null, 'never read: unknown, not zero');
  g.addAddressStats('A', { chain_stats: { funded_txo_sum: 900000, spent_txo_sum: 400000, tx_count: 7 }, mempool_stats: { funded_txo_sum: 30000, spent_txo_sum: 0, tx_count: 1 } }, { at: 1700000000, source: 'https://x/api' });
  const n = g.node(ID.addr('A')), b = balanceOf(n);
  assert.deepEqual(b, { confirmed: 500000, pending: 30000, total: 530000, received: 900000, sent: 400000 });
  assert.equal(n.txCount, 8); assert.equal(n.statsAt, 1700000000); assert.equal(n.statsSource, 'https://x/api');
  g.addAddressStats('A', { chain_stats: { funded_txo_sum: 900000, spent_txo_sum: 400000, tx_count: 7 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 20000, tx_count: 1 } }, { at: 1700000100 });
  assert.equal(balanceOf(g.node(ID.addr('A'))).pending, -20000, 'unconfirmed spending is a negative pending amount');
  assert.equal(g.node(ID.addr('A')).statsSource, 'https://x/api', 'a missing source never erases a known one');
  assert.equal(balanceOf(null), null); assert.equal(balanceOf({ type: 'tx' }), null);
  g.addAddressStats('B', { chain_stats: { funded_txo_sum: 'x', spent_txo_sum: NaN } }, {});
  assert.equal(balanceOf(g.node(ID.addr('B'))), null, 'rubbish in the stats counts as not read');
  g.addAddressStats('C', {}, {});
  assert.equal(balanceOf(g.node(ID.addr('C'))), null); assert.equal(g.node(ID.addr('C')).txCount, 0);
});

test('a balance read alone does not count as the wallet\'s history being read', () => {
  const { historyRead } = require('../public/js/hopline-model.js');
  const stats = { chain_stats: { funded_txo_sum: 900000, spent_txo_sum: 900000, tx_count: 4 }, mempool_stats: {} };
  const g = new Graph();
  g.upsertNode({ id: ID.addr('A'), type: 'addr', address: 'A' });
  assert.equal(historyRead(g.node(ID.addr('A'))), false, 'nothing asked for');
  g.addAddressStats('A', stats, { at: 1 });
  const a = g.node(ID.addr('A'));
  assert.equal(a.txCount, 4); assert.equal(a.balanceOnly, true); assert.equal(historyRead(a), false, 'it knows how many transactions there are, and has none of them');
  g.addAddressStats('A', stats, { at: 2 });
  assert.equal(historyRead(g.node(ID.addr('A'))), false, 'a second balance read changes nothing');
  g.addAddressStats('A', stats, { at: 3, history: true });
  assert.equal(historyRead(g.node(ID.addr('A'))), true, 'read together with the transactions'); assert.equal('balanceOnly' in g.node(ID.addr('A')), false);
  g.addAddressStats('A', stats, { at: 4 });
  assert.equal(historyRead(g.node(ID.addr('A'))), true, 'and a later balance read does not undo that');
  g.addAddressStats('B', stats, { at: 1, history: true });
  assert.equal(historyRead(g.node(ID.addr('B'))), true);
  g.upsertNode({ id: ID.addr('OLD'), type: 'addr', address: 'OLD', txCount: 9 });                      // a file or a session from before the difference was kept
  assert.equal(historyRead(g.node(ID.addr('OLD'))), true);
  assert.equal(historyRead(null), false); assert.equal(historyRead({ type: 'tx', txCount: 3 }), false);
});

test('historyOpen: the totals of a wallet say whether more of its transactions can exist in a direction', () => {
  const { historyOpen } = require('../public/js/hopline-model.js');
  const w = (o) => Object.assign({ id: 'addr:w', type: 'addr', address: 'w', received: 0, sent: 0 }, o);
  assert.equal(historyOpen(w({}), 'next'), true, 'nothing known: it may have anything'); assert.equal(historyOpen(w({}), 'prev'), true);
  assert.equal(historyOpen(null, 'next'), false); assert.equal(historyOpen({ type: 'tx' }, 'next'), false);
  const read = { txCount: 2, balanceOnly: true, fundedSum: 900, spentSum: 0, mempoolFundedSum: 0, mempoolSpentSum: 0 };
  assert.equal(historyOpen(w(Object.assign({ received: 900 }, read)), 'next'), false, 'it never spent: nothing goes forward');
  assert.equal(historyOpen(w(Object.assign({ received: 900 }, read)), 'prev'), false, 'and everything it received is in the graph');
  assert.equal(historyOpen(w(Object.assign({ received: 500 }, read)), 'prev'), true, 'received more than the graph holds');
  assert.equal(historyOpen(w(Object.assign({ received: 500 }, read))), true, 'either direction');
  const spent = Object.assign({}, read, { spentSum: 900 });
  assert.equal(historyOpen(w(Object.assign({ received: 900 }, spent)), 'next'), true, 'it spent coins that are not in the graph');
  assert.equal(historyOpen(w(Object.assign({ received: 900, sent: 900 }, spent)), 'next'), false, 'and once the graph holds all of that');
  assert.equal(historyOpen(w(Object.assign({ received: 900 }, read, { mempoolSpentSum: 40 })), 'next'), true, 'unconfirmed spending counts');
  assert.equal(historyOpen(w(Object.assign({ received: 900, histNext: 'abc' }, read)), 'next'), true, 'a further page of history is waiting');
  assert.equal(historyOpen(w({ txCount: 2, received: 1, sent: 0, fundedSum: 900, spentSum: 900 }), 'next'), false, 'its history was asked for: the page says what is left');
});

// ---- flowOf: what an address got from and gave to others, apart from its own change ---------------------------------------------------------
const hex2 = (n) => n.toString(16).padStart(2, '0').repeat(32);
/** A confirmed transaction n: ins are [address, value, number of the transaction it spends from, its output index], outs are [address, value]. */
const flowTx = (n, time, ins, outs) => ({
  txid: hex2(n), fee: 100, weight: 400, status: { confirmed: true, block_height: 700000 + n, block_time: time },
  vin: ins.map(([a, v, p, k]) => ({ txid: hex2(p), vout: k, is_coinbase: false, prevout: { scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: v } })),
  vout: outs.map(([a, v]) => ({ scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: v }))
});

test('flowOf: change that comes back to the wallet counts both ways and is told apart from what others paid it and what it paid them', () => {
  const g = new Graph();
  g.addTx(flowTx(11, 1000, [['payer', 150000, 90, 0]], [['w', 100000], ['payer2', 49000]]));          // 100,000 in from others
  g.addTx(flowTx(12, 2000, [['w', 100000, 11, 0]], [['shop', 30000], ['w', 69850]]));                  // 30,000 out and 150 of fee; 69,850 came back as change
  g.addTx(flowTx(13, 3000, [['w', 69850, 12, 1]], [['shop2', 40000], ['w', 29700]]));                  // 40,000 out and 150 of fee; 29,700 came back
  g.refreshDerived();
  const f = g.flowOf(ID.addr('w')), w = g.node(ID.addr('w'));
  assert.equal(f.received, w.received); assert.equal(f.sent, w.sent);
  assert.equal(f.received, 100000 + 69850 + 29700); assert.equal(f.sent, 100000 + 69850);
  assert.equal(f.own, 69850 + 29700, 'what came back in each transaction that spent from it');
  assert.equal(f.ownTxs, 2);
  assert.equal(f.fromOthers, 100000); assert.equal(f.toOthers, 30000 + 150 + 40000 + 150, 'what left and did not come back: the payments and the fees');
  assert.equal(f.received - f.sent, f.fromOthers - f.toOthers, 'the balance moves by what others paid minus what it paid them');
  assert.deepEqual(f.txs.map((r) => [r.time, r.recv, r.sent]).sort((a, b) => a[0] - b[0]), [[1000, 100000, 0], [2000, 69850, 100000], [3000, 29700, 69850]]);
});

test('flowOf: a wallet that never paid itself has no own change, and the two totals are the plain ones', () => {
  const g = new Graph();
  g.addTx(flowTx(21, 1000, [['payer', 90000, 91, 0]], [['w', 80000]]));
  g.addTx(flowTx(22, 2000, [['w', 80000, 21, 0]], [['shop', 79000]]));
  g.refreshDerived();
  const f = g.flowOf(ID.addr('w'));
  assert.equal(f.own, 0); assert.equal(f.ownTxs, 0); assert.equal(f.fromOthers, 80000); assert.equal(f.toOthers, 80000);
  assert.deepEqual(g.flowOf(ID.addr('nobody')), { received: 0, sent: 0, own: 0, ownTxs: 0, fromOthers: 0, toOthers: 0, txs: [] }, 'an address that is not in the graph');
});

test('flowOf: in a transaction that paid the wallet more than it spent from it, only what it spent is its own', () => {
  const g = new Graph();
  g.addTx(flowTx(31, 1000, [['w', 50000, 92, 0], ['other', 100000, 93, 0]], [['w', 120000], ['third', 29000]]));   // w put in 50,000 and got 120,000: 50,000 of it is its own
  g.refreshDerived();
  const f = g.flowOf(ID.addr('w'));
  assert.equal(f.received, 120000 + 50000, 'the 50,000 it spent had been paid to it by an earlier transaction');
  assert.equal(f.own, 50000); assert.equal(f.fromOthers, 120000); assert.equal(f.toOthers, 0);
  assert.equal(f.received - f.sent, f.fromOthers - f.toOthers);
});

// ---- a coin into a wallet whose spending the graph holds in full is unspent, whether or not the outspends were read -----------------------------
test('spendingComplete: the whole history was read, or the totals say the graph holds all that the wallet spent', () => {
  const { spendingComplete, historyRead } = require('../public/js/hopline-model.js');
  const w = (o) => Object.assign({ id: 'addr:w', type: 'addr', address: 'w', received: 0, sent: 0 }, o);
  assert.equal(spendingComplete(null), false); assert.equal(spendingComplete({ type: 'tx' }), false);
  assert.equal(spendingComplete(w({})), false, 'nothing known');
  assert.equal(spendingComplete(w({ txCount: 3, histDone: true })), true, 'its whole history was read');
  assert.equal(historyRead(w({ txCount: 3 })), true);
  assert.equal(spendingComplete(w({ txCount: 3 })), false, 'read, but not said to be all of it (a cut-off read, or a file from before)');
  assert.equal(spendingComplete(w({ txCount: 3, histDone: true, histNext: 'abc' })), false, 'a further page is waiting');
  const read = { txCount: 2, balanceOnly: true, fundedSum: 900, spentSum: 0, mempoolSpentSum: 0 };
  assert.equal(spendingComplete(w(read)), true, 'it never spent');
  assert.equal(spendingComplete(w(Object.assign({}, read, { spentSum: 900 }))), false, 'it spent coins that are not in the graph');
  assert.equal(spendingComplete(w(Object.assign({}, read, { spentSum: 900, sent: 900 }))), true, 'and once the graph holds all of it');
  assert.equal(spendingComplete(w(Object.assign({}, read, { mempoolSpentSum: 40 }))), false, 'unconfirmed spending counts');
  assert.equal(spendingComplete(w(Object.assign({}, read, { histNext: 'abc' }))), false);
});

test('refreshDerived: an output to a wallet that never spent is unspent, and an output to a wallet nothing is known of is left unknown', () => {
  const g = new Graph();
  g.addTx(flowTx(21, 1000, [['payer', 150000, 90, 0]], [['kept', 100000], ['unknown', 49000]]));
  g.addAddressStats('kept', { chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: {} }, { at: 1 });          // read for its balance: it never spent
  g.refreshDerived();
  const a = g.edges.get(ID.edgeOut(hex2(21), 0)), b = g.edges.get(ID.edgeOut(hex2(21), 1));
  assert.equal(a.spent, false, 'unspent'); assert.equal(a.spentInferred, true, 'and said to be worked out, not read');
  assert.equal(b.spent, undefined, 'nothing is known of the other wallet'); assert.equal(b.spentInferred, undefined);
});

test('refreshDerived: a wallet whose whole history was read has its unspent coins marked, and a coin it spent is left to the transaction that spent it', () => {
  const g = new Graph();
  g.addTx(flowTx(31, 1000, [['payer', 150000, 90, 0]], [['w', 100000], ['w', 40000]]));
  g.addTx(flowTx(32, 2000, [['w', 100000, 31, 0]], [['shop', 99000]]));                                // spends the first coin
  g.upsertNode({ id: ID.addr('w'), type: 'addr', address: 'w', txCount: 2, histDone: true });
  g.refreshDerived();
  const first = g.edges.get(ID.edgeOut(hex2(31), 0)), second = g.edges.get(ID.edgeOut(hex2(31), 1));
  assert.equal(first.spent, true); assert.equal(first.spentBy.txid, hex2(32), 'a loaded spender is the answer, not a guess'); assert.equal(first.spentInferred, undefined);
  assert.equal(second.spent, false); assert.equal(second.spentInferred, true, 'the other coin: nothing spends it');
});

test('refreshDerived: what was worked out is worked out again, and a real answer replaces it', () => {
  const g = new Graph();
  g.addTx(flowTx(41, 1000, [['payer', 150000, 90, 0]], [['w', 100000]]));
  g.upsertNode({ id: ID.addr('w'), type: 'addr', address: 'w', txCount: 1, histDone: true });
  g.refreshDerived();
  const e = g.edges.get(ID.edgeOut(hex2(41), 0));
  assert.equal(e.spent, false);
  g.node(ID.addr('w')).histNext = 'abc';                                                                // the history turns out to go on: nothing is known any more
  g.refreshDerived();
  assert.equal(e.spent, undefined, 'taken back'); assert.equal(e.spentInferred, undefined);
  delete g.node(ID.addr('w')).histNext; g.refreshDerived();
  assert.equal(e.spent, false, 'and given again');
  g.addOutspends(hex2(41), [{ spent: false }]);                                                          // the server was asked: now it is read
  assert.equal(e.spent, false); assert.equal(e.spentInferred, undefined, 'no longer a guess');
  g.node(ID.addr('w')).histNext = 'abc'; g.refreshDerived();
  assert.equal(e.spent, false, 'and it stays when the inference would be taken back');
  g.addOutspends(hex2(41), [{ spent: true, txid: hex2(42), vin: 0, status: { confirmed: true, block_time: 5000 } }]);
  assert.equal(e.spent, true); assert.equal(e.spentBy.txid, hex2(42));
});

test('refreshDerived: only outputs are told apart, and only wallets: a coin to an unspendable or non-standard output is not claimed', () => {
  const g = new Graph();
  g.addTx({ txid: hex2(51), fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1000 },
            vin: [{ txid: hex2(90), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'payer', scriptpubkey_type: 'v0_p2wpkh', value: 1000 } }],
            vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: '6a00', value: 0 }, { scriptpubkey_address: 'w', scriptpubkey_type: 'v0_p2wpkh', value: 900 }] });
  g.upsertNode({ id: ID.addr('w'), type: 'addr', address: 'w', txCount: 1, histDone: true });
  g.refreshDerived();
  assert.equal(g.edges.get(ID.edgeOut(hex2(51), 0)).spent, undefined, 'a data output is not a wallet');
  assert.equal(g.edges.get(ID.edgeOut(hex2(51), 1)).spent, false);
  assert.equal(g.edges.get(ID.edgeIn(hex2(51), 0)).spent, undefined, 'an input is not a coin that is held');
});
