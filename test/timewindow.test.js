'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TW = require('../public/js/hopline-timewindow.js');
const X = require('../public/js/hopline-external.js');

// The facts are made up. The transaction is in block 1000, time T0; the block before it was found ten minutes earlier. It pays 5 sat/vB.
const T0 = 1794000000, TXID = 'aa'.repeat(32);
const block = (height, over) => Object.assign({ height, time: T0 - 600 * (1000 - height), weight: 2000000, txCount: 1500, p25: null }, over);
const facts = (over) => Object.assign({ found: true, at: T0 + 5000, source: 'mempool.space', height: 1000, blockTime: T0, vsize: 200, fee: 1000, locktime: 0, seqFinal: false, prev: [block(999)], lock: null }, over);

test('infer: a block before that had room says the transaction was not waiting when it was built', () => {
  const i = TW.infer(facts());
  assert.deepEqual([i.found, i.by, i.afterBlock, i.afterWhy, i.rate], [true, T0, 999, 'room', 5]);
  assert.equal(i.after, T0 - 600 - TW.MARGIN, 'the time of that block, less the margin');
  assert.deepEqual([i.notBefore, i.window], [i.after, 600 + TW.MARGIN]);
  assert.equal(i.signedAfter, null);
});

test('infer: a full block counts only when the transaction paid well above what a quarter of its transactions paid', () => {
  const full = (p25) => facts({ prev: [block(999, { weight: 3990000, p25 })] });
  assert.equal(TW.infer(full(2)).afterWhy, 'above', '5 sat/vB against a quarter paying 2 or less');
  assert.equal(TW.infer(full(0.4)).afterWhy, 'above', 'under 1 sat/vB counts as 1: the transaction must pay 1.2 times that');
  const near = TW.infer(facts({ fee: 450, prev: [block(999, { weight: 3990000, p25: 2 })] }));      // 2.25 sat/vB: under 2 x 1.2 = 2.4
  assert.deepEqual([near.after, near.tried], [null, [{ block: 999, why: 'full' }]]);
  const unknown = TW.infer(full(null));
  assert.deepEqual([unknown.after, unknown.tried], [null, [{ block: 999, why: 'nofees' }]], 'a full block whose cheap end is not known says nothing');
});

test('infer: the next block back is used when the nearest cannot be, and a block that says nothing is named', () => {
  const i = TW.infer(facts({ prev: [block(999, { txCount: 1 }), block(998, { time: T0 - 1300 })] }));
  assert.deepEqual([i.afterBlock, i.after, i.tried], [998, T0 - 1300 - TW.MARGIN, [{ block: 999, why: 'empty' }]]);
  const order = TW.infer(facts({ prev: [block(999, { time: T0 + 5 }), block(998)] }));
  assert.deepEqual(order.tried, [{ block: 999, why: 'order' }], 'a time stamp that is not earlier than the transaction\'s block is not trusted');
  assert.equal(order.afterBlock, 998);
  const none = TW.infer(facts({ prev: [block(999, { txCount: 1 }), block(998, { weight: 3990000 })] }));
  assert.deepEqual([none.after, none.notBefore, none.window, none.tried.map((t) => t.why)], [null, null, null, ['empty', 'nofees']]);
});

test('infer: a fee under what nodes relay, or an unknown fee, gets no window even from an empty block', () => {
  assert.deepEqual(TW.infer(facts({ fee: 100 })).tried, [{ block: 999, why: 'lowrate' }]);
  assert.equal(TW.infer(facts({ fee: null })).after, null);
  assert.deepEqual(TW.infer(facts({ fee: 100, prev: [] })).tried, [{ block: null, why: 'lowrate' }], 'and when no block was asked for, the fee is why');
  assert.deepEqual(TW.infer(facts({ prev: [] })).tried, [], 'nothing asked, nothing to say: not a reason');
});

test('infer: a locktime that is the height of a block says the transaction was signed after it, and the later reading wins', () => {
  const lock = { height: 998, time: T0 - 1250 };
  const both = TW.infer(facts({ locktime: 998, lock }));
  assert.deepEqual([both.signedBlock, both.signedAfter, both.after], [998, T0 - 1250 - TW.MARGIN, T0 - 600 - TW.MARGIN]);
  assert.equal(both.notBefore, both.after, 'the later of the two');
  const onlyLock = TW.infer(facts({ locktime: 998, lock, prev: [] }));
  assert.deepEqual([onlyLock.after, onlyLock.notBefore, onlyLock.window], [null, T0 - 1250 - TW.MARGIN, 1250 + TW.MARGIN]);
  const no = (over) => TW.infer(facts(Object.assign({ locktime: 998, lock, prev: [] }, over))).signedAfter;
  assert.equal(no({ locktime: 0 }), null, 'no locktime');
  assert.equal(no({ seqFinal: true }), null, 'a final sequence ignores the locktime: it was not set to be one');
  assert.equal(no({ locktime: 1000, lock: { height: 1000, time: T0 } }), null, 'a locktime at or above its own block cannot be');
  assert.equal(no({ locktime: 799, lock: { height: 799, time: T0 - 99999 } }), null, 'more than ' + TW.LOCK_SPAN + ' blocks below: a deliberate lock, not the height at signing');
  assert.equal(no({ lock: { height: 997, time: T0 - 1850 } }), null, 'the block that was looked up is not the one the locktime names');
  assert.equal(no({ lock: null }), null);
});

test('infer says nothing for what is not a found transaction', () => {
  [null, undefined, {}, { found: false }, { found: true }, { found: true, blockTime: 'x' }].forEach((e) => {
    const i = TW.infer(e); assert.deepEqual([i.found, i.after, i.signedAfter, i.notBefore, i.window], [false, null, null, null, null], JSON.stringify(e));
  });
});

test('whyText and rows put it in words, with the block, the time and the rates', () => {
  const e = facts({ prev: [block(999, { weight: 3990000, p25: 2 })], locktime: 998, lock: { height: 998, time: T0 - 1250 } });
  const why = TW.whyText('above', e.prev[0], e, 5);
  assert.ok(why.includes('Block 999') && why.includes('5 sat/vB') && why.includes('2 sat/vB') && why.includes('well above'));
  assert.ok(TW.whyText('room', block(999), e, 5).includes('had room left'));
  assert.ok(TW.whyText('lowrate', undefined, e, 0.5).includes('0.5 sat/vB'));
  ['empty', 'order', 'full', 'nofees', 'nodata', 'anything'].forEach((w) => assert.ok(TW.whyText(w, block(999), e, 5).length > 10, w));
  assert.deepEqual(TW.rows(e).map((r) => r[0]), ['Not before', 'Not after', 'Window', 'From the blocks before', 'From its locktime']);
  const lockRow = TW.rows(e).find((r) => r[0] === 'From its locktime')[1];
  assert.ok(lockRow.includes('if its wallet sets the locktime') && lockRow.startsWith('about ' + TW.utcText(T0 - 1250 - TW.MARGIN)), 'the assumption is said, and the reading has its own time');
  assert.ok(TW.rows(e).find((r) => r[0] === 'Not before')[1].includes('the later of the two readings below'), 'with two readings the later one is said to be the one that counts');
  assert.ok(TW.rows(e).find((r) => r[0] === 'From the blocks before')[1].startsWith('about ' + TW.utcText(T0 - 600 - TW.MARGIN) + '. Block 999'));
  const single = TW.rows(facts());
  assert.ok(!single.find((r) => r[0] === 'Not before')[1].includes('later of') && single.find((r) => r[0] === 'From the blocks before')[1].startsWith('Block 999'), 'with one reading there is nothing to choose between');
  assert.deepEqual(TW.rows(facts({ fee: 100, prev: [] })).map((r) => r[0]), ['The blocks before']);
  assert.deepEqual(TW.rows({ found: false }), []);
  assert.ok(TW.EXPLAIN.includes('not a measurement'));
});

test('clean keeps only the facts it knows, with sane numbers, and at most three blocks', () => {
  const ok = TW.clean(facts({ locktime: 998, lock: { height: 998, time: T0 - 1250 }, prev: [block(999), block(998), block(997), block(996)] }));
  assert.equal(ok.found, true); assert.equal(ok.prev.length, 3, 'three at most'); assert.deepEqual(ok.lock, { height: 998, time: T0 - 1250 });
  const withReading = TW.clean(Object.assign(facts(), { junk: 1, after: 5, notBefore: 5, window: 5, signedAfter: 5 }));
  assert.deepEqual([withReading.junk, withReading.after, withReading.notBefore, withReading.window, withReading.signedAfter], [undefined, undefined, undefined, undefined, undefined], 'a field it does not know is dropped, and a reading is not a fact: it is worked out again');
  const bad = TW.clean(facts({ prev: [block(999), { height: 5, time: 'x' }, null, { height: -1, time: T0 }, block(998, { weight: -5, txCount: 'many', p25: 'x' })] }));
  assert.deepEqual(bad.prev.map((b) => b.height), [999, 998]);
  assert.deepEqual([bad.prev[1].weight, bad.prev[1].txCount, bad.prev[1].p25], [null, null, null]);
  assert.equal(TW.clean(facts({ height: null })).found, false, 'no height, no transaction');
  assert.equal(TW.clean(facts({ blockTime: 5 })).found, false, 'a time before 2009 is not a time');
  assert.equal(TW.clean(facts({ lock: { height: 998, time: 5 } })).lock, null);
  assert.equal(TW.clean(facts({ source: '<b>x</b>.org' })).source, 'bxb.org', 'only the characters of a host name survive');
  ['', null, 5, [], 'x'].forEach((v) => assert.equal(TW.clean(v), null));
});

// ---- asking the data source ----------------------------------------------------------------------------------------------------------
const hash = (n) => String(n % 100).padStart(2, '0').repeat(32);
function client(routes) {
  const calls = [];
  return { calls, get(path) { calls.push(path); const v = routes[path]; return v === undefined ? Promise.reject(Object.assign(new Error('HTTP 404 for ' + path), { kind: 'notfound' })) : Promise.resolve(v); } };
}
function chain(from, to, over) {
  const r = {};
  for (let h = from; h <= to; h++) { r['/block-height/' + h] = hash(h); r['/block/' + hash(h)] = Object.assign({ timestamp: T0 - 600 * (1000 - h), weight: 2000000, tx_count: 1500 }, over && over[h]); }
  return r;
}
const vertex = (over) => Object.assign({ id: 'tx:' + TXID, type: 'tx', txid: TXID, loaded: true, confirmed: true, height: 1000, time: T0, fee: 1000, vsize: 200, locktime: 998, seqs: [4294967293] }, over);
const ctxOf = (c, n) => ({ client: c, host: 'mempool.space', node: () => n });

test('lookup asks for the block before, and for the block its locktime names, and keeps the facts', async () => {
  const c = client(chain(997, 999));
  const r = await TW.lookup(TXID, ctxOf(c, vertex()));
  assert.deepEqual(c.calls, ['/block-height/999', '/block/' + hash(999), '/block-height/998', '/block/' + hash(998)], 'one request for the hash, one for the block; nothing about fees when it had room');
  const e = r.ext;
  assert.deepEqual([r.found, e.found, e.height, e.blockTime, e.vsize, e.fee, e.locktime, e.seqFinal, e.source], [true, true, 1000, T0, 200, 1000, 998, false, 'mempool.space']);
  assert.deepEqual(e.prev, [block(999)]);
  assert.deepEqual(e.lock, { height: 998, time: T0 - 1200 });
  assert.ok(Math.abs(e.at - Date.now() / 1000) < 60);
  assert.equal(TW.infer(e).signedBlock, 998);
  assert.equal(TW.clean(JSON.parse(JSON.stringify(e))).lock.height, 998, 'what it keeps is what clean accepts');
});

test('lookup: a full block is asked for its fee percentiles, a source without them is carried on from, and a locktime block already fetched is not fetched twice', async () => {
  const routes = chain(996, 999, { 999: { weight: 3990000 } });
  routes['/v1/block/' + hash(999)] = { extras: { feeRange: [0, 1, 2, 3, 4, 5, 90] } };
  const c = client(routes);
  const e = (await TW.lookup(TXID, ctxOf(c, vertex({ locktime: 0 })))).ext;
  assert.deepEqual(c.calls, ['/block-height/999', '/block/' + hash(999), '/v1/block/' + hash(999)]);
  assert.deepEqual([e.prev.length, e.prev[0].p25, TW.infer(e).afterWhy], [1, 2, 'above'], 'the 25th percentile is the third value, and 5 sat/vB is well above it');
  const c2 = client(chain(996, 999, { 999: { weight: 3990000 } }));                       // no /v1/block: Blockstream, an own Esplora
  const e2 = (await TW.lookup(TXID, ctxOf(c2, vertex({ locktime: 998 })))).ext;
  assert.deepEqual(e2.prev.map((b) => [b.height, b.p25]), [[999, null], [998, null]], 'it went on to the block before, which had room');
  assert.equal(TW.infer(e2).afterBlock, 998);
  assert.equal(c2.calls.filter((p) => p === '/block-height/998').length, 1, 'block 998 is also the locktime block: asked for once');
  assert.deepEqual(e2.lock, { height: 998, time: T0 - 1200 });
});

test('lookup stops after three blocks, asks nothing for a final sequence or a fee no block can help, and refuses what is not in a block', async () => {
  const empty = chain(990, 999, { 999: { tx_count: 1 }, 998: { tx_count: 1 }, 997: { tx_count: 1 }, 996: { tx_count: 1 } });
  const c = client(empty);
  const e = (await TW.lookup(TXID, ctxOf(c, vertex({ locktime: 0 })))).ext;
  assert.deepEqual(e.prev.map((b) => b.height), [999, 998, 997], 'three at most');
  assert.equal(c.calls.length, 6);
  const c2 = client(chain(997, 999));
  const e2 = (await TW.lookup(TXID, ctxOf(c2, vertex({ seqs: [4294967295], locktime: 998 })))).ext;
  assert.equal(e2.seqFinal, true); assert.equal(e2.lock, null); assert.equal(c2.calls.length, 2, 'the block before only');
  const c3 = client({});
  const e3 = (await TW.lookup(TXID, ctxOf(c3, vertex({ fee: 100, locktime: 0 })))).ext;
  assert.deepEqual([c3.calls.length, e3.prev.length, TW.infer(e3).tried], [0, 0, [{ block: null, why: 'lowrate' }]]);
  const refuse = async (n, ctx) => TW.lookup(TXID, ctx || ctxOf(c3, n)).then(() => 'ok', (e) => e.kind);
  assert.equal(await refuse(null), 'bad'); assert.equal(await refuse(vertex({ loaded: false })), 'bad'); assert.equal(await refuse(vertex({ confirmed: false })), 'bad');
  assert.equal(await refuse(vertex({ height: undefined })), 'bad'); assert.equal(await refuse(vertex({ time: undefined })), 'bad'); assert.equal(await refuse(vertex({ type: 'addr' })), 'bad');
  assert.equal(await refuse(null, { node: () => vertex() }), 'setup', 'no data source');
  assert.equal(c3.calls.length, 0, 'nothing was asked for any of them');
});

test('lookup passes on what the data source says: a bad hash, a missing block, a failure', async () => {
  const bad = client({ '/block-height/999': 'not a hash' });
  assert.equal(await TW.lookup(TXID, ctxOf(bad, vertex())).then(() => 'ok', (e) => e.kind), 'bad');
  const gone = client({});
  assert.equal(await TW.lookup(TXID, ctxOf(gone, vertex())).then(() => 'ok', (e) => e.kind), 'notfound');
  const noTime = client({ '/block-height/999': hash(999), ['/block/' + hash(999)]: { weight: 1 } });
  assert.equal(await TW.lookup(TXID, ctxOf(noTime, vertex())).then(() => 'ok', (e) => e.kind), 'bad');
});

// ---- in the registry ---------------------------------------------------------------------------------------------------------------
test('chainwindow is a source of the registry that asks no third party, is described in words and is kept only on a transaction', async () => {
  const def = X.source('chainwindow');
  assert.deepEqual([def.kind, def.third, def.short], ['tx', false, 'Block data']);
  const c = client(chain(997, 999));
  let asked = 0;
  const r = await X.lookupMany('chainwindow', [TXID], { ctx: ctxOf(c, vertex()), confirm: () => { asked++; return false; } });
  assert.deepEqual([r.stopped, asked, r.results.length, r.results[0].found], [null, 0, 1, true], 'nobody is asked for leave: nothing leaves this computer');
  const ext = X.cleanExt({ chainwindow: r.results[0].ext }, 'tx');
  const node = { type: 'tx', txid: TXID, time: T0, ext };
  const [e] = X.entries(node);
  assert.deepEqual([e.source, e.found, e.category, e.txid], ['chainwindow', true, 'Time window', TXID]);
  assert.equal(e.label, 'not before about ' + TW.utcText(T0 - 600 - TW.MARGIN));
  assert.equal(def.headline(ext.chainwindow), 'not before about ' + TW.utcText(T0 - 780) + ' (a window of 13 min 0 s)');
  assert.equal(def.useful(ext.chainwindow), true);
  assert.equal(def.useful(TW.clean(facts({ fee: 100, prev: [] }))), false);
  assert.equal(X.cleanExt({ chainwindow: r.results[0].ext }, 'addr'), null, 'not on a wallet');
  assert.deepEqual(X.timeRows([node]), [], 'the table of first-seen times is for the sources that say so');
  const none = X.entries({ type: 'tx', txid: TXID, ext: { chainwindow: TW.clean(facts({ fee: 100, prev: [] })) } })[0];
  assert.deepEqual([none.found, none.label, none.none], [false, 'no window', 'no window']);
  assert.ok(def.explain().includes('not a measurement') && def.fields(ext.chainwindow).length >= 4);
});

test('reportRows lists the readings with their reasons, in the order of the vertices, for the report', () => {
  const nodes = [{ type: 'tx', txid: 'a', ext: { chainwindow: TW.clean(facts({ locktime: 998, lock: { height: 998, time: T0 - 1250 } })) } },
                 { type: 'tx', txid: 'b', ext: { chainwindow: TW.clean(facts({ fee: 100, prev: [] })) } }, { type: 'tx', txid: 'c' }, { type: 'addr', ext: { chainwindow: facts() } }, null];
  const rows = TW.reportRows(nodes);
  assert.deepEqual(rows.map((r) => r.txid), ['a', 'b']);
  assert.deepEqual([rows[0].notBefore, rows[0].window, rows[0].afterBlock, rows[0].signedBlock, rows[0].blockTime], [T0 - 600 - TW.MARGIN, 600 + TW.MARGIN, 999, 998, T0]);
  assert.deepEqual([rows[0].after, rows[0].signedAfter], [T0 - 600 - TW.MARGIN, T0 - 1250 - TW.MARGIN], 'each reading with its own time');
  assert.ok(rows[0].because.includes('had room left'));
  assert.deepEqual([rows[1].notBefore, rows[1].window], [null, null]);
  assert.ok(rows[1].because.includes('under what nodes relay'));
});
