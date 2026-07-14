function text(value) {
  return String(value ?? '').trim();
}

export function normalizeFavoriteFriendKeys(keys = []) {
  if (keys instanceof Set) return keys;
  return new Set(
    (Array.isArray(keys) ? keys : [])
      .map(text)
      .filter(Boolean)
  );
}

export function friendFavoriteKey(friend = {}) {
  const puuid = text(friend.puuid).toLowerCase();
  if (puuid) return `puuid:${puuid}`;
  const riotId = text(friend.riotId).toLowerCase();
  if (riotId) return `riot:${riotId}`;
  return '';
}

export function isFavoriteFriend(friend, favoriteKeys = []) {
  const key = friendFavoriteKey(friend);
  return Boolean(key && normalizeFavoriteFriendKeys(favoriteKeys).has(key));
}

function isMobileFriend(friend) {
  return String(friend?.state || '').toLowerCase() === 'mobile';
}

function favoriteDisplayRank(friend, favoriteKeys) {
  const favorite = isFavoriteFriend(friend, favoriteKeys);
  if (friend?.online && !isMobileFriend(friend)) return favorite ? 0 : 1;
  if (isMobileFriend(friend)) return favorite ? 2 : 3;
  return favorite ? 4 : 5;
}

export function sortFriendsForFavorites(friends = [], favoriteKeys = []) {
  const normalizedKeys = normalizeFavoriteFriendKeys(favoriteKeys);
  const items = [...friends].map((friend, index) => ({
    friend,
    index,
    rank: favoriteDisplayRank(friend, normalizedKeys)
  }));
  const sameGameAnchors = new Map();
  for (const item of items) {
    const activity = item.friend?.activity;
    const gameId = activity?.kind === 'inGame' ? text(activity.gameId) : '';
    if (!gameId) continue;
    const key = `${item.rank}:${gameId}`;
    if (!sameGameAnchors.has(key)) sameGameAnchors.set(key, item.index);
  }
  const groupAnchor = (item) => {
    const activity = item.friend?.activity;
    const gameId = activity?.kind === 'inGame' ? text(activity.gameId) : '';
    return gameId ? sameGameAnchors.get(`${item.rank}:${gameId}`) ?? item.index : item.index;
  };

  return items
    .sort((a, b) => {
      const rankDelta = a.rank - b.rank;
      if (rankDelta) return rankDelta;
      const groupDelta = groupAnchor(a) - groupAnchor(b);
      return groupDelta || a.index - b.index;
    })
    .map((item) => item.friend);
}
