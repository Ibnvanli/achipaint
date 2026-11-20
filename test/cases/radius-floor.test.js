/* 收笔半径下限
 *
 * 缺陷来源：.myb 笔刷的 radius_logarithmic 压力响应很陡，压力趋近 0 时
 * 半径也趋近 0，笔画末端拖出一根细长的针尖。用户反馈为「大拖尾」。
 *
 * 实测同一笔（压力从 1.0 线性降到 0.02）的厚度剖面：
 *   无下限  64 → 36 → 22 → 14 → 10 → 8 → 6 → 4 → 2 → 消失
 *   有下限  64 → 36 → 22 → 18 → 16 → 16 → 16 → 16（稳住）
 *
 * 半径下限取满压力半径的 20%：收笔仍保留可辨识的粗细，
 * 又不至于把压感压平。
 */

const MIN_RATIO = 0.2;

const CASES = {
  /* 压力降到很低时，线宽不应低于满压力时的下限比例 */
  '收笔保持最小半径': async ({ achi, assert }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert(hk.ready, 'hokusai 引擎应已就绪');

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const SIZE = 80;

    /* 压力从 1.0 线性降到 0.02 */
    hk.begin(100, 300, 1.0, { size: SIZE, color: '#000000', opacity: 1 });
    hk.lastT = performance.now() / 1000;
    for (let i = 1; i <= 40; i++) {
      hk.lastT -= 0.004;
      hk.move(100 + i * 12, 300, 1.0 - (i / 40) * 0.98, {});
    }
    hk.end();
    hk.flush();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    /* 量厚度剖面 */
    const thicknessAt = x => {
      let top = -1, bot = -1;
      for (let y = 180; y <= 420; y++) {
        const c = Math.floor(x / 256), rr = Math.floor(y / 256);
        const t = layer.tiles.get(c + ',' + rr);
        if (!t) continue;
        const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
        if (d[3] > 8) { if (top < 0) top = y; bot = y; }
      }
      return top < 0 ? 0 : bot - top + 1;
    };

    const head = thicknessAt(160);   // 起笔附近，压力最大
    assert(head > 0, '起笔处应画出可见墨迹');

    /* 沿整条线找最小非零厚度 */
    let minThick = Infinity;
    for (let x = 200; x <= 560; x += 20) {
      const t = thicknessAt(x);
      if (t > 0 && t < minThick) minThick = t;
    }
    assert(minThick < Infinity, '笔画应覆盖中段');

    const ratio = minThick / head;
    assert(ratio >= MIN_RATIO * 0.7,
      `收笔处不应细成针：最小厚度 ${minThick}px / 最粗 ${head}px = ${(ratio * 100).toFixed(0)}%，` +
      `下限为 ${(MIN_RATIO * 100).toFixed(0)}%`);
  },

  /* 满压力时半径不应被下限影响（下限只托底，不放大） */
  '满压力半径不受影响': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const SIZE = 80;

    hk.begin(120, 300, 1.0, { size: SIZE, color: '#000000', opacity: 1 });
    hk.lastT = performance.now() / 1000;
    for (let i = 1; i <= 20; i++) {
      hk.lastT -= 0.004;
      hk.move(120 + i * 12, 300, 1.0, {});
    }
    hk.end();
    hk.flush();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let maxT = 0;
    for (let x = 140; x <= 300; x += 10) {
      let top = -1, bot = -1;
      for (let y = 180; y <= 420; y++) {
        const c = Math.floor(x / 256), rr = Math.floor(y / 256);
        const t = layer.tiles.get(c + ',' + rr);
        if (!t) continue;
        const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
        if (d[3] > 8) { if (top < 0) top = y; bot = y; }
      }
      const th = top < 0 ? 0 : bot - top + 1;
      if (th > maxT) maxT = th;
    }

    /* 满压力时直径应接近设定值 SIZE，不能被下限放大 */
    assert(maxT <= SIZE * 1.15,
      `满压力时线宽应约为 ${SIZE}px，实际 ${maxT}px`);
    assert(maxT >= SIZE * 0.8,
      `满压力时线宽不应明显偏细，实际 ${maxT}px`);
  },
};
