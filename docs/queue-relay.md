# Queue Relay

Queue Relay lets a non-leader ask the lobby leader's Account Switcher to start matchmaking. Both
players must run Account Switcher, the leader must explicitly allow that Riot account, and both
players must still be members of the same live lobby.

The two-PC flow was successfully validated with two different Riot accounts on 2026-07-11. It uses
custom Riot XMPP IQ stanzas and does not send a League chat body or call a chat-conversation
endpoint.

## Setup and use

1. Both players run Account Switcher and sign in to League with an account already saved in it.
2. Both open the Friends tab and wait for Queue Relay to show `Riot XMPP connected`.
3. Join the same League lobby.
4. The leader opens Friends -> Queue Relay and waits for the other member to show
   `Queue Relay detected`.
5. The leader enables `Allow queue starts` for that member. The permission is stored by Riot PUUID.
6. After the next capability response, the non-leader's `Start via leader` button becomes enabled.
7. The non-leader clicks it. The leader's Account Switcher revalidates the live lobby and asks the
   leader's local League client to start matchmaking.

The button remains disabled when the leader's relay is not detected, the leader has not opted in,
either side is not in the same lobby, the lobby is already searching, or League reports that the
lobby is not ready to queue.

## Communication flow

1. Account Switcher reads fresh access and entitlement credentials from the signed-in local League
   client, then exchanges the access token for a short-lived PAS chat credential. This does not
   depend on the account's saved Friends session being replayable. The encrypted saved session is
   retained only as a fallback while the local credential endpoints are temporarily unavailable.
2. It opens a second authenticated XMPP resource beside the official League client resource and
   announces ordinary presence with negative priority. The announcement is refreshed periodically
   and immediately when joining a lobby so other Account Switchers do not forget the relay resource
   during games or post-game screens.
3. Presence reveals each friend's full XMPP resource address. Queue Relay sends a custom capability
   IQ to the resources associated with a member of the current lobby.
4. Another Account Switcher resource answers with its protocol version and whether the authenticated
   sender's Riot PUUID is allowed. Official League client resources do not answer this extension.
5. Clicking `Start via leader` sends a short-lived custom IQ request directly to the detected leader
   resource. It contains a request ID, party ID, sender PUUID, issue time, and expiry time.
6. Riot authenticates the XMPP sender. The leader derives the requesting PUUID from the stanza's
   authenticated `from` address rather than trusting the payload's claimed identity.
7. The leader re-reads `/lol-lobby/v2/lobby` and verifies permission, request freshness, replay and
   rate limits, Lobby gameflow phase, leadership, matching party ID, sender membership, selected
   queue, readiness, and restrictions.
8. Only after all checks pass does the leader call its local
   `POST /lol-lobby/v2/lobby/matchmaking/search` endpoint.
9. The leader returns a custom IQ result with an accepted or rejected status and a reason code. The
   sender uses that response to update the UI.

No `<message><body>` stanza is sent, so the protocol does not create a visible chat message,
conversation, notification, or chat sound.

## Permissions and safety

- Permission is opt-in and stored in `switcher-settings.json` as allowed Riot PUUIDs.
- A request is accepted only from an authenticated allowed PUUID that is in the leader's current
  party at the moment of validation.
- Requests expire after 10 seconds and duplicate request IDs are rejected.
- Rate limiting prevents repeated remote queue-start attempts.
- The leader's local LCU remains the only process that actually starts matchmaking, so League still
  applies all normal queue, role, penalty, and readiness rules.

## Troubleshooting and logs

Right-click the tray icon and choose **Open logs**, or open:

```text
%APPDATA%\LeagueClientAutomation\switcher.log
```

Useful milestones include:

- `Queue relay: matched active saved account`
- `Queue relay: connected`
- `Queue relay: observed XMPP resource`
- `Queue relay: capability probe sent`
- `Queue relay: capability probe received`
- `Queue relay: peer confirmed`
- `Queue relay: permission allowed`
- `Queue relay: queue-start received`
- `Queue relay: validation`
- `Queue relay: matchmaking started`
- `Queue relay: queue-start response`

If the relay does not connect, confirm that League is running, the currently signed-in League
account exists in the Accounts tab, and the current account panel shows League Client as online.
Access tokens, PAS tokens, entitlement tokens, cookies, passwords, and raw saved-session contents
are not written to the Queue Relay logs.
