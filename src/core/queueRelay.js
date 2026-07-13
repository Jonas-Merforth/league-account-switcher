import crypto from 'node:crypto';

import { getSavedFriendXmppAuth } from './friendPresencePoc.js';
import { RiotXmppConnection } from './riotXmppConnection.js';
import {
  buildCapabilityProbe,
  buildCapabilityResponse,
  buildQueueStartRequest,
  buildQueueStartResponse,
  buildRelayPresence,
  parsePresenceResource,
  parseRelayIq,
  puuidFromJid,
  QUEUE_RELAY_REQUEST_TTL_MS,
  shortPeerId,
  summarizeQueueRelayLobby,
  validateQueueStartRequest,
  xmppAttr
} from './queueRelayProtocol.js';

const RELAY_TICK_MS = 2_000;
const RESOURCE_TTL_MS = 90_000;
const CAPABILITY_TTL_MS = 25_000;
const CAPABILITY_PROBE_INTERVAL_MS = 10_000;
const IQ_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 10_000;
const ACCEPT_COOLDOWN_MS = 5_000;

function accountName(account) {
  return account?.lastSummonerName || account?.label || account?.username || account?.id || 'unknown';
}

function friendlyXmppError(error) {
  const message = String(error?.message || error || 'Unknown XMPP error');
  return message.replace(/<rso_token>[\s\S]*?<\/rso_token>/gi, '<rso_token>[redacted]</rso_token>')
    .replace(/<pas_token>[\s\S]*?<\/pas_token>/gi, '<pas_token>[redacted]</pas_token>')
    .replace(/<token>[\s\S]*?<\/token>/gi, '<token>[redacted]</token>');
}

export async function fetchQueueRelayLobby(lcu) {
  let phase;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch (error) {
    return { ...summarizeQueueRelayLobby(null, null), reason: `League is unavailable: ${error.message}` };
  }
  if (String(phase || '') !== 'Lobby') return summarizeQueueRelayLobby(phase, null);
  try {
    return summarizeQueueRelayLobby(phase, await lcu.get('/lol-lobby/v2/lobby'));
  } catch (error) {
    return { ...summarizeQueueRelayLobby(phase, null), reason: `League lobby is unavailable: ${error.message}` };
  }
}

export class QueueRelayService {
  constructor({ lcu, log, getActiveAccount, getAllowedPuuids, onEvent = () => {}, getXmppAuth = getSavedFriendXmppAuth }) {
    this.lcu = lcu;
    this.log = log;
    this.getActiveAccount = getActiveAccount;
    this.getAllowedPuuids = getAllowedPuuids;
    this.onEvent = onEvent;
    this.getXmppAuth = getXmppAuth;
    this.instanceId = crypto.randomUUID();
    this.connection = null;
    this.connectionAccountId = '';
    this.connectionState = 'disconnected';
    this.reason = 'Queue relay is starting.';
    this.lobby = summarizeQueueRelayLobby(null, null);
    this.roster = new Map();
    this.resources = new Map();
    this.pendingIq = new Map();
    this.processedRequests = new Map();
    this.lastAcceptedBySender = new Map();
    this.nextConnectAt = 0;
    this.timer = null;
    this.ticking = false;
    this.connecting = false;
    this.requestPending = false;
    this.lastKeepaliveAt = 0;
    this.stopped = true;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.log(`Queue relay: service start instance=${this.instanceId.slice(0, 8)} protocol=1.`);
    this.timer = setInterval(() => this.tick(), RELAY_TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._disconnect('service stopped');
    for (const pending of this.pendingIq.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Queue relay stopped.'));
    }
    this.pendingIq.clear();
  }

  kick() {
    this.nextConnectAt = 0;
    this.tick();
  }

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.lobby = await fetchQueueRelayLobby(this.lcu);
      this._prune();
      const account = await this.getActiveAccount?.() || null;
      if (!account?.id) {
        this.reason = 'No saved account matches the signed-in Riot account.';
        this._disconnect('no active saved account');
        return;
      }
      if (this.connectionAccountId && this.connectionAccountId !== account.id) {
        this._disconnect('active account changed');
      }
      if (!this.connection && !this.connecting && Date.now() >= this.nextConnectAt) {
        this._connect(account);
      }
      if (this.connectionState === 'connected') {
        await this._keepAlive();
        await this._probeRelevantPeers();
      }
    } finally {
      this.ticking = false;
      this._emitStatus();
    }
  }

  getStatus() {
    const allowed = new Set((this.getAllowedPuuids?.() || []).map((value) => String(value).toLowerCase()));
    const members = this.lobby.members || [];
    const peers = members
      .filter((member) => member.puuid && member.puuid !== this.lobby.localPuuid)
      .map((member) => {
        const toolResources = this._toolResources(member.puuid);
        return {
          puuid: member.puuid,
          riotId: member.riotId || this.roster.get(member.puuid)?.riotId || shortPeerId(member.puuid),
          isLeader: member.isLeader,
          detected: toolResources.length > 0,
          allowed: allowed.has(member.puuid),
          resources: toolResources.length
        };
      });
    const leaderResources = this._toolResources(this.lobby.leaderPuuid);
    const leaderResource = leaderResources.sort((a, b) => b.capabilityAt - a.capabilityAt)[0] || null;
    const leaderMember = members.find((member) => member.puuid === this.lobby.leaderPuuid);
    return {
      connected: this.connectionState === 'connected',
      connectionState: this.connectionState,
      reason: this.reason,
      accountId: this.connectionAccountId,
      requestPending: this.requestPending,
      lobby: this.lobby,
      leader: {
        puuid: this.lobby.leaderPuuid,
        riotId: leaderMember?.riotId || this.roster.get(this.lobby.leaderPuuid)?.riotId || '',
        detected: Boolean(leaderResource),
        allowed: Boolean(leaderResource?.remoteAllowed),
        resource: leaderResource?.jid || ''
      },
      peers
    };
  }

  async startViaLeader() {
    if (this.requestPending) throw new Error('A queue-start request is already pending.');
    const status = this.getStatus();
    if (!status.connected) throw new Error(status.reason || 'Queue relay is not connected.');
    if (!status.lobby.inLobby) throw new Error('Join a League lobby first.');
    if (status.lobby.localIsLeader) throw new Error('You are already the lobby leader.');
    if (!status.leader.detected) throw new Error('The lobby leader\'s Queue Relay was not detected.');
    if (!status.leader.allowed) throw new Error('The lobby leader has not allowed queue requests from you.');

    const requestId = crypto.randomUUID();
    const iqId = `las-start-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + QUEUE_RELAY_REQUEST_TTL_MS).toISOString();
    this.requestPending = true;
    this.log(`Queue relay: sending queue-start request=${requestId.slice(0, 8)} party=${status.lobby.partyId.slice(0, 8)} leader=${shortPeerId(status.leader.puuid)} resource=${this._resourceLabel(status.leader.resource)}.`);
    this._emitStatus();
    try {
      const response = await this._sendIqAndWait({
        id: iqId,
        stanza: buildQueueStartRequest({
          id: iqId,
          to: status.leader.resource,
          requestId,
          partyId: status.lobby.partyId,
          senderPuuid: status.lobby.localPuuid,
          createdAt,
          expiresAt
        }),
        expectedKind: 'queue-start-result'
      });
      const result = response.payload;
      this.log(`Queue relay: queue-start response request=${requestId.slice(0, 8)} ok=${result.ok} code=${result.code || 'none'} message=${result.message || 'none'}.`, result.ok ? 'info' : 'warn');
      if (!result.ok) throw new Error(result.message || `Leader rejected the request (${result.code || 'unknown'}).`);
      this.onEvent({ type: 'queue-started-remote', message: result.message || 'The lobby leader started matchmaking.' });
      return { ok: true, code: result.code, message: result.message };
    } finally {
      this.requestPending = false;
      this._emitStatus();
    }
  }

  async _connect(account) {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    this.connectionState = 'connecting';
    this.connectionAccountId = account.id;
    this.reason = `Connecting queue relay for ${accountName(account)}.`;
    this.log(`Queue relay: connecting account=${accountName(account)} id=${shortPeerId(account.id)}.`);
    this._emitStatus();
    try {
      let credentials;
      try {
        credentials = await this.getXmppAuth(account.id, { log: this._authLog() });
      } catch (error) {
        throw new Error(`Authentication failed: ${error.message}`);
      }
      const credentialPuuid = String(credentials.identity?.puuid || '').toLowerCase();
      const lobbyPuuid = String(this.lobby.localPuuid || '').toLowerCase();
      if (credentialPuuid && lobbyPuuid && credentialPuuid !== lobbyPuuid) {
        throw new Error('Authentication failed: the live League identity changed while Queue Relay was connecting.');
      }
      this.log(`Queue relay: auth source=${credentials.source || 'saved-session'} account=${accountName(account)}.`);
      if (this.stopped || this.connectionAccountId !== account.id) return;
      const connection = new RiotXmppConnection({
        credentials,
        log: this.log,
        logLabel: 'Queue relay',
        initialPresence: buildRelayPresence(),
        onStanza: (stanza) => this._handleStanza(stanza),
        onClose: (error) => this._handleConnectionClose(error)
      });
      this.connection = connection;
      const connected = await connection.connect();
      if (this.stopped || this.connection !== connection) {
        connection.close('superseded');
        return;
      }
      this.roster = connected.roster;
      this.connectionState = 'connected';
      this.reason = '';
      this.nextConnectAt = 0;
      this.log(`Queue relay: connected account=${accountName(account)} self=${shortPeerId(connected.boundJid)} resource=${this._resourceLabel(connected.boundJid)} roster=${this.roster.size}.`);
    } catch (error) {
      const message = friendlyXmppError(error);
      this.log(`Queue relay: connect failed account=${accountName(account)} (${message}).`, 'warn');
      this.reason = `Queue relay connection failed: ${message}`;
      this.connectionState = 'error';
      this.connection?.close('connect failed');
      this.connection = null;
      this.nextConnectAt = Date.now() + RECONNECT_DELAY_MS;
    } finally {
      this.connecting = false;
      this._emitStatus();
    }
  }

  _authLog() {
    return (message, level = 'info') => this.log(`Queue relay auth: ${message}`, level);
  }

  _disconnect(reason) {
    if (this.connection) this.connection.close(reason);
    this.connection = null;
    this.connectionAccountId = '';
    this.connectionState = 'disconnected';
    this.resources.clear();
    for (const pending of this.pendingIq.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Queue relay disconnected: ${reason}.`));
    }
    this.pendingIq.clear();
  }

  _handleConnectionClose(error) {
    if (this.connectionState === 'disconnected' || this.stopped) return;
    const message = friendlyXmppError(error);
    this.log(`Queue relay: XMPP connection closed (${message}); retrying in ${RECONNECT_DELAY_MS}ms.`, 'warn');
    this.connection = null;
    this.connectionState = 'error';
    this.reason = `Queue relay disconnected: ${message}`;
    this.nextConnectAt = Date.now() + RECONNECT_DELAY_MS;
    this._emitStatus();
  }

  async _handleStanza(stanza) {
    const presence = parsePresenceResource(stanza);
    if (presence) {
      this._handlePresence(presence);
      return;
    }
    const iq = parseRelayIq(stanza);
    if (!iq) return;
    if (iq.type === 'error' && this.pendingIq.has(iq.id)) {
      this._settlePending(iq.id, new Error('The XMPP resource rejected the relay request.'));
      return;
    }
    if (iq.kind === 'capability' && iq.type === 'get') {
      await this._answerCapability(iq);
      return;
    }
    if (iq.kind === 'capability' && iq.type === 'result') {
      this._recordCapability(iq);
      this._settlePending(iq.id, null, iq);
      return;
    }
    if (iq.kind === 'queue-start' && iq.type === 'set') {
      await this._handleIncomingQueueStart(iq);
      return;
    }
    if (iq.kind === 'queue-start-result' && iq.type === 'result') {
      this._settlePending(iq.id, null, iq);
    }
  }

  _handlePresence(presence) {
    if (!presence.puuid || !presence.resource || presence.puuid === this.lobby.localPuuid) return;
    let byJid = this.resources.get(presence.puuid);
    if (!byJid) {
      byJid = new Map();
      this.resources.set(presence.puuid, byJid);
    }
    if (presence.unavailable) {
      if (byJid.delete(presence.from)) {
        this.log(`Queue relay: resource offline peer=${shortPeerId(presence.puuid)} resource=${this._resourceLabel(presence.from)}.`);
      }
      if (!byJid.size) this.resources.delete(presence.puuid);
      return;
    }
    const previous = byJid.get(presence.from);
    byJid.set(presence.from, {
      ...(previous || {}),
      jid: presence.from,
      puuid: presence.puuid,
      seenAt: Date.now(),
      lastProbeAt: previous?.lastProbeAt || 0,
      capabilityAt: previous?.capabilityAt || 0,
      remoteAllowed: previous?.remoteAllowed || false,
      instanceId: previous?.instanceId || ''
    });
    if (!previous) {
      this.log(`Queue relay: observed XMPP resource peer=${shortPeerId(presence.puuid)} resource=${this._resourceLabel(presence.from)}.`);
    }
  }

  async _answerCapability(iq) {
    if (!iq.from || !iq.id) return;
    const allowed = this._allowedSet().has(iq.fromPuuid);
    this.log(`Queue relay: capability probe received peer=${shortPeerId(iq.fromPuuid)} resource=${this._resourceLabel(iq.from)} allowed=${allowed}.`);
    await this.connection.send(buildCapabilityResponse({
      id: iq.id,
      to: iq.from,
      instanceId: this.instanceId,
      allowed
    }));
  }

  _recordCapability(iq) {
    const byJid = this.resources.get(iq.fromPuuid);
    const resource = byJid?.get(iq.from);
    if (!resource) return;
    const first = !resource.capabilityAt;
    const previousAllowed = resource.remoteAllowed;
    resource.capabilityAt = Date.now();
    resource.remoteAllowed = iq.payload.allowed;
    resource.instanceId = iq.payload.instanceId;
    resource.seenAt = Date.now();
    if (first || previousAllowed !== iq.payload.allowed) {
      this.log(`Queue relay: peer confirmed peer=${shortPeerId(iq.fromPuuid)} resource=${this._resourceLabel(iq.from)} allowedByPeer=${iq.payload.allowed} instance=${String(iq.payload.instanceId || '').slice(0, 8) || 'none'}.`);
    }
  }

  async _probeRelevantPeers() {
    if (!this.lobby.inLobby) return;
    const peerPuuids = this.lobby.members
      .map((member) => member.puuid)
      .filter((puuid) => puuid && puuid !== this.lobby.localPuuid);
    const now = Date.now();
    for (const puuid of peerPuuids) {
      const byJid = this.resources.get(puuid);
      if (!byJid) continue;
      for (const resource of byJid.values()) {
        if (now - resource.lastProbeAt < CAPABILITY_PROBE_INTERVAL_MS) continue;
        resource.lastProbeAt = now;
        const id = `las-cap-${crypto.randomUUID()}`;
        this.log(`Queue relay: capability probe sent peer=${shortPeerId(puuid)} resource=${this._resourceLabel(resource.jid)}.`);
        this._sendIqAndWait({
          id,
          stanza: buildCapabilityProbe({ id, to: resource.jid }),
          expectedKind: 'capability'
        }).catch(() => {});
      }
    }
  }

  async _keepAlive() {
    const now = Date.now();
    if (now - this.lastKeepaliveAt < KEEPALIVE_INTERVAL_MS) return;
    this.lastKeepaliveAt = now;
    try {
      await this.connection.send(' ');
    } catch (error) {
      this.log(`Queue relay: XMPP keepalive failed (${friendlyXmppError(error)}).`, 'warn');
      this.connection?.close('keepalive failed');
      this._handleConnectionClose(error);
    }
  }

  async _handleIncomingQueueStart(iq) {
    const request = iq.payload;
    const requestLabel = String(request.requestId || '').slice(0, 8) || 'missing';
    this.log(`Queue relay: queue-start received request=${requestLabel} peer=${shortPeerId(iq.fromPuuid)} resource=${this._resourceLabel(iq.from)} party=${String(request.partyId || '').slice(0, 8) || 'none'}.`);
    let result;
    const now = Date.now();
    if (this.processedRequests.has(request.requestId)) {
      result = { ok: false, code: 'replayed', message: 'This queue request was already processed.' };
    } else if (now - (this.lastAcceptedBySender.get(iq.fromPuuid) || 0) < ACCEPT_COOLDOWN_MS) {
      result = { ok: false, code: 'rate-limited', message: 'Queue requests are arriving too quickly.' };
    } else {
      const lobby = await fetchQueueRelayLobby(this.lcu);
      result = validateQueueStartRequest({
        request,
        fromPuuid: iq.fromPuuid,
        lobby,
        allowedPuuids: [...this._allowedSet()],
        now
      });
      this.log(`Queue relay: validation request=${requestLabel} ok=${result.ok} code=${result.code} phase=${lobby.phase || 'none'} localLeader=${lobby.localIsLeader} sameParty=${lobby.partyId === request.partyId} senderInParty=${lobby.members.some((member) => member.puuid === iq.fromPuuid)} queue=${lobby.queueId || 'none'} canStart=${lobby.canStartActivity}.`, result.ok ? 'info' : 'warn');
      if (result.ok) {
        this.processedRequests.set(request.requestId, now + QUEUE_RELAY_REQUEST_TTL_MS * 2);
        try {
          await this.lcu.post('/lol-lobby/v2/lobby/matchmaking/search');
          this.lastAcceptedBySender.set(iq.fromPuuid, Date.now());
          result = { ok: true, code: 'started', message: 'The lobby leader started matchmaking.' };
          this.log(`Queue relay: matchmaking started request=${requestLabel} peer=${shortPeerId(iq.fromPuuid)}.`);
          this.onEvent({
            type: 'queue-started-local',
            peerPuuid: iq.fromPuuid,
            peerName: this.roster.get(iq.fromPuuid)?.riotId || shortPeerId(iq.fromPuuid),
            message: `${this.roster.get(iq.fromPuuid)?.riotId || 'A permitted friend'} started matchmaking through Queue Relay.`
          });
        } catch (error) {
          result = { ok: false, code: 'lcu-rejected', message: `League rejected the queue start: ${error.message}` };
          this.log(`Queue relay: LCU start failed request=${requestLabel} (${error.message}).`, 'warn');
        }
      }
    }
    try {
      await this.connection.send(buildQueueStartResponse({
        id: iq.id,
        to: iq.from,
        requestId: request.requestId,
        ...result
      }));
      this.log(`Queue relay: response sent request=${requestLabel} ok=${result.ok} code=${result.code}.`);
    } catch (error) {
      this.log(`Queue relay: response failed request=${requestLabel} (${friendlyXmppError(error)}).`, 'warn');
    }
  }

  _sendIqAndWait({ id, stanza, expectedKind }) {
    if (!this.connection || this.connectionState !== 'connected') {
      return Promise.reject(new Error('Queue relay is not connected.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingIq.delete(id);
        reject(new Error(`Queue relay ${expectedKind} timed out.`));
      }, IQ_TIMEOUT_MS);
      timer.unref?.();
      this.pendingIq.set(id, { resolve, reject, timer, expectedKind });
      this.connection.send(stanza).catch((error) => this._settlePending(id, error));
    });
  }

  _settlePending(id, error, iq) {
    const pending = this.pendingIq.get(id);
    if (!pending) return;
    this.pendingIq.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else if (pending.expectedKind && iq?.kind !== pending.expectedKind) pending.reject(new Error(`Unexpected queue relay response: ${iq?.kind || 'none'}.`));
    else pending.resolve(iq);
  }

  _toolResources(puuid) {
    if (!puuid) return [];
    const now = Date.now();
    return [...(this.resources.get(puuid)?.values() || [])]
      .filter((resource) => now - resource.seenAt <= RESOURCE_TTL_MS && now - resource.capabilityAt <= CAPABILITY_TTL_MS);
  }

  _allowedSet() {
    return new Set((this.getAllowedPuuids?.() || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
  }

  _prune() {
    const now = Date.now();
    for (const [puuid, byJid] of this.resources) {
      for (const [jid, resource] of byJid) {
        if (now - resource.seenAt > RESOURCE_TTL_MS) byJid.delete(jid);
      }
      if (!byJid.size) this.resources.delete(puuid);
    }
    for (const [requestId, expiresAt] of this.processedRequests) {
      if (expiresAt < now) this.processedRequests.delete(requestId);
    }
  }

  _resourceLabel(jid) {
    const resource = String(jid || '').split('/')[1] || '';
    return resource ? resource.slice(0, 12) : 'bare';
  }

  _emitStatus() {
    this.onEvent({ type: 'status', status: this.getStatus() });
  }
}
