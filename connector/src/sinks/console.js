/** Human-readable sink — the default for --dry-run. */

import { formatInZone } from "../time.js";

export const type = "console";

export function create(config) {
  return {
    id: config.id,
    type,
    describe: () => "stdout",
    async send(events) {
      for (const event of events) {
        const s = event.solicitation;
        const when = s.closesAt ? formatInZone(s.closesAt, s.timeZone || "UTC") : "no deadline parsed";
        const caveat = s.closeTimeAssumed ? " [time assumed]" : s.timeZoneAssumed ? " [zone assumed]" : "";
        console.log(`  ${event.type}\n    ${s.title}\n    ${s.agency || "unknown agency"} · ${s.source}` +
          `\n    closes ${when}${caveat}\n    ${event.reason ?? ""}${s.url ? `\n    ${s.url}` : ""}\n`);
      }
      return { delivered: events.length };
    },
  };
}
