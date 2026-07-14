const FRIEND_STATE_LABELS = {
  chat: 'Online',
  online: 'Online',
  away: 'Away',
  mobile: 'On mobile',
  dnd: 'In game'
};

export function isMobileFriend(friend) {
  return String(friend?.state || '').toLowerCase() === 'mobile';
}

export function friendStateText(friend = {}, now = Date.now()) {
  const activity = friend.activity;
  if (activity) {
    if (activity.kind === 'inGame') {
      return ['In game', activity.queueLabel, activity.championName, friendActivityDuration(activity, now)]
        .filter(Boolean)
        .join(' · ');
    }
    if (activity.kind === 'lobby') {
      const queue = activity.queueLabel || 'Game';
      return `${queue} lobby`;
    }
    if (activity.kind === 'champSelect') {
      return ['Champ select', activity.queueLabel].filter(Boolean).join(' · ');
    }
    if (activity.kind === 'queue') {
      return ['In queue', activity.queueLabel].filter(Boolean).join(' · ');
    }
    if (activity.label) return activity.label;
  }
  if (!friend.online) return 'Offline';
  const key = String(friend.state || '').toLowerCase();
  const base = FRIEND_STATE_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Online');
  const queue = friend.queue && key === 'dnd' ? ` · ${friend.queue}` : '';
  return `${base}${queue}`;
}

export function friendActivityTooltip(friend = {}, now = Date.now()) {
  const activity = friend.activity;
  const awayLobby = activity?.kind === 'away' && activity.party;
  if (!activity || (!awayLobby && !['inGame', 'lobby', 'champSelect', 'queue'].includes(activity.kind))) return '';
  const lines = [activity.label || friendStateText(friend, now)];
  if (activity.kind === 'lobby' || awayLobby) {
    const size = partySizeText(activity.party);
    const queue = activity.queueLabel || 'Game';
    lines.push(`Lobby: ${size ? `${size} ` : ''}${queue}`);
  } else if (activity.queueLabel) {
    lines.push(`Game: ${activity.queueLabel}`);
  }
  if (activity.championName) lines.push(`Champion: ${activity.championName}`);
  const duration = friendActivityDuration(activity, now);
  if (duration) lines.push(`Duration: ${duration}`);
  if (activity.sameGameFriendNames?.length) {
    lines.push(`Same game: ${activity.sameGameFriendNames.join(', ')}`);
  }
  const party = partyMembersText(activity.party);
  if (party) lines.push(`Party: ${party}`);
  if (activity.spectatable) lines.push('Spectatable');
  if (activity.gameStatus) lines.push(`Status: ${activity.gameStatus}`);
  return lines.join('\n');
}

export function playingWithFriends(friend = {}) {
  const activity = friend.activity;
  return [...new Set([
    ...(activity?.sameGameFriendNames || []),
    ...(activity?.party?.playingWithNames || [])
  ])];
}

export function partySizeText(party) {
  if (!party) return '';
  if (party.size && party.maxSize) return `${party.size}/${party.maxSize}`;
  if (party.size) return String(party.size);
  return '';
}

export function friendLobbyOccupancy(friend) {
  const activity = friend?.activity;
  if (!activity?.party || !['lobby', 'away'].includes(activity.kind)) return '';
  return partySizeText(activity.party);
}

export function partyMembersText(party) {
  if (!party) return '';
  const names = [...(party.playingWithNames || party.memberNames || [])];
  if (party.unknownCount) names.push(`${party.unknownCount} unknown`);
  return names.join(', ');
}

export function friendActivityDuration(activity, now = Date.now()) {
  const started = Date.parse(activity?.startedAt || '');
  if (!Number.isFinite(started)) return '';
  const totalMinutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (totalMinutes < 1) return 'just started';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
