const MAX = 200;
const _log = [];

function logError(context, err) {
  const entry = {
    t:       new Date().toISOString(),
    context,
    message: err?.message || String(err),
    code:    err?.code || null,
    stack:   err?.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : null,
  };
  _log.push(entry);
  if (_log.length > MAX) _log.shift();
  console.error(`[ERROR][${context}] ${entry.message}${entry.code ? ` (${entry.code})` : ""}`);
}

function getLog() {
  return [..._log].reverse(); // najnoviji prvi
}

module.exports = { logError, getLog };
