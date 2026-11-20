/* 核心：hokusai 笔刷引擎的适配层
 *
 * 需要中间适配层的原因：
 *   1) hokusai 的 `pixels()` 为「整张画布压白底」输出 —— 无 alpha、单次 34MB（A4@300dpi），
 *      既无法作为图层，也无法逐帧调用。因此改用 `drainDirty()`：增量输出、按 64×64 块、
 *      直通 alpha、已裁剪到画布内。
 *   2) 单笔过程中 hokusai 的 surface 持续累加（其内部已完成 alpha 归一化）。
 *      若每个事件都向图层执行一次 source-over，重叠处会被反复叠加而变黑。
 *      因此这一笔先落在 doc.overlay（临时覆盖层），松手时**只压入一次**图层。
 *   3) 撤销仍由 history 负责：overlay 每次扩大即通知 onRegion 扩拍，
 *      在压入图层之前相关像素已拍摄完毕。
 *
 * 手感：Achi 自身的稳定器保留在这一层，hokusai 的 slow_tracking 仍然生效。
 */
import init, { HokusaiCanvas, HokusaiBrush } from '../wasm/hokusai.js';
import { Stabilizer } from './brush.js';

/* hex → HSV，其中 V 与 RGB 走**线性**空间。
 *
 * 不可直接使用 sRGB 的原因：hokusai（与 libmypaint 一致）将 HSV 作为线性色处理，
 * hsv_to_rgb 的输出直接乘入 fix15 表面；出口处才执行 linear_to_srgb。
 * 因此入口需先 srgb→linear，出口再 linear→srgb，两端转换后才能保持颜色准确。
 * 若直接传入 sRGB 值，选中 #e8eaf0 将绘制为 #f5f6f8，整体偏淡。
 */
export function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, v: 0.1 };
  const n = parseInt(m[1], 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s: max > 1e-6 ? d / max : 0, v: max };
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/* .myb 中的曲线：[[输入, 输出], ...]，采用线性插值。 */
function curveValue(points, x) {
  if (!points || !points.length) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      const k = (x - x0) / ((x1 - x0) || 1);
      return y0 + (y1 - y0) * k;
    }
  }
  return points[points.length - 1][1];
}

export class HokusaiEngine {
  /** @param {import('./canvas.js').Doc} doc */
  constructor(doc) {
    this.doc = doc;
    this.ready = false;
    this.error = null;
    this.canvas = null;
    this.surfaceW = 0;
    this.surfaceH = 0;

    this.presets = new Map();     // name -> .myb JSON 文本
    this.brushes = new Map();     // name -> HokusaiBrush
    this.radiusBias = new Map();  // name -> 半径曲线在满压力处的偏移
    this.name = null;             // 当前预设
    this.current = null;

    this.stab = null;
    this.lastT = 0;
    this.startX = 0; this.startY = 0;
    this.lastX = 0; this.lastY = 0;
    this.lastPressure = 0.5;
    this.moved = false;
    this.radiusPx = 40;
    this.opacity = 1;             // 本笔不透明度，begin() 中会被实际值覆盖
    this.active = false;
    this.onRegion = null;         // (x0,y0,x1,y1) => void
    this.paintedTiles = 0;        // 统计用
    /* 最近若干次压力的环形缓冲。抬笔时稳定器的滞后位移会一次性补画，
     * 若用最后一个压力（常常是抬笔前的峰值），那一整段就会突然变粗，
     * 形成末端的大圆点。用中位数补画，单个尖峰影响不到结果。 */
    this._pBuf = [];
    this._pBufLen = 0;
    /* 本笔是否真的落下过 dab。由 wasm 的 strokeTo 返回值累积，
     * 不能用 paintedTiles 判断 —— 后者靠每帧 pump() 累加，快速笔画
     * 可能一次都没 pump 到，于是被误判成「什么都没画」，
     * 抬笔时补画一个点，用的还是抬笔瞬间的压力。 */
    this._dabbed = false;
  }

  /* 载入 wasm 与预设。失败时不抛出，记录于 this.error，主程序回退至旧引擎。 */
  async load(presets) {
    try {
      await init();
      for (const [name, json] of Object.entries(presets)) {
        this.presets.set(name, json);
      }
      this.name = this.presets.keys().next().value || null;
      this.ready = true;
    } catch (e) {
      this.error = e;
      this.ready = false;
      console.error('[hokusai] 载入失败，退回内置笔刷引擎：', e);
    }
    return this.ready;
  }

  /* 释放 wasm 侧持有的资源。
   * 审计结论（audit/2026-11-20-audit.md 第 1.3 节）：原先只有 ensureSurface 内的
   * 重建路径，类上没有销毁接口，切换文档时仅置空 JS 侧引用，
   * wasm 内存依赖 FinalizationRegistry 回收，时机不可控。
   *
   * 此方法可重复调用；释放后引擎回到「未就绪」状态，需重新 load 才能使用。 */
  dispose() {
    if (this.canvas) {
      try { this.canvas.free(); } catch { /* 已释放 */ }
      this.canvas = null;
    }
    for (const b of this.brushes.values()) {
      try { b.free(); } catch { /* 已释放 */ }
    }
    this.brushes.clear();
    this.current = null;
    this.currentKey = null;
    this.surfaceW = 0;
    this.surfaceH = 0;
    this.active = false;
    this.doc = null;
  }

  /* 画布尺寸变化时必须重建（hokusai 的 canvas 尺寸不可变） */
  ensureSurface(w, h) {
    if (this.canvas && this.surfaceW === w && this.surfaceH === h) return;
    if (this.canvas) { try { this.canvas.free(); } catch { /* 已释放 */ } }
    this.canvas = new HokusaiCanvas(w, h);
    this.surfaceW = w;
    this.surfaceH = h;
    for (const b of this.brushes.values()) { try { b.free(); } catch { /* 已释放 */ } }
    this.brushes.clear();
    this.current = null;
  }

  /* 获取（必要时构造并缓存）指定预设的笔刷对象。
   * 颜色与半径在每次落笔时会被改写 —— 每个预设只应有一个实例。 */
  brushFor(name) {
    const key = this.presets.has(name) ? name : this.name;
    this.currentKey = key;
    if (!key) return null;
    let b = this.brushes.get(key);
    if (!b) {
      const json = this.presets.get(key);
      if (!json) return null;
      try {
        b = new HokusaiBrush(json);
      } catch (e) {
        console.error('[hokusai] 预设解析失败：' + key, e);
        return null;
      }
      this.brushes.set(key, b);
    }
    return b;
  }

  /* ---------- 单笔 ---------- */

  begin(x, y, pressure, opts = {}) {
    if (!this.ready) return false;
    this.ensureSurface(this.doc.w, this.doc.h);

    const b = this.brushFor(opts.preset || this.name);
    if (!b) return false;
    this.current = b;

    // 半径取直径的一半。注意 libmypaint 的 radius_logarithmic 单位为 **ln(像素)**，
    // hokusai 内部使用 `setting.exp()`，而非 exp2。
    // 原实现按 log2 计算，导致 40px 半径被当作 exp(5.32) ≈ 204px，笔迹覆盖大幅超出预期。
    this.radiusPx = Math.max(0.5, (opts.size || 80) / 2);
    b.setRadiusLog(this.radiusBaseFor(this.currentKey) + Math.log(this.radiusPx));

    const { h, s, v } = hexToHsv(opts.color || '#000000');
    b.setColorHsv(h, s, v);

    // 每笔使用一个临时 surface，避免上一笔的内容残留
    this.canvas.clear();
    this.doc.overlay.clear();
    this.doc.overlayActive = true;

    /* 必须先确定本笔的不透明度，再写入 overlayAlpha。
     * 原实现顺序相反，导致首帧以 100% 绘制，松手后才变为设定值
     * （审计结论 audit/2026-11-20-audit.md 第 2.5 节）。 */
    this.opacity = opts.opacity ?? 1;
    this.doc.overlayAlpha = this.opacity;

    this.stab = new Stabilizer(opts.stabilize ?? 0.12);
    this.lastT = performance.now() / 1000;
    this.startX = this.lastX = x;
    this.startY = this.lastY = y;
    this.lastPressure = pressure;
    this.moved = false;
    this.active = true;
    this.paintedTiles = 0;
    this._dabbed = false;
    this._pBuf = [pressure];
    this._pBufLen = 1;

    /* 首次 strokeTo 仅播种状态，不落笔（libmypaint 的行为）。
     *
     * 但播种用的压力会被 libmypaint 记入笔刷状态，影响紧随其后的第一个 dab。
     * 落笔瞬间的压力是读数毛刺（笔尖刚接触板面时偏高），若照实播种，
     * 第一个 dab 就会按峰值画成一个比线身粗一倍的圆点。
     *
     * 因此播种时压住压力：取 0.25 与落笔值的较小者。
     * 0.25 相当于「轻触」，画出的第一个 dab 不会比线身更粗；
     * 后续 move 会立刻带回真实压力，不影响整笔的压感表现。 */
    const seedPressure = Math.min(pressure, 0.25);
    const p = this.stab.push(x, y);
    this.canvas.strokeTo(b, p.x, p.y, seedPressure, opts.tiltX || 0, opts.tiltY || 0, 0.0001);
    this.pump();
    return true;
  }

  move(x, y, pressure, opts = {}) {
    if (!this.active) return;
    const p = this.stab.push(x, y);

    const now = performance.now() / 1000;
    let dt = now - this.lastT;
    if (!(dt > 0)) dt = 0.0001;
    // 停顿过久后再次移动时，避免 libmypaint 以过大的 dtime 计算速度
    if (dt > 0.1) dt = 0.1;
    this.lastT = now;

    if (Math.hypot(x - this.startX, y - this.startY) > 1.5) this.moved = true;
    this.lastX = x; this.lastY = y; this.lastPressure = pressure;

    /* 记入环形缓冲（保留最近 5 个） */
    if (this._pBuf.length < 5) this._pBuf.push(pressure);
    else { this._pBuf[this._pBufLen % 5] = pressure; }
    this._pBufLen++;

    if (this.canvas.strokeTo(this.current, p.x, p.y, pressure,
      opts.tiltX || 0, opts.tiltY || 0, dt)) this._dabbed = true;
    // 此处**不**执行 pump：一个 pointermove 内可能包含十余个合并事件，
    // 若每个都搬运块并通知撤销层，将产生数十倍冗余开销。
    // 应由调用方在处理完一批事件后再调用一次 flush()。
  }

  /* 将累积的脏块一次性搬运至覆盖层 */
  flush() {
    if (!this.active) return;
    this.pump();
  }

  end() {
    if (!this.active) return;
    this.active = false;

    /* 先把稳定器积压的位移补完，再冲刷 slow_tracking 尾巴。
     *
     * 稳定器会让落笔点滞后于笔尖，抬笔时这段滞后会一次补画。若直接用
     * 最后一个压力（抬笔前常见峰值）补画，末端会突然鼓成一个圆点。
     * 这里用近期压力均值补到真实笔尖位置，粗细才与线身连贯。 */
    if (this.moved) {
      const sorted = [...this._pBuf].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      this.canvas.strokeTo(this.current, this.lastX, this.lastY, median,
        0, 0, 0.016);
    }

    if (this.canvas.finishStroke(this.current)) this._dabbed = true;
    this.pump();

    // 单次点击也应产生一个点。多数 .myb 按「走过的距离」采样，
    // 指针不动时不会落任何点；dabs_per_second 为 0 的笔刷则完全无响应。
    //
    // 这里的位移只用于「让按距离采样的笔刷认为走过了一小步」，越小越好。
    // 曾用 r * 0.55（半径的 55%），半径 40px 时点的中心会偏出点击位置 22px ——
    // 表现为落笔处莫名多出一个偏离笔尖的墨点。
    //
    // 判据用 _dabbed（wasm 如实回报是否落过 dab），不再是 paintedTiles。
    // paintedTiles 靠 pump() 累加，快速笔画可能一次都没 pump 到，会误判成
    // 「什么都没画」，于是抬笔时补一个点 —— 用当时的压力，压力高就是一个大圆。
    if (!this._dabbed) {
      const nudge = Math.min(1, this.radiusPx * 0.02);
      /* 这里用 lastPressure：真单击时它就是用户按下的力度，应当如实反映。
       * 抬笔压力偏高只在「已经画了东西」的情况下才是干扰，
       * 那种情况走的是上面的滞后补画，判据不同。 */
      this.canvas.strokeTo(this.current, this.lastX + nudge, this.lastY,
        this.lastPressure, 0, 0, 0.016);
      this.canvas.finishStroke(this.current);
      this.pump();
    }

    this.canvas.resetStroke();

    // 松手：将整笔一次性压入图层。
    // 压入的是「一次性合成」的最终值，因此重叠处不会叠加变黑。
    const layer = this.doc.paintTarget || this.doc.layer.canvas;
    const sel = this.doc.selection;
    const ov = this.doc.overlay;
    for (const o of ov.values()) {
      layer.forEachTileInBounds(o.x, o.y, o.x + o.w, o.y + o.h, ctx => {
        if (sel) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(sel.x0, sel.y0, sel.x1 - sel.x0, sel.y1 - sel.y0);
          ctx.clip();
        }
        // 整笔一次性压入图层，alpha 才等于「这一笔的不透明度」；
        // 逐事件压入则等同于「每个事件各叠加一次」，越画越实。
        ctx.globalAlpha = this.opacity;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(o.canvas, o.x, o.y, o.w, o.h);
        if (sel) ctx.restore();
      });
      layer.markDirty(o.x, o.y, o.x + o.w, o.y + o.h);
    }
    ov.clear();
    this.doc.overlayActive = false;
    this.doc.overlayAlpha = 1;

    this.canvas.clear();
    this.current = null;
    this.stab = null;
  }

  /* 将 drainDirty 输出的块写入覆盖层 */
  pump() {
    const buf = this.canvas.drainDirty();
    if (!buf || buf.length === 0) return;

    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = dv.getUint32(0, true);
    if (n === 0) return;
    const ES = 24;
    const ts = this.canvas.tileSize();
    const stride = buf.byteLength;
    let off = 4 + n * ES;

    // 单个事件可能扫过数十块。撤销层按「矩形」拍摄，
    // 逐块通知会使 grabRegion 反复执行 O(面积) 的合并 —— 此前 20 秒的耗时即源于此。
    // 因此先合并出包围盒，最后仅通知一次。
    let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;

    for (let i = 0; i < n; i++) {
      const hb = 4 + i * ES;
      const tx = dv.getInt32(hb, true);
      const ty = dv.getInt32(hb + 4, true);
      const x0 = dv.getUint32(hb + 8, true);
      const y0 = dv.getUint32(hb + 12, true);
      const x1 = dv.getUint32(hb + 16, true);
      const y1 = dv.getUint32(hb + 20, true);
      const w = x1 - x0, h = y1 - y0;
      const bytes = w * h * 4;
      if (bytes <= 0 || off + bytes > stride) continue;

      const key = tx + ',' + ty;
      let o = this.doc.overlay.get(key);
      if (!o) {
        const cv = document.createElement('canvas');
        cv.width = ts; cv.height = ts;
        o = { canvas: cv, ctx: cv.getContext('2d'), x: tx * ts, y: ty * ts, w: ts, h: ts };
        this.doc.overlay.set(key, o);
      }

      const img = new ImageData(
        new Uint8ClampedArray(buf.buffer, buf.byteOffset + off, bytes), w, h);
      o.ctx.putImageData(img, x0 - tx * ts, y0 - ty * ts);
      off += bytes;

      if (x0 < ux0) ux0 = x0;
      if (y0 < uy0) uy0 = y0;
      if (x1 > ux1) ux1 = x1;
      if (y1 > uy1) uy1 = y1;
      this.paintedTiles++;
    }

    if (ux1 <= ux0 || uy1 <= uy0) return;
    // 撤销：该批次在压入图层之前先行拍摄
    if (this.onRegion) this.onRegion(ux0, uy0, ux1, uy1);
    this.doc.markRegionDirty(ux0, uy0, ux1, uy1);
  }

  /* 尺寸滑块对应「满压力时的半径」。.myb 的 radius_logarithmic 常带一条
   * 压力曲线，且该曲线**叠加**在 base_value 之上（base + curve(p)）。
   * 仅修改 base_value 无效：brush.myb 在 p=0.85 时会额外增加 +1.6，
   * 40px 半径会直接变为 200px。
   * 因此先减去曲线在 p=1 处的偏移量，滑块才能等同于笔尖尺寸，
   * 同时保留压力响应。
   * 返回值为「抵消量」，使用前需加上 ln(半径)。
   */
  radiusBaseFor(key) {
    let bias = this.radiusBias.get(key);
    if (bias !== undefined) return bias;
    bias = 0;
    try {
      const doc = JSON.parse(this.presets.get(key));
      const rl = doc && doc.settings && doc.settings.radius_logarithmic;
      const pts = rl && rl.inputs && rl.inputs.pressure;
      if (pts && pts.length) bias = -curveValue(pts, 1.0);
    } catch { /* JSON 坏了就用 0 */ }
    this.radiusBias.set(key, bias);
    return bias;
  }

  /* 切换预设 —— 供 UI 调用 */
  setPreset(name) {
    if (!this.presets.has(name)) return false;
    this.name = name;
    return true;
  }

  get presetNames() { return [...this.presets.keys()]; }
}
