import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCapabilityProbe,
  buildCapabilityResponse,
  buildQueueStartRequest,
  buildQueueStartResponse,
  extractXmppStanzas,
  parsePresenceResource,
  parseRelayIq,
  summarizeQueueRelayLobby,
  validateQueueStartRequest
} from '../src/core/queueRelayProtocol.js';

const sender = 'sender-puuid';
const leader = 'leader-puuid';
const resource = `${leader}@eu1.pvp.net/league-account-switcher-beta`;

test('capability IQ has no chat body and round-trips tool permission', () => {
  const probe = buildCapabilityProbe({ id: 'cap-1', to: resource });
  assert.doesNotMatch(probe, /<body/i);
  assert.deepEqual(parseRelayIq(probe), {
    id: 'cap-1', from: '', to: resource, type: 'get', fromPuuid: '', kind: 'capability',
    payload: {
      version: 1, instanceId: '', allowed: false, requestId: '', partyId: '', senderPuuid: '',
      createdAt: '', expiresAt: '', ok: false, code: '', message: ''
    }
  });

  const response = buildCapabilityResponse({ id: 'cap-1', to: `${sender}@eu1.pvp.net/tool`, instanceId: 'instance-1', allowed: true })
    .replace('<iq ', `<iq from="${resource}" `);
  const parsed = parseRelayIq(response);
  assert.equal(parsed.kind, 'capability');
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.fromPuuid, leader);
  assert.equal(parsed.payload.allowed, true);
  assert.equal(parsed.payload.instanceId, 'instance-1');
});

test('queue-start IQ round-trips party identity, timing, and result without a chat body', () => {
  const request = buildQueueStartRequest({
    id: 'start-1', to: resource, requestId: 'request-1', partyId: 'party-1', senderPuuid: sender,
    createdAt: '2026-07-11T12:00:00.000Z', expiresAt: '2026-07-11T12:00:10.000Z'
  });
  assert.doesNotMatch(request, /<body/i);
  const parsed = parseRelayIq(request.replace('<iq ', `<iq from="${sender}@eu1.pvp.net/tool" `));
  assert.equal(parsed.kind, 'queue-start');
  assert.equal(parsed.payload.partyId, 'party-1');
  assert.equal(parsed.payload.senderPuuid, sender);

  const response = buildQueueStartResponse({
    id: 'start-1', to: `${sender}@eu1.pvp.net/tool`, requestId: 'request-1', ok: false,
    code: 'not-allowed', message: 'Friend not allowed'
  });
  const result = parseRelayIq(response);
  assert.equal(result.kind, 'queue-start-result');
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.code, 'not-allowed');
});

test('stream extraction retains split stanzas and handles self-closing presence', () => {
  const first = extractXmppStanzas('noise<presence from="a@b/tool"/><iq from="a@b/tool" id="1" type="result"><queue-relay');
  assert.equal(first.stanzas.length, 1);
  assert.equal(parsePresenceResource(first.stanzas[0]).resource, 'tool');
  const second = extractXmppStanzas(`${first.remainder} xmlns="urn:league-account-switcher:queue-relay:1" version="1" allowed="true"/></iq>`);
  assert.equal(second.stanzas.length, 1);
  assert.equal(parseRelayIq(second.stanzas[0]).kind, 'capability');
  assert.equal(second.remainder, '');
});

test('lobby summary identifies local member, leader, party, queue, and readiness', () => {
  const summary = summarizeQueueRelayLobby('Lobby', {
    partyId: 'party-1', canStartActivity: true, gameConfig: { queueId: 420 },
    localMember: { puuid: sender, isLeader: false, ready: true },
    members: [
      { puuid: leader, isLeader: true, gameName: 'Leader', tagLine: 'EUW' },
      { puuid: sender, isLeader: false, ready: true }
    ],
    restrictions: []
  });
  assert.equal(summary.inLobby, true);
  assert.equal(summary.localIsLeader, false);
  assert.equal(summary.leaderPuuid, leader);
  assert.equal(summary.queueId, 420);
  assert.equal(summary.members.find((member) => member.isLeader).riotId, 'Leader#EUW');
});

test('queue-start validation requires opt-in, fresh timing, leadership, and same party membership', () => {
  const now = Date.parse('2026-07-11T12:00:05.000Z');
  const request = {
    requestId: 'request-1', partyId: 'party-1', senderPuuid: sender,
    createdAt: '2026-07-11T12:00:00.000Z', expiresAt: '2026-07-11T12:00:10.000Z'
  };
  const lobby = {
    inLobby: true, phase: 'Lobby', localIsLeader: true, partyId: 'party-1', queueId: 420,
    canStartActivity: true, restrictions: [], members: [{ puuid: sender }, { puuid: leader }]
  };
  assert.deepEqual(validateQueueStartRequest({ request, fromPuuid: sender, lobby, allowedPuuids: [sender], now }), {
    ok: true, code: 'accepted', message: 'Queue start request accepted.'
  });
  assert.equal(validateQueueStartRequest({ request, fromPuuid: sender, lobby, allowedPuuids: [], now }).code, 'not-allowed');
  assert.equal(validateQueueStartRequest({ request, fromPuuid: sender, lobby: { ...lobby, localIsLeader: false }, allowedPuuids: [sender], now }).code, 'not-leader');
  assert.equal(validateQueueStartRequest({ request: { ...request, partyId: 'other' }, fromPuuid: sender, lobby, allowedPuuids: [sender], now }).code, 'party-mismatch');
  assert.equal(validateQueueStartRequest({ request, fromPuuid: sender, lobby: { ...lobby, members: [{ puuid: leader }] }, allowedPuuids: [sender], now }).code, 'sender-not-in-party');
  assert.equal(validateQueueStartRequest({ request, fromPuuid: sender, lobby, allowedPuuids: [sender], now: now + 20_000 }).code, 'expired');
});
