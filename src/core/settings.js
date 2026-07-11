import fs from 'node:fs';
import { getConfigDir, getSwitcherSettingsPath } from './config.js';
import { DEFAULT_LEAGUE_PATH } from './constants.js';
import { DEFAULT_REGION, normalizeRegionCode } from './regions.js';

// Slim settings for the standalone switcher, stored in switcher-settings.json (separate from the
// automation app's settings.json, but in the same shared config dir).

// Auto-accept waits this long after a ready check appears before accepting (0 = as soon as possible).
// Capped at the ~10s the client gives you to accept.
export const MAX_AUTO_ACCEPT_DELAY_MS = 10_000;
export const DEFAULT_FRIENDS_POC_AUTO_REFRESH_MS = 60_000;
export const MIN_FRIENDS_POC_AUTO_REFRESH_MS = 15_000;
export const MAX_FRIENDS_POC_AUTO_REFRESH_MS = 60 * 60_000;

export function defaultSettings() {
  return {
    defaultRegion: DEFAULT_REGION,
    startWithWindows: true,
    autoUpdate: true,
    autoAccept: false,
    autoAcceptDelayMs: 2_000,
    autoClientCleanup: false,
    syncSettings: false,
    friendsPocAggressiveFetching: false,
    friendsPocUseAllAccounts: false,
    friendsPocSelectedAccountIds: [],
    friendsPocSelectionInitialized: false,
    friendsPocFavoriteFriendKeys: [],
    friendsPocAutoRefresh: false,
    friendsPocAutoRefreshMs: DEFAULT_FRIENDS_POC_AUTO_REFRESH_MS,
    queueRelayAllowedPuuids: [],
    leaguePath: DEFAULT_LEAGUE_PATH
  };
}

function normalizeAcceptDelay(value, fallback) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return fallback;
  return Math.min(MAX_AUTO_ACCEPT_DELAY_MS, Math.max(0, Math.round(ms)));
}

function normalizeFriendsAutoRefreshMs(value, fallback) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return fallback;
  return Math.min(MAX_FRIENDS_POC_AUTO_REFRESH_MS, Math.max(MIN_FRIENDS_POC_AUTO_REFRESH_MS, Math.round(ms)));
}

export function normalizeSettings(input = {}) {
  const defaults = defaultSettings();
  const region = normalizeRegionCode(input.defaultRegion) || defaults.defaultRegion;
  return {
    defaultRegion: region,
    startWithWindows: Boolean(input.startWithWindows ?? defaults.startWithWindows),
    autoUpdate: Boolean(input.autoUpdate ?? defaults.autoUpdate),
    autoAccept: Boolean(input.autoAccept ?? defaults.autoAccept),
    autoAcceptDelayMs: normalizeAcceptDelay(input.autoAcceptDelayMs, defaults.autoAcceptDelayMs),
    autoClientCleanup: Boolean(input.autoClientCleanup ?? defaults.autoClientCleanup),
    syncSettings: Boolean(input.syncSettings ?? defaults.syncSettings),
    friendsPocAggressiveFetching: Boolean(input.friendsPocAggressiveFetching ?? defaults.friendsPocAggressiveFetching),
    friendsPocUseAllAccounts: Boolean(input.friendsPocUseAllAccounts ?? defaults.friendsPocUseAllAccounts),
    friendsPocSelectedAccountIds: Array.isArray(input.friendsPocSelectedAccountIds)
      ? [...new Set(input.friendsPocSelectedAccountIds.map(String).filter(Boolean))]
      : defaults.friendsPocSelectedAccountIds,
    friendsPocSelectionInitialized: Boolean(input.friendsPocSelectionInitialized ?? defaults.friendsPocSelectionInitialized),
    friendsPocFavoriteFriendKeys: Array.isArray(input.friendsPocFavoriteFriendKeys)
      ? [...new Set(input.friendsPocFavoriteFriendKeys.map(String).map((key) => key.trim().toLowerCase()).filter(Boolean))]
      : defaults.friendsPocFavoriteFriendKeys,
    friendsPocAutoRefresh: Boolean(input.friendsPocAutoRefresh ?? defaults.friendsPocAutoRefresh),
    friendsPocAutoRefreshMs: normalizeFriendsAutoRefreshMs(input.friendsPocAutoRefreshMs, defaults.friendsPocAutoRefreshMs),
    queueRelayAllowedPuuids: Array.isArray(input.queueRelayAllowedPuuids)
      ? [...new Set(input.queueRelayAllowedPuuids.map(String).map((value) => value.trim().toLowerCase()).filter(Boolean))]
      : defaults.queueRelayAllowedPuuids,
    leaguePath: String(input.leaguePath || defaults.leaguePath)
  };
}

export function loadSettings() {
  try {
    const text = fs.readFileSync(getSwitcherSettingsPath(), 'utf8');
    return normalizeSettings(JSON.parse(text));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read switcher settings, using defaults: ${error.message}`);
    }
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getSwitcherSettingsPath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}
