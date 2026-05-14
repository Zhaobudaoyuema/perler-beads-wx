/**
 * 杂色合并算法（移植自 src/app/page.tsx 920-1014）
 *
 * 思路：按色频降序处理；对每个高频色，把其余距离 < threshold 的低频色全图替换为它。
 * 复用 colorDistance（Oklab 0-100 区间）。
 */

const { colorDistance, hexToRgb } = require('./pixelation.js');

/**
 * @param {Array<Array<{key,color,isExternal?}>>} mappedData
 * @param {Array<{key,hex,rgb}>} palette 当前 active palette（仅用于查 RGB / 显示色）
 * @param {number} threshold 0-50，建议 30；0 表示不合并
 * @returns {{ data: Array<Array<{key,color,isExternal?}>>, mergedCount: number }}
 */
function mergeSimilarColors(mappedData, palette, threshold) {
  if (!mappedData || mappedData.length === 0 || threshold <= 0) {
    return { data: mappedData, mergedCount: 0 };
  }

  const M = mappedData.length;
  const N = mappedData[0].length;

  // key -> rgb / hex 映射
  const keyToRgb = new Map();
  const keyToHex = new Map();
  palette.forEach(p => {
    keyToRgb.set(p.key, p.rgb);
    keyToHex.set(p.key, p.hex);
  });

  // 1. 统计初始用量（仅非外部 / 非空格）
  const counts = {};
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const c = mappedData[j][i];
      if (!c || c.isExternal || !c.key) continue;
      counts[c.key] = (counts[c.key] || 0) + 1;
      // 兜底：当前 palette 中找不到该 key 时，从 cell.color 解析 RGB
      if (!keyToRgb.has(c.key) && c.color) {
        const rgb = hexToRgb(c.color);
        if (rgb) {
          keyToRgb.set(c.key, rgb);
          keyToHex.set(c.key, c.color);
        }
      }
    }
  }

  // 2. 按频率降序
  const byFreq = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (byFreq.length === 0) {
    return { data: mappedData, mergedCount: 0 };
  }

  // 3. 复制 mappedData
  const result = mappedData.map(row => row.map(cell => Object.assign({}, cell)));

  // 4. 处理合并
  const replaced = new Set();
  for (let i = 0; i < byFreq.length; i++) {
    const high = byFreq[i];
    if (replaced.has(high)) continue;
    const highRgb = keyToRgb.get(high);
    if (!highRgb) continue;

    for (let j = i + 1; j < byFreq.length; j++) {
      const low = byFreq[j];
      if (replaced.has(low)) continue;
      const lowRgb = keyToRgb.get(low);
      if (!lowRgb) continue;

      const dist = colorDistance(highRgb, lowRgb);
      if (dist < threshold) {
        replaced.add(low);
        const newHex = keyToHex.get(high);
        // 全图替换 low → high
        for (let r = 0; r < M; r++) {
          for (let c = 0; c < N; c++) {
            if (result[r][c].key === low && !result[r][c].isExternal) {
              result[r][c] = { key: high, color: newHex, isExternal: false };
            }
          }
        }
      }
    }
  }

  return { data: result, mergedCount: replaced.size };
}

module.exports = { mergeSimilarColors };
