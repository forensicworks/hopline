/*
 * Orion label packs: lists of "this address belongs to that" imported from a file (CSV or JSON), and your own labels
 * exported in the same shape so they can be shared. Pure functions, no DOM, no network.
 *
 * A pack is somebody else's claim about wallets. It is shown as "known (pack name)", never mixed into your own labels, and
 * everything in it is checked here before it reaches the page: addresses must be valid Bitcoin addresses (checksum
 * included), text is stripped of control characters and capped, links must be plain http(s).
 *
 * Accepted files
 *   CSV   a header row with an `address` column and optionally label, category, url, note (name, tag, type, program,
 *         link, notes, comment are understood too); or no header and two columns: address, label
 *   JSON  { "format": "orion-labels", "name", "source", "labels": [ {address, label, category, url, note} ] },
 *         or just such a list, or a plain { "<address>": "<label>" } map
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-address.js'));
  else root.OrionLabels = factory(root.OrionAddress);
}(typeof self !== 'undefined' ? self : this, function (Addr) {
  'use strict';

  var FORMAT = 'orion-labels', MAX_ENTRIES = 200000, MAX_LABEL = 120, MAX_CATEGORY = 40, MAX_NOTE = 500;
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
    else if (d && typeof d === 'object' && Array.isArray(d.labels)) { list = d.labels; if (typeof d.name === 'string') meta.name = cleanText(d.name, 80); if (typeof d.source === 'string') meta.source = cleanText(d.source, 200); }
    else if (d && typeof d === 'object') list = Object.keys(d).filter(function (k) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'; }).map(function (k) { return typeof d[k] === 'object' && d[k] ? Object.assign({ address: k }, d[k]) : { address: k, label: d[k] }; });
    return list.map(function (x) {
      if (Array.isArray(x)) return { address: x[0], label: x[1], category: x[2], url: x[3], note: x[4] };
      if (x && typeof x === 'object') return { address: pick(x, 'address'), label: pick(x, 'label'), category: pick(x, 'category'), url: pick(x, 'url'), note: pick(x, 'note') };
      return { address: '', label: '' };
    });
  }

  /**
   * Read a pack from text. Returns { name, source, entries, skipped: {invalid, otherChain, empty, duplicate}, truncated }
   * or throws Error with a message a person can read. `fallbackName` names a pack that does not name itself (the file name).
   */
  function parse(text, fallbackName) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
    var meta = { name: cleanText(fallbackName || 'Imported labels', 80), source: '' }, raws, t = text.replace(/^\ufeff/, '').trim();
    if (t[0] === '{' || t[0] === '[') {
      var d; try { d = JSON.parse(t); } catch (e) { throw new Error('That looks like JSON but could not be read.'); }
      raws = fromJsonValue(d, meta);
    } else raws = fromCsv(t);
    var seen = new Set(), entries = [], skipped = { invalid: 0, otherChain: 0, empty: 0, duplicate: 0 }, truncated = false;
    for (var i = 0; i < raws.length; i++) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      var r = clampEntry(raws[i]);
      if (r.error) { skipped[r.error]++; continue; }
      if (seen.has(r.entry.address)) { skipped.duplicate++; continue; }
      seen.add(r.entry.address); entries.push(r.entry);
    }
    if (!entries.length) throw new Error('No usable Bitcoin addresses with a label were found' + (skipped.otherChain ? ' (' + skipped.otherChain + ' were not Bitcoin addresses)' : '') + (skipped.invalid ? ' (' + skipped.invalid + ' failed the address checksum)' : '') + '.');
    return { name: meta.name || 'Imported labels', source: meta.source, entries: entries, skipped: skipped, truncated: truncated };
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

  return { FORMAT: FORMAT, MAX_ENTRIES: MAX_ENTRIES, parse: parse, fromGraph: fromGraph, toJson: toJson, toCsv: toCsv, cleanText: cleanText, cleanUrl: cleanUrl, clampEntry: clampEntry };
}));
