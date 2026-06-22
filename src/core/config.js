import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_NAME,
  DEFAULT_LEAGUE_PATH,
  DEFAULT_RIOT_CLIENT_SERVICES,
  RIOT_CLIENT_INSTALLS_PATH,
  RIOT_CLIENT_LOCKFILE_SUBPATH,
  RIOT_SESSION_FILE_SUBPATH
} from './constants.js';

// Path resolution for the account switcher. The accounts store (accounts.json + per-account
// session.enc) is intentionally SHARED with the League Client Automation app, so getConfigDir()
// resolves to the same %AppData%\LeagueClientAutomation folder. Our own settings live in a separate
// file in that folder (switcher-settings.json) so we never clobber the automation app's settings.

export function getConfigDir() {
  if (process.env.LCA_CONFIG_DIR) return process.env.LCA_CONFIG_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, APP_NAME);
  return path.join(os.homedir(), `.${APP_NAME}`);
}

// Our own settings file (kept separate from the automation app's settings.json).
export function getSwitcherSettingsPath() {
  return path.join(getConfigDir(), 'switcher-settings.json');
}

// Switcher-only account grouping/order (keyed by account id). Kept separate from accounts.json so the
// automation app never strips it via normalizeAccount.
export function getSwitcherLayoutPath() {
  return path.join(getConfigDir(), 'switcher-layout.json');
}

export function getLogPath() {
  return path.join(getConfigDir(), 'switcher.log');
}

export function getAccountsPath() {
  return path.join(getConfigDir(), 'accounts.json');
}

// Per-account encrypted session snapshots live under <configDir>/accounts/<id>/session.enc.
export function getAccountsDir() {
  return path.join(getConfigDir(), 'accounts');
}

function getLocalAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

// Riot Client's persisted login lives here; switching accounts swaps this file while the client is closed.
export function getRiotSessionFilePath() {
  if (process.env.LCA_RIOT_SESSION_FILE) return process.env.LCA_RIOT_SESSION_FILE;
  return path.join(getLocalAppDataDir(), RIOT_SESSION_FILE_SUBPATH);
}

export function getRiotLockfilePath() {
  if (process.env.LCA_RIOT_LOCKFILE) return process.env.LCA_RIOT_LOCKFILE;
  return path.join(getLocalAppDataDir(), RIOT_CLIENT_LOCKFILE_SUBPATH);
}

// Resolve League's install folder (where its `lockfile` appears when running). RiotClientInstalls.json
// maps each installed product's folder to its client under `associated_client`; the League key is that
// folder. This makes the "is League up?" check work regardless of where League is installed.
export function resolveLeaguePath() {
  if (process.env.LCA_LEAGUE_PATH) return process.env.LCA_LEAGUE_PATH;
  try {
    const installs = JSON.parse(fs.readFileSync(RIOT_CLIENT_INSTALLS_PATH, 'utf8'));
    const associated = installs.associated_client;
    if (associated && typeof associated === 'object') {
      const matches = Object.keys(associated).filter((folder) => /league of legends/i.test(folder));
      if (matches.length) {
        // Prefer the live install over PBE / other patchlines when both are present.
        const live = matches.find((folder) => !/pbe/i.test(folder)) || matches[0];
        return path.normalize(live.replace(/[\\/]+$/, ''));
      }
    }
  } catch {
    // Fall back to the conventional path when the registry file is missing or malformed.
  }
  return DEFAULT_LEAGUE_PATH;
}

// Resolve RiotClientServices.exe from RiotClientInstalls.json (rc_live/rc_default), falling back to the default path.
export function resolveRiotClientServicesPath() {
  if (process.env.LCA_RIOT_CLIENT_EXE) return process.env.LCA_RIOT_CLIENT_EXE;
  try {
    const installs = JSON.parse(fs.readFileSync(RIOT_CLIENT_INSTALLS_PATH, 'utf8'));
    const candidate = installs.rc_live || installs.rc_default || Object.values(installs.patchlines ?? {})[0];
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.normalize(candidate);
    }
  } catch {
    // Fall back to the conventional install path when the registry file is missing or malformed.
  }
  return DEFAULT_RIOT_CLIENT_SERVICES;
}
