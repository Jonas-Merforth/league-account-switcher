import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAccountsDir, getAccountsPath, getConfigDir } from './config.js';

// Persistence for the account manager. accounts.json holds metadata + the DPAPI-encrypted password
// (never the plaintext); each account's encrypted Riot session snapshot lives at
// <configDir>/accounts/<id>/session.enc. The normalize/redact helpers are pure for unit testing.

const STALE_SESSION_DAYS = 14; // Riot persisted sessions expire in ~1-3 weeks; warn past two.

export function normalizeAccount(input = {}) {
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID();
  const username = String(input.username ?? '').trim();
  return {
    id,
    label: String(input.label ?? '').trim() || username || 'Account',
    username,
    passwordEnc: typeof input.passwordEnc === 'string' ? input.passwordEnc : '',
    region: String(input.region ?? '').trim(),
    lastSummonerName: input.lastSummonerName ? String(input.lastSummonerName) : null,
    sessionCapturedAt: input.sessionCapturedAt ? String(input.sessionCapturedAt) : null
  };
}

export function normalizeAccounts(list) {
  return (Array.isArray(list) ? list : []).map(normalizeAccount);
}

// Public view for API responses: never includes the encrypted password, only whether one is stored.
export function redactAccount(account) {
  const { passwordEnc, ...rest } = account;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

// Heuristic: does a Riot session file actually contain a persisted ("Stay signed in") login?
// A signed-out / no-remember file shows `persist: null` and only a device (tdid) cookie; a
// persisted login carries the `ssid` token under a non-null persist/cookies block.
export function hasPersistedSession(content) {
  const text = String(content ?? '');
  if (/persist:\s*null/i.test(text)) return false;
  return /ssid/i.test(text) || (/persist:/i.test(text) && /cookies/i.test(text));
}

export function describeSessionAge(sessionCapturedAt, now = new Date()) {
  if (!sessionCapturedAt) return { captured: false, days: null, stale: false, text: 'No saved session' };
  const then = new Date(sessionCapturedAt);
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return { captured: true, days: 0, stale: false, text: 'Session saved' };
  const days = Math.floor(ms / 86_400_000);
  const stale = days >= STALE_SESSION_DAYS;
  const text = days === 0 ? 'Session saved today' : `Session saved ${days}d ago`;
  return { captured: true, days, stale, text };
}

export function loadAccounts() {
  try {
    const text = fs.readFileSync(getAccountsPath(), 'utf8');
    return normalizeAccounts(JSON.parse(text));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read accounts, starting empty: ${error.message}`);
    }
    return [];
  }
}

export function saveAccounts(accounts) {
  const normalized = normalizeAccounts(accounts);
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getAccountsPath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export function getSnapshotDir(id) {
  return path.join(getAccountsDir(), id);
}

export function getSnapshotPath(id) {
  return path.join(getSnapshotDir(id), 'session.enc');
}

export function hasSnapshot(id) {
  return fs.existsSync(getSnapshotPath(id));
}

export function writeSnapshot(id, encryptedContent) {
  fs.mkdirSync(getSnapshotDir(id), { recursive: true });
  fs.writeFileSync(getSnapshotPath(id), encryptedContent, 'utf8');
}

export function readSnapshot(id) {
  return fs.readFileSync(getSnapshotPath(id), 'utf8');
}

export function removeSnapshotDir(id) {
  fs.rmSync(getSnapshotDir(id), { recursive: true, force: true });
}
