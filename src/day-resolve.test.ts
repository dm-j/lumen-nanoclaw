import { describe, it, expect } from 'vitest';

import { matchDayWord, resolveDay } from './day-resolve.js';

const tz = 'America/Chicago';
// Sat 2026-09-26 22:00 in Chicago, which is already Sunday the 27th in UTC.
const now = new Date('2026-09-27T03:00:00Z');
const r = (day?: string, retro = false) => {
  const { y, m, d } = resolveDay(day, tz, retro, now);
  return `${y}-${m}-${d}`;
};

describe('matchDayWord', () => {
  it('matches unique prefixes case-insensitively and refuses ambiguous ones', () => {
    expect(matchDayWord('w')).toBe('wednesday');
    expect(matchDayWord(' Tues. ')).toBe('tuesday');
    expect(matchDayWord('weds')).toBe('wednesday');
    expect(() => matchDayWord('t')).toThrow(/ambiguous/);
    expect(matchDayWord('thursdayx')).toBeNull();
  });
});

describe('resolveDay', () => {
  it('uses the tz date, not the UTC date', () => {
    expect(r()).toBe('2026-09-26');
    expect(r('tomorrow')).toBe('2026-09-27');
    expect(r('yesterday')).toBe('2026-09-25');
  });

  it('weekday looks ahead by default and never lands on today', () => {
    expect(r('mon')).toBe('2026-09-28');
    expect(r('saturday')).toBe('2026-10-03');
    expect(r('fri')).toBe('2026-10-02');
  });

  it('weekday looks back when retrospective and never lands on today', () => {
    expect(r('mon', true)).toBe('2026-09-21');
    expect(r('saturday', true)).toBe('2026-09-19');
    expect(r('fri', true)).toBe('2026-09-25');
  });

  it('retrospective does not change non-weekday tokens', () => {
    expect(r('tomorrow', true)).toBe('2026-09-27');
    expect(r('10-03', true)).toBe('2026-10-03');
  });

  it('accepts DD, MM-DD and YYYY-MM-DD', () => {
    expect(r('5')).toBe('2026-09-05');
    expect(r('10-03')).toBe('2026-10-03');
    expect(r('2025-12-31')).toBe('2025-12-31');
  });

  it('refuses impossible dates and unknown tokens', () => {
    expect(() => r('02-30')).toThrow(/not a real date/);
    expect(() => r('31')).toThrow(/not a real date/); // September has 30
    expect(() => r('someday')).toThrow(/unrecognized day/);
  });
});
