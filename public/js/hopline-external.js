/*
 * Hopline external lookups: ask a third-party service about wallets, on request. Never run over the whole graph.
 *
 * ONE CONTRACT FOR EVERY SOURCE. A source is registered with register({ id, name, short, third, ready(ctx), lookup(address, ctx), clean(ext), describe(ext), fields(ext), headline(ext) }):
 *   lookup   Promise<{ found, ext }> for one address; `ext` is what is kept on the wallet, under node.ext[id], one entry per source.
 *   clean    validates an `ext` read from a file (unknown fields are dropped); the entries a file carries for sources that are not registered are dropped.
 *   describe the same plain-text claim for every source: { found, label, category, tags, note, suggest (a tag preset id or ''), at }. A claim, never a fact.
 *   third    true (the default) when the address leaves this computer: lookupMany then refuses to run unless the caller's confirm() says yes, every time it is called.
 *   kind     'addr' (the default: lookup takes a wallet's address, the result is kept on the wallet) or 'tx' (it takes a transaction id and the result is kept on the transaction).
 *   paceMs   milliseconds to wait between two requests of one run (a source with a low request limit sets it).
 *   ask      what the buttons say (kind 'tx'): { button, again, tip }; kinds: { good, none } the words for the two kinds of answer; useful(ext) tells which kind it was; manyId the id of the button
 *            for several selected transactions; host the address a request goes to (named in the question); report 'firstseen' puts its answers in the report's table of first-seen times.
 *   fields(ext) rows are [label, value] or [label, value, text to copy]: a row with a third value gets a copy button beside it.
 *   label and intro head and introduce the source's section when several transactions are selected; ask.many (with %s for the count) and ask.manyTip are the button for them.
 *   Another source for transactions is chainwindow (hopline-timewindow.js): not a third party, it asks the data source in use for the blocks before a transaction's block.
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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-tags.js'), require('./hopline-timewindow.js'));
  else root.HoplineExternal = factory(root.HoplineTags, root.HoplineTimeWindow);
}(typeof self !== 'undefined' ? self : this, function (Tags, TW) {
  'use strict';

  var SOURCES = { arkham: { id: 'arkham', name: 'Arkham Intelligence' } };
  var ARKHAM_EXPLORER = 'https://arkm.com/explorer/';                                    // Arkham's own site (intel.arkm.com sends visitors there)
  var RAW_LIMIT = 4000;
  var BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/btc/main';
  var MIN_TIME = 1230768000, MAX_TIME = 4102444800;                                    // 2009 .. 2100: a time outside it is not a time

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
  /** Validate an `ext` object read from a file: each registered source cleans its own entry; unknown sources and unknown fields are dropped. With `kind` ('addr' or 'tx') only the sources of that kind are kept. */
  function cleanExt(ext, kind) {
    if (!isObj(ext)) return null;
    var out = {};
    REG.forEach(function (d, id) { if (kind && d.kind !== kind) return; if (isObj(ext[id])) { var c = d.clean(ext[id]); if (c) out[id] = c; } });
    return Object.keys(out).length ? out : null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

  var RELAY_PAGE = 'https://relay.link/transaction/';
  /**
   * Relay's page for a request ID (the "0x" and 64 hex digits some Bitcoin payments carry in an OP_RETURN), or ''. Opening it tells Relay which request you are looking at, so the
   * pages offer it only when the data source is not Tor.
   */
  function relayUrl(id) { return typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id) ? RELAY_PAGE + id.toLowerCase() : ''; }

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

  // ---- BlockCypher: when a transaction was first seen --------------------------------------------------------------------
  // A transaction has the time of its block on the chain. A service that watches the network as it happens can say when it first saw the transaction, which is the nearest thing to
  // when it was sent. That is the service's record, not part of the chain; it is kept as a claim with the time it was asked. BlockCypher's answer has `received` (when its servers got the
  // transaction), `confirmed` (the time of the block) and `relayed_by` (the peer that handed it over, which may be empty). A transaction BlockCypher never saw before its block has
  // `received` equal to `confirmed` and no peer: that is "no record", not a first-seen time.

  /** An ISO time as seconds (with milliseconds), or null when it is not a time. */
  function seconds(v) {
    if (typeof v !== 'string') return null;
    var ms = Date.parse(v); if (!isFinite(ms)) return null;
    var s = Math.round(ms) / 1000;
    return s >= MIN_TIME && s <= MAX_TIME ? s : null;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) && v >= MIN_TIME && v <= MAX_TIME ? v : null; }
  /** The peer a service named, "ip:port" or "[ipv6]:port" or an onion address, or '' when it is anything else. */
  function relayText(v) {
    var s = text(v, 80);
    return /^(?:\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?|\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?|[0-9A-Fa-f:]{3,45}|[a-z2-7]{16,56}\.onion(?::\d{1,5})?)$/.test(s) ? s : '';
  }
  /** The address of a peer without its port or brackets, for pasting into another tool: "203.0.113.9:8333" -> "203.0.113.9", "[2001:db8::1]:8333" -> "2001:db8::1". '' for anything that is not a peer. */
  function relayHost(v) {
    var s = relayText(v); if (!s) return '';
    var m = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(s); if (m) return m[1];
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/.test(s) || /\.onion(?::\d{1,5})?$/.test(s)) return s.replace(/:\d{1,5}$/, '');
    return s;                                                                          // a bare IPv6 address has no port to take off
  }
  var utcText = TW.utcText, gapText = TW.gapText;                                       // "2026-03-04 10:21:32 UTC" and "16 min 24 s"

  /**
   * Read a BlockCypher transaction reply: { found, seen, received, confirmed, relay, height }. `seen` is true only when BlockCypher has a record from before the block: a peer
   * was named, or `received` is not the time of the block. Otherwise `received` is dropped: it only repeats the block time.
   */
  function parseBlockcypher(json) {
    var o = isObj(json) ? json : {};
    var received = seconds(o.received), confirmed = seconds(o.confirmed), relay = relayText(o.relayed_by);
    var found = typeof o.hash === 'string' && /^[0-9a-fA-F]{64}$/.test(o.hash);
    var seen = found && received != null && (relay !== '' || received !== confirmed);
    return { found: found, seen: seen, received: seen ? received : null, confirmed: confirmed, relay: seen ? relay : '',
             height: typeof o.block_height === 'number' && isFinite(o.block_height) && o.block_height >= 0 ? Math.floor(o.block_height) : null };
  }
  /** What is kept on a transaction: the parsed fields, when it was asked, the address that was asked (when given) and (capped) the reply as it came. */
  function toBlockcypherExt(json, at, url) {
    var p = parseBlockcypher(json), raw = '';
    try { raw = JSON.stringify(json); } catch (e) { raw = ''; }
    if (raw.length > RAW_LIMIT) raw = raw.slice(0, RAW_LIMIT) + '…';
    p.at = typeof at === 'number' ? at : Math.floor(Date.now() / 1000);
    p.raw = raw;
    if (cleanUrl(url)) p.url = url;
    return p;
  }
  /** Validate the BlockCypher entry of an `ext` read from a file. */
  function cleanBlockcypher(a) {
    if (!isObj(a)) return null;
    var received = num(a.received), seen = a.seen === true && received != null;
    var out = { found: a.found === true, seen: seen, received: seen ? received : null, confirmed: num(a.confirmed), relay: seen ? relayText(a.relay) : '',
                height: typeof a.height === 'number' && isFinite(a.height) && a.height >= 0 ? Math.floor(a.height) : null,
                at: typeof a.at === 'number' && isFinite(a.at) ? Math.floor(a.at) : 0, raw: typeof a.raw === 'string' ? a.raw.slice(0, RAW_LIMIT + 1) : '' };
    if (cleanUrl(a.url)) out.url = a.url;
    return out;
  }

  /** The address asked for one transaction (the one the request is sent to): base + /txs/<id>?limit=1. */
  function blockcypherUrl(txid, base) {
    return String(base || BLOCKCYPHER_BASE).replace(/\/+$/, '') + '/txs/' + String(txid || '').toLowerCase() + '?limit=1';
  }
  /** An address read from a file, kept only when it is a plain https address (it is shown as text, never opened). */
  function cleanUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s<>"'\\]{1,200}$/.test(u) ? u : ''; }

  /**
   * Ask BlockCypher about one transaction. Resolves { found, ext } (found false when it does not know the transaction); rejects with an Error whose .kind is
   * 'rate' | 'upstream' | 'timeout' | 'network' | 'bad'. No cookies and no referrer go with the request: the page's own address can carry a link to a canvas.
   * opts: { fetch, txid, base, timeoutMs }
   */
  function lookupBlockcypher(opts) {
    var id = String(opts.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) return Promise.reject(fail('bad', 'That is not a transaction id.'));
    var url = blockcypherUrl(id, opts.base);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = null, timedOut = false;
    if (ctl) timer = setTimeout(function () { timedOut = true; ctl.abort(); }, opts.timeoutMs || 25000);
    return opts.fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (body) {
          var json = null; try { json = JSON.parse(body); } catch (e) { json = null; }
          if (res.status === 404) return { found: false, ext: toBlockcypherExt({}, undefined, url) };
          if (res.status === 429) throw fail('rate', 'BlockCypher\'s request limit was reached (without an account it allows only a few requests a minute and an hour). Wait a while and ask again.', 429);
          if (!res.ok) throw fail('upstream', 'BlockCypher answered HTTP ' + res.status + '.', res.status);
          if (json === null) throw fail('bad', 'BlockCypher answered with something that is not JSON.', res.status);
          var ext = toBlockcypherExt(json, undefined, url);
          return { found: ext.found, ext: ext };
        });
      }, function (e) {
        if (timedOut) throw fail('timeout', 'BlockCypher did not answer in time.');
        throw fail('network', 'Could not reach BlockCypher (' + (e && e.message ? e.message : e) + ').');
      }).then(function (v) { if (timer) clearTimeout(timer); return v; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /** The look-ups of transaction sources kept on these vertices, one row each, for the report: { txid, time, source, sourceName, found, seen, received, confirmed, relay, height, url, at }. */
  function timeRows(nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      if (!n || n.type !== 'tx' || !isObj(n.ext)) return;
      REG.forEach(function (d, id) {
        if (d.kind !== 'tx' || d.report !== 'firstseen' || !isObj(n.ext[id])) return;
        var a = n.ext[id];
        out.push({ txid: n.txid, time: typeof n.time === 'number' ? n.time : null, source: id, sourceName: d.name, found: a.found === true, seen: a.seen === true, received: typeof a.received === 'number' ? a.received : null,
                   confirmed: typeof a.confirmed === 'number' ? a.confirmed : null, relay: typeof a.relay === 'string' ? a.relay : '', height: typeof a.height === 'number' ? a.height : null,
                   url: cleanUrl(a.url) || (typeof d.url === 'function' ? d.url(n.txid) : ''), at: typeof a.at === 'number' ? a.at : 0 });
      });
    });
    return out;
  }

  // ---- the registry: one contract for every source -------------------------------------------------------------------
  var REG = new Map();
  /** Add a source. A source without `clean` or `describe` cannot be stored or shown, so it is refused. */
  function register(def) {
    if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(def.id)) throw new Error('A source needs an id of lower case letters, digits and hyphens.');
    ['lookup', 'clean', 'describe'].forEach(function (f) { if (typeof def[f] !== 'function') throw new Error('The source "' + def.id + '" needs a ' + f + '() function.'); });
    var d = Object.assign({ name: def.id, short: '', third: true, kind: 'addr', paceMs: 0 }, def);
    if (d.kind !== 'addr' && d.kind !== 'tx') throw new Error('The source "' + def.id + '" is for wallets (addr) or for transactions (tx).');
    d.short = d.short || d.name;
    REG.set(d.id, d);
    SOURCES[d.id] = { id: d.id, name: d.name };
    return d;
  }
  function unregister(id) { REG.delete(id); delete SOURCES[id]; }
  function source(id) { return REG.get(id) || null; }
  /** The registered sources, in the order they were added: [{ id, name, short, third }]. Those for wallets, unless `kind` is 'tx' (those for transactions) or 'all'. */
  function list(kind) {
    kind = kind || 'addr';
    return Array.from(REG.values()).filter(function (d) { return kind === 'all' || d.kind === kind; }).map(function (d) { return { id: d.id, name: d.name, short: d.short, third: d.third !== false }; });
  }
  /** What a stored result says, the same for every source: { source, sourceName, found, label, category, tags[], note, suggest, at }, or null for an unknown source. */
  function describe(id, ext) {
    var d = REG.get(id); if (!d || !isObj(ext)) return null;
    var c = d.describe(ext) || {};
    return { source: id, sourceName: d.name, found: c.found === true, label: text(c.label, 200), category: text(c.category, 60), tags: (Array.isArray(c.tags) ? c.tags : []).map(function (t) { return text(t, 40); }).filter(Boolean).slice(0, 12),
             note: text(c.note, 300), suggest: Tags.preset(c.suggest) ? c.suggest : '', at: typeof c.at === 'number' && isFinite(c.at) ? c.at : 0 };
  }
  /**
   * Every stored result on a vertex, described: [{ source, sourceName, address, txid, found, label, category, tags, note, suggest, at, none }], in the order of the registry. A wallet has the results of the
   * wallet sources (address is set), a transaction those of the transaction sources (txid is set). `none` is what to say when a source found nothing.
   */
  function entries(node) {
    var out = []; if (!node || !isObj(node.ext)) return out;
    var isTx = node.type === 'tx';
    REG.forEach(function (d, id) {
      if ((d.kind === 'tx') !== isTx || !isObj(node.ext[id])) return;
      var c = describe(id, node.ext[id]); if (!c) return;
      if (isTx) c.txid = node.txid || ''; else c.address = node.address || '';
      c.none = d.none || 'no entry'; out.push(c);
    });
    return out;
  }
  var FATAL = { token: 1, key: 1, rate: 1, proxy: 1, timeout: 1, setup: 1, network: 1, cap: 1, aborted: 1 };      // errors that would repeat for the next address: the run stops at the first
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
      }).then(function () {
        if (stopped) return { results: results, stopped: stopped, error: error };
        return i < list.length && d.paceMs > 0 ? (opts.sleep || sleep)(d.paceMs).then(step) : step();                 // a source with a low request limit is asked slowly
      });
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

  register({
    id: 'blockcypher', name: 'BlockCypher', short: 'BlockCypher', kind: 'tx', third: true, paceMs: 700, none: 'no first-seen record', report: 'firstseen', host: 'api.blockcypher.com', manyId: 'btnAskTimes',
    ask: { button: 'Ask BlockCypher when it was first seen', again: 'Ask BlockCypher again',
           tip: 'Sends this transaction id to BlockCypher (api.blockcypher.com), which then knows you are looking at it. It answers when it first saw the transaction, and which peer passed it on.',
           many: 'Ask BlockCypher about %s', manyTip: 'Sends the transaction ids to BlockCypher, slowly, and stops when its request limit is reached' },
    label: 'When first seen', intro: 'The time on a transaction is the time of its block. BlockCypher can say when it first saw them.',
    kinds: { good: 'with a first-seen time', none: 'with no record from before the block' }, useful: function (a) { return a.seen === true; },
    ready: function () { return ''; },
    lookup: function (txid, ctx) { return lookupBlockcypher({ fetch: ctx.fetch, txid: txid, base: ctx.blockcypher }); },
    clean: cleanBlockcypher,
    url: function (txid) { return blockcypherUrl(txid); },
    describe: function (a) {
      return { found: a.seen === true, label: a.seen ? 'first seen ' + utcText(a.received) : 'no first-seen record', category: 'Broadcast time', tags: [], suggest: '', at: a.at,
               note: a.seen ? '' : a.found ? 'BlockCypher learned of it from its block.' : 'BlockCypher does not know it.' };
    },
    headline: function (a) { return a.seen ? 'first seen ' + utcText(a.received) + (a.relay ? ', from peer ' + a.relay : '') : a.found ? 'no record from before its block' : 'it does not know this transaction'; },
    explain: function (a) {
      return a.seen ? 'This is what BlockCypher recorded; it is not part of the blockchain. The peer is the first node that passed the transaction to BlockCypher, which is not necessarily the sender.'
        : a.found ? 'BlockCypher has no record from before the block: it learned of this transaction from its block. That says nothing about when it was sent.' : 'BlockCypher does not know this transaction.';
    },
    fields: function (a) {
      return [['First seen', a.seen ? utcText(a.received) : ''], ['Before its block', a.seen && a.confirmed != null ? (a.received <= a.confirmed ? gapText(a.confirmed - a.received) : 'none: the block\'s time stamp is earlier') : ''],
              ['Peer that passed it on', a.relay, relayHost(a.relay)], ['Block', a.height]];
    }
  });

  register({
    id: 'chainwindow', name: 'Block data', short: 'Block data', kind: 'tx', third: false, none: 'no window', manyId: 'btnAskWindow',
    ask: { button: 'Narrow the time from block data', again: 'Narrow it again',
           tip: 'Asks the data source you are using for the blocks before this transaction\'s block (a few requests) and works out the earliest it can have been sent. Nothing goes to another service.',
           many: 'Narrow the time of %s', manyTip: 'Asks your data source for the blocks before each transaction\'s block (a few requests for each); nothing goes to another service' },
    label: 'Time window from block data', intro: 'The blocks before a transaction\'s block show how much earlier than that block it can have been sent.',
    kinds: { good: 'with a window', none: 'with nothing to narrow it' }, useful: function (a) { return TW.infer(a).notBefore != null; },
    ready: function (ctx) { return ctx.client ? '' : 'There is no data source to ask.'; },
    lookup: function (txid, ctx) { return TW.lookup(txid, ctx); },
    clean: TW.clean,
    describe: function (a) { var i = TW.infer(a); return { found: i.notBefore != null, label: i.notBefore != null ? 'not before about ' + utcText(i.notBefore) : 'no window', category: 'Time window', tags: [], suggest: '', at: a.at, note: '' }; },
    headline: function (a) { var i = TW.infer(a); return i.notBefore != null ? 'not before about ' + utcText(i.notBefore) + ' (a window of ' + gapText(i.window) + ')' : 'the blocks before it do not narrow the time'; },
    explain: function () { return TW.EXPLAIN; },
    fields: function (a) { return TW.rows(a); }
  });

  return { parseBlockcypher: parseBlockcypher, lookupBlockcypher: lookupBlockcypher, toBlockcypherExt: toBlockcypherExt, blockcypherUrl: blockcypherUrl, timeRows: timeRows, utcText: utcText, gapText: gapText, relayText: relayText, relayHost: relayHost, BLOCKCYPHER_BASE: BLOCKCYPHER_BASE,
           relayUrl: relayUrl, SOURCES: SOURCES, register: register, unregister: unregister, source: source, list: list, describe: describe, entries: entries, lookupMany: lookupMany, parseArkham: parseArkham, tagFor: tagFor, toExt: toExt, cleanExt: cleanExt, lookupArkham: lookupArkham, proxyHealth: proxyHealth, arkhamUrl: arkhamUrl, ARKHAM_EXPLORER: ARKHAM_EXPLORER, RAW_LIMIT: RAW_LIMIT };
}));
