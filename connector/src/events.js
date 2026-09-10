/**
 * Change detection and deadline alerting.
 *
 * The CRM does not want a nightly dump of every solicitation — it wants the
 * deltas that change what someone has to do today. Two of these matter most:
 * a deadline that moved (addenda routinely shift them) and a deadline that is
 * about to arrive.
 */

import { diff, hashOf, STATUS } from "./schema.js";
import { daysUntil, formatInZone } from "./time.js";

export const EVENT = Object.freeze({
  DISCOVERED: "solicitation.discovered",
  UPDATED: "solicitation.updated",
  DEADLINE_CHANGED: "solicitation.deadline_changed",
  ADDENDUM: "solicitation.addendum",
  CLOSING_SOON: "solicitation.closing_soon",
  CLOSED: "solicitation.closed",
});

/**
 * Merge a freshly ingested record over what we already had, and describe what
 * changed. Returns { record, events }.
 *
 * Deals only in what this sighting revealed; lead-time and closure alerts are a
 * separate sweep over every stored record, so they fire whether or not a bid
 * happened to be re-ingested this cycle.
 *
 * A later sighting must not blank out fields an earlier, richer one supplied —
 * a CSV export row is thinner than the notification email for the same bid — so
 * empty incoming values never overwrite populated stored ones.
 */
export function reconcile(previous, incoming, { store, now = new Date() } = {}) {
  const events = [];

  if (!previous) {
    const record = { ...incoming };
    events.push(makeEvent(EVENT.DISCOVERED, record, {
      reason: `New ${record.source} solicitation ingested via ${record.ingestedVia || "unknown"}`,
    }));
    return { record, events };
  }

  const record = merge(previous, incoming, now);
  const changes = diff(previous, record);
  if (!changes.length) return { record, events };

  const deadlineChange = changes.find((c) => c.field === "closesAt");
  if (deadlineChange) {
    // The old alert ladder described a deadline that no longer exists.
    store?.resetAlerts(record.id);
    events.push(makeEvent(EVENT.DEADLINE_CHANGED, record, {
      reason: describeDeadlineMove(deadlineChange, record),
      previousClosesAt: deadlineChange.before,
      shiftDays: shiftDays(deadlineChange),
    }));
  }

  const addendumChange = changes.find((c) => c.field === "addendaCount");
  if (addendumChange && Number(addendumChange.after) > Number(addendumChange.before ?? 0)) {
    events.push(makeEvent(EVENT.ADDENDUM, record, {
      reason: `Addendum issued (${addendumChange.after} total)`,
    }));
  }

  const other = changes.filter((c) => !["closesAt", "addendaCount"].includes(c.field));
  if (other.length) {
    events.push(makeEvent(EVENT.UPDATED, record, {
      reason: `Updated: ${other.map((c) => c.field).join(", ")}`,
      changes: other,
    }));
  }

  return { record, events };
}

/**
 * Lead-time and closure events. Run against every stored solicitation each
 * cycle, not just the ones seen this run — a bid ingested once by email still
 * needs its 7-day warning a fortnight later.
 */
export function closingEvents(record, { store, now = new Date(), leadDays = [] } = {}) {
  const events = [];
  if (!record.closesAt) return events;

  const remaining = daysUntil(record.closesAt, now);
  const isClosed = new Date(record.closesAt).getTime() <= now.getTime();

  if (isClosed) {
    if (record.status !== STATUS.CLOSED && store?.claimAlert(record.id, "closed")) {
      events.push(makeEvent(EVENT.CLOSED, { ...record, status: STATUS.CLOSED }, {
        reason: `Submission deadline passed (${formatInZone(record.closesAt, record.timeZone || "UTC")})`,
        daysUntilClose: remaining,
      }));
    }
    return events;
  }

  // Fire only the tightest threshold already crossed, so a connector that has
  // been offline for a week sends one "3 days left", not the whole ladder.
  const crossed = [...leadDays].sort((a, b) => a - b).filter((d) => remaining <= d);
  const threshold = crossed[0];
  if (threshold === undefined) return events;

  if (store?.claimAlert(record.id, `lead-${threshold}`)) {
    events.push(makeEvent(EVENT.CLOSING_SOON, record, {
      reason: `Closes in ${remaining} day${remaining === 1 ? "" : "s"} — ${formatInZone(record.closesAt, record.timeZone || "UTC")}`,
      threshold,
      daysUntilClose: remaining,
    }));
  }
  return events;
}

function merge(previous, incoming, now) {
  // A notification re-read after a newer one (mail drops are read in filename
  // order, and an addendum rarely sorts after the original) must not roll the
  // record back to a superseded deadline. Touch the timestamps and nothing else.
  if (isStale(previous, incoming)) {
    return {
      ...previous,
      lastSeenAt: now.toISOString(),
      daysUntilClose: previous.closesAt ? daysUntil(previous.closesAt, now) : null,
    };
  }

  const record = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty && !["addendaCount"].includes(key)) continue;
    record[key] = value;
  }
  // Addenda only accumulate; a thin source reporting 0 must not reset the count.
  record.addendaCount = Math.max(previous.addendaCount ?? 0, incoming.addendaCount ?? 0);
  record.firstSeenAt = previous.firstSeenAt ?? incoming.firstSeenAt;
  record.lastSeenAt = now.toISOString();
  record.daysUntilClose = record.closesAt ? daysUntil(record.closesAt, now) : null;
  record.contentHash = hashOf(record);
  return record;
}

function isStale(previous, incoming) {
  if (!previous?.observedAt || !incoming?.observedAt) return false;
  return new Date(incoming.observedAt) < new Date(previous.observedAt);
}

function describeDeadlineMove(change, record) {
  const zone = record.timeZone || "UTC";
  if (!change.before) return `Submission deadline set to ${formatInZone(change.after, zone)}`;
  const days = shiftDays(change);
  const direction = days > 0 ? "extended" : "moved earlier";
  return `Deadline ${direction} by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}: ` +
    `${formatInZone(change.before, zone)} to ${formatInZone(change.after, zone)}`;
}

function shiftDays(change) {
  if (!change.before || !change.after) return 0;
  return Math.round((new Date(change.after) - new Date(change.before)) / 86400000);
}

function makeEvent(type, record, detail = {}) {
  return {
    type,
    id: `${record.id}#${type}#${detail.threshold ?? record.contentHash ?? ""}`,
    occurredAt: new Date().toISOString(),
    solicitation: record,
    ...detail,
  };
}
