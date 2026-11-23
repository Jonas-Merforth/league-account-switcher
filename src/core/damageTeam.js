import { liveObservers } from './spectator/observer-pool.js';
import { parseReplayBlocks } from './spectator/block-parser.js';
import { normalizePlatformId } from './spectator/regions.js';
import { protocol16_22 } from './liveProtocol.js';

// The playing client reports personal hits and champion takedowns. League's
// spectator feed carries a stat block per hero in each one-minute
// keyframe, and every hit between any two units in the 30-second chunks.
// Measured in ARAM Mayhem, a chunk is published about 30 s after it ends and
// keyframe K arrives with chunk 2K+1, about 62 s after its game time.
const HERO_STATS_BLOCK_BYTES = 1263;
const CHUNK_INFO_MS = 20_000;
const RETRY_MS = 30_000;
const UNAVAILABLE_AFTER_MS = 6 * 60_000;
const MAX_CHUNKS_PER_POLL = 4;
// A hit 0.3 ms after a keyframe's float32 timestamp was already in its totals.
const KEYFRAME_SLACK = 0.001;
const SYNC_MARGIN_SECONDS = 1;
const SCHOOLS = ['physical', 'magic', 'true'];

export function readTeamSession(log) {
  const gameId = /"-GameID=([1-9]\d{0,19})"/.exec(log)?.[1] ?? /\bGameStartData::GameID=([1-9]\d{0,19})\b/.exec(log)?.[1];
  const platformId = normalizePlatformId(/"-PlatformID=([A-Za-z]{2,4}\d?)"/.exec(log)?.[1]);
  return gameId && platformId ? { gameId, platformId } : null;
}

export function decodeTeamKeyframe(data, protocol = protocol16_22) {
  const byId = new Map();
  const byShape = new Map();
  let gameTime = null;
  for (const block of parseReplayBlocks(data, protocol)) {
    if (Number.isFinite(block.timestamp)) gameTime = Math.max(gameTime ?? 0, block.timestamp);
    // Prefer the packet ID. A block of the exact snapshot size is a
    // fallback in case the spectator stream numbers it differently.
    const expected = block.packetId === protocol.heroStats;
    if (!expected && block.length !== HERO_STATS_BLOCK_BYTES) continue;
    let stats = null;
    try { stats = protocol.fields.decodeHeroStatSnapshot(block.payload); } catch { /* Not a hero stat block. */ }
    if (stats) (expected ? byId : byShape).set(block.param >>> 0, stats);
  }
  return { gameTime, heroes: byId.size ? byId : byShape };
}

// Every damage display row in a chunk. The type code is the damage school:
// per-type sums matched Match History's physical, magic and true damage.
export function decodeTeamChunk(data, decodeHit, protocol = protocol16_22) {
  const hits = [];
  let end = null;
  let rows = 0;
  let rejected = 0;
  const decode = decodeHit ?? protocol.fields.decodeSpectatorDamageDisplay;
  for (const block of parseReplayBlocks(data, protocol)) {
    if (Number.isFinite(block.timestamp)) end = Math.max(end ?? 0, block.timestamp);
    if (block.packetId !== protocol.display) continue;
    rows++;
    let hit;
    try { hit = decode(block.param >>> 0, block.payload); } catch { rejected++; continue; }
    // Identical rows at one timestamp are separate hits and all count.
    if (hit?.amount > 0) {
      hits.push({ time: block.timestamp, sourceId: hit.sourceId, targetId: hit.targetId, amount: hit.amount,
        school: SCHOOLS[hit.typeCode] ?? null });
    }
  }
  return { end, hits, rows, rejected };
}

const cloneStats = (stats) => ({ ...stats, damageDealt: { ...stats.damageDealt },
  damageToChampions: { ...stats.damageToChampions }, damageTaken: { ...stats.damageTaken } });
function addHit(bucket, hit) {
  bucket.total += hit.amount;
  if (hit.school) bucket[hit.school] += hit.amount;
}

// Keyframe totals plus every later hit from the chunks that follow it
// without a gap. Hits on any hero count as champion damage, as in League's
// own totals. All-target damage also includes two structures League leaves
// out of its total, as the local meter does.
export function teamTotalsAt(anchor, chunks, until = Infinity) {
  if (!anchor?.heroes?.size || until < anchor.gameTime) return null;
  const heroes = new Map([...anchor.heroes].map(([id, stats]) => [id, cloneStats(stats)]));
  let gameTime = anchor.gameTime;
  let chunkId = null;
  for (let id = anchor.keyFrameId * 2 + 1; chunks.has(id); id++) {
    const chunk = chunks.get(id);
    for (const hit of chunk.hits) {
      if (!(hit.time > anchor.gameTime + KEYFRAME_SLACK) || hit.time >= until) continue;
      const source = heroes.get(hit.sourceId);
      const target = heroes.get(hit.targetId);
      if (source) {
        addHit(source.damageDealt, hit);
        if (target) addHit(source.damageToChampions, hit);
      }
      if (target) addHit(target.damageTaken, hit);
    }
    gameTime = Math.min(until, Math.max(gameTime, chunk.end ?? gameTime));
    chunkId = id;
    if (gameTime >= until) break;
  }
  return { keyFrameId: anchor.keyFrameId, chunkId, gameTime, heroes };
}

// Anchor the personal meter once. Both clocks describe the same game, but
// packet arrival can fall on the other side of a hit's spectator timestamp.
// Use a quiet boundary so that a hit belongs to exactly one recording.
export function damageBeforeRecording(feed, live) {
  const start = live.tracker.startedAt;
  const frame = feed?.latest;
  if (!(start > 0) || !live.wire?.stats.checked || !Number.isFinite(frame?.gameTime) || frame.gameTime < start ||
      !frame.heroes.has(live.owner) || live.ownerConflict) return null;
  const margin = SYNC_MARGIN_SECONDS;
  const chunks = feed.chunks ? [...feed.chunks.values()] : [];
  if (frame.chunkId != null && chunks.some((chunk) => chunk.rejected)) return null;
  const stats = (hero) => ({ champion: { ...hero.damageToChampions }, all: { ...hero.damageDealt } });
  if (feed.anchor?.gameTime < start - margin && frame.gameTime >= start + margin &&
      !chunks.some((chunk) => chunk.hits.some((hit) => hit.sourceId === live.owner && Math.abs(hit.time - start) <= margin))) {
    const atStart = teamTotalsAt(feed.anchor, feed.chunks, start);
    if (atStart?.gameTime === start) return stats(atStart.heroes.get(live.owner));
  }

  // A newer keyframe can arrive first. Remove the local hits already in it.
  // Only do this after the capture has read past the frame without loss.
  if (live.clockLoss || live.reader.remaining || live.wire.stats.missing || live.wire.stats.fragmentLoss ||
      !Number.isFinite(live.lastServerPacketAt) ||
      !(live.gameTimeAt(live.lastServerPacketAt, 5000) >= frame.gameTime + margin) ||
      !(live.lastGameTime >= frame.gameTime + margin)) return null;
  const before = stats(frame.heroes.get(live.owner));
  const owner = String(live.owner);
  for (const hit of live.tracker.events) {
    if (hit.time > frame.gameTime + margin) break;
    if (hit.incoming || hit.sourceId !== owner) continue;
    if (Math.abs(hit.time - frame.gameTime) <= margin) return null;
    const buckets = [before.all];
    if (frame.heroes.has(hit.targetId)) buckets.push(before.champion);
    for (const bucket of buckets) {
      bucket.total -= hit.amount;
      for (const [school, amount] of Object.entries(hit.schools ?? { [hit.damageType]: hit.amount })) {
        if (!SCHOOLS.includes(school) && amount) return null;
        if (amount) bucket[school] -= amount;
      }
    }
  }
  for (const bucket of Object.values(before)) {
    for (const [key, amount] of Object.entries(bucket)) {
      // The keyframe accumulators use float32, while captured hits are summed as doubles.
      if (amount < -0.01) return null;
      bucket[key] = Math.max(0, amount);
    }
  }
  return before;
}

export class TeamDamageFeed {
  constructor({ platformId, gameId, observer, now = Date.now, onKeyframe, onChunk, onUnreadable,
    decodeHit, protocol = protocol16_22 }) {
    this.observer = observer ?? liveObservers.acquire({ platformId, gameId });
    this.now = now;
    this.onKeyframe = onKeyframe;
    this.onChunk = onChunk;
    this.onUnreadable = onUnreadable;
    this.decodeHit = decodeHit;
    this.protocol = protocol;
    this.createdAt = now();
    this.nextPollAt = 0;
    this.state = 'waiting';
    this.anchor = null;
    this.chunks = new Map();
    this.latest = null;
    this.ended = false;
  }
  async poll() {
    if (this.pending || this.closed || this.ended || this.now() < this.nextPollAt) return;
    this.pending = true;
    let delay = CHUNK_INFO_MS;
    try {
      if (!this.metadataLoaded) {
        await this.observer.getMetadata();
        this.metadataLoaded = true;
      }
      const info = await this.observer.getLastChunkInfo();
      const keyFrameId = Number(info?.keyFrameId);
      if (Number.isInteger(keyFrameId) && keyFrameId > 0 && keyFrameId !== this.anchor?.keyFrameId &&
          keyFrameId !== this.unreadableKeyFrameId) {
        const data = await this.observer.getKeyFrame(keyFrameId);
        if (data) this.readKeyframe(keyFrameId, data);
      }
      const lastChunk = Number(info?.chunkId);
      if (this.anchor && !this.chunksUnreadable && Number.isInteger(lastChunk)) await this.readChunks(lastChunk);
      const end = Number(info?.endGameChunkId);
      this.ended = end > 0 && lastChunk >= end && (this.chunksUnreadable || this.latest?.chunkId === lastChunk);
      this.state = this.latest ? 'live' : this.unreadableKeyFrameId ? 'unreadable' : 'waiting';
      this.error = null;
      // The observer reports when its next 30-second chunk is due.
      const next = Number(info?.nextAvailableChunk);
      if (Number.isFinite(next) && next > 0) delay = Math.min(30_000, Math.max(5_000, next + 1_000));
    } catch (error) {
      delay = Math.max(RETRY_MS, error?.retryAfterMs || 0);
      if (!this.metadataLoaded && error?.statusCode === 404) {
        // The game is not on the spectator server, at least not yet.
        this.state = this.now() - this.createdAt > UNAVAILABLE_AFTER_MS ? 'unavailable' : 'waiting';
        delay = Math.max(delay, this.state === 'unavailable' ? 60_000 : RETRY_MS);
      } else {
        this.error = error?.message || 'Spectator feed request failed.';
        if (!this.latest && this.state !== 'unreadable') this.state = 'error';
      }
    } finally {
      this.nextPollAt = this.now() + delay;
      this.pending = false;
    }
  }
  readKeyframe(keyFrameId, data) {
    // A request can finish after a new recording replaced this feed.
    if (this.closed) return;
    let frame = null;
    try { frame = decodeTeamKeyframe(data, this.protocol); } catch { /* Unreadable framing. */ }
    if (!frame?.heroes.size) {
      this.unreadableKeyFrameId = keyFrameId;
      this.onUnreadable?.(`keyframe-${keyFrameId}`, data);
      return;
    }
    this.unreadableKeyFrameId = null;
    this.anchor = { keyFrameId, gameTime: frame.gameTime, heroes: frame.heroes };
    for (const id of this.chunks.keys()) if (id <= keyFrameId * 2) this.chunks.delete(id);
    this.update();
    this.onKeyframe?.(this.anchor);
  }
  // Chunks after the latest keyframe, oldest first. A chunk the observer has
  // advertised but not served yet is retried on the next poll.
  async readChunks(lastChunk) {
    let fetched = 0;
    for (let id = this.anchor.keyFrameId * 2 + 1; id <= lastChunk && fetched < MAX_CHUNKS_PER_POLL; id++) {
      if (this.chunks.has(id)) continue;
      const data = await this.observer.getChunk(id);
      if (this.closed || !data) return;
      fetched++;
      let chunk = null;
      try { chunk = decodeTeamChunk(data, this.decodeHit, this.protocol); } catch { /* Unreadable framing. */ }
      // Keep showing keyframes if this patch's damage rows cannot be read.
      if (!chunk || (chunk.rows && chunk.rejected > chunk.rows / 2)) {
        this.chunksUnreadable = true;
        this.onUnreadable?.(`chunk-${id}`, data);
        return;
      }
      const from = this.latest.gameTime;
      this.chunks.set(id, chunk);
      if (this.update()) this.onChunk?.(this.latest, chunk, from);
    }
  }
  update() {
    const previous = this.latest;
    const totals = teamTotalsAt(this.anchor, this.chunks);
    this.latest = totals && { ...totals, fetchedAt: this.now() };
    return !!this.latest && (previous?.chunkId !== this.latest.chunkId || previous?.keyFrameId !== this.latest.keyFrameId);
  }
  close() {
    this.closed = true;
    this.observer.release?.();
  }
}

const modelOf = (player) => /^game_character_displayname_([a-z0-9]+)$/i.exec(player?.rawChampionName || '')?.[1]?.toLowerCase() ?? null;
const teamCode = (team) => team === 'ORDER' ? 100 : team === 'CHAOS' ? 200 : null;
const isPlayer = (player, playerId) => !!playerId && (player?.riotId === playerId || player?.summonerName === playerId);

// Hero object IDs follow the Live Client roster order from game time 1 on.
// Hero spawn models win when every hero was seen spawning.
function matchRoster(ids, roster, heroModels) {
  if (!roster?.length || roster.length !== ids.length) return null;
  const byModel = new Map(roster.map((player) => [modelOf(player), player]));
  if (heroModels && byModel.size === roster.length && ids.every((id) => byModel.has(heroModels.get(id)))) {
    return ids.map((id) => byModel.get(heroModels.get(id)));
  }
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.some((id, index) => id !== sorted[0] + index)) return null;
  return ids.map((id) => roster[id - sorted[0]]);
}

function damageSummary(stats) {
  const pick = (value) => ({ total: value.total, ...Object.fromEntries(SCHOOLS.map((school) => [school, value[school]])) });
  return { kills: stats.kills, deaths: stats.deaths, assists: stats.assists,
    champion: pick(stats.damageToChampions), all: pick(stats.damageDealt), taken: pick(stats.damageTaken) };
}

function groupTeams(players, myTeam) {
  const teams = [];
  for (const side of ['ally', 'enemy']) {
    const members = players.filter((player) => myTeam == null ? side === 'ally' : (player.team === myTeam) === (side === 'ally'));
    if (members.length) teams.push({ side: myTeam == null ? 'unknown' : side, players: members });
  }
  return teams;
}

// These two measurements cover disjoint players on a given kill. A killer's
// final hit has no verified school. Only the assists have a three-way split.
export function teamFromTakedowns(live, roster, playerId) {
  if (!live?.takedowns?.size || live.ownerConflict || !roster?.length) return null;
  const byModel = new Map();
  for (const player of roster) {
    const model = modelOf(player);
    if (model) byModel.set(model, byModel.has(model) ? null : player);
  }
  const myTeam = teamCode(roster.find((player) => isPlayer(player, playerId))?.team);
  if (!myTeam) return null;
  const totals = new Map();
  for (const hit of live.takedowns.values()) {
    const source = byModel.get(live.heroes.get(hit.sourceId));
    const team = teamCode(source?.team);
    const victimTeam = teamCode(byModel.get(live.heroes.get(hit.targetId))?.team);
    if (!team || !victimTeam || team === victimTeam) continue;
    const row = totals.get(hit.sourceId) ?? { name: source.championName?.slice(0, 40) || 'Unidentified champion', team, you: isPlayer(source, playerId),
      finalHits: 0, physical: 0, magic: 0, true: 0, total: 0 };
    row.finalHits += hit.finalHits;
    for (const type of SCHOOLS) row[type] += hit[type];
    row.total = row.finalHits + row.physical + row.magic + row.true;
    totals.set(hit.sourceId, row);
  }
  return totals.size ? groupTeams([...totals.values()], myTeam) : null;
}

// The live scoreboard is ahead of the spectator feed.
function withLiveScores(row, player) {
  const scores = player?.scores;
  if (['kills', 'deaths', 'assists'].every((key) => Number.isSafeInteger(scores?.[key]))) {
    Object.assign(row, { kills: scores.kills, deaths: scores.deaths, assists: scores.assists });
  }
  return row;
}

// Champion damage since the spectator totals, from the live estimate. The
// part from the local hit stream is exact. The rest is estimated.
function liveDamage(live, id) {
  const amount = live?.get(id);
  if (!amount || !(amount.champion > 0)) return null;
  return { champion: amount.champion, estimated: Math.max(0, amount.champion - amount.exact) };
}

// Latest spectator keyframe as named teams, with the team of the local player first.
// The optional live estimate covers the game time after that keyframe.
export function teamFromKeyframe(frame, { roster, playerId, heroModels, gameTime, live } = {}) {
  if (!frame?.heroes?.size) return null;
  const ids = [...frame.heroes.keys()];
  const players = matchRoster(ids, roster, heroModels);
  // Every matched slot must agree with the team in the stat block.
  const named = players && players.every((player, index) => teamCode(player?.team) === frame.heroes.get(ids[index]).team);
  const rows = ids.map((id, index) => {
    const stats = frame.heroes.get(id);
    const player = named ? players[index] : null;
    const row = { name: player?.championName?.slice(0, 40) || 'Unidentified champion', you: !!player && isPlayer(player, playerId),
      team: stats.team, ...damageSummary(stats) };
    const recent = liveDamage(live, id);
    if (recent) row.live = recent;
    return withLiveScores(row, player);
  });
  const me = named ? rows.find((row) => row.you) : null;
  const myTeam = me?.team ?? teamCode(roster?.find((player) => isPlayer(player, playerId))?.team);
  return { source: 'spectator', keyFrameId: frame.keyFrameId, chunkId: frame.chunkId ?? null, gameTime: frame.gameTime,
    behind: Number.isFinite(gameTime) && Number.isFinite(frame.gameTime) ? Math.max(0, gameTime - frame.gameTime) : null,
    identified: named, ...(live && { liveSince: frame.gameTime }), teams: groupTeams(rows, myTeam) };
}

// Before the first spectator totals, or in a game without a spectator feed,
// the live estimate is all there is. It starts when the recording does.
export function teamFromLive(live, { roster, playerId, heroes, teams, since } = {}) {
  if (!live?.size || !roster?.length || !heroes?.size || !teams?.size) return null;
  const byModel = new Map();
  for (const player of roster) {
    const model = modelOf(player);
    if (model) byModel.set(model, byModel.has(model) ? null : player);
  }
  const zero = () => ({ total: 0, physical: 0, magic: 0, true: 0 });
  const rows = [];
  for (const [id, team] of teams) {
    const player = byModel.get(heroes.get(id));
    if (!player || teamCode(player.team) !== team) return null;
    const row = { name: player.championName?.slice(0, 40) || 'Unidentified champion', you: isPlayer(player, playerId), team,
      kills: 0, deaths: 0, assists: 0, champion: zero(), all: zero(), taken: zero() };
    const recent = liveDamage(live, id);
    if (recent) row.live = recent;
    rows.push(withLiveScores(row, player));
  }
  const me = rows.filter((row) => row.you);
  if (me.length !== 1 || !rows.some((row) => row.live)) return null;
  return { source: 'live', gameTime: null, behind: null, identified: true, liveSince: since ?? 0, teams: groupTeams(rows, me[0].team) };
}

export function matchPlayerIds(player) {
  const riotId = (name, tag) => name && tag ? `${name}#${tag}` : null;
  return [player?.riotId, player?.summonerName, riotId(player?.gameName, player?.tagLine),
    riotId(player?.riotIdGameName, player?.riotIdTagLine)]
    .filter((id) => typeof id === 'string' && id).map((id) => id.toLowerCase());
}

export function fillFinalChampionNames(view, roster) {
  if (!roster?.length || view?.source !== 'matchHistory' || view.identified) return view;
  const teams = view.teams.map((group) => {
    const unknown = group.players.filter((player) => player.name === 'Unidentified champion');
    if (unknown.length !== 1) return group;
    const names = roster.filter((player) => teamCode(player.team) === unknown[0].team)
      .map((player) => player.championName?.slice(0, 40));
    const remaining = new Set(names);
    if (names.length !== group.players.length || remaining.size !== names.length || remaining.has(undefined)) return group;
    for (const player of group.players) {
      if (player !== unknown[0] && !remaining.delete(player.name)) return group;
    }
    const [name] = remaining;
    if (!name) return group;
    return { ...group, players: group.players.map((player) => player === unknown[0] ? { ...player, name } : player) };
  });
  return { ...view, teams, identified: teams.every(({ players }) => players.every((player) => player.name !== 'Unidentified champion')) };
}

// Final Match History totals for all ten players.
export function teamFromMatch(match, { roster, playerId, championNames } = {}) {
  const identities = new Map((match?.participantIdentities || []).map(({ participantId, player }) => [participantId, matchPlayerIds(player)]));
  const localId = playerId?.toLowerCase();
  const rows = [];
  for (const participant of match?.participants || []) {
    const stats = participant?.stats;
    if (!stats || ![100, 200].includes(participant.teamId)) return null;
    const ids = identities.get(participant.participantId) || [];
    const player = roster?.find((entry) => teamCode(entry.team) === participant.teamId &&
      matchPlayerIds(entry).some((id) => ids.includes(id)));
    const name = championNames?.get(Number(participant.championId)) || player?.championName;
    const amount = (key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0 ? stats[key] : 0;
    const schools = (total, prefix, suffix, magic = 'magic') => ({ total: amount(total),
      physical: amount(`physical${prefix}${suffix}`), magic: amount(`${magic}${prefix}${suffix}`), true: amount(`true${prefix}${suffix}`) });
    rows.push({ name: name?.slice(0, 40) || 'Unidentified champion', you: ids.includes(localId),
      team: participant.teamId, kills: amount('kills'), deaths: amount('deaths'), assists: amount('assists'),
      champion: schools('totalDamageDealtToChampions', 'DamageDealt', 'ToChampions'),
      all: schools('totalDamageDealt', 'DamageDealt', ''),
      taken: schools('totalDamageTaken', 'DamageTaken', '', 'magical') });
  }
  const me = rows.filter((row) => row.you);
  if (me.length !== 1) return null;
  return fillFinalChampionNames({ source: 'matchHistory',
    identified: rows.every((row) => row.name !== 'Unidentified champion'), teams: groupTeams(rows, me[0].team) }, roster);
}
