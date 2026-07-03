import test from 'node:test';
import assert from 'node:assert/strict';
import { rankViews } from '../src/renderer/rankView.js';

test('never-fetched ranks render as unknown placeholders, solo first', () => {
  const views = rankViews(null);
  assert.equal(views.length, 2);
  assert.equal(views[0].queue, 'solo');
  assert.equal(views[1].queue, 'flex');
  for (const view of views) {
    assert.equal(view.state, 'unknown');
    assert.equal(view.img, 'ranks/unranked.png');
    assert.equal(view.overlay, '?');
    assert.ok(view.tip.includes('Rank not fetched yet'));
  }
});

test('an unranked queue shows the grayed unranked crest without an overlay', () => {
  const views = rankViews({ solo: null, flex: null, updatedAt: '2026-07-03T00:00:00Z' });
  for (const view of views) {
    assert.equal(view.state, 'unranked');
    assert.equal(view.img, 'ranks/unranked.png');
    assert.equal(view.overlay, '');
    assert.deepEqual(view.tip.slice(1), ['Unranked']);
  }
});

test('a ranked queue shows the tier crest, division overlay, and detail tooltip', () => {
  const [solo, flex] = rankViews({
    solo: { tier: 'GOLD', division: 3, lp: 85, wins: 18, losses: 21 },
    flex: { tier: 'EMERALD', division: 2, lp: 13, wins: 26, losses: 20 },
    updatedAt: '2026-07-03T00:00:00Z'
  });
  assert.equal(solo.state, 'ranked');
  assert.equal(solo.img, 'ranks/gold.png');
  assert.equal(solo.overlay, '3');
  assert.equal(solo.tip[0], 'SOLO/DUO');
  assert.equal(solo.tip[1], 'Gold III — 85 LP');
  assert.equal(solo.tip[2], '18 Wins | 21 Losses');
  assert.equal(flex.img, 'ranks/emerald.png');
  assert.equal(flex.tip[0], 'FLEX 5V5');
});

test('apex tiers have no overlay but keep LP in the tooltip', () => {
  const [solo] = rankViews({ solo: { tier: 'MASTER', division: null, lp: 245, wins: 100, losses: 90 }, flex: null });
  assert.equal(solo.overlay, '');
  assert.equal(solo.tip[1], 'Master — 245 LP');
});
