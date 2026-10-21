# First real game packet capture: two failed votes and a surrender

Analyzed 2026-10-17 on `ff-detecting`.

**Follow-up, 2026-10-18:** [live packet decryption and own-team vote decoding now
work](ff-live-decoding-2026-10-18.md). The findings below preserve the initial
raw-byte analysis. Its “no verified decoder” statements are superseded by that
follow-up; early enemy-vote visibility is still unproven.

## Result

Real packet capture succeeded and covers all reported vote windows. Initial
packet-size, traffic-rate and raw-byte comparisons have **not isolated a reliable
surrender-vote signature**. This is not evidence that the packets contain no
vote information: no current League message framing/decryption/semantic decoder
has been verified. Early enemy-vote visibility remains untested.

## Input and ground truth

Capture: `ff-2026-10-17T14-16-30-474Z-dfcd91`, game 8016231671,
ARAM: Mayhem / queue 2400. API/debug log: 5,106,200 bytes, 3,227 records.

The user supplied these times after the game:

| Vote | Start | Outcome |
| --- | --- | --- |
| 1 | 8:33 (513 s) | Failed 8:36 (516 s) |
| 2 | Observed 18:15 (1095 s); chat displayed 18:21 (1101 s) | Failed 18:27 (1107 s) |
| 3 | 23:42 (1422 s), matching chat | Surrender accepted at approximately 23:49 (1429 s) |

The third outcome is interpreted from the user's wording and supported by later
postgame surrender flags. Exact acceptance time remains user-reported. There
are no actual vote hotkey markers in the file; its sole marker records that
hotkeys were enabled. Both second-vote start times are retained as alternatives.
Original capture files were not edited or augmented with invented live events.

## Capture health

- Packet capture option: true. Helper captured from 14:16:47.605 UTC, stopping
  after the game process exited at approximately 14:41:22 UTC.
- PCAPNG: **54,803,120 bytes**, **342,133 packet records**; 342,130 recognized UDP,
  three unsupported by the narrow index parser, zero truncated packet records.
- Original ETL: 25,294,726 bytes. Helper limit: 2 GB; no size-limit issue.
- Windows stop output reports **No events lost**. Conversion reports zero packet
  drops. These diagnostics do not prove that the network itself had zero loss.
- UDP filter used the game's local port 63292. All parsed UDP traffic was between
  that socket and one remote peer. Peer addresses are omitted from this report.
- 171,718 records were flagged as possible duplicates using identical full-frame
  bytes within 2 ms, leaving 170,412 UDP observations for exploratory comparisons.
  This is a heuristic, not verified NIC provenance or a retransmission decoder;
  original packets, including every duplicate, are preserved.

Widened windows after heuristic duplicate removal:

| Game-time window | UDP observations | Incoming | Outgoing | Largest inter-packet gap |
| --- | ---: | ---: | ---: | ---: |
| 8:31–8:39 | 920 | 439 | 481 | 45.6 ms |
| 18:13–18:30 | 1,994 | 966 | 1,028 | 67.6 ms |
| 23:40–23:52 | 1,417 | 689 | 728 | 65.6 ms |

These show populated traffic coverage, not proof of delivery of any specific
vote message. Game-time alignment uses the nearest Live Client request midpoint.
Nearby snapshot gaps were at most 2.018, 2.036 and 2.023 seconds respectively.
Polling request latency and the user's second-resolution observations limit
timing precision. Packet clocks alone do not resolve the 18:15/18:21 discrepancy.

## API, chat and final outcome

API event polling and LCU event connections report connected across all three
windows. No vote-start, vote-failed or system-chat alignment candidate appears
there. LCU conversation inventories are empty in each window, so this chat API
still does not provide the in-game surrender messages needed for automatic timing.

Ordinary gameplay overlaps the votes: champion kills at 510.122 and 515.298 s;
at 1093.332, 1095.798 and 1102.930 s; and a kill plus Ace at 1424.246 s. Traffic
changes in these windows cannot simply be attributed to surrender voting.

Live Client GameEnd/Lose is at **1434.523 s (23:54.523)**, received at
14:41:10.735 UTC. This is approximately **5.523 seconds after** the reported
23:49 acceptance. Postgame `gameEndedInSurrender` appears at 14:41:15.706 UTC,
roughly 4.97 seconds after the API end event. The local flag is 1 and each team
aggregate is 5: these are postgame aggregate flags, not five votes or proof that
both teams surrendered. They confirm a surrender ending, not an early vote signal.

## Packet-level comparisons performed

1. Parsed raw Ethernet/IPv4/UDP bytes and aligned packet timestamps with game
   clock anchors; inspected both directions separately.
2. Searched payload bytes for `surrender`, `forfeit`, `concede`, `vote failed`,
   and `vote passed` as case-insensitive ASCII-compatible and UTF-16LE text.
   No matches. This does not establish the payload encoding or encryption scheme.
3. Compared UDP payload-length families across all three widened vote windows.
   Every shared family also occurred outside them. For example, incoming
   474-byte payloads appear once per window but 20 more times elsewhere.
4. Compared repeated 4/8/12-byte chunks at four-byte-spaced offsets in the first
   64 payload bytes, grouped by direction and payload length. Shared features
   were not exclusive to voting windows.
5. Compared eight-byte substrings at **every offset across entire payloads**,
   grouped by direction without requiring equal payload lengths. Across the
   widened windows, 431 substrings were shared; all also occurred elsewhere.
6. Repeated substring comparison with narrower, stage-specific windows:

| Comparison | Shared eight-byte patterns | Exclusive to inspected windows |
| --- | ---: | ---: |
| All three starts, using 18:15 for vote 2 (±2 s) | 74 | 0 |
| All three starts, using 18:21 for vote 2 (±2 s) | 37 | 0 |
| Both failures (±2 s) | 152 | 0 |

These are deliberately simple discovery tests. A real vote field can be shorter,
variable, compressed, encrypted, fragmented or bundled with unrelated messages;
it need not repeat as eight literal bytes. Common substrings may be transport
headers rather than application fields. No packet ID or payload layout is claimed.

One-second traffic volumes at 8:33, 18:21 and 23:42 were around the 66th, 66th
and 59th percentiles of background gameplay payload volume. At 18:15 the volume
was around the 94th percentile, but a kill also occurred in that second and
similar/higher volumes occurred elsewhere. There is no consistent isolated burst
across the three starts. At 23:54 traffic drops sharply (API game end), which is
a later ending clue, not an early surrender-vote signal.

## Saved analysis artifacts

Under the original `.packets/analysis/` directory:

- `findings.json`: detailed counts, time bins, alternative second-vote start
  comparisons and raw-byte feature statistics.
- `vote-1.pcapng`: 8:28–8:41, 3,021 original packet records.
- `vote-2.pcapng`: 18:10–18:32, 5,412 original packet records; includes both starts.
- `vote-3.pcapng`: 23:37–24:01, 4,061 original packet records; includes game end.
- Corresponding `vote-N-index.jsonl` files. All three standalone clips were
  reparsed successfully with no truncated or unsupported records.

Local reproducibility script: `.local-research/analyze-ff-8016231671.mjs`.
It reads this capture without changing original evidence, writes derived clips
and findings, and treats all signatures as unverified exploration. Raw payload
clips remain local, outside tracked repository documentation.

## What this establishes and what remains

The capture infrastructure is now verified on a real match, including known
failed and successful own-team votes. There is no justified automatic detector
to add from these size/byte comparisons. The next technical step is identifying
the current game's transport framing and application message representation in
these clips, then validating any proposed vote-specific decoding against all
three windows and normal-play controls. A controlled opposing-team test becomes
informative once own-team vote packets can be identified. This capture does not
answer whether early enemy voting is transmitted to the local client.
