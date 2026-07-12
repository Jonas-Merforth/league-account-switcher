import crypto from 'node:crypto';

import {
  buildChatMessage,
  buildChatPresence,
  buildChatUnavailablePresence,
  friendBareJid,
  normalizeLcuChatMessage,
  parseChatMessage
} from './chatProtocol.js';
import { parsePresenceStanzas } from './friendPresencePoc.js';
import { RiotXmppConnection } from './riotXmppConnection.js';

const LCU_POLL_MS = 1_000;

export class DirectXmppChatTransport {
  constructor({ accountId, getCredentials, log, onMessage, onPresence = () => {}, onClose = () => {} }) {
    this.accountId = accountId;
    this.getCredentials = getCredentials;
    this.log = log;
    this.onMessage = onMessage;
    this.onPresence = onPresence;
    this.onClose = onClose;
    this.connection = null;
    this.credentials = null;
    this.roster = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return this.summary();
    this.credentials = await this.getCredentials(this.accountId);
    const connection = new RiotXmppConnection({
      credentials: this.credentials,
      log: this.log,
      logLabel: `Chat account=${this.accountId.slice(0, 8)}`,
      initialPresence: buildChatPresence(),
      onStanza: (stanza) => this._handleStanza(stanza),
      onClose: (error) => {
        this.connected = false;
        this.onClose(error);
      }
    });
    this.connection = connection;
    const result = await connection.connect();
    this.roster = result.roster;
    this.connected = true;
    return this.summary();
  }

  summary() {
    return { kind: 'xmpp', connected: this.connected, roster: this.roster, boundJid: this.connection?.boundJid || '' };
  }

  friend(puuid) {
    return this.roster.get(String(puuid || '').toLowerCase()) || null;
  }

  async send({ destinationPuuid, destinationJid, body, id = crypto.randomUUID() }) {
    if (!this.connected) await this.connect();
    const domain = this.credentials?.endpoint?.domain;
    await this.connection.send(buildChatMessage({ id, destinationPuuid, destinationJid, domain, body }));
    return { id, sentAt: new Date().toISOString() };
  }

  async close(reason = 'idle lease expired') {
    const connection = this.connection;
    this.connection = null;
    this.connected = false;
    if (!connection) return;
    try { await connection.send(buildChatUnavailablePresence()); } catch {}
    connection.close(reason);
  }

  _handleStanza(stanza) {
    const message = parseChatMessage(stanza);
    if (message?.body) {
      const friend = this.friend(message.fromPuuid);
      this.onMessage({ ...message, incoming: true, friend });
      return;
    }
    const presence = parsePresenceStanzas(stanza)[0];
    if (presence?.puuid) this.onPresence(presence);
  }
}

function directConversation(conversation) {
  const id = String(conversation?.id || '').trim();
  if (!id || /@lol-(?:pre-game|champ-select)/i.test(id)) return null;
  const type = String(conversation?.type || '').toLowerCase();
  if (type && type !== 'chat') return null;
  return id;
}

export function normalizeLcuFriendPresence(friend = {}) {
  const jid = String(friend.id || friend.jid || '').trim();
  const puuid = String(friend.puuid || jid.split('@')[0] || '').trim().toLowerCase();
  if (!puuid) return null;
  const state = String(friend.availability || friend.state || 'offline').trim().toLowerCase();
  return {
    puuid,
    online: !['', 'offline'].includes(state),
    state: state || 'offline'
  };
}

export class LcuChatTransport {
  constructor({ accountId, lcu, selfPuuid, domain, log, onMessage, onPresence = () => {}, onClose = () => {}, pollMs = LCU_POLL_MS }) {
    this.accountId = accountId;
    this.lcu = lcu;
    this.selfPuuid = String(selfPuuid || '').toLowerCase();
    this.domain = String(domain || '').trim();
    this.log = log;
    this.onMessage = onMessage;
    this.onPresence = onPresence;
    this.onClose = onClose;
    this.pollMs = pollMs;
    this.connected = false;
    this.timer = null;
    this.polling = false;
    this.seenMessageIds = new Set();
    this.initializedConversations = new Set();
  }

  async connect() {
    if (this.connected) return this.summary();
    await this.lcu.get('/lol-chat/v1/me');
    this.connected = true;
    await this._poll();
    this._schedule();
    return this.summary();
  }

  summary() {
    return { kind: 'lcu', connected: this.connected, roster: new Map() };
  }

  friend() {
    return null;
  }

  async send({ destinationPuuid, destinationJid, domain, body }) {
    if (!this.connected) await this.connect();
    const jid = friendBareJid({ destinationPuuid, destinationJid, domain });
    const result = await this.lcu.post(`/lol-chat/v1/conversations/${encodeURIComponent(jid)}/messages`, { body: String(body) });
    return {
      id: String(result?.id || crypto.randomUUID()),
      sentAt: result?.timestamp || result?.createdAt || new Date().toISOString()
    };
  }

  async close() {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule() {
    if (!this.connected || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this._poll();
      } catch (error) {
        this.log(`Chat live-account poll failed: ${error.message}`, 'warn');
        this.connected = false;
        this.onClose(error);
        return;
      }
      this._schedule();
    }, this.pollMs);
    this.timer.unref?.();
  }

  async _poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      try {
        const friends = await this.lcu.get('/lol-chat/v1/friends');
        for (const raw of Array.isArray(friends) ? friends : []) {
          const presence = normalizeLcuFriendPresence(raw);
          if (presence) this.onPresence(presence);
        }
      } catch (error) {
        this.log(`Chat live-account presence refresh failed: ${error.message}`, 'warn');
      }
      const conversations = await this.lcu.get('/lol-chat/v1/conversations');
      for (const conversation of Array.isArray(conversations) ? conversations : []) {
        const id = directConversation(conversation);
        if (!id) continue;
        const firstPoll = !this.initializedConversations.has(id);
        const messages = await this.lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(id)}/messages`);
        for (const raw of Array.isArray(messages) ? messages : []) {
          const message = normalizeLcuChatMessage(raw, { selfPuuid: this.selfPuuid, conversationPuuid: id.split('@')[0] });
          const dedupe = message?.id || `${id}:${message?.receivedAt}:${message?.body}`;
          if (!message || this.seenMessageIds.has(dedupe)) continue;
          this.seenMessageIds.add(dedupe);
          const gameName = String(conversation.gameName || conversation.name || '').trim();
          const tagLine = String(conversation.gameTag || conversation.tagLine || '').trim();
          this.onMessage({
            ...message,
            historical: firstPoll,
            conversationJid: id,
            friend: {
              puuid: id.split('@')[0],
              jid: id,
              gameName,
              tagLine,
              riotId: tagLine ? `${gameName}#${tagLine}` : gameName
            }
          });
        }
        this.initializedConversations.add(id);
      }
    } finally {
      this.polling = false;
    }
  }
}
