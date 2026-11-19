/* 启动浮层：选画布尺寸，然后收起，直接开始画 */

export const PRESETS = [
  { name: 'A4 · 300dpi', w: 2480, h: 3508, note: '印刷尺寸' },
  { name: 'A4 · 150dpi', w: 1240, h: 1754, note: '省一半内存' },
  { name: 'A5 · 300dpi', w: 1748, h: 2480, note: '速写' },
  { name: '正方形', w: 2000, h: 2000, note: '头像 / 社交' },
  { name: '屏幕', w: 1920, h: 1080, note: '横版' },
  { name: 'A3 · 300dpi', w: 3508, h: 4961, note: '大字海报' },
];

/* 合成缓冲是 w*h*4，加上瓦片乘个系数 —— 对 8GB 机器这个数字比"多少像素"有用 */
export function memMB(w, h) {
  return Math.round(((w * h * 4) / 1048576) * 2.2);
}

export class Splash {
  /**
   * @param {object} opts
   * @param {(w:number,h:number)=>void} opts.onPick  选定尺寸
   * @param {{w:number,h:number}} opts.defaultSize   直接关掉时用的尺寸
   */
  constructor(opts) {
    this.el = document.getElementById('splash');
    this.grid = document.getElementById('splash-presets');
    this.hint = document.getElementById('splash-hint');
    this.inputW = document.getElementById('splash-w');
    this.inputH = document.getElementById('splash-h');
    this.onPick = opts.onPick;
    this.defaultSize = opts.defaultSize;

    this.build();
    this.bind();
  }

  build() {
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

  bind() {
    const onInput = () => this.updateHint();
    this.inputW.addEventListener('input', onInput);
    this.inputH.addEventListener('input', onInput);

    document.getElementById('splash-create').onclick = () => {
      this.pick(this.clamp(this.inputW.value, 64, 12000),
                this.clamp(this.inputH.value, 64, 12000));
    };

    // Esc = 直接关掉，用默认尺寸
    this._key = e => {
      if (e.key === 'Escape' && !this.hidden) {
        e.preventDefault();
        this.dismiss();
      }
    };
    window.addEventListener('keydown', this._key);

    // 点浮层外面也关
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

  show() {
    this.el.removeAttribute('hidden');
  }

  hide() {
    this.el.setAttribute('hidden', '');
  }

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
