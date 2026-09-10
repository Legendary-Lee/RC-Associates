/**
 * Append events to a JSON Lines file.
 *
 * Useful as a durable audit trail alongside the CRM sink, and as the target
 * when someone wants to load deadlines with their own importer.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const type = "jsonl";

export function create(config, ctx) {
  const path = ctx.resolve(config.path ?? "./events.jsonl");
  return {
    id: config.id,
    type,
    describe: () => path,
    async send(events) {
      if (!events.length) return { delivered: 0 };
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      return { delivered: events.length };
    },
  };
}
