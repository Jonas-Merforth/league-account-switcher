# Shared gameplay settings

With sync enabled, the active account's latest settings are captured after a game and before a normal account switch. A manual **Apply now** deliberately keeps the existing baseline. Friend-session repairs do not replace it.

The shared snapshot covers `game.cfg`, `input.ini`, and `PersistedSettings.json`; rune pages and item sets remain account-specific. A validated, atomic `settings-baseline/snapshot.json` replaces the previous separate baseline files on the next capture. Older baselines remain readable. An incomplete JSON write cannot replace the last good snapshot.

## Handoff

1. Cancel and drain any pending post-game capture. Pin the outgoing LCU connection to its lockfile session.
2. Once outside a game with `/lol-game-settings/v1/ready` true, call `reload-post-game` and `save` to flush gameplay changes, then capture the files and live summoner identity.
3. With League closed, copy the baseline and briefly make its files read-only during the incoming account's download.
4. Wait for the incoming settings-ready signal. Unlock the files, patch supported fields through `/lol-settings/v2/account/GamePreferences/{game-settings,input-settings}`, read the values back, then save.
5. Release file locks on success, failure, shutdown, sync disable, and app startup recovery. A lockfile or arbitrary delay alone does not establish settings readiness.

Post-game captures belong to the client session that played the game. An unreachable phase does not count as game end. Exact byte equality at game start is no longer a prerequisite for saving the user's changes.

## Evidence (League 16.20, 2026-10-14)

The shipped `rcp-fe-lol-settings` frontend uses the GamePreferences patch routes with `{schemaVersion: 1, data}` and waits for the settings-ready resource. The live Nueluclor client confirmed that patching `HUD.ShowSpellCosts` and saving updates both the API and `PersistedSettings.json`. A temporary disk change followed by `reload-post-game` updated the live API as expected. The new capture/apply/verify helpers were exercised against that client, including restoration of the original value and writable files afterward.

Automated coverage includes incomplete captures, optional file removal, legacy migration, typed API fields, delayed readiness, rejected writes, timeout/game guards, and cancellation before a delayed capture commits. Cross-account and actual game-exit checks are tracked separately from these API checks.
