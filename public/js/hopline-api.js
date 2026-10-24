/*
 * Hopline data source: an Esplora / mempool.space client with the behaviour a public API needs
 * (request queue, concurrency and spacing, timeout, retry with backoff, response cache, request cap),
 * plus the expansion operations that turn responses into graph vertices.
 *
 * `fetch` is injected so tests run without a network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-model.js'), require('./hopline-address.js'));
  else root.HoplineApi = factory(root.HoplineModel, root.HoplineAddress);
}(typeof self !== 'undefined' ? self : this, function (Model, Addr) {
  'use strict';

  var ID = Model.ID;

  var ONION = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api';
  // Tor is slow and its exit/circuit capacity is shared: fewer parallel requests, more spacing, longer timeout.
  // `prices`: where fiat prices come from when this source is chosen. Esplora servers other than mempool have no price API.
  var MEMPOOL = 'https://mempool.space/api';
  var PRESETS = {
    clearnet:   { label: 'mempool.space',                      base: MEMPOOL,                         concurrency: 4, delayMs: 150, timeoutMs: 20000, retries: 3, prices: MEMPOOL },
    tor:        { label: 'mempool.space over Tor (.onion)',    base: ONION,                           concurrency: 2, delayMs: 800, timeoutMs: 60000, retries: 3, prices: ONION },
    blockstream:{ label: 'Blockstream.info',                   base: 'https://blockstream.info/api',  concurrency: 3, delayMs: 250, timeoutMs: 25000, retries: 3, prices: MEMPOOL },
    custom:     { label: 'My own Esplora URL',                 base: '',                              concurrency: 4, delayMs: 150, timeoutMs: 30000, retries: 3, prices: null }
  };
  // A published copy (public/config.js: hosted) does not offer Tor: an .onion address cannot be reached from an https page in an ordinary browser.
  // Every place that checks a saved or requested source against PRESETS then treats "tor" as unknown and uses mempool.space.
  if (typeof self !== 'undefined' && self.HOPLINE_CONFIG && self.HOPLINE_CONFIG.hosted) delete PRESETS.tor;

  // ---- a key for a server, and the pace for your own ---------------------------------------------------------
  var DEFAULT_PACE = { concurrency: 8, delayMs: 20 };                          // your own server can take more than the public ones (4 at once, 150 ms apart)
  function clampInt(v, lo, hi, dflt) { var n = Math.round(Number(v)); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; }
  /** { concurrency, delayMs } for your own server: requests at once (1 to 32) and the pause between starts (0 to 2000 ms). */
  function cleanPace(p) { p = p && typeof p === 'object' ? p : {}; return { concurrency: clampInt(p.concurrency, 1, 32, DEFAULT_PACE.concurrency), delayMs: clampInt(p.delayMs, 0, 2000, DEFAULT_PACE.delayMs) }; }
  /** { header, value } for a key, or null when there is none. The header name is letters, digits and hyphens; the value has no control characters. */
  function cleanKey(k) {
    if (!k || typeof k !== 'object') return null;
    var value = String(k.value == null ? '' : k.value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 2000);
    if (!value) return null;
    var header = String(k.header == null ? '' : k.header).trim();
    return { header: /^[A-Za-z0-9-]{1,40}$/.test(header) ? header : 'Authorization', value: value };
  }
  /** The header to send: an Authorization key without a scheme is a Bearer token. */
  function keyHeader(k) {
    var v = k.value;
    if (/^authorization$/i.test(k.header) && !/^(bearer|basic|token)\s/i.test(v)) v = 'Bearer ' + v;
    return { name: k.header, value: v };
  }
  /**
   * The keys to send, by server: { base: { name, value } }, for a saved choice { source, customBase, fallback, keys: { source: { header, value } } }.
   * A key goes only to the server it was saved for: the backup server never gets the key of the main one.
   */
  function authFor(p) {
    p = p || {}; var out = {}, keys = p.keys && typeof p.keys === 'object' ? p.keys : {};
    function add(id, b) { var k = cleanKey(keys[id]); if (k && b) out[String(b).replace(/\/+$/, '')] = keyHeader(k); }
    add(p.source, sourceBase(p));
    var bk = backupFor(p); if (bk) add(p.source === 'clearnet' ? 'blockstream' : 'clearnet', bk.base);
    return out;
  }

  function hostOf(base) { return String(base).replace(/^https?:[/][/]/i, '').split('/')[0]; }

  /** The API base of a saved choice { source: 'clearnet' | 'tor' | 'blockstream' | 'custom', customBase }. */
  function sourceBase(p) {
    p = p || {};
    return p.source === 'custom' ? String(p.customBase || '').trim() : (PRESETS[p.source] || PRESETS.clearnet).base;
  }
  /** Where the price endpoints are for a saved choice { source, customBase, customPrices ('server' | 'mempool' | 'off') }, or null when there are none. */
  function priceBaseFor(p) {
    p = p || {};
    var preset = PRESETS[p.source] || PRESETS.custom;
    if (preset.prices) return preset.prices;
    if (p.customPrices === 'off') return null;
    if (p.customPrices === 'mempool') return PRESETS.clearnet.prices;                          // a plain Esplora has no price service: only the currency and the dates go to mempool.space
    var b = String(p.customBase || '').trim();
    return /^https?:\/\//i.test(b) ? b : null;
  }
  /** The other public server to fall back to, when the choice allows it: never for Tor (that would leave Tor) or your own server. */
  function backupFor(p) {
    p = p || {};
    if (p.fallback === false) return null;
    return p.source === 'clearnet' ? PRESETS.blockstream : p.source === 'blockstream' ? PRESETS.clearnet : null;
  }
  /**
   * A Client for a saved choice { source, customBase, fallback } with the pacing, timeout, retries and backup that go with it.
   * extra: { onRequest, onSwitch, onRestore, maxRequests } are passed on.
   */
  function buildClient(p, extra) {
    p = p || {}; extra = extra || {};
    var preset = PRESETS[p.source] || (p.source === 'custom' ? PRESETS.custom : PRESETS.clearnet), bk = backupFor(p);
    var pace = p.source === 'custom' && p.pace ? cleanPace(p.pace) : preset;                    // your own server: the pace you set; the public ones keep theirs
    return new Client({
      base: sourceBase(p), concurrency: pace.concurrency, delayMs: pace.delayMs, timeoutMs: preset.timeoutMs, retries: preset.retries,
      auth: authFor(p), keyHint: p.source === 'custom',
      backup: bk ? { base: bk.base, concurrency: bk.concurrency, delayMs: bk.delayMs } : null,
      onRequest: extra.onRequest, onSwitch: extra.onSwitch, onRestore: extra.onRestore, maxRequests: extra.maxRequests
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ApiError(message, kind, status) {
    var e = new Error(message); e.kind = kind; e.status = status; return e;
  }

  /**
   * opts: { base, concurrency, delayMs, timeoutMs, retries, maxRequests, fetch, onRequest, backup, coolMs, onSwitch, onRestore }
   * maxRequests: hard cap of network requests for this client (cache hits are free). 0/undefined = none.
   * backup: { base, concurrency, delayMs } of a second Esplora server for when this one keeps failing. A request that is throttled
   *   (429) goes to it at once, one that fails in another transient way (5xx, timeout, network) after one retry; the failing server is then
   *   not tried first for `coolMs` (default a minute), after which it gets the next request again. A "not found" is an answer and never
   *   moves a request. onSwitch({ from, to, reason, status, seconds }) and onRestore({ base }) report it; sourceOf(result) says which
   *   server answered, so each transaction can record where it came from.
   */
  function Client(opts) {
    opts = opts || {};
    this.base = String(opts.base || PRESETS.clearnet.base).replace(/\/+$/, '');
    this.concurrency = Math.max(1, opts.concurrency || 4);
    this.auth = opts.auth && typeof opts.auth === 'object' ? opts.auth : {};              // { base: { name, value } }: sent only to that server
    this.keyHint = !!opts.keyHint;
    this.delayMs = opts.delayMs == null ? 150 : opts.delayMs;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.retries = opts.retries == null ? 3 : opts.retries;
    this.maxRequests = opts.maxRequests || 0;
    this.backoffMs = opts.backoffMs == null ? 1000 : opts.backoffMs;
    this.fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    this.onRequest = opts.onRequest || null;
    var bk = opts.backup && opts.backup.base ? opts.backup : null;
    this.backup = bk ? { base: String(bk.base).replace(/\/+$/, ''), concurrency: Math.max(1, bk.concurrency || 3), delayMs: bk.delayMs == null ? 250 : bk.delayMs } : null;
    if (this.backup && this.backup.base === this.base) this.backup = null;
    this.coolMs = opts.coolMs == null ? 60000 : opts.coolMs;
    this.cool = {};                                      // base -> ms until which it is not tried first
    this.away = null;                                    // the base that was given up on and has not answered since
    this.onSwitch = opts.onSwitch || null; this.onRestore = opts.onRestore || null;
    this.served = new WeakMap();                         // response -> the base that sent it
    this.cache = new Map();                              // key -> { p: Promise, at: ms }
    this.ttlMs = opts.ttlMs == null ? 300000 : opts.ttlMs;
    this.now = opts.now || Date.now;
    this.queue = [];
    this.active = 0;
    this.lastStart = 0;
    this.aborted = false;
    this.controllers = new Set();
    this.count = { network: 0, cached: 0, failed: 0, retried: 0, backup: 0 };
    this.total = { network: 0, failed: 0, retried: 0, backup: 0 };          // since the client was made: resetCount() does not touch these
  }

  Client.prototype.abort = function () {
    this.aborted = true;
    this.controllers.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
    var q = this.queue; this.queue = [];
    q.forEach(function (j) { j.reject(ApiError('aborted', 'aborted')); });
  };
  /** Allow requests again after abort() (a new action starts). */
  Client.prototype.resume = function () { this.aborted = false; };
  Client.prototype.resetCount = function () { this.count = { network: 0, cached: 0, failed: 0, retried: 0, backup: 0 }; };

  /** Which server a new request goes to first: this one, unless it was just given up on and the backup was not. */
  Client.prototype._firstBase = function () {
    if (!this.backup) return this.base;
    var t = this.now();
    return (this.cool[this.base] || 0) > t && !((this.cool[this.backup.base] || 0) > t) ? this.backup.base : this.base;
  };
  /** The pacing that goes with a server (the backup is a different service with its own manners). */
  Client.prototype._pace = function (base) { return this.backup && base === this.backup.base ? this.backup : this; };
  /** Which server answered `result` (a response from get()); this client's own base when unknown. */
  Client.prototype.sourceOf = function (result) { return (result && typeof result === 'object' && this.served.get(result)) || this.base; };
  Client.prototype._cooldown = function (base, to, e) {
    var t = this.now(), was = (this.cool[base] || 0) > t;
    this.cool[base] = t + this.coolMs;
    if (!was) { this.away = base; if (this.onSwitch) this.onSwitch({ from: base, to: to, reason: e.kind, status: e.status, seconds: Math.round(this.coolMs / 1000) }); }
  };

  Client.prototype._pump = function () {
    var self = this;
    var pace = this._pace(this._firstBase());
    while (this.active < pace.concurrency && this.queue.length) {
      var job = this.queue.shift();
      this.active++;
      (function (j) {
        var wait = Math.max(0, self.lastStart + pace.delayMs - Date.now());
        self.lastStart = Date.now() + wait;               // reserve the slot so parallel starts are spaced too
        sleep(wait).then(function () { return self._run(j); }).then(j.resolve, j.reject).then(function () {
          self.active--; self._pump();
        });
      })(job);
    }
  };

  Client.prototype._attempt = function (base, path, text) {
    var self = this;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null, timedOut = false;
    if (ctl) { this.controllers.add(ctl); timer = setTimeout(function () { timedOut = true; ctl.abort(); }, this.timeoutMs); }
    var key = this.auth[base], headers = { 'Accept': 'application/json, text/plain' };
    if (key) headers[key.name] = key.value;
    var p = this.fetchImpl(base + path, ctl ? { signal: ctl.signal, headers: headers } : { headers: headers })
      .then(function (res) {
        if (!res.ok) {
          var err = ApiError('HTTP ' + res.status + ' for ' + path, res.status === 429 ? 'rate' : (res.status >= 500 ? 'server' : 'http'), res.status);
          if (res.status === 401 || res.status === 403) {                          // not retried: asking again with the same key will not change the answer
            err = ApiError('HTTP ' + res.status + ' for ' + path + ': ' + (key ? 'the server rejected the key' : 'the server refused the request' + (self.keyHint ? ' (if it needs a key, add one under Data source)' : '')), 'auth', res.status);
          }
          err.retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
          if (res.status === 400 || res.status === 404) err.kind = 'notfound';
          throw err;
        }
        return res.text();
      })
      .then(function (body) {
        if (text) return body.trim();
        try { return JSON.parse(body); } catch (e) { throw ApiError('invalid JSON from ' + path, 'parse'); }
      });
    return p.then(function (v) { clean(); return v; }, function (e) {
      clean();
      if (timedOut) throw ApiError('timeout after ' + self.timeoutMs + ' ms for ' + path, 'timeout');
      if (self.aborted) throw ApiError('aborted', 'aborted');
      if (e && e.kind) throw e;
      throw ApiError('network error for ' + path + (e && e.message ? ' (' + e.message + ')' : ''), 'network');
    });
    function clean() { if (timer) clearTimeout(timer); if (ctl) self.controllers.delete(ctl); }
  };

  Client.prototype._run = function (job) {
    var self = this, tries = 0, base = this._firstBase(), other = !this.backup ? null : base === this.base ? this.backup.base : this.base, moved = false;
    function go() {
      if (self.aborted) return Promise.reject(ApiError('aborted', 'aborted'));
      if (self.maxRequests && self.count.network >= self.maxRequests) return Promise.reject(ApiError('request cap of ' + self.maxRequests + ' reached', 'cap'));
      self.count.network++; self.total.network++;
      if (self.backup && base === self.backup.base) { self.count.backup++; self.total.backup++; }
      if (self.onRequest) self.onRequest(job.path, self.count);
      return self._attempt(base, job.path, job.text).then(function (v) {
        if (v && typeof v === 'object') self.served.set(v, base);
        if (self.away === base) { self.away = null; if (self.onRestore) self.onRestore({ base: base }); }
        return v;
      }, function (e) {
        var retryable = e.kind === 'rate' || e.kind === 'server' || e.kind === 'timeout' || e.kind === 'network';
        if (retryable && other && !moved && (e.kind === 'rate' || tries >= 1)) {            // this server keeps failing: the other one takes this request, and the next ones for a while
          self._cooldown(base, other, e); base = other; moved = true; tries = 0;
          return go();
        }
        if (!retryable || tries >= self.retries) { self.count.failed++; self.total.failed++; throw e; }
        tries++; self.count.retried++; self.total.retried++;
        var delay = Math.max(e.retryAfter ? e.retryAfter * 1000 : 0, self.backoffMs * Math.pow(2, tries - 1));
        return sleep(delay).then(go);
      });
    }
    return go();
  };

  /** GET path (relative to base). Cached per client; concurrent identical requests share one call. */
  Client.prototype.get = function (path, text) {
    var self = this, key = (text ? 'T ' : 'J ') + path;
    var hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) { this.count.cached++; return hit.p; }
    if (this.aborted) return Promise.reject(ApiError('aborted', 'aborted'));
    var p = new Promise(function (resolve, reject) {
      self.queue.push({ path: path, text: !!text, resolve: resolve, reject: reject });
      self._pump();
    });
    var entry = { p: p, at: this.now() };
    this.cache.set(key, entry);
    p.catch(function () { if (self.cache.get(key) === entry) self.cache.delete(key); });          // never cache a failure
    return p;
  };

  Client.prototype.tx = function (txid) { return this.get('/tx/' + encodeURIComponent(txid)); };
  Client.prototype.outspends = function (txid) { return this.get('/tx/' + encodeURIComponent(txid) + '/outspends'); };
  Client.prototype.address = function (a) { return this.get('/address/' + encodeURIComponent(a)); };
  Client.prototype.addressTxs = function (a, afterTxid) {
    return this.get('/address/' + encodeURIComponent(a) + '/txs' + (afterTxid ? '/chain/' + encodeURIComponent(afterTxid) : ''));
  };
  /** Today's prices in every supported currency (mempool.space API). */
  Client.prototype.prices = function () { return this.get('/v1/prices'); };
  /** The whole price history for a currency: one request, ~25,000 points (see hopline-price.js). */
  Client.prototype.historicalPrices = function (currency) { return this.get('/v1/historical-price?currency=' + encodeURIComponent(currency)); };
  Client.prototype.tipHeight = function () { return this.get('/blocks/tip/height', true).then(Number); };

  // ---- expansion ------------------------------------------------------------------------------
  function isTxid(s) { return /^[0-9a-fA-F]{64}$/.test(s || ''); }

  /**
   * Turns what was typed or pasted into {kind:'tx'|'addr', value} or null. Tolerates surrounding spaces, a
   * `bitcoin:` URI, and capitalisation: bech32 addresses (bc1...) are case-insensitive but the API rejects mixed case
   * (autocorrect often capitalises the first letter), so they are lower-cased; base58 addresses are case-sensitive
   * and left alone.
   */
  function normaliseQuery(q) {
    q = String(q == null ? '' : q).trim().replace(/^bitcoin:/i, '').split(/[?#]/)[0].trim();
    var link = /\/(?:address|tx)\/([A-Za-z0-9]+)\/?$/.exec(q);          // https://mempool.space/address/BC1Q... , blockstream.info/tx/...
    if (link) q = link[1];
    if (isTxid(q)) return { kind: 'tx', value: q.toLowerCase() };
    if (/^(bc1|tb1|bcrt1)[0-9a-z]{6,}$/i.test(q)) return { kind: 'addr', value: Addr.normalise(q) };
    if (/^[A-Za-z0-9]{14,90}$/.test(q)) return { kind: 'addr', value: q };
    return null;
  }

  /** normaliseQuery plus a local check of the address checksum: {ok:true, kind, value} or {ok:false, message}. */
  function checkQuery(q) {
    var n = normaliseQuery(q);
    if (!n) return { ok: false, message: 'That does not look like a transaction id (64 hex characters) or a Bitcoin address.' };
    if (n.kind === 'addr') {
      var v = Addr.validate(n.value);
      if (!v.ok) return { ok: false, message: Addr.explain(v) };
    }
    return { ok: true, kind: n.kind, value: n.value };
  }

  /**
   * Explorer: turns API responses into graph content. Every operation resolves to
   * { added: <new vertices>, requests: <network calls>, truncated: bool, errors: [string] } and never rejects
   * for a single failed request: a partial result is better than none, and errors are reported.
   */
  function Explorer(client, graph) { this.client = client; this.graph = graph; }

  /**
   * Put a fetched transaction into the graph and note where and when it came from (`source` = the API base, `fetchedAt` =
   * unix seconds): what an investigator needs to say "I saw this at that time, from that server".
   */
  Explorer.prototype._ingest = function (t, from) {
    var id = this.graph.addTx(t), n = this.graph.nodes.get(id);
    if (n) { n.source = srcOf(this, from || t); n.fetchedAt = Math.floor(Date.now() / 1000); }
    return id;
  };
  /** The server that answered `result`: with a backup configured that is not always the client's own base. */
  function srcOf(ex, result) { return ex.client.sourceOf ? ex.client.sourceOf(result) : ex.client.base; }

  /** Put an outspends answer into the graph and note when it was read: "unspent" is only true as of that time. */
  Explorer.prototype._spends = function (txid, o) {
    this.graph.addOutspends(txid, o);
    var n = this.graph.nodes.get(ID.tx(txid));
    if (n) n.spendsCheckedAt = Math.floor(Date.now() / 1000);
  };

  function summarise(ex, before, errors, truncated) {
    return { added: ex.graph.nodes.size - before.n, addedEdges: ex.graph.edges.size - before.e,
             requests: ex.client.count.network - before.r, truncated: !!truncated, errors: errors };
  }
  function snap(ex) { return { n: ex.graph.nodes.size, e: ex.graph.edges.size, r: ex.client.count.network }; }
  function note(errors, e) { if (e && e.kind !== 'aborted') errors.push(e.message); return e && e.kind === 'aborted'; }

  /** Load one transaction and which of its outputs are spent. */
  Explorer.prototype.loadTx = function (txid) {
    var ex = this, before = snap(this), errors = [];
    return this.client.tx(txid).then(function (t) {
      ex._ingest(t);
      return ex.client.outspends(txid).then(function (o) { ex._spends(txid, o); }, function (e) { note(errors, e); });
    }).then(function () { return summarise(ex, before, errors, false); }, function (e) {
      note(errors, e); var r = summarise(ex, before, errors, false); r.failed = true; return r;
    });
  };

  // Fetch a list of full transactions (capped) into the graph. Resolves with how many were left out.
  Explorer.prototype._loadMany = function (txids, cap, errors, withOutspends) {
    var ex = this, todo = [], left = 0;
    txids.forEach(function (id) {
      var n = ex.graph.nodes.get(ID.tx(id));
      if (n && n.loaded) return;
      if (cap > 0 && todo.length >= cap) { left++; return; }
      todo.push(id);
    });
    return Promise.all(todo.map(function (id) {
      return ex.client.tx(id).then(function (t) {
        ex._ingest(t);
        if (withOutspends) return ex.client.outspends(id).then(function (o) { ex._spends(id, o); });
      }).catch(function (e) { note(errors, e); });
    })).then(function () { return left; });
  };

  /** Load full transactions (at most `cap`; with their outspends when asked). Resolves with the usual summary. */
  Explorer.prototype.loadMany = function (txids, cap, withOutspends) {
    var ex = this, before = snap(this), errors = [];
    return this._loadMany(txids, cap, errors, !!withOutspends).then(function (left) { return summarise(ex, before, errors, left > 0); });
  };

  /**
   * Expand a transaction. direction: 'forward' (who spent its outputs), 'backward' (what funded it), 'both'.
   * cap = at most this many transactions are fetched per direction.
   */
  Explorer.prototype.expandTx = function (txid, direction, cap) {
    var ex = this, before = snap(this), errors = [], truncated = false;
    direction = direction || 'both'; cap = cap == null ? 25 : cap;
    var node = this.graph.nodes.get(ID.tx(txid));
    var ready = node && node.loaded ? Promise.resolve() : this.loadTx(txid).then(function () { node = ex.graph.nodes.get(ID.tx(txid)); });
    return ready.then(function () {
      var jobs = [];
      if ((direction === 'forward' || direction === 'both') && node) {
        var p = node.outspendsLoaded ? Promise.resolve() : ex.client.outspends(txid).then(function (o) { ex._spends(txid, o); }).catch(function (e) { note(errors, e); });
        jobs.push(p.then(function () {
          var spenders = [];
          ex.graph.edgesOf(ID.tx(txid)).forEach(function (e) { if (e.kind === 'out' && e.source === ID.tx(txid) && e.spentBy) spenders.push(e.spentBy.txid); });
          return ex._loadMany(spenders, cap, errors, false).then(function (left) { if (left) truncated = true; });
        }));
      }
      if ((direction === 'backward' || direction === 'both') && node && !node.coinbase) {
        var funders = [];
        ex.graph.edgesOf(ID.tx(txid)).forEach(function (e) { if (e.kind === 'in' && e.target === ID.tx(txid) && e.prev) funders.push(e.prev.txid); });
        jobs.push(ex._loadMany(funders, cap, errors, true).then(function (left) { if (left) truncated = true; }));
      }
      return Promise.all(jobs);
    }).then(function () { return summarise(ex, before, errors, truncated); });
  };

  /**
   * Walk outward from transactions, one level at a time, loading what each step needs. The caller decides where to go:
   *   opts.dir         'next' (who spent the outputs) or 'prev' (what funded the inputs)
   *   opts.hops        how many levels beyond the start to load (at least 1)
   *   opts.maxTx       the most NEW transactions to load in total (stops there, keeping what was loaded)
   *   opts.successors  (txid, level) -> { next: [txid], stop: reason|null }, called once per loaded transaction; for 'next' its
   *                    outspends are loaded first, so the spenders are known. The last level is loaded but not asked.
   * Resolves with the usual summary plus
   *   levels   [[txid]] the transactions loaded at each level (level 0 = the start)
   *   stops    [{txid, reason}] where the walk ended on its own
   *   asked    [{txid, level}] the transactions `successors` was asked about, in order
   *   loadedNew, left (transactions known but not loaded because of the cap), reason: 'done' | 'cap-tx' | 'cap-requests' | 'cancelled'
   * Stops between levels when the client was aborted or hit its request cap, so a cancel keeps everything loaded so far.
   */
  Explorer.prototype.walk = function (start, opts) {
    var ex = this, before = snap(this), errors = [], dir = opts.dir === 'prev' ? 'prev' : 'next';
    var hops = Math.max(1, opts.hops | 0), maxTx = opts.maxTx > 0 ? opts.maxTx : 1e9;
    var levels = [], stops = [], asked = [], visited = new Set(), newLoaded = 0, left = 0, reason = 'done';
    var level = [];
    (start || []).forEach(function (t) { if (level.indexOf(t) < 0) level.push(t); });

    function loaded(id) { var n = ex.graph.nodes.get(ID.tx(id)); return !!(n && n.loaded); }
    function ensure(ids, withOut) {
      var budget = maxTx - newLoaded, allowed = new Set();
      ids.forEach(function (id) {
        if (loaded(id)) allowed.add(id);
        else if (budget > 0) { allowed.add(id); budget--; }
        else left++;
      });
      return Promise.all(ids.filter(function (id) { return allowed.has(id); }).map(function (id) {
        var have = loaded(id);
        var p = have ? Promise.resolve() : ex.client.tx(id).then(function (t) { ex._ingest(t); newLoaded++; });
        return p.then(function () {
          var n = ex.graph.nodes.get(ID.tx(id));
          if (withOut && n && n.loaded && !n.outspendsLoaded) return ex.client.outspends(id).then(function (o) { ex._spends(id, o); });
        }).catch(function (e) { note(errors, e); });
      })).then(function () { return ids.filter(loaded); });
    }
    function interrupted() {
      if (ex.client.aborted) { reason = 'cancelled'; return true; }
      if (errors.some(function (m) { return /request cap/.test(m); })) { reason = 'cap-requests'; return true; }
      return false;
    }
    function go(h) {
      if (!level.length) return Promise.resolve();
      return ensure(level, dir === 'next' && h < hops).then(function (ids) {
        levels.push(ids);
        if (interrupted()) return;
        if (h >= hops) return;
        var nextLevel = [];
        ids.forEach(function (id) {
          if (visited.has(id)) return;
          visited.add(id); asked.push({ txid: id, level: h });
          var r = opts.successors(id, h) || {};
          if (r.stop) stops.push({ txid: id, reason: r.stop });
          (r.next || []).forEach(function (x) { if (!visited.has(x) && nextLevel.indexOf(x) < 0) nextLevel.push(x); });
        });
        level = nextLevel;
        return go(h + 1);
      });
    }
    return go(0).catch(function (e) { note(errors, e); }).then(function () {
      if (reason === 'done' && left > 0) reason = 'cap-tx';
      var r = summarise(ex, before, errors, left > 0);
      r.levels = levels; r.stops = stops; r.asked = asked; r.loadedNew = newLoaded; r.left = left; r.reason = reason;
      return r;
    });
  };

  /**
   * Expand an address: its transaction history, newest first, 25 per page.
   * opts: { pages (default 1), cap (max txs added, default 100), after (txid to continue from) }
   * Resolves with .last = txid to continue from (null when the history is exhausted) and .total = chain tx count.
   */
  Explorer.prototype.expandAddress = function (addr, opts) {
    opts = opts || {};
    var ex = this, before = snap(this), errors = [], truncated = false;
    var pages = opts.pages || 1, cap = opts.cap == null ? 100 : opts.cap, added = 0, total = null, last = opts.after || null;
    var node = ex.graph.nodes.get(ID.addr(addr));
    if (!node) ex.graph.upsertNode({ id: ID.addr(addr), type: 'addr', address: addr });

    function step(page) {
      if (page >= pages) return Promise.resolve();
      return ex.client.addressTxs(addr, last).then(function (txs) {
        for (var i = 0; i < txs.length; i++) {
          if (cap > 0 && added >= cap) { truncated = true; return; }
          ex._ingest(txs[i], txs); added++;
          last = txs[i].txid;
        }
        if (txs.length < 25) { last = null; return; }
        if (cap > 0 && added >= cap) { truncated = true; return; }
        return step(page + 1);
      });
    }
    var stats = opts.after ? Promise.resolve(true) : ex.client.address(addr).then(function (a) {
      total = (a.chain_stats ? a.chain_stats.tx_count : 0) + (a.mempool_stats ? a.mempool_stats.tx_count : 0);
      ex.graph.addAddressStats(addr, a, { at: Math.floor(Date.now() / 1000), source: srcOf(ex, a) });
      return true;
    }, function (e) {
      if (e && (e.status === 400 || e.kind === 'notfound')) errors.push('"' + addr + '" is not a valid Bitcoin address (the server rejected it)');
      else note(errors, e);
      return false;                                          // without the summary the history request would only fail too
    });
    return stats.then(function (ok) { return ok ? step(0) : null; }).catch(function (e) { note(errors, e); }).then(function () {
      var me = ex.graph.nodes.get(ID.addr(addr));
      if (me && ex.graph.edgesOf(me.id).length === 0 && errors.length) ex.graph.removeNode(me.id);   // a failed lookup leaves nothing behind
      var r = summarise(ex, before, errors, truncated);
      r.last = last; r.total = total; r.addedTx = added;
      return r;
    });
  };

  /**
   * Read the totals the server keeps for each address (what it received and spent, so what it holds now): one request each,
   * no history. At most `cap` addresses (the rest are counted in `truncated`). Resolves with the usual summary.
   */
  Explorer.prototype.loadBalances = function (addrs, cap) {
    var ex = this, before = snap(this), errors = [], todo = [], left = 0;
    addrs.forEach(function (a) {
      if (todo.indexOf(a) >= 0) return;
      if (cap > 0 && todo.length >= cap) { left++; return; }
      todo.push(a);
    });
    return Promise.all(todo.map(function (a) {
      return ex.client.address(a).then(function (s) { ex.graph.addAddressStats(a, s, { at: Math.floor(Date.now() / 1000), source: srcOf(ex, s) }); }, function (e) { note(errors, e); });
    })).then(function () { return summarise(ex, before, errors, left > 0); });
  };

  /** Search box: a 64-hex string is a transaction, anything else is treated as an address. */
  Explorer.prototype.open = function (query, opts) {
    var q = normaliseQuery(query) || { kind: 'addr', value: String(query || '').trim() };
    if (q.kind === 'tx') return this.loadTx(q.value).then(function (r) { r.kind = 'tx'; r.id = ID.tx(q.value); return r; });
    return this.expandAddress(q.value, opts).then(function (r) { r.kind = 'addr'; r.id = ID.addr(q.value); return r; });
  };

  return { Client: Client, Explorer: Explorer, PRESETS: PRESETS, ONION: ONION, buildClient: buildClient, priceBaseFor: priceBaseFor, authFor: authFor, cleanKey: cleanKey, cleanPace: cleanPace, DEFAULT_PACE: DEFAULT_PACE, sourceBase: sourceBase, backupFor: backupFor, hostOf: hostOf, isTxid: isTxid, normaliseQuery: normaliseQuery, checkQuery: checkQuery, ApiError: ApiError };
}));
