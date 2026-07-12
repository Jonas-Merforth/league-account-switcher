import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSwitchExecution } from '../src/core/accountManager.js';

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
