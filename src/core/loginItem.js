import path from 'node:path';

export const LOGIN_ITEM_NAME = 'com.merforth.league-account-switcher';

// Electron 33 joins these strings directly when writing the Windows Run value.
// Quote paths ourselves, including a trailing backslash if the path is a root.
const quotePath = (value) => `"${path.resolve(value).replace(/(\\+)$/, '$1$1')}"`;

// Windows starts login items without the checkout's working directory. An unpackaged
// Electron executable therefore needs the absolute app directory before our flags;
// otherwise Electron opens its default welcome app instead of the switcher.
export function loginItemSettings({ enabled, isPackaged, execPath, appPath, name = LOGIN_ITEM_NAME }) {
  if (!execPath || (!isPackaged && !appPath)) throw new Error('Startup application path is missing.');
  return {
    name,
    path: quotePath(execPath),
    args: isPackaged ? ['--hidden'] : [quotePath(appPath), '--hidden'],
    openAtLogin: Boolean(enabled)
  };
}

export function applyWindowsLoginItem(app, enabled, { execPath = process.execPath, name } = {}) {
  const options = loginItemSettings({
    enabled, isPackaged: app.isPackaged, appPath: app.getAppPath(), execPath, name
  });
  // The explicit name also replaces the old entry, rather than leaving a second
  // generic Electron startup command behind when a development build is used.
  app.setLoginItemSettings(options);
  const actual = app.getLoginItemSettings({ path: options.path, args: options.args });
  if (actual.openAtLogin !== options.openAtLogin) {
    throw new Error('Windows did not retain the requested startup command.');
  }
  return options;
}
