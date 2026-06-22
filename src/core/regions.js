// All League of Legends / Riot regions. `code` is the short web code we store on each account
// (compatible with Porofessor/op.gg); `platformId` is the LCU platform id; `porofessor` is the
// Porofessor live-game path segment, should a "live game" link ever be added.
export const REGIONS = [
  { code: 'euw', label: 'EUW — Europe West', platformId: 'euw1', porofessor: 'euw' },
  { code: 'eune', label: 'EUNE — Europe Nordic & East', platformId: 'eun1', porofessor: 'eune' },
  { code: 'na', label: 'NA — North America', platformId: 'na1', porofessor: 'na' },
  { code: 'kr', label: 'KR — Korea', platformId: 'kr', porofessor: 'kr' },
  { code: 'br', label: 'BR — Brazil', platformId: 'br1', porofessor: 'br' },
  { code: 'lan', label: 'LAN — Latin America North', platformId: 'la1', porofessor: 'lan' },
  { code: 'las', label: 'LAS — Latin America South', platformId: 'la2', porofessor: 'las' },
  { code: 'oce', label: 'OCE — Oceania', platformId: 'oc1', porofessor: 'oce' },
  { code: 'tr', label: 'TR — Türkiye', platformId: 'tr1', porofessor: 'tr' },
  { code: 'ru', label: 'RU — Russia', platformId: 'ru', porofessor: 'ru' },
  { code: 'jp', label: 'JP — Japan', platformId: 'jp1', porofessor: 'jp' },
  { code: 'ph', label: 'PH — Philippines', platformId: 'ph2', porofessor: 'ph' },
  { code: 'sg', label: 'SG — Singapore', platformId: 'sg2', porofessor: 'sg' },
  { code: 'th', label: 'TH — Thailand', platformId: 'th2', porofessor: 'th' },
  { code: 'tw', label: 'TW — Taiwan', platformId: 'tw2', porofessor: 'tw' },
  { code: 'vn', label: 'VN — Vietnam', platformId: 'vn2', porofessor: 'vn' },
  { code: 'me', label: 'ME — Middle East', platformId: 'me1', porofessor: 'me' }
];

export const DEFAULT_REGION = 'euw';

const REGION_CODES = new Set(REGIONS.map((region) => region.code));

// Normalize arbitrary region input (e.g. a legacy "EUW1" or "EUW") to a known web code, or '' .
export function normalizeRegionCode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (REGION_CODES.has(raw)) return raw;
  const byPlatform = REGIONS.find((region) => region.platformId === raw);
  if (byPlatform) return byPlatform.code;
  return raw; // unknown but keep it so we never silently drop a user's value
}

export function regionLabel(code) {
  const region = REGIONS.find((item) => item.code === normalizeRegionCode(code));
  return region ? region.label : (code ? String(code).toUpperCase() : '');
}
