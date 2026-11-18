'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Tg = require('../tools/telegram-notify.js');
const Mon = require('../tools/hopline-monitor.js');

const TOOL = path.join(__dirname, '..', 'tools', 'telegram-notify.js');
const A = 'bc1q' + 'a'.repeat(38), B = 'bc1q' + 'b'.repeat(38), OLD = '1' + 'A'.repeat(33);
const TX = 'ab'.repeat(32), TOKEN = '123456:TESTTOKEN', CHAT = '-100987';
const AT = '2026-11-18T12:00:00.000Z';
const ev = (o) => Object.assign({ type: 'tx', at: AT, seenAt: 1795000000, wallet: A, txid: TX, status: 'unconfirmed', in: 0, out: 0, fee: 1420, n: 7 }, o);
const link = (kind, id) => new RegExp('<a href="https://mempool\\.space/' + kind + '/' + id + '">');      // a regex, never a substring test on a URL

/** A made-up Telegram: it keeps what it is sent and answers with what the test queued (200 when nothing is queued). */
function makeTelegram() {
  const got = [], answers = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const a = answers.shift() || { status: 200, body: { ok: true } };
      res.statusCode = a.status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(a.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ got, answers, base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-telegram-')); }
function cleanEnv(extra) {
  const e = Object.assign({}, process.env); ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API', 'HOPLINE_WALLETS'].forEach((k) => { delete e[k]; });
  return Object.assign(e, extra);
}
/** Run the notifier as the monitor does: the event on its input, the settings in the environment. */
function run(input, env, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL].concat(args || []), { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, out, err }));
    c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input) + '\n');
  });
}
const settings = (tg, extra) => Object.assign({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API: tg.base }, extra);

test('a payment says what came in or went out, where, when it was first seen and what it cost, with links to the explorer', () => {
  const got = Tg.message(ev({ in: 90000 }), {});
  assert.match(got, /^🟢 <b>Received 0\.00090000 BTC<\/b>/);
  assert.match(got, link('address', A)); assert.match(got, link('tx', TX));
  assert.match(got, /Unconfirmed, in the mempool/); assert.match(got, /First seen: 2026-11-18 \d\d:\d\d:\d\d UTC/); assert.match(got, /Fee: 1420 sats/);
  assert.match(got, /<i>2026-11-18 12:00:00 UTC · event #7<\/i>$/);
  assert.match(Tg.message(ev({ out: 100000 }), {}), /^🔴 <b>Sent 0\.00100000 BTC<\/b>/);
  const change = Tg.message(ev({ in: 10000, out: 100000 }), {});
  assert.match(change, /Sent 0\.00090000 BTC/); assert.match(change, /Spent 0\.00100000 BTC, received back 0\.00010000 BTC/);
  assert.match(Tg.message(ev({ status: 'confirmed', height: 900123, blockTime: 1795000000, in: 5 }), {}), /Confirmed in block 900123 \(2026-11-18 11:06:40 UTC\)/);
  assert.match(Tg.message(ev({ in: 5, baseline: true }), {}), /Already unconfirmed when monitoring of this wallet began/);
  assert.match(Tg.message(ev({ in: 5, blockcypher: { seen: true, received: 1795000000, relay: '203.0.113.9:8333' } }), {}), /BlockCypher first saw it: 2026-11-18 11:06:40 UTC via 203\.0\.113\.9:8333/);
  assert.doesNotMatch(Tg.message(ev({ in: 5, blockcypher: { seen: false } }), {}), /BlockCypher/);
});

test('the other events: start with the balance, confirmation, dropped, gap, error, recovered; and an event it does not know is still a message', () => {
  assert.match(Tg.message({ type: 'start', at: AT, wallet: A, confirmed: 150000000, unconfirmed: 2000, txCount: 12, n: 1 }, {}), /Now watching[\s\S]*Balance: 1\.50000000 BTC \(\+0\.00002000 BTC unconfirmed\)[\s\S]*12 transactions so far/);
  assert.doesNotMatch(Tg.message({ type: 'start', at: AT, wallet: A, confirmed: 5, txCount: 1, n: 1 }, {}), /unconfirmed\)/);
  const c = Tg.message({ type: 'confirmed', at: AT, wallet: A, txid: TX, height: 900200, blockTime: 1795000000, n: 2 }, {});
  assert.match(c, /✅ <b>Confirmed in block 900200<\/b>/); assert.match(c, link('tx', TX)); assert.match(c, /Block time: 2026-11-18 11:06:40 UTC/);
  assert.match(Tg.message({ type: 'dropped', at: AT, wallet: A, txid: TX, n: 3 }, {}), /Left the mempool unconfirmed/);
  assert.match(Tg.message({ type: 'gap', at: AT, wallet: A, n: 4 }, {}), /More than 25 new transactions/);
  assert.match(Tg.message({ type: 'error', at: AT, wallet: A, message: 'HTTP 500 for /address/<x> & more', n: 5 }, {}), /❌ <b>Monitor error<\/b>[\s\S]*HTTP 500 for \/address\/&lt;x&gt; &amp; more/);
  assert.match(Tg.message({ type: 'recovered', at: AT, wallet: A, n: 6 }, {}), /Reading this wallet again/);
  assert.match(Tg.message({ type: 'skipped', at: AT, line: 7, n: 9 }, {}), /⚠️ <b>Line 7 of the wallets file is not an address<\/b>\nIt is not being watched; the other wallets are\./);
  assert.match(Tg.message({ type: 'something-new', at: AT, n: 8 }, {}), /^something-new/);
  assert.doesNotThrow(() => Tg.message({ type: 'tx', n: 1 }, {}), 'an event without a time or a wallet does not break it');
});

test('the name after # in the wallets file is shown with the wallet, whatever the case of the address, and is read again every time', () => {
  const dir = tmp(), file = path.join(dir, 'wallets.txt');
  try {
    fs.writeFileSync(file, '# my wallets\n' + A.toUpperCase() + '   # Savings (cold)\n' + B + '\n' + OLD + '# Old <donation> & more # really\n\n');
    const n = Tg.names(file);
    assert.deepEqual(n, { [A]: 'Savings (cold)', [OLD]: 'Old <donation> & more # really' }, 'a line without # has no name, a full-line comment is no address, bech32 is lower case');
    assert.match(Tg.message(ev({ in: 1 }), n), /<b>Savings \(cold\)<\/b>\n<a href=/);
    assert.match(Tg.message(ev({ wallet: OLD, in: 1 }), n), /<b>Old &lt;donation&gt; &amp; more # really<\/b>/);
    assert.doesNotMatch(Tg.message(ev({ wallet: B, in: 1 }), n), /<b>(?!Received)/, 'no name, no bold line');
    fs.writeFileSync(file, A + ' # Renamed\n');
    assert.deepEqual(Tg.names(file), { [A]: 'Renamed' });
    assert.deepEqual(Tg.names(path.join(dir, 'missing.txt')), {}); assert.deepEqual(Tg.names(undefined), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('it posts the message to the chat as HTML without a link preview, with the token in the path and never in the text', async () => {
  const tg = await makeTelegram(), dir = tmp(), wallets = path.join(dir, 'wallets.txt');
  try {
    fs.writeFileSync(wallets, A + ' # Savings\n');
    const r = await run(ev({ in: 90000 }), settings(tg, { HOPLINE_WALLETS: wallets }));
    assert.deepEqual([r.code, r.err], [0, '']);
    assert.equal(tg.got.length, 1);
    assert.deepEqual([tg.got[0].method, tg.got[0].url], ['POST', '/bot' + TOKEN + '/sendMessage']);
    assert.deepEqual([tg.got[0].body.chat_id, tg.got[0].body.parse_mode, tg.got[0].body.disable_web_page_preview], [CHAT, 'HTML', true]);
    assert.match(tg.got[0].body.text, /Received 0\.00090000 BTC/); assert.match(tg.got[0].body.text, /<b>Savings<\/b>/);
    assert.equal(tg.got[0].body.text.indexOf(TOKEN), -1);
  } finally { await tg.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a rate limit is waited out and the message goes through; one that never lets up gives up after three tries', async () => {
  const tg = await makeTelegram();
  try {
    tg.answers.push({ status: 429, body: { ok: false, parameters: { retry_after: 0 } } });
    const ok = await run(ev({ in: 1 }), settings(tg));
    assert.deepEqual([ok.code, tg.got.length], [0, 2]);
    tg.got.length = 0;
    for (let i = 0; i < 3; i++) tg.answers.push({ status: 429, body: { ok: false, parameters: { retry_after: 0 } } });
    const no = await run(ev({ in: 1 }), settings(tg));
    assert.equal(no.code, 1); assert.equal(tg.got.length, 3); assert.match(no.err, /rate-limiting/);
  } finally { await tg.close(); }
});

test('what goes wrong is said on stderr with a non-zero exit, once, and the token is not in it', async () => {
  const tg = await makeTelegram();
  try {
    tg.answers.push({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    const bad = await run(ev({ in: 1 }), settings(tg));
    assert.equal(bad.code, 1); assert.match(bad.err, /telegram-notify: Telegram answered HTTP 401: Unauthorized/); assert.equal(tg.got.length, 1, 'a wrong token is not tried again');
    assert.equal(bad.err.indexOf(TOKEN), -1);
    tg.answers.push({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } });
    assert.match((await run(ev({ in: 1 }), settings(tg))).err, /chat not found/);
    tg.answers.push({ status: 404, body: { ok: false, description: 'Not Found: ' + TOKEN } });
    const echoed = await run(ev({ in: 1 }), settings(tg));
    assert.equal(echoed.err.indexOf(TOKEN), -1, 'a reply that repeats the token does not put it in a log'); assert.match(echoed.err, /Not Found: \*\*\*/);
    tg.got.length = 0;
    const none = await run(ev({ in: 1 }), { TELEGRAM_API: tg.base });
    assert.equal(none.code, 1); assert.match(none.err, /TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set/); assert.equal(tg.got.length, 0);
    const junk = await run('not json', settings(tg));
    assert.equal(junk.code, 1); assert.match(junk.err, /not JSON/); assert.equal(tg.got.length, 0);
  } finally { await tg.close(); }
  const down = await run(ev({ in: 1 }), { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API: 'http://127.0.0.1:1' });
  assert.equal(down.code, 1); assert.equal(down.err.indexOf(TOKEN), -1, 'a server that cannot be reached is a message too, without the token');
});

test('--dry prints the message instead of sending it, and needs no token', async () => {
  const tg = await makeTelegram();
  try {
    const r = await run(ev({ out: 2000 }), { TELEGRAM_API: tg.base }, ['--dry']);
    assert.equal(r.code, 0); assert.match(r.err, /Sent 0\.00002000 BTC/); assert.equal(tg.got.length, 0);
  } finally { await tg.close(); }
});

test('the monitor runs it for each event: a new wallet, a payment and its confirmation arrive as three messages, named from the wallets file', async () => {
  const tg = await makeTelegram(), dir = tmp(), wallets = path.join(dir, 'wallets.txt');
  const saved = {}; ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API', 'HOPLINE_WALLETS'].forEach((k) => { saved[k] = process.env[k]; });
  Object.assign(process.env, settings(tg, { HOPLINE_WALLETS: wallets }));
  try {
    fs.writeFileSync(wallets, A + '   # Savings\n');
    const tx = (confirmed, inn) => ({ txid: TX, fee: 300, status: confirmed ? { confirmed: true, block_height: 900300, block_time: 1795000000 } : { confirmed: false }, vin: [{ prevout: { scriptpubkey_address: B, value: inn + 300 } }], vout: [{ scriptpubkey_address: A, value: inn }] });
    let phase = 0;
    const chain = () => [
      { stats: { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } }, txs: [] },
      { stats: { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 1, funded_txo_sum: 40000, spent_txo_sum: 0 } }, txs: [tx(false, 40000)] },
      { stats: { chain_stats: { tx_count: 1, funded_txo_sum: 40000, spent_txo_sum: 0 }, mempool_stats: { tx_count: 0 } }, txs: [tx(true, 40000)] },
    ][phase];
    const fetchFake = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (/\/txs$/.test(url) ? chain().txs : chain().stats) });
    const go = () => Mon.run({ wallets: [A], log: path.join(dir, 'events.jsonl'), state: path.join(dir, 'state.json'), once: true, quiet: true, delay: 0, fetch: fetchFake, out: () => {}, onEvent: '"' + process.execPath + '" "' + TOOL + '"' });
    for (phase = 0; phase < 3; phase++) await go();
    assert.equal(Mon.verifyLog(path.join(dir, 'events.jsonl')).ok, true);
    assert.equal(tg.got.length, 3);
    const texts = tg.got.map((g) => g.body.text);
    assert.equal(texts.filter((t) => /Now watching/.test(t)).length, 1);
    assert.equal(texts.filter((t) => /Received 0\.00040000 BTC/.test(t) && /Unconfirmed/.test(t)).length, 1);
    assert.equal(texts.filter((t) => /Confirmed in block 900300/.test(t)).length, 1);
    assert.ok(texts.every((t) => /<b>Savings<\/b>/.test(t)), 'every message carries the name from the wallets file');
  } finally {
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    await tg.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
