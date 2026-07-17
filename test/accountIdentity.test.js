import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findAccountByRiotIdentity,
  formatRiotId,
  parseRiotIdentity,
  sameRiotIdentity
} from '../src/core/accountIdentity.js';

test('Riot identity helpers preserve tags and compare legacy names safely', () => {
  assert.equal(formatRiotId(' Same Name ', ' TWO '), 'Same Name#TWO');
  assert.deepEqual(parseRiotIdentity(' Same Name#TWO '), {
    gameName: 'Same Name',
    tagLine: 'TWO',
    normalizedGameName: 'same name',
    normalizedTagLine: 'two'
  });
  assert.equal(sameRiotIdentity('Same Name#TWO', 'same name#two'), true);
  assert.equal(sameRiotIdentity('Same Name#ONE', 'same name#two'), false);
  assert.equal(sameRiotIdentity('Same Name', 'same name#two'), true);
});

test('account identity matching prefers an exact tag and refuses ambiguous legacy names', () => {
  const tagged = [
    { id: 'one', lastSummonerName: 'Same Name#ONE' },
    { id: 'two', lastSummonerName: 'Same Name#TWO' }
  ];
  assert.equal(findAccountByRiotIdentity(tagged, 'same name#two')?.id, 'two');

  assert.equal(findAccountByRiotIdentity([
    { id: 'legacy', lastSummonerName: 'Same Name' },
    { id: 'one', lastSummonerName: 'Same Name#ONE' }
  ], 'Same Name#TWO'), null);

  assert.equal(findAccountByRiotIdentity([
    { id: 'legacy', lastSummonerName: 'Same Name' },
    { id: 'other', lastSummonerName: 'Other Name' }
  ], 'Same Name#TWO')?.id, 'legacy');
});
