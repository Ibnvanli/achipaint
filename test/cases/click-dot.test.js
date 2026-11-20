/* 单击落点位置
 *
 * 缺陷来源：画笔引擎在「这一笔没画出任何东西」时会补一个点，
 * 让按距离采样的 .myb 笔刷也能响应单击。
 *
 * 补点位置写的是 lastX + radius * 0.55 —— 半径的 55%。
 * 半径 40px 时点会偏出点击位置 22px，表现为落笔处莫名多出一个
 * 偏离笔尖的墨点。实测点击 (200,300)，墨迹中心落在 (210,300)。
 *
 * 位移的真实用途只是「让按距离采样的笔刷认为走过了一小步」，
 * 1px 就够，没有必要挪半个半径。
 */

const CASES = {
  /* 单击产生的点必须落在点击位置 */
  '单击点不偏离点击位置': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) {
      const t0 = Date.now();
      while (!hk.ready && Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    assert(hk.ready, 'hokusai 引擎应已就绪');

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
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

    assert(maxx > minx, '单击应画出可见的墨点');

    const cx = (minx + maxx) / 2;
    const cy = (miny + maxy) / 2;
    assert(Math.abs(cx - CLICK.x) <= 3,
      `墨点应落在点击位置，水平偏移 ${(cx - CLICK.x).toFixed(1)}px`);
    assert(Math.abs(cy - CLICK.y) <= 3,
      `墨点应落在点击位置，垂直偏移 ${(cy - CLICK.y).toFixed(1)}px`);
  },
};
