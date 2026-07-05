const LOBBY_PHASE = 'Lobby';

function text(value) {
  return String(value ?? '').trim();
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function parseRiotId(riotId) {
  const value = text(riotId);
  const index = value.lastIndexOf('#');
  if (index <= 0 || index === value.length - 1) return { gameName: value, tagLine: '' };
  return {
    gameName: value.slice(0, index).trim(),
    tagLine: value.slice(index + 1).trim()
  };
}

export function normalizeLobbyInviteTarget(input = {}) {
  const parsed = parseRiotId(input.riotId);
  const gameName = text(input.gameName) || parsed.gameName;
  const tagLine = text(input.tagLine) || parsed.tagLine;
  const riotId = gameName && tagLine ? `${gameName}#${tagLine}` : text(input.riotId);
  const puuid = text(input.puuid);
  return {
    puuid,
    gameName,
    tagLine,
    riotId,
    label: riotId || gameName || puuid || 'this player'
  };
}

function lobbyMemberCandidates(lobby) {
  const candidates = [];
  if (lobby?.localMember) candidates.push(lobby.localMember);
  for (const key of ['members', 'players']) {
    if (Array.isArray(lobby?.[key])) candidates.push(...lobby[key]);
  }
  if (Array.isArray(lobby?.currentParty?.players)) candidates.push(...lobby.currentParty.players);
  return candidates.filter(Boolean);
}

export function summarizeLobbyForInvites(phase, lobby) {
  const phaseText = text(phase);
  if (phaseText !== LOBBY_PHASE || !lobby) {
    return {
      inLobby: false,
      canInvite: false,
      phase: phaseText || null,
      localPuuid: '',
      memberPuuids: []
    };
  }

  const candidates = lobbyMemberCandidates(lobby);
  const localMember = lobby.localMember || null;
  const localPuuid = text(localMember?.puuid || lobby?.localMember?.puuid);
  const memberPuuids = unique(candidates.map((member) => member.puuid));
  const localCanInvite = typeof localMember?.canInvite === 'boolean' ? localMember.canInvite : true;

  return {
    inLobby: true,
    canInvite: localCanInvite,
    phase: phaseText,
    localPuuid,
    memberPuuids
  };
}

export async function getLobbyInviteStatus(lcu) {
  let phase = null;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    return {
      inLobby: false,
      canInvite: false,
      phase: null,
      localPuuid: '',
      memberPuuids: [],
      reason: 'League is not running.'
    };
  }

  if (text(phase) !== LOBBY_PHASE) {
    return summarizeLobbyForInvites(phase, null);
  }

  try {
    return summarizeLobbyForInvites(phase, await lcu.get('/lol-lobby/v2/lobby'));
  } catch {
    return {
      ...summarizeLobbyForInvites(phase, null),
      reason: 'No active lobby was found.'
    };
  }
}

function summonerIdFrom(value) {
  const id = value?.summonerId;
  if (id === undefined || id === null || text(id) === '') return '';
  return text(id);
}

function targetMatchesSummoner(target, summoner) {
  if (!summoner) return false;
  if (target.puuid && text(summoner.puuid).toLowerCase() === target.puuid.toLowerCase()) return true;
  const name = text(summoner.gameName);
  const tag = text(summoner.tagLine);
  return !!(target.gameName && target.tagLine
    && name.toLowerCase() === target.gameName.toLowerCase()
    && tag.toLowerCase() === target.tagLine.toLowerCase());
}

export async function resolveLobbyInviteSummoner(lcu, rawTarget) {
  const target = normalizeLobbyInviteTarget(rawTarget);
  if (!target.puuid && !target.riotId) {
    throw new Error('This friend does not have a PUUID or Riot ID to invite.');
  }

  let puuidError = null;
  if (target.puuid) {
    try {
      const summoner = await lcu.get(`/lol-summoner/v2/summoners/puuid/${encodeURIComponent(target.puuid)}`);
      if (summonerIdFrom(summoner)) return summoner;
    } catch (error) {
      puuidError = error;
    }
  }

  if (target.riotId) {
    const results = await lcu.post('/lol-summoner/v2/summoners/names', [target.riotId]);
    const summoners = Array.isArray(results) ? results : [];
    const summoner = summoners.find((item) => targetMatchesSummoner(target, item)) || summoners[0];
    if (summonerIdFrom(summoner)) return summoner;
  }

  if (puuidError) {
    throw new Error(`Could not resolve ${target.label} through the current League client: ${puuidError.message}`);
  }
  throw new Error(`Could not resolve ${target.label} to a League summoner ID.`);
}

export async function inviteTargetToLobby(lcu, rawTarget) {
  const target = normalizeLobbyInviteTarget(rawTarget);
  const lobbyStatus = await getLobbyInviteStatus(lcu);
  if (!lobbyStatus.inLobby) {
    throw new Error('Create or join a League lobby before inviting friends.');
  }
  if (!lobbyStatus.canInvite) {
    throw new Error('The current account cannot invite players from this lobby.');
  }
  if (target.puuid && lobbyStatus.localPuuid && target.puuid.toLowerCase() === lobbyStatus.localPuuid.toLowerCase()) {
    throw new Error('You cannot invite the currently logged-in account.');
  }
  if (target.puuid && lobbyStatus.memberPuuids.some((puuid) => puuid.toLowerCase() === target.puuid.toLowerCase())) {
    throw new Error(`${target.label} is already in the current lobby.`);
  }

  const summoner = await resolveLobbyInviteSummoner(lcu, target);
  const summonerId = summonerIdFrom(summoner);
  await lcu.post('/lol-lobby/v2/lobby/invitations', [{ toSummonerId: summonerId }]);
  return {
    ok: true,
    summonerId,
    puuid: text(summoner.puuid) || target.puuid,
    riotId: text(summoner.gameName) && text(summoner.tagLine)
      ? `${text(summoner.gameName)}#${text(summoner.tagLine)}`
      : target.label
  };
}
