/* 图层面板：属性条位置与行内元素布局
 *
 * 两个缺陷来源：
 *
 * 1) 属性条遮挡眼睛按钮
 *    属性条此前是 #layers 的首个子元素，并设 position: sticky; top: 0。
 *    滚动时它吸附在列表顶部，盖住滚到它下方的行 —— 行的眼睛按钮在最左侧，
 *    被遮后无法点击。实测滚动后 2 个眼睛被遮挡。
 *
 * 2) 缩略图脱离布局流
 *    theme.css 里有一条全局规则 `canvas { position: absolute; inset: 0 }`，
 *    本意是给主画布用，但图层缩略图也是 canvas，于是被拉成绝对定位：
 *    贴到行的左上角、不参与 flex 布局，与相邻元素错位。
 *    表现为缩略图左边没有间距、文字位置异常。
 */

const CASES = {
  /* 属性条必须渲染在滚动容器之外 */
  '属性条位于滚动容器之外': async ({ assert, assertEq }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const box = document.getElementById('layers');
    const slot = document.getElementById('lay-props-slot');

    assert(!!slot, '应存在属性条槽位');
    assertEq(box.querySelector('.lay-props'), null,
      '#layers 内不应再有属性条（它会在滚动时遮挡行）');
  },

  /* 滚动后，可视区内的行不得被属性条覆盖 */
  '滚动后眼睛按钮不被遮挡': async ({ assert, assertEq }) => {
    /* 造足够多的图层以产生滚动 */
    const btn = document.getElementById('btn-add-layer');
    for (let i = 0; i < 12; i++) btn.click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const box = document.getElementById('layers');
    const slot = document.getElementById('lay-props-slot');
    box.scrollTop = 150;
    await new Promise(r => setTimeout(r, 100));

    const bb = box.getBoundingClientRect();
    const sb = slot.getBoundingClientRect();

    let checked = 0;
    let covered = 0;
    for (const row of box.querySelectorAll('.lay-row')) {
      const eye = row.querySelector('.lay-eye');
      if (!eye) continue;
      const eb = eye.getBoundingClientRect();

      /* 只看落在列表可视区内的眼睛。
       * 滚出容器的行坐标会落在容器外，那是正常状态、也不可点击，
       * 把它们计入会把测量变成「所有滚过去的行都算被遮挡」。 */
      if (eb.top < bb.top || eb.bottom > bb.bottom) continue;
      checked++;

      if (eb.top < sb.bottom && eb.bottom > sb.top) covered++;
    }

    assert(checked > 0, '应至少有一个可见的行可供检查');
    assertEq(covered, 0, `可视区内不应有眼睛被遮挡，实际 ${covered} 个`);
  },

  /* 缩略图必须参与布局流，而不是绝对定位 */
  '缩略图不脱离布局流': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const row = document.querySelector('#layers .lay-row');
    assert(!!row, '应存在图层行');

    const thumb = row.querySelector('canvas.lay-thumb');
    if (!thumb) return;

    const pos = getComputedStyle(thumb).position;
    assert(pos === 'static' || pos === 'relative',
      `缩略图应为流内元素，实际 position: ${pos}`);
  },

  /* 行内元素从左到右依次排列，不重叠 */
  '行内元素依次排列不重叠': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const row = document.querySelector('#layers .lay-row');
    assert(!!row, '应存在图层行');

    const box = row.getBoundingClientRect();
    const kids = [...row.children].map(c => ({
      cls: c.className.split(' ')[0],
      r: c.getBoundingClientRect(),
    }));

    assert(kids.length >= 2, '行内应有多个元素');

    for (let i = 1; i < kids.length; i++) {
      const prev = kids[i - 1];
      const cur = kids[i];
      /* 相邻元素之间不应有负间距（重叠） */
      assert(cur.r.left >= prev.r.right - 0.5,
        `${prev.cls} 与 ${cur.cls} 发生重叠：${prev.cls} 右边 ${prev.r.right.toFixed(1)}，` +
        `${cur.cls} 左边 ${cur.r.left.toFixed(1)}`);
    }

    /* 所有元素必须位于行内 */
    for (const k of kids) {
      assert(k.r.left >= box.left - 0.5 && k.r.right <= box.right + 0.5,
        `${k.cls} 超出所在行范围`);
    }
  },

  /* 缩略图与行左边缘之间应有间距，不能贴边 */
  '缩略图与行边缘留有间距': async ({ assert }) => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const row = document.querySelector('#layers .lay-row');
    assert(!!row, '应存在图层行');
    const thumb = row.querySelector('canvas.lay-thumb');
    if (!thumb) return;

    const rb = row.getBoundingClientRect();
    const tb = thumb.getBoundingClientRect();
    const leftGap = tb.left - rb.left;

    /* 行本身有 padding-left（含层级缩进），缩略图应在其之后。
     * 贴边（左侧无间距）说明它又被拉成了绝对定位。 */
    assert(leftGap > 0,
      `缩略图不应贴住行左边缘，实际间距 ${leftGap.toFixed(1)}px`);
  },
};
