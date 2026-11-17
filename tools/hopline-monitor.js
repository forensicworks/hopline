#!/usr/bin/env node
'use strict';
/*
 * Hopline monitor: watch some Bitcoin wallets from any machine and keep a time-stamped, tamper-evident log of what happens to them.
 *
 *   node hopline-monitor.js --wallets wallets.txt [--every 60] [--log events.jsonl] [--state state.json] [--on-event "command"] [--blockcypher] [--once]
 *   node hopline-monitor.js --address bc1q... --address 1A1z...
 *   node hopline-monitor.js list events.jsonl     the events as text
 *   node hopline-monitor.js txids events.jsonl    the transaction ids, one a line, to paste into Hopline's Add box (ten at a time)
 *   node hopline-monitor.js verify events.jsonl   check that the log has not been changed
 *
 * One file and no packages: copy it to a server, a Raspberry Pi or another laptop that has Node 18 or later, and leave it running (or run it from cron or the Windows Task Scheduler with --once).
 * It asks an Esplora API (mempool.space by default, or your own with --api) about each wallet's totals; when they change it reads the newest transactions and writes one line to the log for each new
 * one (and for each that gets confirmed), then runs your command if you gave one. It remembers what it has seen in the state file, so stopping and starting it misses nothing and repeats nothing.
 *
 * What the time in an event means: `at` is this machine's clock when the event was written, and `seenAt` the same moment in seconds: the first time THIS PROGRAM saw the transaction, which is never earlier than
 * the interval between two checks before it was sent. Keep the clock right (NTP). A transaction's block time is only the time of its block. With --blockcypher each new transaction's id is also sent to BlockCypher,
 * which says when it first saw it and which peer passed it on: that is a third party, so it is off unless you ask for it.
 *
 * What the log is: JSON lines. Each line has `prev` (the hash of the line before) and `hash` (the SHA-256 of the line without `hash`, which includes `prev`), so a changed, removed or inserted line breaks the chain from
 * there on, and `verify` says where. That shows the log was not edited afterwards; it does not show the clock was right.
 *
 * Privacy: the API sees the wallets you ask about, from this machine's address. Use your own Esplora (--api) when that matters.
 */
const fs = require('fs'), crypto = require('crypto'), cp = require('child_process');

const DEFAULT_API = 'https://mempool.space/api';
const BLOCKCYPHER_API = 'https://api.blockcypher.com/v1/btc/main';
const ZERO = '0'.repeat(64);
const MIN_EVERY = 10, PAGE = 25, SEEN_CAP = 3000;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function btc(sats) { return (sats / 1e8).toFixed(8) + ' BTC'; }
function iso(ms) { return new Date(ms).toISOString(); }
function short(s, n) { s = String(s || ''); return s.length > n * 2 + 1 ? s.slice(0, n) + '…' + s.slice(-n) : s; }

// ---- wallets ------------------------------------------------------------------------------------------------------------------------------------
/** A wallet address as the API wants it (bech32 lower case), or null when it is not an address. */
function cleanAddress(a) {
  a = String(a == null ? '' : a).trim();
  if (/^bc1[0-9a-z]{6,87}$/i.test(a)) return a.toLowerCase();
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) return a;
  return null;
}
/** The addresses of a text file: one a line, anything after # ignored, blank lines and repeats dropped. Returns { list, bad: [line] }. */
function parseWallets(text) {
  var list = [], bad = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var t = line.replace(/#.*$/, '').trim(); if (!t) return;
    var a = cleanAddress(t); if (!a) { bad.push(t); return; }
    if (list.indexOf(a) < 0) list.push(a);
  });
  return { list: list, bad: bad };
}

// ---- the log ----------------------------------------------------------------------------------------------------------------------------------
/** The hash of a line: SHA-256 of the line without its own hash. The line holds the hash of the line before it (`prev`), so each hash depends on all that came before. */
function lineHash(body) { return sha256(JSON.stringify(body)); }
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return l.trim(); });
}
/** { n, hash } of the last line of a log (or the start of an empty one). */
function logTail(file) {
  var lines = readLines(file); if (!lines.length) return { n: 0, hash: ZERO };
  try { var e = JSON.parse(lines[lines.length - 1]); return { n: e.n || lines.length, hash: e.hash || ZERO }; } catch (e) { return { n: lines.length, hash: ZERO }; }
}
/** Append an event: it gets its number, the hash of the line before and its own hash. Returns the line as written. */
function appendEvent(file, tail, ev) {
  var body = Object.assign({ n: tail.n + 1 }, ev, { prev: tail.hash });
  var hash = lineHash(body), line = Object.assign({}, body, { hash: hash });
  fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
  tail.n = body.n; tail.hash = hash;
  return line;
}
/** Check the chain of a log: { ok, lines, broken: null | { line, why } }. */
function verifyLog(file) {
  var lines = readLines(file), prev = ZERO;
  for (var i = 0; i < lines.length; i++) {
    var e; try { e = JSON.parse(lines[i]); } catch (x) { return { ok: false, lines: lines.length, broken: { line: i + 1, why: 'not JSON' } }; }
    if (e.prev !== prev) return { ok: false, lines: lines.length, broken: { line: i + 1, why: 'it does not follow the line before it (a line was removed, inserted or changed)' } };
    var h = e.hash, body = Object.assign({}, e); delete body.hash;
    if (lineHash(body) !== h) return { ok: false, lines: lines.length, broken: { line: i + 1, why: 'its hash does not match what it says (the line was changed)' } };
    prev = h;
  }
  return { ok: true, lines: lines.length, broken: null };
}
function readEvents(file) { return readLines(file).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }

/** One event as a line of text. */
function describe(e) {
  var t = e.at ? e.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
  var w = e.wallet ? ' ' + short(e.wallet, 8) : '';
  switch (e.type) {
    case 'start': return t + w + ' START ' + btc(e.confirmed || 0) + ' confirmed' + (e.unconfirmed ? ', ' + btc(e.unconfirmed) + ' unconfirmed' : '') + ', ' + e.txCount + ' transactions';
    case 'tx': return t + w + ' NEW ' + short(e.txid, 8) + ' ' + (e.in ? 'in ' + btc(e.in) : '') + (e.in && e.out ? ', ' : '') + (e.out ? 'out ' + btc(e.out) : '') + ' (' + e.status + (e.height ? ' in block ' + e.height : '') + ')' + (e.baseline ? ' [already there at the start]' : '')
      + (e.blockcypher && e.blockcypher.seen ? ' [BlockCypher first saw it ' + iso(Math.floor(e.blockcypher.received * 1000)).replace('T', ' ').replace(/\.\d+Z$/, 'Z') + (e.blockcypher.relay ? ' via ' + e.blockcypher.relay : '') + ']' : '');
    case 'confirmed': return t + w + ' CONFIRMED ' + short(e.txid, 8) + ' in block ' + e.height;
    case 'dropped': return t + w + ' DROPPED ' + short(e.txid, 8) + ' left the mempool without being confirmed (replaced, or evicted)';
    case 'gap': return t + w + ' GAP more than ' + PAGE + ' new transactions since the last check: the older ones were not read';
    case 'error': return t + w + ' ERROR ' + e.message;
    case 'recovered': return t + w + ' OK again';
    default: return t + ' ' + e.type;
  }
}
function listLog(file) { return readEvents(file).map(describe).join('\n') + '\n'; }
/** The transaction ids in a log, oldest first, each once. */
function txidsOf(file) { var seen = {}, out = []; readEvents(file).forEach(function (e) { if (e.txid && !seen[e.txid]) { seen[e.txid] = 1; out.push(e.txid); } }); return out; }

// ---- the network --------------------------------------------------------------------------------------------------------------------------------
async function getJson(ctx, url) {
  var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000);
  try {
    var res = await ctx.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'hopline-monitor', Connection: 'close' }, signal: ctl.signal });
    if (res.status === 429) { var e = new Error('rate limit (HTTP 429)'); e.rate = true; e.retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0; throw e; }
    if (!res.ok) { var err = new Error('HTTP ' + res.status + ' for ' + url.replace(/^https?:\/\/[^/]+/, '')); err.status = res.status; throw err; }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout for ' + url.replace(/^https?:\/\/[^/]+/, ''));
    throw e;
  } finally { clearTimeout(timer); }
}
/** What changed for the wallet is read from its totals: the same numbers say "nothing happened" in one request. */
function fingerprint(s) {
  var c = (s && s.chain_stats) || {}, m = (s && s.mempool_stats) || {};
  return [c.tx_count, c.funded_txo_sum, c.spent_txo_sum, m.tx_count, m.funded_txo_sum, m.spent_txo_sum].map(function (v) { return v == null ? '' : String(v); }).join('|');
}
/** What a transaction did to a wallet: sats paid to it (in) and sats of its own that were spent (out). */
function effect(tx, wallet) {
  var inn = 0, out = 0;
  (tx.vout || []).forEach(function (o) { if (o.scriptpubkey_address === wallet) inn += o.value || 0; });
  (tx.vin || []).forEach(function (v) { if (v.prevout && v.prevout.scriptpubkey_address === wallet) out += v.prevout.value || 0; });
  return { in: inn, out: out };
}
async function blockcypherOf(ctx, txid) {
  try {
    var j = await getJson(ctx, ctx.blockcypher + '/txs/' + txid + '?limit=1');
    var received = Date.parse(j.received) / 1000, confirmed = Date.parse(j.confirmed) / 1000, relay = typeof j.relayed_by === 'string' ? j.relayed_by : '';
    var seen = isFinite(received) && (relay !== '' || received !== confirmed);
    return seen ? { seen: true, received: received, relay: relay } : { seen: false };
  } catch (e) { return { error: e.rate ? 'limit' : String(e.message).slice(0, 120) }; }
}

// ---- one check of one wallet -------------------------------------------------------------------------------------------------------------------
function emit(ctx, ev) {
  var line = appendEvent(ctx.log, ctx.tail, ev);
  if (!ctx.quiet || ev.type === 'error' || ev.type === 'gap') ctx.out(describe(line));
  ctx.events.push(line);
  if (ctx.onEvent) runCommand(ctx, line);
  return line;
}
function runCommand(ctx, ev) {
  try {
    var child = cp.spawn(ctx.onEvent, { shell: true, stdio: ['pipe', 'ignore', 'inherit'], env: Object.assign({}, process.env, { HOPLINE_EVENT: ev.type, HOPLINE_WALLET: ev.wallet || '', HOPLINE_TXID: ev.txid || '', HOPLINE_N: String(ev.n) }) });
    child.on('error', function (e) { ctx.out('on-event command failed to start: ' + e.message); });
    child.stdin.on('error', function () {});
    child.stdin.end(JSON.stringify(ev) + '\n');
    var timer = setTimeout(function () { try { child.kill(); } catch (e) { /* gone */ } }, 30000); child.on('exit', function () { clearTimeout(timer); });
    ctx.children.push(new Promise(function (r) { child.on('exit', r); child.on('error', r); }));
  } catch (e) { ctx.out('on-event command failed: ' + e.message); }
}

/** Check one wallet: write the events for what is new in it, and update what is remembered. */
async function checkWallet(ctx, wallet) {
  var st = ctx.state.wallets[wallet], now = ctx.now(), at = iso(now), seenAt = Math.floor(now / 1000);
  try {
    var stats = await getJson(ctx, ctx.api + '/address/' + encodeURIComponent(wallet)), fp = fingerprint(stats);
    var c = stats.chain_stats || {}, m = stats.mempool_stats || {};
    if (!st) {                                                                                   // the first look: what is there now is the starting point
      var first = await getJson(ctx, ctx.api + '/address/' + encodeURIComponent(wallet) + '/txs');
      st = { fp: fp, seen: first.map(function (tx) { return tx.txid; }), pending: {} };         // remembered only once everything was read: a failure above leaves the wallet to be looked at again
      ctx.state.wallets[wallet] = st;
      noteRecovered(ctx, wallet, at);
      emit(ctx, { type: 'start', at: at, wallet: wallet, api: ctx.apiHost, confirmed: (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0), unconfirmed: (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0), txCount: c.tx_count || 0 });
      for (var i = 0; i < first.length; i++) {
        var tx = first[i]; if (tx.status && tx.status.confirmed) continue;                       // an unconfirmed one is news even now, and its confirmation will be too
        st.pending[tx.txid] = seenAt;
        await newTx(ctx, wallet, tx, at, seenAt, true);
      }
      return;
    }
    noteRecovered(ctx, wallet, at);
    if (st.fp === fp) return;                                                                    // nothing happened
    var page = await getJson(ctx, ctx.api + '/address/' + encodeURIComponent(wallet) + '/txs'), seen = new Set(st.seen);
    var fresh = page.filter(function (tx) { return !seen.has(tx.txid); });
    if (st.seen.length && page.length >= PAGE && fresh.length === page.length) emit(ctx, { type: 'gap', at: at, wallet: wallet });
    for (var j = fresh.length - 1; j >= 0; j--) {                                               // oldest first
      var t = fresh[j]; st.seen.push(t.txid);
      if (!(t.status && t.status.confirmed)) st.pending[t.txid] = seenAt;
      await newTx(ctx, wallet, t, at, seenAt, false);
    }
    var onPage = {}; page.forEach(function (tx) { onPage[tx.txid] = tx; });
    for (var id of Object.keys(st.pending)) {                                                    // the ones that were waiting: confirmed now, or gone
      var p = onPage[id];
      if (p && p.status && p.status.confirmed) { delete st.pending[id]; if (fresh.indexOf(p) < 0) emit(ctx, { type: 'confirmed', at: at, wallet: wallet, txid: id, height: p.status.block_height, blockTime: p.status.block_time }); }
      else if (!p && !(m.tx_count > 0)) {                                                       // not in the mempool any more and not on the first page: look at it itself
        var gone = null; try { gone = await getJson(ctx, ctx.api + '/tx/' + id); } catch (e) { if (e.status !== 404) throw e; }
        delete st.pending[id];
        if (gone && gone.status && gone.status.confirmed) emit(ctx, { type: 'confirmed', at: at, wallet: wallet, txid: id, height: gone.status.block_height, blockTime: gone.status.block_time });
        else emit(ctx, { type: 'dropped', at: at, wallet: wallet, txid: id });
      }
    }
    if (st.seen.length > SEEN_CAP) st.seen = st.seen.slice(-SEEN_CAP);
    st.fp = fp;
  } catch (e) {
    ctx.failed.push(wallet);
    if (e && e.rate && e.retryAfter) ctx.waitMore = Math.max(ctx.waitMore || 0, Math.min(e.retryAfter, 300));
    if (!ctx.state.errors[wallet]) { ctx.state.errors[wallet] = true; emit(ctx, { type: 'error', at: at, wallet: wallet, message: String(e.message).slice(0, 200) }); }     // said once, not at every check
  }
}
function noteRecovered(ctx, wallet, at) { if (ctx.state.errors[wallet]) { delete ctx.state.errors[wallet]; emit(ctx, { type: 'recovered', at: at, wallet: wallet }); } }
async function newTx(ctx, wallet, tx, at, seenAt, baseline) {
  var eff = effect(tx, wallet), confirmed = !!(tx.status && tx.status.confirmed);
  var ev = { type: 'tx', at: at, seenAt: seenAt, wallet: wallet, txid: tx.txid, status: confirmed ? 'confirmed' : 'unconfirmed', in: eff.in, out: eff.out, fee: typeof tx.fee === 'number' ? tx.fee : null };
  if (confirmed) { ev.height = tx.status.block_height; ev.blockTime = tx.status.block_time; }
  if (baseline) ev.baseline = true;
  if (ctx.blockcypher) { ev.blockcypher = await blockcypherOf(ctx, tx.txid); if (ctx.delay) await ctx.sleep(Math.max(ctx.delay, 1000)); }
  emit(ctx, ev);
}

// ---- the loop ---------------------------------------------------------------------------------------------------------------------------------
function loadState(file) {
  try { var s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && s.wallets) { s.errors = s.errors || {}; return s; } } catch (e) { /* none yet */ }
  return { version: 1, wallets: {}, errors: {} };
}
function saveState(file, state) {
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, wallets: state.wallets, errors: state.errors }), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

/**
 * Check every wallet, once or until stopped. options: { wallets, api, every (seconds), log, state, onEvent, blockcypher (true | false), blockcypherApi, once, quiet, delay (ms between wallets),
 * fetch, now, out, sleep, maxCycles, stop() }. Resolves { events, cycles, failed }.
 */
async function run(options) {
  var o = Object.assign({ api: DEFAULT_API, every: 60, log: 'hopline-events.jsonl', state: 'hopline-monitor-state.json', delay: 400, fetch: globalThis.fetch, now: Date.now, out: function (s) { console.log(s); }, sleep: sleep }, options);
  var ctx = { fetch: o.fetch, now: o.now, out: o.out, sleep: o.sleep, api: String(o.api).replace(/\/+$/, ''), blockcypher: o.blockcypher ? String(o.blockcypherApi || BLOCKCYPHER_API).replace(/\/+$/, '') : '', onEvent: o.onEvent || '',
              log: o.log, quiet: !!o.quiet, delay: o.delay, tail: logTail(o.log), state: loadState(o.state), events: [], children: [], failed: [], waitMore: 0 };
  try { ctx.apiHost = new URL(ctx.api).host; } catch (e) { ctx.apiHost = ctx.api; }
  var cycles = 0, bad = 0;
  for (;;) {
    ctx.failed = []; ctx.waitMore = 0;
    for (var i = 0; i < o.wallets.length; i++) {
      if (o.stop && o.stop()) break;
      await checkWallet(ctx, o.wallets[i]);
      if (i + 1 < o.wallets.length && o.delay) await o.sleep(o.delay);
    }
    saveState(o.state, ctx.state);
    cycles++;
    if (ctx.failed.length) bad = Math.min(bad + 1, 6); else bad = 0;
    if (o.once || (o.maxCycles && cycles >= o.maxCycles) || (o.stop && o.stop())) break;
    await o.sleep(Math.max(o.every * 1000 * Math.pow(2, bad), ctx.waitMore * 1000));            // a failing server is asked less and less often, up to 64 times as long
  }
  await Promise.all(ctx.children);
  return { events: ctx.events, cycles: cycles, failed: ctx.failed };
}

// ---- the command line ---------------------------------------------------------------------------------------------------------------------------
const USAGE = 'Usage:\n'
  + '  node hopline-monitor.js --wallets wallets.txt | --address ADDR [--address ADDR ...]   [--every SECONDS] [--log FILE] [--state FILE] [--api URL] [--on-event COMMAND] [--blockcypher] [--once] [--quiet]\n'
  + '  node hopline-monitor.js list FILE      the events as text\n  node hopline-monitor.js txids FILE     the transaction ids, one a line\n  node hopline-monitor.js verify FILE    check that the log was not changed\n'
  + 'Wallets: one address a line in the file (anything after # is ignored). --every is at least ' + MIN_EVERY + ' seconds (default 60). --blockcypher sends each new transaction id to BlockCypher (a third party).\n';

/** The command line as options, or { error } with what is wrong. */
function parseArgs(argv) {
  var o = { addresses: [], walletsFile: '', every: 60, api: DEFAULT_API, log: 'hopline-events.jsonl', state: 'hopline-monitor-state.json', onEvent: '', blockcypher: false, once: false, quiet: false };
  var i = 0, takes = { '--wallets': 'walletsFile', '--address': null, '--every': 'every', '--log': 'log', '--state': 'state', '--api': 'api', '--on-event': 'onEvent' };
  for (; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--blockcypher') o.blockcypher = true;
    else if (a === '--once') o.once = true;
    else if (a === '--quiet') o.quiet = true;
    else if (Object.prototype.hasOwnProperty.call(takes, a)) {
      var v = argv[++i]; if (v === undefined) return { error: a + ' needs a value.' };
      if (a === '--address') o.addresses.push(v); else o[takes[a]] = v;
    } else return { error: 'Unknown option ' + a + '.' };
  }
  o.every = Number(o.every);
  if (!isFinite(o.every) || o.every < MIN_EVERY) return { error: '--every must be a number of seconds, at least ' + MIN_EVERY + ': a public API is not for asking more often.' };
  if (!/^https?:\/\//i.test(o.api)) return { error: '--api must be a URL that starts with http:// or https://' };
  var wallets = [];
  if (o.walletsFile) {
    var text; try { text = fs.readFileSync(o.walletsFile, 'utf8'); } catch (e) { return { error: 'Cannot read ' + o.walletsFile + ': ' + e.message }; }
    var p = parseWallets(text); if (p.bad.length) return { error: 'Not an address in ' + o.walletsFile + ': ' + p.bad[0] };
    wallets = p.list;
  }
  for (var k = 0; k < o.addresses.length; k++) { var c = cleanAddress(o.addresses[k]); if (!c) return { error: 'Not an address: ' + o.addresses[k] }; if (wallets.indexOf(c) < 0) wallets.push(c); }
  if (!wallets.length) return { error: 'No wallets: give --wallets FILE or --address ADDR.' };
  o.wallets = wallets;
  return o;
}

async function main(argv) {
  var cmd = argv[0];
  if (cmd === 'list' || cmd === 'txids' || cmd === 'verify') {
    var file = argv[1]; if (!file) { process.stderr.write(USAGE); return 2; }
    if (!fs.existsSync(file)) { process.stderr.write('No such file: ' + file + '\n'); return 2; }
    if (cmd === 'list') { process.stdout.write(listLog(file)); return 0; }
    if (cmd === 'txids') { process.stdout.write(txidsOf(file).join('\n') + (txidsOf(file).length ? '\n' : '')); return 0; }
    var v = verifyLog(file);
    if (v.ok) { process.stdout.write('OK: ' + v.lines + ' lines, the chain is unbroken.\n'); return 0; }
    process.stdout.write('BROKEN at line ' + v.broken.line + ' of ' + v.lines + ': ' + v.broken.why + '\n'); return 1;
  }
  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) { process.stdout.write(USAGE); return 0; }
  var o = parseArgs(cmd === 'watch' ? argv.slice(1) : argv);
  if (o.error) { process.stderr.write(o.error + '\n\n' + USAGE); return 2; }
  if (o.blockcypher) process.stderr.write('--blockcypher: each new transaction id will be sent to BlockCypher (api.blockcypher.com).\n');
  var stopping = false;
  ['SIGINT', 'SIGTERM'].forEach(function (s) { process.on(s, function () { if (stopping) process.exit(130); stopping = true; process.stderr.write('Stopping after this check…\n'); }); });
  if (!o.quiet) process.stdout.write('Watching ' + o.wallets.length + ' wallet' + (o.wallets.length === 1 ? '' : 's') + ' every ' + o.every + ' s through ' + o.api + '; log ' + o.log + '.\n');
  var napping = function (ms) { return new Promise(function (resolve) { var t0 = Date.now(); (function tick() { if (stopping || Date.now() - t0 >= ms) return resolve(); setTimeout(tick, Math.min(250, ms)); }()); }); };       // Ctrl-C does not wait out the interval
  await run(Object.assign({}, o, { stop: function () { return stopping; }, sleep: napping }));
  return 0;
}

// The exit code is set, not forced: ending the process while connections are still closing makes Node abort on Windows. Each request asks for its connection to be closed, so nothing keeps it waiting.
if (require.main === module) main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) { process.stderr.write('Failed: ' + (e && e.message ? e.message : e) + '\n'); process.exitCode = 1; });

module.exports = { run: run, main: main, parseArgs: parseArgs, parseWallets: parseWallets, cleanAddress: cleanAddress, verifyLog: verifyLog, readEvents: readEvents, listLog: listLog, txidsOf: txidsOf, describe: describe,
                   fingerprint: fingerprint, effect: effect, appendEvent: appendEvent, logTail: logTail, lineHash: lineHash, ZERO: ZERO, MIN_EVERY: MIN_EVERY };
