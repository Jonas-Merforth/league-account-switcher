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
