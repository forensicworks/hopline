'use strict';
// Share links: a canvas in the address (public/js/hopline-share.js). The vertices nearest START, a limit with a warning, and a link made by someone else is checked before it is opened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const S = require('../public/js/hopline-share.js');
const IO = require('../public/js/hopline-io.js');
const { Graph } = require('../public/js/hopline-model.js');
const { buildGraph } = require('./benchmark/lib/cases.js');

/** A path of vertices v0 - v1 - ... - v(n-1): transactions and addresses alternating, each edge pointing the way money moves. */
function path_(n, extra) {
  const g = new Graph();
  for (let i = 0; i < n; i++) g.upsertNode(Object.assign({ id: (i % 2 ? 'addr:a' : 'tx:t') + i, type: i % 2 ? 'addr' : 'tx', address: i % 2 ? 'a' + i : undefined, txid: i % 2 ? undefined : 't' + i, loaded: true }, extra && extra(i)));
  for (let i = 0; i + 1 < n; i++) {
    const a = g.nodes.get(Array.from(g.nodes.keys())[i]), b = g.nodes.get(Array.from(g.nodes.keys())[i + 1]);
    g.upsertEdge(a.type === 'tx' ? { id: 'out:e' + i, source: a.id, target: b.id, kind: 'out', amount: 1000 + i } : { id: 'in:e' + i, source: a.id, target: b.id, kind: 'in', amount: 1000 + i });
  }
  return g;
}
const ids = (g) => Array.from(g.nodes.keys());

test('limitOf: a number between the least and the most, the default for anything else', () => {
  assert.equal(S.limitOf(50), 50); assert.equal(S.limitOf(1), S.MIN_LIMIT); assert.equal(S.limitOf(99999), S.MAX_LIMIT); assert.equal(S.limitOf('80'), 80);
  assert.equal(S.limitOf('x'), S.DEFAULT_LIMIT); assert.equal(S.limitOf(undefined), S.DEFAULT_LIMIT); assert.equal(S.limitOf(12.9), 12);
});

test('nearest: the limit, taken hop by hop from START in either direction', () => {
  const g = path_(21), v = ids(g), mid = v[10];
  const r = S.nearest(g, { starts: [mid], limit: 7 });
  assert.equal(r.kept.size, 7); assert.equal(r.total, 21);
  assert.deepEqual(new Set(r.order), new Set([v[7], v[8], v[9], v[10], v[11], v[12], v[13]]), 'three hops each way');
  assert.equal(r.order[0], mid, 'START first');
});

test('nearest: a ring that does not fit whole is cut, and several starts count as one ring', () => {
  const g = path_(21), v = ids(g);
  const cut = S.nearest(g, { starts: [v[10]], limit: 6 });
  assert.equal(cut.kept.size, 6); assert.ok(cut.kept.has(v[9]) && cut.kept.has(v[11]) && cut.kept.has(v[8]) && cut.kept.has(v[12]), 'two hops each way, then one of the next ring');
  const two = S.nearest(g, { starts: [v[2], v[18]], limit: 8 });
  assert.ok(two.kept.has(v[2]) && two.kept.has(v[18]) && two.kept.has(v[1]) && two.kept.has(v[19]), 'both starts and their neighbours');
  assert.equal(two.kept.size, 8);
});

test('nearest: without a start on screen the first vertex stands in; what is not connected comes last; nothing is bridged through a vertex that is not allowed', () => {
  const g = path_(12), v = ids(g);
  assert.equal(S.nearest(g, { starts: [], limit: 5 }).order[0], v[0]);
  assert.equal(S.nearest(g, { starts: ['tx:gone'], limit: 5 }).order[0], v[0], 'a start that is not in the graph');
  const allowed = new Set(v.filter((id) => id !== v[5]));
  const r = S.nearest(g, { starts: [v[2]], nodes: allowed, limit: 10 });
  assert.equal(r.total, 11); assert.ok(!r.kept.has(v[5]));
  assert.deepEqual(r.order.slice(0, 5), [v[2], v[1], v[3], v[0], v[4]], 'the near side first');
  assert.equal(r.kept.size, 10); assert.ok(r.kept.has(v[6]) && r.kept.has(v[10]) && !r.kept.has(v[11]), 'the far side is reached last, only because room is left, and the limit still holds');
  const cutEdge = S.nearest(g, { starts: [v[2]], edges: new Set(['out:e0', 'in:e1', 'out:e2']), limit: 6 });
  assert.deepEqual(new Set(cutEdge.order.slice(0, 4)), new Set([v[0], v[1], v[2], v[3]]), 'only the allowed edges are followed');
});

test('slim and pack: only the vertices that are kept and the edges between them; no note, no look-ups, no source unless asked', () => {
  const g = path_(30, (i) => ({ label: i === 12 ? 'exchange' : undefined, note: i === 12 ? 'a private thought' : undefined, tag: i === 12 ? 'EXCH' : undefined, ext: { arkham: { x: 1 } }, fetchedAt: 1650000000, statsSource: 'https://x.example/api', source: 'https://x.example/api' }));
  const v = ids(g);
  const p = S.pack(g, { starts: [v[12]], limit: 9, view: null, now: 1700000000000 });
  const d = JSON.parse(p.text);
  assert.equal(d.nodes.length, 9); assert.equal(d.share.kept, 9); assert.equal(d.share.of, 30); assert.equal(p.kept, 9); assert.equal(p.total, 30);
  assert.equal(d.edges.length, 8, 'the path between nine vertices');
  d.edges.forEach((e) => assert.ok(d.nodes.some((n) => n.id === e.source) && d.nodes.some((n) => n.id === e.target)));
  const kept = d.nodes.find((n) => n.id === v[12]);
  assert.equal(kept.label, 'exchange'); assert.equal(kept.tag, 'EXCH'); assert.equal(kept.note, undefined, 'notes stay home by default');
  d.nodes.forEach((n) => { assert.equal(n.ext, undefined); assert.equal(n.fetchedAt, undefined); assert.equal(n.statsSource, undefined); assert.equal(n.source, undefined); });
  assert.equal(JSON.parse(S.pack(g, { starts: [v[12]], limit: 9, notes: true }).text).nodes.find((n) => n.id === v[12]).note, 'a private thought', 'notes when asked');
  assert.equal(d.exported, '2023-11-14T22:13:20.000Z');
});

test('pruneView: the picture settings stay, the reader\'s own do not, and the trace only keeps vertices that are still there', () => {
  const kept = new Set(['tx:a', 'addr:b', 'tx:c']);
  const view = { layout: 'trace', arrange: 'columns', colorBy: 'age', sizeBy: 'area', timeScale: 'compact', hops: 2, focusOn: true, focus: 'tx:z',
                 source: 'tor', fiat: { on: true }, filter: { minAmount: 5 }, hidden: ['tx:a'], routeRef: 'tx:a', vgroups: [{ id: 'x' }], expandRange: { a: 1 },
                 trace: { seed: 'tx:z', seeds: ['tx:z', 'tx:a'], shown: ['tx:a', 'tx:c', 'tx:far'], pos: { 'tx:a': [0, 0], 'tx:c': [200, 0], 'tx:far': [9, 9] },
                          prov: { 'tx:c': ['tx:a', 'next'], 'tx:far': ['tx:a', 'next'], 'addr:b': ['tx:far', 'prev'] }, groups: [{ id: 'g1', members: ['tx:q'] }], seq: 3 } };
  const out = S.pruneView(view, kept);
  assert.deepEqual(Object.keys(out).sort(), ['arrange', 'colorBy', 'focusOn', 'hops', 'layout', 'sizeBy', 'timeScale', 'trace']);
  assert.equal(out.focus, undefined, 'the focus left out is dropped');
  assert.deepEqual(out.trace.shown, ['tx:a', 'tx:c']); assert.deepEqual(out.trace.seeds, ['tx:a']); assert.equal(out.trace.seed, 'tx:a');
  assert.deepEqual(Object.keys(out.trace.pos).sort(), ['tx:a', 'tx:c']); assert.deepEqual(Object.keys(out.trace.prov), ['tx:c']);
  assert.equal(out.trace.groups, undefined, 'folded groups are not carried');
  const none = S.pruneView({ layout: 'trace', trace: { seed: 'tx:z', seeds: ['tx:z'], shown: ['tx:z'], pos: {}, prov: {} } }, kept);
  assert.equal(none.layout, 'flow'); assert.equal(none.trace, undefined, 'a trace with nothing left is a plain canvas');
  assert.equal(S.pruneView(null, kept), null);
});

test('a link made from real chain data: start, limit, and what the reader gets back', async () => {
  const txs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'benchmark/cases/mainnet-sample/txs.json.gz'))));
  const g = buildGraph(txs);
  let start = null; g.nodes.forEach((n) => { if (n.type === 'tx' && g.edgesOf(n.id).length > 30 && g.edgesOf(n.id).length < 60 && !start) start = n.id; });
  assert.ok(start, 'a transaction with a good many connections');
  const one = await S.build(g, { starts: [start], limit: 50 });
  assert.ok(one.fragment.startsWith('#s1/') && /^#s1\/[A-Za-z0-9_-]+$/.test(one.fragment));
  assert.equal(one.kept, 50); assert.ok(one.total > 50 && one.trimmed === true && one.bySize === false, 'over the limit: cut to 50 around START');
  assert.ok(one.chars < 6000, 'about 4,000 characters for 50 vertices on real data (' + one.chars + ')');
  const back = await S.decode(one.fragment);
  assert.equal(back.kept, 50); assert.equal(back.of, one.total);
  const r = IO.fromJson(back.text);
  assert.equal(r.graph.nodes.size, 50); assert.ok(r.graph.nodes.has(start), 'START is in it'); assert.deepEqual(r.warnings, []);
  const small = await S.build(g, { starts: [start], limit: 10 });
  assert.ok(small.chars < one.chars && small.kept === 10);
  const room = await S.build(g, { starts: [start], limit: 500, nodes: new Set(Array.from(r.graph.nodes.keys())) });
  assert.equal(room.kept, 50); assert.equal(room.trimmed, false, 'everything allowed fits: nothing to warn about');
});

test('the text in a link is a workspace file (the same names), so the ordinary import opens it', async () => {
  const g = path_(14), exported = JSON.parse(IO.toJson(g, {}));
  assert.equal(S.FORMAT, exported.format); assert.equal(S.VERSION, exported.version);
  const l = await S.build(g, { starts: [ids(g)[0]], limit: 14 });
  assert.equal(IO.fromJson((await S.decode(l.fragment)).text).graph.edges.size, 13);
});

test('a link that is too long for chat is cut by its length, and one that cannot be cut is refused', async () => {
  const big = (i) => ({ label: crypto.randomBytes(1000).toString('hex') });                  // 2,000 characters that do not compress
  const g = path_(60, big), start = ids(g)[30];
  const r = await S.build(g, { starts: [start], limit: 50 });
  assert.ok(r.chars <= S.MAX_CHARS, 'within the longest link: ' + r.chars);
  assert.ok(r.kept < 50 && r.bySize === true && r.trimmed === true, 'cut by size, not by the limit: ' + r.kept);
  const huge = path_(8, () => ({ label: crypto.randomBytes(10000).toString('hex') }));
  await assert.rejects(S.build(huge, { starts: [ids(huge)[0]], limit: 50 }), /more than the 60000/);
});

test('decode: a link that is not one, is damaged, is a bomb or lies about its size is refused with a reason', async () => {
  const frag = (buf) => S.PREFIX + S.toBase64Url(buf);
  await assert.rejects(S.decode('#f1/tx:abc'), /not a Hopline share link/);
  await assert.rejects(S.decode('#s1/'), /empty/);
  await assert.rejects(S.decode('#s1/abc def'), /characters that do not belong/);
  await assert.rejects(S.decode('#s1/' + 'A'.repeat(200001)), /longer than/);
  const good = await S.build(path_(10), { starts: [ids(path_(10))[0]], limit: 10 });
  await assert.rejects(S.decode(good.fragment.slice(0, Math.floor(good.fragment.length / 2))), /damaged or was cut short/);
  await assert.rejects(S.decode(frag(zlib.deflateRawSync(Buffer.alloc(6000000)))), /more than 4 MB/);
  await assert.rejects(S.decode(frag(zlib.deflateRawSync(Buffer.from('not json at all')))), /damaged: what is inside/);
  await assert.rejects(S.decode(frag(zlib.deflateRawSync(Buffer.from(JSON.stringify({ format: 'something-else', nodes: [], edges: [] }))))), /does not hold a Hopline canvas/);
  const many = JSON.stringify({ format: S.FORMAT, version: 1, nodes: Array.from({ length: 5001 }, (_, i) => ({ id: 'tx:' + i, type: 'tx' })), edges: [] });
  await assert.rejects(S.decode(frag(zlib.deflateRawSync(Buffer.from(many)))), /claims 5001 vertices/);
});

// ---- a link of transaction IDs ------------------------------------------------------------------------------------------------------------------------------------------
const hex = (n) => crypto.createHash('sha256').update('tx' + n).digest('hex');
/** A path of n loaded transactions with an address after each, real-looking txids; transaction 0 is the first. */
function chain_(n, extra) {
  const g = new Graph();
  for (let i = 0; i < n; i++) {
    g.upsertNode(Object.assign({ id: 'tx:' + hex(i), type: 'tx', txid: hex(i), loaded: true }, extra && extra(i)));
    g.upsertNode({ id: 'addr:a' + i, type: 'addr', address: 'a' + i });
    g.upsertEdge({ id: 'out:' + hex(i) + ':0', source: 'tx:' + hex(i), target: 'addr:a' + i, kind: 'out', amount: 1000 });
    if (i) g.upsertEdge({ id: 'in:' + hex(i) + ':0', source: 'addr:a' + (i - 1), target: 'tx:' + hex(i), kind: 'in', amount: 1000 });
  }
  return g;
}

test('packIds: the loaded transactions nearest START first, never an address or a transaction that is only known by its id', () => {
  const g = chain_(12);
  g.upsertNode({ id: 'tx:' + hex(99), type: 'tx', txid: hex(99), loaded: false });              // a stub: the reader sees it as a stub too, it needs no request of its own
  g.upsertEdge({ id: 'out:' + hex(99) + ':0', source: 'tx:' + hex(99), target: 'addr:a5', kind: 'out', amount: 1 });
  const p = S.packIds(g, { starts: ['tx:' + hex(6)] });
  assert.equal(p.ids[0], hex(6), 'START first'); assert.equal(p.total, 12); assert.equal(p.ids.length, 12);
  assert.deepEqual(new Set(p.ids), new Set(Array.from({ length: 12 }, (_, i) => hex(i))), 'twelve transactions, no stub, no address');
  assert.deepEqual(new Set(p.ids.slice(0, 3)), new Set([hex(6), hex(5), hex(7)]), 'then the ones next to it, along the money in either direction');
  assert.deepEqual(Object.keys(p.payload).sort(), ['f', 'format', 'of', 't', 'version', 'view']);
  assert.equal(p.payload.f, 'tx:' + hex(6)); assert.equal(p.payload.of, 12);
});

test('packIds: only what is allowed (on screen), at most the limit, and the place to start is one the link carries', () => {
  const g = chain_(12), v = Array.from(g.nodes.keys());
  const allowed = new Set(v.filter((id) => id !== 'tx:' + hex(9) && id !== 'tx:' + hex(10) && id !== 'tx:' + hex(11)));
  const p = S.packIds(g, { starts: ['tx:' + hex(2)], nodes: allowed, limit: 4 });
  assert.equal(p.total, 9, 'three are hidden'); assert.equal(p.ids.length, 4);
  assert.ok(!p.ids.includes(hex(9)) && !p.ids.includes(hex(11)));
  const far = S.packIds(g, { starts: ['tx:' + hex(11)], nodes: allowed, limit: 4 });
  assert.equal(far.payload.f, null, 'START is not on screen: no place is named');
  const addr = S.packIds(g, { starts: ['addr:a3'], limit: 100 });
  assert.equal(addr.payload.f, 'addr:a3', 'a wallet next to a listed transaction can be where it opens');
  assert.equal(S.packIds(g, { starts: [], limit: 3 }).ids.length, 3);
  assert.equal(S.packIds(new Graph(), { starts: [] }).ids.length, 0);
});

test('idsView: the settings that make the same picture, a trace as the automatic layout, nothing the reader did not choose', () => {
  assert.deepEqual(S.idsView({ layout: 'trace', colorBy: 'age', sizeBy: 'log', timeScale: 'compact', focusOn: true, hops: 2, trace: { seed: 'x' }, hidden: ['tx:a'], fiat: { currency: 'USD' }, filter: { minAmount: 5 }, ext: 1 }),
    { layout: 'flow', colorBy: 'age', sizeBy: 'log', timeScale: 'compact', focusOn: true, hops: 2 });
  assert.deepEqual(S.idsView({ layout: 'x'.repeat(41), colorBy: { a: 1 }, hops: Infinity }), {}, 'long text, objects and numbers that are not numbers are not carried');
  assert.deepEqual(S.idsView(null), {}); assert.deepEqual(S.idsView('layout'), {});
});

test('buildIds and decodeIds: what goes in comes out, in the same order, and a transaction costs about 50 characters', async () => {
  const g = chain_(400), start = 'tx:' + hex(200);
  const r = await S.buildIds(g, { starts: [start], view: { layout: 'trace', colorBy: 'script' } });
  assert.equal(r.kept, 400); assert.equal(r.total, 400); assert.equal(r.trimmed, false);
  assert.ok(r.fragment.startsWith('#i1/') && r.chars === r.fragment.length);
  assert.ok(r.chars / 400 < 55, 'about 45 to 50 characters a transaction: ' + (r.chars / 400).toFixed(1));
  const back = await S.decodeIds(r.fragment);
  assert.equal(back.ids.length, 400); assert.equal(back.ids[0], hex(200)); assert.equal(back.focus, start); assert.equal(back.of, 400);
  assert.deepEqual(back.view, { layout: 'flow', colorBy: 'script' });
  assert.deepEqual(new Set(back.ids), new Set(Array.from({ length: 400 }, (_, i) => hex(i))));
});

test('buildIds: a list too long for chat is cut to the transactions nearest START, and says so; with nothing to list it refuses', async () => {
  const g = chain_(1800), start = 'tx:' + hex(900);
  const r = await S.buildIds(g, { starts: [start] });
  assert.ok(r.chars <= S.MAX_CHARS, 'within the longest link: ' + r.chars);
  assert.ok(r.trimmed && r.kept < 1800 && r.kept > 1000 && r.total === 1800, 'cut by size: ' + r.kept);
  const back = await S.decodeIds(r.fragment);
  assert.equal(back.ids.length, r.kept); assert.equal(back.of, 1800, 'the reader can be told how many the sender had');
  assert.ok(back.ids.includes(hex(900)) && back.ids.includes(hex(901)) && !back.ids.includes(hex(0)) && !back.ids.includes(hex(1799)), 'the far ends are the ones left out');
  await assert.rejects(S.buildIds(new Graph(), {}), /No loaded transaction/);
  const stubs = new Graph(); stubs.upsertNode({ id: 'tx:' + hex(1), type: 'tx', txid: hex(1), loaded: false });
  await assert.rejects(S.buildIds(stubs, {}), /No loaded transaction/);
});

test('decodeIds: a link that is not one, is damaged or lists anything but transaction ids is refused with a reason', async () => {
  const frag = (obj) => S.IDS_PREFIX + S.toBase64Url(zlib.deflateRawSync(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))));
  const ok = { format: 'hopline-ids', version: 1, t: [hex(1), hex(2)], f: null, of: 2, view: {} };
  await assert.rejects(S.decodeIds('#s1/abc'), /not a Hopline link to transactions/);
  await assert.rejects(S.decodeIds('#i1/'), /empty/);
  await assert.rejects(S.decodeIds('#i1/abc def'), /characters that do not belong/);
  await assert.rejects(S.decodeIds('#i1/' + 'A'.repeat(200001)), /longer than/);
  const good = await S.decodeIds(frag(ok)); assert.deepEqual(good.ids, [hex(1), hex(2)]);
  await assert.rejects(S.decodeIds(frag(ok).slice(0, 30)), /damaged or was cut short/);
  await assert.rejects(S.decodeIds(frag('not json at all')), /damaged: what is inside/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { format: 'hopline-workspace' }))), /does not hold a list of transactions/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: 'tx' }))), /does not hold a list of transactions/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: [hex(1), 'zz'.repeat(32)] }))), /not a transaction ID/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: [hex(1).toUpperCase()] }))), /not a transaction ID/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: [hex(1), 7] }))), /not a transaction ID/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: [] }))), /lists no transactions/);
  await assert.rejects(S.decodeIds(frag(Object.assign({}, ok, { t: Array.from({ length: S.MAX_IDS + 1 }, (_, i) => hex(i)) }))), /holds at most 3000/);
  await assert.rejects(S.decodeIds(S.IDS_PREFIX + S.toBase64Url(zlib.deflateRawSync(Buffer.alloc(6000000)))), /more than 4 MB/);
});

test('decodeIds: duplicates are listed once, a made-up focus is dropped, the settings are cleaned, and "of" is believed only when it is at least the list', async () => {
  const frag = (obj) => S.IDS_PREFIX + S.toBase64Url(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj))));
  const base = { format: 'hopline-ids', version: 1, t: [hex(1), hex(2), hex(1)], f: 'tx:' + hex(2), of: 3, view: { layout: 'trace', colorBy: 'age', fiat: { currency: 'USD' }, hops: '2' } };
  const r = await S.decodeIds(frag(base));
  assert.deepEqual(r.ids, [hex(1), hex(2)]); assert.equal(r.focus, 'tx:' + hex(2)); assert.deepEqual(r.view, { layout: 'flow', colorBy: 'age', hops: '2' }); assert.equal(r.of, 3);
  assert.equal((await S.decodeIds(frag(Object.assign({}, base, { f: '<script>alert(1)</script>' })))).focus, null);
  assert.equal((await S.decodeIds(frag(Object.assign({}, base, { f: 'tx:' })))).focus, null);
  assert.equal((await S.decodeIds(frag(Object.assign({}, base, { of: 1 })))).of, null, 'fewer than it lists: not believed');
  assert.equal((await S.decodeIds(frag(Object.assign({}, base, { of: 'many' })))).of, null);
});

test('isIdsHash: only the IDs link\'s own prefix, and the two kinds of link are told apart', () => {
  assert.equal(S.isIdsHash('#i1/abc'), true); assert.equal(S.isIdsHash('#s1/abc'), false); assert.equal(S.isIdsHash('#f1/tx:abc'), false); assert.equal(S.isIdsHash(''), false); assert.equal(S.isIdsHash(null), false); assert.equal(S.isIdsHash('#I1/abc'), false);
  assert.equal(S.isShareHash('#i1/abc'), false, 'an IDs link is not a canvas link');
});

test('isShareHash: only the link\'s own prefix', () => {
  assert.equal(S.isShareHash('#s1/abc'), true); assert.equal(S.isShareHash('#f1/tx:abc'), false); assert.equal(S.isShareHash(''), false); assert.equal(S.isShareHash(null), false); assert.equal(S.isShareHash('#S1/abc'), false);
});
