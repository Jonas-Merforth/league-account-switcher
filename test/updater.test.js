import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createUpdater } from '../src/main/updater.js';

class FakeUpdater extends EventEmitter {
  async checkForUpdates() {}

  async downloadUpdate() {
    throw new Error('download unavailable');
  }

  quitAndInstall() {}
}

test('a user-started update download reports a visible manual error', async () => {
  const statuses = [];
  const service = createUpdater({
    log() {},
    broadcast: (status) => statuses.push(status),
    isBusy: () => false,
    getAutoUpdate: () => false,
    updater: new FakeUpdater(),
    appRuntime: { isPackaged: true }
  });

  service.downloadUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(statuses.at(-1), {
    state: 'error',
    message: 'download unavailable',
    manual: true
  });
});

test('a background check cannot erase a concurrent user check intent', () => {
  const statuses = [];
  const fakeUpdater = new FakeUpdater();
  const service = createUpdater({
    log() {},
    broadcast: (status) => statuses.push(status),
    isBusy: () => false,
    getAutoUpdate: () => false,
    updater: fakeUpdater,
    appRuntime: { isPackaged: true }
  });

  service.checkForUpdates(true);
  service.checkForUpdates(false);
  fakeUpdater.emit('update-not-available');

  assert.deepEqual(statuses.at(-1), { state: 'none', manual: true });
});
