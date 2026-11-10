'use strict';
// The decision on the one-sign change guess (docs/benchmark.md, "The one-sign question: decided, nothing changed"; PR 56): it stays "medium". These tests do not judge that decision.
// They keep the facts it rests on true: the numbers it quotes come out of the committed cases, and the behaviour it relies on (what a one-sign guess says, that Auto-expand follows a low
// guess too) is what the code does. If one of them fails, the analysis changed under the decision: read the section again, and change it or the code on purpose.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { loadCase } = require('./benchmark/lib/cases.js');
const { analyse, evaluateChange } = require('./benchmark/lib/evaluate.js');
const { loadSample, measure } = require('./benchmark/lib/base-rates.js');
const { Graph, ID } = require('../public/js/hopline-model.js');
const An = require('../public/js/hopline-analysis.js');

const CASES = path.join(__dirname, 'benchmark', 'cases');
const caseDirs = (set) => fs.readdirSync(path.join(CASES, set)).map((d) => path.join(CASES, set, d)).filter((d) => fs.existsSync(path.join(d, 'case.json')));
const changeOf = (dir) => { const c = loadCase(dir); return evaluateChange(c, analyse(c)); };

/** Pooled over the cases of a set: how many guesses of a kind ('medium|1' is a medium guess on one sign) and how many of them were right. */
function pooled(set, keys) {
  let guesses = 0, right = 0;
  caseDirs(set).forEach((d) => keys.forEach((k) => { const b = changeOf(d).byCount[k]; if (b) { guesses += b.guesses; right += b.precision.k; } }));
  return [right, guesses];
}
function tier(set, name) {
  let guesses = 0, right = 0;
  caseDirs(set).forEach((d) => { const t = changeOf(d).byTier[name]; guesses += t.guesses.k !== undefined ? t.guesses.k : t.guesses; right += t.precision.k; });
  return [right, guesses];
}

// ---- the numbers the decision quotes -------------------------------------------------------------------------------------------------------------

test('the synthetic cases, first seed: a medium guess on one sign is right 518 of 579 (89.5%), on two signs 385 of 387 (99.5%), and the low tier 356 of 392 (90.8%)', () => {
  assert.deepEqual(pooled('regtest-v1', ['medium|1']), [518, 579]);
  assert.deepEqual(pooled('regtest-v1', ['medium|2', 'medium|3']), [385, 387]);
  assert.deepEqual(tier('regtest-v1', 'low'), [356, 392]);
});

test('the synthetic cases, fresh seed (2026-11-09): a medium guess on one sign is right 412 of 462 (89.2%), below the low tier as a whole, 401 of 423 (94.8%)', () => {
  assert.deepEqual(pooled('regtest-v2', ['medium|1']), [412, 462]);
  assert.deepEqual(tier('regtest-v2', 'low'), [401, 423]);
});

test('Sparrow and Electrum on testnet4: all 24 medium guesses on one sign are right (both wallets change to the type they receive on, so the sign could not fail there)', () => {
  assert.deepEqual(changeOf(path.join(CASES, 'wallets-v1', 'testnet4-1')).byCount['medium|1'].precision.k, 24);
  assert.equal(changeOf(path.join(CASES, 'wallets-v1', 'testnet4-1')).byCount['medium|1'].guesses, 24);
});

test('Bitcoin Core on signet, receiving on p2sh-segwit and changing to bech32: 35 of 38 medium guesses on one sign are right', () => {
  const r = changeOf(path.join(CASES, 'wallets-v1', 'signet-core-1'));
  assert.deepEqual([r.byCount['medium|1'].precision.k, r.byCount['medium|1'].guesses], [35, 38]);
});

/** Of the payments with one payment output and a change, the guesses that rest on the type sign alone, split by the type of the coins spent and of the recipient (as test/benchmark/by_type.js does). */
function typeAloneByShape(dir) {
  const c = loadCase(dir), an = analyse(c), byId = new Map(c.txs.map((t) => [t.txid, t])), out = {};
  const NAME = { p2pkh: 'legacy', p2sh: 'p2sh', v0_p2wpkh: 'p2wpkh', v1_p2tr: 'taproot', v0_p2wsh: 'p2wsh' };
  Object.keys(c.truth.txs).forEach((txid) => {
    const t = c.truth.txs[txid];
    if (t.kind !== 'payment' || t.change_vout == null) return;
    const raw = byId.get(txid), rec = an.tx.get('tx:' + txid), g = rec && rec.change;
    if (!raw || !g) return;
    const pay = raw.vout.filter((o, i) => i !== t.change_vout && o.scriptpubkey_type !== 'op_return');
    if (pay.length !== 1) return;
    const signs = Array.from(new Set(g.reasons.map(An.signalOf)));
    if (!(signs.length === 1 && signs[0] === 'type')) return;
    const shape = Array.from(new Set(raw.vin.map((x) => NAME[x.prevout.scriptpubkey_type] || x.prevout.scriptpubkey_type))).join('+') + ' -> ' + (NAME[pay[0].scriptpubkey_type] || pay[0].scriptpubkey_type);
    const row = out[shape] = out[shape] || { guesses: 0, right: 0, tiers: new Set() };
    row.guesses++; if (g.vout === t.change_vout) row.right++; row.tiers.add(g.confidence);
  });
  return out;
}

test('signet: the type sign alone fails only for p2sh coins paid to a p2sh address (3 of 3 wrong, all medium) and is right 35 of 35 wherever the recipient\'s type differs from the coins\'', () => {
  const rows = typeAloneByShape(path.join(CASES, 'wallets-v1', 'signet-core-1'));
  const total = Object.values(rows).reduce((a, r) => [a[0] + r.right, a[1] + r.guesses], [0, 0]);
  assert.deepEqual(total, [35, 38], 'the 38 guesses on the type sign alone');
  const wrong = Object.keys(rows).filter((k) => rows[k].right < rows[k].guesses);
  assert.deepEqual(wrong, ['p2sh -> p2sh'], 'it fails in one shape only');
  assert.deepEqual([rows['p2sh -> p2sh'].guesses, rows['p2sh -> p2sh'].right, Array.from(rows['p2sh -> p2sh'].tiers)], [3, 0, ['medium']]);
  Object.keys(rows).filter((k) => k !== 'p2sh -> p2sh').forEach((k) => assert.equal(rows[k].right, rows[k].guesses, k + ' is right every time'));
});

test('on the first sample of the real chain about two thirds of the change guesses rest on one sign (1619 of 2451, 66.1%), and the synthetic cases 1073 of 2358 (45.5%)', () => {
  const real = measure(loadSample(path.join(CASES, 'mainnet-sample')).txs).change;
  assert.deepEqual([real.oneSign, real.guessed], [1619, 2451]);
  const synthetic = measure([].concat.apply([], caseDirs('regtest-v1').map((d) => loadCase(d).txs))).change;
  assert.deepEqual([synthetic.oneSign, synthetic.guessed], [1073, 2358]);
});

// ---- what the decision says the page does -------------------------------------------------------------------------------------------------------

const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const a = (name) => 'bc1q' + name.padEnd(20, 'x');
function add(g, n, ins, outs) {
  g.addTx({ txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: 1650000000 + n * 600 },
    vin: ins.map((i) => ({ txid: tid(i.from), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: i.addr, scriptpubkey_type: i.type || 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => ({ scriptpubkey_address: o.addr, scriptpubkey_type: o.type || 'v0_p2wpkh', value: o.value })) });
  return ID.tx(tid(n));
}

/** A medium guess on the type sign alone: the coins are p2wpkh, one output is p2wpkh and the other taproot. */
function mediumOneSign(g, n) { return add(g, n, [{ from: 90 + n, addr: a('in' + n), value: 5000150 }], [{ addr: a('same' + n), value: 3123456 }, { addr: a('other' + n), value: 1876544, type: 'v1_p2tr' }]); }
/** A low guess on one sign: both outputs are p2wpkh, one amount is round (100,000), so the other output is the one that looks like change (30 points, a lead of 30). */
function lowOneSign(g, n) { return add(g, n, [{ from: 90 + n, addr: a('in' + n), value: 5000150 }], [{ addr: a('pay' + n), value: 100000 }, { addr: a('chg' + n), value: 4899876 }]); }

test('a one-sign guess says so: "Only one sign points to this output", and a lead to check; two signs and a high guess do not say it', () => {
  const g = new Graph(), m = An.guessChange(An.txView(g, mediumOneSign(g, 1)));
  assert.equal(m.confidence, 'medium'); assert.equal(m.reasons.length, 1);
  assert.match(An.changeCaution(m), /^Only one sign points to this output\. Treat this as a lead to check, not as the change: follow both outputs before relying on it\.$/);
  const l = An.guessChange(An.txView(g, lowOneSign(g, 2)));
  assert.equal(l.confidence, 'low'); assert.match(An.changeCaution(l), /^Only one sign points to this output\./, 'a low guess on one sign says it too');
  assert.doesNotMatch(An.changeCaution({ confidence: 'medium', reasons: ['a', 'b'] }), /Only one sign/, 'two signs: the lead is stronger and does not say so');
  assert.equal(An.changeCaution({ confidence: 'high', reasons: ['a'] }), 'A guess from the evidence above, not a certainty.', 'a high guess is not worded as a lead');
});

test('a guess is made at the low tier too, and the hover card\'s cut (medium and above) is where the tiers differ', () => {
  const g = new Graph(), l = An.guessChange(An.txView(g, lowOneSign(g, 1)));
  assert.equal(l.confidence, 'low'); assert.equal(l.vout, 1, 'the output that is not round');
  assert.deepEqual([An.rank('low'), An.rank('medium'), An.rank('high')], [1, 2, 3], 'the page shows a guess on the hover card from rank 2 up');
  assert.equal(An.changeTitle('high'), 'Likely change'); assert.equal(An.changeTitle('medium'), 'Possible change'); assert.equal(An.changeTitle('low'), 'Possible change', 'only a high guess is "likely"');
});

test('Auto-expand\'s "follow the change" follows a low guess as it follows a medium one, and stops only where there is no guess', () => {
  const g = new Graph();
  const low = lowOneSign(g, 1), medium = mediumOneSign(g, 2);
  g.addOutspends(tid(1), [{ spent: true, txid: tid(11), vin: 0, status: { confirmed: true, block_time: 1650000900 } }, { spent: true, txid: tid(12), vin: 0, status: { confirmed: true, block_time: 1650001000 } }]);
  g.addOutspends(tid(2), [{ spent: true, txid: tid(13), vin: 0, status: { confirmed: true, block_time: 1650001100 } }, { spent: true, txid: tid(14), vin: 0, status: { confirmed: true, block_time: 1650001200 } }]);
  assert.equal(An.guessChange(An.txView(g, low)).confidence, 'low'); assert.equal(An.guessChange(An.txView(g, medium)).confidence, 'medium');
  const sl = An.successors(g, low, 'next', { follow: 'change' }), sm = An.successors(g, medium, 'next', { follow: 'change' });
  assert.deepEqual(sl.next, [tid(12)], 'the low guess is the second output, and it is the one followed'); assert.equal(sl.stop, null);
  assert.deepEqual(sm.next, [tid(13)], 'the medium guess is the first output'); assert.equal(sm.stop, null);
  const none = add(g, 3, [{ from: 93, addr: a('in3'), value: 5000150 }], [{ addr: a('o3a'), value: 2500075 }, { addr: a('o3b'), value: 2500075 }]);
  g.addOutspends(tid(3), [{ spent: true, txid: tid(15), vin: 0, status: { confirmed: true, block_time: 1650001300 } }, { spent: true, txid: tid(16), vin: 0, status: { confirmed: true, block_time: 1650001400 } }]);
  const s0 = An.successors(g, none, 'next', { follow: 'change' });
  assert.deepEqual(s0.next, []); assert.match(s0.stop, /no clear change output/, 'with no guess at all it stops');
});
