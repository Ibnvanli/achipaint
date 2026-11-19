# AchiPaint

> **v0.1.0-alpha.1** · MIT License

一个轻量绘画工具。核心是画布、笔刷、图层与颜色，其余能力以插件形式接入。

成熟度：**alpha**。功能可用，稳定性仍在迭代，暂不建议用于正式工作。

---

## 技术构成

- **运行时** — 原生 ES module + Canvas 2D，无框架、无构建步骤、零运行时依赖
- **笔刷引擎** — [hokusai](https://github.com/reearth/hokusai)（libmypaint 的 Rust 移植），编译为 WebAssembly。压感、倾斜与速率响应均来自 libmypaint 原始实现
- **应用外壳** — Electron（Chromium）；Swift launcher 负责进程启动
- **文件格式** — 自研 `.achi` 容器，含 CRC32 校验

界面设计参考 Blender：控件可拖拽、数值内嵌于条形控件、色轮配合 RGB/HSV 通道条。

## 功能

| 模块 | 状态 |
| --- | --- |
| 笔刷 | hokusai 引擎，4 个 `.myb` 预设，压感 / 倾斜 / 速率，大小 / 不透明度 / 流量 / 硬度 / 间距 / 稳定 |
| 图层 | 新建、分组、嵌套、重排、显隐、不透明度、16 种混合模式、蒙版 |
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

```
偏移    内容
0       "ACHI"          magic          4B
4       formatVersion   u16            2B
6       flags           u16            2B（必须为 0）
8       headerLen       u32            4B
12      header          UTF-8 JSON     变长
        ……数据块：nameLen u16 / name / dataLen u32 / data(PNG)
末尾    crc32           u32            4B，覆盖此前全部内容
```

三层校验，任一层失败即整体拒绝：结构（magic、版本、偏移边界）、CRC32、语义
（JSON 可解析、图层树可重建、每块均被引用）。读取时先完整解析到新文档，
**全部成功后才替换**当前文档。

保存流程先写 `.tmp` 再原子 `rename`，中断不会留下半个文件覆盖原件。

已覆盖的损坏情形：截断、单字节翻转、magic 篡改、版本高于当前程序。

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
优化方向为笔刷计算迁移至 Web Worker、合成迁移至 WebGL2。

## 关于 AI 生成

本项目代码主要由 AI 生成。需求、验收与取舍由人类负责；编码、调试与测试由
[DeepSeek Harness](https://github.com/deepseek-ai) 中的 agent 完成。

设计边界记录于 `ARCHITECTURE.md`，每轮实现的问题与决策记录于 `DEVNOTES.md`。
未经验证的场景请勿用于关键工作。

## 协议

MIT，见 [LICENSE](LICENSE)。

笔刷引擎来自 [hokusai](https://github.com/reearth/hokusai)（MIT / Apache-2.0），
第三方组件声明见 [NOTICE](NOTICE)。

## 参与

alpha 阶段，接口与文件格式可能变动。问题反馈与建议请开
[Issue](https://github.com/Ibnvanli/achipaint/issues)，性能相关反馈尤其欢迎。
