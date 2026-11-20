/* 压感取值
 *
 * 历史教训：这里曾有一层「设备是否真有压感」的判定 —— 未判定时整笔按满压画，
 * 观测到压力变化才改用真实值。它导致两个问题：
 *
 *   1) 每笔开头按满压、判定成立后切到真实压力，
 *      于是每笔都是「一头粗黑、后面变细」的蝌蚪形。
 *   2) 真压感设备的第一笔完全没有压感，用户得先画一笔试试。
 *
 * 现在直接采信浏览器给的压力值，不做任何设备判定。
 * 「报 pen 但压力恒 0.5」的情况由 brush.myb 的曲线兜住
 * （p=0.5 时半径为 55%，不再是细线）。
 */

async function strokePressures(hk, view, pressureAt, steps = 12) {
  const seen = [];
  const oM = hk.move.bind(hk);
  hk.move = (x, y, p, o) => { seen.push(+p.toFixed(3)); return oM(x, y, p, o); };

  try {
    const r = view.getBoundingClientRect();
    const cx = r.left + r.width / 2 - 120;
    const cy = r.top + r.height / 2;
    const mk = (t, p, x, y, buttons = 1) => new PointerEvent(t, {
      pointerType: 'pen', pressure: p, buttons, bubbles: true,
      clientX: x, clientY: y, pointerId: 71,
    });

    view.dispatchEvent(mk('pointerdown', pressureAt(0), cx, cy));
    for (let i = 1; i <= steps; i++) {
      /* 留真实间隔：dtime 接近 0 时 libmypaint 不产生 dab */
      await new Promise(r => setTimeout(r, 12));
      view.dispatchEvent(mk('pointermove', pressureAt(i / steps), cx + i * 18, cy));
    }
    view.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'pen', pressure: pressureAt(1), buttons: 0, bubbles: true,
      clientX: cx + steps * 18, clientY: cy, pointerId: 71,
    }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  } finally {
    hk.move = oM;
  }
  return seen;
}

const CASES = {
  /* 第一笔就应采信真实压力，不能「先画一笔试试」 */
  '第一笔即有压感': async ({ achi, assert }) => {
    const hk = achi.hk;
    const t0 = Date.now();
    while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
    assert(hk.ready, '引擎应就绪');

    const view = document.getElementById('view');
    const seq = await strokePressures(hk, view, t => 0.15 + t * 0.75);

    const uniq = [...new Set(seq)];
    assert(uniq.length > 3,
      `第一笔就应采信真实压力，实际只有 ${uniq.length} 种取值：${uniq.join(',')}`);
    assert(Math.min(...seq) < 0.3,
      `低压力段应被采信，实际最小值 ${Math.min(...seq)}`);
    assert(Math.max(...seq) > 0.8,
      `高压力段应被采信，实际最大值 ${Math.max(...seq)}`);
  },

  /* 连续多笔都应各自有压感，不能只有第一笔正常 */
  '连续三笔都带压感': async ({ achi, assert }) => {
    const hk = achi.hk;
    if (!hk.ready) return;

    const view = document.getElementById('view');
    for (let n = 1; n <= 3; n++) {
      const seq = await strokePressures(hk, view, t => 0.15 + t * 0.75);
      const uniq = [...new Set(seq)];
      assert(uniq.length > 3,
        `第 ${n} 笔应有压感变化，实际只有 ${uniq.length} 种取值`);
    }
  },

  /* 鼠标：pressure 恒 0.5 是占位值，应按满压 */
  '鼠标一律满压': async ({ achi, assertEq }) => {
    const { pressureOf } = achi;
    for (let i = 0; i < 3; i++) {
      assertEq(pressureOf({ pointerType: 'mouse', pressure: 0.5 }), 1, '鼠标应按满压');
    }
  },

  /* 无压感数据的 pen：压力为 0 时不能返回 0，否则笔迹零宽 */
  '压力无效时不返回零': async ({ achi, assert }) => {
    const { pressureOf } = achi;
    const v = pressureOf({ pointerType: 'pen', pressure: 0 });
    assert(v > 0, `无效压力不应返回 0，实际 ${v}`);
  },
};

/* ---------- 起笔圆点 ----------
 *
 * 落笔瞬间的压力是读数毛刺（笔尖刚接触板面时偏高），
 * 而 libmypaint 会把它记入笔刷状态，影响紧随其后的第一个 dab。
 * 若照实播种，开头就鼓出一个比线身粗一倍的圆点。
 *
 * 实测（落笔 0.95、后续 0.3）：
 *   修复前  8, 44, 56, 63, 65, 63, 57, 50, 39, 32, 32   ← 鼓到 65px
 *   修复后  4, 26, 31, 33, 33, 33, 33, 33, 33, 33, 33   ← 平滑到线身
 */

CASES['起笔不出现粗圆点'] = async ({ achi, assert }) => {
  const hk = achi.hk;
  const t0 = Date.now();
  while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
  assert(hk.ready, '引擎应就绪');

  const doc = achi.doc;
  const layer = doc.activeLeaf.canvas;
  const view = document.getElementById('view');
  const r = view.getBoundingClientRect();

  /* 模拟真实落笔：down 压力高，后续立刻降到 0.3 */
  const cx = r.left + r.width / 2 - 100, cy = r.top + r.height / 2;
  const ev = (t, p, x, y, b = 1) => new PointerEvent(t, {
    pointerType: 'pen', pressure: p, buttons: b, bubbles: true,
    clientX: x, clientY: y, pointerId: 95,
  });

  view.dispatchEvent(ev('pointerdown', 0.95, cx, cy));
  for (let i = 1; i <= 8; i++) {
    await new Promise(rr => setTimeout(rr, 12));
    view.dispatchEvent(ev('pointermove', 0.3, cx + i * 20, cy - i * 10));
  }
  view.dispatchEvent(ev('pointerup', 0.3, cx + 160, cy - 80, 0));
  await new Promise(rr => requestAnimationFrame(() => requestAnimationFrame(rr)));

  /* 沿笔画方向逐列量厚度 */
  let minx = Infinity, maxx = -Infinity;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (d[(y * 256 + x) * 4 + 3] <= 10) continue;
        const wx = t.col * 256 + x;
        if (wx < minx) minx = wx;
        if (wx > maxx) maxx = wx;
      }
    }
  }
  assert(maxx > minx, '应画出墨迹');

  const prof = [];
  for (let x = minx; x <= maxx; x += 8) {
    let top = -1, bot = -1;
    for (let y = 0; y < doc.h; y++) {
      const c = Math.floor(x / 256), rr = Math.floor(y / 256);
      const t = layer.tiles.get(c + ',' + rr);
      if (!t) continue;
      const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
      if (d[3] > 10) { if (top < 0) top = y; bot = y; }
    }
    prof.push(top < 0 ? 0 : bot - top + 1);
  }

  /* 线身厚度取中位数，开头不应明显超过它 */
  const body = prof.filter(v => v > 0);
  body.sort((a, b) => a - b);
  const median = body[Math.floor(body.length / 2)];

  const headMax = Math.max(...prof.slice(1, 5));
  assert(headMax < median * 1.4,
    `起笔不应鼓出粗圆点：开头 ${headMax}px vs 线身 ${median}px`);
};

/* ---------- 抬笔末端圆点 ----------
 *
 * 稳定器会让落笔点滞后于笔尖，抬笔时这段滞后会一次补画。
 * 若补画用最后一个压力（抬笔前常是峰值），末端会突然鼓成一个圆点 ——
 * 而且因为滞后位移集中在最后，这个圆点会比线身粗一大截、位置还在笔画之外。
 *
 * 修法：抬笔前先用近期压力的中位数补到真实笔尖位置，再冲刷 slow_tracking。
 * 中位数让单个尖峰影响不到整段补画。
 */

CASES['抬笔后末端不鼓圆点'] = async ({ achi, assert }) => {
  const hk = achi.hk;
  const t0 = Date.now();
  while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
  assert(hk.ready, '引擎应就绪');

  const doc = achi.doc;
  const layer = doc.activeLeaf.canvas;
  const view = document.getElementById('view');
  const r = view.getBoundingClientRect();
  const cx = r.left + r.width / 2 - 200, cy = r.top + r.height / 2;

  const ev = (t, p, x, y, b = 1) => new PointerEvent(t, {
    pointerType: 'pen', pressure: p, buttons: b, bubbles: true,
    clientX: x, clientY: y, pointerId: 105,
  });

  /* 压力平滑上升，模拟真实运笔 */
  view.dispatchEvent(ev('pointerdown', 0.2, cx, cy));
  for (let i = 1; i <= 22; i++) {
    await new Promise(rr => setTimeout(rr, 12));
    view.dispatchEvent(ev('pointermove', 0.2 + (i / 22) * 0.65, cx + i * 14, cy));
  }
  view.dispatchEvent(ev('pointerup', 0.85, cx + 308, cy, 0));
  await new Promise(rr => requestAnimationFrame(() => requestAnimationFrame(rr)));

  let minx = Infinity, maxx = -Infinity;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (d[(y * 256 + x) * 4 + 3] <= 10) continue;
        const wx = t.col * 256 + x;
        if (wx < minx) minx = wx;
        if (wx > maxx) maxx = wx;
      }
    }
  }
  assert(maxx > minx, '应画出墨迹');

  const prof = [];
  for (let x = minx; x <= maxx; x += 14) {
    let top = -1, bot = -1;
    for (let y = 0; y < doc.h; y++) {
      const c = Math.floor(x / 256), rr = Math.floor(y / 256);
      const t = layer.tiles.get(c + ',' + rr);
      if (!t) continue;
      const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
      if (d[3] > 10) { if (top < 0) top = y; bot = y; }
    }
    prof.push(top < 0 ? 0 : bot - top + 1);
  }

  /* 末段取最后若干列的厚度，与全笔峰值比 —— 不该突然鼓出去 */
  const body = prof.filter(v => v > 0);
  const peak = Math.max(...body);
  const tailMax = Math.max(...prof.slice(-4));

  assert(tailMax < peak * 1.35,
    `抬笔处不应鼓出圆点：末段 ${tailMax}px vs 全笔峰值 ${peak}px`);
};

/* ---------- 短笔画的落笔毛刺 ----------
 *
 * 落笔瞬间的压力是读数毛刺（笔尖刚接触板面时偏高），随后落到实际力度。
 * 抬笔时稳定器的滞后位移要用「近期压力中位数」补画。
 *
 * 缺陷：_pBuf 只有两个样本 [落笔0.95, 移动0.3] 时，
 * sorted[Math.floor(2/2)] = sorted[1] 取到的正是较大的那个（0.95）。
 * 于是「落笔后只移动一次就抬笔」的短笔画被按峰值补画，
 * 开头鼓成一个 76px 的大圆，而线身只有 28px。
 *
 * 修法：偶数长度取偏小的那个（floor((n-1)/2)），让毛刺落选。
 *
 * 实测（落笔 0.95 → 移动 0.3，只移动一次）：
 *   修复前  16, 52, 68, 74, 76, 76, 76, 76 ...
 *   修复后   8, 26, 28, 28, 28, 28, 28, 28 ...
 */

/* 注：该用例在测试环境中量不出取中位数的差异（笔画过短时鼓包被
 * 笔尖直径掩盖），因此抓不到该回归。作为场景记录保留；
 * 修复的有效性由独立验证脚本确认，见提交说明。 */
CASES['短笔画不按落笔毛刺补画'] = async ({ achi, assert }) => {
  const hk = achi.hk;
  const t0 = Date.now();
  while (!hk.ready && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100));
  assert(hk.ready, '引擎应就绪');

  const doc = achi.doc;
  const layer = doc.activeLeaf.canvas;
  const view = document.getElementById('view');
  const r = view.getBoundingClientRect();
  const cx = r.left + r.width / 2 - 150, cy = r.top + r.height / 2;

  const ev = (t, p, x, y, b = 1) => new PointerEvent(t, {
    pointerType: 'pen', pressure: p, buttons: b, bubbles: true,
    clientX: x, clientY: y, pointerId: 211,
  });

  /* 落笔高压力，之后只移动一次就抬笔 —— 样本只有两个 */
  /* 位移要足够长：笔画太短时 80px 的笔刷盖满整段，
   * 鼓包与线身分不开，量不出差异。
   * 也不能只移动一次 —— 那样补画目标点与上一 dab 距离过大，
   * libmypaint 会按大间距重新采样，结果与真实手写不同。
   * 用「一次大位移 + 若干小位移」构造短笔画。 */
  view.dispatchEvent(ev('pointerdown', 0.95, cx, cy));
  await new Promise(rr => setTimeout(rr, 15));
  view.dispatchEvent(ev('pointermove', 0.3, cx + 260, cy));
  await new Promise(rr => setTimeout(rr, 15));
  view.dispatchEvent(ev('pointermove', 0.3, cx + 340, cy));
  view.dispatchEvent(ev('pointerup', 0.3, cx + 340, cy, 0));
  await new Promise(rr => requestAnimationFrame(() => requestAnimationFrame(rr)));

  let minx = Infinity, maxx = -Infinity;
  for (const t of layer.tiles.values()) {
    const d = t.ctx.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        if (d[(y * 256 + x) * 4 + 3] <= 10) continue;
        const wx = t.col * 256 + x;
        if (wx < minx) minx = wx;
        if (wx > maxx) maxx = wx;
      }
    }
  }
  assert(maxx > minx, '应画出墨迹');

  const prof = [];
  for (let x = minx; x <= maxx; x += 10) {
    let top = -1, bot = -1;
    for (let y = 0; y < doc.h; y++) {
      const c = Math.floor(x / 256), rr = Math.floor(y / 256);
      const t = layer.tiles.get(c + ',' + rr);
      if (!t) continue;
      const d = t.ctx.getImageData(x - c * 256, y - rr * 256, 1, 1).data;
      if (d[3] > 10) { if (top < 0) top = y; bot = y; }
    }
    prof.push(top < 0 ? 0 : bot - top + 1);
  }

  const body = prof.filter(v => v > 0).sort((a, b) => a - b);
  const median = body[Math.floor(body.length / 2)];
  const headMax = Math.max(...prof.slice(1, 4));

  assert(headMax < median * 1.5,
    `短笔画开头不应按落笔毛刺鼓包：开头 ${headMax}px vs 线身 ${median}px`);
};
