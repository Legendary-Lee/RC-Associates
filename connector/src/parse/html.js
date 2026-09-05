/** HTML-to-text and label/value extraction for notification email bodies. */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: "...",
};

export function decodeEntities(input) {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(code) {
  try { return String.fromCodePoint(code); } catch { return ""; }
}

/**
 * Flatten HTML to text, preserving row/cell boundaries as separators so that
 * "Closing Date" and its value stay adjacent and recoverable.
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|tr|h[1-6]|li)\s*>/gi, "\n")
      .replace(/<\/\s*(td|th)\s*>/gi, " | ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * All href values in the document, in order.
 *
 * Portal listing tables link opportunities relatively ("/portal/?..."), so
 * `absolute: false` is needed there; email bodies always carry absolute links.
 */
export function extractLinks(html, { absolute = true } = {}) {
  const hrefs = [...String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => decodeEntities(m[1]).trim())
    .filter(Boolean);
  return absolute ? hrefs.filter((href) => /^https?:\/\//i.test(href)) : hrefs;
}

/**
 * Value following a "Label:" or "Label |" marker in flattened text.
 * Portal emails render these as table rows, so the value may land on the same
 * line after a pipe or on the next line entirely.
 */
export function labelledValue(text, labels) {
  for (const label of labels) {
    const re = new RegExp(
      `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:|]?\\s*([^\\n|]{1,300})`,
      "i"
    );
    const inline = text.match(re);
    if (inline && inline[1].trim()) return inline[1].trim();

    const lines = text.split("\n");
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${label}\\s*[:|]?\\s*$`, "i").test(l));
    if (idx !== -1 && lines[idx + 1]?.trim()) return lines[idx + 1].trim();
  }
  return "";
}
