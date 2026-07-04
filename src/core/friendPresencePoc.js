import tls from 'node:tls';
import { loadAccounts, readSnapshot } from './accountStore.js';
import { dpapiUnprotect } from './secrets.js';

const AUTH_URL = 'https://auth.riotgames.com/api/v1/authorization';
const USERINFO_URL = 'https://auth.riotgames.com/userinfo';
const ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1';
const PAS_CHAT_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
const RIOT_CLIENT_UA = 'RiotClient/90.0.0 rso-auth (Windows;10;;Professional, x64)';
const XMPP_PORT = 5223;
const DEFAULT_PRESENCE_WAIT_MS = 1_000;
const DEFAULT_CAREFUL_ACCOUNT_DELAY_MS = 1_000;

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
    const puuid = attr(attrs, 'puuid') || attr(attrs, 'jid').split('@')[0];
    const gameName = attr(idAttrs, 'name') || attr(lolAttrs, 'name') || attr(riotAttrs, 'name') || attr(attrs, 'name');
    const tagLine = attr(idAttrs, 'tagline') || attr(riotAttrs, 'tagline');
    const state = unescapeXml(body.match(/<state>([^<]*)<\/state>/i)?.[1] || '');
    const groups = [...body.matchAll(/<group[^>]*>([^<]*)<\/group>/g)].map((group) => unescapeXml(group[1]));
    const riotId = tagLine ? `${gameName}#${tagLine}` : gameName;
    friends.push({ puuid, gameName, tagLine, riotId, state: state || 'offline', online: false, groups });
  }
  return friends;
}

function parseLeaguePresence(body) {
  const league = body.match(/<league_of_legends\b[^>]*>([\s\S]*?)<\/league_of_legends>/i)?.[1] || '';
  const state = unescapeXml(league.match(/<st>([^<]*)<\/st>/i)?.[1] || '');
  const queue = unescapeXml(league.match(/<s\.q>([^<]*)<\/s\.q>/i)?.[1] || '');
  const product = unescapeXml(league.match(/<s\.p>([^<]*)<\/s\.p>/i)?.[1] || '');
  let details = null;
  const encoded = league.match(/<p>([\s\S]*?)<\/p>/i)?.[1];
  if (encoded) {
    try {
      details = JSON.parse(unescapeXml(encoded));
    } catch {
      details = null;
    }
  }
  return { state, queue, product, details };
}

function parsePresenceStanzas(xml) {
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
      throw new Error(`Timed out waiting for ${marker}; received ${out.length} bytes.`);
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

async function getSavedSessionAuth(account, log) {
  const authStartedAt = Date.now();
  log(`auth start for ${account.label}`);
  const sessionStartedAt = Date.now();
  const decrypted = await dpapiUnprotect(readSnapshot(account.id));
  const manifest = JSON.parse(decrypted);
  const yaml = Buffer.from(manifest['Data/RiotGamesPrivateSettings.yaml'] || '', 'base64').toString('utf8');
  const cookies = parseAuthCookiesFromRiotYaml(yaml);
  if (!cookies.some((cookie) => cookie.name === 'ssid')) {
    throw new Error('No ssid cookie in saved session.');
  }
  const sessionMs = elapsedSince(sessionStartedAt);

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
      throw new Error('Saved session requires interactive Riot auth (expired, signed out, or 2FA challenge); the Riot Client may still be logged in, but this Friends PoC cannot replay that saved session.');
    }
    throw new Error(`Saved session was not accepted by Riot auth (${type}).`);
  }
  log(`auth accepted for ${account.label}: sessionMs=${sessionMs}, authPostMs=${elapsedSince(authPostStartedAt)}, authElapsedMs=${elapsedSince(authStartedAt)}`);

  const tokenStartedAt = Date.now();
  const [entitlements, pasToken, userInfo] = await Promise.all([
    fetch(ENTITLEMENTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    }).then((response) => response.json()),
    fetch(PAS_CHAT_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((response) => response.text()),
    fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } }).then((response) => response.json())
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

async function fetchRosterForAccount(account, { log, presenceWaitMs, progress, accountIndex, accountTotal, accountDone }) {
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
  stepProgress('account-auth', 'authenticating saved session');
  const auth = await getSavedSessionAuth(account, log);
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
      if (/<failure|<stream:error/.test(response)) throw new Error('XMPP authentication failed.');
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
      friends,
      presenceStanzas: presenceMap.size,
      onlineCount
    };
  } finally {
    socket.end('</stream:stream>');
  }
}

function mergeRosters(accounts) {
  const merged = new Map();
  for (const account of accounts) {
    for (const friend of account.friends) {
      const key = friend.puuid || friend.riotId.toLowerCase();
      const existing = merged.get(key) || {
        puuid: friend.puuid,
        riotId: friend.riotId,
        state: friend.state,
        online: friend.online,
        queue: friend.queue,
        product: friend.product,
        details: friend.details,
        groups: friend.groups,
        seenFrom: []
      };
      existing.seenFrom.push(account.label);
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
  return [...merged.values()].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const stateDelta = presenceSortRank(a) - presenceSortRank(b);
    if (stateDelta !== 0) return stateDelta;
    return a.riotId.localeCompare(b.riotId);
  });
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
  emitProgress(progress, {
    phase: 'refresh-start',
    accountDone: 0,
    accountTotal: selected.length,
    mode: parallel ? 'parallel' : 'sequential',
    message: `Starting friend refresh for ${selected.length} account${selected.length === 1 ? '' : 's'} (${parallel ? 'aggressive parallel' : 'careful sequential'})`
  });
  log(`refresh start: labels=${selected.map((account) => account.label).join(', ')}, presenceWaitMs=${presenceWaitMs}, mode=${parallel ? 'parallel' : 'sequential'}, accountDelayMs=${accountDelayMs}`);
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
        accountDone: completedCount
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
      const reason = {
        accountId: account.id,
        label: account.label,
        error: error.message || String(error)
      };
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
