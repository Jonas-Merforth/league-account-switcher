export const IN_GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);

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
