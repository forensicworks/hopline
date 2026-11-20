#!/usr/bin/env node
/**
 * Compare local models on the same questions about one workspace, and score what they answer by code.
 *
 *   node tools/compare-models.js workspace.json --models gpt-oss:20b,llama3.1:8b [--runs 3] [--questions questions.txt] [--expect expect.json] [--actions] [--out folder]
 *   node tools/compare-models.js --list [--endpoint http://127.0.0.1:11434/v1]
 *
 * What it does: for each question it makes the prompt exactly as the workspace does (it runs tools/hopline-cli.js prompt), asks each model on this computer in turn, `--runs` times each,
 * and scores every answer with the same checks the page uses: the ids it cites against the evidence (tools/hopline-cli.js check), the block of actions it proposes (hopline-cli.js actions,
 * with --actions) and, when you give an --expect file, the phrases an answer must or must not contain. Then it writes the answers, results.json and summary.md to a folder.
 *
 * Only a model on this computer is accepted (localhost, 127.0.0.1 or ::1), as in the workspace: nothing about a wallet is sent to another machine. It prints no id, only counts; the answers
 * (which may hold your real ids) are written to the --out folder, which by default sits next to the workspace file, so keep that folder out of any repository.
 * Needs Node.js 18 or newer. Exit codes: 0 done (some runs may have failed: they are counted), 2 it could not run.
 */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var AS = require(path.join(__dirname, '..', 'public', 'js', 'hopline-assist.js'));
var CLI = path.join(__dirname, 'hopline-cli.js');
var DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/v1';
var BUILT_IN = [                                                         // questions that name no id, so they fit any workspace
  { task: 'ask', question: 'Which findings should I look at first, and why?' },
  { task: 'ask', question: 'What would make the strongest finding wrong?' },
  { task: 'ask', question: 'Where do the open ends of the trace lead, and what is still missing?' }
];

function fail(msg, code) { process.stderr.write('compare-models: ' + msg + '\n'); process.exit(code || 2); }
function note(msg) { process.stderr.write(msg + '\n'); }

function usage() {
  return [
    'Compare local models on the same questions about one workspace, and score what they answer.',
    '',
    '  node tools/compare-models.js <workspace.json> --models a,b,c [options]',
    '  node tools/compare-models.js --list [--endpoint URL]            the models the server has',
    '',
    'Options:',
    '  --models a,b,c      the models to ask, in this order (names as the server lists them)',
    '  --runs N            ask each model each question N times (default 1; a 20B model varies between runs, so 3 or more says more)',
    '  --questions FILE    one question per line (a line "task:next" asks for the list of next steps); # starts a comment. Default: three questions that name no id',
    '  --expect FILE       JSON with phrases to look for: {"defaults":{"mustNotContain":["regex"]},"1":{"mustContain":["57\\\\.282"],"mustNotContain":[]}} (the keys are question numbers)',
    '  --actions           let the models propose actions (as the workspace setting does) and score the block they return; adds the next-steps question when there is no --questions file',
    '  --out FOLDER        where the answers, results.json and summary.md go (default: next to the workspace file)',
    '  --endpoint URL      the server (default ' + DEFAULT_ENDPOINT + '); only this computer is accepted',
    '  --max-rows N        pattern rows in the prompt (default 60, as in the workspace)',
    '  --timeout-min N     give up on one answer after N minutes (default 10)',
    '  --temperature X     the sampling temperature (default: the workspace\'s, 0.2)',
    '',
    'It prints counts only, never an id. The answers are written to --out: keep that folder out of any repository.'
  ].join('\n');
}

function parseArgs(argv) {
  var out = { _: [], flags: {} }, valued = { '--models': 1, '--endpoint': 1, '--questions': 1, '--expect': 1, '--runs': 1, '--out': 1, '--max-rows': 1, '--timeout-min': 1, '--temperature': 1 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a.slice(0, 2) !== '--') { out._.push(a); continue; }
    if (valued[a]) { if (i + 1 >= argv.length) fail('Option ' + a + ' needs a value.'); out.flags[a.slice(2)] = argv[++i]; }
    else if (a === '--actions' || a === '--list' || a === '--help') out.flags[a.slice(2)] = true;
    else fail('Unknown option ' + a + '. Try: node tools/compare-models.js --help');
  }
  return out;
}
function intFlag(args, name, def, min, max) {
  if (args.flags[name] == null) return def;
  var n = Number(args.flags[name]);
  if (!(Number.isInteger(n) && n >= min && n <= max)) fail('--' + name + ' is a whole number from ' + min + ' to ' + max + '.');
  return n;
}

/** What the CLI says (as JSON on its standard output) when given these arguments; `input` goes to its standard input. */
function cli(args, input) {
  var r = cp.spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', input: input, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}
function cliJson(args, input, what) {
  var r = cli(args, input), j;
  try { j = JSON.parse(r.stdout); } catch (e) { throw new Error(what + ' failed: ' + ((r.stderr || r.stdout || '').trim().slice(0, 200) || 'no output')); }
  return j;
}

function readQuestions(file, withActions) {
  if (!file) return BUILT_IN.concat(withActions ? [{ task: 'next' }] : []);
  var list = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line[0] === '#') return;
    if (/^task:\s*next$/i.test(line)) list.push({ task: 'next' }); else list.push({ task: 'ask', question: AS.cleanQuestion(line) });
  });
  if (!list.length) fail('No question in ' + file + '.');
  return list;
}
function readExpect(file) {
  if (!file) return {};
  var e;
  try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { fail('Could not read the expectations in ' + file + ': ' + err.message); }
  Object.keys(e).forEach(function (k) {
    ['mustContain', 'mustNotContain'].forEach(function (kind) {
      (e[k] && e[k][kind] || []).forEach(function (p) { try { new RegExp(p, 'i'); } catch (err) { fail('"' + p + '" in the expectations is not a regular expression.'); } });
    });
  });
  return e;
}
function expectationsFor(expect, n) {
  var d = expect.defaults || {}, e = expect[String(n)] || {};
  return { mustContain: (d.mustContain || []).concat(e.mustContain || []), mustNotContain: (d.mustNotContain || []).concat(e.mustNotContain || []) };
}
function judge(ex, text) {
  var out = [];
  ex.mustContain.forEach(function (p) { out.push({ kind: 'mustContain', pattern: p, ok: new RegExp(p, 'i').test(text) }); });
  ex.mustNotContain.forEach(function (p) { out.push({ kind: 'mustNotContain', pattern: p, ok: !new RegExp(p, 'i').test(text) }); });
  return out;
}

/** One question to one model. Resolves to { text, cut } or rejects with a message in words. */
function askModel(base, model, p, timeoutMs, temperature) {
  var req = AS.chatRequest({ base: base, model: model, system: p.system, user: p.user });
  if (temperature != null) { var b = JSON.parse(req.init.body); b.temperature = temperature; req.init.body = JSON.stringify(b); }
  var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
  req.init.signal = ctl.signal;
  return fetch(req.url, req.init).then(function (r) {
    return r.text().then(function (body) {
      if (!r.ok) throw new Error('the model server answered ' + r.status + ': ' + AS.plainText(body, 200));
      return { text: AS.parseChat(body), cut: AS.chatFinish(body).truncated };
    });
  }).catch(function (e) {
    if (e && e.name === 'AbortError') throw new Error('no answer within ' + Math.round(timeoutMs / 60000) + ' minutes');
    if (e && e.name === 'TypeError') throw new Error('could not reach the model server at ' + base + ' (is it running?)');
    throw e;
  }).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
}

/** The ids an answer cites, the block of actions, and the phrases, scored with the CLI's own checks. */
function scoreAnswer(ws, text, withActions, ex) {
  var shown = text.replace(/<think>[\s\S]*?<\/think>/gi, '');                       // a model that writes its thinking in tags: only what follows counts
  var c = cliJson(['check', ws, '-'], shown, 'the id check'), s = { ids: {}, actions: null, expectations: judge(ex, shown) };
  var unknown = c.unknown.txids.length + c.unknown.addresses.length;
  s.ids = { cited: c.cited.txids.length + c.cited.addresses.length, unknown: unknown, copySlips: (c.near || []).length, badShortened: (c.abbreviated || []).filter(function (x) { return !x.id; }).length, uncitedAmounts: (c.uncited || []).length };
  if (withActions) {
    var a = cliJson(['actions', ws, '-'], shown, 'the actions check'), kinds = {};
    a.actions.forEach(function (x) { kinds[x.action] = (kinds[x.action] || 0) + 1; });
    s.actions = { found: !!a.found, error: a.error || null, accepted: a.actions.length, dropped: a.dropped.length, kinds: kinds, reasons: a.dropped.slice(0, 3).map(function (d) { return d.reason; }) };
  }
  return s;
}

function safeName(model) { return model.replace(/[^\w.\-]/g, '_'); }
function mean(xs) { return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : 0; }
function r1(x) { return Math.round(x * 10) / 10; }

/** The totals per model: how often it cited an id that is not there, how often its answer was cut off, how its actions fared, how many phrases held. */
function summarise(runs, models, withActions) {
  return models.map(function (m) {
    var rs = runs.filter(function (r) { return r.model === m; }), ok = rs.filter(function (r) { return !r.error; }), t = { model: m, runs: rs.length, failed: rs.length - ok.length };
    t.cutOff = ok.filter(function (r) { return r.cut; }).length;
    t.meanSeconds = r1(mean(ok.map(function (r) { return r.seconds; })));
    t.runsWithAnInventedId = ok.filter(function (r) { return r.score.ids.unknown > 0; }).length;
    t.inventedIds = ok.reduce(function (a, r) { return a + r.score.ids.unknown; }, 0);
    t.copySlips = ok.reduce(function (a, r) { return a + r.score.ids.copySlips; }, 0);
    t.runsCitingNothing = ok.filter(function (r) { return r.score.ids.cited === 0; }).length;
    var ex = [].concat.apply([], ok.map(function (r) { return r.score.expectations; }));
    t.phrases = ex.length ? { held: ex.filter(function (x) { return x.ok; }).length, of: ex.length } : null;
    if (withActions) {
      var withA = ok.filter(function (r) { return r.score.actions; });
      t.actions = { runsWithABlock: withA.filter(function (r) { return r.score.actions.found && !r.score.actions.error; }).length, runsWithABadBlock: withA.filter(function (r) { return r.score.actions.error; }).length,
                    accepted: withA.reduce(function (a, r) { return a + r.score.actions.accepted; }, 0), dropped: withA.reduce(function (a, r) { return a + r.score.actions.dropped; }, 0), of: withA.length };
    }
    return t;
  });
}

function table(rows, head) {
  var line = function (cells) { return '| ' + cells.join(' | ') + ' |'; };
  return [line(head), line(head.map(function () { return '---'; }))].concat(rows.map(line)).join('\n');
}
function summaryMarkdown(info, totals, perQuestion) {
  var withActions = info.actions;
  var head = ['model', 'runs', 'failed', 'cut off', 'mean s', 'runs with an invented id', 'invented ids', 'copy slips', 'cited nothing'].concat(info.expect ? ['phrases held'] : []).concat(withActions ? ['runs with a block', 'bad block', 'actions accepted / dropped'] : []);
  var rows = totals.map(function (t) {
    return [t.model, t.runs, t.failed, t.cutOff, t.meanSeconds, t.runsWithAnInventedId + ' of ' + (t.runs - t.failed), t.inventedIds, t.copySlips, t.runsCitingNothing]
      .concat(info.expect ? [t.phrases ? t.phrases.held + ' of ' + t.phrases.of : '-'] : [])
      .concat(withActions ? [t.actions.runsWithABlock + ' of ' + t.actions.of, t.actions.runsWithABadBlock, t.actions.accepted + ' / ' + t.actions.dropped] : []);
  });
  var md = ['# Model comparison', '', 'Made ' + info.generated + ' with the workspace file `' + info.workspace + '`, ' + info.questions.length + ' questions, ' + info.runs + ' run' + (info.runs === 1 ? '' : 's') + ' each, ' + info.endpoint + '.',
            'About ' + info.promptTokens + ' tokens in the largest prompt.', '', table(rows, head), '',
            '## How to read it', '',
            '- **runs with an invented id**: an answer cited a transaction id or address that is not in the workspace (made up or garbled: the most serious slip in a forensic answer). **copy slips** are the ones one or two characters from a real id.',
            '- **cut off**: the model ran out of room before it finished (raise the context window of the server, or lower the pattern rows).',
            '- **cited nothing**: an answer with no id to check is unsupported.',
            '- **phrases held**: how many of the checks you wrote in the expectations file held (a number that must appear, a claim that must not).',
            '- **runs with a block / bad block / accepted / dropped** (with --actions): whether the model returned a block of actions that Hopline could read, and how many of its proposals survived the checks.',
            '- A model varies from run to run: with one run a number is a sample, with three or more it says something. Compare models on the same workspace, the same questions and the same settings.', '',
            '## By question', ''];
  perQuestion.forEach(function (q) {
    md.push('**' + q.n + '. ' + (q.task === 'next' ? 'Next steps' : q.label) + '**', '');
    md.push(table(q.models.map(function (m) { return [m.model, m.runs, m.invented, m.phrases || '-'].concat(withActions ? [m.actions || '-'] : []); }), ['model', 'answers', 'invented ids', 'phrases held'].concat(withActions ? ['actions accepted / dropped'] : [])), '');
  });
  return md.join('\n') + '\n';
}

async function listModels(base) {
  var r;
  try { r = await fetch(base + '/models'); } catch (e) { fail('could not reach the model server at ' + base + ' (is it running?)'); }
  var body = await r.text();
  if (!r.ok) fail('the server answered ' + r.status + '.');
  var d; try { d = JSON.parse(body); } catch (e) { fail('the server did not send a list of models.'); }
  var names = (Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models : []).map(function (m) { return m && (m.id || m.name); }).filter(function (x) { return typeof x === 'string'; }).map(function (x) { return AS.plainText(x, 80); });
  names.forEach(function (n) { process.stdout.write(n + '\n'); });
  return 0;
}

async function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.flags.help || (!args._.length && !args.flags.list)) { process.stdout.write(usage() + '\n'); return 0; }
  var ep = AS.localEndpoint(args.flags.endpoint || DEFAULT_ENDPOINT);
  if (!ep.ok) fail(ep.error);
  if (args.flags.list) return listModels(ep.base);

  var ws = args._[0];
  if (!fs.existsSync(ws)) fail('No such file: ' + ws);
  var models = Array.from(new Set(String(args.flags.models || '').split(',').map(function (m) { return m.trim(); }).filter(Boolean)));
  if (!models.length) fail('Name the models to ask: --models gpt-oss:20b,llama3.1:8b (node tools/compare-models.js --list shows what the server has).');
  models.forEach(function (m) { if (!/^[\w.:\/@+\-]+$/.test(m)) fail('"' + m + '" is not a model name the workspace can send.'); });
  var runs = intFlag(args, 'runs', 1, 1, 20), maxRows = intFlag(args, 'max-rows', 60, 5, 400), timeoutMs = intFlag(args, 'timeout-min', 10, 1, 120) * 60000;
  var temperature = args.flags.temperature == null ? null : Number(args.flags.temperature);
  if (temperature != null && !(temperature >= 0 && temperature <= 2)) fail('--temperature is a number from 0 to 2.');
  var withActions = args.flags.actions === true, questions = readQuestions(args.flags.questions, withActions), expect = readExpect(args.flags.expect);
  var anyActions = withActions || questions.some(function (q) { return q.task === 'next'; });                // the next-steps question carries the actions text whatever the flag says
  var out = args.flags.out || path.join(path.dirname(path.resolve(ws)), 'compare-models-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 13));
  fs.mkdirSync(out, { recursive: true });

  // the prompts: the same for every model, made once by the command-line tool as the workspace would make them
  var prompts = questions.map(function (q, i) {
    var a = ['prompt', ws, '--task', q.task, '--max-rows', String(maxRows), '--json'].concat(q.task === 'ask' ? ['--question', q.question] : []).concat(withActions && q.task === 'ask' ? ['--actions'] : []);
    var r = cli(a);
    if (r.status !== 0) fail('Could not make the prompt for question ' + (i + 1) + ': ' + (r.stderr || '').trim().slice(0, 200));
    return JSON.parse(r.stdout);
  });
  var promptTokens = Math.max.apply(null, prompts.map(function (p) { return p.tokens; }));
  note('Asking ' + models.length + ' model' + (models.length === 1 ? '' : 's') + ' ' + questions.length + ' questions, ' + runs + ' run' + (runs === 1 ? '' : 's') + ' each (' + models.length * questions.length * runs + ' answers). About ' + promptTokens + ' tokens in the largest prompt.');
  note('The first answer of each model also loads it, so it is slower. Answers go to ' + out);

  var results = [], total = models.length * questions.length * runs, done = 0;
  for (var mi = 0; mi < models.length; mi++) {
    var model = models[mi];
    fs.mkdirSync(path.join(out, safeName(model)), { recursive: true });
    for (var qi = 0; qi < questions.length; qi++) {
      for (var k = 1; k <= runs; k++) {
        var rec = { model: model, question: qi + 1, run: k }, t0 = Date.now();
        try {
          var ans = await askModel(ep.base, model, prompts[qi], timeoutMs, temperature);
          rec.seconds = r1((Date.now() - t0) / 1000); rec.cut = ans.cut; rec.chars = ans.text.length;
          fs.writeFileSync(path.join(out, safeName(model), 'q' + (qi + 1) + '-run' + k + '.txt'), ans.text + (ans.cut ? '\n\n[Cut off: the model stopped before it finished.]' : ''));
          rec.score = scoreAnswer(ws, ans.text, withActions || questions[qi].task === 'next', expectationsFor(expect, qi + 1));
        } catch (e) { rec.error = e && e.message ? e.message : String(e); }
        results.push(rec); done++;
        note('[' + done + '/' + total + '] ' + model + '  question ' + (qi + 1) + '  run ' + k + ': ' + (rec.error ? 'FAILED: ' + rec.error : rec.seconds + ' s, ' + rec.score.ids.unknown + ' invented id' + (rec.score.ids.unknown === 1 ? '' : 's') + (rec.cut ? ', cut off' : '')));
      }
    }
  }

  var info = { generated: new Date().toISOString(), workspace: path.basename(ws), endpoint: ep.base, runs: runs, actions: anyActions, expect: !!args.flags.expect, promptTokens: promptTokens,
               questions: questions.map(function (q, i) { return { n: i + 1, task: q.task, question: q.question || null }; }) };
  var totals = summarise(results, models, anyActions);
  var perQuestion = questions.map(function (q, i) {
    return { n: i + 1, task: q.task, label: q.question && q.question.length > 90 ? q.question.slice(0, 89) + '…' : q.question || '',
             models: models.map(function (m) {
               var rs = results.filter(function (r) { return r.model === m && r.question === i + 1 && !r.error; }), ex = [].concat.apply([], rs.map(function (r) { return r.score.expectations; }));
               return { model: m, runs: rs.length, invented: rs.reduce(function (a, r) { return a + r.score.ids.unknown; }, 0), phrases: ex.length ? ex.filter(function (x) { return x.ok; }).length + ' of ' + ex.length : '',
                        actions: rs.some(function (r) { return r.score.actions; }) ? rs.reduce(function (a, r) { return a + (r.score.actions ? r.score.actions.accepted : 0); }, 0) + ' / ' + rs.reduce(function (a, r) { return a + (r.score.actions ? r.score.actions.dropped : 0); }, 0) : '' };
             }) };
  });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ info: info, totals: totals, runs: results }, null, 2));
  var md = summaryMarkdown(info, totals, perQuestion);
  fs.writeFileSync(path.join(out, 'summary.md'), md);
  process.stdout.write(md);
  note('Written to ' + out);
  return 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { fail(e && e.message ? e.message : String(e)); });
