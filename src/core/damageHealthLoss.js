// Health snapshots can batch hits or include other players' damage. Count a
// drop only when the combat display agrees with our outgoing hit records.
const MAX_UPDATE_DELAY_MS = 150;
const MAX_LETHAL_BASELINE_AGE_MS = 750;
const MAX_HITS_BETWEEN_UPDATES = 64;
const AMOUNT_EPSILON = 0.02;

export class DamageHealthLoss {
  targets = new Map();
  matches = new Map();

  noteHit(targetId, time, amount, id) {
    const target = this.targets.get(targetId);
    if (!target || time < target.time || !(amount > 0)) return;
    const hits = id ? target.outgoing : target.display;
    if (hits.length === MAX_HITS_BETWEEN_UPDATES) {
      target.overflow = true;
      return;
    }
    hits.push({ time, amount, id });
  }

  update(targetId, time, health) {
    if (health === null) {
      this.targets.delete(targetId);
      return;
    }
    const before = this.targets.get(targetId);
    if (before && time < before.time) return;
    // A repeat of the same state (including retransmissions) cannot settle a hit.
    if (before?.health === health && before.outgoing.length) return;
    this.targets.set(targetId, { time, health, outgoing: [], display: [], overflow: false });
    if (!before?.outgoing.length || before.overflow || before.health <= health) return;
    const { outgoing, display } = before;
    if (outgoing.length !== display.length || time - outgoing.at(-1).time > MAX_UPDATE_DELAY_MS) return;
    const byTimeAndAmount = (a, b) => a.time - b.time || a.amount - b.amount;
    const expected = [...outgoing].sort(byTimeAndAmount);
    if (display.sort(byTimeAndAmount).some((hit, i) => hit.time !== expected[i].time ||
      Math.abs(hit.amount - expected[i].amount) > AMOUNT_EPSILON)) return;

    const reported = outgoing.reduce((sum, hit) => sum + hit.amount, 0);
    const drop = before.health - health;
    if (drop > reported + AMOUNT_EPSILON) return;
    const wholeHits = Math.abs(drop - reported) <= AMOUNT_EPSILON;
    if (!wholeHits && outgoing.some((hit) => hit.time !== outgoing[0].time)) return;
    if (!wholeHits && health === 0 && outgoing[0].time - before.time > MAX_LETHAL_BASELINE_AGE_MS) return;

    if (wholeHits || outgoing.length === 1) {
      const ratio = Math.min(drop / reported, 1);
      for (const hit of outgoing) {
        this.matches.set(hit.id, { amount: hit.amount * ratio, attributed: true });
      }
    } else {
      // Simultaneous hits can establish a combined drop. The allocation across
      // spells or schools is unknown when the amounts differ.
      for (const [index, hit] of outgoing.entries()) {
        this.matches.set(hit.id, { amount: index === 0 ? drop : 0, attributed: false });
      }
    }
  }

  invalidate() {
    this.targets.clear();
  }
}
