# Branch audit — 2026-07-17

This is the working evidence journal for the audit of `codex/bug-fixing-goal`. It records confirmed
bugs separately from candidates that were reproduced and rejected as intended or documented
behavior. Logs and live probes are summarized without account identifiers, credentials, session
data, PUUIDs, or private social/chat content.

## Rejected candidate: TFT dot after the API-only cleanup change

### Reported behavior

After the notification-cleanup change removed automatic League navigation, a gold dot was visible on
the TFT header immediately after signing in.

### Reproduction and trace

- The baseline suite passed before edits.
- A sanitized live probe showed gameflow `None`, client build 16.14, both TFT battle-pass/store offer
  arrays absent from the home-hub payload, and an empty `seenOfferIds` placeholder already persisted.
- The switcher log showed the renderer starting first and the placeholder being written six seconds
  later, after settings became ready.
- A restricted visual check confirmed the current renderer's dot.
- The installed 16.14 navigation bundle was extracted and inspected. Its preference observer sets the
  TFT alert when `seenOfferIds` is absent, but a later preference update does not clear an already
  latched alert when the home-hub offer arrays are absent. No supported current-session API
  false-setter exists for this state.

### Conclusion

This is the exact first-session renderer-cache limitation already documented by the API-only cleanup
design. The placeholder was first created during this session, so it could not prevent the earlier
renderer latch. Automatic or hidden navigation would contradict the intended no-click behavior. No
code change or commit was made for this candidate.

## Confirmed bug 1: current Riot identity was unreadable and tags were discarded

### Misbehavior

The current Riot Client returns `/rso-auth/v1/authorization/userinfo` as an object containing a
JSON-encoded `userInfo` field. The app only handled a direct user-info object, so
`getSignedInName()` returned `null` on the running client. This disabled startup account detection and
the wrong-account capture guard. Separately, several identity paths compared only the game-name part
of a Riot ID, so two saved accounts with the same game name and different tags could be confused.

The combined effects included:

- the active account being missing after app startup;
- a manual capture lacking the intended warning before overwriting the selected account with a
  different live session;
- outgoing session refresh and rank data being attributed to the wrong same-name account;
- Friends live-auth and Queue Relay either using an ambiguous account or rejecting it inconsistently;
- the Friends current-client header resolving the wrong saved account.

### Reproduction

- A sanitized live shape probe confirmed the response is `{ userInfo: "<JSON>" }` and that the
  embedded payload contains both game name and tag line.
- Before the fix, a focused 11-test run had five failures:
  - current wrapped user info returned `null`;
  - a direct user-info object lost its tag;
  - case-insensitive tagged startup detection returned no account;
  - one unambiguous legacy game-name-only record did not match its full live Riot ID;
  - the capture identity guard rejected a valid legacy-to-full-ID migration.

### Root cause

`RiotClientApi.getSignedInName()` did not decode the wrapper used by the current Riot Client and
returned only a game name even for response shapes that carried a tag. `AccountManager.detectCurrent`
then required a case-sensitive string equality, while main-process Friends and Queue Relay helpers
explicitly removed everything after `#`.

### Fix

- Parse direct, JSON-wrapped, and JWT-style Riot user-info payloads.
- Preserve the complete `game name#tag` identity when available.
- Match tagged identities case-insensitively and exactly.
- Allow migration of one unambiguous legacy game-name-only record, but refuse to guess when multiple
  saved accounts share that game name.
- Use the same identity rules for startup detection, capture protection, rank identity refresh,
  Friends live credentials/current-client summary, and Queue Relay.

### Confirmation

- The focused identity/capture/live-auth/current-summary run passed 20/20 after the fix.
- A sanitized live probe then confirmed all three outcomes without printing the identity: the wrapper
  was parsed, a full tagged Riot ID was recovered, and one saved account was matched.
- The full suite passed 259/259.
- `node --check` passed for every changed JavaScript file and `git diff --check` was clean.
- The isolated Electron self-test completed with its window, tray, preload API, updater, cleanup,
  chat, and renderer wiring checks passing.
- `npm run pack` completed and produced the unpacked Windows app.

## Confirmed bug 2: a failed gameflow read bypassed live-game protection

### Misbehavior

Before every ordinary account switch, the app asks League for its gameflow phase and blocks ready
checks, champion select, game start, and active games. Any failure reading that endpoint was treated
as proof that League was closed. If League's UI or game process was actually alive during a transient
LCU failure, the switch continued into the Riot/League shutdown path without knowing whether it was
about to close a protected phase.

### Reproduction

A deterministic switch-safety probe used an LCU client whose phase request fails while the process
probe reports League running. Before the fix, `_currentLeaguePhase({ failIfRunning: true })` returned
`null` and the regression test failed because no safety error was raised. The same fail-open result
also occurred for an empty, unusable phase response.

### Root cause

`_currentLeaguePhase()` collapsed two different states into `null`: League genuinely stopped, and
League running with an unreachable or unusable gameflow endpoint. The destructive switch guard
therefore could not distinguish safe absence from missing safety information.

### Fix

- The destructive switch guard now requests a fail-closed gameflow check.
- When gameflow cannot provide a non-empty phase, a separate League-process probe must establish that
  League is stopped before the switch may continue.
- If League is still running, or the process probe also fails, the switch stops with a clear retry,
  manual-close, or explicit force-switch message.
- Non-destructive callers keep their existing best-effort phase behavior.

### Confirmation

- The pre-fix focused run failed the new running-League regression and passed the stopped-League
  control case.
- After the fix, switch, capture, lobby, and retry tests passed 23/23, including failed and empty
  gameflow responses and the genuine-stopped control.
- The full suite passed 261/261; changed JavaScript passed `node --check`, and `git diff --check` was
  clean.
- The isolated Electron self-test completed without a timeout or renderer, preload, load, or probe
  error.

## Confirmed bug 3: API-only cleanup hid the action needed for a still-visible TFT dot

### Misbehavior

With automatic/API-only cleanup enabled, the TFT header could still show a gold dot in the current
League renderer. The cleanup result correctly knew both that it had saved an experimental marker for
the next session and that the current renderer still had a residual latch. However, the UI removed
the live warning whenever that same reason was also covered for the next session. “Clean up now”
therefore sounded successful without saying that the dot visible on screen had not been cleared or
which safe explicit action would clear it.

### Reproduction

- A sanitized Computer Use screenshot cropped to the League navigation header clearly showed the
  gold dot above TFT while gameflow was `None`.
- The current live payload matched the known missing-offer-array residual and the ordinary cleanup
  had already persisted its next-session placeholder.
- A focused renderer regression reproduced the misleading result: with both
  `tftLiveClearReasons: ['residual']` and `tftNextSessionReasons: ['residual']`, the visible-dot note
  was an empty string. The default cleanup hint also omitted the deep-clean action. Both assertions
  failed before the fix.

### Root cause

The renderer subtracted every next-session TFT reason from the live reasons before deciding whether
to show the deep-clean note. That treated “will be prevented after the next client start” as if it
also meant “is no longer visible in the running renderer.” The default hint reinforced the same
ambiguity by mentioning only a possible next-session disappearance.

### Fix

- Keep the automatic and ordinary manual paths API-only, preserving the no-click behavior.
- Whenever a live TFT clear reason remains and no TFT visit was sent, explicitly say that the dot is
  still visible now and direct the user to **Deep-clean visible dots**.
- Make the default hint distinguish API-only cleanup from the explicit current-screen deep clean.
- Move this result decision into a small tested renderer helper.

### Confirmation

- The two focused renderer assertions failed before the behavior change and passed afterward.
- The related cleanup and renderer tests passed 50/50.
- With League safely idle, Computer Use triggered only **Deep-clean visible dots** in the running
  Account Switcher. The action completed, and a second sanitized screenshot of the exact same TFT
  header crop showed the gold dot was gone.
- The full suite passed 263/263; changed renderer JavaScript passed `node --check`, and
  `git diff --check` was clean.
- The isolated Electron self-test completed without diagnostic errors, and `npm run pack` completed
  with the new renderer helper included in the packaged app.

## Confirmed bug 4: failed switch attempts consumed Appear Offline

### Misbehavior

Appear Offline is documented as lasting on the current account until the next switch, or staying
armed for the first account switched to when League is closed. The app consumed that one-shot state
before `AccountManager.startSwitch()` had even accepted the request. A busy/rejected switch, a
live-game safety rejection, or a later login failure could therefore make the toolbar show online
without changing accounts. For an already-offline client this also left the icon and League chat
availability disagreeing, because the failed switch path did not restore chat online.

### Reproduction

The existing main-process order was reproduced in an isolated state controller without touching the
live account:

- active offline state plus a synchronously rejected switch became `on: false`;
- an armed next-account state became active as soon as a switch merely started, before success;
- there was no successful-switch transition to distinguish an attempt from a completed account
  change.

All three focused assertions failed before the lifecycle change.

### Root cause

`beginSwitch()` changed `appearOffline` / `appearOfflinePendingNext` and broadcast the new icon state
before calling the manager. The actual success signal already existed in AccountManager's
`onSwitched` hook, but Appear Offline did not use it.

### Fix

- Keep Appear Offline unchanged while a switch is only starting, running, rejected, or failed.
- Consume the active/armed state only from the post-success `onSwitched` hook.
- Wake the live-client monitor after that successful transition so an armed offline state is applied
  to the newly signed-in account, while a switch-away state stops enforcing offline.
- Centralize the transient lifecycle in a focused state controller.

### Confirmation

- The three pre-fix lifecycle failures pass after the change.
- Related Appear Offline, auto-accept, switching, capture, and lobby tests pass 17/17.
- The full suite passes 266/266; changed JavaScript passes `node --check`, and `git diff --check` is
  clean.
- The isolated Electron self-test completes without diagnostic errors, and `npm run pack` succeeds.

## Confirmed bug 5: Auto Accept repeated a successful queue-pop action

### Misbehavior

After a successful ready-check accept, the monitor immediately cleared its delay timestamp. Until
League updated `playerResponse` away from `None`, the next 200 ms poll treated the same ready check as
new, posted `/accept` again, and fired the renderer's accepted event again. On a real client this
could create duplicate accept requests and play the configured Auto Accept sound multiple times for
one queue pop.

### Reproduction

The ready-check harness intentionally kept the response at `None` for two monitor ticks, matching the
short eventual-consistency window after an accepted POST. Before the fix, the two ticks produced two
accept requests instead of one; the focused test failed with the duplicate endpoint in its actual
call list.

### Root cause

`acceptDueAt` represented only the delay timer. A successful POST reset it to `null`, and there was no
separate “this ready check was handled” state. The existing manual-response latch protected declines
but did not cover a successful automatic accept.

### Fix

- Latch a ready check immediately after its accept POST succeeds.
- While League remains in `ReadyCheck`, suppress further accepts and renderer sound events even if
  the response endpoint temporarily still says `None`.
- Clear the latch when gameflow leaves `ReadyCheck`, allowing the next genuine queue pop through.

### Confirmation

- The pre-fix two-tick regression produced two POSTs and failed.
- After the fix, two same-pop ticks produce one POST and one accepted event; leaving ReadyCheck and
  entering it again accepts the later pop normally.
- All focused Auto Accept tests pass 4/4, including manual-decline and malformed-response controls.
- The full suite passes 267/267; changed JavaScript passes `node --check`, and `git diff --check` is
  clean.
- The isolated Electron self-test completes without diagnostic errors, and `npm run pack` succeeds.

## Confirmed bug 6: a transient gameflow error invented a game end

### Misbehavior

The five-second game watcher drives game statistics, post-game rank refreshes, notification cleanup,
and deferred settings-baseline capture. `currentGameflowPhase()` returns `null` when the local League
endpoint is briefly unavailable. The watcher converted that unknown value to `inGame: false`, so one
missed poll while a match was still running fired the complete game-end path.

Besides premature cleanup/rank work, this could lose real settings changes: if the user had clicked
**Update baseline** during the game, the false end consumed the deferred request and scheduled a
capture while League had not yet written the in-game changes to disk.

### Reproduction

The transition helper was first wired with the existing behavior unchanged. Starting from
`wasInGame: true`, both a `null` phase and an empty phase produced `ended: true` and
`inGame: false`. The focused regression expected the active game to be preserved and failed with
that exact false end.

### Root cause

The watcher used `Boolean(phase) && IN_GAME_PHASES.has(phase)`. This collapsed “confirmed non-game
phase” and “could not read gameflow” into the same false value, then used the false value for edge
detection and destructive one-shot post-game state transitions.

### Fix

- Classify blank/non-string gameflow as unknown rather than out of game.
- Preserve the previous in-game state on unknown polls and emit neither a start nor end edge.
- Skip stats, cleanup, rank, and settings transitions until a later poll confirms a real phase.
- Keep confirmed `WaitingForStats` and other non-game phases as valid game-end signals.

### Confirmation

- The unavailable-phase regression failed before the classification change and passes afterward for
  both `null` and empty responses.
- Confirmed start and WaitingForStats end controls still pass.
- Related game stats, cleanup, and watcher tests pass 57/57.
- The full suite passes 269/269; changed JavaScript passes `node --check`, and `git diff --check` is
  clean.
- The isolated Electron self-test completes without diagnostic errors, and `npm run pack` succeeds.

## Confirmed bug 7: overlapping chat opens created duplicate or stale connections

### Misbehavior

Chat source activation was not serialized. If the same source account was selected again while its
transport was still being created or connected, each request created and connected its own
transport. With saved-account XMPP this could leave an untracked connection online, duplicate
presence/message callbacks, and make the visible chat depend on whichever attempt finished last.

Account switching exposed a second part of the same lifecycle failure. The switch reset cleared only
transports that had already reached the source map. An activation still awaiting live/saved auth
could finish afterward and put the old source online again. A late close callback from that old
transport could then delete a newly opened replacement for the same account.

### Reproduction

- A credential-free deferred transport probe called the existing source activation twice before
  either connection completed. It reported `connectCalls: 2`.
- The focused concurrent-activation regression likewise observed two transport creations and two
  connection attempts instead of one.
- A second focused regression paused transport creation, ran the same source reset used after an
  account switch, then released creation. Before the fix the supposedly reset activation resolved
  successfully and remained in the service.

### Root cause

`ChatService` tracked only fully created sources. It had no promise for creation/connection in
progress and no generation linking an activation to the account-switch reset that started it.
Transport callbacks were routed only by account id, so callbacks from an obsolete transport were
indistinguishable from callbacks belonging to its replacement.

### Fix

- Share one in-flight activation promise per source account.
- Invalidate pending activations whenever all chat sources are reset or the app stops.
- Close a transport that finishes creating or connecting after its generation was invalidated.
- Token message, presence, and close callbacks to the exact transport instance so stale callbacks
  cannot affect the replacement connection.

### Confirmation

- The two pre-fix regressions failed with two connection attempts and a stale activation resolving;
  both pass after the lifecycle change.
- A third regression confirms that a late close from a reset transport leaves its replacement
  connected and its conversation online.
- The related chat service, protocol, encrypted-store, and renderer-view tests pass 25/25.
- The full suite passes 272/272; changed JavaScript passes `node --check`, and `git diff --check` is
  clean.
- The isolated Electron self-test completes without diagnostic errors, and `npm run pack` succeeds.

## Confirmed bug 8: simultaneous Queue Relay requests started matchmaking twice

### Misbehavior

When the lobby leader had allowed Queue Relay requests, two requests arriving together could both
pass validation and both POST League's matchmaking-start endpoint. This could happen with a rapid
retry or requests from two permitted lobby members, causing duplicate start attempts and duplicate
leader notifications for one queue transition.

### Reproduction

The focused service regression delivered two valid queue-start IQs concurrently with distinct
request ids. Both used the same permitted sender and the same current lobby. Before the fix, the
harness recorded two `/lol-lobby/v2/lobby/matchmaking/search` POSTs instead of one.

This was intentionally reproduced with the credential-free LCU/XMPP harness. A live-client
reproduction would have started matchmaking, which the audit safety rules prohibit.

### Root cause

Replay ids and the per-sender cooldown were checked before asynchronous lobby fetching. The cooldown
was written only after League accepted the start POST. XMPP stanza handlers run concurrently, so a
second request could complete all the same checks before the first request updated either piece of
state.

### Fix

- Claim a leader-side single-flight gate before asynchronous queue-request validation begins.
- Reject any overlapping request with an explicit `request-in-progress` result.
- Keep the gate through the League POST and XMPP response so no later request can observe the
  transition half-complete.
- Preserve the existing permission, identity, party, timing, replay, and cooldown checks.

### Confirmation

- The pre-fix regression failed with two matchmaking POSTs.
- After the fix, the same simultaneous pair produces one matchmaking POST, one successful response,
  and one `request-in-progress` response.
- All Queue Relay service, protocol, and renderer-view tests pass 14/14.
- The full suite passes 273/273; changed JavaScript passes `node --check`, and `git diff --check` is
  clean.
- The isolated Electron self-test completes without diagnostic errors, and `npm run pack` succeeds.
