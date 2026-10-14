# Chat delivery and history

The active League account uses a session-pinned LCU transport. It verifies the immutable player
identity, creates a missing direct conversation, and accepts a send only when League returns the
matching body and a real message ID. This path needs no separate remote authentication exchange.
Inactive accounts use their saved session through XMPP. Account switching disconnects chat before
closing the old client; callbacks and pending connections from older generations are ignored.

Messages use the same Riot IDs across local sends and later history, so the service deduplicates both
send-result and polling paths. Historical messages are sorted by their original timestamp and do not
create unread alerts, even when Riot delivers them after the initial poll. System/room events are
excluded. Invalid historical timestamps have a stable oldest-date fallback. Closed conversations
retain their encrypted local history, and edits to the next draft survive a pending send.

## Live validation, 2026-10-14

Only Umisteba, Nueluclor and Dr Bonk were used during this work. A controlled Umisteba-to-Dr Bonk
message sent over the offline XMPP transport arrived exactly once. After switching into Umisteba,
the first read of a newly created client conversation returned no chat history. A subsequent read
and opening the conversation showed the original outgoing bubble, with the exact same message ID
and `isHistorical=true`. Native history arrives asynchronously; an immediate empty read is not
evidence of lost delivery. No replay/import mechanism was added.

Riot returned unsupported-service errors for the standard [Message Carbons](https://xmpp.org/extensions/xep-0280.html)
and Message Archive Management probes. A separate bounded local `system` message test did not reach
the recipient but was not rendered as ordinary chat; that approach was rejected. Test text stayed
within the two approved accounts.

The corrected live-client transport sent a second controlled message, received once by Dr Bonk,
returned a concrete League ID and observed one matching poll echo. No `joined_room` events escaped
normalization. Automated tests cover delayed history, early send echoes, draft edits, concurrent
opens, connection cancellation, stale callbacks, wrong-account rejection, missing send responses,
closed history, and system-event filtering.
