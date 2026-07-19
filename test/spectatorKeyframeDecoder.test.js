import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KeyframeSnapshotDecoder,
  UnsupportedKeyframeProfileError,
  keyframeStructuralFingerprint
} from '../src/core/spectator/keyframe-snapshot-decoder.js';

function blocks() {
  return Array.from({ length: 10 }, (_, index) => ({
    timestamp: 900,
    packetId: 491,
    param: 0x40000010 + index,
    length: 8,
    payload: Buffer.alloc(8, index)
  }));
}

function snapshot() {
  return {
    gameTimeSeconds: 900,
    teams: [100, 200].map((teamId) => ({
      teamId,
      kills: 10,
      towersDestroyed: 2,
      inhibitorsDestroyed: 0,
      objectives: {
        dragons: 1, barons: 0, riftHeralds: 0, voidGrubs: 3, atakhan: 0, other: 0
      }
    })),
    participants: Array.from({ length: 10 }, (_, index) => ({
      participantSlot: index + 1,
      teamId: index < 5 ? 100 : 200,
      championId: index + 1,
      level: 10,
      score: { kills: 1, deaths: 2, assists: 3, cs: 100 },
      items: [1055]
    }))
  };
}

test('selects a profile only when version and structural fingerprint match', () => {
  const input = blocks();
  const fingerprint = keyframeStructuralFingerprint(input);
  const decoder = new KeyframeSnapshotDecoder({
    profiles: [{
      id: '16.14-test',
      clientVersion: /^16\.14(?:\.|$)/,
      fingerprint,
      decode: () => snapshot()
    }]
  });
  const result = decoder.decode({ blocks: input, clientVersion: '16.14.123.1' });
  assert.equal(result.profileId, '16.14-test');
  assert.equal(result.teams[0].teamId, 100);
  assert.equal(result.participants.length, 10);
});

test('rejects an unverified patch instead of returning plausible values', () => {
  const input = blocks();
  const decoder = new KeyframeSnapshotDecoder({
    profiles: [{
      id: 'old',
      clientVersion: '16.13',
      fingerprint: keyframeStructuralFingerprint(input),
      decode: () => snapshot()
    }]
  });
  assert.throws(
    () => decoder.decode({ blocks: input, clientVersion: '16.14' }),
    UnsupportedKeyframeProfileError
  );
});

test('rejects malformed profile output', () => {
  const input = blocks();
  const decoder = new KeyframeSnapshotDecoder({
    profiles: [{
      id: 'broken',
      clientVersion: '16.14',
      fingerprint: keyframeStructuralFingerprint(input),
      decode: () => ({ ...snapshot(), participants: [] })
    }]
  });
  assert.throws(
    () => decoder.decode({ blocks: input, clientVersion: '16.14' }),
    /exactly ten/
  );
});
