/**
 * BidNet Direct adapter.
 *
 * BidNet Direct has no supplier-facing public API, so the supported channels are
 * the ones a registered vendor already controls:
 *   - email : the match notifications BidNet sends to your vendor profile
 *   - csv   : a "Bid Opportunities" / saved-search export downloaded from the site
 *   - http  : an authenticated page fetch, opt-in, using your own session cookie
 *
 * Label and link patterns are overridable per source in connector.config.json —
 * notification templates change, and re-tuning should not need a code change.
 */

import {
  ingestMailDrop, ingestCsvExport, fetchPortal,
  findDeadline, deadlineFields, labelledValue, pick, parseDeadline,
} from "./common.js";
import { htmlToText, extractLinks } from "../parse/html.js";

export const type = "bidnet";

const DEFAULTS = {
  closeLabels: [
    "Closing Date", "Close Date", "Bid Closing Date", "Bid Due Date",
    "Due Date", "Submission Deadline", "Proposals Due", "Bids Due", "Closes",
  ],
  questionLabels: ["Question Deadline", "Questions Due", "Q&A Deadline", "Inquiry Deadline"],
  preBidLabels: ["Pre-Bid", "Pre Bid", "Pre-Bid Meeting", "Site Visit", "Pre-Proposal"],
  titleLabels: ["Solicitation Title", "Bid Title", "Project Title", "Title", "Description"],
  agencyLabels: ["Agency", "Issuing Organization", "Organization", "Purchasing Group", "Buyer", "Entity"],
  numberLabels: ["Solicitation Number", "Bid Number", "Reference Number", "Bid ID", "Project Number"],
  linkPattern: "bidnetdirect\\.com",
};

export async function ingest(config, ctx) {
  const opts = { ...DEFAULTS, ...config };
  switch (config.mode) {
    case "email": return ingestMailDrop(config, ctx, (input) => fromEmail(input, opts, ctx));
    case "csv":   return ingestCsvExport(config, ctx, ({ row }) => fromCsvRow(row, ctx));
    case "http":  return fromHttp(config, opts, ctx);
    default:
      throw new Error(`${config.id}: unsupported bidnet mode "${config.mode}" (use email, csv or http)`);
  }
}

function fromEmail({ email, body, links }, opts, ctx) {
  const url = links.find((href) => new RegExp(opts.linkPattern, "i").test(href)) ?? "";
  const number = labelledValue(body, opts.numberLabels);
  const title = labelledValue(body, opts.titleLabels) || subjectTitle(email.subject);

  // A notification with no solicitation link and no reference number is almost
  // certainly a digest footer or an account notice, not an opportunity.
  const sourceRef = number || solicitationIdFromUrl(url);
  if (!sourceRef) return [];

  const questions = findDeadline(body, opts.questionLabels, ctx);
  const preBid = findDeadline(body, opts.preBidLabels, ctx);

  return [{
    source: type,
    sourceRef,
    solicitationNumber: number,
    title,
    agency: labelledValue(body, opts.agencyLabels),
    portal: "bidnetdirect.com",
    url,
    status: "open",
    ...deadlineFields(findDeadline(body, opts.closeLabels, ctx)),
    questionsDueAt: questions?.at ?? null,
    preBidAt: preBid?.at ?? null,
    preBidMandatory: /mandatory/i.test(body) ? true : null,
    raw: { subject: email.subject, from: email.from, receivedAt: email.date?.toISOString() ?? null },
  }];
}

function fromCsvRow(row, ctx) {
  const number = pick(row, ["solicitation number", "bid number", "reference", "bid id", "id"]);
  const url = pick(row, ["url", "link", "bid url"]);
  const sourceRef = number || solicitationIdFromUrl(url);
  if (!sourceRef) return null;

  const closeText = pick(row, ["closing date", "close date", "due date", "bid due", "closes"]);
  return {
    source: type,
    sourceRef,
    solicitationNumber: number,
    title: pick(row, ["title", "bid title", "description", "name"]),
    agency: pick(row, ["agency", "organization", "buyer", "entity", "purchasing group"]),
    portal: "bidnetdirect.com",
    url,
    status: pick(row, ["status", "state"]) || "open",
    ...deadlineFields(parseDeadline(closeText, { defaultTimeZone: ctx.defaultTimeZone })),
    categories: splitList(pick(row, ["category", "categories", "nigp"])),
    raw: row,
  };
}

async function fromHttp(config, opts, ctx) {
  const urls = config.urls ?? [];
  if (!urls.length) {
    ctx.log.warn(`${config.id}: http mode enabled but no "urls" configured`);
    return [];
  }

  const records = [];
  for (const url of urls) {
    try {
      const html = await fetchPortal(url, config, ctx);
      const body = htmlToText(html);
      const number = labelledValue(body, opts.numberLabels);
      const sourceRef = number || solicitationIdFromUrl(url);
      if (!sourceRef) {
        ctx.log.warn(`${config.id}: no solicitation reference found at ${url}`);
        continue;
      }
      records.push({
        source: type,
        sourceRef,
        solicitationNumber: number,
        title: labelledValue(body, opts.titleLabels) || firstHeading(html),
        agency: labelledValue(body, opts.agencyLabels),
        portal: "bidnetdirect.com",
        url,
        status: /\bclosed\b/i.test(body) ? "closed" : "open",
        ...deadlineFields(findDeadline(body, opts.closeLabels, ctx)),
        ingestedVia: "http",
        raw: { fetchedAt: new Date().toISOString(), links: extractLinks(html).slice(0, 10) },
      });
    } catch (err) {
      ctx.log.error(`${config.id}: ${err.message}`);
    }
  }
  return records;
}

/** BidNet solicitation URLs end in a long numeric id. */
function solicitationIdFromUrl(url) {
  if (!url) return "";
  return url.match(/\/(?:solicitations|abstract)\/(?:[^/?#]+\/)*(\d{4,})/)?.[1]
    ?? url.match(/[?&](?:solicitationId|bidId)=(\d+)/i)?.[1]
    ?? "";
}

function subjectTitle(subject) {
  return String(subject ?? "")
    .replace(/^(re|fwd?):\s*/i, "")
    .replace(/^\s*(bidnet direct|new bid (match|opportunity)|bid notification)\s*[-:|]\s*/i, "")
    .trim();
}

const firstHeading = (html) => htmlToText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
const splitList = (value) => String(value ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
