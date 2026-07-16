# Patch Notes

Short, easy-readable notes for each release. New unreleased changes go at the top.

## Unreleased

- Login typing now keeps going when you switch to another window, and retries enable "Stay signed in" before entering credentials.
- Automatic cleanup and “Clean up now” no longer click around League; an explicit idle-only deep clean is available for stubborn visible dots without moving the real mouse.
- Added an experimental next-session fix for the stubborn TFT dot when Riot omits its offer data.

## v1.0.20 - 2026-07-14

- Manual ready-check declines now cancel a pending delayed auto-accept instead of being overridden.
- Fixed Queue Relay permissions becoming unclickable after spending time in a game or post-game screen.
- Friends in the same match now stay together in the list without overriding favorites.
- Friends who are in the same match now show up as playing together in the Friends list.
- Fixed Queue Relay repeatedly printing background errors after connecting.
- Fixed Away and in-game friends sometimes flipping to plain Online between Friends refreshes when they also had another chat connection open.

- Friend refreshes now update in a stable status bar without making the friend list jump or interrupting cards while you hover them.
- Friend refresh failures now explain whether they need a retry or a fresh login, and broken saved sessions can be repaired together in Riot Client without repeatedly launching League before returning to the account you were using.
- Added multi-account chat: pick any account that shares a friend, keep each source → friend conversation separate, see live presence and unread counts, and keep recent history encrypted locally.
- Added a configurable chat online timeout, with three minutes as the default, so background chat accounts disconnect automatically when idle.
- Fixed new replies staying hidden when they arrived shortly after closing a chat.
- Kept friend cards tidy when Chat and lobby actions appear together, without clipped source-account pills or redundant unavailable buttons.
- Fixed sent chat text remaining in the message field after pressing Enter or Send.
- Made leased background chat accounts appear online to League friends until their chat timeout expires.
- Added full live friend status to chats, with familiar presence colors and hover details for games, queues, champions, and lobbies.
- Synced a friend's status across chats from different accounts and made narrow chat rows lead with the friend's name instead of a clipped route.
- Made chat use the same resolved friend status as the Friends list, avoiding generic online signals overriding Away or in-game states.

## v1.0.19 - 2026-07-12

- Friend lobbies now show their current occupancy, such as 2/5 for Flex or 1/2 for Solo/Duo, in a compact badge that stays readable in narrow mode.
- Replaced the unclear Stats menu symbol with a proper chart icon.
- Added an optional volume-controlled chime when the app auto-accepts a queue, so muted League clients no longer make queue pops easy to miss.
- Fixed game stats for every queue, including ARAM Mayhem, and made the most-played accounts appear first with each game-type breakdown available on hover.
- Friend source badges can now switch straight to that account, prefer the accounts you use most, and include a small stats view for logins and games by queue.

## v1.0.18 - 2026-07-12

- Client cleanup now clears every League-home card plus new League and TFT mission notices without opening the objectives window.

## v1.0.17 - 2026-07-12

- Kept crowded friend cards tidy by compacting the party-friend badge while preserving its details on hover.
- Away friends with an open lobby can now still be joined, matching the League client.
- Fixed misleading zero-loss records and rank-tooltip flickering in the Friends list.
- Fixed open-lobby rejoining after an account switch when League's lobby service takes a few extra seconds to become ready.
- Fixed recurring Collection dots by tracking each collectible category's real unlock state, including Chromas, and quietly clearing an already-visible parent dot once.
- TFT cleanup now also clears Store and seasonal-event tab dots, discovering rotating event tabs automatically and handling Riot's zero-progress edge case.

## v1.0.16 - 2026-07-11

- Queue Relay and the current account's Friends list now use the signed-in League client's live credentials, so they keep working even when that account's saved friend session needs repair. Refreshed sessions are also checked automatically after normal captures and switches.

## v1.0.15 - 2026-07-11

- Added an opt-in Queue Relay that lets a permitted lobby member ask the leader's Account Switcher to start matchmaking without sending a League chat message.
- Made Friends actions follow the current account's lobby and game state live, explain disabled actions on hover, disable joins that League would reject, and hide the active account from its own friend list.
- Stopped stale last-match details from showing idle friends as being on a post-match screen.
- Made aggressive Friends refreshes much lighter by safely reusing short-lived Riot credentials and decrypting selected saved sessions together.
- Kept the full detailed diagnostic log while batching busy bursts into fewer disk writes.
- Changing the Friends auto-refresh interval now refreshes immediately when the new interval is already due.
- Fixed the app name shown for League Account Switcher in Windows Task Manager.
- Kept in-game durations visible by compacting long source-account badges sooner on narrow friend cards.
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
