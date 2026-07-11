import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFriendActivity,
  clearSavedFriendAuthCache,
  compareMergedFriends,
  parsePresenceStanzas,
  savedFriendAuthExpiresAt,
  suppressScanSourceAccountPresence
} from '../src/core/friendPresencePoc.js';

function jwtWithExpiry(exp) {
  const payload = Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

test('saved friend auth expires with its shortest-lived credential', () => {
  clearSavedFriendAuthCache();
  const now = Math.floor(Date.now() / 1_000);
  assert.equal(savedFriendAuthExpiresAt({
    accessToken: jwtWithExpiry(now + 3_600),
    pasToken: jwtWithExpiry(now + 1_800),
    entitlementToken: jwtWithExpiry(now + 7_200)
  }), (now + 1_800) * 1_000);
  assert.equal(savedFriendAuthExpiresAt({ accessToken: 'not-a-jwt' }), 0);
});

test('parsePresenceStanzas decodes base64 League presence details', () => {
  const puuid = '11111111-1111-4111-8111-111111111111';
  const partyFriend = '22222222-2222-4222-8222-222222222222';
  const started = Date.now() - 10 * 60_000;
  const payload = {
    gameStatus: 'inGame',
    gameQueueType: 'ARAM_UNRANKED_5x5',
    queueId: '450',
    championId: '22',
    skinname: 'Ashe',
    timeStamp: String(started),
    isObservable: 'ALL',
    pty: JSON.stringify({
      maxPlayers: 5,
      queueId: 450,
      summonerPuuids: [puuid, partyFriend]
    })
  };
  const encoded = Buffer.from(JSON.stringify(JSON.stringify(payload)), 'utf8').toString('base64');
  const xml = `<presence from='${puuid}@eu1.pvp.net/RC-1'><games><league_of_legends>` +
    `<st>dnd</st><s.p>league_of_legends</s.p><p>${encoded}</p>` +
    `</league_of_legends></games><show>dnd</show></presence>`;

  const [presence] = parsePresenceStanzas(xml);
  assert.equal(presence.puuid, puuid);
  assert.equal(presence.state, 'dnd');
  assert.equal(presence.product, 'league_of_legends');
  assert.equal(presence.details.gameStatus, 'inGame');
  assert.equal(presence.details.skinname, 'Ashe');

  const activity = buildFriendActivity(
    { puuid, riotId: 'Ashe Friend#EUW', online: true, state: presence.state, details: presence.details },
    { namesByPuuid: new Map([[puuid, 'Ashe Friend#EUW'], [partyFriend, 'Duo Friend#EUW']]) }
  );
  assert.equal(activity.kind, 'inGame');
  assert.equal(activity.queueLabel, 'ARAM');
  assert.equal(activity.championName, 'Ashe');
  assert.equal(activity.party.size, 2);
  assert.equal(activity.party.maxSize, 5);
  assert.deepEqual(activity.party.memberNames, ['Ashe Friend#EUW', 'Duo Friend#EUW']);
  assert.deepEqual(activity.party.playingWithNames, ['Duo Friend#EUW']);
  assert.equal(activity.spectatable, true);
  assert.ok(Date.parse(activity.startedAt) <= Date.now());
});

test('buildFriendActivity summarizes lobby party size and queue', () => {
  const activity = buildFriendActivity({
    puuid: 'friend-a',
    riotId: 'Lobby Friend#EUW',
    online: true,
    state: 'chat',
    details: {
      gameStatus: 'hosting_RANKED_FLEX_SR',
      gameQueueType: 'RANKED_FLEX_SR',
      queueId: '440',
      pty: JSON.stringify({
        partyId: 'party-open-1',
        partyType: 'open',
        isPartyOpen: true,
        maxPlayers: 5,
        queueId: 440,
        summonerPuuids: ['friend-a', 'friend-b', 'friend-c']
      })
    }
  }, {
    namesByPuuid: new Map([
      ['friend-a', 'Lobby Friend#EUW'],
      ['friend-b', 'Known Duo#EUW']
    ])
  });

  assert.equal(activity.kind, 'lobby');
  assert.equal(activity.queueLabel, 'Ranked Flex');
  assert.equal(activity.party.size, 3);
  assert.equal(activity.party.maxSize, 5);
  assert.equal(activity.party.partyId, 'party-open-1');
  assert.equal(activity.party.partyType, 'open');
  assert.equal(activity.party.open, true);
  assert.deepEqual(activity.party.memberNames, ['Lobby Friend#EUW', 'Known Duo#EUW']);
  assert.deepEqual(activity.party.playingWithNames, ['Known Duo#EUW']);
  assert.equal(activity.party.unknownCount, 1);
});

test('buildFriendActivity marks invite-only lobby parties as closed', () => {
  const activity = buildFriendActivity({
    puuid: 'friend-a',
    riotId: 'Closed Lobby#EUW',
    online: true,
    state: 'chat',
    details: {
      gameStatus: 'hosting_ARAM_UNRANKED_5x5',
      queueId: '450',
      pty: JSON.stringify({
        partyId: 'party-closed-1',
        partyType: 'closed',
        maxPartySize: 5,
        summonerPuuids: ['friend-a']
      })
    }
  });

  assert.equal(activity.kind, 'lobby');
  assert.equal(activity.party.partyId, 'party-closed-1');
  assert.equal(activity.party.partyType, 'closed');
  assert.equal(activity.party.open, false);
  assert.equal(activity.party.size, 1);
  assert.equal(activity.party.maxSize, 5);
});

test('buildFriendActivity keeps an away friend away while retaining joinable lobby details', () => {
  const activity = buildFriendActivity({
    puuid: 'friend-away',
    online: true,
    state: 'away',
    details: {
      gameStatus: 'hosting_RANKED_FLEX_SR',
      queueId: '440',
      pty: JSON.stringify({
        partyId: 'party-away-open',
        partyType: 'open',
        isPartyOpen: true,
        maxPlayers: 5,
        summonerPuuids: ['friend-away', 'friend-b']
      })
    }
  });

  assert.equal(activity.kind, 'away');
  assert.equal(activity.label, 'Away');
  assert.equal(activity.party.partyId, 'party-away-open');
  assert.equal(activity.party.open, true);
});

test('buildFriendActivity ignores stale out-of-game match metadata when no party exists', () => {
  const activity = buildFriendActivity({
    puuid: 'friend-post-game',
    riotId: 'Albues#EUW',
    online: true,
    state: 'chat',
    details: {
      gameStatus: 'outOfGame',
      gameId: '7910631033',
      gameMode: 'KIWI',
      queueId: '2400',
      pty: '',
      ptyType: 'open'
    }
  });

  assert.equal(activity.kind, 'online');
  assert.equal(activity.label, 'Online');
  assert.equal(activity.queueLabel, 'ARAM Mayhem');
  assert.equal(activity.party, null);
});

test('buildFriendActivity keeps away status above stale out-of-game queue data', () => {
  const activity = buildFriendActivity({
    puuid: 'friend-away',
    riotId: 'Away Friend#EUW',
    online: true,
    state: 'away',
    details: {
      gameStatus: 'outOfGame',
      gameId: '7910631033',
      queueId: '2400',
      ptyType: 'open'
    }
  });

  assert.equal(activity.kind, 'away');
  assert.equal(activity.label, 'Away');
  assert.equal(activity.queueLabel, 'ARAM Mayhem');
  assert.equal(activity.party, null);
});

test('buildFriendActivity differentiates ARAM Mayhem from Brawl', () => {
  const mayhem = buildFriendActivity({
    puuid: 'friend-mayhem',
    riotId: 'Mayhem Friend#EUW',
    online: true,
    state: 'dnd',
    details: {
      gameStatus: 'inGame',
      gameMode: 'KIWI',
      queueId: '2400'
    }
  });
  const brawl = buildFriendActivity({
    puuid: 'friend-brawl',
    riotId: 'Brawl Friend#EUW',
    online: true,
    state: 'dnd',
    details: {
      gameStatus: 'inGame',
      gameMode: 'KIWI',
      queueId: '2300'
    }
  });
  const mayhemWithoutQueueId = buildFriendActivity({
    puuid: 'friend-mayhem-token',
    riotId: 'Token Friend#EUW',
    online: true,
    state: 'dnd',
    details: {
      gameStatus: 'inGame',
      gameMode: 'KIWI'
    }
  });

  assert.equal(mayhem.queueLabel, 'ARAM Mayhem');
  assert.equal(brawl.queueLabel, 'Brawl');
  assert.equal(mayhemWithoutQueueId.queueLabel, 'ARAM Mayhem');
});

test('buildFriendActivity labels current queues from Riot queue ids', () => {
  const activityFor = (queueId) => buildFriendActivity({
    puuid: `friend-${queueId}`,
    riotId: `Queue ${queueId}#EUW`,
    online: true,
    state: 'dnd',
    details: {
      gameStatus: 'inGame',
      queueId: String(queueId)
    }
  });

  assert.equal(activityFor(480).queueLabel, 'Swiftplay');
  assert.equal(activityFor(720).queueLabel, 'ARAM Clash');
  assert.equal(activityFor(870).queueLabel, 'Co-op Intro');
  assert.equal(activityFor(880).queueLabel, 'Co-op Beginner');
  assert.equal(activityFor(890).queueLabel, 'Co-op Intermediate');
  assert.equal(activityFor(1810).queueLabel, 'Swarm');
});

test('compareMergedFriends ranks shared friends higher inside each status bucket', () => {
  const seen = (count) => Array.from({ length: count }, (_, index) => `Account ${index + 1}`);
  const friends = [
    { riotId: 'Offline Shared#EUW', online: false, state: 'offline', seenFrom: seen(4) },
    { riotId: 'Online One#EUW', online: true, state: 'chat', seenFrom: seen(1) },
    { riotId: 'Mobile Shared#EUW', online: true, state: 'mobile', seenFrom: seen(5) },
    { riotId: 'Online Three#EUW', online: true, state: 'chat', seenFrom: seen(3) },
    { riotId: 'Online Two#EUW', online: true, state: 'chat', seenFrom: seen(2) },
    { riotId: 'In Game Shared#EUW', online: true, state: 'dnd', seenFrom: seen(4) }
  ];

  assert.deepEqual(
    friends.sort(compareMergedFriends).map((friend) => friend.riotId),
    [
      'Online Three#EUW',
      'Online Two#EUW',
      'Online One#EUW',
      'In Game Shared#EUW',
      'Mobile Shared#EUW',
      'Offline Shared#EUW'
    ]
  );
});

test('suppressScanSourceAccountPresence hides scan-induced source-account chat presence', () => {
  const accounts = [
    {
      label: 'Scanner A',
      selfPuuid: 'source-a',
      friends: [
        {
          puuid: 'source-b',
          riotId: 'Scanner B#EUW',
          online: true,
          state: 'chat',
          queue: '',
          product: 'league_of_legends',
          details: null
        },
        {
          puuid: 'normal-friend',
          riotId: 'Real Friend#EUW',
          online: true,
          state: 'chat',
          queue: '',
          product: 'league_of_legends',
          details: null
        }
      ],
      onlineCount: 2
    },
    {
      label: 'Scanner B',
      selfPuuid: 'source-b',
      friends: [],
      onlineCount: 0
    }
  ];

  suppressScanSourceAccountPresence(accounts);

  assert.equal(accounts[0].friends[0].online, false);
  assert.equal(accounts[0].friends[0].state, 'offline');
  assert.equal(accounts[0].friends[0].details, null);
  assert.equal(accounts[0].friends[0].scanSourceAccount, true);
  assert.equal(accounts[0].friends[1].online, true);
  assert.equal(accounts[0].onlineCount, 1);
});

test('suppressScanSourceAccountPresence keeps source accounts with real League activity online', () => {
  const accounts = [
    {
      label: 'Scanner A',
      selfPuuid: 'source-a',
      friends: [
        {
          puuid: 'source-b',
          riotId: 'Scanner B#EUW',
          online: true,
          state: 'chat',
          queue: '420',
          product: 'league_of_legends',
          details: {
            gameStatus: 'hosting_RANKED_SOLO_5x5',
            queueId: '420',
            pty: JSON.stringify({
              partyId: 'party-real',
              partyType: 'open',
              isPartyOpen: true,
              summonerPuuids: ['source-b'],
              maxPlayers: 2
            })
          }
        }
      ],
      onlineCount: 1
    },
    {
      label: 'Scanner B',
      selfPuuid: 'source-b',
      friends: [],
      onlineCount: 0
    }
  ];

  suppressScanSourceAccountPresence(accounts);

  assert.equal(accounts[0].friends[0].online, true);
  assert.equal(accounts[0].friends[0].state, 'chat');
  assert.equal(accounts[0].friends[0].details.gameStatus, 'hosting_RANKED_SOLO_5x5');
  assert.equal(accounts[0].onlineCount, 1);
});

test('suppressScanSourceAccountPresence hides source accounts with stale out-of-game metadata', () => {
  const accounts = [
    {
      label: 'Scanner A',
      selfPuuid: 'source-a',
      friends: [
        {
          puuid: 'source-b',
          riotId: 'Scanner B#EUW',
          online: true,
          state: 'chat',
          queue: '2400',
          product: 'league_of_legends',
          details: {
            gameStatus: 'outOfGame',
            gameId: '7910631033',
            queueId: '2400',
            ptyType: 'open'
          }
        }
      ],
      onlineCount: 1
    },
    {
      label: 'Scanner B',
      selfPuuid: 'source-b',
      friends: [],
      onlineCount: 0
    }
  ];

  suppressScanSourceAccountPresence(accounts);

  assert.equal(accounts[0].friends[0].online, false);
  assert.equal(accounts[0].friends[0].state, 'offline');
  assert.equal(accounts[0].friends[0].details, null);
  assert.equal(accounts[0].onlineCount, 0);
});
