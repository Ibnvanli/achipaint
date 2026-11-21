/* 核心：选区
 *
 * 选区在 AchiPaint 里不是「一个矩形」，而是**一张蒙版**。
 *
 * 为什么以蒙版为基本形态：
 *   绘画软件里的选区来源有三种 —— 矩形、套索（自由手绘）、魔棒（按颜色扩散）。
 *   后两者天然不是矩形：套索是任意多边形，魔棒是像素级的不连通区域。
 *   若把矩形当基本形态，另外两种就只能在外面套一层特殊判断，
 *   后续每一个用到选区的地方（绘制裁剪、浮起、填充、删除）都要分叉。
 *
 *   统一成蒙版之后，矩形只是「蒙版里有一个实心矩形」的特例，
 *   所有消费方只需要处理一种形态。
 *
 * 蒙版的存储方式：
 *   mask 是一张与文档同尺寸的 Uint8Array（每像素 1 字节，0 或 255）。
 *   不用 canvas，是因为这里只关心「在不在选区内」，
 *   而 canvas 的 getImageData 往返开销远大于直接读字节数组；
 *   魔棒要逐像素判定，这个差别很实际。
 *
 *   A4@300dpi 是 2480×3508 ≈ 8.7MB。选区是低频操作，这个量级可以接受；
 *   但仍提供 bbox 缓存，让绝大多数「只需要外接矩形」的调用方不必扫全图。
 */

export class Selection {
  /**
   * @param {number} w 文档宽
   * @param {number} h 文档高
   * @param {Uint8Array} [mask] 与 w×h 等长的蒙版；省略时为空选区
   */
  constructor(w, h, mask = null) {
    this.w = w;
    this.h = h;
    this.mask = mask || new Uint8Array(w * h);
    this._bbox = null;
  }

  /** 由矩形构造。这是最常用的来源，也是最简单的一种。 */
  static fromRect(w, h, x0, y0, x1, y1) {
    const sel = new Selection(w, h);
    const ax = Math.max(0, Math.min(w, Math.round(Math.min(x0, x1))));
    const ay = Math.max(0, Math.min(h, Math.round(Math.min(y0, y1))));
    const bx = Math.max(0, Math.min(w, Math.round(Math.max(x0, x1))));
    const by = Math.max(0, Math.min(h, Math.round(Math.max(y0, y1))));
    if (bx <= ax || by <= ay) return sel;
    const m = sel.mask;
    for (let y = ay; y < by; y++) {
      m.fill(255, y * w + ax, y * w + bx);
    }
    sel._bbox = { x0: ax, y0: ay, x1: bx, y1: by };
    return sel;
  }

  /** 由闭合多边形构造（套索）。points 为文档坐标的 [x, y] 数组。 */
  static fromPolygon(w, h, points) {
    const sel = new Selection(w, h);
    if (!points || points.length < 3) return sel;

    /* 扫描线填充：逐行求多边形与该行的交点，按 x 排序后成对填充。
     * 这是最直接的奇偶规则填充，对自相交路径也能给出合理结果。 */
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;
    for (const [px, py] of points) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    const m = sel.mask;
    const xs = [];

    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        /* 半开区间判定，避免顶点被重复计数 */
        if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
          xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ax = Math.max(0, Math.round(xs[k]));
        const bx = Math.min(w, Math.round(xs[k + 1]));
        if (bx > ax) m.fill(255, y * w + ax, y * w + bx);
      }
    }
    return sel;
  }

  /** 由已有蒙版构造（魔棒等逐像素算法使用）。 */
  static fromMask(w, h, mask) {
    return new Selection(w, h, mask);
  }

  /** 选区是否为空 */
  isEmpty() {
    const b = this.bbox();
    return !b || b.x1 <= b.x0 || b.y1 <= b.y0;
  }

  /** 外接矩形。结果缓存，蒙版变化后需调用 invalidate()。 */
  bbox() {
    if (this._bbox !== null) return this._bbox;
    const { w, h, mask } = this;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      /* 逐行找该行最左/最右的选中像素，比逐像素判定快得多 */
      let left = -1, right = -1;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) { left = x; break; }
      }
      if (left < 0) continue;
      for (let x = w - 1; x >= left; x--) {
        if (mask[row + x]) { right = x; break; }
      }
      if (y < y0) y0 = y;
      y1 = y + 1;
      if (left < x0) x0 = left;
      if (right + 1 > x1) x1 = right + 1;
    }
    this._bbox = (x1 > x0 && y1 > y0) ? { x0, y0, x1, y1 } : null;
    return this._bbox;
  }

  /** 蒙版被直接改写后调用，丢弃缓存的包围盒。 */
  invalidate() {
    this._bbox = null;
  }

  /** 某点是否在选区内 */
  contains(x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return false;
    return this.mask[yi * this.w + xi] !== 0;
  }

  /* ---------- 与 canvas 协作 ----------
   * 绘制裁剪需要真正的路径，而蒙版没有路径。
   * 这里把蒙版转成 canvas，供 ctx.clip() 之外的场景使用
   * （例如以 'destination-in' 方式裁一张图）。
   */

  /** 把蒙版写进一张 canvas 的 alpha 通道（白 = 选中）。结果缓存。 */
  toCanvas() {
    if (this._cv) return this._cv;
    const cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    const d = img.data;
    const m = this.mask;
    for (let i = 0, n = m.length; i < n; i++) {
      if (m[i]) {
        const p = i * 4;
        d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this._cv = cv;
    return cv;
  }

  /** 把目标画布的 alpha 按蒙版裁掉（选区之外变透明）。原地修改。 */
  clipCanvas(targetCtx) {
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'destination-in';
    targetCtx.drawImage(this.toCanvas(), 0, 0);
    targetCtx.restore();
  }

  /* ---------- 构造辅助 ---------- */

  /** 取反（反选） */
  invert() {
    const m = this.mask;
    for (let i = 0, n = m.length; i < n; i++) m[i] = m[i] ? 0 : 255;
    this.invalidate();
    return this;
  }

  /** 加一个矩形区域 */
  addRect(x0, y0, x1, y1) {
    const ax = Math.max(0, Math.min(this.w, Math.round(Math.min(x0, x1))));
    const ay = Math.max(0, Math.min(this.h, Math.round(Math.min(y0, y1))));
    const bx = Math.max(0, Math.min(this.w, Math.round(Math.max(x0, x1))));
    const by = Math.max(0, Math.min(this.h, Math.round(Math.max(y0, y1))));
    for (let y = ay; y < by; y++) this.mask.fill(255, y * this.w + ax, y * this.w + bx);
    this.invalidate();
    return this;
  }

  /** 减去一个矩形区域 */
  subRect(x0, y0, x1, y1) {
    const ax = Math.max(0, Math.min(this.w, Math.round(Math.min(x0, x1))));
    const ay = Math.max(0, Math.min(this.h, Math.round(Math.min(y0, y1))));
    const bx = Math.max(0, Math.min(this.w, Math.round(Math.max(x0, x1))));
    const by = Math.max(0, Math.min(this.h, Math.round(Math.max(y0, y1))));
    for (let y = ay; y < by; y++) this.mask.fill(0, y * this.w + ax, y * this.w + bx);
    this.invalidate();
    return this;
  }

  /** 已选中的像素数 */
  count() {
    let n = 0;
    const m = this.mask;
    for (let i = 0, len = m.length; i < len; i++) if (m[i]) n++;
    return n;
  }
}

/* ---------- 魔棒：按颜色容差扩散 ----------
 *
 * 从种子点出发做 4 邻域扩散，把颜色接近的连通像素纳入选区。
 * 用扫描线填充而不是逐像素 BFS，避免大区域时栈过深。
 *
 * @param {Uint8ClampedArray} data 源像素（RGBA）
 * @param {number} w 宽
 * @param {number} h 高
 * @param {number} sx 种子 x
 * @param {number} sy 种子 y
 * @param {number} tolerance 0..255 的容差
 * @param {boolean} contiguous 是否只取连通区域（否则取全图同色）
 */
export function magicWandMask(data, w, h, sx, sy, tolerance = 32, contiguous = true) {
  const mask = new Uint8Array(w * h);
  const xi = Math.round(sx), yi = Math.round(sy);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return mask;

  const si = (yi * w + xi) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
  const tol = Math.max(0, tolerance) * tolerance;   // 比较平方距离

  /* 颜色是否落在容差内。用平方距离省掉开方。 */
  const match = (i) => {
    const p = i * 4;
    const dr = data[p] - sr, dg = data[p + 1] - sg;
    const db = data[p + 2] - sb, da = data[p + 3] - sa;
    return (dr * dr + dg * dg + db * db + da * da) <= tol;
  };

  if (!contiguous) {
    for (let i = 0, n = w * h; i < n; i++) if (match(i)) mask[i] = 255;
    return mask;
  }

  /* 扫描线填充：每找到一个种子，向左右扩张成一段，
   * 再检查上下两行对应区间内的像素作为新种子。
   * 这样避免逐像素入栈，大区域也不会爆栈。 */
  const stack = [xi, yi];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    let i = y * w + x;
    if (mask[i]) continue;
    if (!match(i)) continue;

    let left = x;
    while (left > 0 && !mask[i - 1] && match(i - 1)) { left--; i--; }
    i = y * w + x;
    let right = x;
    while (right < w - 1 && !mask[i + 1] && match(i + 1)) { right++; i++; }

    /* 填充这一段 */
    const row = y * w;
    mask.fill(255, row + left, row + right + 1);

    /* 上下两行找新种子 */
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let nx = left; nx <= right; nx++) {
        const ok = !mask[nrow + nx] && match(nrow + nx);
        if (ok && !inRun) { stack.push(nx, ny); inRun = true; }
        else if (!ok) inRun = false;
      }
    }
  }
  return mask;
}
