# Enemy surrender detection: feasibility research

Research date: 2026-10-16. Branch: `ff-detecting`, created from `main` at
`0454917`. Research only; no feature or gameplay automation implemented.

## Finding

**There is no verified way to implement a reliable "detect their FF and surrender
before them" feature using the interfaces examined.** The missing piece is an
observable enemy vote *before it passes*. Five cooperating installations on our
team could coordinate our votes, but cannot create that missing information.

**A different outcome remains plausible:** surrendering *after* the enemy's
successful vote, during the ending animation, might still make our team lose.
Historical firsthand reports describe this. That would be a late surrender,
not winning the race to surrender first. Its behavior on the current patch and
target game mode is unverified.

This distinction matters if the intended joke is "we take the loss even though
they surrendered." Research does not justify calling that impossible, but does
not establish that an automatic version would work reliably either.

## Timing and information

The relevant sequence is:

1. An opponent initiates a vote.
2. Opponents submit their votes.
3. The server accepts their surrender.
4. Our game receives and displays the successful-surrender announcement.
5. The ending animation and result presentation complete.

This is a causal model, not a measured description of Riot's internal server
implementation. No public server contract reviewed specifies exactly when the
winner becomes irrevocable between steps 3 and 5.

Reacting to the *successful* surrender announcement cannot make our vote pass
before step 3: that event has already happened. Faster polling, reading a packet
before its text is drawn, and coordinating five computers can shorten a reaction;
they cannot reverse that ordering. An announcement arriving before the enemy
Nexus visually explodes is not evidence of an opportunity to surrender first.

Whether the server still accepts another surrender between steps 3 and 5, and
whether it changes the recorded winner, are separate empirical questions.

## Interfaces examined

| Route | Evidence and implication |
| --- | --- |
| Live Client Data API on port 2999 | Riot documents local game/player data and `GET /liveclientdata/eventdata`. The published interface has no documented surrender-vote reader or vote-submission endpoint. [Riot documentation](https://developer.riotgames.com/docs/lol#live-client-data-api) |
| Official event examples | The downloaded sample has 11 distinct event names and no surrender/vote event. It also omits an end-of-game example. This is a sample, not an exhaustive schema; absence alone does not prove an undocumented event cannot exist. [Riot event sample](https://static.developer.riotgames.com/docs/lol/liveclientdata_events.json) |
| League Client API / LCU | This is separate from the running game. Riot describes it as unsupported. No documented in-match FF control was found in the reviewed material. [Riot documentation](https://developer.riotgames.com/docs/lol#league-client-api) |
| Screen recognition | Could potentially recognize the enemy's successful-surrender announcement. It cannot reveal their earlier private voting from pixels that are not shown. Localization, hidden chat, layout and capture delay would need testing. |
| Logs or undocumented game traffic | No verified current pre-acceptance enemy-vote signal was found. An internal name or old packet example would not establish that current opposing clients receive it, or establish its timing. |
| Spectator/replay data | No verified live, pre-acceptance enemy-vote feed was found. A recorded event cannot be assumed to arrive early enough for this race. |
| Communication between app installations | Can communicate facts an installation already knows. It supplies coordination, not an earlier enemy signal. |

Only a read-only local probe was made:

```text
GET https://127.0.0.1:2999/swagger/v3/openapi.json
Result: ECONNREFUSED
```

No League game/client process was found by the accompanying process-name check.
Consequently, this research did **not** inspect the installed running-game schema,
capture a real surrender, measure a reaction window, or verify current server
behavior. No game was launched and no vote was sent.

## What enough installations would provide

The current repository already has an authenticated app-to-app capability exchange
in [Queue Relay](queue-relay.md). However,
[`fetchQueueRelayLobby`](../src/core/queueRelay.js) and
[`summarizeQueueRelayLobby`](../src/core/queueRelayProtocol.js) explicitly depend on
the `Lobby` phase. Existing discovery uses friend presence and lobby membership.
It is not an established in-game teammate protocol or an arbitrary-enemy app
discovery system.

A future in-game coordination system would still need fresh match/team identity,
explicit local opt-in, peer availability, and a measured delivery path. One
participant would initiate our vote; the others would submit their own votes.
Five installations do not grant one account five votes or bypass the game's
eligibility/cooldown rules. Launching five independent vote attempts is not an
atomic team surrender, and simultaneous attempts could arrive before a vote is
open on the receiving game clients.

If an *opponent* also opted into sharing their own team's vote, that would be a
different design. An advance message could provide earlier notice, but no such
feed was verified. It would still offer no guarantee: their team could finish
voting before the message and our votes complete the network round trips.

Relevant documented rules to account for in any experiment:

- Riot made ordinary Ranked Solo/Flex surrender available from 15 minutes with
  4/5 votes or 70% of team members. Do not generalize this to every mode, remake,
  AFK vote, or immediate completion with an unvoted fifth player.
  [Patch 13.7](https://www.leagueoflegends.com/en-us/news/game-updates/patch-13-7-notes/)
- Riot documented a three-minute team cooldown and six-minute initiator cooldown.
  [Patch 13.16](https://www.leagueoflegends.com/en-us/news/game-updates/patch-13-16-notes/)
- The published surrender/remake timeout was reduced from 60 to 25 seconds.
  The old one-minute figure is unsuitable for a timing assumption.
  [Patch 25.15](https://www.leagueoflegends.com/en-us/news/game-updates/patch-25-15-notes/)

These patch notes establish announced rules, not a fresh verification of every
mode's current behavior. The precise target mode needs its own check.

## Related work and reports

**Actual automation source:** [Roconx/auto-chat](https://github.com/Roconx/auto-chat)
monitors the local player's kills/deaths/assists and can start a surrender. Its
last commit inspected was `2dedbdccc095c0e133971a9efd478b41ea070eb1`
(2023-08-13). The
[keyboard controller](https://github.com/Roconx/auto-chat/blob/2dedbdccc095c0e133971a9efd478b41ea070eb1/src/keyboard_controller.rs#L12-L31)
uses simulated keyboard input to type `/ff`; it does not call a surrender API or
detect an enemy vote. This shows an existing local-input approach, not present-day
compatibility, Riot approval, or a solution to the detection problem. Its code
was read, not installed or executed.

**Late surrender observations:** the 2024 discussion
[What if both teams surrender in the exact same time?](https://www.reddit.com/r/leagueoflegends/comments/1gd1zky/)
contains firsthand accounts of the second team surrendering and receiving the
loss. One specifically describes reacting after the enemy's successful-vote
message. The 2019 post
[TIL: The team that surrenders last loses](https://www.reddit.com/r/leagueoflegends/comments/bxzc3b/)
describes the same general outcome.

These are historical anecdotes, not a current reproducible test or an official
rule. Other comments speculate about server ticks, team processing order and
winner precedence; those explanations were not adopted as facts. Direct Reddit
page opens failed, while search-indexed post/comment content was available.

Searches for enemy-surrender detectors, automated FF tools, LCU/live-data
surrender support and simultaneous-surrender behavior did not locate a verified
implementation of the requested complete feature. This is a scoped search result,
not proof that no private or unindexed tool exists.

## Product constraint

Riot explicitly lists acting on a player's behalf through scripting/botting and
exposing intentionally hidden information among objectionable third-party app
behaviors. Automatically casting in-game votes, especially using an opponent's
private state, raises a direct policy concern even if timing can be solved.
That assessment is an inference from the published policy, not a claim that Riot
has reviewed this proposed feature.
[Riot's third-party application policy](https://support.riotgames.com/en-us/riot/events/third-party-applications)

## Smallest useful next experiment

Before implementing automation, use a consenting custom-game group and manual
votes to answer the unresolved mechanics question:

1. Record the patch/build, mode, both teams' perspectives and final recorded
   win/loss. Avoid inferring the result from explosion order alone.
2. Have team A pass a surrender normally. Team B attempts to complete an
   **already-open** vote immediately after seeing A's success announcement.
3. Repeat with team B starting a **new** vote only after that announcement.
   These are distinct cases; an existing vote might work when a new one cannot.
4. Repeat with the sides swapped and several deliberate response delays. Also
   compare all five responding with four yes votes and the fifth uncast.
5. Observe the local OpenAPI specification and read-only live event stream during
   these trials. Establish whether any API event exists, whether it identifies
   the team, and whether it appears before or after the visual announcement.

Only after reproducing a useful late-surrender result would it make sense to
evaluate detection speed and multi-PC coordination. A manual custom-game result
would establish a mechanic; it would not by itself establish permission to ship
automatic votes.

**Decision:** do not implement a promised "surrender first" feature from current
evidence. Keep "take the loss by surrendering second during the ending" as an
unverified experiment. A separate manual team-coordination feature is technically
plausible, but does not solve enemy-vote detection.
