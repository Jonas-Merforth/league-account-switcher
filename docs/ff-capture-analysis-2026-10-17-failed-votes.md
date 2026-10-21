# Failed surrender votes: 2026-10-17

Capture: `ff-2026-10-17T09-57-59-261Z-a97e75.jsonl`.
Game: `8015989226`, ARAM: Mayhem / KIWI, queue 2400.
User-reported own-team failed vote windows: **8:59–9:20** and **14:01–14:05**.
A further vote near the end has no supplied timestamp or independently established outcome.

## Result

No identifiable vote-start, progress, or failure signal was found in either
window. This is a negative result for the recorded interfaces, not a claim that
the game never transmitted or held the vote state.

The capture contains 2,009 rows, 670 game samples, 641 snapshot deltas, 106 client
route inventories and 67 keyword candidates. None of the candidates is classified
as vote-start, vote-progress or vote-failed. The keyword candidates occur at/after
the ending and include postgame statistics, objective-vote settings and honor.

Around the first window (including three seconds either side), there are 13
snapshot samples with a maximum source-game-time gap of 2.0212 seconds. Around the
second, five samples with a maximum gap of 2.0189 seconds. Recorded health reports
show the event, snapshot and LCU push sources connected in both windows.

The first window has ordinary champion kills and first-turret events, plus normal
gold/stats/items/respawn changes. The second contains normal gold/health/resource,
items and respawn changes. Client inventories show patcher-lock and cached ranked
statistics, not a new vote resource. There is no recorded API outage explaining
the absence in those intervals.

The live GameEnd event reports Lose at **21:24.832**; our team was CHAOS.
The first postgame stats arrived 5.586 seconds after that event and report
`gameEndedInSurrender = 0` in both team aggregates. Thus the untimed final vote
has no recorded acceptance confirmation, and the recorded result does not
identify the ending as a surrender. Its opening/failure time cannot be recovered
from this capture.

## Network inspection

Inspected the full `netstats.csv`, `netlog.txt` and `r3dlog.txt` in
`C:/Riot Games/League of Legends/Logs/GameLogs/2026-10-17T11-57-56/`.
The text logs contain no surrender/forfeit/concede/vote/standalone-ff keyword.

These files are **counter logs, not a packet trace**. They contain approximately
10-second observations; no saved per-packet content, opcode, or exact vote packet
timestamp is available. The CSV carries its own game-time field and duration;
the text network log's clock includes startup/loading. Their clock values must
not be treated interchangeably. The CSV's final row has a whole-session-sized
duration and must not be included as an ordinary 10-second interval.

Selected CSV observations, quoting the recorded sample clock rather than asserting
whether that clock marks the start or end of its aggregate interval:

| Sample clock (seconds) | Received bytes | Sent bytes | Received packets | Lost packets |
| --- | ---: | ---: | ---: | ---: |
| 529.944 | 140,846 | 22,809 | 707 | 0 |
| 539.947 | 130,778 | 20,455 | 652 | 0 |
| 549.948 | 85,019 | 18,637 | 598 | 0 |
| 559.950 | 118,841 | 21,082 | 663 | 0 |
| 569.954 | 97,020 | 21,671 | 662 | 0 |
| 830.012 | 95,323 | 18,231 | 571 | 0 |
| 840.011 | 72,180 | 19,890 | 623 | 1 |
| 850.010 | 54,940 | 19,468 | 629 | 0 |

For ordinary samples after game time 60 seconds with duration between 9 and 11
seconds, received bytes range from 38,967 to 187,441 (median 106,387). The displayed
observations fall inside that range. Traffic decreases near both reported votes,
but the magnitudes differ, normal gameplay affects these totals, and the low
traffic around the second vote is not unique. This does not establish a reusable
surrender signature. A four-second vote is shorter than one counter interval.

The matching launcher trace was also inspected. Surrender-related names are
queue configuration and postgame statistics; vote-related names additionally
belong to startup voting data and honor. No explicit open-surrender message was
found. Opaque or encoded fields cannot be ruled out by this inspection.

## Added probes on this branch

- Runtime Help discovery: the current LCU responds to `GET /help` although its
  Swagger URLs return 404. Live inspection enumerated **889 event names, 1,447
  functions and 3,564 types**; none of their names contains surrender, forfeit or
  concede. These are interface names, not proof of what every payload can contain.
- Additional advertised WAMP buses: `OnLcdsEvent`, `OnServiceProxyAsyncEvent`,
  `OnServiceProxyMethodEvent`, and `OnServiceProxyUuidEvent`. The new recorder
  requests subscriptions only when advertised, records their arrival counts and
  field shapes, and scans structured fields. Subscription request and actual
  message receipt are shown separately. Live smoke testing verified discovery
  and subscription requests; it did not observe an in-game vote on those buses.
- Bounded parsing of JSON embedded inside message strings and inspection of
  structured event/type names. Previously a field such as `payload` containing
  JSON text could hide a relevant key from the matcher. Ordinary prose/chat does
  not become vote evidence, and chat/auth routes remain excluded.
- Game runtime `POST /Help` discovery, as declared in the saved game schema.
  It lists interfaces only; discovered functions are never invoked. The game
  process/API was no longer running during verification, so this probe needs
  validation in the next game. No game-side event transport is claimed working.
- Appended `netstats.csv` and `netlog.txt` counters now join the normal JSONL
  export. They retain source timing, read timing, file association and unread-byte
  information; IP addresses and player IDs are omitted. They are explicitly
  unclassified network observations, never early-vote candidates.

## Packet capture and RAM limits

No raw packet capture was running during this game, so the exact packets cannot
be recovered from these logs. The installed Windows PktMon can support a future
filtered capture, but both `pktmon status` and `pktmon filter list` returned
**Access is denied** in this session. No driver installation, elevation, filter
changes or broad network capture was attempted. Wireshark/tshark was not found
in PATH or the usual installation location.

For a separate packet experiment, use an elevated capture restricted to the
actual game server IP/UDP port, preserve existing capture sessions/filters, and
collect timing/direction/length alongside manually labelled failed votes. The
peer values in the local game's counter file can identify the target; do not
assume a historical server port stays valid. Collect control intervals and votes
from both sides before proposing a signature. Traffic size correlation alone is
not a semantic decoder and cannot establish enemy-vote visibility.
[Microsoft PktMon documentation](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon-syntax)

A bounded static ASCII/UTF-16 string search of the installed 46,635,448-byte game
executable found no readable surrender/forfeit/concede symbol. This does not mean
the state is absent from RAM. It leaves us without a verified address, structure,
or decoder. Windows memory reads require a readable process handle and a known
address range; a process-wide dump/search would not by itself identify an active
vote or its team. No live game process was available for a targeted check. No RAM
scanner, injection, protection bypass, or invented offset was added.
[Microsoft ReadProcessMemory documentation](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory)

The next game should run recorder version 2 before loading. Repeat known failed
votes and keep their game-clock windows. Screen recognition and Overwolf are
excluded per the user's direction. Enemy visibility remains unverified even if
one of these sources exposes our own vote.

Validation: 352 tests, 345 passed and 7 existing skips; focused FF suite 23 passed.
Real LCU Help enumeration/subscription request smoke test passed; active-game
Help and actual vote delivery remain untested. Electron's isolated FF tab
start/stop/export and minimum-width layout checks passed.
