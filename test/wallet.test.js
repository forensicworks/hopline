'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Wallet = require('../public/js/orion-wallet.js');

const ME = 'bc1qme000000000000000000000000000000000';
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);

function tx(n, ins, outs, time, extra) {
  return Object.assign({
    txid: tid(n), fee: 200, weight: 800, status: time == null ? { confirmed: false } : { confirmed: true, block_height: 700000 + n, block_time: time },
    vin: ins.map(([addr, value, p]) => ({ txid: tid(p || 90), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'v0_p2wpkh', value } })),
    vout: outs.map(([addr, value, type]) => Object.assign({ scriptpubkey_address: addr, scriptpubkey_type: type || 'v0_p2wpkh', value }, addr === null ? { scriptpubkey: type === 'op_return' ? '6a0b68656c6c6f20776f726c64' : '51' } : {}))
  }, extra);
}

// newest first, as the API gives them: pending, then by block. 4: unconfirmed payment out; 3: paid in; 2: payment out with change back; 1: first payment in.
function sample() {
  return [
    tx(4, [[ME, 5000]], [['bc1qshop0000000000000000000000000000000', 4000]], null),
    tx(3, [['bc1qpayer000000000000000000000000000000', 30000]], [[ME, 29000], ['bc1qother000000000000000000000000000000', 500]], 1650003000),
    tx(2, [[ME, 100000]], [['bc1qexch0000000000000000000000000000000', 60000], [ME, 39000]], 1650002000),
    tx(1, [['bc1qfriend00000000000000000000000000000', 100000]], [[ME, 99000]], 1650001000)
  ];
}
const known = (a) => ({ 'bc1qexch0000000000000000000000000000000': { label: 'Exchange X', pack: 'Case list', category: 'EXCH' }, 'bc1qpayer000000000000000000000000000000': { label: 'Payer Co' } }[a] || null);

test('every transaction becomes a row with its inputs, outputs and what it did to the wallet', () => {
  const { rows } = Wallet.ledger(ME, sample(), { known });
  assert.equal(rows.length, 4);
  const byId = Object.fromEntries(rows.map((r) => [r.txid, r]));
  const r1 = byId[tid(1)], r2 = byId[tid(2)], r3 = byId[tid(3)], r4 = byId[tid(4)];
  assert.deepEqual([r1.recv, r1.sent, r1.net, r1.dir], [99000, 0, 99000, 'in']);
  assert.deepEqual([r2.recv, r2.sent, r2.net, r2.dir], [39000, 100000, -61000, 'out'], 'change that came back is netted off');
  assert.deepEqual([r3.recv, r3.sent, r3.net, r3.dir], [29000, 0, 29000, 'in']);
  assert.deepEqual([r4.recv, r4.sent, r4.net, r4.dir], [0, 5000, -5000, 'out']);
  assert.equal(r4.confirmed, false); assert.equal(r4.time, null); assert.equal(r1.height, 700001); assert.equal(r1.fee, 200);
  assert.deepEqual(r2.inputs.map((i) => [i.address === ME, i.value, i.self]), [[true, 100000, true]]);
  assert.deepEqual(r2.outputs.map((o) => [o.self, o.value, o.label]), [[false, 60000, 'Exchange X'], [true, 39000, null]], 'the wallet\'s own lines are marked, labels come from the lookup');
  assert.equal(r2.inTotal, 100000); assert.equal(r2.outTotal, 99000);
});

test('a transaction that only moves money between the wallet\'s own outputs is "self", one that does nothing to it is "none"', () => {
  const t = tx(7, [[ME, 10000]], [[ME, 9800]], 1650005000);
  assert.equal(Wallet.ledger(ME, [t]).rows[0].dir, 'out', 'it paid the fee, so the wallet lost a little');
  const exact = tx(8, [[ME, 10000]], [[ME, 10000]], 1650005000);
  assert.equal(Wallet.ledger(ME, [exact]).rows[0].dir, 'self');
  const other = tx(9, [['bc1qx000000000000000000000000000000000', 5]], [['bc1qy000000000000000000000000000000000', 5]], 1650005000);
  assert.equal(Wallet.ledger(ME, [other]).rows[0].dir, 'none');
});

test('the balance after each confirmed transaction is worked backwards from today\'s balance, and an unconfirmed one has none', () => {
  // the wallet holds 99000 + 39000 - 100000 ... newest confirmed (3) leaves today's balance
  const today = 67000;
  const { rows } = Wallet.ledger(ME, sample(), { balance: today });
  const after = Object.fromEntries(rows.map((r) => [r.txid, r.balanceAfter]));
  assert.equal(after[tid(4)], null, 'unconfirmed: not part of the confirmed balance');
  assert.equal(after[tid(3)], 67000);
  assert.equal(after[tid(2)], 67000 - 29000, 'before tx 3 paid 29000 in');
  assert.equal(after[tid(1)], 67000 - 29000 + 61000, 'before tx 2 took 61000 out');
  assert.equal(after[tid(1)], 99000, 'and the numbers close: the first payment in left exactly what it paid');
  const none = Wallet.ledger(ME, sample());
  assert.ok(none.rows.every((r) => r.balanceAfter === null), 'no balance known: none shown');
});

test('with only the newest part of the history loaded the balance after each is still right', () => {
  const { rows } = Wallet.ledger(ME, sample().slice(0, 3), { balance: 67000 });
  assert.deepEqual(rows.map((r) => r.balanceAfter), [null, 67000, 38000]);
});

test('labelled wallets the transactions dealt with are listed once each, with how many transactions and how much', () => {
  const { assoc } = Wallet.ledger(ME, sample(), { known });
  assert.deepEqual(assoc.map((a) => a.label).sort(), ['Exchange X', 'Payer Co']);
  const ex = assoc.find((a) => a.label === 'Exchange X'), pay = assoc.find((a) => a.label === 'Payer Co');
  assert.deepEqual([ex.txs, ex.asOutput, ex.asInput, ex.pack, ex.category], [1, 60000, 0, 'Case list', 'EXCH'], 'the exchange received 60000 from the wallet');
  assert.deepEqual([pay.txs, pay.asInput, pay.asOutput], [1, 30000, 0], 'the payer paid in 30000');
  assert.ok(!assoc.some((a) => a.address === ME), 'the wallet itself is never an association');
  assert.deepEqual(Wallet.ledger(ME, sample()).assoc, [], 'with no lookup there is nothing to list');
});

test('a labelled wallet that is on both sides of one transaction is counted once; the most frequent comes first', () => {
  const both = tx(5, [['bc1qexch0000000000000000000000000000000', 9000], [ME, 1000]], [['bc1qexch0000000000000000000000000000000', 3000], [ME, 6000]], 1650006000);
  const twice = tx(6, [[ME, 5000]], [['bc1qexch0000000000000000000000000000000', 4000]], 1650007000);
  const { assoc } = Wallet.ledger(ME, [twice, both, sample()[3]], { known });
  assert.equal(assoc.length, 1);
  assert.deepEqual([assoc[0].txs, assoc[0].asInput, assoc[0].asOutput], [2, 9000, 7000]);
});

test('OP_RETURN data, outputs without an address and coinbase inputs are described, not lost', () => {
  const t = tx(10, [], [[ME, 1000], [null, 0, 'op_return'], [null, 50, 'nonstandard']], 1650009000, { vin: [{ txid: '00'.repeat(32), vout: 4294967295, is_coinbase: true, prevout: null }] });
  const r = Wallet.ledger(ME, [t]).rows[0];
  assert.equal(r.inputs.length, 1); assert.equal(r.inputs[0].coinbase, true); assert.equal(r.inputs[0].address, null); assert.equal(r.inputs[0].value, 0);
  assert.equal(r.outputs[1].address, null); assert.equal(r.outputs[1].data.text, 'hello world'); assert.equal(r.outputs[2].data, null);
  assert.equal(r.net, 1000);
});

test('summary is the address\'s own totals: the whole history, not just what is loaded', () => {
  const s = Wallet.summary({ chain_stats: { funded_txo_sum: 150000, spent_txo_sum: 100000, tx_count: 7 }, mempool_stats: { funded_txo_sum: 400, spent_txo_sum: 1000, tx_count: 2 } });
  assert.deepEqual(s, { received: 150000, sent: 100000, balance: 50000, txCount: 7, pendingCount: 2, pendingIn: 400, pendingOut: 1000, pendingNet: -600 });
  assert.deepEqual(Wallet.summary(null), { received: 0, sent: 0, balance: 0, txCount: 0, pendingCount: 0, pendingIn: 0, pendingOut: 0, pendingNet: 0 });
});

test('csv has a header and a line per transaction, quotes what needs it and defuses spreadsheet formulas', () => {
  const evil = tx(11, [['=HYPERLINK("http://x","y")', 1000]], [[ME, 900]], 1650010000);
  const text = Wallet.csv(Wallet.ledger(ME, [evil].concat(sample()), { balance: 67000 }).rows);
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 6); assert.equal(lines[0], Wallet.COLUMNS.join(','));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"",""y"")=1000"`), 'a cell that starts with = is prefixed with a quote, and quoted because it holds quotes and a comma');
  assert.ok(!/(^|,)=/.test(lines[1]), 'no cell starts with =');
  const first = lines.find((l) => l.startsWith(tid(1)));
  assert.match(first, new RegExp('^' + tid(1) + ',2022-04-15 \\d\\d:\\d\\d:\\d\\d UTC,1650001000,confirmed,700001,in,99000,0,99000,200,'));
  const pending = lines.find((l) => l.startsWith(tid(4)));
  assert.match(pending, new RegExp('^' + tid(4) + ',,,unconfirmed,,out,0,5000,-5000,200,,'), 'an unconfirmed transaction has no time, height or balance');
});
