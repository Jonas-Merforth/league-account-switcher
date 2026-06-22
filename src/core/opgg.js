// Build an OP.GG summoner-profile URL from a Riot ID, e.g.
// https://op.gg/lol/summoners/euw/Azir%20to%20Plat-EUW
// gameName and tagLine are percent-encoded so spaces and any special characters survive.
export function buildOpggProfileUrl({ gameName, tagLine, region } = {}) {
  const name = String(gameName || '').trim();
  const tag = String(tagLine || '').trim();
  const reg = String(region || '').trim().toLowerCase();
  if (!name || !tag) {
    throw new Error('No Riot ID found for the signed-in account. Make sure League is signed in.');
  }
  if (!reg) {
    throw new Error('Could not determine the account region from the League client.');
  }
  return `https://op.gg/lol/summoners/${reg}/${encodeURIComponent(name)}-${encodeURIComponent(tag)}`;
}
