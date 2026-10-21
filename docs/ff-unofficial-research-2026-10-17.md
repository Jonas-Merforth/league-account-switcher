# Unofficial surrender detection: public implementation research

Checked 2026-10-17 on `ff-detecting`, after implementing recorder version 2.
Scope: public source inspection of packet decoders, server reconstructions,
memory readers, and existing surrender-related tools. No external project was
installed, compiled, injected, or run. Screen recognition and Overwolf remain
excluded from the proposed implementation.

## Finding

**Low-level surrender-vote decoding has been implemented publicly.** Historical
LeagueSharp and LeaguePackets source distinguishes an open/in-progress vote from
its result. That is more relevant than keyboard macros or postgame API flags.

**A working current-build pre-acceptance enemy-vote detector was not found.**
The strongest routing evidence found is an old server reconstruction that sends
open-vote updates only to the voting team. This is not Riot's current server
source and cannot establish today's behavior, but it identifies the critical
remaining test: whether the opposing client receives any pre-acceptance state.

## Verified projects and what they establish

### LeagueSharp.Common: an actual receive-side decoder

Inspected commit `f21214022ffc7d35fb31bc922f0a4763060d59a2`
(repository tip dated 2017-01-10).

[Packet.cs: surrender and result decoders](https://github.com/LeagueSharp/LeagueSharp.Common/blob/f21214022ffc7d35fb31bc922f0a4763060d59a2/Packet.cs#L5006-L5143)
contains separate receive-side `Surrender` and `SurrenderResult` parsers. The
vote parser extracts player network identity, yes/no counts, maximum votes and
team. The result parser handles the completed decision separately. This is
source-level implementation evidence, not just a forum claim that a decoder
could be built.

However, the [file's own version warning](https://github.com/LeagueSharp/LeagueSharp.Common/blob/f21214022ffc7d35fb31bc922f0a4763060d59a2/Packet.cs#L9-L12)
says it was not updated past patch **4.21**. Its old packet IDs and field offsets
must not be applied to current encrypted/raw traffic. A decoder accepting a team
field also does not prove it receives both teams' open-vote messages.

### LeaguePackets: explicit open-vote, result, and eligibility structures

Inspected commit `207baab80dc4cd203dd2d41ce9d98f1aae7a1544`
(repository tip dated 2022-07-17). Its [README](https://github.com/LeagueSandbox/LeaguePackets/blob/207baab80dc4cd203dd2d41ce9d98f1aae7a1544/readme.md)
explicitly describes **season 4** packet structures; the commit date does not
make the protocol modern.

- [S2C_TeamSurrenderVote](https://github.com/LeagueSandbox/LeaguePackets/blob/207baab80dc4cd203dd2d41ce9d98f1aae7a1544/LeaguePackets/Game/201_S2C_TeamSurrenderVote.cs)
  has an open-menu flag, vote choice, player network ID, for/against counts,
  player count, team and timeout.
- [S2C_TeamSurrenderStatus](https://github.com/LeagueSandbox/LeaguePackets/blob/207baab80dc4cd203dd2d41ce9d98f1aae7a1544/LeaguePackets/Game/165_S2C_TeamSurrenderStatus.cs)
  has a reason, vote counts and team. It is distinct from the open-vote packet.
- [S2C_SetCanSurrender](https://github.com/LeagueSandbox/LeaguePackets/blob/207baab80dc4cd203dd2d41ce9d98f1aae7a1544/LeaguePackets/Game/270_S2C_SetCanSurrender.cs)
  contains eligibility, which is not evidence that a vote has opened.
- [ArgsSurrenderVotes](https://github.com/LeagueSandbox/LeaguePackets/blob/207baab80dc4cd203dd2d41ce9d98f1aae7a1544/LeaguePackets/Game/Events/ArgsSurrenderVotes.cs)
  has for/against counts and team. This definition alone does not establish
  emission, audience, observer delivery, or timing in a modern game.

These names are research leads and useful distinctions for analysis, not a
drop-in modern wire decoder or API endpoints to call.

### LeagueSandbox GameServer: open-vote audience is restricted

Inspected commit `b37c75483abf66048af7c914e7fab700efaa5e21`
(repository tip dated 2022-09-02). The [setup documentation](https://github.com/LeagueSandbox/GameServer/blob/b37c75483abf66048af7c914e7fab700efaa5e21/README-old.md)
targets the **4.20 client**.

The [vote notifier](https://github.com/LeagueSandbox/GameServer/blob/b37c75483abf66048af7c914e7fab700efaa5e21/GameServerLib/Packets/PacketNotifier.cs#L3802-L3825)
constructs the vote-update message and calls `BroadcastPacketTeam(starter.Team, ...)`.
This is executable routing logic in that reconstruction, not merely a comment.

Its [surrender handler](https://github.com/LeagueSandbox/GameServer/blob/b37c75483abf66048af7c914e7fab700efaa5e21/GameServerLib/Handlers/SurrenderHandler.cs#L76-L118)
separately handles acceptance and failed-vote results. Acceptance is sent through
the player loop before a delayed Nexus destruction; the timeout-failure path
explicitly checks team membership. This illustrates why an acceptance message
can precede the ending animation without being an early vote signal.

Do not infer today's thresholds, timer duration, or winner-selection semantics
from this implementation. It is an old community reconstruction, with TODOs and
implementation limitations, not a specification of Riot's production server.

### LViewLoL: memory-reading precedent, no surrender reader found

Inspected `orkido/LViewLoL` commit
`49db3ea7e048e5da40ae36578e5a35b58e05b288`
(repository tip dated 2021-08-29). Its [README](https://github.com/orkido/LViewLoL/blob/49db3ea7e048e5da40ae36578e5a35b58e05b288/README.md)
describes an external process using `ReadProcessMemory`; the repository includes
[LeagueMemoryReader.cpp](https://github.com/orkido/LViewLoL/blob/49db3ea7e048e5da40ae36578e5a35b58e05b288/LView/LeagueMemoryReader.cpp)
and offset tables. A scoped scan of 229 C/C++/Python source/header files returned
no surrender/forfeit/concede identifier matches. This supports memory reading as
an existing historical technique, not an available surrender implementation.
No current surrender pointer, signature, structure, or enemy-state availability
was verified. No detection-evasion instructions from project documentation were
adopted.

### Auto-Chat and other similarly named tools

The user's [Gabattal Auto-Chat main.py](https://github.com/Gabattal/Scripts-LeagueOfLegends/blob/8fa6708d01117e2a01d993ab03f4fb2700abb619/Auto-Chat/main.py)
reads active-player name/scores from the Live Client API and uses `pynput` to
type chat. It is not a surrender-event reader. Repository tip inspected:
`8fa6708d01117e2a01d993ab03f4fb2700abb619`, dated 2022-12-06.

Public repository searches also returned surrender-history tracking and
win-probability/recommendation projects. Their descriptions target completed
matches or whether a player should surrender, not detecting a currently open
opponent vote. They were not treated as technical evidence for this feature.

## Implications for our next work

1. **Keep the new client probes, but distinguish their reach.** LCU LCDS/service
   buses and game Help discovery may improve coverage. They are separate from
   the gameplay packet receive path shown in these old decoders.
2. **For packets, test information availability before building an auto-FF feature.**
   Capture a controlled failed own vote and a controlled failed enemy vote on
   both participants' machines, with aligned timing. Obtain a current-build
   semantic identification of the own-vote message first, then determine whether
   the other side receives its counterpart. Packet lengths/timing alone are
   insufficient, and an old message ID appearing inside arbitrary bytes is not
   a match.
3. **For RAM or internal callbacks, require a current verified state source.**
   Candidate state would be the active vote flag, tally, team and deadline, or
   the parsed receive event that updates it. Such fields are hypotheses until
   validated across multiple open/failed/passed votes. A successful memory read
   does not demonstrate that the values mean a vote, nor that enemy state exists.
4. **Use recipient visibility as the decision point.** If modern vote updates
   are team-only, deeper reading of our client cannot recover an opponent's
   unreceived private update. If a verified pre-acceptance enemy update is
   present, the problem becomes decoding and latency measurement. Current
   evidence has not established that second case.

Search scope included combinations of surrender/enemy-vote/packet/memory/offset,
old scripting callback names, exact packet symbols, GitHub repository discovery,
and primary source inspection. No current reproducible enemy detector was found;
this does not rule out private, unindexed or differently named work.

Only research documentation changed in this follow-up. Historical decoders and
offsets were deliberately not installed into the app as current detections.
