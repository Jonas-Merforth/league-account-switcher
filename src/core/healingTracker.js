// Healing for every champion, and the health each one lost.
//
// The server sends a heal event for all ten champions, owned by the healer,
// whether or not the champion is in vision. Unit replication carries every
// champion's current health. Health lost in an update, plus the healing
// received since the previous one, is the damage that champion took.
//
// Checked against Match History by replaying four recorded games (ARAM
// Mayhem and Summoner's Rift, 16.22 and 16.23). Recorded from the start,
// the heals credited to each champion were within 3% of its totalHeal and
// health lost within 7% of its totalDamageTaken, for allies and enemies.
const MIN_LOSS = 0.005;
const MAX_UNITS = 4096;

// An enemy is worth anti-heal once it has healed a meaningful amount and
// heals back a large part of the damage it takes.
export const ANTI_HEAL_MIN_HEALING = 2000;
export const ANTI_HEAL_MIN_TAKEN = 1500;
export const ANTI_HEAL_MIN_SHARE = 0.25;

// Wounds items on the current patch, for when League's item data is
// unavailable. Mode variants (Arena, ARAM) add a prefix to the same ID.
const DEFAULT_ANTI_HEAL_ITEMS = [3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609];

export class HealingTracker {
  constructor() {
    this.healers = new Map();
    this.units = new Map();
    this.events = 0;
  }
  unit(id) {
    let unit = this.units.get(id);
    if (!unit && this.units.size < MAX_UNITS) this.units.set(id, unit = { health: null, pending: 0, received: 0, lost: 0 });
    return unit;
  }
  heal({ sourceId, targetId, amount }) {
    if (!sourceId || !targetId || !Number.isFinite(amount) || !(amount > 0)) return;
    let healer = this.healers.get(sourceId);
    if (!healer) {
      if (this.healers.size >= MAX_UNITS) return;
      this.healers.set(sourceId, healer = { self: 0, others: 0 });
    }
    if (sourceId === targetId) healer.self += amount;
    else healer.others += amount;
    const target = this.unit(targetId);
    if (target) { target.received += amount; target.pending += amount; }
    this.events++;
  }
  // Call for each champion health record, in stream order with the heals.
  health({ id, health }) {
    if (!Number.isFinite(health) || health < 0) return;
    const unit = this.unit(id);
    if (!unit) return;
    if (unit.health !== null) {
      const lost = unit.health - health + unit.pending;
      if (lost > MIN_LOSS) unit.lost += lost;
    }
    unit.health = health;
    unit.pending = 0;
  }
  // Healing done and received, and health lost, for one unit.
  totals(id) {
    const healer = this.healers.get(id);
    const unit = this.units.get(id);
    const self = healer?.self || 0;
    const others = healer?.others || 0;
    return { total: self + others, self, allies: others, received: unit?.received || 0, taken: unit?.lost || 0 };
  }
}

// League's item data names the Wounds effect in each item's description.
export function antiHealItemIds(items) {
  if (!Array.isArray(items)) return null;
  const ids = items.filter((item) => Number.isSafeInteger(item?.id) && typeof item.description === 'string' &&
    /\bwounds\b/i.test(item.description)).map((item) => item.id);
  return ids.length ? ids : null;
}

export function isAntiHealItem(id, ids) {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (ids) return ids.has(id);
  return DEFAULT_ANTI_HEAL_ITEMS.includes(id >= 100000 ? id % 10000 : id);
}

// The share of the damage a champion took that it healed back.
export function healedBack(player) {
  return player.taken >= ANTI_HEAL_MIN_TAKEN ? player.total / player.taken : null;
}

// Enemies that heal back a large part of their damage, and the players on
// your team who already apply Wounds.
export function antiHealAdvice(players, holders = []) {
  const healers = players.filter((player) => {
    const share = healedBack(player);
    return player.side === 'enemy' && player.total >= ANTI_HEAL_MIN_HEALING && share >= ANTI_HEAL_MIN_SHARE;
  }).sort((a, b) => b.total - a.total).map((player) => ({ name: player.name, total: player.total, share: healedBack(player) }));
  const owners = holders.filter((holder) => holder.side === 'ally')
    .map(({ name, item, you }) => ({ name, item, you: !!you }));
  return { healers, owners, recommended: healers.length > 0 && !owners.length };
}
