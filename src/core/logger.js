import fs from 'node:fs';
import path from 'node:path';
import { getLogPath } from './config.js';
import { nowIso } from './utils.js';

export function ensureLogFile() {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# League Account Switcher log\n# Created ${nowIso()}\n`, 'utf8');
  }
  return logPath;
}

export function appendLogLine(level, message) {
  const logPath = ensureLogFile();
  const line = `${nowIso()} [${String(level).toUpperCase()}] ${String(message).replace(/\r?\n/g, ' ')}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  return logPath;
}

// Convenience logger matching the AccountManager `log(message, level?)` signature.
export function createLogger() {
  return (message, level = 'info') => {
    try {
      appendLogLine(level, message);
    } catch {
      // Logging must never break a switch.
    }
  };
}

// Keep the log from growing forever: drop any entry older than maxAgeDays so the file only ever
// holds recent history (each entry is a single line prefixed with an ISO timestamp). Called on
// startup and periodically. Never throws.
export function pruneOldLogs(maxAgeDays = 3) {
  const logPath = getLogPath();
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return; // no log yet
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const kept = text.split('\n').filter((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line);
    if (!match) return false; // drop the header / blank / unparseable lines while pruning
    const ts = Date.parse(match[1]);
    return Number.isFinite(ts) ? ts >= cutoff : false;
  });
  const next = kept.length ? `${kept.join('\n')}\n` : '';
  if (next.length !== text.length) {
    try {
      fs.writeFileSync(logPath, next, 'utf8');
    } catch {
      // ignore — pruning is best-effort
    }
  }
}
