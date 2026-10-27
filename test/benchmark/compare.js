#!/usr/bin/env node
'use strict';
/**
 * A change to a rule, judged on a sample it was not made on: which transactions the analysis of an earlier commit flagged and today's does not.
 *
 *   node test/benchmark/compare.js --rev <git revision> --sample <folder> [--kind coinjoin|consolidation|batch|peel]
 *
 * The earlier analysis is read from git (public/js/hopline-analysis.js and the model beside it, into a temporary folder). Nothing touches the
 * network; the sample is one made by tools/bench/fetch_mainnet_sample.py. The method is in docs/benchmark.md (phase 4): a sample used to make
 * a change is not the one it is reported on, so make a new one with another seed, leave it alone until the change is done, and run this once.
 */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { loadSample, compareFlags, describe } = require('./lib/base-rates.js');
const NOW = require('../../public/js/hopline-analysis.js');

const ROOT = path.join(__dirname, '..', '..');

function args(argv) {
  const f = { kind: 'coinjoin' };
  for (let i = 0; i < argv.length; i++) {
    if (['--rev', '--sample', '--kind'].indexOf(argv[i]) >= 0) f[argv[i].slice(2)] = argv[++i];
    else { process.stderr.write('Unknown option ' + argv[i] + '\n'); process.exit(2); }
  }
  return f;
}

/** The analysis as it was at a revision: its file and the model it needs, from git, in a folder of their own. */
function analysisAt(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-analysis-'));
  ['hopline-model.js', 'hopline-analysis.js'].forEach((f) => {
    fs.writeFileSync(path.join(dir, f), cp.execFileSync('git', ['show', rev + ':public/js/' + f], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 }));
  });
  return { dir, analysis: require(path.join(dir, 'hopline-analysis.js')) };
}

const USAGE = 'Usage: node test/benchmark/compare.js --rev <git revision> --sample <folder> [--kind coinjoin|consolidation|batch|peel]\n';

function main() {
  if (process.argv.length <= 2) { process.stdout.write(USAGE); return; }                // asked for nothing: say how, and do not fail (node --test runs every file under test/)
  const f = args(process.argv.slice(2));
  if (!f.rev || !f.sample) { process.stderr.write(USAGE); process.exit(2); }
  const before = analysisAt(f.rev), sample = loadSample(f.sample), byId = new Map(sample.txs.map((t) => [t.txid, t]));
  try {
    const r = compareFlags(sample.txs, before.analysis, NOW, f.kind), line = (id) => JSON.stringify(describe(byId.get(id)));
    process.stdout.write('Sample ' + sample.name + ': ' + r.transactions + ' transactions. Flagged as ' + f.kind + ' at ' + f.rev + ': ' + r.before + ', now: ' + r.after + '.\n');
    process.stdout.write('\nDropped (flagged then, not now): ' + r.dropped.length + '\n' + r.dropped.map((id) => '  ' + line(id)).join('\n') + '\n');
    process.stdout.write('\nAdded (flagged now, not then): ' + r.added.length + '\n' + r.added.map((id) => '  ' + line(id)).join('\n') + '\n');
    process.stdout.write('\nKept: ' + r.kept.length + '\n' + r.kept.map((id) => '  ' + line(id)).join('\n') + '\n');
  } finally { fs.rmSync(before.dir, { recursive: true, force: true }); }
}

if (require.main === module) main();
