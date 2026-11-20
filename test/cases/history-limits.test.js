/* 结构记录的淘汰上限
 *
 * 审计依据：audit/2026-11-20-structure-undo.md 第二节
 *   结构记录以 bytes: 0 入栈，而 trim() 的入口条件是 this.bytes > this.limit，
 *   因此纯结构操作时 bytes 恒为 0，trim() 永不触发，结构记录无上限增长。
 *
 * 该审计补充的一点：报告测的是空图层（约 2MB，看起来无害），
 * 但结构记录真正持有的是**节点对象**，删除带像素的图层时，
 * 该图层的 TileCanvas 会随节点一起被快照引用，无法被 GC 回收。
 */

window.__t = {
  waitFrame() {
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};

const CASES = {
  /* 连续大量结构操作后，结构记录条数必须收敛到上限 */
  '结构记录条数受上限约束': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const LIMIT = hist.constructor.name === 'History' ? 200 : 200;

    /* 用「新建图层」这种最轻的结构操作把栈堆起来。
     * 纯结构操作时像素字节数为 0，这正是审计指出的失效条件。 */
    const rounds = LIMIT + 120;
    for (let i = 0; i < rounds; i++) {
      const p = hist.beginStructure(doc);
      doc.addLayer();
      hist.commitStructure(p, '新建图层');
    }

    const structs = hist.stack.filter(r => r.kind === 'structure').length;
    assert(hist.structCount <= LIMIT,
      `结构记录应不超过 ${LIMIT} 条，实际 ${hist.structCount}`);
    assertEq(structs, hist.structCount, 'structCount 与实际条数应一致');

    /* 反向验证：不能把所有记录都清空，否则撤销历史等于丢失。
     * 达到上限后应稳定停留在上限附近。 */
    assert(hist.structCount > LIMIT - 5,
      `达到上限后应稳定在 ${LIMIT} 附近，实际 ${hist.structCount}`);
  },

  /* 淘汰后 index 必须仍指向有效记录，撤销要能正常工作 */
  '结构淘汰后撤销仍可用': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const LIMIT = 200;

    const baseLayers = doc.root.children.length;

    for (let i = 0; i < LIMIT + 50; i++) {
      const p = hist.beginStructure(doc);
      doc.addLayer();
      hist.commitStructure(p, '新建图层');
    }

    /* index 必须落在栈范围内 */
    assert(hist.index >= 0 && hist.index < hist.stack.length,
      `index 应在 [0, ${hist.stack.length}) 内，实际 ${hist.index}`);

    /* 连续撤销若干次，每次都必须成功且图层数递减 */
    const before = doc.root.children.length;
    let undone = 0;
    for (let i = 0; i < 20; i++) {
      if (!hist.undo(doc.activeLeaf && doc.activeLeaf.canvas)) break;
      undone++;
    }
    assert(undone > 0, `淘汰后仍应能撤销，实际撤销 ${undone} 次`);
    assertEq(doc.root.children.length, before - undone, '撤销次数应与图层减少数一致');
    assert(doc.root.children.length >= baseLayers, '不应撤到比初始更少');
  },

  /* 结构记录的字节估算：删除带像素的大图层，应比新建空图层更"重" */
  '删除带内容的图层计入更高开销': async ({ achi, assert }) => {
    const doc = achi.doc;
    const hist = achi.history;

    /* 情形一：新建空图层 */
    let p = hist.beginStructure(doc);
    doc.addLayer();
    hist.commitStructure(p, '新建图层');
    const emptyCost = hist.stack[hist.stack.length - 1].bytes;

    /* 情形二：给某层铺上内容后删除它 */
    const victim = doc.activeLeaf;
    victim.canvas.forEachTileInBounds(0, 0, doc.w, doc.h, (ctx) => {
      ctx.fillStyle = '#2b6cb0';
      ctx.fillRect(0, 0, doc.w, doc.h);
    });
    doc.addLayer();                       // 保证删除后仍有叶子

    p = hist.beginStructure(doc);
    assert(doc.deleteNode(victim), '删除应成功');
    hist.commitStructure(p, '删除图层');
    const heavyCost = hist.stack[hist.stack.length - 1].bytes;

    assert(heavyCost > emptyCost,
      `删除带内容的图层应计入更高开销（空=${emptyCost} 满=${heavyCost}）`);
  },

  /* 像素记录与结构记录混用时，两者的淘汰互不破坏对方 */
  '像素与结构记录混用后均可撤销': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    const hist = achi.history;
    const node = doc.activeLeaf;

    /* 一条像素记录。
     * 顺序很关键：grabRegion 必须在**绘制之前**调用，它拍摄的是「动手前」的像素；
     * 若在绘制之后才拍，快照里已经含内容，撤销自然清不掉。 */
    const sp = hist.beginStroke(node.canvas);
    hist.grabRegion(sp, 0, 0, 100, 100);
    node.canvas.forEachTileInBounds(0, 0, 100, 100, (ctx) => {
      ctx.fillStyle = '#e2453d';
      ctx.fillRect(0, 0, 100, 100);
    });
    hist.commit(sp);

    /* 一条结构记录 */
    const st = hist.beginStructure(doc);
    doc.addLayer();
    hist.commitStructure(st, '新建图层');

    const layersAfter = doc.root.children.length;

    /* 先撤结构，再撤像素 */
    assert(hist.undo(doc.activeLeaf && doc.activeLeaf.canvas), '撤销结构记录应成功');
    assertEq(doc.root.children.length, layersAfter - 1, '图层应减少');

    assert(hist.undo(node.canvas), '撤销像素记录应成功');

    /* 像素应被清空 */
    let ink = 0;
    for (const t of node.canvas.tiles.values()) {
      const d = t.ctx.getImageData(0, 0, 256, 256).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
    }
    assertEq(ink, 0, '撤销后该区域应无像素');
  },
};
