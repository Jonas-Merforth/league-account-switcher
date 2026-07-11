export const QUEUE_RELAY_NAMESPACE = 'urn:league-account-switcher:queue-relay:1';
export const QUEUE_RELAY_VERSION = 1;
export const QUEUE_RELAY_REQUEST_TTL_MS = 10_000;

function text(value) {
  return String(value ?? '').trim();
}

export function escapeXmpp(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;'
  }[char]));
}

export function unescapeXmpp(value) {
  return String(value ?? '').replace(/&(amp|lt|gt|apos|quot|#x([0-9a-f]+)|#(\d+));/gi, (match, named, hex, dec) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return ({ amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' }[named.toLowerCase()] ?? match);
  });
}

export function xmppAttr(source, name) {
  const match = String(source || '').match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return unescapeXmpp(match?.[1] ?? match?.[2] ?? '');
}

export function puuidFromJid(jid) {
  return text(jid).split('/')[0].split('@')[0].toLowerCase();
}

export function resourceFromJid(jid) {
  const value = text(jid);
  const slash = value.indexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : '';
}

export function shortPeerId(value) {
  const id = puuidFromJid(value) || text(value);
  return id ? id.slice(0, 8) : 'unknown';
}

export function buildRelayPresence() {
  // Negative priority prevents a standards-compliant server from preferring this helper resource
  // for ordinary bare-JID chats. Relay traffic targets its exact full JID after discovery.
  return '<presence><priority>-1</priority></presence>';
}

export function buildCapabilityProbe({ id, to }) {
  return `<iq type="get" id="${escapeXmpp(id)}" to="${escapeXmpp(to)}"><queue-relay xmlns="${QUEUE_RELAY_NAMESPACE}" version="${QUEUE_RELAY_VERSION}"/></iq>`;
}

export function buildCapabilityResponse({ id, to, instanceId, allowed }) {
  return `<iq type="result" id="${escapeXmpp(id)}" to="${escapeXmpp(to)}"><queue-relay xmlns="${QUEUE_RELAY_NAMESPACE}" version="${QUEUE_RELAY_VERSION}" instance="${escapeXmpp(instanceId)}" allowed="${allowed ? 'true' : 'false'}"/></iq>`;
}

export function buildQueueStartRequest({ id, to, requestId, partyId, senderPuuid, createdAt, expiresAt }) {
  return `<iq type="set" id="${escapeXmpp(id)}" to="${escapeXmpp(to)}"><queue-start xmlns="${QUEUE_RELAY_NAMESPACE}" version="${QUEUE_RELAY_VERSION}" request-id="${escapeXmpp(requestId)}" party-id="${escapeXmpp(partyId)}" sender-puuid="${escapeXmpp(senderPuuid)}" created-at="${escapeXmpp(createdAt)}" expires-at="${escapeXmpp(expiresAt)}"/></iq>`;
}

export function buildQueueStartResponse({ id, to, requestId, ok, code, message }) {
  return `<iq type="result" id="${escapeXmpp(id)}" to="${escapeXmpp(to)}"><queue-start-result xmlns="${QUEUE_RELAY_NAMESPACE}" version="${QUEUE_RELAY_VERSION}" request-id="${escapeXmpp(requestId)}" ok="${ok ? 'true' : 'false'}" code="${escapeXmpp(code)}" message="${escapeXmpp(message)}"/></iq>`;
}

// Extract complete top-level stanzas from an arbitrary sequence of TLS chunks. Stream headers and
// whitespace before a stanza are discarded; an incomplete final stanza is retained for next time.
export function extractXmppStanzas(input) {
  let remainder = String(input || '');
  const stanzas = [];
  while (remainder) {
    const start = /<(presence|iq|message)\b/i.exec(remainder);
    if (!start) {
      // Keep a small suffix in case the next chunk completes a split opening tag.
      return { stanzas, remainder: remainder.slice(-32) };
    }
    remainder = remainder.slice(start.index);
    const tag = start[1].toLowerCase();
    const openEnd = remainder.indexOf('>');
    if (openEnd < 0) return { stanzas, remainder };
    if (/\/\s*>$/.test(remainder.slice(0, openEnd + 1))) {
      stanzas.push(remainder.slice(0, openEnd + 1));
      remainder = remainder.slice(openEnd + 1);
      continue;
    }
    const closing = `</${tag}>`;
    const closeAt = remainder.toLowerCase().indexOf(closing, openEnd + 1);
    if (closeAt < 0) return { stanzas, remainder };
    const end = closeAt + closing.length;
    stanzas.push(remainder.slice(0, end));
    remainder = remainder.slice(end);
  }
  return { stanzas, remainder };
}

export function parsePresenceResource(stanza) {
  const opening = String(stanza || '').match(/^<presence\b([^>]*)>/i);
  if (!opening) return null;
  const from = xmppAttr(opening[1], 'from');
  if (!from) return null;
  return {
    from,
    puuid: puuidFromJid(from),
    resource: resourceFromJid(from),
    unavailable: xmppAttr(opening[1], 'type').toLowerCase() === 'unavailable'
  };
}

export function parseRelayIq(stanza) {
  const source = String(stanza || '');
  const opening = source.match(/^<iq\b([^>]*)>/i);
  if (!opening) return null;
  const outer = opening[1];
  const base = {
    id: xmppAttr(outer, 'id'),
    from: xmppAttr(outer, 'from'),
    to: xmppAttr(outer, 'to'),
    type: xmppAttr(outer, 'type').toLowerCase(),
    fromPuuid: puuidFromJid(xmppAttr(outer, 'from')),
    kind: 'other',
    payload: {}
  };
  for (const [kind, tag] of [
    ['capability', 'queue-relay'],
    ['queue-start-result', 'queue-start-result'],
    ['queue-start', 'queue-start']
  ]) {
    const child = source.match(new RegExp(`<${tag}\\b([^>]*)`, 'i'));
    if (!child || xmppAttr(child[1], 'xmlns') !== QUEUE_RELAY_NAMESPACE) continue;
    const attrs = child[1];
    return {
      ...base,
      kind,
      payload: {
        version: Number(xmppAttr(attrs, 'version')) || 0,
        instanceId: xmppAttr(attrs, 'instance'),
        allowed: xmppAttr(attrs, 'allowed') === 'true',
        requestId: xmppAttr(attrs, 'request-id'),
        partyId: xmppAttr(attrs, 'party-id'),
        senderPuuid: xmppAttr(attrs, 'sender-puuid').toLowerCase(),
        createdAt: xmppAttr(attrs, 'created-at'),
        expiresAt: xmppAttr(attrs, 'expires-at'),
        ok: xmppAttr(attrs, 'ok') === 'true',
        code: xmppAttr(attrs, 'code'),
        message: xmppAttr(attrs, 'message')
      }
    };
  }
  return base;
}

export function parseRelayRoster(xml) {
  const friends = new Map();
  const itemRe = /<item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/item>)/gi;
  for (const match of String(xml || '').matchAll(itemRe)) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const jid = xmppAttr(attrs, 'jid');
    const puuid = (xmppAttr(attrs, 'puuid') || puuidFromJid(jid)).toLowerCase();
    if (!puuid) continue;
    const idAttrs = body.match(/<id\b([^/>]*)\/>/i)?.[1] || '';
    const gameName = xmppAttr(idAttrs, 'name') || xmppAttr(attrs, 'name');
    const tagLine = xmppAttr(idAttrs, 'tagline');
    friends.set(puuid, {
      puuid,
      jid,
      gameName,
      tagLine,
      riotId: gameName && tagLine ? `${gameName}#${tagLine}` : gameName || shortPeerId(puuid)
    });
  }
  return friends;
}

function memberPuuid(member) {
  return text(member?.puuid).toLowerCase();
}

function memberIsLeader(member) {
  const role = text(member?.role).toUpperCase();
  return member?.isLeader === true || role === 'LEADER' || role === '0';
}

function memberName(member) {
  const gameName = text(member?.gameName || member?.displayName || member?.summonerName);
  const tagLine = text(member?.tagLine);
  return gameName && tagLine ? `${gameName}#${tagLine}` : gameName;
}

export function summarizeQueueRelayLobby(phase, lobby) {
  const phaseText = text(phase);
  if (phaseText !== 'Lobby' || !lobby) {
    return {
      inLobby: false,
      phase: phaseText || null,
      partyId: '',
      queueId: null,
      canStartActivity: false,
      localPuuid: '',
      localIsLeader: false,
      leaderPuuid: '',
      members: [],
      restrictions: []
    };
  }
  const candidates = Array.isArray(lobby.members) ? lobby.members : [];
  const local = lobby.localMember || candidates.find((member) => member?.isLocal) || {};
  const byPuuid = new Map();
  for (const member of [local, ...candidates]) {
    const puuid = memberPuuid(member);
    if (puuid) byPuuid.set(puuid, member);
  }
  const members = [...byPuuid.values()].map((member) => ({
    puuid: memberPuuid(member),
    isLeader: memberIsLeader(member),
    ready: member?.ready ?? member?.memberData?.ready ?? null,
    riotId: memberName(member)
  }));
  const localPuuid = memberPuuid(local);
  const leader = members.find((member) => member.isLeader) || null;
  return {
    inLobby: true,
    phase: phaseText,
    partyId: text(lobby.partyId || lobby.currentParty?.partyId),
    queueId: Number(lobby.gameConfig?.queueId) || null,
    canStartActivity: lobby.canStartActivity === true,
    localPuuid,
    localIsLeader: memberIsLeader(local),
    leaderPuuid: leader?.puuid || '',
    members,
    restrictions: Array.isArray(lobby.restrictions) ? lobby.restrictions : []
  };
}

export function validateQueueStartRequest({ request, fromPuuid, lobby, allowedPuuids, now = Date.now() }) {
  const allowed = new Set((allowedPuuids || []).map((value) => text(value).toLowerCase()).filter(Boolean));
  const sender = text(fromPuuid).toLowerCase();
  const reject = (code, message) => ({ ok: false, code, message });
  if (!sender || !allowed.has(sender)) return reject('not-allowed', 'This friend is not allowed to start your queue.');
  if (!request?.requestId) return reject('invalid-request', 'The request has no ID.');
  if (text(request.senderPuuid).toLowerCase() !== sender) return reject('sender-mismatch', 'The request sender does not match the Riot XMPP identity.');
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now + 5_000 || expiresAt < now || expiresAt - createdAt > QUEUE_RELAY_REQUEST_TTL_MS + 1_000) {
    return reject('expired', 'The queue request is stale or has invalid timing.');
  }
  if (!lobby?.inLobby || lobby.phase !== 'Lobby') return reject('not-in-lobby', 'The leader is not in a League lobby.');
  if (!lobby.localIsLeader) return reject('not-leader', 'This client is not the lobby leader.');
  if (!lobby.partyId || text(request.partyId) !== lobby.partyId) return reject('party-mismatch', 'The lobby changed before the request arrived.');
  if (!lobby.members?.some((member) => member.puuid === sender)) return reject('sender-not-in-party', 'The requester is not in the leader\'s current lobby.');
  if (!lobby.queueId) return reject('queue-not-selected', 'The lobby does not have a matchmaking queue selected.');
  if (!lobby.canStartActivity) return reject('lobby-not-ready', 'The League lobby is not ready to start matchmaking.');
  if ((lobby.restrictions || []).length) return reject('lobby-restricted', 'The League lobby has active restrictions.');
  return { ok: true, code: 'accepted', message: 'Queue start request accepted.' };
}
