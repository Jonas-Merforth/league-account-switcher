import { readFileSync } from 'node:fs';
import { schemaFields } from '../src/core/liveSchemaFields.js';
import { compileLayouts } from '../src/core/liveSchema.js';
import { readHealthUpdates } from '../src/core/liveReplication.js';

const { role, profile, samples } = JSON.parse(readFileSync(0));
const fields = schemaFields(profile);
const evidence = new Set();
let positive = 0;
const decodeRecap = role === 'recap' && compileLayouts(profile).decode.recap;
for (const hex of samples) {
  const data = Buffer.from(hex, 'hex');
  if (role === 'batch') {
    const messages = fields.decodeDamageBatch(data);
    if (messages.length > 1) {
      positive++;
      for (const message of messages) evidence.add(message[0]);
    }
  } else if (role === 'combat') {
    const event = fields.decodeCombatEvent(data);
    if (event?.candidateAmount > 0) {
      positive++;
      evidence.add(event.candidateTargetNetId);
    }
  } else if (role === 'replication') {
    const { vector } = fields.decodeReplication(data);
    for (const { id, health } of readHealthUpdates(vector, () => true)) {
      if (health > 0) { positive++; evidence.add(id); }
    }
  } else if (role === 'marker') {
    const marker = fields.decodeCombatMarker(data);
    if (marker?.time > 0) { positive++; evidence.add(marker.champion); }
  } else if (role === 'recap') {
    // Recovering the nested record types and consuming real recap payloads
    // establishes the envelope ID even before the damage schools are named.
    if (decodeRecap(data)) { positive++; evidence.add(hex); }
  } else throw new Error('Unknown client role');
}
if (positive < 2 || evidence.size < 2) process.exitCode = 1;
