/*
 * Hopline OFAC import: turns the U.S. Treasury's SDN list into a label pack of the Bitcoin addresses it names. Pure functions,
 * no DOM, no network: the page hands over the bytes of a file the user chose.
 *
 * Where the file comes from: https://sanctionslist.ofac.treas.gov/Home/SdnList (Data Center - SDN List). Any of the three XML
 * versions can be used, as a zip or unzipped:
 *   SDN_XML.ZIP / SDN.XML              the legacy layout (30 MB unzipped; the lightest, so the default)
 *   SDN_ENHANCED.ZIP / SDN_ENHANCED.XML  the enhanced layout (110 MB unzipped)
 *   SDN_ADVANCED.ZIP / SDN_ADVANCED.XML  the advanced layout (130 MB unzipped)
 * They hold the same addresses. Not SDN.CSV: it cuts every entry's remarks at 1000 characters and so loses addresses (in
 * October 2026 it held about half of them).
 *
 * The result is the same pack tools/make_label_pack_ofac.py writes; it goes through HoplineLabels.parse like any imported file,
 * so addresses are checked (checksum included) and text is cleaned there.
 *
 * The file is untrusted. It is never evaluated: only the entries that name a Bitcoin address are cut out of the text and read
 * with a small parser that knows only tags, attributes, text and the five standard character references; a file that
 * declares a DOCTYPE or entities is refused; the unzipped size is capped. Every layout is checked the same way: the number of
 * address entries the file contains is counted separately from the reading, and a difference is reported.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineOfac = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE = 'https://sanctionslist.ofac.treas.gov/Home/SdnList';
  var ENTRY_PAGE = 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=';        // OFAC's page for one entry, by its uid
  var ID_TYPES = ['Digital Currency Address - XBT', 'Digital Currency Address - BTC'];   // OFAC writes XBT
  var MAX_XML = 400000000;                                                           // the real file is about 30 MB

  function fail(message) { var e = new Error(message); e.name = 'OfacError'; return e; }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function local(name) { return name.slice(name.lastIndexOf(':') + 1); }

  // ---- zip: the one XML file inside, read with the browser's built-in deflate ---------------------------------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function inflateRaw(bytes, limit) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(fail('This browser cannot open zip files. Unzip SDN_XML.ZIP yourself and choose SDN.XML instead.'));
    var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = [], total = 0;
    function next() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), at = 0;
          chunks.forEach(function (c) { out.set(c, at); at += c.length; });
          return out;
        }
        total += r.value.length;
        if (total > limit) { reader.cancel(); throw fail('The file unzips to more than expected; refusing it.'); }
        chunks.push(r.value);
        return next();
      });
    }
    return next().catch(function (e) { throw e && e.name === 'OfacError' ? e : fail('The zip file could not be unpacked (' + (e && e.message ? e.message : 'corrupt data') + ').'); });
  }

  /** The text of the single .xml file inside a zip (given as bytes). */
  function unzipXml(bytes) {
    var eocd = -1, i;
    for (i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(fail('That is not a readable zip file.'));
    var count = u16(bytes, eocd + 10), at = u32(bytes, eocd + 16);
    if (count === 0xffff || at === 0xffffffff) return Promise.reject(fail('That zip file uses a format this page does not read (zip64). Unzip it and choose SDN.XML.'));
    var found = [];
    for (i = 0; i < count; i++) {
      if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) return Promise.reject(fail('That is not a readable zip file.'));
      var nameLen = u16(bytes, at + 28), extraLen = u16(bytes, at + 30), commentLen = u16(bytes, at + 32);
      var name = String.fromCharCode.apply(null, bytes.subarray(at + 46, at + 46 + nameLen));
      if (/\.xml$/i.test(name)) found.push({ flags: u16(bytes, at + 8), method: u16(bytes, at + 10), size: u32(bytes, at + 20), full: u32(bytes, at + 24), local: u32(bytes, at + 42) });
      at += 46 + nameLen + extraLen + commentLen;
    }
    if (found.length !== 1) return Promise.reject(fail('The zip has ' + found.length + ' XML files; expected one (SDN.XML).'));
    var f = found[0];
    if (f.flags & 1) return Promise.reject(fail('The zip is encrypted.'));
    if (f.full > MAX_XML) return Promise.reject(fail('The file inside the zip is larger than expected (' + f.full + ' bytes); refusing it.'));
    if (f.local + 30 > bytes.length || u32(bytes, f.local) !== 0x04034b50) return Promise.reject(fail('That is not a readable zip file.'));
    var start = f.local + 30 + u16(bytes, f.local + 26) + u16(bytes, f.local + 28);
    if (start + f.size > bytes.length) return Promise.reject(fail('That zip file is cut short.'));
    var data = bytes.subarray(start, start + f.size);
    var got = f.method === 0 ? Promise.resolve(data) : f.method === 8 ? inflateRaw(data, MAX_XML) : Promise.reject(fail('That zip file uses a compression method this page does not read.'));
    return got.then(text);
  }

  function text(bytes) {
    var s = new TextDecoder('utf-8').decode(bytes);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  // ---- a small parser for one <sdnEntry> block (tags, text, character references; nothing else) ------------
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decode(s) {
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e.charAt(0) !== '#') return ENT[e];
      var n = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
  }
  function parseAttrs(s) {
    var a = {}, m, re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    while ((m = re.exec(s)) !== null) a[local(m[1])] = decode(m[2] !== undefined ? m[2] : m[3]);
    return a;
  }
  function parseBlock(s) {
    var re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g, m, stack = [], rootEl = null;
    while ((m = re.exec(s)) !== null) {
      if (m[6] !== undefined) { if (stack.length) stack[stack.length - 1].text += decode(m[6]); }
      else if (m[1] !== undefined) { if (stack.length) stack[stack.length - 1].text += m[1]; }
      else if (m[3] !== undefined) {
        if (m[2] === '/') {
          var top = stack.pop();
          if (!top || top.tag !== m[3]) throw fail('The file is not valid XML.');
        } else {
          var el = { name: local(m[3]), tag: m[3], attrs: m[4] ? parseAttrs(m[4]) : {}, kids: [], text: '' };
          if (stack.length) stack[stack.length - 1].kids.push(el); else if (!rootEl) rootEl = el; else throw fail('The file is not valid XML.');
          if (m[5] !== '/') stack.push(el);
        }
      }
    }
    if (stack.length || !rootEl) throw fail('The file is not valid XML.');
    return rootEl;
  }
  function child(el, name) { if (!el) return null; for (var i = 0; i < el.kids.length; i++) if (el.kids[i].name === name) return el.kids[i]; return null; }
  function children(el, name) { return el ? el.kids.filter(function (k) { return k.name === name; }) : []; }
  function childText(el, name) { var c = child(el, name); return c ? clean(c.text) : ''; }
  function firstWhere(list, test) { for (var i = 0; i < list.length; i++) if (test(list[i])) return list[i]; return list[0] || null; }
  function count(s, what) { var n = 0, p = -1; while ((p = s.indexOf(what, p + 1)) >= 0) n++; return n; }
  function matches(s, re) { return (s.match(re) || []).length; }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function category(programs, limit) {
    var out = '';
    for (var i = 0; i < programs.length; i++) {
      var next = out ? out + ', ' + programs[i] : programs[i];
      if (next.length > limit) return out || programs[i].slice(0, limit);
      out = next;
    }
    return out;
  }

  /** Calls fn(root element) once for each block (open ... close) that contains a match of `marker`; only those blocks are parsed. */
  function eachBlock(xml, marker, open, close, fn) {
    var m, last = -1;
    marker.lastIndex = 0;
    while ((m = marker.exec(xml)) !== null) {
      var s = xml.lastIndexOf(open, m.index), e = xml.indexOf(close, m.index);
      if (s < 0 || e < 0) throw fail('The file is not valid XML.');
      if (s !== last) fn(parseBlock(xml.slice(s, e + close.length)));
      last = s;
      marker.lastIndex = e;                                                  // the rest of this block was read as a whole
    }
  }

  // ---- the three layouts: each gives { date, entries, expected, records: [{ uid, who, programs, address }] } -------------
  function readLegacy(xml, head) {
    var dm = /<Publish_Date>([^<]*)<\/Publish_Date>/.exec(head), records = [];
    eachBlock(xml, /<idType>\s*Digital Currency Address - (?:XBT|BTC)\s*<\/idType>/g, '<sdnEntry>', '</sdnEntry>', function (el) {
      var last = childText(el, 'lastName'), first = childText(el, 'firstName'), programs = [];
      children(child(el, 'programList'), 'program').forEach(function (k) { if (clean(k.text)) programs.push(clean(k.text)); });
      children(child(el, 'idList'), 'id').forEach(function (id) {
        if (ID_TYPES.indexOf(childText(id, 'idType')) >= 0 && childText(id, 'idNumber')) {
          records.push({ uid: childText(el, 'uid'), who: last && first ? last + ', ' + first : last || first, programs: programs, address: childText(id, 'idNumber') });
        }
      });
    });
    return { date: dm ? clean(dm[1]) : '', entries: count(xml, '<sdnEntry>'), records: records,
             expected: matches(xml, /Digital Currency Address - (?:XBT|BTC)/g) };                    // every mention, wherever it is
  }

  function readEnhanced(xml, head) {
    var dm = /<dataAsOf>(\d{4})-(\d{2})-(\d{2})/.exec(head), records = [];
    eachBlock(xml, /<type featureTypeId="\d+">\s*Digital Currency Address - (?:XBT|BTC)\s*<\/type>/g, '<entity ', '</entity>', function (el) {
      var names = child(el, 'names'), nm = firstWhere(children(names, 'name'), function (n) { return childText(n, 'isPrimary') === 'true'; });
      var tr = firstWhere(children(child(nm, 'translations'), 'translation'), function (t) { return childText(t, 'isPrimary') === 'true'; });
      var who = childText(tr, 'formattedFullName');
      if (!who) { var l = childText(tr, 'formattedLastName'), f = childText(tr, 'formattedFirstName'); who = l && f ? l + ', ' + f : l || f; }
      var programs = [];
      children(child(el, 'sanctionsPrograms'), 'sanctionsProgram').forEach(function (k) { if (clean(k.text)) programs.push(clean(k.text)); });
      children(child(el, 'features'), 'feature').forEach(function (ft) {
        if (ID_TYPES.indexOf(clean((child(ft, 'type') || { text: '' }).text)) >= 0 && childText(ft, 'value')) records.push({ uid: el.attrs.id || '', who: who, programs: programs, address: childText(ft, 'value') });
      });
    });
    return { date: dm ? dm[2] + '/' + dm[3] + '/' + dm[1] : '', entries: count(xml, '<entity '), records: records,
             expected: matches(xml, /Digital Currency Address - (?:XBT|BTC)/g) - matches(xml, /<type>\s*Digital Currency Address - (?:XBT|BTC)\s*<\/type>/g) };   // all mentions except the definition of the type
  }

  function readAdvanced(xml, head) {
    var dm = /<DateOfIssue[^>]*>\s*<Year>(\d{4})<\/Year>\s*<Month>(\d{1,2})<\/Month>\s*<Day>(\d{1,2})<\/Day>/.exec(head), records = [];
    var refEnd = xml.indexOf('</ReferenceValueSets>'), ref = xml.slice(0, refEnd > 0 ? refEnd : 5000000), m, ftIds = [], nameTypes = {};
    var ftRe = /<FeatureType ID="(\d+)"[^>]*>\s*Digital Currency Address - (?:XBT|BTC)\s*<\/FeatureType>/g, ntRe = /<NamePartType ID="(\d+)">([^<]*)<\/NamePartType>/g;
    while ((m = ftRe.exec(ref)) !== null) ftIds.push(m[1]);
    while ((m = ntRe.exec(ref)) !== null) nameTypes[m[1]] = clean(decode(m[2]));
    var expected = 0;
    ftIds.forEach(function (id) { expected += count(xml, 'FeatureTypeID="' + id + '"'); });
    if (ftIds.length) {
      eachBlock(xml, new RegExp('<Feature ID="\\d+" FeatureTypeID="(?:' + ftIds.join('|') + ')"', 'g'), '<Profile ', '</Profile>', function (el) {
        var ident = firstWhere(children(el, 'Identity'), function (i) { return i.attrs.Primary === 'true'; }), groups = {};
        children(child(ident, 'NamePartGroups'), 'MasterNamePartGroup').forEach(function (g) { var ng = child(g, 'NamePartGroup'); if (ng) groups[ng.attrs.ID] = ng.attrs.NamePartTypeID; });
        var alias = firstWhere(children(ident, 'Alias'), function (a) { return a.attrs.Primary === 'true'; });
        var dn = firstWhere(children(alias, 'DocumentedName'), function (d) { return d.attrs.DocNameStatusID === '1'; }), lastParts = [], rest = [];
        children(dn, 'DocumentedNamePart').forEach(function (part) {
          var v = child(part, 'NamePartValue'), t = v ? clean(v.text) : '', kind = v ? nameTypes[groups[v.attrs.NamePartGroupID]] : '';
          if (!t) return;
          if (kind === 'Last Name') lastParts.push(t.toUpperCase());
          else rest.push(kind === 'Entity Name' ? t.toUpperCase() : t);                   // OFAC writes surnames and organisation names in capitals in the other two layouts
        });
        var who = lastParts.length ? lastParts.join(' ') + (rest.length ? ', ' + rest.join(' ') : '') : rest.join(' ');
        children(el, 'Feature').forEach(function (ft) {
          var addr = clean((child(child(ft, 'FeatureVersion'), 'VersionDetail') || { text: '' }).text);
          if (ftIds.indexOf(ft.attrs.FeatureTypeID) >= 0 && addr) records.push({ uid: el.attrs.ID || '', who: who, programs: [], address: addr });
        });
      });
      // programmes: the "Program" measures (type 1) of each profile's sanctions entry
      var from = xml.indexOf('<SanctionsEntries>'), to = xml.indexOf('</SanctionsEntries>'), needed = {};
      records.forEach(function (r) { needed[r.uid] = []; });
      if (from >= 0 && to > from) {
        var seRe = /<SanctionsEntry\b[^>]*?\bProfileID="(\d+)"[^>]*>([\s\S]*?)<\/SanctionsEntry>/g, region = xml.slice(from, to), se;
        while ((se = seRe.exec(region)) !== null) {
          if (!needed[se[1]]) continue;
          var pr = /<SanctionsMeasure\b[^>]*?\bSanctionsTypeID="1"[^>]*>\s*<Comment>([^<]*)<\/Comment>/g, pm;
          while ((pm = pr.exec(se[2])) !== null) { var name = clean(decode(pm[1])); if (name && needed[se[1]].indexOf(name) < 0) needed[se[1]].push(name); }
        }
      }
      records.forEach(function (r) { r.programs = needed[r.uid] || []; });
    }
    return { date: dm ? pad2(dm[2]) + '/' + pad2(dm[3]) + '/' + dm[1] : '', entries: count(xml, '<DistinctParty '), records: records, expected: expected };
  }

  var LAYOUTS = {
    sdnList: { read: readLegacy, end: '</sdnList>', file: 'SDN.XML' },
    sanctionsData: { read: readEnhanced, end: '</sanctionsData>', file: 'SDN_ENHANCED.XML' },
    Sanctions: { read: readAdvanced, end: '</Sanctions>', file: 'SDN_ADVANCED.XML' }
  };

  // ---- the list ----------------------------------------------------------------------------------------------
  function looksLikeSdnCsv(s) {
    var lines = (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).split(/\r?\n/, 4).filter(Boolean);
    return lines.length > 0 && lines.every(function (l) { return /^\d+,"[^"]*",/.test(l) && l.indexOf('-0-') >= 0; });
  }

  /** { pack, info } for the Bitcoin addresses in the text of an SDN XML file (any of the three layouts).
   *  info: { layout, date, entries, withAddress, read, expected, warning }. */
  function convertXml(xml, opts) {
    opts = opts || {};
    xml = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    var head = xml.slice(0, 6000);
    if (xml.replace(/^\s+/, '').charAt(0) !== '<') throw fail('That is not an XML list. SDN.CSV cannot be used: it cuts long entries and loses addresses. Download SDN_XML.ZIP, SDN_ENHANCED.ZIP or SDN_ADVANCED.ZIP from ' + PAGE + '.');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('The file declares a DOCTYPE or entities, which the real list does not; refusing to read it.');
    var top = /<([A-Za-z_][\w.:-]*)[\s>\/]/.exec(head.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')), name = top ? local(top[1]) : '', lay = LAYOUTS.hasOwnProperty(name) ? LAYOUTS[name] : null;
    if (!lay) throw fail('This is not an OFAC SDN list (the top element is <' + (top ? top[1] : '?') + '>). Download SDN_XML.ZIP, SDN_ENHANCED.ZIP or SDN_ADVANCED.ZIP from ' + PAGE + '.');
    if (xml.slice(-200).replace(/\s+$/, '').slice(-lay.end.length) !== lay.end) throw fail('The file is cut short: it does not end where the list ends.');

    var r = lay.read(xml, head), found = new Map(), uids = new Set();
    r.records.forEach(function (rec) {
      uids.add(rec.uid);
      var f = found.get(rec.address);
      if (!f) { f = { uids: [], names: [], programs: [] }; found.set(rec.address, f); }
      if (/^\d{1,12}$/.test(rec.uid) && f.uids.indexOf(rec.uid) < 0) f.uids.push(rec.uid);
      if (rec.who && f.names.indexOf(rec.who) < 0) f.names.push(rec.who);
      rec.programs.forEach(function (pr) { if (f.programs.indexOf(pr) < 0) f.programs.push(pr); });
    });

    var labels = [], date = r.date;
    found.forEach(function (rec, address) {
      var names = rec.names, entry = {
        address: address,
        label: names.length ? 'OFAC SDN: ' + names.slice(0, 3).join(' / ') + (names.length > 3 ? ' (+' + (names.length - 3) + ' more)' : '') : 'OFAC SDN',
        url: rec.uids.length ? ENTRY_PAGE + rec.uids[0] : PAGE
      };
      var cat = category(rec.programs, 40);
      if (cat) entry.category = cat;
      entry.note = (rec.uids.length ? 'OFAC SDN entry ' + rec.uids.join(', ') : 'OFAC SDN') + (date ? '; list dated ' + date : '');
      labels.push(entry);
    });
    if (!labels.length) throw fail('No Bitcoin addresses found: is this the SDN list?');
    var today = opts.today || new Date(opts.now != null ? opts.now : Date.now()).toISOString().slice(0, 10);
    var pack = { format: 'hopline-labels', version: 1, name: 'OFAC SDN list (Bitcoin)',
                 source: 'U.S. Treasury OFAC SDN list (' + lay.file + (date ? ', dated ' + date : '') + '), converted ' + today,
                 created: new Date(opts.now != null ? opts.now : Date.now()).toISOString(), labels: labels };
    var info = { layout: name, date: date, entries: r.entries, withAddress: uids.size, read: r.records.length, expected: r.expected, warning: '' };
    if (info.read !== info.expected) info.warning = 'The file mentions ' + info.expected + ' Bitcoin address entries but only ' + info.read + ' could be read: the list may have a layout this page does not know, so the pack may be incomplete.';
    return { pack: pack, info: info };
  }

  /** Promise of { pack, info } from the bytes (an ArrayBuffer or Uint8Array) of a zip of the list or of the XML itself. */
  function convertFile(buffer, opts) {
    return Promise.resolve().then(function () {
      var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (!bytes.length) throw fail('The file is empty.');
      return bytes[0] === 0x50 && bytes[1] === 0x4b ? unzipXml(bytes) : text(bytes);
    }).then(function (xml) { return convertXml(xml, opts); });
  }

  return { PAGE: PAGE, ENTRY_PAGE: ENTRY_PAGE, convertFile: convertFile, convertXml: convertXml, unzipXml: unzipXml, looksLikeSdnCsv: looksLikeSdnCsv, category: category };
}));
