'use strict';
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const { Graph, ID } = require('../public/js/hopline-model.js');
const An = require('../public/js/hopline-analysis.js');
const RP = require('../public/js/hopline-report.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const sha = (s) => nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex');
const BECH = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';

function tx(n, ins, outs, time, extra) {
  return Object.assign({
    txid: tid(n), fee: 200, weight: 800, version: 2, locktime: 0, status: { confirmed: true, block_height: 700000 + n, block_time: time },
    vin: ins.map(([p, vout, addr, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'v0_p2wpkh', value } })),
    vout: outs.map(([addr, value]) => ({ scriptpubkey_address: addr, scriptpubkey_type: 'v0_p2wpkh', value }))
  }, extra);
}

/** A small graph: tx 2 (later) is added before tx 1 on purpose, tx 1 pays the wallet back (a likely change) and tx 2 is a consolidation. */
function sample() {
  const g = new Graph();
  g.addTx(tx(2, [[80, 0, 'k0', 10000], [81, 0, 'k1', 10000], [82, 0, 'k2', 10000], [83, 0, 'k3', 10000], [84, 0, 'k4', 10000]], [['sink', 49000]], 1650006000));
  g.addTx(tx(1, [[90, 0, 'me', 100000]], [['shop', 60000], ['me', 39000]], 1650000000));
  g.addOutspends(tid(1), [{ spent: true, txid: tid(2), vin: 0, status: { confirmed: true, block_time: 1650006000 } }, { spent: false }]);
  g.nodes.get(ID.tx(tid(1))).source = 'https://mempool.space/api'; g.nodes.get(ID.tx(tid(1))).fetchedAt = 1700000000; g.nodes.get(ID.tx(tid(1))).spendsCheckedAt = 1700000005;
  g.refreshDerived();
  return g;
}

function modelOf(g, over) {
  const an = An.analyse(g, {}), atx = {};
  an.tx.forEach((r, id) => { if (r.flags.length || r.change || r.chain) atx[id] = { flags: r.flags.map((f) => ({ kind: f.kind, short: f.short, title: f.title })), change: r.change && { vout: r.change.vout, edgeId: r.change.edgeId, address: r.change.address, confidence: r.change.confidence, reasons: r.change.reasons }, chain: r.chain }; });
  const nodes = JSON.parse(JSON.stringify(Array.from(g.nodes.values()))), edges = JSON.parse(JSON.stringify(Array.from(g.edges.values())));
  return Object.assign({
    title: 'Case 12', preparedBy: 'A. Analyst', generated: 1700000100000, nodes, edges,
    evidence: { format: 'hopline-workspace', version: 1, nodes, edges, evidence: { counts: { nodes: nodes.length, edges: edges.length } } },
    analysis: { tx: atx, chains: [], clusters: an.clusters.list.map((c) => ({ label: c.label, size: c.size, addrs: c.addrs, txs: c.txs })), skipped: an.clusters.skipped },
    known: () => null, fiat: null, fiatNote: '', image: null, fingerprint: (n) => (An.fingerprint(n) || {}).text || ''
  }, over);
}

test('sha256Hex agrees with node\'s own SHA-256, on text with accents and astral characters', async () => {
  for (const s of ['', 'abc', 'Zürich — 東京 😀', 'x'.repeat(10000)]) assert.equal(await RP.sha256Hex(s), sha(s));
});

test('the report: title, who and when, the findings with reasons, the transactions in time order, and the integrity block', async () => {
  const g = sample(), r = await RP.build(modelOf(g));
  assert.match(r.html, /^<!doctype html>/);
  assert.match(r.html, /<h1>Case 12<\/h1>/); assert.match(r.html, /Prepared by A\. Analyst/); assert.match(r.html, /2023-11-14 22:15:00 UTC/);
  assert.match(r.html, /CONSOL 5→1/); assert.match(r.html, /Consolidation: 5 inputs gathered into 1 output/);
  assert.match(r.html, /Likely change:<\/b> output 1/); assert.match(r.html, /also one of the inputs/); assert.match(r.html, /class="chg"/, 'the change output row is highlighted');
  const order = [...r.html.matchAll(/<section class="tx" id="tx-([0-9a-f]{64})"/g)].map((m) => m[1]);
  assert.deepEqual(order, [tid(1), tid(2)], 'the earlier transaction first although it was loaded second');
  assert.match(r.html, /0\.00060000 BTC/); assert.match(r.html, /spent by <code>/); assert.match(r.html, /unspent/);
  assert.match(r.html, /Retrieved 2023-11-14 22:13:20 UTC from mempool\.space; spent\/unspent status as of 2023-11-14 22:13:25 UTC/);
  assert.match(r.html, /Retrieved at an unknown time/, 'a transaction without provenance says so');
  assert.match(r.html, /Address clusters \(1\)/); assert.match(r.html, /Method and limits/);
  assert.match(r.html, /Wallet habits: version 2/);
});

test('every word that came from outside is escaped; the only script is the inert data block, which cannot end early', async () => {
  const g = sample(), n = g.nodes.get(ID.addr('me'));
  n.label = '<img src=x onerror=alert(1)>Suspect'; n.note = '</script><script>alert(2)</script>'; n.tag = 'THREAT';
  const m = modelOf(g, { title: '<b>Case</b> & "quotes"', preparedBy: "<i>me</i>", fiatNote: '<u>note</u>', known: (a) => (a === 'shop' ? { label: '<svg onload=alert(3)>Shop', pack: '<b>pack</b>', category: '<c>', note: '<n>' } : null) });
  m.nodes.find((x) => x.id === 'tx:' + tid(1)).source = 'https://x.example/api';
  const r = await RP.build(m);
  assert.ok(!/<img src=x/.test(r.html) && !/<svg onload/.test(r.html) && !/<b>Case/.test(r.html) && !/<i>me/.test(r.html) && !/<u>note/.test(r.html) && !/<b>pack/.test(r.html));
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;Suspect') && r.html.includes('&lt;b&gt;Case&lt;/b&gt; &amp; &quot;quotes&quot;'));
  const scripts = r.html.match(/<script[\s>]/g) || [];
  assert.equal(scripts.length, 1); assert.match(r.html, /<script type="application\/json" id="hopline-evidence">/);
  const block = /<script type="application\/json" id="hopline-evidence">(.*?)<\/script>/s.exec(r.html)[1];
  assert.ok(!block.includes('<') && !block.includes('>'), 'no markup characters inside the data block');
  assert.equal(JSON.parse(block).nodes.find((x) => x.id === 'addr:me').note, '</script><script>alert(2)</script>', 'and it still reads back exactly');
});

test('the stated hashes are right: the evidence block, and the whole file with the document hash zeroed', async () => {
  const r = await RP.build(modelOf(sample()));
  const block = /<script type="application\/json" id="hopline-evidence">(.*?)<\/script>/s.exec(r.html)[1];
  assert.equal(block, r.text); assert.equal(sha(block), r.hash);
  assert.match(r.html, new RegExp('id="evidence-hash">' + r.hash + '<'));
  assert.match(r.html, new RegExp('id="document-hash">' + r.docHash + '<'));
  assert.equal(sha(r.html.replace(r.docHash, RP.ZERO)), r.docHash, 'hashing the file with the document hash zeroed gives the document hash');
  assert.notEqual(r.docHash, RP.ZERO);
  const again = await RP.build(modelOf(sample()));
  assert.equal(again.hash, r.hash, 'the same evidence gives the same hash');
  const other = modelOf(sample()); other.evidence.evidence.counts.nodes++;
  assert.notEqual((await RP.build(other)).hash, r.hash);
});

test('fiat values and the picture appear when given, and are absent when not', async () => {
  const m = modelOf(sample(), { fiat: (s) => '$' + (s / 1e8 * 40000).toFixed(2), fiatNote: 'Shown in USD at the price at each transaction\'s own time.', image: 'data:image/png;base64,AAAA' });
  const r = await RP.build(m);
  assert.match(r.html, /\$24\.00/); assert.match(r.html, /<img class="graph" alt="[^"]*" src="data:image\/png;base64,AAAA">/); assert.match(r.html, /Fiat values/);
  const plain = await RP.build(modelOf(sample()));
  assert.ok(!/<img/.test(plain.html) && !/\$24/.test(plain.html) && !/Fiat values/.test(plain.html));
});

test('a long list is cut with a note while the embedded data keeps everything; an empty model still renders', async () => {
  const g = new Graph();
  for (let i = 0; i < 520; i++) g.addTx(tx(1000 + i, [[5000 + i, 0, 'a' + i, 10000]], [['b' + i, 9000]], 1650000000 + i, { txid: (i + 1).toString(16).padStart(64, '0') }));
  g.refreshDerived();
  const m = modelOf(g), r = await RP.build(m);
  assert.equal((r.html.match(/<section class="tx"/g) || []).length, 500); assert.match(r.html, /Only the first 500 of 520 are listed/);
  assert.equal(JSON.parse(/<script type="application\/json" id="hopline-evidence">(.*?)<\/script>/s.exec(r.html)[1]).nodes.filter((x) => x.type === 'tx' && x.loaded).length, 520);
  const empty = await RP.build({ title: '', generated: 0, nodes: [], edges: [], evidence: { nodes: [], edges: [] }, analysis: null });
  assert.match(empty.html, /No loaded transaction in this selection/); assert.match(empty.html, /Hopline investigation report/);
});

test('known wallets, tags and notes get their own table, with the pack named', async () => {
  const g = sample(); g.nodes.get(ID.addr('me')).tag = 'THREAT'; g.nodes.get(ID.addr('me')).note = 'seen twice';
  const r = await RP.build(modelOf(g, { known: (a) => (a === 'shop' ? { label: 'Acme Exchange', pack: 'OFAC-like pack', category: 'EXCH', note: 'listed 2023' } : null) }));
  assert.match(r.html, /Labelled wallets \(2\)/); assert.match(r.html, /known: Acme Exchange \(OFAC-like pack\)/); assert.match(r.html, /\[EXCH\]/); assert.match(r.html, /tag THREAT/); assert.match(r.html, /seen twice/);
});

test('the report lists where the names came from: each pack that names a wallet in it, with its source, licence, credit and date', async () => {
  const g = sample();
  const known = (a) => (a === 'shop' ? { label: 'Acme Exchange', pack: 'List one', claims: [{ label: 'Acme Exchange', pack: 'List one' }, { label: 'Acme', pack: 'List two' }, { label: 'A', pack: '' }] } : null);
  const packs = [{ name: 'List one', source: 'U.S. Treasury <list>', licence: 'Public domain', attribution: 'The Treasury', asOf: '2026-10-21' }, { name: 'List two', source: '', licence: '', attribution: '', asOf: '' },
                 { name: 'Unused list', source: 'nobody', licence: 'x', attribution: 'x', asOf: '2020-01-01' }];
  const r = await RP.build(modelOf(g, { known, packs }));
  assert.match(r.html, /<h3>Sources of the names<\/h3>/);
  assert.match(r.html, /<li>List one - U\.S\. Treasury &lt;list&gt;; licence: Public domain; credit: The Treasury; data as of 2026-10-21<\/li>/);
  assert.match(r.html, /<li>List two<\/li>/, 'a pack that says nothing about itself is still named');
  assert.doesNotMatch(r.html, /Unused list/, 'a pack that names nothing in the report is not listed');
  assert.doesNotMatch((await RP.build(modelOf(g, { known }))).html, /Sources of the names/, 'nothing to list without the packs');
  assert.doesNotMatch((await RP.build(modelOf(g, { known: () => null, packs }))).html, /Sources of the names/, 'and nothing when no pack names a wallet');
});

test('the wallets table has a balance column: what the server reported, with the time, and "not read" otherwise', async () => {
  const g = sample();
  g.addAddressStats('me', { chain_stats: { funded_txo_sum: 139000, spent_txo_sum: 100000, tx_count: 2 }, mempool_stats: { funded_txo_sum: 7000, spent_txo_sum: 0, tx_count: 1 } }, { at: 1700000000, source: 'https://mempool.space/api' });
  const r = await RP.build(modelOf(g));
  assert.match(r.html, /<th>Balance<\/th>/);
  assert.match(r.html, /0\.00039000 BTC<div class="hint">as of 2023-11-14 22:13:20 UTC; \+0\.00007000 BTC unconfirmed<\/div>/s);
  assert.match(r.html, /<span class="hint">not read<\/span>/);
  assert.match(r.html, /its <i>Balance<\/i> is what the server reported for the whole address/);
});

test('a group shown as one vertex is listed in full, with its numbers, and everything in it is escaped', async () => {
  const members = [];
  for (let i = 0; i < 4; i++) members.push({ id: ID.tx(tid(10 + i)), amount: 1000 * (i + 1), time: 1650000000 + i * 60 });
  const m = modelOf(sample(), { groups: [{ id: 'grp:1', text: '4 transactions to <img src=x onerror=alert(1)>', anchor: ID.addr('me'), dir: 'next', kind: 'party', party: ID.addr('x'), count: 4, total: 10000, min: 1000, max: 4000, first: 1650000000, last: 1650000180, members }] });
  const r = await RP.build(m);
  assert.match(r.html, /<h2>Groups shown as one vertex<\/h2>/);
  assert.match(r.html, /4 members · 0\.00010000 BTC in total \(each 0\.00001000 to 0\.00004000\)/);
  members.forEach((x) => assert.ok(r.html.includes(x.id.slice(3)), 'every member is listed'));
  assert.ok(!r.html.includes('<img src=x'), 'the text of a group is escaped');
  assert.match(r.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(r.html, /forward from <code>me<\/code>/);
});

test('with no group the report has no groups section, and a very large group is cut with a note', async () => {
  assert.ok(!(await RP.build(modelOf(sample()))).html.includes('Groups shown as one vertex'));
  const big = []; for (let i = 0; i < 600; i++) big.push({ id: ID.tx(tid(i % 200).slice(0, 63) + String(i % 10)), amount: 1000, time: null });
  const r = await RP.build(modelOf(sample(), { groups: [{ id: 'grp:2', text: '600 transactions', anchor: ID.addr('me'), dir: 'prev', kind: 'small', party: null, count: 600, total: 600000, min: 1000, max: 1000, first: null, last: null, members: big }] }));
  assert.match(r.html, /times unknown · behind <code>me<\/code>/);
  assert.match(r.html, /The first 500 of 600 are listed; the embedded data has them all\./);
});

test('analysisFor: the findings are cut to the vertices that are in the report, so nothing left out comes in through a chain or a cluster', () => {
  const an = An.analyse(sample(), {}), all = RP.analysisFor(an, () => true);
  assert.ok(all.tx[ID.tx(tid(2))].flags.some((f) => f.short.startsWith('CONSOL')), 'the consolidation is found'); assert.equal(all.tx[ID.tx(tid(1))].change.vout, 1, 'and the change');
  assert.equal(all.clusters.length, 1); assert.equal(all.clusters[0].addrs.length, 5);
  const drop = all.clusters[0].addrs[0], cut = RP.analysisFor(an, (id) => id !== ID.tx(tid(2)) && id !== drop && id !== ID.addr('me'));
  assert.ok(!(ID.tx(tid(2)) in cut.tx), 'a transaction that is not in the report has no finding');
  assert.equal(cut.tx[ID.tx(tid(1))].change, null, 'a change output that is not in the report is not named');
  assert.equal(cut.clusters.length, 1); assert.equal(cut.clusters[0].size, 5, 'the size is the whole cluster');
  assert.ok(!cut.clusters[0].addrs.includes(drop) && cut.clusters[0].addrs.length === 4 && cut.clusters[0].txs.length === 0, 'its addresses and transactions are cut to what is in the report');
  const none = RP.analysisFor(an, () => false);
  assert.deepEqual(none, { tx: {}, chains: [], clusters: [] });
});

test('a page can say what made the report and what it covers; the workspace wording is the default', async () => {
  const d = await RP.build(modelOf(sample()));
  assert.match(d.html, /made with Hopline workspace/); assert.match(d.html, /This is what was on screen when the report was made\./);
  const w = await RP.build(modelOf(sample(), { madeWith: 'Hopline wallet', scopeText: 'This is 2 transactions of the wallet <b>me</b>.' }));
  assert.match(w.html, /made with Hopline wallet/); assert.ok(!/made with Hopline workspace/.test(w.html));
  assert.match(w.html, /This is 2 transactions of the wallet &lt;b&gt;me&lt;\/b&gt;\./, 'what the page says is escaped');
  assert.ok(!/This is what was on screen/.test(w.html));
});
