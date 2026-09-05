import * as crmHttp from "./crm-http.js";
import * as jsonl from "./jsonl.js";
import * as consoleSink from "./console.js";

const REGISTRY = new Map([crmHttp, jsonl, consoleSink].map((m) => [m.type, m]));

export function buildSink(config, ctx) {
  const module = REGISTRY.get(config.type);
  if (!module) {
    throw new Error(`unknown sink type "${config.type}" (available: ${[...REGISTRY.keys()].join(", ")})`);
  }
  return module.create(config, ctx);
}
