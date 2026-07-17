import electron from 'electron';
import electronUpdater from 'electron-updater'; // CJS module — default-import then destructure

const { app } = electron;

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
export function createUpdater({ log, broadcast, isBusy, getAutoUpdate, updater = electronUpdater.autoUpdater, appRuntime = app }) {
  let lastStatus = { state: 'idle' };
  let manualPending = false;   // was the in-flight check user-initiated?
  let installDeferred = false; // auto-install waiting for a switch to finish
  let downloadOperation = null;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = {
    info: (m) => log(`updater: ${m}`),
    warn: (m) => log(`updater: ${m}`, 'warn'),
    error: (m) => log(`updater: ${m}`, 'warn'),
    debug: () => {}
  };

  function setStatus(status) {
    lastStatus = status;
    broadcast(status);
  }

  function setErrorStatus(error, manual = false) {
    const message = error?.message || String(error);
    const wasAlreadyManual = lastStatus.state === 'error'
      && lastStatus.message === message
      && lastStatus.manual === true;
    setStatus({ state: 'error', message, manual: Boolean(manual || wasAlreadyManual) });
  }

  updater.on('checking-for-update', () => setStatus({ state: 'checking', manual: manualPending }));

  updater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info?.version, manual: manualPending });
    manualPending = false;
    if (getAutoUpdate()) {
      log('updater: auto-update enabled — downloading.');
      downloadUpdate(false);
    }
  });

  updater.on('update-not-available', () => {
    setStatus({ state: 'none', manual: manualPending });
    manualPending = false;
  });

  updater.on('download-progress', (progress) => {
    setStatus({ state: 'downloading', percent: progress?.percent ?? 0 });
  });

  updater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info?.version });
    if (getAutoUpdate()) maybeAutoInstall();
  });

  updater.on('error', (err) => {
    setErrorStatus(err, manualPending || downloadOperation?.manual);
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
      downloadUpdate(false);
    } else if (lastStatus.state === 'downloaded') {
      maybeAutoInstall();
    }
  }

  async function checkForUpdates(manual = false) {
    if (!appRuntime?.isPackaged) {
      // electron-updater needs a packaged app + app-update.yml; in dev just report "up to date".
      log('updater: skipped update check (not packaged / dev).');
      setStatus({ state: 'none', manual });
      return;
    }
    manualPending = manualPending || manual;
    try {
      await updater.checkForUpdates();
    } catch (err) {
      // The 'error' event usually fires too; this covers synchronous/throwing failures.
      setErrorStatus(err, manualPending || manual);
      manualPending = false;
    }
  }

  function downloadUpdate(manual = true) {
    if (downloadOperation) {
      downloadOperation.manual = downloadOperation.manual || Boolean(manual);
      return downloadOperation.promise;
    }
    const operation = { manual: Boolean(manual), promise: null };
    downloadOperation = operation;
    operation.promise = Promise.resolve()
      .then(() => updater.downloadUpdate())
      .catch((err) => {
        setErrorStatus(err, operation.manual);
      })
      .finally(() => {
        if (downloadOperation === operation) downloadOperation = null;
      });
    return operation.promise;
  }

  function quitAndInstall() {
    try {
      // (isSilent, isForceRunAfter): silent install even for the assisted NSIS installer, then relaunch.
      updater.quitAndInstall(true, true);
    } catch (err) {
      log(`updater: quitAndInstall failed: ${err.message}`, 'warn');
    }
  }

  return { checkForUpdates, downloadUpdate, quitAndInstall, onIdle, onAutoUpdateEnabled, getLastStatus: () => lastStatus };
}
