#!/usr/bin/env node
'use strict';
/**
 * Documented cases: follow the money from where a public document says it was, with each rule of auto-expand, and see whether the trace
 * reaches where the document says it ended up.
 *
 *   node test/benchmark/trace.js [--cases <folder>] [--write-docs]          measure the recorded cases (no network)
 *   node test/benchmark/trace.js --record [--case <name>]                   ask the public API again and keep the answers (about 400 requests a case)
 *
 * The method is in docs/benchmark.md (tier C).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const T = require('./lib/trace.js');
const { sha256 } = require('./lib/cases.js');

const ROOT = path.join(__dirname, '..', '..'), DEFAULT_CASES = path.join(__dirname, 'cases', 'public-v1');

function args(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-docs' || argv[i] === '--record') f[argv[i].slice(2).replace(/-(.)/g, (m, c) => c.toUpperCase())] = true;
    else if (['--cases', '--case', '--date'].indexOf(argv[i]) >= 0) f[argv[i].slice(2)] = argv[++i];
    else { process.stderr.write('Unknown option ' + argv[i] + '\n'); process.exit(2); }
  }
  return f;
}

function commit() {
  const git = (a) => cp.execSync('git ' + a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try { return git('rev-parse --short HEAD') + (git('status --porcelain -- public/js') ? ' plus uncommitted changes in public/js' : ''); } catch (e) { return 'unknown'; }
}

const short = (id) => id.slice(0, 12);
const row = (cells) => '| ' + cells.join(' | ') + ' |';
const table = (head, rows) => [row(head), row(head.map(() => '---'))].concat(rows.map(row)).join('\n');
const RULE_NAMES = { all: 'every output (largest first, up to 6)', largest: 'the largest output only', change: 'the likely change output', peel: 'a peel chain' };

/** Where the branches of a walk ended, in the workspace's words, and the limit that stopped it if one did. */
function endedAt(x) {
  const bits = Object.keys(x.endings).filter((k) => x.endings[k]).map((k) => x.endings[k] + ' × ' + k);
  if (x.ended === 'cap-tx') bits.push('the limit of transactions');
  else if (x.ended === 'cap-requests') bits.push('the limit of requests');
  else if (x.hopsRun >= x.hopsLimit) bits.push('the limit of hops');
  return bits.join('; ') || 'nothing further to follow';
}

function toMarkdown(results, meta) {
  const out = ['# Benchmark: documented cases', '',
    'Written by `node test/benchmark/trace.js --write-docs`; the method is in [benchmark.md](benchmark.md) (tier C). A case starts where a public document says the money was and asks whether Hopline\'s auto-expand, run with each of its rules, reaches where the document says it ended up. **A case is a case study, not a rate**: one case says what each rule did there and nothing about how often.', '',
    table(['', ''], [['Date', meta.date], ['Commit', meta.commit], ['`hopline-analysis.js` SHA-256', '`' + meta.analysisSha.slice(0, 16) + '`'], ['Cases', results.map((r) => r.meta.name).join(', ')]]), ''];
  results.forEach((r) => {
    const m = r.meta;
    out.push('## ' + m.title, '', m.summary + '.', '', '**What the documents say, and what was read:**', '');
    m.documented.forEach((d) => out.push('* ' + d.claim + ' Source: ' + d.source + '. Read: ' + d.read + '.'));
    out.push('', '**Start:** `' + m.start.txid + '`. ' + m.start.why, '', '**End:** `' + m.endpoint.address + '`. ' + m.endpoint.why, '', '**The route** (' + m.route.length + ' transactions, verified on the chain): ' + m.route.map((t) => '`' + short(t) + '`').join(' then ') + '. ' + m.route_note, '',
      'The walk goes forward from the start, ' + (m.limits && m.limits.hops || T.DEFAULTS.hops) + ' hops at most, ' + (m.limits && m.limits.maxTx || T.DEFAULTS.maxTx) + ' transactions and ' + (m.limits && m.limits.maxReq || T.DEFAULTS.maxReq) + ' requests at most, and stops at a CoinJoin-like transaction, as the workspace does with its default settings.', '',
      table(['Rule', 'Reached the end', 'Hops to it', 'Requests to get there', 'Wrong branches loaded on the way', 'Loaded after the end', 'The whole run: requests', 'The whole run: transactions', 'Where the branches ended'],
        r.runs.map((x) => [RULE_NAMES[x.rule], x.reached ? 'yes' : 'no', x.hops == null ? 'n/a' : String(x.hops), x.requestsToEnd == null ? 'n/a' : String(x.requestsToEnd), String(x.wrongBranches), String(x.afterTheEnd),
          String(x.requests), String(x.loaded) + ' (' + x.onRoute + ' of the ' + x.routeLength + ' on the route)', endedAt(x)])), '',
      'Reading the rows:', '', Object.keys(m.rule_notes || {}).map((k) => '* **' + RULE_NAMES[k] + '.** ' + m.rule_notes[k]).join('\n'), '',
      'A wrong branch is a transaction the walk loaded that is not on the route, on the way to the end (a level at or before the one that reached it; when the end is not reached, everything it loaded off the route). The walk does not know when it has arrived, so what it loads after the end is counted apart. "Requests to get there" is a second walk with the hops set to the level the end was reached at.', '');
  });
  return out.join('\n') + '\n';
}

async function main() {
  const flags = args(process.argv.slice(2)), root = flags.cases || DEFAULT_CASES;
  const folders = T.listFolders(root).filter((d) => !flags.case || path.basename(d) === flags.case);
  if (!folders.length) { process.stderr.write('No cases in ' + root + '\n'); process.exit(2); }
  if (flags.record) {
    for (const d of folders) {
      const c = T.loadCaseFolder(d);
      process.stderr.write('recording ' + c.name + ' from ' + c.meta.api + ' ...\n');
      const { rec, runs } = await T.record(c.meta, fetch, { concurrency: 2, delayMs: 700, retries: 3 });
      T.writeRecording(d, rec);
      runs.forEach((r) => process.stderr.write('  ' + r.rule + ': reached ' + r.reached + ', ' + r.requests + ' requests, ' + r.loaded + ' loaded\n'));
    }
    return;
  }
  const results = [];
  for (const d of folders) {
    const c = T.loadCaseFolder(d);
    if (!c.responses) { process.stderr.write(c.name + ' has no recording: run with --record\n'); process.exit(2); }
    const runs = [];
    for (const rule of T.RULES) runs.push(await T.trace(c.meta, rule, T.replayFetch(c.responses, c.meta.api)));
    results.push({ meta: c.meta, runs });
  }
  const meta = { date: flags.date || new Date().toISOString().slice(0, 10), commit: commit(), analysisSha: sha256(fs.readFileSync(path.join(ROOT, 'public', 'js', 'hopline-analysis.js'))) };
  const md = toMarkdown(results, meta);
  process.stdout.write(md);
  if (flags.writeDocs) { fs.writeFileSync(path.join(ROOT, 'docs', 'benchmark-cases.md'), md); process.stderr.write('Wrote docs/benchmark-cases.md\n'); }
}

if (require.main === module) main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });

module.exports = { toMarkdown };
