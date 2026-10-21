# Second Mayhem capture: known own-team surrender

Analyzed 2026-10-16. Source:
`%APPDATA%/LeagueClientAutomation/ff-research/ff-2026-10-16T14-17-07-029Z-cc5d00.jsonl`.
Actual match ID `8015141398`, queue `2400`, mode `KIWI`, local team `CHAOS`/200.
The player reports that their own team surrendered.

## Finding

**There is a confirmed post-game surrender indicator, but no observed early
vote indicator.** The end-of-game statistics field `gameEndedInSurrender` was
`1` for every player in this match, versus `0` in the previous normal-ending
control. Its first observed arrival was **4,993 ms after live `GameEnd`**.

This confirms that the captured client data can distinguish these two completed
games retrospectively. It does not expose vote initiation, voting progress, or
an enemy vote before its acceptance. Even the known own-team vote generated no
recorded live FF-specific event or snapshot field.

## Coverage and timing

- Capture 16:17:07–16:40:43 Europe/Berlin, clean user stop, no file-write errors.
- 2,123 valid JSONL records, 2,942,974 bytes; no malformed lines.
- 5,249 successful event polls; 168 live events; 690 game-data samples.
- Game clock coverage approximately 0.025–1,383.426 seconds; maximum sample gap
  2,048 ms. The event stream connected at capture +6,034 ms and snapshots at
  +6,036 ms, when game time was still approximately zero.
- No recorded live API/snapshot/client event-stream failure during active play
  after connection and before `GameEnd`. Initial unavailable/404 responses were
  during game startup. The LCU schema remained unavailable (HTTP 404).
- Reconstructed the baseline and 687 deltas (5,791 operations) with no errors;
  two samples needed no change record. No surrender/vote/forfeit/concede/result/
  winner/game-end key names occurred in snapshot data or delta paths. No new
  non-gameplay snapshot path appeared relative to the first control, using a
  filter that excludes item, score, ability, champion-stat and rune paths.
- There were no manual vote-start/progress/acceptance markers. Consequently the
  exact vote-opening time and server acceptance time are not independently known.

The capture initially contains the previous game's stale LCU session ID
`8015128921`. At +337 ms, records 16–17 correctly establish match index 2 and the
new ID `8015141398`. Analyze the new match rather than the first metadata row.

| Record | Arrival relative to live `GameEnd` | Observation |
| --- | --- | --- |
| 2017 | 0 ms | `GameEnd`, `Result: Lose`, source game time 1,383.174 s (23:03.2) |
| 2020 | +207 ms | Game log: received game-end packet |
| 2022 | +1,751 ms | Game log: `Game ended normally` |
| phase event | +1,889 ms | LCU phase `WaitingForStats` |
| 2035 | +4,993 ms | First end-of-game statistics payload with surrender flags |
| phase event | +5,007 ms | LCU phase `PreEndOfGame` |
| phase event | +11,767 ms | LCU phase `EndOfGame` |

Relative times use the recorder's monotonic elapsed clock. They describe local
arrival, not server execution or visual announcement timing.

## What the surrender flag means in this capture

The first statistics payload has:

- `localPlayer.stats.gameEndedInSurrender = 1`.
- Every player on **both teams** has `stats.gameEndedInSurrender = 1`.
- Both team summaries have `stats.gameEndedInSurrender = 5`.
- The losing local team is 200; the winning opposing team is 100.

The team value `5` corresponds to the five player flags being aggregated. It is
not evidence of five yes votes, five vote participants, or both teams surrendering.
This is a match-ending flag, not an explicit team-voted-to-surrender flag.

The separate `gameEndedInEarlySurrender`, `teamEarlySurrendered`,
`causedEarlySurrender`, and `earlySurrenderAccomplice` fields remain false.
IGNB-named surrender statistics remain zero. Do not treat these fields as generic
ordinary-FF indicators or guess what IGNB means from this dataset.

The live `GameEnd` payload itself contains only `EventID`, `EventName`,
`EventTime`, and `Result`. It has no surrender reason, team or vote tally.

## Other recorded clues and controls

There are 74 broad keyword-candidate records:

- 56 post-game surrender-statistic fields; their first values are baselines.
- 10 champion-select `currentChampionVotePercentInteger` values of `-1` during
  startup, unrelated to in-game surrender.
- Three generic ending/exit log lines.
- Three copies of `ObjectiveVoteScale` through game-settings routes.
- One honor `votePool` and one honor `voterRelationship` field.

No candidate showed a vote-start or vote-progress stage. The final minute's
saved LCU route inventory contained only patcher-lock updates and cached ranked
stats before `GameEnd`; its last partial bucket was flushed later, so that
window alone is not an exhaustive per-message timestamped inventory. The full
capture had no FF-named route.

The complete current game's `r3dlog.txt` also contains no matching surrender,
forfeit, concede, FF or vote line. The message **`Game ended normally` occurs
even in this known surrendered match**. It describes normal game-process exit;
it cannot distinguish Nexus destruction from surrender. This revises the
interpretation of the identical line in the first control.

## Comparison with the first control

| Observation | Normal-ending control | Known own-team FF |
| --- | --- | --- |
| Live `GameEnd` result | Win | Lose |
| Player `gameEndedInSurrender` | 0 | 1 on both teams |
| Team aggregate of that field | 0 | 5 on both teams |
| First post-game stats after `GameEnd` | +5,559 ms | +4,993 ms |
| Live FF-start/progress observation | None | None |
| Log text `Game ended normally` | Present | Present |

The result demonstrates a useful completed-match classifier. It supplies no
evidence that an early enemy signal is available through the tested readers.
The own-team negative result makes a simple exposed vote feed less promising,
but is not proof of impossibility: polling, reader selection, absent markers
and undocumented/other interfaces still limit the experiment.

No app implementation changes were made for this analysis.
