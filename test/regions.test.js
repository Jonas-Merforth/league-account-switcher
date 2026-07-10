import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGION, REGIONS, normalizeRegionCode, regionLabel } from '../src/core/regions.js';
import { defaultSettings, normalizeSettings } from '../src/core/settings.js';

test('region list is non-empty and includes the default', () => {
  assert.ok(REGIONS.length >= 16);
  assert.ok(REGIONS.some((r) => r.code === DEFAULT_REGION));
  assert.equal(DEFAULT_REGION, 'euw');
});

test('normalizeRegionCode accepts web codes, platform ids, and casing', () => {
  assert.equal(normalizeRegionCode('EUW'), 'euw');
  assert.equal(normalizeRegionCode(' euw1 '), 'euw'); // platform id -> web code
  assert.equal(normalizeRegionCode('NA1'), 'na');
  assert.equal(normalizeRegionCode(''), '');
  assert.equal(normalizeRegionCode(null), '');
  assert.equal(normalizeRegionCode('weird'), 'weird'); // unknown values are preserved
});

test('regionLabel returns a friendly label or a sensible fallback', () => {
  assert.match(regionLabel('euw'), /EUW/);
  assert.equal(regionLabel('weird'), 'WEIRD');
});

test('settings normalize: defaults, region coercion, boolean coercion', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.defaultRegion, 'euw');
  assert.equal(defaults.startWithWindows, true);
  assert.equal(defaults.autoUpdate, true);
  assert.equal(defaults.autoClientCleanup, false);
  assert.equal(defaults.friendsPocAggressiveFetching, false);
  assert.equal(defaults.friendsPocUseAllAccounts, false);
  assert.deepEqual(defaults.friendsPocSelectedAccountIds, []);
  assert.equal(defaults.friendsPocSelectionInitialized, false);
  assert.deepEqual(defaults.friendsPocFavoriteFriendKeys, []);
  assert.equal(defaults.friendsPocAutoRefresh, false);
  assert.equal(defaults.friendsPocAutoRefreshMs, 60_000);

  const s = normalizeSettings({
    defaultRegion: 'NA1',
    startWithWindows: 0,
    autoClientCleanup: 1,
    leaguePath: 'D:\\LoL',
    friendsPocFavoriteFriendKeys: [' puuid:abc ', 'puuid:abc', '', 'riot:name#tag'],
    friendsPocAutoRefresh: 1,
    friendsPocAutoRefreshMs: 1000
  });
  assert.equal(s.defaultRegion, 'na');
  assert.equal(s.startWithWindows, false);
  assert.equal(s.autoClientCleanup, true);
  assert.equal(s.friendsPocAggressiveFetching, false);
  assert.equal(s.friendsPocUseAllAccounts, false);
  assert.deepEqual(s.friendsPocFavoriteFriendKeys, ['puuid:abc', 'riot:name#tag']);
  assert.equal(s.friendsPocAutoRefresh, true);
  assert.equal(s.friendsPocAutoRefreshMs, 15_000);
  assert.equal(s.leaguePath, 'D:\\LoL');

  // empty / invalid region falls back to the default
  assert.equal(normalizeSettings({ defaultRegion: '' }).defaultRegion, 'euw');
  assert.equal(normalizeSettings({ friendsPocAutoRefreshMs: 'nope' }).friendsPocAutoRefreshMs, 60_000);
});
