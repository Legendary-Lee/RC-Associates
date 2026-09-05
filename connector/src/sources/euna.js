/**
 * Euna (Bonfire) supplier portal adapter.
 *
 * Euna Procurement is multi-tenant: each buyer runs its own portal at
 * <agency>.bonfirehub.com, and a supplier registers per portal. There is no
 * documented supplier API, so the same three channels apply as for BidNet, with
 * one addition — most agency portals expose their open opportunities publicly,
 * which the http mode can read without any session at all.
 */

import {
  ingestMailDrop, ingestCsvExport, fetchPortal,
  findDeadline, deadlineFields, labelledValue, pick, parseDeadline,
} from "./common.js";
import { htmlToText, extractLinks } from "../parse/html.js";

export const type = "euna";

const DEFAULTS = {
  closeLabels: [
    "Close Date", "Closing Date", "Submission Deadline", "Submissions Due",
    "Due Date", "Deadline", "Closes On", "Bid Closing",
  ],
  questionLabels: ["Question Deadline", "Questions Close", "Q&A Close", "Question Period Ends"],
  preBidLabels: ["Pre-Bid", "Pre-Submission Meeting", "Site Meeting", "Information Session"],
  titleLabels: ["Project Title", "Opportunity", "Project", "Title", "Name"],
  agencyLabels: ["Organization", "Agency", "Buyer", "Issued By", "Owner"],
  numberLabels: ["Reference Number", "Reference No", "Project Number", "Opportunity Number", "Ref #", "Bid Number"],
  linkPattern: "(bonfirehub\\.com|eunasolutions\\.com|gobonfire\\.com)",
};

export async function ingest(config, ctx) {
  const opts = { ...DEFAULTS, ...config };
  switch (config.mode) {
    case "email": return ingestMailDrop(config, ctx, (input) => fromEmail(input, opts, ctx));
    case "csv":   return ingestCsvExport(config, ctx, ({ row }) => fromCsvRow(row, ctx));
    case "http":  return fromHttp(config, opts, ctx);
    default:
      throw new Error(`${config.id}: unsupported euna mode "${config.mode}" (use email, csv or http)`);
  }
}

function fromEmail({ email, body, links }, opts, ctx) {
  const url = links.find((href) => new RegExp(opts.linkPattern, "i").test(href)) ?? "";
  const portal = portalHost(url);
  const number = labelledValue(body, opts.numberLabels);
  const opportunityId = opportunityIdFromUrl(url);

  // Scope the ref to the portal: two agencies can both issue "RFP-2026-01".
  const localRef = number || opportunityId;
  if (!localRef) return [];
  const sourceRef = portal ? `${portal}/${localRef}` : localRef;

  const questions = findDeadline(body, opts.questionLabels, ctx);
  const preBid = findDeadline(body, opts.preBidLabels, ctx);

  return [{
    source: type,
    sourceRef,
    solicitationNumber: number,
    title: labelledValue(body, opts.titleLabels) || subjectTitle(email.subject),
    agency: labelledValue(body, opts.agencyLabels) || agencyFromHost(portal),
    portal,
    url,
    status: "open",
    ...deadlineFields(findDeadline(body, opts.closeLabels, ctx)),
    questionsDueAt: questions?.at ?? null,
    preBidAt: preBid?.at ?? null,
    preBidMandatory: /mandatory/i.test(body) ? true : null,
    // Addendum mail is how a Euna deadline usually moves; count it so the CRM
    // can show "3 addenda" rather than silently rewriting the due date.
    addendaCount: /\baddend(um|a)\b/i.test(body) ? 1 : 0,
    raw: { subject: email.subject, from: email.from, receivedAt: email.date?.toISOString() ?? null },
  }];
}

function fromCsvRow(row, ctx) {
  const url = pick(row, ["url", "link", "opportunity url"]);
  const portal = portalHost(url) || pick(row, ["portal", "organization url"]);
  const number = pick(row, ["reference number", "reference", "project number", "opportunity number", "ref"]);
  const localRef = number || opportunityIdFromUrl(url);
  if (!localRef) return null;

  const closeText = pick(row, ["close date", "closing date", "submission deadline", "deadline", "due date"]);
  return {
    source: type,
    sourceRef: portal ? `${portal}/${localRef}` : localRef,
    solicitationNumber: number,
    title: pick(row, ["project title", "opportunity", "title", "project", "name"]),
    agency: pick(row, ["organization", "agency", "buyer", "issued by"]) || agencyFromHost(portal),
    portal,
    url,
    status: pick(row, ["status", "state"]) || "open",
    ...deadlineFields(parseDeadline(closeText, { defaultTimeZone: ctx.defaultTimeZone })),
    categories: splitList(pick(row, ["category", "categories", "commodity"])),
    raw: row,
  };
}

async function fromHttp(config, opts, ctx) {
  const targets = (config.portals ?? []).map((host) =>
    /^https?:\/\//i.test(host) ? host : `https://${host}/portal/?tab=openOpportunities`
  ).concat(config.urls ?? []);

  if (!targets.length) {
    ctx.log.warn(`${config.id}: http mode enabled but no "portals" or "urls" configured`);
    return [];
  }

  const records = [];
  for (const url of targets) {
    try {
      const html = await fetchPortal(url, config, ctx);
      const portal = portalHost(url);
      const found = parseOpportunityList(html, portal, opts, ctx);
      if (!found.length) ctx.log.warn(`${config.id}: no open opportunities parsed from ${url}`);
      records.push(...found.map((r) => ({ ...r, ingestedVia: "http" })));
    } catch (err) {
      ctx.log.error(`${config.id}: ${err.message}`);
    }
  }
  return records;
}

/**
 * Pull opportunity rows out of a portal listing table.
 *
 * Row markup varies by portal theme, so this keys off the opportunity links and
 * reads the surrounding row text rather than fixed column positions.
 */
export function parseOpportunityList(html, portal, opts = DEFAULTS, ctx = { defaultTimeZone: "America/New_York" }) {
  const records = [];
  const seen = new Set();

  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const link = extractLinks(row, { absolute: false }).find((href) => /opportunit/i.test(href)) ?? "";
    const id = opportunityIdFromUrl(link) || opportunityIdFromUrl(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const text = htmlToText(row);
    const cells = text.split("|").map((c) => c.trim()).filter(Boolean);
    const deadline = findDeadline(text, opts.closeLabels, ctx)
      ?? cells.map((c) => parseDeadline(c, { defaultTimeZone: ctx.defaultTimeZone })).find(Boolean);

    records.push({
      source: type,
      sourceRef: portal ? `${portal}/${id}` : id,
      solicitationNumber: labelledValue(text, opts.numberLabels),
      title: cells[0] ?? "",
      agency: agencyFromHost(portal),
      portal,
      url: absoluteUrl(link, portal),
      status: "open",
      ...deadlineFields(deadline),
    });
  }
  return records;
}

function opportunityIdFromUrl(value) {
  if (!value) return "";
  return String(value).match(/[?&]opportunityId=(\d+)/i)?.[1]
    ?? String(value).match(/\/opportunities\/(\d+)/i)?.[1]
    ?? "";
}

function portalHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** "cityofexample.bonfirehub.com" carries the buyer name when no label does. */
function agencyFromHost(host) {
  if (!host) return "";
  const sub = host.split(".")[0];
  if (!sub || ["www", "vendor", "supplier", "portal"].includes(sub)) return "";
  return sub;
}

function absoluteUrl(href, portal) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  return portal ? `https://${portal}${href.startsWith("/") ? "" : "/"}${href}` : href;
}

function subjectTitle(subject) {
  return String(subject ?? "")
    .replace(/^(re|fwd?):\s*/i, "")
    .replace(/^\s*(euna|bonfire)[^-:|]*[-:|]\s*/i, "")
    .replace(/\s*[-|]\s*(new opportunity|addendum|notice)\s*$/i, "")
    .trim();
}

const splitList = (value) => String(value ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
