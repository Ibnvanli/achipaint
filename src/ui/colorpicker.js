/* 取色器：照 Blender 那个弹窗做的
 *
 * 上面是色轮（色相绕一圈 / 饱和度走半径），右边一条明度竖条，
 * 中间 RGB / HSV 切换，下面三根通道条。
 *
 * 两个实现上的选择：
 *   1) 色轮只在启动时画一次（V=1 的盘），明度靠盖一层黑色圆形上去，
 *      透明度 = 1-V。等价于整体乘 V，但不用每次改明度重画 11 万像素。
 *   2) 色相角度按 Blender 摆：红在下、青在上、品红在右下、黄在左下。
 *      θ = -(h + 90)，屏幕 y 向下，所以位置是 (cos θ, -sin θ)。
 */
import { Slider } from './widgets.js';

/* ---------- 颜色换算（都是 sRGB 0..255 / HSV h 0..360 s,v 0..1） ---------- */

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: max > 1e-9 ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const rgbCss = (r, g, b) => `rgb(${r},${g},${b})`;

function hueGradient(s, v) {
  const stops = [];
  for (let i = 0; i <= 6; i++) {
    const [r, g, b] = hsvToRgb(i * 60, s || 1, v || 1);
    stops.push(rgbCss(r, g, b));
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

function satGradient(h, v) {
  const a = hsvToRgb(h, 0, v || 1);
  const b = hsvToRgb(h, 1, v || 1);
  return `linear-gradient(to right, ${rgbCss(...a)}, ${rgbCss(...b)})`;
}

function valGradient(h, s) {
  const b = hsvToRgb(h, s, 1);
  return `linear-gradient(to right, #000, ${rgbCss(...b)})`;
}

/* ---------- 组件 ---------- */

export class ColorPicker {
  constructor({ host, value = '#ffffff', onChange = null, size = 172 }) {
    this.onChange = onChange;
    this.size = size;
    this.mode = 'rgb';

    const rgb0 = hexToRgb(value) || { r: 255, g: 255, b: 255 };
    const hsv0 = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);
    this.h = hsv0.h; this.s = hsv0.s; this.v = hsv0.v;
    this.bars = null;

    const el = document.createElement('div');
    el.className = 'cp';
    el.innerHTML = `
      <div class="cp-top">
        <div class="cp-wheel-wrap">
          <canvas class="cp-wheel"></canvas>
          <div class="cp-dim"></div>
          <div class="cp-cursor"></div>
        </div>
        <div class="cp-vbar-wrap"></div>
      </div>
      <div class="cp-mode">
        <button type="button" data-mode="rgb" class="on">RGB</button>
        <button type="button" data-mode="hsv">HSV</button>
      </div>
      <div class="cp-bars"></div>`;
    host.innerHTML = '';
    host.appendChild(el);
    this.el = el;

    this.wheel = el.querySelector('.cp-wheel');
    this.dim = el.querySelector('.cp-dim');
    this.cursor = el.querySelector('.cp-cursor');
    this.barsEl = el.querySelector('.cp-bars');

    const px = Math.round(size * 2);
    this.wheel.width = px;
    this.wheel.height = px;
    this._drawWheel();

    this.vbar = new Slider({
      label: '',
      min: 0, max: 100, step: 1,
      value: Math.round(this.v * 100),
      axis: 'y',
      gradient: () => {
        const top = hsvToRgb(this.h, this.s, 1);
        return `linear-gradient(to top, #000, ${rgbCss(...top)})`;
      },
      onChange: val => { this.v = val / 100; this._changed(); },
    });
    this.vbar.el.classList.add('cp-v');
    el.querySelector('.cp-vbar-wrap').appendChild(this.vbar.el);

    this._bindWheel();
    this._bindMode();
    this._buildBars();
    this._render();
  }

  hex() {
    const [r, g, b] = hsvToRgb(this.h, this.s, this.v);
    return rgbToHex(r, g, b);
  }

  /* 外部设色（hex 输入、色板、吸色）走这里 */
  setValue(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    // 纯灰时色相没有意义，保留原来的，不然光标会跳到红
    if (hsv.s > 1e-6) this.h = hsv.h;
    this.s = hsv.s;
    this.v = hsv.v;
    this._render();
  }

  /* 侧栏拉宽/收窄时叫一次。色轮按 2 倍像素重画，别让它糊。 */
  resize(size) {
    const px = Math.round(size);
    if (px === this.size) return;
    this.size = px;
    this.wheel.width = px * 2;
    this.wheel.height = px * 2;
    const wrap = this.el.querySelector('.cp-wheel-wrap');
    wrap.style.width = px + 'px';
    wrap.style.height = px + 'px';
    this.el.querySelector('.cp-vbar-wrap').style.height = px + 'px';
    this._drawWheel();
    this._render();
  }

  _changed() {
    this._render();
    if (this.onChange) this.onChange(this.hex());
  }

  /* V=1 的色盘只画一次；明度靠 .cp-dim 那层黑圆叠上去 */
  _drawWheel() {
    const c = this.wheel;
    const N = c.width;
    const ctx = c.getContext('2d');
    const R = N / 2;
    const img = ctx.createImageData(N, N);
    const d = img.data;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - R;
        const dy = y + 0.5 - R;
        const rad = Math.sqrt(dx * dx + dy * dy);
        const i = (y * N + x) * 4;
        if (rad > R) { d[i + 3] = 0; continue; }

        const th = Math.atan2(-dy, dx) * 180 / Math.PI;
        let h = -(th + 90) % 360;
        if (h < 0) h += 360;
        const s = Math.min(1, rad / R);
        const [r, g, b] = hsvToRgb(h, s, 1);
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        // 边缘一像素做点抗锯齿，不然一圈锯齿很显眼
        d[i + 3] = rad > R - 1 ? Math.round((R - rad) * 255) : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  _bindWheel() {
    const wrap = this.el.querySelector('.cp-wheel-wrap');
    let dragging = false;

    const pick = e => {
      const r = wrap.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const R = r.width / 2;
      const rad = Math.sqrt(dx * dx + dy * dy);
      const th = Math.atan2(-dy, dx) * 180 / Math.PI;
      let h = -(th + 90) % 360;
      if (h < 0) h += 360;
      this.h = h;
      this.s = Math.min(1, rad / (R - 1));
      this._changed();
    };

    wrap.addEventListener('pointerdown', e => {
      dragging = true;
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      pick(e);
    });
    wrap.addEventListener('pointermove', e => { if (dragging) pick(e); });
    const end = e => {
      dragging = false;
      try { wrap.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
  }

  _bindMode() {
    this.el.querySelectorAll('.cp-mode button').forEach(btn => {
      btn.onclick = () => {
        const m = btn.dataset.mode;
        if (m === this.mode) return;
        this.mode = m;
        this.el.querySelectorAll('.cp-mode button')
          .forEach(b => b.classList.toggle('on', b === btn));
        this._buildBars();
      };
    });
  }

  _buildBars() {
    this.barsEl.innerHTML = '';
    this.bars = [];

    if (this.mode === 'rgb') {
      const defs = [
        { label: '红', ch: 0 },
        { label: '绿', ch: 1 },
        { label: '蓝', ch: 2 },
      ];
      for (const d of defs) {
        const s = new Slider({
          label: d.label, min: 0, max: 255, step: 1, value: 0,
          onChange: v => {
            const cur = hsvToRgb(this.h, this.s, this.v);
            cur[d.ch] = v;
            const hsv = rgbToHsv(cur[0], cur[1], cur[2]);
            if (hsv.s > 1e-6) this.h = hsv.h;
            this.s = hsv.s;
            this.v = hsv.v;
            this._changed();
          },
        });
        this.bars.push(s);
        this.barsEl.appendChild(s.el);
      }
    } else {
      const defs = [
        {
          label: '色相', min: 0, max: 360,
          gradient: () => hueGradient(this.s, this.v),
          get: () => Math.round(this.h),
          set: v => { this.h = v; },
        },
        {
          label: '饱和', min: 0, max: 100,
          gradient: () => satGradient(this.h, this.v),
          get: () => Math.round(this.s * 100),
          set: v => { this.s = v / 100; },
        },
        {
          label: '明度', min: 0, max: 100,
          gradient: () => valGradient(this.h, this.s),
          get: () => Math.round(this.v * 100),
          set: v => { this.v = v / 100; },
        },
      ];
      for (const d of defs) {
        const s = new Slider({
          label: d.label, min: d.min, max: d.max, step: 1,
          value: d.get(),
          gradient: d.gradient,
          onChange: v => { d.set(v); this._changed(); },
        });
        this.bars.push(s);
        this.barsEl.appendChild(s.el);
      }
    }
    this._render();
  }

  _render() {
    // 光标位置：屏幕 y 向下，所以纵向取 -sin
    const th = (-(this.h + 90)) * Math.PI / 180;
    const rad = this.s * 50;
    this.cursor.style.left = (50 + Math.cos(th) * rad).toFixed(2) + '%';
    this.cursor.style.top = (50 - Math.sin(th) * rad).toFixed(2) + '%';
    this.dim.style.opacity = String(1 - this.v);

    if (this.vbar) {
      this.vbar.value = Math.round(this.v * 100);
      this.vbar.render();
    }

    if (!this.bars) return;
    if (this.mode === 'rgb') {
      const [r, g, b] = hsvToRgb(this.h, this.s, this.v);
      const vals = [r, g, b];
      this.bars.forEach((s, i) => { s.value = vals[i]; s.render(); });
    } else {
      const vals = [Math.round(this.h), Math.round(this.s * 100), Math.round(this.v * 100)];
      this.bars.forEach((s, i) => { s.value = vals[i]; s.render(); });
    }
  }
}
