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
