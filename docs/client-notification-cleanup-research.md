# League client notification cleanup: agent handoff

This is an implementation and research handoff for agents continuing the client-notification cleanup
feature on `codex/notification-remover`. It intentionally records low-level observations, failed
approaches, and live-test procedure. The reusable recorder is
[`scripts/debug-lcu-events.mjs`](../scripts/debug-lcu-events.mjs); keep it in the repository for later
League client investigations.

## Status: the foreground click fallback has been replaced (2026-07-10)

The former highest-priority TODO is done. Live header clears no longer foreground the client, move
the cursor, or synthesize real input. The layered architecture is:

1. **API sweep** (unchanged): preference PATCHes, inventory-notification acknowledgements, pass
   claims, bell deletion.
2. **Event-driven Collection clear** (new): the shipped navigation plug-in's `handleInventoryChange`
   observer sets the shared Collection alert **false** whenever an inventory-notifications change
   event arrives and no unacknowledged `CREATE` remains — even when the alert was latched by
   skin/chroma/ward purchase dates. Because acknowledgements already run after the preference
   PATCHes, a sweep that successfully acknowledged at least one Collection notification suppresses
   the live visit entirely (`headerClearModes.collection === 'event'`). Live-proven on Dr Bonk: the
   Collection and profile dots vanished ~1 s after the final acknowledge with zero clicks.
3. **Background clicks** (new, `src/core/leagueBackgroundClicks.js`): for latched dots with nothing
   left to acknowledge (TFT in particular), window messages (`WM_MOUSEMOVE` +
   `WM_LBUTTONDOWN/UP`) are posted directly to the client's CEF child window
   (`Chrome_RenderWidgetHostHWND`) at the existing header ratios. No `SetForegroundWindow`, no
   `SetCursorPos`, no `mouse_event`; a minimized client is restored with `SW_SHOWNOACTIVATE` and
   re-minimized with `SW_SHOWMINNOACTIVE`. Live-proven on Dr Bonk: cleared the TFT dot while the
   client was occluded and unfocused, and again while minimized; the foreground window handle was
   unchanged before/after.
4. **Foreground clicker** (`src/core/leagueHeaderClicks.js`, demoted): retained only as the
   throw-path fallback inside `createLayeredHeaderClear` (`src/core/leagueHeaderClear.js`) when the
   background path fails (window/CEF child not found, PostMessage failure).
5. **Burst cadence** (new): `ClientCleanupMonitor.kick({ burst: true })` sweeps every 3 s (up to
   3 min) after an account switch until a sweep completes with nothing left to do, then reverts to
   the 30 s cadence. This wins the race against the freshly launched renderer so most dots never
   latch in the first place.

| Surface | Persistent/API action | Live header action |
| --- | --- | --- |
| League Season pass | Event Hub `claim-all` | None |
| ARAM Mayhem pass | Event Hub `claim-all` | None |
| Collection parent dot | Update exact Collection preferences and acknowledge exact inventory notifications | None when a notification was acknowledged (event clears it); otherwise a background PostMessage visit |
| TFT parent dot | Update current set and current home-offer preferences | Background PostMessage visit (the TFT alert is a latch; see below) |
| Notification bell | Delete unread, dismissible, non-critical player notifications | None |
| Dot above summoner name/profile | Update challenge/customizer preferences and acknowledge profile inventory notifications | None |

Collection sub-menu dots are deliberately out of scope. TFT battle-pass rewards, arbitrary reward
choices, critical/non-dismissible warnings, and unrelated generic notifications are also out of scope.

`ClientCleanupMonitor` runs immediately when the persisted `autoClientCleanup` setting is enabled and
then every 30 seconds (3 seconds while bursting after a switch). It has a no-overlap guard. Automatic
sweeps invoke the live Collection/TFT path only when newly unseen content is detected. A manual run
forces both live header visits (now via the background clicker) because stale dots can outlive
already-advanced preferences.

Allowed phases are `None`, `Lobby`, and `Matchmaking`. Other phases return `blocked`. A missing or
unreachable LCU returns `unavailable`.

### Alert set/clear semantics from the shipped navigation bundle (verified 26.13)

Decompiled `rcp-fe-lol-navigation.js` observer behavior, which drives the layering above:

- **Collection**: one shared alert bit. Set true by unacked `CREATE` inventory notifications
  (EMOTE/SKIN_BORDER/SUMMONER_ICON), purchase-date-vs-`lastVisitTime` comparisons, and mastery EAT.
  `handleInventoryChange` is the only external **false**-setter: after any notifications change
  event, it clears the alert when no unacked `CREATE` remains. Acknowledge last; the final ack fires
  the event.
- **TFT**: the set-name observer and home-offer observer only ever set the alert **true** (latch).
  `_handlePlayerPreferencesChange` treats a *missing* `seenOfferIds` as unseen (alert true) and a
  mismatch as unseen; a match does nothing. The only false-setter is `_handleBattlePassV2Change`
  (WS binding `/lol-tft/v2/tft/battlepass`), which on some accounts 404s and never fires. Accounts
  whose home hub has **empty** `battlePassOfferIds`/`storePromoOfferIds` arrays are unfixable via
  preference writes: the front end computes `[undefined, undefined]` as the current store offers,
  which no JSON-persistable `seenOfferIds` can equal, so the TFT dot latches at every client start
  until Riot populates the offers. The background click handles those.
- **Renderer control endpoints exist** (`POST /riotclient/kill-and-restart-ux`, `kill-ux`,
  `launch-ux`, `ux-minimize`, `ux-show`; verified in `/help` on 26.13) and a UX restart would flush
  the alert cache, but it visibly closes/reopens the window for several seconds — rejected for
  automatic use; possible future opt-in "nuke" only.
- Enabling the CEF remote debugger requires DLL injection (Riot removed `--remote-debugging-port`
  in 2017) — rejected for ToS/Vanguard risk.

## LCU transport and discovery

The local League Client Update API is authenticated from `<League install>/lockfile`, whose format is:

```text
name:pid:port:password:protocol
```

Connect to `https://127.0.0.1:<port>` with self-signed TLS accepted and HTTP Basic authentication
`riot:<password>`. Never record or commit the password or derived Authorization header. The repository
implementation is `src/core/lcu.js`; it invalidates cached credentials after request errors so account
switches/client restarts can obtain a new lockfile password.

Useful contract discovery:

```text
GET /help?format=Full
```

Use the full help response as the primary list of HTTP resources, verbs, request bodies, and response
types for the currently installed client. It did not expose a public Collection/TFT navigation-alert
reset endpoint during this investigation.

LCU events use a TLS WebSocket on the same port, subprotocol `wamp`. After upgrade, subscribe with:

```json
[5, "OnJsonApiEvent"]
```

Events arrive with a JSON API payload containing `uri`, `eventType`, and `data`. An absence of an event
after a UI click is meaningful: the click may only mutate in-process front-end state.

## Known API behavior

### Event Hub reward claiming

Read:

```text
GET /lol-event-hub/v1/events
```

Only claim an event when all of the following are true:

- `eventInfo.eventType === "kSeasonPass"`
- `eventInfo.seasonPassSubType` is exactly `Default` or `Mayhem`
- `eventInfo.unclaimedRewardCount > 0`
- an event id is present

Claim all for that exact event:

```text
POST /lol-event-hub/v1/events/{eventId}/reward-track/claim-all
```

Do not claim TFT passes or unrelated Event Hub entries. Process claims before Collection/TFT
acknowledgement, then allow a short settle delay so inventory notifications created by rewards can be
handled by the same or next sweep. The endpoint is idempotent when the unclaimed count is re-read first;
individual event failures must not stop other areas.

### Collection parent dot

The initial assumption that the parent dot was controlled by
`lol-collection-champions.data.lastVisitTime` was wrong. Riot's shipped
`rcp-fe-lol-navigation` bundle showed that the Collection parent alert aggregates several sources.

Owned inventory dates:

| Area | Inventory | Preference | Shipped comparison |
| --- | --- | --- | --- |
| Skins | `GET /lol-inventory/v2/inventory/CHAMPION_SKIN` | `lol-skins-viewer.data.lastVisitTime` | newest purchase `>=` last visit |
| Chromas | `GET /lol-inventory/v2/inventory/CHROMA` | `lol-collection-chromas.data.lastVisitTime` | newest purchase `>` last visit |
| Wards | `GET /lol-inventory/v2/inventory/WARD_SKIN` | `lol-collection-wards.data.lastVisitTime` | newest purchase `>=` last visit |

Only count items where `owned === true`, `f2p !== true`, and `ownershipType === "OWNED"`. LCU purchase
dates may use compact UTC syntax such as `20260710T001433.089Z`; `Date.parse` is not reliable for it.
`parseLeaguePurchaseDate` handles this form explicitly.

When an area is unseen, PATCH the corresponding resource below while preserving every existing data
field, filter, sort option, and schema version:

```text
PATCH /lol-settings/v2/account/LCUPreferences/lol-skins-viewer
PATCH /lol-settings/v2/account/LCUPreferences/lol-collection-chromas
PATCH /lol-settings/v2/account/LCUPreferences/lol-collection-wards
```

Body shape:

```json
{
  "schemaVersion": 1,
  "data": {
    "...existing fields": "preserved",
    "lastVisitTime": 1780000000000
  }
}
```

Chromas currently use fallback schema version 2; skins and wards use fallback version 1. Prefer the
resource's current positive `schemaVersion` over a fallback.

The parent dot also aggregates unacknowledged `CREATE` inventory notifications from:

```text
GET /lol-inventory/v1/notifications/EMOTE
GET /lol-inventory/v1/notifications/SKIN_BORDER
GET /lol-inventory/v1/notifications/SUMMONER_ICON
POST /lol-inventory/v1/notification/acknowledge   body: <numeric notification id>
```

Champion/mastery attention uses:

```text
GET/PATCH /lol-settings/v2/account/LCUPreferences/lol-collection-champions
data["lcm-eat-seen"]: false -> true
```

Important: all of these API writes can persist successfully while the visible Collection parent dot
remains. The running navigation plug-in caches its item alert. In the shipped bundle, the alert is
cleared by `NavigationPlugin.setItemAlert(item, false)` from the Collection navigation item's
`show`/`hide` callback. Opening Collection triggers that callback; merely PATCHing the backing state
does not reliably do so.

### TFT parent dot

Current set:

```text
GET /lol-game-data/assets/v1/tftsets.json
default set: LCTFTModeData.mDefaultSet.SetCoreName, falling back to SetName
GET/PATCH /lol-settings/v2/account/LCUPreferences/lol-tft
data.lastTftSetNameSeen
```

Never hardcode a set such as `TFTSet17`; compare the current default set dynamically.

Current home offers:

```text
GET /lol-tft/v1/tft/homeHub
```

When the hub is enabled and required offer arrays are populated, its current seen shape is:

```json
{
  "seenOfferIds": {
    "storeOfferIds": ["<first battlePassOfferId>", "<first storePromoOfferId>"],
    "tacticianOfferIds": ["<all tacticianPromoOfferIds>"]
  }
}
```

Merge changed `lastTftSetNameSeen` and/or `seenOfferIds` into the existing `lol-tft` preference.

As with Collection, a correct persisted PATCH did not clear an already-rendered TFT parent dot. Riot's
navigation bundle clears the cached item alert through `NavigationPlugin.setItemAlert(item, false)` in
the TFT navigation item's `show`/`hide` flow. Clicking TFT caused the dot to disappear with no distinct
acknowledgement HTTP request/event.

`POST /lol-tft/v1/tft/homeHub/redirect` was tested and did not navigate the visible client or clear the
cached dot. Preference observers may persist state but did not reset this cached alert.

### Bell and profile/name dot

Bell cleanup reads:

```text
GET /player-notifications/v1/notifications
DELETE /player-notifications/v1/notifications/{id}
```

Delete only `state === "unread"`, `dismissible === true`, and `critical !== true`. Generic player
notification lists were empty on accounts that still had Collection/TFT dots, so this endpoint is not
a general header-dot source.

The dot above the summoner name/profile is handled with these sources:

```text
GET/PATCH /lol-settings/v2/account/LCUPreferences/lol-customizer-tokens
GET/PATCH /lol-settings/v2/account/LCUPreferences/lol-challenges-latest-level-up
GET /lol-challenges/v1/latest-challenge-level-up
GET /lol-inventory/v1/notifications/ACHIEVEMENT_TITLE
GET /lol-inventory/v1/notifications/SUMMONER_ICON
GET /lol-inventory/v1/notifications/REGALIA_BANNER
POST /lol-inventory/v1/notification/acknowledge   body: <numeric notification id>
```

Advance the customizer token `lastVisitTime` past the newest level-up, reset stored
`lastLevelUpTime` to zero when nonzero, and acknowledge only unacknowledged `CREATE` inventory
notifications. On the Dr Bonk live test the bell cleared first; the remaining gold dot above the name
then cleared without a click after these targeted sources were handled.

## Persisted state versus live navigation state

This distinction caused the original false-positive result:

1. The cleanup PATCH returned success and a subsequent GET showed the new account preference.
2. The implementation reported “cleared the Collection dot.”
3. The visible dot remained because `rcp-fe-lol-navigation` had already computed and cached an alert.
4. Opening the navigation item called its internal `setItemAlert(false)` path and removed the dot.

Therefore a successful HTTP response is evidence that future sessions/account state are correct, but
not evidence that the current client UI changed. Structured results set `cleared.collection` and
`cleared.tft` only after the live fallback reports success. Future API-only implementations need a
separate live acceptance assertion.

## Failed or incomplete approaches

Do not repeat these without a new reason or new client version evidence:

- PATCHing `lol-collection-champions.lastVisitTime`: wrong state for the Collection parent alert.
- PATCHing the correct skins/chromas/wards and TFT preferences alone: persisted, but did not invalidate
  the running navigation alert.
- Generic `/player-notifications/v1/notifications`: may be empty while these dots are present.
- Generic inventory notification lists alone: the skin/chroma/ward purchase-date comparisons are
  separate sources.
- `POST /lol-tft/v1/tft/homeHub/redirect`: did not clear the parent dot.
- Searching `/help?format=Full` for a public Collection/TFT navigation endpoint: none was exposed in
  the tested 26.13 client.
- Watching the LCU event stream for a special acknowledgement call after clicking Collection/TFT:
  no such call appeared; the meaningful action was in-process front-end state.
- Screenshot/pixel detection: intentionally rejected as brittle and unnecessary for detection.
- Restarting/reloading the client to flush navigation state: too disruptive and unsafe around queues,
  ready checks, and games.

## Current live clear implementations

Primary: `src/core/leagueBackgroundClicks.js` (background PostMessage clicker). It:

1. Finds the visible `LeagueClientUx` window titled “League of Legends”.
2. If minimized, restores it with `SW_SHOWNOACTIVATE` (posted clicks against an iconic window are
   unreliable) and re-minimizes with `SW_SHOWMINNOACTIVE` in `finally`.
3. Finds the CEF input child window (class `Chrome_RenderWidgetHostHWND`).
4. Rejects unexpectedly small client areas (`< 900 x 500`).
5. Posts `WM_MOUSEMOVE` (CEF resolves the click target from the last hover), `WM_LBUTTONDOWN`,
   `WM_LBUTTONUP` with client-relative `lParam` coordinates at the header ratios below.
6. Ends on League home. Never activates the window or touches the real cursor.

Fallback: `src/core/leagueHeaderClicks.js` (the original foreground clicker), invoked only when the
background script throws, via `createLayeredHeaderClear` in `src/core/leagueHeaderClear.js`.

Shared ratios (exported from `leagueHeaderClicks.js`):

```json
{
  "league": { "x": 0.2, "y": 0.058 },
  "tft": { "x": 0.255, "y": 0.058 },
  "collection": { "x": 0.592, "y": 0.058 }
}
```

These worked across the tested 1600x900 League clients because the ratios target the stable top nav,
but localization, layout changes, window sizes, or Riot client redesigns can break both clickers.
Known cosmetic side effect of the background clicker: chat presence can flip from Away to Online
because the client registers activity.

## Recorder workflow

Start capture before asking the user to touch any client page or switching to an account with fresh
dots:

```powershell
node scripts/debug-lcu-events.mjs "$env:TEMP\lcu-notification-trace.jsonl"
```

The recorder:

- reads fresh lockfile credentials but never writes them;
- reconnects after account switches/client restarts;
- subscribes to all `OnJsonApiEvent` events;
- polls selected resources every 500 ms and records only changes/errors;
- summarizes large owned inventories as a count and ten newest purchase records;
- appends JSONL so exact before/action/after timestamps can be compared.

It currently watches the relevant account preferences, TFT set/home state, Collection inventories,
Collection inventory notifications, player notifications, regalia, TFT passes, and gameflow. Extend
`watchedEndpoints` before consuming a rare fresh notification if a new hypothesis needs another
resource. A single user click should be made only after `capture-ready` is present. Note the precise
wall-clock action time and inspect both `lcu-event` and `snapshot-change` records around it.

Do not commit captured JSONL. Although credentials are omitted, traces can contain account ids,
summoner data, inventory ids, and other user-specific state.

Recommended acceptance sequence:

1. Start recorder and confirm `capture-ready` plus complete initial snapshots.
2. Switch to a fresh account with untouched target dots; do not click Collection/TFT first.
3. Save the before screenshot and identify the visible dots.
4. Run **Clean up now** while automation is disabled.
5. Confirm the visible dots disappear and League home is restored.
6. Inspect trace changes and the switcher log; do not rely only on the cleanup result string.
7. Wait beyond 30 seconds to detect reappearance.
8. Separately verify a blocked game phase causes no UI/API action.

## Shipped Riot front-end inspection

The decisive logic was found in Riot's installed WAD, not the public LCU endpoint list:

```text
<League install>/Plugins/rcp-fe-lol-navigation/assets.wad
extracted file: rcp-fe-lol-navigation.js
```

CommunityDragon's `cdtb` tooling was installed into temporary directories only. A reproducible Windows
setup is:

```powershell
python -m pip install --target "$env:TEMP\codex-cdtb" cdtb
$env:PYTHONPATH = "$env:TEMP\codex-cdtb"
$env:CDRAGON_DATA = "$env:TEMP\codex-cdragon-data"
python -m cdtb fetch-hashes
python -m cdtb wad-extract "<League install>\Plugins\rcp-fe-lol-navigation\assets.wad" `
  -o "$env:TEMP\codex-league-wads\rcp-fe-lol-navigation"
```

The investigation used `%TEMP%\codex-cdtb`, `%TEMP%\codex-cdragon-data`, and
`%TEMP%\codex-league-wads`; none are application dependencies or repository files.

Search the extracted JavaScript for:

- `setItemAlert`
- `lastVisitTime`
- `lastTftSetNameSeen`
- `lcm-eat-seen`
- inventory names `CHAMPION_SKIN`, `CHROMA`, `WARD_SKIN`
- `NavigationPlugin`
- TFT provider methods such as `showTFTHome` and `recordSetAnnouncementSeen`

The bundle exposed useful in-process concepts including `NavigationPlugin.setItemAlert`, navigation
item `show`/`hide` handlers, `Navigation.navigatePluginById`, TFT `showTFTHome`, and
`recordSetAnnouncementSeen`. These are provider/remoting methods inside the CEF front end, not HTTP
resources confirmed by `/help?format=Full`.

## Future research order

Items 1-3 and 7 of the original list are resolved: the Collection alert is cleared through the
`handleInventoryChange` observer (acknowledge-last), the TFT alert has no external false-setter
besides the often-404 battlepass binding, and the live clear behind the injected callback is now the
background PostMessage clicker with the foreground clicker as throw-path fallback. Remaining:

1. Compare future client versions' `/help?format=Full` and navigation WAD; Riot may expose or change
   a supported endpoint, add a battlepass binding that fires, or repopulate the home-hub offer
   arrays (which would make the empty-offer TFT latch fixable via `seenOfferIds` again).
2. Keep the persistent preference/inventory acknowledgement layer even though the background clicker
   works. One handles account state; the other handles the current renderer cache.
3. If the background clicker ever breaks (CEF input routing change), `POST
   /riotclient/kill-and-restart-ux` is a validated-to-exist but disruptive opt-in alternative.

## Live validation history

- **Nueluclor**: original Season and Mayhem counts validated Event Hub filtering and claim-all. Opening
  Collection -> Skins and TFT manually demonstrated that their state could be acknowledged.
- **Dr Bonk**: recorder-assisted work separated the bell from the gold profile/name dot. Targeted API
  acknowledgement cleared both; Collection parent cleared after opening Collection even while a Chroma
  sub-menu dot remained, confirming parent and child pips are separate.
- **UwUmind**: reproduced the bug where **Clean up now** reported Collection cleared but the visible
  Collection and TFT dots remained. Correct preference PATCHes persisted. Direct user clicks cleared
  the dots without a separate acknowledgement endpoint, establishing the live navigation-cache issue.
- **Azir to Plat**: final acceptance account with fresh Collection and TFT dots. Before cleanup,
  `lastTftSetNameSeen` was `TFTSet16`, current default was `TFTSet17`, and an unacknowledged
  `SUMMONER_ICON` notification was present. The updated manual cleanup advanced TFT to `TFTSet17`,
  created/advanced ward Collection visit state, acknowledged the icon notification, visited the two
  live tabs, returned League home, and visibly removed both parent dots. The user confirmed it worked.

The successful manual run logged:

```text
Client cleanup (manual): cleared the Collection indicator, cleared the TFT indicator.
```

- **Dr Bonk (2026-07-10, background rework)**: started with fresh Collection, TFT, and profile dots.
  Acknowledging the single unacked `SUMMONER_ICON` inventory notification (id `0` — ids can be
  falsy, keep the explicit `undefined`/`null` checks) cleared the Collection **and** profile dots
  within ~2 s with no click, proving the `handleInventoryChange` event-clear. The TFT dot was
  latched by a missing `seenOfferIds` while the home hub's battle-pass/store offer arrays were
  empty and `/lol-tft/v2/tft/battlepass` 404'd, so no API path existed; the new background
  PostMessage clicker cleared it while the client was occluded/unfocused, and the minimized
  restore/re-minimize path was verified separately. The foreground window handle was unchanged
  before/after the script, confirmed via `GetForegroundWindow`.

## Regression coverage and result contract

`runClientCleanup` returns:

- `status`: `completed`, `blocked`, or `unavailable`
- `phase`
- claimed reward count and per-event details
- dismissed player-notification count
- acknowledged Collection/profile notification counts
- `cleared.collection`, `cleared.tft`, and `cleared.profile`
- `headerClearModes.collection` / `headerClearModes.tft`: `'event'`, `'background'`,
  `'foreground'`, `'live'` (injected callback without a mode), or `null`
- per-area `{ area, message }` errors for partial failure

Tests cover Event Hub filtering/URLs/zero counts/partial failures/idempotence, compact purchase dates,
exact Collection sources and preference merging, dynamic TFT comparison, blocked/unavailable states,
manual forced live headers, click ratios/cursor restoration, monitor reentrancy/immediate enable, and
settings/preload/IPC wiring. Before pushing related changes, run:

```powershell
npm test
$env:LAS_SELFTEST = '1'; npx electron .
npm run pack
```

The Electron self-test should print `SELFTEST: done` and exit; also check its preload API, update UI,
cleanup UI, renderer, and IPC probes. Packaging is important because PowerShell invocation, ESM
imports, preload exposure, and Electron main-process wiring can pass unit tests while failing in the
packaged app.
