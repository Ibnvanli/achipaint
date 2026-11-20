/* 性能探针与控制台
 *
 * 缺陷来源：控制台「性能」页所有指标显示 null。
 * 根因不是统计逻辑，而是探针从未记录过任何一帧 ——
 * perfMark() 首行是 `if (!window.__achiPerf) return;`，
 * 而 window.__achiPerf 正是在该函数末尾才被赋值，
 * 于是第一次调用即返回，之后再无调用能通过该判断。
 */

const CASES = {
  /* 探针必须真的在记录帧数据 */
  '性能探针会记录帧样本': async ({ achi, assert }) => {
    /* 触发若干次重绘，产生帧样本 */
    for (let i = 0; i < 5; i++) {
      achi.redraw();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }

    const perf = window.__achiPerf;
    assert(Array.isArray(perf), `__achiPerf 应为数组，实际 ${typeof perf}`);
    assert(perf.length > 0, `应已记录帧样本，实际 ${perf.length} 条`);

    /* 样本字段必须可用。gap 依赖「上一次绘制时间」，首帧为 0 属正常；
     * 但至少要有非零值，否则说明时间戳没有在更新。 */
    const withGap = perf.filter(p => p.gap > 0).length;
    assert(withGap > 0, '应存在帧间隔大于 0 的样本');
  },

  /* 帧间隔必须是合理量级，不能是 0 或异常大 */
  '帧间隔数值处于合理范围': async ({ achi, assert }) => {
    for (let i = 0; i < 6; i++) {
      achi.redraw();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }

    const gaps = window.__achiPerf.map(p => p.gap).filter(v => v > 0);
    assert(gaps.length > 0, '应存在有效帧间隔');

    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    /* 隐藏窗口的 rAF 可能被降频，上限放宽到 1000ms；
     * 下限 1ms —— 小于 1ms 说明时间戳算错了。 */
    assert(avg > 1 && avg < 1000, `帧间隔均值应在 1–1000ms，实际 ${avg.toFixed(1)}ms`);
  },

  /* 探针可被关闭，关闭后不再增长 */
  '探针可关闭': async ({ achi, assert, assertEq }) => {
    achi.redraw();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = window.__achiPerf.length;

    window.__achiPerfOff = true;
    assertEq(window.__achiPerfOff, true, '开关应生效');

    for (let i = 0; i < 3; i++) {
      achi.redraw();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }

    assertEq(window.__achiPerf.length, before, '关闭后不应再新增样本');

    /* 复原，避免影响后续用例 */
    window.__achiPerfOff = false;
  },
};
