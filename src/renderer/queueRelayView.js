export function queueRelayButtonView(status = {}) {
  if (status.requestPending) {
    return { disabled: true, label: 'Starting…', detail: 'Waiting for the leader\'s Account Switcher.', tone: 'pending' };
  }
  if (!status.connected) {
    return { disabled: true, label: 'Start via leader', detail: status.reason || 'Queue relay is connecting.', tone: 'offline' };
  }
  const lobby = status.lobby || {};
  if (!lobby.inLobby) {
    return { disabled: true, label: 'Start via leader', detail: 'Join a League lobby to use queue relay.', tone: 'offline' };
  }
  if (lobby.localIsLeader) {
    return {
      disabled: true,
      label: 'Start via leader',
      detail: status.enabled
        ? 'Queue Relay is on. Lobby members using Account Switcher can start your queue.'
        : 'Queue Relay is off. Turn it on to let lobby members start your queue.',
      tone: status.enabled ? 'online' : 'offline'
    };
  }
  const leader = status.leader || {};
  if (!leader.detected) {
    return { disabled: true, label: 'Start via leader', detail: 'The lobby leader\'s Queue Relay was not detected.', tone: 'offline' };
  }
  if (!leader.enabled) {
    return { disabled: true, label: 'Start via leader', detail: 'The lobby leader\'s Queue Relay is off.', tone: 'pending' };
  }
  return { disabled: false, label: 'Start via leader', detail: `Ready through ${leader.riotId || 'the lobby leader'}.`, tone: 'online' };
}
