/* 压感的取值判定
 *
 * 缺陷来源：网页版没有压感。
 *
 * 原实现只按 pointerType 分支：
 *
 *   if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
 *   return 1;
 *
 * 问题在于「名义上是 pen」不等于「真的提供了压力数据」。
 * 部分浏览器 / 驱动会把数位板报成 pen 却始终只给 0.5 这个占位值，
 * 于是整条线都按 0.5 的压力画 —— 而 0.5 在 .myb 的 radius 曲线上
 * 只对应 -0.35，直径缩减一半以上，看起来就是「没有压感」。
 *
 * 改为观测本笔的压力范围：压力在变就采信，始终不变则按满压。
 */

window.__t = {
  /* 构造一个最小的伪指针事件 */
  ev(pointerType, pressure) {
    return { pointerType, pressure };
  },
};

const CASES = {
  /* 正常压感笔：压力变化时采用真实值 */
  '压感笔采用真实压力': async ({ achi, assert }) => {
    const { pressureOf, resetPressureObs } = achi;
    resetPressureObs();

    const seq = [0.15, 0.35, 0.6, 0.85, 1.0];
    const got = seq.map(p => pressureOf(window.__t.ev('pen', p)));

    for (let i = 0; i < seq.length; i++) {
      /* 前三个样本尚不足以判定「是否变化」，按有压感处理；
       * 之后压力确实在变，继续采信真实值。 */
      assert(Math.abs(got[i] - seq[i]) < 0.001,
        `第 ${i + 1} 个压力应采信真实值 ${seq[i]}，实际 ${got[i]}`);
    }
  },

  /* 报成 pen 但压力恒定：
   * 笔画过程中照实画（不中途切换），笔画结束后判定为无压感，
   * 之后的笔按满压。 */
  '压力恒定的 pen 在笔画结束后判为无压感': async ({ achi, assert }) => {
    const { pressureOf, resetPressureObs, settlePressureObs } = achi;
    const before = achi.penPressureUsable;
    achi.penPressureUsable = null;

    resetPressureObs();
    const got = [];
    for (let i = 0; i < 6; i++) got.push(pressureOf(window.__t.ev('pen', 0.5)));

    /* 笔画内必须一致 —— 中途切换会造成线条粗细突变 */
    const uniq = [...new Set(got)];
    assert(uniq.length === 1, `笔画内压力应一致，实际 ${got.join(',')}`);

    /* 结算后判定为无压感 */
    settlePressureObs();
    assert(achi.penPressureUsable === false,
      `结算后应判定为无压感，实际 ${achi.penPressureUsable}`);

    achi.penPressureUsable = before;
  },

  /* 鼠标：压力恒 0.5，一律满压 */
  '鼠标一律满压': async ({ achi, assert, assertEq }) => {
    const { pressureOf, resetPressureObs } = achi;
    resetPressureObs();

    for (let i = 0; i < 5; i++) {
      assertEq(pressureOf(window.__t.ev('mouse', 0.5)), 1, '鼠标应按满压');
    }
  },

  /* 非 pen 设备但压力在变（被误报为 mouse 的数位板）也采信 */
  '误报为鼠标但有压力变化时采信': async ({ achi, assert }) => {
    const { pressureOf, resetPressureObs } = achi;
    resetPressureObs();

    const seq = [0.2, 0.9, 0.2, 0.9];
    const got = seq.map(p => pressureOf(window.__t.ev('mouse', p)));

    /* 0.2 与 0.9 都不是 0.5 这个占位值，应被采信 */
    assert(Math.abs(got[0] - 0.2) < 0.001, `首个压力应为 0.2，实际 ${got[0]}`);
    assert(Math.abs(got[1] - 0.9) < 0.001, `次个压力应为 0.9，实际 ${got[1]}`);
  },

  /* 压力为 0（悬停等无效值）不能把笔迹画成零宽 */
  '压力为零时不返回零': async ({ achi, assert }) => {
    const { pressureOf, resetPressureObs } = achi;
    resetPressureObs();

    const v = pressureOf(window.__t.ev('pen', 0));
    assert(v > 0, `无效压力不应返回 0（会导致零宽笔迹），实际 ${v}`);
  },

  /* 判定为无压感后，只要又观测到压力变化，应立刻恢复采信 */
  '设备判定可自愈': async ({ achi, assert }) => {
    const { pressureOf, resetPressureObs } = achi;
    const before = achi.penPressureUsable;

    achi.penPressureUsable = false;      // 模拟「已判为无压感」
    resetPressureObs();

    const got = [];
    for (const p of [0.2, 0.8, 0.3, 0.7]) got.push(pressureOf(window.__t.ev('pen', p)));

    assert(achi.penPressureUsable === true,
      '观测到压力变化后应恢复为可用');
    assert(Math.abs(got[1] - 0.8) < 0.001,
      `恢复后应采信真实压力，实际 ${got[1]}`);

    achi.penPressureUsable = before;
  },

  /* 画布必须自己接管指针手势，否则浏览器会中断笔迹、丢弃压力 */
  '画布设置了 touch-action': async ({ assert }) => {
    const view = document.getElementById('view');
    assert(!!view, '应存在主画布');

    const cs = getComputedStyle(view);
    assert(cs.touchAction === 'none',
      `#view 的 touch-action 应为 none，实际 ${cs.touchAction}`);

    const stage = document.getElementById('stage');
    if (stage) {
      const ss = getComputedStyle(stage);
      assert(ss.touchAction === 'none',
        `#stage 的 touch-action 应为 none，实际 ${ss.touchAction}`);
    }
  },
};

/* ---------- Safari：合并事件不完整的 PointerEvent ----------
 *
 * Safari 的 getCoalescedEvents() 返回的合并事件里 pressure 常为 0，
 * 而原始事件带有真实压力。原实现整体用合并事件替代原始事件，
 * 于是压力全部变成 0 → 判为无压感 → 整笔满压。
 *
 * 实测修复前后：
 *   修复前  压力序列 [0.25, 1, 1, 1, 1, 1, 1]   只有首笔有效
 *   修复后  [0.25, 0.35, 0.45, …]              全程有效
 */

/* 构造一个「Safari 式」事件：自身有压力，合并事件压力全 0 */
function safariLike(type, pressure, x, y) {
  const e = new PointerEvent(type, {
    pointerType: 'pen', pressure, buttons: 1, bubbles: true,
    clientX: x, clientY: y, pointerId: 9,
  });
  Object.defineProperty(e, 'getCoalescedEvents', {
    value: () => [
      { pressure: 0, clientX: x, clientY: y },
      { pressure: 0, clientX: x + 2, clientY: y },
    ],
  });
  return e;
}

CASES['Safari 式合并事件不丢压感'] = async ({ achi, assert }) => {
  const hk = achi.hk;
  if (!hk.ready) return;    // 引擎未就绪时该路径不适用

  const seen = [];
  const oB = hk.begin.bind(hk), oM = hk.move.bind(hk);
  hk.begin = (x, y, p, o) => { seen.push(+p.toFixed(3)); return oB(x, y, p, o); };
  hk.move = (x, y, p, o) => { seen.push(+p.toFixed(3)); return oM(x, y, p, o); };

  try {
    const view = document.getElementById('view');
    const r = view.getBoundingClientRect();
    const cx = r.left + r.width / 2 - 100;
    const cy = r.top + r.height / 2;

    view.dispatchEvent(safariLike('pointerdown', 0.25, cx, cy));
    for (let i = 1; i <= 6; i++) {
      view.dispatchEvent(safariLike('pointermove', 0.25 + i * 0.1, cx + i * 10, cy));
    }
    view.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'pen', pressure: 0.85, buttons: 0, bubbles: true,
      clientX: cx + 60, clientY: cy, pointerId: 9,
    }));
  } finally {
    hk.begin = oB; hk.move = oM;
  }

  const uniq = [...new Set(seen)];
  assert(uniq.length > 2,
    `合并事件压力为 0 时应回退到原始事件压力，实际只有 ${uniq.length} 种取值：${uniq.join(',')}`);
};

/* 合并事件压力有效时，仍应优先使用它自己的值（不要让兜底盖掉） */
CASES['合并事件压力有效时优先采用'] = async ({ achi, assert }) => {
  const { pressureOf, resetPressureObs } = achi;
  resetPressureObs();

  const ev = { pointerType: 'pen', pressure: 0 };
  /* 自身无效 → 用兜底 */
  const a = pressureOf(ev, 0.7);
  assert(Math.abs(a - 0.7) < 0.001, `应回退到兜底压力 0.7，实际 ${a}`);

  /* 自身有效 → 不用兜底 */
  resetPressureObs();
  const b = pressureOf({ pointerType: 'pen', pressure: 0.3 }, 0.9);
  assert(Math.abs(b - 0.3) < 0.001, `应优先用自身压力 0.3，实际 ${b}`);
};

/* ---------- 笔画中途不得切换压力 ----------
 *
 * 曾经的实现按「压力是否变化」实时判断：前几个样本不足以判断时用真实值，
 * 样本够了判定为「恒定」，立刻切到满压。
 * 结果：画一条用力稳定的线，前两点细、之后全粗，末端出现一个明显粗块。
 *
 * 判定改为在一笔结束之后结算，笔画过程中压力必须连续。
 */

/* 构造恒定压力的 pen 事件序列，返回引擎收到的压力 */
function simulateStroke(hk, view, pressure, steps = 12) {
  const seen = [];
  const oB = hk.begin.bind(hk), oM = hk.move.bind(hk);
  hk.begin = (x, y, p, o) => { seen.push(+p.toFixed(3)); return oB(x, y, p, o); };
  hk.move = (x, y, p, o) => { seen.push(+p.toFixed(3)); return oM(x, y, p, o); };

  try {
    const r = view.getBoundingClientRect();
    const cx = r.left + r.width / 2 - 120;
    const cy = r.top + r.height / 2;
    const mk = (t, p, x, y) => new PointerEvent(t, {
      pointerType: 'pen', pressure: p, buttons: 1, bubbles: true,
      clientX: x, clientY: y, pointerId: 11,
    });

    view.dispatchEvent(mk('pointerdown', pressure, cx, cy));
    for (let i = 1; i <= steps; i++) {
      view.dispatchEvent(mk('pointermove', pressure, cx + i * 8, cy + i * 2));
    }
    view.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'pen', pressure, buttons: 0, bubbles: true,
      clientX: cx + steps * 8, clientY: cy + steps * 2, pointerId: 11,
    }));
  } finally {
    hk.begin = oB; hk.move = oM;
  }
  return seen;
}

CASES['恒压笔画不出现中途突变'] = async ({ achi, assert }) => {
  const hk = achi.hk;
  if (!hk.ready) return;

  const before = achi.penPressureUsable;
  achi.penPressureUsable = null;   // 强制回到「未判定」状态

  const view = document.getElementById('view');
  const seq = simulateStroke(hk, view, 0.3);

  /* 整笔必须同一个压力，不能在某个点突然跳到 1 */
  const uniq = [...new Set(seq)];
  assert(uniq.length === 1,
    `整笔压力应保持一致，实际出现 ${uniq.length} 种取值：${seq.join(',')}`);

  achi.penPressureUsable = before;
};

/* 一笔结束后才结算设备判定，且不影响已完成的那一笔 */
CASES['笔画结束才结算设备判定'] = async ({ achi, assert, assertEq }) => {
  const hk = achi.hk;
  if (!hk.ready) return;

  const before = achi.penPressureUsable;
  achi.penPressureUsable = null;

  const view = document.getElementById('view');
  /* 第一笔恒压：过程中全部 0.3，结束后判定为无压感 */
  const first = simulateStroke(hk, view, 0.3);
  assertEq([...new Set(first)].length, 1, '第一笔内部压力应一致');
  assertEq(achi.penPressureUsable, false, '恒压一笔结束后应判定为无压感');

  /* 第二笔：设备已判定无压感，按满压 */
  const second = simulateStroke(hk, view, 0.3);
  assertEq(achi.penPressureUsable, false, '判定应保持');
  assert(second[0] > 0.9, `已判定无压感时应按满压，实际 ${second[0]}`);

  achi.penPressureUsable = before;
};
