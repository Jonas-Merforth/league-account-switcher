export const IN_GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
export const POST_GAME_PHASES = new Set(['WaitingForStats', 'PreEndOfGame', 'EndOfGame']);

export function gameWatcherTransition(wasInGame, phase) {
  const normalizedPhase = typeof phase === 'string' ? phase.trim() : '';
  if (!normalizedPhase) {
    return {
      known: false,
      inGame: Boolean(wasInGame),
      started: false,
      ended: false
    };
  }
  const inGame = IN_GAME_PHASES.has(normalizedPhase);
  return {
    known: true,
    inGame,
    started: inGame && !wasInGame,
    ended: !inGame && wasInGame
  };
}

export function settingsBaselineCaptureDisposition(leagueRunning, phase) {
  if (!leagueRunning) return 'client-closed';
  const normalizedPhase = typeof phase === 'string' ? phase.trim() : '';
  if (!normalizedPhase) return 'unknown';
  if (IN_GAME_PHASES.has(normalizedPhase)) return 'in-game';
  if (POST_GAME_PHASES.has(normalizedPhase)) return 'post-game';
  return 'safe';
}
