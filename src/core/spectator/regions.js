import { REGIONS } from '../regions.js';

const platforms = new Map(REGIONS.map(({ code, platformId }) => [code.toUpperCase(), platformId.toUpperCase()]));

export function normalizePlatformId(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return platforms.get(normalized) ?? normalized;
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

