import { readDamageProtocol } from './damageWire.js';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { DamageIpCapture } from './damageIpCapture.js';
import { DamageLive } from './damageLive.js';
import { DamageHistory, withCapturedSources } from './damageHistory.js';
import { normalizePlatformId } from './spectator/regions.js';
import { discardTemporaryCapture } from './damageTemporaryFiles.js';
import { DEFAULT_FIGHT_GAP } from './damageTracker.js';
import { readChampionScriptNames } from './damageSources.js';
import { antiHealItemIds } from './healingTracker.js';
import { TeamDamageFeed, damageBeforeRecording, matchPlayerIds, readTeamSession, teamFromKeyframe, teamFromLive, teamFromMatch, teamFromTakedowns } from './damageTeam.js';

function readGameLogHeader(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if (isTransientLogError(error)) return '';
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function isTransientLogError(error) {
  return ['EBUSY', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code);
}

function getMatchResult(match, gameId, playerId, gameStartedAt, platformId) {
  if (String(match?.gameId) !== gameId || !Number.isFinite(match.gameDuration) || match.gameDuration <= 0) return null;
  // A reconnect starts a new process during the original match.
  if (platformId && match.platformId && platformId !== normalizePlatformId(match.platformId)) return null;
  if (!Number.isFinite(match.gameCreation) || gameStartedAt < match.gameCreation - 60_000 ||
      gameStartedAt > match.gameCreation + match.gameDuration * 1000 + 60_000) return null;
  const identities = (match.participantIdentities || []).filter(({ player }) =>
    matchPlayerIds(player).includes(playerId.toLowerCase()));
  if (identities.length !== 1) return null;
  const stats = match.participants?.find((p) => p.participantId === identities[0].participantId)?.stats;
  if (!stats) return null;
  const totals = {};
  for (const [scope, suffix] of [['all', 'Dealt'], ['champion', 'DealtToChampions']]) {
    const total = stats[`totalDamage${suffix}`];
    if (!Number.isSafeInteger(total) || total < 0) continue;
    const types = {};
    for (const school of ['physical', 'magic', 'true']) {
      const amount = stats[`${school}Damage${suffix}`];
      if (Number.isSafeInteger(amount) && amount >= 0) types[school] = amount;
    }
    const includesPracticeDummies = scope === 'champion' && match.gameMode === 'PRACTICETOOL';
    totals[scope] = { total, types, sources: [], duration: match.gameDuration, dps: total / match.gameDuration,
      fromMatchHistory: true, includesPracticeDummies };
  }
  if (!Object.keys(totals).length) return null;
  const augmentIds = Array.from({ length: 6 }, (_, index) => stats[`playerAugment${index + 1}`])
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return { totals, augmentIds, gameMode: match.gameMode };
}

function historyMatchKey(gameId, playerId, regionOrCreation) {
  // Compact history omits account names, including when one match has several recordings.
  return crypto.createHash('sha256').update(JSON.stringify([gameId, playerId.toLowerCase(), regionOrCreation])).digest('hex');
}

function damageView(recording, target, { gap, finalized } = {}) {
  const live = recording?.snapshot(target);
  const meter = live?.meter;
  if (meter) {
    if (gap) meter.gaps = true;
    const latestFight = meter.fights.at(-1);
    if (latestFight && finalized) latestFight.active = false;
  }
  return { meter: meter || null, incoming: live?.incoming || null, dealt: live?.dealt || null, meterStatus: live?.detail || null,
    healing: live?.healing || null };
}

// Healing does not depend on the target filter, so saved games keep one copy.
function championScope(recording, options) {
  const { healing, ...view } = damageView(recording, 'champion', options);
  return view;
}

// Ability, summoner spell, item and rune names that label damage sources.
export function sourceNameData(data) {
  const active = data?.activePlayer;
  const me = (data?.allPlayers || []).find((player) =>
    (active?.riotId && player.riotId === active.riotId) || (active?.summonerName && player.summonerName === active.summonerName));
  const pick = (entry, keys) => Object.fromEntries(keys.filter((key) => ['string', 'number'].includes(typeof entry?.[key]))
    .map((key) => [key, entry[key]]));
  const runes = active?.fullRunes;
  return {
    abilities: Object.fromEntries(Object.entries(active?.abilities || {})
      .map(([slot, ability]) => [slot, pick(ability, ['id', 'displayName', 'rawDisplayName'])])),
    summonerSpells: Object.fromEntries(Object.entries(me?.summonerSpells || {})
      .map(([slot, spell]) => [slot, pick(spell, ['displayName', 'rawDisplayName'])])),
    items: (me?.items || []).map((item) => pick(item, ['itemID', 'displayName'])),
    runes: [runes?.keystone, ...(runes?.generalRunes || [])].filter(Boolean)
      .map((rune) => pick(rune, ['id', 'displayName', 'rawDisplayName']))
  };
}

export function readLiveGame() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://127.0.0.1:2999/liveclientdata/allgamedata',
      { rejectUnauthorized: false, timeout: 1200 }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new Error('Live response too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('Game data unavailable');
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) { reject(error); }
        });
      });
    req.on('timeout', () => req.destroy(new Error('Game data timed out')));
    req.on('error', reject);
  });
}

// Live Client snapshots supply timing and roster. The IP observer supplies damage.
export class DamageRecorder {
  constructor({ directory, temporaryDirectory, leaguePath, readGame = readLiveGame, readMatch, readItems,
    captureFactory = (options) => new DamageIpCapture(options),
    readChampions,
    readSpellNames = (champion) => readChampionScriptNames(leaguePath(), champion),
    teamFeedFactory = (options) => new TeamDamageFeed(options) }) {
    this.readSpellNames = readSpellNames;
    this.teamFeedFactory = teamFeedFactory;
    this.directory = directory;
    this.temporaryDirectory = temporaryDirectory;
    this.retainResearch = !temporaryDirectory;
    this.temporarySessions = new Set();
    this.history = new DamageHistory(directory);
    this.leaguePath = leaguePath;
    this.readGame = readGame;
    this.readMatch = readMatch;
    this.readItems = readItems;
    this.readChampions = readChampions;
    this.capture = captureFactory({ leaguePath, onUpdate: (state) => { this.packet = state; },
      onHelperExit: () => this.cleanupTemporarySessions() });
    this.packet = { state: 'off', detail: 'No recording started' };
    this.samples = 0;
    this.fightGap = DEFAULT_FIGHT_GAP;
    this.matchRetries = new Set();
    this.continuous = false;
  }
  snapshot(target = 'all') {
    const damage = damageView(this.live, target, { gap: this.error || this.packet.captureLimit || this.packet.state === 'error', finalized: this.finalized });
    const official = this.matchTotals?.[target];
    const matchTotals = official
      ? { ...this.matchTotals, [target]: withCapturedSources(official, damage.meter?.total) }
      : this.matchTotals;
    return { ...this.packet, busy: !!this.capture.busy, samples: this.samples,
      sessionDirectory: this.sessionDirectory || null, gameTime: this.gameTime ?? null,
      originalLogSaved: !!this.originalLogSaved, retainResearch: this.retainResearch, error: this.error || null,
      matchTotals: matchTotals || null, team: this.teamSnapshot(),
      takedowns: teamFromTakedowns(this.live, this.roster, this.activePlayerId),
      ...damage, fightGap: this.fightGap };
  }
  status(target, savedId) {
    const state = this.snapshot(target);
    const showLastGame = !state.gameStartedAt && !state.samples;
    const id = savedId || (showLastGame ? this.history.latestId : null);
    const view = id ? this.history.read(id, target) : null;
    return { ...state, continuous: this.continuous, historyRevision: this.history.revision,
      viewId: view ? id : null, view };
  }
  // Spectator totals plus the live estimate for the time since them, until
  // the game ends. Then Match History for all players.
  teamSnapshot() {
    if (this.matchTeam) return { ...this.matchTeam, state: 'final' };
    if (this.live?.protocolError) return null;
    const feed = this.teamFeed;
    const live = this.live;
    const estimate = live?.teamLive.events.length && !live.ownerConflict ? live.teamLive : null;
    const frame = feed?.latest;
    let view = teamFromKeyframe(frame, { roster: this.roster, playerId: this.activePlayerId,
      heroModels: live?.heroModels, gameTime: this.finalized ? null : this.gameTime,
      live: frame && estimate ? estimate.since(frame.gameTime) : undefined });
    if (!view && estimate) {
      view = teamFromLive(estimate.since(), { roster: this.roster, playerId: this.activePlayerId, heroes: live.heroes,
        teams: estimate.teams, since: live.tracker.startedAt });
    }
    if (!feed && !view) return null;
    // Lost packets leave holes in the estimate, never in the spectator totals.
    const liveGaps = view?.liveSince != null && (live.clockLoss || live.wire.stats.missing > 0 ||
      live.wire.stats.fragmentLoss > 0 || live.teamLiveLoss > 0);
    return { ...view, ...(view?.liveSince != null && { liveGaps }), state: feed?.state ?? 'live', error: feed?.error || null };
  }
  setFightGap(seconds) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Fight pause must be 1–60 seconds.');
    this.fightGap = seconds;
    this.live?.tracker.setFightGap(seconds);
    return this.snapshot();
  }
  start(mode = 'always') {
    if (this.capture.busy || this.pending || (this.live && !this.finalized)) throw new Error('Wait for the previous recording to finish.');
    this.beginRecording(mode === 'always');
    return this.snapshot();
  }
  beginRecording(continuous) {
    this.startedAt = Date.now();
    this.samples = 0; this.gameTime = null;
    this.originalLogSaved = false; this.error = null; this.logSource = null;
    this.logSession = null;
    this.matchTotals = null;
    this.matchTeam = null;
    this.teamFeed?.close();
    this.teamFeed = null;
    this.roster = null;
    this.savedUnreadableKeyframe = false;
    this.activePlayerId = null;
    this.itemRequests = 0;
    this.lastNames = null;
    this.sessionDirectory = path.join(this.temporaryDirectory || this.directory,
      new Date(this.startedAt).toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(this.sessionDirectory, { recursive: true });
    this.file = path.join(this.sessionDirectory, 'observations.jsonl');
    this.live = new DamageLive(path.join(this.sessionDirectory, 'raw-ipv4.pcapng'), this.fightGap,
      { readSpellNames: this.readSpellNames });
    if (this.itemNames) this.live.sourceNames.addItemNames(this.itemNames);
    this.live.setAntiHealItems(this.antiHealItems);
    this.finalized = false;
    try {
      if (this.retainResearch) fs.writeFileSync(this.file, JSON.stringify({ kind: 'start', at: new Date().toISOString(), schema: 1,
        purpose: 'Damage source validation; snapshots contain no damage measurements' }) + '\n', { flag: 'wx' });
      this.capture.start(this.file, { continuous });
      this.continuous = continuous;
      this.timer ??= setInterval(() => this.poll(), 1000);
      this.timer.unref?.();
    } catch (error) {
      this.finalized = true;
      this.continuous = false;
      this.packet = { state: 'error', detail: error.message };
      this.capture.stop();
      this.finishTemporarySession(this.sessionDirectory);
      throw error;
    }
  }
  async poll() {
    if (this.pending) return;
    this.pending = true;
    try {
      if (!this.capture.busy) {
        this.finalize();
        if (this.continuous && this.packet.state === 'complete' && !this.shuttingDown) {
          this.beginRecording(true);
          return;
        }
        this.continuous = false;
        clearInterval(this.timer);
        this.timer = null;
        return;
      }
      if (this.packet.state !== 'capturing') return;
      this.pollLive();
      const requestedAt = new Date().toISOString();
      const data = await this.readGame().catch(() => null);
      if (!data || !Number.isFinite(data.gameData?.gameTime)) return;
      this.gameTime = data.gameData.gameTime;
      this.activePlayerId ||= data.activePlayer?.riotId || data.activePlayer?.summonerName;
      // Allowlist avoids retaining unrelated client/account data.
      const players = (data.allPlayers || []).map((p) => ({ riotId: p.riotId, summonerName: p.summonerName,
        championName: p.championName, rawChampionName: p.rawChampionName, team: p.team, isDead: p.isDead, scores: p.scores }));
      // At game time 0 the roster lists the local player first.
      if (this.gameTime >= 1 && players.length) this.roster = players;
      const receivedAt = new Date().toISOString();
      this.live.sample(data, Date.parse(requestedAt), Date.parse(receivedAt));
      this.requestItemNames();
      void this.requestChampionNames();
      if (this.samples < 7200) {
        if (this.retainResearch) this.recordSample(data, players, requestedAt, receivedAt);
        this.samples++;
      }
      this.pollLive();
      this.pollTeam();
    } catch (error) { this.error = error.message; this.stop(); }
    finally { this.pending = false; }
  }
  recordSample(data, players, requestedAt, receivedAt) {
    // Save source names only when they change, so replay can restore them.
    const names = sourceNameData(data);
    const namesKey = JSON.stringify(names);
    if (namesKey !== this.lastNames) {
      this.lastNames = namesKey;
      fs.appendFileSync(this.file, JSON.stringify({ kind: 'names', at: receivedAt, gameTime: this.gameTime, data: names }) + '\n');
    }
    fs.appendFileSync(this.file, JSON.stringify({ kind: 'sample', requestedAt, at: receivedAt,
      gameTime: this.gameTime, data: { gameData: data.gameData, allPlayers: players,
        clockAnchor: { requestedAt, receivedAt, gameTime: this.gameTime },
        activePlayer: { riotId: data.activePlayer?.riotId, summonerName: data.activePlayer?.summonerName },
        events: data.events } }) + '\n');
  }
  requestChampionNames() {
    if (this.championNamesRequest) return this.championNamesRequest;
    if (!this.readChampions || this.championNames || Date.now() < (this.championNamesRetryAt || 0)) {
      return Promise.resolve();
    }
    this.championNamesRetryAt = Date.now() + 5000;
    this.championNamesRequest = Promise.resolve().then(() => this.readChampions()).then((champions) => {
      if (!Array.isArray(champions)) return;
      const names = new Map();
      for (const champion of champions) {
        const id = Number(champion?.id);
        if (Number.isInteger(id) && id > 0 && typeof champion.name === 'string' && champion.name) names.set(id, champion.name);
      }
      if (names.size) this.championNames = names;
    }).catch(() => {}).finally(() => { this.championNamesRequest = null; });
    return this.championNamesRequest;
  }
  // Item names label damage from items the player no longer holds. The
  // descriptions name the Wounds items for the anti-heal advice.
  requestItemNames() {
    if (!this.readItems || this.itemRequests >= 3 || this.itemNames) return;
    this.itemRequests++;
    Promise.resolve().then(() => this.readItems()).then((items) => {
      if (!Array.isArray(items) || !items.length || this.itemNames) return;
      this.itemNames = items.map((item) => ({ id: item?.id, name: item?.name }));
      this.antiHealItems = antiHealItemIds(items);
      this.live?.sourceNames.addItemNames(this.itemNames);
      this.live?.setAntiHealItems(this.antiHealItems);
    }).catch(() => {});
  }
  findLog() {
    const root = path.join(this.leaguePath(), 'Logs', 'GameLogs');
    if (!fs.existsSync(root)) return;
    const gameStart = Date.parse(this.packet.gameStartedAt);
    if (!Number.isFinite(gameStart)) return;
    const candidates = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() &&
      fs.statSync(path.join(root, d.name)).birthtimeMs >= gameStart - 10000)
      .flatMap((d) => fs.readdirSync(path.join(root, d.name)).filter((n) => n.endsWith('_r3dlog.txt'))
        .map((n) => path.join(root, d.name, n)))
      .map((file) => ({ file, stat: fs.statSync(file) }))
      .filter(({ stat }) => stat.birthtimeMs >= gameStart - 10000 && stat.size < 64 * 1024 * 1024);
    if (candidates.length === 1) this.logSource = candidates[0].file;
  }
  pollLive(options) {
    if (!this.logSource) {
      try { this.findLog(); }
      catch (error) { if (!isTransientLogError(error)) throw error; }
    }
    if (!this.logSource) return;
    if (!this.live.wire) this.live.initialize(readGameLogHeader(this.logSource));
    this.live.poll(options);
    this.syncBeforeRecording();
  }
  syncBeforeRecording() {
    if (this.teamFeed && this.live && !this.live.beforeRecording && !this.error && this.packet.state !== 'error') {
      this.live.beforeRecording = damageBeforeRecording(this.teamFeed, this.live);
    }
  }
  pollTeam() {
    if (!this.teamFeed && this.logSource) {
      const header = readGameLogHeader(this.logSource);
      const session = this.logSession ??= readTeamSession(header);
      const protocol = readDamageProtocol(header);
      if (!session || !protocol) return;
      this.teamFeed = this.teamFeedFactory({ ...session,
        protocol,
        onKeyframe: (frame) => this.recordTeamFrame(frame),
        onChunk: (frame, chunk, from) => this.recordTeamFrame(frame, chunk, from),
        onUnreadable: (label, data) => this.saveUnreadableSpectatorData(label, data) });
    }
    void this.teamFeed?.poll().catch(() => {});
  }
  // Stat blocks and chunk totals are kept so a recording can be checked
  // against the capture and Match History.
  recordTeamFrame(frame, chunk, from) {
    this.syncBeforeRecording();
    // The stat blocks name each champion's team outright.
    this.live?.setTeamIds(new Map([...frame.heroes].map(([id, stats]) => [id, stats.team])));
    if (!this.retainResearch) return;
    try {
      // Keep independent per-hit truth for scoring bursts in development recordings.
      const championHits = chunk?.hits.filter(({ sourceId, targetId }) => frame.heroes.has(sourceId) &&
        frame.heroes.has(targetId) && frame.heroes.get(sourceId).team !== frame.heroes.get(targetId).team)
        .map(({ time, sourceId, targetId, amount, school }) => [time, sourceId, targetId, amount, school]);
      fs.appendFileSync(this.file, JSON.stringify({ kind: 'team', at: new Date().toISOString(), keyFrameId: frame.keyFrameId,
        ...(frame.chunkId != null && { chunkId: frame.chunkId }), gameTime: frame.gameTime, heroes: [...frame.heroes],
        ...(chunk && { hitsFrom: from, championHits, rejected: chunk.rejected }) }) + '\n');
    } catch { /* The live view does not depend on the saved copy. */ }
  }
  // Spectator data this version cannot read is kept once for patch research.
  // On an unverified hotfix, an unreadable keyframe also fails the session closed.
  saveUnreadableSpectatorData(label, data) {
    if (typeof label === 'string' && label.startsWith('keyframe-') && this.live?.unverifiedHotfix && !this.error) {
      this.live.failHotfix();
      if (this.live.protocolError) {
        this.error = this.live.protocolError;
        this.stop();
      }
    }
    if (!this.retainResearch || this.savedUnreadableKeyframe || !Buffer.isBuffer(data) || data.length > 16 * 1024 * 1024 ||
        !/^(keyframe|chunk)-\d{1,6}$/.test(label)) return;
    this.savedUnreadableKeyframe = true;
    try { fs.writeFileSync(path.join(this.sessionDirectory, `spectator-${label}.bin`), data, { flag: 'wx' }); }
    catch { /* Research copy only. */ }
  }
  finalize() {
    if (this.finalized || !this.sessionDirectory) return;
    this.finalized = true;
    this.teamFeed?.close();
    try {
      if (!this.error) this.pollLive({ final: true });
      if (this.live.reader.remaining) this.live.clockLoss = true;
      this.live.wire?.finish();
    } catch (error) { this.error = error.message; }
    let session = this.logSession;
    let gameId = session?.gameId;
    const gameStartedAt = Date.parse(this.packet.gameStartedAt);
    try {
      if (!gameId && this.logSource) {
        const log = readGameLogHeader(this.logSource);
        session = readTeamSession(log);
        gameId = session?.gameId ?? log.match(/\bGameStartData::GameID=([1-9]\d*)[ \t]*\r?$/m)?.[1];
      }
      if (this.retainResearch) this.preserveLog();
    } catch (error) { this.error ||= error.message; }
    const workingDirectory = this.sessionDirectory;
    const id = path.basename(workingDirectory);
    if (!this.retainResearch && !this.packet.gameStartedAt && !this.samples) {
      this.finishTemporarySession(workingDirectory);
      this.sessionDirectory = null;
      return;
    }
    const savedDirectory = path.join(this.directory, id);
    const platformId = session?.platformId;
    const playerId = this.activePlayerId;
    const summary = { ...this.snapshot(), sessionDirectory: savedDirectory,
      ...(platformId && playerId && { matchKey: historyMatchKey(gameId, playerId, platformId) }),
      startedAt: this.packet.startedAt || new Date(this.startedAt).toISOString(),
      championName: this.roster?.find((player) =>
        [player.riotId, player.summonerName].includes(playerId))?.championName,
      scopes: { champion: championScope(this.live, { gap: this.error || this.packet.captureLimit || this.packet.state === 'error', finalized: true }) } };
    if (!this.retainResearch && this.roster) {
      summary.roster = this.roster.map(({ championName, team }) => ({ championName, team }));
    }
    const context = { id, summary, recording: this.live, roster: this.roster, gameId, playerId, gameStartedAt, platformId };
    this.writeSummary(context);
    this.sessionDirectory = savedDirectory;
    this.finishTemporarySession(workingDirectory);
    if (gameId && playerId && this.readMatch && Number.isFinite(gameStartedAt)) void this.refreshMatchTotals(context);
  }
  writeSummary({ id, summary }) {
    const directory = path.join(this.directory, id);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'summary.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(summary, null, this.retainResearch ? 2 : 0));
    fs.renameSync(file + '.tmp', file);
    this.history.saved(id, summary);
  }
  finishTemporarySession(directory) {
    if (this.retainResearch) return;
    this.temporarySessions.add(directory);
    this.cleanupTemporarySessions();
  }
  cleanupTemporarySessions() {
    for (const directory of this.temporarySessions) {
      const helperActive = directory === this.capture.controlDirectory;
      if (discardTemporaryCapture(this.temporaryDirectory, directory, { helperActive })) this.temporarySessions.delete(directory);
    }
  }
  async refreshMatchTotals(context, attempt = 1) {
    const { recording, gameId, playerId, gameStartedAt, roster, summary } = context;
    if (this.shuttingDown) return;
    let match, result;
    try {
      match = await this.readMatch(gameId);
      result = getMatchResult(match, gameId, playerId, gameStartedAt, context.platformId);
    } catch {}
    if (this.shuttingDown) return;
    if (result) {
      await this.requestChampionNames();
      if (this.shuttingDown) return;
      summary.matchKey ??= historyMatchKey(gameId, playerId, normalizePlatformId(match.platformId) || match.gameCreation);
      recording.sourceNames.setMatchAugments(result.gameMode, result.augmentIds);
      const team = teamFromMatch(match, { roster, playerId, championNames: this.championNames });
      if (recording === this.live) {
        this.matchTotals = result.totals;
        this.matchTeam = team;
      }
      const options = { gap: summary.error || summary.captureLimit || summary.state === 'error', finalized: true };
      Object.assign(summary, damageView(recording, 'all', options));
      summary.scopes.champion = championScope(recording, options);
      summary.matchTotals = Object.fromEntries(Object.entries(result.totals).map(([target, totals]) =>
        [target, withCapturedSources(totals, (target === 'all' ? summary : summary.scopes.champion).meter?.total)]));
      if (team) summary.team = { ...team, state: 'final' };
      try { this.writeSummary(context); } catch (error) { if (recording === this.live) this.error ||= error.message; }
    } else if (attempt < 10) {
      const timer = setTimeout(() => {
        this.matchRetries.delete(timer);
        void this.refreshMatchTotals(context, attempt + 1);
      }, 5000);
      this.matchRetries.add(timer);
      timer.unref?.();
    }
  }
  preserveLog() {
    if (!this.logSource) return;
    if (fs.statSync(this.logSource).size > 64 * 1024 * 1024) throw new Error('Original game log exceeded the retention limit.');
    fs.copyFileSync(this.logSource, path.join(this.sessionDirectory, 'original-r3dlog.txt'));
    this.originalLogSaved = true;
  }
  stop() { this.continuous = false; this.capture.stop(); return this.snapshot(); }
  async shutdown() {
    this.shuttingDown = true;
    for (const timer of this.matchRetries) clearTimeout(timer);
    this.matchRetries.clear();
    this.stop();
    // Keep the heartbeat alive while the helper stops and converts its own capture.
    const deadline = Date.now() + 60000;
    while ((this.capture.busy || this.pending) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    clearInterval(this.timer);
    this.timer = null;
    if (!this.capture.busy && !this.pending) this.finalize();
  }
}
