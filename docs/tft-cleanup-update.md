# Updating TFT notification cleanup

Most TFT submenu cleanup is data-driven and should survive seasonal tab changes without code edits.
The cleanup reads the enabled tabs from `GET /lol-tft/v1/tft/events`, uses each `eventId` and
`startDate`, and advances the matching entries in
`/lol-settings/v2/account/TFT/VersionsSeen`.

Store cleanup is also gated by the live
`lol.client_settings.tft.tft_rotational_shop.enabled` client configuration, so disabled layouts are
not clicked.

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
5. Update the Store click ratio only if its top-level position changes. The current value is
   `TFT_SUBNAV_RATIOS.store` in `src/core/leagueHeaderClicks.js`.
6. Update the focused fixtures in `test/clientCleanup.test.js` and
   `test/leagueBackgroundClicks.test.js`, then run:

   ```powershell
   npm test
   git diff --check
   npm run pack
   ```

## Behavior boundaries

- Event-start and mission-unlock notice pips are marked seen automatically.
- The Store version is persisted first. Because the running Store service does not observe
  `VersionsSeen`, a newly detected Store pip gets one background TFT → Store → League-home visit
  after the renderer grace period.
- A zero completed-mission count is saved as string `"0"`. Riot tests the field for truthiness, so
  numeric zero recreates the Star Atlas pip forever; the string remains numerically comparable and
  still allows the first completed mission to be detected.
- Claimable TFT battle-pass/event-pass rewards and skill-tree choices are actionable state, not a
  seen-version notice. They are not falsely dismissed by this cleanup.
