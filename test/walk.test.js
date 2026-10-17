'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/orion-model.js');
const { Client, Explorer } = require('../public/js/orion-api.js');
const An = require('../public/js/orion-analysis.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const addr = (s) => 'bc1q' + s.padEnd(20, 'x');

/** A chain 1 -> 2 -> 3 ... where output 1 of each transaction is spent by the next and output 0 stays unspent. */
function chainRoutes(len, extra) {
  const routes = {};
  for (let i = 1; i <= len; i++) {
    const prev = i === 1 ? { txid: tid(90), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: addr('origin'), scriptpubkey_type: 'v0_p2wpkh', value: 1000000 } }
      : { txid: tid(i - 1), vout: 1, is_coinbase: false, prevout: { scriptpubkey_address: addr('c' + (i - 1)), scriptpubkey_type: 'v0_p2wpkh', value: 1000000 - (i - 1) * 10000 } };
    routes['/tx/' + tid(i)] = { txid: tid(i), fee: 100, weight: 800, status: { confirmed: true, block_height: 700000 + i, block_time: 1650000000 + i * 600 }, vin: [prev],
                                vout: [{ scriptpubkey_address: addr('p' + i), scriptpubkey_type: 'v0_p2wpkh', value: 5000 }, { scriptpubkey_address: addr('c' + i), scriptpubkey_type: 'v0_p2wpkh', value: 1000000 - i * 10000 }] };
    routes['/tx/' + tid(i) + '/outspends'] = [{ spent: false }, i < len ? { spent: true, txid: tid(i + 1), vin: 0, status: { confirmed: true, block_time: 1650000000 + (i + 1) * 600 } } : { spent: false }];
  }
  return Object.assign(routes, extra || {});
}

function fakeFetch(routes) {
  const log = [];
  const f = (url) => {
    const p = url.replace(/^https?:\/\/[^/]+(\/api)?/, '');
    log.push(p);
    const body = routes[p];
    return Promise.resolve(body === undefined
      ? { ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('not found') }
      : { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  f.log = log; return f;
}

function setup(routes, o) {
  const f = fakeFetch(routes), client = new Client(Object.assign({ base: 'https://x/api', delayMs: 0, timeoutMs: 500, retries: 0, backoffMs: 1, fetch: f }, o));
  const g = new Graph();
  return { f, client, g, ex: new Explorer(client, g) };
}
const follow = (g, opts) => (txid) => An.successors(g, ID.tx(txid), opts.dir || 'next', Object.assign({ follow: 'largest' }, opts));

test('walk forward: loads the spenders level by level, outspends for every level but the last', async () => {
  const { f, g, ex, client } = setup(chainRoutes(6));
  await ex.loadTx(tid(1));
  client.resetCount();
  const asked = [];
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 3, successors: (txid, level) => { asked.push([txid, level]); return follow(g, {})(txid); } });
  assert.deepEqual(r.levels, [[tid(1)], [tid(2)], [tid(3)], [tid(4)]]);
  assert.deepEqual(asked, [[tid(1), 0], [tid(2), 1], [tid(3), 2]], 'the last level is loaded but not asked where to go');
  assert.equal(r.loadedNew, 3); assert.equal(r.reason, 'done'); assert.deepEqual(r.stops, []);
  assert.equal(r.requests, 5, 'tx + outspends for 2 levels, only the tx for the last');
  assert.ok(!f.log.includes('/tx/' + tid(4) + '/outspends'));
  assert.ok(g.nodes.get(ID.tx(tid(4))).loaded && !g.nodes.get(ID.tx(tid(4))).outspendsLoaded);
});

test('walk: a start that is not loaded is loaded first, with its outspends when going forward', async () => {
  const { f, g, ex } = setup(chainRoutes(4));
  const r = await ex.walk([tid(2)], { dir: 'next', hops: 1, successors: follow(g, {}) });
  assert.deepEqual(r.levels, [[tid(2)], [tid(3)]]);
  assert.ok(f.log.includes('/tx/' + tid(2) + '/outspends'));
});

test('walk: stops at the transaction cap, keeps what was loaded, and says how many it left', async () => {
  const { g, ex } = setup(chainRoutes(8));
  await ex.loadTx(tid(1));
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 6, maxTx: 2, successors: follow(g, {}) });
  assert.equal(r.loadedNew, 2); assert.equal(r.reason, 'cap-tx'); assert.ok(r.left >= 1); assert.equal(r.truncated, true);
  assert.ok(g.nodes.get(ID.tx(tid(3))).loaded && !g.nodes.get(ID.tx(tid(4))).loaded);
});

test('walk: a hop limit is exact; running out of road ends early without an error', async () => {
  const { g, ex } = setup(chainRoutes(3));
  await ex.loadTx(tid(1));
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 10, successors: follow(g, {}) });
  assert.equal(r.loadedNew, 2, 'only 2 more transactions exist'); assert.equal(r.reason, 'done'); assert.deepEqual(r.errors, []);
  assert.equal(r.levels.length, 3);
});

test('walk: the request cap ends it with the reason, and what was loaded stays', async () => {
  const { g, ex, client } = setup(chainRoutes(8));
  await ex.loadTx(tid(1));
  client.resetCount(); client.maxRequests = 3;
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 6, successors: follow(g, {}) });
  assert.equal(r.reason, 'cap-requests'); assert.ok(r.requests <= 3);
  assert.ok(g.nodes.get(ID.tx(tid(2))).loaded);
  assert.ok(r.errors.some((e) => /request cap/.test(e)));
});

test('walk: cancelling (abort) keeps everything loaded so far and reports it', async () => {
  const { g, ex, client } = setup(chainRoutes(8));
  await ex.loadTx(tid(1));
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 6, successors: (txid, level) => { if (level === 1) client.abort(); return follow(g, {})(txid); } });
  assert.equal(r.reason, 'cancelled'); assert.ok(g.nodes.get(ID.tx(tid(2))).loaded);
  assert.deepEqual(r.errors, [], 'a cancel is not an error');
  client.resume();
});

test('walk: each transaction is asked once even when two paths reach it, and stops are listed', async () => {
  const routes = chainRoutes(4);
  routes['/tx/' + tid(1) + '/outspends'] = [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(2), vin: 0 }];   // two outputs, the same spender (a diamond)
  const { g, ex } = setup(routes);
  await ex.loadTx(tid(1));
  const asked = [];
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 3, successors: (txid, level) => { asked.push(txid); return txid === tid(2) ? { next: [], stop: 'testing' } : { next: [tid(2), tid(2)] }; } });
  assert.deepEqual(asked, [tid(1), tid(2)]);
  assert.deepEqual(r.stops, [{ txid: tid(2), reason: 'testing' }]);
  assert.deepEqual(r.levels, [[tid(1)], [tid(2)]]);
});

test('walk backward follows the funding transactions', async () => {
  const { g, ex } = setup(chainRoutes(5));
  const r = await ex.walk([tid(4)], { dir: 'prev', hops: 2, successors: follow(g, { dir: 'prev' }) });
  assert.deepEqual(r.levels, [[tid(4)], [tid(3)], [tid(2)]]);
  assert.ok(g.nodes.get(ID.tx(tid(2))).loaded);
});

test('walk: failures of single transactions are reported but do not stop the rest', async () => {
  const routes = chainRoutes(4);
  routes['/tx/' + tid(1) + '/outspends'] = [{ spent: true, txid: tid(2), vin: 0 }, { spent: true, txid: tid(77), vin: 0 }];
  const { g, ex } = setup(routes);
  await ex.loadTx(tid(1));
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 2, successors: (txid) => (txid === tid(1) ? { next: [tid(77), tid(2)] } : follow(g, {})(txid)) });
  assert.ok(r.errors.some((e) => /HTTP 404/.test(e)));
  assert.deepEqual(r.levels[1], [tid(2)], 'the one that failed to load is not in the level');
  assert.ok(g.nodes.get(ID.tx(tid(3))).loaded, 'and the walk went on through the other');
});

test('walk with the analysis rules: a peel chain is followed on its large output only', async () => {
  const { g, ex } = setup(chainRoutes(6));
  await ex.loadTx(tid(1));
  const r = await ex.walk([tid(1)], { dir: 'next', hops: 4, successors: follow(g, { follow: 'peel' }) });
  assert.deepEqual(r.levels.map((l) => l.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(r.stops, []);
});

test('every transaction fetched notes where and when it came from', async () => {
  const { g, ex } = setup(chainRoutes(4));
  const before = Math.floor(Date.now() / 1000);
  await ex.loadTx(tid(1));
  await ex.walk([tid(1)], { dir: 'next', hops: 2, successors: follow(g, {}) });
  const after = Math.floor(Date.now() / 1000);
  [1, 2, 3].forEach((i) => {
    const n = g.nodes.get(ID.tx(tid(i)));
    assert.equal(n.source, 'https://x/api', 'the API it was fetched from');
    assert.ok(n.fetchedAt >= before && n.fetchedAt <= after + 1, 'and when (unix seconds)');
  });
  assert.ok(!g.nodes.has(ID.tx(tid(4))) || g.nodes.get(ID.tx(tid(4))).source === undefined, 'a transaction that was never fetched has none');
});
