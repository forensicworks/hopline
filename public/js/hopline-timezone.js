/*
 * Hopline timezone fit: what the times of some transactions can say about the local time of whoever sent them. A HYPOTHESIS GENERATOR, not a finding.
 *
 * The times are of the events that were put in: the time a service first saw a transaction when that is known, else the time of its block (the transaction may have been sent minutes or hours
 * earlier). Transactions within half an hour of each other are one event: a person sitting down to move money (or a script run) is one point, not several. For each whole-hour offset from UTC it
 * says what the local hour of each event would be, and how many fall in waking hours (07:00 to 22:59) and at night (00:00 to 05:59).
 *
 * It refuses to conclude from little. A day has 24 hours, so a handful of events fits many offsets: with fewer than NEED_EVENTS events over NEED_DAYS days it says so and lists what still fits, that is all.
 * With enough it also names the quietest stretch of the day (UTC) and the offsets for which that stretch falls in the small hours, as one reading of when the person sleeps. People work nights, scripts run at any hour,
 * and a transaction can wait for a block: none of this is proof of where anybody is. Pure functions; nothing here touches the DOM or the network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineTimezone = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLUSTER_S = 1800, NEED_EVENTS = 8, NEED_DAYS = 3, WAKE_FROM = 7, WAKE_TO = 23, NIGHT_TO = 6, SLEEP_FROM = 1, SLEEP_TO = 7;
  var OFFSETS = []; for (var o = -12; o <= 14; o++) OFFSETS.push(o);
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function offsetText(o) { return 'UTC' + (o < 0 ? '-' : '+') + Math.abs(o); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function hourText(h) { var m = Math.round(mod(h, 24) * 60) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }

  /**
   * Events from times: items [{ txid, time, basis ('first seen' | 'block time') }] -> [{ time (the first), last, txids, basis ('first seen', 'block time' or 'mixed') }], oldest first.
   * Items without a time are left out.
   */
  function events(items) {
    var list = (items || []).filter(function (x) { return x && typeof x.time === 'number' && isFinite(x.time); }).sort(function (a, b) { return a.time - b.time; });
    var out = [];
    list.forEach(function (x) {
      var e = out[out.length - 1];
      if (e && x.time - e.last <= CLUSTER_S) { e.last = x.time; e.txids.push(x.txid); if (e.basis !== x.basis) e.basis = 'mixed'; return; }
      out.push({ time: x.time, last: x.time, txids: [x.txid], basis: x.basis || 'block time' });
    });
    return out;
  }

  /** The longest stretch of the day (UTC, hours, going round midnight) with no event in it: { start, length, mid } or null with fewer than two events. */
  function quietest(evs) {
    if (!evs || evs.length < 2) return null;
    var h = evs.map(function (e) { return mod(e.time / 3600, 24); }).sort(function (a, b) { return a - b; }), best = null;
    for (var i = 0; i < h.length; i++) {
      var from = h[i], to = i + 1 < h.length ? h[i + 1] : h[0] + 24, len = to - from;
      if (!best || len > best.length) best = { start: mod(from, 24), length: len, mid: mod(from + len / 2, 24) };
    }
    return best;
  }

  function fitsAt(evs, off) {
    var hours = [], days = [], waking = 0, night = 0;
    evs.forEach(function (e) {
      var local = e.time + off * 3600, hr = mod(local / 3600, 24);
      hours.push(hr); days.push(WEEKDAYS[mod(Math.floor(local / 86400) + 4, 7)]);
      if (hr >= WAKE_FROM && hr < WAKE_TO) waking++;
      if (hr < NIGHT_TO) night++;
    });
    return { offset: off, text: offsetText(off), hours: hours, days: days, waking: waking, night: night, all: waking === evs.length };
  }

  /** The offsets as ranges of text: [-8, -7, -6, -5, 8] -> "UTC-8 to UTC-5, UTC+8". */
  function ranges(list) {
    var out = [], i = 0, s = list.slice().sort(function (a, b) { return a - b; });
    while (i < s.length) { var j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j > i ? offsetText(s[i]) + ' to ' + offsetText(s[j]) : offsetText(s[i])); i = j + 1; }
    return out.join(', ');
  }

  /**
   * What the events say. { n, spanDays, events, offsets: [{ offset, text, hours, days, waking, night, all }], fitting (offsets with every event in waking hours), enough,
   * need: { events, days }, quiet (quietest stretch or null), sleep (offsets for which it falls in the small hours; only when enough), text (the sentence to show), basis }.
   */
  function fit(items) {
    var evs = events(items), n = evs.length, span = n ? (evs[n - 1].time - evs[0].time) / 86400 : 0;
    var offs = OFFSETS.map(function (o) { return fitsAt(evs, o); });
    var fitting = offs.filter(function (x) { return x.all; }).map(function (x) { return x.offset; });
    var enough = n >= NEED_EVENTS && span >= NEED_DAYS, quiet = quietest(evs), sleep = null, text;
    if (enough && quiet) sleep = OFFSETS.filter(function (o) { var l = mod(quiet.mid + o, 24); return l >= SLEEP_FROM && l < SLEEP_TO; });
    var basis = evs.reduce(function (acc, e) { return acc === null ? e.basis : (acc === e.basis ? acc : 'mixed'); }, null);
    if (!n) text = 'No transaction with a time.';
    else if (!enough) {
      text = n + (n === 1 ? ' event' : ' events') + ' over ' + (Math.round(span * 10) / 10) + ' days is too few to say anything about a daily rhythm: a day has 24 hours, and they fit ' + (fitting.length === OFFSETS.length ? 'every' : fitting.length + ' of ' + OFFSETS.length)
           + ' whole-hour offsets' + (fitting.length && fitting.length < OFFSETS.length ? ' (' + ranges(fitting) + ') if they were sent in waking hours' : '') + '. At least ' + NEED_EVENTS + ' events over ' + NEED_DAYS + ' days are needed before a quiet stretch means anything.';
    } else {
      text = n + ' events over ' + (Math.round(span * 10) / 10) + ' days. The quietest stretch of the day is ' + hourText(quiet.start) + ' to ' + hourText(quiet.start + quiet.length) + ' UTC (' + (Math.round(quiet.length * 10) / 10) + ' hours)'
           + (sleep && sleep.length ? '; if that is when the person sleeps, the local time is ' + ranges(sleep) + '.' : ', which does not fall in the small hours of any whole-hour offset.')
           + (fitting.length && fitting.length < OFFSETS.length ? ' With every event in waking hours: ' + ranges(fitting) + '.' : '') + ' A hypothesis: people work nights and scripts run at any hour.';
    }
    return { n: n, spanDays: span, events: evs, offsets: offs, fitting: fitting, enough: enough, need: { events: NEED_EVENTS, days: NEED_DAYS }, quiet: quiet, sleep: sleep, text: text, basis: basis };
  }

  return { events: events, fit: fit, quietest: quietest, ranges: ranges, offsetText: offsetText, hourText: hourText, OFFSETS: OFFSETS, CLUSTER_S: CLUSTER_S, NEED_EVENTS: NEED_EVENTS, NEED_DAYS: NEED_DAYS };
}));
