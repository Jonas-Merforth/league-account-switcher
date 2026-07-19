# Decoder research log

This is the negative-results companion to
[spectator-keyframe-decoding.md](spectator-keyframe-decoding.md). It records
approaches that were tested so later patch work does not repeat the same
assumptions.

## Tooling and evidence used

- Seven local 16.14 replay files, sampled at first, middle, and final
  keyframes.
- Replay post-game statistics as ground truth only, never as decoder input.
- Visible spectator scoreboards for timestamp-level spot checks.
- The installed 16.14 League executable, loaded into Unicorn for offline
  generated-deserializer tracing.
- Static analysis of packet constructors, vtables, the hero-stat registry,
  primitive readers, allocation shapes, and mutation tables.
- Current Data Dragon item IDs for candidate validation.
- Historical open-source packet layouts from
  [LeagueEmulatorJS](https://github.com/Karmel0x/LeagueEmulatorJS) and
  [Chronobreak](https://github.com/Shadoukita/Chronobreak).

No signed-in account secret was needed to decode semantic fields. Observer
metadata already supplies the transport Blowfish key. The remaining layer is
generated per-field mutation, not another account-bound encryption key.

### Observer version is not the game patch

The live observer consumer `/version` endpoint returned `2.36.0` while both the
installed executables and `system.yaml` identified the game build as
`16.14.794.5912` / `Releases/16.14`. Treating `2.36.0` as the decoder patch made
the first live keyframe correctly fail closed, but it was the wrong selection
input: that endpoint describes the observer transport protocol.

The account switcher selector prefers a game client version supplied by
observer metadata and otherwise reads the patch branch from `system.yaml` in
the configured League installation. The protocol version is not used as a
patch alias, so a future patch cannot silently reuse the 16.14 codec merely
because the observer transport stays at `2.36.0`.

## Successful findings

### Transport and framing

- Observer keyframes decrypt and inflate without launching the game.
- A late keyframe is a complete state transfer; historical chunks are not
  needed for the current scoreboard.
- Ten player entities can be inferred as a contiguous entity window.

### Packet 747

- The generated deserializer and its mutation table were reproduced in pure
  JavaScript.
- The 1,476-byte decoded vector is the current hero-stat registry snapshot.
- Team, XP, KDA, lane/neutral CS, player-credited structures, gold
  earned/spent, and neutral objective credits have stable registry offsets.
- XP-derived levels match current state. The direct `LEVEL` registry slot does
  not.

### Packet 761

- Three string-reader mutations recover exactly ten internal champion names.
- The non-linear vector wire order was reconstructed as
  `1,2,10,3,9,4,8,5,7,6`.

### Packet 129 offline oracle

- Each player has a ten-record inventory vector with 0x98-byte in-memory
  records.
- Tracing generated primitive readers before at-rest mutation exposed exact
  item IDs and inventory slots.
- The values matched the replay at the keyframe timestamp, including purchases
  that differed from later post-game items.
- Schema call tracing established a four-byte outer record header, a
  three-byte nested item-state header, exact optional-field order, and records
  serialized from slot 9 down to slot 0.
- The generated grammar and its required mutation readers are now reproduced
  in pure JavaScript. It consumed 2,110 real packet-129 payloads and matched
  2,100 executable-oracle item slots with zero differences.
- Production treats inventory as an optional all-or-nothing capability. If any
  of the ten packet-129 payloads is absent or fails exact validation, all item
  rows are discarded while independently verified scoreboard fields remain
  available. This prevents an unused item-schema change from disabling the
  account switcher's score hover.

### Packet 815 turret state

- The executable deserializer identifies the 22 standard-Rift packet-815
  entities as `Turret_TOrder_*` or `Turret_TChaos_*`, with categories
  `SR_Outer`, `SR_Inner`, `SR_Inhibitor`, and `SR_Nexus`.
- The generated field at header bit offset 3, width 1, is the absolute alive
  state. It changes only from 1 to 0 for a given turret.
- The fixed map IDs provide canonical owner teams. Counting dead enemy turret
  entities gives the team's tower score without player attribution or event
  accumulation.
- The pure parser decoded all 4,268 packet-815 payloads in 194 standard-Rift
  keyframes. The ARAM Mayhem fixture has a different object set and correctly
  remains unsupported for towers.

### Inhibitor controller state

- The six standard-Rift inhibitor controllers have stable map IDs. Packet
  1227 has exactly two observed payload states across 1,164 controller
  snapshots: a one-byte default and a 24-byte switched/destroyed state.
- Packet 280 game-stream events identify the canonical inhibitor controller
  on each destruction. Packet 930 also exposes the five-minute respawn
  transition.
- A controller remains marked after its inhibitor respawns and can be
  destroyed again. The packet-1227 bit therefore establishes that a lane was
  breached at least once, but it is not the cumulative inhibitor score.

## Rejected or incomplete approaches

### Accumulating live chunks

The first prototype inferred deaths and objectives from event signatures. It
worked only from the point observation began, permanently undercounted a late
join, required continual polling, and increased 429 risk. It remains an
offline cross-check only. Production must replace state from absolute
keyframes.

### Plain scalar and string scanning

Searching raw keyframe payloads for expected KDA, CS, level, item IDs, or
champion strings produced no reliable mapping because generated schemas mutate
wire bytes and reorder vector elements. Any coincidental hits were discarded.

### Whole-keyframe structural SHA allowlist

The structural fingerprint changes with ordinary game state because incidental
packet counts and lengths change. A whole-fixture hash would recognize only a
recording, not a patch. The production profile now checks exact critical
packet/entity shapes and validates their semantic decode.

### Packet 107 replication records

Packet 107's outer vector and record grammar were decoded. It contains useful
replication groups, but a sampled keyframe carried complete champion records
for only two of ten heroes. It cannot be the authoritative source for every
friend's level or inventory in a snapshot.

### Packet 648 enter-visibility state

The current generated deserializer yields a main variable vector and a
12-byte position vector. The main vector visibly contains current item IDs and
an old OnEnterVisibility-like suffix (look-at entity, position, buffs, hero and
movement state). Its outer mutation, length varint, and reverse vector write
were reproduced exactly. Cross-checking the decoded vectors against packet 129
showed that packet 648 contains only selected active/state item-like values,
not a complete inventory. It was rejected as the production item source.

### Packet 649 level-up events

Packet 649 is a real level-up event and its mutation was partially mapped.
Counting these events is still event accumulation, and replay streams contain
missing/duplicate observations relative to a selected keyframe. Cumulative XP
inside packet 747 is the authoritative snapshot source.

### Direct `LEVEL` and structure-loss stats in packet 747

The registry slots named `LEVEL`, `FRIENDLY_TURRET_LOST`,
`FRIENDLY_DAMPEN_LOST`, and `FRIENDLY_HQ_LOST` are zero in the sampled
keyframes. Their presence in the registry does not mean the snapshot populates
them.

### Summing personal structure credits

Summed `TURRETS_KILLED` and `BARRACKS_KILLED` values sometimes match final
stats but undercount structures destroyed by minions or after the last
keyframe. Takedowns also cannot represent inhibitor respawns or repeated Nexus
turret destruction. These values are useful verification evidence only.

### Packet 1227 structure hypothesis

The original attempt treated packet 1227 as a generic structure counter and
was correctly rejected: it does not track turrets. Later executable tracing
showed a narrower useful meaning on the six inhibitor controllers. Its state
persists through respawn, so summing those flags still undercounts repeated
destructions in one lane. Do not promote that sum, or
`max(player credits, controller flags)`, as an authoritative team total.

### Other packet candidates

- Packet 343 appears in event/chunk contexts and is not a complete scoreboard.
- Packet 480/ScoreManager-like state was not present as a usable keyframe
  snapshot in the inspected stream.
- Packet 290 did not correlate with team scoreboard totals.
- Entity-destruction packet signatures can identify some structure events but
  do not reconstruct absolute late-join state without full history.

### Packet 129 scanning attempt

A scanner using valid Data Dragon item IDs and expected slot categories
decoded only a subset of records. False-positive bitfield headers and omitted
default records make a greedy scan unsafe. The working implementation instead
reproduces the complete generated record grammar, checks slot order, and
requires exact payload consumption. Do not reintroduce item-ID scanning as a
fallback.

## Next research targets

1. Locate the cumulative inhibitor destruction total. Packet-1227 controller
   state alone cannot distinguish a respawned inhibitor destroyed twice.
2. Validate `GOLD_EARNED` team sums against the delayed spectator top bar
   before deciding whether to expose team gold.

Every new field must be decoded from keyframe bytes alone, agree at multiple
timestamps and modes, and fail closed on a patch mismatch.
