import test from 'node:test';
import assert from 'node:assert/strict';
import { nextUpdateView } from '../src/renderer/updateState.js';

test('available (manual): shows the update with an action, dismissible', () => {
  const view = nextUpdateView({ state: 'available', version: '1.0.1' }, false, false);
  assert.equal(view.visible, true);
  assert.equal(view.action, 'download');
  assert.equal(view.dismissible, true);
  assert.match(view.text, /Update available v1\.0\.1/);
});

test('available (manual) is hidden once dismissed', () => {
  const view = nextUpdateView({ state: 'available', version: '1.0.1' }, true, false);
  assert.equal(view.visible, false);
});

test('available (auto): always shown, no action, not suppressed by dismiss', () => {
  const view = nextUpdateView({ state: 'available', version: '1.0.1' }, true, true);
  assert.equal(view.visible, true);
  assert.equal(view.action, null);
  assert.equal(view.dismissible, false);
  assert.match(view.text, /downloading/i);
});

test('downloading always shows progress, regardless of dismiss', () => {
  const view = nextUpdateView({ state: 'downloading', percent: 42.6 }, true, false);
  assert.equal(view.visible, true);
  assert.match(view.text, /43%/);
  assert.equal(view.action, null);
});

test('downloaded (manual) offers install; (auto) just restarts', () => {
  const manual = nextUpdateView({ state: 'downloaded', version: '1.0.1' }, false, false);
  assert.equal(manual.action, 'install');
  assert.match(manual.text, /restart to install/i);

  const auto = nextUpdateView({ state: 'downloaded', version: '1.0.1' }, false, true);
  assert.equal(auto.action, null);
  assert.match(auto.text, /restarting/i);
});

test('checking/none/error only show for a manual check', () => {
  assert.equal(nextUpdateView({ state: 'none' }, false, false).visible, false);
  assert.equal(nextUpdateView({ state: 'none', manual: true }, false, false).visible, true);

  const err = nextUpdateView({ state: 'error', manual: true, message: 'boom' }, false, false);
  assert.equal(err.visible, true);
  assert.equal(err.transient, true);
  assert.match(err.text, /boom/);
});

test('idle / unknown is hidden', () => {
  assert.equal(nextUpdateView({ state: 'idle' }).visible, false);
  assert.equal(nextUpdateView(null).visible, false);
});
