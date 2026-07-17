export const CLIENT_CLEANUP_DEFAULT_HINT =
  'API-only cleanup; dots already on screen need Deep-clean visible dots';

export function clientCleanupTftVisibleNote(result, { deep = false } = {}) {
  const liveReasons = Array.isArray(result?.tftLiveClearReasons)
    ? result.tftLiveClearReasons
    : [];
  if (liveReasons.length && !result?.uiNavigation?.visitsSent?.tft && !deep) {
    return 'A rendered TFT dot is still visible now; use Deep-clean visible dots.';
  }
  return '';
}
