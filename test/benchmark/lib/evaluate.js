'use strict';
/**
 * What the benchmark measures, one function for each heuristic. Each takes a loaded case (see cases.js) and the result of
 * HoplineAnalysis.analyse on it, and returns plain numbers: counts, proportions with a 95% interval, and a short list of the wrong
 * answers so that a reader can look at them. Nothing here changes the analysis.
 */
const AN = require('../../../public/js/hopline-analysis.js');
const { wilson, mean } = require('./stats.js');

const ELIGIBLE_CHANGE = (t) => Object.prototype.hasOwnProperty.call(t, 'change_vout');
const TIERS = ['high', 'medium', 'low'];

function tier() { return { n: 0, correct: 0, wrong: 0 }; }

function analyse(c, extra) {
  const known = new Set(c.truth.known || []);
  return AN.analyse(c.graph, Object.assign({ known: (a) => known.has(a) }, extra || {}));
}

// ---- the change guess -------------------------------------------------------------------------------------------------------
/** The wallet habits a transaction's sender had, as the strata the change results are cut by. */
function strata(c, t) {
  const w = (c.truth.wallets || {})[t.wallet] || {}, b = w.behaviour || {};
  return { 'wallet software': w.software || 'unknown', 'change position': b.change_position || 'unknown', 'receive type': b.address_type || 'unknown',
           'change type': b.change_type === b.address_type ? 'same as receive' : (b.change_type || 'unknown'), 'amounts': b.round_payments > 0.5 ? 'mostly round' : 'mostly not round',
           'address reuse': (t.tags || []).indexOf('reuse') >= 0 ? 'change reused an address' : 'fresh change', 'inputs': t.inputs > 1 ? 'several inputs' : 'one input' };
}

function evaluateChange(c, an) {
  const out = { transactions: 0, withChange: 0, noChange: 0, all: tier(), abstained: 0, tiers: { high: tier(), medium: tier(), low: tier() }, noChangeGuessed: { n: 0, byTier: { high: 0, medium: 0, low: 0 } },
                baselines: { random: [], largest: tier(), smallest: tier(), first: tier(), last: tier() }, wrongHigh: [], strata: {}, bySigns: {}, byCount: {} };
  const signalUse = {};
  Object.keys(c.truth.txs).forEach((txid) => {
    const t = c.truth.txs[txid];
    if (!ELIGIBLE_CHANGE(t)) return;
    const rec = an.tx.get('tx:' + txid), v = AN.txView(c.graph, 'tx:' + txid);
    if (!v || !v.complete) return;
    out.transactions++;
    const g = rec ? rec.change : null;
    if (t.change_vout == null) {                                                          // a transaction that has no change: any guess is wrong
      out.noChange++;
      if (g) { out.noChangeGuessed.n++; out.noChangeGuessed.byTier[g.confidence]++; }
      return;
    }
    out.withChange++;
    const pay = AN.payOuts(v), n = pay.length;
    if (n >= 2) {
      out.baselines.random.push(1 / n);
      const by = (f) => pay.slice().sort((x, y) => f(x, y) || x.vout - y.vout)[0].vout;
      const picks = { largest: by((x, y) => y.amount - x.amount), smallest: by((x, y) => x.amount - y.amount), first: pay[0].vout, last: pay[n - 1].vout };
      Object.keys(picks).forEach((k) => { out.baselines[k].n++; if (picks[k] === t.change_vout) out.baselines[k].correct++; else out.baselines[k].wrong++; });
    }
    const s = strata(c, Object.assign({ inputs: v.inputs.length }, t));
    Object.keys(s).forEach((dim) => {
      const row = ((out.strata[dim] = out.strata[dim] || {})[s[dim]] = out.strata[dim][s[dim]] || { transactions: 0, guessed: 0, correct: 0 });
      row.transactions++;
      if (g) { row.guessed++; if (g.vout === t.change_vout) row.correct++; }
    });
    if (!g) { out.abstained++; return; }
    g.reasons.forEach((r) => { const k = AN.signalOf(r); if (!k) throw new Error('a reason that belongs to no signal: ' + r); signalUse[k] = (signalUse[k] || 0) + 1; });
    const ok = g.vout === t.change_vout;
    // how many different signs the guess rests on, and which: a guess on one sign is a lead, and this says how good a lead
    const signs = Array.from(new Set(g.reasons.map(AN.signalOf))).sort(), count = signs.length >= 3 ? '3 or more' : String(signs.length);
    [[out.bySigns, signs.join(' + ')], [out.byCount, g.confidence + '|' + count]].forEach(([map, key]) => { const x = map[key] = map[key] || tier(); x.n++; if (ok) x.correct++; else x.wrong++; });
    [out.all, out.tiers[g.confidence]].forEach((x) => { x.n++; if (ok) x.correct++; else x.wrong++; });
    if (!ok && g.confidence === 'high' && out.wrongHigh.length < 15) out.wrongHigh.push({ txid, guessed: g.vout, change: t.change_vout, wallet: t.wallet, reasons: g.reasons });
  });
  out.signalUse = signalUse;
  return summarise(out);
}

function summarise(o) {
  const r = Object.assign({}, o);
  r.coverage = wilson(o.all.n, o.withChange);
  r.precision = wilson(o.all.correct, o.all.n);
  r.byTier = {};
  TIERS.forEach((k) => { r.byTier[k] = { guesses: wilson(o.tiers[k].n, o.withChange), precision: wilson(o.tiers[k].correct, o.tiers[k].n) }; });
  r.byCount = {}; Object.keys(o.byCount).forEach((k) => { r.byCount[k] = { guesses: o.byCount[k].n, precision: wilson(o.byCount[k].correct, o.byCount[k].n) }; });
  r.bySigns = {}; Object.keys(o.bySigns).forEach((k) => { r.bySigns[k] = { guesses: o.bySigns[k].n, correct: o.bySigns[k].correct }; });
  r.baselineAccuracy = { random: mean(o.baselines.random) };
  ['largest', 'smallest', 'first', 'last'].forEach((k) => { r.baselineAccuracy[k] = o.baselines[k].n ? wilson(o.baselines[k].correct, o.baselines[k].n) : null; });
  r.strataTable = {};
  Object.keys(o.strata).forEach((dim) => {
    r.strataTable[dim] = Object.keys(o.strata[dim]).sort().map((name) => { const x = o.strata[dim][name]; return { name, transactions: x.transactions, coverage: wilson(x.guessed, x.transactions), precision: wilson(x.correct, x.guessed) }; });
  });
  return r;
}

// ---- clusters ---------------------------------------------------------------------------------------------------------------
const pairs = (n) => n * (n - 1) / 2;

function evaluateClusters(c, an) {
  const owners = c.truth.owners || {};
  let predicted = 0, truePairs = 0, impure = 0, impureAddrs = 0, clusters = 0, addrsInClusters = 0, unowned = 0;
  const examples = [];
  an.clusters.list.forEach((cl) => {
    const byOwner = new Map();
    cl.addrs.forEach((id) => { const o = owners[id.replace(/^addr:/, '')]; if (!o) { unowned++; return; } byOwner.set(o, (byOwner.get(o) || 0) + 1); });
    const n = Array.from(byOwner.values()).reduce((a, b) => a + b, 0);
    clusters++; addrsInClusters += n;
    predicted += pairs(n);
    byOwner.forEach((m) => { truePairs += pairs(m); });
    if (byOwner.size > 1) { impure++; impureAddrs += n; if (examples.length < 8) examples.push({ cluster: cl.id.replace(/^addr:/, ''), owners: Object.fromEntries(byOwner), addresses: n }); }
  });
  // the pairs that exist at all: addresses of one owner that were spent from (only an address that was spent can be linked by co-spending)
  const spent = new Map();
  c.graph.nodes.forEach((nd) => {
    if (nd.type !== 'addr') return;
    const o = owners[nd.address]; if (!o) return;
    let isInput = false;
    c.graph.edgesOf(nd.id).forEach((e) => { if (e.kind === 'in' && e.source === nd.id) isInput = true; });
    if (isInput) spent.set(o, (spent.get(o) || 0) + 1);
  });
  let possible = 0; spent.forEach((m) => { possible += pairs(m); });
  // the best a co-spend rule could do: join the inputs of every transaction that had one sender, and none that mixed owners
  const parent = new Map(), find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  Object.keys(c.truth.txs).forEach((txid) => {
    const t = c.truth.txs[txid];
    if (t.kind === 'coinjoin' || t.kind === 'payjoin') return;
    const v = AN.txView(c.graph, 'tx:' + txid); if (!v || v.coinbase) return;
    const addrs = Array.from(new Set(v.inputs.map((i) => i.address).filter(Boolean)));
    addrs.forEach(add); for (let i = 1; i < addrs.length; i++) { const a = find(addrs[0]), b = find(addrs[i]); if (a !== b) parent.set(b, a); }
  });
  const groups = new Map(); parent.forEach((_, a) => { const r = find(a); groups.set(r, (groups.get(r) || 0) + 1); });
  let oracle = 0; groups.forEach((m) => { oracle += pairs(m); });
  // of those, the pairs Hopline also put in one cluster; a right pair it got only through a transaction the oracle left out (a PayJoin) is not one of them
  let found = 0;
  an.clusters.list.forEach((cl) => {
    const by = new Map();
    cl.addrs.forEach((id) => { const a = id.replace(/^addr:/, ''); if (parent.has(a)) { const r = find(a); by.set(r, (by.get(r) || 0) + 1); } });
    by.forEach((m) => { found += pairs(m); });
  });
  return { clusters, addressesClustered: addrsInClusters, unowned, joinedPairs: predicted, joinedPairsSameOwner: truePairs,
           precision: wilson(truePairs, predicted), recallOfAllPairs: wilson(truePairs, possible), recallOfWhatCoSpendingCanFind: wilson(found, oracle),
           clustersWithSeveralOwners: impure, addressesInThem: impureAddrs, impureShare: wilson(impure, clusters), examples,
           skipped: an.clusters.skipped };
}

// ---- patterns of one transaction -----------------------------------------------------------------------------------------
function flagged(an, txid, kind) {
  const r = an.tx.get('tx:' + txid);
  return !!(r && r.flags.some((f) => f.kind === kind));
}

/** Is the transaction a positive of `kind`? What it was made to be: a sweep is a consolidation. */
const INTENT = { consolidation: (k) => k === 'consolidation' || k === 'sweep', batch: (k) => k === 'batch', coinjoin: (k) => k === 'coinjoin' };

function evaluateFlag(c, an, kind) {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 }, wrongKinds = {}, missed = {};
  Object.keys(c.truth.txs).forEach((txid) => {
    const t = c.truth.txs[txid];
    const v = AN.txView(c.graph, 'tx:' + txid); if (!v || !v.complete) return;
    const positive = INTENT[kind](t.kind), seen = flagged(an, txid, kind);
    if (positive && seen) m.tp++; else if (positive) { m.fn++; missed[t.kind] = (missed[t.kind] || 0) + 1; } else if (seen) { m.fp++; wrongKinds[t.kind] = (wrongKinds[t.kind] || 0) + 1; } else m.tn++;
  });
  return { counts: m, recall: wilson(m.tp, m.tp + m.fn), precision: wilson(m.tp, m.tp + m.fp), falsePositiveRate: wilson(m.fp, m.fp + m.tn), falsePositivesByKind: wrongKinds, missedByKind: missed };
}

// ---- peel chains ------------------------------------------------------------------------------------------------------------
const PEEL_BANDS = [{ name: 'up to 0.1', hi: 0.1 }, { name: '0.1 to 0.25', hi: 0.25 }, { name: '0.25 to 0.5', hi: 0.5 }, { name: 'over 0.5', hi: 1 }, { name: 'not two outputs', hi: Infinity }];
function evaluateChains(c, an) {
  const truth = (c.truth.chains || []).map((ch) => new Set(ch)), inTruth = new Set(); truth.forEach((s) => s.forEach((t) => inTruth.add(t)));
  const found = an.chains.map((ch) => ch.txids);
  const overlap = (a, set) => a.filter((t) => set.has(t)).length;
  const recalled = truth.filter((s) => found.some((d) => overlap(d, s) >= 0.8 * s.size)).length;
  const real = found.filter((d) => truth.some((s) => overlap(d, s) >= 0.8 * d.length)).length;
  const notThere = found.filter((d) => !truth.some((s) => overlap(d, s) >= 0.5 * d.length)).length;
  const others = Object.keys(c.truth.txs).filter((t) => !inTruth.has(t)).length;
  const flaggedSteps = Array.from(inTruth).filter((t) => (an.tx.get('tx:' + t) || {}).chain).length;
  // each step of a real chain by the smaller output over the larger, which is what the rule's cut-off is about
  const byId = new Map(c.txs.map((t) => [t.txid, t])), bands = PEEL_BANDS.map((b) => ({ name: b.name, hi: b.hi, steps: 0, peelStep: 0, inChain: 0 }));
  inTruth.forEach((id) => {
    const t = byId.get(id), vals = t ? t.vout.map((o) => o.value).filter((x) => x > 0) : [];
    const ratio = vals.length === 2 ? Math.min.apply(null, vals) / Math.max.apply(null, vals) : Infinity;
    const b = bands.find((x) => ratio <= x.hi) || bands[bands.length - 1];
    b.steps++;
    if (AN.peelStep(AN.txView(c.graph, 'tx:' + id), {})) b.peelStep++;
    if ((an.tx.get('tx:' + id) || {}).chain) b.inChain++;
  });
  return {
    byRatio: bands.map((b) => ({ name: b.name, steps: b.steps, looksLikeAPeelStep: wilson(b.peelStep, b.steps), inAChain: wilson(b.inChain, b.steps) })), truthChains: truth.length, detected: found.length, recalled: wilson(recalled, truth.length), real: wilson(real, found.length), notThere, otherTransactions: others,
           notThereFlaggedPer1000Others: others ? 1000 * notThere / others : null, stepsFlagged: wilson(flaggedSteps, inTruth.size),
           lengths: { truth: truth.map((s) => s.size), detected: found.map((d) => d.length) } };
}

// ---- one case, all of it ------------------------------------------------------------------------------------------------------
/** The measures of a case with the analysis as the workspace runs it, and with each change signal switched off in turn. */
function evaluateCase(c, options) {
  options = options || {};
  const an = analyse(c);
  const r = { name: c.name, transactions: c.txs.length, wallets: Object.keys(c.truth.wallets || {}).length, addresses: Object.keys(c.truth.owners || {}).length,
              kinds: {}, change: evaluateChange(c, an), clusters: evaluateClusters(c, an), coinjoin: evaluateFlag(c, an, 'coinjoin'), consolidation: evaluateFlag(c, an, 'consolidation'),
              batch: evaluateFlag(c, an, 'batch'), peel: evaluateChains(c, an) };
  Object.keys(c.truth.txs).forEach((t) => { const k = c.truth.txs[t].kind; r.kinds[k] = (r.kinds[k] || 0) + 1; });
  if (options.variants !== false) {
    r.variants = {};
    AN.CHANGE_SIGNALS.forEach(([sig]) => { r.variants['without ' + sig] = summaryOfChange(evaluateChange(c, analyse(c, { changeOff: [sig] }))); });
    if ((c.truth.known || []).length) r.variants['without the known list'] = summaryOfChange(evaluateChange(c, AN.analyse(c.graph, {})));
    const noJoin = analyse(c, { coinjoin: { minIn: 1e9, minEqual: 1e9 } });
    r.variants['clusters without the CoinJoin exclusion'] = { clusters: evaluateClusters(c, noJoin) };
  }
  return r;
}

function summaryOfChange(ch) { return { coverage: ch.coverage, precision: ch.precision, high: ch.byTier.high, medium: ch.byTier.medium, low: ch.byTier.low }; }

module.exports = { evaluateCase, evaluateChange, evaluateClusters, evaluateFlag, evaluateChains, analyse, TIERS };
