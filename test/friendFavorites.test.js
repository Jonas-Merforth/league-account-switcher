import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendFavoriteKey,
  isFavoriteFriend,
  sortFriendsForFavorites
} from '../src/renderer/friendFavorites.js';

test('friendFavoriteKey prefers PUUID and falls back to Riot ID', () => {
  assert.equal(friendFavoriteKey({ puuid: ' ABC ', riotId: 'Name#EUW' }), 'puuid:abc');
  assert.equal(friendFavoriteKey({ riotId: ' Name#EUW ' }), 'riot:name#euw');
  assert.equal(friendFavoriteKey({}), '');
});

test('isFavoriteFriend matches normalized favorite keys', () => {
  assert.equal(isFavoriteFriend({ puuid: 'ABC' }, ['puuid:abc']), true);
  assert.equal(isFavoriteFriend({ riotId: 'Name#EUW' }, ['riot:name#euw']), true);
  assert.equal(isFavoriteFriend({ riotId: 'Other#EUW' }, ['riot:name#euw']), false);
});

test('sortFriendsForFavorites promotes favorites inside visible online, mobile, and offline groups', () => {
  const friends = [
    { riotId: 'Online Normal#EUW', puuid: 'online-normal', online: true, state: 'chat' },
    { riotId: 'Offline Favorite#EUW', puuid: 'offline-fav', online: false, state: 'offline' },
    { riotId: 'Mobile Normal#EUW', puuid: 'mobile-normal', online: true, state: 'mobile' },
    { riotId: 'Online Favorite#EUW', puuid: 'online-fav', online: true, state: 'away' },
    { riotId: 'Offline Normal#EUW', puuid: 'offline-normal', online: false, state: 'offline' },
    { riotId: 'Mobile Favorite#EUW', puuid: 'mobile-fav', online: true, state: 'mobile' }
  ];

  assert.deepEqual(
    sortFriendsForFavorites(friends, ['puuid:online-fav', 'puuid:mobile-fav', 'puuid:offline-fav'])
      .map((friend) => friend.riotId),
    [
      'Online Favorite#EUW',
      'Online Normal#EUW',
      'Mobile Favorite#EUW',
      'Mobile Normal#EUW',
      'Offline Favorite#EUW',
      'Offline Normal#EUW'
    ]
  );
});

test('sortFriendsForFavorites keeps same-game friends together without overriding favorites', () => {
  const inGame = (riotId, puuid, gameId) => ({
    riotId,
    puuid,
    online: true,
    state: 'dnd',
    activity: { kind: 'inGame', gameId }
  });
  const friends = [
    inGame('First Teammate#EUW', 'first', 'shared-game'),
    inGame('Other Favorite#EUW', 'other-favorite', 'other-game'),
    inGame('Second Teammate#EUW', 'second', 'shared-game'),
    inGame('Third Teammate#EUW', 'third', 'shared-game'),
    inGame('Non-favorite Teammate#EUW', 'non-favorite', 'shared-game'),
    inGame('Other Normal#EUW', 'other-normal', 'normal-game')
  ];

  assert.deepEqual(
    sortFriendsForFavorites(friends, [
      'puuid:first',
      'puuid:other-favorite',
      'puuid:second',
      'puuid:third'
    ]).map((friend) => friend.riotId),
    [
      'First Teammate#EUW',
      'Second Teammate#EUW',
      'Third Teammate#EUW',
      'Other Favorite#EUW',
      'Non-favorite Teammate#EUW',
      'Other Normal#EUW'
    ]
  );
});
