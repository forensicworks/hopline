'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../public/js/hopline-model.js');
const F = require('../public/js/hopline-find.js');

const A1 = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', A2 = '325gSHHe7UGvzEc9kGx43VqPboXUVwa26i', A3 = '1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9', A4 = 'bc1qprdf80adfz7aekh5nejjfrp3jksc8r929svpxk';
const T1 = 'a1'.repeat(32), T2 = 'b2'.repeat(32);

function graph() {
  const g = new Model.Graph();
  g.upsertNode({ id: 'addr:' + A1, type: 'addr', address: A1, label: 'Suspect Alpha', note: 'seen in case 12 near the harbour', tag: 'THREAT' });
  g.upsertNode({ id: 'addr:' + A2, type: 'addr', address: A2 });
  g.upsertNode({ id: 'addr:' + A3, type: 'addr', address: A3 });
  g.upsertNode({ id: 'addr:' + A4, type: 'addr', address: A4 });
  g.upsertNode({ id: 'tx:' + T1, type: 'tx', txid: T1, height: 730576, label: 'The ransom payment' });
  g.upsertNode({ id: 'tx:' + T2, type: 'tx', txid: T2 });
  g.upsertNode({ id: 'data:x', type: 'data', text: 'Suspect in the OP_RETURN' });
  return g;
}
const KNOWN = { [A2]: { label: 'Binance Hot Wallet', category: 'EXCH', alt: ['OFAC SDN: EXAMPLE GROUP (OFAC SDN list (Bitcoin))'] }, [A3]: { label: 'Case list wallet', pack: 'Case 12 list', note: 'hot' } };
const CLUSTERS = { ['addr:' + A3]: { label: 'C3' }, ['addr:' + A4]: { label: 'C30' } };
const opts = { known: (a) => KNOWN[a] || null, clusterOf: (id) => CLUSTERS[id] || null, tagName: (t) => ({ THREAT: 'Threat actor' })[t] || '' };
const ids = (r) => r.results.map((x) => x.id);
const find = (q, o) => F.search(graph(), q, Object.assign({}, opts, o));

test('a whole id comes first, then ones that start with it, then ones that only contain it', () => {
  assert.deepEqual(ids(find(A1)), ['addr:' + A1], 'the whole address');
  assert.deepEqual(ids(find(A1.slice(0, 12))), ['addr:' + A1], 'its beginning');
  assert.deepEqual(ids(find(A1.slice(10, 20))), ['addr:' + A1], 'a piece from the middle');
  assert.equal(find(T1).results[0].id, 'tx:' + T1);
  assert.equal(find(T1).results[0].why[0].field, 'id');
});

test('case does not matter, and a query shorter than two characters matches nothing', () => {
  assert.deepEqual(ids(find('SUSPECT alpha')), ['addr:' + A1]);
  assert.deepEqual(find('s'), { results: [], total: 0 });
  assert.deepEqual(find('   '), { results: [], total: 0 });
  assert.deepEqual(F.search(new Model.Graph(), 'anything', opts), { results: [], total: 0 }, 'an empty workspace');
});

test('your own label, note and tag are searched, and so is the tag\'s full name', () => {
  assert.deepEqual(ids(find('ransom')), ['tx:' + T1]);
  assert.deepEqual(ids(find('harbour')), ['addr:' + A1]);
  assert.equal(find('harbour').results[0].why[0].field, 'note');
  assert.deepEqual(ids(find('threat')), ['addr:' + A1], 'the short name THREAT');
  assert.deepEqual(ids(find('actor')), ['addr:' + A1], 'the preset name Threat actor');
});

test('names that come from outside are searched: the built-in list, a pack, its category, note and the other names it is listed as', () => {
  assert.deepEqual(ids(find('binance')), ['addr:' + A2]);
  assert.equal(find('binance').results[0].why[0].field, 'known');
  assert.deepEqual(ids(find('exch')), ['addr:' + A2], 'the category');
  assert.deepEqual(ids(find('ofac sdn')), ['addr:' + A2], 'a second claim stored beside the first');
  assert.deepEqual(ids(find('case 12')).sort(), ['addr:' + A1, 'addr:' + A3].sort(), 'the pack name and your own note both say case 12');
});

test('several words must all match, each in any field', () => {
  assert.deepEqual(ids(find('suspect harbour')), ['addr:' + A1], 'the label and the note');
  assert.deepEqual(ids(find('suspect banana')), [], 'one word that matches nothing rules it out');
  assert.deepEqual(ids(find('case list')), ['addr:' + A3], 'pack and name together narrow it');
});

test('a cluster is matched exactly: c3 is not c30', () => {
  assert.deepEqual(ids(find('c3')), ['addr:' + A3]);
  assert.deepEqual(ids(find('C30')), ['addr:' + A4]);
  assert.equal(find('c3').results[0].why[0].field, 'cluster');
});

test('a transaction is found by its block height too', () => {
  assert.deepEqual(ids(find('730576')), ['tx:' + T1]);
  assert.equal(find('730576').results[0].why[0].field, 'block');
});

test('only transactions and wallets are searched', () => {
  assert.ok(!ids(find('op_return')).includes('data:x'));
  assert.deepEqual(ids(find('suspect')), ['addr:' + A1], 'not the OP_RETURN text that happens to say it');
});

test('better matches come first: a whole label beats a label that merely contains the word', () => {
  const g = new Model.Graph();
  g.upsertNode({ id: 'addr:' + A1, type: 'addr', address: A1, label: 'exchange' });
  g.upsertNode({ id: 'addr:' + A2, type: 'addr', address: A2, label: 'a big exchange hot wallet' });
  g.upsertNode({ id: 'addr:' + A3, type: 'addr', address: A3, label: 'exchange two' });
  assert.deepEqual(ids(F.search(g, 'exchange', opts)), ['addr:' + A1, 'addr:' + A3, 'addr:' + A2]);
});

test('the result list is capped and says how many matched in all', () => {
  const g = new Model.Graph();
  for (let i = 0; i < 80; i++) g.upsertNode({ id: 'tx:' + String(i).padStart(64, '0'), type: 'tx', txid: String(i).padStart(64, '0'), label: 'payment ' + i });
  const r = F.search(g, 'payment', opts);
  assert.equal(r.results.length, 50); assert.equal(r.total, 80);
  assert.equal(F.search(g, 'payment', { limit: 5 }).results.length, 5);
});

test('what comes out is plain text: markup in a label is returned as it is, never interpreted', () => {
  const g = new Model.Graph();
  const evil = '<img src=x onerror=window.__pwned=1>';
  g.upsertNode({ id: 'addr:' + A1, type: 'addr', address: A1, label: evil, note: '"><script>1</script>' });
  const r = F.search(g, 'img src', opts).results[0];
  assert.equal(r.label, evil); assert.equal(typeof r.why[0].text, 'string');
});

test('snippet cuts long text around the match and keeps short text whole', () => {
  assert.deepEqual(F.snippet('Binance Hot Wallet', 0, 7, 60), { before: '', hit: 'Binance', after: ' Hot Wallet' });
  const long = 'x'.repeat(80) + 'NEEDLE' + 'y'.repeat(80), s = F.snippet(long, 80, 6, 40);
  assert.equal(s.hit, 'NEEDLE'); assert.ok(s.before.startsWith('…') && s.after.endsWith('…'));
  assert.ok((s.before + s.hit + s.after).length <= 42);
});
