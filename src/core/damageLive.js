import { DamageIpReader } from './damageIpCapture.js';
import { DamageWire, readDamageSession } from './damageWire.js';
import { damagePacketOwner } from './livePacketReader.js';
import { protocol16_22 } from './liveProtocol.js';
import { DamageTracker, DEFAULT_FIGHT_GAP } from './damageTracker.js';
import { DamageSourceNames, labelSources } from './damageSources.js';
import { TeamLiveEstimate } from './damageTeamLive.js';
import { readHealthUpdates } from './liveReplication.js';

const RECAP_PAIR_WINDOW_MS = 2;
const sourceKey = (event) =>
  [event.candidateHash, event.candidateScriptHash, event.candidateMissileHash].map((hash) => (hash >>> 0).toString(16)).join(':');

export class DamageLive {
  constructor(file, fightGap = DEFAULT_FIGHT_GAP, { readSpellNames } = {}) {
    this.reader = new DamageIpReader(file);
    this.protocol = protocol16_22;
    this.tracker = new DamageTracker({ fightGap });
    this.sourceNames = new DamageSourceNames();
    this.readSpellNames = readSpellNames;
    this.pending = [];
    this.anchors = [];
    this.heroModels = new Map();
    this.takedowns = new Map();
    this.inferredHeroes = new Map();
    this.heroes = this.heroModels;
    this.rosterOrder = null;
    this.rosterModels = new Set();
    this.rosterNames = new Map();
    this.rosterTeams = new Map();
    this.teamLive = new TeamLiveEstimate();
    this.teamLiveLoss = 0;
    this.heroSpawnLoss = false;
    this.owner = null;
    this.ownerVerified = false;
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
    const protocol = this.protocol = session.protocol;
    this.wire = new DamageWire({ ...session,
      onTakedown: (event) => this.addTakedown(event),
      onSupport: (event) => this.teamLive[event.support](event),
      onPacket: ({ type, fields, direction, time }) => {
        if (direction === 'in' && (type === protocol.marker || type === protocol.replication)) {
          this.readTeamLive(type, fields, time);
          return;
        }
        if (direction === 'in' && (type === protocol.recapOwner || type === protocol.recap)) {
          this.readDeathRecap(type, fields, time);
          return;
        }
        if (type === protocol.heroSpawn && direction === 'in') {
          let hero;
          try { hero = protocol.fields.decodeDamageHeroSpawn(fields); }
          catch { this.heroSpawnLoss = true; return; }
          if (!hero) return;
          const model = hero.model.toLowerCase();
          const existing = this.heroModels.get(hero.id);
          this.heroModels.set(hero.id, existing === undefined || existing === model ? model : null);
          this.verifyOwner();
          this.refreshHeroes();
          return;
        }
        if (type === protocol.ownerAction && direction === 'out' && !this.ownerVerified) {
          this.observeActionOwner(damagePacketOwner(fields));
        }
      },
      onDamage: (event) => {
        const incoming = event.statDirection === 'incoming';
        if (incoming && this.owner && !this.ownerConflict && event.candidateTargetNetId !== this.owner) return;
        if (this.owner && (incoming ? event.candidateTargetNetId : event.candidateSourceNetId) === this.owner) {
          // In stream order, so the estimate can take these out of the health drop that follows.
          this.teamLive.ownHit({ sourceId: event.candidateSourceNetId, targetId: event.candidateTargetNetId,
            amount: event.candidateAmount, time: this.gameTimeAt(event.time, 5000) });
        }
        if (this.pending.length >= 200000) { this.clockLoss = true; return; }
        this.pending.push(event);
      }
    });
  }
  observeActionOwner(id) {
    if (!id || this.owner === id || this.ownerVerified) return;
    if (this.owner) {
      this.ownerConflict = true;
      return;
    }
    // Late starts can use the outgoing action until the champion is verified.
    this.owner = id;
    this.teamLive.setOwner(id);
    this.inferHeroes();
  }
  verifyOwner() {
    if (this.ownerVerified || !this.rosterOrder) return;
    const model = this.rosterOrder.models[this.rosterOrder.me];
    const matches = [...this.heroModels].filter(([, spawned]) => spawned === model);
    if (matches.length !== 1) return;
    const [[id]] = matches;
    if (this.owner && this.owner !== id) {
      // Older hits were filtered with a provisional ID. Keep the coverage
      // warning and discard any totals, recaps or estimates credited to it.
      this.clockLoss = true;
      this.tracker.reset({ gameId: this.tracker.gameId, startedAt: this.tracker.startedAt });
      this.beforeRecording = null;
      this.deathRecap = null;
      this.recapCandidate = null;
      this.recapOwnerUpdateAt = undefined;
      this.teamLive = new TeamLiveEstimate();
    }
    this.owner = id;
    this.ownerVerified = true;
    this.ownerConflict = false;
    this.teamLive.setOwner(id);
    this.inferHeroes();
  }
  // Markers and health updates feed the live estimate for all ten players.
  readTeamLive(type, fields, time) {
    const { fields: decoder, marker } = this.protocol;
    try {
      if (type === marker) {
        const event = decoder.decodeCombatMarker(fields);
        if (event) this.teamLive.marker(event);
        return;
      }
      const { time: tick, vector } = decoder.decodeReplication(fields);
      this.teamLive.replication({ time: tick, at: time });
      for (const update of readHealthUpdates(vector, (id) => this.teamLive.teams.has(id))) this.teamLive.health(update);
    } catch { this.teamLiveLoss++; }
  }
  // Champion object IDs to teams, from the roster or from spectator stat blocks.
  setTeamIds(teams) {
    this.teamIds = teams;
    this.refreshTeams();
  }
  refreshTeams() {
    if (this.teamIds) { this.teamLive.setTeams(this.teamIds); return; }
    // A champion keeps its team. Keep what the roster showed while a
    // possession makes two players read as one champion.
    this.rosterTeamIds ??= new Map();
    for (const [id, model] of this.heroes) {
      const team = this.rosterTeams.get(model);
      if (team) this.rosterTeamIds.set(id, team);
    }
    for (const id of this.rosterTeamIds.keys()) if (!this.heroes.has(id)) this.rosterTeamIds.delete(id);
    this.teamLive.setTeams(this.rosterTeamIds);
  }
  // Keep the victim ID too. The roster may arrive after the packet, and
  // only opposing champion pairs belong in the team comparison.
  addTakedown({ takedown, sourceId, targetId, amount, schools, time }) {
    if (takedown === 'finalHit') this.teamLive.finalHit({ sourceId, targetId, amount, at: time });
    else this.teamLive.assist({ sourceId, targetId, amount });
    const key = sourceId + '/' + targetId;
    const row = this.takedowns.get(key) ?? { sourceId, targetId, finalHits: 0, physical: 0, magic: 0, true: 0 };
    if (takedown === 'finalHit') row.finalHits += amount;
    else for (const type of ['physical', 'magic', 'true']) row[type] += schools[type];
    this.takedowns.set(key, row);
  }
  readDeathRecap(type, fields, time) {
    // A recap and its local hero update can arrive in separate datagrams
    // within the same receive burst.
    if (type === this.protocol.recapOwner) {
      if (!this.owner || damagePacketOwner(fields) !== this.owner) return;
      this.recapOwnerUpdateAt = time;
    } else {
      let recap = { duration: null };
      try { recap = this.protocol.fields.decodeDeathRecap(fields); } catch { /* Recap unavailable for this death. */ }
      this.recapCandidate = { time, ...recap };
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
    this.readRosterOrder(data);
    const rosterTeams = new Map();
    for (const player of data.allPlayers || []) {
      const model = /^game_character_displayname_([a-z0-9]+)$/i.exec(player.rawChampionName)?.[1] || player.championName;
      if (/^[a-z][a-z0-9]*$/i.test(model || '')) {
        const team = player.team === 'ORDER' ? 100 : player.team === 'CHAOS' ? 200 : null;
        // A champion picked on both sides cannot be placed by its model.
        rosterTeams.set(model.toLowerCase(), rosterTeams.has(model.toLowerCase()) && rosterTeams.get(model.toLowerCase()) !== team ? null : team);
        this.rosterModels.add(model.toLowerCase());
        if (typeof player.championName === 'string' && player.championName) {
          this.rosterNames.set(model.toLowerCase(), player.championName.slice(0, 40));
        }
      }
      if ((active?.riotId && player.riotId === active.riotId) ||
          (active?.summonerName && player.summonerName === active.summonerName)) {
        if (this.playerDead && player.isDead === false) this.respawnedAt = requestedAt;
        if (typeof player.isDead === 'boolean') this.playerDead = player.isDead;
      }
    }
    if (data.gameData.gameTime >= 1 && rosterTeams.size) {
      this.rosterTeams = rosterTeams;
      this.refreshTeams();
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
      if (fromServer) this.lastServerPacketAt = time;
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
    this.inferHeroes();
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
  // League lists the local player first at game time 0. From then on the
  // roster order matches the hero object IDs, which are consecutive.
  readRosterOrder(data) {
    const players = data.allPlayers || [];
    if (!(data.gameData?.gameTime >= 1) || !players.length || players.length > 20) return;
    const active = data.activePlayer;
    const me = players.findIndex((player) => (active?.riotId && player.riotId === active.riotId) ||
      (active?.summonerName && player.summonerName === active.summonerName));
    const models = players.map((player) =>
      /^game_character_displayname_([a-z0-9]+)$/i.exec(player.rawChampionName || '')?.[1]?.toLowerCase() || null);
    const named = models.filter(Boolean);
    // Viego's possession briefly repeats another champion's name.
    if (me < 0 || !models[me] || new Set(named).size !== named.length) return;
    this.rosterOrder = { models, me };
    this.verifyOwner();
    this.inferHeroes();
  }
  // Identifies champions without the opening spawn messages, so a recording
  // started mid-game can still split champion damage and name attackers.
  inferHeroes() {
    if (!this.owner || !this.rosterOrder) return;
    const base = this.owner - this.rosterOrder.me;
    if (base < 0x40000001) return;
    const inferred = new Map();
    this.rosterOrder.models.forEach((model, index) => { if (model) inferred.set(base + index, model); });
    if ([...inferred].every(([id, model]) => this.inferredHeroes.get(id) === model) && inferred.size === this.inferredHeroes.size) return;
    this.inferredHeroes = inferred;
    this.refreshHeroes();
  }
  // Spawn messages win. The roster fills gaps only when it agrees with them.
  refreshHeroes() {
    const agrees = [...this.heroModels].every(([id, model]) => !this.inferredHeroes.has(id) || this.inferredHeroes.get(id) === model);
    this.heroes = agrees && this.inferredHeroes.size ? new Map([...this.inferredHeroes, ...this.heroModels]) : this.heroModels;
    this.refreshTeams();
  }
  get heroesInferred() {
    return this.heroes !== this.heroModels && [...this.inferredHeroes.keys()].some((id) => !this.heroModels.has(id));
  }
  // Every champion object is known, so other targets are not champions.
  get heroesKnown() {
    const champions = [...this.heroes.values()].filter((model) => this.rosterModels.has(model)).length;
    const roster = this.rosterOrder?.models.filter(Boolean).length;
    return roster ? champions >= roster : champions > 0 && !this.heroSpawnLoss;
  }
  // Champions are named from hero spawns or the Live Client roster. Practice
  // dummies get their own row and every other attacker or target shares one.
  nameParties(parties, unknownName) {
    const named = [];
    const grouped = new Map();
    for (const party of parties) {
      const model = party.kind === 'champion' ? this.heroes.get(Number(party.id)) : null;
      if (model) {
        named.push({ ...party, name: this.rosterNames.get(model) || model });
        continue;
      }
      const kind = party.kind === 'dummy' ? 'dummy' : 'other';
      let row = grouped.get(kind);
      if (!row) {
        row = { id: kind, kind, amount: 0, hits: 0, types: Object.fromEntries(Object.keys(party.types).map((type) => [type, 0])),
          name: kind === 'dummy' ? 'Practice dummies' : this.heroesKnown ? 'Minions, turrets & monsters' : unknownName };
        grouped.set(kind, row);
      }
      row.amount += party.amount;
      row.hits += party.hits;
      for (const [type, value] of Object.entries(party.types)) row.types[type] += value;
    }
    return [...named, ...grouped.values()];
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
  snapshot(target = 'all') {
    if (this.ownerConflict) return { detail: 'Multiple local player IDs were observed. Damage totals are unavailable.' };
    if (!this.wire?.stats.checked) return { detail: 'Waiting for verified game packets.' };
    if (!this.owner || this.lastGameTime === null || this.tracker.gameId === null) return { detail: 'Waiting for the player ID. Move or attack in game.' };
    const now = Math.max(this.lastGameTime, this.tracker.lastTime);
    const targetKinds = new Map();
    for (const [id, model] of this.heroes) {
      if (model === 'practicetool_targetdummy') targetKinds.set(id, 'dummy');
      else if (this.rosterModels.has(model)) targetKinds.set(id, 'champion');
    }
    const previousDeath = this.playerDead && this.deathRecap?.time < this.respawnedAt;
    const deathRecap = !previousDeath && this.deathRecap?.duration != null ? this.deathRecap : undefined;
    const meter = this.tracker.snapshot({ sourceId: String(this.owner), now, target, targetKinds, deathRecap,
      nextFightAfter: this.playerDead ? Infinity : this.respawnedAt, estimateRecap: true,
      fightTarget: 'champion' });
    const targetCoverageIncomplete = !this.heroesKnown && (meter.unclassifiedHits > 0 || this.heroSpawnLoss);
    const incoming = { ...meter.incoming, attackers: this.nameParties(meter.incoming.attackers, 'Unidentified attackers') };
    const dealt = { ...meter.dealt, targets: this.nameParties(meter.dealt.targets, 'Unidentified targets') };
    delete meter.incoming;
    delete meter.dealt;
    const before = this.beforeRecording?.[target];
    if (!before && target === 'champion' && !meter.total.hits && !meter.deathRecap && !meter.fights.length) {
      if (!meter.observedHits) return { detail: 'Waiting for decoded damage before showing champion totals.', incoming, dealt };
      if (targetCoverageIncomplete) return { detail: 'Champion damage is unavailable because hit targets are unidentified. Select All targets to see captured damage.', incoming, dealt };
    }
    const fights = meter.fights.slice(-10);
    for (const summary of [meter.total, meter.deathRecap, ...fights]) {
      if (summary) summary.sources = labelSources(summary.sources, this.sourceNames);
    }
    if (before) {
      const total = meter.total;
      total.beforeRecording = before.total;
      total.total += before.total;
      for (const school of ['physical', 'magic', 'true']) total.types[school] += before[school];
      total.duration = now;
      total.dps = total.total / now;
    }
    return { incoming, dealt, meter: { ...meter, fights, targetScope: target === 'champion' ? 'Champions' : 'All observed targets',
      // Rejected datagrams were connection handshakes and the final goodbye in
      // every recording. A lost game datagram shows up as a missing sequence.
      gaps: (target === 'champion' && targetCoverageIncomplete) || this.clockLoss ||
        this.wire.stats.missing > 0 || this.wire.stats.fragmentLoss > 0,
      heroesInferred: this.heroesInferred, missed: this.wire.stats.missing } };
  }
}
