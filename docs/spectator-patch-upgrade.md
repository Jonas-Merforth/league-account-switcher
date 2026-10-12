# Spectator decoder patch-upgrade runbook

Use this document when a new League patch drops and the account switcher's
friend score hover reports `unsupported`, or whenever a spectator field,
profile, supported mode, observer request, or research tool changes.

As of this document's last update, the newest production profiles are
`league-16.20-scoreboard-v1` for supported Summoner's Rift queues and
`league-16.20-mayhem-scoreboard-v1` for ARAM Mayhem on `Releases/16.20`.
The protected Windows executable requires an offline oracle using the
official matching macOS build; no League process is launched or inspected.
See the latest history entry for the evidence and remaining validation gaps.

## Required outcome

A patch is supported only when current-patch keyframes alone reproduce the
delayed spectator scoreboard exactly. Never make an old profile's version
matcher broader just to restore the UI. Until verification finishes, the
correct result is `status: "unsupported"`, not plausible-looking numbers.

The production path must continue to:

- use only observer metadata, last-keyframe information, and the newest
  keyframe;
- use Riot's positive `nextAvailableChunk` countdown only while waiting for the
  first readable keyframe, then return to the advertised keyframe interval;
- derive the approximate live clock from decoded keyframe time, the current
  observer buffer, and bounded publication age rather than friend presence;
- avoid game chunks, historical event accumulation, League/replay processes,
  and persistent observer sockets;
- select a narrow versioned profile and validate its critical packet structure;
- expose only tracked friends plus aggregate team data;
- keep raw payloads, observer keys, credentials, replays, and unmatched player
  identities out of commits, logs, IPC, and renderer state.

## Read these files first

1. `docs/spectator-keyframe-decoding.md` describes the working packet formats,
   transforms, offsets, validation rules, and runtime lifecycle.
2. `docs/spectator-decoder-research-log.md` records successful findings,
   incomplete leads, and approaches that must not be repeated.
3. `src/core/spectator/keyframe-snapshot-decoder.js` owns profile selection and
   output validation.
4. `src/core/spectator/patch-16-20-profile.js` is the current assembly
   profile.
5. `src/core/spectator/patch-16-20-codecs.js` contains the current pure
   JavaScript packet codecs. The 16.19 through 16.14 files remain
   immutable regression references.
6. `research/inspect_macos_16_20.py` is the current offline executable oracle;
   `research/verify_patch_16_20.mjs` compares its output with production codecs.
   `research/inspect_keyframes.py` retains the historical Windows oracle.
   None of these research tools may be imported by the application.

## Establish the new patch and evidence set

Confirm the installed game patch before changing code. The observer transport
`/version` value, such as `2.36.0`, is not the League game patch.

Useful Windows checks:

```powershell
Select-String -Path 'C:\Riot Games\League of Legends\system.yaml' -Pattern 'branch:'
(Get-Item 'C:\Riot Games\League of Legends\Game\League of Legends.exe').VersionInfo |
  Select-Object FileVersion, ProductVersion
```

Build a private current-patch evidence set:

- Prefer at least one Solo/Duo, one Flex, and one Normal Summoner's Rift replay.
- Include early, middle, and late keyframes from each replay.
- Include games with towers and each available neutral objective taken.
- Include a live late-join comparison when an eligible friend game is
  available.
- Capture the visible delayed scoreboard at the same timestamp when possible.
  Replay/post-game data is ground truth only; it must never become decoder
  input.
- Keep `.rofl` files, extracted keyframes, screenshots with identities, and
  analysis output outside tracked source. This repository ignores `.rofl`,
  `.local-research/`, and the research virtual environment.

Do not infer compatibility from a single final scoreboard. A replay can end
after its final published keyframe, and structures or objectives taken later
will legitimately differ.

## Set up the research helper

The helper was verified with Python 3.13 and the pinned packages in
`research/requirements.txt`:

```powershell
py -3.13 -m venv .venv-research
.\.venv-research\Scripts\python.exe -m pip install --upgrade pip
.\.venv-research\Scripts\python.exe -m pip install -r research\requirements.txt
```

For 16.20, use the SHA-pinned macOS helper and comparison command in the
[16.20 history entry](#1619-to-1620---2026-10-12). The same pinned research
dependencies suffice once the official binary has been extracted. CDTB is
only an optional artifact-extraction aid, not a runtime or oracle dependency.

Historical Windows packet inspection (requires a readable matching PE):

```powershell
.\.venv-research\Scripts\python.exe research\inspect_keyframes.py `
  'C:\path\to\current-patch.rofl' `
  --exe 'C:\Riot Games\League of Legends\Game\League of Legends.exe' `
  --keyframe 12 `
  --packet 387
```

The current 16.20 baseline uses packet 444 for hero stats, packet 522 for the
roster, packet 1200 for turret state, and packet 227 for inventory. The above
Windows command is a historical 16.18 example, not a current oracle. Repeat
player-scoped inspection for the current inventory packet when inventory
research is needed. The helper can also be imported from a temporary private
analysis script to call `read_rofl`, `read_rofl_stream`, `infer_player_base`,
`LeagueEmulator.packet_profile`, `LeagueEmulator.deserialize_block`,
`decode_hero_snapshot_payload`, and the roster-string helpers directly.

The helper contains patch-local executable RVAs and assumptions, including the
base-parameter mutation table, allocator hooks, field-bit reader, and hero
mutation table. Constructor, vtable, and deserializer discovery is dynamic,
but the complete helper is not automatically portable. If emulation fails on
the new executable, rediscover and document every changed RVA instead of
forcing the previous address. Remove unused old-patch hooks rather than
leaving dormant addresses that may point at unrelated new code.

### Fast offline path for protected Windows builds

The successful 16.19 workaround also worked directly on 16.20. Start here
when the Windows PE has high-entropy protected sections and no readable
constructor code; closing League does not change its on-disk bytes.

1. Confirm the installed game version, then find the same build in
   `LoL/EUW1/macos/lol-game-client/` in the riot-manifests registry. Download
   the referenced manifest and required bundles from Riot's official CDN;
   CDTB can parse RMAN and decompress the selected executable's chunks.
2. Extract `LeagueofLegends.app/Contents/MacOS/LeagueofLegends` and
   `code-metadata.json`. Verify the branch/build and pin the complete binary's
   SHA-256 before executing any helper with hardcoded addresses.
3. Select the universal Mach-O's x86-64 slice. Use `LC_FUNCTION_STARTS` for
   function boundaries and `LC_SYMTAB`/`LC_DYSYMTAB` plus the stub section's
   indirect symbol indexes to identify bzero and C++ static-guard/atexit
   shims. Do not transplant the previous build's addresses.
4. Rediscover the packet factory, vtable slot-1 deserializers, allocators,
   base-parameter reader/table, object fields, and each vector/string write
   direction. Search constructor packet-ID writes on multiple registers:
   16.20's factory uses `[rax+8]`, not only the old `[rdi+8]` pattern.
5. Use the bounded offline oracle on actual current-patch payloads. Require
   complete input consumption, byte-for-byte vectors, record-order equality,
   and decoded turret names/states before porting codecs. Cross-platform
   version similarity alone is not proof.

Record all newly verified addresses in a patch-specific helper. Keep old
helpers unchanged. No game launch, live-memory dump, debugger, injection, or
Windows unpacking is part of this path.

## Fast compatibility check

Start by testing the new keyframes against the previous patch's packet
expectations without changing the production version matcher.

Verify separately:

1. Ten contiguous player entities can still be inferred.
2. Every player has one current hero-snapshot packet with the expected payload
   shape (packet 444 in the 16.20 baseline).
3. The hero snapshot decodes and consumes exactly, with canonical team IDs
   100/200.
4. Kills, deaths, assists, lane CS, neutral CS, XP, and objective credits still
   occupy the verified semantic positions.
5. The current roster packet (522 in 16.20) recovers exactly ten known champion
   names in unambiguous participant order. Compare the case-sensitive allowlist
   with the installed patch's base `Game/DATA/FINAL/Champions/*.wad.client`
   stems; exclude locale copies and mode-specific `Ruby_*`, `Strawberry_*`, and
   `TFTChampion` assets.
6. Standard Summoner's Rift exposes the expected turret entity set and an
   absolute alive/destroyed state.
7. The patch's inventory packet is tested independently. Its failure must
   result in `capabilities.items: "unavailable"` and must not block the score
   snapshot.
8. New season mechanics have not changed level caps or cumulative XP
   thresholds for the supported queues.

Mode profiles must set independent structural bounds and capability flags.
For example, 16.20 ARAM Mayhem retains packets 444 and 522, has no verified
Summoner's Rift turret set, and does not expose neutral-objective totals.

Do not use whole-keyframe SHA hashes as a patch allowlist. Ordinary game state
changes incidental packet counts and lengths. Validate the critical packet
grammar and decoded semantics instead.

## Choose the adaptation path

### A. Layout and mutations are unchanged

This is the easy path:

1. Add a new narrowly matched profile for the new `major.minor` patch.
2. Reuse the existing codec functions rather than copying them when byte-level
   behavior is proven identical.
3. Give the profile a new versioned ID.
4. Register it in `KeyframeSnapshotDecoder`.
5. Add profile-selection and fail-closed tests.
6. Complete every replay and live comparison below before enabling it.

Do not edit the historical profile to claim the new version. Keeping old
profiles immutable makes replay regressions and future comparisons possible.

### B. Mutation table or constants changed, grammar stayed the same

Use the current executable and the helper's emulator/deserializer oracle to
recover the new table, transforms, default constants, and relevant RVAs.
Create patch-specific codecs and tests. Compare their output against several
timestamps before registering the profile.

### C. Packet grammar, IDs, registry layout, or world entities changed

Treat this as new reverse engineering:

- Inventory and other optional capabilities may remain unavailable while core
  scores ship, but never return partial data within one capability.
- A hero-snapshot change blocks KDA, CS, team kills, level, and objectives until
  all affected fields are verified.
- A roster change blocks safe friend-to-participant mapping.
- A turret-layout change makes tower totals unavailable until the complete
  absolute object set is understood.
- Re-run constructor/vtable discovery, generated-deserializer tracing, exact
  consumption checks, and transition analysis as appropriate.
- Record both successful and rejected approaches in
  `docs/spectator-decoder-research-log.md`.

### D. Observer transport or key delivery changed

First separate transport failure from payload failure. Confirm metadata,
observer encryption-key delivery, Blowfish mode/padding, gzip inflation, and
block framing. Do not look for an account-bound second key: the verified 16.14
transport key came from observer metadata. A true transport redesign may
require a larger investigation before any profile work is possible.

## Patch adaptation history

Maintaining this history is a required part of every spectator patch adoption,
including patches that ultimately reuse an existing codec unchanged. Add the
newest entry after validation and before committing. Future investigations
should read this section before starting executable or packet research so they
can test previously volatile boundaries first.

Each entry must record:

- the old and new game patch, plus the observer transport versions seen;
- the critical packet-role mapping before and after the change;
- what remained byte-compatible and what changed;
- any mode-specific structural bounds or capability differences;
- which fields were deliberately left unavailable and why;
- research-helper or executable-RVA changes needed for the investigation;
- live/replay/post-game evidence obtained and any validation gaps left open;
- rejected shortcuts or assumptions that would have produced plausible but
  unverified output.

Keep raw game IDs, observer keys, participant identities, and private fixture
paths out of this history.

### 16.14 to 16.15 - 2026-08-03

This was adaptation path C: the observer block framing and player-entity model
survived, but every critical scoreboard packet ID changed and several wire
grammars moved.

| Role | 16.14 | 16.15 | Required adaptation |
|---|---:|---:|---|
| Hero statistics | 747 | 670 | Kept the 1,476-byte decoded vector and semantic stat offsets, but changed the field tag and byte mutation. The mutation table bytes happened to remain equal; that did not make the old transform compatible. |
| Participant roster | 761 | 315 | Recovered three new canonical string mutations. The new records were already in participant-slot order instead of requiring the 16.14 order restoration. The exact-case 173-champion base allowlist remained unchanged. |
| Summoner's Rift turrets | 815 | 298 | Kept the same 22 deterministic turret network IDs, but moved the absolute alive flag to generated-header bit offset 16. |
| Inventory | 129 | 370 | Confirmed exact executable consumption and ten-record allocation, but could not independently prove item and slot semantics. Items were therefore disabled for the whole 16.15 capability instead of partially decoded. |

Additional changes and lessons:

- The observer transport version changed from `2.36.0` to `2.45.0`; neither
  value was used as the game-patch selector. The installed or metadata game
  branch remained the authoritative profile version.
- The observer buffer was no longer one global value. A visible 16.15
  Summoner's Rift comparison showed the old 150-second estimate about 23
  seconds behind and aligned with the standard 180-second buffer. Independent
  wall-clock/keyframe comparisons across three Mayhem games aligned with a
  60-second buffer. These delays moved into the mode profile; historical
  profiles retain their prior value.
- Ranked Solo and Normal Draft produced the same strict Summoner's Rift packet
  structure. Ranked Flex was enabled through that same narrow queue profile and
  role-quest level handling, but a direct 16.15 Flex sample remained pending.
  Other Normal and Summoner's Rift queues were not inferred to be compatible.
- ARAM Mayhem required a separate mode profile. Its valid roster could be
  shorter than the Summoner's Rift lower bound, and its packet-298 objects were
  not the 22 standard turrets. The Mayhem profile publishes player scores and
  team kills but marks towers, neutral objectives, structures, and items
  unavailable; the renderer omits those fields rather than displaying zeroes.
- The executable-assisted helper needed new base-parameter-table, allocator,
  field-reader, mutation-table, and deserializer RVAs. Obsolete 16.14 enum and
  inventory plaintext hooks were removed because leaving old addresses active
  against a new executable could trace unrelated code.
- Validation used multiple early/middle/late keyframes from live Ranked Solo,
  Normal Draft, and three ARAM Mayhem games. Completed-game comparisons checked
  exact champion/team mapping and monotonic cumulative values. A direct Flex
  sample and same-clock visible spectator comparison remained documented gaps.
- The fastest reliable sequence was: compare packet inventories first, trace
  exact client consumption second, separate stable semantic offsets from
  changed wire mutations, then split mode profiles as soon as structural bounds
  or map capabilities diverged. Reusing 16.14 packet IDs or widening its version
  matcher would not have restored verified output.

### 16.15 to 16.16 - 2026-08-19

This was adaptation path C again: observer transport, block framing, and the
ten-player entity model remained compatible, but all four critical packet IDs
changed and the two identity-bearing payload mutations had to be recovered
from the new executable.

| Role | 16.15 | 16.16 | Required adaptation |
|---|---:|---:|---|
| Hero statistics | 670 | 248 | Kept the 1,476-byte decoded vector, participant ordering, and semantic offsets. Recovered tag `0x0d` and a new subtract/swap/table/rotate/table/subtract/table byte mutation; the unchanged 256-byte table alone was not evidence of compatibility. |
| Participant roster | 315 | 827 | Recovered three new canonical alternating front/back string mutations. Exactly ten hits remained in participant-slot order. The installed base WAD set still matched the exact-case 173-champion allowlist. |
| Summoner's Rift turrets | 298 | 320 | Kept the same 22 deterministic network IDs, 47-63 byte range, ownership mapping, and absolute alive flag at generated-header bit offset 16. The surrounding header shape changed and is validated by the new codec. |
| Inventory | 370 | 793 | Confirmed exact executable consumption and a ten-record allocation. Item IDs, slots, and default-state semantics were not independently established, so items remain unavailable rather than being guessed or partially returned. |

Additional changes and lessons:

- The installed branch was `Releases/16.16` (`16.16.804.9184`). The observer
  transport `/version` changed from `2.45.0` to `2.49.0`; it remains diagnostic
  only and is not a game-patch alias.
- The helper's executable constants moved with the client: base-parameter
  table `0x1B360D0` to `0x1B375C0`, allocator/free hooks
  `0x11A1920`/`0x11A1950` to `0x11999B0`/`0x11999E0`, field reader
  `0xF27680` to `0xF31B30`, and hero table/routine
  `0x1B15B50`/`0xEF0E20` to `0x1B16C70`/`0xEEC9E0`. Packet constructors,
  vtables, and deserializers continued to be discovered dynamically.
- Six live games supplied ten private early/middle/late keyframes: two Ranked
  Solo, one Ranked Flex, and three ARAM Mayhem. Every old 16.15 profile
  rejected them.
  The new executable deserializers consumed packet 248, 827, 320, and 793
  inputs exactly, and the pure profile decoded every frame without relaxing
  the packet grammar.
- Across sequential frames, all ten participants' KDA, CS, and XP values were
  monotonic; objective and turret totals were monotonic where applicable, and
  team kills equalled their five participant sums. Summoner's Rift tower
  totals progressed from `4/2` to `6/7`. Champion
  rosters stayed stable, tracked friends mapped uniquely, and one Mayhem game
  mapped two tracked friends to two distinct slots in the shared monitor.
- Mayhem again needed the separate 800-byte roster floor and exposes only
  participant scores plus team kills. Summoner's Rift retains the 900-byte
  floor and objective/tower capabilities. Both modes leave items and
  inhibitor totals unavailable.
- Queue 420, queue 440 Ranked Flex, and Mayhem have direct 16.16 evidence. Two
  sequential late-game Flex frames mapped five tracked friends uniquely, moved
  monotonically from `38/52` to `41/57` team kills and `7/6` to `8/6` towers,
  retained all 22 turret objects, and passed exact current-executable
  consumption for representative packet 248, 827, 320, and 793 payloads.
  Queue 400 Normal Draft still needs a direct 16.16 sample. A
  current-patch post-game comparison and same-clock visible delay check also
  remain pending. The mode-specific 180/60-second delay values were retained;
  they were not inferred from presence timestamps or observer protocol
  version.
- Reusing packet IDs, field tags, or roster transforms from 16.15 failed
  closed. Packet-length matching alone, widening the 16.15 version regex, or
  treating exact executable consumption as proof of inventory semantics would
  all have produced either unsupported or unverified output.

### 16.16 to 16.17 - 2026-08-27

This was adaptation path C for a third consecutive patch. Observer transport,
block framing, the ten-player entity window, scoreboard semantic offsets, and
the standard Rift turret IDs survived, but every critical packet ID changed.
The hero vector also grew and both identity-bearing wire mutations changed.

| Role | 16.16 | 16.17 | Required adaptation |
|---|---:|---:|---|
| Hero statistics | 248 | 433 | Expanded the decoded vector from 1,476 to 1,492 bytes, changed the tag to `0xda`, changed to forward output order, and recovered the new swap/rotate/swap/rotate/table/XOR mutation. Team, XP, KDA, CS, and objective offsets remained stable. |
| Participant roster | 827 | 326 | Recovered three new canonical string readers: two forward readers and one alternating front/back reader. Exactly ten hits remained in participant-slot order. The installed base WAD set still matched the exact-case 173-champion allowlist. |
| Summoner's Rift turrets | 320 | 786 | Kept the same 22 deterministic network IDs and ownership map, but the absolute state is now a destroyed flag at generated-header bit offset 0, width 1. Observed payloads remained 47-59 bytes. |
| Inventory | 793 | 101 | Confirmed exact executable consumption and ten 160-byte record allocations. Item IDs, slots, default states, and display ordering remain unverified, so the whole item capability stays unavailable. |

Additional changes and lessons:

- The installed branch was `Releases/16.17` (`16.17.810.4348`). Observer
  transport `/version` changed from `2.49.0` to `2.51.0`; it remains diagnostic
  only and is not used as a game-patch selector.
- Eleven live games supplied 14 private keyframes: five Ranked Solo games, one
  Ranked Flex game, and five ARAM Mayhem games, including early, middle, and
  late state. Every frame
  correctly failed the immutable 16.16 profiles. The new pure profiles decoded
  all 14 without weakening any old matcher or using private data at runtime.
- The 16.17 executable consumed all 140 packet-433 hero payloads, 14 packet-326
  rosters, 198 recognized packet-786 turret payloads, and 140 packet-101 inventory
  payloads exactly, including routing prefixes. Every pure hero vector matched
  the executable allocation byte-for-byte. Team kills equalled participant
  sums, roster mapping was unambiguous, and early-to-late Rift tower totals
  progressed from `0/0` to `3/5` within one game.
- Mayhem and Rift both fit a 900-1,300 byte roster bound in the available
  evidence. Mayhem still publishes only player scores and team kills; Rift
  retains objective and tower totals. Both modes leave items, inhibitors, and
  the composite structure capability unavailable.
- Research-helper constants moved again: base-parameter table `0x1B671C0`,
  allocator/free `0x119BAB0`/`0x119BAE0`, field reader `0xF37210`, hero table
  `0x1B46660`, and hero vector routine `0xEEF590`. Constructor, vtable, and
  deserializer discovery stayed dynamic. The helper's pure hero and roster
  routines were updated to the new grammar.
- Queue 420, queue 440 Ranked Flex, and Mayhem have direct 16.17 evidence. On
  2026-08-29, the Flex frame used the unchanged strict Rift profile, retained
  all 22 turret objects, produced all ten participant rows, and mapped its tracked friend to
  exactly one slot. Queue 400 Normal Draft remains gated by the same complete
  Rift packet grammar and fail-closed decoders, but a direct current-patch
  sample was unavailable. A same-clock visible scoreboard and post-game
  comparison also remain pending. The 180/60-second delays are retained
  assumptions, not conclusions from the transport version or presence time.
- Reusing 16.16 packet IDs or transforms failed closed. Packet 300 also had ten
  player-scoped occurrences, but the current client made no matching record
  allocation; packet 101 made the ten 160-byte allocations. Packet counts,
  payload lengths, or exact client consumption alone were not treated as proof
  of scoreboard or inventory semantics.

### 16.17 to 16.18 - 2026-09-12

This was adaptation path C for a fourth consecutive patch. Observer transport,
block framing, the ten-player entity window, scoreboard semantic offsets, the
standard Rift turret IDs, and the 256-byte mutation table survived, but every
critical packet ID, the hero transform and output order, the roster readers,
and the turret state bits changed. The roster also revealed a backwards-written
record vector that the earlier profiles had silently assumed away.

| Role | 16.17 | 16.18 | Required adaptation |
|---|---:|---:|---|
| Hero statistics | 433 | 387 | Shrank the decoded vector from 1,492 to 1,264 bytes and changed the tag to `0xcb`. The new routine at RVA `0xEFCE40` uses a table-free rotate/subtract/swap transform and writes decoded bytes backwards, so the first wire byte is the last decoded byte. Team, XP, KDA, CS, and objective offsets were unchanged. |
| Participant roster | 326 | 523 | Recovered three new canonical string readers, all forward. The generated record vector is filled backwards, so payload hit order is the reverse of participant order; reversing the ten hits pairs each champion with the correct hero slot. The installed base WAD set still matched the exact-case 173-champion allowlist. |
| Summoner's Rift turrets | 786 | 1110 | Kept the same 22 deterministic network IDs and ownership map. The absolute destroyed state moved to generated-header bit offset 13, mirrored by a matching width-1 field at bit offset 19; observed payloads were 47-63 bytes. |
| Inventory | 101 | 850 | Confirmed a ten-record allocation (1,520 bytes, 152 bytes per record) and exact executable consumption. Item IDs, slots, and default-state semantics remain unverified, so the whole item capability stays unavailable. |

Additional changes and lessons:

- The installed branch was `Releases/16.18` (`16.18.817.5716`). Observer
  transport `/version` changed from `2.51.0` to `2.55.0`; it remains diagnostic
  only and is not used as a game-patch selector.
- Five live Ranked Solo games supplied 86 keyframes, one Ranked Flex game 9,
  one Normal Draft game 10, and thirteen ARAM Mayhem games 138 keyframes
  during adaptation. Every 16.17 profile rejected them. The pure 16.18
  profiles decoded all 1,050 Rift and 1,380 Mayhem hero payloads, all 243
  rosters, and every recognized turret block. Champion rosters stayed stable
  and unique in every frame.
- The hero vector is written backwards: the wire's first data byte belongs to
  the vector's last byte. The Rift turret totals stayed monotonic across all
  seven Rift games, reaching `1/8`, `8/4`, `1/2`, `0/0`, `6/3`, `5/4`, and
  `3/4` for team 100/team 200 in the final sampled frames. Team kills equalled
  their five participant sums. A live friend's champion, identified through the
  independent startup packet's participant order, landed on the expected
  participant row and team.
- Packet 523's record vector is also written backwards. The live executable
  pointer-write trace wrote the first payload champion (participant 10) into
  the last record and the last payload champion (participant 1) into the first.
  Earlier profiles had not modelled that direction, and index-only pairing
  would have attached each champion to the wrong hero row. The profile now
  reverses the roster hits before matching them to hero entities.
- Mayhem filled an entire frame with its own packet-1110 objects, none of which
  are the 22 Summoner's Rift turrets. Its rosters can be shorter than Rift's;
  an 847-byte and an 884-byte payload were observed, so Mayhem keeps the
  800-byte floor while Rift retains 900. Mayhem still publishes only player
  scores and team kills; Rift retains tower and objective totals. Both modes
  leave items, inhibitors, and the composite structure capability unavailable.
- Queues 400, 420, 440, and Mayhem all have direct 16.18 evidence. The Ranked
  Flex frame set contained two tracked friends, both mapped to distinct
  participant rows, and the Normal Draft set contained one; representative
  Draft and Flex frames passed the same executable hero-vector, roster
  consumption, and turret consumption checks as Ranked Solo, including the
  descending roster record writes that require hit reversal. A same-clock
  visible scoreboard and post-game comparison remain pending. The 180/60-second
  delays are retained assumptions.
- Research-helper constants moved again: base-parameter table `0x1BA7970`,
  allocator/free `0x11B9530`/`0x11B9560`, field reader `0xF48E40`, and roster
  string table `0x1B92E90`. Constructor, vtable, and deserializer discovery
  stayed dynamic. The helper's pure hero and roster routines were rewritten for
  the new grammar.
- Reusing 16.17 packet IDs or transforms failed closed. Packet 300 had no
  16.18 occurrences, and packet 850 was accepted as the inventory candidate
  only because the executable allocated ten 152-byte records for it; allocation
  shape and exact consumption alone were not treated as proof of item
  semantics.

The 16.18 review additionally checked all 166 then-available frames (77 Solo,
89 Mayhem) and tightened the turret header gate: bits 0-2 must be selector 4
and bits 20-23 must retain `0xf` padding, alongside the two agreeing state
fields. These invariants held in all 1,694 recognized Rift turret payloads.
Length and state-bit agreement alone accepted zero-filled payloads that the
current executable rejected. Other header selectors vary and remain unfrozen.
The later Ranked Flex and Normal Draft samples re-confirmed the same header
gate and state bits across the full 2,310-payload corpus.

### 16.18 to 16.19 - 2026-09-26

Installed branch: `Releases/16.19`; final executable version:
`16.19.821.7343`; code metadata:
`16.19.8217343+branch.releases-16-19.code.public`. Observer transport remains
`2.55.0`, but the scoreboard grammar changed.

#### Recovering an offline oracle

Both official Windows builds examined (8207193 and 8217343) contain protected
`.text/.rdata/.data/.pdata` sections and `.riot0/.riot1`; closing League does
not change the on-disk protection. Constructor markers and the old mutation
table are absent. The historical helper now explains that failure explicitly.
The local PBE 16.3 binary and companion DLLs were not usable substitutes.

The successful alternative was Riot's official **macOS 8217343 build**, whose
universal Mach-O contains readable x86-64 code. Manifest discovery used
[riot-manifests](https://github.com/Morilli/riot-manifests); extraction used
[CDTB](https://github.com/CommunityDragon/CDTB)'s RMAN/bundle format support.
Manifest `5BBF3F70EADF0C91` came from
[Riot's CDN](https://lol.dyn.riotcdn.net/channels/public/releases/5BBF3F70EADF0C91.manifest).
The extracted `LeagueofLegends` binary SHA-256 is
`ea05eba548fcc408e66d142f4e408d172c686636991786d309334bf2e31c9b53`.

`research/inspect_macos_16_19.py` pins that exact hash, maps the x86-64 slice
in Unicorn, uses the SysV argument registers, and invokes factory VA
`0x10132ab60` and vtable slot 1. Allocator, zeroing, and static-initialization
shims are bounded; complete input consumption is mandatory. This is not a
Windows unpacker, a game launch, injection, debugger attachment, or live
memory dump. No macOS machine is required. Other builds need fresh addresses
and proof; neither shared patch numbers nor cross-platform similarity suffice.

#### Verified packet changes

| Role | 16.18 | 16.19 | Verified change |
| --- | --- | --- | --- |
| Hero | 387 | 137 | Tag `0x67`, 1,263-byte payload, 1,260-byte vector; add/rotate/swap/table/add mutation, backwards writes. Published stat offsets remain unchanged. |
| Roster | 523 | 453 | Eleven 328-byte records: ten participants plus empty world record. Descending record writes still require hit reversal. Canonical strings now use two reverse readers and one outside-in reader. |
| Rift turrets | 1110 | 1099 | Same 22 IDs and executable-decoded owner names; lengths 47–63. Header bits 0 and 7 clear when destroyed, bit 11 sets; all three must agree. |
| Inventory candidate | 850 | 855 | Ten 168-byte records instead of 152-byte records. Exact consumption/allocation verified; item semantics remain unverified and items unavailable. |

Packet 136 was an initial shape-based turret lead, **not** the turret codec.
Only decoded names and state established packet 1099. The 173 exact-case
champion assets still match the allowlist after excluding generic
`TFTChampion`. Rift roster bounds remain 900–1,300; Mayhem remains 800–1,300.
Observed Mayhem lengths were 950–1,066, not new evidence for the historical
800-byte lower bound.

#### Validation and limits

- **35 keyframes / nine games:** Draft 9 / two games (4–24 minutes), Solo
  9 / three games (9–19 minutes), Flex 3 / one game (11–13 minutes, four
  tracked friends), Mayhem 14 / three games (2–13 minutes).
- All **350 hero vectors** matched the executable byte-for-byte. Every roster
  matched the executable's ten participant records in order. All **462 Rift
  turret payloads** consumed exactly and matched name-derived ownership and
  object state. Inventory candidates consumed exactly and allocated ten records.
- Production decoded every frame with zero failures. Rosters were stable;
  team kills and towers were monotonic per game. Rift samples include zero
  towers and later nonzero totals (up to six for one team); Flex samples had
  zero towers and nonzero dragon/grub credits.
- A real `SpectatorStatsService` late join returned a fresh Mayhem snapshot,
  including the tracked friend's KDA, CS and level. By that later check, the
  captured Draft/Solo/Flex games had ended; a live service refresh for those
  queues was not revalidated. Their direct current-patch capture/oracle checks
  did pass.
- **374 tests passed**; historical 16.18 regression: **243 frames / 20 games,
  zero failures**. Tests cover all roster directions, all 256 hero byte values,
  invalid tags/lengths/teams/floats, incomplete/duplicate turrets, inconsistent
  state bits, malformed selectors, queue/version isolation and unavailable items.
- Same-clock visible scoreboard/post-game comparison remains pending. The
  corpus has nonzero dragon, Herald and grub credits, but no nonzero Baron,
  Elder or Atakhan example; those unchanged slots have vector/oracle and
  synthetic coverage, not new nonzero real-game ground truth. Endgame Flex
  and later Mayhem samples also remain gaps.
- Observer-delay values **180 seconds Rift / 60 seconds Mayhem** are retained
  assumptions, not newly measured timings. Inhibitor totals and items remain
  unavailable; Mayhem also keeps map objectives and towers unavailable.

Reproduce the executable comparison after privately obtaining that binary and
capturing decrypted keyframes under `<capture-root>/<private-game>/`, with
each game's private `manifest.json` providing `queueId` and `queueType`:

```powershell
node research/verify_patch_16_19.mjs .venv-research/Scripts/python.exe <official-macos-binary> <capture-root>
```

This emits counts only. Binaries, manifests with identities, captures, and
oracle output stay private/ignored. The production runtime still fetches only
metadata, last-keyframe information, and the newest keyframe.

**Lessons:** an unreadable Windows build does not imply that the transport
changed or that another official platform build is unusable. Packet size alone
does not establish role. Trace both the string byte direction and enclosing
record direction. Compare the entire vector, not merely plausible scores;
keep fixed byte examples so accidental changes to mutation tables are caught.

### 16.19 to 16.20 - 2026-10-12

Installed branch: `Releases/16.20`; Windows version `16.20.824.8524`.
Matching official code metadata:
`16.20.8248524+branch.releases-16-20.code.public`.
Observer transport changed from `2.55.0` to `2.62.0`; framing, decryption
and the ten-player entity model remain compatible. This is adaptation path C.

The Windows executable remains protected. The documented macOS route worked
without launching or inspecting League. Artifact discovery used
[riot-manifests](https://github.com/Morilli/riot-manifests), extraction used
[CDTB](https://github.com/CommunityDragon/CDTB), and the official manifest is
[66B91DB25E5AD56E](https://lol.dyn.riotcdn.net/channels/public/releases/66B91DB25E5AD56E.manifest).
The 80,518,288-byte `LeagueofLegends` binary has SHA-256
`f0ff0944c204e51cce8df8493f8d769c82e0b0f70bae63fe90e074c30a973671`.
`research/inspect_macos_16_20.py` rejects every other binary hash.

| Role | 16.19 | 16.20 | Verified change |
| --- | ---: | ---: | --- |
| Hero | 137 | 444 | Tag `0x65`, unchanged 1,263-byte payload / 1,260-byte vector. New table-free NOT/rotate/add/rotate/subtract/rotate mutation; backwards vector writes. Object vector moved from +0x18 to +0x10. Shared stat offsets remain unchanged. |
| Roster | 453 | 522 | Eleven 328-byte records, but records now write forwards. Canonical champion field moved from +0x10 to +0x48; strings A/B write backwards and C forwards. Do not reverse the ten payload hits. |
| Rift turrets | 1099 | 1200 | Same 22 name-proven IDs/owners. Destroyed is header bit 1 set; bits 0 and 2 must agree. Executable state moved to object +0x54: standing 0xdc, destroyed 0x86. |
| Inventory candidate | 855 | 227 | Ten 168-byte records, exact consumption/allocation verified. Item/slot semantics still unverified; items remain unavailable. |

The exact-case 173-champion base WAD set still matches the allowlist after
excluding locale copies, mode assets and TFTChampion. The roster permutation
table is unchanged, but none of the old reader transforms is compatible.
Rift bounds remain 900–1,300 bytes and Mayhem 800–1,300; observed lengths were
985–1,209. Turrets retain the conservative 47–63-byte envelope, with observed
lengths 47–59. Fixed header bits 6/7 must both be one, bit 11 zero and bits
20–23 zero; all other selectors are allowed to vary.

#### Oracle addresses and reusable lessons

These are macOS virtual addresses, not Windows RVAs:

| Routine | 16.20 VA |
| --- | --- |
| Factory / base parameter reader / parameter table | `0x101237830` / `0x101865e80` / `0x10234f810` |
| Hero deserializer / reverse vector | `0x10128a340` / `0x10131b530` |
| Roster deserializer / forward record vector | `0x10141d780` / `0x10141d600` |
| Canonical string A / B / C / table | `0x10141b400` / `0x1014e5d00` / `0x1014e5e40` / `0x102342ec0` |
| Turret deserializer | `0x101268010` |

Allocator shims are `0x1016fc1a0`, `0x1016fc0c0`, `0x1016fc110`
(aligned), and `0x1016fc1d0`. Free is `0x1016fc0f0`; symbol-proven bzero,
atexit, guard-acquire and guard-release stubs are `0x1022326f0`,
`0x1022326fc`, `0x10223271a`, `0x102232720`. Heap and instruction
budgets, zeroed allocations and exact cursor checks remain mandatory.

The initial previous-patch object-field assumptions were wrong even when the
new deserializer consumed the whole packet successfully. Turret +0x18 is
now a map-type label such as SR_Inner, not the canonical owner name (+0x40).
The roster also contains alternate champion text at +0xb0; scanning both
fields would double-count. Trace the actual +0x48 readers and enclosing
record loop. Inheriting 16.19's reversal would put champions on the wrong
participant rows. Keep replacements scoped to symbols/messages, not broad
decimal substitutions that can silently alter hex tables.

#### Validation and limits

- **51 frames / seven games:** Solo 24 / three games (4–19 minutes), Flex
  16 / two games (11–28 minutes), Mayhem 11 / two games (0–13 minutes).
- All **510 full hero vectors**, all 51 roster orders, and all **880 Rift
  turret payloads** agree with the official executable. All **510 inventory
  candidates** consume exactly and allocate ten 168-byte records.
- Production passes every frame. Per-game champion rosters are stable;
  participant KDA/CS/levels and team kills/towers are monotonic. Decoded
  vector scalars match participant and team output, including objective
  aggregation and role-quest top-lane level handling. Samples contain nonzero
  dragon, Herald, grub and Baron credits, and towers up to five/six for the
  two teams across the corpus.
- A real `SpectatorStatsService` late join returns fresh Solo, Flex and
  Mayhem snapshots with tracked-friend scores. No historical chunks are
  required by production. Startup chunks were captured for private research
  only; they have not established an independent identity-order cross-check.
- **387 tests pass**, including all 256 hero byte values, fixed public
  champion examples from all three reader variants, record order, invalid
  state/shape/version/mode rejection, and unavailable optional capabilities.
  Historical regressions also pass: **35 frames / nine games on 16.19**
  (including Draft) and **243 frames / 20 games on 16.18**, zero failures.
- **Normal Draft (400) has no direct 16.20 sample yet.** It is enabled only
  through the same strict Rift grammar and has synthetic queue/level coverage,
  not a claim of direct live validation. No other Normal queues are enabled.
- Same-clock visible scoreboard/post-game comparison and independent identity
  mapping remain pending. Elder and Atakhan have unchanged-offset/vector and
  synthetic coverage, not new nonzero semantic ground truth. Delay values
  **180 seconds Rift / 60 seconds Mayhem** are retained, not remeasured.
  Items and inhibitors remain unavailable; Mayhem also withholds map totals.

Reproduce the counts-only executable comparison with private artifacts:

```powershell
node research/verify_patch_16_20.mjs .venv-research/Scripts/python.exe <official-macos-binary> <capture-root>
```

Each game's ignored folder contains decrypted keyframes and a private
`manifest.json` with queue context. Do not commit binaries, raw captures,
observer keys, account identifiers or oracle vectors.


## Required exact comparisons

At multiple keyframe timestamps and across the evidence set, require exact
agreement for every capability being enabled:

- friend champion and participant mapping;
- friend KDA, total CS, and level;
- both teams' kill totals;
- dragons including Elder credit, Barons, Rift Heralds, Void Grubs, and
  Atakhan;
- both teams' destroyed-tower totals on supported Summoner's Rift layouts;
- inventory only if the patch profile declares it available internally.

Also verify:

- two tracked friends in one game share one monitor and both map correctly;
- duplicate/ambiguous champion mapping exposes no incorrect friend row;
- any changed roster champion asset spelling has an exact-case synthetic
  roster regression;
- late joining receives the current delayed absolute score without chunks;
- unsupported modes retain ordinary presence with an explanation;
- a deliberately wrong patch version and malformed critical packet both fail
  closed;
- a malformed or missing inventory packet preserves scores but disables all items;
- no raw keyframe, observer key, credentials, full participant list, unmatched
  identity, or item data reaches renderer IPC or logs;
- observer requests remain serialized, finite, and subject to the shared
  60/120/300-second 429 controller, including when the first-keyframe warm-up
  cadence follows `nextAvailableChunk`;
- the `nextChunkId` keyframe association and observer-buffer assumption still
  match a same-moment visible live clock, including both keyframe-aligned and
  trailing latest-chunk cases, and a completed game's short final chunk stops
  advancing at its reported duration.

If no eligible live game is available, record live validation as pending. Do
not substitute a post-game total for a same-timestamp live comparison.

## Automated validation and delivery

Add or update focused tests for the new codecs, profile selection, structural
rejection, optional capability behavior, game monitor, redacted IPC, and hover
states. Then run:

```powershell
npm test
node --check src\core\spectator\keyframe-snapshot-decoder.js
node --check src\core\spectator\game-monitor.js
node --check src\core\spectator\spectator-stats-service.js
python -c "import ast, pathlib; ast.parse(pathlib.Path('research/inspect_keyframes.py').read_text(encoding='utf-8'))"
git diff --check
```

Run the private replay regression corpus separately; raw fixtures must not be
committed. Perform a live late-join check when possible.

Before committing:

1. Update the newest verified profile named at the top of this document.
2. Update `docs/spectator-keyframe-decoding.md` with new packets, transforms,
   offsets, capability boundaries, modes, or lifecycle behavior.
3. Update `docs/spectator-decoder-research-log.md` with new findings and failed
   approaches.
4. Add a chronological entry to the patch adaptation history in this runbook,
   even when the new patch reuses an old codec unchanged.
5. Update the rest of this runbook if any command, file, dependency, decision
   point, or acceptance rule changed.
6. Add a short friend-readable `PATCH_NOTES.md` entry.

## Common traps already disproved

- Do not accumulate live chunks; late joins remain permanently partial and
  polling increases 429 risk.
- Do not scan raw bytes for plausible KDA, CS, levels, item IDs, or champion
  strings; generated schemas mutate and reorder them.
- Do not treat the observer protocol `/version` as the League patch.
- Do not use a whole-keyframe structural hash as a patch allowlist.
- Do not count level-up events; derive level from verified cumulative XP.
- Do not sum personal turret/inhibitor credits as authoritative team structure
  totals.
- Do not treat persistent inhibitor-controller state as cumulative inhibitor
  destructions.
- Do not publish a field merely because its named stat-registry slot exists;
  several such slots were zero in verified keyframes.

The detailed evidence and additional rejected packet candidates remain in
`docs/spectator-decoder-research-log.md`.
