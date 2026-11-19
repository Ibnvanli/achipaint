/* 独立窗口里的控制台
 *
 * 数据全部来自 BroadcastChannel('achi-console')：
 * 主窗口收到 poll 就回一份快照。Electron 里窗口是主进程建的，
 * 拿不到 opener，所以不用 opener 这套。
 */

const MAX_LOG = 800;

const state = {
  tab: 'log',
  logs: [],
  paused: false,
  snap: null,
  online: false,
  lastSeen: 0,
};

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

function renderLog() {
  const el = panes.log;
  el.innerHTML = '';
  for (const L of state.logs.slice(-300)) {
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
  if (!state.logs.length) {
    el.innerHTML = '<div class="dc-row"><span class="dc-time"></span><span>还没有警告或错误。</span></div>';
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

  // 连接状态：3 秒没收到快照就算断
  const alive = state.lastSeen && (Date.now() - state.lastSeen < 3000);
  linkEl.textContent = alive ? '已连接' : '主窗口无响应';
  linkEl.classList.toggle('off', !alive);
}

/* ---------- 交互 ---------- */

host.querySelectorAll('.dc-tab').forEach(t => {
  t.onclick = () => {
    state.tab = t.dataset.tab;
    host.querySelectorAll('.dc-tab').forEach(x => x.classList.toggle('on', x === t));
    for (const [k, el] of Object.entries(panes)) el.hidden = (k !== state.tab);
    render();
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
