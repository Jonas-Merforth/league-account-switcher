import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_SWITCH_BLOCKING_PHASES, DEFAULT_LEAGUE_PATH } from './constants.js';
import { getRiotSessionFilePath, resolveRiotClientServicesPath } from './config.js';
import { RiotClientApi } from './riotClient.js';
import { dpapiProtect, dpapiUnprotect } from './secrets.js';
import { isLeagueRunning, killRiotAndLeague, launchRiotClient, prefillRiotLogin } from './riotControl.js';
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
const CAPTCHA_GRACE_MS = 120_000;
const LOGIN_POLL_INTERVAL_MS = 1_500;
const POST_LOGIN_SETTLE_MS = 2_500;
// After sign-in (especially via the login form), give the client a moment to reach the main UI
// before re-issuing the League launch, otherwise it can ignore the launch request.
const LEAGUE_LAUNCH_SETTLE_MS = 4_000;
// If the client sits on the login screen this long, the restored session was rejected; stop waiting
// and fall back to the typed login instead of burning the full restore timeout.
const LOGIN_SCREEN_BAIL_MS = 8_000;
// Seconds counted down in the UI before the tool auto-types the login, so the user knows not to
// touch the mouse/keyboard while it clicks and pastes.
const PREFILL_COUNTDOWN_S = 3;
// League launch verification: a previously-running League can leave residue that no-ops a single
// launch, so command the launch, wait for League's lockfile to appear, and retry if it doesn't.
const LEAGUE_UP_WAIT_MS = 15_000;
const LEAGUE_LAUNCH_ATTEMPTS = 3;
const GRACEFUL_QUIT_WAIT_MS = 9_000;
// A real logged-in session YAML is ~2.5KB; an empty/signed-out one is ~0.5KB (just the device id).
const MIN_SESSION_YAML_BYTES = 1_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    onSwitched
  } = {}) {
    this.lcu = lcuClient;
    this.riot = riotClient ?? new RiotClientApi();
    this.getServicesPath = getServicesPath ?? resolveRiotClientServicesPath;
    this.getSessionFilePath = getSessionFilePath ?? getRiotSessionFilePath;
    this.log = log ?? (() => {});
    // Fired after a successful switch (the new account is signed in). Used to refresh per-account
    // state such as the ARAM Mayhem available-champion list. Runs in the background; its failures
    // never affect the switch result.
    this.onSwitched = onSwitched ?? (() => {});
    this.accounts = loadAccounts();
    this.currentAccountId = null;
    this.switchStatus = idleStatus();
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
      sessionCapturedAt: existing?.sessionCapturedAt ?? null
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
  async captureCurrent(id) {
    const account = this._require(id);
    const name = await this.riot.getSignedInName().catch(() => null);
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
    return { account: redactAccount(account), persisted: true, warning: null };
  }

  // Kicks off the switch and returns immediately; the UI polls getStatus() for progress.
  startSwitch(id, { force = false } = {}) {
    const account = this._require(id);
    if (this.switchStatus.busy) {
      throw new Error('A switch is already in progress.');
    }
    this.switchStatus = {
      busy: true,
      id,
      label: account.label,
      stage: 'starting',
      message: `Preparing to switch to ${account.label}…`,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.log(`Account switch started: ${account.label}.`);
    this._runSwitch(account, { force }).catch((error) => this._failSwitch(error.message));
    return this.getStatus();
  }

  async _runSwitch(account, { force }) {
    const servicesPath = this.getServicesPath();
    this.log(`Account switch: target ${account.label} (${account.id}); RiotClientServices=${servicesPath}; sessionFile=${this.getSessionFilePath()}.`);

    // 1. Don't close a live game unless forced.
    if (!force) {
      const phase = await this._currentLeaguePhase();
      this.log(`Account switch: League gameflow phase=${phase ?? 'none / not running'}.`);
      if (phase && ACCOUNT_SWITCH_BLOCKING_PHASES.includes(phase)) {
        throw new Error(`League is in ${phase}; switching would close it. Finish first or force the switch.`);
      }
    }

    // 2. Gracefully quit the running client first so the OUTGOING account's rotated tokens flush to
    // disk, then snapshot it. A graceful quit (not a logout) keeps the session valid server-side.
    if (this.riot.isRunning()) {
      const outgoingName = await this.riot.getSignedInName().catch(() => null);
      this._setStage('closing', 'Closing the Riot Client (saving current session)…');
      await this._gracefulQuitAndWait();
      if (this.currentAccountId && this.currentAccountId !== account.id) {
        await this._snapshotOutgoing(this.currentAccountId, outgoingName);
      }
    }

    // 3. Force-close any remaining Riot/League processes so the session files can be swapped safely.
    this._setStage('closing', 'Closing Riot Client and League…');
    await killRiotAndLeague();
    // Remove the stale League lockfile a force-kill leaves behind: it can block the next launch and
    // would otherwise make our "is League up?" check falsely succeed on the old file.
    this._clearLeagueLockfile();

    // 4. Fast path: restore the saved session set. Otherwise clear any stale session so login shows.
    const hasSession = hasSnapshot(account.id);
    if (hasSession) {
      this._setStage('restoring', `Restoring saved session for ${account.label}…`);
      await this._restoreSnapshot(account.id);
      this._logSessionFileState('restored');
    } else {
      this._setStage('restoring', `No saved session for ${account.label}; a sign-in will be needed.`);
      this._clearSessionFiles();
    }

    // 5. Launch the Riot Client (it boots League once signed in).
    this._setStage('launching', 'Launching Riot Client…');
    launchRiotClient(servicesPath);
    // Diagnostic: did the client keep our restored session, or reset it to persist:null?
    const clobberCheck = setTimeout(() => this._logSessionFileState('8s-after-launch'), 8_000);
    clobberCheck.unref();

    // 6. Wait for sign-in from the restored session. A valid session reaches "authorized" within a
    // few seconds and never sits on the login screen, so if the client shows needs_authentication for
    // a sustained spell the session was rejected — bail early to the typed-login fallback instead of
    // burning the full timeout.
    this._setStage('waiting-login', 'Checking the saved session (will auto-type the login if it is not accepted)…');
    let loggedIn = await this._waitForLogin(
      hasSession ? RESTORE_LOGIN_WAIT_MS : NO_SESSION_WAIT_MS,
      'restored-session',
      { bailOnLoginScreenMs: LOGIN_SCREEN_BAIL_MS }
    );

    // 7. Fallback: prefill and submit the real login form.
    if (!loggedIn) {
      if (hasSession) {
        this.log('Account switch: restored session did not auto-sign-in (likely revoked/expired); falling back to login form.', 'warn');
      }
      const password = account.passwordEnc ? await dpapiUnprotect(account.passwordEnc) : '';
      if (account.username && password) {
        this._setStage('logging-in', `Saved session not accepted (was Riot "Sign out" used?); typing the login for ${account.username}.`);
        // Visible countdown so the user knows the automated typing is imminent and stays hands-off.
        await this._countdown('logging-in', PREFILL_COUNTDOWN_S, (s) =>
          `Auto-typing login for ${account.username} in ${s}s — don't touch the mouse or keyboard…`);
        this._tickStatus('logging-in', `Auto-typing login for ${account.username} now — don't touch the mouse or keyboard…`);
        try {
          const diag = await prefillRiotLogin({ username: account.username, password });
          this.log(`Account switch: prefill ran — ${diag || 'no diagnostics returned'}.`);
        } catch (error) {
          this.log(`Account switch: login prefill failed: ${error.message}`, 'warn');
        }
        loggedIn = await this._waitForLogin(POST_PREFILL_WAIT_MS, 'after-prefill');
        if (!loggedIn) {
          this._setStage('solve-captcha', 'Credentials filled. If a captcha appears, solve it to finish signing in.');
          loggedIn = await this._waitForLogin(CAPTCHA_GRACE_MS, 'captcha-grace');
        }
      } else {
        this._setStage('manual', 'No saved session or stored password. Sign in manually in the Riot Client window.');
        loggedIn = await this._waitForLogin(CAPTCHA_GRACE_MS, 'manual');
      }
    }

    if (!loggedIn) {
      this._logSessionFileState('on-timeout');
      throw new Error('Timed out waiting for sign-in. The Riot Client is open — finish signing in manually.');
    }

    // 8. Launch League and verify it actually comes up. A previously-running League can leave state
    // that makes a single launch silently no-op, so command the launch (API, CLI fallback), wait for
    // League's lockfile to appear, and retry.
    this._setStage('launching-league', 'Signed in; launching League…');
    await delay(LEAGUE_LAUNCH_SETTLE_MS);
    const leagueUp = await this._launchLeague(servicesPath);

    // 9. Capture a fresh session so the next switch uses the fast path.
    await this._captureAfterLogin(account);

    this.currentAccountId = account.id;
    this._save();
    this._finishSwitch(leagueUp
      ? `Switched to ${account.label}. League is launching.`
      : `Signed in as ${account.label}, but League did not auto-launch — press Play in the Riot Client.`);
    this._afterSwitch({ account: redactAccount(account), leagueUp });
  }

  // Fire the post-switch hook in the background. Isolated from the switch flow: it runs after the
  // status is already 'done', and any error is swallowed so it cannot flip the switch to failed.
  _afterSwitch(context) {
    Promise.resolve()
      .then(() => this.onSwitched(context))
      .catch((error) => this.log(`Account switch: post-switch refresh failed: ${error.message}`, 'warn'));
  }

  // Re-snapshot the outgoing account's just-flushed session (after a graceful quit) so switching
  // back stays on the fast path. Skips if the signed-in account doesn't match (avoids mislabeling).
  async _snapshotOutgoing(id, signedInName) {
    const outgoing = this.accounts.find((item) => item.id === id);
    if (!outgoing) return;
    if (signedInName && outgoing.lastSummonerName && signedInName !== outgoing.lastSummonerName) {
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
      }
      const name = await this.riot.getSignedInName().catch(() => null);
      if (name) account.lastSummonerName = name;
    } catch (error) {
      this.log(`Could not capture session after login: ${error.message}`, 'warn');
    }
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
        launchRiotClient(servicesPath);
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

  async _currentLeaguePhase() {
    if (!this.lcu) return null;
    try {
      const phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase');
      return typeof phase === 'string' ? phase : null;
    } catch {
      return null; // League isn't running, so nothing to protect.
    }
  }

  async _waitForLogin(timeoutMs, label = 'sign-in', { bailOnLoginScreenMs = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastLogged = 0;
    let loginScreenSince = 0;
    while (Date.now() < deadline) {
      const probe = await this.riot.probe().catch((error) => ({ error: error.message }));
      const signedIn = probe.running && probe.authType && probe.authType !== 'needs_authentication' && !probe.error;
      if (signedIn) {
        this.log(`Account switch: signed in (${label}); Riot auth state=${probe.authType}.`);
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

  _setStage(stage, message) {
    this.switchStatus = { ...this.switchStatus, stage, message };
    this.log(`Account switch: ${message}`);
  }

  // Updates the live switch status WITHOUT writing a log line — for per-second countdown ticks.
  _tickStatus(stage, message) {
    this.switchStatus = { ...this.switchStatus, stage, message };
  }

  async _countdown(stage, seconds, makeMessage) {
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      this._tickStatus(stage, makeMessage(remaining));
      await delay(1_000);
    }
  }

  _finishSwitch(message) {
    this.switchStatus = {
      ...this.switchStatus,
      busy: false,
      stage: 'done',
      message,
      error: null,
      finishedAt: new Date().toISOString()
    };
    this.log(`Account switch: ${message}`);
  }

  _failSwitch(message) {
    this.switchStatus = {
      ...this.switchStatus,
      busy: false,
      stage: 'error',
      message,
      error: message,
      finishedAt: new Date().toISOString()
    };
    this.log(`Account switch failed: ${message}`, 'warn');
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
