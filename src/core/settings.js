import fs from 'node:fs';
import { getConfigDir, getSwitcherSettingsPath } from './config.js';
import { DEFAULT_LEAGUE_PATH } from './constants.js';
import { DEFAULT_REGION, normalizeRegionCode } from './regions.js';

// Slim settings for the standalone switcher, stored in switcher-settings.json (separate from the
// automation app's settings.json, but in the same shared config dir).

export function defaultSettings() {
  return {
    defaultRegion: DEFAULT_REGION,
    startWithWindows: true,
    leaguePath: DEFAULT_LEAGUE_PATH
  };
}

export function normalizeSettings(input = {}) {
  const defaults = defaultSettings();
  const region = normalizeRegionCode(input.defaultRegion) || defaults.defaultRegion;
  return {
    defaultRegion: region,
    startWithWindows: Boolean(input.startWithWindows ?? defaults.startWithWindows),
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
