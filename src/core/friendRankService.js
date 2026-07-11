import { parseRankedStats } from './rankedStats.js';

export const FRIEND_RANK_CACHE_TTL_MS = 5 * 60_000;
export const FRIEND_RANK_POST_GAME_DELAY_MS = 2_000;
export const FRIEND_RANK_CONCURRENCY = 6;

const ACTIVE_GAME_KINDS = new Set(['inGame', 'champSelect']);

function text(value) {
  return String(value || '').trim();
}

function postGameMarker(friend, previous) {
  const activity = friend?.activity || {};
  const previousActivity = previous || {};
  if (activity.kind === 'postGame') {
    return `post:${text(activity.gameId) || text(activity.startedAt) || 'unknown'}`;
  }
  if (ACTIVE_GAME_KINDS.has(previousActivity.kind) && !ACTIVE_GAME_KINDS.has(activity.kind)) {
    return `ended:${text(previousActivity.gameId) || text(previousActivity.startedAt) || 'unknown'}`;
  }
  return '';
}

export async function fetchFriendRanks(lcu, friends, {
  concurrency = FRIEND_RANK_CONCURRENCY,
  now = () => Date.now()
} = {}) {
  const unique = new Map();
  for (const friend of friends || []) {
    const puuid = text(friend?.puuid);
    if (puuid) unique.set(puuid, friend);
  }
  const queue = [...unique.entries()];
  const results = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, queue.length || 1));

  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const [puuid] = queue[index];
      try {
        const payload = await lcu.get(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`);
        const parsed = payload ? parseRankedStats(payload) : null;
        if (parsed) {
          results.push({ puuid, ranks: { ...parsed, updatedAt: new Date(now()).toISOString() } });
        }
      } catch {
        // Rank enrichment is optional. One unavailable friend/client must not affect the friend list.
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class FriendRankService {
  constructor({
    lcu,
    log = () => {},
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    cacheTtlMs = FRIEND_RANK_CACHE_TTL_MS,
    postGameDelayMs = FRIEND_RANK_POST_GAME_DELAY_MS,
    concurrency = FRIEND_RANK_CONCURRENCY
  } = {}) {
    this.lcu = lcu;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.cacheTtlMs = cacheTtlMs;
    this.postGameDelayMs = postGameDelayMs;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.lastActivities = new Map();
    this.postGameMarkers = new Map();
    this.pendingTimers = new Set();
    this.generation = 0;
  }

  startRefresh(friends, onUpdate = () => {}) {
    const generation = ++this.generation;
    this._cancelPendingTimers();
    const now = this.now();
    const immediate = [];
    const postGame = [];

    for (const friend of friends || []) {
      const puuid = text(friend?.puuid);
      if (!puuid) continue;
      const cached = this.cache.get(puuid);
      if (friend.online && cached?.ranks) friend.ranks = cached.ranks;

      const previous = this.lastActivities.get(puuid);
      const marker = postGameMarker(friend, previous);
      if (friend.online && marker && this.postGameMarkers.get(puuid) !== marker) {
        postGame.push(friend);
      }
      this.lastActivities.set(puuid, { ...(friend.activity || {}) });

      const stale = !cached || now - cached.fetchedAt >= this.cacheTtlMs;
      if (friend.online && stale) immediate.push(friend);
    }

    this._scheduleFetch(immediate, 0, generation, onUpdate, 'refresh');
    this._scheduleFetch(postGame, this.postGameDelayMs, generation, onUpdate, 'post-game');
    return generation;
  }

  _scheduleFetch(friends, delayMs, generation, onUpdate, reason) {
    if (!friends.length) return;
    const timer = this.setTimer(async () => {
      this.pendingTimers.delete(timer);
      if (generation !== this.generation) return;
      if (reason === 'post-game') {
        for (const friend of friends) {
          const puuid = text(friend?.puuid);
          const marker = postGameMarker(friend, this.lastActivities.get(puuid));
          if (puuid && marker) this.postGameMarkers.set(puuid, marker);
        }
      }
      const startedAt = this.now();
      const updates = await fetchFriendRanks(this.lcu, friends, {
        concurrency: this.concurrency,
        now: this.now
      });
      if (generation !== this.generation || !updates.length) return;
      for (const update of updates) {
        this.cache.set(update.puuid, { ranks: update.ranks, fetchedAt: this.now() });
      }
      this.log(`Friends ranks: ${reason} updated ${updates.length}/${friends.length} online friends in ${this.now() - startedAt}ms.`);
      onUpdate({ generation, reason, updates });
    }, delayMs);
    timer?.unref?.();
    this.pendingTimers.add(timer);
  }

  _cancelPendingTimers() {
    for (const timer of this.pendingTimers) this.clearTimer(timer);
    this.pendingTimers.clear();
  }
}
