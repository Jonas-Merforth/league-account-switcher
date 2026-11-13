import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { DamageIpCapture } from './damageIpCapture.js';
import { DamageLive } from './damageLive.js';

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
  constructor({ directory, leaguePath, readGame = readLiveGame, captureFactory = (options) => new DamageIpCapture(options) }) {
    this.directory = directory;
    this.leaguePath = leaguePath;
    this.readGame = readGame;
    this.capture = captureFactory({ leaguePath, onUpdate: (state) => { this.packet = state; } });
    this.packet = { state: 'off', detail: 'No recording started' };
    this.samples = 0;
    this.fightGap = 8;
  }
  snapshot(target = 'all') {
    const live = this.live?.snapshot(target);
    const meter = live?.meter;
    if (meter && (this.error || this.packet.state === 'error')) meter.incomplete = true;
    return { ...this.packet, busy: !!this.capture.busy, samples: this.samples,
      sessionDirectory: this.sessionDirectory || null, gameTime: this.gameTime ?? null,
      originalLogSaved: !!this.originalLogSaved, error: this.error || null,
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
    if (!this.live.wire) {
      const descriptor = fs.openSync(this.logSource, 'r');
      try {
        const buffer = Buffer.alloc(65536);
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        this.live.initialize(buffer.subarray(0, count).toString('utf8'));
      } finally { fs.closeSync(descriptor); }
    }
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
    try { this.preserveLog(); } catch (error) { this.error ||= error.message; }
    fs.writeFileSync(path.join(this.sessionDirectory, 'summary.json'), JSON.stringify(this.snapshot(), null, 2));
  }
  preserveLog() {
    if (!this.logSource) return;
    if (fs.statSync(this.logSource).size > 64 * 1024 * 1024) throw new Error('Original game log exceeded the retention limit.');
    fs.copyFileSync(this.logSource, path.join(this.sessionDirectory, 'original-r3dlog.txt'));
    this.originalLogSaved = true;
  }
  stop() { this.capture.stop(); return this.snapshot(); }
  async shutdown() {
    this.stop();
    // Keep the heartbeat alive while the helper stops and converts its own capture.
    const deadline = Date.now() + 60000;
    while (this.capture.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    clearInterval(this.timer);
    if (!this.capture.busy) this.finalize();
  }
}
