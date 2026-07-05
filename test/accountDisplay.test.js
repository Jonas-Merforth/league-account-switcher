import test from 'node:test';
import assert from 'node:assert/strict';

import { accountSubtitle, gameNameOnly } from '../src/renderer/accountDisplay.js';

test('gameNameOnly strips Riot taglines from stored Riot IDs', () => {
  assert.equal(gameNameOnly('Acoustic Weapon#REE'), 'Acoustic Weapon');
  assert.equal(gameNameOnly(' Acoustic Weapon '), 'Acoustic Weapon');
  assert.equal(gameNameOnly(''), '');
});

test('accountSubtitle shows game name and Riot username when both are known', () => {
  assert.equal(
    accountSubtitle({ lastSummonerName: 'Acoustic Weapon#REE', username: 'y2357780' }),
    'Acoustic Weapon | y2357780'
  );
  assert.equal(accountSubtitle({ lastSummonerName: '', username: 'y2357780' }), 'y2357780');
  assert.equal(accountSubtitle({ lastSummonerName: 'Acoustic Weapon', username: '' }), 'Acoustic Weapon');
});
