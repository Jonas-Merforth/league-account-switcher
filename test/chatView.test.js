import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatConnectionView,
  chatDestinationLabel,
  chatFriendPresenceView,
  chatPreview,
  chatRoute,
  chatSourceLabel,
  chatSourceOptions
} from '../src/renderer/chatView.js';

test('chatSourceOptions only exposes unique friend source accounts', () => {
  assert.deepEqual(chatSourceOptions({ seenFrom: [
    { accountId: 'main', label: 'Main', jid: 'friend@eu1.pvp.net' },
    { accountId: 'main', label: 'Duplicate' },
    'legacy source',
    { accountId: 'smurf', label: 'Smurf' },
    { label: 'Missing id' }
  ] }), [
    { accountId: 'main', label: 'Main', jid: 'friend@eu1.pvp.net' },
    { accountId: 'smurf', label: 'Smurf', jid: '' }
  ]);
});

test('chat conversation labels keep source and destination visible', () => {
  const conversation = {
    sourceLabel: 'Main',
    destinationRiotId: 'Friendly#EUW',
    messages: [{ incoming: false, body: '  hello\nthere ' }]
  };
  assert.equal(chatRoute(conversation), 'Main → Friendly#EUW');
  assert.equal(chatDestinationLabel(conversation), 'Friendly#EUW');
  assert.equal(chatSourceLabel(conversation), 'Main');
  assert.equal(chatPreview(conversation), 'You: hello there');
});

test('chatConnectionView reports the active lease and errors', () => {
  assert.deepEqual(chatConnectionView({
    connectionState: 'online',
    leaseExpiresAt: '2026-07-12T12:02:05.000Z'
  }, Date.parse('2026-07-12T12:00:00.000Z')), {
    tone: 'online', text: 'Source online for 2m 5s'
  });
  assert.deepEqual(chatConnectionView({ connectionState: 'error', connectionError: 'Session expired.' }), {
    tone: 'error', text: 'Session expired.'
  });
});

test('chatFriendPresenceView matches friend-list colors and exposes activity details', () => {
  const view = chatFriendPresenceView({
    friendOnline: true,
    friendState: 'dnd',
    friendActivity: {
      kind: 'inGame',
      label: 'In game',
      queueLabel: 'Ranked Solo',
      championName: 'Ahri',
      startedAt: '2026-07-12T11:50:00.000Z',
      gameStatus: 'inGame',
      spectatable: true
    }
  }, Date.parse('2026-07-12T12:00:00.000Z'));

  assert.deepEqual(view, {
    tone: 'ingame',
    text: 'In game · Ranked Solo · Ahri · 10m',
    tooltip: 'In game\nGame: Ranked Solo\nChampion: Ahri\nDuration: 10m\nSpectatable\nStatus: inGame'
  });
});
