# Live game packet decoding: own-team surrender evidence

Research completed on `ff-detecting`, 2026-10-18, using the game captured on
2026-10-17. This follows [the initial raw-packet analysis](ff-capture-analysis-2026-10-17-real-packets.md).

## Result

**The spectator-style approach worked for recovering the live transport and
own-team surrender messages.** The existing capture can be decrypted and
decompressed. The matching official macOS client can deserialize the vote
messages, including their team and yes/no counts, without starting League or
reading a live process. This establishes information available before game end,
and vote starts before the vote decision.

**Early enemy voting remains unproven.** Every decoded team-specific surrender
message in this match is for team 100, the local ORDER team. There is no known
enemy vote in this capture to test against. Decrypting a connection cannot reveal
a message the server never sends to that connection.

The new tool is an **offline research analyzer**. The app still records and
exports captures; it does not yet run this decoder live. No `/ff` typing or
automatic voting has been added.

## Measured timeline

Input: `ff-2026-10-17T14-16-30-474Z-dfcd91`, game 8016231671, ARAM Mayhem / KIWI,
queue 2400. The report retains packet UTC and estimates game time from the nearest
Live Client request midpoint. These estimates are not the user's chat timestamps.

| Vote | Outgoing request | Incoming start | Decoded updates | Explicit result |
| --- | --- | --- | --- | --- |
| 1 | 8:33.673 | 8:33.704, 1 yes / 0 no | 8:35.348: 1–1; 8:37.113: 1–2 | **Failed**, 8:37.113, 1–2 |
| 2 | 18:13.775 | 18:13.803, 1–0 | 18:17.994: 1–1; 18:22.401: 2–1 | **Not recovered** |
| 3 | 23:42.462 | **Not recovered** | 23:45.565: 2–0; 23:45.733: 3–0; 23:45.866: 4–0 | **Accepted**, 23:45.866, 4–0 |

The first two incoming starts follow the outgoing requests by **31.25 ms** and
**28.37 ms**. The outgoing request only establishes an attempt; the incoming
start establishes that a vote opened. Updates and acceptance are separate events.
The third request is not promoted to a confirmed incoming start.

The acceptance packet arrived at **14:41:01.987776 UTC**. The API GameEnd event
arrived at **14:41:10.735 UTC**, **8.747 seconds later**. The API's intrinsic
`EventTime` is 1434.523315 seconds; its difference from the packet's estimated
game time is 8.657 seconds. Do not use the event row's cached sample `gameTime`
(1433.105103) as the intrinsic GameEnd time.

User-reported times remain separate ground truth: 8:33–8:36, 18:15 (chat 18:21)
to 18:27, and 23:42–23:49. Packet estimates do not fully agree, especially in the
second window. The current data does not establish whether the discrepancy is
human timing, chat timing, clock alignment or another effect. Request latency
and anchor age are included in each decoded event; they are not complete error
bounds. A future controlled test should retain both clients' packet UTC and
independent manual markers.

## What was recovered

The Windows build is 16.20.824.8524. The corresponding official macOS universal
executable is 16.20.8248524, from release manifest
`66B91DB25E5AD56E`, with SHA-256:

```text
f0ff0944c204e51cce8df8493f8d769c82e0b0f70bae63fe90e074c30a973671
```

The analyzer refuses other binaries. Addresses below are x86-64 virtual addresses
in this exact file, not offsets for injection into a running Windows process.

1. The original local r3d log contains the launch session material needed for
   this connection. The analyzer reads it in memory. The existing redacted
   debug export deliberately does not contain it. No live RAM access is needed.
2. Incoming UDP has four clear bytes before the encrypted portion; outgoing UDP
   has twelve. Decryption uses two independent Blowfish CFB64 passes with a zero
   IV, reversing the complete buffer between passes. Only complete eight-byte
   blocks enter each cipher pass; the remainder stays unchanged in that pass.
   Buffers shorter than eight bytes alone cannot validate the key.
3. The decrypted header contains a 16-bit sequence, 32-bit checksum and flags.
   Negative signed sequences include eight acknowledgment bytes; their negation
   supplies the acknowledged sequence. Without them, checksum input uses eight
   `FF` bytes. The checksum covers sequence, player identifier, acknowledgment
   bytes and payload. It is checked before interpreting any payload.
4. Flag 128 marks Zstandard compression. The application message container then
   provides channel, sequence, payload length, optional fragmentation and compact
   fields. The previous-message context starts at zero. Complete fragments are
   assembled with a bounded five-second window; incomplete groups are counted.
5. On game channel 1, packet IDs below 251 occupy one byte; larger IDs use
   `251 + (firstByte - 251) * 256 + secondByte`. Matching current packet factories
   and consumers supply meanings; historical IDs are not reused.

| Packet type | Direction | Evidence and interpretation |
| --- | --- | --- |
| 1062 / `0x426` | Client → server | Constructed by the current `surrender` command callback. Three requests found. Type identified; request body is not semantically decoded. |
| 738 / `0x2e2` | Server → client | Nine exactly decoded start/update messages. Real consumer yields team, actor, yes/no counts, and whether this is a start or update. |
| 662 / `0x296` | Server → client | Two exactly decoded announcement messages. Reasons 0 and 4 map to `OnSurrenderFailedVotes` and `OnSurrenderAgreed`. Consumer gives the same 1–2 and 4–0 counts as their preceding updates. |
| 668 / `0x29c` | Server → client | Six exactly decoded booleans. Timing suggests local surrender eligibility/cooldown: true near 8 minutes, false at requests, true about 300 seconds later. **Meaning remains provisional**, and this is not an enemy/start/decision signal. |
| 673 / `0x2a1` | Server → client | One candidate near game end. Its type reaches a game-end handler in the macOS dispatch, but this captured body fails exact deserialization. **Rejected**, not reported as a confirmed decoded end. |

Relevant code locations:

| Purpose | Address |
| --- | --- |
| Blowfish setup / encrypt / decrypt | `0x101711140` / `0x101711b60` / `0x101711cf0` |
| Transport reader / checksum | `0x1005e9310` / `0x1005e90b0` |
| Message reader / caller initializing prior context | `0x1005e8350` / `0x1005edbb0` |
| Compact application type reader / factory | `0x101865e10` / `0x101237830` |
| Vote deserializer / consumer scalar extraction | `0x1013d1b10` / `0x1006df681`–`0x1006df79b` |
| Announcement deserializer / event mapping / arguments | `0x1013d28f0` / `0x1006b9a80` / `0x1006b9aa0` |
| Surrender command callback / request construction | `0x100dd9420` / `0x100f18fa3` |

The current vote consumer also compares the message team with local team state
at `0x1006df856` before taking the UI path. That is a **client-side filter**; it
does not establish whether the live server sends enemy votes. Historical
[team-only routing](ff-unofficial-research-2026-10-17.md) is supporting context,
not proof of current server behavior.

## Coverage and unresolved gaps

The final pass read all **342,133** PCAPNG packet records. Identical-frame
observations within two milliseconds are heuristically deduplicated, leaving
**170,412** matching IPv4 UDP observations. Original files are unchanged.

- **170,405** pass the real protocol checksum; **7** are rejected.
- **21,600** compressed payloads decompress successfully.
- All checksum-valid datagrams have completely consumed message framing:
  **382,278 message occurrences**, including retransmissions/fragments.
- **1,646** fragment occurrences produce **646** complete assembled messages;
  **48** fragment groups expire incomplete. Reassembly finds no additional
  surrender event in this game.
- Three unique non-IPv4 observations are excluded (five raw records before
  deduplication). No IP-fragment or truncated-record exclusion occurs here.
- One relevant application-type candidate fails exact semantic decoding: 673.

The missing second failure and third start cannot be treated as negative evidence.
For example, outgoing record **339405**, estimated 23:42.507, acknowledges
incoming transport sequence **14860**. No checksum-valid incoming instance of
that sequence is observed within five seconds. The surrounding channel-1 message
sequences jump from **48090 to 48094**, with 48091–48093 absent from the extracted
traffic. This is consistent with a capture/processing coverage gap; it does not
identify the contents of those missing messages or establish the root cause.

The general acknowledgment audit finds **4,269** such incoming-sequence coverage
candidates, no outgoing ones. The report includes them with record IDs and UTC.
This number is **not a measured network-loss rate**: it depends on sequence
interpretation, capture boundaries and a five-second matching window. It also
does not use the full acknowledgment bitmask to reconstruct delivery history.

Reconversion of the original ETL with `pktmon etl2pcap --drop-only` reported
342,133 total packets, **zero recorded drops**, and zero formatted drop records.
It did not recover the missing messages. Windows' earlier “No events lost”
diagnostic is not proof that every application message is available to this parser.

## Running the analyzer

Files: [analyzer](../research/ff_live_16_20.py),
[bounded macOS oracle](../research/ff_oracle_16_20.py),
[tests](../research/test_ff_live_16_20.py),
[dependencies](../research/requirements-ff.txt).

From the repository in PowerShell, after installing Python and obtaining the
exact local binary above:

```powershell
python -m venv .venv-research
.venv-research/Scripts/python.exe -m pip install -r research/requirements-ff.txt
$captureBase = 'C:\path\to\ff-YYYY-MM-DD-capture'
$macBinary = 'C:\path\to\66B91DB25E5AD56E-LeagueofLegends'
$gameLog = 'C:\Riot Games\League of Legends\Logs\GameLogs\matching-game\matching-game_r3dlog.txt'
.venv-research/Scripts/python.exe research/ff_live_16_20.py `
  --pcap "$captureBase.packets\packets.pcapng" `
  --debug-log "$captureBase.jsonl" --game-log $gameLog --binary $macBinary `
  --output "$captureBase.packets\analysis\decoded-16-20.json"
```

Use an unused output filename; the tool refuses to overwrite files. It writes
source hashes, counts, decoded events, per-event alignment information, rejected
record IDs, and acknowledgment coverage diagnostics. The report has no session
key, auth token, raw/decrypted payload, server address, account ID or player name.
Actors are labeled `player-1`, etc., within the report.

For a friend's test, run this on the machine that still has the **matching original
game log**, then share the derived report with the normal capture export. Do not
send the raw r3d launch log just to supply a key. A previously exported redacted
log alone cannot unlock an encrypted capture. There is no automatic upload and
the raw capture remains subject to the existing export privacy limitations.

The complete result for this game is beside its original capture at
`%APPDATA%\LeagueClientAutomation\ff-research\ff-2026-10-17T14-16-30-474Z-dfcd91.packets\analysis\decoded-16-20-verified.json`.
A compact, non-secret [evidence snapshot](ff-decoded-evidence-2026-10-17.json)
retains all decoded events and rejections plus the coverage gaps near the votes.

## Validation and next experiment

**15 tests passed**, with the local SHA-pinned binary enabled. These include
48 cipher cases against actual client encryption/decryption, 18 checksum cases
against its checksum function, message-framing comparisons against its reader,
wrong-key rejection when encrypted blocks exist, input bounds, endian/timestamp
handling, fragment handling, clock alignment and secret-free session errors.
Every accepted incoming semantic event in the full-capture run requires exact
deserializer input consumption; vote counts/team are obtained by executing the
actual consumer's bounded scalar extraction, not inferred from packet lengths.

```powershell
$env:FF_MACOS_BINARY = $macBinary
.venv-research/Scripts/python.exe -m unittest discover -s research -p test_ff_live_16_20.py -v
```

Without `FF_MACOS_BINARY`, the four oracle-dependent tests are explicitly skipped.
No whole-app behavior changed in this follow-up, so prior app validations are not
presented as a new live-decoder test. Only one real Mayhem game has been decoded;
other modes, patches and matching Windows/macOS layouts remain unvalidated.

The next useful test is a controlled match with captures on **opposing teams**.
First verify the voting side contains its own start/update packets, then look for
the same team-specific messages on the other side at those UTC times. Include a
failed vote so a pre-decision signal cannot be confused with the final surrender
announcement. Repeat an own-team vote as a positive control in the same captures.
If only the voting team's connection carries the open-vote messages, further
decryption on the opposing connection will not solve early detection. No live
automation should depend on the provisional cooldown boolean or on absent packets.
