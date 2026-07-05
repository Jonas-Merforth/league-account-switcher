// Fetch + normalize the signed-in League identity from the LCU.

export function parseSummonerIdentity(payload) {
  const gameName = String(payload?.gameName ?? payload?.game_name ?? '').trim();
  const tagLine = String(payload?.tagLine ?? payload?.tag_line ?? '').trim();
  if (!gameName) return null;
  return { gameName, tagLine: tagLine || null };
}

export async function fetchCurrentSummonerIdentity(lcuClient) {
  const payload = await lcuClient.get('/lol-summoner/v1/current-summoner');
  return payload ? parseSummonerIdentity(payload) : null;
}
