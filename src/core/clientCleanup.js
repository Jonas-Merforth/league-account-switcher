// Targeted cleanup for the League client indicators that are backed by LCU state:
//   - League Season / ARAM Mayhem event-pass rewards
//   - the parent Collection navigation pip (sub-menu pips are intentionally left alone)
//   - TFT home-offer and new-set pips
//   - dismissible, non-critical bell notifications
//   - profile customization pips backed by inventory notifications / challenge level-up state

export const CLIENT_CLEANUP_INTERVAL_MS = 30_000;

const ALLOWED_PHASES = new Set(['None', 'Lobby', 'Matchmaking']);
const EVENT_HUB_ENDPOINT = '/lol-event-hub/v1/events';
const TFT_SETS_ENDPOINT = '/lol-game-data/assets/v1/tftsets.json';
const TFT_HOME_ENDPOINT = '/lol-tft/v1/tft/homeHub';
const PLAYER_NOTIFICATIONS_ENDPOINT = '/player-notifications/v1/notifications';
const PREFERENCES_ROOT = '/lol-settings/v2/account/LCUPreferences';
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
    cleared: {
      collection: false,
      tft: false,
      profile: false
    },
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
  if (!viewedAt) return false;

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
  const needsLiveClear = Object.values(unseen).some(Boolean) || unacknowledged.length > 0 || masteryAttentionUnseen;

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

  for (const notification of unacknowledged) {
    try {
      await lcu.post('/lol-inventory/v1/notification/acknowledge', notification.id);
      result.acknowledgedCollectionNotificationCount += 1;
    } catch (error) {
      addError(result, `collection-notification:${notification.inventoryType || notification.id}`, error);
    }
  }

  return needsLiveClear;
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

async function markCurrentTftContentViewed(lcu, result) {
  const [sets, homeHub, preference] = await Promise.all([
    lcu.get(TFT_SETS_ENDPOINT),
    lcu.get(TFT_HOME_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/lol-tft`)
  ]);
  const defaultSet = sets?.LCTFTModeData?.mDefaultSet;
  const currentSet = String(defaultSet?.SetCoreName || defaultSet?.SetName || '').trim();
  const offers = currentTftOffers(homeHub);
  const seenOffers = preference?.data?.seenOfferIds;
  const setNeedsUpdate = Boolean(currentSet) && preference?.data?.lastTftSetNameSeen !== currentSet;
  const offersNeedUpdate = Boolean(offers) && (
    !sameList(offers.storeOfferIds, seenOffers?.storeOfferIds) ||
    !sameList(offers.tacticianOfferIds, seenOffers?.tacticianOfferIds)
  );
  if (!setNeedsUpdate && !offersNeedUpdate) return false;

  await lcu.patch(
    `${PREFERENCES_ROOT}/lol-tft`,
    preferenceBody(preference, 1, {
      ...(setNeedsUpdate ? { lastTftSetNameSeen: currentSet } : {}),
      ...(offersNeedUpdate ? { seenOfferIds: offers } : {})
    })
  );
  return true;
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
  forceHeaderClear = false
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

  let collectionNeedsLiveClear = false;
  try {
    collectionNeedsLiveClear = await markCollectionViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'collection', error);
  }

  let tftNeedsLiveClear = false;
  try {
    tftNeedsLiveClear = await markCurrentTftContentViewed(lcu, result);
  } catch (error) {
    addError(result, 'tft', error);
  }

  const headerTargets = {
    collection: forceHeaderClear || collectionNeedsLiveClear,
    tft: forceHeaderClear || tftNeedsLiveClear
  };
  if (headerTargets.collection || headerTargets.tft) {
    if (typeof clearHeaderIndicators === 'function') {
      try {
        const cleared = await clearHeaderIndicators(headerTargets);
        result.cleared.collection = Boolean(cleared?.collection && headerTargets.collection);
        result.cleared.tft = Boolean(cleared?.tft && headerTargets.tft);
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
  if (result.claimedRewardCount) parts.push(`claimed ${result.claimedRewardCount} pass reward${result.claimedRewardCount === 1 ? '' : 's'}`);
  if (result.cleared.collection) parts.push('cleared the Collection indicator');
  if (result.cleared.tft) parts.push('cleared the TFT indicator');
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
    intervalMs = CLIENT_CLEANUP_INTERVAL_MS,
    runner = runClientCleanup
  }) {
    this.lcu = lcu;
    this.log = log ?? (() => {});
    this.getEnabled = getEnabled;
    this.clearHeaderIndicators = clearHeaderIndicators;
    this.intervalMs = intervalMs;
    this.runner = runner;
    this.timer = null;
    this.currentRun = null;
    this.lastSuccessSignature = '';
    this.lastErrorSignature = '';
  }

  kick() {
    if (!this.getEnabled()) {
      this.stop();
      return null;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.tick('automatic'), this.intervalMs);
      this.timer.unref?.();
    }
    return this.tick('automatic');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnce() {
    return this.tick('manual');
  }

  tick(trigger = 'automatic') {
    if (this.currentRun) return this.currentRun;
    this.currentRun = this.runner(this.lcu, {
      clearHeaderIndicators: this.clearHeaderIndicators,
      forceHeaderClear: trigger === 'manual'
    })
      .then((result) => {
        this._logResult(result, trigger);
        return result;
      })
      .finally(() => {
        this.currentRun = null;
      });
    return this.currentRun;
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
