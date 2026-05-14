# 拼豆图纸生成器 · 微信小程序版

基于 [Zippland/perler-beads](https://github.com/Zippland/perler-beads) 移植的原生微信小程序，已与 Web 版核心功能基本对齐（除 CSV 导入导出和放大镜外）。

## 功能

### 主页面（pages/index）
- 上传图片（相册或拍照）
- 5 大色号品牌（MARD / COCO / 漫漫 / 盼盼 / 咪小窝）+ 自定义勾选启用色号
- 像素化模式（卡通 / 真实）
- 横向格数 N（20–120，> 80 时给出性能提示），纵向 M 按比例
- 杂色合并阈值（0–50）
- 双指缩放预览，单击格子可改色号或擦除
- 一键去背景（边界洪水填充） / 撤回去背景
- 颜色排除：批量排除某色号，自动用其他色重映射
- 已排除色号可单独恢复（chip 列表点击）
- 用量条 chip 三选一：高亮闪烁定位 / 整色批量替换 / 排除该色
- 多步撤销：单格编辑 + 批量替换均可逐步还原
- 保存图纸 PNG（导出选项：坐标轴 / 粗网格 / 网格颜色 / cell 文字 / 色号统计表）
- 保存采购清单 PNG
- 会话偏好持久化（品牌 / 模式 / 格数 / 阈值 / 导出选项）

### 专注模式（pages/focus）
- 顶部：当前色卡片 + 计时器（暂停 / 继续 / 重置）+ 进度条 + 百分比
- 中部：FocusCanvas，已完成格画绿色对勾，支持双指缩放，点击切换完成态
- 引导推荐：「最近 / 最大 / 边缘」三种排序，「下一推荐」按钮跳转并红框闪烁 1.5s
- 底部色板：可滚动 chip 列表，点击切换当前色，已完成色变淡
- 设置弹层：分隔线间隔 / 颜色 / 庆祝弹窗开关 / 重置进度
- 全部完成时弹出庆祝弹窗，可选保存「完成打卡图」（缩略图 + 用时 + 色号统计）到相册
- 进度持久化（按图纸 hash），下次进入同图自动恢复完成格 + 累计用时

## 调试方式

1. 打开「微信开发者工具」
2. 「导入项目」选择本目录 `miniprogram/`
3. AppID 选「测试号」即可（也可改为自己的）
4. 启动调试，模拟器和真机预览均可

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss / sitemap.json
  project.config.json / project.private.config.json
  pages/
    index/                  主页（上传 + 配置 + 预览 + 编辑 + 导出）
    focus/                  专注模式页（按色拼豆 + 进度跟踪）
  utils/
    pixelation.js           像素化算法（移植自 Web 版）
    colorSystem.js          品牌 + 色板构建
    colorMerge.js           杂色合并（相似度 BFS）
    backgroundRemove.js     边界洪水填充去背景
    previewRender.js        预览/导出公用渲染（drawCellOnContext + 布局 + 文本对比色）
    exportRender.js         可选项导出渲染（坐标轴 + 粗网格 + 色号统计）
    floodFill.js            连通区域算法（专注模式推荐区域）
  data/
    colorSystemMapping.js   291 种 hex → 5 大品牌色号映射（包装为 .js 模块）
```

## 算法说明

像素化算法与 Web 版完全一致：

- 颜色距离：Oklab 色彩空间
- 卡通模式：单元格内主导色（出现次数最多的像素 RGB）
- 真实模式：单元格内像素 RGB 的算术平均
- 调色板映射：在当前品牌（含自定义勾选）可用色码集合中查找最接近的颜色

详细算法说明见仓库根目录 [README.md](../README.md)。

## 持久化

- `user_prefs`：会话级偏好（品牌 / 模式 / 格数 / 阈值 / 导出选项）
- `palette_selections_<brand>`：每个品牌独立的色号勾选状态
- `focus_session`：进入专注模式时缓存的图纸数据
- `focus_progress_<imgKey>`：按图纸 hash 存储的完成格 + 用时
- `focus_prefs`：专注模式设置（分隔线间隔 / 颜色 / 庆祝开关）

## 性能

- 原图最长边自动等比缩到 ≤ 1200px 后再读取像素，控制 `getImageData` 内存与耗时
- N 上限 120，> 80 时给出「处理可能稍慢」警告 hint；多数图纸单次像素化 < 1s
- 编辑 / 替换 / 高亮均通过单格增量重绘（_drawCell），避免整图重画
- 同一张图复用 ImageData 缓存，参数变更不重新读图

## 与 Web 版的差异

- 跳过 CSV 导入/导出（小程序文件 API 受限）
- 跳过放大镜局部精修（双指缩放已替代）
- 简化庆祝动画为 wx.showModal
- 简化打卡卡片为 canvas 一次性绘制（无动画）
