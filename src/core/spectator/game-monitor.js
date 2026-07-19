import { parseBlocks } from './block-parser.js';
import { HttpError } from './errors.js';
import {
  KeyframeSnapshotDecoder,
  UnsupportedKeyframeProfileError
} from './keyframe-snapshot-decoder.js';
import { ObserverClient } from './observer-client.js';

const MIN_REFRESH_MS = 60_000;

function iso(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : null;
}

function intervalFromMetadata(metadata, sharedCadenceMs) {
  const advertised = Number(metadata?.keyFrameTimeInterval);
  return Math.max(
    MIN_REFRESH_MS,
    Number(sharedCadenceMs) || MIN_REFRESH_MS,
    Number.isFinite(advertised) ? advertised : 0
  );
}

function deterministicJitter(gameId, intervalMs) {
  let hash = 2166136261;
  for (const character of String(gameId)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, Math.min(10_000, Math.floor(intervalMs / 10)));
}

function friendIdentity(friend) {
  return {
    puuid: String(friend?.puuid ?? ''),
    gameName: String(friend?.gameName ?? ''),
    tagLine: String(friend?.tagLine ?? '')
  };
}

function mapFriends(friends, participants) {
  const usedSlots = new Set();
  const mapped = [];
  const ambiguous = [];
  for (const friend of friends) {
    const candidates = participants.filter((participant) => (
      participant.championId === Number(friend.championId)
      && !usedSlots.has(participant.participantSlot)
    ));
    if (candidates.length !== 1) {
      ambiguous.push(friendIdentity(friend));
      continue;
    }
    const participant = candidates[0];
    usedSlots.add(participant.participantSlot);
    mapped.push({
      ...friendIdentity(friend),
      participantSlot: participant.participantSlot,
      teamId: participant.teamId,
      championId: participant.championId,
      level: participant.level,
      score: { ...participant.score },
      items: [...participant.items]
    });
  }
  return { mapped, ambiguous };
}

export class GameMonitor {
  constructor({
    platformId,
    gameId,
    friends = [],
    observer,
    decoder = new KeyframeSnapshotDecoder(),
    clientVersion = null,
    refreshIntervalMs = MIN_REFRESH_MS,
    now = () => Date.now(),
    logger = () => {}
  }) {
    this.platformId = platformId;
    this.gameId = String(gameId);
    this.friends = friends;
    this.observer = observer ?? new ObserverClient({ platformId, gameId });
    this.decoder = decoder;
    this.clientVersion = String(clientVersion ?? '').trim();
    this.sharedCadenceMs = Math.max(MIN_REFRESH_MS, Number(refreshIntervalMs) || 0);
    this.now = now;
    this.logger = logger;
    this.metadata = null;
    this.lastChunkInfo = null;
    this.scoreboard = null;
    this.mappedFriends = [];
    this.ambiguousFriends = [];
    this.lastKeyFrameId = null;
    this.nextPollAt = 0;
    this.createdAt = this.now();
    this.updatedAt = null;
    this.lastSeenInFriendsAt = this.createdAt;
    this.endedAt = null;
    this.statusOverride = null;
    this.lastError = null;
    this.lastErrorStatusCode = null;
    this.lastRetryAfterMs = null;
    this.consecutiveFailures = 0;
    this.requestCount = 0;
  }

  updateFriends(friends) {
    this.friends = friends;
    if (this.scoreboard) {
      const result = mapFriends(friends, this.scoreboard.participants);
      this.mappedFriends = result.mapped;
      this.ambiguousFriends = result.ambiguous;
    }
  }

  markEnded(timestamp = this.now()) {
    this.endedAt ??= timestamp;
    this.nextPollAt = Number.POSITIVE_INFINITY;
  }

  setRefreshInterval(milliseconds) {
    this.sharedCadenceMs = Math.max(MIN_REFRESH_MS, Number(milliseconds) || 0);
  }

  refreshIntervalMs() {
    return intervalFromMetadata(this.metadata, this.sharedCadenceMs);
  }

  scheduleNext(baseTimestamp = this.now()) {
    const interval = this.refreshIntervalMs();
    this.nextPollAt = baseTimestamp + interval + deterministicJitter(this.gameId, interval);
  }

  deferUntil(timestamp) {
    const until = Number(timestamp);
    if (Number.isFinite(until)) this.nextPollAt = Math.max(this.nextPollAt, until);
  }

  shouldPoll({ force = false, cooldownUntil = 0 } = {}) {
    if (this.endedAt !== null) return false;
    const now = this.now();
    if (now < cooldownUntil || now < this.nextPollAt) return false;
    return force || now >= this.nextPollAt;
  }

  async request(method, ...args) {
    this.requestCount += 1;
    return await this.observer[method](...args);
  }

  async initialize() {
    if (this.metadata) return;
    this.metadata = await this.request('getMetadata');
    if (!this.metadata.clientVersion && this.clientVersion) {
      this.metadata.clientVersion = this.clientVersion;
    }
  }

  async poll({ force = false, cooldownUntil = 0 } = {}) {
    if (!this.shouldPoll({ force, cooldownUntil })) return this.snapshot();
    try {
      await this.initialize();
      this.lastChunkInfo = await this.request('getLastChunkInfo');
      const keyFrameId = Number(this.lastChunkInfo?.keyFrameId ?? 0);
      if (!Number.isInteger(keyFrameId) || keyFrameId <= 0) {
        this.statusOverride = this.scoreboard ? 'stale' : 'waiting';
        this.lastError = 'Observer on-demand feed has not published a keyframe yet.';
        this.scheduleNext();
        return this.snapshot();
      }

      if (keyFrameId !== this.lastKeyFrameId) {
        const data = await this.request('getKeyFrame', keyFrameId);
        if (!data) {
          this.statusOverride = this.scoreboard ? 'stale' : 'waiting';
          this.lastError = `Observer keyframe ${keyFrameId} is not readable yet.`;
          this.scheduleNext();
          return this.snapshot();
        }
        const decoded = this.decoder.decode({
          blocks: parseBlocks(data, { retainPayload: true }),
          clientVersion: this.metadata?.clientVersion,
          queueId: this.friends[0]?.queueId ?? null,
          queueType: this.friends[0]?.queueType ?? ''
        });
        const mapping = mapFriends(this.friends, decoded.participants);
        this.scoreboard = {
          source: 'keyframe',
          keyFrameId,
          gameTimeSeconds: decoded.gameTimeSeconds,
          fetchedAt: iso(this.now()),
          delayed: true,
          teams: decoded.teams,
          participants: decoded.participants,
          capabilities: decoded.capabilities,
          profileId: decoded.profileId
        };
        this.mappedFriends = mapping.mapped;
        this.ambiguousFriends = mapping.ambiguous;
        this.lastKeyFrameId = keyFrameId;
        this.updatedAt = this.now();
      }

      this.statusOverride = null;
      this.lastError = this.ambiguousFriends.length
        ? 'One or more friends could not be uniquely mapped to a participant by champion id.'
        : null;
      this.lastErrorStatusCode = null;
      this.lastRetryAfterMs = null;
      this.consecutiveFailures = 0;
      if (
        Boolean(this.lastChunkInfo?.gameEnded)
        || Boolean(this.metadata?.gameEnded)
      ) {
        this.markEnded(this.now());
      } else {
        this.scheduleNext();
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastErrorStatusCode = Number(error?.statusCode) || null;
      this.lastRetryAfterMs = Number(error?.retryAfterMs) || null;
      if (error instanceof UnsupportedKeyframeProfileError) {
        this.statusOverride = 'unsupported';
        this.lastError = error.message;
        this.scheduleNext();
      } else {
        this.statusOverride = this.scoreboard ? 'stale' : 'error';
        this.lastError = error instanceof HttpError && error.statusCode === 404
          ? 'Observer stream is not available yet.'
          : error.message;
        const backoff = Math.max(
          this.refreshIntervalMs(),
          Number(error?.retryAfterMs) || 0
        );
        this.nextPollAt = this.now() + backoff;
      }
      this.logger('warn', `game ${this.gameId}: ${this.lastError}`);
    } finally {
      await this.observer.close?.();
    }
    return this.snapshot();
  }

  snapshot() {
    const now = this.now();
    const interval = this.refreshIntervalMs();
    const ageSeconds = this.updatedAt === null ? null : Math.max(0, (now - this.updatedAt) / 1_000);
    const stale = this.statusOverride === 'stale'
      || (ageSeconds !== null && ageSeconds > (interval * 2) / 1_000);
    const status = this.endedAt !== null
      ? 'ended'
      : this.statusOverride
        ?? (this.scoreboard ? (stale ? 'stale' : 'ready') : 'waiting');
    const decoderCapabilities = this.scoreboard?.capabilities ?? {
      teamScore: 'unavailable',
      friendScore: 'unavailable',
      structures: 'unavailable',
      objectives: 'unavailable',
      items: 'unavailable'
    };
    const friendScoreAvailable = (
      decoderCapabilities.friendScore === 'available'
      && this.ambiguousFriends.length === 0
    );
    const itemsAvailable = (
      decoderCapabilities.items === 'available'
      && this.ambiguousFriends.length === 0
    );
    return {
      gameId: this.gameId,
      platformId: this.platformId,
      queueId: Number(this.friends[0]?.queueId ?? 0) || null,
      queueType: String(this.friends[0]?.queueType ?? ''),
      status,
      scoreboard: this.scoreboard
        ? {
            source: this.scoreboard.source,
            keyFrameId: this.scoreboard.keyFrameId,
            gameTimeSeconds: this.scoreboard.gameTimeSeconds,
            fetchedAt: this.scoreboard.fetchedAt,
            delayed: true,
            teams: this.scoreboard.teams.map((team) => ({
              ...team,
              objectives: { ...team.objectives }
            }))
          }
        : null,
      friends: this.mappedFriends.map((friend) => ({
        ...friend,
        score: { ...friend.score },
        items: [...friend.items]
      })),
      freshness: {
        status: this.scoreboard && !stale ? 'fresh' : 'stale',
        ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds * 1_000) / 1_000,
        refreshIntervalSeconds: interval / 1_000,
        nextRefreshAt: Number.isFinite(this.nextPollAt) ? iso(this.nextPollAt) : null
      },
      capabilities: {
        teamScore: decoderCapabilities.teamScore,
        friendScore: friendScoreAvailable ? 'available' : 'unavailable',
        structures: decoderCapabilities.structures,
        objectives: decoderCapabilities.objectives,
        items: itemsAvailable ? 'available' : 'unavailable'
      },
      lastError: this.lastError
    };
  }
}

