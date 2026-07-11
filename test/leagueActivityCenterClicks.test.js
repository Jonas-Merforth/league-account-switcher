import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_CENTER_LAYOUT,
  buildActivityCenterClickPlan,
  buildBackgroundActivityCenterClickScript
} from '../src/core/leagueActivityCenterClicks.js';
import { LEAGUE_HEADER_RATIOS } from '../src/core/leagueHeaderClicks.js';

test('Activity Center click planning maps top, scrolled-bottom, and sticky rows', () => {
  const plan = buildActivityCenterClickPlan({
    tabCount: 10,
    tabIndices: [1, 3, 8, 9],
    stickyCount: 1,
    stickyIndices: [0]
  });
  assert.deepEqual(plan.top.map((entry) => entry.index), [1, 3]);
  assert.deepEqual(plan.bottom.map((entry) => entry.index), [8, 9]);
  assert.equal(plan.bottom[1].y, ACTIVITY_CENTER_LAYOUT.bottomLastTabY);
  assert.equal(
    plan.bottom[0].y,
    ACTIVITY_CENTER_LAYOUT.bottomLastTabY - ACTIVITY_CENTER_LAYOUT.tabStepY
  );
  assert.deepEqual(plan.sticky, [{ index: 0, y: ACTIVITY_CENTER_LAYOUT.stickyFirstY }]);
});

test('Activity Center click planning refuses a row outside its safe two-view coverage', () => {
  assert.throws(
    () => buildActivityCenterClickPlan({ tabCount: 20, tabIndices: [10] }),
    /outside the safe top\/bottom click ranges/
  );
});

test('Activity Center background script scrolls without focus or real cursor input', () => {
  const script = buildBackgroundActivityCenterClickScript({
    tabCount: 10,
    tabIndices: [1, 9],
    stickyCount: 1,
    stickyIndices: [0]
  });

  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /WM_MOUSEWHEEL = 0x020A/);
  assert.match(script, /ClientToScreen/);
  assert.match(script, /SW_SHOWNOACTIVATE/);
  assert.match(script, /SW_SHOWMINNOACTIVE/);
  assert.match(script, /activity-center-background-clicks-ok/);
  assert.doesNotMatch(script, /SetForegroundWindow/);
  assert.doesNotMatch(script, /SetCursorPos/);
  assert.doesNotMatch(script, /mouse_event/);

  const leagueClick = `Invoke-BackgroundClick ${LEAGUE_HEADER_RATIOS.league.x} ${LEAGUE_HEADER_RATIOS.league.y}`;
  const defaultClick = `Invoke-BackgroundClick ${ACTIVITY_CENTER_LAYOUT.sidebarX} ${ACTIVITY_CENTER_LAYOUT.firstTabY}`;
  const bottomScroll = script.indexOf('Activity Center bottom');
  const stickyClick = script.indexOf('Activity Center sticky tab 0');
  const finalDefault = script.lastIndexOf(defaultClick);
  assert.ok(script.indexOf(leagueClick) > -1);
  assert.ok(bottomScroll > -1);
  assert.ok(stickyClick > bottomScroll);
  assert.ok(finalDefault > stickyClick, 'the default League home card should be restored last');
});
