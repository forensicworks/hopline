#!/usr/bin/env node
/*
 * Hopline on the command line: the analysis of a saved workspace as JSON, with no browser and no network.
 *
 *   node tools/hopline-cli.js summary    workspace.json                    the evidence summary
 *   node tools/hopline-cli.js detections workspace.json [--kind peel] [--chain P-65a1]
 *   node tools/hopline-cli.js chains     workspace.json                    every possible peel chain, with its steps and payments
 *   node tools/hopline-cli.js focus      workspace.json <ref>              the facts about one transaction, wallet, peel chain (P-65a1) or cluster (C3)
 *   node tools/hopline-cli.js trace      workspace.json [--ref R]          how far the trail from the reference got: hand-offs and open ends
 *   node tools/hopline-cli.js handoffs   workspace.json [--ref R] [--csv]  where the trail meets a service wallet, as JSON or CSV
 *   node tools/hopline-cli.js route      workspace.json --from A --to B    the route the money took from one wallet or transaction to another (exit code 1 if none)
 *   node tools/hopline-cli.js prompt     workspace.json --task triage|narrative|explain|challenge [--focus <ref>] [--max-rows 60] [--json]
 *   node tools/hopline-cli.js check      workspace.json answer.txt         which ids an answer cites that are not in the evidence (exit code 1 if any)
 *
 * workspace.json is a file made by Export > JSON in the workspace (use - to read it from standard input; for check, answer.txt can be - too).
 * The reference (--ref, a wallet address or a transaction id) is the first starting point of the trace the file was saved from, or a wallet tagged THREAT.
 * Options: --known <file> (the wallet list to use; default is public/data/known-addresses.js), --packs <folder> (the packs the site ships that are on as shipped, the OFAC list;
 * default is public/packs), --with <id,id> (also use these shipped packs, e.g. ransomwhere), --no-packs, --no-known (no names from either), --generated <ISO time>, --compact.
 * It reads files and prints; it never opens a connection. Exit codes: 0 done, 1 check found ids that are not in the evidence, 2 could not run.
 * The shape of the JSON is described in docs/interface.md.
 */
'use strict';
var fs = require('fs'), path = require('path');
var JS = path.join(__dirname, '..', 'public', 'js');
var IO = require(path.join(JS, 'hopline-io.js')), AN = require(path.join(JS, 'hopline-analysis.js')), DT = require(path.join(JS, 'hopline-detections.js')), AS = require(path.join(JS, 'hopline-assist.js'));
var LB = require(path.join(JS, 'hopline-labels.js')), PK = require(path.join(JS, 'hopline-packs.js')), RT = require(path.join(JS, 'hopline-route.js'));

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
    '  trace      <workspace.json> [--ref R]             how far the trail from the reference got: service hand-offs and where it is still open',
    '  handoffs   <workspace.json> [--ref R] [--csv]     where the trail meets a service wallet or a wallet a sanctions or ransomware list names, as JSON or CSV',
    '  route      <workspace.json> --from A --to B       the route the money took from one wallet or transaction to another (exit code 1 if there is none)',
    '',
    'A file name of - reads standard input. Options: --known <file>, --packs <folder>, --with <id,id>, --no-packs, --no-known, --generated <ISO time>, --compact.',
    'For trace, handoffs and route a wallet is an address and a transaction a 64-character id; --ref defaults to the first starting point saved in the file.',
    'The workspace file is Export > JSON from the workspace. The JSON shapes are in docs/interface.md.'
  ].join('\n');
}

function parseArgs(argv) {
  var out = { _: [], flags: {} }, valued = { '--kind': 1, '--chain': 1, '--task': 1, '--focus': 1, '--max-rows': 1, '--known': 1, '--packs': 1, '--with': 1, '--generated': 1, '--ref': 1, '--from': 1, '--to': 1 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '-' || a.slice(0, 2) !== '--') { out._.push(a); continue; }
    if (valued[a]) { if (i + 1 >= argv.length) fail('Option ' + a + ' needs a value.'); out.flags[a.slice(2)] = argv[++i]; }
    else if (a === '--no-known' || a === '--no-packs' || a === '--compact' || a === '--json' || a === '--help' || a === '--csv') out.flags[a.slice(2)] = true;
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

/** The packs the site ships that are on as shipped (the OFAC list), and any named in `extra`: packs/index.js and each pack's file are data files, read as JSON and never run. [] when the folder has none. */
function loadPacks(dir, asked, extra) {
  var idx = path.join(dir, 'index.js');
  if (!fs.existsSync(idx)) { if (asked) fail('There is no pack list in "' + dir + '" (expected index.js).'); return []; }
  var text = readText(idx, 'pack list'), at = text.indexOf('HOPLINE_PACK_INDEX'), from = text.indexOf('[', at), to = text.lastIndexOf(']'), list;
  if (at < 0 || from < 0 || to < from) fail('The pack list "' + idx + '" is not in the expected form (window.HOPLINE_PACK_INDEX = [ ... ]).');
  try { list = PK.cleanIndex(JSON.parse(text.slice(from, to + 1))); } catch (e) { fail('The pack list "' + idx + '" is not valid JSON inside: ' + e.message); }
  extra.forEach(function (id) { if (!list.some(function (e) { return e.id === id; })) fail('No pack named "' + id + '" in "' + dir + '". Those there: ' + list.map(function (e) { return e.id; }).join(', ') + '.'); });
  return list.filter(function (e) { return e.defaultOn || extra.indexOf(e.id) >= 0; }).map(function (e) {
    var file = path.join(dir, e.file), t = readText(file, 'pack'), at2 = t.indexOf('"] = '), a = t.indexOf('{', at2), b = t.lastIndexOf('}'), r;
    if (at2 < 0 || a < 0 || b < a) fail('The pack "' + file + '" is not in the expected form.');
    try { r = LB.fromObject(JSON.parse(t.slice(a, b + 1)), e.name); } catch (err) { fail('The pack "' + file + '" cannot be read: ' + err.message); }
    return Object.assign({}, e, { enabled: true, loaded: true, entries: r.entries, sanctions: r.sanctions, asOf: r.asOf || e.asOf });
  });
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
    var packs = args.flags['no-packs'] ? [] : loadPacks(args.flags.packs || path.join(__dirname, '..', 'public', 'packs'), !!args.flags.packs, String(args.flags.with || '').split(',').filter(Boolean));
    if (packs.length) known = LB.buildKnown(known || {}, packs);
  }
  var knownFn = known ? function (a) { return Object.prototype.hasOwnProperty.call(known, a) ? known[a] : null; } : null;
  var an = AN.analyse(loaded.graph, { known: function (a) { var n = loaded.graph.nodes.get('addr:' + a); return !!(n && (n.label || n.tag)) || !!(knownFn && knownFn(a)); } });
  return { graph: loaded.graph, an: an, known: knownFn, view: loaded.view };
}

/** A wallet or a transaction named on the command line: an address, a 64-character id, or a vertex id (addr:... / tx:...). null when it is not in the workspace. */
function vertexOf(graph, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  var tries = [ref, 'addr:' + ref, 'tx:' + ref];
  for (var i = 0; i < tries.length; i++) if (graph.nodes.has(tries[i])) return tries[i];
  return null;
}
/** What route, hand-off and open-end commands need: the coin index, the reference and the rules for service wallets and names. */
function trailOf(args, ctx, needRef) {
  var idx = RT.index(ctx.graph), ref = null;
  if (args.flags.ref) { ref = vertexOf(ctx.graph, args.flags.ref); if (!ref) fail('"' + args.flags.ref + '" is not in the workspace.'); }
  else ref = RT.referenceOf(ctx.graph, ctx.view, []);
  if (!ref && needRef) fail('There is no reference: name one with --ref (a wallet address or a transaction id). A workspace saved from a trace has its starting point.');
  return { idx: idx, ref: ref, hub: function (id) { return RT.isHub(ctx.graph, ctx.known, id); }, name: function (id) { return RT.nameOf(ctx.graph, ctx.known, id); },
           listed: function (id) { return RT.listedName(ctx.graph, ctx.known, id); } };
}
function traceOf(args, ctx, needRef) {
  var t = trailOf(args, ctx, needRef);
  if (!t.ref) return null;
  var r = RT.trace(t.idx, t.ref, { hub: t.hub, name: t.name, listed: t.listed, stop: t.name });
  r.referenceName = t.name(t.ref) || '';
  return r;
}

function print(args, value) {
  process.stdout.write(JSON.stringify(value, null, args.flags.compact ? 0 : 2) + '\n');
}

function summaryOf(args, ctx) {
  var generated = args.flags.generated || new Date().toISOString();
  return AS.summary(ctx.graph, ctx.an, { generated: generated, known: ctx.known, trace: traceOf(args, ctx, false) });
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
  if (cmd === 'trace') { ctx = load(args); print(args, traceOf(args, ctx, true)); return 0; }
  if (cmd === 'handoffs') {
    ctx = load(args);
    var rows = traceOf(args, ctx, true).handoffs;
    if (args.flags.csv) process.stdout.write(IO.handoffsCsv(rows)); else print(args, rows);
    return 0;
  }
  if (cmd === 'route') {
    ctx = load(args);
    if (!args.flags.from || !args.flags.to) fail('Name both ends: --from <wallet or transaction> --to <wallet or transaction>.');
    var from = vertexOf(ctx.graph, args.flags.from), to = vertexOf(ctx.graph, args.flags.to), tr = trailOf(args, ctx, false);
    if (!from) fail('"' + args.flags.from + '" is not in the workspace.');
    if (!to) fail('"' + args.flags.to + '" is not in the workspace.');
    var route = RT.find(tr.idx, from, to, { hub: tr.hub });
    if (!route) { print(args, { route: null, from: from, to: to, message: 'No route in the loaded transactions: it only means none was found there, not that the money did not go that way.' }); return 1; }
    print(args, { route: { from: route.from, to: route.to, hops: route.hops, vertices: route.vertices, edges: route.edges, transactions: route.txs, firstTime: route.first, lastTime: route.last,
                           steps: route.steps.map(function (st) { return { txid: st.txid, time: st.time, inputs: st.nIn, outputs: st.nOut, coinSats: st.coinOut, mergesManyInputs: st.merges }; }),
                           acrossServiceWallets: route.viaHub, note: 'Each step is the transaction that spent the coin before it; it does not say who controls the wallets between.' } });
    return 0;
  }
  fail('Unknown command "' + cmd + '". Try: node tools/hopline-cli.js help');
}

process.exitCode = main(process.argv.slice(2));
