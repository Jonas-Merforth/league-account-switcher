import crypto from 'node:crypto';

import { chatConversationKey } from './chatProtocol.js';
import { buildFriendActivity } from './friendPresencePoc.js';

export const DEFAULT_CHAT_ONLINE_LEASE_MS = 3 * 60_000;
const MAX_MESSAGES_PER_CONVERSATION = 200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanFriend(friend = {}) {
  return {
    puuid: String(friend.puuid || '').trim().toLowerCase(),
    jid: String(friend.jid || '').trim(),
    riotId: String(friend.riotId || friend.gameName || '').trim(),
    gameName: String(friend.gameName || '').trim(),
    tagLine: String(friend.tagLine || '').trim()
  };
}

function friendNames(roster) {
  const names = new Map();
  if (!(roster instanceof Map)) return names;
  for (const [key, friend] of roster.entries()) {
    const puuid = String(friend?.puuid || key || '').trim().toLowerCase();
    const name = String(friend?.riotId || friend?.gameName || '').trim();
    if (puuid && name) names.set(puuid, name);
  }
  return names;
}

function applyFriendPresence(conversation, presence = {}, namesByPuuid = new Map()) {
  const online = Boolean(presence.online);
  const details = presence.details && typeof presence.details === 'object'
    ? { ...presence.details }
    : null;
  if (details && presence.queue && !details.gameQueueType && !details.queueId) {
    details.gameQueueType = String(presence.queue);
  }
  conversation.friendOnline = online;
  conversation.friendState = String(presence.state || (online ? 'chat' : 'offline')).trim().toLowerCase();
  conversation.friendQueue = String(presence.queue || '').trim();
  conversation.friendProduct = String(presence.product || '').trim();
  conversation.friendActivity = presence.activity && typeof presence.activity === 'object'
    ? clone(presence.activity)
    : buildFriendActivity({
        puuid: conversation.destinationPuuid,
        online,
        state: conversation.friendState,
        queue: conversation.friendQueue,
        product: conversation.friendProduct,
        details
      }, { namesByPuuid });
}

export class ChatService {
  constructor({
    getAccount,
    createTransport,
    getLeaseMs = () => DEFAULT_CHAT_ONLINE_LEASE_MS,
    onEvent = () => {},
    onChanged = () => {},
    log = () => {},
    now = () => Date.now()
  }) {
    this.getAccount = getAccount;
    this.createTransport = createTransport;
    this.getLeaseMs = getLeaseMs;
    this.onEvent = onEvent;
    this.onChanged = onChanged;
    this.log = log;
    this.now = now;
    this.conversations = new Map();
    this.sources = new Map();
    this.sourceActivations = new Map();
    this.sourceEpoch = 0;
    this.friendPresenceByPuuid = new Map();
    this.canonicalFriendPresenceByPuuid = new Map();
    this.activeKey = '';
    this.viewActive = false;
  }

  hydrate(state = {}) {
    this.conversations.clear();
    this.friendPresenceByPuuid.clear();
    this.canonicalFriendPresenceByPuuid.clear();
    for (const raw of Array.isArray(state.conversations) ? state.conversations : []) {
      const key = chatConversationKey(raw.sourceAccountId, raw.destinationPuuid);
      if (!key) continue;
      this.conversations.set(key, {
        key,
        sourceAccountId: String(raw.sourceAccountId),
        sourceLabel: String(raw.sourceLabel || ''),
        destinationPuuid: String(raw.destinationPuuid).toLowerCase(),
        destinationJid: String(raw.destinationJid || ''),
        destinationRiotId: String(raw.destinationRiotId || raw.destinationPuuid),
        friendOnline: false,
        friendState: 'offline',
        friendQueue: '',
        friendProduct: '',
        friendActivity: { kind: 'offline', label: 'Offline' },
        connectionState: 'offline',
        connectionError: '',
        unreadCount: Math.max(0, Number(raw.unreadCount) || 0),
        draft: String(raw.draft || ''),
        open: raw.open !== false,
        updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
        messages: (Array.isArray(raw.messages) ? raw.messages : []).slice(-MAX_MESSAGES_PER_CONVERSATION)
      });
    }
    const preferred = String(state.activeKey || '');
    this.activeKey = this.conversations.has(preferred) ? preferred : (this.listConversations()[0]?.key || '');
  }

  snapshot() {
    const conversations = this.listConversations();
    return {
      activeKey: this.activeKey,
      unreadCount: conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0),
      conversations
    };
  }

  persistedState() {
    return { activeKey: this.activeKey, conversations: this.listConversations() };
  }

  listConversations() {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.open)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(clone);
  }

  async openConversation({ sourceAccountId, friend }) {
    const account = this.getAccount(sourceAccountId);
    if (!account) throw new Error('Source account not found.');
    const destination = cleanFriend(friend);
    if (!destination.puuid) throw new Error('This friend has no Riot PUUID.');
    const key = chatConversationKey(account.id, destination.puuid);
    const existing = this.conversations.get(key);
    const conversation = existing || {
      key,
      sourceAccountId: account.id,
      sourceLabel: account.label,
      destinationPuuid: destination.puuid,
      destinationJid: destination.jid,
      destinationRiotId: destination.riotId || destination.puuid,
      friendOnline: false,
      friendState: 'offline',
      friendQueue: '',
      friendProduct: '',
      friendActivity: { kind: 'offline', label: 'Offline' },
      connectionState: 'connecting',
      connectionError: '',
      unreadCount: 0,
      draft: '',
      open: true,
      updatedAt: new Date(this.now()).toISOString(),
      messages: []
    };
    applyFriendPresence(conversation, friend);
    if (friend?.canonicalPresence) {
      this.canonicalFriendPresenceByPuuid.set(destination.puuid, clone({ ...friend, puuid: destination.puuid }));
    }
    const sharedPresence = this.canonicalFriendPresenceByPuuid.get(destination.puuid)
      || this.friendPresenceByPuuid.get(destination.puuid);
    if (sharedPresence) applyFriendPresence(conversation, sharedPresence);
    conversation.open = true;
    conversation.sourceLabel = account.label;
    conversation.destinationJid ||= destination.jid;
    conversation.destinationRiotId = destination.riotId || conversation.destinationRiotId;
    this.conversations.set(key, conversation);
    this.activeKey = key;
    conversation.unreadCount = 0;
    const source = await this._activateSource(account.id);
    const roster = source.transport.summary?.().roster;
    if (roster instanceof Map && roster.size > 0 && !roster.has(destination.puuid)) {
      conversation.connectionState = 'error';
      conversation.connectionError = `${conversation.destinationRiotId} is not friends with ${account.label}.`;
      this._changed('conversation-invalid-friend');
      throw new Error(conversation.connectionError);
    }
    const rosterFriend = source.transport.friend?.(destination.puuid);
    if (rosterFriend) {
      conversation.destinationJid ||= rosterFriend.jid || '';
      conversation.destinationRiotId = rosterFriend.riotId || conversation.destinationRiotId;
      if (typeof rosterFriend.online === 'boolean' || rosterFriend.state) {
        applyFriendPresence(conversation, rosterFriend, friendNames(roster));
      }
    }
    this._changed('conversation-opened');
    return this.snapshot();
  }

  async selectConversation(key) {
    const conversation = this._conversation(key);
    this.activeKey = conversation.key;
    conversation.unreadCount = 0;
    await this._activateSource(conversation.sourceAccountId);
    this._changed('conversation-selected');
    return this.snapshot();
  }

  setViewActive(active) {
    this.viewActive = Boolean(active);
    if (this.viewActive && this.activeKey && this.conversations.has(this.activeKey)) {
      this.conversations.get(this.activeKey).unreadCount = 0;
      this._changed('view-active');
    }
    return this.snapshot();
  }

  setDraft(key, draft) {
    const conversation = this._conversation(key);
    conversation.draft = String(draft || '').slice(0, 4_000);
    this._changed('draft');
    return this.snapshot();
  }

  refreshActiveLeases() {
    for (const sourceAccountId of this.sources.keys()) this._touchSource(sourceAccountId);
    this._changed('lease-setting-changed');
    return this.snapshot();
  }

  setCanonicalFriendPresences(friends = []) {
    const canonical = new Map();
    for (const friend of Array.isArray(friends) ? friends : []) {
      const puuid = String(friend?.puuid || '').trim().toLowerCase();
      if (!puuid) continue;
      canonical.set(puuid, clone({ ...friend, puuid }));
    }
    this.canonicalFriendPresenceByPuuid = canonical;
    for (const conversation of this.conversations.values()) {
      const presence = canonical.get(conversation.destinationPuuid)
        || this.friendPresenceByPuuid.get(conversation.destinationPuuid)
        || { online: false, state: 'offline' };
      applyFriendPresence(conversation, presence);
    }
    this._changed('canonical-friend-presence');
    return this.snapshot();
  }

  closeConversation(key) {
    const conversation = this._conversation(key);
    conversation.open = false;
    conversation.unreadCount = 0;
    if (this.activeKey === key) this.activeKey = this.listConversations()[0]?.key || '';
    this._changed('conversation-closed');
    return this.snapshot();
  }

  async sendMessage(key, body) {
    const conversation = this._conversation(key);
    const messageBody = String(body || '').trim();
    if (!messageBody) throw new Error('Enter a message first.');
    const source = await this._activateSource(conversation.sourceAccountId);
    const result = await source.transport.send({
      destinationPuuid: conversation.destinationPuuid,
      destinationJid: conversation.destinationJid,
      domain: source.domain,
      body: messageBody
    });
    this._appendMessage(conversation, {
      id: result.id || crypto.randomUUID(),
      body: messageBody,
      incoming: false,
      sentAt: result.sentAt || new Date(this.now()).toISOString(),
      receivedAt: result.sentAt || new Date(this.now()).toISOString(),
      status: 'sent'
    });
    conversation.draft = '';
    this._touchSource(conversation.sourceAccountId);
    this._changed('message-sent');
    return this.snapshot();
  }

  async stop() {
    this.sourceEpoch += 1;
    this.sourceActivations.clear();
    const closing = [...this.sources.values()].map((source) => source.transport.close('app exit'));
    for (const source of this.sources.values()) if (source.timer) clearTimeout(source.timer);
    this.sources.clear();
    await Promise.allSettled(closing);
  }

  async disconnectSources(reason = 'chat transports reset') {
    this.sourceEpoch += 1;
    this.sourceActivations.clear();
    const sources = [...this.sources.values()];
    this.sources.clear();
    for (const source of sources) if (source.timer) clearTimeout(source.timer);
    await Promise.allSettled(sources.map((source) => source.transport.close(reason)));
    this.friendPresenceByPuuid.clear();
    for (const conversation of this.conversations.values()) {
      conversation.connectionState = 'offline';
      conversation.connectionError = '';
      conversation.leaseExpiresAt = null;
      applyFriendPresence(
        conversation,
        this.canonicalFriendPresenceByPuuid.get(conversation.destinationPuuid)
          || { online: false, state: 'offline' }
      );
    }
    this._changed('sources-disconnected');
  }

  async removeAccount(sourceAccountId) {
    const id = String(sourceAccountId || '').trim();
    if (!id) return this.snapshot();

    // Invalidate transports that are still being created. The reset is global because activations
    // share one epoch, but already-connected sources for other accounts remain untouched.
    this.sourceEpoch += 1;
    this.sourceActivations.clear();
    const source = this.sources.get(id);
    this.sources.delete(id);
    if (source?.timer) clearTimeout(source.timer);

    for (const [key, conversation] of this.conversations.entries()) {
      if (conversation.sourceAccountId === id) this.conversations.delete(key);
    }
    if (!this.conversations.has(this.activeKey)) {
      this.activeKey = this.listConversations()[0]?.key || '';
    }

    if (source) {
      try {
        await source.transport.close('source account removed');
      } catch (error) {
        this.log(`Chat: removed source close failed account=${source.account?.label || id} (${error.message}).`, 'warn');
      }
    }
    this._changed('account-removed');
    return this.snapshot();
  }

  _conversation(key) {
    const conversation = this.conversations.get(String(key || ''));
    if (!conversation || !conversation.open) throw new Error('Chat conversation not found.');
    return conversation;
  }

  async _activateSource(sourceAccountId) {
    const source = this.sources.get(sourceAccountId);
    if (source?.transport?.connected) {
      this._touchSource(sourceAccountId);
      return source;
    }
    const pending = this.sourceActivations.get(sourceAccountId);
    if (pending) return pending;
    const activation = this._connectSource(sourceAccountId, this.sourceEpoch);
    this.sourceActivations.set(sourceAccountId, activation);
    try {
      return await activation;
    } finally {
      if (this.sourceActivations.get(sourceAccountId) === activation) {
        this.sourceActivations.delete(sourceAccountId);
      }
    }
  }

  async _connectSource(sourceAccountId, sourceEpoch) {
    const account = this.getAccount(sourceAccountId);
    if (!account) throw new Error('Source account not found.');
    let source = this.sources.get(sourceAccountId);
    if (!source) {
      const sourceToken = {};
      let transport;
      try {
        transport = await this.createTransport({
          account,
          onMessage: (message) => this._incoming(sourceAccountId, message, sourceToken),
          onPresence: (presence) => this._presence(sourceAccountId, presence, sourceToken),
          onClose: (error) => this._sourceClosed(sourceAccountId, error, sourceToken)
        });
      } catch (error) {
        if (sourceEpoch === this.sourceEpoch) this._setSourceState(sourceAccountId, 'error', error.message);
        throw error;
      }
      if (sourceEpoch !== this.sourceEpoch) {
        await transport.close('chat source reset while connecting');
        throw new Error('Chat connection was reset; try again.');
      }
      source = { account, transport, sourceToken, timer: null, leaseExpiresAt: 0, domain: '' };
      this.sources.set(sourceAccountId, source);
    }
    this._setSourceState(sourceAccountId, 'connecting');
    try {
      const summary = await source.transport.connect();
      if (sourceEpoch !== this.sourceEpoch || this.sources.get(sourceAccountId) !== source) {
        await source.transport.close('chat source reset while connecting');
        throw new Error('Chat connection was reset; try again.');
      }
      source.domain = source.transport.credentials?.endpoint?.domain || source.transport.domain || '';
      this._setSourceState(sourceAccountId, 'online');
      this._touchSource(sourceAccountId);
      this.log(`Chat: source connected account=${account.label} transport=${summary.kind}.`);
      return source;
    } catch (error) {
      if (this.sources.get(sourceAccountId) === source) {
        this._setSourceState(sourceAccountId, 'error', error.message);
      }
      throw error;
    }
  }

  _touchSource(sourceAccountId) {
    const source = this.sources.get(sourceAccountId);
    if (!source) return;
    if (source.timer) clearTimeout(source.timer);
    const leaseMs = Math.max(15_000, Number(this.getLeaseMs()) || DEFAULT_CHAT_ONLINE_LEASE_MS);
    source.leaseExpiresAt = this.now() + leaseMs;
    source.timer = setTimeout(() => this._expireSource(sourceAccountId), leaseMs);
    source.timer.unref?.();
    for (const conversation of this.conversations.values()) {
      if (conversation.sourceAccountId === sourceAccountId) conversation.leaseExpiresAt = new Date(source.leaseExpiresAt).toISOString();
    }
  }

  async _expireSource(sourceAccountId) {
    const source = this.sources.get(sourceAccountId);
    if (!source) return;
    this.sources.delete(sourceAccountId);
    await source.transport.close('idle lease expired');
    this._setSourceState(sourceAccountId, 'offline');
    this._changed('lease-expired');
  }

  _incoming(sourceAccountId, message, sourceToken = null) {
    if (sourceToken && this.sources.get(sourceAccountId)?.sourceToken !== sourceToken) return;
    const incoming = message?.incoming !== false;
    const friendPuuid = String(incoming ? message?.fromPuuid : message?.toPuuid || '').toLowerCase();
    if (!message?.body || !friendPuuid) return;
    const account = this.getAccount(sourceAccountId);
    if (!account) return;
    const key = chatConversationKey(sourceAccountId, friendPuuid);
    let conversation = this.conversations.get(key);
    if (!conversation && message.historical) return;
    if (!conversation) {
      const friend = message.friend || {};
      conversation = {
        key,
        sourceAccountId,
        sourceLabel: account.label,
        destinationPuuid: friendPuuid,
        destinationJid: message.conversationJid || friend.jid || message.from?.split('/')[0] || '',
        destinationRiotId: friend.riotId || friendPuuid,
        friendOnline: true,
        friendState: 'chat',
        friendQueue: '',
        friendProduct: '',
        friendActivity: { kind: 'online', label: 'Online' },
        connectionState: 'online',
        connectionError: '',
        unreadCount: 0,
        draft: '',
        open: true,
        updatedAt: message.receivedAt || new Date(this.now()).toISOString(),
        messages: []
      };
      const sharedPresence = this.canonicalFriendPresenceByPuuid.get(friendPuuid)
        || this.friendPresenceByPuuid.get(friendPuuid);
      applyFriendPresence(conversation, sharedPresence || { ...friend, online: true, state: friend.state || 'chat' });
      this.conversations.set(key, conversation);
    }
    const duplicate = conversation.messages.some((item) => message.id && item.id === message.id);
    if (duplicate) return;
    // Closing a chat only removes it from the visible list; its source connection can remain online
    // until the idle lease expires. A genuinely new reply during that window must surface the chat
    // again instead of being appended to a conversation that the renderer intentionally filters out.
    if (incoming && !message.historical && !conversation.open) conversation.open = true;
    this._appendMessage(conversation, { ...message, incoming, status: incoming ? 'received' : 'sent' });
    if (incoming && !message.historical && !(this.viewActive && this.activeKey === key)) {
      conversation.unreadCount += 1;
      this.onEvent({ type: 'message', conversationKey: key, sourceLabel: account.label, friend: conversation.destinationRiotId, body: message.body });
    }
    this._touchSource(sourceAccountId);
    this._changed('message-received');
  }

  _presence(sourceAccountId, presence, sourceToken = null) {
    if (sourceToken && this.sources.get(sourceAccountId)?.sourceToken !== sourceToken) return;
    const friendPuuid = String(presence?.puuid || '').trim().toLowerCase();
    if (!friendPuuid) return;
    const sharedPresence = clone({ ...presence, puuid: friendPuuid });
    this.friendPresenceByPuuid.set(friendPuuid, sharedPresence);
    const effectivePresence = this.canonicalFriendPresenceByPuuid.get(friendPuuid) || sharedPresence;
    const roster = this.sources.get(sourceAccountId)?.transport?.summary?.().roster;
    const namesByPuuid = friendNames(roster);
    for (const conversation of this.conversations.values()) {
      if (conversation.destinationPuuid !== friendPuuid) continue;
      applyFriendPresence(conversation, effectivePresence, namesByPuuid);
    }
    this._changed('presence');
  }

  _appendMessage(conversation, message) {
    conversation.messages.push({
      id: String(message.id || crypto.randomUUID()),
      body: String(message.body || ''),
      incoming: Boolean(message.incoming),
      receivedAt: String(message.receivedAt || message.sentAt || new Date(this.now()).toISOString()),
      delayed: Boolean(message.delayed),
      status: String(message.status || '')
    });
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
    conversation.updatedAt = conversation.messages.at(-1).receivedAt;
  }

  _sourceClosed(sourceAccountId, error, sourceToken = null) {
    const source = this.sources.get(sourceAccountId);
    if (!source || (sourceToken && source.sourceToken !== sourceToken)) return;
    if (source?.timer) clearTimeout(source.timer);
    this.sources.delete(sourceAccountId);
    this.sourceActivations.delete(sourceAccountId);
    this._setSourceState(sourceAccountId, 'error', error?.message || 'Riot chat disconnected.');
    this._changed('source-closed');
  }

  _setSourceState(sourceAccountId, state, error = '') {
    for (const conversation of this.conversations.values()) {
      if (conversation.sourceAccountId !== sourceAccountId) continue;
      conversation.connectionState = state;
      conversation.connectionError = error;
      if (state !== 'online') conversation.leaseExpiresAt = null;
    }
  }

  _changed(reason) {
    const snapshot = this.snapshot();
    this.onChanged(this.persistedState(), reason);
    this.onEvent({ type: 'state', reason, state: snapshot });
  }
}
