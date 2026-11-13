import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { DamageRecorder } from '../src/core/damageRecorder.js';

const recorder = new DamageRecorder({
  directory: path.resolve('.local-research/damage-sessions'),
  leaguePath: () => process.env.LEAGUE_PATH || 'C:\\Riot Games\\League of Legends'
});
recorder.start();
console.log('Windows will request administrator permission for the scoped packet recorder.');
console.log('Wait for "Recorder ready" before starting Practice Tool.');
console.log('Type a note and press Enter to mark an action; type stop to finish.');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim().toLowerCase() === 'stop') recorder.stop();
  else if (line.trim()) fs.appendFileSync(path.join(recorder.sessionDirectory, 'markers.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), gameTime: recorder.gameTime, note: line.slice(0, 2000) }) + '\n');
});
let last = '';
const timer = setInterval(() => {
  const state = recorder.snapshot();
  const message = `${state.state}: ${state.detail}`;
  if (message !== last) { console.log(message); last = message; }
  if (!state.busy) {
    clearInterval(timer);
    recorder.shutdown().then(() => {
      console.log(`Saved locally: ${recorder.sessionDirectory}`);
      console.log(`Game snapshots: ${recorder.samples}. Original game log saved: ${recorder.originalLogSaved}.`);
      input.close();
      process.exitCode = state.state === 'error' ? 1 : 0;
    });
  }
}, 1000);
process.on('SIGINT', () => recorder.stop());
