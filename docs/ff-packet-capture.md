# Real packet capture and surrender-time alignment

Implemented on `ff-detecting`, 2026-10-17, recorder version 3.

## Current evidence

The previous access-denied problem is resolved through a separate elevated
PowerShell helper. The normal app remains unelevated. A real Windows test through
the same Node controller, helper, conversion, parser and export path produced
10 UDP packet records from five controlled sends. The expected test payload was
found inside the PCAPNG. All 10 records had full captured lengths; no truncation
or unsupported packet types occurred. This verifies capture infrastructure,
**not a real League surrender packet or enemy visibility**.

The game was not running during validation. Automatic attachment to a live
League process and in-game vote correlation still need a game test.

The existing 2026-10-17 game logs have no surrender/vote/chat-message text beyond
chat subsystem initialization. The running LCU advertises read-only conversation
and message functions, but returned an empty conversation list during inspection.
No automatic surrender timestamp has been observed from chat yet.

## Recording a game

1. Restart the branch app (`npm start`) and open FF Research / Capture setup.
2. **Include real game packets** is enabled by default and visible above Start.
   Keep it enabled, along with the system-chat and log probes.
3. Start before loading the match; accept the Windows administrator prompt.
   The always-visible packet status moves from waiting to capturing when League
   opens UDP sockets. Disabling the switch displays **REAL PACKETS OFF**.
4. Enable marker hotkeys: Ctrl+Shift+F5 own vote started, F6 failed, F7 accepted.
   If chat displays an exact time, the observation form accepts `minutes:seconds`
   (optionally decimals) separately from the time you click the marker.
5. Record several failed own-team votes first, plus normal gameplay with no votes.
   Stop after the match and wait for a packet count / completed conversion.
6. Export. Share the JSONL **and the matching `.packets` folder** together.

Use a new recording for each game. Game process exit also stops packet capture.
If the game opens a new UDP socket mid-match (seen about eight minutes into a
Flex game), the helper stops PktMon, adds the new port and restarts into a new
ETL segment. About a second of traffic is lost at the switch; `status.json`
records each change under `socketChanges`.

## Files and coverage

- JSONL: API/log observations, manual markers, experimental system-chat matches,
  game-clock anchors and capture-source health. A separate 256 MB hard limit applies;
  reaching it stops recording, including the packet helper.
- `packets.etl`: original Windows events, including diagnostic/counter metadata.
  `packets-2.etl`, `packets-3.etl`, … hold later segments after socket changes.
- `packets.pcapng`: full packet bytes, readable by Wireshark or the included parser.
  With several segments it is their PCAPNG sections joined in order.
- `packet-index.jsonl`: one row per captured packet with UTC time, file offset,
  interface ID, original/captured length, frame hash; recognized UDP also includes
  endpoints, direction relative to the game ports, payload length/hash and truncation.
- `status.json`, `capture-result.json`, `validation.json`: helper lifecycle,
  actual filters/ports, conversion diagnostics, packet counts and validation.

Raw packet files are **not redacted**: addresses and payload bytes are retained.
Nothing is uploaded automatically. PCAPNG is a packet container, not a decryption
or League protocol decoder. Unknown link types, IPv6 extension headers and IP
fragments remain in the original file but are unclassified in the UDP index.
The NIC capture can contain repeated observations of a packet. Never interpret
raw record counts as unique network-message counts.

Capture is restricted to UDP ports owned by `League of Legends.exe` (either
direction), not all system traffic. Port reuse/collisions are possible; this is
not a kernel per-process filter. It does not capture LCU HTTPS chat on TCP.
There is a 2 GB circular ETL limit and two-hour helper limit. Converted PCAPNG,
packet indexes and exported copies require additional disk space. A full ring can
overwrite early packets; verify retained first/last packet times before analysis.
Stop diagnostics include Windows event-loss information when available.

The helper refuses existing PktMon sessions or filters, rather than overwriting
them. English PktMon status text is currently required; unrecognized localized
output fails closed. An app heartbeat stops the helper within roughly 30 seconds
after a crash; normal stop/quit requests stop immediately. No persistent service,
driver installation, game injection or memory access is used.

## Chat and timing

LCU chat and the in-game HUD are separate surfaces. The probe reads game/lobby
conversation histories every two seconds and watches message events. It retains
only English surrender matches in `system`/`notification` messages, removing the
player-name portion and retaining normalized stage and parseable source timestamp.
Ordinary player chat/DM text is not stored. This deliberately misses unsupported
languages, message types and wording. Initial room histories are marked historical.
The match stage remains separate: vote started, failed, accepted, game ended.

These records are `alignment-candidate`, never an early enemy detection. Client
message timestamps are preserved but their relationship to the in-game clock is
unverified. The packet index uses Windows UTC timestamps. Each Live Client sample
now records request-start UTC, response-receipt UTC, request duration and game
time. The last sampled game clock in an ordinary row can be stale; use the anchors.
Manual markers include human reaction delay. A manually transcribed game/chat
time can reduce that delay, but remains human-supplied evidence.

## Offline analysis

```powershell
node scripts/analyze-ff-packets.mjs "C:\captures\trial.jsonl"
```

This reads the companion `trial.packets/packet-index.jsonl` and creates
`trial.packet-analysis.json` without overwriting an existing report. Optional
second/third arguments select an index and output path.

The report contains one-second game-time bins, packet examples/offsets within
three seconds of each marker/chat clue, and possible duplicate counts. Mapping
uses a nearby game-clock anchor (within five seconds), assumes the game clock
advances normally, and is approximate. Pauses, system clock changes and request
latency need review. Supplied chat timestamps are displayed separately rather
than automatically trusted. Duplicate estimates (identical frame within 2 ms)
are heuristic; raw packets are never removed.

First establish repeated own-team vote-specific packets or message structures
against matched normal-play controls. Size/rate bursts alone are not evidence.
Then compare controlled opposing-team votes, with their own independently marked
capture as ground truth, to determine whether any early signal reaches our PC.
No enemy decoder or automatic `/ff` action is implemented.

An additional [offline decoder](ff-live-decoding-2026-10-18.md) now identifies
own-team surrender messages in the tested 16.20 capture. It needs the exact
supported macOS binary and the matching original game log on the tester's machine.
It exports a non-secret analysis report; it does not change the app's live recorder
or export session keys. See that report for coverage gaps and enemy-test limits.

## References

- [Microsoft Packet Monitor documentation](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon)
- [Riot Live Client Data API](https://developer.riotgames.com/docs/lol#live-client-data-api)

Exact command availability was also verified using this machine's `pktmon` help.

## Validation

- Full suite: 358 tests, 351 passed, 7 existing skips, no failures.
- Focused recorder/packet suite: 29 passed, covering parser bounds, distinct chat
  stages, history, direct-message exclusion, export gating, helper lifecycle and
  approximate clock alignment.
- Isolated Electron test: start, stop, export, manual `15:02` timestamp retained
  as 902 seconds, and minimum-width layout passed.
- Live elevated smoke: capture, conversion, all 10 UDP records parsed, expected
  test payload present, companion export verified. Synthetic alignment mapped
  all 10 real packet records and flagged five possible duplicate observations.
- Stop-before-game test: helper reached ready/waiting, accepted stop, exited
  cleanly. Preflight also verified previous smoke cleanup left PktMon stopped
  with no filters.
