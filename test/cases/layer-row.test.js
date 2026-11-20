/* 图层行的缩略图与蒙版缩略图
 *
 * 缺陷来源：`.lay-row` 写死 height: 24px，而缩略图是 32×32 的 canvas，
 * 溢出 8px，压到下一行上。图层行与蒙版行成对出现时最明显。
 *
 * 断言的是**几何关系**（元素矩形是否被行容器包住），而不是某个具体像素值。
 * 这样即使将来调整行高或缩略图尺寸，只要两者仍然互相匹配，用例依旧成立。
 */

const CASES = {
  /* 所有缩略图必须完整落在所在行内 */
  '缩略图不超出图层行': async ({ assert, assertEq }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const rows = [...document.querySelectorAll('.lay-row')];
    assert(rows.length >= 1, `应存在图层行，实际 ${rows.length} 行`);

    const problems = [];
    let checked = 0;

    for (const row of rows) {
      const rb = row.getBoundingClientRect();
      const thumb = row.querySelector('canvas.lay-thumb');
      if (!thumb) continue;
      checked++;

      const tb = thumb.getBoundingClientRect();
      /* 上下各允许 0.5px 的亚像素误差 */
      const overflowTop = rb.top - tb.top;
      const overflowBottom = tb.bottom - rb.bottom;
      if (overflowTop > 0.5 || overflowBottom > 0.5) {
        problems.push(
          `行高 ${rb.height.toFixed(1)} / 缩略图 ${tb.height.toFixed(1)} ` +
          `上溢 ${overflowTop.toFixed(1)} 下溢 ${overflowBottom.toFixed(1)}`);
      }
    }

    assert(checked > 0, '应至少检查到一个缩略图');
    assertEq(problems.length, 0, `缩略图不应超出图层行：${problems.join(' | ')}`);
  },

  /* 蒙版行与图层行同构，同样适用 */
  '蒙版缩略图不超出所在行': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const maskRows = [...document.querySelectorAll('.lay-row.mask-row')];
    /* 当前文档可能没有蒙版，此时该断言语义上不适用，直接通过。 */
    if (!maskRows.length) return;

    for (const row of maskRows) {
      const rb = row.getBoundingClientRect();
      const thumb = row.querySelector('canvas.lay-thumb');
      if (!thumb) continue;
      const tb = thumb.getBoundingClientRect();
      assert(rb.top - tb.top <= 0.5 && tb.bottom - rb.bottom <= 0.5,
        `蒙版缩略图超出所在行：上溢 ${(rb.top - tb.top).toFixed(1)} 下溢 ${(tb.bottom - rb.bottom).toFixed(1)}`);
    }
  },

  /* 行高必须足够容纳缩略图 —— 这是上面两条的根因约束 */
  '行高足以容纳缩略图': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const row = document.querySelector('.lay-row');
    assert(!!row, '应存在图层行');

    const thumb = row.querySelector('canvas.lay-thumb');
    if (!thumb) return;   // 组行可能没有缩略图

    const rb = row.getBoundingClientRect();
    const tb = thumb.getBoundingClientRect();
    assert(rb.height >= tb.height,
      `行高 ${rb.height.toFixed(1)} 必须不小于缩略图高度 ${tb.height.toFixed(1)}`);
  },

  /* 溢出修复后，缩略图应仍在行内垂直居中 */
  '缩略图在行内垂直居中': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const row = document.querySelector('.lay-row');
    assert(!!row, '应存在图层行');
    const thumb = row.querySelector('canvas.lay-thumb');
    if (!thumb) return;

    const rb = row.getBoundingClientRect();
    const tb = thumb.getBoundingClientRect();
    const rowCenter = (rb.top + rb.bottom) / 2;
    const thumbCenter = (tb.top + tb.bottom) / 2;

    assert(Math.abs(rowCenter - thumbCenter) <= 1.5,
      `缩略图应垂直居中，实际偏差 ${Math.abs(rowCenter - thumbCenter).toFixed(2)}px`);
  },
};
