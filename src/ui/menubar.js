/* 命令表与网页端菜单栏
 *
 * 此处定义的每个命令在 Electron 原生菜单中均有对应项
 * （见 native/electron/main.js 的 buildMenu），修改时需同步更新。
 *
 * 仅收录**可实际执行**的命令。尚未实现的命令不予列出：点击无响应比不提供更糟。
 */

export const COMMANDS = [
  { group: 'file', label: '文件' },
  { id: 'file:new', group: 'file', label: '新建', key: '⌘N' },
  { id: 'file:open', group: 'file', label: '打开…', key: '⌘O' },
  { id: 'file:save', group: 'file', label: '保存', key: '⌘S' },
  { id: 'file:saveAs', group: 'file', label: '另存为…', key: '⇧⌘S' },
  { id: 'file:export', group: 'file', label: '导出 PNG…', key: '⇧⌘E' },

  { group: 'edit', label: '编辑' },
  { id: 'edit:undo', group: 'edit', label: '撤销', key: '⌘Z' },
  { id: 'edit:redo', group: 'edit', label: '重做', key: '⇧⌘Z' },
  { id: 'edit:clearSel', group: 'edit', label: '取消选区', key: 'Esc' },

  { group: 'view', label: '视图' },
  { id: 'view:reference', group: 'view', label: '参考图窗', key: '⇧⌘O' },
  { id: 'view:fit', group: 'view', label: '适应窗口', key: '⌘0' },
  { id: 'view:100', group: 'view', label: '实际大小', key: '⌘1' },
  { id: 'view:in', group: 'view', label: '放大', key: '⌘+' },
  { id: 'view:out', group: 'view', label: '缩小', key: '⌘-' },
  { group: 'debug', label: '调试' },
  { id: 'view:console', group: 'debug', label: '开发者控制台', key: '⇧⌘D' },
  { id: 'debug:reload', group: 'debug', label: '重新加载界面', key: '⇧⌘R' },
  { id: 'debug:markAll', group: 'debug', label: '强制全量重绘' },
  { id: 'debug:testImage', group: 'debug', label: '测试：导入一张图' },
  { id: 'debug:testRoundtrip', group: 'debug', label: '测试：保存解析往返' },
];

const ICONS = {
  'file:new': '<path d="M4.5 2.5h6l3.5 3.5v9.5h-9.5z"/><path d="M10.5 2.5V6H14"/>',
  'file:open': '<path d="M2.5 5.5h5l1.5 2h6.5v7.5h-13z"/>',
  'file:save': '<path d="M9 2.5v8"/><path d="M5.8 7.4 9 10.6l3.2-3.2"/><path d="M3.5 13.5v2h11v-2"/>',
  'edit:undo': '<path d="M7 5.5 3.5 9l3.5 3.5"/><path d="M3.5 9h6.5a4 4 0 0 1 0 8H8"/>',
  'edit:redo': '<path d="M11 5.5 14.5 9 11 12.5"/><path d="M14.5 9H8a4 4 0 0 0 0 8h2"/>',
  'file:export': '<rect x="2.5" y="3.5" width="13" height="11" rx="1.2"/><circle cx="6.4" cy="7" r="1.1"/><path d="M2.5 12.4 6 9.6l2.4 2.1 2.2-1.6 4.9 3.4"/>',
};

export function iconOf(id) {
  const body = ICONS[id];
  return body
    ? `<svg viewBox="0 0 18 18" aria-hidden="true">${body}</svg>`
    : '';
}

export class MenuBar {
  /**
   * @param {HTMLElement} host 标题栏里放菜单的容器
   * @param {(id:string)=>void} run 执行命令
   */
  constructor(host, run) {
    this.host = host;
    this.run = run;
    this.openGroup = null;

    this.build();
    this.bindGlobal();
  }

  build() {
    this.host.innerHTML = '';
    const groups = [];
    for (const c of COMMANDS) {
      if (c.group && !c.id) {
        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.textContent = c.label;
        btn.dataset.group = c.group;
        btn.onclick = e => {
          e.stopPropagation();
          this.toggle(c.group, btn);
        };
        groups.push({ group: c.group, btn });
        this.host.appendChild(btn);
      }
    }
    this.host._groups = groups;
  }

  toggle(group, btn) {
    if (this.openGroup === group) return this.close();
    this.close();

    const items = COMMANDS.filter(c => c.group === group && c.id);
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.dataset.group = group;

    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'menu-item';
      row.innerHTML = `<span>${item.label}</span><kbd>${item.key || ''}</kbd>`;
      row.onclick = e => {
        e.stopPropagation();
        this.close();
        this.run(item.id);
      };
      panel.appendChild(row);
    }

    btn.parentElement.style.position = 'relative';
    btn.appendChild(panel);
    btn.classList.add('open');
    this.openGroup = group;
    this._panel = panel;

    // 位置过于靠右时翻转到左侧，避免被窗口边界裁切
    requestAnimationFrame(() => {
      const r = panel.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) {
        panel.style.left = 'auto';
        panel.style.right = '0';
      }
    });
  }

  close() {
    if (this._panel) this._panel.remove();
    if (this.openGroup) {
      const btn = this.host.querySelector(`.menu-btn[data-group="${this.openGroup}"]`);
      if (btn) btn.classList.remove('open');
    }
    this.openGroup = null;
    this._panel = null;
  }

  bindGlobal() {
    window.addEventListener('pointerdown', e => {
      if (!this.openGroup) return;
      if (!e.target.closest('.menu-btn')) this.close();
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.openGroup) {
        e.stopPropagation();
        this.close();
      }
    }, true);
  }
}
