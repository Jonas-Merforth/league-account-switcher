// Porofessor (and op.gg) address regions by the LCU's webRegion code (euw, na, eune, …). Older
// clients may only expose the platform id, so map the common ones as a fallback.
const POROFESSOR_REGION_FALLBACK = {
  na1: 'na', euw1: 'euw', eun1: 'eune', kr: 'kr', br1: 'br', la1: 'lan', la2: 'las',
  oc1: 'oce', ru: 'ru', tr1: 'tr', jp1: 'jp', ph2: 'ph', sg2: 'sg', th2: 'th', tw2: 'tw',
  vn2: 'vn', me1: 'me'
};

export function resolvePorofessorRegion({ webRegion, region } = {}) {
  const web = String(webRegion || '').trim().toLowerCase();
  const raw = String(region || '').trim().toLowerCase();
  return web || POROFESSOR_REGION_FALLBACK[raw] || raw;
}

// Build a Porofessor live-game URL from a Riot ID, e.g. https://porofessor.gg/live/euw/Nueluclor-1553
export function buildPorofessorLiveUrl({ gameName, tagLine, region } = {}) {
  const name = String(gameName || '').trim();
  const tag = String(tagLine || '').trim();
  const reg = String(region || '').trim().toLowerCase();
  if (!name || !tag) {
    throw new Error('No Riot ID found for the signed-in account. Make sure League is signed in.');
  }
  if (!reg) {
    throw new Error('Could not determine the account region from the League client.');
  }
  return `https://porofessor.gg/live/${reg}/${encodeURIComponent(name)}-${encodeURIComponent(tag)}`;
}
