// Targeted cleanup for the League client indicators that are backed by LCU state:
//   - League Season / ARAM Mayhem event-pass rewards
//   - Collection parent/category pips backed by exact Riot inventory and preference state
//   - TFT home-offer, new-set, Store, and dynamic event sub-navigation pips
//   - dynamic League-home news/event pips and Patch Notes
//   - active League and TFT mission-card pips
//   - dismissible, non-critical bell notifications
//   - profile customization pips backed by inventory notifications / challenge level-up state

export const CLIENT_CLEANUP_INTERVAL_MS = 30_000;
export const CLIENT_CLEANUP_BURST_INTERVAL_MS = 3_000;
export const CLIENT_CLEANUP_BURST_MIN_MS = 30_000;
export const CLIENT_CLEANUP_BURST_MAX_MS = 180_000;
export const CLIENT_CLEANUP_RENDERER_GRACE_MS = 15_000;

const ALLOWED_PHASES = new Set(['None', 'Lobby', 'Matchmaking']);
const EVENT_HUB_ENDPOINT = '/lol-event-hub/v1/events';
const TFT_SETS_ENDPOINT = '/lol-game-data/assets/v1/tftsets.json';
const TFT_HOME_ENDPOINT = '/lol-tft/v1/tft/homeHub';
const TFT_EVENTS_ENDPOINT = '/lol-tft/v1/tft/events';
const TFT_VERSIONS_SEEN_ENDPOINT = '/lol-settings/v2/account/TFT/VersionsSeen';
const TFT_MISSIONS_ENDPOINT = '/lol-missions/v1/missions';
const OBJECTIVES_ENDPOINT = '/lol-objectives/v1/objectives';
const MISSION_VIEW_ENDPOINT = '/lol-missions/v1/player';
const TFT_ROTATIONAL_SHOP_CONFIG_ENDPOINT =
  '/lol-client-config/v3/client-config/lol.client_settings.tft.tft_rotational_shop';
const PLAYER_NOTIFICATIONS_ENDPOINT = '/player-notifications/v1/notifications';
const PREFERENCES_ROOT = '/lol-settings/v2/account/LCUPreferences';
const ACTIVITY_CENTER_NAV_ENDPOINT = '/lol-activity-center/v1/content/client-nav';
const SYSTEM_BUILDS_ENDPOINT = '/system/v1/builds';
const ACTIVITY_CENTER_PREFERENCE = 'activity-center';
const PATCH_NOTES_ID = 'lol-patch-notes';
const INFO_HUB_ID = 'info-hub';
const STICKY_ACTIVITY_CENTER_IDS = new Set([PATCH_NOTES_ID, INFO_HUB_ID]);
const PERSISTENT_METAGAME_ACTION = 'lc_open_metagame';
const CLAIM_SETTLE_MS = 750;

// The event tabs themselves are data-driven. Riot's rotational-shop provider is the one remaining
// version map compiled into the TFT bundle; docs/tft-cleanup-update.md explains how to refresh it.
export const TFT_ROTATIONAL_SHOP_VERSIONS = Object.freeze({
  'rotational-shop-nav': 1,
  'rotational-shop-mythic': 1,
  'rotational-shop-seasonal': 1,
  'rotational-shop-evergreen': 1,
  'rotational-shop-history': 1,
  'rotational-shop-events': 1
});

// Riot 16.13 special-cases this event instead of using its start timestamp. The renderer compares
// the number of completed missions in this series with lol-tft.data.lastUnlockCount.
const TFT_EVENT_UNLOCK_MISSION_SERIES = Object.freeze({
  Set17AGE: 'TFT17_Age_Series'
});

const COLLECTION_INVENTORY_NOTIFICATION_TYPES = [
  'EMOTE',
  'SKIN_BORDER',
  'SUMMONER_ICON'
];

const COLLECTION_NOTIFICATION_CATEGORIES = {
  EMOTE: 'emotes',
  SKIN_BORDER: 'skins',
  SUMMONER_ICON: 'icons'
};

const COLLECTION_PREFERENCES = {
  skins: {
    name: 'lol-skins-viewer',
    schemaVersion: 2,
    defaults: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false
    }
  },
  icons: {
    name: 'lol-collection-summoner-icons',
    schemaVersion: 2,
    defaults: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false
    }
  },
  wards: {
    name: 'lol-collection-wards',
    schemaVersion: 3,
    defaults: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false
    }
  },
  chromas: {
    name: 'lol-collection-chromas',
    schemaVersion: 2,
    defaults: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false
    }
  },
  finishers: {
    name: 'lol-collection-finishers',
    schemaVersion: 1,
    defaults: {
      groupingDropdownKey: 'myCollection',
      sortingDropdownKey: 'acquisitionDate',
      unownedFilter: false,
      unavailableFilter: false
    }
  }
};

const COLLECTION_CHAMPIONS_PREFERENCE = 'lol-collection-champions';

const PROFILE_INVENTORY_NOTIFICATION_TYPES = [
  'ACHIEVEMENT_TITLE',
  'SUMMONER_ICON',
  'REGALIA_BANNER'
];

const SUPPORTED_SEASON_PASS_SUBTYPES = new Set(['Default', 'Mayhem']);
const ACTIVE_OBJECTIVE_MISSION_STATUSES = new Set([
  'PENDING',
  'UPCOMING',
  'SELECT_REWARDS',
  'COMPLETED',
  'REWARDS_PENDING'
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newResult() {
  return {
    status: 'completed',
    phase: null,
    claimedRewardCount: 0,
    claimedEvents: [],
    viewedMissionCount: 0,
    dismissedNotificationCount: 0,
    acknowledgedCollectionNotificationCount: 0,
    acknowledgedProfileNotificationCount: 0,
    collectionSeenCategories: [],
    collectionLiveClearCategories: [],
    tftSeenCategories: [],
    tftStoreLiveClear: false,
    tftStoreCleared: false,
    homeViewedCount: 0,
    cleared: {
      collection: false,
      tft: false,
      profile: false,
      home: false
    },
    headerClearModes: {
      collection: null,
      tft: null,
      home: null
    },
    tftResidualLatch: null,
    homeLiveClearIds: [],
    errors: []
  };
}

// LCU inventory dates use a compact ISO-like form such as 20260710T001433.089Z, which Date.parse
// does not consistently accept. Exported for focused regression coverage.
export function parseLeaguePurchaseDate(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value ?? '').trim();
  if (/^\d{11,}$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (compact) {
    const [, year, month, day, hour, minute, second, fraction = '0'] = compact;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(fraction.padEnd(3, '0'))
    );
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestInventoryPurchaseDate(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((newest, item) => {
    if (item?.owned === false || item?.f2p === true || item?.ownershipType === 'F2P') return newest;
    return Math.max(newest, parseLeaguePurchaseDate(item.purchaseDate));
  }, 0);
}

function isBaseSkinId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id % 1000 === 0;
}

// Riot's Collections plug-in derives both pips from the champion inventory, not from the generic
// CHAMPION_SKIN / CHROMA inventory resources. The latter can be empty while the nested ownership
// data contains dozens of owned chromas.
export function newestChampionCollectionPurchases(champions) {
  const newest = { skins: 0, chromas: 0 };
  if (!Array.isArray(champions)) return newest;
  for (const champion of champions) {
    for (const skin of (Array.isArray(champion?.skins) ? champion.skins : [])) {
      if (!isBaseSkinId(skin?.id) && skin?.ownership?.owned === true) {
        newest.skins = Math.max(
          newest.skins,
          parseLeaguePurchaseDate(skin?.ownership?.rental?.purchaseDate)
        );
      }
      for (const chroma of (Array.isArray(skin?.chromas) ? skin.chromas : [])) {
        if (chroma?.ownership?.owned !== true) continue;
        newest.chromas = Math.max(
          newest.chromas,
          parseLeaguePurchaseDate(chroma?.ownership?.rental?.purchaseDate)
        );
      }
    }
  }
  return newest;
}

function addError(result, area, error) {
  result.errors.push({
    area,
    message: error instanceof Error ? error.message : String(error)
  });
}

function preferenceBody(resource, fallbackSchemaVersion, patch) {
  const data = resource?.data && typeof resource.data === 'object' ? resource.data : {};
  const currentSchema = Number(resource?.schemaVersion);
  return {
    schemaVersion: Number.isFinite(currentSchema) && currentSchema > 0
      ? currentSchema
      : fallbackSchemaVersion,
    data: { ...data, ...patch }
  };
}

function collectionPreferenceBody(resource, config, patch) {
  const data = resource?.data && typeof resource.data === 'object' ? resource.data : {};
  return {
    schemaVersion: config.schemaVersion,
    data: { ...config.defaults, ...data, ...patch }
  };
}

function parseViewedTabs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildVersion(value) {
  return String(value ?? '').split('.').slice(0, 2).join('.');
}

function isExpiredActivityCenterItem(item, now) {
  if (!item?.endsAt) return false;
  const endsAt = Date.parse(item.endsAt);
  return Number.isFinite(endsAt) && endsAt < now;
}

function isActiveAt(item, now) {
  const startsAt = Number(item?.startDate ?? item?.startTime);
  const endsAt = Number(item?.endDate ?? item?.endTime);
  return (!Number.isFinite(startsAt) || startsAt <= now) &&
    (!Number.isFinite(endsAt) || endsAt >= now);
}

// Mirrors the objectives renderer before it batches card hovers into PUT /lol-missions/v1/player:
// only currently displayed categories, groups, and missions contribute ids. The raw missions list
// contains many hidden/internal TFT missions whose isNew bit must not be touched.
export function newObjectiveMissionIds(payload, now = Date.now()) {
  const currentTime = Number(now) || Date.now();
  const ids = new Set();
  for (const root of (Array.isArray(payload) ? payload : [])) {
    for (const category of (Array.isArray(root?.objectivesCategories) ? root.objectivesCategories : [])) {
      if (!isActiveAt(category, currentTime)) continue;
      for (const group of (Array.isArray(category?.objectives) ? category.objectives : [])) {
        if (!isActiveAt(group, currentTime)) continue;
        for (const mission of (Array.isArray(group?.missions) ? group.missions : [])) {
          if (
            mission?.isNew !== true ||
            !mission?.id ||
            !ACTIVE_OBJECTIVE_MISSION_STATUSES.has(mission.status) ||
            !isActiveAt(mission, currentTime)
          ) continue;
          ids.add(mission.id);
        }
      }
    }
  }
  return [...ids];
}

async function markObjectiveMissionsViewed(lcu, result, now) {
  const currentTime = Number(now()) || Date.now();
  const missionIds = new Set();
  for (const game of ['lol', 'tft']) {
    try {
      const objectives = await lcu.get(`${OBJECTIVES_ENDPOINT}/${game}`);
      for (const id of newObjectiveMissionIds(objectives, currentTime)) missionIds.add(id);
    } catch (error) {
      addError(result, `missions:${game}`, error);
    }
  }
  if (missionIds.size === 0) return;
  await lcu.put(MISSION_VIEW_ENDPOINT, {
    missionIds: [...missionIds],
    seriesIds: []
  });
  result.viewedMissionCount = missionIds.size;
}

async function markActivityCenterViewed(lcu, result, now) {
  const [navigation, builds, preference] = await Promise.all([
    lcu.get(ACTIVITY_CENTER_NAV_ENDPOINT),
    lcu.get(SYSTEM_BUILDS_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/${ACTIVITY_CENTER_PREFERENCE}`)
  ]);
  const currentTime = Number(now()) || Date.now();
  const config = Array.isArray(navigation?.data) ? navigation.data : [];
  const activeItems = config.filter((item) =>
    item?.navigationItemID && !isExpiredActivityCenterItem(item, currentTime)
  );
  const navTabs = activeItems.filter((item) =>
    !STICKY_ACTIVITY_CENTER_IDS.has(item.navigationItemID) &&
    item?.action?.type !== PERSISTENT_METAGAME_ACTION
  );
  const stickyTabs = activeItems.filter((item) => STICKY_ACTIVITY_CENTER_IDS.has(item.navigationItemID));
  const viewedTabs = parseViewedTabs(preference?.data?.tabsViewed);
  const validIds = new Set(activeItems.map((item) => item.navigationItemID));
  const changedIds = [];

  // Riot's markTabViewed path prunes no-longer-valid content before adding the selected id. Mirror
  // that behavior so this dynamic preference does not grow forever as events rotate.
  for (const id of Object.keys(viewedTabs)) {
    if (!validIds.has(id)) delete viewedTabs[id];
  }
  for (const item of activeItems) {
    const id = item.navigationItemID;
    if (id === PATCH_NOTES_ID || viewedTabs[id]) continue;
    viewedTabs[id] = true;
    changedIds.push(id);
  }

  const currentBuild = buildVersion(builds?.version);
  const hasPatchNotes = stickyTabs.some((item) => item.navigationItemID === PATCH_NOTES_ID);
  const patchNotesChanged = hasPatchNotes && Boolean(currentBuild) &&
    preference?.data?.lastPatchNotesViewed !== currentBuild;
  if (changedIds.length > 0 || patchNotesChanged) {
    await lcu.patch(
      `${PREFERENCES_ROOT}/${ACTIVITY_CENTER_PREFERENCE}`,
      preferenceBody(preference, 1, {
        tabsViewed: JSON.stringify(viewedTabs),
        ...(patchNotesChanged ? { lastPatchNotesViewed: currentBuild } : {})
      })
    );
    result.homeViewedCount += changedIds.length + (patchNotesChanged ? 1 : 0);
  }

  return {
    navTabs,
    stickyTabs,
    changedIds: [
      ...changedIds,
      ...(patchNotesChanged ? [PATCH_NOTES_ID] : [])
    ]
  };
}

function activityCenterClickTargets(outcome, requestedIds) {
  const ids = new Set(requestedIds);
  const tabIndices = [];
  const stickyIndices = [];
  outcome.navTabs.forEach((item, index) => {
    if (ids.has(item.navigationItemID)) tabIndices.push(index);
  });
  outcome.stickyTabs.forEach((item, index) => {
    if (ids.has(item.navigationItemID)) stickyIndices.push(index);
  });
  return {
    tabCount: outcome.navTabs.length,
    tabIndices,
    stickyCount: outcome.stickyTabs.length,
    stickyIndices
  };
}

function eventIdentity(event) {
  const info = event?.eventInfo && typeof event.eventInfo === 'object' ? event.eventInfo : {};
  return {
    id: String(event?.eventId || info.eventId || '').trim(),
    name: String(info.eventName || info.localizedShortName || 'Event pass').trim(),
    type: String(info.eventType || '').trim(),
    subtype: String(info.seasonPassSubType || '').trim(),
    count: Math.max(0, Number(info.unclaimedRewardCount) || 0)
  };
}

async function claimEventRewards(lcu, result) {
  const events = await lcu.get(EVENT_HUB_ENDPOINT);
  if (!Array.isArray(events)) return;

  for (const event of events) {
    const identity = eventIdentity(event);
    if (
      !identity.id ||
      identity.count <= 0 ||
      identity.type !== 'kSeasonPass' ||
      !SUPPORTED_SEASON_PASS_SUBTYPES.has(identity.subtype)
    ) continue;
    try {
      await lcu.post(`${EVENT_HUB_ENDPOINT}/${encodeURIComponent(identity.id)}/reward-track/claim-all`);
      result.claimedRewardCount += identity.count;
      result.claimedEvents.push({
        eventId: identity.id,
        eventName: identity.name,
        rewards: identity.count
      });
    } catch (error) {
      addError(result, `event:${identity.name}`, error);
    }
  }
}

async function markCollectionViewed(lcu, result, now) {
  const viewedAt = Number(now()) || 0;
  if (!viewedAt) return { liveClearCategories: [], eventClearExpected: false };

  const summoner = await lcu.get('/lol-summoner/v1/current-summoner');
  const summonerId = Number(summoner?.summonerId);
  if (!Number.isFinite(summonerId) || summonerId <= 0) {
    throw new Error('Current summoner is not ready for Collection cleanup.');
  }

  const preferenceEntries = Object.entries(COLLECTION_PREFERENCES);
  const notificationEntries = COLLECTION_INVENTORY_NOTIFICATION_TYPES.map((type) => [
    type,
    `/lol-inventory/v1/notifications/${type}`
  ]);
  const values = await Promise.all([
    ...preferenceEntries.map(([, config]) => lcu.get(`${PREFERENCES_ROOT}/${config.name}`)),
    lcu.get(`${PREFERENCES_ROOT}/${COLLECTION_CHAMPIONS_PREFERENCE}`),
    lcu.get(`/lol-champions/v1/inventories/${summonerId}/champions`),
    lcu.get('/lol-inventory/v2/inventory/WARD_SKIN'),
    lcu.get('/lol-inventory/v2/inventory/NEXUS_FINISHER'),
    ...notificationEntries.map(([, endpoint]) => lcu.get(endpoint))
  ]);
  const preferences = Object.fromEntries(preferenceEntries.map(([key], index) => [key, values[index]]));
  const championsPreference = values[preferenceEntries.length];
  const championInventory = values[preferenceEntries.length + 1];
  const wardInventory = values[preferenceEntries.length + 2];
  const finisherInventory = values[preferenceEntries.length + 3];
  const notificationOffset = preferenceEntries.length + 4;
  const notificationLists = notificationEntries.map(([type, endpoint], index) => ({
    type,
    endpoint,
    notifications: values[notificationOffset + index]
  }));

  const championPurchases = newestChampionCollectionPurchases(championInventory);
  const newest = {
    skins: championPurchases.skins,
    chromas: championPurchases.chromas,
    wards: newestInventoryPurchaseDate(wardInventory),
    finishers: newestInventoryPurchaseDate(finisherInventory)
  };
  const lastVisit = {
    skins: Number(preferences.skins?.data?.lastVisitTime) || 0,
    chromas: Number(preferences.chromas?.data?.lastVisitTime) || 0,
    wards: Number(preferences.wards?.data?.lastVisitTime) || 0,
    finishers: Number(preferences.finishers?.data?.lastVisitTime) || 0
  };
  // These comparisons mirror the shipped navigation / Collections plug-ins exactly.
  const unseen = {
    skins: newest.skins > 0 && newest.skins >= lastVisit.skins,
    chromas: newest.chromas > 0 && newest.chromas > lastVisit.chromas,
    wards: newest.wards > 0 && newest.wards >= lastVisit.wards,
    finishers: newest.finishers > 0 && newest.finishers >= lastVisit.finishers
  };
  const unacknowledged = notificationLists.flatMap(({ type, notifications }) => (
    Array.isArray(notifications) ? notifications : []
  ).filter((notification) =>
    notification?.type === 'CREATE' &&
    notification?.acknowledged !== true &&
    notification?.id !== undefined &&
    notification?.id !== null
  ).map((notification) => ({
    ...notification,
    inventoryType: notification.inventoryType || type
  })));
  const notificationCategories = new Set(unacknowledged.map((notification) =>
    COLLECTION_NOTIFICATION_CATEGORIES[notification.inventoryType]
  ).filter(Boolean));
  const masteryAttentionUnseen = championsPreference?.data?.['lcm-eat-seen'] === false;
  const seenCategories = new Set([
    ...Object.entries(unseen).filter(([, value]) => value).map(([key]) => key),
    ...notificationCategories,
    ...(masteryAttentionUnseen ? ['champions'] : [])
  ]);

  for (const key of Object.keys(COLLECTION_PREFERENCES)) {
    const notificationNeedsVisitTime = (key === 'skins' || key === 'icons') && notificationCategories.has(key);
    if (!unseen[key] && !notificationNeedsVisitTime) continue;
    const config = COLLECTION_PREFERENCES[key];
    await lcu.patch(
      `${PREFERENCES_ROOT}/${config.name}`,
      collectionPreferenceBody(preferences[key], config, { lastVisitTime: viewedAt })
    );
  }

  if (masteryAttentionUnseen) {
    await lcu.patch(
      `${PREFERENCES_ROOT}/${COLLECTION_CHAMPIONS_PREFERENCE}`,
      preferenceBody(championsPreference, 1, { 'lcm-eat-seen': true })
    );
  }

  let ackFailures = 0;
  const failedNotificationCategories = new Set();
  for (const notification of unacknowledged) {
    try {
      await lcu.post('/lol-inventory/v1/notification/acknowledge', notification.id);
      result.acknowledgedCollectionNotificationCount += 1;
    } catch (error) {
      ackFailures += 1;
      const category = COLLECTION_NOTIFICATION_CATEGORIES[notification.inventoryType];
      if (category) failedNotificationCategories.add(category);
      addError(result, `collection-notification:${notification.inventoryType || notification.id}`, error);
    }
  }

  result.collectionSeenCategories = [...seenCategories].sort();
  // The final acknowledge fires an inventory-notifications change event; the shipped navigation
  // plugin's handleInventoryChange observer then sets the shared Collection alert to false when
  // no unacknowledged CREATE remains — even when the alert was latched by purchase dates. With
  // no notification to acknowledge, no event fires and the rendered pip needs a live visit.
  const eventClearExpected = unacknowledged.length > 0 && ackFailures === 0;
  const liveClearCategories = eventClearExpected ? [] : [
    ...Object.entries(unseen).filter(([, value]) => value).map(([key]) => key),
    ...failedNotificationCategories,
    ...(masteryAttentionUnseen ? ['champions'] : [])
  ];
  return {
    liveClearCategories: [...new Set(liveClearCategories)].sort(),
    eventClearExpected
  };
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentTftOffers(homeHub) {
  if (
    !homeHub?.enabled ||
    !Array.isArray(homeHub.storePromoOfferIds) ||
    !Array.isArray(homeHub.battlePassOfferIds) ||
    !Array.isArray(homeHub.tacticianPromoOfferIds) ||
    !homeHub.storePromoOfferIds[0] ||
    !homeHub.battlePassOfferIds[0]
  ) return null;

  return {
    storeOfferIds: [homeHub.battlePassOfferIds[0], homeHub.storePromoOfferIds[0]],
    tacticianOfferIds: [...homeHub.tacticianPromoOfferIds]
  };
}

// What the shipped TFT provider itself computes as "current offers": it always takes the FIRST
// battle-pass and store-promo ids, even when those arrays are empty. Empty arrays therefore yield
// entries no JSON-persistable seenOfferIds can equal, so the alert latches on every client start.
function frontEndTftOffers(homeHub) {
  if (
    !homeHub?.enabled ||
    !Array.isArray(homeHub.storePromoOfferIds) ||
    !Array.isArray(homeHub.battlePassOfferIds) ||
    !Array.isArray(homeHub.tacticianPromoOfferIds)
  ) return null;

  return {
    storeOfferIds: [homeHub.battlePassOfferIds[0], homeHub.storePromoOfferIds[0]],
    tacticianOfferIds: [...homeHub.tacticianPromoOfferIds]
  };
}

async function markCurrentTftContentViewed(lcu, result, now) {
  const [sets, homeHub, preference, eventsResource, versionsResource, rotationalShopConfig] = await Promise.all([
    lcu.get(TFT_SETS_ENDPOINT),
    lcu.get(TFT_HOME_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/lol-tft`),
    lcu.get(TFT_EVENTS_ENDPOINT),
    lcu.get(TFT_VERSIONS_SEEN_ENDPOINT),
    lcu.get(TFT_ROTATIONAL_SHOP_CONFIG_ENDPOINT)
  ]);
  const viewedAt = Number(now()) || 0;
  const defaultSet = sets?.LCTFTModeData?.mDefaultSet;
  const currentSet = String(defaultSet?.SetCoreName || defaultSet?.SetName || '').trim();
  const data = preference?.data && typeof preference.data === 'object' ? preference.data : null;
  const versions = versionsResource?.data && typeof versionsResource.data === 'object'
    ? versionsResource.data
    : {};
  const events = Array.isArray(eventsResource?.subNavTabs) ? eventsResource.subNavTabs : [];
  const offers = currentTftOffers(homeHub);
  const seenOffers = data?.seenOfferIds;
  const setNeedsUpdate = Boolean(currentSet) && data?.lastTftSetNameSeen !== currentSet;
  const offersNeedUpdate = Boolean(offers) && (
    !sameList(offers.storeOfferIds, seenOffers?.storeOfferIds) ||
    !sameList(offers.tacticianOfferIds, seenOffers?.tacticianOfferIds)
  );

  const versionUpdates = {};
  const seenCategories = new Set();
  if (rotationalShopConfig?.enabled === true) {
    for (const [key, requiredVersion] of Object.entries(TFT_ROTATIONAL_SHOP_VERSIONS)) {
      if ((Number(versions[key]) || 0) >= requiredVersion) continue;
      versionUpdates[key] = requiredVersion;
      if (key === 'rotational-shop-nav') seenCategories.add('store');
    }
  }
  const storeLiveClear = Object.hasOwn(versionUpdates, 'rotational-shop-nav');

  const activeEvents = events.filter((event) => {
    if (event?.enabled !== true || event?.eventFuture === true) return false;
    const start = Date.parse(event?.startDate || '');
    return Number.isFinite(start) && start > 0 && (!viewedAt || start <= viewedAt);
  });
  for (const event of activeEvents) {
    const eventId = String(event?.eventId || '').trim();
    const start = Date.parse(event?.startDate || '');
    if (!eventId || (Number(versions[eventId]) || 0) >= start) continue;
    versionUpdates[eventId] = start;
    seenCategories.add(`event:${eventId}`);
  }

  const unlockEvent = activeEvents.find((event) =>
    Object.hasOwn(TFT_EVENT_UNLOCK_MISSION_SERIES, String(event?.eventId || ''))
  );
  let unlockCountUpdate;
  if (unlockEvent) {
    const eventId = String(unlockEvent.eventId);
    const seriesName = TFT_EVENT_UNLOCK_MISSION_SERIES[eventId];
    try {
      const missions = await lcu.get(TFT_MISSIONS_ENDPOINT);
      const completedCount = (Array.isArray(missions) ? missions : []).filter((mission) =>
        mission?.seriesName === seriesName && mission?.status === 'COMPLETED'
      ).length;
      const savedCount = data?.lastUnlockCount;
      // Riot uses `!lastUnlockCount || completed > lastUnlockCount`, which makes numeric zero an
      // eternal pip. String "0" is truthy while preserving the intended numeric comparison when the
      // first mission completes.
      if (savedCount === undefined || savedCount === null || savedCount === '' || savedCount === 0 ||
        completedCount > (Number(savedCount) || 0)) {
        unlockCountUpdate = completedCount > 0 ? completedCount : '0';
        seenCategories.add(`unlocks:${eventId}`);
      }
    } catch (error) {
      addError(result, `tft-unlocks:${eventId}`, error);
    }
  }

  if (Object.keys(versionUpdates).length > 0) {
    // Riot patches this category as a partial version map; do not replace unrelated historical ids.
    await lcu.patch(TFT_VERSIONS_SEEN_ENDPOINT, { data: versionUpdates });
  }

  // Detect latches the shipped provider renders but preference writes cannot extinguish. The
  // provider's preference observer latches whenever the preference has data but no seenOfferIds —
  // regardless of the home hub (whose offer arrays may be entirely absent, in which case there is
  // nothing valid to write). It also latches when the stored seenOfferIds cannot equal its
  // computed current offers (see frontEndTftOffers). These accounts need a live TFT visit every
  // client session until Riot's data changes, so report a stable signature the monitor can use to
  // avoid re-clicking within one session.
  let residualLatchSignature = null;
  const frontEndOffers = frontEndTftOffers(homeHub);
  const missingSeenLatch = Boolean(data) && !seenOffers;
  const mismatchLatch = Boolean(seenOffers) && Boolean(frontEndOffers) && (
    !sameList(frontEndOffers.storeOfferIds, seenOffers.storeOfferIds) ||
    !sameList(frontEndOffers.tacticianOfferIds, seenOffers.tacticianOfferIds)
  );
  if ((missingSeenLatch || mismatchLatch) && !offersNeedUpdate) {
    residualLatchSignature = JSON.stringify({
      set: currentSet,
      missingSeen: missingSeenLatch,
      store: frontEndOffers ? frontEndOffers.storeOfferIds.map((value) => value ?? null) : null,
      tacticians: frontEndOffers ? frontEndOffers.tacticianOfferIds : null
    });
  }

  const preferenceNeedsUpdate = setNeedsUpdate || offersNeedUpdate || unlockCountUpdate !== undefined;
  if (preferenceNeedsUpdate) {
    await lcu.patch(
      `${PREFERENCES_ROOT}/lol-tft`,
      preferenceBody(preference, 1, {
        ...(setNeedsUpdate ? { lastTftSetNameSeen: currentSet } : {}),
        ...(offersNeedUpdate ? { seenOfferIds: offers } : {}),
        ...(unlockCountUpdate !== undefined ? { lastUnlockCount: unlockCountUpdate } : {})
      })
    );
  }
  result.tftSeenCategories = [...seenCategories].sort();
  return {
    updated: preferenceNeedsUpdate || Object.keys(versionUpdates).length > 0,
    residualLatchSignature,
    storeLiveClear
  };
}

async function dismissPlayerNotifications(lcu, result) {
  const notifications = await lcu.get(PLAYER_NOTIFICATIONS_ENDPOINT);
  if (!Array.isArray(notifications)) return;

  for (const notification of notifications) {
    if (
      notification?.state !== 'unread' ||
      notification?.dismissible !== true ||
      notification?.critical === true ||
      notification?.id === undefined ||
      notification?.id === null
    ) continue;
    try {
      await lcu.delete(`${PLAYER_NOTIFICATIONS_ENDPOINT}/${encodeURIComponent(notification.id)}`);
      result.dismissedNotificationCount += 1;
    } catch (error) {
      addError(result, `notification:${notification.source || notification.id}`, error);
    }
  }
}

async function markProfileViewed(lcu, result, now) {
  const tokenEndpoint = `${PREFERENCES_ROOT}/lol-customizer-tokens`;
  const levelUpEndpoint = `${PREFERENCES_ROOT}/lol-challenges-latest-level-up`;
  const inventoryEndpoints = PROFILE_INVENTORY_NOTIFICATION_TYPES.map(
    (type) => `/lol-inventory/v1/notifications/${type}`
  );
  const [tokenPreference, levelUpPreference, latestLevelUp, ...inventoryLists] = await Promise.all([
    lcu.get(tokenEndpoint),
    lcu.get(levelUpEndpoint),
    lcu.get('/lol-challenges/v1/latest-challenge-level-up'),
    ...inventoryEndpoints.map((endpoint) => lcu.get(endpoint))
  ]);

  const liveLevelUp = Number(latestLevelUp?.lastLevelUpTime ?? latestLevelUp) || 0;
  const storedLevelUp = Number(levelUpPreference?.data?.lastLevelUpTime) || 0;
  const tokenLastVisit = Number(tokenPreference?.data?.lastVisitTime) || 0;
  const newestLevelUp = Math.max(liveLevelUp, storedLevelUp);
  const viewedAt = Math.max(Number(now()) || 0, newestLevelUp);
  let changed = false;

  if (newestLevelUp > tokenLastVisit && viewedAt) {
    await lcu.patch(tokenEndpoint, preferenceBody(tokenPreference, 1, { lastVisitTime: viewedAt }));
    changed = true;
  }

  if (storedLevelUp !== 0) {
    await lcu.patch(levelUpEndpoint, preferenceBody(levelUpPreference, 1, { lastLevelUpTime: 0 }));
    changed = true;
  }

  for (let index = 0; index < inventoryLists.length; index += 1) {
    const notifications = inventoryLists[index];
    if (!Array.isArray(notifications)) continue;
    for (const notification of notifications) {
      if (
        notification?.type !== 'CREATE' ||
        notification?.acknowledged === true ||
        notification?.id === undefined ||
        notification?.id === null
      ) continue;
      try {
        await lcu.post('/lol-inventory/v1/notification/acknowledge', notification.id);
        result.acknowledgedProfileNotificationCount += 1;
        changed = true;
      } catch (error) {
        addError(result, `profile:${PROFILE_INVENTORY_NOTIFICATION_TYPES[index]}`, error);
      }
    }
  }

  result.cleared.profile = changed;
}

export async function runClientCleanup(lcu, {
  now = Date.now,
  settleAfterClaims = () => sleep(CLAIM_SETTLE_MS),
  clearHeaderIndicators = null,
  clearActivityCenterIndicators = null,
  deferCollectionClear = false,
  deferTftClear = false,
  deferResidualTftClear = false,
  deferActivityCenterClear = false,
  forceActivityCenterClear = false,
  retryCollectionCategories = [],
  retryTftStoreClear = false,
  retryActivityCenterIds = [],
  isTftLatchHandled = null
} = {}) {
  const result = newResult();
  let phase;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    result.status = 'unavailable';
    return result;
  }

  if (typeof phase !== 'string' || !phase) {
    result.status = 'unavailable';
    return result;
  }
  result.phase = phase;
  if (!ALLOWED_PHASES.has(phase)) {
    result.status = 'blocked';
    return result;
  }

  try {
    await claimEventRewards(lcu, result);
  } catch (error) {
    addError(result, 'event-passes', error);
  }

  if (result.claimedRewardCount > 0) await settleAfterClaims();

  try {
    await markObjectiveMissionsViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'missions', error);
  }

  let activityCenterOutcome = { navTabs: [], stickyTabs: [], changedIds: [] };
  try {
    activityCenterOutcome = await markActivityCenterViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'league-home', error);
  }

  const availableActivityIds = new Set([
    ...activityCenterOutcome.navTabs,
    ...activityCenterOutcome.stickyTabs
  ].map((item) => item.navigationItemID));
  // Normally visit only ids whose backing preference was newly advanced, plus exact retained ids.
  // A full pass is used once per client session (and for manual cleanup) because the already-running
  // renderer can retain pips even when their persisted preference was marked seen earlier.
  const requestedActivityIds = [...new Set([
    ...(forceActivityCenterClear ? [...availableActivityIds] : activityCenterOutcome.changedIds),
    ...(Array.isArray(retryActivityCenterIds) ? retryActivityCenterIds : [])
  ])].filter((id) => availableActivityIds.has(id));
  const activityTargets = activityCenterClickTargets(activityCenterOutcome, requestedActivityIds);
  const needsActivityCenterLiveClear = activityTargets.tabIndices.length > 0 ||
    activityTargets.stickyIndices.length > 0;
  result.homeLiveClearIds = requestedActivityIds;

  // Updating activity-center preferences prevents future pips, but the already-running Ember pip
  // manager never observes that preference. Its only in-renderer false path is row selection. Defer
  // the background pass during account-switch burst mode so clicks cannot land on the loading UI.
  if (needsActivityCenterLiveClear && !deferActivityCenterClear) {
    if (typeof clearActivityCenterIndicators === 'function') {
      try {
        const cleared = await clearActivityCenterIndicators(activityTargets);
        result.cleared.home = Boolean(cleared?.home);
        if (result.cleared.home) result.headerClearModes.home = cleared?.mode || 'live';
      } catch (error) {
        addError(result, 'league-home-live', error);
      }
    } else {
      addError(result, 'league-home-live', 'Live League home cleanup is unavailable.');
    }
  }

  let collectionOutcome = { liveClearCategories: [], eventClearExpected: false };
  try {
    collectionOutcome = await markCollectionViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'collection', error);
  }
  const requestedCollectionCategories = collectionOutcome.eventClearExpected ? [] : [...new Set([
    ...collectionOutcome.liveClearCategories,
    ...(Array.isArray(retryCollectionCategories) ? retryCollectionCategories : [])
  ])].sort();
  result.collectionLiveClearCategories = requestedCollectionCategories;

  let tftOutcome = { updated: false, residualLatchSignature: null, storeLiveClear: false };
  try {
    tftOutcome = await markCurrentTftContentViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'tft', error);
  }
  result.tftResidualLatch = tftOutcome.residualLatchSignature;
  // A residual latch needs one live visit per client session. Defer it while the client is still
  // booting (burst sweeps — the nav bar may not be rendered yet, so a click would be spent on the
  // loading screen) and skip it when the monitor already cleared this exact latch this session.
  const residualHandled = Boolean(tftOutcome.residualLatchSignature) &&
    typeof isTftLatchHandled === 'function' && isTftLatchHandled(tftOutcome.residualLatchSignature);
  const tftStoreLiveClear = Boolean(tftOutcome.storeLiveClear || retryTftStoreClear);
  result.tftStoreLiveClear = tftStoreLiveClear;
  const tftNeedsLiveClear = tftOutcome.updated ||
    tftStoreLiveClear ||
    (Boolean(tftOutcome.residualLatchSignature) && !residualHandled);
  const tftLiveClearDeferred = deferTftClear || deferResidualTftClear;

  const headerTargets = {
    // These are source-state detections, not screen-pixel detections. Never visit a current target
    // merely because the sweep was started manually.
    collection: requestedCollectionCategories.length > 0 && !deferCollectionClear,
    tft: tftNeedsLiveClear && !tftLiveClearDeferred,
    ...(tftStoreLiveClear && !tftLiveClearDeferred ? { tftStore: true } : {})
  };
  if (!headerTargets.collection && collectionOutcome.eventClearExpected) {
    result.cleared.collection = true;
    result.headerClearModes.collection = 'event';
  }
  if (headerTargets.collection || headerTargets.tft) {
    if (typeof clearHeaderIndicators === 'function') {
      try {
        const cleared = await clearHeaderIndicators(headerTargets);
        result.cleared.collection = Boolean(cleared?.collection && headerTargets.collection) || result.cleared.collection;
        result.cleared.tft = Boolean(cleared?.tft && headerTargets.tft);
        result.tftStoreCleared = Boolean(cleared?.tftStore && headerTargets.tftStore);
        const mode = cleared?.mode || 'live';
        if (cleared?.collection && headerTargets.collection) result.headerClearModes.collection = mode;
        if (result.cleared.tft) result.headerClearModes.tft = mode;
      } catch (error) {
        addError(result, 'client-header', error);
      }
    } else {
      addError(result, 'client-header', 'Live League header cleanup is unavailable.');
    }
  }

  try {
    await markProfileViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'profile', error);
  }

  try {
    await dismissPlayerNotifications(lcu, result);
  } catch (error) {
    addError(result, 'notifications', error);
  }

  return result;
}

function cleanupSummary(result) {
  const parts = [];
  const withMode = (text, mode) => (mode ? `${text} (${mode})` : text);
  if (result.claimedRewardCount) parts.push(`claimed ${result.claimedRewardCount} pass reward${result.claimedRewardCount === 1 ? '' : 's'}`);
  if (result.viewedMissionCount) parts.push(`cleared ${result.viewedMissionCount} mission notification${result.viewedMissionCount === 1 ? '' : 's'}`);
  if (result.collectionSeenCategories?.length) {
    parts.push(`marked Collection ${result.collectionSeenCategories.join(', ')} seen`);
  }
  if (result.tftSeenCategories?.length) {
    parts.push(`marked TFT ${result.tftSeenCategories.join(', ')} seen`);
  }
  if (result.cleared.home) parts.push(withMode('cleared the League home indicators', result.headerClearModes?.home));
  if (result.cleared.collection) parts.push(withMode('cleared the Collection indicator', result.headerClearModes?.collection));
  if (result.cleared.tft) parts.push(withMode('cleared the TFT indicator', result.headerClearModes?.tft));
  if (result.cleared.profile) parts.push('cleared the profile indicator');
  if (result.dismissedNotificationCount) parts.push(`dismissed ${result.dismissedNotificationCount} client notification${result.dismissedNotificationCount === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export class ClientCleanupMonitor {
  constructor({
    lcu,
    log,
    getEnabled,
    clearHeaderIndicators = null,
    clearActivityCenterIndicators = null,
    intervalMs = CLIENT_CLEANUP_INTERVAL_MS,
    burstIntervalMs = CLIENT_CLEANUP_BURST_INTERVAL_MS,
    burstMinMs = CLIENT_CLEANUP_BURST_MIN_MS,
    burstMaxMs = CLIENT_CLEANUP_BURST_MAX_MS,
    rendererGraceMs = CLIENT_CLEANUP_RENDERER_GRACE_MS,
    now = Date.now,
    runner = runClientCleanup
  }) {
    this.lcu = lcu;
    this.log = log ?? (() => {});
    this.getEnabled = getEnabled;
    this.clearHeaderIndicators = clearHeaderIndicators;
    this.clearActivityCenterIndicators = clearActivityCenterIndicators;
    this.intervalMs = intervalMs;
    this.burstIntervalMs = burstIntervalMs;
    this.burstMinMs = burstMinMs;
    this.burstMaxMs = burstMaxMs;
    this.rendererGraceMs = rendererGraceMs;
    this.now = now;
    this.runner = runner;
    this.timer = null;
    this.currentIntervalMs = null;
    this.burstStartedAt = null;
    this.burstDeadline = null;
    this.currentRun = null;
    this.lastSuccessSignature = '';
    this.lastErrorSignature = '';
    // The last residual TFT latch we live-cleared, keyed to the client session (lockfile pid:port).
    // Prevents re-clicking the same unfixable latch every sweep; a client restart changes the key.
    this.tftLatchHandled = null;
    // If an Activity Center background pass is deferred during boot or fails after the preference
    // write, retain the exact dynamic ids so a later sweep retries the renderer-only clear.
    this.activityCenterPending = null;
    // A full Activity Center pass runs once per League client session so stale renderer pips are
    // cleared even when their persisted settings were already current before this app started.
    this.activityCenterSessionCleared = null;
    // Date-backed Collection category pips have no settings observer that clears an already-latched
    // parent alert. Retain the exact observed categories until one source-gated parent visit works.
    this.collectionPending = null;
    // The TFT Store reads VersionsSeen only at plug-in startup. Retain one source-gated Store visit
    // when persistence landed after that cache was created.
    this.tftStorePending = null;
  }

  kick({ burst = false } = {}) {
    if (!this.getEnabled()) {
      this.stop();
      return null;
    }
    if (burst) {
      this.burstStartedAt = this.now();
      this.burstDeadline = this.burstStartedAt + this.burstMaxMs;
    }
    this._setTimer(this.burstDeadline ? this.burstIntervalMs : this.intervalMs);
    return this.tick('automatic');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentIntervalMs = null;
    this.burstStartedAt = null;
    this.burstDeadline = null;
    this.activityCenterPending = null;
    this.activityCenterSessionCleared = null;
    this.collectionPending = null;
    this.tftStorePending = null;
  }

  runOnce() {
    return this.tick('manual');
  }

  tick(trigger = 'automatic') {
    if (this.currentRun) return this.currentRun;
    const sessionKey = this._sessionKey();
    if (this.collectionPending && this.collectionPending.sessionKey !== sessionKey) {
      this.collectionPending = null;
    }
    if (this.tftStorePending && this.tftStorePending.sessionKey !== sessionKey) {
      this.tftStorePending = null;
    }
    if (this.activityCenterPending && this.activityCenterPending.sessionKey !== sessionKey) {
      this.activityCenterPending = null;
    }
    const rendererGraceActive = trigger === 'automatic' && this.burstStartedAt !== null &&
      this.now() - this.burstStartedAt < this.rendererGraceMs;
    const forceActivityCenterClear = trigger === 'manual' || Boolean(
      sessionKey && this.activityCenterSessionCleared !== sessionKey
    );
    this.currentRun = this.runner(this.lcu, {
      clearHeaderIndicators: this.clearHeaderIndicators,
      clearActivityCenterIndicators: this.clearActivityCenterIndicators,
      deferCollectionClear: rendererGraceActive,
      deferTftClear: rendererGraceActive,
      deferActivityCenterClear: trigger === 'automatic' && this.burstDeadline !== null,
      forceActivityCenterClear,
      retryCollectionCategories: this.collectionPending?.categories || [],
      retryTftStoreClear: Boolean(this.tftStorePending),
      retryActivityCenterIds: this.activityCenterPending?.ids || [],
      isTftLatchHandled: (signature) => Boolean(sessionKey) &&
        this.tftLatchHandled?.signature === signature &&
        this.tftLatchHandled?.sessionKey === sessionKey
    })
      .then((result) => {
        this._logResult(result, trigger);
        if (result?.cleared?.tft && result?.tftResidualLatch && sessionKey) {
          this.tftLatchHandled = { signature: result.tftResidualLatch, sessionKey };
        }
        if (result?.tftStoreCleared) {
          this.tftStorePending = null;
        } else if (result?.tftStoreLiveClear && sessionKey) {
          this.tftStorePending = { sessionKey };
        }
        if (result?.cleared?.collection) {
          this.collectionPending = null;
        } else if (Array.isArray(result?.collectionLiveClearCategories) &&
          result.collectionLiveClearCategories.length > 0 && sessionKey) {
          this.collectionPending = {
            categories: [...new Set([
              ...(this.collectionPending?.categories || []),
              ...result.collectionLiveClearCategories
            ])].sort(),
            sessionKey
          };
        }
        if (Array.isArray(result?.homeLiveClearIds)) {
          if (result.cleared?.home || result.homeLiveClearIds.length === 0) {
            this.activityCenterPending = null;
          } else if (sessionKey) {
            this.activityCenterPending = {
              ids: [...result.homeLiveClearIds],
              sessionKey
            };
          }
        }
        if (
          forceActivityCenterClear &&
          sessionKey &&
          result?.status === 'completed' &&
          (result?.cleared?.home || result?.homeLiveClearIds?.length === 0)
        ) {
          this.activityCenterSessionCleared = sessionKey;
        }
        this._updateBurst(result);
        return result;
      })
      .finally(() => {
        this.currentRun = null;
      });
    return this.currentRun;
  }

  _sessionKey() {
    try {
      if (typeof this.lcu?.readLockfile === 'function') {
        const credentials = this.lcu.readLockfile();
        if (credentials?.pid && credentials?.port) return `${credentials.pid}:${credentials.port}`;
      }
    } catch {
      // No lockfile — the client is down; the sweep will report unavailable anyway.
    }
    return null;
  }

  // Burst cadence exists to win the race against the freshly launched client renderer: keep
  // sweeping quickly until a sweep completes with nothing left to do (all state was already
  // current, so the navigation plugin can no longer latch anything the sweep covers).
  _updateBurst(result) {
    if (this.burstDeadline === null) return;
    const now = this.now();
    const minimumElapsed = this.burstStartedAt === null || now - this.burstStartedAt >= this.burstMinMs;
    const quiet = result.status === 'completed'
      && (result.errors || []).length === 0
      && result.claimedRewardCount === 0
      && (result.viewedMissionCount || 0) === 0
      && result.dismissedNotificationCount === 0
      && result.acknowledgedCollectionNotificationCount === 0
      && result.acknowledgedProfileNotificationCount === 0
      && (result.homeViewedCount || 0) === 0
      && !result.cleared.collection && !result.cleared.tft && !result.cleared.profile && !result.cleared.home
      && !this.collectionPending
      && !this.tftStorePending;
    if ((quiet && minimumElapsed) || now >= this.burstDeadline) {
      this.burstStartedAt = null;
      this.burstDeadline = null;
      if (this.timer) this._setTimer(this.intervalMs);
    }
  }

  _setTimer(ms) {
    if (this.timer && this.currentIntervalMs === ms) return;
    if (this.timer) clearInterval(this.timer);
    this.currentIntervalMs = ms;
    this.timer = setInterval(() => this.tick('automatic'), ms);
    this.timer.unref?.();
  }

  _logResult(result, trigger) {
    const summary = cleanupSummary(result);
    if (summary && (trigger === 'manual' || summary !== this.lastSuccessSignature)) {
      this.log(`Client cleanup (${trigger}): ${summary}.`);
    }
    if (trigger === 'automatic') this.lastSuccessSignature = summary;

    const errorSignature = (result.errors || []).map((error) => `${error.area}:${error.message}`).join('|');
    if (errorSignature && errorSignature !== this.lastErrorSignature) {
      for (const error of result.errors) {
        this.log(`Client cleanup (${error.area}) failed: ${error.message}`, 'warn');
      }
    }
    this.lastErrorSignature = errorSignature;
  }
}
