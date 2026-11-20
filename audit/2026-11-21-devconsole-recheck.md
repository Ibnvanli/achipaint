# 复查：开发者控制台（处置验证）— 2026-11-21

对应处置：[2026-11-20-devconsole-response.md](2026-11-20-devconsole-response.md)
对应原审查：[2026-11-20-devconsole.md](2026-11-20-devconsole.md)

基线：`4956ddb`（工作区干净）。
相对原审查基线 `80f6572` 新增提交：`4956ddb` 控制台：修复静止重建与滚动位置。

---

## 一、结论

处置文档提出的两项问题**全部成立**，修复**全部验证通过**。

| 项 | 处置声明 | 复查结果 |
|---|---|---|
| 静止时每 500ms 全量重建 | 已修（内容签名短路） | ✅ 代码存在，实测有效 |
| 新日志把视口拽回底部 | 已修（stickToBottom） | ✅ 代码存在，实测有效 |
| 连接状态三态化 | 已改 | ✅ 代码存在 |
| 提交历史来回 | 不处理 | 合理 |
| 快照生成优化 | 不做（实测 0.01ms） | 合理 |
| 新增 8 项测试 | 全部以 iframe 加载真实页面 | ✅ 实际 6 项（见第五节） |

处置文档对原审查的批评成立：原审查只验证了「点击后的状态」，
没有验证「不点击时系统在做什么」。这是验证范围的空白，不是判断错误，
但确实漏掉了两处用户可感知的缺陷。

---

## 二、验证过程

### 2.1 完整测试套件

仓库已有测试基础设施（`test/harness.js`，以 Electron 启动真实 Chromium）。
执行全部用例：

```
通过 32 项，失败 0 项
```

覆盖 7 个用例文件：`devconsole` / `devconsole-render` / `floating` /
`history-limits` / `perf-probe` / `transform-mask` / `undo-structure`。

### 2.2 有效性验证（关键）

测试「通过」不代表测试「有效」。故意注入两处回归：

```js
// 1) 退回无条件滚到底
- if (stickToBottom) el.scrollTop = el.scrollHeight;
+ el.scrollTop = el.scrollHeight;

// 2) 取消签名短路
- if (!force && sig === lastLogSignature) return;
+ if (false && sig === lastLogSignature) return;
```

结果：

```
✗ devconsole-render.test.js › 静止时日志区不重建
✗ devconsole-render.test.js › 向上翻阅时不被新日志拽回
通过 30 项，失败 2 项
```

**两条对应用例精确报错，其余不受影响。** 恢复后回到 32 项全通过。

这说明测试确实在断言行为，不是空跑。

---

## 三、逐项代码核对

### 3.1 内容签名短路

`src/ui/devconsole-window.js`：

```js
let lastLogSignature = '';

function logSignature(list) {
  const last = list.length ? list[list.length - 1] : null;
  return `${state.filter}|${list.length}|${last ? last.t : 0}`;
}

function renderLog(force = false) {
  const sig = logSignature(list);
  if (!force && sig === lastLogSignature) return;
  lastLogSignature = sig;
  …
}
```

**签名包含 `state.filter`**，切换筛选仍能正确重建 —— 这一设计防止了
「优化短路导致筛选失效」这类新 bug。

清空路径有保底（`lastLogSignature = ''`），否则「清空后为空」与
「初始为空」签名相同会卡住不刷新。处置文档明确记录了这个陷阱。

### 3.2 滚动跟随

```js
let stickToBottom = true;

// 渲染时
if (stickToBottom) el.scrollTop = el.scrollHeight;

// 用户滚动时更新
stickToBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;

// 清空后重置
stickToBottom = true;
```

阈值 24px 用于吸收行高取整带来的抖动，合理。

### 3.3 连接状态三态

```js
if (!state.online)      linkEl.textContent = '未连接';      // 从未收到过快照
else if (alive)         linkEl.textContent = '已连接';
else                    linkEl.textContent = '连接中断';    // 收到过但已超时
```

原审查的建议被完整采纳，且注释写明了三种状态的语义差异。

---

## 四、处置文档质量

这份处置文档有一个原审查没有的优点：**记录了三次自误**。

1. 手工 append 填充行 → 下次重建清掉，测不到滚动
2. 用固定行数阈值等新日志 → 主窗口原有日志已满足，等到的是旧状态
3. 往控制台本地 `pushLocal` 塞日志 → 被主窗口快照整体覆盖

三次都是「测试通过但没测到东西」。这类失败比测试报错更危险 ——
报错至少知道有问题，空跑会让人误以为有保障。

最终改为往主窗口 `mainConsole.push`（真实投递路径）并用
「行数确实增加」作为等待条件，方向正确。

---

## 五、两处表述偏差（不影响结论）

### 5.1 「新增 8 项用例」实际为 6 项

处置文档第五节的表格列了 5 条，正文写「新增 8 项」。
实际 `devconsole-render.test.js` 中有 **6 条**用例：

```
静止时日志区不重建
向上翻阅时不被新日志拽回
停在底部时自动跟随新日志
切换筛选仍能重建
清空后仍可正常显示新日志
向上滚动不被重置
```

比表格多一条「向上滚动不被重置」，但总数是 6 不是 8。

**属于记述笔误，不影响功能结论。** 记录在此仅供将来引用时准确。

### 5.2 基线标注

处置文档标注基线 `80f6572`，其实际修改提交为 `4956ddb`。
这两者之间的差异即本次修复内容，标注方式可以理解。

---

## 六、遗留

原审查中的两项遗留问题，当前状态：

| 项 | 状态 |
|---|---|
| 提交历史有一次来回（`e3e4019` 删页签 / `80f6572` 加回） | 仍未处理，处置文档采纳了「不改写已推送历史」的建议 |
| 「主窗口无响应」歧义 | ✅ 已消除 |

---

## 七、方法层面的结论

本次复查验证了一件事：**「测试通过」和「测试有效」是两回事**。

处置文档做了有效性验证（退回旧代码看是否报错），这是原审查没有做的。
建议把这一条固化进 `audit/README.md` 的约定：

> 新增测试后，必须退回旧实现确认测试会失败，否则无法证明测试有效。

本次复查也照此执行，注入两处回归后确认对应用例精确报错。
