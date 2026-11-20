# 审查：开发者控制台 — 2026-11-20

基线：`80f6572`（工作区干净）。审查对象为该提交前的三次控制台改动：

| 提交 | 说明 |
|---|---|
| `e3e4019` | 控制台精简为仅日志，修复性能探针自锁 |
| `80f6572` | 修正：保留三个页签，筛选栏仅在日志页显示 |

审查方式：读代码 + 在无头 Edge 中实际加载 `devconsole.html`，
逐个点击页签，检查 DOM 状态。

---

## 一、结论

| 项 | 结果 |
|---|---|
| 四页签保留 | ✅ |
| 筛选栏仅在日志页显示 | ✅ |
| 页签互斥（同时只一个 pane） | ✅ |
| 页签高亮跟随 | ✅ |
| 清空 / 暂停按钮 | ✅ 均有实现 |
| 性能探针自锁 | ✅ 已修，实测可记录 |
| 引入新 bug | 无 |

**代码质量合格。** 未发现功能性缺陷。

---

## 二、验证详情

### 2.1 页签与筛选栏联动

实测四个页签逐个点击，检查 `dc-filters` 的 `hidden` 属性与可见 pane：

| 页签 | 筛选栏隐藏 | 可见 pane | 高亮 |
|---|---|---|---|
| 日志 | `false` | `log` | ✅ |
| 性能 | `true` | `perf` | ✅ |
| 文档 | `true` | `doc` | ✅ |
| 操作 | `true` | `act` | ✅ |

`syncFilterBar()` 实现正确：

```js
function syncFilterBar() {
  const bar = document.getElementById('dc-filters');
  if (bar) bar.hidden = (state.tab !== 'log');
}
```

并且在初始化时调用了一次（`syncFilterBar()` 位于绑定之后），
切换到其他页签时由 `onclick` 再次调用 —— 没有遗漏路径。

### 2.2 性能探针自锁（已修）

**原问题**：

```js
if (!window.__achiPerf) return;      // 此时尚未赋值
// ……记录样本……
window.__achiPerf = perfSamples;     // 末尾才赋值
```

第一次调用即返回，之后每次同样返回 —— **探针从未记录过任何一帧**，
控制台性能页全部显示 `null`。

这是典型的**用输出判断要不要执行**的自锁：把「结果是否存在」
当成了「开关是否打开」。

**当前实现**（`src/main.js:116` 附近）：

```js
const perfSamples = [];
let perfEnabled = true;              // 独立布尔量

Object.defineProperty(window, '__achiPerf', {
  get: () => perfSamples,            // 只读暴露
  configurable: true,
});
```

开关与输出解耦。实测主窗口画一笔后 `window.__achiPerf.length === 2`，
记录正常。

### 2.3 清空 / 暂停

```js
document.getElementById('dc-clear').onclick = () => {
  state.logs = [];
  if (bus) bus.postMessage({ type: 'clear' });
  renderLog();
};

pauseBtn.onclick = () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
};
```

暂停的语义在接收侧实现：

```js
if (!state.paused && m.logs) state.logs = m.logs;
```

暂停时不再接收新日志，已显示的内容保留，按钮文案切换为「继续」。
语义正确。

---

## 三、遗留问题（非缺陷）

### 3.1 提交历史有一次来回

`e3e4019` 删除了性能 / 文档 / 操作三个页签及其渲染函数、CSS；
`80f6572` 又将它们全部恢复。

`80f6572` 的提交信息已注明「上一提交误解了需求」。

**功能最终正确**，但 `git log` 中留下「删了又加」的记录。
对将来阅读历史的人，这条记录会引发疑问：到底应当保留几个页签？

**处理建议**：可用 `git rebase -i` 合并两个提交，但会改写历史。
若已推送至远程，不建议改动 —— 代价大于收益。**此项无需处理。**

### 3.2 「主窗口无响应」提示有歧义

控制台通过 `BroadcastChannel('achi-console')` 与主窗口通信。
单独打开 `devconsole.html` 时对端不存在，3 秒后判定为断开：

```js
const alive = state.lastSeen && (Date.now() - state.lastSeen < 3000);
linkEl.textContent = alive ? '已连接' : '主窗口无响应';
```

**两个不同状态显示同一句话**：

| 实际状态 | 当前显示 |
|---|---|
| 主窗口根本没启动 | 主窗口无响应 |
| 主窗口启动过但已崩溃 / 卡死 | 主窗口无响应 |

**这属于设计行为，不是 bug**，但提示语容易让人误以为出了故障。
截图确认：独立打开时页面显示「主窗口无响应」，其余功能正常渲染。

**建议**（非必需）：区分为「未连接」与「连接中断」。

---

## 四、代码位置索引

| 内容 | 位置 |
|---|---|
| 页签结构 | `src/ui/devconsole-window.js:35-39` |
| 筛选栏结构 | `src/ui/devconsole-window.js:41-46` |
| 筛选显隐 | `src/ui/devconsole-window.js` `syncFilterBar()` |
| 页签切换 | 同上，`dc-tab` 的 `onclick` |
| 清空 | 同上，`dc-clear` |
| 暂停 | 同上，`dc-pause` + 接收侧的 `state.paused` |
| 性能探针 | `src/main.js` 约 116 行附近 |
| 连接判定 | `src/ui/devconsole-window.js` `render()` 末尾 |

---

## 五、与既有审计的关系

本文是独立审查，不推翻前两份报告。控制台此前未单独审查过，
`2026-11-20-audit.md` 中仅提及「无 CSP、`window.__achi` 暴露写操作」
这类通用安全项，与本次审查范围不重叠。
