import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrentClientSummary,
  chatPresenceView,
  gameflowStatusView
} from '../src/core/currentClientSummary.js';

test('current client summary distinguishes closed, signed-out, and Riot-only states', () => {
  assert.equal(buildCurrentClientSummary().statusLabel, 'All clients closed');
  assert.equal(buildCurrentClientSummary({ riotRunning: true, riotAuthType: 'needs_authentication' }).kind, 'signed-out');
  const riotOnly = buildCurrentClientSummary({
    riotRunning: true,
    riotAuthType: 'authorized',
    accountId: 'account-a',
    liveName: 'Player'
  });
  assert.equal(riotOnly.kind, 'riot-only');
  assert.equal(riotOnly.accountId, 'account-a');
  assert.match(riotOnly.detail, /League closed/);
});

test('current client summary exposes presence while idle and gameflow while active', () => {
  const away = buildCurrentClientSummary({
    riotRunning: true, riotAuthType: 'authorized', leagueRunning: true,
    leaguePhase: 'None', chatAvailability: 'away'
  });
  assert.equal(away.statusLabel, 'Away');
  assert.equal(away.tone, 'away');

  const queue = buildCurrentClientSummary({
    riotRunning: true, riotAuthType: 'authorized', leagueRunning: true,
    leaguePhase: 'Matchmaking', chatAvailability: 'offline'
  });
  assert.equal(queue.statusLabel, 'In queue');
  assert.equal(queue.presenceLabel, 'Appearing offline');
  assert.equal(queue.tone, 'online');
});

test('switching state wins over stale live-client observations', () => {
  const view = buildCurrentClientSummary({
    switchStatus: { busy: true, id: 'target', label: 'Target', message: 'Closing League…' },
    riotRunning: true,
    riotAuthType: 'authorized',
    leagueRunning: true,
    leaguePhase: 'InProgress'
  });
  assert.equal(view.kind, 'switching');
  assert.equal(view.accountId, 'target');
  assert.equal(view.detail, 'Closing League…');
});

test('presence and gameflow helpers cover offline and active states', () => {
  assert.deepEqual(chatPresenceView('offline'), { label: 'Appearing offline', tone: 'offline' });
  assert.deepEqual(gameflowStatusView('ChampSelect', 'chat'), { label: 'Champ select', tone: 'ingame' });
  assert.equal(gameflowStatusView('CustomPhase', 'chat').label, 'Custom Phase');
});
