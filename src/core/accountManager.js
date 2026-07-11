import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_SWITCH_BLOCKING_PHASES, DEFAULT_LEAGUE_PATH } from './constants.js';
import { getRiotSessionFilePath, resolveRiotClientServicesPath } from './config.js';
import { RiotClientApi } from './riotClient.js';
import { dpapiProtect, dpapiUnprotect } from './secrets.js';
import { isLeagueRunning, killRiotAndLeague, launchRiotClient, prefillRiotLogin } from './riotControl.js';
import { getLobbyInviteStatus, joinFriendLobby, prepareCurrentLobbyForSwitch } from './lobbyInvite.js';
import { canRestartSwitchStatus } from './switchRetry.js';
import {
  describeSessionAge,
  hasPersistedSession,
  hasSnapshot,
  loadAccounts,
  normalizeAccount,
  readSnapshot,
  redactAccount,
  removeSnapshotDir,
  saveAccounts,
  writeSnapshot
} from './accountStore.js';
import { bundlePrimaryYaml, readSessionBundle, writeSessionBundle } from './sessionBundle.js';

// How long to wait for the Riot Client to sign in via a restored session before falling back to
// the login-form path; a shorter wait when there is no saved session (we expect a login screen).
const RESTORE_LOGIN_WAIT_MS = 30_000;
const NO_SESSION_WAIT_MS = 12_000;
const POST_PREFILL_WAIT_MS = 30_000;
const BACKGROUND_PREFILL_WAIT_MS = 12_000;
const CAPTCHA_GRACE_MS = 120_000;
const LOGIN_POLL_INTERVAL_MS = 500;
const POST_LOGIN_SETTLE_MS = 2_500;
// After sign-in (especially via the login form), give the client a moment to reach the main UI
// before re-issuing the League launch, otherwise it can ignore the launch request.
const LEAGUE_LAUNCH_SETTLE_MS = 4_000;
// If the client sits on the login screen this long, the restored session was rejected; stop waiting
// and fall back to the typed login instead of burning the full restore timeout. Measured (2026-07-03
// logs): a valid restored session goes ECONNREFUSED -> authorized ~3s after launch and NEVER reports
// needs_authentication, so a short sustain is enough; the pre-type probe after the countdown is the
// backstop if a valid session ever signs in late.
const LOGIN_SCREEN_BAIL_MS = 2_000;
// Seconds counted down before an unexpected saved-session fallback starts. Background input avoids
// disturbing the user; the old foreground path remains only as a safety net if Riot ignores it.
const PREFILL_COUNTDOWN_S = 3;
// League launch verification: a previously-running League can leave residue that no-ops a single
// launch, so command the launch, wait for League's lockfile to appear, and retry if it doesn't.
const LEAGUE_UP_WAIT_MS = 15_000;
const LEAGUE_LAUNCH_ATTEMPTS = 3;
const GRACEFUL_QUIT_WAIT_MS = 9_000;
// After League's window is up the login sync-down is done; wait a touch longer, then clear the
// settings read-only lock so the user can change settings again (the baseline re-applies next switch).
const SETTINGS_RELEASE_SETTLE_MS = 5_000;
// League's lockfile appears before all LCU plugins are necessarily ready. Keep the switch alive long
// enough for gameflow to answer before using the captured party ID to rejoin the previous lobby.
const LOBBY_REJOIN_READY_WAIT_MS = 30_000;
const LOBBY_REJOIN_POLL_INTERVAL_MS = 500;
const LOBBY_REJOIN_CONFIRM_WAIT_MS = 5_000;
// A real logged-in session YAML is ~2.5KB; an empty/signed-out one is ~0.5KB (just the device id).
const MIN_SESSION_YAML_BYTES = 1_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 'unknown' means the auth endpoint 404'd (RSO plugin still loading right after launch), NOT that
// someone is signed in — treating it as success would skip the typed-login fallback.
function probeSignedIn(probe) {
  return Boolean(probe.running && probe.authType
    && probe.authType !== 'needs_authentication' && probe.authType !== 'unknown');
}

function idleStatus() {
  return {
    busy: false,
    id: null,
    label: null,
    stage: 'idle',
    message: 'Idle',
    error: null,
    startedAt: null,
    finishedAt: null
  };
}

// Orchestrates the account switch: guard against closing a live game, kill processes, swap in the
// saved Riot session (fast path) or prefill the login form (fallback), wait for sign-in, then
// capture a fresh session. Holds the account list and an in-memory switch status the UI polls.
export class AccountManager {
  constructor({
    lcuClient,
    riotClient,
    getServicesPath,
    getSessionFilePath,
    log,
    onSwitched,
    onSessionCaptured,
    settingsSync
  } = {}) {
    this.lcu = lcuClient;
    this.riot = riotClient ?? new RiotClientApi();
    this.getServicesPath = getServicesPath ?? resolveRiotClientServicesPath;
    this.getSessionFilePath = getSessionFilePath ?? getRiotSessionFilePath;
    this.log = log ?? (() => {});
    // Optional hook to apply the shared in-game settings baseline across a switch. apply() runs while
    // the client is closed (before relaunch) to copy + lock the settings, returning whether it locked;
    // release() clears the lock again. Both are best-effort and must never fail the switch.
    this.settingsSync = settingsSync ?? { apply: () => false, release: () => {} };
    // Whether apply() left the Config files read-only, so every switch outcome (success, League not
    // up, failure) owes a _releaseSettingsLock() — the lock must never outlive the switch.
    this._settingsLockActive = false;
    this._settingsReleaseTimer = null;
    // Fired after a successful switch (the new account is signed in). Used to refresh per-account
    // state such as the ARAM Mayhem available-champion list. Runs in the background; its failures
    // never affect the switch result.
    this.onSwitched = onSwitched ?? (() => {});
    // Fired whenever a saved-session snapshot is refreshed. Background Friends auth can validate
    // it opportunistically without making account switching wait on Riot's remote auth service.
    this.onSessionCaptured = onSessionCaptured ?? (() => {});
    this.accounts = loadAccounts();
    this.currentAccountId = null;
    this.switchStatus = idleStatus();
    this._activeSwitch = null;
    this._switchRunId = 0;
  }

  // Reload the account list from disk. Useful when another process (e.g. the automation app, which
  // shares this store) may have changed accounts.json since we loaded it.
  reload() {
    this.accounts = loadAccounts();
    return this.listAccounts();
  }

  // Best-effort: on launch, if the Riot Client is already running and signed in, mark the matching
  // account active (currentAccountId isn't persisted across restarts). Never throws.
  async detectCurrent() {
    if (this.switchStatus.busy) return this.currentAccountId;
    try {
      if (!this.riot.isRunning()) return this.currentAccountId;
      const name = await this.riot.getSignedInName().catch(() => null);
      if (!name) return this.currentAccountId;
      const match = this.accounts.find((account) => account.lastSummonerName === name);
      if (match) this.currentAccountId = match.id;
    } catch {
      // Detection is optional; leave currentAccountId as-is.
    }
    return this.currentAccountId;
  }

  listAccounts() {
    const now = new Date();
    return this.accounts.map((account) => ({
      ...redactAccount(account),
      hasSession: hasSnapshot(account.id),
      isCurrent: account.id === this.currentAccountId,
      sessionAge: describeSessionAge(account.sessionCapturedAt, now)
    }));
  }

  getStatus() {
    return this.switchStatus;
  }

  async addOrUpdate({ id, label, username, password, region } = {}) {
    const existing = id ? this.accounts.find((account) => account.id === id) : null;
    let passwordEnc = existing?.passwordEnc ?? '';
    if (typeof password === 'string' && password.length > 0) {
      passwordEnc = await dpapiProtect(password);
    }
    const merged = normalizeAccount({
      id: existing?.id,
      label,
      username,
      region,
      passwordEnc,
      lastSummonerName: existing?.lastSummonerName ?? null,
      sessionCapturedAt: existing?.sessionCapturedAt ?? null,
      ranks: existing?.ranks ?? null
    });
    if (existing) {
      this.accounts = this.accounts.map((account) => (account.id === existing.id ? merged : account));
    } else {
      this.accounts.push(merged);
    }
    this._save();
    this.log(`Account saved: ${merged.label}.`);
    return redactAccount(merged);
  }

  remove(id) {
    const existed = this.accounts.some((account) => account.id === id);
    if (!existed) throw new Error('Account not found.');
    this.accounts = this.accounts.filter((account) => account.id !== id);
    removeSnapshotDir(id);
    if (this.currentAccountId === id) this.currentAccountId = null;
    this._save();
    this.log('Account removed.');
    return true;
  }

  // Snapshot the currently-signed-in Riot session into this account (run after a manual login with
  // "Stay signed in" checked). Gracefully quits the Riot Client first so its rotated RSO tokens are
  // flushed to disk — capturing a running client saves a stale, server-invalidated token. This
  // closes the Riot Client.
  async captureCurrent(id, { force = false } = {}) {
    const account = this._require(id);
    const name = await this.riot.getSignedInName().catch(() => null);
    // Guard against capturing a DIFFERENT account's session into this one by mistake: if this account
    // was captured before and the Riot Client is now signed in as someone else, refuse (unless forced)
    // instead of silently overwriting it. (Same check the switch flow uses for the outgoing account.)
    if (!force && name && this._identityMismatch(account, name)) {
      return {
        account: redactAccount(account),
        persisted: false,
        mismatch: true,
        signedInName: name,
        warning: `The Riot Client is signed in as "${name}", not "${account.lastSummonerName}". Capturing would overwrite ${account.label} with that session.`
      };
    }
    await this._gracefulQuitAndWait();
    // Stop League as well, so it cannot respawn a fresh Riot Client mid-capture (which would relaunch
    // the client and could overwrite the just-flushed session file).
    await killRiotAndLeague();

    let manifest;
    try {
      manifest = readSessionBundle(this._riotClientDir());
    } catch {
      throw new Error('Could not read the Riot session files. Make sure the Riot Client is installed and you have signed in.');
    }
    const yaml = bundlePrimaryYaml(manifest);
    const persisted = hasPersistedSession(yaml) && yaml.length >= MIN_SESSION_YAML_BYTES;
    if (!persisted) {
      return {
        account: redactAccount(account),
        persisted: false,
        warning: 'No "Stay signed in" session was found. Sign in with "Stay signed in" checked, then capture again.'
      };
    }
    await this._saveSnapshot(id, manifest);
    account.sessionCapturedAt = new Date().toISOString();
    if (name) account.lastSummonerName = name;
    this.currentAccountId = id;
    this._save();
    this.log(`Captured session for ${account.label} (Riot Client was closed to save a valid token).`);
    this._afterSessionCaptured(account, 'manual-capture');
    return { account: redactAccount(account), persisted: true, warning: null };
  }

  // True when this account was previously captured under a different signed-in name. Compares against
  // lastSummonerName (which also came from getSignedInName, so it's an apples-to-apples check). An
  // account that was never captured returns false — we can't reliably compare, so we don't block.
  _identityMismatch(account, name) {
    const known = String(account.lastSummonerName || '').trim().toLowerCase();
    if (!known) return false;
    const legacyUsername = String(account.username || '').trim().toLowerCase();
    if (legacyUsername && known === legacyUsername) return false;
    return known !== String(name || '').trim().toLowerCase();
  }

  // Kicks off the switch and returns immediately; the UI polls getStatus() for progress.
  // forceLogin ignores any saved session and drives a fresh typed sign-in (with "Stay signed in"
  // checked), then captures. Used to repair an account whose saved session the Riot Client accepts
  // but which was never persisted with "Stay signed in", so headless cookie reauth (the friend fetch)
  // is refused — a fresh typed login mints a properly-persistable session.
  startSwitch(id, { force = false, forceLogin = false } = {}) {
    const account = this._require(id);
    if (this.switchStatus.busy) {
      throw new Error('A switch is already in progress.');
    }
    if (forceLogin && !(account.username && account.passwordEnc)) {
      throw new Error(`${account.label} has no stored username/password, so it can't be re-logged-in automatically. Add credentials, or sign in manually with "Stay signed in" checked and capture.`);
    }
    return this._startSwitchRun(account, { force, forceLogin });
  }

  _startSwitchRun(
    account,
    { force = false, forceLogin = false } = {},
    { restarting = false, lobbyRejoinTarget = null } = {}
  ) {
    const runId = ++this._switchRunId;
    this._activeSwitch = {
      id: account.id,
      options: { force: Boolean(force), forceLogin: Boolean(forceLogin) },
      runId,
      lobbyRejoinTarget
    };
    this.switchStatus = {
      busy: true,
      id: account.id,
      label: account.label,
      stage: restarting ? 'restarting' : 'starting',
      message: restarting
        ? `Retrying login for ${account.label}…`
        : forceLogin
          ? `Preparing to re-login ${account.label}…`
          : `Preparing to switch to ${account.label}…`,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.log(`Account switch ${restarting ? 'restarted' : 'started'}: ${account.label}${forceLogin ? ' (forced re-login)' : ''}.`);
    this._runSwitch(account, { force, forceLogin }, runId).catch((error) => {
      if (error?.code === 'SWITCH_RUN_CANCELLED' || !this._isCurrentSwitchRun(runId)) {
        this.log(`Account switch: ignored stale switch run for ${account.label}.`);
        return;
      }
      this._releaseSettingsLock(); // a failed switch must not leave the Config files read-only
      this._failSwitch(error.message, runId);
    });
    return this.getStatus();
  }

  async restartCurrentSwitch() {
    const current = this._activeSwitch;
    if (!this.switchStatus.busy || !current) {
      throw new Error('No account switch is currently running.');
    }
    if (!canRestartSwitchStatus(this.switchStatus)) {
      throw new Error('Retry is only available while the switch is waiting for login typing.');
    }

    const account = this._require(current.id);
    const options = { ...current.options };
    const lobbyRejoinTarget = current.lobbyRejoinTarget || null;
    const cancelledRunId = current.runId;
    this._switchRunId += 1;
    this._activeSwitch = { ...current, runId: this._switchRunId };
    this._releaseSettingsLock();
    this.switchStatus = {
      ...this.switchStatus,
      stage: 'restarting',
      message: `Retrying login for ${account.label}… closing Riot/League first.`,
      error: null
    };
    this.log(`Account switch: retry requested for ${account.label}; cancelling run ${cancelledRunId}.`);

    try {
      await killRiotAndLeague();
    } catch (error) {
      this.log(`Account switch: retry cleanup failed (${error.message}); restarting anyway.`, 'warn');
    } finally {
      this._clearLeagueLockfile();
    }
    return this._startSwitchRun(account, options, { restarting: true, lobbyRejoinTarget });
  }

  async _runSwitch(account, { force, forceLogin = false }, runId) {
    this._assertActiveSwitchRun(runId);
    let lobbyRejoinTarget = this._activeSwitch?.lobbyRejoinTarget || null;
    const servicesPath = this.getServicesPath();
    this.log(`Account switch: target ${account.label} (${account.id}); RiotClientServices=${servicesPath}; sessionFile=${this.getSessionFilePath()}.`);

    // 1. Don't close a live game unless forced.
    if (!force) {
      const phase = await this._currentLeaguePhase();
      this._assertActiveSwitchRun(runId);
      this.log(`Account switch: League gameflow phase=${phase ?? 'none / not running'}.`);
      if (phase && ACCOUNT_SWITCH_BLOCKING_PHASES.includes(phase)) {
        throw new Error(`League is in ${phase}; switching would close it. Finish first or force the switch.`);
      }
    }

    // 2. Gracefully quit the running client first so the OUTGOING account's rotated tokens flush to
    // disk, then snapshot it. A graceful quit (not a logout) keeps the session valid server-side.
    if (this.riot.isRunning()) {
      const outgoingName = await this.riot.getSignedInName().catch(() => null);
      this._assertActiveSwitchRun(runId);
      const capturedLobby = await this._leaveLeagueLobbyBeforeSwitch(runId);
      if (capturedLobby) {
        lobbyRejoinTarget = capturedLobby;
        this._rememberLobbyRejoinTarget(capturedLobby, runId);
      }
      this._assertActiveSwitchRun(runId);
      this._setStage('closing', 'Closing the Riot Client (saving current session)…', runId);
      await this._gracefulQuitAndWait();
      this._assertActiveSwitchRun(runId);
      if (this.currentAccountId && this.currentAccountId !== account.id) {
        await this._snapshotOutgoing(this.currentAccountId, outgoingName);
        this._assertActiveSwitchRun(runId);
      }
    }

    // 3. Force-close any remaining Riot/League processes so the session files can be swapped safely.
    this._setStage('closing', 'Closing Riot Client and League…', runId);
    await killRiotAndLeague();
    this._assertActiveSwitchRun(runId);
    // Remove the stale League lockfile a force-kill leaves behind: it can block the next launch and
    // would otherwise make our "is League up?" check falsely succeed on the old file.
    this._clearLeagueLockfile();

    // 4. Fast path: restore the saved session set. Otherwise (or when forcing a fresh login to repair a
    // non-persistable session) clear any stale session so the login form shows and we type a new one.
    const hasSession = !forceLogin && hasSnapshot(account.id);
    if (hasSession) {
      this._setStage('restoring', `Restoring saved session for ${account.label}…`, runId);
      await this._restoreSnapshot(account.id);
      this._logSessionFileState('restored');
    } else if (forceLogin) {
      this._setStage('restoring', `Re-logging in ${account.label} — clearing the old session so a fresh "Stay signed in" login can be typed…`, runId);
      this._clearSessionBundleFiles();
    } else {
      this._setStage('restoring', `No saved session for ${account.label}; a sign-in will be needed.`, runId);
      this._clearSessionFiles();
    }
    this._assertActiveSwitchRun(runId);

    // 4b. Apply the shared settings baseline while everything is closed, locking the files so the
    // account's login sync-down can't overwrite them. Best-effort; a failure must not block the switch.
    try {
      this._cancelPendingSettingsRelease(); // a release from the previous switch must not unlock us
      this._settingsLockActive = Boolean(await this.settingsSync.apply(account));
      this._assertActiveSwitchRun(runId);
    } catch (error) {
      if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
      this.log(`Account switch: settings baseline apply failed: ${error.message}`, 'warn');
    }

    // 5. Launch the Riot Client (it boots League once signed in). A spawn failure (bad path) fails
    // the switch with a pointer to the fix instead of leaving the UI waiting for a login forever.
    this._setStage('launching', 'Launching Riot Client…', runId);
    try {
      await launchRiotClient(servicesPath);
      this._assertActiveSwitchRun(runId);
    } catch (error) {
      if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
      throw new Error(`${error.message} — check the Riot Client install (RiotClientInstalls.json).`);
    }
    // Diagnostic: did the client keep our restored session, or reset it to persist:null?
    const clobberCheck = setTimeout(() => this._logSessionFileState('8s-after-launch'), 8_000);
    clobberCheck.unref();

    // 6. Wait for sign-in from the restored session. A valid session reaches "authorized" within a
    // few seconds and never sits on the login screen, so if the client shows needs_authentication for
    // a sustained spell the session was rejected — bail early to the typed-login fallback instead of
    // burning the full timeout.
    // With no saved session the auto-type is certain, so this wait doubles as advance notice and
    // the separate pre-type countdown is skipped (see step 7).
    const willAutoType = Boolean(account.username && account.passwordEnc);
    this._setStage('waiting-login', hasSession
      ? 'Checking the saved session (will auto-type the login if it is not accepted)…'
      : willAutoType
        ? `Waiting for the login form — will sign in ${account.username} in the background…`
        : 'Waiting for the Riot Client login form — sign in manually when it appears.', runId);
    let loggedIn = await this._waitForLogin(
      hasSession ? RESTORE_LOGIN_WAIT_MS : NO_SESSION_WAIT_MS,
      'restored-session',
      { bailOnLoginScreenMs: LOGIN_SCREEN_BAIL_MS, runId }
    );
    this._assertActiveSwitchRun(runId);

    // 7. Fallback: prefill and submit the real login form.
    if (!loggedIn) {
      if (hasSession) {
        this.log('Account switch: restored session did not auto-sign-in (likely revoked/expired); falling back to login form.', 'warn');
      }
      const password = account.passwordEnc ? await dpapiUnprotect(account.passwordEnc) : '';
      if (account.username && password) {
        if (hasSession) {
          // The user expected a session switch here, so the typed fallback is a surprise: give a
          // visible countdown so they know to take their hands off the mouse/keyboard first.
          this._setStage('logging-in', `Saved session not accepted (was Riot "Sign out" used?); typing the login for ${account.username}.`, runId);
          this.log(`Account switch: starting the ${PREFILL_COUNTDOWN_S}s pre-type countdown.`);
          await this._countdown('logging-in', PREFILL_COUNTDOWN_S, (s) =>
            `Signing in ${account.username} in the background in ${s}s…`, runId);
        } else {
          // No-session switch: the hands-off warning has been on screen since the wait started, so a
          // further countdown would only add dead time before the login form gets typed.
          this.log('Account switch: no saved session, auto-type announced during the wait; skipping the countdown.');
        }
        this._tickStatus('logging-in', `Signing in ${account.username} in the background…`, runId);
        // Safety net for the short login-screen bail: if the client signed in on its own during the
        // countdown after all, typing now would click on the post-login UI instead of the login form.
        const lateProbe = await this.riot.probe().catch((error) => ({ error: error.message }));
        this._assertActiveSwitchRun(runId);
        if (probeSignedIn(lateProbe)) {
          this.log(`Account switch: signed in during the countdown (auth=${lateProbe.authType}); skipping the typed login.`);
          loggedIn = true;
        } else {
          try {
            const prefillStarted = Date.now();
            this.log('Account switch: spawning the background prefill PowerShell…');
            const diag = await prefillRiotLogin({ username: account.username, password, mode: 'background' });
            this._assertActiveSwitchRun(runId);
            this.log(`Account switch: background prefill ran in ${Date.now() - prefillStarted}ms — ${diag || 'no diagnostics returned'}.`);
          } catch (error) {
            if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
            this.log(`Account switch: background login prefill failed: ${error.message}`, 'warn');
          }
          loggedIn = await this._waitForLogin(BACKGROUND_PREFILL_WAIT_MS, 'after-background-prefill', { runId });
          this._assertActiveSwitchRun(runId);
          if (!loggedIn) {
            try {
              const foregroundStarted = Date.now();
              this.log('Account switch: background input was not accepted; retrying with the foreground prefill.', 'warn');
              const diag = await prefillRiotLogin({
                username: account.username,
                password,
                mode: 'foreground',
                // The proven background click already enabled this checkbox. Do not toggle it off
                // when retrying only the credential entry and submit steps.
                clickStaySignedIn: false
              });
              this._assertActiveSwitchRun(runId);
              this.log(`Account switch: foreground prefill ran in ${Date.now() - foregroundStarted}ms — ${diag || 'no diagnostics returned'}.`);
            } catch (error) {
              if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
              this.log(`Account switch: foreground login prefill failed: ${error.message}`, 'warn');
            }
            loggedIn = await this._waitForLogin(POST_PREFILL_WAIT_MS, 'after-foreground-prefill', { runId });
            this._assertActiveSwitchRun(runId);
          }
          if (!loggedIn) {
            this._setStage('solve-captcha', 'Credentials filled. If a captcha appears, solve it to finish signing in.', runId);
            loggedIn = await this._waitForLogin(CAPTCHA_GRACE_MS, 'captcha-grace', { runId });
            this._assertActiveSwitchRun(runId);
          }
        }
      } else {
        this._setStage('manual', 'No saved session or stored password. Sign in manually in the Riot Client window.', runId);
        loggedIn = await this._waitForLogin(CAPTCHA_GRACE_MS, 'manual', { runId });
        this._assertActiveSwitchRun(runId);
      }
    }

    if (!loggedIn) {
      this._logSessionFileState('on-timeout');
      throw new Error('Timed out waiting for sign-in. The Riot Client is open — finish signing in manually.');
    }

    // 8. Launch League and verify it actually comes up. A previously-running League can leave state
    // that makes a single launch silently no-op, so command the launch (API, CLI fallback), wait for
    // League's lockfile to appear, and retry.
    this._setStage('launching-league', 'Signed in; launching League…', runId);
    await delay(LEAGUE_LAUNCH_SETTLE_MS);
    this._assertActiveSwitchRun(runId);
    const leagueUp = await this._launchLeague(servicesPath);
    this._assertActiveSwitchRun(runId);

    // 8a. If the outgoing account was in an open party, join that same party by ID from the new
    // account. This is intentionally best-effort: a party can close, fill, or disappear while the
    // switch is running, and none of those should turn a successful account login into a failure.
    let lobbyRejoin = { rejoined: false, attempted: false, reason: '' };
    if (leagueUp && lobbyRejoinTarget) {
      lobbyRejoin = await this._rejoinLobbyAfterSwitch(lobbyRejoinTarget, runId);
      this._assertActiveSwitchRun(runId);
    }

    // 8b. League is up, so the login sync-down has happened and our locked baseline survived. Release
    // the read-only lock (after a short settle) so the user can change settings again; it re-applies on
    // the next switch. Scheduled off the critical path so it never delays the "switch done" status.
    // Released even when League did NOT come up: leaving Config read-only indefinitely would silently
    // stop the user's settings from saving, which is worse than a later manual launch re-syncing them
    // (the baseline re-applies on the next switch either way).
    this._releaseSettingsLock(SETTINGS_RELEASE_SETTLE_MS);

    // 9. Capture a fresh session so the next switch uses the fast path.
    await this._captureAfterLogin(account);
    this._assertActiveSwitchRun(runId);

    this.currentAccountId = account.id;
    this._save();
    this._finishSwitch(leagueUp
      ? lobbyRejoin.rejoined
        ? `Switched to ${account.label}. Rejoined the previous lobby.`
        : lobbyRejoin.attempted
          ? `Switched to ${account.label}, but the previous lobby could not be rejoined.`
          : `Switched to ${account.label}. League is launching.`
      : `Signed in as ${account.label}, but League did not auto-launch — press Play in the Riot Client.`, runId);
    this._afterSwitch({ account: redactAccount(account), leagueUp });
  }

  _cancelPendingSettingsRelease() {
    if (this._settingsReleaseTimer) {
      clearTimeout(this._settingsReleaseTimer);
      this._settingsReleaseTimer = null;
    }
  }

  // Clear the read-only lock left by settingsSync.apply(), optionally after a settle delay (so the
  // login sync-down finishes against the locked files first). No-op when nothing is locked; failures
  // are logged, never thrown.
  _releaseSettingsLock(delayMs = 0) {
    if (!this._settingsLockActive) return;
    this._settingsLockActive = false;
    this._cancelPendingSettingsRelease();
    const run = () => {
      this._settingsReleaseTimer = null;
      Promise.resolve()
        .then(() => this.settingsSync.release())
        .catch((error) => this.log(`Account switch: settings baseline release failed: ${error.message}`, 'warn'));
    };
    if (delayMs > 0) {
      this._settingsReleaseTimer = setTimeout(run, delayMs);
      this._settingsReleaseTimer.unref?.();
    } else {
      run();
    }
  }

  // Fire the post-switch hook in the background. Isolated from the switch flow: it runs after the
  // status is already 'done', and any error is swallowed so it cannot flip the switch to failed.
  _afterSwitch(context) {
    Promise.resolve()
      .then(() => this.onSwitched(context))
      .catch((error) => this.log(`Account switch: post-switch refresh failed: ${error.message}`, 'warn'));
  }

  _rememberLobbyRejoinTarget(target, runId) {
    if (!target || !this._isCurrentSwitchRun(runId)) return false;
    this._activeSwitch.lobbyRejoinTarget = target;
    return true;
  }

  // Re-snapshot the outgoing account's just-flushed session (after a graceful quit) so switching
  // back stays on the fast path. Skips if the signed-in account doesn't match (avoids mislabeling).
  async _snapshotOutgoing(id, signedInName) {
    const outgoing = this.accounts.find((item) => item.id === id);
    if (!outgoing) return;
    if (signedInName && this._identityMismatch(outgoing, signedInName)) {
      this.log(`Account switch: signed-in "${signedInName}" != expected "${outgoing.lastSummonerName}"; skipping outgoing save.`, 'warn');
      return;
    }
    try {
      const manifest = readSessionBundle(this._riotClientDir());
      const yaml = bundlePrimaryYaml(manifest);
      if (hasPersistedSession(yaml) && yaml.length >= MIN_SESSION_YAML_BYTES) {
        await this._saveSnapshot(id, manifest);
        outgoing.sessionCapturedAt = new Date().toISOString();
        if (signedInName) outgoing.lastSummonerName = signedInName;
        this.log(`Account switch: saved fresh session for ${outgoing.label} before closing.`);
        this._afterSessionCaptured(outgoing, 'switch-away');
      } else {
        this.log(`Account switch: outgoing ${outgoing.label} had no usable session to save (yaml ${yaml.length}B).`);
      }
    } catch (error) {
      this.log(`Account switch: could not save outgoing session: ${error.message}`, 'warn');
    }
  }

  _logSessionFileState(tag) {
    try {
      const content = fs.readFileSync(this.getSessionFilePath(), 'utf8');
      this.log(`Account switch: session file [${tag}] ${content.length}B persistedSession=${hasPersistedSession(content)}.`);
    } catch (error) {
      this.log(`Account switch: session file [${tag}] unreadable (${error.code || error.message}).`);
    }
  }

  // Best-effort capture right after a fresh login (token is valid now). The freshest, most reliable
  // snapshot happens on the next switch-away via graceful quit; this just seeds a first-time account.
  async _captureAfterLogin(account) {
    try {
      const manifest = readSessionBundle(this._riotClientDir());
      const yaml = bundlePrimaryYaml(manifest);
      if (hasPersistedSession(yaml) && yaml.length >= MIN_SESSION_YAML_BYTES) {
        await this._saveSnapshot(account.id, manifest);
        account.sessionCapturedAt = new Date().toISOString();
        this._afterSessionCaptured(account, 'post-login');
      }
      const name = await this.riot.getSignedInName().catch(() => null);
      if (name) account.lastSummonerName = name;
    } catch (error) {
      this.log(`Could not capture session after login: ${error.message}`, 'warn');
    }
  }

  _afterSessionCaptured(account, reason) {
    Promise.resolve()
      .then(() => this.onSessionCaptured({ account: redactAccount(account), reason }))
      .catch((error) => this.log(`Saved-session post-capture check failed: ${error.message}`, 'warn'));
  }

  // Store freshly fetched ranked stats on an account. Returns the redacted account or null.
  setRanks(id, ranks) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return null;
    account.ranks = {
      solo: ranks?.solo ?? null,
      flex: ranks?.flex ?? null,
      updatedAt: new Date().toISOString()
    };
    this._save();
    return redactAccount(account);
  }

  // Store the League in-game name fetched from the LCU once the switched account is fully loaded.
  setLastSummonerName(id, name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return null;
    if (account.lastSummonerName === clean) return null;
    account.lastSummonerName = clean;
    this._save();
    return redactAccount(account);
  }

  _leagueLockfilePath() {
    return path.join(this.lcu?.leaguePath || DEFAULT_LEAGUE_PATH, 'lockfile');
  }

  _clearLeagueLockfile() {
    try {
      fs.rmSync(this._leagueLockfilePath(), { force: true });
    } catch {
      // Nothing to clear.
    }
  }

  // League writes its lockfile once the client window is up; poll for it to confirm a real launch.
  async _waitForLeague(timeoutMs) {
    const lockfile = this._leagueLockfilePath();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(lockfile)) return true;
      await delay(1_500);
    }
    return false;
  }

  // Command League to launch and confirm it actually starts, retrying. Prefers the product-launcher
  // API (deterministic) and falls back to the CLI launch.
  async _launchLeague(servicesPath) {
    this.log(`Account switch: verifying League via lockfile ${this._leagueLockfilePath()} (set a correct League path if this never appears).`);
    for (let attempt = 1; attempt <= LEAGUE_LAUNCH_ATTEMPTS; attempt += 1) {
      try {
        await this.riot.launchLeague();
        this.log(`Account switch: requested League launch via product-launcher API (attempt ${attempt}).`);
      } catch (error) {
        this.log(`Account switch: product-launcher API failed (${error.message}); using CLI launch.`, 'warn');
        await launchRiotClient(servicesPath).catch((launchError) =>
          this.log(`Account switch: CLI launch failed: ${launchError.message}`, 'warn'));
      }
      if (await this._waitForLeague(LEAGUE_UP_WAIT_MS)) {
        this.log('Account switch: League client is up (lockfile found).');
        return true;
      }
      // Fallback: the lockfile may be at a path we couldn't resolve — trust a running League process.
      if (await isLeagueRunning().catch(() => false)) {
        this.log('Account switch: League process detected (lockfile not found at the configured path).');
        return true;
      }
      this.log(`Account switch: League did not appear after attempt ${attempt}; retrying launch.`, 'warn');
    }
    return false;
  }

  // Gracefully quit the Riot Client (flushing rotated tokens) and wait for it to exit.
  async _gracefulQuitAndWait(timeoutMs = GRACEFUL_QUIT_WAIT_MS) {
    if (!this.riot.isRunning()) return;
    try {
      await this.riot.gracefulQuit();
      this.log('Account switch: requested graceful Riot Client quit (flushing session tokens).');
    } catch (error) {
      this.log(`Account switch: graceful quit request failed (${error.message}); will force-kill.`, 'warn');
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.riot.isRunning()) {
        this.log('Account switch: Riot Client exited gracefully.');
        return;
      }
      await delay(500);
    }
    this.log('Account switch: Riot Client did not exit in time; will force-kill.', 'warn');
  }

  async _leaveLeagueLobbyBeforeSwitch(runId) {
    if (!this.lcu) return;
    try {
      const phase = await this._currentLeaguePhase();
      this._assertActiveSwitchRun(runId);
      if (phase !== 'Lobby') {
        this.log(`Account switch: no pre-switch lobby leave needed (phase=${phase ?? 'none / not running'}).`);
        return;
      }
      this._setStage('leaving-lobby', 'Leaving current League lobby…', runId);
      const result = await prepareCurrentLobbyForSwitch(this.lcu);
      this._assertActiveSwitchRun(runId);
      if (result.left) {
        if (result.rejoinTarget) {
          this.log(`Account switch: saved open lobby ${result.rejoinTarget.partyId} for the new account, then left it.`);
        } else {
          this.log('Account switch: left current League lobby before switching (not open or no joinable party ID).');
        }
      } else {
        this.log(`Account switch: did not leave League lobby before switching (${result.reason || `phase=${result.phase ?? 'unknown'}`}).`);
      }
      return result.rejoinTarget || null;
    } catch (error) {
      if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
      this.log(`Account switch: pre-switch lobby leave failed (${error.message}); continuing switch.`, 'warn');
      return null;
    }
  }

  async _rejoinLobbyAfterSwitch(target, runId) {
    if (!this.lcu || !target?.partyId) return { rejoined: false, attempted: false, reason: '' };
    this._setStage('rejoining-lobby', 'League is ready; rejoining the previous lobby…', runId);

    const deadline = Date.now() + LOBBY_REJOIN_READY_WAIT_MS;
    let lastReason = 'League lobby services did not become ready in time.';
    while (Date.now() < deadline) {
      this._assertActiveSwitchRun(runId);
      let phase = null;
      try {
        phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase');
        this._assertActiveSwitchRun(runId);
      } catch (error) {
        if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
        lastReason = error.message;
      }

      if (phase === 'None' || phase === 'Lobby' || phase === '') {
        try {
          const result = await joinFriendLobby(this.lcu, target);
          this._assertActiveSwitchRun(runId);
          if (await this._confirmLobbyRejoin(result.partyId, runId)) {
            this.log(`Account switch: rejoined previous open lobby ${result.partyId}.`);
            return { rejoined: true, attempted: true, reason: '' };
          }
          const reason = 'League did not confirm membership in the previous lobby.';
          this.log(`Account switch: could not rejoin previous open lobby ${target.partyId} (${reason}).`, 'warn');
          return { rejoined: false, attempted: true, reason };
        } catch (error) {
          if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
          // The client is ready, so a rejected join now means the party closed, filled, or vanished.
          // Retrying the same direct join would only spam the lobby endpoint.
          if (/already in this lobby/i.test(error.message)) {
            this.log(`Account switch: new account was already in previous open lobby ${target.partyId}.`);
            return { rejoined: true, attempted: true, reason: '' };
          }
          this.log(`Account switch: could not rejoin previous open lobby ${target.partyId} (${error.message}).`, 'warn');
          return { rejoined: false, attempted: true, reason: error.message };
        }
      }
      if (typeof phase === 'string' && phase) {
        lastReason = `League entered ${phase} before the lobby could be rejoined.`;
      }
      await delay(LOBBY_REJOIN_POLL_INTERVAL_MS);
    }

    this.log(`Account switch: could not rejoin previous open lobby ${target.partyId} (${lastReason}).`, 'warn');
    return { rejoined: false, attempted: true, reason: lastReason };
  }

  async _confirmLobbyRejoin(partyId, runId) {
    const deadline = Date.now() + LOBBY_REJOIN_CONFIRM_WAIT_MS;
    while (Date.now() < deadline) {
      this._assertActiveSwitchRun(runId);
      try {
        const lobby = await getLobbyInviteStatus(this.lcu);
        this._assertActiveSwitchRun(runId);
        if (lobby.inLobby && lobby.partyId === partyId) return true;
      } catch (error) {
        if (error?.code === 'SWITCH_RUN_CANCELLED') throw error;
      }
      await delay(LOBBY_REJOIN_POLL_INTERVAL_MS);
    }
    return false;
  }

  async _currentLeaguePhase() {
    if (!this.lcu) return null;
    try {
      const phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase');
      return typeof phase === 'string' ? phase : null;
    } catch {
      return null; // League isn't running, so nothing to protect.
    }
  }

  async _waitForLogin(timeoutMs, label = 'sign-in', { bailOnLoginScreenMs = 0, runId = null } = {}) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let lastLogged = 0;
    let loginScreenSince = 0;
    let lastState = null;
    while (Date.now() < deadline) {
      if (runId) this._assertActiveSwitchRun(runId);
      const probe = await this.riot.probe().catch((error) => ({ error: error.message }));
      if (runId) this._assertActiveSwitchRun(runId);
      // Timing instrumentation: log every auth-state TRANSITION (the 5s heartbeat below is too
      // coarse to show whether a valid restored session ever passes through needs_authentication,
      // which is what bounds how aggressively the login-screen bail can be tuned).
      const state = probe.running ? `auth=${probe.authType ?? probe.error ?? 'unknown'}` : 'not-running';
      if (state !== lastState) {
        this.log(`Account switch: auth state ${lastState ?? '(start)'} -> ${state} (${label}, +${Date.now() - start}ms).`);
        lastState = state;
      }
      if (probeSignedIn(probe)) {
        this.log(`Account switch: signed in (${label}); Riot auth state=${probe.authType} after ${Date.now() - start}ms.`);
        return true;
      }
      // Bail early once the client has been parked on the login screen long enough: a valid restored
      // session would have signed in by now, so this one was rejected.
      if (bailOnLoginScreenMs && probe.running && probe.authType === 'needs_authentication') {
        if (!loginScreenSince) {
          loginScreenSince = Date.now();
        } else if (Date.now() - loginScreenSince >= bailOnLoginScreenMs) {
          this.log(`Account switch: Riot Client parked on the login screen (${label}); restored session not accepted, falling back.`);
          return false;
        }
      } else {
        loginScreenSince = 0;
      }
      const now = Date.now();
      if (now - lastLogged >= 5_000) {
        lastLogged = now;
        const detail = probe.running
          ? `auth=${probe.authType ?? probe.error ?? 'unknown'} port=${probe.port ?? '-'}`
          : 'Riot Client not running yet';
        this.log(`Account switch: waiting (${label}) — ${detail}.`);
      }
      await delay(LOGIN_POLL_INTERVAL_MS);
    }
    this.log(`Account switch: wait (${label}) hit the ${timeoutMs}ms deadline (last state: ${lastState ?? 'none'}).`);
    return false;
  }

  // The Riot Client root dir (parent of Data/Config), derived from the session-file path.
  _riotClientDir() {
    return path.dirname(path.dirname(this.getSessionFilePath()));
  }

  // Encrypt and store a session bundle (a manifest of relPath -> base64) for an account.
  async _saveSnapshot(id, manifest) {
    writeSnapshot(id, await dpapiProtect(JSON.stringify(manifest)));
  }

  // Decrypt and write an account's saved session bundle back to disk. Falls back to treating a
  // legacy snapshot (raw YAML, pre-bundle format) as just the primary session file.
  async _restoreSnapshot(id) {
    const decrypted = await dpapiUnprotect(readSnapshot(id));
    let manifest;
    try {
      manifest = JSON.parse(decrypted);
      if (!manifest || typeof manifest !== 'object') throw new Error('not a manifest');
    } catch {
      manifest = { 'Data/RiotGamesPrivateSettings.yaml': Buffer.from(decrypted, 'utf8').toString('base64') };
    }
    writeSessionBundle(manifest, this._riotClientDir());
  }

  // Remove the live session file so a stale login does not linger before a fresh sign-in.
  _clearSessionFiles() {
    try {
      fs.rmSync(this.getSessionFilePath(), { force: true });
    } catch {
      // Nothing to clear.
    }
  }

  // Remove the whole live session set (primary yaml + Cookies + Sessions), so the client cannot
  // silently re-authenticate from residual state and the login form is guaranteed to appear. Used for
  // a forced re-login; a lingering cookie/session store could otherwise skip the typed sign-in.
  _clearSessionBundleFiles() {
    const dataDir = path.dirname(this.getSessionFilePath());
    for (const target of [this.getSessionFilePath(), path.join(dataDir, 'Cookies'), path.join(dataDir, 'Sessions')]) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort; a missing path is fine.
      }
    }
  }

  _isCurrentSwitchRun(runId) {
    return Boolean(runId && this._activeSwitch?.runId === runId);
  }

  _assertActiveSwitchRun(runId) {
    if (this._isCurrentSwitchRun(runId)) return;
    const error = new Error('Switch run was cancelled.');
    error.code = 'SWITCH_RUN_CANCELLED';
    throw error;
  }

  _setStage(stage, message, runId = null) {
    if (runId && !this._isCurrentSwitchRun(runId)) return false;
    this.switchStatus = { ...this.switchStatus, stage, message };
    this.log(`Account switch: ${message}`);
    return true;
  }

  // Updates the live switch status WITHOUT writing a log line — for per-second countdown ticks.
  _tickStatus(stage, message, runId = null) {
    if (runId && !this._isCurrentSwitchRun(runId)) return false;
    this.switchStatus = { ...this.switchStatus, stage, message };
    return true;
  }

  async _countdown(stage, seconds, makeMessage, runId = null) {
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (runId) this._assertActiveSwitchRun(runId);
      this._tickStatus(stage, makeMessage(remaining), runId);
      await delay(1_000);
    }
  }

  _finishSwitch(message, runId = null) {
    if (runId && !this._isCurrentSwitchRun(runId)) return false;
    this._activeSwitch = null;
    this.switchStatus = {
      ...this.switchStatus,
      busy: false,
      stage: 'done',
      message,
      error: null,
      finishedAt: new Date().toISOString()
    };
    this.log(`Account switch: ${message}`);
    return true;
  }

  _failSwitch(message, runId = null) {
    if (runId && !this._isCurrentSwitchRun(runId)) return false;
    this._activeSwitch = null;
    this.switchStatus = {
      ...this.switchStatus,
      busy: false,
      stage: 'error',
      message,
      error: message,
      finishedAt: new Date().toISOString()
    };
    this.log(`Account switch failed: ${message}`, 'warn');
    return true;
  }

  _require(id) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new Error('Account not found.');
    return account;
  }

  _save() {
    this.accounts = saveAccounts(this.accounts);
  }
}
