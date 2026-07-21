import test from 'node:test';
import assert from 'node:assert/strict';

import { ClientMonitor } from '../src/core/clientMonitor.js';

function monitorHarness({ delayMs = 0 } = {}) {
  const posts = [];
  const logs = [];
  let acceptedEvents = 0;
  let dodgeEvents = 0;
  let readyCheck = { state: 'InProgress', playerResponse: 'None' };
  const monitor = new ClientMonitor({
    lcu: {
      async get(endpoint) {
        if (endpoint === '/lol-matchmaking/v1/ready-check') return readyCheck;
        throw new Error(`Unexpected GET ${endpoint}`);
      },
      async post(endpoint) {
        posts.push(endpoint);
      }
    },
    log: (message, level) => logs.push({ message, level }),
    getAutoAccept: () => true,
    getAcceptDelayMs: () => delayMs,
    getSoundNotifications: () => true,
    getDesiredOffline: () => false,
    onAutoAccepted: () => { acceptedEvents += 1; },
    onQueueDodged: () => { dodgeEvents += 1; }
  });
  return {
    monitor,
    posts,
    logs,
    acceptedEvents: () => acceptedEvents,
    dodgeEvents: () => dodgeEvents,
    setReadyCheck(value) { readyCheck = value; }
  };
}

test('auto-accept accepts an explicitly unanswered ready check', async () => {
  const harness = monitorHarness();

  await harness.monitor._handleReadyCheck('ReadyCheck');

  assert.deepEqual(harness.posts, ['/lol-matchmaking/v1/ready-check/accept']);
  assert.equal(harness.acceptedEvents(), 1);
});

test('manual decline cancels a delayed auto-accept for the rest of that ready check', async () => {
  const harness = monitorHarness({ delayMs: 2_000 });
  await harness.monitor._handleReadyCheck('ReadyCheck');
  assert.notEqual(harness.monitor.acceptDueAt, null);

  harness.setReadyCheck({ state: 'InProgress', playerResponse: 'Declined' });
  await harness.monitor._handleReadyCheck('ReadyCheck');

  assert.deepEqual(harness.posts, []);
  assert.equal(harness.monitor.acceptDueAt, null);
  assert.equal(harness.monitor.readyCheckCanceled, true);
  assert.ok(harness.logs.some((entry) => /manual decline detected/.test(entry.message)));

  harness.setReadyCheck(null);
  await harness.monitor._handleReadyCheck('ReadyCheck');
  harness.setReadyCheck({ state: 'InProgress', playerResponse: 'None' });
  await harness.monitor._handleReadyCheck('ReadyCheck');
  assert.deepEqual(harness.posts, []);

  await harness.monitor._handleReadyCheck('Matchmaking');
  assert.equal(harness.monitor.readyCheckCanceled, false);
});

test('missing or unknown player responses are never auto-accepted', async () => {
  const harness = monitorHarness();

  harness.setReadyCheck({ state: 'InProgress' });
  await harness.monitor._handleReadyCheck('ReadyCheck');
  harness.setReadyCheck({ state: 'InProgress', playerResponse: 'Unexpected' });
  await harness.monitor._handleReadyCheck('ReadyCheck');

  assert.deepEqual(harness.posts, []);
});

test('champ select returning to a pre-game phase reports one dodge', () => {
  for (const returnPhase of ['Lobby', 'Matchmaking', 'ReadyCheck']) {
    const harness = monitorHarness();

    harness.monitor._observeDodgePhase('ChampSelect');
    harness.monitor._observeDodgePhase(returnPhase);
    harness.monitor._observeDodgePhase(returnPhase);

    assert.equal(harness.dodgeEvents(), 1, returnPhase);
    assert.ok(harness.logs.some((entry) => /detected a dodge/.test(entry.message)), returnPhase);
  }
});

test('champ select starting a game does not report a dodge later', () => {
  const harness = monitorHarness();

  harness.monitor._observeDodgePhase('ChampSelect');
  harness.monitor._observeDodgePhase('GameStart');
  harness.monitor._observeDodgePhase('Lobby');

  assert.equal(harness.dodgeEvents(), 0);
});

test('dodge watching runs when sound notifications are the only enabled feature', async () => {
  const phases = ['ChampSelect', 'Matchmaking'];
  let dodgeEvents = 0;
  const monitor = new ClientMonitor({
    lcu: { get: async () => phases.shift() },
    getAutoAccept: () => false,
    getAcceptDelayMs: () => 0,
    getSoundNotifications: () => true,
    getDesiredOffline: () => false,
    onQueueDodged: () => { dodgeEvents += 1; }
  });

  await monitor.tick();
  await monitor.tick();

  assert.equal(dodgeEvents, 1);
});
