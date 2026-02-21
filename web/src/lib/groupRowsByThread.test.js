import assert from 'node:assert/strict';
import test from 'node:test';

import { groupRowsByThread } from './groupRowsByThread.js';

function makeStatsMap(entries) {
  const map = new Map();
  for (const [lsIndex, stats] of entries) {
    map.set(lsIndex, stats);
  }
  return map;
}

test('returns standalone rows when nodeStats is unavailable', () => {
  const rows = [{ ls_index: 1 }, { ls_index: 2 }];
  const items = groupRowsByThread(rows, null);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'standalone');
  assert.equal(items[0].hasMissingAncestors, false);
  assert.equal(items[1].type, 'standalone');
});

test('groups visible members when internal root is present', () => {
  const rows = [{ ls_index: 10 }, { ls_index: 11 }];
  const stats = makeStatsMap([
    [10, { tweetId: '10', threadRootId: '10', threadDepth: 0, threadSize: 4 }],
    [11, { tweetId: '11', threadRootId: '10', threadDepth: 1, threadSize: 4 }],
  ]);

  const items = groupRowsByThread(rows, stats);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'thread');
  assert.equal(items[0].threadRootId, '10');
  assert.equal(items[0].globalThreadSize, 4);
  assert.equal(items[0].visibleCount, 2);
  assert.equal(items[0].hasMissingAncestors, false);
});

test('depth-0 root alone still renders as thread group (global membership)', () => {
  const rows = [{ ls_index: 20 }];
  const stats = makeStatsMap([
    [20, { tweetId: '20', threadRootId: '20', threadDepth: 0, threadSize: 6 }],
  ]);

  const items = groupRowsByThread(rows, stats);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'thread');
  assert.equal(items[0].visibleCount, 1);
  assert.equal(items[0].globalThreadSize, 6);
  assert.equal(items[0].hasMissingAncestors, false);
});

test('standalone reply keeps missing-ancestor hint based on depth', () => {
  const rows = [{ ls_index: 30 }];
  const stats = makeStatsMap([
    [30, { tweetId: '30', threadRootId: '25', threadDepth: 2, threadSize: 3 }],
  ]);

  const items = groupRowsByThread(rows, stats);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'standalone');
  assert.equal(items[0].hasMissingAncestors, true);
  assert.equal(items[0].missingAncestorCount, 2);
});

test('does not bundle depth-1 siblings sharing an external root id', () => {
  const rows = [{ ls_index: 40 }, { ls_index: 41 }];
  const stats = makeStatsMap([
    [40, { tweetId: '40', threadRootId: '9000', threadDepth: 1, threadSize: 2 }],
    [41, { tweetId: '41', threadRootId: '9000', threadDepth: 1, threadSize: 2 }],
  ]);

  const items = groupRowsByThread(rows, stats);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'standalone');
  assert.equal(items[1].type, 'standalone');
});

test('bundles partial chains without visible root when depth > 1 exists', () => {
  const rows = [{ ls_index: 50 }, { ls_index: 51 }];
  const stats = makeStatsMap([
    [50, { tweetId: '50', threadRootId: '1000', threadDepth: 1, threadSize: 4 }],
    [51, { tweetId: '51', threadRootId: '1000', threadDepth: 2, threadSize: 4 }],
  ]);

  const items = groupRowsByThread(rows, stats);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'thread');
  assert.equal(items[0].hasMissingAncestors, true);
  assert.equal(items[0].missingAncestorCount, 1);
});
