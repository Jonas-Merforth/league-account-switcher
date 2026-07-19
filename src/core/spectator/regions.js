const PLATFORM_BY_REGION = Object.freeze({
  BR: 'BR1',
  EUNE: 'EUN1',
  EUW: 'EUW1',
  JP: 'JP1',
  KR: 'KR',
  LAN: 'LA1',
  LAS: 'LA2',
  ME: 'ME1',
  NA: 'NA1',
  OCE: 'OC1',
  PH: 'PH2',
  RU: 'RU',
  SG: 'SG2',
  TH: 'TH2',
  TR: 'TR1',
  TW: 'TW2',
  VN: 'VN2'
});

const KNOWN_PLATFORMS = new Set(Object.values(PLATFORM_BY_REGION));

export function normalizePlatformId(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return '';
  if (KNOWN_PLATFORMS.has(normalized)) return normalized;
  return PLATFORM_BY_REGION[normalized] ?? normalized;
}

export function platformFromRegionLocale(regionLocale) {
  return normalizePlatformId(
    regionLocale?.platformId
      ?? regionLocale?.platform_id
      ?? regionLocale?.webRegion
      ?? regionLocale?.region
  );
}

export function observerHost(platformId) {
  const platform = normalizePlatformId(platformId);
  if (!platform) throw new Error('A League platform id is required.');
  return `spectator.${platform.toLowerCase()}.lol.pvp.net`;
}

