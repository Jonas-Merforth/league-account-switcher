import { ObserverClient } from './spectator/observer-client.js';
import { parseBlocks } from './spectator/block-parser.js';
import { normalizePlatformId } from './spectator/regions.js';
import { DAMAGE_DISPLAY_PACKET, HERO_STATS_PACKET, decodeHeroStatSnapshot,
  decodeSpectatorDamageDisplay } from './damagePacketFields16_22.js';

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
const SCHOOLS = ['physical', 'magic', 'true'];

export function readTeamSession(log) {
  const gameId = /"-GameID=([1-9]\d{0,19})"/.exec(log)?.[1] ?? /\bGameStartData::GameID=([1-9]\d{0,19})\b/.exec(log)?.[1];
  const platformId = normalizePlatformId(/"-PlatformID=([A-Za-z]{2,4}\d?)"/.exec(log)?.[1]);
  return gameId && platformId ? { gameId, platformId } : null;
}

export function decodeTeamKeyframe(data) {
  const byId = new Map();
  const byShape = new Map();
  let gameTime = null;
  for (const block of parseBlocks(data, { retainPayload: true })) {
    if (Number.isFinite(block.timestamp)) gameTime = Math.max(gameTime ?? 0, block.timestamp);
    // Prefer the 16.22 packet ID. A block of the exact snapshot size is a
    // fallback in case the spectator stream numbers it differently.
    const expected = block.packetId === HERO_STATS_PACKET;
    if (!expected && block.length !== HERO_STATS_BLOCK_BYTES) continue;
    let stats = null;
    try { stats = decodeHeroStatSnapshot(block.payload); } catch { /* Not a hero stat block. */ }
    if (stats) (expected ? byId : byShape).set(block.param >>> 0, stats);
  }
  return { gameTime, heroes: byId.size ? byId : byShape };
}

// Every damage display row in a chunk. The type code is the damage school:
// per-type sums matched Match History's physical, magic and true damage.
export function decodeTeamChunk(data, decodeHit = decodeSpectatorDamageDisplay) {
  const hits = [];
  let end = null;
  let rows = 0;
  let rejected = 0;
  for (const block of parseBlocks(data, { retainPayload: true })) {
    if (Number.isFinite(block.timestamp)) end = Math.max(end ?? 0, block.timestamp);
    if (block.packetId !== DAMAGE_DISPLAY_PACKET) continue;
    rows++;
    let hit;
    try { hit = decodeHit(block.param >>> 0, block.payload); } catch { rejected++; continue; }
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
export function teamTotalsAt(anchor, chunks) {
  if (!anchor?.heroes?.size) return null;
  const heroes = new Map([...anchor.heroes].map(([id, stats]) => [id, cloneStats(stats)]));
  let gameTime = anchor.gameTime;
  let chunkId = null;
  for (let id = anchor.keyFrameId * 2 + 1; chunks.has(id); id++) {
    const chunk = chunks.get(id);
    for (const hit of chunk.hits) {
      if (!(hit.time > anchor.gameTime + KEYFRAME_SLACK)) continue;
      const source = heroes.get(hit.sourceId);
      const target = heroes.get(hit.targetId);
      if (source) {
        addHit(source.damageDealt, hit);
        if (target) addHit(source.damageToChampions, hit);
      }
      if (target) addHit(target.damageTaken, hit);
    }
    gameTime = Math.max(gameTime, chunk.end ?? gameTime);
    chunkId = id;
  }
  return { keyFrameId: anchor.keyFrameId, chunkId, gameTime, heroes };
}

export class TeamDamageFeed {
  constructor({ platformId, gameId, observer, now = Date.now, onKeyframe, onChunk, onUnreadable,
    decodeHit = decodeSpectatorDamageDisplay }) {
    this.observer = observer ?? new ObserverClient({ platformId, gameId });
    this.now = now;
    this.onKeyframe = onKeyframe;
    this.onChunk = onChunk;
    this.onUnreadable = onUnreadable;
    this.decodeHit = decodeHit;
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
    try { frame = decodeTeamKeyframe(data); } catch { /* Unreadable framing. */ }
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
      try { chunk = decodeTeamChunk(data, this.decodeHit); } catch { /* Unreadable framing. */ }
      // Keep showing keyframes if this patch's damage rows cannot be read.
      if (!chunk || (chunk.rows && chunk.rejected > chunk.rows / 2)) {
        this.chunksUnreadable = true;
        this.onUnreadable?.(`chunk-${id}`, data);
        return;
      }
      this.chunks.set(id, chunk);
      if (this.update()) this.onChunk?.(this.latest);
    }
  }
  update() {
    const previous = this.latest;
    const totals = teamTotalsAt(this.anchor, this.chunks);
    this.latest = totals && { ...totals, fetchedAt: this.now() };
    return !!this.latest && (previous?.chunkId !== this.latest.chunkId || previous?.keyFrameId !== this.latest.keyFrameId);
  }
  close() { this.closed = true; }
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

// Latest spectator keyframe as named teams, with the local player's team first.
export function teamFromKeyframe(frame, { roster, playerId, heroModels, gameTime } = {}) {
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
    // The live scoreboard is ahead of the spectator feed.
    const scores = player?.scores;
    if (['kills', 'deaths', 'assists'].every((key) => Number.isSafeInteger(scores?.[key]))) {
      Object.assign(row, { kills: scores.kills, deaths: scores.deaths, assists: scores.assists });
    }
    return row;
  });
  const me = named ? rows.find((row) => row.you) : null;
  const myTeam = me?.team ?? teamCode(roster?.find((player) => isPlayer(player, playerId))?.team);
  return { source: 'spectator', keyFrameId: frame.keyFrameId, chunkId: frame.chunkId ?? null, gameTime: frame.gameTime,
    behind: Number.isFinite(gameTime) && Number.isFinite(frame.gameTime) ? Math.max(0, gameTime - frame.gameTime) : null,
    identified: named, teams: groupTeams(rows, myTeam) };
}

// Final Match History totals for all ten players.
export function teamFromMatch(match, { roster, playerId } = {}) {
  const identities = new Map((match?.participantIdentities || []).map(({ participantId, player }) => [participantId,
    player?.gameName && player?.tagLine ? `${player.gameName}#${player.tagLine}` : player?.summonerName]));
  const rows = [];
  for (const participant of match?.participants || []) {
    const stats = participant?.stats;
    if (!stats || ![100, 200].includes(participant.teamId)) return null;
    const id = identities.get(participant.participantId);
    const player = roster?.find((entry) => id && (entry.riotId === id || entry.summonerName === id));
    const amount = (key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0 ? stats[key] : 0;
    const schools = (total, prefix, suffix, magic = 'magic') => ({ total: amount(total),
      physical: amount(`physical${prefix}${suffix}`), magic: amount(`${magic}${prefix}${suffix}`), true: amount(`true${prefix}${suffix}`) });
    rows.push({ name: player?.championName?.slice(0, 40) || 'Unidentified champion', you: !!id && id === playerId,
      team: participant.teamId, kills: amount('kills'), deaths: amount('deaths'), assists: amount('assists'),
      champion: schools('totalDamageDealtToChampions', 'DamageDealt', 'ToChampions'),
      all: schools('totalDamageDealt', 'DamageDealt', ''),
      taken: schools('totalDamageTaken', 'DamageTaken', '', 'magical') });
  }
  const me = rows.filter((row) => row.you);
  if (me.length !== 1) return null;
  return { source: 'matchHistory', identified: rows.every((row) => row.name !== 'Unidentified champion'),
    teams: groupTeams(rows, me[0].team) };
}
