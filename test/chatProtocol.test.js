import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatMessage,
  buildChatPresence,
  buildChatUnavailablePresence,
  chatConversationKey,
  friendBareJid,
  normalizeLcuChatMessage,
  parseChatMessage
} from '../src/core/chatProtocol.js';
import { normalizeLcuFriendPresence } from '../src/core/chatTransports.js';

test('chat conversation keys preserve the source account and normalize the friend PUUID', () => {
  assert.equal(chatConversationKey('account-1', ' FRIEND-PUUID '), 'account-1:friend-puuid');
  assert.equal(chatConversationKey('', 'friend'), '');
});

test('chat presence uses a routable priority and has an explicit offline stanza', () => {
  const presence = buildChatPresence();
  assert.match(presence, /^<presence><show>chat<\/show>/);
  assert.match(presence, /<st>chat<\/st><s\.p>league_of_legends<\/s\.p>/);
  assert.match(presence, /<priority>0<\/priority><\/presence>$/);
  const encoded = presence.match(/<p>([^<]+)<\/p>/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), { gameStatus: 'outOfGame' });
  assert.equal(buildChatUnavailablePresence(), '<presence type="unavailable"/>');
});

test('chat messages target a bare friend JID and escape user content', () => {
  assert.equal(friendBareJid({ destinationJid: 'friend@eu1.pvp.net/resource' }), 'friend@eu1.pvp.net');
  assert.equal(
    buildChatMessage({ id: 'm&1', destinationPuuid: 'friend', domain: 'eu1.pvp.net', body: ' hi <there> ' }),
    '<message id="m&amp;1" to="friend@eu1.pvp.net" type="chat"><active xmlns="http://jabber.org/protocol/chatstates"/><body>hi &lt;there&gt;</body></message>'
  );
});

test('incoming Riot chat messages parse body, identity, and delayed timestamp', () => {
  const parsed = parseChatMessage('<message from="friend@eu1.pvp.net/device" to="self@eu1.pvp.net/app" id="abc" type="chat"><body>Hello &amp; welcome</body><delay xmlns="urn:xmpp:delay" stamp="2026-07-12T10:00:00Z"/></message>');
  assert.deepEqual(parsed, {
    id: 'abc',
    from: 'friend@eu1.pvp.net/device',
    to: 'self@eu1.pvp.net/app',
    fromPuuid: 'friend',
    toPuuid: 'self',
    body: 'Hello & welcome',
    receivedAt: '2026-07-12T10:00:00.000Z',
    delayed: true
  });
  assert.equal(parseChatMessage('<message type="chat"><active xmlns="http://jabber.org/protocol/chatstates"/></message>'), null);
});

test('LCU chat messages normalize incoming and outgoing identities', () => {
  assert.equal(normalizeLcuChatMessage(null), null);
  assert.deepEqual(
    normalizeLcuChatMessage({ id: 'm1', fromId: 'friend@eu1.pvp.net', body: 'Hi', timestamp: '2026-07-12T10:00:00Z' }, { selfPuuid: 'self', conversationPuuid: 'friend' }),
    { id: 'm1', fromPuuid: 'friend', toPuuid: 'self', body: 'Hi', receivedAt: '2026-07-12T10:00:00.000Z', incoming: true }
  );
});

test('LCU friend presence normalizes Riot ids and availability', () => {
  assert.deepEqual(normalizeLcuFriendPresence({
    id: 'FRIEND-PUUID@eu1.pvp.net',
    availability: 'dnd',
    gameName: 'Friendly',
    gameTag: 'EUW',
    product: 'league_of_legends',
    lol: { gameStatus: 'inGame', gameQueueType: 'RANKED_SOLO_5x5', skinname: 'Ahri' }
  }), {
    puuid: 'friend-puuid',
    jid: 'FRIEND-PUUID@eu1.pvp.net',
    gameName: 'Friendly',
    tagLine: 'EUW',
    riotId: 'Friendly#EUW',
    online: true,
    state: 'dnd',
    queue: 'RANKED_SOLO_5x5',
    product: 'league_of_legends',
    details: { gameStatus: 'inGame', gameQueueType: 'RANKED_SOLO_5x5', skinname: 'Ahri' }
  });
  assert.deepEqual(normalizeLcuFriendPresence({ puuid: 'friend', availability: 'offline' }), {
    puuid: 'friend',
    jid: '',
    gameName: '',
    tagLine: '',
    riotId: '',
    online: false,
    state: 'offline',
    queue: '',
    product: '',
    details: null
  });
});
