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

// ---- BlockCypher: when a transaction was first seen. The reply shape is the documented one (received, confirmed, relayed_by); the sample is made up, not copied from a case.
const BC_TX = 'ab'.repeat(32);
const bcReply = (over) => Object.assign({ hash: BC_TX, block_height: 840123, confirmed: '2026-03-04T10:24:49Z', received: '2026-03-04T10:21:32.652Z', relayed_by: '203.0.113.9:8333', double_spend: false, confirmations: 894 }, over);
const secs = (iso) => Date.parse(iso) / 1000;

test('parseBlockcypher: a first-seen time needs a record from before the block, and the block time repeated is no record', () => {
  const seen = X.parseBlockcypher(bcReply());
  assert.deepEqual([seen.found, seen.seen, seen.confirmed, seen.relay, seen.height], [true, true, secs('2026-03-04T10:24:49Z'), '203.0.113.9:8333', 840123]);
  assert.equal(seen.received, secs('2026-03-04T10:21:32.652Z'), 'to the millisecond');
  const echo = X.parseBlockcypher(bcReply({ received: '2026-03-04T10:24:49Z', relayed_by: null }));
  assert.deepEqual([echo.found, echo.seen, echo.received, echo.relay], [true, false, null, ''], 'received equal to the block time: BlockCypher learned of it from its block');
  const pending = X.parseBlockcypher(bcReply({ confirmed: undefined, block_height: -1, relayed_by: '' }));
  assert.deepEqual([pending.seen, pending.height, pending.confirmed], [true, null, null], 'a transaction not in a block: its received time is a first-seen time');
  assert.equal(X.parseBlockcypher(bcReply({ confirmed: '2026-03-04T10:20:00Z', relayed_by: null })).seen, true, 'seen after the (earlier) time stamp of its block is still a real record');
  ['', null, undefined, 5, [], {}, 'x', { hash: 'nothex' }].forEach((g) => assert.equal(X.parseBlockcypher(g).found, false, JSON.stringify(g)));
  assert.equal(X.parseBlockcypher(bcReply({ received: 'yesterday' })).seen, false, 'not a time');
  assert.equal(X.parseBlockcypher(bcReply({ received: '1970-01-01T00:00:05Z' })).seen, false, 'a time before 2009 is not a time');
});

test('relayText keeps an address and a port and nothing else', () => {
  ['1.2.3.4:8333', '1.2.3.4', '[2001:db8::1]:8333', '2001:db8::1', 'abcdefghijklmnop.onion:8333'].forEach((v) => assert.equal(X.relayText(v), v, v));
  ['', null, undefined, 5, '<script>alert(1)</script>', '1.2.3.4:99999999', '1.2.3.4; drop', 'javascript:alert(1)', 'x'.repeat(100), '1.2.3'].forEach((v) => assert.equal(X.relayText(v), '', String(v)));
});

test('utcText and gapText say a time and a length in words', () => {
  assert.equal(X.utcText(secs('2026-03-04T10:21:32.652Z')), '2026-03-04 10:21:32 UTC');
  assert.equal(X.utcText(null), '');
  assert.deepEqual([45, 984, 3900, 90000].map(X.gapText), ['45 s', '16 min 24 s', '1 h 5 min', '25 h 0 min']);
});

test('toBlockcypherExt keeps the parsed fields, the time it was asked and a capped raw copy', () => {
  const e = X.toBlockcypherExt(bcReply(), 1700000000);
  assert.deepEqual([e.found, e.seen, e.at], [true, true, 1700000000]);
  assert.ok(e.raw.includes('"relayed_by":"203.0.113.9:8333"') && e.raw.length <= X.RAW_LIMIT + 1);
  assert.ok(X.toBlockcypherExt(bcReply({ junk: 'x'.repeat(9000) }), 1).raw.length <= X.RAW_LIMIT + 1);
});

test('cleanExt keeps a BlockCypher entry only on a transaction, and only what it knows', () => {
  const ok = X.toBlockcypherExt(bcReply(), 1700000000);
  const tx = X.cleanExt({ blockcypher: Object.assign({}, ok, { junk: 1, relay: '<b>x</b>' }) }, 'tx');
  assert.equal(tx.blockcypher.junk, undefined); assert.equal(tx.blockcypher.relay, '', 'a peer that is not an address is dropped');
  assert.equal(X.cleanExt({ blockcypher: ok }, 'addr'), null, 'not on a wallet');
  assert.equal(X.cleanExt({ arkham: { found: true, name: 'x', type: 'cex', at: 1 } }, 'tx'), null, 'a wallet source is not kept on a transaction');
  assert.equal(X.cleanExt({ blockcypher: { found: true, seen: true, received: null } }, 'tx').blockcypher.seen, false, 'seen needs a time');
  assert.equal(X.cleanExt({ blockcypher: Object.assign({}, ok, { received: 5 }) }, 'tx').blockcypher.seen, false, 'a time outside 2009 to 2100 is not a time');
  assert.equal(X.cleanExt({ blockcypher: Object.assign({}, ok, { seen: false }) }, 'tx').blockcypher.relay, '', 'no first-seen record, no peer');
});

test('lookupBlockcypher asks for one transaction, sends no cookies and no referrer, and every failure has a kind', async () => {
  const f = fakeFetch(() => resp(200, bcReply()));
  const r = await X.lookupBlockcypher({ fetch: f, txid: BC_TX.toUpperCase() });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.blockcypher.com/v1/btc/main/txs/' + BC_TX + '?limit=1');
  assert.equal(f.calls[0].init.credentials, 'omit'); assert.equal(f.calls[0].init.referrerPolicy, 'no-referrer');
  assert.deepEqual([r.found, r.ext.seen, r.ext.relay], [true, true, '203.0.113.9:8333']);
  assert.ok(r.ext.raw.includes('relayed_by'), 'the reply as it came');
  assert.equal((await X.lookupBlockcypher({ fetch: fakeFetch(() => resp(404, { error: 'not found' })), txid: BC_TX })).found, false, 'unknown to it is an answer, not an error');
  const kind = (handler) => X.lookupBlockcypher({ fetch: handler, txid: BC_TX }).then(() => 'ok', (e) => e.kind);
  assert.equal(await kind(() => Promise.resolve(resp(429, { error: 'Limits reached.' }))), 'rate');
  assert.equal(await kind(() => Promise.resolve(resp(500, 'x'))), 'upstream');
  assert.equal(await kind(() => Promise.resolve(resp(200, 'not json'))), 'bad');
  assert.equal(await kind(() => Promise.reject(new Error('offline'))), 'network');
  const g = fakeFetch(() => resp(200, {}));
  assert.equal(await X.lookupBlockcypher({ fetch: g, txid: 'abc' }).then(() => 'ok', (e) => e.kind), 'bad'); assert.equal(g.calls.length, 0, 'nothing is sent for what is not a transaction id');
  const hang = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  await assert.rejects(X.lookupBlockcypher({ fetch: hang, txid: BC_TX, timeoutMs: 30 }), (e) => e.kind === 'timeout');
});

test('the address asked is built in one place: sent in the request, kept with the lookup, and given for the report', async () => {
  const want = 'https://api.blockcypher.com/v1/btc/main/txs/' + BC_TX + '?limit=1';
  assert.equal(X.blockcypherUrl(BC_TX.toUpperCase()), want, 'lower case, the endpoint and the one transaction');
  assert.equal(X.blockcypherUrl(BC_TX, 'https://example.test/api/'), 'https://example.test/api/txs/' + BC_TX + '?limit=1', 'another base, with no double slash');
  const f = fakeFetch(() => resp(200, bcReply()));
  const r = await X.lookupBlockcypher({ fetch: f, txid: BC_TX });
  assert.equal(r.ext.url, f.calls[0].url, 'the address kept is the address that was sent');
  assert.equal(r.ext.url, want);
  const viaBase = fakeFetch(() => resp(200, bcReply()));
  const mirror = await X.lookupBlockcypher({ fetch: viaBase, txid: BC_TX, base: 'https://example.test/api/' });
  assert.equal(viaBase.calls[0].url, 'https://example.test/api/txs/' + BC_TX + '?limit=1', 'a base that is given is the one asked');
  assert.equal(mirror.ext.url, viaBase.calls[0].url, 'and the one kept');
  const unknown = await X.lookupBlockcypher({ fetch: fakeFetch(() => resp(404, { error: 'not found' })), txid: BC_TX });
  assert.equal(unknown.ext.url, want, 'an answer of "unknown" was asked for at an address too');
  assert.equal(X.cleanExt({ blockcypher: r.ext }, 'tx').blockcypher.url, want, 'it survives a file');
  ['http://api.blockcypher.com/x', 'javascript:alert(1)', 'https://a b', 'https://x/<script>', 'https://' + 'a'.repeat(300), 5, null, ''].forEach((u) =>
    assert.equal('url' in X.cleanExt({ blockcypher: Object.assign({}, r.ext, { url: u }) }, 'tx').blockcypher, false, 'not kept: ' + String(u).slice(0, 30)));
  assert.equal('url' in X.toBlockcypherExt(bcReply(), 1), false, 'a lookup that does not say where it asked has no address');
  const node = (blockcypher) => ({ type: 'tx', txid: BC_TX, time: 1, ext: { blockcypher } });
  assert.equal(X.timeRows([node(r.ext)])[0].url, want);
  assert.equal(X.timeRows([node(X.toBlockcypherExt(bcReply(), 1))])[0].url, want, 'a lookup made before the address was kept: the address that was always asked');
  const other = 'https://example.test/v9/txs/' + BC_TX;
  assert.equal(X.timeRows([node(Object.assign({}, r.ext, { url: other }))])[0].url, other, 'what was recorded wins over what is built now');
});

// ---- Blockchain.com: the second source of first-seen times
const BI_BLOCK = secs('2026-03-04T10:24:49Z');                                           // the time of the block, as the data source gives it
const biReply = (over) => Object.assign({ hash: BC_TX, ver: 2, size: 235, relayed_by: '0.0.0.0', time: BI_BLOCK - 197, block_height: 840123, double_spend: false, inputs: [{ index: 0 }], out: [{ n: 0 }] }, over);

test('parseBlockchaincom: its time is a first-seen time only when it differs from the time of the block, and it names no peer', () => {
  const seen = X.parseBlockchaincom(biReply(), BI_BLOCK);
  assert.deepEqual([seen.found, seen.seen, seen.received, seen.confirmed, seen.height], [true, true, BI_BLOCK - 197, BI_BLOCK, 840123]);
  const echo = X.parseBlockchaincom(biReply({ time: BI_BLOCK }), BI_BLOCK);
  assert.deepEqual([echo.found, echo.seen, echo.received], [true, false, null], 'the time of the block repeated: no record from before it');
  const pending = X.parseBlockchaincom(biReply({ block_height: undefined }), null);
  assert.deepEqual([pending.seen, pending.received, pending.confirmed, pending.height], [true, BI_BLOCK - 197, null, null], 'not in a block yet: its time is a first-seen time');
  assert.equal(X.parseBlockchaincom(biReply({ time: BI_BLOCK + 60 }), BI_BLOCK).seen, true, 'seen after the (earlier) time stamp of its block is still a real record');
  ['', null, undefined, 5, [], {}, 'x', { hash: 'nothex' }].forEach((g) => assert.equal(X.parseBlockchaincom(g, BI_BLOCK).found, false, JSON.stringify(g)));
  assert.equal(X.parseBlockchaincom(biReply({ time: 'yesterday' }), BI_BLOCK).seen, false, 'not a time');
  assert.equal(X.parseBlockchaincom(biReply({ time: 5 }), BI_BLOCK).seen, false, 'a time before 2009 is not a time');
  assert.ok(!('relay' in seen), 'it names no peer: the 0.0.0.0 it sends is not read');
});

test('toBlockchaincomExt keeps the parsed fields, when it was asked, the address and the reply without its long lists; cleanExt keeps only what is known', () => {
  const e = X.toBlockchaincomExt(biReply(), BI_BLOCK, 1700000000, X.blockchaincomUrl(BC_TX));
  assert.deepEqual([e.found, e.seen, e.at, e.url], [true, true, 1700000000, 'https://blockchain.info/rawtx/' + BC_TX]);
  assert.ok(e.raw.includes('"relayed_by":"0.0.0.0"') && !e.raw.includes('"inputs"') && !e.raw.includes('"out"'), 'the reply as it came, but not the inputs and outputs the graph already has');
  assert.ok(X.toBlockchaincomExt(biReply({ junk: 'x'.repeat(9000) }), BI_BLOCK, 1).raw.length <= X.RAW_LIMIT + 1);
  const kept = X.cleanExt({ blockchaincom: Object.assign({}, e, { junk: 1, relay: '203.0.113.9:8333', url: 'javascript:alert(1)' }) }, 'tx');
  assert.equal(kept.blockchaincom.junk, undefined);
  assert.equal(kept.blockchaincom.relay, '', 'no peer, whatever a file says');
  assert.equal('url' in kept.blockchaincom, false, 'an address that is not a plain https address is dropped');
  assert.equal(X.cleanExt({ blockchaincom: e }, 'tx').blockchaincom.url, e.url, 'and a good one is kept');
  assert.equal(X.cleanExt({ blockchaincom: e }, 'addr'), null, 'not on a wallet');
  assert.equal(X.cleanExt({ blockchaincom: { found: true, seen: true, received: null } }, 'tx').blockchaincom.seen, false, 'seen needs a time');
});

test('lookupBlockchaincom asks for one transaction, sends no cookies and no referrer, keeps the address, and every failure has a kind', async () => {
  const f = fakeFetch(() => resp(200, biReply()));
  const r = await X.lookupBlockchaincom({ fetch: f, txid: BC_TX.toUpperCase(), blockTime: BI_BLOCK });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://blockchain.info/rawtx/' + BC_TX);
  assert.equal(f.calls[0].init.credentials, 'omit'); assert.equal(f.calls[0].init.referrerPolicy, 'no-referrer');
  assert.deepEqual([r.found, r.ext.seen, r.ext.received, r.ext.url], [true, true, BI_BLOCK - 197, f.calls[0].url], 'the address kept is the address that was sent');
  const unknown = await X.lookupBlockchaincom({ fetch: fakeFetch(() => resp(404, { error: 'not-found-or-invalid-arg' })), txid: BC_TX, blockTime: BI_BLOCK });
  assert.deepEqual([unknown.found, unknown.ext.seen, unknown.ext.url], [false, false, 'https://blockchain.info/rawtx/' + BC_TX], 'unknown to it is an answer, not an error');
  const kind = (handler) => X.lookupBlockchaincom({ fetch: handler, txid: BC_TX }).then(() => 'ok', (e) => e.kind);
  assert.equal(await kind(() => Promise.resolve(resp(429, 'slow down'))), 'rate');
  assert.equal(await kind(() => Promise.resolve(resp(500, 'x'))), 'upstream');
  assert.equal(await kind(() => Promise.resolve(resp(200, 'not json'))), 'bad');
  assert.equal(await kind(() => Promise.reject(new Error('offline'))), 'network');
  const g = fakeFetch(() => resp(200, {}));
  assert.equal(await X.lookupBlockchaincom({ fetch: g, txid: 'abc' }).then(() => 'ok', (e) => e.kind), 'bad'); assert.equal(g.calls.length, 0, 'nothing is sent for what is not a transaction id');
  const hang = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  await assert.rejects(X.lookupBlockchaincom({ fetch: hang, txid: BC_TX, timeoutMs: 30 }), (e) => e.kind === 'timeout');
  const viaBase = fakeFetch(() => resp(200, biReply()));
  const mirror = await X.lookupBlockchaincom({ fetch: viaBase, txid: BC_TX, base: 'https://example.test/x/' });
  assert.equal(viaBase.calls[0].url, 'https://example.test/x/rawtx/' + BC_TX, 'a base that is given is the one asked');
  assert.equal(mirror.ext.url, viaBase.calls[0].url, 'and the one kept');
});

test('the source takes the block time from the transaction on screen, so one reply is a first-seen time for one block time and none for another', async () => {
  const src = X.source('blockchaincom');
  const asked = (node) => src.lookup(BC_TX, Object.assign({ fetch: fakeFetch(() => resp(200, biReply())) }, node ? { node: () => node } : {}));
  assert.equal((await asked({ time: BI_BLOCK })).ext.seen, true);
  assert.equal((await asked({ time: BI_BLOCK - 197 })).ext.seen, false, 'the block is at the time it gives: no record from before the block');
  assert.equal((await asked(null)).ext.seen, true, 'no transaction on screen, no block time: its time is a first-seen time');
  assert.equal((await asked({ time: null })).ext.seen, true, 'a transaction not in a block yet');
});

test('the second source is a third party for transactions, asked slowly, and gives the address it asks', () => {
  const d = X.source('blockchaincom');
  assert.deepEqual([d.kind, d.third, d.report, d.host, d.name], ['tx', true, 'firstseen', 'blockchain.info', 'Blockchain.com']);
  assert.ok(d.paceMs >= 700, 'a service with a request limit is asked slowly');
  assert.equal(d.url(BC_TX), 'https://blockchain.info/rawtx/' + BC_TX);
  assert.notEqual(d.manyId, X.source('blockcypher').manyId, 'its own button for a selection');
  assert.equal(X.list('tx').filter((s) => s.third !== false).length, 2, 'two services that need a tick');
});

test('firstSeen gives the earliest time any service recorded on a transaction, and the report rows keep the two services apart', () => {
  const bc = X.toBlockcypherExt(bcReply({ received: '2026-03-04T10:21:32.652Z' }), 1);
  const bi = X.toBlockchaincomExt(biReply({ time: secs('2026-03-04T10:21:30Z') }), BI_BLOCK, 1);
  const f = X.firstSeen({ blockcypher: bc, blockchaincom: bi });
  assert.deepEqual([f.time, f.source, f.sourceName], [secs('2026-03-04T10:21:30Z'), 'blockchaincom', 'Blockchain.com'], 'the earlier of the two');
  const echo = X.toBlockchaincomExt(biReply({ time: BI_BLOCK }), BI_BLOCK, 1);
  assert.equal(X.firstSeen({ blockcypher: bc, blockchaincom: echo }).source, 'blockcypher', 'one with no record does not count');
  assert.equal(X.firstSeen({ blockchaincom: echo }), null, 'none recorded');
  assert.equal(X.firstSeen(null), null); assert.equal(X.firstSeen({ arkham: { seen: true, received: 5 } }), null, 'only a source of first-seen times counts');
  const rows = X.timeRows([{ type: 'tx', txid: BC_TX, time: BI_BLOCK, ext: { blockcypher: bc, blockchaincom: bi } }]);
  assert.deepEqual(rows.map((r) => [r.source, r.sourceName, r.seen, r.relay, r.url]),
                   [['blockcypher', 'BlockCypher', true, '203.0.113.9:8333', X.blockcypherUrl(BC_TX)], ['blockchaincom', 'Blockchain.com', true, '', 'https://blockchain.info/rawtx/' + BC_TX]]);
});

test('sources are for wallets or for transactions: list, entries and the file each keep to their own kind', () => {
  assert.deepEqual(X.list().map((s) => s.id), ['arkham']); assert.deepEqual(X.list('tx').map((s) => s.id), ['blockcypher', 'blockchaincom', 'chainwindow']); assert.deepEqual(X.list('all').map((s) => s.id), ['arkham', 'blockcypher', 'blockchaincom', 'chainwindow']);
  assert.throws(() => X.register({ id: 'odd', name: 'x', kind: 'block', lookup() {}, clean() {}, describe() {} }), /wallets \(addr\) or for transactions \(tx\)/);
  const ext = X.cleanExt({ blockcypher: X.toBlockcypherExt(bcReply(), 1700000000) }, 'tx');
  const txNode = { type: 'tx', txid: BC_TX, time: secs('2026-03-04T10:24:49Z'), ext };
  assert.deepEqual(X.entries(txNode).map((e) => [e.source, e.sourceName, e.found, e.txid, e.address, e.label, e.category]), [['blockcypher', 'BlockCypher', true, BC_TX, undefined, 'first seen 2026-03-04 10:21:32 UTC', 'Broadcast time']]);
  assert.ok(!X.entries(txNode)[0].label.includes('203.0.113'), 'the peer is not in the one-line text that goes into the CSV');
  const echo = X.cleanExt({ blockcypher: X.toBlockcypherExt(bcReply({ received: '2026-03-04T10:24:49Z', relayed_by: null }), 1700000000) }, 'tx');
  const none = X.entries({ type: 'tx', txid: BC_TX, ext: echo })[0];
  assert.deepEqual([none.found, none.label, none.none], [false, 'no first-seen record', 'no first-seen record']);
  assert.deepEqual(X.entries({ type: 'addr', address: 'bc1qx', ext }), [], 'a wallet does not show a transaction source');
  const rows = X.timeRows([txNode, { type: 'addr', ext }, { type: 'tx', txid: 'z' }, null]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].txid, rows[0].time, rows[0].source, rows[0].seen, rows[0].relay, rows[0].at], [BC_TX, secs('2026-03-04T10:24:49Z'), 'blockcypher', true, '203.0.113.9:8333', 1700000000]);
});

test('lookupMany with a transaction source: asks only after a yes, waits between requests, and stops at the limit keeping what it has', async () => {
  const ids = ['1', '2', '3', '4'].map((c) => c.repeat(64));
  let n = 0;
  const f = fakeFetch((url) => (++n === 3 ? resp(429, { error: 'Limits reached.' }) : resp(200, bcReply({ hash: url.split('/txs/')[1].split('?')[0] }))));
  const declined = await X.lookupMany('blockcypher', ids, { ctx: { fetch: f }, confirm: () => false });
  assert.equal(declined.stopped, 'declined'); assert.equal(f.calls.length, 0, 'nothing was sent');
  const waits = [], said = [];
  const r = await X.lookupMany('blockcypher', ids, { ctx: { fetch: f }, confirm: (d, keys) => { said.push([d.id, keys.length]); return true; }, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
  assert.deepEqual(said, [['blockcypher', 4]], 'the caller is told what would be sent');
  assert.equal(r.stopped, 'failed'); assert.equal(r.error.kind, 'rate');
  assert.equal(r.results.filter((x) => !x.error).length, 2, 'the two answered before the limit are kept');
  assert.deepEqual(waits, [700, 700], 'a pause between requests, none after the failure');
  assert.equal(f.calls.length, 3, 'and the fourth was not asked');
});

test('relayHost gives the address of a peer without its port or brackets, to paste into another tool, and nothing for what is not a peer', () => {
  assert.deepEqual(['203.0.113.9:8333', '203.0.113.9', '[2001:db8::1]:8333', '[2001:db8::1]', '2001:db8::1', 'abcdefghijklmnop.onion:8333', 'abcdefghijklmnop.onion'].map(X.relayHost),
                   ['203.0.113.9', '203.0.113.9', '2001:db8::1', '2001:db8::1', '2001:db8::1', 'abcdefghijklmnop.onion', 'abcdefghijklmnop.onion']);
  ['', null, undefined, 5, '<b>1.2.3.4</b>', '1.2.3.4; drop', 'javascript:alert(1)', '1.2.3'].forEach((v) => assert.equal(X.relayHost(v), '', String(v)));
  const fields = X.source('blockcypher').fields(X.parseBlockcypher({ hash: 'ab'.repeat(32), received: '2026-03-04T10:21:32.652Z', confirmed: '2026-03-04T10:24:49Z', relayed_by: '203.0.113.9:8333' }));
  const peer = fields.find((r) => r[0] === 'Peer that passed it on');
  assert.deepEqual([peer[1], peer[2]], ['203.0.113.9:8333', '203.0.113.9'], 'the card gets the text to copy as the third value of the row');
  assert.ok(fields.filter((r) => r[2]).length === 1, 'and no other row has one');
});
