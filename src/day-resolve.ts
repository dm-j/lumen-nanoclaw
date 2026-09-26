/**
 * Resolve a human day token ("tomorrow", "mon", "27", "10-03", "2026-10-03") to a calendar date in a timezone.
 * Shared by the agent-facing daily-note / calendar / journal shims so they all mean the same thing by "monday".
 */

export type DateParts = { y: string; m: string; d: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The whole vocabulary of a word token. A token matches by UNIQUE PREFIX: "w" is Wednesday, "y" is yesterday, "tom" is
 * tomorrow, while "t" (tuesday/thursday/today/tomorrow), "s" and "to" are ambiguous and refused rather than guessed.
 */
const DAY_WORDS = ['today', 'tomorrow', 'yesterday', ...WEEKDAYS];
// Forms people write that are not a prefix of the word they mean.
const DAY_ALIASES: Record<string, string> = { weds: 'wednesday' };

const pad = (n: number): string => String(n).padStart(2, '0');

/** The one word `token` means, or null if it matches none. Case-insensitive; trims whitespace and a trailing period.
 * Throws if it could mean more than one word. */
export function matchDayWord(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  const w = DAY_ALIASES[t] ?? t;
  const hits = DAY_WORDS.filter((x) => x.startsWith(w));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${token}" is ambiguous: it could be ${hits.join(', ')}`);
  return null;
}

/** Wall-clock calendar date in `tz` (never the server's UTC date). */
export function todayParts(tz: string, now = new Date()): DateParts {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-');
  return { y, m, d };
}

/** `from` shifted by `offsetDays` (may be negative), via UTC arithmetic on the calendar date alone. */
export function shiftDate({ y, m, d }: DateParts, offsetDays: number): DateParts {
  const s = new Date(Date.UTC(+y, +m - 1, +d) + offsetDays * 86_400_000);
  return { y: String(s.getUTCFullYear()), m: pad(s.getUTCMonth() + 1), d: pad(s.getUTCDate()) };
}

/** A literal date, refusing ones that don't exist (02-30 must not silently become 03-02). */
function exact(y: number, m: number, d: number, token: string): DateParts {
  const parts = shiftDate({ y: String(y), m: pad(m), d: pad(d) }, 0);
  if (+parts.y !== y || +parts.m !== m || +parts.d !== d) throw new Error(`"${token}" is not a real date`);
  return parts;
}

/**
 * Resolves an optional day token to calendar-date parts:
 *  - undefined/empty → today
 *  - "YYYY-MM-DD" → that literal date; "MM-DD" → that date this year; "DD" → that day this month. No tz involved.
 *  - "today" / "yesterday" / "tomorrow", or any unique prefix of a day word (see matchDayWord)
 *  - a weekday → the nearest occurrence that is strictly after today, or strictly before today when `retrospective`
 *    (asking for "monday" on a Monday means 7 days away, never today). An ambiguous prefix throws.
 * Throws on anything else.
 */
export function resolveDay(day: string | undefined, tz: string, retrospective = false, now = new Date()): DateParts {
  const today = todayParts(tz, now);
  const token = day?.trim();
  if (!token) return today;

  let g: RegExpExecArray | null;
  if ((g = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token))) return exact(+g[1], +g[2], +g[3], token);
  if ((g = /^(\d{1,2})-(\d{1,2})$/.exec(token))) return exact(+today.y, +g[1], +g[2], token);
  if ((g = /^(\d{1,2})$/.exec(token))) return exact(+today.y, +today.m, +g[1], token);

  const word = matchDayWord(token);
  if (word === 'today') return today;
  if (word === 'yesterday') return shiftDate(today, -1);
  if (word === 'tomorrow') return shiftDate(today, 1);
  if (word) {
    const todayIdx = new Date(Date.UTC(+today.y, +today.m - 1, +today.d)).getUTCDay();
    const idx = WEEKDAYS.indexOf(word);
    const ahead = (idx - todayIdx + 7) % 7 || 7;
    const back = (todayIdx - idx + 7) % 7 || 7;
    return shiftDate(today, retrospective ? -back : ahead);
  }

  throw new Error(
    `unrecognized day "${day}" — expected "today", "yesterday", "tomorrow", a weekday, an unambiguous abbreviation of one, "DD", "MM-DD" or "YYYY-MM-DD"`,
  );
}
