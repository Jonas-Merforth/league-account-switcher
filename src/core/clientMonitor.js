// Adaptive LCU poll loop for ready checks, champion lock-in, sound notifications, and keeping chat
// presence offline ("appear offline"). Runs entirely in the main process so it keeps working while
// the window is closed to the tray. Polls faster for ready checks and pick deadlines.
//
// It does NOT own any feature state — it reads the current intent through getters every tick:
//   getAutoAccept()    -> boolean, accept ready checks for any queue
//   getAcceptDelayMs() -> number, how long to wait after a ready check appears (0 = ASAP)
//   getAutoLockIn()    -> boolean, complete the local player's hovered pick
//   getLockInBeforeEndMs() -> number, lock when this much pick time remains
//   getSoundNotifications() -> boolean, watch for champ-select dodges
//   getDesiredOffline()-> boolean, chat should currently be forced offline

const BASE_INTERVAL_MS = 1_000; // idle / between games / League not running
const FAST_INTERVAL_MS = 200; // while in queue or a ready check is up — catch the pop quickly

const CHAT_ME_ENDPOINT = '/lol-chat/v1/me';
const AVAILABILITY_OFFLINE = 'offline';

// Phases where a ready check is imminent or live; we poll fast so a delay-0 accept is near-instant.
const ACTIVE_PHASES = new Set(['Matchmaking', 'ReadyCheck']);
// A champ select that returns to one of these pre-game phases ended without starting a match.
const DODGE_RETURN_PHASES = new Set(['Lobby', 'Matchmaking', 'ReadyCheck']);

export class ClientMonitor {
  constructor({
    lcu,
    log,
    getAutoAccept,
    getAcceptDelayMs,
    getAutoLockIn = () => false,
    getLockInBeforeEndMs,
    getSoundNotifications,
    getDesiredOffline,
    onAutoAccepted,
    onQueueDodged
  }) {
    this.lcu = lcu;
    this.log = log ?? (() => {});
    this.getAutoAccept = getAutoAccept;
    this.getAcceptDelayMs = getAcceptDelayMs;
    this.getAutoLockIn = getAutoLockIn;
    this.getLockInBeforeEndMs = getLockInBeforeEndMs;
    this.getSoundNotifications = getSoundNotifications ?? (() => false);
    this.getDesiredOffline = getDesiredOffline;
    this.onAutoAccepted = onAutoAccepted ?? (() => {});
    this.onQueueDodged = onQueueDodged ?? (() => {});

    this.timer = null;
    this.intervalMs = BASE_INTERVAL_MS;
    this.acceptDueAt = null; // scheduled accept time for the current ready check
    this.readyCheckCanceled = false; // a manual response must win until this ready check ends
    this.champSelectSeen = false; // armed until champ select starts a game or returns to the queue
    this.ticking = false;
  }

  // Start (or wake) the loop and run a tick immediately so toggles feel instant. Safe to call often.
  kick() {
    if (!this.getAutoAccept() && !this.getAutoLockIn() && !this.getSoundNotifications() && !this.getDesiredOffline()) {
      this.stop();
      return;
    }
    if (!this.timer) this._schedule(this.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.acceptDueAt = null;
    this.readyCheckCanceled = false;
    this.champSelectSeen = false;
  }

  _schedule(intervalMs) {
    if (this.timer) clearInterval(this.timer);
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  // Re-pace the loop only when the target interval actually changes (avoid churn every tick).
  _setInterval(intervalMs) {
    if (this.timer && intervalMs !== this.intervalMs) this._schedule(intervalMs);
  }

  async tick() {
    if (this.ticking) return; // a slow request must not overlap the next interval fire
    this.ticking = true;
    try {
      const wantAccept = this.getAutoAccept();
      const wantSoundNotifications = this.getSoundNotifications();
      const wantOffline = this.getDesiredOffline();
      if (!wantAccept && !this.getAutoLockIn() && !wantSoundNotifications && !wantOffline) {
        this.stop();
        return;
      }

      // A bare string like "Matchmaking"; null when League isn't running / not reachable.
      const phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase').catch(() => null);
      if (!phase) {
        this.acceptDueAt = null;
        this.champSelectSeen = false;
        this._setInterval(BASE_INTERVAL_MS);
        return;
      }

      if (wantSoundNotifications) this._observeDodgePhase(phase);
      else this.champSelectSeen = false;

      if (wantAccept) {
        await this._handleReadyCheck(phase);
      } else {
        this.acceptDueAt = null;
        this.readyCheckCanceled = false;
      }

      const pickDeadlineNear = phase === 'ChampSelect' && this.getAutoLockIn() && await this._handleLockIn();
      if (wantOffline) {
        await this._enforceOffline();
      }

      const watchingQueue = wantAccept || wantSoundNotifications || wantOffline;
      const pollFast = (watchingQueue && ACTIVE_PHASES.has(phase)) || pickDeadlineNear;
      this._setInterval(pollFast ? FAST_INTERVAL_MS : BASE_INTERVAL_MS);
    } catch (error) {
      this.log(`Client monitor tick failed: ${error.message}`, 'warn');
    } finally {
      this.ticking = false;
    }
  }

  async _handleLockIn() {
    let client, session;
    try {
      client = this.lcu.forCurrentSession();
      session = await client.get('/lol-champ-select/v1/session');
    } catch {
      return false; // League may have closed or switched accounts since the gameflow check.
    }
    const timer = session?.timer;
    if (timer?.phase !== 'BAN_PICK' || timer.isInfinite || !Number.isFinite(timer.adjustedTimeLeftInPhase)
        || timer.adjustedTimeLeftInPhase < 0 || !Number.isInteger(session.localPlayerCellId)
        || session.localPlayerCellId < 0 || !Array.isArray(session.actions)) return false;

    const pick = session.actions.flat().find(action => action?.type === 'pick'
      && action.actorCellId === session.localPlayerCellId && action.isInProgress === true
      && action.completed === false && Number.isInteger(action.id) && action.id >= 0);
    if (!pick) return false;

    // The timer carries the time remaining when League produced this snapshot.
    const ageMs = Number.isFinite(timer.internalNowInEpochMs) && timer.internalNowInEpochMs > 0
      ? Math.max(0, Date.now() - timer.internalNowInEpochMs) : 0;
    const remaining = timer.adjustedTimeLeftInPhase - ageMs;
    const windowMs = this.getLockInBeforeEndMs();
    if (remaining > windowMs) return remaining <= windowMs + 2 * BASE_INTERVAL_MS;
    if (this.getAutoLockIn() && Number.isInteger(pick.championId) && pick.championId > 0) {
      // Complete the client's current hover. Sending a champion ID could overwrite a newer hover.
      try {
        await client.post(`/lol-champ-select/v1/session/actions/${pick.id}/complete`);
      } catch (error) {
        this.log(`Auto Lock-In could not complete the pick: ${error.message}`, 'warn');
      }
    }
    return true; // Re-read the action on the next tick, including after a late hover.
  }

  _observeDodgePhase(phase) {
    if (phase === 'ChampSelect') {
      this.champSelectSeen = true;
      return;
    }
    if (!this.champSelectSeen) return;
    this.champSelectSeen = false;
    if (!DODGE_RETURN_PHASES.has(phase)) return;
    this.log(`Sound notifications: champ select returned to ${phase}; detected a dodge.`);
    try {
      this.onQueueDodged();
    } catch (error) {
      this.log(`Sound notifications: could not notify the app about a dodge: ${error.message}`, 'warn');
    }
  }

  async _handleReadyCheck(phase) {
    if (phase !== 'ReadyCheck') {
      this.acceptDueAt = null;
      this.readyCheckCanceled = false;
      return;
    }
    const readyCheck = await this.lcu.get('/lol-matchmaking/v1/ready-check').catch(() => null);
    if (!readyCheck || readyCheck.state !== 'InProgress') {
      this.acceptDueAt = null;
      return;
    }

    const playerResponse = String(readyCheck.playerResponse || '');
    if (playerResponse !== 'None') {
      const hadPendingAccept = this.acceptDueAt !== null;
      this.readyCheckCanceled = true;
      this.acceptDueAt = null;
      if (hadPendingAccept && playerResponse === 'Declined') {
        this.log('Auto-accept: manual decline detected; canceled pending accept.');
      }
      return;
    }
    if (this.readyCheckCanceled) {
      this.acceptDueAt = null;
      return;
    }
    const delay = Math.max(0, Number(this.getAcceptDelayMs()) || 0);
    if (this.acceptDueAt === null) this.acceptDueAt = Date.now() + delay;
    if (Date.now() < this.acceptDueAt) return;

    try {
      await this.lcu.post('/lol-matchmaking/v1/ready-check/accept');
      this.log('Auto-accept: accepted ready check.');
    } catch (error) {
      this.log(`Auto-accept: could not accept ready check: ${error.message}`, 'warn');
      this.acceptDueAt = null;
      return;
    }
    try {
      this.onAutoAccepted();
    } catch (error) {
      this.log(`Auto-accept: could not notify the app: ${error.message}`, 'warn');
    }
    this.acceptDueAt = null;
  }

  async _enforceOffline() {
    let me;
    try {
      me = await this.lcu.get(CHAT_ME_ENDPOINT);
    } catch {
      return; // chat not connected yet — try again next tick
    }
    if (!me || me.availability === AVAILABILITY_OFFLINE) return;
    try {
      await this.lcu.put(CHAT_ME_ENDPOINT, { availability: AVAILABILITY_OFFLINE });
      this.log('Appear offline: set chat availability to offline.');
    } catch (error) {
      this.log(`Appear offline: could not set availability: ${error.message}`, 'warn');
    }
  }
}
