'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const O = require('../public/js/hopline-ofac.js');
const Labels = require('../public/js/hopline-labels.js');

const BECH = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';      // real addresses with valid checksums
const LEGACY = '325gSHHe7UGvzEc9kGx43VqPboXUVwa26i';
const ETH = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const NS = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML';
const XBT = 'Digital Currency Address - XBT';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function entry(uid, last, { first, programs = [], ids = [], aka = '', remarks = '' } = {}) {
  return '<sdnEntry><uid>' + uid + '</uid>' + (first ? '<firstName>' + esc(first) + '</firstName>' : '') + '<lastName>' + esc(last) + '</lastName><sdnType>Entity</sdnType>'
    + (remarks ? '<remarks>' + esc(remarks) + '</remarks>' : '')
    + (programs.length ? '<programList>' + programs.map((p) => '<program>' + p + '</program>').join('') + '</programList>' : '')
    + (ids.length ? '<idList>' + ids.map(([t, v], n) => '<id><uid>9' + n + '</uid><idType>' + t + '</idType><idNumber>' + esc(v) + '</idNumber></id>').join('') + '</idList>' : '')
    + aka + '</sdnEntry>';
}
const sdn = (entries, date = '10/21/2026') => '<?xml version="1.0" standalone="yes"?>\n<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="' + NS + '">\n  <publshInformation><Publish_Date>' + date
  + '</Publish_Date><Record_Count>' + entries.length + '</Record_Count></publshInformation>\n' + entries.join('\n') + '\n</sdnList>\n';
const ENTRIES = [
  entry(100, 'EXAMPLE GROUP & SONS', { programs: ['CYBER2'], ids: [[XBT, BECH], [XBT, LEGACY], ['Digital Currency Address - ETH', ETH], ['Email Address', 'x@example.org']],
    aka: '<akaList><aka><uid>5</uid><type>a.k.a.</type><category>strong</category><firstName>ALIAS</firstName><lastName>NOT THE NAME</lastName></aka></akaList>' }),
  entry(200, 'ETH ONLY LTD', { programs: ['SDGT'], ids: [['Digital Currency Address - ETH', ETH]] }),
  entry(300, 'NO ADDRESS INC', { programs: ['IRAN'] }),
  entry(400, 'SMITH', { first: 'Jane', programs: ['DPRK3', 'CYBER2'], ids: [[XBT, BECH]] }),
];
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const run = (xml) => O.convertXml(xml, { now: NOW });

/** a minimal zip writer for the tests: [{ name, data: Buffer, method: 8 (default) | 0, flags, fullSize }] */
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const method = f.method == null ? 8 : f.method, data = f.rawData || (method === 8 ? zlib.deflateRawSync(f.data) : f.data), name = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.flags || 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.flags || 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(f.fullSize != null ? f.fullSize : f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('a list becomes a pack of its Bitcoin addresses: named, linked to the OFAC entry, dated', () => {
  const { pack, info } = run(sdn(ENTRIES));
  assert.equal(pack.format, 'hopline-labels'); assert.equal(pack.name, 'OFAC SDN list (Bitcoin)');
  assert.match(pack.source, /SDN\.XML, dated 10\/21\/2026\), converted 2026-10-22/);
  assert.deepEqual(pack.labels.map((l) => l.address), [BECH, LEGACY], 'the Ethereum address, the email and the entries without a Bitcoin address are left out');
  const legacy = pack.labels[1];
  assert.equal(legacy.label, 'OFAC SDN: EXAMPLE GROUP & SONS', 'the entry\'s own name, not an alias, and character references are decoded');
  assert.equal(legacy.category, 'CYBER2'); assert.equal(legacy.url, 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=100');
  assert.equal(legacy.note, 'OFAC SDN entry 100; list dated 10/21/2026');
  assert.deepEqual(info, { layout: 'sdnList', date: '10/21/2026', entries: 4, withAddress: 2, read: 3, expected: 3, warning: '' });
});

test('an address listed under two entries keeps both names, all programmes and both entry numbers', () => {
  const l = run(sdn(ENTRIES)).pack.labels[0];
  assert.equal(l.label, 'OFAC SDN: EXAMPLE GROUP & SONS / SMITH, Jane', 'an individual is written LAST, First');
  assert.equal(l.category, 'CYBER2, DPRK3'); assert.equal(l.note, 'OFAC SDN entry 100, 400; list dated 10/21/2026'); assert.ok(l.url.endsWith('id=100'));
});

test('non-Latin names and numeric character references survive; a hostile name stays plain text', () => {
  const evil = '<img src=x onerror=1>';
  const l = run(sdn([entry(7, 'ООО ТЕСТ &#x41; ' + evil, { ids: [[XBT, BECH]] }).replace('&amp;#x41;', '&#x41;')])).pack.labels[0];
  assert.ok(l.label.includes('ООО ТЕСТ A'), l.label);
  assert.equal(Labels.parse(JSON.stringify(run(sdn([entry(7, 'X ' + evil, { ids: [[XBT, BECH]] })])).pack), 'x').entries[0].label.includes('<img'), true, 'kept as text; the page never turns labels into markup');
});

test('the label importer accepts the pack as it is: every address checks out', () => {
  const p = Labels.parse(JSON.stringify(run(sdn(ENTRIES)).pack), 'x');
  assert.equal(p.name, 'OFAC SDN list (Bitcoin)'); assert.equal(p.entries.length, 2);
  assert.deepEqual(p.skipped, { invalid: 0, otherChain: 0, empty: 0, duplicate: 0 });
  assert.ok(p.entries.every((e) => e.url.startsWith('https://sanctionssearch.ofac.treas.gov/Details.aspx?id=')));
});

test('a leading byte-order mark and Windows line endings do not matter', () => {
  const xml = '﻿' + sdn(ENTRIES).replace(/\n/g, '\r\n');
  assert.equal(run(xml).pack.labels.length, 2);
});

test('the zipped list (stored or deflated) gives the same pack as the plain file', async () => {
  const plain = run(sdn(ENTRIES)).pack.labels;
  const data = Buffer.from(sdn(ENTRIES), 'utf8');
  for (const method of [8, 0]) {
    const r = await O.convertFile(zip([{ name: 'SDN.XML', data, method }]), { now: NOW });
    assert.deepEqual(r.pack.labels, plain, 'method ' + method);
  }
  assert.deepEqual((await O.convertFile(data, { now: NOW })).pack.labels, plain, 'the plain file, as bytes');
  assert.deepEqual((await O.convertFile(new Uint8Array(data).buffer, { now: NOW })).pack.labels, plain, 'an ArrayBuffer, as the page passes it');
});

test('hostile or wrong files are refused with a message that says what to do, and nothing is imported', async () => {
  const refuse = (input, re) => assert.rejects(O.convertFile(input, { now: NOW }), (e) => { assert.equal(e.name, 'OfacError'); assert.match(e.message, re); return true; });
  const good = Buffer.from(sdn(ENTRIES), 'utf8');
  await refuse(Buffer.from('36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'), /SDN\.CSV cannot be used.*SDN_XML\.ZIP/);
  await refuse(Buffer.from('<?xml version="1.0"?><Whatever xmlns="http://example.org"><DistinctParties/></Whatever>'), /not an OFAC SDN list.*top element is <Whatever>/);
  await refuse(Buffer.from('<?xml version="1.0"?><!DOCTYPE sdnList [<!ENTITY a "aaaa">]><sdnList><sdnEntry><uid>1</uid><lastName>&a;</lastName></sdnEntry></sdnList>'), /DOCTYPE/);
  await refuse(good.subarray(0, good.length - 300), /cut short/);
  await refuse(Buffer.from(sdn([ENTRIES[1], ENTRIES[2]])), /No Bitcoin addresses found/);
  await refuse(Buffer.alloc(0), /empty/);
  await refuse(Buffer.from('PK\x03\x04 not really a zip'), /not a readable zip/);
  await refuse(zip([{ name: 'a.xml', data: good }, { name: 'b.xml', data: good }]), /2 XML files; expected one/);
  await refuse(zip([{ name: 'readme.txt', data: Buffer.from('hi') }]), /0 XML files/);
  await refuse(zip([{ name: 'SDN.XML', data: good, flags: 1 }]), /encrypted/);
  await refuse(zip([{ name: 'SDN.XML', data: good, fullSize: 500000000 }]), /larger than expected/);
  await refuse(zip([{ name: 'SDN.XML', data: good, method: 12 }]), /compression method/);
  await refuse(zip([{ name: 'SDN.XML', data: good, rawData: Buffer.from('this is not deflate data at all, just text') }]), /could not be unpacked/);
});

test('an address mentioned where the list is not read is reported: the pack may be incomplete', () => {
  const sneaky = entry(500, 'HIDDEN GROUP', { remarks: XBT + ' ' + BECH, ids: [[XBT, LEGACY]] });
  const { pack, info } = run(sdn([sneaky]));
  assert.equal(pack.labels.length, 1);
  assert.equal(info.read, 1); assert.equal(info.expected, 2);
  assert.match(info.warning, /mentions 2 Bitcoin address entries but only 1 could be read/);
});

test('SDN.CSV is recognised, a normal label list is not', () => {
  assert.ok(O.looksLikeSdnCsv('36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'));
  assert.ok(!O.looksLikeSdnCsv('address,label\n' + BECH + ',Exchange\n') && !O.looksLikeSdnCsv(''));
});

test('categories are cut at a programme, never in the middle of one', () => {
  assert.equal(O.category([], 40), ''); assert.equal(O.category(['DPRK3', 'CYBER2'], 40), 'DPRK3, CYBER2');
  assert.equal(O.category(['ILLICIT-DRUGS-EO14059', 'SDNTK', 'SDNT', 'CYBER2'], 40), 'ILLICIT-DRUGS-EO14059, SDNTK, SDNT');
  assert.equal(O.category(['A'.repeat(60)], 40), 'A'.repeat(40));
});

// ---- the enhanced and advanced layouts, checked against the legacy one with the same data ------------------------------
const FX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'ofac', 'sdn_' + n + '.xml'), 'utf8');
const LAYOUTS = [['legacy', 'sdnList', 'SDN.XML'], ['enhanced', 'sanctionsData', 'SDN_ENHANCED.XML'], ['advanced', 'Sanctions', 'SDN_ADVANCED.XML']];
const PAYER = '1opFYNKYG21CfzMYgCZBDoeBpQ9vhVUC9';

test('the legacy, enhanced and advanced layouts give exactly the same pack', () => {
  const packs = LAYOUTS.map(([n, top, file]) => {
    const { pack, info } = run(FX(n));
    assert.equal(info.layout, top); assert.equal(info.date, '10/21/2026'); assert.equal(info.entries, 5);
    assert.deepEqual([info.withAddress, info.read, info.expected, info.warning], [3, 4, 4, ''], n);
    assert.match(pack.source, new RegExp(file.replace('.', '[.]') + ', dated 10/21/2026'));
    return pack.labels;
  });
  assert.deepEqual(packs[1], packs[0], 'enhanced = legacy'); assert.deepEqual(packs[2], packs[0], 'advanced = legacy');
  const by = Object.fromEntries(packs[0].map((l) => [l.address, l]));
  assert.equal(by[BECH].label, 'OFAC SDN: EXAMPLE GROUP & SONS / SMITH, Jane', 'two entries, an organisation and an individual (LAST, First)');
  assert.equal(by[BECH].category, 'CYBER2, DPRK3'); assert.equal(by[BECH].note, 'OFAC SDN entry 100, 400; list dated 10/21/2026'); assert.ok(by[BECH].url.endsWith('Details.aspx?id=100'));
  assert.equal(by[PAYER].label, 'OFAC SDN: DOE, John Michael', 'a middle name stays with the given names'); assert.equal(by[PAYER].category, 'SDGT');
  assert.ok(!JSON.stringify(packs[0]).includes('NOT THE NAME') && !JSON.stringify(packs[0]).includes('ALIAS'), 'aliases and other scripts are not used as the name');
});

test('every layout, zipped or not, goes through the same door', async () => {
  const want = run(FX('legacy')).pack.labels;
  for (const [n] of LAYOUTS) {
    const data = Buffer.from(FX(n), 'utf8');
    assert.deepEqual((await O.convertFile(zip([{ name: 'SDN_' + n.toUpperCase() + '.XML', data }]), { now: NOW })).pack.labels, want, n + ' zipped');
    assert.deepEqual((await O.convertFile(data, { now: NOW })).pack.labels, want, n + ' plain');
  }
});

test('a cut-off or hostile enhanced or advanced file is refused like the legacy one', async () => {
  const refuse = (text, re) => assert.rejects(O.convertFile(Buffer.from(text, 'utf8'), { now: NOW }), (e) => { assert.equal(e.name, 'OfacError'); assert.match(e.message, re); return true; });
  for (const n of ['enhanced', 'advanced']) {
    const xml = FX(n);
    await refuse(xml.slice(0, xml.length - 200), /cut short/);
    await refuse(xml.replace('?>', '?><!DOCTYPE x [<!ENTITY a "b">]>'), /DOCTYPE/);
  }
});

test('an address the reading missed is reported in the enhanced and advanced layouts too', () => {
  const blank = (xml, tag) => xml.replace('<' + tag + (tag === 'value' ? '>' : ' DetailTypeID="1432">') + PAYER, '<' + tag + (tag === 'value' ? '>' : ' DetailTypeID="1432">'));
  const enh = run(blank(FX('enhanced'), 'value')).info, adv = run(blank(FX('advanced'), 'VersionDetail')).info;
  for (const info of [enh, adv]) { assert.equal(info.read, 3); assert.equal(info.expected, 4); assert.match(info.warning, /mentions 4 Bitcoin address entries but only 3 could be read/); }
  const sneaky = run(FX('enhanced').replace('<features>', '<remarks>Digital Currency Address - XBT ' + PAYER + '</remarks><features>')).info;
  assert.equal(sneaky.expected, 5); assert.equal(sneaky.read, 4); assert.ok(sneaky.warning);
});

test('the pack of every layout passes the label importer untouched', () => {
  for (const [n] of LAYOUTS) {
    const p = Labels.parse(JSON.stringify(run(FX(n)).pack), 'x');
    assert.equal(p.entries.length, 3, n); assert.deepEqual(p.skipped, { invalid: 0, otherChain: 0, empty: 0, duplicate: 0 }, n);
  }
});
