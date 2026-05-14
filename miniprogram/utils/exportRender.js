/**
 * 导出图纸渲染（移植自 src/utils/imageDownloader.ts）
 *
 * 与预览的简版渲染解耦：
 *  - 预览：fast，仅色块 + 描边 + 文字
 *  - 导出：slow，可选 坐标轴 / 粗网格 / 网格颜色 / cell 文字 / 底部统计
 *
 * 入参完全是普通对象 + ctx，不依赖 wx.* / Page，方便单元测试 & 主页/专注页复用
 */

const { drawCellOnContext, getContrastColor } = require('./previewRender.js');

const DEFAULT_CELL = 26;       // 导出每格像素（CSS px）
const DEFAULT_HEADER = 64;     // 顶部品牌横条高度
const STATS_PADDING = 16;      // 统计区域内边距

/**
 * 生成色号统计列表（按用量降序，与主页 usageList 一致）
 */
function buildStatsItems(colorCountMap, palette) {
  const hexByKey = {};
  (palette || []).forEach(p => { hexByKey[p.key] = p.hex; });
  return Object.keys(colorCountMap || {}).map(key => ({
    key,
    count: colorCountMap[key],
    color: hexByKey[key] || '#cccccc'
  })).sort((a, b) => b.count - a.count);
}

/**
 * 计算导出 canvas 的 CSS 尺寸（不含 dpr 缩放）
 *
 * @param N 横向格数
 * @param M 纵向格数
 * @param options {
 *   cellPx?: number              // 每格像素，默认 26
 *   showCoordinates?: boolean    // 顶部/左侧坐标轴
 *   includeStats?: boolean       // 底部色号统计
 *   statsItemsCount?: number     // 用于估算 stats 区高度
 * }
 */
function computeExportLayout(N, M, options) {
  const o = options || {};
  const cell = o.cellPx || DEFAULT_CELL;
  const headerH = DEFAULT_HEADER;
  const showCoords = !!o.showCoordinates;
  const axisLabelSize = showCoords ? Math.max(28, Math.floor(cell)) : 0;
  const extraMargin = showCoords ? Math.max(16, Math.floor(cell * 0.6)) : 8;

  const gridW = N * cell;
  const gridH = M * cell;

  const cssW = gridW + axisLabelSize * 2 + extraMargin * 2;
  let cssH = headerH + extraMargin + axisLabelSize + gridH + axisLabelSize + extraMargin;

  // 估算 stats 区域
  let statsH = 0;
  if (o.includeStats) {
    const itemsCount = o.statsItemsCount || 0;
    const numColumns = Math.max(1, Math.min(4, Math.floor((cssW - STATS_PADDING * 2) / 220)));
    const numRows = Math.ceil(itemsCount / numColumns);
    const swatchSize = 22;
    const rowH = Math.max(swatchSize + 8, 26);
    const titleH = 36;
    const footerH = 36;
    const topMargin = 16;
    statsH = topMargin + titleH + numRows * rowH + footerH + STATS_PADDING * 2;
    cssH += statsH;
  }

  return {
    cell,
    headerH,
    axisLabelSize,
    extraMargin,
    gridW,
    gridH,
    gridOriginX: extraMargin + axisLabelSize,
    gridOriginY: headerH + extraMargin + axisLabelSize,
    cssW,
    cssH,
    statsH,
    statsTop: cssH - statsH
  };
}

/**
 * 渲染顶部品牌 header（深色横条 + 标题 + 副标题，简化版，去掉二维码）
 */
function drawHeader(ctx, layout, info) {
  const { cssW, headerH } = layout;
  const brand = (info && info.brand) || '';
  const N = (info && info.N) || 0;
  const M = (info && info.M) || 0;

  // 主背景
  ctx.fillStyle = '#1F2937';
  ctx.fillRect(0, 0, cssW, headerH);

  // 左侧渐变品牌色块
  const brandBlockW = headerH * 0.85;
  const grad = ctx.createLinearGradient(0, 0, brandBlockW, headerH);
  grad.addColorStop(0, '#6366F1');
  grad.addColorStop(1, '#8B5CF6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, brandBlockW, headerH);

  // 抽象 logo（3x3 圆角小方块）
  const logoSize = headerH * 0.42;
  const cx = brandBlockW / 2;
  const cy = headerH / 2;
  const beadSize = logoSize / 4;
  const beadSpacing = beadSize * 1.15;
  ctx.fillStyle = '#FFFFFF';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const bx = cx - logoSize / 2 + c * beadSpacing;
      const by = cy - logoSize / 2 + r * beadSpacing;
      // 兼容 mp 没有 roundRect 的环境
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(bx, by, beadSize, beadSize, beadSize * 0.2);
        ctx.fill();
      } else {
        ctx.fillRect(bx, by, beadSize, beadSize);
      }
    }
  }

  // 标题文字
  const titleX = brandBlockW + headerH * 0.3;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const mainSize = Math.max(18, Math.floor(headerH * 0.32));
  ctx.font = '600 ' + mainSize + 'px sans-serif';
  ctx.fillText('拼豆图纸', titleX, headerH * 0.4);

  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  const subSize = Math.max(11, Math.floor(headerH * 0.18));
  ctx.font = '400 ' + subSize + 'px sans-serif';
  const subText = brand
    ? brand + ' · ' + N + ' × ' + M
    : N + ' × ' + M;
  ctx.fillText(subText, titleX, headerH * 0.7);

  // 底部分隔线
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(cssW, headerH - 0.5);
  ctx.stroke();
}

/**
 * 画坐标轴背景 + 数字（四边）
 */
function drawCoordinates(ctx, layout, N, M, options) {
  const { axisLabelSize, gridOriginX, gridOriginY, gridW, gridH, cell, extraMargin, headerH } = layout;
  if (!axisLabelSize) return;
  const interval = (options && options.gridInterval) || 10;

  // 背景：四边浅灰
  ctx.fillStyle = '#F5F5F5';
  // 顶
  ctx.fillRect(gridOriginX, gridOriginY - axisLabelSize, gridW, axisLabelSize);
  // 底
  ctx.fillRect(gridOriginX, gridOriginY + gridH, gridW, axisLabelSize);
  // 左
  ctx.fillRect(gridOriginX - axisLabelSize, gridOriginY, axisLabelSize, gridH);
  // 右
  ctx.fillRect(gridOriginX + gridW, gridOriginY, axisLabelSize, gridH);

  ctx.fillStyle = '#333333';
  const fontSize = Math.max(11, Math.min(14, Math.floor(cell * 0.45)));
  ctx.font = fontSize + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < N; i++) {
    if ((i + 1) % interval === 0 || i === 0 || i === N - 1) {
      const numX = gridOriginX + i * cell + cell / 2;
      ctx.fillText(String(i + 1), numX, gridOriginY - axisLabelSize / 2);
      ctx.fillText(String(i + 1), numX, gridOriginY + gridH + axisLabelSize / 2);
    }
  }
  for (let j = 0; j < M; j++) {
    if ((j + 1) % interval === 0 || j === 0 || j === M - 1) {
      const numY = gridOriginY + j * cell + cell / 2;
      ctx.fillText(String(j + 1), gridOriginX - axisLabelSize / 2, numY);
      ctx.fillText(String(j + 1), gridOriginX + gridW + axisLabelSize / 2, numY);
    }
  }

  // 坐标边框
  ctx.strokeStyle = '#AAAAAA';
  ctx.lineWidth = 1;
  ctx.strokeRect(gridOriginX - 0.5, gridOriginY - 0.5, gridW + 1, gridH + 1);
}

/**
 * 画粗网格分隔线（每 gridInterval 格）
 */
function drawGridLines(ctx, layout, N, M, options) {
  const { gridOriginX, gridOriginY, gridW, gridH, cell } = layout;
  const interval = (options && options.gridInterval) || 10;
  const color = (options && options.gridLineColor) || '#000000';

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  for (let i = interval; i < N; i += interval) {
    const x = gridOriginX + i * cell;
    ctx.beginPath();
    ctx.moveTo(x, gridOriginY);
    ctx.lineTo(x, gridOriginY + gridH);
    ctx.stroke();
  }
  for (let j = interval; j < M; j += interval) {
    const y = gridOriginY + j * cell;
    ctx.beginPath();
    ctx.moveTo(gridOriginX, y);
    ctx.lineTo(gridOriginX + gridW, y);
    ctx.stroke();
  }

  // 整图主边框
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(gridOriginX + 0.5, gridOriginY + 0.5, gridW, gridH);
}

/**
 * 画底部统计区（多列色块 + 色号 + 数量）
 */
function drawStatsPanel(ctx, layout, items, options) {
  const { cssW, statsTop, statsH } = layout;
  if (!statsH || !items || items.length === 0) return;

  const padX = STATS_PADDING;
  const numColumns = Math.max(1, Math.min(4, Math.floor((cssW - padX * 2) / 220)));
  const swatchSize = 22;
  const rowH = Math.max(swatchSize + 8, 26);
  const titleH = 36;
  const footerH = 36;
  const topMargin = 16;
  const fontSize = 13;

  // 标题
  ctx.fillStyle = '#1F2937';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('色号统计', padX, statsTop + topMargin + 14);

  // 标题分隔线
  ctx.strokeStyle = '#DDDDDD';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, statsTop + topMargin + titleH - 4);
  ctx.lineTo(cssW - padX, statsTop + topMargin + titleH - 4);
  ctx.stroke();

  ctx.font = fontSize + 'px sans-serif';
  const itemWidth = Math.floor((cssW - padX * 2) / numColumns);

  let total = 0;
  items.forEach((it, idx) => {
    total += it.count;
    const rowIdx = Math.floor(idx / numColumns);
    const colIdx = idx % numColumns;
    const itemX = padX + colIdx * itemWidth;
    const rowY = statsTop + topMargin + titleH + rowIdx * rowH + rowH / 2;

    // 色块
    ctx.fillStyle = it.color;
    ctx.fillRect(itemX, rowY - swatchSize / 2, swatchSize, swatchSize);
    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth = 1;
    ctx.strokeRect(itemX + 0.5, rowY - swatchSize / 2 + 0.5, swatchSize - 1, swatchSize - 1);

    // 色号
    ctx.fillStyle = '#1F2937';
    ctx.textAlign = 'left';
    ctx.fillText(it.key, itemX + swatchSize + 6, rowY);

    // 数量
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5B3CD6';
    const countStr = '× ' + it.count;
    if (numColumns === 1) {
      ctx.fillText(countStr, cssW - padX, rowY);
    } else {
      ctx.fillText(countStr, itemX + itemWidth - 10, rowY);
    }
  });

  const numRows = Math.ceil(items.length / numColumns);
  const totalY = statsTop + topMargin + titleH + numRows * rowH + 14;
  ctx.fillStyle = '#1F2937';
  ctx.font = 'bold ' + fontSize + 'px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('总计：' + total + ' 颗 · ' + items.length + ' 种', cssW - padX, totalY);
  // 此处也消耗了一次 footerH 的空间
  void footerH;
}

/**
 * 主入口：把 mappedData 渲染到 ctx 上（按 options 决定细节）
 *
 * @param ctx
 * @param mappedData
 * @param N
 * @param M
 * @param layout 来自 computeExportLayout
 * @param options {
 *   showGrid?: boolean             // 粗网格线（默认 true）
 *   gridInterval?: number          // 粗网格间隔（默认 10）
 *   showCoordinates?: boolean      // 坐标轴（默认 true）
 *   showCellNumbers?: boolean      // cell 内显示色号文字（默认 true）
 *   gridLineColor?: string         // 粗网格颜色（默认 #000000）
 *   includeStats?: boolean         // 底部色号统计（默认 true）
 *   bgColor?: string               // 整图背景（默认 #ffffff）
 * }
 * @param info { brand, statsItems? } 若 includeStats，则 statsItems 必须传
 */
function renderExportToContext(ctx, mappedData, N, M, layout, options, info) {
  const o = options || {};
  const showGrid = o.showGrid !== false;
  const showCoords = o.showCoordinates !== false;
  const showCellNumbers = o.showCellNumbers !== false;

  // 1. 整图白底
  ctx.fillStyle = o.bgColor || '#ffffff';
  ctx.fillRect(0, 0, layout.cssW, layout.cssH);

  // 2. 顶部 header
  drawHeader(ctx, layout, { brand: info && info.brand, N, M });

  // 3. 坐标轴背景与数字
  if (showCoords) drawCoordinates(ctx, layout, N, M, o);

  // 4. 单元格
  const { cell, gridOriginX, gridOriginY } = layout;
  for (let j = 0; j < M; j++) {
    const row = mappedData[j];
    if (!row) continue;
    for (let i = 0; i < N; i++) {
      const c = row[i];
      if (!c) continue;
      drawCellOnContext(
        ctx, c,
        gridOriginX + i * cell,
        gridOriginY + j * cell,
        cell,
        {
          drawLabel: showCellNumbers,
          // 导出时用更清晰的对比色（Rec.709）
          labelColor: c.isExternal ? null : getContrastColor(c.color)
        }
      );
    }
  }

  // 5. 粗网格分隔
  if (showGrid) drawGridLines(ctx, layout, N, M, o);

  // 6. 底部统计
  if (o.includeStats && info && info.statsItems) {
    drawStatsPanel(ctx, layout, info.statsItems, o);
  }
}

module.exports = {
  computeExportLayout,
  renderExportToContext,
  buildStatsItems,
  DEFAULT_CELL,
  DEFAULT_HEADER
};
