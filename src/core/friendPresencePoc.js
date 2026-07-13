import fs from 'node:fs';
import tls from 'node:tls';
import { getSnapshotPath, loadAccounts, readSnapshot } from './accountStore.js';
import { dpapiUnprotect, dpapiUnprotectMany } from './secrets.js';
import { knownQueueIdLabel, queueLabelFrom } from './queueLabels.js';
import { friendFailureDetails } from './friendFailure.js';

const AUTH_URL = 'https://auth.riotgames.com/api/v1/authorization';
const USERINFO_URL = 'https://auth.riotgames.com/userinfo';
const ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1';
const PAS_CHAT_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
const RIOT_CLIENT_UA = 'RiotClient/90.0.0 rso-auth (Windows;10;;Professional, x64)';
const XMPP_PORT = 5223;
const DEFAULT_PRESENCE_WAIT_MS = 1_000;
const DEFAULT_CAREFUL_ACCOUNT_DELAY_MS = 1_000;
const AUTH_CACHE_SAFETY_MS = 60_000;
const savedSessionAuthCache = new Map();
const savedSessionAuthPending = new Map();

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMaybeMs(value) {
  return Number.isFinite(value) ? `${value}ms` : 'none';
}

function emitProgress(progress, payload) {
  if (typeof progress !== 'function') return;
  try {
    progress({ at: new Date().toISOString(), ...payload });
  } catch {
    // Progress updates are best-effort; the fetch itself should keep going.
  }
}

function decodeHash(uri) {
  return Object.fromEntries(new URLSearchParams((String(uri || '').split('#')[1] || '')));
}

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

function accountSnapshotVersion(account) {
  try {
    const stat = fs.statSync(getSnapshotPath(account.id));
    return `${account?.sessionCapturedAt || 'unknown'}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return String(account?.sessionCapturedAt || 'missing');
  }
}

function tokenExpiresAt(token) {
  const seconds = Number(decodeJwtPayload(token)?.exp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

export function savedFriendAuthExpiresAt(auth) {
  const expiries = [auth?.accessToken, auth?.pasToken, auth?.entitlementToken]
    .map(tokenExpiresAt)
    .filter(Number.isFinite);
  return expiries.length ? Math.min(...expiries) : 0;
}

function reusableSavedSessionAuth(account, log, now = Date.now()) {
  const version = accountSnapshotVersion(account);
  const cached = savedSessionAuthCache.get(account.id);
  if (cached?.version === version && cached.expiresAt - AUTH_CACHE_SAFETY_MS > now) {
    log(`auth cache hit for ${account.label}: remainingMs=${cached.expiresAt - now}`);
    return Promise.resolve(cached.auth);
  }
  if (cached) savedSessionAuthCache.delete(account.id);
  const pending = savedSessionAuthPending.get(account.id);
  if (pending?.version === version) {
    log(`auth already in progress for ${account.label}; reusing pending request`);
    return pending.promise;
  }
  if (pending) savedSessionAuthPending.delete(account.id);
  return null;
}

function cacheSavedSessionAuth(account, factory, log) {
  const reusable = reusableSavedSessionAuth(account, log);
  if (reusable) return reusable;
  const version = accountSnapshotVersion(account);
  const promise = Promise.resolve()
    .then(factory)
    .then((auth) => {
      const expiresAt = savedFriendAuthExpiresAt(auth);
      const stillCurrent = savedSessionAuthPending.get(account.id)?.promise === promise;
      if (stillCurrent && expiresAt > Date.now() + AUTH_CACHE_SAFETY_MS) {
        savedSessionAuthCache.set(account.id, { version, expiresAt, auth });
        log(`auth cached for ${account.label}: usableMs=${expiresAt - Date.now() - AUTH_CACHE_SAFETY_MS}`);
      } else if (stillCurrent) {
        log(`auth not cached for ${account.label}: no reusable token lifetime`, 'warn');
      }
      return auth;
    })
    .finally(() => {
      if (savedSessionAuthPending.get(account.id)?.promise === promise) savedSessionAuthPending.delete(account.id);
    });
  savedSessionAuthPending.set(account.id, { version, promise });
  return promise;
}

function invalidateSavedSessionAuth(accountId) {
  savedSessionAuthCache.delete(accountId);
  savedSessionAuthPending.delete(accountId);
}

export function clearSavedFriendAuthCache() {
  savedSessionAuthCache.clear();
  savedSessionAuthPending.clear();
}

function escapeXml(text) {
  return String(text ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;'
  }[char]));
}

function unescapeXml(text) {
  return String(text ?? '').replace(/&(amp|lt|gt|apos|quot|#x([0-9a-f]+)|#(\d+));/gi, (match, named, hex, dec) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return ({ amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' }[named.toLowerCase()] ?? match);
  });
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text || ''));
    if (typeof value === 'string') return parseJsonObject(value);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeBase64Text(text) {
  try {
    const compact = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    if (!compact || compact.length % 4 === 1) return '';
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parsePresenceDetails(encoded) {
  const text = unescapeXml(encoded).trim();
  return parseJsonObject(text) || parseJsonObject(decodeBase64Text(text));
}

function numberFrom(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function queueLabelFor(details = {}, party = null) {
  return knownQueueIdLabel(details.queueId)
    || knownQueueIdLabel(party?.queueId)
    || queueLabelFrom(details.gameQueueType)
    || queueLabelFrom(details.gameMode)
    || queueLabelFrom(details.queueId)
    || queueLabelFrom(party?.queueId);
}

function championNameFrom(details = {}) {
  const skin = String(details.skinname || '').trim();
  if (skin) return skin;
  const championId = numberFrom(details.championId);
  return championId ? `Champion ${championId}` : '';
}

function startedAtFrom(details = {}) {
  const time = numberFrom(details.timeStamp);
  if (!time) return null;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return null;
  // Presence timestamps are epoch milliseconds. Ignore obviously bad future values.
  if (date.getTime() - Date.now() > 120_000) return null;
  return date.toISOString();
}

function parsePartyPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return parseJsonObject(raw);
}

function firstText(...values) {
  for (const value of values) {
    const textValue = String(value ?? '').trim();
    if (textValue) return textValue;
  }
  return '';
}

function normalizePartyOpen(value, partyType) {
  if (typeof value === 'boolean') return value;
  const type = String(partyType || '').trim().toLowerCase();
  if (type === 'open') return true;
  if (type === 'closed' || type === 'inviteonly' || type === 'invite-only') return false;
  return undefined;
}

function partyMembersFromPayload(payload = {}) {
  if (Array.isArray(payload.summonerPuuids)) {
    return payload.summonerPuuids.map(String).filter(Boolean);
  }
  if (Array.isArray(payload.memberPuuids)) {
    return payload.memberPuuids.map(String).filter(Boolean);
  }
  if (Array.isArray(payload.players)) {
    return payload.players.map((player) => String(player?.puuid || '')).filter(Boolean);
  }
  if (Array.isArray(payload.members)) {
    return payload.members.map((member) => String(member?.puuid || '')).filter(Boolean);
  }
  if (Array.isArray(payload.currentParty?.players)) {
    return payload.currentParty.players.map((player) => String(player?.puuid || '')).filter(Boolean);
  }
  return [];
}

function hasRealPartyPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (firstText(payload.partyId, payload.id, payload.currentParty?.partyId)) return true;
  if (partyMembersFromPayload(payload).length) return true;
  if (Array.isArray(payload.summoners) && payload.summoners.length) return true;
  return [
    payload.partySize,
    payload.size,
    payload.currentParty?.players?.length,
    payload.maxPlayers,
    payload.maxPartySize,
    payload.maxPartySizeForQueue,
    payload.gameMode?.maxPartySize
  ].some((value) => numberFrom(value));
}

function queuePartyMaxSize(queueId) {
  const id = numberFrom(queueId);
  if (id === 420) return 2;
  if (id === 440) return 5;
  return null;
}

function parseParty(details = {}, namesByPuuid = new Map()) {
  const payload = parsePartyPayload(details.pty);
  const hasPartyMarker = hasRealPartyPayload(payload) || String(details.gameStatus || '').startsWith('hosting_');
  if (!hasPartyMarker) return null;

  const memberPuuids = partyMembersFromPayload(payload || {});
  const summonerIds = Array.isArray(payload?.summoners)
    ? payload.summoners.map(String).filter(Boolean)
    : [];
  const size = memberPuuids.length
    || summonerIds.length
    || numberFrom(payload?.partySize)
    || numberFrom(payload?.size)
    || numberFrom(payload?.currentParty?.players?.length)
    || null;
  const queueId = numberFrom(payload?.queueId) || numberFrom(details.queueId);
  const maxSize = numberFrom(payload?.maxPlayers)
    || numberFrom(payload?.maxPartySize)
    || numberFrom(payload?.maxPartySizeForQueue)
    || numberFrom(payload?.gameMode?.maxPartySize)
    || queuePartyMaxSize(queueId)
    || null;
  const partyType = firstText(payload?.partyType, payload?.currentParty?.partyType, details.ptyType, details.partyType);
  const memberNames = memberPuuids
    .map((puuid) => namesByPuuid.get(puuid))
    .filter(Boolean);
  return {
    partyId: firstText(payload?.partyId, payload?.id, payload?.currentParty?.partyId, details.partyId),
    partyType,
    size,
    maxSize,
    queueId,
    open: normalizePartyOpen(payload?.isPartyOpen, partyType),
    memberPuuids,
    memberNames,
    unknownCount: Math.max(0, (size || 0) - memberNames.length)
  };
}

export function buildFriendActivity(friend, { namesByPuuid = new Map() } = {}) {
  if (!friend?.online) return { kind: 'offline', label: 'Offline' };

  const state = String(friend.state || '').toLowerCase();
  if (state === 'mobile') return { kind: 'mobile', label: 'On mobile' };

  const details = friend.details && typeof friend.details === 'object' ? friend.details : {};
  const party = parseParty(details, namesByPuuid);
  const gameStatus = String(details.gameStatus || '').trim();
  const statusKey = gameStatus.toLowerCase();
  const queueLabel = queueLabelFor(details, party);
  const championName = championNameFrom(details);
  const startedAt = startedAtFrom(details);
  const base = {
    gameStatus: gameStatus || null,
    queueLabel,
    queueId: numberFrom(details.queueId) || party?.queueId || null,
    gameMode: String(details.gameMode || '').trim(),
    gameQueueType: String(details.gameQueueType || '').trim(),
    championName,
    championId: numberFrom(details.championId),
    gameId: String(details.gameId || '').trim(),
    startedAt,
    party,
    spectatable: String(details.isObservable || '').toUpperCase() === 'ALL'
  };
  if (base.party) {
    base.party.playingWithNames = base.party.memberPuuids
      .filter((puuid) => String(puuid) !== String(friend.puuid || ''))
      .map((puuid) => namesByPuuid.get(puuid))
      .filter(Boolean);
  }

  if (statusKey === 'ingame' || (!gameStatus && state === 'dnd')) {
    return { ...base, kind: 'inGame', label: 'In game' };
  }
  if (statusKey === 'championselect') {
    return { ...base, kind: 'champSelect', label: 'Champ select' };
  }
  if (statusKey.includes('queue') || statusKey.includes('matchmaking')) {
    return { ...base, kind: 'queue', label: 'In queue' };
  }
  if (state === 'away') return { ...base, kind: 'away', label: 'Away' };
  if (statusKey.startsWith('hosting_') || (party && (statusKey === 'outofgame' || statusKey === ''))) {
    return { ...base, kind: 'lobby', label: 'Lobby' };
  }
  return { ...base, kind: 'online', label: 'Online' };
}

function hasRealLeagueActivity(friend) {
  const state = String(friend?.state || '').toLowerCase();
  const details = friend?.details && typeof friend.details === 'object' ? friend.details : {};
  const gameStatus = String(details.gameStatus || '').trim().toLowerCase();
  if (gameStatus && gameStatus !== 'outofgame') return true;
  if (state === 'dnd') return true;
  return Boolean(parseParty(details));
}

export function suppressScanSourceAccountPresence(accounts) {
  const sourcePuuids = new Set(
    accounts
      .map((account) => String(account?.selfPuuid || '').trim())
      .filter(Boolean)
  );
  if (!sourcePuuids.size) return accounts;

  for (const account of accounts) {
    for (const friend of account.friends || []) {
      if (!sourcePuuids.has(String(friend.puuid || ''))) continue;
      if (!friend.online || hasRealLeagueActivity(friend)) continue;
      friend.online = false;
      friend.state = 'offline';
      friend.queue = '';
      friend.product = '';
      friend.details = null;
      friend.scanSourceAccount = true;
    }
    account.onlineCount = (account.friends || []).filter((friend) => friend.online).length;
  }
  return accounts;
}

function decorateFriendActivities(friends) {
  const namesByPuuid = new Map();
  for (const friend of friends) {
    if (friend.puuid && friend.riotId) namesByPuuid.set(String(friend.puuid), friend.riotId);
  }
  for (const friend of friends) {
    friend.activity = buildFriendActivity(friend, { namesByPuuid });
  }
}

function attr(fragment, name) {
  return unescapeXml(fragment.match(new RegExp(`${name}=['"]([^'"]*)['"]`))?.[1] || '');
}

function parseAuthCookiesFromRiotYaml(yaml) {
  const cookies = [];
  const blockRe = /-\s+domain:\s*"auth\.riotgames\.com"[\s\S]*?(?=\n\s*-\s+domain:|\n\S|$)/g;
  for (const match of yaml.matchAll(blockRe)) {
    const block = match[0];
    const name = block.match(/\n\s*name:\s*"([^"]+)"/)?.[1];
    const value = block.match(/\n\s*value:\s*"([^"]+)"/)?.[1];
    if (name && value) cookies.push({ name, value });
  }
  return cookies;
}

function parseRoster(xml) {
  const friends = [];
  const itemRe = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  for (const match of xml.matchAll(itemRe)) {
    const attrs = match[1];
    const body = match[2];
    const idAttrs = body.match(/<id\b([^/>]*)\/?>/i)?.[1] || '';
    const lolAttrs = body.match(/<lol\b([^/>]*)\/?>/i)?.[1] || '';
    const platforms = body.match(/<platforms>([\s\S]*?)<\/platforms>/i)?.[1] || '';
    const riotAttrs = platforms.match(/<riot\b([^/>]*)\/?>/i)?.[1] || '';
    const jid = attr(attrs, 'jid');
    const puuid = attr(attrs, 'puuid') || jid.split('@')[0];
    const gameName = attr(idAttrs, 'name') || attr(lolAttrs, 'name') || attr(riotAttrs, 'name') || attr(attrs, 'name');
    const tagLine = attr(idAttrs, 'tagline') || attr(riotAttrs, 'tagline');
    const state = unescapeXml(body.match(/<state>([^<]*)<\/state>/i)?.[1] || '');
    const groups = [...body.matchAll(/<group[^>]*>([^<]*)<\/group>/g)].map((group) => unescapeXml(group[1]));
    const riotId = tagLine ? `${gameName}#${tagLine}` : gameName;
    friends.push({ puuid, jid, gameName, tagLine, riotId, state: state || 'offline', online: false, groups });
  }
  return friends;
}

function parseLeaguePresence(body) {
  const league = body.match(/<league_of_legends\b[^>]*>([\s\S]*?)<\/league_of_legends>/i)?.[1] || '';
  const state = unescapeXml(league.match(/<st>([^<]*)<\/st>/i)?.[1] || '');
  const product = unescapeXml(league.match(/<s\.p>([^<]*)<\/s\.p>/i)?.[1] || '');
  const encoded = league.match(/<p>([\s\S]*?)<\/p>/i)?.[1];
  const details = encoded ? parsePresenceDetails(encoded) : null;
  const queue = unescapeXml(league.match(/<s\.q>([^<]*)<\/s\.q>/i)?.[1] || '')
    || String(details?.gameQueueType || details?.queueId || '');
  return { state, queue, product, details };
}

export function parsePresenceStanzas(xml) {
  const presences = [];
  const presenceRe = /<presence\b([^>]*?)(?:\/>|>([\s\S]*?)<\/presence>)/g;
  for (const match of xml.matchAll(presenceRe)) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const from = attr(attrs, 'from');
    const type = attr(attrs, 'type');
    const puuid = from.split('@')[0];
    const show = unescapeXml(body.match(/<show>([^<]*)<\/show>/i)?.[1] || '');
    const league = parseLeaguePresence(body);
    const online = type !== 'unavailable';
    presences.push({
      raw: match[0],
      puuid,
      from,
      online,
      state: online ? (league.state || show || 'online') : 'offline',
      queue: league.queue,
      product: league.product,
      details: league.details
    });
  }
  return presences;
}

function parsePresenceStanzasWithTimings(chunkItems) {
  const timed = [];
  const seen = new Set();
  let xml = '';
  for (const chunk of chunkItems) {
    xml += chunk.xml;
    for (const presence of parsePresenceStanzas(xml)) {
      if (seen.has(presence.raw)) continue;
      seen.add(presence.raw);
      timed.push({ ...presence, atMs: chunk.atMs });
    }
  }
  return timed;
}

function xmppDomainForAffinity(affinity) {
  const value = String(affinity || '').toLowerCase();
  if (value === 'us') return 'la1.pvp.net';
  if (value === 'euw1' || value === 'eun1' || value === 'tr1' || value === 'ru') return 'eu1.pvp.net';
  return `${value || 'eu1'}.pvp.net`;
}

function xmppHostForAffinity(affinity) {
  const value = String(affinity || '').toLowerCase();
  if (value === 'us') return 'la1.chat.si.riotgames.com';
  return `${value || 'euw1'}.chat.si.riotgames.com`;
}

export function savedFriendXmppEndpoint(affinity) {
  return {
    host: xmppHostForAffinity(affinity),
    domain: xmppDomainForAffinity(affinity),
    port: XMPP_PORT
  };
}

function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 10_000 }, () => resolve(socket));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('TLS connect timed out')));
  });
}

function makeReader(socket) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
  });
  return {
    async readUntil(marker, timeoutMs = 10_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (buffer.includes(marker) || buffer.includes('<failure') || buffer.includes('<stream:error')) {
          const out = buffer;
          buffer = '';
          return out;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const out = buffer;
      buffer = '';
      const error = new Error(`Timed out waiting for ${marker}; received ${out.length} bytes.`);
      error.code = 'FRIENDS_TIMEOUT';
      throw error;
    },
    async drainFor(timeoutMs) {
      const start = Date.now();
      let out = '';
      const deadline = Date.now() + timeoutMs;
      const chunkItems = [];
      let firstChunkMs = null;
      let lastChunkMs = null;
      while (Date.now() < deadline) {
        if (buffer) {
          const chunkMs = elapsedSince(start);
          firstChunkMs ??= chunkMs;
          lastChunkMs = chunkMs;
          chunkItems.push({ atMs: chunkMs, xml: buffer });
          out += buffer;
          buffer = '';
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (buffer) {
        const chunkMs = elapsedSince(start);
        firstChunkMs ??= chunkMs;
        lastChunkMs = chunkMs;
        chunkItems.push({ atMs: chunkMs, xml: buffer });
        out += buffer;
        buffer = '';
      }
      return {
        xml: out,
        chunks: chunkItems.length,
        chunkItems,
        firstChunkMs,
        lastChunkMs,
        elapsedMs: elapsedSince(start),
        bytes: Buffer.byteLength(out, 'utf8')
      };
    }
  };
}

async function write(socket, stanza) {
  await new Promise((resolve, reject) => {
    socket.write(stanza, 'utf8', (error) => (error ? reject(error) : resolve()));
  });
}

async function mintSavedSessionAuth(account, decrypted, log, sessionMs) {
  const authStartedAt = Date.now();
  log(`auth start for ${account.label}`);
  let manifest;
  try {
    manifest = JSON.parse(decrypted);
  } catch (cause) {
    const error = new Error(`Saved session snapshot could not be read: ${cause.message}`);
    error.code = 'FRIENDS_LOCAL_SESSION_ERROR';
    throw error;
  }
  const yaml = Buffer.from(manifest['Data/RiotGamesPrivateSettings.yaml'] || '', 'base64').toString('utf8');
  const cookies = parseAuthCookiesFromRiotYaml(yaml);
  if (!cookies.some((cookie) => cookie.name === 'ssid')) {
    const error = new Error('No ssid cookie in saved session.');
    error.code = 'FRIENDS_SESSION_MISSING_SSID';
    throw error;
  }

  const body = {
    acr_values: 'urn:riot:bronze',
    claims: '',
    client_id: 'riot-client',
    nonce: crypto.randomUUID().replace(/-/g, ''),
    redirect_uri: 'http://localhost/redirect',
    response_type: 'token id_token',
    scope: 'openid link ban lol_region lol summoner offline_access account'
  };
  const authPostStartedAt = Date.now();
  const authResponse = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      'User-Agent': RIOT_CLIENT_UA
    },
    body: JSON.stringify(body)
  });
  const authJson = await authResponse.json();
  const tokens = decodeHash(authJson?.response?.parameters?.uri);
  if (!tokens.access_token) {
    const type = authJson?.type || authResponse.status;
    log(`auth rejected for ${account.label}: ${type}`);
    if (type === 'auth') {
      const error = new Error('Saved session requires interactive Riot auth (expired, signed out, or 2FA challenge); the Riot Client may still be logged in, but this Friends PoC cannot replay that saved session.');
      error.code = 'FRIENDS_SESSION_INTERACTIVE_AUTH';
      throw error;
    }
    const error = new Error(`Saved session was not accepted by Riot auth (${type}).`);
    error.code = 'FRIENDS_SESSION_AUTH_REJECTED';
    throw error;
  }
  log(`auth accepted for ${account.label}: sessionMs=${sessionMs}, authPostMs=${elapsedSince(authPostStartedAt)}, authElapsedMs=${elapsedSince(authStartedAt)}`);

  const tokenStartedAt = Date.now();
  const [entitlementsResponse, pasResponse, userInfoResponse] = await Promise.all([
    fetch(ENTITLEMENTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    }),
    fetch(PAS_CHAT_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } }),
    fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } })
  ]);
  for (const [name, response] of [
    ['entitlements', entitlementsResponse],
    ['PAS chat', pasResponse],
    ['userinfo', userInfoResponse]
  ]) {
    if (!response.ok) {
      const error = new Error(`${name} token request failed (${response.status}).`);
      error.status = response.status;
      error.code = response.status === 401 || response.status === 403
        ? 'FRIENDS_TOKEN_AUTH_REJECTED'
        : response.status === 429
          ? 'FRIENDS_RATE_LIMITED'
        : response.status >= 500
          ? 'FRIENDS_SERVICE_UNAVAILABLE'
          : 'FRIENDS_TOKEN_REQUEST_FAILED';
      throw error;
    }
  }
  const [entitlements, pasToken, userInfo] = await Promise.all([
    entitlementsResponse.json(),
    pasResponse.text(),
    userInfoResponse.json()
  ]);

  const affinity = decodeJwtPayload(pasToken)?.affinity || String(userInfo?.lol?.cpid || account.region || 'euw1').toLowerCase();
  log(`tokens ready for ${account.label}: riotId=${userInfo?.acct?.game_name || account.label}#${userInfo?.acct?.tag_line || '?'}, affinity=${affinity}, tokenFetchMs=${elapsedSince(tokenStartedAt)}, authTotalMs=${elapsedSince(authStartedAt)}`);
  return {
    accessToken: tokens.access_token,
    pasToken,
    entitlementToken: entitlements.entitlements_token || entitlements.token,
    userInfo,
    affinity
  };
}

async function getSavedSessionAuth(account, log, { force = false } = {}) {
  if (force) invalidateSavedSessionAuth(account.id);
  const reusable = reusableSavedSessionAuth(account, log);
  if (reusable) return reusable;
  return cacheSavedSessionAuth(account, async () => {
    const sessionStartedAt = Date.now();
    const decrypted = await dpapiUnprotect(readSnapshot(account.id));
    return mintSavedSessionAuth(account, decrypted, log, elapsedSince(sessionStartedAt));
  }, log);
}

// Reuse the validated saved-session auth path for long-lived, main-process XMPP features without
// exposing tokens to the renderer. The caller owns the socket lifecycle and must never log tokens.
export async function getSavedFriendXmppAuth(accountId, { log = () => {}, force = false } = {}) {
  const account = loadAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  const auth = await getSavedSessionAuth(account, log, { force });
  return {
    account,
    auth,
    endpoint: savedFriendXmppEndpoint(auth.affinity)
  };
}

// Aggressive refresh still performs all Riot HTTP/XMPP work in parallel, but decrypts every cold
// saved session in one PowerShell process first. Cached or already-pending auth is reused directly.
async function prepareParallelSavedSessionAuth(accounts, log) {
  const prepared = new Map();
  const cold = [];
  for (const account of accounts) {
    const reusable = reusableSavedSessionAuth(account, log);
    if (reusable) prepared.set(account.id, reusable);
    else cold.push(account);
  }
  if (!cold.length) return prepared;

  const readable = [];
  for (const account of cold) {
    try {
      readable.push({ account, cipher: readSnapshot(account.id) });
    } catch (error) {
      prepared.set(account.id, { error });
    }
  }
  if (!readable.length) return prepared;

  const batchStartedAt = Date.now();
  try {
    const decrypted = await dpapiUnprotectMany(readable.map((item) => item.cipher));
    log(`session batch decrypted: accounts=${readable.length}, elapsedMs=${elapsedSince(batchStartedAt)}`);
    for (const [index, item] of readable.entries()) {
      prepared.set(item.account.id, cacheSavedSessionAuth(
        item.account,
        () => mintSavedSessionAuth(item.account, decrypted[index], log, elapsedSince(batchStartedAt)),
        log
      ));
    }
  } catch (batchError) {
    log(`session batch decrypt failed; retrying accounts one at a time: ${batchError.message}`, 'warn');
    for (const item of readable) {
      prepared.set(item.account.id, cacheSavedSessionAuth(item.account, async () => {
        const sessionStartedAt = Date.now();
        const decrypted = await dpapiUnprotect(item.cipher);
        return mintSavedSessionAuth(item.account, decrypted, log, elapsedSince(sessionStartedAt));
      }, log));
    }
  }
  return prepared;
}

export async function validateSavedFriendSessionPoc(accountId, { log = () => {} } = {}) {
  const account = loadAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  const startedAt = Date.now();
  const auth = await getSavedSessionAuth(account, log);
  return {
    accountId: account.id,
    label: account.label,
    riotId: `${auth.userInfo?.acct?.game_name || account.label}#${auth.userInfo?.acct?.tag_line || '?'}`,
    affinity: auth.affinity,
    elapsedMs: elapsedSince(startedAt)
  };
}

async function fetchRosterForAccount(account, {
  log,
  presenceWaitMs,
  progress,
  accountIndex,
  accountTotal,
  accountDone,
  preparedAuth,
  authOverride
}) {
  const accountStartedAt = Date.now();
  const stepPrefix = accountIndex && accountTotal ? `Fetching ${accountIndex}/${accountTotal}: ${account.label}` : account.label;
  const stepProgress = (phase, detail, extra = {}) => emitProgress(progress, {
    phase,
    accountId: account.id,
    accountLabel: account.label,
    accountIndex,
    accountTotal,
    accountDone,
    message: `${stepPrefix} - ${detail}`,
    ...extra
  });
  stepProgress('account-auth', authOverride ? 'using live League credentials' : 'authenticating saved session');
  if (preparedAuth?.error) throw preparedAuth.error;
  let auth = await (authOverride?.auth || preparedAuth || getSavedSessionAuth(account, log));
  try {
    return await fetchRosterForAccountWithAuth(account, auth, { log, presenceWaitMs, stepProgress, accountStartedAt });
  } catch (error) {
    if (error.code !== 'FRIENDS_XMPP_AUTH_FAILED') throw error;
    const source = authOverride ? 'live-client' : 'saved-session';
    log(`XMPP auth rejected for ${account.label}; refreshing ${source} credentials and retrying once`, 'warn');
    stepProgress('account-auth', `refreshing rejected ${source} auth`);
    auth = authOverride?.refresh
      ? await authOverride.refresh()
      : await getSavedSessionAuth(account, log, { force: true });
    return fetchRosterForAccountWithAuth(account, auth, { log, presenceWaitMs, stepProgress, accountStartedAt });
  }
}

async function fetchRosterForAccountWithAuth(account, auth, { log, presenceWaitMs, stepProgress, accountStartedAt }) {
  const host = xmppHostForAffinity(auth.affinity);
  const domain = xmppDomainForAffinity(auth.affinity);
  stepProgress('account-connect', 'connecting to Riot chat');
  log(`xmpp connect for ${account.label}: host=${host}, domain=${domain}`);
  const connectStartedAt = Date.now();
  const socket = await connectTls(host, XMPP_PORT);
  log(`xmpp connected for ${account.label}: connectMs=${elapsedSince(connectStartedAt)}, accountElapsedMs=${elapsedSince(accountStartedAt)}`);
  const readUntil = makeReader(socket);
  const stream = () => `<?xml version="1.0" encoding="UTF-8"?><stream:stream to="${domain}" xml:lang="en" version="1.0" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams">`;
  const steps = [
    [stream(), '</stream:features>'],
    [`<auth mechanism="X-Riot-RSO-PAS" xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><rso_token>${escapeXml(auth.accessToken)}</rso_token><pas_token>${escapeXml(auth.pasToken)}</pas_token></auth>`, '</success>'],
    [stream(), '</stream:features>'],
    ['<iq id="_xmpp_bind1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><puuid-mode enabled="true"/></bind></iq>', '</iq>'],
    [`<iq id="xmpp_entitlements_0" type="set"><entitlements xmlns="urn:riotgames:entitlements"><token>${escapeXml(auth.entitlementToken)}</token></entitlements></iq>`, '</iq>'],
    ['<iq id="_xmpp_session1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"><platform>riot</platform></session></iq>', '</iq>']
  ];

  try {
    const handshakeStartedAt = Date.now();
    for (const [stanza, marker] of steps) {
      await write(socket, stanza);
      const response = await readUntil.readUntil(marker);
      if (/<failure|<stream:error/.test(response)) {
        const error = new Error('XMPP authentication failed.');
        error.code = 'FRIENDS_XMPP_AUTH_FAILED';
        throw error;
      }
    }
    log(`xmpp authenticated for ${account.label}: handshakeMs=${elapsedSince(handshakeStartedAt)}, accountElapsedMs=${elapsedSince(accountStartedAt)}`);
    stepProgress('account-roster', 'fetching roster');
    const rosterStartedAt = Date.now();
    await write(socket, '<iq id="roster_1" type="get"><query xmlns="jabber:iq:riotgames:roster"/></iq>');
    const rosterXml = await readUntil.readUntil('</iq>');
    const friends = parseRoster(rosterXml);
    log(`roster for ${account.label}: ${friends.length} friends, rosterMs=${elapsedSince(rosterStartedAt)}, accountElapsedMs=${elapsedSince(accountStartedAt)}`);

    stepProgress('account-presence', `checking online status for ${friends.length} friends`);
    await write(socket, '<presence/>');
    const presenceDrain = await readUntil.drainFor(presenceWaitMs);
    const timedPresences = parsePresenceStanzasWithTimings(presenceDrain.chunkItems);
    const friendsByPuuid = new Map(friends.map((friend) => [friend.puuid, friend]));
    const selfPuuid = auth.userInfo?.sub || '';
    for (const presence of timedPresences) {
      const friend = friendsByPuuid.get(presence.puuid);
      const kind = friend ? 'friend' : (presence.puuid === selfPuuid ? 'self' : 'unknown');
      const who = friend?.riotId || kind;
      log(`presence stanza for ${account.label}: atMs=${presence.atMs}, kind=${kind}, who=${who}, online=${presence.online}, state=${presence.state}, queue=${presence.queue || 'none'}, product=${presence.product || 'none'}`);
    }
    const presenceMap = new Map(timedPresences.map((presence) => [presence.puuid, presence]));
    let onlineCount = 0;
    for (const friend of friends) {
      const presence = presenceMap.get(friend.puuid);
      if (!presence) continue;
      friend.online = presence.online;
      friend.state = presence.state;
      friend.queue = presence.queue;
      friend.product = presence.product;
      friend.details = presence.details;
      if (presence.online) onlineCount += 1;
    }
    log(`presence for ${account.label}: ${presenceMap.size} stanzas, ${onlineCount}/${friends.length} friends online, waitedMs=${presenceDrain.elapsedMs}, firstChunkMs=${formatMaybeMs(presenceDrain.firstChunkMs)}, lastChunkMs=${formatMaybeMs(presenceDrain.lastChunkMs)}, chunks=${presenceDrain.chunks}, bytes=${presenceDrain.bytes}`);
    log(`account done for ${account.label}: elapsedMs=${elapsedSince(accountStartedAt)}`);

    return {
      accountId: account.id,
      label: account.label,
      riotId: `${auth.userInfo?.acct?.game_name || account.label}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity,
      selfPuuid,
      friends,
      presenceStanzas: presenceMap.size,
      onlineCount
    };
  } finally {
    socket.end('</stream:stream>');
  }
}

export function mergeRosters(accounts) {
  const merged = new Map();
  for (const account of accounts) {
    for (const friend of account.friends) {
      const key = friend.puuid || friend.riotId.toLowerCase();
      const existing = merged.get(key) || {
        puuid: friend.puuid,
        gameName: friend.gameName,
        tagLine: friend.tagLine,
        riotId: friend.riotId,
        state: friend.state,
        online: friend.online,
        queue: friend.queue,
        product: friend.product,
        details: friend.details,
        groups: friend.groups,
        seenFrom: []
      };
      existing.seenFrom.push({
        accountId: account.accountId,
        label: account.label,
        ...(friend.jid ? { jid: friend.jid } : {})
      });
      if (!existing.gameName && friend.gameName) existing.gameName = friend.gameName;
      if (!existing.tagLine && friend.tagLine) existing.tagLine = friend.tagLine;
      if (!existing.riotId && friend.riotId) existing.riotId = friend.riotId;
      if (!existing.online && friend.online) {
        existing.online = true;
        existing.state = friend.state;
        existing.queue = friend.queue;
        existing.product = friend.product;
        existing.details = friend.details;
      }
      merged.set(key, existing);
    }
  }
  const friends = [...merged.values()];
  decorateFriendActivities(friends);
  return friends.sort(compareMergedFriends);
}

function sourceAccountCount(friend) {
  return Array.isArray(friend?.seenFrom) ? friend.seenFrom.length : 0;
}

export function compareMergedFriends(a, b) {
  if (a.online !== b.online) return a.online ? -1 : 1;
  const stateDelta = presenceSortRank(a) - presenceSortRank(b);
  if (stateDelta !== 0) return stateDelta;
  const sourceDelta = sourceAccountCount(b) - sourceAccountCount(a);
  if (sourceDelta !== 0) return sourceDelta;
  return String(a.riotId || '').localeCompare(String(b.riotId || ''));
}

function presenceSortRank(friend) {
  if (!friend.online) return 99;
  const state = String(friend.state || '').toLowerCase();
  if (state === 'chat' || state === 'online') return 0;
  if (state === 'dnd') return 1;
  if (state === 'away') return 2;
  if (state === 'mobile') return 3;
  return 4;
}

export async function fetchMergedFriendListPoc(labels = ['Umisteba', 'Dr Bonk'], options = {}) {
  const log = options.log ?? (() => {});
  const progress = options.progress;
  const presenceWaitMs = options.presenceWaitMs ?? DEFAULT_PRESENCE_WAIT_MS;
  const parallel = options.parallel === true;
  const accountDelayMs = parallel ? 0 : (options.accountDelayMs ?? DEFAULT_CAREFUL_ACCOUNT_DELAY_MS);
  const startedAt = Date.now();
  const allAccounts = loadAccounts();
  const accountIds = Array.isArray(options.accountIds)
    ? [...new Set(options.accountIds.map(String).filter(Boolean))]
    : [];
  const selected = accountIds.length
    ? accountIds.map((id) => {
      const account = allAccounts.find((item) => item.id === id);
      if (!account) throw new Error(`Account not found: ${id}`);
      return account;
    })
    : labels.map((label) => {
      const account = allAccounts.find((item) => item.label.toLowerCase() === label.toLowerCase());
      if (!account) throw new Error(`Account not found: ${label}`);
      return account;
    });
  if (!selected.length) throw new Error('Select at least one saved account to fetch friends from.');
  const authOverridesByAccountId = options.authOverridesByAccountId instanceof Map
    ? options.authOverridesByAccountId
    : new Map();
  emitProgress(progress, {
    phase: 'refresh-start',
    accountDone: 0,
    accountTotal: selected.length,
    mode: parallel ? 'parallel' : 'sequential',
    message: `Starting friend refresh for ${selected.length} account${selected.length === 1 ? '' : 's'} (${parallel ? 'aggressive parallel' : 'careful sequential'})`
  });
  log(`refresh start: labels=${selected.map((account) => account.label).join(', ')}, presenceWaitMs=${presenceWaitMs}, mode=${parallel ? 'parallel' : 'sequential'}, accountDelayMs=${accountDelayMs}`);
  const preparedAuthByAccountId = parallel
    ? await prepareParallelSavedSessionAuth(
      selected.filter((account) => !authOverridesByAccountId.has(account.id)),
      log
    )
    : new Map();
  let completedCount = 0;
  const fetchOne = async (account, index) => {
    emitProgress(progress, {
      phase: 'account-start',
      accountId: account.id,
      accountLabel: account.label,
      accountIndex: index + 1,
      accountDone: completedCount,
      accountTotal: selected.length,
      message: `Fetching ${index + 1}/${selected.length}: ${account.label}`
    });
    try {
      const value = await fetchRosterForAccount(account, {
        log,
        presenceWaitMs,
        progress,
        accountIndex: index + 1,
        accountTotal: selected.length,
        accountDone: completedCount,
        preparedAuth: preparedAuthByAccountId.get(account.id),
        authOverride: authOverridesByAccountId.get(account.id)
      });
      completedCount += 1;
      emitProgress(progress, {
        phase: 'account-done',
        accountId: account.id,
        accountLabel: account.label,
        accountIndex: index + 1,
        accountDone: completedCount,
        accountTotal: selected.length,
        message: `Finished ${index + 1}/${selected.length}: ${account.label} (${value.onlineCount}/${value.friends.length} online)`
      });
      return { ok: true, value };
    } catch (error) {
      const reason = friendFailureDetails(account, error);
      completedCount += 1;
      log(`account failed for ${account.label}: ${reason.error}`, 'warn');
      emitProgress(progress, {
        phase: 'account-error',
        accountId: account.id,
        accountLabel: account.label,
        accountIndex: index + 1,
        accountDone: completedCount,
        accountTotal: selected.length,
        error: reason.error,
        message: `Failed ${index + 1}/${selected.length}: ${account.label} - ${reason.error}`
      });
      return { ok: false, reason };
    }
  };

  const accounts = [];
  const errors = [];
  if (parallel) {
    const results = await Promise.all(selected.map((account, index) => fetchOne(account, index)));
    for (const result of results) {
      if (result.ok) accounts.push(result.value);
      else errors.push(result.reason);
    }
  }
  if (!parallel) {
    for (const [index, account] of selected.entries()) {
      if (index > 0 && accountDelayMs > 0) {
        log(`careful delay before ${account.label}: delayMs=${accountDelayMs}`);
        emitProgress(progress, {
          phase: 'account-delay',
          accountId: account.id,
          accountLabel: account.label,
          accountIndex: index + 1,
          accountDone: completedCount,
          accountTotal: selected.length,
          message: `Waiting ${formatMaybeMs(accountDelayMs)} before ${index + 1}/${selected.length}: ${account.label}`
        });
        await sleep(accountDelayMs);
      }
      const result = await fetchOne(account, index);
      if (result.ok) accounts.push(result.value);
      else errors.push(result.reason);
    }
  }
  suppressScanSourceAccountPresence(accounts);
  const merged = mergeRosters(accounts);
  const onlineCount = merged.filter((friend) => friend.online).length;
  const elapsedMs = elapsedSince(startedAt);
  emitProgress(progress, {
    phase: 'refresh-done',
    accountDone: completedCount,
    accountTotal: selected.length,
    failedCount: errors.length,
    onlineCount,
    elapsedMs,
    message: `Finished friend refresh: ${accounts.length}/${selected.length} accounts fetched${errors.length ? `, ${errors.length} failed` : ''}`
  });
  log(`refresh done: accounts=${accounts.length}, failed=${errors.length}, merged=${merged.length}, online=${onlineCount}, elapsedMs=${elapsedMs}, mode=${parallel ? 'parallel' : 'sequential'}`);
  return {
    labels: selected.map((account) => account.label),
    accountIds: selected.map((account) => account.id),
    refreshedAt: new Date().toISOString(),
    accounts,
    errors,
    merged,
    onlineCount,
    offlineCount: merged.length - onlineCount,
    presenceWaitMs,
    accountDelayMs,
    elapsedMs,
    mode: parallel ? 'parallel' : 'sequential'
  };
}
