import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, accountSwitchExecution } from '../src/core/accountManager.js';

test('normal account switches keep existing League and settings behavior', () => {
  assert.deepEqual(accountSwitchExecution(), {
    launchArgs: undefined,
    launchLeague: true,
    applySettings: true,
    notifySwitched: true
  });
});

test('repair account switches launch Riot Client only without normal switch side effects', () => {
  assert.deepEqual(accountSwitchExecution({ clientOnly: true, repairOnly: true }), {
    launchArgs: [],
    launchLeague: false,
    applySettings: false,
    notifySwitched: false
  });
});

test('an immediate settings release flushes a pending delayed release', async () => {
  let releaseCalls = 0;
  const manager = new AccountManager({
    lcuClient: {},
    riotClient: {},
    log: () => {},
    settingsSync: {
      apply: () => true,
      release: () => { releaseCalls += 1; }
    }
  });

  manager._settingsLockActive = true;
  manager._releaseSettingsLock(60_000);
  await manager.releaseSettingsForShutdown();

  assert.equal(releaseCalls, 1);
  assert.equal(manager._settingsReleaseTimer, null);
  assert.equal(manager._settingsLockActive, false);
});
