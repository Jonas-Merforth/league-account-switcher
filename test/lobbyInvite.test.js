import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inviteTargetToLobby,
  joinFriendLobby,
  leaveCurrentLobby,
  normalizeLobbyInviteTarget,
  summarizeLobbyForInvites
} from '../src/core/lobbyInvite.js';

test('normalizeLobbyInviteTarget parses Riot ID fallback data', () => {
  assert.deepEqual(
    normalizeLobbyInviteTarget({ puuid: ' friend-puuid ', riotId: 'Lobby Friend#EUW' }),
    {
      puuid: 'friend-puuid',
      gameName: 'Lobby Friend',
      tagLine: 'EUW',
      riotId: 'Lobby Friend#EUW',
      label: 'Lobby Friend#EUW'
    }
  );
});

test('summarizeLobbyForInvites only marks real lobby phase as inviteable', () => {
  assert.equal(summarizeLobbyForInvites('None', null).inLobby, false);

  const status = summarizeLobbyForInvites('Lobby', {
    localMember: { puuid: 'self-puuid', canInvite: true },
    members: [{ puuid: 'self-puuid' }, { puuid: 'friend-puuid' }]
  });

  assert.equal(status.inLobby, true);
  assert.equal(status.canInvite, true);
  assert.equal(status.localPuuid, 'self-puuid');
  assert.deepEqual(status.memberPuuids, ['self-puuid', 'friend-puuid']);
});

test('inviteTargetToLobby resolves PUUID and posts summoner-id invitation', async () => {
  const calls = [];
  const lcu = {
    async get(endpoint) {
      calls.push(['GET', endpoint]);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'Lobby';
      if (endpoint === '/lol-lobby/v2/lobby') {
        return { localMember: { puuid: 'self-puuid', canInvite: true }, members: [{ puuid: 'self-puuid' }] };
      }
      if (endpoint === '/lol-summoner/v2/summoners/puuid/friend-puuid') {
        return { summonerId: 123456789, puuid: 'friend-puuid', gameName: 'Lobby Friend', tagLine: 'EUW' };
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post(endpoint, body) {
      calls.push(['POST', endpoint, body]);
      return null;
    }
  };

  const result = await inviteTargetToLobby(lcu, { puuid: 'friend-puuid', riotId: 'Lobby Friend#EUW' });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.find((call) => call[0] === 'POST'),
    ['POST', '/lol-lobby/v2/lobby/invitations', [{ toSummonerId: '123456789' }]]
  );
});

test('inviteTargetToLobby does not post when the current client is not in lobby', async () => {
  const calls = [];
  const lcu = {
    async get(endpoint) {
      calls.push(['GET', endpoint]);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'None';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post(endpoint, body) {
      calls.push(['POST', endpoint, body]);
    }
  };

  await assert.rejects(
    () => inviteTargetToLobby(lcu, { puuid: 'friend-puuid', riotId: 'Lobby Friend#EUW' }),
    /Create or join a League lobby/
  );
  assert.equal(calls.some((call) => call[0] === 'POST'), false);
});

test('leaveCurrentLobby deletes the current lobby only while in lobby', async () => {
  const lobbyCalls = [];
  const lobbyLcu = {
    async get(endpoint) {
      lobbyCalls.push(['GET', endpoint]);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'Lobby';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async delete(endpoint) {
      lobbyCalls.push(['DELETE', endpoint]);
      return null;
    }
  };

  assert.deepEqual(await leaveCurrentLobby(lobbyLcu), { left: true, phase: 'Lobby' });
  assert.deepEqual(lobbyCalls, [
    ['GET', '/lol-gameflow/v1/gameflow-phase'],
    ['DELETE', '/lol-lobby/v2/lobby']
  ]);

  const champSelectCalls = [];
  const champSelectLcu = {
    async get(endpoint) {
      champSelectCalls.push(['GET', endpoint]);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'ChampSelect';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async delete(endpoint) {
      champSelectCalls.push(['DELETE', endpoint]);
      throw new Error('Should not delete');
    }
  };

  const result = await leaveCurrentLobby(champSelectLcu);
  assert.equal(result.left, false);
  assert.equal(result.phase, 'ChampSelect');
  assert.equal(champSelectCalls.some((call) => call[0] === 'DELETE'), false);
});

test('joinFriendLobby posts party-id join request', async () => {
  const calls = [];
  const lcu = {
    async get(endpoint) {
      calls.push(['GET', endpoint]);
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'None';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post(endpoint, body) {
      calls.push(['POST', endpoint, body]);
      return null;
    }
  };

  const result = await joinFriendLobby(lcu, {
    partyId: 'party-open-1',
    riotId: 'Lobby Friend#EUW',
    party: { open: true, size: 2, maxSize: 5, memberPuuids: ['friend-puuid'] }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.find((call) => call[0] === 'POST'),
    ['POST', '/lol-lobby/v2/party/party-open-1/join', undefined]
  );
});

test('joinFriendLobby rejects missing, closed, full, unsafe, and already-joined lobbies', async () => {
  const idleLcu = {
    async get(endpoint) {
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'None';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post() {
      throw new Error('Should not post');
    }
  };

  await assert.rejects(() => joinFriendLobby(idleLcu, {}), /party ID/);
  await assert.rejects(() => joinFriendLobby(idleLcu, { partyId: 'p1', party: { open: false } }), /invite-only/);
  await assert.rejects(() => joinFriendLobby(idleLcu, { partyId: 'p1', party: { size: 5, maxSize: 5 } }), /full/);

  const champSelectLcu = {
    async get(endpoint) {
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'ChampSelect';
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post() {
      throw new Error('Should not post');
    }
  };
  await assert.rejects(() => joinFriendLobby(champSelectLcu, { partyId: 'p1' }), /champ select/);

  const alreadyJoinedLcu = {
    async get(endpoint) {
      if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'Lobby';
      if (endpoint === '/lol-lobby/v2/lobby') return { partyId: 'p1', localMember: { puuid: 'self' }, members: [{ puuid: 'self' }] };
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async post() {
      throw new Error('Should not post');
    }
  };
  await assert.rejects(() => joinFriendLobby(alreadyJoinedLcu, { partyId: 'p1' }), /already in this lobby/);
});
