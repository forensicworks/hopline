'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Graph, ID } = require('../public/js/hopline-model.js');
const AN = require('../public/js/hopline-analysis.js');
const LS = require('../public/js/hopline-losses.js');

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const adr = (name) => 'bc1q' + name.padEnd(20, 'x');
const w = (name) => ID.addr(adr(name));
const T0 = 1700000000;
function tx(n, ins, outs, at, over) {
  const vin = ins.map(([p, vout, who, value]) => ({ txid: tid(p), vout, sequence: 4294967293, is_coinbase: false, prevout: { scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value } }));
  const fee = ins.reduce((s, i) => s + i[3], 0) - outs.reduce((s, o) => s + o[1], 0);
  return Object.assign({ txid: tid(n), fee, weight: 800, version: 2, locktime: 0, status: at == null ? { confirmed: false } : { confirmed: true, block_height: 1000 + Math.floor(at / 600), block_time: T0 + at },
                         vin, vout: outs.map(([who, value]) => ({ scriptpubkey_address: adr(who), scriptpubkey_type: 'v0_p2wpkh', value })) }, over);
}
const find = (txs, opts) => { const g = new Graph(); txs.forEach((t) => g.addTx(t)); g.refreshDerived(); return LS.find(g, AN.analyse(g, {}), opts); };
const opts = { victims: [w('vic')], threats: [w('thr')] };

test('losses: what the victim paid to the threat, the amount that reached the threat and not the change, in time order, with the test and the main payment named', () => {
  const r = find([tx(1, [[90, 0, 'vic', 2000000]], [['thr', 10000], ['vchg', 1989000]], 0), tx(2, [[91, 0, 'vic', 2000000]], [['thr', 1000000], ['vchg2', 989000]], 3600), tx(3, [[92, 0, 'other', 500000]], [['thr', 400000], ['ochg', 90000]], 7200)], opts);
  assert.deepEqual(r.paid.map((p) => [p.txid, p.amount, p.roles, p.to, p.from, p.time]), [[tid(1), 10000, ['test'], adr('thr'), [adr('vic')], T0], [tid(2), 1000000, ['main'], adr('thr'), [adr('vic')], T0 + 3600]]);
  assert.deepEqual([r.totalPaid, r.totalReturned, r.net, r.first, r.last, r.mixed], [1010000, 0, 1010000, T0, T0 + 3600, 0], 'a payment from somebody else is not the victim\'s');
  assert.deepEqual(r.recipients, [{ id: w('thr'), address: adr('thr'), paid: 1010000, count: 2 }]);
  assert.deepEqual([r.victimWallets, r.threatWallets], [1, 1]);
});

test('losses: what came back is subtracted, and a payment that is both a main and the test of a later one has both roles', () => {
  const r = find([tx(1, [[90, 0, 'vic', 2000000]], [['thr', 10000], ['vc', 1989000]], 0), tx(2, [[91, 0, 'vic', 99000000]], [['thr', 1000000], ['vc2', 97990000]], 600), tx(3, [[92, 0, 'vic', 999000000]], [['thr', 100000000], ['vc3', 898000000]], 1200),
                  tx(4, [[93, 0, 'thr', 500000]], [['vic', 400000], ['tc', 90000]], 1800)], opts);
  assert.deepEqual(r.paid.map((p) => p.roles), [['test'], ['main', 'test'], ['main']]);
  assert.deepEqual(r.returned.map((p) => [p.txid, p.amount, p.to]), [[tid(4), 400000, adr('vic')]]);
  assert.deepEqual([r.totalPaid, r.totalReturned, r.net], [101010000, 400000, 100610000]);
});

test('losses: the victim\'s wallets include the ones spent together with it, and the threat\'s are exactly the ones given', () => {
  // v1 and v2 are spent together in tx 1, so tagging v1 is enough for a payment from v2 alone
  const txs = [tx(1, [[90, 0, 'v1', 5000], [91, 0, 'v2', 6000]], [['x', 10000], ['c', 500]], 0), tx(2, [[92, 0, 'v2', 100000]], [['thr', 60000], ['vc', 39000]], 600), tx(3, [[93, 0, 'vic', 70000]], [['thr', 50000], ['thr2', 19000]], 1200), tx(4, [[94, 0, 'thr', 1000], [95, 0, 'thr2', 1000]], [['sink', 1500]], 1800)];        // thr and thr2 are spent together in tx 4: one owner
  const r = find(txs, { victims: [w('v1')], threats: [w('thr')] });
  assert.deepEqual(r.paid.map((p) => [p.txid, p.from]), [[tid(2), [adr('v2')]]]);
  assert.equal(r.victimWallets, 2);
  const none = find(txs, { victims: [w('vic')], threats: [w('thr')] });
  assert.deepEqual([none.paid.map((p) => p.amount), none.threatWallets], [[50000], 1], 'a wallet that is spent together with the threat\'s is not the threat\'s unless it is given');
});

test('losses: a transaction that spends coins of both sides is left out and counted, and nothing is found without both sides', () => {
  const both = find([tx(1, [[90, 0, 'vic', 50000], [91, 0, 'thr', 50000]], [['thr', 60000], ['vic', 39000]], 0)], opts);
  assert.deepEqual([both.paid.length, both.returned.length, both.mixed, both.net], [0, 0, 1, 0]);
  const txs = [tx(1, [[90, 0, 'vic', 2000000]], [['thr', 10000], ['c', 1989000]], 0)];
  assert.deepEqual([find(txs, { victims: [], threats: [w('thr')] }).paid.length, find(txs, { victims: [w('vic')], threats: [] }).paid.length, find(txs, {}).paid.length, find(txs).totalPaid], [0, 0, 0, 0]);
  assert.deepEqual(find([], opts).paid, []);
});

test('losses: a payment that is not in a block has no time and comes last', () => {
  const r = find([tx(1, [[90, 0, 'vic', 2000000]], [['thr', 10000], ['c', 1989000]], null), tx(2, [[91, 0, 'vic', 2000000]], [['thr', 20000], ['c2', 1979000]], 600)], opts);
  assert.deepEqual(r.paid.map((p) => [p.txid, p.time]), [[tid(2), T0 + 600], [tid(1), null]]);
  assert.deepEqual([r.first, r.last, r.totalPaid], [T0 + 600, T0 + 600, 30000]);
});

test('losses toCsv: one row for each payment and return, a return is negative, and the last row is the net with the fiat values added up', () => {
  const r = find([tx(1, [[90, 0, 'vic', 2000000]], [['thr', 10000], ['vc', 1989000]], 0), tx(2, [[91, 0, 'vic', 99000000]], [['thr', 1000000], ['vc2', 97990000]], 600), tx(4, [[93, 0, 'thr', 500000]], [['vic', 400000], ['tc', 90000]], 1800)], opts);
  const csv = LS.toCsv(r, { currency: 'EUR', fiat: (sats, time) => sats / 1e8 * 20000, today: (sats) => sats / 1e8 * 30000, firstSeen: (txid) => (txid === tid(1) ? T0 - 90 : null) });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'time_utc,txid,kind,from,to,amount_sat,amount_btc,roles,block_height,first_seen_utc,fiat_at_time,fiat_today,currency');
  assert.equal(lines.length, 6, 'a header, three payments, a total, and the final line break');
  assert.equal(lines[1], ['2023-11-14 22:13:20', tid(1), 'paid', adr('vic'), adr('thr'), 10000, '0.00010000', 'test', 1000, '2023-11-14 22:11:50', '2', '3', 'EUR'].join(','));
  assert.deepEqual(lines[2].split(',').slice(2, 3).concat(lines[2].split(',')[7]), ['paid', 'main']);
  const ret = lines[3].split(',');
  assert.deepEqual([ret[2], ret[5], ret[6], ret[10], ret[11]], ['returned', '-400000', '-0.00400000', '-80', '-120'], 'a return is negative in every column');
  const total = lines[4].split(',');
  assert.deepEqual([total[0], total[2], total[5], total[6], total[10], total[11], total[12]], ['TOTAL', 'net', '610000', '0.00610000', '122', '183', 'EUR'], 'the net, in sats and in both fiat columns');
  assert.equal(lines[5], '');
  const plain = LS.toCsv(r).split('\r\n');
  assert.deepEqual([plain[1].split(',').slice(10), plain[4].split(',').slice(10)], [['', '', ''], ['', '', '']], 'without fiat the columns are empty');
  const empty = LS.toCsv(find([], opts));
  assert.equal(empty.split('\r\n').length, 3, 'a header, a total of nothing');
});
