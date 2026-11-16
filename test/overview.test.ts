import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countIn, peopleIn, spread, stepsOf, whenOn } from '../src/features/overview.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHICAGO = 'America/Chicago';

test('a period is cut into hours, days, weeks or months by its length, from the hour or midnight in the time zone', () => {
  const at = Date.parse('2026-06-15T17:20:00Z');
  const hours = stepsOf(at - 5 * HOUR, at, CHICAGO);
  assert.equal(hours.step, 'hour');
  assert.equal(new Date(hours.starts[0]).toISOString(), '2026-06-15T12:00:00.000Z', 'from the top of the hour');
  assert.equal(hours.starts.length, 6);
  const days = stepsOf(at - 10 * DAY, at, CHICAGO);
  assert.equal(days.step, 'day');
  assert.equal(new Date(days.starts[0]).toISOString(), '2026-06-05T05:00:00.000Z', 'midnight in Chicago');
  assert.equal(stepsOf(at - 100 * DAY, at, CHICAGO).step, 'week');
  const months = stepsOf(at - 500 * DAY, at, CHICAGO);
  assert.equal(months.step, 'month');
  assert.ok(months.ends.at(-1)! >= at && months.starts.at(-1)! < at, 'the last step holds now');
  // The day the clocks go back is 25 hours long, and the next starts at midnight all the same
  const autumn = stepsOf(Date.parse('2026-10-30T05:00:00Z'), Date.parse('2026-11-03T05:00:00Z'), CHICAGO);
  assert.deepEqual(autumn.starts.map((s, i) => (autumn.ends[i] - s) / HOUR), [24, 24, 25, 24]);
});

test('time is spread over the steps it covers, an amount in proportion, and moments and people are counted in theirs', () => {
  const steps = { step: 'hour' as const, starts: [0, HOUR, 2 * HOUR], ends: [HOUR, 2 * HOUR, 3 * HOUR] };
  assert.deepEqual(spread([{ start: HOUR / 2, end: 2 * HOUR }], steps), [HOUR / 2, HOUR, 0]);
  // An hour of voice in a two-hour session goes half in each hour
  assert.deepEqual(spread([{ start: 0, end: 2 * HOUR, weight: HOUR }], steps), [HOUR / 2, HOUR / 2, 0]);
  assert.deepEqual(countIn([10, HOUR + 1, HOUR + 2, 9 * HOUR], steps), [1, 2, 0], 'a moment after the period isn’t counted');
  assert.deepEqual(
    peopleIn(
      [
        { userId: 'a', start: 0, end: 2 * HOUR },
        { userId: 'a', start: HOUR, end: HOUR + 5 },
        { userId: 'b', start: 2 * HOUR + 1, end: 3 * HOUR },
      ],
      steps,
    ),
    [1, 1, 1],
    'someone in two things at once is one person',
  );
});

test('when people are on is how many were on at once at each weekday and hour, on average, in the time zone', () => {
  // Two weeks from Monday 1 June, midnight in Chicago
  const first = Date.parse('2026-06-01T05:00:00Z');
  const until = first + 14 * DAY;
  const nine = (week: number) => first + week * 7 * DAY + 21 * HOUR;
  const grid = whenOn(
    [
      // Ana both Monday evenings, 9 to 10 PM, playing and in voice at once
      { userId: 'ana', start: nine(0), end: nine(0) + HOUR },
      { userId: 'ana', start: nine(0) + 10 * 60_000, end: nine(0) + HOUR },
      { userId: 'ana', start: nine(1), end: nine(1) + HOUR },
      // Ben only the first Monday, for half the hour
      { userId: 'ben', start: nine(0), end: nine(0) + HOUR / 2 },
    ],
    first,
    until,
    CHICAGO,
  );
  assert.equal(grid.length, 7);
  assert.equal(grid[0][21], 1.25, 'Mondays at 9 PM: Ana both weeks, Ben half an hour of one');
  assert.equal(grid[0][20], 0);
  assert.equal(grid[6][23], 0, 'Sunday is the last row');
  // A stretch shorter than a day leaves the hours it doesn't include empty
  const short = whenOn([], first, first + 2 * HOUR, CHICAGO);
  assert.deepEqual([short[0][0], short[0][1], short[0][2]], [0, 0, null]);
});

test('when people are on follows the clocks going back', () => {
  // Sunday 1 November 2026: 1 AM happens twice in Chicago
  const first = Date.parse('2026-11-01T05:00:00Z');
  const grid = whenOn([{ userId: 'ana', start: Date.parse('2026-11-01T07:00:00Z'), end: Date.parse('2026-11-01T08:00:00Z') }], first, first + 25 * HOUR, CHICAGO);
  // 07:00 UTC is 1 AM CST, the second 1 AM: the hour happened twice, and she was on for one of them
  assert.equal(grid[6][1], 0.5);
  assert.equal(grid[6][2], 0);
});
