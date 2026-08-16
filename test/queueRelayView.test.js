import test from 'node:test';
import assert from 'node:assert/strict';

import { queueRelayButtonView } from '../src/renderer/queueRelayView.js';

test('Start via leader only enables for a detected leader whose global relay toggle is on', () => {
  const base = { connected: true, lobby: { inLobby: true, localIsLeader: false }, leader: {} };
  assert.equal(queueRelayButtonView(base).disabled, true);
  assert.match(queueRelayButtonView(base).detail, /not detected/i);
  assert.equal(queueRelayButtonView({ ...base, leader: { detected: true, enabled: false } }).disabled, true);
  assert.match(queueRelayButtonView({ ...base, leader: { detected: true, enabled: false } }).detail, /relay is off/i);
  assert.equal(queueRelayButtonView({ ...base, enabled: false, leader: { detected: true, enabled: true, riotId: 'Friend#EUW' } }).disabled, false);
});

test('Start via leader remains disabled while disconnected, outside lobby, leader, or pending', () => {
  assert.equal(queueRelayButtonView({ connected: false, reason: 'No saved session.' }).disabled, true);
  assert.equal(queueRelayButtonView({ connected: true, lobby: { inLobby: false } }).disabled, true);
  const leaderOn = queueRelayButtonView({ connected: true, enabled: true, lobby: { inLobby: true, localIsLeader: true } });
  const leaderOff = queueRelayButtonView({ connected: true, enabled: false, lobby: { inLobby: true, localIsLeader: true } });
  assert.equal(leaderOn.disabled, true);
  assert.match(leaderOn.detail, /relay is on/i);
  assert.match(leaderOff.detail, /relay is off/i);
  assert.equal(queueRelayButtonView({ requestPending: true }).label, 'Starting…');
});
