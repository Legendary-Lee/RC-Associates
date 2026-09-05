/**
 * Shared ingestion plumbing for the portal adapters.
 *
 * The two portals differ only in their labels, link shapes and sender domains,
 * so the mechanics of reading a mail drop, walking a CSV export or fetching an
 * authenticated page live here once.
 */

import { readdir, readFile, rename, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseEml } from "../parse/eml.js";
import { htmlToText, extractLinks, labelledValue } from "../parse/html.js";
import { parseCsvRecords, pick } from "../parse/csv.js";
import { parseDeadline } from "../time.js";

/**
 * Read every .eml in a directory and hand each to `extract`.
 *
 * Files are moved to `archive` only after a successful pass, so a parser bug
 * never destroys the original message — re-run once the labels are fixed.
 */
export async function ingestMailDrop(config, ctx, extract) {
  const dir = ctx.resolve(config.inbox);
  const records = [];
  let files;
  try {
    files = (await readdir(dir)).filter((f) => /\.eml$/i.test(f)).sort();
    // `only` narrows the drop to a single message, for `inspect`.
    if (config.only) files = files.filter((f) => f === config.only);
  } catch (err) {
    if (err.code === "ENOENT") {
      ctx.log.warn(`${config.id}: mail drop ${dir} does not exist yet — skipping`);
      return records;
    }
    throw err;
  }

  for (const file of files) {
    const path = join(dir, file);
    try {
      const email = parseEml(await readFile(path));
      const body = email.html ? htmlToText(email.html) : email.text;
      const found = extract({ email, body, links: extractLinks(email.html || ""), ctx, config });
      for (const record of found) {
        records.push({
          ...record,
          ingestedVia: "email",
          sourceMessageId: email.messageId || basename(file),
          observedAt: email.date ?? undefined,
        });
      }
      if (!found.length) ctx.log.warn(`${config.id}: no solicitation found in ${file}`);
      if (config.archive && !ctx.dryRun) {
        const archiveDir = ctx.resolve(config.archive);
        await mkdir(archiveDir, { recursive: true });
        await rename(path, join(archiveDir, file));
      }
    } catch (err) {
      // One malformed message must not stop the run; the rest still reach the CRM.
      ctx.log.error(`${config.id}: failed to parse ${file}: ${err.message}`);
    }
  }
  return records;
}

/** Read a portal CSV/report export and hand each row to `extract`. */
export async function ingestCsvExport(config, ctx, extract) {
  const path = ctx.resolve(config.path);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      ctx.log.warn(`${config.id}: export ${path} not found — skipping`);
      return [];
    }
    throw err;
  }
  return parseCsvRecords(text)
    .map((row) => extract({ row, ctx, config }))
    .filter(Boolean)
    .map((record) => ({ ...record, ingestedVia: "csv" }));
}

/**
 * Fetch an authenticated portal page.
 *
 * Off by default. Neither portal publishes a supplier API, so this replays a
 * session cookie you supply from your own logged-in browser — check your
 * account's terms before enabling it, and keep the rate limit conservative.
 */
export async function fetchPortal(url, config, ctx) {
  const cookie = config.cookieEnv ? process.env[config.cookieEnv] : null;
  if (!cookie) throw new Error(`${config.id}: env var ${config.cookieEnv} is not set`);

  await ctx.throttle(config.rateLimitMs ?? 4000);
  const response = await fetch(url, {
    headers: {
      cookie,
      "user-agent": config.userAgent ?? "RC-Associates-BidConnector/1.0",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(config.timeoutMs ?? 30000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${config.id}: ${url} responded ${response.status}`);

  const html = await response.text();
  // A portal that bounced us to a login form returns 200 with a login page.
  if (/name=["']?(password|j_password)/i.test(html)) {
    throw new Error(`${config.id}: session cookie is expired or invalid (got a login page)`);
  }
  return html;
}

/**
 * Pull a deadline out of a body using the adapter's label list, falling back to
 * a scan of any line that names a closing date.
 */
export function findDeadline(body, labels, ctx) {
  const labelled = labelledValue(body, labels);
  const direct = parseDeadline(labelled, { defaultTimeZone: ctx.defaultTimeZone });
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!labels.some((l) => new RegExp(escapeRe(l), "i").test(line))) continue;
    const parsed = parseDeadline(line, { defaultTimeZone: ctx.defaultTimeZone });
    if (parsed) return parsed;
  }
  return null;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spread a parsed deadline into the normalize() field names. */
export function deadlineFields(deadline) {
  if (!deadline) return { closesAt: null };
  return {
    closesAt: deadline.at,
    closesAtLocal: deadline.localText,
    timeZone: deadline.timeZone,
    closeTimeAssumed: !deadline.timeKnown,
    timeZoneAssumed: deadline.zoneAssumed,
  };
}

export { labelledValue, pick, parseDeadline };
