import { clearLeagueHeaderIndicators } from './leagueHeaderClicks.js';
import { clearLeagueHeaderIndicatorsBackground } from './leagueBackgroundClicks.js';

// Layered live header clear: prefer the background PostMessage clicker (no focus steal, no
// cursor movement), and only fall back to the legacy foreground clicker when the background
// path reports failure. Dependencies are injectable for tests.
export function createLayeredHeaderClear({
  background = clearLeagueHeaderIndicatorsBackground,
  foreground = clearLeagueHeaderIndicators,
  log = () => {}
} = {}) {
  return async function clearHeaders(targets) {
    if (!targets?.collection && !targets?.tft && !targets?.tftStore) {
      return { collection: false, tft: false, tftStore: false, mode: null };
    }
    try {
      const cleared = await background(targets);
      return { ...cleared, mode: 'background' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Background header click failed (${message}); falling back to foreground click.`, 'warn');
      const cleared = await foreground(targets);
      return { ...cleared, mode: 'foreground' };
    }
  };
}
