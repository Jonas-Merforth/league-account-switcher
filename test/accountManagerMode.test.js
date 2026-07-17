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

test('shutdown invalidates active switch work before releasing settings', async () => {
  let continueSwitch;
  const switchGate = new Promise((resolve) => { continueSwitch = resolve; });
  let releaseCalls = 0;
  const manager = new AccountManager({
    lcuClient: {},
    riotClient: {},
    log: () => {},
    settingsSync: { release: () => { releaseCalls += 1; } }
  });
  manager._switchRunId = 1;
  manager._activeSwitch = { id: 'target', options: {}, runId: 1 };
  manager.switchStatus = {
    busy: true,
    id: 'target',
    label: 'Target',
    stage: 'closing',
    message: 'Closing clients',
    error: null,
    startedAt: new Date(0).toISOString(),
    finishedAt: null
  };
  manager._settingsLockActive = true;

  const switchWork = (async () => {
    await switchGate;
    manager._assertActiveSwitchRun(1);
    manager._settingsLockActive = true;
  })();
  await manager.prepareForShutdown();
  continueSwitch();

  await assert.rejects(switchWork, (error) => error.code === 'SWITCH_RUN_CANCELLED');
  assert.equal(releaseCalls, 1);
  assert.equal(manager._settingsLockActive, false);
  assert.equal(manager._activeSwitch, null);
  assert.equal(manager.getStatus().busy, false);
  assert.throws(
    () => manager._startSwitchRun({ id: 'late', label: 'Late switch' }),
    /shutting down/i
  );
});
