'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { Graph, ID } = require('../public/js/hopline-model.js');
const IO = require('../public/js/hopline-io.js');
const An = require('../public/js/hopline-analysis.js');

const CLI = path.join(__dirname, '..', 'tools', 'hopline-cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-cli-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- a small workspace: a peel chain, a consolidation and a payment to a wallet on the built-in list ---------------------------
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const a = (name) => 'bc1q' + name.padEnd(20, 'x');
const IN = (txn, vout, addr, value) => ({ txid: tid(txn), vout, addr, value });
const OUT = (addr, value) => ({ addr, value });
const BINANCE = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';                         // on the built-in list as "Binance Hot Wallet"
function add(g, n, ins, outs) {
  g.addTx({ txid: tid(n), fee: 200, weight: 800, status: { confirmed: true, block_height: 700000 + n, block_time: 1650000000 + n * 600 },
    vin: ins.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, prevout: { scriptpubkey_address: i.addr, scriptpubkey_type: 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => ({ scriptpubkey_address: o.addr, scriptpubkey_type: 'v0_p2wpkh', value: o.value })) });
}
function spend(g, from, vout, by) {
  const outs = g.edgesOf(ID.tx(tid(from))).filter((e) => e.kind === 'out' && e.source === ID.tx(tid(from))).length;
  const list = Array.from({ length: outs }, () => ({ spent: false }));
  list[vout] = { spent: true, txid: tid(by), vin: 0, status: { confirmed: true, block_time: 1650000000 + by * 600 } };
  g.addOutspends(tid(from), list);
}
function workspace() {
  const g = new Graph();
  let value = 1000000;
  for (let i = 0; i < 5; i++) {
    const t = 10 + i, prev = i === 0 ? IN(250, 0, a('origin'), value) : IN(t - 1, 1, a('c' + (i - 1)), value), small = 1000 + i * 13, large = value - small - 200;
    add(g, t, [prev], [OUT(i === 2 ? BINANCE : a('peel' + i), small), OUT(a('c' + i), large)]);
    if (i > 0) spend(g, t - 1, 1, t);
    value = large;
  }
  add(g, 40, Array.from({ length: 6 }, (_, i) => IN(200 + i, 0, a('k' + i), 10000)), [OUT(a('dest'), 59000)]);
  return IO.toJson(g, {});
}
const FILE = path.join(dir, 'ws.json');
fs.writeFileSync(FILE, workspace());
const LABEL = 'P-' + tid(10).slice(0, 4);

function run(args, o) {
  const r = spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', input: o && o.input, cwd: dir });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test('help and no arguments print the usage and succeed', () => {
  for (const args of [[], ['help'], ['--help']]) { const r = run(args); assert.equal(r.code, 0); assert.match(r.out, /summary\s+<workspace\.json>/); assert.match(r.out, /no network/); }
});

test('summary: the evidence summary as JSON', () => {
  const r = run(['summary', FILE, '--generated', '2026-10-23T00:00:00Z']), s = r.json();
  assert.equal(r.code, 0); assert.equal(s.format, 'hopline-evidence-summary'); assert.equal(s.generated, '2026-10-23T00:00:00Z');
  assert.equal(s.counts.transactionsLoaded, 6); assert.equal(s.counts.peelChains, 1); assert.equal(s.chains[0].label, LABEL);
  assert.equal(r.err, '');
  assert.ok(r.out.includes('\n  "format"'), 'indented by default');
  assert.ok(!run(['summary', FILE, '--compact']).out.trim().includes('\n'), '--compact is one line');
});

test('summary: the built-in wallet list names a wallet, and --no-known leaves it out', () => {
  const w = run(['summary', FILE]).json().wallets;
  assert.deepEqual(w.map((x) => x.address), [BINANCE]); assert.equal(w[0].known.name, 'Binance Hot Wallet');
  assert.deepEqual(run(['summary', FILE, '--no-known']).json().wallets, []);
  const mine = path.join(dir, 'known.js');
  fs.writeFileSync(mine, 'window.HOPLINE_KNOWN = {\n  "' + BINANCE + '": {"label": "My own name", "category": "EXCH"}\n};\n');
  assert.equal(run(['summary', FILE, '--known', mine]).json().wallets[0].known.name, 'My own name');
});

test('the OFAC list the site ships names and flags a wallet in the summary, and --no-packs, --packs and --no-known change that', () => {
  const pack = fs.readFileSync(path.join(__dirname, '..', 'public', 'packs', 'ofac-sdn.js'), 'utf8');
  const sanctioned = /^\{"address":"([^"]+)"/m.exec(pack)[1];
  const g = new Graph();
  add(g, 60, [IN(250, 1, a('payer'), 50000)], [OUT(sanctioned, 40000), OUT(a('change'), 9000)]);
  const file = path.join(dir, 'ofac-ws.json'); fs.writeFileSync(file, IO.toJson(g, {}));
  const w = run(['summary', file]).json().wallets.find((x) => x.address === sanctioned);
  assert.ok(w && w.known.sanctions === true && /^OFAC SDN: /.test(w.known.name) && w.known.source === 'OFAC SDN list (Bitcoin)', 'named, flagged and sourced like the page does');
  assert.equal(run(['summary', file, '--no-packs']).json().wallets.find((x) => x.address === sanctioned), undefined);
  assert.equal(run(['summary', file, '--no-known']).json().wallets.find((x) => x.address === sanctioned), undefined, '--no-known leaves out names from both lists');
  const other = path.join(dir, 'packs'); fs.mkdirSync(other);
  assert.equal(run(['summary', file, '--packs', other]).code, 2, 'a folder that holds no pack list is refused when it was asked for');
  assert.match(run(['summary', file, '--packs', other]).err, /no pack list/);
  const evil = path.join(dir, 'packs2'); fs.mkdirSync(evil);
  const marker = path.join(dir, 'ran2.txt');
  fs.writeFileSync(path.join(evil, 'index.js'), 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x"); window.HOPLINE_PACK_INDEX = [{"id":"x","name":"X","file":"x.js","entries":1,"defaultOn":true}];');
  fs.writeFileSync(path.join(evil, 'x.js'), 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x"); (window.HOPLINE_PACKS = {})["x"] = {"labels":[{"address":"' + sanctioned + '","label":"Mine"}]};');
  const r = run(['summary', file, '--packs', evil]);
  assert.ok(!fs.existsSync(marker), 'nothing in the pack files was executed'); assert.equal(r.code, 0);
  assert.equal(r.json().wallets.find((x) => x.address === sanctioned).known.name, 'Mine');
});

test('a shipped pack that is off as shipped is used only when asked for with --with', () => {
  const pack = fs.readFileSync(path.join(__dirname, '..', 'public', 'packs', 'ransomwhere.js'), 'utf8');
  const payee = /^\{"address":"([^"]+)"/m.exec(pack)[1];
  const g = new Graph();
  add(g, 61, [IN(250, 2, a('victim'), 90000)], [OUT(payee, 80000), OUT(a('chg'), 9000)]);
  const file = path.join(dir, 'rw-ws.json'); fs.writeFileSync(file, IO.toJson(g, {}));
  const find = (args) => run(['summary', file].concat(args)).json().wallets.find((x) => x.address === payee);
  assert.equal(find([]), undefined, 'not named by default');
  const w = find(['--with', 'ransomwhere']);
  assert.ok(w && /^Ransomware/.test(w.known.name) && w.known.source === 'Ransomwhere ransomware payments' && w.known.sanctions === undefined, 'named and sourced, and not a sanctions list');
  assert.equal(find(['--with', 'ransomwhere,ofac-sdn']).known.name, w.known.name);
  assert.equal(find(['--with', 'ransomwhere', '--no-packs']), undefined);
  const bad = run(['summary', file, '--with', 'nope']);
  assert.equal(bad.code, 2); assert.match(bad.err, /No pack named "nope".*ofac-sdn, ransomwhere/);
});

test('a wallet list that holds code is read as data and never run', () => {
  const evil = path.join(dir, 'evil.js'), marker = path.join(dir, 'ran.txt');
  fs.writeFileSync(evil, 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x"); window.HOPLINE_KNOWN = {};');
  const r = run(['summary', FILE, '--known', evil]);
  assert.ok(!fs.existsSync(marker), 'nothing in the file was executed'); assert.equal(r.code, 0); assert.deepEqual(r.json().wallets, [], 'only the object literal was read, and it was empty');
  fs.writeFileSync(evil, 'window.HOPLINE_KNOWN = { "a": require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x") };');
  const r2 = run(['summary', FILE, '--known', evil]);
  assert.equal(r2.code, 2); assert.match(r2.err, /not valid JSON/); assert.ok(!fs.existsSync(marker), 'still nothing was executed');
  assert.equal(run(['summary', FILE, '--known', path.join(dir, 'missing.js')]).code, 2);
});

test('detections: all, by kind and by chain', () => {
  const all = run(['detections', FILE]).json();
  assert.deepEqual(all.map((r) => r.pattern), ['PEEL 1/5', 'PEEL 2/5', 'PEEL 3/5', 'PEEL 4/5', 'PEEL 5/5', 'CONSOL 6→1']);
  assert.equal(run(['detections', FILE, '--kind', 'consolidation']).json().length, 1);
  assert.equal(run(['detections', FILE, '--kind', 'peel']).json().length, 5);
  assert.equal(run(['detections', FILE, '--chain', LABEL]).json().length, 5);
  assert.deepEqual(run(['detections', FILE, '--chain', 'P-nothing']).json(), []);
  const bad = run(['detections', FILE, '--kind', 'fancy']); assert.equal(bad.code, 2); assert.match(bad.err, /--kind is one of peel, consolidation, batch, coinjoin/);
});

test('chains: every chain with its steps and payments', () => {
  const c = run(['chains', FILE]).json();
  assert.equal(c.length, 1); assert.equal(c[0].txids.length, 5); assert.equal(c[0].payments.length, 5); assert.equal(c[0].payments[2].address, BINANCE);
});

test('focus: one transaction, a chain, and an error for what is not there', () => {
  const t = run(['focus', FILE, tid(12)]).json();
  assert.equal(t.type, 'transaction'); assert.equal(t.peelChain.step, 3); assert.equal(t.outputs.length, 2);
  assert.equal(run(['focus', FILE, LABEL]).json().type, 'peel chain');
  assert.equal(run(['focus', FILE, BINANCE]).json().known.name, 'Binance Hot Wallet');
  const none = run(['focus', FILE, tid(99)]); assert.equal(none.code, 2); assert.match(none.err, /is not in the workspace/);
  assert.equal(run(['focus', FILE]).code, 2);
});

test('prompt: the text for an assistant, and as JSON', () => {
  const r = run(['prompt', FILE, '--task', 'triage']);
  assert.equal(r.code, 0); assert.match(r.out, /Use only the EVIDENCE/); assert.match(r.out, /TASK: Triage/); assert.match(r.out, /<<EVIDENCE \(JSON\)/);
  const j = run(['prompt', FILE, '--task', 'narrative', '--json']).json();
  assert.deepEqual(Object.keys(j).sort(), ['shown', 'system', 'task', 'tokens', 'user']); assert.equal(j.task, 'narrative');
  const ex = run(['prompt', FILE, '--task', 'explain', '--focus', tid(12)]);
  assert.equal(ex.code, 0); assert.match(ex.out, /TASK: Explain the FOCUS/); assert.ok(ex.out.includes('"focus":{"type":"transaction"'));
  assert.equal(run(['prompt', FILE, '--task', 'explain']).code, 2);
  assert.equal(run(['prompt', FILE]).code, 2);
  assert.equal(run(['prompt', FILE, '--task', 'triage', '--max-rows', '0']).code, 2);
  assert.equal(run(['prompt', FILE, '--task', 'triage', '--focus', tid(99)]).code, 2);
});

test('check: exit 0 when every id is in the evidence, 1 when one is not, with the ids named', () => {
  const good = path.join(dir, 'good.txt'), bad = path.join(dir, 'bad.txt'), fake = 'ab'.repeat(32);
  fs.writeFileSync(good, 'The chain starts at ' + tid(10) + ' and pays ' + BINANCE + '.');
  fs.writeFileSync(bad, 'It also moved through ' + fake + '.');
  const g = run(['check', FILE, good]); assert.equal(g.code, 0); assert.equal(g.json().ok, true); assert.equal(g.json().cited.txids[0].where, 'evidence');
  const b = run(['check', FILE, bad]); assert.equal(b.code, 1); assert.deepEqual(b.json().unknown.txids, [fake]);
  const viaStdin = run(['check', FILE, '-'], { input: 'See ' + fake }); assert.equal(viaStdin.code, 1);
  assert.equal(run(['check', FILE]).code, 2);
  assert.equal(run(['check', '-', '-']).code, 2);
});

test('the workspace can come from standard input', () => {
  const r = run(['chains', '-'], { input: fs.readFileSync(FILE, 'utf8') });
  assert.equal(r.code, 0); assert.equal(r.json().length, 1);
});

test('problems with the input are reported plainly and exit 2', () => {
  const junk = path.join(dir, 'junk.json'); fs.writeFileSync(junk, 'not json');
  let r = run(['summary', junk]); assert.equal(r.code, 2); assert.match(r.err, /Not a JSON file/);
  fs.writeFileSync(junk, JSON.stringify({ hello: 1 })); r = run(['summary', junk]); assert.equal(r.code, 2); assert.match(r.err, /Not a Hopline workspace file/);
  r = run(['summary', path.join(dir, 'missing.json')]); assert.equal(r.code, 2); assert.match(r.err, /no such file/);
  r = run(['summary']); assert.equal(r.code, 2); assert.match(r.err, /Name the workspace file/);
  r = run(['frobnicate', FILE]); assert.equal(r.code, 2); assert.match(r.err, /Unknown command/);
  r = run(['summary', FILE, '--bogus']); assert.equal(r.code, 2); assert.match(r.err, /Unknown option/);
  r = run(['summary', FILE, '--kind']); assert.equal(r.code, 2); assert.match(r.err, /needs a value/);
});

test('it never touches the network: neither the tool nor the modules it uses can open a connection', () => {
  const files = [CLI].concat(['hopline-assist.js', 'hopline-detections.js'].map((f) => path.join(__dirname, '..', 'public', 'js', f)));
  files.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/require\(\s*['"](?:node:)?(?:https?|net|tls|dgram|dns|http2)['"]\s*\)/.test(src), f + ' requires a network module');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|child_process/.test(src), f + ' uses a network or process API');
  });
});

test('the same workspace gives the same summary every time (apart from the time it was made)', () => {
  const x = run(['summary', FILE, '--generated', 'T']).out, y = run(['summary', FILE, '--generated', 'T']).out;
  assert.equal(x, y);
});

test('the analysis in the CLI is the one the page runs', () => {
  const g = IO.fromJson(fs.readFileSync(FILE, 'utf8')).graph, an = An.analyse(g);
  assert.equal(run(['chains', FILE]).json()[0].label, an.chains[0].label);
});
