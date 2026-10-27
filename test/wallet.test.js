'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Wallet = require('../public/js/hopline-wallet.js');

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

// ---- finding things in a long history -------------------------------------------------------------------------------------
test('filterRows: by direction, by date, by amount, and by words found anywhere in a transaction', () => {
  const { rows } = Wallet.ledger(ME, sample(), { known, balance: 67000 });
  const ids = (list) => list.map((r) => r.txid);
  assert.equal(Wallet.filterRows(rows, {}).length, 4); assert.equal(Wallet.filterRows(rows).length, 4);
  assert.deepEqual(ids(Wallet.filterRows(rows, { dir: 'in' })), [tid(3), tid(1)]);
  assert.deepEqual(ids(Wallet.filterRows(rows, { dir: 'out' })), [tid(4), tid(2)]);
  assert.deepEqual(ids(Wallet.filterRows(rows, { from: 1650002000, to: 1650003000 })), [tid(3), tid(2)], 'both ends are included; unconfirmed is newer than any "to"');
  assert.deepEqual(ids(Wallet.filterRows(rows, { from: 1650002500 })), [tid(4), tid(3)], 'unconfirmed counts as the newest');
  assert.deepEqual(ids(Wallet.filterRows(rows, { to: 1650001500 })), [tid(1)]);
  assert.deepEqual(ids(Wallet.filterRows(rows, { minSats: 50000 })), [tid(2), tid(1)], 'on what the transaction did to the wallet: 61000 out and 99000 in');
  assert.deepEqual(ids(Wallet.filterRows(rows, { maxSats: 29000 })), [tid(4), tid(3)]);
  assert.deepEqual(ids(Wallet.filterRows(rows, { minSats: 29000, maxSats: 29000 })), [tid(3)], 'the limits are included');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: 'exchange' })), [tid(2)], 'a label counts');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: 'CASE LIST' })), [tid(2)], 'so does the list it came from, whatever the case');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: 'bc1qpayer' })), [tid(3)], 'an address');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: tid(1).slice(0, 8) })), [tid(1)], 'the start of a transaction id');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: '700002' })), [tid(2)], 'a block height');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: 'bc1qshop  bc1q' })), [tid(4)], 'every word has to be found, and spaces do not matter');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: 'payer exchange' })), [], 'no transaction has both');
  assert.deepEqual(ids(Wallet.filterRows(rows, { text: '   ' })), ids(rows), 'blank words match everything');
  assert.deepEqual(ids(Wallet.filterRows(rows, { dir: 'in', minSats: 50000, text: 'friend' })), [tid(1)], 'the choices combine');
});

test('filterRows: a move to itself is judged by the amount moved', () => {
  const t = tx(8, [[ME, 10000]], [[ME, 10000]], 1650005000);
  const { rows } = Wallet.ledger(ME, [t]);
  assert.equal(Wallet.rowAmount(rows[0]), 10000);
  assert.equal(Wallet.filterRows(rows, { minSats: 9000 }).length, 1); assert.equal(Wallet.filterRows(rows, { minSats: 11000 }).length, 0);
});

// ---- who the wallet dealt with ------------------------------------------------------------------------------------------------
test('counterparties: every wallet, labelled or not, by the money that passed between, with what each paid in and received', () => {
  const { rows } = Wallet.ledger(ME, sample(), { known });
  const list = Wallet.counterparties(rows, ME, known);
  assert.deepEqual(list.map((c) => c.address), ['bc1qfriend00000000000000000000000000000', 'bc1qexch0000000000000000000000000000000', 'bc1qpayer000000000000000000000000000000', 'bc1qshop0000000000000000000000000000000', 'bc1qother000000000000000000000000000000']);
  const by = Object.fromEntries(list.map((c) => [c.address, c]));
  assert.deepEqual([by['bc1qfriend00000000000000000000000000000'].asInput, by['bc1qfriend00000000000000000000000000000'].asOutput, by['bc1qfriend00000000000000000000000000000'].volume], [100000, 0, 100000]);
  assert.deepEqual([by['bc1qexch0000000000000000000000000000000'].asInput, by['bc1qexch0000000000000000000000000000000'].asOutput, by['bc1qexch0000000000000000000000000000000'].txs], [0, 60000, 1]);
  assert.equal(by['bc1qpayer000000000000000000000000000000'].volume, 30000);
  assert.deepEqual(list.map((c) => c.volume), list.map((c) => c.volume).slice().sort((a, b) => b - a), 'biggest first');
  assert.equal(list[0].volume, 100000); assert.ok(!list.some((c) => c.address === ME), 'the wallet itself is not a counterparty');
  assert.equal(by['bc1qexch0000000000000000000000000000000'].label, 'Exchange X'); assert.equal(by['bc1qexch0000000000000000000000000000000'].pack, 'Case list'); assert.equal(by['bc1qexch0000000000000000000000000000000'].category, 'EXCH');
  assert.equal(by['bc1qshop0000000000000000000000000000000'].label, null, 'one that nobody named is still listed');
  assert.equal(by['bc1qshop0000000000000000000000000000000'].sanctions, false);
});

test('counterparties: a wallet on both sides of one transaction counts that transaction once; a sanctions mark is passed on; ties are settled by count then address', () => {
  const t = tx(11, [['bc1qa000000000000000000000000000000000', 5000], [ME, 5000]], [['bc1qa000000000000000000000000000000000', 4000], [ME, 5800]], 1650006000);
  const u = tx(12, [[ME, 1000]], [['bc1qb000000000000000000000000000000000', 500]], 1650007000);
  const { rows } = Wallet.ledger(ME, [u, t]);
  const list = Wallet.counterparties(rows, ME, (a) => (a.startsWith('bc1qb') ? { label: 'B', sanctions: true } : null));
  const a = list.find((c) => c.address.startsWith('bc1qa')), b = list.find((c) => c.address.startsWith('bc1qb'));
  assert.deepEqual([a.txs, a.asInput, a.asOutput, a.volume], [1, 5000, 4000, 9000]);
  assert.equal(b.sanctions, true); assert.deepEqual(list.map((c) => c.address.slice(0, 5)), ['bc1qa', 'bc1qb']);
  const tie = Wallet.counterparties(Wallet.ledger(ME, [tx(13, [[ME, 3000]], [['bc1qz000000000000000000000000000000000', 1000], ['bc1qy000000000000000000000000000000000', 1000]], 1650008000)]).rows, ME);
  assert.deepEqual(tie.map((c) => c.address.slice(0, 5)), ['bc1qy', 'bc1qz'], 'equal volume and count: by address');
  assert.deepEqual(Wallet.counterparties([], ME), []);
});

// ---- the balance over time -----------------------------------------------------------------------------------------------------
test('balanceSeries: the balance after each confirmed transaction, oldest first, and where it started', () => {
  const { rows } = Wallet.ledger(ME, sample(), { balance: 67000 });
  const s = Wallet.balanceSeries(rows);
  assert.deepEqual(s.points.map((p) => [p.txid, p.balance, p.net]), [[tid(1), 99000, 99000], [tid(2), 38000, -61000], [tid(3), 67000, 29000]], 'the unconfirmed one is not on the line');
  assert.deepEqual(s.points.map((p) => p.time), [1650001000, 1650002000, 1650003000]);
  assert.deepEqual(s.start, { time: 1650001000, balance: 0 }, 'the whole history is loaded: it began at nothing');
  const partial = Wallet.balanceSeries(Wallet.ledger(ME, sample().slice(0, 3), { balance: 67000 }).rows);
  assert.deepEqual(partial.start, { time: 1650002000, balance: 99000 }, 'with only the newest loaded it begins where the older history left it');
});

test('balanceSeries: nothing to draw without a balance, and transactions in one block keep their order', () => {
  assert.deepEqual(Wallet.balanceSeries([]), { points: [], start: null });
  assert.deepEqual(Wallet.balanceSeries(Wallet.ledger(ME, sample()).rows), { points: [], start: null }, 'no balance known: no line');
  const a = tx(21, [['bc1qp0000000000000000000000000000000000', 10000]], [[ME, 9000]], 1650009000), b = tx(22, [[ME, 9000]], [['bc1qq000000000000000000000000000000000', 8000]], 1650009000);
  const s = Wallet.balanceSeries(Wallet.ledger(ME, [b, a], { balance: 0 }).rows);                  // newest first: b spent what a paid in, in the same block
  assert.deepEqual(s.points.map((p) => [p.txid, p.balance]), [[tid(21), 9000], [tid(22), 0]]);
});

// ---- the whole wallet: addresses spent together ----------------------------------------------------------------------------------------
const A = (n) => 'bc1qaddr' + String(n).padStart(33, '0');
function spend(n, addrs, outs, time) {
  return { txid: tid(n), fee: 100, status: { confirmed: true, block_height: 700000 + n, block_time: time || 1650000000 + n },
           vin: addrs.map((a, i) => ({ txid: tid(90 + i), vout: i, prevout: { scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: 10000 } })),
           vout: (outs || [[A(99), 5000]]).map(([a, v]) => ({ scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: v })) };
}

test('cluster: addresses spent together with this one, and through them the addresses spent with those', () => {
  const txs = [spend(1, [A(1), A(2)]), spend(2, [A(2), A(3)]), spend(3, [A(7), A(8)]), spend(4, [A(1)])];
  const c = Wallet.cluster(A(1), txs);
  assert.deepEqual(c.members, [A(1), A(2), A(3)], 'this one first, then the others in order; 7 and 8 belong with each other, not with these');
  assert.deepEqual(c.links.map((l) => l.txid), [tid(1), tid(2)], 'the transactions that joined them; a payment from one address alone joins nothing');
  assert.deepEqual(c.links[0].addresses, [A(1), A(2)]); assert.equal(c.links[0].time, 1650000001);
  assert.deepEqual(Wallet.cluster(A(7), txs).members, [A(7), A(8)]);
  assert.deepEqual(Wallet.cluster(A(50), txs), { members: [A(50)], links: [], skipped: { mix: 0 } }, 'an address nothing joined is a wallet of one');
  assert.deepEqual(Wallet.cluster(A(1), []).members, [A(1)]); assert.deepEqual(Wallet.cluster(A(1), null).members, [A(1)]);
});

test('cluster: a CoinJoin-like transaction links nothing, and says how many were left out', () => {
  const mix = spend(5, [A(1), A(10), A(11)]), plain = spend(6, [A(1), A(2)]);
  const isMix = (v) => v.inputs.length >= 3;
  const c = Wallet.cluster(A(1), [mix, plain], { isMix });
  assert.deepEqual(c.members, [A(1), A(2)]); assert.deepEqual(c.skipped, { mix: 1 }); assert.deepEqual(c.links.map((l) => l.txid), [tid(6)]);
  assert.deepEqual(Wallet.cluster(A(1), [mix, plain]).members, [A(1), A(2), A(10), A(11)], 'without the check they would all be one wallet');
  const seen = [];
  Wallet.cluster(A(1), [plain], { isMix: (v) => { seen.push(v); return false; } });
  assert.deepEqual(seen[0].inputs.map((i) => [i.address, i.amount]), [[A(1), 10000], [A(2), 10000]]); assert.deepEqual(seen[0].outputs.map((o) => [o.amount, o.type]), [[5000, 'addr']]);
});

// ---- the CSV with fiat ----------------------------------------------------------------------------------------------------------------------
test('csv with fiat: five more columns, one value each, empty where there is no price', () => {
  const { rows } = Wallet.ledger(ME, sample(), { balance: 67000 });
  const fiat = (sats, time) => (time == null ? null : { value: (sats / 1e8 * 20000).toFixed(4), price: '20000' });
  const lines = Wallet.csv(rows, { fiat, currency: 'EUR' }).trim().split('\r\n');
  assert.equal(lines[0], Wallet.COLUMNS.concat(Wallet.FIAT_COLUMNS).join(','));
  const r3 = lines.find((l) => l.startsWith(tid(3))).split(',');
  assert.deepEqual(r3.slice(-5), ['EUR', '20000', '5.8000', '0.0000', '5.8000']);
  const r4 = lines.find((l) => l.startsWith(tid(4))).split(',');
  assert.deepEqual(r4.slice(-5), ['', '', '', '', ''], 'the unconfirmed one has no price time');
  assert.equal(Wallet.csv(rows).split('\r\n')[0], Wallet.COLUMNS.join(','), 'without fiat the file is as it was');
});

test('csv: a negative amount keeps its sign, while text that could run as a formula is still defused', () => {
  const { rows } = Wallet.ledger(ME, sample(), { balance: 67000 });
  const out = Wallet.csv(rows, { currency: 'USD', fiat: (sats) => ({ value: (sats / 1e8 * 20000).toFixed(4), price: '20000' }) }).trim().split('\r\n');
  const r2 = out.find((l) => l.startsWith(tid(2))).split(',');
  assert.equal(r2[r2.length - 1], '-12.2000', 'a payment out: -61000 sat at 20000 per BTC');
  const bad = tx(40, [[ME, 5000]], [['bc1qshop0000000000000000000000000000000', 4000]], 1650010000);
  const line = Wallet.csv(Wallet.ledger(ME, [bad], {}).rows, { currency: '=1+1', fiat: () => ({ value: '=1+1', price: '-1+2' }) }).trim().split('\r\n')[1].split(',');
  assert.deepEqual(line.slice(-5, -2), ["'=1+1", "'-1+2", "'=1+1"], 'formulas are defused, including one that starts with a minus');
});

// ---- trace from here -------------------------------------------------------------------------------------------------------------------------
test('traceQuery: the wallet first, then well-formed transaction ids once each, at most ten places in all', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => tid(i + 1));
  assert.deepEqual(Wallet.traceQuery(ME, []), { query: ME, txids: [], cut: 0 }, 'nothing ticked: just the wallet');
  const q = Wallet.traceQuery(ME, [tid(2), tid(1), tid(2), 'not-an-id', null, undefined, tid(3).toUpperCase(), '<img src=x>']);
  assert.deepEqual(q.txids, [tid(2), tid(1), tid(3)], 'in the order ticked, once each, bad ones dropped, lower case');
  assert.equal(q.query, [ME, tid(2), tid(1), tid(3)].join(' ')); assert.equal(q.cut, 0);
  const big = Wallet.traceQuery(ME, ids(14));
  assert.equal(big.txids.length, 9, 'the wallet and nine transactions are ten places'); assert.equal(big.cut, 5); assert.equal(big.query.split(' ').length, 10);
  assert.equal(Wallet.traceQuery(ME, ids(5), 3).txids.length, 2, 'a smaller limit is kept'); assert.deepEqual(Wallet.traceQuery(ME, null).txids, []);
});

// ---- the wallet as a graph, for a workspace file and a report -------------------------------------------------------------------------------
test('graphOf: the transactions as a workspace graph, with when and where each arrived and the totals the server keeps', () => {
  const Model = require('../public/js/hopline-model.js'), IO = require('../public/js/hopline-io.js');
  const txs = sample(), api = 'https://mempool.space/api';
  const fetched = new Map(txs.slice(0, 3).map((t, i) => [t.txid, { at: 1700000000 + i, source: api }]));                 // the fourth has no record of its arrival
  const stats = { chain_stats: { funded_txo_sum: 268000, spent_txo_sum: 100000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 5000, tx_count: 1 } };
  const g = Wallet.graphOf(ME, txs, { stats, at: 1700000100, source: api, fetched });
  const loaded = Array.from(g.nodes.values()).filter((n) => n.type === 'tx' && n.loaded);
  assert.equal(loaded.length, 4, 'every transaction is a loaded vertex');
  const first = g.nodes.get(Model.ID.tx(tid(4)));
  assert.equal(first.source, api); assert.equal(first.fetchedAt, 1700000000);
  assert.equal(g.nodes.get(Model.ID.tx(tid(1))).fetchedAt, undefined, 'no record of arrival, none invented');
  const me = g.nodes.get(Model.ID.addr(ME));
  assert.equal(me.fundedSum, 268000); assert.equal(me.spentSum, 100000); assert.equal(me.statsAt, 1700000100); assert.equal(me.statsSource, api);
  assert.ok(me.received > 0 && me.sent > 0, 'what each wallet received and sent is worked out');
  const back = IO.fromJson(IO.toJson(g, { source: api }));                                                                  // the workspace opens it
  assert.equal(back.graph.nodes.size, g.nodes.size); assert.equal(back.graph.edges.size, g.edges.size);
  assert.equal(back.graph.nodes.get(Model.ID.tx(tid(4))).fetchedAt, 1700000000, 'the provenance survives');
  assert.equal(back.graph.nodes.get(Model.ID.addr(ME)).fundedSum, 268000);
});

test('graphOf: no totals without stats, an empty list is an empty graph, and a transaction given twice is one vertex', () => {
  const Model = require('../public/js/hopline-model.js');
  const g = Wallet.graphOf(ME, sample().concat(sample()));
  assert.equal(Array.from(g.nodes.values()).filter((n) => n.type === 'tx' && n.loaded).length, 4);
  assert.equal(g.nodes.get(Model.ID.addr(ME)).fundedSum, undefined);
  const e = Wallet.graphOf(ME, []); assert.equal(e.nodes.size, 0); assert.equal(Wallet.graphOf(ME, null).edges.size, 0);
});
