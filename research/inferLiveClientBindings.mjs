// Cross-check proposed packet meanings against local roster, death events and personal hits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLayouts } from '../src/core/liveSchema.js';
import { schemaFields } from '../src/core/liveSchemaFields.js';

const [profilePath, ...files] = process.argv.slice(2);
if (files.length < 4 || files.length % 2) throw new Error('Expected profile and two or more dump/recording pairs');
const profile = JSON.parse(readFileSync(profilePath));
const { ids, layouts } = profile;
const fields = schemaFields(profile);
const { decode } = compileLayouts(profile);
const names = (role, type) => layouts[role].fields.filter(f => f.type === type).map(f => f.name);
const [outgoing] = names('recap', 'struct');
const [details] = names('entry', 'structs');
const schools = ['physical', 'magic', 'true'];
const candidates = [];
class IncompleteGame extends Error {}
for (const duration of names('recap', 'float')) {
  const floats = names('detail', 'float');
  for (const physical of floats) for (const magic of floats) for (const pure of floats) {
    if (new Set([physical, magic, pure]).size === 3) candidates.push({ duration, physical, magic, true: pure });
  }
}

function observe(folder, spawn) {
  const anchors = [];
  const models = new Set();
  const deaths = new Set();
  for (const line of readFileSync(join(folder, 'observations.jsonl'), 'utf8').trim().split(/\r?\n/)) {
    const sample = JSON.parse(line);
    if (sample.kind !== 'sample' || !(sample.gameTime >= 1)) continue;
    const { activePlayer, allPlayers, events } = sample.data;
    const me = allPlayers.find(p => (activePlayer?.riotId && p.riotId === activePlayer.riotId)
      || (activePlayer?.summonerName && p.summonerName === activePlayer.summonerName));
    if (!me) continue;
    const model = /^game_character_displayname_(\w+)$/i.exec(me.rawChampionName)?.[1] ?? me.championName;
    models.add(model.toLowerCase());
    const playerNames = [me.riotId, me.summonerName].filter(Boolean);
    const short = me.riotId?.split('#')[0];
    if (short && allPlayers.filter(p => p.riotId?.split('#')[0] === short).length === 1) playerNames.push(short);
    for (const e of events?.Events ?? []) {
      if (e.EventName === 'ChampionKill' && playerNames.includes(e.VictimName)) deaths.add(e.EventTime);
    }
    anchors.push({ clock: sample.gameTime, wall: (Date.parse(sample.at) + Date.parse(sample.requestedAt)) / 2 });
  }
  const local = [...spawn].filter(([, model]) => models.has(model));
  if (spawn.size !== 10 || local.length !== 1 || !anchors.length || deaths.size < 2) throw new IncompleteGame('Need opening spawns and local roster/death observations');
  const wall = [...deaths].map(t => {
    const anchor = anchors.reduce((a, b) => Math.abs(b.clock - t) < Math.abs(a.clock - t) ? b : a);
    return anchor.wall + 1000 * (t - anchor.clock);
  });
  return { owner: local[0][0], model: local[0][1], deaths: wall };
}

function checkGame(dump, folder) {
  if (dump.build !== profile.build || !dump.expandedBatches || !Number.isFinite(dump.startedAt)) throw new Error('Expected full timed dump of exact build');
  const rows = key => (dump.payloads[key] ?? []).map((hex, i) => ({ data: Buffer.from(hex, 'hex'), time: dump.times[key][i] }));
  const incoming = id => rows('in:' + id);
  const heroes = new Map(incoming(ids.heroSpawn).map(({ data }) => {
    const hero = fields.decodeDamageHeroSpawn(data);
    return [hero.id, hero.model.toLowerCase()];
  }));
  const { owner, model, deaths } = observe(folder, heroes);
  const recaps = incoming(ids.recap).map(({ time, data }) => ({ time, values: decode.recap(data).values }));
  const matched = new Set();
  for (const { time } of recaps) {
    const event = deaths.filter(t => Math.abs(t - (dump.startedAt + time)) <= 2000);
    if (event.length !== 1 || matched.has(event[0])) throw new Error('A recap has no unique local death observation');
    matched.add(event[0]);
  }
  if (matched.size !== deaths.length || matched.size < 2) throw new Error('Incomplete local death coverage');

  const actions = [];
  const witnesses = [];
  for (const [key, count] of Object.entries(dump.counts)) {
    const packet = Number(key.split(':')[1]);
    if (count < recaps.length || packet === ids.recap || dump.payloads[key].length !== count) continue;
    let local;
    try { local = rows(key).filter(({ data }) => fields.damagePacketOwner(data) === owner); } catch { continue; }
    if (key.startsWith('out:')) {
      if (local.length === count && new Set(dump.payloads[key]).size >= 30) actions.push({ packet, count });
    } else if (!Object.values(ids).includes(packet) && local.length === recaps.length && recaps.every(r => local.some(l => Math.abs(l.time - r.time) <= 2))
        && local.every(l => recaps.some(r => Math.abs(l.time - r.time) <= 2))) witnesses.push(packet);
  }
  actions.sort((a, b) => b.count - a.count);
  if (!actions.length || actions[0].count < 2 * (actions[1]?.count ?? 0)) throw new Error('Ambiguous outgoing local-player action');
  const hits = incoming(ids.combat).flatMap(({ data, time }) => {
    const h = fields.decodeCombatEvent(data);
    return h?.candidateSourceNetId === owner && heroes.has(h.candidateTargetNetId) ? [{ time, schools: h.schools }] : [];
  });
  const evidence = [];
  for (const { values, time } of recaps) {
    const entries = values[outgoing]?.[details] ?? [];
    if (!entries.length) continue;
    const matches = candidates.filter(c => {
      const duration = values[c.duration];
      if (!(duration > 0 && duration <= 45.1)) return false;
      const recorded = hits.filter(h => h.time >= time - duration * 1000 - 100 && h.time <= time + 100);
      if (!recorded.length) return false;
      return schools.every(s => {
        const sum = entries.reduce((n, e) => n + e[c[s]], 0);
        const actual = recorded.reduce((n, h) => n + h.schools[s], 0);
        return Math.abs(sum - actual) <= 0.05;
      });
    });
    // The server can include a different hit at the window edge. A death with
    // no exact reconstruction supplies no label. Contradictory matches fail below.
    if (matches.length) evidence.push(matches);
  }
  if (!evidence.length) throw new IncompleteGame('No recap reconstructs the recorded local champion hits');
  return { action: actions[0].packet, witnesses, evidence, model, count: recaps.length };
}

const games = [];
for (let i = 0; i < files.length; i += 2) {
  try { games.push(checkGame(JSON.parse(readFileSync(files[i])), files[i + 1])); }
  catch (error) {
    if (!(error instanceof IncompleteGame)) throw error;
    console.error('Skipped incomplete recording:', error.message);
  }
}
if (games.length < 2) throw new Error('Need two complete recordings with independent death evidence');
const answers = candidates.filter(c => games.every(g => g.evidence.every(matches => matches.includes(c))));
const independent = games.filter(g => candidates.filter(c => g.evidence.every(m => m.includes(c))).length === 1).length;
const witness = games[0].witnesses.filter(id => games.every(g => g.witnesses.includes(id))).sort((a, b) => a - b);
if (new Set(games.map(g => g.model)).size < 2 || new Set(games.map(g => g.action)).size !== 1 ||
    !witness.length || answers.length !== 1 || !independent || games.reduce((n, g) => n + g.evidence.length, 0) < 3) {
  throw new Error(`Inconclusive cross-game evidence: ${answers.length} recap bindings, ${witness.length} local-death witnesses. Collect another complete game.`);
}
const { duration, ...detail } = answers[0];
console.error(`Verified ${games.length} games, ${games.reduce((n,g) => n+g.count,0)} local deaths, ${games.reduce((n,g) => n+g.evidence.length,0)} recap windows; equivalent death witnesses: ${witness.join(', ')}`);
console.log(JSON.stringify({ ids: { ownerAction: games[0].action, recapOwner: witness[0] },
  offsets: { recap: { duration: Number(duration) }, detail: Object.fromEntries(schools.map(s => [s, Number(detail[s])])) } }));
