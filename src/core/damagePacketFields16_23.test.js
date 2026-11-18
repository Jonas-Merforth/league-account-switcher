import assert from 'node:assert/strict';
import test from 'node:test';
import { DamageWire, readDamageSession } from './damageWire.js';
import { decodeTeamChunk } from './damageTeam.js';
import { decodeDamageBatch, decodeDamageHeroSpawn, decodeDeathRecap } from './damagePacketFields16_23.js';

const session = (build) => readDamageSession(
  `Build Version: Version ${build}\nCommand line: "127.0.0.1 5000 AAECAwQFBgcICQoLDA0ODw== 12345678"`
);

test('selects the damage decoder for the exact League build', () => {
  assert.equal(session('16.22.834.8910').protocol.combat, 743);
  const current = session('16.23.839.6405');
  assert.equal(current.protocol.combat, 172);
  assert.throws(() => session('16.23.839.6406'), /unsupported/);

  const recordedFields = Buffer.from(
    '1f6e3d7e76765989767676767676768903273dc44976764976764f76497676c87676767649767649497676497676768903273dc476767676e0291f3f7676767676767676e03c0f00767676767676597603273dc47676767676767676497676c87676764783b1c87b91',
    'hex'
  );
  const events = [];
  const wire = new DamageWire({ ...current, onDamage: (event) => events.push(event) });
  wire.dispatch(Buffer.concat([Buffer.from([172]), recordedFields]), 'in', 'sample', 1000, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].candidateSourceNetId, 0x40000040);
  assert.equal(events[0].candidateTargetNetId, 0x40000045);
  assert.equal(events[0].candidateScriptHash, 49858039);
  assert.deepEqual(events[0].schools, { physical: 125.11400604248047, magic: 0, true: 0 });
});

test('reads the 16.23 spectator clock and the damage row after it', () => {
  const payload = Buffer.from('a4a2afb531a9f8dfeafdbe512c', 'hex');
  const header = Buffer.alloc(19);
  header[0] = 1;
  header.writeFloatLE(540.25, 1);
  header.writeFloatLE(575.5, 5);
  header.writeUInt32LE(payload.length, 9);
  header.writeUInt16LE(530, 13);
  header.writeUInt32LE(0x40005e0b, 15);
  const result = decodeTeamChunk(Buffer.concat([header, payload]), undefined, session('16.23.839.6405').protocol);
  assert.equal(result.end, 540.25);
  assert.equal(result.rejected, 0);
  assert.deepEqual(result.hits, [
    { time: 540.25, sourceId: 0x40000042, targetId: 0x40005e0b, amount: 64.798583984375, school: 'magic' }
  ]);
});

test('unpacks 16.23 nested messages in order and rejects a truncated batch', () => {
  const fields = Buffer.from('a60335d5350b93ce1c', 'hex');
  assert.deepEqual(decodeDamageBatch(fields).map((packet) => packet.toString('hex')), ['2f', 'aca6']);
  assert.throws(() => decodeDamageBatch(fields.subarray(0, -1)), /Truncated/);
});

test('identifies the hero from the model field when the display name is omitted', () => {
  const fields = Buffer.from('a62f08a7f84a150d7e23a00d0d73550d0d81a0b6abffed4c8b37d425d80c50ecf15858d553f1f1f1f19494e953', 'hex');
  assert.deepEqual(decodeDamageHeroSpawn(fields), { id: 0x4000003d, model: 'Sejuani' });
});

test('reads fight duration and rounds the three Death Recap amounts per detail', () => {
  const fields = Buffer.from('a658a6002929cf821318020101e82898989962dada0f510e0e', 'hex');
  assert.deepEqual(decodeDeathRecap(fields), {
    duration: 15.25,
    schools: { physical: 12.125, magic: 23.25, true: 3.75 },
    displayTypes: { physical: 13, magic: 24, true: 4 }
  });
});
