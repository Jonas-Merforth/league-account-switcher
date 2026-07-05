import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFriendActivity, parsePresenceStanzas } from '../src/core/friendPresencePoc.js';

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
  assert.deepEqual(activity.party.memberNames, ['Lobby Friend#EUW', 'Known Duo#EUW']);
  assert.deepEqual(activity.party.playingWithNames, ['Known Duo#EUW']);
  assert.equal(activity.party.unknownCount, 1);
});
