# Two failed own-team votes: 12:06 and 24:06

Analyzed 2026-10-17 on `ff-detecting`.

## Capture and limitations

- File: `ff-2026-10-17T13-37-44-798Z-9769d5.jsonl`, 5,738,528 bytes,
  3,754 records, recorder/format version 3.
- Match 8016177325, ARAM: Mayhem, KIWI, queue 2400, map 12.
- User-reported own-team votes: started 12:06, failed 12:12;
  started 24:06, failed 24:09. These times came from the conversation;
  the capture contains no manual marker records. The original is unchanged.
- Capture options: 250 ms event interval, logs on, chat on, **packets off**.
  No packet-status rows or companion packet directories exist in the recording
  folder. The short preceding capture (`13-37-24-251Z-8e20b6`) also has packets off.
- Therefore this game provides **no real packet evidence**. This is a disabled
  capture option, not an observed PktMon access failure or packet-parser failure.
  Packet bytes cannot be reconstructed afterward from aggregate network counters.

## Vote windows

| Reported event | Game seconds | Approximate UTC from nearby clock anchor |
| --- | ---: | --- |
| First start | 726 | 13:50:37.111 |
| First failure | 732 | 13:50:43.112 |
| Second start | 1446 | 14:02:37.132 |
| Second failure | 1449 | 14:02:40.131 |

These are mappings of user-reported second-resolution times, not precise server
event timestamps. Nearby API request windows were approximately 4.3–5.7 ms;
this does not remove uncertainty in the reported event times.

Within each vote interval plus four seconds on either side:

- First window: seven game snapshots, maximum sample gap 2.024 seconds.
  Ordinary turret/inhibitor events at 723.491 and 728.675 seconds. Snapshot
  changes cover gold, health/resources, respawns/deaths, levels, CS and items.
- Second window: six game snapshots, maximum gap 2.022 seconds. No Live Client
  event rows in the inspected window. Snapshot changes cover gold, health,
  resources, scores, death/respawn and champion identity fields.
- Live-event polling and client event connection report connected throughout
  both windows; no source-status transitions appear in either inspected interval.
- Neither window contains a surrender candidate, system-chat alignment candidate
  or manual marker. Across the whole capture, the 64 keyword candidates comprise
  three game-end clues and 61 unclassified settings/postgame/honor fields;
  none is classified as vote start, progress or failure.

## Chat and additional discovery

The LCU conversation list is empty around both votes: `roomTypes: []`, zero
game rooms inspected. Only a `postGame` room type appears elsewhere in this
capture. The chat reader therefore had no in-game room/history to inspect;
the absence of surrender matches is not evidence that chat text lacks them.
This run does not establish a usable automatic in-game chat timestamp source.

Runtime game Help succeeded: one event (`OnCallback`), 27 functions and 24 types.
No surrender- or chat-specific function/event is advertised. Additional LCU bus
subscriptions remained in the requested/listening state, without observed messages.
Discovery names alone are not evidence of vote visibility.

## Network counters and game logs

346 aggregate network-sample rows were saved. Selected netstats rows near the
reported votes (source clock, interval alignment remains unverified):

| Sample game time | Received bytes | Sent bytes |
| ---: | ---: | ---: |
| 720.828 | 73,580 | 18,615 |
| 730.829 | 73,859 | 19,853 |
| 740.832 | 128,185 | 22,288 |
| 1440.953 | 92,162 | 18,172 |
| 1450.953 | 79,460 | 18,711 |
| 1460.957 | 99,346 | 20,401 |

Each row covers roughly ten seconds. They contain no message bytes and cannot
identify a surrender vote or its failure. No surrender/forfeit/concede/vote text
appears in the game's r3dlog, netlog or netstats files under
`Logs/GameLogs/2026-10-17T15-37-30`.

The Live Client reports GameEnd/Lose at 1674.740 seconds (27:54.740). Postgame
`gameEndedInSurrender` is zero for the local player and both team aggregates.
Those later outcome fields do not describe the earlier failed votes.

## Next recording

Enable **Capture real game packets** in FF Research / Capture setup, accept the
administrator prompt, and verify the Windows packet source says **capturing**
after loading in. Record own-team start/failure markers or report game times.
Export the JSONL with its companion `.packets` folder after conversion. A new
recording with packets enabled is necessary before packet-level comparison.
