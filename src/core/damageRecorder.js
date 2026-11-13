import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { DamageIpCapture } from './damageIpCapture.js';
import { DamageLive } from './damageLive.js';

function readGameLogHeader(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(descriptor); }
}

function getMatchTotals(match, gameId, playerId, gameStartedAt) {
  if (String(match?.gameId) !== gameId || !Number.isFinite(match.gameDuration) || match.gameDuration <= 0) return null;
  // Game IDs are regional. Check the creation time as well as the participant.
  if (!Number.isFinite(match.gameCreation) || Math.abs(match.gameCreation - gameStartedAt) > 60_000) return null;
  const identities = (match.participantIdentities || []).filter(({ player }) =>
    (player?.gameName && player?.tagLine && `${player.gameName}#${player.tagLine}` === playerId) || player?.summonerName === playerId);
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
  return Object.keys(totals).length ? totals : null;
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
  constructor({ directory, leaguePath, readGame = readLiveGame, readMatch, captureFactory = (options) => new DamageIpCapture(options) }) {
    this.directory = directory;
    this.leaguePath = leaguePath;
    this.readGame = readGame;
    this.readMatch = readMatch;
    this.capture = captureFactory({ leaguePath, onUpdate: (state) => { this.packet = state; } });
    this.packet = { state: 'off', detail: 'No recording started' };
    this.samples = 0;
    this.fightGap = 8;
  }
  snapshot(target = 'all', metric = 'reported') {
    const live = this.live?.snapshot(target, metric);
    const meter = live?.meter;
    if (meter) {
      if (this.error || this.packet.state === 'error') meter.incomplete = true;
      const latestFight = meter.fights.at(-1);
      if (latestFight && this.finalized) latestFight.active = false;
    }
    return { ...this.packet, busy: !!this.capture.busy, samples: this.samples,
      sessionDirectory: this.sessionDirectory || null, gameTime: this.gameTime ?? null,
      originalLogSaved: !!this.originalLogSaved, error: this.error || null,
      matchTotals: this.matchTotals || null,
      meter: meter || null, meterStatus: live?.detail || null, fightGap: this.fightGap };
  }
  setFightGap(seconds) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Fight pause must be 1–60 seconds.');
    this.fightGap = seconds;
    this.live?.tracker.setFightGap(seconds);
    return this.snapshot();
  }
  start() {
    if (this.capture.busy || this.pending) throw new Error('Wait for the previous recording to finish.');
    this.startedAt = Date.now();
    this.samples = 0; this.gameTime = null; this.originalLogSaved = false; this.error = null; this.logSource = null;
    clearTimeout(this.matchRetry);
    this.matchTotals = null;
    this.activePlayerId = null;
    this.sessionDirectory = path.join(this.directory, new Date(this.startedAt).toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(this.sessionDirectory, { recursive: true });
    this.file = path.join(this.sessionDirectory, 'observations.jsonl');
    this.live = new DamageLive(path.join(this.sessionDirectory, 'raw-ipv4.pcapng'), this.fightGap);
    this.finalized = false;
    fs.writeFileSync(this.file, JSON.stringify({ kind: 'start', at: new Date().toISOString(), schema: 1,
      purpose: 'Damage source validation; snapshots contain no damage measurements' }) + '\n', { flag: 'wx' });
    this.capture.start(this.file);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 1000);
    this.timer.unref?.();
    return this.snapshot();
  }
  async poll() {
    if (this.pending) return;
    this.pending = true;
    try {
      if (!this.capture.busy) {
        clearInterval(this.timer);
        this.finalize();
        return;
      }
      this.pollLive();
      const requestedAt = new Date().toISOString();
      const data = await this.readGame().catch(() => null);
      if (!data || !Number.isFinite(data.gameData?.gameTime)) return;
      this.gameTime = data.gameData.gameTime;
      this.activePlayerId ||= data.activePlayer?.riotId || data.activePlayer?.summonerName;
      // Allowlist avoids retaining unrelated client/account data.
      const players = (data.allPlayers || []).map((p) => ({ riotId: p.riotId, summonerName: p.summonerName,
        championName: p.championName, rawChampionName: p.rawChampionName, team: p.team, isDead: p.isDead, scores: p.scores }));
      if (this.samples >= 7200) { this.stop(); return; }
      const receivedAt = new Date().toISOString();
      this.live.sample(data, Date.parse(requestedAt), Date.parse(receivedAt));
      fs.appendFileSync(this.file, JSON.stringify({ kind: 'sample', requestedAt, at: receivedAt,
        gameTime: this.gameTime, data: { gameData: data.gameData, allPlayers: players,
          clockAnchor: { requestedAt, receivedAt, gameTime: this.gameTime },
          activePlayer: { riotId: data.activePlayer?.riotId, summonerName: data.activePlayer?.summonerName },
          events: data.events } }) + '\n');
      this.samples++;
      this.pollLive();
    } catch (error) { this.error = error.message; this.stop(); }
    finally { this.pending = false; }
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
    if (!this.logSource) this.findLog();
    if (!this.logSource) return;
    if (!this.live.wire) this.live.initialize(readGameLogHeader(this.logSource));
    this.live.poll(options);
  }
  finalize() {
    if (this.finalized || !this.sessionDirectory) return;
    this.finalized = true;
    try {
      if (!this.error) this.pollLive({ final: true });
      if (this.live.reader.remaining) this.live.clockLoss = true;
      this.live.wire?.finish();
    } catch (error) { this.error = error.message; }
    try {
      this.preserveLog();
      const gameStartedAt = Date.parse(this.packet.gameStartedAt);
      if (this.readMatch && this.originalLogSaved && this.activePlayerId && Number.isFinite(gameStartedAt) && !this.shuttingDown) {
        const log = readGameLogHeader(path.join(this.sessionDirectory, 'original-r3dlog.txt'));
        const gameId = log.match(/\bGameStartData::GameID=([1-9]\d*)[ \t]*\r?$/m)?.[1];
        if (gameId) void this.refreshMatchTotals({ recording: this.live, gameId, playerId: this.activePlayerId, gameStartedAt });
      }
    } catch (error) { this.error ||= error.message; }
    this.writeSummary();
  }
  writeSummary() {
    fs.writeFileSync(path.join(this.sessionDirectory, 'summary.json'), JSON.stringify(this.snapshot(), null, 2));
  }
  async refreshMatchTotals(context, attempt = 1) {
    const { recording, gameId, playerId, gameStartedAt } = context;
    if (recording !== this.live || this.shuttingDown) return;
    let totals;
    try { totals = getMatchTotals(await this.readMatch(gameId), gameId, playerId, gameStartedAt); } catch {}
    if (recording !== this.live || this.shuttingDown) return;
    if (totals) {
      this.matchTotals = totals;
      try { this.writeSummary(); } catch (error) { this.error ||= error.message; }
    } else if (attempt < 10) {
      this.matchRetry = setTimeout(() => void this.refreshMatchTotals(context, attempt + 1), 5000);
      this.matchRetry.unref?.();
    }
  }
  preserveLog() {
    if (!this.logSource) return;
    if (fs.statSync(this.logSource).size > 64 * 1024 * 1024) throw new Error('Original game log exceeded the retention limit.');
    fs.copyFileSync(this.logSource, path.join(this.sessionDirectory, 'original-r3dlog.txt'));
    this.originalLogSaved = true;
  }
  stop() { this.capture.stop(); return this.snapshot(); }
  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.matchRetry);
    this.stop();
    // Keep the heartbeat alive while the helper stops and converts its own capture.
    const deadline = Date.now() + 60000;
    while (this.capture.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    clearInterval(this.timer);
    if (!this.capture.busy) this.finalize();
  }
}
