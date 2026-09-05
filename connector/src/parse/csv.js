/** RFC 4180 CSV reader, tolerant of CRLF and embedded quotes/newlines. */

export function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; started = true; continue; }
    if (ch === ",") { row.push(field); field = ""; started = true; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      if (started || row.some((c) => c !== "")) rows.push(row);
      row = []; field = ""; started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  row.push(field);
  if (started || row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** Parse into objects keyed by a normalized header ("Close Date" -> "close date"). */
export function parseCsvRecords(input) {
  const rows = parseCsv(input);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((h, i) => { record[h] = (cells[i] ?? "").trim(); });
    return record;
  });
}

/** First value whose header matches any of `names` (case-insensitive substring). */
export function pick(record, names) {
  for (const name of names) {
    const key = Object.keys(record).find((k) => k === name || k.includes(name));
    if (key && record[key]) return record[key];
  }
  return "";
}
