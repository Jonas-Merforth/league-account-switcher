const IN_GAME_ACTIVITY_KINDS = new Set(['inGame', 'champSelect']);

export function friendPresenceTone(friend = {}) {
  if (!friend?.online) return 'offline';

  const state = String(friend.state || '').toLowerCase();
  const kind = String(friend.activity?.kind || '');

  if (IN_GAME_ACTIVITY_KINDS.has(kind) || state === 'dnd') return 'ingame';
  if (kind === 'away' || state === 'away') return 'away';
  if (kind === 'mobile' || state === 'mobile') return 'mobile';
  return 'online';
}
