'use strict';
/*
 * Live check of the backup-server logic against the real mempool.space and Blockstream.info.
 * It is OFF by default because it uses the network (about 30 requests):
 *
 *     HOPLINE_LIVE=1 node --test "test/live/*.test.js"
 *
 * A server's failure is made up (a wrapper around fetch answers 429, or refuses the connection); everything the working server
 * says is real. The test then asks: did the graph that comes out match the one from a normal run? So it also compares what the
 * two servers say about the same transaction and address.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Graph } = require('../../public/js/hopline-model.js');
const A = require('../../public/js/hopline-api.js');

const LIVE = process.env.HOPLINE_LIVE === '1';
const TX = '0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d';
const ADDR = 'bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq';
const MEMPOOL = A.PRESETS.clearnet.base, BLOCKSTREAM = A.PRESETS.blockstream.base;
const cfg = { delayMs: 150, timeoutMs: 25000, retries: 2, backoffMs: 300 };
const opts = { skip: LIVE ? false : 'live test: set HOPLINE_LIVE=1 to run it', timeout: 180000 };

const host = (u) => new URL(u).host;
const plain = (url, init) => fetch(url, init);
/** a fetch where requests to `base` get `fail(url)`'s answer (a Response, or a rejection) and everything else goes to the network */
const broken = (base, fail) => (url, init) => (url.startsWith(base) ? fail(url) : fetch(url, init));
const throttle = (url) => Promise.resolve(new Response('slow down', { status: 429 }));
const refuse = (url) => Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));

async function trace(client) {
  const g = new Graph(), ex = new A.Explorer(client, g), errors = [];
  errors.push(...(await ex.loadTx(TX)).errors);
  errors.push(...(await ex.expandAddress(ADDR, { pages: 2, cap: 60 })).errors);
  g.refreshDerived();
  const nodes = [...g.nodes.values()], edges = [...g.edges.values()];
  return {
    errors, nodes: g.nodes.size, edges: g.edges.size, client,
    txs: nodes.filter((n) => n.type === 'tx' && n.loaded).map((n) => [n.txid.slice(0, 8), n.time, n.valueOut, n.nIn, n.nOut, n.fee, n.confirmed].join()).sort(),
    spent: edges.filter((e) => e.kind === 'out').map((e) => e.id.slice(4, 12) + e.id.slice(-2) + ':' + e.spent).sort(),
    sources: [...new Set(nodes.filter((n) => n.source).map((n) => host(n.source)))],
  };
}
const facts = (r) => ({ nodes: r.nodes, edges: r.edges, txs: r.txs, spent: r.spent });

test('the two servers tell the same story about a transaction and an address', opts, async () => {
  const m = await trace(new A.Client(Object.assign({ base: MEMPOOL, fetch: plain }, cfg)));
  const b = await trace(new A.Client(Object.assign({ base: BLOCKSTREAM, fetch: plain }, cfg)));
  assert.deepEqual([m.errors, b.errors], [[], []]);
  assert.deepEqual(m.sources, ['mempool.space']); assert.deepEqual(b.sources, ['blockstream.info']);
  assert.deepEqual(facts(m), facts(b));
});

test('mempool.space throttles (429): Blockstream.info answers and the graph is the same', opts, async () => {
  const normal = await trace(new A.Client(Object.assign({ base: BLOCKSTREAM, fetch: plain }, cfg)));
  const switches = [];
  const c = new A.Client(Object.assign({ base: MEMPOOL, fetch: broken(MEMPOOL, throttle), backup: { base: BLOCKSTREAM, concurrency: 3, delayMs: 250 },
    onSwitch: (i) => switches.push([i.reason, host(i.from), host(i.to)]) }, cfg));
  const r = await trace(c);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.sources, ['blockstream.info']);
  assert.deepEqual(switches, [['rate', 'mempool.space', 'blockstream.info']], 'announced once');
  assert.ok(c.count.backup > 0);
  assert.deepEqual(facts(r), facts(normal));
});

test('Blockstream.info throttles (429): mempool.space answers and the graph is the same', opts, async () => {
  const normal = await trace(new A.Client(Object.assign({ base: MEMPOOL, fetch: plain }, cfg)));
  const r = await trace(new A.Client(Object.assign({ base: BLOCKSTREAM, fetch: broken(BLOCKSTREAM, throttle), backup: { base: MEMPOOL, concurrency: 4, delayMs: 150 } }, cfg)));
  assert.deepEqual(r.errors, []); assert.deepEqual(r.sources, ['mempool.space']);
  assert.deepEqual(facts(r), facts(normal));
});

test('a refused connection moves to the backup, and after the cool-down the main server is used again', opts, async () => {
  let down = true; const events = [];
  const fetcher = (url, init) => (down && url.startsWith(MEMPOOL) ? refuse(url) : fetch(url, init));
  const c = new A.Client({ base: MEMPOOL, fetch: fetcher, delayMs: 100, timeoutMs: 20000, retries: 1, backoffMs: 200, coolMs: 2500,
    backup: { base: BLOCKSTREAM, concurrency: 2, delayMs: 200 },
    onSwitch: (i) => events.push('switch ' + i.reason), onRestore: (i) => events.push('restore ' + host(i.base)) });
  const a = await c.get('/address/' + ADDR);
  assert.equal(host(c.sourceOf(a)), 'blockstream.info'); assert.ok(a.chain_stats.tx_count >= 1);
  down = false;
  assert.equal(host(c.sourceOf(await c.get('/address/' + ADDR + '/txs'))), 'blockstream.info', 'still cooling down');
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(host(c.sourceOf(await c.get('/address/' + ADDR + '/txs/chain'))), 'mempool.space', 'back on the main server');
  assert.deepEqual(events, ['switch network', 'restore mempool.space']); assert.equal(c.away, null);
});

test('a missing transaction is an answer, not a reason to switch servers', opts, async () => {
  const switches = [];
  const c = new A.Client(Object.assign({ base: MEMPOOL, fetch: plain, backup: { base: BLOCKSTREAM, concurrency: 2, delayMs: 250 }, onSwitch: () => switches.push(1) }, cfg));
  await assert.rejects(c.get('/tx/' + '0'.repeat(64)), (e) => e.status === 404 || /not found|404/i.test(String(e.message || e.kind)));
  assert.equal(switches.length, 0); assert.equal(c.count.backup, 0);
});
