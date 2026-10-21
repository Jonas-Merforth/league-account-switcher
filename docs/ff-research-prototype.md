# FF Research capture prototype

This branch adds an opt-in observation tab. It does not type `/ff`, cast votes,
send team messages, or claim to have found an early enemy signal. See the
[initial feasibility research](ff-detecting-research.md) for the current evidence.

## Run a test and share it

1. Run this branch with `npm install` and `npm start`. Open **FF Research**.
2. Give the test a common label (use the same trial label on friends' PCs), fill
   in the League patch/build if known, and start capture **before loading in**.
   Recording continues when the window is hidden in the tray. It never starts
   automatically, and quitting the app stops it.
3. Leave **Include real game packets** enabled above Start (the default) and accept the Windows
   administrator prompt. Only the helper runs elevated. It waits for the game,
   then captures UDP on game-owned ports; the source card must say **capturing**.
   Leave the default 250 ms event interval for initial tests. Optional marker
   hotkeys work while recording: **Ctrl+Shift+F8** = enemy vote started,
   **Ctrl+Shift+F9** = enemy surrender accepted, **Ctrl+Shift+F10** = game ended.
   Own-team markers are **Ctrl+Shift+F5** = started, **F6** = failed, **F7** = accepted.
   These only write observations. If registration fails, the tab says so;
   use the marker controls instead. Hotkeys are released on stop/quit.
4. In a coordinated custom game, have a player on the opposing team call and
   report their vote. Mark **Vote started** only when that start is known.
   The enemy's successful-surrender announcement means **Surrender accepted**,
   not vote start. Mark own-team events with **Our team**, not **Enemy**.
5. Add notes for failed votes, ordinary Nexus destruction, disconnects, observed
   vote counts, who supplied the observation, and the final win/loss. Keep
   recording for at least 10 seconds after the result if possible.
6. Stop and wait for packet conversion/validation, then choose **Export file…**.
   Send the `.jsonl` file **and its companion `.packets` folder** together.
   Packet-enabled sessions cannot export while capture/conversion is running.
   API-only sessions can still export during recording.
   Previous captures remain accessible through **Open saved captures**.

For a useful initial dataset, collect failed and passed enemy votes, an own-team
vote, and an ordinary game ending without an FF. A control with no votes helps
identify false positives. Repeat on both teams. A consenting opposite-team
tester can record their perspective as a second file, labeling their own vote
as **Our team**. Their feed is ground truth for this experiment, not evidence
that our team's app can see it.

If available, keep a video of both perspectives to validate markers. Human
reaction delay and unsynchronized PC clocks prevent millisecond claims based on
manual markers or file timestamps alone. A candidate arriving before a human
acceptance marker may still arrive after the actual server decision.

## Sources and limits

| Source | What is captured | Cadence / limits |
| --- | --- | --- |
| Live Client `/liveclientdata/eventdata` | Every new event, including unrecognized names, redacted payload, source game time, revised payloads under the same event ID, request/receipt times | 250/500/1000 ms after the previous request finishes; 2 s retry when unavailable |
| Live Client `/liveclientdata/allgamedata` | Game mode/map/time, local team where identifiable, field inventory, full redacted baseline excluding `events`, reconstructable changes, FF-named fields | 2 s after completion; events are captured separately above |
| LCU WebSocket `OnJsonApiEvent` | FF/vote-named routes and fields; gameflow/end-of-game payloads; phase transitions; route shapes/counts/top-level field names for other non-auth/non-chat routes | Push delivery; 5 s reconnect backoff; inventory flushed every ~5 s and on stop/export |
| LCU HTTP | Game phase and match ID/queue/map metadata | Phase every 1 s; session every ~5 s |
| Runtime API schemas | Full redacted schema, version, path count, candidate FF/vote routes and schema field locations | Once per game/client connection; unavailable schemas retry every 30 s |
| Runtime Help and additional client buses | Function/event/type names; advertised LCDS/service-proxy event channel subscriptions; message counts, shapes and relevant structured fields, including bounded embedded JSON | Discovery once per game/client connection, 30 s retry; additional messages use push delivery |
| Game logs | Newly appended lines matching surrender/forfeit/vote/FF or game-end terms; relative filename, read offset, unread byte count and truncation flag | Tail every 500 ms; scan newest two game-log directories every 3 s; read max 256 KB per file per tick |
| Game network logs | Newly appended numeric netstats/netlog counters with source clocks; no peer addresses or player IDs | Same bounded tail; game writes approximately 10 s aggregates, not packet-level events |
| Manual markers | Team, stage, note, UTC time and elapsed monotonic time | On button/hotkey action |

HTTP probes use loopback GET requests, plus the explicitly allowed observational
`POST /Help` operation. All other non-GET methods are blocked. A route appearing in a schema is
only a discovery; the recorder never invokes it automatically. LCU credentials
stay in memory. Connection failures and recoveries are recorded; game snapshots
include current source-health information. API responses are capped at 8 MB,
WebSocket messages at 2 MB. Polling cannot observe a transient state that begins
and ends between responses. Full field snapshots are slower than event polling.

At first connection, existing events/fields are explicitly **history/baseline**.
Events and snapshot fields first observed after a failed poll are also marked as
baseline, since their actual arrival during the gap is unknown. A source-health
record is saved about every 5 seconds, including the last successful event poll.
Newly attached log files start at EOF, with skipped bytes reported. This avoids
claiming old log lines as live observations, but can miss early lines written
before attachment. Rotation/truncation is recorded. Log-to-match association is
unverified, and log buffering can delay arrival. Secret-bearing log lines are
discarded; very long matching lines are explicitly flagged as truncated.

The generic field scanner searches key names to depth 8, up to 100 matches per
sample. The full sanitized snapshots preserve other fields for later analysis.
The recorder does not capture screen pixels, process memory or team coordination
messages. Version 3 adds optional real Windows packet capture and a narrowly
scoped client system-chat probe; see [packet capture and alignment](ff-packet-capture.md).

## Reading the file

Each line is an independent JSON record, currently format version 3. The initial `capture`
record contains app/recorder/runtime/OS versions, user-reported League patch,
label, intervals, privacy rules and timing semantics. Runtime schema versions
are recorded when available; they need not equal the League patch. Match records
and LCU metadata identify boundaries, game ID, queue/map and local team.

Common fields:

- `id`: increasing record number within this capture.
- `receivedAt`: local UTC wall-clock timestamp; useful across files only when
  clock synchronization is known.
- `elapsedMs`: local monotonic arrival time from capture start.
- `matchIndex`, `gameId`: local match segmentation and LCU game ID if known.
  A boundary may initially lack an ID. Correlate with nearby `match-info` rows.
- `gameTime`: last sampled game clock, potentially up to several seconds stale.
  `eventGameTime` is an event's own source timestamp and is a separate clock.
- `observationWindow`: event request start, response receipt and prior successful
  event response. This bounds polling uncertainty, not server latency.
- `kind`, `source`, `label`, `data`: provenance and redacted evidence.
- `stage`, `side`, `confidence`, `historical`: heuristic annotations. `unknown`
  is deliberate; a winner is never used to guess which team surrendered.

`snapshot-base.data` is the sanitized game data without the `events` envelope.
For each subsequent `snapshot-delta.data.changes`, follow its `path` array from
the root, then `set` the value or `remove` the key. Array size changes replace
the whole array. Restart reconstruction at each baseline/match boundary. All
operations are saved, even if a delta has hundreds of fields. The UI omits these
large payloads, but the exported file keeps them for discovering unknown fields.

`candidate` means a keyword/shape match needing verification. Explicit team names
or matching numeric/ORDER/CHAOS team fields are required for enemy classification.
`vote-start` and `vote-progress` remain separate from `surrender-accepted` and
`game-end`. Schemas, initial history, manual markers and later events never count
as early automatic detections. Wording heuristics can still be wrong.

The summary uses the latest marked enemy vote start and following acceptance
marker in the current match. Only nonhistorical enemy start/progress candidates
inside that window qualify. Without a start marker it considers earlier current
match candidates; inspect individual attempts before drawing conclusions. A late
start marker can exclude a real candidate. The UI says **Candidate needs
verification**, never “early detection confirmed.” The exported arrival lead is
relative to a human marker, not the actual FF decision.

The timeline shows only the latest 300 records and keeps a bounded in-memory
history. **Export copies every persisted record**, then appends an
`export-summary` with the current source status, options, errors and timing
summary. The debug log is capped at 256 MB, separate from the 2 GB raw packet
buffer; reaching the debug-log cap stops recording, including packets, with a
visible error. Start a new capture to continue. Disk-write errors also stop
recording. Original captures are append-only files under the app's configuration
directory in `ff-research/`; they survive restarts. No automatic uploads occur.

Known account/player identity and credential fields are redacted. Snapshot data
may be replaced by an explicit depth-limit marker beyond depth 40. Arbitrary
notes, route names and log text can still contain names: review before sharing.

## Analysis criteria

1. Check coverage, request durations, gaps, history flags and the exact game/build.
   A disconnected source or an unmarked vote is not evidence that a signal is absent.
2. Compare pre-vote, voting, accepted and ending windows, including unclassified
   records and snapshot deltas. Look for repeatable new fields/routes, not just
   the current keyword matcher.
3. Require local enemy-side evidence before the known acceptance decision, with
   enough margin to account for observer reaction and polling delay. An enemy
   label alone is not proof. Compare with the opponent's independent recording.
4. Test controls and both teams to reject generic game-end and own-team events.
5. Refine source readers/classification only after repeatable captures. Keep the
   raw evidence, add regression fixtures, and leave unknown fields unclassified.

Real captures now include a known own-team surrender and timestamped failed own
votes. None yielded an early vote signal in recorder version 1. See the
[failed-vote analysis and added probes](ff-capture-analysis-2026-10-17-failed-votes.md).
Synthetic tests validate recording, classification boundaries, redaction,
reconstruction, export and UI wiring; they do not establish enemy-vote visibility.

Recorder/format version 2 adds runtime Help discovery (`GET /help` for LCU and
the observational `POST /Help` for the game), discovered additional client event
buses, embedded-JSON field inspection, and `network-sample` records from appended
game network logs. Keep **Watch game logs and network counters** enabled to
include these counters in the same export. Initial log contents are skipped;
start before loading. Source-health cards distinguish a subscription request
from actual additional-bus message receipt.

`network-sample.data` preserves the source format, game/log clock, aggregate
duration when supplied, numeric counters, source file, read offset and pending
bytes. The row envelope timestamps when the recorder read it. These roughly
10-second counters are not per-packet capture or automatic surrender detections.
Log game association and aggregate interval alignment remain unverified. The
last CSV row may summarize the whole session. Peer IPs and player IDs are excluded.
Runtime Help inventories are discovery evidence, never observed votes. No screen,
Overwolf, RAM scanning or gameplay automation is part of version 2.

Local validation on 2026-10-16: the read-only probe reported `ECONNREFUSED` for
the game API and no LCU lockfile. Two existing game log files were attached at EOF;
no matching new lines were observed. The Electron self-test exercises start,
manual markers, distinct early/later stages, stop and full-file export with
explicitly synthetic data. Run `node --test test/ffResearch.test.js` for recorder
regressions, or `npm test` for the full suite.
