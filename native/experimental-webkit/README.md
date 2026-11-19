# WKWebView 壳（实验，暂不维护）

用 Swift + WKWebView 做的原生壳，`bash build.sh` 可以打出 **680KB** 的 `.app`。

**当前不是主路径。** 主路径见上级目录的 `build-electron.sh` 和仓库根目录的 `serve.py`。

## 为什么搁置

macOS 27 之后 WebKit 的方向不明。苹果对「别人在其引擎上搭生态」一向不算热络，
而 Electron 至少把 Chromium 攥在自己手里 —— 内核版本、行为、什么时候坏，都是可控的。

留着这份代码的理由只有一个：万一哪天需要一条不依赖 Chromium 的路，这里已经有能跑的东西。

## 实测数据（真实窗口）

| | 帧率 | 体积 | 内存 |
| --- | --- | --- | --- |
| 本方案（WKWebView） | 37 fps | 680KB | 90MB |
| Electron | 44 fps | 253MB | 93MB |

WKWebView 的 `desynchronized` canvas 和 `getCoalescedEvents()` 都支持，
输入到合成完成 6ms（比 Chromium 还快），瓶颈在 canvas 层交给系统合成的开销。

## 已知问题（都已修在 src/ 里）

- `requestPaint` 的 rAF 锁：WKWebView 会吞掉页面刚加载时排队的回调，锁解不开
- scheme 响应缓存：只写 `Cache-Control: no-store` 不够，WebKit 仍会缓存脚本
- `setPointerCapture` 对合成事件会抛异常
