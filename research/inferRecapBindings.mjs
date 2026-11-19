import { readFileSync } from 'node:fs';
import { compileLayouts } from '../src/core/liveSchema.js';

// Each observation identifies a zero-based incoming recap in this recording.
// League rounds each individual detail up before adding it to the display.
const { profile, samples, observations } = JSON.parse(readFileSync(0));
const { decode } = compileLayouts(profile);
const names = (role, type) => profile.layouts[role].fields.filter(f => f.type === type).map(f => f.name);
const [outgoing] = names('recap', 'struct');
const [details] = names('entry', 'structs');
const schools = ['physical', 'magic', 'true'];
let durations = names('recap', 'float');
const floats = names('detail', 'float');
let assignments = [];
for (const physical of floats) for (const magic of floats) for (const actual of floats) {
  if (new Set([physical, magic, actual]).size === 3) assignments.push({ physical, magic, true: actual });
}
if (!Array.isArray(observations) || !observations.length) throw new Error('Expected at least one labeled recap');
for (const { index, duration, displayTypes } of observations) {
  if (!Number.isSafeInteger(index) || !samples[index] || !Number.isFinite(duration) || duration < 0
      || !schools.every(s => Number.isSafeInteger(displayTypes?.[s]) && displayTypes[s] >= 0)) {
    throw new Error('Invalid recap index, duration or displayed school totals');
  }
  const { values } = decode.recap(Buffer.from(samples[index], 'hex'));
  durations = durations.filter(offset => Math.abs(values[offset] - duration) <= 0.051);
  const rows = values[outgoing]?.[details] ?? [];
  assignments = assignments.filter(fields => schools.every(s => rows.reduce((sum, r) => sum + Math.ceil(r[fields[s]]), 0) === displayTypes[s]));
}
if (durations.length !== 1 || assignments.length !== 1) {
  throw new Error(`Recap evidence leaves ${durations.length} durations and ${assignments.length} school assignments. Check the ordinal or add a death with different school totals.`);
}
console.log(JSON.stringify({ recap: { duration: Number(durations[0]) },
  detail: Object.fromEntries(schools.map(s => [s, Number(assignments[0][s])])) }));
