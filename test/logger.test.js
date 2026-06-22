import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'las-log-'));
process.env.LCA_CONFIG_DIR = tmp;

const { pruneOldLogs } = await import('../src/core/logger.js');
const { getLogPath } = await import('../src/core/config.js');

test('pruneOldLogs drops entries older than the retention window, keeps recent ones', () => {
  const logPath = getLogPath();
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(logPath, `# header line\n${old} [INFO] old entry\n${recent} [INFO] recent entry\n`, 'utf8');

  pruneOldLogs(3);

  const text = fs.readFileSync(logPath, 'utf8');
  assert.ok(!text.includes('old entry'), 'old entry pruned');
  assert.ok(text.includes('recent entry'), 'recent entry kept');
  assert.ok(!text.includes('# header line'), 'non-timestamped lines dropped during prune');

  fs.rmSync(tmp, { recursive: true, force: true });
});
