'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/orion-model.js');
const { Client, Explorer } = require('../public/js/orion-api.js');

const A = 'https://a.example/api', B = 'https://b.example/api';
const R = (status, body, headers) => ({ __resp: true, status, body, headers });

/** A fake fetch that knows two servers: hosts is { base: { path: value | (call) => value } }. 'hang' never answers, 'down' fails like a refused connection. */
function twoServers(hosts) {
  const log = [];
  const f = (url, init) => {
    const m = /^(https?:\/\/[^/]+\/api)(\/.*)$/.exec(url), base = m[1], p = m[2];
    log.push({ base, p });
    const calls = log.filter((l) => l.base === base && l.p === p).length;
    return new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      let r = (hosts[base] || {})[p];
      if (typeof r === 'function') r = r(calls);
      if (r === 'hang') return;
      if (r === 'down') return reject(new TypeError('Failed to fetch'));
      if (r === undefined) r = R(404, 'not found');
      if (!r || !r.__resp) r = { status: 200, body: r };
      setTimeout(() => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null },
                                 text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }), 0);
    });
  };
  f.log = log;
  f.on = (base) => log.filter((l) => l.base === base).map((l) => l.p);
  return f;
}

function make(hosts, extra) {
  const clock = { t: 1000000 };
  const events = { switched: [], restored: [] };
  const f = twoServers(hosts);
  const c = new Client(Object.assign({
    base: A, backup: { base: B }, fetch: f, delayMs: 0, timeoutMs: 400, retries: 2, backoffMs: 1, now: () => clock.t, coolMs: 60000,
    onSwitch: (i) => events.switched.push(i), onRestore: (i) => events.restored.push(i)
  }, extra));
  return { c, f, clock, events };
}

test('a throttled request goes to the backup at once, without waiting or retrying on the throttling server', async () => {
  const { c, f, events } = make({ [A]: { '/tx/1': R(429, 'slow down') }, [B]: { '/tx/1': { id: 1 } } });
  const r = await c.get('/tx/1');
  assert.deepEqual(r, { id: 1 });
  assert.deepEqual(f.on(A), ['/tx/1'], 'one try only on the server that throttles');
  assert.deepEqual(f.on(B), ['/tx/1']);
  assert.equal(c.sourceOf(r), B, 'the answer remembers which server sent it');
  assert.equal(events.switched.length, 1);
  assert.equal(events.switched[0].from, A); assert.equal(events.switched[0].to, B); assert.equal(events.switched[0].reason, 'rate'); assert.equal(events.switched[0].seconds, 60);
  assert.equal(c.count.backup, 1); assert.equal(c.total.backup, 1); assert.equal(c.count.failed, 0);
});

test('while the first server is cooling down new requests go straight to the backup, then it gets the next one again', async () => {
  const { c, f, clock, events } = make({ [A]: { '/tx/1': R(429, 'no'), '/tx/2': { id: 2 }, '/tx/3': { id: 3 } }, [B]: { '/tx/1': { id: 1 }, '/tx/2': { id: 2 }, '/tx/3': { id: 3 } } });
  await c.get('/tx/1');
  clock.t += 30000;
  const second = await c.get('/tx/2');
  assert.deepEqual(f.on(A), ['/tx/1'], 'not asked again during the cool-down');
  assert.equal(c.sourceOf(second), B);
  assert.equal(events.switched.length, 1, 'one message for the whole spell, not one per request');
  clock.t += 31000;                                                       // a minute has passed since the failure
  const third = await c.get('/tx/3');
  assert.equal(c.sourceOf(third), A, 'the first server is tried first again');
  assert.deepEqual(events.restored, [{ base: A }]);
  await c.get('/tx/2'.replace('2', '3'));                                // cached: no second message
  assert.equal(events.restored.length, 1);
});

test('a server error is tried once more on the same server, then the backup answers', async () => {
  const { c, f, events } = make({ [A]: { '/tx/1': R(503, 'unavailable') }, [B]: { '/tx/1': { id: 1 } } });
  const r = await c.get('/tx/1');
  assert.equal(c.sourceOf(r), B);
  assert.deepEqual(f.on(A), ['/tx/1', '/tx/1'], 'the one retry');
  assert.equal(events.switched[0].reason, 'server'); assert.equal(c.count.retried, 1);
});

test('a timeout and a refused connection move a request too', async () => {
  const slow = make({ [A]: { '/tx/1': 'hang' }, [B]: { '/tx/1': { id: 1 } } }, { timeoutMs: 30 });
  assert.equal(slow.c.sourceOf(await slow.c.get('/tx/1')), B); assert.equal(slow.events.switched[0].reason, 'timeout');
  const down = make({ [A]: { '/tx/1': 'down' }, [B]: { '/tx/1': { id: 1 } } });
  assert.equal(down.c.sourceOf(await down.c.get('/tx/1')), B); assert.equal(down.events.switched[0].reason, 'network');
});

test('"not found" is an answer: it is returned as it is and never sent to the other server', async () => {
  const { c, f, events } = make({ [A]: { '/tx/1': R(404, 'Transaction not found') }, [B]: { '/tx/1': { id: 1 } } });
  await assert.rejects(c.get('/tx/1'), (e) => e.kind === 'notfound');
  assert.deepEqual(f.on(B), [], 'the backup was not asked');
  assert.equal(events.switched.length, 0);
  const bad = make({ [A]: { '/address/x': R(400, 'bad address') }, [B]: { '/address/x': { ok: 1 } } });
  await assert.rejects(bad.c.get('/address/x'), (e) => e.kind === 'notfound'); assert.deepEqual(bad.f.on(B), []);
});

test('when both servers fail the error is reported, each was given its chance, and the failure is counted once', async () => {
  const { c, f } = make({ [A]: { '/tx/1': R(500, 'a') }, [B]: { '/tx/1': R(502, 'b') } });
  await assert.rejects(c.get('/tx/1'), (e) => e.status === 502);
  assert.equal(f.on(A).length, 2, 'one try and one retry on the first server');
  assert.equal(f.on(B).length, 3, 'the full retries on the backup');
  assert.equal(c.count.failed, 1);
});

test('without a backup nothing changes, and a backup that is the same server is ignored', async () => {
  const f = twoServers({ [A]: { '/tx/1': (n) => (n < 3 ? R(500, 'x') : { id: 1 }) } });
  const plain = new Client({ base: A, fetch: f, delayMs: 0, retries: 2, backoffMs: 1 });
  assert.deepEqual(await plain.get('/tx/1'), { id: 1 }); assert.equal(f.on(A).length, 3); assert.equal(plain.backup, null);
  assert.equal(plain.sourceOf({}), A);
  assert.equal(new Client({ base: A, backup: { base: A + '/' }, fetch: f }).backup, null);
});

test('several requests failing together make one switch message, and the backup takes all of them', async () => {
  const routes = {}; for (let i = 0; i < 6; i++) routes['/tx/' + i] = { id: i };
  const failing = {}; for (let i = 0; i < 6; i++) failing['/tx/' + i] = R(429, 'no');
  const { c, events } = make({ [A]: failing, [B]: routes }, { concurrency: 3 });
  const out = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => c.get('/tx/' + i)));
  assert.deepEqual(out.map((o) => o.id), [0, 1, 2, 3, 4, 5]);
  assert.equal(events.switched.length, 1); assert.equal(c.count.backup, 6);
});

test('the request cap counts requests to both servers', async () => {
  const { c } = make({ [A]: { '/tx/1': R(429, 'no'), '/tx/2': { id: 2 } }, [B]: { '/tx/1': { id: 1 }, '/tx/2': { id: 2 } } }, { maxRequests: 2 });
  await c.get('/tx/1');                                                    // one to each server
  await assert.rejects(c.get('/tx/2'), (e) => e.kind === 'cap');
});

test('the backup is paced by its own settings while it is serving', async () => {
  const { c, clock } = make({ [A]: { '/tx/1': R(429, 'no') }, [B]: { '/tx/1': { id: 1 } } }, { concurrency: 4, delayMs: 150, backup: { base: B, concurrency: 3, delayMs: 250 } });
  assert.equal(c._pace(c._firstBase()).concurrency, 4);
  await c.get('/tx/1');
  assert.equal(c._firstBase(), B); assert.equal(c._pace(c._firstBase()).concurrency, 3); assert.equal(c._pace(c._firstBase()).delayMs, 250);
  clock.t += 61000; assert.equal(c._firstBase(), A);
});

test('both directions work: a request moves from the backup to the first server when the backup is the one failing', async () => {
  const { c, clock, f } = make({ [A]: { '/tx/1': R(429, 'no'), '/tx/2': { id: 2 } }, [B]: { '/tx/1': { id: 1 }, '/tx/2': R(503, 'down') } });
  await c.get('/tx/1');                                                    // A throttled: B serves
  clock.t += 5000;
  const r = await c.get('/tx/2');                                          // B fails (twice: a try and a retry): A, still cooling, is the other choice
  assert.equal(c.sourceOf(r), A);
  assert.equal(f.on(B).filter((p) => p === '/tx/2').length, 2);
});

test('Explorer notes the server that actually sent each transaction and address total', async () => {
  const txA = { txid: 'aa'.repeat(32), vin: [{ txid: 'bb'.repeat(32), vout: 0, prevout: { scriptpubkey_address: 'bc1qin', value: 5000 } }], vout: [{ scriptpubkey_address: 'bc1qout', value: 4000 }], status: { confirmed: true, block_time: 1650000000 } };
  const txB = { txid: 'cc'.repeat(32), vin: [{ txid: 'dd'.repeat(32), vout: 0, prevout: { scriptpubkey_address: 'bc1qin2', value: 7000 } }], vout: [{ scriptpubkey_address: 'bc1qout2', value: 6000 }], status: { confirmed: true, block_time: 1650000100 } };
  const stats = { address: 'bc1qout', chain_stats: { funded_txo_sum: 4000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } };
  const { c, clock } = make({
    [A]: { ['/tx/' + txA.txid]: txA, ['/tx/' + txA.txid + '/outspends']: [{ spent: false }], ['/tx/' + txB.txid]: R(429, 'no'), ['/address/bc1qout']: R(429, 'no') },
    [B]: { ['/tx/' + txB.txid]: txB, ['/tx/' + txB.txid + '/outspends']: [{ spent: false }], ['/address/bc1qout']: stats, ['/address/bc1qout/txs']: [txB] }
  });
  const g = new Graph(), ex = new Explorer(c, g);
  await ex.loadTx(txA.txid);
  assert.equal(g.node(ID.tx(txA.txid)).source, A, 'answered by the first server');
  await ex.loadTx(txB.txid);
  assert.equal(g.node(ID.tx(txB.txid)).source, B, 'answered by the backup, and recorded as such');
  clock.t += 120000;                                                       // the first server is tried again, throttles again, the backup answers the address and its history
  await ex.expandAddress('bc1qout', { pages: 1 });
  assert.equal(g.node(ID.addr('bc1qout')).statsSource, B);
  assert.equal(g.node(ID.tx(txB.txid)).source, B);
});
