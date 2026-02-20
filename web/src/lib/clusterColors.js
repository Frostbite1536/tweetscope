// Flexoki-inspired cluster color palette.
// Shared module — consumed by DeckGLScatter, TweetCard, SearchResults,
// Container, VisualizationPane and any future cluster-referencing UI.

// ── Palette tables ──────────────────────────────────────────────────
// 6 tones × 8 hues = 48 unique colors before cycling.
// All values are official Flexoki extended palette (v2.0) derived from
// Oklab color space. Hue order: red, orange, yellow, green, cyan, blue,
// purple, magenta.
//
// Light mode uses scales 300→800 (darker accents on warm paper).
// Dark mode uses scales 100→500 (lighter accents on ink backgrounds).
// Original 3-row palette used scales 500/600/700 (light) and 200/300/400 (dark).
export const FLEXOKI_CLUSTER_TONES_LIGHT = [
  [[232, 112, 95], [236, 139, 73], [223, 180, 49], [160, 175, 84], [90, 189, 172], [102, 160, 200], [166, 153, 208], [228, 125, 168]],  // 300
  [[209, 77, 65], [218, 112, 44], [208, 162, 21], [135, 154, 57], [58, 169, 159], [67, 133, 190], [139, 126, 200], [206, 93, 151]],  // 400
  [[192, 62, 53], [203, 97, 32], [190, 146, 7], [118, 141, 33], [47, 150, 141], [49, 113, 178], [115, 94, 181], [183, 69, 131]],  // 500
  [[175, 48, 41], [188, 82, 21], [173, 131, 1], [102, 128, 11], [36, 131, 123], [32, 94, 166], [94, 64, 157], [160, 47, 111]],  // 600
  [[148, 40, 34], [157, 67, 16], [142, 107, 1], [83, 105, 7], [28, 108, 102], [26, 79, 140], [79, 54, 133], [135, 40, 94]],  // 700
  [[108, 32, 28], [113, 50, 13], [102, 77, 1], [61, 76, 7], [22, 79, 74], [22, 59, 102], [60, 42, 98], [100, 31, 70]],  // 800
];

export const FLEXOKI_CLUSTER_TONES_DARK = [
  [[255, 202, 187], [254, 211, 175], [246, 226, 160], [221, 226, 178], [191, 232, 217], [198, 221, 232], [226, 217, 233], [252, 207, 218]],  // 100
  [[253, 178, 162], [252, 193, 146], [241, 214, 126], [205, 213, 151], [162, 222, 206], [171, 207, 226], [211, 202, 230], [249, 185, 207]],  // 150
  [[248, 154, 138], [249, 174, 119], [236, 203, 96], [190, 201, 126], [135, 211, 195], [146, 191, 219], [196, 185, 224], [244, 164, 194]],  // 200
  [[232, 112, 95], [236, 139, 73], [223, 180, 49], [160, 175, 84], [90, 189, 172], [102, 160, 200], [166, 153, 208], [228, 125, 168]],  // 300
  [[209, 77, 65], [218, 112, 44], [208, 162, 21], [135, 154, 57], [58, 169, 159], [67, 133, 190], [139, 126, 200], [206, 93, 151]],  // 400
  [[192, 62, 53], [203, 97, 32], [190, 146, 7], [118, 141, 33], [47, 150, 141], [49, 113, 178], [115, 94, 181], [183, 69, 131]],  // 500
];

const FLEXOKI_CLUSTER_UNKNOWN_LIGHT = [145, 130, 100]; // warm stone
const FLEXOKI_CLUSTER_UNKNOWN_DARK = [185, 170, 140];

// Canonical 8-hue palette (original Flexoki mid-tone, now row 3).
export const CLUSTER_PALETTE = FLEXOKI_CLUSTER_TONES_LIGHT[3];

// ── Cluster ID → numeric index ──────────────────────────────────────
// Converts cluster identifiers to a numeric index for palette lookup.
export const clusterIdToIndex = (clusterId) => {
  if (clusterId === null || clusterId === undefined) return -1;

  if (typeof clusterId === 'number') return clusterId;

  if (typeof clusterId === 'string') {
    if (clusterId === 'unknown') return -1;

    // "layer_index" format (e.g., "0_5" → 5)
    const match = clusterId.match(/_(\d+)$/);
    if (match) return parseInt(match[1], 10);

    // Plain number string
    const parsed = parseInt(clusterId, 10);
    if (!isNaN(parsed)) return parsed;
  }

  return -1; // Unknown — triggers stone color, not cluster 0
};

// ── Core color lookup ───────────────────────────────────────────────
export const getClusterToneColor = (clusterId, isDarkMode) => {
  const idx = clusterIdToIndex(clusterId);
  if (idx < 0) {
    return isDarkMode ? FLEXOKI_CLUSTER_UNKNOWN_DARK : FLEXOKI_CLUSTER_UNKNOWN_LIGHT;
  }

  const toneTable = isDarkMode ? FLEXOKI_CLUSTER_TONES_DARK : FLEXOKI_CLUSTER_TONES_LIGHT;
  const hueCount = toneTable[0].length;
  const toneIdx = Math.floor(Math.abs(idx) / hueCount) % toneTable.length;
  const hueIdx = Math.abs(idx) % hueCount;
  return toneTable[toneIdx][hueIdx];
};

// ── Public helpers ──────────────────────────────────────────────────
const toRgbaString = (rgbColor, alpha = 1) => {
  const [r, g, b] = rgbColor;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const getClusterColor = (clusterId, alpha = 180, isDarkMode = false) => {
  const color = getClusterToneColor(clusterId, isDarkMode);
  return [...color, alpha];
};

export const getClusterColorRGBA = (clusterId, isDarkMode = false, alpha = 255) => {
  const color = getClusterToneColor(clusterId, isDarkMode);
  return [...color, alpha];
};

export const getClusterColorCSS = (clusterId, isDarkMode = false, alpha = 1) => {
  const color = getClusterToneColor(clusterId, isDarkMode);
  return toRgbaString(color, alpha);
};
