# XMPP queue-start relay research

Status: the preferred custom-IQ design is implemented on the
`codex/explore-lobby-queue-start` beta branch for two-PC testing. Riot-to-Riot delivery still needs
validation with two different tool-enabled accounts.

Last updated: 2026-07-11

## Goal

Allow a non-leader in a League lobby to press a button in Account Switcher that asks the lobby
leader's Account Switcher installation to start matchmaking. The leader should not need to notice a
chat message or click anything, but must have opted in to accepting requests.

The desired flow is:

1. Both players are in the same League lobby and both have Account Switcher running.
2. The non-leader's tool recognizes that the leader's tool is reachable.
3. The non-leader sends a short-lived queue-start request.
4. The leader's tool validates the request against its own live lobby.
5. The leader's tool starts matchmaking through its local LCU connection and returns an
   acknowledgement.

The testing implementation uses an additional persistent Riot XMPP resource with negative message
priority, ordinary presence for resource discovery, custom IQ capability probes, and custom IQ
queue-start requests. It does not send a `<body>` or call the League chat-conversation endpoints.
Per-friend permission is stored by authenticated Riot PUUID. The receiver re-reads its live lobby
and checks leadership, party identity, current membership, queue selection, readiness, restrictions,
request age, replay, and rate limits before calling LCU.

## What the live LCU test proved

On 2026-07-11, a direct non-leader bypass was tested in a real two-player lobby:

- The local account was explicitly reported as `isLeader: false`.
- The other member was explicitly reported as `isLeader: true`.
- Both members were ready.
- The lobby reported `canStartActivity: true` and had ranked solo queue (`queueId: 420`) selected.
- `POST /lol-lobby/v2/lobby/matchmaking/search` returned HTTP 400 with
  `INVALID_PERMISSIONS`.
- The lower-level `POST /lol-matchmaking/v1/search` path failed as an invalid function for the
  current teambuilder flow.
- Gameflow remained `Lobby` and no matchmaking search was created.

Conclusion: the disabled leader-only button is not the only restriction. The LCU/lobby service
rejects a start request authenticated as a non-leader. Any working design therefore needs the
leader's installation to receive the request and make the normal LCU call locally.

## Can XMPP carry this without creating a real chat message?

Theoretically, yes.

XMPP has three stanza primitives:

- `message` for pushed data;
- `presence` for availability/capability announcements;
- `iq` for request/response exchanges.

All three may contain application-specific XML elements in their own namespace. A `message` stanza
does not need a human-readable `<body>` to carry an extension payload. Such a stanza is still
technically an XMPP message, but it is not necessarily a League chat message that should appear in
the conversation UI.

For example, a tool-to-tool request could conceptually be a bodyless stanza containing only a
namespaced `queue-start-request` element. The official League resource would not understand that
element and should ignore it; the Account Switcher resource would recognize it. An `iq type="set"`
request is even closer to RPC semantics because XMPP defines IQ as a request/response primitive.

This is standards-compliant XMPP behavior, but it is not yet confirmed Riot behavior. Riot's chat
server might:

- route the unknown payload unchanged;
- strip unknown child elements;
- reject client-to-client IQ requests;
- deliver a bare-JID message only to the official League resource;
- archive or surface a bodyless message as a blank/odd chat entry;
- close a connection that sends stanza shapes it does not expect.

Those questions require a controlled two-account, two-installation probe. Until that probe is done,
"invisible XMPP control packet" is a strong possibility, not a proven capability.

## Best stanza choices

### 1. Custom IQ request: preferred first experiment

Use an `iq` request with a custom Account Switcher namespace and require a matching IQ result or
error.

Advantages:

- naturally supports request, acknowledgement, rejection, and timeout;
- has no chat body and should not be treated as conversation content;
- can distinguish unsupported official League resources from a tool resource that responds;
- can double as a capability probe.

Risks:

- Riot may not route client-to-client IQ stanzas;
- the request needs the tool's full resource JID for reliable delivery;
- unsupported resources may return an error rather than silently ignore it.

### 2. Bodyless custom message: preferred fallback

Send a normal XMPP `message` stanza containing a custom extension and no `<body>`, then send a second
bodyless message as the acknowledgement.

Advantages:

- message routing is more likely to be enabled because Riot chat already depends on it;
- no visible text needs to be sent;
- the payload can carry a protocol version, request ID, timestamp, party ID, and signature.

Risks:

- Riot or the League client might still create a blank conversation entry;
- delivery and acknowledgement need to be implemented by the tool;
- message archiving could retain the opaque payload.

### 3. Presence: discovery only

Presence is a good place to announce "this XMPP resource supports Account Switcher queue relay," but
it is a poor place to send the actual start command. Presence is broadcast-style state, not a
transaction, and it has no built-in acknowledgement.

## How automatic tool discovery could work

### Option A: resource-level capability probe — recommended

This avoids modifying a user's visible League status.

1. The tool keeps a persistent XMPP connection for the current account.
2. It sends ordinary XMPP presence so friends can observe that resource.
3. The other tool retains every full JID seen for a PUUID, not just the bare PUUID.
4. When the user is a non-leader, it looks up the leader's PUUID from the live lobby.
5. It sends a custom capability IQ to each observed full JID for that leader.
6. The official League resource ignores or rejects the unknown capability.
7. The Account Switcher resource responds with its protocol version and supported commands.
8. The UI shows `Start via leader` only while a recent valid response is cached.

This only probes the relevant lobby leader instead of advertising to or probing the entire friend
list. A small availability badge could still be shown in the Friends view after a successful
capability response.

The critical detail is the full JID. An account can have several XMPP resources at once: the normal
League client, mobile clients, and the Account Switcher connection. Sending to only the bare JID can
allow the server to choose a different resource. Sending to the exact full JID that answered the
capability probe targets the tool connection.

### Option B: advertise a custom capability in presence

The tool could add a small namespaced element to its presence, for example a protocol version and a
`queue-start` capability. Tools that already receive friend presence could recognize it immediately.
Unknown XMPP extensions are meant to be ignored by clients that do not implement them.

This gives the nicest zero-setup friend-list experience:

- tool-enabled friends can receive a badge automatically;
- protocol versions can be negotiated;
- no repeated capability probing is necessary.

However, it is more global: every friend authorized to receive presence could potentially inspect
the marker. It also depends on Riot preserving custom presence children and on the extra resource
not changing the user's visible online state.

The standard XMPP version of this idea is Entity Capabilities (XEP-0115) plus Service Discovery
(XEP-0030). A simpler first probe could use a private namespaced presence child. If Riot passes that
through, a later design can decide whether full XEP-0115 support is worthwhile.

### Option C: explicit pairing plus XMPP reachability

Each friend pairs the two installations once, using a short code, copied public key, or QR code. The
tool stores the friend's PUUID and public key. XMPP is then used only to locate the current resource
and carry signed requests.

This is the most dependable trust model and avoids accepting requests from every friend who happens
to install the tool. It is slightly less magical than automatic discovery, but pairing can be made a
one-time action.

A good compromise is:

- automatically detect that a lobby member supports the protocol;
- show `Tool detected`;
- require one explicit `Allow queue requests from this friend` action before accepting commands.

### Option D: zero-width or empty status marker — not recommended

Adding an invisible character to the League status looks simple, but it is brittle:

- Riot may trim, normalize, reject, or rewrite it;
- fonts and clients can render supposedly invisible Unicode visibly;
- it modifies user-facing account state and may sync between machines;
- other tools can copy the marker, so it proves neither identity nor permission;
- a normal League client can overwrite it whenever presence changes;
- it identifies the account, not a particular running Account Switcher instance.

It could be tried as a disposable diagnostic, but it should not become the real discovery protocol.
A custom presence extension or resource-level capability response solves the same problem without
abusing user-visible status text.

## How this fits the current implementation

The repo already has most of the difficult Riot authentication work:

- [`src/core/friendPresencePoc.js`](../src/core/friendPresencePoc.js) decrypts a saved session,
  mints fresh Riot access/PAS/entitlement credentials, opens TLS/XMPP, binds a PUUID-mode resource,
  requests the roster, and receives presence.
- [`src/core/lcu.js`](../src/core/lcu.js) can make the leader's local matchmaking-start request.
- [`src/core/lobbyInvite.js`](../src/core/lobbyInvite.js) already inspects the current lobby, party
  ID, local PUUID, and member PUUIDs.
- [`src/core/clientMonitor.js`](../src/core/clientMonitor.js) already runs background LCU monitoring
  while the app is in the tray.
- [`docs/friends-persistent-xmpp.md`](friends-persistent-xmpp.md) already outlines turning the
  one-shot Friends connections into persistent connections.

What is missing today:

- The Friends XMPP connection is deliberately one-shot. It sends `<presence/>`, waits briefly, and
  closes the socket.
- The bind response is consumed but the assigned full JID/resource is not retained.
- Roster parsing keeps the PUUID but drops the roster item's full JID.
- Presence parsing sees a full `from` JID, but the merged friend model ultimately collapses friends
  by PUUID and does not retain all active resources.
- Only presence stanzas are parsed; custom messages and IQ requests are not handled.
- There is no peer capability cache, pairing/allowlist, request protocol, or acknowledgement path.

This makes the feature a meaningful extension rather than a tiny endpoint addition, but it aligns
well with the planned persistent-XMPP architecture.

## Suggested peer protocol

Discovery records should identify a running installation, not merely an account:

- protocol name and version;
- account PUUID, taken from the authenticated XMPP identity;
- random installation ID;
- installation public key;
- supported commands, initially only `queue-start`;
- current full resource JID;
- short expiry/last-seen time.

A queue-start request should contain:

- protocol version;
- unique request ID/nonce;
- creation and expiry timestamps, with a lifetime of only a few seconds;
- the party ID observed by the sender;
- sender and intended leader PUUIDs;
- requested command (`queue-start` only);
- a signature from the paired installation key.

The receiver should trust the authenticated XMPP `from` address more than identity fields claimed
inside the payload. Payload identity fields are useful for consistency checks, not as the source of
truth.

The acknowledgement should report only a compact result:

- accepted and matchmaking started;
- rejected because the sender is not in the lobby;
- rejected because the receiver is not leader;
- rejected because the party ID changed;
- rejected because the lobby is not ready or has restrictions;
- rejected because the request expired, was replayed, or was rate-limited;
- unsupported protocol version or command.

## Required safety checks on the leader's installation

Receiving an authenticated XMPP packet is not enough to start a queue. Immediately before the local
LCU call, the leader's tool must independently verify:

1. Queue-start relay is enabled locally.
2. The sender's PUUID is explicitly allowed, ideally through pairing.
3. The request signature is valid when paired keys are used.
4. The request is fresh and its nonce has never been processed.
5. League gameflow is exactly `Lobby`.
6. The receiver's local lobby member is the leader.
7. The sender's PUUID is currently a member of that same lobby.
8. The receiver's current party ID matches the request party ID.
9. The lobby has a queue selected and is allowed to start.
10. There are no current lobby restrictions, readiness problems, or an existing search.
11. The same sender has not requested another start within a short cooldown.

The feature should be disabled by default, enabled per friend, log every accepted/rejected request,
show a local notification when a remote request starts matchmaking, and never automatically retry
after a rejection or cancellation.

## Multi-resource and presence concerns

This is the largest protocol uncertainty.

The official League client and Account Switcher would be separate XMPP resources for the same Riot
account. XMPP supports that, but Riot-specific behavior needs validation:

- Does a second authenticated resource remain connected reliably?
- Does sending presence from it make the account appear online or alter the displayed status?
- Does Riot merge presence from multiple resources, and which resource wins?
- Does bare-JID message routing choose only one resource?
- Are full-JID messages and IQ requests routed to the intended resource?
- Does the server preserve custom extension elements?
- Does an idle resource need pings or periodic presence to stay connected?
- What happens when the official League client reconnects or the account switches?

The current Friends snapshot connection already creates an additional XMPP resource and sends
presence briefly, so the repo has some evidence that multiple connections are accepted. It has not
yet tested long-lived coexistence or application-specific stanzas.

Directed presence is another possible refinement. Instead of broadcasting the tool capability to
the entire roster, a tool can send presence addressed only to paired friends or the current lobby
leader. XMPP Core permits directed presence. Whether Riot delivers it without side effects still
needs a live test.

## Recommended experiment order

No feature code should be designed around invisible delivery until these probes succeed with two
accounts and two running tool instances:

1. Keep two raw Riot XMPP connections alive and record the full JIDs returned by resource binding.
2. Confirm both tool resources receive ordinary presence while the League clients remain connected.
3. Send a custom IQ capability request to the other tool's full JID.
4. If IQ is blocked, send a custom bodyless message to the full JID.
5. Verify the raw receiver gets the payload unchanged.
6. Verify neither League client shows a blank message, conversation, toast, sound, or status change.
7. Repeat using a bare JID to document Riot's resource routing behavior.
8. Test custom presence capability advertising and directed presence.
9. Disconnect/reconnect League and Account Switcher in different orders.
10. Test sleep/resume, account switching, token expiry, and stale resource cleanup.
11. Only after the transport is proven, send a harmless ping/ack protocol.
12. Finally test a queue-start request in an unranked lobby, with immediate manual cancellation
    available.

Each probe should capture raw sent/received stanza shapes with access tokens and PAS tokens fully
redacted. It should also watch the normal League UI and LCU chat events so a supposedly invisible
packet cannot accidentally become visible conversation content.

## Recommended direction

The strongest design to pursue is:

1. Persistent XMPP connection for the currently active account.
2. Explicit per-friend permission stored by PUUID and installation public key.
3. Resource-level capability probing for the current lobby leader.
4. Custom IQ request/response if Riot routes it; bodyless custom messages as fallback.
5. Presence capability advertising only if testing proves it has no visible status side effects.
6. Strict same-party and leader validation immediately before the local LCU call.

This can provide a genuinely invisible, serverless, Riot-identity-backed control channel. If Riot
filters custom stanzas or routes them only to the official client resource, the next-best option is a
small external WebSocket relay with the same pairing and lobby-validation rules. A visible League
chat command should remain a last-resort fallback, not the primary design.

## Standards and Riot references

- [RFC 6120: XMPP Core](https://www.rfc-editor.org/rfc/rfc6120.html) defines message, presence, and IQ
  stanzas, application-specific extension elements, full/bare JIDs, persistent streams, and directed
  presence.
- [XEP-0030: Service Discovery](https://xmpp.org/extensions/xep-0030.html) defines capability
  queries between XMPP entities.
- [XEP-0115: Entity Capabilities](https://xmpp.org/extensions/xep-0115.html) defines advertising
  client capabilities through presence.
- [Riot's League Client API policy](https://support-developer.riotgames.com/hc/en-us/articles/22698698001939-League-of-Legends)
  states that LCU is unsupported for third-party use, provides no stability guarantees, and asks
  developers to register and disclose endpoint usage.
