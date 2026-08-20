/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Compact sortable local stamp for log lines: "YYYY-MM-DD HH:mm" in `timezone`.
 * (sv-SE is the one locale whose default rendering is this exact shape.)
 */
export function formatLocalStamp(date: Date, timezone: string): string {
  return date.toLocaleString('sv-SE', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Convert a UTC ISO timestamp to a local ISO-8601 string with an explicit
 * numeric offset (e.g. "2026-08-01T03:03:03-05:00") — unambiguous wall-clock
 * time (what the reader should think "now" is), still trivially sortable and
 * convertible back to UTC. Prefer this over formatLocalTime/formatLocalStamp
 * wherever the string is fed back to a model as *context* rather than shown
 * to a human in prose — a bare "Aug 1, 3:03 AM" reads fine to a person but
 * gives a model no offset to reason about relative-time or convert to UTC.
 */
export function formatLocalIsoOffset(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  const zone = resolveTimezone(timezone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  // "GMT+5:30" (India etc., non-hour-aligned) as well as "GMT-5" — parse both
  // hour and minute rather than assuming ":00".
  const match = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(parts.timeZoneName.replace('GMT', '') || '+0');
  const [, sign, offH, offM] = match ?? ['', '+', '0', '00'];
  const offsetStr = `${sign}${offH.padStart(2, '0')}:${(offM ?? '00').padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offsetStr}`;
}

/**
 * Interpret a naive ISO-like timestamp (no trailing `Z`, no offset) as wall-clock
 * time in `tz` and return the corresponding UTC Date. Strings that already carry
 * offset info (`Z` or `+-HH:MM`) are passed through to the Date constructor.
 */
export function parseZonedToUtc(input: string, tz: string): Date {
  const hasOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(input.trim());
  if (hasOffset) return new Date(input);

  const zone = resolveTimezone(tz);
  const asIfUtc = new Date(input + 'Z');
  if (Number.isNaN(asIfUtc.getTime())) return asIfUtc;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(asIfUtc)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const zonedAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = zonedAsUtcMs - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs);
}
