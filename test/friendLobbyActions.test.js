import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendJoinPayload,
  friendJoinView,
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
    { visible: true, disabled: true, label: 'Failed', status: 'error', title: 'Rejected' }
  );
});

test('shouldConfirmLobbyJoin only prompts when leaving a multi-person current lobby', () => {
  const payload = friendJoinPayload(lobbyFriend());
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: false, memberPuuids: [] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'solo', memberPuuids: ['self'] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'party-open-1', memberPuuids: ['self', 'friend'] }), false);
  assert.equal(shouldConfirmLobbyJoin(payload, { inLobby: true, partyId: 'other-party', memberPuuids: ['self', 'friend'] }), true);
});
