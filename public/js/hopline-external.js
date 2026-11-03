/*
 * Hopline external lookups: ask a third-party service about wallets, on request. Never run over the whole graph.
 *
 * ONE CONTRACT FOR EVERY SOURCE. A source is registered with register({ id, name, short, third, ready(ctx), lookup(address, ctx), clean(ext), describe(ext), fields(ext), headline(ext) }):
 *   lookup   Promise<{ found, ext }> for one address; `ext` is what is kept on the wallet, under node.ext[id], one entry per source.
 *   clean    validates an `ext` read from a file (unknown fields are dropped); the entries a file carries for sources that are not registered are dropped.
 *   describe the same plain-text claim for every source: { found, label, category, tags, note, suggest (a tag preset id or ''), at }. A claim, never a fact.
 *   third    true (the default) when the address leaves this computer: lookupMany then refuses to run unless the caller's confirm() says yes, every time it is called.
 * lookupMany(id, addresses, opts) is the one way to ask: sequential, paced by the source, stopped by the first error that would repeat (token, key, rate, proxy, timeout), and
 * never applying anything: what it returns is stored by the caller and applied by the person, with a button. entries(node) reads every stored result the same way, for the
 * details, the report and the exports. A pack (a list that comes with the page or that you import) is the offline kind of source and lives in hopline-packs.js.
 *
 * Arkham Intelligence has no CORS headers, so a web page cannot call it. The lookup goes to a small local proxy
 * (tools/arkham_proxy.py) that holds the API key in an environment variable and forwards only
 * GET /intelligence/address/<address>. This module builds that request and reads the reply.
 *
 * The reply is parsed from Arkham's documented field names (arkhamEntity, arkhamLabel, populatedTags, predictedEntity).
 * Their reference could not be read when this was written and no live key was available, so the parser is tolerant, the
 * raw reply is always kept, and nothing is applied to a wallet automatically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-tags.js'));
  else root.HoplineExternal = factory(root.HoplineTags);
}(typeof self !== 'undefined' ? self : this, function (Tags) {
  'use strict';

  var SOURCES = { arkham: { id: 'arkham', name: 'Arkham Intelligence' } };
  var ARKHAM_EXPLORER = 'https://arkm.com/explorer/';                                    // Arkham's own site (intel.arkm.com sends visitors there)
  var RAW_LIMIT = 4000;

  function text(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  /** The object that carries the intelligence: the reply itself, or the first value inside it that does. */
  function pick(json) {
    if (!isObj(json)) return null;
    var keys = ['arkhamEntity', 'arkhamLabel', 'populatedTags', 'predictedEntity', 'entity', 'label'];
    if (keys.some(function (k) { return k in json; })) return json;
    var vals = Object.keys(json).map(function (k) { return json[k]; });
    for (var i = 0; i < vals.length; i++) if (isObj(vals[i]) && keys.some(function (k) { return k in vals[i]; })) return vals[i];
    return json;
  }

  /** Read an Arkham address reply into plain text fields. `found` is false when it names nobody. */
  function parseArkham(json) {
    var o = pick(json) || {};
    var ent = isObj(o.arkhamEntity) ? o.arkhamEntity : isObj(o.entity) ? o.entity : {};
    var lab = isObj(o.arkhamLabel) ? o.arkhamLabel : isObj(o.label) ? o.label : {};
    var pred = isObj(o.predictedEntity) ? o.predictedEntity : {};
    var tags = (Array.isArray(o.populatedTags) ? o.populatedTags : []).map(function (t) {
      return isObj(t) ? text(t.label || t.id || t.name, 40) : text(t, 40);
    }).filter(Boolean).slice(0, 12);
    var out = { name: text(ent.name), type: text(ent.type, 40), label: text(lab.name), tags: tags, website: text(ent.website, 200), note: text(ent.note, 300),
                predicted: text(pred.name || (isObj(pred.entity) ? pred.entity.name : '')) };
    out.found = !!(out.name || out.label || out.tags.length || out.predicted);
    return out;
  }

  /** A preset tag id that fits an Arkham entity type or name, or ''. A suggestion only: the user decides. */
  function tagFor(type, name) {
    var s = (text(type, 40) + ' ' + text(name, 80)).toLowerCase();
    if (/mixer|tumbl|coinjoin/.test(s)) return 'MIXER';
    if (/hack|exploit|scam|ransom|thief|stolen|threat|sanction|lazarus|darknet\s*market/.test(s)) return /market/.test(s) && !/hack|scam|ransom/.test(s) ? 'MARKET' : 'THREAT';
    if (/market/.test(s)) return 'MARKET';
    if (/gambl|casino|betting|\bbet\b/.test(s)) return 'GAMBLING';
    if (/\bcex\b|exchange|binance|coinbase|kraken|okx|bitfinex|huobi|kucoin|bybit|bitstamp|gemini/.test(s)) return 'EXCH';
    if (/payment|merchant|processor|\bpay\b/.test(s)) return 'SERVICE';
    return '';
  }

  /** The entry that is stored on a wallet: parsed fields, when, and (capped) the raw reply for the record. */
  function toExt(json, at) {
    var p = parseArkham(json), raw = '';
    try { raw = JSON.stringify(json); } catch (e) { raw = ''; }
    if (raw.length > RAW_LIMIT) raw = raw.slice(0, RAW_LIMIT) + '…';
    p.at = typeof at === 'number' ? at : Math.floor(Date.now() / 1000);
    p.raw = raw;
    p.suggest = tagFor(p.type, p.name || p.label);
    return p;
  }

  /** Validate the Arkham entry of an `ext` read from a file. */
  function cleanArkham(a) {
    if (!isObj(a)) return null;
    var c = { found: a.found === true, name: text(a.name), type: text(a.type, 40), label: text(a.label), website: text(a.website, 200), note: text(a.note, 300),
              predicted: text(a.predicted), at: typeof a.at === 'number' && isFinite(a.at) ? Math.floor(a.at) : 0, raw: typeof a.raw === 'string' ? a.raw.slice(0, RAW_LIMIT + 1) : '',
              tags: (Array.isArray(a.tags) ? a.tags : []).map(function (t) { return text(t, 40); }).filter(Boolean).slice(0, 12) };
    c.suggest = Tags.preset(a.suggest) ? a.suggest : '';
    return c;
  }
  /** Validate an `ext` object read from a file: each registered source cleans its own entry; unknown sources and unknown fields are dropped. */
  function cleanExt(ext) {
    if (!isObj(ext)) return null;
    var out = {};
    REG.forEach(function (d, id) { if (isObj(ext[id])) { var c = d.clean(ext[id]); if (c) out[id] = c; } });
    return Object.keys(out).length ? out : null;
  }

  function fail(kind, message, status) { var e = new Error(message); e.kind = kind; e.status = status; return e; }

  /**
   * Ask the proxy about one address. Resolves { found, ext } (found false when Arkham knows nothing); rejects with
   * an Error whose .kind is 'proxy' | 'token' | 'rate' | 'key' | 'upstream' | 'timeout' | 'bad'.
   * opts: { fetch, base, token, address, timeoutMs }
   */
  function lookupArkham(opts) {
    var base = String(opts.base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.reject(fail('proxy', 'Enter the address of the lookup proxy first.'));
    if (!opts.token) return Promise.reject(fail('token', 'Enter the proxy token first (it is printed when the proxy starts).'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = null, timedOut = false;
    if (ctl) timer = setTimeout(function () { timedOut = true; ctl.abort(); }, opts.timeoutMs || 25000);
    return opts.fetch(base + '/intelligence/address/' + encodeURIComponent(opts.address), { headers: { 'X-Hopline-Token': opts.token, 'Accept': 'application/json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (body) {
          var json = null; try { json = JSON.parse(body); } catch (e) { json = null; }
          var msg = json && typeof json.error === 'string' ? text(json.error, 300) : '';
          if (res.status === 404) return { found: false, ext: toExt({}, undefined) };
          if (res.status === 401) throw fail('token', msg || 'The proxy rejected the token.', 401);
          if (res.status === 429) throw fail('rate', msg || 'Rate limit reached: wait a moment and try again.', 429);
          if (res.status === 403 || res.status === 502 && /key/i.test(msg)) throw fail('key', msg || 'Arkham rejected the API key.', res.status);
          if (!res.ok) throw fail('upstream', msg || 'The lookup failed (HTTP ' + res.status + ').', res.status);
          if (json === null) throw fail('bad', 'The proxy answered with something that is not JSON.', res.status);
          var ext = toExt(json);
          return { found: ext.found, ext: ext };
        });
      }, function (e) {
        if (timedOut) throw fail('timeout', 'The proxy did not answer in time.');
        throw fail('proxy', 'Could not reach the proxy at ' + base + '. Is tools/arkham_proxy.py running? (' + (e && e.message ? e.message : e) + ')');
      }).then(function (v) { if (timer) clearTimeout(timer); return v; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /**
   * The address of Arkham's page for a wallet (kind 'address') or a Bitcoin transaction (kind 'tx'), to open in a new tab, or '' for anything else.
   * No key and no proxy: it is a link, and the page is Arkham's (with the visitor's own Arkham account if they are signed in). Opening it tells Arkham
   * which wallet or transaction is being looked at, so the pages offer it only when the data source is not Tor.
   */
  function arkhamUrl(kind, id) {
    id = typeof id === 'string' ? id : '';
    if (kind === 'address' && /^[A-Za-z0-9]{14,90}$/.test(id)) return ARKHAM_EXPLORER + 'address/' + id;
    if (kind === 'tx' && /^[0-9a-fA-F]{64}$/.test(id)) return ARKHAM_EXPLORER + 'tx/' + id.toLowerCase();
    return '';
  }

  /** GET /health on the proxy: { ok, keyConfigured, upstream }. */
  function proxyHealth(opts) {
    var base = String(opts.base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.reject(fail('proxy', 'Enter the address of the lookup proxy first.'));
    return opts.fetch(base + '/health', { headers: { 'X-Hopline-Token': opts.token || '' } }).then(function (res) {
      if (res.status === 401) throw fail('token', 'The proxy is running but rejected the token.', 401);
      if (!res.ok) throw fail('proxy', 'The proxy answered HTTP ' + res.status + '.', res.status);
      return res.json();
    }, function (e) { throw fail('proxy', 'Could not reach the proxy at ' + base + '. Is tools/arkham_proxy.py running? (' + (e && e.message ? e.message : e) + ')'); });
  }

  // ---- the registry: one contract for every source -------------------------------------------------------------------
  var REG = new Map();
  /** Add a source. A source without `clean` or `describe` cannot be stored or shown, so it is refused. */
  function register(def) {
    if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(def.id)) throw new Error('A source needs an id of lower case letters, digits and hyphens.');
    ['lookup', 'clean', 'describe'].forEach(function (f) { if (typeof def[f] !== 'function') throw new Error('The source "' + def.id + '" needs a ' + f + '() function.'); });
    var d = Object.assign({ name: def.id, short: '', third: true }, def);
    d.short = d.short || d.name;
    REG.set(d.id, d);
    SOURCES[d.id] = { id: d.id, name: d.name };
    return d;
  }
  function unregister(id) { REG.delete(id); delete SOURCES[id]; }
  function source(id) { return REG.get(id) || null; }
  /** The registered sources, in the order they were added: [{ id, name, short, third }]. */
  function list() { return Array.from(REG.values()).map(function (d) { return { id: d.id, name: d.name, short: d.short, third: d.third !== false }; }); }
  /** What a stored result says, the same for every source: { source, sourceName, found, label, category, tags[], note, suggest, at }, or null for an unknown source. */
  function describe(id, ext) {
    var d = REG.get(id); if (!d || !isObj(ext)) return null;
    var c = d.describe(ext) || {};
    return { source: id, sourceName: d.name, found: c.found === true, label: text(c.label, 200), category: text(c.category, 60), tags: (Array.isArray(c.tags) ? c.tags : []).map(function (t) { return text(t, 40); }).filter(Boolean).slice(0, 12),
             note: text(c.note, 300), suggest: Tags.preset(c.suggest) ? c.suggest : '', at: typeof c.at === 'number' && isFinite(c.at) ? c.at : 0 };
  }
  /** Every stored result on a wallet vertex, described: [{ source, sourceName, address, found, label, category, tags, note, suggest, at }], in the order of the registry. */
  function entries(node) {
    var out = []; if (!node || !isObj(node.ext)) return out;
    REG.forEach(function (d, id) {
      if (!isObj(node.ext[id])) return;
      var c = describe(id, node.ext[id]); if (c) { c.address = node.address || ''; out.push(c); }
    });
    return out;
  }
  var FATAL = { token: 1, key: 1, rate: 1, proxy: 1, timeout: 1, setup: 1 };      // errors that would repeat for the next address: the run stops at the first
  /**
   * Ask a source about some wallets, one after the other. opts: { ctx (what the source needs: fetch, the proxy and token ...), confirm(def, addresses) -> true to go on,
   * cancelled() -> true to stop, onResult(result) }. A source that sends addresses to a third party is not asked without a confirm() that returns true.
   * Resolves { results: [{ address, found, ext, error }], stopped: null | 'declined' | 'cancelled' | 'failed', error } and never applies anything.
   */
  function lookupMany(id, addresses, opts) {
    opts = opts || {};
    var d = REG.get(id);
    if (!d) return Promise.reject(fail('bad', 'Unknown source "' + id + '".'));
    var seen = {}, list = (addresses || []).filter(function (a) { return typeof a === 'string' && a && !seen[a] && (seen[a] = 1); });
    if (!list.length) return Promise.resolve({ results: [], stopped: null, error: null });
    var miss = typeof d.ready === 'function' ? d.ready(opts.ctx || {}) : '';
    if (miss) return Promise.reject(fail('setup', miss));
    if (d.third !== false && (typeof opts.confirm !== 'function' || opts.confirm(d, list) !== true)) return Promise.resolve({ results: [], stopped: 'declined', error: null });
    var results = [], stopped = null, error = null, i = 0;
    return (function step() {
      if (i >= list.length) return Promise.resolve({ results: results, stopped: stopped, error: error });
      if (typeof opts.cancelled === 'function' && opts.cancelled()) { stopped = 'cancelled'; return Promise.resolve({ results: results, stopped: stopped, error: error }); }
      var a = list[i++];
      return d.lookup(a, opts.ctx || {}).then(function (r) {
        var res = { address: a, found: !!r.found, ext: r.ext, error: null }; results.push(res); if (opts.onResult) opts.onResult(res);
      }, function (e) {
        var res = { address: a, found: false, ext: null, error: e }; results.push(res); if (opts.onResult) opts.onResult(res);
        if (e && FATAL[e.kind]) { stopped = 'failed'; error = e; }
      }).then(function () { return stopped ? { results: results, stopped: stopped, error: error } : step(); });
    }());
  }

  register({
    id: 'arkham', name: 'Arkham Intelligence', short: 'Arkham', third: true,
    ready: function (ctx) { return !ctx.token ? 'Set up the lookup proxy first (Controls › External sources): run tools/arkham_proxy.py and enter its URL and token.' : ''; },
    lookup: function (address, ctx) { return lookupArkham({ fetch: ctx.fetch, base: ctx.proxy, token: ctx.token, address: address }); },
    clean: cleanArkham,
    describe: function (a) { return { found: a.found === true, label: [a.name, a.label].filter(Boolean).join(' · '), category: a.type, tags: a.tags, note: a.note, suggest: a.suggest, at: a.at }; },
    headline: function (a) { return (a.name || a.label || 'tagged wallet') + (a.type ? ' (' + a.type + ')' : ''); },
    fields: function (a) { return [['Entity', a.name], ['Type', a.type], ['Label', a.label], ['Tags', (a.tags || []).join(', ')], ['Predicted', a.predicted], ['Website', a.website], ['Note', a.note]]; }
  });

  return { SOURCES: SOURCES, register: register, unregister: unregister, source: source, list: list, describe: describe, entries: entries, lookupMany: lookupMany, parseArkham: parseArkham, tagFor: tagFor, toExt: toExt, cleanExt: cleanExt, lookupArkham: lookupArkham, proxyHealth: proxyHealth, arkhamUrl: arkhamUrl, ARKHAM_EXPLORER: ARKHAM_EXPLORER, RAW_LIMIT: RAW_LIMIT };
}));
