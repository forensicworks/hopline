#!/usr/bin/env node
'use strict';
/*
 * Hopline Telegram notifier: send what hopline-monitor.js sees to a Telegram chat. One file and no packages (Node 18 or later).
 *
 * It is the monitor's --on-event command: the monitor runs it once for each event and puts the event (one JSON line) on its input.
 *
 *   node hopline-monitor.js --wallets wallets.txt --once --quiet --on-event "node telegram-notify.js"
 *
 * Settings come from the environment, never from the command line (where `ps` would show them):
 *   TELEGRAM_BOT_TOKEN   the token BotFather gave you
 *   TELEGRAM_CHAT_ID     the chat to write to (a person, or a group: group ids are negative)
 *   HOPLINE_WALLETS      optional: the wallets file the monitor reads. The text after # on a line is that wallet's name in the messages:
 *                          bc1q...   # Savings (cold)
 *                        The file is read again for every message, so a name you add or change is used from the next one.
 *   TELEGRAM_API         optional: another Bot API server (default https://api.telegram.org); the tests use it
 *
 * From cron, put the three variables above the job in the crontab (`crontab -e`) and run the monitor with --once every minute:
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=123456789
 *   HOPLINE_WALLETS=/home/me/hopline-data/wallets.txt
 *   * * * * * cd /home/me/hopline-data && flock -n .lock node /path/to/tools/hopline-monitor.js --wallets wallets.txt --once --quiet --on-event "node /path/to/tools/telegram-notify.js" >> monitor.log 2>&1
 *
 * To try it: `echo '{"type":"recovered","at":"2026-01-01T00:00:00.000Z","wallet":"bc1q...","n":0}' | node telegram-notify.js` sends a message; add --dry to print it instead.
 *
 * What it sends, and to whom: each message holds the wallet's address (and name), the transaction id, the amounts and the times of one event, and goes to Telegram. Telegram is a third party that then knows
 * which wallets you watch. A message that could not be sent is not tried again later (a rate limit is waited out, up to three tries); the event is still in the monitor's log.
 */
const fs = require('fs');

const TELEGRAM_API = 'https://api.telegram.org';
const EXPLORER = 'https://mempool.space';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function btc(sats) { return (sats / 1e8).toFixed(8) + ' BTC'; }
function utc(ms) { return isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'unknown time'; }
function short(s, n) { s = String(s || ''); return s.length > n * 2 + 1 ? s.slice(0, n) + '…' + s.slice(-n) : s; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/** The form of an address the monitor writes into events: bech32 in lower case, the old forms as they are. */
function norm(a) { return /^bc1/i.test(a) ? a.toLowerCase() : a; }

/** { address: name } from a wallets file: the text after the first # of a line is the name of the address before it. No file, no names. */
function names(file) {
  var m = {};
  try {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf('#'); if (i < 0) return;
      var addr = line.slice(0, i).trim(), name = line.slice(i + 1).trim();
      if (addr && name) m[norm(addr)] = name;
    });
  } catch (e) { /* no file, no names */ }
  return m;
}

/** One event as the HTML Telegram accepts (b, i and a only). `nameOf` is { address: name }. */
function message(ev, nameOf) {
  var name = nameOf && ev.wallet ? nameOf[ev.wallet] : '';
  var wallet = ev.wallet ? (name ? '<b>' + esc(name) + '</b>\n' : '') + '<a href="' + EXPLORER + '/address/' + encodeURIComponent(ev.wallet) + '">' + esc(short(ev.wallet, 8)) + '</a>' : '';
  var tx = ev.txid ? '<a href="' + EXPLORER + '/tx/' + encodeURIComponent(ev.txid) + '">' + esc(short(ev.txid, 8)) + '</a>' : '';
  var lines = [];
  switch (ev.type) {
    case 'tx': {
      var net = (ev.in || 0) - (ev.out || 0);
      lines.push(net > 0 ? '🟢 <b>Received ' + btc(net) + '</b>' : net < 0 ? '🔴 <b>Sent ' + btc(-net) + '</b>' : '⚪ <b>Transaction</b>');
      lines.push(wallet, 'Tx: ' + tx);
      if (ev.in && ev.out) lines.push('Spent ' + btc(ev.out) + ', received back ' + btc(ev.in));
      lines.push(ev.status === 'confirmed' ? 'Confirmed in block ' + esc(ev.height) + (ev.blockTime ? ' (' + utc(ev.blockTime * 1000) + ')' : '') : 'Unconfirmed, in the mempool');
      lines.push('First seen: ' + utc(ev.seenAt ? ev.seenAt * 1000 : Date.parse(ev.at)));
      if (typeof ev.fee === 'number') lines.push('Fee: ' + ev.fee + ' sats');
      if (ev.blockcypher && ev.blockcypher.seen) lines.push('BlockCypher first saw it: ' + utc(ev.blockcypher.received * 1000) + (ev.blockcypher.relay ? ' via ' + esc(ev.blockcypher.relay) : ''));
      if (ev.baseline) lines.push('<i>Already unconfirmed when monitoring of this wallet began.</i>');
      break;
    }
    case 'confirmed': lines.push('✅ <b>Confirmed in block ' + esc(ev.height) + '</b>', wallet, 'Tx: ' + tx, ev.blockTime ? 'Block time: ' + utc(ev.blockTime * 1000) : ''); break;
    case 'dropped': lines.push('⚠️ <b>Left the mempool unconfirmed</b> (replaced or evicted)', wallet, 'Tx: ' + tx); break;
    case 'start': lines.push('👁 <b>Now watching</b>', wallet, 'Balance: ' + btc(ev.confirmed || 0) + (ev.unconfirmed ? ' (+' + btc(ev.unconfirmed) + ' unconfirmed)' : ''), (ev.txCount || 0) + ' transactions so far'); break;
    case 'gap': lines.push('⚠️ <b>More than 25 new transactions since the last check</b>: the older ones were not read.', wallet); break;
    case 'error': lines.push('❌ <b>Monitor error</b>', wallet, esc(ev.message)); break;
    case 'recovered': lines.push('✔️ <b>Reading this wallet again</b>', wallet); break;
    case 'skipped': lines.push('⚠️ <b>Line ' + esc(ev.line) + ' of the wallets file is not an address</b>', 'It is not being watched; the other wallets are. Look for a typo, or a name without # in front of it.'); break;
    default: lines.push(esc(ev.type), wallet);
  }
  lines.push('<i>' + utc(Date.parse(ev.at)) + (ev.n ? ' · event #' + esc(ev.n) : '') + '</i>');
  return lines.filter(Boolean).join('\n');
}

/** Send the text; a rate limit (429) is waited out, up to three tries. Throws with what Telegram said. `o`: { token, chat, api, sleep }. */
async function send(text, o) {
  var url = String(o.api || TELEGRAM_API).replace(/\/+$/, '') + '/bot' + o.token + '/sendMessage', wait = o.sleep || sleep;
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: o.chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true }) });
    if (res.ok) return;
    var j = await res.json().catch(function () { return {}; });
    if (res.status === 429) { var ra = Number(j && j.parameters && j.parameters.retry_after); await wait(Math.min(isFinite(ra) ? ra : 2, 20) * 1000 + 250); continue; }
    throw new Error('Telegram answered HTTP ' + res.status + (j && j.description ? ': ' + j.description : ''));
  }
  throw new Error('Telegram kept rate-limiting the message');
}

function readStdin() {
  return new Promise(function (resolve) { var raw = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', function (d) { raw += d; }); process.stdin.on('end', function () { resolve(raw); }); });
}

/** The exit code: 0 when the message was sent (or printed with --dry), 1 with the reason on stderr when not. */
async function main(argv, env) {
  var token = env.TELEGRAM_BOT_TOKEN || '';
  try {
    var ev; try { ev = JSON.parse(await readStdin()); } catch (e) { throw new Error('the event on the input is not JSON'); }
    var text = message(ev, names(env.HOPLINE_WALLETS));
    if (argv.indexOf('--dry') >= 0) { process.stderr.write(text + '\n---\n'); return 0; }
    if (!token || !env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    await send(text, { token: token, chat: env.TELEGRAM_CHAT_ID, api: env.TELEGRAM_API });
    return 0;
  } catch (e) {
    var why = String(e && e.message ? e.message : e); if (token) why = why.split(token).join('***');            // a token never reaches a log
    process.stderr.write('telegram-notify: ' + why + '\n');
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2), process.env).then(function (code) { process.exitCode = code; });

module.exports = { message: message, names: names, send: send, main: main, utc: utc };
