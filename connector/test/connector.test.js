import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { parseDeadline, wallTimeToInstant, daysUntil, resolveZone } from "../src/time.js";
import { parseEml, decodeWords } from "../src/parse/eml.js";
import { parseCsvRecords } from "../src/parse/csv.js";
import { htmlToText, labelledValue } from "../src/parse/html.js";
import { normalize, diff, STATUS } from "../src/schema.js";
import { reconcile, closingEvents, EVENT } from "../src/events.js";
import { Store } from "../src/store.js";
import { render } from "../src/sinks/crm-http.js";
import * as bidnet from "../src/sources/bidnet.js";
import * as euna from "../src/sources/euna.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const ctx = {
  log: { debug() {}, info() {}, warn() {}, error() {} },
  resolve: (p) => p,
  dryRun: true,
  defaultTimeZone: "America/New_York",
  throttle: async () => {},
};

const emailSource = (type, file) => ({ id: `t-${type}`, type, mode: "email", inbox: FIXTURES, only: file });

describe("deadline parsing", () => {
  test("converts a published wall time in a named zone to the right instant", () => {
    const d = parseDeadline("Closing Date: October 15, 2026 2:00 PM ET");
    // Mid-October is EDT (UTC-4), so 2:00 PM local is 18:00Z.
    assert.equal(d.at.toISOString(), "2026-10-15T18:00:00.000Z");
    assert.equal(d.timeZone, "America/New_York");
    assert.equal(d.timeKnown, true);
    assert.equal(d.zoneAssumed, false);
  });

  test("respects DST rather than a fixed offset", () => {
    const winter = parseDeadline("January 15, 2026 2:00 PM ET");
    const summer = parseDeadline("July 15, 2026 2:00 PM ET");
    assert.equal(winter.at.toISOString(), "2026-01-15T19:00:00.000Z"); // EST, UTC-5
    assert.equal(summer.at.toISOString(), "2026-07-15T18:00:00.000Z"); // EDT, UTC-4
  });

  test("reads US month-first slash dates with a zone", () => {
    const d = parseDeadline("Close Date | 11/12/2026 03:00 PM CT");
    assert.equal(d.at.toISOString(), "2026-11-12T21:00:00.000Z"); // CST, UTC-6
  });

  test("trusts an ISO timestamp that carries its own offset", () => {
    const d = parseDeadline("Due 2026-10-15T14:00:00-04:00");
    assert.equal(d.at.toISOString(), "2026-10-15T18:00:00.000Z");
  });

  test("flags an assumed timezone when none is published", () => {
    const d = parseDeadline("Bids due October 15, 2026 2:00 PM", { defaultTimeZone: "America/Chicago" });
    assert.equal(d.zoneAssumed, true);
    assert.equal(d.timeZone, "America/Chicago");
  });

  test("anchors a date with no time to local midnight and says so", () => {
    const d = parseDeadline("Submission deadline March 3, 2026");
    assert.equal(d.timeKnown, false);
    // 00:00 EST is 05:00Z — deliberately a floor, so alerts fire early.
    assert.equal(d.at.toISOString(), "2026-03-03T05:00:00.000Z");
  });

  test("returns null when there is no date at all", () => {
    assert.equal(parseDeadline("Please log in to view this opportunity."), null);
  });

  test("resolves zone spellings", () => {
    assert.equal(resolveZone("Pacific Time"), "America/Los_Angeles");
    assert.equal(resolveZone("EDT"), "America/New_York");
    assert.equal(resolveZone("America/Denver"), "America/Denver");
    assert.equal(resolveZone("Klingon"), null);
  });

  test("handles the spring-forward gap without drifting a day", () => {
    // 2:30 AM on 2026-03-08 does not exist in America/New_York.
    const at = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York");
    assert.equal(at.toISOString().slice(0, 10), "2026-03-08");
  });

  test("daysUntil rounds up and goes negative after the fact", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    assert.equal(daysUntil("2026-10-08T00:00:00Z", now), 7);
    assert.equal(daysUntil("2026-09-30T00:00:00Z", now), -1);
  });
});

describe("email parsing", () => {
  test("decodes quoted-printable multipart mail", () => {
    const email = parseEml(
      "Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: quoted-printable\n\nCity =E2=80=93 Purchasing"
    );
    assert.match(email.text, /City – Purchasing/);
  });

  test("decodes RFC 2047 encoded subjects", () => {
    assert.equal(decodeWords("=?UTF-8?Q?Caf=C3=A9_Renovation?="), "Café Renovation");
  });

  test("keeps table cells separable in flattened HTML", () => {
    const text = htmlToText("<tr><td>Close Date</td><td>Oct 15, 2026</td></tr>");
    assert.equal(labelledValue(text, ["Close Date"]), "Oct 15, 2026");
  });
});

describe("csv parsing", () => {
  test("handles quoted commas", () => {
    const rows = parseCsvRecords('Title,Due\n"Roof, Phase 2",10/15/2026\n');
    assert.equal(rows[0].title, "Roof, Phase 2");
  });
});

describe("bidnet adapter", () => {
  test("extracts the full solicitation from a notification email", async () => {
    const [raw] = await bidnet.ingest(emailSource("bidnet", "bidnet-notification.eml"), ctx);
    const record = normalize(raw);

    assert.equal(record.solicitationNumber, "RFP-2026-0142");
    assert.equal(record.title, "Roof Replacement, Municipal Complex");
    assert.equal(record.agency, "City of Springfield – Purchasing");
    assert.equal(record.closesAt, "2026-10-15T18:00:00.000Z");
    assert.equal(record.questionsDueAt, "2026-10-01T21:00:00.000Z");
    assert.equal(record.preBidAt, "2026-09-30T14:00:00.000Z");
    assert.equal(record.preBidMandatory, true);
    assert.equal(record.timeZone, "America/New_York");
    assert.equal(record.closeTimeAssumed, false);
    assert.equal(record.ingestedVia, "email");
    assert.match(record.url, /bidnetdirect\.com/);
    assert.equal(record.id, "bidnet:rfp-2026-0142");
  });

  test("reads a portal CSV export and normalizes status", async () => {
    const raws = await bidnet.ingest(
      { id: "t", type: "bidnet", mode: "csv", path: join(FIXTURES, "bidnet-export.csv") },
      ctx
    );
    const records = raws.map(normalize);
    assert.equal(records.length, 2);
    assert.equal(records[0].status, STATUS.OPEN);
    assert.equal(records[1].status, STATUS.CLOSED);
    assert.deepEqual(records[0].categories, ["Roofing", "General Construction"]);
  });

  test("carries the notification's own date as the observation time", async () => {
    const [raw] = await bidnet.ingest(emailSource("bidnet", "bidnet-notification.eml"), ctx);
    assert.equal(normalize(raw).observedAt, "2026-09-21T12:03:11.000Z");
  });

  test("the same bid from email and CSV resolves to one id", async () => {
    const [fromEmail] = await bidnet.ingest(emailSource("bidnet", "bidnet-notification.eml"), ctx);
    const fromCsv = await bidnet.ingest(
      { id: "t", type: "bidnet", mode: "csv", path: join(FIXTURES, "bidnet-export.csv") }, ctx
    );
    assert.equal(normalize(fromEmail).id, normalize(fromCsv[0]).id);
  });
});

describe("euna adapter", () => {
  test("extracts an opportunity and scopes the id to the agency portal", async () => {
    const [raw] = await euna.ingest(emailSource("euna", "euna-notification.eml"), ctx);
    const record = normalize(raw);

    assert.equal(record.title, "Fire Station No. 4 Renovation");
    assert.equal(record.agency, "County of Example");
    assert.equal(record.portal, "countyofexample.bonfirehub.com");
    assert.equal(record.closesAt, "2026-11-12T21:00:00.000Z");
    // Two agencies can both issue "2026-CN-018"; the portal disambiguates.
    assert.equal(record.id, "euna:countyofexample-bonfirehub-com-2026-cn-018");
  });

  test("parses an opportunity listing page", () => {
    const html = `<table><tr>
      <td>Fire Station No. 4 Renovation</td>
      <td>Close Date: Nov 12, 2026 3:00 PM CT</td>
      <td><a href="/portal/?tab=openOpportunities&opportunityId=99120">View</a></td>
    </tr></table>`;
    const [record] = euna.parseOpportunityList(html, "countyofexample.bonfirehub.com", undefined, ctx);
    assert.equal(record.sourceRef, "countyofexample.bonfirehub.com/99120");
    assert.equal(record.closesAt.toISOString(), "2026-11-12T21:00:00.000Z");
    assert.match(record.url, /^https:\/\/countyofexample\.bonfirehub\.com\/portal/);
  });
});

describe("change detection", () => {
  const base = () => normalize({
    source: "euna", sourceRef: "p/1", title: "Fire Station", agency: "County",
    closesAt: "2026-11-12T21:00:00.000Z", timeZone: "America/Chicago", status: "open",
  });

  test("a first sighting is a discovery", () => {
    const { events } = reconcile(null, base(), {});
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EVENT.DISCOVERED);
  });

  test("re-ingesting an unchanged bid produces nothing", () => {
    const { events } = reconcile(base(), base(), {});
    assert.deepEqual(events, []);
  });

  test("an extended deadline is reported with its direction and size", () => {
    const later = normalize({ ...base(), closesAt: "2026-11-26T21:00:00.000Z" });
    const { events, record } = reconcile(base(), later, {});
    const moved = events.find((e) => e.type === EVENT.DEADLINE_CHANGED);

    assert.ok(moved, "expected a deadline_changed event");
    assert.equal(moved.shiftDays, 14);
    assert.match(moved.reason, /extended by 14 days/);
    assert.equal(record.closesAt, "2026-11-26T21:00:00.000Z");
  });

  test("a thin later sighting does not erase richer stored fields", () => {
    const previous = base();
    const thin = normalize({ source: "euna", sourceRef: "p/1", title: "Fire Station", agency: "" });
    const { record } = reconcile(previous, thin, {});
    assert.equal(record.agency, "County");
    assert.equal(record.closesAt, "2026-11-12T21:00:00.000Z");
  });

  test("addenda accumulate rather than reset", () => {
    const previous = normalize({ ...base(), addendaCount: 2 });
    const { record, events } = reconcile(previous, normalize({ ...base(), addendaCount: 0 }), {});
    assert.equal(record.addendaCount, 2);
    assert.equal(events.filter((e) => e.type === EVENT.ADDENDUM).length, 0);
  });

  test("a stale sighting cannot roll back a newer deadline", () => {
    // Mail drops are read in filename order, so "euna-addendum.eml" is parsed
    // before "euna-notification.eml" even though it superseded it.
    const original = normalize({ ...base(), observedAt: "2026-09-22T16:41:00Z" });
    const addendum = normalize({
      ...base(), closesAt: "2026-11-26T21:00:00.000Z", observedAt: "2026-10-09T14:15:00Z",
    });

    const afterAddendum = reconcile(original, addendum, {}).record;
    assert.equal(afterAddendum.closesAt, "2026-11-26T21:00:00.000Z");

    const replay = reconcile(afterAddendum, original, {});
    assert.equal(replay.record.closesAt, "2026-11-26T21:00:00.000Z", "the superseded date must not return");
    assert.deepEqual(replay.events, [], "re-reading old mail is not news");
  });

  test("diff only reports tracked fields", () => {
    const a = base();
    const b = { ...a, lastSeenAt: new Date().toISOString() };
    assert.deepEqual(diff(a, b), []);
  });
});

describe("deadline alerts", () => {
  let store;
  const record = normalize({
    source: "bidnet", sourceRef: "X-1", title: "Roof",
    closesAt: "2026-10-15T18:00:00.000Z", timeZone: "America/New_York", status: "open",
  });

  test("fires once per threshold", async () => {
    store = new Store(join(tmpdir(), "unused.json"));
    const now = new Date("2026-10-09T12:00:00Z"); // 7 days out
    const first = closingEvents(record, { store, now, leadDays: [21, 14, 7, 3, 1] });
    assert.equal(first.length, 1);
    assert.equal(first[0].type, EVENT.CLOSING_SOON);
    assert.equal(first[0].threshold, 7);

    const again = closingEvents(record, { store, now, leadDays: [21, 14, 7, 3, 1] });
    assert.deepEqual(again, [], "an already-claimed threshold must not repeat");
  });

  test("a long outage sends only the tightest threshold, not the whole ladder", () => {
    const fresh = new Store(join(tmpdir(), "unused.json"));
    const now = new Date("2026-10-14T18:00:00Z"); // exactly 1 day out; 21/14/7/3 all crossed too
    const events = closingEvents(record, { store: fresh, now, leadDays: [21, 14, 7, 3, 1] });
    assert.equal(events.length, 1);
    assert.equal(events[0].threshold, 1);
  });

  test("a moved deadline re-arms the alerts already fired", () => {
    const fresh = new Store(join(tmpdir(), "unused.json"));
    const now = new Date("2026-10-09T12:00:00Z");
    assert.equal(closingEvents(record, { store: fresh, now, leadDays: [7] }).length, 1);

    const moved = normalize({ ...record, closesAt: "2026-11-15T18:00:00.000Z" });
    reconcile(record, moved, { store: fresh });

    const later = new Date("2026-11-09T12:00:00Z"); // 7 days from the new date
    const events = closingEvents(moved, { store: fresh, now: later, leadDays: [7] });
    assert.equal(events.length, 1, "the new deadline deserves its own 7-day warning");
  });

  test("reports a passed deadline exactly once", () => {
    const fresh = new Store(join(tmpdir(), "unused.json"));
    const now = new Date("2026-10-16T00:00:00Z");
    const events = closingEvents(record, { store: fresh, now, leadDays: [7] });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EVENT.CLOSED);
    assert.equal(events[0].solicitation.status, STATUS.CLOSED);
    assert.deepEqual(closingEvents(record, { store: fresh, now, leadDays: [7] }), []);
  });

  test("a bid with no parsed deadline raises nothing", () => {
    const undated = normalize({ source: "bidnet", sourceRef: "X-2", title: "No date" });
    assert.deepEqual(closingEvents(undated, { store: new Store("x"), leadDays: [7] }), []);
  });
});

describe("crm mapping", () => {
  const event = {
    type: EVENT.DEADLINE_CHANGED,
    occurredAt: "2026-10-09T14:00:00.000Z",
    reason: "Deadline extended by 14 days",
    solicitation: normalize({
      source: "euna", sourceRef: "p/1", title: "Fire Station", agency: "County",
      closesAt: "2026-11-26T21:00:00.000Z", closesAtLocal: "11/26/2026 03:00 PM",
      timeZone: "America/Chicago",
    }),
  };

  test("maps dot paths onto the CRM's own field names", () => {
    const payload = render(event, {
      map: { crm_name: "solicitation.title", crm_due: "solicitation.closesAt", crm_note: "reason" },
    });
    assert.deepEqual(payload, {
      crm_name: "Fire Station",
      crm_due: "2026-11-26T21:00:00.000Z",
      crm_note: "Deadline extended by 14 days",
    });
  });

  test("supports templates and constants", () => {
    const payload = render(event, {
      constants: { pipeline: "Public Bids" },
      map: { display: "{solicitation.closesAtLocal} {solicitation.timeZone}" },
    });
    assert.equal(payload.pipeline, "Public Bids");
    assert.equal(payload.display, "11/26/2026 03:00 PM America/Chicago");
  });

  test("omits fields the event does not carry", () => {
    const payload = render(event, { map: { nope: "solicitation.doesNotExist" } });
    assert.equal("nope" in payload, false);
  });
});

describe("store", () => {
  test("survives a round trip and prunes long-closed bids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bidconn-"));
    try {
      const path = join(dir, "state.json");
      const store = await new Store(path).load();
      store.put(normalize({ source: "bidnet", sourceRef: "A", title: "Recent", closesAt: new Date().toISOString() }));
      store.put(normalize({ source: "bidnet", sourceRef: "B", title: "Ancient", closesAt: "2020-01-01T00:00:00Z" }));
      await store.save();

      const reloaded = await new Store(path).load();
      assert.equal(reloaded.all().length, 2);
      assert.equal(reloaded.prune(120), 1);
      assert.equal(reloaded.all().length, 1);
      assert.equal(reloaded.all()[0].title, "Recent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing state file is a clean first run, not an error", async () => {
    const store = await new Store(join(tmpdir(), "definitely-absent", "state.json")).load();
    assert.deepEqual(store.all(), []);
  });
});
