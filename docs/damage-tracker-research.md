# Standalone damage tracker: feasibility and next experiment

Research date: 2026-11-08. Branch: `damage-tracker`, created and checked out from
local `main` at `04549170a9866eb7cedccadf45c98f8c60592cea`.

For future League patches, use the [patch-upgrade guide](damage-tracker-patch-upgrade.md).

## Result

The Damage preview now streams Windows IP-layer recordings into a standalone
JavaScript decoder and shows the tracked game, last 30 seconds, and latest fight.
It uses the local player's network ID from outgoing action packets and labels
the preview as all observed targets. General target classification still needs
the opening of a controlled match. The surrender branch provided the first
recorder and transport decoder.

The user selected a standalone implementation, automatic fight splitting after
a configurable damage-free interval, and a rolling last-30-seconds view.

## Sources investigated

| Source | What the evidence supports | What it does not establish |
| --- | --- | --- |
| Riot Live Client Data API | Game time, roster, local champion stats, scores and game events | A documented outgoing damage event stream, damage totals, or death-recap endpoint |
| Running League launcher API (LCU) | End-of-game statistics and match-history/timeline functions exist | A live combat log; enumerating API names cannot rule out every undocumented source |
| Overwolf GEP | Documents live total/champion damage counters and physical, magic and true damage events | A standalone interface for this Electron app, an exact neutral-only split, or per-ability attribution |
| Public replay packet research | Damage records with time, attacker, target and amount have been extracted | Compatibility with the installed build, delivery to a playing client, or complete live team coverage |
| Old LiveEvents API | Historical spectator/replay `OnDamage` events | A current playing-client solution; the author reports removal/disablement in patch 14.1 |
| Death recap | Riot added the player's outgoing fight contribution in patch 25.17 | A continuous full-game feed, or public access to the underlying data |

Primary references:

- [Riot Game Client / Live Client API](https://developer.riotgames.com/docs/lol#game-client-api).
- [Overwolf League game events, damage section](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/#damage).
- [Henry Zhu's replay decoding research](https://maknee.github.io/blog/2025/League-Data-Scraping/).
- [Published replay packet definitions](https://huggingface.co/datasets/maknee/league-of-legends-decoded-replay-packets/blob/main/packets.py):
  `UnitApplyDamage` has timestamp, source/target IDs and amount; this published
  definition does not include a damage school or ability identifier.
- [SkinSpotlights LiveEvents documentation](https://github.com/SkinSpotlights/LiveEventsDocumentation).
- [Riot patch 25.17: death recap changes](https://www.leagueoflegends.com/en-us/news/game-updates/patch-25-17-notes/).

No maintained standalone live meter meeting the entire request was verified in
this search. [TutorLoL](https://github.com/LuizGomes56/tutorlolv2) calculates
potential ability/item/rune damage; that is different data from recording actual
hits. [Open League Overlay](https://github.com/bossNilac/Open-League-Overlay)
documents a Live Client API scoreboard and postgame reports, not the requested
combat-event meter. Overwolf is useful evidence that richer damage telemetry has
been exposed, but is excluded from the proposed implementation by user choice.

Historical [LeagueSandbox packet emission code](https://github.com/LeagueSandbox/GameServer/blob/indev/GameServerLib/Packets/PacketNotifier.cs)
constructs `UnitApplyDamage` with damage amount, source/target IDs, damage type
and result type. It is an archived server reimplementation, not evidence of
today's packet layout or server routing. Never reuse its packet IDs as current.

## Local checks

Read-only checks on 2026-11-08:

- Installed `Game/League of Legends.exe` file/product version:
  **16.22.834.8910**.
- LCU `/lol-gameflow/v1/gameflow-phase`: **Lobby**.
- Game API port 2999 was unavailable; no live game was observed. The current
  game client's OpenAPI schema and combat payloads were therefore not inspected.
- LCU `/help` returned **1,453 function names**. Name searches found no live
  damage/death-recap function or event; damage-named functions concerned TFT
  cosmetics. End-of-game stats and match-history/timeline getters were present.
- The attempted LCU Swagger paths returned no schema; `/help` supplied the
  inventory. This LCU probe is separate from the game client's port-2999 API.
- No match was started, game configuration changed, packet capture enabled,
  running-game memory read, or third-party runtime installed.

No credentials, session keys, account names or raw traffic are included here.

## What can be reused from the FF branch

Inspected `ff-detecting` at `9259a4fd64f7c2f618209475c4658fbc3290ddbe` using
`git show` and `git grep`, without merging it into this branch:

- `src/core/ffPacketCapture.js` and `ffPacketCapture.ps1`: scoped PktMon capture,
  helper lifecycle and game socket discovery.
- `research/ff_live_16_20.py`: PCAPNG reading, session material from the original
  local game log, decryption, checksums, message framing, decompression, fragment
  reassembly, per-socket separation and approximate alignment with game time.
- `research/ff_oracle_16_20.py` and `ff_oracle_16_21.py`: exact-build hashes and
  bounded offline execution of matching macOS deserializers/consumers.
- `research/test_ff_live_16_20.py` and `test_ff_live_16_21.py`: malformed input,
  transport, fragment and multi-socket regression patterns.
- `docs/ff-16-21-progress-2026-10-23.md`: the latest validation distinction.
  16.20 has real playing-client evidence; 16.21 has synthetic and replay evidence
  and still awaits a playing-client capture. Neither profile supports 16.22.

The latest FF notes supersede an older statement that replay copy counts proved
opponent delivery/routing. Replay evidence cannot establish what a playing
client receives. This distinction also matters for team-wide damage.

The PktMon helper converts ETL to PCAPNG **after capture stops**. It is suitable
for initial experiments but not a ready-to-use live damage feed. A streaming
capture reader is a separate implementation task. Repeatedly restarting capture
would introduce gaps. Existing socket discovery/restarts and incomplete-fragment
coverage also prevent assuming that captured totals are complete.

The `spectator-stats` branch at `6316eeb35d18f62d6c4e949f5133bfa907418bbb`
has useful roster/keyframe/profile work, but a targeted search found no existing
damage decoder. Spectator data is a separate, potentially delayed source and
does not prove live player-view coverage.

## Proposed behavior once the source is validated

- Opening the Damage tab enables tracking. It continues when changing tabs until
  explicitly stopped or the match ends, so tab changes do not create silent gaps.
  This continuation behavior is a proposed default, not a confirmed preference.
- Views: recorded game total, current/last fight, selectable earlier fights and
  rolling 30 seconds. Use a proposed default of five seconds without qualifying
  outgoing damage to close a fight; make that threshold configurable.
- Separate champion and neutral-monster damage, plus their combined total.
  Neutrals include jungle monsters and epic monsters; exclude lane minions,
  structures and pets from this category. Unknown target classes stay unknown.
- Start with the local player's actual damage. Add physical/magic/true breakdowns
  only when their semantics are verified. Ability, attack, item, rune and pet
  ownership breakdowns require additional attribution evidence.
- Label unsupported breakdowns as unavailable. Do not assign an overlapping burn,
  proc or attack to the most recently cast spell based only on timing.
- Distinguish damage amount from DPS. Rolling DPS uses the window's observed
  duration (30 seconds once full); fight DPS uses elapsed fight time from first
  to last damage, excluding the idle closing timeout. A zero-duration fight shows
  damage and an unavailable DPS value. Mark startup windows shorter than 30 seconds.
- Starting mid-match shows "since tracking began" rather than "entire game".
  Full-game reporting requires capture from game start or verified cumulative
  counters. Any disconnect/capture gap marks the affected totals incomplete.
- Team/all-player views remain optional. A local player stream may omit remote
  combat. Only label complete totals when delivery and coverage are verified;
  otherwise explicitly show observed damage. A replay-based all-player report
  can be a later, separately labelled feature.

Subtracting champion damage from total damage does not isolate neutrals: minions
and structures can contribute too. Health differences are also insufficient:
heals, shields, regeneration and multiple attackers confound attribution.

## Concrete next experiment and acceptance criteria

1. Obtain/identify the official macOS artifact matching installed Windows 16.22,
   pin its hash and port the FF transport validation before accepting its packets.
   Validate on an old supported capture first where useful, but retain the build
   restriction. Do not treat 16.21 offsets or packet IDs as 16.22 compatible.
2. Trace the matching damage packet factory, exact deserializer and client consumer;
   investigate damage counters and the newer death-recap contribution messages as
   independent candidates. Fully consumed bytes alone do not prove field meaning.
3. Record a controlled Practice Tool/custom session with the matching original
   game log, packet capture and independent visible damage/timing evidence.
   Include isolated autos and spells, physical/magic/true damage, neutral targets,
   minions/structures as exclusions, shields, overkill, DoTs and simultaneous procs.
4. Prove attacker, target, amount and timestamp first; then target classification,
   damage school and source attribution. Verify whether amounts count shield
   absorption/overkill and how pet damage is credited. Compare aggregate results
   against appropriate postgame stats without assuming identical definitions.
5. Test retransmission deduplication using transport/message identity, legitimate
   equal hits, reordering, gaps, reconnects and unsupported builds. Never dedupe
   solely by equal damage amount/time. Repeat in the intended normal game mode.
6. Only after these checks, connect a streaming reader to an event accumulator and
   the Electron tab. Unit-test interval boundaries and attribution; measure live
   latency/CPU and verify shutdown. Preserve explicit unavailable/incomplete states.

This remains evidence work, not a claim that live damage tracking works. The tab
is currently a clearly labelled validation preview. Opening it never silently
starts elevated capture; the user explicitly starts a test recording. Automatic
live tracking on tab selection will follow only after source validation.

## Implementation checkpoint (2026-11-08)

- Reused `ff-detecting`'s scoped Windows PktMon helper, PCAPNG reader and offline
  transport primitives. Existing PktMon sessions/filters are left untouched.
  The helper uses the same global mutex as FF research, so both cannot capture
  simultaneously. Capture stops on game exit, explicit stop, missing heartbeat,
  or its two-hour limit. Circular capture can overwrite early packets at 2 GB
  per segment; socket changes introduce gaps. Neither case proves full coverage.
- `src/core/damageRecorder.js` records API request timing and allowlisted roster
  snapshots, then preserves the matching original r3d log locally. Snapshots are
  timing/reference data, never damage estimates. Start before launching the game
  so the recorder can identify a newly created log. A missing log is reported.
- `src/core/damageTracker.js` accepts normalized events, excludes minions and
  buildings, deduplicates by event identity, separates players, splits fights
  after a configurable 1–60 second pause (default 8), and computes a rolling
  30-second view. Settings are currently a core API, not a user-facing control.
  It keeps unknown damage/source categories and marks midgame starts partial.
  It is intentionally not connected to unverified candidate packets.
- Official Riot macOS artifact `9E817EA717DA1A6F`, version `16.22.8348910`, SHA-256
  `368dcf59f0409deb35fce0743bcc2c10fa9d2ea5d040445332c705de8f00f5b5` is the only
  accepted artifact for the new decoder. Binary artifacts and captures are
  ignored local research files, not distributed with the app.
- Transport checks execute the exact client routines in bounded offline Unicorn:
  48 cipher cases, 18 checksum cases, framing, and compact packet type IDs.
- Packet 393 is registered by the attackable-unit constructor at `0x1000e0100`
  with consumer `0x1000e1490`; its factory allocates 52 bytes and its exact
  deserializer is `0x10101f110`. Candidate amount/source/target/type extraction
  is checked with 24 independently encoded object fixtures against the original
  consumer. The consumer passes these fields to floating damage display code
  (`0x1000e3220`). This is evidence for a candidate, not proof of its live coverage
  or damage accounting. A separate conditional path can add another float to
  display damage; shield/recap/result-code semantics remain unresolved.
- `research/damage_capture_16_22.py` verifies matching log build, checksum,
  framing and exact payload consumption before reporting candidates. It keeps
  rejection/fragment/ack coverage information and uses pseudonymous unit labels.
  Its outputs are not accepted by the meter. No team completeness, target-class
  mapping, ability mapping or damage type naming is claimed yet.
- Validation: 28 Python research tests pass with all three pinned binaries;
  Node tests pass. The Electron self-test loaded the Damage panel, exercised its
  status IPC, and produced a reviewed screenshot. Live validation is pending.

### Record a controlled game

Use **Damage → Start tracking**, or run `node scripts/record-damage.mjs` from
the repository. Wait for **Recorder ready** before entering the game.
The command-line recorder saves under `.local-research/damage-sessions`.
the app saves under its user-data directory and offers **Open recording folder**.
The original log contains private session material; keep it local.

Start with isolated basic attacks on a target dummy, a 10-second pause, an
isolated spell, another pause, and damage to a jungle monster. Record the visible
numbers and approximate game times independently. The CLI accepts typed notes
as timestamped markers and `stop` to finish early. Leave the game to finish
normally. True damage, shields, overkill, simultaneous sources and normal game
coverage need additional tests after this first pass.

Run the offline analyzer with the session directory and pinned local artifact:

```powershell
.venv-research/Scripts/python.exe research/damage_capture_16_22.py --session '<session-directory>' --raw-only --binary '.local-research/official-builds/9E817EA717DA1A6F-LeagueofLegends' --output '<new-report.json>'
```

The analyzer refuses to overwrite a report. Reports contain candidate fields,
not full-game damage totals. Packet arrival times are only estimates of game time.

## Controlled Practice Tool results

Three Annie sessions supplied independent ground truth. PktMon missed incoming
sequences that the client acknowledged, including confirmed damage events. All
components improved visibility at some points but retained substantial gaps.

| Test | Capture | Acknowledged incoming sequences absent | Damage evidence |
| --- | --- | ---: | --- |
| 1 | PktMon NICs | 702 | Two of three 54-damage dummy autos and a wolf auto. Wolf Q absent. |
| 2 | PktMon all components | 424 | Two dummy autos and wolf Q. Other reported hits absent. |
| 3 | PktMon all components | 353 | Four of six reported outgoing hits. |
| 3 | Windows IP-layer socket | 0 within its capture window | All six reported outgoing hits and six incoming wolf hits. |
| 3 | Both captures merged | 3, all before 0.5 seconds | Same 12 hits. PktMon started earlier than the IP observer. |

In test 3, the dummy took 54 physical damage at 10.90, 12.34 and 13.91 seconds,
then 94.18 magic damage at 14.74. A wolf took 35.21 physical damage at 56.11 and
61.41 magic damage at 56.57. The two packet formats agreed on source, target,
amount and source hash for all 12 hits in the combined recording. The targets
were also identified independently from exact type 43 and 1193 spawn packets.

Type 743 dispatches a 96-byte damage-counter event for schema `0x2839cc82`.
The handler sends kind 24 to received damage counters and kind 25 to dealt damage
counters. Three adjacent floats hold the damage schools. The next float is
reported as an unlabelled extra field. The source hash matches lowercase ELF
hashes of `AnnieBasicAttack2` and `AnnieQ` in these sessions. This validates those
sources only. True damage, shields, pets, DoTs and other source mappings need
separate checks. `src/core/damagePacketFields16_22.js` decodes the event without
Unicorn or the Riot binary. It matched 26 distinct damage payloads and ignored
21 unrelated payloads when compared with the pinned client code.

`research/damage_raw_capture.py` is a Windows-only comparison observer. It uses
[Winsock IP-level receive](https://learn.microsoft.com/en-us/windows/win32/winsock/sio-rcvall)
and writes only traffic matching the game's server endpoint and owned UDP ports.
A 12-response UDP probe verified the socket before the in-game test. Run it from
an elevated terminal while the test recorder is armed. It stops with the recorder.

```powershell
.venv-research/Scripts/python.exe research/damage_raw_capture.py --session '<session-directory>' --league-path 'C:\Riot Games\League of Legends'
```

Pass `--raw-only` to the analyzer to inspect the IP-layer capture. Use
`--raw-pcap '<session-directory>/raw-ipv4.pcapng'` to merge both. Preserve the
original local log and capture start times. The first connection's Game Info
handler (type 331) sets the local player slot at `0x1006f9f69`. It was already
past when these recordings started. Capturing that handshake earlier and linking
the slot to the champion's network ID remain alternate ways to establish
ownership before the player's first action.

## Live preview integration (2026-11-13)

- The app ships a PowerShell and .NET IP-layer helper. It filters by the game
  server and the process's UDP ports, writes a bounded capture, and stops on game
  exit or loss of the app heartbeat. The app reads complete packet blocks as
  they arrive. Python and the pinned Riot binary are only needed for the
  independent offline verifier.
- The packaged JavaScript decoder reproduced all six outgoing Annie hits
  (352.80 damage), with two fights and two hits in the final 30 seconds. It also
  decoded all 126 batch packets in that recording byte-for-byte against the
  pinned client deserializer.
- The integrated recorder captured 1,787 checksum-verified datagrams in a
  mid-match KIWI sample. Its 82 outgoing stat records matched the player object
  ID from the client's outgoing type 618 packets. The rolling display marks a
  late start as partial coverage.
- A capture armed before the Practice Tool match verified the hero spawn decoder.
  The client and standalone decoder agreed on Caitlyn, Heimerdinger, and the
  Practice Tool dummy. The opening roster confirms player and bot champion
  models. Six hits on Heimerdinger account for 427.39 physical damage, including
  70.31 from Caitlyn's Q in the last 30 seconds and latest fight. Three dummy
  hits and four wolf hits stayed out of the Champion view. All targets showed
  all 16 recorded hits for 1,267.89 damage. Other targets can remain unidentified.
- Champion totals require captured hero spawns and a matching roster. A start
  after the opening can omit the spawns. The Champions view then shows dashes
  if it cannot identify the target of any hit. Full normal-match coverage and
  true-damage accounting still need validation.

## Damage reported on lethal hits

The Caitlyn versus Amumu Practice Tool capture reproduced totals above the
user's observed HP at the start of a fight. Kill 19 at 12:18 had four hits for
971.32 damage against 855 reported starting HP. The 14:40 fight had six hits
for 1,185.51 against 943 reported starting HP. The last hits were 179.72 and
487.75 respectively. Every hit matched by amount, source and target in both
the damage counter (type 743) and floating damage display (type 393). The
unlabelled float at offset 40 was positive on nonlethal hits, and it was zero
on the true-damage hits here. There is no evidence that it is an overkill field.

The Live Client Data response exposes current HP for the local player only.
Measuring actual HP lost requires verified target health and damage accounting
at hit time, including regeneration and other sources. The live meter labels
these figures as reported damage and displays the DPS denominator.

League Match History returned 38,620 champion damage for the completed Amumu
game. The capture contained 36,407.46 on Amumu and 2,212.84 on the dummy. The
short Heimerdinger recording likewise had 427.39 on the bot and 228.60 on the
dummy against League's 655. These results show why clipping reported hits at
remaining HP would diverge from League's totals. All-target capture totals
can also differ from Match History, as they did in the Amumu game.

The full-game card uses League's published values once a recording matches the
game ID, start time, and local participant. The local timeline for this game
provided kill timestamps without per-kill damage or per-frame damage stats.
Last 30 seconds and Latest champion fight use the live capture. Only champion
hits advance or extend the fight timer in either target view.

## Live champion HP loss

The saved Amumu capture contains health updates in type 952 replication bank
5, field 0. The official deserializer and standalone reader agree on the
record vector. The decoded starting health was 855 and 942.68 for the two
reported kills. The last hits removed 71.30 and 251.67 HP respectively.
The two fights removed 862.90 and 948.47 HP, including HP restored by
regeneration between hits. The matcher covered 144 of 154 champion hits in
the full Amumu recording.

Matched HP loss is available for the live Champions cards and Latest champion fight.
Each accepted drop has matching per-target damage display and outgoing hit
records in the same capture frames, followed promptly by a health update.
The meter leaves unmatched hits out of the HP subtotal and indicates partial
coverage. Simultaneous damage can have a verified combined drop with an
unknown split by source or school. The metric measures observed net HP drops,
so simultaneous healing and incomplete visibility can affect attribution.
In a full ARAM Mayhem recording, the HP matcher covered 895 of 2,133 champion
hits. The HP subtotal was 71,371.37. The same capture had 139,019.46 reported
champion damage, matching League Match History's 139,019 after rounding. The
physical, magic and true subtotals each matched the corresponding Match History
integer when truncated. The live meter defaults to reported hits in all cards.
Matched HP loss remains optional, with unmatched hits shown as partial.
At 14 of the player's 15 deaths, the reported latest-fight total exceeded the
old matched-HP subtotal over the same estimated window. After the match, the
default full-game card uses League Match History totals when available.

## Death Recap fight time

On 16.22.8348910, the playing client gets the fight duration in the Death
Recap message (1074) at death. The client rounds the duration to hundredths
and formats Fight Time to one decimal place. The standalone reader matched
the native duration at all 15 deaths in the recorded ARAM Mayhem game. The
values displayed ranged from 10.8 to 45.0 seconds. The server's exact rules
for starting or extending the window are unknown.

The fight card stays on that duration through respawn, until the next
incoming or outgoing champion hit starts a new estimated fight. It uses the observed death
message time to count locally captured outgoing champion damage over the
same number of seconds. Differences in event coverage or packet timing
can still affect the damage total.

In that ARAM capture, five of the recap start times lined up within 20 ms
of an incoming champion event. Three of those had a zero-damage event at
the start. Other recap start times were several seconds earlier than any
observed champion event. Incoming champion events, including zero-damage
ones, now start and extend the live estimate. The timer runs through the
configured pause and uses a rolling maximum of 45 seconds. The default
10-second pause and 45-second limit approximate the observed recaps.
The fight damage and DPS use outgoing champion damage only.

In the last sampled live state before each of 15 deaths, the median
absolute duration error dropped from 22.3 seconds to 1.0 second. Results
within 3 seconds increased from 1 of 15 to 10 of 15. The largest residual
error was 36.3 seconds. Two other recordings started mid-match and lacked
the champion spawn data needed to classify the hits around five deaths.

A second complete ARAM Mayhem recording on November 14 matched League's
final 49,356 champion damage and 134,947 all-target damage. The capture
contained all 14 recaps. One arrived in a separate datagram about 1 ms
before the local hero update, so the reader now pairs the two messages
within a 2 ms receive window. Using the 10-second pause, the last sampled
live timer was within 3 seconds at 6 of 14 deaths, with a median error of
7.7 seconds. Replaying this match with a 15-second pause reduced the
median error to 4.3 seconds. The previous full recording had a higher
mean error with that longer pause.

## Damage source names

The 96-byte damage event carries three spell name hashes and a slot field.
Offset 80 names the root spell, offset 16 the script that applied the
damage and offset 48 its missile or sub-spell. Spell names use the
lowercase ELF hash. Item and rune damage replace the root with FNV-1a of
`SpellOriginItem` or `SpellOriginPerk`. Damage over time, such as item
burns and augment missiles, has a zero root and names its script at
offset 16. Offset 84 matched Q, W, E and R as 0 to 3 and basic attacks as
64 or higher, but it also held an item ID and other values. The meter does
not rely on it.

Replaying ten local recordings resolved every ELF root hash from the
`mScriptName` strings in the champion’s installed WAD or the shared list below.
Champion examples are
`ZyraQPlant`, `CaitlynPassive` and `LucianPassiveAttack`. The remaining
"Unknown source" damage in the November 14 Zyra game had a zero root. Its
scripts were `6653Burn`, `2503Burn` and `Augment_ARAM_MagicMissile_Missile1`
through `Missile3`, which accounted for all 5,776.92 true damage.

The live meter reads the player’s champion WAD once per app session.
`src/core/damageSourceNames16_22.js` holds 1,334 shared item, augment, rune
and summoner script names. `research/damageSourceNames16_22.mjs` regenerates
it from Global and map WADs. Live Client Data supplies ability, item,
summoner spell and rune display names, and the League client’s item list
covers items that have been sold. Some item effects only send the item
origin and hashes that do not occur as strings in the installed bins. They
appear as Other item effects. With item names loaded, this was 2% of the
first Galio game. In the second it was 43%, nearly all from one effect with
script hash 0x08db76a2 and missile hash 0x05bf74f4. A few events had all
three hashes zero, including one 32,250 hit in a Hwei game. They appear as
Other.
