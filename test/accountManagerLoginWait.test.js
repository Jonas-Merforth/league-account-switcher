import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousConfigDir = process.env.LCA_CONFIG_DIR;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'las-login-wait-'));
process.env.LCA_CONFIG_DIR = configDir;

// AccountManager loads the account store in its constructor, so install the isolated config path
// before importing the module. This prevents these unit tests from reading the user's live accounts.
const { AccountManager, identityMatchesAccount, probeSignedIn } = await import('../src/core/accountManager.js');

test('account matching prefers immutable identity and handles renamed and legacy accounts', () => {
  const identity = { puuid: 'one', username: 'login', gameName: 'Renamed', riotId: 'Renamed#EUW' };
  assert.equal(identityMatchesAccount({ puuid: 'one', username: 'old-login' }, identity), true);
  assert.equal(identityMatchesAccount({ puuid: 'other', username: 'login' }, identity), false);
  assert.equal(identityMatchesAccount({ username: 'LOGIN', lastSummonerName: 'Old name' }, identity), true);
  assert.equal(identityMatchesAccount({ lastSummonerName: 'Renamed' }, identity), true);
  assert.equal(identityMatchesAccount({ lastSummonerName: 'Renamed#OTHER' }, identity), false);
  assert.equal(identityMatchesAccount({}, identity), false);
  assert.equal(identityMatchesAccount({ puuid: 'one' }, null), false);
  assert.equal(probeSignedIn({ running: true, authType: 'multifactor' }), false);
});

test('detectCurrent recognizes the live login username even before its game name was captured', async () => {
  const manager = new AccountManager({ riotClient: {
    isRunning: () => true,
    getIdentity: async () => ({ puuid: 'fixture-player', username: 'fixture-login', riotId: 'Game#EUW' })
  } });
  manager.accounts = [{ id: 'fixture-account', username: 'fixture-login', lastSummonerName: null }];
  manager._save = () => {};
  assert.equal(await manager.detectCurrent(), 'fixture-account');
  assert.equal(manager.accounts[0].puuid, 'fixture-player');
  assert.equal(manager.accounts[0].lastSummonerName, 'Game#EUW');
});

test.after(() => {
  if (previousConfigDir === undefined) delete process.env.LCA_CONFIG_DIR;
  else process.env.LCA_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

test('known no-session login returns on the first ready login-screen probe', async () => {
  const logs = [];
  let probes = 0;
  const manager = new AccountManager({
    riotClient: {
      probe: async () => {
        probes += 1;
        return { running: true, authType: 'needs_authentication' };
      }
    },
    log: (message) => logs.push(message)
  });

  const result = await manager._waitForLogin(5_000, 'known-no-session', {
    bailOnLoginScreenMs: 2_000,
    bailImmediatelyOnLoginScreen: true
  });

  assert.equal(result, false);
  assert.equal(probes, 1);
  assert.ok(logs.some((message) => /requesting credentials.*no saved session to wait for/i.test(message)));
});

test('an authorized probe still wins before the no-session early return', async () => {
  const manager = new AccountManager({
    riotClient: {
      probe: async () => ({ running: true, authType: 'authorized' })
    },
    log: () => {}
  });

  const result = await manager._waitForLogin(5_000, 'known-no-session', {
    bailOnLoginScreenMs: 2_000,
    bailImmediatelyOnLoginScreen: true
  });

  assert.equal(result, true);
});
