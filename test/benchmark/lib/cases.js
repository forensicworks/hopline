'use strict';
/**
 * Reading a benchmark case: a folder with
 *   case.json    what it is (name, tier, how it was made, a seed, the version of what made it)
 *   txs.json.gz  the transactions as the Esplora API returns them (a list)
 *   truth.json   what is known about them
 *
 * truth.json: {
 *   schema: 1,
 *   wallets: { <wallet>: { software, behaviour: {...}, service: bool } },
 *   owners:  { <address>: <wallet> },                    every address of ours that appears in a transaction
 *   txs:     { <txid>: { kind, wallet?, change_vout?: number | null } },
 *             kind is what the transaction was made to be: payment, peel, batch, consolidation, coinjoin, equal-payout, payjoin
 *             change_vout is present for a transaction with one sender whose change is known: the output (null when it has no change)
 *   chains:  [ [<txid>, ...], ... ]                      peel chains, in order
 *   known:   [ <address>, ... ]                          addresses a list of names would know (the services)
 * }
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { Graph, ID } = require('../../../public/js/hopline-model.js');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** The folders under `root` that hold a case, in name order. */
function listCases(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'case.json'))).map((d) => path.join(root, d.name)).sort();
}

/** The graph of a list of transactions: every one loaded, and every output marked spent (by whom) or unspent, since nothing outside the list can spend it. */
function buildGraph(txs) {
  const g = new Graph(), spender = new Map();
  txs.forEach((t) => t.vin.forEach((v, i) => { if (!v.is_coinbase) spender.set(v.txid + ':' + v.vout, { txid: t.txid, vin: i, time: t.status && t.status.block_time }); }));
  txs.forEach((t) => g.addTx(t));
  txs.forEach((t) => g.addOutspends(t.txid, t.vout.map((o, n) => {
    const s = spender.get(t.txid + ':' + n);
    return s ? { spent: true, txid: s.txid, vin: s.vin, status: { confirmed: true, block_time: s.time } } : { spent: false };
  })));
  return g;
}

function loadCase(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const txBytes = fs.readFileSync(path.join(dir, 'txs.json.gz')), truthBytes = fs.readFileSync(path.join(dir, 'truth.json'));
  const txs = JSON.parse(zlib.gunzipSync(txBytes).toString('utf8')), truth = JSON.parse(truthBytes.toString('utf8'));
  if (!Array.isArray(txs) || !truth || truth.schema !== 1 || !truth.txs) throw new Error(dir + ': not a benchmark case (expected a list of transactions and a truth.json of schema 1)');
  return { name: meta.name || path.basename(dir), dir, meta, txs, truth, graph: buildGraph(txs), files: { txs: sha256(txBytes), truth: sha256(truthBytes) }, ID };
}

module.exports = { listCases, loadCase, buildGraph, sha256 };
