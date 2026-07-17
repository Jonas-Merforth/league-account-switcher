import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountManager } from '../core/accountManager.js';
import { findAccountByRiotIdentity, formatRiotId, parseRiotIdentity } from '../core/accountIdentity.js';
import { AppearOfflineState } from '../core/appearOfflineState.js';
import {
  gameWatcherTransition,
  settingsBaselineCaptureDisposition
} from '../core/gameWatcherState.js';
import { createUpdater } from './updater.js';
import { LcuClient } from '../core/lcu.js';
import { ClientMonitor } from '../core/clientMonitor.js';
import { ClientCleanupMonitor } from '../core/clientCleanup.js';
import { createLayeredHeaderClear } from '../core/leagueHeaderClear.js';
import { clearLeagueActivityCenterIndicatorsBackground } from '../core/leagueActivityCenterClicks.js';
import {
  applyBaseline,
  baselineMatchesLive,
  captureBaseline,
  getBaselineMeta,
  hasBaseline,
  unlockConfig
} from '../core/settingsSync.js';
import { createLogger, ensureLogFile, flushPendingLogs, pruneOldLogs } from '../core/logger.js';
import {
  getConfigDir,
  getLogPath,
  getRiotLockfilePath,
  getRiotSessionFilePath,
  getSwitcherLayoutPath,
  resolveLeaguePath,
  resolveRiotClientServicesPath
} from '../core/config.js';
import { defaultLayout, normalizeLayout, reconcileLayout } from '../core/layout.js';
import { buildPorofessorLiveUrl, resolvePorofessorRegion } from '../core/porofessor.js';
import { buildOpggProfileUrl } from '../core/opgg.js';
import { fetchCurrentRanks } from '../core/rankedStats.js';
import { fetchCurrentSummonerIdentity } from '../core/summonerIdentity.js';
import { fetchMergedFriendListPoc, getSavedFriendXmppAuth, validateSavedFriendSessionPoc } from '../core/friendPresencePoc.js';
import { createLiveFriendAuthOverride } from '../core/friendLiveAuth.js';
import { getLiveClientXmppAuth } from '../core/liveClientXmppAuth.js';
import { getLobbyInviteStatus, inviteTargetToLobby, joinFriendLobby, prepareCurrentLobbyForSwitch } from '../core/lobbyInvite.js';
import { buildCurrentClientSummary } from '../core/currentClientSummary.js';
import { FriendRankService } from '../core/friendRankService.js';
import { QueueRelayService } from '../core/queueRelay.js';
import { ChatService } from '../core/chatService.js';
import { DirectXmppChatTransport, LcuChatTransport } from '../core/chatTransports.js';
import { loadChatState, saveChatState } from '../core/chatStore.js';
import { ACCOUNT_SWITCH_BLOCKING_PHASES, DEFAULT_LEAGUE_PATH, RIOT_CLIENT_ONLY_LAUNCH_ARGS } from '../core/constants.js';
import { killRiotAndLeague, launchRiotClient } from '../core/riotControl.js';
import { readSessionBundle } from '../core/sessionBundle.js';
import {
  friendRepairRestoreOptions,
  replaceLiveSessionBundle,
  runSequentialFriendRepairs,
  shouldCountLoginDuringFriendRepair
} from '../core/friendSessionRepair.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { REGIONS } from '../core/regions.js';
import {
  accountStatsSummary,
  incrementLoginCount,
  LoginObservationTracker,
  loadAccountStats,
  recordStartedGame,
  removeAccountStatistics,
  saveAccountStats
} from '../core/accountStats.js';

// Logs are pruned to this many days so a friend's log file stays small and current.
const LOG_RETENTION_DAYS = 3;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_PNG = path.join(__dirname, '..', 'assets', 'tray.png');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.cjs');
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const HELP_HTML = path.join(__dirname, '..', 'help', 'help.html');

const STARTED_HIDDEN = process.argv.includes('--hidden');
// Diagnostic boot mode (LAS_SELFTEST=1): load everything headless, verify the renderer/preload/IPC
// wired up, then quit. Skips the login-item registration so it never touches the user's machine.
const SELFTEST = process.env.LAS_SELFTEST === '1';
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'league-account-switcher-selftest'));

const log = createLogger();
let settings = loadSettings();
let accountStats = loadAccountStats({ log });
const loginObservationTracker = new LoginObservationTracker();

// Use the user's League path if they set a custom one; otherwise auto-detect it (the default is just
// a guess that's wrong whenever League isn't on C:). This is what the lockfile launch-check relies on.
function effectiveLeaguePath() {
  const custom = settings.leaguePath && settings.leaguePath !== DEFAULT_LEAGUE_PATH;
  return custom ? settings.leaguePath : resolveLeaguePath();
}

const lcu = new LcuClient({ leaguePath: effectiveLeaguePath() });
const friendRankService = new FriendRankService({ lcu, log });
const savedFriendValidationTimers = new Map();
let cleanupMonitor = null;
let cleanupSwitchTimer = null;
let queueRelay = null;
let chatService = null;
let chatStateSaveTimer = null;
let chatStateSaveChain = Promise.resolve();

function scheduleSavedFriendSessionValidation({ account, reason }) {
  if (!account?.id) return;
  const existing = savedFriendValidationTimers.get(account.id);
  if (existing) clearTimeout(existing);
  // A running Riot Client may still be settling files after login. Switch-away and manual captures
  // happen after a graceful quit, so those snapshots can be checked almost immediately.
  const delayMs = reason === 'post-login' ? 20_000 : 1_000;
  const timer = setTimeout(async () => {
    savedFriendValidationTimers.delete(account.id);
    const prefix = `Friends session auto-check: account=${account.label} reason=${reason}`;
    try {
      const result = await validateSavedFriendSessionPoc(account.id, {
        log: (message, level) => log(`${prefix}: ${message}`, level)
      });
      log(`${prefix}: accepted riotId=${result.riotId} elapsedMs=${result.elapsedMs}.`);
    } catch (error) {
      // This is opportunistic. Live-client auth still keeps the current account and Queue Relay
      // working, while the existing Fix failed sessions flow remains available for offline access.
      log(`${prefix}: not replayable yet (${error.message}).`, 'warn');
    }
  }, delayMs);
  timer.unref?.();
  savedFriendValidationTimers.set(account.id, timer);
}

const appearOfflineState = new AppearOfflineState();

const manager = new AccountManager({
  lcuClient: lcu,
  log,
  onSwitched: ({ account }) => {
    if (appearOfflineState.completeSuccessfulSwitch()) broadcastAppearOffline();
    monitor?.kick();
    detectedCurrentId = account?.id ?? null;
    recordDetectedLogin(account?.id, { force: true, reason: 'switch' });
    rebuildTray();
    sendAccountsChanged();
    // League is just booting; give it a head start, the retry loop absorbs the rest.
    scheduleRankRefresh(8_000, 'post-switch');
    // Burst mode sweeps quickly during client boot so acknowledgements land before the freshly
    // started renderer latches its header pips.
    scheduleClientCleanup(3_000, { burst: true });
    queueRelay?.kick();
    chatService?.disconnectSources('active account switched').catch((error) => log(`Chat: transport reset failed (${error.message}).`, 'warn'));
  },
  onSessionCaptured: scheduleSavedFriendSessionValidation,
  // Apply/release the shared in-game settings baseline across a switch (only while sync is on).
  settingsSync: {
    // Returns true when the baseline was copied in and the Config files were locked read-only, so
    // the manager knows a matching release() is owed.
    apply: () => {
      if (!settings.syncSettings || !hasBaseline()) return false;
      const applied = applyBaseline(effectiveLeaguePath());
      if (applied) log('Settings sync: applied baseline and locked Config.');
      return applied;
    },
    release: () => {
      if (!settings.syncSettings) return;
      unlockConfig(effectiveLeaguePath());
      log('Settings sync: released Config lock.');
    }
  }
});

// "Appear offline" is a transient, consume-on-successful-switch toggle — it is intentionally NOT
// persisted. When armed with no client running it becomes active only after the first account switch
// completes. A failed or rejected switch leaves the current intent unchanged.
const desiredOffline = () => appearOfflineState.desired;

// The account detected as signed-in at startup (used to re-apply settings on the current account).
let detectedCurrentId = null;
// A watcher polls the gameflow phase to catch the end of a game. It always runs: game end triggers a
// ranked-stats refresh for the current account, and — while settings sync is on — a baseline
// auto-update (in-game settings changes are only written to Config when the match exits). We only
// auto-capture the baseline when the account was tracking it at game start (guards against
// overwriting it with a manually-launched, non-baseline account's settings). "Update baseline" pressed
// mid-game rides the same watcher (it captures unconditionally once the game ends).
let baselineGameWatcher = null; // interval handle; always running
let baselineWasInGame = false; // previous tick's in-game state, for edge detection
let baselineMatchedAtGameStart = false; // did live match the baseline when this game started?
let pendingManualBaselineCapture = false; // a mid-game "Update baseline" click is waiting for game end
let pendingGameStatsCapture = false; // retry game/session metadata until the new live game is identifiable
let gameWatcherTickRunning = false;
// Startup-only notice: the live Config differs from the baseline (a different account was launched
// manually). { show, canApply } — surfaced as a dismissible banner in the renderer.
let settingsNotice = { show: false, canApply: false };
let friendRepairBusy = false;
let suppressRepairLoginStats = false;

// Is a League client currently running? Its lockfile exists only while it's up.
function isLeagueRunning() {
  try {
    return fs.existsSync(path.join(effectiveLeaguePath(), 'lockfile'));
  } catch {
    return false;
  }
}

const monitor = new ClientMonitor({
  lcu,
  log,
  getAutoAccept: () => settings.autoAccept,
  getAcceptDelayMs: () => settings.autoAcceptDelayMs,
  getDesiredOffline: desiredOffline,
  onAutoAccepted: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('autoAccept:accepted');
  }
});

let lastQueueRelayIdentityMatch = '';
async function resolveQueueRelayAccount() {
  const accounts = manager.listAccounts();
  const current = accounts.find((account) => account.isCurrent);
  try {
    const identity = await fetchCurrentSummonerIdentity(lcu);
    const liveRiotId = formatRiotId(identity?.gameName, identity?.tagLine);
    if (!liveRiotId) return current || null;
    const match = findAccountByRiotIdentity(accounts, liveRiotId);
    if (match) {
      if (lastQueueRelayIdentityMatch !== match.id) {
        lastQueueRelayIdentityMatch = match.id;
        log(`Queue relay: matched active saved account by Riot ID account=${match.label}.`);
      }
      return match;
    }
    const live = parseRiotIdentity(liveRiotId);
    const sameGameNameCount = accounts.filter((account) =>
      parseRiotIdentity(account.lastSummonerName).normalizedGameName === live.normalizedGameName).length;
    if (sameGameNameCount > 0) {
      log(`Queue relay: Riot identity matched ${sameGameNameCount} saved game name${sameGameNameCount === 1 ? '' : 's'} but no unique tag; refusing ambiguous relay auth.`, 'warn');
    }
    return null;
  } catch {
    // League may be signed out or still starting. The relay tick retries without affecting the app.
  }
  return current || null;
}

async function getQueueRelayXmppAuth(accountId, { log: authLog = () => {} } = {}) {
  try {
    return await getLiveClientXmppAuth(lcu, { log: authLog });
  } catch (liveError) {
    authLog(`live-client auth unavailable (${liveError.message}); trying the saved-session fallback`, 'warn');
    try {
      const saved = await getSavedFriendXmppAuth(accountId, { log: authLog });
      return { ...saved, source: 'saved-session' };
    } catch (savedError) {
      throw new Error(`Live client: ${liveError.message} Saved-session fallback: ${savedError.message}`);
    }
  }
}

async function getLiveFriendAuthOverrides(accountIds, authLog) {
  const active = await resolveQueueRelayAccount();
  if (!active?.id || !accountIds.includes(active.id)) return new Map();
  try {
    const authOverride = await createLiveFriendAuthOverride(active, {
      getCredentials: (force) => getLiveClientXmppAuth(lcu, { log: authLog, force }),
      log: authLog
    });
    return new Map([[active.id, authOverride]]);
  } catch (error) {
    authLog(`live League credentials unavailable for current Friends source=${active.label} (${error.message}); using its saved session`, 'warn');
    return new Map();
  }
}

queueRelay = new QueueRelayService({
  lcu,
  log,
  getActiveAccount: resolveQueueRelayAccount,
  getXmppAuth: getQueueRelayXmppAuth,
  getAllowedPuuids: () => settings.queueRelayAllowedPuuids || [],
  onEvent: (event) => handleQueueRelayEvent(event)
});

async function createChatTransport({ account, onMessage, onPresence, onClose }) {
  const active = await resolveQueueRelayAccount();
  if (active?.id === account.id && isLeagueRunning()) {
    const credentials = await getLiveClientXmppAuth(lcu, { log: (message, level) => log(`Chat live auth: ${message}`, level) });
    return new LcuChatTransport({
      accountId: account.id,
      lcu,
      selfPuuid: credentials.identity?.puuid,
      domain: credentials.endpoint?.domain,
      log,
      onMessage,
      onPresence,
      onClose
    });
  }
  return new DirectXmppChatTransport({
    accountId: account.id,
    getCredentials: (accountId) => getSavedFriendXmppAuth(accountId, { log: (message, level) => log(`Chat saved auth: ${message}`, level) }),
    log,
    onMessage,
    onPresence,
    onClose
  });
}

chatService = new ChatService({
  getAccount: (accountId) => manager.listAccounts().find((account) => account.id === accountId) || null,
  createTransport: createChatTransport,
  getLeaseMs: () => settings.chatOnlineLeaseMs,
  log,
  onChanged: (state) => scheduleChatStateSave(state),
  onEvent: (event) => handleChatEvent(event)
});

cleanupMonitor = new ClientCleanupMonitor({
  lcu,
  log,
  getEnabled: () => settings.autoClientCleanup,
  clearHeaderIndicators: createLayeredHeaderClear({ log }),
  clearActivityCenterIndicators: clearLeagueActivityCenterIndicatorsBackground
});

function scheduleClientCleanup(delayMs = 0, kickOptions = undefined) {
  if (cleanupSwitchTimer) clearTimeout(cleanupSwitchTimer);
  cleanupSwitchTimer = setTimeout(() => {
    cleanupSwitchTimer = null;
    cleanupMonitor?.kick(kickOptions);
  }, delayMs);
  cleanupSwitchTimer.unref?.();
}

let mainWindow = null;
let helpWindow = null;
let tray = null;
let isQuitting = false;
let statusTimer = null;
let updateCheckTimer = null;
let shutdownPromise = null;
let shutdownComplete = false;

const updater = createUpdater({
  log,
  broadcast: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
  },
  isBusy: () => manager.getStatus().busy,
  getAutoUpdate: () => settings.autoUpdate
});

// ---------------------------------------------------------------------------
// Single instance — a tray app sharing one store must not run twice.
// ---------------------------------------------------------------------------
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.setAppUserModelId('com.merforth.league-account-switcher');
  app.whenReady().then(onReady);
}

async function onReady() {
  Menu.setApplicationMenu(null); // no native menu bar; this is a focused utility window
  ensureLogFile();
  pruneOldLogs(LOG_RETENTION_DAYS);
  logStartupDiagnostics();
  setInterval(() => pruneOldLogs(LOG_RETENTION_DAYS), 6 * 60 * 60 * 1000).unref();

  chatService.hydrate(await loadChatState({ log }));
  applyLoginItem(settings.startWithWindows);
  createMainWindow();
  createTray();
  if (SELFTEST) {
    runSelfTest();
    return;
  }
  if (!STARTED_HIDDEN) showMainWindow();
  // Best-effort: reflect an already-signed-in account in the UI/tray.
  observeCurrentLogin({ startup: true }).then((id) => {
    detectedCurrentId = id ?? null;
    log(`Startup: detected active account=${id ?? 'none'}.`);
    rebuildTray();
    sendAccountsChanged();
    checkSettingsBaselineOnStartup();
    if (id && isLeagueRunning()) scheduleRankRefresh(3_000, 'startup');
    queueRelay.kick();
  });

  // Update checks: once on launch, then every 10 minutes while running.
  updater.checkForUpdates(false);
  updateCheckTimer = setInterval(() => updater.checkForUpdates(false), 10 * 60 * 1000);
  updateCheckTimer.unref();

  // Start the live-client loop if auto-accept was left on (it's a persisted global setting).
  monitor.kick();
  // The cleanup monitor is deliberately slower and separate from auto-accept's latency-sensitive loop.
  cleanupMonitor.kick();
  // Watch for game ends: refreshes ranked stats, and auto-updates the baseline while sync is on.
  startGameWatcher();
  queueRelay.start();
}

// A snapshot of the environment written to the log at every launch — the first thing to check when a
// friend reports a problem (wrong League path, Riot not installed where expected, etc.).
function logStartupDiagnostics() {
  try {
    const leaguePath = lcu.leaguePath;
    const leagueLockfile = path.join(leaguePath, 'lockfile');
    const services = resolveRiotClientServicesPath();
    log(`Startup: League Account Switcher v${app.getVersion()} pid=${process.pid} hidden=${STARTED_HIDDEN}.`);
    log(`Startup: configDir=${getConfigDir()}; accounts=${manager.listAccounts().length}.`);
    log(`Startup: leaguePath=${leaguePath} (setting=${settings.leaguePath}; lockfile exists=${fs.existsSync(leagueLockfile)}).`);
    log(`Startup: riotSessionFile=${getRiotSessionFilePath()} (exists=${fs.existsSync(getRiotSessionFilePath())}).`);
    log(`Startup: riotLockfile=${getRiotLockfilePath()} (running=${fs.existsSync(getRiotLockfilePath())}).`);
    log(`Startup: riotClientServices=${services} (exists=${fs.existsSync(services)}).`);
  } catch (error) {
    log(`Startup diagnostics failed: ${error.message}`, 'warn');
  }
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
        const api = await wc.executeJavaScript(
          '!!(window.api && window.api.switchAccount && window.api.runClientCleanupOnce && window.api.runClientCleanupDeepOnce)'
        );
        const opts = await wc.executeJavaScript('document.querySelectorAll("#defaultRegion option").length');
        const region = await wc.executeJavaScript('document.getElementById("defaultRegion").value');
        out(`preload-api=${api} regionOptions=${opts} defaultRegion=${region}`);
        const updateUi = await wc.executeJavaScript(
          '!!(window.api.checkForUpdate && document.getElementById("updateBanner") && document.getElementById("checkUpdateBtn") && document.getElementById("autoUpdate"))'
        );
        const cleanupUi = await wc.executeJavaScript(
          '!!(document.getElementById("autoClientCleanup") && document.getElementById("clientCleanupNowBtn") && document.getElementById("clientCleanupDeepBtn"))'
        );
        const chatUi = await wc.executeJavaScript(
          '!!(window.api.getChatState && window.api.openChat && document.getElementById("tabChat") && document.getElementById("chatComposer"))'
        );
        const devCheck = await wc.executeJavaScript('window.api.checkForUpdate().then(() => "ok").catch(e => "err:" + e.message)');
        out(`update-ui=${updateUi} cleanup-ui=${cleanupUi} chat-ui=${chatUi} dev-check=${devCheck}`);
        const sections = await wc.executeJavaScript(
          'JSON.stringify({ sections: document.querySelectorAll(".section").length, names: [...document.querySelectorAll(".section-name")].map(n => n.textContent), cardsInSections: document.querySelectorAll(".section-body .account-card").length, addBtn: !!document.querySelector(".add-section") })'
        );
        out(`sections=${sections}`);
      } catch (error) {
        out(`probe-error: ${error.message}`);
      }
      if (process.env.LAS_SHOT) {
        try {
          mainWindow.show();
          // Demo-only: surface the update banner so the screenshot showcases the feature.
          if (process.env.LAS_SHOT_UPDATE) {
            mainWindow.webContents.send('update:status', { state: 'available', version: '1.0.1' });
          }
          if (process.env.LAS_SELFTEST_TAB === 'friends') {
            await wc.executeJavaScript('document.getElementById("tabFriends").click()');
          } else if (process.env.LAS_SELFTEST_TAB === 'chat') {
            await wc.executeJavaScript('document.getElementById("tabChat").click()');
          }
          await new Promise((r) => setTimeout(r, 500));
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
app.on('before-quit', (event) => {
  isQuitting = true;
  if (!shutdownComplete) event.preventDefault();
  queueRelay?.stop();
  monitor.stop();
  cleanupMonitor?.stop();
  if (cleanupSwitchTimer) clearTimeout(cleanupSwitchTimer);
  if (shutdownComplete || shutdownPromise) return;
  shutdownPromise = (async () => {
    await manager.releaseSettingsForShutdown();
    await chatService?.stop();
    await flushChatStateSave();
  })().catch((error) => {
    log(`Shutdown cleanup failed (${error.message}).`, 'warn');
  }).finally(() => {
    try {
      flushPendingLogs();
    } catch {
      // Best-effort during shutdown; logging must not prevent the app from quitting.
    }
    shutdownComplete = true;
    app.quit();
  });
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

  // Order/group the tray the same way as the window: Unordered first, then each section.
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const layout = reconcileLayout(loadLayout(), accounts.map((account) => account.id));
  const makeItem = (account) => ({
    label: trayAccountLabel(account),
    type: 'checkbox',
    checked: account.isCurrent,
    enabled: !busy,
    click: () => safeBeginSwitch(account.id)
  });
  const grouped = [];
  for (const id of layout.top) {
    const account = byId.get(id);
    if (account) grouped.push(makeItem(account));
  }
  for (const section of layout.sections) {
    const items = section.accountIds.map((id) => byId.get(id)).filter(Boolean);
    if (!items.length) continue;
    grouped.push({ type: 'separator' });
    grouped.push({ label: section.name, enabled: false });
    for (const account of items) grouped.push(makeItem(account));
  }
  const accountItems = accounts.length ? grouped : [{ label: 'No accounts yet — open to add one', enabled: false }];

  const template = [
    { label: active ? `Active: ${active.label}` : 'No active account', enabled: false },
    busy ? { label: `Switching: ${status.message}`, enabled: false } : null,
    { type: 'separator' },
    { label: busy ? 'Switch to… (busy)' : 'Switch to…', enabled: false },
    ...accountItems,
    { type: 'separator' },
    { label: 'Open', click: () => showMainWindow() },
    { label: 'Help', click: () => openHelpWindow() },
    { label: 'Open logs', click: () => openLogs() },
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

// Open the log file in the user's default text editor so they can send it for debugging.
function openLogs() {
  try {
    ensureLogFile();
    pruneOldLogs(LOG_RETENTION_DAYS);
    shell.openPath(getLogPath());
  } catch (error) {
    log(`Open logs failed: ${error.message}`, 'warn');
  }
}

// A tray balloon notification — the only progress feedback when the window is closed to the tray.
function notify(content, iconType = 'info') {
  if (!tray) return;
  try {
    tray.displayBalloon({ title: 'League Account Switcher', content, iconType, icon: loadIcon(ICON_PNG) });
  } catch (error) {
    log(`Notification failed: ${error.message}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Switch orchestration + status streaming (replaces the webapp's HTTP polling)
// ---------------------------------------------------------------------------
function beginSwitch(id, force = false, forceLogin = false) {
  // Starting an attempt must not consume Appear Offline. The post-success hook resolves whether an
  // armed state applies to this account or an active state ends for the account switched away from.
  const status = appearOfflineState.startSwitch(
    () => manager.startSwitch(id, { force, forceLogin }) // throws if busy / not found
  );
  monitor.kick();
  broadcastStatus(status);
  rebuildTray();
  startStatusPump();
  return status;
}

function beginRepairManagedSwitch(id, options) {
  const status = manager.startSwitch(id, options);
  monitor.kick();
  broadcastStatus(status);
  rebuildTray();
  startStatusPump();
  return status;
}

async function waitForManagedSwitch() {
  while (manager.getStatus().busy) await new Promise((resolve) => setTimeout(resolve, 250));
  const status = manager.getStatus();
  if (status.stage === 'error') throw new Error(status.message || 'Account login failed.');
  return status;
}

async function restartCurrentSwitch() {
  const status = await manager.restartCurrentSwitch();
  monitor.kick();
  broadcastStatus(status);
  rebuildTray();
  startStatusPump();
  return status;
}

// Tray-initiated switches do NOT open the window — progress shows in the tray (tooltip/menu) and via
// balloon notifications. The user opens the window themselves to see full progress / handle a captcha.
function safeBeginSwitch(id) {
  try {
    const status = beginSwitch(id, false);
    notify(`Switching to ${status.label}…`, 'info');
  } catch (error) {
    log(`Tray switch failed: ${error.message}`, 'warn');
    notify(error.message, 'warning');
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
      if (!friendRepairBusy) updater.onIdle(); // deferred updates wait for the whole repair batch
      // If the window is closed to the tray, the balloon is the only completion feedback.
      if ((!mainWindow || !mainWindow.isVisible()) && !friendRepairBusy) {
        notify(status.message, status.stage === 'error' ? 'error' : 'info');
      }
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

function broadcastChatState(state = chatService.snapshot()) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:update', state);
}

function handleChatEvent(event) {
  if (event?.type === 'state') broadcastChatState(event.state);
  if (event?.type === 'message' && (!mainWindow || !mainWindow.isVisible())) {
    notify(`${event.sourceLabel} → ${event.friend}: ${String(event.body || '').slice(0, 120)}`);
  }
}

function scheduleChatStateSave(state = chatService.persistedState()) {
  if (chatStateSaveTimer) clearTimeout(chatStateSaveTimer);
  chatStateSaveTimer = setTimeout(() => {
    chatStateSaveTimer = null;
    chatStateSaveChain = chatStateSaveChain
      .then(() => saveChatState(state))
      .catch((error) => log(`Chat: encrypted history save failed (${error.message}).`, 'warn'));
  }, 250);
  chatStateSaveTimer.unref?.();
}

async function flushChatStateSave() {
  if (chatStateSaveTimer) {
    clearTimeout(chatStateSaveTimer);
    chatStateSaveTimer = null;
    const state = chatService.persistedState();
    chatStateSaveChain = chatStateSaveChain
      .then(() => saveChatState(state))
      .catch((error) => log(`Chat: encrypted history save failed (${error.message}).`, 'warn'));
  }
  await chatStateSaveChain;
}

function statsAccountOrderIds() {
  const layout = reconcileLayout(loadLayout(), accountIds());
  return [
    ...(layout.top || []),
    ...(layout.sections || []).flatMap((section) => section.accountIds || [])
  ];
}

function getStatsSnapshot() {
  return accountStatsSummary(accountStats, manager.listAccounts(), statsAccountOrderIds());
}

function broadcastStatsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stats:changed', getStatsSnapshot());
  }
}

function persistAccountStats(next, context) {
  accountStats = next;
  try {
    accountStats = saveAccountStats(next);
    return true;
  } catch (error) {
    log(`Stats: could not save ${context} (${error.message}).`, 'warn');
    return false;
  }
}

function recordDetectedLogin(accountId, { force = false, reason = 'detected' } = {}) {
  const id = String(accountId || '').trim();
  if (!id) {
    loginObservationTracker.observe(null);
    return false;
  }
  if (!shouldCountLoginDuringFriendRepair(suppressRepairLoginStats)) {
    loginObservationTracker.observe(id, { force });
    return false;
  }
  if (!loginObservationTracker.observe(id, { force })) return false;
  const result = incrementLoginCount(accountStats, id);
  if (!result.changed) return false;
  persistAccountStats(result.stats, 'login count');
  const count = accountStats.accounts[id]?.loginCount || 0;
  const label = manager.listAccounts().find((account) => account.id === id)?.label || id;
  log(`Stats: counted login account=${label} reason=${reason} total=${count}.`);
  broadcastStatsChanged();
  return true;
}

async function observeCurrentLogin({ startup = false } = {}) {
  if (manager.getStatus().busy) return manager.currentAccountId;
  const previousId = manager.currentAccountId;
  const id = await manager.detectCurrent();
  detectedCurrentId = id ?? null;
  if (!id) {
    loginObservationTracker.observe(null);
  } else {
    recordDetectedLogin(id, { force: startup, reason: startup ? 'startup' : 'manual-detection' });
  }
  if (previousId !== id) {
    rebuildTray();
    sendAccountsChanged();
  }
  return id;
}

function broadcastAppearOffline() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('appearOffline:update', { on: appearOfflineState.on });
  }
}

function broadcastSettingsNotice() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settingsSync:notice', settingsNotice);
  }
}

function broadcastBaselineUpdated(meta) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settingsSync:baselineUpdated', meta);
  }
}

function handleQueueRelayEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queueRelay:update', event.type === 'status' ? event.status : queueRelay.getStatus());
  }
  if (event.type === 'queue-started-local') {
    notify(event.message || 'A permitted friend started matchmaking through Queue Relay.', 'info');
  }
}

// If the user quit the app and later launched a different account manually, the live Config no longer
// matches the baseline. We never auto-relaunch on startup — just surface a dismissible notice offering
// to apply now (force-switch the current account) or let it apply on the next real switch.
function checkSettingsBaselineOnStartup() {
  try {
    if (!settings.syncSettings || !hasBaseline() || !isLeagueRunning()) return;
    if (baselineMatchesLive(effectiveLeaguePath())) return;
    settingsNotice = { show: true, canApply: Boolean(detectedCurrentId) };
    broadcastSettingsNotice();
    log('Settings sync: live Config differs from baseline; offering to apply.');
  } catch (error) {
    log(`Settings sync: startup check failed: ${error.message}`, 'warn');
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

ipcMain.handle('accounts:remove', async (_event, id) => {
  const removed = manager.remove(id);
  await chatService.removeAccount(id);
  const result = removeAccountStatistics(accountStats, id);
  if (result.changed) {
    persistAccountStats(result.stats, 'account removal');
    broadcastStatsChanged();
  }
  rebuildTray();
  return removed;
});

ipcMain.handle('accounts:capture', async (_event, payload) => {
  const { id, force = false } = (payload && typeof payload === 'object') ? payload : { id: payload };
  const result = await manager.captureCurrent(id, { force });
  rebuildTray();
  return result;
});

// Best-effort: who is the Riot Client currently signed in as (for the capture confirmation)?
ipcMain.handle('accounts:signed-in-name', () => manager.riot.getSignedInName().catch(() => null));

ipcMain.handle('accounts:switch', (_event, payload) => {
  const { id, force = false, forceLogin = false } = payload ?? {};
  return beginSwitch(id, force, forceLogin);
});

ipcMain.handle('accounts:restart-current-switch', () => restartCurrentSwitch());

ipcMain.handle('stats:get', () => getStatsSnapshot());

ipcMain.handle('chat:get', () => chatService.snapshot());
ipcMain.handle('chat:open', (_event, payload = {}) => chatService.openConversation(payload));
ipcMain.handle('chat:select', (_event, key) => chatService.selectConversation(key));
ipcMain.handle('chat:send', (_event, payload = {}) => chatService.sendMessage(payload.key, payload.body));
ipcMain.handle('chat:draft', (_event, payload = {}) => chatService.setDraft(payload.key, payload.draft));
ipcMain.handle('chat:close', (_event, key) => chatService.closeConversation(key));
ipcMain.handle('chat:view-active', (_event, active) => chatService.setViewActive(active));

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('queueRelay:status', () => queueRelay.getStatus());

ipcMain.handle('queueRelay:set-permission', (_event, payload = {}) => {
  const puuid = String(payload.puuid || '').trim().toLowerCase();
  if (!puuid) throw new Error('A Riot PUUID is required.');
  const next = new Set(settings.queueRelayAllowedPuuids || []);
  if (payload.allowed) next.add(puuid);
  else next.delete(puuid);
  settings = saveSettings({ ...settings, queueRelayAllowedPuuids: [...next] });
  log(`Queue relay: permission ${payload.allowed ? 'allowed' : 'revoked'} peer=${puuid.slice(0, 8)}.`);
  queueRelay.kick();
  return queueRelay.getStatus();
});

ipcMain.handle('queueRelay:start-via-leader', () => queueRelay.startViaLeader());

ipcMain.handle('settings:set', (_event, patch) => {
  const autoUpdateWasOff = !settings.autoUpdate;
  const autoCleanupWasOff = !settings.autoClientCleanup;
  const previousChatOnlineLeaseMs = settings.chatOnlineLeaseMs;
  settings = saveSettings({ ...settings, ...(patch ?? {}) });
  lcu.setLeaguePath(effectiveLeaguePath());
  applyLoginItem(settings.startWithWindows);
  // If the user just turned Auto update on and an update is already pending, act on it now.
  if (settings.autoUpdate && autoUpdateWasOff) updater.onAutoUpdateEnabled();
  // Pick up auto-accept / delay changes (starts or stops the poll loop as needed).
  monitor.kick();
  // Enabling cleanup runs immediately; disabling it stops its background timer. Unrelated setting
  // changes do not force an extra cleanup between the normal 30-second ticks.
  if (!settings.autoClientCleanup) cleanupMonitor.stop();
  else if (autoCleanupWasOff) cleanupMonitor.kick();
  if (settings.chatOnlineLeaseMs !== previousChatOnlineLeaseMs) chatService.refreshActiveLeases();
  return settings;
});

ipcMain.handle('clientCleanup:runOnce', () => cleanupMonitor.runOnce());
ipcMain.handle('clientCleanup:runDeepOnce', () => cleanupMonitor.runDeepOnce());

// --- Appear offline (transient, not persisted) ---
ipcMain.handle('appearOffline:get', () => ({ on: appearOfflineState.on }));

ipcMain.handle('appearOffline:set', async (_event, on) => {
  if (on) {
    // If a client is already up, apply offline now; otherwise arm it for the first account switched to.
    appearOfflineState.setEnabled(true, { clientRunning: isLeagueRunning() });
  } else {
    appearOfflineState.setEnabled(false);
    // Best-effort: flip chat back to online immediately if a client is connected.
    try {
      await lcu.put('/lol-chat/v1/me', { availability: 'chat' });
    } catch {
      // Chat not connected (or no client) — nothing to revert.
    }
  }
  monitor.kick();
  broadcastAppearOffline();
  return { on: appearOfflineState.on };
});

// --- Settings sync (persist in-game settings across accounts) ---
// Best label for the account whose settings we're snapshotting: the switcher's own label when it
// recognises the signed-in account, otherwise the live Riot ID from the client.
async function currentAccountLabel() {
  try {
    const current = manager.listAccounts().find((account) => account.isCurrent);
    if (current?.label) return current.label;
  } catch {
    // fall through to the LCU lookup
  }
  try {
    const summoner = await lcu.get('/lol-summoner/v1/current-summoner');
    const name = String(summoner?.gameName || '').trim();
    if (name) return name;
  } catch {
    // client not reachable — leave it unlabelled
  }
  return null;
}

ipcMain.handle('settingsSync:get', () => ({
  on: settings.syncSettings,
  hasBaseline: hasBaseline(),
  ...getBaselineMeta(),
  notice: settingsNotice
}));

ipcMain.handle('settingsSync:set', async (_event, on) => {
  if (on) {
    // First-time activation needs a real, logged-in account to snapshot — otherwise the baseline
    // would capture empty/garbage files. Reuse any existing baseline without requiring a client.
    if (!hasBaseline()) {
      const leagueRunning = isLeagueRunning();
      if (!leagueRunning) {
        return { on: false, hasBaseline: false, capturedAt: null, account: null,
          error: 'Log into the account whose settings you want as the baseline, then turn this on.' };
      }
      const captureDisposition = settingsBaselineCaptureDisposition(leagueRunning, await currentGameflowPhase());
      if (captureDisposition === 'unknown') {
        return { on: false, hasBaseline: false, capturedAt: null, account: null,
          error: 'League’s game status could not be checked. Try again before capturing the settings baseline.' };
      }
      if (captureDisposition === 'in-game' || captureDisposition === 'post-game') {
        return { on: false, hasBaseline: false, capturedAt: null, account: null,
          error: 'Finish the current game and post-game screen before turning on settings sync.' };
      }
      const account = await currentAccountLabel();
      captureBaseline(effectiveLeaguePath(), { capturedAt: new Date().toISOString(), account });
      log(`Settings sync: captured baseline from ${account ?? 'the current account'}.`);
    }
    settings = saveSettings({ ...settings, syncSettings: true });
    startGameWatcher(); // normally already running; arm it defensively
  } else {
    settings = saveSettings({ ...settings, syncSettings: false });
    unlockConfig(effectiveLeaguePath()); // drop any read-only lock we left behind
    // The watcher keeps running (rank refreshes need it) — just drop any queued post-game capture.
    pendingManualBaselineCapture = false;
    log('Settings sync: turned off.');
  }
  return { on: settings.syncSettings, hasBaseline: hasBaseline(), ...getBaselineMeta() };
});

const BASELINE_AFTER_GAME_POLL_MS = 5_000;
// Brief settle after the match exits so the game's on-close write of game.cfg/input.ini completes.
const BASELINE_AFTER_GAME_SETTLE_MS = 4_000;

async function currentGameflowPhase() {
  try {
    return await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    return null; // League not reachable
  }
}

async function captureBaselineNow() {
  const account = await currentAccountLabel();
  const meta = captureBaseline(effectiveLeaguePath(), { capturedAt: new Date().toISOString(), account });
  log(`Settings sync: baseline updated from ${account ?? 'the current account'}.`);
  return { ...meta, hasBaseline: hasBaseline() };
}

// Poll the gameflow phase so a game's end can be detected. Always on: ranked stats refresh after every
// game; the baseline capture additionally rides it while sync is on. Idempotent — safe to call on
// startup, on sync enable, and from the mid-game manual click.
function startGameWatcher() {
  if (baselineGameWatcher) return;
  baselineWasInGame = false;
  baselineGameWatcher = setInterval(gameWatcherTick, BASELINE_AFTER_GAME_POLL_MS);
  baselineGameWatcher.unref?.();
}

async function gameWatcherTick() {
  if (gameWatcherTickRunning) return;
  gameWatcherTickRunning = true;
  try {
    const accountId = await observeCurrentLogin();
    const phase = await currentGameflowPhase();
    const transition = gameWatcherTransition(baselineWasInGame, phase);
    if (!transition.known) return;
    const inGame = transition.inGame;
    if (transition.started) {
      pendingGameStatsCapture = true;
      // Game just started: remember whether we're tracking the baseline on this account, so a post-game
      // divergence can be attributed to the user's in-game tweak (vs a manually-launched other account).
      if (settings.syncSettings) baselineMatchedAtGameStart = baselineMatchesLive(effectiveLeaguePath());
    }
    if (inGame && pendingGameStatsCapture) {
      await capturePendingGameStats(accountId);
    } else if (transition.ended) {
      pendingGameStatsCapture = false;
      captureBaselineAfterGame(); // self-guards on settings.syncSettings inside its settle timer
      // Post-game rewards and unlocks can land across several client phases. Start the same fast
      // cleanup burst used after an account switch; blocked phases (such as WaitingForStats) only
      // get polled and are never cleaned, then the first safe phase is handled without a 30s wait.
      scheduleClientCleanup(0, { burst: true });
      // LP only lands once the client finishes the end-of-game flow; fetch twice to catch a late update.
      for (const delayMs of RANK_POST_GAME_DELAYS_MS) scheduleRankRefresh(delayMs, 'post-game');
    }
    baselineWasInGame = inGame;
  } finally {
    gameWatcherTickRunning = false;
  }
}

async function capturePendingGameStats(accountId) {
  const liveAccount = await resolveQueueRelayAccount().catch(() => null);
  const resolvedAccountId = liveAccount?.id || accountId;
  if (!resolvedAccountId) return;
  let session;
  try {
    session = await lcu.get('/lol-gameflow/v1/session');
  } catch {
    return; // the gameflow plugin can lag behind the phase endpoint; retry on the next existing tick
  }
  const gameData = session?.gameData || {};
  const gameId = String(gameData.gameId ?? session?.gameId ?? '').trim();
  const queue = gameData.queue || session?.queue || {};
  const hasQueueMetadata = [queue.id, queue.queueId, queue.type, queue.queueType, queue.name, queue.gameMode]
    .some((value) => value !== null && value !== undefined && String(value).trim());
  if (!gameId || !hasQueueMetadata) return;

  const result = recordStartedGame(accountStats, resolvedAccountId, { gameId, queue });
  if (result.duplicate) {
    pendingGameStatsCapture = false;
    return;
  }
  if (!result.changed) return;
  persistAccountStats(result.stats, 'game count');
  pendingGameStatsCapture = false;
  const record = accountStats.accounts[resolvedAccountId];
  const queueCount = record?.gamesByQueue?.[result.queue.key]?.count || 0;
  const label = manager.listAccounts().find((account) => account.id === resolvedAccountId)?.label || resolvedAccountId;
  log(`Stats: counted game account=${label} gameId=${gameId} queue=${result.queue.label} queueTotal=${queueCount}.`);
  broadcastStatsChanged();
}

// ---------------------------------------------------------------------------
// Ranked stats — fetched from the LCU after switches and games, stored per account, and shown as
// rank crests on the account cards.
// ---------------------------------------------------------------------------
const RANK_FETCH_RETRY_MS = 5_000;
const RANK_FETCH_MAX_ATTEMPTS = 24; // ~2 minutes — covers the client's slow post-login plugin load
const RANK_POST_GAME_DELAYS_MS = [15_000, 90_000];
let rankRefreshToken = 0; // newest refresh wins; superseded loops abort

async function refreshCurrentAccountRanks(reason) {
  const token = ++rankRefreshToken;
  // Re-sync against the signed-in name first (catches manual logins between known accounts), then
  // snapshot: results must go to THIS account even if a switch happens mid-loop.
  const accountId = await manager.detectCurrent();
  if (!accountId) return;
  if (token !== rankRefreshToken) return; // a newer refresh started while detecting
  let identityUpdated = false;
  let ranksUpdated = false;
  for (let attempt = 1; attempt <= RANK_FETCH_MAX_ATTEMPTS; attempt += 1) {
    if (token !== rankRefreshToken) return; // superseded by a newer refresh
    if (manager.currentAccountId !== accountId) return; // switched away mid-loop
    if (!identityUpdated) {
      try {
        const identity = await fetchCurrentSummonerIdentity(lcu);
        if (identity?.gameName) {
          const riotId = formatRiotId(identity.gameName, identity.tagLine);
          const updated = manager.setLastSummonerName(accountId, riotId);
          if (updated) {
            sendAccountsChanged();
            log(`Summoner: updated stored Riot identity (${reason}).`);
          }
          identityUpdated = true;
        }
      } catch {
        // League not reachable (yet) — retry with the rank fetch.
      }
    }
    if (!ranksUpdated) {
      try {
        const ranks = await fetchCurrentRanks(lcu);
        if (ranks) {
          manager.setRanks(accountId, ranks);
          sendAccountsChanged();
          log(`Ranks: updated (${reason}) — solo=${ranks.solo?.tier ?? 'unranked'} flex=${ranks.flex?.tier ?? 'unranked'}.`);
          ranksUpdated = true;
        }
      } catch {
        // League not reachable (yet) — retry.
      }
    }
    if (identityUpdated && ranksUpdated) return;
    await new Promise((resolve) => setTimeout(resolve, RANK_FETCH_RETRY_MS));
  }
  if (!ranksUpdated) log(`Ranks: gave up after ${RANK_FETCH_MAX_ATTEMPTS} attempts (${reason}).`, 'warn');
  if (!identityUpdated) log(`Summoner: gave up after ${RANK_FETCH_MAX_ATTEMPTS} attempts (${reason}).`, 'warn');
}

function scheduleRankRefresh(delayMs, reason) {
  const timer = setTimeout(() => refreshCurrentAccountRanks(reason), delayMs);
  timer.unref?.();
}

// Called once on the in-game -> not-in-game transition. Waits for the game's on-exit write to land, then
// captures the baseline if a manual update is pending, or (auto) if the tracked baseline actually changed.
function captureBaselineAfterGame() {
  const manual = pendingManualBaselineCapture;
  pendingManualBaselineCapture = false;
  const matchedAtStart = baselineMatchedAtGameStart;
  const settle = setTimeout(async () => {
    try {
      if (!settings.syncSettings || !isLeagueRunning()) {
        // sync off / client gone meanwhile
        if (manual) log('Settings sync: deferred baseline update dropped (League closed before it could be captured).', 'warn');
        return;
      }
      if (!manual) {
        // Auto path: only touch the baseline if this account was tracking it and the settings changed.
        if (!matchedAtStart) return;
        if (baselineMatchesLive(effectiveLeaguePath())) return;
      }
      broadcastBaselineUpdated(await captureBaselineNow());
    } catch (error) {
      log(`Settings sync: post-game baseline capture failed: ${error.message}`, 'warn');
    }
  }, BASELINE_AFTER_GAME_SETTLE_MS);
  settle.unref?.();
}

ipcMain.handle('settingsSync:updateBaseline', async () => {
  const leagueRunning = isLeagueRunning();
  if (!leagueRunning) {
    return { error: 'Log into the account whose settings should be the new baseline, then update.' };
  }
  const phase = await currentGameflowPhase();
  const captureDisposition = settingsBaselineCaptureDisposition(leagueRunning, phase);
  if (captureDisposition === 'unknown') {
    return { error: 'League’s game status could not be checked. Try again before updating the settings baseline.' };
  }
  if (captureDisposition === 'post-game') {
    return { error: 'Wait for the post-game screen to finish, then update the settings baseline.' };
  }
  if (captureDisposition === 'in-game') {
    // Capturing now would miss the in-game changes (only written when the match exits) — ride the
    // watcher and capture unconditionally once the game ends.
    pendingManualBaselineCapture = true;
    startGameWatcher(); // normally already running; arm it defensively
    log('Settings sync: in a game — baseline update deferred until the game ends.');
    return { deferred: true };
  }
  return await captureBaselineNow();
});

ipcMain.handle('settingsSync:applyNow', () => {
  settingsNotice = { show: false, canApply: false };
  if (!detectedCurrentId) return { error: 'No active account detected to relaunch.' };
  try {
    const status = beginSwitch(detectedCurrentId, true);
    return { ok: true, status };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('settingsSync:dismissNotice', () => {
  settingsNotice = { show: false, canApply: false };
  return true;
});

ipcMain.handle('regions:list', () => REGIONS);

ipcMain.handle('help:open', () => {
  openHelpWindow();
  return true;
});

// Riot ID + region of the account currently signed in to League (from the LCU), for the stats-site
// buttons. Throws if League isn't running / signed in.
async function currentRiotIdRegion() {
  let summoner;
  try {
    summoner = await lcu.get('/lol-summoner/v1/current-summoner');
  } catch {
    throw new Error('League is not running. Start and sign in to League first.');
  }
  const regionLocale = await lcu.get('/riotclient/region-locale').catch(() => null);
  const current = manager.listAccounts().find((account) => account.isCurrent);
  return {
    gameName: String(summoner?.gameName || '').trim(),
    tagLine: String(summoner?.tagLine || '').trim(),
    region: resolvePorofessorRegion({
      webRegion: regionLocale?.webRegion,
      region: regionLocale?.region || current?.region
    })
  };
}

async function openStatsSite(buildUrl) {
  try {
    const url = buildUrl(await currentRiotIdRegion());
    shell.openExternal(url);
    return { ok: true, url };
  } catch (error) {
    return { error: error.message };
  }
}

ipcMain.handle('porofessor:open', () => openStatsSite(buildPorofessorLiveUrl));
ipcMain.handle('opgg:open', () => openStatsSite(buildOpggProfileUrl));

ipcMain.handle('app:openExternal', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle('friends:poc-refresh', async (event, payload = {}) => {
  const prefix = 'Friends PoC:';
  const safeLog = (message, level) => log(`${prefix} ${message}`, level);
  const sendProgress = (progress) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('friends:poc-progress', progress);
    } catch {
      // Progress updates are diagnostic UI only.
    }
  };
  const sendRanks = (update) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('friends:poc-ranks', update);
    } catch {
      // Rank badges are optional enrichment; a closed renderer needs no retry.
    }
  };
  try {
    const aggressive = !!settings.friendsPocAggressiveFetching;
    const accountIds = Array.isArray(payload.accountIds)
      ? [...new Set(payload.accountIds.map(String).filter(Boolean))]
      : [];
    if (!accountIds.length) throw new Error('Select at least one saved account before refreshing friends.');
    safeLog(`manual refresh requested; aggressiveFetching=${aggressive}; accountIds=${accountIds.length}.`);
    const authOverridesByAccountId = await getLiveFriendAuthOverrides(accountIds, safeLog);
    const result = await fetchMergedFriendListPoc([], {
      accountIds,
      log: safeLog,
      parallel: aggressive,
      progress: sendProgress,
      authOverridesByAccountId
    });
    chatService.setCanonicalFriendPresences(result.merged);
    const rankGeneration = friendRankService.startRefresh(result.merged, sendRanks);
    return { ...result, rankGeneration };
  } catch (error) {
    safeLog(`refresh failed: ${error.message}`, 'warn');
    sendProgress({ phase: 'refresh-error', error: error.message, message: `Friend refresh failed: ${error.message}` });
    throw error;
  }
});

ipcMain.handle('friends:poc-validate-session', async (_event, payload = {}) => {
  const prefix = 'Friends PoC:';
  const safeLog = (message, level) => log(`${prefix} ${message}`, level);
  const accountId = String(payload?.accountId || '').trim();
  if (!accountId) throw new Error('Missing account id.');
  try {
    safeLog(`session validation requested; accountId=${accountId}.`);
    const result = await validateSavedFriendSessionPoc(accountId, { log: safeLog });
    safeLog(`session validation accepted for ${result.label}: riotId=${result.riotId}, affinity=${result.affinity}, elapsedMs=${result.elapsedMs}`);
    return result;
  } catch (error) {
    safeLog(`session validation failed for accountId=${accountId}: ${error.message}`, 'warn');
    throw error;
  }
});

ipcMain.handle('friends:repair-sessions', async (event, payload = {}) => {
  if (friendRepairBusy || manager.getStatus().busy) throw new Error('An account operation is already in progress.');
  const accountIds = Array.isArray(payload.accountIds)
    ? [...new Set(payload.accountIds.map(String).filter(Boolean))]
    : [];
  if (!accountIds.length) throw new Error('No reauthentication-required Friends accounts were provided.');

  const accounts = new Map(manager.listAccounts().map((account) => [account.id, account]));
  for (const id of accountIds) {
    if (!accounts.has(id)) throw new Error(`Account not found: ${id}`);
  }

  const riotWasRunning = manager.riot.isRunning();
  const leagueWasRunning = isLeagueRunning();
  const signedInName = riotWasRunning ? await manager.riot.getSignedInName().catch(() => null) : null;
  const originalAccountId = await manager.detectCurrent();
  if (signedInName && !originalAccountId) {
    throw new Error(`Riot Client is signed in as "${signedInName}", which does not match a saved account. Add or capture it before repairing other sessions.`);
  }

  let originalPhase = null;
  if (leagueWasRunning) {
    try {
      originalPhase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
    } catch {
      throw new Error('League is running, but its game state could not be checked. Close League before repairing sessions.');
    }
    if (ACCOUNT_SWITCH_BLOCKING_PHASES.includes(originalPhase)) {
      throw new Error(`League is in ${originalPhase}; finish the current game flow before repairing sessions.`);
    }
  }

  const riotRoot = path.dirname(path.dirname(getRiotSessionFilePath()));
  const originalLiveBundle = readSessionBundle(riotRoot);
  const sendProgress = (progress) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('friends:repair-progress', progress);
    } catch {
      // The main-process repair continues even if the window closes to the tray.
    }
  };

  friendRepairBusy = true;
  suppressRepairLoginStats = true;
  let lobbyRejoinTarget = null;
  try {
    if (originalPhase === 'Lobby') {
      const prepared = await prepareCurrentLobbyForSwitch(lcu);
      lobbyRejoinTarget = prepared.rejoinTarget || null;
    }

    return await runSequentialFriendRepairs(accountIds, {
      progress: sendProgress,
      repair: async (accountId) => {
        const account = accounts.get(accountId);
        try {
          beginRepairManagedSwitch(accountId, {
            force: false,
            forceLogin: true,
            clientOnly: true,
            repairOnly: true
          });
          await waitForManagedSwitch();
          const capture = await manager.captureCurrent(accountId, { force: true });
          if (!capture.persisted) throw new Error(capture.warning || 'Riot did not persist a reusable session.');
          return { accountId, label: account.label };
        } catch (error) {
          error.label = account.label;
          throw error;
        }
      },
      validate: async (accountId) => validateSavedFriendSessionPoc(accountId, {
        log: (message, level) => log(`Friends repair validation: ${message}`, level)
      }),
      restore: async () => {
        if (!originalAccountId) {
          await killRiotAndLeague();
          replaceLiveSessionBundle(riotRoot, originalLiveBundle);
          manager.currentAccountId = null;
          return { restored: true, accountId: null, runtime: 'closed' };
        }

        const original = accounts.get(originalAccountId) || manager.listAccounts().find((account) => account.id === originalAccountId);
        try {
          beginRepairManagedSwitch(originalAccountId, friendRepairRestoreOptions({
            leagueWasRunning,
            lobbyRejoinTarget
          }));
          await waitForManagedSwitch();
          return {
            restored: true,
            accountId: originalAccountId,
            label: original?.label || originalAccountId,
            runtime: leagueWasRunning ? 'league' : 'riot-client'
          };
        } catch (error) {
          await killRiotAndLeague().catch(() => null);
          replaceLiveSessionBundle(riotRoot, originalLiveBundle);
          if (riotWasRunning) {
            await launchRiotClient(
              resolveRiotClientServicesPath(),
              leagueWasRunning ? undefined : RIOT_CLIENT_ONLY_LAUNCH_ARGS
            ).catch(() => null);
          }
          throw new Error(`Could not fully restore ${original?.label || originalAccountId}: ${error.message}`);
        }
      }
    });
  } finally {
    friendRepairBusy = false;
    suppressRepairLoginStats = false;
    monitor.kick();
    queueRelay.kick();
    updater.onIdle();
    rebuildTray();
    sendAccountsChanged();
  }
});

ipcMain.handle('friends:poc-lobby-status', async () => {
  try {
    return await getLobbyInviteStatus(lcu);
  } catch (error) {
    log(`Friends PoC: lobby status failed: ${error.message}`, 'warn');
    return { inLobby: false, canInvite: false, phase: null, localPuuid: '', memberPuuids: [], reason: error.message };
  }
});

// Live account/client context for the compact strip above the Friends list. This intentionally
// probes both Riot Client and LCU: the Riot process can be open but signed out, or logged in while
// League itself is closed/starting, and those must not be shown as an active League account.
ipcMain.handle('friends:current-client-summary', async () => {
  const switchStatus = manager.getStatus();
  const riotProbe = await manager.riot.probe().catch((error) => ({
    running: manager.riot.isRunning(),
    authType: error.code || error.message || 'unknown'
  }));
  const authorized = Boolean(riotProbe.running && riotProbe.authType
    && !['needs_authentication', 'unknown', 'ECONNREFUSED'].includes(riotProbe.authType));
  const leagueRunning = isLeagueRunning();

  const [signedInName, summoner, phase, chat] = await Promise.all([
    authorized ? manager.riot.getSignedInName().catch(() => null) : null,
    leagueRunning ? lcu.get('/lol-summoner/v1/current-summoner').catch(() => null) : null,
    leagueRunning ? lcu.get('/lol-gameflow/v1/gameflow-phase').catch(() => null) : null,
    leagueRunning ? lcu.get('/lol-chat/v1/me').catch(() => null) : null
  ]);

  const accounts = manager.listAccounts();
  const liveRiotId = formatRiotId(summoner?.gameName, summoner?.tagLine) || String(signedInName || '').trim();
  let account = findAccountByRiotIdentity(accounts, liveRiotId);
  if (!account && authorized && !liveRiotId) {
    account = accounts.find((item) => item.isCurrent) || null;
  }
  const parsedLive = parseRiotIdentity(liveRiotId || account?.lastSummonerName);
  const gameName = String(summoner?.gameName || parsedLive.gameName || '').trim();
  const tagLine = String(summoner?.tagLine || parsedLive.tagLine || '').trim();
  const probeError = String(riotProbe.error || '');
  const riotAuthType = riotProbe.authType || (probeError.includes('ECONNREFUSED') ? 'ECONNREFUSED' : 'unknown');

  return buildCurrentClientSummary({
    switchStatus,
    riotRunning: Boolean(riotProbe.running),
    riotAuthType,
    leagueRunning,
    leaguePhase: typeof phase === 'string' ? phase : null,
    chatAvailability: chat?.availability || null,
    accountId: account?.id || null,
    liveName: gameName,
    liveRiotId: formatRiotId(gameName, tagLine),
    livePuuid: String(summoner?.puuid || '').trim()
  });
});

ipcMain.handle('friends:poc-invite', async (_event, payload = {}) => {
  const target = payload && typeof payload === 'object' ? payload : {};
  try {
    const result = await inviteTargetToLobby(lcu, target);
    log(`Friends PoC: invited ${result.riotId} to current lobby.`);
    return result;
  } catch (error) {
    log(`Friends PoC: invite failed: ${error.message}`, 'warn');
    throw error;
  }
});

ipcMain.handle('friends:poc-join-lobby', async (_event, payload = {}) => {
  const target = payload && typeof payload === 'object' ? payload : {};
  try {
    const result = await joinFriendLobby(lcu, target);
    log(`Friends PoC: joined lobby for ${result.riotId || result.friendPuuid || result.partyId}.`);
    return result;
  } catch (error) {
    log(`Friends PoC: join lobby failed: ${error.message}`, 'warn');
    throw error;
  }
});

// --- Account layout (ordering + sections) ---
function accountIds() {
  return manager.listAccounts().map((account) => account.id);
}
function loadLayout() {
  try {
    return normalizeLayout(JSON.parse(fs.readFileSync(getSwitcherLayoutPath(), 'utf8')));
  } catch {
    return defaultLayout();
  }
}
function saveLayout(layout) {
  const normalized = normalizeLayout(layout);
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getSwitcherLayoutPath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

ipcMain.handle('layout:get', () => reconcileLayout(loadLayout(), accountIds()));
ipcMain.handle('layout:set', (_event, layout) => {
  const next = layout ?? defaultLayout();
  saveLayout(next);
  rebuildTray();
  return reconcileLayout(next, accountIds());
});

// --- Auto-update ---
ipcMain.handle('update:check', () => updater.checkForUpdates(true));
ipcMain.handle('update:download', () => updater.downloadUpdate());
ipcMain.handle('update:install', () => updater.quitAndInstall());
ipcMain.handle('update:get', () => updater.getLastStatus());
