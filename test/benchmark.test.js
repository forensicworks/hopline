'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const { wilson, pct, prop } = require('./benchmark/lib/stats.js');
const { evaluateCase, evaluateChange, evaluateClusters, analyse } = require('./benchmark/lib/evaluate.js');
const { loadCase, listCases } = require('./benchmark/lib/cases.js');
const { toMarkdown, pool } = require('./benchmark/lib/report.js');
const mini = require('./benchmark/lib/mini.js');

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
