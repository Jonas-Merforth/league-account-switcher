import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { Blowfish } from 'egoroof-blowfish';

import { ObserverClient } from '../src/core/spectator/observer-client.js';

test('uses the observer protocol literal token instead of a presence spectator key', () => {
  const client = new ObserverClient({
    platformId: 'EUW1',
    gameId: '42',
    fetchImpl: () => {
      throw new Error('not used');
    }
  });
  assert.match(
    client.endpoint('getGameMetaData', 1),
    /\/EUW1\/42\/1\/token$/
  );
});

test('reads the regional observer transport protocol version', async () => {
  let requestedUrl = null;
  const client = new ObserverClient({
    platformId: 'EUW1',
    gameId: '1',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response('16.14.794.5912', { status: 200 });
    }
  });
  assert.equal(await client.getVersion(), '16.14.794.5912');
  assert.match(requestedUrl, /\/observer-mode\/rest\/consumer\/version$/);
});

test('preserves observer Retry-After guidance on rate limits', async () => {
  const client = new ObserverClient({
    platformId: 'EUW1',
    gameId: '42',
    fetchImpl: async () => new Response('slow down', {
      status: 429,
      headers: { 'Retry-After': '180' }
    })
  });
  await assert.rejects(
    client.getMetadata(),
    (error) => error.statusCode === 429 && error.retryAfterMs === 180_000
  );
});

test('decrypts PKCS5-padded observer gzip payloads in pure JavaScript', () => {
  const key = Buffer.from('observer-test-key');
  const expected = Buffer.from('observer payload '.repeat(2_000));
  const compressed = gzipSync(expected);
  const cipher = new Blowfish(
    Uint8Array.from(key),
    Blowfish.MODE.ECB,
    Blowfish.PADDING.PKCS5
  );
  const encrypted = Buffer.from(cipher.encode(Uint8Array.from(compressed)));
  assert.notEqual(encrypted.at(-1), compressed.at(-1));

  const client = new ObserverClient({
    platformId: 'EUW1',
    gameId: '1',
    fetchImpl: () => {
      throw new Error('not used');
    }
  });
  client.sessionKey = key;
  assert.deepEqual(client.decode(encrypted), expected);
});
