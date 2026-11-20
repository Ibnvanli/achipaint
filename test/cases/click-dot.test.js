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
 * 一度整体关闭过，但那治不了根：真正的根因是 brush.myb 的半径压力
 * 曲线被改得过于平缓（p=0 时已有 46% 半径），任何低压力 dab 都会鼓包。
 * 曲线恢复原始后，补点重新启用 —— 它是必要功能，纯点按要能留下墨点。
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
  /* 纯点按应留下一个点，且落在点击位置 */
  '纯点按在点击位置留下墨点': async ({ achi, assert }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert(hk.ready, 'hokusai 引擎应已就绪');

    const layer = achi.doc.activeLeaf.canvas;
    const CLICK = { x: 200, y: 300 };

    hk.begin(CLICK.x, CLICK.y, 1.0, { size: 80, color: '#000000', opacity: 1 });
    hk.end();
    hk.flush();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

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
    assert(maxx > minx, '纯点按应留下墨点');

    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    assert(Math.abs(cx - CLICK.x) <= 3,
      `墨点应落在点击位置，水平偏移 ${(cx - CLICK.x).toFixed(1)}px`);
    assert(Math.abs(cy - CLICK.y) <= 3,
      `墨点应落在点击位置，垂直偏移 ${(cy - CLICK.y).toFixed(1)}px`);
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
