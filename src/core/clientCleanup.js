// Targeted cleanup for the League client indicators that are backed by LCU state:
//   - League Season / ARAM Mayhem event-pass rewards
//   - newly acquired skin pips in Collection
//   - the new-TFT-set intro pip/modal
//
// This deliberately does not acknowledge the generic player-notification feed. That feed can carry
// warnings and other messages which must remain visible, and the observed Collection/TFT pips are not
// represented there anyway.

export const CLIENT_CLEANUP_INTERVAL_MS = 30_000;

const ALLOWED_PHASES = new Set(['None', 'Lobby', 'Matchmaking']);
const EVENT_HUB_ENDPOINT = '/lol-event-hub/v1/events';
const SKIN_INVENTORY_ENDPOINT = '/lol-inventory/v2/inventory/CHAMPION_SKIN';
const TFT_SETS_ENDPOINT = '/lol-game-data/assets/v1/tftsets.json';
const PREFERENCES_ROOT = '/lol-settings/v2/account/LCUPreferences';
const CLAIM_SETTLE_MS = 750;

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
    cleared: {
      collectionSkins: false,
      tftSet: false
    },
    errors: []
  };
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

// League uses compact timestamps such as 20260703T201744.000Z for inventory purchases.
export function parseLeaguePurchaseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}${compact[7] || ''}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestOwnedSkinPurchase(inventory) {
  if (!Array.isArray(inventory)) return 0;
  return inventory.reduce((latest, item) => {
    if (!item || item.owned !== true) return latest;
    return Math.max(latest, parseLeaguePurchaseDate(item.purchaseDate));
  }, 0);
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

async function markNewSkinsViewed(lcu, result, now) {
  const [inventory, skinsPreference, collectionPreference] = await Promise.all([
    lcu.get(SKIN_INVENTORY_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/lol-skins-viewer`),
    lcu.get(`${PREFERENCES_ROOT}/lol-collection-champions`)
  ]);
  const newestPurchase = newestOwnedSkinPurchase(inventory);
  if (!newestPurchase) return;

  const skinsLastVisit = Number(skinsPreference?.data?.lastVisitTime) || 0;
  const collectionLastVisit = Number(collectionPreference?.data?.lastVisitTime) || 0;
  const skinsNeedUpdate = newestPurchase > skinsLastVisit;
  const collectionNeedsUpdate = newestPurchase > collectionLastVisit;
  if (!skinsNeedUpdate && !collectionNeedsUpdate) return;

  const viewedAt = Math.max(Number(now()) || 0, newestPurchase);
  let updated = true;

  if (skinsNeedUpdate) {
    try {
      await lcu.patch(
        `${PREFERENCES_ROOT}/lol-skins-viewer`,
        preferenceBody(skinsPreference, 2, { lastVisitTime: viewedAt })
      );
    } catch (error) {
      updated = false;
      addError(result, 'collection:skins', error);
    }
  }

  if (collectionNeedsUpdate) {
    try {
      await lcu.patch(
        `${PREFERENCES_ROOT}/lol-collection-champions`,
        preferenceBody(collectionPreference, 1, { lastVisitTime: viewedAt })
      );
    } catch (error) {
      updated = false;
      addError(result, 'collection:navigation', error);
    }
  }

  result.cleared.collectionSkins = updated;
}

async function markCurrentTftSetViewed(lcu, result) {
  const [sets, preference] = await Promise.all([
    lcu.get(TFT_SETS_ENDPOINT),
    lcu.get(`${PREFERENCES_ROOT}/lol-tft`)
  ]);
  const currentSet = String(sets?.LCTFTModeData?.mDefaultSet?.SetName || '').trim();
  if (!currentSet || preference?.data?.lastTftSetNameSeen === currentSet) return;

  await lcu.patch(
    `${PREFERENCES_ROOT}/lol-tft`,
    preferenceBody(preference, 1, { lastTftSetNameSeen: currentSet })
  );
  result.cleared.tftSet = true;
}

export async function runClientCleanup(lcu, {
  now = Date.now,
  settleAfterClaims = () => sleep(CLAIM_SETTLE_MS)
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
    await markNewSkinsViewed(lcu, result, now);
  } catch (error) {
    addError(result, 'collection', error);
  }

  try {
    await markCurrentTftSetViewed(lcu, result);
  } catch (error) {
    addError(result, 'tft', error);
  }

  return result;
}

function cleanupSummary(result) {
  const parts = [];
  if (result.claimedRewardCount) parts.push(`claimed ${result.claimedRewardCount} pass reward${result.claimedRewardCount === 1 ? '' : 's'}`);
  if (result.cleared.collectionSkins) parts.push('cleared the new-skin indicator');
  if (result.cleared.tftSet) parts.push('cleared the TFT set indicator');
  return parts.join(', ');
}

export class ClientCleanupMonitor {
  constructor({
    lcu,
    log,
    getEnabled,
    intervalMs = CLIENT_CLEANUP_INTERVAL_MS,
    runner = runClientCleanup
  }) {
    this.lcu = lcu;
    this.log = log ?? (() => {});
    this.getEnabled = getEnabled;
    this.intervalMs = intervalMs;
    this.runner = runner;
    this.timer = null;
    this.currentRun = null;
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
    this.currentRun = this.runner(this.lcu)
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
    if (summary) this.log(`Client cleanup (${trigger}): ${summary}.`);

    const errorSignature = (result.errors || []).map((error) => `${error.area}:${error.message}`).join('|');
    if (errorSignature && errorSignature !== this.lastErrorSignature) {
      for (const error of result.errors) {
        this.log(`Client cleanup (${error.area}) failed: ${error.message}`, 'warn');
      }
    }
    this.lastErrorSignature = errorSignature;
  }
}
