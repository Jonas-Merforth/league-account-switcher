const PHASE_STATUS = {
  Lobby: { label: 'In lobby', tone: 'online' },
  Matchmaking: { label: 'In queue', tone: 'online' },
  ReadyCheck: { label: 'Ready check', tone: 'online' },
  ChampSelect: { label: 'Champ select', tone: 'ingame' },
  GameStart: { label: 'In game', tone: 'ingame' },
  InProgress: { label: 'In game', tone: 'ingame' },
  Reconnect: { label: 'Reconnecting', tone: 'ingame' },
  WaitingForStats: { label: 'Post-game screen', tone: 'ingame' },
  PreEndOfGame: { label: 'Post-game screen', tone: 'ingame' },
  EndOfGame: { label: 'Post-game screen', tone: 'ingame' },
  WatchInProgress: { label: 'Spectating', tone: 'ingame' },
  CheckingForUpdates: { label: 'Checking for updates', tone: 'pending' },
  Patch: { label: 'Patching League', tone: 'pending' }
};

export function chatPresenceView(availability) {
  const value = String(availability || '').toLowerCase();
  if (value === 'offline') return { label: 'Appearing offline', tone: 'offline' };
  if (value === 'away') return { label: 'Away', tone: 'away' };
  if (value === 'mobile') return { label: 'On mobile', tone: 'mobile' };
  return { label: 'Online', tone: 'online' };
}

export function gameflowStatusView(phase, availability) {
  const presence = chatPresenceView(availability);
  if (!phase || phase === 'None') return presence;
  return PHASE_STATUS[phase] || {
    label: String(phase).replace(/([a-z])([A-Z])/g, '$1 $2'),
    tone: 'online'
  };
}

// Pure display model for the Friends-tab current-account strip. The main process gathers the live
// Riot/LCU values; this function keeps all closed/login/startup/gameflow distinctions deterministic.
export function buildCurrentClientSummary({
  switchStatus = null,
  riotRunning = false,
  riotAuthType = null,
  leagueRunning = false,
  leaguePhase = null,
  chatAvailability = null,
  accountId = null,
  liveName = '',
  liveRiotId = ''
} = {}) {
  if (switchStatus?.busy) {
    return {
      kind: 'switching',
      accountId: switchStatus.id || accountId,
      liveName: switchStatus.label || liveName,
      liveRiotId,
      statusLabel: 'Switching account',
      detail: switchStatus.message || 'Preparing Riot Client…',
      presenceLabel: '',
      tone: 'pending',
      phase: null
    };
  }

  if (!riotRunning) {
    return {
      kind: 'closed', accountId: null, liveName: '', liveRiotId: '',
      statusLabel: 'All clients closed',
      detail: 'Riot Client and League are not running',
      presenceLabel: '', tone: 'offline', phase: null
    };
  }

  if (riotAuthType === 'needs_authentication') {
    return {
      kind: 'signed-out', accountId: null, liveName: '', liveRiotId: '',
      statusLabel: 'Signed out', detail: 'Riot Client is open · Login required',
      presenceLabel: '', tone: 'offline', phase: null
    };
  }

  if (!riotAuthType || riotAuthType === 'unknown' || riotAuthType === 'ECONNREFUSED') {
    return {
      kind: 'riot-starting', accountId, liveName, liveRiotId,
      statusLabel: 'Riot Client starting', detail: 'Connecting to Riot services…',
      presenceLabel: '', tone: 'pending', phase: null
    };
  }

  if (!leagueRunning) {
    return {
      kind: 'riot-only', accountId, liveName, liveRiotId,
      statusLabel: 'Logged in', detail: 'Riot Client open · League closed',
      presenceLabel: '', tone: 'online', phase: null
    };
  }

  if (!leaguePhase) {
    return {
      kind: 'league-starting', accountId, liveName, liveRiotId,
      statusLabel: 'League Client starting', detail: 'Waiting for the League client…',
      presenceLabel: '', tone: 'pending', phase: null
    };
  }

  const presence = chatPresenceView(chatAvailability);
  const gameflow = gameflowStatusView(leaguePhase, chatAvailability);
  return {
    kind: 'league', accountId, liveName, liveRiotId,
    statusLabel: gameflow.label,
    detail: leaguePhase === 'None' ? 'League Client connected' : `League Client · ${presence.label}`,
    presenceLabel: presence.label,
    tone: gameflow.tone,
    phase: leaguePhase
  };
}
