import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAccounts, writeSnapshot } from '../src/core/accountStore.js';
import { dpapiProtect } from '../src/core/secrets.js';
import { AccountManager } from '../src/core/accountManager.js';
import { clearSavedFriendAuthCache, getSavedFriendXmppAuth, getSavedFriendSessionVerification } from '../src/core/friendPresencePoc.js';
import { accountSessionView } from '../src/renderer/accountDisplay.js';

test('Friends auth validates the rotated saved snapshot and account labels forget replaced or rejected credentials',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'las-session-status-'));
    const previousDirectory = process.env.LCA_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LCA_CONFIG_DIR = directory;
    const account = { id: 'fixture-account', label: 'Fixture', username: 'fixture', sessionCapturedAt: '2020-01-01T00:00:00Z' };
    let rejectRefresh = false;
    let refreshCalls = 0;
    const jwt = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `fixture.${jwt}.fixture`;
    const manifest = { 'Data/RiotGamesPrivateSettings.yaml': Buffer.from(
      'psl:\n    authorization:\n        riot-client:\n            id_token: "fixture-id"\n            refresh_token: "fixture-refresh"\nriot-login:\n    persist: null\n'
    ).toString('base64') };
    globalThis.fetch = async url => {
      const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
      if (url === 'https://auth.riotgames.com/token') {
        refreshCalls++;
        if (rejectRefresh) return response({ error: 'invalid_grant' });
        return response({ access_token: token, refresh_token: 'fixture-rotated-refresh', id_token: token });
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
      await getSavedFriendXmppAuth(account.id);
      assert.equal(refreshCalls, 1, 'cached auth must retain verification after refresh-token rotation');

      writeSnapshot(account.id, 'a different snapshot');
      assert.equal(accountSessionView(manager.listAccounts()[0]).className, 'tag warn');
      writeSnapshot(account.id, await dpapiProtect(JSON.stringify(manifest)));
      await getSavedFriendXmppAuth(account.id);
      assert.equal(accountSessionView(manager.listAccounts()[0]).text, 'Session verified by Friends');

      rejectRefresh = true;
      await assert.rejects(getSavedFriendXmppAuth(account.id, { force: true }), { code: 'FRIENDS_SESSION_INTERACTIVE_AUTH' });
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
