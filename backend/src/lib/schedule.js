/** When timed announcements play next. Mirrors speaker/gramsetu_speaker/schedule.py. */

const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }
  return formatters.get(timeZone);
}

function zoneParts(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

function offsetMs(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - offsetMs(wall, timeZone);
  const corrected = wall - offsetMs(utc, timeZone);
  if (corrected !== utc) utc = corrected;
  return utc;
}

function validZone(timeZone) {
  try {
    formatter(timeZone || "Asia/Kolkata");
    return timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

function isoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function runsOn(announcement, iso, weekday) {
  if (!announcement.startDate || iso < announcement.startDate) return false;
  if (announcement.repeat === "ONCE") return iso === announcement.startDate;
  if (announcement.endDate && iso > announcement.endDate) return false;
  if (announcement.repeat === "WEEKLY") return (announcement.daysOfWeek || []).includes(weekday);
  return true;
}

/** Next play time (ms since epoch) of one ONCE/DAILY/WEEKLY announcement after `now`, or null. */
export function nextOccurrence(announcement, now = Date.now(), horizonDays = 8) {
  if (announcement.repeat === "NOW") return null;
  const timeZone = validZone(announcement.timezone);
  const today = zoneParts(now, timeZone);
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!runsOn(announcement, isoDay(year, month, day), date.getUTCDay())) continue;
    const upcoming = (announcement.times || [])
      .map((clock) => {
        const [hour, minute] = clock.split(":").map(Number);
        return zonedToUtc(year, month, day, hour, minute, timeZone);
      })
      .filter((at) => at > now);
    if (upcoming.length) return Math.min(...upcoming);
  }
  return null;
}
