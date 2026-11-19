# Standalone damage tracker: feasibility and next experiment

Research date: 2026-11-08. Branch: `damage-tracker`, created and checked out from
local `main` at `04549170a9866eb7cedccadf45c98f8c60592cea`.

For future League patches, use the [patch-upgrade guide](damage-tracker-patch-upgrade.md).

The [combined 16.23 upgrade record](spectator-patch-upgrade.md#1620-to-1623---2026-11-18)
covers the shared replay readers, executable comparisons, same-clock score checks
and end-of-game damage validation used on the `live-features` branch.

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

The app removed this metric on November 14. The meter counts the reported
damage that League uses for its own totals. The notes below are kept as
research history.

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
incoming or outgoing champion hit starts a new estimated fight. The final
entry in the recap contains the player's outgoing champion damage by
school. League rounds each detail's physical, magic, and true damage up
before summing. The default card uses those figures and shows captured
source rows only if the unrounded school amounts reconcile. HP loss
continues to use matched hits within the recap window.

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

The November 14 Malzahar capture exposed a shared Mayhem burn. The raw
script `Augment_ARAM_SlowCooker_Bleed` accounts for 3,103.29 champion damage,
but only Infernal Conduit was selected among the shared-script candidates.
The installed Kiwi data gives the script the generic Burn name and also
links Firebrand to it. The meter uses Burn until the local Match History
participant identifies a single candidate. League can fold this burn
into the triggering spell on its recap. The captured source split shows it
separately. For example, the packet credited 1,310.62 magic damage to Q
in one recap, all of which came from the burn in the captured hits.

A second capture confirmed the same shared hash (`0x079bcfa4`) for
Firebrand. Twitch dealt 11,624.35 champion damage and 12,801.69 all-target
damage with the effect. The saved Live Client snapshots lacked augment
selections, so the live label stays Burn. Resolve this hash directly even
if the mode string or spell catalog is unavailable. Use a specific name
only when Match History confirms a single Mayhem burn augment.

All eight Malzahar recaps had an outgoing damage total that agreed with
the captured window to within 0.05 per school. In a previous ARAM capture,
the timed window summed to 17,712 while the server's fight total was about
9,677 before display rounding. Always check the dedicated recap entry.
Malzahar's champion total matched Match History (17,842 after truncation).
The live all-target sum was 33,508.32 against 32,726 in Match History, with
the difference in non-champion magic damage. The cause is unverified.
If captured totals disagree with Match History, the match card shows the
official totals and withholds the captured source split.

## Damage taken

Kind 24 damage events name the attacker as their peer object. Enemy items,
burns and pets are credited to the champion's own hero ID, as the local
player's are on outgoing events. Hero IDs come from the type 43 spawns, or
from the roster order when the recording starts after the opening. Turrets,
minions, monsters and the fountain are grouped as one non-champion row.
Match History's `totalDamageTaken` includes them. The card therefore counts
every source in both target views. In the November 15 Zyra game, the
Champions view had left out 1,458 damage from minions and turrets, so it
showed 35,144 against League's 36,602. The full capture matched 36,602.

Nine ARAM Mayhem recordings from November 13 and 14 that started before
the match were replayed with `research/damageReplay16_22.mjs` and compared
with Match History. Damage taken matched
`totalDamageTaken` within 1 in all nine, and each school matched its
`physicalDamageTaken`, `magicalDamageTaken` or `trueDamageTaken` within
1. Damage to champions matched `totalDamageDealtToChampions` within 1.

All-target damage dealt exceeded `totalDamageDealt` in six of the nine
games by 599.8 to 1,343.5. In each game the excess matched the captured
damage to a single low object ID within 1. The ID was 15 or 12 below the
first hero ID. Turret damage, at other low IDs, was included in Match
History. The excluded object is likely an inhibitor, but it has not been
identified from game data. The live all-target total therefore runs high
when the player damages it.

Recordings now add a `names` entry whenever the local player's ability,
summoner spell, item or rune names change. Only IDs and display names are
kept. The replay script restores them so labels match the live meter.

On a 25-minute recording, decoding the whole capture took 2.6 seconds, or
0.17% of one core over the game. One meter snapshot at the end of the game
took about 2 ms. Reading the champion archive for spell names took 0.7 to
1.6 seconds once per session, yielding to the event loop at least every
25 ms. The Damage tab polls once per second only while it is visible.

## Starting after the opening

A recording that starts mid-game misses the type 43 hero spawns. From game
time 1 onward, the Live Client roster order matched the hero object IDs in
all 11 recordings with spawns, including Practice Tool. The IDs were
consecutive. At game time 0 the roster lists the local player first, so
those samples are ignored. The local player's ID comes from outgoing type
618 packets, so the other heroes are that ID plus their roster offset.
Roster samples that repeat a champion name, as during Viego's possession,
are skipped. Spawn data wins over the roster whenever both exist.

Each of the 9 complete Mayhem games was cut to start at game time 180, 480
and 900. All 10 heroes were identified in every cut. Champion damage, damage
taken and damage per enemy champion were identical to the full replay over
the same window. One game ended before 900 seconds. The real late
recordings named the expected attackers. In the Zyra recording that started
at 61 seconds, Caitlyn's hits carried the `CaitlynBasicAttack` hash. In the
Lucian recording that started at 669 seconds, 4,397 captured champion damage
compared with 4,400 in the matching Death Recap.

Every recording had a few checksum failures. They were the connection
handshake at the start and five identical 69-byte goodbye datagrams at the
end. A lost game datagram leaves an acknowledged sequence missing, so the
meter reports partial coverage only for missing sequences, fragment loss,
clock gaps or unidentified champions.

## ARAM Mayhem script names

ARAM Mayhem spell scripts use a `Kiwi_` prefix. In the November 15 Zyra
game, 2,071 champion damage labelled Other came from
`Kiwi_GoH_Bees_GigaMissile_Bomb` and `Kiwi_GoH_Bees_Missile_Bomb` as the
root spell. GoH is the Guest of Honor event. The shared name list now keeps
`Kiwi_` script names. Labels drop the season and mode prefixes and mark
Guest of Honor effects, so this damage reads Bees · Guest of Honor.

Two other groups of unnamed damage were resolved by replaying the November
14 recordings. `ItemHurricaneAttack` and Jinx's variant name Runaan's
Hurricane bolts. They are matched to the item through the item list.
In the Twitch game, 10,151 damage had another champion's kit spell as its
root: `PantheonQ`, `PantheonW`, `PantheonBasicAttack2` and
`ShacoCritAttack`, with the unnamed script hash `0x05bf74f4`. The hits
landed on several enemies, not only the caster. The player's own effect was
triggered by an enemy hit. Roots that match an enemy champion's basic kit
names are labelled Triggered by enemy hits. A Zyra game still had 872 damage
with `EzrealR` as its script and no Ezreal in the match. That damage stays
labelled Other.

## Damage dealt by target

The Damage dealt card groups the player's outgoing hits by target object ID.
It follows the target filter, so the Champions view sums to the champion
total. In the November 15 Zyra game the five enemies received 14,202,
10,280, 8,993, 6,191 and 5,338, which add up to League's 45,004.
League's end-of-game stats have no per-target split to compare against.

## Team damage

The playing client's ordinary hit stream is local to the player. In a complete
November 16 ARAM Mayhem recording, every damage counter event (743,
schema `0x2839cc82`) and every floating damage event (393) involved the
local player. The 743 envelope did arrive for all ten heroes with other
schemas: heals and shields (`0x8f7f3f4e`, kinds 241 and 242), self-heals
(`0x7c044fe1`), kills, assists and kill gold. The later paired-replay
check below found damage fields on the kill and assist records. The
last packet of each of the 76 other packet types with a hero owner was
run through its pinned client deserializer and searched for every
player's final Match History damage. No field matched for more than two
heroes. Health replication (952) gives HP for visible units but no attacker.

Type 664 is the hero's end-of-game stat block, a 1,260-byte vector behind a
selector byte and a length. The playing client receives it once per hero
at spawn, with zero totals. League's spectator feed puts the same packet in
every keyframe, once a minute, with current totals for all ten heroes. The
block parameter holds the hero ID, so the payload starts at the selector.
The deserializer at `0x1010474c0` writes the vector in alternating
front/back order through a byte table. The table was derived by
deserializing synthetic vectors with the pinned client, and a synthetic
payload with non-zero damage decodes identically in both readers. The
client reads the length and vector only when the low four selector bits
are 0, 1, 2 or 4.

The end-of-game stat names are in the same order in 16.20 and 16.22, and
the vector is 1,260 bytes in both. Damage dealt starts at `0x1d0`, damage
to champions at `0x1e0` and damage taken at `0x1f0`, each as the total
followed by physical, magic and true. Kills, deaths and assists are at
`0x4c`. Saved 16.20 spectator keyframes from five games were compared with
Match History. These fields correlated with the final values (r up to
0.99), the ratios rose toward 1 as the keyframe neared the end, and the
three schools summed to the total. The field after time crowd-controlling
is not total healing, so healing is not shown.

On November 17 a running 16.22 ARAM Mayhem game was read from the observer
API at game time 912. Its newest keyframe was at 840.3 seconds and held
exactly ten 1,263-byte type 664 blocks. All ten decoded, their teams
matched the roster order, and their kills, deaths and assists trailed the
live scoreboard by the last minute. The local player's block equalled the
packet capture at the same game time: 53,292.2 damage to champions,
67,365.9 to all targets and 96,126.5 taken against 96,126.2 captured,
including each damage type.

The observer serves a game on demand. The first request returned only the
startup chunk; about 30 seconds later the feed had caught up to the live
game. The client's gameflow session reported `spectatorsAllowed: false`
for this game, but the feed still served it. Ranked queues may use a
longer spectator delay, so the card shows how far its numbers trail the
live game. Practice Tool and custom games are expected to have no feed.

The recorder starts the feed once it finds the game log, which supplies
`-GameID` and `-PlatformID`. Each new keyframe's stat blocks are saved as
`team` observations. `research/damageReplay16_22.mjs` compares the
player's saved block with the capture at the same game time. A keyframe
with no readable stat block is saved once for patch research. After the
game the card uses Match History for all ten players.

### Faster team damage from spectator chunks

The keyframe feed measured in the November 17 Varus game was 61.4 to 62.2
seconds behind for all 17 keyframes, so the card trailed the game by 62 to
122 seconds. A search for anything faster found:

- **No cumulative teammate counter found.** All 711,319 incoming packets of that game were
  decoded with the pinned client and tested against the 17 exact keyframes:
  at every byte position near the keyframes, as per-minute sums, as running
  totals, and across every 952 replication record of all 2,010 objects.
  The local player's 743 events were found at a ratio of 1.000. Nothing for
  the other nine champions scored above a time-shifted chance baseline.
  Overwolf's League damage events, the Live Client Data API and the
  companion apps that were checked expose no other player's live damage.
- **Chunks carry every hit.** Two 16.22 replays of recorded games
  (`.rofl` format 2: plain zstd segments in the spectator block format,
  then a signature and JSON metadata) contain packet 393 rows for hits
  between any two units: 19,018 and 9,417 rows. Summing rows whose source
  is a hero and whose target is a hero matched every keyframe's damage to
  champions (329 of 330 hero-keyframes; the miss is a hit 0.3 ms after a
  float32 keyframe time) and Match History for all 20 players. Damage taken
  matched the same way. The type code is the damage school: 0 physical,
  1 magic, 2 true; per-type sums matched Match History for every player.
  Identical rows at one timestamp are separate hits. The chunks hold no
  damage-counter 743 events and no 664 stat blocks. All-target sums run
  high by the hits on two structures per game that League leaves out.
- **Chunks arrive sooner.** Logged observer replies place chunk N's
  publication about 30 seconds after its end, and keyframe K appears with
  chunk 2K+1 rather than chunk 2K. Chunk N covers game time from
  30(N-3) to 30(N-2) seconds, and keyframe K's time is the end of chunk 2K.
  Adding the chunks after the latest keyframe therefore cuts the card's
  lag from 62-122 seconds to about 31-61 seconds in ARAM Mayhem, refreshed
  every 30 seconds. Riot's spectator delay is longer on Summoner's Rift.
- **Live estimates are approximate.** Enemy HP loss from 952 replication,
  scaled by about 0.96 and minus the local player's damage, tracked the
  allies' damage per minute with about 20% median error. Splitting it per
  ally was right about the top ally in 8 of 13 minutes. This is not shown.
- **Friends could share exact live damage.** Each player's own capture is
  exact, and the app's Queue Relay chat connection could carry it between
  friends who run the app. This is not built.

The live chunk feed rebuilds each 393 block in its playing-client form by
encoding the block parameter as the leading owner ID, decodes it with the
standalone 393 reader, and adds hits after the latest keyframe's time
(with 1 ms of slack) up to the first chunk not yet served.
`research/teamChunks16_22.mjs` replays a `.rofl` file through the same code
and compares each pair of chunks with the next keyframe and the final
totals with the replay's end-of-game stats.

The standalone 393 reader follows the deserializer at `0x10101f110`: the
owner, four selector bytes, then amount, hash, source, target, type,
display, an ID and a four-byte value the consumer ignores, and the result.
Its varints have no length limit and wrap the shift at 32 bits, as the
client's do. It matched the pinned client on every field for all 28,435
replay rows, 1,635 live packets and 70,000 fuzzed inputs, including which
inputs are rejected. An independent check derived the layout again from the
disassembly and compared 456,861 inputs without a difference. Replayed
through the app's feed code, both replays decoded every damage row. Each
keyframe plus its two following chunks equalled the next keyframe for all
330 hero-keyframes, for damage to champions and damage taken, and the
final totals equalled the end-of-game stats for all 20 players.

### Playing-client checks on November 17

In the November 17 ARAM Mayhem and Summoner’s Rift recordings starting at
20:30 and 20:48 UTC, published chunks arrived roughly 32 and 122 seconds
behind game time respectively. Across their 6,439 decoded damage-display
rows, zero showed a hit between two champions other than the player.
The 9 and 2 Death Recaps matched the player’s death count in each game.
During a later Rift game, the installed Live Client API supplied kills,
deaths, assists, creep score and ward score. Match History, the game
timeline, end-of-game stats and replay metadata returned no data for the
in-progress match. The configured replay folder had no file for it.
These checks establish the limits of the tested sources on build 16.22.

### Exact live damage on champion takedowns

Two matched playing-client captures and spectator replays (EUW1 games
8046070263 and 8047054973) provide independent views of the same fights.
The client received 29,750 hero HP readings across these games. We matched
consecutive enemy readings to the same hero and exact float values in the
replay, requiring each value to occur only once there, both clocks to agree
within half a second, and the interval to last at most one second.
In 47 such drops, the spectator recorded hits from at least two of the
local player's teammates strictly inside the interval. At 4:32 in the
Caitlyn game, Xin Zhao's HP fell from 898.53 to 550.93. Kassadin dealt
144.52 and 45.47, and Yasuo dealt 157.61. The playing client's type 952
row gives the target and HP. Its fields do not split that drop by attacker.
The two replays held 9,410 opposing-champion hits involving neither local
player. The ordinary damage-display and damage-counter streams in the
paired playing-client captures had zero of those hits.

An offline check using the pinned 16.22 client deserializer found a replay
hit amount in a different type 743 event near a death. Checking every death
and assist established two sources for the live Takedowns view:

| Event | What the playing client sends |
| --- | --- |
| 743 schema `0xd83b6b03`, kind 4 | The victim owns the 108-byte body. Offset 4 identifies the killer, 12 repeats the victim and 104 holds the final hit as a float. All 224 notifications matched the killer and victim in the Live Client kill log. Each of the 207 positive amounts matched a replay hit exactly. |
| 743 schema `0x7c689a48`, kind 87 | The assister owns the 36-byte body. Offset 4 identifies the victim, 32 identifies the killer, and 12, 16 and 20 hold physical, magic and true damage. Every one of the 447 positive reports matched the three school sums of a consecutive run of that assister's last hits on the victim before death, within 0.05 per school. Kind 86 duplicates assist figures and can also apply to other units. Only kind 87 is counted. |

The card sums these records for identified opposing champions from the
start of the recording. It excludes zero-damage assists and keeps the
killer's final hit separate from the assister's damage by school. These
amounts cover a subset of champion damage and can overlap the spectator
totals. They are displayed as their own measurement.

| Game | Verified positive records | Captured takedown damage | Share of all opposing-champion damage in the replay |
| --- | ---: | ---: | ---: |
| Caitlyn | 310 / 310 | 131,621 | 45.8% |
| Xayah | 344 / 344 | 185,911 | 41.0% |

Two further Summoner's Rift recordings had 193 positive champion records.
All 193 matched the named killer or assister and victim in the kill log.
All 43 involving the local player also matched the local hit stream.
The installed Lux WAD contains spell and missile definitions, including
`LuxLightBindingMis`. Such definitions can name an ability. The measured
takedown values above come from server messages in the player's capture.
The client deserializer was run offline without attaching to the game.

To repeat the paired comparison, run
`node research/teamTakedowns16_22.mjs <recording-directory> [...]` with
the corresponding ROFLs in the League replay folder. Set `LEAGUE_REPLAY_DIR`
for another location.

### League patch 26.23

The Windows game log and Riot's EUW macOS manifest identified build
`16.23.8396405`. The offline x86-64 reference came from Riot manifest
`A4E02DE59267375D`. The SHA-256 of the universal executable was
`8ee34ee5848104beb3be0d92344b2f8c6a1953aa853229e889e796c875f88639`.
The transport passed checksum validation without changes. The app selects
between the two supported builds by exact version.

The 16.23 decode uses 172 for combat events, 314 for batches, 693 for
the local action owner, 88 for hero spawns, 502 and 408 for Death Recap,
313 for spectator stat snapshots, and 530 for spectator damage rows. The
spectator stream carries a second clock. Its original timestamp aligned
with the live game clock.

In an EUW ARAM Mayhem match, the playing-client recording began at
4:30. The spectator feed filled in 4,831 earlier champion damage, bringing
the personal total to 62,910 at League's integer precision. The replay
decoded 13,462 damage rows and matched the following keyframe for all 140
hero intervals within 0.07 damage. The final champion damage and damage
taken matched the replay's results for all ten players. All 271 captured
takedown records matched the same game's replay, including assists whose
credit carried through a revive. The recorder decoded six Death Recaps
after the capture started. Four also matched the local hits inside the
reported duration within 0.01 per school. The other two kept the
server-reported totals with no source breakdown.

The all-target comparison remains sensitive to structure damage. The
finished Damage card takes its total from Match History. This sample
covered ARAM Mayhem. Champion spawn IDs were also checked against the
replay's roster.

## Live team damage from combat markers and health

Research date: 2026-11-18, builds 16.22.8348910 and 16.23.8396405. The goal
was a Team damage card without the spectator delay. The exact feed stays.
A live estimate now covers the game time the feed has yet to reach.

### Sources that cannot be made faster

- **Spectator chunks ahead of the released one.** During a live EUW ARAM
  Mayhem game the observer answered HTTP 404 for the three chunks after the
  released one and for the next keyframe, in three rounds eleven seconds
  apart. Its metadata held `delayTime: 0` and no list of pending chunks.
  The released chunk was 34 to 51 seconds behind the live clock. A
  `getLastChunkInfo` parameter of 30000 returned an older chunk. The
  observer serves nothing ahead of the chunk it has released.
- **Game memory.** Not read, and not attempted: the game runs under Riot's
  anti-cheat. The client can only hold what the server sent it, and the
  earlier search of every incoming packet found no damage figure for the
  other players (see Team damage above).
- **Replay files.** A `.rofl` is offered after the game ends.

### The two packets

A census of one 16.23 recording counted 250 incoming packet types. On the
paired 16.22 Caitlyn recording, each type was scored by how often a packet
owned by a champion arrived within 0.2 seconds of a replay hit by or on that
champion. One type stood out: 99.9% of hits between two other champions had
such a packet for the target, and 89.8% for the attacker.

| Role | 16.22 | 16.23 | Layout |
| --- | ---: | ---: | --- |
| Combat marker | 979 | 503 | Owner, one selector byte, four time bytes. The time is the server game time of the hit, a float. A selector tells a hit between champions from one involving a minion, monster or structure. |
| Unit replication | 952 | 309 | The server time of the tick, a byte vector of unit records, a one-byte field and a counter. Bank 5, field 0 of a record is the unit's current health. |

Attacker and target get a marker with the same time. On that replay a
marker within 11 ms of the hit was present for 98.9% of ally hits on
enemies (source) and 98.6% (target). Enemy attackers were marked for 86.4%
of their hits on allies. An attacker the team cannot see is the likely
reason, which was not checked hit by hit. Hits on or by a unit mark only
the champion. The median difference between a marker time and the nearest
replay hit time was under 0.01 ms on both builds. On the 16.23 pair, 90% of
markers lay within half a millisecond of a replay hit.

The marker's flag was cross-checked against the replay on both builds. On
16.23, 5,091 champion markers fell in a frame where that champion only
dealt or took champion damage and 47 in a frame with unit damage only. For
unit markers the counts were 17 and 1,275. About 17% of all markers had
no replay hit for that champion in that frame. Rows with zero damage are
left out of the replay hit list, so these were not examined further.

Replication is sent in ticks 0.1 seconds apart. Its clock runs ahead of the
game clock by a constant (36.5 and 35.2 seconds in two games). A tick's time
minus the latest marker time before it clusters on multiples of one server
frame. Markers of the tick's own frame arrive both before the replication
packet (1,094 ticks in one game) and after it (193). The estimate counts a
marker received before the packet toward that tick's health and one
received after it toward the next. That rule was not checked hit by hit.
It replaced an arrival-time window that scored about a point worse on both
16.22 replays, along with other changes made at the same time.

Both readers were derived from the pinned macOS deserializers offline.
Memory hooks record which input bytes are read and what is written, which
gives the byte tables and field order without disassembly. The marker time
table (256 entries, no conflict on 8,940 packets), the replication vector
and time tables (5,543 packets, no conflict) and the four replication
selectors (all 256 first flag bytes with each low value of the second) come
from that trace. A table learned separately by voting on replay hit times
agreed with the 16.22 client table on all 254 entries it covered.
`research/dumpLivePackets.mjs` and `research/team_live_tables_16_23.py`
repeat the derivation.

### The estimate

`src/core/damageTeamLive.js` credits the health a champion loses in one tick
to the opposing champions that share one of its marker times since the
previous tick:

- Only champion markers form these groups. A champion that also lost
  health in the frame is taken as a target there, unless every opponent
  did, which is a trade.
- A unit marker on the target in a frame where every opponent was hit
  explains the loss instead.
- Each frame of a tick takes an equal part of the loss, credited at that
  frame's own time, and attackers in one frame share its part. An equal
  split over the tick, extra weight for an attacker just seen hitting that
  target alone, winner-takes-all and matching against recent hit amounts
  were compared on the paired replays. All landed within two points of
  each other, so the split is not where the remaining error comes from.
- The local player's hits come from the own hit stream, exactly, and are
  taken out of the loss. Hits on the local player use that stream alone.
  Each own hit takes the server time of the local player's marker for it,
  which arrives just before the hit (1,238 of 1,832 in one game) or within
  3 ms after it. The Live Client clock alone reads 11 to 35 ms late.
- Heals in a tick with a hit are added back (see below).
- A death corrects the fight that led to it (see below).

The card adds the estimate for game time after the newest spectator totals.
Each new chunk replaces that part with exact figures, so the error never
accumulates past the spectator delay. Before the first totals, and in games
without a feed, the estimate stands alone from the start of the recording.

### Heals

The combat-event envelope carries a heal event for every visible champion:
schema `0x7c044fe1`, kind 75, a 52-byte body. The healer owns it. Offset 4
names the healed unit and offset 24 holds the health restored. A 16.22 game
with Soraka had 2,960 of them from all ten champions, 912 healing someone
else. In ticks where a champion was healed and had no marker, its health
rose by exactly the summed heals in 815 of 1,058 ticks in that game and in
217 of 263 in a 16.23 game. It was within 10% in 1,026 and 257.

A heal in the same tick as a hit hides that much damage, so the estimate
adds it back. Leaving heals out raised the summed error from 3.4% to 5.0%
in one paired game and from 5.8% to 6.2% in another. The third did not
change.

### Shields are not counted

Shield events use schema `0x8f7f3f4e`. Kind 241 is owned by the shielded
unit, kind 242 by the granter. Both name the granter at offset 8, the
shielded unit at 12 and the amount at 16. The shield's current value is
replication bank 5, field 3. Field 1 is maximum health. Field 2 was zero in
the two recordings checked. Field 3 rose by, or became, the event's amount within two
ticks of 253 of 501 shield events on 16.22 and 206 of 259 on 16.23.

Counting the shield's decrease as absorbed damage made the estimate worse
on every rule tried:

| Rule | Summed error, three paired games |
| --- | --- |
| Shields ignored | 3.4%, 5.8%, 2.1% |
| Count the decrease in any tick with a hit | 18.2%, 5.5%, 14.2% |
| Count it only while health is untouched and the shield still up | 10.0%, 5.4%, 10.1% |
| Also count a shield that broke in a tick that cost health | 14.9%, 5.3%, 12.2% |

The replay shows why. In ticks where a shield shrank, the champion's health
was untouched and the shield was still up, the shield lost 52,719 in one
game and the replay recorded 20 damage on those champions. In another game
it was 36,704 against 18. Where a shield was present before the tick, the
replay's damage matched the health lost (21,097 against 20,883, and 8,683
against 8,464). The replay's damage rows add up to League's own totals, so
those totals leave out what shields take. A shield also shrinks by itself
as it runs out. Do not add shield loss to the estimate.

### Kills and assists

When a champion dies the server sends, in this order, the kill record
(schema `0xd83b6b03`, kind 4), the assist records (`0x7c689a48`, kind 87)
within 2 ms, and then the tick that shows the victim at zero health, 0 to
162 ms later. That order held for all 190 deaths in two games where the
tick was seen.

All 643 assist records with damage in the three paired games matched a run
of the assister's last hits on the victim, and no run reached back more
than 20.0 seconds. In 622 of them the record equalled all of the assister's
damage to the victim in the 20 seconds before the death. An assist record
with zero damage also occurs (12 of 208 in one game). The decoder now
passes those on too. The killer gets no such record, only
the final hit in the kill record.

Once the victim's last tick is in, the estimate for that fight is corrected:

- Each assister's credit on the victim over the last 20 seconds is scaled
  to the reported amount, added if the estimate had none, and removed if
  the record says zero.
- What the assisters had too much or too little goes to the killer, since
  the health the victim lost is known. The killer also gets what its final
  hit reports beyond the health lost in the last tick, and never less than
  the final hit.

Without this correction the summed error was 4.0%, 9.2% and 9.2% instead of
3.4%, 5.8% and 2.1%. Without the killer's part it was 3.5%, 7.8% and 5.5%.

These comparisons, and the ones for heals and shields above, were run with
an earlier handling of the final hit. It raised the killer's share of the
last tick to the final hit and then added the assisters' surplus as well,
which can count the same health twice when the last tick is shared. The
shipped handling does not, and scores 3.5%, 5.9% and 2.6%.

### Two errors found in review

- **The local player's finishing hit.** The own hit stream reports the
  full hit, overkill included. Taking all of it out of the victim's last
  health left nothing for a teammate who had hit just before. With a
  target at 100 health, a teammate's 60 and then a reported 150 from the
  local player, the teammate was credited nothing. The teammate's part now
  lies between what is left after all of the local player's hits and what
  is left after the ones before the last, and the middle is taken (50
  here). The assist record then makes it exact (60).
- **A tick across the spectator cutoff.** A tick's whole loss was credited
  at its last frame's time. Two hits of 100 in one tick, one on each side
  of the cutoff, added 200 to the live part although the confirmed totals
  already held the first. Crediting each frame at its own time counts 100.

### Accuracy

Against three paired replays, as each other player's damage to champions
over the whole capture:

| Game | Build | Largest error | Other players | Summed error | Before these corrections |
| --- | --- | ---: | --- | ---: | ---: |
| Caitlyn, ARAM Mayhem | 16.22 | -15.4% (Teemo) | seven of nine within 4% | 3.5% | 5.0% |
| Xayah, ARAM Mayhem | 16.22 | +32.5% (Briar) | eight of nine within 10% | 5.9% | 10.3% |
| Volibear, ARAM Mayhem, from 4:30 | 16.23 | +7.8% (Nautilus) | eight of nine within 4% | 2.6% | 8.6% |

The summed error is the absolute error of the nine other players over
their true total. Over 30-second windows the estimate was off by 89, 228
and 173 damage per player on average, where the delayed figure lacks 1,106,
1,548 and 1,612. It named the top-damage teammate in 28 of 29, 30 of 35 and
19 of 21 windows.

`research/teamLiveEstimate.mjs` scores a recording against the exact
spectator totals saved with it, interval by interval. Ten recordings had
them: seven on 16.22 (five on Summoner's Rift) and three on 16.23, one read
while its game was still running. Per player and interval, the estimate
missed by 7% to 15% of the damage the delayed card lacks (median 8%, down
from 10%). The 15% came from a recording with one-minute intervals. It
named the top-damage teammate of an interval in 249 of 263. A recording
that began at 12:30 scored 10%. The local player's own row matched the
spectator totals in nine of the ten. In the tenth, a Varus game with Wukong
and LeBlanc, one minute of the own hit stream was 1,334 short. The cause
was not established.

### Health a champion pays itself

Briar was the largest outlier, 42% too high before the corrections and 33%
after. About two thirds of what remains was credited on Vladimir, who loses
a lot of health that is not damage. In that game these champions lost
health in ticks with no marker of any kind:

| Champion | Lost with no marker | Lost beyond the replay damage in ticks with a marker |
| --- | ---: | ---: |
| Vladimir | 15,395 in 170 ticks | 11,895 |
| Briar | 10,326 in 74 ticks, 5.0% of current health each | 6,606 |
| Blitzcrank | 7,690 in 207 ticks | 3,432 |
| Locke | 1,996 in 258 ticks, 0.5% each | 962 |

The first column is never credited. The second is: it falls in a tick
where the champion was also in a fight, and goes to whoever was hitting
it. Briar was credited 15,011 on Vladimir against 8,793 in the replay. No
combat event owned by the champion accompanies these losses. One rule
was tried and rejected: for a champion seen paying health three or ten
times, treat a tick in which every opponent was hit too as its own cost
instead of a trade. The summed error rose to 5.5%, 10.0% and 5.2%, or 3.9%,
8.9% and 3.4%.

### Markers without a damaging hit

About a fifth of champion markers had no damaging replay hit for that
champion at that time. Zero-damage rows do not explain them: the replays
held 4 of 13,462 and 58 of 9,417. Of 7,000 champion markers in the 16.23
game:

| What the replay and the next tick show | Markers |
| --- | ---: |
| A damaging replay hit by or on the champion | 5,660 (80.9%) |
| No replay hit; its shield shrank and its health did not | 484 (6.9%) |
| No replay hit; its health dropped | 94 (1.3%) |
| No replay hit; nothing changed | 761 (10.9%) |

The 16.22 game gave 79.9%, 5.8%, 1.1% and 12.9%. The second row fits a hit
that a shield took in full, which League does not count as damage, though
a shield running out would look the same. The last row is unexplained. A
marker of this kind can add a champion to a frame it dealt no damage in.

### Remaining limits

- Health a champion pays for its own abilities in a tick where it is also
  hit goes to its attackers (above).
- Between 1% and 3% of champion damage fell in ticks with no loss to
  credit.
- A single candidate agreed with the replay for 88% to 95% of losses.
  Between 16% and 23% of losses had several candidates and were split.
  These shares were measured before the corrections above, which do not
  change who the candidates are.
- The killer's part of a fight is what is left after the assisters, so an
  error in the victim's health loss lands on the killer.
- Without spectator totals the estimate is never corrected, so its error
  carries through the whole game.
