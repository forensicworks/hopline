#!/usr/bin/env node
'use strict';
/**
 * Rates on real traffic: every flag on a sample of the real chain, next to the same counts on the synthetic cases.
 *
 *   node test/benchmark/base-rates.js [--sample <folder>] [--write-docs] [--date YYYY-MM-DD]
 *
 * Nothing here touches the network. Make a sample with tools/bench/fetch_mainnet_sample.py. The method is in docs/benchmark.md (tier D).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { listCases, loadCase, sha256 } = require('./lib/cases.js');
const { loadSample, measure, toMarkdown } = require('./lib/base-rates.js');

const ROOT = path.join(__dirname, '..', '..'), DEFAULT_SAMPLE = path.join(__dirname, 'cases', 'mainnet-sample'), SYNTHETIC = path.join(__dirname, 'cases', 'regtest-v1');

function args(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-docs') f.writeDocs = true;
    else if (['--sample', '--date'].indexOf(argv[i]) >= 0) f[argv[i].slice(2)] = argv[++i];
    else { process.stderr.write('Unknown option ' + argv[i] + '\n'); process.exit(2); }
  }
  return f;
}

function commit() {
  const git = (a) => cp.execSync('git ' + a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try { return git('rev-parse --short HEAD') + (git('status --porcelain -- public/js') ? ' plus uncommitted changes in public/js' : ''); } catch (e) { return 'unknown'; }
}

function run(flags) {
  const dir = flags.sample || DEFAULT_SAMPLE;
  if (!fs.existsSync(path.join(dir, 'case.json'))) { process.stderr.write('No sample in ' + dir + '. Make one with tools/bench/fetch_mainnet_sample.py.\n'); process.exit(2); }
  const sample = loadSample(dir), real = measure(sample.txs);
  const synthetic = measure([].concat.apply([], listCases(SYNTHETIC).map((d) => loadCase(d).txs)));
  const meta = { date: flags.date || new Date().toISOString().slice(0, 10), commit: commit(), analysisSha: sha256(fs.readFileSync(path.join(ROOT, 'public', 'js', 'hopline-analysis.js'))) };
  return { sample, real, synthetic, markdown: toMarkdown(sample, real, synthetic, meta) };
}

if (require.main === module) {
  const flags = args(process.argv.slice(2)), out = run(flags);
  process.stdout.write(out.markdown);
  if (flags.writeDocs) { fs.writeFileSync(path.join(ROOT, 'docs', 'benchmark-base-rates.md'), out.markdown); process.stderr.write('Wrote docs/benchmark-base-rates.md\n'); }
}

module.exports = { run };
