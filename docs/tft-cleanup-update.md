# Updating TFT notification cleanup

Most TFT submenu cleanup is data-driven and should survive seasonal tab changes without code edits.
Automatic cleanup and **Clean up now** read the enabled tabs from `GET /lol-tft/v1/tft/events`, use
each `eventId` and `startDate`, and advance the matching entries in
`/lol-settings/v2/account/TFT/VersionsSeen` without navigating the client.

Store cleanup is also gated by the live
`lol.client_settings.tft.tft_rotational_shop.enabled` client configuration, so disabled layouts are
not persisted or included in an explicit deep-clean visit.

Two parts of Riot's installed TFT front end are compiled into the JavaScript bundle and must be
checked when a client update changes the TFT navigation:

1. `TFT_ROTATIONAL_SHOP_VERSIONS` in `src/core/clientCleanup.js`. These keys drive the Store pip and
   its internal categories. In client 16.13 all six versions are `1`.
2. `TFT_EVENT_UNLOCK_MISSION_SERIES` in `src/core/clientCleanup.js`. Riot currently special-cases
   `Set17AGE` and compares completed `TFT17_Age_Series` missions with
   `lol-tft.data.lastUnlockCount`. Other event tabs use their dynamic start timestamps.

## Refresh procedure after a TFT navigation change

1. Extract the currently installed TFT bundle:

   ```powershell
   python -m cdtb wad-extract "C:\Riot Games\League of Legends\Plugins\rcp-fe-lol-tft\assets.wad" `
     -o "$env:TEMP\codex-league-wads\rcp-fe-lol-tft"
   ```

2. Open the extracted `global/default/rcp-fe-lol-tft.js` and search for:

   - `TFT_ROTATIONAL_SHOP_VERSIONS`
   - `eventHubsPipStatus`
   - `hasNewUnlocks`
   - `updateUnlockMissionsCount`
   - `subNavTabs`

3. Copy any changed rotational-shop keys or numbers into `TFT_ROTATIONAL_SHOP_VERSIONS`.
4. If Riot adds another event-specific branch like `Set17AGE`, identify the mission series selected
   by `fetchTFTMissions` and add its `eventId` to `TFT_EVENT_UNLOCK_MISSION_SERIES`.
5. Update the Store background-visit ratio only if its top-level position changes. The current value is
   `TFT_SUBNAV_RATIOS.store` in `src/core/leagueHeaderClicks.js`.
6. Update the focused fixtures in `test/clientCleanup.test.js` and
   `test/leagueBackgroundClicks.test.js`, then run:

   ```powershell
   npm test
   git diff --check
   npm run pack
   ```

## Behavior boundaries

- Current-set writes drive announcement state, and event-version or mission-unlock writes drive TFT
  submenu pips. None of those reasons requests a TFT parent visit.
- Event-start and mission-unlock notice pips are marked seen automatically through their settings
  state. If the running renderer keeps a cached pip, it waits for the next League UX session.
- The Store version is persisted first. Because the running Store service does not observe
  `VersionsSeen`, an already-rendered Store pip also waits for the next UX session during automatic
  cleanup and **Clean up now**. The user-requested **Deep-clean visible dots** action visits Store
  whenever the live rotational-shop feature is enabled, including when an earlier API sweep already
  consumed the new-version evidence. Navigation is allowed only while gameflow remains `None`.
- Source-derived TFT visit reasons are limited to offers, residual latch, and Store. A normal
  set-name, event-version, or unlock-count update is not a parent-dot reason. Explicit deep-clean
  itself still forces one TFT parent visit so it can repair an unknown stale renderer cache.
- Client 16.13 was observed with `lol-tft` data but no `seenOfferIds`, while the enabled home hub
  omitted `battlePassOfferIds` and `storePromoOfferIds`. Only when the hub is enabled, preference data
  exists without `seenOfferIds`, and one or more required arrays are missing does the cleanup
  experimentally persist
  `seenOfferIds: { storeOfferIds: [], tacticianOfferIds: [] }` for this exact missing-array case. This
  placeholder is **not live-validated** and can only influence a later UX session; it cannot clear a
  dot already cached by the running renderer.
- A UX restart alone did not solve that residual before the placeholder because startup immediately
  relatched it. Present-but-empty offer arrays are a different, unpersistable residual and may still
  relatch on every session; do not claim the placeholder covers them.
- Deep-clean navigation uses posted background window messages. A failure is logged and returned; it
  never falls back to foreground input or the real cursor. Gameflow is re-checked immediately before
  each background dispatch so a queue transition suppresses the remaining visits.
- A zero completed-mission count is saved as string `"0"`. Riot tests the field for truthiness, so
  numeric zero recreates the Star Atlas pip forever; the string remains numerically comparable and
  still allows the first completed mission to be detected.
- Claimable TFT battle-pass/event-pass rewards and skill-tree choices are actionable state, not a
  seen-version notice. They are not falsely dismissed by this cleanup.
