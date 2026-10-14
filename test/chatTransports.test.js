import test from 'node:test';
import assert from 'node:assert/strict';
import { LcuChatTransport } from '../src/core/chatTransports.js';

function setup() {
  const calls = [], received = [];
  let conversation = null;
  const resources = { me: { puuid: 'self' }, messages: [] };
  const lcu = {
    async get(endpoint) {
      calls.push(['get', endpoint]);
      if (endpoint.endsWith('/me')) return resources.me;
      if (endpoint.endsWith('/friends')) return [];
      if (endpoint.endsWith('/conversations')) return conversation ? [conversation] : [];
      if (endpoint.endsWith('/messages')) return resources.messages;
      return conversation;
    },
    async post(endpoint, body) {
      calls.push(['post', endpoint, body]);
      if (endpoint.endsWith('/conversations')) { conversation = body; return body; }
      const message = { id: 'accepted', fromPuuid: 'self', timestamp: '2026-10-14T12:00:00Z', ...body };
      resources.messages.push(message);
      return message;
    }
  };
  const transport = new LcuChatTransport({ accountId: 'source', lcu, selfPuuid: 'self', domain: 'eu1.pvp.net', log: () => {}, onMessage: m => received.push(m) });
  return { transport, lcu, calls, resources, received };
}

test('LCU opens the recipient conversation before sending and requires a real response', async () => {
  const { transport, lcu, calls } = setup();
  try {
    const result = await transport.send({ destinationPuuid: 'friend', body: 'Hello' });
    assert.equal(result.id, 'accepted');
    assert.deepEqual(calls.filter(c => c[0] === 'post').map(c => c[2]), [{ id: 'friend@eu1.pvp.net', type: 'chat' }, { type: 'chat', body: 'Hello' }]);
    lcu.post = async () => null;
    await assert.rejects(transport.send({ destinationPuuid: 'friend', body: 'No confirmation' }), /did not confirm/);
  } finally { await transport.close(); }
});

test('account changes block sends before any mutation', async () => {
  const { transport, calls, resources } = setup();
  try {
    await transport.connect();
    resources.me = { puuid: 'another-account' };
    await assert.rejects(transport.send({ destinationPuuid: 'friend', body: 'Must not send' }), /account changed/);
    assert.equal(calls.some(c => c[0] === 'post'), false);
  } finally { await transport.close(); }
});

test('delayed server history stays historical after the initial poll and ignores system events', async () => {
  const { transport, resources, received } = setup();
  try {
    await transport.connect();
    await transport.openConversation({ destinationPuuid: 'friend' });
    await transport._poll();
    resources.messages = [
      { id: 'system', type: 'system', body: 'joined_room', fromPuuid: 'friend' },
      { id: 'history', type: 'chat', body: 'Earlier', fromPuuid: 'friend', timestamp: '2026-07-01T12:00:00Z', isHistorical: true }
    ];
    await transport._poll();
    await transport._poll();
    assert.equal(received.length, 1);
    assert.equal(received[0].historical, true);
  } finally { await transport.close(); }
});

test('closing during a poll prevents late messages and presence callbacks', async () => {
  const { transport, lcu, received } = setup();
  await transport.connect();
  let release;
  lcu.get = () => new Promise(resolve => { release = resolve; });
  const poll = transport._poll();
  await transport.close();
  release([{ puuid: 'friend' }]);
  await poll;
  assert.equal(received.length, 0);
  assert.equal(transport.friends.size, 0);
});
