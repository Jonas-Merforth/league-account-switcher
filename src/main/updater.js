import { app } from 'electron';
import electronUpdater from 'electron-updater'; // CJS module — default-import then destructure

const { autoUpdater } = electronUpdater;

// Wraps electron-updater in the controlled flow the app wants: never auto-download by default
// (the banner's "Update now" triggers it), but when the user enables Auto update we download and
// install automatically. Status is pushed to the renderer via `broadcast`; the latest status is
// cached so a freshly-opened window can render the right banner.
//
// Deps:
//   log(message, level?)   - our file logger
//   broadcast(status)      - send a status object to the renderer
//   isBusy()               - true while an account switch is in progress (don't restart mid-switch)
//   getAutoUpdate()        - current value of the autoUpdate setting
export function createUpdater({ log, broadcast, isBusy, getAutoUpdate }) {
  let lastStatus = { state: 'idle' };
  let manualPending = false;   // was the in-flight check user-initiated?
  let installDeferred = false; // auto-install waiting for a switch to finish

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log(`updater: ${m}`),
    warn: (m) => log(`updater: ${m}`, 'warn'),
    error: (m) => log(`updater: ${m}`, 'warn'),
    debug: () => {}
  };

  function setStatus(status) {
    lastStatus = status;
    broadcast(status);
  }

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', manual: manualPending }));

  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info?.version, manual: manualPending });
    manualPending = false;
    if (getAutoUpdate()) {
      log('updater: auto-update enabled — downloading.');
      downloadUpdate();
    }
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'none', manual: manualPending });
    manualPending = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    setStatus({ state: 'downloading', percent: progress?.percent ?? 0 });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info?.version });
    if (getAutoUpdate()) maybeAutoInstall();
  });

  autoUpdater.on('error', (err) => {
    setStatus({ state: 'error', message: err?.message || String(err), manual: manualPending });
    manualPending = false;
  });

  function maybeAutoInstall() {
    if (isBusy && isBusy()) {
      installDeferred = true;
      log('updater: update downloaded but a switch is in progress; will install when idle / on quit.');
      return;
    }
    log('updater: auto-installing update and restarting.');
    quitAndInstall();
  }

  // Called by the main process when a switch finishes, so a deferred auto-install can proceed.
  function onIdle() {
    if (installDeferred && getAutoUpdate() && !(isBusy && isBusy())) {
      installDeferred = false;
      quitAndInstall();
    }
  }

  // Called when the user turns Auto update ON while an update is already pending — the original
  // update-available event already fired (and skipped downloading because it was off then), so kick
  // off the right action now.
  function onAutoUpdateEnabled() {
    if (lastStatus.state === 'available') {
      log('updater: auto-update enabled with an update pending — downloading.');
      downloadUpdate();
    } else if (lastStatus.state === 'downloaded') {
      maybeAutoInstall();
    }
  }

  async function checkForUpdates(manual = false) {
    if (!app.isPackaged) {
      // electron-updater needs a packaged app + app-update.yml; in dev just report "up to date".
      log('updater: skipped update check (not packaged / dev).');
      setStatus({ state: 'none', manual });
      return;
    }
    manualPending = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // The 'error' event usually fires too; this covers synchronous/throwing failures.
      setStatus({ state: 'error', message: err?.message || String(err), manual });
      manualPending = false;
    }
  }

  function downloadUpdate() {
    autoUpdater.downloadUpdate().catch((err) => {
      setStatus({ state: 'error', message: err?.message || String(err) });
    });
  }

  function quitAndInstall() {
    try {
      // (isSilent, isForceRunAfter): silent install even for the assisted NSIS installer, then relaunch.
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      log(`updater: quitAndInstall failed: ${err.message}`, 'warn');
    }
  }

  return { checkForUpdates, downloadUpdate, quitAndInstall, onIdle, onAutoUpdateEnabled, getLastStatus: () => lastStatus };
}
