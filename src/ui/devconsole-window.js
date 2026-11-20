/* 独立窗口中的控制台
 *
 * 数据全部来自 BroadcastChannel('achi-console')：
 * 主窗口收到 poll 后返回一份快照。Electron 中窗口由主进程创建，
 * 无法获取 opener，因此不使用 opener 机制。
 */

const MAX_LOG = 800;

const state = {
  tab: 'log',
  filter: 'all',
  logs: [],
  paused: false,
  snap: null,
  online: false,
  lastSeen: 0,
};

/* 日志区是否应自动跟随到底部。
 * 用户滚动到接近底部时置为 true（跟随新日志），
 * 向上翻阅超过阈值则置为 false（保持视口不动）。 */
let stickToBottom = true;

let bus = null;
try { bus = new BroadcastChannel('achi-console'); } catch { /* 环境不支持 */ }

/* ---------- 骨架 ---------- */

const host = document.getElementById('devconsole');
host.innerHTML = `
  <header class="dc-head">
    <span class="dc-title">AchiPaint 控制台</span>
    <span class="dc-fps" id="dc-fps"></span>
    <span class="dc-spacer"></span>
    <span class="dc-link" id="dc-link">连接中…</span>
    <button class="dc-btn" id="dc-clear">清空</button>
    <button class="dc-btn" id="dc-pause">暂停</button>
  </header>
  <nav class="dc-tabs">
    <button class="dc-tab on" data-tab="log">日志</button>
    <button class="dc-tab" data-tab="perf">性能</button>
    <button class="dc-tab" data-tab="doc">文档</button>
    <button class="dc-tab" data-tab="act">操作</button>
  </nav>
  <div class="dc-filters" id="dc-filters">
    <button class="dc-filter on" data-filter="all">全部操作</button>
    <button class="dc-filter" data-filter="warn">警告</button>
    <button class="dc-filter" data-filter="error">错误</button>
    <button class="dc-filter" data-filter="ext">外接扩展</button>
  </div>
  <div class="dc-body">
    <div class="dc-pane" id="dc-pane-log"></div>
    <div class="dc-pane" id="dc-pane-perf" hidden></div>
    <div class="dc-pane" id="dc-pane-doc" hidden></div>
    <div class="dc-pane" id="dc-pane-act" hidden></div>
  </div>
`;

const panes = {
  log: document.getElementById('dc-pane-log'),
  perf: document.getElementById('dc-pane-perf'),
  doc: document.getElementById('dc-pane-doc'),
  act: document.getElementById('dc-pane-act'),
};
const fpsEl = document.getElementById('dc-fps');
const linkEl = document.getElementById('dc-link');

const row = (k, v, warn) =>
  `<div class="dc-kv${warn ? ' warn' : ''}"><span>${k}</span><b>${v}</b></div>`;
const section = t => `<div class="dc-section">${t}</div>`;

/* ---------- 接收主窗口 ---------- */

if (bus) {
  bus.onmessage = ev => {
    const m = ev.data || {};
    if (m.type === 'state') {
      state.snap = m;
      state.online = true;
      state.lastSeen = Date.now();
      if (!state.paused && m.logs) state.logs = m.logs;
      if (state.tab === 'log') renderLog();
      else render();
    } else if (m.type === 'testResult') {
      pushLocal(m.ok ? 'info' : 'error',
        `[${m.id}] ${m.ok ? '通过' : '失败'}：${m.result}`);
    }
  };
}

function poll() {
  if (bus) bus.postMessage({ type: 'poll' });
}

function pushLocal(level, text) {
  state.logs.push({ level, text, t: Date.now() });
  if (state.logs.length > MAX_LOG) state.logs.shift();
  if (state.tab === 'log') renderLog();
}

/* ---------- 渲染 ---------- */

/* 各级别与筛选分类的映射。
 * 「外接扩展」为将来插件系统预留的入口，当前尚无写入方。 */
const FILTER_OF = {
  log: 'all', info: 'all', op: 'all',
  warn: 'warn',
  error: 'error',
  ext: 'ext',
};

function matchFilter(L) {
  if (state.filter === 'all') return true;
  return FILTER_OF[L.level] === state.filter;
}

/* 渲染日志列表。
 *
 * 只在内容确实变化时重建 DOM。
 * 主循环每 500ms 调一次 render()，若无条件重建：
 *   1) 静止界面也在持续产生 DOM 变动（实测 1.5 秒内 24 次）
 *   2) 每次重建都会把滚动位置拉回底部，用户向上翻阅时会被反复拽回去
 * 因此用一个内容签名做短路判断。 */
let lastLogSignature = '';

function logSignature(list) {
  /* 签名只需反映「显示内容是否变化」。日志为追加式，末条的序号与总数
   * 足以判断；配合筛选条件，切换筛选时也能正确触发重建。 */
  const last = list.length ? list[list.length - 1] : null;
  return `${state.filter}|${list.length}|${last ? last.t : 0}`;
}

function renderLog(force = false) {
  const el = panes.log;
  const list = state.logs.filter(matchFilter).slice(-300);

  const sig = logSignature(list);
  if (!force && sig === lastLogSignature) return;
  lastLogSignature = sig;

  el.innerHTML = '';
  for (const L of list) {
    const r = document.createElement('div');
    r.className = 'dc-row dc-' + L.level;
    const t = new Date(L.t);
    const ts = [t.getHours(), t.getMinutes(), t.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    r.innerHTML = `<span class="dc-time">${ts}</span><span></span>`;
    r.lastChild.textContent = L.text;
    el.appendChild(r);
  }
  /* 仅当用户本就停在底部时才自动跟随。
   * 无条件滚动到底部会让「向上翻看历史」在每条新日志到达时被打断 ——
   * 日志是持续追加的，这个体验问题会一直存在。 */
  if (stickToBottom) el.scrollTop = el.scrollHeight;
  if (!list.length) {
    const msg = {
      all: '还没有日志。',
      warn: '没有警告。',
      error: '没有错误。',
      ext: '还没有外接扩展上报。这个页留给以后的插件系统。',
    }[state.filter] || '没有内容。';
    el.innerHTML = `<div class="dc-row"><span class="dc-time"></span><span>${msg}</span></div>`;
  }
}

function stats(a) {
  const s = a.filter(v => v > 0).sort((x, y) => x - y);
  const q = p => s.length ? +s[Math.floor(s.length * p)].toFixed(2) : null;
  return { p50: q(0.5), p90: q(0.9) };
}

function renderPerf() {
  const s = state.snap;
  if (!s) { panes.perf.innerHTML = '<div class="dc-kv"><span>等主窗口响应…</span></div>'; return; }
  const gaps = s.perf.map(p => p.gap);
  const lags = s.perf.map(p => p.inputLag);
  const frames = s.perf.map(p => p.frame);
  const g = stats(gaps), l = stats(lags), f = stats(frames);
  const fps = gaps.filter(v => v > 0).length
    ? +(1000 / (gaps.filter(v => v > 0).reduce((a, b) => a + b, 0) / gaps.filter(v => v > 0).length)).toFixed(1)
    : null;

  panes.perf.innerHTML = `
    ${section(`渲染（最近 ${s.perf.length} 帧）`)}
    ${row('帧率', fps == null ? '—' : fps + ' fps', fps != null && fps < 55)}
    ${row('帧间隔 p50', g.p50 + ' ms')}
    ${row('帧间隔 p90', g.p90 + ' ms', g.p90 > 20)}
    ${row('合成耗时 p50', f.p50 + ' ms')}
    ${row('合成耗时 p90', f.p90 + ' ms', f.p90 > 8)}
    ${section('输入')}
    ${row('输入→出帧 p50', l.p50 + ' ms')}
    ${row('输入→出帧 p90', l.p90 + ' ms', l.p90 > 30)}
    ${section('内存')}
    ${row('JS 堆', s.heap ? (s.heap / 1048576).toFixed(1) + ' MB' : '—')}
    ${row('视口画布', s.canvas ? s.canvas.join(' × ') : '—')}
  `;
  fpsEl.textContent = fps == null ? '' : fps + ' fps';
}

function renderDoc() {
  const s = state.snap;
  if (!s) { panes.doc.innerHTML = '<div class="dc-kv"><span>等主窗口响应…</span></div>'; return; }
  const d = s.doc;
  const sel = d.selection
    ? `(${Math.round(d.selection.x0)},${Math.round(d.selection.y0)})–(${Math.round(d.selection.x1)},${Math.round(d.selection.y1)})`
    : '无';
  panes.doc.innerHTML = `
    ${section('文档')}
    ${row('尺寸', d.w + ' × ' + d.h)}
    ${row('背景', d.background)}
    ${row('缩放', (d.zoom * 100).toFixed(0) + '%')}
    ${row('视图偏移', Math.round(d.viewX) + ', ' + Math.round(d.viewY))}
    ${row('图层数', d.layers.length)}
    ${row('选中', d.active || '—')}
    ${section('图层')}
    ${d.layers.map(l => row(l.name || '未命名',
      `${l.visible ? '显示' : '隐藏'} · ${Math.round(l.opacity * 100)}% · ${l.mode} · ${l.tiles} 块`)).join('')}
    ${section('状态')}
    ${row('撤销栈', s.history.steps + ' 步')}
    ${row('撤销内存', (s.history.bytes / 1048576).toFixed(1) + ' MB')}
    ${row('引擎', s.hkReady ? 'hokusai 就绪' : '内置笔画')}
    ${row('选区', sel)}
  `;
}

function renderAct() {
  const s = state.snap;
  panes.act.innerHTML = `
    ${section('环境')}
    ${row('主窗口', state.online ? '已连接' : '未连接')}
    ${row('运行在', s && s.isElectron ? 'Electron' : '浏览器')}
    ${section('最近文件')}
    ${s && s.recents.length
      ? s.recents.map(r => row(r.name, r.path || '(无路径)')).join('')
      : '<div class="dc-kv"><span>—</span><b>没有记录</b></div>'}
    ${section('自测（在主窗口里跑）')}
    <div class="dc-actions">
      <button class="dc-btn" data-act="image">导入一张图</button>
      <button class="dc-btn" data-act="roundtrip">保存 → 解析往返</button>
      <button class="dc-btn" data-act="markAll">强制全量重绘</button>
    </div>
  `;
  panes.act.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      if (!bus) return pushLocal('error', '没有 BroadcastChannel，无法触发');
      bus.postMessage({ type: 'test', id: b.dataset.act });
      pushLocal('info', `已请求：${b.textContent}`);
    };
  });
}

function render() {
  if (state.tab === 'perf') renderPerf();
  else if (state.tab === 'doc') renderDoc();
  else if (state.tab === 'act') renderAct();
  else renderLog();

  /* 连接状态分三种，此前「从未连上」与「连过又断」共用同一句「主窗口无响应」，
   * 会让人误以为刚发生了故障（审查报告 3.2）。
   *
   *   从未收到过快照   → 未连接（对端可能根本没启动）
   *   收到过且 3 秒内  → 已连接
   *   收到过但已超时   → 连接中断（对端曾存在，现已失联）
   */
  const alive = state.lastSeen && (Date.now() - state.lastSeen < 3000);
  if (alive) {
    linkEl.textContent = '已连接';
  } else if (!state.lastSeen) {
    linkEl.textContent = '未连接';
  } else {
    linkEl.textContent = '连接中断';
  }
  linkEl.classList.toggle('off', !alive);
}

/* ---------- 交互 ---------- */

host.querySelectorAll('.dc-filter').forEach(b => {
  b.onclick = () => {
    state.filter = b.dataset.filter;
    host.querySelectorAll('.dc-filter').forEach(x => x.classList.toggle('on', x === b));
    renderLog();
  };
});

/* 日志级别筛选只对「日志」页有意义。
 * 性能 / 文档 / 操作三页是结构化信息，不存在 level 概念，
 * 在那里显示筛选栏只会让人以为筛掉了内容。因此切页时一并收起。 */
function syncFilterBar() {
  const bar = document.getElementById('dc-filters');
  if (bar) bar.hidden = (state.tab !== 'log');
}

host.querySelectorAll('.dc-tab').forEach(t => {
  t.onclick = () => {
    state.tab = t.dataset.tab;
    host.querySelectorAll('.dc-tab').forEach(x => x.classList.toggle('on', x === t));
    for (const [k, el] of Object.entries(panes)) el.hidden = (k !== state.tab);
    syncFilterBar();
    render();
  };
});

syncFilterBar();

/* 阈值 24px：容差范围内仍视为「在底部」，避免因行高取整导致判定反复跳变。 */
panes.log.addEventListener('scroll', () => {
  const el = panes.log;
  stickToBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;
});

document.getElementById('dc-clear').onclick = () => {
  state.logs = [];
  lastLogSignature = '';        // 强制下一次重建，避免空列表与旧签名相同
  stickToBottom = true;         // 清空后回到跟随状态
  if (bus) bus.postMessage({ type: 'clear' });
  renderLog(true);
};

const pauseBtn = document.getElementById('dc-pause');
pauseBtn.onclick = () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
};

setInterval(() => { poll(); render(); }, 500);
poll();

/* 测试接口：供自动化用例走真实的日志追加与渲染路径。
 * 直接操作 DOM 无法验证滚动行为 —— 下一次重建会把手工插入的节点清掉。 */
window.__dcTest = {
  pushMany(n) {
    for (let i = 0; i < n; i++) {
      pushLocal('info', '测试日志 ' + i + ' ' + Date.now());
    }
  },
  get stickToBottom() { return stickToBottom; },
};
