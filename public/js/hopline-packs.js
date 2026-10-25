/*
 * Hopline shipped packs: label packs that come with the site (the OFAC sanctions list, later others) instead of from a file you choose.
 *
 * packs/index.js lists them (window.HOPLINE_PACK_INDEX); each one's wallets are in its own file, packs/<id>.js, which sets
 * window.HOPLINE_PACKS[<id>]. The files are scripts and not JSON that is fetched, because the pages must work from file://,
 * where a script tag works and fetch does not. A pack file is only loaded when its pack is switched on.
 *
 * Both files are written by tools/build_packs.py. The list is still checked as if it came from outside: names and files
 * are matched against fixed patterns, and the wallets go through HoplineLabels like any imported pack (checksums included).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-labels.js'));
  else root.HoplinePacks = factory(root.HoplineLabels);
}(typeof self !== 'undefined' ? self : this, function (LB) {
  'use strict';

  var ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/, FILE_RE = /^[a-z0-9][a-z0-9-]{0,39}\.js$/, VERSION_RE = /^[A-Za-z0-9]{1,16}$/;
  var MAX_PACKS = 20, STALE_DAYS = 60, LOAD_TIMEOUT = 15000, DAY = 86400000;

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** The list of shipped packs from the page, cleaned: [{ id, name, file, entries, source, licence, attribution, asOf, sourceUrl, sanctions, defaultOn, version }]. Anything that does not fit is left out. */
  function cleanIndex(raw) {
    var out = [], seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach(function (r) {
      if (out.length >= MAX_PACKS || !isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id) || seen.has(r.id)) return;
      var file = typeof r.file === 'string' && FILE_RE.test(r.file) && r.file !== 'index.js' ? r.file : '';
      var name = LB.cleanText(r.name, 80);
      if (!file || !name) return;
      seen.add(r.id);
      out.push({ id: r.id, name: name, file: file,
                 entries: typeof r.entries === 'number' && r.entries >= 0 && r.entries <= LB.MAX_ENTRIES ? Math.floor(r.entries) : 0,
                 source: LB.cleanText(r.source, 200), licence: LB.cleanText(r.licence, 80), attribution: LB.cleanText(r.attribution, 200),
                 asOf: LB.cleanDate(r.asOf), sourceUrl: LB.cleanUrl(r.sourceUrl),
                 sanctions: r.sanctions === true, defaultOn: r.defaultOn === true,
                 version: typeof r.version === 'string' && VERSION_RE.test(r.version) ? r.version : '' });
    });
    return out;
  }

  /** The visitor's switches from the saved preferences: { id: true | false } for the ids that were set. */
  function cleanChoices(raw) {
    var out = {};
    if (!isObj(raw)) return out;
    Object.keys(raw).slice(0, 50).forEach(function (k) { if (ID_RE.test(k) && typeof raw[k] === 'boolean') out[k] = raw[k]; });
    return out;
  }

  /** Whether a pack is on: what the visitor chose, otherwise what the pack is shipped as. */
  function isOn(entry, choices) { return choices && has(choices, entry.id) ? choices[entry.id] === true : entry.defaultOn === true; }

  /** Whether a pack that you imported yourself, switched on, has the same name: then yours is the one that counts. */
  function shadowed(pack, imported) {
    return (imported || []).some(function (p) { return p.enabled && p.name === pack.name; });
  }

  /** The shipped packs that count: switched on and loaded, except those that one of your own imports replaces. `shipped` rows carry { name, enabled, loaded, entries, sanctions, asOf }. */
  function active(shipped, imported) {
    return (shipped || []).filter(function (p) { return p.enabled && p.loaded && !shadowed(p, imported); });
  }

  /** How old the pack's data is, as text for a pack that should be looked at again; '' when it is recent or has no date. */
  function staleness(asOf, now) {
    if (!LB.cleanDate(asOf)) return '';
    var days = Math.floor(((now == null ? Date.now() : now) - new Date(asOf + 'T00:00:00Z').getTime()) / DAY);
    if (days < STALE_DAYS) return '';
    var months = Math.floor(days / 30);
    return 'about ' + months + ' months old';
  }

  /**
   * Promise of the parsed pack (the result of HoplineLabels.fromObject) for one entry of the index. The pack file is added to the page as a script and
   * removed again; a pack whose data is already on the page (window.HOPLINE_PACKS[id]) is used without loading anything.
   */
  function load(entry, win, timeoutMs) {
    win = win || (typeof self !== 'undefined' ? self : root);
    return new Promise(function (resolve, reject) {
      var done = false, timer = null, s = null;
      function finish(err, parsed) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (s && s.parentNode) s.parentNode.removeChild(s);
        if (err) reject(err); else resolve(parsed);
      }
      function use() {
        var store = win.HOPLINE_PACKS, data = store && has(store, entry.id) ? store[entry.id] : null;
        if (!data) { finish(new Error('The file did not contain the pack.')); return; }
        try { finish(null, LB.fromObject(data, entry.name)); } catch (e) { finish(e); } finally { delete store[entry.id]; }            // the wallets are kept by the page; the loaded copy is not
      }
      var preloaded = win.HOPLINE_PACKS && has(win.HOPLINE_PACKS, entry.id);
      if (preloaded) { use(); return; }
      s = win.document.createElement('script');
      s.onload = use;
      s.onerror = function () { finish(new Error('The pack file could not be loaded.')); };
      timer = setTimeout(function () { finish(new Error('The pack file took too long to load.')); }, timeoutMs || LOAD_TIMEOUT);
      s.src = 'packs/' + entry.file + (entry.version ? '?v=' + entry.version : '');
      win.document.head.appendChild(s);
    });
  }

  return { cleanIndex: cleanIndex, cleanChoices: cleanChoices, isOn: isOn, shadowed: shadowed, active: active, staleness: staleness, load: load, STALE_DAYS: STALE_DAYS };
}));
