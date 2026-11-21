import fs from 'node:fs';
import path from 'node:path';
import { DAMAGE_SESSION_ID } from './damageIpCapture.js';

const PACKET_FILE = 'raw-ipv4.pcapng';
const TEMPORARY_FILES = [PACKET_FILE, 'DamageIpCapture.cs', 'damageCapture.ps1', 'heartbeat', 'status.json',
  'status.json.tmp', 'stop', 'stop-helper', 'next-session', 'next-session.tmp', 'helper-error.txt'];
const STALE_AFTER_MS = 60_000;

export function discardTemporaryCapture(root, directory, { helperActive = false } = {}) {
  if (path.dirname(directory) !== root || !DAMAGE_SESSION_ID.test(path.basename(directory))) return true;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return true;
    for (const file of helperActive ? [PACKET_FILE] : TEMPORARY_FILES) {
      fs.rmSync(path.join(directory, file), { force: true });
    }
    if (helperActive) return false;
    fs.rmdirSync(directory);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

// After an app crash the capture helper can still be winding down. Recent
// heartbeats leave it time to close before the next app instance removes files.
export function pruneStaleCaptures(root, now = Date.now()) {
  if (!root) return false;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return false; }
  let pending = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !DAMAGE_SESSION_ID.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const heartbeat = fs.statSync(path.join(directory, 'heartbeat'), { throwIfNoEntry: false });
      if (now - (heartbeat?.mtimeMs ?? fs.statSync(directory).mtimeMs) < STALE_AFTER_MS) {
        pending = true;
        continue;
      }
    } catch { continue; }
    if (!discardTemporaryCapture(root, directory)) pending = true;
  }
  return pending;
}
