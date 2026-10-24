/*
 * Hopline visit counter, for a copy of the pages that is published on a web site. It does nothing unless public/config.js says where to
 * count (tools/build_site.py writes that for the published copy); the open edition, a local run and a file:// copy never send anything.
 *
 * What it sends: the page that was opened ("/", "/wallet" or "/workspace") and, for a few actions, a fixed event name such as "report".
 * Nothing else: no address, transaction id, label, note, query string or hash, and no referrer. It is an image request to the counting
 * service, not a script from it, so that service's code never runs on this origin (where the saved session lives). A browser that sends
 * Do Not Track or Global Privacy Control is not counted. The service is GoatCounter (its tracking-pixel form: <endpoint>?p=<name>&e=1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineStats = factory().create(root);
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGES = { '': '/', 'index.html': '/', 'wallet.html': '/wallet', 'workspace.html': '/workspace' };
  var EVENT = /^[a-z][a-z0-9-]{0,39}$/;

  /** The counting address from the settings, or null: https only, and a plain path (no query, no hash, no credentials). */
  function endpointOf(cfg) {
    var s = cfg && cfg.stats, e = s && typeof s.endpoint === 'string' ? s.endpoint : '';
    return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._\/-]*$/.test(e) ? e : null;
  }
  /** The name a page is counted under, from its path, or null for anything that is not one of the three pages. */
  function pagePath(pathname) {
    var f = String(pathname == null ? '' : pathname).split('/').pop().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PAGES, f) ? PAGES[f] : null;
  }
  function eventName(name) { return typeof name === 'string' && EVENT.test(name) ? name : null; }
  /** Do Not Track or Global Privacy Control: the visitor said no. */
  function optedOut(nav, win) {
    return !!((nav && (nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || nav.globalPrivacyControl === true)) || (win && win.doNotTrack === '1'));
  }
  /** The request for one count: a page (name starts with "/") or an event. `rnd` only keeps a browser from reusing an answer. */
  function pixelUrl(endpoint, name, isEvent, rnd) {
    return endpoint + '?p=' + encodeURIComponent(name) + (isEvent ? '&e=1' : '') + '&rnd=' + encodeURIComponent(String(rnd == null ? '' : rnd));
  }

  /** The counter for a window: { enabled, hit(eventName), page() }. Disabled (and silent) without settings or when the visitor opted out. */
  function create(win) {
    var endpoint = endpointOf(win && win.HOPLINE_CONFIG), enabled = !!endpoint && !optedOut(win.navigator, win);
    function send(name, isEvent) {
      if (!enabled || !name) return false;
      try {
        var img = new win.Image(); img.referrerPolicy = 'no-referrer';
        img.src = pixelUrl(endpoint, name, isEvent, Math.random().toString(36).slice(2));
        return true;
      } catch (e) { return false; }                                       // a counter must never break the page
    }
    var api = {
      enabled: enabled,
      hit: function (name) { return send(eventName(name), true); },
      page: function () { return send(pagePath(win.location && win.location.pathname), false); }
    };
    if (enabled && win.document) {
      var go = function () {
        Array.prototype.forEach.call(win.document.querySelectorAll('[data-counter]'), function (n) { n.hidden = false; });   // the note that says the site counts
        api.page();
      };
      if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', go); else go();
    }
    return api;
  }

  return { create: create, endpointOf: endpointOf, pagePath: pagePath, eventName: eventName, optedOut: optedOut, pixelUrl: pixelUrl };
}));
