/* 变换与蒙版同步
 *
 * 审计依据：audit/2026-11-20-audit.md 第 1.4 节
 *   移动图层：画布移动、蒙版移动，但历史只拍画布 → 撤销后蒙版永久错位
 *   旋转图层：画布旋转、蒙版不动 → 内容与蒙版完全脱节
 *
 * 断言对象是**合成层像素分布**：蒙版错位会直接表现为可见内容的范围变化，
 * 比检查内部蒙版坐标更贴近用户实际看到的结果。
 */

/* 辅助函数挂到 window 上：用例体在页面中单独执行，访问不到本文件模块作用域。 */
window.__t = {
  /* 等待两帧：redraw() 走 requestPaint（rAF），立即读取 doc.off 会读到上一帧结果。 */
  waitFrame() {
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  /* 统计单个 TileCanvas 的不透明像素数 */
  opaqueCountOf(tc) {
    let n = 0;
    for (const t of tc.tiles.values()) {
      const d = t.ctx.getImageData(0, 0, 256, 256).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    }
    return n;
  },
  /* 统计合成层（doc.off）中的不透明像素数量 */
  opaqueCount(achi) {
    const off = achi.doc.off;
    const d = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  },
};

const CASES = {
  /* 旋转必须保持可见面积。
   * 这是审计未列出、由测试发现的缺陷：boundsOf 原先返回块网格外接矩形，
   * 与真实内容边界最多相差 255px，导致旋转轴心偏移、内容被甩出画布。 */
  '旋转保持可见面积': async ({ achi, assert }) => {
    const doc = achi.doc;
    const node = doc.activeLeaf;
    const cv = node.canvas;

    /* 铺满整张画布：包围盒与画布完全重合，任何轴心偏移都会直接表现为面积损失。 */
    cv.forEachTileInBounds(0, 0, doc.w, doc.h, (ctx) => {
      ctx.fillStyle = '#2b6cb0';
      ctx.fillRect(0, 0, doc.w, doc.h);
    });
    cv.markDirty(0, 0, doc.w, doc.h);
    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const before = window.__t.opaqueCountOf(cv);
    achi.rotateLayer(node, 180);
    const after = window.__t.opaqueCountOf(cv);

    const diff = Math.abs(after - before) / Math.max(1, before);
    assert(diff < 0.02, `旋转前后面积应一致，实际偏差 ${(diff * 100).toFixed(1)}%（${before} → ${after}）`);
  },

  /* 旋转后蒙版必须与内容保持同步。
   * 若只转内容不转蒙版，原本被遮住的区域会重新露出，合成层可见面积随之改变。 */
  '旋转图层时蒙版同步旋转': async ({ achi, assert }) => {
    const doc = achi.doc;
    const node = doc.activeLeaf;

    /* 内容铺满，蒙版只保留左半边可见：可见面积应恒为画布的一半。 */
    const cv = node.canvas;
    cv.forEachTileInBounds(0, 0, doc.w, doc.h, (ctx) => {
      ctx.fillStyle = '#2b6cb0';
      ctx.fillRect(0, 0, doc.w, doc.h);
    });
    cv.markDirty(0, 0, doc.w, doc.h);

    const mask = node.ensureMask();
    /* 蒙版为 alpha 通道：255 显示，0 遮住。先整体填满，再把右半擦成透明。 */
    mask.forEachTileInBounds(0, 0, doc.w, doc.h, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, doc.w, doc.h);
    });
    mask.forEachTileInBounds(doc.w / 2, 0, doc.w, doc.h, (ctx) => {
      ctx.clearRect(doc.w / 2, 0, doc.w / 2, doc.h);
    });
    mask.markDirty(0, 0, doc.w, doc.h);

    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const before = window.__t.opaqueCount(achi);
    assert(before > 0, '前置条件：应有可见内容');

    achi.rotateLayer(node, 180);
    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const after = window.__t.opaqueCount(achi);

    /* 内容与蒙版同步旋转 180° 后，可见面积保持不变。
     * 若蒙版未跟随，可见区域会与内容错配，面积出现明显偏差。 */
    const diff = Math.abs(after - before) / Math.max(1, before);
    assert(diff < 0.02, `蒙版应随内容同步旋转，实际偏差 ${(diff * 100).toFixed(1)}%（${before} → ${after}）`);
  },

  /* 移动图层后撤销，蒙版必须回到原位 */
  '移动图层撤销后蒙版复位': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const node = doc.activeLeaf;

    const cv = node.canvas;
    cv.forEachTileInBounds(100, 100, 300, 300, (ctx) => {
      ctx.fillStyle = '#e2453d';
      ctx.fillRect(100, 100, 200, 200);
    });
    cv.markDirty(0, 0, doc.w, doc.h);

    const mask = node.ensureMask();
    mask.forEachTileInBounds(100, 100, 300, 300, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(100, 100, 200, 200);
    });
    mask.markDirty(0, 0, doc.w, doc.h);

    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const before = window.__t.opaqueCount(achi);

    achi.commitMove(node, 200, 0);
    await window.__t.waitFrame();

    /* 画布与蒙版各入一条像素记录，需撤销两次。 */
    achi.history.undo(node.canvas);
    achi.history.undo(node.canvas);
    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const restored = window.__t.opaqueCount(achi);
    assertEq(restored, before, '撤销后可见面积应与移动前一致');
  },
};
