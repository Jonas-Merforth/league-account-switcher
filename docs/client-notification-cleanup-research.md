# League client notification cleanup: agent handoff

This is an implementation and research handoff for agents continuing the client-notification cleanup
feature. It intentionally records low-level observations, failed
approaches, and live-test procedure. The reusable recorder is
[`scripts/debug-lcu-events.mjs`](../scripts/debug-lcu-events.mjs); keep it in the repository for later
League client investigations.

## Status: automatic cleanup is API/event-only; renderer visits are explicit (2026-07-14)

The current safety boundary is:

1. **Automatic cleanup and Clean up now are API/event-only.** They PATCH preferences (including all
   current Activity Center ids and the current Patch Notes build), mark displayed objective missions
   viewed, acknowledge exact inventory notifications, claim supported passes, and delete safe bell
   notifications. They do not navigate League or synthesize input.
2. **Events can still clear some current UI.** In particular, the shipped navigation plug-in's
   `handleInventoryChange` observer can false-set the Collection parent alert after the final real
   inventory notification is acknowledged. This was live-proven on Dr Bonk without a visit.
3. **Persisted state is not visual proof.** Activity Center, date-backed Collection, TFT parent, and
   TFT Store services cache some state inside the running renderer. When no observer false-sets a
   cached dot, an ordinary run leaves it for the next League UX session.
4. **Deep-clean visible dots is the only renderer-navigation path.** It is an explicit user action,
   allowed only when gameflow is exactly `None`. It forces all eligible Activity Center rows plus the
   Collection and TFT parent visits; TFT Store is included whenever the live rotational-shop feature
   is enabled, including after an earlier API sweep consumed its new-version evidence. Each visit
   returns to League home.
5. **Deep-clean is background-only.** It posts window messages to the CEF child and never activates
   League, moves the real cursor, or falls back to the foreground clicker. Gameflow is re-checked
   immediately before each dispatch; a background failure is logged and returned as an error.
6. **Burst cadence remains API-only.** `ClientCleanupMonitor.kick({ burst: true })` sweeps every 3 s
   for at least 30 s (up to 3 min) after an account switch or game. It then returns to the normal 30 s
   cadence after an error-free quiet sweep; no renderer grace timer or deferred automatic visit is
   needed.

| Surface | Persistent/API or event action | Current renderer behavior |
| --- | --- | --- |
| League Season pass | Event Hub `claim-all` | No navigation |
| ARAM Mayhem pass | Event Hub `claim-all` | No navigation |
| League-home news/events + Patch Notes | Persist every current Activity Center id and build version | Cached pips wait for the next UX; explicit deep-clean visits all eligible rows and scrolls when needed |
| League + TFT objectives | Read the two live objective layouts and mark only their active `isNew` mission ids viewed | API observer path; no navigation |
| Collection parent dot | Persist exact category state and acknowledge exact inventory notifications | A real acknowledgement event can clear it now; otherwise it waits for the next UX or an explicit deep-clean parent visit |
| Collection child dots | Track the shipped Skins, Emotes, Icons, Wards, Chromas, Finishers, and mastery sources | Persist seen state; deep-clean does not visit child tabs |
| TFT parent dot | Persist valid offer state; apply the experimental missing-array placeholder only in its narrow case | Cached parent dots wait for the next UX or an explicit deep-clean parent visit |
| TFT submenu dots | Advance dynamic event versions, mission-unlock count, and the current Store version map | Event/unlock settings do not request a parent visit; cached Store waits for the next UX or an enabled-Store deep-clean visit |
| Notification bell | Delete unread, dismissible, non-critical player notifications | No navigation |
| Dot above summoner name/profile | Update challenge/customizer preferences and acknowledge profile inventory notifications | API/event path; no navigation |

Runes' auto-modified-page notice and the Spells/Items tabs are deliberately out of scope. Spells and
Items expose no review pip; Runes is not an owned-unlock timestamp. Claimable TFT pass rewards,
arbitrary reward choices, critical/non-dismissible warnings, and unrelated generic notifications are
also out of scope.

`ClientCleanupMonitor` runs immediately when the persisted `autoClientCleanup` setting is enabled and
then every 30 seconds (3 seconds while bursting after a switch or game). It has a no-overlap guard.
Automatic sweeps and **Clean up now** may persist/acknowledge state in `None`, `Lobby`, and
`Matchmaking`, but never request UI navigation. **Deep-clean visible dots** may send visits only in
`None`; in `Lobby` or `Matchmaking` its API work may still complete, but UI navigation is refused.
Other phases are blocked before notification endpoints are touched. A missing or unreachable LCU
returns `unavailable`.

### Alert set/clear semantics from the shipped navigation bundle (verified on client 16.13)

Decompiled `rcp-fe-lol-navigation.js` observer behavior, which drives the split above:

- **Collection**: one shared alert bit. Set true by unacknowledged `CREATE` inventory notifications
  (EMOTE/SKIN_BORDER/SUMMONER_ICON), purchase-date-vs-`lastVisitTime` comparisons, and mastery EAT.
  `handleInventoryChange` is the only external **false**-setter: after any notifications change
  event, it clears the alert when no unacknowledged `CREATE` remains. Acknowledge last so the final
  real acknowledgement fires the event.
- **TFT parent**: `_handlePlayerPreferencesChange` treats missing `seenOfferIds` or a current-offer
  mismatch as unseen. `_handleBattlePassV2Change` can also drive claimable state, but its binding is
  conditional. Current-set announcements, event versions, mission-unlock counts, and rotational Store
  versions are different UI sources; they must not be collapsed into a generic "TFT updated" reason
  that causes a parent visit.
- **Precise TFT navigation reasons**: only `offers`, `residual`, and `store` are source-derived
  renderer-visit reasons. Set-name, normal event-version, and unlock-count writes persist their own
  state without requesting a TFT parent visit. The Store reason may add the Store sub-navigation step
  during explicit deep-clean; it does not make ordinary cleanup navigate. The explicit deep-clean
  force of the TFT parent is independent of this source list.
- **Observed missing-array case** (Dr Bonk and Nueluclor, client 16.13): the live home-hub response had
  no `battlePassOfferIds` or `storePromoOfferIds` properties, while the existing `lol-tft` data had no
  `seenOfferIds`. The preference observer can latch true, but the hub handler cannot calculate normal
  offer state because its `Array.isArray` guard fails. Beware when probing: PowerShell's `-join`
  prints missing keys and empty arrays identically, and `Invoke-RestMethod` returns `$null` for an
  empty JSON array.
- **Experimental placeholder**: only for that exact missing-properties + missing-preference case, the
  cleanup writes `seenOfferIds: { storeOfferIds: [], tacticianOfferIds: [] }`. This is deliberately
  marked **unvalidated**: it is intended to prevent the missing-value latch after a later UX start,
  but it cannot mutate the current renderer and has not yet been confirmed across a fresh session.
  Do not broaden it to present offer arrays or overwrite real ids.
- **Present-but-empty arrays are a separate residual case**: the front end can compute
  `[undefined, undefined]`, which no JSON-persistable `seenOfferIds` can equal. Do not claim the empty
  placeholder solves it.
- **No supported current-session TFT reset exists on 16.13 for these accounts.** The only false-setter
  found is `_handleClaimableStateChange` with nothing claimable, driven by the conditional
  `/lol-tft/v2/tft/battlepass` binding. On Nueluclor the `tft_pass_upgrade` config was empty, that
  endpoint returned 404, and the observer was never registered. The nav item's `show`/`hide` callbacks
  or a complete UX restart remain the only renderer-cache resets found. A restart did **not** solve
  the missing-array residual before the placeholder because startup immediately latched it again; a
  present-but-empty/unpersistable residual can still relatch on every restart.
- `lastTftSetNameSeen` drives the set announcement modal, not the parent navigation alert. This was the
  key reason the former generic `updated` flag produced unnecessary TFT visits when only set, event,
  or unlock state had changed.
- **Renderer control endpoints exist** (`POST /riotclient/kill-and-restart-ux`, `kill-ux`,
  `launch-ux`, `ux-minimize`, `ux-show`; verified in `/help` on 16.13), but a UX restart visibly
  closes/reopens the window for several seconds and remains rejected for automatic use.
- Enabling the CEF remote debugger requires DLL injection (Riot removed `--remote-debugging-port`
  in 2017) and remains rejected for ToS/Vanguard risk.

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

### League-home news/event and Patch Notes pips

The scrolling left rail on the League landing page is the **Activity Center** implemented inside the
shipped `rcp-fe-lol-navigation.js` bundle. Its content is dynamic; never hardcode titles such as
“Locke” or ids from a particular patch. Read the current ordered config from:

```text
GET /lol-activity-center/v1/content/client-nav
```

Each row carries a `navigationItemID`. Ordinary rows (and `info-hub`, when present) are persisted in:

```text
GET/PATCH /lol-settings/v2/account/LCUPreferences/activity-center
data.tabsViewed = JSON.stringify({ "<current navigationItemID>": true, ... })
```

Expired ids are pruned using the current config, matching the shipped pip manager's
`updateViewedTabsWithOnlyValidTabs` behavior. `lol-patch-notes` is special: it is not stored in
`tabsViewed`. The client compares `data.lastPatchNotesViewed` to the first two components of:

```text
GET /system/v1/builds
version: "16.13.789.3741" -> lastPatchNotesViewed: "16.13"
```

The visible content ids currently use `26-13-*` names while `/system/v1/builds` reports `16.13`;
use the endpoint value exactly rather than deriving a version from the navigation ids or UI footer.
Preserve unrelated fields such as `thematicTimelineViewed` and the existing schema version.

#### Why API persistence does not prove a current-session visual clear

The persistence path is complete and is always attempted first, but the running Ember pip manager
does not observe later changes to the `activity-center` preference. In the shipped code:

- `shouldShowActivityPip` reads the in-memory `pipManager.tabsViewed` object;
- `shouldShowPipOnPatchNotes` reads in-memory `lastPatchNotesViewed` versus `buildVersion`;
- `removePip(tab)` mutates those values and PATCHes the preference only from the row's selection
  handler (`markTabVisited` / `selectTab`);
- the method named `handleActivityCenterSettingsChanged` exists but is not registered as an observer.

Live tests on Fire Crotch exhausted the non-click invalidation paths after a successful preference
PATCH: the pips remained after the settings event, after `POST /lol-activity-center/v1/clear-cache`,
and after a background leave-and-return through TFT. `/help?format=Full` exposes only Activity Center
GETs plus `clear-cache`; there is no mark-seen or pip-manager mutation resource. A UX restart would
rebuild the service from the correct preference but is far more disruptive. Therefore row selection
is the only current-session false-setter on this build.

#### Exhaustive non-click route investigation (2026-07-10)

There are two clean **in-renderer** ways to select an Activity Center item, but neither crosses the
renderer boundary through a supported external API:

1. A normal row calls `Navigation.activityCenter.route("lc_home_tab", { tabId })`. The route handler
   invokes the callback registered by `lc_set_deep_link_callback`; that callback is the controller's
   `handleSelectTab`. Changing `selectedTabId` causes the row component's `markTabVisited` observer to
   call `pipManager.removePip(tab)`. This would be the ideal no-click path if it were externally
   callable.
2. The shared-components managed-iframe bridge accepts the DOM message
   `rcp-fe-lol-home-open-activity-center` with `initialSelectedActivityId`, then calls
   `activityCenter.showActivityCenter({ pageName: "hub", initialSelectedActivityId })`. This is a
   CEF `postMessage` listener for already-managed Riot content, not an LCU/WAMP resource.

The following possible bridges were traced or tested and ruled out:

- **LCU HTTP surface:** the complete 16.13 `/help?format=Full` contract has Activity Center content,
  config, overrides, ready, and `clear-cache` only. The deep-links plugin has only settings and the
  LoR launch-link generator. There is no general navigation, route, mark-seen, or front-end provider
  invocation endpoint.
- **Front-end provider remoting:** `rcp-fe-plugin-runner` gives plugins direct JavaScript references
  to dependency APIs. Its socket subscribes to `OnJsonApiEvent` and can call backend WAMP procedures;
  it does not register front-end provider methods as WAMP procedures. Live authenticated WAMP calls
  to `lc_home_tab`, `Navigation.activityCenter.route`,
  `rcp-fe-lol-navigation.activityCenter.route`, and
  `rcp-fe-lol-navigation/lc_home_tab` all returned `MethodNotFound`.
- **Other shipped front ends:** all 39 installed `rcp-fe-*` WADs were extracted to a temporary
  directory (`66` JavaScript bundles) and searched. Only the navigation bundle contains
  `lc_home_tab`; only navigation/shared-components contain the Activity Center show route. No
  backend-observed URI in any shipped front end forwards data into that route. Publishing a made-up
  JSON API event therefore has no route subscriber to target.
- **`/riotclient/new-args`:** none of the shipped front ends observes this resource. Navigation reads
  `/riotclient/command-line-args` once during startup and recognizes only
  `--initial-route=<broad Home/TFT/NPE route>`. A live `--initial-route=SHOW_HOME` submission to
  `new-args` succeeded as an event but neither became a process command-line argument nor exposed an
  Activity Center id route. It cannot drive already-rendered rows.
- **`riotclient://` URI scheme:** Windows registers it as
  `RiotClientServices.exe --app-command="%1"`. The installed Riot Client implementation recognizes
  auth, Vanguard, product-launch, and invite/smart-URL command families; it rejects unknown command
  URLs. Its League deep-link backend exposes no Activity Center command.
- **Settings/cache refresh:** the pip manager observes `/lol-settings/v2/ready` only for its initial
  load and guards that path with `!isInitialized`; it never observes the Activity Center preference.
  Consequently settings reload events cannot refresh its cached `tabsViewed`. Activity Center cache
  clear and the season-driven Activity Center refresh rebuild content/navigation, not the pip-manager
  values, and auto-select only the default row.
- **Windows accessibility:** both Computer Use and raw UI Automation saw only the outer League
  window, `CefBrowserWindow`, `Chrome_WidgetWin_0`, and one `Chrome_RenderWidgetHostHWND` document.
  No Activity Center row exposes a button, name, automation id, or `InvokePattern`, so there is no
  coordinate-free accessibility action.
- **CEF debugging:** the UX/render process command lines have no remote-debugging flag, no
  `DevToolsActivePort` exists, and no UX/render process owns a listening TCP port. Enabling CDP or
  forcing renderer accessibility would require relaunch flags/injection. External plug-ins are also
  unavailable in the running plugin manager. These paths are rejected for fragility and
  ToS/Vanguard risk.
- **UX restart:** `POST /riotclient/kill-and-restart-ux` would rebuild the pip manager from the
  already-correct persisted preference and is technically non-click. It closes/reopens the complete
  client, is unsafe around queues/ready checks/games, and is much more disruptive than the narrowly
  targeted background row visits, so it remains rejected for automatic cleanup.

Conclusion for client 16.13: the supported API can make future-session state correct, but no
supported external call can mutate the already-instantiated pip manager or invoke its internal
selection route. Ordinary cleanup therefore stops after persistence. The user-requested deep-clean
uses background PostMessage row visits as the least invasive current-session option; it should be
re-evaluated whenever the navigation WAD or `/help` contract changes.

#### Explicit Activity Center deep-clean implementation

`src/core/leagueActivityCenterClicks.js` is called only by **Deep-clean visible dots**. It sends the
explicit Activity Center row visits without foregrounding the client or moving the real cursor:

1. It uses the ordered live config to convert requested current ids into row indices. Deep-clean
   deliberately requests every current eligible row so it can repair a stale renderer even when the
   persisted preference is already current. Expired rows, sticky ids, and the separately rendered
   `lc_open_metagame` header are not miscounted.
2. It opens League home and resets the hidden scroll container to the top with posted
   `WM_MOUSEWHEEL` messages.
3. It clicks requested rows among the safe first eight positions. When a requested row is lower, it
   scrolls to the bottom and addresses the last eight positions from the bottom of the current list.
   This covers up to sixteen dynamic rows without screenshots or OCR.
4. It treats `lol-patch-notes` / `info-hub` as sticky footer rows and restores the first dynamic home
   card at the end.
5. Like the header background clicker, it uses `Chrome_RenderWidgetHostHWND`,
   `SW_SHOWNOACTIVATE`, and `SW_SHOWMINNOACTIVE`, so minimized clients are supported without focus or
   cursor movement.

Automatic account-switch bursts and **Clean up now** persist the ids but never call this clicker and
do not retain automatic renderer retries. A stale current-session pip waits for the next UX unless the
user explicitly runs deep-clean while gameflow is `None`. Posted-message success is recorded as a
visit sent, not as proof that a particular pip visibly disappeared.

### League and TFT objective-card pips

The shipped `rcp-fe-lol-objectives` bundle exposes an exact no-click path for the yellow dots on
mission cards and the objectives-button count. Its card hover handler batches the hovered mission's
id; closing the modal also collects every currently displayed mission whose `isNew` field is true.
Both paths finish with:

```text
PUT /lol-missions/v1/player
{ "missionIds": ["..."], "seriesIds": [] }
```

Do not build this list from `GET /lol-missions/v1/missions`. That raw response includes hidden and
internal missions (notably many TFT unlock probes) whose `isNew` state is unrelated to a visible
objectives dot. Mirror the renderer instead: read both
`GET /lol-objectives/v1/objectives/lol` and `/tft`, keep only active categories/groups/missions in a
displayed status, and submit their distinct `isNew` mission ids. On the live 16.13 test account this
produced exactly the 14 remaining TFT mission ids shown by the objectives badge after the League
cards had been hovered manually.

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

The later assumption that generic `/lol-inventory/v2/inventory/CHROMA` was the right Chroma source
was also wrong. Both `rcp-fe-lol-navigation` and `rcp-fe-lol-collections` read the champion inventory:

```text
GET /lol-summoner/v1/current-summoner
GET /lol-champions/v1/inventories/{summonerId}/champions
```

Owned skin and chroma purchase dates are nested under each champion's skins. This matters on accounts
where the generic CHROMA inventory is empty: Haschbruder had 39 owned nested chromas and a missing
`lol-collection-chromas.data`, so a chroma acquired on 2026-04-30 was treated as unseen at every login.

Owned inventory dates:

| Area | Inventory | Preference | Shipped comparison |
| --- | --- | --- | --- |
| Skins | nested `/lol-champions/v1/inventories/{summonerId}/champions` ownership | `lol-skins-viewer.data.lastVisitTime` | newest purchase `>=` last visit |
| Chromas | nested `/lol-champions/v1/inventories/{summonerId}/champions` ownership | `lol-collection-chromas.data.lastVisitTime` | newest purchase `>` last visit |
| Wards | `GET /lol-inventory/v2/inventory/WARD_SKIN` | `lol-collection-wards.data.lastVisitTime` | newest purchase `>=` last visit |
| Finishers | `GET /lol-inventory/v2/inventory/NEXUS_FINISHER` | `lol-collection-finishers.data.lastVisitTime` | newest purchase `>=` last visit |

For nested skins and chromas, use `ownership.owned === true`. For ward inventory, ignore F2P entries;
the finisher route already returns owned inventory. LCU purchase dates may use compact UTC syntax such
as `20260710T001433.089Z`; `Date.parse` is not reliable for it.
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

Use the current Collections plug-in schemas: Skins 2, Summoner Icons 2, Wards 3, Chromas 2, and
Finishers 1. Preserve existing filter/sort fields and fill Riot's normal collection defaults when a
preference is missing; a partial object with only `lastVisitTime` is not a valid replacement for the
route's settings shape.

#### Collection child pip map

The installed `pip-notifications` service drives the sub-navigation alerts as follows:

- **Skins:** nested owned-skin dates plus unacknowledged `SKIN_BORDER` creates.
- **Emotes:** unacknowledged `EMOTE` creates; the Emotes panel acknowledges them when opened.
- **Icons:** unacknowledged `SUMMONER_ICON` creates.
- **Wards:** `WARD_SKIN` purchase dates versus `lol-collection-wards.lastVisitTime`.
- **Chromas:** nested owned-chroma dates versus `lol-collection-chromas.lastVisitTime`.
- **Finishers:** `NEXUS_FINISHER` purchase dates versus `lol-collection-finishers.lastVisitTime`.
- **Runes:** pages with `autoModifiedSelections`; intentionally not treated as an owned unlock.
- **Spells / Items:** their `has...ForReview` values are hardcoded false.

Settings changes do not false-set an already-instantiated date-backed child pip. The route's
`dismissNotification(category)` call does that when the child tab opens. Automatic cleanup and
**Clean up now** persist every detected category but do not visit either the parent or child tabs. A
real inventory-notification acknowledgement may false-set the current parent through
`handleInventoryChange`; otherwise current cached pips wait for the next UX. Deep-clean may force the
Collection parent visit, but deliberately does not walk the child tabs. The corrected timestamps
prevent the date-backed pips from being recreated on the next session.

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

Never hardcode a set such as `TFTSet17`; compare the current default set dynamically. This field
drives the set announcement, not the TFT parent navigation dot, so changing it must not request a
parent visit.

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

Merge changed `lastTftSetNameSeen` and/or valid `seenOfferIds` into the existing `lol-tft`
preference. When one or more required offer arrays are missing and existing preference data also
lacks `seenOfferIds`, the implementation additionally writes the experimental empty-array placeholder
described above. It is next-session-only and remains unvalidated; do not present it as a live clear.

As with Collection, a correct persisted PATCH did not clear an already-rendered TFT parent dot. Riot's
navigation bundle clears the cached item alert through `NavigationPlugin.setItemAlert(item, false)` in
the TFT navigation item's `show`/`hide` flow. Visiting TFT caused the dot to disappear with no distinct
acknowledgement HTTP request/event. Ordinary runs therefore report persisted/next-session state and do
not visit; explicit deep-clean forces the TFT parent visit even when no current source reason is
detectable.

`POST /lol-tft/v1/tft/homeHub/redirect` was tested and did not navigate the visible client or clear the
cached dot. Preference observers may persist state but did not reset this cached alert.

### TFT submenu dots

The installed `rcp-fe-lol-tft` bundle builds seasonal event tabs from live data:

```text
GET /lol-tft/v1/tft/events
GET/PATCH /lol-settings/v2/account/TFT/VersionsSeen
```

For normal enabled events, a pip is shown while the saved value for `eventId` is older than the
event's `startDate`. The cleanup discovers those ids and timestamps dynamically; names such as
`7YA` are not hardcoded.

Store uses the same `VersionsSeen` resource but compares compiled keys from
`TFT_ROTATIONAL_SHOP_VERSIONS`. Client 16.13 ships six version-1 keys. The running rotational-shop
service reads them only during initialization, so persistence prevents future sessions but does not
remove an already-rendered Store pip. The write is gated by the live rotational-shop client
configuration. Automatic cleanup and **Clean up now** leave the current renderer alone. Explicit
deep-clean adds a TFT → Store → League-home visit whenever that live configuration is enabled,
because an earlier API-only sweep may already have consumed the new-version evidence while the
current renderer kept its cached pip.

`Set17AGE` is a Riot exception: its Star Atlas pip compares completed `TFT17_Age_Series` missions
from `/lol-missions/v1/missions` with `lol-tft.data.lastUnlockCount`. Riot's truthiness check makes
numeric zero permanently unseen. String `"0"` is the compatible zero sentinel: it is truthy and
still compares numerically when the first mission completes. The maintenance procedure for compiled
Store versions and future event exceptions lives in `docs/tft-cleanup-update.md`. This unlock-count
write and normal event-version writes affect submenu state only; neither is a TFT parent-visit reason.

Reward/choice state remains distinct. Claimable event-pass milestones and skill-tree choices can
also light an event tab; those are not falsely marked resolved by a version write.

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
not evidence that the current client UI changed. The current contract reports persisted state and
next-session reasons separately from `uiNavigation.visitsSent`. Even a sent PostMessage is delivery
evidence, not a screenshot/DOM assertion that the dot disappeared. Keep visual acceptance separate.

## Failed or incomplete approaches

Do not repeat these without a new reason or new client version evidence:

- PATCHing `lol-collection-champions.lastVisitTime`: wrong state for the Collection parent alert.
- Reading `/lol-inventory/v2/inventory/CHROMA`: wrong source for the Collections plug-in; use nested
  champion inventory ownership instead.
- PATCHing the correct skins/chromas/wards and TFT preferences alone: persisted, but did not invalidate
  the running navigation alert.
- Generic `/player-notifications/v1/notifications`: may be empty while these dots are present.
- Generic inventory notification lists alone: the skin/chroma/ward purchase-date comparisons are
  separate sources.
- `POST /lol-tft/v1/tft/homeHub/redirect`: did not clear the parent dot.
- Searching `/help?format=Full` for a public Collection/TFT navigation endpoint: none was exposed in
  the tested 16.13 client.
- Watching the LCU event stream for a special acknowledgement call after clicking Collection/TFT:
  no such call appeared; the meaningful action was in-process front-end state.
- Using `POST /lol-inventory/v1/notification/acknowledge` with sentinel id `0` as a Collection
  observer poke when no real notification exists: the call succeeds and emits generic inventory
  events, but a live forced-dot test showed the Collection pip remains. Only acknowledging a real
  typed notification produces the observer update that clears the rendered parent alert.
- Screenshot/pixel detection: intentionally rejected as brittle and unnecessary for detection.
- Restarting/reloading the client to flush navigation state: too disruptive and unsafe around queues,
  ready checks, and games.

## Current explicit renderer-navigation implementation

Automatic cleanup and **Clean up now** never enter this path. An explicit **Deep-clean visible dots**
request may call `src/core/leagueBackgroundClicks.js` for header/Store visits and
`src/core/leagueActivityCenterClicks.js` for Activity Center rows, but only in gameflow phase `None`.
The header clicker:

1. Finds the visible `LeagueClientUx` window titled “League of Legends”.
2. If minimized, restores it with `SW_SHOWNOACTIVATE` (posted clicks against an iconic window are
   unreliable) and re-minimizes with `SW_SHOWMINNOACTIVE` in `finally`.
3. Finds the CEF input child window (class `Chrome_RenderWidgetHostHWND`).
4. Rejects unexpectedly small client areas (`< 900 x 500`).
5. Posts `WM_MOUSEMOVE` (CEF resolves the click target from the last hover), `WM_LBUTTONDOWN`,
   `WM_LBUTTONUP` with client-relative `lParam` coordinates at the header ratios below.
6. Ends on League home. Never activates the window or touches the real cursor.

There is **no foreground fallback**. `createLayeredHeaderClear` logs a background failure and rethrows
the original error; cleanup never invokes the real-cursor implementation. The old
`src/core/leagueHeaderClicks.js` module still supplies shared ratios, but its foreground clear is not
part of this feature's execution path.

Shared ratios (exported from `leagueHeaderClicks.js`):

```json
{
  "league": { "x": 0.2, "y": 0.058 },
  "tft": { "x": 0.255, "y": 0.058 },
  "collection": { "x": 0.592, "y": 0.058 }
}
```

These worked across the tested 1600x900 League clients because the ratios target the stable top nav,
but localization, layout changes, window sizes, or Riot client redesigns can break the background
scripts. Known cosmetic side effect: chat presence can flip from Away to Online because the client
registers activity. This is another reason navigation remains explicit rather than automatic.

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
resource. When a comparison requires a manual Riot-client click, make that click only after
`capture-ready` is present. Note the precise wall-clock action time and inspect both `lcu-event` and
`snapshot-change` records around it.

Do not commit captured JSONL. Although credentials are omitted, traces can contain account ids,
summoner data, inventory ids, and other user-specific state.

Recommended acceptance sequence:

1. Start recorder and confirm `capture-ready` plus complete initial snapshots.
2. Switch to a fresh account with untouched target dots; do not click Collection/TFT first.
3. Save the before screenshot and identify the visible dots.
4. Run **Clean up now** while automation is disabled.
5. Confirm the expected API writes/events in the trace and confirm League did not navigate. Do not
   require a renderer-cached dot to disappear in this session.
6. Inspect the structured result and switcher log: persisted/acknowledged state is not a visual clear,
   and `visit sent` must appear only for an explicit deep-clean.
7. Start a later League UX session and verify that persistable dots do not return. Test the
   experimental missing-offer placeholder separately; it is not accepted until this fresh-session
   check succeeds.
8. For current-session visual acceptance, reach gameflow `None`, save another before screenshot, and
   run **Deep-clean visible dots**. Confirm only background visits are sent, League home is restored,
   and the target dots are visually absent. A sent visit alone is not proof.
9. Force a background-message failure and confirm it is reported without foregrounding League or
   moving the real cursor.
10. Verify deep-clean refuses navigation in `Lobby` and `Matchmaking` even though persistence/API work
    may run, and verify active/transition phases block before notification endpoints are touched.

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

The supported 16.13 API/event surface is exhausted for current renderer caches, and automatic
navigation has been removed. Continue in this order:

1. Live-validate the experimental empty `seenOfferIds` placeholder across a fresh UX start on an
   account whose home hub still omits the required arrays. Confirm both the persisted preference and
   whether the TFT parent relatches. Until then, keep it labeled experimental/next-session-only.
2. Compare future versions' `/help?format=Full`, navigation WAD, `tft_pass_upgrade` config, and home-hub
   response. Riot may add a supported Activity Center/navigation reset, register a usable battlepass
   observer, or restore offer arrays. Do not infer behavior from the `26-13-*` content-id names; the
   verified client build is 16.13.
3. Investigate a supported pre-UX preference path or plug-in-only reload only if new evidence appears.
   No remote Riot account-settings write or targeted navigation plug-in reload was confirmed in this
   audit; `/help` exposed only the disruptive full UX controls.
4. Keep persistence and exact inventory acknowledgements as the primary architecture. Explicit
   deep-clean handles only the current renderer cache and must remain phase-`None`, background-only,
   and free of any foreground fallback.
5. `POST /riotclient/kill-and-restart-ux` is validated to exist but is not a general solution: it is
   disruptive, and an unpersistable residual can immediately relatch during startup. Treat it only as
   research or a future explicit last resort, never automatic recovery.

## Live validation history

Entries before 2026-07-14 preserve research evidence from the former implementation. Background
visits described there proved renderer behavior, but automatic cleanup and **Clean up now** no longer
perform those visits.

- **Current 16.13 audit (2026-07-14, phantom-navigation investigation)**: live Activity Center state
  already contained all 11 normal current row ids and Patch Notes `16.13`, yet the former forced plan
  still produced 14 click sequences and 30 wheel messages. The same day's diagnostic log contained
  six League-home passes and ten automatic TFT background visits, with zero foreground fallbacks.
  Code tracing found the TFT trigger conflated set-name, event-version, unlock-count, offers, and Store
  updates behind one generic `updated` value even though the shipped navigation bundle sources the
  parent alert from offer/residual or conditional battlepass state, not set/event/unlock writes. The
  live home hub omitted `battlePassOfferIds` and `storePromoOfferIds`, `lol-tft` lacked
  `seenOfferIds`, `tft_pass_upgrade` was empty, and `/lol-tft/v2/tft/battlepass` returned 404. This
  evidence motivated API-only ordinary runs, the precise TFT reason split, and explicit deep-clean.
- **UwUmind (2026-07-11, TFT submenu source test)**: screenshots showed Store, 7Y Bash, and Star
  Atlas pips. `TFT/VersionsSeen` was null; the live events endpoint supplied `7YA` and `Set17AGE`;
  `lastUnlockCount` was missing while the matching mission series had zero completions. Persistence
  alone immediately removed 7Y Bash and Star Atlas. Store remained because its service caches the
  version at startup, and opening Store removed it, proving that a current-session visit worked. The
  implementation at that time restored deliberately-staled Store/unlock values, performed the
  background TFT → Store → League-home sequence without errors, and a final screenshot confirmed all
  three submenu pips absent.
- **UwUmind (2026-07-11, full Collection acceptance)**: a screenshot before cleanup showed the
  Collection parent dot after login. The account had 57 owned nested chromas, a newest purchase on
  2025-05-02, and an older saved Chroma visit time. Persistence advanced the complete schema-2
  preference and reported only `chromas`; the then-automatic background Collection visit cleared
  the parent dot and returned League home. Follow-up screenshots showed both the parent dot and the
  Chromas child dot absent.
- **Haschbruder (2026-07-11, category-source diagnosis)**: the parent Collection dot returned 5-15 s
  after login. The correct champion inventory contained 39 owned chromas (newest purchase
  2026-04-30), while `lol-collection-chromas` had schema 0 / null data and the generic CHROMA
  inventory used by the old cleanup was empty. Riot therefore recreated the Chromas child pip and
  Collection parent alert every login.
- **Nueluclor**: original Season and Mayhem counts validated Event Hub filtering and claim-all. Opening
  Collection -> Skins and TFT manually demonstrated that their state could be acknowledged.
- **Dr Bonk**: recorder-assisted work separated the bell from the gold profile/name dot. Targeted API
  acknowledgement cleared both; Collection parent cleared after opening Collection even while a Chroma
  sub-menu dot remained, confirming parent and child pips are separate.
- **UwUmind**: reproduced the bug where **Clean up now** reported Collection cleared but the visible
  Collection and TFT dots remained. Correct preference PATCHes persisted. Direct user clicks cleared
  the dots without a separate acknowledgement endpoint, establishing the live navigation-cache issue.
- **Azir to Plat (historical foreground-free visit acceptance)**: final acceptance account with fresh Collection and TFT dots. Before cleanup,
  `lastTftSetNameSeen` was `TFTSet16`, current default was `TFTSet17`, and an unacknowledged
  `SUMMONER_ICON` notification was present. The updated manual cleanup advanced TFT to `TFTSet17`,
  created/advanced ward Collection visit state, acknowledged the icon notification, visited the two
  live tabs, returned League home, and visibly removed both parent dots. The user confirmed it worked.

That historical manual run logged the following. This wording is obsolete because it called a sent
visit "cleared" without an independent visual assertion:

```text
Client cleanup (manual): cleared the Collection indicator, cleared the TFT indicator.
```

- **Nueluclor (2026-07-10, residual-latch investigation)**: only a TFT dot, latched by a `lol-tft`
  preference without `seenOfferIds` while the home hub omitted its battle-pass/store offer arrays
  — nothing writable, so pre-fix automatic sweeps never requested the click (the reported bug).
  Confirmed `tft_pass_upgrade` client-config empty → no battlepass observer → no event-clear
  possible (see the alert map above). The former residual detector plus automatic background visit
  was validated live on this account, but that automatic visit has since been removed. The new
  placeholder requires separate next-session validation.
- **Dr Bonk (2026-07-10, background rework)**: started with fresh Collection, TFT, and profile dots.
  Acknowledging the single unacked `SUMMONER_ICON` inventory notification (id `0` — ids can be
  falsy, keep the explicit `undefined`/`null` checks) cleared the Collection **and** profile dots
  within ~2 s with no click, proving the `handleInventoryChange` event-clear. The TFT dot was
  latched by a missing `seenOfferIds` while the home hub omitted its battle-pass/store offer arrays
  and `/lol-tft/v2/tft/battlepass` 404'd, so no API path existed; the new background
  PostMessage clicker cleared it while the client was occluded/unfocused, and the minimized
  restore/re-minimize path was verified separately. The foreground window handle was unchanged
  before/after the script, confirmed via `GetForegroundWindow`.
- **Fire Crotch (2026-07-10, Activity Center sidebar)**: the live navigation config contained ten
  dynamic rows plus sticky Patch Notes. Only Soccer Cup Skins and MSI were initially persisted;
  `lastPatchNotesViewed` was `15.23` while `/system/v1/builds` resolved to `16.13`. A single merged
  preference PATCH persisted all current ids and the build while preserving
  `thematicTimelineViewed`, but every already-rendered pip remained. Settings events, Activity Center
  `clear-cache`, and a background TFT/League round trip did not invalidate the pip manager. The new
  background row pass then cleared every visible pip, scrolled to and cleared the initially hidden
  Eclipse Eternal Aspect Diana row, cleared Patch Notes, and restored the first home card. A separate
  scroll-down visual check confirmed the lower list was clean.

## Regression coverage and result contract

`runClientCleanup` returns:

- `status`: `completed`, `blocked`, or `unavailable`
- `phase`
- claimed reward count and per-event details
- dismissed player-notification count
- acknowledged Collection/profile notification counts
- newly persisted Collection and TFT category identifiers (`collectionSeenCategories`,
  `tftSeenCategories`)
- current League-home state persisted by the sweep (`homeViewedCount` and the ids actually changed in
  `homePersistedIds`)
- `tftLiveClearReasons`: exact current-renderer reasons (`offers`, `residual`, `store`); set-name,
  event-version, and unlock-count writes never appear here
- `tftNextSessionReasons`: persistable TFT state that can affect a later UX. It contains offer/Store
  reasons when no visit was sent, and contains `residual` only when the experimental placeholder was
  actually applied. An unpersistable present-but-empty-array residual remains live-only because it
  will relatch after restart.
- `tftOfferPlaceholderApplied`: whether the narrow, experimental empty-array `seenOfferIds` write ran
- `uiNavigation`: `{ requested, allowed, blockedReason, visitsSent }`, where `visitsSent` contains
  booleans for League home, Collection, TFT, and TFT Store. This is the explicit deep-clean dispatch
  record, not proof that the pixels changed.
- per-area `{ area, message }` errors for partial failure

Result and log terminology must match the evidence level: use persisted/marked viewed/acknowledged for
API and event work, `visit sent` for successful background dispatch, and visually verified only when a
separate screenshot or user observation exists. Do not restore `'foreground'` as a header mode or
describe a PostMessage success as “cleared.”

Tests cover Event Hub filtering/URLs/zero counts/partial failures/idempotence, compact purchase dates,
exact Collection sources and preference merging, dynamic TFT events, Store versions/feature gating,
the zero-unlock sentinel, dynamic Activity Center ids and build versions, the missing-array placeholder,
the TFT reason split, API-only automatic/manual runs, phase-`None` deep-clean gating, background click
planning without foreground fallback, blocked/unavailable states, click ratios, monitor
reentrancy/immediate enable, and settings/preload/IPC wiring. Before pushing related changes, run:

```powershell
npm test
$env:LAS_SELFTEST = '1'; npx electron .
npm run pack
```

The Electron self-test should print `SELFTEST: done` and exit; also check its preload API, update UI,
cleanup UI, renderer, and IPC probes. Packaging is important because PowerShell invocation, ESM
imports, preload exposure, and Electron main-process wiring can pass unit tests while failing in the
packaged app.
