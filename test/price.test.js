'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/js/hopline-price.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const DAY = 86400;
const utc = (y, m, d, h) => Date.UTC(y, m - 1, d, h || 0) / 1000;

test('convert and format', () => {
  assert.equal(P.convert(1e8, 50000), 50000);
  assert.equal(P.convert(12345678, 40000), 4938.2712);
  assert.equal(P.format(1234.567, 'USD'), '$1,234.57');
  assert.equal(P.format(1234.567, 'JPY'), '¥1,235', 'yen has no decimals');
  assert.equal(P.format(0, 'EUR'), '€0.00');
  assert.equal(P.format(0.004, 'USD'), '< $0.01');
  assert.equal(P.format(-3.5, 'GBP'), '-£3.50');
  assert.equal(P.format(NaN, 'USD'), '');
  assert.equal(P.format(1, 'XXX'.slice(0, 3) === 'XXX' ? 'ZZZ' : 'USD').length > 0, true, 'an unknown currency code still formats');
  assert.equal(P.plain(1234.5678912, 'USD'), '1234.5679');
  assert.equal(P.plain(null, 'USD'), '');
});

// A hand-made series in the real API's shape: newest first, -1 for "no data in this currency"
function series() {
  return { prices: [
    { time: utc(2024, 3, 1), USD: 60000, EUR: 55000 },
    { time: utc(2024, 2, 29), USD: 58000, EUR: 53000 },
    { time: utc(2023, 1, 8), USD: 17000, EUR: -1 },
    { time: utc(2023, 1, 1), USD: 16000, EUR: 15000 },
    { time: utc(2022, 12, 25), USD: 15000, EUR: 14000 },
    { time: utc(2010, 7, 19), USD: 0.08, EUR: -1 }
  ], exchangeRates: { USDEUR: 0.9, USDGBP: 0.75 } };
}

test('PriceBook sorts the newest-first series, drops -1 entries and interpolates linearly', () => {
  const b = new P.PriceBook(series(), 'EUR');
  assert.equal(b.size(), 4, 'the -1 entries are skipped');
  assert.equal(b.firstTime(), utc(2022, 12, 25));
  assert.equal(b.lastTime(), utc(2024, 3, 1));
  const mid = b.rateAt(utc(2022, 12, 28, 12));                   // halfway between 25 Dec (14000) and 1 Jan (15000)
  assert.ok(Math.abs(mid.price - (14000 + 1000 * (3.5 / 7))) < 1e-6, String(mid.price));
  assert.equal(mid.derived, false);
  assert.ok(mid.approx, 'seven days apart: only an approximation');
  assert.ok(Math.abs(mid.spanDays - 7) < 1e-9);
  const exact = b.rateAt(utc(2023, 1, 1));
  assert.equal(exact.price, 15000);
});

test('hourly/daily data is not flagged approximate; weekly is', () => {
  const b = new P.PriceBook(series(), 'USD');
  assert.equal(b.rateAt(utc(2024, 2, 29, 12)).approx, false, 'one day apart');
  assert.equal(b.rateAt(utc(2023, 1, 4)).approx, true);
});

test('before the first data point in a currency, the USD price at today\'s exchange rate is used and flagged derived', () => {
  const b = new P.PriceBook(series(), 'EUR');
  const r = b.rateAt(utc(2023, 1, 8) - 0);                        // the EUR entry for 8 Jan is -1, but 1 Jan..1 Mar EUR points surround it
  assert.equal(r.derived, false, 'inside the range, neighbouring valid points are interpolated');
  const old = b.rateAt(utc(2011, 1, 1));
  assert.equal(old.derived, true);
  assert.ok(old.approx);
  const usdAt = new P.PriceBook(series(), 'USD').rateAt(utc(2011, 1, 1)).price;
  assert.ok(Math.abs(old.price - usdAt * 0.9) < 1e-9, 'the USD price times the USD->EUR exchange rate');
  assert.equal(new P.PriceBook(series(), 'JPY').rateAt(utc(2023, 1, 1)), null, 'no yen data and no exchange rate: nothing to say');
});

test('outside the series the nearest point is used and flagged', () => {
  const b = new P.PriceBook(series(), 'USD');
  const future = b.rateAt(utc(2030, 1, 1));
  assert.equal(future.price, 60000);
  assert.ok(future.outside && future.approx);
  const empty = new P.PriceBook({ prices: [] }, 'USD');
  assert.equal(empty.rateAt(utc(2024, 1, 1)), null);
  assert.equal(empty.size(), 0);
  assert.equal(new P.PriceBook(null, 'USD').rateAt(1), null);
});

test('garbage entries are ignored', () => {
  const b = new P.PriceBook({ prices: [{ time: 'x', USD: 1 }, { time: 10, USD: 'high' }, null, { time: 20, USD: 100 }, { time: 30, USD: -5 }, { time: 40, USD: 0 }] }, 'USD');
  assert.equal(b.size(), 1);
  assert.equal(b.rateAt(25).price, 100);
});

test('real mempool.space sample: weekly in 2022 (flagged), recent points exact, EUR -1 gaps skipped', () => {
  const j = fx('historical_price_sample.json');
  const usd = new P.PriceBook(j, 'USD'), eur = new P.PriceBook(j, 'EUR');
  assert.ok(usd.size() > 30);
  const t = 1649176756;                                           // 2022-04-05 16:39 UTC, the sample transaction
  const r = usd.rateAt(t);
  assert.ok(r.approx && r.spanDays > 5 && r.spanDays < 8, JSON.stringify(r));
  assert.ok(r.price > 40000 && r.price < 48000, 'USD/BTC early April 2022 was around 45k, got ' + r.price);
  const e = eur.rateAt(t);
  assert.ok(e.price < r.price && e.price > r.price * 0.8, 'euro price is below the dollar price');
  const newest = Math.max(...j.prices.map((p) => p.time));
  assert.equal(usd.rateAt(newest).price, j.prices.find((p) => p.time === newest).USD);
  assert.equal(usd.lastTime(), newest);
});

test('parseToday reads /v1/prices and refuses a missing currency', () => {
  const j = fx('prices_now.json');
  assert.deepEqual(P.parseToday(j, 'EUR'), { price: 73541, time: 1792083612 });
  assert.equal(P.parseToday(j, 'XYZ'), null);
  assert.equal(P.parseToday(null, 'USD'), null);
  assert.equal(P.parseToday({ USD: -1 }, 'USD'), null);
  assert.deepEqual(P.CURRENCIES, ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY']);
});

// ---- the rules both pages use to price an amount --------------------------------------------------------------------------------------------
const CTX = (extra) => Object.assign({ books: {}, today: null, fmtTime: (t) => 'T' + t }, extra);
const DAILY = { prices: [{ time: 2000000, USD: 30000, EUR: 28000 }, { time: 1913600, USD: 20000, EUR: 18000 }, { time: 1827200, USD: 10000, EUR: 9000 }], exchangeRates: { USDEUR: 0.9 } };
const BOOK = () => ({ EUR: new P.PriceBook(DAILY, 'EUR') });
const WEEKLY = { prices: [{ time: 3000000, USD: 30000, EUR: 28000 }, { time: 2395200, USD: 10000, EUR: 9000 }], exchangeRates: { USDEUR: 0.9 } };

test('rateFor: nothing without a currency or without prices, today\'s price for "today" and for something not confirmed yet', () => {
  assert.equal(P.rateFor({ currency: 'off', basis: 'each' }, 1913600, CTX()), null); assert.equal(P.rateFor(null, 1, CTX()), null);
  assert.equal(P.rateFor({ currency: 'EUR', basis: 'each' }, 1913600, CTX()), null, 'no price history loaded yet');
  const ctx = CTX({ today: { time: 2100000, EUR: 40000 }, books: BOOK() });
  const today = P.rateFor({ currency: 'EUR', basis: 'today' }, 1913600, ctx);
  assert.deepEqual([today.price, today.approx, today.note], [40000, false, 'today\'s price']); assert.equal(today.label, 'today T2100000');
  const pending = P.rateFor({ currency: 'EUR', basis: 'each' }, null, ctx);
  assert.deepEqual([pending.price, pending.note], [40000, 'not confirmed yet, so today\'s price']);
  assert.equal(P.rateFor({ currency: 'EUR', basis: 'today' }, 1, CTX({ books: BOOK() })), null, 'today\'s price is not loaded');
});

test('rateFor: the price at the time, interpolated, with the note that says how good it is', () => {
  const ctx = CTX({ books: BOOK() }), fiat = { currency: 'EUR', basis: 'each' };
  const exact = P.rateFor(fiat, 1913600, ctx);
  assert.equal(exact.price, 18000); assert.equal(exact.label, 'T1913600'); assert.equal(exact.approx, false); assert.equal(exact.note, 'hourly/daily data');
  const weekly = CTX({ books: { EUR: new P.PriceBook(WEEKLY, 'EUR') } }), mid = P.rateFor(fiat, 2697600, weekly);
  assert.equal(mid.price, 18500); assert.equal(mid.approx, true); assert.equal(mid.note, 'interpolated between price points 7.0 days apart');
});

test('amountOf: the value, its text with the ≈ sign only where the price is rough, and the tip that explains it', () => {
  const ctx = CTX({ books: BOOK(), today: { time: 2100000, EUR: 40000 } }), fiat = { currency: 'EUR', basis: 'each' };
  const a = P.amountOf(fiat, 50000000, 1913600, ctx);
  assert.equal(a.value, 9000); assert.equal(a.text, '€9,000.00'); assert.equal(a.approx, false); assert.match(a.title, /€18,000\.00 per BTC at T1913600 \(hourly\/daily data\)/);
  const rough = P.amountOf(fiat, 100000000, 1870400, ctx);                                // halfway between two points: interpolated
  assert.equal(rough.value, 13500); assert.equal(rough.approx, false);
  const early = P.amountOf(fiat, 100000000, 100, ctx);                                      // before the series: the USD price at today's rate, flagged
  assert.equal(early.approx, true); assert.ok(early.text.startsWith('≈ ')); assert.match(early.title, /USD price converted at today's exchange rate \(no EUR data that early\)/);
  assert.equal(P.amountOf(fiat, null, 1913600, ctx), null); assert.equal(P.amountOf(fiat, 5, 1913600, CTX()), null);
  assert.equal(P.amountOf({ currency: 'EUR', basis: 'ref', ref: { time: 1827200 } }, 100000000, 1913600, ctx).value, 9000, 'at a reference moment every amount uses its price');
  assert.equal(P.amountOf({ currency: 'EUR', basis: 'ref', ref: null }, 100000000, 1913600, ctx).value, 40000, 'a reference that is not set is today\'s price');
});
