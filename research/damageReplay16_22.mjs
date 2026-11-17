// Replays saved Damage recordings through the live meter and compares the
// totals with League Match History. Run while the League client is open.
//
// node research/damageReplay16_22.mjs [session-name-prefix ...]
// With no arguments, every recording in the app's damage-research folder runs.
import fs from 'node:fs';
import path from 'node:path';
import { DamageLive } from '../src/core/damageLive.js';
import { readChampionScriptNames } from '../src/core/damageSources.js';
import { LcuClient } from '../src/core/lcu.js';

const league = process.env.LEAGUE_PATH || 'C:\\Riot Games\\League of Legends';
const root = path.join(process.env.APPDATA, 'league-account-switcher', 'damage-research');
const lcu = new LcuClient({ leaguePath: league });
const prefixes = process.argv.slice(2);
const SCHOOLS = ['physical', 'magic', 'true'];
const whole = (value) => value == null ? '-' : Math.round(value).toLocaleString('en-US');

function compare(label, captured, official) {
  const schools = (summary) => SCHOOLS.map((school) => whole(summary?.types?.[school])).join('/');
  const diff = official ? ` diff ${(captured.total - official.total).toFixed(1)}` : '';
  console.log(`  ${label.padEnd(19)} captured ${whole(captured.total).padStart(8)} (${schools(captured)})` +
    `  League ${whole(official?.total).padStart(8)} (${schools(official)})${diff}`);
}

async function matchStats(gameId, riotId) {
  try {
    const match = await lcu.forCurrentSession().get(`/lol-match-history/v1/games/${gameId}`);
    const identity = match.participantIdentities.find(({ player }) => `${player.gameName}#${player.tagLine}` === riotId);
    return match.participants.find((participant) => participant.participantId === identity?.participantId)?.stats || null;
  } catch { return null; }
}

for (const name of fs.readdirSync(root).sort()) {
  if (prefixes.length && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
  const dir = path.join(root, name);
  const logFile = path.join(dir, 'original-r3dlog.txt');
  if (!fs.existsSync(logFile) || !fs.existsSync(path.join(dir, 'raw-ipv4.pcapng'))) continue;
  const log = fs.readFileSync(logFile, 'utf8');
  const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), 10,
    { readSpellNames: (champion) => readChampionScriptNames(league, champion) });
  live.maxReadPasses = Infinity;
  live.initialize(log.slice(0, 65536));
  // Keep every clock anchor. The live meter only needs recent ones.
  const anchors = [];
  let names = null;
  let riotId = null;
  let firstGameTime = null;
  let mode = null;
  let team = null;
  for (const line of fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.kind === 'names') names = entry.data;
    if (entry.kind === 'team') team = entry;
    if (entry.kind !== 'sample') continue;
    const data = entry.data;
    if (names) {
      // Recordings save names separately. Restore them for the label resolver.
      data.activePlayer = { ...data.activePlayer, abilities: names.abilities,
        fullRunes: { keystone: names.runes[0], generalRunes: names.runes.slice(1) } };
      const me = data.allPlayers.find((player) => player.riotId === data.activePlayer.riotId);
      if (me) Object.assign(me, { items: names.items, summonerSpells: names.summonerSpells });
    }
    live.sample(data, Date.parse(entry.requestedAt), Date.parse(entry.at));
    anchors.push(live.anchors.at(-1));
    riotId ||= data.activePlayer?.riotId;
    firstGameTime ??= entry.gameTime;
    mode = data.gameData?.gameMode;
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  live.anchors = anchors;
  live.poll({ final: true });
  const gameId = /GameStartData::GameID=(\d+)/.exec(log)?.[1];
  const stats = gameId && riotId ? await matchStats(gameId, riotId) : null;
  const late = firstGameTime > 30 || live.tracker.startedAt > 5;
  console.log(`\n## ${name} ${mode || ''} game ${gameId || '?'} ${late ? `LATE START at ${Math.round(firstGameTime)} s` : 'full game'}` +
    `${names ? '' : ' (no saved names)'}${stats ? '' : ' (no Match History)'}`);
  const champion = live.snapshot('champion');
  const all = live.snapshot('all');
  const official = (total, prefix, suffix, magic = 'magic') => stats && { total: stats[total],
    types: { physical: stats[`physical${prefix}${suffix}`], magic: stats[`${magic}${prefix}${suffix}`], true: stats[`true${prefix}${suffix}`] } };
  if (champion.meter) compare('Dealt to champions', champion.meter.total, official('totalDamageDealtToChampions', 'DamageDealt', 'ToChampions'));
  else console.log(`  Dealt to champions  ${champion.detail}`);
  if (all.meter) compare('Dealt, all targets', all.meter.total, official('totalDamageDealt', 'DamageDealt', ''));
  if (all.incoming) compare('Damage taken', all.incoming, official('totalDamageTaken', 'DamageTaken', '', 'magical'));
  if (!champion.meter) continue;
  console.log('  Sources:');
  for (const source of champion.meter.total.sources) {
    const label = `${source.slot || source.group} ${source.name}${source.detail ? ` · ${source.detail}` : ''}`;
    console.log(`    ${label.padEnd(44)} ${whole(source.amount).padStart(8)}`);
  }
  console.log(`  Attackers${champion.incoming?.unidentified ? ' (unidentified)' : ''}:`);
  for (const attacker of all.incoming?.attackers || []) {
    console.log(`    ${attacker.name.padEnd(30)} ${whole(attacker.amount).padStart(8)}  ${SCHOOLS.map((school) => whole(attacker.types[school])).join('/')}`);
  }
  const recap = champion.meter.deathRecap;
  if (recap) console.log(`  Latest Death Recap: ${whole(recap.displayTotal ?? recap.total)} over ${recap.duration?.toFixed(1)} s`);
  // The spectator stat block for the player should equal the capture at the
  // keyframe's game time. A hit at the boundary can differ by one event.
  const own = team?.heroes.find(([id]) => id === live.owner)?.[1];
  if (own) {
    const champions = new Set([...live.heroes].filter(([, model]) => live.rosterModels.has(model)).map(([id]) => id));
    const until = (filter) => live.tracker.events.filter((event) => event.time <= team.gameTime && filter(event))
      .reduce((total, event) => total + event.amount, 0);
    const scopes = [['to champions', own.damageToChampions, (event) => !event.incoming && champions.has(Number(event.targetId))],
      ['all targets', own.damageDealt, (event) => !event.incoming], ['taken', own.damageTaken, (event) => event.incoming]];
    console.log(`  Spectator keyframe ${team.keyFrameId} at ${team.gameTime.toFixed(1)} s, ${team.heroes.length} players:`);
    for (const [label, stat, filter] of scopes) {
      console.log(`    ${label.padEnd(13)} keyframe ${whole(stat.total).padStart(8)}  captured ${whole(until(filter)).padStart(8)}`);
    }
  }
  const wire = live.wire.stats;
  console.log(`  Packets: ${wire.checked} verified, ${wire.rejected} rejected, ${wire.missing} missing, ${wire.fragmentLoss} fragment losses${live.clockLoss ? ', clock gaps' : ''}`);
}
