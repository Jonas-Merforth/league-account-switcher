import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFriendRankQueue, rankViews, smartFriendRankView } from '../src/renderer/rankView.js';

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

test('smart friend rank chooses the higher rank outside ranked play', () => {
  const view = smartFriendRankView({
    online: true,
    activity: { kind: 'lobby', queueId: 450, queueLabel: 'ARAM' },
    ranks: {
      solo: { tier: 'GOLD', division: 1, lp: 50, wins: 10, losses: 8 },
      flex: { tier: 'EMERALD', division: 4, lp: 12, wins: 4, losses: 2 }
    }
  });
  assert.equal(view.queue, 'flex');
  assert.equal(view.active, false);
  assert.match(view.tip[1], /Solo\/Duo: Gold I/);
  assert.match(view.tip[2], /Flex 5v5: Emerald IV/);
});

test('smart friend rank follows and highlights the active ranked queue', () => {
  const ranks = {
    solo: { tier: 'DIAMOND', division: 2, lp: 20, wins: 20, losses: 10 },
    flex: { tier: 'SILVER', division: 1, lp: 4, wins: 2, losses: 1 }
  };
  const flex = smartFriendRankView({
    online: true,
    activity: { kind: 'inGame', queueId: 440, queueLabel: 'Ranked Flex' },
    ranks
  });
  assert.equal(flex.queue, 'flex');
  assert.equal(flex.active, true);
  assert.equal(flex.tip[0], 'PLAYING RANKED FLEX');
  assert.equal(activeFriendRankQueue({ kind: 'champSelect', gameQueueType: 'RANKED_SOLO_5x5' }), 'solo');
});

test('smart friend rank ignores stale ranked queue details while away or post-game', () => {
  const ranks = {
    solo: { tier: 'EMERALD', division: 4, lp: 36, wins: 175, losses: 0 },
    flex: null
  };
  for (const kind of ['away', 'postGame']) {
    const view = smartFriendRankView({
      online: true,
      activity: { kind, queueId: 420, gameQueueType: 'RANKED_SOLO_5x5' },
      ranks
    });
    assert.equal(view.queue, 'solo');
    assert.equal(view.active, false);
    assert.equal(view.activeQueue, null);
    assert.equal(view.tip[0], 'CURRENT RANKS');
  }
});

test('redacted friend losses are labeled unavailable instead of displayed as zero', () => {
  const view = smartFriendRankView({
    online: true,
    ranks: {
      solo: { tier: 'GOLD', division: 1, lp: 50, wins: 10, losses: null },
      flex: null
    }
  });
  assert.match(view.tip[1], /10 Wins \| Losses unavailable/);
  assert.doesNotMatch(view.tip[1], /0 Losses/);
});

test('smart friend rank hides unavailable and offline ranks but shows active unranked play', () => {
  assert.equal(smartFriendRankView({ online: true }), null);
  assert.equal(smartFriendRankView({ online: false, ranks: { solo: null, flex: null } }), null);
  const unranked = smartFriendRankView({
    online: true,
    activity: { kind: 'queue', queueId: 420 },
    ranks: { solo: null, flex: null }
  });
  assert.equal(unranked.state, 'unranked');
  assert.equal(unranked.active, true);
});
