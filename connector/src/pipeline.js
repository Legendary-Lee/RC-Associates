/**
 * The run loop: ingest every source, reconcile against stored state, sweep for
 * approaching deadlines, and deliver the resulting events to every sink.
 */

import { makeResolver } from "./config.js";
import { createLogger } from "./log.js";
import { Store } from "./store.js";
import { normalize, STATUS } from "./schema.js";
import { reconcile, closingEvents, EVENT } from "./events.js";
import { getSource } from "./sources/index.js";
import { buildSink } from "./sinks/index.js";

export async function run(config, { dryRun = false, logLevel = "info", now = new Date() } = {}) {
  const log = createLogger({ level: logLevel });
  const resolve = makeResolver(config.baseDir);
  let lastFetchAt = 0;

  const ctx = {
    log,
    resolve,
    dryRun,
    defaultTimeZone: config.timezone,
    /** Serialize outbound portal requests so we never hammer an agency site. */
    async throttle(ms) {
      const wait = lastFetchAt + ms - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetchAt = Date.now();
    },
  };

  const store = await new Store(resolve(config.statePath)).load();
  const summary = {
    ingested: 0, discovered: 0, updated: 0, deadlineChanges: 0,
    closingSoon: 0, closed: 0, delivered: 0, sourceErrors: 0,
  };

  // 1. Ingest.
  const incoming = [];
  for (const source of config.sources) {
    if (source.enabled === false) {
      log.debug(`${source.id}: disabled, skipping`);
      continue;
    }
    try {
      const raw = await getSource(source.type).ingest(source, ctx);
      for (const item of raw) {
        try {
          incoming.push(normalize(item));
        } catch (err) {
          log.warn(`${source.id}: dropped an unusable record — ${err.message}`);
        }
      }
      log.info(`${source.id}: ingested ${raw.length} record(s)`);
    } catch (err) {
      // A broken source must not stop the others from reaching the CRM.
      summary.sourceErrors++;
      log.error(`${source.id}: ${err.message}`);
    }
  }
  summary.ingested = incoming.length;

  // 2. Reconcile, oldest sighting first, so that when one batch carries both an
  //    original notice and its addendum the later one lands last and wins.
  incoming.sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));

  const events = [];
  const touched = new Map();
  for (const item of incoming) {
    const previous = touched.get(item.id) ?? store.get(item.id);
    const { record, events: produced } = reconcile(previous, item, { store, now });
    touched.set(record.id, record);
    store.put(record);
    events.push(...produced);
  }

  // 3. Sweep every known solicitation for lead-time and closure alerts, so a bid
  //    seen once still raises its 7-day warning weeks later.
  for (const record of store.all()) {
    const produced = closingEvents(record, { store, now, leadDays: config.alertLeadDays });
    for (const event of produced) {
      if (event.type === EVENT.CLOSED) store.put({ ...record, status: STATUS.CLOSED });
      events.push(event);
    }
  }

  tally(events, summary);

  // 4. Deliver.
  const sinks = config.sinks
    .filter((s) => s.enabled !== false)
    .map((s) => buildSink(dryRun && s.type === "crm-http" ? { ...s, type: "console" } : s, ctx));

  if (!events.length) {
    log.info("no changes to deliver");
  } else {
    for (const sink of sinks) {
      try {
        log.info(`${sink.id}: sending ${events.length} event(s) to ${sink.describe()}`);
        const result = await sink.send(events, ctx);
        summary.delivered += result?.delivered ?? 0;
      } catch (err) {
        // Un-claim alerts so the next run re-raises them. Delivery is therefore
        // at-least-once: if a second sink fails after the first succeeded, the
        // first may see a repeat. A duplicate CRM task is cheap; a deadline
        // alert that silently never fires again is not.
        log.error(`${sink.id}: delivery failed — ${err.message}`);
        for (const event of events) {
          if (event.type === EVENT.CLOSING_SOON || event.type === EVENT.CLOSED) {
            store.resetAlerts(event.solicitation.id);
          }
        }
        throw err;
      } finally {
        if (!dryRun) await store.save();
      }
    }
  }

  const pruned = store.prune(config.retentionDays);
  if (pruned) log.debug(`pruned ${pruned} solicitation(s) closed over ${config.retentionDays} days ago`);
  if (!dryRun) await store.save();

  return { summary, events, store };
}

function tally(events, summary) {
  for (const event of events) {
    if (event.type === EVENT.DISCOVERED) summary.discovered++;
    else if (event.type === EVENT.UPDATED) summary.updated++;
    else if (event.type === EVENT.DEADLINE_CHANGED) summary.deadlineChanges++;
    else if (event.type === EVENT.CLOSING_SOON) summary.closingSoon++;
    else if (event.type === EVENT.CLOSED) summary.closed++;
  }
}
