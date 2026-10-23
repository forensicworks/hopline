'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/hopline-model.js');
const { Client, Explorer, PRESETS, ONION, isTxid } = require('../public/js/hopline-api.js');
const Api = require('../public/js/hopline-api.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const NORMAL = fx('tx_normal.json'), OUTSP = fx('outspends_normal.json');
const SPEND = [fx('tx_spender_0.json'), fx('tx_spender_1.json')];
const ADDR = fx('address_stats.json'), ADDR_TXS = fx('address_txs.json');

// Marks a route value as an HTTP response (plain values are 200 JSON bodies; tx JSON itself has a `status` field).
const R = (status, body, headers) => ({ __resp: true, status, body, headers });

// A fake fetch over a route table. routes: path -> value | (n) => Response-like descriptor
function fakeFetch(routes, o) {
  o = o || {};
  const log = [];
  let inflight = 0, maxInflight = 0;
  const f = (url, init) => {
    const p = url.replace(/^https?:\/\/[^/]+(\/api)?/, '');
    log.push({ p, t: Date.now() });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    return new Promise((resolve, reject) => {
      const done = (fn) => { inflight--; fn(); };
      if (init && init.signal) init.signal.addEventListener('abort', () => done(() => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
      const respond = () => {
        const calls = log.filter((l) => l.p === p).length;
        let r = routes[p];
        if (typeof r === 'function') r = r(calls);
        if (r === 'hang') return;                                        // never answers (until aborted)
        if (r === undefined) r = R(404, 'not found');
        if (!r || !r.__resp) r = { status: 200, body: r };
        done(() => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null },
                             text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }));
      };
      setTimeout(respond, o.latency || 0);
    });
  };
  f.log = log; f.maxInflight = () => maxInflight;
  return f;
}
const quick = (extra) => Object.assign({ base: 'https://x/api', delayMs: 0, timeoutMs: 500, retries: 2, backoffMs: 1 }, extra);

test('Tor preset: onion base, fewer parallel requests, more spacing and a longer timeout than clearnet', () => {
  assert.match(PRESETS.tor.base, /^http:\/\/[a-z2-7]{56}\.onion\/api$/);
  assert.equal(PRESETS.tor.base, ONION);
  assert.ok(PRESETS.tor.concurrency < PRESETS.clearnet.concurrency);
  assert.ok(PRESETS.tor.delayMs > PRESETS.clearnet.delayMs);
  assert.ok(PRESETS.tor.timeoutMs > PRESETS.clearnet.timeoutMs);
  assert.match(PRESETS.clearnet.base, /^https:\/\/mempool\.space\/api$/);
});

test('get: parses JSON, caches, and shares one request between concurrent identical calls', async () => {
  const f = fakeFetch({ '/tx/a': { x: 1 } }, { latency: 5 });
  const c = new Client(quick({ fetch: f }));
  const [a, b] = await Promise.all([c.get('/tx/a'), c.get('/tx/a')]);
  assert.deepEqual(a, { x: 1 }); assert.deepEqual(b, { x: 1 });
  await c.get('/tx/a');
  assert.equal(f.log.length, 1);
  assert.equal(c.count.network, 1);
  assert.equal(c.count.cached, 2);
});

test('get: plain-text endpoints work (tip height)', async () => {
  const c = new Client(quick({ fetch: fakeFetch({ '/blocks/tip/height': '971587\n' }) }));
  assert.equal(await c.tipHeight(), 971587);
});

test('concurrency limit is respected', async () => {
  const routes = {}; for (let i = 0; i < 12; i++) routes['/tx/' + i] = { i };
  const f = fakeFetch(routes, { latency: 15 });
  const c = new Client(quick({ fetch: f, concurrency: 3 }));
  await Promise.all(Object.keys(routes).map((p) => c.get(p)));
  assert.equal(f.maxInflight(), 3);
});

test('requests are spaced by delayMs even when they run in parallel (mock clock, so no timing flakiness)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const calls = [];
  const f = () => { calls.push(Date.now()); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('{}') }); };
  const c = new Client({ base: 'https://x/api', fetch: f, concurrency: 4, delayMs: 40, timeoutMs: 60000, retries: 0 });
  const done = [0, 1, 2, 3].map((i) => c.get('/tx/' + i));
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(calls.length, 1, 'the first request goes out at once');
  t.mock.timers.tick(39); await flush();
  assert.equal(calls.length, 1, 'the second waits for the full delay');
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(40); await flush();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(40); await flush();
  assert.equal(calls.length, 4);
  await Promise.all(done);
  assert.deepEqual(calls.map((x, i) => (i ? x - calls[i - 1] : 40)), [40, 40, 40, 40].map((v, i) => (i ? v : 40)));
});

test('retries 5xx and 429 (honouring Retry-After) and then succeeds', async () => {
  const f = fakeFetch({
    '/a': (n) => n < 3 ? R(503, 'busy') : { x: 'ok' },
    '/b': (n) => n < 2 ? R(429, 'slow down', { 'retry-after': '0' }) : { y: 'ok' }
  });
  const c = new Client(quick({ fetch: f }));
  assert.deepEqual(await c.get('/a'), { x: 'ok' });
  assert.deepEqual(await c.get('/b'), { y: 'ok' });
  assert.equal(c.count.retried, 3);
});

test('does not retry 404, reports it as notfound and does not cache the failure', async () => {
  let hits = 0;
  const f = fakeFetch({ '/missing': () => { hits++; return R(404, 'Transaction not found'); } });
  const c = new Client(quick({ fetch: f }));
  await assert.rejects(c.get('/missing'), (e) => e.kind === 'notfound');
  assert.equal(hits, 1);
  await assert.rejects(c.get('/missing'));
  assert.equal(hits, 2, 'failure was not cached');
});

test('gives up after the retry budget', async () => {
  const f = fakeFetch({ '/down': R(500, 'x') });
  const c = new Client(quick({ fetch: f, retries: 2 }));
  await assert.rejects(c.get('/down'), (e) => e.kind === 'server');
  assert.equal(f.log.length, 3);
  assert.equal(c.count.failed, 1);
});

test('timeout aborts a hung request and is reported as timeout', async () => {
  const f = fakeFetch({ '/slow': 'hang' });
  const c = new Client(quick({ fetch: f, timeoutMs: 30, retries: 0 }));
  await assert.rejects(c.get('/slow'), (e) => e.kind === 'timeout');
});

test('request cap stops further network calls but still serves the cache', async () => {
  const f = fakeFetch({ '/1': { a: 1 }, '/2': { a: 2 }, '/3': { a: 3 } });
  const c = new Client(quick({ fetch: f, maxRequests: 2 }));
  await c.get('/1'); await c.get('/2');
  await assert.rejects(c.get('/3'), (e) => e.kind === 'cap');
  assert.deepEqual(await c.get('/1'), { a: 1 });
  assert.equal(f.log.length, 2);
});

test('abort rejects queued and in-flight requests, and resume allows new ones', async () => {
  const f = fakeFetch({ '/slow': 'hang', '/q1': { ok: 1 }, '/q2': { ok: 2 }, '/fresh': { ok: 3 } });
  const c = new Client(quick({ fetch: f, concurrency: 1, timeoutMs: 5000 }));
  const running = c.get('/slow'), queued = c.get('/q1');
  const r1 = assert.rejects(running, (e) => e.kind === 'aborted'), r2 = assert.rejects(queued, (e) => e.kind === 'aborted');
  await new Promise((r) => setTimeout(r, 10));
  c.abort();
  await Promise.all([r1, r2]);
  await assert.rejects(c.get('/q2'), (e) => e.kind === 'aborted');
  c.resume();
  assert.deepEqual(await c.get('/fresh'), { ok: 3 });
});

test('Explorer.loadTx: tx plus outspends, 2 requests', async () => {
  const f = fakeFetch({ ['/tx/' + NORMAL.txid]: NORMAL, ['/tx/' + NORMAL.txid + '/outspends']: OUTSP });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const r = await ex.loadTx(NORMAL.txid);
  assert.equal(r.requests, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(g.node(ID.tx(NORMAL.txid)).outspendsLoaded, true);
  assert.ok(g.node(ID.tx(OUTSP[0].txid)), 'spender stub');
  assert.ok(r.added > 5);
});

test('Explorer.loadTx: unknown tx reports an error and leaves the graph empty', async () => {
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: fakeFetch({}) })), g);
  const r = await ex.loadTx('f'.repeat(64));
  assert.equal(r.failed, true);
  assert.equal(r.errors.length, 1);
  assert.equal(g.nodes.size, 0);
});

function chainRoutes() {
  const routes = { ['/tx/' + NORMAL.txid]: NORMAL, ['/tx/' + NORMAL.txid + '/outspends']: OUTSP };
  SPEND.forEach((t) => { routes['/tx/' + t.txid] = t; routes['/tx/' + t.txid + '/outspends'] = []; });
  return routes;
}

test('Explorer.expandTx forward loads the spending transactions in full', async () => {
  const f = fakeFetch(chainRoutes());
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  await ex.loadTx(NORMAL.txid);
  const r = await ex.expandTx(NORMAL.txid, 'forward');
  SPEND.forEach((t) => assert.equal(g.node(ID.tx(t.txid)).loaded, true));
  assert.equal(r.truncated, false);
  assert.deepEqual(r.errors, []);
  // second expansion costs nothing
  const again = await ex.expandTx(NORMAL.txid, 'forward');
  assert.equal(again.requests, 0);
});

test('Explorer.expandTx forward honours the cap and says it truncated', async () => {
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: fakeFetch(chainRoutes()) })), g);
  await ex.loadTx(NORMAL.txid);
  const r = await ex.expandTx(NORMAL.txid, 'forward', 1);
  assert.equal(r.truncated, true);
  assert.equal(SPEND.filter((t) => g.node(ID.tx(t.txid)).loaded).length, 1);
});

test('Explorer.expandTx backward fetches the funding transactions; a coinbase has none', async () => {
  const fund = NORMAL.vin[0].txid;
  const fundTx = { txid: fund, fee: 0, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1000 },
                   vin: [{ txid: 'ab'.repeat(32), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'zzz', scriptpubkey_type: 'p2pkh', value: 1e8 } }],
                   vout: []};
  fundTx.vout[NORMAL.vin[0].vout] = NORMAL.vin[0].prevout;
  const f = fakeFetch({ ['/tx/' + NORMAL.txid]: NORMAL, ['/tx/' + NORMAL.txid + '/outspends']: OUTSP, ['/tx/' + fund]: fundTx, ['/tx/' + fund + '/outspends']: [{ spent: true, txid: NORMAL.txid, vin: 0, status: { confirmed: true, block_time: NORMAL.status.block_time } }] });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  await ex.loadTx(NORMAL.txid);
  const r = await ex.expandTx(NORMAL.txid, 'backward');
  assert.equal(g.node(ID.tx(fund)).loaded, true);
  assert.equal(g.node(ID.tx(fund)).time, 1000);
  assert.deepEqual(r.errors, []);

  const cbRoutes = {}; const cb = fx('tx_coinbase.json');
  cbRoutes['/tx/' + cb.txid] = cb; cbRoutes['/tx/' + cb.txid + '/outspends'] = cb.vout.map(() => ({ spent: false }));
  const g2 = new Graph(), ex2 = new Explorer(new Client(quick({ fetch: fakeFetch(cbRoutes) })), g2);
  const r2 = await ex2.expandTx(cb.txid, 'both');
  assert.deepEqual(r2.errors, []);
  assert.equal(g2.node(ID.tx(cb.txid)).coinbase, true);
});

test('Explorer.expandTx loads the transaction first when it is not in the graph yet', async () => {
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: fakeFetch(chainRoutes()) })), g);
  const r = await ex.expandTx(NORMAL.txid, 'forward');
  assert.equal(g.node(ID.tx(NORMAL.txid)).loaded, true);
  assert.deepEqual(r.errors, []);
  SPEND.forEach((t) => assert.equal(g.node(ID.tx(t.txid)).loaded, true));
});

test('Explorer.expandTx reports failed spenders but keeps what it got', async () => {
  const routes = chainRoutes(); delete routes['/tx/' + SPEND[1].txid];
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: fakeFetch(routes) })), g);
  await ex.loadTx(NORMAL.txid);
  const r = await ex.expandTx(NORMAL.txid, 'forward');
  assert.equal(r.errors.length, 1);
  assert.equal(g.node(ID.tx(SPEND[0].txid)).loaded, true);
  assert.equal(g.node(ID.tx(SPEND[1].txid)).loaded, false);
});

test('Explorer.expandAddress adds the history and reports the total', async () => {
  const f = fakeFetch({ ['/address/' + ADDR.address]: ADDR, ['/address/' + ADDR.address + '/txs']: ADDR_TXS });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const r = await ex.expandAddress(ADDR.address);
  assert.equal(r.total, ADDR.chain_stats.tx_count + ADDR.mempool_stats.tx_count);
  assert.equal(r.addedTx, ADDR_TXS.length);
  assert.equal(r.last, null, 'history exhausted');
  ADDR_TXS.forEach((t) => assert.equal(g.node(ID.tx(t.txid)).loaded, true));
  assert.equal(g.node(ID.addr(ADDR.address)).txCount, r.total);
});

test('Explorer.expandAddress pages with /txs/chain/<last> and stops at the cap', async () => {
  const mk = (i) => ({ txid: String(i).padStart(64, '0'), fee: 1, weight: 400, status: { confirmed: true, block_height: i, block_time: 1000 + i },
                       vin: [{ txid: 'cd'.repeat(32), vout: i, prevout: { scriptpubkey_address: 'src' + i, scriptpubkey_type: 'p2pkh', value: 5 } }],
                       vout: [{ scriptpubkey_address: 'ADDR', scriptpubkey_type: 'p2pkh', value: 4 }] });
  const page1 = Array.from({ length: 25 }, (_, i) => mk(i + 1)), page2 = Array.from({ length: 25 }, (_, i) => mk(i + 26)), page3 = [mk(51)];
  const f = fakeFetch({ '/address/ADDR': { address: 'ADDR', chain_stats: { tx_count: 51 }, mempool_stats: { tx_count: 0 } },
                        '/address/ADDR/txs': page1, ['/address/ADDR/txs/chain/' + page1[24].txid]: page2, ['/address/ADDR/txs/chain/' + page2[24].txid]: page3 });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const all = await ex.expandAddress('ADDR', { pages: 5, cap: 0 });
  assert.equal(all.addedTx, 51);
  assert.equal(all.last, null);
  const g2 = new Graph(), ex2 = new Explorer(new Client(quick({ fetch: fakeFetch({ '/address/ADDR': { address: 'ADDR', chain_stats: { tx_count: 51 }, mempool_stats: { tx_count: 0 } }, '/address/ADDR/txs': page1, ['/address/ADDR/txs/chain/' + page1[24].txid]: page2 }) })), g2);
  const part = await ex2.expandAddress('ADDR', { pages: 5, cap: 30 });
  assert.equal(part.addedTx, 30);
  assert.equal(part.truncated, true);
  assert.equal(part.last, page2[4].txid, 'can continue from where it stopped');
});

test('Explorer.expandAddress: a failed lookup leaves no placeholder vertex', async () => {
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: fakeFetch({}) })), g);
  const r = await ex.expandAddress('notanaddress');
  assert.ok(r.errors.length >= 1);
  assert.equal(g.nodes.size, 0);
});

test('Explorer.open routes by input type', async () => {
  const f = fakeFetch(Object.assign(chainRoutes(), { ['/address/' + ADDR.address]: ADDR, ['/address/' + ADDR.address + '/txs']: ADDR_TXS }));
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const a = await ex.open('  ' + NORMAL.txid.toUpperCase() + '  ');
  assert.equal(a.kind, 'tx'); assert.equal(a.id, ID.tx(NORMAL.txid));
  const b = await ex.open(ADDR.address);
  assert.equal(b.kind, 'addr'); assert.equal(b.id, ID.addr(ADDR.address));
  assert.ok(isTxid(NORMAL.txid) && !isTxid(ADDR.address) && !isTxid('abc'));
});

test('cached responses expire after the TTL so an unconfirmed tx can be seen confirming', async () => {
  let n = 0;
  const f = fakeFetch({ '/tx/a': () => ({ v: ++n }) });
  let now = 1000;
  const c = new Client(quick({ fetch: f, ttlMs: 60000, now: () => now }));
  assert.deepEqual(await c.get('/tx/a'), { v: 1 });
  now += 59000;
  assert.deepEqual(await c.get('/tx/a'), { v: 1 }, 'still fresh');
  now += 2000;
  assert.deepEqual(await c.get('/tx/a'), { v: 2 }, 'expired: fetched again');
  assert.equal(f.log.length, 2);
});

test('normaliseQuery: bech32 is case-insensitive so it is lower-cased, base58 is case-sensitive so it is not', () => {
  const { normaliseQuery } = require('../public/js/hopline-api.js');
  const lower = 'bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq';
  assert.deepEqual(normaliseQuery('Bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq'), { kind: 'addr', value: lower }, 'autocorrected first capital');
  assert.deepEqual(normaliseQuery(lower.toUpperCase()), { kind: 'addr', value: lower });
  assert.deepEqual(normaliseQuery('  ' + lower + '\n'), { kind: 'addr', value: lower });
  assert.deepEqual(normaliseQuery('bitcoin:' + lower + '?amount=0.1&label=x'), { kind: 'addr', value: lower });
  assert.deepEqual(normaliseQuery('1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9'), { kind: 'addr', value: '1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9' });
  assert.deepEqual(normaliseQuery('bc1p' + 'q'.repeat(58)), { kind: 'addr', value: 'bc1p' + 'q'.repeat(58) });          // taproot
  assert.deepEqual(normaliseQuery(NORMAL.txid.toUpperCase()), { kind: 'tx', value: NORMAL.txid });
  ['', '   ', 'hello world', 'abc', '<script>', null, undefined].forEach((bad) => assert.equal(normaliseQuery(bad), null, String(bad)));
});

test('Explorer.open looks a mixed-case bech32 address up in lower case', async () => {
  const f = fakeFetch({ ['/address/' + ADDR.address]: ADDR, ['/address/' + ADDR.address + '/txs']: ADDR_TXS });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const typed = ADDR.address[0].toUpperCase() + ADDR.address.slice(1);
  const r = await ex.open(typed);
  assert.equal(r.id, ID.addr(ADDR.address));
  assert.ok(f.log.every((l) => !/[A-Z]/.test(l.p.replace('/address/', '').replace('/txs', ''))), 'no capital letters were sent');
  assert.deepEqual(r.errors, []);
});

test('a rejected address is reported once, clearly, with a single request', async () => {
  const f = fakeFetch({ '/address/Bad1addr0000000': R(400, 'Invalid Bitcoin address') });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  const r = await ex.expandAddress('Bad1addr0000000');
  assert.equal(r.requests, 1, 'the history request is not attempted after the summary was rejected');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /is not a valid Bitcoin address/);
  assert.equal(g.nodes.size, 0);
});

test('checkQuery: right case, understands pasted explorer links, and checks the address locally', () => {
  const { checkQuery, normaliseQuery } = require('../public/js/hopline-api.js');
  const good = 'bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq';
  assert.deepEqual(checkQuery('Bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq'), { ok: true, kind: 'addr', value: good });
  assert.deepEqual(checkQuery(good.toUpperCase()), { ok: true, kind: 'addr', value: good });
  assert.deepEqual(checkQuery('https://mempool.space/address/' + good.toUpperCase() + '?foo=1#bar'), { ok: true, kind: 'addr', value: good });
  assert.deepEqual(checkQuery('https://blockstream.info/tx/' + NORMAL.txid.toUpperCase()), { ok: true, kind: 'tx', value: NORMAL.txid });
  assert.deepEqual(checkQuery('mempool.space/address/1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2/'), { ok: true, kind: 'addr', value: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' });
  assert.deepEqual(checkQuery('bitcoin:' + good + '?amount=1'), { ok: true, kind: 'addr', value: good });

  const typo = checkQuery(good.slice(0, -1) + 'p');
  assert.equal(typo.ok, false); assert.match(typo.message, /checksum/);
  const wrongCase = checkQuery('1bvbmseystwetqtfn5au4m4gfg7xjanvn2');
  assert.equal(wrongCase.ok, false); assert.match(wrongCase.message, /case-sensitive/);
  assert.match(checkQuery('0x52908400098527886E0F7030069857D2E4169EE7').message, /not a Bitcoin address/);
  assert.match(checkQuery('hello world').message, /does not look like/);
  assert.equal(checkQuery('').ok, false);
  assert.equal(normaliseQuery('https://example.com/address/'), null);
});

test('presets: Blockstream.info is an Esplora source with its own gentler limits; prices come from mempool where it has none', () => {
  const { PRESETS, ONION } = require('../public/js/hopline-api.js');
  assert.equal(PRESETS.blockstream.base, 'https://blockstream.info/api');
  assert.equal(PRESETS.blockstream.prices, 'https://mempool.space/api');
  assert.ok(PRESETS.blockstream.concurrency <= PRESETS.clearnet.concurrency && PRESETS.blockstream.delayMs >= PRESETS.clearnet.delayMs);
  assert.equal(PRESETS.tor.prices, ONION, 'Tor users never fetch prices over the clearnet');
  assert.equal(PRESETS.clearnet.prices, PRESETS.clearnet.base);
  assert.equal(PRESETS.custom.prices, null);
  Object.keys(PRESETS).forEach((k) => assert.ok(PRESETS[k].label));
});

test('a Blockstream-style source works with the same client (same Esplora paths and shapes)', async () => {
  const f = fakeFetch({ ['/tx/' + NORMAL.txid]: NORMAL, ['/tx/' + NORMAL.txid + '/outspends']: OUTSP });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f, base: 'https://blockstream.info/api' })), g);
  const r = await ex.loadTx(NORMAL.txid);
  assert.deepEqual(r.errors, []);
  assert.equal(g.node(ID.tx(NORMAL.txid)).loaded, true);
});

test('price endpoints: today in one call, the history for one currency in one call; totals survive resetCount', async () => {
  const f = fakeFetch({ '/v1/prices': { time: 1, USD: 5, EUR: 4 }, '/v1/historical-price?currency=EUR': { prices: [], exchangeRates: {} } });
  const c = new Client(quick({ fetch: f }));
  assert.equal((await c.prices()).USD, 5);
  assert.deepEqual(await c.historicalPrices('EUR'), { prices: [], exchangeRates: {} });
  assert.equal(c.count.network, 2);
  c.resetCount();
  assert.equal(c.count.network, 0);
  assert.equal(c.total.network, 2, 'cumulative counter is kept for the session display');
  assert.ok(f.log.some((l) => l.p === '/v1/historical-price?currency=EUR'));
});

test('cumulative totals count retries and failures', async () => {
  const f = fakeFetch({ '/flaky': (n) => (n < 2 ? R(503, 'x') : { ok: 1 }), '/dead': R(500, 'x') });
  const c = new Client(quick({ fetch: f, retries: 1 }));
  await c.get('/flaky');
  await assert.rejects(c.get('/dead'));
  c.resetCount();
  assert.deepEqual(c.total, { network: 4, failed: 1, retried: 2, backup: 0 });
});

test('Explorer.loadBalances reads the totals of each wallet, nothing else, caps the list, and reports failures', async () => {
  const stat = (f, s) => ({ chain_stats: { funded_txo_sum: f, spent_txo_sum: s, tx_count: 2 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
  const f = fakeFetch({ '/address/a1': stat(1000, 400), '/address/a2': stat(5000, 5000) });          // a3 answers 404
  const c = new Client(quick({ fetch: f })), g = new Graph(), ex = new Explorer(c, g);
  const before = Math.floor(Date.now() / 1000);
  const r = await ex.loadBalances(['a1', 'a2', 'a3', 'a1'], 0);
  assert.deepEqual(f.log.map((l) => l.p).sort(), ['/address/a1', '/address/a2', '/address/a3'], 'one request each, a repeat is not asked twice, no history');
  assert.equal(r.requests, 3); assert.equal(r.errors.length, 1); assert.match(r.errors[0], /a3/);
  assert.equal(g.node(ID.addr('a1')).fundedSum, 1000); assert.equal(g.node(ID.addr('a1')).source === undefined, true);
  assert.equal(g.node(ID.addr('a1')).statsSource, 'https://x/api'); assert.ok(g.node(ID.addr('a1')).statsAt >= before);
  assert.equal(g.node(ID.addr('a2')).spentSum, 5000); assert.equal(g.nodes.has(ID.addr('a3')), false, 'a failed read leaves nothing behind');
  const capped = await new Explorer(new Client(quick({ fetch: fakeFetch({ '/address/b1': stat(1, 0), '/address/b2': stat(2, 0), '/address/b3': stat(3, 0) }) })), new Graph()).loadBalances(['b1', 'b2', 'b3'], 2);
  assert.equal(capped.requests, 2); assert.equal(capped.truncated, true);
});

test('expanding an address records its totals as well as its history', async () => {
  const f = fakeFetch({ ['/address/' + ADDR.address]: ADDR, ['/address/' + ADDR.address + '/txs']: [] });
  const g = new Graph(), ex = new Explorer(new Client(quick({ fetch: f })), g);
  await ex.expandAddress(ADDR.address, {});
  const n = g.node(ID.addr(ADDR.address));
  assert.equal(n.fundedSum, ADDR.chain_stats.funded_txo_sum); assert.equal(n.spentSum, ADDR.chain_stats.spent_txo_sum);
  assert.equal(n.txCount, ADDR.chain_stats.tx_count + ADDR.mempool_stats.tx_count);
});

test('buildClient: the pacing and the backup that go with a saved source choice, and never a backup for Tor or your own server', () => {
  const m = require('../public/js/hopline-api.js');
  const a = m.buildClient({ source: 'clearnet', fallback: true });
  assert.equal(a.base, PRESETS.clearnet.base); assert.equal(a.backup.base, PRESETS.blockstream.base); assert.equal(a.concurrency, PRESETS.clearnet.concurrency);
  assert.equal(m.buildClient({ source: 'blockstream' }).backup.base, PRESETS.clearnet.base, 'the other way round');
  assert.equal(m.buildClient({ source: 'clearnet', fallback: false }).backup, null);
  assert.equal(m.buildClient({ source: 'tor', fallback: true }).backup, null, 'a backup would leave Tor');
  const own = m.buildClient({ source: 'custom', customBase: ' http://localhost:8080/api/ ', fallback: true });
  assert.equal(own.base, 'http://localhost:8080/api'); assert.equal(own.backup, null);
  assert.equal(m.buildClient({}).base, PRESETS.clearnet.base, 'nothing chosen: the default');
  assert.equal(m.buildClient({ source: 'nonsense' }).base, PRESETS.clearnet.base);
  assert.equal(m.hostOf('https://blockstream.info/api'), 'blockstream.info');
  let sw = null; const c = m.buildClient({ source: 'clearnet' }, { onSwitch: (i) => { sw = i; }, maxRequests: 7 });
  assert.equal(c.maxRequests, 7); assert.equal(c.onSwitch !== null, true); assert.equal(sw, null);
});

// ---- a key for a server, and the pace of your own ---------------------------------------------------------------------
// A fetch that keeps what it was asked: the address and the headers. answers: base -> (path) => status
function spyFetch(answers) {
  const calls = [];
  const f = (url, init) => {
    const m = /^(https?:\/\/[^/]+(?:\/api)?)(\/.*)$/.exec(url), base = m[1], p = m[2];
    calls.push({ url, base, p, headers: (init && init.headers) || {} });
    const status = (answers[base] || (() => 200))(p, calls.filter((c) => c.base === base).length);
    return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: () => Promise.resolve(status === 200 ? '123' : 'no') });
  };
  f.calls = calls;
  return f;
}

test('cleanKey: a key with its header, tidied; nothing for an empty key; a bad header name becomes Authorization', () => {
  assert.deepEqual(Api.cleanKey({ header: ' X-API-Key ', value: '  abc123  ' }), { header: 'X-API-Key', value: 'abc123' });
  assert.deepEqual(Api.cleanKey({ value: 'abc' }), { header: 'Authorization', value: 'abc' });
  assert.deepEqual(Api.cleanKey({ header: 'Bad Header: x', value: 'abc' }), { header: 'Authorization', value: 'abc' });
  assert.deepEqual(Api.cleanKey({ header: 'X-Key', value: 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(13) + String.fromCharCode(0) + 'c' }), { header: 'X-Key', value: 'abc' }, 'no line breaks or control characters in a header');
  assert.equal(Api.cleanKey({ header: 'X-Key', value: '   ' }), null); assert.equal(Api.cleanKey(null), null); assert.equal(Api.cleanKey('abc'), null); assert.equal(Api.cleanKey({}), null);
  assert.equal(Api.cleanKey({ value: 'x'.repeat(5000) }).value.length, 2000);
});

test('authFor: an Authorization key becomes a Bearer token unless it already names its scheme; another header is sent as it is', () => {
  const key = (k) => Api.authFor({ source: 'custom', customBase: 'https://my.node/api/', keys: { custom: k } })['https://my.node/api'];
  assert.deepEqual(key({ header: 'Authorization', value: 'tok123' }), { name: 'Authorization', value: 'Bearer tok123' });
  assert.deepEqual(key({ header: 'authorization', value: 'Bearer tok123' }), { name: 'authorization', value: 'Bearer tok123' });
  assert.deepEqual(key({ header: 'Authorization', value: 'Basic dXNlcjpwdw==' }), { name: 'Authorization', value: 'Basic dXNlcjpwdw==' });
  assert.deepEqual(key({ header: 'X-API-Key', value: 'k' }), { name: 'X-API-Key', value: 'k' });
  assert.deepEqual(Api.authFor({ source: 'custom', customBase: 'https://my.node/api', keys: {} }), {});
  assert.deepEqual(Api.authFor({ source: 'custom', customBase: 'https://my.node/api' }), {});
  assert.deepEqual(Api.authFor(null), {});
});

test('authFor: a key is only ever for the server it was saved for', () => {
  const keys = { custom: { header: 'X-Key', value: 'mine' }, blockstream: { header: 'X-Key', value: 'bs' } };
  assert.deepEqual(Api.authFor({ source: 'clearnet', fallback: true, keys }), { [PRESETS.blockstream.base]: { name: 'X-Key', value: 'bs' } }, 'the key of your own server is not sent to mempool.space or its backup');
  assert.deepEqual(Api.authFor({ source: 'clearnet', fallback: false, keys }), {}, 'no backup, no key for it');
  assert.deepEqual(Object.keys(Api.authFor({ source: 'custom', customBase: 'https://my.node/api', keys })), ['https://my.node/api'], 'and your own server has no backup to leak to');
});

test('a Client sends its key as a header to its own server only, never in the address, and the backup server never sees it', async () => {
  const keys = { custom: { header: 'X-API-Key', value: 'SECRET-1' } };
  const mine = 'https://my.node/api';
  const f = spyFetch({ [mine]: () => 200 });
  const c = new Client(quick({ base: mine, fetch: f, auth: Api.authFor({ source: 'custom', customBase: mine, keys }) }));
  await c.get('/blocks/tip/height', true);
  assert.equal(f.calls[0].headers['X-API-Key'], 'SECRET-1'); assert.equal(f.calls[0].headers.Accept, 'application/json, text/plain');
  assert.ok(!f.calls[0].url.includes('SECRET-1'), 'the key is not in the address');
  // the main server keeps failing: the backup answers, and receives only a key saved for the backup
  const g = spyFetch({ [PRESETS.clearnet.base]: () => 500, [PRESETS.blockstream.base]: () => 200 });
  const pair = Api.buildClient({ source: 'clearnet', fallback: true, keys: { clearnet: { header: 'X-Key', value: 'MAIN-KEY' }, blockstream: { header: 'X-Key', value: 'BS-KEY' } } }, {});
  pair.fetchImpl = g; pair.backoffMs = 1; pair.delayMs = 0; pair.backup.delayMs = 0;
  await pair.get('/blocks/tip/height', true);
  const main = g.calls.filter((x) => x.base === PRESETS.clearnet.base), backup = g.calls.filter((x) => x.base === PRESETS.blockstream.base);
  assert.ok(main.length >= 1 && backup.length >= 1);
  assert.ok(main.every((x) => x.headers['X-Key'] === 'MAIN-KEY'), 'the main server gets its own key');
  assert.ok(backup.every((x) => x.headers['X-Key'] === 'BS-KEY'), 'the backup gets only its own key');
  assert.ok(g.calls.every((x) => !x.url.includes('KEY')));
});

test('a server that says 401 or 403 is reported as a refusal, not retried, and a rejected key is said to be rejected', async () => {
  const f = spyFetch({ 'https://x/api': () => 401 });
  const withKey = new Client(quick({ fetch: f, auth: { 'https://x/api': { name: 'Authorization', value: 'Bearer nope' } }, retries: 3 }));
  await assert.rejects(withKey.get('/tx/' + 'a'.repeat(64)), (e) => e.kind === 'auth' && e.status === 401 && /the server rejected the key/.test(e.message));
  assert.equal(f.calls.length, 1, 'asking again with the same key would change nothing');
  const g = spyFetch({ 'https://x/api': () => 403 });
  const none = new Client(quick({ fetch: g, keyHint: true }));
  await assert.rejects(none.get('/tx/' + 'b'.repeat(64)), (e) => e.kind === 'auth' && e.status === 403 && /refused the request \(if it needs a key, add one under Data source\)/.test(e.message));
  const h = spyFetch({ 'https://x/api': () => 403 });
  await assert.rejects(new Client(quick({ fetch: h })).get('/tx/' + 'c'.repeat(64)), (e) => e.kind === 'auth' && /refused the request$/.test(e.message), 'no advice about a key for a public server');
  const nf = spyFetch({ 'https://x/api': () => 404 });
  await assert.rejects(new Client(quick({ fetch: nf })).get('/tx/' + 'd'.repeat(64)), (e) => e.kind === 'notfound', 'a missing transaction is still just missing');
});

test('the pace of your own server: faster by default, settable, and clamped; the public servers keep theirs', () => {
  assert.deepEqual(Api.DEFAULT_PACE, { concurrency: 8, delayMs: 20 });
  assert.ok(Api.DEFAULT_PACE.concurrency > PRESETS.custom.concurrency && Api.DEFAULT_PACE.delayMs < PRESETS.custom.delayMs);
  assert.deepEqual(Api.cleanPace(null), Api.DEFAULT_PACE);
  assert.deepEqual(Api.cleanPace({ concurrency: 0, delayMs: -5 }), { concurrency: 1, delayMs: 0 });
  assert.deepEqual(Api.cleanPace({ concurrency: 500, delayMs: 99999 }), { concurrency: 32, delayMs: 2000 });
  assert.deepEqual(Api.cleanPace({ concurrency: 'abc', delayMs: '40' }), { concurrency: 8, delayMs: 40 });
  const own = Api.buildClient({ source: 'custom', customBase: 'https://my.node/api', pace: { concurrency: 16, delayMs: 5 } }, {});
  assert.equal(own.concurrency, 16); assert.equal(own.delayMs, 5); assert.equal(own.keyHint, true);
  const oldWay = Api.buildClient({ source: 'custom', customBase: 'https://my.node/api' }, {});
  assert.equal(oldWay.concurrency, PRESETS.custom.concurrency, 'a caller that sets no pace gets what it always got');
  const pub = Api.buildClient({ source: 'clearnet', pace: { concurrency: 30, delayMs: 0 } }, {});
  assert.equal(pub.concurrency, PRESETS.clearnet.concurrency); assert.equal(pub.delayMs, PRESETS.clearnet.delayMs); assert.equal(pub.keyHint, false);
});
