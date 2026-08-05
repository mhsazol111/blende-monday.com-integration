/**
 * Splitting a monday date column into display parts.
 *
 * A monday Date column holds an optional time of day, and its hydrated `text`
 * comes back as `"2026-08-19 11:15"` (or `"2026-08-19"` when no time is set).
 * That single string is wrong in a sentence that wants one or the other —
 * "Date: 2026-08-19 11:15 / Time: 2026-08-19 11:15" — so templates get
 * `{{columnDate.<id>}}` and `{{columnTime.<id>}}` alongside the raw
 * `{{column.<id>}}`.
 *
 * The parts are derived from `text`, never from the column's raw `value`: the
 * value stores UTC, while `text` is already rendered in the monday account's
 * timezone, which is the clock the practice and the patient both read.
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

  const h = Number(hour);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { date, time: `${hour12}:${minute} ${suffix}` };
}
