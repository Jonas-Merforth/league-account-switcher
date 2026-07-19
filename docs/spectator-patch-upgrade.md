# Spectator decoder patch-upgrade runbook

Use this document when a new League patch drops and the account switcher's
friend score hover reports `unsupported`, or whenever a spectator field,
profile, supported mode, observer request, or research tool changes.

As of this document's last update, the newest verified production profile is
`league-16.14-scoreboard-v3` for `Releases/16.14`.

## Required outcome

A patch is supported only when current-patch keyframes alone reproduce the
delayed spectator scoreboard exactly. Never make an old profile's version
matcher broader just to restore the UI. Until verification finishes, the
correct result is `status: "unsupported"`, not plausible-looking numbers.

The production path must continue to:

- use only observer metadata, last-keyframe information, and the newest
  keyframe;
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
4. `src/core/spectator/patch-16-14-profile.js` is the reference assembly
   profile.
5. `src/core/spectator/patch-16-14-codecs.js` contains the current pure
   JavaScript packet codecs.
6. `research/inspect_keyframes.py` is the offline executable-assisted oracle.
   It is research tooling only and must never be imported by the application.

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

Basic packet inspection:

```powershell
.\.venv-research\Scripts\python.exe research\inspect_keyframes.py `
  'C:\path\to\current-patch.rofl' `
  --exe 'C:\Riot Games\League of Legends\Game\League of Legends.exe' `
  --keyframe 12 `
  --packet 747
```

Repeat player-scoped inspection for packet 129 when inventory research is
needed. The helper can also be imported from a temporary private analysis
script to call `read_rofl`, `read_rofl_stream`, `infer_player_base`,
`LeagueEmulator.packet_profile`, `LeagueEmulator.deserialize_block`,
`decode_hero_snapshot_payload`, and the roster-string helpers directly.

The helper contains patch-local executable RVAs and assumptions, including
allocator hooks, enum/TLS context locations, primitive-reader hooks, mutation
tables, and generated-schema entry points. Its constructor/vtable discovery is
partly dynamic, but the complete helper is not automatically portable. If
emulation fails on the new executable, rediscover and document every changed
RVA instead of forcing the previous address.

## Fast compatibility check

Start by testing the new keyframes against the previous patch's packet
expectations without changing the production version matcher.

Verify separately:

1. Ten contiguous player entities can still be inferred.
2. Every player has one packet 747 with the expected payload shape.
3. Packet 747 decodes and consumes exactly, with canonical team IDs 100/200.
4. Kills, deaths, assists, lane CS, neutral CS, XP, and objective credits still
   occupy the verified semantic positions.
5. Packet 761 recovers exactly ten known champion names in unambiguous
   participant order.
6. Standard Summoner's Rift exposes the expected turret entity set and an
   absolute alive/destroyed state.
7. Packet 129 inventory is tested independently. Its failure must result in
   `capabilities.items: "unavailable"` and must not block the score snapshot.
8. New season mechanics have not changed level caps or cumulative XP
   thresholds for the supported queues.

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
- A packet-747 change blocks KDA, CS, team kills, level, and objectives until
  all affected fields are verified.
- A packet-761 change blocks safe friend-to-participant mapping.
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
- late joining receives the current delayed absolute score without chunks;
- unsupported modes retain ordinary presence with an explanation;
- a deliberately wrong patch version and malformed critical packet both fail
  closed;
- a malformed or missing packet 129 preserves scores but disables all items;
- no raw keyframe, observer key, credentials, full participant list, unmatched
  identity, or item data reaches renderer IPC or logs;
- observer requests remain serialized, finite, and subject to the shared
  60/120/300-second 429 controller.

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
4. Update this runbook if any command, file, dependency, decision point, or
   acceptance rule changed.
5. Add a short friend-readable `PATCH_NOTES.md` entry.

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
