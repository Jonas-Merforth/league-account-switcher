# Riot authentication experiments

This document records login research and the validated background form path. The July experiments
below are historical; the current implementation is described first.

## October 2026 implementation (Riot Client 141.0.6)

Inspection of the installed renderer confirms that modern `riot-identity` completion still needs
the official renderer's hCaptcha proof when a challenge is advertised. A fresh client initially
exposes a default `auth`/`none` structure without a session ID or timestamp; it must not be submitted.
The implementation only permits the direct local API when a fully initialized session explicitly
declares `captcha.type=none`. That conditional path is unit-tested, not demonstrated by a successful
live password exchange. Rejected submissions are not retried through another input method.

The validated path uses MSAA accessibility values/actions on the real Riot form: resolve the
username, protected password, stay-signed-in checkbox and unique submit control, set both values,
verify the checkbox is checked, then invoke submit. Chromium exposed these controls through MSAA
while its UI Automation edit tree was empty. No global keyboard input or clipboard is used. Process
name and installation path restrict targeting. Unsupported layouts fall back to targeted background
input only if persistence can be verified; otherwise the official client remains available for manual
completion. Credentials travel through the child process's standard input, not command arguments.

Fresh Umisteba login succeeded through the production switch path, with authorization roughly two
seconds after form submission and a reusable persisted session. The full switch, including League
startup and settings, took about 36 seconds. Nueluclor's saved session subsequently authorized in
about three seconds. These checks used only the user's approved accounts. Challenges and MFA, if
requested by Riot, remain in the official client; unattended success is not guaranteed in those cases.

Wrapped `userinfo` JSON is now parsed correctly. Only `authorized` counts as signed in, and the
immutable PUUID (or verified login identity for older records) must match before replacing a saved
session. Unknown identity never overwrites an outgoing snapshot. This fixes missed current-account
detection that previously prevented refreshed session tokens being saved reliably.

## Safety

The accompanying `scripts/experiment-auth-flows.mjs` harness:

- closes Riot Client and League processes;
- decrypts real credentials from the local account store in memory;
- temporarily clears and replaces Riot's live session files;
- restores the original session bundle in a `finally` block; and
- must only be used with throwaway accounts.

Do not pass passwords on the command line or add credential/token output to the script. The harness
is excluded from packaged application builds because `package.json` packages only `src/**` and
`package.json`.

Run a single experiment from the repository root, for example:

```powershell
node scripts/experiment-auth-flows.mjs autotype Umisteba
```

Available modes are printed by the script's usage error. The direct and local modes contact real
Riot services and the client-oriented modes disrupt any running Riot/League session.

## Results

### Existing Riot Client autotype

The existing background autotype path successfully signed in the throwaway account `Umisteba` as
`Umisteba#1013` in about 17 seconds. The resulting access, entitlement, and PAS credentials also
authenticated XMPP and fetched the account's roster. This confirmed that the stored credentials
were valid and that the production fallback remains viable.

### Legacy direct and local credential APIs

Both the old `auth.riotgames.com/api/v1/authorization` username/password exchange and Riot Client's
legacy local credentials endpoint returned Riot's generic `auth_failure` for the throwaway accounts.
Because the same Umisteba credentials worked through Riot's real form, this response does not mean
the password was incorrect; those older exchanges no longer reproduce the current login protocol.

### Current Riot Identity flow and hCaptcha

The current Riot Client renderer performs this sequence through its local API:

1. reset current authenticator state;
2. start a `riot-identity` authentication;
3. execute the supplied hCaptcha site key and `rqdata`; and
4. complete authentication with username, password, remember flag, and the captcha proof.

The throwaway account `xpamelia` reached this modern flow and received a real hCaptcha challenge.
A hidden Electron page generated a token, including when hosted from the same random-loopback style
origin used by Riot's renderer, but Riot rejected completion with `captcha_not_allowed`. The rejection
occurred at captcha validation, before the experiment could use the result to judge the credentials.

### Trusted-renderer experiments

Riot Client's UI is an Electron renderer served from a random `127.0.0.1` port and connected to
`RiotClientServices.exe` with a short-lived remoting token. Relaunching the renderer with remote
debugging enabled caused Riot Client Services to rotate that token, leaving the controllable renderer
unauthorized. A bounded experiment temporarily enabled debugging inside Riot's installed renderer
package, but it still did not expose a usable automatable login form.

The original installed `app.asar` was restored afterward and its SHA-256 hash was verified against
the pre-test backup. The user's prior live Riot session bundle was also restored, and Riot/League
were left stopped.

## Conclusions

- Replaying a still-valid saved `ssid` remains fully clientless and is appropriate for background
  Friends/XMPP access.
- Fresh username/password authentication is not currently a simple OAuth-style exchange. Riot's
  hCaptcha and trusted-client context prevent the tested custom background flow from completing.
- Keep the working Riot Client autotype as the reauthentication fallback. Do not ship renderer
  patching, captcha bypasses, or remote-debugging injection.

Potential future directions are deliberately limited to legitimate credentials Riot accepts:

- a supported Riot password or device authorization API; or
- a reusable trusted-device or refresh credential issued and accepted by Riot.

If either becomes available, prefer it for background session repair while retaining Riot Client
login as the fallback for MFA, captcha, and account-recovery cases.

## Desktop regression checks (2026-10-14)

The login fallback uses native MSAA actions against Riot-owned windows. It now explicitly sends
Chromium's documented WM_GETOBJECT accessibility handshake before resolving the form. The later
cold-start regression below showed that this handshake alone was insufficient. Credentials remain on
stdin, the checkbox is verified before submission, and an unresolved form reports only control counts
and a fixed reason code. Shutdown includes the current Electron renderer, `Riot Client.exe`, as well
as the legacy RiotClientUx processes.

Live desktop checks used only Umisteba and Nueluclor. In the development app, two Umisteba switches
recovered from a rejected saved session (one immediately after clicking League's Sign out). A separate
Sign out, Friends Refresh, Fix failed session, Re-login sequence completed without typing credentials
manually. The refreshed session then passed the independent Friends authentication check; repair
restored the original closed-client state. The installed build is validated separately below.

The initial reported failure was not reproduced in those successful runs. Their inspector-assisted
setup missed the cold-start failure subsequently reproduced below. MFA and interactive challenges
still require the official client.

Reference: [Chromium accessibility detection](https://www.chromium.org/developers/design-documents/accessibility/).

Installed-build check: after using Riot Client's Sign Out on Nueluclor, Switch rejected the revoked
snapshot, submitted the real form with Stay signed in verified, authorized Nueluclor in 2.6 seconds
after submission, and completed League launch/settings verification. No manual credential entry or
Retry login typing was needed. The packaged and installed app.asar SHA-256 hashes matched.
The 312-test suite and directory package build passed.

Installed repair check (21:45-21:46Z): switched to Umisteba, used League's real Sign out command,
and confirmed Riot reported `needs_authentication`. The first Friends refresh could still use its
cached access token, so only the Switcher was restarted before testing again. The cold refresh
rejected the saved refresh token with `invalid_grant` and exposed **Fix failed session**. Clicking
that and **Re-login** submitted Riot's form automatically, authorized Umisteba 1.75 seconds later,
captured a persisted session, and passed an independent refresh-token validation at 21:46:19Z.
The UI reported success and the refreshed Friends roster contained two friends with zero failures.
Repair restored the original closed-client state. No manual credentials or login retry were needed.
This used the installed package containing the accessibility handshake and Collection refresh;
its 314-test suite, directory build, and Electron startup self-test passed.

## Cold-start login regression (2026-10-15)

The user reproduced the failure after these checks: League **X -> Sign out**, then **Switch** back
to Nueluclor left Riot's username and password blank. The failed run at 22:25Z logged nine MSAA
nodes and `fields=0/0/0`. A read-only probe confirmed the top-level tree remained at nine nodes,
and the renderer child at one node, even after the old WM_GETOBJECT handshake. Inspecting the
same window with Computer Use then exposed 110 nodes and the real form. The prior live checks
were therefore affected by the inspection tool and did not establish unassisted login reliability.

The helper now requests IAccessible2 through IServiceProvider and reads its extended attributes on
the Riot renderer root, including `Chrome_RenderWidgetHostHWND` children. Chromium's custom-id
handshake only requests basic accessibility; the extended requests initialize web-content
accessibility. A first live iteration that only queried the interface found the fields but failed
to verify the checkbox, so obtaining the interface alone was not accepted as the final fix. Initialization
is retried within the existing deadline because renderer children can appear after their parent.
No foreground activation, global keyboard input, clipboard operation, or system accessibility
setting is involved. The existing field/checkbox/submit verification remains mandatory.

Implementation reference: [Chromium's IAccessible2 QueryService handling](https://github.com/chromium/chromium/blob/main/ui/accessibility/platform/ax_platform_node_win.cc).

A new opt-in native Electron regression fixture starts with web accessibility disabled and verifies
the actual submitted username, password, and checked persistence flag. It uses dummy credentials,
an isolated temporary profile, and the fixture's exact process id. Against the previous script it
failed after 18 seconds with no mutation and no credential controls. Against the new script it
submitted successfully in about one second, without an inspector initializing the form.

Run it on Windows with:

```powershell
$env:LAS_LOGIN_NATIVE_TEST = '1'
try { node --test test/riotLoginNative.test.js }
finally { Remove-Item Env:\LAS_LOGIN_NATIVE_TEST }
```

For live acceptance, use computer input only to sign out and click Switch, then stop the inspection
helper before Riot's new renderer starts. Observe login through the app log and local authentication
API until it finishes; do not read the new login's accessibility tree while waiting. This prevents
the test itself from supplying the missing initialization.

The installed pre-fix build reproduced the exact reported failure with that protocol at
22:32-22:33Z: the saved Nueluclor session was rejected, the form remained empty, and the helper
reported `nodes=9; fields=0/0/0`. Resetting the JavaScript session alone had not stopped the native
inspection process; it had to be stopped explicitly before the new Riot renderer launched.

The final installed build passed two successive Nueluclor **League X -> Sign out -> Switch** runs
with the inspection helper stopped before each Riot startup. Each run first independently verified
`needs_authentication`, rejected the revoked saved session, then automatically submitted the real
form with persistence verified. Authorization followed submission in 2.056 seconds (22:39:42Z) and
2.063 seconds (22:40:57Z), respectively. No credential typing, checkbox click, Retry login typing,
or accessibility inspection occurred during either login. The first run completed shared-settings
verification and displayed Nueluclor in League before the second sign-out. The second run also
completed shared-settings verification at 22:41:21Z; the LCU reported Nueluclor with phase `None`.

Validation: all 315 tests passed with `LAS_LOGIN_NATIVE_TEST=1`, including the native regression;
the directory package and Electron startup self-test passed. The packaged and installed app.asar
hashes matched (`90CA495B42392BF7D0684D57939C96265BC9C33A2292B3F1207337A89EFCB395`).

## Friends-backed session age labels (2026-10-16)

The Accounts age warning previously used only the original capture timestamp, even when Friends
successfully reused the same saved snapshot and retained a rotated refresh token in it. Account
cards now show **Session verified by Friends** while the main-process saved-session authentication
cache has valid credentials for that exact snapshot. The tray uses the same evidence to suppress
its age warning. Only a source label and verification/expiry timestamps reach the renderer.

Verification expires with the shortest cached token lifetime, retaining the existing one-minute
safety margin. Replacing or deleting the snapshot invalidates the match; an authentication failure
invalidates the cache. Cached Friends roster data and live-client credentials alone do not prove
that a saved snapshot is reusable. Nothing extends the session's capture date or guarantees that
Riot cannot revoke it later. Labels refresh after Friends requests and periodically without
rebuilding account cards or moving the list. Restarting the app requires fresh authentication
evidence before an old session receives the verified label again.

Installed-build validation: refreshed the user's configured 17 Friends sources with zero failures.
The 16 saved-session sources displayed the verified label, including the previously yellow Main
accounts; the active live-client source retained its normal saved-today label. No League account
switch or settings change was performed. All 321 tests passed, including isolated dummy-token
rotation, cache reuse, snapshot replacement and auth rejection; expiry/unknown-session UI and tray
rules are also covered. Packaging and the Electron startup self-test passed, and the installed
app.asar matched the package (`00CE277B7A2D483CD5622A013B65CA1ABF481033BAB35576EC8D42886D97AA34`).
