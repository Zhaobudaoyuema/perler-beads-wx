/**
 * 色板与品牌色号映射工具
 * 数据源：data/colorSystemMapping.json（291 种 hex → 5 大品牌色号映射）
 */

// 注意：小程序原生 require 不支持 .json 文件，故使用 .js 模块包装
const colorSystemMapping = require('../data/colorSystemMapping.js');
const { hexToRgb } = require('./pixelation.js');

const BRANDS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'];

const brandOptions = BRANDS.map(b => ({ key: b, name: b }));

const modeOptions = [
  { key: 'dominant', name: '卡通模式（主色）' },
  { key: 'average', name: '真实模式（平均色）' }
];

/**
 * 构建调色板：返回当前品牌下所有有有效色号的颜色
 * @param {string} brand 品牌名（MARD/COCO/漫漫/盼盼/咪小窝）
 * @returns {Array<{key:string, hex:string, rgb:{r:number,g:number,b:number}}>}
 */
function buildPalette(brand) {
  const palette = [];
  Object.keys(colorSystemMapping).forEach(hex => {
    const mapping = colorSystemMapping[hex];
    const code = mapping && mapping[brand];
    if (!code) return;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    palette.push({ key: code, hex: hex.toUpperCase(), rgb });
  });
  return palette;
}

/**
 * 默认备用色：调色板第一个颜色
 */
function getFallbackColor(palette) {
  if (palette && palette.length > 0) {
    return { key: palette[0].key, hex: palette[0].hex };
  }
  return { key: '?', hex: '#FFFFFF' };
}

module.exports = {
  BRANDS,
  brandOptions,
  modeOptions,
  buildPalette,
  getFallbackColor
};
