# Finding an earlier surrender signal

Research date: 2026-10-17. Branch: `ff-detecting`.

**Follow-up:** the user has excluded screen recognition and Overwolf. The plan
below is retained as earlier research, not the active implementation direction.
See the [failed-vote investigation](ff-capture-analysis-2026-10-17-failed-votes.md)
for the new client/event and network-counter probes actually implemented.

## Assessment

The known own-team surrender is a failed positive control for our current API
recorder: it captured the completed outcome, but no open vote. It does not prove
that all detection is impossible. The game renders our vote panel, so our client
has information that the recorded API responses did not expose. Whether an
opposing client receives comparable information remains a separate question.

The next experiment should establish a reliable own-vote observation and compare
other sources against that observation. Faster polling of the same event list is
not a demonstrated fix. A short unobserved transient remains possible, but simply
reducing the interval would not make an omitted field appear.

## Additional evidence checked

The known-FF capture is
`ff-2026-10-16T14-17-07-029Z-cc5d00.jsonl`, game `8015141398`, KIWI queue 2400.
See [the detailed capture analysis](ff-capture-analysis-2026-10-16-own-surrender.md).

Additional files inspected locally, without copying their raw contents into the
repository or export:

- `Logs/GameLogs/2026-10-16T16-17-08/*_netlog.txt`: network-status diagnostics;
  no surrender/forfeit/concede/vote/standalone-ff keyword match.
- The same game's `*_netstats.csv`: counters for traffic, latency, packet loss,
  replication, and frame time; no vote field or matching keyword. These counters
  do not identify a surrender, and traffic changes alone would be ambiguous.
- Launcher session `2026-10-16T15-51-17_33328_LeagueClient.log`: ten matching
  keyword occurrences, all honor-vote related; no surrender-start message.
- Corresponding `34428_LeagueClientUx.log`: no matching keywords.
- Corresponding `LeagueClient-tracing.json`: surrender terms occur in queue
  configuration and end-of-game telemetry. Vote terms additionally occur in
  startup voting data and honor routes. No explicit open-surrender event found.
  This is a semantic/keyword inspection, not proof against opaque numeric events.

The game API schema saved in the capture has 26 paths, including **POST `/Help`**,
**POST `/Subscribe`**, and `/Unsubscribe`. The Help description says it enumerates
available functions/types; Subscribe accepts an event name. The prototype did
not interrogate Help or test this game-side event mechanism. Their presence does
not establish that a surrender event exists, or that HTTP subscription alone
would provide a usable stream.

LCU schema discovery returned 404. Also, unrelated LCU push payloads are scanned
for matching field names rather than retained in full. Nested JSON strings and
generic numeric fields can escape that scan. We should describe this as a
coverage limitation, not claim that every internal client message was captured.
No running LCU connection was available for a fresh runtime discovery probe
during this investigation.

## Sources ranked for the next experiment

| Source | What it could add | Enemy early-vote relevance |
| --- | --- | --- |
| Game-window vote-panel recognition | Detect our panel appearing, changing, and disappearing; save timestamped evidence and use it as the positive control | Cannot reveal an enemy panel that is not rendered on our screen |
| Game API Help and event discovery | Enumerate available interfaces, then test explicitly discovered observational events; compare push and polling | Unknown; useful only if an actual pre-acceptance event is exposed |
| Overwolf in-game chat events | A separate provider exposes chat messages; test whether system vote messages are included | Unknown; documentation does not promise private opponent votes or even surrender system messages |
| Additional logs / tracing | Already inspected for the known own FF; may help audit recorder coverage | No early semantic signal found; lower priority than the above |
| Consenting opponent's app relaying its own detected panel | Acquire the observation on the computer where that vote is visible, then relay it | Plausible early source, but requires an opponent participating; five allied installations alone do not provide it |
| Packet or process-state investigation | Could investigate information delivered to the local game beyond public APIs | No verified current vote decoder or evidence that enemy-open votes are sent to this client; not a ready implementation path |
| Spectator/replay feed | Potential independent perspective for offline comparison | Must establish event availability and delivery latency independently; a replay event or delayed observer update is not an early live signal |

Overwolf's [official League event reference](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/)
documents a `chat` event but no surrender event. Its announcer list includes
victory/defeat, not surrender initiation. Its `panel_location` feature currently
documents the scoreboard, not the surrender panel. The chat documentation says
content is for real-time use and should not be logged: any experiment must process
it transiently and avoid exporting raw chat. Verify permitted derived telemetry
before persisting it. An ordinary player typing "ff" would not constitute evidence
of a server vote, so text matching alone is insufficient.

## Concrete next prototype

1. **Add an opt-in visual source to FF Research.** Select the actual game window
   and show a crop preview for the surrender panel. Capture frames at a proposed
   10 Hz initially; measure the actual rate and recognition latency. Detect panel
   structure plus text/colored vote indicators, with consecutive-frame confirmation.
   Calibrate against real frames rather than inventing a template. Do not assume
   a fixed panel location, UI scale, resolution, language, or game mode.
2. **Preserve frame time separately from recognition time.** A detection delayed
   by OCR is not an earlier observation. Keep a bounded crop ring buffer and
   optionally save crops around transitions for review. A disappearing panel
   alone means `closed-unknown`, not `passed`: it could have failed or timed out.
   Capture failure, a minimized window, and black/stale frames must be visible
   source-health failures rather than "no vote."
3. **Add read-only discovery beyond the current schema fetch.** Specifically
   interrogate the declared Help operation, record response/status and discovered
   event names, and validate the event transport. Try documented schema versions
   as fallbacks for LCU discovery. Do not invoke arbitrary discovered functions
   or treat a generic Subscribe endpoint as evidence of surrender support.
4. **Make the export useful for comparisons.** Include source/version, match and
   team identity, patch/mode, UTC and monotonic timestamps, source game time,
   request/frame timings, source outages, crop bounds and frame dimensions,
   language/UI scale when known, detector confidence/version, and human labels.
   Export an explicitly selected evidence bundle containing JSONL plus relevant
   crops; avoid full-screen or unrelated chat capture by default.
5. **Keep stages and team attribution explicit.** `vote-open`, `vote-progress`,
   `vote-failed`, `vote-accepted`, `game-end`, and `closed-unknown` remain distinct.
   Store the evidence supporting team/stage attribution. A successful enemy
   surrender announcement is acceptance evidence even if the Nexus animation
   has not finished. It is never evidence of detecting the vote before it passed.

Electron already provides [window capture](https://www.electronjs.org/docs/latest/api/desktop-capturer).
[Tesseract.js](https://github.com/naptha/tesseract.js) is a possible local OCR
implementation; recognition performance and game-window capture need validation
in this app's installed Electron version. A native alternative is
[Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture),
which exposes a frame timestamp. The documented
[Windows OCR API](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr)
requires package identity for supported desktop use, so do not assume it is a
drop-in dependency for the current app packaging.

## Test that separates voting from ending

Use a consenting custom-game group with recordings on both sides, when the mode
and team sizes permit the intended votes. First open an own-team vote and leave
it unresolved for several seconds, then reject it or let it expire. Repeat a
passed own vote, failed enemy vote, and passed enemy vote; retain a normal-ending
control. Record the visible opening and acceptance separately. A failed enemy
vote is especially valuable because it has no game-end event to misclassify.

Compare the timestamps of automatic observations against reviewed frames, not
only manual hotkeys, which include reaction delay. For two computers, measure
clock offset/uncertainty and relay round-trip time; do not subtract their raw
wall-clock timestamps and call that detection latency.

Acceptance criteria: an own-vote detector must fire while a failed vote is visibly
open, and remain quiet on unrelated popups. An enemy-early candidate must be
observed on the receiving side before the other side's reviewed acceptance, with
enough margin to exceed timing uncertainty, and reproduce on additional trials.
Until then, keep every enemy-early source unverified.

This update records research and a proposed implementation. It does not add a
visual detector, install Overwolf, subscribe to new live sources, or automate votes.
