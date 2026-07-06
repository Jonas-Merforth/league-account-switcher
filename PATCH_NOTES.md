# Patch Notes

Short, friend-readable notes for each release. New unreleased changes go at the top.

## Unreleased

- Added a merged Friends tab that can refresh friends from multiple saved accounts.
- Added source badges so you can see which account(s) know each friend.
- Added richer friend activity: online, mobile, lobby, queue, champ select, in-game info, party size, queue, and who friends are playing with.
- Matched friend status colors closer to the League client: green online/lobby, red away, blue in game.
- Fixed ARAM Mayhem showing as Brawl and filled in more current mode labels.
- Added Show mobile and Show offline toggles.
- Added optional auto-refresh for the merged Friends tab, defaulting to off and 60 seconds, with the first refresh starting right away when due.
- Added favorites in the merged friend list. Starred friends are saved and shown first when they are visible.
- Made the Friends tab source and refresh details calmer: top source accounts are shown first, extra sources collapse, and aggressive refresh progress stays stable.
- Added lobby invites from the merged friend list while your current account is in a lobby.
- Added open-lobby joins from the merged friend list using the currently logged-in account.
- Added session repair for accounts whose saved friendlist session needs a fresh "Stay signed in" login.
- Made aggressive friend scans hide scan-created fake online states for the source accounts.
- Made account cards refresh and show the current in-game name.
- Made switching leave the current League lobby first so the old account does not stay stuck in the party.
- Added a retry button for login typing during account switches and friend-session repairs.
- Made login typing refocus the Riot login window before clicks and paste steps.

## v1.0.12

- Cleaned up the top bar with settings behind a gear button.
- Moved app messages into one shared notice area so updates, switch status, and settings notices feel less cluttered.

## v1.0.11

- Added ranked crests to account cards.
- Made typed login fallback faster and more reliable.
- Waited for the real login form before typing so the Riot intro animation does not eat clicks.
- Fixed several account-switch edge cases found during review.
- Auto-captured the shared settings baseline after games while settings sync is enabled.

## v1.0.10

- Added settings sync across accounts.
- Showed which account the shared settings baseline came from.
- Delayed baseline updates safely if you click them during a game.
- Polished the Appear Offline toolbar icon and active state.

## v1.0.9

- Added Auto Accept from the toolbar.
- Added Appear Offline from the toolbar.
- Added a GitHub button in the app menu.

## v1.0.8

- Polished wording in the app.

## v1.0.7

- Added a safety check before capturing a session into the wrong account.
- Fixed auto-update so enabling it downloads an already-pending update.

## v1.0.6

- Added an OP.GG profile button next to Porofessor.
- Added a repair command for a missing Electron binary in local installs.

## v1.0.5

- Added a Porofessor live-game button for the current account.
- Fixed flicker when dragging accounts into empty sections.

## v1.0.4

- Added drag-and-drop account reordering.
- Added collapsible account sections.

## v1.0.3

- Release maintenance.

## v1.0.2

- Release maintenance and version updates.

## v1.0.1

- Enabled auto-update by default.
- Switched releases to publish directly instead of as drafts.
- Settled the patch-version release scheme.

## 1.1

- Added GitHub auto-update with an update banner, manual check button, and auto-update toggle.

## 1.0

- Added a warning not to use Riot's Sign out button.
- Fixed a stuck "launching League" state.
- Added more useful logs and an Open logs tray action.
- Made tray-initiated switches quieter.
- Reduced installer size.
