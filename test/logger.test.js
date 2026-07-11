import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'las-log-'));
process.env.LCA_CONFIG_DIR = tmp;

const { createLogger, flushPendingLogs, pruneOldLogs } = await import('../src/core/logger.js');
const { getLogPath } = await import('../src/core/config.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

});

test('batched logger preserves detailed lines and ordering', () => {
  const log = createLogger();
  log('Friends detail one');
  log('Friends detail two\ncontinued', 'warn');
  flushPendingLogs();

  const text = fs.readFileSync(getLogPath(), 'utf8');
  const first = text.indexOf('Friends detail one');
  const second = text.indexOf('Friends detail two continued');
  assert.ok(first >= 0, 'first detailed line is written');
  assert.ok(second > first, 'second detailed line follows the first');
  assert.match(text, /\[WARN\] Friends detail two continued/);
});
