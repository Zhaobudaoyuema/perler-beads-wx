const { calculatePixelGrid, PixelationMode } = require('../../utils/pixelation.js');
const { brandOptions, modeOptions, buildPalette, getFallbackColor } = require('../../utils/colorSystem.js');
const { mergeSimilarColors } = require('../../utils/colorMerge.js');
const { removeBoundaryBackground } = require('../../utils/backgroundRemove.js');
const previewRender = require('../../utils/previewRender.js');
const exportRender = require('../../utils/exportRender.js');

const app = getApp();

const MAX_SRC_PIXELS = 1200; // 原图最长边缩放上限，控制 getImageData 性能与内存

// 预览/导出常量从 previewRender 抽出，本文件仅用于计算
const PREVIEW_PADDING = previewRender.PREVIEW_PADDING;
const PREVIEW_LABEL_MIN_CELL = previewRender.PREVIEW_LABEL_MIN_CELL;
const EXPORT_CELL_PX = previewRender.EXPORT_CELL_PX;
const EXPORT_HEADER_PX = previewRender.EXPORT_HEADER_PX;
const EXPORT_PADDING = previewRender.EXPORT_PADDING;

// tap 判定阈值
const TAP_MAX_MOVE_PX = 8;
const TAP_MAX_DURATION_MS = 500;

Page({
  data: {
    // 配置
    brandNames: brandOptions.map(b => b.name),
    brandIndex: 0,
    modeNames: modeOptions.map(m => m.name),
    modeIndex: 0,
    gridN: 50,
    mergeThreshold: 30,

    // 选图
    tempFilePath: '',
    imageInfo: null,

    // 计算结果（仅展示用的元信息）
    gridM: 0,
    totalBeads: 0,
    usedColorCount: 0,
    hasResult: false,
    bgRemoved: false,
    stale: false,
    usageList: [],
    previewScale: '1.0',
    eraseMode: false,
    canUndo: false,
    pickerVisible: false,
    pickerList: [],
    pickerCellInfo: '',
    pickerMode: 'cell', // 'cell' | 'batchReplace'
    excludedList: [],

    // 状态
    processing: false,

    // 预览 canvas 尺寸（CSS px）—— canvas 自然尺寸
    previewCssW: 100,
    previewCssH: 100,
    // 预览 movable-area（屏幕上的可视框）—— 一般与 canvas 一致，超出屏宽时小于 canvas
    previewAreaW: 100,
    previewAreaH: 100,
    // 预览副标题（从 canvas 里移出来的 brand · N×M）
    previewSubtitle: '',

    // 离屏 canvas 尺寸（CSS px）—— 给一个最小可见尺寸，type=2d 不能 hidden
    srcCssW: 1,
    srcCssH: 1,
    listCssW: 1,
    listCssH: 1,
    posterCssW: 1,
    posterCssH: 1,
    exportCssW: 1,
    exportCssH: 1,

    // 导出选项
    exportSheetVisible: false,
    exportOpts: {
      showGrid: true,
      showCoordinates: true,
      showCellNumbers: true,
      includeStats: true
    },
    gridIntervalOptions: [5, 10, 20],
    gridIntervalIndex: 1, // 默认 10
    gridColorOptions: [
      { label: '黑色', value: '#000000' },
      { label: '深灰', value: '#5b5b6e' },
      { label: '白色', value: '#ffffff' }
    ],
    gridColorLabels: ['黑色', '深灰', '白色'],
    gridColorIndex: 0,

    // 安全区（页面 padding 用，rpx 比较麻烦，直接用 px 注入）
    safeBottom: 0,
    headerNavH: 0
  },

  onLoad() {
    const g = (app && app.globalData) || {};
    this.setData({
      safeBottom: g.safeBottom || 0
    });
  },

  onReady() {
    // 提前拿到 canvas 节点（异步，不阻塞）
    this._getCanvasNode('previewCanvas').catch(() => {});
    this._getCanvasNode('srcCanvas').catch(() => {});
    this._getCanvasNode('listCanvas').catch(() => {});
    this._getCanvasNode('posterCanvas').catch(() => {});
  },

  // ==================== 配置项变更 ====================

  onBrandChange(e) {
    this.setData({ brandIndex: Number(e.detail.value) });
    this._markStale();
  },
  onModeChange(e) {
    this.setData({ modeIndex: Number(e.detail.value) });
    this._markStale();
  },
  onGridNChange(e) {
    this.setData({ gridN: Number(e.detail.value) });
    this._markStale();
  },
  onMergeThresholdChange(e) {
    this.setData({ mergeThreshold: Number(e.detail.value) });
    this._markStale();
  },

  _markStale() {
    if (this.data.hasResult && !this.data.stale) {
      this.setData({ stale: true });
    }
  },

  onPreviewScale(e) {
    const s = e && e.detail && e.detail.scale;
    if (typeof s !== 'number') return;
    const display = s.toFixed(1);
    if (display !== this.data.previewScale) {
      this.setData({ previewScale: display });
    }
  },

  // ==================== 选图 ====================

  onChooseImage() {
    const that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        that._mappedData = null;
        that._colorCountMap = null;
        that._cachedImageData = null;
        that._cachedImageDataPath = null;
        that._excludedHex = new Set();
        that._bgSnapshot = null;
        that._editHistory = [];
        that._selectedCell = null;
        that.setData({
          tempFilePath: file.tempFilePath,
          hasResult: false,
          bgRemoved: false,
          stale: false,
          usageList: [],
          excludedList: [],
          imageInfo: null
        });
        wx.getImageInfo({
          src: file.tempFilePath,
          success(info) {
            that.setData({ imageInfo: info });
          }
        });
      },
      fail(err) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选图失败', icon: 'none' });
        }
      }
    });
  },

  // ==================== 生成图纸 ====================

  async onGenerate() {
    if (!this.data.tempFilePath) {
      wx.showToast({ title: '请先选择图片', icon: 'none' });
      return;
    }
    if (this.data.processing) return;

    this.setData({ processing: true });
    wx.showLoading({ title: '生成中…', mask: true });

    try {
      // 重新生成 → 清空排除集 / 去背景快照 / 编辑历史
      this._excludedHex = new Set();
      this._bgSnapshot = null;
      this._editHistory = [];
      this._selectedCell = null;
      this.setData({ canUndo: false, eraseMode: false, pickerVisible: false, excludedList: [] });

      // 1. 拿原图 ImageData（带缓存：同一张图复用）
      const imageData = await this._ensureImageData();

      // 2. 根据图片比例算出 M
      const N = this.data.gridN;
      const aspect = imageData.height / imageData.width;
      const M = Math.max(1, Math.round(N * aspect));

      // 3. 构建调色板
      const brand = brandOptions[this.data.brandIndex].key;
      const palette = buildPalette(brand);
      if (palette.length === 0) {
        throw new Error('当前品牌无可用色板');
      }
      const fallback = getFallbackColor(palette);

      // 4. 像素化（让出主线程一帧，避免长任务卡 UI）
      await this._nextFrame();
      const mode = modeOptions[this.data.modeIndex].key === 'average'
        ? PixelationMode.Average
        : PixelationMode.Dominant;
      let mappedData = calculatePixelGrid(imageData, N, M, palette, mode, fallback);

      // 5. 杂色合并（阈值 > 0 才执行）
      const threshold = this.data.mergeThreshold;
      if (threshold > 0) {
        await this._nextFrame();
        const merged = mergeSimilarColors(mappedData, palette, threshold);
        mappedData = merged.data;
        if (merged.mergedCount > 0) {
          console.log('[Generate] merged', merged.mergedCount, 'similar colors');
        }
      }

      // 缓存当前生成上下文
      this._currentBrand = brand;
      this._currentPalette = palette;
      this._currentMode = mode;
      this._currentN = N;
      this._currentM = M;
      this._currentFallback = fallback;
      this._bgRemoved = false; // 新生成 → 重置去背景状态

      // 应用 mappedData：统计 + 渲染 + setData
      await this._applyMappedData(mappedData);
    } catch (err) {
      console.error('[Generate] error', err);
      wx.showToast({ title: (err && err.message) || '生成失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ processing: false });
    }
  },

  /**
   * 拿原图 ImageData。同一张图复用缓存，参数变更不重读。
   */
  async _ensureImageData() {
    const path = this.data.tempFilePath;
    if (this._cachedImageData && this._cachedImageDataPath === path) {
      return this._cachedImageData;
    }
    const imageData = await this._loadImageToSrcCanvas(path);
    this._cachedImageData = imageData;
    this._cachedImageDataPath = path;
    return imageData;
  },

  /**
   * 应用 mappedData：统计颜色用量 → 渲染预览 → 更新展示数据
   * 供 onGenerate / 去背景 / 排除重映射 / 手动编辑 等多处复用
   */
  async _applyMappedData(mappedData) {
    const N = this._currentN;
    const M = this._currentM;
    const brand = this._currentBrand;
    const palette = this._currentPalette || [];

    const colorMap = {};
    let total = 0;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const cell = mappedData[j][i];
        if (cell && cell.isExternal) continue;
        if (!cell || !cell.key) continue;
        colorMap[cell.key] = (colorMap[cell.key] || 0) + 1;
        total++;
      }
    }
    const usedColorCount = Object.keys(colorMap).length;

    // 构造 hex by key 表，并按用量降序生成色板用量条
    const hexByKey = {};
    palette.forEach(p => { hexByKey[p.key] = p.hex; });
    const usageList = Object.keys(colorMap).map(key => ({
      key,
      count: colorMap[key],
      color: hexByKey[key] || '#cccccc'
    })).sort((a, b) => b.count - a.count);

    await this._renderPreview(mappedData, N, M, brand);

    this._mappedData = mappedData;
    this._colorCountMap = colorMap;

    this.setData({
      gridM: M,
      totalBeads: total,
      usedColorCount,
      usageList,
      hasResult: true,
      stale: false
    });
  },

  // ==================== 手动逐格编辑 ====================

  onToggleEraseMode() {
    if (!this.data.hasResult) return;
    this.setData({ eraseMode: !this.data.eraseMode });
    if (this.data.eraseMode) {
      wx.showToast({ title: '擦除模式：点击格子置为透明', icon: 'none' });
    }
  },

  onUndo() {
    if (!this._editHistory || this._editHistory.length === 0) {
      wx.showToast({ title: '无可撤销', icon: 'none' });
      return;
    }
    const last = this._editHistory.pop();
    if (!last || !this._mappedData) return;

    if (last.type === 'batchReplace' && Array.isArray(last.edits)) {
      // 批量恢复
      last.edits.forEach(({ i, j, prev }) => {
        if (this._mappedData[j] && this._mappedData[j][i]) {
          this._mappedData[j][i] = prev;
          this._drawCell(i, j, prev, false);
        }
      });
      this._recomputeUsageAndCount();
      this.setData({ canUndo: this._editHistory.length > 0 });
      wx.showToast({ title: '已恢复 ' + last.edits.length + ' 格', icon: 'none' });
      return;
    }

    const { i, j, prev } = last;
    if (!this._mappedData[j] || !this._mappedData[j][i]) return;
    this._mappedData[j][i] = prev;
    this._drawCell(i, j, prev, false);
    this._recomputeUsageAndCount();
    this.setData({ canUndo: this._editHistory.length > 0 });
  },

  /**
   * 预览 canvas 触摸 —— 三段式手势识别，避免与 movable-view pinch 冲突
   *   touchstart: 记录起点
   *   touchmove:  位移超阈值 / 双指落下 → 取消 tap（让位 pinch / pan）
   *   touchend:   仅当一指 / 短时 / 无位移 → 视为 tap，触发选色或擦除
   */
  onPreviewTouchStart(e) {
    if (!this.data.hasResult || !this._mappedData) return;
    if (this.data.processing) return;
    if (this.data.pickerVisible) return;
    if (e.touches && e.touches.length > 1) {
      // 一开始就是双指，绝不是 tap
      this._previewTap = null;
      return;
    }
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this._previewTap = {
      x: touch.clientX,
      y: touch.clientY,
      t: Date.now(),
      cancelled: false
    };
  },

  onPreviewTouchMove(e) {
    const tap = this._previewTap;
    if (!tap) return;
    if (e.touches && e.touches.length > 1) {
      tap.cancelled = true;
      return;
    }
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - tap.x;
    const dy = touch.clientY - tap.y;
    if (dx * dx + dy * dy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) {
      tap.cancelled = true;
    }
  },

  async onPreviewTouchEnd(e) {
    const tap = this._previewTap;
    this._previewTap = null;
    if (!tap || tap.cancelled) return;
    if (Date.now() - tap.t > TAP_MAX_DURATION_MS) return;
    if (this.data.pickerVisible) return;
    if (!this.data.hasResult || !this._mappedData) return;

    try {
      const rect = await this._getCanvasBoundingRect('previewCanvas');
      if (!rect || !rect.width) return;
      const { startX, startY, cell, cssW, cssH, N, M } = this._previewDraw || {};
      if (!cell) return;
      // 屏幕坐标 → canvas CSS 坐标（rect 已包含 movable-view scale）
      const localX = (tap.x - rect.left) * cssW / rect.width;
      const localY = (tap.y - rect.top) * cssH / rect.height;
      const i = Math.floor((localX - startX) / cell);
      const j = Math.floor((localY - startY) / cell);
      if (i < 0 || i >= N || j < 0 || j >= M) return;

      const sel = this._selectedCell;
      if (sel && (sel.i !== i || sel.j !== j)) {
        this._drawCell(sel.i, sel.j, this._mappedData[sel.j][sel.i], false);
      }
      this._selectedCell = { i, j };
      this._drawCell(i, j, this._mappedData[j][i], true);

      if (this.data.eraseMode) {
        this._applyEdit(i, j, { key: 'ERASE', color: '#FFFFFF', isExternal: true });
      } else {
        this._showPickerForCell(i, j);
      }
    } catch (err) {
      console.error('[Tap] error', err);
    }
  },

  onPreviewTouchCancel() {
    this._previewTap = null;
  },

  _getCanvasBoundingRect(id) {
    return new Promise((resolve, reject) => {
      const q = wx.createSelectorQuery().in(this);
      q.select('#' + id).boundingClientRect();
      q.exec(res => {
        if (!res || !res[0]) return reject(new Error('rect not found'));
        resolve(res[0]);
      });
    });
  },

  _showPickerForCell(i, j) {
    const palette = this._currentPalette || [];
    if (palette.length === 0) return;
    this._pickerCell = { i, j };
    this.setData({
      pickerVisible: true,
      pickerList: palette,
      pickerCellInfo: 'i=' + i + ', j=' + j
    });
  },

  onClosePicker() {
    // 关闭选色面板，并清掉高亮
    const sel = this._selectedCell;
    if (sel && this._mappedData) {
      this._drawCell(sel.i, sel.j, this._mappedData[sel.j][sel.i], false);
    }
    this._selectedCell = null;
    this._pickerCell = null;
    this._batchReplaceCtx = null;
    this.setData({ pickerVisible: false, pickerMode: 'cell' });
  },

  onTapPickerColor(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const palette = this._currentPalette || [];
    const picked = palette[idx];
    if (!picked) return;

    if (this.data.pickerMode === 'batchReplace') {
      this._doBatchReplace(picked);
      this._batchReplaceCtx = null;
      this.setData({ pickerVisible: false, pickerMode: 'cell' });
      return;
    }

    if (!this._pickerCell) return;
    const { i, j } = this._pickerCell;
    this._applyEdit(i, j, {
      key: picked.key,
      color: picked.hex,
      isExternal: false
    });
    this.setData({ pickerVisible: false });
    this._pickerCell = null;
  },

  /**
   * 应用编辑：写入 mappedData，push history，单格重绘，更新统计
   */
  _applyEdit(i, j, newCell) {
    if (!this._mappedData || !this._mappedData[j] || !this._mappedData[j][i]) return;
    const prev = Object.assign({}, this._mappedData[j][i]);
    if (prev.key === newCell.key && !!prev.isExternal === !!newCell.isExternal) {
      return;
    }
    this._mappedData[j][i] = Object.assign({ isExternal: false }, newCell);
    this._editHistory = this._editHistory || [];
    this._editHistory.push({ i, j, prev });

    this._drawCell(i, j, this._mappedData[j][i], false);
    this._selectedCell = null;
    this._recomputeUsageAndCount();
    this.setData({ canUndo: this._editHistory.length > 0 });
  },

  /**
   * 编辑后增量更新 usageList / totalBeads / usedColorCount
   */
  _recomputeUsageAndCount() {
    if (!this._mappedData) return;
    const N = this._currentN;
    const M = this._currentM;
    const palette = this._currentPalette || [];
    const colorMap = {};
    let total = 0;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const c = this._mappedData[j][i];
        if (!c || c.isExternal || !c.key) continue;
        colorMap[c.key] = (colorMap[c.key] || 0) + 1;
        total++;
      }
    }
    this._colorCountMap = colorMap;

    const hexByKey = {};
    palette.forEach(p => { hexByKey[p.key] = p.hex; });
    const usageList = Object.keys(colorMap).map(key => ({
      key,
      count: colorMap[key],
      color: hexByKey[key] || '#cccccc'
    })).sort((a, b) => b.count - a.count);

    this.setData({
      totalBeads: total,
      usedColorCount: Object.keys(colorMap).length,
      usageList
    });
  },

  // ==================== 颜色排除与重映射 ====================

  onTapUsageChip(e) {
    if (this.data.processing) return;
    const key = e.currentTarget.dataset.key;
    const hex = e.currentTarget.dataset.hex;
    if (!key || !hex) return;
    const that = this;
    wx.showActionSheet({
      itemList: [
        '在图上高亮 ' + key,
        '替换为其他色号',
        '排除色号 ' + key + '（用其他色替代）'
      ],
      success(res) {
        if (res.tapIndex === 0) {
          that._highlightColorInGrid(key);
        } else if (res.tapIndex === 1) {
          that._openBatchReplace(key, hex);
        } else if (res.tapIndex === 2) {
          that._excludeColor(hex.toUpperCase());
        }
      }
    });
  },

  /**
   * 整色批量替换（B2.1）：打开 picker 选目标，遇到原 key 全替换
   */
  _openBatchReplace(srcKey, srcHex) {
    const palette = this._currentPalette || [];
    if (palette.length === 0) return;
    this._pickerCell = null;
    this._batchReplaceCtx = { srcKey: srcKey, srcHex: (srcHex || '').toUpperCase() };
    this.setData({
      pickerVisible: true,
      pickerMode: 'batchReplace',
      pickerList: palette,
      pickerCellInfo: '替换 ' + srcKey + ' → ?'
    });
  },

  _doBatchReplace(picked) {
    const ctx = this._batchReplaceCtx;
    if (!ctx || !this._mappedData) return;
    const { srcKey } = ctx;
    if (!picked || picked.key === srcKey) {
      wx.showToast({ title: '未变更', icon: 'none' });
      return;
    }
    const N = this._currentN, M = this._currentM;
    // 先把所有受影响的 (i,j) 收集为一条复合编辑（push history 占一格成本）
    const edits = [];
    for (let j = 0; j < M; j++) {
      const row = this._mappedData[j];
      if (!row) continue;
      for (let i = 0; i < N; i++) {
        const c = row[i];
        if (!c || c.isExternal) continue;
        if (c.key === srcKey) {
          edits.push({ i, j, prev: Object.assign({}, c) });
          row[i] = { key: picked.key, color: picked.hex, isExternal: false };
        }
      }
    }
    if (edits.length === 0) {
      wx.showToast({ title: '未找到 ' + srcKey, icon: 'none' });
      return;
    }
    this._editHistory = this._editHistory || [];
    this._editHistory.push({ type: 'batchReplace', edits });
    // 重绘所有变更的 cell
    edits.forEach(({ i, j }) => {
      this._drawCell(i, j, this._mappedData[j][i], false);
    });
    this._recomputeUsageAndCount();
    this.setData({ canUndo: true });
    wx.showToast({ title: '已替换 ' + edits.length + ' 格', icon: 'success' });
  },

  /**
   * 色号高亮闪烁（B2.2）：所有该 key 的 cell 加红框，1.5s 后恢复
   */
  _highlightColorInGrid(targetKey) {
    if (!this._mappedData) return;
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = null;
      // 立刻清掉上次的高亮
      this._clearHighlightForKey(this._highlightKey);
    }
    const N = this._currentN, M = this._currentM;
    let count = 0;
    for (let j = 0; j < M; j++) {
      const row = this._mappedData[j];
      if (!row) continue;
      for (let i = 0; i < N; i++) {
        const c = row[i];
        if (c && !c.isExternal && c.key === targetKey) {
          this._drawCell(i, j, c, true);
          count++;
        }
      }
    }
    if (count === 0) {
      wx.showToast({ title: '未找到 ' + targetKey, icon: 'none' });
      return;
    }
    this._highlightKey = targetKey;
    this._highlightTimer = setTimeout(() => {
      this._clearHighlightForKey(targetKey);
      this._highlightTimer = null;
      this._highlightKey = null;
    }, 1500);
  },

  _clearHighlightForKey(key) {
    if (!key || !this._mappedData) return;
    const N = this._currentN, M = this._currentM;
    for (let j = 0; j < M; j++) {
      const row = this._mappedData[j];
      if (!row) continue;
      for (let i = 0; i < N; i++) {
        const c = row[i];
        if (c && !c.isExternal && c.key === key) {
          this._drawCell(i, j, c, false);
        }
      }
    }
  },

  async _excludeColor(hexUpper) {
    if (!this._cachedImageData) {
      wx.showToast({ title: '请重新生成', icon: 'none' });
      return;
    }
    if (!this._currentBrand) return;

    this._excludedHex = this._excludedHex || new Set();
    this._excludedHex.add(hexUpper);

    this.setData({ processing: true });
    wx.showLoading({ title: '重映射…', mask: true });
    try {
      // 重新构建 palette（剔除已排除色）
      const fullPalette = buildPalette(this._currentBrand);
      const filtered = fullPalette.filter(p => !this._excludedHex.has(p.hex.toUpperCase()));
      if (filtered.length === 0) {
        throw new Error('剩余色板为空');
      }
      const fallback = getFallbackColor(filtered);

      await this._nextFrame();
      let mapped = calculatePixelGrid(
        this._cachedImageData,
        this._currentN,
        this._currentM,
        filtered,
        this._currentMode,
        fallback
      );

      // 重新合并
      const threshold = this.data.mergeThreshold;
      if (threshold > 0) {
        const merged = mergeSimilarColors(mapped, filtered, threshold);
        mapped = merged.data;
      }

      // 如果之前开了去背景，重新做一遍
      if (this.data.bgRemoved) {
        this._bgSnapshot = mapped.map(row => row.map(c => Object.assign({}, c)));
        const r = removeBoundaryBackground(mapped);
        if (r.removedCount > 0) {
          mapped = r.data;
        } else {
          this._bgSnapshot = null;
          this.setData({ bgRemoved: false });
        }
      }

      this._currentPalette = filtered;
      this._currentFallback = fallback;
      await this._applyMappedData(mapped);
      this._refreshExcludedList();
      wx.showToast({ title: '已排除 ' + hexUpper, icon: 'success' });
    } catch (err) {
      console.error('[Exclude] error', err);
      wx.showToast({ title: (err && err.message) || '重映射失败', icon: 'none' });
      this._excludedHex.delete(hexUpper);
    } finally {
      wx.hideLoading();
      this.setData({ processing: false });
    }
  },

  /**
   * 单色恢复（B2.3）：从 _excludedHex 删除一个色，重跑 generate
   */
  async onTapExcludedChip(e) {
    if (this.data.processing) return;
    const hex = e.currentTarget.dataset.hex;
    if (!hex || !this._excludedHex) return;
    const hexUpper = hex.toUpperCase();
    if (!this._excludedHex.has(hexUpper)) return;
    this._excludedHex.delete(hexUpper);
    this._refreshExcludedList();
    wx.showToast({ title: '已恢复 ' + hexUpper, icon: 'none' });
    await this._reapplyAfterExcludeChange();
  },

  async _reapplyAfterExcludeChange() {
    if (!this._cachedImageData || !this._currentBrand) {
      this.onGenerate();
      return;
    }
    this.setData({ processing: true });
    wx.showLoading({ title: '重映射…', mask: true });
    try {
      const fullPalette = buildPalette(this._currentBrand);
      const filtered = fullPalette.filter(p => !this._excludedHex.has(p.hex.toUpperCase()));
      if (filtered.length === 0) throw new Error('剩余色板为空');
      const fallback = getFallbackColor(filtered);

      await this._nextFrame();
      let mapped = calculatePixelGrid(
        this._cachedImageData,
        this._currentN,
        this._currentM,
        filtered,
        this._currentMode,
        fallback
      );
      const threshold = this.data.mergeThreshold;
      if (threshold > 0) {
        const merged = mergeSimilarColors(mapped, filtered, threshold);
        mapped = merged.data;
      }
      if (this.data.bgRemoved) {
        this._bgSnapshot = mapped.map(row => row.map(c => Object.assign({}, c)));
        const r = removeBoundaryBackground(mapped);
        if (r.removedCount > 0) {
          mapped = r.data;
        } else {
          this._bgSnapshot = null;
          this.setData({ bgRemoved: false });
        }
      }
      this._currentPalette = filtered;
      this._currentFallback = fallback;
      await this._applyMappedData(mapped);
      this._refreshExcludedList();
    } catch (err) {
      console.error('[ReapplyExclude] error', err);
      wx.showToast({ title: (err && err.message) || '重映射失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ processing: false });
    }
  },

  _refreshExcludedList() {
    const set = this._excludedHex || new Set();
    const fullPalette = this._currentBrand ? buildPalette(this._currentBrand) : [];
    const keyByHex = {};
    fullPalette.forEach(p => { keyByHex[p.hex.toUpperCase()] = p.key; });
    const list = [];
    set.forEach(hexUpper => {
      list.push({
        hex: hexUpper,
        key: keyByHex[hexUpper] || hexUpper
      });
    });
    list.sort((a, b) => a.key.localeCompare(b.key));
    this.setData({ excludedList: list });
  },

  onResetExclude() {
    if (!this._excludedHex || this._excludedHex.size === 0) {
      wx.showToast({ title: '无已排除色号', icon: 'none' });
      return;
    }
    if (this.data.processing) return;
    this._excludedHex.clear();
    this.setData({ excludedList: [] });
    wx.showToast({ title: '已恢复全部色号', icon: 'none' });
    this.onGenerate();
  },

  // ==================== 去背景 ====================

  async onToggleBgRemove() {
    if (!this.data.hasResult || !this._mappedData) return;
    if (this.data.processing) return;

    if (this.data.bgRemoved) {
      // 撤回：从快照恢复
      if (!this._bgSnapshot) {
        wx.showToast({ title: '无快照', icon: 'none' });
        return;
      }
      this.setData({ processing: true, bgRemoved: false });
      wx.showLoading({ title: '撤回中…', mask: true });
      try {
        await this._applyMappedData(this._bgSnapshot);
        this._bgSnapshot = null;
      } catch (err) {
        console.error('[BgUndo] error', err);
      } finally {
        wx.hideLoading();
        this.setData({ processing: false });
      }
      return;
    }

    // 执行去背景
    this.setData({ processing: true });
    wx.showLoading({ title: '去背景中…', mask: true });
    try {
      // 快照（深拷贝）
      this._bgSnapshot = this._mappedData.map(row => row.map(c => Object.assign({}, c)));
      await this._nextFrame();
      const { data, removedCount } = removeBoundaryBackground(this._mappedData);
      if (removedCount === 0) {
        wx.showToast({ title: '未识别到边缘背景色', icon: 'none' });
        this._bgSnapshot = null;
      } else {
        await this._applyMappedData(data);
        this.setData({ bgRemoved: true });
      }
    } catch (err) {
      console.error('[BgRemove] error', err);
      wx.showToast({ title: '去背景失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ processing: false });
    }
  },

  // ==================== Canvas 辅助 ====================

  _getCanvasNode(id) {
    if (this._canvasCache && this._canvasCache[id]) {
      return Promise.resolve(this._canvasCache[id]);
    }
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery().in(this);
      query.select('#' + id).fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('canvas node not found: ' + id));
          return;
        }
        this._canvasCache = this._canvasCache || {};
        this._canvasCache[id] = res[0];
        resolve(res[0]);
      });
    });
  },

  _nextFrame() {
    return new Promise(resolve => setTimeout(resolve, 16));
  },

  /**
   * 加载图片到 srcCanvas，返回 ImageData
   */
  async _loadImageToSrcCanvas(tempFilePath) {
    const info = this.data.imageInfo || await new Promise((resolve, reject) => {
      wx.getImageInfo({ src: tempFilePath, success: resolve, fail: reject });
    });

    // 等比缩到不超过 MAX_SRC_PIXELS
    const longEdge = Math.max(info.width, info.height);
    const scale = longEdge > MAX_SRC_PIXELS ? MAX_SRC_PIXELS / longEdge : 1;
    const drawW = Math.max(1, Math.round(info.width * scale));
    const drawH = Math.max(1, Math.round(info.height * scale));

    // 必须先把 CSS 尺寸设到 wxml（type=2d 的 canvas size 跟 css 尺寸联动），通过 setData 同步触发布局
    await new Promise(resolve => {
      this.setData({ srcCssW: drawW, srcCssH: drawH }, () => resolve());
    });

    // 关键：setData 触发的布局变更后，原本缓存的 canvas node 仍可用，但需要重新设置 width/height（像素级）
    // 重新查询 canvas（避免缓存的 size 过期）
    delete (this._canvasCache || {}).srcCanvas;
    const res = await this._getCanvasNode('srcCanvas');
    const canvas = res.node;
    canvas.width = drawW;
    canvas.height = drawH;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, drawW, drawH);

    // 加载图片
    const img = canvas.createImage();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = e => reject(e || new Error('图片加载失败'));
      img.src = tempFilePath;
    });
    ctx.drawImage(img, 0, 0, drawW, drawH);

    const imageData = ctx.getImageData(0, 0, drawW, drawH);
    return imageData;
  },

  /**
   * 计算预览 canvas 与 movable-area 的尺寸（委托给 previewRender.computePreviewLayout）
   */
  _computePreviewLayout(N, M) {
    const g = (app && app.globalData) || {};
    return previewRender.computePreviewLayout(N, M, {
      winW: g.windowWidth || 375,
      winH: g.windowHeight || 667
    });
  },

  /**
   * 把 mappedData 画到 previewCanvas（纯色块网格，无标题）
   * 标题信息以 wxml 文本形式显示在 canvas 上方
   */
  async _renderPreview(mappedData, N, M, brand) {
    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const { cell, cssW, cssH, areaW, areaH } = this._computePreviewLayout(N, M);
    const pad = PREVIEW_PADDING;

    await new Promise(resolve => {
      this.setData({
        previewCssW: cssW,
        previewCssH: cssH,
        previewAreaW: areaW,
        previewAreaH: areaH,
        previewSubtitle: brand + ' · ' + N + ' × ' + M
      }, () => resolve());
    });

    delete (this._canvasCache || {}).previewCanvas;
    const res = await this._getCanvasNode('previewCanvas');
    const canvas = res.node;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    const startX = pad;
    const startY = pad;
    const fontSize = Math.max(8, Math.floor(cell * 0.42));
    const drawLabel = cell >= PREVIEW_LABEL_MIN_CELL;

    this._previewDraw = {
      canvas, ctx,
      cell, pad,
      startX, startY,
      fontSize, drawLabel,
      cssW, cssH,
      N, M
    };

    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        this._drawCell(i, j, mappedData[j][i], false);
      }
    }
  },

  /**
   * 在已渲染的 previewCanvas 上单格重绘（委托给 previewRender.drawCellOnContext）
   */
  _drawCell(i, j, cellData, highlighted) {
    const ctx = this._previewDraw && this._previewDraw.ctx;
    if (!ctx) return;
    const { cell, startX, startY, drawLabel } = this._previewDraw;
    const c = cellData || (this._mappedData && this._mappedData[j] && this._mappedData[j][i]);
    if (!c) return;
    previewRender.drawCellOnContext(
      ctx, c,
      startX + i * cell,
      startY + j * cell,
      cell,
      { drawLabel, highlighted: !!highlighted }
    );
  },

  /**
   * 渲染高清导出图，按 options 决定是否带坐标/网格/统计
   *
   * @param mappedData
   * @param N
   * @param M
   * @param brand
   * @param options { showGrid, gridInterval, showCoordinates, showCellNumbers, gridLineColor, includeStats }
   */
  async _renderExportPoster(mappedData, N, M, brand, options) {
    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const opts = options || {};

    // 1. 计算布局（统计区按 items 数量预估）
    const palette = this._currentPalette || [];
    const statsItems = opts.includeStats
      ? exportRender.buildStatsItems(this._colorCountMap || {}, palette)
      : [];

    const layout = exportRender.computeExportLayout(N, M, {
      showCoordinates: opts.showCoordinates,
      includeStats: opts.includeStats,
      statsItemsCount: statsItems.length
    });

    const { cssW, cssH } = layout;

    // 2. 同步 css 尺寸到 wxml（type=2d 必须）
    await new Promise(resolve => {
      this.setData({ exportCssW: cssW, exportCssH: cssH }, () => resolve());
    });

    delete (this._canvasCache || {}).exportCanvas;
    const res = await this._getCanvasNode('exportCanvas');
    const canvas = res.node;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;

    // 3. 调用纯函数渲染
    exportRender.renderExportToContext(
      ctx, mappedData, N, M, layout, opts,
      { brand: brand || '', statsItems }
    );

    return canvas;
  },

  /**
   * 留作兼容：之前的 posterCanvas 简版渲染（28px/cell 只画色块和文字）
   * 当前未使用，但保留方法以便回退
   */
  // eslint-disable-next-line no-unused-vars
  async _renderSimplePoster(mappedData, N, M, brand) {
    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const cell = EXPORT_CELL_PX;
    const pad = EXPORT_PADDING;
    const headerH = EXPORT_HEADER_PX;
    const cssW = N * cell + pad * 2;
    const cssH = M * cell + pad * 2 + headerH;

    await new Promise(resolve => {
      this.setData({ posterCssW: cssW, posterCssH: cssH }, () => resolve());
    });

    delete (this._canvasCache || {}).posterCanvas;
    const res = await this._getCanvasNode('posterCanvas');
    const canvas = res.node;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.fillStyle = '#1f1f23';
    ctx.font = '600 20px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(brand + ' 色号 · ' + N + ' × ' + M, pad, headerH / 2);

    const startX = pad;
    const startY = headerH + pad;

    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const c = mappedData[j] && mappedData[j][i];
        if (!c) continue;
        previewRender.drawCellOnContext(
          ctx, c, startX + i * cell, startY + j * cell, cell,
          { drawLabel: true }
        );
      }
    }
    return canvas;
  },

  _pickTextColor(hex) {
    return previewRender.pickTextColor(hex);
  },

  // ==================== 导出图纸 ====================

  onOpenExportSheet() {
    if (!this.data.hasResult) {
      wx.showToast({ title: '请先生成图纸', icon: 'none' });
      return;
    }
    this.setData({ exportSheetVisible: true });
  },

  onCloseExportSheet() {
    this.setData({ exportSheetVisible: false });
  },

  onExportOptToggle(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (!key) return;
    this.setData({ ['exportOpts.' + key]: value });
  },

  onGridIntervalChange(e) {
    this.setData({ gridIntervalIndex: Number(e.detail.value) });
  },

  onGridColorChange(e) {
    this.setData({ gridColorIndex: Number(e.detail.value) });
  },

  async onConfirmExport() {
    if (!this.data.hasResult) return;
    if (!this._mappedData) return;

    const opts = this.data.exportOpts;
    const gridInterval = this.data.gridIntervalOptions[this.data.gridIntervalIndex];
    const gridLineColor = this.data.gridColorOptions[this.data.gridColorIndex].value;

    this.setData({ exportSheetVisible: false });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const canvas = await this._renderExportPoster(
        this._mappedData,
        this._currentN,
        this._currentM,
        this._currentBrand || '',
        Object.assign({}, opts, { gridInterval, gridLineColor })
      );
      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'png',
          success: r => resolve(r.tempFilePath),
          fail: reject
        });
      });
      await this._saveToAlbum(tempPath);
      wx.hideLoading();
      this._afterSaveSuccess(tempPath, '图纸');
    } catch (err) {
      wx.hideLoading();
      this._handleSaveError(err);
    }
  },

  /**
   * 兼容老入口（如分享、其他地方调用）：直接走默认选项
   */
  async onSavePoster() {
    this.onOpenExportSheet();
  },

  // ==================== 导出采购清单 ====================

  async onSaveList() {
    if (!this.data.hasResult) return;
    if (!this._colorCountMap) return;
    wx.showLoading({ title: '生成清单…', mask: true });
    try {
      const tempPath = await this._renderAndExportList();
      await this._saveToAlbum(tempPath);
      wx.hideLoading();
      this._afterSaveSuccess(tempPath, '采购清单');
    } catch (err) {
      wx.hideLoading();
      this._handleSaveError(err);
    }
  },

  _afterSaveSuccess(tempPath, label) {
    wx.showModal({
      title: '已保存到相册',
      content: label + '已保存，可立即预览或前往相册查看',
      confirmText: '立即预览',
      cancelText: '关闭',
      success(r) {
        if (r.confirm) {
          wx.previewImage({ urls: [tempPath], current: tempPath });
        }
      }
    });
  },

  async _renderAndExportList() {
    const colorMap = this._colorCountMap || {};
    const brand = this._currentBrand || '';
    const palette = this._currentPalette || [];

    // 排序：按用量降序
    const hexByKey = {};
    palette.forEach(p => { hexByKey[p.key] = p.hex; });
    const items = Object.keys(colorMap).map(key => ({
      key,
      count: colorMap[key],
      color: hexByKey[key] || '#cccccc'
    })).sort((a, b) => b.count - a.count);

    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const cssW = 360;
    const headerH = 88;
    const rowH = 56;
    const padX = 24;
    const cssH = headerH + items.length * rowH + 32;

    await new Promise(resolve => {
      this.setData({ listCssW: cssW, listCssH: cssH }, () => resolve());
    });

    delete (this._canvasCache || {}).listCanvas;
    const res = await this._getCanvasNode('listCanvas');
    const canvas = res.node;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    // 标题
    ctx.fillStyle = '#1f1f23';
    ctx.font = '600 20px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('采购清单', padX, 36);

    ctx.fillStyle = '#8a8a99';
    ctx.font = '400 13px sans-serif';
    const total = this.data.totalBeads || items.reduce((s, it) => s + it.count, 0);
    ctx.fillText(brand + ' · 共 ' + items.length + ' 种 · ' + total + ' 颗', padX, 60);

    // 分隔线
    ctx.strokeStyle = '#eeeef3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, headerH);
    ctx.lineTo(cssW - padX, headerH);
    ctx.stroke();

    // 列表
    ctx.font = '500 15px sans-serif';
    items.forEach((it, idx) => {
      const y = headerH + idx * rowH + rowH / 2;
      // 色块
      const swX = padX;
      const swY = y - 16;
      ctx.fillStyle = it.color;
      ctx.fillRect(swX, swY, 32, 32);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(swX + 0.5, swY + 0.5, 31, 31);

      // 色号
      ctx.fillStyle = '#1f1f23';
      ctx.textAlign = 'left';
      ctx.fillText(it.key, swX + 48, y);

      // 数量
      ctx.fillStyle = '#5b3cd6';
      ctx.textAlign = 'right';
      ctx.fillText('× ' + it.count, cssW - padX, y);
    });

    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: canvas,
        fileType: 'png',
        success: r => resolve(r.tempFilePath),
        fail: reject
      });
    });
  },

  // ==================== 相册保存与授权 ====================

  _saveToAlbum(tempFilePath) {
    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath: tempFilePath,
        success: resolve,
        fail: err => {
          if (err && err.errMsg && err.errMsg.indexOf('auth deny') !== -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '保存图片到相册需要您的授权，是否前往设置？',
              success(r) {
                if (r.confirm) {
                  wx.openSetting({
                    success(s) {
                      if (s.authSetting['scope.writePhotosAlbum']) {
                        wx.saveImageToPhotosAlbum({ filePath: tempFilePath, success: resolve, fail: reject });
                      } else {
                        reject(new Error('未授权'));
                      }
                    },
                    fail: reject
                  });
                } else {
                  reject(new Error('已取消'));
                }
              }
            });
          } else {
            reject(err);
          }
        }
      });
    });
  },

  _handleSaveError(err) {
    if (!err) return;
    const msg = err.message || (err.errMsg || '');
    if (msg.indexOf('cancel') !== -1 || msg.indexOf('已取消') !== -1) return;
    wx.showToast({ title: '保存失败', icon: 'none' });
    console.error('[Save] error', err);
  },

  // ==================== 分享 ====================

  onShareAppMessage() {
    return {
      title: '我用拼豆图纸生成器做了个图纸',
      path: '/pages/index/index'
    };
  },

  onShareTimeline() {
    return {
      title: '拼豆图纸生成器 — 任意图片一键生成拼豆底稿',
      query: ''
    };
  }
});
