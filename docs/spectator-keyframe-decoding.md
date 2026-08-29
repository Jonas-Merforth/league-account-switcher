# Spectator keyframe decoding in the account switcher

This document describes the verified production decoder embedded under
`src/core/spectator/`. The account switcher does not import or launch the
former standalone spectator API. It intentionally separates the pure payload
implementation from the executable-assisted reverse-engineering tools used
offline.

## Runtime data flow

The production path needs only observer metadata and the newest keyframe:

1. Fetch observer metadata and last-chunk information.
2. If `keyFrameId` changed, fetch that one encrypted keyframe.
3. Decrypt with the observer key supplied by metadata, inflate the gzip body,
   and parse the standard observer block framing.
4. Infer the ten contiguous player entity parameters.
5. Select a profile by the observer-reported game client version, falling back
   to the installed game patch from `system.yaml`, plus verified packet
   structure.
6. Decode absolute participant state and replace the previous snapshot.

There is no League game process, replay process, persistent observer socket,
or `getGameDataChunk` call in this path.

## Patch 16.17 Summoner's Rift structural profile

The `league-16.17-scoreboard-v1` profile requires:

- observer or installed League branch `Releases/16.17`;
- Normal Draft queue ID 400, Ranked Solo 420, or Ranked Flex 440;
- ten contiguous player entities;
- exactly one packet 433 payload of 1,495 bytes for every player entity;
- exactly one packet 326 roster payload between 900 and 1,300 bytes;
- exactly 22 recognized packet 786 turret snapshots on Summoner's Rift;
- successful exact validation by every scoreboard codec.

Packet 101 is the 16.17 inventory candidate. Its generated deserializer
consumed all 140 captured player payloads exactly and allocated ten 160-byte
records per player, but item and slot semantics remain unverified. The profile
therefore keeps `capabilities.items: "unavailable"`; verified scores do not
depend on that optional packet.

Five live Ranked Solo games supplied early and late Rift evidence. One live
Ranked Flex frame passed the same strict profile, retained all 22 turret
objects, produced ten participant rows, and mapped the tracked friend uniquely.
All 140 hero payloads, 14 rosters, 198 recognized turret payloads, and 140
inventory payloads across the complete 14-frame multi-mode corpus were checked
against the installed executable. Normal Draft retains the same strict Rift
grammar and queue gate, but a direct 16.17 sample remains pending. Other Normal
variants do not inherit queue-400 support.

## Patch 16.17 ARAM Mayhem structural profile

The separate `league-16.17-mayhem-scoreboard-v1` profile requires queue ID
2400 or queue type `KIWI`, ten contiguous player entities, ten packet-433 hero
snapshots, and one packet-326 roster payload between 900 and 1,300 bytes.

Five independent live games covered middle and late Mayhem state. The mode
does not expose the 22 standard-Rift turret set, and its objectives are not
comparable to Rift counters. The profile publishes player scores and team
kills while leaving towers, structures, neutral objectives, and items
unavailable.

## Historical patch 16.16 Summoner's Rift structural profile

The `league-16.16-scoreboard-v1` profile requires:

- observer or installed League branch `Releases/16.16`;
- Normal Draft queue ID 400, Ranked Solo 420, or Ranked Flex 440;
- ten contiguous player entities;
- exactly one packet 248 payload of 1,479 bytes for every player entity;
- exactly one packet 827 roster payload between 900 and 1,300 bytes;
- exactly 22 recognized packet 320 turret snapshots on Summoner's Rift;
- successful exact consumption and validation by every scoreboard codec.

Packet 793 is the 16.16 inventory candidate. The generated client
deserializer consumed each tested payload exactly and allocated ten 168-byte
records, but item, slot, and default-state semantics are not independently
verified. The profile therefore keeps `capabilities.items: "unavailable"`.
KDA, CS, XP-derived levels, team kills, objectives, and tower totals do not
depend on that optional packet.

Two live Ranked Solo games and two sequential late-game snapshots from one
Ranked Flex game provide direct 16.16 evidence. The Flex frames contained five
tracked friends, all of whom mapped uniquely to different participant slots,
and representative packet 248, 827, 320, and 793 samples were consumed exactly
by the current executable. Normal Draft retains the same strict queue gate and
Summoner's Rift packet requirements, but a direct 16.16 queue-400 sample
remains pending. Other Normal variants do not silently inherit queue-400
support.

## Historical patch 16.16 ARAM Mayhem structural profile

The separate `league-16.16-mayhem-scoreboard-v1` profile requires queue ID
2400 or queue type `KIWI`, ten contiguous player entities, ten packet-248 hero
snapshots, and one packet-827 roster payload between 800 and 1,300 bytes.

Three independent live games confirmed the same hero mutation and sequential
roster order across early, middle, and late state. Mayhem still lacks the 22
standard-Rift turret objects and its neutral objectives are not comparable to
the Rift counters. The profile exposes friend KDA/CS/level and both team kill
totals while leaving towers, structures, neutral objectives, and items
unavailable. Null capability values are omitted by the renderer instead of
being presented as fabricated zeroes.

## Historical patch 16.15 Summoner's Rift structural profile

The `league-16.15-scoreboard-v3` profile requires:

- observer or installed League branch `Releases/16.15`;
- Normal Draft queue ID 400, Ranked Solo 420, or Ranked Flex 440;
- ten contiguous player entities;
- exactly one packet 670 payload of 1,479 bytes for every player entity;
- exactly one packet 315 roster payload between 900 and 1,300 bytes;
- exactly 22 recognized packet 298 turret snapshots on Summoner's Rift;
- successful exact consumption and validation by every scoreboard codec.

Packet 370 contains the changed 16.15 inventory state. The current client
deserializer consumes all ten live payloads exactly, but the new record fields
have not yet passed independent item/slot semantic comparison. The profile
therefore reports `capabilities.items: "unavailable"` and never calls the
16.14 packet-129 codec. KDA, CS, XP-derived levels, team kills, objectives, and
tower totals remain available independently.

Ranked Solo and Normal Draft have direct 16.15 live evidence. Flex uses the
same strict Summoner's Rift packet/entity requirements, level-quest rules, and
fail-closed decoders; a direct 16.15 Flex sample remains pending. Other Normal
variants do not silently inherit queue-400 support.

## Historical patch 16.15 ARAM Mayhem structural profile

The separate `league-16.15-mayhem-scoreboard-v2` profile requires queue ID
2400 or queue type `KIWI`, ten contiguous player entities, ten packet-670 hero
snapshots, and one packet-315 roster payload between 800 and 1,300 bytes.

Three independent live games confirmed the same hero mutation, semantic stat
offsets, and sequential roster order. One roster was only 889 bytes, below the
Summoner's Rift lower bound. The generated client deserializer consumed both
Mayhem roster shapes exactly.

Mayhem has a different map-object set and no standard-Rift turret snapshots.
The profile therefore exposes friend KDA/CS/level and both team kill totals,
while returning null towers and declaring structures and neutral objectives
unavailable. The renderer omits those irrelevant map metrics instead of
showing fabricated zeroes. Packet-370 items remain unavailable as in the
Summoner's Rift profile.

## Historical patch 16.14 structural profile

The `league-16.14-scoreboard-v3` profile requires:

- observer or installed League branch `Releases/16.14`;
- ten contiguous player entities;
- exactly one packet 747 payload of 1,479 bytes for every player entity;
- exactly one packet 761 roster payload between 900 and 1,300 bytes;
- for standard Summoner's Rift, exactly 22 recognized packet 815 turret
  snapshots;
- successful exact consumption and validation by every scoreboard codec.

Packet 129 inventory is an independent optional capability. The profile tries
to decode exactly one complete ten-slot inventory for every player. It exposes
items internally only when all ten inventories pass; otherwise it discards all
item rows and reports `capabilities.items: "unavailable"` without hiding
verified KDA, CS, level, team kills, objectives, or towers. Items are not sent
to the account-switcher renderer.

The general structural SHA-256 remains useful diagnostics, but it is not used
as a game-specific allowlist: valid keyframes have different incidental packet
shapes as state changes. The profile instead verifies its critical packets and
fails closed if any required score field, length, participant count, team ID,
or mutation decode is invalid.

## Hero statistics: packet 433 in 16.17

Packet 433 decodes to a 1,492-byte hero-stat vector. The 1,495-byte payload
starts with tag `0xda`, followed by a mutated varint length, and writes decoded
bytes in forward order. The extra 16 trailing vector bytes do not move the
verified team, XP, KDA, CS, or objective offsets.

For each wire byte:

1. swap adjacent bits and rotate right by six;
2. swap adjacent bits again and rotate right by six (equivalent to left two);
3. index the 256-byte table at executable RVA `0x1B46660` and XOR `0x3e`.

The generated routine at RVA `0xEEF590` allocated exactly 1,492 bytes. Across
all 140 captured hero payloads, the pure vector matched the executable output
byte-for-byte and the deserializer consumed the complete input including its
routing prefix.

### Historical packet 248 in 16.16

Packet 248 still decodes to the 1,476-byte hero-stat vector and retains the
semantic offsets used in 16.14 and 16.15. Its 1,479-byte payload starts with
tag `0x0d`, followed by a mutated varint length, and writes decoded bytes in
alternating front/back order.

For each wire byte:

1. subtract `0x12` and swap adjacent bits;
2. index the 256-byte mutation table at executable RVA `0x1B16C70`;
3. rotate right by three and index the same table again;
4. subtract `0x5f` and index the table a third time.

The table bytes remained equal to the earlier patches, but neither previous
byte transform can decode packet 248. The generated routine at RVA `0xEEC9E0`
allocated exactly 1,476 bytes and consumed all tested inputs exactly.

### Historical packet 670 in 16.15

Packet 670 retains the 1,476-byte decoded hero-stat vector and the semantic
offsets used in 16.14, but changes the wire packet ID, tag, and byte mutation.
Its 1,479-byte payload starts with tag `0xaf`, followed by a mutated varint
length, and writes decoded vector bytes in alternating front/back order.

For each wire byte:

1. swap adjacent bits and XOR with `0x4d`;
2. index the 256-byte mutation table at executable RVA `0x1B15B50`;
3. rotate the table result right by one.

The table bytes are identical to 16.14, but equality of the table does not make
the old transform compatible. The generated packet-670 deserializer at RVA
`0xEF0E20` consumed each tested live payload exactly.

### Historical packet 747 in 16.14

Packet 747 contains a mutation-encoded vector of exactly 1,476 bytes. The
wire payload starts with tag `0xe8`, followed by a mutated varint length. Vector
bytes are written in alternating front/back order.

The byte mutation is patch-local:

1. rotate the wire byte right by four;
2. subtract `0x75`;
3. swap adjacent bits;
4. rotate right by one and XOR with `0xf5`;
5. index the 256-byte mutation table recovered from the 16.14 client.

After decoding any supported patch's hero vector, the client stat registry
uses this scalar layout:

| Vector offset | Type | Meaning |
|---:|---|---|
| `0x20` | `uint32` | canonical team ID |
| `0x28` | `float32` | cumulative champion XP |
| `0x3c` | `float32` | lane minions |
| `0x40` | `float32` | neutral minions |
| `0x4c` | `uint32` | kills |
| `0x50` | `uint32` | deaths |
| `0x54` | `uint32` | assists |
| `0xa4` | `uint32` | Baron credits |
| `0xa8` | `uint32` | dragon credits |
| `0xac` | `uint32` | Elder Dragon credits |
| `0xb0` | `uint32` | Rift Herald credits |
| `0xb4` | `uint32` | Void Grub credits |
| `0xb8` | `uint32` | Atakhan credits |

CS is `round(laneMinions + neutralMinions)`. Team kills and neutral objectives
are sums of the five absolute participant counters for that team. Elder credits
are included in the API's `dragons` total.

The same registry exposes `GOLD_EARNED` and `GOLD_SPENT` at `0x38` and `0x34`.
They are retained as a research lead but are not public until their spectator
semantics are validated against the visible team-gold display.

### Level from cumulative XP

The registry's nominal `LEVEL` scalar is zero in keyframes, while cumulative
XP is populated. Standard levels use cumulative thresholds:

`0, 280, 660, 1140, 1720, 2400, 3180, 4060, 5040, 6120, 7300, 8580, 9960,
11440, 13020, 14700, 16480, 18360`.

For assigned-position queues, roster slots 1 and 6 are the two top laners.
The 2026 top quest can extend only those slots to levels 19 and 20, at inferred
and replay-verified cumulative thresholds 20,340 and 22,420. Swiftplay and
ARAM retain the standard cap.

## Roster and participant mapping

### Packet 326 in 16.17

Packet 326 contains the ten champion internal names in participant-slot order.
Its three canonical readers use the shared 256-byte table but have distinct
wire mutations and output orders:

1. table lookup, bitwise NOT, table lookup, then rotate right two; forward;
2. table lookup, adjacent-bit swap, table lookup, adjacent-bit swap; forward;
3. subtract `0x15`, adjacent-bit swap, subtract `0x36`, then XOR `0xcf`;
   alternating front/back.

Scanning only these readers yielded exactly ten unambiguous names in every
captured roster, including the same champion switching between reader variants
in sequential frames. The installed 16.17 non-localized base WAD stems still
match the 173 exact-case allowlist, including `Zaahen`. Both current mode
profiles require a 900-1,300 byte roster and then require all ten rows.

### Historical packet 827 in 16.16

Packet 827 contains the ten champion internal names. Its three canonical
first-name readers all write decoded bytes in alternating front/back order but
use different mutations:

1. adjacent-bit swap, rotate right six, swap again, table lookup, rotate right
   two, add `0x63`, table lookup, then subtract seven;
2. add `0x1f`, rotate right four, then subtract `0x68`;
3. rotate right six, XOR `0x1a`, rotate right five, subtract `0x68`, then XOR
   `0xe3`.

Scanning only these canonical readers recovers exactly ten known champion
names in participant slots 1 through 10. Across every captured Ranked and
Mayhem frame the roster stayed stable and tracked champion IDs mapped
uniquely. The installed 16.16 base champion WAD set still contains the same
173 exact-case names as the production allowlist. Summoner's Rift requires a
900-1,300 byte payload; Mayhem keeps the conservative 800-byte lower bound.

### Historical packet 315 in 16.15

Packet 315 contains the ten champion internal names. Client-assisted tracing
identified three canonical generated string readers: two reverse-output
mutations and one alternating front/back mutation. Scanning only those three
canonical fields recovers exactly ten names; scanning the record's redundant
second champion-name fields creates duplicates and is rejected.

Unlike 16.14, the recovered record order is already participant slots 1 through
10. The installed 16.15 base champion WAD set contains 173 exact-case names and
matches the production allowlist with no additions or removals. Summoner's Rift
requires 900-1,300 payload bytes. Mayhem uses an 800-byte conservative floor;
the shortest observed valid payload was 889 bytes and still had to recover
exactly ten unambiguous champion rows.

### Historical packet 761 in 16.14

Packet 761 contains the champion internal names. Three generated string
mutation variants are scanned, but a profile is accepted only when exactly ten
known 16.14 champion names are recovered without ambiguity. These names are
case-sensitive Riot asset identifiers, not display names. For example, the
verified internal spelling is `FiddleSticks`, with a capital second `S`.

The generated vector helper writes the records in this wire order:

`1, 2, 10, 3, 9, 4, 8, 5, 7, 6`.

Restoring that order maps each champion to the corresponding packet-747 player
entity. Friend presence supplies a champion ID. A friend is exposed only when
that champion maps to exactly one unused participant slot; duplicate or
ambiguous champions fail closed for that friend.

## Inventory capability

### Packet 101 in 16.17

Packet 101 is the player-scoped inventory candidate. The 16.17 executable
consumed all 140 captured payloads exactly and allocated ten 160-byte records
per player. That establishes the packet's structural role, not the meaning of
its item, slot, default, or display fields. Production returns no items for the
whole 16.17 capability and does not fall back to plausible item-ID scanning.

### Historical packet 793 in 16.16

Packet 793 replaced packet 370. The current executable deserializer consumed
the sampled player payloads exactly and allocated ten 168-byte records. This
establishes the structural role but does not identify item IDs, slots, omitted
defaults, or visible-versus-hidden records. Production does not scan for
plausible shop IDs and returns no items for the entire 16.16 capability.

### Historical packet 370 in 16.15

Packet 370 replaced packet 129 and has a different vector/record schema. The
16.15 executable deserializer consumes the observed ten player payloads exactly
and allocates ten in-memory records, establishing that this is still the
inventory candidate. That is structural evidence only: the item ID, slot, and
default-state fields have not been independently matched at multiple
timestamps. The 16.15 profile therefore returns no items and declares the
entire capability unavailable.

### Historical packet 129 in 16.14

Each player entity has one packet 129 containing ten absolute inventory
records. The production parser mirrors the generated 16.14 schema rather than
scanning for plausible Data Dragon IDs:

1. Validate the outer one-byte packet header and one-byte vector header.
2. Decode the transformed record-count varint and require exactly ten.
3. Read records in wire order from slot 9 down to slot 0.
4. For each record, consume a four-byte Group-A bitfield header and its
   optional transformed scalar fields in schema order.
5. A Group-A bit at offset 24 selects either the default empty state or a
   nested item state.
6. The nested state begins with a three-byte bitfield header. The item-ID tag
   is at bit offset 4 with width 3; the slot tag is at offset 20 with width 3.
   Both support generated default constants and transformed wire values.
7. Validate that the decoded slot equals the record's expected wire position,
   consume every optional state field, and require exact payload exhaustion.

The item-ID transform rotates right by five, XORs `0x75`, swaps adjacent bits,
adds `0x19`, then rotates right by three before normal varint assembly. Dynamic
slot bytes use the same patch table as packet 747 followed by their own
rotate/XOR/add transform. Other optional record fields use additional
generated fixed-width or transformed-varint readers solely to preserve exact
record boundaries.

The decoder returns non-empty item IDs from visible scoreboard slots 0 through 6.
Hidden tracking/quest slots 7 through 9 are decoded and structurally validated
but the account switcher does not send item IDs to its renderer. Riot can use
internal IDs above the normal shop-item range, so the parser does not use a
Data Dragon allowlist as a correctness test.

Inventory is deliberately capability-isolated. A missing or changed packet-129
schema makes the entire snapshot's item capability unavailable; it never
returns a mixture of decoded and empty inventories, and it does not invalidate
independently verified score fields.

The pure JavaScript parser consumed all 2,110 packet-129 payloads in the seven
16.14 replay fixtures. A separate executable-assisted oracle compared 2,100
individual item slots from 210 first/middle/final player snapshots with zero
mismatches. Replay metadata was not input to either decode.

## Absolute turret state

### Packet 786 in 16.17

Packet 786 retains the same 22 deterministic Summoner's Rift turret network
IDs and owner teams. Its generated field reader at RVA `0xF37210` reads bit
offset 0, width 1 from the retained payload header. Executable object-state
comparison proves `1 = destroyed` and `0 = standing`, the inverse naming of
the previous alive field.

All 198 recognized payloads across nine Rift frames were 47-59 bytes and were
consumed exactly. The pure codec requires all 22 complete unique IDs. One game
progressed from `0/0` to `3/5`; a separate late frame reported `2/4`. A
same-clock visible scoreboard and post-game comparison remain pending.

### Historical packet 320 in 16.16

Packet 320 retains all 22 deterministic Summoner's Rift turret network IDs,
their ownership mapping, and the absolute alive field at generated-header bit
offset 16, width 1. Verified payloads were 47-59 bytes, within the retained
47-63 byte bound. The new codec also validates the surrounding generated
header shape and requires all 22 complete unique objects.

Two sequential Ranked Solo keyframes progressed monotonically from tower
totals `4/2` to `6/7` for team 100/team 200. A current-patch same-clock visible
scoreboard and post-game comparison remain pending, so personal structure
credits are still not used as a substitute.

### Historical packet 298 in 16.15

Packet 298 retains the same 22 deterministic Summoner's Rift turret network
IDs and ownership mapping. Its generated header moved the absolute alive field
to bit offset 16, width 1: payload byte 2 is `0x55` while alive and `0x54` once
destroyed. The client field reader returns at RVA `0xF0BA09`. Live keyframes at
approximately 11, 25, 33, and 40 minutes showed monotonic totals of 0/0, 2/6,
3/7, and 6/7 for team 100/team 200. Riot's post-game result 108 seconds after
the last published keyframe was 8/10, consistent with later turrets falling.
A same-clock visible-scoreboard comparison remains pending.

### Historical packet 815 in 16.14

Standard Summoner's Rift keyframes contain one packet 815 snapshot for each
of the map's 22 turret objects: eleven owned by team 100 and eleven owned by
team 200. The map-object network IDs and ownership are deterministic for this
patch profile.

Packet 815 begins with a three-byte generated-schema field table. The client
reader at return RVA `0xF0527A` reads bit offset 3, width 1. Executable-assisted
deserialization and transition analysis established `1 = alive` and
`0 = destroyed`. Team 100's tower score is therefore the number of dead
team-200 turret objects, and vice versa.

Production requires all 22 unique IDs, complete retained payloads, the
verified 47-63 byte payload range, and the expected schema-header nibble. A
partial set throws instead of returning a partial score. Modes without this
Summoner's Rift set return no tower total.

The pure decoder consumed all 4,268 turret snapshots in 194 standard-Rift
keyframes. Every individual turret transition was monotonic from alive to
destroyed. Final-keyframe totals also agreed with game-stream tower events up
to that timestamp; later post-game differences were explained by turrets
falling after the last keyframe.

## Objective and structure distinction

The hero-stat vector also has personal credited turret and inhibitor
kill/takedown counters at `0x78` through `0x84`. These are not team structure totals:
minion-destroyed structures may have no credited player, inhibitors respawn,
and an inhibitor in one lane can be destroyed again after respawning.

The patch-local turret packet solves the tower half directly from persistent
world entities, so
standard-Rift responses now contain an exact `towersDestroyed` value.
`inhibitorsDestroyed` remains `null`, and the composite
`capabilities.structures` remains `"unavailable"` until the cumulative
inhibitor total is decoded. On unsupported map layouts both structure fields
remain null.

Neutral objective counters do not have that ambiguity. Their five-player team
sums matched the official replay stats at the same timestamp across the
current Summoner's Rift fixture corpus, so `capabilities.objectives` is
available there. Mayhem does not expose those map objectives and marks the
capability unavailable.

## Offline reverse-engineering boundary

`research/inspect_keyframes.py` can load the current League executable into a
Unicorn x86-64 emulator and invoke generated packet deserializers. It is an
offline oracle used to identify field readers, exact source consumption,
allocation shapes, and at-rest mutations. The 16.17 refresh updates its base
parameter table to `0x1B671C0`, allocator/free hooks to
`0x119BAB0`/`0x119BAE0`, field-bit reader to `0xF37210`, hero mutation table
to `0x1B46660`, and the pure hero/roster helpers. Constructor, vtable, and
deserializer discovery remains dynamic. Old addresses are not left active
against unrelated 16.17 code.

The one-off research script and emulator are intentionally not part of the
account switcher. Production never reads the League executable. Once a field
is understood, its mutation and record grammar must be implemented directly
over keyframe bytes and pass replay regression before its capability becomes
available.

## Account switcher lifecycle and freshness

The existing saved-session Friends refresh discovers a friend `gameId`,
champion, observability, and the source account affinity. The affinity selects
the observer platform. No Riot or League process must be running, although the
saved account session must still be replayable and the League installation's
`system.yaml` supplies a patch fallback when observer metadata omits it.

Each unique `platformId:gameId` owns one monitor. The service checks at most one
monitor at a time and closes every HTTP connection after its finite cycle.
While the on-demand feed still reports `keyFrameId: 0`, a monitor without a
scoreboard schedules its next last-chunk check from Riot's positive
`nextAvailableChunk` millisecond countdown. The waiting delay is bounded
between five seconds and the normal keyframe interval; missing or invalid
guidance falls back to that normal interval. After the first readable keyframe,
the monitor returns to the observer-advertised interval, with 60 seconds as the
minimum. HTTP 429 moves the shared cadence through 60, 120, and 300 seconds,
honors the complete `Retry-After` cooldown, and overrides the shorter warm-up
schedule while escalated. One tier is recovered after each clean 30-minute
window.

The renderer receives only tracked-friend rows and aggregate team totals. The
monitor anchors its estimated live clock to the decoded keyframe instead of the
friend presence timestamp. At fetch time it adds the selected profile's
observer buffer and the keyframe's publication age to `gameTimeSeconds`.
Historical profiles default to the verified 150-second buffer. Patches 16.15,
16.16, and 16.17 use 180 seconds for supported Summoner's Rift queues and 60
seconds for ARAM Mayhem. The 16.15 evidence showed why one global value was
wrong; a fresh same-clock visible comparison for 16.17 remains pending, so the
new profile values are an explicitly retained timing assumption rather than a
claim derived from presence timestamps or observer protocol version.
Publication age starts with `availableSince`; when the latest chunk follows the
keyframe's associated chunk, it also includes the intervening chunk interval.
`nextChunkId` identifies the first chunk after the keyframe, so the bounded
extra age is `(chunkId - nextChunkId) * chunkTimeInterval`. When Riot omits that
direct association, the monitor derives a guarded fallback from the game-start
chunk and decoded game time. `availableSince` is capped to the reported chunk
duration so an ended stream cannot keep advancing after its short final chunk.
The renderer then advances that estimate by `now - fetchedAt`, reports the same
fetch age separately, and subtracts the snapshot game time for the displayed
distance from live. The value remains marked approximate because Riot can
change observer timing and publication can jitter.

## Patch maintenance

Follow [spectator-patch-upgrade.md](spectator-patch-upgrade.md) for the complete
new-patch workflow. At minimum, for a new observer client patch:

1. Preserve new replay fixtures at several timestamps and official scoreboard
   ground truth.
2. Re-run the offline packet inventory and generated-deserializer tracing.
3. Create a new profile; never widen an old version matcher or mode gate
   without replay and live structural verification.
4. Require exact multi-mode, multi-timestamp agreement.
5. Keep any unverified field unavailable.

Raw keyframes, observer keys, client credentials, replay identities, item IDs,
and unmatched participant rows must stay out of committed fixtures, logs, IPC,
and renderer state.
