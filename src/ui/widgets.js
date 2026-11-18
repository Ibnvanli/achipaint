/* 界面控件：Blender 那一套
 *
 * 和浏览器原生 range 的区别就三点，但手感完全不同：
 *   1) 整条就是滑块 —— 按哪儿都能拖，不用先瞄准那个小圆头
 *   2) 数值压在条上，拖的时候眼睛不用在两个地方来回看
 *   3) 滚轮、方向键、双击输入数字都能改
 *
 * 填充宽度用 --p，RGB 那类渐变条用 --grad（给了 gradient 就不画填充）。
 */

export class Slider {
  constructor(opts) {
    const {
      label = '',
      min = 0, max = 100, step = 1, value = 0,
      gradient = null,          // (v) => css 背景，给了就不画填充条
      onChange = null,
      format = v => Math.round(v),
      axis = 'x',               // 'y' = 竖条（明度那种），拖动走 clientY
    } = opts || {};

    this.min = min; this.max = max; this.step = step;
    this.gradient = gradient;
    this.format = format;
    this.onChange = onChange;
    this._value = this._quant(value);
    this._disabled = false;
    this._editing = false;
    this.axis = axis;

    const el = document.createElement('div');
    el.className = 'bslider' + (gradient ? ' grad' : '') + (axis === 'y' ? ' vert' : '');
    el.tabIndex = 0;
    el.innerHTML = '<span class="bs-fill"></span><span class="bs-label"></span><span class="bs-num"></span>';
    this.el = el;
    this.fillEl = el.querySelector('.bs-fill');
    this.lblEl = el.querySelector('.bs-label');
    this.numEl = el.querySelector('.bs-num');
    this.lblEl.textContent = label;

    this._bind();
    this.render();
  }

  get value() { return this._value; }
  set value(v) { this._set(v, false); }

  get disabled() { return this._disabled; }
  set disabled(b) {
    this._disabled = !!b;
    this.el.classList.toggle('disabled', this._disabled);
    this.el.tabIndex = this._disabled ? -1 : 0;
  }

  _quant(v) {
    const s = this.step || 1;
    const q = Math.round(v / s) * s;
    return Math.min(this.max, Math.max(this.min, q));
  }

  _set(v, fire = true) {
    const q = this._quant(v);
    if (q === this._value) return;
    this._value = q;
    this.render();
    if (fire && this.onChange) this.onChange(q);
  }

  render() {
    if (this._editing) return;          // 正在手打数字，别把输入框冲掉
    const span = (this.max - this.min) || 1;
    const p = ((this._value - this.min) / span) * 100;
    this.el.style.setProperty('--p', p.toFixed(2) + '%');
    this.numEl.textContent = this.format(this._value);
    if (this.gradient) this.el.style.setProperty('--grad', this.gradient(this._value));
    else this.el.style.removeProperty('--grad');
  }

  _bind() {
    const el = this.el;
    let dragging = false, x0 = 0, v0 = 0, w = 1, pid = null;

    const vertical = this.axis === 'y';

    el.addEventListener('pointerdown', e => {
      if (this._disabled || this._editing) return;
      // 双击数字进编辑模式，那两下的 pointerdown 不该当作拖动
      if (e.target === this.numEl && e.detail > 1) return;
      el.focus();
      pid = e.pointerId;
      try { el.setPointerCapture(pid); } catch { /* 老浏览器 */ }
      dragging = true;
      const rect = el.getBoundingClientRect();
      if (vertical) { x0 = e.clientY; w = rect.height || 1; }
      else { x0 = e.clientX; w = rect.width || 1; }
      v0 = this._value;
      el.classList.add('active');
    });

    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      const k = e.shiftKey ? 0.15 : 1;    // Shift 精调
      // 竖条往上拖是变大，所以 clientY 的增量要反号
      const delta = vertical ? (x0 - e.clientY) : (e.clientX - x0);
      this._set(v0 + (delta / w) * (this.max - this.min) * k);
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('active');
      if (pid !== null) { try { el.releasePointerCapture(pid); } catch { /* 已释放 */ } pid = null; }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);

    el.addEventListener('wheel', e => {
      if (this._disabled) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const k = e.shiftKey ? 0.1 : ((e.ctrlKey || e.metaKey) ? 10 : 1);
      this._set(this._value + dir * this.step * k);
    }, { passive: false });

    el.addEventListener('keydown', e => {
      if (this._disabled || this._editing) return;
      const k = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); this._set(this._value + this.step * k); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); this._set(this._value - this.step * k); }
    });

    this.numEl.addEventListener('dblclick', e => {
      if (this._disabled) return;
      e.stopPropagation();
      this._editInline();
    });
  }

  /* 双击数字直接打，Blender 里也是这样 */
  _editInline() {
    if (this._editing) return;
    this._editing = true;
    const num = this.numEl;
    const inp = document.createElement('input');
    inp.className = 'bs-edit';
    inp.value = String(this._value);
    num.textContent = '';
    num.appendChild(inp);

    const finish = commit => {
      if (!this._editing) return;
      this._editing = false;
      const raw = Number(inp.value);
      inp.remove();
      if (commit && Number.isFinite(raw)) {
        const q = this._quant(raw);
        this._value = q;
        if (this.onChange) this.onChange(q);
      }
      this.render();
      this.el.focus();
    };

    inp.addEventListener('pointerdown', e => e.stopPropagation());
    inp.addEventListener('dblclick', e => e.stopPropagation());
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });

    inp.focus();
    inp.select();
  }
}
