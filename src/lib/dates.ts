/**
 * #30(b) — build "day N of month M" without JS Date's silent rollover.
 * new Date(2026, 8, 31) is Oct 1, so a due-day-31 card showed next month's
 * date. Month overflow (12 → next January) is preserved; only the DAY clamps.
 */
export function clampedMonthlyDate(year: number, month: number, day: number): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth));
}

/** Plaid pulls run 07:00, 13:00, 19:00 America/Chicago — functions-sync/main.py:168, `0 7,13,19 * * *`. */
const SYNC_HOURS_CHICAGO = [7, 13, 19] as const;

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** `instant`'s wall-clock reading in America/Chicago, via the platform's own tz database. */
function chicagoWallClock(instant: Date): WallClock {
  const parts: Record<string, string> = {};
  for (const p of CHICAGO_FMT.formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}
const CHICAGO_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * A Chicago wall-clock reading -> the true UTC instant it names.
 *
 * CST/CDT is UTC-6/UTC-5, so the offset to undo depends on WHICH SIDE of a DST
 * transition the reading falls on — not on the day `lastScheduledSyncSlot` is being
 * asked about "as of". A naive `instant + fixedOffset` gets yesterday's slot wrong by
 * an hour on the two days a year the offset actually changes (see the DST tests).
 *
 * Standard two-pass zoned-to-UTC conversion: guess the offset from a UTC-literal
 * reading of the wall clock, then re-check it against the resulting instant, because
 * that guess can itself land on the wrong side of the transition.
 */
function chicagoWallClockToUtc(w: WallClock): Date {
  const guessMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offsetMs = (at: number) => {
    const local = chicagoWallClock(new Date(at));
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - at;
  };
  const utcMs = guessMs - offsetMs(guessMs);
  const offset2 = offsetMs(utcMs);
  return new Date(guessMs - offset2);
}

/**
 * The most recent Plaid sync slot at or before `instant` (INV-1: the producer
 * `driftStatus`'s staleness comparison needs and never had).
 *
 * MUST be derived from the schedule, never a fixed hour count: the gap between the
 * 19:00 run and the next 07:00 run is itself 12 hours, so a fixed 6h/12h "stale"
 * window would flag every account stale every single morning before the first sync
 * of the day ran — the exact false positive this function exists to prevent.
 */
export function lastScheduledSyncSlot(instant: Date): Date {
  const local = chicagoWallClock(instant);
  const minuteOfDay = local.hour * 60 + local.minute;
  const todaysHour = [...SYNC_HOURS_CHICAGO].reverse().find((h) => h * 60 <= minuteOfDay);
  if (todaysHour !== undefined) {
    return chicagoWallClockToUtc({ ...local, hour: todaysHour, minute: 0, second: 0 });
  }
  // Before today's first slot (07:00): the answer is yesterday's 19:00. Date.UTC
  // normalizes day 0 into the last day of the PREVIOUS month on its own, so this
  // stays correct across a month (and year) boundary without special-casing it.
  const yesterdayMs = Date.UTC(local.year, local.month - 1, local.day - 1);
  const yesterday = new Date(yesterdayMs);
  return chicagoWallClockToUtc({
    year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth() + 1, day: yesterday.getUTCDate(),
    hour: 19, minute: 0, second: 0,
  });
}
