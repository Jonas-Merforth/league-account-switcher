import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatService } from '../src/core/chatService.js';

function setup() {
  const events = [];
  const changes = [];
  const transports = new Map();
  const account = { id: 'source-1', label: 'Source One' };
  const service = new ChatService({
    getAccount: (id) => id === account.id ? account : null,
    createTransport: async ({ account: source, onMessage, onPresence, onClose }) => {
      const transport = {
        connected: false,
        sent: [],
        async connect() { this.connected = true; return { kind: 'fake' }; },
        async send(payload) { this.sent.push(payload); return { id: `sent-${this.sent.length}`, sentAt: '2026-07-12T12:00:00.000Z' }; },
        async close() { this.connected = false; },
        receive(message) { onMessage(message); },
        presence(presence) { onPresence(presence); },
        fail(error) { onClose(error); }
      };
      transports.set(source.id, transport);
      return transport;
    },
    onEvent: (event) => events.push(event),
    onChanged: (state, reason) => changes.push({ state, reason }),
    now: () => Date.parse('2026-07-12T12:00:00.000Z')
  });
  return { service, events, changes, transports };
}

test('opening a source-to-friend chat connects the source and sending resets its draft', async () => {
  const { service, transports } = setup();
  await service.openConversation({
    sourceAccountId: 'source-1',
    friend: { puuid: 'friend-1', jid: 'friend-1@eu1.pvp.net', riotId: 'Friend#EUW', online: true }
  });
  const key = 'source-1:friend-1';
  service.setDraft(key, 'hello');
  const state = await service.sendMessage(key, 'hello');
  const conversation = state.conversations[0];
  assert.equal(conversation.sourceLabel, 'Source One');
  assert.equal(conversation.destinationRiotId, 'Friend#EUW');
  assert.equal(conversation.connectionState, 'online');
  assert.equal(conversation.draft, '');
  assert.equal(conversation.messages[0].body, 'hello');
  assert.equal(transports.get('source-1').sent[0].destinationJid, 'friend-1@eu1.pvp.net');
  await service.stop();
});

test('an incoming message from another friend auto-creates a chat and increments the tab unread count', async () => {
  const { service, events, transports } = setup();
  await service.openConversation({ sourceAccountId: 'source-1', friend: { puuid: 'friend-1', riotId: 'Friend One#EUW' } });
  service.setViewActive(false);
  transports.get('source-1').receive({
    id: 'incoming-1',
    fromPuuid: 'friend-2',
    from: 'friend-2@eu1.pvp.net/device',
    body: 'Are you there?',
    receivedAt: '2026-07-12T12:01:00.000Z',
    incoming: true,
    friend: { puuid: 'friend-2', jid: 'friend-2@eu1.pvp.net', riotId: 'Friend Two#EUW' }
  });
  const state = service.snapshot();
  assert.equal(state.unreadCount, 1);
  assert.equal(state.conversations[0].key, 'source-1:friend-2');
  assert.equal(state.conversations[0].destinationRiotId, 'Friend Two#EUW');
  assert.equal(events.some((event) => event.type === 'message' && event.conversationKey === 'source-1:friend-2'), true);
  await service.stop();
});

test('a new reply reopens a closed chat while its source connection is leased', async () => {
  const { service, transports } = setup();
  await service.openConversation({
    sourceAccountId: 'source-1',
    friend: { puuid: 'friend-1', riotId: 'Friend One#EUW' }
  });
  service.closeConversation('source-1:friend-1');
  assert.equal(service.snapshot().conversations.length, 0);

  transports.get('source-1').receive({
    id: 'reply-after-close',
    fromPuuid: 'friend-1',
    body: 'Still there?',
    receivedAt: '2026-07-12T12:01:00.000Z',
    incoming: true
  });

  const state = service.snapshot();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].open, true);
  assert.equal(state.conversations[0].unreadCount, 1);
  assert.equal(state.conversations[0].messages.at(-1).body, 'Still there?');
  await service.stop();
});

test('the visible active conversation consumes incoming messages as read and tracks friend presence', async () => {
  const { service, transports } = setup();
  await service.openConversation({ sourceAccountId: 'source-1', friend: { puuid: 'friend-1', riotId: 'Friend#EUW' } });
  service.setViewActive(true);
  const transport = transports.get('source-1');
  transport.receive({ id: 'incoming-1', fromPuuid: 'friend-1', body: 'Hi', receivedAt: '2026-07-12T12:01:00.000Z' });
  transport.presence({ puuid: 'friend-1', online: false });
  const conversation = service.snapshot().conversations[0];
  assert.equal(conversation.unreadCount, 0);
  assert.equal(conversation.friendOnline, false);
  await service.stop();
});

test('changing the online timeout refreshes connected source leases', async () => {
  const { service, changes } = setup();
  await service.openConversation({ sourceAccountId: 'source-1', friend: { puuid: 'friend-1', riotId: 'Friend#EUW' } });
  const state = service.refreshActiveLeases();
  assert.equal(state.conversations[0].leaseExpiresAt, '2026-07-12T12:03:00.000Z');
  assert.equal(changes.at(-1).reason, 'lease-setting-changed');
  await service.stop();
});

test('hydrated encrypted-state shape restores conversations without claiming a live connection', () => {
  const { service } = setup();
  service.hydrate({
    activeKey: 'source-1:friend-1',
    conversations: [{
      sourceAccountId: 'source-1', destinationPuuid: 'friend-1', destinationRiotId: 'Friend#EUW',
      unreadCount: 2, open: true, messages: [{ id: 'old', body: 'Earlier', incoming: true }]
    }]
  });
  const state = service.snapshot();
  assert.equal(state.activeKey, 'source-1:friend-1');
  assert.equal(state.unreadCount, 2);
  assert.equal(state.conversations[0].connectionState, 'offline');
});
