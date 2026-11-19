import { compileLayouts } from './liveSchema.js';
import { decodeCombatBody } from './damageCombatBody.js';
import { heroStatFields } from './heroStats.js';
import { riftTurret } from './spectator/riftTurrets.js';

export function schemaFields(profile) {
  const { decode, damagePacketOwner } = compileLayouts(profile);
  const decodeHeroStatVector = (data) => {
    if (!(data instanceof Uint8Array) || data.length !== 1263) return null;
    const vector = decode.heroStats(data, true)?.values.vector;
    return vector?.length === 1260 ? vector : null;
  };
  return {
    damagePacketOwner,
    decodeHeroStatVector,
    decodeHeroStatSnapshot: (data) => heroStatFields(decodeHeroStatVector(data)),
    decodeDamageBatch(data) {
      const { lengths = [], body } = decode.batch(data).values;
      if (lengths.some((length) => !length) || lengths.reduce((sum, n) => sum + n, 0) !== body.length) {
        throw new RangeError('Invalid damage batch boundaries');
      }
      let offset = 0;
      return lengths.map((length) => {
        const start = offset;
        offset += length;
        return body.subarray(start, offset);
      });
    },
    decodeCombatEvent(data) {
      if (data?.length >= 0x7000) throw new RangeError('Invalid damage event envelope size');
      const { owner, schema, kind, body } = decode.combat(data).values;
      return decodeCombatBody(owner, schema, kind, body);
    },
    decodeDeathRecap(data) {
      if (data?.length >= 0x7000) throw new RangeError('Invalid death recap size');
      const { duration, outgoing } = decode.recap(data).values;
      if (!Number.isFinite(duration)) throw new RangeError('Invalid death recap duration');
      const schools = { physical: 0, magic: 0, true: 0 };
      const displayTypes = { ...schools };
      const time = duration >= 0 ? duration : null;
      for (const detail of outgoing?.details ?? []) {
        for (const school of Object.keys(schools)) {
          const amount = detail[school];
          if (!Number.isFinite(amount) || amount < 0) return { duration: time, schools: null, displayTypes: null };
          schools[school] += amount;
          displayTypes[school] += Math.ceil(amount);
        }
      }
      return { duration: time, schools, displayTypes };
    },
    decodeCombatMarker(data) {
      const packet = decode.marker(data);
      if (!packet) return null;
      const { owner, time, kind } = packet.values;
      return owner && Number.isFinite(time) && time >= 0 ? { owner, time, champion: kind === 0 } : null;
    },
    decodeReplication(data) {
      const { values, present } = decode.replication(data);
      const time = present.time && Number.isFinite(values.time) && values.time >= 0 ? values.time : null;
      return { time, vector: values.vector };
    },
    decodeDamageHeroSpawn(data, { spectator = false } = {}) {
      if (data?.length >= 0x7000) throw new RangeError('Invalid hero spawn size');
      const { values, present } = decode.heroSpawn(data, spectator);
      const model = values.model.toString('latin1');
      return present.id && values.id && /^[A-Za-z][A-Za-z0-9_]*$/.test(model) ? { id: values.id, model } : null;
    },
    decodeSpectatorDamageDisplay(_owner, data) {
      const { owner, ...hit } = decode.display(data, true).values;
      if (!Number.isFinite(hit.amount) || hit.amount < 0) throw new RangeError('Invalid damage display amount');
      return hit;
    },
    decodeTurret(data) {
      const { values, present } = decode.turret(data, true);
      if (values.destroyed !== present.destroyedTime || values.destroyed !== present.stateTime ||
          present.counter || values.counter !== 0) throw new Error('Unverified turret state.');
      return riftTurret(values.name, values.destroyed);
    }
  };
}
