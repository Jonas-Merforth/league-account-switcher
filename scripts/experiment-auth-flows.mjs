// UNSUPPORTED DEVELOPER EXPERIMENT.
//
// This harness closes Riot/League, reads real credentials from the local encrypted account store,
// and temporarily replaces the live Riot session bundle while it probes authentication paths.
// Use throwaway accounts only. See docs/riot-auth-experiments.md before running it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadAccounts } from '../src/core/accountStore.js';
import { dpapiUnprotectMany } from '../src/core/secrets.js';
import { getRiotLockfilePath, getRiotSessionFilePath, resolveRiotClientServicesPath } from '../src/core/config.js';
import { readSessionBundle, writeSessionBundle } from '../src/core/sessionBundle.js';
import { RiotClientApi } from '../src/core/riotClient.js';
import { killRiotAndLeague, launchRiotClient, prefillRiotLogin } from '../src/core/riotControl.js';
import { savedFriendXmppEndpoint } from '../src/core/friendPresencePoc.js';
import { runPowerShell } from '../src/core/powershell.js';

const AUTH_URL = 'https://auth.riotgames.com/api/v1/authorization';
const USERINFO_URL = 'https://auth.riotgames.com/userinfo';
const ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1';
const PAS_CHAT_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
const RIOT_UA = 'RiotClient/90.0.0 rso-auth (Windows;10;;Professional, x64)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  absorb(headers) {
    const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = String(line).split(';', 1)[0];
      const split = pair.indexOf('=');
      if (split <= 0) continue;
      const name = pair.slice(0, split).trim();
      const value = pair.slice(split + 1).trim();
      if (value) this.values.set(name, value);
      else this.values.delete(name);
    }
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  names() {
    return [...this.values.keys()].sort();
  }
}

function decodeHash(uri) {
  try {
    const parsed = new URL(uri);
    return Object.fromEntries(new URLSearchParams(parsed.hash.replace(/^#/, '')));
  } catch {
    return {};
  }
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function safeOutcome(json, status) {
  const detail = json?.error || json?.response?.error || json?.response?.parameters?.error || null;
  const multifactor = json?.multifactor || json?.response?.multifactor || null;
  const captcha = json?.captcha || json?.response?.captcha || null;
  return {
    status,
    type: json?.type || json?.response?.type || null,
    error: typeof detail === 'string' ? detail : detail?.error || detail?.message || null,
    multifactor: Boolean(multifactor),
    multifactorMethod: multifactor?.method || null,
    captcha: Boolean(captcha)
  };
}

async function jsonRequest(url, options, jar) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (jar?.header()) headers.Cookie = jar.header();
  const response = await fetch(url, { ...options, headers });
  jar?.absorb(response.headers);
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return { response, json, text };
}

async function mintDownstream(accessToken) {
  const [entitlementsResponse, pasResponse, userInfoResponse] = await Promise.all([
    fetch(ENTITLEMENTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }
    }),
    fetch(PAS_CHAT_URL, { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } })
  ]);
  if (!entitlementsResponse.ok || !pasResponse.ok || !userInfoResponse.ok) {
    throw new Error(`downstream HTTP status entitlements=${entitlementsResponse.status} pas=${pasResponse.status} userinfo=${userInfoResponse.status}`);
  }
  const [entitlements, pasToken, userInfo] = await Promise.all([
    entitlementsResponse.json(),
    pasResponse.text(),
    userInfoResponse.json()
  ]);
  return {
    accessToken,
    entitlementToken: entitlements.entitlements_token || entitlements.token,
    pasToken,
    userInfo,
    affinity: String(decodeJwt(pasToken)?.affinity || userInfo?.lol?.cpid || 'euw1').toLowerCase()
  };
}

async function readUntil(socket, marker, timeoutMs = 12_000) {
  let buffer = '';
  const onData = (chunk) => { buffer += chunk.toString('utf8'); };
  socket.on('data', onData);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (buffer.includes(marker) || buffer.includes('<failure') || buffer.includes('<stream:error')) return buffer;
      await sleep(25);
    }
    throw new Error(`XMPP timeout waiting for ${marker}; bytes=${Buffer.byteLength(buffer)}`);
  } finally {
    socket.off('data', onData);
  }
}

async function xmppProbe(auth) {
  const endpoint = savedFriendXmppEndpoint(auth.affinity);
  const socket = await new Promise((resolve, reject) => {
    const connected = tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host, timeout: 12_000 });
    connected.once('secureConnect', () => resolve(connected));
    connected.once('error', reject);
    connected.once('timeout', () => connected.destroy(new Error('XMPP TLS timeout')));
  });
  const stream = () => `<?xml version="1.0" encoding="UTF-8"?><stream:stream to="${endpoint.domain}" xml:lang="en" version="1.0" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams">`;
  const steps = [
    [stream(), '</stream:features>'],
    [`<auth mechanism="X-Riot-RSO-PAS" xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><rso_token>${escapeXml(auth.accessToken)}</rso_token><pas_token>${escapeXml(auth.pasToken)}</pas_token></auth>`, '</success>'],
    [stream(), '</stream:features>'],
    ['<iq id="_xmpp_bind1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><puuid-mode enabled="true"/></bind></iq>', '</iq>'],
    [`<iq id="xmpp_entitlements_0" type="set"><entitlements xmlns="urn:riotgames:entitlements"><token>${escapeXml(auth.entitlementToken)}</token></entitlements></iq>`, '</iq>'],
    ['<iq id="_xmpp_session1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"><platform>riot</platform></session></iq>', '</iq>'],
    ['<iq id="roster_1" type="get"><query xmlns="jabber:iq:riotgames:roster"/></iq>', '</iq>']
  ];
  try {
    let roster = '';
    for (const [stanza, marker] of steps) {
      socket.write(stanza);
      const response = await readUntil(socket, marker);
      if (/<failure|<stream:error/.test(response)) throw new Error('XMPP authentication rejected');
      roster = response;
    }
    return { connected: true, rosterItems: (roster.match(/<item\b/g) || []).length, host: endpoint.host };
  } finally {
    socket.end('</stream:stream>');
  }
}

async function directLogin(account, password) {
  const startedAt = Date.now();
  const jar = new CookieJar();
  const init = await jsonRequest(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': RIOT_UA },
    body: JSON.stringify({
      acr_values: 'urn:riot:bronze',
      claims: '',
      client_id: 'riot-client',
      nonce: crypto.randomUUID().replaceAll('-', ''),
      redirect_uri: 'http://localhost/redirect',
      response_type: 'token id_token',
      scope: 'openid link ban lol_region lol summoner offline_access account'
    })
  }, jar);
  if (!init.response.ok || init.json?.type !== 'auth') {
    return { method: 'direct', label: account.label, ok: false, stage: 'initialize', ...safeOutcome(init.json, init.response.status) };
  }
  const login = await jsonRequest(AUTH_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'User-Agent': RIOT_UA },
    body: JSON.stringify({ type: 'auth', username: account.username, password, remember: true, language: 'en_US', region: null })
  }, jar);
  const outcome = safeOutcome(login.json, login.response.status);
  const tokens = decodeHash(login.json?.response?.parameters?.uri);
  if (!tokens.access_token) {
    return { method: 'direct', label: account.label, ok: false, stage: 'credentials', ...outcome, cookieNames: jar.names(), elapsedMs: Date.now() - startedAt };
  }
  try {
    const auth = await mintDownstream(tokens.access_token);
    const xmpp = await xmppProbe(auth);
    return {
      method: 'direct', label: account.label, ok: true, type: outcome.type, rememberedCookie: jar.names().includes('ssid'),
      cookieNames: jar.names(), riotId: `${auth.userInfo?.acct?.game_name || '?'}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity, xmpp, elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return { method: 'direct', label: account.label, ok: false, stage: 'validate', error: error.message, cookieNames: jar.names(), elapsedMs: Date.now() - startedAt };
  }
}

function riotRoot() {
  return path.dirname(path.dirname(getRiotSessionFilePath()));
}

function clearLiveSessionBundle() {
  const root = riotRoot();
  for (const rel of ['Data/RiotGamesPrivateSettings.yaml', 'Data/Cookies', 'Data/Sessions']) {
    fs.rmSync(path.join(root, ...rel.split('/')), { recursive: true, force: true });
  }
}

async function waitForRiotApi(timeoutMs = 30_000) {
  const riot = new RiotClientApi();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (riot.isRunning()) {
        await riot.request('GET', '/riot-login/v1/status');
        return riot;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Riot local API did not become ready');
}

async function waitForLocalAccessToken(riot, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = await riot.request('GET', '/rso-auth/v1/authorization/access-token');
      if (token?.token) return token.token;
    } catch {}
    await sleep(250);
  }
  return null;
}

async function localLogin(account, password) {
  const startedAt = Date.now();
  await killRiotAndLeague();
  clearLiveSessionBundle();
  fs.rmSync(getRiotLockfilePath(), { force: true });
  await launchRiotClient(resolveRiotClientServicesPath());
  const riot = await waitForRiotApi();
  let authorization;
  try {
    authorization = await riot.request('POST', '/rso-auth/v2/authorizations', { clientId: 'riot-client', trustLevels: ['always_trusted'] });
  } catch (error) {
    return { method: 'local-api', label: account.label, ok: false, stage: 'initialize', error: error.message.replace(/password[^,}]*/gi, 'password=[redacted]') };
  }
  let login;
  try {
    login = await riot.request('PUT', '/rso-auth/v1/session/credentials', { username: account.username, password, persistLogin: true });
  } catch (error) {
    return { method: 'local-api', label: account.label, ok: false, stage: 'credentials', authType: authorization?.type || null, error: error.message.replace(/password[^,}]*/gi, 'password=[redacted]'), elapsedMs: Date.now() - startedAt };
  }
  const accessToken = await waitForLocalAccessToken(riot);
  if (!accessToken) {
    return {
      method: 'local-api', label: account.label, ok: false, stage: 'access-token', authType: authorization?.type || null,
      loginType: login?.type || null,
      loginError: typeof login?.error === 'string' ? login.error : login?.error?.error || login?.error?.message || null,
      persistLogin: login?.persistLogin ?? null,
      multifactor: Boolean(login?.multifactor),
      multifactorMethod: login?.multifactor?.method || null,
      captcha: Boolean(login?.captcha),
      responseKeys: login && typeof login === 'object' ? Object.keys(login).sort() : [],
      elapsedMs: Date.now() - startedAt
    };
  }
  try {
    const auth = await mintDownstream(accessToken);
    const xmpp = await xmppProbe(auth);
    const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
    return {
      method: 'local-api', label: account.label, ok: true, loginType: login?.type || null, persist: status?.persist ?? null,
      phase: status?.phase || null, riotId: `${auth.userInfo?.acct?.game_name || '?'}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity, xmpp, elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return { method: 'local-api', label: account.label, ok: false, stage: 'validate', error: error.message, elapsedMs: Date.now() - startedAt };
  }
}

async function modernLocalLogin(account, password) {
  const startedAt = Date.now();
  await killRiotAndLeague();
  clearLiveSessionBundle();
  fs.rmSync(getRiotLockfilePath(), { force: true });
  await launchRiotClient(resolveRiotClientServicesPath());
  const riot = await waitForRiotApi();
  try {
    await riot.request('DELETE', '/rso-authenticator/v1/authentication').catch(() => null);
    const start = await riot.request('POST', '/rso-authenticator/v1/authentication/riot-identity/start', {
      language: 'en_US',
      productId: 'riot-client',
      state: 'auth'
    });
    const captchaType = start?.captcha?.type || 'none';
    let captchaToken = '';
    let captchaSolver = 'not-needed';
    if (captchaType && captchaType !== 'none') {
      try {
        captchaToken = await solveHcaptcha(start?.captcha?.hcaptcha || {});
        captchaSolver = 'hidden-electron';
      } catch (error) {
        return {
          method: 'modern-local-api', label: account.label, ok: false, stage: 'captcha', startType: start?.type || null,
          captchaType, captchaKeys: Object.keys(start?.captcha?.hcaptcha || {}).sort(), solverError: error.message,
          elapsedMs: Date.now() - startedAt
        };
      }
    }
    const complete = await riot.request('POST', '/rso-authenticator/v1/authentication/riot-identity/complete', {
      username: account.username,
      password,
      remember: true,
      language: 'en_US',
      captcha: captchaToken ? `${captchaType} ${captchaToken}` : ''
    });
    if (complete?.type !== 'success') {
      return {
        method: 'modern-local-api', label: account.label, ok: false, stage: 'credentials', startType: start?.type || null,
        type: complete?.type || null, error: typeof complete?.error === 'string' ? complete.error : complete?.error?.error || complete?.error?.message || null,
        multifactorMethod: complete?.multifactor?.method || null, responseKeys: complete && typeof complete === 'object' ? Object.keys(complete).sort() : [],
        elapsedMs: Date.now() - startedAt
      };
    }
    const accessToken = await waitForLocalAccessToken(riot, 40_000);
    if (!accessToken) return { method: 'modern-local-api', label: account.label, ok: false, stage: 'access-token', type: complete?.type || null, elapsedMs: Date.now() - startedAt };
    const auth = await mintDownstream(accessToken);
    const xmpp = await xmppProbe(auth);
    const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
    return {
      method: 'modern-local-api', label: account.label, ok: true, type: complete?.type || null, phase: status?.phase || null,
      persist: status?.persist ?? null, captchaSolver, riotId: `${auth.userInfo?.acct?.game_name || '?'}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity, xmpp, elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return { method: 'modern-local-api', label: account.label, ok: false, stage: 'request', error: error.message.replace(/password[^,}]*/gi, 'password=[redacted]'), elapsedMs: Date.now() - startedAt };
  }
}

async function solveHcaptcha({ key, data }) {
  if (!key || !data) throw new Error('Riot did not provide both hCaptcha key and rqdata');
  const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error('Electron runtime not found');
  const resultPath = path.join(os.tmpdir(), `las-captcha-${crypto.randomUUID()}.json`);
  const child = spawn(electronExe, [new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'), 'captcha-render'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      LAS_CAPTCHA_INPUT: Buffer.from(JSON.stringify({ key, data }), 'utf8').toString('base64'),
      LAS_CAPTCHA_RESULT: resultPath
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('hidden hCaptcha renderer timed out'));
    }, 45_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}
  fs.rmSync(resultPath, { force: true });
  if (exitCode !== 0 || !result?.token) throw new Error(result?.error || stderr.trim().slice(0, 200) || `hidden renderer exited ${exitCode}`);
  return result.token;
}

async function captchaRendererMain() {
  const { key, data } = JSON.parse(Buffer.from(process.env.LAS_CAPTCHA_INPUT || '', 'base64').toString('utf8'));
  const resultPath = process.env.LAS_CAPTCHA_RESULT || '';
  delete process.env.LAS_CAPTCHA_INPUT;
  delete process.env.LAS_CAPTCHA_RESULT;
  const { app, BrowserWindow, session } = await import('electron');
  await app.whenReady();
  const staticServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head></head><body><div id="captcha"></div></body></html>');
  });
  await new Promise((resolve, reject) => {
    staticServer.once('error', reject);
    staticServer.listen(0, '127.0.0.1', resolve);
  });
  const staticPort = staticServer.address().port;
  const captchaSession = session.fromPartition(`las-auth-experiment-${Date.now()}`);
  captchaSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders || {}) };
    for (const name of Object.keys(headers)) {
      if (/content-security-policy/i.test(name)) delete headers[name];
    }
    callback({ responseHeaders: headers });
  });
  const win = new BrowserWindow({
    show: false,
    width: 480,
    height: 640,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, session: captchaSession }
  });
  // Riot Client runs its login renderer from a random 127.0.0.1 HTTP origin.
  // Reproduce that origin instead of minting the captcha token from Riot's API origin.
  await win.loadURL(`http://127.0.0.1:${staticPort}/index.html`);
  const setup = `(() => {
    document.documentElement.innerHTML = '<head></head><body><div id="captcha"></div></body>';
    window.__captchaResult = null;
    window.__captchaLoaded = async () => {
      try {
        const id = hcaptcha.render('captcha', {
          sitekey: ${JSON.stringify(key)},
          size: 'invisible',
          callback: token => { window.__captchaResult = { token }; },
          'error-callback': error => { window.__captchaResult = { error: String(error || 'hcaptcha error') }; },
          'expired-callback': () => { window.__captchaResult = { error: 'hcaptcha expired' }; }
        });
        const value = await hcaptcha.execute(id, { rqdata: ${JSON.stringify(data)}, async: true });
        const token = typeof value === 'string' ? value : value?.response;
        if (token) window.__captchaResult = { token };
      } catch (error) {
        window.__captchaResult = { error: String(error?.message || error) };
      }
    };
    const script = document.createElement('script');
    script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit&onload=__captchaLoaded';
    script.async = true;
    script.defer = true;
    script.onerror = () => { window.__captchaResult = { error: 'hcaptcha script load failed' }; };
    document.head.appendChild(script);
  })()`;
  await win.webContents.executeJavaScript(setup);
  const deadline = Date.now() + 15_000;
  let result = null;
  while (Date.now() < deadline) {
    result = await win.webContents.executeJavaScript('window.__captchaResult').catch(() => null);
    if (result) break;
    await sleep(250);
  }
  if (!result) {
    const diagnostics = await win.webContents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      hcaptchaLoaded: typeof window.hcaptcha !== 'undefined',
      iframeCount: document.querySelectorAll('iframe').length,
      bodyText: document.body?.innerText?.slice(0, 120) || ''
    })`).catch(() => ({}));
    result = { error: `captcha renderer produced no result (${JSON.stringify(diagnostics)})` };
  }
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  win.destroy();
  await new Promise((resolve) => staticServer.close(resolve));
  app.quit();
}

async function autotypeLogin(account, password) {
  const startedAt = Date.now();
  await killRiotAndLeague();
  clearLiveSessionBundle();
  fs.rmSync(getRiotLockfilePath(), { force: true });
  await launchRiotClient(resolveRiotClientServicesPath());
  const riot = await waitForRiotApi();
  await sleep(2_000);
  const attempts = [];
  try {
    attempts.push({ mode: 'background', diagnostics: await prefillRiotLogin({ username: account.username, password, mode: 'background' }) });
  } catch (error) {
    attempts.push({ mode: 'background', error: error.message });
  }
  let accessToken = await waitForLocalAccessToken(riot, 20_000);
  if (!accessToken) {
    try {
      attempts.push({ mode: 'foreground', diagnostics: await prefillRiotLogin({ username: account.username, password, mode: 'foreground', clickStaySignedIn: false }) });
    } catch (error) {
      attempts.push({ mode: 'foreground', error: error.message });
    }
    accessToken = await waitForLocalAccessToken(riot, 40_000);
  }
  if (!accessToken) {
    const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
    return { method: 'autotype', label: account.label, ok: false, phase: status?.phase || null, attempts, elapsedMs: Date.now() - startedAt };
  }
  try {
    const auth = await mintDownstream(accessToken);
    const xmpp = await xmppProbe(auth);
    const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
    return {
      method: 'autotype', label: account.label, ok: true, phase: status?.phase || null, persist: status?.persist ?? null,
      riotId: `${auth.userInfo?.acct?.game_name || '?'}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity, xmpp, attempts, elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return { method: 'autotype', label: account.label, ok: false, stage: 'validate', error: error.message, attempts, elapsedMs: Date.now() - startedAt };
  }
}

function splitWindowsCommandLine(commandLine) {
  return (String(commandLine).match(/"[^"]*"|\S+/g) || []).map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part
  );
}

async function relaunchRiotRendererWithCdp(port = 9222) {
  const processInfo = (await runPowerShell(`
$process = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Riot Client.exe' -and $_.CommandLine -match '--app-port=' } | Select-Object -First 1
if ($process) {
  $service = Get-Process -Name 'RiotClientServices' -ErrorAction SilentlyContinue | Select-Object -First 1
  $json = @{ commandLine = $process.CommandLine; servicePid = $service.Id } | ConvertTo-Json -Compress
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}
`, { timeoutMs: 10_000 })).trim();
  if (!processInfo) throw new Error('Riot renderer command line was not found');
  const decoded = JSON.parse(Buffer.from(processInfo, 'base64').toString('utf8'));
  const [exe, ...args] = splitWindowsCommandLine(decoded.commandLine);
  const nativeProcessControl = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeProcessControl {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$process = Get-Process -Id ${Number(decoded.servicePid)} -ErrorAction Stop
`;
  await runPowerShell(`${nativeProcessControl}[NativeProcessControl]::NtSuspendProcess($process.Handle) | Out-Null`, { timeoutMs: 10_000 });
  let resumed = false;
  try {
    await runPowerShell("Get-Process -Name 'Riot Client' -ErrorAction SilentlyContinue | Stop-Process -Force", { timeoutMs: 10_000 });
    const child = spawn(exe, [...args, `--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
        const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(item.url));
        if (page?.webSocketDebuggerUrl) {
          await runPowerShell(`${nativeProcessControl}[NativeProcessControl]::NtResumeProcess($process.Handle) | Out-Null`, { timeoutMs: 10_000 });
          resumed = true;
          return page.webSocketDebuggerUrl;
        }
      } catch {}
      await sleep(200);
    }
    throw new Error('Riot renderer DevTools endpoint did not become ready');
  } finally {
    if (!resumed) await runPowerShell(`${nativeProcessControl}[NativeProcessControl]::NtResumeProcess($process.Handle) | Out-Null`, { timeoutMs: 10_000 }).catch(() => null);
  }
}

async function openCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    evaluate(expression) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject })).then((result) => {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
        return result.result?.value;
      });
    },
    close() { socket.close(); }
  };
}

async function findRiotRendererCdp(port = 9222, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(item.url));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  return null;
}

async function domLogin(account, password) {
  const startedAt = Date.now();
  await killRiotAndLeague();
  clearLiveSessionBundle();
  fs.rmSync(getRiotLockfilePath(), { force: true });
  await launchRiotClient(resolveRiotClientServicesPath());
  const riot = await waitForRiotApi();
  await riot.request('DELETE', '/rso-authenticator/v1/authentication').catch(() => null);
  const wsUrl = await findRiotRendererCdp() || await relaunchRiotRendererWithCdp();
  const cdp = await openCdp(wsUrl);
  try {
    const deadline = Date.now() + 20_000;
    let form = null;
    while (Date.now() < deadline) {
      form = await cdp.evaluate(`(() => ({
        path: location.pathname,
        inputs: [...document.querySelectorAll('input')].map((el, index) => ({ index, type: el.type, name: el.name, autocomplete: el.autocomplete })),
        buttons: [...document.querySelectorAll('button')].map((el, index) => ({ index, type: el.type, text: (el.innerText || '').trim().slice(0, 50) }))
      }))()`);
      if (form?.inputs?.some((item) => item.type === 'password')) break;
      await sleep(250);
    }
    if (!form?.inputs?.some((item) => item.type === 'password')) {
      return { method: 'renderer-dom', label: account.label, ok: false, stage: 'form', diagnostics: form, elapsedMs: Date.now() - startedAt };
    }
    const payload = Buffer.from(JSON.stringify({ username: account.username, password }), 'utf8').toString('base64');
    const submit = await cdp.evaluate(`(() => {
      const credentials = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(payload)}), c => c.charCodeAt(0))));
      const inputs = [...document.querySelectorAll('input')];
      const username = inputs.find(el => ['text', 'email'].includes(el.type) && (el.autocomplete === 'username' || /user|name/i.test(el.name))) || inputs.find(el => ['text', 'email'].includes(el.type));
      const password = inputs.find(el => el.type === 'password');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [element, value] of [[username, credentials.username], [password, credentials.password]]) {
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const checkbox = inputs.find(el => el.type === 'checkbox');
      if (checkbox && !checkbox.checked) checkbox.click();
      const button = [...document.querySelectorAll('button')].find(el => el.type === 'submit' && !el.disabled)
        || [...document.querySelectorAll('button')].find(el => !el.disabled);
      if (!button) return { submitted: false, reason: 'no enabled button' };
      button.click();
      return { submitted: true, usernameLength: credentials.username.length, passwordLength: credentials.password.length };
    })()`);
    const accessToken = await waitForLocalAccessToken(riot, 45_000);
    if (!accessToken) {
      const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
      const page = await cdp.evaluate(`({ path: location.pathname, text: (document.body?.innerText || '').slice(0, 300) })`).catch(() => null);
      return { method: 'renderer-dom', label: account.label, ok: false, stage: 'access-token', submit, phase: status?.phase || null, page, elapsedMs: Date.now() - startedAt };
    }
    const auth = await mintDownstream(accessToken);
    const xmpp = await xmppProbe(auth);
    const status = await riot.request('GET', '/riot-login/v1/status').catch(() => null);
    return {
      method: 'renderer-dom', label: account.label, ok: true, phase: status?.phase || null, persist: status?.persist ?? null,
      riotId: `${auth.userInfo?.acct?.game_name || '?'}#${auth.userInfo?.acct?.tag_line || '?'}`,
      affinity: auth.affinity, xmpp, submit, elapsedMs: Date.now() - startedAt
    };
  } finally {
    cdp.close();
  }
}

async function holdCleanLoginClient(account) {
  await killRiotAndLeague();
  clearLiveSessionBundle();
  fs.rmSync(getRiotLockfilePath(), { force: true });
  await launchRiotClient(resolveRiotClientServicesPath());
  const riot = await waitForRiotApi();
  const start = await riot.request('DELETE', '/rso-authenticator/v1/authentication').catch(() => null);
  console.log(JSON.stringify({ event: 'clean-login-client-ready', label: account.label, reset: start === null || typeof start === 'object', holdMs: 60_000 }));
  await sleep(60_000);
  return { method: 'hold-clean', label: account.label, ok: true };
}

async function loadCredentials(labels) {
  const accounts = loadAccounts();
  const selected = labels.map((label) => {
    const account = accounts.find((item) => item.label.toLowerCase() === label.toLowerCase());
    if (!account) throw new Error(`Account not found: ${label}`);
    if (!account.username || !account.passwordEnc) throw new Error(`Account has no stored credentials: ${label}`);
    return account;
  });
  const passwords = await dpapiUnprotectMany(selected.map((account) => account.passwordEnc));
  return selected.map((account, index) => ({ account, password: passwords[index] }));
}

async function main() {
  const mode = process.argv[2];
  const labels = process.argv.slice(3);
  if (!['direct', 'local', 'modern-local', 'autotype', 'dom-login', 'hold-clean'].includes(mode) || !labels.length) {
    throw new Error('Usage: node scripts/experiment-auth-flows.mjs <direct|local|modern-local|autotype|dom-login|hold-clean> <account labels...>');
  }
  const credentials = await loadCredentials(labels);
  if (mode === 'direct') {
    for (const item of credentials) console.log(JSON.stringify(await directLogin(item.account, item.password)));
    return;
  }

  let backup = null;
  try {
    const existing = new RiotClientApi();
    if (existing.isRunning()) {
      await existing.gracefulQuit().catch(() => null);
      await sleep(4_000);
    }
    await killRiotAndLeague();
    backup = readSessionBundle(riotRoot());
    console.log(JSON.stringify({ event: 'live-session-backed-up', fileCount: Object.keys(backup).length }));
    for (const item of credentials) {
      const result = mode === 'autotype'
        ? await autotypeLogin(item.account, item.password)
        : mode === 'dom-login'
          ? await domLogin(item.account, item.password)
        : mode === 'hold-clean'
          ? await holdCleanLoginClient(item.account)
        : mode === 'modern-local'
          ? await modernLocalLogin(item.account, item.password)
          : await localLogin(item.account, item.password);
      console.log(JSON.stringify(result));
    }
  } finally {
    await killRiotAndLeague().catch(() => null);
    clearLiveSessionBundle();
    if (backup) writeSessionBundle(backup, riotRoot());
    console.log(JSON.stringify({ event: 'live-session-restored', restored: Boolean(backup) }));
  }
}

const entry = process.env.LAS_CAPTCHA_INPUT ? captchaRendererMain : main;
entry().catch((error) => {
  console.error(JSON.stringify({ fatal: error.message }));
  process.exitCode = 1;
});
