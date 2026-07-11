# Persistent XMPP Friends connections

## Why this is the next architecture improvement

The current Friends refresh is a snapshot operation. For every selected source account it authenticates a saved Riot session, opens a TLS/XMPP connection, completes the Riot chat handshake, downloads the roster, listens for presence messages for one second, and closes the connection. Aggressive mode correctly runs the network work in parallel, but repeating nine XMPP handshakes every refresh is still unnecessary work.

The first optimization keeps this snapshot design while caching the short-lived auth bundle and batching DPAPI decryption. A live probe on 2026-07-11 found a 60-minute Riot access token and a 30-minute PAS chat token, so the cache uses the shorter lifetime with a safety margin. This removes the expensive repeated authentication path without changing roster behavior.

Persistent XMPP would go further. XMPP is a live stream: after the initial roster request and presence announcement, Riot sends presence changes on the existing socket. Keeping one authenticated connection per selected source account would make updates fresher while removing repeated TLS handshakes, roster downloads, and fixed one-second collection windows.

## What was measured

With nine accounts in aggressive mode on a Ryzen 9 9950X3D:

- A snapshot refresh took roughly 4.1-4.4 seconds.
- The old cold-auth burst started nine hidden PowerShell processes and peaked around 31-36% total CPU across 32 logical processors.
- Electron itself peaked around 2.1%; the PowerShell DPAPI children caused about 30.6% of the burst.
- The process tree briefly approached 1 GB of working set.
- One batched DPAPI helper completed nine decryptions faster than nine parallel helpers in the focused measurement and used far less CPU and memory.

Most remaining refresh time is network protocol work: XMPP connection/handshake, roster response, and the one-second presence drain.

## Suggested design

Create a main-process Friends connection manager keyed by saved account ID. Each account connection should own:

- The saved-session snapshot version it was created from.
- The cached Riot access, PAS chat, entitlement, user-info, and affinity data.
- Its TLS socket and an incremental XMPP stream parser.
- The latest roster and presence state for that source account.
- Connection state, last-message time, retry count, and next retry time.

When the selected source set changes, reconcile it with the connection map:

1. Start connections for newly selected accounts.
2. Keep healthy existing connections untouched.
3. Close and remove connections for deselected or deleted accounts.
4. Reconnect an account when its saved-session version changes.

After authentication, request the roster once, announce presence, then keep consuming roster and presence pushes. Merge the per-source state into the same response shape the renderer already uses. Renderer updates should be coalesced briefly, for example over 50-100 ms, so a burst of XMPP stanzas produces one UI update rather than one render per stanza.

## Reconnection and correctness rules

- Use exponential backoff with jitter for network failures, capped at a reasonable delay.
- On XMPP authentication rejection, invalidate the cached auth bundle, mint fresh credentials once, and reconnect.
- Refresh credentials before reconnecting when the PAS token is near expiry. An already authenticated healthy socket may remain usable, but do not assume that indefinitely; reconnect cleanly when the server closes it.
- Detect half-open sockets with idle timeouts or protocol-level keepalives and reconnect them.
- Keep the last known roster visible while marking its source stale or reconnecting, rather than dropping the entire merged list immediately.
- Preserve the scan-source suppression rule so opening several source connections does not make those accounts look falsely online.
- Keep detailed per-account connection, roster, presence, retry, and timing logs. Batch disk writes, but do not reduce diagnostic content.
- Shut all sockets down cleanly on app exit and when an account is deselected.

## Rollout approach

Implement this behind the existing snapshot interface first, so the renderer does not need a large rewrite. The manager can expose an initial snapshot plus pushed updates through IPC. Keep the current one-shot fetch as a fallback while persistent connections are validated against disconnects, account switching, session replacement, sleep/resume, and Riot service interruptions.

The persistent design should be measured with the same nine-account setup. Compare CPU, working set, network traffic, event-loop delay, reconnect behavior, and time-to-visible presence change against the optimized snapshot refresh.
