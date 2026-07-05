import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchCurrentSummonerIdentity, parseSummonerIdentity } from '../src/core/summonerIdentity.js';

test('parseSummonerIdentity keeps the League game name and optional tag', () => {
  assert.deepEqual(
    parseSummonerIdentity({ gameName: ' Acoustic Weapon ', tagLine: ' REE ' }),
    { gameName: 'Acoustic Weapon', tagLine: 'REE' }
  );
  assert.deepEqual(
    parseSummonerIdentity({ game_name: 'Hide on bush', tag_line: 'KR1' }),
    { gameName: 'Hide on bush', tagLine: 'KR1' }
  );
  assert.equal(parseSummonerIdentity({ gameName: '   ' }), null);
});

test('fetchCurrentSummonerIdentity reads the current-summoner LCU endpoint', async () => {
  const calls = [];
  const identity = await fetchCurrentSummonerIdentity({
    get: async (endpoint) => {
      calls.push(endpoint);
      return { gameName: 'Acoustic Weapon', tagLine: 'REE' };
    }
  });
  assert.deepEqual(calls, ['/lol-summoner/v1/current-summoner']);
  assert.equal(identity.gameName, 'Acoustic Weapon');
});
