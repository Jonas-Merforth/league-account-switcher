import tls from 'node:tls';

import {
  escapeXmpp,
  extractXmppStanzas,
  parseRelayRoster
} from './queueRelayProtocol.js';

const KEEPALIVE_INTERVAL_MS = 30_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function friendlyXmppError(error) {
  const message = String(error?.message || error || 'Unknown XMPP error');
  return message.replace(/<rso_token>[\s\S]*?<\/rso_token>/gi, '<rso_token>[redacted]</rso_token>')
    .replace(/<pas_token>[\s\S]*?<\/pas_token>/gi, '<pas_token>[redacted]</pas_token>')
    .replace(/<token>[\s\S]*?<\/token>/gi, '<token>[redacted]</token>');
}

// Shared Riot XMPP transport used by Queue Relay and user-visible chats. Authentication and tokens
// stay in the main process; callers only receive parsed roster metadata and complete live stanzas.
export class RiotXmppConnection {
  constructor({ credentials, log, logLabel = 'XMPP', initialPresence = '', onStanza = () => {}, onClose = () => {} }) {
    this.credentials = credentials;
    this.log = log;
    this.logLabel = logLabel;
    this.initialPresence = initialPresence;
    this.onStanza = onStanza;
    this.onClose = onClose;
    this.socket = null;
    this.buffer = '';
    this.live = false;
    this.closed = false;
    this.boundJid = '';
    this.roster = new Map();
  }

  async connect() {
    const { auth, endpoint } = this.credentials;
    this.socket = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: endpoint.host,
        port: endpoint.port,
        servername: endpoint.host,
        timeout: 10_000
      }, () => resolve(socket));
      socket.once('error', reject);
      socket.once('timeout', () => socket.destroy(new Error('TLS connect timed out')));
    });
    this.socket.setTimeout(0);
    this.socket.setKeepAlive(true, KEEPALIVE_INTERVAL_MS);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (error) => this._finish(error));
    this.socket.on('close', () => this._finish(new Error('Riot XMPP socket closed.')));

    const stream = () => `<?xml version="1.0" encoding="UTF-8"?><stream:stream to="${escapeXmpp(endpoint.domain)}" xml:lang="en" version="1.0" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams">`;
    await this.send(stream());
    await this._waitFor('</stream:features>');
    await this.send(`<auth mechanism="X-Riot-RSO-PAS" xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><rso_token>${escapeXmpp(auth.accessToken)}</rso_token><pas_token>${escapeXmpp(auth.pasToken)}</pas_token></auth>`);
    const authResponse = await this._waitFor('</success>');
    if (/<failure|<stream:error/i.test(authResponse)) throw new Error('Riot XMPP authentication failed.');
    await this.send(stream());
    await this._waitFor('</stream:features>');
    await this.send('<iq id="las_bind_1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><puuid-mode enabled="true"/></bind></iq>');
    const bindResponse = await this._waitFor('</iq>');
    if (/<error|<stream:error/i.test(bindResponse)) throw new Error('Riot XMPP resource binding failed.');
    this.boundJid = bindResponse.match(/<jid>([^<]+)<\/jid>/i)?.[1] || '';
    await this.send(`<iq id="las_entitlements_1" type="set"><entitlements xmlns="urn:riotgames:entitlements"><token>${escapeXmpp(auth.entitlementToken)}</token></entitlements></iq>`);
    await this._waitFor('</iq>');
    await this.send('<iq id="las_session_1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"><platform>riot</platform></session></iq>');
    await this._waitFor('</iq>');
    await this.send('<iq id="las_roster_1" type="get"><query xmlns="jabber:iq:riotgames:roster"/></iq>');
    const rosterXml = await this._waitFor('</iq>');
    this.roster = parseRelayRoster(rosterXml);
    this.live = true;
    if (this.initialPresence) await this.send(this.initialPresence);
    this._drainLiveBuffer();
    return { boundJid: this.boundJid, roster: this.roster };
  }

  async send(stanza) {
    if (!this.socket || this.socket.destroyed) throw new Error('Riot XMPP socket is not connected.');
    await new Promise((resolve, reject) => {
      this.socket.write(stanza, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  close(reason = 'stopped') {
    if (this.closed) return;
    this.closed = true;
    this.log(`${this.logLabel}: closing XMPP connection (${reason}).`);
    try { this.socket?.end('</stream:stream>'); } catch {}
    setTimeout(() => this.socket?.destroy(), 250).unref?.();
  }

  _onData(chunk) {
    this.buffer += String(chunk || '');
    if (this.live) this._drainLiveBuffer();
  }

  _drainLiveBuffer() {
    const extracted = extractXmppStanzas(this.buffer);
    this.buffer = extracted.remainder;
    for (const stanza of extracted.stanzas) {
      Promise.resolve(this.onStanza(stanza)).catch((error) => {
        this.log(`${this.logLabel}: stanza handler failed (${friendlyXmppError(error)}).`, 'warn');
      });
    }
  }

  async _waitFor(marker, timeoutMs = 10_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.buffer.includes(marker) || this.buffer.includes('<failure') || this.buffer.includes('<stream:error')) {
        const value = this.buffer;
        this.buffer = '';
        return value;
      }
      await delay(25);
    }
    const bytes = Buffer.byteLength(this.buffer, 'utf8');
    this.buffer = '';
    throw new Error(`Timed out waiting for ${marker}; received ${bytes} bytes.`);
  }

  _finish(error) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(error);
  }
}
