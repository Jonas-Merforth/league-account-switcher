import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { loadLocalLiveProfiles } from './liveProtocol.js';

const LIMIT = 8 * 1024 * 1024;
const RETRY = 5 * 60_000;

export function liveProfileFeed({ directory, url, log, request = fetch, now = Date.now }) {
  const cache = join(directory, 'verified-live-feed.json');
  const localFeed = join(directory, 'live-profiles.json');
  const local = join(directory, 'live-protocols');
  const report = (file, error) => log(`Could not load live protocol ${file}: ${error.message}`, 'warn');
  let previous, next = 0, pending;
  function prepare(raw) {
    const catalog = JSON.parse(raw);
    if (catalog.version !== 1 || !Array.isArray(catalog.profiles)) throw new Error('Unsupported profile catalog');
    return loadLocalLiveProfiles(local, report, catalog.profiles, false);
  }
  loadLocalLiveProfiles(local, report);
  if (url) try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Expected HTTPS profile feed');
  } catch (error) { report('feed URL', error); return { check() {} }; }
  try {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.url === (url || null)) { prepare(saved.raw)(); previous = saved; }
  } catch (error) { if (error.code !== 'ENOENT') report(cache, error); }
  async function download() {
    const response = await request(url, { signal: AbortSignal.timeout(15_000), redirect: 'error',
      headers: previous?.etag ? { 'If-None-Match': previous.etag } : {} });
    if (response.status === 304 && previous) return null;
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > LIMIT) { await reader.cancel(); throw new Error('Profile catalog too large'); }
      chunks.push(value);
    }
    return { raw: Buffer.concat(chunks).toString('utf8'), etag: response.headers.get('etag') };
  }
  async function fromDisk() {
    let handle;
    try {
      handle = await open(localFeed);
      const { size } = await handle.stat();
      if (size > LIMIT) throw new Error('Profile catalog too large');
      return { raw: await handle.readFile('utf8'), etag: null };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close(); }
  }
  async function refresh() {
    const result = url ? await download() : await fromDisk();
    if (!result) return;
    const { raw, etag } = result;
    if (raw === previous?.raw) return;
    const activate = prepare(raw);
    const saved = { url: url || null, raw, etag };
    mkdirSync(directory, { recursive: true });
    const temp = cache + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temp, JSON.stringify(saved), { flag: 'wx' }); renameSync(temp, cache); }
    finally { rmSync(temp, { force: true }); }
    activate();
    previous = saved;
  }
  return { check() {
    if (pending || now() < next) return pending;
    next = now() + RETRY;
    pending = refresh().catch(error => report('feed', error)).finally(() => { pending = null; });
    return pending;
  } };
}
