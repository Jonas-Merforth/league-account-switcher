import test from 'node:test';
import assert from 'node:assert/strict';

import { QueueRelayService } from '../src/core/queueRelay.js';
import { parseRelayIq } from '../src/core/queueRelayProtocol.js';

const sender = 'sender-puuid';
const leader = 'leader-puuid';

function lobbyPayload() {
  return {
    partyId: 'party-1',
    canStartActivity: true,
    gameConfig: { queueId: 430 },
    localMember: { puuid: leader, isLeader: true, ready: true },
    members: [
      { puuid: leader, isLeader: true, ready: true },
      { puuid: sender, isLeader: false, ready: true }
    ],
    restrictions: []
  };
}

function incomingIq(overrides = {}) {
  const now = Date.now();
  return {
    id: 'iq-1',
    from: `${sender}@eu1.pvp.net/tool-resource`,
    fromPuuid: sender,
    type: 'set',
    kind: 'queue-start',
    payload: {
      requestId: 'request-1',
      partyId: 'party-1',
      senderPuuid: sender,
      createdAt: new Date(now - 100).toISOString(),
      expiresAt: new Date(now + 5_000).toISOString(),
      ...overrides
    }
  };
}

function serviceHarness({ allowed = true } = {}) {
  const posts = [];
  const sent = [];
  const logs = [];
  const events = [];
  const lcu = {
    async get(endpoint) {
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'Lobby';
      if (endpoint === '/lol-lobby/v2/lobby') return lobbyPayload();
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post(endpoint, body) {
      posts.push({ endpoint, body });
      return null;
    }
  };
  const service = new QueueRelayService({
    lcu,
    log: (message, level) => logs.push({ message, level }),
    getActiveAccount: () => null,
    getAllowedPuuids: () => allowed ? [sender] : [],
    onEvent: (event) => events.push(event)
  });
  service.connection = { send: async (stanza) => sent.push(stanza), close() {} };
  service.connectionState = 'connected';
  return { service, posts, sent, logs, events };
}

test('leader accepts an opted-in same-lobby request, starts LCU, and returns an IQ result', async () => {
  const harness = serviceHarness();
  await harness.service._handleIncomingQueueStart(incomingIq());
  assert.deepEqual(harness.posts, [{ endpoint: '/lol-lobby/v2/lobby/matchmaking/search', body: undefined }]);
  assert.equal(harness.sent.length, 1);
  const response = parseRelayIq(harness.sent[0]);
  assert.equal(response.kind, 'queue-start-result');
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.code, 'started');
  assert.equal(harness.events[0].type, 'queue-started-local');
  assert.ok(harness.logs.some((entry) => /validation.*ok=true/.test(entry.message)));
});

test('leader rejects a request without per-friend permission and never calls LCU', async () => {
  const harness = serviceHarness({ allowed: false });
  await harness.service._handleIncomingQueueStart(incomingIq());
  assert.equal(harness.posts.length, 0);
  const response = parseRelayIq(harness.sent[0]);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.code, 'not-allowed');
});

test('status only exposes a leader as detected after a fresh capability response', () => {
  const harness = serviceHarness();
  harness.service.lobby = {
    inLobby: true, phase: 'Lobby', localPuuid: sender, localIsLeader: false,
    leaderPuuid: leader, partyId: 'party-1', queueId: 430, canStartActivity: true,
    members: [{ puuid: sender, isLeader: false }, { puuid: leader, isLeader: true, riotId: 'Leader#EUW' }],
    restrictions: []
  };
  harness.service.resources.set(leader, new Map([['leader@eu1.pvp.net/tool', {
    jid: 'leader@eu1.pvp.net/tool', puuid: leader, seenAt: Date.now(), capabilityAt: Date.now(), remoteAllowed: true
  }]]));
  const status = harness.service.getStatus();
  assert.equal(status.leader.detected, true);
  assert.equal(status.leader.allowed, true);
  assert.equal(status.leader.riotId, 'Leader#EUW');
});

test('keepalive sends at most once per interval', async () => {
  const harness = serviceHarness();
  harness.service.lastKeepaliveAt = 0;

  await harness.service._keepAlive();
  await harness.service._keepAlive();

  assert.deepEqual(harness.sent, [' ']);
});

test('background tick failures are logged instead of rejecting', async () => {
  const harness = serviceHarness();
  harness.service.stopped = false;
  harness.service.getActiveAccount = async () => {
    throw new Error('test tick failure');
  };

  await assert.doesNotReject(() => harness.service.tick());
  assert.equal(harness.service.reason, 'Queue relay update failed: test tick failure');
  assert.ok(harness.logs.some((entry) => /service tick failed \(test tick failure\)/.test(entry.message)));
});
