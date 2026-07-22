import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getNotificationSoundsDir } from './config.js';

export const MAX_NOTIFICATION_SOUND_BYTES = 25 * 1024 * 1024;
export const NOTIFICATION_SOUND_KINDS = Object.freeze(['accept', 'dodge']);

const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';

function assertKind(kind) {
  if (!NOTIFICATION_SOUND_KINDS.includes(kind)) {
    throw new Error('Unknown notification sound type.');
  }
}

function managedFilePattern(kind) {
  return new RegExp(`^${kind}-[0-9a-f-]{36}\\.bin$`);
}

function normalizeEntry(kind, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const file = String(entry.file || '');
  if (!managedFilePattern(kind).test(file) || path.basename(file) !== file) return null;
  const name = sanitizeDisplayName(entry.name);
  const mimeType = sanitizeMimeType(entry.mimeType);
  return { file, name, mimeType };
}

function readManifest(rootDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, MANIFEST_FILE), 'utf8'));
    if (!parsed || parsed.version !== MANIFEST_VERSION) return {};
    return Object.fromEntries(NOTIFICATION_SOUND_KINDS.map((kind) => [kind, normalizeEntry(kind, parsed[kind])]));
  } catch {
    return {};
  }
}

function writeManifest(rootDir, entries) {
  fs.mkdirSync(rootDir, { recursive: true });
  const manifest = { version: MANIFEST_VERSION };
  for (const kind of NOTIFICATION_SOUND_KINDS) {
    const entry = normalizeEntry(kind, entries[kind]);
    if (entry) manifest[kind] = entry;
  }
  const destination = path.join(rootDir, MANIFEST_FILE);
  const temporary = path.join(rootDir, `${MANIFEST_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sanitizeDisplayName(value) {
  const raw = String(value || '');
  const base = path.basename(path.win32.basename(raw)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'Custom sound').slice(0, 200);
}

function sanitizeMimeType(value) {
  const mimeType = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
    ? mimeType.slice(0, 120)
    : 'application/octet-stream';
}

function payloadBuffer(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('The selected sound data is invalid.');
}

function defaultSound(kind) {
  return { kind, custom: false, name: null, mimeType: null, size: 0, data: null };
}

function readSound(kind, entries, rootDir, maxBytes) {
  const entry = normalizeEntry(kind, entries[kind]);
  if (!entry) return defaultSound(kind);
  try {
    const filePath = path.join(rootDir, entry.file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return defaultSound(kind);
    const data = fs.readFileSync(filePath);
    return {
      kind,
      custom: true,
      name: entry.name,
      mimeType: entry.mimeType,
      size: data.byteLength,
      data: new Uint8Array(data)
    };
  } catch {
    return defaultSound(kind);
  }
}

function removeFile(rootDir, file) {
  if (!file || path.basename(file) !== file) return;
  try { fs.unlinkSync(path.join(rootDir, file)); } catch {}
}

function cleanupKindFiles(rootDir, kind, keepFile = null) {
  let files;
  try { files = fs.readdirSync(rootDir); } catch { return; }
  const pattern = managedFilePattern(kind);
  for (const file of files) {
    if (file !== keepFile && pattern.test(file)) removeFile(rootDir, file);
  }
}

export function getNotificationSounds({
  rootDir = getNotificationSoundsDir(),
  maxBytes = MAX_NOTIFICATION_SOUND_BYTES
} = {}) {
  const entries = readManifest(rootDir);
  return Object.fromEntries(NOTIFICATION_SOUND_KINDS.map((kind) => [
    kind,
    readSound(kind, entries, rootDir, maxBytes)
  ]));
}

export function saveNotificationSound(kind, payload = {}, {
  rootDir = getNotificationSoundsDir(),
  maxBytes = MAX_NOTIFICATION_SOUND_BYTES
} = {}) {
  assertKind(kind);
  const data = payloadBuffer(payload.data);
  if (!data.byteLength) throw new Error('The selected sound file is empty.');
  if (data.byteLength > maxBytes) throw new Error('The selected sound is larger than 25 MB.');

  fs.mkdirSync(rootDir, { recursive: true });
  const entries = readManifest(rootDir);
  const oldEntry = normalizeEntry(kind, entries[kind]);
  const file = `${kind}-${crypto.randomUUID()}.bin`;
  const nextEntry = {
    file,
    name: sanitizeDisplayName(payload.name),
    mimeType: sanitizeMimeType(payload.mimeType)
  };
  const nextEntries = { ...entries, [kind]: nextEntry };
  const filePath = path.join(rootDir, file);

  try {
    fs.writeFileSync(filePath, data, { flag: 'wx' });
    writeManifest(rootDir, nextEntries);
  } catch (error) {
    removeFile(rootDir, file);
    throw error;
  }

  if (oldEntry?.file !== file) removeFile(rootDir, oldEntry?.file);
  cleanupKindFiles(rootDir, kind, file);
  return readSound(kind, nextEntries, rootDir, maxBytes);
}

export function resetNotificationSound(kind, {
  rootDir = getNotificationSoundsDir(),
} = {}) {
  assertKind(kind);
  const entries = readManifest(rootDir);
  const oldEntry = normalizeEntry(kind, entries[kind]);
  if (oldEntry) {
    const nextEntries = { ...entries, [kind]: null };
    writeManifest(rootDir, nextEntries);
    removeFile(rootDir, oldEntry.file);
  }
  cleanupKindFiles(rootDir, kind);
  return defaultSound(kind);
}
