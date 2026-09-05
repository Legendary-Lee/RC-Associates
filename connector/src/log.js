/** Leveled logger. Structured JSON when LOG_FORMAT=json, for hosted schedulers. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = "info", format = process.env.LOG_FORMAT } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name, message, fields) => {
    if (LEVELS[name] < threshold) return;
    const stream = LEVELS[name] >= LEVELS.warn ? process.stderr : process.stdout;
    if (format === "json") {
      stream.write(JSON.stringify({ ts: new Date().toISOString(), level: name, message, ...fields }) + "\n");
    } else {
      stream.write(`${name === "info" ? "" : `${name}: `}${message}\n`);
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
