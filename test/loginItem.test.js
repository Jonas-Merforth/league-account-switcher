import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyWindowsLoginItem, loginItemSettings, LOGIN_ITEM_NAME } from '../src/core/loginItem.js';

test('development startup includes an absolute application path even with spaces', () => {
  const appPath = path.resolve('checkout with spaces');
  const execPath = path.join(appPath, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.deepEqual(loginItemSettings({ enabled: true, isPackaged: false, execPath, appPath }), {
    name: LOGIN_ITEM_NAME, path: `"${execPath}"`, args: [`"${appPath}"`, '--hidden'], openAtLogin: true
  });
});

test('packaged startup uses its executable without passing the asar as an app argument', () => {
  const execPath = path.resolve('Program Files', 'League Account Switcher.exe');
  assert.deepEqual(loginItemSettings({ enabled: true, isPackaged: true, execPath, appPath: 'resources/app.asar' }), {
    name: LOGIN_ITEM_NAME, path: `"${execPath}"`, args: ['--hidden'], openAtLogin: true
  });
});

test('enabling and disabling use the same named entry and verify the exact command', () => {
  const writes = [];
  const app = {
    isPackaged: false,
    getAppPath: () => path.resolve('checkout'),
    setLoginItemSettings: (options) => writes.push(options),
    getLoginItemSettings: (query) => {
      const last = writes.at(-1);
      assert.deepEqual(query, { path: last.path, args: last.args });
      return { openAtLogin: last.openAtLogin };
    }
  };
  applyWindowsLoginItem(app, true);
  applyWindowsLoginItem(app, false);
  assert.equal(writes[0].name, writes[1].name);
  assert.deepEqual(writes[0].args, writes[1].args);
  assert.equal(writes[1].openAtLogin, false);
  app.getLoginItemSettings = () => ({ openAtLogin: false });
  assert.throws(() => applyWindowsLoginItem(app, true), /did not retain/);
});
