# 拼豆图纸生成器 · 微信小程序版

基于 [Zippland/perler-beads](https://github.com/Zippland/perler-beads) 移植的原生微信小程序 MVP。

## 功能（MVP）

- 上传图片（相册或拍照）
- 选择色号品牌（MARD / COCO / 漫漫 / 盼盼 / 咪小窝）
- 选择像素化模式（卡通模式 / 真实模式）
- 调整横向格数 N（20–80），纵向 M 自动按图片比例
- 生成带色号标注的图纸预览
- 一键保存图纸 PNG 到相册
- 一键保存采购清单 PNG 到相册

## 调试方式

1. 打开「微信开发者工具」
2. 「导入项目」选择本目录 `miniprogram/`
3. AppID 选「测试号」即可（也可改为自己的）
4. 启动调试，模拟器和真机预览均可

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss
  sitemap.json
  project.config.json / project.private.config.json
  pages/
    index/                  单页 MVP（上传 + 配置 + 预览 + 导出）
  utils/
    pixelation.js           像素化算法（移植自 Web 版）
    colorSystem.js          品牌 + 色板构建
  data/
    colorSystemMapping.js   291 种 hex → 5 大品牌色号映射（小程序 require 不支持 .json，故包装为 .js 模块）
```

## 算法说明

像素化算法与 Web 版完全一致：

- 颜色距离：Oklab 色彩空间
- 卡通模式：单元格内主导色（出现次数最多的像素 RGB）
- 真实模式：单元格内像素 RGB 的算术平均
- 调色板映射：在当前品牌可用色码集合中查找最接近的颜色

详细算法说明见仓库根目录 [README.md](../README.md)。

## 性能

- 原图最长边自动等比缩到 ≤ 1200px 后再读取像素，控制 `getImageData` 内存与耗时
- N 上限 80，M 按比例计算，最大约 6400 格，移动端单次像素化 < 1s

## 本期未实现（后续可选）

- 颜色排除/重映射、连通区域颜色合并、背景智能移除
- 手动逐格精修、放大镜
- 撤销/重做
