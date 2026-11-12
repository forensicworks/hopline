/*
 * Hopline version: which version of the code this page is, and whether the site now has a newer one.
 *
 * A published copy (tools/build_site.py with --code-version and --code-date) says in public/config.js which version it is (HOPLINE_CONFIG.version, a short commit id,
 * and HOPLINE_CONFIG.committed, when that change was made, UTC) and has a version.json at its root with the same two facts about what is published now.
 *   * Every element marked data-version shows "Version <id>" (and is hidden on a copy that has no version: a local run, a copy built without one).
 *   * A page left open asks its own site for version.json now and then (a few seconds after it opens, every half hour, and when the tab comes back after a while) and,
 *     when the site holds a version that was committed LATER than this page's, shows the bar #newVersion: "A newer version is available", with Reload and Not now.
 *     "Later" is what counts, not "different": a copy that is served a little behind, or a roll back, does not tell the page that it is out of date.
 * Nothing is sent anywhere but the page's own site, and nothing is stored: "Not now" is remembered only until the page is closed.
 * The daily refresh of the label packs does not change the version (see tools/code_version.py), so it does not show the bar either.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.HoplineVersion = factory();
    if (root.document) {
      var go = function () { root.HoplineVersion.start(root); };
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', go); else go();
    }
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID = /^[0-9A-Za-z._-]{1,40}$/, WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  var FIRST_MS = 3000, EVERY_MS = 30 * 60 * 1000, IDLE_MS = 10 * 60 * 1000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** {version, committed} from a settings object or a version.json, or null when there is no usable version. `committed` is null when it is missing or not a UTC time. */
  function parse(o) {
    if (!o || typeof o !== 'object' || typeof o.version !== 'string' || !ID.test(o.version)) return null;
    return { version: o.version, committed: typeof o.committed === 'string' && WHEN.test(o.committed) ? o.committed : null };
  }

  /** Is `other` a version committed after `own`? Both need a date: without one the page cannot tell newer from different, and says nothing. */
  function isNewer(own, other) {
    return !!(own && other && own.version !== other.version && own.committed && other.committed && other.committed > own.committed);
  }

  /** "12 Nov 2026 00:36 UTC" from 2026-11-12T00:36:21Z, or '' when there is no date. */
  function when(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] + ' ' + m[4] + ':' + m[5] + ' UTC' : '';
  }

  /** "ae67f10, committed 12 Nov 2026 00:36 UTC". */
  function describe(v) { return v.version + (v.committed ? ', committed ' + when(v.committed) : ''); }

  /** Time to look again? (Never looked, or `every` ms have passed.) */
  function due(now, last, every) { return last == null || now - last >= every; }

  function ms(v, fallback) { return typeof v === 'number' && v >= 0 && isFinite(v) ? v : fallback; }

  /**
   * Start on a window: show the version where it is asked for, and watch for a newer one where there is a #newVersion bar. The bar says where version.json is
   * (data-root, "" for the start page and "../" for the pages in public/) and whether a reload costs work (data-work).
   * HOPLINE_CONFIG.versionCheck = {first, every} (milliseconds) changes the timing: the tests use it. Returns the version of this page, or null.
   */
  function start(win) {
    var doc = win.document, cfg = win.HOPLINE_CONFIG || {}, own = parse({ version: cfg.version, committed: cfg.committed });
    if (!own) return null;
    Array.prototype.forEach.call(doc.querySelectorAll('[data-version]'), function (el) {
      el.textContent = 'Version ' + own.version;
      el.title = 'The last change to the code of this copy' + (own.committed ? ': ' + when(own.committed) : '') + '. A daily refresh of the label packs does not change it.';
      el.hidden = false;
    });
    var bar = doc.getElementById('newVersion');
    if (!bar || typeof win.fetch !== 'function') return own;
    var t = cfg.versionCheck || {}, first = ms(t.first, FIRST_MS), every = ms(t.every, EVERY_MS), idle = ms(t.idle, IDLE_MS);
    var root = bar.getAttribute('data-root') || '', dismissed = null, last = null, busy = false;

    function node(tag, text, cls) { var e = doc.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
    function show(v) {
      bar.textContent = '';
      var msg = node('span', 'A newer version of Hopline is available (' + describe(v) + ').' +
        (bar.hasAttribute('data-work') ? ' Export your work first, or keep the session in this browser: a reload starts the page over.' : ''), 'msg');
      var reload = node('button', 'Reload', 'primary'); reload.type = 'button'; reload.id = 'newVersionReload';
      reload.addEventListener('click', function () { win.location.reload(); });
      var later = node('button', 'Not now'); later.type = 'button'; later.id = 'newVersionLater';
      later.addEventListener('click', function () { dismissed = v.version; bar.hidden = true; });
      bar.appendChild(msg); bar.appendChild(reload); bar.appendChild(later);
      bar.hidden = false;
    }
    function check() {
      if (busy) return;
      busy = true; last = Date.now();
      win.fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('no version.json'); return r.json(); })
        .then(function (j) {
          var v = parse(j);
          if (isNewer(own, v)) { if (v.version !== dismissed) show(v); } else bar.hidden = true;
        })
        .catch(function () { /* a copy that cannot be asked (offline, a local run) says nothing */ })
        .then(function () { busy = false; });
    }
    win.setTimeout(check, first);
    win.setInterval(check, every);
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible' && due(Date.now(), last, idle)) check(); });
    return own;
  }

  return { parse: parse, isNewer: isNewer, when: when, describe: describe, due: due, start: start, FIRST_MS: FIRST_MS, EVERY_MS: EVERY_MS, IDLE_MS: IDLE_MS };
}));
