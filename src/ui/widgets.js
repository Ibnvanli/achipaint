/* 界面控件：Blender 风格
 *
 * 与浏览器原生 range 的差异有三点，操作手感差异明显：
 *   1) 整条即为滑块 —— 任意位置均可拖动，无需先对准滑块圆头
 *   2) 数值内嵌于滑块上，拖动时视线无需在两处之间切换
 *   3) 滚轮、方向键与双击输入均可调整数值
 *
 * 填充宽度使用 --p；RGB 等渐变条使用 --grad（提供 gradient 时不绘制填充）。
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
      // 双击数值进入编辑模式，该次 pointerdown 不应被视为拖动
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
      // 竖向滑块向上拖动为增大，因此 clientY 增量需取反
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

  /* 双击数值可直接输入，与 Blender 行为一致 */
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
