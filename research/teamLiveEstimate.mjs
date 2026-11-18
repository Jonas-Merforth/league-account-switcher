// Scores the live team damage estimate against the exact spectator totals
// saved in the same recording. For each interval between two saved spectator
// frames, the estimate summed over that game time is compared with the
// exact increase of every player's damage to champions.
//
// node research/teamLiveEstimate.mjs [session-name-prefix ...]
// With no arguments, every recording in the app's damage-research folder runs.
// A recording still being written can be read while the game is running.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DamageLive } from '../src/core/damageLive.js';

const root = process.env.DAMAGE_RESEARCH_DIR || path.join(process.env.APPDATA, 'league-account-switcher', 'damage-research');
const whole = (value) => Math.round(value).toLocaleString('en-US');
const mean = (values) => values.reduce((total, value) => total + value, 0) / (values.length || 1);

// Replays one recording through the live meter and returns its estimate
// and the saved spectator frames.
// A finished recording keeps its game log. For one still running, read the
// newest log in League's own folder.
function gameLog(dir) {
  const saved = path.join(dir, 'original-r3dlog.txt');
  if (fs.existsSync(saved)) return fs.readFileSync(saved, 'utf8');
  const logs = path.join(process.env.LEAGUE_PATH || 'C:\\Riot Games\\League of Legends', 'Logs', 'GameLogs');
  const newest = fs.readdirSync(logs).map((name) => path.join(logs, name)).filter((entry) => fs.statSync(entry).isDirectory())
    .sort((a, b) => fs.statSync(b).birthtimeMs - fs.statSync(a).birthtimeMs)[0];
  const file = newest && fs.readdirSync(newest).find((name) => name.endsWith('_r3dlog.txt'));
  if (!file || fs.statSync(newest).birthtimeMs < fs.statSync(dir).birthtimeMs - 10_000) throw new Error('No game log for this recording');
  const descriptor = fs.openSync(path.join(newest, file), 'r');
  try {
    const buffer = Buffer.alloc(65536);
    return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8');
  } finally { fs.closeSync(descriptor); }
}

export function replayRecording(dir) {
  const log = gameLog(dir);
  const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), 10, {});
  live.maxReadPasses = Infinity;
  live.initialize(log.slice(0, 65536));
  if (!live.wire) throw new Error('No session data in the game log');
  const frames = [];
  const anchors = [];
  for (const line of fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8').split('\n')) {
    if (line.startsWith('{"kind":"team"')) {
      const frame = JSON.parse(line);
      frames.push({ ...frame, heroes: new Map(frame.heroes) });
    } else if (line.startsWith('{"kind":"sample"')) {
      const entry = JSON.parse(line);
      live.sample(entry.data, Date.parse(entry.requestedAt), Date.parse(entry.at));
      anchors.push(live.anchors.at(-1));
    }
  }
  // Keep every clock anchor. The live meter only needs recent ones.
  live.anchors = anchors;
  live.poll({ final: true });
  live.teamLive.settle();
  return { live, frames };
}

export function scoreRecording({ live, frames }) {
  const rows = new Map();
  const windows = [];
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1], frame = frames[i];
    if (!(frame.gameTime > previous.gameTime)) continue;
    const estimate = live.teamLive.since(previous.gameTime, frame.gameTime);
    const window = { from: previous.gameTime, to: frame.gameTime, players: [] };
    for (const [id, stats] of frame.heroes) {
      const before = previous.heroes.get(id);
      if (!before) continue;
      const exact = stats.damageToChampions.total - before.damageToChampions.total;
      const estimated = estimate.get(id)?.champion ?? 0;
      window.players.push({ id, team: stats.team, exact, estimated });
      const row = rows.get(id) ?? { id, team: stats.team, exact: 0, estimated: 0, error: 0, windows: 0 };
      row.exact += exact; row.estimated += estimated; row.error += Math.abs(estimated - exact); row.windows++;
      rows.set(id, row);
    }
    windows.push(window);
  }
  return { rows: [...rows.values()], windows };
}

function report(name) {
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, 'raw-ipv4.pcapng')) || !fs.existsSync(path.join(dir, 'observations.jsonl'))) return;
  let recording;
  try { recording = replayRecording(dir); } catch (error) { console.log(`\n## ${name}: ${error.message}`); return; }
  const { live, frames } = recording;
  if (frames.length < 2) { console.log(`\n## ${name}: no saved spectator frames`); return; }
  const start = live.tracker.startedAt ?? 0;
  const usable = frames.filter((frame) => frame.gameTime >= start + 1);
  const { rows, windows } = scoreRecording({ live, frames: usable });
  const myTeam = usable.at(-1).heroes.get(live.owner)?.team;
  console.log(`\n## ${name} build ${live.protocol.build}: ${windows.length} intervals from ${Math.round(usable[0].gameTime)} s to ${Math.round(usable.at(-1).gameTime)} s; ` +
    `${live.teamLive.stats.markers} markers, ${live.teamLive.stats.ticks} health ticks, decode failures ${live.teamLiveLoss}`);
  console.log('  player          side    exact  estimate  difference  average miss per interval');
  for (const row of rows.sort((a, b) => a.id - b.id)) {
    const side = row.id === live.owner ? 'you' : row.team === myTeam ? 'ally' : 'enemy';
    console.log(`  ${(live.heroes.get(row.id) || row.id.toString(16)).padEnd(15)} ${side.padEnd(5)} ${whole(row.exact).padStart(7)} ${whole(row.estimated).padStart(9)} ` +
      `${((row.estimated - row.exact) / (row.exact || 1) * 100).toFixed(1).padStart(9)}%  ${whole(row.error / row.windows).padStart(8)}`);
  }
  const others = windows.flatMap((window) => window.players.filter((player) => player.id !== live.owner));
  const miss = mean(others.map((player) => Math.abs(player.estimated - player.exact)));
  const stale = mean(others.map((player) => player.exact));
  let top = 0, counted = 0;
  for (const window of windows) {
    const allies = window.players.filter((player) => player.team === myTeam);
    if (!allies.length || Math.max(...allies.map((player) => player.exact)) < 300) continue;
    counted++;
    const best = (key) => allies.reduce((a, b) => b[key] > a[key] ? b : a).id;
    if (best('exact') === best('estimated')) top++;
  }
  console.log(`  Other players, per interval: the estimate misses by ${whole(miss)} on average. Without it the card would be short by ${whole(stale)}` +
    ` (${(100 * miss / (stale || 1)).toFixed(1)}%). Top-damage teammate right in ${top}/${counted} intervals.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const prefixes = process.argv.slice(2);
  for (const name of fs.readdirSync(root).sort()) {
    if (!prefixes.length || prefixes.some((prefix) => name.startsWith(prefix))) report(name);
  }
}
