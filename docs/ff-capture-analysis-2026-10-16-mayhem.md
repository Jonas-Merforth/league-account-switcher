# First ARAM: Mayhem capture analysis

Analyzed 2026-10-16. Source capture:
`%APPDATA%/LeagueClientAutomation/ff-research/ff-2026-10-16T13-53-48-025Z-ed3e05.jsonl`.
Game ID: `8015128921`; queue `2400`; mode `KIWI`; map `12`.
The player reports a normal game ending and does not know of an enemy surrender
attempt. This is a normal-ending control, not a known vote test.

## Result

**No early enemy surrender signal was observed.** There were no vote-start,
vote-progress, or accepted-surrender observations. Post-game surrender statistics
were all false or zero, consistent with the reported normal ending. This cannot
establish whether an opposing player opened a private vote that failed or expired.

## Recording coverage

- Capture: 15:53:48–16:14:36 Europe/Berlin (13:53:48–14:14:36 UTC).
- 1,860 valid JSONL records, 2,757,346 bytes, clean user stop; no malformed lines
  or capture-limit/write errors.
- 4,641 successful event polls, 189 live events, and 611 game-data samples.
- Game-data coverage: approximately game time 0.019–1,226.766 seconds. The largest
  interval between samples was 2,044 ms.
- Source-health snapshots sampled event request durations of 1–13 ms, median 4 ms.
  These are sampled durations, not a distribution of every request.
- No recorded game API/snapshot/client event-stream failure before `GameEnd`.
  Game API closure and a brief client WebSocket reconnect occurred after ending.
- The LCU schema route returned HTTP 404 throughout. Its event subscription and
  game-phase/session reads still worked. The game API schema was captured.
- Reconstructed the baseline and all 609 deltas (5,958 operations) successfully;
  one of the 611 samples needed no snapshot change record. There were no
  surrender/vote/forfeit/concede/result/winner/game-end key names in the baseline
  or delta paths. Game events are recorded separately from these snapshots.

Live event names: `GameStart`, `ChampionKill`, `FirstBlood`, `MinionsSpawning`,
`Multikill`, `Ace`, `FirstBrick`, `TurretKilled`, `InhibKilled`, `GameEnd`.
There was no FF/vote-named live event. The captured game schema exposed 26 paths
and no surrender/vote-named route or schema field.

## Ending timeline

Times below are monotonic recorder arrival differences relative to live
`GameEnd`, not server processing times or visual announcement times.

| Record | Relative arrival | Observation |
| --- | --- | --- |
| 1763 | 0 ms | Live `GameEnd`, source game time 1,222.730 s (20:22.7), `Result: Win` |
| 1764 | +140 ms | Game log: received game-end packet, entering end-game state |
| 1771 | +4,994 ms | LCU phase `WaitingForStats` |
| 1773 | +5,251 ms | Game log: `Game ended normally` |
| 1776 | +5,559 ms | First LCU end-of-game statistics block |
| 1834 | +5,573 ms | LCU phase `PreEndOfGame` |
| 1855 | +14,443 ms | LCU phase `EndOfGame` |

The API game clock continued to advance briefly after `GameEnd`; its last
sampled value is not the match's ending timestamp. All three log clues concerned
the completed/ending game. None exposed an earlier vote.

## Why the capture contains 63 candidate rows

The keyword collector intentionally keeps broad matches. These rows were not
63 votes or 63 early detections:

| Count | Source | Meaning |
| --- | --- | --- |
| 3 | Game log | Ordinary game ending/exit/completion messages |
| 56 | End-of-game statistics | Surrender-named fields from local-player, player, and team summaries; all false/zero |
| 1 | Honor ballot | `votePool`, referring to post-game honors |
| 3 | Game-settings events | `ObjectiveVoteScale`, the same UI setting through three client routes |

The post-game fields included `gameEndedInSurrender`,
`gameEndedInEarlySurrender`, `teamEarlySurrendered`, `causedEarlySurrender`,
`earlySurrenderAccomplice`, `gameEndedInIGNBSurrender`,
`causedGameEndFromIGNBSurrender`, and `teamIGNBSurrendered`. All observed values
were false or zero. Repeated player/team summaries account for much of the count.
These names are evidence of post-game reporting capabilities, not evidence of
live vote visibility. Their first arrival was already 5.559 seconds after
`GameEnd`; their behavior during an actual surrender is still untested.

The capture's annotations correctly kept these initial false/zero fields as
baseline/unclassified rather than early detections. There were no manual markers.

## Refinements exposed by this control

No implementation changes were made during this analysis.

- Keep post-game surrender statistics and generic honor/objective votes visible
  as discovery evidence, but distinguish them from live FF candidates in the UI.
- Correct the team-word heuristic: `normally` contains `ally`, so record 1773
  was incorrectly annotated as our team. Its `game-end` stage prevented it from
  counting as early evidence, but team labels need token-aware matching.
- Add a schema-discovery fallback for the LCU HTTP 404; this did not disable its
  WebSocket capture, but leaves a schema coverage gap.
- Expand player-name redaction to the live `Ace` event's `Acer` field, which is
  currently outside the known identity-field list. No names are reproduced here.
- Add explicit patch/build metadata for future runs; this capture's user-reported
  patch was blank, and the game API schema's `1.0.0` is an API version.

The next informative test is a **known enemy vote that fails**, followed by a
known passed vote, with the opposite team's perspective marking start/progress
and acceptance. This control shows that the recorder works in Mayhem and
identifies normal-ending noise. It does not show that a private enemy vote is
observable.

## Follow-up: known surrendered match

The [second capture](ff-capture-analysis-2026-10-16-own-surrender.md) reports a
known own-team FF. Its player `gameEndedInSurrender` flags are `1`, versus `0`
here, but first arrive 4.993 seconds after `GameEnd`. It also logs `Game ended
normally`: that line indicates normal process exit and cannot establish that a
match ended through Nexus destruction rather than surrender.
