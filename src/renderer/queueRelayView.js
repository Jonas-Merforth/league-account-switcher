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
    return { disabled: true, label: 'Start via leader', detail: 'You are the lobby leader. Allow detected friends below if they may start your queue.', tone: 'online' };
  }
  const leader = status.leader || {};
  if (!leader.detected) {
    return { disabled: true, label: 'Start via leader', detail: 'The lobby leader\'s beta tool was not detected.', tone: 'offline' };
  }
  if (!leader.allowed) {
    return { disabled: true, label: 'Start via leader', detail: 'Leader tool detected. The leader must allow requests from you.', tone: 'pending' };
  }
  return { disabled: false, label: 'Start via leader', detail: `Ready through ${leader.riotId || 'the lobby leader'}.`, tone: 'online' };
}
