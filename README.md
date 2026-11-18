# AchiPaint

一个轻核心、边缘插件的绘画工具。跑在浏览器里，纯原生 ES module + Canvas 2D，没有框架、没有构建步骤。

笔刷不自己写，直接接 [hokusai](https://github.com/reearth/hokusai)（libmypaint 的 Rust 移植）编译成的 wasm，
所以 `.myb` 笔刷文件的压感、倾斜、速率响应都是 libmypaint 原本的数学。

界面走 Blender 那一路：控件整条可拖、数值压在条上、色轮 + RGB/HSV 通道条。

---

## ⚠️ 关于 AI 生成

**这个项目的代码绝大部分由 AI 生成。** 需求、验收、取舍和每一次「这个不对」由人类负责；
写代码、调试、跑测试的是 [DeepSeek Harness](https://github.com/deepseek-ai) 里的 agent。

这意味着：

- 结构是经过设计和讨论的（`ARCHITECTURE.md` 记了边界，`DEVNOTES.md` 记了每一轮踩的坑），但覆盖不到的地方一定还有
- 别不开验证就拿去干要紧的活
- 发现问题欢迎开 issue，这比什么都有用

---

## 现状

**能画，但不能保存。** 刷新页面作品就没了 —— 这是目前最大的缺口。

| 已经能用 | 说明 |
| --- | --- |
| 笔刷 | hokusai 引擎，4 个 `.myb` 预设，压感/倾斜/速率 |
| 橡皮 / 吸色 | 内置引擎 / 读合成像素 |
| 图层树 | 分组、嵌套、拖拽、可见性、不透明度、16 种混合模式、删除 |
| 图层蒙版 | 透明度蒙版，合成时隔离 + `destination-in` |
| 取色器 | 色轮 + 明度条 + RGB/HSV 切换 + 通道条 |
| 主色 / 副色 | 两个槽，`X` 交换 |
| 框选 | 矩形，限制笔画落在框内 |
| 移动 | 拖动实时预览，松手落定，可撤销 |
| 抓手 / 缩放 | 平移、点击放大、`Alt` 点击缩小 |
| 撤销 | 脏矩形像素快照，384MB 封顶 |

### 还没做

保存/打开工程文件、画布旋转与翻转、笔刷光标轮廓、自由变换、套索与魔棒、压感曲线编辑、
图层合并与剪贴蒙版、调整图层、笔刷预设管理、参考图面板、自动保存、PSD 导入导出、滤镜、文字工具。

图层结构的变更（新建/删除/移动）也还不在撤销栈里 —— 撤销目前只管像素。

---

## 跑起来

```sh
python3 serve.py
# 打开 http://127.0.0.1:8899/src/index.html
```

不能直接双击 `index.html`：项目用原生 ES module 加载，还用 `fetch` 取 `.myb` 笔刷和 wasm，
`file://` 协议下会被浏览器拦掉。

### 快捷键

| 键 | 作用 |
| --- | --- |
| `B` `E` `I` | 画笔 / 橡皮 / 吸色 |
| `V` `M` `H` `Z` | 移动 / 框选 / 抓手 / 缩放 |
| `X` | 交换主色副色 |
| `Esc` | 取消框选、退出蒙版编辑 |
| `⌘Z` / `⇧⌘Z` | 撤销 / 重做 |

---

## 目录

```
src/
  core/            核心，不可插件化
    canvas.js        分块画布、图层树、组隔离合成、蒙版
    brush.js         内置笔刷引擎（现在只管橡皮）
    hokusai-engine.js  hokusai 适配层
    history.js       撤销：脏矩形像素快照
    color.js  bus.js
  ui/              界面层
    theme.css        唯一一套 design token
    widgets.js       Blender 式滑块
    colorpicker.js   色轮 / 明度 / RGB-HSV
  wasm/            hokusai 的 wasm 绑定（生成产物，别手改）
  brushes/         .myb 笔刷预设
  plugins/         边缘插件（目前只有 PNG 导出）
  main.js  index.html
```

设计边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，
踩过的坑和调试方法见 [DEVNOTES.md](DEVNOTES.md)。

---

## 第三方与许可

本项目自身代码以 **MIT** 许可发布，见 [LICENSE](LICENSE)。

包含 **hokusai**（Copyright © 2026 Re:Earth and contributors，MIT / Apache-2.0 双许可，
本项目按 MIT 使用）编译出的 wasm 产物，并**修改了它的源码**。
修改内容、基线 commit 与重建步骤见 [NOTICE](NOTICE) 和 [third-party/hokusai/](third-party/hokusai/)，
改动补丁在 [patches/](patches/)。
