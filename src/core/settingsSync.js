import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettingsBaselineDir, getLeagueConfigDir } from './config.js';

// Persist in-game settings across accounts. League stores settings server-side per account and pulls
// them down on client login, overwriting the local Config files — which is why keybinds/camera "reset"
// when you switch accounts. We keep one shared snapshot (the "baseline") of the core settings files
// and re-apply it on every switch, briefly setting the files read-only across the login window so the
// server sync-down can't clobber them. After League is up the read-only bit is cleared again, so you
// can still change settings normally; the baseline simply re-applies on the next switch.
//
// Scope is intentionally the three gameplay files only — account-specific data (rune pages, item sets)
// is left untouched so it stays per account.
export const SYNCED_FILES = ['game.cfg', 'input.ini', 'PersistedSettings.json'];

// PersistedSettings.json is the file the client syncs to the server; it must be writable to capture a
// fresh baseline and read-only to defeat the sync-down. The other two are downstream copies.
const META_FILE = 'baseline.json';

const READONLY_MODE = 0o444;
const WRITABLE_MODE = 0o644;

function baselineFilePath(name) {
  return path.join(getSettingsBaselineDir(), name);
}

function liveFilePath(leaguePath, name) {
  return path.join(getLeagueConfigDir(leaguePath), name);
}

function metaPath() {
  return path.join(getSettingsBaselineDir(), META_FILE);
}

// Clear the read-only attribute so a copy/overwrite can't fail with EPERM. Best-effort.
function makeWritable(file) {
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, WRITABLE_MODE);
  } catch {
    // Not fatal — the copy below will surface a real problem if there is one.
  }
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null; // missing/unreadable — treated as "no content" for comparison
  }
}

// A baseline exists once we've captured the key synced file (PersistedSettings.json).
export function hasBaseline() {
  return fs.existsSync(baselineFilePath('PersistedSettings.json'));
}

// { capturedAt, account } — when the baseline was captured and which account it was taken from.
export function getBaselineMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    return { capturedAt: meta.capturedAt ?? null, account: meta.account ?? null };
  } catch {
    return { capturedAt: null, account: null };
  }
}

// Snapshot the current Config files as the shared baseline. Caller guarantees a client has been
// logged in (so the files reflect a real account). `meta` records when and from which account it was
// taken (for the UI hint). Returns the stored meta.
export function captureBaseline(leaguePath, meta = {}) {
  const dir = getSettingsBaselineDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of SYNCED_FILES) {
    const src = liveFilePath(leaguePath, name);
    if (!fs.existsSync(src)) continue; // a file may be absent on a fresh install
    const dest = baselineFilePath(name);
    makeWritable(dest);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, WRITABLE_MODE);
  }
  const stored = { capturedAt: meta.capturedAt ?? null, account: meta.account ?? null };
  fs.writeFileSync(metaPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return stored;
}

// Copy the baseline into the Config folder and lock the files read-only. Called mid-switch, before
// the Riot Client is relaunched, so the account's login sync-down can't overwrite our settings.
export function applyBaseline(leaguePath) {
  if (!hasBaseline()) return false;
  const configDir = getLeagueConfigDir(leaguePath);
  fs.mkdirSync(configDir, { recursive: true });
  let applied = false;
  for (const name of SYNCED_FILES) {
    const src = baselineFilePath(name);
    if (!fs.existsSync(src)) continue;
    const dest = liveFilePath(leaguePath, name);
    makeWritable(dest);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, READONLY_MODE);
    applied = true;
  }
  return applied;
}

// Clear the read-only attribute on the live Config files so the user can change settings again (the
// baseline re-applies on the next switch). Called once League is up, and when sync is turned off.
export function unlockConfig(leaguePath) {
  for (const name of SYNCED_FILES) {
    makeWritable(liveFilePath(leaguePath, name));
  }
}

// True when every synced file in Config matches the baseline byte-for-byte. Used on startup to detect
// that the user launched a different account manually (live settings differ from the baseline).
export function baselineMatchesLive(leaguePath) {
  if (!hasBaseline()) return true; // nothing to compare against
  for (const name of SYNCED_FILES) {
    const baseHash = sha256(baselineFilePath(name));
    if (baseHash === null) continue; // file not part of the baseline
    if (sha256(liveFilePath(leaguePath, name)) !== baseHash) return false;
  }
  return true;
}
