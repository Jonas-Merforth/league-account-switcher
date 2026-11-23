// Live champion damage for every player, estimated from the playing
// client's own traffic while the exact spectator figures are still on their
// way. These server messages make it possible:
//
// - A combat marker names a champion and the server time at which it dealt
//   or took damage, and says whether the other party was a champion. Both
//   sides of a hit get a marker with the same time, as soon as it lands.
// - Unit replication carries every visible champion's current health. The
//   server sends it in ticks about 100 ms apart, after the markers of the
//   hits it includes.
// - A heal event gives the health restored to a champion, so a health
//   change can be turned back into the damage behind it.
// - When a champion dies, the server reports the killer's final hit and
//   each assister's damage to the victim over the last 20 seconds.
//
// Health lost in one tick is credited to the opposing champions that share
// one of the target's marker times since the previous tick. Simultaneous
// attackers share it. A death then replaces the assisters' estimates for
// that fight with the reported figures. The spectator feed replaces all of
// it with exact totals as it catches up.
//
// Shields are left out on purpose. League's own damage figures do not
// count what a shield takes, and a shield also shrinks as it runs out.
const TICK_GAP_MS = 20;
const ASSIST_WINDOW_SECONDS = 20;
// A death's records precede the tick that shows the victim at zero health.
const DEATH_SETTLE_TICKS = 4;
// The Live Client clock reads an own hit about 19 ms after its server time,
// and within 20 ms of that for nearly all of them.
const OWN_CLOCK_LAG = 0.019;
const OWN_CLOCK_SLACK = 0.02;
const MAX_EVENTS = 400_000;
const MAX_GROUPS = 4096;
const RECENT_LIMIT = 512;
const MIN_DAMAGE = 0.005;

export class TeamLiveEstimate {
  constructor({ owner = null } = {}) {
    this.owner = owner;
    this.teams = new Map();
    this.heroes = new Map();
    this.groups = new Map();
    this.groupOrder = [];
    this.tick = null;
    this.lastTime = null;
    this.ownMarker = null;
    this.ownWaiting = [];
    this.events = [];
    this.deaths = new Map();
    this.stats = { markers: 0, ticks: 0, single: 0, shared: 0, unexplained: 0, reconciled: 0, dropped: 0 };
  }
  // Champion object ID to team. Nothing is credited before both sides are known.
  setTeams(teams) { this.teams = new Map(teams); }
  setOwner(owner) { this.owner = owner; }
  hero(id) {
    let hero = this.heroes.get(id);
    if (!hero) this.heroes.set(id, hero = { health: null, frames: [], units: [], own: 0, ownLast: 0, healed: 0, recent: [], lethal: null });
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
    if (owner === this.owner) this.timeOwnHits(time);
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
    this.tick = { time, at, updates: new Map() };
    this.stats.ticks++;
  }
  health({ id, health }) {
    if (!(health >= 0) || !this.tick || !this.teams.has(id)) return;
    this.tick.updates.set(id, health);
  }
  // Health restored before the next tick hides that much damage in it.
  heal({ targetId, amount }) {
    if (!(amount > 0) || !this.teams.has(targetId)) return;
    this.settle();
    this.hero(targetId).healed += amount;
  }
  // The local player's own hits are exact and arrive on their own stream,
  // ahead of the health update that includes them.
  ownHit({ sourceId, targetId, amount, time }) {
    if (!(amount > 0)) return;
    this.settle();
    if (sourceId === this.owner) {
      const hero = this.hero(targetId);
      hero.own += amount;
      hero.ownLast = amount;
    }
    // Without a clock reading, the hit's own marker has just set the time.
    const at = Number.isFinite(time) ? time : this.lastTime;
    if (!Number.isFinite(at) || !this.opposed(sourceId, targetId)) return;
    // The local player's marker for this hit carries its exact server time.
    // It arrives just before the hit or just after it, so wait for the next
    // one and take whichever is nearer the clock reading.
    const event = this.add({ time: at - (Number.isFinite(time) ? OWN_CLOCK_LAG : 0), sourceId, targetId, amount, exact: true });
    if (event) this.ownWaiting.push({ event, before: this.ownMarker });
  }
  timeOwnHits(after) {
    for (const { event, before } of this.ownWaiting) this.timeOwnHit(event, before, after);
    this.ownWaiting = [];
    this.ownMarker = after;
  }
  timeOwnHit(event, before, after) {
    let nearest = null;
    for (const time of [before, after]) {
      if (time !== null && Math.abs(time - event.time) <= OWN_CLOCK_SLACK &&
          (nearest === null || Math.abs(time - event.time) < Math.abs(nearest - event.time))) nearest = time;
    }
    if (nearest !== null) event.time = nearest;
  }
  // A kill notification reports the killer's last hit in full, overkill included.
  finalHit({ sourceId, targetId, amount }) {
    if (!(amount > 0)) return;
    this.settle();
    const death = this.death(targetId);
    death.killer = sourceId;
    death.final = amount;
    // The records normally come first. If the victim's last tick is already in, settle on the next one.
    const lethal = this.hero(targetId).lethal;
    if (lethal && Math.abs(lethal.time - this.lastTime) <= 1) death.seen = true;
  }
  // An assister's damage to the victim over the 20 seconds before its death.
  // Zero means it dealt none.
  assist({ sourceId, targetId, amount }) {
    if (!(amount >= 0)) return;
    this.settle();
    this.death(targetId).assists.set(sourceId, amount);
  }
  death(targetId) {
    let death = this.deaths.get(targetId);
    if (!death) this.deaths.set(targetId, death = { killer: null, final: 0, assists: new Map(), time: this.lastTime, ticks: 0, seen: false });
    return death;
  }
  add(event) {
    if (this.events.length >= MAX_EVENTS) { this.stats.dropped++; return null; }
    this.events.push(event);
    if (!event.exact) this.hero(event.targetId).recent.push(event);
    return event;
  }
  // Closes the open tick: everything received before it explains its losses.
  settle() {
    const tick = this.tick;
    if (!tick) return;
    this.tick = null;
    const drops = [];
    for (const [id, health] of tick.updates) {
      const hero = this.hero(id);
      const before = hero.health;
      hero.health = health;
      if (before === null) continue;
      // Healing in a tick with a hit offsets the damage in it.
      const lost = before - health + (hero.frames.length || hero.units.length ? hero.healed : 0);
      if (!(lost > MIN_DAMAGE)) continue;
      drops.push({ id, amount: lost, lethal: health === 0 && before > 0, at: tick.at, frames: [...new Set(hero.frames)],
        units: new Set(hero.units), own: hero.own, ownLast: hero.ownLast });
    }
    // A champion that lost health in a frame is explained as a target there.
    const hurt = new Map();
    for (const drop of drops) for (const time of drop.frames) {
      if (!hurt.has(time)) hurt.set(time, new Set());
      hurt.get(time).add(drop.id);
    }
    for (const drop of drops) this.resolve(drop, hurt);
    // An own hit still waiting has its marker behind it, or none within reach.
    for (const { event, before } of this.ownWaiting) this.timeOwnHit(event, before, null);
    this.ownWaiting = [];
    // Frames left over belong to champions that only dealt damage this tick.
    for (const hero of this.heroes.values()) {
      hero.frames = [];
      hero.units = [];
      hero.own = 0;
      hero.ownLast = 0;
      hero.healed = 0;
      if (hero.recent.length > RECENT_LIMIT) {
        hero.recent = hero.recent.filter((event) => event.time >= this.lastTime - ASSIST_WINDOW_SECONDS - 5);
      }
    }
    this.settleDeaths();
  }
  // The opposing champions in each of the target's frames. A champion that
  // lost health in a frame itself is taken as a target there, unless every
  // opponent did, which is a trade.
  candidates(drop, hurt) {
    const frames = [];
    for (const time of drop.frames) {
      const opponents = [...(this.groups.get(time) || [])].filter((id) => id !== this.owner && this.opposed(id, drop.id));
      const attackers = opponents.filter((id) => !hurt.get(time)?.has(id));
      // Every opponent here lost health too. A minion or turret hit on the
      // target in the same frame explains the loss better than a trade.
      if (!attackers.length && drop.units.has(time)) continue;
      const list = attackers.length ? attackers : opponents;
      if (list.length) frames.push({ time, list });
    }
    return frames;
  }
  resolve(drop, hurt) {
    if (drop.id === this.owner || !drop.frames.length) return;
    const frames = this.candidates(drop, hurt);
    // The local player's part is already counted exactly. When its last hit
    // killed the target, that hit reports overkill. The others' part then
    // lies between what is left after all of the local player's hits and
    // what is left after the ones before the last. Take the middle. The
    // assist records settle it once the death is processed.
    let amount = drop.amount - drop.own;
    const killer = this.deaths.get(drop.id)?.killer ?? null;
    if (drop.lethal && drop.own > 0 && (killer === this.owner || (killer === null && drop.own > drop.amount))) {
      amount = (Math.max(0, amount) + Math.max(0, drop.amount - (drop.own - drop.ownLast))) / 2;
    }
    if (amount > MIN_DAMAGE && frames.length) {
      this.stats[new Set(frames.flatMap((frame) => frame.list)).size === 1 ? 'single' : 'shared']++;
      // Each frame takes an equal part, credited at its own time so that a
      // tick across the spectator cutoff is only counted from there on.
      for (const frame of frames) {
        for (const sourceId of frame.list) {
          this.add({ time: frame.time, sourceId, targetId: drop.id, exact: false, amount: amount / frames.length / frame.list.length });
        }
      }
    } else if (amount > MIN_DAMAGE) this.stats.unexplained++;
    if (!drop.lethal) return;
    this.hero(drop.id).lethal = { amount: drop.amount, time: drop.frames.at(-1) };
    const death = this.deaths.get(drop.id);
    if (death) death.seen = true;
  }
  // A death is settled once the victim's last tick is in, or a few ticks
  // after its records if that tick never shows.
  settleDeaths() {
    for (const [targetId, death] of this.deaths) {
      if (!death.seen && ++death.ticks < DEATH_SETTLE_TICKS) continue;
      this.deaths.delete(targetId);
      if (targetId !== this.owner) this.reconcile(targetId, death);
      this.hero(targetId).recent = [];
    }
  }
  // The assisters' estimates for the fight give way to the reported damage.
  // Extra assist credit comes out of the killer's estimate. When assists
  // were overestimated, some of the health loss may itself be misattributed.
  reconcile(targetId, death) {
    const hero = this.hero(targetId);
    const lethal = hero.lethal;
    hero.lethal = null;
    const time = lethal?.time ?? death.time ?? this.lastTime;
    const recent = hero.recent.filter((event) => event.time >= time - ASSIST_WINDOW_SECONDS);
    const rescale = (sourceId, wanted) => {
      const events = recent.filter((event) => event.sourceId === sourceId);
      const estimated = events.reduce((total, event) => total + event.amount, 0);
      const amount = wanted(estimated);
      if (estimated > 0) for (const event of events) event.amount *= amount / estimated;
      else if (amount > 0) this.add({ time, sourceId, targetId, amount, exact: false });
      return estimated;
    };
    let surplus = 0;
    for (const [sourceId, reported] of death.assists) {
      if (sourceId === this.owner || !this.opposed(sourceId, targetId)) continue;
      surplus += rescale(sourceId, () => reported) - reported;
      this.stats.reconciled++;
    }
    if (death.killer === null || death.killer === this.owner || !this.opposed(death.killer, targetId)) return;
    const overkill = lethal ? Math.max(0, death.final - lethal.amount) : 0;
    const killerAdjustment = surplus > 0 ? surplus / 2 : surplus;
    rescale(death.killer, (estimated) => Math.max(death.final, estimated + killerAdjustment + overkill));
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
      if (!(event.time > gameTime) || event.time > until || !(event.amount > 0)) continue;
      const source = row(event.sourceId);
      source.champion += event.amount;
      if (event.exact) source.exact += event.amount;
      row(event.targetId).taken += event.amount;
    }
    return totals;
  }
}
