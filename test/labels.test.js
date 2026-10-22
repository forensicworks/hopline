'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph } = require('../public/js/hopline-model.js');
const Labels = require('../public/js/hopline-labels.js');

const BECH = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';              // real addresses from the built-in list: their checksums are valid
const LEGACY = '325gSHHe7UGvzEc9kGx43VqPboXUVwa26i';
const LEGACY2 = '18saWjMCchDTGWunefuDJSWNdz4p6KtfBL';

test('CSV with a header: columns are found by name (and by common aliases), quotes and BOM are handled', () => {
  const csv = '\ufeffAddress,Name,Program,Link,Remarks\r\n' + BECH + ',"Binance, hot wallet",EXCH,https://example.org/a,"line one\nline two"\r\n' + LEGACY + ',FTX,,,\r\n';
  const p = Labels.parse(csv, 'my-pack.csv');
  assert.equal(p.name, 'my-pack.csv'); assert.equal(p.entries.length, 2);
  assert.deepEqual(p.entries[0], { address: BECH, label: 'Binance, hot wallet', category: 'EXCH', url: 'https://example.org/a', note: 'line one line two' });
  assert.equal(p.entries[1].label, 'FTX'); assert.equal(p.entries[1].url, '');
});

test('CSV without a header: two columns are address and label', () => {
  const p = Labels.parse(BECH + ',Exchange A\n' + LEGACY + ',Exchange B\n');
  assert.deepEqual(p.entries.map((e) => [e.address, e.label]), [[BECH, 'Exchange A'], [LEGACY, 'Exchange B']]);
});

test('a label pack made when the project was called Orion still imports', () => {
  const p = Labels.parse(JSON.stringify({ format: 'orion-labels', name: 'Old pack', labels: [{ address: BECH, label: 'Suspect A' }] }), 'old.json');
  assert.equal(p.name, 'Old pack'); assert.equal(p.entries.length, 1); assert.equal(p.entries[0].label, 'Suspect A');
});

test('JSON: the pack format, a bare list, a list of pairs, and an address-to-label map', () => {
  const pack = Labels.parse(JSON.stringify({ format: 'hopline-labels', name: 'Case 12 wallets', source: 'our own notes', labels: [{ address: BECH, label: 'Suspect A', category: 'THREAT' }] }), 'x.json');
  assert.equal(pack.name, 'Case 12 wallets'); assert.equal(pack.source, 'our own notes'); assert.equal(pack.entries[0].category, 'THREAT');
  assert.equal(Labels.parse(JSON.stringify([{ addr: LEGACY, entity: 'FTX' }])).entries[0].label, 'FTX');
  assert.equal(Labels.parse(JSON.stringify([[LEGACY2, 'Coinbase']])).entries[0].address, LEGACY2);
  const map = Labels.parse(JSON.stringify({ [BECH]: 'Binance', [LEGACY]: { label: 'FTX', note: 'collapsed 2022' } }));
  assert.deepEqual(map.entries.map((e) => e.label).sort(), ['Binance', 'FTX']); assert.equal(map.entries.find((e) => e.address === LEGACY).note, 'collapsed 2022');
});

test('addresses are checked: a bad checksum, another chain and a repeat are counted and left out; bech32 is lower-cased', () => {
  const bad = LEGACY.slice(0, -1) + (LEGACY.slice(-1) === 'a' ? 'b' : 'a');
  const p = Labels.parse('address,label\n' + BECH.toUpperCase() + ',Upper\n' + bad + ',Typo\n0x742d35Cc6634C0532925a3b844Bc454e4438f44e,Ethereum\n' + BECH + ',Again\n' + LEGACY2 + ',' + '\n');
  assert.deepEqual(p.entries.map((e) => [e.address, e.label]), [[BECH, 'Upper']]);
  assert.deepEqual(p.skipped, { invalid: 1, otherChain: 1, empty: 1, duplicate: 1 });
});

test('nothing usable is an error that says why', () => {
  assert.throws(() => Labels.parse('address,label\n0x742d35Cc6634C0532925a3b844Bc454e4438f44e,Ethereum\n'), /not Bitcoin addresses/);
  assert.throws(() => Labels.parse(''), /empty/);
  assert.throws(() => Labels.parse('{ not json'), /JSON/);
  assert.throws(() => Labels.parse('{"labels": []}'), /No usable/);
});

test('text from a file is cleaned: control characters, bidirectional overrides and over-long text, and links must be plain http(s)', () => {
  const evil = 'Name\u0000\u0007\u202eevil\u2066 spoof\u2069 ' + 'x'.repeat(300);
  const p = Labels.parse(JSON.stringify([{ address: BECH, label: evil, category: 'c'.repeat(100), url: 'javascript:alert(1)', note: 'n'.repeat(900) }]));
  const e = p.entries[0];
  assert.ok(!/[\u0000-\u001f\u202e\u2066\u2069]/.test(e.label)); assert.equal(e.label.length, 120);
  assert.equal(e.category.length, 40); assert.equal(e.url, ''); assert.equal(e.note.length, 500);
  assert.equal(Labels.cleanUrl('https://ok.example/path?q=1'), 'https://ok.example/path?q=1');
  assert.equal(Labels.cleanUrl('https://x.example/"><img src=x>'), ''); assert.equal(Labels.cleanUrl('ftp://x.example'), '');
});

test('hostile keys cannot pollute prototypes', () => {
  const p = Labels.parse('{"__proto__": {"polluted": "yes"}, "constructor": "x", "' + BECH + '": "Binance"}');
  assert.equal(({}).polluted, undefined); assert.equal(p.entries.length, 1);
});

test('export: JSON and CSV round-trip, and spreadsheet formulas are defused', () => {
  const entries = [{ address: BECH, label: '=HYPERLINK("http://x")', category: 'THREAT', url: 'https://example.org', note: 'a, "quoted"\nnote' }, { address: LEGACY, label: 'FTX', category: '', url: '', note: '' }];
  const back = Labels.parse(Labels.toJson(entries, { name: 'Mine', now: 0 }));
  assert.equal(back.name, 'Mine'); assert.equal(back.entries.length, 2); assert.equal(back.entries[0].note, 'a, "quoted" note');
  const csv = Labels.toCsv(entries);
  assert.match(csv, /^address,label,category,url,note\r\n/); assert.ok(csv.includes("'=HYPERLINK"), 'a leading = would run as a formula in a spreadsheet');
  assert.equal(Labels.parse(csv).entries[1].label, 'FTX');
});

test('your own labels, tags and notes on wallets become a pack; other vertices and bare wallets do not', () => {
  const g = new Graph();
  g.upsertNode({ id: 'addr:' + BECH, type: 'addr', address: BECH, label: 'Suspect A', tag: 'THREAT' });
  g.upsertNode({ id: 'addr:' + LEGACY, type: 'addr', address: LEGACY, tag: 'EXCH' });
  g.upsertNode({ id: 'addr:' + LEGACY2, type: 'addr', address: LEGACY2 });
  g.upsertNode({ id: 'tx:' + 'a'.repeat(64), type: 'tx', txid: 'a'.repeat(64), label: 'a transaction' });
  const out = Labels.fromGraph(g);
  assert.deepEqual(out.map((e) => [e.address, e.label, e.category]).sort(), [[BECH, 'Suspect A', 'THREAT'], [LEGACY, 'EXCH', 'EXCH']].sort());
});

test('parseStored reads the packs kept in the browser, caps them and survives damage; buildKnown merges them under the built-in names', () => {
  const stored = JSON.stringify([
    { id: 'p1', name: 'Case list', source: 'https://example.org/x', enabled: true, entries: [['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', 'Pack name', 'EXCH', 'https://example.org/ref', 'a note'], ['bad'], 5] },
    { id: 'p2', name: 'Off', enabled: false, entries: [['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'Hidden']] },
    null, { name: '<b>x</b>' }
  ]);
  const packs = Labels.parseStored(stored);
  assert.equal(packs.length, 4); assert.equal(packs[0].entries.length, 1, 'the damaged entries are dropped');
  assert.equal(packs[0].entries[0].label, 'Pack name'); assert.equal(packs[0].stored, true); assert.equal(packs[1].enabled, false);
  assert.deepEqual(Labels.parseStored(''), []); assert.deepEqual(Labels.parseStored('{not json'), []); assert.deepEqual(Labels.parseStored('{"a":1}'), []);
  const base = { 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h': { label: 'Built-in name' } };
  const known = Labels.buildKnown(base, packs);
  assert.equal(known['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h'].label, 'Built-in name', 'the built-in name wins');
  assert.deepEqual(known['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h'].alt, ['Pack name (Case list)'], 'and the pack is shown as another claim');
  assert.equal(known['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'], undefined, 'a pack that is switched off adds nothing');
  assert.equal(base['bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h'].alt, undefined, 'the base list is not changed');
  const fresh = Labels.buildKnown({}, [{ name: 'P', enabled: true, entries: [{ address: 'x', label: 'L', category: 'C', url: '', note: '' }] }]);
  assert.deepEqual(fresh.x, { label: 'L', pack: 'P', category: 'C', url: undefined, note: undefined });
});
