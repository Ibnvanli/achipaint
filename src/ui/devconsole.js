/* 开发者控制台
 *
 * 有些 bug 肉眼看不在 —— 图标没了、文件没存上、某次点击无反应，
 * 界面上只有「什么都没发生」这一种表现。所以给一个能看见内部状态的面板。
 *
 * 四个页：日志 / 性能 / 文档 / 操作
 */

const MAX_LOG = 500;

export class DevConsole {
  constructor(host) {
    this.host = host;
    this.logs = [];
    this.tab = 'log';
    this.timer = null;
    this.paused = false;
    this._orig = {};

    this.build();
    this.patchConsole();
    this.bind();
  }

  build() {
    this.host.innerHTML = `
      <header class="dc-head">
        <span class="dc-title">控制台</span>
        <span class="dc-fps" id="dc-fps"></span>
        <span class="dc-spacer"></span>
        <button class="dc-btn" id="dc-clear">清空</button>
        <button class="dc-btn" id="dc-pause">暂停</button>
        <button class="dc-btn" id="dc-close">关闭</button>
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
    this.panes = {
      log: this.host.querySelector('#dc-pane-log'),
      perf: this.host.querySelector('#dc-pane-perf'),
      doc: this.host.querySelector('#dc-pane-doc'),
      act: this.host.querySelector('#dc-pane-act'),
    };
  }

  /* 把 console.* 抄一份进来，控制台里就能看到代码自己报的错了 */
  patchConsole() {
    for (const level of ['log', 'warn', 'error', 'info']) {
      const orig = console[level].bind(console);
      this._orig[level] = orig;
      console[level] = (...args) => {
        orig(...args);
        if (level === 'log') return;           // log 太吵，只收警告和错误
        this.push(level, args);
      };
    }
    window.addEventListener('error', e => {
      this.push('error', [`${e.message}  @${e.filename}:${e.lineno}`]);
    });
    window.addEventListener('unhandledrejection', e => {
      this.push('error', ['未处理的 Promise 拒绝: ' + String(e.reason)]);
    });
  }

  push(level, args) {
    if (this.paused) return;
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    this.logs.push({ level, text, t: Date.now() });
    if (this.logs.length > MAX_LOG) this.logs.shift();
    if (this.tab === 'log') this.renderLog();
  }

  renderLog() {
    const el = this.panes.log;
    if (!el) return;
    el.innerHTML = '';
    for (const L of this.logs.slice(-200)) {
      const row = document.createElement('div');
      row.className = 'dc-row dc-' + L.level;
      const t = new Date(L.t);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      row.innerHTML = `<span class="dc-time">${hh}:${mm}:${ss}</span><span></span>`;
      row.lastChild.textContent = L.text;
      el.appendChild(row);
    }
    el.scrollTop = el.scrollHeight;
  }

  renderPerf() {
    const el = this.panes.perf;
    const perf = (window.__achiPerf || []).slice(-300);
    const pick = k => perf.map(p => p[k]).filter(v => v > 0).sort((a, b) => a - b);
    const q = (a, p) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : null;
    const gaps = pick('gap'), lags = pick('inputLag'), frames = pick('frame');
    const fps = gaps.length ? +(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1) : null;

    const row = (k, v, warn) =>
      `<div class="dc-kv${warn ? ' warn' : ''}"><span>${k}</span><b>${v}</b></div>`;

    const heap = performance.memory
      ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : '—';

    el.innerHTML = `
      <div class="dc-section">渲染（最近 ${perf.length} 帧）</div>
      ${row('帧率', fps == null ? '—' : fps + ' fps', fps != null && fps < 55)}
      ${row('帧间隔 p50', q(gaps, 0.5) + ' ms')}
      ${row('帧间隔 p90', q(gaps, 0.9) + ' ms', q(gaps, 0.9) > 20)}
      ${row('合成耗时 p50', q(frames, 0.5) + ' ms')}
      ${row('合成耗时 p90', q(frames, 0.9) + ' ms', q(frames, 0.9) > 8)}
      <div class="dc-section">输入</div>
      ${row('输入→出帧 p50', q(lags, 0.5) + ' ms')}
      ${row('输入→出帧 p90', q(lags, 0.9) + ' ms', q(lags, 0.9) > 30)}
      <div class="dc-section">内存</div>
      ${row('JS 堆', heap)}
      ${row('视口画布', (() => { const c = document.getElementById('view'); return c ? c.width + ' × ' + c.height : '—'; })())}
    `;
  }

  renderDoc(api) {
    const el = this.panes.doc;
    const d = api.doc;
    if (!d) { el.textContent = '没有文档'; return; }
    const leaves = [];
    const walk = ns => ns.forEach(n => n.isGroup ? walk(n.children) : leaves.push(n));
    walk(d.root.children);

    const row = (k, v) => `<div class="dc-kv"><span>${k}</span><b>${v}</b></div>`;
    el.innerHTML = `
      <div class="dc-section">文档</div>
      ${row('尺寸', d.w + ' × ' + d.h)}
      ${row('背景', d.background)}
      ${row('缩放', (d.view.zoom * 100).toFixed(0) + '%')}
      ${row('视图偏移', Math.round(d.view.x) + ', ' + Math.round(d.view.y))}
      ${row('图层数', leaves.length)}
      ${row('选中', d.activeLeaf ? d.activeLeaf.name : '—')}
      <div class="dc-section">图层</div>
      ${leaves.map(l => row(l.name || '未命名',
        `${l.visible ? '显示' : '隐藏'} · ${Math.round(l.opacity * 100)}% · ${l.mode} · ${l.canvas.tiles.size} 块`)).join('')}
      <div class="dc-section">状态</div>
      ${row('撤销栈', api.history.stack.length + ' 步')}
      ${row('撤销内存', (api.history.bytes / 1048576).toFixed(1) + ' MB')}
      ${row('引擎', api.hk && api.hk.ready ? 'hokusai 就绪' : '内置笔画')}
      ${row('选区', d.selection ? `(${Math.round(d.selection.x0)},${Math.round(d.selection.y0)})–(${Math.round(d.selection.x1)},${Math.round(d.selection.y1)})` : '无')}
    `;
  }

  renderAct(api) {
    const el = this.panes.act;
    const recents = (() => {
      try { return JSON.parse(localStorage.getItem('achi.recent') || '[]'); } catch { return []; }
    })();
    const row = (k, v) => `<div class="dc-kv"><span>${k}</span><b>${v}</b></div>`;
    el.innerHTML = `
      <div class="dc-section">环境</div>
      ${row('运行在', navigator.userAgent.includes('Electron') ? 'Electron' : '浏览器')}
      ${row('文件桥', window.achiFile ? '可用' : '不可用')}
      ${row('devicePixelRatio', String(window.devicePixelRatio))}
      <div class="dc-section">最近文件</div>
      ${recents.length ? recents.map(r => row(r.name, r.path || '(无路径)')).join('') : '<div class="dc-kv"><span>—</span></div>'}
      <div class="dc-section">快捷操作</div>
      <div class="dc-actions">
        <button class="dc-btn" data-act="test-image">测试：导入一张图</button>
        <button class="dc-btn" data-act="test-roundtrip">测试：保存→解析往返</button>
        <button class="dc-btn" data-act="mark-all">强制全量重绘</button>
      </div>
    `;
    el.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = () => this.runTest(b.dataset.act, api);
    });
  }

  async runTest(id, api) {
    try {
      if (id === 'test-image') {
        const r = await api.selfTestImage();
        this.push('info', ['导入测试：' + r]);
      } else if (id === 'test-roundtrip') {
        const r = await api.selfTestRoundtrip();
        this.push('info', ['往返测试：' + r]);
      } else if (id === 'mark-all') {
        api.doc.markAllDirty();
        api.redraw();
        this.push('info', ['已强制全量重绘']);
      }
    } catch (e) {
      this.push('error', ['测试失败: ' + String(e)]);
    }
  }

  bind() {
    this.host.querySelector('#dc-close').onclick = () => this.hide();
    this.host.querySelector('#dc-clear').onclick = () => {
      this.logs = [];
      this.renderLog();
    };
    const pauseBtn = this.host.querySelector('#dc-pause');
    pauseBtn.onclick = () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? '继续' : '暂停';
    };
    this.host.querySelectorAll('.dc-tab').forEach(t => {
      t.onclick = () => {
        this.tab = t.dataset.tab;
        this.host.querySelectorAll('.dc-tab').forEach(x => x.classList.toggle('on', x === t));
        for (const [k, el] of Object.entries(this.panes)) el.hidden = (k !== this.tab);
        this.refresh();
      };
    });
  }

  refresh() {
    const api = window.__achi;
    if (!api) return;
    if (this.tab === 'log') this.renderLog();
    else if (this.tab === 'perf') this.renderPerf();
    else if (this.tab === 'doc') this.renderDoc(api);
    else if (this.tab === 'act') this.renderAct(api);

    const fpsEl = this.host.querySelector('#dc-fps');
    if (fpsEl) {
      const perf = (window.__achiPerf || []).slice(-60);
      const g = perf.map(p => p.gap).filter(v => v > 0);
      fpsEl.textContent = g.length
        ? (1000 / (g.reduce((a, b) => a + b, 0) / g.length)).toFixed(0) + ' fps'
        : '';
    }
  }

  get open() { return !this.host.hasAttribute('hidden'); }

  show() {
    this.host.removeAttribute('hidden');
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.open) this.refresh(); }, 500);
  }

  hide() {
    this.host.setAttribute('hidden', '');
    clearInterval(this.timer);
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }
}
