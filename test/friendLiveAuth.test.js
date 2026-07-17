import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveFriendAuthOverride } from '../src/core/friendLiveAuth.js';

function credentials(gameName, tagLine) {
  return {
    auth: { accessToken: `${gameName}-token` },
    identity: { gameName, tagLine }
  };
}

test('live Friends auth rejects a forced retry after the signed-in identity changes', async () => {
  const responses = [credentials('Account A', 'ONE'), credentials('Account B', 'TWO')];
  const override = await createLiveFriendAuthOverride(
    { id: 'account-a', label: 'Account A', lastSummonerName: 'Account A#ONE' },
    { getCredentials: async () => responses.shift() }
  );

  await assert.rejects(
    () => override.refresh(),
    /identity changed/i
  );
});

test('live Friends auth permits a forced retry for the same full Riot identity', async () => {
  const responses = [credentials('Account A', 'ONE'), credentials('account a', 'one')];
  const override = await createLiveFriendAuthOverride(
    { id: 'account-a', label: 'Account A', lastSummonerName: 'Account A#ONE' },
    { getCredentials: async () => responses.shift() }
  );

  assert.deepEqual(await override.refresh(), { accessToken: 'account a-token' });
});
