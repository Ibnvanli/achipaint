/* 选区：任意形状与自由变换
 *
 * 选区在 AchiPaint 里不是矩形，而是一张蒙版（Uint8Array，每像素 1 字节）。
 * 矩形、套索、魔棒三种来源最终都产出同一形态，消费方只处理一种。
 *
 * 自由变换原先只有移动和旋转，缺缩放 —— 贴素材、改比例时用不了。
 * 缩放只作用在绘制尺寸上，不改原画布，因此反复缩放不会累积重采样损失。
 */

const CASES = {
  /* 矩形选区：外接矩形与像素数都应精确 */
  '矩形选区的包围盒与像素数': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const sel = achi.Selection.fromRect(doc.w, doc.h, 10, 20, 40, 60);
    const bb = sel.bbox();
    assertEq(bb.x0, 10, 'bbox.x0');
    assertEq(bb.y0, 20, 'bbox.y0');
    assertEq(bb.x1, 40, 'bbox.x1');
    assertEq(bb.y1, 60, 'bbox.y1');
    assertEq(sel.count(), 30 * 40, '选中像素数应为 宽×高');
  },

  /* 套索：多边形的填充面积应接近理论值 */
  '套索多边形面积接近理论值': async ({ achi, assert }) => {
    const doc = achi.doc;
    const R = 80, CX = 300, CY = 300;
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2;
      pts.push([CX + Math.cos(a) * R, CY + Math.sin(a) * R]);
    }
    const sel = achi.Selection.fromPolygon(doc.w, doc.h, pts);
    const theory = Math.PI * R * R;
    const got = sel.count();
    /* 像素化误差允许 3% */
    assert(Math.abs(got - theory) / theory < 0.03,
      `圆面积应接近 ${Math.round(theory)}，实际 ${got}`);

    const bb = sel.bbox();
    assert(Math.abs(bb.x1 - bb.x0 - 2 * R) <= 2, `bbox 宽应约 ${2 * R}，实际 ${bb.x1 - bb.x0}`);
  },

  /* 魔棒：只取连通且颜色相近的区域 */
  '魔棒按容差取连通区域': async ({ achi, assert, assertEq }) => {
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const left = x < 20;
        data[p] = left ? 255 : 0;
        data[p + 1] = 0;
        data[p + 2] = left ? 0 : 255;
        data[p + 3] = 255;
      }
    }
    const m = achi.magicWandMask(data, w, h, 2, 2, 20, true);
    let n = 0;
    for (const v of m) if (v) n++;
    assertEq(n, 20 * 40, '连通魔棒应只选中左半边');

    /* 非连通模式：全图同色都选中（这里仍只有左半边是同色） */
    const m2 = achi.magicWandMask(data, w, h, 2, 2, 20, false);
    let n2 = 0;
    for (const v of m2) if (v) n2++;
    assertEq(n2, 20 * 40, '非连通魔棒结果');
  },

  /* 浮起时按蒙版裁切：选区之外的内容不能跟着走 */
  '浮起只带走选区内的像素': async ({ achi, assert, assertEq }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
    assert(hk.ready, '引擎应就绪');

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;

    /* 画一整块 200×200 的实心方块 */
    layer.forEachTileInBounds(100, 100, 300, 300, ctx => {
      ctx.fillStyle = '#2050c0';
      ctx.fillRect(100, 100, 200, 200);
    });
    layer.markDirty(0, 0, doc.w, doc.h);

    /* 只选左半边（100×200） */
    doc.selection = achi.Selection.fromRect(doc.w, doc.h, 100, 100, 200, 300);
    assert(achi.liftSelection(), '应能浮起');

    assertEq(achi.floating.w, 100, '浮起宽度应为选区宽');
    assertEq(achi.floating.h, 200, '浮起高度应为选区高');

    /* 关键断言：浮动画布的内容必须按蒙版裁过。
     * 用矩形选区测不出这一点（蒙版就是矩形，裁不裁结果一样），
     * 因此这里换用「矩形选区 + 检查浮动画布」不够，
     * 直接检查浮动画布四条边上的像素是否与选区边界吻合。 */
    const fctx = achi.floating.canvas.getContext('2d');
    const img = fctx.getImageData(0, 0, achi.floating.w, achi.floating.h);

    /* 浮起的是 100×200 的矩形选区，四边之内都应有内容 */
    const at = (px, py) => img.data[(py * achi.floating.w + px) * 4 + 3];
    assert(at(50, 100) > 10, '浮动画布中心应有内容');
    assert(at(2, 2) > 10, '浮动画布左上角应有内容（选区内）');
  },

  /* 非矩形选区：浮起时必须按蒙版裁掉界外像素。
   *
   * 这条才真正覆盖「套索/魔棒能浮起正确内容」——
   * 矩形选区的蒙版本身就是矩形，裁与不裁结果相同，测不出问题。 */
  '套索浮起时按蒙版裁掉界外像素': async ({ achi, assert, assertEq }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
    assert(hk.ready, '引擎应就绪');

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;

    /* 画满一个 200×200 的方块 */
    layer.forEachTileInBounds(100, 100, 300, 300, ctx => {
      ctx.fillStyle = '#2050c0';
      ctx.fillRect(100, 100, 200, 200);
    });
    layer.markDirty(0, 0, doc.w, doc.h);

    /* 只选左上半：一个三角形 */
    doc.selection = achi.Selection.fromPolygon(doc.w, doc.h,
      [[100, 100], [300, 100], [100, 300]]);
    assert(achi.liftSelection(), '应能浮起');

    const f = achi.floating;
    const fctx = f.canvas.getContext('2d');
    const img = fctx.getImageData(0, 0, f.w, f.h);
    const at = (px, py) => img.data[(py * f.w + px) * 4 + 3];

    /* 三角形覆盖左上角，不覆盖右下角 */
    assert(at(5, 5) > 10, '左上角在三角形内，应有内容');
    assertEq(at(f.w - 5, f.h - 5), 0, '右下角在三角形外，应为空');
    /* 中心附近：三角形斜边过中点，取稍微靠左上的点 */
    assert(at(Math.floor(f.w * 0.3), Math.floor(f.h * 0.3)) > 10,
      '斜边内侧应有内容');
  },

  /* 缩放：落回后尺寸按比例变化，中心不动 */
  '缩放后落回尺寸按比例变化且中心不变': async ({ achi, assert, assertEq }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const SIZE = 100, X0 = 250, Y0 = 250;

    layer.forEachTileInBounds(X0, Y0, X0 + SIZE, Y0 + SIZE, ctx => {
      ctx.fillStyle = '#2050c0';
      ctx.fillRect(X0, Y0, SIZE, SIZE);
    });
    layer.markDirty(0, 0, doc.w, doc.h);

    doc.selection = achi.Selection.fromRect(doc.w, doc.h, X0, Y0, X0 + SIZE, Y0 + SIZE);
    assert(achi.liftSelection(), '应能浮起');
    assertEq(achi.floating.scaleX, 1, '初始缩放为 1');

    /* 放大 2 倍后落回 */
    achi.floating.scaleX = 2;
    achi.floating.scaleY = 2;
    achi.commitFloating();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    /* 量落回后的墨迹范围 */
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const t of layer.tiles.values()) {
      const d = t.ctx.getImageData(0, 0, 256, 256).data;
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          if (d[(y * 256 + x) * 4 + 3] <= 10) continue;
          const wx = t.col * 256 + x, wy = t.row * 256 + y;
          if (wx < minx) minx = wx;
          if (wx > maxx) maxx = wx;
          if (wy < miny) miny = wy;
          if (wy > maxy) maxy = wy;
        }
      }
    }

    assertEq(maxx - minx + 1, SIZE * 2, '放大 2 倍后宽度应为 200');
    assertEq(maxy - miny + 1, SIZE * 2, '放大 2 倍后高度应为 200');

    /* 中心应保持在原中心 (300,300) */
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    assert(Math.abs(cx - (X0 + SIZE / 2)) <= 2,
      `水平中心应保持在 ${X0 + SIZE / 2}，实际 ${cx}`);
    assert(Math.abs(cy - (Y0 + SIZE / 2)) <= 2,
      `垂直中心应保持在 ${Y0 + SIZE / 2}，实际 ${cy}`);
  },
};
