#!/usr/bin/env node
/**
 * CLI for the BidNet / Euna deadline connector.
 *
 *   bid-connector run [--dry-run] [--config path] [--verbose]
 *   bid-connector doctor  [--config path]
 *   bid-connector inspect <file.eml|file.csv> --source bidnet|euna
 *   bid-connector list    [--config path] [--days N]
 */

import { loadConfig, makeResolver } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { run } from "../src/pipeline.js";
import { Store } from "../src/store.js";
import { getSource, sourceTypes } from "../src/sources/index.js";
import { buildSink } from "../src/sinks/index.js";
import { normalize } from "../src/schema.js";
import { formatInZone, daysUntil } from "../src/time.js";
import { basename, dirname } from "node:path";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const configPath = args.config ?? "connector.config.json";
const log = createLogger({ level: args.verbose ? "debug" : "info" });

try {
  await main();
} catch (err) {
  log.error(err.message);
  if (args.verbose) console.error(err.stack);
  process.exitCode = 1;
}

async function main() {
  switch (command) {
    case "run": return cmdRun();
    case "doctor": return cmdDoctor();
    case "inspect": return cmdInspect();
    case "list": return cmdList();
    case "help": case "--help": case "-h": return usage();
    default:
      throw new Error(`unknown command "${command}"\n\n${usageText()}`);
  }
}

async function cmdRun() {
  const config = await loadConfig(configPath);
  const { summary } = await run(config, {
    dryRun: Boolean(args["dry-run"]),
    logLevel: args.verbose ? "debug" : "info",
  });

  log.info(
    `done — ${summary.ingested} ingested, ${summary.discovered} new, ` +
    `${summary.deadlineChanges} deadline change(s), ${summary.closingSoon} closing soon, ` +
    `${summary.closed} closed, ${summary.delivered} delivered`
  );
  if (args["dry-run"]) log.info("dry run: nothing was written to state or the CRM");
  // A source that failed is a partial run; surface it to the scheduler.
  if (summary.sourceErrors) process.exitCode = 1;
}

/** Validate config and credentials without touching any portal or the CRM. */
async function cmdDoctor() {
  const config = await loadConfig(configPath);
  const resolve = makeResolver(config.baseDir);
  const ctx = { log, resolve, dryRun: true, defaultTimeZone: config.timezone, throttle: async () => {} };

  console.log(`config       ${configPath}`);
  console.log(`timezone     ${config.timezone}`);
  console.log(`state        ${resolve(config.statePath)}`);
  console.log(`lead times   ${config.alertLeadDays.join(", ")} day(s) before close\n`);

  console.log("sources");
  for (const source of config.sources) {
    const flag = source.enabled === false ? "off" : "on ";
    const target = source.inbox ?? source.path ?? (source.portals ?? source.urls ?? []).join(", ") ?? "";
    console.log(`  [${flag}] ${source.id.padEnd(18)} ${source.type}/${source.mode}  ${target}`);
    if (source.mode === "http" && source.cookieEnv && !process.env[source.cookieEnv]) {
      console.log(`         warning: ${source.cookieEnv} is not set`);
    }
  }

  console.log("\nsinks");
  for (const sink of config.sinks) {
    const flag = sink.enabled === false ? "off" : "on ";
    try {
      console.log(`  [${flag}] ${sink.id.padEnd(18)} ${sink.type}  ${buildSink(sink, ctx).describe()}`);
    } catch (err) {
      console.log(`  [${flag}] ${sink.id.padEnd(18)} ${sink.type}  ERROR: ${err.message}`);
      process.exitCode = 1;
    }
  }

  const store = await new Store(resolve(config.statePath)).load();
  console.log(`\ntracking ${store.all().length} solicitation(s)`);
}

/**
 * Show exactly what an adapter extracts from one real file.
 *
 * Notification templates change and vary by agency; this is how you find out
 * which label to add to `closeLabels` before anything reaches the CRM.
 */
async function cmdInspect() {
  const file = args._[1];
  if (!file) throw new Error("usage: bid-connector inspect <file.eml|file.csv> --source bidnet|euna");
  const type = args.source;
  if (!sourceTypes.includes(type)) {
    throw new Error(`--source must be one of ${sourceTypes.join(", ")}`);
  }

  const isCsv = /\.csv$/i.test(file);
  const source = isCsv
    ? { id: "inspect", type, mode: "csv", path: file }
    // `only` keeps the mail-drop adapter to this one message, and omitting
    // `archive` means inspecting never moves the file.
    : { id: "inspect", type, mode: "email", inbox: dirname(file) || ".", only: basename(file) };

  const ctx = {
    log,
    resolve: (p) => p,
    dryRun: true,
    defaultTimeZone: args.timezone ?? "America/New_York",
    throttle: async () => {},
  };

  const wanted = await getSource(type).ingest(source, ctx);

  if (!wanted.length) {
    console.log("nothing extracted — check the label lists for this source in your config");
    process.exitCode = 1;
    return;
  }
  for (const item of wanted) {
    const record = normalize(item);
    console.log(JSON.stringify(record, null, 2));
    if (!record.closesAt) console.log("\nwarning: no submission deadline parsed from this file");
    else if (record.closeTimeAssumed) console.log("\nwarning: date only, no time — anchored to local midnight");
    else if (record.timeZoneAssumed) console.log(`\nwarning: no timezone published — assumed ${record.timeZone}`);
  }
}

/** Print tracked solicitations by deadline — a quick check against the CRM. */
async function cmdList() {
  const config = await loadConfig(configPath);
  const store = await new Store(makeResolver(config.baseDir)(config.statePath)).load();
  const within = Number(args.days ?? 0);

  const rows = store.all()
    .filter((r) => r.closesAt)
    .filter((r) => !within || (daysUntil(r.closesAt) <= within && daysUntil(r.closesAt) >= 0))
    .sort((a, b) => new Date(a.closesAt) - new Date(b.closesAt));

  if (!rows.length) return console.log("no tracked solicitations with a parsed deadline");
  for (const r of rows) {
    const days = daysUntil(r.closesAt);
    const when = formatInZone(r.closesAt, r.timeZone || "UTC");
    console.log(`${String(days).padStart(4)}d  ${r.source.padEnd(7)} ${when}  ${r.title.slice(0, 60)}`);
  }
}

function usage() { console.log(usageText()); }

function usageText() {
  return `bid-connector — BidNet Direct + Euna deadline sync

  run [--dry-run] [--config <path>] [--verbose]
      Ingest all sources, detect changes, deliver events to the sinks.
      --dry-run prints to stdout and writes nothing.

  doctor [--config <path>]
      Validate configuration, paths and credentials. Touches nothing.

  inspect <file.eml|file.csv> --source bidnet|euna [--timezone <IANA>]
      Show what an adapter extracts from one real file, before wiring the CRM.

  list [--config <path>] [--days <n>]
      Print tracked solicitations ordered by deadline.`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const [flag, inline] = token.slice(2).split("=");
    if (inline !== undefined) out[flag] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[flag] = argv[++i];
    else out[flag] = true;
  }
  return out;
}
