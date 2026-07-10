// Targeted cleanup for the League client indicators that are backed by LCU state:
//   - League Season / ARAM Mayhem event-pass rewards
//   - the parent Collection navigation pip (sub-menu pips are intentionally left alone)
//   - TFT home-offer and new-set pips
//   - dynamic League-home news/event pips and Patch Notes
//   - dismissible, non-critical bell notifications
//   - profile customization pips backed by inventory notifications / challenge level-up state

export const CLIENT_CLEANUP_INTERVAL_MS = 30_000;
export const CLIENT_CLEANUP_BURST_INTERVAL_MS = 3_000;
export const CLIENT_CLEANUP_BURST_MAX_MS = 180_000;

const ALLOWED_PHASES = new Set(['None', 'Lobby', 'Matchmaking']);
const EVENT_HUB_ENDPOINT = '/lol-event-hub/v1/events';
const TFT_SETS_ENDPOINT = '/lol-game-data/assets/v1/tftsets.json';
const TFT_HOME_ENDPOINT = '/lol-tft/v1/tft/homeHub';
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

const COLLECTION_INVENTORY_TYPES = {
  skins: 'CHAMPION_SKIN',
  chromas: 'CHROMA',
  wards: 'WARD_SKIN'
};

const COLLECTION_INVENTORY_NOTIFICATION_TYPES = [
  'EMOTE',
  'SKIN_BORDER',
  'SUMMONER_ICON'
];

const PROFILE_INVENTORY_NOTIFICATION_TYPES = [
  'ACHIEVEMENT_TITLE',
  'SUMMONER_ICON',
  'REGALIA_BANNER'
];

const SUPPORTED_SEASON_PASS_SUBTYPES = new Set(['Default', 'Mayhem']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newResult() {
  return {
    status: 'completed',
    phase: null,
    claimedRewardCount: 0,
    claimedEvents: [],
    dismissedNotificationCount: 0,
    acknowledgedCollectionNotificationCount: 0,
    acknowledgedProfileNotificationCount: 0,
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
  const text = String(value ?? '').trim();
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

function newestOwnedPurchaseDate(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((newest, item) => {
    if (item?.owned !== true || item?.f2p === true || item?.ownershipType !== 'OWNED') return newest;
    return Math.max(newest, parseLeaguePurchaseDate(item.purchaseDate));
  }, 0);
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
  if (!viewedAt) return { liveClear: false, eventClearExpected: false };

  const preferenceNames = {
    skins: 'lol-skins-viewer',
    chromas: 'lol-collection-chromas',
    wards: 'lol-collection-wards',
    champions: 'lol-collection-champions'
  };
  const preferenceEntries = Object.entries(preferenceNames);
  const inventoryEntries = Object.entries(COLLECTION_INVENTORY_TYPES);
  const notificationEntries = COLLECTION_INVENTORY_NOTIFICATION_TYPES.map((type) => [
    type,
    `/lol-inventory/v1/notifications/${type}`
  ]);
  const values = await Promise.all([
    ...preferenceEntries.map(([, name]) => lcu.get(`${PREFERENCES_ROOT}/${name}`)),
    ...inventoryEntries.map(([, type]) => lcu.get(`/lol-inventory/v2/inventory/${type}`)),
    ...notificationEntries.map(([, endpoint]) => lcu.get(endpoint))
  ]);
  const preferences = Object.fromEntries(preferenceEntries.map(([key], index) => [key, values[index]]));
  const inventoryOffset = preferenceEntries.length;
  const inventories = Object.fromEntries(inventoryEntries.map(
    ([key], index) => [key, values[inventoryOffset + index]]
  ));
  const notificationOffset = inventoryOffset + inventoryEntries.length;
  const notificationLists = notificationEntries.map(([, endpoint], index) => ({
    endpoint,
    notifications: values[notificationOffset + index]
  }));

  const newest = {
    skins: newestOwnedPurchaseDate(inventories.skins),
    chromas: newestOwnedPurchaseDate(inventories.chromas),
    wards: newestOwnedPurchaseDate(inventories.wards)
  };
  const lastVisit = {
    skins: Number(preferences.skins?.data?.lastVisitTime) || 0,
    chromas: Number(preferences.chromas?.data?.lastVisitTime) || 0,
    wards: Number(preferences.wards?.data?.lastVisitTime) || 0
  };
  // These comparisons mirror the shipped rcp-fe-lol-navigation plugin exactly.
  const unseen = {
    skins: newest.skins > 0 && newest.skins >= lastVisit.skins,
    chromas: newest.chromas > 0 && newest.chromas > lastVisit.chromas,
    wards: newest.wards > 0 && newest.wards >= lastVisit.wards
  };
  const unacknowledged = notificationLists.flatMap(({ notifications }) =>
    (Array.isArray(notifications) ? notifications : []).filter((notification) =>
      notification?.type === 'CREATE' &&
      notification?.acknowledged !== true &&
      notification?.id !== undefined &&
      notification?.id !== null
    )
  );
  const masteryAttentionUnseen = preferences.champions?.data?.['lcm-eat-seen'] === false;
  const unseenAny = Object.values(unseen).some(Boolean) || masteryAttentionUnseen;

  for (const key of ['skins', 'chromas', 'wards']) {
    if (!unseen[key]) continue;
    const name = preferenceNames[key];
    await lcu.patch(
      `${PREFERENCES_ROOT}/${name}`,
      preferenceBody(preferences[key], key === 'chromas' ? 2 : 1, { lastVisitTime: viewedAt })
    );
  }

  if (masteryAttentionUnseen) {
    await lcu.patch(
      `${PREFERENCES_ROOT}/${preferenceNames.champions}`,
      preferenceBody(preferences.champions, 1, { 'lcm-eat-seen': true })
    );
  }

  let ackFailures = 0;
  for (const notification of unacknowledged) {
    try {
      await lcu.post('/lol-inventory/v1/notification/acknowledge', notification.id);
      result.acknowledgedCollectionNotificationCount += 1;
    } catch (error) {
      ackFailures += 1;
      addError(result, `collection-notification:${notification.inventoryType || notification.id}`, error);
    }
  }

  // The final acknowledge fires an inventory-notifications change event; the shipped navigation
  // plugin's handleInventoryChange observer then sets the shared Collection alert to false when
  // no unacknowledged CREATE remains — even when the alert was latched by purchase dates. With
  // no notification to acknowledge, no event fires and the rendered pip needs a live visit.
  const eventClearExpected = unacknowledged.length > 0 && ackFailures === 0;
  return {
    liveClear: (unseenAny || unacknowledged.length > 0) && !eventClearExpected,
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

async function markCurrentTftContentViewed(lcu, result) {
  const [sets, homeHub, preference] = await Promise.all([
    lcu.get(TFT_SETS_ENDPOINT),
    lcu.get(TFT_HOME_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/lol-tft`)
  ]);
  const defaultSet = sets?.LCTFTModeData?.mDefaultSet;
  const currentSet = String(defaultSet?.SetCoreName || defaultSet?.SetName || '').trim();
  const data = preference?.data && typeof preference.data === 'object' ? preference.data : null;
  const offers = currentTftOffers(homeHub);
  const seenOffers = data?.seenOfferIds;
  const setNeedsUpdate = Boolean(currentSet) && data?.lastTftSetNameSeen !== currentSet;
  const offersNeedUpdate = Boolean(offers) && (
    !sameList(offers.storeOfferIds, seenOffers?.storeOfferIds) ||
    !sameList(offers.tacticianOfferIds, seenOffers?.tacticianOfferIds)
  );

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

  const updated = setNeedsUpdate || offersNeedUpdate;
  if (updated) {
    await lcu.patch(
      `${PREFERENCES_ROOT}/lol-tft`,
      preferenceBody(preference, 1, {
        ...(setNeedsUpdate ? { lastTftSetNameSeen: currentSet } : {}),
        ...(offersNeedUpdate ? { seenOfferIds: offers } : {})
      })
    );
  }
  return { updated, residualLatchSignature };
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
  forceHeaderClear = false,
  deferResidualTftClear = false,
  deferActivityCenterClear = false,
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
  const requestedActivityIds = forceHeaderClear
    ? [...availableActivityIds]
    : [...new Set([
        ...activityCenterOutcome.changedIds,
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

  let collectionOutcome = { liveClear: false, eventClearExpected: false };
  try {
    collectionOutcome = await markCollectionViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'collection', error);
  }

  let tftOutcome = { updated: false, residualLatchSignature: null };
  try {
    tftOutcome = await markCurrentTftContentViewed(lcu, result);
  } catch (error) {
    addError(result, 'tft', error);
  }
  result.tftResidualLatch = tftOutcome.residualLatchSignature;
  // A residual latch needs one live visit per client session. Defer it while the client is still
  // booting (burst sweeps — the nav bar may not be rendered yet, so a click would be spent on the
  // loading screen) and skip it when the monitor already cleared this exact latch this session.
  const residualHandled = Boolean(tftOutcome.residualLatchSignature) && (
    deferResidualTftClear ||
    (typeof isTftLatchHandled === 'function' && isTftLatchHandled(tftOutcome.residualLatchSignature))
  );
  const tftNeedsLiveClear = tftOutcome.updated ||
    (Boolean(tftOutcome.residualLatchSignature) && !residualHandled);

  const headerTargets = {
    // forceHeaderClear exists to recover stale dots, but when this sweep's acknowledgements are
    // about to clear the Collection alert through the client's own observer, a forced visit would
    // be pure noise — skip it.
    collection: (forceHeaderClear && !collectionOutcome.eventClearExpected) || collectionOutcome.liveClear,
    tft: forceHeaderClear || tftNeedsLiveClear
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
    burstMaxMs = CLIENT_CLEANUP_BURST_MAX_MS,
    runner = runClientCleanup
  }) {
    this.lcu = lcu;
    this.log = log ?? (() => {});
    this.getEnabled = getEnabled;
    this.clearHeaderIndicators = clearHeaderIndicators;
    this.clearActivityCenterIndicators = clearActivityCenterIndicators;
    this.intervalMs = intervalMs;
    this.burstIntervalMs = burstIntervalMs;
    this.burstMaxMs = burstMaxMs;
    this.runner = runner;
    this.timer = null;
    this.currentIntervalMs = null;
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
  }

  kick({ burst = false } = {}) {
    if (!this.getEnabled()) {
      this.stop();
      return null;
    }
    if (burst) this.burstDeadline = Date.now() + this.burstMaxMs;
    this._setTimer(this.burstDeadline ? this.burstIntervalMs : this.intervalMs);
    return this.tick('automatic');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentIntervalMs = null;
    this.burstDeadline = null;
  }

  runOnce() {
    return this.tick('manual');
  }

  tick(trigger = 'automatic') {
    if (this.currentRun) return this.currentRun;
    const sessionKey = this._sessionKey();
    if (this.activityCenterPending && this.activityCenterPending.sessionKey !== sessionKey) {
      this.activityCenterPending = null;
    }
    this.currentRun = this.runner(this.lcu, {
      clearHeaderIndicators: this.clearHeaderIndicators,
      clearActivityCenterIndicators: this.clearActivityCenterIndicators,
      forceHeaderClear: trigger === 'manual',
      deferResidualTftClear: trigger === 'automatic' && this.burstDeadline !== null,
      deferActivityCenterClear: trigger === 'automatic' && this.burstDeadline !== null,
      retryActivityCenterIds: this.activityCenterPending?.ids || [],
      isTftLatchHandled: (signature) => Boolean(sessionKey) &&
        this.tftLatchHandled?.signature === signature &&
        this.tftLatchHandled?.sessionKey === sessionKey
    })
      .then((result) => {
        this._logResult(result, trigger);
        this._updateBurst(result);
        if (result?.cleared?.tft && result?.tftResidualLatch && sessionKey) {
          this.tftLatchHandled = { signature: result.tftResidualLatch, sessionKey };
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
    if (!this.burstDeadline) return;
    const quiet = result.status === 'completed'
      && result.claimedRewardCount === 0
      && result.dismissedNotificationCount === 0
      && result.acknowledgedCollectionNotificationCount === 0
      && result.acknowledgedProfileNotificationCount === 0
      && (result.homeViewedCount || 0) === 0
      && !result.cleared.collection && !result.cleared.tft && !result.cleared.profile && !result.cleared.home;
    if (quiet || Date.now() >= this.burstDeadline) {
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
