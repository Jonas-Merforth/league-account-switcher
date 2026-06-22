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

  const s = normalizeSettings({ defaultRegion: 'NA1', startWithWindows: 0, leaguePath: 'D:\\LoL' });
  assert.equal(s.defaultRegion, 'na');
  assert.equal(s.startWithWindows, false);
  assert.equal(s.leaguePath, 'D:\\LoL');

  // empty / invalid region falls back to the default
  assert.equal(normalizeSettings({ defaultRegion: '' }).defaultRegion, 'euw');
});
