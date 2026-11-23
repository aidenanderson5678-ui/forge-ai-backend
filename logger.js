'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(err) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

/**
 * Minimal structured (JSON lines) logger.
 * Never pass prompts, source code or secrets in `fields`.
 */
function createLogger({ level = 'info', write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink =
    write ||
    ((line, severity) => {
      (severity >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
    });

  function log(name, message, fields) {
    const severity = LEVELS[name];
    if (severity < threshold) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level: name, msg: message, ...fields }), severity);
  }

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  };
}

module.exports = { createLogger, serializeError };
