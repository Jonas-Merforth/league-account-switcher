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

function lockInHarness() {
  const pick = { id: 0, actorCellId: 0, type: 'pick', isInProgress: true, completed: false, championId: 22 };
  const session = {
    localPlayerCellId: 0,
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 30_000, isInfinite: false },
    actions: [[pick]]
  };
  const h = { pick, session, phase: 'ChampSelect', enabled: true, beforeEndMs: 1_000, posts: [] };
  const client = {
    async get(endpoint) {
      assert.equal(endpoint, '/lol-champ-select/v1/session');
      return h.session;
    },
    async post(...args) { h.posts.push(args); }
  };
  h.monitor = new ClientMonitor({
    lcu: {
      async get(endpoint) {
        assert.equal(endpoint, '/lol-gameflow/v1/gameflow-phase');
        return h.phase;
      },
      forCurrentSession: () => client
    },
    log(message) { assert.fail(message); },
    getAutoAccept: () => false,
    getAutoLockIn: () => h.enabled,
    getLockInBeforeEndMs: () => h.beforeEndMs,
    getDesiredOffline: () => false
  });
  return h;
}

test('lock-in follows the latest hover and completes only the local pick in the final second', async () => {
  const h = lockInHarness();
  h.session.actions.unshift([{ ...h.pick, actorCellId: 1, id: 19 }]);
  await h.monitor.tick();
  h.pick.championId = 0; // cleared even though an earlier hover existed
  h.session.timer.adjustedTimeLeftInPhase = 800;
  await h.monitor.tick();
  assert.deepEqual(h.posts, []);

  h.pick.championId = 99;
  await h.monitor.tick();
  h.pick.completed = true;
  await h.monitor.tick();
  assert.deepEqual(h.posts, [['/lol-champ-select/v1/session/actions/0/complete']]);
});

test('lock-in uses the configured window and the timestamp of the timer snapshot', async () => {
  const h = lockInHarness();
  h.beforeEndMs = 5_000;
  h.session.timer.adjustedTimeLeftInPhase = 8_000;
  await h.monitor.tick();
  assert.deepEqual(h.posts, []);
  h.session.timer.internalNowInEpochMs = Date.now() - 4_000;
  await h.monitor.tick();
  assert.equal(h.posts.length, 1);
});

test('a rejected lock-in is retried only while the current hover is eligible', async () => {
  const h = lockInHarness();
  h.session.timer.adjustedTimeLeftInPhase = 900;
  const client = h.monitor.lcu.forCurrentSession();
  const post = client.post;
  client.post = async () => { throw new Error('pick temporarily unavailable'); };
  const warnings = [];
  h.monitor.log = message => warnings.push(message);
  await h.monitor.tick();
  assert.match(warnings[0], /temporarily unavailable/);

  client.post = post;
  h.pick.championId = 0;
  await h.monitor.tick();
  assert.deepEqual(h.posts, []);
  h.pick.championId = 99;
  await h.monitor.tick();
  assert.deepEqual(h.posts, [['/lol-champ-select/v1/session/actions/0/complete']]);
});

test('disabling lock-in during the session read cancels the pending completion', async () => {
  const h = lockInHarness();
  h.session.timer.adjustedTimeLeftInPhase = 100;
  h.monitor.lcu.forCurrentSession().get = async () => {
    h.enabled = false;
    return h.session;
  };
  await h.monitor.tick();
  assert.deepEqual(h.posts, []);
});

test('lock-in skips inactive turns, bans, missing hovers, and unusable clocks', async () => {
  for (const edit of [
    h => { h.phase = 'Lobby'; },
    h => { h.enabled = false; },
    h => { h.session.timer.phase = 'PLANNING'; },
    h => { h.session.timer.phase = 'FINALIZATION'; },
    h => { h.session.timer.isInfinite = true; },
    h => { h.session.timer.adjustedTimeLeftInPhase = null; },
    h => { h.session.timer.adjustedTimeLeftInPhase = -1; },
    h => { h.session.localPlayerCellId = -1; },
    h => { h.pick.actorCellId = 2; },
    h => { h.pick.type = 'ban'; },
    h => { h.pick.isInProgress = false; },
    h => { h.pick.completed = true; },
    h => { h.pick.championId = 0; },
    h => { h.session = null; }
  ]) {
    const h = lockInHarness();
    h.session.timer.adjustedTimeLeftInPhase = 0;
    edit(h);
    await h.monitor.tick();
    assert.deepEqual(h.posts, [], String(edit));
  }
});
