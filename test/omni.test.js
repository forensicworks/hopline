'use strict';
// The Omni Layer: an OP_RETURN that starts with "omni" is an instruction for the Omni ledger (Tether's USDT began there). It is decoded, flagged OMNI and said not to be a movement of bitcoin.
// The transactions here are invented; the payload of the first test is the one of a real Tether send (a simple send of 50,000 USDT), which is public.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('../public/js/hopline-model.js');
const { Graph, ID } = M;
const An = require('../public/js/hopline-analysis.js');
const Det = require('../public/js/hopline-detections.js');
const IO = require('../public/js/hopline-io.js');
const As = require('../public/js/hopline-assist.js');

const SEND_USDT = '6f6d6e69000000000000001f0000048c27395000';                         // omni, version 0, type 0 (simple send), property 31, 5,000,000,000,000 units

// ---- the decoder ------------------------------------------------------------------------------------------------------------------------
test('decodeOmni: a simple send of Tether, the payload of a real transaction', () => {
  const d = M.decodeOmni(SEND_USDT);
  assert.deepEqual([d.version, d.type, d.typeName, d.property, d.amount, d.text], [0, 0, 'simple send', 31, '5000000000000', 'simple send of 50,000 TetherUS (USDT)']);
  assert.equal(M.decodeOmni(SEND_USDT.toUpperCase()).text, d.text, 'capital letters are the same hex');
});

test('decodeOmni: amounts are written as their owner reads them: eight decimals for a divisible token, none for an indivisible one, units for a token Hopline does not know', () => {
  const send = (prop, units) => M.decodeOmni('6f6d6e69' + '00000000' + prop.toString(16).padStart(8, '0') + BigInt(units).toString(16).padStart(16, '0')).text;
  assert.equal(send(1, 100000000), 'simple send of 1 Omni (OMNI)');
  assert.equal(send(1, 1), 'simple send of 0.00000001 Omni (OMNI)');
  assert.equal(send(31, 123456789), 'simple send of 1.23456789 TetherUS (USDT)');
  assert.equal(send(31, 150000000), 'simple send of 1.5 TetherUS (USDT)');
  assert.equal(send(3, 42), 'simple send of 42 MaidSafeCoin (MAID)', 'an indivisible token has no decimals');
  assert.equal(send(3, 1234567), 'simple send of 1,234,567 MaidSafeCoin (MAID)');
  assert.equal(send(45, 1), 'simple send of 1 unit of property 45 (Hopline does not know its name or its decimals)');
  assert.equal(send(45, 1500), 'simple send of 1,500 units of property 45 (Hopline does not know its name or its decimals)');
  assert.equal(send(31, '18446744073709551615'), 'simple send of 184,467,440,737.09551615 TetherUS (USDT)', 'eight bytes are more than a JavaScript number holds');
  assert.equal(M.omniAmount(31, '5000000000000'), '50,000 TetherUS (USDT)');
});

test('decodeOmni: a property number can be any four bytes, and the ones of the test ecosystem are above two billion', () => {
  const send = (prop) => M.decodeOmni('6f6d6e69' + '00000000' + prop.toString(16).padStart(8, '0') + '0000000000000001');
  [0, 255, 256, 74565, 16777216, 2147483651, 4294967295].forEach((p) => assert.equal(send(p).property, p, 'property ' + p));
  assert.equal(send(2147483651).text, 'simple send of 1 unit of property 2147483651 (Hopline does not know its name or its decimals)');
});

test('decodeOmni: the other instructions Hopline reads, and what it says of the ones it does not', () => {
  const hex = (...parts) => '6f6d6e69' + parts.join('');
  const u16 = (n) => n.toString(16).padStart(4, '0'), u32 = (n) => n.toString(16).padStart(8, '0'), u64 = (n) => BigInt(n).toString(16).padStart(16, '0');
  assert.equal(M.decodeOmni(hex(u16(0), u16(3), u32(31), u64(100000000))).text, 'send to the owners of TetherUS (USDT): 1 TetherUS (USDT) shared out to them');
  assert.equal(M.decodeOmni(hex(u16(0), u16(4), '01')).text, 'send all tokens of the main ecosystem');
  assert.equal(M.decodeOmni(hex(u16(0), u16(4), '02')).text, 'send all tokens of the test ecosystem');
  assert.equal(M.decodeOmni(hex(u16(0), u16(20), u32(31), u64(100000000))).text, 'DEx sell offer of 1 TetherUS (USDT) for bitcoin');
  const trade = M.decodeOmni(hex(u16(0), u16(21), u32(31), u64(200000000), u32(1), u64(300000000)));
  assert.deepEqual([trade.property, trade.amount, trade.desiredProperty, trade.desiredAmount], [31, '200000000', 1, '300000000']);
  assert.equal(trade.text, 'MetaDEx trade: sells 2 TetherUS (USDT) for 3 Omni (OMNI)');
  assert.equal(M.decodeOmni(hex(u16(0), u16(23), u32(31), u32(1))).text, 'MetaDEx cancel by pair: every offer of TetherUS (USDT) for Omni (OMNI)');
  assert.equal(M.decodeOmni(hex(u16(0), u16(55), u32(31), u64(100000000))).text, 'the issuer grants 1 TetherUS (USDT)');
  assert.equal(M.decodeOmni(hex(u16(0), u16(185), u32(31))).text, 'freeze tokens for TetherUS (USDT)');
  const name = Buffer.from('Cat\0Sub\0My Token\0http://x\0\0').toString('hex');
  assert.equal(M.decodeOmni(hex(u16(0), u16(54), '01', u16(2), u32(0), name)).text, 'create a token (managed) named "My Token"');
  const unknown = M.decodeOmni(hex(u16(0), u16(9999)));
  assert.deepEqual([unknown.typeName, unknown.text], [null, 'an Omni Layer instruction of type 9999 (Hopline does not know this type)']);
  assert.equal(M.decodeOmni(hex(u16(0), u16(0), u32(31))).text, 'simple send (Hopline does not read its fields)', 'a simple send cut short says so and invents no amount');
  assert.match(M.decodeOmni(hex(u16(7), u16(0), u32(31), u64(1))).text, / \(version 7\)$/, 'a version Hopline does not know is said');
});

test('decodeOmni: anything that is not an Omni payload is null, and text in the payload cannot carry markup of its own', () => {
  [null, undefined, '', 'zz', '6f6d6e69', '6f6d6e690000000', '6f6d6e69000000', '68656c6c6f20776f726c6421', '6f6d6e6x0000000000000000', SEND_USDT + '0', '6f6d6e69000000000000001f0000048c2739zz00', ' ' + SEND_USDT].forEach((x) => assert.equal(M.decodeOmni(x), null, String(x)));
  const evil = Buffer.from('a\0b\0<img src=x onerror=1>\0u\0\0').toString('hex');
  const d = M.decodeOmni('6f6d6e69' + '0000' + '0032' + '01' + '0001' + '00000000' + evil);
  assert.equal(d.name, '<img src=x onerror=1>', 'it is printable text, kept as text: the page shows it with textContent, and the prompt cleans it');
  const ctl = M.decodeOmni('6f6d6e69' + '00000032' + '010001' + '00000000' + Buffer.from('a\0b\0line\nbreak‮\0u\0\0').toString('hex'));
  assert.ok(!/[\n‮]/.test(ctl.name), 'control characters are dots');
});

// ---- the flag ---------------------------------------------------------------------------------------------------------------------------
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const a = (name) => 'bc1q' + name.padEnd(20, 'x');
function esplora(n, ins, outs, o) {
  return { txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: 1650000000 + n * 600 },
           vin: ins.map((i) => ({ txid: tid(i[0]), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: i[1], scriptpubkey_type: 'v0_p2wpkh', value: i[2] } })),
           vout: outs.map((x) => (x.data ? { scriptpubkey: '6a' + (x.data.length / 2).toString(16).padStart(2, '0') + x.data, scriptpubkey_type: 'op_return', value: 0 } : { scriptpubkey_address: x.addr, scriptpubkey_type: 'v0_p2wpkh', value: x.value })) };
}
function build(txs) { const g = new Graph(); txs.forEach((t) => g.addTx(t)); return g; }
// the shape of a Tether send: the sender pays a marker to the receiver, an OP_RETURN, and the change back to itself
const SEND = (n, payload) => esplora(n, [[90 + n, a('sender'), 500000]], [{ addr: a('receiver'), value: 546 }, { data: payload || SEND_USDT }, { addr: a('sender'), value: 499000 }]);

test('analysis: a transaction with an Omni instruction is flagged OMNI, with what it says, who sends and who receives, and that the bitcoin amounts are not the value', () => {
  const g = build([SEND(1)]), an = An.analyse(g, {}), id = ID.tx(tid(1));
  const f = an.tx.get(id).flags;
  assert.deepEqual(f.map((x) => [x.kind, x.short, x.color]), [['omni', 'OMNI', An.COLORS.omni]]);
  assert.match(f[0].title, /^Omni Layer instruction in an OP_RETURN: simple send of 50,000 TetherUS \(USDT\)\. From bc1qsender\w* to bc1qreceiver\w*\. The tokens move on the Omni ledger, not on Bitcoin/);
  assert.match(f[0].title, /the bitcoin amounts of this transaction are not the value moved \(the small output to the receiver is only a marker, the rest is change\)/);
  assert.match(f[0].title, /It is what the sender wrote: the Omni ledger decides whether it is carried out .* and Hopline cannot check that\.$/);
  assert.equal(f[0].memo.omni.property, 31);
  assert.deepEqual(An.omniParties(An.txView(g, id), An.omniOf(An.txView(g, id))), { sender: a('sender'), receiver: a('receiver') });
});

test('analysis: the sender and the receiver are named only when each is one wallet, and only for a simple send', () => {
  const parties = (tx) => { const g = build([tx]), v = An.txView(g, ID.tx(tid(tx.txid ? parseInt(tx.txid.slice(0, 2), 16) : 1))); return An.omniParties(v, An.omniOf(v)); };
  assert.deepEqual(parties(esplora(2, [[90, a('s1'), 300000], [91, a('s2'), 200000]], [{ addr: a('receiver'), value: 546 }, { data: SEND_USDT }, { addr: a('s1'), value: 499000 }])), { sender: null, receiver: null }, 'two input wallets: there is no one sender, so the change cannot be told from the receiver');
  assert.deepEqual(parties(esplora(3, [[90, a('sender'), 500000]], [{ addr: a('r1'), value: 546 }, { addr: a('r2'), value: 546 }, { data: SEND_USDT }, { addr: a('sender'), value: 498000 }])), { sender: a('sender'), receiver: null }, 'two other wallets are paid: Omni has its own rule, which is not applied');
  assert.deepEqual(parties(esplora(4, [[90, a('sender'), 500000]], [{ data: SEND_USDT }, { addr: a('sender'), value: 499000 }])), { sender: a('sender'), receiver: null }, 'no one else is paid');
  assert.deepEqual(parties(esplora(5, [[90, a('sender'), 500000]], [{ addr: a('receiver'), value: 546 }, { data: '6f6d6e6900000004' + '01' }, { addr: a('sender'), value: 499000 }])), { sender: null, receiver: null }, 'a send all has no receiver in its payload: nothing is named');
});

test('analysis: the OMNI flag goes with the shape of the transaction, and first with the swap memo', () => {
  const many = esplora(6, [[90, a('i1'), 100000], [91, a('i2'), 100000], [92, a('i3'), 100000], [93, a('i4'), 100000], [94, a('i5'), 100000]], [{ addr: a('receiver'), value: 546 }, { data: SEND_USDT }]);
  const g = build([many]), f = An.analyse(g, {}).tx.get(ID.tx(tid(6))).flags.map((x) => x.kind);
  assert.deepEqual(f, ['omni', 'consolidation'], 'a consolidation of five inputs that also carries an Omni instruction is both');
  const plain = build([esplora(7, [[90, a('x'), 5000]], [{ addr: a('y'), value: 4000 }, { data: '68656c6c6f' }])]);
  assert.deepEqual(An.analyse(plain, {}).tx.get(ID.tx(tid(7))).flags, [], 'an OP_RETURN with other text is no Omni instruction');
  const wrong = build([SEND(8, '6f6d6e6900')]);
  assert.deepEqual(An.analyse(wrong, {}).tx.get(ID.tx(tid(8))).flags, [], 'a payload that starts with omni and says nothing is not an instruction');
});

test('analysis: a mark a link carries can name OMNI and nothing else of its kind', () => {
  assert.deepEqual(An.carriedFlags(['OMNI']).map((x) => [x.kind, x.short, x.carried]), [['omni', 'OMNI', true]]);
  assert.deepEqual(An.carriedFlags(['OMNI 5', 'omni', 'OMNI<script>']), [], 'only the text this analysis writes');
});

// ---- the detections, the assistant and the command line -----------------------------------------------------------------------------
test('detections: a row for the Omni instruction with what it says, counted apart, and first on its transaction', () => {
  const g = build([SEND(9)]), an = An.analyse(g, {}), d = Det.build(g, an);
  assert.equal(d.counts.omni, 1); assert.equal(d.counts.total, 1);
  assert.deepEqual([d.rows[0].kind, d.rows[0].short], ['omni', 'OMNI']);
  assert.match(d.rows[0].reason, /^Omni Layer instruction in an OP_RETURN: simple send of 50,000 TetherUS \(USDT\)\./);
  assert.equal(Det.pick(d.rows, { kind: 'omni' }).length, 1); assert.equal(Det.pick(d.rows, { kind: 'swap' }).length, 0);
  assert.equal(Det.build(g, an, { kinds: { omni: false } }).rows.length, 0, 'it can be switched off like the others');
  assert.ok(Det.KINDS.includes('omni'));
});

test('assistant: the evidence carries the Omni row and a legend that says the bitcoin amounts are not the value', () => {
  const g = build([SEND(10)]), an = An.analyse(g, {}), sum = As.summary(g, an, {}), p = As.prompt(sum, 'triage');
  const ev = JSON.parse(p.user.split('<<EVIDENCE (JSON)\n')[1].split('\nEVIDENCE>>')[0]);
  const row = ev.patterns.find((r) => r[2] === 'OMNI');
  assert.ok(row, 'a pattern row named OMNI: ' + JSON.stringify(ev.patterns));
  assert.match(ev.legend.omni, /Omni Layer .* the bitcoin amounts of such a transaction are never the value moved/);
  assert.match(ev.legend.omni, /nothing here checks that/);
});

test('the command line: detections --kind omni reads the instruction of a saved workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-omni-'));
  try {
    const file = path.join(dir, 'ws.json'); fs.writeFileSync(file, IO.toJson(build([SEND(11)]), {}));
    const run = (args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'hopline-cli.js')].concat(args), { encoding: 'utf8' });
    const rows = JSON.parse(run(['detections', file, '--kind', 'omni']).stdout);
    assert.deepEqual(rows.map((r) => [r.kind, r.pattern]), [['omni', 'OMNI']]);
    assert.match(rows[0].why, /simple send of 50,000 TetherUS \(USDT\)/);
    assert.deepEqual(JSON.parse(run(['detections', file, '--kind', 'swap']).stdout), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
