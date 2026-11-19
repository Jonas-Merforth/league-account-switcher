# Live protocol automation: handoff

Work in progress on branch `live-protocol-automation`, cut from
`live-features` at `82428c3` on 2026-11-19. Nothing under `src/` has
changed yet. This document is everything a new session needs to continue.

## The question and the answer so far

The friend scoreboard and the Damage tab both decode League's internal
packets. Each patch (about every two weeks) breaks them, and each port has
taken an agent hours of reading disassembly. The owner asked:

1. Is there a pattern that avoids the per-patch upgrade altogether?
2. If not, make the upgrade as fast and mechanical as possible for an agent,
   and abstract the parts that change.

**Answer to 1: no, not at the decoder level.** Riot regenerates the packet
layer for every build. The history in
[spectator-patch-upgrade.md](spectator-patch-upgrade.md) and a comparison of
the 16.22 and 16.23 binaries show that all of this changes each time:

| Changes every build | Stays the same |
| --- | --- |
| Packet IDs (hero stats 747, 670, 248, 433, 387, 137, 444, 664, 313) | Observer transport, block framing (one change in ten patches: the second clock in 16.23) |
| Order of fields on the wire | The *shape* of the generated reader code |
| Which selector bits belong to which field, and which selector values mean "default" | Plain values and their meaning: stat vector offsets, combat event schemas, kinds and body offsets, turret names, enum values |
| The byte substitution of every field (a fresh mix of add, xor, rotate, bit swap and table lookups) | The default constants a selector can stand for: 0, 1, 2 and -1 |
| Byte order of vectors and strings (forward, reverse, outside-in) | The owner ID encoding (same table 16.20 through 16.23, still derived per build) |
| Field offsets inside the packet object (also shuffled, checked on packet 393 against 530) | |

The app has no source of plain values at runtime to learn a new encoding
from, so a build it has never seen cannot be decoded. Both features must
keep failing closed on unknown builds.

**Answer to 2: yes, the port can be mechanical.** Everything that changes
can be read out of the official macOS binary by running its own packet
readers on chosen inputs. No disassembly reading is needed. That is what
`research/liveproto/` does, and it already reproduces the hand-ported 16.23
decoder for six packets (see "Verified" below). What remains is finishing
three reader kinds, a generic JavaScript decoder that executes the recovered
schema, and the wiring. Then a new patch is: fetch binary, run one command,
check against one recording, commit one JSON file.

## What exists on this branch

| File | Purpose |
| --- | --- |
| `research/liveproto/macho.py` | Parses the universal Mach-O. Finds function starts, import stubs by name and the packet factory, with no per-build address. |
| `research/liveproto/emulator.py` | Unicorn harness. Replaces C runtime imports by name, discovers the game's allocator wrappers on the first fault, traces input reads and memory writes of one deserializer call. |
| `research/liveproto/probe.py` | Recovers a packet's layout as a schema: selector bytes, each field's selector window, default constants, and each reader's kind, byte table and byte order. |
| `research/describe_packets.py` | CLI. `--list` prints every packet ID with object size. With IDs it prints a summary and `--json` writes full schemas. |
| `research/trace_packet.py` | CLI debugging aid: raw writes per selector value of one field. Use it when the probe reports `unknown` or `opaque`. |
| `research/checkProbe16_23.mjs` | Regression check: probe output for 16.23 must equal the hand-written transforms in `src/core/damagePacketFields16_23.js`. |
| `research/dumpAllLivePackets.mjs` | Dumps every packet type of a Damage recording with counts, for parity tests and for finding role IDs by statistics. |

Run from the repository root with the research environment
(`research/requirements.txt`; only `unicorn` is needed by liveproto):

```powershell
.venv-research/Scripts/python.exe research/describe_packets.py .local-research/official-builds/A4E02DE59267375D-LeagueofLegends --list
```

```powershell
.venv-research/Scripts/python.exe research/describe_packets.py .local-research/official-builds/A4E02DE59267375D-LeagueofLegends 503 530 313 172 309 88 314 502 408 921 --json .local-research/liveproto/schemas-16.23.json
```

```powershell
node research/checkProbe16_23.mjs .local-research/liveproto/schemas-16.23.json
```

```powershell
.venv-research/Scripts/python.exe research/trace_packet.py .local-research/official-builds/A4E02DE59267375D-LeagueofLegends 314 --bit 0
```

A full probe of the ten 16.23 role packets takes under half a minute.

## Verified

- **Anchors on five builds.** The factory address found by `macho.py`
  equals the hand-found one on 16.19, 16.20, 16.21, 16.22 and 16.23, and
  `--list` constructs 1,085 to 1,094 packet types on each. The allocator
  wrappers found on 16.23 are exactly the three addresses in
  `research/inspect_macos_16_23.py`. 16.20 uses a different allocator
  shape (heap instance first, size second) and is handled.
- **16.23 parity, 25 of 25 checks** in `checkProbe16_23.mjs`: owner ID
  table; marker 503 time table and selector set; replication 309 vector
  table, order and time table; hero stats 313 table, length table and
  reverse order; combat 172 body, kind and schema tables; display 530
  amount, school, target, source, unused ID and hash tables; spawn 88
  object ID table and all three model string variants including the
  outside-in order.
- **Selector sets** printed for 503, 530, 313, 172 and 309 agree with the
  `[..].includes(...)` lists in the hand-written 16.23 reader wherever they
  were compared by eye (marker time `{0,1,4,6}`, display hash `{1,2,4,7}`,
  display unused ID defaults `{2,7}`, hero stats vector on bit 3 clear).
- **16.22**: all nine role packets probe (743, 1045, 43, 1074, 419, 664,
  393, 979, 952). The unresolved readers are the same three kinds as on
  16.23: the batch length list, the validated spawn byte and the two recap
  struct lists. The 16.22 tables have not been compared with
  `damagePacketFields16_22.js` yet. Output is in
  `.local-research/liveproto/describe-16.22.txt` and `schemas-16.22.json`.

Not verified: any decode of real payloads through a schema. There is no
JavaScript schema decoder yet. That parity test is the next milestone.

## How the generated readers work

This model is what the probe relies on. It held on every packet looked at.

1. `factory(out, packetId)` builds the packet object. Slot 1 of its vtable
   is `deserialize(object, &cursor, end)`.
2. Every deserializer first calls a shared base reader: the owner's object
   ID as a 7-bit variable-length integer through one byte table, stored
   plain at object +0xc. A nonzero low 24 bits flips bit 30.
3. Then a fixed number of selector bytes, checked for presence up front.
4. Then the fields in a fixed order. Each field owns a contiguous window of
   1, 2 or 3 selector bits (windows can straddle bytes). A jump table on the
   window either stores a constant or calls the field's reader.
   - 3-bit scalar: four values are the constants 0, 1, 2, -1 (floats: 0, 1,
     -1, 2) and four read from the wire. Object IDs: two constants (0 and
     0xffffffff), six readers.
   - 2-bit string: one empty default and three readers with *different*
     tables and byte orders.
   - 1-bit: byte vectors (present or empty), optional values, and pure flags
     that store one of two constants and read nothing.
   - Readers under different selector values of one scalar are separate
     functions with identical behavior. The probe merges them by behavior.
5. Scalars are stored re-encoded ("at rest") with a second per-field byte
   substitution, sometimes with the bytes reversed. The plain value still
   passes through the field's memory first: a float accumulates byte by
   byte, an integer is stored whole, then the bytes are rewritten encoded.
   One-byte fields never hold the plain value, but when their wire byte is
   missing the reader re-encodes whatever the field held, which reveals the
   at-rest table. Decoded default constants come out as exactly 0, 1, 2,
   0xff, which confirms the method on every one-byte field seen.
6. Byte vectors and strings: a length integer, then one substituted byte per
   element written plain into a heap block, forward, reversed or outside-in
   (first byte to the front, second to the back, and so on). Strings
   allocate length + 1 and write two terminators first. The length table
   and the content table of one reader can differ.
7. Some readers stop unless a game singleton exists (spawn 88, bit 44).
   `Emulator.revive_null_global` finds the null pointer and points it at a
   block of set flags.

Two findings matter for the design:

- **Plain enum values are stable across builds.** The marker's kind is the
  constant 0 for a champion hit and 1 for a unit hit on 16.23 (selector
  values 7 and 3) and the same constants on 16.22 (selector values 0 and
  3). The hand-written readers compare selector values, which is why they
  needed re-deriving each patch. A schema decoder compares plain values.
- **Object offsets are not stable.** Display fields sit in a different
  order in the 16.22 object than in the 16.23 one. So a field's meaning
  cannot be carried to the next build by wire position, selector bits or
  object offset. See "Semantic binding" below.

## Probe algorithm in short

`Probe.describe()` in `probe.py`:

1. `flag_bytes`: smallest input length at which a selector byte is read.
2. `all_default`: hill-climb over single, double and triple bit flips until
   no field reads from the wire. Progress is the number of selector reads
   before the first wire read, which grows as more leading fields default.
3. `windows`: flip each bit from the all-default state. Bits that start the
   same reader (same progress) or touch overlapping object bytes are one
   field. Silent bits are retried next to a reading neighbor.
4. `field`: run every window value. A value is a default (record the stored
   constant) or a reader. Group readers by behavior on shared random input.
5. `reader`: heap writes mean `blob` (bytes) or `varints` (integer list).
   One wire size means `fixed`. Otherwise `varint`. Fallbacks keep the
   schema usable for skipping: `fixed` with `opaque`, `varint` with `opaque`
   (only continuation bits known), or `unknown`.
6. `rest`: learn the at-rest substitution by encoding chosen plain bytes
   back to the wire, then decode each default constant to its plain value.

`own_writes` isolates one field's writes by trimming what the run shares
with the all-default run. It keeps neighbors on the same bytes, because a
read value can equal the field's default constant.

## Open problems in the probe

Current output for the ten 16.23 role packets has six unresolved readers.
The saved run is `.local-research/liveproto/describe-16.23.txt`.

1. **Batch 314, first field (list of u16 lengths): `unknown`, "No terminal
   byte decodes to zero".** `Probe.varints` takes the element count from
   the heap block size. Start with `trace_packet.py ... 314 --bit 0`. The
   hand-written reader says count and elements share one table with an
   inverted continuation bit, and that a count of zero may be rejected, so
   the count table probably has no terminal zero. Let `varint_table` accept
   a missing zero by using another known terminal digit, or derive the
   count from the number of element writes. The Damage tab cannot work
   without batches, so this one blocks the playing-client side.
2. **Recap 502, two fields: `unknown`.** These are lists of structs (recap
   entries holding detail rows), each with its own selector bytes and
   fields. The probe has no nested mode. Options: recurse with the same
   machinery on the element reader (its object is the heap element), or
   keep Death Recap hand-ported and ship new builds without it at first.
   `decodeDeathRecap` in `damagePacketFields16_23.js` documents the layout.
3. **Turret 921, +0x10 and +0x40: `varint` with `opaque`.** The plain
   value never reaches memory (single encoded write). Skipping works with
   the continuation bits alone, and the scoreboard does not use these
   fields. Optional: recover digits through the failed-read path as
   `fixed_hidden` does.
4. **Spawn 88, +0x70: `fixed` size 1 with `opaque`.** The reader validates
   the byte and rejects most values. Skipping works.
5. **Pure flag fields** only report `stored` constants. Unused so far.
6. **Byte order of the plain value is not normalized.** Some four-byte
   fields hold their plain value big-endian in memory (display amount
   defaults print as `3f800000`, marker time defaults as `0000803f`). Add
   a pass: when the defaults match the big-endian set, reverse `order` and
   the default values so every plain value is little-endian, and record
   `type` as `float` or `int` from which canonical set matched.
7. A field that reads for every selector value raises `ProbeError`. Not
   seen on a role packet.
8. `ownerAction` (618, 693) is sent by the client, so the factory does not
   build it and it cannot be probed. Only its ID and the shared owner field
   are needed. Its ID has to come from a recording.

## Next steps, in order

1. **Fix problem 1 (batch), then 6 (normalization).** Extend
   `checkProbe16_23.mjs` with the batch tables and the recap object ID.
2. **Write `src/core/liveSchema.js`,** a generic decoder: owner, selector
   bytes, then each field by its case (constant or reader kind `fixed`,
   `varint`, `bytes`, `varints`, with `opaque` variants only skipped).
   Reuse `PacketReader`. Unit tests with synthetic schemas.
3. **Parity harness on real payloads.** For each role packet of 16.23 and
   16.22, decode the payloads in `.local-research/liveproto/live-16-23.json`
   and `live-16-22.json` with both the schema decoder and the hand-written
   reader and require equal results and equal byte consumption. Spectator
   forms (hero stats, spawn, display, turret) come from keyframes and
   chunks. This is the acceptance test for the whole approach. Record the
   counts in this file, keep the payloads private.
4. **Semantic binding per role.** A small per-build map from meaning to
   schema field. Most roles bind by type alone: combat has one u16
   integer, one byte vector and one u32 integer. Marker has one float and
   one byte. Hero stats has one byte vector. Roles with several fields of
   one type (display has three object IDs and two floats; recap has three
   damage floats) need a data check that picks the permutation, using the
   existing oracles: `research/teamChunks16_22.mjs` (keyframe plus chunks
   must equal the next keyframe) and `research/teamTakedowns16_22.mjs`.
   Write these as reusable binding checks.
5. **One data file per build.** Proposed `src/core/protocols/<build>.json`
   with `build`, role packet IDs, `secondaryTimestamp`, schemas and
   bindings. `liveProtocol.js` builds the same `fields` API from it
   (`decodeCombatEvent`, `decodeHeroStatVector`, `decodeDamageHeroSpawn`,
   `decodeSpectatorDamageDisplay`, `decodeDamageBatch`, `decodeDeathRecap`,
   `decodeCombatMarker`, `decodeReplication`, `decodeTurret`), with the
   plain-value logic (`damageCombatBody.js`, `heroStats.js`,
   `liveReplication.js`, turret name parsing) shared. Generate the 16.23
   file, prove parity, then decide whether to retire the hand-written 16.23
   module. Keep 16.22 as it is.
6. **Role identification on a new build.** Packet IDs are reshuffled, but a
   role's schema fingerprint (object size, field kinds and widths, default
   sets) and its traffic statistics are stable. Fingerprint the previous
   build's roles, rank candidates in the new build, confirm with a
   recording: hero stats is ten 1,263-byte blocks per keyframe, the marker
   is a six-byte packet owned by champions, replication arrives ten times
   a second. `--list` already gives object sizes for all IDs.
7. **Binary fetch command.** `.local-research/official-builds.py` (ignored,
   needs CDTB) downloads a macOS build by manifest ID. Turn it into a
   tracked tool that takes a patch number, finds the manifest in
   riot-manifests under `LoL/EUW1/macos/lol-game-client/` and saves the
   binary with its `code-metadata.json`. The build string is not inside
   the executable, so take it from that file.
8. **Capture on unsupported builds.** The Damage recorder decodes while it
   records. On an unknown build it must still save `raw-ipv4.pcapng` and
   the game log (the runbook currently says to use a private copy of
   `scripts/record-damage.mjs`). Make that built in, so the owner only has
   to play one game on the new patch.
9. **Rewrite the runbooks** around the new flow and cut the per-patch
   history down to what still guides decisions. Per `AGENTS.md`, tooling
   changes must be reflected in `docs/spectator-patch-upgrade.md`.
10. **Later, optional:** the app could fetch protocol files from the
    repository, so a new patch needs no app release, and a scheduled job
    could watch riot-manifests and open a pull request with the new file.

## Private data on this machine

All ignored by git. Do not commit any of it.

- `.local-research/official-builds/<manifest>-LeagueofLegends`: macOS
  binaries. `5BBF3F70EADF0C91` 16.19.8217343, `66B91DB25E5AD56E`
  16.20.8248524, `B0DE7A4FF23DB6B4` 16.21.8298620, `9E817EA717DA1A6F`
  16.22.8348910, `A4E02DE59267375D` 16.23.8396405.
- `%APPDATA%/league-account-switcher/damage-research/`: about 25 full
  recordings on 16.22 and three on 16.23 (`2026-11-18T17-02-15`,
  `17-17-32`, `22-05-06`), each with `raw-ipv4.pcapng` and the game log.
- `.local-research/damage-sessions/2026-11-18T16-29-02.320Z-a780b3cd/`:
  16.23 keyframes and chunks next to a recording.
- `.local-research/liveproto/`: `live-16-23.json` and `live-16-22.json`
  (all packet types of one recording each, 600 payloads per type, from
  `dumpAllLivePackets.mjs`), the probe output for both builds
  (`schemas-16.2x.json`, `describe-16.2x.txt`), and `scratch/` with the
  exploration scripts of the first session.

Role packet IDs for reference:

| Role | 16.22 | 16.23 |
| --- | ---: | ---: |
| combat | 743 | 172 |
| batch | 1045 | 314 |
| ownerAction (outgoing) | 618 | 693 |
| heroSpawn | 43 | 88 |
| recap | 1074 | 502 |
| recapOwner | 419 | 408 |
| heroStats | 664 | 313 |
| display | 393 | 530 |
| marker | 979 | 503 |
| replication | 952 | 309 |
| turret | not ported | 921 |

## Working notes for the next agent

- Read `CLAUDE.md` and `AGENTS.md` first. Commit as the configured git
  user and add no co-author trailer.
- In the Bash tool here, heredocs that contain an odd number of apostrophes
  fail. Write script files with the file tools instead.
- Python is `.venv-research/Scripts/python.exe`. Run the research scripts
  from the repository root; they import `liveproto` from `research/`.
- `npm test` covers `src/`. Nothing there changed on this branch, so no
  patch note was added. Add one when the app starts using schema files.
- The existing 16.x oracles (`inspect_macos_16_2x.py`,
  `damage_oracle_16_22.py`, `team_live_tables_16_23.py`) still work and
  remain the reference for the hand-ported readers. The new emulator makes
  their per-build address lists unnecessary for new builds.
