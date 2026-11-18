/* 核心：hokusai 笔刷引擎的适配层
 *
 * 为什么要在中间垫一层：
 *   1) hokusai 的 `pixels()` 是「整张画布压白底」—— 没 alpha、34MB/次（A4@300dpi），
 *      既不能当图层也不能逐帧用。所以走 `drainDirty()`：增量、按 64×64 块、
 *      直通 alpha、已经裁到画布内。
 *   2) 一笔的过程里，hokusai 的 surface 一直在累加（它自己的 alpha 归一化在里头），
 *      如果每个事件都往图层上 source-over 一次，重叠处会一遍遍叠黑。
 *      所以这一笔先落在 doc.overlay（一层临时覆盖），松手时**只压一次**到图层。
 *   3) 撤销仍然走 history：overlay 每次变大就通知 onRegion 扩拍，
 *      松手压图层之前那些像素已经拍好了。
 *
 * 手感：Achi 自己的稳定器留在这一层，hokusai 的 slow_tracking 照旧生效。
 */
import init, { HokusaiCanvas, HokusaiBrush } from '../wasm/hokusai.js';
import { Stabilizer } from './brush.js';

/* hex → HSV，但 V/RGB 走**线性**空间。
 *
 * 为什么不能直接用 sRGB：hokusai（跟 libmypaint 一样）把 HSV 当线性色用，
 * hsv_to_rgb 出来的值直接乘进 fix15 表面；出口那步才是 linear_to_srgb。
 * 所以进来时得先 srgb→linear，出口再 linear→srgb，两头一夹颜色才不多不少。
 * 直接把 sRGB 塞进去的话，选 #e8eaf0 会画成 #f5f6f8 —— 淡一圈。
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

/* .myb 里的曲线：[[输入, 输出], ...]，线性插值。 */
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
    this.active = false;
    this.onRegion = null;         // (x0,y0,x1,y1) => void
    this.paintedTiles = 0;        // 统计用
  }

  /* 载入 wasm 和预设。失败不抛，落在 this.error 里，主程序退回旧引擎。 */
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

  /* 画布尺寸变了就得重建（hokusai 的 canvas 尺寸是不可变的） */
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

  /* 取（必要时构造并缓存）一个预设的笔刷对象。
   * 颜色和半径每次落笔都会改写它 —— 一个预设只该有一个实例。 */
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

  /* ---------- 一笔 ---------- */

  begin(x, y, pressure, opts = {}) {
    if (!this.ready) return false;
    this.ensureSurface(this.doc.w, this.doc.h);

    const b = this.brushFor(opts.preset || this.name);
    if (!b) return false;
    this.current = b;

    // 半径用直径/2。注意 libmypaint 的 radius_logarithmic 是 **ln(像素)**
    // —— hokusai 里头是 `setting.exp()`，不是 exp2。
    // 之前按 log2 算，40px 半径被当成 exp(5.32)≈204px，一笔糊掉半个版面。
    this.radiusPx = Math.max(0.5, (opts.size || 80) / 2);
    b.setRadiusLog(this.radiusBaseFor(this.currentKey) + Math.log(this.radiusPx));

    const { h, s, v } = hexToHsv(opts.color || '#000000');
    b.setColorHsv(h, s, v);

    // 一笔一个临时 surface，别让上一笔的内容漏进来
    this.canvas.clear();
    this.doc.overlay.clear();
    this.doc.overlayActive = true;
    this.doc.overlayAlpha = this.opacity;

    this.stab = new Stabilizer(opts.stabilize ?? 0.12);
    this.opacity = opts.opacity ?? 1;
    this.lastT = performance.now() / 1000;
    this.startX = this.lastX = x;
    this.startY = this.lastY = y;
    this.lastPressure = pressure;
    this.moved = false;
    this.active = true;
    this.paintedTiles = 0;

    // 第一次 strokeTo 只播种状态，不落笔（libmypaint 就是这样）
    const p = this.stab.push(x, y);
    this.canvas.strokeTo(b, p.x, p.y, pressure, opts.tiltX || 0, opts.tiltY || 0, 0.0001);
    this.pump();
    return true;
  }

  move(x, y, pressure, opts = {}) {
    if (!this.active) return;
    const p = this.stab.push(x, y);

    const now = performance.now() / 1000;
    let dt = now - this.lastT;
    if (!(dt > 0)) dt = 0.0001;
    // 停太久再动，别让 libmypaint 拿一个巨大的 dtime 去算速度
    if (dt > 0.1) dt = 0.1;
    this.lastT = now;

    if (Math.hypot(x - this.startX, y - this.startY) > 1.5) this.moved = true;
    this.lastX = x; this.lastY = y; this.lastPressure = pressure;

    this.canvas.strokeTo(this.current, p.x, p.y, pressure,
      opts.tiltX || 0, opts.tiltY || 0, dt);
    // 这里**不** pump：一个 pointermove 里可能塞了十几个合并事件，
    // 每个都搬一次块 + 通知撤销层，会白白重复几十倍。
    // 外面一批事件喂完再调一次 flush()。
  }

  /* 把积攒的脏块一次性搬进覆盖层 */
  flush() {
    if (!this.active) return;
    this.pump();
  }

  end() {
    if (!this.active) return;
    this.active = false;

    this.canvas.finishStroke(this.current);
    this.pump();

    // 点一下也应该出一个点。多数 .myb 靠「走过的距离」采样，
    // 一动不动时一个点都不会落；dabs_per_second 为 0 的笔刷就彻底没反应。
    // 补一小段出来（不到一个笔尖直径），看起来仍然是一个点。
    if (this.paintedTiles === 0) {
      const r = this.radiusPx;
      this.canvas.strokeTo(this.current, this.lastX + r * 0.55, this.lastY,
        this.lastPressure, 0, 0, 0.016);
      this.canvas.finishStroke(this.current);
      this.pump();
    }

    this.canvas.resetStroke();

    // 松手：把整笔一次性压到图层上。
    // 先压的是「一拍到底」的最终值，所以重叠处不会叠黑。
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
        // 整笔一次性压在图层上，alpha 才是「这一笔的不透明度」；
        // 逐事件压就会变成「每个事件各叠一次」，越画越实。
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

  /* 把 drainDirty 出来的块写进覆盖层 */
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

    // 一个事件可能扫过几十块。撤销层是按「矩形」拍的，
    // 逐块通知会让 grabRegion 反复做 O(面积) 的合并 —— 之前慢成 20 秒就是这儿。
    // 先合出一个包围盒，最后只通知一次。
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
    // 撤销：这一批在被压到图层之前先拍下来
    if (this.onRegion) this.onRegion(ux0, uy0, ux1, uy1);
    this.doc.markRegionDirty(ux0, uy0, ux1, uy1);
  }

  /* 尺寸滑块 = 「满压力时的半径」。.myb 的 radius_logarithmic 常带一条
   * 压力曲线，而且它是**叠加**在 base_value 上的（base + curve(p)）。
   * 光改 base_value 等于白改：brush.myb 在 p=0.85 时会额外 +1.6，
   * 40px 半径直接变成 200px。
   * 所以先把曲线在 p=1 处的偏移量减掉，滑块才能真正等于笔尖大小，
   * 压力响应也照旧留着。
   * 返回的是「抵消量」，用之前再加上 ln(半径)。
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

  /* 换预设 —— UI 用 */
  setPreset(name) {
    if (!this.presets.has(name)) return false;
    this.name = name;
    return true;
  }

  get presetNames() { return [...this.presets.keys()]; }
}
