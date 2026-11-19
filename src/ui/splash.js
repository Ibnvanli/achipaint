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
   * @param {(w:number,h:number)=>void} opts.onPick
   * @param {()=>void} opts.onOpen          点「打开文件…」
   * @param {(entry:object)=>void} opts.onOpenRecent  点最近记录
   * @param {{w:number,h:number}} opts.defaultSize
   * @param {boolean} opts.canOpenRecent    这个环境能不能按路径重开
   */
  constructor(opts) {
    this.el = document.getElementById('splash');
    this.grid = document.getElementById('splash-presets');
    this.recentEl = document.getElementById('splash-recent');
    this.hint = document.getElementById('splash-hint');
    this.note = document.getElementById('splash-note');
    this.inputW = document.getElementById('splash-w');
    this.inputH = document.getElementById('splash-h');
    this.onPick = opts.onPick;
    this.onOpen = opts.onOpen || (() => {});
    this.onOpenRecent = opts.onOpenRecent || (() => {});
    this.defaultSize = opts.defaultSize;
    this.canOpenRecent = !!opts.canOpenRecent;

    this.buildPresets();
    this.bind();
    this.refreshRecent();
  }

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
      b.onclick = () => this.pick(p.w, p.h);
      this.grid.appendChild(b);
    }
    this.inputW.value = this.defaultSize.w;
    this.inputH.value = this.defaultSize.h;
    this.updateHint();
  }

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
        const b = document.createElement('button');
        b.className = 'splash-recent-item';
        b.innerHTML = `
          <span class="ri-name">${escapeHtml(item.name)}</span>
          <span class="ri-meta">${item.w && item.h ? item.w + ' × ' + item.h : ''}${
            item.w && item.h ? ' · ' : ''}${timeAgo(item.time)}</span>`;
        if (this.canOpenRecent && item.path) {
          b.title = item.path;
          b.onclick = () => this.onOpenRecent(item);
        } else {
          b.disabled = true;
          b.title = '浏览器里拿不到文件路径，请用右下角「打开文件…」';
        }
        this.recentEl.appendChild(b);
      }
    }

    this.note.textContent = this.canOpenRecent
      ? '最近列表只记路径，文件被移走就点不开了'
      : '浏览器版不能按路径重开，用「打开文件…」选一次';
  }

  bind() {
    const onInput = () => this.updateHint();
    this.inputW.addEventListener('input', onInput);
    this.inputH.addEventListener('input', onInput);

    document.getElementById('splash-create').onclick = () => {
      this.pick(this.clamp(this.inputW.value, 64, 12000),
                this.clamp(this.inputH.value, 64, 12000));
    };

    document.getElementById('splash-open').onclick = () => this.onOpen();

    this._key = e => {
      if (e.key === 'Escape' && !this.hidden) {
        e.preventDefault();
        this.dismiss();
      }
    };
    window.addEventListener('keydown', this._key);

    this.el.addEventListener('pointerdown', e => {
      if (e.target === this.el) this.dismiss();
    });
  }

  clamp(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  updateHint() {
    const w = this.clamp(this.inputW.value, 64, 12000);
    const h = this.clamp(this.inputH.value, 64, 12000);
    const mem = memMB(w, h);
    const px = (w * h / 1e6).toFixed(1);
    this.hint.textContent = `${px} 百万像素 · 约 ${mem} MB 内存`
      + (mem > 300 ? '　（这台机器 8GB，偏大了）' : '');
    this.hint.style.color = mem > 300 ? '#d99a4e' : '';
  }

  get hidden() { return this.el.hasAttribute('hidden'); }
  show() { this.el.removeAttribute('hidden'); }
  hide() { this.el.setAttribute('hidden', ''); }

  pick(w, h) {
    this.hide();
    this.onPick(w, h);
  }

  dismiss() {
    this.pick(this.defaultSize.w, this.defaultSize.h);
  }

  destroy() {
    window.removeEventListener('keydown', this._key);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
