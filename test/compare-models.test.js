'use strict';
// tools/compare-models.js: the same questions to several models on this computer, scored by code. The models here are stand-ins on a server on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFile, spawnSync } = require('child_process');
const { Graph, ID } = require('../public/js/hopline-model.js');
const IO = require('../public/js/hopline-io.js');

const TOOL = path.join(__dirname, '..', 'tools', 'compare-models.js'), CLI = path.join(__dirname, '..', 'tools', 'hopline-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-models-'));
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); server.close(); });

// ---- a small workspace (as in cli.test.js): a peel chain and a consolidation ------------------------------------------------------------
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const a = (name) => 'bc1q' + name.padEnd(20, 'x');
function add(g, n, ins, outs) {
  g.addTx({ txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: 1650000000 + n * 600 },
    vin: ins.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, prevout: { scriptpubkey_address: i.addr, scriptpubkey_type: 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => ({ scriptpubkey_address: o.addr, scriptpubkey_type: 'v0_p2wpkh', value: o.value })) });
}
const IN = (txn, vout, addr, value) => ({ txid: tid(txn), vout, addr, value });
const OUT = (addr, value) => ({ addr, value });
const g = new Graph();
let value = 1000000;
for (let i = 0; i < 5; i++) {
  const t = 10 + i, prev = i === 0 ? IN(250, 0, a('origin'), value) : IN(t - 1, 1, a('c' + (i - 1)), value), small = 1000 + i * 13, large = value - small - 200;
  add(g, t, [prev], [OUT(a('peel' + i), small), OUT(a('c' + i), large)]);
  value = large;
}
for (let i = 0; i < 8; i++) add(g, 50 + i, Array.from({ length: 6 }, (_, j) => IN(100 + i * 6 + j, 0, a('k' + i + '_' + j), 10000)), [OUT(a('d' + i), 59000)]);      // eight consolidations: more pattern rows than the smallest limit
const FILE = path.join(dir, 'ws.json');
fs.writeFileSync(FILE, IO.toJson(g, {}));
const GARBLED = tid(10).slice(0, -1) + '0';                                                 // a copy of a real id with the last character wrong
const GARBLED_ADDR = a('peel0').slice(0, -1) + 'y';                                         // and of a real address

// ---- stand-in models --------------------------------------------------------------------------------------------------------------------
const seen = [];
const reply = (res, content, finish) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content }, finish_reason: finish || 'stop' }] })); };
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: ['steady', 'sloppy', 'broken', 'thinker'].map((id) => ({ id })) })); }
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const b = JSON.parse(body), user = b.messages[1].content, next = user.indexOf('TASK: Next steps') >= 0;
    seen.push({ model: b.model, user: user, system: b.messages[0].content, temperature: b.temperature });
    if (b.model === 'broken') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'model not found' } })); }
    if (b.model === 'steady') {
      if (next) return reply(res, 'Here are the next steps.\n```json\n' + JSON.stringify({ actions: [{ action: 'select', ids: [tid(10)], why: 'the first step' }, { action: 'load', id: tid(250), why: 'it funded the chain' }] }) + '\n```');
      return reply(res, 'The first step is ' + tid(10) + ' and the chain goes on. The two were 57.282 seconds apart.');
    }
    if (b.model === 'thinker') return reply(res, '<think>I recall ' + GARBLED + ' but not well.</think>The first step is ' + tid(10) + '.');
    // sloppy: cites a garbled id, runs out of room on one question, and proposes an action that does not exist
    if (next) return reply(res, '```json\n' + JSON.stringify({ actions: [{ action: 'ask_arkham', id: tid(10), why: 'see who owns it' }] }) + '\n```');
    return reply(res, 'Probably ' + GARBLED + ' and ' + GARBLED_ADDR + ', and the owner is one entity with distinct owners.', user.indexOf('strongest finding wrong') >= 0 ? 'length' : 'stop');
  });
});
let BASE;
const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', () => { BASE = 'http://127.0.0.1:' + server.address().port + '/v1'; resolve(); }));

function tool(args) {
  return new Promise((resolve) => execFile(process.execPath, [TOOL].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}
const QUESTIONS = path.join(dir, 'questions.txt'), EXPECT = path.join(dir, 'expect.json');
fs.writeFileSync(QUESTIONS, '# the questions\nWhich findings should I look at first, and why?\nWhat would make the strongest finding wrong?\ntask:next\n');
fs.writeFileSync(EXPECT, JSON.stringify({ defaults: { mustNotContain: ['distinct owners'] }, 1: { mustContain: ['57\\.282'] } }));

test('--list prints the models the server has, and a server that is not on this computer is refused', async () => {
  await listening;
  const l = await tool(['--list', '--endpoint', BASE]);
  assert.deepEqual([l.code, l.stdout.trim().split('\n')], [0, ['steady', 'sloppy', 'broken', 'thinker']]);
  const far = await tool([FILE, '--models', 'steady', '--endpoint', 'http://example.com/v1']);
  assert.equal(far.code, 2); assert.match(far.stderr, /Only a model on this computer is allowed/);
  assert.equal((await tool(['--list', '--endpoint', 'http://192.168.1.20:11434/v1'])).code, 2, 'neither is a machine on the local network');
});

test('the usage and the mistakes are said in words', async () => {
  await listening;
  assert.match((await tool(['--help'])).stdout, /Compare local models on the same questions/);
  assert.match((await tool([FILE, '--endpoint', BASE])).stderr, /Name the models to ask/);
  assert.match((await tool([FILE, '--models', 'a b', '--endpoint', BASE])).stderr, /is not a model name/);
  assert.match((await tool([FILE, '--models', 'steady', '--runs', '0', '--endpoint', BASE])).stderr, /--runs is a whole number from 1 to 20/);
  assert.match((await tool([path.join(dir, 'nothing.json'), '--models', 'steady', '--endpoint', BASE])).stderr, /No such file/);
  assert.match((await tool([FILE, '--models', 'steady', '--expect', path.join(dir, 'nope.json'), '--endpoint', BASE])).stderr, /Could not read the expectations/);
  fs.writeFileSync(path.join(dir, 'badexpect.json'), JSON.stringify({ 1: { mustContain: ['('] } }));
  assert.match((await tool([FILE, '--models', 'steady', '--expect', path.join(dir, 'badexpect.json'), '--endpoint', BASE])).stderr, /is not a regular expression/);
});

test('the models are asked in turn, each run is scored by the checks of the workspace, and the results and the summary are written', async () => {
  await listening;
  seen.length = 0;
  const out = path.join(dir, 'out1');
  const r = await tool([FILE, '--models', 'steady,sloppy,broken,thinker', '--runs', '2', '--questions', QUESTIONS, '--expect', EXPECT, '--actions', '--out', out, '--endpoint', BASE]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!/[0-9a-f]{64}/.test(r.stdout + r.stderr), 'it prints counts, never an id');
  assert.ok(!/bc1q/.test(r.stdout + r.stderr));
  const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')), by = (m) => res.totals.find((t) => t.model === m);
  assert.deepEqual([res.info.runs, res.info.questions.length, res.info.actions, res.info.workspace], [2, 3, true, 'ws.json']);
  assert.equal(res.runs.length, 4 * 3 * 2);
  assert.deepEqual(seen.filter((s) => s.model === 'steady').length, 6, 'each model is asked every question the number of runs');
  // the model that behaves
  const s = by('steady');
  assert.deepEqual([s.runs, s.failed, s.runsWithAnInventedId, s.inventedIds, s.cutOff], [6, 0, 0, 0, 0]);
  assert.deepEqual(s.actions, { runsWithABlock: 2, runsWithABadBlock: 0, accepted: 4, dropped: 0, of: 6 }, 'the block of the next-steps answer is read and both actions survive the checks');
  assert.deepEqual(s.phrases, { held: 8, of: 8 });
  // the model that slips
  const p = by('sloppy');
  assert.deepEqual([p.runsWithAnInventedId, p.inventedIds, p.copySlips, p.cutOff], [4, 8, 8, 2], 'a garbled transaction id and a garbled address are invented, and both are copy slips; one question runs out of room');
  assert.deepEqual([p.actions.accepted, p.actions.dropped, p.actions.runsWithABlock], [0, 2, 2], 'an action that does not exist is dropped');
  assert.deepEqual(p.phrases, { held: 2, of: 8 }, 'it says "distinct owners" in both answers to a question and never gives the number, so only its two next-steps answers hold');
  // a model that fails and a model that thinks aloud
  const b = by('broken');
  assert.deepEqual([b.runs, b.failed], [6, 6]);
  assert.match(res.runs.find((x) => x.model === 'broken').error, /the model server answered 500: .*model not found/);
  const t = by('thinker');
  assert.deepEqual([t.failed, t.inventedIds], [0, 0], 'what a model writes between <think> tags is not scored');
  // the files
  assert.ok(fs.existsSync(path.join(out, 'steady', 'q1-run1.txt')) && fs.existsSync(path.join(out, 'sloppy', 'q2-run2.txt')));
  assert.match(fs.readFileSync(path.join(out, 'sloppy', 'q2-run1.txt'), 'utf8'), /Cut off: the model stopped before it finished/);
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /# Model comparison/); assert.match(md, /\| steady \| 6 \| 0 \|/); assert.match(md, /\| broken \| 6 \| 6 \|/); assert.match(md, /## How to read it/); assert.match(md, /## By question/);
  assert.equal(r.stdout, md, 'the summary is also printed');
});

test('the prompt a model gets is the one the workspace makes, with the actions text only when asked for, and the temperature can be set', async () => {
  await listening;
  fs.writeFileSync(path.join(dir, 'one.txt'), 'Where do the open ends of the trace lead?\n');
  seen.length = 0;
  await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'one.txt'), '--out', path.join(dir, 'out2'), '--endpoint', BASE]);
  const want = JSON.parse(spawnSync(process.execPath, [CLI, 'prompt', FILE, '--task', 'ask', '--question', 'Where do the open ends of the trace lead?', '--max-rows', '60', '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].user, seen[0].system, seen[0].temperature], [want.user, want.system, 0.2], 'the same text, the same rules, the workspace\'s own temperature');
  assert.ok(!seen[0].user.includes('ACTIONS (optional)'));
  seen.length = 0;
  await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'one.txt'), '--actions', '--temperature', '0.7', '--max-rows', '20', '--out', path.join(dir, 'out3'), '--endpoint', BASE]);
  assert.ok(seen[0].user.includes('ACTIONS (optional)'), 'with --actions the models are told they may propose them');
  assert.equal(seen[0].temperature, 0.7);
  seen.length = 0;
  await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'one.txt'), '--max-rows', '5', '--out', path.join(dir, 'out3b'), '--endpoint', BASE]);
  assert.match(seen[0].user, /Only the first 5 of \d+ pattern rows are in this prompt/, '--max-rows reaches the prompt');
  seen.length = 0;
  await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'one.txt'), '--out', path.join(dir, 'out3c'), '--endpoint', BASE]);
  assert.ok(!/Only the first \d+ of \d+ pattern rows/.test(seen[0].user), 'and by default there are 60, so the eight are all in');
});

test('with no questions file the three built-in questions name no id, and --actions adds the next-steps question', async () => {
  await listening;
  seen.length = 0;
  const r = await tool([FILE, '--models', 'steady', '--actions', '--out', path.join(dir, 'out4'), '--endpoint', BASE]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.length, 4);
  assert.ok(!/[0-9a-f]{64}/.test(seen.slice(0, 3).map((s) => s.user.split('<<EVIDENCE')[0]).join('')), 'no id in the questions');
  assert.ok(seen[3].user.includes('TASK: Next steps'));
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'out4', 'results.json'), 'utf8'));
  assert.deepEqual(res.info.questions.map((q) => q.task), ['ask', 'ask', 'ask', 'next']);
});

test('a task:next question is scored for actions even without --actions', async () => {
  await listening;
  fs.writeFileSync(path.join(dir, 'next.txt'), 'task:next\n');
  const r = await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'next.txt'), '--out', path.join(dir, 'out5'), '--endpoint', BASE]);
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'out5', 'results.json'), 'utf8'));
  assert.deepEqual([res.info.actions, res.totals[0].actions.accepted], [true, 2]);
});

test('a server that is not running is said in words, and one failed run does not stop the others', async () => {
  await listening;
  const r = await tool([FILE, '--models', 'steady', '--questions', path.join(dir, 'one.txt'), '--out', path.join(dir, 'out6'), '--endpoint', 'http://127.0.0.1:9/v1']);
  assert.equal(r.code, 0);
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'out6', 'results.json'), 'utf8'));
  assert.match(res.runs[0].error, /could not reach the model server at http:\/\/127\.0\.0\.1:9\/v1/);
  assert.equal(res.totals[0].failed, 1);
});
