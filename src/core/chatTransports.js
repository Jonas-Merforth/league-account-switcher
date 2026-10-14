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
    this.closed = false;
  }

  async connect() {
    if (this.connected) return this.summary();
    this.credentials = await this.getCredentials(this.accountId);
    if (this.closed) throw new Error('Chat connection was cancelled.');
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
    if (this.closed) { connection.close(); throw new Error('Chat connection was cancelled.'); }
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
    this.closed = true;
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
    if (presence?.puuid) {
      const friend = this.friend(presence.puuid);
      if (friend) Object.assign(friend, presence);
      this.onPresence({ ...friend, ...presence });
    }
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
  const gameName = String(friend.gameName || friend.name || '').trim();
  const tagLine = String(friend.gameTag || friend.tagLine || '').trim();
  const details = friend.lol && typeof friend.lol === 'object' && !Array.isArray(friend.lol)
    ? { ...friend.lol }
    : null;
  if (details && !details.timeStamp && Number(friend.time) > 0) details.timeStamp = Number(friend.time);
  return {
    puuid,
    jid,
    gameName,
    tagLine,
    riotId: tagLine ? `${gameName}#${tagLine}` : gameName,
    online: !['', 'offline'].includes(state),
    state: state || 'offline',
    queue: String(details?.gameQueueType || details?.queueId || '').trim(),
    product: String(friend.product || (details ? 'league_of_legends' : '')).trim(),
    details
  };
}

export class LcuChatTransport {
  constructor({ accountId, lcu, selfPuuid, domain, log, onMessage, onPresence = () => {}, onClose = () => {}, pollMs = LCU_POLL_MS }) {
    this.accountId = accountId;
    this.lcu = lcu.forCurrentSession ? lcu.forCurrentSession() : lcu;
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
    this.friends = new Map();
    this.closed = false;
  }

  async connect() {
    if (this.connected) return this.summary();
    await this._verifyIdentity();
    if (this.closed) throw new Error('Chat connection was cancelled.');
    this.connected = true;
    await this._poll();
    this._schedule();
    return this.summary();
  }

  summary() {
    return { kind: 'lcu', connected: this.connected, roster: this.friends };
  }

  friend(puuid) {
    return this.friends.get(String(puuid || '').toLowerCase()) || null;
  }

  async send({ destinationPuuid, destinationJid, domain, body }) {
    if (!this.connected) await this.connect();
    const jid = await this.openConversation({ destinationPuuid, destinationJid, domain });
    if (this.closed) throw new Error('Chat connection was cancelled.');
    const result = await this.lcu.post(`/lol-chat/v1/conversations/${encodeURIComponent(jid)}/messages`, { type: 'chat', body: String(body) });
    if (!result?.id || result.body !== String(body)) throw new Error('League did not confirm sending the message. Check the client before retrying.');
    return {
      id: String(result.id),
      sentAt: result?.timestamp || result?.createdAt || new Date().toISOString()
    };
  }

  async openConversation({ destinationPuuid, destinationJid, domain }) {
    await this._verifyIdentity();
    const jid = friendBareJid({ destinationPuuid, destinationJid, domain: domain || this.domain });
    if (jid.split('@')[0].toLowerCase() !== String(destinationPuuid).toLowerCase()) throw new Error('Chat recipient identity does not match.');
    const endpoint = `/lol-chat/v1/conversations/${encodeURIComponent(jid)}`;
    let conversation = await this.lcu.get(endpoint);
    if (!conversation) conversation = await this.lcu.post('/lol-chat/v1/conversations', { id: jid, type: 'chat' });
    if (conversation?.id !== jid) throw new Error('League could not open this conversation. The message was not sent.');
    return jid;
  }

  async close() {
    this.closed = true;
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
        if (this.closed) return;
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
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      try {
        const friends = await this.lcu.get('/lol-chat/v1/friends');
        if (this.closed) return;
        const nextFriends = new Map();
        for (const raw of Array.isArray(friends) ? friends : []) {
          const presence = normalizeLcuFriendPresence(raw);
          if (!presence) continue;
          nextFriends.set(presence.puuid, presence);
        }
        this.friends = nextFriends;
        for (const presence of nextFriends.values()) this.onPresence(presence);
      } catch (error) {
        if (error.code === 'LCU_SESSION_CHANGED') throw error;
        this.log(`Chat live-account presence refresh failed: ${error.message}`, 'warn');
      }
      const conversations = await this.lcu.get('/lol-chat/v1/conversations');
      if (this.closed) return;
      for (const conversation of Array.isArray(conversations) ? conversations : []) {
        const id = directConversation(conversation);
        if (!id) continue;
        const firstPoll = !this.initializedConversations.has(id);
        const messages = await this.lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(id)}/messages`);
        if (this.closed) return;
        for (const raw of Array.isArray(messages) ? messages : []) {
          const message = normalizeLcuChatMessage(raw, { selfPuuid: this.selfPuuid, conversationPuuid: id.split('@')[0] });
          const dedupe = `${id}:${message?.id || `${message?.fromPuuid}:${message?.receivedAt}:${message?.body}`}`;
          if (!message || this.seenMessageIds.has(dedupe)) continue;
          this.seenMessageIds.add(dedupe);
          if (this.seenMessageIds.size > 5000) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
          const gameName = String(conversation.gameName || conversation.name || '').trim();
          const tagLine = String(conversation.gameTag || conversation.tagLine || '').trim();
          this.onMessage({
            ...message,
            historical: firstPoll || raw.isHistorical === true,
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

  async _verifyIdentity() {
    const me = await this.lcu.get('/lol-chat/v1/me');
    const puuid = String(me?.puuid || me?.id?.split('@')[0] || '').toLowerCase();
    if (!this.selfPuuid || puuid !== this.selfPuuid) throw new Error('The active League account changed. Reopen this chat.');
  }
}
