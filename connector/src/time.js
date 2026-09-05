/**
 * Deadline parsing and timezone math.
 *
 * Bid deadlines are published as wall-clock times in a local zone ("October 15,
 * 2026 2:00 PM ET"). Storing that as if it were UTC — or as the connector host's
 * local time — silently shifts the deadline by hours, which is how a bid gets
 * missed. Everything here converts an explicit wall time in an explicit IANA
 * zone to an absolute instant, and records what it had to assume.
 */

/** Common portal abbreviations -> IANA zones. */
const ZONE_ALIASES = {
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  EASTERN: "America/New_York",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  CENTRAL: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  MOUNTAIN: "America/Denver",
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  PACIFIC: "America/Los_Angeles",
  AKST: "America/Anchorage", AKDT: "America/Anchorage", ALASKA: "America/Anchorage",
  HST: "Pacific/Honolulu", HAST: "Pacific/Honolulu", HAWAII: "Pacific/Honolulu",
  AST: "America/Halifax", ADT: "America/Halifax", ATLANTIC: "America/Halifax",
  NST: "America/St_Johns", NDT: "America/St_Johns",
  UTC: "UTC", GMT: "UTC", Z: "UTC",
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Offset of `timeZone` from UTC at instant `ts`, in milliseconds.
 * Positive east of Greenwich (America/New_York in winter -> -18000000).
 */
export function zoneOffsetMs(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ts))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = Number(p.hour) % 24;
  const wall = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    hour, Number(p.minute), Number(p.second)
  );
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * Interpret a wall-clock time as occurring in `timeZone` and return the instant.
 *
 * The offset depends on the instant, and the instant depends on the offset, so
 * this iterates to a fixed point (two passes settle every real zone, including
 * DST boundaries; a third guards against pathological historical rules).
 */
export function wallTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - zoneOffsetMs(ts, timeZone);
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** Resolve a zone token ("ET", "Eastern Time", "America/Chicago") to an IANA id. */
export function resolveZone(token) {
  if (!token) return null;
  const raw = String(token).trim();
  if (raw.includes("/")) return isValidZone(raw) ? raw : null;
  const key = raw.toUpperCase().replace(/\b(TIME|STANDARD|DAYLIGHT|ZONE)\b/g, "").replace(/[^A-Z]/g, "");
  return ZONE_ALIASES[key] || null;
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a submission deadline from free text.
 *
 * Returns null when no date is present. Otherwise:
 *   { at, localText, timeZone, timeKnown, zoneAssumed }
 *
 * `timeKnown: false` means only a date was published. We anchor those to
 * 00:00 local rather than end-of-day: alerting early is recoverable, treating a
 * bid as still open after it closed is not.
 */
export function parseDeadline(text, { defaultTimeZone = "America/New_York" } = {}) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, " ").trim();
  if (!s) return null;

  // An ISO timestamp carrying its own offset is already unambiguous.
  const iso = s.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/);
  if (iso) {
    const at = new Date(iso[0].replace(" ", "T"));
    if (!Number.isNaN(at.getTime())) {
      return { at, localText: iso[0], timeZone: "UTC", timeKnown: true, zoneAssumed: false };
    }
  }

  const date = matchDate(s);
  if (!date) return null;

  const time = matchTime(s.slice(date.end));
  const zoneToken = matchZone(s.slice(date.end));
  const timeZone = resolveZone(zoneToken) || defaultTimeZone;

  const at = wallTimeToInstant(
    { ...date.value, hour: time?.hour ?? 0, minute: time?.minute ?? 0 },
    timeZone
  );
  if (Number.isNaN(at.getTime())) return null;

  return {
    at,
    localText: s.slice(date.start, date.end + (time?.end ?? 0)).trim() || s.slice(date.start, date.end),
    timeZone,
    timeKnown: Boolean(time),
    zoneAssumed: !resolveZone(zoneToken),
  };
}

function matchDate(s) {
  // "October 15, 2026" / "Oct 15 2026"
  const named = s.match(
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
  );
  if (named) {
    return {
      start: named.index,
      end: named.index + named[0].length,
      value: { year: +named[3], month: MONTHS[named[1].toLowerCase()], day: +named[2] },
    };
  }
  // "2026-10-15"
  const isoDate = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    return {
      start: isoDate.index,
      end: isoDate.index + isoDate[0].length,
      value: { year: +isoDate[1], month: +isoDate[2], day: +isoDate[3] },
    };
  }
  // "10/15/2026" — both portals publish US month-first.
  const slash = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slash) {
    let year = +slash[3];
    if (year < 100) year += 2000;
    const month = +slash[1];
    const day = +slash[2];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { start: slash.index, end: slash.index + slash[0].length, value: { year, month, day } };
    }
  }
  return null;
}

function matchTime(tail) {
  const m = tail.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  let hour = +m[1];
  const minute = +m[2];
  const mer = m[3]?.toLowerCase().replace(/\./g, "");
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, end: m.index + m[0].length };
}

function matchZone(tail) {
  const named = tail.match(/\b(Eastern|Central|Mountain|Pacific|Atlantic|Alaska|Hawaii)(?:\s+(?:Standard|Daylight))?\s+Time\b/i);
  if (named) return named[1];
  const abbr = tail.match(/\b(E[SD]?T|C[SD]?T|M[SD]?T|P[SD]?T|AK[SD]T|H?AST|A[SD]T|N[SD]T|UTC|GMT)\b/);
  if (abbr) return abbr[1];
  const iana = tail.match(/\b[A-Za-z]+\/[A-Za-z_]+\b/);
  if (iana) return iana[0];
  return null;
}

/** Whole days from `from` until `at`, rounded up. Negative once the date has passed. */
export function daysUntil(at, from = new Date()) {
  return Math.ceil((new Date(at).getTime() - from.getTime()) / 86400000);
}

/** Render an instant in a zone, for logs and CRM note fields. */
export function formatInZone(at, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, dateStyle: "medium", timeStyle: "short",
  }).format(new Date(at)) + ` (${timeZone})`;
}
