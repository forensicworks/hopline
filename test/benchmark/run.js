#!/usr/bin/env node
'use strict';
/**
 * The benchmark: every case in a folder, measured, printed, and with --write-docs written to docs/benchmark-results.md.
 *
 *   node test/benchmark/run.js [--cases <folder>] [--write-docs] [--json <file>] [--date YYYY-MM-DD]
 *
 * Nothing here touches the network. The method is in docs/benchmark.md.
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { listCases, loadCase, sha256 } = require('./lib/cases.js');
const { evaluateCase } = require('./lib/evaluate.js');
const { toMarkdown } = require('./lib/report.js');

const ROOT = path.join(__dirname, '..', '..'), DEFAULT_CASES = path.join(__dirname, 'cases', 'regtest-v1');

function args(argv) {
  const a = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-docs') a.flags.writeDocs = true;
    else if (['--cases', '--json', '--date'].indexOf(argv[i]) >= 0) a.flags[argv[i].slice(2)] = argv[++i];
    else { process.stderr.write('Unknown option ' + argv[i] + '\n'); process.exit(2); }
  }
  return a.flags;
}

/** The commit the analysis was measured at, and whether the working tree had changes to it that no commit holds. */
function commit() {
  const git = (args) => cp.execSync('git ' + args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try { return git('rev-parse --short HEAD') + (git('status --porcelain -- public/js') ? ' plus uncommitted changes in public/js' : ''); } catch (e) { return 'unknown'; }
}

function run(flags) {
  const dirs = listCases(flags.cases || DEFAULT_CASES);
  if (!dirs.length) { process.stderr.write('No cases in ' + (flags.cases || DEFAULT_CASES) + '. Make them with tools/bench/make_regtest.py.\n'); process.exit(2); }
  const cases = dirs.map(loadCase);
  const results = cases.map((c) => evaluateCase(c));
  const meta = { date: flags.date || new Date().toISOString().slice(0, 10), commit: commit(), node: process.version,
                 analysisSha: sha256(fs.readFileSync(path.join(ROOT, 'public', 'js', 'hopline-analysis.js'))),
                 cases: cases.map((c) => ({ name: c.name, madeBy: (c.meta.generator || '') + (c.meta.seed != null ? ', seed ' + c.meta.seed : ''), files: c.files })) };
  return { results, meta, markdown: toMarkdown(results, meta) };
}

if (require.main === module) {
  const flags = args(process.argv.slice(2)), out = run(flags);
  process.stdout.write(out.markdown);
  if (flags.json) fs.writeFileSync(flags.json, JSON.stringify({ meta: out.meta, results: out.results }, null, 1));
  if (flags.writeDocs) { fs.writeFileSync(path.join(ROOT, 'docs', 'benchmark-results.md'), out.markdown); process.stderr.write('Wrote docs/benchmark-results.md\n'); }
}

module.exports = { run };
