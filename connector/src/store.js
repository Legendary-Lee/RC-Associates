/**
 * Durable state: what we have already seen, and which alerts already fired.
 *
 * A JSON file is the right size of tool here — a supplier tracks hundreds of
 * solicitations, not millions — and it keeps the connector dependency-free and
 * trivially inspectable when a deadline looks wrong.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY = { version: 1, updatedAt: null, solicitations: {}, alerts: {} };

export class Store {
  #path;
  #data;

  constructor(path) {
    this.#path = path;
    this.#data = structuredClone(EMPTY);
  }

  async load() {
    try {
      this.#data = { ...structuredClone(EMPTY), ...JSON.parse(await readFile(this.#path, "utf8")) };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // First run: start clean rather than failing.
    }
    return this;
  }

  /** Atomic write — a crash mid-save must not truncate the state file. */
  async save() {
    this.#data.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), "utf8");
    await rename(tmp, this.#path);
  }

  get(id) {
    return this.#data.solicitations[id] ?? null;
  }

  all() {
    return Object.values(this.#data.solicitations);
  }

  put(record) {
    this.#data.solicitations[record.id] = record;
  }

  /** Drop solicitations that closed longer than `retentionDays` ago. */
  prune(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 86400000;
    let removed = 0;
    for (const [id, record] of Object.entries(this.#data.solicitations)) {
      const closed = record.closesAt ? new Date(record.closesAt).getTime() : null;
      if (closed !== null && closed < cutoff) {
        delete this.#data.solicitations[id];
        delete this.#data.alerts[id];
        removed++;
      }
    }
    return removed;
  }

  /** True the first time a given lead-time alert is claimed for a bid. */
  claimAlert(id, key) {
    const fired = this.#data.alerts[id] ?? [];
    if (fired.includes(key)) return false;
    this.#data.alerts[id] = [...fired, key];
    return true;
  }

  /** Alert bookkeeping is keyed to a deadline; a moved deadline re-arms it. */
  resetAlerts(id) {
    delete this.#data.alerts[id];
  }
}
