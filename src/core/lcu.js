import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

// Minimal League Client (LCU) API client. The account switcher uses it only for the live-game
// guard (reading /lol-gameflow/v1/gameflow-phase) and to locate League's lockfile via leaguePath.
// Lockfile/Basic-auth scheme: name:pid:port:password:protocol, authenticate as riot:<password>
// over self-signed HTTPS on 127.0.0.1.
export class LcuClient {
  constructor({ leaguePath }) {
    this.leaguePath = leaguePath;
    this.credentials = null;
  }

  setLeaguePath(leaguePath) {
    if (this.leaguePath !== leaguePath) {
      this.leaguePath = leaguePath;
      this.credentials = null;
    }
  }

  readLockfile() {
    const lockfile = path.join(this.leaguePath, 'lockfile');
    const raw = fs.readFileSync(lockfile, 'utf8').trim();
    const [name, pid, port, password, protocol] = raw.split(':');
    if (!name || !pid || !port || !password || !protocol) {
      throw new Error('LCU lockfile has an unexpected format.');
    }
    this.credentials = {
      name,
      pid: Number(pid),
      port: Number(port),
      password,
      protocol
    };
    return this.credentials;
  }

  getCredentials() {
    if (!this.credentials) return this.readLockfile();
    return this.credentials;
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

  get(endpoint) {
    return this.request('GET', endpoint);
  }

  post(endpoint, body = {}) {
    return this.request('POST', endpoint, body);
  }

  put(endpoint, body = {}) {
    return this.request('PUT', endpoint, body);
  }

  patch(endpoint, body = {}) {
    return this.request('PATCH', endpoint, body);
  }

  delete(endpoint, body) {
    return this.request('DELETE', endpoint, body);
  }
}
