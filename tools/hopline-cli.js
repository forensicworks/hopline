#!/usr/bin/env node
/*
 * Hopline on the command line: the analysis of a saved workspace as JSON, with no browser and no network.
 *
 *   node tools/hopline-cli.js summary    workspace.json                    the evidence summary
 *   node tools/hopline-cli.js detections workspace.json [--kind peel] [--chain P-65a1]
 *   node tools/hopline-cli.js chains     workspace.json                    every possible peel chain, with its steps and payments
 *   node tools/hopline-cli.js focus      workspace.json <ref>              the facts about one transaction, wallet, peel chain (P-65a1) or cluster (C3)
 *   node tools/hopline-cli.js prompt     workspace.json --task triage|narrative|explain|challenge [--focus <ref>] [--max-rows 60] [--json]
 *   node tools/hopline-cli.js check      workspace.json answer.txt         which ids an answer cites that are not in the evidence (exit code 1 if any)
 *
 * workspace.json is a file made by Export > JSON in the workspace (use - to read it from standard input; for check, answer.txt can be - too).
 * Options: --known <file> (the wallet list to use; default is public/data/known-addresses.js), --no-known, --generated <ISO time>, --compact.
 * It reads files and prints; it never opens a connection. Exit codes: 0 done, 1 check found ids that are not in the evidence, 2 could not run.
 * The shape of the JSON is described in docs/interface.md.
 */
'use strict';
var fs = require('fs'), path = require('path');
var JS = path.join(__dirname, '..', 'public', 'js');
var IO = require(path.join(JS, 'hopline-io.js')), AN = require(path.join(JS, 'hopline-analysis.js')), DT = require(path.join(JS, 'hopline-detections.js')), AS = require(path.join(JS, 'hopline-assist.js'));

function fail(msg, code) { process.stderr.write('hopline: ' + msg + '\n'); process.exit(code || 2); }

function usage() {
  return [
    'Hopline on the command line (no browser, no network).',
    '',
    '  summary    <workspace.json>                       the evidence summary',
    '  detections <workspace.json> [--kind K] [--chain L]  every pattern found, oldest first (K: peel, consolidation, batch, coinjoin)',
    '  chains     <workspace.json>                       every possible peel chain with its steps and payments',
    '  focus      <workspace.json> <ref>                 one transaction id, address, peel chain name (P-65a1) or cluster name (C3)',
    '  prompt     <workspace.json> --task T [--focus ref] [--max-rows N] [--json]',
    '                                                     the text to give an assistant (T: triage, narrative, explain, challenge)',
    '  check      <workspace.json> <answer.txt>          the ids an answer cites, and which are not in the evidence (exit code 1 if any)',
    '',
    'A file name of - reads standard input. Options: --known <file>, --no-known, --generated <ISO time>, --compact.',
    'The workspace file is Export > JSON from the workspace. The JSON shapes are in docs/interface.md.'
  ].join('\n');
}

function parseArgs(argv) {
  var out = { _: [], flags: {} }, valued = { '--kind': 1, '--chain': 1, '--task': 1, '--focus': 1, '--max-rows': 1, '--known': 1, '--generated': 1 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '-' || a.slice(0, 2) !== '--') { out._.push(a); continue; }
    if (valued[a]) { if (i + 1 >= argv.length) fail('Option ' + a + ' needs a value.'); out.flags[a.slice(2)] = argv[++i]; }
    else if (a === '--no-known' || a === '--compact' || a === '--json' || a === '--help') out.flags[a.slice(2)] = true;
    else fail('Unknown option ' + a + '. Try: node tools/hopline-cli.js help');
  }
  return out;
}

function readText(file, what) {
  try { return file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'); }
  catch (e) { fail('Could not read ' + what + ' "' + file + '": ' + (e && e.code === 'ENOENT' ? 'no such file.' : e.message)); }
}

/** The built-in wallet list is a data file ("window.HOPLINE_KNOWN = { ... };"); it is read as JSON, never run. */
function loadKnown(file) {
  var text = readText(file, 'wallet list'), at = text.indexOf('HOPLINE_KNOWN'), from = text.indexOf('{', at), to = text.lastIndexOf('}');
  if (at < 0 || from < 0 || to < from) fail('The wallet list "' + file + '" is not in the expected form (window.HOPLINE_KNOWN = { ... }).');
  try { return JSON.parse(text.slice(from, to + 1)); } catch (e) { fail('The wallet list "' + file + '" is not valid JSON inside: ' + e.message); }
}

function load(args) {
  var file = args._[1];
  if (!file) fail('Name the workspace file (or - for standard input).');
  var loaded;
  try { loaded = IO.fromJson(readText(file, 'workspace file')); } catch (e) { fail(e.message); }
  loaded.warnings.forEach(function (w) { process.stderr.write('hopline: warning: ' + w + '\n'); });
  var known = null;
  if (!args.flags['no-known']) {
    var kf = args.flags.known || path.join(__dirname, '..', 'public', 'data', 'known-addresses.js');
    if (args.flags.known || fs.existsSync(kf)) known = loadKnown(kf);
  }
  var knownFn = known ? function (a) { return Object.prototype.hasOwnProperty.call(known, a) ? known[a] : null; } : null;
  var an = AN.analyse(loaded.graph, { known: function (a) { var n = loaded.graph.nodes.get('addr:' + a); return !!(n && (n.label || n.tag)) || !!(knownFn && knownFn(a)); } });
  return { graph: loaded.graph, an: an, known: knownFn };
}

function print(args, value) {
  process.stdout.write(JSON.stringify(value, null, args.flags.compact ? 0 : 2) + '\n');
}

function summaryOf(args, ctx) {
  var generated = args.flags.generated || new Date().toISOString();
  return AS.summary(ctx.graph, ctx.an, { generated: generated, known: ctx.known });
}

function main(argv) {
  var args = parseArgs(argv), cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) { process.stdout.write(usage() + '\n'); return 0; }
  var ctx;
  if (cmd === 'summary') { ctx = load(args); print(args, summaryOf(args, ctx)); return 0; }
  if (cmd === 'detections') {
    if (args.flags.kind && DT.KINDS.indexOf(args.flags.kind) < 0) fail('--kind is one of ' + DT.KINDS.join(', ') + '.');
    ctx = load(args);
    print(args, DT.pick(summaryOf(args, ctx).detections, { kind: args.flags.kind, chain: args.flags.chain })); return 0;
  }
  if (cmd === 'chains') { ctx = load(args); print(args, summaryOf(args, ctx).chains); return 0; }
  if (cmd === 'focus') {
    ctx = load(args);
    if (!args._[2]) fail('Name what to look at: a transaction id, an address, a peel chain (P-65a1) or a cluster (C3).');
    var f = AS.focus(ctx.graph, ctx.an, args._[2], { known: ctx.known });
    if (!f) fail('"' + args._[2] + '" is not in the workspace.');
    print(args, f); return 0;
  }
  if (cmd === 'prompt') {
    ctx = load(args);
    var task = args.flags.task; if (!task) fail('Say what the assistant should do: --task triage, narrative, explain or challenge.');
    var focus = null;
    if (args.flags.focus) { focus = AS.focus(ctx.graph, ctx.an, args.flags.focus, { known: ctx.known }); if (!focus) fail('"' + args.flags.focus + '" is not in the workspace.'); }
    var rowsMax = args.flags['max-rows'] == null ? 60 : parseInt(args.flags['max-rows'], 10);
    if (!(rowsMax >= 1 && rowsMax <= 1000)) fail('--max-rows is a number from 1 to 1000.');
    var p;
    try { p = AS.prompt(summaryOf(args, ctx), task, { maxRows: rowsMax, focus: focus }); } catch (e) { fail(e.message); }
    if (args.flags.json) print(args, { task: p.task, system: p.system, user: p.user, tokens: p.tokens, shown: p.shown });
    else process.stdout.write(p.text + '\n');
    return 0;
  }
  if (cmd === 'check') {
    ctx = load(args);
    if (!args._[2]) fail('Name the file with the assistant\'s answer (or - for standard input).');
    if (args._[1] === '-' && args._[2] === '-') fail('Only one of the two can be read from standard input.');
    var answer = readText(args._[2], 'answer'), sum = summaryOf(args, ctx);
    var focusFacts = args.flags.focus ? AS.focus(ctx.graph, ctx.an, args.flags.focus, { known: ctx.known }) : null;
    var res = AS.checkCitations(answer, AS.idSets(sum, ctx.graph, focusFacts));
    print(args, res);
    return res.ok ? 0 : 1;
  }
  fail('Unknown command "' + cmd + '". Try: node tools/hopline-cli.js help');
}

process.exitCode = main(process.argv.slice(2));
