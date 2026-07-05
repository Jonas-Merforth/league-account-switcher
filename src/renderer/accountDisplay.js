export function gameNameOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const tagIndex = text.lastIndexOf('#');
  return tagIndex > 0 ? text.slice(0, tagIndex).trim() : text;
}

export function accountSubtitle(account = {}) {
  const gameName = gameNameOnly(account.lastSummonerName);
  const username = String(account.username || '').trim();
  if (gameName && username && gameName.toLowerCase() !== username.toLowerCase()) {
    return `${gameName} | ${username}`;
  }
  return gameName || username;
}
