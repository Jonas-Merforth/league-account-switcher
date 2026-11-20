import assert from 'node:assert/strict';
import test from 'node:test';
import { protocol16_23, protocolForBuild, protocolForObserver } from '../src/core/liveProtocol.js';
import { liveScoreboardProfiles } from '../src/core/spectator/live-scoreboard-profile.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';
import { ObserverPool } from '../src/core/spectator/observer-pool.js';
import { countRiftTurrets, decodeTurret } from '../src/core/spectator/patch-16-23-turrets.js';

test('a patch hint selects observer framing, while a full version pins the exact build', () => {
  assert.equal(protocolForObserver('16.23'), protocol16_23);
  for (const version of ['16.23.839.6405', '16.23.8396405', '16.23.839.9929', '16.23.8399929', '16.23.840.6595', '16.23.8406595']) {
    assert.equal(protocolForBuild(version), protocol16_23);
  }
  for (const version of ['16.23.839.6406', '16.23.83.96405', '16.24', '2.62.0', '']) {
    assert.equal(protocolForObserver(version), null);
  }
  assert.equal(protocolForBuild('16.23'), null);
  const decoder = new KeyframeSnapshotDecoder();
  for (const queueId of [400, 420, 440, 2400]) decoder.assertSupportsContext('16.23', { queueId });
  assert.throws(() => decoder.assertSupportsContext('16.23', { queueId: 450, queueType: 'KIWI' }));
});

test('spectator roster joins by entity ID, requiring one complete stat and spawn per player', () => {
  const base = 0x40000100;
  const champions = {};
  const fields = {
    decodeDamageHeroSpawn(data, { spectator }) {
      assert.equal(spectator, true);
      return { id: base + data[0], model: 'Hero' + data[0] };
    },
    decodeHeroStatVector(data) {
      const vector = Buffer.alloc(1260);
      vector.writeUInt32LE(data[0] < 5 ? 100 : 200, 0x20);
      vector.writeUInt32LE(data[0], 0x4c);
      return vector;
    }
  };
  const protocol = { ...protocol16_23, fields, scoreboard: { ...protocol16_23.scoreboard, champions } };
  const [, profile] = liveScoreboardProfiles(protocol);
  const blocks = [];
  for (let slot = 0; slot < 10; slot++) {
    champions['Hero' + slot] = slot + 1;
    const payload = Buffer.from([slot]);
    blocks.push({ packetId: protocol.heroStats, param: base + slot, length: 1, payload });
    blocks.unshift({ packetId: protocol.heroSpawn, param: 0, length: 1, payload });
  }
  const decode = blocks => profile.decode({ blocks, playerBase: base, queueId: 2400 });
  const result = decode(blocks);
  assert.deepEqual(result.participants.map(p => [p.championId, p.score.kills]),
    Array.from({ length: 10 }, (_, i) => [i + 1, i]));
  assert.deepEqual(result.teams.map(t => [t.kills, t.towersDestroyed]), [[10, null], [35, null]]);
  assert.equal(result.capabilities.objectives, 'unavailable');
  assert.throws(() => decode(blocks.slice(1)));
  assert.throws(() => decode([...blocks, blocks[0]]));
  assert.throws(() => decode([{ ...blocks[0], length: 0 }, ...blocks.slice(1)]));
  delete champions.Hero4;
  assert.throws(() => decode(blocks));
});

// Synthetic standing turret. Selector three writes its name forwards. All
// following fields use defaults except the one-byte enum at object +0x44.
function turret(side, lane, position) {
  const rol = (v, n) => ((v << n) | (v >>> (8 - n))) & 255;
  const encode = new Uint8Array(256);
  for (let v = 0; v < 256; v++) encode[((rol((rol(v, 5) + 0x60) & 255, 3) ^ 0xc2) + 0x63) & 255] = v;
  const name = Buffer.from(`Turret_T${side}_L${lane}_P${position}_123_0`);
  return Buffer.from([0x83, 0x1b, 0x42, encode[name.length], ...name.map(v => encode[v]), 0]);
}

test('Rift totals require all distinct lane positions on both sides regardless of entity IDs', () => {
  const blocks = [];
  for (const side of ['Order', 'Chaos']) {
    for (const lane of [0, 1, 2]) {
      for (let position = lane === 1 ? 0 : 1; position <= (lane === 1 ? 5 : 3); position++) {
        const payload = turret(side, lane, position);
        blocks.push({ packetId: 921, param: 500 + blocks.length * 3, payload, length: payload.length });
      }
    }
  }
  assert.deepEqual(countRiftTurrets(blocks.reverse(), 921), { 100: 0, 200: 0 });
  assert.throws(() => countRiftTurrets(blocks.slice(1), 921));
  assert.throws(() => countRiftTurrets([...blocks, { ...blocks[0], param: 70 }], 921));
  const corrupt = Buffer.from(blocks[0].payload);
  corrupt[0] ^= 4;
  assert.throws(() => decodeTurret(corrupt));
  assert.throws(() => decodeTurret(blocks[0].payload.subarray(0, -1)));
});

test('two live views share same-game requests and release the keyframe with their subscriptions', async () => {
  const calls = [];
  const pool = new ObserverPool(({ platformId }) => ({
    async getKeyFrame(id) { calls.push([platformId, id]); return Buffer.from([id]); },
    async getChunk(id) { calls.push(['chunk', id]); return null; },
    async close() {}
  }));
  const a = pool.acquire({ platformId: 'EUW1', gameId: '1' });
  const b = pool.acquire({ platformId: 'EUW', gameId: '1' });
  await Promise.all([a.getKeyFrame(3), b.getKeyFrame(3)]);
  await b.getKeyFrame(3);
  await a.getChunk(7);
  assert.deepEqual(calls, [['EUW1', 3], ['chunk', 7]]);
  a.release();
  a.release();
  await b.getKeyFrame(4);
  b.release();
  assert.equal(pool.games.size, 0);
  await assert.rejects(a.getKeyFrame(4), /ended/);
});

test('a same-game 429 also defers the other view’s queued request', async () => {
  let attempts = 0;
  const error = Object.assign(new Error('rate limited'), { statusCode: 429, retryAfterMs: 60_000 });
  const pool = new ObserverPool(() => ({
    async getLastChunkInfo() { attempts++; throw error; },
    async getKeyFrame() { assert.fail('cooldown was ignored'); },
    async close() {}
  }));
  const opts = { platformId: 'KR', gameId: '1' };
  const a = pool.acquire(opts), b = pool.acquire(opts);
  await Promise.all([assert.rejects(a.getLastChunkInfo(), error), assert.rejects(b.getKeyFrame(3), error)]);
  assert.equal(attempts, 1);
  a.release();
  b.release();
});
