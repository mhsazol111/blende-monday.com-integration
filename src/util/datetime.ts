/**
 * Turning monday's date and hour columns into display parts.
 *
 * Templates get `{{columnDate.<id>}}` and `{{columnTime.<id>}}` alongside the raw
 * `{{column.<id>}}`, because one string is wrong in a sentence that wants one or
 * the other — "Date: 2026-08-19 11:15 / Time: 2026-08-19 11:15".
 *
 * Two column types feed those maps:
 *
 * - **Date** (`columnDateParts`) — hydrated `text` is `"2026-08-19 11:15"`, or
 *   just `"2026-08-19"` when no time is set. Parts come from `text`, never from
 *   the raw `value`: value stores UTC, while `text` is rendered in the monday
 *   account's timezone.
 * - **Hour** (`hourColumnTime`) — `{"hour":16,"minute":5}`, with **no timezone
 *   at all**: the time is stored exactly as it was typed. This is why the
 *   appointment times live here rather than on the Date column, where the value
 *   is an absolute instant whose displayed time depends on who is looking at it
 *   (and on which browser it was entered from). An hour column has no date half,
 *   so `{{columnDate.<hourId>}}` is empty — pair it with its Date column.
 */

export interface ColumnDateParts {
  /** e.g. "August 19, 2026" — empty when the text doesn't start with a date. */
  date: string;
  /** e.g. "11:15 AM" — empty when the cell carries no time of day. */
  time: string;
}

const EMPTY: ColumnDateParts = { date: '', time: '' };

/**
 * Leading `YYYY-MM-DD` with an optional `HH:mm`. Anchored at the start so a
 * Timeline column ("2026-08-19 - 2026-08-21") yields its start date, and any
 * other column type ("Done", "3") simply doesn't match.
 */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format the parsed pieces by hand — a Date object would re-apply a timezone. */
export function columnDateParts(text: string): ColumnDateParts {
  const m = DATE_TIME.exec((text ?? '').trim());
  if (!m) return EMPTY;

  const [, year, month, day, hour, minute] = m;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return EMPTY;

  const date = `${monthName} ${Number(day)}, ${year}`;
  if (hour === undefined) return { date, time: '' };

  return { date, time: clockTime(Number(hour), Number(minute)) };
}

/** 24-hour pieces → "4:05 PM". The one place the display format is decided. */
function clockTime(hour: number, minute: number): string {
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** `text` of an hour column: "04:05 PM", or "16:05" on a 24-hour account. */
const HOUR_TEXT = /^(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?[Mm])?/;

/**
 * The `{{columnTime.<id>}}` value for an hour column, as "4:05 PM".
 *
 * Read from `value` (`{"hour":16,"minute":5}`) in preference to `text`, since
 * that is unambiguous — `text` follows the account's 12/24-hour setting, so
 * changing that setting would otherwise change every rendered message.
 */
export function hourColumnTime(text: string, value?: string | null): string {
  if (value) {
    try {
      const v = JSON.parse(value) as { hour?: unknown; minute?: unknown };
      if (typeof v?.hour === 'number') return clockTime(v.hour, typeof v.minute === 'number' ? v.minute : 0);
    } catch {
      // Fall through to the text form rather than dropping the time.
    }
  }

  const m = HOUR_TEXT.exec((text ?? '').trim());
  if (!m) return '';
  const [, rawHour, minute, meridiem] = m;

  let hour = Number(rawHour);
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'p';
    hour = hour % 12; // 12 AM is hour 0, 12 PM is hour 12.
    if (pm) hour += 12;
  }
  if (hour > 23) return '';
  return clockTime(hour, Number(minute));
}
