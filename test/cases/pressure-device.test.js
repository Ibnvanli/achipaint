/* 无压感数据的 pen 设备
 *
 * 缺陷来源：某些数位板/驱动会报告 pointerType === 'pen'，但 pressure 恒为 0.5
 * （规范里的占位值），从不随力度变化。
 *
 * 原实现直接采信这个 0.5：.myb 的 radius 曲线在 p=0.5 时只有满半径的约 16%，
 * 80px 的笔刷画出来只有十几像素 —— 看起来就是「没有压感」。
 *
 * 修法：尚未确认设备提供压感时先按满压画；一旦观测到压力在变，
 * 立即认定可用并切到真实值。判定跨笔画保持，笔画内部不做切换。
 */

function strokeWith(hk, view, pressures) {
  const seen = [];
  const oM = hk.move.bind(hk);
  hk.move = (x, y, p, o) => { seen.push(p); return oM(x, y, p, o); };

  try {
    const r = view.getBoundingClientRect();
    const cx = r.left + 100, cy = r.top + 300;
    const mk = (t, p, x, y) => new PointerEvent(t, {
      pointerType: 'pen', pressure: p, buttons: 1, bubbles: true,
      clientX: x, clientY: y, pointerId: 41,
    });

    view.dispatchEvent(mk('pointerdown', pressures[0], cx, cy));
    for (let i = 1; i <= 20; i++) {
      const p = pressures[Math.min(i, pressures.length - 1)];
      view.dispatchEvent(mk('pointermove', p, cx + i * 12, cy));
    }
    view.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'pen', pressure: pressures[pressures.length - 1],
      buttons: 0, bubbles: true, clientX: cx + 240, clientY: cy, pointerId: 41,
    }));
  } finally {
    hk.move = oM;
  }
  return seen;
}

/* 量整张图层里墨迹的最大厚度（竖直方向）。
 * 不依赖坐标换算 —— 视图有缩放平移，把 client 坐标硬套成文档坐标会量错地方。 */
function maxStrokeWidth(layer) {
  /* 先找出有墨迹的列范围 */
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const tiles = [...layer.tiles.values()];
  for (const t of tiles) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (d[(y * 256 + x) * 4 + 3] <= 8) continue;
        const wx = t.col * 256 + x, wy = t.row * 256 + y;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }
  }
  if (maxX <= minX) return 0;

  /* 在中间几列上量竖直厚度，取最大值 */
  let maxT = 0;
  for (let x = minX + 10; x <= maxX - 10; x += 8) {
    let top = -1, bot = -1;
    for (let y = minY; y <= maxY; y++) {
      const c = Math.floor(x / 256), rr = Math.floor(y / 256);
      const t = layer.tiles.get(c + ',' + rr);
      if (!t) continue;
      const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
      if (d[3] > 8) { if (top < 0) top = y; bot = y; }
    }
    const th = top < 0 ? 0 : bot - top + 1;
    if (th > maxT) maxT = th;
  }
  return maxT;
}

const CASES = {
  /* 压力恒为 0.5 的 pen：不能按 0.5 画成细线 */
  'pen 压力恒定时按满压绘制': async ({ achi, assert }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
    assert(hk.ready, '引擎应就绪');

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const view = document.getElementById('view');
    const SIZE = 80;
    /* 该判定跨笔画保持，用例之间必须重置，否则互相污染 */
    achi.penPressureUsable = null;

    /* 压力恒 0.5，模拟「报了 pen 但不给数据」的设备 */
    strokeWith(hk, view, [0.5]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const width = maxStrokeWidth(layer);

    /* 允许一定余量：圆头、抗锯齿会让边缘测量偏小 */
    assert(width >= SIZE * 0.6,
      `压力恒为 0.5 时应按满压绘制，线宽应接近 ${SIZE}px，实际 ${width}px`);
  },

  /* 真压感设备：压力变化必须被采信 */
  '压力变化时采信真实值': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const view = document.getElementById('view');
    achi.penPressureUsable = null;
    const seq = [];
    for (let i = 0; i < 20; i++) seq.push(0.2 + i * 0.04);

    const seen = strokeWith(hk, view, seq);

    const uniq = [...new Set(seen.map(v => +v.toFixed(2)))];
    assert(uniq.length > 3,
      `压力变化时应采信真实值，实际只有 ${uniq.length} 种取值：${uniq.join(',')}`);
    assert(Math.min(...seen) < 0.6,
      `低压力应被采信，实际最小值 ${Math.min(...seen)}`);
  },
};
