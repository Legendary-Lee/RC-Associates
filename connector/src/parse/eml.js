/**
 * Minimal RFC 5322 / MIME reader — enough for portal notification emails.
 *
 * Notification mail is the one integration channel a supplier fully controls:
 * both BidNet Direct and Euna send it to the address on your vendor profile, no
 * credentials or scraping involved. Deliberately not a general-purpose MIME
 * implementation; it handles the single- and multipart/alternative shapes these
 * senders actually produce.
 */

export function parseEml(source) {
  const raw = Buffer.isBuffer(source) ? source.toString("binary") : String(source);
  const text = raw.replace(/\r\n/g, "\n");
  const { headers, body } = splitHeaders(text);
  const parts = extractParts(headers, body);

  const html = parts.find((p) => p.type === "text/html")?.content ?? "";
  const plain = parts.find((p) => p.type === "text/plain")?.content ?? "";

  return {
    headers,
    subject: decodeWords(headers.subject ?? ""),
    from: decodeWords(headers.from ?? ""),
    date: headers.date ? new Date(headers.date) : null,
    messageId: (headers["message-id"] ?? "").replace(/[<>]/g, "").trim(),
    html,
    text: plain,
    parts,
  };
}

function splitHeaders(text) {
  const blank = text.indexOf("\n\n");
  const head = blank === -1 ? text : text.slice(0, blank);
  const body = blank === -1 ? "" : text.slice(blank + 2);

  const headers = {};
  // Unfold continuation lines before splitting on ':'.
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return { headers, body };
}

function extractParts(headers, body) {
  const contentType = headers["content-type"] ?? "text/plain";
  const boundary = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i)?.[1];

  if (!boundary) {
    return [{
      type: mimeType(contentType),
      content: decodeBody(body, headers["content-transfer-encoding"], charset(contentType)),
    }];
  }

  const parts = [];
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    const sub = splitHeaders(trimmed);
    const subType = sub.headers["content-type"] ?? "text/plain";
    if (/multipart\//i.test(subType)) {
      parts.push(...extractParts(sub.headers, sub.body));
      continue;
    }
    parts.push({
      type: mimeType(subType),
      content: decodeBody(sub.body, sub.headers["content-transfer-encoding"], charset(subType)),
    });
  }
  return parts;
}

const mimeType = (ct) => ct.split(";")[0].trim().toLowerCase();
const charset = (ct) => ct.match(/charset\s*=\s*"?([^";]+)"?/i)?.[1]?.toLowerCase() ?? "utf-8";

function decodeBody(body, encoding, cs) {
  const enc = (encoding ?? "").trim().toLowerCase();
  let bytes;
  if (enc === "base64") {
    bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  } else if (enc === "quoted-printable") {
    bytes = Buffer.from(decodeQuotedPrintable(body), "binary");
  } else {
    bytes = Buffer.from(body, "binary");
  }
  return bytes.toString(supportedCharset(cs));
}

const supportedCharset = (cs) =>
  /^(utf-?8)$/.test(cs) ? "utf8" : /^(us-ascii|iso-8859-1|latin1|windows-1252)$/.test(cs) ? "latin1" : "utf8";

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\n/g, "")               // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** RFC 2047 encoded-word decoding, for subjects with non-ASCII agency names. */
export function decodeWords(value) {
  return String(value).replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, cs, enc, data) => {
      const bytes = enc.toUpperCase() === "B"
        ? Buffer.from(data, "base64")
        : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, " ")), "binary");
      return bytes.toString(supportedCharset(cs.toLowerCase()));
    }
  ).trim();
}
