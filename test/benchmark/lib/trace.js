'use strict';
/**
 * Tracing a documented case (tier C of docs/benchmark.md): start where a public document says the money was, follow it forward with each
 * rule of Hopline's auto-expand, and see whether the trace reaches the place the document says it ended up, how many requests that took, and
 * how many transactions it loaded that were not on the way. It is the same walk the workspace runs (HoplineApi.Explorer.walk and
 * HoplineAnalysis.successors), with the network replaced by a recording of what the API said, so a result does not depend on the day.
 *
 * A case folder: case.json (what the documents say, the start, the endpoint, the route that was verified on the chain) and
 * responses.json.gz ({ "<path after the API base>": <the API's answer> }, the transactions without their signatures).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Api = require('../../../public/js/hopline-api.js');
const { Graph, ID } = require('../../../public/js/hopline-model.js');
const AN = require('../../../public/js/hopline-analysis.js');

const RULES = ['all', 'largest', 'change', 'peel'];
const DEFAULTS = { hops: 10, maxTx: 80, maxReq: 400, perTx: 6 };
const SIGNATURES = ['witness', 'scriptsig'], ASM = ['scriptsig_asm', 'scriptpubkey_asm', 'inner_redeemscript_asm', 'inner_witnessscript_asm'];

/** What the walk does not read, left out of a recorded transaction (the same as tools/bench/fetch_mainnet_sample.py does). */
function slim(t) {
  if (!t || !Array.isArray(t.vin)) return t;
  t.vin.forEach((v) => {
    ASM.forEach((k) => { delete v[k]; if (v.prevout) delete v.prevout[k]; });
    if (!v.is_coinbase) SIGNATURES.forEach((k) => { delete v[k]; });
  });
  (t.vout || []).forEach((o) => ASM.forEach((k) => { delete o[k]; }));
  return t;
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: () => Promise.resolve(body) });

/** A fetch that answers from a recording, and fails loudly on a request the recording does not have. */
function replayFetch(rec, base) {
  return (url) => {
    const p = String(url).slice(base.length);
    if (Object.prototype.hasOwnProperty.call(rec, p)) return Promise.resolve(reply(200, JSON.stringify(rec[p])));
    const e = new Error('the recording has no answer for ' + p + ' (the rules asked for something new: record the case again with --record)'); e.notRecorded = true;
    return Promise.reject(e);
  };
}

/** A fetch that asks the real API and keeps its answers. */
function recordFetch(real, rec, base) {
  return (url, init) => {
    const p = String(url).slice(base.length);
    if (Object.prototype.hasOwnProperty.call(rec, p)) return Promise.resolve(reply(200, JSON.stringify(rec[p])));            // asked before by another rule: not asked of the server again
    const headers = Object.assign({ 'User-Agent': 'hopline-benchmark/1.0 (public chain data, read only)' }, init && init.headers);
    return real(url, Object.assign({}, init, { headers })).then((res) => {
      if (!res.ok) return res;
      return res.text().then((body) => { rec[p] = slim(JSON.parse(body)); return reply(200, body); });
    });
  };
}

function loadCaseFolder(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')), file = path.join(dir, 'responses.json.gz');
  return { name: meta.name || path.basename(dir), dir, meta, responses: fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) : null };
}

function listFolders(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'case.json'))).map((d) => path.join(root, d.name)).sort();
}

/** One walk with one rule, as the workspace runs it. Resolves with the graph, the client and the walk. */
function walkOnce(meta, rule, fetchImpl, options) {
  const o = Object.assign({}, DEFAULTS, meta.limits || {}, options || {});
  const graph = new Graph();
  const client = new Api.Client({ base: meta.api, fetch: fetchImpl, concurrency: o.concurrency || 1, delayMs: o.delayMs || 0, retries: o.retries || 0, backoffMs: o.backoffMs || 1000, maxRequests: o.maxReq, ttlMs: 1e12 });
  const ex = new Api.Explorer(client, graph);
  const sopts = { follow: rule, perTx: o.perTx, minSats: 0, stopAtMix: true, mark: null, known: () => false };
  return ex.walk([meta.start.txid], { dir: 'next', hops: o.hops, maxTx: o.maxTx, successors: (txid) => AN.successors(graph, ID.tx(txid), 'next', sopts) }).then((w) => {
    const missing = (w.errors || []).filter((m) => /no answer for/.test(m));
    if (missing.length) throw new Error(missing[0]);
    return { graph, client, w, sopts, hops: o.hops };
  });
}

/** Why the branches of a walk ended, in the workspace's words: what the rules said at each transaction they were asked about. */
function endings(r) {
  const n = { 'transaction looked like a CoinJoin': 0, 'transaction had no clear change output': 0, 'transaction was not a peel step': 0, 'output unspent': 0, 'output with no known spender': 0, 'output at a labelled wallet': 0 };
  r.w.asked.forEach((a) => {
    const s = AN.successors(r.graph, ID.tx(a.txid), 'next', r.sopts);
    if (s.stop) { if (/CoinJoin/.test(s.stop)) n['transaction looked like a CoinJoin']++; else if (/clear change/.test(s.stop)) n['transaction had no clear change output']++; else if (/peel step/.test(s.stop)) n['transaction was not a peel step']++; }
    s.items.forEach((it) => { if (!it.why) return; if (it.why === 'unspent') n['output unspent']++; else if (/not known/.test(it.why)) n['output with no known spender']++; else if (/^labelled/.test(it.why)) n['output at a labelled wallet']++; });
  });
  return n;
}

/**
 * One rule on one case. Resolves with what happened: whether the endpoint was reached and at which hop, the requests it took to get there
 * (a second walk with the hops set at the end), how many transactions off the route were loaded on the way (wrong branches) and how many
 * after it (the walk does not know it has arrived), and why the branches ended. `fetchImpl` is replayFetch or recordFetch.
 */
function trace(meta, rule, fetchImpl, options) {
  return walkOnce(meta, rule, fetchImpl, options).then((r) => {
    const { graph, client, w } = r, onRoute = new Set(meta.route || []), levelOf = new Map(), loaded = [];
    graph.nodes.forEach((n) => { if (n.type === 'tx' && n.loaded === true) loaded.push(n.txid); });
    w.levels.forEach((ids, i) => ids.forEach((id) => { if (!levelOf.has(id)) levelOf.set(id, i); }));
    // the endpoint is reached when a loaded transaction pays its address: the first level at which one did
    const end = graph.nodes.get(ID.addr(meta.endpoint.address)), payers = [];
    if (end) graph.edgesOf(end.id).forEach((e) => { if (e.kind === 'out' && graph.nodes.get(e.source) && graph.nodes.get(e.source).loaded === true) payers.push(graph.nodes.get(e.source).txid); });
    const at = payers.length ? Math.min.apply(null, payers.map((t) => levelOf.has(t) ? levelOf.get(t) : Infinity)) : Infinity, reached = at !== Infinity;
    const lvl = (t) => (levelOf.has(t) ? levelOf.get(t) : Infinity);
    const out = { rule, reached, hops: reached ? at : null, requests: client.count.network, loaded: loaded.length, routeLength: onRoute.size,
                  onRoute: loaded.filter((t) => onRoute.has(t)).length,
                  wrongBranches: loaded.filter((t) => !onRoute.has(t) && (!reached || lvl(t) <= at)).length, afterTheEnd: reached ? loaded.filter((t) => !onRoute.has(t) && lvl(t) > at).length : 0,
                  ended: w.reason, hopsLimit: r.hops, hopsRun: w.levels.length - 1, endings: endings(r), stops: w.stops.map((s) => ({ txid: s.txid, reason: s.reason })) };
    if (!reached) return out;
    return walkOnce(meta, rule, fetchImpl, Object.assign({}, options || {}, { hops: Math.max(1, at) })).then((short) => { out.requestsToEnd = short.client.count.network; return out; });
  });
}

/** The recording a case needs: every rule run against the real API, the answers kept, and the transactions of the route, so they can be checked. */
async function record(meta, realFetch, options) {
  const rec = {}, runs = [];
  for (const rule of RULES) runs.push(await trace(meta, rule, recordFetch(realFetch, rec, meta.api), options));
  const client = new Api.Client({ base: meta.api, fetch: recordFetch(realFetch, rec, meta.api), concurrency: 1, delayMs: (options && options.delayMs) || 0, retries: 3, ttlMs: 1e12 });
  for (const t of meta.route || []) { if (!rec['/tx/' + t]) await client.tx(t); }
  return { rec, runs };
}

function writeRecording(dir, rec) {
  const sorted = {}; Object.keys(rec).sort().forEach((k) => { sorted[k] = rec[k]; });
  fs.writeFileSync(path.join(dir, 'responses.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(sorted), 'utf8'), { level: 9 }));
}

/** Is what the case says about itself true of the recording? The route is one chain of spends from the start to a payment of the endpoint. */
function checkRoute(c) {
  const problems = [], tx = (id) => (c.responses || {})['/tx/' + id], route = c.meta.route || [];
  if (!route.length) return ['no route'];
  if (route[0] !== c.meta.start.txid) problems.push('the route does not start at the start');
  route.forEach((id, i) => {
    const t = tx(id);
    if (!t) { problems.push('the recording has no ' + id); return; }
    if (i > 0 && !t.vin.some((v) => v.txid === route[i - 1])) problems.push(id + ' does not spend ' + route[i - 1]);
  });
  const last = tx(route[route.length - 1]);
  if (last && !last.vout.some((o) => o.scriptpubkey_address === c.meta.endpoint.address)) problems.push('the last transaction of the route does not pay the endpoint');
  return problems;
}

module.exports = { RULES, DEFAULTS, slim, replayFetch, recordFetch, loadCaseFolder, listFolders, trace, record, writeRecording, checkRoute };
