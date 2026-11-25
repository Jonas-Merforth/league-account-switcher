import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, saveAccounts, writeSnapshot } from '../src/core/accountStore.js';
import { dpapiProtect } from '../src/core/secrets.js';
import { AccountManager } from '../src/core/accountManager.js';
import { clearSavedFriendAuthCache, getSavedFriendXmppAuth, getSavedFriendSessionVerification } from '../src/core/friendPresencePoc.js';
import { accountSessionView } from '../src/renderer/accountDisplay.js';

test('Friends remembers a saved renewal across access-token expiry, cache clears and transient failures',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'las-session-status-'));
    const previousDirectory = process.env.LCA_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LCA_CONFIG_DIR = directory;
    const account = { id: 'fixture-account', label: 'Fixture', username: 'fixture', sessionCapturedAt: '2020-01-01T00:00:00Z' };
    let refreshResult = 'rotate';
    let refreshCalls = 0;
    let pauseRefresh;
    const jwt = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `fixture.${jwt}.fixture`;
    const manifest = { 'Data/RiotGamesPrivateSettings.yaml': Buffer.from(
      'psl:\n    authorization:\n        riot-client:\n            id_token: "fixture-id"\n            refresh_token: "fixture-refresh"\nriot-login:\n    persist: null\n'
    ).toString('base64') };
    globalThis.fetch = async (url, options) => {
      const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
      if (url === 'https://auth.riotgames.com/token') {
        refreshCalls++;
        await pauseRefresh?.();
        if (refreshResult === 'rejected') return response({ error: 'invalid_grant' });
        if (refreshResult === 'unavailable') throw new Error('Temporary network failure');
        const refreshToken = refreshResult === 'unchanged'
          ? options.body.get('refresh_token') : `fixture-rotated-${refreshCalls}`;
        return response({ access_token: token, refresh_token: refreshToken, id_token: token });
      }
      if (url === 'https://entitlements.auth.riotgames.com/api/token/v1') return response({ entitlements_token: token });
      if (url === 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat') return response(`fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, affinities: { live: 'euw1' } })).toString('base64url')}.fixture`);
      if (url === 'https://auth.riotgames.com/userinfo') return response({ sub: 'fixture-player', acct: { game_name: 'Fixture', tag_line: 'TEST' } });
      throw new Error('Unexpected request in isolated test');
    };
    try {
      clearSavedFriendAuthCache();
      saveAccounts([account]);
      writeSnapshot(account.id, await dpapiProtect(JSON.stringify(manifest)));
      const manager = new AccountManager({ getSessionVerification: getSavedFriendSessionVerification });
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');

      await getSavedFriendXmppAuth(account.id);
      assert.equal(accountSessionView(manager.listAccounts()[0]).text, 'Session verified by Friends');
      const verifiedAt = manager.listAccounts()[0].sessionVerification.verifiedAt;
      await getSavedFriendXmppAuth(account.id);
      assert.equal(refreshCalls, 1, 'cached auth must retain verification after refresh-token rotation');
      const afterAccessTokenExpiry = Date.now() + 2 * 60 * 60 * 1000;
      assert.equal(getSavedFriendSessionVerification(account, afterAccessTokenExpiry).renewed, true);
      clearSavedFriendAuthCache();
      assert.equal(accountSessionView(manager.reload()[0]).text, 'Session verified by Friends');

      refreshResult = 'unavailable';
      await assert.rejects(getSavedFriendXmppAuth(account.id), /Temporary network failure/);
      assert.equal(manager.listAccounts()[0].sessionVerification.verifiedAt, verifiedAt);

      refreshResult = 'unchanged';
      await getSavedFriendXmppAuth(account.id);
      assert.equal(manager.listAccounts()[0].sessionVerification.verifiedAt, verifiedAt);

      writeSnapshot(account.id, 'a different snapshot');
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');
      writeSnapshot(account.id, await dpapiProtect(JSON.stringify(manifest)));
      await getSavedFriendXmppAuth(account.id);
      assert.equal(manager.listAccounts()[0].sessionVerification.renewed, undefined);
      clearSavedFriendAuthCache();
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');

      refreshResult = 'rotate';
      await getSavedFriendXmppAuth(account.id);
      assert.equal(accountSessionView(manager.listAccounts()[0]).text, 'Session verified by Friends');

      refreshResult = 'rejected';
      await assert.rejects(getSavedFriendXmppAuth(account.id, { force: true }), { code: 'FRIENDS_SESSION_INTERACTIVE_AUTH' });
      clearSavedFriendAuthCache();
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');

      refreshResult = 'rotate';
      let signalStarted;
      let resumeRefresh;
      const started = new Promise(resolve => { signalStarted = resolve; });
      const resume = new Promise(resolve => { resumeRefresh = resolve; });
      pauseRefresh = () => {
        signalStarted();
        return resume;
      };
      const running = getSavedFriendXmppAuth(account.id);
      const rejected = assert.rejects(running, { code: 'FRIENDS_LOCAL_SESSION_ERROR' });
      await Promise.race([started, running]);
      writeSnapshot(account.id, 'a newer snapshot');
      resumeRefresh();
      await rejected;
      assert.equal(readSnapshot(account.id), 'a newer snapshot');
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');
    } finally {
      globalThis.fetch = originalFetch;
      clearSavedFriendAuthCache();
      if (previousDirectory === undefined) delete process.env.LCA_CONFIG_DIR;
      else process.env.LCA_CONFIG_DIR = previousDirectory;
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('las-session-status-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
