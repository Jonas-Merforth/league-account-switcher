import { parseBlocks } from './block-parser.js';
import { HttpError } from './errors.js';
import {
  KeyframeSnapshotDecoder,
  UnsupportedKeyframeProfileError
} from './keyframe-snapshot-decoder.js';
import { ObserverClient } from './observer-client.js';

const MIN_REFRESH_MS = 60_000;
const MIN_WAITING_REFRESH_MS = 5_000;
const OBSERVER_DELAY_MS = 150_000;

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

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finiteNumber(value);
  return Number.isInteger(number) ? number : null;
}

function keyframePublicationAgeMs(metadata, chunkInfo, snapshotGameTimeSeconds) {
  const chunkIntervalMs = finiteNumber(metadata?.chunkTimeInterval);
  const keyFrameIntervalMs = finiteNumber(metadata?.keyFrameTimeInterval);
  const advertisedChunkDurationMs = (
    chunkIntervalMs > 0
      ? chunkIntervalMs
      : keyFrameIntervalMs > 0
        ? keyFrameIntervalMs
        : MIN_REFRESH_MS
  );
  const reportedChunkDurationMs = finiteNumber(chunkInfo?.duration);
  const maximumAvailableSinceMs = reportedChunkDurationMs > 0
    ? Math.min(advertisedChunkDurationMs, reportedChunkDurationMs)
    : advertisedChunkDurationMs;
  const availableSinceMs = finiteNumber(chunkInfo?.availableSince);
  let ageMs = Math.min(
    maximumAvailableSinceMs,
    Math.max(0, availableSinceMs ?? 0)
  );

  if (!(chunkIntervalMs > 0)) return ageMs;
  const latestChunkId = integer(chunkInfo?.chunkId);
  const nextChunkId = integer(chunkInfo?.nextChunkId);
  const exactChunksPerKeyFrame = keyFrameIntervalMs > 0
    ? keyFrameIntervalMs / chunkIntervalMs
    : MIN_REFRESH_MS / chunkIntervalMs;
  const chunksPerKeyFrame = Math.max(1, Math.ceil(exactChunksPerKeyFrame));
  const ended = (
    Boolean(chunkInfo?.gameEnded)
    || Boolean(metadata?.gameEnded)
    || integer(chunkInfo?.endGameChunkId) > 0
    || integer(metadata?.endGameChunkId) > 0
  );
  const maximumTrailingChunks = Math.max(
    0,
    chunksPerKeyFrame - 1 + (ended ? 1 : 0)
  );
  let trailingChunks = null;
  if (
    latestChunkId !== null
    && nextChunkId !== null
    && nextChunkId > 0
    && latestChunkId >= nextChunkId
  ) {
    trailingChunks = latestChunkId - nextChunkId;
  } else if (latestChunkId !== null) {
    const startGameChunkId = (
      integer(chunkInfo?.startGameChunkId)
      ?? integer(metadata?.startGameChunkId)
    );
    if (
      startGameChunkId !== null
      && Number.isFinite(snapshotGameTimeSeconds)
    ) {
      const nominalCurrentChunkStartMs = (
        latestChunkId - startGameChunkId - 1
      ) * chunkIntervalMs;
      const offsetFromKeyFrameMs = (
        nominalCurrentChunkStartMs - snapshotGameTimeSeconds * 1_000
      );
      if (
        offsetFromKeyFrameMs >= -2_000
        && offsetFromKeyFrameMs <= maximumTrailingChunks * chunkIntervalMs + 2_000
      ) {
        trailingChunks = Math.round(offsetFromKeyFrameMs / chunkIntervalMs);
      }
    }
  }
  ageMs += Math.min(
    maximumTrailingChunks,
    Math.max(0, trailingChunks ?? 0)
  ) * chunkIntervalMs;
  return ageMs;
}

function estimatedLiveGameTimeSeconds({
  gameTimeSeconds,
  metadata,
  chunkInfo,
  elapsedSinceChunkInfoMs = 0
}) {
  const snapshotGameTimeSeconds = finiteNumber(gameTimeSeconds);
  if (snapshotGameTimeSeconds === null) return null;
  const processingAgeMs = Math.max(0, finiteNumber(elapsedSinceChunkInfoMs) ?? 0);
  return Math.max(0, snapshotGameTimeSeconds) + (
    OBSERVER_DELAY_MS
    + keyframePublicationAgeMs(metadata, chunkInfo, snapshotGameTimeSeconds)
    + processingAgeMs
  ) / 1_000;
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

  waitingRefreshIntervalMs() {
    const steadyInterval = this.refreshIntervalMs();
    if (this.sharedCadenceMs > MIN_REFRESH_MS) return steadyInterval;
    const suggested = Number(this.lastChunkInfo?.nextAvailableChunk);
    if (!Number.isFinite(suggested) || suggested <= 0) return steadyInterval;
    return Math.min(
      steadyInterval,
      Math.max(MIN_WAITING_REFRESH_MS, suggested)
    );
  }

  scheduleNext(baseTimestamp = this.now(), intervalMs = this.refreshIntervalMs()) {
    const interval = Number(intervalMs) || this.refreshIntervalMs();
    this.nextPollAt = baseTimestamp + interval + deterministicJitter(this.gameId, interval);
  }

  scheduleWaitingNext(baseTimestamp = this.now()) {
    this.scheduleNext(baseTimestamp, this.waitingRefreshIntervalMs());
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
      const chunkInfoObservedAt = this.now();
      const keyFrameId = Number(this.lastChunkInfo?.keyFrameId ?? 0);
      if (!Number.isInteger(keyFrameId) || keyFrameId <= 0) {
        this.statusOverride = this.scoreboard ? 'stale' : 'waiting';
        this.lastError = 'Observer on-demand feed has not published a keyframe yet.';
        if (this.scoreboard) this.scheduleNext();
        else this.scheduleWaitingNext();
        return this.snapshot();
      }

      if (keyFrameId !== this.lastKeyFrameId) {
        const data = await this.request('getKeyFrame', keyFrameId);
        if (!data) {
          this.statusOverride = this.scoreboard ? 'stale' : 'waiting';
          this.lastError = `Observer keyframe ${keyFrameId} is not readable yet.`;
          if (this.scoreboard) this.scheduleNext();
          else this.scheduleWaitingNext();
          return this.snapshot();
        }
        const decoded = this.decoder.decode({
          blocks: parseBlocks(data, { retainPayload: true }),
          clientVersion: this.metadata?.clientVersion,
          queueId: this.friends[0]?.queueId ?? null,
          queueType: this.friends[0]?.queueType ?? ''
        });
        const mapping = mapFriends(this.friends, decoded.participants);
        const fetchedAt = this.now();
        this.scoreboard = {
          source: 'keyframe',
          keyFrameId,
          gameTimeSeconds: decoded.gameTimeSeconds,
          estimatedLiveGameTimeSecondsAtFetch: estimatedLiveGameTimeSeconds({
            gameTimeSeconds: decoded.gameTimeSeconds,
            metadata: this.metadata,
            chunkInfo: this.lastChunkInfo,
            elapsedSinceChunkInfoMs: fetchedAt - chunkInfoObservedAt
          }),
          fetchedAt: iso(fetchedAt),
          delayed: true,
          teams: decoded.teams,
          participants: decoded.participants,
          capabilities: decoded.capabilities,
          profileId: decoded.profileId
        };
        this.mappedFriends = mapping.mapped;
        this.ambiguousFriends = mapping.ambiguous;
        this.lastKeyFrameId = keyFrameId;
        this.updatedAt = fetchedAt;
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
            estimatedLiveGameTimeSecondsAtFetch:
              this.scoreboard.estimatedLiveGameTimeSecondsAtFetch,
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
