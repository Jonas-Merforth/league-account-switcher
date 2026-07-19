import { BlockFramingError } from './errors.js';

const MARKER_TS_RELATIVE = 0x80;
const MARKER_REUSE_PACKET_ID = 0x40;
const MARKER_PARAM_RELATIVE = 0x20;
const MARKER_LEN_U8 = 0x10;

function need(buffer, cursor, bytes, blockOffset) {
  if (cursor + bytes > buffer.length) {
    throw new BlockFramingError(
      `need ${bytes} bytes but only ${buffer.length - cursor} remain`,
      blockOffset
    );
  }
}

export function parseBlocks(input, { retainPayload = false } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const blocks = [];
  let cursor = 0;
  let accumulatedTime = 0;
  let previousPacketId = 0;
  let previousParam = 0;

  while (cursor < buffer.length) {
    const offset = cursor;
    need(buffer, cursor, 1, offset);
    const marker = buffer.readUInt8(cursor);
    cursor += 1;

    let timestamp;
    if (marker & MARKER_TS_RELATIVE) {
      need(buffer, cursor, 1, offset);
      accumulatedTime += buffer.readUInt8(cursor) * 0.001;
      cursor += 1;
      timestamp = accumulatedTime;
    } else {
      need(buffer, cursor, 4, offset);
      timestamp = buffer.readFloatLE(cursor);
      accumulatedTime = timestamp;
      cursor += 4;
    }

    let length;
    if (marker & MARKER_LEN_U8) {
      need(buffer, cursor, 1, offset);
      length = buffer.readUInt8(cursor);
      cursor += 1;
    } else {
      need(buffer, cursor, 4, offset);
      length = buffer.readUInt32LE(cursor);
      cursor += 4;
    }

    let packetId;
    if (marker & MARKER_REUSE_PACKET_ID) {
      packetId = previousPacketId;
    } else {
      need(buffer, cursor, 2, offset);
      packetId = buffer.readUInt16LE(cursor);
      cursor += 2;
    }

    let param;
    if (marker & MARKER_PARAM_RELATIVE) {
      need(buffer, cursor, 1, offset);
      param = (previousParam + buffer.readUInt8(cursor)) >>> 0;
      cursor += 1;
    } else {
      need(buffer, cursor, 4, offset);
      param = buffer.readUInt32LE(cursor);
      cursor += 4;
    }

    need(buffer, cursor, length, offset);
    blocks.push({
      timestamp,
      length,
      packetId,
      param,
      offset,
      ...(retainPayload ? { payload: buffer.subarray(cursor, cursor + length) } : {})
    });
    cursor += length;
    previousPacketId = packetId;
    previousParam = param;
  }

  return blocks;
}

