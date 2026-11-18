// Live champion damage for every player, estimated from the playing
// client's own traffic while the exact spectator figures are still on their
// way. Two server messages make this possible:
//
// - A combat marker names a champion and the server time at which it dealt
//   or took damage, and says whether the other party was a champion. Both
//   sides of a hit get a marker with the same time, as soon as it lands.
// - Unit replication carries every visible champion's current health. The
//   server sends it in ticks about 100 ms apart, after the markers of the
//   hits it includes.
//
// A health drop in one tick is credited to the opposing champions that share
// one of the target's marker times since the previous tick. The amounts are
// health lost, so damage a shield absorbs is not counted, and simultaneous
// attackers share a drop. Overkill counts only where a kill notification
// reports the final hit. The spectator feed replaces these figures with
// exact ones as it catches up.
const TICK_GAP_MS = 20;
const FINAL_HIT_WINDOW_MS = 500;
const MAX_EVENTS = 200_000;
const MAX_GROUPS = 4096;
const MIN_DROP = 0.005;

export class TeamLiveEstimate {
  constructor({ owner = null } = {}) {
    this.owner = owner;
    this.teams = new Map();
    this.heroes = new Map();
    this.groups = new Map();
    this.groupOrder = [];
    this.tick = null;
    this.lastTime = null;
    this.events = [];
    this.lethal = new Map();
    this.finalHits = new Map();
    this.stats = { markers: 0, ticks: 0, single: 0, shared: 0, unexplained: 0, dropped: 0 };
  }
  // Champion object ID to team. Nothing is credited before both sides are known.
  setTeams(teams) { this.teams = new Map(teams); }
  setOwner(owner) { this.owner = owner; }
  hero(id) {
    let hero = this.heroes.get(id);
    if (!hero) this.heroes.set(id, hero = { health: null, frames: [], units: [], own: 0 });
    return hero;
  }
  opposed(first, second) {
    return this.teams.has(first) && this.teams.has(second) && this.teams.get(first) !== this.teams.get(second);
  }
  marker({ owner, time, champion }) {
    if (!Number.isFinite(time)) return;
    this.settle();
    this.stats.markers++;
    this.lastTime = time;
    const hero = this.hero(owner);
    if (!champion) { hero.units.push(time); return; }
    let group = this.groups.get(time);
    if (!group) {
      this.groups.set(time, group = new Set());
      this.groupOrder.push(time);
      // Marker times only matter until the health update that follows them.
      while (this.groupOrder.length > MAX_GROUPS) this.groups.delete(this.groupOrder.shift());
    }
    group.add(owner);
    hero.frames.push(time);
  }
  // Call once per replication packet, before its health records. Packets of
  // one tick share the server time. Without one, close arrivals are a tick.
  replication({ time = null, at }) {
    const same = this.tick && (time !== null && this.tick.time !== null ? time === this.tick.time
      : Number.isFinite(at) && at - this.tick.at <= TICK_GAP_MS);
    if (same) return;
    this.settle();
    this.tick = { time, at, updates: [] };
    this.stats.ticks++;
  }
  health({ id, health }) {
    if (!(health >= 0) || !this.tick || !this.teams.has(id)) return;
    this.tick.updates.push({ id, health });
  }
  // The local player's own hits are exact and arrive on their own stream,
  // ahead of the health update that includes them.
  ownHit({ sourceId, targetId, amount, time }) {
    if (!(amount > 0)) return;
    this.settle();
    if (sourceId === this.owner) this.hero(targetId).own += amount;
    // Without a clock reading, the hit's own marker has just set the time.
    const at = Number.isFinite(time) ? time : this.lastTime;
    if (Number.isFinite(at) && this.opposed(sourceId, targetId)) this.add({ time: at, sourceId, targetId, amount, exact: true });
  }
  // A kill notification reports the killer's last hit in full, overkill included.
  finalHit({ sourceId, targetId, amount, at }) {
    if (!(amount > 0) || sourceId === this.owner || targetId === this.owner) return;
    this.settle();
    const lethal = this.lethal.get(targetId);
    if (lethal && Math.abs(at - lethal.at) <= FINAL_HIT_WINDOW_MS) {
      this.lethal.delete(targetId);
      this.applyFinalHit(lethal, sourceId, targetId, amount);
    } else this.finalHits.set(targetId, { sourceId, amount, at });
  }
  applyFinalHit(lethal, sourceId, targetId, amount) {
    const mine = lethal.events.filter((event) => event.sourceId === sourceId);
    if (!mine.length) {
      if (this.opposed(sourceId, targetId)) this.add({ time: lethal.time, sourceId, targetId, amount, exact: false });
      return;
    }
    // Earlier hits in the same tick keep their share. The last one is replaced.
    const estimated = mine.reduce((total, event) => total + event.amount, 0);
    if (amount > estimated) mine.at(-1).amount += amount - estimated;
  }
  add(event) {
    if (this.events.length >= MAX_EVENTS) { this.stats.dropped++; return null; }
    this.events.push(event);
    return event;
  }
  // Closes the open tick: everything received before it explains its drops.
  settle() {
    const tick = this.tick;
    if (!tick) return;
    this.tick = null;
    const drops = [];
    for (const update of tick.updates) {
      const hero = this.hero(update.id);
      const before = hero.health;
      hero.health = update.health;
      if (before === null || !(before - update.health > MIN_DROP)) continue;
      drops.push({ id: update.id, amount: before - update.health, lethal: update.health === 0, at: tick.at,
        frames: [...new Set(hero.frames)], units: new Set(hero.units), own: hero.own });
    }
    // A champion that lost health in a frame is explained as a target there.
    const hurt = new Map();
    for (const drop of drops) for (const time of drop.frames) {
      if (!hurt.has(time)) hurt.set(time, new Set());
      hurt.get(time).add(drop.id);
    }
    for (const drop of drops) this.resolve(drop, hurt);
    // Frames left over belong to champions that only dealt damage this tick.
    for (const hero of this.heroes.values()) {
      hero.frames = [];
      hero.units = [];
      hero.own = 0;
    }
  }
  resolve(drop, hurt) {
    const team = this.teams.get(drop.id);
    if (team === undefined || drop.id === this.owner || !drop.frames.length) return;
    // The local player's part is already counted exactly.
    const amount = drop.amount - drop.own;
    const time = drop.frames.at(-1);
    const candidates = new Map();
    for (const frame of drop.frames) {
      const opponents = [...(this.groups.get(frame) || [])].filter((id) => id !== this.owner && this.opposed(id, drop.id));
      const attackers = opponents.filter((id) => !hurt.get(frame)?.has(id));
      // Every opponent here lost health too. A minion or turret hit on the
      // target in the same frame explains the drop better than a trade.
      if (!attackers.length && drop.units.has(frame)) continue;
      for (const id of attackers.length ? attackers : opponents) candidates.set(id, (candidates.get(id) || 0) + 1);
    }
    const events = [];
    if (amount > MIN_DROP && candidates.size === 1) {
      const [sourceId] = candidates.keys();
      this.stats.single++;
      events.push(this.add({ time, sourceId, targetId: drop.id, amount, exact: false }));
    } else if (amount > MIN_DROP && candidates.size) {
      this.stats.shared++;
      for (const [sourceId, share] of this.split(amount, candidates)) {
        if (share > 0) events.push(this.add({ time, sourceId, targetId: drop.id, amount: share, exact: false, shared: true }));
      }
    } else if (amount > MIN_DROP) this.stats.unexplained++;
    if (!drop.lethal) return;
    const lethal = { at: drop.at, time, events: events.filter(Boolean) };
    const final = this.finalHits.get(drop.id);
    this.finalHits.delete(drop.id);
    if (final && Math.abs(drop.at - final.at) <= FINAL_HIT_WINDOW_MS) this.applyFinalHit(lethal, final.sourceId, drop.id, final.amount);
    else this.lethal.set(drop.id, lethal);
  }
  // Several opposing champions were in combat in the frames behind one drop.
  // Each gets a share for every frame it appears in.
  split(amount, candidates) {
    let total = 0;
    for (const frames of candidates.values()) total += frames;
    return new Map([...candidates].map(([id, frames]) => [id, amount * frames / total]));
  }
  // Damage to opposing champions per source after a game time, and how much
  // of it comes from the local player's exact hit stream.
  since(gameTime = -Infinity, until = Infinity) {
    const totals = new Map();
    const row = (id) => {
      let entry = totals.get(id);
      if (!entry) totals.set(id, entry = { champion: 0, exact: 0, taken: 0 });
      return entry;
    };
    for (const event of this.events) {
      if (!(event.time > gameTime) || event.time > until) continue;
      const source = row(event.sourceId);
      source.champion += event.amount;
      if (event.exact) source.exact += event.amount;
      row(event.targetId).taken += event.amount;
    }
    return totals;
  }
}
