/* 浮动选区与首帧不透明度
 *
 * 审计依据：audit/2026-11-20-audit.md
 *   2.5 低危：overlayAlpha 在 this.opacity 赋值之前写入，首帧按 100% 绘制
 *   2.6 低危：浮选区旋转后，历史只覆盖原矩形，超出部分撤销不掉，会留残影
 */

window.__t = {
  waitFrame() {
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  opaqueCount(achi) {
    const off = achi.doc.off;
    const d = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  },
};

const CASES = {
  /* 浮动选区移动后落回，撤销必须完全清除，不留残影 */
  '浮动选区移动落回后可完全撤销': async ({ achi, assertEq }) => {
    const doc = achi.doc;
    const node = doc.activeLeaf;
    const tc = node.canvas;

    /* 在 (50,50)-(150,150) 画一块内容 */
    tc.forEachTileInBounds(50, 50, 150, 150, (ctx) => {
      ctx.fillStyle = '#e2453d';
      ctx.fillRect(50, 50, 100, 100);
    });
    tc.markDirty(0, 0, doc.w, doc.h);
    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const before = window.__t.opaqueCount(achi);
    assertEq(before > 0, true, '前置条件：应有内容');

    /* 框选并用真实路径浮动 */
    doc.selection = { x0: 50, y0: 50, x1: 150, y1: 150 };
    achi.liftSelection();
    await window.__t.waitFrame();

    /* 把浮动块移到新的位置后落回 */
    achi.moveFloating(300, 220);
    achi.commitFloating();
    await window.__t.waitFrame();

    /* 撤销应回到初始状态：原位置恢复、新位置清除 */
    achi.history.undo(node.canvas);
    doc.markAllDirty();
    achi.redraw();
    await window.__t.waitFrame();

    const restored = window.__t.opaqueCount(achi);

    /* 面积必须完全一致。若撤销范围不足，新位置会残留一块，面积偏大。 */
    assertEq(restored, before, '撤销后不应残留任何落回区像素');
  },

  /* 首帧不透明度：笔迹开始时的 overlayAlpha 必须等于设定的不透明度 */
  '起笔时 overlayAlpha 与实际不透明度一致': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hk = achi.hk;

    /* 该断言针对的是 hokusai 引擎的起笔逻辑。
     * wasm 为异步载入，需等待就绪；若始终未就绪则判失败 ——
     * 静默跳过等同于没测（这正是审计报告指出的「自测覆盖不足」问题）。 */
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) {
      await new Promise(r => setTimeout(r, 100));
    }
    assertEq(hk.ready, true, 'hokusai 引擎应在 10 秒内就绪');

    hk.begin(100, 100, 0.5, { size: 40, color: '#000000', opacity: 0.4 });

    assertEq(hk.opacity, 0.4, '引擎应记录本笔的不透明度');
    assertEq(doc.overlayAlpha, 0.4, 'overlay 透明度应在首帧即为设定值，而非 1');
  },
};
