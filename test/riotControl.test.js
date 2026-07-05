import test from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_FIELD_RATIOS, buildPrefillScript } from '../src/core/riotControl.js';

test('buildPrefillScript refocuses the Riot login window during typing', () => {
  const script = buildPrefillScript(LOGIN_FIELD_RATIOS);

  assert.match(script, /function Focus-RiotWindow/);
  assert.match(script, /function Send-ToRiot/);
  assert.match(script, /function Paste-ToRiot/);
  assert.match(script, /Focus-RiotWindow\s+\[System\.Windows\.Forms\.SendKeys\]::SendWait\(\$keys\)/);
  assert.equal(script.includes("[System.Windows.Forms.SendKeys]::SendWait('^v')"), false);
});
