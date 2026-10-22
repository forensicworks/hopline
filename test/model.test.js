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
