/* 独立窗口中的控制台
 *
 * 数据全部来自 BroadcastChannel('achi-console')：
 * 主窗口收到 poll 后返回一份快照。Electron 中窗口由主进程创建，
 * 无法获取 opener，因此不使用 opener 机制。
 */

const MAX_LOG = 800;

const state = {
  filter: 'all',
  logs: [],
  paused: false,
  lastSeen: 0,      // 最近一次收到快照的时间，用于连接状态判定
};

let bus = null;
try { bus = new BroadcastChannel('achi-console'); } catch { /* 环境不支持 */ }

/* ---------- 骨架 ---------- */

const host = document.getElementById('devconsole');
host.innerHTML = `
  <header class="dc-head">
    <span class="dc-title">AchiPaint 控制台</span>
    <span class="dc-spacer"></span>
    <span class="dc-link" id="dc-link">连接中…</span>
    <button class="dc-btn" id="dc-clear">清空</button>
    <button class="dc-btn" id="dc-pause">暂停</button>
  </header>
  <div class="dc-filters" id="dc-filters">
    <button class="dc-filter on" data-filter="all">全部操作</button>
    <button class="dc-filter" data-filter="warn">警告</button>
    <button class="dc-filter" data-filter="error">错误</button>
    <button class="dc-filter" data-filter="ext">外接扩展</button>
  </div>
  <div class="dc-body">
    <div class="dc-pane" id="dc-pane-log"></div>
  </div>
`;

const panes = {
  log: document.getElementById('dc-pane-log'),
};
const linkEl = document.getElementById('dc-link');

/* ---------- 接收主窗口 ---------- */

if (bus) {
  bus.onmessage = ev => {
    const m = ev.data || {};
    if (m.type === 'state') {
      state.lastSeen = Date.now();
      if (!state.paused && m.logs) state.logs = m.logs;
      renderLog();
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
  renderLog();
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

function renderLog() {
  const el = panes.log;
  el.innerHTML = '';
  const list = state.logs.filter(matchFilter).slice(-300);
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
  el.scrollTop = el.scrollHeight;
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

function render() {
  renderLog();

  // 连接状态：超过 3 秒未收到快照即判定为断开
  const alive = state.lastSeen && (Date.now() - state.lastSeen < 3000);
  linkEl.textContent = alive ? '已连接' : '主窗口无响应';
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

document.getElementById('dc-clear').onclick = () => {
  state.logs = [];
  if (bus) bus.postMessage({ type: 'clear' });
  renderLog();
};

const pauseBtn = document.getElementById('dc-pause');
pauseBtn.onclick = () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
};

setInterval(() => { poll(); render(); }, 500);
poll();
