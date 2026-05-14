/**
 * 预览/导出公用渲染工具（纯函数 + ctx 参数）
 *
 * 核心目标：
 *  - 主页 index.js 使用 drawCellOnContext 做单格快速重绘（编辑/高亮）
 *  - 导出 exportRender.js 使用相同的填充/描边规则在大图上画格子
 *  - 专注页 focus.js 复用同一份 cell 绘制 + 完成态绘制（绿色对勾）
 *
 * 不依赖 wx.* / Page，纯依赖传入 ctx 即可。
 */

// 预览相关常量
const PREVIEW_CELL_MIN = 6;        // CSS px
const PREVIEW_CELL_MAX = 32;
const PREVIEW_LABEL_MIN_CELL = 14; // 小于该值不画 cell 内文字
const PREVIEW_PADDING = 4;
const PREVIEW_AREA_MAX_VH = 0.62;

// 导出（poster）相关常量
const EXPORT_CELL_PX = 28;
const EXPORT_HEADER_PX = 56;
const EXPORT_PADDING = 12;

/**
 * 文本对比色（背景亮 → 深色文字；背景暗 → 浅色文字）
 */
function pickTextColor(hex) {
  if (!hex || typeof hex !== 'string') return '#000000';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000000';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  // Luma Rec.601
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? '#1f1f23' : '#ffffff';
}

/**
 * 高对比度版本（专注页/导出图统计区可用）
 * Rec.709，更敏感
 */
function getContrastColor(hex) {
  if (!hex || typeof hex !== 'string') return '#000000';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000000';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.5 ? '#000000' : '#FFFFFF';
}

/**
 * 在 ctx 上画单格（不画粗分隔线，不画整图边框，仅 cell 自己的色 + 描边 + 文字）
 *
 * @param ctx CanvasRenderingContext2D
 * @param cell 单元格数据 { color, key, isExternal? }
 * @param x cell 左上角 x（CSS px）
 * @param y cell 左上角 y（CSS px）
 * @param size cell 边长（CSS px）
 * @param opt {
 *   highlighted?: boolean    // 红框选中
 *   completed?: boolean      // 专注页完成态：绿色对勾
 *   drawLabel?: boolean      // 是否画 key 文字
 *   labelText?: string       // 自定义文字（默认 cell.key）
 *   labelColor?: string      // 自定义文字颜色（默认按 contrast）
 *   borderColor?: string     // 自定义描边颜色（默认 rgba(0,0,0,.18)）
 *   externalFill?: string    // 外部空格填充色（默认 #fafafa）
 * }
 */
function drawCellOnContext(ctx, cell, x, y, size, opt) {
  if (!ctx || !cell) return;
  const o = opt || {};
  const borderW = size <= 10 ? 0.3 : 0.6;

  if (cell.isExternal) {
    // 外部背景：浅灰底 + 斜杠 + 浅描边
    ctx.fillStyle = o.externalFill || '#fafafa';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = '#dcdce4';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y + size);
    ctx.lineTo(x + size, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = borderW;
    ctx.strokeRect(x + 0.3, y + 0.3, size - 0.6, size - 0.6);
  } else {
    ctx.fillStyle = cell.color || '#ffffff';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = o.borderColor || 'rgba(0,0,0,0.18)';
    ctx.lineWidth = borderW;
    ctx.strokeRect(x + 0.3, y + 0.3, size - 0.6, size - 0.6);

    if (o.drawLabel && size >= PREVIEW_LABEL_MIN_CELL) {
      const label = o.labelText != null ? o.labelText : (cell.key || '');
      if (label) {
        const fontSize = Math.max(8, Math.floor(size * 0.42));
        ctx.font = '500 ' + fontSize + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = o.labelColor || pickTextColor(cell.color);
        ctx.fillText(label, x + size / 2, y + size / 2);
      }
    }
  }

  if (o.completed) {
    // 半透明绿底 + 绿色对勾
    ctx.fillStyle = 'rgba(36, 192, 110, 0.32)';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = '#1aaa55';
    const checkW = Math.max(1.2, size <= 12 ? 1.4 : 2);
    ctx.lineWidth = checkW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pad = size * 0.22;
    const xStart = x + pad;
    const yMid = y + size * 0.55;
    const xMid = x + size * 0.42;
    const yEnd = y + size - pad - 1;
    const xEnd = x + size - pad;
    const yTop = y + size * 0.32;
    ctx.beginPath();
    ctx.moveTo(xStart, yMid);
    ctx.lineTo(xMid, yEnd);
    ctx.lineTo(xEnd, yTop);
    ctx.stroke();
  }

  if (o.highlighted) {
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = Math.max(1.2, size <= 10 ? 1 : 2);
    ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
  }
}

/**
 * 把整张 mappedData 画到 ctx 的简版渲染（与原 _renderPreview 对齐）
 * 不画 header（标题已抽到 wxml 文本），仅白底 + 网格
 *
 * @returns layout 信息 { startX, startY, cell }
 */
function drawMappedDataToContext(ctx, mappedData, N, M, layout, opts) {
  const { cell, cssW, cssH } = layout;
  const pad = layout.pad != null ? layout.pad : PREVIEW_PADDING;
  const drawLabel = cell >= PREVIEW_LABEL_MIN_CELL;

  ctx.fillStyle = (opts && opts.bgColor) || '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const startX = pad;
  const startY = pad;

  for (let j = 0; j < M; j++) {
    const row = mappedData[j];
    if (!row) continue;
    for (let i = 0; i < N; i++) {
      const c = row[i];
      if (!c) continue;
      drawCellOnContext(ctx, c, startX + i * cell, startY + j * cell, cell, {
        drawLabel
      });
    }
  }
  return { startX, startY, cell };
}

/**
 * 计算预览 canvas 与 movable-area 尺寸（与 _computePreviewLayout 等价）
 *
 * @param N 横向格数
 * @param M 纵向格数
 * @param viewport { winW, winH } 视口宽高（CSS px）
 */
function computePreviewLayout(N, M, viewport) {
  const winW = (viewport && viewport.winW) || 375;
  const winH = (viewport && viewport.winH) || 667;
  const horizPad = winW * 80 / 750;
  const availW = Math.max(120, winW - horizPad);
  const availH = Math.max(220, Math.floor(winH * PREVIEW_AREA_MAX_VH));

  let cell = Math.floor(availW / N);
  const cellByH = Math.floor((availH - PREVIEW_PADDING * 2) / Math.max(1, M));
  if (cellByH > 0) cell = Math.min(cell, cellByH);
  cell = Math.max(PREVIEW_CELL_MIN, Math.min(PREVIEW_CELL_MAX, cell));

  const cssW = N * cell + PREVIEW_PADDING * 2;
  const cssH = M * cell + PREVIEW_PADDING * 2;
  const areaW = Math.min(cssW, availW);
  const areaH = Math.min(cssH, availH);
  return {
    cell, cssW, cssH, areaW, areaH,
    pad: PREVIEW_PADDING
  };
}

module.exports = {
  // 常量
  PREVIEW_CELL_MIN,
  PREVIEW_CELL_MAX,
  PREVIEW_LABEL_MIN_CELL,
  PREVIEW_PADDING,
  PREVIEW_AREA_MAX_VH,
  EXPORT_CELL_PX,
  EXPORT_HEADER_PX,
  EXPORT_PADDING,

  // 工具函数
  pickTextColor,
  getContrastColor,
  drawCellOnContext,
  drawMappedDataToContext,
  computePreviewLayout
};
