import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountManager } from '../core/accountManager.js';
import { LcuClient } from '../core/lcu.js';
import { createLogger } from '../core/logger.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { REGIONS } from '../core/regions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_PNG = path.join(__dirname, '..', 'assets', 'tray.png');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.cjs');
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const HELP_HTML = path.join(__dirname, '..', 'help', 'help.html');

const STARTED_HIDDEN = process.argv.includes('--hidden');
// Diagnostic boot mode (LAS_SELFTEST=1): load everything headless, verify the renderer/preload/IPC
// wired up, then quit. Skips the login-item registration so it never touches the user's machine.
const SELFTEST = process.env.LAS_SELFTEST === '1';

const log = createLogger();
let settings = loadSettings();

const lcu = new LcuClient({ leaguePath: settings.leaguePath });
const manager = new AccountManager({
  lcuClient: lcu,
  log,
  onSwitched: () => {
    rebuildTray();
    sendAccountsChanged();
  }
});

let mainWindow = null;
let helpWindow = null;
let tray = null;
let isQuitting = false;
let statusTimer = null;

// ---------------------------------------------------------------------------
// Single instance — a tray app sharing one store must not run twice.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.setAppUserModelId('com.merforth.league-account-switcher');
  app.whenReady().then(onReady);
}

async function onReady() {
  Menu.setApplicationMenu(null); // no native menu bar; this is a focused utility window
  applyLoginItem(settings.startWithWindows);
  createMainWindow();
  createTray();
  if (SELFTEST) {
    runSelfTest();
    return;
  }
  if (!STARTED_HIDDEN) showMainWindow();
  // Best-effort: reflect an already-signed-in account in the UI/tray.
  manager.detectCurrent().then(() => {
    rebuildTray();
    sendAccountsChanged();
  });
}

// Headless boot check: confirms the window + tray are created, the renderer loads, the preload API
// is exposed, and an IPC round-trip works (region <option>s get rendered). Then quits.
function runSelfTest() {
  const wc = mainWindow.webContents;
  const out = (m) => console.log(`SELFTEST: ${m}`);
  out(`booted; window=${mainWindow ? 'ok' : 'missing'}; tray=${tray ? 'ok' : 'missing'}`);

  wc.on('console-message', (...args) => {
    const d = args[0];
    if (d && typeof d === 'object' && 'message' in d) {
      if (d.level === 'error' || d.level === 'warning') out(`renderer-${d.level}: ${d.message}`);
    } else if (args[1] >= 2) {
      out(`renderer-error: ${args[3]}`);
    }
  });
  wc.on('preload-error', (_e, _p, err) => out(`preload-error: ${err.message}`));
  wc.on('did-fail-load', (_e, code, desc) => out(`did-fail-load: ${code} ${desc}`));
  wc.on('did-finish-load', () => {
    out('renderer loaded');
    setTimeout(async () => {
      try {
        const api = await wc.executeJavaScript('!!(window.api && window.api.switchAccount)');
        const opts = await wc.executeJavaScript('document.querySelectorAll("#defaultRegion option").length');
        const region = await wc.executeJavaScript('document.getElementById("defaultRegion").value');
        out(`preload-api=${api} regionOptions=${opts} defaultRegion=${region}`);
      } catch (error) {
        out(`probe-error: ${error.message}`);
      }
      if (process.env.LAS_SHOT) {
        try {
          mainWindow.show();
          await new Promise((r) => setTimeout(r, 400));
          const image = await mainWindow.capturePage();
          const fs = await import('node:fs');
          fs.writeFileSync(process.env.LAS_SHOT, image.toPNG());
          out(`screenshot saved: ${process.env.LAS_SHOT}`);
        } catch (error) {
          out(`screenshot-error: ${error.message}`);
        }
      }
      out('done');
      quitApp();
    }, 1500);
  });

  setTimeout(() => { out('TIMEOUT'); process.exit(1); }, 20000);
}

// On Windows we live in the tray; closing the window hides it, so windows are never all destroyed.
app.on('window-all-closed', () => {
  if (process.platform !== 'win32') app.quit();
});
app.on('before-quit', () => {
  isQuitting = true;
});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function loadIcon(file) {
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 680,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'League Account Switcher',
    icon: loadIcon(ICON_PNG),
    backgroundColor: '#101215',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(INDEX_HTML);

  // Close = hide to tray (unless the user chose Quit from the tray menu).
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.show();
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 560,
    height: 680,
    title: 'League Account Switcher — Help',
    icon: loadIcon(ICON_PNG),
    backgroundColor: '#101215',
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  helpWindow.loadFile(HELP_HTML);
  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  tray = new Tray(loadIcon(TRAY_PNG));
  tray.setToolTip('League Account Switcher');
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  rebuildTray();
}

function rebuildTray() {
  if (!tray) return;
  const accounts = manager.listAccounts();
  const status = manager.getStatus();
  const busy = status.busy;
  const active = accounts.find((account) => account.isCurrent);

  const accountItems = accounts.length
    ? accounts.map((account) => ({
        label: trayAccountLabel(account),
        type: 'checkbox',
        checked: account.isCurrent,
        enabled: !busy,
        click: () => safeBeginSwitch(account.id)
      }))
    : [{ label: 'No accounts yet — open to add one', enabled: false }];

  const template = [
    { label: active ? `Active: ${active.label}` : 'No active account', enabled: false },
    busy ? { label: `Switching: ${status.message}`, enabled: false } : null,
    { type: 'separator' },
    { label: busy ? 'Switch to… (busy)' : 'Switch to…', enabled: false },
    ...accountItems,
    { type: 'separator' },
    { label: 'Open', click: () => showMainWindow() },
    { label: 'Help', click: () => openHelpWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() }
  ].filter(Boolean);

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(busy ? `Switching: ${status.message}` : `League Account Switcher${active ? ` — ${active.label}` : ''}`);
}

function trayAccountLabel(account) {
  const bits = [account.label];
  if (!account.hasSession && !account.hasPassword) bits.push('(no session)');
  else if (account.sessionAge?.stale) bits.push('(session may be expired)');
  return bits.join(' ');
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// Switch orchestration + status streaming (replaces the webapp's HTTP polling)
// ---------------------------------------------------------------------------
function beginSwitch(id, force = false) {
  const status = manager.startSwitch(id, { force }); // throws if busy / not found
  broadcastStatus(status);
  rebuildTray();
  startStatusPump();
  return status;
}

// Tray-initiated switches can't surface a thrown error to a dialog cleanly, so swallow + log.
function safeBeginSwitch(id) {
  try {
    beginSwitch(id, false);
    showMainWindow(); // so the user can watch progress / handle captcha
  } catch (error) {
    log(`Tray switch failed: ${error.message}`, 'warn');
  }
}

function startStatusPump() {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    const status = manager.getStatus();
    broadcastStatus(status);
    if (!status.busy) {
      clearInterval(statusTimer);
      statusTimer = null;
      rebuildTray();
      sendAccountsChanged();
    }
  }, 400);
}

function broadcastStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:update', status);
  }
}

function sendAccountsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('accounts:changed');
  }
}

// ---------------------------------------------------------------------------
// Login item (Start with Windows)
// ---------------------------------------------------------------------------
function applyLoginItem(enabled) {
  if (process.platform !== 'win32' || SELFTEST) return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  } catch (error) {
    log(`Could not set login item: ${error.message}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('accounts:list', () => manager.reload());
ipcMain.handle('accounts:status', () => manager.getStatus());

ipcMain.handle('accounts:save', async (_event, data) => {
  const saved = await manager.addOrUpdate(data ?? {});
  rebuildTray();
  return saved;
});

ipcMain.handle('accounts:remove', (_event, id) => {
  const removed = manager.remove(id);
  rebuildTray();
  return removed;
});

ipcMain.handle('accounts:capture', async (_event, id) => {
  const result = await manager.captureCurrent(id);
  rebuildTray();
  return result;
});

ipcMain.handle('accounts:switch', (_event, payload) => {
  const { id, force = false } = payload ?? {};
  return beginSwitch(id, force);
});

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_event, patch) => {
  settings = saveSettings({ ...settings, ...(patch ?? {}) });
  lcu.setLeaguePath(settings.leaguePath);
  applyLoginItem(settings.startWithWindows);
  return settings;
});

ipcMain.handle('regions:list', () => REGIONS);

ipcMain.handle('help:open', () => {
  openHelpWindow();
  return true;
});

ipcMain.handle('app:openExternal', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});
