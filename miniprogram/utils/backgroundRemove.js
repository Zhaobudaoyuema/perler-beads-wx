/**
 * 一键去背景算法（移植自 src/app/page.tsx 1305-1411）
 *
 * 思路：
 *  1. 统计四边格子里出现最多的色号 = 推测背景色
 *  2. 从四条边上的同色格出发洪水填充，把所有连通的同色格标记为 isExternal: true
 *
 * 标记后的格子在统计、预览、导出图、采购单中均跳过。
 */

const TRANSPARENT = { key: 'ERASE', color: '#FFFFFF', isExternal: true };

/**
 * @param {Array<Array<{key,color,isExternal?}>>} mappedData
 * @returns {{ data: Array<Array<{key,color,isExternal?}>>, removedKey: string|null, removedCount: number }}
 */
function removeBoundaryBackground(mappedData) {
  if (!mappedData || mappedData.length === 0) {
    return { data: mappedData, removedKey: null, removedCount: 0 };
  }
  const M = mappedData.length;
  const N = mappedData[0].length;

  // 1. 统计边缘格主色
  const borderCounts = new Map();
  const tally = (r, c) => {
    const cell = mappedData[r] && mappedData[r][c];
    if (!cell || cell.isExternal || !cell.key) return;
    borderCounts.set(cell.key, (borderCounts.get(cell.key) || 0) + 1);
  };
  for (let c = 0; c < N; c++) {
    tally(0, c);
    if (M > 1) tally(M - 1, c);
  }
  for (let r = 1; r < M - 1; r++) {
    tally(r, 0);
    if (N > 1) tally(r, N - 1);
  }
  if (borderCounts.size === 0) {
    return { data: mappedData, removedKey: null, removedCount: 0 };
  }

  let targetKey = null;
  let max = -1;
  borderCounts.forEach((count, key) => {
    if (count > max) {
      max = count;
      targetKey = key;
    }
  });

  // 2. 从所有边界目标格出发洪水填充
  const result = mappedData.map(row => row.map(cell => Object.assign({}, cell)));
  const visited = Array(M).fill(null).map(() => Array(N).fill(false));
  const stack = [];

  const push = (r, c) => {
    if (r < 0 || r >= M || c < 0 || c >= N || visited[r][c]) return;
    const cell = result[r][c];
    if (!cell || cell.isExternal || cell.key !== targetKey) return;
    visited[r][c] = true;
    stack.push([r, c]);
  };

  for (let c = 0; c < N; c++) {
    push(0, c);
    if (M > 1) push(M - 1, c);
  }
  for (let r = 1; r < M - 1; r++) {
    push(r, 0);
    if (N > 1) push(r, N - 1);
  }

  if (stack.length === 0) {
    return { data: mappedData, removedKey: targetKey, removedCount: 0 };
  }

  let removedCount = 0;
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    result[r][c] = Object.assign({}, TRANSPARENT);
    removedCount++;
    push(r - 1, c);
    push(r + 1, c);
    push(r, c - 1);
    push(r, c + 1);
  }

  return { data: result, removedKey: targetKey, removedCount };
}

module.exports = { removeBoundaryBackground, TRANSPARENT };
