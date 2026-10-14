import test from 'node:test';
import assert from 'node:assert/strict';
import { submitRiotLoginThroughControls } from '../src/core/riotLoginAutomation.js';
import { buildBackgroundPrefillScript, LOGIN_FIELD_RATIOS } from '../src/core/riotControl.js';
import { RIOT_PROCESS_IMAGES } from '../src/core/constants.js';

test('background form automation passes credentials only over stdin and retains verified submission state', async () => {
  const result = await submitRiotLoginThroughControls({
    username: 'fixture-user', password: 'private-fixture', servicesPath: 'C:/Riot/RiotClientServices.exe',
    execute: async (script, options) => {
      assert.equal(script.includes('private-fixture'), false);
      assert.equal(JSON.parse(options.input).password, 'private-fixture');
      assert.doesNotMatch(script, /SendInput|SetForegroundWindow|Clipboard|SendKeys|mouse_event/);
      assert.match(script, /RequestAccessibility\(\$candidate.MainWindowHandle\)/);
      assert.match(script, /SendMessageTimeout\(hwnd,0x003D,IntPtr.Zero,new IntPtr\(1\),2,300/);
      return '{"submitted":true,"persistenceVerified":true,"method":"accessibility-msaa"}';
    }
  });
  assert.equal(result.submitted, true);
  assert.equal(result.persistenceVerified, true);
});

test('switch shutdown includes both current and legacy Riot renderers before their service', () => {
  for (const image of ['Riot Client.exe', 'RiotClientUx.exe', 'RiotClientUxRender.exe']) {
    assert.ok(RIOT_PROCESS_IMAGES.indexOf(image) >= 0);
    assert.ok(RIOT_PROCESS_IMAGES.indexOf(image) < RIOT_PROCESS_IMAGES.indexOf('RiotClientServices.exe'));
  }
});

test('production input fallback requires a verified checkbox instead of toggling guessed coordinates', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS, { requireVerifiedPersistence: true });
  assert.doesNotMatch(script, /stay-signed-in-normal-fallback|stay-signed-in-classic-fallback/);
  assert.match(script, /Stay signed in could not be verified/);
});
