# AchiPaint

> **v0.1.0-alpha.1** · MIT License

一个轻量绘画工具。核心包含画布、笔刷、图层与颜色，其余能力以插件形式接入。

成熟度：**alpha**。功能可用，稳定性仍在迭代，暂不建议用于正式工作。

---

## 技术构成

- **运行时** — 原生 ES Module + Canvas 2D，无框架、无构建步骤、无 `node_modules` 依赖
- **笔刷引擎** — [hokusai](https://github.com/reearth/hokusai)（libmypaint 的 Rust 移植），编译为 WebAssembly。压感、倾斜与速率响应均来自 libmypaint 原始实现
- **应用外壳** — Electron（Chromium）；由 Swift launcher 负责进程启动
- **文件格式** — 自研 `.achi` 容器（v2，按瓦片存储），含 CRC32 校验

第三方库以自包含单文件 ESM 随仓库分发（`src/vendor/`，共 105KB），不引入包管理器：

| 库 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| fflate | 0.8.3 | MIT | 压缩（暂未接入） |
| comlink | 4.4.2 | Apache-2.0 | Worker 通信，为笔刷 Worker 化预备 |
| perfect-freehand | 1.2.3 | MIT | 手绘线条平滑（暂未接入） |

界面设计参考 Blender：控件整条可拖拽、数值内嵌于条形控件、色轮配合 RGB / HSV 通道条。

## 功能

| 模块 | 状态 |
| --- | --- |
| 笔刷 | hokusai 引擎，4 个 `.myb` 预设，压感 / 倾斜 / 速率，大小 / 不透明度 / 流量 / 硬度 / 间距 / 稳定 |
| 图层 | 新建、分组、嵌套、重排、显示 / 隐藏、不透明度、16 种混合模式、蒙版 |
| 选区 | 矩形框选；选中内容可提取、移动、旋转后合并回图层 |
| 工具 | 画笔、橡皮、吸管、移动、框选、抓手、缩放 |
| 文件 | `.achi` 保存与打开、图片导入、PNG 导出、拖拽打开、最近文件 |
| 撤销 | 脏矩形像素快照，上限 384MB |
| 界面 | 启动浮层、导航器、参考图窗、开发者控制台 |

**尚未实现**：套索与魔棒、自由变换（缩放 / 斜切）、文字工具、滤镜、对称辅助、
自动保存、笔画对象（单独选中某一笔）。图层结构变更（新建 / 删除 / 移动）尚未纳入撤销栈。

完整清单见 [ROADMAP.md](ROADMAP.md)。

## 文件格式

`.achi` 是自定义容器，设计约束为：**损坏的文件不得影响当前文档，也不得静默加载部分内容。**

当前版本为 **v2**：画布按 256×256 瓦片存储，**仅写入存在笔迹的瓦片**，空瓦片不占用空间。
v1（整层存一张大图）结构不兼容，打开时直接抛出 `LEGACY_FORMAT` 并说明原因，
而非呈现无法理解的解析错误。

```
偏移    内容
0       "ACHI"          magic          4B
4       formatVersion   u16            2B（当前 2）
6       flags           u16            2B（必须为 0）
8       headerLen       u32            4B
12      header          UTF-8 JSON     变长
        ……数据块（每块 = 一块瓦片）：nameLen u16 / name / dataLen u32 / data(256×256 PNG)
末尾    crc32           u32            4B，覆盖此前全部内容
```

header 中每个图层记录自身的 `tiles: [{c, r, data}]`，即该层有内容的块坐标与块名。
读取时反向重建瓦片表，边缘块按文档有效区域裁剪。

三层校验，任一层失败即整体拒绝：结构（magic、版本、偏移边界）、CRC32、语义
（JSON 可解析、图层树可重建、每块均被引用、瓦片坐标不重复）。读取时先完整解析到新文档，
**全部成功后才替换**当前文档。

保存流程先写入 `.tmp` 再原子 `rename`，中断不会残留不完整文件覆盖原文件。

已覆盖的损坏情形：截断、单字节翻转、magic 篡改、版本高于当前程序、v1 旧格式。

体积参考（2480×3508 单层）：稀疏内容约 0.04 MB，满铺约 2.65 MB。
代价是序列化耗时增加（140 块全满时 168ms），以换取稀疏场景 5.5 倍的体积下降。

## 运行

### 网页版

```bash
python3 serve.py 8899
# 打开 http://127.0.0.1:8899/src/index.html
```

### 桌面版

```bash
bash native/build-electron.sh
# 产物安装到 ~/Applications/AchiPaint.app
```

## 性能

[PERFORMANCE.md](PERFORMANCE.md) 记录了实测数据、瓶颈定位与分阶段优化路线。

当前瓶颈为笔刷计算全部在主线程同步执行：300px 笔刷单笔约 92ms。
优化方向为将笔刷计算迁移至 Web Worker，并将合成迁移至 WebGL2。

## 关于 AI 生成

本项目代码主要由 AI 生成。需求、验收与取舍由人类负责；编码、调试与测试由
[DeepSeek Harness](https://github.com/deepseek-ai) 中的 agent 完成。

设计边界记录于 [`ARCHITECTURE.md`](ARCHITECTURE.md)，每轮实现的问题与决策记录于
[`DEVNOTES.md`](DEVNOTES.md)。未经验证的场景请勿用于关键工作。

## 审查记录

[`audit/`](audit/) 存放代码审计与架构评估报告，每条结论都带代码位置和实测依据。
最新一份：[2026-11-20](audit/2026-11-20-audit.md)。

## 协议

MIT，见 [LICENSE](LICENSE)。

笔刷引擎来自 [hokusai](https://github.com/reearth/hokusai)（MIT / Apache-2.0），
第三方组件声明见 [NOTICE](NOTICE)。

## 参与

alpha 阶段，接口与文件格式可能变动。问题与建议请提交
[Issue](https://github.com/Ibnvanli/achipaint/issues)，性能相关反馈尤其欢迎。
