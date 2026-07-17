import test from 'node:test';
import assert from 'node:assert/strict';

import { RiotClientApi } from '../src/core/riotClient.js';

test('getSignedInName parses the current Riot userInfo wrapper and preserves the tag line', async () => {
  const api = new RiotClientApi();
  api.getUserInfo = async () => ({
    userInfo: JSON.stringify({
      acct: { game_name: 'Same Name', tag_line: 'TWO' },
      username: 'login-name'
    })
  });

  assert.equal(await api.getSignedInName(), 'Same Name#TWO');
});

test('getSignedInName still accepts a direct user-info object', async () => {
  const api = new RiotClientApi();
  api.getUserInfo = async () => ({
    acct: { game_name: 'Direct Name', tag_line: 'EUW' }
  });

  assert.equal(await api.getSignedInName(), 'Direct Name#EUW');
});
