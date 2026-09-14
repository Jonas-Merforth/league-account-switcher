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
- The installed 16.15 executable and one live 16.15 Ranked Solo observer feed,
  sampled at approximately 11, 25, 33, and 40 minutes, plus the identity-free
  post-game result. Raw keyframes and participant identities stayed in ignored
  private research storage.
- One live 16.15 Normal Draft game and three independent live ARAM Mayhem games.
  Mayhem was sampled in early/mid/late state and one game was compared with its
  identity-free post-game result.
- The installed 16.16 executable and ten private live keyframes from two
  Ranked Solo, one Ranked Flex, and three ARAM Mayhem games. Samples covered
  early, middle, and late state; one Mayhem game contained two tracked friends
  and the Flex game contained five. Raw observer data, game IDs, and
  participant identities remained in ignored private storage.
- The installed 16.17 executable and 14 private live keyframes from five
  Ranked Solo, one Ranked Flex, and five ARAM Mayhem games. The corpus spans
  game time zero to 27 minutes on Rift and middle/late Mayhem state. Raw
  observer payloads, game IDs, credentials, and identities remained in ignored
  private storage.
- The installed 16.18 executable and 243 private live keyframes from five
  Ranked Solo, one Ranked Flex, one Normal Draft, and fourteen ARAM Mayhem
  games. The corpus spans early, middle, and late state on both maps, plus
  startup data and game-stream chunks from one live Rift game used only as
  identity ground truth. Raw observer payloads, game IDs, credentials, and
  identities remained in ignored private storage.
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

The live observer consumer `/version` endpoint returned `2.36.0` on 16.14,
`2.45.0` on 16.15, `2.49.0` on 16.16, `2.51.0` on 16.17, and `2.55.0` on
16.18, while
`system.yaml` identified the corresponding `Releases/16.14` through
`Releases/16.18` game branches.
Treating a transport value as the decoder patch made the keyframe correctly
fail closed, but it was the wrong selection input: that endpoint describes the
observer transport protocol.

The account switcher selector prefers a game client version supplied by
observer metadata and otherwise reads the patch branch from `system.yaml` in
the configured League installation. The protocol version is not used as a
patch alias, so a future patch cannot silently reuse an old codec merely
because the observer transport has its own unrelated version.

## Successful findings

### Transport and framing

- Observer keyframes decrypt and inflate without launching the game.
- Live observer metadata advertised 30-second chunks and 60-second keyframes.
  While an on-demand feed warms up, `nextAvailableChunk` is a millisecond
  countdown to the next chunk publication and can schedule lightweight
  last-chunk checks without polling continually.
- `nextChunkId` directly identifies the first chunk after the advertised
  keyframe. `availableSince` gives the latest chunk's age, and each bounded
  `chunkId - nextChunkId` step contributes one additional 30-second interval to
  the keyframe's publication age. Adding that age and the observed 16.14
  150-second spectator buffer to decoded game time reproduced a visible
  `41:41` clock from a `39:00` snapshot. Warm `delayTime` metadata was `0`, so
  it is not a usable source for the spectator buffer.
- Patch 16.15 made the buffer mode-specific. A visible Summoner's Rift clock
  put the old 150-second estimate about 23 seconds behind and aligned with a
  180-second buffer. Three independent Mayhem captures, comparing wall time,
  decoded keyframe time, bounded publication age, and game creation time,
  consistently aligned with a 60-second buffer after normal game-start
  overhead. Production stores these delays on the narrow mode profiles rather
  than inferring them from the observer protocol version.
- A completed live sample had keyframe time `3000.889`, `nextChunkId: 103`, and
  chunk timestamps beginning at `3000.923`, confirming that `nextChunkId` is
  the first chunk at the keyframe boundary. The final `chunkId: 105` began at
  `3060.951`; its 16.744-second duration must cap `availableSince`, which keeps
  increasing after the stream ends.
- A late keyframe is a complete state transfer; historical chunks are not
  needed for the current scoreboard.
- Ten player entities can be inferred as a contiguous entity window.

### 16.18 packet remap and hero packet 387

- The role mapping changed from hero/roster/turret/inventory
  `433/326/786/101` to `387/523/1110/850`. Observer decryption, framing, and
  the ten-player window remained compatible, but every 16.18 frame failed the
  immutable 16.17 profiles.
- Packet 387 uses tag `0xcb` and a table-free rotate/subtract/swap transform.
  Its decoded vector shrank from 1,492 to 1,264 bytes, and its routine at RVA
  `0xEFCE40` writes decoded bytes backwards. Across all 2,430 captured Rift and
  Mayhem hero payloads, the pure vector decoded to valid team IDs and the
  verified semantic offsets without moving.
- The pre-upgrade source of truth was executable emulation: the 1,264-byte
  allocation matched the pure vector byte-for-byte, and a wire-to-vector map
  collected from seven frames contained all 256 byte values with zero
  conflicts.
- Team, XP, KDA, lane/neutral CS, and objective offsets were unchanged from
  16.17. Late Rift frames showed role-consistent CS (supports near 10-40, both
  junglers with 160+ neutral CS) and objective credits on the smiting jungler.

### 16.18 roster packet 523

- Exact client deserialization consumed all observed 847-1,079 byte payloads
  and allocated an eleven-record vector. Three new canonical forward readers
  were recovered from the executable: subtract/table/subtract/table;
  subtract/rotate/table/add/swap/add/NOT; and
  rotate/swap/rotate/XOR/table/rotate.
- The generated record vector is written backwards. A pointer-write trace
  proved the first payload champion (participant 10) lands in the last record
  and the last payload champion (participant 1) lands in the first. Reversing
  the ten scanned hits is required before pairing champions with hero entities.
- Every captured frame yielded exactly ten unique names in payload order, so
  the reversed order was stable. The installed non-localized base WAD set
  matched the 173 exact-case production names.

### 16.18 turret packet 1110

- The same 22 deterministic Rift network IDs and owner teams remain. The
  generated reader at RVA `0xF48E40` reads width-1 fields at bit offsets 13 and
  19; both are zero while standing and one once destroyed, and both agreed in
  every sampled object.
- Totals stayed monotonic across all seven live Rift games, reaching `1/8`,
  `8/4`, `1/2`, `0/0`, `6/3`, `5/4`, and `3/4` for team 100/team 200 in the
  final sampled frames. Recognized payloads were 47-63 bytes, and the
  three-byte header invariant (selector 4 at bits 0-2, `0xf` padding at bits
  20-23) held across all 2,310 of them; zero-filled payloads fail it. No
  same-clock visible scoreboard or post-game result was available; personal
  structure credits were not substituted.

Review correction: packet-1110 length and agreement of the two state fields
were insufficient structural validation. Zero-filled and `0xff`-filled
payloads were rejected by the installed executable but accepted by the initial
pure codec. The production gate now also requires selector 4 at header bits
0-2 and `0xf` padding at bits 20-23. All 1,694 recognized turret payloads in
the review corpus retained these invariants; other header selectors varied.
Synthetic rejection tests cover both fill patterns and individual invariant
mutations, while valid varied headers and both length bounds remain accepted.

### 16.18 inventory packet 850

- The executable consumed sampled player payloads exactly and allocated ten
  152-byte records per player (a 1,520-byte vector), establishing packet 850 as
  the inventory candidate. No other surviving ten-per-player candidate made a
  comparable record allocation.
- Allocation shape and exact consumption still do not prove item IDs, slots,
  default records, or display order. Production leaves the complete 16.18 item
  capability unavailable and does not scan for plausible item IDs.

### 16.18 mode evidence and helper changes

- Five Ranked Solo games supplied 86 keyframes from roughly 5 to 30 minutes,
  one Ranked Flex game supplied 9 keyframes from 18 to 26 minutes, one Normal
  Draft game supplied 10 keyframes from 15 to 24 minutes, and fourteen Mayhem
  games supplied 138 keyframes from early through late game. The pure profiles
  decoded every frame directly; rosters stayed stable per game, team kills
  equalled participant sums, and tracked champions mapped to unique rows.
- A live friend's champion was cross-checked against the independent startup
  packet's participant order: the friend's name was the first participant
  record and the production decode placed the same champion on participant 1,
  team 100. That link, plus the executable pointer-write trace, validates the
  reversed roster pairing and the first-team ordering.
- Mayhem rosters were as short as 847 bytes, so Mayhem keeps the 800-byte
  floor while Rift retains 900. Mayhem packet-1110 objects are not Rift
  turrets, and the mode keeps towers, structures, and objectives unavailable.
- All four supported queues now have direct 16.18 evidence. The Ranked Flex
  and Normal Draft samples passed the same executable hero-vector, roster
  consumption, and turret consumption checks as Ranked Solo, and both wrote
  roster records in descending order, confirming the hit reversal. The
  180/60-second delays and the same-clock/post-game comparisons remain pending.
- Helper constants moved to base-parameter table `0x1BA7970`, allocator/free
  `0x11B9530`/`0x11B9560`, field reader `0xF48E40`, and roster string table
  `0x1B92E90`. Dynamic constructor/vtable/deserializer lookup found packet 387
  at `0xE9ABD0`/`0xF1C560`, packet 523 at `0xE9C900`/`0x10114F0`, packet 1110
  at `0xE95DC0`/`0xF19970`, and packet 850 at `0xEAA2C0`/`0x102FCA0`. The
  helper's pure hero and roster routines were rewritten for the new grammar.

### 16.17 packet remap and hero packet 433

- The role mapping changed from hero/roster/turret/inventory
  `248/827/320/793` to `433/326/786/101`. Observer decryption, framing, and the
  ten-player window remained compatible, but all 14 frames correctly failed
  the immutable 16.16 profiles.
- Packet 433 uses tag `0xda`, a forward vector write, and a new
  swap/rotate/swap/rotate/table/XOR mutation. The table bytes remained equal to
  previous patches; the surrounding transform did not.
- The decoded vector grew from 1,476 to 1,492 bytes by adding 16 trailing
  bytes. Verified team, XP, KDA, lane/neutral CS, and objective offsets stayed
  fixed. Across all 140 player payloads, the pure vector matched the current
  executable allocation byte-for-byte and each input was consumed exactly.
- All decoded frames had canonical five-player teams, team kills equalling
  their participant sums, and plausible cumulative scores. Sequential early
  Rift frames remained monotonic; the separate late frame exercised non-zero
  KDA, CS, level, objectives, and tower state.

### 16.17 roster packet 326

- Exact client deserialization consumed all 14 observed 938-1,146 byte
  payloads and allocated eleven 328-byte outer records.
- Three canonical champion readers were recovered: table/NOT/table/rotate in
  forward order; table/swap/table/swap in forward order; and
  subtract/swap/subtract/XOR in alternating front/back order. Every frame
  yielded exactly ten unambiguous names in participant order.
- Sequential frames can encode the same champion through different canonical
  variants, so a decoder that locked a record slot to one mutation would fail.
  Scanning the exact three readers preserves the generated-schema behavior.
- The installed non-localized base WAD set, excluding `TFTChampion`, matched
  the 173 exact-case production names, including `Zaahen`.

### 16.17 turret packet 786

- The same 22 deterministic Rift network IDs and owner teams remain. The
  generated reader at RVA `0xF37210` consumes bit offset 0, width 1 from the
  retained payload header.
- Direct per-object comparison with the executable's at-rest byte proved the
  field means absolute destroyed state: early frames had 22 zeroes; later
  frames had six or eight set bits with exactly the same number of changed
  object values. One game progressed from `0/0` to `3/5`; another late frame
  reported `2/4` for team 100/team 200.
- All 198 recognized payloads were 47-59 bytes and were consumed exactly. A
  visible same-clock scoreboard and post-game result were not available;
  personal structure credits were not substituted for either.

### 16.17 inventory packet 101

- The executable consumed all 140 player-scoped payloads exactly and allocated
  ten 160-byte records for each one, establishing packet 101 as the inventory
  candidate. Another ten-per-player candidate, packet 300, made no comparable
  record allocation and was rejected for this role.
- Allocation shape and exact consumption still do not prove item IDs, slots,
  default records, or display order. Production leaves the complete 16.17 item
  capability unavailable and does not scan for plausible item IDs.

### 16.17 mode evidence and helper changes

- Five Ranked Solo games supplied eight Rift keyframes from approximately 0 to
  27 minutes. One Ranked Flex game supplied a frame near 7 minutes. Five Mayhem
  games supplied five frames from approximately 8 to 23 minutes. The pure
  production profiles decoded every frame directly.
- Mayhem again omitted the standard turret set and publishes only player
  scores plus team kills. Its observed rosters fit the same 900-byte floor as
  Rift in this patch. Items and inhibitors remain unavailable in both modes.
- The 2026-08-29 Flex frame retained the complete Rift grammar, decoded all ten
  players, kept all 22 canonical turret objects, and mapped the tracked friend uniquely.
  The current executable consumed its hero, roster, turret, and inventory
  candidate inputs exactly; no Flex-specific adaptation was needed. Direct
  16.17 Normal Draft, same-clock visible, and post-game evidence remains
  unavailable. Queue 400 stays behind the same complete Rift grammar. The prior
  180-second Rift and 60-second Mayhem delays remain explicit assumptions.
- Helper constants moved to base-parameter table `0x1B671C0`, allocator/free
  `0x119BAB0`/`0x119BAE0`, field reader `0xF37210`, hero table `0x1B46660`,
  and hero routine `0xEEF590`. Dynamic constructor/vtable/deserializer lookup
  found packet 433 at `0xF0E7C0`, packet 326 at `0xFF6310`, packet 786 at
  `0xF0BBD0`, and packet 101 at `0x10132D0`.

### 16.16 packet remap and hero packet 248

- Observer decryption, inflation, block framing, player-window inference, and
  the 1,476-byte decoded stat vector remained compatible. The critical role
  mapping changed from hero/roster/turret/inventory `670/315/298/370` to
  `248/827/320/793`.
- Every captured 16.16 frame correctly failed the immutable 16.15 profiles.
  Production received new `^16.16` profiles rather than widened old matchers
  or a generic packet-number remapper.
- Packet 248 uses field tag `0x0d` and a new
  subtract/swap/table/rotate/table/subtract/table byte mutation. Its mutation
  table bytes stayed equal to prior patches, demonstrating again that table
  equality does not establish transform compatibility.
- The current client allocated exactly 1,476 bytes and consumed tested
  1,479-byte payloads exactly. The pure codec recovered canonical team IDs,
  XP, KDA, lane/neutral CS, and objective credits at the unchanged semantic
  offsets from all eight frames. Sequential participant counters were
  monotonic and team kills exactly equalled the five participant sums.

### 16.16 roster packet 827

- Exact client deserialization allocated eleven outer records and consumed
  complete observed payloads of 1,017, 1,036, and 1,050 bytes.
- Three new canonical first-champion string readers were recovered. All write
  alternating front/back output; scanning only those fields yielded exactly
  ten known names in sequential participant order with no ambiguity.
- The installed base WAD set again matched the 173-name exact-case allowlist.
  Locale and mode-specific copies were excluded.
- Tracked champion IDs mapped uniquely in both supported modes. One Mayhem
  game had two tracked friends, and both mapped to distinct roster slots in
  the same shared game monitor.

### 16.16 turret packet 320

- The same 22 deterministic Summoner's Rift turret IDs and owner teams remain.
  The generated absolute alive field remains header bit offset 16, width 1;
  the surrounding header bytes changed and are checked by the new codec.
- Observed recognized payloads were 47-59 bytes and were consumed exactly by
  the generated client deserializer. Two sequential Ranked Solo snapshots
  moved monotonically from `4/2` to `6/7` towers for team 100/team 200.
- No 16.16 same-clock visible scoreboard or post-game result was available.
  These remain validation gaps; personal turret credits and presence time were
  not used as replacement evidence.

### 16.16 inventory packet 793

- Exact generated deserialization consumed each sampled input and allocated
  ten 168-byte records, establishing packet 793 as the inventory candidate.
- Record allocation does not prove item IDs, slots, default-state fields, or
  display ordering. The 16.16 profiles leave the whole item capability
  unavailable and do not fall back to ID scanning.

### 16.16 mode evidence and helper changes

- Two Ranked Solo, one Ranked Flex, and three ARAM Mayhem games supplied ten
  usable keyframes. Ranked Solo frames included two sequential snapshots whose
  participant, objective, and turret counters remained monotonic. Mayhem
  samples covered early, middle, and late state and consistently omitted
  Rift-only structures and objectives.
- Two sequential late-game Flex snapshots decoded all ten participant rows
  without changing the production profile. Team kills advanced from `38/52`
  to `41/57` and towers from `7/6` to `8/6`; every participant's cumulative
  KDA, CS, and level remained monotonic. Five tracked friends each mapped
  uniquely to a different participant slot. The current executable exactly
  consumed representative packet 248, 827, 320, and 793 inputs including their
  routing prefixes; the roster payload was 1,046 bytes and the complete
  profile still required all 22 turret objects.
- The Mayhem roster still needs the separate 800-byte floor; Summoner's Rift
  retains 900 bytes. The profiles retain the prior 180-second Rift and
  60-second Mayhem delay values, but a fresh same-clock 16.16 comparison is
  pending. Presence timestamps were inspected only to reject them as timing
  proof.
- A current-patch Normal Draft, post-game, and visible same-clock sample was
  not available. Queue 400 remains gated by the same exact Summoner's Rift
  profile; this evidence gap is not presented as a direct sample.
- Patch-local helper RVAs changed: base-parameter table `0x1B375C0`,
  allocator/free `0x11999B0`/`0x11999E0`, field reader `0xF31B30`, hero table
  `0x1B16C70`, and hero routine `0xEEC9E0`. Dynamic discovery located packet
  248/827/320/793 constructors and deserializers; the pure helper now mirrors
  the recovered packet-248 and packet-827 mutations.

### 16.15 packet remap and hero packet 670

- Transport decryption, gzip inflation, block framing, and inference of ten
  contiguous player entities remained compatible.
- The 16.14 profile correctly rejected the live frame because its critical
  packet IDs were absent. The 16.15 scoreboard mappings are hero 670, roster
  315, turret 298, and inventory 370; broad packet-number remapping was not
  added to production.
- Packet 670 still decodes to a 1,476-byte hero-stat vector. Tag `0xaf` and its
  new swap/XOR/table/rotate mutation replaced packet 747's `0xe8` transform,
  while the semantic team, XP, KDA, CS, and objective offsets stayed stable.
- The current executable deserializer consumed tested packet-670 inputs
  exactly. The pure production codec decoded all ten rows at four live
  timestamps; every cumulative XP/CS/objective value and KDA transition stayed
  internally valid, and team kills equalled the five participant sums.
- The final published keyframe was 108 seconds before match end. All ten
  champion/team/participant mappings matched Riot's post-game result; every
  decoded KDA and CS counter was equal to or below its final value, and the
  last keyframe's dragon, Baron, and Rift Herald totals matched the final team
  totals. This is a monotonic post-game check, not a same-clock substitution.

### 16.15 roster packet 315

- Exact client deserialization produced ten champion records plus vector
  capacity. Three canonical string readers recovered exactly ten internal
  names in sequential participant order 1 through 10.
- Three redundant record fields can also decode champion names, but including
  them produces duplicate hits. Production scans only the canonical reverse-B,
  reverse-C, and alternating-F readers and requires exactly ten rows.
- The installed base champion WAD set and codec allowlist both contain the same
  173 exact-case names. Locale and mode-specific assets were excluded.

### 16.15 turret packet 298

- The same 22 deterministic Summoner's Rift turret IDs remain present.
- The absolute alive state moved to generated-header bit offset 16, width 1.
  Four live keyframes moved monotonically through 0, 8, 10, and 13 dead turret
  objects, producing ownership totals 0/0, 2/6, 3/7, and 6/7. The post-game
  total 108 seconds later was 8/10, consistent with additional late structures.
- A same-clock visible spectator comparison is still pending. Queue-400 Normal
  Draft reproduced the same complete turret set; queue-440 Flex shares the
  strict Summoner's Rift profile but still lacks a direct 16.15 sample. Other
  Summoner's Rift queues remain excluded.

### 16.15 inventory packet 370

- The old packet-129 parser rejects packet 370's changed vector header, as it
  should. The current executable deserializer consumed all tested payloads
  exactly and allocated a ten-record vector.
- Exact consumption identifies the packet's structural role but does not prove
  the new item/slot semantics. Production deliberately leaves items unavailable
  and does not fall back to raw item-ID scanning.

### 16.15 Normal Draft and Ranked Flex

- A live queue-400 Normal Draft keyframe had the same packet-670 hero grammar,
  sequential packet-315 roster, 22 recognized packet-298 Summoner's Rift
  turrets, and packet-370 inventory boundary as Ranked Solo.
- The tracked friend's champion mapped uniquely and all ten participant rows,
  team kills, objectives, and turret state decoded without relaxing structural
  validation.
- Queue 440 Ranked Flex shares this strict Summoner's Rift profile and its
  role-quest level rules. No active 16.15 Flex friend or replay was available
  during this run, so a direct current-patch Flex regression remains pending.

### 16.15 ARAM Mayhem

- Three independent queue-2400/`KIWI` games retained the packet-670 hero vector
  and packet-315 sequential participant mapping. Each tracked friend's champion
  mapped uniquely.
- Mayhem roster payloads included 889 and 1,023 bytes. The old 900-byte
  Summoner's Rift lower bound rejected the shorter valid sample; the separate
  mode profile uses a conservative 800-byte floor plus the exact ten-row
  semantic check. Executable deserialization consumed both payloads including
  their routing prefix.
- Mayhem has ten packet-298 map objects but none of the 22 deterministic
  Summoner's Rift turret IDs. Tower and neutral-objective capabilities are
  unavailable; only absolute player scores and team kills are published.
- In a completed sample, the last keyframe was about 39 seconds before match
  end. All ten champion/team mappings matched Riot's final result and every
  KDA, CS, and XP-derived level was equal to or below the final counter.

### Historical 16.14 packet 747

- The generated deserializer and its mutation table were reproduced in pure
  JavaScript.
- The 1,476-byte decoded vector is the current hero-stat registry snapshot.
- Team, XP, KDA, lane/neutral CS, player-credited structures, gold
  earned/spent, and neutral objective credits have stable registry offsets.
- XP-derived levels match current state. The direct `LEVEL` registry slot does
  not.

### Historical 16.14 packet 761

- Three string-reader mutations recover exactly ten internal champion names.
- The non-linear vector wire order was reconstructed as
  `1,2,10,3,9,4,8,5,7,6`.
- A live 16.14 Ranked Solo keyframe exposed `FiddleSticks`, while the original
  allowlist used display-style `Fiddlesticks`. The case-sensitive miss reduced
  the roster to nine recognized rows and correctly failed the full profile.
  Comparing all 173 allowlist entries with the installed 16.14 base champion
  WAD names found no other mismatch. `Ruby_*`, `Strawberry_*`, and
  `TFTChampion` archives are mode-specific assets, not missing standard roster
  aliases.

### Historical 16.14 packet 129 offline oracle

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

### Historical 16.14 packet 815 turret state

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

### Presence timestamp as the live game clock

Riot friend presence timestamps describe when an individual client entered its
loading or in-game presence state, not the match's `0:00` clock. Two friends in
one sampled game differed by 11.403 seconds, and one visible comparison put the
presence-derived estimate 88 seconds ahead of the actual game clock. Production
therefore anchors the approximate live clock to keyframe and observer timing;
presence time remains useful only for the ordinary friend-card duration.

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

### Reusing 16.14 critical packet IDs on 16.15

The 16.15 keyframe did not contain the required packet-747/761/815 set. Widening
the 16.14 version matcher would therefore either remain unsupported or invite
plausible false matches against unrelated remapped packets. The old profile was
left immutable and a separate narrowly matched 16.15 profile was created.

### Reusing 16.15 critical packet IDs or transforms on 16.16

The 16.16 frames lacked the required packet-670/315/298/370 role set, and
packet 248 rejected packet 670's tag and mutation. The packet-315 roster
readers produced no authoritative ten-row roster from packet 827. Widening the
16.15 matcher, accepting matching payload lengths, or reusing the unchanged
mutation table without tracing the surrounding transform would not establish
compatibility. A separate fail-closed 16.16 profile was required.

### Reusing 16.16 critical packet IDs or transforms on 16.17

The current frames lacked the required packet-248/827/320/793 role set.
Packet 433 also changed tag, decoded length, byte mutation, and output order;
the packet-827 readers did not recover the packet-326 roster. Widening the
16.16 version matcher, treating the unchanged mutation table as compatibility,
or selecting roles from ten-per-player counts would have been unverified. A
separate fail-closed 16.17 profile was required.

### Reusing 16.17 critical packet IDs or transforms on 16.18

The 16.18 frames lacked the required packet-433/326/786/101 role set. Packet
387 changed tag, decoded length, output order, and used a table-free transform;
the packet-326 readers did not recover the packet-523 roster. Packet 300 had no
16.18 occurrences. Widening the 16.17 matcher or reusing old transforms would
have produced unsupported rows. A separate fail-closed 16.18 profile was
required.

### Pairing 16.18 rosters by payload index

The three roster readers recover names in payload order, but the generated
record vector is written backwards. Pairing payload hit `i` with hero entity
`i` attaches every champion to the opposite team's same-role player. A
pointer-write trace and an independent startup packet both proved the reversal;
the production decoder now reverses hits into participant order first.

## Next research targets

1. Add direct 16.18 Normal Draft and Ranked Flex samples, plus a same-clock
   visible spectator and post-game comparison. Recheck the retained
   180/60-second mode delays at the same time.
2. Recover packet 850's complete item/slot grammar and validate it independently
   before enabling the 16.18 optional inventory capability. Packets 101, 793,
   and 370 remain the equivalent historical 16.17, 16.16, and 16.15 gaps.
3. Locate the cumulative inhibitor destruction total. Packet-1227 controller
   state alone cannot distinguish a respawned inhibitor destroyed twice.
4. Validate `GOLD_EARNED` team sums against the delayed spectator top bar
   before deciding whether to expose team gold.

Every new field must be decoded from keyframe bytes alone, agree at multiple
timestamps and modes, and fail closed on a patch mismatch.
