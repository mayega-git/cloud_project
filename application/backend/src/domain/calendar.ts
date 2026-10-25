import {Temporal} from '@js-temporal/polyfill';

export function nextLocalMidnight(timeZone: string, now: Date): Date {
  const zoned = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone);
  return new Date(zoned.add({days: 1}).startOfDay().epochMilliseconds);
}

export function assertTimeZone(timeZone: string): void {
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
}
