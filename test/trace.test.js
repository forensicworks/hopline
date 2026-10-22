'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/hopline-model.js');
const TR = require('../public/js/hopline-trace.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// A pays t1 -> (B 600, C 300, D 90); B is spent in t2 -> (E 500, F 50); C unspent; D spent in t3 -> G.
function chain() {
  const g = new Graph();
  const tx = (txid, time, ins, outs) => ({ txid, fee: 10, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: ins.map(([ptxid, vout, addr, value]) => ({ txid: ptxid, vout, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value } })),
    vout: outs.map(([addr, value]) => ({ scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value })) });
  g.addTx(tx('t1', 1000, [['t0', 0, 'A', 1000]], [['B', 600], ['C', 300], ['D', 90]]));
  g.addTx(tx('t2', 2000, [['t1', 0, 'B', 600]], [['E', 500], ['F', 50]]));
  g.addTx(tx('t3', 3000, [['t1', 2, 'D', 90]], [['G', 80]]));
  g.addOutspends('t1', [{ spent: true, txid: 't2', vin: 0, status: { confirmed: true, block_time: 2000 } }, { spent: false },
                        { spent: true, txid: 't3', vin: 0, status: { confirmed: true, block_time: 3000 } }]);
  g.addOutspends('t2', [{ spent: false }, { spent: false }]);
  g.addOutspends('t3', [{ spent: false }]);
  g.refreshDerived();
  return g;
}
const ids = (rows) => rows.map((r) => r.id);

test('neighbours: a transaction steps to wallets, a wallet steps to transactions, merged and with amounts', () => {
  const g = chain();
  assert.deepEqual(ids([...TR.neighbours(g, ID.tx('t1'), 'next').values()]).sort(), [ID.addr('B'), ID.addr('C'), ID.addr('D')].sort());
  assert.deepEqual(ids([...TR.neighbours(g, ID.tx('t1'), 'prev').values()]), [ID.addr('A')]);
  assert.deepEqual(ids([...TR.neighbours(g, ID.addr('B'), 'next').values()]), [ID.tx('t2')]);
  assert.deepEqual(ids([...TR.neighbours(g, ID.addr('B'), 'prev').values()]), [ID.tx('t1')]);
  assert.equal(TR.neighbours(g, ID.addr('B'), 'next').get(ID.tx('t2')).amount, 600);
  assert.equal(TR.neighbours(g, ID.addr('B'), 'next').get(ID.tx('t2')).time, 2000);
  assert.equal(TR.neighbours(g, ID.addr('C'), 'next').size, 0, 'unspent: nowhere to go');
  assert.equal(TR.neighbours(g, 'nope', 'next').size, 0);
});

test('hidden counts what is not shown yet, and says when more may exist beyond what is loaded', () => {
  const g = chain();
  const shown = new Set([ID.tx('t1')]);
  const h = TR.hidden(g, shown, ID.tx('t1'), 'next');
  assert.equal(h.known, 3); assert.equal(h.unknown, false, 'a loaded transaction has all its outputs');
  assert.equal(TR.handleLabel(h), '3');
  shown.add(ID.addr('B'));
  assert.equal(TR.hidden(g, shown, ID.tx('t1'), 'next').known, 2, 'what is shown no longer counts');
  // a wallet whose history was never loaded: what is known may be only part of it
  const b = TR.hidden(g, shown, ID.addr('B'), 'next');
  assert.deepEqual([b.known, b.unknown, TR.handleLabel(b)], [1, true, '1+']);
  g.node(ID.addr('B')).txCount = 2;
  assert.deepEqual([TR.hidden(g, shown, ID.addr('B'), 'next').unknown, TR.handleLabel(TR.hidden(g, shown, ID.addr('B'), 'next'))], [false, '1']);
  g.node(ID.addr('B')).histNext = 'abc';
  assert.equal(TR.hidden(g, shown, ID.addr('B'), 'next').unknown, true, 'a further page of history exists');
  // unspent wallet, history unknown -> "?"; an unloaded transaction knows one neighbour but may have more -> "1+"
  assert.equal(TR.handleLabel(TR.hidden(g, shown, ID.addr('C'), 'next')), '?');
  assert.equal(TR.handleLabel(TR.hidden(g, shown, ID.tx('t0'), 'next')), '1+');
  g.upsertNode({ id: ID.tx('lonely'), type: 'tx', txid: 'lonely', loaded: false });
  assert.equal(TR.handleLabel(TR.hidden(g, shown, ID.tx('lonely'), 'next')), '?', 'nothing known at all');
  assert.equal(TR.handleLabel({ known: 0, unknown: false }), '');
  // things that cannot be expanded
  g.addTx(fx('tx_coinbase.json'));
  const cb = fx('tx_coinbase.json');
  assert.equal(TR.handleLabel(TR.hidden(g, new Set(), ID.coinbase(cb.txid), 'next')), '');
  assert.equal(TR.hidden(g, new Set(), 'nope', 'next').known, 0);
});

test('plan: a transaction reveals its wallets, largest first, up to the limit', () => {
  const g = chain();
  const p = TR.plan(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'next', { limit: 2 });
  assert.deepEqual(ids(p.primary), [ID.addr('B'), ID.addr('C')]);
  assert.equal(p.remaining, 1);
  assert.deepEqual(p.secondary, []); assert.deepEqual(p.needLoad, []);
  const all = TR.plan(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'next', { limit: 10 });
  assert.equal(all.remaining, 0); assert.equal(all.primary.length, 3);
  assert.deepEqual(ids(TR.plan(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'prev').primary), [ID.addr('A')]);
});

test('plan: a wallet reveals the transactions that spent from it and the wallets those paid', () => {
  const g = chain();
  const shown = new Set([ID.addr('B')]);
  const p = TR.plan(g, shown, ID.addr('B'), 'next');
  assert.deepEqual(ids(p.primary), [ID.tx('t2')]);
  assert.deepEqual(p.secondary.map((s) => [s.parent, ids(s.rows)]), [[ID.tx('t2'), [ID.addr('E'), ID.addr('F')]]], 'the wallets t2 paid, largest first');
  const back = TR.plan(g, new Set([ID.addr('B')]), ID.addr('B'), 'prev');
  assert.deepEqual(ids(back.primary), [ID.tx('t1')]);
  assert.deepEqual(back.secondary.map((s) => ids(s.rows)), [[ID.addr('A')]], 'the wallets that paid into t1 (B and the rest are not shown: only inputs go backward)');
});

test('plan: transactions not loaded yet are listed to load first; the inner limit leaves a remainder', () => {
  const g = new Graph();
  g.upsertNode({ id: ID.addr('W'), type: 'addr', address: 'W' });
  g.upsertNode({ id: ID.tx('s1'), type: 'tx', txid: 's1', loaded: false });
  g.upsertEdge({ id: ID.edgeIn('s1', 0), source: ID.addr('W'), target: ID.tx('s1'), kind: 'in', txid: 's1', amount: 5, time: 10 });
  const p = TR.plan(g, new Set([ID.addr('W')]), ID.addr('W'), 'next');
  assert.deepEqual(p.needLoad, ['s1']); assert.deepEqual(p.secondary, []);
  // once loaded with 5 outputs and an inner limit of 3
  g.addTx({ txid: 's1', fee: 1, weight: 400, status: { confirmed: true, block_time: 10 }, vin: [{ txid: 'z', vout: 0, prevout: { scriptpubkey_address: 'W', scriptpubkey_type: 'p2pkh', value: 5 } }],
            vout: [1, 2, 3, 4, 5].map((i) => ({ scriptpubkey_address: 'O' + i, scriptpubkey_type: 'p2pkh', value: i })) });
  const q = TR.plan(g, new Set([ID.addr('W')]), ID.addr('W'), 'next', { inner: 3 });
  assert.deepEqual(q.needLoad, []);
  assert.deepEqual(ids(q.secondary[0].rows), [ID.addr('O5'), ID.addr('O4'), ID.addr('O3')]);
  assert.equal(q.remainingInner, 2);
});

test('plan never offers what is already shown and ignores things that cannot be expanded', () => {
  const g = chain();
  const shown = new Set([ID.tx('t1'), ID.addr('B'), ID.addr('C'), ID.addr('D')]);
  assert.equal(TR.plan(g, shown, ID.tx('t1'), 'next').primary.length, 0);
  assert.deepEqual(TR.plan(g, shown, 'nope', 'next').primary, []);
  g.addTx(fx('tx_opreturn.json'));
  const t = fx('tx_opreturn.json');
  const dataNode = [...g.nodes.values()].find((n) => n.type === 'data');
  assert.deepEqual(TR.plan(g, new Set(), dataNode.id, 'next').primary, []);
  assert.ok(TR.plan(g, new Set([ID.tx(t.txid)]), ID.tx(t.txid), 'next').primary.some((r) => r.type === 'data'), 'an OP_RETURN output is revealed like any other output');
});

test('place: new vertices go in the next column, centred on the clicked one, in order', () => {
  const g = chain();
  const pos = new Map([[ID.tx('t1'), { x: 0, y: 0 }]]);
  const p = TR.plan(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'next');
  const placed = TR.place(pos, ID.tx('t1'), 'next', p, { colGap: 200, rowGap: 60 });
  assert.equal(placed.size, 3);
  placed.forEach((v) => assert.equal(v.x, 200));
  const ys = ids(p.primary).map((id) => placed.get(id).y);
  assert.deepEqual(ys, [-60, 0, 60], 'largest first, top to bottom, centred on 0');
  const back = TR.place(pos, ID.tx('t1'), 'prev', TR.plan(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'prev'), { colGap: 200 });
  assert.equal(back.get(ID.addr('A')).x, -200, 'backward goes left');
});

test('place: nothing lands on anything, existing vertices are never moved, and a wallet hop uses two columns', () => {
  const g = chain();
  const pos = new Map([[ID.addr('B'), { x: 0, y: 0 }], [ID.addr('X1'), { x: 200, y: 0 }], [ID.addr('X2'), { x: 400, y: 0 }], [ID.addr('X3'), { x: 400, y: 58 }]]);
  const before = JSON.stringify([...pos]);
  const p = TR.plan(g, new Set([ID.addr('B')]), ID.addr('B'), 'next');
  const placed = TR.place(pos, ID.addr('B'), 'next', p, { colGap: 200, rowGap: 58 });
  assert.equal(JSON.stringify([...pos]), before, 'the existing map is untouched');
  const t2 = placed.get(ID.tx('t2'));
  assert.equal(t2.x, 200); assert.notEqual(t2.y, 0, 'the free spot beside the occupied one');
  [ID.addr('E'), ID.addr('F')].forEach((id) => assert.equal(placed.get(id).x, 400));
  const all = [...pos.values(), ...placed.values()];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    assert.ok(!(Math.abs(a.x - b.x) < 90 && Math.abs(a.y - b.y) < 49), `overlap at ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
});

test('place: dozens of vertices never overlap, and ones that already have a place keep it', () => {
  const g = new Graph();
  g.addTx({ txid: 'big', fee: 1, weight: 400, status: { confirmed: true, block_time: 5 }, vin: [{ txid: 'z', vout: 0, prevout: { scriptpubkey_address: 'S', scriptpubkey_type: 'p2pkh', value: 9999 } }],
            vout: Array.from({ length: 40 }, (_, i) => ({ scriptpubkey_address: 'O' + i, scriptpubkey_type: 'p2pkh', value: 100 + i })) });
  const pos = new Map([[ID.tx('big'), { x: 0, y: 0 }], [ID.addr('O7'), { x: 777, y: 777 }]]);
  const p = TR.plan(g, new Set([ID.tx('big')]), ID.tx('big'), 'next', { limit: 40 });
  const placed = TR.place(pos, ID.tx('big'), 'next', p, { colGap: 200, rowGap: 58 });
  assert.ok(!placed.has(ID.addr('O7')), 'O7 was already placed: not placed again');
  const ys = [...placed.values()].map((v) => v.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 58 - 1e-9);
  assert.equal(placed.size, 39);
});

test('descendants and revealed give "hide this branch" something to work with', () => {
  const prov = new Map([['b', { via: 'a', dir: 'next' }], ['c', { via: 'b', dir: 'next' }], ['d', { via: 'a', dir: 'next' }], ['x', { via: 'q', dir: 'prev' }]]);
  assert.deepEqual(TR.descendants(prov, 'a').sort(), ['b', 'c', 'd']);
  assert.deepEqual(TR.descendants(prov, 'b'), ['c']);
  assert.deepEqual(TR.descendants(prov, 'c'), []);
  assert.deepEqual(TR.descendants(prov, 'nobody'), []);
  const g = chain();
  const p = TR.plan(g, new Set([ID.addr('B')]), ID.addr('B'), 'next');
  assert.deepEqual(TR.revealed(p, ID.addr('B'), 'next'), [{ id: ID.tx('t2'), via: ID.addr('B'), dir: 'next' }, { id: ID.addr('E'), via: ID.tx('t2'), dir: 'next' }, { id: ID.addr('F'), via: ID.tx('t2'), dir: 'next' }]);
});

test('a whole forward trace from a real transaction behaves', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t); g.addOutspends(t.txid, fx('outspends_normal.json')); [0, 1].forEach((i) => g.addTx(fx(`tx_spender_${i}.json`)));
  const seed = ID.tx(t.txid), shown = new Set([seed]), pos = new Map([[seed, { x: 0, y: 0 }]]);
  const p1 = TR.plan(g, shown, seed, 'next');
  assert.equal(p1.primary.length, t.vout.length);
  TR.place(pos, seed, 'next', p1).forEach((v, id) => pos.set(id, v));
  p1.primary.forEach((r) => shown.add(r.id));
  g.refreshDerived();
  p1.primary.forEach((r) => {
    const h = TR.hidden(g, shown, r.id, 'next');
    assert.equal(h.known, 1, 'each output wallet is spent once, and that spender is known from the outspends');
  });
  // the larger output is spent in a transaction that pays only wallets already on screen: nothing new to reveal beyond it
  const big = TR.plan(g, shown, p1.primary[0].id, 'next');
  assert.equal(big.primary.length, 1); assert.deepEqual(big.secondary, [], 'both of its outputs are already shown');
  // the smaller one is spent in a transaction that pays a wallet that is not shown yet
  const small = TR.plan(g, shown, p1.primary[1].id, 'next');
  assert.equal(small.primary.length, 1);
  assert.deepEqual(small.needLoad, [], 'the spenders are already loaded in this fixture set');
  assert.ok(small.secondary.length === 1 && small.secondary[0].rows.length >= 1);
});

test('rows lists what is hidden in a direction, largest first, and never what is already shown', () => {
  const g = chain();
  assert.deepEqual(ids(TR.rows(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'next')), [ID.addr('B'), ID.addr('C'), ID.addr('D')]);
  assert.deepEqual(ids(TR.rows(g, new Set([ID.tx('t1'), ID.addr('B')]), ID.tx('t1'), 'next')), [ID.addr('C'), ID.addr('D')]);
  assert.deepEqual(TR.rows(g, new Set(), 'nope', 'next'), []);
});

test('summary puts numbers on what is hidden: how many, the total, the largest and the dates', () => {
  const g = chain();
  const s = TR.summary(g, new Set([ID.tx('t1')]), ID.tx('t1'), 'next');
  assert.deepEqual(s, { count: 3, total: 990, largest: 600, first: 1000, last: 1000 }, 'the wallets a transaction paid carry that transaction\'s time');
  const w = TR.summary(g, new Set([ID.addr('B')]), ID.addr('B'), 'prev');
  assert.deepEqual(w, { count: 1, total: 600, largest: 600, first: 1000, last: 1000 });
  assert.deepEqual(TR.summary(g, new Set([ID.addr('C')]), ID.addr('C'), 'next'), { count: 0, total: 0, largest: 0, first: null, last: null }, 'unspent: nothing behind the arrow');
});

test('summary spans the dates of several transactions and skips unknown times', () => {
  const g = new Graph();
  const mk = (txid, time) => ({ txid, fee: 1, weight: 400, status: time ? { confirmed: true, block_height: 1, block_time: time } : { confirmed: false },
    vin: [{ txid: 'p' + txid, vout: 0, prevout: { scriptpubkey_address: 'W', scriptpubkey_type: 'p2pkh', value: 5000 } }], vout: [{ scriptpubkey_address: 'X' + txid, scriptpubkey_type: 'p2pkh', value: 4000 }] });
  g.addTx(mk('a', 5000)); g.addTx(mk('b', 9000)); g.addTx(mk('c', 0)); g.refreshDerived();
  const s = TR.summary(g, new Set([ID.addr('W')]), ID.addr('W'), 'next');
  assert.equal(s.count, 3); assert.equal(s.total, 15000); assert.equal(s.largest, 5000); assert.equal(s.first, 5000); assert.equal(s.last, 9000);
});

test('rows say whether the output between the two is still unspent (only where that makes sense)', () => {
  const g = chain();
  const one = (id, dir, other) => TR.rows(g, new Set([id]), id, dir).find((r) => r.id === other);
  assert.equal(one(ID.addr('C'), 'prev', ID.tx('t1')).unspent, true, 'C was paid by t1 and has not spent it');
  assert.equal(one(ID.addr('B'), 'prev', ID.tx('t1')).unspent, false, 'B spent what t1 paid it, in t2');
  assert.equal(one(ID.tx('t1'), 'next', ID.addr('C')).unspent, true, 'the same fact seen from the transaction');
  assert.equal(one(ID.tx('t1'), 'next', ID.addr('B')).unspent, false);
  assert.equal(one(ID.addr('B'), 'next', ID.tx('t2')).unspent, null, 'a transaction that spent from the wallet: not about an unspent output');
  assert.equal(one(ID.tx('t1'), 'prev', ID.addr('A')).unspent, null, 'an input');
});

function wallet3() {
  const g = new Graph();
  const mk = (txid, time) => ({ txid, fee: 1, weight: 400, status: time ? { confirmed: true, block_height: 1, block_time: time } : { confirmed: false },
    vin: [{ txid: 'p' + txid, vout: 0, prevout: { scriptpubkey_address: 'W', scriptpubkey_type: 'p2pkh', value: 5000 } }], vout: [{ scriptpubkey_address: 'X' + txid, scriptpubkey_type: 'p2pkh', value: 4000 }] });
  g.addTx(mk('a', 5000)); g.addTx(mk('b', 9000)); g.addTx(mk('c', 0)); g.refreshDerived();
  return g;
}

test('a time window leaves out what falls outside it, keeps what has no time, and says how many it left out', () => {
  const g = wallet3(), W = ID.addr('W'), shown = new Set([W]);
  assert.deepEqual(TR.rows(g, shown, W, 'next').length, 3, 'no window: everything');
  const r = TR.rows(g, shown, W, 'next', { from: 6000, to: null }).map((x) => x.id).sort();
  assert.deepEqual(r, [ID.tx('b'), ID.tx('c')].sort(), 'a was before the window; c is unconfirmed (time unknown) and cannot be ruled out');
  const h = TR.hidden(g, shown, W, 'next', { from: 6000, to: null });
  assert.equal(h.known, 2); assert.equal(h.outside, 1);
  assert.equal(TR.hidden(g, shown, W, 'next', { from: null, to: 5000 }).known, 2, 'to is inclusive: a (5000) and the unknown one');
  assert.equal(TR.hidden(g, shown, W, 'next', { from: 5001, to: 8999 }).known, 1, 'only the unknown one is left');
  const s = TR.summary(g, shown, W, 'next', { from: 6000, to: null });
  assert.equal(s.count, 2); assert.equal(s.total, 10000);
  const p = TR.plan(g, shown, W, 'next', { range: { from: 6000, to: null }, limit: 10 });
  assert.deepEqual(p.primary.map((x) => x.id).sort(), [ID.tx('b'), ID.tx('c')].sort());
  assert.equal(TR.inRange({ time: 5 }, null), true); assert.equal(TR.inRange({ time: null }, { from: 1, to: 2 }), true);
});
