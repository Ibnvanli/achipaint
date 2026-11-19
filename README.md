# AchiPaint

> **v0.1.0-alpha.1** · Alpha · MIT License
>
> 能用，但别拿它干正事。缺的东西不少（见 [ROADMAP.md](ROADMAP.md)），
> 而且随机崩、随机丢功能这种事还时有发生。**画完记得 ⌘S**。


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

## 新建画布

启动浮层两屏：先选预设（或「自定义尺寸…」），再进详细设置。

详细面板里只放**真正生效**的字段：

| 字段 | 说明 |
| --- | --- |
| 名称 | 文档标题 |
| 宽 × 高 | px，64–12000 |
| 分辨率 | ppi，只影响物理尺寸换算和存进文件的元信息 |
| 方向 | 竖 / 横，交换宽高 |
| 背景 | 白色 / 透明（透明时画布铺棋盘格） |

颜色模式、位深、像素长宽比、颜色配置文件这些**没做就不放**——摆上去只能点、不生效，
比没有更糟。底部实时显示 `2480 × 3508 px · RGB · 8 位 · 8.7 MP · 约 73 MB`
和按 dpi 换算的物理尺寸（A4 显示 21.0 × 29.7 cm）。

## 最近文件

存 localStorage，最多 6 条，按路径去重。每条右侧有删除按钮：

- **仅移除记录**：只从列表去掉
- **连文件一起删**：真的把 `.achi` 删掉（只有 Electron 能做，浏览器里不出现这个选项）

删除文件失败时**不会**把记录也抹掉——否则文件还在原地，用户却再也找不到它。

## 文件格式（.achi）

自定义容器，一条铁律：**坏文件不能把当前画布搞坏，也不能静悄悄加载一半。**

```
偏移  内容
0     "ACHI"            magic           4B
4     formatVersion     u16             2B
6     flags             u16             2B（必须为 0）
8     headerLen         u32             4B
12    header            UTF-8 JSON      变长
      ……数据块区，每块：nameLen u16 / name UTF-8 / dataLen u32 / data(PNG)
末尾  crc32             u32             4B，覆盖前面全部
```

三层校验，任一层不过就整体拒绝：结构（magic/版本/偏移边界）、CRC32、语义（JSON 能解析、
图层树能重建、每个块都被引用到）。读取时先完整解到一个新的 `Doc`，**全部成功之后才替换**
当前文档——中途抛异常，用户手上这张画一个字节都不动。

保存侧：Electron 先写 `.tmp` 再原子 `rename`，断电不会留下半个文件顶掉原件。

已验证的损坏情形：

| 情形 | 结果 |
| --- | --- |
| 截断一半 | `[CRC]` 校验和不符 |
| 翻转一个字节 | `[CRC]` 校验和不符 |
| 改 magic | `[BAD_MAGIC]` |
| 版本号高于本程序 | `[FUTURE_VERSION]` 提示升级 |

往返保真：多图层 + 组 + 蒙版 + 视图位置存读一轮，像素逐字节一致。

## 启动浮层

打开后先浮一个小窗在主界面上，选好尺寸就收起，直接开始画。
不选、按 Esc、或者点浮层外面，就用默认的 A4@300dpi。

预设按真实用途给：A4/A5/A3 的 300dpi、半分辨率、正方形、屏幕横版。每张标了大致内存占用——
这台是 8GB，A4@300dpi 一个文档的合成缓冲 35MB，加瓦片约 73MB，选之前心里有数。

链接里带 `?w=2480&h=3508` 可以直接跳过浮层进画布。

## 现在能干什么

- 画：hokusai/libmypaint 笔刷引擎，4 个预设，压感、笔刷大小/不透明度/流量/硬度/间距/稳定
- 图层：新建、分组、重排、显隐、不透明度、混合模式、蒙版
- 选区：矩形框选，框住的内容可以拎出来拖动、旋转、再落回去
- 工具：画笔 / 橡皮 / 吸管 / 移动 / 框选 / 抓手 / 缩放
- 文件：`.achi` 保存打开（带 CRC 校验），图片导入（拖进来或打开），PNG 导出
- 界面：启动浮层选画布尺寸、导航器、参考图窗、开发者控制台（⌘⇧D）

**还不能干**：套索/魔棒、自由变换（缩放/斜切）、文字、滤镜、对称辅助、
自动保存、笔画对象（单独选中某一笔）。

## 两种跑法

### 网页版（开发用）

```sh
python3 serve.py
# 浏览器打开 http://127.0.0.1:8899/src/index.html
```

改完刷新就见效，`src/` 直接就是源码。

### Electron 版（日常用）

```sh
npm run app            # 或 bash native/build-electron.sh
open ~/Applications/AchiPaint.app
```

约 **253MB**，常驻内存约 90MB。双击就能画，不依赖终端、不依赖本地服务。

**主路径是这条。** 网页端和 Electron 端共用同一份 `src/`，改一处两边都生效。

### 为什么是这两条、不是 WKWebView

试过用 Swift + WKWebView 做原生壳，能跑（680KB / 37fps），但搁置了：
macOS 27 之后 WebKit 的方向不明，而 Electron 至少把内核攥在自己手里。
代码留在 [native/experimental-webkit](native/experimental-webkit/)，需要时还能捡起来。

### Electron 在 macOS 27 上的坑

直接把 Electron.app 拖进 `~/Applications` 双击是**打不开**的：

```
ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)
```

原因是 macOS 会拒绝 LaunchServices 启动的、没有 Apple 签发 Team ID 的进程
调用 `task_name_for_pid`，而 Electron 启动时要做这项检查。
自签名证书也没用 —— Team ID 由 Apple 签发证书时写入，自己造不出来。

**绕法**：套一个极简 Swift launcher。

```
AchiPaint.app             ← LaunchServices 启动这一层（Swift，104KB）
  └─ spawn ────────────→ Electron.app/Contents/MacOS/AchiPaint   ← 真正干活的
```

另外两个坑：LaunchServices 不接受从 `/tmp` 启动的 app（`lsregister` 报 `-10811`），
以及极简 bundle 缺 `NSPrincipalClass` 也会被拒。构建脚本里都处理了。

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
native/
  electron/           Electron 主进程（自定义 achi:// 协议提供静态资源）
  build-electron.sh   打包 Electron 版并套上 launcher
  experimental-webkit/ WKWebView 壳，实验，暂不维护
build/           应用图标与签名用的 entitlements
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

## 还没做的

一大串，按「缺了最难受」排好了，见 [ROADMAP.md](ROADMAP.md)。

---

## 性能

[**Electron 能不能做专业绘画工具？**](PERFORMANCE.md) —— 实测数据、瓶颈定位、分阶段优化路线。

一句话：能。Photopea 和 Figma 已经证明 Web 技术栈跑得动专业工具，
真正的差距在于我们还没把笔刷计算挪出主线程、还没用 GPU 合成。
那份文档里写了 v0.2 到 v1.0 每一步要做什么、验收线在哪。

## 协议

本项目以 **MIT** 发布。

笔刷引擎来自 [hokusai](https://github.com/reearth/hokusai)（libmypaint 的 Rust 移植，
MIT / Apache-2.0），完整第三方声明见 [NOTICE](NOTICE)。

## 参与

alpha 阶段，接口和文件格式都可能变。
想提意见直接开 issue，尤其是**性能** —— 那是这个项目唯一想赢的地方。
