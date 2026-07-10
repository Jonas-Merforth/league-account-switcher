import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ClientCleanupMonitor,
  parseLeaguePurchaseDate,
  runClientCleanup
} from '../src/core/clientCleanup.js';
import { LcuClient } from '../src/core/lcu.js';

const EVENT_ENDPOINT = '/lol-event-hub/v1/events';
const PREFS = '/lol-settings/v2/account/LCUPreferences';

function event(eventId, name, subtype, count, eventType = 'kSeasonPass') {
  return {
    eventId,
    eventInfo: {
      eventId,
      eventName: name,
      eventType,
      seasonPassSubType: subtype,
      unclaimedRewardCount: count
    }
  };
}

function createFakeLcu({
  phase = 'None',
  events = [],
  inventory = [],
  preferences = {},
  currentTftSet = 'TFTSet18',
  failures = new Set()
} = {}) {
  const calls = [];
  const state = {
    phase,
    events: structuredClone(events),
    inventory: structuredClone(inventory),
    preferences: structuredClone(preferences),
    currentTftSet
  };

  function check(method, endpoint) {
    calls.push({ method, endpoint });
    if (failures.has(`${method} ${endpoint}`)) throw new Error(`forced ${method} failure`);
  }

  return {
    calls,
    state,
    async get(endpoint) {
      check('GET', endpoint);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return state.phase;
      if (endpoint === EVENT_ENDPOINT) return structuredClone(state.events);
      if (endpoint === '/lol-inventory/v2/inventory/CHAMPION_SKIN') return structuredClone(state.inventory);
      if (endpoint === '/lol-game-data/assets/v1/tftsets.json') {
        return { LCTFTModeData: { mDefaultSet: { SetName: state.currentTftSet } } };
      }
      if (endpoint.startsWith(`${PREFS}/`)) {
        const category = endpoint.slice(PREFS.length + 1);
        return structuredClone(state.preferences[category] ?? { data: null, schemaVersion: 0 });
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post(endpoint, body = {}) {
      check('POST', endpoint);
      const match = endpoint.match(/^\/lol-event-hub\/v1\/events\/([^/]+)\/reward-track\/claim-all$/);
      if (!match) throw new Error(`Unexpected POST ${endpoint}`);
      const eventId = decodeURIComponent(match[1]);
      const selected = state.events.find((entry) => entry.eventId === eventId);
      if (selected) selected.eventInfo.unclaimedRewardCount = 0;
      return body;
    },
    async patch(endpoint, body) {
      check('PATCH', endpoint);
      if (!endpoint.startsWith(`${PREFS}/`)) throw new Error(`Unexpected PATCH ${endpoint}`);
      const category = endpoint.slice(PREFS.length + 1);
      state.preferences[category] = structuredClone(body);
      calls.at(-1).body = structuredClone(body);
      return body;
    }
  };
}

test('parseLeaguePurchaseDate handles League compact timestamps and invalid values', () => {
  assert.equal(parseLeaguePurchaseDate('20260703T201744.000Z'), Date.parse('2026-07-03T20:17:44.000Z'));
  assert.equal(parseLeaguePurchaseDate('2026-07-03T20:17:44Z'), Date.parse('2026-07-03T20:17:44Z'));
  assert.equal(parseLeaguePurchaseDate('not-a-date'), 0);
  assert.equal(parseLeaguePurchaseDate(''), 0);
});

test('cleanup claims League and Mayhem rewards and clears skin/TFT indicators', async () => {
  const now = Date.parse('2026-07-10T01:30:00Z');
  const lcu = createFakeLcu({
    events: [
      event('season-id', 'Season 2: Act II', 'Default', 2),
      event('mayhem-id', 'Mayhem Set 2', 'Mayhem', 1),
      event('tft-id', 'TFT pass', 'TFT', 4),
      event('other-id', 'Other content', 'Default', 5, 'kOther'),
      event('empty-id', 'Empty season', 'Default', 0)
    ],
    inventory: [
      { owned: true, purchaseDate: '20260709T221700.000Z' },
      { owned: false, purchaseDate: '20260710T020000.000Z' }
    ],
    preferences: {
      'lol-skins-viewer': {
        schemaVersion: 2,
        data: { groupingDropdownKey: 'myCollection', sortingDropdownKey: 'acquisitionDate', lastVisitTime: 1 }
      },
      'lol-collection-champions': {
        schemaVersion: 1,
        data: { groupingDropdownKey: 'role', unownedFilter: 'none', lastVisitTime: 1 }
      },
      'lol-tft': {
        schemaVersion: 1,
        data: { TFTContentRetierModalViewed: true, lastTftSetNameSeen: 'TFTSet17' }
      }
    }
  });

  let settled = 0;
  const result = await runClientCleanup(lcu, {
    now: () => now,
    settleAfterClaims: async () => { settled += 1; }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.claimedRewardCount, 3);
  assert.deepEqual(result.claimedEvents.map((entry) => entry.eventName), ['Season 2: Act II', 'Mayhem Set 2']);
  assert.deepEqual(result.cleared, { collectionSkins: true, tftSet: true });
  assert.deepEqual(result.errors, []);
  assert.equal(settled, 1);

  const posts = lcu.calls.filter((call) => call.method === 'POST').map((call) => call.endpoint);
  assert.deepEqual(posts, [
    '/lol-event-hub/v1/events/season-id/reward-track/claim-all',
    '/lol-event-hub/v1/events/mayhem-id/reward-track/claim-all'
  ]);

  assert.deepEqual(lcu.state.preferences['lol-skins-viewer'], {
    schemaVersion: 2,
    data: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      lastVisitTime: now
    }
  });
  assert.deepEqual(lcu.state.preferences['lol-collection-champions'], {
    schemaVersion: 1,
    data: {
      groupingDropdownKey: 'role',
      unownedFilter: 'none',
      lastVisitTime: now
    }
  });
  assert.deepEqual(lcu.state.preferences['lol-tft'], {
    schemaVersion: 1,
    data: {
      TFTContentRetierModalViewed: true,
      lastTftSetNameSeen: 'TFTSet18'
    }
  });
});

test('cleanup is idempotent after the server and preferences reflect the first sweep', async () => {
  const now = Date.parse('2026-07-10T01:30:00Z');
  const lcu = createFakeLcu({
    events: [event('season-id', 'Season', 'Default', 1)],
    inventory: [{ owned: true, purchaseDate: '20260709T221700.000Z' }],
    preferences: {
      'lol-skins-viewer': { schemaVersion: 2, data: { lastVisitTime: 1 } },
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } }
    }
  });
  const options = { now: () => now, settleAfterClaims: async () => {} };

  await runClientCleanup(lcu, options);
  lcu.calls.length = 0;
  const second = await runClientCleanup(lcu, options);

  assert.equal(second.claimedRewardCount, 0);
  assert.deepEqual(second.cleared, { collectionSkins: false, tftSet: false });
  assert.equal(lcu.calls.some((call) => call.method === 'POST' || call.method === 'PATCH'), false);
});

test('cleanup blocks critical game phases before touching notification endpoints', async () => {
  for (const phase of ['ReadyCheck', 'ChampSelect', 'InProgress', 'Reconnect', 'WaitingForStats']) {
    const lcu = createFakeLcu({ phase });
    const result = await runClientCleanup(lcu);
    assert.equal(result.status, 'blocked', phase);
    assert.equal(result.phase, phase);
    assert.deepEqual(lcu.calls, [{ method: 'GET', endpoint: '/lol-gameflow/v1/gameflow-phase' }]);
  }
});

test('cleanup reports an unavailable client when the phase cannot be read', async () => {
  const endpoint = '/lol-gameflow/v1/gameflow-phase';
  const lcu = createFakeLcu({ failures: new Set([`GET ${endpoint}`]) });
  const result = await runClientCleanup(lcu);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.errors, []);
});

test('a failed pass claim does not stop Collection or TFT cleanup', async () => {
  const claimEndpoint = '/lol-event-hub/v1/events/mayhem-id/reward-track/claim-all';
  const lcu = createFakeLcu({
    events: [event('mayhem-id', 'Mayhem', 'Mayhem', 1)],
    inventory: [{ owned: true, purchaseDate: '20260709T221700.000Z' }],
    preferences: {
      'lol-skins-viewer': { schemaVersion: 2, data: null },
      'lol-collection-champions': { schemaVersion: 1, data: null },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } }
    },
    failures: new Set([`POST ${claimEndpoint}`])
  });

  const result = await runClientCleanup(lcu, { now: () => Date.now(), settleAfterClaims: async () => {} });
  assert.equal(result.claimedRewardCount, 0);
  assert.deepEqual(result.cleared, { collectionSkins: true, tftSet: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].area, /Mayhem/);
});

test('cleanup monitor runs manually while disabled and prevents overlapping sweeps', async () => {
  let enabled = false;
  let runs = 0;
  let resolveRun;
  const pending = new Promise((resolve) => { resolveRun = resolve; });
  const monitor = new ClientCleanupMonitor({
    lcu: {},
    getEnabled: () => enabled,
    intervalMs: 60_000,
    runner: async () => {
      runs += 1;
      await pending;
      return { status: 'completed', claimedRewardCount: 0, cleared: {}, errors: [] };
    }
  });

  assert.equal(monitor.kick(), null);
  const first = monitor.runOnce();
  const second = monitor.runOnce();
  assert.equal(first, second);
  assert.equal(runs, 1);
  resolveRun();
  await first;

  enabled = true;
  const automatic = monitor.kick();
  await automatic;
  assert.equal(runs, 2);
  monitor.stop();
});

test('LcuClient.patch delegates to request with PATCH', async () => {
  const client = Object.create(LcuClient.prototype);
  client.request = async (method, endpoint, body) => ({ method, endpoint, body });
  assert.deepEqual(await client.patch('/preference', { enabled: true }), {
    method: 'PATCH',
    endpoint: '/preference',
    body: { enabled: true }
  });
});
