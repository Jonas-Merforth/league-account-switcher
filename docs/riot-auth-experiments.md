# Riot authentication experiments

This document preserves the July 2026 investigation into replacing Riot Client login-field
autotyping with a code-only authentication flow. It is research, not a supported product feature.

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
