'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const R = require('../public/js/hopline-route.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const addr = (s) => 'bc1q' + s.padEnd(20, 'x');
const A = (s) => ID.addr(addr(s));
const T = (n) => ID.tx(tid(n));

/** An Esplora transaction. ins: [prev tx number, vout, wallet, value]; outs: [wallet, value]. */
function esplora(n, time, ins, outs) {
  return {
    txid: tid(n), fee: 10, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: time },
    vin: ins.map(([p, v, who, value]) => ({ txid: tid(p), vout: v, is_coinbase: false, prevout: { scriptpubkey_address: addr(who), scriptpubkey_type: 'v0_p2wpkh', value } })),
    vout: outs.map(([who, value]) => ({ scriptpubkey_address: addr(who), scriptpubkey_type: 'v0_p2wpkh', value }))
  };
}
const unspent = (n) => (g, outs) => g.addOutspends(tid(n), Array.from({ length: outs }, () => ({ spent: false })));

/**
 * The case: an exchange wallet (ex) pays a victim wallet (vic), who pays the ransom wallet (ran), which pays on to q1, q2 (named) and q3.
 * Beside it, three things that must not count: a wallet (z) that spent into ran long ago and was paid again years later by k2 (the same address,
 * a different coin), a service wallet (hubw) in the middle of another route, and a consolidation of six wallets (m1 ... m6).
 */
function caseGraph() {
  const g = new Graph();
  g.addTx(esplora(1, 1000, [[90, 0, 'ex', 900]], [['vic', 500], ['ex', 390]]));                       // ex -> vic
  g.addTx(esplora(2, 2000, [[1, 0, 'vic', 500]], [['ran', 490]]));                                    // vic -> ran
  g.addTx(esplora(3, 3000, [[2, 0, 'ran', 490]], [['q1', 300], ['q2', 100], ['q3', 80]]));            // ran -> q1, q2, q3 (outspends never asked)
  g.addTx(esplora(4, 4000, [[3, 0, 'q1', 300]], [['x1', 150], ['x2', 140]]));
  g.addOutspends(tid(4), [{ spent: false }, { spent: true, txid: tid(77), vin: 0, status: { confirmed: true, block_time: 5000 } }]);   // x2 spent by a transaction that is not loaded
  // address reuse: z spent a coin into ran in 2022, and was paid a different coin by k2 in 2026
  g.addTx(esplora(20, 100, [[91, 0, 'src', 200]], [['z', 190]]));
  g.addTx(esplora(21, 200, [[20, 0, 'z', 190]], [['ran', 180]]));
  g.addTx(esplora(22, 9000, [[92, 0, 'k2', 500]], [['z', 490]]));
  // a service wallet in the middle: k3 -> hubw -> ran
  g.addTx(esplora(30, 500, [[93, 0, 'k3', 300]], [['hubw', 290]]));
  g.addTx(esplora(31, 600, [[30, 0, 'hubw', 290]], [['ran', 280]]));
  // six wallets gathered into ran in one transaction
  g.addTx(esplora(40, 700, [[94, 0, 'm1', 1000], [95, 0, 'm2', 1000], [96, 0, 'm3', 1000], [97, 0, 'm4', 1000], [98, 0, 'm5', 1000], [99, 0, 'm6', 1000]], [['ran', 5990]]));
  unspent(22)(g, 1);
  return g;
}
const hub = (id) => id === A('hubw');

test('find: the route is the chain of coins that were spent, wallet and transaction in turn, with its edges', () => {
  const g = caseGraph(), idx = R.index(g), r = R.find(idx, A('ex'), A('ran'));
  assert.deepEqual(r.vertices, [A('ex'), T(1), A('vic'), T(2), A('ran')]);
  assert.deepEqual(r.txs, [T(1), T(2)]);
  assert.equal(r.hops, 2);
  assert.deepEqual(r.edges, [ID.edgeIn(tid(1), 0), ID.edgeOut(tid(1), 0), ID.edgeIn(tid(2), 0), ID.edgeOut(tid(2), 0)], 'the coins in the order they moved');
  assert.ok(r.edges.every((e) => g.edges.has(e)), 'every edge named is in the graph');
  assert.equal(r.first, 1000); assert.equal(r.last, 2000);
  assert.deepEqual(r.steps.map((s) => [s.txid, s.nIn, s.nOut, s.coinIn, s.coinOut]), [[tid(1), 1, 2, 900, 500], [tid(2), 1, 1, 500, 490]]);
  assert.deepEqual(r.viaHub, []);
  assert.deepEqual(r.mixing, []);
});

test('find: it runs with the money only: the other way round there is no route', () => {
  const idx = R.index(caseGraph());
  assert.equal(R.find(idx, A('ran'), A('ex')), null);
  assert.equal(R.find(idx, A('ran'), A('ran')), null);
  assert.ok(R.find(idx, A('ran'), A('q1')), 'forward it is found');
});

test('find: a wallet used again does not join two coins: a route over addresses would have joined k2 to ran, a route over coins does not', () => {
  const g = caseGraph(), idx = R.index(g);
  // over addresses: k2 -> (tx 22) -> z -> (tx 21) -> ran
  const e22 = g.edgesOf(T(22)).some((e) => e.target === A('z')), e21 = g.edgesOf(T(21)).some((e) => e.source === A('z') && e.kind === 'in');
  assert.ok(e22 && e21, 'the trap is in the graph: z is paid by tx 22 and spends in tx 21');
  assert.equal(R.find(idx, A('k2'), A('ran')), null);
  assert.ok(R.find(idx, A('src'), A('ran')), 'the coin z really spent does come from src');
});

test('find: a transaction can be either end, and the first transaction counts as one hop', () => {
  const idx = R.index(caseGraph());
  const r = R.find(idx, T(1), T(3));
  assert.deepEqual(r.vertices, [T(1), A('vic'), T(2), A('ran'), T(3)]);
  assert.equal(r.hops, 3);
  assert.deepEqual(R.find(idx, A('vic'), T(2)).vertices, [A('vic'), T(2)]);
});

test('find: it is not carried across a service wallet unless there is no other way, and then it says so', () => {
  const idx = R.index(caseGraph());
  assert.deepEqual(R.find(idx, A('k3'), A('ran')).vertices, [A('k3'), T(30), A('hubw'), T(31), A('ran')], 'without a service list nothing is avoided');
  const r = R.find(idx, A('k3'), A('ran'), { hub });
  assert.deepEqual(r.viaHub, [A('hubw')]);
  assert.equal(R.find(idx, A('k3'), A('hubw'), { hub }).hops, 1, 'a service wallet may be where a route ends');
  assert.equal(R.find(idx, A('hubw'), A('ran'), { hub }).hops, 1, 'or where it starts');
});

test('find: a transaction that merges many inputs is named on the route', () => {
  const r = R.find(R.index(caseGraph()), A('m1'), A('ran'));
  assert.equal(r.hops, 1);
  assert.equal(r.steps[0].merges, true);
  assert.deepEqual(r.steps[0].flags, ['consolidation']);
  assert.equal(r.mixing.length, 1);
  assert.equal(r.steps[0].coinIn, 1000, 'the coin of the route, not the sum of the inputs');
});

test('find: a limit on the number of transactions is kept', () => {
  const idx = R.index(caseGraph());
  assert.equal(R.find(idx, A('ex'), A('ran'), { max: 1 }), null);
  assert.ok(R.find(idx, A('ex'), A('ran'), { max: 2 }));
});

test('relations: upstream, downstream, none and the reference itself, with the number of transactions', () => {
  const idx = R.index(caseGraph());
  const rel = R.relations(idx, A('ran'), [A('ex'), A('vic'), A('q1'), A('x2'), A('k2'), A('ran'), A('nobody')], { hub });
  assert.deepEqual([rel.get(A('ex')).up.hops, rel.get(A('ex')).down], [2, null]);
  assert.deepEqual([rel.get(A('vic')).up.hops, rel.get(A('vic')).down], [1, null]);
  assert.deepEqual([rel.get(A('q1')).down.hops, rel.get(A('q1')).up], [1, null]);
  assert.equal(rel.get(A('x2')).down.hops, 2);
  assert.deepEqual([rel.get(A('k2')).up, rel.get(A('k2')).down], [null, null], 'a wallet that only shares an address with the flow is not related');
  assert.equal(rel.get(A('ran')).same, true);
  assert.deepEqual([rel.get(A('nobody')).up, rel.get(A('nobody')).down], [null, null]);
});

test('relations: across a service wallet it is marked, and the service wallet itself is reached at the end', () => {
  const idx = R.index(caseGraph());
  const rel = R.relations(idx, A('ran'), [A('k3'), A('hubw')], { hub });
  assert.deepEqual([rel.get(A('k3')).up.hops, rel.get(A('k3')).up.viaHub], [2, true]);
  assert.deepEqual([rel.get(A('hubw')).up.hops, rel.get(A('hubw')).up.viaHub], [1, false]);
  const plain = R.relations(idx, A('ran'), [A('k3')]);
  assert.equal(plain.get(A('k3')).up.viaHub, false, 'with no service list nothing is a service');
});

test('relations: a transaction can be a target, and is on the way when the money passed through it', () => {
  const rel = R.relations(R.index(caseGraph()), A('ran'), [T(1), T(2), T(3), T(4), T(21), T(22)], {});
  assert.deepEqual([rel.get(T(1)).up.hops, rel.get(T(1)).down], [2, null], 'tx 1 is two transactions before ran');
  assert.deepEqual([rel.get(T(2)).up.hops, rel.get(T(2)).down], [1, null]);
  assert.deepEqual([rel.get(T(3)).down.hops, rel.get(T(3)).up], [1, null]);
  assert.equal(rel.get(T(4)).down.hops, 2);
  assert.equal(rel.get(T(21)).up.hops, 1, 'tx 21 paid ran too');
  assert.deepEqual([rel.get(T(22)).up, rel.get(T(22)).down], [null, null], 'tx 22 only paid an address ran once shared');
});

test('relations: from a transaction as the reference', () => {
  const rel = R.relations(R.index(caseGraph()), T(2), [A('vic'), A('ex'), A('q3')]);
  assert.equal(rel.get(A('vic')).up.hops, 1);
  assert.equal(rel.get(A('ex')).up.hops, 2);
  assert.equal(rel.get(A('q3')).down.hops, 2, 'tx 2 pays ran, ran pays q3 in tx 3');
});

test('openEnds forward: where it is still open, where it stopped, and what sits unspent', () => {
  const idx = R.index(caseGraph());
  const stop = (id) => (id === A('q2') ? 'Exchange X' : null);
  const o = R.openEnds(idx, A('ran'), 'next', { stop });
  assert.equal(o.dir, 'next');
  assert.deepEqual(o.ends.map((e) => [e.kind, e.address, e.amount, e.depth]), [['unchecked', addr('q3'), 80, 1], ['spent', null, null, 3]]);
  assert.equal(o.ends[0].next, tid(3), 'to follow it, tx 3 is the one to ask about');
  assert.equal(o.ends[1].next, tid(77), 'and the spender that is not loaded is the one to load');
  assert.deepEqual(o.named.map((n) => [n.label, n.amount, n.txid]), [['Exchange X', 100, tid(3)]]);
  assert.deepEqual(o.resting, { count: 1, sats: 150 });
  assert.equal(o.reached.txs, 2);
});

test('openEnds forward: without names the named wallet is an open end like the others', () => {
  const o = R.openEnds(R.index(caseGraph()), A('ran'), 'next', {});
  assert.deepEqual(o.ends.map((e) => e.amount), [100, 80, null]);
  assert.deepEqual(o.named, []);
});

test('openEnds backward: the funding transactions that are not loaded, a named wallet, and coinbase', () => {
  const g = caseGraph();
  g.addTx({ txid: tid(50), fee: 0, weight: 800, status: { confirmed: true, block_height: 1, block_time: 50 }, vin: [{ is_coinbase: true, vout: 0 }], vout: [{ scriptpubkey_address: addr('miner'), scriptpubkey_type: 'v0_p2wpkh', value: 5000 }] });
  const idx = R.index(g);
  const o = R.openEnds(idx, A('vic'), 'prev', {});
  assert.deepEqual(o.ends.map((e) => [e.kind, e.address, e.amount, e.next]), [['funder', addr('ex'), 900, tid(90)]]);
  assert.deepEqual(R.openEnds(idx, A('vic'), 'prev', { stop: (id) => (id === A('ex') ? 'Exchange' : null) }).ends, []);
  assert.equal(R.openEnds(idx, A('miner'), 'prev', {}).reached.coinbase, 1);
  const two = R.openEnds(idx, A('ran'), 'prev', {});
  assert.ok(two.ends.length >= 8, 'several branches are open behind ran: ' + two.ends.length);
});

test('openEnds: a transaction or several references can start it, and a limit on depth is kept', () => {
  const idx = R.index(caseGraph());
  assert.equal(R.openEnds(idx, T(3), 'next', {}).ends.length, R.openEnds(idx, A('ran'), 'next', {}).ends.length);
  assert.equal(R.openEnds(idx, [A('ran'), A('vic')], 'next', {}).reached.txs, 3, 'vic spends in tx 2, which leads to ran and on to tx 3 and 4');
  assert.equal(R.openEnds(idx, A('ran'), 'next', { max: 1 }).reached.txs, 1);
});

test('the index copes with a graph that has outspends but not every transaction, and with nothing at all', () => {
  const g = new Graph();
  assert.equal(R.find(R.index(g), A('a'), A('b')), null);
  assert.deepEqual(R.openEnds(R.index(g), A('a'), 'next', {}).ends, []);
  g.addTx(esplora(1, 10, [[90, 0, 'a', 100]], [['b', 90]]));
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0, status: { confirmed: true, block_time: 20 } }]);
  const idx = R.index(g);
  assert.equal(R.find(idx, A('a'), A('b')).hops, 1);
  assert.equal(R.find(idx, A('a'), T(2)).hops, 2, 'the spender is known to exist even though it is not loaded');
});

// ---- names, service wallets, the reference ----------------------------------------------------------------
test('isHub: a service on a list or tagged as one is a hub; a ransomware or sanctions entry is not', () => {
  const g = caseGraph(), list = { [addr('ex')]: { label: 'Exchange' }, [addr('q1')]: { label: 'Ransomware: Family' }, [addr('q2')]: { label: 'Listed', sanctions: true } };
  const known = (a) => list[a] || null;
  assert.equal(R.isHub(g, known, A('ex')), true);
  assert.equal(R.isHub(g, known, A('q1')), false, 'a ransomware address is not a service');
  assert.equal(R.isHub(g, known, A('q2')), false, 'nor is a sanctions entry');
  g.nodes.get(A('vic')).tag = 'MIXER';
  assert.equal(R.isHub(g, known, A('vic')), true, 'a tag you set says it is a service');
  g.nodes.get(A('ran')).tag = 'THREAT';
  assert.equal(R.isHub(g, known, A('ran')), false);
  assert.equal(R.isHub(g, null, A('ex')), false, 'without a list nothing is known');
  assert.equal(R.isHub(g, known, T(1)), false);
});

test('nameOf: your label, then your tag, then the name on a list', () => {
  const g = caseGraph(), known = (a) => (a === addr('ex') ? { label: 'Exchange' } : null);
  assert.equal(R.nameOf(g, known, A('ex')), 'Exchange');
  g.nodes.get(A('ex')).tag = 'EXCH';
  assert.equal(R.nameOf(g, known, A('ex')), 'EXCH');
  g.nodes.get(A('ex')).label = 'Mine';
  assert.equal(R.nameOf(g, known, A('ex')), 'Mine');
  assert.equal(R.nameOf(g, known, A('vic')), null);
});

test('referenceOf: the one picked, else the first starting point, else a THREAT wallet, else the one selected vertex', () => {
  const g = caseGraph();
  assert.equal(R.referenceOf(g, { routeRef: A('vic'), trace: { seeds: [A('ran')] } }, [A('ex')]), A('vic'));
  assert.equal(R.referenceOf(g, { routeRef: 'addr:gone', trace: { seeds: ['addr:gone', A('ran')] } }, []), A('ran'), 'an id that is not in the graph is skipped');
  g.nodes.get(A('q3')).tag = 'THREAT';
  assert.equal(R.referenceOf(g, {}, []), A('q3'));
  g.nodes.get(A('q3')).tag = '';
  assert.equal(R.referenceOf(g, null, [A('ex')]), A('ex'));
  assert.equal(R.referenceOf(g, null, [A('ex'), A('vic')]), null, 'two selected is no choice');
  assert.equal(R.referenceOf(g, null, []), null);
});

// ---- hand-offs ----------------------------------------------------------------------------------------------
const services = (id) => [A('ex'), A('hubw'), A('q2')].indexOf(id) >= 0;
const svcName = (id) => (services(id) ? 'Service ' + id.slice(9, 12) : null);

test('handoffs: where money from the reference went into a service, and where a service\'s money came in, oldest first', () => {
  const rows = R.handoffs(R.index(caseGraph()), A('ran'), { hub: services, stop: svcName });
  const which = (r) => (r.txid === tid(31) ? 31 : r.txid === tid(1) ? 1 : r.txid === tid(3) ? 3 : 0);
  assert.deepEqual(rows.map((r) => [r.dir, which(r), r.amount]), [['withdrawal', 31, 290], ['withdrawal', 1, 900], ['deposit', 3, 100]]);
  const w = rows.find((r) => r.txid === tid(1)), d = rows.find((r) => r.dir === 'deposit');
  assert.deepEqual([w.service, w.wallet, w.walletAddress, w.depth], ['Service exx', A('vic'), addr('vic'), 2], 'after the withdrawal the coin sat at the victim wallet');
  assert.deepEqual([d.wallet, d.address, d.depth, d.time], [A('ran'), addr('q2'), 1, 3000], 'a deposit: the wallet before it is the one that spent');
  assert.equal(rows.find((r) => r.txid === tid(31)).wallet, A('ran'), 'a service that paid the reference directly');
});

test('handoffs: only services (a named wallet that is not a service is left out), and outputs to one service in one transaction are one row', () => {
  const g = new Graph();
  g.addTx(esplora(1, 100, [[90, 0, 'src', 1000]], [['svc', 100], ['svc2', 50], ['other', 800]]));
  const stop = (id) => (id === A('svc') || id === A('other') ? 'Name ' + id.slice(9, 12) : null);
  const rows = R.handoffs(R.index(g), A('src'), { hub: (id) => id === A('svc'), stop });
  assert.deepEqual(rows.map((r) => [r.dir, r.amount, r.outputs, r.merges]), [['deposit', 100, 1, false]]);
  g.addTx(esplora(2, 200, [[91, 0, 'src', 500]], [['svc', 40], ['svc', 60]]));
  const two = R.handoffs(R.index(g), A('src'), { hub: (id) => id === A('svc'), stop });
  assert.deepEqual(two.filter((r) => r.txid === tid(2)).map((r) => [r.amount, r.outputs]), [[100, 2]]);
  assert.deepEqual(R.handoffs(R.index(g), A('src'), { hub: () => false, stop }), [], 'with no service nothing is a hand-off');
});

test('openEnds: a named wallet reports the time, the transaction\'s size and the wallet next to it', () => {
  const o = R.openEnds(R.index(caseGraph()), A('ran'), 'next', { stop: (id) => (id === A('q2') ? 'X' : null) });
  const n = o.named[0];
  assert.deepEqual([n.label, n.time, n.nIn, n.nOut, n.wallet], ['X', 3000, 1, 3, A('ran')]);
});

// ---- following open ends, and searching from both ends ---------------------------------------------------------
test('endsSuccessors: the first level goes only along the outputs that were open; later levels are the rule as it is', () => {
  const g = new Graph();
  g.addTx(esplora(1, 100, [[90, 0, 'src', 1000]], [['a', 400], ['b', 300], ['c', 200]]));
  g.addTx(esplora(2, 200, [[1, 0, 'a', 400]], [['x', 390]]));
  g.addTx(esplora(3, 300, [[1, 1, 'b', 300]], [['y', 290]]));
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(3), vin: 0 }, { spent: false }]);
  const ends = [{ next: tid(1), edgeId: ID.edgeOut(tid(1), 1) }];
  const f = R.endsSuccessors(g, ends, 'next', { follow: 'all', perTx: 6 });
  assert.deepEqual(f(tid(1), 0).next, [tid(3)], 'only the open output (to b) is followed, not a');
  assert.deepEqual(f(tid(1), 1).next.slice().sort(), [tid(2), tid(3)].sort(), 'from the second level on nothing is held back');
  assert.deepEqual(R.endsSuccessors(g, [], 'next', { follow: 'all' })(tid(1), 0).next.slice().sort(), [tid(2), tid(3)].sort(), 'with no open end named nothing is filtered');
});

test('pickEnds: the largest first, at most the width, and a spender that is not loaded only once', () => {
  const ends = [{ next: 'a', amount: 5, edgeId: 'e1' }, { next: 'b', amount: 50, edgeId: 'e2' }, { next: 'c', amount: 20, edgeId: 'e3' }, { next: 'd', amount: null, edgeId: null }, { next: 'd', amount: null, edgeId: null }];
  assert.deepEqual(R.pickEnds(ends, 3).map((e) => e.next), ['b', 'c', 'a']);
  assert.deepEqual(R.pickEnds(ends, 10).map((e) => e.next), ['b', 'c', 'a', 'd']);
});

const { Client, Explorer } = require('../public/js/hopline-api.js');

/** Transactions 1..n in a chain: tx i pays a small amount out and passes the rest to tx i+1; the first spends `src`, the last pays `dst` with an output nobody spends. */
function chain(n) {
  const routes = {};
  for (let i = 1; i <= n; i++) {
    const prev = i === 1 ? { txid: tid(90), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: addr('src'), scriptpubkey_type: 'v0_p2wpkh', value: 10000 } }
      : { txid: tid(i - 1), vout: 1, is_coinbase: false, prevout: { scriptpubkey_address: addr('c' + (i - 1)), scriptpubkey_type: 'v0_p2wpkh', value: 10000 - (i - 1) * 100 } };
    routes['/tx/' + tid(i)] = { txid: tid(i), fee: 10, weight: 800, status: { confirmed: true, block_height: 700000 + i, block_time: 1650000000 + i * 600 }, vin: [prev],
      vout: [{ scriptpubkey_address: addr('p' + i), scriptpubkey_type: 'v0_p2wpkh', value: 50 }, { scriptpubkey_address: i === n ? addr('dst') : addr('c' + i), scriptpubkey_type: 'v0_p2wpkh', value: 10000 - i * 100 }] };
    routes['/tx/' + tid(i) + '/outspends'] = [{ spent: false }, i < n ? { spent: true, txid: tid(i + 1), vin: 0, status: { confirmed: true, block_time: 1650000000 + (i + 1) * 600 } } : { spent: false }];
  }
  return routes;
}
function fetcher(routes) {
  const f = (url) => {
    const body = routes[url.replace(/^https?:\/\/[^/]+(\/api)?/, '')];
    return Promise.resolve(body === undefined ? { ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('not found') }
      : { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  return f;
}
function explorer(routes) {
  const client = new Client({ base: 'https://x/api', delayMs: 0, timeoutMs: 500, retries: 0, backoffMs: 1, fetch: fetcher(routes) }), g = new Graph();
  return { g, client, ex: new Explorer(client, g) };
}

test('connect: loads from both ends until the two meet, and says what it cost', async () => {
  const { g, ex } = explorer(chain(8));
  await ex.loadTx(tid(1)); await ex.loadTx(tid(8));                                  // the two ends are loaded, with nothing between them
  assert.equal(R.find(R.index(g), A('src'), A('dst')), null);
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 8, width: 4 });
  assert.equal(r.reason, 'found');
  assert.equal(r.route.hops, 8);
  assert.equal(r.route.vertices[0], A('src')); assert.equal(r.route.vertices[r.route.vertices.length - 1], A('dst'));
  assert.ok(r.loaded >= 6 && r.requests >= 6 && r.rounds >= 2 && r.rounds <= 4, JSON.stringify(r));
});

test('connect: one step from each end per round, so ten transactions apart it meets in few rounds', async () => {
  const { g, ex } = explorer(chain(10));
  await ex.loadTx(tid(1)); await ex.loadTx(tid(10));
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 8 });
  assert.equal(r.reason, 'found');
  assert.ok(r.rounds <= 4, 'rounds: ' + r.rounds);
});

test('connect: a route that is already loaded is returned at once, with nothing loaded', async () => {
  const { g, ex, client } = explorer(chain(3));
  for (const i of [1, 2, 3]) await ex.loadTx(tid(i));
  client.resetCount();
  const r = await R.connect(ex, g, A('src'), A('dst'), {});
  assert.deepEqual([r.reason, r.rounds, r.loaded, r.requests, r.route.hops], ['found', 0, 0, 0, 3]);
});

test('connect: stops at the round limit, and says how many branches are still open on each side', async () => {
  const { g, ex } = explorer(chain(12));
  await ex.loadTx(tid(1)); await ex.loadTx(tid(12));
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 1 });
  assert.equal(r.reason, 'rounds'); assert.equal(r.route, null); assert.equal(r.rounds, 1);
  assert.ok(r.open.next >= 1 && r.open.prev >= 1, JSON.stringify(r.open));
});

test('connect: stops at the request limit and keeps what it loaded', async () => {
  const { g, ex, client } = explorer(chain(10));
  await ex.loadTx(tid(1)); await ex.loadTx(tid(10));
  client.resetCount(); client.maxRequests = 3;
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 8 });
  assert.equal(r.reason, 'cap-requests'); assert.equal(r.route, null);
  assert.ok(g.nodes.has(ID.tx(tid(2))) && g.nodes.get(ID.tx(tid(2))).loaded, 'what it got before the limit is kept');
});

test('connect: stops when nothing is left to load on either side (the two are not connected)', async () => {
  const { g, ex } = explorer(chain(3));
  await ex.loadTx(tid(1));
  const r = await R.connect(ex, g, A('src'), A('nobody'), { rounds: 8 });
  assert.equal(r.reason, 'exhausted', JSON.stringify(r)); assert.equal(r.route, null);
  assert.ok(g.nodes.get(ID.tx(tid(3))).loaded, 'it followed the only road to its end first');
});

test('connect: a named wallet ends a branch, and a route across a service wallet is marked as such', async () => {
  const { g, ex } = explorer(chain(6));
  await ex.loadTx(tid(1)); await ex.loadTx(tid(6));
  const name = (id) => (id === A('c3') ? 'Service' : null);
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 8, stop: name, hub: (id) => id === A('c3') });
  assert.equal(r.reason, 'found');
  assert.deepEqual(r.route.viaHub, [A('c3')], 'the coin passes through c3, a service wallet: the route says so');
  const plain = explorer(chain(6));
  await plain.ex.loadTx(tid(1)); await plain.ex.loadTx(tid(6));
  assert.equal((await R.connect(plain.ex, plain.g, A('src'), A('dst'), { rounds: 8, stop: name })).route.viaHub.length, 0, 'a name alone does not mark a route: only a service does');
});

test('trace: the reference, the hand-offs and how each side of the trail ends, as plain data', () => {
  const t = R.trace(R.index(caseGraph()), A('ran'), { hub: services, name: svcName, stop: svcName });
  assert.equal(t.reference, A('ran'));
  assert.equal(t.handoffs.length, 3);
  assert.deepEqual([t.openEnds.next.count, t.openEnds.next.unchecked, t.openEnds.next.notLoaded, t.openEnds.next.resting], [2, 1, 1, { count: 1, sats: 150 }]);
  assert.deepEqual(t.openEnds.next.named, [{ label: 'Service q2x', count: 1, sats: 100 }]);
  assert.deepEqual(t.openEnds.next.rows.map((r) => [r.kind, r.amount, r.depth]), [['unchecked', 80, 1], ['spent', null, 3]]);
  assert.ok(t.openEnds.prev.count >= 1);
  assert.equal(JSON.parse(JSON.stringify(t)).handoffs.length, 3, 'plain data: it survives JSON');
});

test('trace: with `has`, only what is shown comes in, so a report cannot say more than the screen did', () => {
  const idx = R.index(caseGraph());
  const hidden = new Set([T(3), A('q3'), A('vic')]);
  const has = (id) => !hidden.has(id);
  const t = R.trace(idx, A('ran'), { hub: services, name: svcName, stop: svcName, has });
  assert.deepEqual(t.handoffs.map((r) => r.dir + ':' + r.txid.slice(0, 2)), ['withdrawal:1f', 'withdrawal:01'], 'the deposit was in the hidden transaction 3');
  assert.equal(t.handoffs.find((r) => r.txid === tid(1)).walletAddress, null, 'and the victim wallet, which is hidden, is not named');
  assert.equal(t.openEnds.next.rows.some((r) => r.address === addr('q3')), false);
  assert.equal(t.openEnds.next.resting, null, 'a count that cannot be cut to the screen is left out');
  assert.deepEqual(t.openEnds.next.named, []);
});

test('connect: a round that changes nothing stops the search as stalled, with what could not be fetched', async () => {
  const routes = chain(5);
  delete routes['/tx/' + tid(3)]; delete routes['/tx/' + tid(2) + '/outspends'];                              // the data source cannot return transaction 3, nor say who spent the outputs of 2
  const { g, ex } = explorer(routes);
  await ex.loadTx(tid(1)); await ex.loadTx(tid(5));
  const r = await R.connect(ex, g, A('src'), A('dst'), { rounds: 8 });
  assert.equal(r.reason, 'stalled', JSON.stringify(r));
  assert.ok(r.rounds < 8, 'it did not go on asking: ' + r.rounds);
  assert.ok(r.errors.length >= 1 && r.errors.length <= 5, JSON.stringify(r.errors));
  assert.ok(g.nodes.get(ID.tx(tid(2))).loaded && g.nodes.get(ID.tx(tid(4))).loaded, 'what it could load it did');
});

test('handoffs: wallets you tagged or a list names that are not services do not end the trail, so a service behind them is still found', () => {
  const stop = (id) => (id === A('vic') ? 'VICTIM' : id === A('ran') ? 'THREAT' : svcName(id));            // a tag on the victim wallet, and a name on the reference itself
  const rows = R.handoffs(R.index(caseGraph()), A('ran'), { hub: services, stop });
  const w = rows.find((r) => r.txid === tid(1));
  assert.ok(w, 'the exchange behind the tagged victim wallet is found: ' + JSON.stringify(rows.map((r) => r.txid.slice(0, 2))));
  assert.deepEqual([w.dir, w.wallet, w.depth], ['withdrawal', A('vic'), 2], 'and the victim wallet, which was walked through, is the wallet after it');
  assert.deepEqual(R.handoffs(R.index(caseGraph()), A('ran'), { stop }), [], 'without a way to tell a service there is no hand-off');
});

/** svc2 -> lstb -> ref -> lst -> svc: two services, and a wallet a list names on each side of the reference. */
function namedGraph() {
  const g = new Graph(), st = (t) => ({ confirmed: true, block_time: t });
  g.addTx(esplora(11, 100, [[90, 0, 'svc2', 700]], [['lstb', 600]]));
  g.addTx(esplora(12, 200, [[11, 0, 'lstb', 600]], [['ref', 590]]));
  g.addTx(esplora(13, 300, [[12, 0, 'ref', 590]], [['lst', 400], ['chg', 180]]));
  g.addTx(esplora(14, 400, [[13, 0, 'lst', 400]], [['svc', 390]]));
  g.addOutspends(tid(11), [{ spent: true, txid: tid(12), vin: 0, status: st(200) }]);
  g.addOutspends(tid(12), [{ spent: true, txid: tid(13), vin: 0, status: st(300) }]);
  g.addOutspends(tid(13), [{ spent: true, txid: tid(14), vin: 0, status: st(400) }, { spent: false }]);
  g.addOutspends(tid(14), [{ spent: false }]);
  return g;
}
const isService = (id) => id === A('svc') || id === A('svc2');
const namedBy = (id) => (isService(id) ? 'Exchange' : id === A('lst') ? 'Listed ahead' : id === A('lstb') ? 'Listed behind' : null);
const listedBy = (id) => (id === A('lst') ? 'Listed ahead' : id === A('lstb') ? 'Listed behind' : null);

test('handoffs: a wallet a list names that is not a service is a row of its own, and the trail goes on through it', () => {
  const idx = R.index(namedGraph());
  const rows = R.handoffs(idx, A('ref'), { hub: isService, stop: namedBy, listed: listedBy });
  assert.deepEqual(rows.map((r) => [r.kind, r.dir, r.service, r.txid]), [
    ['service', 'withdrawal', 'Exchange', tid(11)], ['named', 'withdrawal', 'Listed behind', tid(12)], ['named', 'deposit', 'Listed ahead', tid(13)], ['service', 'deposit', 'Exchange', tid(14)]],
    'oldest first, and the services behind and beyond the listed wallets are still found');
  const ahead = rows[2];
  assert.deepEqual([ahead.address, ahead.amount, ahead.wallet, ahead.depth], [addr('lst'), 400, A('ref'), 1], 'the listed wallet is the one the coin was paid to, and the wallet before it is the reference');
  assert.equal(rows[1].amount, 600); assert.equal(rows[1].wallet, A('ref'), 'going back, the wallet after the transaction is on its way to the reference');
});

test('handoffs: without `listed` only the services are rows, as before', () => {
  const rows = R.handoffs(R.index(namedGraph()), A('ref'), { hub: isService, stop: namedBy });
  assert.deepEqual(rows.map((r) => [r.kind, r.service, r.txid]), [['service', 'Exchange', tid(11)], ['service', 'Exchange', tid(14)]]);
});

test('handoffs: your own labels and tags are not rows, only names from lists', () => {
  const rows = R.handoffs(R.index(namedGraph()), A('ref'), { hub: isService, stop: (id) => (isService(id) ? 'Exchange' : id === A('lst') ? 'VICTIM' : null), listed: () => null });
  assert.deepEqual(rows.map((r) => r.kind), ['service', 'service'], 'a wallet you tagged is walked through and says nothing');
});

test('handoffs: the reference itself is never a row, even when it is named and gets change back', () => {
  const g = new Graph();
  g.addTx(esplora(13, 300, [[12, 0, 'ref', 590]], [['lst', 400], ['ref', 180]]));                // the change goes back to the reference's own address
  g.addOutspends(tid(13), [{ spent: false }, { spent: false }]);
  const rows = R.handoffs(R.index(g), A('ref'), { hub: isService, stop: namedBy, listed: (id) => (id === A('ref') ? 'The reference' : listedBy(id)) });
  assert.deepEqual(rows.map((r) => r.service), ['Listed ahead'], 'only the other wallet: ' + JSON.stringify(rows.map((r) => r.service)));
});

test('trace: the hand-offs carry their kind, the open ends are not changed by them, and `has` cuts the named ones too', () => {
  const idx = R.index(namedGraph()), opts = { hub: isService, name: namedBy, listed: listedBy, stop: namedBy };
  const t = R.trace(idx, A('ref'), opts);
  assert.deepEqual(t.handoffs.map((r) => r.kind), ['service', 'named', 'named', 'service']);
  assert.deepEqual(t.openEnds.next.named.map((n) => n.label), ['Listed ahead'], 'the open ends still stop at the first named wallet, and count it once');
  const off = R.trace(idx, A('ref'), Object.assign({ has: (id) => id !== A('lst') }, opts));
  assert.deepEqual(off.handoffs.map((r) => r.service), ['Exchange', 'Listed behind', 'Exchange'], 'a listed wallet that is not on screen is not reported');
});

test('listedName: the name a list gives a wallet that is not a service', () => {
  const g = namedGraph();
  const list = { [addr('lst')]: { label: 'Ransomware: Acme' }, [addr('svc')]: { label: 'Binance' }, [addr('lstb')]: { label: 'SDN entry', sanctions: true }, [addr('chg')]: { label: 'Ransomware: Beta' } };
  const known = (a) => list[a] || null;
  assert.equal(R.listedName(g, known, A('lst')), 'Ransomware: Acme');
  assert.equal(R.listedName(g, known, A('lstb')), 'SDN entry', 'a sanctions entry is not a service');
  assert.equal(R.listedName(g, known, A('svc')), null, 'an exchange is a service');
  g.nodes.get(A('chg')).tag = 'EXCH';
  assert.equal(R.listedName(g, known, A('chg')), null, 'a wallet you tagged as an exchange is a service whatever the list says');
  assert.equal(R.listedName(g, known, A('ref')), null, 'no entry');
  assert.equal(R.listedName(g, known, T(11)), null, 'a transaction has no name');
  assert.equal(R.listedName(g, null, A('lst')), null, 'no list');
});

// ---- what is loaded but not on screen ----------------------------------------------------------------------
test('offscreen: how much is loaded that the canvas does not show, and what the findings hold among it', () => {
  const g = caseGraph(), an = require('../public/js/hopline-analysis.js').analyse(g, {});
  const list = { [addr('ex')]: { label: 'Exchange' }, [addr('q2')]: { label: 'Listed', sanctions: true } }, known = (a) => list[a] || null;
  const everything = new Set(g.nodes.keys()), none = R.offscreen(g, everything, an, known);
  assert.deepEqual([none.total, none.shown, none.left], [g.nodes.size, g.nodes.size, 0]);
  assert.deepEqual(none.known, [], 'nothing is left out when everything is on screen');
  const shown = new Set([A('ran'), T(2), T(3), A('q1'), 'group:not-in-the-graph']);                 // a trace shows a few vertices (and may carry a group vertex)
  const r = R.offscreen(g, shown, an, known);
  assert.equal(r.shown, 4, 'a group vertex is not in the graph and is not counted');
  assert.equal(r.left, g.nodes.size - 4);
  assert.equal(r.transactions + r.wallets + r.other, r.left);
  assert.ok(r.transactions > 0 && r.wallets > 0);
  assert.deepEqual(r.known.slice().sort(), [A('ex'), A('q2')].sort(), 'both named wallets are off screen');
  assert.equal(r.sanctions, 1);
  assert.equal(r.patterns.consolidation, 1, 'the consolidation (tx 40) is not on screen');
  assert.ok(r.clusters >= 1, 'its six wallets form a cluster that is not on screen');
  const withEx = R.offscreen(g, new Set([A('ex'), A('q2')]), an, known);
  assert.deepEqual(withEx.known, [], 'a named wallet that is on screen is not counted');
  assert.equal(R.offscreen(g, everything, null, null).left, 0, 'works without an analysis or a list');
  assert.deepEqual(R.offscreen(g, new Set(), null, null).patterns, {});
});
