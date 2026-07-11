import { savedFriendAuthExpiresAt, savedFriendXmppEndpoint } from './friendPresencePoc.js';

const PAS_CHAT_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
const CACHE_SAFETY_MS = 60_000;
let cachedLiveAuth = null;
let pendingLiveAuth = null;
let cacheGeneration = 0;

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function fallbackAffinity(region) {
  const value = String(region || '').trim().toLowerCase();
  return ({
    euw: 'euw1',
    eune: 'eun1',
    na: 'na1',
    br: 'br1',
    jp: 'jp1',
    kr: 'kr',
    lan: 'la1',
    las: 'la2',
    oce: 'oc1',
    ru: 'ru',
    tr: 'tr1'
  })[value] || value || 'euw1';
}

function cleanFetchError(name, response) {
  return new Error(`${name} request failed (${response?.status || 'unknown'}).`);
}

export function clearLiveClientXmppAuthCache() {
  cacheGeneration += 1;
  cachedLiveAuth = null;
  pendingLiveAuth = null;
}

// The signed-in League client already owns fresh Riot credentials. Reuse those local, short-lived
// credentials for a second XMPP resource instead of requiring the account's offline saved-session
// cookie to be replayable. Token values stay in the main process and are never logged.
export async function getLiveClientXmppAuth(lcu, {
  log = () => {},
  fetchImpl = globalThis.fetch,
  force = false,
  now = Date.now()
} = {}) {
  if (!lcu?.get) throw new Error('League local API is unavailable.');
  if (typeof fetchImpl !== 'function') throw new Error('Riot credential request support is unavailable.');
  if (force) clearLiveClientXmppAuthCache();
  const summoner = await lcu.get('/lol-summoner/v1/current-summoner');
  const puuid = String(summoner?.puuid || '').trim().toLowerCase();
  if (!puuid) throw new Error('League did not provide the signed-in account identity.');
  if (cachedLiveAuth?.puuid === puuid && cachedLiveAuth.expiresAt - CACHE_SAFETY_MS > now) {
    log(`live-client auth cache hit: remainingMs=${cachedLiveAuth.expiresAt - now}`);
    return cachedLiveAuth.credentials;
  }
  if (pendingLiveAuth?.puuid === puuid) {
    log('live-client auth already in progress; reusing pending request');
    return pendingLiveAuth.promise;
  }

  const generation = cacheGeneration;
  const promise = (async () => {
    const startedAt = Date.now();
    log('live-client auth start');
    const [access, entitlements, regionLocale] = await Promise.all([
      lcu.get('/lol-rso-auth/v1/authorization/access-token'),
      lcu.get('/entitlements/v1/token'),
      lcu.get('/riotclient/region-locale').catch(() => null)
    ]);
    const accessToken = String(access?.token || access?.accessToken || '').trim();
    const entitlementToken = String(entitlements?.token || entitlements?.entitlements_token || '').trim();
    if (!accessToken) throw new Error('League did not provide a live Riot access token.');
    if (!entitlementToken) throw new Error('League did not provide a live entitlement token.');

    const pasResponse = await fetchImpl(PAS_CHAT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!pasResponse?.ok) throw cleanFetchError('PAS chat credential', pasResponse);
    const pasToken = String(await pasResponse.text()).trim();
    if (!pasToken) throw new Error('Riot returned an empty PAS chat credential.');

    const affinity = String(decodeJwtPayload(pasToken)?.affinity || fallbackAffinity(regionLocale?.region)).toLowerCase();
    const auth = {
      accessToken,
      pasToken,
      entitlementToken,
      affinity,
      userInfo: {
        sub: puuid,
        acct: {
          game_name: String(summoner?.gameName || summoner?.displayName || '').trim(),
          tag_line: String(summoner?.tagLine || '').trim()
        },
        lol: { cpid: affinity }
      }
    };
    const credentials = {
      auth,
      endpoint: savedFriendXmppEndpoint(affinity),
      identity: {
        puuid,
        gameName: auth.userInfo.acct.game_name,
        tagLine: auth.userInfo.acct.tag_line
      },
      source: 'live-client'
    };
    const expiresAt = savedFriendAuthExpiresAt(auth);
    if (generation === cacheGeneration && expiresAt > Date.now() + CACHE_SAFETY_MS) {
      cachedLiveAuth = { puuid, expiresAt, credentials };
    }
    log(`live-client auth ready: account=${auth.userInfo.acct.game_name || puuid.slice(0, 8)}, affinity=${affinity}, usableMs=${Math.max(0, expiresAt - Date.now() - CACHE_SAFETY_MS)}, elapsedMs=${Date.now() - startedAt}`);
    return credentials;
  })();
  const pending = { puuid, promise, generation };
  pendingLiveAuth = pending;

  try {
    return await promise;
  } finally {
    if (pendingLiveAuth === pending) pendingLiveAuth = null;
  }
}
