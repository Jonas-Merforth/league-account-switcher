import { EventEmitter } from 'node:events';

import { GameMonitor } from './game-monitor.js';
import { normalizePlatformId } from './regions.js';

export const CADENCE_TIERS_MS = Object.freeze([60_000, 120_000, 300_000]);
export const CADENCE_RECOVERY_MS = 30 * 60_000;

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const DEFAULT_ENDED_RETENTION_MS = 10 * 60_000;
const OBSERVER_INCOMPATIBLE_QUEUE_IDS = new Set([
  1090, 1100, 1110, 1111, 1130, 1160, 1210,
  1700, 1710, 1750,
  1810, 1820, 1830, 1840,
  2000, 2010, 2020
]);

export function parseInstalledClientVersion(systemYaml) {
  const match = String(systemYaml ?? '').match(
    /^\s*branch:\s*['"]?Releases\/(\d+\.\d+(?:\.\d+)*)['"]?\s*$/mi
  );
  return match?.[1] ?? null;
}

function friendIdentity(friend) {
  return {
    puuid: String(friend?.puuid ?? ''),
    gameName: String(friend?.gameName ?? ''),
    tagLine: String(friend?.tagLine ?? '')
  };
}

function incompatibleMode(activity) {
  const queueId = Number(activity?.queueId) || null;
  const queueType = String(activity?.gameQueueType ?? '').trim().toUpperCase();
  return (
    OBSERVER_INCOMPATIBLE_QUEUE_IDS.has(queueId)
    || queueType.includes('TFT')
    || queueType === 'CHERRY'
    || queueType === 'STRAWBERRY'
  );
}

export function spectatorFriendFromPresence(friend) {
  const activity = friend?.activity;
  if (activity?.kind !== 'inGame') return { friend: null, reason: null };
  if (!activity.gameId) return { friend: null, reason: 'Riot presence did not include a game id.' };
  if (!activity.spectatable) {
    return { friend: null, reason: 'Riot did not mark this game as spectatable.' };
  }
  if (incompatibleMode(activity)) {
    return { friend: null, reason: 'Score snapshots are not supported for this game mode.' };
  }
  const championId = Number(activity.championId) || null;
  if (!championId) {
    return { friend: null, reason: 'Riot presence did not include the friend’s champion.' };
  }
  const platformId = normalizePlatformId(
    friend?.presenceSource?.platformId
    ?? friend?.presenceSource?.affinity
  );
  if (!platformId) {
    return { friend: null, reason: 'The source account’s League region is unavailable.' };
  }
  const gameId = String(activity.gameId);
  return {
    reason: null,
    friend: {
      ...friendIdentity(friend),
      gameId,
      platformId,
      gameKey: `${platformId}:${gameId}`,
      championId,
      queueId: Number(activity.queueId) || null,
      queueType: String(activity.gameQueueType ?? ''),
      startedAt: activity.startedAt || null
    }
  };
}

function groupFriends(friends) {
  const games = new Map();
  const unavailableFriends = [];
  for (const source of friends ?? []) {
    const result = spectatorFriendFromPresence(source);
    if (result.friend) {
      const group = games.get(result.friend.gameKey) ?? [];
      group.push(result.friend);
      games.set(result.friend.gameKey, group);
    } else if (result.reason && source?.activity?.kind === 'inGame') {
      unavailableFriends.push({
        ...friendIdentity(source),
        gameId: String(source.activity.gameId ?? ''),
        reason: result.reason
      });
    }
  }
  return { games, unavailableFriends };
}

function redactGame(snapshot) {
  return {
    gameId: String(snapshot?.gameId ?? ''),
    platformId: String(snapshot?.platformId ?? ''),
    queueId: Number(snapshot?.queueId) || null,
    queueType: String(snapshot?.queueType ?? ''),
    status: String(snapshot?.status ?? 'waiting'),
    scoreboard: snapshot?.scoreboard
      ? {
          source: 'keyframe',
          keyFrameId: Number(snapshot.scoreboard.keyFrameId),
          gameTimeSeconds: Number(snapshot.scoreboard.gameTimeSeconds),
          fetchedAt: snapshot.scoreboard.fetchedAt,
          delayed: true,
          teams: (snapshot.scoreboard.teams ?? []).map((team) => ({
            teamId: Number(team.teamId),
            kills: Number(team.kills) || 0,
            towersDestroyed: Number.isInteger(team.towersDestroyed)
              ? team.towersDestroyed
              : null,
            objectives: {
              dragons: Number(team.objectives?.dragons) || 0,
              barons: Number(team.objectives?.barons) || 0,
              riftHeralds: Number(team.objectives?.riftHeralds) || 0,
              voidGrubs: Number(team.objectives?.voidGrubs) || 0,
              atakhan: Number(team.objectives?.atakhan) || 0
            }
          }))
        }
      : null,
    friends: (snapshot?.friends ?? []).map((friend) => ({
      puuid: String(friend.puuid ?? ''),
      participantSlot: Number(friend.participantSlot),
      teamId: Number(friend.teamId),
      championId: Number(friend.championId),
      level: Number(friend.level),
      score: {
        kills: Number(friend.score?.kills) || 0,
        deaths: Number(friend.score?.deaths) || 0,
        assists: Number(friend.score?.assists) || 0,
        cs: Number(friend.score?.cs) || 0
      }
    })),
    freshness: {
      status: String(snapshot?.freshness?.status ?? 'stale'),
      ageSeconds: Number.isFinite(snapshot?.freshness?.ageSeconds)
        ? Number(snapshot.freshness.ageSeconds)
        : null,
      refreshIntervalSeconds: Number(snapshot?.freshness?.refreshIntervalSeconds) || 60,
      nextRefreshAt: snapshot?.freshness?.nextRefreshAt ?? null
    },
    capabilities: {
      teamScore: snapshot?.capabilities?.teamScore ?? 'unavailable',
      friendScore: snapshot?.capabilities?.friendScore ?? 'unavailable',
      structures: snapshot?.capabilities?.structures ?? 'unavailable',
      objectives: snapshot?.capabilities?.objectives ?? 'unavailable'
    },
    lastError: snapshot?.lastError ? String(snapshot.lastError) : null
  };
}

export class SpectatorStatsService extends EventEmitter {
  constructor({
    monitorFactory,
    endedRetentionMs = DEFAULT_ENDED_RETENTION_MS,
    tickIntervalMs = 1_000,
    clientVersionProvider = () => null,
    logger = () => {},
    now = () => Date.now()
  } = {}) {
    super();
    this.monitorFactory = monitorFactory ?? ((options) => new GameMonitor(options));
    this.endedRetentionMs = endedRetentionMs;
    this.tickIntervalMs = tickIntervalMs;
    this.clientVersionProvider = clientVersionProvider;
    this.clientVersion = null;
    this.logger = logger;
    this.now = now;
    this.enabled = false;
    this.latestFriends = [];
    this.unavailableFriends = [];
    this.monitors = new Map();
    this.timer = null;
    this.tickInProgress = false;
    this.generation = 0;
    this.nextMonitorKey = null;
    this.observerCooldownUntil = 0;
    this.cadenceTier = 0;
    this.last429At = null;
    this.observer429Count = 0;
    this.observerRequestCount = 0;
    this.consecutive429s = 0;
  }

  currentCadenceMs() {
    return CADENCE_TIERS_MS[this.cadenceTier];
  }

  updateFriends(friends) {
    this.latestFriends = Array.isArray(friends) ? friends : [];
    if (!this.enabled) return this.snapshot();
    this.reconcileFriends();
    this.emitUpdate();
    this.ensureTimer();
    void this.tick({ force: true });
    return this.snapshot();
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return this.snapshot();
    this.enabled = next;
    this.generation += 1;
    if (!next) {
      this.stopTimer();
      this.monitors.clear();
      this.unavailableFriends = [];
      this.nextMonitorKey = null;
      this.observerCooldownUntil = 0;
      this.cadenceTier = 0;
      this.last429At = null;
      this.consecutive429s = 0;
      this.emitUpdate();
      return this.snapshot();
    }
    this.reconcileFriends();
    this.emitUpdate();
    this.ensureTimer();
    void this.tick({ force: true });
    return this.snapshot();
  }

  reconcileFriends() {
    const { games, unavailableFriends } = groupFriends(this.latestFriends);
    const now = this.now();
    try {
      this.clientVersion = String(this.clientVersionProvider?.() ?? '').trim() || null;
    } catch (error) {
      this.clientVersion = null;
      this.logger('warn', `Could not read the installed League patch: ${error.message}`);
    }
    this.unavailableFriends = unavailableFriends;
    for (const [gameKey, friends] of games) {
      let monitor = this.monitors.get(gameKey);
      if (!monitor) {
        monitor = this.monitorFactory({
          platformId: friends[0].platformId,
          gameId: friends[0].gameId,
          friends,
          clientVersion: this.clientVersion,
          refreshIntervalMs: this.currentCadenceMs(),
          logger: this.logger,
          now: this.now
        });
        monitor.gameKey = gameKey;
        this.monitors.set(gameKey, monitor);
      } else {
        monitor.updateFriends(friends);
        monitor.setRefreshInterval?.(this.currentCadenceMs());
      }
      monitor.lastSeenInFriendsAt = now;
    }
    for (const [gameKey, monitor] of this.monitors) {
      if (!games.has(gameKey) && monitor.endedAt === null) monitor.markEnded?.(now);
    }
  }

  applyCadence() {
    const cadence = this.currentCadenceMs();
    for (const monitor of this.monitors.values()) monitor.setRefreshInterval?.(cadence);
  }

  recoverCadenceIfEligible() {
    if (
      this.cadenceTier > 0
      && this.last429At !== null
      && this.now() - this.last429At >= CADENCE_RECOVERY_MS
    ) {
      this.cadenceTier -= 1;
      this.last429At = this.now();
      this.consecutive429s = 0;
      this.applyCadence();
      this.logger('info', `Spectator stats cadence recovered to ${this.currentCadenceMs() / 1_000}s.`);
    }
  }

  deferMonitors(until) {
    for (const monitor of this.monitors.values()) monitor.deferUntil?.(until);
  }

  register429(monitor) {
    const now = this.now();
    this.observer429Count += 1;
    this.consecutive429s += 1;
    this.last429At = now;
    this.cadenceTier = Math.min(CADENCE_TIERS_MS.length - 1, this.cadenceTier + 1);
    const retryAfter = Number(monitor.lastRetryAfterMs) || DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.observerCooldownUntil = now + retryAfter;
    this.nextMonitorKey = monitor.gameKey;
    this.applyCadence();
    this.deferMonitors(this.observerCooldownUntil);
    this.logger(
      'warn',
      `Spectator stats rate limited; cadence=${this.currentCadenceMs() / 1_000}s cooldownUntil=${new Date(this.observerCooldownUntil).toISOString()}.`
    );
  }

  async pollMonitors({ force = false } = {}) {
    const now = this.now();
    if (now < this.observerCooldownUntil) {
      this.deferMonitors(this.observerCooldownUntil);
      return;
    }
    this.observerCooldownUntil = 0;
    this.recoverCadenceIfEligible();
    const monitors = [...this.monitors.values()];
    if (!monitors.length) return;
    const requestedStart = monitors.findIndex((monitor) => monitor.gameKey === this.nextMonitorKey);
    const start = requestedStart >= 0 ? requestedStart : 0;
    for (let offset = 0; offset < monitors.length; offset += 1) {
      const index = (start + offset) % monitors.length;
      const monitor = monitors[index];
      const due = monitor.shouldPoll?.({
        force,
        cooldownUntil: this.observerCooldownUntil
      }) ?? false;
      if (!due) continue;
      const before = Number(monitor.requestCount) || 0;
      await monitor.poll({ force, cooldownUntil: this.observerCooldownUntil });
      this.observerRequestCount += Math.max(
        0,
        (Number(monitor.requestCount) || 0) - before
      );
      if (monitor.lastErrorStatusCode === 429) {
        this.register429(monitor);
        break;
      }
      this.consecutive429s = 0;
      this.nextMonitorKey = monitors[(index + 1) % monitors.length]?.gameKey ?? null;
      break;
    }
  }

  prune() {
    const now = this.now();
    for (const [gameKey, monitor] of this.monitors) {
      if (
        monitor.endedAt !== null
        && now - monitor.endedAt > this.endedRetentionMs
      ) {
        this.monitors.delete(gameKey);
      }
    }
  }

  async tick({ force = false } = {}) {
    if (!this.enabled || this.tickInProgress) return this.snapshot();
    const generation = this.generation;
    this.tickInProgress = true;
    try {
      await this.pollMonitors({ force });
      if (!this.enabled || generation !== this.generation) return this.snapshot();
      this.prune();
      this.emitUpdate();
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
      if (!this.monitors.size) this.stopTimer();
    }
  }

  ensureTimer() {
    if (!this.enabled || !this.monitors.size || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop() {
    this.enabled = false;
    this.generation += 1;
    this.stopTimer();
    this.monitors.clear();
    this.unavailableFriends = [];
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  snapshot() {
    return {
      enabled: this.enabled,
      service: {
        clientVersion: this.clientVersion,
        snapshotCadenceSeconds: this.currentCadenceMs() / 1_000,
        observerRequestCount: this.observerRequestCount,
        observer429Count: this.observer429Count,
        consecutive429s: this.consecutive429s,
        last429At: this.last429At === null ? null : new Date(this.last429At).toISOString(),
        observerCooldownUntil: this.observerCooldownUntil
          ? new Date(this.observerCooldownUntil).toISOString()
          : null
      },
      unavailableFriends: this.enabled ? this.unavailableFriends.map((friend) => ({ ...friend })) : [],
      games: this.enabled
        ? [...this.monitors.values()].map((monitor) => redactGame(monitor.snapshot()))
        : []
    };
  }
}
