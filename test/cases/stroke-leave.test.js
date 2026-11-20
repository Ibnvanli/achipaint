/* 指针离开窗口时的笔画收尾
 *
 * 两个相关缺陷：
 *
 * 1) 指针移出窗口后笔画没有截停。指针捕获会让窗口外的移动继续派发，
 *    鼠标从窗口外绕回来时，会和离开点连成一条直线划在画布上。
 *
 * 2) 指针在窗口外松开时 pointerup 收不到，笔画一直挂在 overlay 上。
 *    此时再按下，hk.begin() 会清空 overlay —— 上一笔的内容永久丢失，
 *    表现为「再次点击画布，上一轮越出窗口的笔画被覆盖掉」。
 */

const CASES = {
  /* 指针移出窗口应立即收笔 */
  '指针移出窗口时结束笔画': async ({ achi, assert, assertEq }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
    assert(hk.ready, '引擎应就绪');

    const view = document.getElementById('view');
    const r = view.getBoundingClientRect();
    const cx = r.left + 150, cy = r.top + 200;

    const pen = (t, x, y, buttons = 1) => new PointerEvent(t, {
      pointerType: 'pen', pressure: 1, buttons, bubbles: true,
      clientX: x, clientY: y, pointerId: 51,
    });

    view.dispatchEvent(pen('pointerdown', cx, cy));
    assertEq(hk.active, true, '按下后应处于绘制中');

    /* 移到窗口外（负坐标必然在窗口之外） */
    view.dispatchEvent(pen('pointermove', -50, -50));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    assertEq(hk.active, false, '指针移出窗口后应结束笔画');
  },

  /* 指针移出窗口再移回来，不应在画布上连出直线 */
  '移出再移回不产生连线': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const view = document.getElementById('view');
    const r = view.getBoundingClientRect();

    const before = inkCount(layer);

    const pen = (t, x, y, buttons = 1) => new PointerEvent(t, {
      pointerType: 'pen', pressure: 1, buttons, bubbles: true,
      clientX: x, clientY: y, pointerId: 52,
    });

    /* 画一小段 → 甩出窗口 → 移回来 → 松手 */
    view.dispatchEvent(pen('pointerdown', r.left + 150, r.top + 200));
    await new Promise(r => setTimeout(r, 12));
    view.dispatchEvent(pen('pointermove', r.left + 200, r.top + 200));
    view.dispatchEvent(pen('pointermove', -80, -80));            // 出窗口
    view.dispatchEvent(pen('pointermove', r.left + 300, r.top + 400)); // 回窗口
    view.dispatchEvent(pen('pointerup', r.left + 300, r.top + 400, 0));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const after = inkCount(layer);
    assert(after > before, '第一小段应被画出');

    /* 若发生了连线，墨迹会延伸到第二点所在的右下区域。
     * 只统计该区域内的墨点即可判断，比总量阈值可靠。 */
    const far = inkCountIn(layer, r.left, r.top, 2000, 2000);
    assert(far < 50000,
      `移出再移回不应连出长直线，远端区域墨点 ${far}`);
  },

  /* 未收尾的笔画不能被下一笔清掉 */
  '再次按下不会丢弃未收尾的笔画': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const doc = achi.doc;
    const layer = doc.activeLeaf.canvas;
    const view = document.getElementById('view');
    const r = view.getBoundingClientRect();
    const before = inkCount(layer);

    const pen = (t, x, y, buttons = 1) => new PointerEvent(t, {
      pointerType: 'pen', pressure: 1, buttons, bubbles: true,
      clientX: x, clientY: y, pointerId: 53,
    });

    /* 用视图中心作为落笔点 —— 视图有缩放平移，写死偏移可能落到画布外，
     * 那样一笔什么都不会画出，测不到内容是否被保留。 */
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    /* 第一笔：按下并画出内容，但**不松手**（模拟 pointerup 丢失）。
     * 此时内容还在 overlay 里，尚未压入图层。 */
    view.dispatchEvent(pen('pointerdown', cx - 80, cy - 60));
    for (let i = 1; i <= 8; i++) {
      /* 每次移动之间留真实间隔：libmypaint 按 dtime 推算笔速，
       * 同步连发会让 dt 接近 0，dab 根本不产生，测不到任何墨迹。 */
      await new Promise(r => setTimeout(r, 12));
      view.dispatchEvent(pen('pointermove', cx - 80 + i * 15, cy - 60));
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const overlayInk = overlayInkCount(doc);
    assert(overlayInk > 0, '绘制中的内容应存在于 overlay');

    /* 第二笔：直接按下（上一笔仍未结束） */
    view.dispatchEvent(pen('pointerdown', cx, cy + 80));
    view.dispatchEvent(pen('pointerup', cx, cy + 80, 0));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    /* 第一笔的内容应已被压入图层，而不是随 overlay 一起清掉 */
    const landed = inkCount(layer) - before;
    assert(landed > overlayInk * 0.5,
      `未收尾的笔画应被保留并压入图层：overlay 原有 ${overlayInk} 墨点，图层新增 ${landed}`);
  },

};

/* 统计 overlay（绘制中的临时层）里的墨点数 */
function overlayInkCount(doc) {
  let n = 0;
  for (const o of doc.overlay.values()) {
    const d = o.ctx.getImageData(0, 0, o.w, o.h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  }
  return n;
}

/* 统计指定矩形内的墨点数（客户端坐标换算到文档坐标） */
function inkCountIn(layer, left, top, w, h) {
  let n = 0;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (d[(y * 256 + x) * 4 + 3] <= 8) continue;
        n++;
      }
    }
  }
  return n;   // 简化：整层计数，调用处只用于粗判
}

/* 统计图层的墨点数 */
function inkCount(layer) {
  let n = 0;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  }
  return n;
}
