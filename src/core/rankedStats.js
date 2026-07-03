// Fetch + parse the signed-in account's ranked standings from the LCU
// (`/lol-ranked/v1/current-ranked-stats`). The parse helpers are pure for unit testing.

const TIERS = new Set(['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER']);
// Apex tiers have no division (the LCU reports division 'NA').
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVISIONS = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

// One LCU queue entry -> stored shape, or null when unranked. Unranked shows up as tier ''
// (older clients) or 'NONE'/'UNRANKED' — anything outside the real tiers counts as unranked.
export function parseRankedQueue(entry) {
  const tier = String(entry?.tier ?? '').toUpperCase();
  if (!TIERS.has(tier)) return null;
  const division = APEX.has(tier) ? null : (DIVISIONS[String(entry.division ?? '').toUpperCase()] ?? null);
  return {
    tier,
    division,
    lp: Number(entry.leaguePoints) || 0,
    wins: Number(entry.wins) || 0,
    losses: Number(entry.losses) || 0
  };
}

// Full payload -> { solo, flex } (each null = unranked), or null when the payload is unusable.
// A null result means "no data yet, retry" — never store it as unranked.
export function parseRankedStats(payload) {
  const queues = Array.isArray(payload?.queues) ? payload.queues : [];
  const find = (type) => queues.find((q) => q?.queueType === type) ?? payload?.queueMap?.[type] ?? null;
  const solo = find('RANKED_SOLO_5x5');
  const flex = find('RANKED_FLEX_SR');
  if (!solo && !flex) return null;
  return { solo: parseRankedQueue(solo), flex: parseRankedQueue(flex) };
}

// null = client not ready (404 while plugins load) or empty payload; the caller retries.
// Connection errors propagate for the caller to catch.
export async function fetchCurrentRanks(lcuClient) {
  const payload = await lcuClient.get('/lol-ranked/v1/current-ranked-stats');
  return payload ? parseRankedStats(payload) : null;
}
