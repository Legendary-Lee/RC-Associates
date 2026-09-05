/** Configuration loading, defaults and validation. */

import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { sourceTypes } from "./sources/index.js";

const DEFAULTS = {
  timezone: "America/New_York",
  statePath: "./.state/solicitations.json",
  // Lead times a construction bid team actually works to: three weeks out to
  // decide go/no-go, one week to assemble, three days and one day to finish.
  alertLeadDays: [21, 14, 7, 3, 1],
  retentionDays: 120,
  sources: [],
  sinks: [],
};

export async function loadConfig(path) {
  const file = resolve(process.cwd(), path);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `config not found at ${file} — copy connector.config.example.json to get started`,
        { cause: err }
      );
    }
    throw new Error(`config at ${file} is not valid JSON: ${err.message}`, { cause: err });
  }

  const config = { ...DEFAULTS, ...parsed, baseDir: dirname(file) };
  validate(config);
  return config;
}

function validate(config) {
  const problems = [];

  if (!isValidZone(config.timezone)) {
    problems.push(`timezone "${config.timezone}" is not a valid IANA zone (e.g. "America/New_York")`);
  }
  if (!Array.isArray(config.sources) || !config.sources.length) {
    problems.push("no sources configured");
  }
  if (!Array.isArray(config.sinks) || !config.sinks.length) {
    problems.push('no sinks configured — add at least one (type "crm-http", "jsonl" or "console")');
  }

  const ids = new Set();
  for (const [i, source] of (config.sources ?? []).entries()) {
    const label = source.id ?? `sources[${i}]`;
    if (!source.id) problems.push(`${label}: "id" is required`);
    else if (ids.has(source.id)) problems.push(`${label}: duplicate id`);
    ids.add(source.id);
    if (!sourceTypes.includes(source.type)) {
      problems.push(`${label}: type must be one of ${sourceTypes.join(", ")}`);
    }
    if (!["email", "csv", "http"].includes(source.mode)) {
      problems.push(`${label}: mode must be email, csv or http`);
    }
    if (source.mode === "email" && !source.inbox) problems.push(`${label}: email mode needs "inbox"`);
    if (source.mode === "csv" && !source.path) problems.push(`${label}: csv mode needs "path"`);
  }

  for (const [i, sink] of (config.sinks ?? []).entries()) {
    if (!sink.id) problems.push(`sinks[${i}]: "id" is required`);
    if (!sink.type) problems.push(`sinks[${i}]: "type" is required`);
  }

  if (problems.length) {
    throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a config-relative path against the config file's directory. */
export function makeResolver(baseDir) {
  return (p) => (!p ? p : isAbsolute(p) ? p : resolve(baseDir, p));
}
