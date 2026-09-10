/**
 * Generic HTTP sink for a custom CRM.
 *
 * A bespoke CRM has a bespoke schema, so nothing here hard-codes field names.
 * The `map` block in connector.config.json says which CRM field takes which
 * value from the event, and the connector does no other translation.
 */

export const type = "crm-http";

export function create(config) {
  const url = required(config, "url");
  const method = (config.method ?? "POST").toUpperCase();
  const token = config.authEnv ? process.env[config.authEnv] : null;

  if (config.authEnv && !token) {
    throw new Error(`sink "${config.id}": env var ${config.authEnv} is not set`);
  }

  return {
    id: config.id,
    type,
    describe: () => `${method} ${url}`,

    async send(events, ctx) {
      if (!events.length) return { delivered: 0 };
      const payloads = events.map((event) => render(event, config));

      if (config.batch !== false) {
        await post(url, method, wrap(payloads, config), headers(config, token), config, ctx);
        return { delivered: payloads.length };
      }

      let delivered = 0;
      for (const payload of payloads) {
        await post(url, method, payload, headers(config, token), config, ctx);
        delivered++;
      }
      return { delivered };
    },
  };
}

/** Build one CRM-shaped object from an event, per the configured mapping. */
export function render(event, config) {
  const map = config.map ?? DEFAULT_MAP;
  const out = {};
  for (const [crmField, path] of Object.entries(map)) {
    const value = resolve(event, path);
    if (value !== undefined) out[crmField] = value;
  }
  return { ...(config.constants ?? {}), ...out };
}

/**
 * Resolve a mapping value: a dot-path into the event, or a "{a} {b}" template
 * when the CRM wants several fields combined into one.
 */
function resolve(event, path) {
  if (typeof path !== "string") return path;
  if (path.includes("{")) {
    return path.replace(/\{([^}]+)\}/g, (_, inner) => stringify(get(event, inner.trim())));
  }
  return get(event, path);
}

function get(source, path) {
  let value = source;
  for (const key of path.split(".")) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

const stringify = (v) => (v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

function wrap(payloads, config) {
  const key = config.batchKey ?? "records";
  return config.batchEnvelope === false ? payloads : { [key]: payloads, count: payloads.length };
}

function headers(config, token) {
  const out = { "content-type": "application/json", ...(config.headers ?? {}) };
  if (token) {
    const header = config.authHeader ?? "authorization";
    const scheme = config.authScheme ?? "Bearer";
    out[header.toLowerCase()] = scheme ? `${scheme} ${token}` : token;
  }
  return out;
}

/**
 * POST with bounded retry.
 *
 * 4xx other than 408/429 means the CRM rejected the shape — retrying sends the
 * same bad payload, so fail loudly and let the operator fix the mapping.
 */
async function post(url, method, body, hdrs, config, ctx) {
  const attempts = config.retries ?? 3;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: hdrs,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs ?? 20000),
      });

      if (response.ok) return;

      const detail = (await response.text().catch(() => "")).slice(0, 500);
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      lastError = new Error(`CRM responded ${response.status}: ${detail}`);
      if (!retryable) throw lastError;
    } catch (err) {
      lastError = err;
      if (err.message?.startsWith("CRM responded 4")) throw err;
    }

    if (attempt < attempts) {
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 15000);
      ctx?.log?.warn(`sink retry ${attempt}/${attempts - 1} in ${backoff}ms: ${lastError.message}`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

/** Sensible starting point; override per-CRM in config. */
export const DEFAULT_MAP = {
  external_id: "solicitation.id",
  event_type: "type",
  name: "solicitation.title",
  account: "solicitation.agency",
  due_date: "solicitation.closesAt",
  due_date_local: "solicitation.closesAtLocal",
  timezone: "solicitation.timeZone",
  questions_due: "solicitation.questionsDueAt",
  pre_bid_at: "solicitation.preBidAt",
  status: "solicitation.status",
  url: "solicitation.url",
  source_system: "solicitation.source",
  solicitation_number: "solicitation.solicitationNumber",
  days_until_close: "solicitation.daysUntilClose",
  note: "reason",
  occurred_at: "occurredAt",
};

function required(config, key) {
  if (!config[key]) throw new Error(`sink "${config.id}": "${key}" is required`);
  return config[key];
}
