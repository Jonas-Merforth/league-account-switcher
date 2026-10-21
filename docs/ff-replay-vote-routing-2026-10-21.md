# Who receives surrender votes: replay evidence

Research date: 2026-10-21, branch `ff-detecting`. Follows
[the live decoding work](ff-live-decoding-2026-10-18.md), which decoded our
own team's votes but could not test enemy votes. Re-checked the same day
against the client code, historical packet definitions and public sources;
the corrections from that pass are folded in below.

## Result

**The server sends surrender vote starts and updates only to the five players
on the voting team.** An opposing client receives nothing while the enemy vote
is open, so no decoder on our side can see it early. That holds however many
of our five players run the app. "Detect their FF and surrender first" is
therefore not possible from our own clients.

The evidence comes from replay files: they log the vote messages once per
recipient, and every vote we found was logged exactly five times, never ten.
Replays also let us check any downloaded game. The enemy does not need the
app, and the game does not have to end in a surrender.

**What the other team does get is the result.** When a vote passes, both teams
are told in all chat (community wiki, consistent with the client code below).
Our measurements put the game-over point **5.0 s** after that acceptance and
the client's game end **8.75 s** after it. The community wiki documents that a
team which surrenders inside that window takes the Defeat. That is the
[late-surrender path](#what-remains-possible): no advance warning, but the
"we lose even though they surrendered" outcome looks achievable and needs one
real test.

## Evidence 1: replays log one copy per generated packet

A ROFL2 replay is the spectator stream: zstd frames holding the same observer
block format the `spectator-stats` branch parses. It is not encrypted. Packet
IDs change every patch, so [`research/ff_replay_votes.py`](../research/ff_replay_votes.py)
identifies the three surrender message types by structure (see its docstring):

| Role | 16.14 ID | 15.23 ID | Pattern | Historical name |
| --- | --- | --- | --- | --- |
| Can-surrender flag (per player) | 765 | 868 | One byte per hero; ten at once when surrender unlocks | `S2C_SetCanSurrender` |
| Vote start/update | 891 | 669 | Same instant as one player's flag change; 10–13 bytes | `S2C_TeamSurrenderVote` |
| Announcement | 568 | 317 | One per vote window, at the deciding vote or the timeout | `S2C_TeamSurrenderStatus` |

The historical names come from the community packet definitions in
[LeaguePackets](https://github.com/moonshadow565/LeaguePackets/tree/master/LeaguePackets/Game).
Their fields match what the 16.20 decoder reads exactly: the vote message
carries `VoteYes`, `OpenVoteMenu`, the voter's net ID, for/against counts, the
team and a timeout; the status message carries a reason plus for/against/team;
`SetCanSurrender` is a single bit. So the three types are the same messages
the live decoder already handles, and "eligibility" in the earlier report is
Riot's can-surrender flag.

**How the stream logs messages.** Three observations fix the model:

- Broadcasts appear once. The game-over packet (type 174, no target) appears
  exactly once per replay; per-player end-of-game packets appear ten times.
- Nothing is deduplicated. Among the 210 logged vote copies, two were
  byte-identical to another copy at the same instant and were still logged.
- The five copies of a vote message differ in two bytes, so they are five
  separately generated per-recipient packets, not one broadcast.

Together: the count of a message in the replay is the number of packets the
server generated. A live client receives one `SetCanSurrender` at unlock (every
16.20 capture) while the replay holds ten, and one vote message per vote event
(16.20: 4 for 4 events, 9 for 9) while the replay holds five. If the opposing
team received the vote too, the replay would hold ten copies, identical or not.
It never does:

| Replay | Patch | Vote windows (voting team → outcome) | Copies per message |
| --- | --- | --- | --- |
| 7620083713 | 15.23 | 100 failed | 5 (4 messages) |
| 7921097546 | 16.14 | 200 failed, 100 failed, 200 failed, 200 failed | 5 (15) |
| 7921363271 | 16.14 | 200 failed, 200 failed | 5 (7) |
| 7921381160 | 16.14 | 200 failed, **200 accepted** | 5 (7) |
| 7921390249 | 16.14 | 200 failed, 100 failed, 200 failed, 200 failed | 5 (13) |
| 7921136462, 7921244815, 7921410317 | 16.14 | no votes | — |

That is 46 vote messages in 13 windows, from both teams, across two patches,
all logged exactly five times. No other packet type is tied to vote moments.
The only frequent co-occurrence, type 556, is the ~30 Hz replication tick that
shares a timestamp with anything processed in the same server frame.

Full per-message output (no names or IDs beyond game IDs):
[ff-replay-vote-evidence-2026-10-21.json](ff-replay-vote-evidence-2026-10-21.json).

The can-surrender flags reproduce Riot's documented rules to within
milliseconds, which supports the type identification:

- Unlock: 8:00 in Mayhem/ARAM, 15:00 on Summoner's Rift.
- Team cooldown: 180 s from the vote **start** (for example 934.026 → 1114.044).
- Initiator cooldown: 360 s on the Rift (934.026 → 1294.034); **300 s in
  Mayhem** in our 16.20 captures (513.7 → 813.7, 1093.8 → 1393.8).
- A failed vote closes at 25 s (903.660 → 928.680) or as soon as it can no
  longer pass.

## Evidence 2: the game-over timeline

Two independent sources give the same numbers:

| Event | 16.14 replay 7921381160 | 16.20 live capture 8016231671 |
| --- | --- | --- |
| Vote accepted | 1120.375 | 1425.866 (packet) |
| Game-over burst | 1125.386 (**+5.011 s**) | 1430.878 (**+5.012 s**, can-surrender flag reset) |
| Stream / client game end | 1129.139 (**+8.764 s**) | API `GameEnd` **+8.75 s** |

The game-over burst is the same in every replay (always 3.75 s before the
stream ends): per-player end-of-game packets and the single game-over
broadcast. This is presumably the Nexus explosion. So after an enemy
acceptance there are about five seconds until the server declares the result
and about 8.7 seconds until the client shows it.

## Evidence 3: six more 16.20 captures

All Oct 18–19 captures were still undecoded. They decode cleanly with the
existing analyzer (Windows build 16.20.824.8524). Reports are saved beside
each capture as `analysis/decoded-16-20.json`. Match results come from the
client's match history.

| Game | Mode | Result | Capture | Decoded surrender messages |
| --- | --- | --- | --- | --- |
| 8017089009 | Mayhem | loss | full | Own vote: start 20:07.5, updates 1–1, 2–1, 2–2, **failed 20:17.1 at 2–2** |
| 8017164387 | Mayhem | win | full | Our can-surrender flag at 8:00 only |
| 8017801829 | Mayhem | win | full, heavy gaps | Our request at 9:28.9; no incoming start (17,001 coverage gaps); flag back at 12:26.7, i.e. 180 s after a teammate's start |
| 8018764545 | Mayhem | win | last ~2 min | none |
| 8018780293 | Mayhem | win | full | Our can-surrender flag at 8:00 only |
| 8018843678 | Flex | **our** surrender | first 8 min | none; capture stopped when the game opened a new UDP socket |

None of these games ended in an enemy surrender. Our first-try decode of a
second own vote is another positive control. The three complete wins contain
no enemy vote messages, but we cannot tell from them whether the enemy voted
at all. The replay method above replaces that unknown with a measurement.

## Evidence 4: what the client code expects

The 16.20 vote consumer compares the message team with the local team at
`0x1006df856`. A match opens the vote panel. A mismatch is **not** a no-op:
for a vote start it prints a "vote started" chat announcement
(`OnSurrenderVoteStart`, `OnEarlySurrenderVoteStart`,
`OnUnanimousSurrenderVoteStart` or `OnIGNBSurrenderVoteStart`, chosen by
vote kind), and it drops vote updates. That is what a spectator sees: the
spectator client receives both teams' messages, exactly as the replay shows.
If a playing client received enemy vote starts, they would show up as chat
announcements, which they never do.

The status handler (`0x1006f7230`) builds the for/against/team arguments, then
looks up a hero on the message's team, for team 100 or 200 alike, before
announcing. It handles failed votes (`OnSurrenderFailedVotes`,
`OnUnanimousSurrenderFailedVotes`, `OnSurrenderSpam`) with extra local-team
logic and everything else, including `OnSurrenderAgreed`, without it. That is
consistent with the wiki: failures are team-only, a pass is announced to both
teams. The announcement packet itself appears once per window in the replay,
so its recipient list cannot be read from the count.

## What remains possible

1. **Late surrender (documented, untested by us).** The community wiki states
   that when one team surrenders and the other surrenders right after, the
   second team takes the Defeat, that only the last pass before the Nexus
   explodes counts, and that a team can even surrender after destroying the
   enemy Nexus until the Victory screen. Old forum threads agree, with a few
   reports of inconsistent outcomes. Our measured window is **~5 s** from the
   enemy's acceptance to the game-over burst, 8.7 s to the client's game end.
   Every teammate's client receives the all-chat pass announcement, so each
   app instance could react locally without any relay: 4 of 5 `/ff` within a
   few seconds. Before building that, one manual test: next time the enemy
   surrenders, everyone types `/ff` and votes yes the moment the message
   appears, then check match history. Automated `/ff` typing also raises the
   scripting-policy concern noted in the first report.
2. **An app user on the enemy team.** Their own client receives their team's
   vote start, which the decoder already reads. Relaying it would give a real
   early signal, but only when someone on the other team runs the app.
3. **Early detection from our side**: not possible; drop it.

## Using the replay tool

Replays can be downloaded from match history only while that patch is current.
The client is now **16.21.829.8620**, so the October 16.20 games can no longer
be downloaded. The tool needs no binary and no patch-specific offsets:

```powershell
.venv-research/Scripts/python.exe research/ff_replay_votes.py `
  "$env:USERPROFILE\Documents\League of Legends\Replays\EUW1-<gameId>.rofl"
```

It reports both teams' vote windows, the players whose flag changed at each
message, copy counts, outcome and acceptance-to-end time. Payload fields
(yes/no counts) stay obfuscated, and "accepted" is inferred from the match
result. A game without votes cannot always pin down the flag type.

Side note for `spectator-stats`: relative block parameters are signed bytes.
Reading them unsigned (as `block-parser.js` does) produces non-existent
`0x400001xx` hero IDs where `0x400000xx` is meant.

## Limits and loose ends

- The routing conclusion is an inference from how the spectator stream logs
  messages, calibrated against our live captures and the client code. It is
  not a capture of an opposing client during an enemy vote.
- Replay evidence covers 15.23 and 16.14; live captures cover 16.20. Riot could
  change routing. Re-running the tool on any 16.21 replay with a vote takes
  seconds and would show it.
- The live decoder is pinned to 16.20. New captures need a 16.21 port, which
  is only worth doing for the late-surrender test or the relay idea.
- [`ffPacketCapture.ps1`](../src/core/ffPacketCapture.ps1) stops the capture
  when the game opens a UDP socket it is not filtering (the Oct 19 flex game,
  8 minutes in). It should add the new port and keep going instead.
- The wiki's late-surrender statements are undated; the forum reports are
  from 2012–2024. Nothing official from Riot describes the rule.

Sources: [League wiki: Surrendering](https://wiki.leagueoflegends.com/en-us/Surrendering),
[LeaguePackets definitions](https://github.com/moonshadow565/LeaguePackets),
[NA forum thread on simultaneous surrenders](http://forums.na.leagueoflegends.com/board/showthread.php?t=1011750),
[fandom thread: surrendering last loses](https://leagueoflegends.fandom.com/f/p/1886592058785794507).
