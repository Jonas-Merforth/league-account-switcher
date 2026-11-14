import { DamageIpReader } from './damageIpCapture.js';
import { DamageWire, readDamageSession } from './damageWire.js';
import { damagePacketOwner, decodeDamageDisplay, decodeDamageHealthUpdates, decodeDamageHeroSpawn,
  decodeDeathRecapDuration } from './damagePacketFields16_22.js';
import { DamageTracker, DEFAULT_FIGHT_GAP } from './damageTracker.js';
import { DamageHealthLoss } from './damageHealthLoss.js';
import { DamageSourceNames, labelSources } from './damageSources.js';

const RECAP_PAIR_WINDOW_MS = 2;
const sourceKey = (event) =>
  [event.candidateHash, event.candidateScriptHash, event.candidateMissileHash].map((hash) => (hash >>> 0).toString(16)).join(':');

export class DamageLive {
  constructor(file, fightGap = DEFAULT_FIGHT_GAP, { readSpellNames } = {}) {
    this.reader = new DamageIpReader(file);
    this.tracker = new DamageTracker({ fightGap });
    this.sourceNames = new DamageSourceNames();
    this.readSpellNames = readSpellNames;
    this.pending = [];
    this.anchors = [];
    this.heroModels = new Map();
    this.rosterModels = new Set();
    this.healthLoss = new DamageHealthLoss();
    this.heroSpawnLoss = false;
    this.owner = null;
    this.ownerConflict = false;
    this.clockLoss = false;
    this.lastGameTime = null;
    this.maxReadPasses = 8;
  }
  initialize(log) {
    if (this.wire) return;
    const session = readDamageSession(log);
    if (!session) return;
    this.server = session.server;
    this.serverPort = session.port;
    this.wire = new DamageWire({ ...session,
      onPacket: ({ type, fields, direction, time }) => {
        if (direction === 'in' && (type === 419 || type === 1074)) {
          this.readDeathRecap(type, fields, time);
          return;
        }
        if (type === 952 && direction === 'in') {
          try {
            for (const { id, health } of decodeDamageHealthUpdates(fields, this.heroModels)) this.healthLoss.update(id, time, health);
          } catch { this.healthLoss.invalidate(); }
          return;
        }
        if (type === 393 && direction === 'in') {
          try {
            const { targetId, amount } = decodeDamageDisplay(fields);
            this.healthLoss.noteHit(targetId, time, amount);
          } catch { this.healthLoss.invalidate(); }
          return;
        }
        if (type === 43 && direction === 'in') {
          let hero;
          try { hero = decodeDamageHeroSpawn(fields); }
          catch { this.heroSpawnLoss = true; return; }
          if (!hero) return;
          const model = hero.model.toLowerCase();
          const existing = this.heroModels.get(hero.id);
          this.heroModels.set(hero.id, existing === undefined || existing === model ? model : null);
          return;
        }
        // Verified against the local action sender for 16.22. Only the
        // outgoing common object ID is considered as a local-player candidate.
        if (type !== 618 || direction !== 'out') return;
        const owner = damagePacketOwner(fields);
        if (!owner) return;
        if (this.owner && this.owner !== owner) this.ownerConflict = true;
        this.owner = owner;
      },
      onDamage: (event) => {
        const incoming = event.statDirection === 'incoming';
        if (incoming && this.owner && event.candidateTargetNetId !== this.owner) return;
        if (this.pending.length >= 200000) { this.clockLoss = true; return; }
        if (!incoming && event.candidateSourceNetId === this.owner) {
          this.healthLoss.noteHit(event.candidateTargetNetId, event.time, event.candidateAmount, event.id);
        }
        this.pending.push(event);
      }
    });
  }
  readDeathRecap(type, fields, time) {
    // A recap and its local hero update can arrive in separate datagrams
    // within the same receive burst.
    if (type === 419) {
      if (!this.owner || damagePacketOwner(fields) !== this.owner) return;
      this.recapOwnerUpdateAt = time;
    } else {
      let duration = null;
      try { duration = decodeDeathRecapDuration(fields); } catch { /* Recap unavailable for this death. */ }
      this.recapCandidate = { time, duration };
    }
    if (this.recapCandidate && Math.abs(this.recapCandidate.time - this.recapOwnerUpdateAt) <= RECAP_PAIR_WINDOW_MS &&
        this.recapCandidate.time >= (this.deathRecap?.time ?? -Infinity)) {
      this.deathRecap = this.recapCandidate;
    }
  }
  sample(data, requestedAt, receivedAt) {
    const game = data.gameData;
    if (!Number.isFinite(game?.gameTime)) return;
    this.lastGameTime = Math.max(this.lastGameTime ?? 0, game.gameTime);
    this.anchors.push({ time: (requestedAt + receivedAt) / 2, gameTime: game.gameTime });
    if (this.anchors.length > 120) this.anchors.shift();
    this.sourceNames.updateLive(data);
    const champion = this.sourceNames.model;
    if (champion && this.readSpellNames && this.spellNamesFor !== champion) {
      this.spellNamesFor = champion;
      // Names only improve labels. Damage totals do not depend on them.
      Promise.resolve().then(() => this.readSpellNames(champion))
        .then((names) => { if (this.spellNamesFor === champion) this.sourceNames.addChampionNames(names); })
        .catch(() => {});
    }
    const active = data.activePlayer;
    for (const player of data.allPlayers || []) {
      const model = /^game_character_displayname_([a-z0-9]+)$/i.exec(player.rawChampionName)?.[1] || player.championName;
      if (/^[a-z][a-z0-9]*$/i.test(model || '')) this.rosterModels.add(model.toLowerCase());
      if ((active?.riotId && player.riotId === active.riotId) ||
          (active?.summonerName && player.summonerName === active.summonerName)) {
        if (this.playerDead && player.isDead === false) this.respawnedAt = requestedAt;
        if (typeof player.isDead === 'boolean') this.playerDead = player.isDead;
      }
    }
  }
  poll({ final = false } = {}) {
    if (!this.wire) return;
    const handle = (packet, time) => {
      const ipLength = (packet[0] & 15) * 4;
      if (ipLength < 20 || ipLength + 8 > packet.length || packet[0] >>> 4 !== 4 || packet[9] !== 17 ||
          packet.readUInt16BE(2) !== packet.length || packet.readUInt16BE(6) & 0x3fff ||
          packet.readUInt16BE(ipLength + 4) !== packet.length - ipLength) return;
      const fromServer = packet.subarray(12, 16).equals(this.server) && packet.readUInt16BE(ipLength) === this.serverPort;
      const toServer = packet.subarray(16, 20).equals(this.server) && packet.readUInt16BE(ipLength + 2) === this.serverPort;
      if (fromServer === toServer) return;
      const port = packet.readUInt16BE(ipLength + (fromServer ? 2 : 0));
      this.firstPacketAt ??= time;
      this.wire.push(packet.subarray(ipLength + 8), fromServer ? 'in' : 'out', port, time);
    };
    for (let pass = 0; pass < (final ? this.maxReadPasses : 1); pass++) {
      const offset = this.reader.offset;
      this.reader.read(handle);
      if (!this.reader.remaining || offset === this.reader.offset) break;
    }
    if (!this.owner || this.ownerConflict || !this.anchors.length) return;
    if (this.tracker.gameId === null && this.firstPacketAt != null) {
      const startedAt = Math.max(0, this.gameTimeAt(this.firstPacketAt, Infinity) ?? 0);
      this.tracker.reset({ gameId: 'live', startedAt });
    }
    const deferred = [];
    for (const event of this.pending) {
      const incoming = event.statDirection === 'incoming';
      const localId = incoming ? event.candidateTargetNetId : event.candidateSourceNetId;
      if (localId !== this.owner) continue;
      if (!final && event.time > this.anchors.at(-1).time) { deferred.push(event); continue; }
      const time = this.gameTimeAt(event.time, 5000);
      if (time === null || time < 0) { this.clockLoss = true; continue; }
      try {
        this.tracker.add({ id: event.id, time: Math.max(this.tracker.lastTime, time), amount: event.candidateAmount,
          packetTime: event.time, incoming, sourceId: String(event.candidateSourceNetId), schools: event.schools,
          targetKind: 'unclassified', targetId: event.candidateTargetNetId,
          ability: incoming ? null : sourceKey(event) });
      } catch { this.clockLoss = true; }
    }
    this.pending = deferred;
  }
  gameTimeAt(time, limit) {
    let nearest = null;
    let distance = limit;
    for (const anchor of this.anchors) {
      if (Math.abs(anchor.time - time) >= distance) continue;
      nearest = anchor;
      distance = Math.abs(anchor.time - time);
    }
    return nearest ? nearest.gameTime + (time - nearest.time) / 1000 : null;
  }
  snapshot(target = 'all', metric = 'reported') {
    if (this.ownerConflict) return { detail: 'Multiple local player IDs were observed. Damage totals are unavailable.' };
    if (!this.wire?.stats.checked) return { detail: 'Waiting for verified game packets.' };
    if (!this.owner || this.lastGameTime === null || this.tracker.gameId === null) return { detail: 'Waiting for the player ID. Move or attack in game.' };
    const now = Math.max(this.lastGameTime, this.tracker.lastTime);
    const targetKinds = new Map();
    for (const [id, model] of this.heroModels) {
      if (model === 'practicetool_targetdummy') targetKinds.set(id, 'dummy');
      else if (this.rosterModels.has(model)) targetKinds.set(id, 'champion');
    }
    const previousDeath = this.playerDead && this.deathRecap?.time < this.respawnedAt;
    const deathRecap = !previousDeath && this.deathRecap?.duration != null ? this.deathRecap : undefined;
    const meter = this.tracker.snapshot({ sourceId: String(this.owner), now, target, targetKinds, deathRecap,
      nextFightAfter: this.playerDead ? Infinity : this.respawnedAt, estimateRecap: true,
      fightTarget: 'champion', healthLoss: metric === 'hp' ? this.healthLoss.matches : undefined });
    const targetCoverageIncomplete = meter.unclassifiedHits > 0 || this.heroSpawnLoss;
    if (target === 'champion' && !meter.total.hits && !meter.deathRecap && !meter.fights.length) {
      if (!meter.observedHits) return { detail: 'Waiting for decoded damage before showing champion totals.' };
      if (targetCoverageIncomplete) return { detail: 'Champion damage is unavailable because hit targets are unidentified. Select All targets to see captured damage.' };
    }
    const fights = meter.fights.slice(-10);
    for (const summary of [meter.total, meter.deathRecap, ...fights]) {
      if (summary) summary.sources = labelSources(summary.sources, this.sourceNames);
    }
    return { meter: { ...meter, fights, targetScope: target === 'champion' ? 'Champions' : 'All observed targets',
      incomplete: meter.partial || (target === 'champion' && targetCoverageIncomplete) || this.clockLoss ||
        this.wire.stats.missing > 0 || this.wire.stats.fragmentLoss > 0 || this.wire.stats.rejected > 0,
      missed: this.wire.stats.missing } };
  }
}
