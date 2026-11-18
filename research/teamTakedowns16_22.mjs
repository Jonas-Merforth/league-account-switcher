// node research/teamTakedowns16_22.mjs <finished recording directory> [...]
// Compare the production packet reader with the same game's spectator hits.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DamageLive } from '../src/core/damageLive.js';
import { decodeTeamChunk, decodeTeamKeyframe, readTeamSession, teamFromTakedowns } from '../src/core/damageTeam.js';
import { readReplay } from './teamChunks16_22.mjs';

const replayDirectory = process.env.LEAGUE_REPLAY_DIR || path.join(os.homedir(), 'Documents', 'League of Legends', 'Replays');
const schools = ['physical', 'magic', 'true'];

function matchesAssist(hits, record) {
  const sums = { physical: 0, magic: 0, true: 0 };
  // Test successive suffixes of this attacker's hits on the victim. League
  // can carry credited damage through a revive that logs a ChampionKill.
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index];
    sums[hit.school] += hit.amount;
    if (schools.every((school) => Math.abs(sums[school] - record.schools[school]) < 0.05)) return true;
  }
  return false;
}

for (const dir of process.argv.slice(2)) {
  const log = fs.readFileSync(path.join(dir, 'original-r3dlog.txt'), 'utf8');
  const { platformId, gameId } = readTeamSession(log);
  const { segments } = readReplay(path.join(replayDirectory, `${platformId}-${gameId}.rofl`));
  const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'));
  live.initialize(log.slice(0, 65536));
  const protocol = live.protocol;
  const heroIds = [...decodeTeamKeyframe(segments.find((s) => s.type === 2).data, protocol).heroes.keys()].sort((a, b) => a - b);
  const hits = segments.filter((s) => s.type === 1).sort((a, b) => a.id - b.id)
    .flatMap((s) => decodeTeamChunk(s.data, undefined, protocol).hits);
  const samples = fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.kind === 'sample');
  const anchors = [];
  for (const sample of samples) {
    live.sample(sample.data, Date.parse(sample.requestedAt), Date.parse(sample.at));
    anchors.push(live.anchors.at(-1));
  }
  const records = [];
  live.wire.onTakedown = (event) => { records.push(event); live.addTakedown(event); };
  live.anchors = anchors;
  live.maxReadPasses = Infinity;
  live.poll({ final: true });
  const last = samples.at(-1).data;
  const roster = last.allPlayers;
  const namesOf = (id) => {
    const player = roster[heroIds.indexOf(id)];
    return [player?.riotId?.split('#')[0], player?.summonerName].filter(Boolean);
  };
  const kills = last.events.Events.filter((e) => e.EventName === 'ChampionKill');
  let checked = 0;
  let matched = 0;
  let finalHits = 0;
  let assists = 0;
  for (const record of records) {
    if (!heroIds.includes(record.sourceId) || !heroIds.includes(record.targetId)) continue;
    checked++;
    const source = namesOf(record.sourceId);
    const victim = namesOf(record.targetId);
    const time = live.gameTimeAt(record.time, Infinity);
    const kill = kills.find((k) => Math.abs(k.EventTime - time) <= 0.35 && victim.includes(k.VictimName) &&
      (record.takedown === 'finalHit' ? source.includes(k.KillerName) : k.Assisters.some((name) => source.includes(name))));
    if (!kill) continue;
    const priorHits = hits.filter((h) => h.sourceId === record.sourceId && h.targetId === record.targetId &&
      h.time <= kill.EventTime + 0.2);
    if (record.takedown === 'finalHit') {
      finalHits++;
      if (priorHits.some((h) => Math.abs(h.time - kill.EventTime) < 0.3 && h.amount === record.amount)) matched++;
    } else {
      assists++;
      if (matchesAssist(priorHits, record)) matched++;
    }
  }
  const teams = teamFromTakedowns(live, roster, last.activePlayer.riotId) || [];
  const captured = teams.flatMap((group) => group.players).reduce((n, row) => n + row.total, 0);
  const opposingHits = hits.filter((h) => {
    const source = roster[heroIds.indexOf(h.sourceId)], victim = roster[heroIds.indexOf(h.targetId)];
    return source && victim && source.team !== victim.team;
  });
  const allDamage = opposingHits.reduce((n, hit) => n + hit.amount, 0);
  console.log(gameId, { checked, finalHits, assists, matched, captured: Math.round(captured),
    percentOfAllChampionDamage: (100 * captured / allDamage).toFixed(1) });
  if (!checked || matched !== checked) process.exitCode = 1;
}
