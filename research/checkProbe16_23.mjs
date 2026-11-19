// Regression check for research/liveproto: the probe must reproduce the byte
// tables, selector sets and byte orders that were ported by hand for
// 16.23.8396405 in src/core/damagePacketFields16_23.js.
//
//   python research/describe_packets.py <16.23 macOS binary> 503 530 313 172 309 88 314 502 921 --json schemas.json
//   node research/checkProbe16_23.mjs schemas.json
//
// Fields are looked up by their offset in the 16.23 packet object.
import fs from 'node:fs';
import { byte, netIdTable, rotateLeft, swapBits } from '../src/core/livePacketReader.js';

if (!process.argv[2]) throw new Error('Expected the JSON written by describe_packets.py');
const source = fs.readFileSync(new URL('../src/core/damagePacketFields16_23.js', import.meta.url), 'utf8');
const { packets, owner } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const table = (transform) => Buffer.from(Array.from({ length: 256 }, (_, value) => transform(value))).toString('hex');
const field = (id, offset) => packets[id].fields.find((f) => f.object?.[0] === offset);
const results = [];
const check = (name, actual, expected) => results.push([name, actual === expected]);

const decodeNetId = (value) => netIdTable[byte(netIdTable[rotateLeft(byte(netIdTable[value ^ 255] + 0x54), 1)] + 0xb4)];
check('owner id', owner, table(decodeNetId));
check('503 marker time table', source.includes(field(503, 0x10).readers[0].table), true);
check('503 marker time selector', JSON.stringify(field(503, 0x10).cases.map((c, i) => 'read' in c ? i : null).filter((i) => i !== null)), '[0,1,4,6]');
check('309 replication vector table', source.includes(field(309, 0x18).readers[0].table), true);
check('309 replication vector order', field(309, 0x18).readers[0].order, 'outside-in');
check('309 replication time', field(309, 0x10).readers[0].table, table((v) => byte(v + 0x82)));
const heroStatByte = (value) => netIdTable[rotateLeft(byte(0x91 - value) ^ 0xd4, 1)] ^ 0x7f;
check('313 hero stat bytes', field(313, 0x10).readers[0].table, table(heroStatByte));
check('313 hero stat length', field(313, 0x10).readers[0].length, table(heroStatByte));
check('313 hero stat order', field(313, 0x10).readers[0].order, 'reverse');
const combatBodyByte = (value) => netIdTable[byte(rotateLeft(byte(0x16 - netIdTable[swapBits(value)]), 3) + 0x34)];
const combatKindByte = (value) => byte(rotateLeft(rotateLeft(value, 4) ^ 255, 6) + 0x0e);
const combatSchemaByte = (value) => netIdTable[swapBits(rotateLeft(byte((value ^ 0x70) + 0x0a), 7)) ^ 255];
check('172 combat body', field(172, 0x18).readers[0].table, table(combatBodyByte));
check('172 combat body length', field(172, 0x18).readers[0].length, table(combatBodyByte));
check('172 combat kind', field(172, 0x10).readers[0].table, table(combatKindByte));
check('172 combat schema', field(172, 0x28).readers[0].table, table(combatSchemaByte));
const displayAmountByte = (value) => netIdTable[rotateLeft(byte(netIdTable[value ^ 5] + 0xa7), 3)] ^ 0x22;
const displaySchoolByte = (value) => rotateLeft(rotateLeft(byte(0x3b - value), 3) ^ 255, 4) ^ 255;
const displayTargetByte = (value) => rotateLeft(netIdTable[byte((rotateLeft(swapBits(rotateLeft(value, 1)) ^ 255, 6) ^ 0x82) + 0x37)], 6);
const displayUnusedIdByte = (value) => rotateLeft(byte(0xdb - swapBits(value)), 1);
const displaySourceByte = (value) => rotateLeft(netIdTable[netIdTable[value ^ 0x24] ^ 0xf2] ^ 0xb0, 1);
const displayHashByte = (value) => rotateLeft(swapBits(netIdTable[byte(5 - netIdTable[value])]) ^ 0x5b, 3);
check('530 display amount', field(530, 0x10).readers[0].table, table(displayAmountByte));
check('530 display school', field(530, 0x14).readers[0].table, table(displaySchoolByte));
check('530 display target', field(530, 0x18).readers[0].table, table(displayTargetByte));
check('530 display unused id', field(530, 0x24).readers[0].table, table(displayUnusedIdByte));
check('530 display source', field(530, 0x28).readers[0].table, table(displaySourceByte));
check('530 display hash', field(530, 0x2c).readers[0].table, table(displayHashByte));
const recapObjectIdByte = (value) => byte((rotateLeft(value ^ 255, 2) ^ 0xf1) + 0xfa) ^ 0x8a;
check('502 recap object id', field(502, 0x28).readers[0].table, table(recapObjectIdByte));
const batchLength = table((v) => rotateLeft(byte((v ^ 0x40) + 0xb6) ^ 0xb0, 3) ^ 0xde);
const lengths = field(314, 0x10).readers[0];
check('314 batch count', lengths.count, batchLength);
check('314 batch lengths', lengths.table, batchLength);
check('314 batch length order', lengths.order, 'forward');
check('921 state time', field(921, 0x10).readers[0].table,
  table((v) => netIdTable[byte((byte(v + 0xa3) ^ 0xdd) + 0x50)] ^ 128));
check('921 destroyed time', field(921, 0x40).readers[0].table,
  table((v) => rotateLeft(netIdTable[rotateLeft(swapBits(byte((v ^ 0x5b) + 0x8e)), 1)], 4)));
check('88 spawn object id', field(88, 0x54).readers[0].table, table(recapObjectIdByte));
const modelBytes = [
  (value) => netIdTable[byte(netIdTable[byte(rotateLeft(value ^ 255, 6) + 0x49)] + 0xc1)],
  (value) => rotateLeft(byte(value + 0xfc), 2) ^ 0x21,
  (value) => byte(swapBits(netIdTable[byte(value + 0x82)]) + 0x13)
];
// Hand-written model reader: selector 1 and 3 use the plain table, selector 2
// inverts the length's continuation bit and XORs the content with 0x80.
const model = field(88, 0x40);
check('88 spawn model selector 1 content', model.readers[model.cases[1].read].table, table(modelBytes[0]));
check('88 spawn model selector 2 content', model.readers[model.cases[2].read].table, table((v) => modelBytes[1](v) ^ 0x80));
check('88 spawn model selector 2 length', model.readers[model.cases[2].read].length, table((v) => modelBytes[1](v) ^ 0x80));
check('88 spawn model selector 3 content', model.readers[model.cases[3].read].table, table(modelBytes[2]));
check('88 spawn model selector 3 order', model.readers[model.cases[3].read].order, 'outside-in');
for (const [name, ok] of results) console.log(ok ? 'ok  ' : 'FAIL', name);
console.log(results.filter(([, ok]) => ok).length + '/' + results.length, 'match');
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
