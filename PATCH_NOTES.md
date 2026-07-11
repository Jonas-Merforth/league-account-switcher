# Patch Notes

Short, easy-readable notes for each release. New unreleased changes go at the top.

## Unreleased

- Fixed the Friends account header showing Riot Client as starting when only its background services were open.
- Added a collapsible current-account panel above the Friends list with live Riot/League status and both ranks, plus cleaner controls and online-friend rank crests.
- Login fallback now types and submits quietly in the background, with the old foreground method kept as an automatic backup.
- Added an optional client cleanup that claims Season and Mayhem rewards and clears the Collection, TFT, notification, and profile dots from the live client, with a one-time cleanup button too.
- The dot cleanup now works quietly in the background: no more window popping to the front or the mouse moving on its own, and it even works while the client is minimized.
- After switching accounts, the cleanup now runs right away and keeps checking during client startup, so most dots never get a chance to appear.
- After a game, the cleanup now checks every few seconds until new rewards and notification dots have settled.
- Automatic cleanup now also catches the stubborn TFT dot that Riot's data never lets us mark as seen (it quietly visits the tab once per client session in the background).
- The manual cleanup button no longer blindly visits already-seen League home, Collection, or TFT tabs.
- League home news, event, and Patch Notes dots are now marked as seen too, including items lower down in the scrolling list.
- Open lobbies now carry over automatically when switching accounts, even when the new account is not friends with the players in the party.
- Made the Friends tab list its source accounts in the same order as your Accounts tab, including sections (accounts without a section come first).

## v1.0.14 - 2026-07-07

- Made opening or starting on the Friends tab refresh the merged friendlist, while avoiding duplicate refreshes right after auto-refresh.

## v1.0.13 - 2026-07-06

- Added a merged Friends tab that can refresh friends from multiple saved accounts.
- Added source badges so you can see which account(s) know each friend.
- Added richer friend activity: online, mobile, lobby, queue, champ select, in-game info, party size, queue, and who friends are playing with.
- Matched friend status colors closer to the League client: green online/lobby, red away, blue in game.
- Show post-match screens correctly instead of mistaking leftover queue data for a joinable lobby.
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

## v1.0.12 - 2026-07-04

- Cleaned up the top bar with settings behind a gear button.
- Moved app messages into one shared notice area so updates, switch status, and settings notices feel less cluttered.

## v1.0.11 - 2026-07-03

- Added ranked crests to account cards.
- Made typed login fallback faster and more reliable.
- Waited for the real login form before typing so the Riot intro animation does not eat clicks.
- Fixed several account-switch edge cases found during review.
- Auto-captured the shared settings baseline after games while settings sync is enabled.

## v1.0.10 - 2026-06-23

- Added settings sync across accounts.
- Showed which account the shared settings baseline came from.
- Delayed baseline updates safely if you click them during a game.
- Polished the Appear Offline toolbar icon and active state.

## v1.0.9 - 2026-06-23

- Added Auto Accept from the toolbar.
- Added Appear Offline from the toolbar.
- Added a GitHub button in the app menu.

## v1.0.8 - 2026-06-23

- Polished wording in the app.

## v1.0.7 - 2026-06-23

- Added a safety check before capturing a session into the wrong account.
- Fixed auto-update so enabling it downloads an already-pending update.

## v1.0.6 - 2026-06-23

- Added an OP.GG profile button next to Porofessor.
- Added a repair command for a missing Electron binary in local installs.

## v1.0.5 - 2026-06-23

- Added a Porofessor live-game button for the current account.
- Fixed flicker when dragging accounts into empty sections.

## v1.0.4 - 2026-06-23

- Added drag-and-drop account reordering.
- Added collapsible account sections.

## v1.0.3 - 2026-06-22

- Release maintenance.

## v1.0.2 - 2026-06-22

- Release maintenance and version updates.

## v1.0.1 - 2026-06-22

- Enabled auto-update by default.
- Switched releases to publish directly instead of as drafts.
- Settled the patch-version release scheme.

## 1.1 - 2026-06-22

- Added GitHub auto-update with an update banner, manual check button, and auto-update toggle.

## 1.0 - 2026-06-22

- Added a warning not to use Riot's Sign out button.
- Fixed a stuck "launching League" state.
- Added more useful logs and an Open logs tray action.
- Made tray-initiated switches quieter.
- Reduced installer size.
