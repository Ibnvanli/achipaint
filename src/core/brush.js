/* 核心：笔刷引擎
 *
 * 唯一判断标准：快速划动与缓慢划动是否产生同一种笔迹。
 * 因此采样按「距离」而非「时间」—— 按时间采样会导致快划断线、慢划堆墨。
 */

/* 压感曲线：每条属性对应一条独立曲线，控制点取值 0..1 → 0..1 */
export class Curve {
  constructor(points = [[0, 0], [1, 1]]) { this.points = points; }
  at(t) {
    const p = this.points;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [x0, y0] = p[i - 1], [x1, y1] = p[i];
        const k = (t - x0) / (x1 - x0 || 1);
        return y0 + (y1 - y0) * k;
      }
    }
    return p[p.length - 1][1];
  }
}

/* 笔刷参数：均可调节，且各自具备压感曲线 */
export class Brush {
  constructor() {
    this.size = 80;
    this.opacity = 1;
    this.flow = 1;
    this.spacing = 0.04;         // 相对笔尖直径
    this.hardness = 0.6;
    this.color = '#e8eaf0';
    this.stabilize = 0.12;       // 0 = 原样，1 = 极度平滑。太高会明显拖尾

    this.sizeCurve = new Curve([[0, 0.12], [1, 1]]);
    this.opacityCurve = new Curve([[0, 0.35], [1, 1]]);
    this.flowCurve = new Curve([[0, 0.5], [1, 1]]);
  }
}

/* 稳定器：滑动平均 + 速度补偿
 *
 * 纯滑动平均必然产生滞后，滞后直接影响手感。
 * 纯直通则线条毛躁、缺乏弧度。
 * 折中方案：将平滑后的点沿速度方向前移补偿滞后，
 * 既抹平抖动，又使笔尖贴合真实位置。
 */
export class Stabilizer {
  constructor(strength = .12) {
    this.s = strength;
    this.x = null; this.y = null;
    this.vx = 0; this.vy = 0;
  }

  push(x, y) {
    if (this.x === null) { this.x = x; this.y = y; return { x, y }; }

    const k = 1 - Math.pow(Math.max(1e-6, this.s), 0.12);
    const nx = this.x + (x - this.x) * k;
    const ny = this.y + (y - this.y) * k;

    // 平滑后的速度
    this.vx = nx - this.x;
    this.vy = ny - this.y;
    this.x = nx; this.y = ny;

    // 速度补偿：抵消平滑造成的滞后，系数随平滑强度递增
    const comp = Math.min(2.2, this.s * 6);
    return { x: nx + this.vx * comp, y: ny + this.vy * comp };
  }

  reset() { this.x = this.y = null; this.vx = this.vy = 0; }
}

/* 单笔：自按下到松开 */
export class Stroke {
  constructor(brush, ctxLayer) {
    this.brush = brush;
    this.layer = ctxLayer;      // TileCanvas
    this.stab = new Stabilizer(brush.stabilize);
    this.last = null;
    this.acc = 0;               // 距离累加，决定何时落笔点
    this.bounds = null;
  }

  begin(x, y, pressure = 1) {
    this.stab.reset();
    const p = this.stab.push(x, y);
    this.last = { ...p, pressure };
    this.acc = 0;
    this.bounds = null;
    this.stamp(p.x, p.y, pressure);   // 起笔必须立刻落一个点，否则短划什么都不出
  }

  move(x, y, pressure = 1) {
    if (!this.last) return;
    const p = this.stab.push(x, y);
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) { this.last = { ...p, pressure }; return; }

    const b = this.brush;
    const size = b.size * b.sizeCurve.at(pressure);
    const step = Math.max(0.8, size * b.spacing);

    /* 沿该段路径按 step 均匀落点。
     * 原实现以 acc 递减计算 t，方向相反（落点顺序颠倒），
     * 且快速运笔时单次可落数百个点，导致该帧卡顿。
     * 现按「已走过的距离」正向推进，并为单次设置上限；
     * 超出上限时自动放大 step（视觉上略微稀疏，但不会卡顿）。
     */
    const need = Math.floor((this.acc + dist) / step);
    const MAX = 64;                       // 单次事件最多落 64 个点
    const count = Math.min(need, MAX);
    if (count <= 0) { this.acc += dist; this.last = { ...p, pressure }; return; }

    const realStep = (this.acc + dist) / count;   // 超限时自动放大间距
    for (let i = 1; i <= count; i++) {
      const t = (i * realStep - this.acc) / dist;
      const tc = Math.max(0, Math.min(1, t));
      this.stamp(this.last.x + dx * tc, this.last.y + dy * tc, pressure);
    }
    this.acc = (this.acc + dist) - count * realStep;
    if (this.acc < 0) this.acc = 0;

    this.last = { ...p, pressure };
  }

  end() { this.last = null; }

  stamp(x, y, pressure) {
    const b = this.brush;
    const size = b.size * b.sizeCurve.at(pressure);
    if (size < 0.6) return;
    const alpha = b.opacity * b.opacityCurve.at(pressure) * b.flow * b.flowCurve.at(pressure);
    const r = size / 2;

    // 裁剪到画布范围内：笔迹不得越出画布
    const L = this.layer;
    let cx0 = Math.max(0, x - r), cy0 = Math.max(0, y - r);
    let cx1 = Math.min(L.w, x + r), cy1 = Math.min(L.h, y + r);
    // 存在框选时进一步收缩范围。仅收缩包围盒不足 —— 笔点圆弧仍可能在框内各块中
    // 超出选框，因此下方对每块还需执行一次 ctx.clip。
    const clip = this.clip;
    if (clip) {
      cx0 = Math.max(cx0, clip.x0); cy0 = Math.max(cy0, clip.y0);
      cx1 = Math.min(cx1, clip.x1); cy1 = Math.min(cy1, clip.y1);
    }
    if (cx1 <= cx0 || cy1 <= cy0) return;

    // 单次笔点覆盖的所有块都需绘制。
    // 若仅绘制「点中心所在的块」，跨块边界处会被裁切，大笔刷将呈现点串状。
    // 写入前先由撤销层将「这一笔的覆盖区域」原样拍摄。
    // 注意是「区域」而非「块」—— 按块拍摄会误伤块内其他笔迹。
    if (this.onRegion) this.onRegion(cx0, cy0, cx1, cy1);

    L.forEachTileInBounds(cx0, cy0, cx1, cy1, (ctx, c, r2) => {
      if (clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
        ctx.clip();
      }
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.globalCompositeOperation = this.erase ? 'destination-out' : 'source-over';

      if (this.erase || b.hardness >= .99) {
        ctx.fillStyle = this.erase ? '#000' : b.color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      } else {
        const g = ctx.createRadialGradient(x, y, r * b.hardness, x, y, r);
        g.addColorStop(0, b.color);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      if (clip) ctx.restore();
    });

    // 累积脏块范围（同时作为撤销与重绘的依据）
    L.markDirty(cx0, cy0, cx1, cy1);
    if (!this.bounds) this.bounds = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
    else {
      this.bounds.x0 = Math.min(this.bounds.x0, cx0);
      this.bounds.y0 = Math.min(this.bounds.y0, cy0);
      this.bounds.x1 = Math.max(this.bounds.x1, cx1);
      this.bounds.y1 = Math.max(this.bounds.y1, cy1);
    }
  }
}
