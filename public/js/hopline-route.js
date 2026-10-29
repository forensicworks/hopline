/*
 * Hopline routes: how money got from one vertex to another through the transactions that are loaded, and where the trail
 * is still open. Pure functions over the graph, no DOM, no network.
 *
 * A route follows COINS, not addresses. Output n of transaction A was spent by transaction B (the spender the API reported,
 * or the `prev` of one of B's inputs), so a route can only run forward in time. A search over addresses would join two
 * unrelated streams of money whenever one address is used again years later (a transaction of 2026 that pays an address
 * and a transaction of 2022 that spends it look connected, and are not). Two limits stay, and are named on the route:
 *   - a transaction with many inputs mixes coins of other origins in (a consolidation, a CoinJoin);
 *   - a service wallet (an exchange) mixes everyone's coins. A route is never searched THROUGH one: it may start or end
 *     there, and is only found across one (and says so) when there is no other way.
 * "No route" only ever means none in what is loaded. openEnds says how much is not: outputs whose spender was never
 * looked up, spenders and funders that are not loaded.
 *
 * `hub(vertexId)` is supplied by the caller: true for a wallet that is a service (the page uses the known list and the tags
 * EXCH, MIXER, SERVICE, MARKET, GAMBLING). Ransomware and sanctions entries are not services, so a route may pass them.
 * isHub, nameOf and referenceOf are those rules for a graph and the lists of names, so the page and the command-line tool agree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'), require('./hopline-analysis.js'));
  else root.HoplineRoute = factory(root.HoplineModel, root.HoplineAnalysis);
}(typeof self !== 'undefined' ? self : this, function (Model, AN) {
  'use strict';

  var ID = Model.ID;
  var MAX_TXS = 60;                                   // no route is searched beyond this many transactions
  var MERGE_INPUTS = 5;                               // a transaction with this many inputs or more mixes the coins of its route with others

  var SERVICE_TAGS = { EXCH: 1, MIXER: 1, SERVICE: 1, MARKET: 1, GAMBLING: 1 };

  function push(map, key, value) { var l = map.get(key); if (!l) map.set(key, l = []); if (l.indexOf(value) < 0) l.push(value); }

  // ---- names, service wallets and the reference ---------------------------------------------------
  /** A service wallet (an exchange, a mixer, a market, a pool): many people's coins pass through it. known(address) -> a list entry { label, sanctions } or null. Ransomware and sanctions entries are not services. */
  function isHub(graph, known, id) {
    var n = graph.nodes.get(id);
    if (!n || n.type !== 'addr') return false;
    if (n.tag && SERVICE_TAGS[n.tag]) return true;
    var k = known ? known(n.address) : null;
    return !!k && !k.sanctions && !/^Ransomware/i.test(k.label || '');
  }
  /** What marks a wallet as named: your label, your tag or the name on a list; null when nothing does. */
  function nameOf(graph, known, id) {
    var n = graph.nodes.get(id);
    if (!n || n.type !== 'addr') return null;
    var k = known ? known(n.address) : null;
    return n.label || n.tag || (k && k.label) || null;
  }
  /**
   * What the other wallets are related to: the one picked (view.routeRef), else the first starting point of the trace (view.trace.seeds), else a wallet tagged
   * THREAT, else the one vertex that is selected. Returns a vertex id or null.
   */
  function referenceOf(graph, view, selected) {
    view = view || {};
    var seeds = (view.trace && view.trace.seeds) || [], found = null, i;
    function ok(id) { return typeof id === 'string' && /^(tx|addr):/.test(id) && graph.nodes.has(id); }
    if (ok(view.routeRef)) return view.routeRef;
    for (i = 0; i < seeds.length; i++) if (ok(seeds[i])) return seeds[i];
    graph.nodes.forEach(function (n) { if (!found && n.type === 'addr' && n.tag === 'THREAT') found = n.id; });
    if (found) return found;
    var sel = (selected || []).filter(ok);
    return sel.length === 1 ? sel[0] : null;
  }

  // ---- the coins of the graph ----------------------------------------------------------------------
  /**
   * The graph as coins moving between transactions. `succ` / `pred` hold, for each transaction, the links to the transactions
   * that spent its outputs / that created the outputs it spent. A link is one coin:
   *   { from, to, vout, amount, address (the vertex that held the coin between the two), outEdge, inEdge }
   * `spenders` / `payers` map a wallet to the transactions it is an input of / an output of.
   */
  function index(graph) {
    var txs = new Map(), succ = new Map(), pred = new Map(), spenders = new Map(), payers = new Map(), links = new Map();
    function rec(id) { var r = txs.get(id); if (!r) { var n = graph.nodes.get(id); r = { id: id, loaded: !!(n && n.loaded === true), ins: [], outs: [] }; txs.set(id, r); } return r; }
    function link(l) {
      var key = l.from + ':' + l.vout;
      if (links.has(key)) return;
      links.set(key, l); push(succ, l.from, l); push(pred, l.to, l);
    }
    graph.edges.forEach(function (e) {
      if (e.kind === 'out') {
        rec(e.source).outs.push(e); push(payers, e.target, e.source);
        if (e.spentBy && e.spentBy.txid) link({ from: e.source, to: ID.tx(e.spentBy.txid), vout: e.vout, amount: e.amount, address: e.target, outEdge: e.id, inEdge: ID.edgeIn(e.spentBy.txid, e.spentBy.vin) });
      } else if (e.kind === 'in') {
        rec(e.target).ins.push(e); push(spenders, e.source, e.target);
        if (e.prev && e.prev.txid) link({ from: ID.tx(e.prev.txid), to: e.target, vout: e.prev.vout, amount: e.amount, address: e.source, outEdge: ID.edgeOut(e.prev.txid, e.prev.vout), inEdge: e.id });
      }
    });
    return { graph: graph, txs: txs, succ: succ, pred: pred, spenders: spenders, payers: payers };
  }

  /** The transactions a search starts from: what the vertex spent in (forward) or what paid it (backward); a transaction starts from itself. */
  function startsFor(idx, id, dir) {
    if (/^tx:/.test(id)) return idx.txs.has(id) || idx.succ.has(id) || idx.pred.has(id) ? [id] : [];
    return (dir === 'next' ? idx.spenders : idx.payers).get(id) || [];
  }

  /** Breadth-first over the coins from the given transactions: dist = how many transactions it took (a start is 1), via = the link that led to it. */
  function walk(idx, starts, dir, hub, max) {
    var dist = new Map(), via = new Map(), queue = [];
    starts.forEach(function (s) { if (!dist.has(s)) { dist.set(s, 1); via.set(s, null); queue.push(s); } });
    for (var i = 0; i < queue.length; i++) {
      var t = queue[i], d = dist.get(t);
      if (d >= max) continue;
      ((dir === 'next' ? idx.succ : idx.pred).get(t) || []).forEach(function (l) {
        var nxt = dir === 'next' ? l.to : l.from;
        if (dist.has(nxt)) return;
        if (hub && hub(l.address)) return;                                     // a service wallet mixes everyone's coins: the route stops there
        dist.set(nxt, d + 1); via.set(nxt, l); queue.push(nxt);
      });
    }
    return { dist: dist, via: via };
  }

  function hubIn(links, hub) { var out = []; links.forEach(function (l) { if (hub && hub(l.address) && out.indexOf(l.address) < 0) out.push(l.address); }); return out; }

  // ---- finding a route ------------------------------------------------------------------------------
  function attempt(idx, fromId, toId, hub, max) {
    var w = walk(idx, startsFor(idx, fromId, 'next'), 'next', hub, max), goal = null;
    if (/^tx:/.test(toId)) { if (w.dist.has(toId)) goal = toId; }
    else (idx.payers.get(toId) || []).forEach(function (t) { if (w.dist.has(t) && (!goal || w.dist.get(t) < w.dist.get(goal))) goal = t; });
    return goal ? build(idx, fromId, toId, goal, w) : null;
  }

  /**
   * The shortest route the money took from `fromId` to `toId` (a wallet or a transaction each), or null when there is none in what
   * is loaded. opts: { hub, max }. Without a way round, a route that crosses a service wallet is returned with `viaHub` naming it.
   * { from, to, vertices: [ids in order], edges: [edge ids], txs: [ids], hops, steps: [...], first, last, mixing: [steps that merge many inputs], viaHub: [wallet ids] }
   */
  function find(idx, fromId, toId, opts) {
    opts = opts || {};
    if (!fromId || !toId || fromId === toId) return null;
    var max = opts.max || MAX_TXS, r = attempt(idx, fromId, toId, opts.hub, max);
    if (r || !opts.hub) return r;
    r = attempt(idx, fromId, toId, null, max);
    if (r) r.viaHub = hubIn(r.links, opts.hub);
    return r && r.viaHub.length ? r : null;
  }

  function build(idx, fromId, toId, goal, w) {
    var graph = idx.graph, links = [], t = goal, l;
    while ((l = w.via.get(t))) { links.unshift(l); t = l.from; }
    var txs = [t]; links.forEach(function (x) { txs.push(x.to); });
    var vertices = [], edges = [], noRec = { ins: [], outs: [] };
    function addEdge(id) { if (id && graph.edges.has(id) && edges.indexOf(id) < 0) edges.push(id); }
    function sum(list) { return list.reduce(function (s, e) { return s + e.amount; }, 0); }
    var firstIns = (idx.txs.get(txs[0]) || noRec).ins.filter(function (e) { return e.source === fromId; });
    var lastOuts = (idx.txs.get(goal) || noRec).outs.filter(function (e) { return e.target === toId; });
    if (!/^tx:/.test(fromId)) { vertices.push(fromId); firstIns.forEach(function (e) { addEdge(e.id); }); }
    vertices.push(txs[0]);
    links.forEach(function (x, i) { addEdge(x.outEdge); vertices.push(x.address); addEdge(x.inEdge); vertices.push(txs[i + 1]); });
    if (!/^tx:/.test(toId)) { vertices.push(toId); lastOuts.forEach(function (e) { addEdge(e.id); }); }
    var coinIn = !/^tx:/.test(fromId) ? sum(firstIns) : null;
    var steps = txs.map(function (id, i) {
      var n = graph.nodes.get(id) || {}, v = AN.txView(graph, id), flags = v ? AN.classify(v).map(function (f) { return f.kind; }) : [];
      var out = i < links.length ? links[i].amount : (!/^tx:/.test(toId) ? sum(lastOuts) : null);
      var merges = n.loaded && (n.nIn || 0) >= MERGE_INPUTS || flags.indexOf('consolidation') >= 0 || flags.indexOf('coinjoin') >= 0;
      return { id: id, txid: n.txid || id.slice(3), time: n.time == null ? null : n.time, loaded: !!n.loaded, nIn: n.nIn == null ? null : n.nIn, nOut: n.nOut == null ? null : n.nOut,
               flags: flags, merges: !!merges, coinIn: i === 0 ? coinIn : links[i - 1].amount, coinOut: out };
    });
    var times = steps.map(function (s) { return s.time; }).filter(function (x) { return x != null; });
    return { from: fromId, to: toId, vertices: vertices, edges: edges, txs: txs, hops: txs.length, links: links, steps: steps,
             first: times.length ? Math.min.apply(null, times) : null, last: times.length ? Math.max.apply(null, times) : null,
             mixing: steps.filter(function (s) { return s.merges; }), viaHub: [] };
  }

  // ---- how a set of wallets relates to one reference ------------------------------------------------
  /**
   * For each wallet in `targets`, how it relates to the reference (a wallet or a transaction), over coins:
   *   down  the reference's money reached it ({ hops: transactions on the way, txid: the one that paid it, viaHub })
   *   up    its money reached the reference
   *   same  it is the reference
   * Each of down / up is null when there is no route in what is loaded. viaHub is true when the only route crosses a service wallet.
   * Returns Map(target id -> { same, down, up }).
   */
  function relations(idx, refId, targets, opts) {
    opts = opts || {};
    var max = opts.max || MAX_TXS, hub = opts.hub, out = new Map();
    var fwd = walk(idx, startsFor(idx, refId, 'next'), 'next', hub, max), bwd = walk(idx, startsFor(idx, refId, 'prev'), 'prev', hub, max);
    var fwdAny = hub ? walk(idx, startsFor(idx, refId, 'next'), 'next', null, max) : fwd, bwdAny = hub ? walk(idx, startsFor(idx, refId, 'prev'), 'prev', null, max) : bwd;
    function best(map, w) {
      var hit = null;
      (map || []).forEach(function (t) { if (w.dist.has(t) && (!hit || w.dist.get(t) < hit.hops)) hit = { hops: w.dist.get(t), txid: t.slice(3), viaHub: false }; });
      return hit;
    }
    // a wallet is on the way when a transaction that pays it (down) or that it spends in (up) is; a transaction is on the way when it is itself
    function pick(id, dir, w) { return /^tx:/.test(id) ? best([id], w) : best(dir === 'next' ? idx.payers.get(id) : idx.spenders.get(id), w); }
    targets.forEach(function (id) {
      if (id === refId) { out.set(id, { same: true, down: null, up: null }); return; }
      var down = pick(id, 'next', fwd), up = pick(id, 'prev', bwd);
      if (!down && hub) { down = pick(id, 'next', fwdAny); if (down) down.viaHub = true; }
      if (!up && hub) { up = pick(id, 'prev', bwdAny); if (up) up.viaHub = true; }
      out.set(id, { same: false, down: down, up: up });
    });
    return out;
  }

  // ---- where the trail is still open ------------------------------------------------------------------
  /**
   * Follow the money from the reference(s) as far as what is loaded goes, and report how each branch ends. dir: 'next' (where it went)
   * or 'prev' (where it came from). opts: { stop(vertexId) -> a name or null, max }. A wallet that has a name stops the branch, as it
   * does for Auto-expand.
   *   ends     branches that go on but were not followed: kind 'unchecked' (whether the output was spent was never asked), 'spent' (it
   *            was spent, by a transaction that is not loaded: forward) or 'funder' (the transaction that paid the input is not loaded:
   *            backward); each { kind, dir, txid, id (the wallet), address, amount, index (output or input number), edgeId, time, depth, next (the transaction to load) }
   *   named    branches that stopped at a named wallet: { id, address, label, txid, amount, depth, time, wallet (the wallet that held the coin just before the
   *            transaction, or after it going backward), nIn, nOut }
   *   resting  coins that are unspent: { count, sats }
   *   reached  { txs: loaded transactions followed, coinbase: coinbase inputs reached (backward) }
   * Ends are ordered largest first.
   */
  function openEnds(idx, refIds, dir, opts) {
    opts = opts || {};
    var graph = idx.graph, max = opts.max || MAX_TXS, forward = dir !== 'prev', stop = opts.stop;
    var seen = new Map(), side = new Map(), queue = [], ends = [], named = [], resting = { count: 0, sats: 0 }, reached = { txs: 0, coinbase: 0 };
    // side: the wallet that held the coin on the reference's side of a transaction: just before it (forward) or just after it, on its way to the reference (backward)
    (Array.isArray(refIds) ? refIds : [refIds]).forEach(function (r) {
      startsFor(idx, r, forward ? 'next' : 'prev').forEach(function (t) { if (!seen.has(t)) { seen.set(t, 1); side.set(t, /^addr:/.test(r) ? r : null); queue.push(t); } });
    });
    function entry(label, id, address, t, amount, d, node) {
      return { id: id, address: address, label: label, txid: t.slice(3), amount: amount, depth: d, time: node.time == null ? null : node.time, wallet: side.get(t) || null, nIn: node.nIn == null ? null : node.nIn, nOut: node.nOut == null ? null : node.nOut };
    }
    function nameOf(id) { return stop ? stop(id) : null; }
    for (var i = 0; i < queue.length; i++) {
      var t = queue[i], d = seen.get(t), rec = idx.txs.get(t), node = graph.nodes.get(t) || {};
      if (!rec || !rec.loaded) {
        ends.push({ kind: forward ? 'spent' : 'funder', dir: dir, txid: t.slice(3), id: null, address: null, amount: null, index: null, edgeId: null, time: node.time == null ? null : node.time, depth: d, next: t.slice(3) });
        continue;
      }
      reached.txs++;
      if (forward) {
        rec.outs.forEach(function (e) {
          var target = graph.nodes.get(e.target);
          if (!target || target.type !== 'addr') return;                      // OP_RETURN data and outputs with no address carry no coins to follow
          var label = nameOf(e.target);
          if (label) { named.push(entry(label, e.target, target.address, t, e.amount, d, node)); return; }
          if (e.spent === false) { resting.count++; resting.sats += e.amount; return; }
          var spender = e.spentBy && e.spentBy.txid ? ID.tx(e.spentBy.txid) : null;
          if (e.spent === true && spender) {
            if (d + 1 > max) return;
            if (!seen.has(spender)) { seen.set(spender, d + 1); side.set(spender, e.target); queue.push(spender); }
            return;
          }
          ends.push({ kind: 'unchecked', dir: dir, txid: t.slice(3), id: e.target, address: target.address, amount: e.amount, index: e.vout, edgeId: e.id, time: node.time == null ? null : node.time, depth: d, next: t.slice(3) });
        });
      } else {
        rec.ins.forEach(function (e) {
          var src = graph.nodes.get(e.source);
          if (!src) return;
          if (src.type === 'coinbase') { reached.coinbase++; return; }
          if (src.type !== 'addr') return;
          var label = nameOf(e.source);
          if (label) { named.push(entry(label, e.source, src.address, t, e.amount, d, node)); return; }
          if (!e.prev || !e.prev.txid) return;
          var funder = ID.tx(e.prev.txid), fr = idx.txs.get(funder);
          if (fr && fr.loaded) { if (d + 1 <= max && !seen.has(funder)) { seen.set(funder, d + 1); side.set(funder, e.source); queue.push(funder); } return; }
          ends.push({ kind: 'funder', dir: dir, txid: t.slice(3), id: e.source, address: src.address, amount: e.amount, index: e.vin, edgeId: e.id, time: node.time == null ? null : node.time, depth: d, next: e.prev.txid });
        });
      }
    }
    ends.sort(function (a, b) { return (b.amount || 0) - (a.amount || 0) || (a.depth - b.depth); });
    return { dir: forward ? 'next' : 'prev', ends: ends, named: named, resting: resting, reached: reached };
  }

  // ---- where the money meets a service ---------------------------------------------------------------
  /**
   * The places where money from the reference went into a service wallet (a deposit) or money from one came into the trail (a withdrawal), oldest first.
   * opts: { hub(vertexId), stop(vertexId) -> name, max }. Several outputs of one transaction to one service are one row. The trail is followed THROUGH every
   * wallet that is not a service, whatever its name or tag (a victim wallet you tagged, a ransom address on a list): only a service ends a branch, because only a
   * service mixes everyone's coins. Without `hub` there is no way to tell a service, and nothing is returned.
   *   { dir: 'deposit' | 'withdrawal', service (its name), id, address, txid, time, amount (sats), outputs, wallet (the wallet that held the coin just before a
   *     deposit, a deposit address candidate, or just after a withdrawal: the customer's wallet candidate), walletAddress, depth, nIn, nOut, merges }
   * The reference's own coins are followed only as far as the loaded transactions go, so a missing row only means none was found there.
   */
  function handoffs(idx, refIds, opts) {
    opts = opts || {};
    if (!opts.hub) return [];
    var rows = [], graph = idx.graph, hub = opts.hub, name = opts.stop;
    var services = name ? function (id) { return hub(id) ? name(id) : null; } : null;
    [['next', 'deposit'], ['prev', 'withdrawal']].forEach(function (d) {
      var oe = openEnds(idx, refIds, d[0], { stop: services, max: opts.max }), by = new Map();
      oe.named.forEach(function (n) {
        var key = n.txid + '|' + n.id, r = by.get(key);
        if (!r) {
          var w = n.wallet ? graph.nodes.get(n.wallet) : null;
          r = { dir: d[1], service: n.label, id: n.id, address: n.address, txid: n.txid, time: n.time, amount: 0, outputs: 0, wallet: n.wallet, walletAddress: w && w.address ? w.address : null,
                depth: n.depth, nIn: n.nIn, nOut: n.nOut, merges: n.nIn != null && n.nIn >= MERGE_INPUTS };
          by.set(key, r); rows.push(r);
        }
        r.amount += n.amount || 0; r.outputs++;
      });
    });
    rows.sort(function (a, b) { return (a.time == null ? 1e18 : a.time) - (b.time == null ? 1e18 : b.time) || a.depth - b.depth || (a.txid < b.txid ? -1 : 1); });
    return rows;
  }

  /**
   * The successor rule for following open ends with Auto-expand's machinery: opts are AN.successors' options; the first level forward only goes along the
   * outputs that were open, not every output of those transactions. Returns function(txid, level) -> { next, items, stop }.
   */
  function endsSuccessors(graph, ends, dir, sopts) {
    var forward = dir !== 'prev';
    return function (txid, level) {
      var first = forward && level === 0;
      var r = AN.successors(graph, ID.tx(txid), forward ? 'next' : 'prev', first ? Object.assign({}, sopts, { follow: 'all', perTx: 1000 }) : sopts);
      if (first) {
        var open = ends.filter(function (e) { return e.next === txid && e.edgeId; });
        if (open.length) {
          var spenders = {};
          open.forEach(function (e) { var ed = graph.edges.get(e.edgeId); if (ed && ed.spentBy) spenders[ed.spentBy.txid] = true; });
          r.next = r.next.filter(function (x) { return spenders[x]; });
          r.items = r.items.filter(function (it) { return spenders[it.spender]; });
        }
      }
      return r;
    };
  }

  /** The largest few of a list of open ends (by amount), at most `width`, one per transaction to load. */
  function pickEnds(ends, width) {
    var out = [], seen = {};
    ends.slice().sort(function (a, b) { return (b.amount || 0) - (a.amount || 0); }).forEach(function (e) {
      if (out.length >= width) return;
      if (e.next && seen[e.next] && !e.edgeId) return;
      seen[e.next] = true; out.push(e);
    });
    return out;
  }

  /**
   * Look for a route from one vertex to another by loading from both ends: round by round, the largest open ends going forward from `fromId` and
   * the largest going backward from `toId` are followed one step, until a route appears or a limit is reached. `ex` is an Explorer (only ex.walk is
   * used), so the request limit of its client applies. A wallet with a name ends a branch, as it does for Auto-expand.
   * opts: { hub, stop(vertexId) -> name, sopts (AN.successors options), rounds (8), width (8 branches per side), maxTx (40 loaded per step), progress(round) }
   * Resolves { route, reason: 'found' | 'exhausted' (nothing left to load) | 'stalled' (a whole round changed nothing: what it asked for was not returned) | 'rounds' |
   * 'cap-requests' | 'cap-tx' | 'cancelled', rounds, loaded, requests, errors (the first few that were not a request limit), open: { next, prev } }.
   */
  function connect(ex, graph, fromId, toId, opts) {
    opts = opts || {};
    var rounds = opts.rounds || 8, width = opts.width || 8, hub = opts.hub, stop = opts.stop, round = 0;
    var sopts = Object.assign({ follow: 'all', perTx: 10, stopAtMix: true, mark: stop ? function (a) { return stop(ID.addr(a)); } : null }, opts.sopts || {});
    var total = { loaded: 0, requests: 0, errors: [] };
    function sig() { var o = 0; graph.nodes.forEach(function (n) { if (n.outspendsLoaded) o++; }); return graph.nodes.size + '/' + graph.edges.size + '/' + o; }
    function result(reason, idx, route) {
      var open = { next: 0, prev: 0 };
      if (!route && idx) { open.next = openEnds(idx, fromId, 'next', { stop: stop }).ends.length; open.prev = openEnds(idx, toId, 'prev', { stop: stop }).ends.length; }
      return { route: route || null, reason: reason, rounds: round, loaded: total.loaded, requests: total.requests, errors: total.errors, open: open };
    }
    var reason = 'found';
    function side(ends, dir) {
      var picks = pickEnds(ends, width), starts = [];
      picks.forEach(function (e) { if (e.next && starts.indexOf(e.next) < 0) starts.push(e.next); });
      if (!starts.length) return Promise.resolve(null);
      return ex.walk(starts, { dir: dir, hops: 1, maxTx: opts.maxTx || 40, successors: endsSuccessors(graph, picks, dir, sopts) }).then(function (w) {
        total.loaded += w.loadedNew || 0; total.requests += w.requests || 0;
        (w.errors || []).forEach(function (e) { if (!/request cap/.test(e) && total.errors.length < 5 && total.errors.indexOf(e) < 0) total.errors.push(e); });
        return w.reason === 'cancelled' || w.reason === 'cap-requests' || w.reason === 'cap-tx' ? w.reason : null;
      });
    }
    function step() {
      var idx = index(graph), route = find(idx, fromId, toId, { hub: hub });
      if (route) { reason = 'found'; return Promise.resolve(result(reason, idx, route)); }
      if (round >= rounds) { reason = 'rounds'; return Promise.resolve(result(reason, idx, null)); }
      var f = openEnds(idx, fromId, 'next', { stop: stop }).ends, b = openEnds(idx, toId, 'prev', { stop: stop }).ends;
      if (!f.length && !b.length) { reason = 'exhausted'; return Promise.resolve(result(reason, idx, null)); }
      round++;
      if (opts.progress) opts.progress(round);
      var before = sig();
      return side(f, 'next').then(function (stopped) { return stopped || side(b, 'prev'); }).then(function (stopped) {
        var i2 = index(graph), r2 = find(i2, fromId, toId, { hub: hub });
        if (r2) { reason = 'found'; return result(reason, i2, r2); }
        if (stopped) { reason = stopped; return result(reason, i2, null); }
        if (sig() === before) { reason = 'stalled'; return result(reason, i2, null); }                       // the same graph as before the round: asking again would get the same answer
        return step();
      });
    }
    return step();
  }

  // ---- what is loaded but not on screen --------------------------------------------------------------
  /**
   * What the workspace holds that the canvas does not show. `shown` is the set of vertex ids on screen (the group vertices of a trace are in it and are not in the
   * graph: they are ignored), `an` is HoplineAnalysis.analyse(graph) and known(address) -> a list entry or null.
   * Returns { total, shown, left, transactions, wallets, other (vertices of other kinds not on screen), patterns: { kind: transactions not on screen },
   *           peelChains (chains with a transaction not on screen), clusters (with an address not on screen), change (transactions with a likely-change guess),
   *           known: [wallet vertex ids that a list names], sanctions (of those, on a sanctions list) }.
   * The findings are computed over everything loaded, so these counts say how much of them the canvas leaves out.
   */
  function offscreen(graph, shown, an, known) {
    var r = { total: graph.nodes.size, shown: 0, left: 0, transactions: 0, wallets: 0, other: 0, patterns: {}, peelChains: 0, clusters: 0, change: 0, known: [], sanctions: 0 };
    graph.nodes.forEach(function (n) {
      if (shown.has(n.id)) { r.shown++; return; }
      if (n.type === 'tx') r.transactions++; else if (n.type === 'addr') r.wallets++; else r.other++;
      var k = n.type === 'addr' && known ? known(n.address) : null;
      if (k) { r.known.push(n.id); if (k.sanctions) r.sanctions++; }
    });
    r.left = r.total - r.shown;
    if (!r.left || !an) return r;
    an.tx.forEach(function (rec, id) {
      if (shown.has(id)) return;
      rec.flags.forEach(function (f) { r.patterns[f.kind] = (r.patterns[f.kind] || 0) + 1; });
      if (rec.change) r.change++;
    });
    r.peelChains = an.chains.filter(function (c) { return c.ids.some(function (id) { return !shown.has(id); }); }).length;
    r.clusters = an.clusters.list.filter(function (c) { return c.addrs.some(function (a) { return !shown.has(a); }); }).length;
    return r;
  }

  // ---- the trail as plain data -------------------------------------------------------------------------
  function endsSummary(oe, has) {
    var ends = oe.ends, named = oe.named;
    if (has) {
      ends = ends.filter(function (e) { return has(ID.tx(e.txid)) && (!e.id || has(e.id)); });
      named = named.filter(function (n) { return has(ID.tx(n.txid)) && has(n.id); });
    }
    var byName = new Map(), unchecked = 0;
    named.forEach(function (n) { var x = byName.get(n.label) || { label: n.label, count: 0, sats: 0 }; x.count++; x.sats += n.amount || 0; byName.set(n.label, x); });
    ends.forEach(function (e) { if (e.kind === 'unchecked') unchecked++; });
    return { count: ends.length, sats: ends.reduce(function (t, e) { return t + (e.amount || 0); }, 0), unchecked: unchecked, notLoaded: ends.length - unchecked,
             resting: has ? null : oe.resting, named: Array.from(byName.values()).sort(function (a, b) { return b.sats - a.sats || (a.label < b.label ? -1 : 1); }),
             rows: ends.slice(0, 20).map(function (e) { return { kind: e.kind, address: e.address, amount: e.amount, txid: e.txid, next: e.next, depth: e.depth }; }) };
  }
  /**
   * How far the trail from the reference got, as plain data for a report, the evidence summary and the command-line tool:
   *   { reference, handoffs: [...as handoffs()], openEnds: { next, prev } } where each side is { count, sats, unchecked, notLoaded, resting, named: [{ label, count, sats }], rows: [first 20] }.
   * opts: { hub, name(vertexId) -> a name (for the hand-offs: always), stop(vertexId) -> a name or null (for the open ends: the stop-at-labelled setting), max, has(vertexId) }.
   * With `has`, only what that says is shown is kept (the report: nothing outside what is on screen comes in through here), and counts are of what is kept.
   */
  function trace(idx, refId, opts) {
    opts = opts || {};
    var has = opts.has, rows = handoffs(idx, refId, { hub: opts.hub, stop: opts.name, max: opts.max });
    if (has) {
      rows = rows.filter(function (r) { return has(ID.tx(r.txid)) && has(r.id); }).map(function (r) {
        return r.wallet && !has(r.wallet) ? Object.assign({}, r, { wallet: null, walletAddress: null }) : r;
      });
    }
    return { reference: refId, handoffs: rows,
             openEnds: { next: endsSummary(openEnds(idx, refId, 'next', { stop: opts.stop, max: opts.max }), has), prev: endsSummary(openEnds(idx, refId, 'prev', { stop: opts.stop, max: opts.max }), has) } };
  }

  return { MAX_TXS: MAX_TXS, MERGE_INPUTS: MERGE_INPUTS, isHub: isHub, nameOf: nameOf, referenceOf: referenceOf, index: index, find: find, relations: relations, openEnds: openEnds,
           handoffs: handoffs, endsSuccessors: endsSuccessors, pickEnds: pickEnds, connect: connect, trace: trace, offscreen: offscreen };
}));
