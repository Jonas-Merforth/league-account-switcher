function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function memberPuuids(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function isExplicitlyClosed(party = {}) {
  if (party.open === false) return true;
  const type = lower(party.partyType);
  return type === 'closed' || type === 'inviteonly' || type === 'invite-only';
}

function blockedLocalJoinView(lobbyStatus = {}) {
  if (lobbyStatus.busy) {
    return {
      visible: true,
      disabled: true,
      label: 'Switching',
      status: 'unavailable',
      title: 'Wait for the account switch to finish before joining a lobby.'
    };
  }

  const phase = text(lobbyStatus.phase);
  if (phase === 'None' || phase === 'Lobby' || phase === '') {
    if (phase || !lobbyStatus.reason) return null;
  }
  if (!phase) {
    return {
      visible: true,
      disabled: true,
      label: 'Unavailable',
      status: 'unavailable',
      title: lobbyStatus.reason || 'Start and sign in to League before joining a lobby.'
    };
  }
  if (phase === 'Matchmaking' || phase === 'ReadyCheck') {
    return {
      visible: true,
      disabled: true,
      label: 'In queue',
      status: 'unavailable',
      title: 'Leave queue before joining another lobby.'
    };
  }
  if (phase === 'ChampSelect') {
    return {
      visible: true,
      disabled: true,
      label: 'Champ select',
      status: 'unavailable',
      title: 'You cannot join another lobby from champ select.'
    };
  }
  if (phase === 'GameStart' || phase === 'InProgress' || phase === 'Reconnect') {
    return {
      visible: true,
      disabled: true,
      label: 'In game',
      status: 'unavailable',
      title: 'You cannot join another lobby while in game.'
    };
  }
  return {
    visible: true,
    disabled: true,
    label: 'Unavailable',
    status: 'unavailable',
    title: `You cannot join another lobby while League is in ${phase}.`
  };
}

export function isCurrentFriend(friend, lobbyStatus = {}, currentClient = {}) {
  const friendPuuid = lower(friend?.puuid);
  const localPuuid = lower(currentClient?.livePuuid || lobbyStatus?.localPuuid);
  if (friendPuuid && localPuuid && friendPuuid === localPuuid) return true;
  const friendRiotId = lower(friend?.riotId);
  const liveRiotId = lower(currentClient?.liveRiotId);
  return !!friendRiotId && liveRiotId.includes('#') && friendRiotId === liveRiotId;
}

export function friendLobbyParty(friend) {
  const kind = friend?.activity?.kind;
  return (kind === 'lobby' || kind === 'away') && friend.activity.party ? friend.activity.party : null;
}

export function friendJoinKey(friend) {
  const party = friendLobbyParty(friend);
  return text(party?.partyId || friend?.puuid || friend?.riotId || friend?.gameName);
}

export function friendJoinPayload(friend) {
  const party = friendLobbyParty(friend);
  if (!party?.partyId) return null;
  return {
    partyId: party.partyId,
    friendPuuid: text(friend?.puuid),
    riotId: text(friend?.riotId),
    party: {
      partyId: party.partyId,
      partyType: party.partyType || '',
      open: party.open,
      size: party.size,
      maxSize: party.maxSize,
      memberPuuids: memberPuuids(party.memberPuuids)
    }
  };
}

export function shouldConfirmLobbyJoin(payload, lobbyStatus = {}) {
  if (!payload?.partyId || !lobbyStatus?.inLobby) return false;
  if (text(lobbyStatus.partyId) === text(payload.partyId)) return false;
  return memberPuuids(lobbyStatus.memberPuuids).length > 1;
}

export function friendJoinView(friend, lobbyStatus = {}, joinStates = {}) {
  const party = friendLobbyParty(friend);
  if (!party?.partyId) return { visible: false };

  const key = friendJoinKey(friend);
  const state = joinStates[key] || {};
  const localPartyId = text(lobbyStatus.partyId);
  const localMembers = memberPuuids(lobbyStatus.memberPuuids).map((puuid) => puuid.toLowerCase());
  const friendPuuid = lower(friend?.puuid);

  if (state.status === 'pending') {
    return { visible: true, disabled: true, label: 'Joining', status: 'pending', title: 'Joining lobby...' };
  }
  if (state.status === 'joined') {
    return { visible: true, disabled: true, label: 'Joined', status: 'joined', title: 'Joined lobby.' };
  }
  if (localPartyId && localPartyId === text(party.partyId)) {
    return { visible: true, disabled: true, label: 'In lobby', status: 'in-lobby', title: 'You are already in this lobby.' };
  }
  if (friendPuuid && localMembers.includes(friendPuuid)) {
    return { visible: true, disabled: true, label: 'In lobby', status: 'in-lobby', title: 'This friend is already in your current lobby.' };
  }
  if (isExplicitlyClosed(party)) {
    return { visible: true, disabled: true, label: 'Closed', status: 'closed', title: 'This lobby is invite-only.' };
  }
  if (Number.isFinite(Number(party.size)) && Number.isFinite(Number(party.maxSize))
    && Number(party.maxSize) > 0 && Number(party.size) >= Number(party.maxSize)) {
    return { visible: true, disabled: true, label: 'Full', status: 'full', title: 'This lobby is full.' };
  }
  const localBlock = blockedLocalJoinView(lobbyStatus);
  if (localBlock) return localBlock;
  if (state.status === 'error') {
    return { visible: true, disabled: false, label: 'Retry', status: 'error', title: state.title || 'Could not join this lobby.' };
  }
  return { visible: true, disabled: false, label: 'Join', status: 'idle', title: `Join ${friend?.riotId || 'friend'}'s lobby` };
}
