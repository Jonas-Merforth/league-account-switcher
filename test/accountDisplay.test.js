import test from 'node:test';
import assert from 'node:assert/strict';

import { accountSubtitle, gameNameOnly } from '../src/renderer/accountDisplay.js';

test('gameNameOnly strips Riot taglines from stored Riot IDs', () => {
  assert.equal(gameNameOnly('Example Player#TEST'), 'Example Player');
  assert.equal(gameNameOnly(' Example Player '), 'Example Player');
  assert.equal(gameNameOnly(''), '');
});

test('accountSubtitle shows game name and Riot username when both are known', () => {
  assert.equal(
    accountSubtitle({ lastSummonerName: 'Example Player#TEST', username: 'example_login' }),
    'Example Player | example_login'
  );
  assert.equal(accountSubtitle({ lastSummonerName: '', username: 'example_login' }), 'example_login');
  assert.equal(accountSubtitle({ lastSummonerName: 'Example Player', username: '' }), 'Example Player');
});
