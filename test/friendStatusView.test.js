import test from 'node:test';
import assert from 'node:assert/strict';

import { friendActivityTooltip, friendStateText } from '../src/renderer/friendStatusView.js';

test('friend status text and tooltip share queue, champion, duration, and party details', () => {
  const friend = {
    online: true,
    state: 'dnd',
    activity: {
      kind: 'inGame',
      label: 'In game',
      queueLabel: 'Ranked Flex',
      championName: 'Garen',
      startedAt: '2026-07-12T10:30:00.000Z',
      party: { playingWithNames: ['Friend Two#EUW'] },
      gameStatus: 'inGame'
    }
  };
  const now = Date.parse('2026-07-12T12:00:00.000Z');
  assert.equal(friendStateText(friend, now), 'In game · Ranked Flex · Garen · 1h 30m');
  assert.equal(
    friendActivityTooltip(friend, now),
    'In game\nGame: Ranked Flex\nChampion: Garen\nDuration: 1h 30m\nParty: Friend Two#EUW\nStatus: inGame'
  );
});

test('away friends retain their color label while hover details expose a lobby', () => {
  const friend = {
    online: true,
    state: 'away',
    activity: {
      kind: 'away',
      label: 'Away',
      queueLabel: 'Ranked Solo',
      party: { size: 1, maxSize: 2 },
      gameStatus: 'outOfGame'
    }
  };
  assert.equal(friendStateText(friend), 'Away');
  assert.equal(friendActivityTooltip(friend), 'Away\nLobby: 1/2 Ranked Solo\nStatus: outOfGame');
});
