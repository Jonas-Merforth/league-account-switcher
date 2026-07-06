const LOBBY_PHASE = 'Lobby';
const SAFE_JOIN_PHASES = new Set(['', 'None', LOBBY_PHASE]);

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

function lobbyPartyId(lobby) {
  return text(lobby?.partyId || lobby?.currentParty?.partyId);
}

export function summarizeLobbyForInvites(phase, lobby) {
  const phaseText = text(phase);
  if (phaseText !== LOBBY_PHASE || !lobby) {
    return {
      inLobby: false,
      canInvite: false,
      phase: phaseText || null,
      partyId: '',
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
    partyId: lobbyPartyId(lobby),
    localPuuid,
    memberPuuids,
    memberCount: memberPuuids.length,
    partyType: text(lobby?.partyType || lobby?.currentParty?.partyType)
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
      partyId: '',
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

export async function leaveCurrentLobby(lcu) {
  let phase = null;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    return {
      left: false,
      phase: null,
      reason: 'League is not running.'
    };
  }

  const phaseText = text(phase);
  if (phaseText !== LOBBY_PHASE) {
    return {
      left: false,
      phase: phaseText || null,
      reason: 'Not in a League lobby.'
    };
  }

  await lcu.delete('/lol-lobby/v2/lobby');
  return {
    left: true,
    phase: phaseText
  };
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

export function normalizeJoinLobbyTarget(input = {}) {
  const partyId = text(input.partyId);
  const party = input.party && typeof input.party === 'object' ? input.party : {};
  const memberPuuids = Array.isArray(input.memberPuuids)
    ? unique(input.memberPuuids)
    : Array.isArray(party.memberPuuids)
      ? unique(party.memberPuuids)
      : [];
  const size = Number(input.size ?? party.size);
  const maxSize = Number(input.maxSize ?? party.maxSize);
  return {
    partyId,
    friendPuuid: text(input.friendPuuid || input.puuid),
    riotId: text(input.riotId),
    open: typeof input.open === 'boolean' ? input.open : party.open,
    partyType: text(input.partyType || party.partyType),
    size: Number.isFinite(size) ? size : null,
    maxSize: Number.isFinite(maxSize) ? maxSize : null,
    memberPuuids
  };
}

function isExplicitlyClosedParty(target) {
  if (target.open === false) return true;
  const partyType = target.partyType.toLowerCase();
  return partyType === 'closed' || partyType === 'inviteonly' || partyType === 'invite-only';
}

function unsafeJoinPhaseMessage(phase) {
  const phaseText = text(phase) || 'Unknown';
  if (SAFE_JOIN_PHASES.has(phaseText)) return '';
  if (phaseText === 'Matchmaking' || phaseText === 'ReadyCheck') return 'Leave queue before joining another lobby.';
  if (phaseText === 'ChampSelect') return 'You cannot join another lobby from champ select.';
  if (phaseText === 'GameStart' || phaseText === 'InProgress' || phaseText === 'Reconnect') {
    return 'You cannot join another lobby while in game.';
  }
  return `You cannot join another lobby while League is in ${phaseText}.`;
}

export async function joinFriendLobby(lcu, rawTarget) {
  const target = normalizeJoinLobbyTarget(rawTarget);
  if (!target.partyId) throw new Error('This friend lobby does not expose a party ID to join.');
  if (isExplicitlyClosedParty(target)) throw new Error('This lobby is invite-only.');
  if (target.size !== null && target.maxSize !== null && target.maxSize > 0 && target.size >= target.maxSize) {
    throw new Error('This lobby is full.');
  }

  let phase;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    throw new Error('League is not running. Start and sign in to League first.');
  }
  const unsafeMessage = unsafeJoinPhaseMessage(phase);
  if (unsafeMessage) throw new Error(unsafeMessage);

  const lobbyStatus = await getLobbyInviteStatus(lcu);
  if (lobbyStatus.partyId && lobbyStatus.partyId === target.partyId) {
    throw new Error('You are already in this lobby.');
  }
  if (target.friendPuuid && lobbyStatus.memberPuuids.some((puuid) => puuid.toLowerCase() === target.friendPuuid.toLowerCase())) {
    throw new Error(`${target.riotId || 'This friend'} is already in your current lobby.`);
  }

  await lcu.post(`/lol-lobby/v2/party/${encodeURIComponent(target.partyId)}/join`);
  return {
    ok: true,
    partyId: target.partyId,
    riotId: target.riotId,
    friendPuuid: target.friendPuuid
  };
}
