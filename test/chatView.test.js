import test from 'node:test';
import assert from 'node:assert/strict';

import { chatConnectionView, chatPreview, chatRoute, chatSourceOptions } from '../src/renderer/chatView.js';

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
