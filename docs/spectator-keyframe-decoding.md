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

## Patch 16.14 structural profile

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

## Packet 747: absolute hero statistics

Packet 747 contains a mutation-encoded vector of exactly 1,476 bytes. The
wire payload starts with tag `0xe8`, followed by a mutated varint length. Vector
bytes are written in alternating front/back order.

The byte mutation is patch-local:

1. rotate the wire byte right by four;
2. subtract `0x75`;
3. swap adjacent bits;
4. rotate right by one and XOR with `0xf5`;
5. index the 256-byte mutation table recovered from the 16.14 client.

After decoding, the vector uses the client stat registry's scalar layout:

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

## Packet 761: roster and participant mapping

Packet 761 contains the champion internal names. Three generated string
mutation variants are scanned, but a profile is accepted only when exactly ten
known 16.14 champion names are recovered without ambiguity.

The generated vector helper writes the records in this wire order:

`1, 2, 10, 3, 9, 4, 8, 5, 7, 6`.

Restoring that order maps each champion to the corresponding packet-747 player
entity. Friend presence supplies a champion ID. A friend is exposed only when
that champion maps to exactly one unused participant slot; duplicate or
ambiguous champions fail closed for that friend.

## Packet 129: absolute inventory

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

## Packet 815: absolute turret state

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

Packet 747 also has personal credited turret and inhibitor kill/takedown
counters at `0x78` through `0x84`. These are not team structure totals:
minion-destroyed structures may have no credited player, inhibitors respawn,
and an inhibitor in one lane can be destroyed again after respawning.

Packet 815 solves the tower half directly from persistent world entities, so
standard-Rift responses now contain an exact `towersDestroyed` value.
`inhibitorsDestroyed` remains `null`, and the composite
`capabilities.structures` remains `"unavailable"` until the cumulative
inhibitor total is decoded. On unsupported map layouts both structure fields
remain null.

Neutral objective counters do not have that ambiguity. Their five-player team
sums matched the official replay stats at the same timestamp across the
current fixture corpus, so `capabilities.objectives` is available.

## Offline reverse-engineering boundary

`research/inspect_keyframes.py` can load the current League executable into a
Unicorn x86-64 emulator and invoke generated packet deserializers. It is an
offline oracle used to identify field readers, source offsets, allocation
shapes, and at-rest mutations. For example, this exposed the packet-129 item
ID and inventory-slot plaintext immediately before the generated schema
mutated them in memory.

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
monitor at a time, starts at a 60-second cadence, and closes every HTTP
connection after its finite cycle. HTTP 429 moves the shared cadence through
60, 120, and 300 seconds and honors the complete `Retry-After` cooldown. One
tier is recovered after each clean 30-minute window.

The renderer receives only tracked-friend rows and aggregate team totals. Its
hover line shows the estimated current live clock as `now - presence startedAt`,
reports snapshot age as `now - fetchedAt`, and estimates distance from live as
`(now - presence startedAt) - keyframe gameTimeSeconds`, clamped to zero.
Because Riot presence and the game clock are not guaranteed to share an exact
origin, the live clock and delay are deliberately marked approximate.

## Patch maintenance

Follow [spectator-patch-upgrade.md](spectator-patch-upgrade.md) for the complete
new-patch workflow. At minimum, for a new observer client patch:

1. Preserve new replay fixtures at several timestamps and official scoreboard
   ground truth.
2. Re-run the offline packet inventory and generated-deserializer tracing.
3. Create a new profile; never widen the 16.14 version matcher without replay
   and live structural verification.
4. Require exact multi-mode, multi-timestamp agreement.
5. Keep any unverified field unavailable.

Raw keyframes, observer keys, client credentials, replay identities, item IDs,
and unmatched participant rows must stay out of committed fixtures, logs, IPC,
and renderer state.
