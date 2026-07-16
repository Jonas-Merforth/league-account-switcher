import { clearLeagueHeaderIndicatorsBackground } from './leagueBackgroundClicks.js';

// Live header clears must stay in the background: never activate the client or move the real
// cursor when the background PostMessage path reports a failure. Dependencies are injectable
// for tests.
export function createLayeredHeaderClear({
  background = clearLeagueHeaderIndicatorsBackground,
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
      log(`Background header click failed (${message}); no foreground click was attempted.`, 'warn');
      throw error;
    }
  };
}
