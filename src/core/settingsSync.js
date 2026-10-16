import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getSettingsBaselineDir, getLeagueConfigDir } from './config.js';

export const SYNCED_FILES = ['game.cfg', 'input.ini', 'PersistedSettings.json'];
export const IN_GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
const SNAPSHOT_FILE = 'snapshot.json';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWritable(file) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
}

function readFiles(dir) {
  const files = {};
  for (const name of SYNCED_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file, 'utf8');
  }
  return files;
}

function persistedSettings(files) {
  const data = JSON.parse(files['PersistedSettings.json']);
  if (!Array.isArray(data?.files) || !data.files.some((file) =>
    /^game\.cfg$/i.test(file.name) && Array.isArray(file.sections) && file.sections.length)) {
    throw new Error('League settings are empty or incomplete. Wait for the client to finish saving.');
  }
  return data;
}

function readBaseline() {
  const dir = getSettingsBaselineDir();
  const snapshotPath = path.join(dir, SNAPSHOT_FILE);
  if (fs.existsSync(snapshotPath)) {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    persistedSettings(snapshot.files);
    return snapshot;
  }
  // Migrate existing installations on their first new capture.
  const files = readFiles(dir);
  persistedSettings(files);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8')); } catch {}
  return { ...meta, files };
}

export function hasBaseline() {
  try { readBaseline(); return true; } catch { return false; }
}

export function getBaselineMeta() {
  try {
    const { capturedAt = null, account = null } = readBaseline();
    return { capturedAt, account };
  } catch { return { capturedAt: null, account: null }; }
}

// One atomic snapshot prevents a failed/partial capture mixing settings from two accounts.
// Missing optional files are omitted, rather than retaining files from an older capture.
export function captureBaseline(leaguePath, meta = {}) {
  const files = readFiles(getLeagueConfigDir(leaguePath));
  persistedSettings(files);
  if (JSON.stringify(files) !== JSON.stringify(readFiles(getLeagueConfigDir(leaguePath)))) {
    throw new Error('League is still writing its settings. Retry after the save completes.');
  }
  const stored = { capturedAt: meta.capturedAt ?? null, account: meta.account ?? null };
  const dir = getSettingsBaselineDir();
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, SNAPSHOT_FILE + '.' + crypto.randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...stored, files }), 'utf8');
    fs.renameSync(temp, path.join(dir, SNAPSHOT_FILE));
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return stored;
}

export function applyBaseline(leaguePath) {
  if (!hasBaseline()) return false;
  const { files } = readBaseline();
  const configDir = getLeagueConfigDir(leaguePath);
  fs.mkdirSync(configDir, { recursive: true });
  const original = readFiles(configDir);
  try {
    for (const name of SYNCED_FILES) {
      if (!(name in files)) continue;
      const dest = path.join(configDir, name);
      makeWritable(dest);
      fs.writeFileSync(dest, files[name], 'utf8');
      fs.chmodSync(dest, 0o444);
    }
    return true;
  } catch (error) {
    unlockConfig(leaguePath);
    for (const name of SYNCED_FILES) {
      const dest = path.join(configDir, name);
      if (name in original) fs.writeFileSync(dest, original[name], 'utf8');
      else fs.rmSync(dest, { force: true });
    }
    throw error;
  }
}

export function unlockConfig(leaguePath) {
  const failures = [];
  for (const name of SYNCED_FILES) {
    try { makeWritable(path.join(getLeagueConfigDir(leaguePath), name)); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Could not make League settings writable.');
}

export function baselineMatchesLive(leaguePath) {
  if (!hasBaseline()) return true;
  const { files } = readBaseline();
  const live = readFiles(getLeagueConfigDir(leaguePath));
  return SYNCED_FILES.every((name) => {
    if (!(name in files) || files[name] === live[name]) return true;
    if (name === 'PersistedSettings.json') {
      try { return isDeepStrictEqual(JSON.parse(files[name]), JSON.parse(live[name])); }
      catch { return false; }
    }
    return typeof live[name] === 'string' && files[name].replace(/\r\n/g, '\n').trim() === live[name].replace(/\r\n/g, '\n').trim();
  });
}

// Only send keys/types supported by this version of League. The full snapshot retains
// video settings and other values outside the client API's scope.
export function settingsPatch(persisted, fileName, current) {
  const file = persisted.files.find((entry) => entry.name.toLowerCase() === fileName.toLowerCase());
  const patch = {};
  for (const section of file?.sections ?? []) {
    for (const setting of section.settings ?? []) {
      const currentValue = current?.[section.name]?.[setting.name];
      let value;
      if (typeof currentValue === 'boolean') {
        if (!['0', '1', 'true', 'false'].includes(String(setting.value).toLowerCase())) continue;
        value = ['1', 'true'].includes(String(setting.value).toLowerCase());
      } else if (typeof currentValue === 'number') {
        value = Number(setting.value);
        if (!Number.isFinite(value) || String(setting.value).trim() === '') continue;
      } else if (typeof currentValue === 'string') value = String(setting.value);
      else continue;
      (patch[section.name] ??= {})[setting.name] = value;
    }
  }
  return patch;
}

function patchMatches(patch, actual) {
  return Object.entries(patch).every(([section, settings]) =>
    Object.entries(settings).every(([key, value]) => {
      const found = actual?.[section]?.[key];
      return typeof value === 'number' ? typeof found === 'number' && Math.abs(value - found) < 0.00001 : found === value;
    }));
}

// Flush the same disk changes League reloads after a game, before closing the outgoing client.
// Callers supply a session-pinned LCU so a restart cannot capture another account.
export async function captureLiveBaseline(lcu, leaguePath, { assertCurrent = () => {} } = {}) {
  const phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  if (typeof phase !== 'string' || IN_GAME_PHASES.has(phase)) return null;
  if (await lcu.get('/lol-game-settings/v1/ready') !== true) return null;
  const identity = await lcu.get('/lol-summoner/v1/current-summoner');
  if (!identity?.puuid) return null;
  assertCurrent();
  await lcu.post('/lol-game-settings/v1/reload-post-game');
  await lcu.post('/lol-game-settings/v1/save');
  assertCurrent();
  lcu.getCredentials?.();
  return captureBaseline(leaguePath, {
    capturedAt: new Date().toISOString(),
    account: identity.gameName ? identity.gameName + (identity.tagLine ? '#' + identity.tagLine : '') : identity.displayName
  });
}

// A lockfile is not evidence that settings have downloaded. Wait for readiness, update
// both the client's in-memory and server-backed values, verify, and always unlock on exit.
export async function applyBaselineToClient(lcu, leaguePath, {
  assertCurrent = () => {}, waitFor = wait, attempts = 60
} = {}) {
  try {
    const persisted = persistedSettings(readBaseline().files);
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      assertCurrent();
      ready = await lcu.get('/lol-game-settings/v1/ready').catch((error) => {
        if (error.code === 'LCU_SESSION_CHANGED') throw error;
        return false;
      });
      if (ready === true) break;
      await waitFor(500);
    }
    if (ready !== true) throw new Error('League did not finish loading account settings; the shared baseline is preserved.');
    const phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
    if (typeof phase !== 'string' || IN_GAME_PHASES.has(phase)) throw new Error('Settings cannot be applied during a game.');
    assertCurrent();
    unlockConfig(leaguePath);
    for (const [resource, fileName] of [['game-settings', 'Game.cfg'], ['input-settings', 'Input.ini']]) {
      const endpoint = '/lol-game-settings/v1/' + resource;
      const current = await lcu.get(endpoint);
      if (!current || typeof current !== 'object') throw new Error('League ' + resource + ' are unavailable.');
      const patch = settingsPatch(persisted, fileName, current);
      assertCurrent();
      if (!Object.keys(patch).length) continue;
      if (resource === 'input-settings') {
        // Voice owns these bindings too and otherwise immediately restores its account-specific
        // keys, removing any conflicting game binding (for example character menu on C).
        const voiceEndpoint = '/lol-settings/v2/account/LCUPreferences/lol-premade-voice';
        const voice = await lcu.get(voiceEndpoint);
        const voicePatch = {};
        for (const [gameKey, voiceKey] of [['evtPushToTalk', 'pushToTalkKey'], ['evtPushToTalkTeam', 'pushToTalkTeamKey']]) {
          const value = patch.GameEvents?.[gameKey];
          if (typeof value === 'string' && typeof voice?.data?.[voiceKey] === 'string') voicePatch[voiceKey] = value;
        }
        if (Object.keys(voicePatch).length) {
          assertCurrent();
          await lcu.patch(voiceEndpoint, { schemaVersion: voice.schemaVersion, data: voicePatch });
        }
      }
      await lcu.patch('/lol-settings/v2/account/GamePreferences/' + resource, { schemaVersion: 1, data: patch });
      const actual = await lcu.get(endpoint);
      if (!patchMatches(patch, actual)) throw new Error('League did not accept all shared ' + resource + '.');
    }
    assertCurrent();
    await lcu.post('/lol-game-settings/v1/save');
    return true;
  } finally {
    unlockConfig(leaguePath);
  }
}
