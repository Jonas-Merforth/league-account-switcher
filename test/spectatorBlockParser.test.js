import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBlocks } from '../src/core/spectator/block-parser.js';
import { BlockFramingError } from '../src/core/spectator/errors.js';

function absoluteBlock({ timestamp, payload, packetId, param }) {
  const header = Buffer.alloc(15);
  header.writeUInt8(0, 0);
  header.writeFloatLE(timestamp, 1);
  header.writeUInt32LE(payload.length, 5);
  header.writeUInt16LE(packetId, 9);
  header.writeUInt32LE(param, 11);
  return Buffer.concat([header, payload]);
}

test('parses absolute and relative observer blocks', () => {
  const first = absoluteBlock({
    timestamp: 1.5,
    payload: Buffer.from([1, 2, 3]),
    packetId: 0x1234,
    param: 0x40000099
  });
  const second = Buffer.from([
    0xf0,
    250,
    2,
    1,
    9,
    8
  ]);
  const blocks = parseBlocks(Buffer.concat([first, second]), { retainPayload: true });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].timestamp, 1.5);
  assert.deepEqual([...blocks[0].payload], [1, 2, 3]);
  assert.equal(blocks[1].timestamp, 1.75);
  assert.equal(blocks[1].packetId, 0x1234);
  assert.equal(blocks[1].param, 0x4000009a);
  assert.deepEqual([...blocks[1].payload], [9, 8]);
});

test('rejects truncated observer blocks with their byte offset', () => {
  assert.throws(
    () => parseBlocks(Buffer.from([0, 0, 0])),
    (error) => error instanceof BlockFramingError && error.offset === 0
  );
});
