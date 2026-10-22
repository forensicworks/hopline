'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const An = require('../public/js/hopline-analysis.js');
const Det = require('../public/js/hopline-detections.js');

// ---- a tiny chain builder (the same shapes as analysis.test.js) ---------------------------------
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const a = (name) => 'bc1q' + name.padEnd(20, 'x');
const IN = (txn, vout, addr, value) => ({ txid: tid(txn), vout, addr, value });
const OUT = (addr, value) => ({ addr, value });

function add(g, n, ins, outs, time) {
  g.addTx({
    txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: time || 1650000000 + n * 600 },
    vin: ins.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, prevout: { scriptpubkey_address: i.addr, scriptpubkey_type: 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => ({ scriptpubkey_address: o.addr, scriptpubkey_type: 'v0_p2wpkh', value: o.value }))
  });
  return ID.tx(tid(n));
}
function spend(g, from, vout, by) {
  const outs = g.edgesOf(ID.tx(tid(from))).filter((e) => e.kind === 'out' && e.source === ID.tx(tid(from))).length;
  const list = Array.from({ length: outs }, () => ({ spent: false }));
  list[vout] = { spent: true, txid: tid(by), vin: 0, status: { confirmed: true, block_time: 1650000000 + by * 600 } };
  g.addOutspends(tid(from), list);
}
function peelChain(g, n, from) {
  let value = 1000000;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const t = from + i, prev = i === 0 ? IN(250 - (from % 50), 0, a('origin' + from), value) : IN(t - 1, 1, a('c' + from + '_' + (i - 1)), value);   // each chain has its own funding coin
    const small = 1000 + i * 13, large = value - small - 200;
    ids.push(add(g, t, [prev], [OUT(a('peel' + from + '_' + i), small), OUT(a('c' + from + '_' + i), large)]));
    if (i > 0) spend(g, t - 1, 1, t);
    value = large;
  }
  return ids;
}
const consolidation = (g, n) => add(g, n, Array.from({ length: 6 }, (_, i) => IN(200 + i, 0, a('k' + n + '_' + i), 10000)), [OUT(a('dest' + n), 59000)]);
const fmt = (s) => (s / 1e8).toFixed(8) + ' BTC';

function scene() {
  const g = new Graph();
  const chain = peelChain(g, 5, 10);                                                // 10..14
  const early = consolidation(g, 3);                                                // older than every chain step
  const late = consolidation(g, 90);
  return { g, chain, early, late, an: An.analyse(g) };
}

test('detections: one row per flag, oldest first', () => {
  const { an, g, chain, early, late } = scene();
  const d = Det.build(g, an);
  assert.deepEqual(d.rows.map((r) => r.id), [early, ...chain, late]);
  assert.ok(d.rows.every((r, i) => i === 0 || d.rows[i - 1].time <= r.time));
  assert.deepEqual(d.counts, { peel: 5, consolidation: 2, batch: 0, coinjoin: 0, total: 7 });
});

test('detections: a transaction that has not been confirmed comes last, and a flag keeps its colour and short text', () => {
  const { an, g, early } = scene();
  g.nodes.get(early).time = null;
  const d = Det.build(g, An.analyse(g));
  assert.equal(d.rows[d.rows.length - 1].id, early);
  const r = d.rows[0];
  assert.equal(r.kind, 'peel'); assert.match(r.short, /^PEEL 1\/5$/); assert.ok(r.color);
  const c = d.rows.find((x) => x.id === early);
  assert.equal(c.kind, 'consolidation'); assert.match(c.short, /^CONSOL 6→1$/); assert.equal(c.chain, ''); assert.equal(c.step, 0);
  assert.equal(c.txid, tid(3)); assert.equal(c.height, 700003);
});

test('detections: a peel step names its chain and says what it paid and passed on', () => {
  const { an, g, chain } = scene();
  const label = an.chains[0].label;
  const d = Det.build(g, an, { fmt });
  const r = d.rows.find((x) => x.id === chain[2]);
  assert.equal(r.chain, label); assert.equal(r.step, 3); assert.equal(r.of, 5);
  assert.match(r.reason, /^Pays 0\.00001026 BTC out and passes 0\.0\d+ BTC on \(step 3 of 5 in P-/);
  assert.ok(r.reason.includes(label));
  const consol = d.rows.find((x) => x.kind === 'consolidation');
  assert.match(consol.reason, /^Consolidation: 6 inputs gathered into 1 output/);
});

test('detections: every chain is listed, however many there are', () => {
  const g = new Graph();
  for (let k = 0; k < 9; k++) peelChain(g, 4, 100 + k * 5);
  const d = Det.build(g, An.analyse(g));
  assert.equal(d.chains.length, 9); assert.equal(d.counts.peel, 36); assert.equal(d.rows.length, 36);
  assert.equal(new Set(d.chains.map((c) => c.label)).size, 9);
  d.chains.forEach((c) => { assert.equal(c.n, 4); assert.ok(c.firstTime < c.lastTime && c.totalPeeled > 0 && c.color); });
});

test('detections: a kind switched off is left out of the rows, the counts and the chains', () => {
  const { an, g } = scene();
  const d = Det.build(g, an, { kinds: { peel: false } });
  assert.equal(d.rows.length, 2); assert.equal(d.chains.length, 0); assert.equal(d.counts.peel, 0); assert.equal(d.counts.total, 2);
  const e = Det.build(g, an, { kinds: { consolidation: false } });
  assert.equal(e.rows.length, 5); assert.equal(e.chains.length, 1);
});

test('pick: one kind, one chain, or everything', () => {
  const g = new Graph();
  peelChain(g, 4, 100); peelChain(g, 4, 110); consolidation(g, 3);
  const d = Det.build(g, An.analyse(g));
  assert.equal(Det.pick(d.rows).length, 9); assert.equal(Det.pick(d.rows, { kind: 'all' }).length, 9);
  assert.equal(Det.pick(d.rows, { kind: 'peel' }).length, 8); assert.equal(Det.pick(d.rows, { kind: 'consolidation' }).length, 1);
  const only = Det.pick(d.rows, { chain: d.chains[1].label });
  assert.equal(only.length, 4); assert.ok(only.every((r) => r.chain === d.chains[1].label));
  assert.equal(Det.pick(d.rows, { kind: 'consolidation', chain: d.chains[0].label }).length, 0);
});

test('toText: a heading and one tab-separated line per row, with nothing that would break a column', () => {
  const { an, g } = scene();
  const d = Det.build(g, an);
  const lines = Det.toText(d.rows, (t) => 'T' + t).split('\n');
  assert.equal(lines[0], 'Time\tTransaction\tPattern\tWhy'); assert.equal(lines.length, 1 + d.rows.length);
  lines.slice(1).forEach((l) => assert.equal(l.split('\t').length, 4));
  assert.ok(lines[2].split('\t')[2].startsWith('PEEL 1/5 P-'));
  assert.equal(Det.toText([], null), 'Time\tTransaction\tPattern\tWhy');
});

test('detections: an empty graph, or no analysis, lists nothing', () => {
  assert.deepEqual(Det.build(new Graph(), An.analyse(new Graph())).rows, []);
  const d = Det.build(null, null);
  assert.deepEqual(d.rows, []); assert.deepEqual(d.chains, []); assert.equal(d.counts.total, 0);
});
