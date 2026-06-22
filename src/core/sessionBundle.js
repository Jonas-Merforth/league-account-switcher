import fs from 'node:fs';
import path from 'node:path';

// A portable Riot login is more than one file. Per the current switchers (klNuno/accshift,
// TcNo), capture the session YAML plus the cookie/session stores and the client settings, all
// relative to the Riot Client dir. The lockfile (per-run) and ClientConfiguration.json (a large
// cache, not session state) are deliberately excluded.
export const SNAPSHOT_ITEMS = [
  { rel: 'Data/RiotGamesPrivateSettings.yaml', dir: false },
  { rel: 'Data/Cookies', dir: true },
  { rel: 'Data/Sessions', dir: true },
  { rel: 'Config/RiotClientSettings.yaml', dir: false }
];

export const PRIMARY_YAML_REL = 'Data/RiotGamesPrivateSettings.yaml';
const EXCLUDE_NAMES = new Set(['lockfile', 'ClientConfiguration.json']);

function collectFiles(absDir, relBase, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(abs, rel, out);
    else out.push({ abs, rel });
  }
}

// Reads the live Riot session file set under `root` into a manifest { relPath: base64 }.
export function readSessionBundle(root) {
  const manifest = {};
  for (const item of SNAPSHOT_ITEMS) {
    const abs = path.join(root, ...item.rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    if (item.dir) {
      const files = [];
      collectFiles(abs, item.rel, files);
      for (const file of files) manifest[file.rel] = fs.readFileSync(file.abs).toString('base64');
    } else {
      manifest[item.rel] = fs.readFileSync(abs).toString('base64');
    }
  }
  return manifest;
}

// Writes a manifest back to disk under `root`, recreating directories as needed.
export function writeSessionBundle(manifest, root) {
  for (const [rel, base64] of Object.entries(manifest || {})) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(base64, 'base64'));
  }
}

// The decoded primary session YAML text from a manifest (for persisted-session detection), or ''.
export function bundlePrimaryYaml(manifest) {
  const base64 = manifest?.[PRIMARY_YAML_REL];
  return base64 ? Buffer.from(base64, 'base64').toString('utf8') : '';
}
