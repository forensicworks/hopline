'use strict';
/**
 * Rates on real traffic (tier D of docs/benchmark.md): how often each flag fires on transactions nobody scripted, and what the change guess
 * does with them. Nobody knows who owns what in a sample of the chain, so there is no right or wrong here, only how often and of what shape;
 * the shape is what lets a reader judge a flag by eye. Nothing here touches the network (tools/bench/fetch_mainnet_sample.py made the sample).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { Graph } = require('../../../public/js/hopline-model.js');
const AN = require('../../../public/js/hopline-analysis.js');
const { wilson, prop, pct } = require('./stats.js');

const WHIRLPOOL_POOLS = [100000, 1000000, 5000000, 50000000];          // satoshis: the sizes of the pools, 5 inputs and 5 outputs of one size
const DUST = 1000;                                                      // satoshis: an amount nobody mixes to
const LOOKALIKE = { minEqual: 3, minSats: 10000, minIn: 3 };            // the shape of a CoinJoin that the detector did not flag, to be looked at by hand
const IN_BUCKETS = [['1', (n) => n === 1], ['2 to 4', (n) => n >= 2 && n <= 4], ['5 to 9', (n) => n >= 5 && n <= 9], ['10 or more', (n) => n >= 10]];
const OUT_BUCKETS = [['1', (n) => n === 1], ['2', (n) => n === 2], ['3 to 5', (n) => n >= 3 && n <= 5], ['6 or more', (n) => n >= 6]];

function loadSample(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const txs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'txs.json.gz'))).toString('utf8'));
  return { name: meta.name || path.basename(dir), dir, meta, txs };
}

/** The graph of a list of transactions with no claim about an output nobody in the list spent: it may well have been spent somewhere else. */
function graphOf(txs) { const g = new Graph(); txs.forEach((t) => g.addTx(t)); return g; }

/** What a CoinJoin-like transaction looks like, by its shape alone: a reader can check a class by eye, and none of it is a verdict. */
function joinClass(t) {
  const e = equalOutputs(t), top = e.value, same = e.count, outs = t.vout.length, ins = t.vin.length;
  if (+top < DUST) return 'equal outputs of dust size (under ' + DUST + ' satoshis: no mix pays out an amount like that)';
  if (ins === 5 && outs === 5 && same === 5 && WHIRLPOOL_POOLS.indexOf(+top) >= 0) return 'Whirlpool-shaped: 5 inputs, 5 outputs of one pool size';
  if (same === outs) return 'every output the same amount (not a pool size)';
  if (outs - same <= same) return 'equal outputs and a few others (change, or a fee)';
  return 'equal outputs among many others';
}

/** The amount most recipients were paid and how many different addresses were paid it, as the detector counts (outputs that pay one address again count once). */
function equalOutputs(t) {
  const by = {};
  t.vout.forEach((o, i) => { (by[o.value] = by[o.value] || new Set()).add(o.scriptpubkey_address || ('output ' + i)); });
  const top = Object.keys(by).sort((a, b) => by[b].size - by[a].size || a - b)[0];
  return { value: +top, count: by[top].size };
}

/**
 * What a detected peel chain looks like, by its shape alone (the first that fits): a way for a reader to look at them, not a verdict.
 * Peeling a dust-sized amount next to an OP_RETURN output is what token-protocol transfers look like; the same amount again and again, or a
 * chain inside one block, is a service paying out in turn.
 */
function chainClass(ch, byId) {
  const ts = ch.txids.map((id) => byId.get(id)).filter(Boolean), amounts = ch.peeled.map((p) => p.amount);
  const opReturn = ts.some((t) => t.vout.some((o) => o.scriptpubkey_type === 'op_return'));
  if (amounts.length && amounts.every((a) => a < DUST)) return opReturn ? 'dust peels next to an OP_RETURN output' : 'dust peels (under ' + DUST + ' satoshis)';
  const count = {}; amounts.forEach((a) => { count[a] = (count[a] || 0) + 1; });
  const most = Math.max.apply(null, [0].concat(Object.keys(count).map((k) => count[k])));
  if (most >= 3 && most * 2 >= amounts.length) return 'the same amount peeled again and again';
  if (ts.length && new Set(ts.map((t) => t.status && t.status.block_height)).size === 1) return 'inside one block (other)';
  return 'spread over several blocks';
}

const year = (t) => (t.status && t.status.block_time ? new Date(t.status.block_time * 1000).getUTCFullYear() : 'unknown');
const kindOf = (rec, kind) => !!(rec && rec.flags.some((f) => f.kind === kind));

/** Everything counted over a list of transactions. */
function measure(txs) {
  const g = graphOf(txs), an = AN.analyse(g, {});
  const r = { transactions: 0, shape: {}, flags: { coinjoin: 0, consolidation: 0, batch: 0 }, joinClasses: {}, joins: [], lookalikes: [], whirlpoolShaped: { all: 0, flagged: 0 }, peelSteps: 0, inChain: 0, chains: an.chains.length, chainClasses: {},
              change: { eligible: 0, guessed: 0, tiers: { high: 0, medium: 0, low: 0 }, oneSign: 0, signals: {} }, byYear: {} };
  const byId = new Map(txs.map((t) => [t.txid, t]));
  an.chains.forEach((ch) => { const k = chainClass(ch, byId), x = (r.chainClasses[k] = r.chainClasses[k] || { chains: 0, steps: 0 }); x.chains++; x.steps += ch.txids.length; });
  txs.forEach((t) => {
    const v = AN.txView(g, 'tx:' + t.txid);
    if (!v || v.coinbase || !v.complete) return;
    const rec = an.tx.get('tx:' + t.txid), y = (r.byYear[year(t)] = r.byYear[year(t)] || { transactions: 0, coinjoin: 0, consolidation: 0, batch: 0, eligible: 0, guessed: 0 });
    r.transactions++; y.transactions++;
    const ib = IN_BUCKETS.find((b) => b[1](v.inputs.length)), ob = OUT_BUCKETS.find((b) => b[1](t.vout.length));
    if (ib && ob) r.shape[ib[0] + '|' + ob[0]] = (r.shape[ib[0] + '|' + ob[0]] || 0) + 1;
    ['coinjoin', 'consolidation', 'batch'].forEach((k) => { if (kindOf(rec, k)) { r.flags[k]++; y[k]++; } });
    if (kindOf(rec, 'coinjoin')) { const c = joinClass(t); r.joinClasses[c] = (r.joinClasses[c] || 0) + 1; r.joins.push({ txid: t.txid, year: year(t), inputs: t.vin.length, outputs: t.vout.length, cls: c }); }
    const eq = equalOutputs(t), isJoin = kindOf(rec, 'coinjoin');
    if (t.vin.length === 5 && t.vout.length === 5 && eq.count === 5 && WHIRLPOOL_POOLS.indexOf(eq.value) >= 0) { r.whirlpoolShaped.all++; if (isJoin) r.whirlpoolShaped.flagged++; }
    if (!isJoin && eq.count >= LOOKALIKE.minEqual && eq.value >= LOOKALIKE.minSats && t.vin.length >= LOOKALIKE.minIn) r.lookalikes.push({ txid: t.txid, year: year(t), inputs: t.vin.length, outputs: t.vout.length, equal: eq.count, value: eq.value });
    if (AN.peelStep(v, {})) r.peelSteps++;
    if (rec && rec.chain) r.inChain++;
    if (AN.payOuts(v).length >= 2) {
      r.change.eligible++; y.eligible++;
      const c = rec && rec.change;
      if (c) {
        r.change.guessed++; y.guessed++; r.change.tiers[c.confidence]++;
        if (c.reasons.length === 1) r.change.oneSign++;
        c.reasons.forEach((x) => { const k = AN.signalOf(x); r.change.signals[k] = (r.change.signals[k] || 0) + 1; });
      }
    }
  });
  return r;
}

/** What the detector sees in a transaction's equal outputs, and the sizes around it, for a reader looking at one flagged or dropped transaction. */
function describe(t) {
  const e = equalOutputs(t), distinct = (list) => new Set(list).size;
  return { txid: t.txid, year: year(t), inputs: t.vin.length, inputAddresses: distinct(t.vin.map((v) => v.prevout && v.prevout.scriptpubkey_address)), outputs: t.vout.length,
           outputAddresses: distinct(t.vout.map((o) => o.scriptpubkey_address)), equalAmount: e.value, equalRecipients: e.count, shape: joinClass(t) };
}

/** The transactions one version of the analysis flags as `kind` and another does not: for judging a change to a rule on a sample it was not made on. */
function compareFlags(txs, before, after, kind) {
  const g = graphOf(txs), flagged = (AN2) => {
    const an = AN2.analyse(g, {}), s = new Set();
    txs.forEach((t) => { const r = an.tx.get('tx:' + t.txid); if (r && (kind === 'peel' ? !!r.chain : r.flags.some((f) => f.kind === kind))) s.add(t.txid); });         // 'peel': in a detected chain
    return s;
  };
  const a = flagged(before), b = flagged(after);
  return { transactions: txs.length, before: a.size, after: b.size, dropped: Array.from(a).filter((x) => !b.has(x)), added: Array.from(b).filter((x) => !a.has(x)), kept: Array.from(b).filter((x) => a.has(x)) };
}

/** The rates of a measure() as plain shares, so that a ceiling in floors.json can be set on any of them. */
function rates(r) {
  const share = (k, n) => (n ? k / n : 0);
  return { coinjoin: share(r.flags.coinjoin, r.transactions), consolidation: share(r.flags.consolidation, r.transactions), batch: share(r.flags.batch, r.transactions),
           peelInChain: share(r.inChain, r.transactions), changeGuessed: share(r.change.guessed, r.change.eligible), changeHigh: share(r.change.tiers.high, r.change.eligible) };
}

const row = (cells) => '| ' + cells.join(' | ') + ' |';
const table = (head, rows) => [row(head), row(head.map(() => '---'))].concat(rows.map(row)).join('\n');
const per1000 = (k, n) => (n ? (1000 * k / n).toFixed(1) : 'n/a');
const date = (s) => new Date(s * 1000).toISOString().slice(0, 10);

/** The report: the sample, and then each rate next to the same count on the synthetic cases, so a reader sees how far the two are apart. */
function toMarkdown(sample, real, synthetic, meta) {
  const out = ['# Benchmark: rates on real traffic', '',
    'Written by `node test/benchmark/base-rates.js --write-docs`; the method is in [benchmark.md](benchmark.md) (tier D). Nobody knows who owns what in a sample of the chain, so these are **rates and shapes, not accuracy**: a flag that fires is not wrong for it, and one that does not fire is not right.', '',
    table(['', ''], [['Date', meta.date], ['Commit', meta.commit], ['`hopline-analysis.js` SHA-256', '`' + meta.analysisSha.slice(0, 16) + '`'], ['Sample', sample.name + ': ' + real.transactions + ' transactions (the coinbase of a block left out), ' + sample.meta.blocks.length + ' blocks'],
                       ['Chosen by', sample.meta.generator + ', seed ' + sample.meta.seed]]), '',
    '## The sample', '',
    'Random pages of 25 consecutive transactions from blocks spread over the years. Neighbours in a block are often related, so the sample is clustered and the intervals below are a little too narrow. A rate pools the transactions as sampled, not as the blocks were full, so it is the rate over this sample, and the early blocks (small) weigh more than their share of the chain.', '',
    table(['Block', 'Date', 'Transactions in the block', 'Taken'], sample.meta.blocks.map((b) => [String(b.height), date(b.time), String(b.tx_count), String(b.transactions)])), '',
    '## What the transactions look like', '', 'Share of the sample by the number of inputs (down) and outputs (across). The synthetic cases, which were made to exercise the flags, are shown beside it.', ''];
  const shapeRows = IN_BUCKETS.map((ib) => [ib[0] + ' in'].concat(OUT_BUCKETS.map((ob) => {
    const k = ib[0] + '|' + ob[0];
    return ((real.shape[k] || 0) / real.transactions * 100).toFixed(1) + '% (synthetic ' + ((synthetic.shape[k] || 0) / synthetic.transactions * 100).toFixed(1) + '%)';
  })));
  out.push(table([''].concat(OUT_BUCKETS.map((b) => b[0] + ' out')), shapeRows), '');
  out.push('## How often each flag fires', '',
    table(['Flag', 'Real traffic', 'Per 1,000 transactions', 'The synthetic cases'],
      [['COINJOIN?', 'coinjoin'], ['CONSOL', 'consolidation'], ['BATCH', 'batch']].map(([name, k]) => [name, prop(wilson(real.flags[k], real.transactions)), per1000(real.flags[k], real.transactions), prop(wilson(synthetic.flags[k], synthetic.transactions))])
        .concat([['A single peel step (one input, two outputs, the small one at most half the large one)', prop(wilson(real.peelSteps, real.transactions)), per1000(real.peelSteps, real.transactions), prop(wilson(synthetic.peelSteps, synthetic.transactions))],
                 ['In a detected peel chain (needs the next transaction in the sample, so this is a floor)', prop(wilson(real.inChain, real.transactions)), per1000(real.inChain, real.transactions), prop(wilson(synthetic.inChain, synthetic.transactions))]])), '',
    'The synthetic column is the six synthetic cases together (' + synthetic.transactions + ' transactions); their mix was chosen to exercise the flags, so it says how far from ordinary traffic they are and nothing else.', '');
  // by year
  const years = Object.keys(real.byYear).sort();
  out.push('### By year', '', table(['Year', 'Transactions', 'COINJOIN?', 'CONSOL', 'BATCH', 'Change guessed, of those with two or more outputs'],
    years.map((y) => { const x = real.byYear[y]; return [y, String(x.transactions), prop(wilson(x.coinjoin, x.transactions)), prop(wilson(x.consolidation, x.transactions)), prop(wilson(x.batch, x.transactions)), prop(wilson(x.guessed, x.eligible))]; })), '');
  // change
  const c = real.change, s = synthetic.change;
  out.push('## The change guess on real transactions', '',
    'On transactions with two or more payment outputs (the ones that can have a change output). Whether a guess is right cannot be known here; only how often one is made, and on what.', '',
    table(['', 'Real traffic', 'The synthetic cases'], [
      ['Transactions with two or more outputs', String(c.eligible), String(s.eligible)],
      ['A guess was made', prop(wilson(c.guessed, c.eligible)), prop(wilson(s.guessed, s.eligible))],
      ['High', prop(wilson(c.tiers.high, c.eligible)), prop(wilson(s.tiers.high, s.eligible))],
      ['Medium', prop(wilson(c.tiers.medium, c.eligible)), prop(wilson(s.tiers.medium, s.eligible))],
      ['Low', prop(wilson(c.tiers.low, c.eligible)), prop(wilson(s.tiers.low, s.eligible))],
      ['Of the guesses, resting on one sign only', prop(wilson(c.oneSign, c.guessed)), prop(wilson(s.oneSign, s.guessed))]]), '',
    '**Which signs the guesses rest on** (a guess can have several):', '',
    table(['Sign', 'Real traffic', 'The synthetic cases'], AN.CHANGE_SIGNALS.map(([k]) => [k, prop(wilson(c.signals[k] || 0, c.guessed)), prop(wilson(s.signals[k] || 0, s.guessed))])), '');
  // coinjoins by shape
  const classes = Object.keys(real.joinClasses).sort((a, b) => real.joinClasses[b] - real.joinClasses[a]);
  out.push('## What the COINJOIN? flags look like', '', real.flags.coinjoin ? 'The ' + real.flags.coinjoin + ' transactions flagged, by shape. The shape is read from the transaction alone (a Whirlpool pool has 5 inputs and 5 outputs of exactly 0.001, 0.01, 0.05 or 0.5 BTC); it is a way to look at them, not a verdict.' : 'None was flagged.', '',
    classes.length ? table(['Shape', 'Flagged'], classes.map((k) => [k, String(real.joinClasses[k])])) : '', '');
  if (real.joins.length) {
    out.push('The flagged transactions (to open in Hopline or any explorer):', '', table(['Transaction', 'Year', 'Inputs', 'Outputs', 'Shape'], real.joins.slice().sort((a, b) => String(a.year).localeCompare(String(b.year)) || a.txid.localeCompare(b.txid)).map((j) => ['`' + j.txid + '`', String(j.year), String(j.inputs), String(j.outputs), j.cls])), '');
  }
  const kinds = Object.keys(real.chainClasses).sort((a, b) => real.chainClasses[b].steps - real.chainClasses[a].steps), inChain = kinds.reduce((a, k) => a + real.chainClasses[k].steps, 0);
  out.push('## What the detected peel chains look like', '', kinds.length ? 'The ' + kinds.reduce((a, k) => a + real.chainClasses[k].chains, 0) + ' chains of ' + AN.DEFAULTS.peel.minLength + ' or more steps, by shape (the first that fits). Chains need linked transactions, so only neighbours inside the sample can form one. The shape is a way to look at them, not a verdict.' : 'No chain was detected.', '',
    kinds.length ? table(['Shape', 'Chains', 'Steps', 'Share of the transactions in a chain'], kinds.map((k) => [k, String(real.chainClasses[k].chains), String(real.chainClasses[k].steps), pct(real.chainClasses[k].steps / inChain)])) : '', '');
  out.push('**What the detector did not flag.** In the sample, ' + real.whirlpoolShaped.all + ' transaction' + (real.whirlpoolShaped.all === 1 ? ' has' : 's have') + ' the Whirlpool shape (' + real.whirlpoolShaped.flagged + ' flagged). So few CoinJoins are in a sample like this that it cannot say how many real ones the detector finds: that is measured on the synthetic cases, and on real CoinJoins only with a list of known ones.', '');
  if (real.lookalikes.length) {
    out.push('Transactions with at least ' + LOOKALIKE.minEqual + ' equal outputs of ' + LOOKALIKE.minSats + ' satoshis or more and at least ' + LOOKALIKE.minIn + ' inputs that were not flagged (' + real.lookalikes.length + '), to look at by hand. Some may be CoinJoins and some payouts of one amount; the benchmark does not know which.', '',
      table(['Transaction', 'Year', 'Inputs', 'Outputs', 'Equal outputs', 'Amount (satoshis)'], real.lookalikes.map((j) => ['`' + j.txid + '`', String(j.year), String(j.inputs), String(j.outputs), String(j.equal), String(j.value)])), '');
  }
  return out.join('\n') + '\n';
}

module.exports = { loadSample, graphOf, measure, rates, joinClass, chainClass, equalOutputs, describe, compareFlags, toMarkdown, WHIRLPOOL_POOLS, DUST };
