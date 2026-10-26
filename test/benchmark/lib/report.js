'use strict';
/** The results of a run as markdown: what was measured, on which cases, with which version of the analysis, and the wrong answers. */
const { wilson, pct, prop } = require('./stats.js');

/** Add up proportions made by wilson(): the pooled proportion over several cases. */
function pool(list) {
  const ok = list.filter(Boolean);
  return wilson(ok.reduce((a, x) => a + x.k, 0), ok.reduce((a, x) => a + x.n, 0));
}

const row = (cells) => '| ' + cells.join(' | ') + ' |';
const table = (head, rows) => [row(head), row(head.map(() => '---'))].concat(rows.map(row)).join('\n');
const short = (id) => id.slice(0, 12);

function changeSection(results) {
  const withChange = results.filter((r) => r.change.withChange > 0);
  if (!withChange.length) return '';
  const sumN = (f) => withChange.reduce((a, r) => a + f(r.change), 0);
  const coverage = pool(withChange.map((r) => r.change.coverage)), precision = pool(withChange.map((r) => r.change.precision));
  const out = ['## The change guess', '',
    'Over ' + sumN((c) => c.withChange) + ' transactions whose change is known (' + withChange.map((r) => r.name).join(', ') + '), and ' + sumN((c) => c.noChange) + ' that have none.', '',
    table(['', 'Share of the transactions', 'Right when it guesses'], [
      ['**Any guess**', prop(coverage), prop(precision)]].concat(['high', 'medium', 'low'].map((k) => ['**' + k + '**', prop(pool(withChange.map((r) => r.change.byTier[k].guesses))), prop(pool(withChange.map((r) => r.change.byTier[k].precision)))]))), ''];
  const base = (k) => pool(withChange.map((r) => r.change.baselineAccuracy[k]));
  const rnd = withChange.reduce((a, r) => a + (r.change.baselineAccuracy.random || 0) * r.change.withChange, 0) / sumN((c) => c.withChange);
  out.push('What a guess has to beat (a rule that always answers, so its coverage is 100%): a random output is right ' + pct(rnd) + ' of the time, the largest ' + pct(base('largest').p) + ', the smallest ' + pct(base('smallest').p) +
           ', the first ' + pct(base('first').p) + ', the last ' + pct(base('last').p) + '.', '');
  const nc = withChange.reduce((a, r) => a + r.change.noChangeGuessed.n, 0), ncTotal = sumN((c) => c.noChange);
  out.push('On transactions that have no change a guess is always wrong: Hopline made one on ' + nc + ' of ' + ncTotal + ' (' + ['high', 'medium', 'low'].map((k) => k + ' ' + withChange.reduce((a, r) => a + r.change.noChangeGuessed.byTier[k], 0)).join(', ') + ').', '');
  // each signal switched off
  const varNames = Object.keys(withChange[0].variants || {}).filter((k) => /^without/.test(k));
  if (varNames.length) {
    out.push('### What each signal is worth', '', 'The same transactions with one signal switched off. A signal that matters lowers coverage or precision when it goes. A row that equals the first means these cases never gave that signal anything to do, which says nothing about whether it is useful on real data.', '');
    const full = (name) => [name, prop(coverage), prop(precision), prop(pool(withChange.map((r) => r.change.byTier.high.precision)))];
    const rows = [full('all signals')];
    varNames.forEach((v) => {
      const some = withChange.filter((r) => r.variants && r.variants[v]);
      rows.push([v, prop(pool(some.map((r) => r.variants[v].coverage))), prop(pool(some.map((r) => r.variants[v].precision))), prop(pool(some.map((r) => r.variants[v].high.precision)))]);
    });
    out.push(table(['', 'Share guessed', 'Right when guessed', 'Right when high'], rows), '');
  }
  // strata
  const dims = {};
  withChange.forEach((r) => Object.keys(r.change.strataTable).forEach((d) => r.change.strataTable[d].forEach((x) => { const e = ((dims[d] = dims[d] || {})[x.name] = dims[d][x.name] || { cov: [], pre: [], n: 0 }); e.cov.push(x.coverage); e.pre.push(x.precision); e.n += x.transactions; })));
  out.push('### By how the sender\'s wallet behaves', '');
  Object.keys(dims).forEach((d) => {
    out.push('**' + d + '**', '', table(['', 'Transactions', 'Share guessed', 'Right when guessed'], Object.keys(dims[d]).sort().map((name) => [name, String(dims[d][name].n), prop(pool(dims[d][name].cov)), prop(pool(dims[d][name].pre))])), '');
  });
  // wrong highs
  const wrong = [];
  withChange.forEach((r) => r.change.wrongHigh.forEach((w) => wrong.push(Object.assign({ case: r.name }, w))));
  const highs = pool(withChange.map((r) => r.change.byTier.high.precision));
  out.push('### The wrong "high" guesses', '', highs.n ? highs.n - highs.k + ' of ' + highs.n + ' high guesses were wrong' + (wrong.length ? '; the first ' + Math.min(wrong.length, 15) + ':' : '.') : 'There were no high guesses.', '');
  if (wrong.length) out.push(table(['Case', 'Transaction', 'Guessed output', 'Change was', 'Why it guessed'], wrong.slice(0, 15).map((w) => [w.case, '`' + short(w.txid) + '`', String(w.guessed), String(w.change), w.reasons.join('; ')])), '');
  return out.join('\n');
}

function flagSection(results, key, title, blurb) {
  const rs = results.filter((r) => r[key].counts.tp + r[key].counts.fn + r[key].counts.fp > 0);
  if (!rs.length) return '';
  const rows = rs.map((r) => [r.name, prop(r[key].recall), prop(r[key].precision), prop(r[key].falsePositiveRate), Object.keys(r[key].falsePositivesByKind).map((k) => k + ' ' + r[key].falsePositivesByKind[k]).join(', ') || 'none']);
  return ['## ' + title, '', blurb, '', table(['Case', 'Found of those that are one', 'Right when flagged', 'Flagged of those that are not', 'Flagged wrongly, by what it was'], rows), ''].join('\n');
}

function clusterSection(results) {
  const rows = results.filter((r) => r.clusters.clusters > 0).map((r) => {
    const x = r.clusters, v = (r.variants && r.variants['clusters without the CoinJoin exclusion'] || {}).clusters;
    return [r.name, String(x.clusters), prop(x.precision), prop(x.recallOfWhatCoSpendingCanFind), prop(x.recallOfAllPairs), String(x.clustersWithSeveralOwners), v ? prop(v.precision) : 'n/a'];
  });
  return ['## Clusters', '', 'Addresses spent together in one transaction are put in one cluster, unless the transaction looks like a CoinJoin. A pair is right when both addresses have the same owner.', '',
          table(['Case', 'Clusters', 'Pairs that share an owner', 'Of the pairs co-spending can find', 'Of all pairs of spent addresses', 'Clusters of several owners', 'Pairs right without the CoinJoin exclusion'], rows), '',
          '"Pairs that share an owner" is the precision of the rule; "of the pairs co-spending can find" is its recall against the best a co-spend rule could do on these transactions (it joins every transaction that had one sender and none that mixed owners), so a shortfall there is a CoinJoin flag that was wrong; "of all pairs of spent addresses" includes pairs no transaction ever linked, so it is low for a reason that is not the rule\'s fault.', ''].join('\n');
}

function peelSection(results) {
  const rs = results.filter((r) => r.peel.truthChains > 0 || r.peel.detected > 0);
  if (!rs.length) return '';
  return ['## Peel chains', '', 'A chain is found when the detected run covers at least 80% of the real one; a detected chain is real when 80% of it lies in one real chain, and "not made as a chain" when less than half does. The rule is a shape (one coin in, a small payment and the rest out, several times running), and ordinary wallets that pay out of one coin make the same shape, so a chain that was not made as one is the rule firing on ordinary behaviour, which is what this column counts.', '',
          table(['Case', 'Real chains', 'Found', 'Detected chains that are real', 'Detected, not made as a chain', 'Of those, per 1,000 other transactions', 'Steps of real chains flagged'],
                rs.map((r) => [r.name, String(r.peel.truthChains), prop(r.peel.recalled), prop(r.peel.real), String(r.peel.notThere), r.peel.notThereFlaggedPer1000Others == null ? 'n/a' : r.peel.notThereFlaggedPer1000Others.toFixed(1), prop(r.peel.stepsFlagged)])), '',
          '### The steps of the real chains, by the smaller output over the larger', '',
          'The scripted chains pay 1% to 60% of the coin at each step, evenly spread on a log scale, so no step is made to suit the rule. The rule calls a transaction a peel step when the smaller of its two outputs is at most half the larger, and a chain needs four such steps in a row; a step that pays more than a third of the coin is therefore never one, and breaks the chain. How many steps fall there is the generator\'s choice, so read the rows, not the total.', '',
          table(['Smaller over larger', 'Steps', 'Look like a peel step', 'Are in a detected chain'], rs[0].peel.byRatio.map((b, i) => {
            const at = (f) => pool(rs.map((r) => r.peel.byRatio[i][f]));
            return [b.name, String(rs.reduce((a, r) => a + r.peel.byRatio[i].steps, 0)), prop(at('looksLikeAPeelStep')), prop(at('inAChain'))];
          })), ''].join('\n');
}

function toMarkdown(results, meta) {
  const head = ['# Benchmark results', '',
    'Written by `node test/benchmark/run.js --write-docs`; the method is in [benchmark.md](benchmark.md). These are measurements of a version of the analysis on synthetic data: read the limits there before reading the numbers.', '',
    table(['', ''], [['Date', meta.date], ['Commit', meta.commit], ['`hopline-analysis.js` SHA-256', '`' + meta.analysisSha.slice(0, 16) + '`'], ['Node', meta.node], ['Cases', meta.cases.map((c) => c.name).join(', ')]]), '',
    '## The cases', '',
    table(['Case', 'Transactions', 'Wallets', 'Addresses', 'What the transactions were made to be', 'Made by'],
          results.map((r, i) => [r.name, String(r.transactions), String(r.wallets), String(r.addresses), Object.keys(r.kinds).sort().map((k) => k + ' ' + r.kinds[k]).join(', '), meta.cases[i].madeBy || ''])), ''];
  return head.concat([changeSection(results),
    flagSection(results, 'coinjoin', 'The CoinJoin detector', 'A transaction is flagged when at least 3 input addresses and at least 3 outputs of exactly the same value to different addresses are present (and the equal outputs are at least half the outputs, or at least 5).'),
    flagSection(results, 'consolidation', 'The consolidation flag', 'Flagged at 5 or more inputs going to 1 or 2 outputs. A sweep of deposit addresses counts as a consolidation here.'),
    flagSection(results, 'batch', 'The batch flag', 'Flagged at 6 or more outputs from 3 or fewer inputs.'),
    clusterSection(results), peelSection(results)].filter(Boolean)).join('\n') + '\n';
}

module.exports = { toMarkdown, pool };
