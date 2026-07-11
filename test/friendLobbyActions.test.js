import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendJoinPayload,
  friendJoinView,
  isCurrentFriend,
  shouldConfirmLobbyJoin
} from '../src/renderer/friendLobbyActions.js';

function lobbyFriend(party = {}) {
  return {
    puuid: 'friend-puuid',
    riotId: 'Lobby Friend#EUW',
    activity: {
      kind: 'lobby',
      party: {
        partyId: 'party-open-1',
        size: 2,
        maxSize: 5,
        memberPuuids: ['friend-puuid', 'other-puuid'],
        ...party
      }
    }
  };
}

test('friendJoinPayload builds a join request from lobby activity', () => {
  assert.deepEqual(friendJoinPayload(lobbyFriend()), {
    partyId: 'party-open-1',
    friendPuuid: 'friend-puuid',
    riotId: 'Lobby Friend#EUW',
    party: {
      partyId: 'party-open-1',
      partyType: '',
      open: undefined,
      size: 2,
      maxSize: 5,
      memberPuuids: ['friend-puuid', 'other-puuid']
    }
  });
});

test('friendJoinView enables unknown-open lobbies and disables known blocked states', () => {
  assert.deepEqual(
    friendJoinView(lobbyFriend(), {}, {}).label,
    'Join'
  );
  assert.deepEqual(
    friendJoinView(lobbyFriend({ partyType: 'closed', open: false }), {}, {}).label,
    'Closed'
  );
  assert.deepEqual(
    friendJoinView(lobbyFriend({ size: 5, maxSize: 5 }), {}, {}).label,
    'Full'
  );
  assert.deepEqual(
    friendJoinView(lobbyFriend(), { partyId: 'party-open-1', memberPuuids: ['self'] }, {}).label,
    'In lobby'
  );
  assert.deepEqual(
    friendJoinView(lobbyFriend(), {}, { 'party-open-1': { status: 'error', title: 'Rejected' } }),
    { visible: true, disabled: false, label: 'Retry', status: 'error', title: 'Rejected' }
  );
});

test('away friends keep their visible status and can expose an open lobby join', () => {
  const friend = lobbyFriend({ partyType: 'open', open: true });
  friend.activity.kind = 'away';

  assert.equal(friend.activity.kind, 'away');
  assert.deepEqual(friendJoinView(friend, { phase: 'None' }, {}), {
    visible: true,
    disabled: false,
    label: 'Join',
    status: 'idle',
    title: "Join Lobby Friend#EUW's lobby"
  });
  assert.equal(friendJoinPayload(friend).partyId, 'party-open-1');

  friend.activity.kind = 'inGame';
  assert.equal(friendJoinView(friend, { phase: 'None' }, {}).visible, false);
});

test('friendJoinView disables joins that the local League state will reject', () => {
  for (const [phase, label] of [
    ['Matchmaking', 'In queue'],
    ['ReadyCheck', 'In queue'],
    ['ChampSelect', 'Champ select'],
    ['GameStart', 'In game'],
    ['InProgress', 'In game'],
    ['Reconnect', 'In game'],
    ['EndOfGame', 'Unavailable']
  ]) {
    const view = friendJoinView(lobbyFriend(), { phase }, {});
    assert.equal(view.disabled, true, phase);
    assert.equal(view.label, label, phase);
  }
  assert.equal(friendJoinView(lobbyFriend(), { busy: true, phase: 'None' }, {}).label, 'Switching');
  assert.equal(friendJoinView(lobbyFriend(), { phase: null, reason: 'League is not running.' }, {}).label, 'Unavailable');
  assert.equal(friendJoinView(lobbyFriend(), { phase: 'None' }, {}).disabled, false);
  assert.equal(friendJoinView(lobbyFriend(), { phase: 'Lobby' }, {}).disabled, false);
});

test('isCurrentFriend uses the live summoner before the lobby fallback', () => {
  const friend = { puuid: 'CURRENT-PUUID' };
  assert.equal(isCurrentFriend(friend, { localPuuid: '' }, { livePuuid: 'current-puuid' }), true);
  assert.equal(isCurrentFriend(friend, { localPuuid: 'current-puuid' }, {}), true);
  assert.equal(isCurrentFriend(friend, { localPuuid: 'other' }, { livePuuid: 'other' }), false);
  assert.equal(isCurrentFriend({ riotId: 'Haschbruder#DRUGS' }, {}, { liveRiotId: 'haschbruder#drugs' }), true);
  assert.equal(isCurrentFriend({ riotId: 'Haschbruder#OTHER' }, {}, { liveRiotId: 'haschbruder#drugs' }), false);
});

test('shouldConfirmLobbyJoin only prompts when leaving a multi-person current lobby', () => {
  const payload = friendJoinPayload(lobbyFriend());
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: false, memberPuuids: [] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'solo', memberPuuids: ['self'] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'party-open-1', memberPuuids: ['self', 'friend'] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'other-party', memberPuuids: ['self', 'friend'] }), true);
});
