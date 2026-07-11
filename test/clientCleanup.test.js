import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ClientCleanupMonitor,
  newestChampionCollectionPurchases,
  parseLeaguePurchaseDate,
  runClientCleanup
} from '../src/core/clientCleanup.js';
import { LcuClient } from '../src/core/lcu.js';
import {
  buildLeagueHeaderClickScript,
  LEAGUE_HEADER_RATIOS
} from '../src/core/leagueHeaderClicks.js';

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

function activityItem(navigationItemID, {
  actionType = 'lc_home_tab',
  endsAt = undefined
} = {}) {
  return {
    navigationItemID,
    action: { type: actionType, payload: { tabId: navigationItemID } },
    ...(endsAt ? { endsAt } : {})
  };
}

function championInventoryFromLegacy(collectionInventories) {
  const skins = (collectionInventories.CHAMPION_SKIN || []).map((item, index) => ({
    id: 1001 + index,
    ownership: {
      owned: item.owned !== false && item.ownershipType !== 'F2P',
      rental: { purchaseDate: item.purchaseDate }
    },
    chromas: []
  }));
  const chromas = (collectionInventories.CHROMA || []).map((item, index) => ({
    id: 2001 + index,
    ownership: {
      owned: item.owned !== false && item.ownershipType !== 'F2P',
      rental: { purchaseDate: item.purchaseDate }
    }
  }));
  if (chromas.length) {
    if (!skins.length) skins.push({ id: 1000, ownership: { owned: true, rental: {} }, chromas: [] });
    skins[0].chromas = chromas;
  }
  return [{ id: 1, skins }];
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
  collectionInventories = {},
  championInventory = null,
  summonerId = 12345,
  profileInventoryNotifications = {},
  latestLevelUp = null,
  activityCenterNav = [],
  buildVersion = '16.13.789.3741',
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
    collectionInventories: structuredClone(collectionInventories),
    championInventory: structuredClone(championInventory ?? championInventoryFromLegacy(collectionInventories)),
    summonerId,
    profileInventoryNotifications: structuredClone(profileInventoryNotifications),
    latestLevelUp,
    activityCenterNav: structuredClone(activityCenterNav),
    buildVersion
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
      if (endpoint === '/lol-summoner/v1/current-summoner') return { summonerId: state.summonerId };
      if (endpoint === `/lol-champions/v1/inventories/${state.summonerId}/champions`) {
        return structuredClone(state.championInventory);
      }
      if (endpoint === EVENT_ENDPOINT) return structuredClone(state.events);
      if (endpoint === '/lol-game-data/assets/v1/tftsets.json') {
        return { LCTFTModeData: { mDefaultSet: { SetCoreName: state.currentTftSet } } };
      }
      if (endpoint === '/lol-tft/v1/tft/homeHub') return structuredClone(state.tftHome);
      if (endpoint === '/player-notifications/v1/notifications') {
        return structuredClone(state.playerNotifications);
      }
      if (endpoint === '/lol-activity-center/v1/content/client-nav') {
        return { data: structuredClone(state.activityCenterNav) };
      }
      if (endpoint === '/system/v1/builds') return { version: state.buildVersion };
      const collectionInventoryMatch = endpoint.match(/^\/lol-inventory\/v2\/inventory\/([^/]+)$/);
      if (collectionInventoryMatch) {
        return structuredClone(state.collectionInventories[collectionInventoryMatch[1]] ?? []);
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

function runCleanup(lcu, options = {}) {
  return runClientCleanup(lcu, {
    clearHeaderIndicators: async (targets) => targets,
    clearActivityCenterIndicators: async () => ({ home: true, mode: 'background' }),
    ...options
  });
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
      'lol-skins-viewer': {
        schemaVersion: 1,
        data: { groupingDropdownKey: 'champion', lastVisitTime: 1 }
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
    collectionInventories: {
      CHAMPION_SKIN: [{
        owned: true,
        f2p: false,
        ownershipType: 'OWNED',
        purchaseDate: '20260710T012959.000Z'
      }]
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
  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    settleAfterClaims: async () => { settled += 1; },
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return targets;
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.claimedRewardCount, 3);
  assert.deepEqual(result.claimedEvents.map((entry) => entry.eventName), ['Season 2: Act II', 'Mayhem Set 2']);
  assert.equal(result.dismissedNotificationCount, 1);
  assert.equal(result.acknowledgedCollectionNotificationCount, 1);
  assert.equal(result.acknowledgedProfileNotificationCount, 0);
  assert.deepEqual(result.cleared, { collection: true, tft: true, profile: true, home: false });
  // The acknowledged inventory notification fires the navigation observer that resets the
  // Collection alert, so no live Collection visit is requested — only TFT needs one.
  assert.deepEqual(headerTargets, { collection: false, tft: true });
  assert.equal(result.headerClearModes.collection, 'event');
  assert.deepEqual(result.errors, []);
  assert.equal(settled, 1);

  const posts = lcu.calls
    .filter((call) => call.method === 'POST' && call.endpoint.startsWith('/lol-event-hub/'))
    .map((call) => call.endpoint);
  assert.deepEqual(posts, [
    '/lol-event-hub/v1/events/season-id/reward-track/claim-all',
    '/lol-event-hub/v1/events/mayhem-id/reward-track/claim-all'
  ]);

  assert.deepEqual(lcu.state.preferences['lol-skins-viewer'], {
    schemaVersion: 2,
    data: {
      groupingDropdownKey: 'champion',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      lastVisitTime: now
    }
  });
  assert.deepEqual(lcu.state.preferences['lol-collection-summoner-icons'], {
    schemaVersion: 2,
    data: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false,
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
      'lol-skins-viewer': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: now - 1 } }
    },
    collectionInventories: {
      CHAMPION_SKIN: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T012959.000Z' }]
    },
    playerNotifications: [
      { id: 'dismiss-me', state: 'unread', dismissible: true, critical: false }
    ]
  });
  const options = { now: () => now, settleAfterClaims: async () => {} };

  await runCleanup(lcu, options);
  lcu.calls.length = 0;
  const second = await runCleanup(lcu, options);

  assert.equal(second.claimedRewardCount, 0);
  assert.deepEqual(second.cleared, { collection: false, tft: false, profile: false, home: false });
  assert.equal(second.dismissedNotificationCount, 0);
  assert.equal(lcu.calls.some((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)), false);
});

test('League home cleanup follows the live dynamic ids and current Patch Notes version', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    activityCenterNav: [
      activityItem('current-a'),
      activityItem('current-b'),
      activityItem('expired', { endsAt: '2026-07-09T00:00:00Z' }),
      activityItem('metagame', { actionType: 'lc_open_metagame' }),
      activityItem('info-hub', { actionType: 'lc_open_info_hub' }),
      activityItem('lol-patch-notes', { actionType: 'iframed' })
    ],
    buildVersion: '16.13.789.3741',
    preferences: {
      'activity-center': {
        schemaVersion: 1,
        data: {
          lastPatchNotesViewed: '15.23',
          tabsViewed: JSON.stringify({ stale: true, expired: true, 'current-a': true }),
          thematicTimelineViewed: '16.5'
        }
      }
    }
  });

  let targets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearActivityCenterIndicators: async (value) => {
      targets = value;
      return { home: true, mode: 'background' };
    }
  });

  assert.equal(result.homeViewedCount, 4);
  assert.equal(result.cleared.home, true);
  assert.equal(result.headerClearModes.home, 'background');
  assert.deepEqual(result.homeLiveClearIds, ['current-b', 'info-hub', 'lol-patch-notes']);
  assert.deepEqual(targets, {
    tabCount: 2,
    tabIndices: [1],
    stickyCount: 2,
    stickyIndices: [0, 1]
  });
  assert.deepEqual(lcu.state.preferences['activity-center'], {
    schemaVersion: 1,
    data: {
      lastPatchNotesViewed: '16.13',
      tabsViewed: JSON.stringify({
        'current-a': true,
        'current-b': true,
        metagame: true,
        'info-hub': true
      }),
      thematicTimelineViewed: '16.5'
    }
  });
});

test('manual cleanup does not click current League home rows when preferences are current', async () => {
  const lcu = createFakeLcu({
    activityCenterNav: [
      activityItem('current-a'),
      activityItem('current-b'),
      activityItem('lol-patch-notes', { actionType: 'iframed' })
    ],
    preferences: {
      'activity-center': {
        schemaVersion: 1,
        data: {
          lastPatchNotesViewed: '16.13',
          tabsViewed: JSON.stringify({ 'current-a': true, 'current-b': true })
        }
      }
    }
  });

  let targets;
  const result = await runCleanup(lcu, {
    clearHeaderIndicators: async (value) => value,
    clearActivityCenterIndicators: async (value) => {
      targets = value;
      return { home: true, mode: 'background' };
    }
  });

  assert.equal(targets, undefined);
  assert.deepEqual(result.homeLiveClearIds, []);
  assert.equal(result.homeViewedCount, 0);
  assert.equal(result.cleared.home, false);
});

test('cleanup blocks critical game phases before touching notification endpoints', async () => {
  for (const phase of ['ReadyCheck', 'ChampSelect', 'InProgress', 'Reconnect', 'WaitingForStats']) {
    const lcu = createFakeLcu({ phase });
    const result = await runCleanup(lcu);
    assert.equal(result.status, 'blocked', phase);
    assert.equal(result.phase, phase);
    assert.deepEqual(lcu.calls, [{ method: 'GET', endpoint: '/lol-gameflow/v1/gameflow-phase' }]);
  }
});

test('cleanup reports an unavailable client when the phase cannot be read', async () => {
  const endpoint = '/lol-gameflow/v1/gameflow-phase';
  const lcu = createFakeLcu({ failures: new Set([`GET ${endpoint}`]) });
  const result = await runCleanup(lcu);
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
      'lol-skins-viewer': { schemaVersion: 1, data: { lastVisitTime: 1 } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    },
    collectionInventories: {
      CHAMPION_SKIN: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T015959.000Z' }]
    },
    failures: new Set([`POST ${claimEndpoint}`])
  });

  const result = await runCleanup(lcu, { now: () => now, settleAfterClaims: async () => {} });
  assert.equal(result.claimedRewardCount, 0);
  assert.deepEqual(result.cleared, { collection: true, tft: true, profile: false, home: false });
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

  const result = await runCleanup(lcu, { now: () => now });
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

  const result = await runCleanup(lcu, { now: () => now });
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

  const result = await runCleanup(lcu, { now: () => now });
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

test('compact League inventory purchase dates parse as UTC milliseconds', () => {
  assert.equal(
    parseLeaguePurchaseDate('20260710T001433.089Z'),
    Date.parse('2026-07-10T00:14:33.089Z')
  );
  assert.equal(parseLeaguePurchaseDate('not-a-date'), 0);
});

test('nested champion inventory is the source of owned skin and chroma purchase dates', () => {
  const purchases = newestChampionCollectionPurchases([{ id: 1, skins: [
    {
      id: 1000,
      ownership: { owned: true, rental: { purchaseDate: 999 } },
      chromas: [
        { id: 2001, ownership: { owned: true, rental: { purchaseDate: 1_700_000_000_000 } } },
        { id: 2002, ownership: { owned: false, rental: { purchaseDate: 1_800_000_000_000 } } }
      ]
    },
    {
      id: 1001,
      ownership: { owned: true, rental: { purchaseDate: 1_710_000_000_000 } },
      chromas: []
    },
    {
      id: 1002,
      ownership: { owned: false, rental: { purchaseDate: 1_900_000_000_000 } },
      chromas: []
    }
  ] }]);

  assert.deepEqual(purchases, {
    skins: 1_710_000_000_000,
    chromas: 1_700_000_000_000
  });
});

test('missing Chromas state is created from nested ownership without using generic CHROMA inventory', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const chromaPurchase = Date.parse('2026-04-30T22:27:59Z');
  const lcu = createFakeLcu({
    championInventory: [{ id: 1, skins: [{
      id: 1000,
      ownership: { owned: true, rental: {} },
      chromas: [{ id: 2001, ownership: { owned: true, rental: { purchaseDate: chromaPurchase } } }]
    }] }],
    preferences: {
      'lol-collection-chromas': { schemaVersion: 0, data: null },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet18' } }
    }
  });

  const result = await runCleanup(lcu, {
    now: () => now,
    deferCollectionClear: true
  });

  assert.deepEqual(result.collectionSeenCategories, ['chromas']);
  assert.deepEqual(result.collectionLiveClearCategories, ['chromas']);
  assert.equal(result.cleared.collection, false);
  assert.equal(lcu.calls.some((call) => call.endpoint === '/lol-inventory/v2/inventory/CHROMA'), false);
  assert.deepEqual(lcu.state.preferences['lol-collection-chromas'], {
    schemaVersion: 2,
    data: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false,
      lastVisitTime: now
    }
  });

  lcu.calls.length = 0;
  const second = await runCleanup(lcu, { now: () => now, deferCollectionClear: true });
  assert.deepEqual(second.collectionSeenCategories, []);
  assert.equal(lcu.calls.some((call) => call.method === 'PATCH' &&
    call.endpoint.endsWith('/lol-collection-chromas')), false);
});

test('Finishers use NEXUS_FINISHER purchases and the shipped schema defaults', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    collectionInventories: {
      NEXUS_FINISHER: [{ ownershipType: 'OWNED', purchaseDate: '20260710T010000.000Z' }]
    },
    preferences: {
      'lol-collection-finishers': { schemaVersion: 0, data: null },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet18' } }
    }
  });

  const result = await runCleanup(lcu, { now: () => now, deferCollectionClear: true });
  assert.deepEqual(result.collectionSeenCategories, ['finishers']);
  assert.deepEqual(lcu.state.preferences['lol-collection-finishers'], {
    schemaVersion: 1,
    data: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false,
      lastVisitTime: now
    }
  });
});

test('Collection date comparisons match Riot at an equal last-visit timestamp', async () => {
  const timestamp = Date.parse('2026-07-10T01:00:00Z');
  const lcu = createFakeLcu({
    collectionInventories: {
      CHAMPION_SKIN: [{ owned: true, purchaseDate: timestamp }],
      CHROMA: [{ owned: true, purchaseDate: timestamp }],
      WARD_SKIN: [{ owned: true, purchaseDate: timestamp }],
      NEXUS_FINISHER: [{ owned: true, purchaseDate: timestamp }]
    },
    preferences: {
      'lol-skins-viewer': { schemaVersion: 2, data: { lastVisitTime: timestamp } },
      'lol-collection-chromas': { schemaVersion: 2, data: { lastVisitTime: timestamp } },
      'lol-collection-wards': { schemaVersion: 3, data: { lastVisitTime: timestamp } },
      'lol-collection-finishers': { schemaVersion: 1, data: { lastVisitTime: timestamp } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet18' } }
    }
  });

  const result = await runCleanup(lcu, {
    now: () => timestamp + 1_000,
    deferCollectionClear: true
  });

  assert.deepEqual(result.collectionSeenCategories, ['finishers', 'skins', 'wards']);
  assert.equal(result.collectionSeenCategories.includes('chromas'), false);
});

test('Collection cleanup follows the shipped navigation sources and preserves view options', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    preferences: {
      'lol-skins-viewer': { schemaVersion: 1, data: { groupingDropdownKey: 'champion', lastVisitTime: 1 } },
      'lol-collection-chromas': { schemaVersion: 2, data: { sortingDropdownKey: 'acquisitionDate', lastVisitTime: 1 } },
      'lol-collection-wards': { schemaVersion: 1, data: { unownedFilter: false, lastVisitTime: 1 } },
      'lol-collection-champions': { schemaVersion: 1, data: { 'lcm-eat-seen': false, groupingDropdownKey: 'role' } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet18' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    },
    collectionInventories: {
      CHAMPION_SKIN: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T010000.000Z' }],
      CHROMA: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T010100.000Z' }],
      WARD_SKIN: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T010200.000Z' }]
    },
    profileInventoryNotifications: {
      EMOTE: [{ id: 7, inventoryType: 'EMOTE', type: 'CREATE', acknowledged: false }],
      SKIN_BORDER: [],
      SUMMONER_ICON: []
    }
  });

  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return targets;
    }
  });
  assert.equal(result.cleared.collection, true);
  assert.equal(result.headerClearModes.collection, 'event');
  // TFT offers were unseen, so a live visit is still requested — but not for Collection.
  assert.deepEqual(headerTargets, { collection: false, tft: true });
  assert.equal(result.acknowledgedCollectionNotificationCount, 1);
  assert.deepEqual(lcu.state.preferences['lol-skins-viewer'].data, {
    groupingDropdownKey: 'champion',
    sortingDropdownKey: 'acquisitionDate',
    unownedFilter: false,
    lastVisitTime: now
  });
  assert.deepEqual(lcu.state.preferences['lol-collection-chromas'].data, {
    groupingDropdownKey: 'myCollection',
    sortingDropdownKey: 'acquisitionDate',
    unownedFilter: false,
    unavailableFilter: false,
    lastVisitTime: now
  });
  assert.deepEqual(lcu.state.preferences['lol-collection-wards'].data, {
    groupingDropdownKey: 'myCollection',
    sortingDropdownKey: 'acquisitionDate',
    unownedFilter: false,
    unavailableFilter: false,
    lastVisitTime: now
  });
  assert.equal(lcu.state.preferences['lol-collection-wards'].schemaVersion, 3);
  assert.deepEqual(lcu.state.preferences['lol-collection-champions'].data, {
    'lcm-eat-seen': true,
    groupingDropdownKey: 'role'
  });
});

test('manual cleanup does not click header targets when their backing state is current', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    preferences: {
      'lol-skins-viewer': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-collection-chromas': { schemaVersion: 2, data: { lastVisitTime: now } },
      'lol-collection-wards': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-collection-champions': { schemaVersion: 1, data: { 'lcm-eat-seen': true } },
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
    }
  });
  let targets;
  const result = await runClientCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (value) => {
      targets = value;
      return value;
    }
  });
  assert.equal(targets, undefined);
  assert.deepEqual(result.cleared, { collection: false, tft: false, profile: false, home: false });
});

test('Collection with unseen purchases but no notifications still requests a live clear', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    preferences: {
      'lol-skins-viewer': { schemaVersion: 1, data: { lastVisitTime: 1 } },
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
    collectionInventories: {
      CHAMPION_SKIN: [{ owned: true, f2p: false, ownershipType: 'OWNED', purchaseDate: '20260710T010000.000Z' }]
    }
  });

  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return { ...targets, mode: 'background' };
    }
  });
  // No inventory notification exists to acknowledge, so no event can reset the rendered
  // alert — the live visit is the only option.
  assert.deepEqual(headerTargets, { collection: true, tft: false });
  assert.equal(result.cleared.collection, true);
  assert.equal(result.headerClearModes.collection, 'background');
});

test('a failed notification acknowledge falls back to a live Collection clear', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
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
    profileInventoryNotifications: {
      EMOTE: [{ id: 9, inventoryType: 'EMOTE', type: 'CREATE', acknowledged: false }]
    },
    failures: new Set(['POST /lol-inventory/v1/notification/acknowledge'])
  });

  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return targets;
    }
  });
  assert.deepEqual(headerTargets, { collection: true, tft: false });
  assert.equal(result.headerClearModes.collection, 'live');
  assert.equal(result.errors.some((error) => error.area.startsWith('collection-notification')), true);
});

// Preferences representing an account whose TFT latch cannot be fixed by writes (the live
// Nueluclor shape): the home hub carries no battle-pass/store offer arrays at all, yet the
// preference has data without seenOfferIds — which the shipped preference observer latches on
// unconditionally.
function residualTftLatchConfig(now) {
  return {
    currentTftSet: 'TFTSet17',
    tftHome: {
      enabled: true,
      tacticianPromoOfferIds: ['tactician-offer']
    },
    preferences: {
      'lol-collection-champions': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-tft': { schemaVersion: 1, data: { lastTftSetNameSeen: 'TFTSet17' } },
      'lol-customizer-tokens': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-challenges-latest-level-up': { schemaVersion: 1, data: { lastLevelUpTime: 0 } }
    }
  };
}

test('an unwritable TFT latch still requests a live clear and reports its signature', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu(residualTftLatchConfig(now));

  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return { ...targets, mode: 'background' };
    }
  });
  assert.deepEqual(headerTargets, { collection: false, tft: true });
  assert.equal(result.cleared.tft, true);
  assert.equal(typeof result.tftResidualLatch, 'string');
  // Nothing was written: the latch is not fixable through preferences.
  assert.equal(lcu.calls.some((call) => call.method === 'PATCH'), false);
});

test('empty home-hub offer arrays also produce an unwritable TFT latch', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const config = residualTftLatchConfig(now);
  config.tftHome = {
    enabled: true,
    battlePassOfferIds: [],
    storePromoOfferIds: [],
    tacticianPromoOfferIds: ['tactician-offer']
  };
  const lcu = createFakeLcu(config);

  let headerTargets;
  const result = await runCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (targets) => {
      headerTargets = targets;
      return targets;
    }
  });
  assert.deepEqual(headerTargets, { collection: false, tft: true });
  assert.equal(typeof result.tftResidualLatch, 'string');
  assert.equal(lcu.calls.some((call) => call.method === 'PATCH'), false);
});

test('a residual TFT latch is not re-clicked when already handled or while deferred', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');

  const handled = createFakeLcu(residualTftLatchConfig(now));
  const first = await runCleanup(handled, { now: () => now });
  assert.equal(typeof first.tftResidualLatch, 'string');
  let called = false;
  const second = await runCleanup(handled, {
    now: () => now,
    isTftLatchHandled: (signature) => signature === first.tftResidualLatch,
    clearHeaderIndicators: async (targets) => {
      called = true;
      return targets;
    }
  });
  assert.equal(called, false);
  assert.equal(second.cleared.tft, false);
  assert.equal(second.tftResidualLatch, first.tftResidualLatch);

  const deferred = createFakeLcu(residualTftLatchConfig(now));
  let deferredCalled = false;
  const result = await runCleanup(deferred, {
    now: () => now,
    deferResidualTftClear: true,
    clearHeaderIndicators: async (targets) => {
      deferredCalled = true;
      return targets;
    }
  });
  assert.equal(deferredCalled, false);
  assert.equal(typeof result.tftResidualLatch, 'string');
});

test('the monitor live-clears a residual TFT latch once per client session', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu(residualTftLatchConfig(now));
  lcu.readLockfile = () => ({ pid: 4242, port: 999 });
  const clicks = [];
  const monitor = new ClientCleanupMonitor({
    lcu,
    getEnabled: () => true,
    intervalMs: 60_000,
    clearHeaderIndicators: async (targets) => {
      clicks.push(targets);
      return { ...targets, mode: 'background' };
    },
    runner: (client, options) => runClientCleanup(client, { ...options, now: () => now })
  });

  await monitor.tick('automatic');
  await monitor.tick('automatic');
  assert.deepEqual(clicks, [{ collection: false, tft: true }]);

  // A client restart (new lockfile identity) invalidates the handled marker.
  lcu.readLockfile = () => ({ pid: 4343, port: 999 });
  await monitor.tick('automatic');
  assert.equal(clicks.length, 2);
  monitor.stop();
});

test('the monitor retries a deferred or failed League home renderer clear after preferences persist', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    activityCenterNav: [activityItem('current-a')],
    preferences: {
      'activity-center': { schemaVersion: 1, data: { tabsViewed: '{}' } }
    }
  });
  lcu.readLockfile = () => ({ pid: 5151, port: 1234 });
  let attempts = 0;
  const monitor = new ClientCleanupMonitor({
    lcu,
    getEnabled: () => true,
    intervalMs: 60_000,
    clearHeaderIndicators: async (targets) => ({ ...targets, mode: 'background' }),
    clearActivityCenterIndicators: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('renderer was not ready');
      return { home: true, mode: 'background' };
    },
    runner: (client, options) => runClientCleanup(client, { ...options, now: () => now })
  });

  const first = await monitor.tick('automatic');
  assert.equal(first.cleared.home, false);
  assert.deepEqual(monitor.activityCenterPending, {
    ids: ['current-a'],
    sessionKey: '5151:1234'
  });

  const second = await monitor.tick('automatic');
  assert.equal(second.cleared.home, true);
  assert.equal(attempts, 2);
  assert.equal(monitor.activityCenterPending, null);
  monitor.stop();
});

test('Collection fallback waits for renderer grace, retains exact categories, and respects burst minimum', async () => {
  let clock = 1_000;
  let cleared = false;
  const optionsSeen = [];
  const lcu = { readLockfile: () => ({ pid: 7001, port: 7777 }) };
  const monitor = new ClientCleanupMonitor({
    lcu,
    getEnabled: () => true,
    intervalMs: 30_000,
    burstIntervalMs: 3_000,
    burstMinMs: 30_000,
    burstMaxMs: 180_000,
    rendererGraceMs: 15_000,
    now: () => clock,
    runner: async (_client, options) => {
      optionsSeen.push({
        deferCollectionClear: options.deferCollectionClear,
        retryCollectionCategories: [...options.retryCollectionCategories]
      });
      if (!cleared) {
        if (options.deferCollectionClear) {
          return {
            status: 'completed',
            claimedRewardCount: 0,
            dismissedNotificationCount: 0,
            acknowledgedCollectionNotificationCount: 0,
            acknowledgedProfileNotificationCount: 0,
            homeViewedCount: 0,
            collectionLiveClearCategories: ['chromas'],
            cleared: { collection: false, tft: false, profile: false, home: false },
            errors: []
          };
        }
        cleared = true;
        return {
          status: 'completed',
          claimedRewardCount: 0,
          dismissedNotificationCount: 0,
          acknowledgedCollectionNotificationCount: 0,
          acknowledgedProfileNotificationCount: 0,
          homeViewedCount: 0,
          collectionLiveClearCategories: ['chromas'],
          cleared: { collection: true, tft: false, profile: false, home: false },
          errors: []
        };
      }
      return {
        status: 'completed',
        claimedRewardCount: 0,
        dismissedNotificationCount: 0,
        acknowledgedCollectionNotificationCount: 0,
        acknowledgedProfileNotificationCount: 0,
        homeViewedCount: 0,
        collectionLiveClearCategories: [],
        cleared: { collection: false, tft: false, profile: false, home: false },
        errors: []
      };
    }
  });

  await monitor.kick({ burst: true });
  assert.deepEqual(monitor.collectionPending?.categories, ['chromas']);
  assert.equal(optionsSeen[0].deferCollectionClear, true);

  clock = 15_999;
  await monitor.tick('automatic');
  assert.equal(optionsSeen[1].deferCollectionClear, true);
  assert.deepEqual(optionsSeen[1].retryCollectionCategories, ['chromas']);

  clock = 16_000;
  await monitor.tick('automatic');
  assert.equal(optionsSeen[2].deferCollectionClear, false);
  assert.deepEqual(optionsSeen[2].retryCollectionCategories, ['chromas']);
  assert.equal(monitor.collectionPending, null);
  assert.notEqual(monitor.burstDeadline, null);

  clock = 31_000;
  await monitor.tick('automatic');
  assert.equal(monitor.burstDeadline, null);
  assert.equal(monitor.currentIntervalMs, 30_000);
  monitor.stop();
});

test('burst does not end on completed errors and pending Collection state is session-scoped', async () => {
  let clock = 1_000;
  let sessionPid = 8001;
  let run = 0;
  const retrySeen = [];
  const lcu = { readLockfile: () => ({ pid: sessionPid, port: 8888 }) };
  const monitor = new ClientCleanupMonitor({
    lcu,
    getEnabled: () => true,
    burstMinMs: 0,
    rendererGraceMs: 0,
    now: () => clock,
    runner: async (_client, options) => {
      retrySeen.push([...options.retryCollectionCategories]);
      run += 1;
      if (run === 1) {
        return {
          status: 'completed',
          claimedRewardCount: 0,
          dismissedNotificationCount: 0,
          acknowledgedCollectionNotificationCount: 0,
          acknowledgedProfileNotificationCount: 0,
          homeViewedCount: 0,
          collectionLiveClearCategories: ['wards'],
          cleared: { collection: false, tft: false, profile: false, home: false },
          errors: [{ area: 'collection', message: 'not ready' }]
        };
      }
      return {
        status: 'completed',
        claimedRewardCount: 0,
        dismissedNotificationCount: 0,
        acknowledgedCollectionNotificationCount: 0,
        acknowledgedProfileNotificationCount: 0,
        homeViewedCount: 0,
        collectionLiveClearCategories: [],
        cleared: { collection: false, tft: false, profile: false, home: false },
        errors: []
      };
    }
  });

  await monitor.kick({ burst: true });
  assert.notEqual(monitor.burstDeadline, null);
  assert.deepEqual(monitor.collectionPending?.categories, ['wards']);

  sessionPid = 8002;
  clock += 1;
  await monitor.tick('automatic');
  assert.deepEqual(retrySeen[1], []);
  assert.equal(monitor.collectionPending, null);
  assert.equal(monitor.burstDeadline, null);
  monitor.stop();
});

test('manual cleanup uses the Collection event clear without forcing unrelated header visits', async () => {
  const now = Date.parse('2026-07-10T02:00:00Z');
  const lcu = createFakeLcu({
    preferences: {
      'lol-skins-viewer': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-collection-chromas': { schemaVersion: 2, data: { lastVisitTime: now } },
      'lol-collection-wards': { schemaVersion: 1, data: { lastVisitTime: now } },
      'lol-collection-champions': { schemaVersion: 1, data: { 'lcm-eat-seen': true } },
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
    profileInventoryNotifications: {
      EMOTE: [{ id: 5, inventoryType: 'EMOTE', type: 'CREATE', acknowledged: false }]
    }
  });

  let targets;
  const result = await runClientCleanup(lcu, {
    now: () => now,
    clearHeaderIndicators: async (value) => {
      targets = value;
      return value;
    }
  });
  assert.equal(targets, undefined);
  assert.equal(result.cleared.collection, true);
  assert.equal(result.cleared.tft, false);
  assert.equal(result.headerClearModes.collection, 'event');
});

test('cleanup monitor burst cadence stays fast until a quiet sweep, then reverts', async () => {
  const results = [
    { status: 'unavailable', claimedRewardCount: 0, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false }, errors: [] },
    { status: 'completed', claimedRewardCount: 0, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 1, acknowledgedProfileNotificationCount: 0, cleared: { collection: true, tft: false, profile: false }, headerClearModes: { collection: 'event', tft: null }, errors: [] },
    { status: 'completed', claimedRewardCount: 0, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false }, errors: [] }
  ];
  let index = 0;
  const monitor = new ClientCleanupMonitor({
    lcu: {},
    getEnabled: () => true,
    intervalMs: 60_000,
    burstIntervalMs: 1_000,
    burstMinMs: 0,
    runner: async () => results[Math.min(index++, results.length - 1)]
  });

  await monitor.kick({ burst: true });
  assert.equal(monitor.currentIntervalMs, 1_000);
  await monitor.tick('automatic');
  assert.equal(monitor.currentIntervalMs, 1_000);
  await monitor.tick('automatic');
  assert.equal(monitor.currentIntervalMs, 60_000);
  assert.equal(monitor.burstDeadline, null);
  monitor.stop();
  assert.equal(monitor.currentIntervalMs, null);
});

test('cleanup monitor keeps a post-game burst active through blocked phases', async () => {
  const results = [
    { status: 'blocked', phase: 'WaitingForStats', claimedRewardCount: 0, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false, home: false }, errors: [] },
    { status: 'completed', claimedRewardCount: 1, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false, home: false }, errors: [] },
    { status: 'completed', claimedRewardCount: 0, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false, home: false }, errors: [] }
  ];
  let index = 0;
  const monitor = new ClientCleanupMonitor({
    lcu: {},
    getEnabled: () => true,
    intervalMs: 30_000,
    burstIntervalMs: 3_000,
    burstMinMs: 0,
    runner: async () => results[Math.min(index++, results.length - 1)]
  });

  await monitor.kick({ burst: true });
  assert.equal(monitor.currentIntervalMs, 3_000);
  assert.notEqual(monitor.burstDeadline, null);

  await monitor.tick('automatic');
  assert.equal(monitor.currentIntervalMs, 3_000);

  await monitor.tick('automatic');
  assert.equal(monitor.currentIntervalMs, 30_000);
  assert.equal(monitor.burstDeadline, null);
  monitor.stop();
});

test('cleanup monitor burst mode gives up at the deadline and plain kicks stay slow', async () => {
  const noisy = { status: 'completed', claimedRewardCount: 1, dismissedNotificationCount: 0, acknowledgedCollectionNotificationCount: 0, acknowledgedProfileNotificationCount: 0, cleared: { collection: false, tft: false, profile: false }, errors: [] };
  const monitor = new ClientCleanupMonitor({
    lcu: {},
    getEnabled: () => true,
    intervalMs: 60_000,
    burstIntervalMs: 1_000,
    burstMaxMs: 0,
    runner: async () => noisy
  });

  await monitor.kick({ burst: true });
  // The deadline elapsed immediately, so even a noisy sweep reverts to the normal cadence.
  assert.equal(monitor.burstDeadline, null);
  assert.equal(monitor.currentIntervalMs, 60_000);
  monitor.stop();

  const plain = new ClientCleanupMonitor({
    lcu: {},
    getEnabled: () => true,
    intervalMs: 60_000,
    burstIntervalMs: 1_000,
    runner: async () => noisy
  });
  await plain.kick();
  assert.equal(plain.currentIntervalMs, 60_000);
  plain.stop();
});

test('League header fallback clicks requested items, returns home, and restores the cursor', () => {
  const script = buildLeagueHeaderClickScript({ collection: true, tft: true });
  assert.match(script, new RegExp(`Invoke-HeaderClick ${LEAGUE_HEADER_RATIOS.collection.x}`));
  assert.match(script, new RegExp(`Invoke-HeaderClick ${LEAGUE_HEADER_RATIOS.tft.x}`));
  assert.match(script, new RegExp(`Invoke-HeaderClick ${LEAGUE_HEADER_RATIOS.league.x}`));
  assert.match(script, /SetCursorPos\(\$originalCursor\.X, \$originalCursor\.Y\)/);
  assert.match(script, /LeagueClientUx/);
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
