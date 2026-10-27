'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const { wilson, pct, prop } = require('./benchmark/lib/stats.js');
const { evaluateCase, evaluateChange, evaluateClusters, analyse } = require('./benchmark/lib/evaluate.js');
const { loadCase, listCases } = require('./benchmark/lib/cases.js');
const { toMarkdown, pool } = require('./benchmark/lib/report.js');
const mini = require('./benchmark/lib/mini.js');
const base = require('./benchmark/lib/base-rates.js');

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), a + ' is not ' + b);

// ---- the statistics -----------------------------------------------------------------------------------------------------
test('wilson: the interval of a proportion, with its edges kept inside 0 and 1', () => {
  const w = wilson(50, 100);
  near(w.p, 0.5); near(w.lo, 0.4038, 1e-4); near(w.hi, 0.5962, 1e-4);
  const all = wilson(20, 20); assert.equal(all.p, 1); assert.equal(all.hi, 1); assert.ok(all.lo > 0.83 && all.lo < 0.84, 'twenty of twenty is not certainty: ' + all.lo);
  const none = wilson(0, 20); assert.equal(none.p, 0); assert.equal(none.lo, 0); assert.ok(none.hi > 0.16 && none.hi < 0.17);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, p: null, lo: null, hi: null });
});

test('pct, prop and pool: how a proportion is written, and several added up', () => {
  assert.equal(pct(0.9234), '92.3%'); assert.equal(pct(null), 'n/a'); assert.equal(pct(0.5, 0), '50%');
  assert.equal(prop(wilson(0, 0)), 'none'); assert.match(prop(wilson(1, 2)), /^50\.0% \(\d+\.\d% to \d+\.\d%\), 1 of 2$/);
  const p = pool([wilson(1, 2), wilson(3, 4), null, wilson(0, 0)]);
  assert.equal(p.k, 4); assert.equal(p.n, 6);
});

// ---- the counting, on cases with answers worked out by hand -----------------------------------------------------------------------
test('change: the tiers, the abstention, the wrong guess, the guess on a transaction with no change, and the baselines', () => {
  const c = mini.changeCase(), r = evaluateChange(c, analyse(c));
  assert.equal(r.transactions, 5); assert.equal(r.withChange, 4); assert.equal(r.noChange, 1);
  assert.deepEqual([r.all.n, r.all.correct, r.all.wrong, r.abstained], [3, 2, 1, 1]);
  assert.deepEqual([r.tiers.high.n, r.tiers.high.correct], [1, 1]); assert.deepEqual([r.tiers.medium.n, r.tiers.medium.correct, r.tiers.medium.wrong], [2, 1, 1]); assert.equal(r.tiers.low.n, 0);
  near(r.coverage.p, 0.75); near(r.precision.p, 2 / 3); assert.equal(r.byTier.high.precision.p, 1); near(r.byTier.medium.precision.p, 0.5);
  assert.deepEqual(r.noChangeGuessed, { n: 1, byTier: { high: 1, medium: 0, low: 0 } }, 'a round payment of another type reads as a payment, so the other output is called change');
  near(r.baselineAccuracy.random, 0.5); near(r.baselineAccuracy.largest.p, 0.25); near(r.baselineAccuracy.first.p, 0.5); near(r.baselineAccuracy.last.p, 0.5); near(r.baselineAccuracy.smallest.p, 0.75);
  assert.equal(r.wrongHigh.length, 0); assert.deepEqual(r.signalUse, { reuse: 1, type: 2 });
  assert.deepEqual(Object.keys(r.byCount).sort(), ['high|1', 'medium|1'], 'every guess here rests on one sign');
  assert.deepEqual([r.byCount['high|1'].guesses, r.byCount['high|1'].precision.k], [1, 1], 'the wallet paying itself back: high on one sign, right');
  assert.deepEqual([r.byCount['medium|1'].guesses, r.byCount['medium|1'].precision.k], [2, 1], 'the same address type alone, twice: one right, one wrong');
  assert.deepEqual(r.bySigns, { reuse: { guesses: 1, correct: 1 }, type: { guesses: 2, correct: 1 } });
});

test('change: a high guess that is wrong is listed with its reasons', () => {
  const c = mini.changeCase(), t = Object.keys(c.truth.txs)[0];
  c.truth.txs[t].change_vout = 0;                                                 // the paper answer is now the other output, so the reuse guess is wrong
  const r = evaluateChange(c, analyse(c));
  assert.equal(r.tiers.high.wrong, 1); assert.equal(r.wrongHigh.length, 1); assert.equal(r.wrongHigh[0].txid, t); assert.match(r.wrongHigh[0].reasons[0], /also one of the inputs/);
});

test('change: a signal switched off removes its guesses and shows in the variants', () => {
  const r = evaluateCase(mini.changeCase());
  assert.equal(r.variants['without reuse'].high.guesses.k, 0); assert.equal(r.variants['without type'].coverage.k, 1, 'only the reuse guess is left');
  assert.ok(!('without the known list' in r.variants), 'no known list in this case, so no variant for it');
});

test('flags and clusters: a CoinJoin found, an equal payout that looks like one, and the co-spend it costs', () => {
  const r = evaluateCase(mini.coinjoinCase());
  assert.deepEqual(r.coinjoin.counts, { tp: 1, fp: 1, fn: 0, tn: 1 }); assert.deepEqual(r.coinjoin.falsePositivesByKind, { 'equal-payout': 1 });
  assert.equal(r.coinjoin.recall.p, 1); near(r.coinjoin.precision.p, 0.5);
  assert.equal(r.clusters.clusters, 0, 'both are left out of clusters, one rightly and one by mistake');
  assert.equal(r.clusters.recallOfWhatCoSpendingCanFind.n, 3); assert.equal(r.clusters.recallOfWhatCoSpendingCanFind.k, 0, 'the three addresses of the exchange should have been joined');
  assert.equal(r.variants['clusters without the CoinJoin exclusion'].clusters.clustersWithSeveralOwners, 1, 'without the exclusion the real CoinJoin joins three owners');
});

test('peel chains: the real chain is found, the ordinary payments are not taken for one', () => {
  const r = evaluateCase(mini.peelCase());
  assert.equal(r.peel.truthChains, 1); assert.equal(r.peel.detected, 1); assert.equal(r.peel.recalled.k, 1); assert.equal(r.peel.real.k, 1); assert.equal(r.peel.notThere, 0);
  assert.equal(r.peel.stepsFlagged.k, 5); assert.equal(r.peel.otherTransactions, 2);
  assert.equal(r.peel.byRatio.reduce((a, b) => a + b.steps, 0), r.peel.stepsFlagged.n, 'every step of a real chain is in one band');
  assert.equal(r.peel.byRatio.reduce((a, b) => a + b.inAChain.k, 0), r.peel.stepsFlagged.k);
});

test('a cluster of two owners is counted as impure and its pairs as wrong', () => {
  const c = mini.make('mix', [
    mini.tx(1, [mini.tx(0, [], []) && { txid: mini.hex(90), vout: 0, address: mini.addr('a'), value: 1000 }, { txid: mini.hex(91), vout: 0, address: mini.addr('b'), value: 1000 }, { txid: mini.hex(92), vout: 0, address: mini.addr('c'), value: 1000 }],
            [{ address: mini.addr('d'), value: 2900 }])], { owners: { [mini.addr('a')]: 'w1', [mini.addr('b')]: 'w1', [mini.addr('c')]: 'w2' }, txs: { [mini.hex(1)]: { kind: 'payjoin' } } });
  const r = evaluateClusters(c, analyse(c));
  assert.equal(r.clusters, 1); assert.equal(r.joinedPairs, 3); assert.equal(r.joinedPairsSameOwner, 1); assert.equal(r.clustersWithSeveralOwners, 1);
  near(r.precision.p, 1 / 3);
  assert.deepEqual([r.recallOfWhatCoSpendingCanFind.k, r.recallOfWhatCoSpendingCanFind.n], [0, 0], 'the oracle leaves a PayJoin out, so a pair joined through one is not counted against it');
});

test('a reason that belongs to no signal is an error, not a silent gap', () => {
  const An = require('../public/js/hopline-analysis.js');
  const real = An.signalOf;
  assert.equal(real('its address is also one of the inputs: the wallet paid itself back'), 'reuse');
  assert.equal(real('something nobody wrote'), '');
});

// ---- reading a case and writing the report -----------------------------------------------------------------------------------
test('a case folder is read, hashed, and refused when it is not one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-bench-')), c = mini.changeCase();
  try {
    fs.mkdirSync(path.join(dir, 'one'));
    fs.writeFileSync(path.join(dir, 'one', 'case.json'), JSON.stringify({ name: 'one', seed: 7 }));
    fs.writeFileSync(path.join(dir, 'one', 'txs.json.gz'), zlib.gzipSync(JSON.stringify(c.txs)));
    fs.writeFileSync(path.join(dir, 'one', 'truth.json'), JSON.stringify(c.truth));
    assert.deepEqual(listCases(dir).map((p) => path.basename(p)), ['one']);
    const loaded = loadCase(path.join(dir, 'one'));
    assert.equal(loaded.txs.length, 5); assert.match(loaded.files.txs, /^[0-9a-f]{64}$/); assert.equal(evaluateChange(loaded, analyse(loaded)).withChange, 4);
    fs.mkdirSync(path.join(dir, 'bad')); fs.writeFileSync(path.join(dir, 'bad', 'case.json'), '{}'); fs.writeFileSync(path.join(dir, 'bad', 'txs.json.gz'), zlib.gzipSync('{}')); fs.writeFileSync(path.join(dir, 'bad', 'truth.json'), '{}');
    assert.throws(() => loadCase(path.join(dir, 'bad')), /not a benchmark case/);
    assert.deepEqual(listCases(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the report names the case, the version it measured and the wrong answers, and says "none" where there were none', () => {
  const results = [mini.changeCase(), mini.coinjoinCase(), mini.peelCase()].map((c) => evaluateCase(c));
  const md = toMarkdown(results, { date: '2026-10-26', commit: 'abc1234', node: 'v0', analysisSha: 'f'.repeat(64), cases: results.map((r) => ({ name: r.name, madeBy: 'by hand' })) });
  ['# Benchmark results', 'abc1234', 'mini-change', '## The change guess', '### What each signal is worth', '## The CoinJoin detector', '## Clusters', '## Peel chains', 'equal-payout 1'].forEach((s) => assert.ok(md.includes(s), s));
  assert.match(md, /There were no high guesses\.|high guesses were wrong/);
  assert.ok(!/undefined|NaN/.test(md), 'no hole in a table');
});

// ---- the cases that are committed (made by tools/bench/make_regtest.py) -----------------------------------------------------------
const CASES = path.join(__dirname, 'benchmark', 'cases', 'regtest-v1');
const FLOORS = path.join(__dirname, 'benchmark', 'floors.json');
const committed = listCases(CASES);

test('the committed cases are well-formed: every address has an owner, every change is an output, chains follow one another, CoinJoins have equal outputs and PayJoins two owners', { skip: committed.length === 0 }, () => {
  const KINDS = new Set(['payment', 'peel', 'batch', 'consolidation', 'coinjoin', 'equal-payout', 'payjoin']);
  committed.forEach((d) => {
    const c = loadCase(d), where = c.name + ': ', byId = new Map(c.txs.map((t) => [t.txid, t]));
    assert.equal(byId.size, c.txs.length, where + 'a transaction is listed twice');
    assert.deepEqual(Object.keys(c.truth.txs).sort(), Array.from(byId.keys()).sort(), where + 'truth and transactions are about the same transactions');
    c.txs.forEach((t) => {
      const e = c.truth.txs[t.txid];
      assert.ok(KINDS.has(e.kind), where + 'unknown kind ' + e.kind);
      t.vin.forEach((v) => assert.ok(c.truth.owners[v.prevout.scriptpubkey_address], where + 'no owner for an input address'));
      t.vout.forEach((o) => assert.ok(o.scriptpubkey_address && c.truth.owners[o.scriptpubkey_address], where + 'no owner for an output address'));
      assert.ok(t.status.confirmed && t.status.block_time > 0 && t.fee > 0 && t.weight > 0, where + 'a transaction that is not whole');
      if (e.change_vout != null) assert.ok(e.change_vout >= 0 && e.change_vout < t.vout.length, where + 'a change that is not an output');
      if (e.change_vout != null && e.wallet && e.kind !== 'payjoin') assert.equal(c.truth.owners[t.vout[e.change_vout].scriptpubkey_address], e.wallet, where + 'the change goes to its sender');
      if (e.kind === 'coinjoin') {
        const count = {}; t.vout.forEach((o) => { count[o.value] = (count[o.value] || 0) + 1; });
        assert.ok(Math.max.apply(null, Object.values(count)) >= 3, where + 'a CoinJoin with fewer than three equal outputs');
        assert.ok(new Set(t.vin.map((v) => c.truth.owners[v.prevout.scriptpubkey_address])).size >= 3, where + 'a CoinJoin with fewer than three owners');
      }
      if (e.kind === 'payjoin') assert.ok(new Set(t.vin.map((v) => c.truth.owners[v.prevout.scriptpubkey_address])).size === 2, where + 'a PayJoin that is not between two');
      if (['payment', 'peel', 'batch', 'consolidation', 'equal-payout'].indexOf(e.kind) >= 0) assert.equal(new Set(t.vin.map((v) => c.truth.owners[v.prevout.scriptpubkey_address])).size, 1, where + 'a one-sender transaction with several owners');
    });
    (c.truth.chains || []).forEach((chain) => chain.forEach((id, i) => {
      if (!i) return;
      const prev = byId.get(chain[i - 1]), t = byId.get(id), e = c.truth.txs[chain[i - 1]];
      assert.deepEqual([t.vin[0].txid, t.vin[0].vout], [prev.txid, e.change_vout], where + 'a chain that does not follow the change');
    }));
    (c.truth.known || []).forEach((a) => assert.ok(c.truth.owners[a], where + "a known address that is nobody's"));
  });
});

// ---- the committed cases: floors that keep a change to the rules from quietly making a guess worse ------------------------------

test('the committed cases are measured above the floors in floors.json', { skip: committed.length === 0 || !fs.existsSync(FLOORS) }, () => {
  const floors = JSON.parse(fs.readFileSync(FLOORS, 'utf8')), results = {};
  committed.forEach((d) => { const r = evaluateCase(loadCase(d), { variants: false }); results[r.name] = r; });
  const sampleDir = path.join(__dirname, 'benchmark', 'cases', 'mainnet-sample');                  // the real sample: its rates, with ceilings
  if (fs.existsSync(path.join(sampleDir, 'case.json'))) results['mainnet-sample'] = base.rates(base.measure(base.loadSample(sampleDir).txs));
  const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  Object.keys(floors.floors).forEach((key) => {
    const [name, ...rest] = key.split(':'), r = results[name];
    assert.ok(r, 'no case called ' + name + ' for the floor ' + key);
    const v = get(r, rest.join(':'));
    assert.ok(typeof v === 'number', key + ' is not a number in the results: ' + v);
    const f = floors.floors[key];
    if (f.min != null) assert.ok(v >= f.min, key + ' is ' + v.toFixed(4) + ', below its floor ' + f.min + ' (' + f.why + ')');
    if (f.max != null) assert.ok(v <= f.max, key + ' is ' + v.toFixed(4) + ', above its ceiling ' + f.max + ' (' + f.why + ')');
  });
});

// ---- rates on real traffic (tier D): nothing is known to be right, so what is checked is the counting ---------------------------------
test('base rates: a CoinJoin, dust-sized equal outputs to different addresses, the same payments to one address, a look-alike that is not flagged, and an ordinary payment are each counted as what they are', () => {
  const H = mini.hex, A = mini.addr;
  const ins = (n, from) => Array.from({ length: n }, (_, i) => ({ txid: H(from + i), vout: 0, address: A('in' + from + '_' + i), value: 2000000 }));
  const outs = (n, value, name) => Array.from({ length: n }, (_, i) => ({ address: A(name + i), value }));
  const txs = [
    mini.tx(1, ins(3, 100), outs(5, 1000000, 'cj')),                                                   // 3 inputs, 5 outputs of 0.01 BTC: a CoinJoin
    mini.tx(2, ins(4, 110), outs(10, 600, 'dust').concat(outs(2, 70000, 'rest'))),                     // 4 input addresses, ten outputs of 600 satoshis to ten addresses: flagged (there is no minimum amount), and its shape says dust size
    mini.tx(3, ins(3, 120), outs(3, 50000, 'eq').concat([0, 1, 2, 3, 4].map((i) => ({ address: A('odd' + i), value: 1234567 + i * 1111 })))),     // 3 equal outputs among 8: looks like one, is not flagged
    mini.tx(4, ins(1, 130), [{ address: A('shop'), value: 30000 }, { address: A('back'), value: 1960000 }]),                          // an ordinary payment: one input, two outputs, a small one and a large one
    mini.tx(5, ins(4, 140), Array.from({ length: 10 }, () => ({ address: A('same'), value: 600 })).concat(outs(2, 70000, 'more')))     // the same ten payments to ONE address (what two real transactions on the chain did): one recipient, not a mix
  ];
  const r = base.measure(txs);
  assert.equal(r.transactions, 5);
  assert.equal(r.flags.coinjoin, 2, 'the CoinJoin and the dust batch to different addresses are flagged, the payments to one address are not');
  assert.deepEqual(r.joinClasses, { 'every output the same amount (not a pool size)': 1, 'equal outputs of dust size (under 1000 satoshis: no mix pays out an amount like that)': 1 });
  assert.equal(r.lookalikes.length, 1); assert.equal(r.lookalikes[0].txid, H(3)); assert.equal(r.lookalikes[0].equal, 3); assert.equal(r.lookalikes[0].value, 50000);
  assert.equal(r.peelSteps, 1, 'only the ordinary payment is one coin in and a small and a large output out');
  assert.deepEqual(Object.keys(r.byYear), ['2023']); assert.equal(r.byYear[2023].transactions, 5);
  assert.equal(r.shape['1|2'], 1); assert.equal(r.shape['2 to 4|3 to 5'], 1); assert.equal(r.shape['2 to 4|6 or more'], 3, 'the dust batch, the look-alike and the payments to one address');
});

test('base rates: the Whirlpool shape is five inputs and five outputs of exactly one pool size, and is counted whether or not it is flagged', () => {
  const H = mini.hex, A = mini.addr;
  const five = (pool, n) => mini.tx(n, [0, 1, 2, 3, 4].map((i) => ({ txid: H(200 + n * 10 + i), vout: 0, address: A('w' + n + i), value: pool + 5000 })), [0, 1, 2, 3, 4].map((i) => ({ address: A('x' + n + i), value: pool })));
  const r = base.measure([five(1000000, 1), five(1234567, 2)]);
  assert.equal(r.whirlpoolShaped.all, 1, 'a pool size counts, any other amount does not');
  assert.equal(base.joinClass(five(1000000, 3)), 'Whirlpool-shaped: 5 inputs, 5 outputs of one pool size');
  assert.equal(base.joinClass(five(1234567, 4)), 'every output the same amount (not a pool size)');
});

test('base rates: an output nobody in the sample spent is not said to be unspent, since it may have been spent somewhere else', () => {
  const t = mini.tx(1, [{ txid: mini.hex(90), vout: 0, address: mini.addr('a'), value: 100000 }], [{ address: mini.addr('b'), value: 60000 }, { address: mini.addr('c'), value: 39000 }]);
  const g = base.graphOf([t]);
  assert.ok(!g.nodes.get('tx:' + t.txid).outspendsLoaded, 'nothing was asked about who spent it');
});

test('base rates: a sample folder is read, and a report is made of it with the shape of what was flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-sample-'));
  try {
    const H = mini.hex, A = mini.addr;
    const txs = [mini.tx(1, [0, 1, 2].map((i) => ({ txid: H(100 + i), vout: 0, address: A('i' + i), value: 2000000 })), [0, 1, 2, 3, 4].map((i) => ({ address: A('o' + i), value: 1000000 })))];
    fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ name: 'mini-sample', seed: 1, generator: 'by hand', blocks: [{ height: 1001, hash: 'ab', time: 1700000600, tx_count: 10, pages: [0], transactions: 1 }] }));
    fs.writeFileSync(path.join(dir, 'txs.json.gz'), zlib.gzipSync(JSON.stringify(txs)));
    const s = base.loadSample(dir), real = base.measure(s.txs), md = base.toMarkdown(s, real, base.measure(txs), { date: '2026-01-01', commit: 'abc', analysisSha: 'f'.repeat(64) });
    assert.equal(s.name, 'mini-sample'); assert.equal(real.flags.coinjoin, 1);
    assert.match(md, /rates and shapes, not accuracy/); assert.match(md, /every output the same amount/); assert.match(md, /\| 1 in \|/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- documented cases (tier C): the route is a real chain of spends, and the rules do what the first run found --------------------------
const T = require('./benchmark/lib/trace.js');

/** A recording by hand: A pays a small output nobody spends and a large one that B spends; B pays the endpoint and keeps the rest. */
function miniRecording() {
  const H = mini.hex, A = mini.addr, E = A('end');
  const a = mini.tx(1, [{ txid: H(90), vout: 0, address: A('src'), value: 100000 }], [{ address: A('small'), value: 1000 }, { address: A('mid'), value: 98000 }]);
  const b = mini.tx(2, [{ txid: a.txid, vout: 1, address: A('mid'), value: 98000 }], [{ address: E, value: 90000 }, { address: A('keep'), value: 7800 }]);
  const rec = {};
  rec['/tx/' + a.txid] = a; rec['/tx/' + b.txid] = b;
  rec['/tx/' + a.txid + '/outspends'] = [{ spent: false }, { spent: true, txid: b.txid, vin: 0, status: { confirmed: true, block_time: 1700001200 } }];
  rec['/tx/' + b.txid + '/outspends'] = [{ spent: false }, { spent: false }];
  return { rec, meta: { api: 'https://x.test/api', start: { txid: a.txid }, endpoint: { address: E }, route: [a.txid, b.txid], limits: { hops: 3 } } };
}

test('trace: the largest output reaches the end in two hops with no wrong branch, and what it asked for is counted', async () => {
  const { rec, meta } = miniRecording();
  const r = await T.trace(meta, 'largest', T.replayFetch(rec, meta.api));
  assert.equal(r.reached, true); assert.equal(r.hops, 1); assert.equal(r.onRoute, 2); assert.equal(r.wrongBranches, 0); assert.equal(r.afterTheEnd, 0);
  assert.equal(r.requestsToEnd, 3, 'the first transaction and who spent its outputs, then the second transaction'); assert.equal(r.requests, 4, 'the whole run also asks who spent the second');
  assert.equal(r.endings['output unspent'], 1, 'only the output the rule chose counts: the largest of the second transaction, which nobody has spent');
});

test('trace: a rule that follows the small output does not reach the end and the transactions it loaded off the route are the wrong branches', async () => {
  const { rec, meta } = miniRecording();
  const out = rec['/tx/' + meta.start.txid + '/outspends'];
  out[0] = { spent: true, txid: mini.hex(3), vin: 0, status: { confirmed: true, block_time: 1700001300 } }; out[1] = { spent: false };            // now the small output is the one spent, by a third transaction
  rec['/tx/' + mini.hex(3)] = mini.tx(3, [{ txid: meta.start.txid, vout: 0, address: mini.addr('small'), value: 1000 }], [{ address: mini.addr('else'), value: 500 }]);
  rec['/tx/' + mini.hex(3) + '/outspends'] = [{ spent: false }];
  const r = await T.trace(meta, 'all', T.replayFetch(rec, meta.api));
  assert.equal(r.reached, false, 'the large output is now unspent, so nothing leads to the endpoint'); assert.equal(r.wrongBranches, 1); assert.equal(r.requestsToEnd, undefined);
});

test('trace: a request the recording does not have fails loudly and says how to record it again', async () => {
  const { rec, meta } = miniRecording();
  delete rec['/tx/' + meta.route[1]];
  await assert.rejects(T.trace(meta, 'largest', T.replayFetch(rec, meta.api)), /no answer for .*record the case again/);
});

test('trace: a route that is not a chain of spends, or does not end at the endpoint, is named', () => {
  const { rec, meta } = miniRecording();
  assert.deepEqual(T.checkRoute({ meta, responses: rec }), []);
  const broken = JSON.parse(JSON.stringify(meta)); broken.route = [meta.route[1], meta.route[0]]; broken.start = { txid: meta.route[1] };
  assert.ok(T.checkRoute({ meta: broken, responses: rec }).length >= 1);
  const elsewhere = JSON.parse(JSON.stringify(meta)); elsewhere.endpoint = { address: mini.addr('nowhere') };
  assert.deepEqual(T.checkRoute({ meta: elsewhere, responses: rec }), ['the last transaction of the route does not pay the endpoint']);
});

const PUBLIC = path.join(__dirname, 'benchmark', 'cases', 'public-v1'), publicCases = T.listFolders(PUBLIC);

test('the documented cases: the route is a real chain of spends from the start to a payment of the endpoint, and each rule does what the first run found', { skip: publicCases.length === 0 }, async () => {
  for (const d of publicCases) {
    const c = T.loadCaseFolder(d);
    assert.ok(c.responses, c.name + ' has no recording');
    assert.deepEqual(T.checkRoute(c), [], c.name + ': the route');
    assert.ok(c.meta.documented.length >= 2 && c.meta.documented.every((x) => x.source && x.read), c.name + ': every claim needs a source and what was read of it');
    for (const rule of Object.keys(c.meta.expect || {})) {
      const r = await T.trace(c.meta, rule, T.replayFetch(c.responses, c.meta.api));
      Object.keys(c.meta.expect[rule]).forEach((k) => assert.equal(r[k], c.meta.expect[rule][k], c.name + ': the ' + rule + ' rule, ' + k + ' (' + (c.meta.expect_note || '') + ')'));
    }
  }
});

const SAMPLE = path.join(__dirname, 'benchmark', 'cases', 'mainnet-sample');

test('the committed real sample says what it is, and every transaction in it can be analysed', { skip: !fs.existsSync(path.join(SAMPLE, 'case.json')) }, () => {
  const s = base.loadSample(SAMPLE), m = s.meta;
  assert.equal(m.generator, 'tools/bench/fetch_mainnet_sample.py'); assert.equal(m.tier, 'D'); assert.ok(m.seed && m.tip_when_chosen > 900000);
  assert.equal(m.transactions, s.txs.length, 'the count in case.json is the count in the file');
  assert.equal(new Set(s.txs.map((t) => t.txid)).size, s.txs.length, 'a transaction is listed twice');
  assert.deepEqual(m.blocks.map((b) => b.height), m.blocks.map((b) => b.height).slice().sort((a, b) => a - b), 'blocks in order');
  assert.equal(m.blocks.reduce((a, b) => a + b.transactions, 0), s.txs.length, 'what each block gave adds up');
  const heights = new Set(m.blocks.map((b) => b.height));
  s.txs.forEach((t) => {
    assert.ok(t.status.confirmed && heights.has(t.status.block_height), 'a transaction from a block that was not chosen: ' + t.txid);
    t.vin.forEach((v) => assert.ok(v.is_coinbase || (v.prevout && v.prevout.value >= 0 && v.prevout.scriptpubkey_type), 'an input without its previous output: ' + t.txid));
    assert.ok(t.vout.length > 0 && t.vout.every((o) => o.value >= 0 && o.scriptpubkey_type));
    t.vin.forEach((v) => { assert.ok(!('witness' in v) || v.is_coinbase, 'a signature that was meant to be left out'); });
  });
  const years = new Set(s.txs.map((t) => new Date(t.status.block_time * 1000).getUTCFullYear()));
  assert.ok(years.size >= 6, 'spread over the years: ' + Array.from(years).join(', '));
});

test('compare: what one version flags and another does not is listed as dropped, added or kept, and a version compared with itself differs in nothing', () => {
  const H = mini.hex, A = mini.addr, AN = require('../public/js/hopline-analysis.js');
  const ins = (n, from) => Array.from({ length: n }, (_, i) => ({ txid: H(from + i), vout: 0, address: A('in' + from + '_' + i), value: 2000000 }));
  const txs = [
    mini.tx(1, ins(3, 100), Array.from({ length: 5 }, (_, i) => ({ address: A('cj' + i), value: 1000000 }))),                         // equal outputs to five addresses: a CoinJoin shape
    mini.tx(2, ins(4, 110), Array.from({ length: 6 }, () => ({ address: A('same'), value: 600 }))),                                   // six outputs of one amount to ONE address
    mini.tx(3, ins(1, 120), [{ address: A('shop'), value: 30000 }, { address: A('back'), value: 1960000 }])
  ];
  const same = base.compareFlags(txs, AN, AN, 'coinjoin');
  assert.deepEqual([same.before, same.after, same.dropped.length, same.added.length], [1, 1, 0, 0]);
  const flagsAll = { analyse: () => ({ tx: new Map(txs.map((t) => ['tx:' + t.txid, { flags: [{ kind: 'coinjoin' }] }])) }) };            // an earlier version that flagged every transaction
  const r = base.compareFlags(txs, flagsAll, AN, 'coinjoin');
  assert.equal(r.before, 3); assert.deepEqual(r.kept, [H(1)]); assert.deepEqual(r.dropped.sort(), [H(2), H(3)].sort()); assert.deepEqual(r.added, []);
  const d = base.describe(txs[1]);
  assert.equal(d.outputs, 6); assert.equal(d.outputAddresses, 1); assert.equal(d.equalRecipients, 1, 'six outputs, one recipient'); assert.equal(d.inputAddresses, 4);
});
