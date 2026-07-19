function finiteDate(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function durationParts(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

export function spectatorFreshnessLine({
  fetchedAt,
  gameTimeSeconds,
  startedAt,
  now = Date.now()
} = {}) {
  const fetched = finiteDate(fetchedAt);
  const started = finiteDate(startedAt);
  const fetchedText = fetched === null
    ? 'Fetch time unavailable'
    : `Fetched ${durationParts((now - fetched) / 1_000)} ago`;
  if (started === null || !Number.isFinite(Number(gameTimeSeconds))) {
    return `${fetchedText} · live delay unavailable`;
  }
  const liveGameSeconds = Math.max(0, (now - started) / 1_000);
  const behindLiveSeconds = Math.max(0, liveGameSeconds - Number(gameTimeSeconds));
  return `${fetchedText} · ~${durationParts(behindLiveSeconds)} behind live`;
}

export function formatSpectatorGameTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function platformId(friend) {
  return String(
    friend?.presenceSource?.platformId
    ?? friend?.presenceSource?.affinity
    ?? ''
  ).trim().toUpperCase();
}

function matchingGame(friend, spectatorState) {
  const gameId = String(friend?.activity?.gameId ?? '');
  const platform = platformId(friend);
  const games = spectatorState?.games ?? [];
  return games.find((game) => (
    String(game.gameId) === gameId
    && (!platform || String(game.platformId).toUpperCase() === platform)
  )) ?? games.find((game) => String(game.gameId) === gameId) ?? null;
}

function unavailableReason(friend, spectatorState) {
  const puuid = String(friend?.puuid ?? '');
  return (spectatorState?.unavailableFriends ?? []).find(
    (item) => String(item.puuid ?? '') === puuid
  )?.reason ?? null;
}

function teamView(team, friendTeamId) {
  const teamId = Number(team?.teamId);
  return {
    teamId,
    label: teamId === 100 ? 'Blue' : teamId === 200 ? 'Red' : `Team ${teamId}`,
    ally: teamId === Number(friendTeamId),
    kills: Number(team?.kills) || 0,
    towers: Number.isInteger(team?.towersDestroyed) ? team.towersDestroyed : null,
    objectives: {
      dragons: Number(team?.objectives?.dragons) || 0,
      barons: Number(team?.objectives?.barons) || 0,
      riftHeralds: Number(team?.objectives?.riftHeralds) || 0,
      voidGrubs: Number(team?.objectives?.voidGrubs) || 0,
      atakhan: Number(team?.objectives?.atakhan) || 0
    }
  };
}

function statusMessage(game) {
  if (!game) return 'Waiting for this game to be discovered by a Friends refresh.';
  if (game.status === 'waiting') {
    return game.lastError || 'Waiting for Riot’s delayed spectator feed to publish its first keyframe.';
  }
  if (game.status === 'unsupported') {
    return game.lastError || 'This League patch does not have a verified decoder profile yet.';
  }
  if (game.status === 'error') {
    return game.lastError || 'The delayed spectator snapshot is currently unavailable.';
  }
  if (game.status === 'ended' && !game.scoreboard) return 'This game has ended.';
  return '';
}

export function friendSpectatorStatsView(friend, spectatorState, now = Date.now()) {
  if (!spectatorState?.enabled || friend?.activity?.kind !== 'inGame') return null;
  const unavailable = unavailableReason(friend, spectatorState);
  if (unavailable) {
    return {
      status: 'unavailable',
      statusMessage: unavailable,
      context: friend.activity.queueLabel || 'In game',
      freshnessLine: ''
    };
  }

  const game = matchingGame(friend, spectatorState);
  const message = statusMessage(game);
  if (!game?.scoreboard) {
    return {
      status: game?.status || 'waiting',
      statusMessage: message,
      context: friend.activity.queueLabel || 'In game',
      freshnessLine: ''
    };
  }

  const participant = (game.friends ?? []).find(
    (candidate) => String(candidate.puuid ?? '') === String(friend.puuid ?? '')
  ) ?? null;
  const teams = [...(game.scoreboard.teams ?? [])]
    .sort((left, right) => Number(left.teamId) - Number(right.teamId))
    .map((team) => teamView(team, participant?.teamId));
  const staleMessage = game.status === 'stale'
    ? (game.lastError || 'This snapshot is stale; the next keyframe will replace it.')
    : game.status === 'ended'
      ? 'Final delayed snapshot'
      : '';

  return {
    status: game.status,
    statusMessage: staleMessage || message,
    context: [
      friend.activity.queueLabel || game.queueType,
      `Snapshot ${formatSpectatorGameTime(game.scoreboard.gameTimeSeconds)}`
    ].filter(Boolean).join(' · '),
    freshnessLine: spectatorFreshnessLine({
      fetchedAt: game.scoreboard.fetchedAt,
      gameTimeSeconds: game.scoreboard.gameTimeSeconds,
      startedAt: friend.activity.startedAt,
      now
    }),
    friend: participant
      ? {
          championName: friend.activity.championName || `Champion ${participant.championId}`,
          level: participant.level,
          kills: participant.score.kills,
          deaths: participant.score.deaths,
          assists: participant.score.assists,
          cs: participant.score.cs
        }
      : null,
    friendUnavailable: participant
      ? ''
      : (game.lastError || 'The friend could not be mapped uniquely in this keyframe.'),
    teams
  };
}
