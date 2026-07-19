import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePlatformId,
  observerHost,
  platformFromRegionLocale
} from '../src/core/spectator/regions.js';

test('normalizes region and platform names for observer hosts', () => {
  assert.equal(normalizePlatformId('euw'), 'EUW1');
  assert.equal(normalizePlatformId('EUW1'), 'EUW1');
  assert.equal(platformFromRegionLocale({ region: 'NA' }), 'NA1');
  assert.equal(observerHost('eune'), 'spectator.eun1.lol.pvp.net');
});
