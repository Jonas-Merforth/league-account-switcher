function clean(value) {
  return String(value || '').trim();
}

export function formatRiotId(gameName, tagLine = '') {
  const game = clean(gameName);
  const tag = clean(tagLine);
  if (!game) return '';
  return tag ? `${game}#${tag}` : game;
}

export function parseRiotIdentity(value) {
  const text = clean(value);
  if (!text) {
    return { gameName: '', tagLine: '', normalizedGameName: '', normalizedTagLine: '' };
  }
  const separator = text.lastIndexOf('#');
  const gameName = clean(separator > 0 ? text.slice(0, separator) : text);
  const tagLine = clean(separator > 0 ? text.slice(separator + 1) : '');
  return {
    gameName,
    tagLine,
    normalizedGameName: gameName.toLowerCase(),
    normalizedTagLine: tagLine.toLowerCase()
  };
}

// Legacy account records contain only the game name. They can still be compared safely while there
// is a single matching saved account; when both sides have tags, the complete Riot ID must match.
export function sameRiotIdentity(left, right) {
  const a = parseRiotIdentity(left);
  const b = parseRiotIdentity(right);
  if (!a.normalizedGameName || a.normalizedGameName !== b.normalizedGameName) return false;
  if (a.normalizedTagLine && b.normalizedTagLine) {
    return a.normalizedTagLine === b.normalizedTagLine;
  }
  return true;
}

export function findAccountByRiotIdentity(accounts, liveIdentity) {
  const live = parseRiotIdentity(liveIdentity);
  if (!live.normalizedGameName || !Array.isArray(accounts)) return null;

  const gameNameMatches = accounts.filter((account) =>
    parseRiotIdentity(account?.lastSummonerName).normalizedGameName === live.normalizedGameName);

  if (live.normalizedTagLine) {
    const exact = gameNameMatches.filter((account) => {
      const stored = parseRiotIdentity(account?.lastSummonerName);
      return stored.normalizedTagLine === live.normalizedTagLine;
    });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;

    // A single old game-name-only record can be migrated. If another account already shares the
    // game name, guessing which tag the legacy record belongs to would risk cross-account writes.
    const legacy = gameNameMatches.filter((account) =>
      !parseRiotIdentity(account?.lastSummonerName).normalizedTagLine);
    return gameNameMatches.length === 1 && legacy.length === 1 ? legacy[0] : null;
  }

  return gameNameMatches.length === 1 ? gameNameMatches[0] : null;
}
