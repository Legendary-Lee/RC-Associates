/**
 * The canonical Solicitation record.
 *
 * Every source adapter normalizes to this shape, so the CRM sees one vocabulary
 * regardless of which portal a bid came from and how it was ingested.
 */

import { createHash } from "node:crypto";
import { daysUntil } from "./time.js";

export const STATUS = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  AWARDED: "awarded",
  CANCELLED: "cancelled",
  UNKNOWN: "unknown",
});

/** Fields that, when changed, mean the opportunity itself materially moved. */
const TRACKED_FIELDS = [
  "title", "agency", "status", "closesAt", "questionsDueAt",
  "preBidAt", "url", "addendaCount", "solicitationNumber",
];

export function normalize(input) {
  const source = req(input.source, "source");
  const sourceRef = req(input.sourceRef, "sourceRef");

  const record = {
    id: `${source}:${slug(sourceRef)}`,
    source,
    sourceRef: String(sourceRef).trim(),
    solicitationNumber: str(input.solicitationNumber),
    title: str(input.title) || "(untitled solicitation)",
    agency: str(input.agency),
    portal: str(input.portal),
    url: str(input.url),
    status: normalizeStatus(input.status),

    closesAt: iso(input.closesAt),
    closesAtLocal: str(input.closesAtLocal),
    timeZone: str(input.timeZone),
    // True when the portal published a date but no time of day; the instant is
    // anchored to local midnight, so it is a floor, not the real cutoff.
    closeTimeAssumed: Boolean(input.closeTimeAssumed),
    // True when no timezone was published and the configured default was used.
    timeZoneAssumed: Boolean(input.timeZoneAssumed),

    questionsDueAt: iso(input.questionsDueAt),
    preBidAt: iso(input.preBidAt),
    preBidMandatory: input.preBidMandatory ?? null,

    categories: arr(input.categories),
    addendaCount: Number.isFinite(input.addendaCount) ? input.addendaCount : 0,
    buyerName: str(input.buyerName),
    buyerEmail: str(input.buyerEmail),

    ingestedVia: str(input.ingestedVia),
    // When the portal actually said this — the notification's own Date header,
    // or now for a live fetch. Decides which of two sightings is authoritative.
    observedAt: iso(input.observedAt) ?? new Date().toISOString(),
    sourceMessageId: str(input.sourceMessageId),
    firstSeenAt: iso(input.firstSeenAt) ?? new Date().toISOString(),
    lastSeenAt: iso(input.lastSeenAt) ?? new Date().toISOString(),
    raw: input.raw ?? {},
  };

  record.daysUntilClose = record.closesAt ? daysUntil(record.closesAt) : null;
  record.contentHash = hashOf(record);
  return record;
}

/** Hash over tracked fields only, so re-ingesting the same bid is a no-op. */
export function hashOf(record) {
  const material = TRACKED_FIELDS.map((f) => `${f}=${record[f] ?? ""}`).join(" ");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Field-level differences between two versions of the same solicitation. */
export function diff(previous, next) {
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    const before = previous?.[field] ?? null;
    const after = next?.[field] ?? null;
    if (String(before ?? "") !== String(after ?? "")) changes.push({ field, before, after });
  }
  return changes;
}

function normalizeStatus(value) {
  const v = String(value ?? "").toLowerCase();
  if (!v) return STATUS.UNKNOWN;
  if (/award/.test(v)) return STATUS.AWARDED;
  if (/cancel|withdraw/.test(v)) return STATUS.CANCELLED;
  if (/close|expired|past/.test(v)) return STATUS.CLOSED;
  if (/open|active|accepting|current/.test(v)) return STATUS.OPEN;
  return STATUS.UNKNOWN;
}

const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const slug = (v) => String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function req(value, name) {
  const v = str(value);
  if (!v) throw new TypeError(`normalize(): "${name}" is required`);
  return v;
}
