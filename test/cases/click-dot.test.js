/* 空笔画不补点
 *
 * 历史上画笔引擎有一段「补点」逻辑：这一笔什么都没画出来时，在抬笔位置
 * 补一个 dab，让「点一下不移动」也能留下一个点（多数 .myb 按走过的距离
 * 采样，指针不动时不会落任何 dab）。
 *
 * 但它在实际使用中持续制造问题：快速笔画可能没被 pump() 计到，判据把它
 * 当成空笔画，于是补出一个满压力的大点，表现为笔画末端或起点附近多出
 * 一个圆点／菱形块。先后换过判据（paintedTiles → wasm 落墨回报）、
 * 压过补点压力上限，都只能缩小它、不能根除。
 *
 * 现在整体关闭（DOT_ON_EMPTY_STROKE = false）：
 * 画出来的东西严格等于「笔尖真正走过的路径」。
 * 代价是纯点按不再留下墨点 —— 需要点的场合，按下后移动一点点即可。
 */

/* 统计图层的墨点数 */
function inkCount(layer) {
  let n = 0;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  }
  return n;
}

const CASES = {
  /* 纯点按（按下即抬起，没有移动）不应留下墨点 */
  '纯点按不产生墨点': async ({ achi, assertEq }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) {
      await new Promise(r => setTimeout(r, 100));
    }
    assertEq(hk.ready, true, 'hokusai 引擎应已就绪');

    const layer = achi.doc.activeLeaf.canvas;
    const before = inkCount(layer);

    hk.begin(200, 300, 1.0, { size: 80, color: '#000000', opacity: 1 });
    hk.end();
    hk.flush();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    assertEq(inkCount(layer) - before, 0, '纯点按不应补出墨点');
  },

  /* 拖一点点就应正常出笔画 —— 确认关掉补点没有伤到正常绘制 */
  '轻微拖动即有笔画': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const layer = achi.doc.activeLeaf.canvas;
    const before = inkCount(layer);

    hk.begin(200, 400, 1.0, { size: 80, color: '#000000', opacity: 1 });
    hk.lastT = performance.now() / 1000;
    hk.move(200, 460, 1.0, {});          // 只移动 60px
    hk.end();
    hk.flush();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const after = inkCount(layer) - before;
    assert(after > 0, `轻微拖动应画出笔画，实际墨点 ${after}`);
  },
};
