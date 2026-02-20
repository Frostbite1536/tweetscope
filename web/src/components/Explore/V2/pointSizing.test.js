import assert from 'node:assert/strict';
import test from 'node:test';

import { getEngagementScore, getLikesCount } from '../../../lib/engagement.js';
import { applyInteractionRadius, computePointRadii } from './pointSizing.js';

test('likes precedence uses like_count before likes', () => {
  const row = { likes: 0, like_count: 1 };
  assert.equal(getLikesCount(row), 1);
});

test('engagement score keeps likes stronger than replies', () => {
  const oneLike = getEngagementScore({ favorites: 1, replies: 0, retweets: 0 });
  const oneReply = getEngagementScore({ favorites: 0, replies: 1, retweets: 0 });
  assert.ok(oneLike > oneReply);
});

test('base radii keep non-zero engagement above zero engagement', () => {
  const rows = [
    { favorites: 1, retweets: 0, replies: 0 },
    { favorites: 0, retweets: 0, replies: 0 },
  ];
  const radii = computePointRadii(rows, rows.length);
  assert.ok(radii[0] > radii[1], `expected non-zero radius ${radii[0]} to exceed zero radius ${radii[1]}`);
});

test('interaction modifiers are monotonic boosts on top of base radius', () => {
  const base = 3.2;
  const highlighted = applyInteractionRadius(base, { isHighlighted: true });
  const hovered = applyInteractionRadius(base, { isHovered: true });
  const both = applyInteractionRadius(base, { isHovered: true, isHighlighted: true });

  assert.ok(highlighted > base);
  assert.ok(hovered > base);
  assert.ok(both > highlighted);
  assert.ok(both > hovered);
});

