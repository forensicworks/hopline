/*
 * Hopline label packs: lists of "this address belongs to that" imported from a file (CSV or JSON), and your own labels
 * exported in the same shape so they can be shared. Pure functions, no DOM, no network.
 *
 * A pack is somebody else's claim about wallets. It is shown as "known (pack name)", never mixed into your own labels, and
 * everything in it is checked here before it reaches the page: addresses must be valid Bitcoin addresses (checksum
 * included), text is stripped of control characters and capped, links must be plain http(s).
 *
 * Accepted files
 *   CSV   a header row with an `address` column and optionally label, category, url, note (name, tag, type, program,
 *         link, notes, comment are understood too); or no header and two columns: address, label
 *   JSON  { "format": "hopline-labels", "name", "source", "labels": [ {address, label, category, url, note} ] },
 *         or just such a list, or a plain { "<address>": "<label>" } map. A pack object may also say where its data came
 *         from, all optional: "licence", "attribution" (who to credit), "asOf" (YYYY-MM-DD, the date of the data) and
 *         "sourceUrl"; "sanctions": true marks a sanctions list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hopline-address.js'));
  else root.HoplineLabels = factory(root.HoplineAddress);
}(typeof self !== 'undefined' ? self : this, function (Addr) {
  'use strict';

  var FORMAT = 'hopline-labels', MAX_ENTRIES = 200000, MAX_LABEL = 120, MAX_CATEGORY = 40, MAX_NOTE = 500, MAX_LICENCE = 80, MAX_ATTRIBUTION = 200;
  var ALIASES = {
    address: ['address', 'addr', 'wallet', 'bitcoin address', 'btc address', 'digital currency address'],
    label: ['label', 'name', 'entity', 'owner', 'description'],
    category: ['category', 'tag', 'type', 'program', 'family', 'class'],
    url: ['url', 'link', 'reference', 'source url'],
    note: ['note', 'notes', 'comment', 'comments', 'remarks']
  };

  function cleanText(v, max) {
    if (typeof v !== 'string') v = v == null ? '' : String(v);
    return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);       // controls and bidirectional overrides go
  }
  function cleanUrl(v) { return typeof v === 'string' && v.length <= 300 && /^https?:\/\/[^\s<>"']+$/i.test(v.trim()) ? v.trim() : ''; }
  /** A calendar date as YYYY-MM-DD, or '' for anything else (the date a list's data is from). */
  function cleanDate(v) {
    var s = typeof v === 'string' ? v.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
  }
  /** Where a pack came from, as the pack states it: licence, who to credit, the date of its data and a link to the source. Optional, each cleaned and capped. */
  function provenance(d) {
    return { licence: textOnly(typeof d.licence === 'string' ? d.licence : d.license, MAX_LICENCE), attribution: textOnly(d.attribution, MAX_ATTRIBUTION), asOf: cleanDate(d.asOf), sourceUrl: cleanUrl(d.sourceUrl) };
  }
  function textOnly(v, max) { return typeof v === 'string' ? cleanText(v, max) : ''; }                   // a number or an object there is not text, so it is not kept

  /** One entry from outside: { entry } or { error: 'invalid' | 'otherChain' | 'empty' }. */
  function clampEntry(raw) {
    var a = cleanText(raw.address, 100);
    if (!a) return { error: 'empty' };
    a = Addr.normalise(a);
    var v = Addr.validate(a);
    if (!v.ok) return { error: v.reason === 'format' ? 'otherChain' : 'invalid' };
    var label = cleanText(raw.label, MAX_LABEL);
    if (!label) return { error: 'empty' };
    return { entry: { address: a, label: label, category: cleanText(raw.category, MAX_CATEGORY), url: cleanUrl(raw.url), note: cleanText(raw.note, MAX_NOTE) } };
  }

  // ---- CSV ----------------------------------------------------------------------------------------
  function csvRows(text) {
    var rows = [], row = [], cur = '', q = false;
    text = String(text).replace(/^\ufeff/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }
  function columnOf(header, field) {
    for (var i = 0; i < header.length; i++) if (ALIASES[field].indexOf(header[i].trim().toLowerCase()) >= 0) return i;
    return -1;
  }
  function fromCsv(text) {
    var rows = csvRows(text), out = [];
    if (!rows.length) return out;
    var col = {}, hasHeader = columnOf(rows[0], 'address') >= 0;
    if (hasHeader) { Object.keys(ALIASES).forEach(function (f) { col[f] = columnOf(rows[0], f); }); rows = rows.slice(1); }
    else col = { address: 0, label: 1, category: 2, url: 3, note: 4 };
    rows.forEach(function (r) {
      function at(f) { return col[f] >= 0 && col[f] < r.length ? r[col[f]] : ''; }
      out.push({ address: at('address'), label: at('label'), category: at('category'), url: at('url'), note: at('note') });
    });
    return out;
  }

  // ---- JSON ---------------------------------------------------------------------------------------
  function pick(o, field) {
    for (var i = 0; i < ALIASES[field].length; i++) {
      var k = ALIASES[field][i];
      if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null && typeof o[k] !== 'object') return o[k];
    }
    return '';
  }
  function fromJsonValue(d, meta) {
    var list = [];
    if (Array.isArray(d)) list = d;
    else if (d && typeof d === 'object' && Array.isArray(d.labels)) { list = d.labels; if (typeof d.name === 'string') meta.name = cleanText(d.name, 80); if (typeof d.source === 'string') meta.source = cleanText(d.source, 200); Object.assign(meta, provenance(d)); }
    else if (d && typeof d === 'object') list = Object.keys(d).filter(function (k) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'; }).map(function (k) { return typeof d[k] === 'object' && d[k] ? Object.assign({ address: k }, d[k]) : { address: k, label: d[k] }; });
    return list.map(function (x) {
      if (Array.isArray(x)) return { address: x[0], label: x[1], category: x[2], url: x[3], note: x[4] };
      if (x && typeof x === 'object') return { address: pick(x, 'address'), label: pick(x, 'label'), category: pick(x, 'category'), url: pick(x, 'url'), note: pick(x, 'note') };
      return { address: '', label: '' };
    });
  }

  /**
   * Read a pack from text. Returns { name, source, sanctions, licence, attribution, asOf, sourceUrl, entries, skipped: {invalid, otherChain, empty, duplicate}, truncated }
   * or throws Error with a message a person can read. `fallbackName` names a pack that does not name itself (the file name).
   */
  function parse(text, fallbackName) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
    var meta = { name: cleanText(fallbackName || 'Imported labels', 80), source: '' }, raws, t = text.replace(/^\ufeff/, '').trim();
    if (t[0] === '{' || t[0] === '[') {
      var d; try { d = JSON.parse(t); } catch (e) { throw new Error('That looks like JSON but could not be read.'); }
      raws = fromJsonValue(d, meta);
      if (d && typeof d === 'object' && !Array.isArray(d) && d.sanctions === true) meta.sanctions = true;           // a pack that says it is a sanctions list (the OFAC converter does)
    } else raws = fromCsv(t);
    return finish(raws, meta);
  }

  /** The same as parse for a pack that is already a JavaScript value (a pack file the site ships): every entry goes through the same checks. */
  function fromObject(d, fallbackName) {
    var meta = { name: cleanText(fallbackName || 'Imported labels', 80), source: '' }, raws = fromJsonValue(d, meta);
    if (d && typeof d === 'object' && !Array.isArray(d) && d.sanctions === true) meta.sanctions = true;
    return finish(raws, meta);
  }

  function finish(raws, meta) {
    var seen = new Set(), entries = [], skipped = { invalid: 0, otherChain: 0, empty: 0, duplicate: 0 }, truncated = false;
    for (var i = 0; i < raws.length; i++) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      var r = clampEntry(raws[i]);
      if (r.error) { skipped[r.error]++; continue; }
      if (seen.has(r.entry.address)) { skipped.duplicate++; continue; }
      seen.add(r.entry.address); entries.push(r.entry);
    }
    if (!entries.length) throw new Error('No usable Bitcoin addresses with a label were found' + (skipped.otherChain ? ' (' + skipped.otherChain + ' were not Bitcoin addresses)' : '') + (skipped.invalid ? ' (' + skipped.invalid + ' failed the address checksum)' : '') + '.');
    return { name: meta.name || 'Imported labels', source: meta.source, sanctions: meta.sanctions === true, licence: meta.licence || '', attribution: meta.attribution || '', asOf: meta.asOf || '', sourceUrl: meta.sourceUrl || '',
             entries: entries, skipped: skipped, truncated: truncated };
  }

  // ---- your own labels, as a pack ------------------------------------------------------------------
  /** The labelled, tagged or annotated wallets of a graph as entries: what you would share with a colleague. */
  function fromGraph(graph) {
    var out = [];
    graph.nodes.forEach(function (n) {
      if (n.type !== 'addr' || !n.address || !(n.label || n.tag || n.note)) return;
      out.push({ address: n.address, label: n.label || n.tag || 'tagged', category: n.tag || '', url: '', note: n.note || '' });
    });
    return out.sort(function (a, b) { return a.address < b.address ? -1 : a.address > b.address ? 1 : 0; });
  }

  function toJson(entries, meta) {
    meta = meta || {};
    return JSON.stringify({ format: FORMAT, version: 1, name: meta.name || 'My labels', source: meta.source || '', created: new Date(meta.now != null ? meta.now : Date.now()).toISOString(),
                            labels: entries.map(function (e) { return { address: e.address, label: e.label, category: e.category || undefined, url: e.url || undefined, note: e.note || undefined }; }) }, null, 1);
  }
  function defuse(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
  function cell(v) { var s = defuse(String(v == null ? '' : v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(entries) {
    var lines = ['address,label,category,url,note'];
    entries.forEach(function (e) { lines.push([e.address, e.label, e.category, e.url, e.note].map(cell).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

  /** The packs saved in this browser (the stored text): checked and capped; [] when there is nothing or it is damaged. */
  function parseStored(raw) {
    if (!raw) return [];
    try {
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.slice(0, 20).map(function (p, i) {
        p = p && typeof p === 'object' ? p : {};
        var entries = (Array.isArray(p.entries) ? p.entries : []).filter(function (e) { return Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string'; })
          .map(function (e) { return { address: e[0], label: cleanText(e[1], MAX_LABEL), category: cleanText(e[2], MAX_CATEGORY), url: cleanUrl(e[3]), note: cleanText(e[4], MAX_NOTE) }; });
        return { id: String(p.id || 'p' + i).slice(0, 40), name: cleanText(p.name, 80) || 'Labels', source: cleanText(p.source, 200), enabled: p.enabled !== false, sanctions: p.sanctions === true,
                 licence: textOnly(p.licence, MAX_LICENCE), attribution: textOnly(p.attribution, MAX_ATTRIBUTION), asOf: cleanDate(p.asOf), sourceUrl: cleanUrl(p.sourceUrl), entries: entries, stored: true };
      });
    } catch (e) { return []; }
  }

  /**
   * The built-in list plus the enabled packs as one lookup { address: { label, pack?, category?, url?, note?, alt? } }.
   * The built-in name wins; a pack that names the same wallet differently is shown as "also listed as".
   */
  function buildKnown(base, packs, own) {
    var out = Object.assign({}, base || {});
    (packs || []).forEach(function (p) {
      if (!p.enabled) return;
      p.entries.forEach(function (e) {
        var link = e.url || p.sourceUrl || '';                                // an entry's own link, else the page the pack's data came from
        var cur = out[e.address], claim = { label: e.label, pack: p.name, category: e.category || '', url: link, note: e.note || '', sanctions: p.sanctions === true };
        if (p.asOf) claim.asOf = p.asOf;                                     // the date of the pack's data, when it says
        if (!cur) {
          out[e.address] = { label: e.label, pack: p.name, category: e.category || undefined, url: link || undefined, note: e.note || undefined, claims: [claim] };
          if (claim.sanctions) out[e.address].sanctions = true;
        } else {
          var first = cur.claims || [claimOf(cur)];
          cur = Object.assign({}, cur);
          cur.alt = (cur.alt || []).concat([e.label + ' (' + p.name + ')']).slice(0, 5);
          cur.claims = first.concat([claim]);                                // every claim is kept in full; `alt` is the short text of the later ones
          if (claim.sanctions) cur.sanctions = true;
          out[e.address] = cur;
        }
      });
    });
    (own || []).forEach(function (e) {                                       // what you wrote yourself is the first claim, and its name is the one shown
      var cur = out[e.address], mine = { label: e.label, pack: OWN_PACK, category: e.category || '', url: '', note: e.note || '', sanctions: false, own: true };
      if (!cur) { out[e.address] = { label: e.label, pack: OWN_PACK, category: e.category || undefined, note: e.note || undefined, claims: [mine] }; return; }
      var claims = cur.claims || [claimOf(cur)];
      cur = Object.assign({}, cur);
      cur.alt = [cur.label + (cur.pack ? ' (' + cur.pack + ')' : '')].concat(cur.alt || []).slice(0, 5);
      cur.label = e.label; cur.pack = OWN_PACK; cur.category = e.category || cur.category; cur.note = e.note || cur.note;
      cur.claims = [mine].concat(claims);
      out[e.address] = cur;
    });
    return out;
  }

  var OWN_PACK = 'Your labels';
  /**
   * Your own labels, tags and notes from a saved workspace (the text the workspace keeps in this browser) as entries { address, label, category (the tag), note }.
   * Only wallets that carry a label, a tag or a note; every field is cleaned and every address checked. [] for anything that is not such a file.
   */
  function fromSession(text, limit) {
    if (typeof text !== 'string' || !text || text.length > 60000000) return [];
    var d; try { d = JSON.parse(text); } catch (e) { return []; }
    if (!d || typeof d !== 'object' || !Array.isArray(d.nodes) || (d.format !== 'hopline-workspace' && d.format !== 'orion-workspace')) return [];
    var out = [], max = limit || MAX_ENTRIES;
    for (var i = 0; i < d.nodes.length && out.length < max; i++) {
      var n = d.nodes[i];
      if (!n || n.type !== 'addr' || typeof n.address !== 'string') continue;
      var label = cleanText(n.label, MAX_LABEL), tag = cleanText(n.tag, 20), note = cleanText(n.note, MAX_NOTE);
      if (!label && !tag && !note) continue;
      var r = clampEntry({ address: n.address, label: label || tag || 'tagged', category: tag, url: '', note: note });
      if (!r.error) out.push(r.entry);
    }
    return out;
  }

  /** One claim of a known entry as plain data: { label, pack ('' is the built-in list), category, url, note, sanctions }. */
  function claimOf(k) { return { label: k.label, pack: k.pack || '', category: k.category || '', url: k.url || '', note: k.note || '', sanctions: k.sanctions === true }; }
  /** Every claim a wallet has, first the one that names it, then the others (at least one for any known entry). */
  function claimsOf(k) { return k ? (k.claims && k.claims.length ? k.claims : [claimOf(k)]) : []; }

  return { FORMAT: FORMAT, MAX_ENTRIES: MAX_ENTRIES, OWN_PACK: OWN_PACK, parseStored: parseStored, buildKnown: buildKnown, fromSession: fromSession, claimsOf: claimsOf, parse: parse, fromObject: fromObject, fromGraph: fromGraph, toJson: toJson, toCsv: toCsv, cleanText: cleanText, cleanUrl: cleanUrl, cleanDate: cleanDate, clampEntry: clampEntry };
}));
