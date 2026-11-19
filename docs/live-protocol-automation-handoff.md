# Porting the live protocol

The Damage tab and friend scoreboard use a generated layout profile for
16.23.839.6405. The app reads the bundled JSON with ordinary JavaScript.
Unicorn and the game executable are needed only when preparing a profile.
16.22 still uses its original runtime decoder and has a build recipe for
cross-patch regression checks.

Riot changed the packet IDs, selector values, field order, byte substitutions
and some object offsets between these builds. Decoded combat bodies, stat
vectors, marker kinds and turret names retained their meanings in the games
checked. A new build needs an exact profile and a recording to verify it.

## Check a hotfix first

A maintenance build can reuse the existing profile. On 16.23.839.9929,
all 1,094 packet factory IDs and object sizes, the owner table, recap
companion and all 11 generated layouts matched 16.23.839.6405. Three
playing-client recordings yielded 84,600 comparable role packets with zero
differences from the hand-written reference. Each game had one local owner
across its actions, and all 32 Death Recaps had a matching update within
2 ms. The 45-frame spectator regression corpus predates the hotfix.

1. Fetch the hotfix by its exact log build. Compare its official metadata
   and binary with the current recipe, shipped profile and base binary.
   The comparison rebuilds the nested and top-level layouts. A changed
   layout or packet inventory sends the port through the full workflow below.

   ~~~powershell
   $py = '.venv-research/Scripts/python.exe'
   & $py research/check_live_hotfix.py <recipe> <shipped-profile> <base-binary> <hotfix-binary> <hotfix-code-metadata.json> <exact-log-build> --candidate <private-candidate.json>
   ~~~

2. Create a timed packet dump from a game with a death. Use the exact
   candidate from step 1 so the offline tool can expand its batches before
   the app supports the hotfix. Rerun the same comparison with
   `--dump <dump.json>` for each capture to verify the outgoing action
   and the local Death Recap companion. Use a sufficient sample cap to
   include the matching owner updates. Check available same-build observer
   data with the replay and scoreboard commands below.

   ~~~powershell
   node research/dumpAllLivePackets.mjs <hotfix-recording> <dump.json> 20000 <private-candidate.json>
   ~~~

3. Add the confirmed build and printed SHA-256 to `hotfixes` in the base
   recipe, then regenerate the shipped profile from the **base** binary.
   This adds an exact alias. Both the four-part log version and its compact
   spelling resolve to one profile, preserving unambiguous patch-only
   observer lookup. Unlisted neighboring builds stay unsupported.

## Port a new build

Run these commands from the repository root. Keep binaries, replays, packet
dumps and candidate profiles in ignored storage until validation finishes.

1. Get the full build from the game log. Use **Damage → Start tracking** to
   record from loading through the results screen. On an unsupported build
   the recorder keeps raw packets, timing observations and the original log.
   A `.rofl` of the same build supplies scoreboard and chunk evidence.
   Include a player death and at least one Rift game with destroyed towers
   for roles that depend on them.
2. Fetch the matching binary and metadata. Use the research Python with
   `research/requirements.txt`. The fetch command additionally uses CDTB
   1.3.0. It resolves the full version in riot-manifests, checks the
   metadata version and prints the SHA-256 of the extracted executable.

   ~~~powershell
   $py = '.venv-research/Scripts/python.exe'
   & $py -m pip install cdtb==1.3.0
   & $py research/fetch_live_build.py <four-part-build>
   ~~~

3. Copy the previous recipe in `research/liveproto/builds/` to a new file.
   Set the full log build and binary hash. Identify role IDs using
   recording traffic in both directions and native factory object sizes.
   Supply the prior build's recipe, binary and packet dump as the reference.
   A recording of an unknown patch first yields only top-level packets. If
   a role is missing, confirm the batch ID first. Run the generator with
   `--batch-only` to create an offline reader using only the new build, hash
   and batch ID. Pass that JSON after the sample cap to expand inner packets
   into a fresh dump, then rerun the ranking.

   ~~~powershell
   node research/dumpAllLivePackets.mjs <recording-dir> <new-dump.json> 600
   & $py research/rank_live_roles.py <old-recipe> <old-binary> <old-dump> <new-binary> <new-dump>
   & $py research/describe_packets.py <new-binary> <candidate-ids> --recap <recap-id> --json <raw-layouts.json>
   ~~~

   The ranking prints six candidates per role. After identifying the recap and
   player action, rerun the ranking with `--recap ID --action ID` on a timed
   dump. It checks which local-owner packets arrive within 2 ms of deaths.
   Several packets can satisfy this condition. Confirm the companion across
   deaths and check false pairings. For the initial Rift turret ID, look for
   a repeated set of 24 objects on a Rift keyframe.

4. Set the observer framing flag from the actual block boundaries. Set
   `modes` for the scoreboard configurations being carried forward.
   The generator recovers byte tables, selectors, list orders and nested
   recap records. Unique field types bind automatically. With `--replay`
   it tries the possible spawn strings and damage-display fields. The roster
   must match the replay's ten champion names. Targets, sources, amounts
   and schools must reproduce the next keyframe's champion damage and damage
   taken, including all three schools. Ambiguous or contradictory answers
   stop generation. Remove the old `heroSpawn.model` and four `display`
   offsets from a fresh recipe before running inference. Record the printed
   offsets in the new recipe to reproduce it without the replay and to run
   the native scoreboard check.

   ~~~powershell
   & $py research/build_live_profile.py <new-binary> <new-recipe> <candidate.json> --replay <full.rofl>
   ~~~

   The remaining manual bindings are Death Recap duration and the three
   damage schools, plus Rift tower name, state flag and counters. Recipe
   offsets are decimal. The descriptive probe prints hex offsets and labels
   the nested entry and detail records. Check recap amounts against isolated
   damage and the game's recap, including per-detail rounding. Compare
   standing and destroyed copies of the same named turret position. The two
   time fields must be present together on a destroyed turret and the trailing
   counter must be default zero. A fixed-width spawn byte with no recovered
   meaning is skipped. Unknown-width fields and unresolved required bindings
   stop generation.

5. Validate the candidate before registering it. Replay reconciliation checks
   adjacent keyframes and each player's final damage totals. The native
   scoreboard check reads the actual game objects for every hero vector,
   model/ID join and Rift turret. Give it a corpus of
   `<game>/manifest.json` and expanded `keyframe-*.bin` files. Manifests
   provide build and queue. The report counts frames with patch-only version
   evidence separately. Continue the user-visible comparisons described in
   the spectator and damage upgrade guides.

   ~~~powershell
   node research/teamChunks16_22.mjs --profile <candidate.json> <full.rofl>
   node research/verifyLivePatch.mjs $py --profile <new-recipe> <candidate.json> <new-binary> <keyframe-corpus>
   ~~~

6. Add the validated JSON under `src/core/protocols/`, import it in
   `src/core/liveProtocol.js`, and append `protocolFromProfile(profile)` to
   `liveProtocols`. Keep previous entries. Run the paired takedown check on
   a recording with timing observations and its matching replay, then the test
   suite. The profile ships in the app release.

   ~~~powershell
   node research/teamTakedowns16_22.mjs <finished-recording-directory>
   npm test
   ~~~

## Reproduce the baseline

The two checked recipes are `research/liveproto/builds/16.22.json` and
`16.23.json`. For these builds there are independent hand-written reference
readers. Run `node research/checkLiveProfile.mjs <generated-profile> <dump> <replay.rofl>`.
It compares returned values, nulls and rejections. Successful full reads
check packet boundaries. A late-start client dump can be missing initial
hero spawns or stat packets. The parity check reports that missing coverage.

| Evidence | Result |
| --- | --- |
| Fetch and generate | Fresh 16.23 download matched the pinned SHA-256. Generation with replay inference took about 28 seconds on 16.23 and 24 seconds on 16.22. On 16.23 it reproduced the bundled JSON byte for byte. |
| Cross-patch bindings | Each replay selected one champion-model field and one assignment of the four display fields. Both matched the hand ports despite different object offsets. |
| Client parity | On 16.23 one full capture agreed for 3,051 batches, 4,814 combat envelopes, 9,612 replication packets, 9,070 markers, 1,530 displays, 11 recaps, ten spawns and ten stat snapshots. On 16.22 all 3,026 sampled role packets agreed, including six recaps. |
| Observer replay parity | On 16.23 all 13,462 damage rows and 150 each of hero spawns and stat snapshots agreed with the reference. On 16.22 the corresponding counts were 19,018 and 190 each. |
| Replay reconciliation | All 140 hero comparisons per damage metric on 16.23 and all 180 on 16.22 agreed within 0.5 damage, including the school breakdown. Final champion damage and damage taken matched all ten players on each replay. |
| Native scoreboard | 45 keyframes from 13 games, 450 hero vectors, 352 destructible Rift tower records. The pinned oracle and the address-independent oracle both agreed with the generated decoder. Queues 420, 440 and 2400 were represented. Thirty frames had patch-only manifest versions. |
| Takedowns | 271 of 271 records matched the same game's replay, including 75 final hits and 196 assists. |

Generation times exclude field identification, downloading inputs and final
validation. Direct Normal Draft evidence and fresh same-clock on-screen delay
comparisons remain open. The next previously unseen patch will test how well
the ranking and native reader shapes generalize.

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
  object offset. The port workflow above verifies the ambiguous bindings on data.

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

## Private data on this machine

All ignored by git. Do not commit any of it.

- `.local-research/official-builds/<manifest>-LeagueofLegends`: macOS
  binaries. `5BBF3F70EADF0C91` 16.19.8217343, `66B91DB25E5AD56E`
  16.20.8248524, `B0DE7A4FF23DB6B4` 16.21.8298620, `9E817EA717DA1A6F`
  16.22.8348910, `A4E02DE59267375D` 16.23.8396405 and
  `2D3C7F43F632F9D1` 16.23.8399929. The matching code metadata is beside each binary used for the hotfix check.
- `%APPDATA%/league-account-switcher/damage-research/`: about 25 full
  recordings on 16.22 and three on the original 16.23 build (`2026-11-18T17-02-15`,
  `17-17-32`, `22-05-06`), each with `raw-ipv4.pcapng` and the game log.
- `.local-research/damage-sessions/2026-11-18T16-29-02.320Z-a780b3cd/`:
  16.23 keyframes and chunks next to a recording.
- `.local-research/liveproto/`: `live-16-23.json` and `live-16-22.json`
  (all packet types of one recording each, 600 payloads per type, from
  `dumpAllLivePackets.mjs`), the probe output for both builds
  (`schemas-16.2x.json`, `describe-16.2x.txt`), and `scratch/` with the
  exploration scripts of the first session. The three expanded hotfix
  inventories are `hotfix-19-21-54.json`, `hotfix-22-19-37.json` and
  `hotfix-22-39-13.json` in the same directory.
- `H:/Git/league-live-features/.local-research/16.23` holds the 13-game
  scoreboard corpus used by both native checks. The full 16.23 client
  parity dump is `.local-research/liveproto/full-start-23.json`. Final
  raw schemas including nested recap records are in `final-raw-23.json`
  in that directory. The full replay files are in the player's Documents
  directory under `League of Legends/Replays`.

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
