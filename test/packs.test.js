'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Labels = require('../public/js/hopline-labels.js');
const Packs = require('../public/js/hopline-packs.js');

const A = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';              // real addresses from the built-in list: their checksums are valid
const B = '325gSHHe7UGvzEc9kGx43VqPboXUVwa26i';

const good = { id: 'ofac-sdn', name: 'OFAC SDN list (Bitcoin)', file: 'ofac-sdn.js', entries: 532, source: 'OFAC', licence: 'Public domain (U.S. government work)', attribution: 'OFAC',
               asOf: '2026-10-21', sourceUrl: 'https://sanctionslist.ofac.treas.gov/Home/SdnList', sanctions: true, defaultOn: true, version: '98b382bfad' };

test('cleanIndex keeps a well-formed list entry whole', () => {
  assert.deepEqual(Packs.cleanIndex([good]), [good]);
});

test('cleanIndex leaves out anything that could point outside packs/ or is not a list entry', () => {
  const bad = [null, 'x', 5, [], {}, Object.assign({}, good, { id: 'Bad Id' }), Object.assign({}, good, { id: '../x' }), Object.assign({}, good, { id: 'a', file: '../ofac-sdn.js' }),
               Object.assign({}, good, { id: 'b', file: 'https://example.org/x.js' }), Object.assign({}, good, { id: 'c', file: 'index.js' }), Object.assign({}, good, { id: 'd', file: 'x.json' }),
               Object.assign({}, good, { id: 'e', name: '   ' })];
  assert.deepEqual(Packs.cleanIndex(bad), []);
  assert.deepEqual(Packs.cleanIndex(undefined), []); assert.deepEqual(Packs.cleanIndex({ id: 'x' }), []);
});

test('cleanIndex cleans the text and numbers, drops a bad date, link or version, and keeps each id once', () => {
  const [p] = Packs.cleanIndex([Object.assign({}, good, { name: 'Line\nbreak‮', licence: 'L'.repeat(200), asOf: '2026-13-40', sourceUrl: 'javascript:alert(1)', version: '../v', entries: -4, sanctions: 'yes', defaultOn: 1 })]);
  assert.equal(p.name, 'Line break'); assert.equal(p.licence.length, 80); assert.equal(p.asOf, ''); assert.equal(p.sourceUrl, ''); assert.equal(p.version, '');
  assert.equal(p.entries, 0); assert.equal(p.sanctions, false); assert.equal(p.defaultOn, false);
  assert.equal(Packs.cleanIndex([good, Object.assign({}, good, { name: 'Again' })]).length, 1, 'the first one with an id wins');
  const many = []; for (let i = 0; i < 40; i++) many.push(Object.assign({}, good, { id: 'p' + i, file: 'p' + i + '.js' }));
  assert.equal(Packs.cleanIndex(many).length, 20);
});

test('a pack is on as it ships unless the visitor chose', () => {
  const on = { id: 'a', defaultOn: true }, off = { id: 'b', defaultOn: false };
  assert.equal(Packs.isOn(on, {}), true); assert.equal(Packs.isOn(off, {}), false); assert.equal(Packs.isOn(on, undefined), true);
  assert.equal(Packs.isOn(on, { a: false }), false); assert.equal(Packs.isOn(off, { b: true }), true);
  assert.equal(Packs.isOn(on, Object.create({ a: false })), true, 'only the visitor\'s own choices count');
});

test('cleanChoices keeps only true and false for ids of the right shape', () => {
  assert.deepEqual(Packs.cleanChoices({ 'ofac-sdn': false, other: true, 'Bad Id': true, num: 1, s: 'true', __proto__x: true }), { 'ofac-sdn': false, other: true });
  assert.deepEqual(Packs.cleanChoices(null), {}); assert.deepEqual(Packs.cleanChoices([true]), {}); assert.deepEqual(Packs.cleanChoices('x'), {});
});

test('your own import of the same name replaces the shipped pack; a shipped pack that is off or not loaded does not count', () => {
  const ship = [{ name: 'OFAC', enabled: true, loaded: true }, { name: 'Off', enabled: false, loaded: true }, { name: 'Loading', enabled: true, loaded: false }, { name: 'Other', enabled: true, loaded: true }];
  assert.deepEqual(Packs.active(ship, []).map((p) => p.name), ['OFAC', 'Other']);
  assert.deepEqual(Packs.active(ship, [{ name: 'OFAC', enabled: true }]).map((p) => p.name), ['Other']);
  assert.deepEqual(Packs.active(ship, [{ name: 'OFAC', enabled: false }]).map((p) => p.name), ['OFAC', 'Other'], 'a switched-off import replaces nothing');
  assert.equal(Packs.shadowed(ship[0], [{ name: 'OFAC', enabled: true }]), true); assert.equal(Packs.shadowed(ship[0], undefined), false);
  assert.deepEqual(Packs.active(undefined, undefined), []);
});

test('staleness says how old a pack is once it is two months old, and nothing before', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(Packs.staleness('2026-10-21', now), ''); assert.equal(Packs.staleness('2026-08-27', now), '', '59 days');
  assert.equal(Packs.staleness('2026-08-26', now), 'about 2 months old'); assert.equal(Packs.staleness('2025-10-25', now), 'about 12 months old');
  assert.equal(Packs.staleness('', now), ''); assert.equal(Packs.staleness('not a date', now), ''); assert.equal(Packs.staleness('2027-01-01', now), '', 'a date in the future is not old');
});

// ---- load: a stand-in for the page, with a document that runs a script's code when it is added -----------------------------
function fakeWindow(behave) {
  const win = { HOPLINE_PACKS: {}, added: [] };
  win.document = { createElement: () => ({ parentNode: null }), head: { appendChild(s) { s.parentNode = win.document.head; win.added.push(s); setTimeout(() => behave(s, win), 0); }, removeChild(s) { s.parentNode = null; } } };
  return win;
}
const data = { format: 'hopline-labels', version: 1, name: 'Whatever', sanctions: true, licence: 'Public domain', asOf: '2026-10-21', labels: [{ address: A, label: 'Name A' }, { address: B, label: 'Name B' }, { address: 'junk', label: 'Skipped' }] };

test('load adds the pack file as a script next to the page, reads the pack through the label checks, and removes the script and the loaded copy', async () => {
  const win = fakeWindow((s, w) => { w.HOPLINE_PACKS['ofac-sdn'] = JSON.parse(JSON.stringify(data)); s.onload(); });
  const r = await Packs.load(good, win);
  assert.equal(win.added.length, 1); assert.equal(win.added[0].src, 'packs/ofac-sdn.js?v=98b382bfad');
  assert.equal(win.added[0].parentNode, null, 'the script element is removed again');
  assert.deepEqual(r.entries.map((e) => e.label), ['Name A', 'Name B']); assert.equal(r.skipped.invalid + r.skipped.otherChain, 1);
  assert.equal(r.sanctions, true); assert.equal(r.licence, 'Public domain'); assert.equal(r.asOf, '2026-10-21'); assert.equal(r.name, 'Whatever');
  assert.equal(Object.prototype.hasOwnProperty.call(win.HOPLINE_PACKS, 'ofac-sdn'), false, 'the loaded copy is not kept');
});

test('load uses data that is already on the page without adding anything', async () => {
  const win = fakeWindow(() => assert.fail('nothing should be loaded'));
  win.HOPLINE_PACKS['ofac-sdn'] = JSON.parse(JSON.stringify(data));
  const r = await Packs.load(good, win);
  assert.equal(win.added.length, 0); assert.equal(r.entries.length, 2);
});

test('load fails with a readable message when the file is missing, empty, unusable or slow', async () => {
  await assert.rejects(Packs.load(good, fakeWindow((s) => s.onerror())), /could not be loaded/);
  await assert.rejects(Packs.load(good, fakeWindow((s) => s.onload())), /did not contain the pack/);
  await assert.rejects(Packs.load(good, fakeWindow((s, w) => { w.HOPLINE_PACKS['ofac-sdn'] = { labels: [{ address: 'junk', label: 'x' }] }; s.onload(); })), /No usable Bitcoin addresses/);
  const slow = fakeWindow(() => {});
  await assert.rejects(Packs.load(good, slow, 20), /too long/);
  assert.equal(slow.added[0].parentNode, null, 'a script that never answered is removed too');
});

test('load never takes a pack that is not for this id from the page\'s store', async () => {
  const win = fakeWindow((s, w) => { Object.setPrototypeOf(w.HOPLINE_PACKS, { 'ofac-sdn': data }); s.onload(); });
  await assert.rejects(Packs.load(good, win), /did not contain the pack/);
});

test('the shipped files are what the list says they are', () => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const dir = path.join(__dirname, '..', 'public', 'packs');
  const win = { HOPLINE_PACKS: {} };
  new Function('window', fs.readFileSync(path.join(dir, 'index.js'), 'utf8'))(win);
  const index = Packs.cleanIndex(win.HOPLINE_PACK_INDEX);
  assert.equal(index.length, win.HOPLINE_PACK_INDEX.length, 'every entry of the list is well-formed');
  index.forEach((e) => {
    const text = fs.readFileSync(path.join(dir, e.file), 'utf8');
    assert.equal(crypto.createHash('sha256').update(text).digest('hex').slice(0, 10), e.version, e.id + ': the version is the file\'s hash, so the file was not edited by hand');
    new Function('window', text)(win);
    const r = Labels.fromObject(win.HOPLINE_PACKS[e.id], e.name);
    assert.equal(r.entries.length, e.entries, e.id + ': the count in the list is the number of wallets'); assert.equal(Object.values(r.skipped).reduce((a, b) => a + b, 0), 0, e.id + ': every wallet passes the checks');
    assert.equal(r.name, e.name); assert.equal(r.sanctions, e.sanctions); assert.equal(r.asOf, e.asOf); assert.equal(r.licence, e.licence);
    assert.ok(e.licence && e.attribution && e.asOf && e.sourceUrl, e.id + ': says where it came from');
  });
});
