import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RiotClientApi, parseRiotUserInfo } from '../src/core/riotClient.js';

test('current wrapped JSON and legacy userinfo produce the same identity', async () => {
  const info = { sub: 'player-id', username: 'login', acct: { game_name: 'Game Name', tag_line: 'EUW' } };
  const jwt = 'header.' + Buffer.from(JSON.stringify(info)).toString('base64url') + '.signature';
  for (const value of [info, JSON.stringify(info), { userInfo: JSON.stringify(info) }, { userInfo: jwt }]) {
    assert.deepEqual(parseRiotUserInfo(value), info);
    const api = new RiotClientApi();
    api.getUserInfo = async () => value;
    assert.equal(await api.getSignedInName(), 'Game Name#EUW');
    assert.equal((await api.getIdentity()).puuid, 'player-id');
  }
  for (const value of [null, '', '{', { error: 'not ready' }, { userInfo: '{}' }]) assert.equal(parseRiotUserInfo(value), null);
});

test('intermediate authorization and challenge states are never treated as signed in', async () => {
  const api = new RiotClientApi();
  api.isRunning = () => true;
  api.getUserInfo = async () => ({ error: 'not signed in' });
  for (const type of ['unknown', 'needs_authentication', 'auth', 'multifactor', 'error', 'pending']) {
    api.getAuthState = async () => ({ type });
    assert.equal(await api.isLoggedIn(), false, type);
  }
  api.getAuthState = async () => ({ type: 'authorized' });
  assert.equal(await api.isLoggedIn(), true);
});

test('direct password login requires an initialized explicitly challenge-free auth session', async () => {
  const api = new RiotClientApi();
  let posts = 0;
  let state;
  api.request = async (method, endpoint, body) => {
    if (method === 'GET') return state;
    posts++;
    assert.equal(body.remember, true);
    assert.equal(body.captcha, '');
    return { type: 'success', error: '' };
  };
  for (const invalid of [null, { type: 'auth', captcha: { type: 'none' } },
    { type: 'auth', suuid: 'session', timestamp: '123', captcha: { type: 'hcaptcha' } }]) {
    state = invalid;
    assert.equal((await api.tryPasswordLogin({ username: 'fixture', password: 'fixture' })).submitted, false);
  }
  assert.equal(posts, 0);
  state = { type: 'auth', suuid: 'session', timestamp: '123', captcha: { type: 'none' } };
  assert.equal((await api.tryPasswordLogin({ username: 'fixture', password: 'fixture' })).submitted, true);
  assert.equal(posts, 1);
});

test('Riot Client is running only while the lockfile owner process exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-client-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    fs.writeFileSync(lockfile, 'Riot Client:31552:62163:secret:https');
    const live = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: (pid) => pid === 31552
    });
    const stale = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: () => false
    });
    assert.equal(live.isRunning(), true);
    assert.equal(stale.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing and malformed Riot Client lockfiles are not running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-client-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    const api = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: () => true
    });
    assert.equal(api.isRunning(), false);
    fs.writeFileSync(lockfile, 'not-a-lockfile');
    assert.equal(api.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
