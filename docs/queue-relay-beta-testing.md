# Queue Relay beta testing

This guide is for the isolated Queue Relay test build from the
`codex/explore-lobby-queue-start` branch.

## What is isolated

The beta is intentionally separate from the release installation:

- Windows app ID: `com.merforth.league-account-switcher.beta`
- Product and shortcut name: `League Account Switcher Beta`
- Installer output name starts with `league-account-switcher-beta-`
- Data folder: `%APPDATA%\LeagueAccountSwitcherBeta`
- Log: `%APPDATA%\LeagueAccountSwitcherBeta\switcher-beta.log`
- Electron browser data: `%APPDATA%\LeagueAccountSwitcherBeta\electron-user-data`
- Start with Windows and the release auto-updater are disabled in the beta.

On first launch, the beta copies the current accounts, encrypted sessions, layout, settings, and
settings baseline from `%APPDATA%\LeagueClientAutomation`. After that one-time copy, the beta and
release stores are independent. Changes made in the beta do not write back to the release store.
Uninstalling the beta does not uninstall or upgrade the release app.

The copied session files remain Windows-DPAPI encrypted. Do not send the beta data directory to
anyone. Only send `switcher-beta.log` when reporting a problem.

## Before testing

Both testers should:

1. Install and run `League Account Switcher Beta`.
2. Prefer closing the release Account Switcher during the test so there is only one tray utility
   monitoring the League client. The release installation can be reopened afterwards.
3. Start League and sign in to an account already present in Account Switcher.
4. Open the Beta's Friends tab.
5. Confirm Queue Relay says `Riot XMPP connected`.

If it stays disconnected:

- confirm the currently signed-in League account exists in the Beta's Accounts tab;
- confirm it has a saved session;
- use Capture in the Beta while signed in with **Stay signed in** if its copied session is stale;
- inspect `switcher-beta.log` for `Queue relay:` and `Queue relay auth:` lines.

## First two-PC test

Use a normal or ARAM lobby for the first test, not ranked.

1. Join the same lobby with both beta-enabled accounts.
2. Make the friend's account the lobby leader.
3. Wait up to approximately 15 seconds for presence, resource probing, and capability responses.
4. On the leader's Beta, open Friends -> Queue Relay.
5. The other lobby member should show `Beta tool detected`.
6. The leader checks `Allow queue starts` for that member. This permission is stored by Riot PUUID.
7. Wait for the next capability probe. On the non-leader's Beta, `Start via leader` should become
   enabled and say it is ready through the leader.
8. The non-leader clicks `Start via leader` once.
9. The leader's Beta validates both live lobbies and calls the normal local queue-start LCU endpoint.
10. Matchmaking should begin for the party.

The protocol sends custom XMPP IQ stanzas only. It does not send a League chat body. During the
test, explicitly check that neither League client shows a blank chat message, new conversation,
sound, toast, or changed status.

## Expected UI states

- `Queue relay is connecting`: saved-session XMPP authentication is still running.
- `The lobby leader's beta tool was not detected`: only an ordinary League XMPP resource was found,
  or Riot did not route the capability response.
- `Leader tool detected. The leader must allow requests from you`: transport works, but the required
  per-friend permission is off.
- `Ready through <Riot ID>`: transport and permission are ready; the button is enabled.
- `You are the lobby leader`: the start button is disabled and detected lobby peers are listed with
  their permission checkboxes.

## Logs to send after a test

Right-click the Beta tray icon and choose **Open logs**, or open:

```text
%APPDATA%\LeagueAccountSwitcherBeta\switcher-beta.log
```

Send the complete log from both PCs and include:

- which account was leader;
- approximate time of the click;
- whether `Beta tool detected` appeared on both PCs;
- whether the permission checkbox stayed checked;
- whether the non-leader button became enabled;
- whether matchmaking started;
- whether any visible League chat/status side effect appeared;
- a screenshot of both Queue Relay panels if the states differ.

Useful log milestones include:

- `Queue relay: matched active saved account`
- `Queue relay: connected`
- `Queue relay: observed XMPP resource`
- `Queue relay: capability probe sent`
- `Queue relay: capability probe received`
- `Queue relay: beta peer confirmed`
- `Queue relay: permission allowed`
- `Queue relay: queue-start received`
- `Queue relay: validation`
- `Queue relay: matchmaking started`
- `Queue relay: queue-start response`

Access, PAS, entitlement, cookies, passwords, and raw session contents are never written by Queue
Relay logging.

## Failure interpretation

- Both sides connect, but neither detects the other: inspect whether each side observed more than one
  resource for the other PUUID. Riot may not be broadcasting the helper resource.
- Resources are observed, probes are sent, but no probe is received: Riot may be rejecting or routing
  custom client-to-client IQs only to another resource.
- Capability succeeds but permission never updates: compare probe response timestamps after the
  leader toggled permission.
- The request arrives but is rejected: the leader log includes the exact validation code and live
  phase/party/queue checks.
- Validation succeeds but LCU rejects: the leader log contains the LCU error; confirm roles, selected
  positions, penalties, and queue availability in League.
- Matchmaking starts but the sender times out: the action path worked but the result IQ was lost; the
  two logs will distinguish that from a failed start.
