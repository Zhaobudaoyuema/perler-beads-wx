const { calculatePixelGrid, PixelationMode } = require('../../utils/pixelation.js');
const { brandOptions, modeOptions, buildPalette, getFallbackColor } = require('../../utils/colorSystem.js');
const { mergeSimilarColors } = require('../../utils/colorMerge.js');
const { removeBoundaryBackground } = require('../../utils/backgroundRemove.js');

const app = getApp();

const MAX_SRC_PIXELS = 1200; // 原图最长边缩放上限，控制 getImageData 性能与内存
const PREVIEW_CELL_PX = 28;  // 预览/导出每格像素（CSS 等价 px，绘制时再乘 dpr）
const PREVIEW_HEADER_PX = 56; // 预览顶部留白（写元信息）
const PREVIEW_PADDING = 8;

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

    // 状态
    processing: false,

    // 预览 canvas 尺寸（CSS px）
    previewCssW: 100,
    previewCssH: 100,

    // 离屏 canvas 尺寸（CSS px）—— 给一个最小可见尺寸，type=2d 不能 hidden
    srcCssW: 1,
    srcCssH: 1,
    listCssW: 1,
    listCssH: 1
  },

  onReady() {
    // 提前拿到 canvas 节点（异步，不阻塞）
    this._getCanvasNode('previewCanvas').catch(() => {});
    this._getCanvasNode('srcCanvas').catch(() => {});
    this._getCanvasNode('listCanvas').catch(() => {});
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
        that.setData({
          tempFilePath: file.tempFilePath,
          hasResult: false,
          bgRemoved: false,
          stale: false,
          usageList: [],
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
      // 重新生成 → 清空排除集与去背景快照
      this._excludedHex = new Set();
      this._bgSnapshot = null;

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

  // ==================== 颜色排除与重映射 ====================

  onTapUsageChip(e) {
    if (this.data.processing) return;
    const key = e.currentTarget.dataset.key;
    const hex = e.currentTarget.dataset.hex;
    if (!key || !hex) return;
    const that = this;
    wx.showActionSheet({
      itemList: ['排除色号 ' + key + '（用其他色替代）'],
      success(res) {
        if (res.tapIndex === 0) {
          that._excludeColor(hex.toUpperCase());
        }
      }
    });
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

  onResetExclude() {
    if (!this._excludedHex || this._excludedHex.size === 0) return;
    if (this.data.processing) return;
    this._excludedHex.clear();
    wx.showToast({ title: '已恢复全部色号', icon: 'none' });
    // 触发一次完整重新生成
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
   * 把 mappedData 画到 previewCanvas（带网格 + 色号 + 标题）
   */
  async _renderPreview(mappedData, N, M, brand) {
    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const cell = PREVIEW_CELL_PX;
    const pad = PREVIEW_PADDING;
    const headerH = PREVIEW_HEADER_PX;
    const cssW = N * cell + pad * 2;
    const cssH = M * cell + pad * 2 + headerH;

    await new Promise(resolve => {
      this.setData({ previewCssW: cssW, previewCssH: cssH }, () => resolve());
    });

    delete (this._canvasCache || {}).previewCanvas;
    const res = await this._getCanvasNode('previewCanvas');
    const canvas = res.node;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    // 顶部标题
    ctx.fillStyle = '#1f1f23';
    ctx.font = '600 18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(brand + ' 色号 · ' + N + ' × ' + M, pad, headerH / 2);

    // 网格
    const startX = pad;
    const startY = headerH + pad;

    // 字号根据 cell 自适应
    const fontSize = Math.max(8, Math.floor(cell * 0.36));
    ctx.font = '500 ' + fontSize + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const c = mappedData[j][i];
        const x = startX + i * cell;
        const y = startY + j * cell;

        if (c && c.isExternal) {
          // 透明背景（白底 + 浅灰斜线）表示已去除
          ctx.fillStyle = '#fafafa';
          ctx.fillRect(x, y, cell, cell);
          ctx.strokeStyle = '#dcdce4';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x, y + cell);
          ctx.lineTo(x + cell, y);
          ctx.stroke();
          // 边框
          ctx.strokeStyle = 'rgba(0,0,0,0.08)';
          ctx.lineWidth = 0.6;
          ctx.strokeRect(x + 0.3, y + 0.3, cell - 0.6, cell - 0.6);
          continue;
        }

        ctx.fillStyle = c.color;
        ctx.fillRect(x, y, cell, cell);

        // 描边
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x + 0.3, y + 0.3, cell - 0.6, cell - 0.6);

        // 色号文字（根据底色明暗自动选黑/白）
        const textColor = this._pickTextColor(c.color);
        ctx.fillStyle = textColor;
        ctx.fillText(c.key, x + cell / 2, y + cell / 2);
      }
    }
  },

  _pickTextColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#000000';
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    // 亮度公式（Rec.601）
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 150 ? '#1f1f23' : '#ffffff';
  },

  // ==================== 导出图纸 ====================

  async onSavePoster() {
    if (!this.data.hasResult) return;
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const res = await this._getCanvasNode('previewCanvas');
      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: res.node,
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
