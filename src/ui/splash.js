/* 启动浮层
 *
 * 左边新建、右边最近，参照 Blender 的首页。
 * 但「最近」只有 Electron 里能真的重开 —— 浏览器拿不到文件路径，
 * 所以那边点进去只会提示用「打开文件」。
 */

const RECENT_KEY = 'achi.recent';
const RECENT_MAX = 6;

export const PRESETS = [
  { name: 'A4 · 300dpi', w: 2480, h: 3508, note: '印刷尺寸' },
  { name: 'A4 · 150dpi', w: 1240, h: 1754, note: '省一半内存' },
  { name: 'A5 · 300dpi', w: 1748, h: 2480, note: '速写' },
  { name: '正方形', w: 2000, h: 2000, note: '头像 / 社交' },
  { name: '屏幕', w: 1920, h: 1080, note: '横版' },
  { name: 'A3 · 300dpi', w: 3508, h: 4961, note: '大字海报' },
];

export function memMB(w, h) {
  return Math.round(((w * h * 4) / 1048576) * 2.2);
}

/* ---------- 最近文件 ---------- */

export function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(x => x && x.name) : [];
  } catch {
    return [];
  }
}

export function pushRecent(entry) {
  if (!entry || !entry.name) return;
  const list = readRecent().filter(x => !(x.path && entry.path && x.path === entry.path)
    && !(!entry.path && x.name === entry.name));
  list.unshift({ ...entry, time: Date.now() });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch { /* 隐私模式下写不进去，不算错 */ }
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/* ---------- 组件 ---------- */

export class Splash {
  /**
   * @param {object} opts
   * @param {(w:number,h:number,extra:object)=>void} opts.onPick
   * @param {()=>void} opts.onOpen
   * @param {(entry:object)=>void} opts.onOpenRecent
   * @param {(entry:object)=>void} opts.onRemoveRecent
   * @param {{w:number,h:number}} opts.defaultSize
   * @param {boolean} opts.canOpenRecent
   */
  constructor(opts) {
    this.el = document.getElementById('splash');
    this.viewList = document.getElementById('splash-view-list');
    this.viewDetail = document.getElementById('splash-view-detail');
    this.grid = document.getElementById('splash-presets');
    this.recentEl = document.getElementById('splash-recent');
    this.note = document.getElementById('splash-note');

    this.onPick = opts.onPick;
    this.onOpen = opts.onOpen || (() => {});
    this.onOpenRecent = opts.onOpenRecent || (() => {});
    this.onRemoveRecent = opts.onRemoveRecent || (() => {});
    this.defaultSize = opts.defaultSize;
    this.canOpenRecent = !!opts.canOpenRecent;

    this.buildPresets();
    this.bindList();
    this.bindDetail();
    this.refreshRecent();
  }

  /* ---------- 一屏 ---------- */

  buildPresets() {
    this.grid.innerHTML = '';
    for (const p of PRESETS) {
      const mem = memMB(p.w, p.h);
      const b = document.createElement('button');
      b.className = 'splash-card' + (mem > 180 ? ' heavy' : '');
      b.innerHTML = `
        <span class="n">${p.name}</span>
        <span class="d">${p.w} × ${p.h}</span>
        <span class="m">${p.note} · 约 ${mem} MB</span>`;
      b.onclick = () => this.showDetail(p);
      this.grid.appendChild(b);
    }
  }

  bindList() {
    document.getElementById('splash-custom').onclick = () => this.showDetail(null);
    document.getElementById('splash-open').onclick = () => this.onOpen();

    this._key = e => {
      if (e.key !== 'Escape' || this.hidden) return;
      e.preventDefault();
      if (!this.viewDetail.hidden) this.backToList();
      else this.dismiss();
    };
    window.addEventListener('keydown', this._key);

    this.el.addEventListener('pointerdown', e => {
      if (e.target === this.el) this.dismiss();
    });
  }

  /* ---------- 二屏：详细设置 ---------- */

  bindDetail() {
    this.dName = document.getElementById('dt-name');
    this.dW = document.getElementById('dt-w');
    this.dH = document.getElementById('dt-h');
    this.dDpi = document.getElementById('dt-dpi');
    this.dBg = document.getElementById('dt-bg');
    this.dInfo = document.getElementById('dt-info');
    this.dPhysical = document.getElementById('dt-physical');
    this.dPortrait = document.getElementById('dt-portrait');
    this.dLandscape = document.getElementById('dt-landscape');

    for (const el of [this.dW, this.dH, this.dDpi]) {
      el.addEventListener('input', () => this.refreshDetail());
    }

    this.dPortrait.onclick = () => this.setOrientation('portrait');
    this.dLandscape.onclick = () => this.setOrientation('landscape');

    document.getElementById('dt-back').onclick = () => this.backToList();
    document.getElementById('dt-create').onclick = () => this.confirmDetail();
  }

  showDetail(preset) {
    const w = preset ? preset.w : 2480;
    const h = preset ? preset.h : 3508;

    this.dName.value = '未命名';
    this.dW.value = w;
    this.dH.value = h;

    // 预设名带 dpi 就沿用（A4 · 300dpi），否则按边长猜一个合理的
    const m = preset && /(\d+)\s*dpi/i.exec(preset.name);
    this.dDpi.value = m ? Number(m[1]) : (Math.max(w, h) >= 2000 ? 300 : 150);

    this.dBg.value = 'white';
    this.setOrientation(h >= w ? 'portrait' : 'landscape');

    this.viewList.hidden = true;
    this.viewDetail.hidden = false;
    this.refreshDetail();
    this.dName.focus();
    this.dName.select();
  }

  backToList() {
    this.viewDetail.hidden = true;
    this.viewList.hidden = false;
  }

  setOrientation(dir) {
    const w = this.clamp(this.dW.value, 64, 12000);
    const h = this.clamp(this.dH.value, 64, 12000);
    const wantLandscape = dir === 'landscape';
    const isLandscape = w > h;
    // 只在需要时交换，避免把用户自己输的方形来回翻
    if (w !== h && wantLandscape !== isLandscape) {
      this.dW.value = h;
      this.dH.value = w;
    }
    this.dPortrait.classList.toggle('on', dir === 'portrait');
    this.dLandscape.classList.toggle('on', dir === 'landscape');
    this.refreshDetail();
  }

  refreshDetail() {
    const w = this.clamp(this.dW.value, 64, 12000);
    const h = this.clamp(this.dH.value, 64, 12000);
    const dpi = this.clamp(this.dDpi.value, 1, 1200);
    const bg = this.dBg.value;

    const mem = memMB(w, h);
    const mp = (w * h / 1e6).toFixed(1);

    this.dInfo.textContent =
      `${w} × ${h} px · RGB · 8 位 · ${mp} MP · 约 ${mem} MB`
      + (bg === 'transparent' ? ' · 透明底' : '');
    this.dInfo.style.color = mem > 300 ? '#d99a4e' : '';

    // 物理尺寸，按 dpi 换算 —— 打印前最实用的一行
    const mmW = (w / dpi) * 25.4;
    const mmH = (h / dpi) * 25.4;
    this.dPhysical.textContent =
      `${(mmW / 10).toFixed(1)} × ${(mmH / 10).toFixed(1)} cm @ ${dpi} ppi`
      + (mem > 300 ? '　（8GB，偏大）' : '');

    // 方向按钮跟着宽高走
    if (w > h) {
      this.dPortrait.classList.remove('on');
      this.dLandscape.classList.add('on');
    } else if (h > w) {
      this.dLandscape.classList.remove('on');
      this.dPortrait.classList.add('on');
    }
  }

  confirmDetail() {
    const w = this.clamp(this.dW.value, 64, 12000);
    const h = this.clamp(this.dH.value, 64, 12000);
    const name = (this.dName.value || '').trim() || '未命名';
    this.hide();
    this.onPick(w, h, {
      name,
      dpi: this.clamp(this.dDpi.value, 1, 1200),
      background: this.dBg.value,
    });
  }

  /* ---------- 最近 ---------- */

  refreshRecent() {
    const list = readRecent();
    this.recentEl.innerHTML = '';

    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'splash-empty';
      empty.textContent = '还没有打开过文件';
      this.recentEl.appendChild(empty);
    } else {
      for (const item of list) {
        const row = document.createElement('div');
        row.className = 'splash-recent-item';

        const main = document.createElement('button');
        main.className = 'ri-main';
        main.innerHTML = `
          <span class="ri-name">${escapeHtml(item.name)}</span>
          <span class="ri-meta">${item.w && item.h ? item.w + ' × ' + item.h : ''}${
            item.w && item.h ? ' · ' : ''}${timeAgo(item.time)}</span>`;

        if (this.canOpenRecent && item.path) {
          main.title = item.path;
          main.onclick = () => this.onOpenRecent(item);
        } else {
          main.disabled = true;
          main.title = '浏览器里拿不到文件路径，请用「打开文件…」';
        }

        const del = document.createElement('button');
        del.className = 'ri-del';
        del.title = '从最近里移除';
        del.innerHTML = '×';
        del.onclick = ev => {
          ev.stopPropagation();
          this.askRemove(item, row);
        };

        row.appendChild(main);
        row.appendChild(del);
        this.recentEl.appendChild(row);
      }
    }

    this.note.textContent = this.canOpenRecent
      ? '最近列表只记路径，文件被移走就点不开了'
      : '浏览器版不能按路径重开，用「打开文件…」选一次';
  }

  /* 移除确认：先只删记录，再问要不要连源文件一起删 */
  askRemove(item, row) {
    const hasFile = this.canOpenRecent && item.path;
    row.classList.add('confirming');
    row.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'ri-confirm';
    bar.innerHTML = `<span>移除这条记录？</span>`;

    const keep = document.createElement('button');
    keep.textContent = '仅移除记录';
    keep.onclick = ev => { ev.stopPropagation(); this.onRemoveRecent(item, false); };

    bar.appendChild(keep);

    if (hasFile) {
      const wipe = document.createElement('button');
      wipe.className = 'danger';
      wipe.textContent = '连文件一起删';
      wipe.onclick = ev => { ev.stopPropagation(); this.onRemoveRecent(item, true); };
      bar.appendChild(wipe);
    }

    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = ev => { ev.stopPropagation(); this.refreshRecent(); };
    bar.appendChild(cancel);

    row.appendChild(bar);
  }

  /* ---------- 通用 ---------- */

  clamp(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  get hidden() { return this.el.hasAttribute('hidden'); }
  show() { this.el.removeAttribute('hidden'); }
  hide() { this.el.setAttribute('hidden', ''); }

  dismiss() {
    this.hide();
    this.onPick(this.defaultSize.w, this.defaultSize.h, { name: '未命名', background: 'white' });
  }

  destroy() {
    window.removeEventListener('keydown', this._key);
  }
}

/* 从最近列表里去掉一条（只动 localStorage） */
export function removeRecent(item) {
  const list = readRecent().filter(x => !(x.path && item.path && x.path === item.path)
    && !(!item.path && x.name === item.name && x.time === item.time));
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* 忽略 */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
