import test from 'node:test';
import assert from 'node:assert/strict';

import { queueRelayButtonView } from '../src/renderer/queueRelayView.js';

test('Start via leader only enables for a detected leader that allowed the requester', () => {
  const base = { connected: true, lobby: { inLobby: true, localIsLeader: false }, leader: {} };
  assert.equal(queueRelayButtonView(base).disabled, true);
  assert.match(queueRelayButtonView(base).detail, /not detected/i);
  assert.equal(queueRelayButtonView({ ...base, leader: { detected: true, allowed: false } }).disabled, true);
  assert.match(queueRelayButtonView({ ...base, leader: { detected: true, allowed: false } }).detail, /must allow/i);
  assert.equal(queueRelayButtonView({ ...base, leader: { detected: true, allowed: true, riotId: 'Friend#EUW' } }).disabled, false);
});

test('Start via leader remains disabled while disconnected, outside lobby, leader, or pending', () => {
  assert.equal(queueRelayButtonView({ connected: false, reason: 'No saved session.' }).disabled, true);
  assert.equal(queueRelayButtonView({ connected: true, lobby: { inLobby: false } }).disabled, true);
  assert.equal(queueRelayButtonView({ connected: true, lobby: { inLobby: true, localIsLeader: true } }).disabled, true);
  assert.equal(queueRelayButtonView({ requestPending: true }).label, 'Starting…');
});
