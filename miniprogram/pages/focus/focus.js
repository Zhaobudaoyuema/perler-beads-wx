const previewRender = require('../../utils/previewRender.js');
const floodFill = require('../../utils/floodFill.js');

const app = getApp();

const TAP_MAX_MOVE_PX = 8;
const TAP_MAX_DURATION_MS = 500;

const FOCUS_CELL_MIN = 10;
const FOCUS_CELL_MAX = 36;
const FOCUS_PADDING = 4;

Page({
  data: {
    safeBottom: 0,

    // 数据
    N: 0,
    M: 0,
    brand: '',
    paletteList: [],     // [{ key, hex, total, done }]
    currentKey: '',
    currentHex: '#cccccc',
    currentTotal: 0,
    currentDoneCount: 0,

    // 进度
    completedCount: 0,
    totalCells: 0,
    progressPercent: 0,

    // 计时
    timerText: '00:00',
    paused: false,

    // 引导模式
    guideMode: 'nearest', // nearest | largest | edge

    // canvas 尺寸
    cssW: 100,
    cssH: 100,
    areaW: 100,
    areaH: 100,

    // 完成图离屏 canvas
    completionCssW: 1,
    completionCssH: 1,

    // 设置
    settingsVisible: false,
    gridIntervalOptions: [5, 10, 20],
    gridIntervalIndex: 1,
    gridColorOptions: [
      { label: '深灰', value: '#5b5b6e' },
      { label: '黑色', value: '#000000' },
      { label: '白色', value: '#ffffff' }
    ],
    gridColorLabels: ['深灰', '黑色', '白色'],
    gridColorIndex: 0,
    celebrateEnabled: true
  },

  onLoad() {
    const g = (app && app.globalData) || {};
    this.setData({ safeBottom: g.safeBottom || 0 });

    // 1. 读取会话
    const session = wx.getStorageSync('focus_session');
    if (!session || !session.mappedData) {
      wx.showToast({ title: '请从主页进入', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    this._mappedData = session.mappedData;
    this._N = session.N;
    this._M = session.M;
    this._brand = session.brand || '';
    this._palette = session.palette || [];
    this._imgKey = session.imgKey || 'default';

    // 2. 读取专注模式偏好（设置 + 进度）
    const prefs = wx.getStorageSync('focus_prefs') || {};
    if (typeof prefs.gridIntervalIndex === 'number') {
      this.setData({ gridIntervalIndex: prefs.gridIntervalIndex });
    }
    if (typeof prefs.gridColorIndex === 'number') {
      this.setData({ gridColorIndex: prefs.gridColorIndex });
    }
    if (typeof prefs.celebrateEnabled === 'boolean') {
      this.setData({ celebrateEnabled: prefs.celebrateEnabled });
    }

    // 3. 计算 paletteList（按色号在图中的总用量）
    this._buildPaletteUsage();

    // 4. 加载已完成进度
    this._completedSet = new Set();
    this._totalSec = 0;
    this._restoreProgress();

    // 5. 默认选用量最多的色为 currentKey
    const list = this.data.paletteList;
    if (list.length > 0 && !this.data.currentKey) {
      const first = list.find(p => p.done < p.total) || list[0];
      this._setCurrentKey(first.key);
    }

    // 6. 启动计时器
    this._startTimer();
  },

  onReady() {
    this._initCanvas().catch(err => {
      console.error('[Focus] init canvas failed', err);
    });
  },

  onUnload() {
    this._stopTimer();
    // 最后一次同步进度
    this._persistProgress();
  },

  onHide() {
    this._stopTimer();
    this._persistProgress();
  },

  onShow() {
    if (!this.data.paused && this._timerStarted) {
      this._startTimer();
    }
  },

  // ==================== 数据 / 进度 ====================

  _buildPaletteUsage() {
    const map = {};
    const hexByKey = {};
    (this._palette || []).forEach(p => { hexByKey[p.key] = p.hex; });
    let total = 0;
    for (let j = 0; j < this._M; j++) {
      const row = this._mappedData[j];
      if (!row) continue;
      for (let i = 0; i < this._N; i++) {
        const c = row[i];
        if (!c || c.isExternal) continue;
        if (!map[c.key]) {
          map[c.key] = { key: c.key, hex: c.color || hexByKey[c.key] || '#ccc', total: 0, done: 0 };
        }
        map[c.key].total += 1;
        total += 1;
      }
    }
    this._colorTotal = map;
    const list = Object.values(map).sort((a, b) => b.total - a.total);
    this.setData({
      paletteList: list,
      totalCells: total
    });
  },

  _restoreProgress() {
    try {
      const key = 'focus_progress_' + this._imgKey;
      const saved = wx.getStorageSync(key);
      if (saved) {
        this._completedSet = new Set(saved.completed || []);
        this._totalSec = saved.totalSec || 0;
        this._refreshAfterCompletedChange();
        this.setData({ timerText: this._formatTimer(this._totalSec) });
      } else {
        this._refreshAfterCompletedChange();
      }
    } catch (e) {
      console.error('[Focus] restore failed', e);
    }
  },

  _persistProgress() {
    try {
      const key = 'focus_progress_' + this._imgKey;
      wx.setStorageSync(key, {
        completed: Array.from(this._completedSet),
        totalSec: this._totalSec,
        ts: Date.now()
      });
    } catch (e) {
      console.error('[Focus] persist failed', e);
    }
  },

  onResetProgress() {
    const that = this;
    wx.showModal({
      title: '重置进度',
      content: '将清空本图纸的所有完成格子，确定？',
      confirmColor: '#ff5f6d',
      success(r) {
        if (!r.confirm) return;
        that._completedSet = new Set();
        that._totalSec = 0;
        that._persistProgress();
        that._refreshAfterCompletedChange();
        that.setData({ timerText: '00:00' });
        if (that._mappedData) that._renderFullCanvas();
        wx.showToast({ title: '已重置', icon: 'success' });
      }
    });
  },

  _refreshAfterCompletedChange() {
    const total = this.data.totalCells;
    const completed = this._completedSet.size;
    const percent = total === 0 ? 0 : Math.round(completed / total * 100);

    // 更新每个色号的 done 计数
    const colorTotal = this._colorTotal || {};
    Object.keys(colorTotal).forEach(k => { colorTotal[k].done = 0; });
    this._completedSet.forEach(rc => {
      const [r, c] = rc.split(',').map(Number);
      const cell = this._mappedData && this._mappedData[r] && this._mappedData[r][c];
      if (cell && !cell.isExternal && colorTotal[cell.key]) {
        colorTotal[cell.key].done += 1;
      }
    });
    const list = Object.values(colorTotal).sort((a, b) => b.total - a.total);

    let curDone = 0;
    let curTotal = 0;
    if (this.data.currentKey && colorTotal[this.data.currentKey]) {
      curDone = colorTotal[this.data.currentKey].done;
      curTotal = colorTotal[this.data.currentKey].total;
    }

    this.setData({
      completedCount: completed,
      progressPercent: percent,
      paletteList: list,
      currentDoneCount: curDone,
      currentTotal: curTotal
    });
  },

  // ==================== Canvas / 渲染 ====================

  async _initCanvas() {
    const layout = this._computeLayout();
    await new Promise(resolve => {
      this.setData({
        cssW: layout.cssW,
        cssH: layout.cssH,
        areaW: layout.areaW,
        areaH: layout.areaH
      }, () => resolve());
    });
    const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
    const node = await this._getCanvasNode('focusCanvas');
    const canvas = node.node;
    canvas.width = layout.cssW * dpr;
    canvas.height = layout.cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    this._ctx = ctx;
    this._layout = layout;
    this._renderFullCanvas();
  },

  _computeLayout() {
    const g = (app && app.globalData) || {};
    const winW = g.windowWidth || 375;
    const winH = g.windowHeight || 667;
    const horizPad = 32; // 32 px (page 16+16)
    const availW = Math.max(140, winW - horizPad);
    const availH = Math.max(260, Math.floor(winH * 0.50));
    let cell = Math.floor(availW / this._N);
    const cellByH = Math.floor((availH - FOCUS_PADDING * 2) / Math.max(1, this._M));
    if (cellByH > 0) cell = Math.min(cell, cellByH);
    cell = Math.max(FOCUS_CELL_MIN, Math.min(FOCUS_CELL_MAX, cell));
    const cssW = this._N * cell + FOCUS_PADDING * 2;
    const cssH = this._M * cell + FOCUS_PADDING * 2;
    const areaW = Math.min(cssW, availW);
    const areaH = Math.min(cssH, availH);
    return { cell, cssW, cssH, areaW, areaH, pad: FOCUS_PADDING };
  },

  _getCanvasNode(id) {
    if (this._canvasCache && this._canvasCache[id]) {
      return Promise.resolve(this._canvasCache[id]);
    }
    return new Promise((resolve, reject) => {
      const q = wx.createSelectorQuery().in(this);
      q.select('#' + id).fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('canvas not found: ' + id));
          return;
        }
        this._canvasCache = this._canvasCache || {};
        this._canvasCache[id] = res[0];
        resolve(res[0]);
      });
    });
  },

  _renderFullCanvas() {
    const ctx = this._ctx;
    const layout = this._layout;
    if (!ctx || !layout) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, layout.cssW, layout.cssH);

    const { cell, pad } = layout;
    const drawLabel = cell >= previewRender.PREVIEW_LABEL_MIN_CELL;
    for (let j = 0; j < this._M; j++) {
      const row = this._mappedData[j];
      if (!row) continue;
      for (let i = 0; i < this._N; i++) {
        const c = row[i];
        if (!c) continue;
        previewRender.drawCellOnContext(
          ctx, c, pad + i * cell, pad + j * cell, cell,
          {
            drawLabel,
            completed: this._completedSet.has(j + ',' + i)
          }
        );
      }
    }
    // 粗网格分隔线
    this._drawGridLines();
  },

  _drawGridLines() {
    const ctx = this._ctx;
    const layout = this._layout;
    if (!ctx || !layout) return;
    const interval = this.data.gridIntervalOptions[this.data.gridIntervalIndex];
    const color = this.data.gridColorOptions[this.data.gridColorIndex].value;
    const { cell, pad } = layout;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    for (let i = interval; i < this._N; i += interval) {
      const x = pad + i * cell;
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, pad + this._M * cell);
      ctx.stroke();
    }
    for (let j = interval; j < this._M; j += interval) {
      const y = pad + j * cell;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(pad + this._N * cell, y);
      ctx.stroke();
    }
  },

  _drawSingleCell(j, i) {
    const ctx = this._ctx;
    const layout = this._layout;
    if (!ctx || !layout) return;
    const cell = this._mappedData[j] && this._mappedData[j][i];
    if (!cell) return;
    const { cell: size, pad } = layout;
    const drawLabel = size >= previewRender.PREVIEW_LABEL_MIN_CELL;
    previewRender.drawCellOnContext(
      ctx, cell, pad + i * size, pad + j * size, size,
      {
        drawLabel,
        completed: this._completedSet.has(j + ',' + i)
      }
    );
    // 重画该 cell 上方落在的网格线（避免被覆盖）
    // 简化：满足度优先，重画整个 cell 后小范围网格线就靠相邻 cell 已有内容
  },

  // ==================== 触摸 ====================

  onCanvasTouchStart(e) {
    if (e.touches && e.touches.length > 1) {
      this._tap = null;
      return;
    }
    const t = e.touches && e.touches[0];
    if (!t) return;
    this._tap = { x: t.clientX, y: t.clientY, t: Date.now(), cancelled: false };
  },

  onCanvasTouchMove(e) {
    if (!this._tap) return;
    if (e.touches && e.touches.length > 1) {
      this._tap.cancelled = true;
      return;
    }
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - this._tap.x;
    const dy = t.clientY - this._tap.y;
    if (dx * dx + dy * dy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) this._tap.cancelled = true;
  },

  async onCanvasTouchEnd(e) {
    const tap = this._tap;
    this._tap = null;
    if (!tap || tap.cancelled) return;
    if (Date.now() - tap.t > TAP_MAX_DURATION_MS) return;
    if (this.data.settingsVisible) return;

    try {
      const rect = await this._getCanvasRect('focusCanvas');
      if (!rect || !rect.width) return;
      const layout = this._layout;
      if (!layout) return;
      const localX = (tap.x - rect.left) * layout.cssW / rect.width;
      const localY = (tap.y - rect.top) * layout.cssH / rect.height;
      const i = Math.floor((localX - layout.pad) / layout.cell);
      const j = Math.floor((localY - layout.pad) / layout.cell);
      if (i < 0 || i >= this._N || j < 0 || j >= this._M) return;
      this._toggleCell(j, i);
    } catch (err) {
      console.error('[Focus] tap', err);
    }
  },

  onCanvasTouchCancel() {
    this._tap = null;
  },

  _getCanvasRect(id) {
    return new Promise((resolve, reject) => {
      const q = wx.createSelectorQuery().in(this);
      q.select('#' + id).boundingClientRect();
      q.exec(res => {
        if (!res || !res[0]) return reject(new Error('rect not found'));
        resolve(res[0]);
      });
    });
  },

  _toggleCell(j, i) {
    const cell = this._mappedData && this._mappedData[j] && this._mappedData[j][i];
    if (!cell || cell.isExternal) return;
    const k = j + ',' + i;
    if (this._completedSet.has(k)) {
      this._completedSet.delete(k);
    } else {
      this._completedSet.add(k);
    }
    this._drawSingleCell(j, i);
    this._refreshAfterCompletedChange();
    this._persistProgress();
    // 完成全部
    if (this._completedSet.size > 0 && this._completedSet.size >= this.data.totalCells) {
      this._onAllCompleted();
    }
  },

  // ==================== 当前色 ====================

  _setCurrentKey(key) {
    if (!key) return;
    const item = (this._colorTotal || {})[key];
    if (!item) return;
    this.setData({
      currentKey: key,
      currentHex: item.hex,
      currentTotal: item.total,
      currentDoneCount: item.done
    });
  },

  onTapPaletteChip(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this._setCurrentKey(key);
  },

  // ==================== 引导推荐 ====================

  onSelectGuideMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode) return;
    this.setData({ guideMode: mode });
  },

  onJumpToNextRegion() {
    if (!this.data.currentKey) {
      wx.showToast({ title: '请先选当前色', icon: 'none' });
      return;
    }
    const key = this.data.currentKey;
    const targetHex = (this._colorTotal[key] || {}).hex;
    if (!targetHex) return;
    let regions = floodFill.getAllConnectedRegions(this._mappedData, targetHex);
    // 过滤掉已完成的区域
    regions = regions.filter(r => !floodFill.isRegionCompleted(r, this._completedSet));
    if (regions.length === 0) {
      wx.showToast({ title: '该色已全部完成', icon: 'success' });
      return;
    }
    if (this.data.guideMode === 'largest') {
      regions = floodFill.sortRegionsBySize(regions);
    } else if (this.data.guideMode === 'edge') {
      regions = floodFill.sortRegionsEdgeFirst(regions, this._M, this._N);
    } else {
      // nearest
      const lastDone = this._lastCompleted || { row: Math.floor(this._M / 2), col: Math.floor(this._N / 2) };
      regions = floodFill.sortRegionsByDistance(regions, lastDone);
    }
    const target = regions[0];
    const center = floodFill.getRegionCenter(target);
    wx.showToast({
      title: '推荐 (' + (center.row + 1) + ',' + (center.col + 1) + ')，' + target.length + ' 格',
      icon: 'none'
    });
    this._lastCompleted = center;
    // 高亮该区域 1.5s
    this._flashRegion(target);
  },

  _flashRegion(region) {
    if (!region || region.length === 0) return;
    const ctx = this._ctx;
    const layout = this._layout;
    if (!ctx || !layout) return;
    const { cell, pad } = layout;
    region.forEach(({ row, col }) => {
      const c = this._mappedData[row][col];
      previewRender.drawCellOnContext(
        ctx, c, pad + col * cell, pad + row * cell, cell,
        {
          drawLabel: cell >= previewRender.PREVIEW_LABEL_MIN_CELL,
          completed: this._completedSet.has(row + ',' + col),
          highlighted: true
        }
      );
    });
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      region.forEach(({ row, col }) => {
        this._drawSingleCell(row, col);
      });
      this._flashTimer = null;
    }, 1500);
  },

  // ==================== 计时器 ====================

  _startTimer() {
    if (this._timerInt) return;
    this._timerStarted = true;
    this.setData({ paused: false });
    this._timerInt = setInterval(() => {
      this._totalSec += 1;
      this.setData({ timerText: this._formatTimer(this._totalSec) });
    }, 1000);
  },

  _stopTimer() {
    if (this._timerInt) {
      clearInterval(this._timerInt);
      this._timerInt = null;
    }
  },

  onToggleTimer() {
    if (this.data.paused) {
      this._startTimer();
    } else {
      this._stopTimer();
      this.setData({ paused: true });
    }
  },

  onResetTimer() {
    this._totalSec = 0;
    this.setData({ timerText: '00:00' });
    this._persistProgress();
  },

  _formatTimer(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => n < 10 ? '0' + n : '' + n;
    return h > 0 ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  },

  // ==================== 设置弹层 ====================

  onOpenSettings() {
    this.setData({ settingsVisible: true });
  },

  onCloseSettings() {
    this.setData({ settingsVisible: false });
    this._persistPrefs();
  },

  onChangeGridInterval(e) {
    this.setData({ gridIntervalIndex: Number(e.detail.value) });
    this._renderFullCanvas();
  },

  onChangeGridColor(e) {
    this.setData({ gridColorIndex: Number(e.detail.value) });
    this._renderFullCanvas();
  },

  onToggleCelebrate(e) {
    this.setData({ celebrateEnabled: !!e.detail.value });
  },

  _persistPrefs() {
    try {
      wx.setStorageSync('focus_prefs', {
        gridIntervalIndex: this.data.gridIntervalIndex,
        gridColorIndex: this.data.gridColorIndex,
        celebrateEnabled: this.data.celebrateEnabled
      });
    } catch (e) {
      console.error('[Focus] persist prefs failed', e);
    }
  },

  // ==================== 全部完成 ====================

  _onAllCompleted() {
    this._stopTimer();
    if (!this.data.celebrateEnabled) {
      wx.showToast({ title: '🎉 已全部完成！', icon: 'success' });
      return;
    }
    const usedSec = this._totalSec;
    const that = this;
    wx.showModal({
      title: '🎉 全部完成！',
      content: '用时 ' + this._formatTimer(usedSec) + '，共 ' + this.data.totalCells + ' 颗\n\n是否生成完成打卡图保存到相册？',
      confirmText: '保存打卡图',
      cancelText: '关闭',
      success(r) {
        if (r.confirm) that._renderAndSaveCompletion(usedSec);
      }
    });
  },

  async _renderAndSaveCompletion(usedSec) {
    wx.showLoading({ title: '生成中…', mask: true });
    try {
      const dpr = (app.globalData && app.globalData.pixelRatio) || 2;
      const cssW = 480;
      const headerH = 96;
      const thumbCell = Math.max(2, Math.min(8, Math.floor(420 / Math.max(this._N, this._M))));
      const thumbW = thumbCell * this._N;
      const thumbH = thumbCell * this._M;
      const thumbStartX = (cssW - thumbW) / 2;
      const padX = 24;
      const list = (this.data.paletteList || []).slice(0, 16); // 最多 16 行
      const rowH = 28;
      const cssH = headerH + 16 + thumbH + 24 + 32 + list.length * rowH + 56;

      await new Promise(resolve => {
        this.setData({ completionCssW: cssW, completionCssH: cssH }, () => resolve());
      });

      delete (this._canvasCache || {}).completionCanvas;
      const node = await this._getCanvasNode('completionCanvas');
      const canvas = node.node;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // 背景
      const grad = ctx.createLinearGradient(0, 0, cssW, cssH);
      grad.addColorStop(0, '#7c5cff');
      grad.addColorStop(1, '#5b8cff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cssW, cssH);

      // 标题
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎉 拼豆完成打卡', cssW / 2, 40);
      ctx.font = '400 14px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(this._brand + ' · ' + this._N + ' × ' + this._M + ' · 用时 ' + this._formatTimer(usedSec), cssW / 2, 72);

      // 缩略图（白色卡片）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(thumbStartX - 8, headerH, thumbW + 16, thumbH + 16);
      for (let j = 0; j < this._M; j++) {
        for (let i = 0; i < this._N; i++) {
          const c = this._mappedData[j] && this._mappedData[j][i];
          if (!c || c.isExternal) {
            ctx.fillStyle = '#fafafa';
          } else {
            ctx.fillStyle = c.color;
          }
          ctx.fillRect(thumbStartX + i * thumbCell, headerH + 8 + j * thumbCell, thumbCell, thumbCell);
        }
      }

      // 色号统计
      let listY = headerH + thumbH + 40;
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 16px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('色号用量', padX, listY);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '400 12px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(this.data.totalCells + ' 颗 · ' + list.length + ' 种', cssW - padX, listY);

      listY += 18;
      ctx.font = '500 14px sans-serif';
      list.forEach((it) => {
        // 色块
        ctx.fillStyle = it.hex;
        ctx.fillRect(padX, listY - 12, 18, 18);
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(padX + 0.5, listY - 11.5, 17, 17);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(it.key, padX + 26, listY);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText('× ' + it.total, cssW - padX, listY);
        listY += rowH;
      });

      // 水印
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '400 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('via 拼豆图纸生成器', cssW / 2, cssH - 24);

      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas, fileType: 'png',
          success: r => resolve(r.tempFilePath),
          fail: reject
        });
      });
      await this._saveToAlbum(tempPath);
      wx.hideLoading();
      wx.showModal({
        title: '已保存到相册',
        content: '完成打卡图已保存',
        confirmText: '立即预览',
        cancelText: '关闭',
        success(r) {
          if (r.confirm) wx.previewImage({ urls: [tempPath], current: tempPath });
        }
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[Focus] save completion failed', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  _saveToAlbum(tempFilePath) {
    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath: tempFilePath,
        success: resolve,
        fail: err => {
          if (err && err.errMsg && err.errMsg.indexOf('auth deny') !== -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '保存打卡图需要您的授权，是否前往设置？',
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
  }
});
