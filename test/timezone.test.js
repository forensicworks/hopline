'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TZ = require('../public/js/hopline-timezone.js');

const at = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi || 0, s || 0) / 1000;
const item = (txid, time, basis) => ({ txid, time, basis: basis || 'block time' });

test('events: transactions within half an hour are one event, and a time that is not a time is left out', () => {
  const t = at(2026, 3, 5, 16, 40, 12);
  const evs = TZ.events([item('a', t), item('b', t), item('c', t + 1700, 'first seen'), item('d', t + 1700 + 1801), item('e', NaN), item('f', null), null, { txid: 'g' }]);
  assert.deepEqual(evs.map((e) => [e.time, e.txids, e.basis]), [[t, ['a', 'b', 'c'], 'mixed'], [t + 3501, ['d'], 'block time']], 'the third is within half an hour of the second; the fourth is not within half an hour of the third');
  assert.deepEqual(TZ.events([]), []);
  assert.deepEqual(TZ.events([item('a', 5, 'first seen'), item('b', 100, 'first seen')]).map((e) => e.basis), ['first seen']);
  assert.deepEqual(TZ.events([item('z', at(2026, 3, 6, 0, 0)), item('y', at(2026, 3, 5, 0, 0))]).map((e) => e.txids), [['y'], ['z']], 'oldest first');
});

test('fit: a few events fit many offsets and it says so instead of concluding', () => {
  const f = TZ.fit([item('x1', at(2026, 3, 2, 22, 10, 5), 'first seen'), item('x2', at(2026, 3, 5, 16, 40, 12)), item('x3', at(2026, 3, 9, 3, 20, 48), 'first seen')]);
  assert.deepEqual([f.n, f.enough, f.basis], [3, false, 'mixed']);
  assert.ok(Math.abs(f.spanDays - 6.215) < 0.01, 'six days, five hours and ten minutes');
  assert.deepEqual(f.fitting, [-9, -8, -7, -6, -5], 'the offsets at which all three are in waking hours (07:00 to 22:59): UTC+8 is not one, the first is then at 06:10 and the second at 00:40');
  const at8 = f.offsets.find((o) => o.offset === 8), at5 = f.offsets.find((o) => o.offset === -5);
  assert.deepEqual(at8.hours.map((h) => Math.floor(h)), [6, 0, 11]);
  assert.deepEqual([at8.waking, at8.night, at8.all], [1, 1, false], 'at UTC+8 the events are at 06:10, 00:40 and 11:20: one in waking hours, one at night');
  assert.deepEqual(at5.hours.map((h) => Math.floor(h)), [17, 11, 22]);
  assert.deepEqual(at5.days, ['Mon', 'Thu', 'Sun'], 'the local weekday follows the local date: the last is Sunday 22:20 at UTC-5');
  assert.deepEqual(TZ.fit([item('x', at(2026, 3, 2, 22, 10))]).offsets.find((o) => o.offset === 0).days, ['Mon']);
  assert.ok(f.text.startsWith('3 events over 6.2 days is too few to say anything about a daily rhythm') && f.text.includes('At least 8 events over 3 days'), f.text);
  assert.ok(f.text.includes('UTC-9 to UTC-5') && f.text.includes('5 of 27'), 'and says what still fits');
  assert.deepEqual([f.sleep, f.quiet.length > 12], [null, true], 'no reading of sleep from so little');
});

test('fit: with enough events it names the quietest stretch of the day and the offsets for which it is the small hours', () => {
  const items = []; for (let d = 0; d < 10; d++) { items.push(item('m' + d, at(2026, 11, 1 + d, 8 + d % 3, 5 * d))); items.push(item('e' + d, at(2026, 11, 1 + d, 18 + d % 3, 7 * d))); }
  const f = TZ.fit(items);
  assert.deepEqual([f.n, f.enough], [20, true]);
  assert.equal(f.quiet.start >= 20 && f.quiet.start < 21, true, 'nothing between about 20:00 and 08:00 UTC');
  assert.ok(f.quiet.length > 10 && f.quiet.length < 12);
  assert.deepEqual(f.sleep, [-1, 0, 1, 2, 3, 4], 'the middle of the quiet stretch (about 02:00 UTC) is in the small hours (01:00 to 06:59) at these offsets');
  assert.ok(f.text.startsWith('20 events over 9.') && f.text.includes('The quietest stretch of the day is 2') && f.text.includes('if that is when the person sleeps, the local time is UTC-1 to UTC+4.') && f.text.includes('A hypothesis'), f.text);
  const few = TZ.fit(items.slice(0, 6)); assert.equal(few.enough, false);
  const quick = []; for (let i = 0; i < 12; i++) quick.push(item('q' + i, at(2026, 11, 1, 9, 0) + i * 3 * 3600)); assert.equal(TZ.fit(quick).enough, false, 'twelve events in one day: not enough days');
});

test('fit: nothing, and one event', () => {
  assert.deepEqual([TZ.fit([]).n, TZ.fit([]).text], [0, 'No transaction with a time.']);
  const one = TZ.fit([item('a', at(2026, 3, 2, 12, 0))]);
  assert.deepEqual([one.n, one.quiet, one.enough, one.fitting.length], [1, null, false, 16], 'noon UTC is in waking hours from UTC-5 to UTC+10');
  assert.ok(one.text.startsWith('1 event over 0 days is too few') && one.text.includes('16 of 27') && one.text.includes('UTC-5 to UTC+10'), one.text);
});

test('quietest goes round midnight, and ranges, offsetText and hourText say it in words', () => {
  const q = TZ.quietest([{ time: at(2026, 11, 1, 22, 0) }, { time: at(2026, 11, 2, 23, 0) }, { time: at(2026, 11, 3, 3, 0) }]);
  assert.deepEqual([q.start, q.length, q.mid], [3, 19, 12.5], 'from 03:00 to 22:00: the longest stretch with no event');
  assert.equal(TZ.quietest([{ time: 5 }]), null);
  assert.equal(TZ.ranges([-8, -7, -6, -5, 8]), 'UTC-8 to UTC-5, UTC+8');
  assert.equal(TZ.ranges([3, 1, 2, 5]), 'UTC+1 to UTC+3, UTC+5');
  assert.equal(TZ.ranges([]), '');
  assert.deepEqual([TZ.offsetText(0), TZ.offsetText(-3), TZ.offsetText(14)], ['UTC+0', 'UTC-3', 'UTC+14']);
  assert.deepEqual([TZ.hourText(0), TZ.hourText(23.5), TZ.hourText(25.25), TZ.hourText(-1)], ['00:00', '23:30', '01:15', '23:00']);
});
