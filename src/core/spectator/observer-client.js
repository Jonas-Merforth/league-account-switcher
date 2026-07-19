import { gunzipSync } from 'node:zlib';

import { Blowfish } from 'egoroof-blowfish';

import { HttpError } from './errors.js';
import { normalizePlatformId, observerHost } from './regions.js';

const CONSUMER_PATH = '/observer-mode/rest/consumer';

function safeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function publicMetadata(metadata) {
  if (!metadata) return null;
  return {
    gameKey: metadata.gameKey
      ? {
          gameId: String(metadata.gameKey.gameId ?? ''),
          platformId: String(metadata.gameKey.platformId ?? '')
        }
      : null,
    clientVersion: String(
      metadata.clientVersion
      ?? metadata.gameVersion
      ?? metadata.version
      ?? ''
    ),
    gameServerAddress: String(metadata.gameServerAddress ?? ''),
    port: safeInteger(metadata.port),
    encryptionKeyAvailable: Boolean(metadata.decodedEncryptionKey),
    chunkTimeInterval: safeInteger(metadata.chunkTimeInterval),
    keyFrameTimeInterval: safeInteger(metadata.keyFrameTimeInterval),
    endStartupChunkId: safeInteger(metadata.endStartupChunkId),
    startGameChunkId: safeInteger(metadata.startGameChunkId),
    endGameChunkId: safeInteger(metadata.endGameChunkId),
    gameEnded: Boolean(metadata.gameEnded),
    lastChunkId: safeInteger(metadata.lastChunkId),
    lastKeyFrameId: safeInteger(metadata.lastKeyFrameId)
  };
}

export class ObserverClient {
  constructor({
    platformId,
    gameId,
    timeoutMs = 8_000,
    fetchImpl = globalThis.fetch
  }) {
    this.platformId = normalizePlatformId(platformId);
    this.gameId = String(gameId);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.metadata = null;
    this.sessionKey = null;
  }

  endpoint(name, id) {
    const platform = encodeURIComponent(this.platformId);
    const game = encodeURIComponent(this.gameId);
    const suffix = id === undefined ? '' : `/${encodeURIComponent(String(id))}`;
    return `http://${observerHost(this.platformId)}:8080${CONSUMER_PATH}/${name}/${platform}/${game}${suffix}/token`;
  }

  versionEndpoint() {
    return `http://${observerHost(this.platformId)}:8080${CONSUMER_PATH}/version`;
  }

  async fetch(path, { json = false, text = false, allowNotFound = false } = {}) {
    const response = await this.fetchImpl(path, {
      headers: {
        Accept: json ? 'application/json' : text ? 'text/plain' : 'application/octet-stream',
        Connection: 'close'
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(`Observer endpoint failed with HTTP ${response.status}.`, {
        statusCode: response.status,
        body: body.slice(0, 300),
        url: new URL(path).pathname,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after'))
      });
    }
    if (json) return await response.json();
    if (text) return await response.text();
    return Buffer.from(await response.arrayBuffer());
  }

  async getVersion() {
    return String(await this.fetch(this.versionEndpoint(), { text: true })).trim();
  }

  async getMetadata() {
    const metadata = await this.fetch(this.endpoint('getGameMetaData', 1), { json: true });
    const encodedKey = String(metadata?.decodedEncryptionKey ?? '');
    if (!encodedKey) throw new Error('Observer metadata did not include a decoded encryption key.');
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length < 4 || key.length > 56) {
      throw new Error(`Observer metadata contained an invalid ${key.length}-byte encryption key.`);
    }
    this.metadata = metadata;
    this.sessionKey = key;
    return publicMetadata(metadata);
  }

  async getLastChunkInfo() {
    return await this.fetch(this.endpoint('getLastChunkInfo', 1), { json: true });
  }

  async getEncryptedChunk(chunkId) {
    return await this.fetch(this.endpoint('getGameDataChunk', chunkId), { allowNotFound: true });
  }

  async getEncryptedKeyFrame(keyFrameId) {
    return await this.fetch(this.endpoint('getKeyFrame', keyFrameId), { allowNotFound: true });
  }

  decode(encrypted) {
    if (!this.sessionKey) throw new Error('Observer metadata must be loaded before stream data is decoded.');
    if (!encrypted?.length || encrypted.length % 8 !== 0) {
      throw new Error('Observer ciphertext is empty or is not aligned to the Blowfish block size.');
    }
    const cipher = new Blowfish(
      Uint8Array.from(this.sessionKey),
      Blowfish.MODE.ECB,
      Blowfish.PADDING.PKCS5
    );
    const decrypted = Buffer.from(cipher.decode(
      Uint8Array.from(encrypted),
      Blowfish.TYPE.UINT8_ARRAY
    ));
    if (decrypted[0] !== 0x1f || decrypted[1] !== 0x8b) {
      throw new Error('Observer decryption did not produce a gzip stream.');
    }
    return gunzipSync(decrypted);
  }

  async getChunk(chunkId) {
    const encrypted = await this.getEncryptedChunk(chunkId);
    return encrypted ? this.decode(encrypted) : null;
  }

  async getKeyFrame(keyFrameId) {
    const encrypted = await this.getEncryptedKeyFrame(keyFrameId);
    return encrypted ? this.decode(encrypted) : null;
  }

  async close() {
    // Every request explicitly asks the observer server to close its connection.
    // This method exists so alternate transports can release finite-cycle state.
  }
}

export { publicMetadata };

