'use strict';
const test = require('node:test');
const assert = require('node:assert');
const X = require('../public/js/hopline-external.js');

// the documented shape (field names from Arkham's published API); NOT captured from a live key
const SAMPLE = { address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', chain: 'bitcoin',
  arkhamEntity: { name: 'Binance', id: 'binance', type: 'cex', note: 'Exchange', website: 'https://binance.com' },
  arkhamLabel: { name: 'Hot Wallet', address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', chainType: 'btc' },
  populatedTags: [{ id: 'cex', label: 'CEX' }, { id: 'hot', label: 'Hot wallet' }], isUserAddress: false, contract: false };

function fakeFetch(handler) {
  const calls = [];
  const f = (url, init) => { calls.push({ url, init }); return Promise.resolve(handler(url, init)); };
  f.calls = calls; return f;
}
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)), json: () => Promise.resolve(body) });

test('parseArkham reads entity, label, tags and website into plain text', () => {
  const p = X.parseArkham(SAMPLE);
  assert.deepEqual([p.found, p.name, p.type, p.label, p.website, p.note], [true, 'Binance', 'cex', 'Hot Wallet', 'https://binance.com', 'Exchange']);
  assert.deepEqual(p.tags, ['CEX', 'Hot wallet']);
});

test('parseArkham is tolerant: nested per-chain replies, synonyms, missing parts, garbage', () => {
  assert.equal(X.parseArkham({ bitcoin: SAMPLE }).name, 'Binance', 'a reply keyed by chain');
  assert.equal(X.parseArkham({ entity: { name: 'X' } }).name, 'X');
  const onlyLabel = X.parseArkham({ arkhamLabel: { name: 'Cold storage' } });
  assert.equal(onlyLabel.found, true); assert.equal(onlyLabel.name, '');
  assert.equal(X.parseArkham({ predictedEntity: { name: 'Maybe Kraken' } }).predicted, 'Maybe Kraken');
  ['', null, undefined, 5, [], {}, { arkhamEntity: null }, { populatedTags: 'x' }, 'text'].forEach((g) => assert.equal(X.parseArkham(g).found, false, JSON.stringify(g)));
  assert.deepEqual(X.parseArkham({ populatedTags: ['a', { id: 'b' }, { label: '' }, 5] }).tags, ['a', 'b', '5']);
});

test('parseArkham makes everything inert text and caps it', () => {
  const p = X.parseArkham({ arkhamEntity: { name: '<img src=x onerror=1>\u0000\n' + 'x'.repeat(500), type: 'cex' } });
  assert.ok(p.name.length <= 200);
  assert.ok(!/[\u0000-\u001F]/.test(p.name));
  assert.equal(typeof p.name, 'string');
  assert.equal(X.parseArkham({ populatedTags: new Array(50).fill('t') }).tags.length, 12);
});

test('tagFor suggests a preset from the entity type or name, and says nothing when unsure', () => {
  assert.equal(X.tagFor('cex', 'Binance'), 'EXCH');
  assert.equal(X.tagFor('', 'Kraken Hot Wallet'), 'EXCH');
  assert.equal(X.tagFor('mixer', 'Tornado'), 'MIXER');
  assert.equal(X.tagFor('hacker', 'Lazarus Group'), 'THREAT');
  assert.equal(X.tagFor('', 'Ransomware wallet'), 'THREAT');
  assert.equal(X.tagFor('market', 'Some Market'), 'MARKET');
  assert.equal(X.tagFor('gambling', 'Stake'), 'GAMBLING');
  assert.equal(X.tagFor('payment-processor', ''), 'SERVICE');
  assert.equal(X.tagFor('individual', 'Some Person'), '');
  assert.equal(X.tagFor('', ''), '');
});

test('toExt keeps the parsed fields, the time, a capped raw copy and the suggestion', () => {
  const e = X.toExt(SAMPLE, 1700000000);
  assert.equal(e.at, 1700000000); assert.equal(e.suggest, 'EXCH'); assert.equal(e.found, true);
  assert.ok(e.raw.startsWith('{') && e.raw.includes('arkhamEntity'));
  const big = X.toExt({ arkhamEntity: { name: 'N' }, pad: 'z'.repeat(20000) }, 1);
  assert.ok(big.raw.length <= X.RAW_LIMIT + 1 && big.raw.endsWith('…'));
  assert.equal(X.toExt({}, 5).found, false);
});

test('cleanExt (import) keeps only the known fields of known sources', () => {
  const clean = X.cleanExt({ arkham: Object.assign(X.toExt(SAMPLE, 9), { evil: '<script>', suggest: 'NOPE' }), other: { x: 1 } });
  assert.deepEqual(Object.keys(clean), ['arkham']);
  assert.equal(clean.arkham.name, 'Binance'); assert.equal(clean.arkham.suggest, '', 'an unknown preset is dropped');
  assert.ok(!('evil' in clean.arkham));
  ['x', null, [], 5, {}, { other: 1 }, { arkham: 'str' }].forEach((v) => assert.equal(X.cleanExt(v), null, JSON.stringify(v)));
  assert.equal(X.cleanExt({ arkham: { name: 'n', at: 'now', tags: 'x' } }).arkham.at, 0);
});

test('lookupArkham asks the proxy for one address with the token and nothing else', async () => {
  const f = fakeFetch(() => resp(200, SAMPLE));
  const r = await X.lookupArkham({ fetch: f, base: 'http://127.0.0.1:8787/', token: 'T0K', address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h' });
  assert.equal(r.found, true); assert.equal(r.ext.name, 'Binance');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8787/intelligence/address/bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h');
  assert.equal(f.calls[0].init.headers['X-Hopline-Token'], 'T0K');
  assert.ok(!JSON.stringify(f.calls[0].init.headers).toLowerCase().includes('api-key'), 'the Arkham key is never in the page');
});

test('lookupArkham: no entry is an answer, not an error; every failure has a kind and a sentence', async () => {
  const base = 'http://127.0.0.1:8787';
  const run = (status, body) => X.lookupArkham({ fetch: fakeFetch(() => resp(status, body)), base, token: 't', address: 'a'.repeat(30) });
  assert.equal((await run(404, { error: 'not found' })).found, false);
  assert.equal((await run(200, {})).found, false);
  await assert.rejects(run(401, { error: 'bad token' }), (e) => e.kind === 'token' && /bad token/.test(e.message));
  await assert.rejects(run(429, { error: 'slow down' }), (e) => e.kind === 'rate');
  await assert.rejects(run(403, { error: 'upstream rejected the API key' }), (e) => e.kind === 'key');
  await assert.rejects(run(502, { error: 'Arkham rejected the API key (HTTP 401)' }), (e) => e.kind === 'key');
  await assert.rejects(run(500, 'oops'), (e) => e.kind === 'upstream' && /HTTP 500/.test(e.message));
  await assert.rejects(run(200, 'not json'), (e) => e.kind === 'bad');
  await assert.rejects(X.lookupArkham({ fetch: () => Promise.reject(new TypeError('NetworkError')), base, token: 't', address: 'a' }), (e) => e.kind === 'proxy' && /arkham_proxy/.test(e.message));
  await assert.rejects(X.lookupArkham({ fetch: fakeFetch(() => resp(200, {})), base: '', token: 't', address: 'a' }), (e) => e.kind === 'proxy');
  await assert.rejects(X.lookupArkham({ fetch: fakeFetch(() => resp(200, {})), base, token: '', address: 'a' }), (e) => e.kind === 'token');
});

test('lookupArkham times out instead of hanging', async () => {
  const hang = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  await assert.rejects(X.lookupArkham({ fetch: hang, base: 'http://127.0.0.1:8787', token: 't', address: 'a', timeoutMs: 30 }), (e) => e.kind === 'timeout');
});

test('proxyHealth reports the proxy state or why it is unreachable', async () => {
  const ok = await X.proxyHealth({ fetch: fakeFetch(() => resp(200, { ok: true, keyConfigured: true, upstream: 'https://api.arkm.com' })), base: 'http://127.0.0.1:8787', token: 't' });
  assert.deepEqual(ok, { ok: true, keyConfigured: true, upstream: 'https://api.arkm.com' });
  await assert.rejects(X.proxyHealth({ fetch: fakeFetch(() => resp(401, {})), base: 'http://x', token: 'bad' }), (e) => e.kind === 'token');
  await assert.rejects(X.proxyHealth({ fetch: () => Promise.reject(new Error('refused')), base: 'http://x', token: 't' }), (e) => e.kind === 'proxy');
});

test('arkhamUrl builds a link to the Arkham page for a wallet or a Bitcoin transaction, and for nothing else', () => {
  const tx = 'ABCDEF' + '0'.repeat(58);
  assert.equal(X.arkhamUrl('address', 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h'), 'https://arkm.com/explorer/address/bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h');
  assert.equal(X.arkhamUrl('address', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'https://arkm.com/explorer/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(X.arkhamUrl('tx', tx), 'https://arkm.com/explorer/tx/' + tx.toLowerCase(), 'a transaction id is written in lower case');
  ['', 'short', 'bc1q/../x' + 'a'.repeat(20), 'javascript:alert(1)aaaaaaaaaaaa', 'a b c d e f g h i j k l m n', null, undefined, 5, {}].forEach((v) => assert.equal(X.arkhamUrl('address', v), '', String(v)));
  ['', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g' + 'a'.repeat(63), null].forEach((v) => assert.equal(X.arkhamUrl('tx', v), '', String(v)));
  assert.equal(X.arkhamUrl('block', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '');
  assert.equal(X.arkhamUrl('address', tx), 'https://arkm.com/explorer/address/' + tx, 'a hex string is also a possible address text: only the kind decides');
  assert.ok(X.ARKHAM_EXPLORER.startsWith('https://') && X.ARKHAM_EXPLORER.endsWith('/'));
});


// ---- one contract for every source -----------------------------------------------------------------------------------
/** A second source that only exists in the test: a service the addresses go to (third: true), or a list asked offline (third: false). */
function fakeSource(over) {
  const calls = [];
  const def = Object.assign({
    id: 'fakelist', name: 'A fake list', short: 'Fake', third: true,
    lookup: (address) => { calls.push(address); return Promise.resolve({ found: address.startsWith('a'), ext: { found: address.startsWith('a'), who: 'Fake ' + address, kind: 'exchange', at: 1700000000, junk: 'x'.repeat(5000) } }); },
    clean: (e) => (e && typeof e === 'object' ? { found: e.found === true, who: String(e.who || '').slice(0, 80), kind: String(e.kind || '').slice(0, 40), at: Number(e.at) || 0 } : null),
    describe: (e) => ({ found: e.found, label: e.who, category: e.kind, tags: ['T1'], at: e.at, suggest: 'EXCH' })
  }, over || {});
  def.calls = calls;
  return def;
}

test('a source is registered with a contract, and one without is refused', () => {
  assert.throws(() => X.register({ id: 'Bad Id', name: 'x', lookup() {}, clean() {}, describe() {} }), /id of lower case/);
  assert.throws(() => X.register({ id: 'nolookup', name: 'x', clean() {}, describe() {} }), /needs a lookup/);
  assert.throws(() => X.register({ id: 'nodescribe', name: 'x', lookup() {}, clean() {} }), /needs a describe/);
  assert.deepEqual(X.list().map((s) => s.id), ['arkham'], 'nothing was added by the refused ones');
  assert.deepEqual(X.list()[0], { id: 'arkham', name: 'Arkham Intelligence', short: 'Arkham', third: true });
});

test('a registered source is kept per wallet, cleaned from a file by its own rules, and described the same way as Arkham', () => {
  const f = fakeSource(); X.register(f);
  try {
    assert.deepEqual(X.list().map((s) => s.id), ['arkham', 'fakelist']);
    const ext = X.cleanExt({ fakelist: { found: true, who: 'Exchange Z', kind: 'exchange', at: 1700000000, junk: 'ignored' }, arkham: { found: true, name: 'Binance', type: 'cex', at: 1700000100 }, unknown: { found: true } });
    assert.deepEqual(Object.keys(ext).sort(), ['arkham', 'fakelist'], 'a source that is not registered is dropped');
    assert.equal(ext.fakelist.junk, undefined, 'and a field the source does not know is dropped');
    const node = { type: 'addr', address: 'bc1qxyz', ext };
    const es = X.entries(node);
    assert.deepEqual(es.map((e) => [e.source, e.sourceName, e.label, e.category, e.found, e.address]), [['arkham', 'Arkham Intelligence', 'Binance', 'cex', true, 'bc1qxyz'], ['fakelist', 'A fake list', 'Exchange Z', 'exchange', true, 'bc1qxyz']]);
    assert.deepEqual(es[1].tags, ['T1']); assert.equal(es[1].suggest, 'EXCH');
    assert.deepEqual(X.entries({ type: 'addr', address: 'a' }), []); assert.deepEqual(X.entries(null), []);
  } finally { X.unregister('fakelist'); }
  assert.deepEqual(X.list().map((s) => s.id), ['arkham']);
  assert.equal(X.cleanExt({ fakelist: { found: true, who: 'x' } }), null, 'once it is gone its entries are not kept');
});

test('lookupMany: a source that sends addresses away is not asked unless the caller says yes, and says what it would send', async () => {
  const f = fakeSource(); X.register(f);
  try {
    let asked = null;
    let r = await X.lookupMany('fakelist', ['a1', 'a1', 'b2'], { ctx: {} });
    assert.deepEqual([r.stopped, r.results.length, f.calls.length], ['declined', 0, 0], 'no confirm(): nothing is sent');
    r = await X.lookupMany('fakelist', ['a1'], { ctx: {}, confirm: () => false });
    assert.deepEqual([r.stopped, f.calls.length], ['declined', 0], 'the caller said no');
    r = await X.lookupMany('fakelist', ['a1'], { ctx: {}, confirm: () => 'yes' });
    assert.equal(r.stopped, 'declined', 'only true counts as yes');
    r = await X.lookupMany('fakelist', ['a1', 'a1', 'b2'], { ctx: {}, confirm: (def, list) => { asked = [def.id, list]; return true; } });
    assert.deepEqual(asked, ['fakelist', ['a1', 'b2']], 'the confirmation sees the source and the addresses, each once');
    assert.deepEqual(f.calls, ['a1', 'b2'], 'one after the other, in order');
    assert.deepEqual(r.results.map((x) => [x.address, x.found]), [['a1', true], ['b2', false]]);
    assert.equal(r.stopped, null);
    assert.ok(r.results[0].ext.junk, 'what comes back is not applied or cleaned here: the caller stores it');
  } finally { X.unregister('fakelist'); }
});

test('lookupMany: an offline source needs no confirmation, an error that would repeat stops the run, one that would not does not', async () => {
  const local = fakeSource({ id: 'locallist', name: 'A local list', third: false }); X.register(local);
  const flaky = fakeSource({ id: 'flaky', name: 'Flaky', lookup: (a) => { flaky.calls.push(a); return a === 'k' ? Promise.reject(Object.assign(new Error('no key'), { kind: 'key' })) : a === 'u' ? Promise.reject(Object.assign(new Error('upstream'), { kind: 'upstream' })) : Promise.resolve({ found: true, ext: { found: true } }); } }); X.register(flaky);
  try {
    let r = await X.lookupMany('locallist', ['a1'], { ctx: {} });
    assert.deepEqual([r.stopped, r.results.length], [null, 1], 'a list on this computer is not a third party');
    r = await X.lookupMany('flaky', ['x', 'u', 'y', 'k', 'z'], { ctx: {}, confirm: () => true });
    assert.deepEqual(flaky.calls, ['x', 'u', 'y', 'k'], 'a failed address is recorded and the run goes on; a rejected key stops it, and z is never sent');
    assert.deepEqual(r.results.map((x) => [x.address, x.error ? x.error.kind : null]), [['x', null], ['u', 'upstream'], ['y', null], ['k', 'key']]);
    assert.equal(r.stopped, 'failed'); assert.equal(r.error.kind, 'key');
    flaky.calls.length = 0; let n = 0;
    r = await X.lookupMany('flaky', ['a', 'b', 'c'], { ctx: {}, confirm: () => true, cancelled: () => n++ >= 1 });
    assert.deepEqual([r.stopped, flaky.calls], ['cancelled', ['a']], 'cancelling stops between two requests');
  } finally { X.unregister('locallist'); X.unregister('flaky'); }
});

test('lookupMany: a source that is not set up says so before anything is sent, and an unknown source is refused', async () => {
  const f = fakeSource({ ready: (ctx) => (ctx.key ? '' : 'Enter the key first.') }); X.register(f);
  try {
    await assert.rejects(X.lookupMany('fakelist', ['a1'], { ctx: {}, confirm: () => assert.fail('asked to confirm a lookup that cannot run') }), (e) => e.kind === 'setup' && /Enter the key/.test(e.message));
    assert.equal(f.calls.length, 0);
    const r = await X.lookupMany('fakelist', ['a1'], { ctx: { key: 'k' }, confirm: () => true });
    assert.equal(r.results.length, 1);
  } finally { X.unregister('fakelist'); }
  await assert.rejects(X.lookupMany('nobody', ['a1'], { confirm: () => true }), /Unknown source/);
  assert.deepEqual(await X.lookupMany('arkham', [], { ctx: { token: 't' }, confirm: () => true }), { results: [], stopped: null, error: null });
});

test('Arkham goes through the same contract: not set up, not confirmed, then one request with the token', async () => {
  await assert.rejects(X.lookupMany('arkham', ['a'.repeat(30)], { ctx: { proxy: 'http://127.0.0.1:8787' }, confirm: () => true }), (e) => e.kind === 'setup' && /lookup proxy/.test(e.message));
  const f = fakeFetch(() => resp(200, SAMPLE)), ctx = { fetch: f, proxy: 'http://127.0.0.1:8787', token: 'T' };
  assert.equal((await X.lookupMany('arkham', ['a'.repeat(30)], { ctx, confirm: () => false })).stopped, 'declined');
  assert.equal(f.calls.length, 0);
  const r = await X.lookupMany('arkham', ['a'.repeat(30)], { ctx, confirm: () => true });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.headers['X-Hopline-Token'], 'T');
  const c = X.describe('arkham', r.results[0].ext);
  assert.deepEqual([c.found, c.label, c.category, c.tags.includes('CEX'), c.suggest], [true, 'Binance · Hot Wallet', 'cex', true, 'EXCH']);
  assert.equal(X.source('arkham').headline(r.results[0].ext), 'Binance (cex)');
  assert.deepEqual(X.source('arkham').fields(r.results[0].ext).map((x) => x[0]), ['Entity', 'Type', 'Label', 'Tags', 'Predicted', 'Website', 'Note']);
});

test('relayUrl builds a link to Relay\'s page for a request ID, and for nothing else', () => {
  const id = '0x' + 'ab'.repeat(32);
  assert.equal(X.relayUrl(id), 'https://relay.link/transaction/' + id);
  assert.equal(X.relayUrl('0x' + 'AB'.repeat(32)), 'https://relay.link/transaction/' + id, 'lower case');
  ['', null, undefined, 42, id + 'a', id.slice(0, -1), 'ab'.repeat(33), '0x' + 'zz'.repeat(32), id + '/../x', 'javascript:alert(1)'].forEach((x) => assert.equal(X.relayUrl(x), '', String(x)));
});
