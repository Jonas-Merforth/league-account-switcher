import { escapeXmpp, puuidFromJid, unescapeXmpp, xmppAttr } from './queueRelayProtocol.js';

export function chatConversationKey(sourceAccountId, destinationPuuid) {
  const source = String(sourceAccountId || '').trim();
  const destination = String(destinationPuuid || '').trim().toLowerCase();
  if (!source || !destination) return '';
  return `${source}:${destination}`;
}

export function buildChatPresence() {
  // A bare XMPP presence is enough to route messages, but League's friend UI only treats a resource
  // as visibly online when it carries League product presence. Keep the payload deliberately minimal:
  // this helper is available for chat, but it is not pretending to be in a lobby or game.
  const details = Buffer.from(JSON.stringify({ gameStatus: 'outOfGame' }), 'utf8').toString('base64');
  return '<presence><show>chat</show><games><league_of_legends>'
    + `<st>chat</st><s.p>league_of_legends</s.p><p>${details}</p>`
    + '</league_of_legends></games><priority>0</priority></presence>';
}

export function buildChatUnavailablePresence() {
  return '<presence type="unavailable"/>';
}

export function friendBareJid({ destinationPuuid, destinationJid, domain }) {
  const explicit = String(destinationJid || '').trim().split('/')[0];
  if (explicit) return explicit;
  const puuid = String(destinationPuuid || '').trim().toLowerCase();
  const xmppDomain = String(domain || '').trim();
  if (!puuid || !xmppDomain) throw new Error('A friend PUUID and XMPP domain are required.');
  return `${puuid}@${xmppDomain}`;
}

export function buildChatMessage({ id, destinationPuuid, destinationJid, domain, body }) {
  const message = String(body ?? '').trim();
  if (!message) throw new Error('Enter a message first.');
  const to = friendBareJid({ destinationPuuid, destinationJid, domain });
  return `<message id="${escapeXmpp(id)}" to="${escapeXmpp(to)}" type="chat"><active xmlns="http://jabber.org/protocol/chatstates"/><body>${escapeXmpp(message)}</body></message>`;
}

export function parseChatMessage(stanza) {
  const source = String(stanza || '');
  const opening = source.match(/^<message\b([^>]*)>/i);
  if (!opening) return null;
  const type = xmppAttr(opening[1], 'type').toLowerCase();
  if (type && type !== 'chat' && type !== 'normal') return null;
  const bodyMatch = source.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return null;
  const from = xmppAttr(opening[1], 'from');
  const to = xmppAttr(opening[1], 'to');
  const delayAttrs = source.match(/<delay\b([^>]*)\/?\s*>/i)?.[1] || '';
  const delayedAt = xmppAttr(delayAttrs, 'stamp');
  const receivedAt = Number.isFinite(Date.parse(delayedAt)) ? new Date(delayedAt).toISOString() : new Date().toISOString();
  return {
    id: xmppAttr(opening[1], 'id'),
    from,
    to,
    fromPuuid: puuidFromJid(from),
    toPuuid: puuidFromJid(to),
    body: unescapeXmpp(bodyMatch[1]),
    receivedAt,
    delayed: Boolean(delayedAt)
  };
}

export function normalizeLcuChatMessage(message, { selfPuuid = '', conversationPuuid = '' } = {}) {
  if (!message || typeof message !== 'object') return null;
  const body = String(message.body ?? message.message ?? '');
  if (!body) return null;
  const fromPuuid = String(message.fromId || message.fromPuuid || message.senderId || '').split('@')[0].toLowerCase();
  const self = String(selfPuuid || '').toLowerCase();
  const incoming = Boolean(fromPuuid && fromPuuid !== self);
  const timestamp = message.timestamp || message.createdAt || message.time;
  return {
    id: String(message.id || ''),
    fromPuuid: incoming ? fromPuuid : self,
    toPuuid: incoming ? self : String(conversationPuuid || '').toLowerCase(),
    body,
    receivedAt: Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString(),
    incoming
  };
}
