/* 撤销：结构变更
 *
 * 审计依据：audit/2026-11-20-audit.md 第 1.2 节
 *   第四版撤销仅覆盖像素，图层新建 / 删除 / 重排 / 改名 / 属性修改 / 蒙版增删
 *   全部不可撤销，误删图层无法恢复（数据丢失级缺口）。
 *
 * 断言对象是**图层树形态与合成层像素**，不是内部快照结构 ——
 * 只要用户看到的结果正确，实现方式可以更换。
 */

/* 辅助函数挂到 window 上：用例体是被单独序列化后在页面中执行的，
 * 无法直接访问本文件的模块作用域。 */
window.__t = {
  /* 在指定图层上画一块实心矩形 */
  paintRect(achi, node, color, x, y, w, h) {
    const tc = node.canvas;
    tc.forEachTileInBounds(x, y, x + w, y + h, ctx => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    });
    tc.markDirty(0, 0, tc.w, tc.h);
    achi.doc.markAllDirty();
    achi.redraw();
  },
  /* 统计合成层（doc.off）中的不透明像素数量。
   * 这是审计报告反复强调的断言方式：数据层对不代表用户看到的是对的。 */
  opaqueCount(achi) {
    const off = achi.doc.off;
    const d = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  },
  /* 等待两帧：redraw() 走 requestPaint（rAF），
   * 立即读取 doc.off 会读到上一次的合成结果。
   * 这是审计报告强调的「数据层对、用户看到的不对」的同一类陷阱。 */
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
};

const CASES = {
  /* 删除图层后撤销，图层与像素都必须回来 */
  '删除图层可撤销且像素完整恢复': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;

    /* 删除约束：必须至少保留一个叶子，否则 deleteNode 会拒绝。
     * 因此先补一层，再删目标层。 */
    doc.addLayer();
    doc.select(doc.root.children[doc.root.children.length - 1]);
    const before = doc.root.children.length;
    const target = doc.activeLeaf;
    window.__t.paintRect(achi, target, '#e2453d', 40, 40, 200, 150);
    await window.__t.waitFrame();

    const inkBefore = window.__t.opaqueCount(achi);
    assert(inkBefore > 0, '前置条件：应已绘制内容');

    // 记录结构变更
    const pending = hist.beginStructure(doc);
    assert(doc.deleteNode(target), '删除应成功');
    hist.commitStructure(pending, '删除图层');
    achi.redraw();
    await window.__t.waitFrame();

    assertEq(doc.root.children.length, before - 1, '删除后图层数应减少');
    assertEq(window.__t.opaqueCount(achi), 0, '删除后合成层应无内容');

    assert(hist.undo(doc.activeLeaf && doc.activeLeaf.canvas), '撤销应成功');
    achi.redraw();
    await window.__t.waitFrame();
    assertEq(doc.root.children.length, before, '撤销后图层数应恢复');
    assertEq(window.__t.opaqueCount(achi), inkBefore, '撤销后像素应逐点恢复');
  },

  /* 新建图层撤销后，图层数回到原值 */
  '新建图层可撤销': async ({ achi, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const before = doc.root.children.length;

    const pending = hist.beginStructure(doc);
    doc.addLayer();
    hist.commitStructure(pending, '新建图层');
    assertEq(doc.root.children.length, before + 1, '新建后图层数应增加');

    achi.history.undo(doc.activeLeaf && doc.activeLeaf.canvas);
    assertEq(doc.root.children.length, before, '撤销后图层数应恢复');
  },

  /* 重排撤销后顺序还原 */
  '图层重排可撤销': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;

    /* 构造两个图层，记录初始顺序 */
    doc.addLayer();
    doc.addLayer();
    const before = doc.root.children.map(n => n.name).join(',');

    const node = doc.root.children[0];
    const target = doc.root.children[doc.root.children.length - 1];
    const pending = hist.beginStructure(doc);
    assert(doc.moveNode(node, target.parent, target.parent.children.length), '移动应成功');
    hist.commitStructure(pending, '图层重排');

    const moved = doc.root.children.map(n => n.name).join(',');
    assert(moved !== before, '移动后顺序应发生变化');

    hist.undo(doc.activeLeaf && doc.activeLeaf.canvas);
    const restored = doc.root.children.map(n => n.name).join(',');
    assertEq(restored, before, '撤销后顺序应还原');
  },

  /* 属性修改撤销 */
  '不透明度与混合模式可撤销': async ({ achi, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const node = doc.activeLeaf;

    const op0 = node.opacity;
    const mode0 = node.mode;

    const p1 = hist.beginStructure(doc);
    node.opacity = 0.3;
    hist.commitStructure(p1, '不透明度');

    const p2 = hist.beginStructure(doc);
    node.mode = 'multiply';
    hist.commitStructure(p2, '混合模式');

    hist.undo(node.canvas);
    assertEq(node.mode, mode0, '撤销应还原混合模式');
    hist.undo(node.canvas);
    assertEq(node.opacity, op0, '撤销应还原不透明度');
  },

  /* 重做恢复被撤销的结构变更 */
  '结构变更可重做': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const before = doc.root.children.length;

    const pending = hist.beginStructure(doc);
    doc.addLayer();
    hist.commitStructure(pending, '新建图层');

    hist.undo(doc.activeLeaf && doc.activeLeaf.canvas);
    assertEq(doc.root.children.length, before, '撤销后应回到原状');

    hist.redo(doc.activeLeaf && doc.activeLeaf.canvas);
    assertEq(doc.root.children.length, before + 1, '重做后应恢复新建');
    assert(doc.root.children.length === before + 1, '重做结果应稳定');
  },

  /* 无变化的操作不应污染撤销栈 */
  '未产生变化时不入栈': async ({ achi, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const depth = hist.stack.length;

    const pending = hist.beginStructure(doc);
    // 不做任何修改
    const committed = hist.commitStructure(pending, '空操作');

    assertEq(committed, false, '无变化时不应提交');
    assertEq(hist.stack.length, depth, '撤销栈深度不应变化');
  },

  /* 蒙版新建可撤销 */
  '新建蒙版可撤销': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const node = doc.activeLeaf;

    assert(!node.mask, '前置条件：默认不应有蒙版');

    const pending = hist.beginStructure(doc);
    node.ensureMask();
    hist.commitStructure(pending, '新建蒙版');
    assert(!!node.mask, '新建后应存在蒙版');

    hist.undo(node.canvas);
    assert(!node.mask, '撤销后蒙版应被移除');
  },

  /* 跨图层撤销：像素只写回记录自己的画布（历史遗留的 P0） */
  '跨图层撤销不写错画布': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;

    const a = doc.activeLeaf;
    const p = hist.beginStroke(a.canvas);
    window.__t.paintRect(achi, a, '#2b6cb0', 20, 20, 100, 100);
    hist.grabRegion(p, 20, 20, 120, 120);
    hist.commit(p);

    doc.addLayer();
    const b = doc.activeLeaf;
    assert(a !== b, '前置条件：应切换到新图层');

    const bInkBefore = window.__t.opaqueCountOf(b.canvas);
    hist.undo(b.canvas);            // 传当前图层，但记录属于 a
    const bInkAfter = window.__t.opaqueCountOf(b.canvas);

    assertEq(bInkAfter, bInkBefore, '撤销不应改动当前图层 B 的像素');
  },
};
