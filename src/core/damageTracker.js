const TYPES = ['physical', 'magic', 'true', 'unknown'];
const TARGETS = ['champion', 'neutral', 'dummy', 'unclassified'];

function summarize(events, duration, healthLoss) {
  const types = Object.fromEntries(TYPES.map((type) => [type, 0]));
  const sources = new Map();
  let total = 0;
  let hits = 0;
  let matchedHits = 0;
  let unattributed = 0;
  for (const e of events) {
    hits++;
    const match = healthLoss?.get(e.id);
    if (healthLoss && !match) continue;
    if (match) matchedHits++;
    const amount = match?.amount ?? e.amount;
    total += amount;
    if (!amount) continue;
    const schools = e.schools && Object.entries(e.schools).filter(([, value]) => value > 0);
    if (match && (!match.attributed || (schools?.length > 1 && Math.abs(amount - e.amount) > 0.02))) {
      unattributed += amount;
      continue;
    }
    if (e.schools) {
      for (const [type, value] of schools) types[type] += value * (amount / e.amount);
    } else types[e.damageType] += amount;
    const key = e.ability || 'Unknown source';
    sources.set(key, (sources.get(key) || 0) + amount);
  }
  const partial = !!healthLoss && matchedHits !== hits;
  return { total: healthLoss && hits && !matchedHits ? null : total,
    dps: duration > 0 && !partial ? total / duration : null, duration, hits, types,
    ...(healthLoss && { matchedHits, unattributed, fromHealth: true }),
    sources: [...sources].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount) };
}

// Aggregate normalized damage events by target, interval and source.
export class DamageTracker {
  constructor({ fightGap = 8, maxEvents = 200000 } = {}) {
    this.maxEvents = maxEvents;
    this.setFightGap(fightGap);
    this.reset();
  }
  reset({ gameId = null, startedAt = 0 } = {}) {
    if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error('Invalid tracking start');
    this.gameId = gameId; this.startedAt = startedAt;
    this.events = []; this.ids = new Set(); this.lastTime = startedAt;
  }
  setFightGap(seconds) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('Fight pause must be 1–60 seconds');
    this.fightGap = seconds;
  }
  add(event) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 200 ||
        typeof event.sourceId !== 'string' || !event.sourceId ||
        !Number.isFinite(event.time) || event.time < this.startedAt ||
        !Number.isFinite(event.amount) || event.amount < 0 ||
        !(event.schools ? validSchools(event.schools, event.amount) : TYPES.includes(event.damageType)) ||
        (event.ability != null && (typeof event.ability !== 'string' || event.ability.length > 200))) {
      throw new Error('Invalid damage event');
    }
    if (!TARGETS.includes(event.targetKind) || event.amount === 0 || this.ids.has(event.id)) return false;
    if (event.time < this.lastTime) throw new Error('Damage events must be ordered by game time');
    if (this.events.length >= this.maxEvents) throw new Error('Damage event limit reached; coverage is incomplete');
    this.ids.add(event.id); this.lastTime = event.time;
    this.events.push({ ...event, schools: event.schools ? { ...event.schools } : undefined });
    return true;
  }
  snapshot({ sourceId, now, target = 'all', targetKinds, fightTarget = target, healthLoss }) {
    if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Invalid game clock');
    const validTargets = ['all', 'combat', ...TARGETS];
    if (!validTargets.includes(target) || !validTargets.includes(fightTarget)) throw new Error('Invalid target filter');
    const playerEvents = this.events.filter((e) => e.sourceId === sourceId);
    const kindOf = (event) => targetKinds?.get(event.targetId) ?? event.targetKind;
    const eventsFor = (scope) => scope === 'all' ? playerEvents : playerEvents.filter((event) => {
      const kind = kindOf(event);
      return kind === scope || (scope === 'combat' && ['champion', 'neutral'].includes(kind));
    });
    const eligible = eventsFor(target);
    const fightEvents = fightTarget === target ? eligible : eventsFor(fightTarget);
    const fights = [];
    for (const event of fightEvents) {
      let fight = fights.at(-1);
      if (!fight || event.time - fight.end >= this.fightGap) {
        fight = { start: event.time, end: event.time, events: [] }; fights.push(fight);
      }
      fight.end = event.time; fight.events.push(event);
    }
    const last30 = eligible.filter((e) => e.time > now - 30);
    return { gameId: this.gameId, startedAt: this.startedAt, partial: this.startedAt > 0,
      observedHits: playerEvents.length,
      unclassifiedHits: playerEvents.filter((e) => kindOf(e) === 'unclassified').length,
      total: summarize(eligible, now - this.startedAt, target === 'champion' ? healthLoss : undefined),
      last30: summarize(last30, Math.min(30, now - this.startedAt), target === 'champion' ? healthLoss : undefined),
      fights: fights.map((f) => ({ start: f.start, end: f.end, active: now - f.end < this.fightGap,
        ...summarize(f.events, f.end - f.start, fightTarget === 'champion' ? healthLoss : undefined) })) };
  }
}

function validSchools(schools, amount) {
  const entries = Object.entries(schools);
  return entries.length > 0 && entries.every(([kind, value]) => TYPES.includes(kind) && Number.isFinite(value) && value >= 0) &&
    Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - amount) < 0.0001;
}
