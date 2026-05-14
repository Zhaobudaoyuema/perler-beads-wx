/**
 * 像素化算法（移植自 Web 版 src/utils/pixelation.ts）
 * 全部为纯函数，依赖 Canvas ImageData 接口（小程序 type="2d" 已支持）
 */

const PixelationMode = {
  Dominant: 'dominant',
  Average: 'average'
};

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      }
    : null;
}

function srgbChannelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function rgbToOklab(rgb) {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return {
    l: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
  };
}

const oklabCache = new Map();

function getOklabColor(rgb) {
  const cacheKey = rgb.r + ',' + rgb.g + ',' + rgb.b;
  const cached = oklabCache.get(cacheKey);
  if (cached) return cached;
  const oklab = rgbToOklab(rgb);
  oklabCache.set(cacheKey, oklab);
  return oklab;
}

function colorDistance(rgb1, rgb2) {
  const o1 = getOklabColor(rgb1);
  const o2 = getOklabColor(rgb2);
  const dl = o1.l - o2.l;
  const da = o1.a - o2.a;
  const db = o1.b - o2.b;
  return Math.sqrt(dl * dl + da * da + db * db) * 100;
}

function findClosestPaletteColor(targetRgb, palette) {
  if (!palette || palette.length === 0) {
    return { key: 'ERR', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } };
  }
  let minDistance = Infinity;
  let closest = palette[0];
  for (let i = 0; i < palette.length; i++) {
    const d = colorDistance(targetRgb, palette[i].rgb);
    if (d < minDistance) {
      minDistance = d;
      closest = palette[i];
    }
    if (d === 0) break;
  }
  return closest;
}

/**
 * 计算指定区域的代表色
 */
function calculateCellRepresentativeColor(imageData, startX, startY, width, height, mode) {
  const data = imageData.data;
  const imgWidth = imageData.width;
  let rSum = 0, gSum = 0, bSum = 0;
  let pixelCount = 0;
  const colorCounts = {};
  let dominantRgb = null;
  let maxCount = 0;

  const endX = startX + width;
  const endY = startY + height;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * imgWidth + x) * 4;
      if (data[idx + 3] < 128) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      pixelCount++;
      if (mode === PixelationMode.Average) {
        rSum += r; gSum += g; bSum += b;
      } else {
        const k = r + ',' + g + ',' + b;
        colorCounts[k] = (colorCounts[k] || 0) + 1;
        if (colorCounts[k] > maxCount) {
          maxCount = colorCounts[k];
          dominantRgb = { r, g, b };
        }
      }
    }
  }

  if (pixelCount === 0) return null;

  if (mode === PixelationMode.Average) {
    return {
      r: Math.round(rSum / pixelCount),
      g: Math.round(gSum / pixelCount),
      b: Math.round(bSum / pixelCount)
    };
  }
  return dominantRgb;
}

/**
 * 计算像素化网格
 * @param {object} imageData 来自 ctx.getImageData() 的图像数据（包含 data/width/height）
 * @param {number} N 网格横向数量
 * @param {number} M 网格纵向数量
 * @param {Array} palette 调色板
 * @param {string} mode 像素化模式
 * @param {object} fallbackColor 备用色（{key, hex}），区域为空时使用
 * @returns {Array<Array<{key,color,isExternal?}>>}
 */
function calculatePixelGrid(imageData, N, M, palette, mode, fallbackColor) {
  const imgWidth = imageData.width;
  const imgHeight = imageData.height;
  const cellW = imgWidth / N;
  const cellH = imgHeight / M;

  const fallback = { key: fallbackColor.key, color: fallbackColor.hex, isExternal: true };
  const result = new Array(M);

  for (let j = 0; j < M; j++) {
    const row = new Array(N);
    for (let i = 0; i < N; i++) {
      const startX = Math.floor(i * cellW);
      const startY = Math.floor(j * cellH);
      const endX = Math.min(imgWidth, Math.ceil((i + 1) * cellW));
      const endY = Math.min(imgHeight, Math.ceil((j + 1) * cellH));
      const w = Math.max(1, endX - startX);
      const h = Math.max(1, endY - startY);

      const repRgb = calculateCellRepresentativeColor(imageData, startX, startY, w, h, mode);
      if (repRgb) {
        const closest = findClosestPaletteColor(repRgb, palette);
        row[i] = { key: closest.key, color: closest.hex };
      } else {
        row[i] = Object.assign({}, fallback);
      }
    }
    result[j] = row;
  }
  return result;
}

module.exports = {
  PixelationMode,
  hexToRgb,
  colorDistance,
  findClosestPaletteColor,
  calculatePixelGrid
};
