'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const Mon = require('../tools/hopline-monitor.js');

const TOOL = path.join(__dirname, '..', 'tools', 'hopline-monitor.js');
const A = 'bc1q' + 'a'.repeat(38), B = 'bc1q' + 'b'.repeat(38), OTHER = 'bc1q' + 'c'.repeat(38);
const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const T = 1794000000000;                                                      // the clock the tests give the monitor, in milliseconds

/** A made-up Esplora server (and a BlockCypher at /bc) over a chain the test changes: addresses hold transactions, newest first, unconfirmed ones before the confirmed. */
function makeServer() {
  const addrs = {}, bc = {}, hits = { esplora: [], bc: [] }, flags = { fail: 0, bcStatus: 200, tx404: true };
  const txs = new Map();
  function mk(n, o) {
    const t = { txid: txid(n), fee: o.fee == null ? 200 : o.fee, status: o.confirmed === false ? { confirmed: false } : { confirmed: true, block_height: o.height || 900000, block_time: o.time || 1793990000 },
                vin: (o.from || [['x' + n, 100000]]).map(([a, v]) => ({ txid: txid(200 + n), vout: 0, prevout: { scriptpubkey_address: a, value: v } })), vout: (o.to || [[A, 90000]]).map(([a, v]) => ({ scriptpubkey_address: a, value: v })) };
    txs.set(t.txid, t);
    return t;
  }
  function add(addr, t) { (addrs[addr] = addrs[addr] || []).unshift(t); addrs[addr].sort((x, y) => (x.status.confirmed ? 1 : 0) - (y.status.confirmed ? 1 : 0) || (y.status.block_height || 0) - (x.status.block_height || 0)); }
  const stats = (a) => {
    const list = addrs[a] || [], conf = list.filter((t) => t.status.confirmed), mem = list.filter((t) => !t.status.confirmed);
    const fund = (l) => l.reduce((s, t) => s + t.vout.filter((o) => o.scriptpubkey_address === a).reduce((x, o) => x + o.value, 0), 0), spent = (l) => l.reduce((s, t) => s + t.vin.filter((i) => i.prevout.scriptpubkey_address === a).reduce((x, i) => x + i.prevout.value, 0), 0);
    return { address: a, chain_stats: { tx_count: conf.length, funded_txo_sum: fund(conf), spent_txo_sum: spent(conf) }, mempool_stats: { tx_count: mem.length, funded_txo_sum: fund(mem), spent_txo_sum: spent(mem) } };
  };
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    let m;
    if ((m = /^\/bc\/txs\/([0-9a-f]{64})/.exec(req.url))) { hits.bc.push(m[1]); if (flags.bcStatus !== 200) return send(flags.bcStatus, { error: 'Limits reached.' }); return bc[m[1]] ? send(200, bc[m[1]]) : send(404, { error: 'not found' }); }
    hits.esplora.push(req.url.replace(/^\/api/, ''));
    if (flags.fail) return send(500, 'boom');
    if ((m = /^\/api\/address\/([^/]+)\/txs$/.exec(req.url))) return send(200, (addrs[m[1]] || []).slice(0, 25));
    if ((m = /^\/api\/address\/([^/]+)$/.exec(req.url))) return send(200, stats(m[1]));
    if ((m = /^\/api\/tx\/([0-9a-f]{64})$/.exec(req.url))) return txs.has(m[1]) && !flags.tx404 ? send(200, txs.get(m[1])) : send(404, 'not found');
    send(404, 'no');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port, mk, add, addrs, bc, hits, flags, txs, close: () => new Promise((r) => server.close(r)) })));
}

async function scene(fn) {
  const srv = await makeServer(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-monitor-')), clock = { t: T };
  const files = { log: path.join(dir, 'events.jsonl'), state: path.join(dir, 'state.json') };
  const go = (extra) => Mon.run(Object.assign({ wallets: [A], api: srv.base + '/api', blockcypherApi: srv.base + '/bc', log: files.log, state: files.state, once: true, quiet: true, delay: 0, out: () => {}, sleep: async () => {}, now: () => clock.t }, extra));
  try { await fn({ srv, dir, clock, files, go }); } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const types = (r) => r.events.map((e) => e.type);

test('the first look is the starting point: a balance snapshot and what is waiting, not the history', async () => {
  await scene(async ({ srv, files, go }) => {
    for (let i = 1; i <= 3; i++) srv.add(A, srv.mk(i, { height: 900000 + i, to: [[A, 10000 * i]] }));
    srv.add(A, srv.mk(9, { confirmed: false, to: [[A, 5000]], fee: 150 }));
    const r = await go();
    assert.deepEqual(types(r), ['start', 'tx']);
    const [s, t] = r.events;
    assert.deepEqual([s.wallet, s.confirmed, s.unconfirmed, s.txCount, s.n, s.prev], [A, 60000, 5000, 3, 1, Mon.ZERO]);
    assert.deepEqual([t.txid, t.status, t.in, t.out, t.fee, t.baseline, t.seenAt, t.at], [txid(9), 'unconfirmed', 5000, 0, 150, true, T / 1000, new Date(T).toISOString()]);
    const st = JSON.parse(fs.readFileSync(files.state, 'utf8'));
    assert.deepEqual([st.wallets[A].seen.length, Object.keys(st.wallets[A].pending)], [4, [txid(9)]]);
    assert.equal(srv.hits.bc.length, 0, 'nothing is sent to BlockCypher unless it is asked for');
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});

test('nothing changed costs one request, and a new unconfirmed payment is one event with what it did to the wallet and when it was first seen', async () => {
  await scene(async ({ srv, files, go, clock }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    srv.hits.esplora.length = 0;
    const quiet = await go();
    assert.deepEqual([quiet.events.length, srv.hits.esplora], [0, ['/address/' + A]]);
    clock.t += 90000; srv.add(A, srv.mk(2, { confirmed: false, to: [[A, 7000], [OTHER, 2000]], fee: 321 }));
    const r = await go();
    assert.deepEqual(types(r), ['tx']);
    const e = r.events[0];
    assert.deepEqual([e.txid, e.in, e.out, e.fee, e.status, e.seenAt, e.baseline, e.n], [txid(2), 7000, 0, 321, 'unconfirmed', (T + 90000) / 1000, undefined, 2]);
    const again = await go();
    assert.equal(again.events.length, 0, 'not repeated');
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});

test('a waiting transaction that gets into a block is one more event, once, with its block', async () => {
  await scene(async ({ srv, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    const t2 = srv.mk(2, { confirmed: false, to: [[A, 7000]] }); srv.add(A, t2);
    await go();
    srv.addrs[A] = srv.addrs[A].filter((t) => t !== t2); srv.add(A, srv.mk(2, { height: 900050, time: 1793995000, to: [[A, 7000]] }));
    const r = await go();
    assert.deepEqual(types(r), ['confirmed']);
    assert.deepEqual([r.events[0].txid, r.events[0].height, r.events[0].blockTime], [txid(2), 900050, 1793995000]);
    assert.equal((await go()).events.length, 0);
  });
});

test('what a transaction took out of the wallet is counted, and a payment to it and from it in one transaction says both', async () => {
  await scene(async ({ srv, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 100000]] }));
    await go();
    srv.add(A, srv.mk(2, { confirmed: false, from: [[A, 100000]], to: [[OTHER, 60000], [A, 39000]], fee: 1000 }));
    const e = (await go()).events[0];
    assert.deepEqual([e.in, e.out, e.fee], [39000, 100000, 1000], 'its own change came back, and everything it had was spent');
    assert.deepEqual(Mon.effect({ vin: [{ prevout: { scriptpubkey_address: A, value: 5 } }, { prevout: { scriptpubkey_address: B, value: 7 } }, {}], vout: [{ scriptpubkey_address: A, value: 3 }, { scriptpubkey_address: A, value: 4 }, {}] }, A), { in: 7, out: 5 });
  });
});

test('stopping and starting again misses nothing and repeats nothing, and the numbering and the chain go on', async () => {
  await scene(async ({ srv, files, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    srv.add(A, srv.mk(2, { confirmed: false, to: [[A, 7000]] }));
    await go();
    srv.add(A, srv.mk(3, { confirmed: false, to: [[A, 3000]] }));                              // happens while the monitor is not running
    const r = await go();                                                                       // a new run reads the state file
    assert.deepEqual([types(r), r.events[0].txid, r.events[0].n], [['tx'], txid(3), 3]);
    assert.deepEqual(Mon.readEvents(files.log).map((e) => e.n), [1, 2, 3]);
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});

test('a waiting transaction that leaves the mempool is dropped, or confirmed when it can be found', async () => {
  await scene(async ({ srv, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    const t2 = srv.mk(2, { confirmed: false, to: [[A, 7000]] }), t3 = srv.mk(3, { confirmed: false, to: [[A, 8000]] });
    srv.add(A, t2); srv.add(A, t3);
    await go();
    srv.addrs[A] = srv.addrs[A].filter((t) => t !== t2 && t !== t3);                             // both gone from the mempool
    srv.add(A, srv.mk(4, { height: 900060, to: [[A, 1000]] }));                                  // and something else happened, so the totals changed
    srv.flags.tx404 = true;
    const dropped = await go();
    assert.deepEqual(dropped.events.map((e) => [e.type, e.txid]).sort(), [['dropped', txid(2)], ['dropped', txid(3)], ['tx', txid(4)]].sort());
  });
  await scene(async ({ srv, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    const t2 = srv.mk(2, { confirmed: false, to: [[A, 7000]] }); srv.add(A, t2); await go();
    srv.addrs[A] = srv.addrs[A].filter((t) => t !== t2);
    for (let i = 0; i < 26; i++) srv.add(A, srv.mk(100 + i, { height: 900100 + i, to: [[A, 100]] }));    // so many newer ones that it is not on the first page
    t2.status = { confirmed: true, block_height: 900002, block_time: 1793991000 }; srv.flags.tx404 = false;
    const r = await go();
    assert.ok(r.events.some((e) => e.type === 'confirmed' && e.txid === txid(2) && e.height === 900002), 'found by asking for the transaction itself');
    assert.ok(!r.events.some((e) => e.type === 'dropped'));
  });
});

test('more new transactions than a page holds say so instead of pretending', async () => {
  await scene(async ({ srv, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    for (let i = 0; i < 30; i++) srv.add(A, srv.mk(100 + i, { height: 900100 + i, to: [[A, 100 + i]] }));
    const r = await go();
    assert.deepEqual([types(r)[0], r.events.filter((e) => e.type === 'tx').length], ['gap', 25]);
  });
});

test('a failing server is said once, not at every check, and recovery is said once; a wallet that could not be read at first is started when it can be', async () => {
  await scene(async ({ srv, files, go }) => {
    srv.flags.fail = 1;
    const first = await go();
    assert.deepEqual([types(first), first.failed], [['error'], [A]]);
    assert.ok(/HTTP 500/.test(first.events[0].message));
    assert.equal((await go()).events.length, 0, 'still failing: not repeated');
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    srv.flags.fail = 0;
    const back = await go();
    assert.deepEqual(types(back), ['recovered', 'start'], 'it was never started, so it starts now');
    srv.flags.fail = 1;
    assert.deepEqual(types(await go()), ['error']);
    srv.flags.fail = 0;
    assert.deepEqual(types(await go()), ['recovered']);
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});

test('the loop waits longer and longer while the server fails, honours a retry-after, and goes back to normal', async () => {
  await scene(async ({ srv, go }) => {
    const sleeps = [];
    srv.flags.fail = 1;
    await go({ once: false, maxCycles: 3, every: 10, sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(sleeps, [20000, 40000], 'twice as long, then four times');
    srv.flags.fail = 0; srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    sleeps.length = 0;
    await go({ once: false, maxCycles: 3, every: 10, sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(sleeps, [10000, 10000]);
  });
  const waits = [];
  const limited = () => ({ ok: false, status: 429, headers: { get: () => '90' }, json: async () => ({}) });
  await Mon.run({ wallets: [A], api: 'http://x/api', log: path.join(os.tmpdir(), 'hm-' + process.pid + '.jsonl'), state: path.join(os.tmpdir(), 'hm-' + process.pid + '.json'), once: false, maxCycles: 2, every: 10, quiet: true, delay: 0, out: () => {}, sleep: async (ms) => { waits.push(ms); }, fetch: async () => limited() });
  assert.ok(waits[0] >= 90000, 'the server asked for 90 seconds: ' + waits[0]);
  fs.rmSync(path.join(os.tmpdir(), 'hm-' + process.pid + '.jsonl'), { force: true }); fs.rmSync(path.join(os.tmpdir(), 'hm-' + process.pid + '.json'), { force: true });
});

test('--blockcypher adds when BlockCypher first saw the transaction and the peer, says no record plainly, and a limit does not stop anything', async () => {
  await scene(async ({ srv, go, clock }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go({ blockcypher: true });
    const sleeps = [];
    srv.add(A, srv.mk(2, { confirmed: false, to: [[A, 7000]] }));
    srv.bc[txid(2)] = { hash: txid(2), received: '2026-03-04T10:21:32.652Z', relayed_by: '203.0.113.9:8333', confirmed: '2026-03-04T10:24:49Z' };
    const r = await go({ blockcypher: true, delay: 400, sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(r.events[0].blockcypher, { seen: true, received: Date.parse('2026-03-04T10:21:32.652Z') / 1000, relay: '203.0.113.9:8333' });
    assert.ok(sleeps.some((ms) => ms >= 1000), 'a pause after asking BlockCypher');
    srv.add(A, srv.mk(3, { confirmed: false, to: [[A, 1000]] }));
    srv.bc[txid(3)] = { hash: txid(3), received: '2026-03-04T10:24:49Z', confirmed: '2026-03-04T10:24:49Z' };
    assert.deepEqual((await go({ blockcypher: true })).events[0].blockcypher, { seen: false }, 'its time equal to the block time is no record');
    srv.add(A, srv.mk(4, { confirmed: false, to: [[A, 1000]] }));
    srv.flags.bcStatus = 429;
    const limited = await go({ blockcypher: true });
    assert.deepEqual([limited.events[0].type, limited.events[0].blockcypher, limited.events[0].txid], ['tx', { error: 'limit' }, txid(4)]);
    srv.add(A, srv.mk(5, { confirmed: false, to: [[A, 1000]] })); srv.hits.bc.length = 0;
    await go();
    assert.equal(srv.hits.bc.length, 0, 'and without the flag nothing is asked');
  });
});

test('--on-event runs the command for each event with the event on its input, and a command that fails stops nothing', async () => {
  await scene(async ({ srv, dir, files, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    const sink = path.join(dir, 'got.txt'), script = path.join(dir, 'save.js');
    fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').appendFileSync(" + JSON.stringify(sink) + ",process.env.HOPLINE_EVENT+' '+process.env.HOPLINE_TXID+' '+s));");
    srv.add(A, srv.mk(2, { confirmed: false, to: [[A, 7000]] }));
    const r = await go({ onEvent: '"' + process.execPath + '" "' + script + '"' });
    const lines = fs.readFileSync(sink, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('tx ' + txid(2) + ' {') && JSON.parse(lines[0].slice(lines[0].indexOf('{'))).hash === r.events[0].hash, 'the whole event, as it is in the log');
    srv.add(A, srv.mk(3, { confirmed: false, to: [[A, 1000]] }));
    const bad = await go({ onEvent: '"' + process.execPath + '" -e "process.exit(3)"' });
    assert.deepEqual(types(bad), ['tx']);
    srv.add(A, srv.mk(4, { confirmed: false, to: [[A, 1000]] }));
    assert.deepEqual(types(await go({ onEvent: 'no-such-command-hopline' })), ['tx'], 'a command that does not exist is a message, not a stop');
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});

test('verify: a changed, removed, inserted or garbled line breaks the chain from there and says where', async () => {
  await scene(async ({ srv, files, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    for (let i = 2; i <= 4; i++) { srv.add(A, srv.mk(i, { confirmed: false, to: [[A, 1000 * i]] })); await go(); }
    const good = fs.readFileSync(files.log, 'utf8'), lines = good.trim().split('\n');
    assert.deepEqual(Mon.verifyLog(files.log), { ok: true, lines: 4, broken: null });
    const bad = (text) => { fs.writeFileSync(files.log, text); return Mon.verifyLog(files.log); };
    const edited = lines.slice(); edited[2] = edited[2].replace('"in":3000', '"in":9000');
    assert.deepEqual(bad(edited.join('\n') + '\n').broken, { line: 3, why: 'its hash does not match what it says (the line was changed)' });
    assert.equal(bad(lines.filter((_, i) => i !== 2).join('\n') + '\n').broken.line, 3, 'a removed line shows at the next');
    assert.equal(bad([lines[0], lines[1], lines[1], lines[2]].join('\n') + '\n').broken.line, 3, 'an inserted copy');
    assert.equal(bad(lines.slice(0, 2).concat(['not json'], lines.slice(3)).join('\n') + '\n').broken.why, 'not JSON');
    assert.deepEqual(bad(''), { ok: true, lines: 0, broken: null });
    fs.writeFileSync(files.log, good);
    const cli = spawnSync(process.execPath, [TOOL, 'verify', files.log], { encoding: 'utf8' });
    assert.deepEqual([cli.status, cli.stdout.trim()], [0, 'OK: 4 lines, the chain is unbroken.']);
    fs.writeFileSync(files.log, edited.join('\n') + '\n');
    const broken = spawnSync(process.execPath, [TOOL, 'verify', files.log], { encoding: 'utf8' });
    assert.deepEqual([broken.status, broken.stdout.startsWith('BROKEN at line 3 of 4')], [1, true]);
  });
});

test('list and txids: the log as text, and each transaction id once, for pasting into Hopline', async () => {
  await scene(async ({ srv, files, go }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] }));
    await go();
    srv.add(A, srv.mk(2, { confirmed: false, to: [[A, 7000]] })); await go();
    srv.addrs[A] = [srv.mk(2, { height: 900050, to: [[A, 7000]] }), ...srv.addrs[A].filter((t) => t.txid !== txid(2))]; await go();
    const text = Mon.listLog(files.log).trim().split('\n');
    assert.equal(text.length, 3);
    assert.ok(/START 0\.00010000 BTC confirmed, 1 transactions$/.test(text[0]) && /NEW 02020202…02020202 in 0\.00007000 BTC \(unconfirmed\)$/.test(text[1]) && /CONFIRMED 02020202…02020202 in block 900050$/.test(text[2]), text.join('\n'));
    assert.deepEqual(Mon.txidsOf(files.log), [txid(2)]);
    const cli = spawnSync(process.execPath, [TOOL, 'txids', files.log], { encoding: 'utf8' });
    assert.deepEqual([cli.status, cli.stdout], [0, txid(2) + '\n']);
    const ls = spawnSync(process.execPath, [TOOL, 'list', files.log], { encoding: 'utf8' });
    assert.deepEqual([ls.status, ls.stdout.trim().split('\n').length], [0, 3]);
    assert.equal(spawnSync(process.execPath, [TOOL, 'list', files.log + '.nope'], { encoding: 'utf8' }).status, 2);
  });
});

test('the command line: wallets from a file and from --address, and every mistake is said before anything is asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-monitor-args-')), file = path.join(dir, 'w.txt');
  fs.writeFileSync(file, '# my wallets\n' + A.toUpperCase() + '   # a comment\n\n' + A + '\n1BoatSLRHtKNngkdXEeobR76b53LETtpyT\n');
  try {
    const o = Mon.parseArgs(['--wallets', file, '--address', B, '--address', A, '--every', '30', '--api', 'http://localhost:3000/api', '--on-event', 'echo hi', '--blockcypher', '--once', '--quiet']);
    assert.deepEqual(o.wallets, [A, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', B], 'bech32 in lower case, once, in the order given');
    assert.deepEqual([o.every, o.api, o.onEvent, o.blockcypher, o.once, o.quiet], [30, 'http://localhost:3000/api', 'echo hi', true, true, true]);
    const d = Mon.parseArgs(['--address', A]);
    assert.deepEqual([d.every, d.api, d.log, d.state, d.blockcypher, d.once], [60, 'https://mempool.space/api', 'hopline-events.jsonl', 'hopline-monitor-state.json', false, false]);
    const err = (args) => Mon.parseArgs(args).error;
    assert.match(err([]), /No wallets/);
    assert.match(err(['--address', 'not an address']), /Not an address: not an address/);
    assert.match(err(['--address', A, '--every', '5']), /at least 10/);
    assert.match(err(['--address', A, '--every', 'soon']), /at least 10/);
    assert.match(err(['--address', A, '--api', 'ftp://x']), /--api must be a URL/);
    assert.match(err(['--address', A, '--frobnicate']), /Unknown option --frobnicate/);
    assert.match(err(['--address', A, '--log']), /--log needs a value/);
    assert.match(err(['--wallets', path.join(dir, 'nope.txt')]), /Cannot read/);
    fs.writeFileSync(file, A + '\nhello\n');
    assert.match(err(['--wallets', file]), /Not an address in .*w\.txt: hello/);
    assert.deepEqual([Mon.cleanAddress(' ' + A.toUpperCase() + ' '), Mon.cleanAddress('bc1q'), Mon.cleanAddress(null), Mon.cleanAddress('0x' + 'a'.repeat(40))], [A, null, null, null]);
    const run = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
    assert.deepEqual([run.status, /No wallets/.test(run.stderr), /Usage:/.test(run.stderr)], [2, true, true]);
    assert.equal(spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run from the command line against a server: one pass with --once writes the log and the state, and a second pass repeats nothing', async () => {
  await scene(async ({ srv, dir, files }) => {
    srv.add(A, srv.mk(1, { height: 900001, to: [[A, 10000]] })); srv.add(B, srv.mk(2, { confirmed: false, to: [[B, 5000]] }));
    const wallets = path.join(dir, 'w.txt'); fs.writeFileSync(wallets, A + '\n' + B + '\n');
    const pass = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [TOOL, '--wallets', wallets, '--api', srv.base + '/api', '--log', files.log, '--state', files.state, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', (code) => resolve({ code, out }));
    });
    const one = await pass();
    assert.equal(one.code, 0);
    assert.ok(/Watching 2 wallets every 60 s/.test(one.out) && /START/.test(one.out) && /NEW .* \[already there at the start\]/.test(one.out), one.out);
    const two = await pass();
    assert.deepEqual([two.code, Mon.readEvents(files.log).length], [0, 3], 'start, start, and the waiting transaction: nothing more');
    assert.equal(Mon.verifyLog(files.log).ok, true);
  });
});
