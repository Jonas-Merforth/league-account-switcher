import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ClientCleanupMonitor,
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
  preferences = {},
  currentTftSet = 'TFTSet18',
  tftHome = {
    enabled: true,
    battlePassOfferIds: ['battle-pass-offer'],
    storePromoOfferIds: ['store-offer'],
    tacticianPromoOfferIds: ['tactician-offer']
  },
  playerNotifications = [],
  profileInventoryNotifications = {},
  latestLevelUp = null,
  failures = new Set()
} = {}) {
  const calls = [];
  const state = {
    phase,
    events: structuredClone(events),
    preferences: structuredClone(preferences),
    currentTftSet,
    tftHome: structuredClone(tftHome),
    playerNotifications: structuredClone(playerNotifications),
    profileInventoryNotifications: structuredClone(profileInventoryNotifications),
    latestLevelUp
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
      if (endpoint === '/lol-game-data/assets/v1/tftsets.json') {
        return { LCTFTModeData: { mDefaultSet: { SetCoreName: state.currentTftSet } } };
      }
      if (endpoint === '/lol-tft/v1/tft/homeHub') return structuredClone(state.tftHome);
      if (endpoint === '/player-notifications/v1/notifications') {
        return structuredClone(state.playerNotifications);
      }
      if (endpoint === '/lol-challenges/v1/latest-challenge-level-up') return state.latestLevelUp;
      const inventoryMatch = endpoint.match(/^\/lol-inventory\/v1\/notifications\/([^/]+)$/);
      if (inventoryMatch) {
        return structuredClone(state.profileInventoryNotifications[inventoryMatch[1]] ?? []);
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
      if (match) {
        const eventId = decodeURIComponent(match[1]);
        const selected = state.events.find((entry) => entry.eventId === eventId);
        if (selected) selected.eventInfo.unclaimedRewardCount = 0;
      } else if (endpoint === '/lol-inventory/v1/notification/acknowledge') {
        for (const notifications of Object.values(state.profileInventoryNotifications)) {
          const notification = notifications.find((entry) => entry.id === body);
          if (notification) notification.acknowledged = true;
        }
      } else {
        throw new Error(`Unexpected POST ${endpoint}`);
      }
      return body;
    },
    async patch(endpoint, body) {
      check('PATCH', endpoint);
      if (!endpoint.startsWith(`${PREFS}/`)) throw new Error(`Unexpected PATCH ${endpoint}`);
      const category = endpoint.slice(PREFS.length + 1);
      state.preferences[category] = structuredClone(body);
      calls.at(-1).body = structuredClone(body);
      return body;
    },
    async delete(endpoint) {
      check('DELETE', endpoint);
      const match = endpoint.match(/^\/player-notifications\/v1\/notifications\/([^/]+)$/);
      if (!match) throw new Error(`Unexpected DELETE ${endpoint}`);
      const id = decodeURIComponent(match[1]);
      state.playerNotifications = state.playerNotifications.filter((entry) => String(entry.id) !== id);
    }
  };
}

test('cleanup claims supported passes and clears the home-header indicators', async () => {
  const now = Date.parse('2026-07-10T01:30:00Z');
  const lcu = createFakeLcu({
    events: [
      event('season-id', 'Season 2: Act II', 'Default', 2),
      event('mayhem-id', 'Mayhem Set 2', 'Mayhem', 1),
      event('tft-id', 'TFT pass', 'TFT', 4),
      event('other-id', 'Other content', 'Default', 5, 'kOther'),
      event('empty-id', 'Empty season', 'Default', 0)
    ],
    preferences: {
      'lol-collection-champions': {
        schemaVersion: 1,
        data: { groupingDropdownKey: 'role', unownedFilter: 'none', lastVisitTime: 1 }
      },
      'lol-tft': {
        schemaVersion: 1,
        data: { TFTContentRetierModalViewed: true, lastTftSetNameSeen: 'TFTSet17' }
      },
      'lol-customizer-tokens': {
        schemaVersion: 1,
        data: { lastVisitTime: 1 }
      },
      'lol-challenges-latest-level-up': {
        schemaVersion: 1,
        data: { lastLevelUpTime: now - 1000 }
      }
    },
    profileInventoryNotifications: {
      SUMMONER_ICON: [{ id: 41, itemId: 9001, type: 'CREATE', acknowledged: false }]
    },
    playerNotifications: [
      { id: 7, source: 'esports', state: 'unread', dismissible: true, critical: false },
      { id: 8, source: 'warning', state: 'unread', dismissible: true, critical: true }
    ]
  });

  let settled = 0;
  const result = await runClientCleanup(lcu, {
    now: () => now,
    settleAfterClaims: async () => { settled += 1; }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.claimedRewardCount, 3);
  assert.deepEqual(result.claimedEvents.map((entry) => entry.eventName), ['Season 2: Act II', 'Mayhem Set 2']);
  assert.equal(result.dismissedNotificationCount, 1);
  assert.equal(result.acknowledgedProfileNotificationCount, 1);
  assert.deepEqual(result.cleared, { collection: true, tft: true, profile: true });
  assert.deepEqual(result.errors, []);
  assert.equal(settled, 1);

  const posts = lcu.calls
    .filter((call) => call.method === 'POST' && call.endpoint.startsWith('/lol-event-hub/'))
    .map((call) => call.endpoint);
  assert.deepEqual(posts, [
    '/lol-event-hub/v1/events/season-id/reward-track/claim-all',
    '/lol-event-hub/v1/events/mayhem-id/reward-track/claim-all'
  ]);

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
      lastTftSetNameSeen: 'TFTSet18',
      seenOfferIds: {
        storeOfferIds: ['battle-pass-offer', 'store-offer'],
        tacticianOfferIds: ['tactician-offer']
      }
    }
  });
  assert.equal(lcu.state.preferences['lol-customizer-tokens'].data.lastVisitTime, now);
  assert.equal(lcu.state.preferences['lol-challenges-latest-level-up'].data.lastLevelUpTime, 0);
  assert.deepEqual(lcu.state.playerNotifications.map((entry) => entry.id), [8]);
  assert.equal(lcu.state.profileInventoryNotifications.SUMMONER_ICON[0].acknowledged, true);
});

test('cleanup is idempotent after the server and preferences reflect the first sweep', async () => {
  const now = Date.parse('2026-07-10T01:30:00Z');
  const lcu = createFakeLcu({
    events: [event('season-id', 'Season', 'Default', 1)],
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: now - 1 } }
    },
    playerNotifications: [
      { id: 'dismiss-me', state: 'unread', dismissible: true, critical: false }
    ]
  });
  const options = { now: () => now, settleAfterClaims: async () => {} };

  await runClientCleanup(lcu, options);
  lcu.calls.length = 0;
  const second = await runClientCleanup(lcu, options);

  assert.equal(second.claimedRewardCount, 0);
  assert.deepEqual(second.cleared, { collection: false, tft: false, profile: false });
  assert.equal(second.dismissedNotificationCount, 0);
  assert.equal(lcu.calls.some((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false);
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
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    events: [event('mayhem-id', 'Mayhem', 'Mayhem', 1)],
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: null },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    },
    failures: new Set([`POST ${claimEndpoint}`])
  });

  const result = await runClientCleanup(lcu, { now: () => now, settleAfterClaims: async () => {} });
  assert.equal(result.claimedRewardCount, 0);
  assert.deepEqual(result.cleared, { collection: true, tft: true, profile: false });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].area, /Mayhem/);
});

test('TFT offer acknowledgement follows the live home hub without hardcoding offer ids', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    currentTftSet: 'TFTSetCustom',
    tftHome: {
      enabled: true,
      battlePassOfferIds: ['bp-current', 'bp-other'],
      storePromoOfferIds: ['store-current', 'store-other'],
      tacticianPromoOfferIds: ['tactician-a', 'tactician-b']
    },
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-tft': {
        schemaVersion: 1,
        data: {
          lastTftSetNameSeen: 'TFTSetCustom',
          seenOfferIds: {
            storeOfferIds: ['old-bp', 'old-store'],
            tacticianOfferIds: ['old-tactician']
          },
          shouldShowTFTNPEQueueUnlock: true
        }
      },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    }
  });

  const result = await runClientCleanup(lcu, { now: () => now });
  assert.equal(result.cleared.tft, true);
  assert.deepEqual(lcu.state.preferences['lol-tft'].data, {
    lastTftSetNameSeen: 'TFTSetCustom',
    seenOfferIds: {
      storeOfferIds: ['bp-current', 'store-current'],
      tacticianOfferIds: ['tactician-a', 'tactician-b']
    },
    shouldShowTFTNPEQueueUnlock: true
  });
});

test('bell cleanup deletes only unread dismissible non-critical notifications and isolates failures', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const failedEndpoint = '/player-notifications/v1/notifications/fails';
  const lcu = createFakeLcu({
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-tft': {
        schemaVersion: 1,
        data: {
          lastTftSetNameSeen: 'TFTSet18',
          seenOfferIds: {
            storeOfferIds: ['battle-pass-offer', 'store-offer'],
            tacticianOfferIds: ['tactician-offer']
          }
        }
      },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    },
    playerNotifications: [
      { id: 'ok', source: 'esports', state: 'unread', dismissible: true, critical: false },
      { id: 'fails', source: 'store', state: 'unread', dismissible: true, critical: false },
      { id: 'read', state: 'read', dismissible: true, critical: false },
      { id: 'critical', state: 'unread', dismissible: true, critical: true },
      { id: 'fixed', state: 'unread', dismissible: false, critical: false }
    ],
    failures: new Set([`DELETE ${failedEndpoint}`])
  });

  const result = await runClientCleanup(lcu, { now: () => now });
  assert.equal(result.dismissedNotificationCount, 1);
  assert.deepEqual(lcu.state.playerNotifications.map((entry) => entry.id), [
    'fails', 'read', 'critical', 'fixed'
  ]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].area, 'notification:store');
});

test('profile cleanup advances tokens, resets stale level-up state, and acknowledges exact inventory types', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    latestLevelUp: now - 500,
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-tft': {
        schemaVersion: 1,
        data: {
          lastTftSetNameSeen: 'TFTSet18',
          seenOfferIds: {
            storeOfferIds: ['battle-pass-offer', 'store-offer'],
            tacticianOfferIds: ['tactician-offer']
          }
        }
      },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now - 1000, keep: true } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: now - 700 } }
    },
    profileInventoryNotifications: {
      ACHIEVEMENT_TITLE: [{ id: 1, type: 'CREATE', acknowledged: false }],
      SUMMONER_ICON: [{ id: 2, type: 'DELETE', acknowledged: false }],
      REGALIA_BANNER: [{ id: 3, type: 'CREATE', acknowledged: true }]
    }
  });

  const result = await runClientCleanup(lcu, { now: () => now });
  assert.equal(result.cleared.profile, true);
  assert.equal(result.acknowledgedProfileNotificationCount, 1);
  assert.deepEqual(lcu.state.preferences['lol-customizer-tokens'].data, {
    lastVisitTime: now,
    keep: true
  });
  assert.equal(lcu.state.preferences['lol-challenges-latest-level-up'].data.lastLevelUpTime, 0);
  assert.equal(lcu.state.profileInventoryNotifications.ACHIEVEMENT_TITLE[0].acknowledged, true);
  assert.equal(lcu.state.profileInventoryNotifications.SUMMONER_ICON[0].acknowledged, false);
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

test('cleanup monitor deduplicates identical automatic success logs but always logs manual runs', async () => {
  const logs = [];
  const result = {
    status: 'completed',
    claimedRewardCount: 0,
    dismissedNotificationCount: 0,
    cleared: { collection: true, tft: false, profile: false },
    errors: []
  };
  const monitor = new ClientCleanupMonitor({
    lcu: {},
    log: (message) => logs.push(message),
    getEnabled: () => true,
    intervalMs: 60_000,
    runner: async () => result
  });

  await monitor.tick('automatic');
  await monitor.tick('automatic');
  await monitor.tick('manual');
  monitor.stop();

  assert.equal(logs.length, 2);
  assert.match(logs[0], /automatic/);
  assert.match(logs[1], /manual/);
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
