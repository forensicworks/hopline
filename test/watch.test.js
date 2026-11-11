'use strict';
// Watching a wallet (public/js/hopline-watch.js): what changed between what the page shows and what the server says now, how to join it in, and the words of an alert. No browser, no clock, no network.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../public/js/hopline-watch.js');

/** An Esplora transaction: ins and outs are [address, value]; height null = unconfirmed. */
function tx(id, height, ins, outs) {
  return { txid: id, fee: 100, weight: 400, status: height == null ? { confirmed: false } : { confirmed: true, block_height: height, block_time: 1700000000 + height * 600 },
           vin: ins.map(([a, v], i) => ({ txid: 'p' + id + i, vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: v } })),
           vout: outs.map(([a, v]) => ({ scriptpubkey_address: a, scriptpubkey_type: 'v0_p2wpkh', value: v })) };
}
const W = 'bc1qwatchedwalletaddressxxxxxxxxxxxxxx';
const incoming = (id, height, value) => tx(id, height, [['payer', value + 100]], [[W, value]]);
const stats = (n, funded, spent, mn, mf, ms) => ({ chain_stats: { tx_count: n, funded_txo_sum: funded, spent_txo_sum: spent }, mempool_stats: { tx_count: mn || 0, funded_txo_sum: mf || 0, spent_txo_sum: ms || 0 } });

test('the choices: one of the offered minutes, else the default; an interval in milliseconds', () => {
  assert.deepEqual(T.INTERVALS, [1, 2, 5, 10, 30]); assert.equal(T.DEFAULT_MINUTES, 2);
  assert.equal(T.cleanMinutes(5), 5); assert.equal(T.cleanMinutes('10'), 10);
  [0, 3, -1, 'x', null, undefined, NaN].forEach((v) => assert.equal(T.cleanMinutes(v), 2, String(v)));
  assert.equal(T.intervalMs(1), 60000); assert.equal(T.intervalMs(30), 1800000); assert.equal(T.intervalMs('nonsense'), 120000);
});

test('fingerprint: equal for equal totals, different when any count or sum differs, confirmed or not', () => {
  const base = stats(3, 900, 400, 1, 50, 0), fp = T.fingerprint(base);
  assert.equal(T.fingerprint(stats(3, 900, 400, 1, 50, 0)), fp); assert.equal(T.changed(fp, base), false);
  [stats(4, 900, 400, 1, 50, 0), stats(3, 901, 400, 1, 50, 0), stats(3, 900, 401, 1, 50, 0), stats(3, 900, 400, 2, 50, 0), stats(3, 900, 400, 1, 51, 0), stats(3, 900, 400, 1, 50, 1)]
    .forEach((s, i) => assert.equal(T.changed(fp, s), true, 'variant ' + i));
  assert.equal(typeof T.fingerprint(null), 'string'); assert.equal(T.fingerprint({}), T.fingerprint({ chain_stats: {}, mempool_stats: {} }));
});

test('diff: new transactions, the ones that got confirmed, and nothing when nothing happened', () => {
  const a = incoming('a', 100, 1000), b = incoming('b', 101, 2000), c = incoming('c', null, 3000);
  const have = [c, b, a];
  let d = T.diff(have, [c, b, a]);
  assert.deepEqual([d.added, d.confirmed, d.gap], [[], [], false]);
  const e = incoming('e', null, 500);
  d = T.diff(have, [e, c, b, a]);
  assert.deepEqual(d.added.map((t) => t.txid), ['e']); assert.equal(d.confirmed.length, 0);
  const cNow = incoming('c', 102, 3000);
  d = T.diff(have, [cNow, b, a]);
  assert.equal(d.added.length, 0); assert.equal(d.confirmed.length, 1); assert.equal(d.confirmed[0].tx.txid, 'c'); assert.equal(d.confirmed[0].tx.status.block_height, 102); assert.equal(d.confirmed[0].was, c);
  assert.deepEqual(T.diff(null, null), { added: [], confirmed: [], gap: false }, 'nothing at all');
  d = T.diff([], [a]); assert.deepEqual(d.added.map((t) => t.txid), ['a'], 'a wallet that showed no transactions');
});

test('diff: a whole page of confirmed transactions that the page does not hold is a gap, and only then', () => {
  const have = [incoming('old', 5, 100)];
  const page = (n) => Array.from({ length: n }, (_, i) => incoming('n' + i, 1000 - i, 100));
  assert.equal(T.diff(have, page(24)).gap, false, '24 new ones are joined to the old one: the page would have reached it');
  assert.equal(T.diff(have, page(25)).gap, true, 'a full page, none of them known: there may be more in between');
  assert.equal(T.diff(have, page(24).concat([have[0]])).gap, false, 'a full page that reaches a known one is joined');
  assert.equal(T.diff([], page(25)).gap, false, 'nothing shown before: nothing to join to');
  assert.equal(T.diff([incoming('u', null, 5)], page(25)).gap, false, 'only an unconfirmed transaction was shown: nothing confirmed to join to');
});

test('merge: new ones on top, unconfirmed before confirmed, newest block first, a confirmed one with its new status, the old list untouched', () => {
  const a = incoming('a', 100, 1000), b = incoming('b', 101, 2000), c = incoming('c', null, 3000);
  const have = [c, b, a], before = JSON.stringify(have);
  const cNow = incoming('c', 102, 3000), e = incoming('e', null, 500), f = incoming('f', 103, 700);
  const m = T.merge(have, [e, f, cNow, b, a]);
  assert.deepEqual(m.txs.map((t) => t.txid), ['e', 'f', 'c', 'b', 'a'], 'unconfirmed e first, then 103, 102, 101, 100');
  assert.deepEqual(m.added.map((t) => t.txid), ['e', 'f']); assert.deepEqual(m.confirmed.map((x) => x.tx.txid), ['c']);
  assert.equal(m.txs.find((t) => t.txid === 'c').status.block_height, 102); assert.equal(m.txs.find((t) => t.txid === 'c').status.confirmed, true);
  assert.equal(JSON.stringify(have), before, 'the list that was passed in is not changed'); assert.equal(have[0], c, 'and neither are its transactions');
  assert.equal(m.txs.find((t) => t.txid === 'b'), b, 'a transaction nothing happened to is the same object');
  assert.deepEqual(T.merge(have, have).txs, have, 'nothing new: the same list');
  assert.deepEqual(T.merge([], [a]).txs, [a]);
  const same = T.merge([incoming('x', 50, 1), incoming('y', 50, 2)], [incoming('z', 50, 3), incoming('x', 50, 1)]);
  assert.deepEqual(same.txs.map((t) => t.txid), ['z', 'x', 'y'], 'in the same block the new one goes first and the rest keep their order');
});

test('nextDelay: the interval with a little random, longer after failures up to a limit', () => {
  assert.equal(T.nextDelay(120000, 0, () => 0.5), 120000);
  assert.equal(T.nextDelay(120000, 0, () => 0), 108000); assert.equal(T.nextDelay(120000, 0, () => 1), 132000);
  assert.equal(T.nextDelay(120000, 1, () => 0.5), 240000); assert.equal(T.nextDelay(120000, 2, () => 0.5), 480000);
  assert.equal(T.nextDelay(120000, 3, () => 0.5), 900000, 'capped at 15 minutes'); assert.equal(T.nextDelay(120000, 9, () => 0.5), 900000);
  assert.equal(T.nextDelay(1800000, 0, () => 0.5), 1800000, 'an interval longer than the cap is not cut');
  assert.equal(T.nextDelay(1800000, 3, () => 0.5), 1800000);
  for (let i = 0; i < 50; i++) { const d = T.nextDelay(60000, 0); assert.ok(d >= 54000 && d <= 66000, String(d)); }
  assert.equal(T.nextDelay(1000, -4, () => 0.5), 1000); assert.equal(T.nextDelay(1000, 'x', () => 0.5), 1000);
});

test('describe: one transaction received, unconfirmed, with its amount', () => {
  const w = T.describe(W, [incoming('a', null, 5000000)], [], {});
  assert.equal(w.title, 'Hopline · bc1qwatc…xxxxx'); assert.equal(w.body, '1 new transaction: +0.05000000 BTC received (unconfirmed)');
});

test('describe: one transaction sent, confirmed; one that moved inside the wallet', () => {
  const out = tx('o', 200, [[W, 1000000]], [['shop', 700000], ['other', 299900]]);
  assert.equal(T.describe(W, [out], [], {}).body, '1 new transaction: -0.01000000 BTC sent');
  const self = tx('s', 201, [[W, 1000]], [[W, 900]]);
  assert.equal(T.describe(W, [self], [], {}).body, '1 new transaction: -0.00000100 BTC sent', 'it paid a fee: it is a small outgoing amount');
  const move = tx('m', 202, [[W, 1000], [W, 2000]], [[W, 3000]]);
  assert.equal(T.describe(W, [move], [], {}).body, '1 new transaction: moved inside the wallet');
});

test('describe: several at once are counted with the net amount and how many are unconfirmed', () => {
  const w = T.describe(W, [incoming('a', null, 100000), incoming('b', null, 200000), tx('c', 300, [[W, 50000]], [['shop', 49900]])], [], {});
  assert.equal(w.body, '3 new transactions: +0.00250000 BTC in all (2 unconfirmed)');
});

test('describe: amounts can be left out, and a label names the wallet in the title', () => {
  const a = incoming('a', null, 5000000);
  assert.equal(T.describe(W, [a], [], { amounts: false }).body, '1 new transaction (unconfirmed)');
  assert.equal(T.describe(W, [a, incoming('b', 10, 1)], [], { amounts: false }).body, '2 new transactions (1 unconfirmed)');
  assert.equal(T.describe(W, [a], [], { label: 'DarkSide payment wallet' }).title, 'Hopline · DarkSide payment wallet');
  assert.equal(T.describe(W, [a], [], { shortId: (x) => 'S:' + x.slice(0, 4) }).title, 'Hopline · S:bc1q');
});

test('describe: the labelled wallets on the other side are named, two at most, and never the wallet itself', () => {
  const names = { exA: { label: 'Exchange A' }, exB: { label: 'Exchange B' }, exC: { label: 'Exchange C' }, [W]: { label: 'Me' } };
  const known = (a) => names[a] || null;
  const t = tx('a', 5, [['exA', 1000], ['exB', 1000], ['exC', 1000]], [[W, 2900]]);
  assert.equal(T.describe(W, [t], [], { known }).body, '1 new transaction: +0.00002900 BTC received · with Exchange A, Exchange B and 1 more');
  assert.equal(T.describe(W, [tx('b', 5, [['exA', 1000]], [[W, 900]])], [], { known }).body, '1 new transaction: +0.00000900 BTC received · with Exchange A');
  assert.equal(T.describe(W, [incoming('c', 5, 1000)], [], { known }).body.includes('with'), false, 'no named wallet: nothing said');
});

test('describe: what got confirmed is counted, with or without new ones; nothing at all is an empty body', () => {
  const c = incoming('c', 9, 1000);
  assert.equal(T.describe(W, [], [c], {}).body, '1 transaction confirmed');
  assert.equal(T.describe(W, [], [c, c], {}).body, '2 transactions confirmed');
  assert.equal(T.describe(W, [incoming('a', null, 5000000)], [c], {}).body, '1 new transaction: +0.05000000 BTC received (unconfirmed). 1 transaction confirmed');
  assert.equal(T.describe(W, [], [], {}).body, '');
});

test('bannerText: what is waiting, in words; empty when nothing is', () => {
  const a = incoming('a', 1, 1);
  assert.equal(T.bannerText([], [], false, false), ''); assert.equal(T.bannerText(null, null, false, false), '');
  assert.equal(T.bannerText([a], [], false, false), '1 new transaction'); assert.equal(T.bannerText([a, a], [], false, false), '2 new transactions');
  assert.equal(T.bannerText([a], [{ tx: a }], false, false), '1 new transaction · 1 transaction confirmed');
  assert.equal(T.bannerText([], [{ tx: a }, { tx: a }], false, false), '2 transactions confirmed');
  assert.match(T.bannerText([], [], false, true), /^The totals changed/);
  assert.match(T.bannerText([a], [], true, false), /1 new transaction · more than 25 happened since this page was read, so Show reads the wallet again/);
  assert.match(T.bannerText([], [], true, false), /^more than 25/, 'a gap alone is still said');
});
