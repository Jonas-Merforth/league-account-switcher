import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLiveClientXmppAuthCache,
  getLiveClientXmppAuth
} from '../src/core/liveClientXmppAuth.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

test('live client auth builds a reusable XMPP credential bundle without saved-session replay', async () => {
  clearLiveClientXmppAuthCache();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const accessToken = jwt({ exp: nowSeconds + 3_600 });
  const entitlementToken = jwt({ exp: nowSeconds + 7_200 });
  const pasToken = jwt({ exp: nowSeconds + 1_800, affinity: 'euw1' });
  const calls = [];
  const lcu = {
    async get(endpoint) {
      calls.push(endpoint);
      if (endpoint === '/lol-rso-auth/v1/authorization/access-token') return { token: accessToken };
      if (endpoint === '/entitlements/v1/token') return { token: entitlementToken };
      if (endpoint === '/lol-summoner/v1/current-summoner') {
        return { puuid: 'CURRENT-PUUID', gameName: 'Current Player', tagLine: 'EUW' };
      }
      if (endpoint === '/riotclient/region-locale') return { region: 'EUW' };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    }
  };
  let pasRequests = 0;
  const logs = [];
  const fetchImpl = async (_url, options) => {
    pasRequests += 1;
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
    return { ok: true, status: 200, text: async () => pasToken };
  };

  const first = await getLiveClientXmppAuth(lcu, { fetchImpl, log: (message) => logs.push(message) });
  const second = await getLiveClientXmppAuth(lcu, { fetchImpl, log: (message) => logs.push(message) });

  assert.equal(first.source, 'live-client');
  assert.equal(first.identity.puuid, 'current-puuid');
  assert.equal(first.auth.userInfo.sub, 'current-puuid');
  assert.equal(first.auth.affinity, 'euw1');
  assert.equal(first.endpoint.host, 'euw1.chat.si.riotgames.com');
  assert.equal(first.endpoint.domain, 'eu1.pvp.net');
  assert.equal(second, first);
  assert.equal(pasRequests, 1);
  assert.deepEqual(calls.sort(), [
    '/entitlements/v1/token',
    '/lol-rso-auth/v1/authorization/access-token',
    '/lol-summoner/v1/current-summoner',
    '/lol-summoner/v1/current-summoner',
    '/riotclient/region-locale'
  ]);
  const combinedLogs = logs.join('\n');
  assert.equal(combinedLogs.includes(accessToken), false);
  assert.equal(combinedLogs.includes(entitlementToken), false);
  assert.equal(combinedLogs.includes(pasToken), false);
});

test('live client auth reports PAS failures without including response contents', async () => {
  clearLiveClientXmppAuthCache();
  const future = Math.floor(Date.now() / 1_000) + 3_600;
  const lcu = {
    async get(endpoint) {
      if (endpoint.includes('access-token')) return { token: jwt({ exp: future }) };
      if (endpoint === '/entitlements/v1/token') return { token: jwt({ exp: future }) };
      if (endpoint === '/lol-summoner/v1/current-summoner') return { puuid: 'puuid' };
      if (endpoint === '/riotclient/region-locale') return { region: 'EUW' };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    }
  };
  await assert.rejects(
    getLiveClientXmppAuth(lcu, {
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret response body' })
    }),
    (error) => error.message === 'PAS chat credential request failed (401).'
  );
});

test('live client auth never reuses cached credentials after the signed-in PUUID changes', async () => {
  clearLiveClientXmppAuthCache();
  const future = Math.floor(Date.now() / 1_000) + 3_600;
  let active = 'first-puuid';
  let pasRequests = 0;
  const lcu = {
    async get(endpoint) {
      if (endpoint.includes('access-token')) return { token: jwt({ exp: future, sub: active }) };
      if (endpoint === '/entitlements/v1/token') return { token: jwt({ exp: future, sub: active }) };
      if (endpoint === '/lol-summoner/v1/current-summoner') return { puuid: active, gameName: active };
      if (endpoint === '/riotclient/region-locale') return { region: 'EUW' };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    }
  };
  const fetchImpl = async () => {
    pasRequests += 1;
    return { ok: true, status: 200, text: async () => jwt({ exp: future, affinity: 'euw1', sub: active }) };
  };

  const first = await getLiveClientXmppAuth(lcu, { fetchImpl });
  active = 'second-puuid';
  const second = await getLiveClientXmppAuth(lcu, { fetchImpl });

  assert.equal(first.identity.puuid, 'first-puuid');
  assert.equal(second.identity.puuid, 'second-puuid');
  assert.notEqual(first.auth.accessToken, second.auth.accessToken);
  assert.equal(pasRequests, 2);
});
