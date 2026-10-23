/*
 * Hopline fiat conversion: turn satoshis into a currency amount using the price at a moment in time (or today's).
 * Pure functions, no network: the page fetches the data, this module reads it.
 *
 * Data shapes (mempool.space):
 *   GET /api/v1/historical-price?currency=EUR  -> { prices: [{time, USD, EUR}, ...], exchangeRates: {USDEUR: 0.9, ...} }
 *       newest first; an entry is -1 where that currency has no data; weekly points before 2023-03-05, daily until
 *       2024-01-05, hourly after. Between points the price is interpolated linearly.
 *   GET /api/v1/prices                         -> { time, USD, EUR, GBP, CAD, CHF, AUD, JPY }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplinePrice = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY'];
  var DAY = 86400;
  // Data points further apart than this make an interpolated price only approximate (weekly data is ~7 days apart).
  var APPROX_SPAN = 2 * DAY;

  function validPrice(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

  /** Linear interpolation over points sorted by time ascending. Returns {price, span, before, after} or null if empty. */
  function interpolate(pts, t) {
    if (!pts.length) return null;
    if (t <= pts[0].t) return { price: pts[0].p, span: 0, before: pts[0].t, after: pts[0].t, outside: t < pts[0].t };
    var last = pts[pts.length - 1];
    if (t >= last.t) return { price: last.p, span: 0, before: last.t, after: last.t, outside: t > last.t };
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
    var a = pts[lo], b = pts[hi], k = (t - a.t) / (b.t - a.t);
    return { price: a.p + (b.p - a.p) * k, span: b.t - a.t, before: a.t, after: b.t, outside: false };
  }

  /**
   * A price history for one currency. `json` is the historical-price response. Entries without data for the currency
   * are skipped; before the first usable entry the USD price times the exchange rate is used and marked derived.
   */
  function PriceBook(json, currency) {
    this.currency = currency;
    var usd = [], own = [], rates = (json && json.exchangeRates) || {};
    ((json && json.prices) || []).forEach(function (p) {
      if (!p || typeof p.time !== 'number') return;
      if (validPrice(p.USD)) usd.push({ t: p.time, p: p.USD });
      if (currency === 'USD') { if (validPrice(p.USD)) own.push({ t: p.time, p: p.USD }); }
      else if (validPrice(p[currency])) own.push({ t: p.time, p: p[currency] });
    });
    function byTime(a, b) { return a.t - b.t; }
    this.usd = usd.sort(byTime); this.own = own.sort(byTime);
    this.cross = currency === 'USD' ? 1 : (typeof rates['USD' + currency] === 'number' ? rates['USD' + currency] : null);
  }

  PriceBook.prototype.size = function () { return this.own.length || this.usd.length; };
  PriceBook.prototype.firstTime = function () { var a = this.own.length ? this.own : this.usd; return a.length ? a[0].t : null; };
  PriceBook.prototype.lastTime = function () { var a = this.own.length ? this.own : this.usd; return a.length ? a[a.length - 1].t : null; };

  /**
   * The price of one BTC at unix time t: { price, approx, derived, spanDays, before, after, outside } or null.
   *   approx   the surrounding data points are more than 2 days apart (older history is weekly)
   *   derived  no data in this currency that early: USD price converted at today's exchange rate
   *   outside  t is before the first / after the last data point (the nearest point is used)
   */
  PriceBook.prototype.rateAt = function (t) {
    var r = interpolate(this.own, t), derived = false;
    if (!r || (r.outside && this.usd.length && t < this.own[0].t)) {
      var u = this.cross != null ? interpolate(this.usd, t) : null;
      if (u) { r = { price: u.price * this.cross, span: u.span, before: u.before, after: u.after, outside: u.outside }; derived = true; }
    }
    if (!r) return null;
    return { price: r.price, approx: r.span > APPROX_SPAN || derived || r.outside, derived: derived, outside: r.outside, spanDays: r.span / DAY, before: r.before, after: r.after };
  };

  /** Today's price from /v1/prices: { price, time } or null when the currency is missing. */
  function parseToday(json, currency) {
    if (!json || !validPrice(json[currency])) return null;
    return { price: json[currency], time: typeof json.time === 'number' ? json.time : null };
  }

  /** A saved fiat choice, made safe: { currency ('off' or one of CURRENCIES), basis ('each' | 'ref' | 'today'), show ('btc' | 'both' | 'fiat'), ref: { txid, time } | null }. */
  function cleanFiat(f) {
    var out = { currency: 'off', basis: 'each', show: 'both', ref: null };
    if (!f || typeof f !== 'object') return out;
    if (f.currency === 'off' || CURRENCIES.indexOf(f.currency) >= 0) out.currency = f.currency;
    if (f.basis === 'each' || f.basis === 'ref' || f.basis === 'today') out.basis = f.basis;
    if (f.show === 'btc' || f.show === 'both' || f.show === 'fiat') out.show = f.show;
    if (f.ref && typeof f.ref.txid === 'string' && /^[0-9a-f]{64}$/.test(f.ref.txid) && typeof f.ref.time === 'number' && isFinite(f.ref.time)) out.ref = { txid: f.ref.txid, time: f.ref.time };
    return out;
  }

  /** Satoshis -> currency units at `price` per BTC. */
  function convert(sats, price) { return sats / 1e8 * price; }

  /**
   * The price to use for something that happened at `time` (unix seconds; null = not confirmed yet), following the saved choice
   * fiat = { currency, basis: 'each' | 'ref' | 'today', ref: { time } | null }.
   * ctx = { books: { CURRENCY: PriceBook }, today: the /v1/prices reply | null, fmtTime(unix, withTime) -> text }.
   * Returns { price, label, approx, note } or null when the prices are not loaded (yet).
   */
  function rateFor(fiat, time, ctx) {
    if (!fiat || fiat.currency === 'off') return null;
    var basis = fiat.basis, t = time;
    if (basis === 'ref') { if (fiat.ref) t = fiat.ref.time; else basis = 'today'; }
    if (basis === 'today' || t == null) {
      var td = ctx.today ? parseToday(ctx.today, fiat.currency) : null; if (!td) return null;
      var when = td.time ? ctx.fmtTime(td.time, false) : 'today';
      return { price: td.price, label: 'today ' + when, approx: false, note: basis === 'today' ? 'today\'s price' : 'not confirmed yet, so today\'s price' };
    }
    var book = ctx.books && ctx.books[fiat.currency]; if (!book) return null;
    var r = book.rateAt(t); if (!r) return null;
    var note = r.derived ? 'USD price converted at today\'s exchange rate (no ' + fiat.currency + ' data that early)' : r.outside ? 'outside the price history, nearest point used'
             : r.approx ? 'interpolated between price points ' + r.spanDays.toFixed(1) + ' days apart' : 'hourly/daily data';
    return { price: r.price, label: ctx.fmtTime(t, false), approx: r.approx, note: note };
  }

  /** { value, text, title, approx, rate } for `sats` at `time`, or null (see rateFor). text carries "≈ " where the price is interpolated or derived. */
  function amountOf(fiat, sats, time, ctx) {
    if (sats == null) return null;
    var r = rateFor(fiat, time, ctx); if (!r) return null;
    var v = convert(sats, r.price), cur = fiat.currency;
    return { value: v, text: (r.approx ? '≈ ' : '') + format(v, cur), approx: r.approx, rate: r, title: format(r.price, cur) + ' per BTC at ' + r.label + ' (' + r.note + ')' };
  }

  /** "$1,234.56", "¥1,235", "< $0.01" for tiny values. */
  function format(value, currency) {
    if (value == null || !isFinite(value)) return '';
    var digits = currency === 'JPY' ? 0 : 2, nf;
    try { nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency, minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch (e) { return value.toFixed(digits) + ' ' + currency; }
    if (value !== 0 && Math.abs(value) < Math.pow(10, -digits)) return (value < 0 ? '-' : '< ') + nf.format(Math.pow(10, -digits));
    return nf.format(value);
  }

  /** A fixed-precision number for exports (never scientific notation). */
  function plain(value, currency) { return value == null || !isFinite(value) ? '' : value.toFixed(currency === 'JPY' ? 2 : 4); }

  return { CURRENCIES: CURRENCIES, PriceBook: PriceBook, parseToday: parseToday, convert: convert, cleanFiat: cleanFiat, rateFor: rateFor, amountOf: amountOf, format: format, plain: plain, interpolate: interpolate, APPROX_SPAN: APPROX_SPAN };
}));
