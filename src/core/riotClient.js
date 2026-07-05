import fs from 'node:fs';
import https from 'node:https';
import { getRiotLockfilePath } from './config.js';

// Local API client for the Riot Client (RiotClientServices), separate from the LCU/League client.
// Used by the account manager only to read login state — never to submit credentials (that path is
// captcha-gated). Same lockfile/Basic-auth scheme as LcuClient: name:pid:port:password:protocol,
// authenticate as riot:<password> over self-signed HTTPS on 127.0.0.1.
export class RiotClientApi {
  constructor({ getLockfilePath = getRiotLockfilePath } = {}) {
    this.getLockfilePath = getLockfilePath;
    this.credentials = null;
  }

  readLockfile() {
    const raw = fs.readFileSync(this.getLockfilePath(), 'utf8').trim();
    const [name, pid, port, password, protocol] = raw.split(':');
    if (!name || !pid || !port || !password || !protocol) {
      throw new Error('Riot Client lockfile has an unexpected format.');
    }
    this.credentials = { name, pid: Number(pid), port: Number(port), password, protocol };
    return this.credentials;
  }

  getCredentials() {
    if (!this.credentials) return this.readLockfile();
    return this.credentials;
  }

  // True when the Riot Client is running (its lockfile exists and parses).
  isRunning() {
    try {
      this.readLockfile();
      return true;
    } catch {
      return false;
    }
  }

  async request(method, endpoint, body) {
    const credentials = this.getCredentials();
    const auth = Buffer.from(`riot:${credentials.password}`).toString('base64');
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const options = {
      hostname: '127.0.0.1',
      port: credentials.port,
      path: endpoint,
      method,
      rejectUnauthorized: false,
      timeout: 5000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      }
    };

    if (payload !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method} ${endpoint} failed with ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          if (!data) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error(`${method} ${endpoint} timed out`));
      });
      req.on('error', (error) => {
        this.credentials = null;
        reject(error);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  // Returns the authorization state. `type === 'needs_authentication'` means no one is signed in yet.
  getAuthState() {
    return this.request('POST', '/rso-auth/v2/authorizations', {
      clientId: 'riot-client',
      trustLevels: ['always_trusted']
    });
  }

  // Returns the signed-in player's userinfo (object or raw JWT string), or null when not signed in.
  getUserInfo() {
    return this.request('GET', '/rso-auth/v1/authorization/userinfo');
  }

  // Destroy the current login session (clean logout). Best-effort; callers also kill processes.
  logout() {
    return this.request('DELETE', '/rso-auth/v1/session');
  }

  // Ask the Riot Client to quit gracefully. Critical before capturing a session: it flushes the
  // in-memory rotated RSO tokens to disk, so the snapshot holds the current (still-valid) token
  // rather than a pre-rotation one the server has already invalidated.
  gracefulQuit() {
    return this.request('POST', '/process-control/v1/process/quit');
  }

  // Tell the signed-in Riot Client to launch League. More deterministic than re-running the CLI with
  // --launch-product (no process race), and it returns once the launch is accepted.
  launchLeague() {
    return this.request('POST', '/product-launcher/v1/products/league_of_legends/patchlines/live');
  }

  // True only when the Riot Client is up AND a user is actually signed in.
  async isLoggedIn() {
    if (!this.isRunning()) return false;
    try {
      const state = await this.getAuthState();
      if (state && typeof state.type === 'string') {
        return state.type !== 'needs_authentication';
      }
    } catch {
      // Fall through to the userinfo probe below.
    }
    try {
      const info = await this.getUserInfo();
      return Boolean(info);
    } catch {
      return false;
    }
  }

  // Diagnostic snapshot of the Riot Client state for switch logging: is it running, on what port,
  // and what authorization state does it report (needs_authentication until a user is signed in;
  // 'unknown' when the endpoint 404s because the RSO plugin hasn't loaded yet — not signed in).
  async probe() {
    if (!this.isRunning()) return { running: false };
    const port = this.credentials?.port ?? null;
    try {
      const state = await this.getAuthState();
      return { running: true, port, authType: state?.type ?? 'unknown' };
    } catch (error) {
      return { running: true, port, error: error.code || error.message };
    }
  }

  // Best-effort display name for the signed-in account, used to label the active account in the UI.
  async getSignedInName() {
    try {
      const info = await this.getUserInfo();
      if (!info) return null;
      if (typeof info === 'object') {
        return info.game_name || info.acct?.game_name || info.username || info.sub || null;
      }
    } catch {
      // No name available (not signed in, or userinfo is an opaque token).
    }
    return null;
  }
}
