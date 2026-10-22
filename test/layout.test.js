'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/hopline-model.js');
const F = require('../public/js/hopline-filter.js');
const L = require('../public/js/hopline-layout.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

function realGraph() {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  [0, 1].forEach((i) => g.addTx(fx(`tx_spender_${i}.json`)));
  g.addTx(fx('tx_coinbase.json'));
  g.addTx(fx('tx_opreturn.json'));
  g.refreshDerived();
  return g;
}

function allDistinct(pos, minDist) {
  const pts = [...pos.values()];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < minDist) return false;
  }
  return true;
}

test('every layout positions every visible vertex with finite numbers and no overlaps', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  ['flow', 'timeline', 'force'].forEach((name) => {
    const { pos } = L.layout(name, g, v);
    assert.equal(pos.size, v.nodes.size, name);
    pos.forEach((p, id) => { assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${name} ${id}`); });
    assert.ok(allDistinct(pos, 8), name + ' overlap');
  });
});

test('flow: money moves left to right on an acyclic graph', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t); g.addOutspends(t.txid, fx('outspends_normal.json')); g.addTx(fx('tx_coinbase.json')); g.addTx(fx('tx_opreturn.json'));
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  v.edges.forEach((id) => {
    const e = g.edges.get(id);
    assert.ok(pos.get(e.source).x < pos.get(e.target).x, `${e.source} -> ${e.target}`);
  });
});

test('flow: address reuse makes cycles; only the edges that close a cycle may point backwards', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  let back = 0;
  v.edges.forEach((id) => { const e = g.edges.get(id); if (pos.get(e.source).x >= pos.get(e.target).x) back++; });
  assert.ok(back / v.edges.size < 0.2, `${back} of ${v.edges.size} edges point backwards`);
});

test('flow: survives a cycle in imported data', () => {
  const g = new Graph();
  g.upsertNode({ id: 'a', type: 'addr' }); g.upsertNode({ id: 'b', type: 'tx', time: 1, confirmed: true });
  g.upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'in', amount: 5 });
  g.upsertEdge({ id: 'e2', source: 'b', target: 'a', kind: 'out', amount: 5 });
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  assert.equal(pos.size, 2);
});

test('timeline: transaction x follows confirmation time', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { width: 1000 });
  const txs = [...v.nodes].map((id) => g.node(id)).filter((n) => n.type === 'tx' && n.time != null);
  assert.ok(txs.length >= 3);
  txs.forEach((a) => txs.forEach((b) => {
    if (a.time < b.time) assert.ok(pos.get(a.id).x < pos.get(b.id).x);
    if (a.time === b.time) assert.equal(pos.get(a.id).x, pos.get(b.id).x);
  }));
  const xs = txs.map((n) => pos.get(n.id).x);
  assert.equal(Math.min(...xs), 0);
  assert.ok(Math.max(...xs) <= 1000 + 1e-9);
  assert.equal(axis.tMin, Math.min(...txs.map((n) => n.time)));
  assert.equal(axis.tMax, Math.max(...txs.map((n) => n.time)));
});

test('timeline: lanes never overlap horizontally', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const sep = 54;
  const { pos } = L.layoutTimeline(g, v, { minSep: sep });
  const byLane = new Map();
  pos.forEach((p) => { const k = p.y; if (!byLane.has(k)) byLane.set(k, []); byLane.get(k).push(p.x); });
  byLane.forEach((xs) => {
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= sep - 1e-9, `gap ${xs[i] - xs[i - 1]}`);
  });
});

test('timeline: pending transactions go after the last confirmed one, unknown stubs before their consumer', () => {
  const g = new Graph();
  const mk = (txid, time, ins, outs) => g.addTx({
    txid, fee: 1, weight: 400, status: time == null ? { confirmed: false } : { confirmed: true, block_height: 1, block_time: time },
    vin: ins.map(([ptxid, vout, addr, value]) => ({ txid: ptxid, vout, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value } })),
    vout: outs.map(([addr, value]) => ({ scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value }))
  });
  mk('t1', 1000, [['t0', 0, 'A', 500]], [['B', 400]]);
  mk('t2', 5000, [['t1', 0, 'B', 400]], [['C', 300]]);
  mk('t3', null, [['t2', 0, 'C', 300]], [['D', 200]]);
  const v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { width: 800 });
  assert.ok(axis.hasPending);
  assert.ok(pos.get(ID.tx('t3')).x > pos.get(ID.tx('t2')).x, 'pending after latest');
  assert.ok(pos.get(ID.tx('t0')).x < pos.get(ID.tx('t1')).x, 'unloaded funding stub before the tx it funds');
  assert.ok(pos.get(ID.addr('B')).x > pos.get(ID.tx('t1')).x && pos.get(ID.addr('B')).x < pos.get(ID.tx('t2')).x, 'address sits between creator and spender');
  assert.ok(pos.get(ID.addr('D')).x > pos.get(ID.tx('t3')).x, 'unspent output after its tx');
});

test('timeline: a single time (everything in one block) spreads vertically instead of stacking', () => {
  const g = new Graph();
  g.addTx(fx('tx_coinbase.json'));
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutTimeline(g, v);
  assert.ok(allDistinct(pos, 8));
  const ys = new Set([...pos.values()].map((p) => p.y));
  assert.ok(ys.size > 1);
});

test('timeline and flow handle an empty selection', () => {
  const g = new Graph();
  const v = F.computeVisible(g, {});
  ['flow', 'timeline', 'force'].forEach((n) => assert.equal(L.layout(n, g, v).pos.size, 0));
  assert.equal(L.bounds(new Map()), null);
});

test('force: deterministic for a seed, and continues from a starting layout', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const a = L.layoutForce(g, v, { seed: 7 }).pos, b = L.layoutForce(g, v, { seed: 7 }).pos;
  a.forEach((p, id) => { assert.equal(p.x, b.get(id).x); assert.equal(p.y, b.get(id).y); });
  const c = L.layoutForce(g, v, { seed: 99 }).pos;
  assert.ok([...a].some(([id, p]) => p.x !== c.get(id).x), 'different seed differs');
  // starting from a converged layout and running few iterations barely moves things
  const again = L.layoutForce(g, v, { start: a, iterations: 1 }).pos;
  let moved = 0; a.forEach((p, id) => { moved = Math.max(moved, Math.hypot(p.x - again.get(id).x, p.y - again.get(id).y)); });
  assert.ok(moved < 250, 'moved ' + moved);
});

test('force: connected vertices end up closer than unconnected ones on average', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t);
  g.addTx(fx('tx_coinbase.json'));        // a disconnected component
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutForce(g, v, { seed: 3 });
  let linked = 0, nl = 0, free = 0, nf = 0;
  const pairs = new Set();
  v.edges.forEach((id) => { const e = g.edges.get(id); pairs.add(e.source + '|' + e.target); pairs.add(e.target + '|' + e.source); });
  const ids = [...pos.keys()];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const d = Math.hypot(pos.get(ids[i]).x - pos.get(ids[j]).x, pos.get(ids[i]).y - pos.get(ids[j]).y);
    if (pairs.has(ids[i] + '|' + ids[j])) { linked += d; nl++; } else { free += d; nf++; }
  }
  assert.ok(linked / nl < free / nf);
});

test('layout dispatcher defaults to flow', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  assert.equal(L.layout('nonsense', g, v).axis, null);
  assert.ok(L.layout('timeline', g, v).axis);
});

// ---- time scale ----
const DAYS = 86400;

test('timeMapper proportional is linear in time', () => {
  const m = L.timeMapper([0, 100, 1000], 'proportional', 1000, 40, 120);
  assert.equal(m.xOf(0), 0);
  assert.equal(m.xOf(100), 100);
  assert.equal(m.xOf(1000), 1000);
  assert.equal(m.breaks.length, 0);
});

test('timeMapper compact: one outlier years later cannot squash a burst, and the gap is reported', () => {
  const burst = [0, 60, 120, 600, 3600];                         // an hour of activity
  const times = burst.concat([5 * 365 * DAYS]);                  // ... and one transaction five years later
  const lin = L.timeMapper(times, 'proportional', 1600, 40, 160);
  const cmp = L.timeMapper(times, 'compact', 1600, 40, 160);
  assert.ok(lin.xOf(3600) < 1, 'proportional: the whole burst is under one pixel');
  // compact: neighbours stay readable
  const xs = burst.map((t) => cmp.xOf(t));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 40 - 1e-9, `gap ${xs[i] - xs[i - 1]}`);
  assert.ok(cmp.x1 < 1700 && cmp.x1 > 200);
  // the five-year gap is capped and flagged, nothing else is
  assert.equal(cmp.breaks.length, 1);
  assert.ok(Math.abs((cmp.breaks[0].x1 - cmp.breaks[0].x0) - 160) < 1e-9);
  assert.equal(cmp.breaks[0].seconds, 5 * 365 * DAYS - 3600);
});

test('timeMapper compact is monotone and exact at the knots; a single time maps to 0', () => {
  const t = [10, 20, 500, 100000, 100001, 9e8];
  const m = L.timeMapper(t, 'compact', 1000, 30, 150);
  let prev = -1;
  t.forEach((x) => { const px = m.xOf(x); assert.ok(px >= prev); prev = px; });
  m.knots.forEach((k) => assert.equal(m.xOf(k.t), k.x));
  assert.equal(m.xOf(-5), 0);
  assert.equal(m.xOf(1e12), m.x1);
  assert.ok(m.xOf(15) > m.xOf(10) && m.xOf(15) < m.xOf(20), 'interpolates between knots');
  const one = L.timeMapper([5], 'compact', 1000, 30, 150);
  assert.equal(one.xOf(5), 0);
});

test('timeline compact layout keeps transactions in time order and exposes the axis mapper', () => {
  const g = new Graph();
  const mk = (txid, time, prev) => g.addTx({ txid, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: [{ txid: prev, vout: 0, prevout: { scriptpubkey_address: 'a' + prev, scriptpubkey_type: 'p2pkh', value: 9 } }],
    vout: [{ scriptpubkey_address: 'a' + txid, scriptpubkey_type: 'p2pkh', value: 8 }] });
  mk('t1', 1000, 't0'); mk('t2', 1060, 't1'); mk('t3', 1120, 't2'); mk('t4', 1000 + 4 * 365 * DAYS, 't3');
  const v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { scale: 'compact', width: 1600 });
  const x = (id) => pos.get(ID.tx(id)).x;
  assert.ok(x('t1') < x('t2') && x('t2') < x('t3') && x('t3') < x('t4'));
  assert.ok(x('t2') - x('t1') >= 40 - 1e-9, 'burst stays readable');
  assert.equal(axis.mode, 'compact');
  assert.equal(axis.breaks.length, 1);
  assert.equal(axis.xOf(1060), x('t2'));
  const prop = L.layoutTimeline(g, v, { scale: 'proportional', width: 1600 });
  assert.ok(prop.pos.get(ID.tx('t3')).x - prop.pos.get(ID.tx('t1')).x < 3, 'proportional squashes the same burst');
  assert.equal(prop.axis.mode, 'proportional');
});

// ---- time x amount ----------------------------------------------------------------------------
test('timeamount: x is the timeline\'s time, bigger amounts are higher, nothing overlaps, and the axis carries an amount scale', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const tl = L.layout('timeline', g, v, { scale: 'proportional' }), ta = L.layout('timeamount', g, v, { scale: 'proportional' });
  assert.equal(ta.pos.size, v.nodes.size);
  v.nodes.forEach((id) => { assert.equal(ta.pos.get(id).x, tl.pos.get(id).x, 'same x as the timeline: ' + id); });
  ta.pos.forEach((p, id) => assert.ok(Number.isFinite(p.y), id));
  assert.ok(allDistinct(ta.pos, 20), 'no two vertices on top of each other');
  const txs = [...v.nodes].filter((id) => g.nodes.get(id).type === 'tx' && g.nodes.get(id).loaded && g.nodes.get(id).time != null);
  const byAmount = txs.slice().sort((a, b) => g.nodes.get(b).valueOut - g.nodes.get(a).valueOut);
  const big = byAmount[0], small = byAmount[byAmount.length - 1];
  if (g.nodes.get(big).valueOut > g.nodes.get(small).valueOut * 3) assert.ok(ta.pos.get(big).y < ta.pos.get(small).y, 'the larger transaction is higher up the page (smaller y)');
  assert.ok(ta.axis && ta.axis.yTicks.length >= 2);
  ta.axis.yTicks.forEach((t, i) => { assert.ok(/ sat$| BTC$/.test(t.label) && Number.isFinite(t.y)); if (i) assert.ok(t.y < ta.axis.yTicks[i - 1].y, 'ticks rise with the amount'); });
  assert.equal(ta.axis.tMin, tl.axis.tMin);
});

test('timeamount: a wallet sits level with the largest movement it took part in, and equal amounts at one time fan out', () => {
  const g = new Graph();
  const mk = (txid, time, ins, outs) => g.addTx({ txid, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: ins.map(([p, vout, a, value]) => ({ txid: p, vout, is_coinbase: false, prevout: { scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value } })),
    vout: outs.map(([a, value]) => ({ scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value })) });
  mk('a', 1000, [['z', 0, 'src', 1000000]], [['big', 900000], ['mid', 90000], ['tiny', 900], ['same1', 5000], ['same2', 5000], ['same3', 5000]]);
  mk('b', 5000, [['a', 0, 'big', 900000]], [['next', 899000]]);
  g.refreshDerived();
  const v = F.computeVisible(g, {}), r = L.layout('timeamount', g, v, { scale: 'proportional' });
  const y = (id) => r.pos.get(id).y;
  assert.ok(y(ID.addr('big')) < y(ID.addr('mid')) && y(ID.addr('mid')) < y(ID.addr('tiny')));
  assert.equal(L.vertexAmount(g, v, ID.addr('big')), 900000);
  assert.equal(L.vertexAmount(g, v, ID.tx('a')), g.nodes.get(ID.tx('a')).valueOut, 'a transaction stands for its total output');
  const sames = ['same1', 'same2', 'same3'].map((a) => ID.addr(a));
  assert.equal(new Set(sames.map((id) => Math.round(y(id)))).size, 3, 'equal amounts at the same x are spread apart');
});

test('timeamount: degenerate inputs do not break it (nothing, one vertex, all the same amount)', () => {
  const g = new Graph();
  assert.equal(L.layout('timeamount', g, F.computeVisible(g, {})).pos.size, 0);
  g.addTx({ txid: 'only', fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: 5 }, vin: [{ txid: 'p', vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'x', scriptpubkey_type: 'v0_p2wpkh', value: 1000 } }],
                 vout: [{ scriptpubkey_address: 'y', scriptpubkey_type: 'v0_p2wpkh', value: 1000 }] });
  g.refreshDerived();
  const r = L.layout('timeamount', g, F.computeVisible(g, {}));
  assert.equal(r.pos.size, 4); r.pos.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.deepEqual(r.axis.yTicks, [], 'one amount, nothing to scale');
});

// ---- force: shapes take room by their size ---------------------------------------------------------
test('force with radii: no two shapes overlap, bigger ones keep more distance, and without radii nothing changes', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const radius = (id) => (id.startsWith('tx:') ? 20 : id.startsWith('addr:') ? 12 : 6);
  const plain = L.layout('force', g, v, { seed: 1 }), sized = L.layout('force', g, v, { seed: 1, radius });
  const ids = [...v.nodes];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = sized.pos.get(ids[i]), b = sized.pos.get(ids[j]);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= radius(ids[i]) + radius(ids[j]) + 7.5, `${ids[i]} / ${ids[j]} overlap`);
  }
  const span = (r) => { const b = L.bounds(r.pos); return Math.max(b.maxX - b.minX, b.maxY - b.minY); };
  assert.ok(span(sized) > span(plain), 'leaving room for the shapes spreads the picture out');
  assert.deepEqual([...L.layout('force', g, v, { seed: 1 }).pos], [...plain.pos], 'no radii given: exactly as before');
  assert.deepEqual([...L.layout('force', g, v, { seed: 1, radius }).pos], [...sized.pos], 'deterministic');
});

test('force with radii copes with an empty graph, one vertex, and a radius function that returns rubbish', () => {
  const g = new Graph();
  assert.equal(L.layout('force', g, F.computeVisible(g, {}), { radius: () => 10 }).pos.size, 0);
  const real = realGraph(), v = F.computeVisible(real, {});
  const r = L.layout('force', real, v, { seed: 1, radius: (id) => (id.length % 3 === 0 ? NaN : id.length % 3 === 1 ? -5 : undefined) });
  r.pos.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
});

// ---- time + force ---------------------------------------------------------------------------------
function peelishGraph(n) {
  // a chain of n transactions, each paying a small output off to the side and passing the rest on
  const g = new Graph();
  let value = 1000000;
  for (let i = 0; i < n; i++) {
    const small = 1000 + i * 13, large = value - small - 200;
    g.addTx({ txid: 'c' + i, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1000 + i * 600 },
      vin: [{ txid: i ? 'c' + (i - 1) : 'origin', vout: i ? 1 : 0, is_coinbase: false, prevout: { scriptpubkey_address: i ? 'w' + (i - 1) : 'src', scriptpubkey_type: 'v0_p2wpkh', value } }],
      vout: [{ scriptpubkey_address: 'peel' + i, scriptpubkey_type: 'v0_p2wpkh', value: small }, { scriptpubkey_address: 'w' + i, scriptpubkey_type: 'v0_p2wpkh', value: large }] });
    value = large;
  }
  g.refreshDerived();
  return g;
}

test('timeforce: x is the timeline\'s time, a chain runs level across and nothing overlaps', () => {
  const g = peelishGraph(8), v = F.computeVisible(g, {});
  const radius = (id) => (id.startsWith('tx:') ? 12 : id.startsWith('addr:peel') ? 4 : 10);
  const tl = L.layout('timeline', g, v, { scale: 'proportional' }), tf = L.layout('timeforce', g, v, { scale: 'proportional', radius });
  assert.equal(tf.pos.size, v.nodes.size);
  v.nodes.forEach((id) => assert.equal(tf.pos.get(id).x, tl.pos.get(id).x, 'same x as the timeline: ' + id));
  tf.pos.forEach((p, id) => assert.ok(Number.isFinite(p.y), id));
  const ids = [...v.nodes];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = tf.pos.get(ids[i]), b = tf.pos.get(ids[j]);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= radius(ids[i]) + radius(ids[j]) + 7.5, `${ids[i]} / ${ids[j]} overlap`);
  }
  const spine = []; for (let i = 0; i < 8; i++) { spine.push(tf.pos.get(ID.tx('c' + i)).y); if (i < 7) spine.push(tf.pos.get(ID.addr('w' + i)).y); }
  const range = (a) => Math.max(...a) - Math.min(...a);
  const laneSpine = []; for (let i = 0; i < 8; i++) laneSpine.push(tl.pos.get(ID.tx('c' + i)).y);
  assert.ok(range(spine) <= Math.max(range(laneSpine), 120), 'the main chain stays close to one height: ' + range(spine));
  const peels = [...Array(8).keys()].map((i) => tf.pos.get(ID.addr('peel' + i)).y);
  assert.ok(peels.every((y, i) => Math.abs(y - tf.pos.get(ID.tx('c' + i)).y) > 10), 'what each transaction peeled off sits beside the chain, not on it');
  assert.ok(tf.axis && tf.axis.tMin === tl.axis.tMin && tf.axis.knots.length === tl.axis.knots.length, 'the time axis comes with it');
});

test('timeforce: deterministic, continues from where things are, and survives degenerate input', () => {
  const g = peelishGraph(6), v = F.computeVisible(g, {});
  const a = L.layout('timeforce', g, v, { scale: 'proportional', seed: 3 }), b = L.layout('timeforce', g, v, { scale: 'proportional', seed: 3 });
  assert.deepEqual([...a.pos], [...b.pos], 'the same input gives the same picture');
  const again = L.layout('timeforce', g, v, { scale: 'proportional', seed: 3, start: a.pos });
  let drift = 0; a.pos.forEach((p, id) => { drift = Math.max(drift, Math.abs(p.y - again.pos.get(id).y)); });
  assert.ok(drift < 25, 'running it again from where it ended hardly moves anything: ' + drift);
  const empty = new Graph();
  assert.equal(L.layout('timeforce', empty, F.computeVisible(empty, {})).pos.size, 0);
  const rubbish = L.layout('timeforce', g, v, { scale: 'proportional', radius: (id) => (id.length % 2 ? NaN : -3) });
  rubbish.pos.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('timeforce: connected vertices end up closer in height than in the timeline\'s lanes', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const tl = L.layout('timeline', g, v, { scale: 'proportional' }), tf = L.layout('timeforce', g, v, { scale: 'proportional' });
  const edgeGap = (r) => { let s = 0, c = 0; v.edges.forEach((id) => { const e = g.edges.get(id); s += Math.abs(r.pos.get(e.source).y - r.pos.get(e.target).y); c++; }); return s / c; };
  assert.ok(edgeGap(tf) <= edgeGap(tl) + 1, `average height difference along an edge: ${edgeGap(tf).toFixed(1)} against ${edgeGap(tl).toFixed(1)} for the lanes`);
});

// ---- reading the time off the axis --------------------------------------------------------------
test('timeMapper tAt is the inverse of xOf: proportional exactly, compact at the knots and flagged inside a shortened gap', () => {
  const prop = L.timeMapper([1000, 2000, 5000], 'proportional', 1000, 40, 100);
  [1000, 1500, 2000, 3333, 5000].forEach((t) => assert.ok(Math.abs(prop.tAt(prop.xOf(t)).t - t) < 1e-6, 'proportional ' + t));
  assert.equal(prop.tAt(-1), null); assert.equal(prop.tAt(1001), null, 'off the ends of the line there is no time');
  assert.equal(prop.tAt(500).gap, false);
  const times = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 10000000];             // a burst, then one outlier long after
  const comp = L.timeMapper(times, 'compact', 1000, 30, 120);
  assert.ok(comp.breaks.length >= 1);
  times.forEach((t) => { const r = comp.tAt(comp.xOf(t)); assert.ok(r && Math.abs(r.t - t) < 1e-3, 'compact round trip ' + t); });
  const br = comp.breaks[0], mid = comp.tAt((br.x0 + br.x1) / 2);
  assert.equal(mid.gap, true, 'inside the shortened gap the time is only interpolated, and says so');
  assert.ok(mid.t > br.t0 && mid.t < br.t1);
  assert.equal(comp.tAt(comp.xOf(120)).gap, false);
  assert.equal(L.timeMapper([42], 'compact', 1000, 30, 120).tAt(0).t, 42, 'one time: that time');
  assert.equal(L.timeMapper([], 'proportional', 1000, 30, 120).tAt(0), null);
});

test('the timeline axis carries tAt and the combined layouts keep it', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  ['timeline', 'timeforce', 'timeamount'].forEach((name) => {
    const ax = L.layout(name, g, v, { scale: 'compact' }).axis;
    assert.equal(typeof ax.tAt, 'function', name);
    const k = ax.knots[ax.knots.length - 1];
    assert.ok(Math.abs(ax.tAt(ax.xOf(k.t)).t - k.t) < 1e-3, name);
  });
});
