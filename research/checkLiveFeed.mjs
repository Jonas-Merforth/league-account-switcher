import { mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalLiveProfiles } from '../src/core/liveProtocol.js';

const bytes = readFileSync(process.argv[2]);
if (bytes.length > 8 * 1024 * 1024) throw new Error('Catalog exceeds client download limit');
const feed = JSON.parse(bytes);
if (feed.version !== 1 || !Array.isArray(feed.profiles)) throw new Error('Invalid feed');
const empty = mkdtempSync(join(tmpdir(), 'live-feed-'));
try { loadLocalLiveProfiles(empty, (_file, err) => { throw err; }, feed.profiles, false); }
finally { rmdirSync(empty); }
