import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHierarchyColorMap,
  buildSiblingVariants,
  selectHierarchyColorAnchor,
} from './useClusterColors.js';

test('buildSiblingVariants keeps small sibling groups in one family with distinct tones', () => {
  const variants = buildSiblingVariants(3, 4, 8, 6);

  assert.equal(variants.length, 3);
  assert.deepEqual(
    [...new Set(variants.map((variant) => variant.hueIdx))],
    [4]
  );
  assert.equal(new Set(variants.map((variant) => variant.toneIdx)).size, 3);
});

test('buildSiblingVariants adds bounded hue drift when siblings exceed tone capacity', () => {
  const variants = buildSiblingVariants(8, 3, 8, 6);
  const hueIndices = [...new Set(variants.map((variant) => variant.hueIdx))];

  assert.equal(variants.length, 8);
  assert.ok(hueIndices.length > 1);
  assert.ok(hueIndices.every((hueIdx) => Math.abs(hueIdx - 3) <= 1));
});

test('buildHierarchyColorMap differentiates siblings under the same inherited family', () => {
  const makeChildren = (rootId, startOrder) => [
    {
      cluster: `${rootId}_a`,
      label: `${rootId} child a`,
      layer: 1,
      semantic_order: startOrder,
      children: [],
    },
    {
      cluster: `${rootId}_b`,
      label: `${rootId} child b`,
      layer: 1,
      semantic_order: startOrder + 0.1,
      children: [],
    },
    {
      cluster: `${rootId}_c`,
      label: `${rootId} child c`,
      layer: 1,
      semantic_order: startOrder + 0.2,
      children: [],
    },
  ];

  const clusterHierarchy = {
    children: [
      {
        cluster: 'root_0',
        label: 'Root 0',
        layer: 2,
        semantic_order: 0.0,
        children: makeChildren('root_0', 0.0),
      },
      {
        cluster: 'root_1',
        label: 'Root 1',
        layer: 2,
        semantic_order: 0.25,
        children: makeChildren('root_1', 0.3),
      },
      {
        cluster: 'root_2',
        label: 'Root 2',
        layer: 2,
        semantic_order: 0.5,
        children: makeChildren('root_2', 0.6),
      },
      {
        cluster: 'root_3',
        label: 'Root 3',
        layer: 2,
        semantic_order: 0.75,
        children: makeChildren('root_3', 0.9),
      },
      {
        cluster: 'root_4',
        label: 'Root 4',
        layer: 2,
        semantic_order: 1.0,
        children: makeChildren('root_4', 1.2),
      },
    ],
  };

  const colorMap = buildHierarchyColorMap(clusterHierarchy);

  assert.ok(colorMap instanceof Map);

  const firstChild = colorMap.get('root_0_a');
  const secondChild = colorMap.get('root_0_b');
  const thirdChild = colorMap.get('root_0_c');

  assert.ok(firstChild);
  assert.ok(secondChild);
  assert.ok(thirdChild);
  assert.notDeepEqual(firstChild.light, secondChild.light);
  assert.notDeepEqual(secondChild.light, thirdChild.light);
});

test('selectHierarchyColorAnchor prefers a connected browse layer over a sparse root layer', () => {
  const makeChildren = (rootId, startOrder) =>
    Array.from({ length: 3 }, (_, idx) => ({
      cluster: `${rootId}_child_${idx}`,
      label: `${rootId} child ${idx}`,
      layer: 3,
      semantic_order: startOrder + idx * 0.1,
      children: [],
    }));

  const clusterHierarchy = {
    children: Array.from({ length: 3 }, (_, idx) => ({
      cluster: `root_${idx}`,
      label: `Root ${idx}`,
      layer: 4,
      semantic_order: idx,
      children: makeChildren(`root_${idx}`, idx),
    })),
  };

  const anchor = selectHierarchyColorAnchor(clusterHierarchy, 8);

  assert.equal(anchor.layer, 3);
  assert.equal(anchor.nodes.length, 9);
});

test('selectHierarchyColorAnchor ignores detached lower roots when choosing the anchor layer', () => {
  const clusterHierarchy = {
    children: [
      ...Array.from({ length: 5 }, (_, idx) => ({
        cluster: `root_${idx}`,
        label: `Root ${idx}`,
        layer: 4,
        semantic_order: idx,
        children: [
          {
            cluster: `root_${idx}_child`,
            label: `Root ${idx} child`,
            layer: 3,
            semantic_order: idx + 0.1,
            children: [],
          },
        ],
      })),
      ...Array.from({ length: 3 }, (_, idx) => ({
        cluster: `detached_${idx}`,
        label: `Detached ${idx}`,
        layer: 3,
        semantic_order: idx + 10,
        children: [],
      })),
    ],
  };

  const anchor = selectHierarchyColorAnchor(clusterHierarchy, 8);
  const colorMap = buildHierarchyColorMap(clusterHierarchy);

  assert.equal(anchor.layer, 4);
  assert.equal(anchor.nodes.length, 5);
  assert.ok(colorMap.get('detached_0'));
  assert.ok(colorMap.get('detached_1'));
  assert.ok(colorMap.get('detached_2'));
});
