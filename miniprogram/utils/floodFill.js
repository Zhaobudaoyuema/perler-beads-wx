/**
 * 连通区域工具（移植自 src/utils/floodFillUtils.ts）
 *
 * 用于专注模式：
 *  - getConnectedRegion / getAllConnectedRegions：查找同色连通块
 *  - isRegionCompleted / isRegionPartiallyCompleted：判断完成状态
 *  - getRegionCenter：区域中心点（用于跳转/标记）
 *  - sortRegionsByDistance / sortRegionsBySize：按引导模式排序
 *
 * 不依赖 wx.* / Page，纯算法
 */

/**
 * 单点起始的洪水填充，返回所有同色连通格
 *
 * @param mappedData MappedPixel[][] (M 行 × N 列)
 * @param startRow
 * @param startCol
 * @param targetColor cell.color（hex 字符串）
 * @returns Array<{row, col}>
 */
function getConnectedRegion(mappedData, startRow, startCol, targetColor) {
  if (!mappedData || !mappedData[startRow] || !mappedData[startRow][startCol]) {
    return [];
  }
  const M = mappedData.length;
  const N = mappedData[0].length;
  const visited = new Array(M);
  for (let r = 0; r < M; r++) visited[r] = new Array(N).fill(false);

  const region = [];
  const stack = [{ row: startRow, col: startCol }];

  while (stack.length > 0) {
    const { row, col } = stack.pop();
    if (row < 0 || row >= M || col < 0 || col >= N || visited[row][col]) continue;
    const cell = mappedData[row][col];
    if (!cell || cell.isExternal || cell.color !== targetColor) continue;
    visited[row][col] = true;
    region.push({ row, col });
    stack.push(
      { row: row - 1, col },
      { row: row + 1, col },
      { row, col: col - 1 },
      { row, col: col + 1 }
    );
  }
  return region;
}

/**
 * 找出所有指定 targetColor 的连通区域
 */
function getAllConnectedRegions(mappedData, targetColor) {
  if (!mappedData || mappedData.length === 0) return [];
  const M = mappedData.length;
  const N = mappedData[0].length;
  const visited = new Array(M);
  for (let r = 0; r < M; r++) visited[r] = new Array(N).fill(false);
  const regions = [];

  for (let row = 0; row < M; row++) {
    for (let col = 0; col < N; col++) {
      if (visited[row][col]) continue;
      const cell = mappedData[row][col];
      if (!cell || cell.isExternal || cell.color !== targetColor) continue;
      const region = getConnectedRegion(mappedData, row, col, targetColor);
      if (region.length > 0) {
        regions.push(region);
        region.forEach(({ row: r, col: c }) => { visited[r][c] = true; });
      }
    }
  }
  return regions;
}

function isRegionCompleted(region, completedSet) {
  if (!region || region.length === 0) return false;
  for (let i = 0; i < region.length; i++) {
    const r = region[i];
    if (!completedSet.has(r.row + ',' + r.col)) return false;
  }
  return true;
}

function isRegionPartiallyCompleted(region, completedSet) {
  if (!region || region.length === 0) return false;
  for (let i = 0; i < region.length; i++) {
    const r = region[i];
    if (completedSet.has(r.row + ',' + r.col)) return true;
  }
  return false;
}

function getRegionCenter(region) {
  if (!region || region.length === 0) return { row: 0, col: 0 };
  let sumR = 0, sumC = 0;
  for (let i = 0; i < region.length; i++) {
    sumR += region[i].row;
    sumC += region[i].col;
  }
  return {
    row: Math.floor(sumR / region.length),
    col: Math.floor(sumC / region.length)
  };
}

/**
 * 按曼哈顿距离排序区域（最近优先）
 */
function sortRegionsByDistance(regions, ref) {
  return regions.slice().sort((a, b) => {
    const ca = getRegionCenter(a);
    const cb = getRegionCenter(b);
    const da = Math.abs(ca.row - ref.row) + Math.abs(ca.col - ref.col);
    const db = Math.abs(cb.row - ref.row) + Math.abs(cb.col - ref.col);
    return da - db;
  });
}

/**
 * 按大小排序（最大优先）
 */
function sortRegionsBySize(regions) {
  return regions.slice().sort((a, b) => b.length - a.length);
}

/**
 * 边缘优先：先把所有触碰边缘的区域排前
 */
function sortRegionsEdgeFirst(regions, M, N) {
  const isEdge = (region) => {
    for (let i = 0; i < region.length; i++) {
      const r = region[i];
      if (r.row === 0 || r.row === M - 1 || r.col === 0 || r.col === N - 1) return true;
    }
    return false;
  };
  return regions.slice().sort((a, b) => {
    const ea = isEdge(a) ? 0 : 1;
    const eb = isEdge(b) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return b.length - a.length;
  });
}

module.exports = {
  getConnectedRegion,
  getAllConnectedRegions,
  isRegionCompleted,
  isRegionPartiallyCompleted,
  getRegionCenter,
  sortRegionsByDistance,
  sortRegionsBySize,
  sortRegionsEdgeFirst
};
